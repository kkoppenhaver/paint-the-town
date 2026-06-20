// The authoritative game engine (spec §2, §4). Pure, synchronous state
// transitions — except travel, which is resolved asynchronously by a
// TravelProvider before `submitTravel` mutates state. The decision-driven clock
// (spec §2.1) only advances when every team is committed (in transit, claiming,
// or explicitly waiting); the instant any team becomes idle, the clock freezes.

import { getArea, largestConnectedRegion } from "./board.js";
import { nextIntInRange, nextRandom } from "./rng.js";
import type { TravelProvider } from "./travel/provider.js";
import type {
  AreaId,
  AreaState,
  Board,
  Cache,
  Challenge,
  Config,
  EventLogEntry,
  EventType,
  GameState,
  PowerUpType,
  Team,
  TeamId,
} from "./types.js";

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

export function createGame(
  config: Config,
  board: Board,
  spawns: Record<TeamId, AreaId>,
): GameState {
  const areas: Record<string, AreaState> = {};
  for (const a of board.areas) {
    areas[String(a.id)] = {
      id: a.id,
      deckRemaining: a.deckSize,
      holderTeamId: null,
      locked: false,
      bonusMultiplier: 1,
      lockdownUntil: null,
    };
  }

  const teams: Team[] = config.game.teams.map((t) => {
    const spawn = spawns[t.id];
    if (spawn == null) throw new Error(`no spawn for team ${t.id}`);
    return {
      id: t.id,
      name: t.name,
      color: t.color,
      locationAreaId: spawn,
      inTransit: null,
      busyUntilSimTime: null,
      busyClaim: null,
      waiting: false,
      lockedScore: 0,
      provisionalScore: 0,
      inventory: [],
      activeEffects: [],
      lastFailedClaimAreaId: null,
    };
  });

  const state: GameState = {
    config,
    clock: { startedAtReal: Date.now(), simTime: 0, phase: "running" },
    wall: {
      liveBands: [1, 2, 3, 4],
      contractionsDone: 0,
      nextContractionAt: config.wall.contractionsAtMin[0] ?? null,
    },
    areas,
    teams,
    caches: [],
    log: [],
    rngState: config.game.seed | 0,
    nextCacheSpawnAt:
      config.powerUps.enabled && config.powerUps.cacheSpawnEveryMin > 0
        ? config.powerUps.cacheSpawnEveryMin
        : null,
    winnerTeamId: null,
  };

  log(state, "game_start", {});
  // Spawns reveal together — the one true tie (spec §2.1). Both teams then idle.
  recomputeScores(state, board);
  return state;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function log(
  state: GameState,
  type: EventType,
  detail: Record<string, unknown>,
  teamId?: TeamId,
  areaId?: AreaId,
): void {
  state.log.push({ simTime: state.clock.simTime, type, teamId, areaId, detail });
}

export function getTeam(state: GameState, id: TeamId): Team {
  const t = state.teams.find((x) => x.id === id);
  if (!t) throw new Error(`unknown team ${id}`);
  return t;
}

export function areaState(state: GameState, id: AreaId): AreaState {
  const a = state.areas[String(id)];
  if (!a) throw new Error(`unknown area ${id}`);
  return a;
}

/** A band is live (claimable) iff still inside the wall. */
export function isLiveArea(state: GameState, board: Board, id: AreaId): boolean {
  const a = areaState(state, id);
  return !a.locked && state.wall.liveBands.includes(getArea(board, id).band);
}

function isBusy(t: Team): boolean {
  return t.inTransit != null || t.busyUntilSimTime != null;
}

/** Idle = decision pending. The clock cannot advance while any team is idle. */
export function isIdle(t: Team): boolean {
  return !isBusy(t) && !t.waiting;
}

export function allCommitted(state: GameState): boolean {
  return state.teams.every((t) => isBusy(t) || t.waiting);
}

function bandValue(state: GameState, board: Board, id: AreaId): number {
  const band = getArea(board, id).band;
  return state.config.bandValues[String(band) as "1" | "2" | "3" | "4"];
}

export function recomputeScores(state: GameState, board: Board): void {
  for (const t of state.teams) {
    t.lockedScore = 0;
    t.provisionalScore = 0;
  }
  for (const a of Object.values(state.areas)) {
    if (!a.holderTeamId) continue;
    const t = getTeam(state, a.holderTeamId);
    const v = bandValue(state, board, a.id) * a.bonusMultiplier;
    if (a.locked) t.lockedScore += v;
    else t.provisionalScore += v;
  }
}

// ---------------------------------------------------------------------------
// intents
// ---------------------------------------------------------------------------

/**
 * Commit a team to travel. Async because it resolves the true travel time via the
 * provider (live Google Routes, or the offline estimate). On return the team is in
 * transit and the clock can advance once all teams are committed.
 */
export async function submitTravel(
  state: GameState,
  board: Board,
  provider: TravelProvider,
  teamId: TeamId,
  destId: AreaId,
): Promise<void> {
  const t = getTeam(state, teamId);
  if (!isIdle(t)) throw new Error(`team ${teamId} is not idle`);
  if (destId === t.locationAreaId) throw new Error("already there");

  const { minutes, source, summary } = await provider.travelTime({
    board,
    config: state.config,
    from: t.locationAreaId,
    to: destId,
    departSimTime: state.clock.simTime,
  });

  t.waiting = false;
  t.inTransit = {
    destId,
    departSimTime: state.clock.simTime,
    arrivalSimTime: state.clock.simTime + minutes,
  };
  log(state, "travel_start", { destId, minutes, source, summary }, teamId, t.locationAreaId);
}

/** Commit a team to claim/capture the area it is standing in. */
export function submitClaim(state: GameState, board: Board, teamId: TeamId): void {
  const t = getTeam(state, teamId);
  if (!isIdle(t)) throw new Error(`team ${teamId} is not idle`);
  const here = t.locationAreaId;
  if (!isLiveArea(state, board, here)) throw new Error("area not live");

  const a = areaState(state, here);
  if (a.deckRemaining <= 0) throw new Error("deck exhausted");
  if (a.holderTeamId === teamId) throw new Error("already held by you");
  const capture = a.holderTeamId != null;
  if (capture && a.lockdownUntil != null && a.lockdownUntil > state.clock.simTime) {
    throw new Error("area is locked down");
  }

  // duration drawn from range, plus retry penalty if re-attempting a recent flop.
  const draw = nextIntInRange(
    state.rngState,
    state.config.challenge.durationMinRange[0],
    state.config.challenge.durationMinRange[1],
  );
  state.rngState = draw.state;
  let duration = draw.value;
  if (t.lastFailedClaimAreaId === here) duration += state.config.challenge.retryPenaltyMin;

  const doubleDown = consumeEffect(t, "double_down");
  const challenge = drawChallenge(board, here, a);
  t.waiting = false;
  t.busyUntilSimTime = state.clock.simTime + duration;
  t.busyClaim = { areaId: here, capture, doubleDown, challenge };
  log(
    state,
    "claim_start",
    { duration, capture, doubleDown, challenge: challenge ?? undefined },
    teamId,
    here,
  );
}

/**
 * Pick the area's challenge for this claim. Deterministic and does NOT consume the
 * game RNG (so it never perturbs claim-success rolls): it cycles through the deck by
 * how many times the area has already been claimed (deckSize − deckRemaining).
 */
function drawChallenge(board: Board, areaId: AreaId, a: AreaState): Challenge | null {
  const deck = board.challenges?.[String(areaId)];
  if (!deck || deck.length === 0) return null;
  const claimedSoFar = getArea(board, areaId).deckSize - a.deckRemaining;
  const idx = ((claimedSoFar % deck.length) + deck.length) % deck.length;
  return deck[idx] ?? null;
}

/** A team with no pending move commits to idle; re-activated at the next decision point. */
export function submitWait(state: GameState, teamId: TeamId): void {
  const t = getTeam(state, teamId);
  if (!isIdle(t)) throw new Error(`team ${teamId} is not idle`);
  t.waiting = true;
  log(state, "wait", {}, teamId);
}

// ---------------------------------------------------------------------------
// power-ups (spec §5) — additive only; never touch transparency or the wall
// ---------------------------------------------------------------------------

function consumeEffect(t: Team, type: PowerUpType): boolean {
  const i = t.activeEffects.findIndex((e) => e.type === type);
  if (i === -1) return false;
  t.activeEffects.splice(i, 1);
  return true;
}

export function usePowerUp(
  state: GameState,
  board: Board,
  teamId: TeamId,
  type: PowerUpType,
  opts: { targetAreaId?: AreaId; rivalTeamId?: TeamId } = {},
): void {
  const t = getTeam(state, teamId);
  const idx = t.inventory.indexOf(type);
  if (idx === -1) throw new Error(`no ${type} in inventory`);
  t.inventory.splice(idx, 1);
  const now = state.clock.simTime;
  const pu = state.config.powerUps;

  switch (type) {
    case "express": {
      if (opts.targetAreaId == null || !isIdle(t)) throw new Error("express needs idle + target");
      t.locationAreaId = opts.targetAreaId; // instant hop along a shared line
      t.inTransit = null;
      break;
    }
    case "uber": {
      if (opts.targetAreaId == null || !isIdle(t)) throw new Error("uber needs idle + target");
      t.inTransit = {
        destId: opts.targetAreaId,
        departSimTime: now,
        arrivalSimTime: now + pu.uber.fixedHopMin,
      };
      break;
    }
    case "curse": {
      const rival = getTeam(state, opts.rivalTeamId ?? otherTeamId(state, teamId));
      if (rival.inTransit) rival.inTransit.arrivalSimTime += pu.curse.penaltyMin;
      else if (rival.busyUntilSimTime != null) rival.busyUntilSimTime += pu.curse.penaltyMin;
      rival.activeEffects.push({ type: "curse", expiresAt: now + pu.curse.durationMin });
      break;
    }
    case "double_down": {
      t.activeEffects.push({ type: "double_down", expiresAt: now + 24 * 60 });
      break;
    }
    case "lockdown": {
      const target = opts.targetAreaId ?? t.locationAreaId;
      const a = areaState(state, target);
      if (a.holderTeamId !== teamId) throw new Error("can only lock down your own area");
      a.lockdownUntil = now + pu.lockdown.durationMin;
      break;
    }
  }
  log(state, "powerup_use", { type, ...opts }, teamId, opts.targetAreaId);
}

function otherTeamId(state: GameState, teamId: TeamId): TeamId {
  const other = state.teams.find((x) => x.id !== teamId);
  if (!other) throw new Error("no rival");
  return other.id;
}

// ---------------------------------------------------------------------------
// the clock — fast-forward to the next decision point
// ---------------------------------------------------------------------------

/**
 * Advance the clock to the next scheduled event and apply it. Requires every team
 * to be committed (`allCommitted`). Returns the new events appended to the log.
 * The caller loops: collect idle-team decisions → advance → repeat until finished.
 */
export function advance(state: GameState, board: Board): EventLogEntry[] {
  if (state.clock.phase !== "running") return [];
  if (!allCommitted(state)) throw new Error("clock frozen: a team has a pending decision");

  const before = state.log.length;
  const buzzer = state.config.game.gameLengthMin;

  // earliest upcoming event time
  const candidates: number[] = [buzzer];
  for (const t of state.teams) {
    if (t.inTransit) candidates.push(t.inTransit.arrivalSimTime);
    if (t.busyUntilSimTime != null) candidates.push(t.busyUntilSimTime);
  }
  if (state.wall.nextContractionAt != null) candidates.push(state.wall.nextContractionAt);
  if (state.nextCacheSpawnAt != null) candidates.push(state.nextCacheSpawnAt);
  const T = Math.min(...candidates);
  state.clock.simTime = T;

  // 1) resolve completions due at or before T (arrivals + claims)
  for (const t of state.teams) {
    if (t.inTransit && t.inTransit.arrivalSimTime <= T) resolveArrival(state, board, t);
  }
  for (const t of state.teams) {
    if (t.busyUntilSimTime != null && t.busyUntilSimTime <= T) resolveClaim(state, board, t);
  }

  // 2) wall contraction at exactly T (fails in-progress claims on the locking band)
  if (state.wall.nextContractionAt === T) applyContraction(state, board, T);

  // 3) cache spawn at exactly T
  if (state.nextCacheSpawnAt === T) spawnCache(state, board, T);

  // 4) buzzer
  if (T >= buzzer) finishGame(state, board);

  // teams that just arrived/finished are idle → clock will freeze for their input.
  // a board change (contraction/cache/claim/capture/lock) re-activates anyone who
  // was waiting, since it may open a new choice (spec §2.1).
  const BOARD_CHANGE: EventType[] = [
    "contraction",
    "cache_spawn",
    "claim_success",
    "capture",
    "area_locked",
  ];
  const boardChanged = state.log.slice(before).some((e) => BOARD_CHANGE.includes(e.type));
  if (boardChanged) {
    for (const t of state.teams) if (!isBusy(t)) t.waiting = false;
  }

  recomputeScores(state, board);
  return state.log.slice(before);
}

function resolveArrival(state: GameState, board: Board, t: Team): void {
  const dest = t.inTransit!.destId;
  t.locationAreaId = dest;
  t.inTransit = null;
  t.waiting = false;
  log(state, "arrive", {}, t.id, dest);
  // auto-grab a cache sitting here (first to arrive wins) if there's room.
  const cache = state.caches.find((c) => c.areaId === dest && c.claimedByTeamId == null);
  if (cache && t.inventory.length < state.config.powerUps.inventoryCap) {
    cache.claimedByTeamId = t.id;
    t.inventory.push(cache.contents);
    log(state, "cache_grab", { contents: cache.contents }, t.id, dest);
  }
}

function resolveClaim(state: GameState, board: Board, t: Team): void {
  const claim = t.busyClaim!;
  t.busyUntilSimTime = null;
  t.busyClaim = null;
  t.waiting = false;

  const roll = nextRandom(state.rngState);
  state.rngState = roll.state;
  if (roll.value < state.config.challenge.failChance) {
    t.lastFailedClaimAreaId = claim.areaId;
    log(state, "claim_fail", {}, t.id, claim.areaId);
    return;
  }

  const a = areaState(state, claim.areaId);
  a.holderTeamId = t.id;
  a.deckRemaining = Math.max(0, a.deckRemaining - 1);
  a.bonusMultiplier = claim.doubleDown ? state.config.powerUps.doubleDown.multiplier : 1;
  a.lockdownUntil = null; // capture clears any prior lockdown ownership state
  t.lastFailedClaimAreaId = null;
  log(state, claim.capture ? "capture" : "claim_success", {}, t.id, claim.areaId);
}

function applyContraction(state: GameState, board: Board, T: number): void {
  const lockedBand = state.wall.liveBands[state.wall.liveBands.length - 1]; // outermost live
  state.wall.contractionsDone += 1;
  log(state, "contraction", { band: lockedBand, at: T });

  for (const a of Object.values(state.areas)) {
    if (getArea(board, a.id).band !== lockedBand) continue;

    // mid-claim when the wall hits: busyUntil > T → the claim fails (spec §4).
    for (const t of state.teams) {
      if (t.busyClaim?.areaId === a.id && t.busyUntilSimTime != null && t.busyUntilSimTime > T) {
        t.busyUntilSimTime = null;
        t.busyClaim = null;
        t.lastFailedClaimAreaId = a.id;
        log(state, "claim_fail", { reason: "wall" }, t.id, a.id);
      }
    }
    a.locked = true;
    log(state, "area_locked", { band: lockedBand, holder: a.holderTeamId }, undefined, a.id);
  }

  state.wall.liveBands = state.wall.liveBands.filter((b) => b !== lockedBand);
  const next = state.config.wall.contractionsAtMin[state.wall.contractionsDone];
  state.wall.nextContractionAt = next ?? null; // null → Band 1 locks at the buzzer
}

function spawnCache(state: GameState, board: Board, T: number): void {
  const live = board.areas.filter((a) => isLiveArea(state, board, a.id));
  if (live.length) {
    const pick = nextIntInRange(state.rngState, 0, live.length - 1);
    state.rngState = pick.state;
    const area = live[pick.value]!;
    const contents = drawPowerUp(state);
    const cache: Cache = {
      id: `cache-${state.caches.length}`,
      areaId: area.id,
      spawnSimTime: T,
      contents,
      claimedByTeamId: null,
    };
    state.caches.push(cache);
    log(state, "cache_spawn", { contents }, undefined, area.id);
  }
  state.nextCacheSpawnAt = T + state.config.powerUps.cacheSpawnEveryMin;
}

function drawPowerUp(state: GameState): PowerUpType {
  const weights = state.config.powerUps.rarityWeights;
  const entries = Object.entries(weights) as Array<[PowerUpType, number]>;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const roll = nextRandom(state.rngState);
  state.rngState = roll.state;
  let x = roll.value * total;
  for (const [type, w] of entries) {
    x -= w;
    if (x <= 0) return type;
  }
  return entries[0]![0];
}

function finishGame(state: GameState, board: Board): void {
  // Band 1 core locks at the buzzer.
  for (const a of Object.values(state.areas)) {
    if (!a.locked) {
      a.locked = true;
      log(state, "area_locked", { band: getArea(board, a.id).band, holder: a.holderTeamId }, undefined, a.id);
    }
  }
  state.wall.liveBands = [];
  recomputeScores(state, board);
  state.winnerTeamId = decideWinner(state, board);
  state.clock.phase = "finished";
  log(state, "game_end", { winner: state.winnerTeamId });
}

/** Highest locked score; tiebreaker = largest single connected held region (§4). */
export function decideWinner(state: GameState, board: Board): TeamId | null {
  const ranked = [...state.teams].sort((a, b) => {
    if (b.lockedScore !== a.lockedScore) return b.lockedScore - a.lockedScore;
    const ra = largestConnectedRegion(board, heldBy(state, a.id));
    const rb = largestConnectedRegion(board, heldBy(state, b.id));
    return rb - ra;
  });
  const [first, second] = ranked;
  if (!first) return null;
  if (
    second &&
    first.lockedScore === second.lockedScore &&
    largestConnectedRegion(board, heldBy(state, first.id)) ===
      largestConnectedRegion(board, heldBy(state, second.id))
  ) {
    return null; // genuine tie
  }
  return first.id;
}

function heldBy(state: GameState, teamId: TeamId): Set<AreaId> {
  const s = new Set<AreaId>();
  for (const a of Object.values(state.areas)) if (a.holderTeamId === teamId) s.add(a.id);
  return s;
}
