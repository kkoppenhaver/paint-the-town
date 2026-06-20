// One game = one room. The room holds canonical state, runs the clock tick, and
// resolves arrivals / contractions / cache spawns / captures (spec §10).

import {
  buildDebugLog,
  createGame,
  DEFAULT_CONFIG,
  cloneConfig,
  estimateProvider,
  createGoogleProvider,
  isIdle,
  submitClaim,
  submitTravel,
  submitWait,
  tick,
  usePowerUp,
  type Board,
  type Config,
  type DebugLog,
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
  /** Set once a finished game's debug log has been written (avoid duplicate writes). */
  debugLogged = false;
  private provider: TravelProvider;
  private lastTickReal = 0; // epoch ms of the previous clock tick

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
      this.state.config.pacing = config.pacing;
    }
  }

  start(): void {
    for (const t of this.config.game.teams) {
      if (this.spawns[t.id] == null) throw new Error(`team ${t.id} has no spawn`);
    }
    this.state = createGame(this.config, this.board, this.spawns);
    this.phase = "running";
    this.debugLogged = false;
    this.lastTickReal = Date.now();
  }

  /**
   * Advance the real-time clock since the last tick. Time creeps while a team has a
   * pending decision and fast-forwards while all teams are committed (executing
   * travel/challenges). Returns true if any game-time elapsed (i.e. broadcast-worthy).
   */
  tickClock(): boolean {
    if (this.phase !== "running" || !this.state) return false;
    const now = Date.now();
    const dtSec = (now - this.lastTickReal) / 1000;
    this.lastTickReal = now;
    if (dtSec <= 0) return false;
    const pacing = this.state.config.pacing; // live config (patchable mid-game)
    const anyDeciding = this.state.teams.some(isIdle);
    const rate = anyDeciding ? pacing.decisionGameMinPerSec : pacing.executionGameMinPerSec;
    if (rate <= 0 && anyDeciding) return false; // frozen-while-deciding mode (rate 0)
    tick(this.state, this.board, rate * dtSec);
    if (this.state.clock.phase === "finished") this.phase = "finished";
    return true;
  }

  reset(): void {
    this.phase = "lobby";
    this.state = null;
    this.spawns = {};
    this.debugLogged = false;
  }

  /** Build a debug/audit log of the current game (null if no game exists yet). */
  debugSnapshot(meta: { generatedAtReal: string }): DebugLog | null {
    if (!this.state) return null;
    return buildDebugLog(this.state, this.board, meta);
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
    // The real-time tick loop (tickClock) owns the clock now: committing both teams
    // makes time fast-forward on the next tick rather than jumping instantly here.
  }

  /** Teams currently facing a decision (clock frozen for them). */
  idleTeams(): TeamId[] {
    if (!this.state) return [];
    return this.state.teams.filter(isIdle).map((t) => t.id);
  }
}
