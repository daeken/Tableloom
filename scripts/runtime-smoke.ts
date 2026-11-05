import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  serverMessageSchema,
  commandSchema,
} from "@tableloom/core";
import type { CommandInput } from "@tableloom/core";
import type { CommandContext } from "@tableloom/core/campaigns";
import { accessStatusSchema } from "@tableloom/core/access";
import {
  campaignMembershipSchema,
  MAX_CAMPAIGNS,
} from "@tableloom/core/campaigns";
import { documentSchema } from "@tableloom/core/documents";
import { assetSchema } from "@tableloom/core/assets";
import { jpegFixture } from "../apps/server/src/jpeg-fixture.js";
import { pngFixture } from "../apps/server/src/png-fixture.js";
import { z } from "zod";
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const request = (url: string, path: string, cookie = "", body?: unknown) =>
  fetch(url + path, {
    signal: AbortSignal.timeout(5000),
    headers: {
      Origin: url,
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });
async function verifyCampaignExport(
  url: string,
  cookie: string,
  document: z.infer<typeof documentSchema>,
  campaignVersion: number,
  assetHash: string,
) {
  const path = `/api/campaigns/${document.campaignId}/export`,
    body = {
      expectedVersion: campaignVersion,
      include: "all-campaign-content-including-private",
    };
  assert.equal((await request(url, path, "", body)).status, 401);
  const response = await request(url, path, cookie, body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment;/,
  );
  const serialized = await response.text();
  const archive = z
    .object({
      format: z.literal("tableloom-campaign-export"),
      version: z.literal(1),
      privacy: z.literal("all-campaign-content-including-private"),
      identityPolicy: z.literal("source-identifiers-without-access-grants"),
      campaign: z.object({ id: z.uuid() }),
      records: z.object({
        module_documents: z.array(
          z.object({ id: z.uuid(), owner_id: z.uuid(), data_json: z.string() }),
        ),
        campaign_assets: z.array(
          z.object({ bytes: z.string(), sha256: z.string() }),
        ),
        scene_backgrounds: z.array(
          z.object({ history_cursor: z.number().int().positive() }),
        ),
        scene_background_history: z.array(z.object({ entry_json: z.string() })),
      }),
    })
    .parse(JSON.parse(serialized));
  const exported = archive.records.module_documents.find(
    (row) => row.id === document.id,
  );
  assert.ok(exported);
  assert.equal(exported.owner_id, document.ownerId);
  assert.deepEqual(JSON.parse(exported.data_json), document.data);
  assert.equal(archive.records.campaign_assets.length, 1);
  const image = archive.records.campaign_assets[0]!;
  assert.equal(hash(Buffer.from(image.bytes, "base64")), assetHash);
  assert.equal(image.sha256, assetHash);
  assert.equal(archive.records.scene_backgrounds.length, 1);
  assert.equal(archive.records.scene_background_history.length, 1);
  const preflight = await fetch(url + "/api/campaign-imports/preflight", {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: {
      Origin: url,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: serialized,
  });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get("cache-control"), "no-store");
  const report = z
    .object({
      status: z.literal("preflight-only"),
      importReady: z.literal(false),
      archiveSha256: z.string(),
      blockers: z.array(z.string()),
      pendingValidation: z.array(z.string()),
      imageValidation: z.object({
        checked: z.literal(1),
        pixels: z.number().int().positive(),
        pixelLimit: z.number().int().positive(),
      }),
      objectHistoryValidation: z.object({
        entries: z.literal(2),
        retainedLinks: z.literal(1),
        expiredLinks: z.literal(0),
      }),
      moduleReferenceValidation: z.object({
        records: z.literal(1),
        references: z.literal(0),
        complete: z.literal(true),
      }),
      destination: z.object({
        campaignCapacity: z.object({
          used: z.number().int().positive(),
          accessUsed: z.number().int().positive(),
          limit: z.literal(MAX_CAMPAIGNS),
        }),
      }),
      ownership: z.object({
        policy: z.literal("explicit-mapping-required"),
        subjects: z.array(z.object({ sourceId: z.uuid() })),
      }),
    })
    .parse(await preflight.json());
  assert.deepEqual(report.blockers, []);
  assert.ok(report.pendingValidation.includes("mapped-storage-quotas"));
  assert.ok(!report.pendingValidation.includes("full-storage-quotas"));
  assert.ok(!report.pendingValidation.includes("object-history-causal-graph"));
  assert.ok(report.pendingValidation.includes("mapped-history-graph"));
  assert.ok(!report.pendingValidation.includes("module-external-references"));
  assert.ok(report.pendingValidation.includes("mapped-module-references"));
  assert.ok(!report.pendingValidation.includes("history-causal-graph"));
  assert.ok(!report.pendingValidation.includes("image-decoding"));
  const originalPng = Buffer.from(image.bytes, "base64");
  assert.equal(
    report.imageValidation.pixels,
    originalPng.readUInt32BE(16) * originalPng.readUInt32BE(20),
  );
  assert.equal(
    report.archiveSha256,
    createHash("sha256").update(serialized).digest("hex"),
  );
  assert.ok(
    report.ownership.subjects.some(
      (subject) => subject.sourceId === document.ownerId,
    ),
  );
  const ownershipPlan = {
    version: 1,
    archiveSha256: report.archiveSha256,
    acknowledge: "reviewed-private-content-and-access",
    acknowledgeMerges: false,
    assignments: report.ownership.subjects.map((subject) => ({
      sourceId: subject.sourceId,
      target: { kind: "existing", userId: document.ownerId, role: "gm" },
    })),
  };
  const ownership = await request(
    url,
    "/api/campaign-imports/ownership-review",
    cookie,
    { file: serialized, plan: ownershipPlan },
  );
  assert.equal(ownership.status, 200);
  assert.equal(ownership.headers.get("cache-control"), "no-store");
  const reviewed = z
    .object({
      status: z.literal("ownership-review-only"),
      importReady: z.literal(false),
      blockers: z.array(z.string()).max(0),
      pendingValidation: z.array(z.string()),
      ownershipReview: z.object({
        complete: z.literal(true),
        planSha256: z.string().regex(/^[a-f0-9]{64}$/),
        counts: z.object({ memberships: z.literal(1), newUsers: z.literal(0) }),
      }),
    })
    .parse(await ownership.json());
  assert.ok(!reviewed.pendingValidation.includes("ownership-plan"));
  assert.ok(reviewed.pendingValidation.includes("resource-id-plan"));
  assert.ok(reviewed.pendingValidation.includes("atomic-import"));
  const preparation = await request(
    url,
    "/api/campaign-imports/prepare",
    cookie,
    {
      file: serialized,
      plan: ownershipPlan,
      resourcePolicy: "fresh-campaign-and-resource-identifiers",
    },
  );
  assert.equal(preparation.status, 200);
  const candidate = z
    .object({
      status: z.literal("candidate-preflight-only"),
      importReady: z.literal(false),
      blockers: z.array(z.unknown()).max(0),
      pendingValidation: z.array(z.string()),
      resourcePlan: z.object({
        complete: z.literal(true),
        targetCampaignId: z.uuid(),
        candidateSha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      candidateValidation: z.object({ complete: z.literal(true) }),
    })
    .parse(await preparation.json());
  assert.notEqual(candidate.resourcePlan.targetCampaignId, archive.campaign.id);
  assert.deepEqual(candidate.pendingValidation, ["atomic-import"]);
  const stalePlan = await request(
    url,
    "/api/campaign-imports/ownership-review",
    cookie,
    { file: serialized + "\n", plan: ownershipPlan },
  );
  assert.equal(
    stalePlan.status,
    409,
    "Ownership review must bind the exact source bytes",
  );
  await stalePlan.arrayBuffer();
  const modified = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(serialized));
  const records = z
    .object({ scene_backgrounds: z.array(z.record(z.string(), z.unknown())) })
    .passthrough()
    .parse(modified.records);
  records.scene_backgrounds[0]!.history_cursor = 0;
  modified.records = records;
  const denied = await fetch(url + "/api/campaign-imports/preflight", {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: {
      Origin: url,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(modified),
  });
  assert.equal(
    denied.status,
    400,
    "A forged map cursor must fail compiled preflight",
  );
  await denied.arrayBuffer();
  records.scene_backgrounds[0]!.history_cursor =
    archive.records.scene_backgrounds[0]!.history_cursor;
  const assets = z
    .array(z.record(z.string(), z.unknown()))
    .parse(records.campaign_assets);
  const malformed = pngFixture(
    originalPng.readUInt32BE(16),
    originalPng.readUInt32BE(20),
    { packed: Buffer.from([0x78, 0x9c, 0]) },
  );
  assets[0]!.bytes = malformed.toString("base64");
  assets[0]!.byte_length = malformed.length;
  assets[0]!.sha256 = hash(malformed);
  records.campaign_assets = assets;
  modified.records = records;
  const invalidImage = await request(
    url,
    "/api/campaign-imports/preflight",
    cookie,
    modified,
  );
  assert.equal(
    invalidImage.status,
    400,
    "A hash-consistent invalid PNG must fail compiled preflight",
  );
  assert.match(await invalidImage.text(), /PNG/);
  const invalidHistoryFile = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(serialized));
  const historyRecords = z
    .object({
      scene_history_entries: z.array(z.record(z.string(), z.unknown())),
    })
    .passthrough()
    .parse(invalidHistoryFile.records);
  const first = historyRecords.scene_history_entries[0]!;
  const targets = z
    .array(
      z.object({
        objectId: z.uuid(),
        expectedVersion: z.number().int().positive(),
        previousId: z.uuid().nullable(),
      }),
    )
    .parse(JSON.parse(z.string().parse(first.targets_json)));
  targets[0]!.previousId = z.uuid().parse(first.id);
  first.targets_json = JSON.stringify(targets);
  invalidHistoryFile.records = historyRecords;
  const invalidHistory = await request(
    url,
    "/api/campaign-imports/preflight",
    cookie,
    invalidHistoryFile,
  );
  assert.equal(
    invalidHistory.status,
    400,
    "A cyclic history link must fail compiled preflight",
  );
  await invalidHistory.arrayBuffer();
  return { file: serialized, plan: ownershipPlan };
}
async function runtimeCommand(
  socket: WebSocket,
  context: CommandContext,
  input: CommandInput,
) {
  const command = commandSchema.parse({ id: randomUUID(), ...input });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", receive);
      socket.off("error", failed);
      socket.off("close", closed);
    };
    const failed = () => {
      cleanup();
      reject(new Error("Runtime command connection failed"));
    };
    const closed = () => failed();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Runtime command acknowledgement timed out"));
    }, 5000);
    const receive = (raw: WebSocket.RawData) => {
      const message = serverMessageSchema.parse(JSON.parse(raw.toString()));
      if (message.type === "ack" && message.commandId === command.id) {
        cleanup();
        resolve();
      } else if (message.type === "error" && message.commandId === command.id) {
        cleanup();
        reject(new Error("Runtime command rejected"));
      }
    };
    socket.on("message", receive);
    socket.once("error", failed);
    socket.once("close", closed);
    socket.send(JSON.stringify({ context, command }));
  });
}
export async function verifyRuntimeHttp(url: string) {
  const health = await request(url, "/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    protocolVersion: PROTOCOL_VERSION,
  });
  const root = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(root.status, 200);
  const asset = (await root.text()).match(/src="([^"]*\/assets\/[^"]+)"/)?.[1];
  assert.ok(asset, "Built HTML must reference its JavaScript");
  const code = await fetch(new URL(asset, url), {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(code.status, 200);
  assert.ok((await code.arrayBuffer()).byteLength > 0);
  assert.equal((await request(url, "/api/table")).status, 401);
}
export async function seedRuntime(url: string, hostKey: string) {
  await verifyRuntimeHttp(url);
  const setup = await request(url, "/api/access/setup", "", {
    key: hostKey,
    name: "Runtime check GM",
  });
  assert.equal(setup.status, 200);
  const member = accessStatusSchema.parse(await setup.json()).member;
  assert.ok(member);
  const cookie = setup.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const campaign = campaignMembershipSchema.parse(
    await (
      await request(url, `/api/campaigns/${member.tableId}`, cookie)
    ).json(),
  );
  const documents = `/api/campaigns/${member.tableId}/documents`;
  const response = await request(url, documents, cookie, {
    title: "Persisted runtime fixture",
    system: campaign.system,
  });
  assert.equal(response.status, 201);
  const document = documentSchema.parse(await response.json());
  const assets = `/api/campaigns/${member.tableId}/assets`;
  const uploaded = await fetch(`${url}${assets}?name=Runtime%20fixture`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: { Origin: url, Cookie: cookie, "Content-Type": "image/jpeg" },
    body: new Uint8Array(jpegFixture(16, 16)),
  });
  assert.equal(uploaded.status, 201);
  const asset = assetSchema.parse(await uploaded.json());
  const assetPath = `${assets}/${asset.id}/content`;
  const bytes = Buffer.from(
    await (await request(url, assetPath, cookie)).arrayBuffer(),
  );
  const map = await request(
    url,
    `/api/campaigns/${member.tableId}/scene-map/set`,
    cookie,
    {
      context: {
        campaignId: campaign.id,
        sceneId: campaign.activeSceneId,
        generation: campaign.version,
      },
      expectedVersion: 0,
      assetId: asset.id,
      position: { x: 0, y: 0 },
      width: 160,
    },
  );
  assert.equal(map.status, 200);
  await map.arrayBuffer();
  const socket = new WebSocket(
    url.replace(/^http/, "ws") +
      `/api/live?protocolVersion=${PROTOCOL_VERSION}`,
    { headers: { Cookie: cookie, Origin: url } },
  );
  try {
    const context = await new Promise<CommandContext>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Runtime WebSocket timed out")),
        5000,
      );
      socket.on("message", (raw) => {
        const parsed = serverMessageSchema.safeParse(
          JSON.parse(raw.toString()),
        );
        if (parsed.success && parsed.data.type === "snapshot") {
          clearTimeout(timer);
          resolve(parsed.data.context);
        }
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        reject(new Error("Runtime WebSocket closed before a snapshot"));
      });
    });
    const tokenId = randomUUID();
    await runtimeCommand(socket, context, {
      type: "token.add",
      token: {
        id: tokenId,
        name: "Runtime history fixture",
        color: "#405f4d",
        position: { x: 0, y: 0 },
      },
    });
    await runtimeCommand(socket, context, {
      type: "token.move",
      tokenId,
      expectedVersion: 1,
      position: { x: 10, y: 5 },
    });
  } finally {
    socket.terminate();
  }
  const transfer = await verifyCampaignExport(
    url,
    cookie,
    document,
    campaign.version,
    hash(bytes),
  );
  const plan = {
    ...transfer.plan,
    assignments: transfer.plan.assignments.map(({ sourceId }) => ({
      sourceId,
      target: { kind: "unclaimed" },
    })),
  };
  const review = await request(
    url,
    "/api/campaign-imports/ownership-review",
    cookie,
    {
      file: transfer.file,
      plan,
    },
  );
  assert.equal(review.status, 200);
  const { ownershipReview } = z
    .object({ ownershipReview: z.object({ planSha256: z.string() }) })
    .parse(await review.json());
  const importRequest = {
    file: transfer.file,
    plan,
    expectedPlanSha256: ownershipReview.planSha256,
    resourcePolicy: "fresh-campaign-and-resource-identifiers",
    requestId: randomUUID(),
    confirm: "create-new-campaign",
  };
  const imported = await request(
    url,
    "/api/campaign-imports/import",
    cookie,
    importRequest,
  );
  assert.equal(imported.status, 201);
  assert.equal(imported.headers.get("set-cookie"), null);
  const result = z
    .object({
      status: z.literal("imported"),
      replayed: z.literal(false),
      campaign: campaignMembershipSchema,
      summary: z.object({
        createdPeople: z.literal(0),
        attributionRecords: z.literal(1),
        memberships: z.literal(1),
      }),
    })
    .parse(await imported.json());
  assert.notEqual(result.campaign.id, campaign.id);
  // Use a separate recovered session to inspect the target without rotating the source session.
  const recovered = await request(url, "/api/access/recover", "", {
    key: hostKey,
  });
  assert.equal(recovered.status, 200);
  const recoveredCookie = recovered.headers.get("set-cookie")?.split(";")[0];
  assert.ok(recoveredCookie);
  const selected = await request(
    url,
    `/api/campaigns/${result.campaign.id}/select`,
    recoveredCookie,
    {},
  );
  assert.equal(selected.status, 200);
  const targetCookie = selected.headers.get("set-cookie")?.split(";")[0];
  assert.ok(targetCookie);
  try {
    const exported = await request(
      url,
      `/api/campaigns/${result.campaign.id}/export`,
      targetCookie,
      {
        expectedVersion: result.campaign.version,
        include: "all-campaign-content-including-private",
      },
    );
    assert.equal(exported.status, 200);
    const target = z
      .object({
        members: z.array(z.object({ id: z.uuid() })),
        records: z.object({
          module_documents: z.array(
            z.object({
              id: z.uuid(),
              owner_id: z.uuid(),
              data_json: z.string(),
            }),
          ),
          campaign_assets: z.array(z.object({ bytes: z.string() })),
          scene_history_entries: z.array(z.unknown()),
        }),
      })
      .parse(await exported.json());
    assert.equal(target.members.length, 1);
    assert.equal(target.members[0]!.id, document.ownerId);
    assert.equal(target.records.module_documents.length, 1);
    const copied = target.records.module_documents[0]!;
    assert.notEqual(copied.id, document.id);
    assert.notEqual(copied.owner_id, document.ownerId);
    assert.deepEqual(JSON.parse(copied.data_json), document.data);
    assert.equal(
      hash(Buffer.from(target.records.campaign_assets[0]!.bytes, "base64")),
      hash(bytes),
    );
    assert.equal(target.records.scene_history_entries.length, 2);
  } finally {
    const logout = await request(url, "/api/access/logout", targetCookie, {});
    assert.equal(logout.status, 200);
    await logout.arrayBuffer();
  }
  return {
    imported: { request: importRequest, campaignId: result.campaign.id },
    cookie,
    document,
    documentPath: `${documents}/${document.id}`,
    assetPath,
    assetHash: hash(bytes),
    campaignVersion: campaign.version,
  };
}
export async function verifyRuntimePersistence(
  url: string,
  state: Awaited<ReturnType<typeof seedRuntime>>,
) {
  await verifyRuntimeHttp(url);
  const response = await request(url, state.documentPath, state.cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(documentSchema.parse(await response.json()), state.document);
  const asset = await request(url, state.assetPath, state.cookie);
  assert.equal(asset.status, 200);
  assert.equal(hash(Buffer.from(await asset.arrayBuffer())), state.assetHash);
  await verifyCampaignExport(
    url,
    state.cookie,
    state.document,
    state.campaignVersion,
    state.assetHash,
  );
  const replay = await request(
    url,
    "/api/campaign-imports/import",
    state.cookie,
    state.imported.request,
  );
  assert.equal(
    replay.status,
    200,
    "A saved import retry must survive backup/restore and runtime replacement",
  );
  const result = z
    .object({
      status: z.literal("imported"),
      replayed: z.literal(true),
      campaign: campaignMembershipSchema,
    })
    .parse(await replay.json());
  assert.equal(result.campaign.id, state.imported.campaignId);
}
