// Fleet state for the dashboard, fed by live MQTT messages (or by the time-machine replay).
// Plain class + useSyncExternalStore; UI notifications are throttled to ~5/s.
import { useSyncExternalStore } from "react";
import { fromW3C, type Quat } from "../shared/quat";
import { SLOTS, type ActionLog, type Alert, type DeviceEvent, type Health, type PresenceEvent, type Telemetry } from "../shared/types";

export const SIGNAL_LOST_MS = 5000;
const HISTORY = 120; // points kept per device for sparklines/charts
const RATE_HISTORY = 120; // seconds of msgs/sec history
/**
 * Orientation samples arrive in 1-second batches; each is played back this long after it was
 * measured (corrected for clock offset), so the twin always has the next sample to move toward.
 */
export const PLAYBACK_DELAY_MS = 1200;

export type DeviceStatus = "WAITING" | "OK" | "WARNING" | "FAILED" | "SIGNAL_LOST" | "OFFLINE" | "LEFT";
export type Mode = "live" | "replay";
export type MessageKind =
  | "telemetry"
  | "abnormal"
  | "event"
  | "alert"
  | "alert-critical"
  | "alert-lake"
  | "presence"
  | "action-push"
  | "action-escalate"
  | "action-command"
  | "action-other";

export interface DeviceView {
  id: string;
  owner?: string;
  profile?: string;
  last?: Telemetry;
  lastAt?: number; // dashboard receive time
  latencyMs?: number;
  presence: "unknown" | "online" | "offline";
  presenceReason?: string;
  presenceAt?: number;
  left?: boolean; // said GOODBYE (left / sleeping)
  hist: { t: number; temp: number; vib: number; hum: number; bat: number; volt: number; noise: number | null }[];
  pose: { t: number; q: Quat }[]; // orientation samples on the local clock, ready for playback
  offs: number[]; // recent (receive time - device time) values; their minimum = clock offset
  hr?: { bpm: number; quality: number; at: number }; // last camera heart-rate check
  loc?: { lat: number; lon: number; acc: number; at: number }; // last shared GPS position
}

/** virtual (load-test) devices are aggregated, not shown as cards */
export interface SimView {
  health: Health;
  temp: number;
  lastAt: number;
}

export interface FeedItem {
  id: number;
  ts: number;
  deviceId?: string;
  tone: "ok" | "warn" | "fail" | "info";
  icon: string;
  text: string;
}

export interface FleetSnapshot {
  mode: Mode;
  devices: Record<string, DeviceView>;
  sims: Record<string, SimView>;
  feed: FeedItem[];
  alerts: Alert[];
  actions: ActionLog[];
  totalMsgs: number;
  msgsPerSec: number;
  rateHistory: number[]; // msgs per second, oldest first
  now: number;
}

let feedSeq = 0;

/** A usable alert record (old or corrupted rows without device / type are ignored). */
function isAlert(a: Partial<Alert> | null | undefined): a is Alert {
  return !!a && typeof a.alertId === "string" && typeof a.deviceId === "string" && typeof a.type === "string" && typeof a.ts === "number";
}
const isSim = (id: string) => id.startsWith("SIM_");
const emptyDevices = () =>
  Object.fromEntries(SLOTS.map((id) => [id, { id, presence: "unknown", hist: [], pose: [], offs: [] } as DeviceView]));

class FleetStore {
  mode: Mode = "live";
  private devices: Record<string, DeviceView> = emptyDevices();
  private sims: Record<string, SimView> = {};
  private feed: FeedItem[] = [];
  private alerts: Alert[] = [];
  private actions: ActionLog[] = [];
  private totalMsgs = 0;
  private recent: number[] = [];
  private rateHistory: number[] = new Array(RATE_HISTORY).fill(0);
  private secondCount = 0;
  private snapshot: FleetSnapshot = this.build();
  private listeners = new Set<() => void>();
  private messageListeners = new Set<(kind: MessageKind, deviceId?: string) => void>();
  private dirty = false;

  constructor() {
    setInterval(() => {
      // re-render at least every 500ms so "SIGNAL LOST" timers update
      this.dirty = true;
      this.flush();
    }, 500);
    setInterval(() => this.flush(), 200);
    setInterval(() => {
      this.rateHistory.push(this.secondCount);
      this.rateHistory.shift();
      this.secondCount = 0;
    }, 1000);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;

  /** every message (used by the pipeline animation) */
  onMessage(fn: (kind: MessageKind, deviceId?: string) => void) {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }
  private emit(kind: MessageKind, deviceId?: string) {
    this.messageListeners.forEach((fn) => fn(kind, deviceId));
  }

  /** switch between live MQTT and the time-machine replay (clears the screen) */
  setMode(mode: Mode) {
    this.mode = mode;
    this.devices = emptyDevices();
    this.sims = {};
    this.feed = [];
    this.alerts = [];
    this.actions = [];
    this.recent = [];
    this.dirty = true;
  }

  private dev(id: string): DeviceView {
    return (this.devices[id] ??= { id, presence: "unknown", hist: [], pose: [], offs: [] });
  }

  telemetry(m: Telemetry) {
    const now = Date.now();
    this.totalMsgs++;
    this.secondCount++;
    this.recent.push(now);
    const abnormal = m.health !== "OK" || m.temp > 55 || m.fault !== "NONE";
    this.emit(abnormal ? "abnormal" : "telemetry", m.id);
    this.dirty = true;

    if (isSim(m.id)) {
      this.sims[m.id] = { health: m.health, temp: m.temp, lastAt: now };
      return;
    }
    const d = this.dev(m.id);
    const wasSilent = d.lastAt === undefined || now - d.lastAt > SIGNAL_LOST_MS;
    d.last = m;
    d.lastAt = now;
    d.latencyMs = Math.max(0, now - m.ts);
    d.owner = m.owner;
    d.profile = m.profile;
    d.left = false;
    if (d.presence !== "online") d.presence = "online"; // data proves it is connected
    if (typeof m.lat === "number" && typeof m.lon === "number") d.loc = { lat: m.lat, lon: m.lon, acc: m.gacc ?? 0, at: now };
    d.hist.push({ t: now, temp: m.temp, vib: m.vibPeak, hum: m.hum, bat: m.bat, volt: m.volt, noise: m.noise ?? null });
    if (d.hist.length > HISTORY) d.hist.splice(0, d.hist.length - HISTORY);
    this.queuePose(d, m, now);
    if (wasSilent && d.hist.length > 1) this.push({ deviceId: m.id, tone: "ok", icon: "📶", text: `${m.id} signal restored` });
  }

  /** Put this message's orientation samples on the local clock for smooth, exact playback. */
  private queuePose(d: DeviceView, m: Telemetry, now: number) {
    const add = (t: number, q: Quat) => {
      const last = d.pose[d.pose.length - 1];
      if (!last || t > last.t) d.pose.push({ t, q });
    };
    if (m.q?.length && m.qt0) {
      // receive time minus device time of the newest sample = network delay + clock difference;
      // the smallest value seen recently is the best estimate of the pure clock difference
      d.offs.push(now - (m.qt0 + m.q[m.q.length - 1][0]));
      if (d.offs.length > 30) d.offs.shift();
      const offset = Math.min(...d.offs);
      for (const s of m.q) add(m.qt0 + s[0] + offset + PLAYBACK_DELAY_MS, [s[1], s[2], s[3], s[4]]);
    } else if (m.ori?.length) {
      // first-version messages (Euler angles at 10 Hz, no timestamps)
      m.ori.forEach((o, i) => add(now - (m.ori!.length - 1 - i) * 100 + PLAYBACK_DELAY_MS, fromW3C(o[0], o[1], o[2])));
    }
    // a fast replay can outrun real time: keep at most ~4 s queued
    if (d.pose.length > 80) d.pose.splice(0, d.pose.length - 80);
  }

  event(e: DeviceEvent) {
    const d = this.dev(e.id);
    d.owner = e.owner;
    d.profile = e.profile;
    if (e.type === "ONLINE") {
      d.left = false;
      this.push({ deviceId: e.id, tone: "ok", icon: "🟢", text: `${e.id} (${e.owner}) joined the fleet` });
    } else if (e.type === "GOODBYE") {
      d.left = true;
      this.push({ deviceId: e.id, tone: "info", icon: "👋", text: `${e.id} left (graceful disconnect)` });
    } else if (e.type === "FAULT_INJECTED") {
      this.push({ deviceId: e.id, tone: "warn", icon: "🧪", text: `${e.owner} injected ${e.fault} on ${e.id}` });
    } else if (e.type === "FAULT_CLEARED") {
      this.push({ deviceId: e.id, tone: "ok", icon: "🛠️", text: `${e.owner} cleared ${e.fault} on ${e.id}` });
    } else if (e.type === "FALL_DETECTED") {
      this.push({ deviceId: e.id, tone: "fail", icon: "🚨", text: `FALL: ${e.owner} (${e.id}) did not answer "Are you OK?" - impact ${e.impactG ?? "?"} g` });
    } else if (e.type === "FALL_CANCELLED") {
      this.push({ deviceId: e.id, tone: "warn", icon: "🙋", text: `${e.owner} (${e.id}) fall detected but cancelled: "I'm OK" (false alarm)` });
    } else if (e.type === "FALL_RESOLVED") {
      this.push({ deviceId: e.id, tone: "ok", icon: "💚", text: `${e.owner} (${e.id}) confirmed OK after the fall` });
    } else if (e.type === "SOS") {
      this.push({ deviceId: e.id, tone: "fail", icon: "🆘", text: `SOS pressed by ${e.owner} (${e.id})` });
    } else if (e.type === "SOS_CLEARED") {
      this.push({ deviceId: e.id, tone: "ok", icon: "✋", text: `${e.owner} (${e.id}) cancelled the SOS` });
    } else if (e.type === "FALL_RECOVERED") {
      this.push({ deviceId: e.id, tone: "warn", icon: "💛", text: `${e.owner} (${e.id}) fell but got up and walked (impact ${e.impactG ?? "?"} g)` });
    } else if (e.type === "HR_CHECK" && e.bpm) {
      d.hr = { bpm: e.bpm, quality: e.quality ?? 0, at: Date.now() };
      this.push({ deviceId: e.id, tone: "info", icon: "❤️", text: `${e.owner} measured heart rate: ${e.bpm} bpm (camera, quality ${Math.round((e.quality ?? 0) * 100)}%)` });
    } else if (e.type === "CHECK_OK") {
      this.push({ deviceId: e.id, tone: "ok", icon: "🙋", text: `${e.owner} answered "I'm OK" on ${e.id}` });
    }
    this.emit("event", e.id);
    this.dirty = true;
  }

  /** an action the platform took (push, escalation, device command, acknowledgement) */
  action(a: ActionLog) {
    this.actions.unshift(a);
    if (this.actions.length > 120) this.actions.length = 120;
    const who = a.owner || a.deviceId || "";
    const text =
      a.action === "push" ? `Push ${a.status} → ${a.target}${a.level ? ` (level ${a.level})` : ""}: ${a.detail ?? ""}`
      : a.action === "escalate" ? `Escalation: ${a.detail}`
      : a.action === "ack" ? `✋ ${a.detail}`
      : a.action === "command" ? `Command → ${a.target}: ${a.detail}`
      : a.action === "unanswered" ? `UNANSWERED: ${who} - ${a.detail}`
      : a.action === "email" ? `Email: ${a.detail}`
      : null;
    if (text) {
      const tone = a.status === "failed" || a.action === "unanswered" ? "fail" : a.action === "ack" ? "ok" : "info";
      this.push({ deviceId: a.deviceId, tone, icon: a.action === "push" ? "📲" : a.action === "escalate" ? "🪜" : a.action === "command" ? "↩️" : "⚡", text });
    }
    this.emit(a.action === "push" && a.status === "sent" ? "action-push" : a.action === "escalate" ? "action-escalate" : a.action === "command" ? "action-command" : "action-other", a.deviceId);
    this.dirty = true;
  }

  setActions(list: ActionLog[]) {
    const seen = new Set(this.actions.map((a) => `${a.ts}${a.action}${a.target}`));
    this.actions = [...this.actions, ...list.filter((a) => !seen.has(`${a.ts}${a.action}${a.target}`))].sort((a, b) => b.ts - a.ts).slice(0, 120);
    this.dirty = true;
  }

  presence(p: PresenceEvent) {
    if (!p.clientId.startsWith("PHONE_")) return;
    const d = this.dev(p.clientId);
    if (d.presenceAt && p.timestamp < d.presenceAt) return; // out of order
    d.presenceAt = p.timestamp;
    if (p.eventType === "connected") {
      d.presence = "online";
      d.presenceReason = undefined;
      this.push({ deviceId: p.clientId, tone: "ok", icon: "☁️", text: `AWS IoT: ${p.clientId} connected` });
    } else {
      d.presence = "offline";
      d.presenceReason = p.disconnectReason;
      // browsers close sockets politely even when the app dies: only a GOODBYE means "planned"
      const graceful = d.left || p.disconnectReason === "DUPLICATE_CLIENTID";
      // how long after the last message did AWS notice? (keep-alive measurement for the report)
      const after = d.lastAt ? ` - detected ${Math.round((Date.now() - d.lastAt) / 1000)} s after its last message` : "";
      this.push({
        deviceId: p.clientId,
        tone: graceful ? "info" : "fail",
        icon: graceful ? "☁️" : "🚨",
        text: `AWS IoT: ${p.clientId} disconnected (${p.disconnectReason ?? "unknown"})${graceful ? "" : after}`,
      });
    }
    this.emit("presence", p.clientId);
    this.dirty = true;
  }

  alert(a: Alert) {
    if (!isAlert(a)) return; // never let one malformed record take the dashboard down
    const i = this.alerts.findIndex((x) => x.alertId === a.alertId);
    if (i >= 0) this.alerts[i] = a;
    else this.alerts.unshift(a);
    this.alerts = this.alerts.slice(0, 150);
    this.emit(a.source === "LAKE_RULE" && a.status === "ACTIVE" ? "alert-lake" : a.severity === "CRITICAL" && a.status === "ACTIVE" ? "alert-critical" : "alert", a.deviceId);
    this.dirty = true;
  }

  setAlerts(list: Alert[]) {
    const known = new Set(this.alerts.map((a) => a.alertId));
    this.alerts = [...this.alerts, ...list.filter((a) => isAlert(a) && !known.has(a.alertId))]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 150);
    this.dirty = true;
  }

  info(text: string, tone: FeedItem["tone"] = "info", icon = "ℹ️") {
    this.push({ tone, icon, text });
    this.dirty = true;
  }

  private push(item: Omit<FeedItem, "id" | "ts">) {
    this.feed.unshift({ ...item, id: ++feedSeq, ts: Date.now() });
    if (this.feed.length > 80) this.feed.length = 80;
  }

  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.snapshot = this.build();
    this.listeners.forEach((fn) => fn());
  }

  private build(): FleetSnapshot {
    const now = Date.now();
    this.recent = (this.recent ?? []).filter((t) => now - t < 5000);
    const devices: Record<string, DeviceView> = {};
    for (const [k, v] of Object.entries(this.devices ?? {})) devices[k] = { ...v, hist: v.hist, pose: v.pose };
    return {
      mode: this.mode ?? "live",
      devices,
      sims: { ...(this.sims ?? {}) },
      feed: [...(this.feed ?? [])],
      alerts: [...(this.alerts ?? [])],
      actions: [...(this.actions ?? [])],
      totalMsgs: this.totalMsgs ?? 0,
      msgsPerSec: (this.recent?.length ?? 0) / 5,
      rateHistory: [...(this.rateHistory ?? [])],
      now,
    };
  }
}

export const fleet = new FleetStore();

export function useFleet(): FleetSnapshot {
  return useSyncExternalStore(fleet.subscribe, fleet.getSnapshot);
}

export function statusOf(d: DeviceView, now: number): DeviceStatus {
  if (d.left && d.presence !== "online") return "LEFT";
  if (d.presence === "offline") return d.left ? "LEFT" : "OFFLINE";
  if (!d.lastAt) return "WAITING";
  if (now - d.lastAt > SIGNAL_LOST_MS) return d.left ? "LEFT" : "SIGNAL_LOST";
  return (d.last?.health ?? "OK") as DeviceStatus;
}
