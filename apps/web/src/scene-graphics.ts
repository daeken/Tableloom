import { Container, Graphics, Text } from "pixi.js";
import { shapeStyleOf, drawingLayerOf, tokenLayerOf } from "@tableloom/core";
import type { DrawingInput, Drawing, Token } from "@tableloom/core";
import { objectBounds } from "./scene-selection.js";

type RenderDrawing = DrawingInput &
  Partial<Pick<Drawing, "layer" | "ownerId" | "version">>;

/** Visual identity deliberately excludes ownership, versions, layer and array order.
 * Values, not object references/version alone, also handle cloned snapshots and local previews.
 */
export function drawingVisualKey(drawing: RenderDrawing) {
  const shape = drawing.kind === "text" ? null : shapeStyleOf(drawing);
  return JSON.stringify([
    drawing.kind,
    drawing.color,
    drawing.points,
    drawing.text,
    drawing.textStyle?.font,
    drawing.textStyle?.weight,
    drawing.textStyle?.align,
    shape?.lineWidth,
    shape?.fill?.color,
    shape?.fill?.opacity,
  ]);
}
export const tokenVisualKey = (token: Token) =>
  JSON.stringify([
    token.name,
    token.color,
    token.radius,
    token.position.x,
    token.position.y,
  ]);

export function createDrawingGraphic(drawing: RenderDrawing): Container {
  const contentLayer = new Container({ label: drawing.id });
  const first = drawing.points[0];
  const last = drawing.points.at(-1);
  if (!first || !last) return contentLayer;
  const graphic = new Graphics();
  if (drawing.kind === "text") {
    const box = objectBounds(drawing),
      label = new Text({
        text: drawing.text!,
        style: {
          fontFamily: drawing.textStyle!.font,
          fontWeight: drawing.textStyle!.weight,
          align: drawing.textStyle!.align,
          fontSize: 24,
          lineHeight: 32,
          fill: drawing.color,
        },
      });
    label.position.set(box.left, box.top);
    label.scale.set(
      (box.right - box.left) / Math.max(1, label.width),
      (box.bottom - box.top) / Math.max(1, label.height),
    );
    contentLayer.addChild(label);
  } else if (drawing.kind === "rectangle") {
    graphic.roundRect(
      Math.min(first.x, last.x),
      Math.min(first.y, last.y),
      Math.max(1, Math.abs(last.x - first.x)),
      Math.max(1, Math.abs(last.y - first.y)),
      3,
    );
    const fill = shapeStyleOf(drawing).fill;
    if (fill) graphic.fill({ color: fill.color, alpha: fill.opacity });
  } else {
    graphic.moveTo(first.x, first.y);
    for (const point of drawing.points.slice(1))
      graphic.lineTo(point.x, point.y);
  }
  if (drawing.kind !== "text")
    graphic.stroke({
      color: drawing.color,
      width: shapeStyleOf(drawing).lineWidth,
      cap: "round",
      join: "round",
    });
  contentLayer.addChild(graphic);

  return contentLayer;
}

export function createTokenGraphic(token: Token): Container {
  const contentLayer = new Container({ label: token.id });
  const { x, y } = token.position;
  const graphic = new Graphics();
  graphic
    .circle(x + 2, y + 4, token.radius)
    .fill({ color: "#242e29", alpha: 0.18 });
  graphic
    .circle(x, y, token.radius)
    .fill(token.color)
    .stroke({ color: "#fffaf0", width: 3 });
  contentLayer.addChild(graphic);
  const initial = new Text({
    text: token.name.slice(0, 1).toUpperCase(),
    style: {
      fontFamily: "Georgia",
      fontSize: Math.max(10, Math.min(64, token.radius * 0.96)),
      fill: "#ffffff",
    },
  });
  initial.anchor.set(0.5);
  initial.position.set(x, y - 1);
  contentLayer.addChild(initial);
  const label = new Text({
    text: token.name,
    style: {
      fontFamily: "Arial",
      fontSize: 12,
      fontWeight: "600",
      fill: "#323f35",
    },
  });
  label.anchor.set(0.5, 0);
  label.position.set(x, y + token.radius + 8);
  contentLayer.addChild(label);

  return contentLayer;
}

/** Owns only its cached nodes. Layer movement/reordering preserves those resources. */
export class RetainedGraphics<T extends { id: string }> {
  private entries = new Map<string, { key: string; node: Container }>();
  constructor(
    private key: (object: T) => string,
    private create: (object: T) => Container,
  ) {}

  sync(objects: readonly T[], layerFor: (object: T) => Container) {
    const ids = new Set(objects.map((object) => object.id));
    for (const [id, entry] of this.entries) {
      if (!ids.has(id)) {
        entry.node.removeFromParent();
        entry.node.destroy({ children: true });
        this.entries.delete(id);
      }
    }
    const indices = new Map<Container, number>();
    for (const object of objects) {
      const key = this.key(object);
      let entry = this.entries.get(object.id);
      if (!entry || entry.key !== key) {
        const node = this.create(object);
        if (entry) {
          entry.node.removeFromParent();
          entry.node.destroy({ children: true });
        }
        entry = { key, node };
        this.entries.set(object.id, entry);
      }
      const layer = layerFor(object),
        index = indices.get(layer) ?? 0;
      if (entry.node.parent !== layer || layer.children[index] !== entry.node)
        layer.addChildAt(entry.node, index);
      indices.set(layer, index + 1);
    }
  }

  destroy() {
    for (const entry of this.entries.values()) {
      entry.node.removeFromParent();
      entry.node.destroy({ children: true });
    }
    this.entries.clear();
  }
}

export class SceneGraphics {
  readonly grid = new Graphics();
  readonly selection = new Container({ label: "Selection" });
  private drawingLayer = new Container({ label: "Drawings" });
  private tokenLayer = new Container({ label: "Tokens" });
  private upperDrawingLayer = new Container({ label: "Drawings above tokens" });
  private upperTokenLayer = new Container({ label: "Tokens above drawings" });
  private drawings = new RetainedGraphics(
    drawingVisualKey,
    createDrawingGraphic,
  );
  private tokens = new RetainedGraphics(tokenVisualKey, createTokenGraphic);

  constructor(private world: Container) {
    world.addChild(
      this.grid,
      this.drawingLayer,
      this.tokenLayer,
      this.upperDrawingLayer,
      this.upperTokenLayer,
      this.selection,
    );
  }
  sync(drawings: readonly RenderDrawing[], tokens: readonly Token[]) {
    this.drawings.sync(drawings, (drawing) =>
      drawingLayerOf(drawing) === "above-tokens"
        ? this.upperDrawingLayer
        : this.drawingLayer,
    );
    this.tokens.sync(tokens, (token) =>
      tokenLayerOf(token) === "above-drawings"
        ? this.upperTokenLayer
        : this.tokenLayer,
    );
  }
  destroy() {
    this.drawings.destroy();
    this.tokens.destroy();
    for (const child of this.world.removeChildren())
      child.destroy({ children: true });
  }
}
