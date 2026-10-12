// Edge fall detection: the three-phase model used in smartphone fall-detection studies.
//   1. FREE FALL  - total acceleration drops close to 0 g (the phone is falling with the body)
//   2. IMPACT     - a sharp spike shortly after the free fall
//   3. STILLNESS  - little movement afterwards (a person who fell often lies still)
// The orientation change before vs after is reported too (a fall usually ends lying down).
// It runs on the phone at ~60 Hz because the cloud only receives 1 summary per second.
// Thresholds vary between published studies; these are starting values, tuned on real drops.

export const FALL_THRESHOLDS = {
  freeFallG: 0.4, // |a| at or below this = weightless
  freeFallMinMs: 80, // must last at least this long
  impactG: 2.0, // |a| at or above this = impact
  impactWindowMs: 1000, // impact must follow the free fall within this time
  settleMs: 300, // ignore bounces right after impact
  stillWindowMs: 2000, // then this long with...
  stillStdG: 0.15, // ...this little variation counts as "still"
  giveUpMs: 6000, // no stillness within this time = the person is moving, not a fall
};

export interface FallEventInfo {
  impactG: number;
  freeFallMs: number;
  angleChange: number; // degrees between gravity direction before and after
}

type Phase = "IDLE" | "FREE_FALL" | "AWAIT_IMPACT" | "AWAIT_STILL";
type Vec3 = [number, number, number];

const G = 9.81;

export class FallDetector {
  private phase: Phase = "IDLE";
  private freeFallStart = 0;
  private freeFallMs = 0;
  private impactAt = 0;
  private impactG = 0;
  private before: Vec3 = [0, 0, 1]; // smoothed gravity direction while normal
  private still: { t: number; g: number; dir: Vec3 }[] = [];
  enabled = true;
  private onFall: (info: FallEventInfo) => void;

  constructor(onFall: (info: FallEventInfo) => void) {
    this.onFall = onFall;
  }

  /** Feed one accelerometer sample (including gravity, m/s²); t in ms. */
  feed(t: number, ax: number, ay: number, az: number) {
    if (!this.enabled) return;
    const mag = Math.hypot(ax, ay, az);
    const g = mag / G;
    const dir: Vec3 = mag > 0.5 ? [ax / mag, ay / mag, az / mag] : this.before;

    switch (this.phase) {
      case "IDLE":
        // remember which way gravity points while things are calm (the "before" posture)
        if (g > 0.8 && g < 1.2) this.before = lerp(this.before, dir, 0.05);
        if (g <= FALL_THRESHOLDS.freeFallG) {
          this.phase = "FREE_FALL";
          this.freeFallStart = t;
        }
        break;

      case "FREE_FALL":
        if (g <= FALL_THRESHOLDS.freeFallG) break;
        this.freeFallMs = t - this.freeFallStart;
        if (this.freeFallMs >= FALL_THRESHOLDS.freeFallMinMs) {
          this.phase = "AWAIT_IMPACT";
          this.impactG = 0;
          this.check(t, g); // this very sample may already be the impact
        } else {
          this.phase = "IDLE";
        }
        break;

      case "AWAIT_IMPACT":
        this.check(t, g);
        break;

      case "AWAIT_STILL": {
        if (t - this.impactAt < FALL_THRESHOLDS.settleMs) {
          this.impactG = Math.max(this.impactG, g);
          break;
        }
        this.still.push({ t, g, dir });
        while (this.still.length && t - this.still[0].t > FALL_THRESHOLDS.stillWindowMs) this.still.shift();
        const span = this.still.length ? t - this.still[0].t : 0;
        if (span >= FALL_THRESHOLDS.stillWindowMs * 0.95) {
          const mean = this.still.reduce((s, x) => s + x.g, 0) / this.still.length;
          const sd = Math.sqrt(this.still.reduce((s, x) => s + (x.g - mean) ** 2, 0) / this.still.length);
          if (sd <= FALL_THRESHOLDS.stillStdG) {
            const after = normalize(this.still.reduce<Vec3>((s, x) => [s[0] + x.dir[0], s[1] + x.dir[1], s[2] + x.dir[2]], [0, 0, 0]));
            const angle = (Math.acos(Math.max(-1, Math.min(1, dot(this.before, after)))) * 180) / Math.PI;
            const info = { impactG: round1(this.impactG), freeFallMs: Math.round(this.freeFallMs), angleChange: Math.round(angle) };
            this.reset();
            this.onFall(info);
            return;
          }
        }
        if (t - this.impactAt > FALL_THRESHOLDS.giveUpMs) this.reset(); // still moving: not a fall
        break;
      }
    }
  }

  private check(t: number, g: number) {
    if (g >= FALL_THRESHOLDS.impactG) {
      this.phase = "AWAIT_STILL";
      this.impactAt = t;
      this.impactG = g;
      this.still = [];
    } else if (t - this.freeFallStart - this.freeFallMs > FALL_THRESHOLDS.impactWindowMs) {
      this.phase = "IDLE";
    }
  }

  private reset() {
    this.phase = "IDLE";
    this.still = [];
  }
}

function lerp(a: Vec3, b: Vec3, k: number): Vec3 {
  return normalize([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
}
function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(...v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function round1(n: number) {
  return Math.round(n * 10) / 10;
}
