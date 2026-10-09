import { useEffect, useState } from "react";
import { Brand } from "../shared/Logo";
import { loadConfig } from "../shared/awsIot";
import { SLOTS } from "../shared/types";
import { AlertsPanel, unlockAudio } from "./AlertsPanel";
import { DeviceCard } from "./DeviceCard";
import { LakePanel } from "./LakePanel";
import { useLiveFeed } from "./live";
import { statusOf, useFleet, type FeedItem } from "./store";

export function Dashboard() {
  const conn = useLiveFeed();
  const fleet = useFleet();
  const [joinUrl, setJoinUrl] = useState("…/device.html");
  const [clock, setClock] = useState(() => new Date());
  const [sound, setSound] = useState(false);

  useEffect(() => {
    loadConfig()
      .then((c) => setJoinUrl((c.deviceUrl ?? `${location.origin}/device.html`).replace(/^https?:\/\//, "")))
      .catch(() => {});
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const devices = SLOTS.map((id) => fleet.devices[id]);
  const statuses = devices.map((d) => statusOf(d, fleet.now));
  const online = statuses.filter((s) => s === "OK" || s === "WARNING" || s === "FAILED").length;
  const failing = statuses.filter((s) => s === "FAILED" || s === "OFFLINE").length;

  return (
    <div className={`dash ${failing ? "alarm" : ""}`}>
      <header className="topbar glass">
        <Brand subtitle="Mission Control · Real-time IoT data lake" />
        <div className="kpis">
          <Kpi label="AWS IoT Core" value={conn === "online" ? "CONNECTED" : conn.toUpperCase()} tone={conn === "online" ? "ok" : "warn"} />
          <Kpi label="Devices online" value={`${online} / ${SLOTS.length}`} tone={online ? "ok" : "off"} />
          <Kpi label="Failing" value={String(failing)} tone={failing ? "fail" : "ok"} />
          <Kpi label="Msgs / sec" value={fleet.msgsPerSec.toFixed(1)} />
          <Kpi label="Msgs total" value={fleet.totalMsgs.toLocaleString()} />
        </div>
        <button
          className={`sound ${sound ? "on" : ""}`}
          title="Alarm sound for critical alerts"
          onClick={() => {
            unlockAudio();
            setSound(!sound);
          }}
        >
          {sound ? "🔊" : "🔇"}
        </button>
        <div className="clock mono">{clock.toLocaleTimeString()}</div>
      </header>

      <main className="grid">
        <div className="maincol">
          <section className="fleet">
            {devices.map((d) => (
              <DeviceCard key={d.id} d={d} now={fleet.now} joinUrl={joinUrl} />
            ))}
          </section>
          <LakePanel />
        </div>
        <aside className="side">
          <AlertsPanel alerts={fleet.alerts} sound={sound} />
          <Feed items={fleet.feed} />
        </aside>
      </main>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`kpi ${tone ? `t-${tone}` : ""}`}>
      <span>{label}</span>
      <b className="mono">{value}</b>
    </div>
  );
}

function Feed({ items }: { items: FeedItem[] }) {
  return (
    <section className="card feed">
      <h3>Live activity</h3>
      <ul>
        {items.map((i) => (
          <li key={i.id} className={`fi tone-${i.tone}`}>
            <span className="ico">{i.icon}</span>
            <span className="txt">{i.text}</span>
            <time className="mono">{new Date(i.ts).toLocaleTimeString()}</time>
          </li>
        ))}
        {!items.length && <li className="fi empty">Waiting for the first message…</li>}
      </ul>
    </section>
  );
}
