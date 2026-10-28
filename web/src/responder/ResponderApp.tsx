// PulseLake Responder: the phone of the person who RECEIVES the actions - a son or daughter,
// a carer, a supervisor. Pair once with a code from the monitored phone; get push alerts even
// when this app is closed; acknowledge ("I'm handling it"), call, navigate.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Brand } from "../shared/Logo";
import { MiniMap, type MapPoint } from "../shared/MiniMap";
import { loadConfig } from "../shared/awsIot";
import { apiCall } from "../shared/http";
import { profileOf, type Activity, type Alert } from "../shared/types";
import { enablePush, pushSupport, registerWorker } from "./push";

const TOKEN_KEY = "pulselake.responderToken";
const NAME_KEY = "pulselake.responderName";

interface DeviceState {
  deviceId: string;
  level: number;
  pairedOwner: string;
  ownerPhone?: string;
  owner?: string;
  profile?: string;
  online?: boolean;
  lastSeen?: number;
  bat?: number;
  chg?: boolean;
  stepsDay?: number;
  act?: Activity;
  lastMoveAt?: number;
  hr?: number;
  hrAt?: number;
  lat?: number;
  lon?: number;
  gacc?: number;
  locAt?: number;
  activeTypes: string[];
}

interface Me {
  rid: string;
  name: string;
  push: boolean;
  devices: DeviceState[];
  alerts: Alert[];
  serverTime: number;
}

export function ResponderApp() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [token, setToken] = useState<string | null>(() => read(TOKEN_KEY));
  const [pairing, setPairing] = useState(() => !read(TOKEN_KEY) || params.has("code"));

  useEffect(() => {
    void registerWorker().catch(() => {});
  }, []);

  if (!token || pairing) {
    return (
      <PairScreen
        initialCode={params.get("code") ?? ""}
        token={token}
        onPaired={(t) => {
          if (t) {
            write(TOKEN_KEY, t);
            setToken(t);
          }
          history.replaceState(null, "", "/responder.html");
          setPairing(false);
        }}
        onCancel={token ? () => setPairing(false) : undefined}
      />
    );
  }
  return (
    <Home
      token={token}
      focusAlert={params.get("alert")}
      onPairMore={() => setPairing(true)}
      onSignedOut={() => {
        write(TOKEN_KEY, "");
        setToken(null);
      }}
    />
  );
}

// ======================================================================== pairing
function PairScreen({ initialCode, token, onPaired, onCancel }: { initialCode: string; token: string | null; onPaired: (token: string | null) => void; onCancel?: () => void }) {
  const [code, setCode] = useState(initialCode.replace(/\D/g, ""));
  const [name, setName] = useState(() => read(NAME_KEY) ?? "");
  const [level, setLevel] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pair = async () => {
    setBusy(true);
    setError("");
    try {
      write(NAME_KEY, name.trim());
      const r = await apiCall<{ token: string | null; device: { deviceId: string; owner: string } }>("/pair", {
        body: { code, name: name.trim(), level },
        token: token ?? undefined,
      });
      onPaired(r.token);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setBusy(false);
    }
  };
  return (
    <div className="rs-wrap">
      <header className="rs-top">
        <Brand subtitle="Responder" />
      </header>
      <section className="rs-hero">
        <h1>Look after someone</h1>
        <p>Pair with a PulseLake phone (a parent, a worker, a device). When its rules fire, for example a fall, no movement or leaving a safe zone, this phone is alerted, even when the app is closed.</p>
      </section>
      <label className="rs-label">Pairing code (shown on the monitored phone)</label>
      <input className="rs-input code mono" inputMode="numeric" maxLength={7} placeholder="123 456" value={code.replace(/(\d{3})(\d)/, "$1 $2")} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
      <label className="rs-label">Your name (they will see it when you respond)</label>
      <input className="rs-input" maxLength={30} placeholder="e.g. Rahul (son)" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="rs-label">Your role</label>
      <div className="rs-seg">
        <button className={level === 1 ? "on" : ""} onClick={() => setLevel(1)}>
          <b>First contact</b>
          <small>alerted immediately</small>
        </button>
        <button className={level === 2 ? "on" : ""} onClick={() => setLevel(2)}>
          <b>Backup</b>
          <small>alerted if nobody answers in 60 s</small>
        </button>
      </div>
      {error && <div className="rs-error">{error}</div>}
      <button className="rs-cta" disabled={code.length !== 6 || !name.trim() || busy} onClick={pair}>
        {busy ? "Pairing…" : "Pair"}
      </button>
      {onCancel && <button className="rs-link" onClick={onCancel}>Cancel</button>}
    </div>
  );
}

// ======================================================================== home
function Home({ token, focusAlert, onPairMore, onSignedOut }: { token: string; focusAlert: string | null; onPairMore: () => void; onSignedOut: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState(focusAlert);
  const [, tick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const r = await apiCall<Me>("/responder/me", { token });
      setMe(r);
      setError("");
    } catch (e: any) {
      if (/not paired|unknown or revoked/.test(e?.message ?? "")) onSignedOut();
      else setError(e?.message ?? String(e));
    }
  }, [token, onSignedOut]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), 5000);
    const clock = setInterval(() => tick((n) => n + 1), 1000);
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === "push") void refresh();
      if (ev.data?.type === "open") {
        const id = new URL(ev.data.url, location.origin).searchParams.get("alert");
        if (id) setFocus(id);
        void refresh();
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMsg);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(t);
      clearInterval(clock);
      navigator.serviceWorker?.removeEventListener("message", onMsg);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);

  if (!me) {
    return (
      <div className="rs-wrap">
        <header className="rs-top"><Brand subtitle="Responder" /></header>
        <div className="rs-loading">{error || "Loading…"}</div>
      </div>
    );
  }

  const skew = me.serverTime - Date.now();
  const now = Date.now() + skew;
  const active = me.alerts
    .filter((a) => a.status === "ACTIVE" && a.severity !== "INFO")
    .sort((a, b) => sevRank(b) - sevRank(a) || b.ts - a.ts);
  const history = me.alerts.filter((a) => !active.includes(a)).slice(0, 12);

  return (
    <div className={`rs-wrap ${active.some((a) => a.severity === "CRITICAL") ? "alarm" : ""}`}>
      <header className="rs-top">
        <Brand subtitle="Responder" />
        <span className="rs-who">{me.name}</span>
      </header>

      {!me.push && <PushCard token={token} onDone={refresh} />}

      {active.map((a) => (
        <EmergencyCard key={a.alertId} a={a} me={me} now={now} token={token} focused={focus === a.alertId} onDone={refresh} />
      ))}

      {!active.length && (
        <div className="rs-allgood">
          <span>💚</span>
          <div>
            <b>All good</b>
            <small>No open alerts for the people and devices you look after.</small>
          </div>
        </div>
      )}

      <h2 className="rs-h2">Looking after</h2>
      {me.devices.map((d) => <DeviceCardR key={d.deviceId} d={d} now={now} />)}
      {!me.devices.length && <p className="rs-tip">No devices paired yet.</p>}

      {history.length > 0 && (
        <>
          <h2 className="rs-h2">Recent</h2>
          <ul className="rs-history">
            {history.map((a) => (
              <li key={a.alertId} className={`sev-${a.severity.toLowerCase()} ${focus === a.alertId ? "focus" : ""}`}>
                <b>{label(a)}</b>
                <span>{a.message}</span>
                <small className="mono">
                  {ago(now - a.ts)} · {a.status === "RESOLVED" ? "resolved" : "open"}
                  {a.ackBy ? ` · handled by ${a.ackBy}` : ""}
                  {a.escalation === "UNANSWERED" ? " · was unanswered" : ""}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}

      <footer className="rs-footer">
        <button onClick={onPairMore}>➕ Pair another</button>
        {me.push && <button onClick={() => apiCall("/responder/test", { method: "POST", body: {}, token }).catch((e) => alert(e.message))}>🔔 Test notification</button>}
      </footer>
      {error && <div className="rs-error">{error}</div>}
    </div>
  );
}

function PushCard({ token, onDone }: { token: string; onDone: () => void }) {
  const support = pushSupport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const enable = async () => {
    setBusy(true);
    setError("");
    try {
      const cfg = await loadConfig();
      if (!cfg.vapidPublicKey) throw new Error("Push is not configured on the server (vapidPublicKey missing).");
      const subscription = await enablePush(cfg.vapidPublicKey);
      await apiCall("/responder/subscribe", { body: { subscription }, token });
      onDone();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rs-card rs-push">
      <h3>🔔 Turn on alerts</h3>
      {support.ok ? (
        <>
          <p>Allow notifications so an emergency reaches you even when this app is closed.</p>
          <button className="rs-cta" disabled={busy} onClick={enable}>{busy ? "Enabling…" : "Enable notifications"}</button>
        </>
      ) : (
        <p>{support.reason}</p>
      )}
      {support.ios && !support.standalone && support.ok && <p className="rs-tip">iPhone: for reliable alerts, add this app to your Home Screen.</p>}
      {error && <div className="rs-error">{error}</div>}
    </section>
  );
}

function EmergencyCard({ a, me, now, token, focused, onDone }: { a: Alert; me: Me; now: number; token: string; focused: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const d = me.devices.find((x) => x.deviceId === a.deviceId);
  const lat = a.lat ?? d?.lat;
  const lon = a.lon ?? d?.lon;
  const mine = a.ackBy && a.ackBy === me.name;
  const ack = async () => {
    setBusy(true);
    try {
      await apiCall("/ack", { body: { alertId: a.alertId }, token });
      navigator.vibrate?.(80);
      onDone();
    } catch (e: any) {
      alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  const points: MapPoint[] = lat !== undefined && lon !== undefined ? [{ id: a.alertId, lat, lon, label: a.owner || a.deviceId, tone: "fail", accuracy: d?.gacc }] : [];
  return (
    <section className={`rs-emergency sev-${a.severity.toLowerCase()} ${focused ? "focus" : ""}`}>
      <div className="rs-em-head">
        <b>{label(a)}</b>
        <span className="mono">{ago(now - a.ts)}</span>
      </div>
      <p>{a.message}</p>
      <div className="rs-esc">
        {a.escalation === "ACKED" ? (
          <span className="ok">✅ {mine ? "You are" : `${a.ackBy} is`} handling it</span>
        ) : a.escalation === "UNANSWERED" ? (
          <span className="fail">‼️ Nobody has responded yet</span>
        ) : a.escalation === "LEVEL2" ? (
          <span className="warn">⏰ Escalated to everyone - no answer within 60 s</span>
        ) : a.escalation === "LEVEL1" ? (
          <span className="warn">⏳ Waiting for someone to respond…</span>
        ) : null}
      </div>
      {points.length > 0 && <MiniMap points={points} height={170} />}
      <div className="rs-actions">
        {a.escalation !== "ACKED" && (
          <button className="rs-ack" disabled={busy} onClick={ack}>✋ I'm handling it</button>
        )}
        {d?.ownerPhone && <a className="rs-call" href={`tel:${d.ownerPhone}`}>📞 Call {a.owner || "them"}</a>}
        <a className="rs-call sos" href="tel:112">🚑 Call 112</a>
        {points.length > 0 && <a className="rs-call" href={`https://www.google.com/maps/search/?api=1&query=${lat},${lon}`} target="_blank" rel="noreferrer">🧭 Navigate</a>}
      </div>
    </section>
  );
}

function DeviceCardR({ d, now }: { d: DeviceState; now: number }) {
  const p = profileOf(d.profile);
  const online = !!d.lastSeen && now - d.lastSeen < 90_000;
  const still = d.lastMoveAt ? now - d.lastMoveAt : null;
  const points: MapPoint[] =
    d.lat !== undefined && d.lon !== undefined && d.lat !== null ? [{ id: d.deviceId, lat: d.lat, lon: d.lon, label: d.owner || d.deviceId, tone: online ? "ok" : "off", accuracy: d.gacc }] : [];
  return (
    <section className="rs-card rs-dev">
      <div className="rs-dev-head">
        <span className="ico">{p?.icon ?? "📱"}</span>
        <div>
          <b>{d.owner || d.pairedOwner || d.deviceId}</b>
          <small>{p?.label ?? d.profile} · {d.deviceId.replace("_", " ")} · you are {d.level === 1 ? "first contact" : "backup"}</small>
        </div>
        <span className={`rs-dot ${online ? "on" : ""}`}>{online ? "LIVE" : d.lastSeen ? `seen ${ago(now - d.lastSeen)}` : "never"}</span>
      </div>
      <div className="rs-stats">
        <Stat icon="🚶" value={d.stepsDay !== undefined && d.stepsDay !== null ? d.stepsDay.toLocaleString() : "–"} label="steps today" />
        <Stat icon={d.act === "walk" ? "🚶" : d.act === "active" ? "🏃" : "🧍"} value={still === null ? "–" : still < 60_000 ? "now" : ago(still).replace(" ago", "")} label="since moving" />
        <Stat icon="❤️" value={d.hr ? `${d.hr}` : "–"} label={d.hrAt ? `bpm · ${ago(now - d.hrAt)}` : "bpm"} />
        <Stat icon={d.chg ? "🔌" : "🔋"} value={d.bat !== undefined && d.bat !== null ? `${d.bat}%` : "–"} label="battery" />
      </div>
      {d.activeTypes.length > 0 && <div className="rs-tags">{d.activeTypes.map((t) => <span key={t}>{t.replace(/_/g, " ")}</span>)}</div>}
      {points.length > 0 && <MiniMap points={points} height={140} />}
    </section>
  );
}

function Stat({ icon, value, label }: { icon: string; value: string; label: string }) {
  return (
    <div className="rs-stat">
      <span>{icon}</span>
      <b className="mono">{value}</b>
      <small>{label}</small>
    </div>
  );
}

const LABELS: Record<string, string> = {
  FALL: "🚨 Fall detected",
  SOS: "🆘 SOS",
  OFFLINE: "📴 Device offline",
  FALL_RECOVERED: "💛 Fell, got up again",
};
function label(a: Alert) {
  const who = a.owner || a.deviceId.replace("_", " ");
  return `${LABELS[a.type] ?? `${a.severity === "CRITICAL" ? "🚨" : a.severity === "WARNING" ? "⚠️" : "ℹ️"} ${a.ruleName || a.type.replace(/_/g, " ")}`} · ${who}`;
}
function sevRank(a: Alert) {
  return a.severity === "CRITICAL" ? 2 : a.severity === "WARNING" ? 1 : 0;
}
function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function read(k: string) {
  try {
    return localStorage.getItem(k) || null;
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
