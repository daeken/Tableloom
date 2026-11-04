import { DatabaseSync } from "node:sqlite";
import { createTable, tableSchema } from "@tableloom/core";
import type { TableState } from "@tableloom/core";

export class TableStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS table_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_receipts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);`);
  }
  load(): TableState {
    const row = this.db
      .prepare("SELECT json FROM table_state WHERE id = 1")
      .get();
    return row
      ? tableSchema.parse(JSON.parse(String(row.json)))
      : createTable();
  }
  hasCommand(id: string): boolean {
    return Boolean(
      this.db.prepare("SELECT id FROM command_receipts WHERE id = ?").get(id),
    );
  }
  save(state: TableState, commandId: string): void {
    const json = JSON.stringify(tableSchema.parse(state));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO table_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        )
        .run(json);
      this.db
        .prepare("INSERT INTO command_receipts (id, revision) VALUES (?, ?)")
        .run(commandId, state.revision);
      // Bound retry history; the protocol never automatically replays old commands.
      this.db
        .prepare("DELETE FROM command_receipts WHERE revision < ?")
        .run(Math.max(0, state.revision - 10000));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}
