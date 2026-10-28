// Calls the analytics Lambda (Function URL) - DynamoDB state + Athena queries on the lake,
// plus the v3 platform routes (Rules & Actions, responders, Accuracy Lab).
import { loadConfig } from "../shared/awsIot";
import type { Rule, RuleDraft } from "../shared/rules";
import type { ActionLog, Alert } from "../shared/types";

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

export interface CompileResult {
  sql: string;
  userClauses: number;
  disabled: boolean;
}

export interface ResponderLink {
  deviceId: string;
  rid: string;
  name: string;
  level: number;
  push: boolean;
  since?: number;
}

export interface Zone {
  deviceId: string;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
}

export interface Escalation {
  alertId: string;
  deviceId: string;
  level: number;
  status: "WAITING" | "DONE" | "UNANSWERED";
  startedAt?: number;
  notifiedAt?: number;
  ackBy?: string;
  ackAt?: number;
}

export interface LakeRuleRun {
  sql?: string;
  columns?: string[];
  rows?: (string | null)[][];
  hits?: number;
  ms?: number;
  scannedBytes?: number;
  error?: string;
  skipped?: string;
}

export interface TraceInfo {
  key: string;
  deviceId: string;
  ts: number;
  traceId: string;
  peakG: number | null;
  detected: boolean;
  trigger: string;
  bytes: number;
  label: string | null;
}

export interface LabScore {
  thresholds: { freeFallG?: number; freeFallMinMs?: number; impactG?: number; stillStdG?: number };
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  sensitivity: number;
  specificity: number;
  accuracy: number;
  f1: number;
}

export interface LabResult {
  at?: number;
  traces?: number;
  labels?: Record<string, number>;
  configsTested?: number;
  current?: LabScore;
  best?: LabScore[];
  currentPerTrace?: { key: string; label: string; detected: boolean }[];
  ms?: number;
  error?: string;
}

// ---- v4: lakehouse, governance, real-time analytics
export interface Dataset {
  name: string;
  layer: "bronze" | "silver" | "quality" | "gold";
  kind: "table" | "iceberg" | "view";
  format: string;
  partitioning: string;
  description: string;
  columns: { name: string; type: string; partition?: boolean }[];
  objects?: number;
  bytes?: number;
  newest?: number | null;
  updated?: number | null;
}

export interface Catalog {
  datasets: Dataset[];
  edges: { from: string; to: string; label?: string }[];
  storage: { bytes: number; monthlyUsd: number; compression: number | null };
  etl: { state?: string; at?: number; mode?: string; watermark?: number; rowsMerged?: number; seconds?: number;
         dq?: { received: number; duplicates: number; invalid: number; late: number; qualityPct: number | null };
         snapshot?: { snapshot_id: string; committed_at: string; operation: string } };
  serverTime: number;
}

export interface Snapshot {
  snapshotId: string;
  committedAt: string;
  operation: string;
  addedRecords: string | null;
  totalRecords: string | null;
  addedFiles: string | null;
  totalFiles: string | null;
}

export interface Lakehouse {
  snapshots: Snapshot[];
  files: { files?: string; records?: string; bytes?: string };
  partitions: { partition: string; record_count: string; file_count: string }[];
}

export interface ReconcilePair {
  minute: number;
  speedMsgs: number;
  batchMsgs: number | null;
  speedTemp: number | null;
  batchTemp: number | null;
  covered: boolean;
}

export interface PerfVariant {
  label: string;
  why: string;
  sql: string;
  rows: number;
  ms: number;
  engineMs: number;
  scannedBytes: number;
  costUsd: number;
  error?: string;
}

export const api = {
  // ---- v4: lakehouse
  catalog: () => get<Catalog>("/catalog"),
  lakehouse: () => get<Lakehouse>("/lakehouse"),
  timeTravel: (snapshotId: string) =>
    post<{ then: Record<string, string>; now: Record<string, string>; sql: string; ms: number }>("/lakehouse/timetravel", { snapshotId }),
  reconcile: (deviceId: string, minutes = 60) =>
    get<{ pairs: ReconcilePair[]; minutesCompared: number; minutesEqual: number; speedMsgs: number; batchMsgs: number; batchWatermark: number; queryMs: number }>(
      `/reconcile?deviceId=${deviceId}&minutes=${minutes}`),
  perfRun: () => post<{ variants: PerfVariant[]; note: string }>("/perf/run", {}),
  exportReport: (name: string, format: "csv" | "parquet") =>
    post<{ files: { file: string; url: string; bytes?: number; rows?: number }[]; scannedBytes: number; ms: number }>("/export", { name, format }),
  etlRunMode: (mode: "incremental" | "full" | "optimize") => post<{ started: boolean; mode: string }>("/etl/run", { mode }),

  // ---- v3: Rules & Actions
  rules: () => get<{ rules: Rule[] }>("/rules").then((r) => r.rules),
  saveRule: (rule: Partial<Rule>) => post<{ rule: Rule; compiled: CompileResult }>("/rules", rule),
  deleteRule: (ruleId: string) => post<{ compiled: CompileResult }>("/rules/delete", { ruleId }),
  toggleRule: (ruleId: string, enabled: boolean) => post<{ compiled: CompileResult }>("/rules/toggle", { ruleId, enabled }),
  installPack: (pack: string, rules: RuleDraft[], devices: string[]) => post<{ rules: Rule[]; compiled: CompileResult }>("/rules/pack", { pack, rules, devices }),
  ruleSql: () => get<{ sql: string; disabled: boolean; ruleName: string }>("/rules/sql"),
  runRule: (ruleId: string) => post<LakeRuleRun>("/rules/run", { ruleId }),
  responders: () => get<{ responders: ResponderLink[] }>("/responders").then((r) => r.responders),
  zones: () => get<{ zones: Zone[] }>("/zones").then((r) => r.zones),
  actions: () => get<{ actions: ActionLog[] }>("/actions").then((r) => r.actions),
  escalations: () => get<{ escalations: Escalation[] }>("/escalations").then((r) => r.escalations),
  pairStart: (deviceId: string, owner: string) => post<{ code: string; expiresAt: number }>("/pair/start", { deviceId, owner }),
  command: (deviceId: string, cmd: "MESSAGE" | "ASK_OK" | "ALARM", text = "") => post<{ sent: boolean }>("/command", { deviceId, cmd, text }),
  backfill: (deviceId: string, owner: string, profile: string, days = 14) =>
    post<{ days: { day: string; steps: number }[]; etlStarted: boolean }>("/simulate", { mode: "backfill", deviceId, owner, profile, days }),
  // ---- v3: Accuracy Lab
  labTraces: () => get<{ traces: TraceInfo[] }>("/lab/traces").then((r) => r.traces),
  labTrace: (key: string) => get<{ samples: number[][]; owner?: string; trigger?: string }>(`/lab/trace?key=${encodeURIComponent(key)}`),
  labLabel: (key: string, label: string) => post<{ ok: boolean }>("/lab/label", { key, label }),
  labRun: () => post<LabResult>("/lab/run", {}),
  labResult: () => get<LabResult>("/lab/result"),

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
