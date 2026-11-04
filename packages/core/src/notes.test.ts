import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  commandSchema,
  createTable,
  MAX_TABLE_NOTES,
  restoreTable,
} from "./index.js";
import type { Command, Note, TableState } from "./index.js";
import type { Member } from "./access.js";
import { applyCommand, projectTable } from "./server.js";

const alice: Member = {
  id: randomUUID(),
  name: "Alice",
  role: "player",
  tableId: "00000000-0000-4000-8000-000000000001",
};
const bob: Member = {
  id: randomUUID(),
  name: "Bob",
  role: "player",
  tableId: "00000000-0000-4000-8000-000000000001",
};
const gm: Member = {
  id: randomUUID(),
  name: "GM",
  role: "gm",
  tableId: "00000000-0000-4000-8000-000000000001",
};
const fields = (visibility: Note["visibility"] = "gm") => ({
  title: "Test note",
  body: "Private fixture text",
  visibility,
});
const add = (
  state: TableState,
  member: Member,
  visibility: Note["visibility"] = "gm",
) =>
  applyCommand(
    state,
    {
      id: randomUUID(),
      type: "note.add",
      note: { id: randomUUID(), ...fields(visibility) },
    },
    member,
  );

test("private notes project only to owner/GM and hidden edits do not change another member's view", () => {
  let state = add(createTable(), alice);
  state = add(state, gm);
  state = add(state, bob, "public");
  const aliceId = state.notes[0]!.id;
  const gmId = state.notes[1]!.id;
  assert.equal(projectTable(state, alice).notes.length, 2);
  assert.equal(projectTable(state, bob).notes.length, 1);
  assert.equal(projectTable(state, gm).notes.length, 3);
  assert.equal(
    JSON.stringify(projectTable(state, bob)).includes(aliceId),
    false,
  );
  assert.equal(
    JSON.stringify(projectTable(state, alice)).includes(gmId),
    false,
  );
  const before = projectTable(state, bob);
  const changed = applyCommand(
    state,
    {
      id: randomUUID(),
      type: "note.update",
      noteId: aliceId,
      expectedVersion: 1,
      changes: { ...fields(), body: "Changed secret" },
    },
    alice,
  );
  assert.deepEqual(projectTable(changed, bob), before);
  assert.equal(state.notes[0]?.version, 1);
  assert.equal(changed.notes[0]?.version, 2);
});

test("note read/write permissions distinguish public readers, owners, and the GM", () => {
  const privateState = add(createTable(), alice);
  const noteId = privateState.notes[0]!.id;
  const update: Command = {
    id: randomUUID(),
    type: "note.update",
    noteId,
    expectedVersion: 1,
    changes: fields("public"),
  };
  const remove: Command = {
    id: randomUUID(),
    type: "note.delete",
    noteId,
    expectedVersion: 1,
  };
  for (const command of [update, remove]) {
    assert.throws(
      () => applyCommand(privateState, command, bob),
      /^Error: That note is unavailable\.$/,
    );
    for (const member of [alice, gm])
      assert.equal(applyCommand(privateState, command, member).revision, 2);
  }
  const publicState = add(createTable(), alice, "public");
  for (const command of [update, remove]) {
    assert.throws(
      () =>
        applyCommand(
          publicState,
          { ...command, noteId: publicState.notes[0]!.id },
          bob,
        ),
      /Only the owner or GM/,
    );
  }
});

test("visibility changes retract notes and stale updates/deletes cannot overwrite a newer version", () => {
  const publicState = add(createTable(), alice, "public");
  const noteId = publicState.notes[0]!.id;
  const command: Command = {
    id: randomUUID(),
    type: "note.update",
    noteId,
    expectedVersion: 1,
    changes: fields(),
  };
  const hidden = applyCommand(publicState, command, gm);
  assert.equal(projectTable(publicState, bob).notes.length, 1);
  assert.equal(projectTable(hidden, bob).notes.length, 0);
  assert.equal(hidden.notes[0]?.ownerId, alice.id);
  assert.throws(() => applyCommand(hidden, command, alice), /note changed/);
  assert.throws(
    () =>
      applyCommand(
        hidden,
        { id: randomUUID(), type: "note.delete", noteId, expectedVersion: 1 },
        gm,
      ),
    /note changed/,
  );
  const deleted = applyCommand(
    hidden,
    { id: randomUUID(), type: "note.delete", noteId, expectedVersion: 2 },
    alice,
  );
  assert.equal(deleted.notes.length, 0);
  assert.equal(hidden.notes.length, 1);
});

test("note creation cannot forge owners, IDs are unique across scene objects, and storage/input are bounded", () => {
  const note = { id: randomUUID(), ...fields(), ownerId: gm.id, version: 99 };
  const command: Command = { id: randomUUID(), type: "note.add", note };
  assert.equal(commandSchema.safeParse(command).success, false);
  const state = applyCommand(createTable(), command, alice);
  assert.equal(state.notes[0]?.ownerId, alice.id);
  assert.equal(state.notes[0]?.version, 1);
  assert.equal(
    commandSchema.safeParse({
      id: randomUUID(),
      type: "note.add",
      note: { id: randomUUID(), ...fields(), body: "x".repeat(10001) },
    }).success,
    false,
  );
  const full: TableState = {
    ...state,
    notes: Array.from({ length: MAX_TABLE_NOTES }, () => ({
      ...state.notes[0]!,
      id: randomUUID(),
    })),
  };
  assert.throws(() => add(full, alice), /note limit/);
  assert.throws(
    () =>
      applyCommand(
        state,
        {
          id: randomUUID(),
          type: "token.add",
          token: {
            id: note.id,
            name: "Collision",
            position: { x: 0, y: 0 },
            color: "#405f4d",
          },
        },
        bob,
      ),
    /already exists/,
  );
  assert.throws(
    () =>
      applyCommand(
        state,
        {
          id: randomUUID(),
          type: "note.add",
          note: { id: note.id, ...fields() },
        },
        bob,
      ),
    /already exists/,
  );
});

test("version 3 migration preserves private rolls and initializes an empty notes collection", () => {
  const rolled = applyCommand(
    createTable(),
    { id: randomUUID(), type: "dice.roll", expression: "d6", visibility: "gm" },
    alice,
  );
  const legacy = { ...rolled, schemaVersion: 3 };
  Reflect.deleteProperty(legacy, "notes");
  const result = restoreTable(legacy);
  assert.equal(result.state.schemaVersion, 4);
  assert.equal(result.state.revision, rolled.revision);
  assert.deepEqual(result.state.notes, []);
  assert.deepEqual(result.state.rolls, rolled.rolls);
  assert.equal(projectTable(result.state, bob).rolls.length, 0);
});
