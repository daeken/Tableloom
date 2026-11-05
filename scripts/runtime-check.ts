import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedRuntime, verifyRuntimePersistence } from "./runtime-smoke.js";
const exec = promisify(execFile),
  root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "tableloom-runtime-check-"));
let child: ChildProcess | undefined;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const current = child;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      current.kill("SIGKILL");
      reject(new Error("Runtime did not stop gracefully"));
    }, 8000);
    current.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? done() : reject(new Error("Runtime exited uncleanly"));
    });
    current.kill("SIGTERM");
  });
}
const manifests = [
  "package.json",
  "package-lock.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/core/package.json",
  "packages/module-sdk/package.json",
  "systems/cyberpunk-red/package.json",
  "systems/kids-on-bikes/package.json",
  "systems/kids-on-brooms/package.json",
];
try {
  for (const path of manifests) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await cp(join(root, path), join(directory, path));
  }
  console.log(
    "Installing a fresh production-only runtime (no source or development dependencies).",
  );
  await exec(
    "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: directory,
      timeout: 120000,
      env: { ...process.env, NODE_ENV: "production" },
      maxBuffer: 1024 * 1024,
    },
  );
  for (const path of ["apps/server/dist", "apps/web/dist"])
    await cp(join(root, path), join(directory, path), { recursive: true });
  for (const absent of [
    "apps/server/src",
    "packages/core/src",
    "systems/cyberpunk-red/src",
    "node_modules/tsx",
    "node_modules/typescript",
    "node_modules/tsup",
  ])
    await assert.rejects(stat(join(directory, absent)), { code: "ENOENT" });
  const dataDir = join(directory, "data");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: "0",
    DATA_DIR: dataDir,
    PUBLIC_ORIGIN: "",
    NODE_ENV: "production",
  };
  delete env.TABLELOOM_HOST_KEY;
  const start = () =>
    new Promise<string>((done, reject) => {
      let logs = "";
      child = spawn(process.execPath, ["apps/server/dist/index.js"], {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const current = child,
        timer = setTimeout(
          () => reject(new Error("Isolated runtime startup timed out")),
          10000,
        );
      const receive = (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-16000);
        const url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) {
          clearTimeout(timer);
          done(url);
        }
      };
      current.stdout!.on("data", receive);
      current.stderr!.on("data", receive);
      current.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      current.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Isolated runtime exited before startup"));
      });
    });
  const first = await start(),
    key = await readFile(join(dataDir, "host-key"), "utf8");
  assert.equal((await stat(join(dataDir, "host-key"))).mode & 0o777, 0o600);
  const probe = resolve(directory, "apps/server/dist/container-healthcheck.js");
  await exec(process.execPath, [probe], {
    cwd: directory,
    env: { ...env, PORT: new URL(first).port },
    timeout: 5000,
  });
  const saved = await seedRuntime(first, key);
  const backupCli = resolve(directory, "apps/server/dist/backup-cli.js"),
    snapshot = join(directory, "snapshot"),
    recovered = join(directory, "recovered");
  await exec(
    process.execPath,
    [backupCli, "backup", "--source", dataDir, "--destination", snapshot],
    { cwd: directory, env, timeout: 10000 },
  );
  await exec(process.execPath, [backupCli, "verify", "--source", snapshot], {
    cwd: directory,
    env,
    timeout: 10000,
  });
  await assert.rejects(
    exec(process.execPath, ["apps/server/dist/index.js"], {
      cwd: directory,
      env: { ...env, DATA_DIR: snapshot },
      timeout: 5000,
    }),
  );

  await stop();
  await exec(
    process.execPath,
    [backupCli, "restore", "--source", snapshot, "--destination", recovered],
    { cwd: directory, env, timeout: 10000 },
  );
  env.DATA_DIR = recovered;
  const second = await start();
  assert.ok(
    (await readFile(join(recovered, "host-key"), "utf8")) === key,
    "Generated host key must persist across restarts",
  );
  await verifyRuntimePersistence(second, saved);
  await stop();
  console.log(
    "Source-free production runtime passed: generated private host key, built assets, auth, WebSocket, document/JPEG storage, private campaign import/export and durable retry receipts, online backup, verified new-directory recovery and graceful restart persistence. Container UID/mount behavior still requires Docker.",
  );
} finally {
  try {
    await stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
