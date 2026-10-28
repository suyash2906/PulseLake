// Edge fall detection: the three-phase model used in smartphone fall-detection studies.
//   1. FREE FALL  - total acceleration drops close to 0 g (the phone is falling with the body)
//   2. IMPACT     - a sharp spike shortly after the free fall
//   3. STILLNESS  - little movement afterwards (a person who fell often lies still)
// The orientation change before vs after is reported too (a fall usually ends lying down).
// It runs on the phone at ~60 Hz because the cloud only receives 1 summary per second.
//
// v2: thresholds are per instance (the cloud pushes tuned values through the Device Shadow),
// every detection carries a 0-100 confidence score, and the SAME class is re-run in the
// cloud over recorded traces (Accuracy Lab) to measure sensitivity and false alarms.

export interface FallThresholds {
  freeFallG: number; // |a| at or below this = weightless
  freeFallMinMs: number; // must last at least this long
  impactG: number; // |a| at or above this = impact
  impactWindowMs: number; // impact must follow the free fall within this time
  settleMs: number; // ignore bounces right after impact
  stillWindowMs: number; // then this long with...
  stillStdG: number; // ...this little variation counts as "still"
  giveUpMs: number; // no stillness within this time = the person is moving, not a fall
}

export const FALL_THRESHOLDS: FallThresholds = {
  freeFallG: 0.4,
  freeFallMinMs: 80,
  impactG: 2.0,
  impactWindowMs: 1000,
  settleMs: 300,
  stillWindowMs: 2000,
  stillStdG: 0.15,
  giveUpMs: 6000,
};

/** The values the cloud may tune (Accuracy Lab grid). */
export const TUNABLE: (keyof FallThresholds)[] = ["freeFallG", "freeFallMinMs", "impactG", "stillStdG"];

export interface FallEventInfo {
  impactG: number;
  freeFallMs: number;
  angleChange: number; // degrees between gravity direction before and after
  confidence: number; // 0-100
  stillSd?: number;
  bang?: boolean; // a loud sound at the moment of impact (microphone on)
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
  th: FallThresholds;
  private onFall: (info: FallEventInfo) => void;
  /** optional: did the microphone hear a bang near time t (same clock as feed)? */
  bangNear: (t: number) => boolean = () => false;

  constructor(onFall: (info: FallEventInfo) => void, thresholds: Partial<FallThresholds> = {}) {
    this.onFall = onFall;
    this.th = { ...FALL_THRESHOLDS, ...thresholds };
  }

  setThresholds(t: Partial<FallThresholds>) {
    const clean: Partial<FallThresholds> = {};
    for (const k of Object.keys(FALL_THRESHOLDS) as (keyof FallThresholds)[]) {
      const v = Number((t as any)[k]);
      if (Number.isFinite(v) && v > 0) clean[k] = v;
    }
    this.th = { ...this.th, ...clean };
  }

  /** Feed one accelerometer sample (including gravity, m/s²); t in ms. */
  feed(t: number, ax: number, ay: number, az: number) {
    if (!this.enabled) return;
    const th = this.th;
    const mag = Math.hypot(ax, ay, az);
    const g = mag / G;
    const dir: Vec3 = mag > 0.5 ? [ax / mag, ay / mag, az / mag] : this.before;

    switch (this.phase) {
      case "IDLE":
        // remember which way gravity points while things are calm (the "before" posture)
        if (g > 0.8 && g < 1.2) this.before = lerp(this.before, dir, 0.05);
        if (g <= th.freeFallG) {
          this.phase = "FREE_FALL";
          this.freeFallStart = t;
        }
        break;

      case "FREE_FALL":
        if (g <= th.freeFallG) break;
        this.freeFallMs = t - this.freeFallStart;
        if (this.freeFallMs >= th.freeFallMinMs) {
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
        if (t - this.impactAt < th.settleMs) {
          this.impactG = Math.max(this.impactG, g);
          break;
        }
        this.still.push({ t, g, dir });
        while (this.still.length && t - this.still[0].t > th.stillWindowMs) this.still.shift();
        const span = this.still.length ? t - this.still[0].t : 0;
        if (span >= th.stillWindowMs * 0.95) {
          const mean = this.still.reduce((s, x) => s + x.g, 0) / this.still.length;
          const sd = Math.sqrt(this.still.reduce((s, x) => s + (x.g - mean) ** 2, 0) / this.still.length);
          if (sd <= th.stillStdG) {
            const after = normalize(this.still.reduce<Vec3>((s, x) => [s[0] + x.dir[0], s[1] + x.dir[1], s[2] + x.dir[2]], [0, 0, 0]));
            const angle = (Math.acos(Math.max(-1, Math.min(1, dot(this.before, after)))) * 180) / Math.PI;
            const bang = this.bangNear(this.impactAt);
            const info: FallEventInfo = {
              impactG: round1(this.impactG),
              freeFallMs: Math.round(this.freeFallMs),
              angleChange: Math.round(angle),
              stillSd: Math.round(sd * 1000) / 1000,
              bang,
              confidence: 0,
            };
            info.confidence = confidenceOf(info, th);
            this.reset();
            this.onFall(info);
            return;
          }
        }
        if (t - this.impactAt > th.giveUpMs) this.reset(); // still moving: not a fall
        break;
      }
    }
  }

  private check(t: number, g: number) {
    if (g >= this.th.impactG) {
      this.phase = "AWAIT_STILL";
      this.impactAt = t;
      this.impactG = g;
      this.still = [];
    } else if (t - this.freeFallStart - this.freeFallMs > this.th.impactWindowMs) {
      this.phase = "IDLE";
    }
  }

  private reset() {
    this.phase = "IDLE";
    this.still = [];
  }
}

/**
 * Evidence score 0-100: how strongly each phase was seen.
 * free fall 25 + impact 25 + posture change 20 + stillness 20 + loud bang 10.
 */
export function confidenceOf(i: FallEventInfo, th: FallThresholds = FALL_THRESHOLDS): number {
  const ff = Math.min(1, i.freeFallMs / 250);
  const imp = Math.min(1, Math.max(0, (i.impactG - 1.5) / 2));
  const ang = Math.min(1, i.angleChange / 60);
  const still = i.stillSd === undefined ? 0.5 : 1 - Math.min(1, i.stillSd / Math.max(0.01, th.stillStdG));
  return Math.round(25 * ff + 25 * imp + 20 * ang + 20 * still + (i.bang ? 10 : 0));
}

/**
 * Re-run the detector over a recorded trace ([dtMs, ax, ay, az] rows). Used by the Accuracy Lab.
 * Traces cover 3 s before and 6.5 s after the trigger, longer than giveUpMs, so the replay sees
 * exactly what the phone saw.
 */
export function replayTrace(samples: number[][], thresholds: Partial<FallThresholds> = {}): FallEventInfo | null {
  let hit: FallEventInfo | null = null;
  const d = new FallDetector((info) => {
    hit ??= info;
  }, thresholds);
  for (const s of samples) d.feed(s[0], s[1], s[2], s[3]);
  return hit;
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
