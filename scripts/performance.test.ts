import assert from "node:assert/strict";
import { test } from "node:test";
import { serverMessageSchema } from "@tableloom/core";
import { projectTable } from "@tableloom/core/server";
import {
  fixture,
  gm,
  player,
  scenarios,
  snapshot,
} from "./performance/fixture.js";
import { summarize } from "./performance/stats.js";

test("benchmark scenes validate through real projection/wire boundaries and exercise private filtering", () => {
  for (const scenario of scenarios) {
    const state = fixture(scenario);
    assert.equal(state.drawings.length, scenario.drawings);
    assert.equal(state.tokens.length, scenario.tokens);
    for (const member of [gm, player]) {
      const message = serverMessageSchema.parse(
        JSON.parse(
          JSON.stringify(snapshot(projectTable(state, member), member)),
        ),
      );
      assert.equal(message.type, "snapshot");
      if (message.type !== "snapshot") throw new Error("Expected snapshot");
      assert.equal(message.state.notes.length, member.role === "gm" ? 100 : 50);
      assert.equal(message.state.rolls.length, member.role === "gm" ? 100 : 50);
      if (member.role === "player")
        assert.ok(!JSON.stringify(message).includes("GM-only"));
    }
  }
});

test("timing summaries use nearest-rank percentiles without mutating input", () => {
  const samples = [9, 1, 7, 3];
  assert.deepEqual(summarize(samples), {
    samples: 4,
    p50Ms: 3,
    p95Ms: 9,
    maxMs: 9,
  });
  assert.deepEqual(samples, [9, 1, 7, 3]);
  for (const bad of [[], [-1], [NaN], [Infinity]])
    assert.throws(() => summarize(bad));
});
