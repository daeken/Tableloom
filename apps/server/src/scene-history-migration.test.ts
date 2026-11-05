import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { applyCommand } from "@tableloom/core/server";
import type { Command } from "@tableloom/core";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { CommandBindings } from "./command-bindings.js";
import { SceneHistoryStore } from "./scene-history.js";
import { transaction } from "./database.js";
const KEY = "tableloom-history-migration-test-key";
function legacy() {
  const db = new DatabaseSync(":memory:"),
    tables = new TableStore(db),
    access = new AccessStore(db, KEY),
    host = access.setupHost(KEY, "GM");
  const bindings = new CommandBindings(db);
  db.exec(`CREATE TABLE scene_move_history (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,scene_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES access_users(id),token_id TEXT NOT NULL,
    previous_id TEXT REFERENCES scene_move_history(id) ON DELETE SET NULL,state TEXT NOT NULL CHECK(state IN ('done','undone')),version INTEGER NOT NULL CHECK(version>0),expected_token_version INTEGER NOT NULL CHECK(expected_token_version>0),from_json TEXT NOT NULL,to_json TEXT NOT NULL,
    FOREIGN KEY(campaign_id,scene_id) REFERENCES scene_records(campaign_id,id));
    CREATE INDEX scene_history_member ON scene_move_history(campaign_id,scene_id,actor_id,sequence);
    CREATE TABLE scene_history_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO scene_history_version VALUES(1,1);`);
  const run = (command: Command) =>
    tables.save(applyCommand(tables.load(), command, host.member), command.id);
  const tokenId = randomUUID();
  run({
    id: randomUUID(),
    type: "token.add",
    token: {
      id: tokenId,
      name: "Migrated",
      position: { x: 0, y: 0 },
      color: "#405f4d",
    },
  });
  const first: Command = {
    id: randomUUID(),
    type: "token.move",
    tokenId,
    expectedVersion: 1,
    position: { x: 10, y: 0 },
  };
  run(first);
  run({
    ...first,
    id: randomUUID(),
    expectedVersion: 2,
    position: { x: 20, y: 0 },
  });
  run({ ...first, id: randomUUID(), expectedVersion: 3 });
  run({
    id: randomUUID(),
    type: "note.add",
    note: {
      id: randomUUID(),
      title: "Private saved note",
      body: "Preserved secret",
      visibility: "gm",
    },
  });
  run({
    id: randomUUID(),
    type: "dice.roll",
    expression: "3d17",
    visibility: "gm",
  });
  const campaign = tables.getCampaign(),
    context = {
      campaignId: campaign.id,
      sceneId: campaign.activeSceneId,
      generation: campaign.version,
    };
  bindings.bind(host.member.id, { context, command: first });
  const a = randomUUID(),
    b = randomUUID(),
    insert = db.prepare(
      "INSERT INTO scene_move_history(id,campaign_id,scene_id,actor_id,token_id,previous_id,state,version,expected_token_version,from_json,to_json) VALUES(?,?,?,?,?,?,?,2,4,?,?)",
    );
  insert.run(
    a,
    campaign.id,
    campaign.activeSceneId,
    host.member.id,
    tokenId,
    null,
    "done",
    '{"x":0,"y":0}',
    '{"x":10,"y":0}',
  );
  insert.run(
    b,
    campaign.id,
    campaign.activeSceneId,
    host.member.id,
    tokenId,
    a,
    "undone",
    '{"x":10,"y":0}',
    '{"x":20,"y":0}',
  );
  const hidden = tables.createScene(campaign.id, { name: "Hidden scene" });
  insert.run(
    randomUUID(),
    campaign.id,
    hidden.id,
    host.member.id,
    randomUUID(),
    null,
    "done",
    '{"x":0,"y":0}',
    '{"x":10,"y":0}',
  );
  return { db, tables, access, host, bindings, first, context, a, b };
}

test("move-history 1 to scene-history 8 preserves IDs, cursors, links, active/offstage rows, receipts, private state and access", () => {
  const f = legacy();
  try {
    const before = f.tables.load(),
      rows = f.db
        .prepare("SELECT * FROM scene_move_history ORDER BY sequence")
        .all();
    const history = new SceneHistoryStore(f.db, f.tables);
    assert.equal(
      f.db.prepare("SELECT version FROM scene_history_version").get()!.version,
      12,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='scene_move_history'",
        )
        .get(),
      undefined,
    );
    const migrated = f.db
      .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
      .all();
    assert.equal(migrated.length, rows.length);
    for (let i = 0; i < rows.length; i++) {
      const old = rows[i]!,
        next = migrated[i]!;
      for (const key of [
        "id",
        "sequence",
        "campaign_id",
        "scene_id",
        "actor_id",
        "state",
        "version",
      ])
        assert.equal(next[key], old[key]);
      const target = JSON.parse(String(next.targets_json))[0];
      assert.equal(target.objectId, old.token_id);
      assert.equal(target.expectedVersion, old.expected_token_version);
      assert.equal(target.previousId, old.previous_id);
      assert.deepEqual(JSON.parse(String(next.payload_json)), {
        kind: "move",
        objectType: "token",
        before: JSON.parse(String(old.from_json)),
        after: JSON.parse(String(old.to_json)),
      });
    }
    assert.deepEqual(f.tables.load(), before);
    assert.equal(f.access.authenticate(f.host.token)!.id, f.host.member.id);
    assert.ok(
      f.bindings.matches(f.host.member.id, {
        context: f.context,
        command: f.first,
      }),
    );
    assert.ok(f.tables.hasCommand(f.first.id));
    assert.equal(history.status(f.host.member).undo!.id, f.a);
    assert.equal(history.status(f.host.member).redo!.id, f.b);
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.host.member),
      history.status(f.host.member),
    );
    transaction(f.db, () => {
      const cursor = history.status(f.host.member).redo!,
        command = {
          id: randomUUID(),
          type: "scene.redo" as const,
          historyId: cursor.id,
          expectedVersion: cursor.version,
        };
      f.tables.save(
        history.apply(f.host.member, f.tables.load(), command),
        command.id,
      );
    });
    assert.equal(f.tables.load().tokens[0]!.version, 5);
    assert.equal(f.tables.load().tokens[0]!.position.x, 20);
  } finally {
    f.db.close();
  }
});

test("history migration SQL failure rolls back the table replacement, copied rows, and schema marker", () => {
  const f = legacy();
  try {
    const rows = f.db
        .prepare("SELECT * FROM scene_move_history ORDER BY sequence")
        .all(),
      before = f.tables.load();
    f.db.exec(
      "CREATE TRIGGER reject_history_upgrade BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END;",
    );
    assert.throws(
      () => new SceneHistoryStore(f.db, f.tables),
      /fixture migration failure/,
    );
    assert.equal(
      f.db.prepare("SELECT version FROM scene_history_version").get()!.version,
      1,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='scene_history_entries'",
        )
        .get(),
      undefined,
    );
    assert.deepEqual(
      f.db.prepare("SELECT * FROM scene_move_history ORDER BY sequence").all(),
      rows,
    );
    assert.deepEqual(f.tables.load(), before);
    f.db.exec("DROP TRIGGER reject_history_upgrade");
    new SceneHistoryStore(f.db, f.tables);
    assert.equal(
      f.db.prepare("SELECT version FROM scene_history_version").get()!.version,
      12,
    );
  } finally {
    f.db.close();
  }
});

test("malformed legacy inverse geometry or cross-object causal links abort migration without partial rows", () => {
  for (const kind of ["geometry", "link"]) {
    const f = legacy();
    try {
      if (kind === "geometry")
        f.db
          .prepare("UPDATE scene_move_history SET to_json=? WHERE id=?")
          .run('{"x":50000,"y":0}', f.b);
      else
        f.db
          .prepare("UPDATE scene_move_history SET token_id=? WHERE id=?")
          .run(randomUUID(), f.b);
      assert.throws(() => new SceneHistoryStore(f.db, f.tables));
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        1,
      );
      assert.equal(
        f.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='scene_history_entries'",
          )
          .get(),
        undefined,
      );
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM scene_move_history").get()!.n,
        3,
      );
    } finally {
      f.db.close();
    }
  }
});

function toVersionTwo(f: ReturnType<typeof legacy>) {
  const history = new SceneHistoryStore(f.db, f.tables),
    status = history.status(f.host.member);
  const rows = f.db
    .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
    .all();
  f.db.exec(`CREATE TABLE scene_edit_history (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,scene_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES access_users(id),object_id TEXT NOT NULL,
    previous_id TEXT REFERENCES scene_edit_history(id) ON DELETE SET NULL,state TEXT NOT NULL CHECK(state IN ('done','undone')),version INTEGER NOT NULL CHECK(version>0),expected_object_version INTEGER NOT NULL CHECK(expected_object_version>0),payload_json TEXT NOT NULL,
    FOREIGN KEY(campaign_id,scene_id) REFERENCES scene_records(campaign_id,id));`);
  const insert = f.db.prepare(
    "INSERT INTO scene_edit_history(sequence,id,campaign_id,scene_id,actor_id,object_id,previous_id,state,version,expected_object_version,payload_json) VALUES(?,?,?,?,?,?,NULL,?,?,?,?)",
  );
  for (const row of rows) {
    const target = JSON.parse(String(row.targets_json))[0];
    insert.run(
      row.sequence!,
      row.id!,
      row.campaign_id!,
      row.scene_id!,
      row.actor_id!,
      target.objectId,
      row.state!,
      row.version!,
      target.expectedVersion,
      row.payload_json!,
    );
  }
  for (const row of rows) {
    const target = JSON.parse(String(row.targets_json))[0];
    f.db
      .prepare("UPDATE scene_edit_history SET previous_id=? WHERE id=?")
      .run(target.previousId, row.id!);
  }
  f.db.exec(
    "DROP TABLE scene_history_entries; UPDATE scene_history_version SET version=2",
  );
  return { status, rows };
}

test("scene history 2 to 8 preserves existing payloads, reservations and per-object causal targets without inventing group edits", () => {
  const f = legacy();
  try {
    const before = f.tables.load(),
      { status, rows } = toVersionTwo(f),
      reservations = f.db
        .prepare("SELECT * FROM object_id_reservations ORDER BY campaign_id,id")
        .all();
    const history = new SceneHistoryStore(f.db, f.tables);
    assert.deepEqual(history.status(f.host.member), status);
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      rows,
    );
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM object_id_reservations ORDER BY campaign_id,id")
        .all(),
      reservations,
    );
    assert.equal(
      f.db.prepare("SELECT version FROM scene_history_version").get()!.version,
      12,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='scene_edit_history'",
        )
        .get(),
      undefined,
    );
  } finally {
    f.db.close();
  }
});

test("failed schema-2 history upgrade keeps the original entries and marker for a safe retry", () => {
  const f = legacy();
  try {
    const { status } = toVersionTwo(f),
      rows = f.db
        .prepare("SELECT * FROM scene_edit_history ORDER BY sequence")
        .all();
    f.db.exec(
      "CREATE TRIGGER reject_v3 BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture v3 failure'); END;",
    );
    assert.throws(
      () => new SceneHistoryStore(f.db, f.tables),
      /fixture v3 failure/,
    );
    assert.deepEqual(
      f.db.prepare("SELECT * FROM scene_edit_history ORDER BY sequence").all(),
      rows,
    );
    assert.equal(
      f.db.prepare("SELECT version FROM scene_history_version").get()!.version,
      2,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='scene_history_entries'",
        )
        .get(),
      undefined,
    );
    f.db.exec("DROP TRIGGER reject_v3");
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.host.member),
      status,
    );
  } finally {
    f.db.close();
  }
});

function versionThree(f: ReturnType<typeof legacy>) {
  const history = new SceneHistoryStore(f.db, f.tables),
    tokenId = crypto.randomUUID();
  const run = (command: Command) =>
    transaction(f.db, () => {
      const before = f.tables.load(),
        next = applyCommand(before, command, f.host.member);
      history.record(f.host.member, before, next, command);
      f.tables.save(next, command.id);
    });
  run({
    id: randomUUID(),
    type: "token.add",
    token: {
      id: tokenId,
      name: "Second",
      position: { x: 50, y: 60 },
      color: "#405f4d",
    },
  });
  run({
    id: randomUUID(),
    type: "tokens.move",
    moves: f.tables.load().tokens.map((token) => ({
      tokenId: token.id,
      expectedVersion: token.version,
      position: { x: token.position.x + 10, y: token.position.y + 20 },
    })),
  });
  const status = history.status(f.host.member);
  f.db.exec("UPDATE scene_history_version SET version=3");
  return status;
}

test("scene history 3 to 8 preserves token groups, expired predecessor links, saved state and reservation IDs", () => {
  const f = legacy();
  try {
    const status = versionThree(f),
      before = f.tables.load();
    const target = JSON.parse(
      String(
        f.db
          .prepare("SELECT targets_json FROM scene_history_entries WHERE id=?")
          .get(f.a)!.targets_json,
      ),
    );
    target[0].previousId = randomUUID();
    f.db
      .prepare("UPDATE scene_history_entries SET targets_json=? WHERE id=?")
      .run(JSON.stringify(target), f.a);
    const rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      reserved = f.db
        .prepare("SELECT * FROM object_id_reservations ORDER BY campaign_id,id")
        .all();
    const history = new SceneHistoryStore(f.db, f.tables);
    assert.deepEqual(history.status(f.host.member), status);
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      rows,
    );
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM object_id_reservations ORDER BY campaign_id,id")
        .all(),
      reserved,
    );
    assert.equal(
      f.db.prepare("SELECT version FROM scene_history_version").get()!.version,
      12,
    );
  } finally {
    f.db.close();
  }
});

test("failed schema-3 marker writes and malformed causal links leave the old history intact", () => {
  for (const failure of ["sql", "link"]) {
    const f = legacy();
    try {
      versionThree(f);
      if (failure === "sql")
        f.db.exec(
          "CREATE TRIGGER reject_v4 BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture v4 failure'); END;",
        );
      else {
        const target = JSON.parse(
          String(
            f.db
              .prepare(
                "SELECT targets_json FROM scene_history_entries WHERE id=?",
              )
              .get(f.a)!.targets_json,
          ),
        );
        target[0].previousId = f.db
          .prepare(
            "SELECT id FROM scene_history_entries ORDER BY sequence DESC LIMIT 1",
          )
          .get()!.id;
        f.db
          .prepare("UPDATE scene_history_entries SET targets_json=? WHERE id=?")
          .run(JSON.stringify(target), f.a);
      }
      const rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
      assert.throws(() => new SceneHistoryStore(f.db, f.tables));
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        3,
      );
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        rows,
      );
      if (failure === "sql") {
        f.db.exec("DROP TRIGGER reject_v4");
        new SceneHistoryStore(f.db, f.tables);
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          12,
        );
      }
    } finally {
      f.db.close();
    }
  }
});

function versionFour(f: ReturnType<typeof legacy>) {
  const history = new SceneHistoryStore(f.db, f.tables),
    drawingId = randomUUID();
  const run = (command: Command) =>
    transaction(f.db, () => {
      const before = f.tables.load(),
        next = applyCommand(before, command, f.host.member);
      history.record(f.host.member, before, next, command);
      f.tables.save(next, command.id);
    });
  run({
    id: randomUUID(),
    type: "drawing.add",
    drawing: {
      id: drawingId,
      kind: "stroke",
      points: [
        { x: 0.1, y: 0.2 },
        { x: 10.3, y: 20.4 },
      ],
      color: "#405f4d",
    },
  });
  const token = f.tables.load().tokens[0]!;
  run({
    id: randomUUID(),
    type: "objects.move",
    objects: [
      { objectId: token.id, expectedVersion: token.version },
      { objectId: drawingId, expectedVersion: 1 },
    ],
    delta: { x: 0.2, y: 0.3 },
  });
  const status = history.status(f.host.member);
  f.db.exec("UPDATE scene_history_version SET version=4");
  return status;
}

test("scene history 4 to 8 preserves exact mixed originals, cursors, state and reserved identities", () => {
  const f = legacy();
  try {
    const status = versionFour(f),
      before = f.tables.load(),
      rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      ids = f.db
        .prepare("SELECT * FROM object_id_reservations ORDER BY campaign_id,id")
        .all();
    const history = new SceneHistoryStore(f.db, f.tables);
    assert.deepEqual(history.status(f.host.member), status);
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      rows,
    );
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM object_id_reservations ORDER BY campaign_id,id")
        .all(),
      ids,
    );
    assert.equal(
      f.db.prepare("SELECT version FROM scene_history_version").get()!.version,
      12,
    );
    transaction(f.db, () => {
      const edge = history.status(f.host.member).undo!,
        command = {
          id: randomUUID(),
          type: "scene.undo" as const,
          historyId: edge.id,
          expectedVersion: edge.version,
        };
      f.tables.save(
        history.apply(f.host.member, f.tables.load(), command),
        command.id,
      );
    });
    assert.deepEqual(f.tables.load().drawings[0]!.points, [
      { x: 0.1, y: 0.2 },
      { x: 10.3, y: 20.4 },
    ]);
  } finally {
    f.db.close();
  }
});

test("failed schema-4 marker writes and invalid original geometry leave the old history untouched", () => {
  for (const failure of ["sql", "geometry"]) {
    const f = legacy();
    try {
      versionFour(f);
      if (failure === "sql")
        f.db.exec(
          "CREATE TRIGGER reject_v5 BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture v5 failure'); END;",
        );
      else {
        const row = f.db
            .prepare(
              "SELECT id,payload_json FROM scene_history_entries ORDER BY sequence DESC LIMIT 1",
            )
            .get()!,
          payload = JSON.parse(String(row.payload_json));
        payload.originals[0].position.x = null;
        f.db
          .prepare("UPDATE scene_history_entries SET payload_json=? WHERE id=?")
          .run(JSON.stringify(payload), row.id!);
      }
      const rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
      assert.throws(() => new SceneHistoryStore(f.db, f.tables));
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        4,
      );
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        rows,
      );
      if (failure === "sql") {
        f.db.exec("DROP TRIGGER reject_v5");
        new SceneHistoryStore(f.db, f.tables);
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          12,
        );
      }
    } finally {
      f.db.close();
    }
  }
});

test("schema-5 group history upgrades intact to 8 and marker failure rolls back; resize payloads cannot masquerade as old data", () => {
  for (const failure of ["none", "marker", "future"]) {
    const f = legacy();
    try {
      versionFour(f);
      const history = new SceneHistoryStore(f.db, f.tables),
        before = f.tables.load(),
        command: Command = {
          id: randomUUID(),
          type: "objects.delete",
          objects: [...before.tokens, ...before.drawings].map((d) => ({
            objectId: d.id,
            expectedVersion: d.version,
          })),
        };
      transaction(f.db, () => {
        const after = applyCommand(before, command, f.host.member);
        history.record(f.host.member, before, after, command);
        f.tables.save(after, command.id);
      });
      const status = history.status(f.host.member);
      f.db.exec("UPDATE scene_history_version SET version=5");
      if (failure === "marker")
        f.db.exec(
          "CREATE TRIGGER reject_v6 BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture v6 failure'); END;",
        );
      if (failure === "future")
        f.db
          .prepare("UPDATE scene_history_entries SET payload_json=? WHERE id=?")
          .run(
            JSON.stringify({
              kind: "resize",
              objectType: "drawing",
              before: [
                { x: 0, y: 0 },
                { x: 10, y: 10 },
              ],
              after: [
                { x: 0, y: 0 },
                { x: 20, y: 20 },
              ],
            }),
            status.undo!.id,
          );
      const rows = f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        state = f.tables.load();
      if (failure !== "none") {
        assert.throws(() => new SceneHistoryStore(f.db, f.tables));
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          5,
        );
      } else {
        const upgraded = new SceneHistoryStore(f.db, f.tables);
        assert.deepEqual(upgraded.status(f.host.member), status);
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          12,
        );
      }
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        rows,
      );
      assert.deepEqual(f.tables.load(), state);
    } finally {
      f.db.close();
    }
  }
});
