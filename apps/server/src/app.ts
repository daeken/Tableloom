import { ChatStore } from "./chat.js";
import { registerChatRoutes } from "./chat-http.js";
import { CursorStore } from "./cursors.js";
import { cursorUpdateSchema, CURSOR_INTERVAL_MS } from "@tableloom/core";
import { projectPresence } from "./presence.js";
import { SceneGridStore } from "./scene-grid.js";
import { registerSceneGridRoutes } from "./scene-grid-http.js";
import { SceneMapStore } from "./scene-map.js";
import { registerSceneMapRoutes } from "./scene-map-http.js";
import { AssetStore } from "./assets.js";
import { registerAssetRoutes } from "./assets-http.js";
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
import type { ServerMessage } from "@tableloom/core";
import { applyCommand, projectTable } from "@tableloom/core/server";
import { StoreError, TableStore } from "./store.js";
import { registerCampaignRoutes } from "./campaign-http.js";
import { installedModules } from "./modules.js";
import { OutboundChannel } from "./outbound.js";
import { SceneHistoryStore } from "./scene-history.js";
import { CommandBindings } from "./command-bindings.js";
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

import type { ServerSystemDefinition } from "@tableloom/module-sdk/server";
const installedSystems = new Set(installedModules.map((module) => module.id));

export async function createApp(options: {
  databasePath: string;
  webRoot?: string;
  logger?: boolean;
  hostKey: string;
  publicOrigin?: string;
  secureCookies?: boolean;
  now?: () => number;
  documentSystems?: readonly ServerSystemDefinition<unknown>[];
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
  let bindings: CommandBindings;
  let sceneHistory: SceneHistoryStore;
  let assets: AssetStore;
  let sceneMaps: SceneMapStore;
  let sceneGrids: SceneGridStore;
  let chat: ChatStore;
  try {
    store = new TableStore(database);
    access = new AccessStore(database, options.hostKey, now);
    store.load();
    documents = new DocumentStore(database, store, options.documentSystems);
    history = new RollHistoryStore(database, store);
    bindings = new CommandBindings(database);
    sceneHistory = new SceneHistoryStore(database, store);
    assets = new AssetStore(database, now);
    sceneMaps = new SceneMapStore(database, store, assets);
    sceneGrids = new SceneGridStore(database, store);
    chat = new ChatStore(database, store, now);
  } catch (error) {
    database.close();
    throw error;
  }
  type Client = { credential: string; campaignId: string };
  const clients = new Map<WebSocket, Client>();
  const sentVersions = new Map<WebSocket, string>();
  const outbound = new Map<WebSocket, OutboundChannel>();
  const cursors = new CursorStore(),
    dirtyCursors = new Set<string>();
  const cursorContext = (id: string) => {
    const c = store.getCampaign(id);
    return {
      campaignId: c.id,
      sceneId: c.activeSceneId,
      generation: c.version,
    };
  };
  const requestCursors = (id: string) => {
    dirtyCursors.add(id);
  };
  let cursorRefresh = Date.now() + 1000;
  const cursorTick = setInterval(() => {
    for (const id of cursors.expire(now())) dirtyCursors.add(id);
    if (Date.now() >= cursorRefresh) {
      cursorRefresh = Date.now() + 1000;
      for (const id of cursors.campaigns()) dirtyCursors.add(id);
    }
    const pending = [...dirtyCursors];
    dirtyCursors.clear();
    for (const id of pending)
      for (const [socket, client] of clients)
        if (client.campaignId === id) outbound.get(socket)?.cursors();
  }, CURSOR_INTERVAL_MS);
  cursorTick.unref();
  const authenticate = (socket: WebSocket): Member | null => {
    const context = clients.get(socket);
    const member = access.authenticate(context?.credential ?? "");
    return member && member.tableId === context?.campaignId ? member : null;
  };
  const closeClient = (socket: WebSocket, code: number, reason: string) => {
    const channel = outbound.get(socket);
    if (channel) channel.close(code, reason);
    else socket.close(code, reason);
  };
  const presence = (campaignId: string) => {
    const members: Member[] = [];
    for (const [socket, context] of clients) {
      if (context.campaignId !== campaignId || socket.readyState !== 1)
        continue;
      const member = authenticate(socket);
      if (member) members.push(member);
    }
    return projectPresence(members);
  };
  const send = (
    socket: WebSocket,
    message: Extract<ServerMessage, { type: "ack" | "error" }>,
  ) => {
    outbound.get(socket)?.control(message);
  };
  const broadcastPresence = (campaignId: string) => {
    for (const [socket, context] of clients)
      if (context.campaignId === campaignId) outbound.get(socket)?.presence();
  };
  const buildSnapshot = (
    socket: WebSocket,
    force: boolean,
  ): Extract<ServerMessage, { type: "snapshot" }> | null => {
    const member = authenticate(socket);
    if (!member) {
      closeClient(socket, 4001, "Sign in again.");
      return null;
    }
    const campaign = store.getCampaign(member.tableId);
    const context = {
      campaignId: campaign.id,
      sceneId: campaign.activeSceneId,
      generation: campaign.version,
    };
    const scene = store.getScene(campaign.id, campaign.activeSceneId);
    const view = projectTable(store.load(member.tableId), member);
    const history = sceneHistory.status(member);
    const background = sceneMaps.project(member);
    const grid = sceneGrids.project(member);
    const fingerprint = `${contextKey(context)}:${view.version}:${JSON.stringify(history)}:${JSON.stringify(background)}:${JSON.stringify(grid)}`;
    if (!force && sentVersions.get(socket) === fingerprint) return null;
    sentVersions.set(socket, fingerprint);
    return {
      type: "snapshot",
      ...background,
      grid,
      protocolVersion: PROTOCOL_VERSION,
      history,
      state: view,
      context,
      campaignName: campaign.name,
      sceneName: scene.name,
      ...presence(member.tableId),
    };
  };
  const sendSnapshot = (socket: WebSocket, force = false) =>
    outbound.get(socket)?.snapshot(force);
  const refreshCampaign = (campaignId: string) => {
    if (cursors.activate(cursorContext(campaignId))) requestCursors(campaignId);
    for (const [socket, context] of clients)
      if (context.campaignId === campaignId) sendSnapshot(socket);
  };
  const disconnectInvalid = () => {
    for (const socket of clients.keys())
      if (!authenticate(socket))
        closeClient(socket, 4001, "Your table access changed. Sign in again.");
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
          closeClient(socket, 4001, "You signed out of the table.");
    },
    disconnectInvalid,
  });
  registerCampaignRoutes(app, store, access, {
    database,
    setSession: accessHttp.setSession,
    disconnectInvalid,
    refreshCampaign,
  });
  registerChatRoutes(app, access, chat);
  registerDocumentRoutes(app, access, documents);
  await registerAssetRoutes(app, access, assets);
  registerSceneMapRoutes(app, access, sceneMaps, assets, refreshCampaign);
  registerSceneGridRoutes(app, access, sceneGrids, refreshCampaign);
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
        const protocol = z
          .object({ protocolVersion: z.string().optional() })
          .safeParse(request.query);
        if (
          !protocol.success ||
          protocol.data.protocolVersion !== String(PROTOCOL_VERSION)
        )
          return reply.code(426).send({
            error: "Reload the application to use this live protocol.",
            protocolVersion: PROTOCOL_VERSION,
          });
      },
    },
    (socket, request) => {
      const credential = sessionToken(request.headers.cookie);
      const initial = access.authenticate(credential);
      if (!initial) {
        closeClient(socket, 4001, "Sign in again.");
        return;
      }
      store.getCampaign(initial.tableId);
      cursors.activate(cursorContext(initial.tableId));
      clients.set(socket, {
        credential,
        campaignId: initial.tableId,
      });
      outbound.set(
        socket,
        new OutboundChannel(socket, {
          authorized: () => Boolean(authenticate(socket)),
          snapshot: (force) => buildSnapshot(socket, force),
          presence: () => ({
            type: "presence",
            campaignId: initial.tableId,
            ...presence(initial.tableId),
          }),
          cursors: () => {
            const actor = authenticate(socket);
            if (!actor) throw new Error("Sign in again.");
            const context = cursorContext(actor.tableId);
            return {
              type: "cursors",
              context,
              cursors: cursors.project(
                context,
                actor.id,
                (owner) => {
                  const peer = owner as WebSocket;
                  return peer.readyState === 1 ? authenticate(peer) : null;
                },
                now(),
              ),
            };
          },
          schedule: (action, delay) => {
            const timer = setTimeout(action, delay);
            timer.unref();
            return () => clearTimeout(timer);
          },
        }),
      );
      try {
        sendSnapshot(socket, true);
      } catch {
        closeClient(socket, 1011, "Unable to open this campaign.");
      }
      broadcastPresence(initial.tableId);
      if (cursors.has(initial.tableId)) requestCursors(initial.tableId);
      let cursorWindow = Date.now(),
        cursorCount = 0,
        lastCursor = -Infinity;
      let windowStart = Date.now();
      let count = 0;
      let alive = true;
      socket.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!authenticate(socket)) {
          closeClient(socket, 4001, "Sign in again.");
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
        if (socket.readyState !== 1) return;
        const member = authenticate(socket);
        if (!member) {
          closeClient(socket, 4001, "Sign in again.");
          return;
        }
        // Cursor traffic has no command IDs, receipts, acknowledgements or replay.
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw.toString());
        } catch {
          /* Normal command validation reports invalid JSON. */
        }
        if (
          decoded &&
          typeof decoded === "object" &&
          "type" in decoded &&
          decoded.type === "cursor.update"
        ) {
          const tick = Date.now();
          if (tick - cursorWindow >= 10000) {
            cursorWindow = tick;
            cursorCount = 0;
          }
          if (++cursorCount > 240) {
            closeClient(socket, 1008, "Too many cursor updates.");
            return;
          }
          const parsed = cursorUpdateSchema.safeParse(decoded);
          if (
            isBinary ||
            Buffer.byteLength(raw.toString()) > 512 ||
            !parsed.success
          ) {
            closeClient(socket, 1008, "Invalid cursor update.");
            return;
          }
          const current = cursorContext(member.tableId);
          if (contextKey(current) !== contextKey(parsed.data.context)) {
            for (const id of cursors.remove(socket)) requestCursors(id);
            return;
          }
          if (tick - lastCursor < 80 && parsed.data.position !== null) return;
          lastCursor = tick;
          if (
            cursors.update(
              socket,
              member,
              current,
              parsed.data.position,
              now(),
              parsed.data.renewOnly,
            )
          )
            requestCursors(member.tableId);
          return;
        }
        if (Date.now() - windowStart > 10000) {
          windowStart = Date.now();
          count = 0;
        }
        if (++count > 120) {
          closeClient(socket, 1008, "Too many commands.");
          return;
        }
        let commandId: string | undefined;
        let committed = false;
        try {
          if (isBinary) throw new Error("Commands must be JSON text.");
          const parsed = clientCommandSchema.safeParse(decoded);
          if (!parsed.success)
            throw new Error(
              "Invalid action or old protocol. Reload the updated application.",
            );
          commandId = parsed.data.command.id;
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
            if (store.hasCommand(command.id, actor.tableId)) {
              if (!bindings.matches(actor.id, parsed.data))
                throw new Error(
                  "This request cannot be confirmed. Review the latest table before making a new change.",
                );
              return { kind: "retry" as const };
            }
            const recipient =
              command.type === "object.assign" || command.type === "note.assign"
                ? access.getMember(command.ownerId, actor.tableId)
                : undefined;
            const before = store.load(actor.tableId);
            const next =
              command.type === "scene.undo" || command.type === "scene.redo"
                ? sceneHistory.apply(actor, before, command)
                : applyCommand(before, command, actor, recipient);
            sceneHistory.record(actor, before, next, command);
            store.save(next, command.id, actor.tableId);
            bindings.bind(actor.id, parsed.data);
            return { kind: "saved" as const, state: next };
          });
          committed = outcome.kind === "saved" || outcome.kind === "retry";
          // No outbound acknowledgement precedes the transaction's commit.
          if (outcome.kind === "unauthorized")
            closeClient(socket, 4001, "Sign in again.");
          else if (outcome.kind === "stale") {
            send(socket, {
              type: "error",
              commandId,
              message:
                "The campaign or scene changed. Review the current scene before trying again.",
            });
            sendSnapshot(socket, true);
          } else {
            send(socket, { type: "ack", commandId });
            if (outcome.kind === "retry") sendSnapshot(socket, true);
            else refreshCampaign(member.tableId);
          }
        } catch (error) {
          app.log.debug({ err: error }, "Rejected table command");
          if (committed) {
            closeClient(
              socket,
              1011,
              "The change was saved but the view could not refresh.",
            );
            return;
          }
          const message =
            error instanceof SyntaxError
              ? "Commands must be valid JSON."
              : error instanceof Error && !("code" in error)
                ? error.message
                : "Unable to save this change.";
          send(socket, {
            type: "error",
            ...(commandId ? { commandId } : {}),
            message: message.slice(0, 500),
          });
          if (commandId) {
            try {
              sendSnapshot(socket, true);
            } catch {
              closeClient(socket, 1011, "Unable to reload this campaign.");
            }
          }
        }
      });
      socket.on("error", (error) =>
        app.log.debug({ err: error }, "WebSocket error"),
      );
      socket.on("close", () => {
        clearInterval(heartbeat);
        for (const id of cursors.remove(socket)) requestCursors(id);
        clients.delete(socket);
        sentVersions.delete(socket);
        outbound.get(socket)?.dispose();
        outbound.delete(socket);
        broadcastPresence(initial.tableId);
      });
    },
  );
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot });
  }
  app.addHook("onClose", async () => {
    clearInterval(cursorTick);
    dirtyCursors.clear();
    for (const channel of outbound.values()) channel.dispose();
    outbound.clear();
    for (const socket of clients.keys()) socket.terminate();
    store.close();
    access.close();
    database.close();
  });
  return app;
}
