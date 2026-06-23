#!/usr/bin/env tsx
// Bake the slim engine board into the Worker bundle. loadBoard() already returns exactly
// what the simulation needs — areas + adjacency + loopAreaId + challenges, with transit
// merged and the 2MB map geojson dropped — so the Durable Object can import it directly
// (no filesystem at runtime). The full board.json (with geojson, for the client map) is
// served separately as a static asset. Run via tsx (it imports the TypeScript engine).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBoard } from "@ptt/engine";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../worker/src/board.data.json");

const board = loadBoard();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(board));

const kb = (JSON.stringify(board).length / 1024).toFixed(1);
console.log(
  `baked engine board → worker/src/board.data.json ` +
    `(${board.areas.length} areas, ${board.challenges ? "with" : "no"} challenges, ${kb} KB)`,
);
