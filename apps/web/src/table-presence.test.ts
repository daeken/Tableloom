import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TablePresence } from "./TablePresence.js";
test("presence UI withholds stale names while disconnected and renders connected names as literal text with distinct people/connections", () => {
  const members = [
      { id: crypto.randomUUID(), name: "GM Rowan", role: "gm" as const },
      { id: crypto.randomUUID(), name: "Nora <&>", role: "player" as const },
    ],
    props = { members, connections: 3, viewerId: members[0]!.id };
  const disconnected = renderToStaticMarkup(
    createElement(TablePresence, { ...props, connected: false }),
  );
  assert.ok(!disconnected.includes("GM Rowan"));
  assert.ok(!disconnected.includes("Nora"));
  assert.ok(!disconnected.includes('role="listitem"'));
  const connected = renderToStaticMarkup(
    createElement(TablePresence, { ...props, connected: true }),
  );
  assert.match(connected, /Nora &lt;&amp;&gt;/);
  assert.ok(!connected.includes("Nora <&>"));
  assert.match(connected, /2 at the table/);
  assert.match(connected, /2 people · 3 connections/);
  assert.match(connected, /GM · You/);
  assert.match(connected, /Player/);
  assert.equal((connected.match(/role="listitem"/g) ?? []).length, 2);
});
