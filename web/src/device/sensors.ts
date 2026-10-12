// Reads the phone's real sensors (motion, orientation, battery) and summarises them
// per publish window. Falls back to gentle simulated motion when the browser has no
// sensors (e.g. a laptop), so the pipeline can still be tested.
import { fromW3C, pack, type Quat } from "../shared/quat";

type Vec3 = [number, number, number];

export interface SensorWindow {
  vib: number; // RMS of dynamic acceleration (gravity removed), m/s²
  vibPeak: number;
  acc: Vec3; // latest acceleration including gravity
  qt0: number; // epoch ms of the first orientation sample
  q: number[][]; // [dtMs, w, x, y, z] orientation samples at 20 Hz
  bat: number | null;
  chg: boolean;
  real: boolean;
}

/** Every raw accelerometer sample (incl. gravity, m/s²) - used by the fall detector. */
export type MotionListener = (t: number, ax: number, ay: number, az: number) => void;

const ORIENTATION_HZ = 20;

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
  private quat: Quat = [1, 0, 0, 0];
  private qSamples: { t: number; q: Quat }[] = [];
  private gotMotion = false;
  private gotOrientation = false;
  private absolute = false; // receiving deviceorientationabsolute (compass-referenced, Android)
  private battery: { level: number; charging: boolean } | null = null;
  private sampler: number | undefined;
  private startedAt = 0;
  private motionListeners = new Set<MotionListener>();
  /** last time the phone moved noticeably (used as "activity" for auto-sleep) */
  lastMovement = Date.now();

  start() {
    this.startedAt = Date.now();
    window.addEventListener("devicemotion", this.onMotion);
    window.addEventListener("deviceorientation", this.onOrientation);
    window.addEventListener("deviceorientationabsolute" as any, this.onAbsolute);
    // Battery Status API: Chrome/Android only (not iPhone/Safari).
    (navigator as any).getBattery?.().then((b: any) => {
      const update = () => (this.battery = { level: Math.round(b.level * 100), charging: !!b.charging });
      update();
      b.addEventListener("levelchange", update);
      b.addEventListener("chargingchange", update);
    });
    // Sample the fused orientation at 20 Hz; the dashboard replays these with interpolation.
    this.sampler = window.setInterval(() => {
      if (!this.gotOrientation && Date.now() - this.startedAt > 2000) this.simulateMotion();
      this.qSamples.push({ t: Date.now(), q: this.quat });
      if (this.qSamples.length > 4 * ORIENTATION_HZ) this.qSamples.shift();
    }, 1000 / ORIENTATION_HZ);
  }

  stop() {
    window.removeEventListener("devicemotion", this.onMotion);
    window.removeEventListener("deviceorientation", this.onOrientation);
    window.removeEventListener("deviceorientationabsolute" as any, this.onAbsolute);
    clearInterval(this.sampler);
  }

  onMotionSample(fn: MotionListener) {
    this.motionListeners.add(fn);
    return () => this.motionListeners.delete(fn);
  }

  get isReal() {
    return this.gotMotion || this.gotOrientation;
  }

  /** current orientation (device -> world) for on-phone readouts */
  get liveQuat(): Quat {
    return this.quat;
  }

  /** Returns the summary since the previous call and resets the window. */
  takeWindow(): SensorWindow {
    const rms = this.count ? Math.sqrt(this.sumSq / this.count) : 0;
    const samples = this.qSamples.splice(0, this.qSamples.length);
    const qt0 = samples.length ? samples[0].t : Date.now();
    const w: SensorWindow = {
      vib: round(rms, 2),
      vibPeak: round(this.peak, 2),
      acc: this.acc.map((n) => round(n, 2)) as Vec3,
      qt0,
      q: samples.map((s) => pack(s.t - qt0, s.q)),
      bat: this.battery?.level ?? null,
      chg: this.battery?.charging ?? false,
      real: this.isReal,
    };
    this.sumSq = 0;
    this.count = 0;
    this.peak = 0;
    return w;
  }

  private onMotion = (e: DeviceMotionEvent) => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    this.gotMotion = true;
    this.acc = [g.x ?? 0, g.y ?? 0, g.z ?? 0];
    const now = performance.now();
    this.motionListeners.forEach((fn) => fn(now, this.acc[0], this.acc[1], this.acc[2]));
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

  // Android Chrome: absolute (compass-referenced) angles - steadier heading. Preferred when present.
  private onAbsolute = (e: DeviceOrientationEvent) => {
    if (e.beta == null && e.gamma == null) return;
    this.absolute = true;
    this.gotOrientation = true;
    this.quat = fromW3C(e.alpha ?? 0, e.beta ?? 0, e.gamma ?? 0);
  };

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta == null && e.gamma == null) return;
    if (this.absolute && !e.absolute) return; // the absolute stream already drives the pose
    this.gotOrientation = true;
    this.quat = fromW3C(e.alpha ?? 0, e.beta ?? 0, e.gamma ?? 0);
  };

  private simulateMotion() {
    const t = Date.now() / 1000;
    const jitter = () => (Math.random() - 0.5) * 0.1; // real sensors are never perfectly still
    this.quat = fromW3C((t * 12) % 360, 35 + 20 * Math.sin(t / 2), 15 * Math.sin(t / 3));
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
