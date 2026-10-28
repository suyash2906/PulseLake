// Accuracy Lab: measure the fall detector instead of claiming it works.
// Traces recorded by the phones (bronze/traces) are labelled here; a Lambda re-runs the phones'
// own detector over them for 300 threshold settings; the best one can be pushed to every phone
// over the air (AWS IoT Device Shadow).
import { useEffect, useMemo, useState } from "react";
import { SLOTS } from "../shared/types";
import { api, type LabResult, type LabScore, type TraceInfo } from "./api";
import { setDesired } from "./live";

const LABELS: { key: string; label: string; positive?: boolean }[] = [
  { key: "fall", label: "🤕 Fall (test)", positive: true },
  { key: "dropped", label: "📱 Phone dropped" },
  { key: "sat", label: "🪑 Sat down hard" },
  { key: "walk", label: "🚶 Walking / stairs" },
  { key: "jump", label: "🦘 Jump" },
  { key: "other", label: "Other" },
  { key: "ignore", label: "Ignore" },
];

export function AccuracyLab() {
  const [traces, setTraces] = useState<TraceInfo[]>([]);
  const [result, setResult] = useState<LabResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [applied, setApplied] = useState("");

  const load = () => api.labTraces().then(setTraces).catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    api.labResult().then((r) => r.at && setResult(r)).catch(() => {});
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    traces.forEach((t) => (c[t.label ?? "unlabelled"] = (c[t.label ?? "unlabelled"] ?? 0) + 1));
    return c;
  }, [traces]);

  const label = async (t: TraceInfo, l: string) => {
    setTraces((list) => list.map((x) => (x.key === t.key ? { ...x, label: l } : x)));
    await api.labLabel(t.key, l).catch((e) => setError(e.message));
  };
  const runLab = async () => {
    setRunning(true);
    setError("");
    try {
      const r = await api.labRun();
      if (r.error) setError(r.error);
      else setResult(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };
  const apply = (s: LabScore) => {
    const version = `lab ${new Date().toLocaleDateString()} · F1 ${s.f1}`;
    SLOTS.forEach((id) => setDesired(id, { fall: s.thresholds, fallVersion: version }));
    setApplied(`Pushed to ${SLOTS.length} phones via Device Shadow: ${fmtTh(s.thresholds)}`);
  };

  const droppedCaught = result?.currentPerTrace?.filter((t) => t.label === "dropped" && t.detected).length ?? 0;

  return (
    <section className="card lab">
      <h3>
        Accuracy Lab <small>is the fall detector right? measured on labelled recordings from the data lake</small>
      </h3>
      <ol className="lab-steps">
        <li><b>Record</b> - drop a phone onto a pillow (simulated fall), sit down hard, walk, jump. Each candidate uploads a 9.5 s trace.</li>
        <li><b>Label</b> - tell the lab what really happened.</li>
        <li><b>Evaluate</b> - a Lambda re-runs the phones' own detector code for 300 threshold settings.</li>
        <li><b>Apply</b> - push the best setting to every phone over the air.</li>
      </ol>

      <div className="lab-counts">
        {[...LABELS.filter((l) => l.key !== "ignore"), { key: "unlabelled", label: "❔ Unlabelled" }].map((l) => (
          <span key={l.key} className={counts[l.key] ? "" : "zero"}>
            {l.label} <b className="mono">{counts[l.key] ?? 0}</b>
          </span>
        ))}
        <button className="etl-btn primary" disabled={running} onClick={runLab}>
          {running ? <><span className="spinner" /> Evaluating…</> : "🎯 Evaluate detector"}
        </button>
      </div>
      {error && <div className="qerr">{error}</div>}

      {result?.current && (
        <div className="lab-result">
          <div className="confusion">
            <h4>Current phone settings <small>{fmtTh(result.current.thresholds)}</small></h4>
            <div className="cm">
              <span />
              <b>alarm</b>
              <b>no alarm</b>
              <b>real fall</b>
              <span className="tp mono">{result.current.tp}</span>
              <span className="fn mono">{result.current.fn}</span>
              <b>not a fall</b>
              <span className="fp mono">{result.current.fp}</span>
              <span className="tn mono">{result.current.tn}</span>
            </div>
            <Meter label="Sensitivity (falls caught)" v={result.current.sensitivity} />
            <Meter label="Specificity (non-falls ignored)" v={result.current.specificity} />
            <small>{result.traces} traces · {result.configsTested} settings tested in {result.ms} ms · {result.at ? new Date(result.at).toLocaleTimeString() : ""}</small>
            {droppedCaught > 0 && (
              <p className="lab-insight">
                💡 {droppedCaught} "phone dropped" trace{droppedCaught === 1 ? " looks" : "s look"} exactly like a fall to the accelerometer. The phone alone cannot tell them apart - that is
                why the person gets 15 s to answer "Are you OK?" before anyone is alerted.
              </p>
            )}
          </div>
          <div className="best">
            <h4>Best settings <small>ranked by F1, then sensitivity</small></h4>
            <table>
              <thead>
                <tr><th>free fall ≤</th><th>for ≥</th><th>impact ≥</th><th>still sd ≤</th><th>sens.</th><th>spec.</th><th>F1</th><th /></tr>
              </thead>
              <tbody>
                {(result.best ?? []).slice(0, 6).map((s, i) => (
                  <tr key={i} className={i === 0 ? "top" : ""}>
                    <td className="mono">{s.thresholds.freeFallG} g</td>
                    <td className="mono">{s.thresholds.freeFallMinMs} ms</td>
                    <td className="mono">{s.thresholds.impactG} g</td>
                    <td className="mono">{s.thresholds.stillStdG} g</td>
                    <td className="mono">{pct(s.sensitivity)}</td>
                    <td className="mono">{pct(s.specificity)}</td>
                    <td className="mono">{s.f1}</td>
                    <td>{i === 0 && <button className="etl-btn" onClick={() => apply(s)}>Apply to phones</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {applied && <small className="mono applied">✅ {applied}</small>}
          </div>
        </div>
      )}

      <div className="tablewrap">
        <table className="lab-table">
          <thead>
            <tr><th>Time</th><th>Device</th><th>Trigger</th><th>Peak</th><th>Phone said</th><th>What really happened?</th></tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <TraceRow key={t.key} t={t} open={open === t.key} onToggle={() => setOpen(open === t.key ? null : t.key)} onLabel={(l) => label(t, l)} />
            ))}
            {!traces.length && (
              <tr><td colSpan={6} className="emptyrow">No traces yet. A trace is recorded when a phone sees free fall or an impact above 2.2 g.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TraceRow({ t, open, onToggle, onLabel }: { t: TraceInfo; open: boolean; onToggle: () => void; onLabel: (l: string) => void }) {
  return (
    <>
      <tr className={t.label ? "" : "unlabelled"}>
        <td className="mono"><button className="link" onClick={onToggle}>{open ? "▾" : "▸"}</button> {new Date(t.ts).toLocaleString()}</td>
        <td className="mono">{t.deviceId.replace("_", " ")}</td>
        <td>{t.trigger}</td>
        <td className="mono">{t.peakG ?? "–"} g</td>
        <td>{t.detected ? <span className="det yes">FALL</span> : <span className="det no">ignored</span>}</td>
        <td>
          <div className="lbls">
            {LABELS.map((l) => (
              <button key={l.key} className={`${t.label === l.key ? "on" : ""} ${l.positive ? "pos" : ""}`} onClick={() => onLabel(l.key)}>
                {l.label}
              </button>
            ))}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="trace-plot">
          <td colSpan={6}><TracePlot traceKey={t.key} /></td>
        </tr>
      )}
    </>
  );
}

/** |a| in g over the 9.5 s window, with the free-fall (0.4 g) and impact (2 g) lines. */
function TracePlot({ traceKey }: { traceKey: string }) {
  const [samples, setSamples] = useState<number[][] | null>(null);
  useEffect(() => {
    api.labTrace(traceKey).then((r) => setSamples(r.samples)).catch(() => setSamples([]));
  }, [traceKey]);
  if (!samples) return <div className="qrun"><span className="spinner" /> loading trace…</div>;
  if (!samples.length) return <div className="qerr">Trace unavailable</div>;
  const W = 900;
  const H = 150;
  const tMax = samples[samples.length - 1][0] || 1;
  const gMax = Math.max(3, ...samples.map((s) => Math.hypot(s[1], s[2], s[3]) / 9.81));
  const y = (g: number) => H - (g / gMax) * (H - 10) - 5;
  const pts = samples.map((s) => `${((s[0] / tMax) * W).toFixed(1)},${y(Math.hypot(s[1], s[2], s[3]) / 9.81).toFixed(1)}`).join(" ");
  return (
    <svg className="tplot" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1="0" x2={W} y1={y(1)} y2={y(1)} className="g1" />
      <line x1="0" x2={W} y1={y(0.4)} y2={y(0.4)} className="ff" />
      <line x1="0" x2={W} y1={y(2)} y2={y(2)} className="imp" />
      <text x="6" y={y(2) - 4}>impact 2 g</text>
      <text x="6" y={y(0.4) - 4}>free fall 0.4 g</text>
      <polyline points={pts} />
    </svg>
  );
}

function Meter({ label, v }: { label: string; v: number }) {
  return (
    <div className="meter">
      <span>{label}</span>
      <div><i style={{ width: `${v * 100}%` }} /></div>
      <b className="mono">{pct(v)}</b>
    </div>
  );
}

function pct(v: number) {
  return `${Math.round(v * 100)}%`;
}
function fmtTh(t: LabScore["thresholds"]) {
  return `free fall ≤ ${t.freeFallG} g for ≥ ${t.freeFallMinMs} ms · impact ≥ ${t.impactG} g · still sd ≤ ${t.stillStdG} g`;
}
