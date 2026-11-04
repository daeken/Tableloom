import { manifest } from "./index.js";

export function SystemPanel() {
  return (
    <section className="system-panel">
      <span className="eyebrow">Your game</span>
      <h3>{manifest.name}</h3>
      <p>{manifest.description}</p>
      <div className="coming-next">
        Character sheets &amp; game rules
        <br />
        <span>Coming in a future update</span>
      </div>
      <p className="muted small">
        For now, sketch your scene, place your cast, and roll together.
      </p>
    </section>
  );
}
