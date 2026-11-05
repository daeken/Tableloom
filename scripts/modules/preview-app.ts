import { randomBytes } from "node:crypto";
import { createApp } from "../../apps/server/src/app.js";
import { installedModules } from "../../apps/server/src/modules.js";
import { documentSystems } from "../../apps/server/src/document-modules.js";
import { documentSchema } from "@tableloom/core/documents";
import { accessStatusSchema } from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
import {
  previewKinds,
  previewSessionSchema,
  dossier,
  checklist,
} from "./shared.js";
import { previewServers, serverCanary } from "./definitions-server.js";

type Grant = { cookie: string; setCookie: string; member: Member };
/** Test/preview-only factory. Nothing here is imported by normal app startup. */
export async function createModulePreview(
  databasePath = ":memory:",
  webRoot?: string,
) {
  const hostKey = randomBytes(32).toString("base64url");
  const app = await createApp({
    databasePath,
    hostKey,
    sessionCookieName: "tableloom_preview_session",
    ...(webRoot ? { webRoot } : {}),
    catalog: {
      systems: [
        ...installedModules,
        ...Object.values(previewServers).map((s) => s.manifest),
      ],
      contentPacks: [],
    },
    documentSystems: [...documentSystems, ...Object.values(previewServers)],
  });
  const fixtures = new Map<
    string,
    {
      sessions: Record<"owner" | "reader" | "gm", Grant>;
      privateId: string;
      sharedId: string;
      gmPrivateId: string;
    }
  >();
  // Deliberate fixture role selection, available only in this disposable loopback harness.
  app.post("/api/preview/session", async (request, reply) => {
    const body = previewSessionSchema.parse(request.body),
      fixture = fixtures.get(body.fixture);
    if (!fixture)
      return reply.code(503).send({ error: "Preview is still starting." });
    const grant = fixture.sessions[body.role];
    reply.header("Set-Cookie", grant.setCookie);
    return { member: grant.member };
  });
  const post = async (path: string, body: unknown, cookie = "") => {
    const result = await app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: {
        origin: "http://localhost",
        cookie,
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
    if (result.statusCode >= 400)
      throw new Error(`Preview setup failed (${result.statusCode}): ${path}`);
    return result;
  };
  const grantOf = (response: {
    headers: Record<string, unknown>;
    json: () => unknown;
  }): Grant => {
    const member = accessStatusSchema.parse(response.json()).member;
    if (!member) throw new Error("Missing preview member");
    const setCookie = String(response.headers["set-cookie"]);
    return { member, setCookie, cookie: setCookie.split(";")[0]! };
  };
  try {
    const host = grantOf(
      await post("access/setup", { key: hostKey, name: "Preview GM" }),
    );
    for (const kind of previewKinds) {
      const system = previewServers[kind],
        pin = { id: system.manifest.id, version: system.manifest.version };
      const campaign = (
        await post(
          "campaigns",
          {
            name: system.manifest.name,
            description: "Temporary synthetic authoring fixture",
            system: pin,
            contentPacks: [],
          },
          host.cookie,
        )
      ).json();
      // Selection rotates its source session. Keep the seed host and other
      // fixture GM sessions valid by selecting through a fresh recovery session.
      const gmSource = grantOf(await post("access/recover", { key: hostKey }));
      const gm = grantOf(
        await post(`campaigns/${campaign.id}/select`, {}, gmSource.cookie),
      );
      const join = async (name: string) => {
        const code = (await post("access/invitations", {}, gm.cookie)).json()
          .token;
        return grantOf(await post("access/join", { name, code }));
      };
      const owner = await join("Preview owner"),
        reader = await join("Preview reader");
      const root = `campaigns/${campaign.id}/documents`;
      const make = async (
        title: string,
        visibility: "public" | "gm",
        who: Grant,
        data?: unknown,
      ) =>
        documentSchema.parse(
          (
            await post(
              root,
              {
                title,
                system: pin,
                visibility,
                ...(data === undefined ? {} : { data }),
              },
              who.cookie,
            )
          ).json(),
        );
      const privateDoc = await make("Owner private sample", "gm", owner),
        shared = await make("Shared sample", "public", owner);
      const gmData =
        kind === "dossier"
          ? { ...dossier.createDocument(), notes: serverCanary }
          : { ...checklist.createDocument(), heading: serverCanary };
      const gmPrivate = await make("GM private sample", "gm", gm, gmData);
      fixtures.set(kind, {
        sessions: { owner, reader, gm },
        privateId: privateDoc.id,
        sharedId: shared.id,
        gmPrivateId: gmPrivate.id,
      });
    }
    return { app, fixtures };
  } catch (error) {
    await app.close();
    throw error;
  }
}
