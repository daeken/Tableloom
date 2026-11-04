import type { DatabaseSync } from "node:sqlite";

let savepointSequence = 0;
/** Synchronous store writes participate in an enclosing service transaction. */
export function transaction<T>(db: DatabaseSync, action: () => T): T {
  const nested = db.isTransaction;
  const savepoint = `tableloom_${++savepointSequence}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    if (nested) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else db.exec("ROLLBACK");
    throw error;
  }
}
