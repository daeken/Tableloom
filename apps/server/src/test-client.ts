// Protocol-aware test peer. Tests can use sendRaw to exercise invalid/stale frames.
import { WebSocket } from "ws";
import type { ClientOptions, RawData } from "ws";
import { once } from "node:events";
import { PROTOCOL_VERSION, serverMessageSchema } from "@tableloom/core";
import { commandContextSchema } from "@tableloom/core/campaigns";
import type { CommandContext } from "@tableloom/core/campaigns";

export class TestWebSocket extends WebSocket {
  context: CommandContext | null = null;
  private versions = new Map<string, number>();
  constructor(address: string, options?: ClientOptions) {
    const url = new URL(address);
    url.searchParams.set("protocolVersion", String(PROTOCOL_VERSION));
    super(url, options);
    this.on("message", (data: RawData) => {
      const parsed = serverMessageSchema.parse(JSON.parse(data.toString()));
      if (parsed.type === "snapshot") {
        this.context = commandContextSchema.parse(parsed.context);
        this.versions = new Map(
          [...parsed.state.tokens, ...parsed.state.drawings].map((object) => [
            object.id,
            object.version,
          ]),
        );
      }
    });
  }
  override send(
    data: Parameters<WebSocket["send"]>[0],
    optionsOrCallback?:
      Parameters<WebSocket["send"]>[1] | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ): void {
    let outgoing = data;
    if (typeof data === "string") {
      try {
        const command: unknown = JSON.parse(data);
        if (
          command &&
          typeof command === "object" &&
          !("command" in command && "context" in command)
        ) {
          const input = command as {
            type?: string;
            expectedVersion?: number;
            tokenId?: string;
            objectId?: string;
          };
          const expectedVersion =
            this.versions.get(input.tokenId ?? input.objectId ?? "") ?? 1;
          const conditioned =
            ["token.move", "object.delete", "object.assign"].includes(
              input.type ?? "",
            ) && input.expectedVersion === undefined
              ? { ...command, expectedVersion }
              : command;
          outgoing = JSON.stringify({
            context: this.context,
            command: conditioned,
          });
        }
      } catch {
        /* Preserve invalid JSON tests. */
      }
    }
    if (typeof optionsOrCallback === "function")
      super.send(outgoing, optionsOrCallback);
    else if (optionsOrCallback)
      super.send(outgoing, optionsOrCallback, callback);
    else super.send(outgoing, callback);
  }
  sendRaw(data: string): void {
    super.send(data);
  }
}
export async function contextReady(socket: TestWebSocket): Promise<void> {
  while (!socket.context) await once(socket, "message");
}
