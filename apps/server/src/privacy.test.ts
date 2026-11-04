import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { serverMessageSchema, tableViewSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { createApp } from "./app.js";
import { TableStore } from "./store.js";

const KEY = "tableloom-private-roll-api-fixture-not-a-real-key";
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for projected table state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function connect(url: string, cookie: string) {
  const ws = new WebSocket(`${url.replace("http", "ws")}/api/live`, {
    headers: { Origin: url, Cookie: cookie },
  });
  const raw: string[] = [];
  const messages: ServerMessage[] = [];
  ws.on("message", (data) => {
    raw.push(data.toString());
    messages.push(serverMessageSchema.parse(JSON.parse(data.toString())));
  });
  await once(ws, "open");
  return { ws, raw, messages };
}

test("private rolls never reach other players through live frames, HTTP, retries, reconnects, or restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-private-rolls-"));
  const databasePath = join(directory, "table.sqlite");
  let app = await createApp({ databasePath, hostKey: KEY });
  const sockets: WebSocket[] = [];
  const post = (route: string, payload: unknown, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/access/${route}`,
      headers: {
        Origin: "http://localhost",
        Cookie: cookie,
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
  const getCookie = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  const read = async (cookie: string) => {
    const response = await app.inject({
      url: "/api/table",
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.body.includes('"revision":'), false);
    return tableViewSchema.parse(response.json());
  };
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gmCookie = getCookie(await post("setup", { key: KEY, name: "GM" }));
    async function joinPlayer(name: string) {
      const invitation = await post("invitations", {}, gmCookie);
      return getCookie(
        await post("join", { name, code: invitation.json().token }),
      );
    }
    const aliceCookie = await joinPlayer("Alice");
    const bobCookie = await joinPlayer("Bob");
    const gm = await connect(url, gmCookie);
    sockets.push(gm.ws);
    const alice = await connect(url, aliceCookie);
    sockets.push(alice.ws);
    const bob = await connect(url, bobCookie);
    sockets.push(bob.ws);
    await until(() =>
      [gm, alice, bob].every((client) =>
        client.messages.some(
          (m) => m.type === "presence" && m.participants === 3,
        ),
      ),
    );
    const bobInitial = await read(bobCookie);
    const privateCommand = {
      id: randomUUID(),
      type: "dice.roll",
      expression: "2d37 + 19",
      visibility: "gm",
    };
    alice.ws.send(JSON.stringify(privateCommand));
    await until(() =>
      [gm, alice].every((client) =>
        client.messages.some(
          (m) => m.type === "snapshot" && m.state.rolls.length === 1,
        ),
      ),
    );
    const alicePrivate = (await read(aliceCookie)).rolls[0]!;
    assert.equal(alicePrivate.visibility, "gm");
    assert.deepEqual(await read(bobCookie), bobInitial);

    // A public update is an ordering barrier for all previously written frames.
    bob.ws.send(
      JSON.stringify({ id: randomUUID(), type: "dice.roll", expression: "d6" }),
    );
    await until(() =>
      [gm, alice, bob].every((client) =>
        client.messages.some(
          (m) =>
            m.type === "snapshot" &&
            m.state.rolls.some((r) => r.actor === "Bob"),
        ),
      ),
    );
    assert.equal(bob.messages.filter((m) => m.type === "snapshot").length, 2);
    const beforeGmPrivate = await read(aliceCookie);
    gm.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "dice.roll",
        expression: "3d41 - 7",
        visibility: "gm",
      }),
    );
    await until(() =>
      gm.messages.some(
        (m) => m.type === "snapshot" && m.state.rolls.length === 3,
      ),
    );
    const gmPrivate = (await read(gmCookie)).rolls.at(-1)!;
    assert.deepEqual(await read(aliceCookie), beforeGmPrivate);
    const bobPublic = await read(bobCookie);

    // Even a guessed/replayed private command ID only returns the caller's view.
    const count = bob.messages.filter((m) => m.type === "snapshot").length;
    bob.ws.send(JSON.stringify(privateCommand));
    await until(
      () =>
        bob.messages.filter((m) => m.type === "snapshot").length === count + 1,
    );
    assert.deepEqual(await read(bobCookie), bobPublic);
    assert.equal((await read(gmCookie)).rolls.length, 3);

    alice.ws.send(
      JSON.stringify({ id: randomUUID(), type: "dice.roll", expression: "d8" }),
    );
    await until(() =>
      [gm, alice, bob].every((client) =>
        client.messages.some(
          (m) =>
            m.type === "snapshot" &&
            m.state.rolls.some(
              (r) => r.actor === "Alice" && r.visibility === "public",
            ),
        ),
      ),
    );
    for (const raw of bob.raw) {
      assert.equal(raw.includes(alicePrivate.id), false);
      assert.equal(raw.includes(gmPrivate.id), false);
      assert.equal(raw.includes("2d37 + 19"), false);
      assert.equal(raw.includes("3d41 - 7"), false);
      assert.equal(raw.includes('"revision":'), false);
    }
    assert.ok(
      alice.raw.every(
        (raw) => !raw.includes(gmPrivate.id) && !raw.includes("3d41 - 7"),
      ),
    );
    const bobBeforeRestart = await read(bobCookie);
    const aliceBeforeRestart = await read(aliceCookie);
    assert.equal(bobBeforeRestart.rolls.length, 2);
    assert.equal(aliceBeforeRestart.rolls.length, 3);
    const unauthorized = await app.inject("/api/table");
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.body.includes(alicePrivate.id), false);

    const reconnected = await connect(url, bobCookie);
    sockets.push(reconnected.ws);
    await until(() => reconnected.messages.some((m) => m.type === "snapshot"));
    assert.ok(
      reconnected.raw.every(
        (raw) => !raw.includes(alicePrivate.id) && !raw.includes(gmPrivate.id),
      ),
    );
    await app.close();
    const store = new TableStore(databasePath);
    try {
      assert.equal(store.load().rolls.length, 4);
      assert.equal(
        store.load().rolls.filter((r) => r.visibility === "gm").length,
        2,
      );
    } finally {
      store.close();
    }
    app = await createApp({ databasePath, hostKey: KEY });
    const restarted = await app.listen({ port: 0, host: "127.0.0.1" });
    assert.deepEqual(await read(bobCookie), bobBeforeRestart);
    assert.deepEqual(await read(aliceCookie), aliceBeforeRestart);
    assert.equal((await read(gmCookie)).rolls.length, 4);
    const afterRestart = await connect(restarted, bobCookie);
    sockets.push(afterRestart.ws);
    await until(() => afterRestart.messages.some((m) => m.type === "snapshot"));
    assert.ok(
      afterRestart.raw.every(
        (raw) => !raw.includes(alicePrivate.id) && !raw.includes(gmPrivate.id),
      ),
    );
    afterRestart.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "dice.roll",
        expression: "d6",
        visibility: "blind",
      }),
    );
    await until(() => afterRestart.messages.some((m) => m.type === "error"));
    assert.deepEqual(await read(bobCookie), bobBeforeRestart);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("note visibility changes, stale writes, deletion, retries, and restart preserve per-recipient privacy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-private-notes-"));
  const databasePath = join(directory, "table.sqlite");
  let app = await createApp({ databasePath, hostKey: KEY });
  const sockets: WebSocket[] = [];
  const post = (route: string, payload: unknown, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/access/${route}`,
      headers: {
        Origin: "http://localhost",
        Cookie: cookie,
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
  const getCookie = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  const read = async (cookie: string) =>
    tableViewSchema.parse(
      (await app.inject({ url: "/api/table", headers: { cookie } })).json(),
    );
  const gmId = randomUUID();
  const aliceId = randomUUID();
  const restoredId = randomUUID();
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gmCookie = getCookie(await post("setup", { key: KEY, name: "GM" }));
    async function joinPlayer(name: string) {
      const invitation = await post("invitations", {}, gmCookie);
      return getCookie(
        await post("join", { name, code: invitation.json().token }),
      );
    }
    const aliceCookie = await joinPlayer("Alice");
    const bobCookie = await joinPlayer("Bob");
    const gm = await connect(url, gmCookie);
    sockets.push(gm.ws);
    const alice = await connect(url, aliceCookie);
    sockets.push(alice.ws);
    const bob = await connect(url, bobCookie);
    sockets.push(bob.ws);
    await until(() =>
      [gm, alice, bob].every((client) =>
        client.messages.some(
          (m) => m.type === "presence" && m.participants === 3,
        ),
      ),
    );
    const beforeSecrets = await read(bobCookie);
    async function issue(
      client: Awaited<ReturnType<typeof connect>>,
      command: unknown,
      check: (message: ServerMessage) => boolean,
    ) {
      const start = client.messages.length;
      client.ws.send(JSON.stringify(command));
      await until(() => client.messages.slice(start).some(check));
    }
    const contains =
      (id: string, version: number) => (message: ServerMessage) =>
        message.type === "snapshot" &&
        message.state.notes.some(
          (note) => note.id === id && note.version === version,
        );
    const absent = (id: string) => (message: ServerMessage) =>
      message.type === "snapshot" &&
      !message.state.notes.some((note) => note.id === id);
    const rejected = (message: ServerMessage) => message.type === "error";
    await issue(
      gm,
      {
        id: randomUUID(),
        type: "note.add",
        note: {
          id: gmId,
          title: "private-gm-title",
          body: "original-gm-secret",
          visibility: "gm",
        },
      },
      contains(gmId, 1),
    );
    await issue(
      alice,
      {
        id: randomUUID(),
        type: "note.add",
        note: {
          id: aliceId,
          title: "private-alice-title",
          body: "original-alice-secret",
          visibility: "gm",
        },
      },
      contains(aliceId, 1),
    );
    assert.deepEqual(await read(bobCookie), beforeSecrets);
    assert.equal((await read(gmCookie)).notes.length, 2);
    assert.equal((await read(aliceCookie)).notes.length, 1);

    const reveal = {
      id: randomUUID(),
      type: "note.update",
      noteId: gmId,
      expectedVersion: 1,
      changes: {
        title: "Public GM note",
        body: "intentional-public-gm",
        visibility: "public",
      },
    };
    await issue(gm, reveal, contains(gmId, 2));
    await until(() => bob.messages.some(contains(gmId, 2)));
    assert.equal(bob.messages.filter((m) => m.type === "snapshot").length, 2);
    await issue(
      alice,
      {
        id: randomUUID(),
        type: "note.update",
        noteId: gmId,
        expectedVersion: 2,
        changes: {
          title: "Forged",
          body: "Not permitted",
          visibility: "public",
        },
      },
      rejected,
    );
    await issue(
      bob,
      {
        id: randomUUID(),
        type: "note.delete",
        noteId: gmId,
        expectedVersion: 2,
      },
      rejected,
    );
    assert.equal(
      (await read(gmCookie)).notes.find((n) => n.id === gmId)?.version,
      2,
    );

    const afterPublicFrames = bob.raw.length;
    await issue(
      gm,
      {
        id: randomUUID(),
        type: "note.update",
        noteId: gmId,
        expectedVersion: 2,
        changes: {
          title: "hidden-gm-title",
          body: "hidden-after-retraction",
          visibility: "gm",
        },
      },
      contains(gmId, 3),
    );
    await until(() =>
      bob.messages
        .slice(afterPublicFrames)
        .some(
          (m) =>
            m.type === "snapshot" && m.state.version === beforeSecrets.version,
        ),
    );
    assert.equal((await read(bobCookie)).notes.length, 0);
    for (const raw of bob.raw.slice(afterPublicFrames))
      assert.equal(raw.includes(gmId), false);
    for (const expectedVersion of [1, 3, 999]) {
      const count = bob.messages.length;
      await issue(
        bob,
        {
          id: randomUUID(),
          type: "note.update",
          noteId: gmId,
          expectedVersion,
          changes: { title: "Guess", body: "Guess", visibility: "public" },
        },
        rejected,
      );
      const response = bob.messages
        .slice(count)
        .find((m) => m.type === "error");
      assert.equal(
        response?.type === "error" ? response.message : "",
        "That note is unavailable.",
      );
    }
    const retries = bob.messages.length;
    bob.ws.send(JSON.stringify(reveal));
    await until(() => bob.messages.slice(retries).some(absent(gmId)));
    assert.equal(
      (await read(gmCookie)).notes.find((n) => n.id === gmId)?.visibility,
      "gm",
    );
    await issue(
      gm,
      {
        id: randomUUID(),
        type: "note.update",
        noteId: gmId,
        expectedVersion: 1,
        changes: { title: "Stale", body: "Must not win", visibility: "public" },
      },
      rejected,
    );
    assert.equal(
      (await read(gmCookie)).notes.find((n) => n.id === gmId)?.body,
      "hidden-after-retraction",
    );

    await issue(
      alice,
      {
        id: randomUUID(),
        type: "note.update",
        noteId: aliceId,
        expectedVersion: 1,
        changes: {
          title: "private-alice-title",
          body: "changed-alice-secret",
          visibility: "gm",
        },
      },
      contains(aliceId, 2),
    );
    assert.deepEqual(await read(bobCookie), beforeSecrets);
    await issue(
      gm,
      {
        id: randomUUID(),
        type: "note.delete",
        noteId: gmId,
        expectedVersion: 3,
      },
      absent(gmId),
    );
    await issue(
      alice,
      {
        id: randomUUID(),
        type: "note.update",
        noteId: aliceId,
        expectedVersion: 2,
        changes: {
          title: "Public Alice note",
          body: "intentional-public-alice",
          visibility: "public",
        },
      },
      contains(aliceId, 3),
    );
    await until(() => bob.messages.some(contains(aliceId, 3)));
    const beforeDelete = bob.messages.length;
    await issue(
      gm,
      {
        id: randomUUID(),
        type: "note.delete",
        noteId: aliceId,
        expectedVersion: 3,
      },
      absent(aliceId),
    );
    await until(() => bob.messages.slice(beforeDelete).some(absent(aliceId)));
    assert.equal((await read(aliceCookie)).notes.length, 0);
    await issue(
      alice,
      {
        id: randomUUID(),
        type: "note.add",
        note: {
          id: restoredId,
          title: "restart-private-title",
          body: "restart-private-body",
          visibility: "gm",
        },
      },
      contains(restoredId, 1),
    );

    for (const raw of bob.raw)
      for (const secret of [
        "original-gm-secret",
        "original-alice-secret",
        "hidden-after-retraction",
        "changed-alice-secret",
        "restart-private-body",
        restoredId,
      ])
        assert.equal(raw.includes(secret), false);
    assert.ok(
      alice.raw.every(
        (raw) =>
          !raw.includes("original-gm-secret") &&
          !raw.includes("hidden-after-retraction"),
      ),
    );
    const bobBeforeRestart = await read(bobCookie);
    await app.close();
    app = await createApp({ databasePath, hostKey: KEY });
    const restarted = await app.listen({ port: 0, host: "127.0.0.1" });
    assert.deepEqual(await read(bobCookie), bobBeforeRestart);
    assert.equal(
      (await read(aliceCookie)).notes[0]?.body,
      "restart-private-body",
    );
    assert.equal((await read(gmCookie)).notes[0]?.id, restoredId);
    const reconnected = await connect(restarted, bobCookie);
    sockets.push(reconnected.ws);
    await until(() => reconnected.messages.some((m) => m.type === "snapshot"));
    assert.ok(
      reconnected.raw.every(
        (raw) =>
          !raw.includes(restoredId) && !raw.includes("restart-private-body"),
      ),
    );
    assert.equal((await app.inject("/api/table")).statusCode, 401);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
