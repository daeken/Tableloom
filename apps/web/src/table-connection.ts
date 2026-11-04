import {
  clientCommandSchema,
  PROTOCOL_VERSION,
  serverMessageSchema,
} from "@tableloom/core";
import type { CommandInput, ServerMessage } from "@tableloom/core";
import { contextKey } from "@tableloom/core/campaigns";
import type { CommandContext } from "@tableloom/core/campaigns";

export type ConnectionStatus =
  "connecting" | "connected" | "offline" | "blocked";
type Snapshot = Extract<ServerMessage, { type: "snapshot" }>;
export interface LiveSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(): void;
}
export interface LiveHandlers {
  message(data: unknown): void;
  close(code: number): void;
  error(): void;
}
export type CommandDelivery = {
  id: string;
  type: CommandInput["type"];
  target: string | null;
  status: "pending" | "accepted" | "rejected" | "uncertain";
  message: string;
};
export interface ConnectionDependencies {
  delivery(result: CommandDelivery): void;
  probe(signal: AbortSignal): Promise<number>;
  open(url: string, handlers: LiveHandlers): LiveSocket;
  schedule(action: () => void, delay: number): () => void;
  random(): number;
  refreshAccess(): Promise<void>;
  snapshot(message: Snapshot): void;
  participants(count: number): void;
  clear(): void;
  status(status: ConnectionStatus): void;
  error(message: string): void;
}
export const MAX_PENDING_BYTES = 256 * 1024;
const CONNECT_TIMEOUT = 10000;
export const MAX_PENDING_COMMANDS = 64;

/** No offline queue or replay: fresh validated state is required after every connection. */
export class TableConnection {
  private pending = new Map<
    string,
    { delivery: CommandDelivery; cancel: () => void }
  >();
  private generation = 0;
  private stopped = true;
  private attempts = 0;
  private socket: LiveSocket | null = null;
  private context: CommandContext | null = null;
  private ready = false;
  private cancelTimer: (() => void) | undefined;
  private cancelDeadline: (() => void) | undefined;
  private probe: AbortController | undefined;
  constructor(
    private readonly url: string,
    private readonly campaignId: string,
    private readonly deps: ConnectionDependencies,
  ) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }
  stop() {
    this.stopped = true;
    this.retire(false);
  }
  private retire(notify = true) {
    for (const item of this.pending.values()) {
      item.cancel();
      if (notify)
        this.deps.delivery({
          ...item.delivery,
          status: "uncertain",
          message:
            "Not confirmed. Review the current table before trying again.",
        });
    }
    this.pending.clear();
    ++this.generation;
    this.ready = false;
    this.context = null;
    this.cancelTimer?.();
    this.cancelDeadline?.();
    this.probe?.abort();
    this.cancelTimer = undefined;
    this.cancelDeadline = undefined;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
  private block(message: string, clear = false) {
    this.retire();
    if (clear) this.deps.clear();
    this.deps.participants(0);
    this.deps.error(message);
    this.deps.status("blocked");
  }
  private retry(code?: number) {
    const interrupted = this.ready;
    this.retire();
    if (interrupted)
      this.deps.error(
        "Connection lost. A change sent just before the interruption may have saved. Review the table after reconnecting before trying it again.",
      );
    this.deps.participants(0);
    this.deps.status("offline");
    if (code === 4001 || code === 4002) this.deps.clear();
    void this.deps.refreshAccess().catch(() => {});
    const base = Math.min(1000 * 2 ** Math.min(this.attempts++, 4), 15000);
    const delay = Math.max(
      code === 1013 ? 3000 : 0,
      Math.round(base * (0.75 + this.deps.random() * 0.25)),
    );
    this.cancelTimer = this.deps.schedule(() => void this.connect(), delay);
  }
  private async connect() {
    if (this.stopped) return;
    this.retire();
    const generation = this.generation;
    const current = () => !this.stopped && generation === this.generation;
    this.deps.status("connecting");
    this.probe = new AbortController();
    this.cancelDeadline = this.deps.schedule(() => {
      if (current()) {
        this.deps.error(
          "The connection timed out. Reconnecting; your drafts are kept.",
        );
        this.retry();
      }
    }, CONNECT_TIMEOUT);
    try {
      const protocol = await this.deps.probe(this.probe.signal);
      if (!current()) return;
      if (protocol !== PROTOCOL_VERSION) {
        this.block(
          "The server and this page use different versions. Reload the page before making changes.",
        );
        return;
      }
      this.socket = this.deps.open(this.url, {
        message: (data) => {
          if (!current()) return;
          const parsed =
            typeof data === "string"
              ? (() => {
                  try {
                    return serverMessageSchema.safeParse(JSON.parse(data));
                  } catch {
                    return null;
                  }
                })()
              : null;
          if (!parsed?.success) {
            this.block(
              "The table sent an incompatible update. Reload the page before making changes.",
            );
            return;
          }
          const message = parsed.data;
          if (message.type === "snapshot") {
            if (message.context.campaignId !== this.campaignId) {
              this.block(
                "The selected campaign changed. Reload the page before making changes.",
                true,
              );
              return;
            }
            this.cancelDeadline?.();
            this.cancelDeadline = undefined;
            this.context = message.context;
            this.ready = true;
            this.attempts = 0;
            this.deps.snapshot(message);
            this.deps.participants(message.participants);
            this.deps.status("connected");
          } else if (
            message.type === "ack" ||
            (message.type === "error" && message.commandId)
          ) {
            const id = message.commandId!;
            const item = this.pending.get(id);
            if (item) {
              item.cancel();
              this.pending.delete(id);
              this.deps.delivery({
                ...item.delivery,
                status: message.type === "ack" ? "accepted" : "rejected",
                message:
                  message.type === "ack"
                    ? "Confirmed by the server."
                    : message.message,
              });
              if (message.type === "error") this.deps.error(message.message);
            }
          } else if (message.type === "presence") {
            if (this.ready) this.deps.participants(message.participants);
          } else this.deps.error(message.message);
        },
        close: (code) => {
          if (!current()) return;
          if (code === 1002 || code === 1008 || code === 1009) {
            this.block(
              code === 1008
                ? "The server paused this connection. Reload the page to try again."
                : "The table update is incompatible or too large. Reload the page to try again.",
            );
            return;
          }
          this.retry(code);
        },
        error: () => {
          if (current()) this.retry();
        },
      });
    } catch {
      if (current()) this.retry();
    }
  }
  send(context: CommandContext | null, command: CommandInput): boolean {
    if (
      !this.ready ||
      !context ||
      !this.context ||
      contextKey(context) !== contextKey(this.context) ||
      this.socket?.readyState !== 1
    ) {
      this.deps.error(
        "The table is reconnecting or has changed. Review the connected scene before trying again.",
      );
      return false;
    }
    try {
      if (this.pending.size >= MAX_PENDING_COMMANDS) {
        this.deps.error(
          "Too many changes are waiting for confirmation. Wait before trying again.",
        );
        return false;
      }
      const id = crypto.randomUUID();
      const frame = JSON.stringify(
        clientCommandSchema.parse({
          context,
          command: { ...command, id },
        }),
      );
      if (
        this.socket.bufferedAmount +
          new TextEncoder().encode(frame).byteLength >
        MAX_PENDING_BYTES
      ) {
        this.deps.error(
          "The connection is busy. This change was not sent; try again in a moment.",
        );
        return false;
      }
      const delivery: CommandDelivery = {
        id,
        type: command.type,
        target:
          "noteId" in command
            ? command.noteId
            : "objectId" in command
              ? command.objectId
              : "tokenId" in command
                ? command.tokenId
                : null,
        status: "pending",
        message: "Waiting for the server…",
      };
      const cancel = this.deps.schedule(() => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        this.deps.delivery({
          ...delivery,
          status: "uncertain",
          message:
            "Confirmation timed out. Review the current table before trying again.",
        });
      }, 10000);
      this.pending.set(id, { delivery, cancel });
      this.deps.delivery(delivery);
      try {
        this.socket.send(frame);
      } catch {
        cancel();
        this.pending.delete(id);
        this.deps.delivery({
          ...delivery,
          status: "uncertain",
          message:
            "Delivery could not be confirmed. Review the table before trying again.",
        });
        return false;
      }
      return true;
    } catch {
      this.deps.error(
        "This change could not be sent. Review the table before trying again.",
      );
      return false;
    }
  }
}
