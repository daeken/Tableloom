import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Member } from "@tableloom/core/access";
import type { ChatInput } from "@tableloom/core/chat";
import { ChatClient, chatRequest, type ChatView } from "./chat-client.js";

export function ChatPanel({
  member,
  active,
  enabled,
}: {
  member: Member;
  active: boolean;
  enabled: boolean;
}) {
  const [view, setView] = useState<ChatView>({
    messages: [],
    pending: false,
    error: "",
    ready: false,
  });
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<ChatInput["audience"]>("public");
  const attempt = useRef<ChatInput | null>(null);
  const [client] = useState(
    () =>
      new ChatClient(
        member,
        (body, signal) =>
          chatRequest(
            `/api/campaigns/${member.tableId}/chat`,
            member.id,
            body,
            signal,
          ),
        setView,
      ),
  );
  useEffect(() => {
    if (!enabled) {
      client.stop();
      return;
    }
    client.start();
    return () => client.stop();
  }, [client, enabled]);
  useEffect(() => {
    if (!active || !enabled) return;
    void client.load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void client.load();
    }, 3000);
    return () => clearInterval(timer);
  }, [active, enabled, client]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!body.trim() || view.pending || !enabled) return;
    if (
      !attempt.current ||
      attempt.current.body !== body.trim() ||
      attempt.current.audience !== audience
    )
      attempt.current = {
        id: crypto.randomUUID(),
        body: body.trim(),
        audience,
      };
    if (await client.send(attempt.current)) {
      setBody("");
      attempt.current = null;
    }
  }
  return (
    <section
      className="chat-panel"
      aria-label="Campaign chat"
      style={{ display: active ? "flex" : "none" }}
    >
      <span className="eyebrow">WORDS AROUND THE TABLE</span>
      <h2>Campaign chat.</h2>
      <p className="muted">
        Recent 100 visible messages. Updates every 3 seconds while open. Private
        messages stay with their author and the GM.
      </p>
      <button
        type="button"
        disabled={!enabled || view.pending}
        onClick={() => void client.load()}
      >
        Refresh messages
      </button>
      {view.error && (
        <p role="status" className="chat-error">
          {view.error}
        </p>
      )}
      {!enabled && (
        <p role="status">
          Reconnect to read or send chat. Your draft stays here.
        </p>
      )}
      <ol
        className="chat-messages"
        aria-label="Recent messages"
        aria-live="polite"
        aria-relevant="additions"
      >
        {view.messages.map((message) => (
          <li key={message.id}>
            <div>
              <strong>
                {message.authorName}
                {message.authorId === member.id ? " · You" : ""}
              </strong>
              <span>
                {message.audience === "public"
                  ? "Everyone"
                  : message.authorId === member.id && member.role === "gm"
                    ? "Only you (GM)"
                    : "Author and GM"}
              </span>
            </div>
            <time dateTime={new Date(message.createdAt).toISOString()}>
              {new Date(message.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <p>{message.body}</p>
          </li>
        ))}
      </ol>
      {view.ready && !view.messages.length && (
        <p className="muted">No messages to read yet.</p>
      )}
      <form onSubmit={send}>
        <label htmlFor="chat-audience">Who can read this message?</label>
        <select
          id="chat-audience"
          value={audience}
          disabled={view.pending}
          onChange={(e) =>
            setAudience(e.target.value === "gm" ? "gm" : "public")
          }
        >
          <option value="public">Everyone at the table</option>
          <option value="gm">
            {member.role === "gm" ? "Only you (GM)" : "You and the GM"}
          </option>
        </select>
        <label htmlFor="chat-body">Message</label>
        <textarea
          id="chat-body"
          value={body}
          maxLength={2000}
          readOnly={view.pending}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Say something to your table…"
        />
        <button
          type="submit"
          disabled={!enabled || !view.ready || view.pending || !body.trim()}
        >
          {view.pending ? "Sending…" : "Send message"}
        </button>
        <small className="muted">
          Plain text · 2,000 characters · 100 saved per audience. Older messages
          leave history automatically. Drafts last until reload or sign-out.
        </small>
      </form>
    </section>
  );
}
