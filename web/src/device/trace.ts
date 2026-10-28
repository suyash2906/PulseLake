// Records raw accelerometer windows around "fall candidates" (free fall or a hard impact),
// 3 s before to 6.5 s after the trigger. They go to the data lake (bronze/traces) where the
// Accuracy Lab labels them and re-runs the fall detector with different thresholds.
// Rate-limited so normal walking cannot flood the lake.

export interface Trace {
  traceId: string;
  t0: number; // wall-clock ms of the first sample
  trigger: "freefall" | "impact";
  peakG: number;
  minG: number;
  samples: number[][]; // [dtMs, ax, ay, az] (m/s², incl. gravity)
}

const G = 9.81;
const BEFORE_MS = 3000;
const AFTER_MS = 6500;
const MIN_GAP_MS = 10_000;
const MAX_PER_HOUR = 30;

export class TraceRecorder {
  private ring: number[][] = []; // [tPerf, ax, ay, az]
  private capture: { trigger: Trace["trigger"]; at: number; until: number } | null = null;
  private lowSince = 0;
  private lastAt = -Infinity;
  private recent: number[] = [];
  enabled = true;
  private onTrace: (t: Trace) => void;

  constructor(onTrace: (t: Trace) => void) {
    this.onTrace = onTrace;
  }

  feed(t: number, ax: number, ay: number, az: number) {
    if (!this.enabled) return;
    this.ring.push([t, ax, ay, az]);
    const g = Math.hypot(ax, ay, az) / G;
    if (this.capture) {
      if (t >= this.capture.until) this.emit(t);
      return;
    }
    while (this.ring.length && t - this.ring[0][0] > BEFORE_MS) this.ring.shift();
    if (g <= 0.5) this.lowSince ||= t;
    else this.lowSince = 0;
    const trigger = this.lowSince && t - this.lowSince >= 40 ? "freefall" : g >= 2.2 ? "impact" : null;
    if (!trigger || t - this.lastAt < MIN_GAP_MS) return;
    this.recent = this.recent.filter((x) => t - x < 3_600_000);
    if (this.recent.length >= MAX_PER_HOUR) return;
    this.capture = { trigger, at: t, until: t + AFTER_MS };
    this.lastAt = t;
    this.recent.push(t);
  }

  private emit(now: number) {
    const rows = this.ring;
    const cap = this.capture!;
    this.capture = null;
    this.ring = [];
    this.lowSince = 0;
    if (rows.length < 30) return;
    const t0 = rows[0][0];
    let peak = 0;
    let min = Infinity;
    const samples = rows.map(([t, x, y, z]) => {
      const g = Math.hypot(x, y, z) / G;
      peak = Math.max(peak, g);
      min = Math.min(min, g);
      return [Math.round(t - t0), r2(x), r2(y), r2(z)];
    });
    this.onTrace({
      traceId: Math.random().toString(36).slice(2, 10),
      t0: Date.now() - (now - t0),
      trigger: cap.trigger,
      peakG: r2(peak),
      minG: r2(min),
      samples,
    });
  }
}

function r2(n: number) {
  return Math.round(n * 100) / 100;
}
