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
  attachTransit(raw.areas, dataDir);
  return { areas: raw.areas, adjacency: raw.adjacency, loopAreaId: raw.loopAreaId, challenges };
}

/** Merge data/transit.json (anchor + transitScore) onto the board areas in place.
 *  Optional: absent file leaves areas routing centroid-to-centroid with no penalty. */
export function attachTransit(areas: Board["areas"], dataDir: string): void {
  let byArea: Record<string, { lat: number; lng: number; transitScore?: number }>;
  try {
    byArea = JSON.parse(readFileSync(join(dataDir, "transit.json"), "utf8")).byArea;
  } catch {
    return;
  }
  for (const a of areas) {
    const t = byArea[String(a.id)];
    if (!t) continue;
    a.anchor = { lat: t.lat, lng: t.lng };
    a.transitScore = t.transitScore;
  }
}
