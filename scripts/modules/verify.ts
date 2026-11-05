import assert from "node:assert/strict";
import { z } from "zod";
import { memberSchema } from "@tableloom/core/access";
import { createApp } from "../../apps/server/src/app.js";
import {
  DocumentClient,
  DocumentRequestError,
} from "../../apps/web/src/document-client.js";
import type { DocumentView } from "../../apps/web/src/document-client.js";
import { ContentClient } from "../../apps/web/src/content-client.js";
import type { ContentState } from "../../apps/web/src/content-client.js";
import { previewKinds } from "./shared.js";
import { previewBrowsers } from "./definitions-client.js";
import { serverCanary } from "./definitions-server.js";
import { createModulePreview } from "./preview-app.js";

/** Real HTTP plus the production document client; no mocked outcomes or game rules. */
export async function verifyModulePreview() {
  const { app, fixtures } = await createModulePreview();
  const reports = [];
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const raw = (path: string, cookie = "", body?: unknown, origin = url) =>
      fetch(url + path, {
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined
          ? {}
          : { method: "POST", body: JSON.stringify(body) }),
      });
    const session = async (fixture: string, role: string) => {
      const response = await raw("/api/preview/session", "", { fixture, role });
      assert.equal(response.status, 200);
      assert.ok(
        response.headers
          .get("set-cookie")!
          .startsWith("tableloom_preview_session="),
      );
      assert.equal(response.headers.getSetCookie().length, 1);
      const body = z
        .object({ member: memberSchema })
        .strict()
        .parse(await response.json());
      return {
        member: body.member,
        cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      };
    };
    for (const kind of previewKinds) {
      const fixture = fixtures.get(kind)!,
        owner = await session(kind, "owner");
      const root = `/api/campaigns/${owner.member.tableId}/documents`;
      assert.equal(
        (
          await raw(
            root,
            owner.cookie.replace(
              /^tableloom_preview_session=/,
              "tableloom_session=",
            ),
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await raw(
            root,
            `${owner.cookie}; tableloom_session=unrelated-real-instance`,
          )
        ).status,
        200,
      );
      assert.equal(
        (await raw(root, `${owner.cookie}; ${owner.cookie}`)).status,
        401,
      );
      const makeClient = (grant: typeof owner) => {
        let view: DocumentView;
        const client = new DocumentClient(
          grant.member,
          previewBrowsers[kind],
          async (path, signal, body) => {
            const response = await fetch(url + path, {
              signal,
              headers: {
                Cookie: grant.cookie,
                Origin: url,
                ...(body === undefined
                  ? {}
                  : { "Content-Type": "application/json" }),
              },
              ...(body === undefined
                ? {}
                : { method: "POST", body: JSON.stringify(body) }),
            });
            const json: unknown = await response.json();
            if (!response.ok)
              throw new DocumentRequestError(
                response.status,
                z.object({ error: z.string() }).parse(json).error,
              );
            return json;
          },
          (value) => {
            view = value;
          },
        );
        client.start();
        return { client, view: () => view! };
      };
      const f = makeClient(owner);
      try {
        assert.equal(await f.client.refresh(), true);
        assert.equal(f.view().documents.length, 2);
        assert.ok(!JSON.stringify(f.view()).includes(serverCanary));
        assert.equal(
          (await raw(`${root}/${fixture.gmPrivateId}`, owner.cookie)).status,
          404,
        );
        assert.equal(await f.client.open(fixture.sharedId), true);
        const tableBefore = await (
          await raw("/api/table", owner.cookie)
        ).text();
        if (kind === "dossier")
          f.client.change({
            data: { alias: "Edited dossier", notes: "  first   second  " },
          });
        else
          f.client.change({
            data: {
              heading: "Edited checklist",
              entries: [
                { label: "First", done: false },
                { label: "Second", done: false },
              ],
            },
          });
        assert.equal(f.client.actionsEnabled(), false);
        assert.equal(await f.client.save(), true);
        assert.equal(f.view().record?.version, 2);
        assert.equal(
          await f.client.act(
            fixture.sharedId,
            2,
            kind === "dossier" ? "notes.normalize" : "entry.toggle",
            kind === "dossier" ? null : { index: 0 },
          ),
          true,
        );
        assert.equal(f.view().record?.version, 3);
        const saved = f.view().record!;
        if (kind === "dossier")
          assert.deepEqual(saved.data, {
            alias: "Edited dossier",
            notes: "first second",
          });
        else
          assert.deepEqual(saved.data, {
            heading: "Edited checklist",
            entries: [
              { label: "First", done: true },
              { label: "Second", done: false },
            ],
          });
        const stale = await raw(
          `${root}/${fixture.sharedId}/actions`,
          owner.cookie,
          {
            expectedVersion: 2,
            action: kind === "dossier" ? "notes.normalize" : "entry.toggle",
            input: kind === "dossier" ? null : { index: 0 },
          },
        );
        assert.equal(stale.status, 409);
        const failed = await raw(
          `${root}/${fixture.sharedId}/actions`,
          owner.cookie,
          {
            expectedVersion: 3,
            action: kind === "dossier" ? "example.fail" : "entry.toggle",
            input: kind === "dossier" ? null : { index: 19 },
          },
        );
        assert.equal(failed.status, 400);
        assert.ok(!(await failed.text()).includes(serverCanary));
        assert.deepEqual(
          await (await raw(`${root}/${fixture.sharedId}`, owner.cookie)).json(),
          saved,
        );
        assert.equal(
          await (await raw("/api/table", owner.cookie)).text(),
          tableBefore,
        );
        const reader = await session(kind, "reader"),
          read = makeClient(reader);
        try {
          assert.equal(await read.client.refresh(), true);
          assert.equal(read.view().documents.length, 1);
          assert.equal(await read.client.open(fixture.sharedId), true);
          assert.equal(read.client.editable(), false);
          assert.equal(
            await read.client.act(fixture.sharedId, 3, "notes.normalize", null),
            false,
          );
          assert.equal(
            (await raw(`${root}/${fixture.privateId}`, reader.cookie)).status,
            404,
          );
          assert.equal(
            (await raw(`${root}/${fixture.gmPrivateId}`, reader.cookie)).status,
            404,
          );
          assert.equal(
            (
              await raw(`${root}/${fixture.sharedId}/actions`, reader.cookie, {
                expectedVersion: 3,
                action: "notes.normalize",
                input: null,
              })
            ).status,
            403,
          );
        } finally {
          read.client.stop();
        }
        const gm = await session(kind, "gm");
        const gmPage = await (await raw(root, gm.cookie)).json();
        assert.equal(gmPage.documents.length, 3);
        assert.ok(
          JSON.stringify(
            await (
              await raw(`${root}/${fixture.gmPrivateId}`, gm.cookie)
            ).json(),
          ).includes(serverCanary),
        );
        // Exercise the same catalog/copy client used by the live application's panel.
        const makeContent = (grant: typeof owner) => {
          let state: ContentState;
          const client = new ContentClient(
            grant.member,
            previewBrowsers[kind],
            async (path, signal, body) => {
              const response = await fetch(url + path, {
                signal,
                headers: {
                  Cookie: grant.cookie,
                  Origin: url,
                  ...(body === undefined
                    ? {}
                    : { "Content-Type": "application/json" }),
                },
                ...(body === undefined
                  ? {}
                  : { method: "POST", body: JSON.stringify(body) }),
              });
              const json: unknown = await response.json();
              if (!response.ok)
                throw new DocumentRequestError(
                  response.status,
                  z.object({ error: z.string() }).parse(json).error,
                );
              return json;
            },
            (value) => {
              state = value;
            },
          );
          client.start();
          return { client, view: () => state! };
        };
        const content = makeContent(owner),
          other = makeContent(reader);
        try {
          assert.equal(await content.client.refresh(), true);
          assert.equal(content.view().definitions.length, 1);
          assert.ok(!JSON.stringify(content.view()).includes(serverCanary));
          const reference = content.view().definitions[0]!.reference;
          assert.equal(await content.client.openDefinition(reference), true);
          assert.equal(await content.client.create(), true);
          const copy = content.view().instance!;
          assert.equal(copy.visibility, "gm");
          assert.equal(await other.client.refresh(), true);
          assert.equal(other.view().instances.length, 0);
          content.client.change(
            {
              visibility: "public",
              data:
                kind === "dossier"
                  ? { inscription: "Synthetic inscription", folded: true }
                  : { packed: [{ label: "Synthetic part", checked: true }] },
            },
            copy.id,
            copy.version,
          );
          assert.equal(await content.client.save(), true);
          const savedCopy = content.view().instance!;
          assert.deepEqual(savedCopy.source, copy.source);
          assert.equal(await other.client.refresh(), true);
          assert.equal(other.view().instances.length, 1);
          assert.equal(await other.client.openInstance(copy.id), true);
          assert.equal(other.client.editable(), false);
          assert.equal(await other.client.save(), false);
          const catalogRoot = `/api/campaigns/${owner.member.tableId}/content/${reference.packId}/${reference.packVersion}`;
          assert.equal(
            (await raw(`${catalogRoot}/private`, owner.cookie)).status,
            404,
          );
          assert.equal(
            (
              await raw(`${catalogRoot}/blank/override`, gm.cookie, {
                expectedRevision: 0,
                name: "Synthetic homebrew",
                visibility: "public",
                sources: [],
                data:
                  kind === "dossier"
                    ? { text: "Synthetic replacement" }
                    : { parts: ["Replacement part"] },
              })
            ).status,
            200,
          );
          assert.equal(await content.client.create(), false); // stale definition revision
          assert.equal(await content.client.refresh(), true);
          assert.deepEqual(content.view().instance, savedCopy);
          assert.equal(await content.client.create(), true);
          assert.equal(content.view().instance!.definitionRevision, 1);
          assert.equal(
            (
              await raw(`${catalogRoot}/blank/reset`, gm.cookie, {
                expectedRevision: 1,
              })
            ).status,
            200,
          );
          assert.equal(await content.client.refresh(), true);
          assert.equal(content.view().instance!.definitionRevision, 1);
        } finally {
          content.client.stop();
          other.client.stop();
        }
        reports.push({
          fixture: kind,
          version: saved.version,
          ownerVisible: 2,
          readerVisible: 1,
          gmVisible: 3,
          action: true,
          rollback: true,
          catalogAndCopies: true,
        });
      } finally {
        f.client.stop();
      }
    }
    assert.equal(
      (
        await raw(
          "/api/preview/session",
          "",
          { fixture: "dossier", role: "gm" },
          "https://foreign.invalid",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await raw("/api/preview/session", "", {
          fixture: "../import",
          role: "gm",
        })
      ).status,
      400,
    );
    return reports;
  } finally {
    await app.close();
  }
}

export async function verifyNormalStartupIsolation() {
  for (const name of ["", "bad; cookie"])
    await assert.rejects(() =>
      createApp({
        databasePath: ":memory:",
        hostKey: "invalid-cookie-fixture-not-a-real-key",
        sessionCookieName: name,
      }),
    );
  const app = await createApp({
    databasePath: ":memory:",
    hostKey: "normal-startup-isolation-key-not-a-real-key",
  });
  try {
    const post = (path: string, body: unknown, cookie = "") =>
      app.inject({
        method: "POST",
        url: `/api/${path}`,
        headers: {
          origin: "http://localhost",
          cookie,
          "content-type": "application/json",
        },
        payload: JSON.stringify(body),
      });
    const host = await post("access/setup", {
      key: "normal-startup-isolation-key-not-a-real-key",
      name: "GM",
    });
    const cookie = String(host.headers["set-cookie"]).split(";")[0]!;
    assert.equal(
      (
        await post(
          "preview/session",
          { fixture: "dossier", role: "gm" },
          cookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await post(
          "campaigns",
          {
            name: "Must not install",
            description: "",
            system: { id: "preview-dossier", version: "0.0.0" },
            contentPacks: [],
          },
          cookie,
        )
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
}
