import { useEffect, useRef } from "react";
import type { Alert } from "../shared/types";
import { api } from "./api";
import { fleet } from "./store";

const SOURCE_LABEL: Record<string, string> = {
  CLOUD_RULE: "cloud rule",
  PRESENCE: "AWS presence",
  DEVICE_FAULT: "device",
};

export function AlertsPanel({ alerts, sound }: { alerts: Alert[]; sound: boolean }) {
  const seen = useRef(new Set<string>());
  const first = useRef(true);

  useEffect(() => {
    api.alerts().then((list) => fleet.setAlerts(list)).catch(() => {});
  }, []);

  // alarm beep for every NEW critical alert
  useEffect(() => {
    let fresh = false;
    for (const a of alerts) {
      const key = `${a.alertId}:${a.status}`;
      if (!seen.current.has(key)) {
        seen.current.add(key);
        if (!first.current && a.status === "ACTIVE" && a.severity === "CRITICAL") fresh = true;
      }
    }
    first.current = false;
    if (fresh && sound) alarm();
  }, [alerts, sound]);

  const active = alerts.filter((a) => a.status === "ACTIVE");
  return (
    <section className="card alerts">
      <h3>
        Alerts <span className={`count ${active.length ? "on" : ""}`}>{active.length} active</span>
      </h3>
      <ul>
        {alerts.slice(0, 30).map((a) => (
          <li key={a.alertId} className={`al sev-${a.severity.toLowerCase()} st-${a.status.toLowerCase()}`}>
            <div className="al-top">
              <b>{a.type.replace(/_/g, " ")}</b>
              <span className="al-dev">{a.deviceId.replace("_", " ")}</span>
              <span className={`al-st`}>{a.status}</span>
            </div>
            <p>{a.message}</p>
            <small className="mono">
              {new Date(a.ts).toLocaleTimeString()} · {a.severity} · detected by {SOURCE_LABEL[a.source] ?? a.source}
            </small>
          </li>
        ))}
        {!alerts.length && <li className="al none">No alerts yet. Inject a failure from a phone.</li>}
      </ul>
    </section>
  );
}

let audio: AudioContext | null = null;
export function unlockAudio() {
  audio ??= new AudioContext();
  void audio.resume();
}
function alarm() {
  if (!audio) return;
  const t0 = audio.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(880, t0 + i * 0.25);
    osc.frequency.linearRampToValueAtTime(660, t0 + i * 0.25 + 0.2);
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.25);
    gain.gain.exponentialRampToValueAtTime(0.15, t0 + i * 0.25 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.25 + 0.2);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + i * 0.25);
    osc.stop(t0 + i * 0.25 + 0.22);
  }
}
