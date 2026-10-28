// GPS for the IoT node, with privacy levels chosen by the person carrying the phone:
//   off        - never sent
//   emergency  - sent only while a fall / SOS is active (exact position for responders)
//   always     - sent with every message, rounded to ~100 m (exact during an emergency)
// The browser only gives location while this page is open (foreground).

export type LocationMode = "off" | "emergency" | "always";

export interface Fix {
  lat: number;
  lon: number;
  acc: number; // metres
  spd: number | null; // m/s
  at: number;
}

const MODE_KEY = "pulselake.locationMode";

export class Location {
  mode: LocationMode = readMode();
  last: Fix | null = null;
  error = "";
  private watchId: number | null = null;
  private highAccuracy = false;
  onChange: () => void = () => {};

  /** Must be called from a tap the first time (permission prompt). */
  setMode(mode: LocationMode) {
    this.mode = mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* ignore */
    }
    this.restart();
  }

  start() {
    this.restart();
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation?.clearWatch(this.watchId);
    this.watchId = null;
  }

  /** emergencies ask the GPS chip for its best accuracy */
  setEmergency(on: boolean) {
    if (on === this.highAccuracy) return;
    this.highAccuracy = on;
    if (this.mode !== "off") this.restart();
  }

  private restart() {
    this.stop();
    if (this.mode === "off") {
      this.last = null;
      this.onChange();
      return;
    }
    if (!("geolocation" in navigator)) {
      this.error = "This browser has no GPS access";
      this.onChange();
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        this.error = "";
        this.last = {
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          acc: Math.round(p.coords.accuracy),
          spd: p.coords.speed === null ? null : Math.round(p.coords.speed * 10) / 10,
          at: Date.now(),
        };
        this.onChange();
      },
      (e) => {
        this.error = e.code === e.PERMISSION_DENIED ? "Location permission was denied" : e.message || "No GPS fix yet";
        this.onChange();
      },
      { enableHighAccuracy: this.highAccuracy, maximumAge: 15_000, timeout: 30_000 },
    );
  }

  /** Fields to add to a message, respecting the privacy level. */
  share(emergency: boolean): { lat?: number; lon?: number; gacc?: number; spd?: number | null } {
    const f = this.last;
    if (!f || this.mode === "off" || Date.now() - f.at > 120_000) return {};
    if (this.mode === "emergency" && !emergency) return {};
    const d = emergency ? 5 : 3; // 3 decimals ≈ 110 m
    return { lat: round(f.lat, d), lon: round(f.lon, d), gacc: emergency ? f.acc : Math.max(f.acc, 110), spd: f.spd };
  }
}

function round(n: number, d: number) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function readMode(): LocationMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "emergency" || v === "always" ? v : "off";
  } catch {
    return "off";
  }
}
