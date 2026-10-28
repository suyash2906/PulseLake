import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import { Brand } from "../shared/Logo";
import { connectIot, type IotConnection } from "../shared/awsIot";
import { FAULTS, PROFILES, SLOTS, TOPICS, type Activity, type Health, type Profile, type Telemetry } from "../shared/types";
import { DeviceEngine, type EngineState } from "./engine";
import type { HrProgress, HrResult } from "./heartRate";
import type { LocationMode } from "./location";
import { noiseBand } from "./noise";
import { requestMotionPermission } from "./sensors";

const NAME_KEY = "pulselake.owner";
const SLOT_KEY = "pulselake.slot";
const PROFILE_KEY = "pulselake.profile";
const PHONE_KEY = "pulselake.ownerPhone";

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
    const profile = PROFILES.find((p) => p.key === profileKey) ?? PROFILES[0];
    const engine = new DeviceEngine(slot, owner.trim(), profile);
    // background keep-alive needs this very tap (media playback rule), so before any await
    engine.background.prime(`${slot.replace("_", " ")} · ${owner.trim()}`);
    await requestMotionPermission(); // must run inside the tap (iPhone)
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
        <p>
          It streams its real sensors (motion, steps, sound, location, heart rate) to AWS IoT Core. The cloud stores
          everything in a data lake and acts on it, for example by alerting your family's phones.
        </p>
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
const ACT_LABEL: Record<Activity, string> = { still: "🧍 still", walk: "🚶 walking", active: "🏃 active" };

function LiveScreen({ engine, onLeave }: { engine: DeviceEngine; onLeave: () => void }) {
  const s = useEngineState(engine);
  const [temp, setTemp] = useState(engine.targets.temp);
  const [hum, setHum] = useState(engine.targets.hum);
  const [hrOpen, setHrOpen] = useState(false);
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
        <Metric icon="🚶" label="Steps today" value={s.stepsDay.toLocaleString()} unit={ACT_LABEL[s.act]} wide />
        <Metric icon="❤️" label="Heart rate" value={s.hr ? `${s.hr.bpm}` : "–"} unit={s.hr ? "bpm" : undefined} alert={!!s.hr && (s.hr.bpm > 120 || s.hr.bpm < 45)} />
      </div>

      {s.backFrom !== null && s.backFrom > 5000 && (
        <div className="dv-banner bgback" onClick={() => engine.dismissBackFrom()}>
          🌙 Welcome back. PulseLake kept streaming for {fmtDur(s.backFrom)} in the background
          {s.bg.ios ? " (iPhone may have paused it)" : ""}. Motion and fall detection were paused while the screen was off. Tap to close.
        </div>
      )}

      {s.helpFrom && (
        <div className="dv-help" onClick={() => engine.dismissHelp()}>
          <b>✅ {s.helpFrom} is responding</b>
          <span>Your alert was received. Help is on the way.</span>
        </div>
      )}

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

      <SensorHub engine={engine} s={s} onHr={() => setHrOpen(true)} />

      <ShareCard engine={engine} s={s} />

      <NoiseCard engine={engine} on={s.noiseOn} level={s.noiseLevel} error={s.noiseError} />

      <section className="dv-card">
        <h3>Environment <small>virtual sensors (stand-ins for external IoT sensors)</small></h3>
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
          {s.helpFrom ? (
            <p className="dv-help-inline">✅ <b>{s.helpFrom}</b> has seen your alert and is responding.</p>
          ) : (
            <p>Your responders have been alerted that {engine.owner} may have fallen. If nobody answers, the alert escalates automatically.</p>
          )}
          <button className="dv-cta" onClick={() => engine.imOk()}>I'm OK now</button>
        </Overlay>
      )}
      {s.command && <CommandOverlay engine={engine} c={s.command} />}
      {hrOpen && <HeartRateOverlay engine={engine} onClose={() => setHrOpen(false)} />}
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

const LOC_MODES: { key: LocationMode; label: string; hint: string }[] = [
  { key: "off", label: "Off", hint: "Location is never sent." },
  { key: "emergency", label: "Emergency only", hint: "Sent only during a fall or SOS, so responders can find you." },
  { key: "always", label: "Always", hint: "Rounded to about 100 m (exact during an emergency). Enables safe-zone rules." },
];

/** Every sensor this phone contributes to the data lake, with consent controls. */
function SensorHub({ engine, s, onHr }: { engine: DeviceEngine; s: EngineState; onHr: () => void }) {
  const [zone, setZone] = useState("Home");
  const [radius, setRadius] = useState(300);
  const [zoneMsg, setZoneMsg] = useState("");
  const still = s.stillSec < 60 ? `${s.stillSec}s` : s.stillSec < 3600 ? `${Math.floor(s.stillSec / 60)} min` : `${(s.stillSec / 3600).toFixed(1)} h`;
  const hrAgo = s.hr ? Math.round((Date.now() - s.hr.at) / 60000) : null;
  const saveZone = async () => {
    setZoneMsg("Saving…");
    try {
      await engine.saveZone(zone, radius);
      setZoneMsg(`✅ Saved "${zone}" (${radius} m). Geofence rules can use it now.`);
    } catch (e: any) {
      setZoneMsg(e?.message ?? String(e));
    }
  };
  return (
    <section className="dv-card dv-hub">
      <h3>Sensor hub <small>what this phone sends to the data lake</small></h3>

      <div className="hub-row">
        <span className="hub-ico">📐</span>
        <div>
          <b>Motion &amp; orientation</b>
          <small>{s.real ? "real accelerometer + gyroscope, 60 Hz on the phone" : "simulated (no motion sensors)"}</small>
        </div>
        <span className={`chip ${s.real ? "ok" : "off"}`}>{s.real ? "REAL" : "SIM"}</span>
      </div>

      <div className="hub-row">
        <span className="hub-ico">🚶</span>
        <div>
          <b>Steps &amp; activity</b>
          <small>{s.stepsDay.toLocaleString()} steps today · {ACT_LABEL[s.act]} · no movement for {still}</small>
        </div>
        <span className="chip ok">EDGE</span>
      </div>

      <div className="hub-row col">
        <div className="hub-line">
          <span className="hub-ico">📍</span>
          <div>
            <b>Location (GPS)</b>
            <small>
              {s.locMode === "off"
                ? "not shared"
                : s.loc
                  ? `±${s.loc.acc} m${s.loc.spd ? ` · ${(s.loc.spd * 3.6).toFixed(0)} km/h` : ""}`
                  : s.locError || "waiting for a GPS fix…"}
            </small>
          </div>
        </div>
        <div className="seg3">
          {LOC_MODES.map((m) => (
            <button key={m.key} className={s.locMode === m.key ? "on" : ""} onClick={() => engine.setLocationMode(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
        <small className="dv-tip">{LOC_MODES.find((m) => m.key === s.locMode)?.hint}</small>
        {s.locMode !== "off" && s.loc && (
          <div className="zone-row">
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              {["Home", "Site", "Depot"].map((z) => <option key={z}>{z}</option>)}
            </select>
            <select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
              {[100, 200, 300, 500, 1000].map((r) => <option key={r} value={r}>{r} m</option>)}
            </select>
            <button onClick={saveZone}>Save this place as zone</button>
          </div>
        )}
        {zoneMsg && <small className="dv-tip">{zoneMsg}</small>}
      </div>

      <div className="hub-row">
        <span className="hub-ico">❤️</span>
        <div>
          <b>Heart rate (camera)</b>
          <small>{s.hr ? `${s.hr.bpm} bpm · quality ${Math.round(s.hr.quality * 100)}% · ${hrAgo === 0 ? "just now" : `${hrAgo} min ago`}` : "fingertip on the rear camera, 20 s"}</small>
        </div>
        <button className="dv-mini" disabled={s.conn !== "online"} onClick={onHr}>Measure</button>
      </div>

      <div className="hub-row">
        <span className="hub-ico">{s.chg ? "🔌" : "🔋"}</span>
        <div>
          <b>Battery</b>
          <small>{"getBattery" in navigator ? "real Battery API" : "simulated (this browser hides the battery)"}</small>
        </div>
        <span className="chip">{s.bat}%</span>
      </div>

      <div className="hub-row">
        <span className="hub-ico">📶</span>
        <div>
          <b>Network quality</b>
          <small>
            {s.net ? `${s.net.rtt} ms round trip · ${s.net.dl} Mbps` : "not exposed by this browser"} · new field: the lake adds a column for it
            automatically
          </small>
        </div>
        <span className={`chip ${s.net ? "ok" : "off"}`}>{s.net ? "EXT" : "N/A"}</span>
      </div>

      <div className="hub-row">
        <span className="hub-ico">🎯</span>
        <div>
          <b>Fall detector settings</b>
          <small>{s.fallConfig === "default" ? "default thresholds" : `tuned by the cloud: ${s.fallConfig}`} · {s.traces} trace{s.traces === 1 ? "" : "s"} sent to the Accuracy Lab</small>
        </div>
      </div>

      <div className="hub-row col">
        <div className="hub-line">
          <span className="hub-ico">🌙</span>
          <div>
            <b>Background mode</b>
            <small>
              {s.bg.ios
                ? "iPhone pauses web pages in the background: keep this screen open"
                : s.bg.keepAlive
                  ? "on - keeps streaming with the screen off or in another app, until you close this tab"
                  : "starting… (tap anywhere if it stays off)"}
            </small>
          </div>
          <span className={`chip ${s.bg.keepAlive && !s.bg.ios ? "ok" : "off"}`}>{s.bg.keepAlive && !s.bg.ios ? "ON" : "OFF"}</span>
        </div>
        <small className="dv-tip">
          In the background the location, sound level, battery and cloud messages keep working. Motion sensors are blocked by the browser while the
          screen is off, so fall detection and steps pause - the cloud is told "motion paused", not "no movement".
        </small>
        {s.bg.notifications !== "granted" && s.bg.notifications !== "unsupported" && (
          <button className="dv-mini blue" onClick={() => engine.background.enableNotifications()}>
            Allow alerts while in the background
          </button>
        )}
        <div className="hub-line">
          <span className="hub-ico">♾️</span>
          <div>
            <b>Keep running until the tab is closed</b>
            <small>{s.longRun ? "on - no auto-sleep (keep the phone charging)" : "off - sleeps after 10 min without activity to save credits"}</small>
          </div>
          <button className={`dv-toggle ${s.longRun ? "on" : ""}`} onClick={() => engine.setLongRun(!s.longRun)}>
            {s.longRun ? "On" : "Off"}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Pair a family member / supervisor: they enter this code in the Responder app. */
function ShareCard({ engine, s }: { engine: DeviceEngine; s: EngineState }) {
  const [svg, setSvg] = useState("");
  const [phone, setPhone] = useState(() => read(PHONE_KEY) ?? "");
  const [, tick] = useState(0);
  useEffect(() => {
    if (!s.pair) return;
    QRCode.toString(s.pair.url, { type: "svg", margin: 1, color: { dark: "#060a14", light: "#ffffff" } }).then(setSvg).catch(() => {});
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [s.pair]);
  const left = s.pair ? Math.max(0, Math.round((s.pair.expiresAt - Date.now()) / 1000)) : 0;
  return (
    <section className="dv-card">
      <h3>Who gets my alerts? <small>family, carer or supervisor</small></h3>
      {!s.pair || left <= 0 ? (
        <>
          <p className="dv-tip">Create a one-time code. The other person opens the PulseLake Responder app and scans it. Their phone then receives your alerts as notifications, with a Call button for the number you enter.</p>
          <input
            className="dv-input small"
            type="tel"
            placeholder="Your phone number (optional)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button
            className="dv-recover"
            disabled={s.conn !== "online"}
            onClick={() => {
              write(PHONE_KEY, phone.trim());
              void engine.startPairing(phone.trim());
            }}
          >
            👨‍👩‍👧 Add a responder
          </button>
        </>
      ) : (
        <div className="pair">
          <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
          <div>
            <b className="mono pair-code">{s.pair.code.replace(/(\d{3})(\d{3})/, "$1 $2")}</b>
            <small>Scan with the other phone's camera, or type the code in the Responder app. Valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.</small>
            <button className="dv-leave" onClick={() => engine.closePairing()}>Done</button>
          </div>
        </div>
      )}
      {s.pairError && <div className="dv-error">{s.pairError}</div>}
    </section>
  );
}

/** A rule in the cloud asked this phone to show something. */
function CommandOverlay({ engine, c }: { engine: DeviceEngine; c: NonNullable<EngineState["command"]> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (c.kind === "ASK_OK") {
    const left = c.until ? Math.max(0, Math.round((c.until - Date.now()) / 1000)) : 0;
    return (
      <div className="dv-fall ask">
        <div className="ico">🙋</div>
        <h2>{c.text}</h2>
        <p>We haven't noticed any movement for a while. Please confirm you are fine, or your responders will be told.</p>
        <div className="dv-count mono">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</div>
        <button className="dv-ok" onClick={() => engine.answerCommand()}>Yes, I'm OK</button>
      </div>
    );
  }
  return (
    <Overlay tone="info" icon="💬" title="Message">
      <p className="dv-msg">{c.text}</p>
      {c.from && <small>from {c.from}</small>}
      <button className="dv-cta" onClick={() => engine.answerCommand()}>OK</button>
    </Overlay>
  );
}

/** Camera PPG heart-rate check with live waveform. */
function HeartRateOverlay({ engine, onClose }: { engine: DeviceEngine; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [p, setP] = useState<HrProgress | null>(null);
  const [result, setResult] = useState<HrResult | null>(null);
  const [error, setError] = useState("");

  const start = async () => {
    setError("");
    setResult(null);
    setP(null);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      setResult(await engine.measureHr(videoRef.current!, setP, ac.signal));
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.name === "NotAllowedError" ? "Camera permission was denied" : e?.message ?? String(e));
    }
  };
  useEffect(() => {
    void start();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = p ? p.seconds / p.total : 0;
  const wave = p?.wave ?? [];
  const span = Math.max(0.5, ...wave.map((v) => Math.abs(v)));
  const points = wave.map((v, i) => `${(i / Math.max(1, wave.length - 1)) * 300},${40 - (v / span) * 34}`).join(" ");

  return (
    <div className="dv-overlay tone-hr">
      <div className="hr-ring">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="52" className="track" />
          <circle cx="60" cy="60" r="52" className="arc" style={{ strokeDashoffset: 327 * (1 - (result ? 1 : pct)) }} />
        </svg>
        <video ref={videoRef} className="hr-video" muted playsInline />
        <b className="mono">{result ? result.bpm : "♥"}</b>
      </div>
      <h2>{result ? `${result.bpm} bpm` : "Heart-rate check"}</h2>
      {!result && !error && (
        <p>
          {!p || p.phase === "starting"
            ? "Opening the camera…"
            : p.phase === "no-finger"
              ? `Cover the rear camera${p.torch ? " and the flash" : ""} with your fingertip.`
              : `Keep still… ${Math.ceil(p.total - p.seconds)} s`}
        </p>
      )}
      {!result && <svg className="hr-wave" viewBox="0 0 300 80"><polyline points={points} /></svg>}
      {result && <p>Signal quality {Math.round(result.quality * 100)}%. Sent to the cloud: only the number, never the video.</p>}
      {error && <div className="dv-error">{error}</div>}
      <small className="dv-tip">Approximate reading from the camera, not a medical device.</small>
      <div className="hr-btns">
        {(result || error) && <button className="dv-recover" onClick={start}>Measure again</button>}
        <button className="dv-cta" onClick={onClose}>{result ? "Done" : "Cancel"}</button>
      </div>
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

function Metric(props: { icon: string; label: string; value: string; unit?: string; bar?: number; alert?: boolean; wide?: boolean }) {
  return (
    <div className={`dv-metric ${props.alert ? "alert" : ""} ${props.wide ? "wide" : ""}`}>
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

function fmtDur(ms: number) {
  const m = Math.round(ms / 60000);
  return m < 1 ? `${Math.round(ms / 1000)} s` : m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
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
