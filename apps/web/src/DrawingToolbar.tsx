import { useRef, useState, type KeyboardEvent } from "react";
import {
  Circle,
  Eraser,
  Hand,
  MousePointer2,
  Pencil,
  Square,
  Ruler,
  Type,
} from "lucide-react";
import type { Tool } from "./Tabletop.js";
import { toolKeys } from "./tabletop-shortcuts.js";
import { horizontalFocusTarget } from "./focus-navigation.js";
import {
  drawingTools,
  drawingColors,
  drawingToolbarItems,
  type DrawingToolbarItem,
} from "./drawing-toolbar.js";
const icons = {
  select: MousePointer2,
  hand: Hand,
  measure: Ruler,
  pen: Pencil,
  rectangle: Square,
  text: Type,
  token: Circle,
  erase: Eraser,
};

export function DrawingToolbar({
  tool,
  setTool,
  color,
  setColor,
}: {
  tool: Tool;
  setTool: (tool: Tool) => void;
  color: string;
  setColor: (color: string) => void;
}) {
  const [focused, setFocused] = useState<DrawingToolbarItem>(
      drawingToolbarItems[0]!,
    ),
    buttons = useRef<
      Partial<Record<DrawingToolbarItem, HTMLButtonElement | null>>
    >({});
  function focusProps(id: DrawingToolbarItem) {
    return {
      ref: (element: HTMLButtonElement | null) => {
        buttons.current[id] = element;
      },
      tabIndex: focused === id ? 0 : -1,
      onFocus: () => setFocused(id),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        const target = horizontalFocusTarget(drawingToolbarItems, id, {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: event.nativeEvent.isComposing,
          keyCode: event.keyCode,
          defaultPrevented: event.defaultPrevented,
        });
        if (!target) return;
        event.preventDefault();
        buttons.current[target]?.focus();
      },
    };
  }
  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation="horizontal"
    >
      {drawingTools.map(({ id, label }) => {
        const Icon = icons[id];
        return (
          <button
            key={id}
            {...focusProps(`tool:${id}`)}
            type="button"
            title={`${label} (${toolKeys[id]})`}
            aria-keyshortcuts={toolKeys[id]}
            aria-label={label}
            aria-pressed={tool === id}
            className={tool === id ? "active" : ""}
            onClick={(event) => {
              setTool(id);
              event.currentTarget.focus();
            }}
          >
            <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
          </button>
        );
      })}
      <span className="tool-divider" aria-hidden="true" />
      <div className="color-options" role="group" aria-label="Drawing color">
        {drawingColors.map(({ value, name }) => (
          <button
            key={value}
            {...focusProps(`color:${value}`)}
            type="button"
            className={`color-swatch ${color === value ? "selected" : ""}`}
            style={{ background: value }}
            title={`${name} (${value})`}
            aria-label={`Use ${name} (${value})`}
            aria-pressed={color === value}
            onClick={(event) => {
              setColor(value);
              event.currentTarget.focus();
            }}
          />
        ))}
      </div>
    </div>
  );
}
