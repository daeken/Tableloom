import type { DatabaseSync } from "node:sqlite";

export type DestinationReadMode = "independent" | "existing";
/** Only trusted synchronous services may borrow an already owned transaction. */
export function destinationSnapshot<T>(
  db: DatabaseSync,
  read: () => T,
  mode: DestinationReadMode = "independent",
): T {
  if (mode === "existing") {
    if (!db.isTransaction)
      throw new Error("An existing destination transaction is required.");
    return read();
  }
  if (db.isTransaction)
    throw new Error("This operation needs its own destination read snapshot.");
  db.exec("BEGIN");
  try {
    const result = read();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

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
