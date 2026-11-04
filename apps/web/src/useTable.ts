import { useCallback, useEffect, useRef, useState } from "react";
import { serverMessageSchema } from "@tableloom/core";
import type { CommandInput, TableView } from "@tableloom/core";

export function useTable(
  viewerKey: string | null,
  onUnauthorized: () => Promise<void>,
) {
  const [snapshot, setSnapshot] = useState<{
    viewerKey: string;
    state: TableView;
  } | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "offline">(
    "connecting",
  );
  const [participants, setParticipants] = useState(0);
  const [error, setError] = useState("");
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
  const socketViewer = useRef<string | null>(null);

  useEffect(() => {
    setSnapshot(null);
    setParticipants(0);
    if (!viewerKey) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const connect = () => {
      ready.current = false;
      setStatus("connecting");
      const url = new URL("/api/live", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socketViewer.current = viewerKey;
      socket.current = ws;
      ws.onmessage = (event) => {
        if (stopped || socket.current !== ws) return;
        try {
          const message = serverMessageSchema.parse(
            JSON.parse(String(event.data)),
          );
          if (message.type === "snapshot") {
            setSnapshot({ viewerKey, state: message.state });
            setParticipants(message.participants);
            ready.current = true;
            setStatus("connected");
            attempts = 0;
          } else if (message.type === "presence")
            setParticipants(message.participants);
          else setError(message.message);
        } catch {
          setError("The table sent an unreadable update. Please reload.");
        }
      };
      ws.onclose = (event) => {
        if (stopped) return;
        ready.current = false;
        setStatus("offline");
        if (event.code === 4001) {
          setSnapshot(null);
          setParticipants(0);
        }
        // Another tab may have replaced the cookie with a return-code session
        // for the same identity. Refresh access and retry; sign-out/removal
        // changes viewerKey to null and cleanup cancels this pending reconnect.
        void onUnauthorized();
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      stopped = true;
      ready.current = false;
      socketViewer.current = null;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, [viewerKey, onUnauthorized]);

  const send = useCallback(
    (command: CommandInput) => {
      if (
        !viewerKey ||
        socketViewer.current !== viewerKey ||
        !ready.current ||
        socket.current?.readyState !== WebSocket.OPEN
      ) {
        setError(
          "The table is reconnecting. Try that change again once connected.",
        );
        return false;
      }
      socket.current.send(
        JSON.stringify({ ...command, id: crypto.randomUUID() }),
      );
      return true;
    },
    [viewerKey],
  );

  const current = snapshot?.viewerKey === viewerKey;
  return {
    state: current ? snapshot.state : null,
    status: current ? status : ("connecting" as const),
    participants: current ? participants : 0,
    error,
    clearError: () => setError(""),
    send,
  };
}
