// Where are the devices? Live GPS (only for phones whose owner shares location) + saved zones.
import { useEffect, useMemo, useState } from "react";
import { MiniMap, type MapPoint } from "../shared/MiniMap";
import { SLOTS } from "../shared/types";
import { api, type Zone } from "./api";
import { statusOf, useFleet } from "./store";

export function FleetMap() {
  const snap = useFleet();
  const [zones, setZones] = useState<Zone[]>([]);
  useEffect(() => {
    const load = () => api.zones().then(setZones).catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const located = SLOTS.map((id) => snap.devices[id]).filter((d) => d?.loc);
  const points: MapPoint[] = useMemo(
    () =>
      located.map((d) => {
        const st = statusOf(d, snap.now);
        const tone = st === "FAILED" || st === "OFFLINE" ? "fail" : st === "WARNING" || st === "SIGNAL_LOST" ? "warn" : st === "LEFT" ? "off" : "ok";
        return { id: d.id, lat: d.loc!.lat, lon: d.loc!.lon, label: `${d.id.replace("PHONE_", "P")} ${d.owner ?? ""}`, tone, accuracy: d.loc!.acc };
      }),
    // positions change every message; the map itself only re-fits when the set of devices changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [located.map((d) => `${d.id}${d.loc!.lat}${d.loc!.lon}`).join(), snap.now - (snap.now % 5000)],
  );

  return (
    <section className="card fleetmap">
      <h3>
        Fleet map <small>GPS only from phones that share location · zones for geofence rules · OpenStreetMap</small>
      </h3>
      {points.length || zones.length ? (
        <MiniMap points={points} zones={zones} height={260} />
      ) : (
        <p className="emptyrow">
          No locations yet. On a phone: Sensor hub → Location → "Always" (or "Emergency only"), then "Save this place as zone".
        </p>
      )}
    </section>
  );
}
