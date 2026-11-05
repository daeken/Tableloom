import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@tableloom/core";
const exec = promisify(execFile),
  probe = fileURLToPath(new URL("./container-healthcheck.ts", import.meta.url));
async function check(port: string) {
  try {
    const result = await exec(process.execPath, ["--import", "tsx", probe], {
      env: { ...process.env, PORT: port },
      timeout: 5000,
    });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    return 0;
  } catch (error) {
    assert.ok(error && typeof error === "object" && "code" in error);
    return error.code;
  }
}
test("container health probe accepts only an available compatible server and emits no secrets", async () => {
  let status = 200,
    body = JSON.stringify({ status: "ok", protocolVersion: PROTOCOL_VERSION });
  const server = createServer((_req, res) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      Location: "https://example.invalid/",
    });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = String(address.port);
  try {
    assert.equal(await check(port), 0);
    for (const value of [
      { status: "starting", protocolVersion: PROTOCOL_VERSION },
      { status: "ok", protocolVersion: PROTOCOL_VERSION + 1 },
      { status: "ok" },
      null,
    ]) {
      body = JSON.stringify(value);
      assert.equal(await check(port), 1);
    }
    body = "not JSON";
    assert.equal(await check(port), 1);
    body = JSON.stringify({ status: "ok", protocolVersion: PROTOCOL_VERSION });
    status = 503;
    assert.equal(await check(port), 1);
    status = 302;
    assert.equal(await check(port), 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  assert.equal(await check(port), 1);
});
test("container health probe rejects invalid ports without contacting a server", async () => {
  for (const port of ["0", "65536", "not-a-port", "3001/api", "-1"])
    assert.equal(await check(port), 1);
});
