import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandSchema, type CommandInput } from "@tableloom/core";
import { applyCommand } from "@tableloom/core/server";
import { fixture } from "./campaign-transfer-fixture.js";
import { transaction } from "./database.js";
import { inspectCampaignTransfer } from "./campaign-preflight.js";
import {
  parseCampaignTransfer,
  type CampaignTransfer,
} from "./campaign-transfer-format.js";
import { installedModules } from "./modules.js";
import { documentSystems } from "./document-modules.js";
import { entryOf } from "./scene-history-model.js";
import { StoreError } from "./store.js";

function historyFixture() {
  const f = fixture();
  const run = (input: CommandInput, actor = f.player.member) =>
    transaction(f.db, () => {
      const command = commandSchema.parse({ id: randomUUID(), ...input }),
        before = f.tables.load(actor.tableId),
        next =
          command.type === "scene.undo" || command.type === "scene.redo"
            ? f.history.apply(actor, before, command)
            : applyCommand(before, command, actor);
      f.history.record(actor, before, next, command);
      f.tables.save(next, command.id, actor.tableId);
      return next;
    });
  const add = () => {
    const id = randomUUID();
    run({
      type: "token.add",
      token: { id, name: "Scout", color: "#405f4d", position: { x: 0, y: 0 } },
    });
    return id;
  };
  const move = (id: string, x: number, actor = f.player.member) =>
    run(
      {
        type: "token.move",
        tokenId: id,
        position: { x, y: 0 },
        expectedVersion: f.tables.load().tokens.find((t) => t.id === id)!
          .version,
      },
      actor,
    );
  const travel = (direction: "undo" | "redo") => {
    const edge = f.history.status(f.player.member)[direction]!;
    return run({
      type: direction === "undo" ? "scene.undo" : "scene.redo",
      historyId: edge.id,
      expectedVersion: edge.version,
    });
  };
  const inspect = (file = f.snapshot()) =>
    inspectCampaignTransfer(
      file,
      { systems: installedModules, contentPacks: f.catalog.metadata() },
      f.catalog,
      documentSystems,
      f.db,
    );
  const accepted = (file = f.snapshot()) => {
    const before = f.db.prepare("SELECT total_changes() AS n").get()!.n,
      report = inspect(file);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.importReady, false);
    assert.ok(
      !report.pendingValidation.includes("object-history-causal-graph"),
    );
    assert.ok(report.pendingValidation.includes("mapped-history-graph"));
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, before);
    assert.equal(f.db.isTransaction, false);
    return report.objectHistoryValidation;
  };
  return { ...f, run, add, move, travel, inspect, accepted };
}
function mutate(file: string, change: (a: CampaignTransfer) => void) {
  const a = parseCampaignTransfer(file);
  change(a);
  return JSON.stringify(a);
}
function link(a: CampaignTransfer, index: number, previousId: string | null) {
  const row = a.records.scene_history_entries[index]!,
    targets = entryOf(row).targets;
  targets[0]!.previousId = previousId;
  row.targets_json = JSON.stringify(targets);
}

test("object preflight accepts live mixed histories, split successors, undo/redo and branched edits without writes", () => {
  const f = historyFixture();
  try {
    const token = f.add(),
      drawing = randomUUID();
    f.run({
      type: "drawing.add",
      drawing: {
        id: drawing,
        kind: "rectangle",
        color: "#405f4d",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      },
    });
    f.run({
      type: "objects.move",
      objects: [
        { objectId: token, expectedVersion: 1 },
        { objectId: drawing, expectedVersion: 1 },
      ],
      delta: { x: 10, y: 20 },
    });
    f.move(token, 30);
    f.run({
      type: "objects.move",
      objects: [{ objectId: drawing, expectedVersion: 2 }],
      delta: { x: 20, y: 30 },
    });
    assert.deepEqual(f.accepted(), {
      entries: 5,
      retainedLinks: 4,
      expiredLinks: 0,
    });
    assert.deepEqual(
      f.accepted(
        mutate(f.snapshot(), (a) => {
          a.records.scene_history_entries.shift();
        }),
      ),
      { entries: 4, retainedLinks: 3, expiredLinks: 1 },
    );
    for (let i = 0; i < 5; i++) {
      f.travel("undo");
      f.accepted();
    }
    for (let i = 0; i < 5; i++) {
      f.travel("redo");
      f.accepted();
    }
    f.travel("undo");
    f.travel("undo");
    f.move(token, 70);
    assert.equal(f.accepted().entries, 4);
    f.accepted(
      mutate(f.snapshot(), (a) => a.records.scene_history_entries.reverse()),
    );
  } finally {
    f.db.close();
  }
});

test("object preflight preserves unavailable edges, retired actors, pruned links and empty history", () => {
  const f = historyFixture();
  try {
    assert.equal(f.accepted().entries, 0);
    const id = f.add();
    for (let i = 1; i <= 105; i++) f.move(id, i);
    assert.deepEqual(f.accepted(), {
      entries: 100,
      retainedLinks: 99,
      expiredLinks: 1,
    });
    f.move(id, 200, f.gm.member);
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    f.accepted();
    f.access.removeMember(f.gm.token, f.player.member.id);
    f.accepted();
  } finally {
    f.db.close();
  }
});

test("object preflight rejects cyclic, future, cross-scope, cross-object and forked retained links and broken stack state", () => {
  const f = historyFixture();
  try {
    const id = f.add();
    f.move(id, 10);
    f.add();
    f.move(id, 20);
    f.move(id, 30, f.gm.member);
    const file = f.snapshot(),
      secondScene = f.tables.createScene(f.tables.getCampaign().id, {
        name: "Second scene",
      });
    const cases: ((a: CampaignTransfer) => void)[] = [
      (a) => link(a, 1, a.records.scene_history_entries[1]!.id),
      (a) => link(a, 1, a.records.scene_history_entries[3]!.id),
      (a) => link(a, 3, a.records.scene_history_entries[2]!.id),
      (a) => {
        a.records.scene_history_entries[0]!.actor_id = f.gm.member.id;
      },
      (a) => {
        a.records.scene_history_entries[0]!.scene_id = secondScene.id;
      },
      (a) => link(a, 3, a.records.scene_history_entries[0]!.id),
      (a) => {
        a.records.scene_history_entries[0]!.state = "undone";
      },
    ];
    // Include the real second scene so the cross-scene case reaches graph validation.
    const source = parseCampaignTransfer(f.snapshot());
    source.records.scene_history_entries =
      parseCampaignTransfer(file).records.scene_history_entries;
    for (const change of cases) {
      const before = f.db.prepare("SELECT total_changes() AS n").get()!.n;
      assert.throws(
        () => f.inspect(mutate(JSON.stringify(source), change)),
        (error: unknown) =>
          error instanceof StoreError && error.statusCode === 400,
      );
      assert.equal(
        f.db.prepare("SELECT total_changes() AS n").get()!.n,
        before,
      );
    }
  } finally {
    f.db.close();
  }
});

test("object preflight rejects target kind changes and unreserved or wrong-kind saved order references", () => {
  const f = historyFixture();
  try {
    const first = f.add(),
      drawing = randomUUID(),
      unknown = randomUUID(),
      note = randomUUID();
    f.run({
      type: "note.add",
      note: { id: note, title: "Private", body: "Secret", visibility: "gm" },
    });
    f.run({
      type: "drawing.add",
      drawing: {
        id: drawing,
        kind: "rectangle",
        color: "#405f4d",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      },
    });
    f.move(first, 10);
    const file = f.snapshot();
    for (const payload of [
      {
        kind: "resize",
        objectType: "drawing",
        before: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        after: [
          { x: 10, y: 0 },
          { x: 20, y: 10 },
        ],
      },
      {
        kind: "reorder",
        objectType: "token",
        before: [first, unknown],
        after: [unknown, first],
      },
      {
        kind: "layer",
        objectType: "token",
        before: null,
        after: "above-drawings",
        order: [first, drawing],
        layers: ["between-drawings", "between-drawings"],
      },
    ]) {
      assert.throws(
        () =>
          f.inspect(
            mutate(file, (a) => {
              const row = a.records.scene_history_entries[2]!;
              row.payload_json = JSON.stringify(payload);
              entryOf(row); // This must reach graph validation, rather than fail payload parsing.
            }),
          ),
        (error: unknown) =>
          error instanceof StoreError && error.statusCode === 400,
      );
    }
    assert.throws(
      () =>
        f.inspect(
          mutate(file, (a) => {
            const row = a.records.scene_history_entries[0]!,
              payload = entryOf(row).payload;
            row.payload_json = JSON.stringify({
              ...payload,
              tokenOrder: [first, unknown],
            });
            entryOf(row);
          }),
        ),
      (error: unknown) =>
        error instanceof StoreError && error.statusCode === 400,
    );
    assert.throws(
      () =>
        f.inspect(
          mutate(file, (a) => {
            const row = a.records.scene_history_entries[2]!;
            row.payload_json = JSON.stringify({
              kind: "reorder",
              objectType: "token",
              before: [first, note],
              after: [note, first],
            });
            entryOf(row);
          }),
        ),
      (error: unknown) =>
        error instanceof StoreError && error.statusCode === 400,
    );
    f.accepted();
  } finally {
    f.db.close();
  }
});
