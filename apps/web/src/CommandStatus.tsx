import type { CommandDelivery } from "./table-connection.js";
const names: Record<CommandDelivery["type"], string> = {
  "scene.undo": "Undo edit",
  "scene.redo": "Redo edit",
  "dice.roll": "Roll dice",
  "drawing.add": "Add drawing",
  "token.add": "Place token",
  "tokens.move": "Move tokens",
  "token.move": "Move token",
  "object.delete": "Delete object",
  "object.assign": "Transfer object",
  "system.set": "Change system",
  "note.add": "Create note",
  "note.update": "Save note",
  "note.delete": "Delete note",
  "note.assign": "Transfer note",
};
const labels = {
  pending: "Waiting for confirmation",
  accepted: "Confirmed",
  rejected: "Rejected",
  uncertain: "Not confirmed",
};
export function CommandStatus({
  deliveries,
}: {
  deliveries: CommandDelivery[];
}) {
  if (!deliveries.length) return null;
  const pending = deliveries.filter((item) => item.status === "pending").length;
  const latest = deliveries[0]!;
  return (
    <details className="command-status">
      <summary>
        <span role="status">
          {pending
            ? `${pending} ${pending === 1 ? "change" : "changes"} awaiting confirmation`
            : `${names[latest.type]}: ${labels[latest.status]}`}
        </span>
      </summary>
      <ol>
        {deliveries.slice(0, 20).map((item) => (
          <li key={item.id}>
            <strong>
              {names[item.type]} · {labels[item.status]}
            </strong>
            <small>{item.message}</small>
          </li>
        ))}
      </ol>
      <small>
        Recent changes in this browser. Unconfirmed changes are never sent again
        automatically.
      </small>
    </details>
  );
}
