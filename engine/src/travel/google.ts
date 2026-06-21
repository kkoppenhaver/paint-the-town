import { getArea } from "../board.js";
import { estimateProvider } from "./estimate.js";
import { simTimeToDeparture, type TravelProvider, type TravelResult } from "./provider.js";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

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

/**
 * Live Google Routes adapter (Compute Routes, TRANSIT) — spec §2.3. Server-side
 * only; the key never reaches a browser. Resolves the true schedule-aware travel
 * time for a committed move and caps/falls back so a no-route weekend pair never
 * stalls the game. A short per-(from,to,sim-minute) memo avoids double-billing
 * within a single moment, which also respects Google's no-long-term-storage terms.
 */
export function createGoogleProvider(apiKey: string): TravelProvider {
  const memo = new Map<string, TravelResult>();

  return {
    async travelTime(args): Promise<TravelResult> {
      const { board, config, from, to, departSimTime } = args;
      if (from === to) return { minutes: 0, source: "google" };

      const key = `${from}:${to}:${Math.round(departSimTime)}`;
      const cached = memo.get(key);
      if (cached) return cached;

      const o = getArea(board, from).centroid;
      const d = getArea(board, to).centroid;
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

        if (!res.ok) throw new Error(`Routes API ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as { routes?: RouteJson[] };
        const route = json.routes?.[0];
        const durStr = route?.duration; // e.g. "1234s"
        if (!durStr) throw new Error("no transit route");

        const seconds = Number(durStr.replace(/s$/, ""));
        const minutes = Math.round(seconds / 60);
        const capped = Math.min(minutes, config.travel.maxTravelMin);
        const result: TravelResult = {
          minutes: capped,
          source: capped < minutes ? "cap" : "google",
          summary: transitSummary(route),
        };
        memo.set(key, result);
        return result;
      } catch (err) {
        // No-route / quota / network: fall back to the offline estimate so the
        // clock keeps moving, flagged via source so telemetry can see it.
        const fallback = await estimateProvider.travelTime(args);
        const result: TravelResult = { ...fallback, summary: `fallback: ${String(err)}` };
        memo.set(key, result);
        return result;
      }
    },
  };
}
