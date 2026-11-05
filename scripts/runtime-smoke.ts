import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, serverMessageSchema } from "@tableloom/core";
import { accessStatusSchema } from "@tableloom/core/access";
import {
  campaignMembershipSchema,
  MAX_CAMPAIGNS,
} from "@tableloom/core/campaigns";
import { documentSchema } from "@tableloom/core/documents";
import { assetSchema } from "@tableloom/core/assets";
import { jpegFixture } from "../apps/server/src/jpeg-fixture.js";
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
      records: z.object({
        module_documents: z.array(
          z.object({ id: z.uuid(), owner_id: z.uuid(), data_json: z.string() }),
        ),
        campaign_assets: z.array(
          z.object({ bytes: z.string(), sha256: z.string() }),
        ),
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
  assert.equal(
    report.archiveSha256,
    createHash("sha256").update(serialized).digest("hex"),
  );
  assert.ok(
    report.ownership.subjects.some(
      (subject) => subject.sourceId === document.ownerId,
    ),
  );
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
  await verifyCampaignExport(
    url,
    cookie,
    document,
    campaign.version,
    hash(bytes),
  );
  const socket = new WebSocket(
    url.replace(/^http/, "ws") +
      `/api/live?protocolVersion=${PROTOCOL_VERSION}`,
    { headers: { Cookie: cookie, Origin: url } },
  );
  try {
    await new Promise<void>((resolve, reject) => {
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
          resolve();
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
  } finally {
    socket.terminate();
  }
  return {
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
}
