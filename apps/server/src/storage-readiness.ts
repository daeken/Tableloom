import { existsSync } from "node:fs";
import { join } from "node:path";
export const BACKUP_MANIFEST = "tableloom-backup.json";
export const BACKUP_INCOMPLETE = ".tableloom-backup-in-progress";
export const RESTORE_INCOMPLETE = ".tableloom-restore-in-progress";
/** Never initialize a table in an archive or a partly restored directory. */
export function assertDataDirectoryReady(path: string) {
  if (
    [BACKUP_MANIFEST, BACKUP_INCOMPLETE, RESTORE_INCOMPLETE].some((name) =>
      existsSync(join(path, name)),
    )
  )
    throw new Error(
      "This is a backup or incomplete recovery directory. Restore into a new data directory before starting Tableloom.",
    );
}
