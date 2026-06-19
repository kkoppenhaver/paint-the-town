# Paint the Town — Playtest Simulator

Simulates a full game of **Paint the Town** on a virtual Chicago so you can stress-test
**balance, pacing, and strategy** with two teams without going outside. Built to the
`paint-the-town-spec.md` build spec.

A game is a closing-wall territory contest: two teams spawn anywhere on the 77 Chicago
community areas, then claim/capture areas for points while a Fortnite-style wall closes
inward from the city edge toward the Loop, locking each band of areas as it consumes it.
Travel time (real Chicago transit) is the core friction. Highest **locked** score at the
8-hour buzzer wins; ties break on largest connected region.

## What's here

| Package | What it is |
|---|---|
| `engine/` | Pure, deterministic simulation core (TypeScript): decision-driven clock, the wall, claim/capture, scoring, win + tiebreaker, power-ups, travel providers, headless runner, telemetry. Fully unit-tested. |
| `server/` | Authoritative realtime room server (Node + `ws`). Holds canonical state, runs the clock, resolves intents, broadcasts to both browsers (spec §10). |
| `client/` | React + Vite + MapLibre UI: live map, HUD, team panels, event feed, config drawer, post-game summary + export. |
| `data/` | `board.json` — 77 community areas with bands, values, centroids, deck sizes, and an adjacency map, generated from real city GeoJSON. |
| `scripts/` | `build-board.mjs` — Phase 0 data prep (GeoJSON → `board.json`). |

Implements **Phase 0** (data prep) and **Phase 1** (playable realtime core) in full, plus
**Phase 2** depth (power-ups, caches, hot-editable config, telemetry export) and a
**Phase 3** headless balance-sweep runner.

## Quick start

```bash
npm install

# 1. Headless balance sweep (no server, no API key — runs offline)
npm run sim                       # 20 games, prints aggregate balance stats
#   from engine/:  npx tsx src/cli/sim.ts --games 50 --a edge_sweep --b core_rush --csv out.csv

# 2. Two-browser / hot-seat play
npm run dev                       # boots BOTH the room server (:8787) and the client (:5173)
#   (or run them separately: `npm run server` and `npm run client`)
#
# Two side-by-side browsers, one team each (tile each to half your screen):
#   left  window: http://localhost:5173?room=demo&team=A
#   right window: http://localhost:5173?room=demo&team=B
# Each window picks its own spawn, then sees & controls ONLY its team; the opponent
# shows as a read-only card. Either player can start once both have spawned.
#
# Single screen? Open http://localhost:5173?room=demo and use the "seat" switch in the
# top bar to drive both team panels yourself (hot-seat).

# 3. Tests
npm test                          # engine unit tests (vitest)
```

### Live Google Routes travel (optional)

The server uses an **offline transit estimator** by default so everything runs with no
key. To resolve real schedule-aware Chicago transit times, set a server-side key:

```bash
cd server && cp .env.example .env   # add GOOGLE_MAPS_API_KEY
GOOGLE_MAPS_API_KEY=... npm run server
```

The key stays server-side; both browsers get the identical resolved time. Travel uses the
**Routes API** (`computeRoutes`, `travelMode: TRANSIT`), mapping the in-game datetime
(default Saturday 9 AM) to a real future timestamp on the same weekday for a real lookup.
No-route weekend pairs are capped and fall back to the estimator so the clock never stalls
(spec §2.3).

## The decision-driven clock

Game-time only advances when **no team has a pending decision** (spec §2.1). When a team is
idle at an area, the clock is frozen — thinking and phone-research are free. Once every team
is committed (in transit, claiming, or explicitly waiting), the server fast-forwards to the
next decision point: an arrival, a claim completing, a wall contraction, or a cache
appearing. Any board change re-opens decisions and re-freezes the clock.

## Board data & bands

`board.json` is generated from the City of Chicago "Community Areas" boundaries. Centroids
and the adjacency map (for the connected-region tiebreaker) are computed from the polygons.

⚠️ **Bands:** the companion `paint-the-town-bands.md` was not available when this was built,
so bands (1 = Loop core … 4 = city edge) are **derived from each area's distance to the
Loop**, which matches the wall model (the wall is centered on the Loop and locks Band 4
first, Band 1 last). The result is geographically sensible — Band 1 is exactly downtown
(Loop, Near North/South/West Side, Armour Square) and Band 4 is the city perimeter. To swap
in real band data, drop it into `BAND_OVERRIDES` in `scripts/build-board.mjs` and re-run
`npm run build:board`.

Values follow the spec default gradient **8 / 4 / 2 / 1** (Band 1→4).

## What the simulator already tells you

Running the headless sweep surfaces real balance signals about the spec's open dials (§9):

- **The value gradient is steep enough that the core decides games.** A `core_rush` AI beats
  an `edge_sweep` AI ~19–1 under default values — grabbing cheap outer edges before they
  lock is almost never worth the transit time.
- **Two equally-good strategies make a close, swingy game** — ~8 lead changes per game and
  0% "decided before the buzzer," i.e. the long finale matters.
- **Transit is ~50–55% of each team's game-time** under the offline estimator — friction is
  high, which is the intended texture.

These are exactly the questions in spec §9; tune `bandValues`, `contractionsAtMin`, and the
challenge numbers in `engine/src/config.ts` (or the in-app config drawer) and re-run.

## Tunables

All live in `engine/src/config.ts` (`DEFAULT_CONFIG`) and the in-app config drawer:
band values, wall contraction times, game length, notional start datetime, challenge
duration/fail/retry, and the power-up catalog. Defaults are the spec §7 first-cut values.

## Telemetry

Every run captures (spec §9): final scores + margin, lead-change count and score-over-time,
per-band claimed/points/flips, % of game in transit, capture count, and whether the game was
decided before the buzzer. Export per run as JSON or CSV from the post-game summary, or
`--csv` from the headless CLI.

## Architecture notes

- The engine is **pure and deterministic** (seeded RNG) — same seed, same game — so headless
  sweeps are reproducible and the server is a thin authoritative wrapper around it.
- Clients send only **intents**; the server is the referee, so two browsers never disagree on
  the clock or ownership.
- Travel is the only async step, hidden behind one `travelTime(from, to, departSimTime)`
  contract with `google` and `estimate` implementations.
