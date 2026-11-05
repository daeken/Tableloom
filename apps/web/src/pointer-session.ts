export interface PointerStart {
  pointerId: number;
  button: number;
  isPrimary: boolean;
}
/** One owner and a synchronous preview. A second contact cancels, never takes over. */
export class PointerSession<T> {
  private contacts = new Set<number>();
  private owner: number | null = null;
  private preview: T | null = null;
  private scope = "";
  get active() {
    return this.contacts.size > 0;
  }
  owns(id: number) {
    return this.owner === id;
  }
  tracks(id: number) {
    return this.contacts.has(id);
  }
  read(id: number) {
    return this.owns(id) ? this.preview : null;
  }
  /** Called in window capture phase, including contacts on controls/outside the canvas. */
  observeDown(id: number): boolean {
    if (!this.active) return false;
    this.contacts.add(id);
    if (this.owner !== null && this.owner !== id) {
      this.cancel();
      return true;
    }
    return false;
  }
  begin(event: PointerStart, scope: string): boolean {
    if (event.button !== 0) return false;
    if (this.active || !event.isPrimary) {
      if (this.active) this.observeDown(event.pointerId);
      else this.contacts.add(event.pointerId);
      return false;
    }
    this.contacts.add(event.pointerId);
    this.owner = event.pointerId;
    this.scope = scope;
    return true;
  }
  update(value: T | null) {
    if (value === null) this.cancel();
    else if (this.owner !== null) this.preview = value;
  }
  finish(id: number, scope: string): { value: T | null } | null {
    const result =
      this.owns(id) && this.scope === scope ? { value: this.preview } : null;
    if (this.owns(id)) {
      this.owner = null;
      this.preview = null;
    }
    this.contacts.delete(id);
    return result;
  }
  cancel() {
    this.owner = null;
    this.preview = null;
  }
  reset() {
    this.cancel();
    this.contacts.clear();
  }
}

/** Tap slop is measured in screen pixels, independent of camera zoom. */
export function withinTap(
  start: { x: number; y: number },
  end: { x: number; y: number },
  scale: number,
) {
  return Math.hypot(end.x - start.x, end.y - start.y) * scale <= 8;
}
