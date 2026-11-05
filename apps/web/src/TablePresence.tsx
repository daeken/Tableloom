import { Users } from "lucide-react";
import type { OnlineMember } from "@tableloom/core";
export function TablePresence({
  members,
  connections,
  connected,
  viewerId,
}: {
  members: OnlineMember[];
  connections: number;
  connected: boolean;
  viewerId: string | null;
}) {
  const online = connected ? members : [];
  return (
    <details className="table-presence">
      <summary
        aria-label={
          connected
            ? `Who's at the table: ${online.length} ${online.length === 1 ? "person" : "people"}`
            : "Who's at the table: presence unavailable"
        }
        title={
          connected
            ? `${online.length} people, ${connections} live connections`
            : "Reconnect to see who's here"
        }
      >
        <Users size={15} aria-hidden="true" />
        <span>
          {connected ? `${online.length} at the table` : "Presence unavailable"}
        </span>
      </summary>
      <div className="presence-roster">
        <strong>At the table</strong>
        {connected ? (
          <>
            <p>
              {online.length} {online.length === 1 ? "person" : "people"} ·{" "}
              {connections} {connections === 1 ? "connection" : "connections"}
            </p>
            <ul role="list">
              {online.map((member) => (
                <li key={member.id} role="listitem">
                  <span className="presence-name">{member.name}</span>
                  <small>
                    {member.role === "gm" ? "GM" : "Player"}
                    {member.id === viewerId ? " · You" : ""}
                  </small>
                </li>
              ))}
            </ul>
            <p className="presence-explainer">
              One row per person, even with several tabs open.
            </p>
          </>
        ) : (
          <p>
            Reconnect to see who's here. Previous names are cleared while
            disconnected.
          </p>
        )}
      </div>
    </details>
  );
}
