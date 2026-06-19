import type { AreaStatic, Config, GameState, LatLng } from "@ptt/engine";
import { HTTP_BASE } from "./net";

export interface ClientBoard {
  areas: AreaStatic[];
  adjacency: Record<string, number[]>;
  loopAreaId: number;
  geojson: GeoJSON.FeatureCollection;
}

export async function fetchBoard(): Promise<ClientBoard> {
  const res = await fetch(`${HTTP_BASE}/board.json`);
  return res.json();
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Notional in-game datetime: notionalStart + simTime minutes (spec §2.1). */
export function gameDateTime(config: Config, simTime: number): string {
  const { weekday, hour, minute } = config.game.notionalStart;
  const total = hour * 60 + minute + simTime;
  const dayOffset = Math.floor(total / (24 * 60));
  const mins = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const day = DAYS[(weekday + dayOffset) % 7];
  return `${day} ${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lng - a.lng) * (Math.PI / 180) * Math.cos(lat) * R;
  const dy = (b.lat - a.lat) * (Math.PI / 180) * R;
  return Math.hypot(dx, dy);
}

/** Radius (km) of the current live zone: farthest live area from the Loop + margin. */
export function liveRadiusKm(board: ClientBoard, state: GameState): number {
  const loop = board.areas.find((a) => a.id === board.loopAreaId)!.centroid;
  let max = 0;
  for (const a of board.areas) {
    if (!state.wall.liveBands.includes(a.band)) continue;
    max = Math.max(max, distanceKm(loop, a.centroid));
  }
  return max + 1.5;
}

/** A circle polygon (for the closing wall overlay) around a center. */
export function circlePolygon(center: LatLng, radiusKm: number, points = 72): GeoJSON.Feature {
  const coords: [number, number][] = [];
  const latRad = (center.lat * Math.PI) / 180;
  for (let i = 0; i <= points; i++) {
    const t = (i / points) * 2 * Math.PI;
    const dLat = (radiusKm / 111) * Math.cos(t);
    const dLng = (radiusKm / (111 * Math.cos(latRad))) * Math.sin(t);
    coords.push([center.lng + dLng, center.lat + dLat]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } };
}

export function areaValue(config: Config, band: number): number {
  return config.bandValues[String(band) as "1" | "2" | "3" | "4"];
}
