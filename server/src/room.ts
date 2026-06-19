// One game = one room. The room holds canonical state, runs the clock tick, and
// resolves arrivals / contractions / cache spawns / captures (spec §10).

import {
  advance,
  allCommitted,
  createGame,
  DEFAULT_CONFIG,
  cloneConfig,
  estimateProvider,
  createGoogleProvider,
  isIdle,
  submitClaim,
  submitTravel,
  submitWait,
  usePowerUp,
  type Board,
  type Config,
  type GameState,
  type TravelProvider,
  type TeamId,
  type AreaId,
} from "@ptt/engine";
import type { Intent } from "./protocol.js";

export class Room {
  phase: "lobby" | "running" | "finished" = "lobby";
  config: Config = cloneConfig(DEFAULT_CONFIG);
  spawns: Record<TeamId, AreaId> = {};
  state: GameState | null = null;
  private provider: TravelProvider;

  constructor(
    public readonly id: string,
    private board: Board,
  ) {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    this.provider = key ? createGoogleProvider(key) : estimateProvider;
    this.config.travel.provider = key ? "google" : "estimate";
  }

  setSpawn(teamId: TeamId, areaId: AreaId): void {
    if (this.phase !== "lobby") throw new Error("game already started");
    this.spawns[teamId] = areaId;
  }

  setConfig(config: Config): void {
    // Hot-editable: pre-game replaces wholesale; mid-game patches tunables only.
    if (this.phase === "lobby") this.config = config;
    else if (this.state) {
      this.state.config.bandValues = config.bandValues;
      this.state.config.challenge = config.challenge;
      this.state.config.powerUps = config.powerUps;
      this.state.config.travel = config.travel;
    }
  }

  start(): void {
    for (const t of this.config.game.teams) {
      if (this.spawns[t.id] == null) throw new Error(`team ${t.id} has no spawn`);
    }
    this.state = createGame(this.config, this.board, this.spawns);
    this.phase = "running";
  }

  reset(): void {
    this.phase = "lobby";
    this.state = null;
    this.spawns = {};
  }

  /** Apply an intent, then fast-forward the clock to the next decision point. */
  async applyIntent(teamId: TeamId, intent: Intent): Promise<void> {
    if (!this.state || this.phase !== "running") throw new Error("game not running");
    const s = this.state;

    switch (intent.kind) {
      case "travel":
        await submitTravel(s, this.board, this.provider, teamId, intent.destId);
        break;
      case "claim":
        submitClaim(s, this.board, teamId);
        break;
      case "wait":
        submitWait(s, teamId);
        break;
      case "powerup":
        usePowerUp(s, this.board, teamId, intent.powerUp, {
          targetAreaId: intent.targetAreaId,
          rivalTeamId: intent.rivalTeamId,
        });
        break;
    }

    // Decision-driven clock: roll forward while every team is committed, stopping
    // the instant someone becomes idle (a pending decision) or the game ends.
    let guard = 0;
    while (s.clock.phase === "running" && allCommitted(s) && guard++ < 100_000) {
      advance(s, this.board);
    }
    if (s.clock.phase === "finished") this.phase = "finished";
  }

  /** Teams currently facing a decision (clock frozen for them). */
  idleTeams(): TeamId[] {
    if (!this.state) return [];
    return this.state.teams.filter(isIdle).map((t) => t.id);
  }
}
