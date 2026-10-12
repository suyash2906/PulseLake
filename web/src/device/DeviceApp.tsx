import { useEffect, useMemo, useRef, useState } from "react";
import { Brand } from "../shared/Logo";
import { connectIot, type IotConnection } from "../shared/awsIot";
import { FAULTS, PROFILES, SLOTS, TOPICS, type Health, type Profile, type Telemetry } from "../shared/types";
import { DeviceEngine, type EngineState } from "./engine";
import { noiseBand } from "./noise";
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
  const [profileKey, setProfileKey] = useState<string>(() => PROFILES.find((p) => p.key === read(PROFILE_KEY))?.key ?? PROFILES[0].key);
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
    const profile = PROFILES.find((p) => p.key === profileKey) ?? PROFILES[0];
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

      {!s.real && s.sent > 3 && <MotionHint />}
      <StuckHint conn={s.conn} />

      <HealthRing health={s.health} label={HEALTH_LABEL[s.health]} sub={activeFault ? `${activeFault.icon} ${activeFault.label}` : "All systems normal"} />

      <div className="dv-metrics">
        <Metric icon="🌡️" label="Temperature" value={`${s.temp.toFixed(1)}°C`} alert={s.temp > 70} />
        <Metric icon="💧" label="Humidity" value={`${s.hum.toFixed(0)}%`} />
        <Metric icon="📳" label="Vibration" value={`${s.vibPeak.toFixed(1)}`} unit="m/s²" bar={Math.min(1, s.vibPeak / 20)} alert={s.vibPeak > 15} />
        <Metric icon={s.chg ? "🔌" : "🔋"} label="Battery" value={`${s.bat}%`} alert={s.bat < 10} />
        <Metric icon="⚡" label="Voltage" value={`${s.volt.toFixed(2)} V`} alert={s.volt > 6} />
        <Metric icon="🔊" label="Noise" value={s.noiseLevel === null ? "off" : `${s.noiseLevel.toFixed(0)}`} unit={s.noiseLevel === null ? undefined : "dB(A)"} bar={s.noiseLevel === null ? undefined : Math.min(1, Math.max(0, (s.noiseLevel - 30) / 70))} alert={(s.noiseLevel ?? 0) > 85} />
      </div>

      <div className="dv-orient mono" title="Compare with the 3D twin on the dashboard (about 1 s behind)">
        <span>📐 front/back <b>{s.orient.frontBack}°</b></span>
        <span>left/right <b>{s.orient.leftRight}°</b></span>
        <span>heading <b>{s.orient.heading}°</b></span>
      </div>

      <section className="dv-card dv-safety">
        <h3>Safety <small>detected on this phone (edge)</small></h3>
        <div className="dv-row">
          <div>
            <b>Fall detection {engine.fallDetection ? "ON" : "OFF"}</b>
            <small>free fall → impact → stillness, then "Are you OK?"</small>
          </div>
          <button className={`dv-toggle ${engine.fallDetection ? "on" : ""}`} onClick={() => engine.setFallDetection(!engine.fallDetection)}>
            {engine.fallDetection ? "Turn off" : "Turn on"}
          </button>
        </div>
        <button className={`dv-sos ${s.sos ? "on" : ""}`} disabled={s.conn !== "online"} onClick={() => (s.sos ? engine.clearSos() : engine.sos())}>
          {s.sos ? "✋ Cancel SOS" : "🆘 SOS - call for help"}
        </button>
      </section>

      <NoiseCard engine={engine} on={s.noiseOn} level={s.noiseLevel} error={s.noiseError} />

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
      {s.overlay === "FALL_COUNTDOWN" && (
        <div className="dv-fall">
          <div className="ico">🆘</div>
          <h2>Fall detected. Are you OK?</h2>
          <p>An alert goes to Mission Control in</p>
          <div className="dv-count mono">{s.fallCountdown}s</div>
          <button className="dv-ok" onClick={() => engine.imOk()}>I'm OK</button>
          {s.fallInfo && <small className="mono">impact {s.fallInfo.impactG} g · free fall {s.fallInfo.freeFallMs} ms · turned {s.fallInfo.angleChange}°</small>}
        </div>
      )}
      {s.overlay === "FALL_SENT" && (
        <Overlay tone="fail" icon="🚑" title="Alert sent">
          <p>Mission Control has been alerted that {engine.owner} may have fallen. Help is on the way.</p>
          <button className="dv-cta" onClick={() => engine.imOk()}>I'm OK now</button>
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

/** Microphone on/off, live level and calibration. Only numbers leave the phone. */
function NoiseCard({ engine, on, level, error }: { engine: DeviceEngine; on: boolean; level: number | null; error: string }) {
  const [cal, setCal] = useState(engine.noiseCalibration);
  const band = noiseBand(level);
  return (
    <section className="dv-card">
      <h3>Noise monitoring <small>audio never leaves this phone</small></h3>
      {!on ? (
        <>
          <p className="dv-tip">Measures how loud it is around this phone (approx. dB(A)), like a sound-level meter. Only the number is sent to the cloud.</p>
          <button className="dv-recover" onClick={() => engine.enableNoise()}>🎙️ Enable noise sensor</button>
        </>
      ) : (
        <>
          <div className={`dv-noise tone-${band.tone}`}>
            <b className="mono">{level === null ? "…" : level.toFixed(0)}</b>
            <span>dB(A) · {band.label}</span>
          </div>
          <Slider
            label="Calibration offset"
            unit=" dB"
            min={60}
            max={140}
            value={cal}
            onChange={(v) => {
              setCal(v);
              engine.setNoiseCalibration(v);
            }}
          />
          <p className="dv-tip">Phone microphones are not calibrated: adjust the offset until a quiet room reads about 35 dB, or match a sound-meter app. Above 85 dB(A) the cloud raises a NOISE alert.</p>
          <button className="dv-leave" onClick={() => engine.disableNoise()}>Turn off microphone</button>
        </>
      )}
      {error && <div className="dv-error">{error}</div>}
    </section>
  );
}

/** If AWS IoT cannot be reached for 15 s, explain the likely reasons. */
function StuckHint({ conn }: { conn: string }) {
  const [since, setSince] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    setSince(conn === "online" || conn === "blocked" ? null : Date.now());
  }, [conn]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (since === null || Date.now() - since < 15_000) return null;
  return (
    <div className="dv-banner">
      Can't reach AWS IoT. Check the phone's internet (try mobile data / hotspot). If it still fails, the project may be
      paused by the budget kill switch.
    </div>
  );
}

/** Shown while the phone sends simulated motion - usually missing iPhone permission. */
function MotionHint() {
  const [tried, setTried] = useState(false);
  const iosPrompt = typeof (window as any).DeviceMotionEvent?.requestPermission === "function";
  return (
    <div className="dv-banner motion">
      <b>Motion sensors are off</b> - this phone is sending simulated tilt/vibration.
      {iosPrompt ? (
        <button
          onClick={async () => {
            await requestMotionPermission();
            setTried(true);
          }}
        >
          Enable motion sensors
        </button>
      ) : (
        <span> This browser does not expose motion sensors.</span>
      )}
      {tried && (
        <small>
          No prompt? On iPhone: Settings → Apps → Safari → Advanced → turn on "Motion & Orientation Access", then reload this
          page.
        </small>
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
