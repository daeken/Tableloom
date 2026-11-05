import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ParticipantCursors } from "./ParticipantCursors.js";
test("cursor overlays follow world camera coordinates, render literal roster names, and omit own/unknown identities", () => {
  const own = crypto.randomUUID(),
    peer = crypto.randomUUID(),
    unknown = crypto.randomUUID(),
    members = [
      { id: own, name: "Own hidden cursor", role: "gm" as const },
      { id: peer, name: "Nora <&>", role: "player" as const },
    ],
    cursors = [own, peer, unknown].map((memberId) => ({
      memberId,
      position: { x: 50, y: 60 },
    }));
  const html = renderToStaticMarkup(
    createElement(ParticipantCursors, {
      members,
      cursors,
      viewerId: own,
      view: { x: 100, y: 200, scale: 2 },
    }),
  );
  assert.match(html, /left:200px/);
  assert.match(html, /top:320px/);
  assert.match(html, /Nora &lt;&amp;&gt;/);
  assert.ok(!html.includes("Own hidden cursor"));
  assert.ok(!html.includes(unknown));
  assert.equal((html.match(/<svg/g) ?? []).length, 1);
  assert.match(html, /aria-hidden="true"/);
});
