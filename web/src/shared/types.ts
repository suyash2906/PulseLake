// Message contracts shared by the phone app, the dashboard and (documented for) the Lambdas.

export const SLOTS = ["PHONE_01", "PHONE_02", "PHONE_03", "PHONE_04"] as const;
export type Slot = (typeof SLOTS)[number];

export const TOPICS = {
  telemetry: (id: string) => `pulselake/devices/${id}/telemetry`,
  events: (id: string) => `pulselake/devices/${id}/events`,
  allTelemetry: "pulselake/devices/+/telemetry",
  allEvents: "pulselake/devices/+/events",
  alerts: "pulselake/alerts",
  presence: "$aws/events/presence/+/+",
};

export type Fault =
  | "NONE"
  | "OVERHEAT"
  | "POWER_SURGE"
  | "BATTERY_CRITICAL"
  | "SENSOR_FREEZE"
  | "CRASH"
  | "NETWORK_DROP";

export type Health = "OK" | "WARNING" | "FAILED";

export interface Profile {
  key: string;
  label: string;
  icon: string;
  baseTemp: number;
  baseHum: number;
}

// Use cases, not decoration: every phone runs fall detection and (if allowed) noise monitoring;
// the profile says who / what the phone represents in the demo.
export const PROFILES: Profile[] = [
  { key: "worker", label: "Factory worker", icon: "🦺", baseTemp: 32, baseHum: 45 },
  { key: "elderly", label: "Elderly care", icon: "🧓", baseTemp: 26, baseHum: 50 },
  { key: "city", label: "City noise node", icon: "🏙️", baseTemp: 30, baseHum: 60 },
  { key: "warehouse", label: "Warehouse", icon: "📦", baseTemp: 28, baseHum: 55 },
];
// older sessions in the data lake still carry the first-version profile keys
export const LEGACY_PROFILES: Profile[] = [
  { key: "motor", label: "Industrial Motor", icon: "⚙️", baseTemp: 48, baseHum: 40 },
  { key: "cold", label: "Cold Storage", icon: "❄️", baseTemp: 4, baseHum: 70 },
  { key: "truck", label: "Delivery Truck", icon: "🚚", baseTemp: 31, baseHum: 55 },
  { key: "wearable", label: "Health Wearable", icon: "❤️", baseTemp: 36.6, baseHum: 50 },
];
export const profileOf = (key?: string) => [...PROFILES, ...LEGACY_PROFILES].find((p) => p.key === key);

export const FAULTS: { key: Exclude<Fault, "NONE">; label: string; icon: string; severity: Health; hint: string }[] = [
  { key: "OVERHEAT", label: "Overheat", icon: "🔥", severity: "FAILED", hint: "Temperature runs away" },
  { key: "POWER_SURGE", label: "Power Surge", icon: "⚡", severity: "FAILED", hint: "Voltage spikes" },
  { key: "BATTERY_CRITICAL", label: "Battery Critical", icon: "🪫", severity: "WARNING", hint: "Battery drops to 3%" },
  { key: "SENSOR_FREEZE", label: "Sensor Freeze", icon: "🧊", severity: "WARNING", hint: "Readings get stuck" },
  { key: "NETWORK_DROP", label: "Network Drop", icon: "📡", severity: "FAILED", hint: "Offline for 20 s, then back" },
  { key: "CRASH", label: "Crash", icon: "💀", severity: "FAILED", hint: "Device dies without goodbye" },
];

/** Published once per second (default) on pulselake/devices/{id}/telemetry */
export interface Telemetry {
  v: 1;
  id: string; // thing name, e.g. PHONE_01
  owner: string; // person holding the phone
  profile: string;
  seq: number;
  ts: number; // device epoch ms
  rate: number; // messages per second
  health: Health;
  fault: Fault;
  temp: number; // °C   (slider / simulated)
  hum: number; // %    (slider / simulated)
  volt: number; // V    (simulated supply voltage)
  bat: number; // %    (real Battery API where available)
  chg: boolean; // charging
  vib: number; // m/s² RMS of dynamic acceleration (REAL accelerometer)
  vibPeak: number; // m/s² peak in this window
  acc: [number, number, number]; // latest acceleration incl. gravity
  qt0?: number; // device epoch ms of the first orientation sample in `q`
  q?: number[][]; // ~20 orientation samples per second: [dtMs from qt0, w, x, y, z] (quaternion)
  ori?: [number, number, number][]; // v1 messages: Euler samples [alpha, beta, gamma] at 10 Hz
  noise?: number | null; // approx. dB(A), 1 s equivalent level (Leq); null = microphone off
  noiseMax?: number | null; // loudest 100 ms in that second
  sensors: "real" | "simulated";
}

/** Published on change on pulselake/devices/{id}/events */
export interface DeviceEvent {
  v: 1;
  id: string;
  owner: string;
  profile: string;
  ts: number;
  type:
    | "ONLINE"
    | "FAULT_INJECTED"
    | "FAULT_CLEARED"
    | "GOODBYE"
    | "FALL_DETECTED" // no answer to "Are you OK?" within 15 s
    | "FALL_CANCELLED" // person tapped "I'm OK" during the countdown (false alarm)
    | "FALL_RESOLVED" // person confirmed OK after the alert was sent
    | "SOS"
    | "SOS_CLEARED";
  fault: Fault;
  health: Health;
  impactG?: number; // fall: peak acceleration at impact, in g
  freeFallMs?: number; // fall: duration of the free-fall phase
  angleChange?: number; // fall: degrees between orientation before and after
}

/** Published by the Alert Lambda on pulselake/alerts */
export interface Alert {
  alertId: string;
  deviceId: string;
  owner?: string;
  ts: number;
  type: string; // OVERHEAT, OFFLINE, VIBRATION, ...
  severity: "INFO" | "WARNING" | "CRITICAL";
  status: "ACTIVE" | "RESOLVED";
  message: string;
  source: "DEVICE_FAULT" | "CLOUD_RULE" | "PRESENCE" | "EDGE";
  etaSec?: number; // PREDICTED_OVERHEAT: seconds until the limit, at alert time
  predictedLeadSec?: number; // OVERHEAT: how long before it the cloud predicted it
  resolvedAt?: number;
}

/** AWS-generated lifecycle event on $aws/events/presence/{connected|disconnected}/{clientId} */
export interface PresenceEvent {
  clientId: string;
  timestamp: number;
  eventType: "connected" | "disconnected";
  disconnectReason?: string;
  clientInitiatedDisconnect?: boolean;
}
