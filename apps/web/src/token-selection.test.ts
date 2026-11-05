import { test } from "node:test";
import assert from "node:assert/strict";
import type { Token } from "@tableloom/core";
import {
  translateTokens,
  tokensInBox,
  selectTokens,
} from "./token-selection.js";
const token = (x: number, y: number, version = 1): Token => ({
  radius: 24,
  id: crypto.randomUUID(),
  name: "Scout",
  position: { x, y },
  color: "#405f4d",
  ownerId: crypto.randomUUID(),
  version,
});
test("group translation preserves pointer offset, relative spacing and captured versions at all world bounds", () => {
  const tokens = [token(9900, 10, 4), token(9990, -20, 7)],
    moves = translateTokens(tokens, { x: 200, y: -20000 });
  assert.deepEqual(
    moves.map((move) => move.position),
    [
      { x: 9910, y: -9970 },
      { x: 10000, y: -10000 },
    ],
  );
  assert.deepEqual(
    moves.map((move) => move.expectedVersion),
    [4, 7],
  );
  assert.deepEqual(
    tokens.map((token) => token.position),
    [
      { x: 9900, y: 10 },
      { x: 9990, y: -20 },
    ],
  );
  assert.deepEqual(
    translateTokens([token(-9990, 9990), token(-9900, 9980)], {
      x: -100,
      y: 100,
    }).map((move) => move.position),
    [
      { x: -10000, y: 10000 },
      { x: -9910, y: 9990 },
    ],
  );
  assert.deepEqual(translateTokens([], { x: 0, y: 0 }), []);
});
test("marquee selection uses world-space centers in either direction and selection is unique and bounded", () => {
  const tokens = [token(0, 0), token(50, 50), token(101, 50)];
  assert.deepEqual(
    tokensInBox(tokens, { x: 100, y: 100 }, { x: 0, y: 0 }),
    tokens.slice(0, 2).map((token) => token.id),
  );
  assert.deepEqual(
    selectTokens(
      [tokens[0]!.id],
      tokens.slice(0, 2).map((token) => token.id),
    ),
    tokens.slice(0, 2).map((token) => token.id),
  );
  const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
  assert.equal(selectTokens(ids, [crypto.randomUUID()]), null);
  assert.equal(selectTokens(ids, [ids[0]!])!.length, 100);
});
