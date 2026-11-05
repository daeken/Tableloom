import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ContentCatalog,
  withContentMetadata,
  validatedContentData,
} from "./content-catalog.js";
import { CampaignContentStore } from "./content.js";
import { TableStore, StoreError } from "./store.js";
import { AccessStore } from "./access.js";
import { installedModules } from "./modules.js";
import { fixturePack, fixtureData } from "./content-fixture.js";
import { defineContentPack } from "@tableloom/module-sdk/content";
import { defineServerSystem } from "@tableloom/module-sdk/server";
import { system } from "@tableloom/cyberpunk-red";
const key = "catalog-test-fixture-not-a-real-key";
const status = (code: number) => (error: unknown) =>
  error instanceof StoreError && error.statusCode === code;
const ref = (definitionId = "a-public", packVersion = "1.0.0") => ({
  packId: "fixture-paper",
  packVersion,
  definitionId,
});
const body = (expectedRevision = 0, visibility: "gm" | "public" = "gm") => ({
  expectedRevision,
  name: "Homebrew page",
  visibility,
  data: { label: "Modified", tags: ["homebrew"] },
  sources: [],
});
function fixture() {
  const db = new DatabaseSync(":memory:"),
    provider = fixturePack(),
    catalog = new ContentCatalog([provider]);
  const campaigns = new TableStore(
      db,
      withContentMetadata(
        { systems: installedModules, contentPacks: [] },
        catalog,
      ),
    ),
    access = new AccessStore(db, key);
  const gm = access.setupHost(key, "GM"),
    alice = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Alice",
    );
  const current = campaigns.getCampaign();
  campaigns.updateCampaign(current.id, current.version, {
    name: current.name,
    description: "",
    system: current.system,
    contentPacks: [{ id: provider.id, version: provider.version }],
  });
  const content = new CampaignContentStore(db, campaigns, catalog);
  return { db, provider, catalog, campaigns, access, gm, alice, content };
}
test("catalog definitions are immutable snapshots with bounded validated data and stable canonical pack identities", () => {
  const f = fixture();
  try {
    const original = f.content.get(f.alice.member, ref());
    f.provider.definitions[0]!.data.label =
      "Changed provider after registration";
    assert.deepEqual(f.content.get(f.alice.member, ref()), original);
    const result = f.content.get(f.alice.member, ref());
    if (
      result.data &&
      !Array.isArray(result.data) &&
      typeof result.data === "object"
    )
      result.data.label = "Mutated response";
    result.sources[0]!.title = "Mutated source";
    assert.deepEqual(f.content.get(f.alice.member, ref()), original);
    const reordered = fixturePack();
    reordered.definitions.reverse();
    assert.equal(
      new ContentCatalog([reordered]).packs[0]!.digest,
      f.catalog.packs[0]!.digest,
    );
    assert.throws(() => new ContentCatalog([fixturePack(), fixturePack()]));
    assert.throws(
      () =>
        new ContentCatalog([
          { ...fixturePack(), dataSchema: z.object({ label: z.string() }) },
        ]),
    );
    assert.equal(validatedContentData(z.boolean(), false), false);
    assert.equal(validatedContentData(z.null(), null), null);
    assert.throws(() =>
      defineContentPack(system, {
        id: "bad",
        version: "1.0.0",
        dataSchema: fixtureData,
        definitions: [
          ...fixturePack().definitions,
          ...fixturePack().definitions,
        ],
      }),
    );
    assert.throws(() =>
      defineContentPack(system, {
        id: "bad",
        version: "1.0.0",
        dataSchema: z.object({ text: z.string() }),
        definitions: [
          {
            id: "example",
            name: "Too large",
            kind: "example",
            sources: [],
            data: { text: "x".repeat(70000) },
          },
        ],
      }),
    );
    assert.throws(() =>
      defineServerSystem({
        ...system,
        contentPacks: [{ ...fixturePack(), systemVersion: "9.9.9" }],
      }),
    );
  } finally {
    f.db.close();
  }
});
test("catalog audiences are filtered before payload decoding and pagination; unknown/unselected/hidden IDs do not disclose content", () => {
  const f = fixture();
  try {
    const first = f.content.list(f.alice.member, { limit: 1 });
    assert.equal(first.definitions[0]?.reference.definitionId, "a-public");
    const second = f.content.list(f.alice.member, {
      limit: 1,
      after: first.next!,
    });
    assert.equal(second.definitions[0]?.reference.definitionId, "c-public");
    assert.equal(second.next, null);
    assert.equal("data" in first.definitions[0]!, false);
    assert.equal(f.content.list(f.gm.member).definitions.length, 3);
    assert.throws(
      () => f.content.get(f.alice.member, ref("b-hidden")),
      status(404),
    );
    assert.throws(
      () => f.content.get(f.alice.member, ref("unknown")),
      status(404),
    );
    assert.throws(
      () =>
        f.content.get(f.alice.member, { ...ref(), packId: "unselected-pack" }),
      status(404),
    );
    f.content.override(f.gm.member, ref("b-hidden"), body());
    f.db
      .prepare(
        "UPDATE content_overrides SET data_json='broken private JSON' WHERE definition_id='b-hidden'",
      )
      .run();
    assert.throws(
      () => f.content.get(f.alice.member, ref("b-hidden")),
      status(404),
    );
    assert.equal(f.content.list(f.alice.member).definitions.length, 2);
    assert.throws(
      () => f.content.get({ ...f.alice.member, role: "gm" }, ref("b-hidden")),
      status(404),
    );
    assert.throws(
      () =>
        f.content.override({ ...f.alice.member, role: "gm" }, ref(), body()),
      status(403),
    );
  } finally {
    f.db.close();
  }
});
test("opaque scalar data remains distinct from a reset override tombstone", () => {
  const pack = defineContentPack(system, {
    id: "fixture-scalar",
    version: "1.0.0",
    dataSchema: z.union([z.boolean(), z.null()]),
    definitions: [
      {
        id: "marker",
        name: "Synthetic marker",
        kind: "example",
        visibility: "public",
        data: false,
        sources: [],
      },
    ],
  });
  const db = new DatabaseSync(":memory:"),
    catalog = new ContentCatalog([pack]),
    campaigns = new TableStore(
      db,
      withContentMetadata(
        { systems: installedModules, contentPacks: [] },
        catalog,
      ),
    );
  const access = new AccessStore(db, key),
    gm = access.setupHost(key, "GM"),
    campaign = campaigns.getCampaign();
  try {
    campaigns.updateCampaign(campaign.id, campaign.version, {
      name: campaign.name,
      description: "",
      system: campaign.system,
      contentPacks: [{ id: pack.id, version: pack.version }],
    });
    const content = new CampaignContentStore(db, campaigns, catalog),
      reference = {
        packId: pack.id,
        packVersion: pack.version,
        definitionId: "marker",
      };
    assert.equal(content.get(gm.member, reference).data, false);
    const changed = content.override(gm.member, reference, {
      ...body(0, "public"),
      data: null,
    });
    assert.equal(changed.data, null);
    assert.equal(changed.overridden, true);
    const reset = content.reset(gm.member, reference, { expectedRevision: 1 });
    assert.equal(reset.data, false);
    assert.equal(reset.overridden, false);
    assert.equal(reset.revision, 2);
  } finally {
    db.close();
  }
});
test("homebrew replacement/reset is GM-only, versioned, keeps origin references and never advances unrelated table/campaign clocks", () => {
  const f = fixture();
  try {
    const table = f.campaigns.load(),
      campaign = f.campaigns.getCampaign(),
      base = f.content.get(f.gm.member, ref());
    assert.throws(
      () => f.content.override(f.alice.member, ref(), body()),
      status(403),
    );
    const override = f.content.override(f.gm.member, ref(), body());
    assert.equal(override.revision, 1);
    assert.equal(override.overridden, true);
    assert.deepEqual(override.originSources, base.sources);
    assert.deepEqual(override.sources, []);
    assert.equal(override.kind, base.kind);
    assert.throws(() => f.content.get(f.alice.member, ref()), status(404));
    assert.throws(
      () => f.content.override(f.gm.member, ref(), body()),
      status(409),
    );
    const published = f.content.override(f.gm.member, ref(), body(1, "public"));
    assert.equal(published.revision, 2);
    assert.deepEqual(f.content.get(f.alice.member, ref()), published);
    const reset = f.content.reset(f.gm.member, ref(), { expectedRevision: 2 });
    assert.equal(reset.revision, 3);
    assert.equal(reset.overridden, false);
    assert.deepEqual(reset.data, base.data);
    assert.throws(
      () => f.content.override(f.gm.member, ref(), body()),
      status(409),
    );
    assert.throws(
      () => f.content.reset(f.gm.member, ref(), { expectedRevision: 3 }),
      status(400),
    );
    assert.deepEqual(f.campaigns.load(), table);
    assert.deepEqual(f.campaigns.getCampaign(), campaign);
  } finally {
    f.db.close();
  }
});
test("active overrides protect pack/system pins; reset tombstones permit removal without accepting an old revision", () => {
  const f = fixture();
  try {
    f.content.override(f.gm.member, ref(), body());
    const campaign = f.campaigns.getCampaign();
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
    assert.throws(
      () =>
        f.campaigns.save(
          {
            ...f.campaigns.load(),
            revision: f.campaigns.load().revision + 1,
            systemId: "kids-on-bikes",
          },
          randomUUID(),
        ),
      status(409),
    );
    f.content.reset(f.gm.member, ref(), { expectedRevision: 1 });
    const removed = f.campaigns.updateCampaign(
      campaign.id,
      campaign.version,
      settings,
    );
    assert.throws(() => f.content.get(f.gm.member, ref()), status(404));
    f.campaigns.updateCampaign(campaign.id, removed.version, {
      ...settings,
      contentPacks: campaign.contentPacks,
    });
    assert.equal(f.content.get(f.gm.member, ref()).revision, 2);
    assert.throws(
      () => f.content.override(f.gm.member, ref(), body()),
      status(409),
    );
  } finally {
    f.db.close();
  }
});
test("content schema markers and distinct-override quotas fail closed, including reset tombstones", () => {
  for (const change of [
    "DROP TABLE content_storage_version",
    "DROP TABLE content_pack_bindings",
  ]) {
    const f = fixture();
    try {
      f.db.exec(change);
      assert.throws(
        () => new CampaignContentStore(f.db, f.campaigns, f.catalog),
      );
    } finally {
      f.db.close();
    }
  }
  const f = fixture();
  try {
    const insert = f.db.prepare(
      "INSERT INTO content_overrides(campaign_id,pack_id,pack_version,definition_id,revision) VALUES(?,?,?,?,?)",
    );
    f.db.exec("BEGIN");
    for (let i = 0; i < 1000; i++)
      insert.run(
        f.gm.member.tableId,
        "fixture-paper",
        "1.0.0",
        `unused-${i}`,
        1,
      );
    f.db.exec("COMMIT");
    assert.throws(
      () => f.content.override(f.gm.member, ref(), body()),
      status(409),
    );
    assert.equal(f.content.get(f.alice.member, ref()).revision, 0);
  } finally {
    f.db.close();
  }
});
test("invalid input, failed persistence and changed pack bytes roll back; content storage markers fail closed", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.content.override(f.gm.member, ref(), {
          ...body(),
          data: { label: "Bad", tags: [], unexpected: true },
        }),
      status(400),
    );
    f.db.exec(
      "CREATE TRIGGER fail_content BEFORE INSERT ON content_overrides BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    assert.throws(() => f.content.override(f.gm.member, ref(), body()));
    assert.equal(f.content.get(f.gm.member, ref()).revision, 0);
    f.db.exec("DROP TRIGGER fail_content");
    const saved = f.content.override(f.gm.member, ref(), body());
    const restarted = new CampaignContentStore(
      f.db,
      f.campaigns,
      new ContentCatalog([fixturePack()]),
    );
    assert.deepEqual(restarted.get(f.gm.member, ref()), saved);
    const changed = fixturePack();
    changed.definitions[0]!.name = "Changed without bump";
    const fresh = fixturePack("2.0.0");
    assert.throws(
      () =>
        new CampaignContentStore(
          f.db,
          f.campaigns,
          new ContentCatalog([fresh, changed]),
        ),
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM content_pack_bindings WHERE pack_version='2.0.0'",
        )
        .get()?.n,
      0,
    );
    f.db.exec("UPDATE content_storage_version SET version=2");
    assert.throws(() => new CampaignContentStore(f.db, f.campaigns, f.catalog));
  } finally {
    f.db.close();
  }
});
