import { useRef, useState } from "react";
import { Dice5, Layers2, FileText, MessageCircle } from "lucide-react";
import { panelTabDestination, panelTabs, type PanelTab } from "./panel-tabs.js";
const content = {
  rolls: { label: "Dice & rolls", Icon: Dice5 },
  game: { label: "Your game", Icon: Layers2 },
  notes: { label: "Notes", Icon: FileText },
  chat: { label: "Chat", Icon: MessageCircle },
};
export function PanelTabs({
  active,
  change,
}: {
  active: PanelTab;
  change: (tab: PanelTab) => void;
}) {
  const buttons = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>(
      {},
    ),
    [focused, setFocused] = useState<PanelTab>(active);
  return (
    <div
      className="panel-tabs"
      role="tablist"
      aria-label="Table panels"
      aria-orientation="horizontal"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(active);
      }}
    >
      {panelTabs.map((id) => {
        const { label, Icon } = content[id];
        return (
          <button
            key={id}
            ref={(element) => {
              buttons.current[id] = element;
            }}
            type="button"
            id={`table-tab-${id}`}
            role="tab"
            aria-selected={active === id}
            aria-controls={`table-panel-${id}`}
            tabIndex={focused === id ? 0 : -1}
            className={active === id ? "active" : ""}
            onFocus={() => setFocused(id)}
            onClick={(event) => {
              change(id);
              setFocused(id);
              event.currentTarget.focus();
            }}
            onKeyDown={(event) => {
              const destination = panelTabDestination(id, {
                key: event.key,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.keyCode,
                defaultPrevented: event.defaultPrevented,
              });
              if (!destination) return;
              event.preventDefault();
              buttons.current[destination]?.focus();
            }}
          >
            <Icon size={16} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
