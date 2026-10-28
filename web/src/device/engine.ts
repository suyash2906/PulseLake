// The phone-side "IoT firmware": owns the MQTT connection, the publish loop,
// simulated environment sensors and fault injection. The React UI only renders
// EngineState and calls the public methods.
import { connectIot, loadConfig, type ConnState, type IotConnection } from "../shared/awsIot";
import { apiCall } from "../shared/http";
import {
  FAULTS,
  TOPICS,
  type Activity,
  type Command,
  type DeviceEvent,
  type Fault,
  type Health,
  type Profile,
  type Telemetry,
} from "../shared/types";
import { readout } from "../shared/quat";
import { BackgroundKeeper, type BackgroundState } from "./background";
import { FallDetector, type FallEventInfo, type FallThresholds } from "./fall";
import { measureHeartRate, type HrProgress } from "./heartRate";
import { Location, type Fix, type LocationMode } from "./location";
import { NoiseMeter } from "./noise";
import { Pedometer } from "./pedometer";
import { Sensors, round } from "./sensors";
import { TraceRecorder, type Trace } from "./trace";

export type Overlay = null | "CRASH" | "NETWORK_DROP" | "SLEEP" | "LOCATE" | "FALL_COUNTDOWN" | "FALL_SENT";

/** Something the cloud asked this phone to show (Rules & Actions engine). */
export interface CommandView {
  kind: "MESSAGE" | "ASK_OK";
  text: string;
  from?: string;
  until?: number; // ASK_OK deadline (epoch ms)
  ruleId?: string;
  alertId?: string;
}

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
  orient: { frontBack: number; leftRight: number; heading: number };
  fallCountdown: number; // seconds left on "Are you OK?"
  fallInfo: FallEventInfo | null;
  sos: boolean;
  noiseOn: boolean;
  noiseLevel: number | null; // live approx. dB(A)
  noiseError: string;
  sent: number;
  real: boolean;
  rate: number;
  overlay: Overlay;
  dropSecondsLeft: number;
  sleepInSeconds: number | null;
  // v3 sensors + actions
  stepsDay: number;
  act: Activity;
  stillSec: number;
  locMode: LocationMode;
  loc: Fix | null;
  locError: string;
  hr: { bpm: number; quality: number; at: number } | null;
  command: CommandView | null;
  helpFrom: string; // responder who acknowledged our emergency
  pair: { code: string; expiresAt: number; url: string } | null;
  pairError: string;
  longRun: boolean; // no auto-sleep (continuous monitoring)
  traces: number; // fall-candidate traces sent to the lake this session
  fallConfig: string; // which fall thresholds are active
  bg: BackgroundState; // background mode (screen off / other app)
  net: { rtt: number; dl: number } | null; // network quality (Network Information API)
  backFrom: number | null; // ms spent in the background, shown once when the person returns
}

const SLEEP_AFTER_MS = 10 * 60_000; // auto-sleep after 10 min without touch/movement (saves credits)
const LONG_RUN_KEY = "pulselake.longRun";
const RECOVERY_STEPS = 8; // walking this many steps during the countdown = the person got up
const SLEEP_WARNING_MS = 60_000;
const NETWORK_DROP_SECONDS = 20;
const FALL_COUNTDOWN_SECONDS = 15; // time to answer "Are you OK?" before the alert goes out

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
  private overheatRate = 1; // °C per second while OVERHEAT is injected
  private frozen: Telemetry | null = null;
  private lastTouch = Date.now();
  private wakeLock: any = null;
  private listeners = new Set<(s: EngineState) => void>();
  private fall = new FallDetector((info) => this.onFall(info));
  private noise = new NoiseMeter();
  private pedometer = new Pedometer();
  private location = new Location();
  private traces = new TraceRecorder((t) => this.onTrace(t));
  private fallTimer: number | undefined;
  private fallStepsAtStart = 0;
  private lastFallWall = 0;
  private askTimer: number | undefined;
  private unsubMotion: (() => void) | null = null;
  /** keeps the tab alive in the background (see background.ts) */
  readonly background = new BackgroundKeeper();

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
      orient: { frontBack: 0, leftRight: 0, heading: 0 },
      fallCountdown: 0,
      fallInfo: null,
      sos: false,
      noiseOn: false,
      noiseLevel: null,
      noiseError: "",
      sent: 0,
      real: false,
      rate: 1,
      overlay: null,
      dropSecondsLeft: 0,
      sleepInSeconds: null,
      stepsDay: this.pedometer.stepsDay,
      act: "still",
      stillSec: 0,
      locMode: this.location.mode,
      loc: null,
      locError: "",
      hr: null,
      command: null,
      helpFrom: "",
      pair: null,
      pairError: "",
      longRun: readFlag(LONG_RUN_KEY, true), // monitoring runs until the tab is closed
      traces: 0,
      fallConfig: "default",
      bg: this.background.state,
      backFrom: null,
      net: netQuality(),
    };
    this.fall.bangNear = (t) => this.noise.bangNear(t);
    this.location.onChange = () =>
      this.set({ loc: this.location.last, locError: this.location.error, locMode: this.location.mode });
    this.background.onChange = (bg) => {
      const was = this.state.bg;
      if (was.hidden && !bg.hidden && was.hiddenSince) {
        // opening the phone again is itself activity; motion was unknown while hidden
        this.pedometer.lastMovement = Date.now();
        this.lastTouch = Date.now();
        this.set({ bg, backFrom: Date.now() - was.hiddenSince });
      } else {
        this.set({ bg });
      }
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
    this.location.start();
    this.unsubMotion = this.sensors.onMotionSample((t, x, y, z) => {
      this.fall.feed(t, x, y, z);
      this.pedometer.feed(t, x, y, z);
      this.traces.feed(t, x, y, z);
    });
    document.addEventListener("pointerdown", this.touched, { passive: true });
    // test hook: open device.html?debug=1 and call __pulselake.testFall() from the console
    if (new URLSearchParams(location.search).has("debug")) (window as any).__pulselake = this;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
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
    this.conn?.client.subscribe(
      [this.shadowTopic("update/delta"), this.shadowTopic("get/accepted"), TOPICS.commands(this.id)],
      { qos: 1 },
    );
    this.reportShadow();
    // persistent settings (tuned fall thresholds) live in the shadow's desired state
    setTimeout(() => this.conn?.client.publish(this.shadowTopic("get"), "", { qos: 1 }), 500);
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
        fall: this.fall.th,
        fallVersion: this.state.fallConfig,
        location: this.location.mode,
      },
    };
    if (clearDesired && Object.keys(clearDesired).length) state.desired = clearDesired;
    this.conn.client.publish(this.shadowTopic("update"), JSON.stringify({ state }), { qos: 1 });
  }

  private onMessage = (topic: string, payload: Uint8Array) => {
    let msg: any;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (topic === TOPICS.commands(this.id)) return this.onCommand(msg as Command);
    if (topic === this.shadowTopic("get/accepted")) {
      // on (re)connect: apply persistent settings only, never replay one-shot commands
      const desired = msg.state?.desired ?? {};
      if (desired.fall) this.applyFallConfig(desired.fall, desired.fallVersion);
      return;
    }
    if (topic !== this.shadowTopic("update/delta")) return;
    const delta = msg.state ?? {};
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
    if (delta.fall) this.applyFallConfig(delta.fall, delta.fallVersion);
    this.reportShadow(clear);
  };

  /** Over-the-air thresholds tuned by the cloud Accuracy Lab. */
  private applyFallConfig(th: Partial<FallThresholds>, version?: string) {
    this.fall.setThresholds(th);
    this.set({ fallConfig: version || "cloud-tuned" });
    this.reportShadow();
  }

  // ------------------------------------------------------------ actions sent by the cloud
  private onCommand(c: Command) {
    if (c.cmd === "SET_RATE" && c.rate) {
      const rate = Math.max(1, Math.min(5, Math.round(c.rate)));
      this.set({ rate });
      this.restartLoop();
      this.reportShadow();
      return;
    }
    if (c.cmd === "ALARM") return this.locate();
    if (c.cmd === "HELP_COMING") {
      this.set({ helpFrom: c.from || "Someone" });
      void this.background.notify(`✅ ${c.from || "Someone"} is responding`, "Your alert was received. Help is on the way.", "help", true);
      navigator.vibrate?.([120, 80, 120]);
      beep([0, 0.2], 660);
      return;
    }
    if (c.cmd === "MESSAGE") {
      this.set({ command: { kind: "MESSAGE", text: c.text ?? "", from: c.from, ruleId: c.ruleId } });
      void this.background.notify("💬 PulseLake", c.text ?? "", "message");
      navigator.vibrate?.([300, 150, 300]);
      beep([0, 0.3, 0.6], 990);
      return;
    }
    if (c.cmd === "ASK_OK") {
      const until = Date.now() + (c.timeoutSec ?? 300) * 1000;
      this.set({ command: { kind: "ASK_OK", text: c.text || "Are you OK?", until, ruleId: c.ruleId, alertId: c.alertId } });
      void this.background.notify("🙋 Are you OK?", "Open PulseLake and tap \"Yes, I'm OK\", or your responders will be told.", "ask-ok", true);
      clearInterval(this.askTimer);
      const nag = () => {
        if (this.state.command?.kind !== "ASK_OK") return clearInterval(this.askTimer);
        navigator.vibrate?.(500);
        beep([0, 0.4], 880);
      };
      nag();
      this.askTimer = window.setInterval(nag, 8000);
    }
  }

  /** answer to the cloud's ASK_OK, or dismiss a MESSAGE */
  answerCommand() {
    const c = this.state.command;
    clearInterval(this.askTimer);
    if (c?.kind === "ASK_OK") this.publishEvent("CHECK_OK", this.state.fault, { reason: c.ruleId });
    this.set({ command: null });
  }

  dismissHelp() {
    this.set({ helpFrom: "" });
  }

  /** Dashboard asked "where are you?" - flash, vibrate, beep. */
  locate() {
    this.set({ overlay: "LOCATE" });
    navigator.vibrate?.([300, 120, 300, 120, 600]);
    beep([0, 0.35, 0.7], 1320);
    setTimeout(() => this.state.overlay === "LOCATE" && this.set({ overlay: null }), 4000);
  }

  // ------------------------------------------------------------ fall detection + SOS (worker / elderly safety)
  get fallDetection() {
    return this.fall.enabled;
  }
  setFallDetection(on: boolean) {
    this.fall.enabled = on;
    this.set({});
  }

  /** The edge detector saw free fall -> impact -> stillness. Ask before alarming anyone. */
  private onFall(info: FallEventInfo) {
    this.lastFallWall = Date.now();
    if (this.state.overlay === "FALL_COUNTDOWN" || this.state.overlay === "FALL_SENT") return;
    this.set({ overlay: "FALL_COUNTDOWN", fallInfo: info, fallCountdown: FALL_COUNTDOWN_SECONDS, helpFrom: "" });
    this.location.setEmergency(true);
    this.fallStepsAtStart = this.pedometer.sessionSteps;
    clearInterval(this.fallTimer);
    const tick = () => {
      // got up and walked away: not an emergency, but the family may want to know
      if (this.pedometer.sessionSteps - this.fallStepsAtStart >= RECOVERY_STEPS) {
        clearInterval(this.fallTimer);
        this.publishEvent("FALL_RECOVERED", this.state.fault, { ...eventInfo(info), reason: "walked during the countdown" });
        this.set({ overlay: null, fallInfo: null, fallCountdown: 0 });
        this.location.setEmergency(false);
        return;
      }
      navigator.vibrate?.(400);
      beep([0], 880);
      const left = this.state.fallCountdown - 1;
      if (left <= 0) {
        clearInterval(this.fallTimer);
        this.publishEvent("FALL_DETECTED", this.state.fault, { ...eventInfo(info), ...this.location.share(true) });
        this.set({ overlay: "FALL_SENT", fallCountdown: 0 });
      } else {
        this.set({ fallCountdown: left });
      }
    };
    navigator.vibrate?.(400);
    beep([0], 880);
    this.fallTimer = window.setInterval(tick, 1000);
  }

  /** "I'm OK" during the countdown (false alarm) or after the alert was sent. */
  imOk() {
    clearInterval(this.fallTimer);
    const info = this.state.fallInfo;
    this.publishEvent(this.state.overlay === "FALL_SENT" ? "FALL_RESOLVED" : "FALL_CANCELLED", this.state.fault, info ? eventInfo(info) : undefined);
    this.set({ overlay: null, fallInfo: null, fallCountdown: 0, helpFrom: "" });
    if (!this.state.sos) this.location.setEmergency(false);
  }

  /** for testing without dropping a phone: device.html?debug=1, then __pulselake.testFall() */
  testFall() {
    this.onFall({ impactG: 3.1, freeFallMs: 420, angleChange: 85, stillSd: 0.03, confidence: 86 });
  }

  sos() {
    this.set({ sos: true, helpFrom: "" });
    this.location.setEmergency(true);
    navigator.vibrate?.([200, 100, 200]);
    this.publishEvent("SOS", this.state.fault, this.location.share(true));
  }
  clearSos() {
    this.set({ sos: false, helpFrom: "" });
    this.location.setEmergency(false);
    this.publishEvent("SOS_CLEARED");
  }

  // ------------------------------------------------------------ fall-candidate traces -> data lake
  private onTrace(t: Trace) {
    if (!this.conn) return;
    // did the live detector fire inside this window? (the Accuracy Lab compares)
    const detected = this.lastFallWall >= t.t0 + 2500 && this.lastFallWall <= t.t0 + 11_000;
    const msg = {
      v: 1,
      id: this.id,
      owner: this.owner,
      profile: this.profile.key,
      ts: t.t0,
      traceId: t.traceId,
      trigger: t.trigger,
      peakG: t.peakG,
      minG: t.minG,
      detected,
      fallConfig: this.state.fallConfig,
      samples: t.samples,
    };
    this.conn.client.publish(TOPICS.traces(this.id), JSON.stringify(msg), { qos: 1 });
    this.set({ traces: this.state.traces + 1 });
  }

  // ------------------------------------------------------------ location, heart rate, sharing
  setLocationMode(mode: LocationMode) {
    this.location.setMode(mode);
    this.set({ locMode: mode });
    this.reportShadow();
  }

  /** Save the current GPS position as a named zone (Home / Site / Depot) for geofence rules. */
  async saveZone(name: string, radiusM: number) {
    const f = this.location.last;
    if (!f) throw new Error("No GPS position yet");
    await apiCall("/zones", { body: { deviceId: this.id, name, lat: f.lat, lon: f.lon, radiusM } });
  }

  async measureHr(video: HTMLVideoElement, onProgress: (p: HrProgress) => void, signal: AbortSignal) {
    const r = await measureHeartRate(video, onProgress, signal);
    this.lastTouch = Date.now();
    this.set({ hr: { ...r, at: Date.now() } });
    this.publishEvent("HR_CHECK", this.state.fault, { bpm: r.bpm, quality: r.quality });
    return r;
  }

  /** One-time code a family member / supervisor types into the Responder app. */
  async startPairing(phone = "") {
    this.set({ pairError: "" });
    try {
      const cfg = await loadConfig();
      const r = await apiCall<{ code: string; expiresAt: number }>("/pair/start", {
        body: { deviceId: this.id, owner: this.owner, profile: this.profile.key, phone },
      });
      const base = cfg.webUrl ?? location.origin;
      this.set({ pair: { ...r, url: `${base}/responder.html?code=${r.code}` } });
    } catch (e: any) {
      this.set({ pairError: e?.message ?? String(e) });
    }
  }
  closePairing() {
    this.set({ pair: null });
  }

  setLongRun(on: boolean) {
    writeFlag(LONG_RUN_KEY, on);
    this.set({ longRun: on, sleepInSeconds: null });
  }

  // ------------------------------------------------------------ noise monitoring (audio never leaves the phone)
  async enableNoise() {
    try {
      await this.noise.start(); // must run inside the tap (microphone permission)
      this.set({ noiseOn: true, noiseError: "" });
    } catch (e: any) {
      this.set({ noiseOn: false, noiseError: e?.name === "NotAllowedError" ? "Microphone permission was denied" : String(e?.message ?? e) });
    }
  }
  disableNoise() {
    this.noise.stop();
    this.set({ noiseOn: false, noiseLevel: null });
  }
  get noiseCalibration() {
    return this.noise.calibration;
  }
  setNoiseCalibration(db: number) {
    this.noise.setCalibration(db);
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
    clearInterval(this.fallTimer);
    clearInterval(this.askTimer);
    this.unsubMotion?.();
    this.sensors.stop();
    this.noise.stop();
    this.location.stop();
    document.removeEventListener("pointerdown", this.touched);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    this.background.stop();
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
    if (fault === "OVERHEAT") this.overheatRate = Math.max(0.9, (76 - this.state.temp) / 25);
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
      stepsDay: out.stepsDay ?? this.state.stepsDay,
      act: out.act ?? this.state.act,
    });
  };

  private get emergency() {
    return this.state.sos || this.state.overlay === "FALL_COUNTDOWN" || this.state.overlay === "FALL_SENT";
  }

  private buildTelemetry(): Telemetry {
    const w = this.sensors.takeWindow();
    const a = this.pedometer.takeWindow();
    const s = this.state;
    const noise = (a: number) => (Math.random() - 0.5) * 2 * a;
    const dt = 1 / s.rate;

    let temp = s.temp + (this.tempTarget - s.temp) * 0.25 * dt + noise(0.15);
    let volt = 5 + noise(0.03);
    let bat = w.bat ?? (this.simBattery = Math.max(1, this.simBattery - 0.01 * dt));
    // ramp so the 70 °C limit is crossed ~25 s after injection -> the cloud's trend
    // prediction has time to warn first (predictive analytics demo)
    if (s.fault === "OVERHEAT") temp = Math.min(98, s.temp + this.overheatRate * (0.8 + Math.random() * 0.4) * dt);
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
      qt0: w.qt0,
      q: this.state.bg.hidden ? [] : w.q,
      ...this.noise.takeSecond(),
      steps: a.steps,
      stepsDay: a.stepsDay,
      // hidden pages get no motion events: movement is UNKNOWN, not "still"
      ...(this.state.bg.hidden ? { bg: true, mp: true } : { act: a.act, stillSec: a.stillSec }),
      ...this.location.share(this.emergency),
      // a sensor the original schema never had: it rides in the generic ext map, and the lake's
      // ETL promotes it to real columns the first time it sees it (schema evolution)
      ...(this.state.net ? { ext: { rtt: this.state.net.rtt, dl: this.state.net.dl } } : {}),
      sensors: w.real ? "real" : "simulated",
    };
  }

  private computeHealth(t: Telemetry): Health {
    const def = FAULTS.find((f) => f.key === t.fault);
    if (def?.severity === "FAILED" || t.temp > THRESHOLDS.temp || t.volt > THRESHOLDS.volt) return "FAILED";
    if (def || t.bat < THRESHOLDS.bat || t.vibPeak > THRESHOLDS.vibPeak) return "WARNING";
    return "OK";
  }

  private publishEvent(type: DeviceEvent["type"], fault: Fault = this.state.fault, extra?: Partial<DeviceEvent>) {
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
      ...extra,
    };
    this.conn.client.publish(TOPICS.events(this.id), JSON.stringify(ev), { qos: 1 });
  }

  // ------------------------------------------------------------ UI ticker, sleep, wake lock
  private tickUi = () => {
    const o = readout(this.sensors.liveQuat);
    const idleMs = Date.now() - Math.max(this.lastTouch, this.sensors.lastMovement);
    const left = SLEEP_AFTER_MS - idleMs;
    const canSleep = !this.state.longRun && !this.emergency && !this.state.command;
    const sleepInSeconds = canSleep && this.conn && left < SLEEP_WARNING_MS ? Math.max(0, Math.ceil(left / 1000)) : null;
    this.set({
      orient: { frontBack: round(o.frontBack, 0), leftRight: round(o.leftRight, 0), heading: round(o.heading, 0) },
      noiseLevel: this.noise.level,
      sleepInSeconds,
      stillSec: Math.round((Date.now() - this.pedometer.lastMovement) / 1000),
      act: this.pedometer.activity(),
      stepsDay: this.pedometer.stepsDay,
      net: netQuality(),
    });
    if (canSleep && this.conn && left <= 0) this.sleep();
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

  /** The tab is being closed (or the browser killed it): a planned leave, not a crash. */
  private onPageHide = (e: PageTransitionEvent) => {
    if (e.persisted) return; // kept in the back/forward cache, not closed
    this.publishEvent("GOODBYE", this.state.fault, { reason: "tab closed" });
  };

  dismissBackFrom() {
    this.set({ backFrom: null });
  }

  private async acquireWakeLock() {
    try {
      this.wakeLock = await (navigator as any).wakeLock?.request("screen");
    } catch {
      /* not supported / denied - fine */
    }
  }
}

/** Round-trip time (ms) and downlink (Mbps) estimated by the browser - Android Chrome only. */
function netQuality(): { rtt: number; dl: number } | null {
  const c = (navigator as any).connection;
  return c && typeof c.rtt === "number" && typeof c.downlink === "number" ? { rtt: c.rtt, dl: c.downlink } : null;
}

function eventInfo(i: FallEventInfo): Partial<DeviceEvent> {
  return { impactG: i.impactG, freeFallMs: i.freeFallMs, angleChange: i.angleChange, confidence: i.confidence };
}

function readFlag(k: string, fallback = false) {
  try {
    const v = localStorage.getItem(k);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writeFlag(k: string, on: boolean) {
  try {
    localStorage.setItem(k, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Short beeps through Web Audio (may be blocked until the user has tapped once). */
function beep(at: number[], hz: number) {
  try {
    const ctx = new AudioContext();
    at.forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.2, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.26);
    });
  } catch {
    /* audio blocked - fine */
  }
}