import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import type {
  CommandInput,
  DrawingInput,
  Point,
  TableView,
  Token,
} from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { canEditObject } from "@tableloom/core/permissions";

export type Tool = "select" | "hand" | "pen" | "rectangle" | "token" | "erase";
type Gesture =
  | { kind: "draw"; drawing: DrawingInput }
  | { kind: "move"; token: Token; start: Point }
  | { kind: "pan"; start: Point; origin: Point };
interface Props {
  state: TableView;
  member: Member | null;
  tool: Tool;
  color: string;
  tokenName: string;
  enabled: boolean;
  send: (command: CommandInput) => boolean;
}

const clamp = (v: number) => Math.max(-10000, Math.min(10000, v));
export function Tabletop({
  state,
  member,
  tool,
  color,
  tokenName,
  enabled,
  send,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState("");
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const app = new Application();
    let stopped = false;
    void app
      .init({
        resizeTo: element,
        background: "#eae7dd",
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
    const grid = new Graphics();
    for (let x = -2400; x <= 4800; x += 60)
      grid.moveTo(x, -2400).lineTo(x, 4800);
    for (let y = -2400; y <= 4800; y += 60)
      grid.moveTo(-2400, y).lineTo(4800, y);
    grid.stroke({ color: "#c7c6b9", width: 1, alpha: 0.5 });
    world.addChild(grid);
    const drawings =
      gesture?.kind === "draw"
        ? [...state.drawings, gesture.drawing]
        : state.drawings;
    for (const drawing of drawings) {
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
    }
    for (const original of state.tokens) {
      const token =
        gesture?.kind === "move" && gesture.token.id === original.id
          ? gesture.token
          : original;
      const { x, y } = token.position;
      const graphic = new Graphics();
      graphic.circle(x + 2, y + 4, 24).fill({ color: "#242e29", alpha: 0.18 });
      if (selected === token.id)
        graphic.circle(x, y, 30).stroke({ color: "#405f4d", width: 2 });
      graphic
        .circle(x, y, 24)
        .fill(token.color)
        .stroke({ color: "#fffaf0", width: 3 });
      world.addChild(graphic);
      const initial = new Text({
        text: token.name.slice(0, 1).toUpperCase(),
        style: { fontFamily: "Georgia", fontSize: 23, fill: "#ffffff" },
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
      label.position.set(x, y + 32);
      world.addChild(label);
    }
  }, [ready, state, gesture, selected, view]);

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
          position: p,
          color,
        },
      });
      return;
    }
    const token = [...state.tokens]
      .reverse()
      .find((t) => Math.hypot(p.x - t.position.x, p.y - t.position.y) <= 28);
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
      const drawing = [...state.drawings].reverse().find((d) => {
        const first = d.points[0]!;
        const last = d.points.at(-1)!;
        if (d.kind === "rectangle") {
          const left = Math.min(first.x, last.x),
            right = Math.max(first.x, last.x);
          const top = Math.min(first.y, last.y),
            bottom = Math.max(first.y, last.y);
          return (
            p.x >= left - 10 &&
            p.x <= right + 10 &&
            p.y >= top - 10 &&
            p.y <= bottom + 10 &&
            Math.min(
              Math.abs(p.x - left),
              Math.abs(p.x - right),
              Math.abs(p.y - top),
              Math.abs(p.y - bottom),
            ) < 10
          );
        }
        return d.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 15);
      });
      if (drawing && canEditObject(member, drawing))
        send({
          type: "object.delete",
          objectId: drawing.id,
          expectedVersion: drawing.version,
        });
    } else if (tool === "select") {
      const editable = token && canEditObject(member, token) ? token : null;
      setSelected(editable?.id ?? null);
      if (editable)
        setGesture({
          kind: "move",
          token: editable,
          start: { ...editable.position },
        });
    } else {
      setSelected(null);
      setGesture({
        kind: "draw",
        drawing: {
          id: crypto.randomUUID(),
          kind: tool === "rectangle" ? "rectangle" : "stroke",
          points: [p, p],
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
    } else if (gesture.kind === "move")
      setGesture({
        ...gesture,
        token: { ...gesture.token, position: point(event) },
      });
    else {
      const p = point(event);
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
  function up() {
    if (gesture?.kind === "draw")
      send({ type: "drawing.add", drawing: gesture.drawing });
    if (
      gesture?.kind === "move" &&
      (gesture.token.position.x !== gesture.start.x ||
        gesture.token.position.y !== gesture.start.y)
    )
      send({
        type: "token.move",
        tokenId: gesture.token.id,
        expectedVersion: gesture.token.version,
        position: gesture.token.position,
      });
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
        if (enabled) zoom(event.deltaY > 0 ? 0.92 : 1.08, local(event));
      }}
    >
      {failure && (
        <div className="canvas-message" role="alert">
          {failure}
        </div>
      )}
      {!ready && !failure && (
        <div className="canvas-message">Unfolding the table…</div>
      )}
      {ready &&
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
