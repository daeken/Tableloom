import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, populate } from "./campaign-transfer-fixture.js";
import { parseCampaignTransfer } from "./campaign-transfer-format.js";
import { validateCampaignStorageQuotas } from "./campaign-storage-quotas.js";
import { inspectCampaignTransfer } from "./campaign-preflight.js";
import { installedModules } from "./modules.js";
import { documentSystems } from "./document-modules.js";
import { StoreError } from "./store.js";
import { MAX_CAMPAIGNS } from "@tableloom/core/campaigns";
import {
  MAX_ASSET_BYTES,
  MAX_CAMPAIGN_ASSET_BYTES,
} from "@tableloom/core/assets";
import {
  MAX_AUDIENCE_CHAT_MESSAGES,
  MAX_CAMPAIGN_CHAT_MESSAGES,
  MAX_MEMBER_SCENE_HISTORY,
  MAX_CAMPAIGN_SCENE_HISTORY,
  MAX_CAMPAIGN_HISTORY_BYTES,
  MAX_SCENE_MAP_HISTORY,
  MAX_MAP_HISTORY_ENTRY_BYTES,
  MAX_CAMPAIGN_MAP_HISTORY_BYTES,
} from "./storage-limits.js";

const overQuota = (error: unknown) =>
  error instanceof StoreError &&
  error.statusCode === 400 &&
  error.message === "Campaign exceeds live storage limits.";
function records() {
  const f = fixture();
  try {
    populate(f);
    return parseCampaignTransfer(f.snapshot()).records;
  } finally {
    f.db.close();
  }
}

test("transfer chat quotas accept each full audience, reject its next message, and enforce the aggregate campaign bound", () => {
  const rows = records(),
    template = rows.chat_messages[0]!,
    message = JSON.parse(template.message_json),
    authors = Array.from({ length: 12 }, () => randomUUID());
  const chat = (count: number, groupSize: number) =>
    Array.from({ length: count }, (_, i) => {
      const id = randomUUID(),
        authorId = authors[Math.floor(i / groupSize)]!;
      return {
        ...template,
        id,
        sequence: i + 1,
        bucket: authorId,
        message_json: JSON.stringify({ ...message, id, authorId }),
      };
    });
  rows.chat_messages = chat(
    MAX_AUDIENCE_CHAT_MESSAGES,
    MAX_AUDIENCE_CHAT_MESSAGES + 1,
  );
  assert.doesNotThrow(() => validateCampaignStorageQuotas(rows));
  rows.chat_messages = chat(
    MAX_AUDIENCE_CHAT_MESSAGES + 1,
    MAX_AUDIENCE_CHAT_MESSAGES + 1,
  );
  assert.throws(() => validateCampaignStorageQuotas(rows), overQuota);
  rows.chat_messages = chat(
    MAX_CAMPAIGN_CHAT_MESSAGES,
    MAX_AUDIENCE_CHAT_MESSAGES,
  );
  assert.doesNotThrow(() => validateCampaignStorageQuotas(rows));
  rows.chat_messages = chat(
    MAX_CAMPAIGN_CHAT_MESSAGES + 1,
    MAX_AUDIENCE_CHAT_MESSAGES,
  );
  assert.throws(() => validateCampaignStorageQuotas(rows), overQuota);
});

test("transfer edit history is bounded per person and scene rather than by only the whole campaign", () => {
  const rows = records(),
    template = rows.scene_history_entries[0]!;
  rows.scene_history_entries = Array.from(
    { length: MAX_MEMBER_SCENE_HISTORY },
    (_, i) => ({ ...template, id: randomUUID(), sequence: i + 1 }),
  );
  assert.doesNotThrow(() => validateCampaignStorageQuotas(rows));
  rows.scene_history_entries.push({
    ...template,
    id: randomUUID(),
    sequence: MAX_MEMBER_SCENE_HISTORY + 1,
  });
  assert.throws(() => validateCampaignStorageQuotas(rows), overQuota);
  rows.scene_history_entries.at(-1)!.scene_id = randomUUID();
  assert.doesNotThrow(() => validateCampaignStorageQuotas(rows));
  rows.scene_history_entries.at(-1)!.scene_id = template.scene_id;
  rows.scene_history_entries.at(-1)!.actor_id = randomUUID();
  assert.doesNotThrow(() => validateCampaignStorageQuotas(rows));
});

test("map history enforces per-scene retention, per-entry bytes and campaign bytes without truncating records", () => {
  const rows = records(),
    template = rows.scene_background_history[0]!,
    parsed = JSON.parse(template.entry_json);
  const history = (count: number, bytes: number) => {
    const scenes = Array.from(
      { length: Math.ceil(count / MAX_SCENE_MAP_HISTORY) },
      () => randomUUID(),
    );
    return Array.from({ length: count }, (_, i) => {
      const id = randomUUID(),
        seq = (i % MAX_SCENE_MAP_HISTORY) + 1,
        json = JSON.stringify({ ...parsed, id, seq });
      return {
        ...template,
        id,
        seq,
        scene_id: scenes[Math.floor(i / MAX_SCENE_MAP_HISTORY)]!,
        entry_json: json + " ".repeat(bytes - Buffer.byteLength(json)),
      };
    });
  };
  rows.scene_background_history = history(
    MAX_SCENE_MAP_HISTORY,
    MAX_MAP_HISTORY_ENTRY_BYTES,
  );
  assert.doesNotThrow(() => validateCampaignStorageQuotas(rows));
  rows.scene_background_history.push({
    ...rows.scene_background_history[0]!,
    id: randomUUID(),
    seq: MAX_SCENE_MAP_HISTORY + 1,
  });
  assert.throws(() => validateCampaignStorageQuotas(rows), overQuota);
  rows.scene_background_history = history(1, MAX_MAP_HISTORY_ENTRY_BYTES + 1);
  assert.throws(() => validateCampaignStorageQuotas(rows), overQuota);
  rows.scene_background_history = history(
    MAX_CAMPAIGN_MAP_HISTORY_BYTES / MAX_MAP_HISTORY_ENTRY_BYTES,
    MAX_MAP_HISTORY_ENTRY_BYTES,
  );
  assert.doesNotThrow(() => validateCampaignStorageQuotas(rows));
  const before = rows.scene_background_history.length;
  rows.scene_background_history.push({
    ...template,
    id: randomUUID(),
    scene_id: randomUUID(),
  });
  assert.throws(() => validateCampaignStorageQuotas(rows), overQuota);
  assert.equal(rows.scene_background_history.length, before + 1);
});

test("edit-history byte accounting matches UTF-8 storage exactly and rejects one extra multibyte character", () => {
  const rows = records(),
    template = rows.scene_history_entries[0]!,
    authors = Array.from(
      { length: MAX_CAMPAIGN_SCENE_HISTORY / MAX_MEMBER_SCENE_HISTORY },
      () => randomUUID(),
    ),
    targetBytes = Buffer.byteLength(template.targets_json),
    each = Math.floor(MAX_CAMPAIGN_HISTORY_BYTES / MAX_CAMPAIGN_SCENE_HISTORY),
    payload =
      template.payload_json +
      " ".repeat(each - targetBytes - Buffer.byteLength(template.payload_json));
  rows.scene_history_entries = Array.from(
    { length: MAX_CAMPAIGN_SCENE_HISTORY },
    (_, i) => ({
      ...template,
      id: randomUUID(),
      sequence: i + 1,
      actor_id: authors[Math.floor(i / MAX_MEMBER_SCENE_HISTORY)]!,
      payload_json: payload,
    }),
  );
  const last = rows.scene_history_entries.at(-1)!;
  last.payload_json += " ".repeat(
    MAX_CAMPAIGN_HISTORY_BYTES - each * MAX_CAMPAIGN_SCENE_HISTORY,
  );
  assert.doesNotThrow(() => validateCampaignStorageQuotas(rows));
  const sameLength = last.payload_json.replace("PRIVATE", "PRIVATÉ");
  assert.equal(sameLength.length, last.payload_json.length);
  assert.equal(
    Buffer.byteLength(sameLength),
    Buffer.byteLength(last.payload_json) + 1,
  );
  last.payload_json = sameLength;
  assert.throws(() => validateCampaignStorageQuotas(rows), overQuota);
});

test("asset storage totals count the bytes of all owned image records", () => {
  const rows = records(),
    template = rows.campaign_assets[0]!;
  rows.campaign_assets = Array.from(
    { length: MAX_CAMPAIGN_ASSET_BYTES / MAX_ASSET_BYTES },
    () => ({ ...template, id: randomUUID(), byte_length: MAX_ASSET_BYTES }),
  );
  assert.doesNotThrow(() => validateCampaignStorageQuotas(rows));
  rows.campaign_assets.push({ ...template, id: randomUUID() });
  assert.throws(() => validateCampaignStorageQuotas(rows), overQuota);
});

test("preflight rejects over-retained private chat before touching destination state and keeps the transfer explicitly unready", () => {
  const f = fixture();
  try {
    populate(f);
    const file = parseCampaignTransfer(f.snapshot()),
      template = file.records.chat_messages[0]!,
      message = JSON.parse(template.message_json);
    const inspect = () =>
      inspectCampaignTransfer(
        JSON.stringify(file),
        { systems: installedModules, contentPacks: f.catalog.metadata() },
        f.catalog,
        documentSystems,
        f.db,
      );
    file.records.chat_messages = Array.from(
      { length: MAX_AUDIENCE_CHAT_MESSAGES },
      (_, i) => {
        const id = randomUUID();
        return {
          ...template,
          id,
          sequence: i + 1,
          message_json: JSON.stringify({ ...message, id }),
        };
      },
    );
    const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
    const report = inspect();
    assert.deepEqual(report.blockers, []);
    assert.equal(report.importReady, false);
    assert.ok(!report.pendingValidation.includes("full-storage-quotas"));
    assert.ok(report.pendingValidation.includes("mapped-storage-quotas"));
    file.records.chat_messages.push({
      ...template,
      sequence: MAX_AUDIENCE_CHAT_MESSAGES + 1,
    });
    assert.throws(inspect, overQuota);
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    assert.equal(f.db.isTransaction, false);
  } finally {
    f.db.close();
  }
});

test("preflight blocks a new campaign when either destination campaign or access storage reaches capacity, without allocating a slot", () => {
  const f = fixture(),
    accessFull = fixture();
  try {
    const file = f.snapshot();
    const inspect = (target = f) =>
      inspectCampaignTransfer(
        file,
        { systems: installedModules, contentPacks: target.catalog.metadata() },
        target.catalog,
        documentSystems,
        target.db,
      );
    const before = inspect();
    assert.deepEqual(before.destination.campaignCapacity, {
      used: 1,
      accessUsed: 1,
      limit: MAX_CAMPAIGNS,
    });
    const campaign = f.tables.getCampaign();
    for (let i = 1; i < MAX_CAMPAIGNS; i++) {
      f.tables.createCampaign({
        name: `Capacity fixture ${i}`,
        description: "",
        system: campaign.system,
        contentPacks: [],
      });
      accessFull.db
        .prepare("INSERT INTO access_campaigns(id) VALUES(?)")
        .run(randomUUID());
    }
    for (const target of [f, accessFull]) {
      const changes = target.db.prepare("SELECT total_changes() AS n").get()!.n;
      const report = inspect(target);
      assert.ok(report.blockers.includes("campaign_capacity_reached"));
      assert.equal(report.importReady, false);
      assert.equal(
        target.db.prepare("SELECT total_changes() AS n").get()!.n,
        changes,
      );
      assert.equal(target.db.isTransaction, false);
    }
  } finally {
    f.db.close();
    accessFull.db.close();
  }
});
