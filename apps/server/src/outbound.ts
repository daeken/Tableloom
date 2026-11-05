import type { ServerMessage } from "@tableloom/core";

type Control = Extract<ServerMessage, { type: "ack" | "error" }>;
export interface OutboundSocket {
  readonly readyState: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
}
export interface OutboundDependencies {
  authorized(): boolean;
  snapshot(force: boolean): Extract<ServerMessage, { type: "snapshot" }> | null;
  presence(): Extract<ServerMessage, { type: "presence" }>;
  cursors?(): Extract<ServerMessage, { type: "cursors" }>;
  schedule(action: () => void, delay: number): () => void;
}
export const MAX_OUTBOUND_CONTROLS = 64;
export const MAX_OUTBOUND_CONTROL_BYTES = 64 * 1024;
export const OUTBOUND_WRITE_TIMEOUT = 10000;

/** One active write; reliable controls are bounded, snapshots/presence are lazy dirty flags. */
export class OutboundChannel {
  private controls: { frame: string; bytes: number }[] = [];
  private bytes = 0;
  private active: { controlBytes: number; cancel: () => void } | null = null;
  private dirtySnapshot = false;
  private forceSnapshot = false;
  private dirtyPresence = false;
  private dirtyCursors = false;
  private stopped = false;
  private cancelTermination: (() => void) | undefined;
  constructor(
    private readonly socket: OutboundSocket,
    private readonly deps: OutboundDependencies,
  ) {}
  control(message: Control) {
    if (this.stopped) return;
    const frame = JSON.stringify(message),
      bytes = Buffer.byteLength(frame);
    if (
      this.controls.length + Number(Boolean(this.active?.controlBytes)) >=
        MAX_OUTBOUND_CONTROLS ||
      this.bytes + (this.active?.controlBytes ?? 0) + bytes >
        MAX_OUTBOUND_CONTROL_BYTES
    ) {
      this.fail(1013, "Too many updates are waiting; reconnect.");
      return;
    }
    this.controls.push({ frame, bytes });
    this.bytes += bytes;
    this.pump();
  }
  snapshot(force = false) {
    if (this.stopped) return;
    this.dirtySnapshot = true;
    this.forceSnapshot ||= force;
    this.pump();
  }
  presence() {
    if (!this.stopped) {
      this.dirtyPresence = true;
      this.pump();
    }
  }
  cursors() {
    if (!this.stopped) {
      this.dirtyCursors = true;
      this.pump();
    }
  }
  close(code: number, reason: string) {
    this.fail(code, reason);
  }
  dispose() {
    this.stopped = true;
    this.controls = [];
    this.bytes = 0;
    this.dirtySnapshot = false;
    this.dirtyPresence = false;
    this.dirtyCursors = false;
    this.forceSnapshot = false;
    this.active?.cancel();
    this.active = null;
    this.cancelTermination?.();
    this.cancelTermination = undefined;
  }
  private fail(code: number, reason: string) {
    if (this.stopped) return;
    this.dispose();
    // A stalled peer might never finish the close handshake or drain the active frame.
    this.cancelTermination = this.deps.schedule(() => {
      this.cancelTermination = undefined;
      this.socket.terminate();
    }, 1000);
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }
  private pump() {
    if (this.stopped || this.active) return;
    if (this.socket.readyState !== 1) {
      this.dispose();
      return;
    }
    try {
      if (!this.deps.authorized()) {
        this.fail(4001, "Sign in to the table again.");
        return;
      }
      let frame: string,
        controlBytes = 0;
      const control = this.controls.shift();
      if (control) {
        this.bytes -= control.bytes;
        frame = control.frame;
        controlBytes = control.bytes;
      } else if (this.dirtySnapshot) {
        const force = this.forceSnapshot;
        this.dirtySnapshot = false;
        this.forceSnapshot = false;
        const message = this.deps.snapshot(force);
        if (!message) {
          this.pump();
          return;
        }
        frame = JSON.stringify(message);
      } else if (this.dirtyPresence) {
        this.dirtyPresence = false;
        frame = JSON.stringify(this.deps.presence());
      } else if (this.dirtyCursors && this.deps.cursors) {
        this.dirtyCursors = false;
        frame = JSON.stringify(this.deps.cursors());
      } else return;
      const active = { controlBytes, cancel: () => {} };
      this.active = active;
      active.cancel = this.deps.schedule(() => {
        if (this.active === active)
          this.fail(1013, "Connection is too slow; reconnect.");
      }, OUTBOUND_WRITE_TIMEOUT);
      this.socket.send(frame, (error) => {
        if (this.stopped || this.active !== active) return;
        active.cancel();
        this.active = null;
        if (error) {
          this.fail(1011, "Unable to send this update; reconnect.");
          return;
        }
        this.pump();
      });
    } catch {
      this.fail(1011, "Unable to prepare this update; reconnect.");
    }
  }
}
