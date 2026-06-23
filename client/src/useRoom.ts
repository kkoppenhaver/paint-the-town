import { useCallback, useEffect, useRef, useState } from "react";
import type { AreaId, Config, TeamId } from "@ptt/engine";
import { WS_URL, type ClientMessage, type Intent, type ServerMessage } from "./net";

export interface RoomView {
  phase: "lobby" | "running" | "finished";
  spawns: Record<TeamId, AreaId>;
  state: ServerMessage extends never ? never : Extract<ServerMessage, { type: "state" }>["state"];
  connected: boolean;
  error: string | null;
  setSpawn: (teamId: TeamId, areaId: AreaId) => void;
  setConfig: (config: Config) => void;
  start: () => void;
  reset: () => void;
  sendIntent: (teamId: TeamId, intent: Intent) => void;
}

export function useRoom(room: string): RoomView {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<RoomView["phase"]>("lobby");
  const [spawns, setSpawns] = useState<Record<TeamId, AreaId>>({});
  const [state, setState] = useState<RoomView["state"]>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Room id rides in the URL so the host (Cloudflare Worker) can route to the right
    // Durable Object before the upgrade; the join message below is then a no-op resync.
    const ws = new WebSocket(`${WS_URL}/ws?room=${encodeURIComponent(room)}`);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "join", room } satisfies ClientMessage));
    };
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerMessage;
      if (msg.type === "state") {
        setPhase(msg.phase);
        setSpawns(msg.spawns);
        setState(msg.state);
        setError(null);
      } else if (msg.type === "error") {
        setError(msg.message);
      }
    };
    return () => ws.close();
  }, [room]);

  const send = useCallback((m: ClientMessage) => {
    wsRef.current?.send(JSON.stringify(m));
  }, []);

  return {
    phase,
    spawns,
    state,
    connected,
    error,
    setSpawn: (teamId, areaId) => send({ type: "setSpawn", teamId, areaId }),
    setConfig: (config) => send({ type: "setConfig", config }),
    start: () => send({ type: "start" }),
    reset: () => send({ type: "reset" }),
    sendIntent: (teamId, intent) => send({ type: "intent", teamId, intent }),
  };
}
