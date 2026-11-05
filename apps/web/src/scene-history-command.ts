import type { CommandInput } from "@tableloom/core";
import type { SceneHistory } from "@tableloom/core/scene-history";
export function sceneHistoryCommand(
  history: SceneHistory | null,
  direction: "undo" | "redo",
  enabled: boolean,
  pending: boolean,
): CommandInput | null {
  const entry = history?.[direction];
  return enabled && !pending && entry?.available
    ? {
        type: direction === "undo" ? "scene.undo" : "scene.redo",
        historyId: entry.id,
        expectedVersion: entry.version,
      }
    : null;
}
