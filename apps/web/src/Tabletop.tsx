import { PositionSelectionDialog } from "./PositionSelectionDialog.js";
import { CreateObjectDialog } from "./CreateObjectDialog.js";
import type { CreationKind } from "./object-creation.js";
import { ObjectPickerDialog } from "./ObjectPickerDialog.js";
import { keyboardMoveCommand } from "./keyboard-objects.js";
import { PointerSession, withinTap } from "./pointer-session.js";
import { ParticipantCursors } from "./ParticipantCursors.js";
import type {
  CursorPosition,
  ParticipantCursor,
  OnlineMember,
} from "@tableloom/core";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog.js";
import { tabletopShortcut } from "./tabletop-shortcuts.js";
import { sceneHistoryCommand } from "./scene-history-command.js";
import type { SceneHistory } from "@tableloom/core/scene-history";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { MeasurementControls } from "./MeasurementControls.js";
import {
  beginMeasurement,
  updateMeasurement,
  finishMeasurement,
  measurementCurrent,
} from "./measurement.js";
import type { Measurement, MeasurementDrag } from "./measurement.js";
import type { SceneGrid } from "@tableloom/core/scene-grid";
import { SceneOrderDialog } from "./SceneOrderDialog.js";
import { ShapeStyleDialog } from "./ShapeStyleDialog.js";
import { shapeStyleOf, drawingLayerOf, tokenLayerOf } from "@tableloom/core";
import type { BackgroundView } from "@tableloom/core/scene-map";
import { EditTextDialog } from "./EditTextDialog.js";
import { TextPlacementDialog } from "./TextPlacementDialog.js";
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
import { dragDelta, snapAnchor, snapPoint, visibleGrid } from "./grid.js";
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
  pickSceneObject,
  objectBounds,
  objectsInBox,
  selectObjects,
} from "./scene-selection.js";
import type { SceneObject } from "./scene-selection.js";
import { canEditObject } from "@tableloom/core/permissions";

export type Tool =
  | "select"
  | "hand"
  | "pen"
  | "rectangle"
  | "token"
  | "erase"
  | "text"
  | "measure";
type Gesture =
  | {
      kind: "tap";
      start: Point;
      gridVersion: number;
      action: CommandInput | { type: "text.open"; anchor: Point };
    }
  | { kind: "measure"; ruler: MeasurementDrag; pointerId: number }
  | {
      kind: "resize";
      drawing: Drawing;
      corner: Corner;
      start: Point;
      pointer: Point;
      snap: boolean;
      gridVersion: number;
    }
  | { kind: "draw"; drawing: DrawingInput; snap: boolean; gridVersion: number }
  | {
      kind: "move";
      objects: SceneObject[];
      start: Point;
      delta: Point;
      anchor: SnapAnchor | null;
      gridVersion: number;
    }
  | { kind: "marquee"; start: Point; end: Point; base: string[] }
  | { kind: "pan"; start: Point; origin: Point };
interface Props {
  state: TableView;
  cursors: ParticipantCursor[];
  onlineMembers: OnlineMember[];
  shareCursor: (position: CursorPosition, renewOnly?: boolean) => boolean;
  grid: SceneGrid;
  background: BackgroundView | null;
  campaignId: string;
  sceneId: string;
  member: Member | null;
  tool: Tool;
  setTool: (tool: Tool) => void;
  history: SceneHistory | null;
  color: string;
  tokenName: string;
  enabled: boolean;
  pending: boolean;
  send: (command: CommandInput) => boolean;
}

const clamp = (v: number) => Math.max(-10000, Math.min(10000, v));
export function Tabletop({
  state,
  cursors,
  onlineMembers,
  shareCursor,
  grid,
  background,
  campaignId,
  sceneId,
  member,
  tool,
  setTool,
  history,
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
  const cursorView = useRef(view);
  cursorView.current = view;
  const [textAnchor, setTextAnchor] = useState<Point | null>(null);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const session = useRef(new PointerSession<Gesture>());
  const [gesture, renderGesture] = useState<Gesture | null>(null);
  function setGesture(value: Gesture | null) {
    session.current.update(value);
    renderGesture(value);
  }
  const gestureScope = `${tool}:${grid.version}`;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [objectPickerOpen, setObjectPickerOpen] = useState(false);
  const [creation, setCreation] = useState<{
    anchor: Point;
    kind: CreationKind;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionActionsOpen, setSelectionActionsOpen] = useState(false);
  useEffect(() => setSelectionActionsOpen(false), [tool, selected.join("|")]);
  const [sharing, setSharing] = useState(false);
  const pointer = useRef<{ clientX: number; clientY: number } | null>(null);
  const cursorSender = useRef(shareCursor);
  cursorSender.current = shareCursor;
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
  const [positionSelection, setPositionSelection] = useState<
    SceneObject[] | null
  >(null);
  const [resizeSelection, setResizeSelection] = useState<SceneObject[] | null>(
    null,
  );
  const [sceneOrder, setSceneOrder] = useState<{
    initial: SceneObject | null;
    kind: "drawing" | "token";
  } | null>(null);
  const [editShape, setEditShape] = useState<Drawing | null>(null);
  const [editText, setEditText] = useState<Drawing | null>(null);
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
        // Transparent premultiplied surfaces must clear RGB to zero as well.
        background: "#000000",
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
    cancelInteraction();
    setMeasurement(null);
  }, [tool, enabled, grid.version]);
  function cancelInteraction(reset = false) {
    if (reset) session.current.reset();
    else session.current.cancel();
    renderGesture(null);
    if (pointer.current) {
      pointer.current = null;
      cursorSender.current(null);
    }
  }
  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (session.current.observeDown(event.pointerId)) cancelInteraction();
    };
    const up = (event: PointerEvent) => {
      if (
        !session.current.owns(event.pointerId) ||
        !event.composedPath().includes(host.current as EventTarget)
      ) {
        if (session.current.owns(event.pointerId)) cancelInteraction();
        session.current.finish(event.pointerId, "");
      }
    };
    const cancel = (event: PointerEvent) => {
      if (session.current.owns(event.pointerId)) cancelInteraction();
      session.current.finish(event.pointerId, "");
    };
    const move = (event: PointerEvent) => {
      // Recover when a release happened outside the window and no pointerup arrived.
      if (
        session.current.tracks(event.pointerId) &&
        (event.buttons & 1) === 0
      ) {
        cancelInteraction();
        session.current.finish(event.pointerId, "");
      }
    };
    const blur = () => cancelInteraction(true);
    const visibility = () => {
      if (document.visibilityState !== "visible") blur();
    };
    const observer = new MutationObserver(() => {
      if (
        (session.current.active || pointer.current) &&
        document.querySelector(
          "dialog[open], [role='dialog'][aria-modal='true']",
        )
      )
        cancelInteraction();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open", "aria-modal"],
    });
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect();
      session.current.reset();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const activeMeasurement =
    tool === "measure" && enabled
      ? gesture?.kind === "measure"
        ? gesture.ruler
        : measurement
      : null;
  const ruler =
    activeMeasurement && measurementCurrent(activeMeasurement, grid)
      ? activeMeasurement
      : null;

  useEffect(() => {
    const world = worldRef.current;
    if (!ready || !world) return;
    for (const child of world.removeChildren())
      child.destroy({ children: true });
    world.position.set(view.x, view.y);
    world.scale.set(view.scale);
    const gridLines = new Graphics(),
      area = visibleGrid(view, viewport.width, viewport.height, grid.settings);
    if (area) {
      for (const x of area.vertical)
        gridLines.moveTo(x, area.top).lineTo(x, area.bottom);
      for (const y of area.horizontal)
        gridLines.moveTo(area.left, y).lineTo(area.right, y);
    }
    gridLines.stroke({ color: "#c7c6b9", width: 1, alpha: 0.5 });
    world.addChild(gridLines);
    const drawingLayer = new Container({ label: "Drawings" }),
      tokenLayer = new Container({ label: "Tokens" }),
      upperDrawingLayer = new Container({ label: "Drawings above tokens" }),
      upperTokenLayer = new Container({ label: "Tokens above drawings" }),
      selectionLayer = new Container({ label: "Selection" });
    world.addChild(
      drawingLayer,
      tokenLayer,
      upperDrawingLayer,
      upperTokenLayer,
      selectionLayer,
    );
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
        grid.settings,
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
      const contentLayer =
        drawingLayerOf(drawing) === "above-tokens"
          ? upperDrawingLayer
          : drawingLayer;
      const first = drawing.points[0];
      const last = drawing.points.at(-1);
      if (!first || !last) continue;
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
        selectionLayer.addChild(outline);
      }
    }
    for (const original of state.tokens) {
      const preview = previews.get(original.id);
      const token = preview && "position" in preview ? preview : original;
      const contentLayer =
        tokenLayerOf(token) === "above-drawings" ? upperTokenLayer : tokenLayer;
      const { x, y } = token.position;
      const graphic = new Graphics();
      graphic
        .circle(x + 2, y + 4, token.radius)
        .fill({ color: "#242e29", alpha: 0.18 });
      if (selected.includes(token.id))
        selectionLayer.addChild(
          new Graphics()
            .circle(x, y, token.radius + 6)
            .stroke({ color: "#405f4d", width: 2 }),
        );
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
        selectionLayer.addChild(
          new Graphics()
            .rect(p.x - size / 2, p.y - size / 2, size, size)
            .fill("#fffaf0")
            .stroke({ color: "#405f4d", width: 1.5 / view.scale }),
        );
      }
    }
    if (ruler) {
      const line = new Graphics();
      for (const [color, width] of [
        ["#fffaf0", 5],
        ["#9b5146", 2],
      ] as const) {
        line
          .moveTo(ruler.start.x, ruler.start.y)
          .lineTo(ruler.end.x, ruler.end.y)
          .stroke({ color, width: width / view.scale });
      }
      for (const p of [ruler.start, ruler.end])
        line
          .circle(p.x, p.y, 4 / view.scale)
          .fill("#fffaf0")
          .stroke({ color: "#9b5146", width: 2 / view.scale });
      selectionLayer.addChild(line);
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
      selectionLayer.addChild(rectangle);
    }
  }, [
    ready,
    ruler,
    state,
    grid,
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
  function trackCursor(event: ReactPointerEvent) {
    if (session.current.active && !session.current.owns(event.pointerId))
      return;
    if (event.pointerType !== "mouse" && !session.current.owns(event.pointerId))
      return;
    const box = host.current?.getBoundingClientRect();
    if (
      !sharing ||
      !enabled ||
      !box ||
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom ||
      (event.target !== host.current &&
        event.target !== appRef.current?.canvas) ||
      document.querySelector("dialog[open], [role='dialog'][aria-modal='true']")
    ) {
      if (pointer.current) {
        pointer.current = null;
        shareCursor(null);
      }
      return;
    }
    pointer.current = { clientX: event.clientX, clientY: event.clientY };
    shareCursor(point(event));
  }
  useEffect(() => {
    const hide = () => {
      pointer.current = null;
      cursorSender.current(null);
    };
    if (!sharing || !enabled) {
      hide();
      return;
    }
    const send = () => {
      if (
        document.visibilityState !== "visible" ||
        document.querySelector(
          "dialog[open], [role='dialog'][aria-modal='true']",
        )
      ) {
        hide();
        return;
      }
      const p = pointer.current,
        box = host.current?.getBoundingClientRect(),
        v = cursorView.current;
      if (p && box)
        cursorSender.current(
          {
            x: clamp((p.clientX - box.left - v.x) / v.scale),
            y: clamp((p.clientY - box.top - v.y) / v.scale),
          },
          true,
        );
    };
    send();
    const timer = setInterval(send, 1000);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", send);
    return () => {
      clearInterval(timer);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", send);
      hide();
    };
  }, [sharing, enabled]);
  useEffect(() => {
    if (sharing && enabled && pointer.current)
      shareCursor(point(pointer.current));
  }, [view]);
  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      !ready ||
      !enabled ||
      event.button !== 0 ||
      textAnchor ||
      (event.target !== host.current &&
        event.target !== appRef.current?.canvas) ||
      document.querySelector(
        "dialog[open], [role='dialog'][aria-modal='true']",
      ) ||
      !session.current.begin(event, gestureScope)
    )
      return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      cancelInteraction();
      return;
    }
    trackCursor(event);
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const p = point(event);
    if (tool === "measure") {
      event.preventDefault();
      setMeasurement(null);
      setGesture({
        kind: "measure",
        ruler: beginMeasurement(p, grid, snap),
        pointerId: event.pointerId,
      });
      return;
    }
    if (tool === "hand") {
      setGesture({ kind: "pan", start: local(event), origin: view });
      return;
    }
    if (tool === "text") {
      event.preventDefault();
      if (!pending)
        setGesture({
          kind: "tap",
          start: local(event),
          gridVersion: grid.version,
          action: {
            type: "text.open",
            anchor: snap ? snapPoint(p, 0, grid.settings) : p,
          },
        });
      return;
    }
    if (tool === "token") {
      if (!pending)
        setGesture({
          kind: "tap",
          start: local(event),
          gridVersion: grid.version,
          action: {
            type: "token.add",
            token: {
              id: crypto.randomUUID(),
              name: tokenName.trim() || "Token",
              position: snap
                ? snapPoint(p, grid.settings.spacing / 2, grid.settings)
                : p,
              color,
            },
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
            gridVersion: grid.version,
          });
          return;
        }
      }
    }
    const target =
      tool === "select" || tool === "erase"
        ? pickSceneObject(state, p, Math.max(3, 8 / view.scale))
        : undefined;
    if (tool === "erase") {
      if (!pending && target && canEditObject(member, target))
        setGesture({
          kind: "tap",
          start: local(event),
          gridVersion: grid.version,
          action: {
            type: "object.delete",
            objectId: target.id,
            expectedVersion: target.version,
          },
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
          gridVersion: grid.version,
          anchor: snap ? snapAnchor(editable, grid.settings) : null,
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
      const start =
        tool === "rectangle" && snap ? snapPoint(p, 0, grid.settings) : p;
      setGesture({
        kind: "draw",
        gridVersion: grid.version,
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
    trackCursor(event);
    const gesture = session.current.read(event.pointerId);
    if (!gesture) return;
    if ((event.buttons & 1) === 0) {
      cancelInteraction();
      session.current.finish(event.pointerId, "");
      return;
    }
    if (gesture.kind === "tap") {
      if (!withinTap(gesture.start, local(event), 1)) cancelInteraction();
      return;
    }
    if (gesture.kind === "measure") {
      if (gesture.pointerId !== event.pointerId) return;
      setGesture({
        ...gesture,
        ruler: updateMeasurement(gesture.ruler, point(event)),
      });
      return;
    }
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
    else if (gesture.kind === "draw") {
      const raw = point(event),
        p = gesture.snap ? snapPoint(raw, 0, grid.settings) : raw;
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
    const owned = session.current.owns(event.pointerId);
    const completed = session.current.finish(event.pointerId, gestureScope);
    if (!completed) {
      if (owned) cancelInteraction();
      return;
    }
    const gesture = completed.value;
    renderGesture(null);
    if (
      !ready ||
      !enabled ||
      document.querySelector("dialog[open], [role='dialog'][aria-modal='true']")
    ) {
      cancelInteraction();
      return;
    }
    if (event.pointerType !== "mouse") {
      if (pointer.current) {
        pointer.current = null;
        shareCursor(null);
      }
    }
    if (gesture?.kind === "measure") {
      if (gesture.pointerId !== event.pointerId) return;
      setMeasurement(
        finishMeasurement(gesture.ruler, point(event), view.scale, grid),
      );
      setGesture(null);
      return;
    }
    if (
      gesture &&
      "gridVersion" in gesture &&
      gesture.gridVersion !== grid.version
    ) {
      setGesture(null);
      return;
    }
    if (gesture?.kind === "tap") {
      const box = host.current!.getBoundingClientRect();
      if (
        !pending &&
        withinTap(gesture.start, local(event), 1) &&
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom
      ) {
        if (gesture.action.type === "text.open")
          setTextAnchor(gesture.action.anchor);
        else send(gesture.action);
      }
      return;
    }
    if (gesture?.kind === "resize") {
      const bounds = resizeDrag(
        gesture.drawing,
        gesture.corner,
        gesture.start,
        point(event),
        view.scale,
        gesture.snap,
        grid.settings,
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
          last = gesture.snap ? snapPoint(raw, 0, grid.settings) : raw,
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
  function focusBattlefield() {
    requestAnimationFrame(() => host.current?.focus({ preventScroll: true }));
  }
  function openPosition() {
    if (
      !enabled ||
      !ready ||
      pending ||
      session.current.active ||
      tool !== "select" ||
      !selected.length ||
      selectedObjects.length !== selected.length ||
      !selectedObjects.every((object) => canEditObject(member, object))
    )
      return;
    setPositionSelection(selectedObjects);
  }
  function openCreation() {
    if (!enabled || !ready || pending || session.current.active) return;
    setCreation({
      anchor: {
        x: clamp(Math.round((viewport.width / 2 - view.x) / view.scale)),
        y: clamp(Math.round((viewport.height / 2 - view.y) / view.scale)),
      },
      kind: tool === "rectangle" || tool === "text" ? tool : "token",
    });
  }
  function keyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const action = tabletopShortcut(
      {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
        defaultPrevented: event.defaultPrevented,
      },
      {
        focused:
          event.target === event.currentTarget &&
          event.currentTarget.ownerDocument.activeElement ===
            event.currentTarget,
        dialogOpen: Boolean(
          event.currentTarget.ownerDocument.querySelector(
            "dialog[open], [role='dialog'][aria-modal='true']",
          ),
        ),
        enabled: enabled && ready,
        gesture: session.current.active,
        pending,
        editableSelection:
          tool === "select" &&
          selectedObjects.length > 0 &&
          selectedObjects.length === selected.length &&
          selectedObjects.every((object) => canEditObject(member, object)),
        undoAvailable: history?.undo?.available === true,
        redoAvailable: history?.redo?.available === true,
      },
    );
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    switch (action.type) {
      case "blocked":
        break;
      case "tool":
        setTool(action.tool);
        break;
      case "history": {
        const command = sceneHistoryCommand(
          history,
          action.direction,
          enabled && ready,
          pending,
        );
        if (command) send(command);
        break;
      }
      case "position":
        openPosition();
        break;
      case "create":
        openCreation();
        break;
      case "objects":
        setObjectPickerOpen(true);
        break;
      case "nudge": {
        const command = keyboardMoveCommand(
          selectedObjects,
          state,
          member,
          action.direction,
          (snap ? grid.settings.spacing : 1) * (action.large ? 10 : 1),
          enabled && ready,
          pending,
        );
        if (command) send(command);
        break;
      }
      case "snap":
        setSnap((value) => !value);
        break;
      case "cancel":
        cancelInteraction();
        break;
      case "clear":
        setGesture(null);
        setMeasurement(null);
        setSelected([]);
        setSelectionError("");
        break;
      case "help":
        setShortcutsOpen(true);
        break;
      case "delete-review":
        setDeleteReview(captureDeletionReview(selectedObjects));
        break;
      case "zoom-in":
        zoom(1.25);
        break;
      case "zoom-out":
        zoom(0.8);
        break;
      case "zoom-reset":
        setView({ x: 0, y: 0, scale: 1 });
        break;
    }
  }
  return (
    <div
      ref={host}
      className={`tabletop tool-${tool}`}
      aria-label="Shared battlefield"
      aria-describedby="tabletop-keyboard-hint"
      role="region"
      tabIndex={0}
      onKeyDown={keyboard}
      onPointerDown={down}
      onPointerMove={move}
      onPointerEnter={trackCursor}
      onPointerLeave={() => {
        pointer.current = null;
        shareCursor(null);
      }}
      onPointerUp={up}
      onPointerCancel={(event) => {
        if (session.current.owns(event.pointerId)) cancelInteraction();
        session.current.finish(event.pointerId, "");
      }}
      onLostPointerCapture={(event) => {
        if (session.current.owns(event.pointerId)) cancelInteraction();
      }}
      onContextMenu={(event) => {
        if (session.current.active) {
          event.preventDefault();
          cancelInteraction();
        }
      }}
      onWheel={(event) => {
        if (enabled && !session.current.active && !textAnchor)
          zoom(event.deltaY > 0 ? 0.92 : 1.08, local(event));
      }}
    >
      {textAnchor && (
        <TextPlacementDialog
          anchor={textAnchor}
          color={color}
          enabled={enabled && !pending}
          close={() => {
            setTextAnchor(null);
            focusBattlefield();
          }}
          save={(drawing) => send({ type: "drawing.add", drawing })}
        />
      )}
      {enabled && (
        <ParticipantCursors
          cursors={cursors}
          members={onlineMembers}
          viewerId={member?.id ?? null}
          view={view}
        />
      )}
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
        !gesture &&
        tool !== "measure" && (
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
        title="Token centers snap to cells; room corners, drawing anchors and ruler endpoints snap to grid intersections. Groups keep their spacing."
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={snap}
          aria-keyshortcuts="S"
          onChange={(event) => setSnap(event.target.checked)}
        />{" "}
        Snap to grid
      </label>
      {((selected.length === 0 && !selectionError) || tool === "measure") && (
        <button
          className="shortcuts-open"
          aria-keyshortcuts="Shift+/"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={() => {
            setGesture(null);
            setShortcutsOpen(true);
          }}
        >
          Keyboard shortcuts
        </button>
      )}
      <label
        className="cursor-sharing"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={sharing}
          onChange={(e) => setSharing(e.target.checked)}
        />{" "}
        Share my cursor
      </label>
      <span className="keyboard-focus-hint" id="tabletop-keyboard-hint">
        Click or Tab to focus the battlefield. Press N to create an object or L
        to select objects; in Select mode use arrow keys to move them. Press ?
        for keyboard shortcuts.
      </span>
      {creation && (
        <CreateObjectDialog
          anchor={creation.anchor}
          kind={creation.kind}
          color={color}
          tokenName={tokenName}
          state={state}
          enabled={enabled && ready}
          pending={pending}
          send={send}
          close={() => {
            setCreation(null);
            focusBattlefield();
          }}
        />
      )}
      {objectPickerOpen && (
        <ObjectPickerDialog
          state={state}
          member={member}
          selected={selected}
          enabled={enabled}
          pending={pending}
          close={() => {
            setObjectPickerOpen(false);
            focusBattlefield();
          }}
          choose={(ids) => {
            setSelected(ids);
            setSelectionError("");
            setTool("select");
            setObjectPickerOpen(false);
            focusBattlefield();
          }}
        />
      )}
      {shortcutsOpen && (
        <KeyboardShortcutsDialog
          close={() => setShortcutsOpen(false)}
          restoreFocus={focusBattlefield}
        />
      )}
      {tool === "measure" && (
        <MeasurementControls
          measurement={ruler}
          snapping={snap}
          dragging={gesture?.kind === "measure"}
          enabled={enabled}
          clear={() => {
            setMeasurement(null);
            setGesture(null);
          }}
        />
      )}
      {tool !== "measure" && selected.length === 0 && (
        <div
          className="drawing-order-open"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            disabled={!enabled || pending}
            aria-keyshortcuts="L"
            onClick={() => {
              setGesture(null);
              setObjectPickerOpen(true);
            }}
          >
            Select objects…
          </button>
          <button
            disabled={!enabled || !ready || pending || !!gesture}
            aria-keyshortcuts="N"
            onClick={openCreation}
          >
            Create object…
          </button>
          {(["drawing", "token"] as const).map((kind) => (
            <button
              key={kind}
              disabled={
                !enabled ||
                pending ||
                !(kind === "drawing" ? state.drawings : state.tokens).length
              }
              onClick={() => {
                setGesture(null);
                setSceneOrder({ initial: null, kind });
              }}
            >
              {kind === "drawing" ? "Drawing" : "Token"} order…
            </button>
          ))}
        </div>
      )}
      {tool !== "measure" && (selected.length > 0 || selectionError) && (
        <div
          className="selection-controls"
          data-expanded={selectionActionsOpen}
          role="group"
          aria-label="Selection actions"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <button
            className="selection-actions-toggle"
            aria-expanded={selectionActionsOpen}
            aria-controls="selection-actions-body"
            onClick={() => setSelectionActionsOpen((value) => !value)}
          >
            <span aria-live="polite">
              {selectionError
                ? "Review selection"
                : `${selected.length} ${selectionType}${selected.length === 1 ? "" : "s"} selected`}
            </span>
            <span>{selectionActionsOpen ? "Hide actions" : "Actions…"}</span>
          </button>
          <div className="selection-actions-body" id="selection-actions-body">
            <button
              disabled={!enabled || !ready || pending || !!gesture}
              aria-keyshortcuts="N"
              onClick={openCreation}
            >
              Create object…
            </button>

            <button
              onClick={() => {
                setGesture(null);
                setShortcutsOpen(true);
              }}
            >
              Keyboard shortcuts
            </button>
            <button
              disabled={!enabled || pending}
              aria-keyshortcuts="L"
              onClick={() => {
                setGesture(null);
                setObjectPickerOpen(true);
              }}
            >
              Select objects…
            </button>
            <span role="status">
              {selectionError ||
                `${selected.length} ${selectionType}${selected.length === 1 ? "" : "s"} selected`}
            </span>
            <button
              disabled={
                !enabled ||
                !ready ||
                pending ||
                !!gesture ||
                tool !== "select" ||
                !selectedObjects.length ||
                selectedObjects.length !== selected.length ||
                !selectedObjects.every((object) =>
                  canEditObject(member, object),
                )
              }
              aria-keyshortcuts="G"
              onClick={openPosition}
            >
              Position selection…
            </button>
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
            {selectedObjects.length === 1 &&
              "kind" in selectedObjects[0]! &&
              selectedObjects[0].kind === "text" && (
                <button
                  disabled={!enabled || pending}
                  onClick={() => {
                    setGesture(null);
                    setEditText(selectedObjects[0] as Drawing);
                  }}
                >
                  Edit label…
                </button>
              )}
            {selectedObjects.length === 1 &&
              "kind" in selectedObjects[0]! &&
              selectedObjects[0].kind !== "text" && (
                <button
                  disabled={!enabled || pending}
                  onClick={() => {
                    setGesture(null);
                    setEditShape(selectedObjects[0] as Drawing);
                  }}
                >
                  Style shape…
                </button>
              )}
            {selectedObjects.length === 1 && (
              <button
                disabled={!enabled || pending}
                onClick={() => {
                  setGesture(null);
                  setSceneOrder({
                    initial: selectedObjects[0]!,
                    kind: "points" in selectedObjects[0]! ? "drawing" : "token",
                  });
                }}
              >
                Arrange {"points" in selectedObjects[0]! ? "drawing" : "token"}…
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
        </div>
      )}
      {positionSelection && (
        <PositionSelectionDialog
          objects={positionSelection}
          state={state}
          member={member}
          enabled={enabled && ready}
          pending={pending}
          send={send}
          close={() => {
            setPositionSelection(null);
            focusBattlefield();
          }}
        />
      )}
      {resizeSelection && (
        <ResizeSelectionDialog
          objects={resizeSelection}
          state={state}
          member={member}
          enabled={enabled}
          pending={pending}
          send={send}
          close={() => {
            setResizeSelection(null);
            focusBattlefield();
          }}
        />
      )}
      {sceneOrder && (
        <SceneOrderDialog
          kind={sceneOrder.kind}
          initial={sceneOrder.initial}
          state={state}
          member={member}
          enabled={enabled}
          pending={pending}
          close={() => {
            setSceneOrder(null);
            focusBattlefield();
          }}
          send={(command) => {
            const queued = send(command);
            if (
              queued &&
              (command.type === "drawing.reorder" ||
                command.type === "drawing.layer.update")
            )
              setSelected([command.drawingId]);
            if (
              queued &&
              (command.type === "token.reorder" ||
                command.type === "token.layer.update")
            )
              setSelected([command.tokenId]);
            return queued;
          }}
        />
      )}
      {editShape && (
        <ShapeStyleDialog
          drawing={editShape}
          state={state}
          member={member}
          enabled={enabled}
          pending={pending}
          send={send}
          close={() => {
            setEditShape(null);
            focusBattlefield();
          }}
        />
      )}
      {editText && (
        <EditTextDialog
          drawing={editText}
          state={state}
          member={member}
          enabled={enabled}
          pending={pending}
          send={send}
          close={() => {
            setEditText(null);
            focusBattlefield();
          }}
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
          close={() => {
            setResizeToken(null);
            focusBattlefield();
          }}
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
          close={() => {
            setDeleteReview(null);
            focusBattlefield();
          }}
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
