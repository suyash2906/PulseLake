// PulseLake action dispatcher (AWS Lambda, Node.js) - the "ACT" in Sense -> Store -> Understand -> Act.
//
// Every action the platform takes goes through here, so it is logged in one place:
//   alert                  a rule fired: push to responders, start the escalation workflow,
//                          email, send a message / higher sampling rate to the device
//   escalation-notify      called BY Step Functions (waitForTaskToken): notify level 1 or 2 and
//                          store the task token; the workflow waits until someone acknowledges
//   escalation-unanswered  nobody answered in time: mark the alert UNANSWERED, email, push
//   ack                    a responder tapped "I'm handling it": resume the workflow
//                          (SendTaskSuccess), tell the device "help is coming", tell the others
//   resolved               the alert ended: stop the workflow, tell responders
//   command                send a command to a device (Are you OK?, message, rate)
//   test-push              "Send test notification" from the Responder app
// Each action is written to the data lake (bronze/actions), a recent-actions table and the
// MQTT topic pulselake/actions (live action log on the dashboard).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { DescribeEndpointCommand, IoTClient } from "@aws-sdk/client-iot";
import { IoTDataPlaneClient, PublishCommand as IotPublishCommand } from "@aws-sdk/client-iot-data-plane";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendTaskSuccessCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import webpush from "web-push";

const env = process.env;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const sfn = new SFNClient({});
const sns = new SNSClient({});
const s3 = new S3Client({});
const ssm = new SSMClient({});
const PLATFORM = env.PLATFORM_TABLE!;
const ALERTS = env.ALERTS_TABLE!;
const LAKE = env.LAKE_BUCKET!;
const STATE_MACHINE = env.STATE_MACHINE_ARN!;
const TOPIC = env.ALERT_TOPIC_ARN!;
const VAPID_PARAM = env.VAPID_PARAM!;
const WEB_URL = env.WEB_URL ?? "";

type Json = Record<string, any>;

interface Alert {
  alertId: string;
  deviceId: string;
  owner?: string;
  ts: number;
  type: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  status: string;
  message: string;
  source?: string;
  ruleId?: string;
  ruleName?: string;
  lat?: number;
  lon?: number;
}

interface Responder {
  rid: string;
  name: string;
  level: number;
  sub?: Json | null;
}

// ------------------------------------------------------------------ clients that need setup
let iotData: IoTDataPlaneClient | null = null;
async function iot() {
  if (!iotData) {
    const ep = await new IoTClient({}).send(new DescribeEndpointCommand({ endpointType: "iot:Data-ATS" }));
    iotData = new IoTDataPlaneClient({ endpoint: `https://${ep.endpointAddress}` });
  }
  return iotData;
}

let vapidReady: Promise<boolean> | null = null;
function vapid() {
  vapidReady ??= ssm
    .send(new GetParameterCommand({ Name: VAPID_PARAM, WithDecryption: true }))
    .then((r) => {
      const v = JSON.parse(r.Parameter!.Value!);
      webpush.setVapidDetails(v.subject || "mailto:admin@pulselake.local", v.publicKey, v.privateKey);
      return true;
    })
    .catch((e) => {
      console.error("VAPID keys unavailable - push disabled", e.message);
      return false;
    });
  return vapidReady;
}

// ------------------------------------------------------------------ helpers
const now = () => Date.now();
const who = (a: Alert) => a.owner || a.deviceId.replace("_", " ");
const alertKey = (a: Pick<Alert, "ts" | "alertId">) => ({ pk: "ALERT", sk: `${String(a.ts).padStart(13, "0")}#${a.alertId}` });

async function mqtt(topic: string, body: Json) {
  await (await iot()).send(new IotPublishCommand({ topic, qos: 1, payload: Buffer.from(JSON.stringify(body)) }));
}

async function log(entry: Json) {
  const rec = { ts: now(), ...entry };
  const rand = Math.random().toString(36).slice(2, 8);
  const day = new Date(rec.ts).toISOString().slice(0, 10);
  await Promise.allSettled([
    s3.send(new PutObjectCommand({
      Bucket: LAKE,
      Key: `bronze/actions/dt=${day}/${rec.ts}-${rand}.json`,
      Body: JSON.stringify(rec),
      ContentType: "application/json",
    })),
    ddb.send(new PutCommand({
      TableName: PLATFORM,
      Item: { pk: "ACTION", sk: `${rec.ts}#${rand}`, ...rec, expiresAt: Math.floor(rec.ts / 1000) + 2 * 86400 },
    })),
    mqtt("pulselake/actions", rec),
  ]);
  console.log(JSON.stringify({ action: rec }));
}

async function responders(deviceId: string): Promise<Responder[]> {
  const links = await ddb.send(new QueryCommand({
    TableName: PLATFORM,
    KeyConditionExpression: "pk = :p AND begins_with(sk, :r)",
    ExpressionAttributeValues: { ":p": `DEV#${deviceId}`, ":r": "RESP#" },
  }));
  const items = links.Items ?? [];
  if (!items.length) return [];
  const profiles = await ddb.send(new BatchGetCommand({
    RequestItems: { [PLATFORM]: { Keys: items.map((i) => ({ pk: `RESP#${i.rid}`, sk: "PROFILE" })) } },
  }));
  const byId = new Map((profiles.Responses?.[PLATFORM] ?? []).map((p) => [p.rid, p]));
  return items.map((i) => ({ rid: i.rid, name: i.name, level: Number(i.level) || 1, sub: byId.get(i.rid)?.sub ?? null }));
}

/** Web Push to a list of responders; expired subscriptions are removed. Returns how many got it. */
async function push(list: Responder[], msg: { title: string; body: string; alert?: Alert; critical?: boolean }, ctx: Json) {
  if (!(await vapid())) {
    await log({ ...ctx, action: "push", status: "failed", detail: "VAPID keys missing" });
    return 0;
  }
  const url = msg.alert ? `${WEB_URL}/responder.html?alert=${msg.alert.alertId}` : `${WEB_URL}/responder.html`;
  const payload = JSON.stringify({
    title: msg.title,
    body: msg.body,
    url,
    tag: msg.alert?.alertId ?? "pulselake",
    critical: !!msg.critical,
    alertId: msg.alert?.alertId,
    deviceId: msg.alert?.deviceId,
  });
  let sent = 0;
  await Promise.all(list.map(async (r) => {
    if (!r.sub) {
      await log({ ...ctx, action: "push", status: "skipped", target: r.name, level: r.level, detail: "notifications not enabled on that phone" });
      return;
    }
    try {
      await webpush.sendNotification(r.sub as any, payload, { TTL: 600, urgency: msg.critical ? "high" : "normal" });
      sent++;
      await log({ ...ctx, action: "push", status: "sent", target: r.name, level: r.level, detail: msg.title });
    } catch (e: any) {
      const gone = e?.statusCode === 404 || e?.statusCode === 410;
      if (gone) {
        await ddb.send(new UpdateCommand({ TableName: PLATFORM, Key: { pk: `RESP#${r.rid}`, sk: "PROFILE" }, UpdateExpression: "REMOVE sub" }));
      }
      await log({ ...ctx, action: "push", status: "failed", target: r.name, level: r.level, detail: gone ? "subscription expired" : String(e?.body ?? e?.message ?? e).slice(0, 200) });
    }
  }));
  return sent;
}

async function command(deviceId: string, cmd: Json, ctx: Json) {
  await mqtt(`pulselake/devices/${deviceId}/commands`, { ...cmd, ts: now() });
  await log({ ...ctx, action: "command", status: "sent", target: deviceId, detail: cmd.cmd + (cmd.text ? `: ${cmd.text}` : cmd.rate ? ` ${cmd.rate} Hz` : "") });
}

async function email(subject: string, text: string, ctx: Json) {
  await sns.send(new PublishCommand({ TopicArn: TOPIC, Subject: subject.slice(0, 99), Message: text }));
  await log({ ...ctx, action: "email", status: "sent", target: "alert email", detail: subject });
}

/** Update the stored alert and re-publish it so every dashboard sees the new escalation state. */
async function updateAlert(a: Alert, fields: Json) {
  const names: Json = {};
  const values: Json = {};
  const sets = Object.entries(fields).map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: ALERTS,
      Key: alertKey(a),
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }));
    const { pk, sk, expiresAt, ...item } = res.Attributes ?? {};
    void pk; void sk; void expiresAt;
    await mqtt("pulselake/alerts", item);
    return item as Alert;
  } catch (e: any) {
    console.warn("alert update failed", e.message);
    return null;
  }
}

function ctxOf(a: Alert, extra: Json = {}): Json {
  return { alertId: a.alertId, alertType: a.type, deviceId: a.deviceId, owner: a.owner, ruleId: a.ruleId, ruleName: a.ruleName, ...extra };
}

const TITLES: Record<string, string> = {
  FALL: "🚨 {who} may have fallen",
  SOS: "🆘 {who} pressed SOS",
  FALL_RECOVERED: "💛 {who} fell but got up",
  OFFLINE: "📴 {who}'s device went offline",
};
function titleOf(a: Alert) {
  const t = TITLES[a.type] ?? `${a.severity === "CRITICAL" ? "🚨" : a.severity === "WARNING" ? "⚠️" : "ℹ️"} ${a.ruleName || a.type.replace(/_/g, " ")}: {who}`;
  return t.replace("{who}", who(a));
}

// ------------------------------------------------------------------ modes
async function onAlert(e: Json) {
  const a: Alert = e.alert;
  const act: Json = e.actions ?? {};
  const ctx = ctxOf(a, { ruleId: e.rule?.ruleId ?? a.ruleId, ruleName: e.rule?.name ?? a.ruleName });
  await log({ ...ctx, action: "notify", status: "done", detail: `rule matched: ${Object.keys(act).filter((k) => act[k]).join(", ")}` });
  const jobs: Promise<unknown>[] = [];
  if (act.escalate && a.severity !== "INFO") {
    // the workflow notifies level 1 itself, so no separate push here
    jobs.push(sfn.send(new StartExecutionCommand({ stateMachineArn: STATE_MACHINE, name: a.alertId, input: JSON.stringify({ alert: a }) }))
      .then(() => log({ ...ctx, action: "escalate", status: "sent", detail: "Step Functions escalation started" }))
      .catch((err) => log({ ...ctx, action: "escalate", status: "failed", detail: String(err.message).slice(0, 200) })));
  } else if (act.push) {
    jobs.push(responders(a.deviceId).then((list) => push(list, { title: titleOf(a), body: a.message, alert: a, critical: a.severity === "CRITICAL" }, ctx)));
  }
  if (act.email) jobs.push(email(`PulseLake: ${titleOf(a)}`, `${a.message}\n\nDevice: ${a.deviceId}\nTime: ${new Date(a.ts).toISOString()}`, ctx));
  if (act.message) jobs.push(command(a.deviceId, { cmd: "MESSAGE", text: act.message, from: a.ruleName || "PulseLake", ruleId: a.ruleId, alertId: a.alertId }, ctx));
  if (act.boost) jobs.push(command(a.deviceId, { cmd: "SET_RATE", rate: 4, alertId: a.alertId }, ctx));
  await Promise.all(jobs);
}

async function onEscalationNotify(e: Json) {
  const a: Alert = e.alert;
  const level = Number(e.level) || 1;
  const ctx = ctxOf(a, { level });
  // the person may already be OK, or someone may already be on it
  const esc = (await ddb.send(new GetCommand({ TableName: PLATFORM, Key: { pk: `ESC#${a.alertId}`, sk: "STATE" } }))).Item;
  if (esc?.status === "DONE") {
    await sfn.send(new SendTaskSuccessCommand({ taskToken: e.token, output: JSON.stringify({ alreadyDone: true }) }));
    return;
  }
  await ddb.send(new PutCommand({
    TableName: PLATFORM,
    Item: { pk: `ESC#${a.alertId}`, sk: "STATE", token: e.token, level, deviceId: a.deviceId, alertTs: a.ts, startedAt: esc?.startedAt ?? now(), notifiedAt: now(), status: "WAITING", expiresAt: Math.floor(now() / 1000) + 2 * 86400 },
  }));
  await updateAlert(a, { escalation: level === 1 ? "LEVEL1" : "LEVEL2", escalatedAt: now() });
  const all = await responders(a.deviceId);
  const first = all.filter((r) => r.level === 1);
  const list = level === 1 ? (first.length ? first : all) : all;
  const title = level === 1 ? titleOf(a) : `⏰ No response yet: ${titleOf(a).replace(/^\S+\s/, "")}`;
  const body = level === 1 ? `${a.message}. Tap to respond.` : `Nobody has responded for 60 s. ${a.message}`;
  const sent = await push(list, { title, body, alert: a, critical: true }, ctx);
  await log({ ...ctx, action: "escalate", status: "done", detail: `level ${level}: notified ${sent} of ${list.length} responder(s), waiting for an acknowledgement` });
  if (level >= 2) await email(`PulseLake ESCALATION: ${titleOf(a)}`, `Nobody acknowledged this alert within 60 s.\n\n${a.message}\nDevice: ${a.deviceId}`, ctx);
}

async function onUnanswered(e: Json) {
  const a: Alert = e.alert;
  const ctx = ctxOf(a, { level: 3 });
  await ddb.send(new UpdateCommand({ TableName: PLATFORM, Key: { pk: `ESC#${a.alertId}`, sk: "STATE" }, UpdateExpression: "SET #s = :s", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": "UNANSWERED" } }));
  await updateAlert(a, { escalation: "UNANSWERED" });
  await log({ ...ctx, action: "unanswered", status: "done", detail: "no responder acknowledged within 3 minutes" });
  await Promise.all([
    push(await responders(a.deviceId), { title: `‼️ UNANSWERED: ${titleOf(a).replace(/^\S+\s/, "")}`, body: "Nobody has responded yet. Please check now or call emergency services.", alert: a, critical: true }, ctx),
    email(`PulseLake UNANSWERED: ${titleOf(a)}`, `No responder acknowledged this alert within 3 minutes.\n\n${a.message}\nDevice: ${a.deviceId}`, ctx),
  ]);
}

async function onAck(e: Json) {
  const alertId: string = e.alertId;
  const name: string = e.name || "A responder";
  const esc = (await ddb.send(new GetCommand({ TableName: PLATFORM, Key: { pk: `ESC#${alertId}`, sk: "STATE" } }))).Item;
  const a: Alert = e.alert;
  const ackMs = now() - Number(a.ts);
  const ctx = ctxOf(a, { level: esc?.level, target: name, ackMs });
  if (esc?.token && esc.status === "WAITING") {
    try {
      await sfn.send(new SendTaskSuccessCommand({ taskToken: esc.token, output: JSON.stringify({ ackBy: name, ackMs }) }));
    } catch (err: any) {
      console.warn("SendTaskSuccess failed (workflow already moved on?)", err.name);
    }
  }
  await ddb.send(new PutCommand({
    TableName: PLATFORM,
    Item: { ...(esc ?? { pk: `ESC#${alertId}`, sk: "STATE", deviceId: a.deviceId }), status: "DONE", ackBy: name, ackAt: now(), expiresAt: Math.floor(now() / 1000) + 2 * 86400 },
  }));
  const updated = await updateAlert(a, { escalation: "ACKED", ackBy: name, ackAt: now() });
  await log({ ...ctx, action: "ack", status: "done", detail: `${name} is handling it (${Math.round(ackMs / 1000)} s after the alert)` });
  await command(a.deviceId, { cmd: "HELP_COMING", from: name, alertId }, ctx);
  const others = (await responders(a.deviceId)).filter((r) => r.rid !== e.rid);
  await push(others, { title: `✅ ${name} is handling it`, body: `${titleOf(a).replace(/^\S+\s/, "")} - ${name} acknowledged.`, alert: a }, ctx);
  return { ok: true, ackMs, alert: updated };
}

async function onResolved(e: Json) {
  const a: Alert = e.alert;
  const ctx = ctxOf(a);
  const esc = (await ddb.send(new GetCommand({ TableName: PLATFORM, Key: { pk: `ESC#${a.alertId}`, sk: "STATE" } }))).Item;
  if (esc?.token && esc.status === "WAITING") {
    await sfn.send(new SendTaskSuccessCommand({ taskToken: esc.token, output: JSON.stringify({ resolved: true }) })).catch(() => {});
  }
  if (esc) {
    await ddb.send(new UpdateCommand({ TableName: PLATFORM, Key: { pk: `ESC#${a.alertId}`, sk: "STATE" }, UpdateExpression: "SET #s = :s", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": "DONE" } }));
  }
  await log({ ...ctx, action: "resolved", status: "done", detail: e.reason || "resolved" });
  if (a.severity !== "INFO") {
    await push(await responders(a.deviceId), { title: `✅ Resolved: ${titleOf(a).replace(/^\S+\s/, "")}`, body: e.reason ? `${e.reason}.` : "The alert is over.", alert: a }, ctx);
  }
}

async function onCommand(e: Json) {
  const ctx = { deviceId: e.deviceId, ruleId: e.ruleId, ruleName: e.ruleName ?? (e.ruleId ? undefined : "manual") };
  await command(e.deviceId, { cmd: e.cmd, text: e.text, from: e.from, timeoutSec: e.timeoutSec, rate: e.rate, ruleId: e.ruleId }, ctx);
}

async function onTestPush(e: Json) {
  const p = (await ddb.send(new GetCommand({ TableName: PLATFORM, Key: { pk: `RESP#${e.rid}`, sk: "PROFILE" } }))).Item;
  if (!p) return { sent: 0 };
  const sent = await push([{ rid: e.rid, name: p.name, level: 1, sub: p.sub }], { title: "🔔 PulseLake test", body: "Notifications work. You will be alerted here." }, { action: "push", ruleName: "test" });
  return { sent };
}

export async function handler(e: Json) {
  switch (e.mode) {
    case "alert": return onAlert(e);
    case "escalation-notify": return onEscalationNotify(e);
    case "escalation-unanswered": return onUnanswered(e);
    case "ack": return onAck(e);
    case "resolved": return onResolved(e);
    case "command": return onCommand(e);
    case "test-push": return onTestPush(e);
    default:
      console.warn("unknown mode", JSON.stringify(e).slice(0, 300));
      return { error: "unknown mode" };
  }
}
