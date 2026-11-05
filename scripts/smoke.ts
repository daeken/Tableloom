import { jpegFixture } from "../apps/server/src/jpeg-fixture.js";
import { backgroundStateSchema } from "@tableloom/core/scene-map";
import { assetSchema, assetPageSchema } from "@tableloom/core/assets";
import { indexedMapFixture } from "../apps/server/src/png-fixture.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  campaignListSchema,
  campaignMembershipSchema,
} from "@tableloom/core/campaigns";
import { accessStatusSchema } from "@tableloom/core/access";
import { documentSchema, documentPageSchema } from "@tableloom/core/documents";
import {
  tableViewSchema,
  serverMessageSchema,
  PROTOCOL_VERSION,
} from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { rollArchivePageSchema } from "@tableloom/core/roll-history";
import { sceneSchema } from "@tableloom/core/campaigns";

function snapshot(
  socket: WebSocket,
  matches: (message: Extract<ServerMessage, { type: "snapshot" }>) => boolean,
) {
  return new Promise<Extract<ServerMessage, { type: "snapshot" }>>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Production live snapshot timed out"));
      }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("message", receive);
        socket.off("error", failed);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const receive = (raw: WebSocket.RawData) => {
        try {
          const message = serverMessageSchema.parse(JSON.parse(raw.toString()));
          if (message.type === "snapshot" && matches(message)) {
            cleanup();
            resolve(message);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      socket.on("message", receive);
      socket.on("error", failed);
    },
  );
}

function acknowledgement(socket: WebSocket, commandId: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Production command acknowledgement timed out"));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", receive);
    };
    const receive = (raw: WebSocket.RawData) => {
      const message = serverMessageSchema.parse(JSON.parse(raw.toString()));
      if (message.type === "ack" && message.commandId === commandId) {
        cleanup();
        resolve();
      } else if (message.type === "error" && message.commandId === commandId) {
        cleanup();
        reject(new Error(message.message));
      }
    };
    socket.on("message", receive);
  });
}

// Exercise the actual distribution: source tests cannot catch broken bundle imports.
const directory = await mkdtemp(join(tmpdir(), "tableloom-smoke-"));
const hostKey = "tableloom-production-smoke-key-never-use-outside-tests";
const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
  env: {
    ...process.env,
    PORT: "0",
    HOST: "127.0.0.1",
    DATA_DIR: directory,
    TABLELOOM_HOST_KEY: hostKey,
    PUBLIC_ORIGIN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
try {
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Production startup timed out: ${logs}`));
    }, 10000);
    child.stdout.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
      const address = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) {
        clearTimeout(timeout);
        resolve(address);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Production server exited (${code}): ${logs}`));
    });
  });
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as {
    status: string;
    protocolVersion: number;
  };
  assert.equal(healthBody.status, "ok");
  assert.equal(healthBody.protocolVersion, PROTOCOL_VERSION);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Tableloom/);
  const asset = html.match(/src="([^"]*\/assets\/[^"]+)"/)?.[1];
  assert.ok(asset, "Production HTML must reference its built JavaScript");
  const javascript = await fetch(new URL(asset, url));
  assert.equal(javascript.status, 200);
  assert.ok((await javascript.arrayBuffer()).byteLength > 0);
  assert.equal((await fetch(`${url}/api/table`)).status, 401);
  const setup = await fetch(`${url}/api/access/setup`, {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({ key: hostKey, name: "Smoke host" }),
  });
  assert.equal(setup.status, 200);
  await setup.json();
  const cookie = setup.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const table = await fetch(`${url}/api/table`, {
    headers: { Cookie: cookie },
  });
  assert.equal(table.status, 200);
  await table.json();
  const campaigns = await fetch(`${url}/api/campaigns`, {
    headers: { Cookie: cookie },
  });
  assert.equal(campaigns.status, 200);
  assert.equal(campaignListSchema.parse(await campaigns.json()).length, 1);
  const created = await fetch(`${url}/api/campaigns`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: url,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Smoke campaign",
      description: "",
      system: { id: "kids-on-brooms", version: "0.1.0" },
      contentPacks: [],
    }),
  });
  assert.equal(created.status, 201);
  const campaign = campaignMembershipSchema.parse(await created.json());
  const selected = await fetch(`${url}/api/campaigns/${campaign.id}/select`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: url,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(selected.status, 200);
  assert.equal(
    accessStatusSchema.parse(await selected.json()).member?.tableId,
    campaign.id,
  );
  const nextCookie = selected.headers.get("set-cookie")?.split(";")[0];
  assert.ok(nextCookie);
  const selectedTable = await fetch(`${url}/api/table`, {
    headers: { Cookie: nextCookie },
  });
  assert.equal(selectedTable.status, 200);
  assert.equal(
    tableViewSchema.parse(await selectedTable.json()).systemId,
    "kids-on-brooms",
  );
  const documentRoot = `${url}/api/campaigns/${campaign.id}/documents`;
  const documentHeaders = {
    Cookie: nextCookie,
    Origin: url,
    "Content-Type": "application/json",
  };
  const documentCreated = await fetch(documentRoot, {
    method: "POST",
    headers: documentHeaders,
    body: JSON.stringify({ title: "Smoke scaffold", system: campaign.system }),
  });
  assert.equal(documentCreated.status, 201);
  const document = documentSchema.parse(await documentCreated.json());
  assert.deepEqual(document.data, { name: "", notes: "" });
  const documentList = await fetch(documentRoot, {
    headers: { Cookie: nextCookie },
  });
  assert.equal(documentList.status, 200);
  assert.equal(
    documentPageSchema.parse(await documentList.json()).documents[0]?.id,
    document.id,
  );
  const documentEdited = await fetch(`${documentRoot}/${document.id}`, {
    method: "POST",
    headers: documentHeaders,
    body: JSON.stringify({
      expectedVersion: 1,
      title: document.title,
      visibility: "gm",
      data: { name: "Scout", notes: "Smoke fixture only" },
    }),
  });
  assert.equal(documentEdited.status, 200);
  const savedDocument = documentSchema.parse(await documentEdited.json());
  assert.equal(savedDocument.version, 2);
  const documentRead = await fetch(`${documentRoot}/${document.id}`, {
    headers: { Cookie: nextCookie },
  });
  assert.equal(documentRead.status, 200);
  assert.deepEqual(
    documentSchema.parse(await documentRead.json()),
    savedDocument,
  );
  const documentDeleted = await fetch(`${documentRoot}/${document.id}/delete`, {
    method: "POST",
    headers: documentHeaders,
    body: JSON.stringify({ expectedVersion: 2 }),
  });
  assert.equal(documentDeleted.status, 200);
  await documentDeleted.json();
  const previousTable = await fetch(`${url}/api/table`, {
    headers: { Cookie: cookie },
  });
  assert.equal(previousTable.status, 401);
  await previousTable.text();
  const sceneResponse = await fetch(
    `${url}/api/campaigns/${campaign.id}/scenes`,
    {
      method: "POST",
      headers: {
        Cookie: nextCookie,
        Origin: url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Smoke battlefield" }),
    },
  );
  assert.equal(sceneResponse.status, 201);
  const scene = sceneSchema.parse(await sceneResponse.json());
  const activated = await fetch(
    `${url}/api/campaigns/${campaign.id}/activate`,
    {
      method: "POST",
      headers: {
        Cookie: nextCookie,
        Origin: url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sceneId: scene.id,
        expectedVersion: campaign.version,
      }),
    },
  );
  assert.equal(activated.status, 200);
  await activated.json();
  const live = new WebSocket(
    `${url.replace("http", "ws")}/api/live?campaignId=${campaign.id}&protocolVersion=${PROTOCOL_VERSION}`,
    { headers: { Cookie: nextCookie, Origin: url } },
  );
  try {
    const opened = snapshot(live, () => true);
    await once(live, "open");
    const current = await opened;
    assert.equal(current.sceneName, scene.name);
    const rolled = snapshot(
      live,
      (message) => message.state.rolls.length === 1,
    );
    const commandId = randomUUID(),
      confirmed = acknowledgement(live, commandId);
    live.send(
      JSON.stringify({
        context: current.context,
        command: { id: commandId, type: "dice.roll", expression: "d6" },
      }),
    );
    await confirmed;
    const result = (await rolled).state.rolls[0]!;
    assert.equal(result.expression, "1d6");
    const tokenId = randomUUID(),
      addId = randomUUID();
    const added = acknowledgement(live, addId);
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: addId,
          type: "token.add",
          token: {
            id: tokenId,
            name: "Smoke scout",
            position: { x: 10, y: 20 },
            color: "#405f4d",
          },
        },
      }),
    );
    await added;
    const moveId = randomUUID(),
      moved = acknowledgement(live, moveId);
    const movedView = snapshot(
      live,
      (message) => message.state.tokens[0]?.version === 2,
    );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: moveId,
          type: "token.move",
          tokenId,
          expectedVersion: 1,
          position: { x: 50, y: 60 },
        },
      }),
    );
    await moved;
    const movedSnapshot = await movedView;
    assert.deepEqual(movedSnapshot.state.tokens[0]?.position, {
      x: 50,
      y: 60,
    });
    let cursor = movedSnapshot.history.undo;
    assert.ok(cursor?.available);
    for (const type of ["scene.undo", "scene.redo"] as const) {
      assert.ok(cursor?.available);
      const id = randomUUID(),
        ack = acknowledgement(live, id);
      const view = snapshot(
        live,
        (message) =>
          message.state.tokens[0]?.version === (type === "scene.undo" ? 3 : 4),
      );
      live.send(
        JSON.stringify({
          context: current.context,
          command: {
            id,
            type,
            historyId: cursor.id,
            expectedVersion: cursor.version,
          },
        }),
      );
      await ack;
      const latest = await view;
      assert.deepEqual(
        latest.state.tokens[0]?.position,
        type === "scene.undo" ? { x: 10, y: 20 } : { x: 50, y: 60 },
      );
      cursor = latest.history.redo;
    }
    const secondToken = randomUUID(),
      secondAdd = randomUUID(),
      secondAck = acknowledgement(live, secondAdd);
    const secondView = snapshot(
      live,
      (message) => message.state.tokens.length === 2,
    );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: secondAdd,
          type: "token.add",
          token: {
            id: secondToken,
            name: "Smoke companion",
            color: "#405f4d",
            position: { x: 110, y: 60 },
          },
        },
      }),
    );
    await secondAck;
    await secondView;
    const groupId = randomUUID(),
      groupAck = acknowledgement(live, groupId);
    const groupView = snapshot(
      live,
      (message) =>
        message.history.undo?.objectCount === 2 &&
        message.state.tokens[0]?.version === 5,
    );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: groupId,
          type: "tokens.move",
          moves: [
            { tokenId, expectedVersion: 4, position: { x: 70, y: 80 } },
            {
              tokenId: secondToken,
              expectedVersion: 1,
              position: { x: 130, y: 80 },
            },
          ],
        },
      }),
    );
    await groupAck;
    let groupState = await groupView;
    for (const type of ["scene.undo", "scene.redo"] as const) {
      const edge =
        type === "scene.undo"
          ? groupState.history.undo!
          : groupState.history.redo!;
      const id = randomUUID(),
        ack = acknowledgement(live, id),
        view = snapshot(
          live,
          (message) =>
            message.state.tokens[0]?.version ===
            (type === "scene.undo" ? 6 : 7),
        );
      live.send(
        JSON.stringify({
          context: current.context,
          command: {
            id,
            type,
            historyId: edge.id,
            expectedVersion: edge.version,
          },
        }),
      );
      await ack;
      groupState = await view;
      assert.deepEqual(
        groupState.state.tokens.map((token) => token.position),
        type === "scene.undo"
          ? [
              { x: 50, y: 60 },
              { x: 110, y: 60 },
            ]
          : [
              { x: 70, y: 80 },
              { x: 130, y: 80 },
            ],
      );
    }
    const roomId = randomUUID(),
      roomAdd = randomUUID(),
      roomAck = acknowledgement(live, roomAdd);
    const roomView = snapshot(live, (message) =>
      message.state.drawings.some((drawing) => drawing.id === roomId),
    );
    const roomPoints = [
      { x: 10.1, y: 20.2 },
      { x: 40.3, y: 50.4 },
    ];
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: roomAdd,
          type: "drawing.add",
          drawing: {
            id: roomId,
            kind: "rectangle",
            points: roomPoints,
            color: "#405f4d",
          },
        },
      }),
    );
    await roomAck;
    await roomView;
    const mixedId = randomUUID(),
      mixedAck = acknowledgement(live, mixedId);
    const mixedView = snapshot(
      live,
      (message) =>
        message.history.undo?.objectType === "mixed" &&
        message.state.tokens.find((token) => token.id === tokenId)?.version ===
          8,
    );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: mixedId,
          type: "objects.move",
          objects: [
            { objectId: tokenId, expectedVersion: 7 },
            { objectId: roomId, expectedVersion: 1 },
          ],
          delta: { x: 10, y: 20 },
        },
      }),
    );
    await mixedAck;
    let mixedState = await mixedView;
    for (const type of ["scene.undo", "scene.redo"] as const) {
      const edge =
        type === "scene.undo"
          ? mixedState.history.undo!
          : mixedState.history.redo!;
      const id = randomUUID(),
        ack = acknowledgement(live, id),
        view = snapshot(
          live,
          (message) =>
            message.state.tokens.find((token) => token.id === tokenId)
              ?.version === (type === "scene.undo" ? 9 : 10),
        );
      live.send(
        JSON.stringify({
          context: current.context,
          command: {
            id,
            type,
            historyId: edge.id,
            expectedVersion: edge.version,
          },
        }),
      );
      await ack;
      mixedState = await view;
      assert.deepEqual(
        mixedState.state.drawings.find((drawing) => drawing.id === roomId)
          ?.points,
        type === "scene.undo"
          ? roomPoints
          : roomPoints.map((point) => ({ x: point.x + 10, y: point.y + 20 })),
      );
      assert.deepEqual(
        mixedState.state.tokens.find((token) => token.id === tokenId)?.position,
        type === "scene.undo" ? { x: 70, y: 80 } : { x: 80, y: 100 },
      );
    }
    const deleteId = randomUUID(),
      deleted = acknowledgement(live, deleteId);
    const deletedView = snapshot(
      live,
      (message) => message.history.undo?.action === "delete",
    );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: deleteId,
          type: "object.delete",
          objectId: tokenId,
          expectedVersion: 10,
        },
      }),
    );
    await deleted;
    const deletion = (await deletedView).history.undo!;
    const restoreId = randomUUID(),
      restored = acknowledgement(live, restoreId);
    const restoredView = snapshot(
      live,
      (message) =>
        message.state.tokens.find((token) => token.id === tokenId)?.version ===
        12,
    );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: restoreId,
          type: "scene.undo",
          historyId: deletion.id,
          expectedVersion: deletion.version,
        },
      }),
    );
    await restored;
    const restoreSnapshot = await restoredView;
    assert.ok(
      restoreSnapshot.state.tokens.some((token) => token.id === tokenId),
    );
    const redoDeletion = restoreSnapshot.history.redo!;
    const removeId = randomUUID(),
      removed = acknowledgement(live, removeId);
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: removeId,
          type: "scene.redo",
          historyId: redoDeletion.id,
          expectedVersion: redoDeletion.version,
        },
      }),
    );
    await removed;
    const batchDeleteId = randomUUID(),
      batchDeleteAck = acknowledgement(live, batchDeleteId);
    const batchDeletedView = snapshot(
      live,
      (message) =>
        message.state.tokens.length === 0 &&
        message.state.drawings.length === 0 &&
        message.history.undo?.objectCount === 2 &&
        message.history.undo.action === "delete",
    );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: batchDeleteId,
          type: "objects.delete",
          objects: [
            { objectId: secondToken, expectedVersion: 4 },
            { objectId: roomId, expectedVersion: 4 },
          ],
        },
      }),
    );
    await batchDeleteAck;
    let batchState = await batchDeletedView;
    for (const type of ["scene.undo", "scene.redo"] as const) {
      const edge =
          type === "scene.undo"
            ? batchState.history.undo!
            : batchState.history.redo!,
        id = randomUUID(),
        ack = acknowledgement(live, id);
      const view = snapshot(live, (message) =>
        type === "scene.undo"
          ? message.state.tokens.some(
              (token) => token.id === secondToken && token.version === 6,
            ) &&
            message.state.drawings.some(
              (drawing) => drawing.id === roomId && drawing.version === 6,
            )
          : message.state.tokens.length === 0 &&
            message.state.drawings.length === 0,
      );
      live.send(
        JSON.stringify({
          context: current.context,
          command: {
            id,
            type,
            historyId: edge.id,
            expectedVersion: edge.version,
          },
        }),
      );
      await ack;
      batchState = await view;
      if (type === "scene.undo") {
        assert.deepEqual(
          batchState.state.drawings[0]?.points,
          roomPoints.map((point) => ({ x: point.x + 10, y: point.y + 20 })),
        );
        assert.deepEqual(batchState.state.tokens[0]?.position, {
          x: 130,
          y: 80,
        });
      }
    }
    const resizedId = randomUUID(),
      resizedPoints = [
        { x: 0.1, y: 0.2 },
        { x: 10.3, y: 20.4 },
      ];
    const addResizeId = randomUUID(),
      addResizeAck = acknowledgement(live, addResizeId),
      addResizeView = snapshot(live, (message) =>
        message.state.drawings.some((d) => d.id === resizedId),
      );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: addResizeId,
          type: "drawing.add",
          drawing: {
            id: resizedId,
            kind: "rectangle",
            color: "#405f4d",
            points: resizedPoints,
          },
        },
      }),
    );
    await addResizeAck;
    await addResizeView;
    const resizeId = randomUUID(),
      resizeAck = acknowledgement(live, resizeId),
      resizedView = snapshot(live, (message) =>
        message.state.drawings.some(
          (d) => d.id === resizedId && d.version === 2,
        ),
      );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: resizeId,
          type: "drawing.resize",
          drawingId: resizedId,
          expectedVersion: 1,
          bounds: { left: -10, top: -20, right: 100, bottom: 200 },
        },
      }),
    );
    await resizeAck;
    let resizeState = await resizedView;
    const finalPoints = resizeState.state.drawings.find(
      (d) => d.id === resizedId,
    )!.points;
    assert.equal(resizeState.history.undo!.action, "resize");
    assert.deepEqual(finalPoints, [
      { x: -10, y: -20 },
      { x: 100, y: 200 },
    ]);
    for (const type of ["scene.undo", "scene.redo"] as const) {
      const edge =
          resizeState.history[type === "scene.undo" ? "undo" : "redo"]!,
        id = randomUUID(),
        ack = acknowledgement(live, id),
        view = snapshot(live, (message) =>
          message.state.drawings.some(
            (d) =>
              d.id === resizedId &&
              d.version === (type === "scene.undo" ? 3 : 4),
          ),
        );
      live.send(
        JSON.stringify({
          context: current.context,
          command: {
            id,
            type,
            historyId: edge.id,
            expectedVersion: edge.version,
          },
        }),
      );
      await ack;
      resizeState = await view;
      assert.deepEqual(
        resizeState.state.drawings.find((d) => d.id === resizedId)!.points,
        type === "scene.undo" ? resizedPoints : finalPoints,
      );
    }
    const sizeToken = randomUUID(),
      sizeAddId = randomUUID(),
      sizeAddAck = acknowledgement(live, sizeAddId),
      sizeAddView = snapshot(live, (message) =>
        message.state.tokens.some((t) => t.id === sizeToken),
      );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: sizeAddId,
          type: "token.add",
          token: {
            id: sizeToken,
            name: "Large scout",
            color: "#405f4d",
            position: { x: 90, y: 150 },
          },
        },
      }),
    );
    await sizeAddAck;
    await sizeAddView;
    const sizeId = randomUUID(),
      sizeAck = acknowledgement(live, sizeId),
      sizeView = snapshot(live, (message) =>
        message.state.tokens.some((t) => t.id === sizeToken && t.version === 2),
      );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: sizeId,
          type: "token.resize",
          tokenId: sizeToken,
          expectedVersion: 1,
          radius: 75.125,
        },
      }),
    );
    await sizeAck;
    let sizeState = await sizeView;
    assert.equal(
      sizeState.state.tokens.find((t) => t.id === sizeToken)!.radius,
      75.125,
    );
    for (const type of ["scene.undo", "scene.redo"] as const) {
      const edge = sizeState.history[type === "scene.undo" ? "undo" : "redo"]!,
        id = randomUUID(),
        ack = acknowledgement(live, id),
        view = snapshot(live, (message) =>
          message.state.tokens.some(
            (t) =>
              t.id === sizeToken &&
              t.version === (type === "scene.undo" ? 3 : 4),
          ),
        );
      live.send(
        JSON.stringify({
          context: current.context,
          command: {
            id,
            type,
            historyId: edge.id,
            expectedVersion: edge.version,
          },
        }),
      );
      await ack;
      sizeState = await view;
      const sized = sizeState.state.tokens.find((t) => t.id === sizeToken)!;
      assert.equal(sized.radius, type === "scene.undo" ? 24 : 75.125);
      assert.deepEqual(sized.position, { x: 90, y: 150 });
    }
    const resizeGroupId = randomUUID(),
      resizeGroupAck = acknowledgement(live, resizeGroupId),
      resizeGroupView = snapshot(
        live,
        (message) =>
          message.state.tokens.some(
            (t) => t.id === sizeToken && t.version === 5,
          ) &&
          message.state.drawings.some(
            (d) => d.id === resizedId && d.version === 5,
          ),
      );
    live.send(
      JSON.stringify({
        context: current.context,
        command: {
          id: resizeGroupId,
          type: "objects.resize",
          objects: [
            { objectId: sizeToken, expectedVersion: 4 },
            { objectId: resizedId, expectedVersion: 4 },
          ],
          scale: 1.25,
        },
      }),
    );
    await resizeGroupAck;
    let resizeGroupState = await resizeGroupView;
    const groupToken = resizeGroupState.state.tokens.find(
        (t) => t.id === sizeToken,
      )!,
      groupPoints = resizeGroupState.state.drawings.find(
        (d) => d.id === resizedId,
      )!.points;
    assert.equal(resizeGroupState.history.undo!.objectCount, 2);
    assert.equal(resizeGroupState.history.undo!.action, "resize");
    assert.equal(groupToken.radius, 75.125 * 1.25);
    for (const type of ["scene.undo", "scene.redo"] as const) {
      const edge =
          resizeGroupState.history[type === "scene.undo" ? "undo" : "redo"]!,
        id = randomUUID(),
        ack = acknowledgement(live, id),
        version = type === "scene.undo" ? 6 : 7,
        view = snapshot(
          live,
          (message) =>
            message.state.tokens.some(
              (t) => t.id === sizeToken && t.version === version,
            ) &&
            message.state.drawings.some(
              (d) => d.id === resizedId && d.version === version,
            ),
        );
      live.send(
        JSON.stringify({
          context: current.context,
          command: {
            id,
            type,
            historyId: edge.id,
            expectedVersion: edge.version,
          },
        }),
      );
      await ack;
      resizeGroupState = await view;
      const token = resizeGroupState.state.tokens.find(
        (t) => t.id === sizeToken,
      )!;
      assert.equal(
        token.radius,
        type === "scene.undo" ? 75.125 : groupToken.radius,
      );
      assert.deepEqual(
        token.position,
        type === "scene.undo" ? { x: 90, y: 150 } : groupToken.position,
      );
      assert.deepEqual(
        resizeGroupState.state.drawings.find((d) => d.id === resizedId)!.points,
        type === "scene.undo" ? finalPoints : groupPoints,
      );
    }
    const assetRoot = `${url}/api/campaigns/${campaign.id}/assets`,
      png = indexedMapFixture(),
      assetResponse = await fetch(
        `${assetRoot}?name=Private%20smoke%20map.png`,
        {
          method: "POST",
          headers: {
            Cookie: nextCookie,
            Origin: url,
            "Content-Type": "image/png",
          },
          body: new Uint8Array(png),
        },
      );
    assert.equal(assetResponse.status, 201);
    const asset = assetSchema.parse(await assetResponse.json());
    const assetPage = await fetch(assetRoot, {
      headers: { Cookie: nextCookie },
    });
    assert.equal(
      assetPageSchema.parse(await assetPage.json()).assets[0]!.id,
      asset.id,
    );
    const privateImage = await fetch(`${assetRoot}/${asset.id}/content`, {
      headers: { Cookie: nextCookie },
    });
    assert.equal(privateImage.status, 200);
    assert.equal(privateImage.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await privateImage.arrayBuffer()), png);
    const unauthenticatedImage = await fetch(
      `${assetRoot}/${asset.id}/content`,
    );
    assert.equal(unauthenticatedImage.status, 401);
    await unauthenticatedImage.text();
    const jpegUpload = await fetch(`${assetRoot}?name=Oriented%20JPEG.jpg`, {
      method: "POST",
      headers: {
        Cookie: nextCookie,
        Origin: url,
        "Content-Type": "image/jpeg",
      },
      body: new Uint8Array(jpegFixture(32, 24, 6)),
    });
    assert.equal(jpegUpload.status, 201);
    const normalized = assetSchema.parse(await jpegUpload.json());
    assert.equal(normalized.mimeType, "image/png");
    assert.equal(normalized.width, 24);
    assert.equal(normalized.height, 32);
    const normalizedDownload = await fetch(
      `${assetRoot}/${normalized.id}/content`,
      { headers: { Cookie: nextCookie } },
    );
    assert.equal(normalizedDownload.headers.get("content-type"), "image/png");
    const normalizedBytes = Buffer.from(await normalizedDownload.arrayBuffer());
    assert.equal(normalizedBytes.readUInt32BE(16), 24);
    assert.equal(normalizedBytes.readUInt32BE(20), 32);
    assert.ok(!normalizedBytes.includes(Buffer.from("Exif")));
    const removeNormalized = await fetch(
      `${assetRoot}/${normalized.id}/delete`,
      { method: "POST", headers: documentHeaders, body: "{}" },
    );
    assert.equal(removeNormalized.status, 200);
    await removeNormalized.json();
    const mapRoot = `${url}/api/campaigns/${campaign.id}/scene-map`,
      controls = await fetch(mapRoot, { headers: { Cookie: nextCookie } }),
      mapState = backgroundStateSchema.parse(await controls.json());
    const privateMapView = snapshot(
      live,
      (message) =>
        message.background?.visibility === "gm" &&
        message.backgroundVersion === 1,
    );
    const placeMap = await fetch(`${mapRoot}/set`, {
      method: "POST",
      headers: documentHeaders,
      body: JSON.stringify({
        context: mapState.context,
        expectedVersion: 0,
        assetId: asset.id,
        position: { x: 20, y: 30 },
        width: 320,
      }),
    });
    assert.equal(placeMap.status, 200);
    const placedMap = backgroundStateSchema.parse(await placeMap.json());
    assert.equal(
      (await privateMapView).background!.imageId,
      placedMap.map!.imageId,
    );
    const protectedMap = await fetch(
      `${mapRoot}/${mapState.context.sceneId}/${placedMap.map!.imageId}/content`,
      { headers: { Cookie: nextCookie } },
    );
    assert.equal(protectedMap.status, 200);
    assert.deepEqual(Buffer.from(await protectedMap.arrayBuffer()), png);
    const stillUsed = await fetch(`${assetRoot}/${asset.id}/delete`, {
      method: "POST",
      headers: documentHeaders,
      body: "{}",
    });
    assert.equal(stillUsed.status, 409);
    await stillUsed.json();
    const publicMapView = snapshot(
      live,
      (message) =>
        message.background?.visibility === "public" &&
        message.backgroundVersion === 2,
    );
    const revealMap = await fetch(`${mapRoot}/visibility`, {
      method: "POST",
      headers: documentHeaders,
      body: JSON.stringify({
        context: mapState.context,
        expectedVersion: 1,
        visibility: "public",
        acknowledgeReveal: true,
      }),
    });
    assert.equal(revealMap.status, 200);
    await revealMap.json();
    await publicMapView;
    const removedMapView = snapshot(
      live,
      (message) =>
        message.background === null && message.backgroundVersion === 3,
    );
    const removeMap = await fetch(`${mapRoot}/remove`, {
      method: "POST",
      headers: documentHeaders,
      body: JSON.stringify({ context: mapState.context, expectedVersion: 2 }),
    });
    assert.equal(removeMap.status, 200);
    const removedMapState = backgroundStateSchema.parse(await removeMap.json());
    await removedMapView;
    const undoMap = await fetch(`${mapRoot}/undo`, {
      method: "POST",
      headers: documentHeaders,
      body: JSON.stringify({
        context: mapState.context,
        expectedVersion: 3,
        entryId: removedMapState.history.undo!.id,
        acknowledgeReveal: true,
      }),
    });
    assert.equal(undoMap.status, 200);
    const undoneMapState = backgroundStateSchema.parse(await undoMap.json());
    assert.equal(undoneMapState.map!.visibility, "public");
    const redoMap = await fetch(`${mapRoot}/redo`, {
      method: "POST",
      headers: documentHeaders,
      body: JSON.stringify({
        context: mapState.context,
        expectedVersion: 4,
        entryId: undoneMapState.history.redo!.id,
      }),
    });
    assert.equal(redoMap.status, 200);
    await redoMap.json();
    const historyProtected = await fetch(`${assetRoot}/${asset.id}/delete`, {
      method: "POST",
      headers: documentHeaders,
      body: "{}",
    });
    assert.equal(historyProtected.status, 409);
    await historyProtected.json();
    const clearMaps = await fetch(`${mapRoot}/clear-history`, {
      method: "POST",
      headers: documentHeaders,
      body: JSON.stringify({
        context: mapState.context,
        expectedVersion: 5,
        acknowledgeClear: true,
      }),
    });
    assert.equal(clearMaps.status, 200);
    await clearMaps.json();
    const removedAsset = await fetch(`${assetRoot}/${asset.id}/delete`, {
      method: "POST",
      headers: documentHeaders,
      body: "{}",
    });
    assert.equal(removedAsset.status, 200);
    await removedAsset.json();
    const historyRoot = `${url}/api/campaigns/${campaign.id}/rolls`;
    const archived = await fetch(`${historyRoot}/archive`, {
      method: "POST",
      headers: documentHeaders,
      body: JSON.stringify({ ids: [result.id] }),
    });
    assert.equal(archived.status, 200);
    await archived.json();
    const archiveList = await fetch(`${historyRoot}/archive`, {
      headers: { Cookie: nextCookie },
    });
    assert.equal(archiveList.status, 200);
    assert.deepEqual(
      rollArchivePageSchema.parse(await archiveList.json()).entries[0]?.roll,
      result,
    );
    const cleaned = await fetch(`${historyRoot}/archive/delete`, {
      method: "POST",
      headers: documentHeaders,
      body: JSON.stringify({ ids: [result.id] }),
    });
    assert.equal(cleaned.status, 200);
    await cleaned.json();
  } finally {
    live.terminate();
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.kill();
    try {
      await once(child, "exit");
      assert.equal(child.exitCode, 0, `Server must shut down cleanly: ${logs}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "Production smoke check passed: built server/assets, authentication, campaigns, module document CRUD, scene activation, acknowledged live dice, versioned scene edits and durable move/create/delete/token-group/mixed/group-deletion/drawing-resize/token-size/group-resize history, private PNG/JPEG normalization and asset upload/list/download/removal and private/revealed scene backgrounds with durable map undo/redo and history asset protection, roll archive/cleanup, and clean shutdown.",
);
