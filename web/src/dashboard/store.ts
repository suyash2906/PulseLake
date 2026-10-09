// Fleet state for the dashboard, fed by live MQTT messages.
// Plain class + useSyncExternalStore; UI notifications are throttled to ~5/s.
import { useSyncExternalStore } from "react";
import { SLOTS, type Alert, type DeviceEvent, type PresenceEvent, type Telemetry } from "../shared/types";

export const SIGNAL_LOST_MS = 5000;
const HISTORY = 120; // points kept per device for sparklines/charts

export type DeviceStatus = "WAITING" | "OK" | "WARNING" | "FAILED" | "SIGNAL_LOST" | "OFFLINE" | "LEFT";

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
  hist: { t: number; temp: number; vib: number; hum: number; bat: number; volt: number }[];
  ori: [number, number, number][]; // queue of orientation samples to replay
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
  devices: Record<string, DeviceView>;
  feed: FeedItem[];
  alerts: Alert[];
  totalMsgs: number;
  msgsPerSec: number;
  now: number;
}

let feedSeq = 0;

class FleetStore {
  private devices: Record<string, DeviceView> = Object.fromEntries(
    SLOTS.map((id) => [id, { id, presence: "unknown", hist: [], ori: [] } as DeviceView]),
  );
  private feed: FeedItem[] = [];
  private alerts: Alert[] = [];
  private totalMsgs = 0;
  private recent: number[] = [];
  private snapshot: FleetSnapshot = this.build();
  private listeners = new Set<() => void>();
  private dirty = false;
  /** raw message hook (used by the pipeline animation) */
  onMessage?: (kind: "telemetry" | "event" | "alert" | "presence", deviceId?: string) => void;

  constructor() {
    setInterval(() => {
      // re-render at least every 500ms so "SIGNAL LOST" timers update
      this.dirty = true;
      this.flush();
    }, 500);
    setInterval(() => this.flush(), 200);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;

  private dev(id: string): DeviceView {
    return (this.devices[id] ??= { id, presence: "unknown", hist: [], ori: [] });
  }

  telemetry(m: Telemetry) {
    const now = Date.now();
    const d = this.dev(m.id);
    const wasSilent = d.lastAt === undefined || now - d.lastAt > SIGNAL_LOST_MS;
    d.last = m;
    d.lastAt = now;
    d.latencyMs = Math.max(0, now - m.ts);
    d.owner = m.owner;
    d.profile = m.profile;
    d.left = false;
    if (d.presence !== "online") d.presence = "online"; // data proves it is connected
    d.hist.push({ t: now, temp: m.temp, vib: m.vibPeak, hum: m.hum, bat: m.bat, volt: m.volt });
    if (d.hist.length > HISTORY) d.hist.splice(0, d.hist.length - HISTORY);
    d.ori.push(...m.ori);
    if (d.ori.length > 60) d.ori.splice(0, d.ori.length - 60);
    if (wasSilent && d.hist.length > 1) this.push({ deviceId: m.id, tone: "ok", icon: "📶", text: `${m.id} signal restored` });
    this.totalMsgs++;
    this.recent.push(now);
    this.onMessage?.("telemetry", m.id);
    this.dirty = true;
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
    }
    this.onMessage?.("event", e.id);
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
      this.push({
        deviceId: p.clientId,
        tone: graceful ? "info" : "fail",
        icon: graceful ? "☁️" : "🚨",
        text: `AWS IoT: ${p.clientId} disconnected (${p.disconnectReason ?? "unknown"})`,
      });
    }
    this.onMessage?.("presence", p.clientId);
    this.dirty = true;
  }

  alert(a: Alert) {
    const i = this.alerts.findIndex((x) => x.alertId === a.alertId);
    if (i >= 0) this.alerts[i] = a;
    else this.alerts.unshift(a);
    this.alerts = this.alerts.slice(0, 100);
    this.onMessage?.("alert", a.deviceId);
    this.dirty = true;
  }

  setAlerts(list: Alert[]) {
    const known = new Set(this.alerts.map((a) => a.alertId));
    this.alerts = [...this.alerts, ...list.filter((a) => !known.has(a.alertId))]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 100);
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
    for (const [k, v] of Object.entries(this.devices ?? {})) devices[k] = { ...v, hist: v.hist, ori: v.ori };
    return {
      devices,
      feed: [...(this.feed ?? [])],
      alerts: [...(this.alerts ?? [])],
      totalMsgs: this.totalMsgs ?? 0,
      msgsPerSec: (this.recent?.length ?? 0) / 5,
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
