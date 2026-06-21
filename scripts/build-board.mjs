#!/usr/bin/env node
// Phase 0 — Data prep.
// Reads the raw Chicago "Community Areas" GeoJSON and emits data/board.json:
//   { areas: Area[], adjacency: Record<id, id[]>, geojson: FeatureCollection }
// Bands (1=core .. 4=outer edge) are derived from each area's distance to the
// Loop, matching the wall model in the spec (the wall is centered on the Loop and
// consumes Band 4 first, Band 1 last). bands.md was not provided, so this is the
// documented stand-in; swap in real band data by editing BAND_OVERRIDES below.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const raw = JSON.parse(readFileSync(join(ROOT, "data/comm_areas.raw.geojson"), "utf8"));

// --- geometry helpers (lng/lat planar approximations; fine at city scale) ---

/** All linear rings of a (Multi)Polygon geometry, outer rings only (index 0). */
function outerRings(geom) {
  if (geom.type === "Polygon") return [geom.coordinates[0]];
  if (geom.type === "MultiPolygon") return geom.coordinates.map((p) => p[0]);
  return [];
}

/** Area-weighted centroid of a (possibly multi) polygon via the shoelace formula. */
function centroidOf(geom) {
  let cxSum = 0,
    cySum = 0,
    aSum = 0;
  for (const ring of outerRings(geom)) {
    let cx = 0,
      cy = 0,
      a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      const cross = x0 * y1 - x1 * y0;
      a += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    a *= 0.5;
    if (Math.abs(a) > 1e-12) {
      cxSum += cx / (6 * a) * Math.abs(a);
      cySum += cy / (6 * a) * Math.abs(a);
      aSum += Math.abs(a);
    }
  }
  return { lng: cxSum / aSum, lat: cySum / aSum };
}

/** Equirectangular distance in km between two lng/lat points. */
function distanceKm(a, b) {
  const R = 6371;
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lng - a.lng) * (Math.PI / 180) * Math.cos(lat) * R;
  const dy = (b.lat - a.lat) * (Math.PI / 180) * R;
  return Math.hypot(dx, dy);
}

/** Project a lng/lat to local km plane around an origin (for point-to-segment math). */
function toLocalKm(p, origin) {
  const R = 6371;
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    x: (p.lng - origin.lng) * (Math.PI / 180) * Math.cos(latRad) * R,
    y: (p.lat - origin.lat) * (Math.PI / 180) * R,
  };
}

/** Shortest distance (km) from `origin` to a segment AB, all lng/lat. */
function pointToSegmentKm(origin, A, B) {
  const a = toLocalKm(A, origin); // origin is the local (0,0)
  const b = toLocalKm(B, origin);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(a.x * dx + a.y * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return Math.hypot(px, py);
}

/** Nearest distance (km) from `origin` to a (Multi)Polygon's boundary. */
function nearestBoundaryKm(geom, origin) {
  let best = Infinity;
  for (const ring of outerRings(geom)) {
    for (let i = 0; i < ring.length - 1; i++) {
      const A = { lng: ring[i][0], lat: ring[i][1] };
      const B = { lng: ring[i + 1][0], lat: ring[i + 1][1] };
      const d = pointToSegmentKm(origin, A, B);
      if (d < best) best = d;
    }
  }
  return best;
}

// --- normalize features ----------------------------------------------------

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bMc(\w)/g, (m, c) => "Mc" + c.toUpperCase());

// Rough east/west split at Chicago's State Street meridian (~ -87.628).
const sideOf = (lng) => (lng >= -87.628 ? "east" : "west");

const features = raw.features.map((f) => {
  const p = f.properties;
  const id = Number(p.area_numbe ?? p.area_num_1);
  const name = titleCase(p.community);
  const centroid = centroidOf(f.geometry);
  return { id, name, centroid, geometry: f.geometry, feature: f };
});
features.sort((a, b) => a.id - b.id);

// --- bands from distance to the Loop (area 32) -----------------------------

const loop = features.find((f) => f.id === 32);
if (!loop) throw new Error("Loop (area 32) not found in source data");

for (const f of features) f.distKm = distanceKm(f.centroid, loop.centroid);
const maxDist = Math.max(...features.map((f) => f.distKm));

// Four concentric rings by distance. Thresholds chosen so the core (Band 1) is a
// tight cluster around the Loop and the outer edge (Band 4) is the largest band —
// the shape the wall pacing in the spec assumes.
const BAND_OVERRIDES = {}; // { areaId: band } — drop real bands.md data here.
function bandFor(f) {
  if (BAND_OVERRIDES[f.id]) return BAND_OVERRIDES[f.id];
  const r = f.distKm / maxDist;
  if (r < 0.18) return 1;
  if (r < 0.4) return 2;
  if (r < 0.62) return 3;
  return 4;
}

const VALUE_BY_BAND = { 1: 8, 2: 4, 3: 2, 4: 1 }; // spec §7: 8/4/2/1 (Band 1→4)

const areas = features.map((f) => {
  const band = bandFor(f);
  // nearKm = how close the area's nearest edge gets to downtown (the Loop centroid).
  // The closing wall (a shrinking circle on the Loop) locks an area only once its
  // radius drops below this — i.e. when no part of the area is inside the circle.
  // The Loop contains the centre, so it's 0 (stays live until the buzzer).
  const nearKm =
    f.id === loop.id ? 0 : round(nearestBoundaryKm(f.geometry, loop.centroid), 4);
  return {
    id: f.id,
    name: f.name,
    side: sideOf(f.centroid.lng),
    band,
    value: VALUE_BY_BAND[band],
    centroid: { lat: round(f.centroid.lat, 6), lng: round(f.centroid.lng, 6) },
    nearKm,
    deckSize: band === 1 ? 12 : 5, // core gets a deep deck; others ~5 (spec §2.4)
  };
});

function round(n, d) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

// --- adjacency from shared polygon edges -----------------------------------
// Community-area boundaries in this dataset share exact vertices along common
// borders, so two areas are adjacent when their rings share >= 2 rounded points
// (i.e. at least one shared edge). Validated below against known neighbors.

function ringPointKeys(geom) {
  const keys = new Set();
  for (const ring of outerRings(geom)) {
    for (const [x, y] of ring) keys.add(`${x.toFixed(5)},${y.toFixed(5)}`);
  }
  return keys;
}

const pointSets = features.map((f) => ({ id: f.id, pts: ringPointKeys(f.geometry) }));
const adjacency = {};
for (const f of features) adjacency[f.id] = [];

for (let i = 0; i < pointSets.length; i++) {
  for (let j = i + 1; j < pointSets.length; j++) {
    const a = pointSets[i];
    const b = pointSets[j];
    let shared = 0;
    const [small, big] = a.pts.size < b.pts.size ? [a.pts, b.pts] : [b.pts, a.pts];
    for (const k of small) {
      if (big.has(k)) {
        shared++;
        if (shared >= 2) break;
      }
    }
    if (shared >= 2) {
      adjacency[a.id].push(b.id);
      adjacency[b.id].push(a.id);
    }
  }
}
for (const id of Object.keys(adjacency)) adjacency[id].sort((x, y) => x - y);

// --- a slimmed GeoJSON for the client map (keep id + name only) ------------
const geojson = {
  type: "FeatureCollection",
  features: features.map((f) => ({
    type: "Feature",
    properties: { id: f.id, name: f.name, band: bandFor(f) },
    geometry: f.geometry,
  })),
};

const board = { areas, adjacency, loopAreaId: 32, geojson };
writeFileSync(join(ROOT, "data/board.json"), JSON.stringify(board));

// --- report + sanity checks ------------------------------------------------
const bandCounts = areas.reduce((m, a) => ((m[a.band] = (m[a.band] || 0) + 1), m), {});
const isolated = Object.entries(adjacency).filter(([, n]) => n.length === 0);
const avgNeighbors =
  Object.values(adjacency).reduce((s, n) => s + n.length, 0) / areas.length;

console.log(`areas: ${areas.length}`);
console.log(`band counts (1..4): ${[1, 2, 3, 4].map((b) => bandCounts[b] || 0).join(" / ")}`);
console.log(`avg neighbors: ${avgNeighbors.toFixed(2)}  isolated: ${isolated.length}`);
console.log(`Loop neighbors: ${adjacency[32].join(", ")}`);
if (isolated.length) {
  console.warn("WARNING isolated areas:", isolated.map(([id]) => id).join(", "));
}
