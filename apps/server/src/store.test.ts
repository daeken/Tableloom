import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTable } from "@tableloom/core";
import {
  DEFAULT_CAMPAIGN_ID,
  DEFAULT_SCENE_ID,
} from "@tableloom/core/campaigns";
import { applyCommand, projectTable } from "@tableloom/core/server";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";

function legacyTables(
  db: DatabaseSync,
  state: unknown,
  receipt: string,
  revision: number,
) {
  db.exec(
    "CREATE TABLE table_state (id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL); CREATE TABLE command_receipts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);",
  );
  db.prepare("INSERT INTO table_state(id, json) VALUES (1, ?)").run(
    JSON.stringify(state),
  );
  db.prepare("INSERT INTO command_receipts(id, revision) VALUES (?, ?)").run(
    receipt,
    revision,
  );
}

test("legacy version 1 table atomically becomes a default campaign/scene without changing revisions or receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-migrate-"));
  const path = join(directory, "table.sqlite"),
    db = new DatabaseSync(path);
  let store: TableStore | undefined;
  try {
    const legacy = {
      ...createTable(),
      schemaVersion: 1,
      revision: 8,
      tokens: [
        {
          id: randomUUID(),
          name: "Old token",
          position: { x: 20, y: 30 },
          color: "#405f4d",
        },
      ],
    };
    Reflect.deleteProperty(legacy, "notes");
    const receipt = randomUUID();
    legacyTables(db, legacy, receipt, 8);
    store = new TableStore(path);
    const state = store.load();
    assert.equal(state.tokens[0]?.ownerId, null);
    assert.equal(state.schemaVersion, 10);
    assert.equal(state.revision, 8);
    assert.equal(store.hasCommand(receipt), true);
    assert.deepEqual(store.getCampaign().system, {
      id: "cyberpunk-red",
      version: "0.1.0",
    });
    assert.equal(store.getCampaign().id, DEFAULT_CAMPAIGN_ID);
    assert.equal(store.getCampaign().activeSceneId, DEFAULT_SCENE_ID);
    assert.equal(store.listScenes().length, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM campaign_receipts").get()
        ?.count,
      1,
    );
    assert.equal(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'table_state'")
        .get(),
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'command_receipts'",
        )
        .get(),
      undefined,
    );
    const campaignData = JSON.parse(
      String(
        db.prepare("SELECT state_json FROM campaign_records").get()?.state_json,
      ),
    );
    assert.equal(campaignData.tokens, undefined);
    const sceneData = JSON.parse(
      String(
        db.prepare("SELECT state_json FROM scene_records").get()?.state_json,
      ),
    );
    assert.equal(sceneData.notes, undefined);
    assert.deepEqual(sceneData.tokens, state.tokens);
    store.close();
    store = new TableStore(path);
    assert.deepEqual(store.load(), state);
    assert.equal(store.hasCommand(receipt), true);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    store?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("version 4 migration preserves private notes/rolls, ownership, edit versions, and access identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-private-migration-"));
  const path = join(directory, "table.sqlite"),
    db = new DatabaseSync(path);
  const key = "tableloom-legacy-migration-fixture-not-a-real-key";
  const access = new AccessStore(path, key);
  let store: TableStore | undefined;
  try {
    const gm = access.setupHost(key, "GM"),
      player = access.redeemInvitation(
        access.createInvitation(gm.token).token,
        "Player",
      );
    const receipt = randomUUID();
    let state = applyCommand(
      createTable(),
      {
        id: randomUUID(),
        type: "note.add",
        note: {
          id: randomUUID(),
          title: "Private clue",
          body: "Hidden",
          visibility: "gm",
        },
      },
      player.member,
    );
    state = applyCommand(
      state,
      { id: receipt, type: "dice.roll", expression: "d6", visibility: "gm" },
      player.member,
    );
    legacyTables(db, { ...state, schemaVersion: 4 }, receipt, state.revision);
    store = new TableStore(path);
    assert.deepEqual(store.load(), state);
    assert.deepEqual(access.authenticate(player.token), player.member);
    assert.deepEqual(access.authenticate(gm.token), gm.member);
    assert.equal(
      projectTable(store.load(), player.member).notes[0]?.ownerId,
      player.member.id,
    );
    const other = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Other",
    );
    assert.equal(projectTable(store.load(), other.member).notes.length, 0);
    assert.equal(projectTable(store.load(), other.member).rolls.length, 0);
    assert.equal(store.hasCommand(receipt), true);
  } finally {
    store?.close();
    access.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed legacy conversion rolls back both new storage and the original scene/receipts", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "tableloom-migration-rollback-"),
  );
  const path = join(directory, "table.sqlite"),
    db = new DatabaseSync(path);
  try {
    const state = { ...createTable(), revision: 8 },
      receipt = randomUUID();
    legacyTables(db, state, receipt, 9); // Corrupt receipt fails after the campaign/scene inserts.
    assert.throws(() => new TableStore(path));
    assert.deepEqual(
      JSON.parse(
        String(db.prepare("SELECT json FROM table_state").get()?.json),
      ),
      state,
    );
    assert.equal(
      db.prepare("SELECT revision FROM command_receipts").get()?.revision,
      9,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'campaign_records'",
        )
        .get(),
      undefined,
    );
    db.prepare("UPDATE command_receipts SET revision = 8").run();
    db.prepare("UPDATE table_state SET json = ?").run(
      JSON.stringify({ ...state, schemaVersion: 99 }),
    );
    assert.throws(() => new TableStore(path));
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'campaign_storage_version'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()?.count,
      1,
    );
    db.prepare("UPDATE table_state SET json = ?").run(JSON.stringify(state));
    const store = new TableStore(path);
    assert.deepEqual(store.load(), state);
    assert.equal(store.hasCommand(receipt), true);
    store.close();
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
