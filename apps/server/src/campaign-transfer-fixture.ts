// Synthetic campaign transfer fixture only; never imported by normal startup.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { commandSchema } from "@tableloom/core";
import { applyCommand } from "@tableloom/core/server";
import { transaction } from "./database.js";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { DocumentStore } from "./documents.js";
import { ContentCatalog, withContentMetadata } from "./content-catalog.js";
import { CampaignContentStore } from "./content.js";
import { ContentInstanceStore } from "./instances.js";
import { AssetStore } from "./assets.js";
import { SceneMapStore } from "./scene-map.js";
import { SceneGridStore } from "./scene-grid.js";
import { SceneHistoryStore } from "./scene-history.js";
import { CommandBindings } from "./command-bindings.js";
import { RollHistoryStore } from "./roll-history.js";
import { ChatStore } from "./chat.js";
import { installedModules } from "./modules.js";
import { instancePack } from "./instances-fixture.js";
import { pngFixture } from "./png-fixture.js";
import { exportCampaign } from "./campaign-export.js";

export const key = "campaign-export-test-not-a-real-private-key";
export const input = {
  expectedVersion: 1,
  include: "all-campaign-content-including-private",
} as const;
export function fixture(path = ":memory:") {
  const db = new DatabaseSync(path),
    pack = instancePack(),
    catalog = new ContentCatalog([pack]),
    tables = new TableStore(
      db,
      withContentMetadata(
        { systems: installedModules, contentPacks: [] },
        catalog,
      ),
    ),
    access = new AccessStore(db, key),
    gm = access.setupHost(key, "Export GM"),
    player = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Export player",
    ),
    documents = new DocumentStore(db, tables),
    content = new CampaignContentStore(db, tables, catalog),
    instances = new ContentInstanceStore(db, tables, catalog, content),
    history = new SceneHistoryStore(db, tables),
    assets = new AssetStore(db),
    maps = new SceneMapStore(db, tables, assets),
    grids = new SceneGridStore(db, tables),
    chat = new ChatStore(db, tables),
    bindings = new CommandBindings(db);
  const rolls = new RollHistoryStore(db, tables);
  const snapshot = () =>
    exportCampaign(db, tables, catalog, gm.member, {
      ...input,
      expectedVersion: tables.getCampaign().version,
    });
  return {
    db,
    pack,
    catalog,
    tables,
    access,
    gm,
    player,
    documents,
    content,
    instances,
    history,
    assets,
    maps,
    grids,
    chat,
    bindings,
    rolls,
    snapshot,
  };
}

export function populate(f: ReturnType<typeof fixture>) {
  const campaign = f.tables.getCampaign();
  f.tables.updateCampaign(campaign.id, campaign.version, {
    name: campaign.name,
    description: campaign.description,
    system: campaign.system,
    contentPacks: [{ id: f.pack.id, version: f.pack.version }],
  });
  const reference = {
    packId: f.pack.id,
    packVersion: f.pack.version,
    definitionId: "a-public",
  };
  f.content.override(f.gm.member, reference, {
    expectedRevision: 0,
    name: "Private override",
    visibility: "gm",
    data: { label: "PRIVATE OVERRIDE", tags: [] },
    sources: [],
  });
  const owned = f.instances.create(f.gm.member, {
    reference,
    expectedRevision: 1,
  });
  const doc = f.documents.create(f.player.member, {
    title: "PRIVATE RECORD",
    system: campaign.system,
    data: { name: "Synthetic", notes: "PRIVATE FIELD" },
  });
  const asset = f.assets.upload(f.gm.member, "PRIVATE MAP", pngFixture());
  const context = {
    campaignId: campaign.id,
    sceneId: campaign.activeSceneId,
    generation: f.tables.getCampaign().version,
  };
  f.maps.set(f.gm.member, {
    context,
    expectedVersion: 0,
    assetId: asset.id,
    position: { x: 0, y: 0 },
    width: 320,
  });
  f.grids.update(f.gm.member, {
    context,
    expectedVersion: 0,
    settings: { spacing: 75, origin: { x: 5, y: 7 }, visible: false },
  });
  f.chat.send(f.player.member, {
    id: randomUUID(),
    audience: "gm",
    body: "PRIVATE CHAT",
  });
  const command = commandSchema.parse({
    id: randomUUID(),
    type: "token.add",
    token: {
      id: randomUUID(),
      name: "PRIVATE OFFSTAGE TOKEN",
      color: "#405f4d",
      position: { x: 3, y: 9 },
    },
  });
  const before = f.tables.load(),
    after = applyCommand(before, command, f.player.member);
  transaction(f.db, () => {
    f.history.record(f.player.member, before, after, command);
    f.tables.save(after, command.id);
    f.bindings.bind(f.player.member.id, { context, command });
  });
  const rollCommand = commandSchema.parse({
    id: randomUUID(),
    type: "dice.roll",
    expression: "d6",
    visibility: "gm",
  });
  const rolled = applyCommand(f.tables.load(), rollCommand, f.player.member);
  f.tables.save(rolled, rollCommand.id);
  f.rolls.change(
    f.player.member,
    { ids: [rolled.rolls.at(-1)!.id] },
    "archive",
  );
  const noteCommand = commandSchema.parse({
    id: randomUUID(),
    type: "note.add",
    note: {
      id: randomUUID(),
      title: "PRIVATE NOTE",
      body: "Private notebook",
      visibility: "gm",
    },
  });
  transaction(f.db, () => {
    const before = f.tables.load(),
      after = applyCommand(before, noteCommand, f.player.member);
    f.history.record(f.player.member, before, after, noteCommand);
    f.tables.save(after, noteCommand.id);
  });
  const second = f.tables.createScene(campaign.id, { name: "Another scene" });
  f.tables.activateScene(
    campaign.id,
    second.id,
    f.tables.getCampaign().version,
  );
  const other = f.tables.createCampaign({
    name: "UNRELATED CAMPAIGN CANARY",
    description: "",
    system: campaign.system,
    contentPacks: [],
  });
  f.access.registerCampaign(f.gm.token, other.id);
  const otherGM = f.access.selectCampaign(f.gm.token, other.id);
  const outsider = f.access.redeemInvitation(
    f.access.createInvitation(otherGM.token).token,
    "UNRELATED PERSON",
  );
  f.documents.create(outsider.member, {
    title: "UNRELATED RECORD CANARY",
    system: campaign.system,
  });

  return { campaign, doc, owned, outsider };
}
