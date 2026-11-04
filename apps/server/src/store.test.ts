import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTable } from "@tableloom/core";
import { TableStore } from "./store.js";

test("loading a version 1 database durably migrates ownership without adding revisions or receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-migrate-"));
  const path = join(directory, "table.sqlite");
  const db = new DatabaseSync(path);
  let store = new TableStore(path);
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
    const receipt = randomUUID();
    db.prepare("INSERT INTO table_state (id, json) VALUES (1, ?)").run(
      JSON.stringify(legacy),
    );
    db.prepare("INSERT INTO command_receipts (id, revision) VALUES (?, 8)").run(
      receipt,
    );
    const state = store.load();
    assert.equal(state.tokens[0]?.ownerId, null);
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.revision, 8);
    assert.deepEqual(
      JSON.parse(
        String(
          db.prepare("SELECT json FROM table_state WHERE id = 1").get()?.json,
        ),
      ),
      state,
    );
    assert.equal(store.hasCommand(receipt), true);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()?.count,
      1,
    );
    store.close();
    store = new TableStore(path);
    assert.deepEqual(store.load(), state);
  } finally {
    store.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
