// Time machine: replays a past window from the S3 data lake through the same fleet store
// the live MQTT feed uses, so the dashboard behaves exactly as it did at that moment.
import { useSyncExternalStore } from "react";
import type { ReplayData } from "./api";
import { fleet } from "./store";

type Item =
  | { at: number; kind: "telemetry"; data: ReplayData["telemetry"][number] }
  | { at: number; kind: "event"; data: ReplayData["events"][number] }
  | { at: number; kind: "alert"; data: ReplayData["alerts"][number] };

export interface ReplayState {
  active: boolean;
  playing: boolean;
  speed: number;
  start: number;
  end: number;
  position: number; // virtual time (epoch ms)
  counts: { telemetry: number; events: number; alerts: number };
}

const IDLE: ReplayState = {
  active: false,
  playing: false,
  speed: 1,
  start: 0,
  end: 0,
  position: 0,
  counts: { telemetry: 0, events: 0, alerts: 0 },
};

class ReplayEngine {
  state: ReplayState = IDLE;
  private items: Item[] = [];
  private cursor = 0;
  private timer: number | undefined;
  private lastTick = 0;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;
  private set(patch: Partial<ReplayState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  load(data: ReplayData) {
    this.stopTimer();
    this.items = [
      ...data.telemetry.map((t) => ({ at: t.ts, kind: "telemetry" as const, data: t })),
      ...data.events.map((e) => ({ at: e.ts, kind: "event" as const, data: e })),
      ...data.alerts.map((a) => ({ at: a.at ?? a.ts, kind: "alert" as const, data: a })),
    ].sort((a, b) => a.at - b.at);
    this.cursor = 0;
    fleet.setMode("replay");
    fleet.info(`Time machine: replaying ${new Date(data.start).toLocaleString()} from the S3 data lake`, "info", "⏪");
    this.set({
      active: true,
      playing: true,
      speed: 1,
      start: data.start,
      end: data.end,
      position: data.start,
      counts: { telemetry: data.telemetry.length, events: data.events.length, alerts: data.alerts.length },
    });
    this.startTimer();
  }

  togglePlay() {
    this.set({ playing: !this.state.playing });
  }
  setSpeed(speed: number) {
    this.set({ speed });
  }

  exit() {
    this.stopTimer();
    this.items = [];
    this.set(IDLE);
    fleet.setMode("live");
    fleet.info("Back to the live feed", "ok", "▶️");
  }

  private startTimer() {
    this.lastTick = performance.now();
    this.timer = window.setInterval(this.tick, 100);
  }
  private stopTimer() {
    clearInterval(this.timer);
  }

  private tick = () => {
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (!this.state.playing) return;
    const position = Math.min(this.state.end, this.state.position + dt * this.state.speed);
    while (this.cursor < this.items.length && this.items[this.cursor].at <= position) {
      const it = this.items[this.cursor++];
      if (it.kind === "telemetry") fleet.telemetry({ ...it.data, ts: Date.now() }); // ts=now: latency is not meaningful in replay
      else if (it.kind === "event") fleet.event(it.data);
      else fleet.alert(it.data);
    }
    this.set({ position, playing: position < this.state.end });
  };
}

export const replay = new ReplayEngine();

export function useReplay(): ReplayState {
  return useSyncExternalStore(replay.subscribe, replay.getState);
}
