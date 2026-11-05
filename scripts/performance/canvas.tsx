import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { tableViewSchema } from "@tableloom/core";
import { Tabletop } from "../../apps/web/src/Tabletop.js";
import "../../apps/web/src/style.css";
import "./style.css";
import { fixture, gm, scenarios, snapshot } from "./fixture.js";
import { summarize } from "./stats.js";

const root = createRoot(document.querySelector("#table")!),
  button = document.querySelector<HTMLButtonElement>("#run")!,
  status = document.querySelector<HTMLElement>("#status")!,
  results = document.querySelector<HTMLElement>("#results")!;
const noop = () => {},
  noCommand = () => false;
let rebuilt: ((duration: number) => void) | undefined;
let rebuildTimeout: number | undefined;
const onSceneRebuild = (duration: number) => rebuilt?.(duration);
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

button.addEventListener("click", () => void run());
async function run() {
  button.disabled = true;
  results.textContent = "";
  let interrupted = document.visibilityState !== "visible";
  const visibility = () => {
    if (document.visibilityState !== "visible") interrupted = true;
  };
  document.addEventListener("visibilitychange", visibility);
  try {
    const rows = [];
    for (const scenario of scenarios) {
      status.textContent = `Measuring ${scenario.name} scene…`;
      const state = fixture(scenario);
      // Rendering only: a valid synthetic view, not a substitute for server projection.
      const base = tableViewSchema.parse({ ...state, version: "0".repeat(64) });
      const message = snapshot(base, gm);
      const rebuildSamples: number[] = [],
        frameSamples: number[] = [];
      for (let i = 0; i < 35; i++) {
        if (interrupted)
          throw new Error(
            "Tab hidden during measurement; keep it visible and run again.",
          );
        const view = {
          ...base,
          version: i.toString(16).padStart(64, "0"),
          tokens: base.tokens.map((token, n) =>
            n === 0
              ? {
                  ...token,
                  position: {
                    ...token.position,
                    x: token.position.x + (i % 2),
                  },
                }
              : token,
          ),
        };
        const start = performance.now();
        const duration = await new Promise<number>((resolve, reject) => {
          rebuildTimeout = window.setTimeout(() => {
            rebuilt = undefined;
            reject(
              new Error(
                "Renderer did not rebuild within 30 seconds; inspect the table/error above.",
              ),
            );
          }, 30_000);
          rebuilt = (value) => {
            window.clearTimeout(rebuildTimeout);
            rebuilt = undefined;
            resolve(value);
          };
          flushSync(() =>
            root.render(
              <Tabletop
                state={view}
                cursors={[]}
                onlineMembers={message.onlineMembers}
                shareCursor={noCommand}
                grid={message.grid}
                background={null}
                campaignId={gm.tableId}
                sceneId={message.context.sceneId}
                member={gm}
                tool="select"
                setTool={noop}
                history={null}
                color="#405f4d"
                tokenName="Benchmark"
                enabled
                pending={false}
                send={noCommand}
                onSceneRebuild={onSceneRebuild}
              />,
            ),
          );
        });
        await frame();
        await frame();
        if (interrupted)
          throw new Error(
            "Tab hidden during measurement; keep it visible and run again.",
          );
        if (i >= 5) {
          rebuildSamples.push(duration);
          frameSamples.push(performance.now() - start);
        }
      }
      const bounds = document.querySelector("#table")!.getBoundingClientRect();
      rows.push({
        scenario: scenario.name,
        drawings: state.drawings.length,
        tokens: state.tokens.length,
        points: state.drawings.reduce((n, d) => n + d.points.length, 0),
        viewport: { width: bounds.width, height: bounds.height },
        rebuild: summarize(rebuildSamples),
        updateToTwoFrames: summarize(frameSamples),
      });
    }
    results.textContent = JSON.stringify(
      {
        environment: {
          userAgent: navigator.userAgent,
          devicePixelRatio,
          rendererResolution: Math.min(devicePixelRatio, 2),
        },
        warmup: 5,
        results: rows,
      },
      null,
      2,
    );
    status.textContent = "Complete";
  } catch (error) {
    status.textContent = "Benchmark failed";
    results.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    window.clearTimeout(rebuildTimeout);
    rebuilt = undefined;
    document.removeEventListener("visibilitychange", visibility);
    button.disabled = false;
  }
}
