import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  PackSelectionClient,
  packSelectionDirty,
  packSelectionStale,
} from "./pack-selection-client.js";
import type { PackSelectionState } from "./pack-selection-client.js";
import { previewBrowsers } from "../../../scripts/modules/definitions-client.js";
const module = previewBrowsers.dossier,
  member = {
    id: randomUUID(),
    tableId: randomUUID(),
    name: "GM",
    role: "gm" as const,
  },
  campaign = {
    id: member.tableId,
    activeSceneId: randomUUID(),
    version: 1,
    name: "Original",
    description: "Keep description",
    system: { id: module.manifest.id, version: module.manifest.version },
    contentPacks: [] as { id: string; version: string }[],
    role: "gm" as const,
  },
  pack = {
    id: "preview-paper",
    version: "0.0.0",
    systemId: module.manifest.id,
    systemVersion: module.manifest.version,
  };
function fixture() {
  let view: PackSelectionState,
    current = structuredClone(campaign),
    failure = false;
  const requests: { path: string; body: unknown }[] = [];
  const client = new PackSelectionClient(
    member,
    module,
    async (path, _signal, body) => {
      requests.push({ path, body });
      if (failure) throw new Error("lost");
      if (body) {
        const b = body as {
          settings: { contentPacks: typeof campaign.contentPacks };
        };
        current = {
          ...current,
          contentPacks: b.settings.contentPacks,
          version: current.version + 1,
        };
        return current;
      }
      return {
        campaign: current,
        packs: [pack, { ...pack, version: "0.0.1" }],
      };
    },
    (state) => {
      view = state;
    },
  );
  client.start();
  return {
    client,
    view: () => view!,
    requests,
    remote: () => {
      current = {
        ...current,
        name: "Remote name",
        version: current.version + 1,
      };
    },
    fail: () => {
      failure = true;
    },
  };
}
test("pack selection binds exact versions, preserves campaign settings, replaces duplicate pack IDs and reconciles conflicts", async () => {
  const f = fixture();
  try {
    assert.equal(await f.client.load(), true);
    f.client.toggle(pack.id, pack.version, true);
    f.client.toggle(pack.id, "0.0.1", true);
    assert.deepEqual(f.view().draft!.pins, [{ id: pack.id, version: "0.0.1" }]);
    assert.ok(packSelectionDirty(f.view()));
    assert.equal(await f.client.save(), true);
    assert.equal(f.view().current!.campaign.version, 2);
    assert.deepEqual(f.requests.at(-1)!.body, {
      expectedVersion: 1,
      settings: {
        name: campaign.name,
        description: campaign.description,
        system: campaign.system,
        contentPacks: [{ id: pack.id, version: "0.0.1" }],
      },
    });
    f.client.toggle(pack.id, "0.0.1", false);
    f.remote();
    await f.client.load();
    assert.ok(packSelectionStale(f.view()));
    assert.equal(f.view().draft!.pins.length, 0);
    assert.equal(await f.client.save(), false);
    f.client.discard();
    assert.equal(f.view().draft!.pins.length, 1);
    assert.equal(f.view().current!.campaign.name, "Remote name");
    f.client.toggle(pack.id, "0.0.1", false);
    f.fail();
    assert.equal(await f.client.save(), false);
    assert.equal(f.view().draft!.pins.length, 0);
    assert.equal(f.view().ready, false);
  } finally {
    f.client.stop();
  }
});
test("pack clients reject non-GM, foreign campaign/system metadata and late replies without writes or follow-up reads", async () => {
  for (const bad of [
    { ...campaign, id: randomUUID() },
    { ...campaign, role: "player" },
    { ...campaign, system: { ...campaign.system, version: "9.9.9" } },
  ]) {
    const client = new PackSelectionClient(
      member,
      module,
      async () => ({ campaign: bad, packs: [pack] }),
      () => {},
    );
    client.start();
    assert.equal(await client.load(), false);
    client.stop();
  }
  let calls = 0,
    resolve!: (v: unknown) => void,
    updates = 0;
  const player = new PackSelectionClient(
    { ...member, role: "player" },
    module,
    async () => {
      calls++;
      return {};
    },
    () => {},
  );
  player.start();
  assert.equal(await player.load(), false);
  assert.equal(calls, 0);
  player.stop();
  const client = new PackSelectionClient(
    member,
    module,
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    () => {
      updates++;
    },
  );
  client.start();
  const pending = client.load();
  client.stop();
  const stopped = updates;
  resolve({ campaign, packs: [pack] });
  await pending;
  assert.equal(updates, stopped);
  client.stop();
});
test("pack writes reject malformed confirmations and require refresh while retaining the selection draft", async () => {
  for (const fields of [
    { version: 50 },
    { name: "Unexpected rename" },
    { role: "player" },
    { id: randomUUID() },
    { contentPacks: [] },
  ]) {
    let view: PackSelectionState;
    const client = new PackSelectionClient(
      member,
      module,
      async (_path, _signal, body) =>
        body
          ? {
              ...campaign,
              version: 2,
              contentPacks: [{ id: pack.id, version: pack.version }],
              ...fields,
            }
          : { campaign, packs: [pack] },
      (state) => {
        view = state;
      },
    );
    client.start();
    try {
      await client.load();
      client.toggle(pack.id, pack.version, true);
      assert.equal(await client.save(), false);
      assert.equal(view!.ready, false);
      assert.equal(view!.draft!.pins.length, 1);
      assert.equal(await client.save(), false);
    } finally {
      client.stop();
    }
  }
});
