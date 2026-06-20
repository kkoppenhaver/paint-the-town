// Per-run debug/audit log. Captures the full event timeline plus time-accounting
// so a run can be audited against reality: every travel leg (minutes + provider
// source) and every challenge (duration + outcome) is itemized, and per-team time
// is split into transit / challenge / idle against the game-length budget. The
// question this answers: "does the in-game time the sim spent map to real time?"

import { computeTelemetry } from "./telemetry.js";
import type { AreaId, Board, Config, GameState, TeamId } from "./types.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Notional in-game datetime: notionalStart + simTime minutes (matches the client HUD). */
export function formatClock(config: Config, simTime: number): string {
  const { weekday, hour, minute } = config.game.notionalStart;
  const total = hour * 60 + minute + simTime;
  const dayOffset = Math.floor(total / (24 * 60));
  const mins = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${DAYS[(weekday + dayOffset) % 7]} ${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export interface TravelLeg {
  teamId: TeamId;
  fromId: AreaId;
  fromName: string;
  toId: AreaId;
  toName: string;
  minutes: number;
  source: string; // "google" | "estimate" | "cap"
  summary?: string;
  departSimTime: number;
  arriveSimTime: number;
}

export interface ChallengeAttempt {
  teamId: TeamId;
  areaId: AreaId;
  areaName: string;
  challengeId?: string;
  title?: string;
  type?: string;
  difficulty?: number;
  durationMin: number;
  startSimTime: number;
  endSimTime: number;
  result: "success" | "capture" | "fail" | "fail_wall";
}

export interface TimelineEntry {
  simTime: number;
  clock: string;
  type: string;
  team?: string;
  area?: string;
  detail?: Record<string, unknown>;
}

export interface TeamTimeAccount {
  teamId: TeamId;
  name: string;
  transitMinutes: number;
  challengeMinutes: number;
  activeMinutes: number; // transit + challenge
  idleMinutes: number; // game length − active (thinking / waiting / held)
  travelLegs: number;
  challengeAttempts: number;
}

export interface DebugLog {
  generatedAtReal: string;
  realDurationMs?: number; // wall-clock time to simulate (headless)
  config: {
    seed: number;
    gameLengthMin: number;
    notionalStart: Config["game"]["notionalStart"];
    travelProvider: string;
    contractionsAtMin: number[];
    challenge: Config["challenge"];
  };
  spawns: Array<{ teamId: TeamId; areaId: AreaId; areaName: string }>;
  strategies?: Record<TeamId, string>;
  result: {
    winnerTeamId: TeamId | null;
    simMinutesElapsed: number;
    finalScores: Array<{ teamId: TeamId; name: string; locked: number; provisional: number }>;
  };
  timeAccounting: TeamTimeAccount[];
  travelLegs: TravelLeg[];
  challengeAttempts: ChallengeAttempt[];
  audit: {
    totalTravelMinutes: number; // person-minutes (summed across teams)
    totalChallengeMinutes: number;
    travelSources: Record<string, number>;
    longestTravelLeg?: { minutes: number; from: string; to: string; source: string };
    note: string;
  };
  timeline: TimelineEntry[];
}

export function buildDebugLog(
  state: GameState,
  board: Board,
  meta: { generatedAtReal: string; realDurationMs?: number; strategies?: Record<TeamId, string> },
): DebugLog {
  const nameOf = (id: AreaId) => board.areas.find((a) => a.id === id)?.name ?? `#${id}`;
  const teamName = (id: TeamId) => state.teams.find((t) => t.id === id)?.name ?? id;
  const tel = computeTelemetry(state, board);

  // ---- walk the log: travel legs + challenge attempts ----
  const travelLegs: TravelLeg[] = [];
  const challengeAttempts: ChallengeAttempt[] = [];
  const pendingTravel = new Map<TeamId, { from: AreaId; depart: number; to: AreaId; minutes: number; source: string; summary?: string }>();
  const pendingClaim = new Map<TeamId, { area: AreaId; start: number; duration: number; challenge?: { id?: string; title?: string; type?: string; difficulty?: number } }>();

  for (const e of state.log) {
    switch (e.type) {
      case "travel_start": {
        if (!e.teamId || e.areaId == null) break;
        pendingTravel.set(e.teamId, {
          from: e.areaId,
          depart: e.simTime,
          to: Number(e.detail?.destId),
          minutes: Number(e.detail?.minutes ?? 0),
          source: String(e.detail?.source ?? "estimate"),
          summary: e.detail?.summary != null ? String(e.detail.summary) : undefined,
        });
        break;
      }
      case "arrive": {
        const p = e.teamId ? pendingTravel.get(e.teamId) : undefined;
        if (p && e.teamId) {
          travelLegs.push({
            teamId: e.teamId,
            fromId: p.from,
            fromName: nameOf(p.from),
            toId: e.areaId ?? p.to,
            toName: nameOf(e.areaId ?? p.to),
            minutes: p.minutes,
            source: p.source,
            summary: p.summary,
            departSimTime: p.depart,
            arriveSimTime: e.simTime,
          });
          pendingTravel.delete(e.teamId);
        }
        break;
      }
      case "claim_start": {
        if (!e.teamId || e.areaId == null) break;
        pendingClaim.set(e.teamId, {
          area: e.areaId,
          start: e.simTime,
          duration: Number(e.detail?.duration ?? 0),
          challenge: e.detail?.challenge as ChallengeAttempt | undefined,
        });
        break;
      }
      case "claim_success":
      case "capture":
      case "claim_fail": {
        const p = e.teamId ? pendingClaim.get(e.teamId) : undefined;
        if (p && e.teamId) {
          challengeAttempts.push({
            teamId: e.teamId,
            areaId: p.area,
            areaName: nameOf(p.area),
            challengeId: p.challenge?.id,
            title: p.challenge?.title,
            type: p.challenge?.type,
            difficulty: p.challenge?.difficulty,
            durationMin: e.simTime - p.start,
            startSimTime: p.start,
            endSimTime: e.simTime,
            result:
              e.type === "capture"
                ? "capture"
                : e.type === "claim_success"
                  ? "success"
                  : e.detail?.reason === "wall"
                    ? "fail_wall"
                    : "fail",
          });
          pendingClaim.delete(e.teamId);
        }
        break;
      }
    }
  }

  // ---- per-team time accounting ----
  const timeAccounting: TeamTimeAccount[] = state.teams.map((t) => {
    const tt = tel.teams.find((x) => x.teamId === t.id);
    const transit = tt?.transitMinutes ?? 0;
    const challenge = tt?.claimMinutes ?? 0;
    const active = transit + challenge;
    return {
      teamId: t.id,
      name: t.name,
      transitMinutes: round(transit),
      challengeMinutes: round(challenge),
      activeMinutes: round(active),
      idleMinutes: round(state.config.game.gameLengthMin - active),
      travelLegs: travelLegs.filter((l) => l.teamId === t.id).length,
      challengeAttempts: challengeAttempts.filter((c) => c.teamId === t.id).length,
    };
  });

  const totalTravel = travelLegs.reduce((s, l) => s + l.minutes, 0);
  const totalChallenge = challengeAttempts.reduce((s, c) => s + c.durationMin, 0);
  const longest = travelLegs.reduce<TravelLeg | null>((m, l) => (!m || l.minutes > m.minutes ? l : m), null);

  return {
    generatedAtReal: meta.generatedAtReal,
    realDurationMs: meta.realDurationMs,
    config: {
      seed: state.config.game.seed,
      gameLengthMin: state.config.game.gameLengthMin,
      notionalStart: state.config.game.notionalStart,
      travelProvider: state.config.travel.provider,
      contractionsAtMin: state.config.wall.contractionsAtMin,
      challenge: state.config.challenge,
    },
    spawns: state.teams.map((t) => {
      // Spawn = origin of the team's first travel leg (where they departed from); if
      // they never moved, their final location is still their spawn.
      const firstLeg = travelLegs.find((l) => l.teamId === t.id);
      const areaId = firstLeg ? firstLeg.fromId : t.locationAreaId;
      return { teamId: t.id, areaId, areaName: nameOf(areaId) };
    }),
    strategies: meta.strategies,
    result: {
      winnerTeamId: state.winnerTeamId,
      simMinutesElapsed: round(state.clock.simTime),
      finalScores: state.teams.map((t) => ({
        teamId: t.id,
        name: t.name,
        locked: t.lockedScore,
        provisional: t.provisionalScore,
      })),
    },
    timeAccounting,
    travelLegs,
    challengeAttempts,
    audit: {
      totalTravelMinutes: round(totalTravel),
      totalChallengeMinutes: round(totalChallenge),
      travelSources: tel.travelSources,
      longestTravelLeg: longest
        ? { minutes: longest.minutes, from: longest.fromName, to: longest.toName, source: longest.source }
        : undefined,
      note:
        "Travel minutes come from the " +
        state.config.travel.provider +
        " provider and are meant to be real Chicago transit times; challenge minutes are placeholder durations drawn from challenge.durationMinRange. Audit each leg/challenge below against plausible real-world time. Per-team totals are sequential (transit+challenge+idle = gameLength); cross-team totals are person-minutes.",
    },
    timeline: state.log.map((e) => ({
      simTime: round(e.simTime),
      clock: formatClock(state.config, e.simTime),
      type: e.type,
      team: e.teamId ? teamName(e.teamId) : undefined,
      area: e.areaId != null ? nameOf(e.areaId) : undefined,
      detail: e.detail && Object.keys(e.detail).length ? e.detail : undefined,
    })),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Human-readable rendering of a debug log for quick eyeballing in a .txt file. */
export function formatDebugLogText(d: DebugLog): string {
  const L: string[] = [];
  L.push(`PAINT THE TOWN — sim debug log`);
  L.push(`generated: ${d.generatedAtReal}${d.realDurationMs != null ? `  (simulated in ${d.realDurationMs} ms)` : ""}`);
  L.push(`seed ${d.config.seed} · ${d.config.gameLengthMin}min game · travel: ${d.config.travelProvider} · contractions @ ${d.config.contractionsAtMin.join("/")}min`);
  L.push(`challenge duration ${d.config.challenge.durationMinRange.join("–")}min, fail ${Math.round(d.config.challenge.failChance * 100)}%, retry +${d.config.challenge.retryPenaltyMin}min`);
  if (d.strategies) L.push(`strategies: ${Object.entries(d.strategies).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  L.push("");
  L.push(`SPAWNS: ${d.spawns.map((s) => `${s.teamId}→${s.areaName}`).join(" · ")}`);
  L.push(`RESULT: winner ${d.result.winnerTeamId ?? "tie"} · ran to ${d.result.simMinutesElapsed}/${d.config.gameLengthMin} min`);
  L.push(`SCORES: ${d.result.finalScores.map((s) => `${s.name} ${s.locked} (+${s.provisional})`).join(" · ")}`);
  L.push("");
  L.push(`TIME ACCOUNTING (per team, of ${d.config.gameLengthMin} min):`);
  for (const t of d.timeAccounting) {
    const pct = (n: number) => `${Math.round((100 * n) / d.config.gameLengthMin)}%`;
    L.push(`  ${t.name}: transit ${t.transitMinutes}m (${pct(t.transitMinutes)}) · challenges ${t.challengeMinutes}m (${pct(t.challengeMinutes)}) · idle ${t.idleMinutes}m · ${t.travelLegs} legs · ${t.challengeAttempts} attempts`);
  }
  L.push("");
  L.push(`AUDIT: ${d.audit.totalTravelMinutes} person-min travel, ${d.audit.totalChallengeMinutes} person-min challenges · sources ${JSON.stringify(d.audit.travelSources)}`);
  if (d.audit.longestTravelLeg) L.push(`  longest leg: ${d.audit.longestTravelLeg.minutes}m ${d.audit.longestTravelLeg.from}→${d.audit.longestTravelLeg.to} (${d.audit.longestTravelLeg.source})`);
  L.push("");
  L.push(`TRAVEL LEGS:`);
  for (const l of d.travelLegs) {
    L.push(`  [${formatClockShort(l.departSimTime)}] ${l.teamId} ${l.fromName} → ${l.toName}: ${l.minutes}m (${l.source})${l.summary ? ` — ${l.summary}` : ""}`);
  }
  L.push("");
  L.push(`CHALLENGES:`);
  for (const c of d.challengeAttempts) {
    L.push(`  [${formatClockShort(c.startSimTime)}] ${c.teamId} @ ${c.areaName}: ${c.type ?? "?"} "${c.title ?? "—"}" (d${c.difficulty ?? "?"}) · ${round(c.durationMin)}m · ${c.result}`);
  }
  L.push("");
  L.push(`TIMELINE (${d.timeline.length} events):`);
  for (const e of d.timeline) {
    L.push(`  ${e.clock.padEnd(12)} ${e.type}${e.team ? ` · ${e.team}` : ""}${e.area ? ` · ${e.area}` : ""}`);
  }
  return L.join("\n") + "\n";
}

function formatClockShort(sim: number): string {
  const h = Math.floor(sim / 60);
  const m = Math.round(sim % 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}
