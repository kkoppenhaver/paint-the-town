// Headless balance-sweep CLI:  npm run sim -- [--games N] [--seed S] [--csv out.csv]
// Plays N games (estimate travel provider) and prints aggregate balance stats.

import { writeFileSync } from "node:fs";
import { loadBoard } from "../loadBoard.js";
import { cloneConfig, DEFAULT_CONFIG } from "../config.js";
import { estimateProvider } from "../travel/estimate.js";
import { runGame, type Strategy } from "../headless.js";
import { computeTelemetry, telemetryToCsvRow, CSV_HEADER, type Telemetry } from "../telemetry.js";
import type { AreaId } from "../types.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const games = Number(arg("games", "20"));
const baseSeed = Number(arg("seed", "1"));
const csvPath = arg("csv", "");
const stratA = arg("a", "greedy_value") as Strategy;
const stratB = arg("b", "core_rush") as Strategy;

const board = loadBoard();
// Default spawns: opposite ends of the city so the AIs contest the middle.
const spawns: Record<string, AreaId> = { A: 8 /* Near North */, B: 71 /* Auburn Gresham */ };

const rows: Telemetry[] = [];
for (let g = 0; g < games; g++) {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.game.seed = baseSeed + g;
  const state = await runGame({
    config,
    board,
    provider: estimateProvider,
    spawns,
    strategies: { A: stratA, B: stratB },
  });
  rows.push(computeTelemetry(state, board));
}

// ---- aggregate report ----
const wins: Record<string, number> = { A: 0, B: 0, tie: 0 };
let marginSum = 0;
let leadChangeSum = 0;
let decidedEarly = 0;
const transit: Record<string, number> = { A: 0, B: 0 };
const bandPoints = [0, 0, 0, 0];

for (const t of rows) {
  wins[t.winnerTeamId ?? "tie"] = (wins[t.winnerTeamId ?? "tie"] ?? 0) + 1;
  marginSum += t.margin;
  leadChangeSum += t.leadChanges;
  if (t.decidedBeforeBuzzer) decidedEarly++;
  for (const tm of t.teams) transit[tm.teamId] = (transit[tm.teamId] ?? 0) + tm.transitMinutes;
  for (const b of t.perBand) bandPoints[b.band - 1]! += b.points;
}

const pct = (n: number) => `${((100 * n) / games).toFixed(0)}%`;
const avg = (n: number) => (n / games).toFixed(1);

console.log(`\n=== Paint the Town — ${games} games (${stratA} vs ${stratB}) ===`);
console.log(`Wins:   A ${wins.A} | B ${wins.B} | tie ${wins.tie}`);
console.log(`Avg margin:            ${avg(marginSum)} pts`);
console.log(`Avg lead changes:      ${avg(leadChangeSum)}`);
console.log(`Decided before buzzer: ${pct(decidedEarly)}  (lower = finale matters more)`);
console.log(`Avg transit/team:      A ${avg(transit.A!)} min | B ${avg(transit.B!)} min  of ${DEFAULT_CONFIG.game.gameLengthMin}`);
console.log(`Avg points by band:    B1 ${avg(bandPoints[0]!)} | B2 ${avg(bandPoints[1]!)} | B3 ${avg(bandPoints[2]!)} | B4 ${avg(bandPoints[3]!)}`);

if (csvPath) {
  const csv = [CSV_HEADER, ...rows.map(telemetryToCsvRow)].join("\n");
  writeFileSync(csvPath, csv);
  console.log(`\nWrote ${rows.length} rows to ${csvPath}`);
}
