import type { Tool } from "./Tabletop.js";
export const drawingTools = [
  { id: "select", label: "Select & move objects" },
  { id: "hand", label: "Pan the table" },
  { id: "measure", label: "Measure distance" },
  { id: "pen", label: "Freehand drawing" },
  { id: "rectangle", label: "Draw a room" },
  { id: "text", label: "Place a text label" },
  { id: "token", label: "Place a token" },
  { id: "erase", label: "Delete an object" },
] as const satisfies readonly { id: Tool; label: string }[];
export const drawingColors = [
  { value: "#405f4d", name: "Forest green" },
  { value: "#b45f4e", name: "Terracotta" },
  { value: "#627d9c", name: "Slate blue" },
  { value: "#a27a44", name: "Ochre" },
  { value: "#8c6c9c", name: "Muted purple" },
] as const;
export const drawingToolbarItems = [
  ...drawingTools.map(({ id }) => `tool:${id}` as const),
  ...drawingColors.map(({ value }) => `color:${value}` as const),
];
export type DrawingToolbarItem = (typeof drawingToolbarItems)[number];
