import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cssMatrix3d, headingRad, readout, recenter, slerp, type Quat } from "../shared/quat";
import { FAULTS, profileOf, type Alert } from "../shared/types";
import { setDesired } from "./live";
import { Sparkline } from "./Sparkline";
import { statusOf, type DeviceStatus, type DeviceView } from "./store";

const ACT: Record<string, string> = { still: "🧍", walk: "🚶", active: "🏃" };

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
  const [enlarged, setEnlarged] = useState(false);
  const status = statusOf(d, now);
  const mine = alerts.filter((a) => a.deviceId === d.id && a.status === "ACTIVE");
  const prediction = mine.find((a) => a.type === "PREDICTED_OVERHEAT");
  const confirmed = mine.find((a) => a.type === "OVERHEAT" && a.predictedLeadSec);
  const fall = mine.find((a) => a.type === "FALL");
  const sos = mine.find((a) => a.type === "SOS");
  const emergency = fall ?? sos;
  // the cloud raises the warning; the countdown is re-estimated live from the newest readings
  const eta = prediction ? liveEta(d.hist) ?? Math.max(0, (prediction.etaSec ?? 0) - (now - prediction.ts) / 1000) : null;
  const meta = emergency ? { label: fall ? "FALL" : "SOS", tone: "fail" } : STATUS_META[status];
  const t = d.last;
  const profile = profileOf(d.profile);
  const fault = FAULTS.find((f) => f.key === t?.fault);
  const ago = d.lastAt ? Math.round((now - d.lastAt) / 1000) : null;
  const dead = status === "OFFLINE" || status === "SIGNAL_LOST" || status === "LEFT";
  const hasNoise = d.hist.some((h) => h.noise !== null);

  return (
    <article className={`card dev st-${status.toLowerCase()} tone-${meta.tone} ${emergency ? "emergency" : ""}`}>
      <header>
        <div className="dev-title">
          <span className="dev-ico">{profile?.icon ?? "📱"}</span>
          <div>
            <b>{d.id.replace("_", " ")}</b>
            <small>{d.owner ? `${d.owner} · ${profile?.label ?? d.profile}` : "no device yet"}</small>
          </div>
        </div>
        <span className={`pill ${meta.tone} ${status === "OK" && !emergency ? "live" : ""}`}>
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
          {emergency && (
            <div className="dev-emergency">
              <b>{fall ? "🚨 FALL DETECTED" : "🆘 SOS"}</b>
              <span>{emergency.message}</span>
              <small className="mono">{new Date(emergency.ts).toLocaleTimeString()} · detected on the phone, alert by the cloud</small>
            </div>
          )}
          <div className="dev-body">
            <OrientationTwin d={d} dead={dead} status={status} onOpen={() => setEnlarged(true)} />
            <div className="dev-metrics">
              <M label="Temp" value={t ? `${t.temp.toFixed(1)}°C` : "–"} hot={!!t && t.temp > 70} />
              <M label="Humidity" value={t ? `${t.hum.toFixed(0)}%` : "–"} />
              <M label="Battery" value={t ? `${t.bat}%${t.chg ? " ⚡" : ""}` : "–"} hot={!!t && t.bat < 10} />
              <M label="Voltage" value={t ? `${t.volt.toFixed(2)}V` : "–"} hot={!!t && t.volt > 6} />
              <M label={`Steps · ${ACT[t?.act ?? "still"]}`} value={t?.stepsDay !== undefined ? t.stepsDay.toLocaleString() : "–"} />
              <M label="Heart" value={d.hr ? `${d.hr.bpm} bpm` : "–"} hot={!!d.hr && (d.hr.bpm > 120 || d.hr.bpm < 45)} />
              <NoiseMeterCell db={t?.noise ?? null} />
            </div>
          </div>
          <div className={`dev-charts ${hasNoise ? "three" : ""}`}>
            <div>
              <span className="lbl">Vibration m/s²</span>
              <Sparkline values={d.hist.map((h) => h.vib)} color="#4cc9f0" min={0} max={20} threshold={15} />
            </div>
            <div>
              <span className="lbl">Temperature °C</span>
              <Sparkline values={d.hist.map((h) => h.temp)} color="#ff9f43" threshold={70} />
            </div>
            {hasNoise && (
              <div>
                <span className="lbl">Noise dB(A)</span>
                <Sparkline values={d.hist.map((h) => h.noise ?? 0)} color="#b388ff" min={30} max={110} threshold={85} />
              </div>
            )}
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
          {t?.bg && !dead && (
            <div className="dev-bg">🌙 Running in the background (screen off) · still streaming · motion &amp; fall detection paused by the browser</div>
          )}
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
            {d.loc && <span title="sharing GPS">📍 ±{Math.round(d.loc.acc)} m</span>}
            <span>{t?.sensors === "real" ? "REAL sensors" : "simulated"}</span>
          </footer>
        </>
      )}
      {status === "SIGNAL_LOST" && <div className="noise" />}
      {(status === "FAILED" || emergency) && <div className="scan" />}
      {enlarged &&
        createPortal(
          <div className="twin-overlay" onClick={() => setEnlarged(false)}>
            <div className="twin-card" onClick={(e) => e.stopPropagation()}>
              <h2>
                {profile?.icon} {d.id.replace("_", " ")} · {d.owner} <small>3D twin, about 1 s behind the real phone</small>
              </h2>
              <OrientationTwin d={d} dead={dead} status={status} big />
              <button className="etl-btn" onClick={() => setEnlarged(false)}>Close</button>
            </div>
          </div>,
          document.body,
        )}
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

/** Wide metric cell with a bar from 30 to 110 dB(A); the 85 dB(A) limit is marked. */
function NoiseMeterCell({ db }: { db: number | null }) {
  const pct = db === null ? 0 : Math.min(100, Math.max(0, ((db - 30) / 80) * 100));
  const tone = db === null ? "off" : db >= 85 ? "fail" : db >= 70 ? "warn" : "ok";
  return (
    <div className={`m wide noise-m t-${tone}`}>
      <span>Noise {db === null ? "(mic off)" : "approx. dB(A)"}</span>
      <b className="mono">{db === null ? "–" : db.toFixed(0)}</b>
      <div className="nbar">
        <i style={{ width: `${pct}%` }} />
        <em style={{ left: `${((85 - 30) / 80) * 100}%` }} title="85 dB(A) limit" />
      </div>
    </div>
  );
}

// Re-center reference (yaw) per device, kept across re-renders and the enlarged view.
const yawRefs = new Map<string, number>();

/**
 * 3D twin: plays the phone's timestamped orientation samples about 1.2 s after they were
 * measured, interpolating between neighbours with SLERP every frame. True angles - no
 * scaling, clamping or offsets; the viewing angle is a separate camera transform.
 */
function OrientationTwin({ d, dead, status, big, onOpen }: { d: DeviceView; dead: boolean; status: DeviceStatus; big?: boolean; onOpen?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const cur = useRef<Quat | null>(null);

  useEffect(() => {
    let raf = 0;
    let lastText = 0;
    const tick = (frame: number) => {
      const now = Date.now();
      const buf = d.pose;
      while (buf.length >= 2 && buf[1].t <= now) buf.shift(); // samples already passed
      let q: Quat | null = null;
      if (buf.length >= 2 && buf[0].t <= now) {
        const a = buf[0];
        const b = buf[1];
        q = slerp(a.q, b.q, (now - a.t) / Math.max(1, b.t - a.t));
      } else if (buf.length && (buf[0].t <= now || !cur.current)) {
        q = buf[0].q;
      }
      if (q) {
        cur.current = q;
        if (!yawRefs.has(d.id)) yawRefs.set(d.id, headingRad(q)); // first pose faces the viewer
        if (ref.current) ref.current.style.transform = cssMatrix3d(recenter(q, yawRefs.get(d.id)!));
        if (readRef.current && frame - lastText > 150) {
          lastText = frame;
          const o = readout(q); // raw angles: identical to the readout on the phone itself
          readRef.current.textContent = `F/B ${Math.round(o.frontBack)}° · L/R ${Math.round(o.leftRight)}° · H ${Math.round(o.heading)}°`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [d]);

  const recenterNow = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (cur.current) yawRefs.set(d.id, headingRad(cur.current));
  };

  return (
    <div className={`twin ${big ? "big" : ""}`}>
      <div className="tilt-stage" onClick={onOpen} title={onOpen ? "Click to enlarge" : undefined}>
        <div className="twin-cam">
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
        </div>
        <div className="shadow" />
      </div>
      <div className="twin-read">
        <span ref={readRef} className="mono">waiting for pose…</span>
        <button title="Make the phone's current direction face you" onClick={recenterNow}>⟲ Re-center</button>
      </div>
    </div>
  );
}

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
