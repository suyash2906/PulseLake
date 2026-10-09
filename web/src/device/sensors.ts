// Reads the phone's real sensors (motion, orientation, battery) and summarises them
// per publish window. Falls back to gentle simulated motion when the browser has no
// sensors (e.g. a laptop), so the pipeline can still be tested.

type Vec3 = [number, number, number];

export interface SensorWindow {
  vib: number; // RMS of dynamic acceleration (gravity removed), m/s²
  vibPeak: number;
  acc: Vec3; // latest acceleration including gravity
  ori: Vec3[]; // orientation samples [alpha, beta, gamma] at ~10 Hz
  bat: number | null;
  chg: boolean;
  real: boolean;
}

/** iOS 13+ requires an explicit permission request from a user gesture. */
export async function requestMotionPermission(): Promise<boolean> {
  const dme = (window as any).DeviceMotionEvent;
  const doe = (window as any).DeviceOrientationEvent;
  try {
    if (dme && typeof dme.requestPermission === "function") {
      if ((await dme.requestPermission()) !== "granted") return false;
    }
    if (doe && typeof doe.requestPermission === "function") {
      await doe.requestPermission();
    }
    return true;
  } catch {
    return false;
  }
}

export class Sensors {
  private sumSq = 0;
  private count = 0;
  private peak = 0;
  private acc: Vec3 = [0, 0, 9.81];
  private gravity: Vec3 = [0, 0, 9.81];
  private orientation: Vec3 = [0, 0, 0];
  private oriSamples: Vec3[] = [];
  private gotMotion = false;
  private gotOrientation = false;
  private battery: { level: number; charging: boolean } | null = null;
  private sampler: number | undefined;
  private startedAt = 0;
  /** last time the phone moved noticeably (used as "activity" for auto-sleep) */
  lastMovement = Date.now();

  start() {
    this.startedAt = Date.now();
    window.addEventListener("devicemotion", this.onMotion);
    window.addEventListener("deviceorientation", this.onOrientation);
    // Battery Status API: Chrome/Android only (not iPhone/Safari).
    (navigator as any).getBattery?.().then((b: any) => {
      const update = () => (this.battery = { level: Math.round(b.level * 100), charging: !!b.charging });
      update();
      b.addEventListener("levelchange", update);
      b.addEventListener("chargingchange", update);
    });
    // Sample orientation at 10 Hz so the dashboard can replay smooth 3D motion.
    this.sampler = window.setInterval(() => {
      if (!this.gotOrientation && Date.now() - this.startedAt > 2000) this.simulateMotion();
      this.oriSamples.push([...this.orientation].map((n) => Math.round(n * 10) / 10) as Vec3);
      if (this.oriSamples.length > 40) this.oriSamples.shift();
    }, 100);
  }

  stop() {
    window.removeEventListener("devicemotion", this.onMotion);
    window.removeEventListener("deviceorientation", this.onOrientation);
    clearInterval(this.sampler);
  }

  get isReal() {
    return this.gotMotion || this.gotOrientation;
  }

  /** Returns the summary since the previous call and resets the window. */
  takeWindow(): SensorWindow {
    const rms = this.count ? Math.sqrt(this.sumSq / this.count) : 0;
    const w: SensorWindow = {
      vib: round(rms, 2),
      vibPeak: round(this.peak, 2),
      acc: this.acc.map((n) => round(n, 2)) as Vec3,
      ori: this.oriSamples.splice(0, this.oriSamples.length),
      bat: this.battery?.level ?? null,
      chg: this.battery?.charging ?? false,
      real: this.isReal,
    };
    this.sumSq = 0;
    this.count = 0;
    this.peak = 0;
    return w;
  }

  /** live values for the phone UI (not reset) */
  get liveOrientation(): Vec3 {
    return this.orientation;
  }

  private onMotion = (e: DeviceMotionEvent) => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    this.gotMotion = true;
    this.acc = [g.x ?? 0, g.y ?? 0, g.z ?? 0];
    let dyn: Vec3;
    if (e.acceleration && e.acceleration.x != null) {
      dyn = [e.acceleration.x ?? 0, e.acceleration.y ?? 0, e.acceleration.z ?? 0];
    } else {
      // No gravity-free reading: low-pass filter estimates gravity, subtract it.
      const a = 0.9;
      this.gravity = this.gravity.map((gv, i) => a * gv + (1 - a) * this.acc[i]) as Vec3;
      dyn = this.acc.map((v, i) => v - this.gravity[i]) as Vec3;
    }
    const mag = Math.hypot(...dyn);
    this.sumSq += mag * mag;
    this.count++;
    if (mag > this.peak) this.peak = mag;
    if (mag > 2) this.lastMovement = Date.now();
  };

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta == null && e.gamma == null) return;
    this.gotOrientation = true;
    this.orientation = [e.alpha ?? 0, e.beta ?? 0, e.gamma ?? 0];
  };

  private simulateMotion() {
    const t = Date.now() / 1000;
    const jitter = () => (Math.random() - 0.5) * 0.1; // real sensors are never perfectly still
    this.orientation = [(t * 12) % 360, 20 * Math.sin(t / 2), 15 * Math.sin(t / 3)];
    this.acc = [jitter(), jitter(), 9.81 + jitter()];
    const mag = 0.15 + 0.1 * Math.abs(Math.sin(t * 3)) + Math.abs(jitter());
    this.sumSq += mag * mag;
    this.count++;
    if (mag > this.peak) this.peak = mag;
  }
}

export function round(n: number, d = 1) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
