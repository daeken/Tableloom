import {
  chatInputSchema,
  chatMessageSchema,
  chatPageSchema,
  type ChatInput,
  type ChatMessage,
} from "@tableloom/core/chat";
import type { Member } from "@tableloom/core/access";
import { z } from "zod";

export class ChatRequestError extends Error {}

export interface ChatView {
  messages: ChatMessage[];
  pending: boolean;
  error: string;
  ready: boolean;
}
type Request = (
  body: ChatInput | undefined,
  signal: AbortSignal,
) => Promise<unknown>;
/** No offline queue or automatic send retry. Retired HTTP results cannot cross identities/campaigns. */
export class ChatClient {
  private generation = 0;
  private loadSequence = 0;
  private running = false;
  private deliveryError = "";
  private controllers = new Set<AbortController>();
  private view: ChatView = {
    messages: [],
    pending: false,
    error: "",
    ready: false,
  };
  constructor(
    private member: Member,
    private request: Request,
    private change: (view: ChatView) => void,
  ) {}
  private update(value: Partial<ChatView>) {
    this.view = { ...this.view, ...value };
    this.change(this.view);
  }
  start() {
    this.running = true;
  }
  stop() {
    if (this.view.pending)
      this.deliveryError =
        "Delivery was not confirmed. Check recent messages before sending again.";
    this.running = false;
    ++this.generation;
    ++this.loadSequence;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.update({
      messages: [],
      pending: false,
      ready: false,
      error: this.deliveryError,
    });
  }
  private visible(message: ChatMessage) {
    if (
      this.member.role !== "gm" &&
      message.audience === "gm" &&
      message.authorId !== this.member.id
    )
      throw new Error(
        "Unexpected private chat response. Reload this campaign.",
      );
  }
  async load() {
    if (!this.running) return;
    const generation = this.generation,
      sequence = ++this.loadSequence,
      controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const page = chatPageSchema.parse(
        await this.request(undefined, controller.signal),
      );
      if (
        !this.running ||
        generation !== this.generation ||
        sequence !== this.loadSequence
      )
        return;
      if (
        page.campaignId !== this.member.tableId ||
        page.viewerId !== this.member.id
      )
        throw new Error(
          "Chat response belongs to another campaign or identity. Reload this campaign.",
        );
      page.messages.forEach((m) => this.visible(m));
      this.update({
        messages: page.messages,
        ready: true,
        error: this.deliveryError,
      });
    } catch (error) {
      if (
        this.running &&
        generation === this.generation &&
        sequence === this.loadSequence
      )
        this.update({
          messages: [],
          ready: false,
          error:
            error instanceof Error ? error.message : "Chat could not refresh.",
        });
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
  async send(input: ChatInput): Promise<boolean> {
    if (!this.running || !this.view.ready || this.view.pending) return false;
    const command = chatInputSchema.parse(input),
      generation = this.generation,
      controller = new AbortController();
    this.controllers.add(controller);
    ++this.loadSequence;
    this.deliveryError = "";
    this.update({ pending: true, error: "" });
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const message = chatMessageSchema.parse(
        await this.request(command, controller.signal),
      );
      if (!this.running || generation !== this.generation) return false;
      if (
        message.id !== command.id ||
        message.authorId !== this.member.id ||
        message.body !== command.body ||
        message.audience !== command.audience
      )
        throw new Error("Unexpected chat confirmation.");
      this.update({ pending: false, error: "" });
      // Confirmation settles the draft immediately; a slow refresh must not later erase new typing.
      void this.load();
      return true;
    } catch (error) {
      if (this.running && generation === this.generation) {
        this.deliveryError =
          error instanceof ChatRequestError
            ? error.message
            : "Delivery was not confirmed. Your draft is kept. Refresh recent messages before retrying; a retained message with the same ID will not send twice.";
        this.update({
          pending: false,
          error: this.deliveryError,
        });
      }
      return false;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
}

export async function chatRequest(
  path: string,
  expectedAuthorId: string,
  body: ChatInput | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, expectedAuthorId }),
        }
      : {}),
  });
  const json: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string().max(500) }).safeParse(json);
    throw new ChatRequestError(
      error.success
        ? error.data.error
        : "The server rejected this chat request. Refresh before trying again.",
    );
  }
  return json;
}
