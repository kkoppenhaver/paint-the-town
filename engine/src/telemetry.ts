// Per-run telemetry (spec §9) — the metrics that answer the open tuning dials.

import { largestConnectedRegion } from "./board.js";
import type { AreaId, Board, GameState, TeamId } from "./types.js";

export interface BandBreakdown {
  band: number;
  claimed: number; // areas finally held in this band (across both teams)
  points: number; // points those held areas contribute
  flips: number; // total successful claims+captures in this band over the game
}

export interface TeamTelemetry {
  teamId: TeamId;
  name: string;
  lockedScore: number;
  areasHeld: number;
  largestRegion: number;
  transitMinutes: number;
  claimMinutes: number;
  captures: number;
  successfulClaims: number;
  failedClaims: number;
  cacheGrabs: number;
}

export interface Telemetry {
  seed: number;
  gameLengthMin: number;
  winnerTeamId: TeamId | null;
  margin: number; // |lockedScore difference| of the top two
  leadChanges: number;
  decidedBeforeBuzzer: boolean; // was the buzzer-phase swingable?
  scoreSeries: Array<{ simTime: number; scores: Record<TeamId, number> }>;
  perBand: BandBreakdown[];
  teams: TeamTelemetry[];
  travelSources: Record<string, number>; // google / estimate / cap counts
}

function heldBy(state: GameState, teamId: TeamId): Set<AreaId> {
  const s = new Set<AreaId>();
  for (const a of Object.values(state.areas)) if (a.holderTeamId === teamId) s.add(a.id);
  return s;
}

export function computeTelemetry(state: GameState, board: Board): Telemetry {
  const bandOf = (id: AreaId) => board.areas.find((a) => a.id === id)!.band;
  const valueOf = (id: AreaId) =>
    state.config.bandValues[String(bandOf(id)) as "1" | "2" | "3" | "4"];

  // ---- per-team aggregates from the event log + final state ----
  const teams: TeamTelemetry[] = state.teams.map((t) => ({
    teamId: t.id,
    name: t.name,
    lockedScore: t.lockedScore,
    areasHeld: heldBy(state, t.id).size,
    largestRegion: largestConnectedRegion(board, heldBy(state, t.id)),
    transitMinutes: 0,
    claimMinutes: 0,
    captures: 0,
    successfulClaims: 0,
    failedClaims: 0,
    cacheGrabs: 0,
  }));
  const byTeam = new Map(teams.map((t) => [t.teamId, t]));

  const travelSources: Record<string, number> = {};
  // pair travel_start with the subsequent arrive to attribute transit minutes;
  // claim_start with its resolution for claim minutes.
  const pendingTravel = new Map<TeamId, number>();
  const pendingClaim = new Map<TeamId, number>();

  for (const e of state.log) {
    const tt = e.teamId ? byTeam.get(e.teamId) : undefined;
    switch (e.type) {
      case "travel_start": {
        if (e.teamId) pendingTravel.set(e.teamId, e.simTime);
        const src = String(e.detail?.source ?? "estimate");
        travelSources[src] = (travelSources[src] ?? 0) + 1;
        break;
      }
      case "arrive": {
        if (e.teamId && tt && pendingTravel.has(e.teamId)) {
          tt.transitMinutes += e.simTime - pendingTravel.get(e.teamId)!;
          pendingTravel.delete(e.teamId);
        }
        break;
      }
      case "claim_start":
        if (e.teamId) pendingClaim.set(e.teamId, e.simTime);
        break;
      case "claim_success":
      case "capture":
      case "claim_fail": {
        if (e.teamId && tt && pendingClaim.has(e.teamId)) {
          tt.claimMinutes += e.simTime - pendingClaim.get(e.teamId)!;
          pendingClaim.delete(e.teamId);
        }
        if (tt && e.type === "claim_success") tt.successfulClaims++;
        if (tt && e.type === "capture") {
          tt.captures++;
          tt.successfulClaims++;
        }
        if (tt && e.type === "claim_fail") tt.failedClaims++;
        break;
      }
      case "cache_grab":
        if (tt) tt.cacheGrabs++;
        break;
    }
  }

  // ---- score-over-time series + lead changes, sampled at every flip/lock ----
  const series: Telemetry["scoreSeries"] = [];
  let leadChanges = 0;
  let lastLeader: TeamId | null | undefined;
  const running: Record<TeamId, number> = {};
  for (const t of state.teams) running[t.id] = 0;

  // Replay flips chronologically using band values to track provisional+locked.
  const holder: Record<AreaId, TeamId | null> = {};
  for (const a of board.areas) holder[a.id] = null;
  const recompute = () => {
    for (const t of state.teams) running[t.id] = 0;
    for (const a of board.areas) {
      const h = holder[a.id];
      if (h) running[h] = (running[h] ?? 0) + valueOf(a.id);
    }
  };
  for (const e of state.log) {
    if ((e.type === "claim_success" || e.type === "capture") && e.areaId != null && e.teamId) {
      holder[e.areaId] = e.teamId;
      recompute();
      series.push({ simTime: e.simTime, scores: { ...running } });
      const leader = currentLeader(running);
      if (lastLeader !== undefined && leader !== lastLeader && leader != null) leadChanges++;
      lastLeader = leader;
    }
  }

  // ---- per-band breakdown ----
  const perBand: BandBreakdown[] = [1, 2, 3, 4].map((band) => {
    const areas = board.areas.filter((a) => a.band === band);
    let claimed = 0;
    let points = 0;
    for (const a of areas) {
      if (state.areas[String(a.id)]!.holderTeamId) {
        claimed++;
        points += valueOf(a.id);
      }
    }
    const flips = state.log.filter(
      (e) =>
        (e.type === "claim_success" || e.type === "capture") &&
        e.areaId != null &&
        bandOf(e.areaId) === band,
    ).length;
    return { band, claimed, points, flips };
  });

  // ---- margin + decided-before-buzzer ----
  const ranked = [...teams].sort((a, b) => b.lockedScore - a.lockedScore);
  const margin =
    ranked.length >= 2 ? Math.abs(ranked[0]!.lockedScore - ranked[1]!.lockedScore) : 0;

  // Was the game decidable at the buzzer? Compare the pre-core lead to the total
  // core (Band 1) value still in play at the final contraction.
  const coreValue = board.areas
    .filter((a) => a.band === 1)
    .reduce((s, a) => s + valueOf(a.id), 0);
  const lastContraction = [...state.log].reverse().find((e) => e.type === "contraction");
  let leadAtLastContraction = 0;
  if (lastContraction) {
    const snap = series.filter((s) => s.simTime <= lastContraction.simTime).at(-1);
    if (snap) {
      const vals = Object.values(snap.scores).sort((a, b) => b - a);
      leadAtLastContraction = (vals[0] ?? 0) - (vals[1] ?? 0);
    }
  }
  const decidedBeforeBuzzer = leadAtLastContraction > coreValue;

  return {
    seed: state.config.game.seed,
    gameLengthMin: state.config.game.gameLengthMin,
    winnerTeamId: state.winnerTeamId,
    margin,
    leadChanges,
    decidedBeforeBuzzer,
    scoreSeries: series,
    perBand,
    teams,
    travelSources,
  };
}

function currentLeader(scores: Record<TeamId, number>): TeamId | null {
  let best: TeamId | null = null;
  let bestVal = -Infinity;
  let tie = false;
  for (const [id, v] of Object.entries(scores)) {
    if (v > bestVal) {
      best = id;
      bestVal = v;
      tie = false;
    } else if (v === bestVal) tie = true;
  }
  return tie ? null : best;
}

/** Flatten telemetry to a single CSV row (spec §6 export). */
export function telemetryToCsvRow(t: Telemetry): string {
  const a = t.teams[0];
  const b = t.teams[1];
  const cols = [
    t.seed,
    t.winnerTeamId ?? "tie",
    t.margin,
    t.leadChanges,
    t.decidedBeforeBuzzer ? 1 : 0,
    a?.lockedScore ?? "",
    a?.areasHeld ?? "",
    a?.transitMinutes ?? "",
    a?.captures ?? "",
    b?.lockedScore ?? "",
    b?.areasHeld ?? "",
    b?.transitMinutes ?? "",
    b?.captures ?? "",
  ];
  return cols.join(",");
}

export const CSV_HEADER =
  "seed,winner,margin,leadChanges,decidedBeforeBuzzer," +
  "A_score,A_areas,A_transitMin,A_captures,B_score,B_areas,B_transitMin,B_captures";
