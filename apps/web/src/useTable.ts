import { useCallback, useEffect, useRef, useState } from "react";
import { serverMessageSchema } from "@tableloom/core";
import type { CommandInput, TableState } from "@tableloom/core";

export function useTable(
  memberId: string | null,
  onUnauthorized: () => Promise<void>,
) {
  const [state, setState] = useState<TableState | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "offline">(
    "connecting",
  );
  const [participants, setParticipants] = useState(0);
  const [error, setError] = useState("");
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);

  useEffect(() => {
    setState(null);
    setParticipants(0);
    if (!memberId) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const connect = () => {
      ready.current = false;
      setStatus("connecting");
      const url = new URL("/api/live", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onmessage = (event) => {
        if (stopped || socket.current !== ws) return;
        try {
          const message = serverMessageSchema.parse(
            JSON.parse(String(event.data)),
          );
          if (message.type === "snapshot") {
            setState(message.state);
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
          setState(null);
          setParticipants(0);
          void onUnauthorized();
          return;
        }
        void onUnauthorized();
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      stopped = true;
      ready.current = false;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, [memberId, onUnauthorized]);

  const send = useCallback((command: CommandInput) => {
    if (!ready.current || socket.current?.readyState !== WebSocket.OPEN) {
      setError(
        "The table is reconnecting. Try that change again once connected.",
      );
      return false;
    }
    socket.current.send(
      JSON.stringify({ ...command, id: crypto.randomUUID() }),
    );
    return true;
  }, []);

  return {
    state,
    status,
    participants,
    error,
    clearError: () => setError(""),
    send,
  };
}
