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

const CTA_COLORS = ["Red", "Blue", "Brown", "Green", "Orange", "Pink", "Purple", "Yellow"];

/** Parse the rail/Metra lines an area is on from its `modes` string. Color words map to
 *  CTA 'L' lines (so "Pink/Green" → both); "All L lines" (the Loop) expands to all of
 *  them — the downtown hub connects every line. Segments flagged "near …" are skipped
 *  (the line is just over the border, not in-area). */
function parseLines(modes?: string): string[] {
  if (!modes) return [];
  const out = new Set<string>();
  for (const seg of modes.split(";")) {
    if (/near/i.test(seg)) continue;
    if (/all l lines|all lines/i.test(seg)) { CTA_COLORS.forEach((c) => out.add(c)); continue; }
    for (const c of CTA_COLORS) if (new RegExp(`\\b${c}\\b`, "i").test(seg)) out.add(c);
    if (/metra electric/i.test(seg)) out.add("MetraElectric");
    if (/up-?nw/i.test(seg)) out.add("UP-NW");
    else if (/up-?n/i.test(seg)) out.add("UP-N");
    if (/md-?w/i.test(seg)) out.add("MD-W");
    if (/md-?n/i.test(seg)) out.add("MD-N");
    if (/rock island/i.test(seg)) out.add("RockIsland");
    if (/south shore/i.test(seg)) out.add("SouthShore");
  }
  return [...out];
}

/** Merge data/transit.json (anchor + transitScore + rail lines) onto the board areas in
 *  place. Optional: absent file leaves areas routing centroid-to-centroid with no penalty. */
export function attachTransit(areas: Board["areas"], dataDir: string): void {
  let byArea: Record<string, { lat: number; lng: number; transitScore?: number; modes?: string }>;
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
    a.lines = parseLines(t.modes);
  }
}
