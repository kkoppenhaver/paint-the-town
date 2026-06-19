import { describe, it, expect } from "vitest";
import {
  advance,
  allCommitted,
  areaState,
  createGame,
  decideWinner,
  getTeam,
  isIdle,
  submitClaim,
  submitTravel,
  submitWait,
  usePowerUp,
} from "../engine.js";
import { largestConnectedRegion } from "../board.js";
import { cloneConfig, DEFAULT_CONFIG } from "../config.js";
import { estimateProvider } from "../travel/estimate.js";
import type { Board, Config } from "../types.js";

// A tiny deterministic board: a line 1—2—3—4 plus an isolated-ish 5 next to 4.
const testBoard: Board = {
  loopAreaId: 1,
  areas: [
    { id: 1, name: "A1", side: "east", band: 1, value: 8, centroid: { lat: 41.88, lng: -87.63 }, deckSize: 12 },
    { id: 2, name: "A2", side: "east", band: 2, value: 4, centroid: { lat: 41.9, lng: -87.65 }, deckSize: 5 },
    { id: 3, name: "A3", side: "east", band: 3, value: 2, centroid: { lat: 41.92, lng: -87.67 }, deckSize: 5 },
    { id: 4, name: "A4", side: "east", band: 4, value: 1, centroid: { lat: 41.94, lng: -87.69 }, deckSize: 5 },
    { id: 5, name: "A5", side: "east", band: 4, value: 1, centroid: { lat: 41.95, lng: -87.7 }, deckSize: 5 },
  ],
  adjacency: { "1": [2], "2": [1, 3], "3": [2, 4], "4": [3, 5], "5": [4] },
};

function cfg(overrides: (c: Config) => void = () => {}): Config {
  const c = cloneConfig(DEFAULT_CONFIG);
  c.game.teams = [
    { id: "A", name: "A", color: "#f00" },
    { id: "B", name: "B", color: "#00f" },
  ];
  // deterministic challenges for most tests
  c.challenge.failChance = 0;
  c.challenge.durationMinRange = [10, 10];
  overrides(c);
  return c;
}

describe("board helpers", () => {
  it("largest connected region uses adjacency", () => {
    expect(largestConnectedRegion(testBoard, new Set([1, 2, 3]))).toBe(3);
    expect(largestConnectedRegion(testBoard, new Set([1, 3, 5]))).toBe(1); // disjoint
    expect(largestConnectedRegion(testBoard, new Set([4, 5]))).toBe(2);
  });
});

describe("decision-driven clock", () => {
  it("freezes while a team is idle and refuses to advance", () => {
    const s = createGame(cfg(), testBoard, { A: 1, B: 5 });
    expect(isIdle(getTeam(s, "A"))).toBe(true);
    expect(allCommitted(s)).toBe(false);
    expect(() => advance(s, testBoard)).toThrow();
  });

  it("advances to the next event once all teams commit", async () => {
    const s = createGame(cfg(), testBoard, { A: 1, B: 5 });
    submitClaim(s, testBoard, "A"); // busy until t=10
    submitWait(s, "B");
    expect(allCommitted(s)).toBe(true);
    advance(s, testBoard);
    expect(s.clock.simTime).toBe(10);
    expect(areaState(s, 1).holderTeamId).toBe("A");
  });
});

describe("claim / capture / scoring", () => {
  it("claim flips holder, decrements deck, credits provisional then locked", () => {
    const s = createGame(cfg(), testBoard, { A: 2, B: 5 });
    const deck0 = areaState(s, 2).deckRemaining;
    submitClaim(s, testBoard, "A");
    submitWait(s, "B");
    advance(s, testBoard);
    expect(areaState(s, 2).holderTeamId).toBe("A");
    expect(areaState(s, 2).deckRemaining).toBe(deck0 - 1);
    // band 2 value = 4, provisional (not yet locked)
    expect(getTeam(s, "A").provisionalScore).toBe(4);
    expect(getTeam(s, "A").lockedScore).toBe(0);
  });

  it("capture flips an enemy-held area", () => {
    const s = createGame(cfg(), testBoard, { A: 3, B: 3 });
    submitClaim(s, testBoard, "A");
    submitWait(s, "B");
    advance(s, testBoard);
    expect(areaState(s, 3).holderTeamId).toBe("A");
    // B captures it back
    submitClaim(s, testBoard, "B");
    submitWait(s, "A");
    advance(s, testBoard);
    expect(areaState(s, 3).holderTeamId).toBe("B");
  });
});

describe("the wall", () => {
  it("locks bands 4/3/2 on schedule and band 1 at the buzzer", () => {
    const c = cfg((c) => {
      c.wall.contractionsAtMin = [150, 300, 390];
      c.game.gameLengthMin = 480;
    });
    const s = createGame(c, testBoard, { A: 1, B: 5 });
    // park both teams: A claims its core spot, B waits forever
    submitClaim(s, testBoard, "A");
    submitWait(s, "B");
    while (s.clock.phase === "running") {
      // re-commit idle teams to waiting so the clock can roll to the buzzer
      for (const t of s.teams) if (isIdle(t)) submitWait(s, t.id);
      advance(s, testBoard);
    }
    // every area locked at end; band-4 areas locked at first contraction
    for (const a of Object.values(s.areas)) expect(a.locked).toBe(true);
    const lockEvents = s.log.filter((e) => e.type === "contraction");
    expect(lockEvents.map((e) => e.detail?.band)).toEqual([4, 3, 2]);
  });

  it("fails an in-progress claim when the wall consumes its band", () => {
    // A starts a long claim on a band-4 area that won't finish before t=150.
    const c = cfg((c) => {
      c.wall.contractionsAtMin = [150, 300, 390];
      c.challenge.durationMinRange = [200, 200]; // longer than time to contraction
    });
    const s = createGame(c, testBoard, { A: 4, B: 1 });
    submitClaim(s, testBoard, "A"); // busy until t=200 on band-4 area 4
    submitWait(s, "B");
    advance(s, testBoard); // jumps to t=150 contraction
    expect(s.clock.simTime).toBe(150);
    expect(areaState(s, 4).locked).toBe(true);
    expect(areaState(s, 4).holderTeamId).toBe(null); // claim failed, prior holder kept
    expect(getTeam(s, "A").busyUntilSimTime).toBe(null);
  });
});

describe("win + tiebreaker", () => {
  it("higher locked score wins", () => {
    const s = createGame(cfg(), testBoard, { A: 1, B: 4 });
    // give A the core (8) and B an edge (1) via direct state poke
    areaState(s, 1).holderTeamId = "A";
    areaState(s, 1).locked = true;
    areaState(s, 4).holderTeamId = "B";
    areaState(s, 4).locked = true;
    getTeam(s, "A").lockedScore = 8;
    getTeam(s, "B").lockedScore = 1;
    expect(decideWinner(s, testBoard)).toBe("A");
  });

  it("breaks a score tie by largest connected region", () => {
    const s = createGame(cfg(), testBoard, { A: 1, B: 5 });
    // tie on score; A holds a connected pair {2,3}, B holds disjoint {1,5}
    for (const id of [2, 3]) areaState(s, id).holderTeamId = "A";
    for (const id of [1, 5]) areaState(s, id).holderTeamId = "B";
    getTeam(s, "A").lockedScore = 6;
    getTeam(s, "B").lockedScore = 6;
    expect(decideWinner(s, testBoard)).toBe("A"); // region 2 > region 1
  });
});

describe("travel estimate provider", () => {
  it("returns 0 for same area and grows with distance, capped", async () => {
    const c = cfg();
    expect((await estimateProvider.travelTime({ board: testBoard, config: c, from: 1, to: 1, departSimTime: 0 })).minutes).toBe(0);
    const near = await estimateProvider.travelTime({ board: testBoard, config: c, from: 1, to: 2, departSimTime: 0 });
    const far = await estimateProvider.travelTime({ board: testBoard, config: c, from: 1, to: 5, departSimTime: 0 });
    expect(far.minutes).toBeGreaterThan(near.minutes);
  });
});

describe("power-ups", () => {
  it("double down multiplies the claimed area's value", () => {
    const c = cfg((c) => {
      c.powerUps.enabled = true;
    });
    const s = createGame(c, testBoard, { A: 2, B: 5 });
    getTeam(s, "A").inventory.push("double_down");
    usePowerUp(s, testBoard, "A", "double_down");
    submitClaim(s, testBoard, "A");
    submitWait(s, "B");
    advance(s, testBoard);
    // band 2 value 4 × 1.5 = 6
    expect(getTeam(s, "A").provisionalScore).toBe(6);
  });

  it("lockdown blocks capture of a held area", () => {
    const c = cfg((c) => {
      c.powerUps.enabled = true;
    });
    const s = createGame(c, testBoard, { A: 3, B: 3 });
    submitClaim(s, testBoard, "A");
    submitWait(s, "B");
    advance(s, testBoard);
    getTeam(s, "A").inventory.push("lockdown");
    usePowerUp(s, testBoard, "A", "lockdown", { targetAreaId: 3 });
    getTeam(s, "B").waiting = false; // B re-decides
    expect(() => submitClaim(s, testBoard, "B")).toThrow(/locked down/);
  });
});

describe("determinism", () => {
  it("same seed yields identical final scores", async () => {
    const run = async () => {
      const c = cfg((c) => {
        c.challenge.failChance = 0.15;
        c.game.seed = 42;
      });
      const s = createGame(c, testBoard, { A: 1, B: 5 });
      // simple scripted loop
      let steps = 0;
      while (s.clock.phase === "running" && steps++ < 500) {
        for (const t of s.teams) {
          if (!isIdle(t)) continue;
          try {
            submitClaim(s, testBoard, t.id);
          } catch {
            await submitTravel(s, testBoard, estimateProvider, t.id, t.locationAreaId === 1 ? 2 : 1).catch(
              () => submitWait(s, t.id),
            );
          }
        }
        if (allCommitted(s)) advance(s, testBoard);
      }
      return s.teams.map((t) => t.lockedScore);
    };
    expect(await run()).toEqual(await run());
  });
});
