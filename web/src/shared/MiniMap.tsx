// Small Leaflet map (OpenStreetMap tiles, free with attribution) used by the Responder app and the
// dashboard's fleet map. Circle markers only (no image assets); zones drawn as circles.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

export interface MapPoint {
  id: string;
  lat: number;
  lon: number;
  label: string;
  tone?: "ok" | "warn" | "fail" | "off";
  accuracy?: number; // metres
}

export interface MapZone {
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
}

const TONE: Record<NonNullable<MapPoint["tone"]>, string> = { ok: "#2ee6a6", warn: "#ffc23d", fail: "#ff4d6d", off: "#6b7590" };

export function MiniMap({ points, zones = [], height = 220, zoom = 15 }: { points: MapPoint[]; zones?: MapZone[]; height?: number; zoom?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef("");

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: false, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    zones.forEach((z) => {
      L.circle([z.lat, z.lon], { radius: z.radiusM, color: "#7b61ff", weight: 1.5, fillOpacity: 0.08, dashArray: "6 6" })
        .bindTooltip(`Zone: ${z.name}`)
        .addTo(g);
    });
    points.forEach((p) => {
      const color = TONE[p.tone ?? "ok"];
      if (p.accuracy && p.accuracy > 15) {
        L.circle([p.lat, p.lon], { radius: p.accuracy, color, weight: 0, fillOpacity: 0.12 }).addTo(g);
      }
      L.circleMarker([p.lat, p.lon], { radius: 8, color: "#ffffff", weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(p.label, { permanent: points.length <= 4, direction: "top", offset: [0, -8] })
        .addTo(g);
    });
    // re-fit only when the set of things on the map changes, not on every position update
    const key = [...points.map((p) => p.id), ...zones.map((z) => z.name)].join(",");
    if (key !== fitted.current) {
      fitted.current = key;
      const all: L.LatLngExpression[] = [...points.map((p) => [p.lat, p.lon] as [number, number]), ...zones.map((z) => [z.lat, z.lon] as [number, number])];
      if (all.length === 1) m.setView(all[0], zoom);
      else if (all.length > 1) m.fitBounds(L.latLngBounds(all).pad(0.3), { maxZoom: zoom });
    }
  }, [points, zones, zoom]);

  return <div ref={el} className="minimap" style={{ height }} />;
}
