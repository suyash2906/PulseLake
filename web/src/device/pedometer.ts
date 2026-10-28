// On-phone step counter + activity recognition (plain signal processing, no AI).
//
// Walking makes the total acceleration |a| swing around gravity once per step.
//   1. smooth |a| (removes sensor jitter) and track its slow average (= gravity)
//   2. a step = the smoothed signal rising above +1.2 m/s² after dipping below +0.2 (hysteresis)
//   3. only REGULAR steps count: 4 in a row, each 0.25-2 s apart (a single bump is not walking)
// Activity: still / walk / active from step cadence and how much the phone moves (RMS).
import type { Activity } from "../shared/types";

export const STEP = {
  high: 1.2, // m/s² above the gravity average = step peak
  low: 0.2, // must fall back below this before the next peak
  minGapMs: 250, // max 4 steps per second
  maxGapMs: 2000, // a longer pause ends the walking run
  runToCount: 4, // regular steps needed before a run is counted
  stillRms: 0.35, // m/s² RMS over 2 s below this = not moving
};

const DAY_KEY = "pulselake.stepsDay";

export interface ActivityWindow {
  steps: number; // counted since the previous takeWindow()
  stepsDay: number;
  act: Activity;
  stillSec: number;
}

export class Pedometer {
  private smooth = 9.81;
  private gravity = 9.81;
  private above = false;
  private lastPeak = 0;
  private run: number[] = []; // peak times of the current, not-yet-counted run
  private counting = false; // the current run already passed the regularity check
  private stepTimes: number[] = []; // counted steps (for cadence)
  private dyn: { t: number; v: number }[] = [];
  private windowSteps = 0;
  private day = today();
  stepsDay = readDay(this.day);
  sessionSteps = 0;
  /** wall-clock ms of the last noticeable movement */
  lastMovement = Date.now();

  /** one accelerometer sample including gravity (m/s²); t = performance.now() */
  feed(t: number, ax: number, ay: number, az: number) {
    const mag = Math.hypot(ax, ay, az);
    this.smooth += (mag - this.smooth) * 0.25;
    this.gravity += (mag - this.gravity) * 0.02;
    const d = this.smooth - this.gravity;

    this.dyn.push({ t, v: d });
    while (this.dyn.length && t - this.dyn[0].t > 2000) this.dyn.shift();
    if (Math.abs(d) > 1.5) this.lastMovement = Date.now();

    if (!this.above && d > STEP.high) {
      this.above = true;
      if (t - this.lastPeak >= STEP.minGapMs) this.peak(t);
    } else if (this.above && d < STEP.low) {
      this.above = false;
    }
  }

  private peak(t: number) {
    if (this.lastPeak && t - this.lastPeak > STEP.maxGapMs) {
      this.run = [];
      this.counting = false;
    }
    this.lastPeak = t;
    if (this.counting) {
      this.count(t, 1);
      return;
    }
    this.run.push(t);
    if (this.run.length >= STEP.runToCount) {
      this.counting = true;
      this.count(t, this.run.length);
      this.run = [];
    }
  }

  private count(t: number, n: number) {
    const d = today();
    if (d !== this.day) {
      this.day = d;
      this.stepsDay = 0;
    }
    this.windowSteps += n;
    this.sessionSteps += n;
    this.stepsDay += n;
    for (let i = 0; i < n; i++) this.stepTimes.push(t);
    while (this.stepTimes.length && t - this.stepTimes[0] > 4000) this.stepTimes.shift();
    this.lastMovement = Date.now();
    writeDay(this.day, this.stepsDay);
  }

  get rms() {
    if (!this.dyn.length) return 0;
    return Math.sqrt(this.dyn.reduce((s, x) => s + x.v * x.v, 0) / this.dyn.length);
  }

  activity(now = performance.now()): Activity {
    const recent = this.stepTimes.filter((s) => now - s <= 4000).length;
    const rms = this.rms;
    if (rms > STEP.stillRms) this.lastMovement = Date.now();
    if (recent / 4 >= 2.5 || rms > 4) return "active"; // running / vigorous
    if (recent >= 2) return "walk";
    return rms > 1.5 ? "active" : "still";
  }

  takeWindow(): ActivityWindow {
    const act = this.activity();
    const w: ActivityWindow = {
      steps: this.windowSteps,
      stepsDay: this.stepsDay,
      act,
      stillSec: Math.round((Date.now() - this.lastMovement) / 1000),
    };
    this.windowSteps = 0;
    return w;
  }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function readDay(day: string): number {
  try {
    const v = JSON.parse(localStorage.getItem(DAY_KEY) ?? "{}");
    return v.day === day ? Number(v.steps) || 0 : 0;
  } catch {
    return 0;
  }
}
function writeDay(day: string, steps: number) {
  try {
    localStorage.setItem(DAY_KEY, JSON.stringify({ day, steps }));
  } catch {
    /* ignore */
  }
}
