import { useEffect, useState } from "react";
import { Brand } from "../shared/Logo";
import { loadConfig } from "../shared/awsIot";
import { SLOTS } from "../shared/types";
import { AlertsPanel, unlockAudio } from "./AlertsPanel";
import { CostMeter } from "./CostMeter";
import { DeviceCard } from "./DeviceCard";
import { JoinQR } from "./JoinQR";
import { LakePanel } from "./LakePanel";
import { useLiveFeed } from "./live";
import { Pipeline } from "./Pipeline";
import { ReplayBar, TimeMachine } from "./TimeMachine";
import { VirtualFleet } from "./VirtualFleet";
import { statusOf, useFleet, type FeedItem } from "./store";

type Tab = "live" | "lake" | "scale";
const TABS: { key: Tab; label: string }[] = [
  { key: "live", label: "📡 Live fleet" },
  { key: "lake", label: "🪣 Data lake" },
  { key: "scale", label: "🚀 Scale test" },
];

export function Dashboard() {
  const conn = useLiveFeed();
  const fleet = useFleet();
  const [joinUrl, setJoinUrl] = useState("…/device.html");
  const [clock, setClock] = useState(() => new Date());
  const [sound, setSound] = useState(false);
  const [tab, setTab] = useState<Tab>(() => (localStorageGet("pulselake.tab") as Tab) || "live");

  useEffect(() => {
    loadConfig()
      .then((c) => setJoinUrl((c.deviceUrl ?? `${location.origin}/device.html`).replace(/^https?:\/\//, "")))
      .catch(() => {});
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const pickTab = (t: Tab) => {
    setTab(t);
    localStorageSet("pulselake.tab", t);
  };

  const devices = SLOTS.map((id) => fleet.devices[id]);
  const statuses = devices.map((d) => statusOf(d, fleet.now));
  const online = statuses.filter((s) => s === "OK" || s === "WARNING" || s === "FAILED").length;
  const failing = statuses.filter((s) => s === "FAILED" || s === "OFFLINE").length;
  const phoneAlerts = fleet.alerts.filter((a) => !a.deviceId.startsWith("SIM_"));

  return (
    <div className={`dash ${failing ? "alarm" : ""} ${fleet.mode === "replay" ? "replaying" : ""}`}>
      <header className="topbar glass">
        <Brand subtitle="Mission Control · Real-time IoT data lake" />
        <div className="kpis">
          <Kpi label="AWS IoT Core" value={conn === "online" ? "CONNECTED" : conn.toUpperCase()} tone={conn === "online" ? "ok" : "warn"} />
          <Kpi label="Phones online" value={`${online} / ${SLOTS.length}`} tone={online ? "ok" : "off"} />
          <Kpi label="Failing" value={String(failing)} tone={failing ? "fail" : "ok"} />
          <Kpi label="Msgs / sec" value={fleet.msgsPerSec.toFixed(1)} />
          <Kpi label="Msgs total" value={fleet.totalMsgs.toLocaleString()} />
          <CostMeter />
        </div>
        <JoinQR />
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

      <ReplayBar />

      {phoneAlerts
        .filter((a) => (a.type === "FALL" || a.type === "SOS") && a.status === "ACTIVE")
        .map((a) => (
          <div key={a.alertId} className="emergency-bar">
            <b>{a.type === "FALL" ? "🚨 FALL DETECTED" : "🆘 SOS"}</b>
            <span>
              {a.deviceId.replace("_", " ")} · {a.owner}
            </span>
            <small>{a.message}</small>
            <small className="mono">{new Date(a.ts).toLocaleTimeString()}</small>
          </div>
        ))}

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => pickTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="grid">
        <div className="maincol">
          {tab === "live" && (
            <>
              <Pipeline />
              <section className="fleet">
                {devices.map((d) => (
                  <DeviceCard key={d.id} d={d} now={fleet.now} joinUrl={joinUrl} alerts={phoneAlerts} />
                ))}
              </section>
            </>
          )}
          {tab === "lake" && (
            <>
              <TimeMachine />
              <LakePanel />
            </>
          )}
          {tab === "scale" && <VirtualFleet />}
        </div>
        <aside className="side">
          <AlertsPanel alerts={phoneAlerts} sound={sound} now={fleet.now} />
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

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
