import type { Measurement } from "./measurement.js";
import { measurementDistance, formatDistance } from "./measurement.js";
export function MeasurementControls({
  measurement,
  dragging,
  snapping,
  enabled,
  enter,
  clear,
}: {
  measurement: Measurement | null;
  dragging: boolean;
  snapping: boolean;
  enabled: boolean;
  enter: () => void;
  clear: () => void;
}) {
  const distance = measurement ? measurementDistance(measurement) : null;
  return (
    <section
      className="measurement-controls"
      aria-label="Local distance ruler"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <strong>Straight-line ruler · Only you</strong>
      {distance ? (
        <output aria-live="off">
          ≈ {formatDistance(distance.units)} canvas units ·{" "}
          {formatDistance(distance.cells)} grid cells
        </output>
      ) : (
        <span>Drag across the table or enter endpoints to measure.</span>
      )}
      <span
        className="measurement-announcement"
        role="status"
        aria-atomic="true"
      >
        {!dragging && distance
          ? `Measured approximately ${formatDistance(distance.units)} canvas units, ${formatDistance(distance.cells)} grid cells.`
          : ""}
      </span>
      <small>
        {(measurement?.snapped ?? snapping)
          ? "Endpoints snap to grid intersections."
          : "Use Snap to grid for intersections."}
      </small>
      <button disabled={!enabled || dragging} onClick={enter}>
        Enter endpoints…
      </button>
      <button disabled={!enabled || !measurement} onClick={clear}>
        Clear measurement
      </button>
    </section>
  );
}
