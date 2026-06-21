// Game-state data model — mirrors spec §3.

export type TeamId = string;
export type AreaId = number;
export type PowerUpType =
  | "express"
  | "uber"
  | "curse"
  | "double_down"
  | "lockdown";

export interface LatLng {
  lat: number;
  lng: number;
}

/** Static board node. Geometry lives separately in board.json's `geojson`. */
export interface AreaStatic {
  id: AreaId;
  name: string;
  side: "east" | "west";
  band: 1 | 2 | 3 | 4;
  value: number;
  centroid: LatLng;
  /** Nearest distance (km) from the Loop centroid to this area's edge. The closing
   *  wall (a shrinking circle on the Loop) locks the area once its radius drops below
   *  this — i.e. when no part of the area is inside the circle. Loop = 0. Optional so
   *  synthetic test boards (no geometry) fall back to centroid distance. */
  nearKm?: number;
  deckSize: number;
}

export type ChallengeType = "photo" | "trivia" | "measure" | "physical" | "find" | "riddle";

/** A neighborhood-specific challenge (Jet Lag: The Game style), drawn on claim. */
export interface Challenge {
  id: string;
  type: ChallengeType;
  title: string;
  prompt: string;
  difficulty: 1 | 2 | 3;
  restriction: string | null;
}

export interface Board {
  areas: AreaStatic[];
  adjacency: Record<string, AreaId[]>;
  loopAreaId: AreaId;
  /** Per-area challenge decks, keyed by area id (string). Optional: empty = none. */
  challenges?: Record<string, Challenge[]>;
}

/** Mutable per-area runtime state. */
export interface AreaState {
  id: AreaId;
  deckRemaining: number;
  holderTeamId: TeamId | null;
  locked: boolean;
  /** Score multiplier from a Double Down on the current holder's claim. */
  bonusMultiplier: number;
  /** Lockdown power-up: cannot be captured until this sim time. */
  lockdownUntil: number | null;
}

export type GamePhase = "lobby" | "running" | "finished";

export interface ActiveEffect {
  type: PowerUpType;
  expiresAt: number; // sim minutes
}

/** A team's commitment state drives the decision-driven clock (spec §2.1). */
export interface Team {
  id: TeamId;
  name: string;
  color: string;
  locationAreaId: AreaId;
  inTransit: { destId: AreaId; departSimTime: number; arrivalSimTime: number } | null;
  busyUntilSimTime: number | null; // claiming/capturing
  busyClaim: { areaId: AreaId; capture: boolean; doubleDown: boolean; challenge: Challenge | null } | null;
  /** Explicitly chose to idle; cleared by the next decision point. */
  waiting: boolean;
  lockedScore: number;
  provisionalScore: number;
  inventory: PowerUpType[]; // cap = config.powerUps.inventoryCap
  activeEffects: ActiveEffect[];
  lastFailedClaimAreaId: AreaId | null; // for retry-penalty bookkeeping
}

export interface Cache {
  id: string;
  areaId: AreaId;
  spawnSimTime: number;
  contents: PowerUpType;
  claimedByTeamId: TeamId | null;
}

export type EventType =
  | "game_start"
  | "spawn_locked"
  | "travel_start"
  | "arrive"
  | "claim_start"
  | "claim_success"
  | "claim_fail"
  | "capture"
  | "contraction"
  | "area_locked"
  | "cache_spawn"
  | "cache_grab"
  | "powerup_use"
  | "wait"
  | "game_end";

export interface EventLogEntry {
  simTime: number;
  type: EventType;
  teamId?: TeamId;
  areaId?: AreaId;
  detail?: Record<string, unknown>;
}

export interface WallState {
  /** Bands still live (claimable). Starts [1,2,3,4]; shrinks as the wall closes. */
  liveBands: Array<1 | 2 | 3 | 4>;
  contractionsDone: number;
  nextContractionAt: number | null; // null once the core contraction (buzzer) is next
  /** Current wall radius (km from the Loop). An area is claimable while any part of
   *  it is inside this circle (nearKm < radiusKm); it locks once the circle clears it. */
  radiusKm: number;
}

export interface GameClock {
  startedAtReal: number; // epoch ms when the game went live
  simTime: number; // minutes since game start (0..gameLengthMin)
  phase: GamePhase;
}

export interface GameState {
  config: Config;
  clock: GameClock;
  wall: WallState;
  areas: Record<string, AreaState>;
  teams: Team[];
  caches: Cache[];
  log: EventLogEntry[];
  rngState: number; // mutable seed for deterministic resolution
  nextCacheSpawnAt: number | null;
  winnerTeamId: TeamId | null;
}

// ---- Config (spec §7) -----------------------------------------------------

export interface Config {
  game: {
    teams: Array<{ id: TeamId; name: string; color: string }>;
    gameLengthMin: number; // 8h = 480
    /** Notional in-game start datetime; drives Google departureTime mapping. */
    notionalStart: { weekday: number; hour: number; minute: number }; // 6 = Saturday
    seed: number;
  };
  wall: {
    /** Sim-minute at which each contraction fires; locks band (4,3,2) in order. */
    contractionsAtMin: number[]; // e.g. [150, 300, 390]
    /** Extra radius (km) beyond the outermost area's edge at game start, so the whole
     *  city is comfortably inside the circle before the wall begins to close. */
    edgeMarginKm: number;
  };
  bandValues: Record<"1" | "2" | "3" | "4", number>;
  challenge: {
    durationMinRange: [number, number];
    failChance: number;
    retryPenaltyMin: number;
  };
  /** Real-time clock pacing for live play (the headless sim ignores this and uses
   *  the instant decision-driven `advance`). game-minutes advanced per real second
   *  while a team still has a pending decision (slow) vs while all teams are
   *  committed and time is just executing travel/challenges (fast). Set
   *  decisionGameMinPerSec to 0 to fully freeze the clock during decisions. */
  pacing: {
    decisionGameMinPerSec: number;
    executionGameMinPerSec: number;
    tickMs: number;
  };
  powerUps: {
    enabled: boolean;
    inventoryCap: number;
    cacheSpawnEveryMin: number; // 0 disables cache spawning
    rarityWeights: Record<PowerUpType, number>;
    express: { skipLegFraction: number };
    uber: { fixedHopMin: number };
    curse: { penaltyMin: number; durationMin: number };
    doubleDown: { multiplier: number };
    lockdown: { durationMin: number };
  };
  travel: {
    /** "google" (live Routes API) or "estimate" (offline, schedule-aware-ish). */
    provider: "google" | "estimate";
    /** Hard cap so a no-route weekend pair never stalls the game (minutes). */
    maxTravelMin: number;
    /** estimate-provider knobs */
    estimate: {
      transitSpeedKmh: number;
      perTransferMin: number;
      baseAccessMin: number; // walk to/from stations + wait
    };
  };
}
