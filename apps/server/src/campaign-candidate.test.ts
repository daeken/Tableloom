import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { commandSchema, type CommandInput } from "@tableloom/core";
import { applyCommand } from "@tableloom/core/server";
import {
  defineCampaignDataTransfer,
  remapCampaignDataReferences,
  type ServerSystemDefinition,
} from "@tableloom/module-sdk/server";
import { fixture, populate } from "./campaign-transfer-fixture.js";
import { inspectCampaignTransfer } from "./campaign-preflight.js";
import { parseCampaignTransfer } from "./campaign-transfer-format.js";
import {
  reviewCampaignOwnership,
  type OwnershipPlan,
} from "./campaign-ownership-plan.js";
import { prepareCampaignCandidate } from "./campaign-prepare.js";
import { documentSystems } from "./document-modules.js";
import { installedModules } from "./modules.js";
import { ContentCatalog } from "./content-catalog.js";
import { fixtureData } from "./content-fixture.js";
import { instanceData } from "./instances-fixture.js";
import { transaction } from "./database.js";
import { entryOf } from "./scene-history-model.js";

function setup(populated = true) {
  const f = fixture();
  if (populated) populate(f);
  const catalog = (content = f.catalog) => ({
    systems: installedModules,
    contentPacks: content.metadata(),
  });
  const inspect = (
    file: string,
    content = f.catalog,
    systems: readonly ServerSystemDefinition<unknown>[] = documentSystems,
  ) => inspectCampaignTransfer(file, catalog(content), content, systems, f.db);
  const review = (
    file: string,
    merge = false,
    content = f.catalog,
    systems: readonly ServerSystemDefinition<unknown>[] = documentSystems,
  ) => {
    const report = inspect(file, content, systems),
      plan: OwnershipPlan = {
        version: 1,
        archiveSha256: report.archiveSha256,
        acknowledge: "reviewed-private-content-and-access",
        acknowledgeMerges: merge,
        assignments: report.ownership.subjects.map((s) => ({
          sourceId: s.sourceId,
          target:
            merge || s.sourceId === f.gm.member.id
              ? { kind: "existing", userId: f.gm.member.id, role: "gm" }
              : { kind: "new", name: "Reviewed person", role: "player" },
        })),
      };
    return reviewCampaignOwnership(report, plan, f.db, f.gm.member.id);
  };
  const prepare = (
    file = f.snapshot(),
    merge = false,
    content = f.catalog,
    systems: readonly ServerSystemDefinition<unknown>[] = documentSystems,
    uuid: () => string = randomUUID,
  ) => {
    const before = f.db.prepare("SELECT total_changes() AS n").get()!.n;
    try {
      return prepareCampaignCandidate(
        file,
        review(file, merge, content, systems),
        catalog(content),
        content,
        systems,
        f.db,
        uuid,
      );
    } finally {
      assert.equal(
        f.db.prepare("SELECT total_changes() AS n").get()!.n,
        before,
      );
      assert.equal(f.db.isTransaction, false);
    }
  };
  const run = (input: CommandInput, actor = f.player.member) =>
    transaction(f.db, () => {
      const before = f.tables.load(),
        command = commandSchema.parse({ id: randomUUID(), ...input }),
        next =
          command.type === "scene.undo" || command.type === "scene.redo"
            ? f.history.apply(actor, before, command)
            : applyCommand(before, command, actor);
      f.history.record(actor, before, next, command);
      f.tables.save(next, command.id);
      return next;
    });
  return { ...f, inspect, review, prepare, run };
}

test("candidate preparation remaps every storage envelope and ownership, rotates source image capabilities, preserves private content and drops source retries without writes", () => {
  const f = setup();
  try {
    const archive = parseCampaignTransfer(f.snapshot()),
      doc = archive.records.module_documents[0]!,
      literal = `PRIVATE LITERAL ${f.player.member.id}`;
    doc.data_json = JSON.stringify({ name: "Synthetic", notes: literal });
    const file = JSON.stringify(archive),
      result = f.prepare(file);
    assert.deepEqual(result.report.blockers, []);
    assert.equal(result.report.status, "candidate-preflight-only");
    assert.equal(result.report.importReady, false);
    assert.equal(result.report.resourcePlan.complete, true);
    assert.deepEqual(result.report.pendingValidation, [
      "image-decoding",
      "atomic-import",
    ]);
    const prepared = result.prepared!;
    assert.ok(prepared);
    const { candidate, ids } = prepared,
      records = candidate.records,
      person = ids.get("member", f.player.member.id);
    assert.notEqual(candidate.campaign.id, archive.campaign.id);
    assert.notEqual(
      candidate.campaign.activeSceneId,
      archive.campaign.activeSceneId,
    );
    assert.equal(
      candidate.campaign.id,
      result.report.resourcePlan.targetCampaignId,
    );
    assert.notEqual(person, f.player.member.id);
    assert.equal(ids.get("member", f.gm.member.id), f.gm.member.id);
    assert.equal(prepared.newUsers.length, 1);
    assert.equal(candidate.members.length, 2);
    assert.equal(records.module_documents[0]!.owner_id, person);
    assert.equal(
      JSON.parse(records.module_documents[0]!.data_json).notes,
      literal,
    );
    assert.equal(
      records.content_instances[0]!.owner_id,
      ids.get("member", archive.records.content_instances[0]!.owner_id),
    );
    const state = JSON.parse(records.campaign_records[0]!.state_json);
    assert.equal(state.notes[0].ownerId, person);
    const oldRoll = archive.records.roll_archive[0]!,
      newRoll = records.roll_archive[0]!;
    assert.equal(newRoll.owner_id, person);
    assert.equal(JSON.parse(newRoll.roll_json).id, ids.get("roll", oldRoll.id));
    const chat = JSON.parse(records.chat_messages[0]!.message_json);
    assert.equal(chat.authorId, person);
    assert.equal(records.chat_messages[0]!.bucket, person);
    assert.equal(
      chat.authorName,
      JSON.parse(archive.records.chat_messages[0]!.message_json).authorName,
    );
    for (const row of records.scene_records) {
      assert.equal(JSON.parse(row.json).campaignId, candidate.campaign.id);
      for (const token of JSON.parse(row.state_json).tokens)
        assert.equal(token.ownerId, person);
    }
    const oldMap = archive.records.scene_backgrounds[0]!,
      map = records.scene_backgrounds[0]!;
    assert.notEqual(map.image_id, oldMap.image_id);
    assert.equal(JSON.parse(map.map_json).imageId, map.image_id);
    assert.equal(map.asset_id, ids.get("asset", oldMap.asset_id!));
    assert.equal(
      records.campaign_assets[0]!.bytes,
      archive.records.campaign_assets[0]!.bytes,
    );
    assert.equal(
      records.campaign_assets[0]!.sha256,
      archive.records.campaign_assets[0]!.sha256,
    );
    assert.equal(
      records.scene_background_history_refs[0]!.entry_id,
      records.scene_background_history[0]!.id,
    );
    assert.equal(records.scene_history_entries[0]!.actor_id, person);
    assert.equal(
      entryOf(records.scene_history_entries[0]).payload.kind,
      "create",
    );
    assert.equal(records.campaign_receipts.length, 0);
    assert.equal(records.command_bindings.length, 0);
    assert.equal(
      prepared.droppedRetries.receipts,
      archive.records.campaign_receipts.length,
    );
    assert.equal(
      prepared.droppedRetries.bindings,
      archive.records.command_bindings.length,
    );
    assert.deepEqual(candidate.packages, archive.packages);
    assert.deepEqual(candidate.storageVersions, archive.storageVersions);
    assert.equal(JSON.stringify(archive), file);
    assert.ok(!JSON.stringify(result.report).includes(literal));
    assert.equal(
      f.db
        .prepare("SELECT 1 FROM campaign_records WHERE id=?")
        .get(candidate.campaign.id),
      undefined,
    );
    const again = f.prepare(file);
    assert.notEqual(
      again.report.resourcePlan.targetCampaignId,
      result.report.resourcePlan.targetCampaignId,
    );
    assert.notEqual(
      again.report.resourcePlan.candidateSha256,
      result.report.resourcePlan.candidateSha256,
    );
    const unclaimed = reviewCampaignOwnership(
      f.inspect(file),
      {
        ...f.review(file).ownershipReview.plan,
        assignments: f
          .review(file)
          .ownershipReview.plan.assignments.map((a) => ({
            sourceId: a.sourceId,
            target: { kind: "unclaimed" },
          })),
      },
      f.db,
      f.gm.member.id,
    );
    const detached = prepareCampaignCandidate(
      file,
      unclaimed,
      { systems: installedModules, contentPacks: f.catalog.metadata() },
      f.catalog,
      documentSystems,
      f.db,
    ).prepared!;
    assert.ok(detached);
    assert.equal(detached.newUsers.length, 0);
    assert.equal(detached.memberships.length, 1);
    assert.notEqual(detached.ids.get("member", f.gm.member.id), f.gm.member.id);
    assert.ok(
      !detached.memberships.some(
        (member) =>
          member.id === detached.ids.get("member", f.player.member.id),
      ),
    );
  } finally {
    f.db.close();
  }
});

test("declared document, override, instance and saved-source references are rewritten by kind; arbitrary UUID text and content pins remain unchanged", () => {
  const f = setup();
  try {
    const archive = parseCampaignTransfer(f.snapshot()),
      scene = archive.records.scene_records.find(
        (r) => JSON.parse(r.state_json).tokens.length,
      )!,
      token = JSON.parse(scene.state_json).tokens[0].id as string,
      note = JSON.parse(archive.records.campaign_records[0]!.state_json)
        .notes[0].id as string,
      kinds = [
        "campaign",
        "scene",
        "token",
        "note",
        "document",
        "instance",
        "asset",
        "roll",
        "member",
      ] as const,
      values = {
        campaign: archive.campaign.id,
        scene: scene.id,
        token,
        note,
        document: archive.records.module_documents[0]!.id,
        instance: archive.records.content_instances[0]!.id,
        asset: archive.records.campaign_assets[0]!.id,
        roll: archive.records.roll_archive[0]!.id,
        member: f.player.member.id,
      },
      dataSchema = z
        .object({
          ...Object.fromEntries(kinds.map((kind) => [kind, z.uuid()])),
          literal: z.string(),
        })
        .strict(),
      system = {
        ...documentSystems[0]!,
        documentSchema: dataSchema,
        documentTransfer: defineCampaignDataTransfer(dataSchema, () =>
          kinds.map((kind) => ({ kind, path: [kind] })),
        ),
      },
      pack = {
        ...f.pack,
        transfer: defineCampaignDataTransfer(fixtureData, (data) =>
          data.tags.includes("linked-token")
            ? [{ kind: "token", path: ["label"] }]
            : data.tags.includes("linked-note")
              ? [{ kind: "note", path: ["label"] }]
              : [],
        ),
        instances: {
          ...f.pack.instances!,
          transfer: defineCampaignDataTransfer(instanceData, (data) =>
            data.marked ? [{ kind: "asset", path: ["label"] }] : [],
          ),
        },
      },
      content = new ContentCatalog([pack]);
    archive.records.module_documents[0]!.data_json = JSON.stringify({
      ...values,
      literal: f.player.member.id,
    });
    const override = archive.records.content_overrides[0]!,
      data = JSON.parse(override.data_json!);
    data.data = { label: token, tags: ["linked-token"] };
    override.data_json = JSON.stringify(data);
    const instance = archive.records.content_instances[0]!,
      snapshot = JSON.parse(instance.source_json);
    instance.data_json = JSON.stringify({ label: values.asset, marked: true });
    snapshot.data = { label: note, tags: ["linked-note"] };
    instance.source_json = JSON.stringify(snapshot);
    const prepared = f.prepare(JSON.stringify(archive), false, content, [
      system,
    ]).prepared!;
    assert.ok(prepared);
    const mapped = JSON.parse(
      prepared.candidate.records.module_documents[0]!.data_json,
    );
    for (const kind of kinds)
      assert.equal(
        mapped[kind],
        prepared.ids.get(
          kind === "token" || kind === "note" ? "object" : kind,
          values[kind],
        ),
      );
    assert.equal(mapped.literal, f.player.member.id);
    assert.equal(
      JSON.parse(prepared.candidate.records.content_overrides[0]!.data_json!)
        .data.label,
      prepared.ids.get("object", token),
    );
    assert.equal(
      JSON.parse(prepared.candidate.records.content_instances[0]!.data_json)
        .label,
      prepared.ids.get("asset", values.asset),
    );
    assert.equal(
      JSON.parse(prepared.candidate.records.content_instances[0]!.source_json)
        .data.label,
      prepared.ids.get("object", note),
    );
    assert.deepEqual(prepared.candidate.packages, archive.packages);
  } finally {
    f.db.close();
  }
});

test("retained and expired object-history links are remapped without binding destination history or changing versions", () => {
  const f = setup(false);
  try {
    const id = randomUUID();
    f.run({
      type: "token.add",
      token: { id, name: "Scout", color: "#405f4d", position: { x: 0, y: 0 } },
    });
    for (let x = 1; x <= 105; x++)
      f.run({
        type: "token.move",
        tokenId: id,
        position: { x, y: 0 },
        expectedVersion: x,
      });
    const source = parseCampaignTransfer(f.snapshot()),
      result = f.prepare(),
      prepared = result.prepared!;
    assert.ok(prepared);
    assert.deepEqual(result.report.candidateValidation.objectHistory, {
      entries: 100,
      retainedLinks: 99,
      expiredLinks: 1,
    });
    const first = entryOf(source.records.scene_history_entries[0]),
      mapped = entryOf(prepared.candidate.records.scene_history_entries[0]);
    assert.notEqual(
      mapped.targets[0]!.previousId,
      first.targets[0]!.previousId,
    );
    assert.equal(
      mapped.targets[0]!.previousId,
      prepared.ids.get("history", first.targets[0]!.previousId!),
    );
    assert.equal(
      mapped.targets[0]!.expectedVersion,
      first.targets[0]!.expectedVersion,
    );
    assert.equal(mapped.version, first.version);
    assert.equal(
      JSON.parse(prepared.candidate.records.scene_records[0]!.state_json)
        .tokens[0].version,
      106,
    );
  } finally {
    f.db.close();
  }
});

test("scene-scoped map history IDs and reused source image capabilities become independent fresh destination keys", () => {
  const f = setup();
  try {
    const source = parseCampaignTransfer(f.snapshot()),
      original = source.records.scene_backgrounds[0]!,
      second = source.records.scene_records.find(
        (row) => row.id !== original.scene_id,
      )!.id;
    source.records.scene_backgrounds.push({ ...original, scene_id: second });
    source.records.scene_background_history.push(
      ...source.records.scene_background_history.map((row) => ({
        ...row,
        scene_id: second,
      })),
    );
    source.records.scene_background_history_refs.push(
      ...source.records.scene_background_history_refs.map((row) => ({
        ...row,
        scene_id: second,
      })),
    );
    const prepared = f.prepare(JSON.stringify(source)).prepared!;
    assert.ok(prepared);
    const maps = prepared.candidate.records.scene_backgrounds,
      history = prepared.candidate.records.scene_background_history;
    assert.equal(maps.length, 2);
    assert.notEqual(maps[0]!.image_id, maps[1]!.image_id);
    assert.notEqual(history[0]!.id, history[1]!.id);
    for (const row of history)
      assert.equal(
        JSON.parse(row.entry_json).after.imageId,
        maps.find((m) => m.scene_id === row.scene_id)!.image_id,
      );
  } finally {
    f.db.close();
  }
});

test("acknowledged merges still fail mapped quota/history checks without pruning private chat or undo stacks", () => {
  const f = setup();
  try {
    const source = parseCampaignTransfer(f.snapshot()),
      template = source.records.chat_messages[0]!;
    source.records.chat_messages = [f.gm.member, f.player.member].flatMap(
      (member, bucket) =>
        Array.from({ length: 100 }, (_, index) => {
          const id = randomUUID(),
            message = {
              ...JSON.parse(template.message_json),
              id,
              authorId: member.id,
              authorName: member.name,
            };
          return {
            ...template,
            id,
            sequence: bucket * 100 + index + 1,
            bucket: member.id,
            message_json: JSON.stringify(message),
          };
        }),
    );
    const blocked = f.prepare(JSON.stringify(source), true);
    assert.equal(blocked.prepared, undefined);
    assert.ok(
      blocked.report.blockers.includes("mapped_storage_limits_exceeded"),
    );
    assert.equal(blocked.report.candidateValidation.failedStage, "storage");
    assert.ok(
      blocked.report.pendingValidation.includes("mapped-storage-quotas"),
    );
  } finally {
    f.db.close();
  }
  const g = setup(false);
  try {
    const a = randomUUID(),
      b = randomUUID();
    const add = (id: string) =>
      ({
        type: "token.add",
        token: {
          id,
          name: "Scout",
          color: "#405f4d",
          position: { x: 0, y: 0 },
        },
      }) as const;
    g.run(add(a), g.gm.member);
    g.run(add(b));
    const edge = g.history.status(g.gm.member).undo!;
    g.run(
      { type: "scene.undo", historyId: edge.id, expectedVersion: edge.version },
      g.gm.member,
    );
    const blocked = g.prepare(g.snapshot(), true);
    assert.equal(blocked.prepared, undefined);
    assert.ok(blocked.report.blockers.includes("mapped_campaign_invalid"));
    assert.equal(blocked.report.candidateValidation.failedStage, "relations");
    assert.ok(
      blocked.report.pendingValidation.includes("mapped-history-graph"),
    );
  } finally {
    g.db.close();
  }
});

test("fresh-ID allocation is bounded and destination global collisions fail closed without partial candidates or lingering transactions", () => {
  const f = setup();
  try {
    const source = parseCampaignTransfer(f.snapshot()),
      foreign = f.db
        .prepare("SELECT id FROM module_documents WHERE campaign_id<>? LIMIT 1")
        .get(source.campaign.id)!.id as string;
    let calls = 0;
    const collision = f.prepare(
      f.snapshot(),
      false,
      f.catalog,
      documentSystems,
      () => (++calls === 1 ? foreign : randomUUID()),
    );
    assert.equal(collision.prepared, undefined);
    assert.ok(collision.report.blockers.includes("candidate_mapping_failed"));
    calls = 0;
    const repeated = f.prepare(
      f.snapshot(),
      false,
      f.catalog,
      documentSystems,
      () => {
        calls++;
        return source.campaign.id;
      },
    );
    assert.equal(repeated.prepared, undefined);
    assert.equal(calls, 10);
    assert.ok(repeated.report.blockers.includes("candidate_mapping_failed"));
    const file = f.snapshot(),
      reviewed = f.review(file);
    f.db.exec("BEGIN");
    assert.throws(
      () =>
        prepareCampaignCandidate(
          file,
          reviewed,
          { systems: installedModules, contentPacks: f.catalog.metadata() },
          f.catalog,
          documentSystems,
          f.db,
        ),
      /independent read snapshots/,
    );
    assert.equal(f.db.isTransaction, true);
    f.db.exec("ROLLBACK");
  } finally {
    f.db.close();
  }
});

test("SDK rewriting supports scalar roots and literal own prototype keys, validates replacements and rejects changing declarations", () => {
  const a = randomUUID(),
    b = randomUUID(),
    policy = defineCampaignDataTransfer(z.unknown(), () => [
      { kind: "member", path: [] },
    ]);
  assert.equal(
    remapCampaignDataReferences(policy, a, () => b),
    b,
  );
  assert.throws(() =>
    remapCampaignDataReferences(policy, a, () => "not a UUID"),
  );
  const source = JSON.parse(`{"__proto__":"${a}","literal":"${a}"}`),
    own = defineCampaignDataTransfer(z.unknown(), () => [
      { kind: "member", path: ["__proto__"] },
    ]);
  const mapped = remapCampaignDataReferences(own, source, () => b) as Record<
    string,
    unknown
  >;
  assert.equal(mapped.__proto__, b);
  assert.equal(mapped.literal, a);
  assert.equal(Object.getPrototypeOf(mapped), Object.prototype);
  assert.equal(source.__proto__, a);
  const unstable = defineCampaignDataTransfer(z.string(), (value) =>
    value === a ? [{ kind: "member", path: [] }] : [],
  );
  assert.throws(
    () => remapCampaignDataReferences(unstable, a, () => b),
    /declarations changed/,
  );
});
