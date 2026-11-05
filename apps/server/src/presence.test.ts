import { test } from "node:test";
import assert from "node:assert/strict";
import { presenceDataSchema, serverMessageSchema } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { projectPresence } from "./presence.js";
const member = (name: string, role: "gm" | "player" = "player"): Member => ({
  id: crypto.randomUUID(),
  tableId: crypto.randomUUID(),
  name,
  role,
});
test("public presence deduplicates identities rather than names, counts tabs and strips scope/credential/activity fields", () => {
  const a = member("Same"),
    b = member("Same"),
    gm = member("GM", "gm"),
    spoof = {
      ...a,
      credential: "private",
      sessionId: "private",
      lastSeen: 123,
      sceneId: crypto.randomUUID(),
    };
  const result = projectPresence([b, gm, spoof, a]);
  assert.equal(result.participants, 4);
  assert.equal(result.onlineMembers.length, 3);
  assert.equal(result.onlineMembers[0]!.id, gm.id);
  assert.deepEqual(result, projectPresence([a, spoof, gm, b]));
  for (const row of result.onlineMembers)
    assert.deepEqual(Object.keys(row).sort(), ["id", "name", "role"]);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(!JSON.stringify(result).includes(a.tableId));
  assert.deepEqual(projectPresence([]), { participants: 0, onlineMembers: [] });
});
test("presence boundaries reject duplicates, incoherent counts, unknown/secret fields and invalid names/roles while bounding a full roster", () => {
  const a = member("One"),
    publicMember = { id: a.id, name: a.name, role: a.role };
  for (const value of [
    { participants: 0, onlineMembers: [publicMember] },
    { participants: 1, onlineMembers: [] },
    { participants: 2, onlineMembers: [publicMember, publicMember] },
    { participants: 1, onlineMembers: [{ ...publicMember, token: "secret" }] },
    { participants: 1, onlineMembers: [{ ...publicMember, name: " " }] },
    { participants: 1, onlineMembers: [{ ...publicMember, role: "admin" }] },
    {
      participants: Number.MAX_SAFE_INTEGER + 1,
      onlineMembers: [publicMember],
    },
    { participants: 1, onlineMembers: [publicMember], session: "secret" },
  ])
    assert.equal(presenceDataSchema.safeParse(value).success, false);
  const full = projectPresence(
    Array.from({ length: 1000 }, () => member("界".repeat(32))),
  );
  assert.equal(full.onlineMembers.length, 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) < 256 * 1024);
  assert.throws(() =>
    projectPresence(Array.from({ length: 1001 }, () => member("Max"))),
  );
  const frame = {
    type: "presence",
    campaignId: a.tableId,
    participants: 1,
    onlineMembers: [publicMember],
  };
  assert.equal(serverMessageSchema.safeParse(frame).success, true);
  assert.equal(
    serverMessageSchema.safeParse({ ...frame, campaignId: undefined }).success,
    false,
  );
  assert.equal(
    serverMessageSchema.safeParse({ ...frame, onlineMembers: undefined })
      .success,
    false,
  );
});
