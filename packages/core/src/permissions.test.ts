import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  commandSchema,
  createTable,
  restoreTable,
  tableSchema,
} from "./index.js";
import type { Command, TableState } from "./index.js";
import type { Member } from "./access.js";
import { applyCommand } from "./server.js";
import { canEditObject } from "./permissions.js";

const alice: Member = {
  id: randomUUID(),
  name: "Alice",
  role: "player",
  tableId: "main",
};
const bob: Member = {
  id: randomUUID(),
  name: "Bob",
  role: "player",
  tableId: "main",
};
const gm: Member = {
  id: randomUUID(),
  name: "GM",
  role: "gm",
  tableId: "main",
};
const token = () => ({
  id: randomUUID(),
  name: "Scout",
  position: { x: 10, y: 20 },
  color: "#405f4d",
});
const drawing = () => ({
  id: randomUUID(),
  kind: "rectangle" as const,
  points: [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
  ],
  color: "#405f4d",
});

test("creation always assigns authenticated ownership, and clients cannot supply owner metadata", () => {
  for (const actor of [alice, bob, gm]) {
    const supplied = { ...token(), ownerId: bob.id };
    const addToken: Command = {
      id: randomUUID(),
      type: "token.add",
      token: supplied,
    };
    assert.equal(commandSchema.safeParse(addToken).success, false);
    const added = applyCommand(createTable(), addToken, actor);
    assert.equal(added.tokens[0]?.ownerId, actor.id);
    const suppliedDrawing = { ...drawing(), ownerId: gm.id };
    const addDrawing: Command = {
      id: randomUUID(),
      type: "drawing.add",
      drawing: suppliedDrawing,
    };
    assert.equal(commandSchema.safeParse(addDrawing).success, false);
    assert.equal(
      applyCommand(createTable(), addDrawing, actor).drawings[0]?.ownerId,
      actor.id,
    );
  }
});

test("owner/other-player/GM permission matrix covers token movement and both object deletions", () => {
  const t = token();
  const d = drawing();
  const state: TableState = {
    ...createTable(),
    tokens: [{ ...t, ownerId: alice.id }],
    drawings: [{ ...d, ownerId: alice.id }],
  };
  const commands: Command[] = [
    {
      id: randomUUID(),
      type: "token.move",
      tokenId: t.id,
      position: { x: 50, y: 60 },
    },
    { id: randomUUID(), type: "object.delete", objectId: t.id },
    { id: randomUUID(), type: "object.delete", objectId: d.id },
  ];
  const original = structuredClone(state);
  for (const command of commands) {
    for (const actor of [alice, gm])
      assert.equal(applyCommand(state, command, actor).revision, 1);
    assert.throws(() => applyCommand(state, command, bob), /owner or GM/);
    assert.deepEqual(state, original);
  }
  assert.equal(canEditObject(null, state.tokens[0]!), false);
  assert.equal(canEditObject(alice, state.tokens[0]!), true);
  assert.equal(canEditObject(bob, state.tokens[0]!), false);
});

test("system settings require the GM while all members can create objects and roll as themselves", () => {
  const state = createTable();
  const change: Command = {
    id: randomUUID(),
    type: "system.set",
    systemId: "kids-on-bikes",
  };
  for (const actor of [alice, bob])
    assert.throws(() => applyCommand(state, change, actor), /Only the GM/);
  assert.equal(applyCommand(state, change, gm).systemId, "kids-on-bikes");
  for (const actor of [alice, bob, gm]) {
    const rolled = applyCommand(
      state,
      { id: randomUUID(), type: "dice.roll", expression: "d6" },
      actor,
    );
    assert.equal(rolled.rolls[0]?.actor, actor.name);
    assert.equal(
      applyCommand(
        state,
        { id: randomUUID(), type: "token.add", token: token() },
        actor,
      ).revision,
      1,
    );
    assert.equal(
      applyCommand(
        state,
        { id: randomUUID(), type: "drawing.add", drawing: drawing() },
        actor,
      ).revision,
      1,
    );
  }
});

test("legacy objects are GM-controlled and unavailable targets do not change state", () => {
  const t = token();
  const d = drawing();
  const state: TableState = {
    ...createTable(),
    tokens: [{ ...t, ownerId: null }],
    drawings: [{ ...d, ownerId: null }],
  };
  for (const actor of [alice, bob]) {
    assert.throws(
      () =>
        applyCommand(
          state,
          {
            id: randomUUID(),
            type: "token.move",
            tokenId: t.id,
            position: { x: 0, y: 0 },
          },
          actor,
        ),
      /owner or GM/,
    );
    for (const object of [t, d])
      assert.throws(
        () =>
          applyCommand(
            state,
            { id: randomUUID(), type: "object.delete", objectId: object.id },
            actor,
          ),
        /owner or GM/,
      );
  }
  assert.equal(
    applyCommand(
      state,
      { id: randomUUID(), type: "object.delete", objectId: d.id },
      gm,
    ).drawings.length,
    0,
  );
  assert.throws(
    () =>
      applyCommand(
        state,
        { id: randomUUID(), type: "object.delete", objectId: randomUUID() },
        gm,
      ),
    /no longer exists/,
  );
  assert.equal(state.revision, 0);
});

test("tokens and drawings share an ID namespace, preventing ambiguous permission/deletion targets", () => {
  const t = token();
  const d = { ...drawing(), id: t.id };
  const withToken = applyCommand(
    createTable(),
    { id: randomUUID(), type: "token.add", token: t },
    alice,
  );
  assert.throws(
    () =>
      applyCommand(
        withToken,
        { id: randomUUID(), type: "drawing.add", drawing: d },
        bob,
      ),
    /already exists/,
  );
  const withDrawing = applyCommand(
    createTable(),
    { id: randomUUID(), type: "drawing.add", drawing: d },
    bob,
  );
  assert.throws(
    () =>
      applyCommand(
        withDrawing,
        { id: randomUUID(), type: "token.add", token: t },
        alice,
      ),
    /already exists/,
  );
  assert.equal(
    tableSchema.safeParse({
      ...withToken,
      drawings: [{ ...d, ownerId: bob.id }],
    }).success,
    false,
  );
});

test("version 1 migration preserves data/revision and defaults to GM control without accepting incomplete version 2", () => {
  const legacy = {
    ...createTable(),
    schemaVersion: 1,
    revision: 42,
    tokens: [token()],
    drawings: [drawing()],
  };
  const result = restoreTable(legacy);
  assert.equal(result.migrated, true);
  assert.equal(result.state.schemaVersion, 3);
  assert.equal(result.state.revision, 42);
  assert.deepEqual(
    result.state.tokens,
    legacy.tokens.map((t) => ({ ...t, ownerId: null })),
  );
  assert.deepEqual(
    result.state.drawings,
    legacy.drawings.map((d) => ({ ...d, ownerId: null })),
  );
  assert.equal(restoreTable(result.state).migrated, false);
  assert.throws(() => restoreTable({ ...legacy, schemaVersion: 2 }));
  assert.throws(() => restoreTable({ ...legacy, schemaVersion: 99 }));
  assert.equal(
    tableSchema.safeParse({
      ...result.state,
      tokens: [{ ...result.state.tokens[0], ownerId: "bogus" }],
    }).success,
    false,
  );
});
