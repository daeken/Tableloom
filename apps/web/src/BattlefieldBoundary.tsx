import { Component, type ReactNode } from "react";

/** Keep a failed deferred renderer from taking down notes, dice, chat or campaign controls. */
export class BattlefieldBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <section
          className="canvas-frame battlefield-load-error"
          role="alert"
          aria-label="Battlefield unavailable"
        >
          <h2>We couldn’t open the battlefield.</h2>
          <p>
            Your other table panels are still available. Save any panel drafts
            before reloading.
          </p>
          <button onClick={() => location.reload()}>Reload page</button>
        </section>
      );
    return this.props.children;
  }
}
