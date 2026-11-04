import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import { z } from "zod";
import { clientCommandSchema, PROTOCOL_VERSION } from "@tableloom/core";
import { contextKey } from "@tableloom/core/campaigns";
import type { Member } from "@tableloom/core/access";
import type { TableState, ServerMessage } from "@tableloom/core";
import { applyCommand, projectTable } from "@tableloom/core/server";
import { StoreError, TableStore } from "./store.js";
import { registerCampaignRoutes } from "./campaign-http.js";
import { installedModules } from "./modules.js";
import { transaction } from "./database.js";
import { RollHistoryStore } from "./roll-history.js";
import { registerRollHistoryRoutes } from "./roll-history-http.js";
import { DocumentStore } from "./documents.js";
import { registerDocumentRoutes } from "./documents-http.js";
import { AccessStore } from "./access.js";
import {
  registerAccessRoutes,
  sameOrigin,
  sessionToken,
} from "./access-http.js";

const installedSystems = new Set(installedModules.map((module) => module.id));

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
  const database = new DatabaseSync(options.databasePath);
  let store: TableStore;
  let access: AccessStore;
  let documents: DocumentStore;
  let history: RollHistoryStore;
  try {
    store = new TableStore(database);
    access = new AccessStore(database, options.hostKey, now);
    store.load();
    documents = new DocumentStore(database, store);
    history = new RollHistoryStore(database, store);
  } catch (error) {
    database.close();
    throw error;
  }
  type Client = { credential: string; campaignId: string };
  const clients = new Map<WebSocket, Client>();
  const sentVersions = new Map<WebSocket, string>();
  const authenticate = (socket: WebSocket): Member | null => {
    const context = clients.get(socket);
    const member = access.authenticate(context?.credential ?? "");
    return member && member.tableId === context?.campaignId ? member : null;
  };
  const participants = (campaignId: string) =>
    [...clients].filter(
      ([socket, context]) =>
        context.campaignId === campaignId &&
        socket.readyState === 1 &&
        authenticate(socket),
    ).length;
  const send = (socket: WebSocket, message: ServerMessage) => {
    if (socket.readyState !== 1) return;
    if (!authenticate(socket)) {
      socket.close(4001, "Sign in to the table again.");
      return;
    }
    if (socket.bufferedAmount > 4 * 1024 * 1024) {
      socket.close(1013, "Connection is too slow; reconnect.");
      return;
    }
    socket.send(JSON.stringify(message));
  };
  const broadcastPresence = (campaignId: string) => {
    const message: ServerMessage = {
      type: "presence",
      participants: participants(campaignId),
    };
    for (const [socket, context] of clients)
      if (context.campaignId === campaignId) send(socket, message);
  };
  const sendSnapshot = (
    socket: WebSocket,
    force = false,
    loaded?: TableState,
  ) => {
    const member = authenticate(socket);
    if (!member) {
      socket.close(4001, "Sign in again.");
      return;
    }
    const campaign = store.getCampaign(member.tableId);
    const context = {
      campaignId: campaign.id,
      sceneId: campaign.activeSceneId,
      generation: campaign.version,
    };
    const scene = store.getScene(campaign.id, campaign.activeSceneId);
    const view = projectTable(loaded ?? store.load(member.tableId), member);
    const fingerprint = `${contextKey(context)}:${view.version}`;
    if (!force && sentVersions.get(socket) === fingerprint) return;
    send(socket, {
      type: "snapshot",
      state: view,
      context,
      campaignName: campaign.name,
      sceneName: scene.name,
      participants: participants(member.tableId),
    });
    sentVersions.set(socket, fingerprint);
  };
  const refreshCampaign = (
    campaignId: string,
    state = store.load(campaignId),
  ) => {
    for (const [socket, context] of clients)
      if (context.campaignId === campaignId) sendSnapshot(socket, false, state);
  };
  const disconnectInvalid = () => {
    for (const socket of clients.keys())
      if (!authenticate(socket))
        socket.close(4001, "Your table access changed. Sign in again.");
  };
  const queryContext = (request: { query: unknown }, member: Member) => {
    const query = z
      .object({ campaignId: z.uuid().optional() })
      .parse(request.query);
    if (query.campaignId !== undefined && query.campaignId !== member.tableId)
      throw new StoreError(
        "Your active campaign changed. Refresh before reconnecting.",
        409,
      );
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
  const accessHttp = registerAccessRoutes(app, access, {
    ...(publicOrigin ? { publicOrigin } : {}),
    database,
    validateCampaign: (id) => {
      store.load(id);
    },
    secureCookies:
      options.secureCookies ?? publicOrigin?.startsWith("https:") ?? false,
    now,
    disconnect: (token) => {
      for (const [socket, context] of clients)
        if (context.credential === token)
          socket.close(4001, "You signed out of the table.");
    },
    disconnectInvalid,
  });
  registerCampaignRoutes(app, store, access, {
    database,
    setSession: accessHttp.setSession,
    disconnectInvalid,
    refreshCampaign,
  });
  registerDocumentRoutes(app, access, documents);
  registerRollHistoryRoutes(app, access, history, refreshCampaign);
  app.get("/api/health", async () => ({
    status: "ok",
    protocolVersion: PROTOCOL_VERSION,
  }));
  app.get("/api/table", async (request, reply) => {
    const member = access.authenticate(sessionToken(request.headers.cookie));
    if (!member)
      return reply.code(401).send({ error: "Sign in to the table first." });
    queryContext(request, member);
    return projectTable(store.load(member.tableId), member);
  });
  app.get(
    "/api/live",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!sameOrigin(request, publicOrigin))
          return reply.code(403).send({ error: "Origin is not allowed." });
        const member = access.authenticate(
          sessionToken(request.headers.cookie),
        );
        if (!member)
          return reply.code(401).send({ error: "Sign in to the table first." });
        queryContext(request, member);
        store.getCampaign(member.tableId);
      },
    },
    (socket, request) => {
      const credential = sessionToken(request.headers.cookie);
      const initial = access.authenticate(credential);
      if (!initial) {
        socket.close(4001, "Sign in again.");
        return;
      }
      store.getCampaign(initial.tableId);
      clients.set(socket, {
        credential,
        campaignId: initial.tableId,
      });
      try {
        sendSnapshot(socket, true);
      } catch {
        socket.close(1011, "Unable to open this campaign.");
      }
      broadcastPresence(initial.tableId);
      let windowStart = Date.now();
      let count = 0;
      let alive = true;
      socket.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!authenticate(socket)) {
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
        const member = authenticate(socket);
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
          const parsed = clientCommandSchema.safeParse(
            JSON.parse(raw.toString()),
          );
          if (!parsed.success)
            throw new Error(
              "Invalid action or old protocol. Reload the updated application.",
            );
          const outcome = transaction(database, () => {
            const actor = authenticate(socket);
            if (!actor) return { kind: "unauthorized" as const };
            const campaign = store.getCampaign(actor.tableId);
            const currentContext = {
              campaignId: campaign.id,
              sceneId: campaign.activeSceneId,
              generation: campaign.version,
            };
            if (contextKey(parsed.data.context) !== contextKey(currentContext))
              return { kind: "stale" as const };
            const command = parsed.data.command;
            if (
              command.type === "system.set" &&
              !installedSystems.has(command.systemId)
            )
              throw new Error("That system is not installed.");
            if (store.hasCommand(command.id, actor.tableId))
              return { kind: "retry" as const };
            const recipient =
              command.type === "object.assign" || command.type === "note.assign"
                ? access.getMember(command.ownerId, actor.tableId)
                : undefined;
            const next = applyCommand(
              store.load(actor.tableId),
              command,
              actor,
              recipient,
            );
            store.save(next, command.id, actor.tableId);
            return { kind: "saved" as const, state: next };
          });
          // No outbound acknowledgement precedes the transaction's commit.
          if (outcome.kind === "unauthorized")
            socket.close(4001, "Sign in again.");
          else if (outcome.kind === "stale") {
            send(socket, {
              type: "error",
              message:
                "The campaign or scene changed. Review the current scene before trying again.",
            });
            sendSnapshot(socket, true);
          } else if (outcome.kind === "retry") sendSnapshot(socket, true);
          else refreshCampaign(member.tableId, outcome.state);
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
        broadcastPresence(initial.tableId);
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
    database.close();
  });
  return app;
}
