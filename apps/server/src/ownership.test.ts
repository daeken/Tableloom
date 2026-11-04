import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { serverMessageSchema, tableViewSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { createApp } from "./app.js";
import { TableStore } from "./store.js";

const KEY = "tableloom-ownership-test-fixture-not-a-real-key";
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Ownership update did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function connect(url: string, cookie: string) {
  const ws = new WebSocket(`${url.replace("http", "ws")}/api/live`, {
    headers: { Origin: url, Cookie: cookie },
  });
  const raw: string[] = [],
    messages: ServerMessage[] = [];
  ws.on("message", (data) => {
    raw.push(data.toString());
    messages.push(serverMessageSchema.parse(JSON.parse(data.toString())));
  });
  await once(ws, "open");
  return { ws, raw, messages };
}

test("ownership commands validate live membership, enforce new rights, filter changed note audiences, and survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-ownership-"));
  const databasePath = join(directory, "table.sqlite");
  let app = await createApp({ databasePath, hostKey: KEY });
  const store = new TableStore(databasePath);
  const sockets: WebSocket[] = [];
  const post = (route: string, payload: unknown, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/access/${route}`,
      headers: {
        origin: "http://localhost",
        cookie,
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  const read = async (cookie: string) => {
    const response = await app.inject({
      url: "/api/table",
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    return tableViewSchema.parse(response.json());
  };
  const send = (client: Awaited<ReturnType<typeof connect>>, command: object) =>
    client.ws.send(JSON.stringify(command));
  const denied = async (
    client: Awaited<ReturnType<typeof connect>>,
    command: object,
    pattern: RegExp,
  ) => {
    const before = store.load();
    const start = client.messages.length;
    send(client, command);
    await until(() =>
      client.messages.slice(start).some((m) => m.type === "error"),
    );
    const error = client.messages.slice(start).find((m) => m.type === "error");
    assert.match(error?.type === "error" ? error.message : "", pattern);
    assert.deepEqual(store.load(), before);
    assert.equal(store.hasCommand((command as { id: string }).id), false);
  };
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const setup = await post("setup", { name: "GM", key: KEY });
    const gmCookie = cookieOf(setup),
      gmId: string = setup.json().member.id;
    async function player(name: string) {
      const invitation = await post("invitations", {}, gmCookie);
      const response = await post("join", {
        name,
        code: invitation.json().token,
      });
      return {
        cookie: cookieOf(response),
        id: String(response.json().member.id),
      };
    }
    const alice = await player("Alice"),
      bob = await player("Bob"),
      carol = await player("Carol"),
      removed = await player("Removed");
    await post(`members/${removed.id}/remove`, {}, gmCookie);
    const gm = await connect(url, gmCookie),
      a = await connect(url, alice.cookie),
      b = await connect(url, bob.cookie),
      c = await connect(url, carol.cookie);
    sockets.push(gm.ws, a.ws, b.ws, c.ws);
    const noteId = randomUUID(),
      tokenId = randomUUID(),
      drawingId = randomUUID();
    send(a, {
      id: randomUUID(),
      type: "token.add",
      token: {
        id: tokenId,
        name: "Scout",
        position: { x: 0, y: 0 },
        color: "#405f4d",
      },
    });
    send(a, {
      id: randomUUID(),
      type: "drawing.add",
      drawing: {
        id: drawingId,
        kind: "rectangle",
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
        color: "#405f4d",
      },
    });
    send(a, {
      id: randomUUID(),
      type: "note.add",
      note: {
        id: noteId,
        title: "Secret to transfer",
        body: "Hidden transfer fixture",
        visibility: "gm",
      },
    });
    await until(() =>
      gm.messages.some(
        (m) => m.type === "snapshot" && m.state.notes.length === 1,
      ),
    );
    const carolBefore = await read(carol.cookie);
    const assignment = {
      id: randomUUID(),
      type: "note.assign",
      noteId,
      ownerId: bob.id,
      expectedVersion: 1,
      acknowledgePrivateAccess: true,
    };
    await denied(a, assignment, /Only the GM/);
    await denied(
      gm,
      { ...assignment, id: randomUUID(), acknowledgePrivateAccess: undefined },
      /Confirm.*private note/,
    );
    await denied(
      gm,
      { ...assignment, id: randomUUID(), ownerId: removed.id },
      /current member/,
    );
    await denied(
      gm,
      { ...assignment, id: randomUUID(), ownerId: randomUUID() },
      /current member/,
    );
    const aliceMark = a.raw.length;
    send(gm, assignment); // Same ID rejected for Alice above was not consumed.
    await until(() =>
      b.messages.some(
        (m) => m.type === "snapshot" && m.state.notes[0]?.ownerId === bob.id,
      ),
    );
    await until(() =>
      a.messages.some(
        (m) => m.type === "snapshot" && m.state.notes.length === 0,
      ),
    );
    assert.equal((await read(alice.cookie)).notes.length, 0);
    assert.equal((await read(bob.cookie)).notes[0]?.version, 2);
    assert.deepEqual(await read(carol.cookie), carolBefore);
    const retryStart = a.messages.length;
    send(a, assignment);
    await until(() =>
      a.messages.slice(retryStart).some((m) => m.type === "snapshot"),
    );
    assert.ok(
      !a.raw.slice(aliceMark).join("").includes("Hidden transfer fixture"),
    );
    assert.ok(!a.raw.slice(aliceMark).join("").includes(noteId));
    await denied(
      gm,
      { ...assignment, id: randomUUID(), ownerId: gmId },
      /note changed/,
    );
    await denied(
      a,
      { id: randomUUID(), type: "note.delete", noteId, expectedVersion: 2 },
      /unavailable/,
    );
    send(b, {
      id: randomUUID(),
      type: "note.update",
      noteId,
      expectedVersion: 2,
      changes: {
        title: "Secret to transfer",
        body: "Updated private text",
        visibility: "gm",
      },
    });
    await until(() =>
      gm.messages.some(
        (m) => m.type === "snapshot" && m.state.notes[0]?.version === 3,
      ),
    );
    const bobMark = b.messages.length;
    send(gm, {
      ...assignment,
      id: randomUUID(),
      expectedVersion: 3,
      ownerId: gmId,
    });
    await until(() =>
      b.messages
        .slice(bobMark)
        .some((m) => m.type === "snapshot" && m.state.notes.length === 0),
    );
    assert.equal((await read(bob.cookie)).notes.length, 0);
    const privateReconnect = await connect(url, bob.cookie);
    sockets.push(privateReconnect.ws);
    await until(() =>
      privateReconnect.messages.some((message) => message.type === "snapshot"),
    );
    assert.ok(!privateReconnect.raw.join("").includes(noteId));
    assert.ok(!privateReconnect.raw.join("").includes("Updated private text"));
    assert.deepEqual(await read(carol.cookie), carolBefore);
    // A public snapshot orders all earlier frames before the leakage assertions.
    send(gm, { id: randomUUID(), type: "dice.roll", expression: "d6" });
    await until(() =>
      [gm, a, b, c, privateReconnect].every((client) =>
        client.messages.some(
          (message) =>
            message.type === "snapshot" && message.state.rolls.length === 1,
        ),
      ),
    );
    assert.ok(
      !a.raw.slice(aliceMark).join("").includes("Updated private text"),
    );
    assert.ok(!b.raw.slice(bobMark).join("").includes(noteId));
    assert.ok(!c.raw.join("").includes(noteId));
    assert.ok(!c.raw.join("").includes("Updated private text"));
    send(gm, { ...assignment, id: randomUUID(), expectedVersion: 4 });
    await until(() =>
      b.messages.some(
        (m) => m.type === "snapshot" && m.state.notes[0]?.version === 5,
      ),
    );
    send(b, {
      id: randomUUID(),
      type: "note.update",
      noteId,
      expectedVersion: 5,
      changes: {
        title: "Shared clue",
        body: "Shared content",
        visibility: "public",
      },
    });
    await until(() =>
      c.messages.some(
        (m) => m.type === "snapshot" && m.state.notes[0]?.version === 6,
      ),
    );
    send(gm, {
      id: randomUUID(),
      type: "note.assign",
      noteId,
      ownerId: carol.id,
      expectedVersion: 6,
    });
    await until(() =>
      c.messages.some(
        (m) => m.type === "snapshot" && m.state.notes[0]?.version === 7,
      ),
    );
    assert.equal((await read(bob.cookie)).notes[0]?.visibility, "public");
    await denied(
      b,
      { id: randomUUID(), type: "note.delete", noteId, expectedVersion: 7 },
      /Only the owner/,
    );
    const tokenAssignment = {
      id: randomUUID(),
      type: "object.assign",
      objectId: tokenId,
      expectedOwnerId: alice.id,
      ownerId: bob.id,
    };
    await denied(a, tokenAssignment, /Only the GM/);
    await denied(
      gm,
      { ...tokenAssignment, id: randomUUID(), ownerId: removed.id },
      /current member/,
    );
    send(gm, tokenAssignment);
    await until(() =>
      b.messages.some(
        (m) => m.type === "snapshot" && m.state.tokens[0]?.ownerId === bob.id,
      ),
    );
    await denied(
      a,
      {
        id: randomUUID(),
        type: "token.move",
        tokenId,
        position: { x: 5, y: 5 },
      },
      /Only the owner/,
    );
    await denied(
      gm,
      { ...tokenAssignment, id: randomUUID(), ownerId: alice.id },
      /Ownership changed/,
    );
    send(b, {
      id: randomUUID(),
      type: "token.move",
      tokenId,
      position: { x: 30, y: 40 },
    });
    await until(() =>
      gm.messages.some(
        (m) => m.type === "snapshot" && m.state.tokens[0]?.position.x === 30,
      ),
    );
    send(gm, {
      id: randomUUID(),
      type: "object.assign",
      objectId: drawingId,
      expectedOwnerId: alice.id,
      ownerId: bob.id,
    });
    await until(() =>
      b.messages.some(
        (m) => m.type === "snapshot" && m.state.drawings[0]?.ownerId === bob.id,
      ),
    );
    await denied(
      a,
      { id: randomUUID(), type: "object.delete", objectId: drawingId },
      /Only the owner/,
    );
    send(b, { id: randomUUID(), type: "object.delete", objectId: drawingId });
    await until(() =>
      gm.messages.some(
        (m) =>
          m.type === "snapshot" &&
          m.state.drawings.length === 0 &&
          m.state.tokens[0]?.position.x === 30,
      ),
    );
    await app.close();
    app = await createApp({ databasePath, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    const reconnected = await connect(url, carol.cookie);
    sockets.push(reconnected.ws);
    await until(() =>
      reconnected.messages.some(
        (m) => m.type === "snapshot" && m.state.notes[0]?.ownerId === carol.id,
      ),
    );
    assert.equal((await read(bob.cookie)).tokens[0]?.ownerId, bob.id);
    assert.equal((await read(alice.cookie)).notes[0]?.ownerId, carol.id);
    assert.equal((await read(gmCookie)).drawings.length, 0);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
