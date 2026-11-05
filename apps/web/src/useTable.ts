import type { BackgroundView } from "@tableloom/core/scene-map";
import { useCallback, useEffect, useRef, useState } from "react";
import { PROTOCOL_VERSION } from "@tableloom/core";
import type { CommandInput, TableView } from "@tableloom/core";
import type { CommandContext } from "@tableloom/core/campaigns";
import { z } from "zod";
import type { SceneHistory } from "@tableloom/core/scene-history";
import { TableConnection } from "./table-connection.js";
import type { CommandDelivery, ConnectionStatus } from "./table-connection.js";

export function useTable(
  viewerKey: string | null,
  onUnauthorized: () => Promise<void>,
  campaignId: string | null,
) {
  const [snapshot, setSnapshot] = useState<{
    viewerKey: string;
    state: TableView;
    history: SceneHistory;
    background: BackgroundView | null;
    backgroundVersion: number | null;
    context: CommandContext;
    campaignName: string;
    sceneName: string;
  } | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [participants, setParticipants] = useState(0),
    [error, setError] = useState("");
  const [deliveries, setDeliveries] = useState<CommandDelivery[]>([]);
  const connection = useRef<{
    viewerKey: string;
    client: TableConnection;
  } | null>(null);
  useEffect(() => {
    setSnapshot(null);
    setParticipants(0);
    setError("");
    setDeliveries([]);
    setStatus("connecting");
    if (!viewerKey || !campaignId) return;
    const url = new URL("/api/live", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("campaignId", campaignId);
    url.searchParams.set("protocolVersion", String(PROTOCOL_VERSION));
    const client = new TableConnection(url.href, campaignId, {
      delivery: (result) =>
        setDeliveries((previous) => {
          const all = [
            result,
            ...previous.filter((item) => item.id !== result.id),
          ];
          let finished = 0;
          return all.filter(
            (item) => item.status === "pending" || finished++ < 20,
          );
        }),
      probe: async (signal) => {
        const response = await fetch("/api/health", {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        if (!response.ok) throw new Error("Server unavailable.");
        return z
          .object({
            status: z.literal("ok"),
            protocolVersion: z.number().int().positive(),
          })
          .parse(await response.json()).protocolVersion;
      },
      open: (address, handlers) => {
        const socket = new WebSocket(address);
        socket.onmessage = (event) => handlers.message(event.data);
        socket.onclose = (event) => handlers.close(event.code);
        socket.onerror = () => handlers.error();
        return socket;
      },
      schedule: (action, delay) => {
        const timer = setTimeout(action, delay);
        return () => clearTimeout(timer);
      },
      random: Math.random,
      refreshAccess: onUnauthorized,
      snapshot: (message) => setSnapshot({ viewerKey, ...message }),
      participants: setParticipants,
      clear: () => setSnapshot(null),
      status: setStatus,
      error: setError,
    });
    connection.current = { viewerKey, client };
    client.start();
    return () => {
      client.stop();
      if (connection.current?.client === client) connection.current = null;
    };
  }, [viewerKey, onUnauthorized, campaignId]);
  const context = snapshot?.viewerKey === viewerKey ? snapshot.context : null;
  const send = useCallback(
    (command: CommandInput) => {
      if (!viewerKey || connection.current?.viewerKey !== viewerKey) {
        setError("Sign in to the table before making changes.");
        return false;
      }
      return connection.current.client.send(context, command);
    },
    [viewerKey, context],
  );
  const current = snapshot?.viewerKey === viewerKey;
  return {
    state: current ? snapshot.state : null,
    context,
    history: current ? snapshot.history : null,
    background: current ? snapshot.background : null,
    backgroundVersion: current ? snapshot.backgroundVersion : null,
    campaignName: current ? snapshot.campaignName : "",
    sceneName: current ? snapshot.sceneName : "",
    status: connection.current?.viewerKey === viewerKey ? status : "connecting",
    participants: current ? participants : 0,
    error,
    deliveries: connection.current?.viewerKey === viewerKey ? deliveries : [],
    clearError: () => setError(""),
    send,
  };
}
