import { presenceDataSchema } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
/** Callers supply freshly authenticated, open sockets only; the projection strips scope/credentials. */
export function projectPresence(members: Iterable<Member>) {
  let participants = 0;
  const online = new Map<
    string,
    { id: string; name: string; role: "gm" | "player" }
  >();
  for (const member of members) {
    participants++;
    online.set(member.id, {
      id: member.id,
      name: member.name,
      role: member.role,
    });
  }
  const onlineMembers = [...online.values()].sort((a, b) =>
    a.name < b.name
      ? -1
      : a.name > b.name
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
  return presenceDataSchema.parse({ participants, onlineMembers });
}
