import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CampaignExportClient,
  MAX_EXPORT_DOWNLOAD_BYTES,
  type CampaignExportState,
  type ExportRequest,
} from "./campaign-export-client.js";

const member = {
    id: randomUUID(),
    tableId: randomUUID(),
    name: "GM",
    role: "gm" as const,
  },
  campaign = {
    id: member.tableId,
    activeSceneId: randomUUID(),
    name: "Private campaign",
    description: "GM plans",
    version: 3,
    system: { id: "kids-on-bikes", version: "0.1.0" },
    contentPacks: [],
    role: "gm" as const,
  },
  file = (settings = campaign) => {
    const { role: _role, ...metadata } = settings;
    return (
      JSON.stringify(
        {
          format: "tableloom-campaign-export",
          version: 1,
          privacy: "all-campaign-content-including-private",
          identityPolicy: "source-identifiers-without-access-grants",
          assetEncoding: "base64",
          campaign: metadata,
          records: { private: "SECRET café 🗺" },
        },
        null,
        2,
      ) + "\n"
    );
  },
  response = (
    value: string,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(value, {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...headers,
      },
    });
function fixture(
  request?: ExportRequest,
  role: "gm" | "player" = "gm",
  timeout = 30000,
) {
  let view: CampaignExportState;
  const calls: { path: string; init: RequestInit }[] = [];
  const client = new CampaignExportClient(
    { ...member, role },
    async (path, init) => {
      calls.push({ path, init });
      return request
        ? request(path, init)
        : response(init.method ? file() : JSON.stringify(campaign));
    },
    (value) => {
      view = value;
    },
    timeout,
  );
  client.start();
  return { client, calls, view: () => view! };
}

test("export needs a scoped GM review and explicit privacy acknowledgement; exact UTF-8 bytes and a local filename survive download", async () => {
  const f = fixture(async (_path, init) =>
    response(init.method ? file() : JSON.stringify(campaign), 200, {
      "content-disposition": 'attachment; filename="../../unsafe.html"',
    }),
  );
  try {
    assert.equal(await f.client.download(), false);
    assert.equal(f.calls.length, 0);
    assert.equal(await f.client.review(), true);
    assert.equal(await f.client.download(), false);
    f.client.acknowledge(true);
    assert.equal(await f.client.download(), true);
    const call = f.calls[1]!;
    assert.equal(call.path, `/api/campaigns/${campaign.id}/export`);
    assert.deepEqual(JSON.parse(String(call.init.body)), {
      expectedVersion: 3,
      include: "all-campaign-content-including-private",
    });
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.redirect, "error");
    const artifact = f.view().artifact!;
    assert.equal(artifact.filename, `tableloom-campaign-${campaign.id}.json`);
    assert.equal(artifact.bytes, Buffer.byteLength(file()));
    assert.equal(await artifact.blob.text(), file());
    assert.equal(artifact.blob.type, "application/json");
    f.client.acknowledge(false);
    assert.equal(f.view().artifact, null);
    assert.equal(await f.client.download(), false);
  } finally {
    f.client.stop();
  }
});

test("players cannot review or export, and mismatched campaigns or roles never enable confirmation", async () => {
  const player = fixture(undefined, "player");
  assert.equal(await player.client.review(), false);
  player.client.acknowledge(true);
  assert.equal(await player.client.download(), false);
  assert.equal(player.calls.length, 0);
  player.client.stop();
  for (const invalid of [
    { ...campaign, id: randomUUID() },
    { ...campaign, role: "player" },
  ]) {
    const f = fixture(async () => response(JSON.stringify(invalid)));
    try {
      assert.equal(await f.client.review(), false);
      f.client.acknowledge(true);
      assert.equal(await f.client.download(), false);
      assert.equal(f.view().campaign, null);
      assert.equal(f.view().acknowledged, false);
    } finally {
      f.client.stop();
    }
  }
});

test("changed campaign settings invalidate confirmation and require reviewing the new version before retry", async () => {
  let current = structuredClone(campaign);
  const f = fixture(async (_path, init) => {
    if (
      init.method &&
      JSON.parse(String(init.body)).expectedVersion !== current.version
    )
      return response('{"error":"SECRET stale"}', 409);
    return response(init.method ? file(current) : JSON.stringify(current));
  });
  try {
    await f.client.review();
    f.client.acknowledge(true);
    current = { ...current, name: "Updated name", version: 4 };
    assert.equal(await f.client.download(), false);
    assert.match(f.view().error, /settings changed/);
    assert.equal(f.view().campaign, null);
    assert.equal(f.view().acknowledged, false);
    assert.equal(await f.client.download(), false);
    assert.equal(await f.client.review(), true);
    assert.equal(f.view().campaign!.name, current.name);
    assert.equal(await f.client.download(), false);
    f.client.acknowledge(true);
    assert.equal(await f.client.download(), true);
    assert.equal(
      JSON.parse(String(f.calls.at(-1)!.init.body)).expectedVersion,
      4,
    );
  } finally {
    f.client.stop();
  }
});

test("sign-in, lost GM access, oversize and server failures clear private artifacts without rendering server errors", async () => {
  for (const status of [401, 403, 409, 413, 500]) {
    let failure = false;
    const f = fixture(async (_path, init) =>
      response(
        failure
          ? '{"error":"SECRET SQL internal"}'
          : init.method
            ? file()
            : JSON.stringify(campaign),
        failure ? status : 200,
      ),
    );
    try {
      await f.client.review();
      f.client.acknowledge(true);
      await f.client.download();
      assert.ok(f.view().artifact);
      failure = true;
      assert.equal(await f.client.download(), false);
      assert.equal(f.view().artifact, null);
      assert.equal(f.view().campaign, null);
      assert.equal(f.view().acknowledged, false);
      assert.ok(f.view().error);
      assert.ok(!f.view().error.includes("SECRET"));
    } finally {
      f.client.stop();
    }
  }
});

test("malformed, foreign-scope or changed export metadata and invalid UTF-8 are never offered as a file", async () => {
  const wrongScope = file({ ...campaign, id: randomUUID() }),
    changed = file({ ...campaign, version: 4 });
  for (const body of [
    "not JSON SECRET",
    file().replace("all-campaign-content-including-private", "public"),
    wrongScope,
    changed,
    new Uint8Array([0xff]),
  ]) {
    const f = fixture(async (_path, init) =>
      init.method
        ? new Response(body, {
            headers: { "content-type": "application/json" },
          })
        : response(JSON.stringify(campaign)),
    );
    try {
      await f.client.review();
      f.client.acknowledge(true);
      assert.equal(await f.client.download(), false);
      assert.equal(f.view().artifact, null);
      assert.ok(!f.view().error.includes("SECRET"));
    } finally {
      f.client.stop();
    }
  }
});

test("download checks both declared and streamed limits, content type, and cancels excess private bytes", async () => {
  let cancelled = false;
  const streamed = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_EXPORT_DOWNLOAD_BYTES + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  const cases = [
    () =>
      response(file(), 200, {
        "content-length": String(MAX_EXPORT_DOWNLOAD_BYTES + 1),
      }),
    () => response(file(), 200, { "content-type": "text/html" }),
    streamed,
  ];
  for (const exportResponse of cases) {
    const f = fixture(async (_path, init) =>
      init.method ? exportResponse() : response(JSON.stringify(campaign)),
    );
    try {
      await f.client.review();
      f.client.acknowledge(true);
      assert.equal(await f.client.download(), false);
      assert.equal(f.view().artifact, null);
    } finally {
      f.client.stop();
    }
  }
  assert.equal(cancelled, true);
});

test("closing or changing identity aborts a pending request and ignores late completion, without overlapping exports", async () => {
  let finish: ((value: Response) => void) | undefined;
  const f = fixture(async (_path, init) =>
    init.method
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : response(JSON.stringify(campaign)),
  );
  await f.client.review();
  f.client.acknowledge(true);
  const pending = f.client.download();
  assert.equal(await f.client.download(), false);
  assert.equal(await f.client.review(), false);
  assert.equal(f.calls.length, 2);
  const signal = f.calls[1]!.init.signal!;
  f.client.stop();
  assert.equal(signal.aborted, true);
  f.client.start();
  await f.client.review();
  finish!(response(file()));
  assert.equal(await pending, false);
  assert.equal(f.view().artifact, null);
  assert.equal(f.view().acknowledged, false);
  assert.equal(f.view().campaign!.id, campaign.id);
  f.client.stop();
});

test("timeouts require a new review and stop the in-flight request", async () => {
  const f = fixture(
    async (_path, init) =>
      init.method
        ? new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener(
              "abort",
              () => reject(new Error("SECRET timeout")),
              { once: true },
            );
          })
        : response(JSON.stringify(campaign)),
    "gm",
    20,
  );
  try {
    await f.client.review();
    f.client.acknowledge(true);
    assert.equal(await f.client.download(), false);
    assert.match(f.view().error, /timed out/);
    assert.equal(f.view().campaign, null);
    assert.equal(f.view().busy, null);
    assert.equal(f.view().acknowledged, false);
  } finally {
    f.client.stop();
  }
});
