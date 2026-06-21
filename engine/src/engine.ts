// The authoritative game engine (spec §2, §4). Pure, synchronous state
// transitions — except travel, which is resolved asynchronously by a
// TravelProvider before `submitTravel` mutates state. The decision-driven clock
// (spec §2.1) only advances when every team is committed (in transit, claiming,
// or explicitly waiting); the instant any team becomes idle, the clock freezes.

import { distanceKm, getArea, largestConnectedRegion } from "./board.js";
import { nextIntInRange, nextRandom } from "./rng.js";
import type { TravelProvider } from "./travel/provider.js";
import type {
  AreaId,
  AreaState,
  AreaStatic,
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
      radiusKm: 0, // set by updateWall() below
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
  updateWall(state, board); // prime wall.radiusKm (and lock nothing — whole city live)
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

/** Nearest distance (km) from the Loop centroid to an area's edge — the radius at
 *  which the closing wall finally clears it. Falls back to centroid distance for
 *  synthetic boards that carry no polygon-derived `nearKm`. */
export function areaNearKm(board: Board, id: AreaId): number {
  const a = getArea(board, id);
  if (a.nearKm != null) return a.nearKm;
  return distanceKm(a.centroid, getArea(board, board.loopAreaId).centroid);
}

/** An area is live (claimable) iff any part of it is still inside the wall circle.
 *  The Band-1 core is always live until the buzzer locks it (it's never swept). */
export function isLiveArea(state: GameState, board: Board, id: AreaId): boolean {
  const a = areaState(state, id);
  if (a.locked) return false;
  if (getArea(board, id).band === 1) return true;
  return areaNearKm(board, id) < state.wall.radiusKm;
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

/** An area's point value: the band base plus a transit-access bonus (config.scoring),
 *  so poorly-served areas can be made worth the trip. The single source of truth used
 *  by scoring, the AI, and telemetry. */
export function areaValue(config: Config, area: AreaStatic): number {
  const base = config.bandValues[String(area.band) as "1" | "2" | "3" | "4"];
  const bonus = (config.scoring?.transitBonusPerLevel ?? 0) * (5 - (area.transitScore ?? 5));
  return base + bonus;
}

export function recomputeScores(state: GameState, board: Board): void {
  for (const t of state.teams) {
    t.lockedScore = 0;
    t.provisionalScore = 0;
  }
  for (const a of Object.values(state.areas)) {
    if (!a.holderTeamId) continue;
    const t = getTeam(state, a.holderTeamId);
    const v = areaValue(state.config, getArea(board, a.id)) * a.bonusMultiplier;
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
  return stepTo(state, board, nextEventTime(state));
}

/** Earliest upcoming scheduled event time (arrival / claim / contraction / cache / buzzer). */
function nextEventTime(state: GameState): number {
  const candidates: number[] = [state.config.game.gameLengthMin];
  for (const t of state.teams) {
    if (t.inTransit) candidates.push(t.inTransit.arrivalSimTime);
    if (t.busyUntilSimTime != null) candidates.push(t.busyUntilSimTime);
  }
  if (state.wall.nextContractionAt != null) candidates.push(state.wall.nextContractionAt);
  if (state.nextCacheSpawnAt != null) candidates.push(state.nextCacheSpawnAt);
  return Math.min(...candidates);
}

/**
 * Real-time clock step for live play (spec §2.1, relaxed): advance the clock by
 * `deltaMin` game-minutes, resolving any scheduled events crossed. Unlike `advance`
 * it does not require all teams to be committed — the server calls it on a timer
 * with a slow rate while a team is deciding and a fast rate while all are committed.
 */
export function tick(state: GameState, board: Board, deltaMin: number): EventLogEntry[] {
  if (state.clock.phase !== "running") return [];
  const before = state.log.length;
  let remaining = Math.max(0, deltaMin);
  // resolve as many events as the delta reaches (handles large dt after a stall)
  while (state.clock.phase === "running") {
    const T = nextEventTime(state);
    if (state.clock.simTime + remaining >= T) {
      remaining -= T - state.clock.simTime;
      stepTo(state, board, T);
      if (remaining <= 0) break;
    } else {
      // Partial step between scheduled events: the wall still shrinks continuously,
      // so update its radius (and lock any area it has just cleared) at the new time.
      const mark = state.log.length;
      state.clock.simTime += remaining;
      updateWall(state, board);
      settle(state, board, mark);
      break;
    }
  }
  return state.log.slice(before);
}

/** Jump the clock to time `T` and apply every event scheduled at/through it. */
function stepTo(state: GameState, board: Board, T: number): EventLogEntry[] {
  const before = state.log.length;
  const buzzer = state.config.game.gameLengthMin;
  state.clock.simTime = T;

  // 1) resolve completions due at or before T (arrivals + claims)
  for (const t of state.teams) {
    if (t.inTransit && t.inTransit.arrivalSimTime <= T) resolveArrival(state, board, t);
  }
  for (const t of state.teams) {
    if (t.busyUntilSimTime != null && t.busyUntilSimTime <= T) resolveClaim(state, board, t);
  }

  // 2) shrink the wall to T: fire any contraction markers crossed, and lock every
  //    area the circle has now cleared (failing claims caught mid-attempt).
  updateWall(state, board);

  // 3) cache spawn at exactly T
  if (state.nextCacheSpawnAt === T) spawnCache(state, board, T);

  // 4) buzzer
  if (T >= buzzer) finishGame(state, board);

  settle(state, board, before);
  return state.log.slice(before);
}

/** After a step, re-activate waiting teams if the board changed in a way that opens a
 *  new choice (a staged contraction, a cache, or an ownership change) and recompute
 *  scores. Individual area locks as the circle sweeps are NOT triggers — they'd nudge
 *  a parked team constantly and never open a new option. */
function settle(state: GameState, board: Board, sinceLen: number): void {
  const BOARD_CHANGE: EventType[] = [
    "contraction",
    "cache_spawn",
    "claim_success",
    "capture",
  ];
  if (state.log.slice(sinceLen).some((e) => BOARD_CHANGE.includes(e.type))) {
    for (const t of state.teams) if (!isBusy(t)) t.waiting = false;
  }
  recomputeScores(state, board);
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

// Bands cleared, in order, by each scheduled contraction (Band 1 core locks at buzzer).
const BANDS_BY_CONTRACTION: Array<2 | 3 | 4> = [4, 3, 2];

/**
 * Wall radius (km) at sim-time `t`. Piecewise-linear: starts enclosing the whole city,
 * passes each band's inner edge at that band's contraction time, then holds at the core
 * boundary until the buzzer (the core all locks at once at the end).
 */
function wallRadiusAt(state: GameState, board: Board, t: number): number {
  const cfg = state.config;
  const minNearOfBand = (band: number): number => {
    let m = Infinity;
    for (const a of board.areas) if (a.band === band) m = Math.min(m, areaNearKm(board, a.id));
    return m === Infinity ? 0 : m;
  };
  let maxNear = 0;
  for (const a of board.areas) maxNear = Math.max(maxNear, areaNearKm(board, a.id));

  const pts: Array<{ t: number; r: number }> = [{ t: 0, r: maxNear + cfg.wall.edgeMarginKm }];
  cfg.wall.contractionsAtMin.forEach((ct, i) => {
    const band = BANDS_BY_CONTRACTION[i];
    pts.push({ t: ct, r: band != null ? minNearOfBand(band) : 0 });
  });
  pts.push({ t: cfg.game.gameLengthMin, r: pts[pts.length - 1]!.r }); // hold core ring to buzzer
  for (let i = 1; i < pts.length; i++) pts[i]!.r = Math.min(pts[i]!.r, pts[i - 1]!.r); // monotonic

  if (t <= pts[0]!.t) return pts[0]!.r;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (t <= b.t) return b.t === a.t ? b.r : a.r + (b.r - a.r) * ((t - a.t) / (b.t - a.t));
  }
  return pts[pts.length - 1]!.r;
}

/**
 * Advance the wall to the current sim-time: set its radius, fire any contraction
 * markers crossed (staging for the HUD/feed), and lock every Band 2–4 area the circle
 * has now fully cleared — failing any claim caught mid-attempt (spec §4). The Band-1
 * core is never swept; it locks at the buzzer in finishGame.
 */
function updateWall(state: GameState, board: Board): void {
  const T = state.clock.simTime;
  state.wall.radiusKm = wallRadiusAt(state, board, T);

  while (state.wall.nextContractionAt != null && T >= state.wall.nextContractionAt) {
    const band = BANDS_BY_CONTRACTION[state.wall.contractionsDone];
    state.wall.contractionsDone += 1;
    if (band != null) {
      log(state, "contraction", { band, at: state.wall.nextContractionAt });
      state.wall.liveBands = state.wall.liveBands.filter((b) => b !== band);
    }
    state.wall.nextContractionAt =
      state.config.wall.contractionsAtMin[state.wall.contractionsDone] ?? null;
  }

  for (const a of Object.values(state.areas)) {
    if (a.locked) continue;
    const area = getArea(board, a.id);
    if (area.band === 1) continue; // core locks only at the buzzer
    if (areaNearKm(board, a.id) >= state.wall.radiusKm) {
      for (const t of state.teams) {
        if (t.busyClaim?.areaId === a.id && t.busyUntilSimTime != null && t.busyUntilSimTime > T) {
          t.busyUntilSimTime = null;
          t.busyClaim = null;
          t.lastFailedClaimAreaId = a.id;
          log(state, "claim_fail", { reason: "wall" }, t.id, a.id);
        }
      }
      a.locked = true;
      log(state, "area_locked", { band: area.band, holder: a.holderTeamId }, undefined, a.id);
    }
  }
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
