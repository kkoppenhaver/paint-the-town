import { distanceKm, getArea } from "../board.js";
import type { TravelProvider, TravelResult } from "./provider.js";

/**
 * Offline transit estimator. Schedule-aware-*ish*: door-to-door time from centroid
 * distance at an average transit speed, plus access (walk+wait) and a transfer
 * surcharge that scales with distance. Deterministic — ideal for headless balance
 * sweeps and for running with no Google key. Not a substitute for the live Routes
 * call during real playtests (spec §2.3), but the same `travelTime` contract.
 */
export const estimateProvider: TravelProvider = {
  async travelTime({ board, config, from, to }): Promise<TravelResult> {
    if (from === to) return { minutes: 0, source: "estimate" };
    const a = getArea(board, from);
    const b = getArea(board, to);
    const km = distanceKm(a.centroid, b.centroid);
    const { transitSpeedKmh, railSpeedKmh, perTransferMin, baseAccessMin, accessPenaltyPerLevelMin } =
      config.travel.estimate;

    // Sparse-transit penalty at each end: areas far below a perfect score pay extra
    // access/wait time, so the offline model feels transit deserts (missing score = 5).
    const penalty = (score?: number) => (5 - (score ?? 5)) * accessPenaltyPerLevelMin;

    // Rail topology (nearly all Chicago rail converges downtown):
    //  - share a line          → one-seat ride: rail speed, no transfer (O'Hare→Loop).
    //  - both on some rail line → rail speed + one downtown transfer (O'Hare→Near North).
    //  - otherwise (bus-heavy)  → slower mixed speed + a transfer per ~4 km.
    // Frequency cost (infrequent Metra/bus) is carried by the per-area score penalty.
    const aRail = (a.lines?.length ?? 0) > 0;
    const bRail = (b.lines?.length ?? 0) > 0;
    const shared = aRail && bRail && a.lines!.some((l) => b.lines!.includes(l));
    let rideMin: number, transferMin: number;
    if (shared) {
      rideMin = (km / railSpeedKmh) * 60;
      transferMin = 0;
    } else if (aRail && bRail) {
      rideMin = (km / railSpeedKmh) * 60;
      transferMin = perTransferMin; // one transfer downtown
    } else {
      rideMin = (km / transitSpeedKmh) * 60;
      transferMin = Math.floor(km / 4) * perTransferMin; // bus-heavy: ~1 per 4 km
    }
    const minutes = baseAccessMin + rideMin + transferMin + penalty(a.transitScore) + penalty(b.transitScore);

    const capped = Math.min(minutes, config.travel.maxTravelMin);
    return {
      minutes: Math.round(capped),
      source: capped < minutes ? "cap" : "estimate",
    };
  },
};
