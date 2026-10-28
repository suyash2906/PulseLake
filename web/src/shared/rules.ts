// The Rules & Actions model: "WHEN <condition on the data> THEN <actions>".
// The dashboard builds rules from this catalogue; the Lambdas evaluate them:
//   live / zone  -> alert processor (every forwarded message; the IoT Rule SQL is compiled from them)
//   absence      -> rule runner, every minute (things that did NOT happen: no movement, no data)
//   lake         -> rule runner, Athena SQL over the data lake on a schedule
//   alert        -> reacts to a built-in alert (fall, SOS, offline, overheat ...)

export type RuleKind = "live" | "zone" | "absence" | "lake" | "alert";
export type Severity = "INFO" | "WARNING" | "CRITICAL";
export type Op = ">" | "<" | ">=" | "<=";

export interface RuleActions {
  push?: boolean; // Web Push to the device's responders (Responder app)
  escalate?: boolean; // Step Functions: level 1 -> wait for ack -> level 2 -> UNANSWERED
  email?: boolean; // SNS email
  message?: string; // text shown + beeped on the device itself
  askOk?: boolean; // absence rules: first ask the person "Are you OK?" on the phone
  boost?: boolean; // raise the device's sampling rate while the alert is open
}

export interface Rule {
  ruleId: string;
  code: string; // alert type raised by this rule, e.g. HR_HIGH
  name: string;
  enabled: boolean;
  pack?: string;
  kind: RuleKind;
  devices?: string[]; // empty / missing = every phone
  severity: Severity;
  // live
  metric?: string;
  op?: Op;
  value?: number;
  forSec?: number;
  // zone
  zone?: string;
  when?: "outside" | "inside";
  // absence
  absence?: "no_movement" | "offline" | "battery";
  minutes?: number;
  // lake
  template?: string;
  param?: number;
  everyMin?: number;
  // alert
  alertTypes?: string[];
  window?: { from: string; to: string }; // local time (IST), e.g. 22:00 -> 06:00
  actions: RuleActions;
  cooldownMin?: number;
  hits?: number;
  lastFiredAt?: number;
  lastRunAt?: number;
  createdAt?: number;
}

export type RuleDraft = Omit<Rule, "ruleId" | "code" | "enabled" | "hits" | "lastFiredAt" | "lastRunAt" | "createdAt"> &
  Partial<Pick<Rule, "ruleId" | "code" | "enabled">>;

export const METRICS: { key: string; label: string; unit: string; source: "telemetry" | "event" }[] = [
  { key: "hr", label: "Heart rate", unit: "bpm", source: "event" },
  { key: "noise", label: "Noise", unit: "dB(A)", source: "telemetry" },
  { key: "temp", label: "Temperature", unit: "°C", source: "telemetry" },
  { key: "hum", label: "Humidity", unit: "%", source: "telemetry" },
  { key: "bat", label: "Battery", unit: "%", source: "telemetry" },
  { key: "volt", label: "Voltage", unit: "V", source: "telemetry" },
  { key: "vibPeak", label: "Vibration peak", unit: "m/s²", source: "telemetry" },
  { key: "stillSec", label: "Time without movement", unit: "s", source: "telemetry" },
  { key: "stepsDay", label: "Steps today", unit: "steps", source: "telemetry" },
  { key: "spd", label: "Speed (GPS)", unit: "m/s", source: "telemetry" },
];

export const ABSENCE: { key: NonNullable<Rule["absence"]>; label: string; unit: string }[] = [
  { key: "no_movement", label: "No movement for", unit: "min" },
  { key: "offline", label: "No data (monitoring lost) for", unit: "min" },
  { key: "battery", label: "Battery below % and not charging", unit: "%" },
];

/** `{n}` in the label is replaced by the rule's parameter. */
export const LAKE_TEMPLATES: { key: string; label: string; unit: string; def: number; hint: string }[] = [
  { key: "steps_below_baseline", label: "Steps today below {n}% of the 14-day average", unit: "%", def: 60, hint: "personal baseline from the Gold layer" },
  { key: "active_minutes_low", label: "Active minutes today below {n} min", unit: "min", def: 30, hint: "walking + active time" },
  { key: "noise_dose", label: "Noise dose today above {n}% (NIOSH)", unit: "%", def: 50, hint: "85 dB(A) for 8 h = 100 %" },
  { key: "falls_week", label: "At least {n} falls in the last 7 days", unit: "falls", def: 2, hint: "fall-risk trend" },
];

export const ALERT_TYPES: { key: string; label: string }[] = [
  { key: "FALL", label: "Fall (no answer)" },
  { key: "SOS", label: "SOS button" },
  { key: "FALL_RECOVERED", label: "Fall, got up again" },
  { key: "OFFLINE", label: "Device offline (crash / network)" },
  { key: "OVERHEAT", label: "Overheat" },
  { key: "PREDICTED_OVERHEAT", label: "Overheat predicted" },
  { key: "POWER_SURGE", label: "Power surge" },
  { key: "BATTERY_LOW", label: "Battery critical" },
  { key: "NOISE_HIGH", label: "Noise above 85 dB(A)" },
  { key: "VIBRATION", label: "Vibration / impact" },
  { key: "SENSOR_FROZEN", label: "Sensor frozen" },
];

const metricOf = (k?: string) => METRICS.find((m) => m.key === k);

/** One-line plain-English description, e.g. "WHEN heart rate > 120 bpm THEN push + escalate". */
export function describeRule(r: Pick<Rule, "kind" | "metric" | "op" | "value" | "forSec" | "zone" | "when" | "absence" | "minutes" | "template" | "param" | "alertTypes" | "window" | "actions" | "everyMin">): { when: string; then: string } {
  let when = "";
  if (r.kind === "live") {
    const m = metricOf(r.metric);
    when = `${m?.label ?? r.metric} ${r.op} ${r.value} ${m?.unit ?? ""}${r.forSec ? ` for ${r.forSec} s` : ""}`;
  } else if (r.kind === "zone") {
    when = `${r.when === "inside" ? "inside" : "leaves"} zone "${r.zone}"`;
  } else if (r.kind === "absence") {
    const a = ABSENCE.find((x) => x.key === r.absence);
    when = r.absence === "battery" ? `battery < ${r.minutes}% and not charging` : `${a?.label.toLowerCase()} ${r.minutes} min`;
  } else if (r.kind === "lake") {
    const t = LAKE_TEMPLATES.find((x) => x.key === r.template);
    when = `${(t?.label ?? r.template ?? "").replace("{n}", String(r.param ?? t?.def ?? ""))} · checked every ${r.everyMin ?? 60} min`;
  } else if (r.kind === "alert") {
    when = (r.alertTypes ?? []).map((k) => ALERT_TYPES.find((a) => a.key === k)?.label ?? k).join(" or ");
  }
  if (r.window) when += ` (between ${r.window.from}-${r.window.to})`;
  const a = r.actions ?? {};
  const then = [
    a.askOk && "ask 'Are you OK?'",
    a.push && "push to responders",
    a.escalate && "escalate (Step Functions)",
    a.email && "email",
    a.message && `tell device "${a.message}"`,
    a.boost && "boost sampling",
  ].filter(Boolean) as string[];
  return { when, then: then.join(" + ") || "record only" };
}

// ------------------------------------------------------------------ use-case packs
// The same platform, different scenarios: a pack is just a set of rules.
export interface Pack {
  key: string;
  icon: string;
  label: string;
  who: string;
  rules: RuleDraft[];
}

const NIGHT = { from: "22:00", to: "06:00" };
const DAY = { from: "08:00", to: "21:00" };
const SHIFT = { from: "09:00", to: "18:00" };

export const PACKS: Pack[] = [
  {
    key: "family",
    icon: "👵",
    label: "Family care",
    who: "Parents living alone. Alerts go to their children's phones.",
    rules: [
      { name: "Fall or SOS: escalate to family", kind: "alert", alertTypes: ["FALL", "SOS"], severity: "CRITICAL", actions: { push: true, escalate: true, email: true } },
      { name: "Fell but got up again", kind: "alert", alertTypes: ["FALL_RECOVERED"], severity: "INFO", actions: { push: true } },
      { name: "No movement during the day", kind: "absence", absence: "no_movement", minutes: 180, window: DAY, severity: "WARNING", actions: { askOk: true, push: true } },
      { name: "Monitoring stopped", kind: "absence", absence: "offline", minutes: 10, severity: "WARNING", actions: { push: true } },
      { name: "Phone battery low", kind: "absence", absence: "battery", minutes: 15, severity: "INFO", actions: { push: true, message: "Please put your phone on charge 🔌" } },
      { name: "Heart rate high", kind: "live", metric: "hr", op: ">", value: 120, severity: "WARNING", actions: { push: true } },
      { name: "Heart rate low", kind: "live", metric: "hr", op: "<", value: 45, severity: "WARNING", actions: { push: true } },
      { name: "Left home at night", kind: "zone", zone: "Home", when: "outside", window: NIGHT, severity: "WARNING", actions: { push: true } },
      { name: "Less active than usual", kind: "lake", template: "steps_below_baseline", param: 60, everyMin: 60, severity: "INFO", actions: { push: true } },
    ],
  },
  {
    key: "worker",
    icon: "🦺",
    label: "Lone worker",
    who: "Factory or field staff working alone. Alerts go to the supervisor.",
    rules: [
      { name: "Worker fall or SOS", kind: "alert", alertTypes: ["FALL", "SOS"], severity: "CRITICAL", actions: { push: true, escalate: true, email: true } },
      { name: "Loud area: hearing protection", kind: "live", metric: "noise", op: ">", value: 85, forSec: 10, severity: "WARNING", actions: { message: "Loud area - wear hearing protection 🎧", push: true } },
      { name: "Daily noise dose high", kind: "lake", template: "noise_dose", param: 50, everyMin: 60, severity: "WARNING", actions: { push: true } },
      { name: "Motionless during shift", kind: "absence", absence: "no_movement", minutes: 10, window: SHIFT, severity: "CRITICAL", actions: { askOk: true, push: true, escalate: true } },
      { name: "Left the site", kind: "zone", zone: "Site", when: "outside", window: SHIFT, severity: "WARNING", actions: { push: true } },
    ],
  },
  {
    key: "city",
    icon: "🏙️",
    label: "City noise node",
    who: "Street-level noise sensors. Alerts go to the city operator.",
    rules: [
      { name: "Night-time noise", kind: "live", metric: "noise", op: ">", value: 70, forSec: 30, window: NIGHT, severity: "WARNING", actions: { push: true } },
      { name: "Noisy day (dose)", kind: "lake", template: "noise_dose", param: 25, everyMin: 60, severity: "INFO", actions: { push: true } },
      { name: "Sensor offline", kind: "alert", alertTypes: ["OFFLINE"], severity: "WARNING", actions: { push: true } },
    ],
  },
  {
    key: "asset",
    icon: "📦",
    label: "Asset tracking",
    who: "Machines, cold-chain boxes, deliveries. Alerts go to maintenance.",
    rules: [
      { name: "Overheat (predicted or real)", kind: "alert", alertTypes: ["PREDICTED_OVERHEAT", "OVERHEAT", "POWER_SURGE"], severity: "CRITICAL", actions: { push: true, escalate: true, boost: true } },
      { name: "Asset offline", kind: "alert", alertTypes: ["OFFLINE", "SENSOR_FROZEN"], severity: "WARNING", actions: { push: true } },
      { name: "Battery low", kind: "live", metric: "bat", op: "<", value: 15, severity: "WARNING", actions: { push: true } },
      { name: "Left the depot", kind: "zone", zone: "Depot", when: "outside", severity: "WARNING", actions: { push: true } },
    ],
  },
];
