import type { BackgroundView } from "@tableloom/core/scene-map";
import { ResizeSelectionDialog } from "./ResizeSelectionDialog.js";
import { ResizeTokenDialog } from "./ResizeTokenDialog.js";
import { drawingBounds, resizedDrawingPoints } from "@tableloom/core/geometry";
import {
  canResize,
  corners,
  cornerPoint,
  resizeDrag,
} from "./drawing-resize.js";
import type { Corner } from "./drawing-resize.js";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  GRID_SIZE,
  dragDelta,
  snapAnchor,
  snapPoint,
  visibleGrid,
} from "./grid.js";
import type { SnapAnchor } from "./grid.js";
import { DeleteSelectionDialog } from "./DeleteSelectionDialog.js";
import { captureDeletionReview } from "./scene-selection.js";
import type { DeletionReviewItem } from "./scene-selection.js";
import { Application, Container, Graphics, Text } from "pixi.js";
import type {
  CommandInput,
  DrawingInput,
  Drawing,
  Token,
  Point,
  TableView,
} from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { translateTokens } from "./token-selection.js";
import {
  translateObject,
  hitDrawing,
  hitToken,
  objectBounds,
  objectsInBox,
  selectObjects,
} from "./scene-selection.js";
import type { SceneObject } from "./scene-selection.js";
import { canEditObject } from "@tableloom/core/permissions";

export type Tool = "select" | "hand" | "pen" | "rectangle" | "token" | "erase";
type Gesture =
  | {
      kind: "resize";
      drawing: Drawing;
      corner: Corner;
      start: Point;
      pointer: Point;
      snap: boolean;
    }
  | { kind: "draw"; drawing: DrawingInput; snap: boolean }
  | {
      kind: "move";
      objects: SceneObject[];
      start: Point;
      delta: Point;
      anchor: SnapAnchor | null;
    }
  | { kind: "marquee"; start: Point; end: Point; base: string[] }
  | { kind: "pan"; start: Point; origin: Point };
interface Props {
  state: TableView;
  background: BackgroundView | null;
  campaignId: string;
  sceneId: string;
  member: Member | null;
  tool: Tool;
  color: string;
  tokenName: string;
  enabled: boolean;
  pending: boolean;
  send: (command: CommandInput) => boolean;
}

const clamp = (v: number) => Math.max(-10000, Math.min(10000, v));
export function Tabletop({
  state,
  background,
  campaignId,
  sceneId,
  member,
  tool,
  color,
  tokenName,
  enabled,
  pending,
  send,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const [ready, setReady] = useState(false);
  const [mapFailure, setMapFailure] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [snap, setSnap] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth,
        height = element.clientHeight;
      setViewport((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
      const app = appRef.current;
      if (
        app &&
        width > 0 &&
        height > 0 &&
        (app.screen.width !== width || app.screen.height !== height)
      )
        app.resize();
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  const [resizeSelection, setResizeSelection] = useState<SceneObject[] | null>(
    null,
  );
  const [resizeToken, setResizeToken] = useState<Token | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const [deleteReview, setDeleteReview] = useState<DeletionReviewItem[] | null>(
    null,
  );
  useEffect(() => {
    setSelected((previous) =>
      previous.filter((id) =>
        [...state.tokens, ...state.drawings].some(
          (object) => object.id === id && canEditObject(member, object),
        ),
      ),
    );
  }, [state, member]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const app = new Application();
    let stopped = false;
    void app
      .init({
        resizeTo: element,
        background: "#eae7dd",
        backgroundAlpha: 0,
        antialias: true,
        resolution: Math.min(devicePixelRatio, 2),
        autoDensity: true,
        preference: "webgl",
      })
      .then(() => {
        if (stopped) {
          app.destroy(true, { children: true });
          return;
        }
        element.prepend(app.canvas);
        const world = new Container();
        app.stage.addChild(world);
        appRef.current = app;
        worldRef.current = world;
        setReady(true);
      })
      .catch(() =>
        setFailure(
          "This browser could not start the tabletop renderer. Please try a browser with WebGL enabled.",
        ),
      );
    return () => {
      stopped = true;
      if (appRef.current === app) {
        app.destroy(true, { children: true });
        appRef.current = null;
        worldRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setGesture(null);
  }, [tool, enabled]);

  useEffect(() => {
    const world = worldRef.current;
    if (!ready || !world) return;
    for (const child of world.removeChildren())
      child.destroy({ children: true });
    world.position.set(view.x, view.y);
    world.scale.set(view.scale);
    const grid = new Graphics(),
      area = visibleGrid(view, viewport.width, viewport.height);
    if (area) {
      for (const x of area.vertical)
        grid.moveTo(x, area.top).lineTo(x, area.bottom);
      for (const y of area.horizontal)
        grid.moveTo(area.left, y).lineTo(area.right, y);
    }
    grid.stroke({ color: "#c7c6b9", width: 1, alpha: 0.5 });
    world.addChild(grid);
    const previews = new Map<string, SceneObject>();
    if (gesture?.kind === "move") {
      const delta = dragDelta(
        gesture.objects,
        gesture.delta,
        view.scale,
        gesture.anchor,
      );
      for (const object of gesture.objects)
        previews.set(object.id, translateObject(object, delta));
    }
    if (gesture?.kind === "resize") {
      const bounds = resizeDrag(
        gesture.drawing,
        gesture.corner,
        gesture.start,
        gesture.pointer,
        view.scale,
        gesture.snap,
      );
      if (bounds)
        previews.set(gesture.drawing.id, {
          ...gesture.drawing,
          points: resizedDrawingPoints(gesture.drawing, bounds),
        });
    }
    const drawings =
      gesture?.kind === "draw"
        ? [...state.drawings, gesture.drawing]
        : state.drawings;
    for (const original of drawings) {
      const preview = previews.get(original.id);
      const drawing = preview && "points" in preview ? preview : original;
      const first = drawing.points[0];
      const last = drawing.points.at(-1);
      if (!first || !last) continue;
      const graphic = new Graphics();
      if (drawing.kind === "rectangle") {
        graphic.roundRect(
          Math.min(first.x, last.x),
          Math.min(first.y, last.y),
          Math.max(1, Math.abs(last.x - first.x)),
          Math.max(1, Math.abs(last.y - first.y)),
          3,
        );
        graphic.fill({ color: drawing.color, alpha: 0.07 });
      } else {
        graphic.moveTo(first.x, first.y);
        for (const point of drawing.points.slice(1))
          graphic.lineTo(point.x, point.y);
      }
      graphic.stroke({
        color: drawing.color,
        width: 3,
        cap: "round",
        join: "round",
      });
      world.addChild(graphic);
      if (selected.includes(drawing.id)) {
        const box = objectBounds(drawing),
          padding = 6 / view.scale;
        const outline = new Graphics()
          .rect(
            box.left - padding,
            box.top - padding,
            Math.max(1, box.right - box.left) + 2 * padding,
            Math.max(1, box.bottom - box.top) + 2 * padding,
          )
          .stroke({ color: "#405f4d", width: 1.5 / view.scale });
        world.addChild(outline);
      }
    }
    for (const original of state.tokens) {
      const preview = previews.get(original.id);
      const token = preview && "position" in preview ? preview : original;
      const { x, y } = token.position;
      const graphic = new Graphics();
      graphic
        .circle(x + 2, y + 4, token.radius)
        .fill({ color: "#242e29", alpha: 0.18 });
      if (selected.includes(token.id))
        graphic
          .circle(x, y, token.radius + 6)
          .stroke({ color: "#405f4d", width: 2 });
      graphic
        .circle(x, y, token.radius)
        .fill(token.color)
        .stroke({ color: "#fffaf0", width: 3 });
      world.addChild(graphic);
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
      world.addChild(initial);
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
      world.addChild(label);
    }
    const resizable =
      tool === "select" && selected.length === 1 && !pending && enabled
        ? state.drawings.find(
            (d) =>
              d.id === selected[0] && canEditObject(member, d) && canResize(d),
          )
        : undefined;
    if (resizable) {
      const preview = previews.get(resizable.id),
        drawing = preview && "points" in preview ? preview : resizable;
      const box = drawingBounds(drawing),
        size = 9 / view.scale;
      for (const corner of corners) {
        const p = cornerPoint(box, corner);
        world.addChild(
          new Graphics()
            .rect(p.x - size / 2, p.y - size / 2, size, size)
            .fill("#fffaf0")
            .stroke({ color: "#405f4d", width: 1.5 / view.scale }),
        );
      }
    }
    if (gesture?.kind === "marquee") {
      const { start, end } = gesture;
      const rectangle = new Graphics().rect(
        Math.min(start.x, end.x),
        Math.min(start.y, end.y),
        Math.abs(end.x - start.x),
        Math.abs(end.y - start.y),
      );
      rectangle
        .fill({ color: "#405f4d", alpha: 0.08 })
        .stroke({ color: "#405f4d", width: 1 / view.scale });
      world.addChild(rectangle);
    }
  }, [
    ready,
    state,
    gesture,
    selected,
    view,
    viewport,
    tool,
    enabled,
    pending,
    member,
  ]);

  function local(event: { clientX: number; clientY: number }): Point {
    const rect = host.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function point(event: { clientX: number; clientY: number }): Point {
    const p = local(event);
    return {
      x: clamp((p.x - view.x) / view.scale),
      y: clamp((p.y - view.y) / view.scale),
    };
  }
  function down(event: ReactPointerEvent) {
    if (!ready || !enabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = point(event);
    if (tool === "hand") {
      setGesture({ kind: "pan", start: local(event), origin: view });
      return;
    }
    if (tool === "token") {
      send({
        type: "token.add",
        token: {
          id: crypto.randomUUID(),
          name: tokenName.trim() || "Token",
          position: snap ? snapPoint(p, GRID_SIZE / 2) : p,
          color,
        },
      });
      return;
    }
    if (
      tool === "select" &&
      !event.shiftKey &&
      !pending &&
      selected.length === 1
    ) {
      const drawing = state.drawings.find(
        (d) => d.id === selected[0] && canEditObject(member, d) && canResize(d),
      );
      if (drawing) {
        const box = drawingBounds(drawing),
          corner = corners.find((c) => {
            const handle = cornerPoint(box, c);
            return Math.hypot(p.x - handle.x, p.y - handle.y) <= 8 / view.scale;
          });
        if (corner) {
          setGesture({
            kind: "resize",
            drawing,
            corner,
            start: p,
            pointer: p,
            snap,
          });
          return;
        }
      }
    }
    const token = [...state.tokens].reverse().find((t) => hitToken(t, p));
    const drawing =
      (tool === "select" || tool === "erase") && !token
        ? [...state.drawings]
            .reverse()
            .find((drawing) =>
              hitDrawing(drawing, p, Math.max(3, 8 / view.scale)),
            )
        : undefined;
    const target = token ?? drawing;
    if (tool === "erase") {
      if (token) {
        if (canEditObject(member, token))
          send({
            type: "object.delete",
            objectId: token.id,
            expectedVersion: token.version,
          });
        return;
      }
      if (drawing && canEditObject(member, drawing))
        send({
          type: "object.delete",
          objectId: drawing.id,
          expectedVersion: drawing.version,
        });
    } else if (tool === "select") {
      setSelectionError("");
      const editable = target && canEditObject(member, target) ? target : null;
      if (editable) {
        if (event.shiftKey) {
          const next = selected.includes(editable.id)
            ? selected.filter((id) => id !== editable.id)
            : selectObjects(selected, [editable.id]);
          if (next) setSelected(next);
          else setSelectionError("Select at most 100 objects at once.");
          return;
        }
        const ids = selected.includes(editable.id) ? selected : [editable.id];
        setSelected(ids);
        const objects = [...state.tokens, ...state.drawings].filter(
          (object) => ids.includes(object.id) && canEditObject(member, object),
        );
        setGesture({
          kind: "move",
          objects,
          start: p,
          delta: { x: 0, y: 0 },
          anchor: snap ? snapAnchor(editable) : null,
        });
      } else if (!target) {
        setGesture({
          kind: "marquee",
          start: p,
          end: p,
          base: event.shiftKey ? selected : [],
        });
      } else setSelected([]);
    } else {
      setSelected([]);
      const start = tool === "rectangle" && snap ? snapPoint(p) : p;
      setGesture({
        kind: "draw",
        snap: tool === "rectangle" && snap,
        drawing: {
          id: crypto.randomUUID(),
          kind: tool === "rectangle" ? "rectangle" : "stroke",
          points: [start, start],
          color,
        },
      });
    }
  }
  function move(event: ReactPointerEvent) {
    if (!gesture) return;
    if (gesture.kind === "pan") {
      const p = local(event);
      setView((v) => ({
        ...v,
        x: gesture.origin.x + p.x - gesture.start.x,
        y: gesture.origin.y + p.y - gesture.start.y,
      }));
    } else if (gesture.kind === "resize")
      setGesture({ ...gesture, pointer: point(event) });
    else if (gesture.kind === "move")
      setGesture({
        ...gesture,
        delta: {
          x: point(event).x - gesture.start.x,
          y: point(event).y - gesture.start.y,
        },
      });
    else if (gesture.kind === "marquee")
      setGesture({ ...gesture, end: point(event) });
    else {
      const raw = point(event),
        p = gesture.snap ? snapPoint(raw) : raw;
      const points = gesture.drawing.points;
      if (Math.hypot(p.x - points.at(-1)!.x, p.y - points.at(-1)!.y) < 2)
        return;
      setGesture({
        ...gesture,
        drawing: {
          ...gesture.drawing,
          points:
            gesture.drawing.kind === "rectangle"
              ? [points[0]!, p]
              : [...points.slice(0, 1999), p],
        },
      });
    }
  }
  function up(event: ReactPointerEvent) {
    if (gesture?.kind === "resize") {
      const bounds = resizeDrag(
        gesture.drawing,
        gesture.corner,
        gesture.start,
        point(event),
        view.scale,
        gesture.snap,
      );
      if (bounds)
        send({
          type: "drawing.resize",
          drawingId: gesture.drawing.id,
          expectedVersion: gesture.drawing.version,
          bounds,
        });
    }
    if (gesture?.kind === "draw") {
      if (gesture.drawing.kind === "rectangle") {
        const raw = point(event),
          last = gesture.snap ? snapPoint(raw) : raw,
          first = gesture.drawing.points[0]!;
        if (first.x !== last.x && first.y !== last.y)
          send({
            type: "drawing.add",
            drawing: { ...gesture.drawing, points: [first, last] },
          });
      } else send({ type: "drawing.add", drawing: gesture.drawing });
    }
    if (gesture?.kind === "marquee") {
      const editable = [...state.tokens, ...state.drawings].filter((object) =>
        canEditObject(member, object),
      );
      const next = selectObjects(
        gesture.base,
        objectsInBox(editable, gesture.start, point(event)),
      );
      if (next) setSelected(next);
      else setSelectionError("Select at most 100 objects at once.");
    }
    if (gesture?.kind === "move") {
      const p = point(event),
        delta = dragDelta(
          gesture.objects,
          {
            x: p.x - gesture.start.x,
            y: p.y - gesture.start.y,
          },
          view.scale,
          gesture.anchor,
        );
      if (delta.x !== 0 || delta.y !== 0) {
        const tokens = gesture.objects.filter((object) => "position" in object);
        if (tokens.length === gesture.objects.length) {
          const moves = translateTokens(tokens, delta);
          if (moves.length === 1) send({ type: "token.move", ...moves[0]! });
          else if (moves.length > 1) send({ type: "tokens.move", moves });
        } else
          send({
            type: "objects.move",
            objects: gesture.objects.map((object) => ({
              objectId: object.id,
              expectedVersion: object.version,
            })),
            delta,
          });
      }
    }
    setGesture(null);
  }
  function zoom(factor: number, center?: Point) {
    const p = center ?? {
      x: (host.current?.clientWidth ?? 0) / 2,
      y: (host.current?.clientHeight ?? 0) / 2,
    };
    setView((v) => {
      const scale = Math.max(0.25, Math.min(3, v.scale * factor));
      return {
        scale,
        x: p.x - ((p.x - v.x) * scale) / v.scale,
        y: p.y - ((p.y - v.y) * scale) / v.scale,
      };
    });
  }
  const selectedObjects = [...state.tokens, ...state.drawings].filter(
    (object) => selected.includes(object.id),
  );
  const selectionType = selectedObjects.every((object) => "position" in object)
    ? "token"
    : selectedObjects.every((object) => "points" in object)
      ? "drawing"
      : "object";
  return (
    <div
      ref={host}
      className={`tabletop tool-${tool}`}
      aria-label="Shared battlefield"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setGesture(null)}
      onWheel={(event) => {
        if (enabled && !gesture)
          zoom(event.deltaY > 0 ? 0.92 : 1.08, local(event));
      }}
    >
      {background && (
        <img
          key={background.imageId}
          className="scene-map-image"
          src={`/api/campaigns/${campaignId}/scene-map/${sceneId}/${background.imageId}/content`}
          alt="Scene background map"
          draggable={false}
          onLoad={() => setMapFailure(null)}
          onError={() => setMapFailure(background.imageId)}
          style={{
            left: view.x + background.position.x * view.scale,
            top: view.y + background.position.y * view.scale,
            width: background.width * view.scale,
            height: background.height * view.scale,
          }}
        />
      )}
      {background && mapFailure === background.imageId && (
        <div className="map-load-error" role="status">
          The map is unavailable. Reconnect or ask the GM to review it.
        </div>
      )}
      {background?.visibility === "gm" && (
        <div className="private-map-badge">GM-only map</div>
      )}
      {failure && (
        <div className="canvas-message" role="alert">
          {failure}
        </div>
      )}
      {!ready && !failure && (
        <div className="canvas-message">Unfolding the table…</div>
      )}
      {ready &&
        !background &&
        state.drawings.length === 0 &&
        state.tokens.length === 0 &&
        !gesture && (
          <div className="canvas-welcome">
            <span className="compass">✧</span>
            <h2>
              A little space.
              <br />
              An infinite number of stories.
            </h2>
            <p>
              Draw a room. Place your cast.
              <br />
              See where the evening takes you.
            </p>
          </div>
        )}
      <div className="canvas-label">
        <span className="live-dot" /> SHARED BATTLEFIELD
      </div>
      <label
        className="snap-controls"
        title="Token centers snap to cells; room corners and drawing anchors snap to grid lines. Groups keep their spacing."
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={snap}
          onChange={(event) => setSnap(event.target.checked)}
        />{" "}
        Snap to grid
      </label>
      {(selected.length > 0 || selectionError) && (
        <div
          className="selection-controls"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span role="status">
            {selectionError ||
              `${selected.length} ${selectionType}${selected.length === 1 ? "" : "s"} selected`}
          </span>
          {selectedObjects.length === 1 &&
            "points" in selectedObjects[0]! &&
            canResize(selectedObjects[0]) &&
            tool === "select" && <small>Drag a corner to resize</small>}
          {selectedObjects.length === 1 &&
            "position" in selectedObjects[0]! && (
              <button
                disabled={!enabled || pending}
                onClick={() => {
                  setGesture(null);
                  setResizeToken(selectedObjects[0] as Token);
                }}
              >
                Resize token…
              </button>
            )}
          {selectedObjects.length > 1 && (
            <button
              disabled={!enabled || pending}
              onClick={() => {
                setGesture(null);
                setResizeSelection(selectedObjects);
              }}
            >
              Resize selection…
            </button>
          )}
          <button
            onClick={() => {
              setSelected([]);
              setSelectionError("");
              setGesture(null);
            }}
          >
            Clear selection
          </button>
          <button
            disabled={!enabled || pending || !selectedObjects.length}
            onClick={() => {
              setGesture(null);
              setDeleteReview(captureDeletionReview(selectedObjects));
            }}
          >
            Delete selection…
          </button>
        </div>
      )}
      {resizeSelection && (
        <ResizeSelectionDialog
          objects={resizeSelection}
          state={state}
          member={member}
          enabled={enabled}
          pending={pending}
          send={send}
          close={() => setResizeSelection(null)}
        />
      )}
      {resizeToken && (
        <ResizeTokenDialog
          token={resizeToken}
          state={state}
          member={member}
          enabled={enabled}
          pending={pending}
          send={send}
          close={() => setResizeToken(null)}
        />
      )}
      {deleteReview && (
        <DeleteSelectionDialog
          review={deleteReview}
          state={state}
          member={member}
          enabled={enabled}
          pending={pending}
          send={send}
          close={() => setDeleteReview(null)}
        />
      )}
      <div
        className="zoom-controls"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <button aria-label="Zoom out" onClick={() => zoom(0.8)}>
          −
        </button>
        <button
          className="zoom-value"
          onClick={() => setView({ x: 0, y: 0, scale: 1 })}
          title="Reset view"
        >
          {Math.round(view.scale * 100)}%
        </button>
        <button aria-label="Zoom in" onClick={() => zoom(1.25)}>
          +
        </button>
      </div>
    </div>
  );
}
