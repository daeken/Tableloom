import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { system } from "@tableloom/cyberpunk-red";
import { documentData } from "@tableloom/module-sdk";
import type { BrowserSystem } from "@tableloom/module-sdk/browser";
import type { SystemDocument } from "@tableloom/core/documents";
import {
  DocumentClient,
  DocumentRequestError,
  documentDirty,
  documentStale,
} from "./document-client.js";
import type { DocumentView } from "./document-client.js";

const member = {
  id: randomUUID(),
  tableId: randomUUID(),
  role: "player" as const,
  name: "Alice",
};
const module: BrowserSystem = {
  manifest: system.manifest,
  documentVersion: 1,
  parse: (value) => documentData(system.documentSchema.parse(value)),
  renderSheet: () => null,
};
const record: SystemDocument = {
  id: randomUUID(),
  campaignId: member.tableId,
  ownerId: member.id,
  title: "Scout",
  visibility: "gm",
  system: { id: system.manifest.id, version: system.manifest.version },
  schemaVersion: 1,
  version: 1,
  data: { name: "Scout", notes: "Saved" },
};
const metadata = (r = record) => {
  const { data, ...m } = r;
  void data;
  return m;
};
const page = (r = record) => ({ documents: [metadata(r)], next: null });
function fixture() {
  const requests: {
    path: string;
    signal: AbortSignal;
    body: unknown;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  let state: DocumentView;
  const client = new DocumentClient(
    member,
    module,
    (path, signal, body) =>
      new Promise((resolve, reject) =>
        requests.push({ path, signal, body, resolve, reject }),
      ),
    (value) => {
      state = value;
    },
  );
  client.start();
  const latest = () => requests.at(-1)!;
  const ready = async () => {
    const p = client.refresh();
    latest().resolve(page());
    await p;
  };
  const open = async (r = record) => {
    const p = client.open(r.id);
    latest().resolve(r);
    await p;
  };
  const refresh = async (r = record) => {
    const p = client.refresh();
    latest().resolve(page(r));
    await Promise.resolve();
    await Promise.resolve();
    latest().resolve(r);
    await p;
  };
  return {
    client,
    requests,
    latest,
    state: () => state!,
    ready,
    open,
    refresh,
  };
}

test("sheet drafts survive refresh, detect remote conflicts and require explicit discard before versioned saves", async () => {
  const f = fixture();
  try {
    await f.ready();
    await f.open();
    f.client.change({ data: { name: "Scout", notes: "Local draft" } });
    assert.ok(documentDirty(f.state()));
    const remote = {
      ...record,
      version: 2,
      data: { name: "Scout", notes: "Remote saved" },
    };
    await f.refresh(remote);
    assert.deepEqual(f.state().draft?.data, {
      name: "Scout",
      notes: "Local draft",
    });
    assert.ok(documentStale(f.state()));
    const count = f.requests.length;
    assert.equal(await f.client.save(), false);
    assert.equal(f.requests.length, count);
    f.client.discard();
    assert.deepEqual(f.state().draft?.data, remote.data);
    assert.ok(!documentDirty(f.state()));
    f.client.change({ title: "New title" });
    const save = f.client.save();
    assert.equal(f.state().busy, true);
    assert.deepEqual(f.latest().body, {
      expectedVersion: 2,
      title: "New title",
      visibility: "gm",
      data: remote.data,
    });
    f.client.change({ title: "Ignored while saving" });
    assert.equal(await f.client.save(), false);
    f.latest().resolve({ ...remote, title: "New title", version: 3 });
    assert.equal(await save, true);
    assert.equal(f.state().record?.version, 3);
    assert.equal(f.state().draft?.title, "New title");
    assert.ok(!documentDirty(f.state()));
    assert.equal("data" in f.state().documents[0]!, false);
  } finally {
    f.client.stop();
  }
});

test("retired requests cannot cross reconnects or trigger follow-up reads; offline drafts stay local", async () => {
  const f = fixture();
  try {
    const old = f.client.refresh(),
      oldRequest = f.latest();
    f.client.stop();
    assert.ok(oldRequest.signal.aborted);
    f.client.start();
    const fresh = f.client.refresh();
    f.latest().resolve(page());
    await fresh;
    oldRequest.resolve({ documents: [], next: null });
    assert.equal(await old, false);
    assert.equal(f.state().documents.length, 1);
    await f.open();
    f.client.change({ title: "Kept offline" });
    const refreshing = f.client.refresh(),
      retired = f.latest();
    f.client.stop();
    f.client.start();
    retired.resolve(page());
    assert.equal(await refreshing, false);
    assert.equal(f.requests.at(-1), retired); // No selected-document fetch under a retired generation.
    assert.equal(f.state().draft?.title, "Kept offline");
    assert.equal(await f.client.save(), false);
    await f.refresh();
    assert.equal(f.state().draft?.title, "Kept offline");
  } finally {
    f.client.stop();
  }
});

test("response scope/pins/schema and private audiences are checked before displaying records", async () => {
  for (const bad of [
    { ...record, campaignId: randomUUID() },
    { ...record, system: { ...record.system, version: "9.9.9" } },
    {
      ...record,
      ownerId: randomUUID(),
      data: { name: "PRIVATE", notes: "PRIVATE" },
    },
    { ...record, schemaVersion: 2 },
    { ...record, id: randomUUID() },
  ]) {
    const f = fixture();
    try {
      await f.ready();
      const opened = f.client.open(record.id);
      f.latest().resolve(bad);
      assert.equal(await opened, false);
      assert.equal(f.state().record, null);
      assert.equal(f.state().ready, false);
      assert.ok(!JSON.stringify(f.state()).includes("PRIVATE"));
    } finally {
      f.client.stop();
    }
  }
  const f = fixture();
  try {
    const loaded = f.client.refresh();
    f.latest().resolve({
      documents: [metadata({ ...record, ownerId: randomUUID() })],
      next: null,
    });
    assert.equal(await loaded, false);
    assert.deepEqual(f.state().documents, []);
  } finally {
    f.client.stop();
  }
});

test("shared records are read-only for other players; permission loss clears record data and draft", async () => {
  const f = fixture();
  try {
    await f.ready();
    const publicRecord = {
      ...record,
      visibility: "public" as const,
      ownerId: randomUUID(),
    };
    await f.open(publicRecord);
    assert.equal(f.client.editable(), false);
    f.client.change({ title: "Stolen" });
    assert.equal(f.state().draft?.title, record.title);
    const count = f.requests.length;
    assert.equal(await f.client.save(), false);
    assert.equal(await f.client.act(record.id, 1, "example", null), false);
    assert.equal(f.requests.length, count);
    const refresh = f.client.refresh();
    f.latest().resolve(page(publicRecord));
    await Promise.resolve();
    await Promise.resolve();
    f.latest().reject(
      new DocumentRequestError(404, "That document is unavailable."),
    );
    await refresh;
    assert.equal(f.state().record, null);
    assert.equal(f.state().draft, null);
    assert.deepEqual(f.state().documents, []);
  } finally {
    f.client.stop();
  }
});

test("lost or conflicting save responses keep drafts, block writes until refresh and never replay", async () => {
  const f = fixture();
  try {
    await f.ready();
    await f.open();
    f.client.change({ title: "Unconfirmed" });
    const save = f.client.save();
    f.latest().reject(new Error("network lost"));
    assert.equal(await save, false);
    assert.equal(f.state().uncertain, true);
    assert.equal(f.state().draft?.title, "Unconfirmed");
    const count = f.requests.length;
    assert.equal(await f.client.save(), false);
    assert.equal(await f.client.create(), false);
    assert.equal(f.requests.length, count);
    await f.refresh({ ...record, title: "Unconfirmed", version: 2 });
    assert.ok(documentStale(f.state()));
    f.client.discard();
    f.client.change({ title: "Another draft" });
    const conflict = f.client.save();
    f.latest().reject(new DocumentRequestError(409, "Record changed."));
    assert.equal(await conflict, false);
    assert.equal(f.state().draft?.title, "Another draft");
    assert.equal(f.state().ready, false);
  } finally {
    f.client.stop();
  }
});

test("module actions require a clean current document and callbacks cannot alter a new version or selection", async () => {
  const f = fixture();
  try {
    await f.ready();
    await f.open();
    f.client.change({ title: "Draft" });
    const count = f.requests.length;
    assert.equal(await f.client.act(record.id, 1, "example", null), false);
    assert.equal(f.requests.length, count);
    f.client.discard();
    assert.equal(await f.client.act(record.id, 1, "../bad", null), false);
    assert.equal(f.state().uncertain, false);
    assert.equal(await f.client.act(record.id, 1, "example", NaN), false);
    assert.equal(f.requests.length, count);
    const action = f.client.act(record.id, 1, "example", { value: "request" });
    assert.deepEqual(f.latest().body, {
      expectedVersion: 1,
      action: "example",
      input: { value: "request" },
    });
    const updated = {
      ...record,
      version: 2,
      data: { name: "Scout", notes: "Server action result" },
    };
    f.latest().resolve(updated);
    assert.equal(await action, true);
    f.client.change({ title: "Old async callback" }, record.id, 1);
    assert.equal(f.state().draft?.title, record.title);
    assert.equal(await f.client.act(record.id, 1, "example", null), false);
    const other = { ...record, id: randomUUID() };
    await f.open(other);
    f.client.change({ title: "Wrong record" }, record.id, 2);
    assert.equal(f.state().record?.id, other.id);
    assert.equal(f.state().draft?.title, other.title);
    assert.equal(await f.client.act(record.id, 2, "example", null), false);
  } finally {
    f.client.stop();
  }
});

test("creation is private, single-flight and server-assigned; malformed confirmations do not discard drafts", async () => {
  const f = fixture();
  try {
    await f.ready();
    const created = f.client.create();
    assert.equal(await f.client.create(), false);
    assert.deepEqual(f.latest().body, {
      title: "Untitled character",
      visibility: "gm",
      system: record.system,
    });
    f.latest().resolve({ ...record, title: "Untitled character" });
    assert.equal(await created, true);
    assert.equal("data" in f.state().documents[0]!, false);
    f.client.change({ title: "Keep draft" });
    assert.equal(await f.client.open(randomUUID()), false);
    const save = f.client.save();
    f.latest().resolve({ ...record, title: "Keep draft", version: 9 });
    assert.equal(await save, false);
    assert.equal(f.state().draft?.title, "Keep draft");
    assert.equal(f.state().record?.version, 1);
    assert.equal(f.state().uncertain, true);
  } finally {
    f.client.stop();
  }
});

test("pagination retains the selected draft and invalid local fields fail before sending", async () => {
  const f = fixture();
  try {
    await f.ready();
    await f.open();
    f.client.change({ title: "" });
    const count = f.requests.length;
    assert.equal(await f.client.save(), false);
    assert.equal(f.requests.length, count);
    assert.equal(f.state().uncertain, false);
    const cursor = randomUUID(),
      paging = f.client.refresh(cursor);
    assert.ok(f.latest().path.endsWith(`after=${cursor}`));
    f.latest().resolve({ documents: [], next: null });
    await Promise.resolve();
    await Promise.resolve();
    f.latest().resolve(record);
    await paging;
    assert.equal(f.state().draft?.title, "");
    assert.equal(f.state().cursor, cursor);
    assert.equal(f.state().record?.id, record.id);
  } finally {
    f.client.stop();
  }
});
