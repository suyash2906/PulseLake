// Calls the analytics Lambda (Function URL) - DynamoDB state + Athena queries on the lake.
import { loadConfig } from "../shared/awsIot";
import type { Alert } from "../shared/types";

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = await loadConfig();
  if (!cfg.analyticsUrl) throw new Error("analyticsUrl missing in config.json");
  const res = await fetch(`${cfg.analyticsUrl}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}
const post = <T>(path: string, body: object) =>
  get<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export interface EtlStatus {
  state: "NEVER_RUN" | "RUNNING" | "SUCCEEDED" | "FAILED";
  at?: number;
  step?: string;
  steps?: string[];
  seconds?: number;
  error?: string;
}

export interface QueryResult {
  name: string;
  title: string;
  layer: string;
  sql: string;
  columns: string[];
  rows: (string | null)[][];
  stats: { queryId: string; engineMs: number; totalMs: number; scannedBytes: number; costUsd: number };
}

export interface LakeLayer {
  prefix: string;
  label: string;
  objects: number;
  bytes: number;
  newestKey: string | null;
  newestAt: string | null;
}

export interface Session {
  start: number;
  end: number;
  messages: number;
  devices: number;
  owners: string[];
}

export interface ReplayData {
  start: number;
  end: number;
  telemetry: import("../shared/types").Telemetry[];
  events: import("../shared/types").DeviceEvent[];
  alerts: (Alert & { at: number })[];
  queryMs: number;
}

export interface SimStatus {
  state: "NEVER_RUN" | "STARTING" | "RUNNING" | "DONE";
  at?: number;
  devices?: number;
  seconds?: number;
  sent?: number;
  errors?: number;
  elapsed?: number;
  faultyDevices?: number;
  durationSec?: number;
  runsToday?: number;
}

export interface CostInfo {
  capUsd: number;
  usedUsd?: number;
  forecastUsd?: number;
  creditsLeftUsd?: number;
  plan?: string;
  phase: string;
  phaseCapUsd: number;
}

export const api = {
  sessions: () => get<{ sessions: Session[] }>("/sessions").then((r) => r.sessions),
  replay: (start: number, end: number) => get<ReplayData>(`/replay?start=${start}&end=${end}`),
  simulate: (devices: number, seconds: number) => post<SimStatus>("/simulate", { devices, seconds }),
  simulateStatus: () => get<SimStatus>("/simulate/status"),
  cost: () => get<CostInfo>("/cost"),
  alerts: () => get<{ alerts: Alert[] }>("/alerts").then((r) => r.alerts),
  fleet: () => get<{ devices: any[] }>("/fleet").then((r) => r.devices),
  queries: () => get<{ queries: { name: string; title: string; layer: string }[] }>("/queries").then((r) => r.queries),
  query: (name: string) => get<QueryResult>(`/query/${name}`),
  lake: () => get<{ bucket: string; layers: LakeLayer[] }>("/lake"),
  sql: (sql: string) => post<QueryResult>("/sql", { sql }),
  etlRun: () => post<{ started: boolean }>("/etl/run", {}),
  etlStatus: () => get<EtlStatus>("/etl/status"),
};

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
