import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, serverMessageSchema } from "@tableloom/core";
import { createApp } from "./app.js";

test("live handshake negotiates the protocol before sending campaign content; authenticated current clients receive a versioned snapshot", async () => {
  const key = "tableloom-protocol-test-key-never-use-in-production";
  const app = await createApp({ databasePath: ":memory:", hostKey: key });
  const sockets: WebSocket[] = [];
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const setup = await app.inject({
      method: "POST",
      url: "/api/access/setup",
      headers: { origin: "http://localhost" },
      payload: { key, name: "GM" },
    });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
    assert.equal(
      (await app.inject("/api/health")).json().protocolVersion,
      PROTOCOL_VERSION,
    );
    for (const version of [
      undefined,
      "5",
      "999",
      "six",
      `${PROTOCOL_VERSION}&protocolVersion=${PROTOCOL_VERSION}`,
    ]) {
      const rejected = await app.inject({
        url: `/api/live${version === undefined ? "" : `?protocolVersion=${version}`}`,
        headers: { origin: "http://localhost", cookie },
      });
      assert.equal(rejected.statusCode, 426);
      assert.equal(rejected.json().protocolVersion, PROTOCOL_VERSION);
      assert.ok(!rejected.body.includes("Campaign"));
      assert.equal(rejected.headers["cache-control"], "no-store");
    }
    const rejected = new WebSocket(
      `${url.replace("http", "ws")}/api/live?protocolVersion=5`,
      { headers: { Origin: url, Cookie: cookie } },
    );
    sockets.push(rejected);
    const response = once(rejected, "unexpected-response");
    rejected.on("error", () => {});
    const [, reply] = await response;
    assert.equal(reply.statusCode, 426);
    reply.resume();
    rejected.terminate();
    const socket = new WebSocket(
      `${url.replace("http", "ws")}/api/live?protocolVersion=${PROTOCOL_VERSION}`,
      { headers: { Origin: url, Cookie: cookie } },
    );
    sockets.push(socket);
    const first = once(socket, "message");
    await once(socket, "open");
    const [raw] = await first;
    const message = serverMessageSchema.parse(JSON.parse(String(raw)));
    assert.equal(message.type, "snapshot");
    assert.ok(
      message.type === "snapshot" &&
        message.protocolVersion === PROTOCOL_VERSION,
    );
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await app.close();
  }
});
