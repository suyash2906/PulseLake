import { useEffect, useRef, useState } from "react";
import { api, type SimStatus } from "./api";
import { Sparkline } from "./Sparkline";
import { useFleet } from "./store";

// ≈ USD per message through the whole pipeline (IoT publish + delivery + rules + SQS + Lambda + DynamoDB)
const COST_PER_MSG = 3.5e-6;

/** Scalability / elasticity demo: launch up to 200 virtual devices for up to 2 minutes. */
export function VirtualFleet() {
  const f = useFleet();
  const [devices, setDevices] = useState(100);
  const [seconds, setSeconds] = useState(60);
  const [status, setStatus] = useState<SimStatus>({ state: "NEVER_RUN" });
  const [error, setError] = useState("");
  const timer = useRef<number>();

  const poll = () =>
    api.simulateStatus().then((s) => {
      setStatus(s);
      return s;
    });

  useEffect(() => {
    poll().catch(() => {});
    return () => clearInterval(timer.current);
  }, []);

  const running = status.state === "RUNNING" || status.state === "STARTING";
  useEffect(() => {
    clearInterval(timer.current);
    if (running) timer.current = window.setInterval(() => poll().catch(() => {}), 2000);
  }, [running]);

  const launch = async () => {
    setError("");
    try {
      setStatus(await api.simulate(devices, seconds));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const sims = Object.entries(f.sims).sort(([a], [b]) => a.localeCompare(b));
  const activeSims = sims.filter(([, s]) => f.now - s.lastAt < 3000);
  const unhealthy = activeSims.filter(([, s]) => s.health !== "OK").length;
  const simAlerts = f.alerts.filter((a) => a.deviceId.startsWith("SIM_") && a.status === "ACTIVE").length;
  const peak = Math.max(...f.rateHistory);
  const estimate = devices * seconds * COST_PER_MSG;

  return (
    <section className="card vf">
      <h3>
        🚀 Scalability test <small>virtual devices through the same serverless pipeline</small>
      </h3>
      <p className="tm-why">
        Cloud elasticity: nothing is pre-provisioned. AWS IoT Core, Lambda, SQS and DynamoDB scale automatically from 4 phones
        to hundreds of devices - and back to zero cost when the test ends.
      </p>

      <div className="vf-controls">
        <label>
          Devices
          <div className="seg">
            {[50, 100, 200].map((n) => (
              <button key={n} className={devices === n ? "on" : ""} disabled={running} onClick={() => setDevices(n)}>{n}</button>
            ))}
          </div>
        </label>
        <label>
          Duration
          <div className="seg">
            {[30, 60, 120].map((n) => (
              <button key={n} className={seconds === n ? "on" : ""} disabled={running} onClick={() => setSeconds(n)}>{n} s</button>
            ))}
          </div>
        </label>
        <button className="etl-btn" disabled={running} onClick={launch}>
          {running ? <><span className="spinner" /> Running…</> : `Launch ${devices} devices`}
        </button>
        <span className="vf-cost mono">≈ {(devices * seconds).toLocaleString()} msgs · ≈ ${estimate.toFixed(3)} credits</span>
      </div>
      {error && <div className="qerr">{error}</div>}

      <div className="vf-stats">
        <Stat label="Virtual devices online" value={String(activeSims.length)} />
        <Stat label="Messages / second" value={f.msgsPerSec.toFixed(0)} accent />
        <Stat label="Peak msgs / s" value={String(peak)} />
        <Stat label="Unhealthy now" value={String(unhealthy)} tone={unhealthy ? "warn" : undefined} />
        <Stat label="Cloud alerts (virtual)" value={String(simAlerts)} tone={simAlerts ? "fail" : undefined} />
        <Stat label="Servers we added" value="0" tone="ok" />
      </div>

      <div className="vf-chart">
        <span className="lbl">Messages per second (last 2 min)</span>
        <Sparkline values={f.rateHistory} color="#4cc9f0" min={0} height={70} />
      </div>

      <div className="vf-grid">
        {sims.map(([id, s]) => (
          <i
            key={id}
            title={`${id} · ${s.temp}°C · ${s.health}`}
            className={`h-${f.now - s.lastAt > 3000 ? "off" : s.health.toLowerCase()}`}
          />
        ))}
        {!sims.length && <span className="emptyrow">Launch a test to see every virtual device as a tile.</span>}
      </div>

      {status.state === "DONE" && (
        <div className="vf-done">
          ✅ Last test: <b>{status.devices} devices × {status.seconds} s</b> → {status.sent?.toLocaleString()} messages published,{" "}
          {status.errors ?? 0} errors, {status.faultyDevices} devices developed faults, finished in {status.durationSec} s. Open the
          Data Lake tab → <i>Virtual fleet load tests</i> to see that every message reached S3.
        </div>
      )}
      {running && (
        <div className="vf-done">
          ⏳ {status.state === "STARTING" ? "Starting Lambda…" : `Running: ${status.elapsed ?? 0}/${status.seconds} s, ${(status.sent ?? 0).toLocaleString()} messages sent`}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, tone, accent }: { label: string; value: string; tone?: string; accent?: boolean }) {
  return (
    <div className={`vf-stat ${tone ? `t-${tone}` : ""} ${accent ? "accent" : ""}`}>
      <span>{label}</span>
      <b className="mono">{value}</b>
    </div>
  );
}
