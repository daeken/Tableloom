import type { OnlineMember, ParticipantCursor } from "@tableloom/core";
export function ParticipantCursors({
  cursors,
  members,
  viewerId,
  view,
}: {
  cursors: ParticipantCursor[];
  members: OnlineMember[];
  viewerId: string | null;
  view: { x: number; y: number; scale: number };
}) {
  const names = new Map(members.map((m) => [m.id, m.name]));
  return (
    <div className="participant-cursors" aria-hidden="true">
      {cursors
        .filter((c) => c.memberId !== viewerId && names.has(c.memberId))
        .map((c) => {
          let hash = 0;
          for (const char of c.memberId)
            hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
          const color = ["#405f4d", "#9b5146", "#436c91", "#79558d", "#856229"][
            hash % 5
          ]!;
          return (
            <div
              key={c.memberId}
              className="participant-cursor"
              style={{
                left: view.x + c.position.x * view.scale,
                top: view.y + c.position.y * view.scale,
                color,
              }}
            >
              <svg width="16" height="20" viewBox="0 0 16 20">
                <path
                  d="M1 1 L1 16 L5 12 L9 19 L12 17 L8 10 L14 10 Z"
                  fill="currentColor"
                  stroke="#fffaf0"
                  strokeWidth="1.5"
                />
              </svg>
              <span style={{ background: color }}>{names.get(c.memberId)}</span>
            </div>
          );
        })}
    </div>
  );
}
