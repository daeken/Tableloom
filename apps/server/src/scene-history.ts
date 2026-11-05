import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  tokenSchema,
  tableSchema,
  sceneTextSnapshot,
  shapeSnapshot,
  drawingOrderMatches,
} from "@tableloom/core";
import type { Command, TableState, Token } from "@tableloom/core";
import { applyCommand } from "@tableloom/core/server";
import { memberSchema } from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
import { canEditObject } from "@tableloom/core/permissions";
import { sceneHistorySchema } from "@tableloom/core/scene-history";
import { ObjectIdentities } from "./object-identities.js";
import { transaction } from "./database.js";
import { TableStore, StoreError } from "./store.js";
import {
  entryOf,
  expectsPresent,
  payloadSchema,
  targetsSchema,
} from "./scene-history-model.js";
import type { Entry, Payload, Target } from "./scene-history-model.js";
import { initializeSceneHistory } from "./scene-history-storage.js";

export const MAX_MEMBER_SCENE_HISTORY = 100;
export const MAX_CAMPAIGN_SCENE_HISTORY = 10000;
export const MAX_CAMPAIGN_HISTORY_BYTES = 32 * 1024 * 1024;
const objectOf = (state: TableState, id: string) =>
  state.tokens.find((object) => object.id === id) ??
  state.drawings.find((object) => object.id === id);
/** Trusted inverses. Every group is one commit and one history edge, with causal links per target. */
export class SceneHistoryStore {
  private readonly identities: ObjectIdentities;
  constructor(
    private readonly db: DatabaseSync,
    private readonly tables: TableStore,
  ) {
    this.identities = transaction(db, () => {
      const existing = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='scene_history_version'",
        )
        .get();
      const current =
        existing &&
        db.prepare("SELECT version FROM scene_history_version WHERE id=1").get()
          ?.version === 13;
      const identities = initializeSceneHistory(db);
      if (!current) {
        for (const row of db
          .prepare(
            "SELECT DISTINCT campaign_id,scene_id,actor_id FROM scene_history_entries",
          )
          .all())
          this.trimMember(
            String(row.campaign_id),
            String(row.scene_id),
            String(row.actor_id),
          );
        for (const row of db
          .prepare("SELECT DISTINCT campaign_id FROM scene_history_entries")
          .all())
          this.trimCampaign(String(row.campaign_id));
      }
      return identities;
    });
  }
  private member(actor: Member): Member {
    const identity = memberSchema.parse(actor),
      row = this.db
        .prepare(
          "SELECT u.id,u.name,m.table_id AS tableId,m.role FROM access_memberships m JOIN access_users u ON u.id=m.user_id WHERE m.user_id=? AND m.table_id=?",
        )
        .get(identity.id, identity.tableId);
    if (!row) throw new StoreError("Sign in to this campaign first.", 403);
    return memberSchema.parse(row);
  }
  private links(member: Member, sceneId: string, state: "done" | "undone") {
    // Read the small target graph; large deleted drawings need not be parsed for
    // unrelated moves or neighboring cursor updates.
    const schema = z.object({
      id: z.uuid(),
      sequence: z.number().int().positive(),
      targets_json: z.string(),
    });
    return this.db
      .prepare(
        `SELECT id,sequence,targets_json FROM scene_history_entries WHERE campaign_id=? AND scene_id=? AND actor_id=? AND state=? ORDER BY sequence ${state === "done" ? "DESC" : "ASC"}`,
      )
      .all(member.tableId, sceneId, member.id, state)
      .map((raw) => {
        const row = schema.parse(raw);
        return {
          ...row,
          targets: targetsSchema.parse(JSON.parse(row.targets_json)),
        };
      });
  }
  private edge(
    member: Member,
    sceneId: string,
    state: "done" | "undone",
  ): Entry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM scene_history_entries WHERE campaign_id=? AND scene_id=? AND actor_id=? AND state=? ORDER BY sequence ${state === "done" ? "DESC" : "ASC"} LIMIT 1`,
      )
      .get(member.tableId, sceneId, member.id, state);
    return row ? entryOf(row) : null;
  }
  private available(entry: Entry, state: TableState, member: Member): boolean {
    const payload = entry.payload;
    if (
      payload.kind === "reorder" &&
      !drawingOrderMatches(
        state.drawings.map((d) => d.id),
        entry.state === "done" ? payload.after : payload.before,
      )
    )
      return false;
    if (expectsPresent(entry))
      return entry.targets.every((target) => {
        const object = objectOf(state, target.objectId);
        return (
          object &&
          (payload.objectType === "mixed" ||
            (payload.objectType === "token"
              ? "name" in object
              : "points" in object)) &&
          (payload.kind !== "resize-many" ||
            payload.changes.some(
              (change) =>
                change.objectId === target.objectId &&
                (change.objectType === "token"
                  ? "position" in object
                  : "points" in object),
            )) &&
          (payload.kind !== "translate" ||
            payload.originals.some(
              (original) =>
                original.objectId === target.objectId &&
                (original.objectType === "token"
                  ? "position" in object
                  : "points" in object),
            )) &&
          (payload.kind !== "delete-many" ||
            payload.objects.some(
              (saved) =>
                saved.object.id === target.objectId &&
                (saved.objectType === "token"
                  ? "position" in object
                  : "points" in object),
            )) &&
          (payload.kind !== "text-update" ||
            ("kind" in object && object.kind === "text")) &&
          (payload.kind !== "shape-update" ||
            ("kind" in object && object.kind !== "text")) &&
          canEditObject(member, object) &&
          object.version === target.expectedVersion
        );
      });
    if (
      payload.kind === "reorder" ||
      payload.kind === "shape-update" ||
      payload.kind === "text-update" ||
      payload.kind === "move" ||
      payload.kind === "move-many" ||
      payload.kind === "resize-many" ||
      payload.kind === "token-resize" ||
      payload.kind === "resize" ||
      payload.kind === "translate"
    )
      return false;
    if (payload.kind === "delete-many") {
      const tokens = payload.objects.filter(
          (saved) => saved.objectType === "token",
        ).length,
        drawings = payload.objects.length - tokens;
      return (
        state.tokens.length + tokens <= 200 &&
        state.drawings.length + drawings <= 2000 &&
        payload.objects.every(
          (saved) =>
            !objectOf(state, saved.object.id) &&
            !state.notes.some((note) => note.id === saved.object.id) &&
            canEditObject(member, saved.object),
        )
      );
    }
    const target = entry.targets[0]!;
    return (
      !objectOf(state, target.objectId) &&
      !state.notes.some((note) => note.id === target.objectId) &&
      canEditObject(member, payload.object) &&
      (payload.objectType === "token"
        ? state.tokens.length < 200
        : state.drawings.length < 2000)
    );
  }
  status(actor: Member) {
    return transaction(this.db, () => {
      const member = this.member(actor),
        campaign = this.tables.getCampaign(member.tableId),
        state = this.tables.load(member.tableId);
      const item = (entry: Entry | null) => {
        if (!entry) return null;
        const target = entry.targets[0]!,
          payload = entry.payload;
        return {
          id: entry.id,
          version: entry.version,
          objectId: target.objectId,
          objectCount: entry.targets.length,
          action:
            payload.kind === "text-update" || payload.kind === "shape-update"
              ? "edit"
              : payload.kind === "token-resize" ||
                  payload.kind === "resize-many"
                ? "resize"
                : payload.kind === "delete-many"
                  ? "delete"
                  : payload.kind === "move-many" || payload.kind === "translate"
                    ? "move"
                    : payload.kind,
          objectType: payload.objectType,
          name:
            payload.kind === "resize-many"
              ? `${entry.targets.length} ${payload.objectType === "mixed" ? "objects" : payload.objectType === "drawing" ? "drawings" : "tokens"}`
              : payload.kind === "delete-many"
                ? entry.targets.length > 1
                  ? `${entry.targets.length} ${payload.objectType === "mixed" ? "objects" : payload.objectType === "drawing" ? "drawings" : "tokens"}`
                  : payload.objects[0]!.objectType === "drawing"
                    ? "Drawing"
                    : (payload.objects[0]!.object as Token).name
                : payload.kind === "translate"
                  ? entry.targets.length > 1
                    ? `${entry.targets.length} ${payload.objectType === "mixed" ? "objects" : payload.objectType === "drawing" ? "drawings" : "tokens"}`
                    : payload.objectType === "drawing"
                      ? "Drawing"
                      : ((objectOf(state, target.objectId) as Token | undefined)
                          ?.name ?? "Token")
                  : payload.kind === "move-many"
                    ? `${entry.targets.length} tokens`
                    : payload.objectType === "drawing"
                      ? "Drawing"
                      : ((objectOf(state, target.objectId) as Token | undefined)
                          ?.name ??
                        (payload.kind === "move" ||
                        payload.kind === "token-resize"
                          ? "Token"
                          : payload.object.name)),
          available: this.available(entry, state, member),
        };
      };
      return sceneHistorySchema.parse({
        undo: item(this.edge(member, campaign.activeSceneId, "done")),
        redo: item(this.edge(member, campaign.activeSceneId, "undone")),
      });
    });
  }
  private trimMember(campaignId: string, sceneId: string, actorId: string) {
    // JSON causal links to expired entries are ignored; they never restore pruned edits.
    this.db
      .prepare(
        "DELETE FROM scene_history_entries WHERE id IN (SELECT id FROM scene_history_entries WHERE campaign_id=? AND scene_id=? AND actor_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?)",
      )
      .run(campaignId, sceneId, actorId, MAX_MEMBER_SCENE_HISTORY);
  }
  private trimCampaign(campaignId: string) {
    this.db
      .prepare(
        "DELETE FROM scene_history_entries WHERE id IN (SELECT id FROM scene_history_entries WHERE campaign_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?)",
      )
      .run(campaignId, MAX_CAMPAIGN_SCENE_HISTORY);
    this.db
      .prepare(
        `DELETE FROM scene_history_entries WHERE id IN (SELECT id FROM (SELECT id,SUM(length(CAST(payload_json AS BLOB))+length(CAST(targets_json AS BLOB))) OVER (ORDER BY sequence DESC) AS bytes FROM scene_history_entries WHERE campaign_id=?) WHERE bytes>?)`,
      )
      .run(campaignId, MAX_CAMPAIGN_HISTORY_BYTES);
  }
  record(
    actor: Member,
    before: TableState,
    after: TableState,
    command: Command,
  ) {
    if (
      ![
        "token.add",
        "drawing.add",
        "drawing.resize",
        "drawing.text.update",
        "drawing.style.update",
        "drawing.reorder",
        "token.resize",
        "objects.resize",
        "token.move",
        "tokens.move",
        "objects.move",
        "objects.delete",
        "object.delete",
        "note.add",
      ].includes(command.type)
    )
      return;
    if (!this.db.isTransaction)
      throw new Error("Scene history must share the scene transaction.");
    transaction(this.db, () => {
      const member = this.member(actor),
        campaign = this.tables.getCampaign(member.tableId);
      if (command.type === "note.add") {
        this.identities.claim(member.tableId, command.note.id);
        return;
      }
      let payload: Payload, ids: string[];
      const movement = (id: string) => {
        const from = tokenSchema.parse(objectOf(before, id)),
          to = tokenSchema.parse(objectOf(after, id));
        if (to.version !== from.version + 1 || to.ownerId !== from.ownerId)
          throw new Error("Invalid move history transition.");
        return { objectId: id, before: from.position, after: to.position };
      };
      if (command.type === "drawing.reorder") {
        ids = [command.drawingId];
        const from = before.drawings.find((d) => d.id === command.drawingId),
          to = after.drawings.find((d) => d.id === command.drawingId);
        if (
          !from ||
          !to ||
          to.version !== from.version + 1 ||
          JSON.stringify({ ...from, version: to.version }) !==
            JSON.stringify(to)
        )
          throw new Error("Invalid drawing order transition.");
        payload = {
          kind: "reorder",
          objectType: "drawing",
          before: before.drawings.map((d) => d.id),
          after: after.drawings.map((d) => d.id),
        };
      } else if (command.type === "drawing.style.update") {
        ids = [command.drawingId];
        const from = before.drawings.find((d) => d.id === command.drawingId),
          to = after.drawings.find((d) => d.id === command.drawingId);
        if (
          !from ||
          !to ||
          from.kind === "text" ||
          to.kind !== from.kind ||
          to.ownerId !== from.ownerId ||
          to.version !== from.version + 1 ||
          JSON.stringify(from.points) !== JSON.stringify(to.points)
        )
          throw new Error("Invalid shape style transition.");
        payload = {
          kind: "shape-update",
          objectType: "drawing",
          before: shapeSnapshot(from),
          after: shapeSnapshot(to),
        };
      } else if (command.type === "drawing.text.update") {
        ids = [command.drawingId];
        const from = before.drawings.find((d) => d.id === command.drawingId),
          to = after.drawings.find((d) => d.id === command.drawingId);
        if (
          !from ||
          !to ||
          from.kind !== "text" ||
          to.kind !== "text" ||
          to.version !== from.version + 1 ||
          from.ownerId !== to.ownerId ||
          JSON.stringify(from.points) !== JSON.stringify(to.points)
        )
          throw new Error("Invalid text edit transition.");
        payload = payloadSchema.parse({
          kind: "text-update",
          objectType: "drawing",
          before: sceneTextSnapshot(from),
          after: sceneTextSnapshot(to),
        });
      } else if (command.type === "objects.resize") {
        ids = command.objects.map((o) => o.objectId);
        const changes = ids.map((objectId) => {
          const from = objectOf(before, objectId),
            to = objectOf(after, objectId);
          if (
            !from ||
            !to ||
            from.version + 1 !== to.version ||
            from.ownerId !== to.ownerId
          )
            throw new Error("Invalid group resize transition.");
          if ("position" in from && "position" in to)
            return {
              objectId,
              objectType: "token" as const,
              before: { position: from.position, radius: from.radius },
              after: { position: to.position, radius: to.radius },
            };
          if ("points" in from && "points" in to)
            return {
              objectId,
              objectType: "drawing" as const,
              before: from.points,
              after: to.points,
            };
          throw new Error("Invalid group resize object type.");
        });
        payload = {
          kind: "resize-many",
          objectType: changes.every((c) => c.objectType === "token")
            ? "token"
            : changes.every((c) => c.objectType === "drawing")
              ? "drawing"
              : "mixed",
          changes,
        };
      } else if (command.type === "token.resize") {
        ids = [command.tokenId];
        const from = before.tokens.find((t) => t.id === command.tokenId)!,
          to = after.tokens.find((t) => t.id === command.tokenId)!;
        if (
          !from ||
          !to ||
          to.version !== from.version + 1 ||
          from.ownerId !== to.ownerId
        )
          throw new Error("Invalid token resize transition.");
        payload = {
          kind: "token-resize",
          objectType: "token",
          before: from.radius,
          after: to.radius,
        };
      } else if (command.type === "drawing.resize") {
        ids = [command.drawingId];
        const from = before.drawings.find((d) => d.id === command.drawingId),
          to = after.drawings.find((d) => d.id === command.drawingId);
        if (
          !from ||
          !to ||
          to.version !== from.version + 1 ||
          to.ownerId !== from.ownerId
        )
          throw new Error("Invalid resize history transition.");
        payload = {
          kind: "resize",
          objectType: "drawing",
          before: from.points,
          after: to.points,
        };
      } else if (command.type === "objects.delete") {
        ids = command.objects.map((target) => target.objectId);
        const objects = ids.map((id) => {
          const object = objectOf(before, id);
          if (!object || objectOf(after, id))
            throw new Error("Invalid group deletion transition.");
          return "position" in object
            ? { objectType: "token" as const, object }
            : { objectType: "drawing" as const, object };
        });
        payload = {
          kind: "delete-many",
          objectType: objects.every((saved) => saved.objectType === "token")
            ? "token"
            : objects.every((saved) => saved.objectType === "drawing")
              ? "drawing"
              : "mixed",
          objects,
        };
      } else if (command.type === "objects.move") {
        ids = command.objects.map((object) => object.objectId);
        const kinds = ids.map((id) => {
          const from = objectOf(before, id),
            to = objectOf(after, id);
          if (
            !from ||
            !to ||
            from.version + 1 !== to.version ||
            from.ownerId !== to.ownerId
          )
            throw new Error("Invalid translated history transition.");
          return "position" in from ? "token" : "drawing";
        });
        payload = {
          kind: "translate",
          objectType: kinds.every((kind) => kind === "token")
            ? "token"
            : kinds.every((kind) => kind === "drawing")
              ? "drawing"
              : "mixed",
          delta: command.delta,
          originals: ids.map((objectId) => {
            const object = objectOf(before, objectId)!;
            return "position" in object
              ? {
                  objectId,
                  objectType: "token" as const,
                  position: object.position,
                }
              : {
                  objectId,
                  objectType: "drawing" as const,
                  points: object.points,
                };
          }),
        };
      } else if (command.type === "tokens.move") {
        ids = command.moves.map((move) => move.tokenId);
        payload = {
          kind: "move-many",
          objectType: "token",
          moves: ids.map(movement),
        };
      } else {
        const objectId =
          command.type === "token.add"
            ? command.token.id
            : command.type === "drawing.add"
              ? command.drawing.id
              : command.type === "token.move"
                ? command.tokenId
                : command.type === "object.delete"
                  ? command.objectId
                  : null;
        if (!objectId) return;
        ids = [objectId];
        if (command.type === "token.move") {
          const move = movement(objectId);
          payload = {
            kind: "move",
            objectType: "token",
            before: move.before,
            after: move.after,
          };
        } else {
          const object =
            command.type === "object.delete"
              ? objectOf(before, objectId)
              : objectOf(after, objectId);
          if (!object) throw new Error("Invalid scene history transition.");
          payload = payloadSchema.parse({
            kind: command.type === "object.delete" ? "delete" : "create",
            objectType: "name" in object ? "token" : "drawing",
            object,
          });
        }
      }
      this.db
        .prepare(
          "DELETE FROM scene_history_entries WHERE campaign_id=? AND scene_id=? AND actor_id=? AND state='undone'",
        )
        .run(member.tableId, campaign.activeSceneId, member.id);
      if (payload.kind === "create")
        this.identities.claim(member.tableId, ids[0]!);
      else
        this.identities.rememberMany(
          ids.map((id) => ({ campaignId: member.tableId, id })),
        );
      const previous = this.links(member, campaign.activeSceneId, "done"),
        cache = new Map<string, Entry>();
      const targets: Target[] = ids.map((objectId) => {
        const original = objectOf(before, objectId),
          next = objectOf(after, objectId),
          link = previous.find((entry) =>
            entry.targets.some((target) => target.objectId === objectId),
          );
        let preceding = link ? cache.get(link.id) : undefined;
        if (link && !preceding) {
          preceding = entryOf(
            this.db
              .prepare("SELECT * FROM scene_history_entries WHERE id=?")
              .get(link.id),
          );
          cache.set(link.id, preceding);
        }
        const target = preceding?.targets.find(
          (target) => target.objectId === objectId,
        );
        return {
          objectId,
          expectedVersion:
            payload.kind === "delete" || payload.kind === "delete-many"
              ? original!.version + 1
              : next!.version,
          previousId:
            preceding &&
            original &&
            expectsPresent(preceding) &&
            target?.expectedVersion === original.version
              ? preceding.id
              : null,
        };
      });
      this.db
        .prepare(
          "INSERT INTO scene_history_entries(id,campaign_id,scene_id,actor_id,state,version,targets_json,payload_json) VALUES(?,?,?,?,'done',1,?,?)",
        )
        .run(
          randomUUID(),
          member.tableId,
          campaign.activeSceneId,
          member.id,
          JSON.stringify(targetsSchema.parse(targets)),
          JSON.stringify(payloadSchema.parse(payload)),
        );
      this.trimMember(member.tableId, campaign.activeSceneId, member.id);
      this.trimCampaign(member.tableId);
    });
  }
  apply(
    actor: Member,
    state: TableState,
    command: Extract<Command, { type: "scene.undo" | "scene.redo" }>,
  ): TableState {
    if (!this.db.isTransaction)
      throw new Error("Scene history must share the scene transaction.");
    return transaction(this.db, () => {
      const member = this.member(actor),
        campaign = this.tables.getCampaign(member.tableId),
        undo = command.type === "scene.undo",
        entry = this.edge(
          member,
          campaign.activeSceneId,
          undo ? "done" : "undone",
        );
      if (!entry || entry.id !== command.historyId)
        throw new StoreError(
          "That history action is unavailable. Review the current scene.",
          404,
        );
      if (entry.version !== command.expectedVersion)
        throw new StoreError(
          "Scene history changed. Review the current action before trying again.",
          409,
        );
      if (!this.available(entry, state, member))
        throw new StoreError(
          "An object changed or is unavailable. This entire edit cannot be applied over newer edits, ownership changes, or a full scene.",
          409,
        );
      const payload = entry.payload,
        target = entry.targets[0]!;
      let next: TableState;
      if (payload.kind === "reorder") {
        const order = undo ? payload.before : payload.after;
        next = structuredClone(state);
        const objects = new Map(next.drawings.map((d) => [d.id, d]));
        next.drawings = order.map((id) => objects.get(id)!);
        next.drawings.find((d) => d.id === target.objectId)!.version += 1;
        next.revision += 1;
        next = tableSchema.parse(next);
      } else if (payload.kind === "shape-update") {
        next = structuredClone(state);
        const drawing = next.drawings.find((d) => d.id === target.objectId)!,
          saved = undo ? payload.before : payload.after;
        drawing.color = saved.color;
        if (saved.shapeStyle === null) delete drawing.shapeStyle;
        else drawing.shapeStyle = structuredClone(saved.shapeStyle);
        drawing.version += 1;
        next.revision += 1;
        next = tableSchema.parse(next);
      } else if (payload.kind === "text-update") {
        next = applyCommand(
          state,
          {
            id: command.id,
            type: "drawing.text.update",
            drawingId: target.objectId,
            expectedVersion: target.expectedVersion,
            changes: undo ? payload.before : payload.after,
          },
          member,
        );
      } else if (payload.kind === "resize-many") {
        next = structuredClone(state);
        for (const change of payload.changes) {
          const geometry = undo ? change.before : change.after;
          if (change.objectType === "token" && "position" in geometry) {
            const token = next.tokens.find((t) => t.id === change.objectId)!;
            token.position = { ...geometry.position };
            token.radius = geometry.radius;
            token.version += 1;
          } else if (Array.isArray(geometry)) {
            const drawing = next.drawings.find(
              (d) => d.id === change.objectId,
            )!;
            drawing.points = structuredClone(geometry);
            drawing.version += 1;
          } else throw new Error("Invalid resized geometry.");
        }
        next.revision += 1;
        next = tableSchema.parse(next);
      } else if (payload.kind === "token-resize") {
        next = applyCommand(
          state,
          {
            id: command.id,
            type: "token.resize",
            tokenId: target.objectId,
            expectedVersion: target.expectedVersion,
            radius: undo ? payload.before : payload.after,
          },
          member,
        );
      } else if (payload.kind === "resize") {
        next = structuredClone(state);
        const drawing = next.drawings.find((d) => d.id === target.objectId)!;
        drawing.points = structuredClone(undo ? payload.before : payload.after);
        drawing.version += 1;
        next.revision += 1;
        next = tableSchema.parse(next);
      } else if (payload.kind === "delete-many") {
        if (expectsPresent(entry))
          next = applyCommand(
            state,
            {
              id: command.id,
              type: "objects.delete",
              objects: entry.targets.map((target) => ({
                objectId: target.objectId,
                expectedVersion: target.expectedVersion,
              })),
            },
            member,
          );
        else {
          next = structuredClone(state);
          for (const saved of payload.objects) {
            const version =
              entry.targets.find(
                (target) => target.objectId === saved.object.id,
              )!.expectedVersion + 1;
            if (saved.objectType === "token")
              next.tokens.push({ ...saved.object, version });
            else next.drawings.push({ ...saved.object, version });
          }
          next.revision += 1;
          next = tableSchema.parse(next);
        }
      } else if (payload.kind === "translate") {
        // Restore exact originals; redo repeats the original addition rather than
        // subtracting from rounded coordinates. Ownership/style remain untouched.
        next = structuredClone(state);
        const point = (point: { x: number; y: number }) =>
          undo
            ? { ...point }
            : { x: point.x + payload.delta.x, y: point.y + payload.delta.y };
        for (const original of payload.originals) {
          if (original.objectType === "token") {
            const object = next.tokens.find(
              (object) => object.id === original.objectId,
            );
            if (!object)
              throw new Error("Translated history type is inconsistent.");
            object.position = point(original.position);
            object.version += 1;
          } else {
            const object = next.drawings.find(
              (object) => object.id === original.objectId,
            );
            if (!object)
              throw new Error("Translated history type is inconsistent.");
            object.points = original.points.map(point);
            object.version += 1;
          }
        }
        next.revision += 1;
        next = tableSchema.parse(next);
      } else if (payload.kind === "move-many")
        next = applyCommand(
          state,
          {
            id: command.id,
            type: "tokens.move",
            moves: payload.moves.map((move) => ({
              tokenId: move.objectId,
              position: undo ? move.before : move.after,
              expectedVersion: entry.targets.find(
                (target) => target.objectId === move.objectId,
              )!.expectedVersion,
            })),
          },
          member,
        );
      else if (payload.kind === "move")
        next = applyCommand(
          state,
          {
            id: command.id,
            type: "token.move",
            tokenId: target.objectId,
            expectedVersion: target.expectedVersion,
            position: undo ? payload.before : payload.after,
          },
          member,
        );
      else if (expectsPresent(entry))
        next = applyCommand(
          state,
          {
            id: command.id,
            type: "object.delete",
            objectId: target.objectId,
            expectedVersion: target.expectedVersion,
          },
          member,
        );
      else {
        next = structuredClone(state);
        if (payload.objectType === "token")
          next.tokens.push({
            ...payload.object,
            version: target.expectedVersion + 1,
          });
        else
          next.drawings.push({
            ...payload.object,
            version: target.expectedVersion + 1,
          });
        next.revision += 1;
        next = tableSchema.parse(next);
      }
      const advanced = entry.targets.map((target) => ({
        ...target,
        expectedVersion: target.expectedVersion + 1,
      }));
      this.db
        .prepare(
          "UPDATE scene_history_entries SET state=?,version=version+1,targets_json=? WHERE id=?",
        )
        .run(undo ? "undone" : "done", JSON.stringify(advanced), entry.id);
      // Rebase only the causal target links, even when a neighboring edit affects
      // several objects. One conflicted target still blocks that entire neighbor.
      for (const neighbor of this.links(
        member,
        campaign.activeSceneId,
        undo ? "done" : "undone",
      )) {
        let changed = false;
        const targets = neighbor.targets.map((target) => {
          const source = advanced.find(
            (source) =>
              source.objectId === target.objectId &&
              (undo
                ? source.previousId === neighbor.id
                : target.previousId === entry.id),
          );
          if (!source) return target;
          changed = true;
          return { ...target, expectedVersion: source.expectedVersion };
        });
        if (changed)
          this.db
            .prepare(
              "UPDATE scene_history_entries SET version=version+1,targets_json=? WHERE id=?",
            )
            .run(JSON.stringify(targetsSchema.parse(targets)), neighbor.id);
      }
      return next;
    });
  }
}
