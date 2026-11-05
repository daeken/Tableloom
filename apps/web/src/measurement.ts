import { pointSchema, type Point } from "@tableloom/core";
import { sameGrid, type SceneGrid } from "@tableloom/core/scene-grid";
import { snapPoint } from "./grid.js";

export interface Measurement {
  start: Point;
  end: Point;
  grid: SceneGrid;
  snapped: boolean;
}
export interface MeasurementDrag extends Measurement {
  rawStart: Point;
}
/** All endpoints are world coordinates. Rulers never construct persistent commands. */
export function beginMeasurement(
  point: Point,
  grid: SceneGrid,
  snapped: boolean,
): MeasurementDrag {
  const captured = structuredClone(grid),
    start = snapped ? snapPoint(point, 0, captured.settings) : { ...point };
  return {
    start,
    end: { ...start },
    rawStart: { ...point },
    grid: captured,
    snapped,
  };
}
export function updateMeasurement(
  drag: MeasurementDrag,
  point: Point,
): MeasurementDrag {
  return {
    ...drag,
    end: drag.snapped ? snapPoint(point, 0, drag.grid.settings) : { ...point },
  };
}
export function measurementCurrent(
  measurement: Measurement,
  grid: SceneGrid,
): boolean {
  return (
    measurement.grid.version === grid.version &&
    sameGrid(measurement.grid.settings, grid.settings)
  );
}
export function finishMeasurement(
  drag: MeasurementDrag,
  point: Point,
  scale: number,
  grid: SceneGrid,
): Measurement | null {
  if (
    !measurementCurrent(drag, grid) ||
    Math.hypot(point.x - drag.rawStart.x, point.y - drag.rawStart.y) * scale < 3
  )
    return null;
  const { rawStart: _, ...result } = updateMeasurement(drag, point);
  return measurementDistance(result).units > 0 ? result : null;
}
export function measurementDistance(measurement: Measurement) {
  const units = Math.hypot(
    measurement.end.x - measurement.start.x,
    measurement.end.y - measurement.start.y,
  );
  return { units, cells: units / measurement.grid.settings.spacing };
}
export interface MeasurementCoordinates {
  startX: string;
  startY: string;
  endX: string;
  endY: string;
}
/** Explicit entry provides intent without a pointer threshold; no saved command is constructed. */
export function coordinateMeasurement(
  coordinates: MeasurementCoordinates,
  capturedGrid: SceneGrid,
  currentGrid: SceneGrid,
  snapped: boolean,
  enabled: boolean,
): Measurement | null {
  if (!enabled || Object.values(coordinates).some((value) => !value.trim()))
    return null;
  const start = pointSchema.safeParse({
      x: Number(coordinates.startX),
      y: Number(coordinates.startY),
    }),
    end = pointSchema.safeParse({
      x: Number(coordinates.endX),
      y: Number(coordinates.endY),
    });
  if (!start.success || !end.success) return null;
  const { rawStart: _, ...result } = updateMeasurement(
    beginMeasurement(start.data, capturedGrid, snapped),
    end.data,
  );
  return measurementCurrent(result, currentGrid) &&
    measurementDistance(result).units > 0
    ? result
    : null;
}
/** Keep the displayed approximation from implying exact zero for a short ruler. */
const distanceFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});
export function formatDistance(value: number): string {
  if (value > 0 && value < 0.01) return "<0.01";
  return distanceFormatter.format(value);
}
