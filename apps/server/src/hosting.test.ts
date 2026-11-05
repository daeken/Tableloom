import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as upstreamRequest } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createApp } from "./app.js";
import { PROTOCOL_VERSION, serverMessageSchema } from "@tableloom/core";

// Simulates the HTTP side of TLS termination, without installing a production proxy
// or weakening TLS validation. Browser-facing Origin stays HTTPS; upstream is HTTP.
test("HTTPS public-origin auth and live sockets work through header-preserving HTTP proxying; forwarded headers cannot grant origin access", async () => {
  const origin = "https://table.example",
    key = "proxy-contract-fixture-not-a-real-host-key",
    app = await createApp({
      databasePath: ":memory:",
      hostKey: key,
      publicOrigin: origin,
    }),
    links = new Set<Duplex>();
  let proxy: ReturnType<typeof createServer> | undefined,
    ws: WebSocket | undefined;
  try {
    const backend = await app.listen({ host: "127.0.0.1", port: 0 }),
      port = Number(new URL(backend).port);
    proxy = createServer((incoming, outgoing) => {
      const upstream = upstreamRequest(
        new URL(incoming.url!, backend),
        { method: incoming.method, headers: incoming.headers, agent: false },
        (response) => {
          outgoing.writeHead(response.statusCode!, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    });
    proxy.on("upgrade", (incoming, client, head) => {
      const upstream = connect(port, "127.0.0.1");
      for (const socket of [client, upstream]) {
        links.add(socket);
        socket.once("close", () => links.delete(socket));
      }
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      upstream.once("connect", () => {
        upstream.write(
          `${incoming.method} ${incoming.url} HTTP/1.1\r\n${incoming.rawHeaders.reduce((text, value, i) => text + (i % 2 ? `${value}\r\n` : `${value}: `), "")}\r\n`,
        );
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const setup = await fetch(url + "/api/access/setup", {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ key, name: "Proxy fixture" }),
    });
    assert.equal(setup.status, 200);
    await setup.json();
    const setCookie = setup.headers.get("set-cookie")!;
    assert.match(setCookie, /; Secure/);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0]!;
    for (const bad of ["https://foreign.invalid", url, "null", ""]) {
      const response = await fetch(url + "/api/access/logout", {
        method: "POST",
        signal: AbortSignal.timeout(5000),
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          ...(bad ? { Origin: bad } : {}),
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "table.example",
        },
        body: "{}",
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      await response.json();
    }
    const snapshots = new Promise<void>((done, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Proxy live snapshot timed out")),
        5000,
      );
      ws = new WebSocket(
        url.replace("http:", "ws:") +
          `/api/live?protocolVersion=${PROTOCOL_VERSION}`,
        { headers: { Origin: origin, Cookie: cookie } },
      );
      ws.on("message", (raw) => {
        const message = serverMessageSchema.safeParse(
          JSON.parse(raw.toString()),
        );
        if (message.success && message.data.type === "snapshot") {
          clearTimeout(timeout);
          done();
        }
      });
      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    await snapshots;
    ws!.terminate();
    const denied = await new Promise<number | undefined>((done, reject) => {
      const bad = new WebSocket(
        url.replace("http:", "ws:") +
          `/api/live?protocolVersion=${PROTOCOL_VERSION}`,
        {
          headers: {
            Origin: "https://foreign.invalid",
            Cookie: cookie,
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "table.example",
          },
        },
      );
      const timeout = setTimeout(() => {
        bad.terminate();
        reject(new Error("Proxy rejection timed out"));
      }, 5000);
      bad.on("error", () => {});
      bad.on("unexpected-response", (_request, response) => {
        clearTimeout(timeout);
        response.resume();
        bad.terminate();
        done(response.statusCode);
      });
    });
    assert.equal(denied, 403);
  } finally {
    ws?.terminate();
    for (const link of links) link.destroy();
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>((done, reject) =>
        proxy!.close((error) => (error ? reject(error) : done())),
      );
    }
    await app.close();
  }
});
