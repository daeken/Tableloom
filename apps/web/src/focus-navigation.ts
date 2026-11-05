export interface FocusNavigationKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
  defaultPrevented: boolean;
}
/** Focus only: native activation, Tab, vertical scrolling and editor/modifier keys stay native. */
export function horizontalFocusTarget<T extends string>(
  items: readonly T[],
  current: T,
  event: FocusNavigationKey,
): T | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return null;
  const index = items.indexOf(current);
  if (index < 0) return null;
  switch (event.key) {
    case "ArrowLeft":
      return items[(index + items.length - 1) % items.length]!;
    case "ArrowRight":
      return items[(index + 1) % items.length]!;
    case "Home":
      return items[0]!;
    case "End":
      return items[items.length - 1]!;
    default:
      return null;
  }
}
