import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Graphics } from "pixi.js";
import { DEFAULT_TEXT_STYLE } from "@tableloom/core";
import type { Drawing, Token } from "@tableloom/core";
import {
  RetainedGraphics,
  SceneGraphics,
  drawingVisualKey,
  tokenVisualKey,
} from "./scene-graphics.js";

const drawing: Drawing = {
  id: "drawing",
  kind: "rectangle",
  points: [
    { x: 10, y: 20 },
    { x: 110, y: 80 },
  ],
  color: "#405f4d",
  ownerId: null,
  version: 1,
};
const token: Token = {
  id: "token",
  name: "Scout",
  position: { x: 50, y: 60 },
  radius: 24,
  color: "#627d9c",
  ownerId: null,
  version: 1,
};

test("cloned snapshots and metadata keep resources; visual previews replace only changed objects and cancel cleanly", () => {
  const layer = new Container();
  const cache = new RetainedGraphics(drawingVisualKey, (d) => {
    const node = new Container({ label: d.id });
    node.addChild(new Graphics());
    return node;
  });
  const other = { ...drawing, id: "other" };
  cache.sync([drawing, other], () => layer);
  const [original, unchanged] = layer.children,
    child = original!.children[0]!;
  cache.sync(
    [
      { ...structuredClone(drawing), version: 2, ownerId: "new owner" },
      structuredClone(other),
    ],
    () => layer,
  );
  assert.deepEqual(layer.children, [original, unchanged]);
  // Same-version previews must invalidate: version/id-only caching leaves stale drags.
  cache.sync(
    [
      {
        ...drawing,
        points: drawing.points.map((p) => ({ x: p.x + 5, y: p.y })),
      },
      other,
    ],
    () => layer,
  );
  assert.equal(original!.destroyed, true);
  assert.equal(child.destroyed, true);
  const preview = layer.children[0]!;
  assert.equal(layer.children[1], unchanged);
  cache.sync([drawing, other], () => layer);
  assert.equal(preview.destroyed, true);
  assert.notEqual(layer.children[0], preview);
  assert.equal(layer.children[1], unchanged);
  cache.destroy();
  assert.equal(layer.children.length, 0);
  assert.equal(unchanged!.destroyed, true);
  cache.destroy();
  layer.destroy();
});

test("reordering and crossing layers preserve identity; removal/recreation releases resources without stale nodes", () => {
  const lower = new Container(),
    upper = new Container();
  const cache = new RetainedGraphics(
    tokenVisualKey,
    (t) => new Container({ label: t.id }),
  );
  const a = { ...token, id: "a" },
    b = { ...token, id: "b" },
    c = { ...token, id: "c" };
  const layer = (t: Token) => (t.layer === "above-drawings" ? upper : lower);
  cache.sync([a, b, c], layer);
  const [an, bn, cn] = lower.children;
  cache.sync([c, a, b], layer);
  assert.deepEqual(lower.children, [cn, an, bn]);
  cache.sync(
    [{ ...a, layer: "above-drawings" }, c, { ...b, layer: "above-drawings" }],
    layer,
  );
  assert.deepEqual(lower.children, [cn]);
  assert.deepEqual(upper.children, [an, bn]);
  cache.sync([c], layer);
  assert.equal(an!.destroyed, true);
  assert.equal(bn!.destroyed, true);
  cache.sync([a, c], layer);
  assert.notEqual(lower.children[0], an);
  assert.equal(lower.children[1], cn);
  cache.sync([], layer);
  assert.equal(lower.children.length, 0);
  assert.equal(upper.children.length, 0);
  assert.equal(cn!.destroyed, true);
  cache.destroy();
  lower.destroy();
  upper.destroy();
});

test("visual signatures cover shape/text/token styling and geometry, excluding ownership/order/layer metadata", () => {
  for (const change of [
    { ...drawing, kind: "stroke" as const },
    { ...drawing, color: "#ffffff" },
    {
      ...drawing,
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    },
    { ...drawing, shapeStyle: { lineWidth: 8, fill: null } },
    {
      ...drawing,
      shapeStyle: { lineWidth: 2, fill: { color: "#ffffff", opacity: 0.5 } },
    },
  ])
    assert.notEqual(drawingVisualKey(change), drawingVisualKey(drawing));
  const text = {
    ...drawing,
    kind: "text" as const,
    text: "Label",
    textStyle: DEFAULT_TEXT_STYLE,
  };
  for (const change of [
    { ...text, text: "Edited" },
    {
      ...text,
      textStyle: { ...DEFAULT_TEXT_STYLE, font: "serif" as const },
    },
    { ...text, textStyle: { ...DEFAULT_TEXT_STYLE, weight: "bold" as const } },
    { ...text, textStyle: { ...DEFAULT_TEXT_STYLE, align: "center" as const } },
  ])
    assert.notEqual(drawingVisualKey(change), drawingVisualKey(text));
  for (const change of [
    { ...token, name: "Renamed" },
    { ...token, color: "#ffffff" },
    { ...token, radius: 48 },
    { ...token, position: { x: 51, y: 60 } },
    { ...token, position: { x: 50, y: 61 } },
  ])
    assert.notEqual(tokenVisualKey(change), tokenVisualKey(token));
  assert.equal(
    drawingVisualKey({
      ...drawing,
      version: 3,
      ownerId: "owner",
      layer: "above-tokens",
    }),
    drawingVisualKey(drawing),
  );
  assert.equal(
    tokenVisualKey({
      ...token,
      version: 3,
      ownerId: "owner",
      layer: "above-drawings",
    }),
    tokenVisualKey(token),
  );
});

test("real scene containers maintain paint order across snapshots and dispose all cached content on teardown", () => {
  const world = new Container(),
    scene = new SceneGraphics(world);
  scene.sync([drawing], [token]);
  assert.deepEqual(
    world.children.map((n) => n.label),
    [
      scene.grid.label,
      "Drawings",
      "Tokens",
      "Drawings above tokens",
      "Tokens above drawings",
      "Selection",
    ],
  );
  const drawingNode = world.children[1]!.children[0]!,
    tokenNode = world.children[2]!.children[0]!;
  scene.sync([structuredClone(drawing)], [structuredClone(token)]);
  assert.equal(world.children[1]!.children[0], drawingNode);
  assert.equal(world.children[2]!.children[0], tokenNode);
  scene.sync(
    [{ ...drawing, layer: "above-tokens" }],
    [{ ...token, layer: "above-drawings" }],
  );
  assert.equal(world.children[1]!.children.length, 0);
  assert.equal(world.children[2]!.children.length, 0);
  assert.equal(world.children[3]!.children[0], drawingNode);
  assert.equal(world.children[4]!.children[0], tokenNode);
  scene.destroy();
  assert.equal(world.children.length, 0);
  assert.ok(
    drawingNode.destroyed &&
      tokenNode.destroyed &&
      scene.selection.destroyed &&
      scene.grid.destroyed,
  );
  scene.destroy();
  world.destroy();
});
