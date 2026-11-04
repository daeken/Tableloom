import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  campaignListSchema,
  campaignMembershipSchema,
} from "@tableloom/core/campaigns";
import { accessStatusSchema } from "@tableloom/core/access";
import {
  tableViewSchema,
  serverMessageSchema,
  PROTOCOL_VERSION,
} from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { sceneSchema } from "@tableloom/core/campaigns";

function snapshot(
  socket: WebSocket,
  matches: (message: Extract<ServerMessage, { type: "snapshot" }>) => boolean,
) {
  return new Promise<Extract<ServerMessage, { type: "snapshot" }>>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Production live snapshot timed out"));
      }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("message", receive);
        socket.off("error", failed);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const receive = (raw: WebSocket.RawData) => {
        try {
          const message = serverMessageSchema.parse(JSON.parse(raw.toString()));
          if (message.type === "snapshot" && matches(message)) {
            cleanup();
            resolve(message);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      socket.on("message", receive);
      socket.on("error", failed);
    },
  );
}

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
  const healthBody = (await health.json()) as {
    status: string;
    protocolVersion: number;
  };
  assert.equal(healthBody.status, "ok");
  assert.equal(healthBody.protocolVersion, PROTOCOL_VERSION);
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
  const campaigns = await fetch(`${url}/api/campaigns`, {
    headers: { Cookie: cookie },
  });
  assert.equal(campaigns.status, 200);
  assert.equal(campaignListSchema.parse(await campaigns.json()).length, 1);
  const created = await fetch(`${url}/api/campaigns`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: url,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Smoke campaign",
      description: "",
      system: { id: "kids-on-brooms", version: "0.1.0" },
      contentPacks: [],
    }),
  });
  assert.equal(created.status, 201);
  const campaign = campaignMembershipSchema.parse(await created.json());
  const selected = await fetch(`${url}/api/campaigns/${campaign.id}/select`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: url,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(selected.status, 200);
  assert.equal(
    accessStatusSchema.parse(await selected.json()).member?.tableId,
    campaign.id,
  );
  const nextCookie = selected.headers.get("set-cookie")?.split(";")[0];
  assert.ok(nextCookie);
  const selectedTable = await fetch(`${url}/api/table`, {
    headers: { Cookie: nextCookie },
  });
  assert.equal(selectedTable.status, 200);
  assert.equal(
    tableViewSchema.parse(await selectedTable.json()).systemId,
    "kids-on-brooms",
  );
  const previousTable = await fetch(`${url}/api/table`, {
    headers: { Cookie: cookie },
  });
  assert.equal(previousTable.status, 401);
  await previousTable.text();
  const sceneResponse = await fetch(
    `${url}/api/campaigns/${campaign.id}/scenes`,
    {
      method: "POST",
      headers: {
        Cookie: nextCookie,
        Origin: url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Smoke battlefield" }),
    },
  );
  assert.equal(sceneResponse.status, 201);
  const scene = sceneSchema.parse(await sceneResponse.json());
  const activated = await fetch(
    `${url}/api/campaigns/${campaign.id}/activate`,
    {
      method: "POST",
      headers: {
        Cookie: nextCookie,
        Origin: url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sceneId: scene.id,
        expectedVersion: campaign.version,
      }),
    },
  );
  assert.equal(activated.status, 200);
  await activated.json();
  const live = new WebSocket(
    `${url.replace("http", "ws")}/api/live?campaignId=${campaign.id}`,
    { headers: { Cookie: nextCookie, Origin: url } },
  );
  try {
    const opened = snapshot(live, () => true);
    await once(live, "open");
    const current = await opened;
    assert.equal(current.sceneName, scene.name);
    const rolled = snapshot(
      live,
      (message) => message.state.rolls.length === 1,
    );
    live.send(
      JSON.stringify({
        context: current.context,
        command: { id: randomUUID(), type: "dice.roll", expression: "d6" },
      }),
    );
    assert.equal((await rolled).state.rolls[0]?.expression, "1d6");
  } finally {
    live.terminate();
  }
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
  "Production smoke check passed: built server/assets, authentication, campaigns, scene activation, context-bound live dice, and clean shutdown.",
);
