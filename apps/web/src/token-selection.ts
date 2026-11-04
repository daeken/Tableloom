import type { Point, Token } from "@tableloom/core";
import { MAX_TOKEN_MOVE_BATCH } from "@tableloom/core";
/** A rigid translation is clamped as a group, preserving spacing at world bounds. */
export function translateTokens(tokens: readonly Token[], delta: Point) {
  if (!tokens.length) return [];
  const dx = Math.max(
    Math.max(...tokens.map((token) => -10000 - token.position.x)),
    Math.min(
      delta.x,
      Math.min(...tokens.map((token) => 10000 - token.position.x)),
    ),
  );
  const dy = Math.max(
    Math.max(...tokens.map((token) => -10000 - token.position.y)),
    Math.min(
      delta.y,
      Math.min(...tokens.map((token) => 10000 - token.position.y)),
    ),
  );
  return tokens.map((token) => ({
    tokenId: token.id,
    expectedVersion: token.version,
    position: { x: token.position.x + dx, y: token.position.y + dy },
  }));
}
export function tokensInBox(
  tokens: readonly Token[],
  start: Point,
  end: Point,
): string[] {
  return tokens
    .filter(
      (token) =>
        token.position.x >= Math.min(start.x, end.x) &&
        token.position.x <= Math.max(start.x, end.x) &&
        token.position.y >= Math.min(start.y, end.y) &&
        token.position.y <= Math.max(start.y, end.y),
    )
    .map((token) => token.id);
}
export function selectTokens(
  base: readonly string[],
  added: readonly string[],
): string[] | null {
  const selected = [...new Set([...base, ...added])];
  return selected.length <= MAX_TOKEN_MOVE_BATCH ? selected : null;
}
