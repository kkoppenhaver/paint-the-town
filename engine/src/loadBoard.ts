import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Board } from "./types.js";

/** Load data/board.json (Node only). The client imports board.json via Vite. */
export function loadBoard(): Board {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = join(here, "../../data");
  const raw = JSON.parse(readFileSync(join(dataDir, "board.json"), "utf8"));
  let challenges: Board["challenges"];
  try {
    challenges = JSON.parse(readFileSync(join(dataDir, "challenges.json"), "utf8")).byArea;
  } catch {
    challenges = undefined; // optional — the engine tolerates a board with no decks
  }
  return { areas: raw.areas, adjacency: raw.adjacency, loopAreaId: raw.loopAreaId, challenges };
}
