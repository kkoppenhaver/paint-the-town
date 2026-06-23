// One game = one room. The room holds canonical state, runs the clock tick, and
// resolves arrivals / contractions / cache spawns / captures (spec §10). It is host-
// agnostic: the Node server and the Cloudflare Durable Object both wrap this same class
// and inject the travel provider, so the two hosts can never drift.

import { buildDebugLog, type DebugLog } from "./debugLog.js";
import {
  createGame,
  isIdle,
  submitClaim,
  submitTravel,
  submitWait,
  tick,
  usePowerUp,
} from "./engine.js";
import { DEFAULT_CONFIG, cloneConfig } from "./config.js";
import type { Board, Config, GameState, TeamId, AreaId } from "./types.js";
import type { TravelProvider } from "./travel/provider.js";
import type { Intent } from "./protocol.js";

export type RoomPhase = "lobby" | "running" | "finished";

/** Serializable room state — everything needed to rebuild a room after the host process
 *  restarts or a Durable Object is evicted. The travel provider is NOT included; the host
 *  re-injects it on restore. */
export interface RoomSnapshot {
  phase: RoomPhase;
  config: Config;
  spawns: Record<TeamId, AreaId>;
  state: GameState | null;
  debugLogged: boolean;
  lastTickReal: number;
}

/** A real-time tick that fast-forwards a full hibernated interval would teleport the game
 *  clock; cap the elapsed real time we honor per tick so a cold DO wake stays sane. */
const MAX_TICK_DT_SEC = 2;

export class Room {
  phase: RoomPhase = "lobby";
  config: Config = cloneConfig(DEFAULT_CONFIG);
  spawns: Record<TeamId, AreaId> = {};
  state: GameState | null = null;
  /** Set once a finished game's debug log has been written (avoid duplicate writes). */
  debugLogged = false;
  private lastTickReal = 0; // epoch ms of the previous clock tick

  constructor(
    public readonly id: string,
    private board: Board,
    private provider: TravelProvider,
    providerName: Config["travel"]["provider"] = "estimate",
  ) {
    this.config.travel.provider = providerName;
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

  start(nowReal: number): void {
    for (const t of this.config.game.teams) {
      if (this.spawns[t.id] == null) throw new Error(`team ${t.id} has no spawn`);
    }
    this.state = createGame(this.config, this.board, this.spawns);
    this.phase = "running";
    this.debugLogged = false;
    this.lastTickReal = nowReal;
  }

  /**
   * Advance the real-time clock since the last tick. Time creeps while a team has a
   * pending decision and fast-forwards while all teams are committed (executing
   * travel/challenges). Returns true if any game-time elapsed (i.e. broadcast-worthy).
   * `nowReal` is epoch ms supplied by the host (Date.now() on Node, the alarm time on a DO).
   */
  tickClock(nowReal: number): boolean {
    if (this.phase !== "running" || !this.state) return false;
    const dtSec = Math.min((nowReal - this.lastTickReal) / 1000, MAX_TICK_DT_SEC);
    this.lastTickReal = nowReal;
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

  /** Apply an intent. The real-time tick loop owns the clock, so committing both teams
   *  makes time fast-forward on the next tick rather than jumping instantly here. */
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
  }

  /** Teams currently facing a decision (clock frozen for them). */
  idleTeams(): TeamId[] {
    if (!this.state) return [];
    return this.state.teams.filter(isIdle).map((t) => t.id);
  }

  /** Capture full room state for persistence (DO snapshot / restart recovery). */
  snapshot(): RoomSnapshot {
    return {
      phase: this.phase,
      config: this.config,
      spawns: this.spawns,
      state: this.state,
      debugLogged: this.debugLogged,
      lastTickReal: this.lastTickReal,
    };
  }

  /** Rehydrate from a previously captured snapshot (provider stays injected). */
  restore(snap: RoomSnapshot): void {
    this.phase = snap.phase;
    this.config = snap.config;
    this.spawns = snap.spawns;
    this.state = snap.state;
    this.debugLogged = snap.debugLogged;
    this.lastTickReal = snap.lastTickReal;
  }
}
