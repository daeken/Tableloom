import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { ContentClient, contentDirty, contentStale } from "./content-client.js";
import type { ContentState } from "./content-client.js";
import { DocumentRequestError } from "./document-client.js";
import type { OwnedContentInstance } from "@tableloom/core/instances";
import type { ContentView } from "@tableloom/core/content";
import { previewBrowsers } from "../../../scripts/modules/definitions-client.js";
const module = previewBrowsers.dossier,
  member = {
    id: randomUUID(),
    tableId: randomUUID(),
    name: "Owner",
    role: "player" as const,
  };
const definition: ContentView = {
  reference: {
    packId: "preview-paper",
    packVersion: "0.0.0",
    definitionId: "blank",
  },
  campaignId: member.tableId,
  name: "Page",
  kind: "example",
  visibility: "public",
  revision: 0,
  overridden: false,
  system: { id: module.manifest.id, version: module.manifest.version },
  data: { text: "Blank" },
  sources: [],
  originSources: [],
};
const instance: OwnedContentInstance = {
  id: randomUUID(),
  campaignId: member.tableId,
  ownerId: member.id,
  name: "Page",
  kind: "example",
  visibility: "gm",
  system: definition.system,
  reference: definition.reference,
  definitionRevision: 0,
  schemaVersion: 1,
  version: 1,
  source: { name: "Page", kind: "example", data: definition.data, sources: [] },
  data: { inscription: "Blank", folded: false },
};
const metadata = () => {
  const { data, source, ...meta } = instance;
  void data;
  void source;
  return meta;
};
function fixture() {
  let view: ContentState,
    stored = structuredClone(instance),
    catalog = structuredClone(definition),
    fail: Error | null = null,
    patch: ((value: unknown) => unknown) | null = null;
  const requests: { path: string; body: unknown }[] = [];
  const client = new ContentClient(
    member,
    module,
    async (path, _signal, body) => {
      requests.push({ path, body });
      if (fail) throw fail;
      let result: unknown;
      if (path.includes("/content?")) {
        const { data, sources, originSources, ...meta } = catalog;
        void data;
        void sources;
        void originSources;
        result = { definitions: [meta], next: null };
      } else if (path.includes("/content/")) result = catalog;
      else if (path.includes("/instances?"))
        result = { instances: [metadata()], next: null };
      else if (path.endsWith("/instances")) result = stored;
      else if (body) {
        const b = body as {
          name: string;
          visibility: "gm" | "public";
          data: OwnedContentInstance["data"];
        };
        stored = {
          ...stored,
          name: b.name,
          visibility: b.visibility,
          data: b.data,
          version: stored.version + 1,
        };
        result = stored;
      } else result = stored;
      return patch ? patch(structuredClone(result)) : structuredClone(result);
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
    stored: (s: OwnedContentInstance) => {
      stored = s;
    },
    catalog: (d: ContentView) => {
      catalog = d;
    },
    fail: (e: Error | null) => {
      fail = e;
    },
    patch: (p: typeof patch) => {
      patch = p;
    },
  };
}
test("typed content controls render escaped arbitrary definition/state shapes with bounded parsing", () => {
  const adapter = module.content![0]!;
  assert.ok(
    renderToStaticMarkup(
      adapter.renderDefinition({ text: "<img onerror=bad>" }),
    ).includes("&lt;img"),
  );
  const html = renderToStaticMarkup(
    adapter.renderInstance({
      data: { inscription: "Saved", folded: true },
      readOnly: true,
      onChange: () => {
        throw new Error("read");
      },
    }),
  );
  assert.ok(/readonly=""/i.test(html));
  assert.ok(html.includes('checked=""'));
  assert.ok(html.includes('disabled=""'));
  assert.throws(() =>
    adapter.parseInstance({ inscription: "x".repeat(70000), folded: true }),
  );
  assert.throws(() => adapter.parseDefinition({ text: 12 }));
});
test("content drafts preserve private creation, immutable confirmations, changes and stale/discard transitions", async () => {
  const f = fixture();
  try {
    assert.equal(await f.client.refresh(), true);
    assert.equal(await f.client.openDefinition(definition.reference), true);
    assert.equal(await f.client.create(), true);
    assert.deepEqual(f.requests.at(-1)!.body, {
      reference: definition.reference,
      expectedRevision: 0,
    });
    f.client.change(
      { name: "Written page", data: { inscription: "Local", folded: true } },
      instance.id,
      1,
    );
    assert.ok(contentDirty(f.view()));
    assert.equal(await f.client.openDefinition(definition.reference), false);
    assert.equal(await f.client.save(), true);
    assert.equal(f.view().instance!.version, 2);
    assert.ok(!contentDirty(f.view()));
    f.client.change({ name: "Draft kept" }, instance.id, 2);
    f.stored({ ...f.view().instance!, name: "Remote", version: 3 });
    assert.equal(await f.client.refresh(), true);
    assert.ok(contentStale(f.view()));
    assert.equal(f.view().draft!.name, "Draft kept");
    assert.equal(await f.client.save(), false);
    f.client.change({ name: "Stale callback" }, instance.id, 2);
    assert.equal(f.view().draft!.name, "Draft kept");
    f.client.discard();
    assert.equal(f.view().draft!.name, "Remote");
    assert.ok(!contentDirty(f.view()));
    f.client.change({ name: "Wrong callback" }, randomUUID(), 3);
    assert.equal(f.view().draft!.name, "Remote");
  } finally {
    f.client.stop();
  }
});
test("content rejects private/cross-scope/malformed responses and immutable or unconfirmed writes without replay", async () => {
  for (const changed of [
    { ownerId: randomUUID() },
    { campaignId: randomUUID() },
    { schemaVersion: 3 },
    { reference: { ...instance.reference, packVersion: "9.9.9" } },
    { version: 3 },
  ]) {
    const f = fixture();
    try {
      await f.client.refresh();
      await f.client.openInstance(instance.id);
      f.client.change({ name: "Save" }, instance.id, 1);
      f.patch((value) => ({ ...(value as object), ...changed }));
      assert.equal(await f.client.save(), false);
      assert.equal(f.view().uncertain, true);
      assert.equal(f.view().draft!.name, "Save");
      const n = f.requests.length;
      assert.equal(await f.client.save(), false);
      assert.equal(f.requests.length, n);
    } finally {
      f.client.stop();
    }
  }
  const f = fixture();
  try {
    await f.client.refresh();
    await f.client.openInstance(instance.id);
    f.client.change({ name: "Kept" }, instance.id, 1);
    f.fail(new Error("lost connection"));
    assert.equal(await f.client.save(), false);
    assert.ok(f.view().uncertain);
    assert.equal(f.view().draft!.name, "Kept");
    f.fail(null);
    await f.client.refresh();
    assert.ok(!f.view().uncertain);
    assert.equal(f.view().draft!.name, "Kept");
    f.fail(new DocumentRequestError(404, "Unavailable"));
    await f.client.refresh();
    assert.equal(f.view().instance, null);
    assert.equal(f.view().draft, null);
  } finally {
    f.client.stop();
  }
});
test("shared non-owner copies are read-only; private definitions and mismatched provenance cannot become accepted creations", async () => {
  const f = fixture();
  try {
    await f.client.refresh();
    f.stored({ ...instance, ownerId: randomUUID(), visibility: "public" });
    await f.client.openInstance(instance.id);
    assert.equal(f.client.editable(), false);
    f.client.change({ name: "Forbidden" }, instance.id, 1);
    assert.equal(f.view().draft!.name, "Page");
    assert.equal(await f.client.save(), false);
    f.catalog({ ...definition, visibility: "gm" });
    assert.equal(await f.client.openDefinition(definition.reference), false);
    f.catalog(definition);
    await f.client.openDefinition(definition.reference);
    f.stored({
      ...instance,
      source: { ...instance.source, name: "Wrong original" },
    });
    assert.equal(await f.client.create(), false);
    assert.ok(f.view().uncertain);
  } finally {
    f.client.stop();
  }
});
test("retired content reads/writes never update a new scope or issue follow-up requests", async () => {
  for (const writing of [false, true]) {
    let resolve!: (value: unknown) => void,
      waiting = false,
      updates = 0,
      followups = 0;
    const f = fixture();
    await f.client.refresh();
    await f.client.openDefinition(definition.reference);
    await f.client.create();
    // A separate scoped client makes the unresolved flight explicit.
    const c = new ContentClient(
      member,
      module,
      async (path) => {
        if (waiting) {
          followups++;
          return new Promise((r) => {
            resolve = r;
          });
        }
        if (path.includes("/content?")) return { definitions: [], next: null };
        if (path.includes("/instances?")) return { instances: [], next: null };
        return path.includes("/content/") ? definition : instance;
      },
      () => {
        updates++;
      },
    );
    c.start();
    await c.refresh();
    await c.openDefinition(definition.reference);
    waiting = true;
    const pending = writing ? c.create() : c.refresh();
    assert.equal(followups, 1);
    c.stop();
    const stopped = updates;
    resolve(writing ? instance : { definitions: [], next: null });
    await pending;
    assert.equal(updates, stopped);
    assert.equal(followups, 1);
    c.stop();
    f.client.stop();
  }
});
test("content pagination preserves drafts, validates module fields and gates stale-definition creation", async () => {
  const f = fixture();
  try {
    await f.client.refresh();
    await f.client.openInstance(instance.id);
    f.client.change({ name: "Keep on page change" }, instance.id, 1);
    const after = randomUUID();
    await f.client.refresh("preview-paper@0.0.0:blank", after);
    assert.ok(f.requests.some((r) => r.path.includes(`after=${after}`)));
    assert.equal(f.view().draft!.name, "Keep on page change");
    f.client.change(
      { data: { inscription: 12, folded: false } },
      instance.id,
      1,
    );
    assert.ok(f.view().error);
    assert.deepEqual(f.view().draft!.data, instance.data);
    f.client.discard();
    await f.client.openDefinition(definition.reference);
    f.fail(new DocumentRequestError(409, "Definition changed"));
    assert.equal(await f.client.create(), false);
    assert.ok(!f.view().ready);
    assert.ok(f.view().uncertain);
  } finally {
    f.client.stop();
  }
});
