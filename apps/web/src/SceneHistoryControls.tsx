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
      [
        "token.move",
        "tokens.move",
        "objects.move",
        "token.add",
        "drawing.add",
        "object.delete",
        "scene.undo",
        "scene.redo",
      ].includes(item.type),
  );
  const blocked = [history?.undo, history?.redo].some(
    (item) => item && !item.available,
  );
  return (
    <div
      className="scene-history-controls"
      aria-label="Your scene edit history"
    >
      {(["undo", "redo"] as const).map((action) => {
        const entry = history?.[action];
        const Icon = action === "undo" ? Undo2 : Redo2;
        const label = action === "undo" ? "Undo last edit" : "Redo last edit";
        return (
          <button
            key={action}
            className="history-button"
            disabled={!enabled || pending || !entry?.available}
            title={
              entry
                ? `${label}: ${entry.action} ${entry.objectType === "drawing" && entry.objectCount === 1 ? "drawing" : entry.name}`
                : `No edit to ${action}`
            }
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
        <small>
          An object changed or is unavailable. Its older edit cannot be applied.
        </small>
      )}
    </div>
  );
}
