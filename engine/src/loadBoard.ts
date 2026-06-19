import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Board } from "./types.js";

/** Load data/board.json (Node only). The client imports board.json via Vite. */
export function loadBoard(): Board {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "../../data/board.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return { areas: raw.areas, adjacency: raw.adjacency, loopAreaId: raw.loopAreaId };
}
