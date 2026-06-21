import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GameState, TeamId } from "@ptt/engine";
import { circlePolygon, liveRadiusKm, type ClientBoard } from "../helpers";

interface Props {
  board: ClientBoard;
  state: GameState | null;
  teamColors: Record<TeamId, string>;
  onPickArea?: (areaId: number) => void;
  /** Lobby use: areaId → color to tint (e.g. chosen spawns), applied when state is null. */
  highlight?: Record<number, string>;
}

const BAND_TINT: Record<number, string> = { 1: "#3a2f4a", 2: "#2f3a4a", 3: "#2f4a3a", 4: "#3a3a2f" };

export function MapView({ board, state, teamColors, onPickArea, highlight }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const loadedRef = useRef(false);

  // init once
  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: {
        version: 8,
        // Glyphs for area-name labels. The board geometry is local (board.json);
        // this CDN only supplies label fonts and degrades gracefully offline.
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {},
        layers: [{ id: "bg", type: "background", paint: { "background-color": "#11141b" } }],
      },
      center: [-87.68, 41.84],
      zoom: 9.6,
      attributionControl: false,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("areas", { type: "geojson", data: board.geojson, promoteId: "id" });
      map.addLayer({
        id: "area-fill",
        type: "fill",
        source: "areas",
        paint: {
          "fill-color": ["coalesce", ["feature-state", "color"], ["match", ["get", "band"], 1, BAND_TINT[1], 2, BAND_TINT[2], 3, BAND_TINT[3], BAND_TINT[4]]],
          "fill-opacity": ["case", ["boolean", ["feature-state", "locked"], false], 0.92, 0.7],
        },
      });
      map.addLayer({
        id: "area-line",
        type: "line",
        source: "areas",
        paint: { "line-color": "#0a0c10", "line-width": 0.8 },
      });
      map.addLayer({
        id: "area-label",
        type: "symbol",
        source: "areas",
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 9, "text-max-width": 7 },
        paint: { "text-color": "#cdd3df", "text-halo-color": "#0008", "text-halo-width": 1 },
      });

      map.addSource("wall", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "wall-line", type: "line", source: "wall", paint: { "line-color": "#ffd166", "line-width": 2.5, "line-dasharray": [2, 1] } });

      map.on("click", "area-fill", (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id != null && onPickArea) onPickArea(Number(id));
      });
      map.on("mouseenter", "area-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "area-fill", () => (map.getCanvas().style.cursor = ""));

      loadedRef.current = true;
      paint();
    });

    // MapLibre doesn't track container size changes (layout reflow, window
    // tiling, lobby→game switch) — keep the canvas matched to its box.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  // repaint on state change
  function paint() {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    for (const a of board.areas) {
      const as = state?.areas[String(a.id)];
      // In-game color = current holder; lobby color = highlight (chosen spawn).
      const color = as?.holderTeamId ? teamColors[as.holderTeamId] : highlight?.[a.id] ?? null;
      const locked = as?.locked ?? (highlight?.[a.id] != null); // bump opacity for spawns too
      map.setFeatureState({ source: "areas", id: a.id }, { color, locked });
    }

    // wall ring
    const wallSrc = map.getSource("wall") as maplibregl.GeoJSONSource | undefined;
    if (wallSrc && state && state.wall.radiusKm > 0) {
      const loop = board.areas.find((a) => a.id === board.loopAreaId)!.centroid;
      wallSrc.setData({ type: "FeatureCollection", features: [circlePolygon(loop, liveRadiusKm(board, state))] });
    } else if (wallSrc) {
      wallSrc.setData({ type: "FeatureCollection", features: [] });
    }

    // team markers
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    if (state) {
      for (const t of state.teams) {
        const area = board.areas.find((a) => a.id === t.locationAreaId);
        if (!area) continue;
        const el = document.createElement("div");
        el.className = "team-marker";
        el.style.background = t.color;
        el.title = `${t.name}${t.inTransit ? " (in transit)" : ""}`;
        el.textContent = t.id;
        if (t.inTransit) el.style.opacity = "0.5";
        markersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat([area.centroid.lng, area.centroid.lat]).addTo(map));
      }
    }
  }

  useEffect(paint);

  return <div ref={ref} className="map" />;
}
