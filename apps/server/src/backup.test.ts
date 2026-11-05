import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  stat,
  symlink,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createBackup, verifyBackup, restoreBackup } from "./backup.js";
import { loadHostKey } from "./host-key.js";
import { createApp } from "./app.js";
import {
  BACKUP_MANIFEST,
  RESTORE_INCOMPLETE,
  assertDataDirectoryReady,
} from "./storage-readiness.js";
import { jpegFixture } from "./jpeg-fixture.js";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tableloom-backup-")),
    data = join(root, "data");
  await mkdir(data, { mode: 0o700 });
  const key = loadHostKey(data),
    app = await createApp({
      databasePath: join(data, "tableloom.sqlite"),
      hostKey: key,
    });
  return {
    root,
    data,
    key,
    app,
    backup: join(root, "backup"),
    restored: join(root, "restored"),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("online backups include committed WAL and assets; private verified recovery preserves sessions and HTTP data without changing the source", async () => {
  const f = await fixture();
  let restored: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const app = f.app;
    const post = (path: string, body: unknown, cookie = "") =>
      app.inject({
        method: "POST",
        url: path,
        headers: { origin: "http://localhost", cookie },
        payload: body as object,
      });
    const setup = await post("/api/access/setup", {
        key: f.key,
        name: "Backup GM",
      }),
      cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
    const campaign = (
      await app.inject({
        url: `/api/campaigns/${DEFAULT_CAMPAIGN_ID}`,
        headers: { cookie },
      })
    ).json();
    const doc = (
      await post(
        `/api/campaigns/${campaign.id}/documents`,
        { title: "Recovery fixture", system: campaign.system },
        cookie,
      )
    ).json();
    const asset = (
      await app.inject({
        method: "POST",
        url: `/api/campaigns/${campaign.id}/assets?name=Recovery`,
        headers: {
          origin: "http://localhost",
          cookie,
          "content-type": "image/jpeg",
        },
        payload: jpegFixture(16, 16),
      })
    ).json();
    const assetPath = `/api/campaigns/${campaign.id}/assets/${asset.id}/content`,
      assetBytes = (await app.inject({ url: assetPath, headers: { cookie } }))
        .rawPayload;
    const writer = new DatabaseSync(join(f.data, "tableloom.sqlite"));
    writer.exec(
      "PRAGMA wal_autocheckpoint=0; CREATE TABLE backup_test_pairs(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER); INSERT INTO backup_test_pairs VALUES(1,7,7)",
    );
    try {
      const manifest = await createBackup({
        source: f.data,
        destination: f.backup,
      });
      assert.equal(manifest.version, 1);
      assert.equal(manifest.keySource, "file");
      assert.deepEqual(await verifyBackup(f.backup), manifest);
      assert.equal((await stat(f.backup)).mode & 0o777, 0o700);
      for (const name of ["tableloom.sqlite", "host-key", BACKUP_MANIFEST])
        assert.equal((await stat(join(f.backup, name))).mode & 0o777, 0o600);
      assert.deepEqual(
        (await readdir(f.backup)).sort(),
        [BACKUP_MANIFEST, "host-key", "tableloom.sqlite"].sort(),
      );
      writer.exec("UPDATE backup_test_pairs SET a=9,b=9");
      await restoreBackup({ source: f.backup, destination: f.restored });
      assertDataDirectoryReady(f.restored);
      const db = new DatabaseSync(join(f.restored, "tableloom.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(db.prepare("SELECT a FROM backup_test_pairs").get()?.a, 7);
      } finally {
        db.close();
      }
      assert.ok(
        (await readFile(join(f.restored, "host-key"), "utf8")) === f.key,
      );
      restored = await createApp({
        databasePath: join(f.restored, "tableloom.sqlite"),
        hostKey: loadHostKey(f.restored),
      });
      const recovered = await restored.inject({
        url: `/api/campaigns/${campaign.id}/documents/${doc.id}`,
        headers: { cookie },
      });
      assert.equal(recovered.statusCode, 200);
      assert.deepEqual(recovered.json(), doc);
      assert.deepEqual(
        (await restored.inject({ url: assetPath, headers: { cookie } }))
          .rawPayload,
        assetBytes,
      );
      assert.equal(
        writer.prepare("SELECT a FROM backup_test_pairs").get()?.a,
        9,
      );
    } finally {
      writer.close();
    }
  } finally {
    await restored?.close();
    await f.close();
  }
});
test("restores reject existing destinations including empty directories and symlinks without overwriting data", async () => {
  const f = await fixture();
  try {
    await createBackup({ source: f.data, destination: f.backup });
    await mkdir(f.restored);
    await assert.rejects(
      restoreBackup({ source: f.backup, destination: f.restored }),
    );
    assert.deepEqual(await readdir(f.restored), []);
    const before = hash(await readFile(join(f.data, "tableloom.sqlite")));
    await assert.rejects(
      restoreBackup({ source: f.backup, destination: f.data }),
    );
    assert.equal(
      hash(await readFile(join(f.data, "tableloom.sqlite"))),
      before,
    );
    await symlink(f.data, join(f.root, "link"));
    await assert.rejects(
      restoreBackup({ source: f.backup, destination: join(f.root, "link") }),
    );
    await assert.rejects(
      createBackup({ source: f.data, destination: f.backup }),
    );
    assert.ok((await readFile(join(f.backup, "host-key"), "utf8")) === f.key);
  } finally {
    await f.close();
  }
});
test("backup boundaries reject damaged checksums, future/oversized metadata, unexpected sidecars and symlinked files before creating restore destinations", async () => {
  const f = await fixture();
  try {
    await createBackup({ source: f.data, destination: f.backup });
    const manifestPath = join(f.backup, BACKUP_MANIFEST),
      original = await readFile(manifestPath, "utf8"),
      dbPath = join(f.backup, "tableloom.sqlite"),
      bytes = await readFile(dbPath);
    await writeFile(dbPath, Buffer.from("broken"));
    await assert.rejects(
      restoreBackup({ source: f.backup, destination: f.restored }),
    );
    await assert.rejects(stat(f.restored), { code: "ENOENT" });
    await writeFile(dbPath, bytes);
    await writeFile(
      manifestPath,
      JSON.stringify({ ...JSON.parse(original), version: 2 }),
    );
    await assert.rejects(verifyBackup(f.backup));
    await writeFile(manifestPath, " ".repeat(32769));
    await assert.rejects(verifyBackup(f.backup));
    await writeFile(manifestPath, original);
    await writeFile(join(f.backup, "tableloom.sqlite-wal"), "unverified");
    await assert.rejects(verifyBackup(f.backup));
    await rm(join(f.backup, "tableloom.sqlite-wal"));
    const keyPath = join(f.backup, "host-key");
    await rm(keyPath);
    await symlink(join(f.data, "host-key"), keyPath);
    await assert.rejects(verifyBackup(f.backup));
  } finally {
    await f.close();
  }
});
test("backup never creates missing source state or key and rejects unsafe key permissions and invalid environment keys", async () => {
  const f = await fixture();
  try {
    const missing = join(f.root, "missing");
    await mkdir(missing);
    await assert.rejects(
      createBackup({ source: missing, destination: f.backup }),
    );
    assert.deepEqual(await readdir(missing), []);
    await chmod(join(f.data, "host-key"), 0o644);
    await assert.rejects(
      createBackup({ source: f.data, destination: f.backup }),
    );
    await assert.rejects(stat(f.backup), { code: "ENOENT" });
    await assert.rejects(
      createBackup({
        source: f.data,
        destination: f.backup,
        hostKey: "invalid",
      }),
    );
    await assert.rejects(
      createBackup({
        source: f.data,
        destination: f.backup,
        hostKey: " " + f.key,
      }),
    );
    await rm(join(f.data, "host-key"));
    await assert.rejects(
      createBackup({ source: f.data, destination: f.backup }),
    );
    await assert.rejects(stat(join(f.data, "host-key")), { code: "ENOENT" });
    const manifest = await createBackup({
      source: f.data,
      destination: f.backup,
      hostKey: f.key,
    });
    assert.equal(manifest.keySource, "environment");
    await restoreBackup({ source: f.backup, destination: f.restored });
    assert.ok(loadHostKey(f.restored) === f.key);
  } finally {
    await f.close();
  }
});
test("failed snapshot validation cleans only newly owned output; archives and incomplete restores cannot initialize a server", async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(join(f.data, "tableloom.sqlite"));
    db.exec("PRAGMA foreign_keys=OFF; DELETE FROM scene_records");
    db.close();
    await assert.rejects(
      createBackup({ source: f.data, destination: f.backup }),
    );
    await assert.rejects(stat(f.backup), { code: "ENOENT" });
    await mkdir(f.restored);
    await writeFile(join(f.restored, RESTORE_INCOMPLETE), "partial");
    assert.throws(() => assertDataDirectoryReady(f.restored));
    await assert.rejects(
      createApp({
        databasePath: join(f.restored, "tableloom.sqlite"),
        hostKey: f.key,
      }),
    );
    await assert.rejects(stat(join(f.restored, "tableloom.sqlite")), {
      code: "ENOENT",
    });
    await rm(join(f.restored, RESTORE_INCOMPLETE));
    await writeFile(join(f.restored, BACKUP_MANIFEST), "{}");
    assert.throws(() => assertDataDirectoryReady(f.restored));
    await rm(join(f.restored, BACKUP_MANIFEST));
    assertDataDirectoryReady(f.restored);
  } finally {
    await f.close();
  }
});
test("a bounded online snapshot stays consistent while another WAL connection commits paired changes", async () => {
  const f = await fixture(),
    writer = new DatabaseSync(join(f.data, "tableloom.sqlite"));
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    writer.exec(
      "CREATE TABLE snapshot_pair(a INTEGER,b INTEGER); INSERT INTO snapshot_pair VALUES(0,0); CREATE TABLE snapshot_padding(data BLOB); INSERT INTO snapshot_padding VALUES(randomblob(8388608))",
    );
    let writes = 0;
    timer = setInterval(() => {
      writes++;
      if (writes >= 50) clearInterval(timer);
      writer.exec(
        `BEGIN; UPDATE snapshot_pair SET a=${writes}; UPDATE snapshot_pair SET b=${writes}; COMMIT;`,
      );
    }, 1);
    await createBackup({ source: f.data, destination: f.backup });
    clearInterval(timer);
    timer = undefined;
    assert.ok(writes > 0);
    await restoreBackup({ source: f.backup, destination: f.restored });
    const db = new DatabaseSync(join(f.restored, "tableloom.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db.prepare("SELECT a,b FROM snapshot_pair").get();
      assert.equal(row?.a, row?.b);
    } finally {
      db.close();
    }
  } finally {
    if (timer) clearInterval(timer);
    writer.close();
    await f.close();
  }
});

test("recovery cannot add a directory inside the source archive, including through a symlink", async () => {
  const f = await fixture();
  try {
    await createBackup({ source: f.data, destination: f.backup });
    const before = await readdir(f.backup);
    await assert.rejects(
      restoreBackup({
        source: f.backup,
        destination: join(f.backup, "recovered"),
      }),
    );
    await symlink(f.backup, join(f.root, "backup-link"));
    await assert.rejects(
      restoreBackup({
        source: f.backup,
        destination: join(f.root, "backup-link", "recovered"),
      }),
    );
    assert.deepEqual(await readdir(f.backup), before);
    await verifyBackup(f.backup);
  } finally {
    await f.close();
  }
});
