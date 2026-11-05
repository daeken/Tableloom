import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Point } from "@tableloom/core";
import { sameGrid, type SceneGrid } from "@tableloom/core/scene-grid";
import {
  coordinateMeasurement,
  formatDistance,
  measurementDistance,
  type Measurement,
  type MeasurementCoordinates,
} from "./measurement.js";

export function MeasurementDialog({
  initial,
  origin,
  grid,
  snapping,
  enabled,
  save,
  close,
}: {
  initial: Measurement | null;
  origin: Point;
  grid: SceneGrid;
  snapping: boolean;
  enabled: boolean;
  save: (measurement: Measurement) => boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    startField = useRef<HTMLInputElement>(null),
    [capturedGrid] = useState(() => structuredClone(grid)),
    [snapped, setSnapped] = useState(initial?.snapped ?? snapping),
    [coordinates, setCoordinates] = useState<MeasurementCoordinates>(() => {
      const start = initial?.start ?? origin,
        end = initial?.end ?? {
          x:
            origin.x +
            (origin.x + grid.settings.spacing <= 10000
              ? grid.settings.spacing
              : -grid.settings.spacing),
          y: origin.y,
        };
      return {
        startX: String(start.x),
        startY: String(start.y),
        endX: String(end.x),
        endY: String(end.y),
      };
    }),
    [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    startField.current?.focus();
    startField.current?.select();
    return () => element?.close();
  }, []);
  const current =
      capturedGrid.version === grid.version &&
      sameGrid(capturedGrid.settings, grid.settings),
    measurement = coordinateMeasurement(
      coordinates,
      capturedGrid,
      grid,
      snapped,
      enabled,
    ),
    distance = measurement ? measurementDistance(measurement) : null;
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog selection-delete-dialog selection-resize-dialog"
      aria-labelledby="measurement-entry-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <h1 id="measurement-entry-title">Ruler endpoints</h1>
      <p>
        Enter canvas coordinates between −10000 and 10000. X increases
        rightward; Y increases downward. This straight-line ruler is visible
        only to you and changes no saved objects.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!measurement) return;
          if (save(measurement)) close();
          else
            setError(
              "The ruler could not be shown. Check the connection and current grid, then try again.",
            );
        }}
      >
        {(["start", "end"] as const).map((endpoint) => (
          <fieldset className="ruler-coordinate-fields" key={endpoint}>
            <legend>{endpoint === "start" ? "Start" : "End"}</legend>
            <div className="creation-coordinates">
              {(["X", "Y"] as const).map((axis) => {
                const key =
                  `${endpoint}${axis}` as keyof MeasurementCoordinates;
                return (
                  <label key={key}>
                    {endpoint === "start" ? "Start" : "End"} {axis}
                    <input
                      ref={key === "startX" ? startField : undefined}
                      type="number"
                      required
                      min={-10000}
                      max={10000}
                      step="any"
                      value={coordinates[key]}
                      onChange={(event) => {
                        const value = event.target.value;
                        setCoordinates((previous) => ({
                          ...previous,
                          [key]: value,
                        }));
                        setError("");
                      }}
                    />
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        <label className="ruler-entry-snap">
          <input
            type="checkbox"
            checked={snapped}
            onChange={(event) => {
              setSnapped(event.target.checked);
              setError("");
            }}
          />{" "}
          Snap endpoints to grid intersections
        </label>
        <p>
          Captured grid spacing: {capturedGrid.settings.spacing}.{" "}
          {snapped
            ? "The preview shows the snapped endpoints."
            : "Coordinates stay exact, regardless of zoom."}{" "}
          This choice applies only to this ruler.
        </p>
        {distance && measurement && (
          <div className="ruler-entry-preview">
            <output aria-label="Measurement preview" aria-live="off">
              ≈ {formatDistance(distance.units)} canvas units ·{" "}
              {formatDistance(distance.cells)} grid cells
            </output>
            <p>
              Start: {measurement.start.x}, {measurement.start.y} → End:{" "}
              {measurement.end.x}, {measurement.end.y}
            </p>
          </div>
        )}
        {!current && (
          <p role="alert" className="form-error">
            The grid changed. Cancel and reopen the endpoints to use its current
            settings.
          </p>
        )}
        {current && enabled && !measurement && (
          <p role="status">
            Enter finite coordinates within the limits and different endpoints
            after snapping.
          </p>
        )}
        {!enabled && (
          <p role="status">Reconnect to the table before showing the ruler.</p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="selection-delete-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="token-size-confirm"
            disabled={!measurement}
          >
            Show measurement
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
