import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostKey } from "./host-key.js";

test("host key is private, durable, configurable, and never follows a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "tableloom-host-key-"));
  try {
    const key = loadHostKey(dir);
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(loadHostKey(dir), key);
    assert.equal(statSync(join(dir, "host-key")).mode & 0o777, 0o600);
    const configured = "synthetic-configured-host-key-not-for-real-use";
    assert.equal(loadHostKey(dir, configured), configured);
    assert.throws(() => loadHostKey(dir, "short"));
    chmodSync(join(dir, "host-key"), 0o644);
    assert.throws(() => loadHostKey(dir), /private/);
    rmSync(join(dir, "host-key"));
    writeFileSync(join(dir, "other-file"), key, { mode: 0o600 });
    symlinkSync(join(dir, "other-file"), join(dir, "host-key"));
    assert.throws(() => loadHostKey(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
