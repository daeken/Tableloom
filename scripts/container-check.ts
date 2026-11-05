import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { seedRuntime, verifyRuntimePersistence } from "./runtime-smoke.js";
const exec = promisify(execFile),
  root = fileURLToPath(new URL("../", import.meta.url)),
  project = `tableloom-check-${randomUUID().slice(0, 8)}`;
const env = {
  ...process.env,
  TABLELOOM_BIND: "127.0.0.1",
  TABLELOOM_PORT: "0",
  PUBLIC_ORIGIN: "",
  TABLELOOM_IMAGE: `${project}:local`,
};
// Resolve once, then force that verified local endpoint for every operation.
// DOCKER_CONTEXT takes precedence over DOCKER_HOST in the normal Docker CLI.
const endpoint = process.env.DOCKER_CONTEXT
  ? (
      await exec(
        "docker",
        [
          "context",
          "inspect",
          process.env.DOCKER_CONTEXT,
          "--format",
          "{{.Endpoints.docker.Host}}",
        ],
        { cwd: root, env, timeout: 30000 },
      )
    ).stdout.trim()
  : (process.env.DOCKER_HOST ??
    (
      await exec(
        "docker",
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        { cwd: root, env, timeout: 30000 },
      )
    ).stdout.trim());
if (!endpoint.startsWith("unix://") && !endpoint.startsWith("npipe://"))
  throw new Error(
    "Container checks accept local Docker sockets only; remote engines are not used.",
  );
const localEnv: NodeJS.ProcessEnv = { ...env };
delete localEnv.DOCKER_CONTEXT;
delete localEnv.DOCKER_HOST;
const docker = async (args: string[], timeout = 30000) => {
  try {
    return (
      await exec("docker", ["--host", endpoint, ...args], {
        cwd: root,
        env: localEnv,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout.trim();
  } catch {
    // exec can contain a generated key in stdout; never print captured Docker output.
    throw new Error(
      `Docker ${args[0] ?? "command"} failed for isolated project ${project}.`,
    );
  }
};
const compose = (...args: string[]) =>
  docker(
    ["compose", "-f", root + "compose.yaml", "-p", project, ...args],
    300000,
  );
try {
  await docker(["info", "--format", "{{.ServerVersion}}"]);
  await docker(["compose", "version"]);
  await docker(["buildx", "version"]);
} catch {
  throw new Error(
    "Container checks require a running Docker engine and the Docker Compose/buildx plugins. No containers or volumes were created.",
  );
}
let attempted = false;
async function ready() {
  const id = await compose("ps", "-q", "tableloom");
  assert.ok(id);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = await docker([
      "inspect",
      "--format",
      "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
      id,
    ]);
    if (state === "running healthy") {
      const address = await compose("port", "tableloom", "3001");
      assert.match(address, /^127\.0\.0\.1:\d+$/);
      return `http://${address}`;
    }
    if (state.startsWith("exited") || state.includes("unhealthy"))
      throw new Error("Container did not become healthy");
    await delay(500);
  }
  throw new Error("Container readiness timed out");
}
try {
  attempted = true;
  console.log(
    `Building and checking an isolated Compose project (${project}).`,
  );
  await compose("up", "--build", "-d");
  const first = await ready();
  const runningId = await compose("ps", "-q", "tableloom");
  assert.equal(
    await docker([
      "inspect",
      "--format",
      "{{.HostConfig.ReadonlyRootfs}}",
      runningId,
    ]),
    "true",
  );
  assert.equal(await compose("exec", "-T", "tableloom", "id", "-u"), "1000");
  await compose(
    "exec",
    "-T",
    "tableloom",
    "node",
    "-e",
    "try { require('node:fs').writeFileSync('/app/runtime-write-test','x'); process.exit(1); } catch (e) { if (e.code !== 'EROFS' && e.code !== 'EACCES') process.exit(1); }",
  );
  const key = await compose(
    "exec",
    "-T",
    "tableloom",
    "cat",
    "/app/data/host-key",
  );
  assert.equal(
    await compose(
      "exec",
      "-T",
      "tableloom",
      "stat",
      "-c",
      "%a",
      "/app/data/host-key",
    ),
    "600",
  );
  const saved = await seedRuntime(first, key);
  const original = await compose("ps", "-q", "tableloom");
  await compose("stop");
  assert.equal(
    await docker(["inspect", "--format", "{{.State.ExitCode}}", original]),
    "0",
  );
  await compose("up", "--force-recreate", "-d");
  const second = await ready();
  assert.ok(
    (await compose("exec", "-T", "tableloom", "cat", "/app/data/host-key")) ===
      key,
    "Host key must survive container replacement",
  );
  await verifyRuntimePersistence(second, saved);
  console.log(
    "Container checks passed: UID 1000, read-only application, health probe, auth/WebSocket, private volume data and replacement persistence.",
  );
} finally {
  // Only this randomly named check project is removed; never touch the user's normal stack.
  if (attempted) {
    await compose("down", "--volumes", "--remove-orphans");
    const exists = await docker([
      "image",
      "inspect",
      env.TABLELOOM_IMAGE,
      "--format",
      "{{.Id}}",
    ]).catch(() => null);
    if (exists) await docker(["image", "rm", env.TABLELOOM_IMAGE]);
  }
}
