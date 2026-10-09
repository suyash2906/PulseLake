import { memo, useEffect, useRef } from "react";
import { FAULTS, PROFILES, type Alert } from "../shared/types";
import { setDesired } from "./live";
import { Sparkline } from "./Sparkline";
import { statusOf, type DeviceStatus, type DeviceView } from "./store";

const STATUS_META: Record<DeviceStatus, { label: string; tone: string }> = {
  WAITING: { label: "WAITING", tone: "off" },
  OK: { label: "HEALTHY", tone: "ok" },
  WARNING: { label: "WARNING", tone: "warn" },
  FAILED: { label: "FAILED", tone: "fail" },
  SIGNAL_LOST: { label: "SIGNAL LOST", tone: "warn" },
  OFFLINE: { label: "OFFLINE", tone: "fail" },
  LEFT: { label: "DISCONNECTED", tone: "off" },
};

export const DeviceCard = memo(function DeviceCard({ d, now, joinUrl, alerts }: { d: DeviceView; now: number; joinUrl: string; alerts: Alert[] }) {
  const status = statusOf(d, now);
  const prediction = alerts.find((a) => a.deviceId === d.id && a.type === "PREDICTED_OVERHEAT" && a.status === "ACTIVE");
  const confirmed = alerts.find((a) => a.deviceId === d.id && a.type === "OVERHEAT" && a.status === "ACTIVE" && a.predictedLeadSec);
  // the cloud raises the warning; the countdown is re-estimated live from the newest readings
  const eta = prediction ? liveEta(d.hist) ?? Math.max(0, (prediction.etaSec ?? 0) - (now - prediction.ts) / 1000) : null;
  const meta = STATUS_META[status];
  const t = d.last;
  const profile = PROFILES.find((p) => p.key === d.profile);
  const fault = FAULTS.find((f) => f.key === t?.fault);
  const ago = d.lastAt ? Math.round((now - d.lastAt) / 1000) : null;
  const dead = status === "OFFLINE" || status === "SIGNAL_LOST" || status === "LEFT";

  return (
    <article className={`card dev st-${status.toLowerCase()} tone-${meta.tone}`}>
      <header>
        <div className="dev-title">
          <span className="dev-ico">{profile?.icon ?? "📱"}</span>
          <div>
            <b>{d.id.replace("_", " ")}</b>
            <small>{d.owner ? `${d.owner} · ${profile?.label ?? d.profile}` : "no device yet"}</small>
          </div>
        </div>
        <span className={`pill ${meta.tone} ${status === "OK" ? "live" : ""}`}>
          <span className="dot" />
          {meta.label}
        </span>
      </header>

      {status === "WAITING" ? (
        <div className="dev-empty">
          <div className="radar" />
          <p>
            Open <span className="mono">{joinUrl}</span> on a phone and pick <b>{d.id.replace("_", " ")}</b>
          </p>
        </div>
      ) : (
        <>
          <div className="dev-body">
            <Tilt d={d} dead={dead} status={status} />
            <div className="dev-metrics">
              <M label="Temp" value={t ? `${t.temp.toFixed(1)}°C` : "–"} hot={!!t && t.temp > 70} />
              <M label="Humidity" value={t ? `${t.hum.toFixed(0)}%` : "–"} />
              <M label="Battery" value={t ? `${t.bat}%${t.chg ? " ⚡" : ""}` : "–"} hot={!!t && t.bat < 10} />
              <M label="Voltage" value={t ? `${t.volt.toFixed(2)}V` : "–"} hot={!!t && t.volt > 6} />
            </div>
          </div>
          <div className="dev-charts">
            <div>
              <span className="lbl">Vibration m/s²</span>
              <Sparkline values={d.hist.map((h) => h.vib)} color="#4cc9f0" min={0} max={20} threshold={15} />
            </div>
            <div>
              <span className="lbl">Temperature °C</span>
              <Sparkline values={d.hist.map((h) => h.temp)} color="#ff9f43" threshold={70} />
            </div>
          </div>
          {eta !== null && !dead && (
            <div className="dev-predict">
              <span>🔮 Cloud predicts <b>OVERHEAT</b> in</span>
              <b className="mono">{Math.round(eta)} s</b>
              <div className="pbar"><i style={{ width: `${Math.max(4, 100 - (eta / 60) * 100)}%` }} /></div>
            </div>
          )}
          {confirmed && !dead && (
            <div className="dev-fault sev-warning">🔮 Prediction confirmed - the cloud warned {Math.round(confirmed.predictedLeadSec!)} s before it happened</div>
          )}
          {fault && !dead && (
            <div className={`dev-fault sev-${fault.severity.toLowerCase()}`}>
              {fault.icon} Injected fault: <b>{fault.label}</b>
            </div>
          )}
          {status === "OFFLINE" && <div className="dev-fault sev-failed">☁️ AWS IoT: {d.presenceReason ?? "disconnected"}</div>}
          {!dead && t && (
            <div className="dev-ctl">
              <button title="Phone flashes, vibrates and beeps" onClick={() => setDesired(d.id, { locate: Date.now() })}>📍 Locate</button>
              <button disabled={t.fault === "NONE"} title="Clear the injected fault remotely" onClick={() => setDesired(d.id, { fault: "NONE" })}>
                🛠 Remote reset
              </button>
              <div className="seg" title="Telemetry rate (messages per second)">
                {[1, 2, 4].map((r) => (
                  <button key={r} className={t.rate === r ? "on" : ""} onClick={() => setDesired(d.id, { rate: r })}>
                    {r} Hz
                  </button>
                ))}
              </div>
            </div>
          )}
          <footer>
            <span>{ago === null ? "" : ago < 2 ? "live" : `${ago}s ago`}</span>
            <span>{d.latencyMs !== undefined ? `${d.latencyMs} ms` : ""}</span>
            <span>#{t?.seq ?? 0}</span>
            <span>{t?.sensors === "real" ? "REAL sensors" : "simulated"}</span>
          </footer>
        </>
      )}
      {status === "SIGNAL_LOST" && <div className="noise" />}
      {status === "FAILED" && <div className="scan" />}
    </article>
  );
});

function M({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return (
    <div className={`m ${hot ? "hot" : ""}`}>
      <span>{label}</span>
      <b className="mono">{value}</b>
    </div>
  );
}

/** CSS-3D phone that replays the batched orientation samples smoothly. */
function Tilt({ d, dead, status }: { d: DeviceView; dead: boolean; status: DeviceStatus }) {
  const ref = useRef<HTMLDivElement>(null);
  const cur = useRef({ beta: 0, gamma: 0 });
  useEffect(() => {
    let raf = 0;
    let lastPop = 0;
    const tick = (t: number) => {
      // pop one sample every 100 ms (samples were captured at 10 Hz)
      if (t - lastPop > 100 && d.ori.length > 3) {
        lastPop = t;
        const s = d.ori.shift();
        if (s) {
          cur.current.beta += (clamp(s[1]) - cur.current.beta) * 0.5;
          cur.current.gamma += (clamp(s[2]) - cur.current.gamma) * 0.5;
        }
      }
      if (ref.current) {
        // small base angle so the phone's thickness is visible even when it lies flat
        ref.current.style.transform = `rotateX(${10 + cur.current.beta * 0.6}deg) rotateY(${-18 + cur.current.gamma * 0.8}deg)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [d]);
  return (
    <div className="tilt-stage">
      <div ref={ref} className={`phone3d ${dead ? "dead" : ""} ps-${status.toLowerCase()}`}>
        {/* six faces = a phone with real thickness */}
        <div className="face back"><span className="cam" /></div>
        <div className="face side right" />
        <div className="face side left" />
        <div className="face edge top" />
        <div className="face edge bottom" />
        <div className="face front">
          <div className="screen">
            <div className="notch" />
            <div className="pulse" />
            <div className="glare" />
          </div>
        </div>
      </div>
      <div className="shadow" />
    </div>
  );
}

const clamp = (n: number) => Math.max(-80, Math.min(80, n));

/** Seconds until 70 °C from a least-squares trend over the last ~15 readings (null if not rising). */
function liveEta(hist: DeviceView["hist"]): number | null {
  const pts = hist.slice(-15);
  if (pts.length < 4) return null;
  const t0 = pts[0].t;
  const xs = pts.map((p) => (p.t - t0) / 1000);
  const ys = pts.map((p) => p.temp);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i] - my);
    sxx += (x - mx) ** 2;
  });
  if (!sxx) return null;
  const slope = sxy / sxx;
  const latest = ys[ys.length - 1];
  if (slope <= 0.05 || latest >= 70) return null;
  return (70 - latest) / slope;
}
