import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  mkdir,
  readdir,
  lstat,
  chmod,
  unlink,
  rmdir,
  realpath,
} from "node:fs/promises";
import { join, resolve, dirname, relative, sep, isAbsolute } from "node:path";
import { z } from "zod";
import { readHostKeyFile } from "./host-key.js";
import {
  BACKUP_MANIFEST,
  BACKUP_INCOMPLETE,
  RESTORE_INCOMPLETE,
  assertDataDirectoryReady,
} from "./storage-readiness.js";
const DB = "tableloom.sqlite",
  KEY = "host-key",
  MAX_DB = 64 * 1024 ** 3;
const fingerprintSchema = z
  .object({
    bytes: z.number().int().min(1).max(MAX_DB),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const backupManifestSchema = z
  .object({
    format: z.literal("tableloom-backup"),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    nodeVersion: z
      .string()
      .max(64)
      .regex(/^\d+\.\d+\.\d+$/),
    keySource: z.enum(["file", "environment"]),
    database: fingerprintSchema,
    hostKey: fingerprintSchema
      .extend({ bytes: z.number().int().min(32).max(2048) })
      .strict(),
  })
  .strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;
async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function regular(path: string, max = MAX_DB) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > max)
      throw new Error("Backup input is not a bounded regular file.");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function fingerprint(path: string, max = MAX_DB) {
  const handle = await regular(path, max);
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > max) throw new Error("Backup input exceeds its limit.");
      hash.update(chunk);
    }
    return fingerprintSchema.parse({ bytes, sha256: hash.digest("hex") });
  } finally {
    await handle.close();
  }
}
async function writePrivate(path: string, data: string, owned: string[]) {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  owned.push(path);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function copyPrivate(
  source: string,
  target: string,
  owned: string[],
  max = MAX_DB,
) {
  const input = await regular(source, max);
  try {
    const output = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    owned.push(target);
    try {
      let bytes = 0;
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > max) throw new Error("Backup input grew beyond its limit.");
        await output.writeFile(chunk);
      }
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}
async function cleanup(directory: string, owned: string[], markerName: string) {
  // Keep a durable sentinel if foreign files or failed cleanup prevent removal.
  const marker = join(directory, markerName);
  const handle = await open(
    marker,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  ).catch(() => null);
  if (handle) {
    try {
      await handle.writeFile("Incomplete backup/recovery.\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const path of [...owned].reverse())
    if (path !== marker) await unlink(path).catch(() => {});
  const entries = await readdir(directory).catch(() => null);
  if (entries && entries.every((name) => name === markerName)) {
    await unlink(marker).catch(() => {});
    await rmdir(directory).catch(() => {});
  } else await syncDirectory(directory).catch(() => {});
}
async function validateDatabase(path: string) {
  // Standalone rollback-journal files only: ignore no unverified WAL/SHM sidecars.
  const input = await regular(path);
  try {
    const header = Buffer.alloc(100);
    const result = await input.read(header, 0, 100, 0);
    if (
      result.bytesRead !== 100 ||
      header.subarray(0, 16).toString() !== "SQLite format 3\0" ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      throw new Error("Backup database is not a standalone SQLite snapshot.");
  } finally {
    await input.close();
  }
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    const checks = db.prepare("PRAGMA integrity_check").all();
    if (
      checks.length !== 1 ||
      checks[0]?.integrity_check !== "ok" ||
      db.prepare("SELECT 1 FROM pragma_foreign_key_check LIMIT 1").get()
    )
      throw new Error("Backup database integrity checks failed.");
    for (const name of [
      "campaign_records",
      "scene_records",
      "access_users",
      "campaign_storage_version",
      "access_storage_version",
    ])
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name)
      )
        throw new Error(
          "Backup does not contain an initialized Tableloom database.",
        );
  } finally {
    db.close();
  }
}
function matches(
  actual: z.infer<typeof fingerprintSchema>,
  expected: z.infer<typeof fingerprintSchema>,
) {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
    throw new Error("Backup checksum or byte count does not match.");
}
export async function verifyBackup(directory: string): Promise<BackupManifest> {
  directory = resolve(directory);
  const entries = await readdir(directory);
  if (
    entries.length !== 3 ||
    ![BACKUP_MANIFEST, DB, KEY].every((name) => entries.includes(name))
  )
    throw new Error(
      "Backup directory is incomplete or contains unexpected files.",
    );
  const file = await regular(join(directory, BACKUP_MANIFEST), 32768);
  let manifest: BackupManifest;
  try {
    manifest = backupManifestSchema.parse(
      JSON.parse(await file.readFile("utf8")),
    );
  } finally {
    await file.close();
  }
  matches(await fingerprint(join(directory, DB)), manifest.database);
  matches(await fingerprint(join(directory, KEY), 2048), manifest.hostKey);
  readHostKeyFile(join(directory, KEY));
  await validateDatabase(join(directory, DB));
  return manifest;
}
/** Online SQLite snapshot. Only a newly reserved output directory is ever written. */
export async function createBackup(input: {
  source: string;
  destination: string;
  hostKey?: string;
}): Promise<BackupManifest> {
  const source = resolve(input.source),
    destination = resolve(input.destination);
  assertDataDirectoryReady(source);
  // Never create a missing source database or recovery key.
  const databaseInfo = await lstat(join(source, DB));
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink())
    throw new Error("Source database must be a regular file.");
  const supplied = input.hostKey !== undefined;
  const key = supplied
    ? z.string().min(32).max(512).parse(input.hostKey)
    : readHostKeyFile(join(source, KEY));
  if (key.trim() !== key)
    throw new Error(
      "Configured key cannot have surrounding whitespace for file-based recovery.",
    );
  const db = new DatabaseSync(join(source, DB), {
    readOnly: true,
    allowExtension: false,
  });
  const owned: string[] = [];
  let reserved = false;
  try {
    db.exec("BEGIN");
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    const pages = Number(db.prepare("PRAGMA page_count").get()?.page_count),
      size = Number(db.prepare("PRAGMA page_size").get()?.page_size);
    if (
      !Number.isSafeInteger(pages) ||
      !Number.isSafeInteger(size) ||
      pages * size > MAX_DB
    )
      throw new Error("Database exceeds the backup size limit.");
    await mkdir(destination, { mode: 0o700 });
    reserved = true;
    await writePrivate(
      join(destination, BACKUP_INCOMPLETE),
      "Backup is incomplete.\n",
      owned,
    );
    await syncDirectory(destination);
    await syncDirectory(dirname(destination));
    await writePrivate(join(destination, DB), "", owned);
    await sqliteBackup(db, join(destination, DB), { rate: 128 });
    db.exec("ROLLBACK");
    const snapshot = new DatabaseSync(join(destination, DB), {
      allowExtension: false,
    });
    try {
      snapshot.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    } finally {
      snapshot.close();
    }
    await chmod(join(destination, DB), 0o600);
    const durable = await open(join(destination, DB), constants.O_RDONLY);
    try {
      await durable.sync();
    } finally {
      await durable.close();
    }
    await validateDatabase(join(destination, DB));
    if (!supplied && readHostKeyFile(join(source, KEY)) !== key)
      throw new Error(
        "The host key changed during backup. Retry with stable configuration.",
      );
    await writePrivate(join(destination, KEY), key, owned);
    const manifest = backupManifestSchema.parse({
      format: "tableloom-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      nodeVersion: process.versions.node,
      keySource: supplied ? "environment" : "file",
      database: await fingerprint(join(destination, DB)),
      hostKey: await fingerprint(join(destination, KEY), 2048),
    });
    await writePrivate(
      join(destination, BACKUP_MANIFEST),
      JSON.stringify(manifest, null, 2) + "\n",
      owned,
    );
    await syncDirectory(destination);
    await unlink(join(destination, BACKUP_INCOMPLETE));
    await syncDirectory(destination);
    await syncDirectory(dirname(destination));
    return manifest;
  } catch (error) {
    if (reserved) await cleanup(destination, owned, BACKUP_INCOMPLETE);
    throw error;
  } finally {
    db.close();
  }
}
/** Restore is deliberately non-destructive: the destination must not exist, even empty. */
export async function restoreBackup(input: {
  source: string;
  destination: string;
}): Promise<BackupManifest> {
  const source = resolve(input.source),
    destination = resolve(input.destination),
    manifest = await verifyBackup(source),
    owned: string[] = [];
  const sourcePath = await realpath(source),
    parentPath = await realpath(dirname(destination)),
    inside = relative(sourcePath, parentPath);
  if (
    inside === "" ||
    (inside !== ".." && !inside.startsWith(".." + sep) && !isAbsolute(inside))
  )
    throw new Error("Recovery destination must be outside the backup archive.");
  await mkdir(destination, { mode: 0o700 });
  try {
    await writePrivate(
      join(destination, RESTORE_INCOMPLETE),
      "Recovery is incomplete.\n",
      owned,
    );
    await syncDirectory(destination);
    await syncDirectory(dirname(destination));
    await copyPrivate(join(source, DB), join(destination, DB), owned);
    await copyPrivate(join(source, KEY), join(destination, KEY), owned, 2048);
    matches(await fingerprint(join(destination, DB)), manifest.database);
    matches(await fingerprint(join(destination, KEY), 2048), manifest.hostKey);
    await validateDatabase(join(destination, DB));
    readHostKeyFile(join(destination, KEY));
    await syncDirectory(destination);
    await unlink(join(destination, RESTORE_INCOMPLETE));
    await syncDirectory(destination);
    await syncDirectory(dirname(destination));
    return manifest;
  } catch (error) {
    await cleanup(destination, owned, RESTORE_INCOMPLETE);
    throw error;
  }
}
