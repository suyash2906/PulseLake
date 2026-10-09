import { useEffect, useMemo, useRef, useState } from "react";
import { Brand } from "../shared/Logo";
import { connectIot, type IotConnection } from "../shared/awsIot";
import { FAULTS, PROFILES, SLOTS, TOPICS, type Health, type Profile, type Telemetry } from "../shared/types";
import { DeviceEngine, type EngineState } from "./engine";
import { requestMotionPermission } from "./sensors";

const NAME_KEY = "pulselake.owner";
const SLOT_KEY = "pulselake.slot";
const PROFILE_KEY = "pulselake.profile";

export function DeviceApp() {
  const [engine, setEngine] = useState<DeviceEngine | null>(null);
  return engine ? (
    <LiveScreen engine={engine} onLeave={() => setEngine(null)} />
  ) : (
    <SetupScreen onJoin={setEngine} />
  );
}

// ======================================================================== setup
function SetupScreen({ onJoin }: { onJoin: (e: DeviceEngine) => void }) {
  const [slot, setSlot] = useState<string>(() => read(SLOT_KEY) ?? "");
  const [owner, setOwner] = useState<string>(() => read(NAME_KEY) ?? "");
  const [profileKey, setProfileKey] = useState<string>(() => read(PROFILE_KEY) ?? PROFILES[0].key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const occupancy = useSlotOccupancy();

  const join = async () => {
    setBusy(true);
    setError("");
    write(SLOT_KEY, slot);
    write(NAME_KEY, owner.trim());
    write(PROFILE_KEY, profileKey);
    await requestMotionPermission(); // must run inside the tap (iPhone)
    const profile = PROFILES.find((p) => p.key === profileKey)!;
    const engine = new DeviceEngine(slot, owner.trim(), profile);
    try {
      await engine.start();
      onJoin(engine);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setBusy(false);
    }
  };

  return (
    <div className="dv-wrap">
      <header className="dv-top">
        <Brand subtitle="IoT node" />
      </header>
      <section className="dv-hero">
        <h1>Turn this phone into an IoT sensor</h1>
        <p>It will stream its real motion sensors to AWS IoT Core. You control the environment and inject failures.</p>
      </section>

      <h2 className="dv-step"><span>1</span> Pick your device slot</h2>
      <div className="dv-slots">
        {SLOTS.map((s) => {
          const occ = occupancy[s];
          const taken = !!occ && s !== slot;
          return (
            <button key={s} className={`dv-slot ${slot === s ? "sel" : ""} ${occ ? "busy" : ""}`} onClick={() => setSlot(s)}>
              <b>{s.replace("_", " ")}</b>
              <small>{occ ? `in use · ${occ}` : "free"}</small>
              {taken && <i>⚠</i>}
            </button>
          );
        })}
      </div>

      <h2 className="dv-step"><span>2</span> Who is holding it?</h2>
      <input
        className="dv-input"
        placeholder="Your name"
        maxLength={20}
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
      />

      <h2 className="dv-step"><span>3</span> What kind of device is it?</h2>
      <div className="dv-profiles">
        {PROFILES.map((p) => (
          <button key={p.key} className={`dv-profile ${profileKey === p.key ? "sel" : ""}`} onClick={() => setProfileKey(p.key)}>
            <span className="ico">{p.icon}</span>
            {p.label}
          </button>
        ))}
      </div>

      {error && <div className="dv-error">{error}</div>}
      <button className="dv-cta" disabled={!slot || !owner.trim() || busy} onClick={join}>
        {busy ? "Connecting to AWS IoT…" : "Connect to AWS IoT Core"}
      </button>
      <p className="dv-foot">MQTT over secure WebSocket · Cognito guest identity · AWS Sydney (ap-southeast-2)</p>
    </div>
  );
}

/** Watches live telemetry briefly so the setup screen can show which slots are taken. */
function useSlotOccupancy() {
  const [occ, setOcc] = useState<Record<string, string>>({});
  useEffect(() => {
    let conn: IotConnection | null = null;
    let cancelled = false;
    const seen: Record<string, { owner: string; at: number }> = {};
    const prune = setInterval(() => {
      const now = Date.now();
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(seen)) if (now - v.at < 6000) next[k] = v.owner;
      setOcc(next);
    }, 1000);
    connectIot({ clientId: `dash-probe-${Math.random().toString(36).slice(2, 8)}` })
      .then((c) => {
        if (cancelled) return c.close();
        conn = c;
        c.client.subscribe(TOPICS.allTelemetry);
        c.client.on("message", (_t, payload) => {
          try {
            const m = JSON.parse(payload.toString()) as Telemetry;
            seen[m.id] = { owner: m.owner, at: Date.now() };
          } catch {
            /* ignore */
          }
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      clearInterval(prune);
      conn?.close();
    };
  }, []);
  return occ;
}

// ======================================================================== live
function useEngineState(engine: DeviceEngine) {
  const [s, setS] = useState<EngineState>(engine.state);
  useEffect(() => {
    const unsub = engine.subscribe(setS);
    return () => {
      unsub();
    };
  }, [engine]);
  return s;
}

const HEALTH_LABEL: Record<Health, string> = { OK: "HEALTHY", WARNING: "WARNING", FAILED: "FAILED" };

function LiveScreen({ engine, onLeave }: { engine: DeviceEngine; onLeave: () => void }) {
  const s = useEngineState(engine);
  const [temp, setTemp] = useState(engine.targets.temp);
  const [hum, setHum] = useState(engine.targets.hum);
  const profile: Profile = engine.profile;
  const activeFault = FAULTS.find((f) => f.key === s.fault);
  const healthClass = s.health === "OK" ? "ok" : s.health === "WARNING" ? "warn" : "fail";
  const connClass = s.conn === "online" ? "ok live" : s.conn === "blocked" ? "fail" : "warn";

  const leave = async () => {
    await engine.disconnect();
    onLeave();
  };

  return (
    <div className={`dv-wrap live h-${healthClass}`}>
      <header className="dv-top">
        <div>
          <div className="dv-id">{engine.id.replace("_", " ")}</div>
          <div className="dv-sub">
            {profile.icon} {profile.label} · {engine.owner}
          </div>
        </div>
        <span className={`pill ${connClass}`}>
          <span className="dot" />
          {s.conn.toUpperCase()}
        </span>
      </header>

      {s.sleepInSeconds !== null && (
        <div className="dv-banner">Going to sleep in {s.sleepInSeconds}s to save credits. Tap anywhere to stay awake.</div>
      )}

      <HealthRing health={s.health} label={HEALTH_LABEL[s.health]} sub={activeFault ? `${activeFault.icon} ${activeFault.label}` : "All systems normal"} />

      <div className="dv-metrics">
        <Metric icon="🌡️" label="Temperature" value={`${s.temp.toFixed(1)}°C`} alert={s.temp > 70} />
        <Metric icon="💧" label="Humidity" value={`${s.hum.toFixed(0)}%`} />
        <Metric icon="📳" label="Vibration" value={`${s.vibPeak.toFixed(1)}`} unit="m/s²" bar={Math.min(1, s.vibPeak / 20)} alert={s.vibPeak > 15} />
        <Metric icon={s.chg ? "🔌" : "🔋"} label="Battery" value={`${s.bat}%`} alert={s.bat < 10} />
        <Metric icon="⚡" label="Voltage" value={`${s.volt.toFixed(2)} V`} alert={s.volt > 6} />
        <Metric icon="📐" label="Tilt" value={`${s.tilt[0]}° / ${s.tilt[1]}°`} />
      </div>

      <section className="dv-card">
        <h3>Environment <small>simulated sensors</small></h3>
        <Slider label="Temperature" unit="°C" min={-20} max={100} value={temp} onChange={(v) => { setTemp(v); engine.setTempTarget(v); }} />
        <Slider label="Humidity" unit="%" min={0} max={100} value={hum} onChange={(v) => { setHum(v); engine.setHumTarget(v); }} />
      </section>

      <section className="dv-card">
        <h3>Inject a failure</h3>
        <div className="dv-faults">
          {FAULTS.map((f) => (
            <button
              key={f.key}
              className={`dv-fault ${s.fault === f.key ? "on" : ""} sev-${f.severity.toLowerCase()}`}
              onClick={() => { navigator.vibrate?.(60); engine.inject(f.key); }}
              disabled={s.conn !== "online"}
            >
              <span className="ico">{f.icon}</span>
              <b>{f.label}</b>
              <small>{f.hint}</small>
            </button>
          ))}
        </div>
        <button className="dv-recover" disabled={s.fault === "NONE"} onClick={() => engine.recover()}>
          ✅ Recover device
        </button>
        <p className="dv-tip">📳 Tip: shake the phone hard to trigger a real vibration alert.</p>
      </section>

      <footer className="dv-footer">
        <span className="mono">{s.sent} msgs sent · {s.rate} Hz · sensors {s.real ? "REAL" : "simulated"}</span>
        <button className="dv-leave" onClick={leave}>Leave</button>
      </footer>

      {s.overlay === "CRASH" && (
        <Overlay tone="fail" icon="💀" title="Device crashed">
          <p>The connection died without saying goodbye. Nobody told the cloud. Watch the dashboard detect it.</p>
          <button className="dv-cta" onClick={() => engine.reboot()}>Reboot device</button>
        </Overlay>
      )}
      {s.overlay === "NETWORK_DROP" && (
        <Overlay tone="warn" icon="📡" title="Network lost">
          <p>Simulating a network outage. Reconnecting automatically in</p>
          <div className="dv-count mono">{s.dropSecondsLeft}s</div>
        </Overlay>
      )}
      {s.overlay === "SLEEP" && (
        <Overlay tone="off" icon="🌙" title="Sleeping">
          <p>Stopped streaming after 10 minutes without activity, to save AWS credits.</p>
          <button className="dv-cta" onClick={() => engine.wake()}>Wake up</button>
        </Overlay>
      )}
      {s.overlay === "LOCATE" && (
        <div className="dv-locate">
          <div className="ico">📍</div>
          <h2>Here I am!</h2>
          <p>Mission Control is locating {engine.id.replace("_", " ")}</p>
        </div>
      )}
      {s.conn === "blocked" && (
        <Overlay tone="fail" icon="⛔" title="Slot taken">
          <p>{s.connDetail}. Pick another slot.</p>
          <button className="dv-cta" onClick={onLeave}>Back</button>
        </Overlay>
      )}
    </div>
  );
}

function HealthRing({ health, label, sub }: { health: Health; label: string; sub: string }) {
  const color = health === "OK" ? "var(--ok)" : health === "WARNING" ? "var(--warn)" : "var(--fail)";
  return (
    <div className={`dv-ring ring-${health.toLowerCase()}`}>
      <svg viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="84" className="track" />
        <circle cx="100" cy="100" r="84" className="arc" style={{ stroke: color }} />
        <circle cx="100" cy="100" r="70" className="inner" style={{ stroke: color }} />
      </svg>
      <div className="dv-ring-text">
        <b style={{ color }}>{label}</b>
        <small>{sub}</small>
      </div>
    </div>
  );
}

function Metric(props: { icon: string; label: string; value: string; unit?: string; bar?: number; alert?: boolean }) {
  return (
    <div className={`dv-metric ${props.alert ? "alert" : ""}`}>
      <div className="lbl">
        <span>{props.icon}</span> {props.label}
      </div>
      <div className="val mono">
        {props.value}
        {props.unit && <small> {props.unit}</small>}
      </div>
      {props.bar !== undefined && (
        <div className="bar">
          <i style={{ width: `${props.bar * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function Slider(props: { label: string; unit: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  const pct = useMemo(() => ((props.value - props.min) / (props.max - props.min)) * 100, [props.value, props.min, props.max]);
  return (
    <label className="dv-slider">
      <div className="row">
        <span>{props.label}</span>
        <b className="mono">
          {props.value}
          {props.unit}
        </b>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        value={props.value}
        style={{ ["--pct" as any]: `${pct}%` }}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Overlay(props: { tone: string; icon: string; title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className={`dv-overlay tone-${props.tone}`}>
      <div className="ico">{props.icon}</div>
      <h2>{props.title}</h2>
      {props.children}
    </div>
  );
}

function read(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
