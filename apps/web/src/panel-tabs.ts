export const panelTabs = ["rolls", "game", "notes", "chat"] as const;
export type PanelTab = (typeof panelTabs)[number];
export interface PanelTabKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
  defaultPrevented: boolean;
}
/** Manual activation: navigation changes focus; native Enter/Space or click selects. */
export function panelTabDestination(
  current: PanelTab,
  event: PanelTabKey,
): PanelTab | null {
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
  const index = panelTabs.indexOf(current);
  switch (event.key) {
    case "ArrowLeft":
      return panelTabs[(index + panelTabs.length - 1) % panelTabs.length]!;
    case "ArrowRight":
      return panelTabs[(index + 1) % panelTabs.length]!;
    case "Home":
      return panelTabs[0];
    case "End":
      return panelTabs[panelTabs.length - 1]!;
    default:
      return null;
  }
}
