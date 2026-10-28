"""PulseLake lake writer - our own micro-batching "firehose" + the real-time SPEED LAYER.

SQS event source mapping invokes this function with up to ~60 s worth of telemetry
(MaximumBatchingWindowInSeconds=60).

1. Batch layer input: the whole batch becomes ONE JSON-lines file in Bronze, partitioned by ingest
   time (UTC), exactly like Firehose would:
     s3://<lake>/bronze/telemetry/dt=YYYY-MM-DD/hr=HH/<timestamp>-<id>.json
   Raw messages are stored unchanged (Bronze = source of truth).
2. Speed layer (Lambda architecture): per-device, per-minute aggregates are added to DynamoDB
   (pulselake-speed) as the data streams in - event-time windows, so a late message still lands in
   the minute it was measured. The dashboard compares them with the batch layer (Silver/Gold).
3. Streaming anomaly detection: for every device and batch, an exponentially weighted mean and
   variance (EWMA) per metric gives a z-score. |z| >= 3.5 after warm-up = "unusual for THIS device"
   -> the alert processor opens an ANOMALY alert. No AI service - online statistics.
"""
import json
import math
import os
import time
import uuid
from collections import defaultdict
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

s3 = boto3.client("s3")
lambda_client = boto3.client("lambda")
dynamodb = boto3.resource("dynamodb")
BUCKET = os.environ["LAKE_BUCKET"]
SPEED = dynamodb.Table(os.environ["SPEED_TABLE"]) if os.environ.get("SPEED_TABLE") else None
DEVICES = dynamodb.Table(os.environ["DEVICES_TABLE"]) if os.environ.get("DEVICES_TABLE") else None
ALERT_FUNCTION = os.environ.get("ALERT_FUNCTION", "")
PREFIX = "bronze/telemetry"
SPEED_TTL_S = 2 * 86400

# streaming anomaly detection
ALPHA = 0.1  # EWMA weight of a new observation (~10-batch memory)
WARMUP = 8  # observations before judging (about 8 minutes of streaming)
Z_OPEN, Z_CLOSE = 3.5, 2.0
SD_FLOOR = {"temp": 0.5, "noise": 6.0}  # ignore tiny wiggles on very steady signals


def dec(x):
    return Decimal(str(round(float(x), 6)))


def write_bronze(lines):
    now = time.gmtime()
    key = (
        f"{PREFIX}/dt={time.strftime('%Y-%m-%d', now)}/hr={time.strftime('%H', now)}/"
        f"{time.strftime('%Y%m%dT%H%M%SZ', now)}-{uuid.uuid4().hex[:8]}.json"
    )
    s3.put_object(Bucket=BUCKET, Key=key, Body=("\n".join(lines) + "\n").encode("utf-8"),
                  ContentType="application/x-ndjson")
    return key


def num(m, k):
    v = m.get(k)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def speed_layer(msgs):
    """Per (device, event-time minute) running aggregates in DynamoDB."""
    groups = defaultdict(lambda: {"n": 0, "sumTemp": 0.0, "nTemp": 0, "noisePow": 0.0, "nNoise": 0,
                                  "maxVib": None, "steps": 0, "minBat": None, "owner": ""})
    for m in msgs:
        minute = int(num(m, "ts") // 60000 * 60000)
        g = groups[(m["id"], minute)]
        g["n"] += 1
        g["owner"] = m.get("owner") or g["owner"]
        if num(m, "temp") is not None:
            g["sumTemp"] += num(m, "temp")
            g["nTemp"] += 1
        if num(m, "noise") is not None:
            g["noisePow"] += 10 ** (num(m, "noise") / 10)
            g["nNoise"] += 1
        if num(m, "vibPeak") is not None:
            g["maxVib"] = max(g["maxVib"] or 0, num(m, "vibPeak"))
        g["steps"] += int(num(m, "steps") or 0)
        if num(m, "bat") is not None:
            g["minBat"] = num(m, "bat") if g["minBat"] is None else min(g["minBat"], num(m, "bat"))
    expires = int(time.time()) + SPEED_TTL_S
    for (device_id, minute), g in groups.items():
        key = {"deviceId": device_id, "minute": minute}
        SPEED.update_item(
            Key=key,
            UpdateExpression="ADD n :n, sumTemp :st, nTemp :nt, noisePow :np, nNoise :nn, steps :s "
                             "SET expiresAt = :e, #o = :o",
            ExpressionAttributeNames={"#o": "owner"},
            ExpressionAttributeValues={":n": g["n"], ":st": dec(g["sumTemp"]), ":nt": g["nTemp"],
                                       ":np": dec(g["noisePow"]), ":nn": g["nNoise"], ":s": g["steps"],
                                       ":e": expires, ":o": g["owner"]},
        )
        for attr, val, cmp in (("maxVib", g["maxVib"], "<"), ("minBat", g["minBat"], ">")):
            if val is None:
                continue
            try:  # max / min cannot be expressed with ADD: conditional set
                SPEED.update_item(Key=key, UpdateExpression=f"SET {attr} = :v",
                                  ConditionExpression=f"attribute_not_exists({attr}) OR {attr} {cmp} :v",
                                  ExpressionAttributeValues={":v": dec(val)})
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    raise
    return len(groups)


def observations(msgs):
    """One observation per device per batch: average temperature and noise Leq."""
    per = defaultdict(list)
    for m in msgs:
        per[m["id"]].append(m)
    out = {}
    for device_id, ms in per.items():
        if len(ms) < 10:
            continue  # too few readings in this batch to judge
        temps = [num(m, "temp") for m in ms if num(m, "temp") is not None]
        noises = [num(m, "noise") for m in ms if num(m, "noise") is not None]
        obs = {}
        if temps:
            obs["temp"] = sum(temps) / len(temps)
        if len(noises) >= 10:
            obs["noise"] = 10 * math.log10(sum(10 ** (x / 10) for x in noises) / len(noises))
        out[device_id] = (obs, ms[-1].get("owner", ""))
    return out


def anomaly_detection(msgs):
    events = 0
    for device_id, (obs, owner) in observations(msgs).items():
        item = DEVICES.get_item(Key={"deviceId": device_id},
                                ProjectionExpression="ewma, active").get("Item") or {}
        state = json.loads(json.dumps(item.get("ewma") or {}, default=float))
        active = item.get("active") or {}
        for metric, x in obs.items():
            st = state.get(metric) or {"m": x, "v": 0.0, "n": 0}
            sd = max(math.sqrt(st["v"]), SD_FLOOR[metric])
            z = (x - st["m"]) / sd if st["n"] >= WARMUP else 0.0
            a_type = f"ANOMALY_{metric.upper()}"
            if abs(z) >= Z_OPEN and a_type not in active:
                invoke({"kind": "anomaly", "deviceId": device_id, "owner": owner, "metric": metric,
                        "value": round(x, 2), "mean": round(st["m"], 2), "sd": round(sd, 2), "z": round(z, 2)})
                events += 1
            elif abs(z) < Z_CLOSE and a_type in active:
                invoke({"kind": "anomaly_clear", "deviceId": device_id, "metric": metric,
                        "value": round(x, 2), "mean": round(st["m"], 2)})
                events += 1
            # learn the new normal - slowly while it looks anomalous, so the alert is not swallowed
            alpha = ALPHA if abs(z) < Z_OPEN else ALPHA / 5
            d = x - st["m"]
            st = {"m": st["m"] + alpha * d, "v": (1 - alpha) * (st["v"] + alpha * d * d), "n": st["n"] + 1}
            state[metric] = st
        DEVICES.update_item(Key={"deviceId": device_id}, UpdateExpression="SET ewma = :e",
                            ExpressionAttributeValues={":e": json.loads(json.dumps(state), parse_float=Decimal)})
    return events


def invoke(payload):
    if ALERT_FUNCTION:
        lambda_client.invoke(FunctionName=ALERT_FUNCTION, InvocationType="Event", Payload=json.dumps(payload).encode())


def handler(event, _context):
    lines, msgs = [], []
    skipped = 0
    for record in event.get("Records", []):
        body = record.get("body", "").strip()
        try:
            m = json.loads(body)
            lines.append(body)
            # phones only: the virtual load-test fleet and synthetic history stay out of the speed layer
            if isinstance(m, dict) and m.get("id") and isinstance(m.get("ts"), (int, float)) \
                    and not str(m["id"]).startswith("SIM_") and m.get("sensors") != "synthetic":
                msgs.append(m)
        except ValueError:
            skipped += 1
    if not lines:
        return {"written": 0, "skipped": skipped}

    key = write_bronze(lines)  # the lake first: speed-layer problems must never lose data
    minutes = anomalies = 0
    try:
        if SPEED and msgs:
            minutes = speed_layer(msgs)
        if DEVICES and msgs:
            anomalies = anomaly_detection(sorted(msgs, key=lambda m: m["ts"]))
    except Exception as e:  # report, never fail the batch (SQS would redeliver -> duplicate files)
        print(f"speed layer error: {e}")
    out = {"written": len(lines), "skipped": skipped, "key": key, "speedMinutes": minutes, "anomalyEvents": anomalies}
    print(json.dumps(out))
    return out
