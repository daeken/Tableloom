import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandSchema, createTable } from "./index.js";
import type { Command, TableState } from "./index.js";
import type { Member } from "./access.js";
import { applyCommand, projectTable } from "./server.js";
import { canEditObject } from "./permissions.js";

const member = (name: string, role: Member["role"] = "player"): Member => ({
  id: randomUUID(),
  name,
  role,
  tableId: "00000000-0000-4000-8000-000000000001",
});
const gm = member("GM", "gm"),
  alice = member("Alice"),
  bob = member("Bob"),
  carol = member("Carol");
function fixture() {
  const state = createTable();
  state.tokens.push({
    radius: 24,
    id: randomUUID(),
    name: "Scout",
    position: { x: 0, y: 0 },
    color: "#445566",
    ownerId: alice.id,
    version: 1,
  });
  state.drawings.push({
    id: randomUUID(),
    kind: "rectangle",
    points: [
      { x: 0, y: 0 },
      { x: 20, y: 30 },
    ],
    color: "#445566",
    ownerId: null,
    version: 1,
  });
  state.notes.push({
    id: randomUUID(),
    title: "Secret clue",
    body: "Hidden text",
    visibility: "gm",
    ownerId: alice.id,
    version: 1,
  });
  return state;
}

test("only the GM can assign scene ownership to a verified recipient; stale expectations and no-ops fail", () => {
  const state = fixture();
  const command: Command = {
    id: randomUUID(),
    type: "object.assign",
    expectedVersion: 1,
    objectId: state.tokens[0]!.id,
    expectedOwnerId: alice.id,
    ownerId: bob.id,
  };
  const original = structuredClone(state);
  for (const actor of [alice, bob])
    assert.throws(
      () => applyCommand(state, command, actor, bob),
      /Only the GM/,
    );
  for (const recipient of [undefined, null, alice])
    assert.throws(
      () => applyCommand(state, command, gm, recipient),
      /current member/,
    );
  const next = applyCommand(state, command, gm, bob);
  assert.deepEqual(state, original);
  assert.equal(next.tokens[0]?.ownerId, bob.id);
  assert.equal(next.revision, 1);
  assert.equal(canEditObject(alice, next.tokens[0]!), false);
  assert.equal(canEditObject(bob, next.tokens[0]!), true);
  assert.throws(() => applyCommand(next, command, gm, bob), /object changed/);
  assert.throws(
    () =>
      applyCommand(
        next,
        {
          ...command,
          expectedOwnerId: bob.id,
          expectedVersion: next.tokens[0]!.version,
        },
        gm,
        bob,
      ),
    /already owns/,
  );
  const legacy = applyCommand(
    next,
    { ...command, objectId: next.drawings[0]!.id, expectedOwnerId: null },
    gm,
    bob,
  );
  assert.equal(legacy.drawings[0]?.ownerId, bob.id);
  assert.throws(
    () =>
      applyCommand(
        state,
        { ...command, objectId: state.notes[0]!.id },
        gm,
        bob,
      ),
    /no longer exists/,
  );
});

test("private-note reassignment requires explicit acknowledgement, advances edit versions, and transfers the filtered audience", () => {
  const state = fixture();
  const note = state.notes[0]!;
  const command: Command = {
    id: randomUUID(),
    type: "note.assign",
    noteId: note.id,
    expectedVersion: 1,
    ownerId: bob.id,
  };
  for (const actor of [alice, bob])
    assert.throws(
      () => applyCommand(state, command, actor, bob),
      /Only the GM/,
    );
  assert.throws(
    () => applyCommand(state, command, gm, bob),
    /Confirm.*private note/,
  );
  const confirmed = { ...command, acknowledgePrivateAccess: true as const };
  assert.throws(() => applyCommand(state, confirmed, gm), /current member/);
  const next = applyCommand(state, confirmed, gm, bob);
  assert.equal(next.notes[0]?.version, 2);
  assert.equal(next.notes[0]?.visibility, "gm");
  assert.equal(projectTable(next, alice).notes.length, 0);
  assert.equal(projectTable(next, bob).notes[0]?.body, note.body);
  assert.equal(projectTable(next, gm).notes[0]?.ownerId, bob.id);
  assert.deepEqual(projectTable(next, carol), projectTable(state, carol));
  assert.throws(() => applyCommand(next, confirmed, gm, bob), /note changed/);
  assert.throws(
    () =>
      applyCommand(
        next,
        {
          id: randomUUID(),
          type: "note.update",
          noteId: note.id,
          expectedVersion: 1,
          changes: { title: note.title, body: "Stale", visibility: "gm" },
        },
        gm,
      ),
    /note changed/,
  );
  assert.throws(
    () =>
      applyCommand(
        next,
        {
          id: randomUUID(),
          type: "note.delete",
          noteId: note.id,
          expectedVersion: 2,
        },
        alice,
      ),
    /unavailable/,
  );
  const gmOwned = applyCommand(
    next,
    { ...confirmed, expectedVersion: 2, ownerId: gm.id },
    gm,
    gm,
  );
  assert.equal(projectTable(gmOwned, bob).notes.length, 0);
  assert.equal(projectTable(gmOwned, gm).notes.length, 1);
  assert.deepEqual(state.notes[0], note);
});

test("shared notes keep their audience while edit rights move, and ownership payloads cannot publish or spoof membership", () => {
  const state: TableState = fixture();
  state.notes[0]!.visibility = "public";
  const command = {
    id: randomUUID(),
    type: "note.assign" as const,
    noteId: state.notes[0]!.id,
    expectedVersion: 1,
    ownerId: bob.id,
  };
  assert.equal(
    commandSchema.safeParse({ ...command, visibility: "public" }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...command, recipient: bob }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...command, acknowledgePrivateAccess: false })
      .success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...command, ownerId: null }).success,
    false,
  );
  const next = applyCommand(state, command, gm, bob);
  assert.equal(projectTable(next, alice).notes.length, 1);
  assert.equal(projectTable(next, carol).notes.length, 1);
  const edit: Command = {
    id: randomUUID(),
    type: "note.update",
    noteId: command.noteId,
    expectedVersion: 2,
    changes: { title: "Updated", body: "Shared text", visibility: "public" },
  };
  assert.throws(() => applyCommand(next, edit, alice), /Only the owner/);
  assert.equal(applyCommand(next, edit, bob).notes[0]?.title, "Updated");
  const scene = {
    id: randomUUID(),
    type: "object.assign",
    expectedVersion: 1,
    objectId: state.tokens[0]!.id,
    expectedOwnerId: alice.id,
    ownerId: bob.id,
  };
  assert.equal(
    commandSchema.safeParse({ ...scene, role: "gm" }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...scene, expectedOwnerId: undefined }).success,
    false,
  );
});
