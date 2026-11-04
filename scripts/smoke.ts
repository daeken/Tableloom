import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Exercise the actual distribution: source tests cannot catch broken bundle imports.
const directory = await mkdtemp(join(tmpdir(), "tableloom-smoke-"));
const hostKey = "tableloom-production-smoke-key-never-use-outside-tests";
const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
  env: {
    ...process.env,
    PORT: "0",
    HOST: "127.0.0.1",
    DATA_DIR: directory,
    TABLELOOM_HOST_KEY: hostKey,
    PUBLIC_ORIGIN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
try {
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Production startup timed out: ${logs}`));
    }, 10000);
    child.stdout.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
      const address = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) {
        clearTimeout(timeout);
        resolve(address);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Production server exited (${code}): ${logs}`));
    });
  });
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { status: string }).status, "ok");
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Tableloom/);
  const asset = html.match(/src="([^"]*\/assets\/[^"]+)"/)?.[1];
  assert.ok(asset, "Production HTML must reference its built JavaScript");
  const javascript = await fetch(new URL(asset, url));
  assert.equal(javascript.status, 200);
  assert.ok((await javascript.arrayBuffer()).byteLength > 0);
  assert.equal((await fetch(`${url}/api/table`)).status, 401);
  const setup = await fetch(`${url}/api/access/setup`, {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({ key: hostKey, name: "Smoke host" }),
  });
  assert.equal(setup.status, 200);
  await setup.json();
  const cookie = setup.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const table = await fetch(`${url}/api/table`, {
    headers: { Cookie: cookie },
  });
  assert.equal(table.status, 200);
  await table.json();
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.kill();
    try {
      await once(child, "exit");
      assert.equal(child.exitCode, 0, `Server must shut down cleanly: ${logs}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "Production smoke check passed: built server, frontend/assets, health, authenticated table access, and clean shutdown.",
);
