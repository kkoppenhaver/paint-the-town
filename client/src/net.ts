import type { AreaId, Config, GameState, PowerUpType, TeamId } from "@ptt/engine";

const WS_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_SERVER_URL ?? "ws://localhost:8787";
export const HTTP_BASE = WS_URL.replace(/^ws/, "http");

export type Intent =
  | { kind: "travel"; destId: AreaId }
  | { kind: "claim" }
  | { kind: "wait" }
  | { kind: "powerup"; powerUp: PowerUpType; targetAreaId?: AreaId; rivalTeamId?: TeamId };

export type ClientMessage =
  | { type: "join"; room: string }
  | { type: "setSpawn"; teamId: TeamId; areaId: AreaId }
  | { type: "setConfig"; config: Config }
  | { type: "start" }
  | { type: "reset" }
  | { type: "intent"; teamId: TeamId; intent: Intent };

export type ServerMessage =
  | { type: "state"; phase: "lobby" | "running" | "finished"; spawns: Record<TeamId, AreaId>; state: GameState | null }
  | { type: "error"; message: string };

export { WS_URL };
