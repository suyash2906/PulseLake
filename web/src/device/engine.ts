// The phone-side "IoT firmware": owns the MQTT connection, the publish loop,
// simulated environment sensors and fault injection. The React UI only renders
// EngineState and calls the public methods.
import { connectIot, type ConnState, type IotConnection } from "../shared/awsIot";
import {
  FAULTS,
  TOPICS,
  type DeviceEvent,
  type Fault,
  type Health,
  type Profile,
  type Telemetry,
} from "../shared/types";
import { Sensors, round } from "./sensors";

export type Overlay = null | "CRASH" | "NETWORK_DROP" | "SLEEP" | "LOCATE";

export interface EngineState {
  conn: ConnState;
  connDetail?: string;
  fault: Fault;
  health: Health;
  temp: number;
  hum: number;
  volt: number;
  bat: number;
  chg: boolean;
  vib: number;
  vibPeak: number;
  tilt: [number, number];
  sent: number;
  real: boolean;
  rate: number;
  overlay: Overlay;
  dropSecondsLeft: number;
  sleepInSeconds: number | null;
}

const SLEEP_AFTER_MS = 10 * 60_000; // auto-sleep after 10 min without touch/movement (saves credits)
const SLEEP_WARNING_MS = 60_000;
const NETWORK_DROP_SECONDS = 20;

const THRESHOLDS = { temp: 70, volt: 6, bat: 10, vibPeak: 15 }; // same numbers the cloud rule uses

export class DeviceEngine {
  state: EngineState;
  private conn: IotConnection | null = null;
  private sensors = new Sensors();
  private loop: number | undefined;
  private ticker: number | undefined;
  private seq = 0;
  private tempTarget: number;
  private humTarget: number;
  private simBattery = 70 + Math.random() * 25;
  private frozen: Telemetry | null = null;
  private lastTouch = Date.now();
  private wakeLock: any = null;
  private listeners = new Set<(s: EngineState) => void>();

  constructor(
    readonly id: string,
    readonly owner: string,
    readonly profile: Profile,
  ) {
    this.tempTarget = profile.baseTemp;
    this.humTarget = profile.baseHum;
    this.state = {
      conn: "connecting",
      fault: "NONE",
      health: "OK",
      temp: profile.baseTemp,
      hum: profile.baseHum,
      volt: 5,
      bat: Math.round(this.simBattery),
      chg: false,
      vib: 0,
      vibPeak: 0,
      tilt: [0, 0],
      sent: 0,
      real: false,
      rate: 1,
      overlay: null,
      dropSecondsLeft: 0,
      sleepInSeconds: null,
    };
  }

  subscribe(fn: (s: EngineState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn(this.state));
  }

  // ------------------------------------------------------------ lifecycle
  async start() {
    this.sensors.start();
    document.addEventListener("pointerdown", this.touched, { passive: true });
    document.addEventListener("visibilitychange", this.onVisibility);
    await this.connect();
    this.ticker = window.setInterval(this.tickUi, 250);
  }

  private async connect() {
    this.set({ conn: "connecting" });
    this.conn = await connectIot({
      clientId: this.id,
      onState: (conn, connDetail) => this.set({ conn, connDetail }),
    });
    // fires on every (re)connect, after the handshake
    this.conn.client.on("connect", this.onOnline);
    this.conn.client.on("message", this.onMessage);
    this.restartLoop();
    void this.acquireWakeLock();
  }

  private onOnline = () => {
    this.publishEvent("ONLINE");
    this.conn?.client.subscribe(this.shadowTopic("update/delta"), { qos: 1 });
    this.reportShadow();
  };

  private restartLoop() {
    clearInterval(this.loop);
    this.loop = window.setInterval(this.publishTelemetry, 1000 / this.state.rate);
  }

  setRate(rate: number) {
    this.set({ rate });
    this.restartLoop();
    this.reportShadow();
  }

  // ------------------------------------------------------------ Device Shadow
  // reported = what the phone really is; desired = what the dashboard asks for.
  // AWS IoT sends the difference on .../shadow/update/delta.
  private shadowTopic(suffix: string) {
    return `$aws/things/${this.id}/shadow/${suffix}`;
  }

  private reportShadow(clearDesired?: Record<string, null>) {
    if (!this.conn) return;
    const state: any = {
      reported: {
        online: true,
        owner: this.owner,
        profile: this.profile.key,
        rate: this.state.rate,
        fault: this.state.fault,
        sensors: this.sensors.isReal ? "real" : "simulated",
      },
    };
    if (clearDesired && Object.keys(clearDesired).length) state.desired = clearDesired;
    this.conn.client.publish(this.shadowTopic("update"), JSON.stringify({ state }), { qos: 1 });
  }

  private onMessage = (topic: string, payload: Uint8Array) => {
    if (topic !== this.shadowTopic("update/delta")) return;
    let delta: any;
    try {
      delta = JSON.parse(new TextDecoder().decode(payload)).state ?? {};
    } catch {
      return;
    }
    const clear: Record<string, null> = {};
    if ([1, 2, 4].includes(delta.rate) && delta.rate !== this.state.rate) {
      this.set({ rate: delta.rate });
      this.restartLoop();
    }
    if (delta.fault === "NONE") {
      this.recover();
      clear.fault = null; // one-shot command: remove it from desired
    }
    if (delta.locate) {
      this.locate();
      clear.locate = null;
    }
    this.reportShadow(clear);
  };

  /** Dashboard asked "where are you?" - flash, vibrate, beep. */
  locate() {
    this.set({ overlay: "LOCATE" });
    navigator.vibrate?.([300, 120, 300, 120, 600]);
    try {
      const ctx = new AudioContext();
      [0, 0.35, 0.7].forEach((t) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 1320;
        g.gain.setValueAtTime(0.2, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.26);
      });
    } catch {
      /* audio blocked - fine */
    }
    setTimeout(() => this.state.overlay === "LOCATE" && this.set({ overlay: null }), 4000);
  }

  /** user pressed "Leave" */
  async disconnect() {
    this.publishEvent("GOODBYE");
    await new Promise((r) => setTimeout(r, 300));
    this.teardown(true);
  }

  private teardown(graceful: boolean) {
    clearInterval(this.loop);
    clearInterval(this.ticker);
    this.sensors.stop();
    document.removeEventListener("pointerdown", this.touched);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.conn?.close(graceful);
    this.conn = null;
    this.wakeLock?.release?.();
  }

  // ------------------------------------------------------------ controls
  setTempTarget(v: number) {
    this.tempTarget = v;
  }
  setHumTarget(v: number) {
    this.humTarget = v;
  }
  get targets() {
    return { temp: this.tempTarget, hum: this.humTarget };
  }

  inject(fault: Exclude<Fault, "NONE">) {
    if (fault === "CRASH") return this.crash();
    if (fault === "NETWORK_DROP") return this.networkDrop();
    this.frozen = null;
    this.set({ fault });
    this.publishEvent("FAULT_INJECTED");
    this.reportShadow();
  }

  recover() {
    if (this.state.fault === "NONE") return;
    const old = this.state.fault;
    this.frozen = null;
    this.set({ fault: "NONE" });
    this.publishEvent("FAULT_CLEARED", old);
    this.reportShadow();
  }

  /** Real failure: the socket just dies. No goodbye message - the cloud must notice on its own. */
  private crash() {
    clearInterval(this.loop);
    this.conn?.close(false);
    this.conn = null;
    this.set({ fault: "CRASH", overlay: "CRASH", conn: "offline" });
  }

  async reboot() {
    this.set({ overlay: null, fault: "NONE" });
    this.frozen = null;
    await this.connect();
  }

  private networkDrop() {
    clearInterval(this.loop);
    this.conn?.close(false);
    this.conn = null;
    this.set({ fault: "NETWORK_DROP", overlay: "NETWORK_DROP", conn: "offline", dropSecondsLeft: NETWORK_DROP_SECONDS });
    const t = window.setInterval(async () => {
      const left = this.state.dropSecondsLeft - 1;
      this.set({ dropSecondsLeft: left });
      if (left <= 0) {
        clearInterval(t);
        this.set({ overlay: null, fault: "NONE" });
        await this.connect();
      }
    }, 1000);
  }

  async wake() {
    this.lastTouch = Date.now();
    this.set({ overlay: null, sleepInSeconds: null });
    await this.connect();
  }

  // ------------------------------------------------------------ telemetry
  private publishTelemetry = () => {
    if (!this.conn || this.state.conn !== "online") return;
    const msg = this.frozen ?? this.buildTelemetry();
    if (this.state.fault === "SENSOR_FREEZE" && !this.frozen) {
      // a stuck sensor repeats the same reading; zero noise is what the cloud looks for
      this.frozen = { ...msg, vib: 0, vibPeak: 0 };
    }
    const out: Telemetry = { ...(this.frozen ?? msg), seq: ++this.seq, ts: Date.now(), fault: this.state.fault };
    out.health = this.computeHealth(out);
    this.conn.client.publish(TOPICS.telemetry(this.id), JSON.stringify(out), { qos: 0 });
    this.set({
      sent: this.state.sent + 1,
      temp: out.temp,
      hum: out.hum,
      volt: out.volt,
      bat: out.bat,
      chg: out.chg,
      vib: out.vib,
      vibPeak: out.vibPeak,
      health: out.health,
      real: out.sensors === "real",
    });
  };

  private buildTelemetry(): Telemetry {
    const w = this.sensors.takeWindow();
    const s = this.state;
    const noise = (a: number) => (Math.random() - 0.5) * 2 * a;
    const dt = 1 / s.rate;

    let temp = s.temp + (this.tempTarget - s.temp) * 0.25 * dt + noise(0.15);
    let volt = 5 + noise(0.03);
    let bat = w.bat ?? (this.simBattery = Math.max(1, this.simBattery - 0.01 * dt));
    if (s.fault === "OVERHEAT") temp = Math.min(98, s.temp + (2.5 + Math.random()) * dt);
    if (s.fault === "POWER_SURGE") {
      volt = 6.4 + Math.random() * 3;
      temp = s.temp + 0.4 * dt + noise(0.3);
    }
    if (s.fault === "BATTERY_CRITICAL") bat = 3;

    return {
      v: 1,
      id: this.id,
      owner: this.owner,
      profile: this.profile.key,
      seq: 0,
      ts: 0,
      rate: s.rate,
      health: "OK",
      fault: s.fault,
      temp: round(temp, 1),
      hum: round(Math.min(100, Math.max(0, s.hum + (this.humTarget - s.hum) * 0.3 * dt + noise(0.4))), 1),
      volt: round(volt, 2),
      bat: Math.round(bat),
      chg: w.chg,
      vib: w.vib,
      vibPeak: w.vibPeak,
      acc: w.acc,
      ori: w.ori,
      sensors: w.real ? "real" : "simulated",
    };
  }

  private computeHealth(t: Telemetry): Health {
    const def = FAULTS.find((f) => f.key === t.fault);
    if (def?.severity === "FAILED" || t.temp > THRESHOLDS.temp || t.volt > THRESHOLDS.volt) return "FAILED";
    if (def || t.bat < THRESHOLDS.bat || t.vibPeak > THRESHOLDS.vibPeak) return "WARNING";
    return "OK";
  }

  private publishEvent(type: DeviceEvent["type"], fault: Fault = this.state.fault) {
    if (!this.conn) return;
    const ev: DeviceEvent = {
      v: 1,
      id: this.id,
      owner: this.owner,
      profile: this.profile.key,
      ts: Date.now(),
      type,
      fault,
      health: this.state.health,
    };
    this.conn.client.publish(TOPICS.events(this.id), JSON.stringify(ev), { qos: 1 });
  }

  // ------------------------------------------------------------ UI ticker, sleep, wake lock
  private tickUi = () => {
    const [, beta, gamma] = this.sensors.liveOrientation;
    const idleMs = Date.now() - Math.max(this.lastTouch, this.sensors.lastMovement);
    const left = SLEEP_AFTER_MS - idleMs;
    const sleepInSeconds = this.conn && left < SLEEP_WARNING_MS ? Math.max(0, Math.ceil(left / 1000)) : null;
    this.set({ tilt: [round(beta, 0), round(gamma, 0)], sleepInSeconds });
    if (this.conn && left <= 0) this.sleep();
  };

  private sleep() {
    this.publishEvent("GOODBYE");
    clearInterval(this.loop);
    const conn = this.conn;
    this.conn = null;
    setTimeout(() => conn?.close(true), 300);
    this.set({ overlay: "SLEEP", conn: "offline", sleepInSeconds: null });
  }

  private touched = () => {
    this.lastTouch = Date.now();
  };

  private onVisibility = () => {
    if (document.visibilityState === "visible") void this.acquireWakeLock();
  };

  private async acquireWakeLock() {
    try {
      this.wakeLock = await (navigator as any).wakeLock?.request("screen");
    } catch {
      /* not supported / denied - fine */
    }
  }
}
