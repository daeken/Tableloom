import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyCommand } from "@tableloom/core/server";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { DocumentStore } from "./documents.js";
import { RollHistoryStore } from "./roll-history.js";
import { CommandBindings } from "./command-bindings.js";

const KEY = "tableloom-object-upgrade-fixture-not-a-real-key";
function fixture() {
  const db = new DatabaseSync(":memory:"),
    store = new TableStore(db),
    access = new AccessStore(db, KEY);
  const gm = access.setupHost(KEY, "GM"),
    player = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Player",
    );
  const defaultId = gm.member.tableId,
    offstage = store.createScene(defaultId, { name: "Unrevealed scene" }),
    other = store.createCampaign({
      name: "Another campaign",
      description: "",
      system: { id: "kids-on-bikes", version: "0.1.0" },
      contentPacks: [],
    });
  function seed(campaignId: string) {
    const tokenId = crypto.randomUUID(),
      id = crypto.randomUUID();
    store.save(
      applyCommand(
        store.load(campaignId),
        {
          id,
          type: "token.add",
          token: {
            id: tokenId,
            name: "Preserved token",
            position: { x: 10, y: 20 },
            color: "#405f4d",
          },
        },
        player.member,
      ),
      id,
      campaignId,
    );
    return tokenId;
  }
  const tokenId = seed(defaultId);
  const metadata = store.getCampaign();
  store.activateScene(defaultId, offstage.id, metadata.version);
  seed(defaultId);
  store.activateScene(
    defaultId,
    metadata.activeSceneId,
    store.getCampaign().version,
  );
  seed(other.id);
  const rollId = crypto.randomUUID();
  store.save(
    applyCommand(
      store.load(),
      { id: rollId, type: "dice.roll", expression: "d6", visibility: "gm" },
      player.member,
    ),
    rollId,
  );
  const noteId = crypto.randomUUID();
  store.save(
    applyCommand(
      store.load(),
      {
        id: noteId,
        type: "note.add",
        note: {
          id: crypto.randomUUID(),
          title: "Preserved private clue",
          body: "Private body",
          visibility: "gm",
        },
      },
      player.member,
    ),
    noteId,
  );
  const documents = new DocumentStore(db, store);
  documents.create(player.member, {
    title: "Provisional sheet",
    system: { id: "cyberpunk-red", version: "0.1.0" },
  });
  const archives = new RollHistoryStore(db, store);
  archives.change(
    player.member,
    { ids: [store.load().rolls[0]!.id] },
    "archive",
  );
  const bindings = new CommandBindings(db);
  bindings.bind(player.member.id, {
    context: {
      campaignId: defaultId,
      sceneId: store.getCampaign().activeSceneId,
      generation: store.getCampaign().version,
    },
    command: {
      id: noteId,
      type: "note.add",
      note: {
        id: store.load().notes[0]!.id,
        title: "Preserved private clue",
        body: "Private body",
        visibility: "gm",
      },
    },
  });
  return { db, store, access, gm, player, defaultId, offstage, other, tokenId };
}
function downgradeFixture(db: DatabaseSync) {
  for (const row of db
    .prepare("SELECT id,state_json FROM campaign_records")
    .all()) {
    const data = JSON.parse(String(row.state_json));
    db.prepare("UPDATE campaign_records SET state_json = ? WHERE id = ?").run(
      JSON.stringify({ ...data, schemaVersion: 4 }),
      row.id!,
    );
  }
  for (const row of db
    .prepare("SELECT campaign_id,id,state_json FROM scene_records")
    .all()) {
    const data = JSON.parse(String(row.state_json));
    for (const object of [...data.tokens, ...data.drawings])
      delete object.version;
    db.prepare(
      "UPDATE scene_records SET state_json = ? WHERE campaign_id = ? AND id = ?",
    ).run(JSON.stringify(data), row.campaign_id!, row.id!);
  }
  db.exec("UPDATE campaign_storage_version SET version=1");
}
const capture = (db: DatabaseSync) => ({
  campaigns: db.prepare("SELECT * FROM campaign_records ORDER BY id").all(),
  scenes: db
    .prepare("SELECT * FROM scene_records ORDER BY campaign_id,id")
    .all(),
  version: db.prepare("SELECT * FROM campaign_storage_version").all(),
});

test("campaign storage 1 upgrades every active/offstage/other-campaign object atomically, preserving access, private content, documents, archives, and receipts", () => {
  const { db, store, gm, player, offstage, other, tokenId } = fixture();
  try {
    const state = store.load(),
      metadata = store.getCampaign(),
      offstageMetadata = store.getScene(gm.member.tableId, offstage.id),
      otherMetadata = store.getCampaign(other.id);
    const tables = [
      "campaign_receipts",
      "command_bindings",
      "access_users",
      "access_memberships",
      "access_sessions",
      "module_documents",
      "roll_archive",
    ];
    const preserved = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
    downgradeFixture(db);
    const upgraded = new TableStore(db);
    assert.deepEqual(upgraded.load(), state);
    assert.deepEqual(upgraded.getCampaign(), metadata);
    assert.deepEqual(upgraded.getCampaign(other.id), otherMetadata);
    assert.deepEqual(
      upgraded.getScene(gm.member.tableId, offstage.id),
      offstageMetadata,
    );
    assert.equal(
      db.prepare("SELECT version FROM campaign_storage_version").get()?.version,
      2,
    );
    for (const row of db.prepare("SELECT state_json FROM scene_records").all())
      for (const object of JSON.parse(String(row.state_json)).tokens)
        assert.equal(object.version, 1);
    tables.forEach((table, index) =>
      assert.deepEqual(
        db.prepare(`SELECT * FROM ${table}`).all(),
        preserved[index],
      ),
    );
    const before = capture(db);
    new TableStore(db);
    assert.deepEqual(capture(db), before);
    const id = crypto.randomUUID();
    upgraded.save(
      applyCommand(
        upgraded.load(),
        {
          id,
          type: "token.move",
          tokenId,
          expectedVersion: 1,
          position: { x: 50, y: 60 },
        },
        player.member,
      ),
      id,
    );
    assert.equal(new TableStore(db).load().tokens[0]?.version, 2);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
  }
});

test("failed version upgrades preserve all rows and marker; malformed hidden scenes and incomplete current saves fail closed", () => {
  const { db, offstage, defaultId } = fixture();
  try {
    downgradeFixture(db);
    const before = capture(db);
    db.exec(
      "CREATE TRIGGER reject_scene_upgrade BEFORE UPDATE ON campaign_records BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    assert.throws(() => new TableStore(db));
    assert.deepEqual(capture(db), before);
    db.exec("DROP TRIGGER reject_scene_upgrade");
    const row = db
      .prepare("SELECT state_json FROM scene_records WHERE id=?")
      .get(offstage.id)!;
    const data = JSON.parse(String(row.state_json));
    data.tokens[0].position.x = "invalid";
    db.prepare("UPDATE scene_records SET state_json=? WHERE id=?").run(
      JSON.stringify(data),
      offstage.id,
    );
    const invalid = capture(db);
    assert.throws(() => new TableStore(db));
    assert.deepEqual(capture(db), invalid);
    db.prepare("UPDATE scene_records SET state_json=? WHERE id=?").run(
      String(row.state_json),
      offstage.id,
    );
    const upgraded = new TableStore(db);
    assert.equal(upgraded.load().schemaVersion, 5);
    const active = upgraded.getCampaign().activeSceneId;
    const activeRow = db
      .prepare(
        "SELECT state_json FROM scene_records WHERE campaign_id=? AND id=?",
      )
      .get(defaultId, active)!;
    const incomplete = JSON.parse(String(activeRow.state_json));
    delete incomplete.tokens[0].version;
    db.prepare(
      "UPDATE scene_records SET state_json=? WHERE campaign_id=? AND id=?",
    ).run(JSON.stringify(incomplete), defaultId, active);
    assert.throws(() => new TableStore(db).load());
    assert.equal(
      db.prepare("SELECT version FROM campaign_storage_version").get()?.version,
      2,
    );
    db.exec("UPDATE campaign_storage_version SET version=99");
    assert.throws(() => new TableStore(db));
  } finally {
    db.close();
  }
});

test("empty and orphaned legacy scene storage cannot advance its schema marker", () => {
  for (const orphan of [false, true]) {
    const db = new DatabaseSync(":memory:");
    new TableStore(db);
    downgradeFixture(db);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      if (orphan)
        db.prepare(
          "INSERT INTO scene_records(campaign_id,id,json,state_json) VALUES (?,?,?,?)",
        ).run(
          crypto.randomUUID(),
          crypto.randomUUID(),
          "{}",
          JSON.stringify({ tokens: [], drawings: [] }),
        );
      else db.exec("DELETE FROM scene_records; DELETE FROM campaign_records;");
      db.exec("PRAGMA foreign_keys = ON");
      const before = capture(db);
      assert.throws(() => new TableStore(db));
      assert.deepEqual(capture(db), before);
    } finally {
      db.close();
    }
  }
});
