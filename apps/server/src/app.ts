import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import type { WebSocket } from "ws";
import { z } from "zod";
import { commandSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { applyCommand, projectTable } from "@tableloom/core/server";
import { TableStore } from "./store.js";
import { manifest as cyberpunk } from "@tableloom/cyberpunk-red";
import { manifest as bikes } from "@tableloom/kids-on-bikes";
import { manifest as brooms } from "@tableloom/kids-on-brooms";
import { AccessStore } from "./access.js";
import {
  registerAccessRoutes,
  sameOrigin,
  sessionToken,
} from "./access-http.js";

const installedSystems = new Set([cyberpunk.id, bikes.id, brooms.id]);

export async function createApp(options: {
  databasePath: string;
  webRoot?: string;
  logger?: boolean;
  hostKey: string;
  publicOrigin?: string;
  secureCookies?: boolean;
  now?: () => number;
}) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 256 * 1024,
  });
  const store = new TableStore(options.databasePath);
  const now = options.now ?? Date.now;
  let publicOrigin: string | undefined;
  if (options.publicOrigin) {
    const url = new URL(z.url().parse(options.publicOrigin));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("PUBLIC_ORIGIN must be the server's HTTP(S) origin.");
    publicOrigin = url.origin;
  }
  const access = new AccessStore(options.databasePath, options.hostKey, now);
  let state = store.load();
  const clients = new Map<WebSocket, string>();
  const sentVersions = new Map<WebSocket, string>();
  const send = (socket: WebSocket, message: ServerMessage) => {
    if (socket.readyState !== 1) return;
    if (!access.authenticate(clients.get(socket) ?? "")) {
      socket.close(4001, "Sign in to the table again.");
      return;
    }
    if (socket.bufferedAmount > 4 * 1024 * 1024) {
      socket.close(1013, "Connection is too slow; reconnect.");
      return;
    }
    socket.send(JSON.stringify(message));
  };
  const broadcast = (message: ServerMessage) => {
    for (const socket of clients.keys()) send(socket, message);
  };
  const sendSnapshot = (socket: WebSocket, force = false) => {
    const member = access.authenticate(clients.get(socket) ?? "");
    if (!member) {
      socket.close(4001, "Sign in again.");
      return;
    }
    const view = projectTable(state, member);
    if (!force && sentVersions.get(socket) === view.version) return;
    send(socket, { type: "snapshot", state: view, participants: clients.size });
    sentVersions.set(socket, view.version);
  };
  await app.register(websocket, {
    options: { maxPayload: 256 * 1024 },
    preClose: function (done) {
      // Proxies may not complete a WebSocket closing handshake during a restart.
      // Accepted state is durable, so terminate sockets to bound shutdown time.
      for (const socket of this.websocketServer.clients) socket.terminate();
      this.websocketServer.close(done);
    },
  });
  registerAccessRoutes(app, access, {
    ...(publicOrigin ? { publicOrigin } : {}),
    secureCookies:
      options.secureCookies ?? publicOrigin?.startsWith("https:") ?? false,
    now,
    disconnect: (token) => {
      for (const [socket, credential] of clients)
        if (credential === token)
          socket.close(4001, "You signed out of the table.");
    },
    disconnectInvalid: () => {
      for (const [socket, credential] of clients)
        if (!access.authenticate(credential))
          socket.close(4001, "Your table access changed. Sign in again.");
    },
  });
  app.get("/api/health", async () => ({ status: "ok", protocolVersion: 4 }));
  app.get("/api/table", async (request, reply) => {
    const member = access.authenticate(sessionToken(request.headers.cookie));
    if (!member)
      return reply.code(401).send({ error: "Sign in to the table first." });
    return projectTable(state, member);
  });
  app.get(
    "/api/live",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!sameOrigin(request, publicOrigin))
          return reply.code(403).send({ error: "Origin is not allowed." });
        if (!access.authenticate(sessionToken(request.headers.cookie)))
          return reply.code(401).send({ error: "Sign in to the table first." });
      },
    },
    (socket, request) => {
      const credential = sessionToken(request.headers.cookie);
      if (!access.authenticate(credential)) {
        socket.close(4001, "Sign in again.");
        return;
      }
      clients.set(socket, credential);
      sendSnapshot(socket, true);
      broadcast({ type: "presence", participants: clients.size });
      let windowStart = Date.now();
      let count = 0;
      let alive = true;
      socket.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!access.authenticate(credential)) {
          socket.close(4001, "Sign in again.");
          return;
        }
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 30000);
      socket.on("message", (raw, isBinary) => {
        const member = access.authenticate(credential);
        if (!member) {
          socket.close(4001, "Sign in again.");
          return;
        }
        if (Date.now() - windowStart > 10000) {
          windowStart = Date.now();
          count = 0;
        }
        if (++count > 120) {
          socket.close(1008, "Too many commands.");
          return;
        }
        try {
          if (isBinary) throw new Error("Commands must be JSON text.");
          const parsed = commandSchema.safeParse(JSON.parse(raw.toString()));
          if (!parsed.success)
            throw new Error("Invalid command. Check its fields and limits.");
          const command = parsed.data;
          if (
            command.type === "system.set" &&
            !installedSystems.has(command.systemId)
          )
            throw new Error("That system is not installed.");
          if (store.hasCommand(command.id)) {
            sendSnapshot(socket, true);
            return;
          }
          const recipient =
            command.type === "object.assign" || command.type === "note.assign"
              ? access.getMember(command.ownerId)
              : undefined;
          const next = applyCommand(state, command, member, recipient);
          store.save(next, command.id);
          state = next;
          for (const client of clients.keys()) sendSnapshot(client);
        } catch (error) {
          app.log.debug({ err: error }, "Rejected table command");
          const message =
            error instanceof SyntaxError
              ? "Commands must be valid JSON."
              : error instanceof Error && !("code" in error)
                ? error.message
                : "Unable to save this change.";
          send(socket, { type: "error", message: message.slice(0, 500) });
        }
      });
      socket.on("error", (error) =>
        app.log.debug({ err: error }, "WebSocket error"),
      );
      socket.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(socket);
        sentVersions.delete(socket);
        broadcast({ type: "presence", participants: clients.size });
      });
    },
  );
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot });
  }
  app.addHook("onClose", async () => {
    for (const socket of clients.keys()) socket.terminate();
    store.close();
    access.close();
  });
  return app;
}
