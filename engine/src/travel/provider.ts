import type { AreaId, Board, Config } from "../types.js";

export interface TravelResult {
  /** Resolved travel time in sim minutes. */
  minutes: number;
  /** Where the time came from — useful for telemetry and no-route flagging.
   *  "walk" = no transit route; bridged by riding to a neighbor and walking in. */
  source: "google" | "estimate" | "cap" | "walk";
  /** Optional human-readable itinerary summary (Google only). */
  summary?: string;
}

/**
 * All travel goes behind this one function (spec §2.3). `departSimTime` is minutes
 * since game start; providers map it to a real future timestamp with the same
 * weekday for schedule-aware lookups.
 */
export interface TravelProvider {
  travelTime(args: {
    board: Board;
    config: Config;
    from: AreaId;
    to: AreaId;
    departSimTime: number;
  }): Promise<TravelResult>;
}

/**
 * Map a sim-minute offset to a real future epoch (ms) on the same weekday/time as
 * the notional in-game datetime, so the Routes schedule lookup is real and
 * reproducible across runs (spec §2.3).
 */
export function simTimeToDeparture(config: Config, departSimTime: number): Date {
  const { weekday, hour, minute } = config.game.notionalStart;
  // Find the next future date matching `weekday` (0=Sun..6=Sat), then add offset.
  const now = new Date();
  const base = new Date(now);
  base.setHours(hour, minute, 0, 0);
  const dayDelta = (weekday - base.getDay() + 7) % 7 || 7; // strictly in the future
  base.setDate(base.getDate() + dayDelta);
  return new Date(base.getTime() + departSimTime * 60_000);
}
