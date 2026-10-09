import { useEffect, useState } from "react";
import { api, type Session } from "./api";
import { replay, useReplay } from "./replay";

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

/** Pick a past session from the data lake and replay it on the dashboard. */
export function TimeMachine() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState<number | null>(null);
  const r = useReplay();

  const refresh = () => {
    setError("");
    setSessions(null);
    api.sessions().then(setSessions).catch((e) => setError(e.message));
  };
  useEffect(refresh, []);

  const play = async (s: Session) => {
    setLoading(s.start);
    setError("");
    try {
      // a session can be long - replay its first 10 minutes
      const end = Math.min(s.end, s.start + 10 * 60_000);
      replay.load(await api.replay(s.start, end));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  };

  return (
    <section className="card tm">
      <h3>
        ⏪ Time machine <small>replay any past session straight from the S3 data lake</small>
        <button className="link" onClick={refresh}>refresh</button>
      </h3>
      <p className="tm-why">
        A data lake keeps the <b>raw data unchanged</b>, so we can re-run history at any time: here Athena reads the Bronze
        layer and the dashboard plays it back exactly as it happened.
      </p>
      {error && <div className="qerr">{error}</div>}
      {!sessions && !error && <div className="qrun"><span className="spinner" /> Athena is looking for sessions…</div>}
      {sessions && !sessions.length && <div className="emptyrow">No phone sessions in the last 7 days yet.</div>}
      <div className="tm-list">
        {sessions?.map((s) => (
          <button key={s.start} className={`tm-item ${r.active && r.start === s.start ? "sel" : ""}`} disabled={loading !== null} onClick={() => play(s)}>
            <span className="tm-day">{fmtDay(s.start)}</span>
            <b className="mono">{fmtTime(s.start)} – {fmtTime(s.end)}</b>
            <span>{s.devices} phone{s.devices > 1 ? "s" : ""} · {s.messages.toLocaleString()} msgs</span>
            <small>{s.owners.join(", ") || "–"}</small>
            {loading === s.start ? <span className="spinner" /> : <span className="tm-play">▶</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Banner shown across the top while a replay is running. */
export function ReplayBar() {
  const r = useReplay();
  if (!r.active) return null;
  const pct = ((r.position - r.start) / Math.max(1, r.end - r.start)) * 100;
  return (
    <div className="replaybar">
      <span className="rb-tag">⏪ REPLAY</span>
      <span className="mono">{new Date(r.position).toLocaleString()}</span>
      <div className="rb-track"><i style={{ width: `${pct}%` }} /></div>
      <button onClick={() => replay.togglePlay()}>{r.playing ? "⏸" : "▶"}</button>
      {[1, 2, 4, 8].map((s) => (
        <button key={s} className={r.speed === s ? "on" : ""} onClick={() => replay.setSpeed(s)}>{s}×</button>
      ))}
      <span className="rb-counts mono">{r.counts.telemetry} readings · {r.counts.events} events · {r.counts.alerts} alerts</span>
      <button className="rb-exit" onClick={() => replay.exit()}>Back to LIVE</button>
    </div>
  );
}
