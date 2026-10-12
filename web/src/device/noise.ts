// Privacy-preserving noise meter: the microphone signal is analysed ON THE PHONE and only
// numbers (sound level in approx. dB(A)) leave the device - never audio.
//
// Pipeline: getUserMedia -> Web Audio AnalyserNode (FFT) -> A-weighting per frequency bin
// -> power sum = level in dBFS(A) every 100 ms -> + calibration offset = approx. dB(A).
// Phone microphones are not calibrated instruments; the offset is set by comparing with a
// reference sound-level meter (or another phone app) once.

const CAL_KEY = "pulselake.noiseCalibration";
export const DEFAULT_CALIBRATION = 100; // dB added to dBFS; tuned against a reference meter

/** IEC 61672 A-weighting in dB for frequency f (Hz). */
function aWeighting(f: number): number {
  if (f <= 0) return -Infinity;
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 20 * Math.log10(ra) + 2.0;
}

export class NoiseMeter {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: number | undefined;
  private bins: Float32Array<ArrayBuffer> = new Float32Array(0);
  private weights: Float32Array<ArrayBuffer> = new Float32Array(0);
  private windowLevels: number[] = []; // 100 ms levels since the last takeSecond()
  level: number | null = null; // latest 100 ms level, approx. dB(A)
  calibration = readCalibration();

  get running() {
    return !!this.ctx;
  }

  /** Must be called from a user gesture (tap). Throws if permission is denied. */
  async start() {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    await this.ctx.resume();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser); // analysed only - never recorded, never sent
    this.bins = new Float32Array(this.analyser.frequencyBinCount);
    const hzPerBin = this.ctx.sampleRate / this.analyser.fftSize;
    this.weights = new Float32Array(this.bins.length);
    for (let i = 0; i < this.bins.length; i++) this.weights[i] = aWeighting(i * hzPerBin);
    this.timer = window.setInterval(this.measure, 100);
  }

  stop() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.level = null;
    this.windowLevels = [];
  }

  setCalibration(db: number) {
    this.calibration = db;
    try {
      localStorage.setItem(CAL_KEY, String(db));
    } catch {
      /* ignore */
    }
  }

  /** 1-second equivalent level (Leq) and the loudest 100 ms, then reset. */
  takeSecond(): { noise: number | null; noiseMax: number | null } {
    const levels = this.windowLevels.splice(0, this.windowLevels.length);
    if (!this.running || !levels.length) return { noise: null, noiseMax: null };
    const leq = 10 * Math.log10(levels.reduce((s, l) => s + 10 ** (l / 10), 0) / levels.length);
    return { noise: round1(leq), noiseMax: round1(Math.max(...levels)) };
  }

  private measure = () => {
    if (!this.analyser) return;
    this.analyser.getFloatFrequencyData(this.bins);
    let power = 0;
    for (let i = 1; i < this.bins.length; i++) {
      const db = this.bins[i] + this.weights[i];
      if (Number.isFinite(db)) power += 10 ** (db / 10);
    }
    const level = power > 0 ? 10 * Math.log10(power) + this.calibration : 0;
    this.level = round1(Math.max(0, level));
    this.windowLevels.push(this.level);
    if (this.windowLevels.length > 50) this.windowLevels.shift();
  };
}

/** Rough guide for the UI (NIOSH recommends limiting exposure above 85 dB(A)). */
export function noiseBand(db: number | null): { label: string; tone: "ok" | "warn" | "fail" | "off" } {
  if (db === null) return { label: "off", tone: "off" };
  if (db < 55) return { label: "quiet", tone: "ok" };
  if (db < 70) return { label: "moderate", tone: "ok" };
  if (db < 85) return { label: "loud", tone: "warn" };
  return { label: "harmful", tone: "fail" };
}

function readCalibration(): number {
  try {
    const v = Number(localStorage.getItem(CAL_KEY));
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_CALIBRATION;
  } catch {
    return DEFAULT_CALIBRATION;
  }
}
function round1(n: number) {
  return Math.round(n * 10) / 10;
}
