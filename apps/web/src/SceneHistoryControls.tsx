import { Undo2, Redo2 } from "lucide-react";
import type { CommandInput } from "@tableloom/core";
import type { SceneHistory } from "@tableloom/core/scene-history";
import type { CommandDelivery } from "./table-connection.js";

export function SceneHistoryControls({
  history,
  enabled,
  deliveries,
  send,
}: {
  history: SceneHistory | null;
  enabled: boolean;
  deliveries: CommandDelivery[];
  send: (command: CommandInput) => boolean;
}) {
  const pending = deliveries.some(
    (item) =>
      item.status === "pending" &&
      ["token.move", "scene.undo", "scene.redo"].includes(item.type),
  );
  const blocked = [history?.undo, history?.redo].some(
    (item) => item && !item.available,
  );
  return (
    <div
      className="scene-history-controls"
      aria-label="Your token move history"
    >
      {(["undo", "redo"] as const).map((action) => {
        const entry = history?.[action];
        const Icon = action === "undo" ? Undo2 : Redo2;
        const label = action === "undo" ? "Undo last move" : "Redo last move";
        return (
          <button
            key={action}
            className="history-button"
            disabled={!enabled || pending || !entry?.available}
            title={entry ? `${label}: ${entry.name}` : `No move to ${action}`}
            onClick={() =>
              entry &&
              send({
                type: action === "undo" ? "scene.undo" : "scene.redo",
                historyId: entry.id,
                expectedVersion: entry.version,
              })
            }
          >
            <Icon size={14} /> {label}
          </button>
        );
      })}
      {blocked && (
        <small>A token changed. Its older move is unavailable.</small>
      )}
    </div>
  );
}
