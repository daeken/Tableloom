import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ContentCatalog, withContentMetadata } from "./content-catalog.js";
import { CampaignContentStore } from "./content.js";
import { ContentInstanceStore } from "./instances.js";
import { instancePack } from "./instances-fixture.js";
import { fixturePack } from "./content-fixture.js";
import { TableStore, StoreError } from "./store.js";
import { AccessStore } from "./access.js";
import { installedModules } from "./modules.js";
import { defineContentInstances } from "@tableloom/module-sdk/server";
import type { ContentPackDefinition } from "@tableloom/module-sdk/content";
import { MAX_CAMPAIGN_INSTANCES } from "@tableloom/core/instances";
const key = "instance-test-fixture-not-a-real-key";
const ref = (definitionId = "a-public") => ({
  packId: "fixture-paper",
  packVersion: "1.0.0",
  definitionId,
});
const create = (definitionId = "a-public", expectedRevision = 0) => ({
  reference: ref(definitionId),
  expectedRevision,
});
const edit = (expectedVersion = 1, visibility: "gm" | "public" = "gm") => ({
  expectedVersion,
  name: "My page",
  visibility,
  data: { label: "Written", marked: true },
});
const status = (code: number) => (error: unknown) =>
  error instanceof StoreError && error.statusCode === code;
function fixture(pack: ContentPackDefinition<unknown> = instancePack()) {
  const db = new DatabaseSync(":memory:"),
    catalog = new ContentCatalog([pack]),
    campaigns = new TableStore(
      db,
      withContentMetadata(
        { systems: installedModules, contentPacks: [] },
        catalog,
      ),
    ),
    access = new AccessStore(db, key),
    gm = access.setupHost(key, "GM"),
    alice = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Alice",
    ),
    bob = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Bob",
    );
  const campaign = campaigns.getCampaign();
  campaigns.updateCampaign(campaign.id, campaign.version, {
    name: campaign.name,
    description: "",
    system: campaign.system,
    contentPacks: [{ id: pack.id, version: pack.version }],
  });
  const content = new CampaignContentStore(db, campaigns, catalog),
    instances = new ContentInstanceStore(db, campaigns, catalog, content);
  return { db, catalog, campaigns, access, gm, alice, bob, content, instances };
}
test("instances capture resolved definitions once, use typed factories, and evolve independently through homebrew/reset", () => {
  const f = fixture();
  try {
    const before = f.campaigns.load(),
      campaign = f.campaigns.getCampaign();
    const first = f.instances.create(f.alice.member, create());
    assert.equal(first.ownerId, f.alice.member.id);
    assert.equal(first.visibility, "gm");
    assert.equal(first.version, 1);
    assert.deepEqual(first.data, { label: "Unmarked", marked: false });
    assert.deepEqual(first.source.data, { label: "Unmarked", tags: [] });
    f.content.override(f.gm.member, ref(), {
      expectedRevision: 0,
      name: "Homebrew page",
      visibility: "public",
      data: { label: "Homebrew", tags: ["changed"] },
      sources: [],
    });
    assert.throws(
      () => f.instances.create(f.alice.member, create()),
      status(409),
    );
    const second = f.instances.create(f.alice.member, create("a-public", 1));
    assert.equal(second.definitionRevision, 1);
    assert.deepEqual(second.data, { label: "Homebrew", marked: false });
    assert.equal(second.source.name, "Homebrew page");
    f.content.reset(f.gm.member, ref(), { expectedRevision: 1 });
    assert.deepEqual(f.instances.get(f.alice.member, first.id), first);
    assert.deepEqual(f.instances.get(f.alice.member, second.id), second);
    const changed = f.instances.update(f.alice.member, first.id, edit());
    assert.equal(changed.version, 2);
    assert.deepEqual(changed.source, first.source);
    assert.throws(
      () => f.instances.update(f.alice.member, first.id, edit()),
      status(409),
    );
    assert.throws(
      () => f.instances.delete(f.gm.member, first.id, 1),
      status(409),
    );
    changed.source.sources[0]!.title = "Mutated response";
    assert.deepEqual(
      f.instances.get(f.gm.member, first.id).source,
      first.source,
    );
    assert.deepEqual(f.campaigns.load(), before);
    assert.deepEqual(f.campaigns.getCampaign(), campaign);
    f.instances.delete(f.alice.member, first.id, 2);
    assert.throws(() => f.instances.get(f.gm.member, first.id), status(404));
  } finally {
    f.db.close();
  }
});
test("instance permissions filter SQL payloads and pagination, ignore forged roles and revoke removed members", () => {
  const f = fixture();
  try {
    const a = f.instances.create(f.alice.member, create()),
      b = f.instances.create(f.bob.member, create()),
      hidden = f.instances.create(f.gm.member, create("b-hidden"));
    assert.throws(
      () => f.instances.create(f.alice.member, create("b-hidden")),
      status(404),
    );
    assert.throws(
      () =>
        f.instances.create(
          { ...f.alice.member, role: "gm" },
          create("b-hidden"),
        ),
      status(404),
    );
    f.db
      .prepare(
        "UPDATE content_instances SET data_json='broken',source_json='private broken' WHERE id=?",
      )
      .run(hidden.id);
    assert.throws(
      () => f.instances.get(f.alice.member, hidden.id),
      status(404),
    );
    assert.throws(
      () => f.instances.get({ ...f.alice.member, role: "gm" }, hidden.id),
      status(404),
    );
    assert.equal(f.instances.list(f.alice.member).instances.length, 1);
    assert.throws(
      () => f.instances.update(f.bob.member, a.id, edit()),
      status(404),
    );
    f.instances.update(f.alice.member, a.id, edit(1, "public"));
    assert.equal(f.instances.get(f.bob.member, a.id).version, 2);
    assert.throws(
      () => f.instances.update(f.bob.member, a.id, edit(2)),
      status(403),
    );
    assert.throws(() => f.instances.delete(f.bob.member, a.id, 2), status(403));
    const page = f.instances.list(f.bob.member, { limit: 1 }),
      next = f.instances.list(f.bob.member, { after: page.next!, limit: 1 });
    assert.deepEqual(
      new Set([page.instances[0]!.id, next.instances[0]!.id]),
      new Set([a.id, b.id]),
    );
    assert.equal(next.next, null);
    assert.ok(!JSON.stringify(page).includes("source"));
    f.instances.update(f.gm.member, a.id, edit(2, "gm"));
    assert.throws(() => f.instances.get(f.bob.member, a.id), status(404));
    f.access.removeMember(f.gm.token, f.alice.member.id);
    assert.throws(() => f.instances.list(f.alice.member), status(403));
    assert.throws(
      () => f.instances.update(f.alice.member, a.id, edit(3)),
      status(403),
    );
    assert.equal(f.instances.get(f.gm.member, a.id).ownerId, f.alice.member.id);
    // Recovery deletion does not need corrupt bodies or a working factory.
    f.instances.delete(f.gm.member, hidden.id, 1);
  } finally {
    f.db.close();
  }
});
test("owned instances guard exact campaign/package pins on settings and live system changes until removed", () => {
  const f = fixture();
  try {
    const a = f.instances.create(f.alice.member, create()),
      campaign = f.campaigns.getCampaign();
    const settings = {
      name: campaign.name,
      description: "",
      system: campaign.system,
      contentPacks: [],
    };
    assert.throws(
      () => f.campaigns.updateCampaign(campaign.id, campaign.version, settings),
      status(409),
    );
    const current = f.campaigns.load();
    assert.throws(
      () =>
        f.campaigns.save(
          {
            ...current,
            revision: current.revision + 1,
            systemId: "kids-on-bikes",
          },
          randomUUID(),
        ),
      status(409),
    );
    assert.deepEqual(f.campaigns.load(), current);
    f.instances.delete(f.gm.member, a.id, 1);
    f.campaigns.updateCampaign(campaign.id, campaign.version, settings);
    assert.throws(
      () => f.instances.create(f.alice.member, create()),
      status(404),
    );
  } finally {
    f.db.close();
  }
});
test("instance factories validate outputs, isolate mutations/failures, and reject oversized or forged state without writes", () => {
  for (const bad of [
    () => {
      throw new Error("PRIVATE-HANDLER-DETAIL");
    },
    () => ({ label: 4, marked: false }),
    () => ({ label: "x".repeat(70000), marked: false }),
    () => Promise.resolve({ label: "async", marked: false }),
  ]) {
    const pack = instancePack();
    pack.instances.create = bad;
    const f = fixture(pack);
    try {
      assert.throws(
        () => f.instances.create(f.alice.member, create()),
        (e: unknown) =>
          status(400)(e) && !String(e).includes("PRIVATE-HANDLER-DETAIL"),
      );
      assert.equal(f.instances.list(f.gm.member).instances.length, 0);
    } finally {
      f.db.close();
    }
  }
  const pack = instancePack();
  pack.instances.create = (data) => {
    (data as { label: string }).label = "Local mutation";
    return { label: "Created", marked: false };
  };
  const f = fixture(pack);
  try {
    const a = f.instances.create(f.alice.member, create());
    assert.deepEqual(a.source.data, { label: "Unmarked", tags: [] });
    for (const bad of [
      { ...edit(), ownerId: f.bob.member.id },
      { ...edit(), source: a.source },
      { ...edit(), data: { label: "Bad", marked: 4 } },
      { ...edit(), data: { label: "x".repeat(70000), marked: true } },
    ])
      assert.throws(() => f.instances.update(f.alice.member, a.id, bad));
    assert.deepEqual(f.instances.get(f.alice.member, a.id), a);
    f.db
      .prepare(
        `CREATE TRIGGER reject_instance_update BEFORE UPDATE ON content_instances BEGIN SELECT RAISE(ABORT,'test'); END`,
      )
      .run();
    assert.throws(() => f.instances.update(f.alice.member, a.id, edit()));
    assert.deepEqual(f.instances.get(f.alice.member, a.id), a);
    const noFactory = new ContentCatalog([fixturePack()]),
      other = new ContentInstanceStore(f.db, f.campaigns, noFactory, f.content);
    assert.throws(() => other.create(f.alice.member, create()), status(400));
    assert.throws(() => other.get(f.alice.member, a.id), status(409));
    assert.throws(() =>
      defineContentInstances(z.string(), {
        schemaVersion: 0,
        dataSchema: z.string(),
        create: (s) => s,
      }),
    );
    assert.notEqual(
      new ContentCatalog([instancePack()]).packs[0]!.digest,
      new ContentCatalog([fixturePack()]).packs[0]!.digest,
    );
  } finally {
    f.db.close();
  }
});
test("instance storage validates markers, enforces campaign quota and fails closed on persisted schema/data corruption", () => {
  const f = fixture();
  try {
    const a = f.instances.create(f.alice.member, create());
    f.db
      .prepare("UPDATE content_instances SET schema_version=2 WHERE id=?")
      .run(a.id);
    assert.throws(() => f.instances.get(f.alice.member, a.id), status(409));
    assert.throws(
      () => f.instances.update(f.alice.member, a.id, edit()),
      status(409),
    );
    f.db
      .prepare(
        "UPDATE content_instances SET schema_version=1,data_json='{}' WHERE id=?",
      )
      .run(a.id);
    assert.throws(() => f.instances.get(f.alice.member, a.id));
    assert.throws(() => f.instances.update(f.alice.member, a.id, edit()));
    f.db
      .prepare("UPDATE content_instances SET data_json=? WHERE id=?")
      .run(JSON.stringify(a.data), a.id);
    const clone = f.db.prepare(
      `INSERT INTO content_instances SELECT ?,campaign_id,owner_id,name,kind,visibility,system_id,system_version,pack_id,pack_version,definition_id,definition_revision,schema_version,version,source_json,data_json FROM content_instances WHERE id=?`,
    );
    for (let i = 1; i < MAX_CAMPAIGN_INSTANCES; i++)
      clone.run(randomUUID(), a.id);
    assert.throws(
      () => f.instances.create(f.alice.member, create()),
      status(409),
    );
    f.instances.delete(f.alice.member, a.id, 1);
    assert.equal(f.instances.create(f.alice.member, create()).version, 1);
    f.db.prepare("UPDATE instance_storage_version SET version=2").run();
    assert.throws(
      () => new ContentInstanceStore(f.db, f.campaigns, f.catalog, f.content),
    );
    f.db.prepare("UPDATE instance_storage_version SET version=1").run();
    f.db.exec("DROP TABLE content_instances");
    assert.throws(
      () => new ContentInstanceStore(f.db, f.campaigns, f.catalog, f.content),
    );
    f.db.exec(
      "DROP TABLE instance_storage_version; CREATE TABLE content_instances(id TEXT)",
    );
    assert.throws(
      () => new ContentInstanceStore(f.db, f.campaigns, f.catalog, f.content),
    );
  } finally {
    f.db.close();
  }
});
test("instance schemas support opaque scalar/null owned state without injecting an attribute or inventory model", () => {
  const pack = instancePack();
  pack.instances = defineContentInstances(z.unknown(), {
    schemaVersion: 1,
    dataSchema: z.boolean().nullable(),
    create: () => false,
  });
  const f = fixture(pack);
  try {
    const created = f.instances.create(f.alice.member, create());
    assert.equal(created.data, false);
    const changed = f.instances.update(f.alice.member, created.id, {
      ...edit(),
      data: null,
    });
    assert.equal(changed.data, null);
    assert.equal(changed.version, 2);
    assert.equal(f.instances.get(f.gm.member, created.id).data, null);
    const changedPack = {
      ...pack,
      instances: { ...pack.instances, schemaVersion: 2 },
    };
    assert.throws(
      () =>
        new CampaignContentStore(
          f.db,
          f.campaigns,
          new ContentCatalog([changedPack]),
        ),
      /version bump/,
    );
    const future = new ContentInstanceStore(
      f.db,
      f.campaigns,
      new ContentCatalog([changedPack]),
      f.content,
    );
    assert.throws(() => future.get(f.alice.member, created.id), status(409));
  } finally {
    f.db.close();
  }
});
test("instances from a published replacement retain only explicit effective sources when the original is private", () => {
  const f = fixture();
  try {
    f.content.override(f.gm.member, ref("b-hidden"), {
      expectedRevision: 0,
      name: "Shared replacement",
      visibility: "public",
      data: { label: "Shared", tags: [] },
      sources: [],
    });
    const gmCopy = f.instances.create(f.gm.member, create("b-hidden", 1));
    const published = f.instances.update(f.gm.member, gmCopy.id, {
      ...edit(),
      visibility: "public",
    });
    const playerCopy = f.instances.create(
      f.alice.member,
      create("b-hidden", 1),
    );
    f.content.reset(f.gm.member, ref("b-hidden"), { expectedRevision: 1 });
    for (const instance of [
      f.instances.get(f.alice.member, published.id),
      f.instances.get(f.alice.member, playerCopy.id),
    ]) {
      assert.deepEqual(instance.source.data, { label: "Shared", tags: [] });
      assert.deepEqual(instance.source.sources, []);
      assert.ok(!JSON.stringify(instance).includes("GM-ONLY-SOURCE"));
      assert.ok(!JSON.stringify(instance).includes("PRIVATE-CONTENT-CANARY"));
      assert.ok(!JSON.stringify(instance).includes("GM-ONLY-FIXTURE"));
    }
    assert.throws(
      () => f.instances.create(f.alice.member, create("b-hidden", 2)),
      status(404),
    );
  } finally {
    f.db.close();
  }
});
