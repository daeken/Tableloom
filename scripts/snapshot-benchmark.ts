import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
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

function measure(run: () => unknown) {
  for (let i = 0; i < 5; i++) run();
  return summarize(
    Array.from({ length: 30 }, () => {
      const start = performance.now();
      run();
      return performance.now() - start;
    }),
  );
}
const results = scenarios.flatMap((scenario) => {
  const state = fixture(scenario);
  return [gm, player].map((member) => {
    const message = snapshot(projectTable(state, member), member);
    const frame = JSON.stringify(message);
    serverMessageSchema.parse(JSON.parse(frame));
    return {
      scenario: scenario.name,
      audience: member.role,
      drawings: state.drawings.length,
      points: state.drawings.reduce((n, d) => n + d.points.length, 0),
      tokens: state.tokens.length,
      visibleNotes: message.state.notes.length,
      visibleRolls: message.state.rolls.length,
      bytes: Buffer.byteLength(frame),
      projection: measure(() => projectTable(state, member)),
      serialization: measure(() => JSON.stringify(message)),
      jsonParse: measure(() => JSON.parse(frame)),
      validation: measure(() => serverMessageSchema.parse(message)),
      receive: measure(() => serverMessageSchema.parse(JSON.parse(frame))),
    };
  });
});
console.log(
  JSON.stringify(
    {
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
      },
      warmup: 5,
      results,
    },
    null,
    2,
  ),
);
