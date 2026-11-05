import {
  createTable,
  DEFAULT_TEXT_STYLE,
  PROTOCOL_VERSION,
  tableSchema,
} from "@tableloom/core";
import type { ServerMessage, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { DEFAULT_GRID } from "@tableloom/core/scene-grid";

// Stable synthetic data only. No campaigns, credentials or published rules.
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const gm: Member = {
  id: id(1),
  tableId: id(3),
  name: "Benchmark GM",
  role: "gm",
};
export const player: Member = {
  id: id(2),
  tableId: id(3),
  name: "Benchmark player",
  role: "player",
};
export const scenarios = [
  { name: "small", drawings: 20, tokens: 10 },
  { name: "medium", drawings: 300, tokens: 60 },
  { name: "large", drawings: 2000, tokens: 200 },
] as const;

export function fixture(scenario: (typeof scenarios)[number]) {
  return tableSchema.parse({
    ...createTable(),
    drawings: Array.from({ length: scenario.drawings }, (_, i) => {
      const x = (i % 25) * 150,
        y = Math.floor(i / 25) * 100;
      const kind = i % 3 === 0 ? "stroke" : i % 3 === 1 ? "rectangle" : "text";
      return {
        id: id(1000 + i),
        kind,
        color: "#405f4d",
        ownerId: gm.id,
        version: 1,
        layer: i % 2 ? "above-tokens" : "below-tokens",
        points:
          kind === "stroke"
            ? Array.from({ length: 64 }, (_, p) => ({
                x: x + p * 2,
                y: y + (p % 5) * 4,
              }))
            : [
                { x, y },
                { x: x + 120, y: y + 60 },
              ],
        ...(kind === "text"
          ? { text: `Area ${i}`, textStyle: DEFAULT_TEXT_STYLE }
          : {}),
      };
    }),
    tokens: Array.from({ length: scenario.tokens }, (_, i) => ({
      id: id(4000 + i),
      name: `Token ${i}`,
      radius: 24,
      color: "#627d9c",
      position: { x: (i % 20) * 150 + 60, y: Math.floor(i / 20) * 100 + 30 },
      ownerId: player.id,
      version: 1,
    })),
    notes: Array.from({ length: 100 }, (_, i) => ({
      id: id(5000 + i),
      title: `Note ${i}`,
      body: `${i % 2 ? "GM-only" : "Public"} synthetic note. `.repeat(100),
      visibility: i % 2 ? "gm" : "public",
      ownerId: gm.id,
      version: 1,
    })),
    rolls: Array.from({ length: 100 }, (_, i) => ({
      id: id(6000 + i),
      actor: gm.name,
      expression: "1d6",
      dice: [3],
      sides: 6,
      modifier: 0,
      total: 3,
      at: "2026-01-01T00:00:00.000Z",
      visibility: i % 2 ? "gm" : "public",
      ownerId: gm.id,
    })),
  });
}

export function snapshot(
  state: TableView,
  member: Member,
): Extract<ServerMessage, { type: "snapshot" }> {
  return {
    type: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    state,
    context: { campaignId: gm.tableId, sceneId: id(4), generation: 1 },
    campaignName: "Synthetic benchmark",
    sceneName: "Mixed objects",
    history: { undo: null, redo: null },
    background: null,
    backgroundVersion: 0,
    grid: { version: 0, settings: DEFAULT_GRID },
    participants: 1,
    onlineMembers: [{ id: member.id, name: member.name, role: member.role }],
  };
}
