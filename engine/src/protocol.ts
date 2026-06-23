// Wire protocol shared by the realtime hosts (Node server, Cloudflare DO) and the
// client. Clients send only intents; the host is the referee and broadcasts the
// authoritative state (spec §10).

import type { AreaId, GameState, PowerUpType, TeamId, Config } from "./types.js";

export type ClientMessage =
  | { type: "join"; room: string }
  | { type: "setSpawn"; teamId: TeamId; areaId: AreaId }
  | { type: "setConfig"; config: Config }
  | { type: "start" }
  | { type: "reset" }
  | { type: "intent"; teamId: TeamId; intent: Intent };

export type Intent =
  | { kind: "travel"; destId: AreaId }
  | { kind: "claim" }
  | { kind: "wait" }
  | { kind: "powerup"; powerUp: PowerUpType; targetAreaId?: AreaId; rivalTeamId?: TeamId };

export type ServerMessage =
  | { type: "state"; phase: "lobby" | "running" | "finished"; spawns: Record<TeamId, AreaId>; state: GameState | null }
  | { type: "error"; message: string };
