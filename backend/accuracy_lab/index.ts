// PulseLake Accuracy Lab (AWS Lambda, Node.js).
//
// "Is the fall detector accurate?" - measured instead of claimed. Phones upload a raw
// accelerometer trace (bronze/traces) around every fall candidate; people label them in the
// dashboard (real test fall, phone dropped, sat down hard, walking, jump). This Lambda re-runs
// the SAME detector code the phones run (web/src/device/fall.ts, bundled with esbuild) over
// every labelled trace, for a grid of threshold settings, and reports the confusion matrix,
// sensitivity (falls caught) and specificity (non-falls correctly ignored) of each setting.
// The best setting can then be pushed to every phone over the air (Device Shadow).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { FALL_THRESHOLDS, replayTrace, type FallThresholds } from "../../web/src/device/fall";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const PLATFORM = process.env.PLATFORM_TABLE!;
const LAKE = process.env.LAKE_BUCKET!;

/** Labels that SHOULD trigger the fall alarm. Everything else should not. */
const POSITIVE = new Set(["fall"]);

const GRID = {
  freeFallG: [0.3, 0.4, 0.5, 0.6],
  freeFallMinMs: [40, 60, 80, 120, 160],
  impactG: [1.6, 1.8, 2.0, 2.5, 3.0],
  stillStdG: [0.1, 0.15, 0.25],
};

interface Labelled {
  key: string;
  label: string;
  samples: number[][];
}

interface Score {
  thresholds: Partial<FallThresholds>;
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  sensitivity: number;
  specificity: number;
  accuracy: number;
  f1: number;
}

function score(traces: Labelled[], th: Partial<FallThresholds>): Score & { perTrace: boolean[] } {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  const perTrace = traces.map((t) => {
    const hit = replayTrace(t.samples, th) !== null;
    if (POSITIVE.has(t.label)) hit ? tp++ : fn++;
    else hit ? fp++ : tn++;
    return hit;
  });
  const sensitivity = tp + fn ? tp / (tp + fn) : 0;
  const specificity = fp + tn ? tn / (fp + tn) : 0;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const f1 = precision + sensitivity ? (2 * precision * sensitivity) / (precision + sensitivity) : 0;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { thresholds: th, tp, fn, fp, tn, sensitivity: r(sensitivity), specificity: r(specificity), accuracy: r((tp + tn) / Math.max(1, traces.length)), f1: r(f1), perTrace };
}

async function loadTraces(): Promise<Labelled[]> {
  const res = await ddb.send(new QueryCommand({ TableName: PLATFORM, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "TRACE" } }));
  const labelled = (res.Items ?? []).filter((i) => i.label && i.label !== "ignore");
  const out: Labelled[] = [];
  // fetch in small parallel batches
  for (let i = 0; i < labelled.length; i += 16) {
    const batch = await Promise.all(labelled.slice(i, i + 16).map(async (l) => {
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: LAKE, Key: l.sk }));
        const body = JSON.parse(await obj.Body!.transformToString());
        return { key: l.sk, label: l.label, samples: body.samples as number[][] };
      } catch (e: any) {
        console.warn("trace unreadable", l.sk, e.message);
        return null;
      }
    }));
    out.push(...(batch.filter(Boolean) as Labelled[]));
  }
  return out;
}

export async function handler() {
  const started = Date.now();
  const traces = await loadTraces();
  if (!traces.length) return { error: "No labelled traces yet. Drop a phone on a pillow, sit down hard, walk... then label the traces." };

  const current = score(traces, FALL_THRESHOLDS);
  const results: Score[] = [];
  for (const freeFallG of GRID.freeFallG)
    for (const freeFallMinMs of GRID.freeFallMinMs)
      for (const impactG of GRID.impactG)
        for (const stillStdG of GRID.stillStdG) {
          const { perTrace, ...s } = score(traces, { freeFallG, freeFallMinMs, impactG, stillStdG });
          void perTrace;
          results.push(s);
        }
  // best = most falls caught, then fewest false alarms, then the most "middle" (robust) setting
  results.sort((a, b) => b.f1 - a.f1 || b.sensitivity - a.sensitivity || b.specificity - a.specificity || b.thresholds.impactG! - a.thresholds.impactG!);
  const labels: Record<string, number> = {};
  traces.forEach((t) => (labels[t.label] = (labels[t.label] ?? 0) + 1));
  const { perTrace, ...cur } = current;
  const result = {
    at: Date.now(),
    traces: traces.length,
    labels,
    configsTested: results.length,
    current: { ...cur, thresholds: { freeFallG: FALL_THRESHOLDS.freeFallG, freeFallMinMs: FALL_THRESHOLDS.freeFallMinMs, impactG: FALL_THRESHOLDS.impactG, stillStdG: FALL_THRESHOLDS.stillStdG } },
    currentPerTrace: traces.map((t, i) => ({ key: t.key, label: t.label, detected: perTrace[i] })),
    best: results.slice(0, 10),
    ms: Date.now() - started,
  };
  await ddb.send(new PutCommand({ TableName: PLATFORM, Item: { pk: "LAB", sk: "RESULT", ...result } }));
  return result;
}
