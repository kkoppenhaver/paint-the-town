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
    const km = distanceKm(getArea(board, from).centroid, getArea(board, to).centroid);
    const { transitSpeedKmh, perTransferMin, baseAccessMin } = config.travel.estimate;

    const rideMin = (km / transitSpeedKmh) * 60;
    // Rough transfer count: ~1 transfer per 4 km of separation.
    const transfers = Math.floor(km / 4);
    const minutes = baseAccessMin + rideMin + transfers * perTransferMin;

    const capped = Math.min(minutes, config.travel.maxTravelMin);
    return {
      minutes: Math.round(capped),
      source: capped < minutes ? "cap" : "estimate",
    };
  },
};
