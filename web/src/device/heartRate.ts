// Camera heart-rate check (photoplethysmography, PPG) - approximate, not a medical device.
//
// A fingertip pressed on the rear camera with the flash on glows red. Each heartbeat pushes
// a little more blood into the fingertip, which absorbs a little more light, so the average
// red brightness of the video pulses with the heart. We sample that brightness ~30 times a
// second for 20 s and find the dominant period with autocorrelation (40-200 bpm).
// Only the resulting number leaves the phone; the video is never stored or sent.

export interface HrSample {
  t: number; // ms
  v: number; // mean red brightness
}

export interface HrResult {
  bpm: number;
  quality: number; // 0-1 (autocorrelation strength)
}

export interface HrProgress {
  phase: "starting" | "no-finger" | "measuring";
  seconds: number; // seconds of good signal collected
  total: number;
  wave: number[]; // recent detrended samples for the UI
  torch: boolean;
}

const FS = 30; // Hz after resampling

/** Pure signal processing: estimate BPM from brightness samples. Null if the signal is too weak. */
export function estimateBpm(samples: HrSample[]): HrResult | null {
  if (samples.length < FS * 6) return null;
  // 1. resample onto an even 30 Hz grid (camera frames are not perfectly regular)
  const t0 = samples[0].t + 2000; // skip 2 s: auto-exposure settles
  const t1 = samples[samples.length - 1].t;
  const xs: number[] = [];
  let j = 0;
  for (let t = t0; t <= t1; t += 1000 / FS) {
    while (j < samples.length - 2 && samples[j + 1].t < t) j++;
    const a = samples[j];
    const b = samples[j + 1];
    const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
    xs.push(a.v + (b.v - a.v) * Math.min(1, Math.max(0, k)));
  }
  if (xs.length < FS * 5) return null;
  // 2. remove slow drift (1 s moving average) and smooth (3 samples)
  const detrended = movingAvg(xs.map((x, i) => x - windowMean(xs, i, FS / 2)), 1);
  // 3. normalised autocorrelation for lags between 200 bpm and 40 bpm
  const n = detrended.length;
  const mean = detrended.reduce((s, x) => s + x, 0) / n;
  const c = detrended.map((x) => x - mean);
  const energy = c.reduce((s, x) => s + x * x, 0);
  if (!energy) return null;
  const minLag = Math.floor((FS * 60) / 200);
  const maxLag = Math.ceil((FS * 60) / 40);
  const r: number[] = [];
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += c[i] * c[i + lag];
    r.push(s / energy);
  }
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag] > r[lag - 1] && r[lag] >= r[lag + 1] && (best < 0 || r[lag] > r[best])) best = lag;
  }
  if (best < 0) return null;
  // parabolic interpolation around the peak for sub-sample precision
  const y0 = r[best - 1];
  const y1 = r[best];
  const y2 = r[best + 1];
  const shift = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
  const period = (best + Math.max(-0.5, Math.min(0.5, shift))) / FS;
  return { bpm: Math.round(60 / period), quality: Math.round(Math.max(0, y1) * 100) / 100 };
}

function windowMean(xs: number[], i: number, half: number) {
  const a = Math.max(0, i - Math.floor(half));
  const b = Math.min(xs.length - 1, i + Math.floor(half));
  let s = 0;
  for (let k = a; k <= b; k++) s += xs[k];
  return s / (b - a + 1);
}
function movingAvg(xs: number[], half: number) {
  return xs.map((_, i) => windowMean(xs, i, half));
}

/** Runs the camera, waits for a finger, measures for `seconds`, then stops the camera. */
export async function measureHeartRate(
  video: HTMLVideoElement,
  onProgress: (p: HrProgress) => void,
  signal: AbortSignal,
  seconds = 20,
): Promise<HrResult> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot open the camera");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } },
  });
  const track = stream.getVideoTracks()[0];
  let torch = false;
  try {
    const caps: any = track.getCapabilities?.() ?? {};
    if (caps.torch) {
      await track.applyConstraints({ advanced: [{ torch: true } as any] });
      torch = true;
    }
  } catch {
    /* no flash control (e.g. iPhone) - works in bright light only */
  }
  const stop = () => stream.getTracks().forEach((t) => t.stop());
  try {
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    let samples: HrSample[] = [];
    let lostAt = 0;
    onProgress({ phase: "starting", seconds: 0, total: seconds, wave: [], torch });

    return await new Promise<HrResult>((resolve, reject) => {
      const abort = () => reject(new DOMException("cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      const frame = () => {
        if (signal.aborted) return;
        ctx.drawImage(video, 0, 0, 40, 30);
        const px = ctx.getImageData(10, 7, 20, 16).data; // centre of the image
        let r = 0;
        let g = 0;
        for (let i = 0; i < px.length; i += 4) {
          r += px[i];
          g += px[i + 1];
        }
        const count = px.length / 4;
        r /= count;
        g /= count;
        const now = performance.now();
        const finger = r > 60 && r > g * 1.4; // a lit fingertip is strongly red
        if (!finger) {
          if (!lostAt) lostAt = now;
          if (now - lostAt > 800) samples = []; // finger removed: start over
          onProgress({ phase: "no-finger", seconds: 0, total: seconds, wave: [], torch });
        } else {
          lostAt = 0;
          samples.push({ t: now, v: r });
          const got = (now - samples[0].t) / 1000;
          const recent = samples.slice(-90).map((s) => s.v);
          const m = recent.reduce((a, b) => a + b, 0) / recent.length;
          onProgress({ phase: "measuring", seconds: Math.min(seconds, got), total: seconds, wave: recent.map((v) => m - v), torch });
          if (got >= seconds) {
            const res = estimateBpm(samples);
            signal.removeEventListener("abort", abort);
            if (!res || res.quality < 0.3) {
              reject(new Error("Signal too weak. Cover the camera AND the flash with your fingertip, keep still, and try again."));
            } else if (res.bpm < 40 || res.bpm > 200) {
              reject(new Error("Could not find a steady pulse. Try again, pressing lightly."));
            } else resolve(res);
            return;
          }
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  } finally {
    stop();
    video.srcObject = null;
  }
}
