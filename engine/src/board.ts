import type { AreaId, AreaStatic, Board, LatLng } from "./types.js";

export function getArea(board: Board, id: AreaId): AreaStatic {
  const a = board.areas.find((x) => x.id === id);
  if (!a) throw new Error(`unknown area ${id}`);
  return a;
}

export function neighbors(board: Board, id: AreaId): AreaId[] {
  return board.adjacency[String(id)] ?? [];
}

/** Equirectangular distance in km — used by the offline travel estimator. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lng - a.lng) * (Math.PI / 180) * Math.cos(lat) * R;
  const dy = (b.lat - a.lat) * (Math.PI / 180) * R;
  return Math.hypot(dx, dy);
}

/**
 * Largest single connected region (by area count) among `held` areas, using the
 * board adjacency map. Drives the win tiebreaker (spec §4 / §12).
 */
export function largestConnectedRegion(board: Board, held: Set<AreaId>): number {
  const seen = new Set<AreaId>();
  let best = 0;
  for (const start of held) {
    if (seen.has(start)) continue;
    let size = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      size++;
      for (const n of neighbors(board, cur)) {
        if (held.has(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    if (size > best) best = size;
  }
  return best;
}
