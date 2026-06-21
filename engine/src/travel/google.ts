import { distanceKm, getArea, neighbors } from "../board.js";
import { simTimeToDeparture, type TravelProvider, type TravelResult } from "./provider.js";
import type { AreaId, Board, Config, LatLng } from "../types.js";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const WALK_KMH = 4.8; // city walking pace, for door-access and the no-route bridge

interface RouteJson {
  duration?: string;
  legs?: Array<{
    steps?: Array<{
      transitDetails?: {
        stopDetails?: { departureStop?: { name?: string }; arrivalStop?: { name?: string } };
        transitLine?: { name?: string; nameShort?: string; vehicle?: { type?: string } };
      };
    }>;
  }>;
}

/** Human itinerary from a Routes response — e.g. "Brown Line @ Belmont → Red Line @ Fullerton".
 *  Walking steps are omitted; only the transit boardings (the bit a player narrates). */
function transitSummary(route: RouteJson | undefined): string | undefined {
  const steps = route?.legs?.flatMap((l) => l.steps ?? []) ?? [];
  const hops: string[] = [];
  for (const s of steps) {
    const td = s.transitDetails;
    if (!td) continue;
    const line = td.transitLine?.name ?? td.transitLine?.nameShort;
    const from = td.stopDetails?.departureStop?.name;
    if (line && from) hops.push(`${line} @ ${from}`);
    else if (line) hops.push(line);
  }
  return hops.length ? hops.join(" → ") : undefined;
}

const walkMin = (a: LatLng, b: LatLng): number => (distanceKm(a, b) / WALK_KMH) * 60;
/** The point we route to/from for an area: its real transit anchor, else its centroid. */
const routePoint = (board: Board, id: AreaId): LatLng => getArea(board, id).anchor ?? getArea(board, id).centroid;
/** Walk from an area's centre to its transit anchor (the "get to the station" leg). */
const accessMin = (board: Board, id: AreaId): number => {
  const a = getArea(board, id);
  return a.anchor ? walkMin(a.centroid, a.anchor) : 0;
};

/**
 * Live Google Routes adapter (Compute Routes, TRANSIT) — spec §2.3. Server-side only;
 * the key never reaches a browser. Routes **anchor-to-anchor** (real station/stop per
 * area) plus a short walk to/from each anchor, so far-flung centroids separated by
 * rivers or rail yards still resolve. If a pair genuinely has no transit route, it does
 * NOT silently fall back to a distance estimate — it **bridges**: ride to the nearest
 * routable neighbour, then walk the rest (honest and slow). A short per-(from,to,minute)
 * memo avoids double-billing and respects Google's no-long-term-storage terms.
 */
export function createGoogleProvider(apiKey: string): TravelProvider {
  const memo = new Map<string, TravelResult>();

  /** Raw transit ride between two areas' anchors. null on no-route / quota / network. */
  async function rawRoute(
    board: Board,
    config: Config,
    from: AreaId,
    to: AreaId,
    departSimTime: number,
  ): Promise<{ minutes: number; summary?: string } | null> {
    const o = routePoint(board, from);
    const d = routePoint(board, to);
    const departure = simTimeToDeparture(config, departSimTime).toISOString();
    try {
      const res = await fetch(ROUTES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "routes.duration,routes.legs.steps.transitDetails",
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: o.lat, longitude: o.lng } } },
          destination: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
          travelMode: "TRANSIT",
          departureTime: departure,
          languageCode: "en-US",
          units: "METRIC",
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { routes?: RouteJson[] };
      const route = json.routes?.[0];
      if (!route?.duration) return null;
      return {
        minutes: Math.round(Number(route.duration.replace(/s$/, "")) / 60),
        summary: transitSummary(route),
      };
    } catch {
      return null;
    }
  }

  /** No direct route: ride to the nearest area reachable from `from`, then walk into `to`. */
  async function bridge(
    board: Board,
    config: Config,
    from: AreaId,
    to: AreaId,
    departSimTime: number,
    cap: number,
  ): Promise<TravelResult | null> {
    const seen = new Set<AreaId>([to]);
    let frontier: AreaId[] = [to];
    for (let ring = 1; ring <= 2; ring++) {
      const candidates: AreaId[] = [];
      for (const a of frontier) {
        for (const n of neighbors(board, a)) if (!seen.has(n)) { seen.add(n); candidates.push(n); }
      }
      let best: { total: number; summary: string } | null = null;
      for (const g of candidates) {
        const walkIn = walkMin(getArea(board, g).centroid, getArea(board, to).centroid);
        let total: number;
        let summary: string;
        if (g === from) {
          // `to` is adjacent to where we already are — no transit, just walk over.
          total = walkIn;
          summary = `walk into ${getArea(board, to).name}`;
        } else {
          const r = await rawRoute(board, config, from, g, departSimTime);
          if (!r) continue;
          total = accessMin(board, from) + r.minutes + accessMin(board, g) + walkIn;
          summary = `${r.summary ?? "transit"} → walk into ${getArea(board, to).name}`;
        }
        if (!best || total < best.total) best = { total: Math.round(total), summary };
      }
      if (best) {
        const capped = Math.min(best.total, cap);
        return { minutes: capped, source: capped < best.total ? "cap" : "walk", summary: best.summary };
      }
      frontier = candidates;
    }
    return null;
  }

  return {
    async travelTime(args): Promise<TravelResult> {
      const { board, config, from, to, departSimTime } = args;
      if (from === to) return { minutes: 0, source: "google" };

      const key = `${from}:${to}:${Math.round(departSimTime)}`;
      const cached = memo.get(key);
      if (cached) return cached;

      const cap = config.travel.maxTravelMin;
      let result: TravelResult;

      const direct = await rawRoute(board, config, from, to, departSimTime);
      if (direct) {
        // door-to-door = walk to anchor + transit ride + walk from anchor
        const total = Math.round(accessMin(board, from) + direct.minutes + accessMin(board, to));
        const capped = Math.min(total, cap);
        result = { minutes: capped, source: capped < total ? "cap" : "google", summary: direct.summary };
      } else {
        result =
          (await bridge(board, config, from, to, departSimTime, cap)) ??
          { minutes: cap, source: "cap", summary: "no transit route — capped" };
      }

      memo.set(key, result);
      return result;
    },
  };
}
