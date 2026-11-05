import {
  horizontalFocusTarget,
  type FocusNavigationKey,
} from "./focus-navigation.js";
export const panelTabs = ["rolls", "game", "notes", "chat"] as const;
export type PanelTab = (typeof panelTabs)[number];
export type PanelTabKey = FocusNavigationKey;
/** Manual activation: navigation changes focus; native Enter/Space or click selects. */
export function panelTabDestination(
  current: PanelTab,
  event: PanelTabKey,
): PanelTab | null {
  return horizontalFocusTarget(panelTabs, current, event);
}
