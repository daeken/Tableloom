import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommand } from "@tableloom/core/server";
import {
  campaignSettingsSchema,
  DEFAULT_CAMPAIGN_ID,
  MAX_CAMPAIGNS,
  MAX_SCENES,
} from "@tableloom/core/campaigns";
import type { CampaignSettings } from "@tableloom/core/campaigns";
import type { Member } from "@tableloom/core/access";
import { TableStore } from "./store.js";
import { installedModules } from "./modules.js";

const gm: Member = {
  id: randomUUID(),
  name: "GM",
  role: "gm",
  tableId: "00000000-0000-4000-8000-000000000001",
};
const settings = (
  name = "Another campaign",
  systemId = "kids-on-bikes",
): CampaignSettings => ({
  name,
  description: "",
  system: { id: systemId, version: "0.1.0" },
  contentPacks: [],
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-campaigns-"));
  return { directory, path: join(directory, "table.sqlite") };
}

test("campaigns isolate content and receipts; scenes keep separate graphics and share campaign notes/rolls", () => {
  const store = new TableStore(":memory:");
  try {
    const commandId = randomUUID(),
      tokenId = randomUUID(),
      noteId = randomUUID();
    let state = store.load();
    state = applyCommand(
      state,
      {
        id: commandId,
        type: "token.add",
        token: {
          id: tokenId,
          name: "Scout",
          position: { x: 1, y: 2 },
          color: "#405f4d",
        },
      },
      gm,
    );
    store.save(state, commandId);
    const noteCommand = randomUUID();
    state = applyCommand(
      state,
      {
        id: noteCommand,
        type: "note.add",
        note: {
          id: noteId,
          title: "Campaign clue",
          body: "Private campaign text",
          visibility: "gm",
        },
      },
      gm,
    );
    store.save(state, noteCommand);
    const rollCommand = randomUUID();
    state = applyCommand(
      state,
      {
        id: rollCommand,
        type: "dice.roll",
        expression: "d6",
        visibility: "gm",
      },
      gm,
    );
    store.save(state, rollCommand);
    const first = store.getCampaign(),
      second = store.createCampaign(settings());
    assert.equal(store.load(second.id).notes.length, 0);
    assert.equal(store.load(second.id).tokens.length, 0);
    assert.equal(store.load(second.id).rolls.length, 0);
    assert.equal(store.load(second.id).systemId, "kids-on-bikes");
    assert.equal(store.hasCommand(commandId, second.id), false);
    const otherState = applyCommand(
      store.load(second.id),
      { id: commandId, type: "dice.roll", expression: "d8" },
      gm,
    );
    store.save(otherState, commandId, second.id);
    assert.equal(store.hasCommand(commandId, second.id), true);
    assert.equal(store.load().rolls[0]?.expression, "1d6");
    const scene = store.createScene(first.id, { name: "Offstage room" });
    assert.equal(store.getCampaign().activeSceneId, first.activeSceneId);
    assert.equal(store.load().tokens[0]?.id, tokenId);
    const switched = store.activateScene(first.id, scene.id, first.version);
    const room = store.load();
    assert.equal(room.tokens.length, 0);
    assert.deepEqual(room.notes, state.notes);
    assert.deepEqual(room.rolls, state.rolls);
    const staleId = randomUUID();
    assert.throws(
      () => store.save({ ...state, revision: state.revision + 1 }, staleId),
      /campaign changed/,
    );
    assert.equal(store.hasCommand(staleId), false);
    assert.deepEqual(store.load(), room);
    const collisionId = randomUUID();
    const colliding = applyCommand(
      room,
      {
        id: collisionId,
        type: "note.add",
        note: {
          id: tokenId,
          title: "Conflicting ID",
          body: "",
          visibility: "gm",
        },
      },
      gm,
    );
    assert.throws(() => store.save(colliding, collisionId), /already exists/);
    assert.equal(store.hasCommand(collisionId), false);
    assert.throws(
      () =>
        store.activateScene(first.id, second.activeSceneId, switched.version),
      /unavailable/,
    );
    assert.throws(
      () => store.activateScene(first.id, first.activeSceneId, first.version),
      /settings changed/,
    );
    store.activateScene(first.id, first.activeSceneId, switched.version);
    assert.equal(store.load().tokens[0]?.id, tokenId);
    assert.equal(store.listScenes().length, 2);
    assert.equal(store.listCampaigns().length, 2);
  } finally {
    store.close();
  }
});

test("settings pin exact installed system/pack versions, reject unknown or incompatible packages, and survive restart", () => {
  const { directory, path } = fixture();
  const catalog = {
    systems: installedModules,
    contentPacks: [
      { id: "test-pack", version: "1.2.3", systemId: "kids-on-bikes" },
    ],
  };
  let store = new TableStore(path, catalog);
  try {
    const input = {
      ...settings(),
      contentPacks: [{ id: "test-pack", version: "1.2.3" }],
    };
    const campaign = store.createCampaign(input);
    assert.throws(
      () =>
        store.createCampaign({
          ...input,
          system: { id: "kids-on-bikes", version: "9.9.9" },
        }),
      /required system/,
    );
    assert.throws(
      () =>
        store.createCampaign({
          ...input,
          contentPacks: [{ id: "missing-pack", version: "1.2.3" }],
        }),
      /compatible content/,
    );
    assert.throws(
      () =>
        store.createCampaign({
          ...input,
          system: { id: "kids-on-brooms", version: "0.1.0" },
        }),
      /compatible content/,
    );
    assert.equal(
      campaignSettingsSchema.safeParse({
        ...input,
        contentPacks: [...input.contentPacks, ...input.contentPacks],
      }).success,
      false,
    );
    assert.equal(
      campaignSettingsSchema.safeParse({
        ...input,
        system: { id: "kids-on-bikes", version: "^0.1.0" },
      }).success,
      false,
    );
    assert.equal(
      campaignSettingsSchema.safeParse({
        ...input,
        scriptPath: "./arbitrary.ts",
      }).success,
      false,
    );
    const updated = store.updateCampaign(campaign.id, 1, {
      ...input,
      name: "  Changed name  ",
      description: "Campaign description",
    });
    assert.equal(updated.name, "Changed name");
    assert.equal(updated.version, 2);
    assert.throws(
      () => store.updateCampaign(campaign.id, 1, input),
      /settings changed/,
    );
    assert.equal(store.load(campaign.id).revision, 1);
    store.close();
    store = new TableStore(path, catalog);
    assert.deepEqual(store.getCampaign(campaign.id), updated);
    const unavailablePack = new TableStore(path);
    try {
      assert.throws(() => unavailablePack.load(campaign.id), /test-pack@1.2.3/);
    } finally {
      unavailablePack.close();
    }
    const upgraded = new TableStore(path, {
      systems: installedModules.map((module) => ({
        ...module,
        version: "0.2.0",
      })),
      contentPacks: catalog.contentPacks,
    });
    try {
      assert.throws(() => upgraded.load(campaign.id), /kids-on-bikes@0.1.0/);
    } finally {
      upgraded.close();
    }
    assert.deepEqual(store.getCampaign(campaign.id), updated); // No silent pin upgrade.
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("campaign metadata, scene state, system pins, and receipts commit together and reject competing writers", () => {
  const { directory, path } = fixture();
  const first = new TableStore(path),
    second = new TableStore(path),
    db = new DatabaseSync(path);
  try {
    const original = first.load(),
      originalMetadata = first.getCampaign();
    db.exec(
      "CREATE TRIGGER reject_campaign_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END;",
    );
    const commandId = randomUUID();
    const changed = {
      ...original,
      systemId: "kids-on-bikes",
      revision: original.revision + 1,
      tokens: [
        {
          id: randomUUID(),
          name: "Marker",
          position: { x: 0, y: 0 },
          color: "#405f4d",
          ownerId: gm.id,
          version: 1,
        },
      ],
    };
    assert.throws(() => first.save(changed, commandId));
    assert.deepEqual(first.getCampaign(), originalMetadata);
    assert.deepEqual(first.load(), original);
    assert.equal(first.hasCommand(commandId), false);
    db.exec("DROP TRIGGER reject_campaign_receipt");
    const stale = second.load();
    first.save(changed, commandId);
    assert.equal(first.getCampaign().system.id, "kids-on-bikes");
    assert.equal(first.getCampaign().version, 2);
    assert.throws(
      () =>
        second.save({ ...stale, revision: stale.revision + 1 }, randomUUID()),
      /campaign changed/,
    );
    assert.deepEqual(second.load(), changed);
    assert.equal(second.hasCommand(commandId), true);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    first.close();
    second.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("campaign and scene capacities are bounded and invalid names do not allocate records", () => {
  const store = new TableStore(":memory:");
  try {
    assert.throws(() => store.createCampaign(settings(" ")));
    assert.throws(() => store.createScene(DEFAULT_CAMPAIGN_ID, { name: " " }));
    for (let i = 1; i < MAX_CAMPAIGNS; i++)
      store.createCampaign(settings(`Campaign ${i}`));
    assert.throws(() => store.createCampaign(settings()), /campaign limit/);
    for (let i = 1; i < MAX_SCENES; i++)
      store.createScene(DEFAULT_CAMPAIGN_ID, { name: `Scene ${i}` });
    assert.throws(
      () => store.createScene(DEFAULT_CAMPAIGN_ID, { name: "Overflow" }),
      /scene limit/,
    );
    assert.equal(store.listCampaigns().length, MAX_CAMPAIGNS);
    assert.equal(store.listScenes().length, MAX_SCENES);
  } finally {
    store.close();
  }
});

test("unknown, incomplete, mismatched, or downgraded persistence fails closed without reconstructing missing data", () => {
  const { directory, path } = fixture();
  let store: TableStore | undefined = new TableStore(path);
  const db = new DatabaseSync(path);
  try {
    const metadata = store.getCampaign();
    store.close();
    store = undefined;
    db.exec("UPDATE campaign_storage_version SET version = 99");
    assert.throws(() => new TableStore(path));
    assert.equal(
      db.prepare("SELECT version FROM campaign_storage_version").get()?.version,
      99,
    );
    db.exec("UPDATE campaign_storage_version SET version = 2");
    db.prepare("UPDATE campaign_records SET json = ?").run(
      JSON.stringify({ ...metadata, activeSceneId: randomUUID() }),
    );
    store = new TableStore(path);
    const mismatched = store;
    assert.throws(() => mismatched.load(), /identifiers disagree/);
    store.close();
    store = undefined;
    db.prepare("UPDATE campaign_records SET json = ?").run(
      JSON.stringify(metadata),
    );
    db.exec("CREATE TABLE table_state(id INTEGER PRIMARY KEY, json TEXT)");
    assert.throws(() => new TableStore(path), /coexist/);
    db.exec("DROP TABLE table_state; DROP TABLE campaign_receipts;");
    assert.throws(() => new TableStore(path), /incomplete/);
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'campaign_receipts'",
        )
        .get(),
      undefined,
    );
  } finally {
    store?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
