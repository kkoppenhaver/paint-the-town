// Headless runner (spec §8 / Phase 3): drives both teams with scripted greedy AIs
// at full speed, no real-time waiting. Used for pacing tests and balance sweeps.

import {
  advance,
  allCommitted,
  areaState,
  createGame,
  isIdle,
  isLiveArea,
  submitClaim,
  submitTravel,
  submitWait,
} from "./engine.js";
import { distanceKm, getArea } from "./board.js";
import type { TravelProvider } from "./travel/provider.js";
import type { AreaId, Board, Config, GameState, Team, TeamId } from "./types.js";

export type Strategy = "greedy_value" | "core_rush" | "edge_sweep";

interface Decision {
  kind: "claim" | "travel" | "wait";
  destId?: AreaId;
}

/** Claimable by `team` right now: live, deck left, not already ours, not locked-down. */
function claimable(state: GameState, board: Board, team: Team, id: AreaId): boolean {
  if (!isLiveArea(state, board, id)) return false;
  const a = areaState(state, id);
  if (a.deckRemaining <= 0) return false;
  if (a.holderTeamId === team.id) return false;
  if (a.holderTeamId != null && a.lockdownUntil != null && a.lockdownUntil > state.clock.simTime) {
    return false;
  }
  return true;
}

function candidateScore(
  state: GameState,
  board: Board,
  team: Team,
  id: AreaId,
  strategy: Strategy,
): number {
  const area = getArea(board, id);
  const value = state.config.bandValues[String(area.band) as "1" | "2" | "3" | "4"];
  const dist = distanceKm(getArea(board, team.locationAreaId).centroid, area.centroid);
  const outermostLive = Math.max(...state.wall.liveBands);
  switch (strategy) {
    case "core_rush":
      return (value * value) / (dist + 2);
    case "edge_sweep": {
      // Models the "sweep inward" arc: grab whatever the wall is about to lock,
      // nearest first, almost regardless of value; fall back to value otherwise.
      if (area.band === outermostLive) return 1000 / (dist + 1);
      return value / (dist + 1);
    }
    case "greedy_value":
    default:
      return value / (dist + 2);
  }
}

function decide(state: GameState, board: Board, team: Team, strategy: Strategy): Decision {
  // Standing on something worth claiming? Take it.
  if (claimable(state, board, team, team.locationAreaId)) return { kind: "claim" };

  let best: { id: AreaId; score: number } | null = null;
  for (const area of board.areas) {
    if (area.id === team.locationAreaId) continue;
    if (!claimable(state, board, team, area.id)) continue;
    const score = candidateScore(state, board, team, area.id, strategy);
    if (!best || score > best.score) best = { id: area.id, score };
  }
  return best ? { kind: "travel", destId: best.id } : { kind: "wait" };
}

export interface RunOptions {
  config: Config;
  board: Board;
  provider: TravelProvider;
  spawns: Record<TeamId, AreaId>;
  strategies: Record<TeamId, Strategy>;
  /** Safety cap on clock advances to guarantee termination. */
  maxSteps?: number;
}

export async function runGame(opts: RunOptions): Promise<GameState> {
  const { config, board, provider, spawns, strategies } = opts;
  const state = createGame(config, board, spawns);
  const maxSteps = opts.maxSteps ?? 100_000;

  let steps = 0;
  while (state.clock.phase === "running" && steps++ < maxSteps) {
    // Serialize decisions: every idle team commits to something this round.
    for (const team of state.teams) {
      if (!isIdle(team)) continue;
      const d = decide(state, board, team, strategies[team.id] ?? "greedy_value");
      try {
        if (d.kind === "claim") submitClaim(state, board, team.id);
        else if (d.kind === "travel" && d.destId != null)
          await submitTravel(state, board, provider, team.id, d.destId);
        else submitWait(state, team.id);
      } catch {
        submitWait(state, team.id); // never let a bad decision stall the sim
      }
    }
    if (allCommitted(state)) advance(state, board);
  }
  return state;
}
