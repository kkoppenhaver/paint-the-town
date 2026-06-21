import type { Config } from "./types.js";

/** Locked first-cut defaults from spec §7. */
export const DEFAULT_CONFIG: Config = {
  game: {
    teams: [
      { id: "A", name: "Team Red", color: "#e63946" },
      { id: "B", name: "Team Blue", color: "#1d6fb8" },
    ],
    gameLengthMin: 480, // 8 hours
    notionalStart: { weekday: 6, hour: 9, minute: 0 }, // Saturday 9:00 AM
    seed: 1,
  },
  wall: {
    // Contractions lock Band 4 / 3 / 2 at 2.5h / 5h / 6.5h; Band 1 at the 8h buzzer.
    contractionsAtMin: [150, 300, 390],
    edgeMarginKm: 1.5,
  },
  bandValues: { "1": 8, "2": 4, "3": 2, "4": 1 },
  challenge: {
    durationMinRange: [8, 16],
    failChance: 0.15,
    retryPenaltyMin: 10,
  },
  pacing: {
    decisionGameMinPerSec: 0.2, // slow creep while a team is deciding (gentle pressure)
    executionGameMinPerSec: 15, // fast-forward while both are committed
    tickMs: 250,
  },
  powerUps: {
    enabled: false, // Phase 1 MVP runs without power-ups (spec §11)
    inventoryCap: 2,
    cacheSpawnEveryMin: 0, // disabled until Phase 2
    rarityWeights: {
      express: 4,
      curse: 3,
      double_down: 3,
      lockdown: 2,
      uber: 1, // rare
    },
    express: { skipLegFraction: 1 }, // skip the whole leg's time
    uber: { fixedHopMin: 12 },
    curse: { penaltyMin: 20, durationMin: 60 },
    doubleDown: { multiplier: 1.5 },
    lockdown: { durationMin: 60 },
  },
  travel: {
    provider: "estimate",
    maxTravelMin: 120,
    estimate: {
      transitSpeedKmh: 18, // door-to-door transit incl. stops, city average
      perTransferMin: 7,
      baseAccessMin: 8,
      accessPenaltyPerLevelMin: 6, // score 3 → +12 each end; a desert (1) → +24
    },
  },
};

/** Deep-clone helper so callers can mutate a config safely. */
export function cloneConfig(c: Config): Config {
  return JSON.parse(JSON.stringify(c));
}
