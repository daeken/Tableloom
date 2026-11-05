import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { commandSchema } from "@tableloom/core";
import { applyCommand } from "@tableloom/core/server";
import {
  defineCampaignDataTransfer,
  defineServerSystem,
  inspectCampaignDataReferences,
  type CampaignDataReference,
  type CampaignDataTransfer,
  type ServerSystemDefinition,
} from "@tableloom/module-sdk/server";
import { fixture, populate, key } from "./campaign-transfer-fixture.js";
import { documentSystems } from "./document-modules.js";
import { installedModules } from "./modules.js";
import { parseCampaignTransfer } from "./campaign-transfer-format.js";
import { inspectCampaignTransfer } from "./campaign-preflight.js";
import { ContentCatalog } from "./content-catalog.js";
import { fixtureData } from "./content-fixture.js";
import { instanceData } from "./instances-fixture.js";
import { campaignModuleReferences } from "./campaign-module-references.js";
import { StoreError } from "./store.js";
import { createApp } from "./app.js";
import { transaction } from "./database.js";

const referenceData = z
  .object({
    secret: z.string(),
    references: z.array(
      z
        .object({
          kind: z.enum([
            "campaign",
            "scene",
            "token",
            "drawing",
            "note",
            "document",
            "instance",
            "asset",
            "roll",
            "member",
            "content",
          ]),
          value: z.unknown(),
        })
        .strict(),
    ),
  })
  .strict();
const transfer = defineCampaignDataTransfer(referenceData, (data) =>
  data.references.map((reference, index) => ({
    kind: reference.kind,
    path: ["references", index, "value"],
  })),
);
const system = {
  ...documentSystems[0]!,
  documentSchema: referenceData,
  documentTransfer: transfer,
  createDocument: () => ({ secret: "", references: [] }),
};
function populated() {
  const f = fixture(),
    drawing = randomUUID(),
    before = f.tables.load(),
    command = commandSchema.parse({
      id: randomUUID(),
      type: "drawing.add",
      drawing: {
        id: drawing,
        kind: "rectangle",
        color: "#405f4d",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      },
    });
  const next = applyCommand(before, command, f.gm.member);
  transaction(f.db, () => {
    f.history.record(f.gm.member, before, next, command);
    f.tables.save(next, command.id);
  });
  populate(f);
  const archive = parseCampaignTransfer(f.snapshot()),
    retired = randomUUID(),
    scene = archive.records.scene_records.find(
      (row) => JSON.parse(row.state_json).tokens.length,
    )!;
  const data = referenceData.parse({
    secret: "PRIVATE MODULE CANARY",
    references: [
      { kind: "campaign", value: archive.campaign.id },
      { kind: "scene", value: scene.id },
      { kind: "token", value: JSON.parse(scene.state_json).tokens[0].id },
      { kind: "drawing", value: drawing },
      {
        kind: "note",
        value: JSON.parse(archive.records.campaign_records[0]!.state_json)
          .notes[0].id,
      },
      { kind: "document", value: archive.records.module_documents[0]!.id },
      { kind: "instance", value: archive.records.content_instances[0]!.id },
      { kind: "asset", value: archive.records.campaign_assets[0]!.id },
      { kind: "roll", value: archive.records.roll_archive[0]!.id },
      { kind: "member", value: retired },
      {
        kind: "content",
        value: {
          packId: f.pack.id,
          packVersion: f.pack.version,
          definitionId: "a-public",
        },
      },
    ],
  });
  archive.records.module_documents[0]!.data_json = JSON.stringify(data);
  const inspect = (
    catalog = f.catalog,
    systems: readonly ServerSystemDefinition<unknown>[] = [system],
  ) =>
    inspectCampaignTransfer(
      JSON.stringify(archive),
      { systems: installedModules, contentPacks: catalog.metadata() },
      catalog,
      systems,
      f.db,
    );
  return { ...f, archive, retired, data, inspect };
}

test("module preflight validates all neutral reference kinds, inventories departed embedded members and reveals only summary counts without writes", () => {
  const f = populated();
  try {
    const before = f.db.prepare("SELECT total_changes() AS n").get()!.n,
      serialized = JSON.stringify(f.archive),
      report = f.inspect();
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.moduleReferenceValidation, {
      records: 4,
      references: 11,
      complete: true,
    });
    assert.ok(!report.pendingValidation.includes("module-external-references"));
    assert.ok(report.pendingValidation.includes("mapped-module-references"));
    assert.equal(report.importReady, false);
    assert.deepEqual(
      report.ownership.subjects.find((s) => s.sourceId === f.retired),
      { sourceId: f.retired, name: null, sourceRole: null },
    );
    assert.ok(!JSON.stringify(report).includes("PRIVATE MODULE CANARY"));
    assert.ok(!JSON.stringify(report).includes('"path"'));
    assert.equal(JSON.stringify(f.archive), serialized);
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, before);
    assert.equal(f.db.isTransaction, false);
  } finally {
    f.db.close();
  }
});

test("module references cannot resolve against destination-only IDs, deleted reservations, wrong resource kinds or unavailable content definitions", () => {
  const f = populated();
  try {
    const source = f.archive.records.module_documents[0]!;
    for (const kind of [
      "campaign",
      "scene",
      "token",
      "drawing",
      "note",
      "document",
      "instance",
      "asset",
      "roll",
    ] as const) {
      source.data_json = JSON.stringify({
        secret: "PRIVATE",
        references: [{ kind, value: randomUUID() }],
      });
      assert.throws(
        () => f.inspect(),
        (error: unknown) =>
          error instanceof StoreError && error.statusCode === 400,
      );
    }
    // The destination still has this document, but it is absent from the source archive.
    const destinationId = f.archive.records.module_documents[0]!.id;
    const second = {
      ...source,
      id: randomUUID(),
      data_json: JSON.stringify({
        secret: "PRIVATE",
        references: [{ kind: "document", value: destinationId }],
      }),
    };
    f.archive.records.module_documents = [second];
    assert.throws(() => f.inspect(), StoreError);
    f.archive.records.module_documents = [source];
    const expired = randomUUID();
    f.archive.records.object_id_reservations.push({
      campaign_id: f.archive.campaign.id,
      id: expired,
    });
    source.data_json = JSON.stringify({
      secret: "PRIVATE",
      references: [{ kind: "token", value: expired }],
    });
    assert.throws(() => f.inspect(), StoreError);
    source.data_json = JSON.stringify({
      secret: "PRIVATE",
      references: [
        { kind: "token", value: f.archive.records.campaign_assets[0]!.id },
      ],
    });
    assert.throws(() => f.inspect(), StoreError);
    source.data_json = JSON.stringify({
      secret: "PRIVATE",
      references: [
        {
          kind: "content",
          value: {
            packId: f.pack.id,
            packVersion: f.pack.version,
            definitionId: "missing",
          },
        },
      ],
    });
    const report = f.inspect();
    assert.ok(report.blockers.includes("content_definition_unavailable"));
    assert.ok(report.blockers.includes("module_transfer_unavailable"));
    assert.equal(report.moduleReferenceValidation.complete, false);
  } finally {
    f.db.close();
  }
});

test("definition overrides, saved definition snapshots and owned instance state each use their declared transfer policy", () => {
  const f = populated();
  try {
    const a = randomUUID(),
      b = randomUUID(),
      pack = {
        ...f.pack,
        transfer: defineCampaignDataTransfer(fixtureData, (data) =>
          data.tags.includes("linked")
            ? [{ kind: "member", path: ["label"] }]
            : [],
        ),
        instances: {
          ...f.pack.instances!,
          transfer: defineCampaignDataTransfer(instanceData, () => [
            { kind: "asset", path: ["label"] },
          ]),
        },
      },
      catalog = new ContentCatalog([pack]),
      override = f.archive.records.content_overrides[0]!,
      saved = JSON.parse(override.data_json!),
      instance = f.archive.records.content_instances[0]!,
      snapshot = JSON.parse(instance.source_json);
    saved.data.tags = ["linked"];
    saved.data.label = a;
    override.data_json = JSON.stringify(saved);
    snapshot.data.tags = ["linked"];
    snapshot.data.label = b;
    instance.source_json = JSON.stringify(snapshot);
    instance.data_json = JSON.stringify({
      label: f.archive.records.campaign_assets[0]!.id,
      marked: false,
    });
    assert.equal(catalog.packs[0]!.digest, f.catalog.packs[0]!.digest);
    const report = f.inspect(catalog);
    assert.deepEqual(report.moduleReferenceValidation, {
      records: 4,
      references: 14,
      complete: true,
    });
    assert.deepEqual(report.blockers, []);
    for (const id of [a, b])
      assert.ok(
        report.ownership.subjects.some(
          (s) => s.sourceId === id && s.name === null,
        ),
      );
    instance.data_json = JSON.stringify({ label: randomUUID(), marked: false });
    assert.throws(() => f.inspect(catalog), StoreError);
  } finally {
    f.db.close();
  }
});

test("legacy modules without explicit transfer support remain blocked, while UUID-looking text is not guessed as a reference", () => {
  const f = populated();
  try {
    const { documentTransfer: _policy, ...legacy } = system;
    const unsupported = f.inspect(f.catalog, [legacy]);
    assert.ok(unsupported.blockers.includes("module_transfer_unavailable"));
    assert.ok(
      unsupported.pendingValidation.includes("module-external-references"),
    );
    f.archive.records.module_documents[0]!.data_json = JSON.stringify({
      name: randomUUID(),
      notes: randomUUID(),
    });
    assert.deepEqual(f.inspect(f.catalog, [documentSystems[0]!]).blockers, []);
    const { transfer: _definition, ...pack } = f.pack;
    const { transfer: _instance, ...instances } = pack.instances!;
    const report = f.inspect(new ContentCatalog([{ ...pack, instances }]), [
      documentSystems[0]!,
    ]);
    assert.equal(report.moduleReferenceValidation.complete, false);
    assert.ok(report.blockers.includes("module_transfer_unavailable"));
  } finally {
    f.db.close();
  }
});

test("reference enumeration is detached, strict and bounded, permits root/array/own-property paths and rejects prototype or duplicate paths", () => {
  const id = randomUUID(),
    raw = { values: [id] },
    policy: CampaignDataTransfer = {
      inspect(data) {
        (data as typeof raw).values[0] = randomUUID();
        return [{ kind: "token", path: ["values", 0] }];
      },
    };
  assert.equal(inspectCampaignDataReferences(policy, raw)[0]!.value, id);
  assert.equal(raw.values[0], id);
  assert.equal(
    inspectCampaignDataReferences(
      { inspect: () => [{ kind: "member", path: [] }] },
      id,
    )[0]!.value,
    id,
  );
  const own = JSON.parse(`{"__proto__":"${id}"}`);
  assert.equal(
    inspectCampaignDataReferences(
      { inspect: () => [{ kind: "token", path: ["__proto__"] }] },
      own,
    )[0]!.value,
    id,
  );
  for (const refs of [
    [{ kind: "token", path: ["constructor"] }],
    [{ kind: "token", path: ["values", "0"] }],
    [{ kind: "token", path: ["missing"] }],
    [
      { kind: "token", path: ["values", 0] },
      { kind: "member", path: ["values", 0] },
    ],
    [{ kind: "token", path: ["values", 0], code: "ignored?" }],
    [{ kind: "token", path: Array(21).fill("x") }],
    Array.from({ length: 1001 }, (_, i) => ({ kind: "token", path: [i] })),
  ])
    assert.throws(() =>
      inspectCampaignDataReferences(
        { inspect: () => refs as CampaignDataReference[] },
        raw,
      ),
    );
  assert.throws(() =>
    inspectCampaignDataReferences(
      { inspect: () => [{ kind: "token", path: [] }] },
      "not-a-uuid",
    ),
  );
  const data = Array(1000).fill(id),
    many = defineCampaignDataTransfer(z.array(z.string()), (values) =>
      values.map((_, i) => ({ kind: "token", path: [i] })),
    ),
    inspector = campaignModuleReferences(
      new Map([["token", new Set([id])]]),
      () => {},
      () => true,
    );
  for (let i = 0; i < 100; i++) inspector.inspect(many, data);
  assert.equal(inspector.summary().references, 100000);
  assert.throws(() => inspector.inspect(many, data), StoreError);
  const composite = {
    packId: "deadbeef-0000-4000-8000-000000000001",
    packVersion: "1.0.0",
    definitionId: "label",
  };
  const overlapping: CampaignDataReference[] = [
    { kind: "content", path: [] },
    { kind: "member", path: ["packId"] },
  ];
  for (const refs of [overlapping, [...overlapping].reverse()])
    assert.throws(() =>
      inspectCampaignDataReferences({ inspect: () => refs }, composite),
    );
});

test("trusted registrations reject malformed transfer executors", () => {
  const f = fixture(),
    bad = {} as CampaignDataTransfer;
  try {
    assert.throws(() =>
      defineServerSystem({ ...documentSystems[0]!, documentTransfer: bad }),
    );
    assert.throws(() => new ContentCatalog([{ ...f.pack, transfer: bad }]));
    assert.throws(
      () =>
        new ContentCatalog([
          { ...f.pack, instances: { ...f.pack.instances!, transfer: bad } },
        ]),
    );
  } finally {
    f.db.close();
  }
});

test("HTTP preflight keeps module callback failures private and returns source-reference summaries without importing", async () => {
  const f = populated(),
    app = await createApp({
      databasePath: ":memory:",
      hostKey: key,
      documentSystems: [system],
      contentPacks: [f.pack],
    });
  const post = (url: string, payload: unknown, cookie = "") =>
    app.inject({
      method: "POST",
      url,
      headers: {
        origin: "http://localhost",
        cookie,
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
  try {
    const setup = await post("/api/access/setup", { key, name: "Host" }),
      cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
    const accepted = await post(
      "/api/campaign-imports/preflight",
      f.archive,
      cookie,
    );
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(accepted.json().moduleReferenceValidation, {
      records: 4,
      references: 11,
      complete: true,
    });
    assert.equal(accepted.json().importReady, false);
    assert.ok(!accepted.body.includes("PRIVATE MODULE CANARY"));
    // Only the installed trusted registration can choose callbacks, never the uploaded file.
    const previous = system.documentTransfer;
    system.documentTransfer = {
      inspect: () => {
        throw new Error("PRIVATE CALLBACK CANARY");
      },
    };
    try {
      const rejected = await post(
        "/api/campaign-imports/preflight",
        f.archive,
        cookie,
      );
      assert.equal(rejected.statusCode, 400);
      assert.ok(!rejected.body.includes("PRIVATE CALLBACK CANARY"));
      assert.ok(!rejected.body.includes("PRIVATE MODULE CANARY"));
    } finally {
      system.documentTransfer = previous;
    }
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/campaigns",
          headers: { cookie },
        })
      ).json().length,
      1,
    );
  } finally {
    await app.close();
    f.db.close();
  }
});
