"""PulseLake alert processor (AWS Lambda, invoked by IoT Rules).

Inputs (field `kind` is added by the IoT Rule SQL):
  telemetry - pre-filtered by the rule: abnormal readings + every 5th message as a heartbeat sample
  presence  - AWS IoT lifecycle events ($aws/events/presence/...) for PHONE_* clients
  event     - device events (ONLINE / GOODBYE / FAULT_INJECTED / FAULT_CLEARED)

The CLOUD decides what is an alert (thresholds, frozen-sensor detection, unexpected disconnects).
State lives in DynamoDB so we alert only on CHANGES (no spam) and can mark alerts RESOLVED.
Every alert is republished on MQTT topic pulselake/alerts (dashboard + S3 archive rule) and
CRITICAL ones are emailed through SNS (max 1 email per device per 2 minutes).
"""
import json
import os
import time
import uuid
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
DEVICES = dynamodb.Table(os.environ["DEVICES_TABLE"])
ALERTS = dynamodb.Table(os.environ["ALERTS_TABLE"])
SNS_TOPIC = os.environ.get("ALERT_TOPIC_ARN", "")
ALERT_MQTT_TOPIC = "pulselake/alerts"
ALERT_TTL_DAYS = 7
EMAIL_COOLDOWN_MS = 120_000
GOODBYE_WINDOW_MS = 15_000  # a disconnect within 15 s after GOODBYE is a planned leave

sns = boto3.client("sns")
_iot_data = None


def iot_data():
    global _iot_data
    if _iot_data is None:
        endpoint = boto3.client("iot").describe_endpoint(endpointType="iot:Data-ATS")["endpointAddress"]
        _iot_data = boto3.client("iot-data", endpoint_url=f"https://{endpoint}")
    return _iot_data


# ----------------------------------------------------------------- cloud detection rules
# (type, severity, test, message, hold_ms) - hold_ms keeps transient alerts open a little.
def _num(m, k, default=0.0):
    try:
        return float(m.get(k, default))
    except (TypeError, ValueError):
        return default


CONDITIONS = [
    ("OVERHEAT", "CRITICAL", lambda m: _num(m, "temp") > 70,
     lambda m: f"Temperature {_num(m, 'temp'):.1f} C is above the 70 C limit", 0),
    ("POWER_SURGE", "CRITICAL", lambda m: _num(m, "volt") > 6,
     lambda m: f"Supply voltage {_num(m, 'volt'):.2f} V is above the 6 V limit", 0),
    ("BATTERY_LOW", "WARNING", lambda m: _num(m, "bat", 100) < 10,
     lambda m: f"Battery at {_num(m, 'bat', 100):.0f}%", 0),
    ("VIBRATION", "WARNING", lambda m: _num(m, "vibPeak") > 15,
     lambda m: f"Vibration peak {_num(m, 'vibPeak'):.1f} m/s2 (limit 15) - device was shaken or hit", 15_000),
]


def fingerprint(m):
    """Readings that always carry noise on a healthy device. Identical values = frozen sensor."""
    return "|".join(str(m.get(k)) for k in ("temp", "hum", "volt", "acc", "vib"))


# ----------------------------------------------------------------- helpers
def now_ms():
    return int(time.time() * 1000)


def to_ddb(obj):
    return json.loads(json.dumps(obj), parse_float=Decimal)


def from_ddb(obj):
    return json.loads(json.dumps(obj, default=lambda d: int(d) if d == int(d) else float(d)))


def get_device(device_id):
    item = DEVICES.get_item(Key={"deviceId": device_id}).get("Item")
    return from_ddb(item) if item else {"deviceId": device_id, "active": {}}


def publish_alert(alert):
    try:
        iot_data().publish(topic=ALERT_MQTT_TOPIC, qos=1, payload=json.dumps(alert))
    except ClientError as e:
        print(f"republish failed: {e}")


def maybe_email(device, alert):
    if not SNS_TOPIC or alert["severity"] != "CRITICAL" or alert["status"] != "ACTIVE":
        return
    if now_ms() - int(device.get("lastEmailAt", 0)) < EMAIL_COOLDOWN_MS:
        return
    try:
        DEVICES.update_item(
            Key={"deviceId": alert["deviceId"]},
            UpdateExpression="SET lastEmailAt = :n",
            ConditionExpression="attribute_not_exists(lastEmailAt) OR lastEmailAt < :cut",
            ExpressionAttributeValues={":n": now_ms(), ":cut": now_ms() - EMAIL_COOLDOWN_MS},
        )
    except ClientError:
        return  # another invocation just emailed
    when = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(alert["ts"] / 1000))
    sns.publish(
        TopicArn=SNS_TOPIC,
        Subject=f"PulseLake ALERT: {alert['deviceId']} {alert['type']}"[:99],
        Message=(
            f"CRITICAL alert from the PulseLake IoT fleet\n\n"
            f"Device : {alert['deviceId']} ({alert.get('owner') or 'unknown owner'})\n"
            f"Alert  : {alert['type']}\n"
            f"Detail : {alert['message']}\n"
            f"Source : {alert['source']}\n"
            f"Time   : {when}\n\n"
            f"Open the Mission Control dashboard to investigate."
        ),
    )


def open_alert(device, a_type, severity, message, source, hit_ts):
    """Create an ACTIVE alert unless one of this type is already open (conditional write)."""
    ts = now_ms()
    alert = {
        "alertId": uuid.uuid4().hex[:12],
        "deviceId": device["deviceId"],
        "owner": device.get("owner", ""),
        "ts": ts,
        "type": a_type,
        "severity": severity,
        "status": "ACTIVE",
        "message": message,
        "source": source,
    }
    sk = f"{ts:013d}#{alert['alertId']}"
    try:
        DEVICES.update_item(
            Key={"deviceId": device["deviceId"]},
            UpdateExpression="SET #a = if_not_exists(#a, :empty)",
            ExpressionAttributeNames={"#a": "active"},
            ExpressionAttributeValues={":empty": {}},
        )
        DEVICES.update_item(
            Key={"deviceId": device["deviceId"]},
            UpdateExpression="SET #a.#t = :v",
            ConditionExpression="attribute_not_exists(#a.#t)",
            ExpressionAttributeNames={"#a": "active", "#t": a_type},
            ExpressionAttributeValues={":v": to_ddb({"alertId": alert["alertId"], "sk": sk, "severity": severity,
                                                     "source": source, "since": ts, "lastHit": hit_ts})},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return None  # already open
        raise
    ALERTS.put_item(Item=to_ddb({**alert, "pk": "ALERT", "sk": sk,
                                 "expiresAt": int(time.time()) + ALERT_TTL_DAYS * 86400}))
    publish_alert(alert)
    maybe_email(device, alert)
    print(json.dumps({"opened": alert}))
    return alert


def resolve_alert(device, a_type, info, reason):
    try:
        DEVICES.update_item(
            Key={"deviceId": device["deviceId"]},
            UpdateExpression="REMOVE #a.#t",
            ConditionExpression="attribute_exists(#a.#t) AND #a.#t.alertId = :id",
            ExpressionAttributeNames={"#a": "active", "#t": a_type},
            ExpressionAttributeValues={":id": info["alertId"]},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return
        raise
    ts = now_ms()
    try:
        item = ALERTS.update_item(
            Key={"pk": "ALERT", "sk": info["sk"]},
            UpdateExpression="SET #s = :r, resolvedAt = :t, resolution = :why",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":r": "RESOLVED", ":t": ts, ":why": reason},
            ReturnValues="ALL_NEW",
        )["Attributes"]
        alert = {k: v for k, v in from_ddb(item).items() if k not in ("pk", "sk", "expiresAt")}
    except ClientError:
        alert = {"alertId": info["alertId"], "deviceId": device["deviceId"], "type": a_type, "ts": ts,
                 "severity": info.get("severity", "WARNING"), "source": info.get("source", ""), "message": reason}
    alert["status"] = "RESOLVED"
    alert["message"] = f"{alert.get('message', '')} - resolved: {reason}"
    publish_alert(alert)
    print(json.dumps({"resolved": alert}))


# ----------------------------------------------------------------- handlers
def handle_telemetry(m):
    device_id = m.get("id") or m.get("thing")
    device = get_device(device_id)
    ts = now_ms()
    active = device.get("active", {}) or {}

    fp = fingerprint(m)
    seq = int(_num(m, "seq", -1))

    hits = {}
    for a_type, severity, test, msg, _hold in CONDITIONS:
        if test(m):
            hits[a_type] = (severity, msg(m))
    # 3 identical samples in a row = frozen sensor (a single match can happen by chance)
    frozen_count = int(device.get("frozenCount", 0)) + 1 if device.get("fingerprint") == fp else 0
    if frozen_count >= 2:
        hits["SENSOR_FROZEN"] = ("WARNING", "Last 3 readings are identical - sensor appears frozen")

    # Messages can arrive out of order (parallel Lambdas). Only a NEWER reading may change
    # alert state; the conditional write makes that check atomic.
    try:
        DEVICES.update_item(
            Key={"deviceId": device_id},
            UpdateExpression="SET fingerprint = :fp, frozenCount = :fc, lastSeq = :sq, lastTs = :mts, lastSeen = :ts, "
                             "#o = :o, #p = :p, health = :h, #on = :on",
            ConditionExpression="attribute_not_exists(lastTs) OR lastTs < :mts",
            ExpressionAttributeNames={"#o": "owner", "#p": "profile", "#on": "online"},  # DynamoDB reserved words
            ExpressionAttributeValues={":fp": fp, ":fc": frozen_count, ":sq": seq, ":mts": int(_num(m, "ts")), ":ts": ts,
                                       ":o": m.get("owner", ""), ":p": m.get("profile", ""),
                                       ":h": m.get("health", "OK"), ":on": True},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return  # older than what we already processed
        raise
    device["owner"] = m.get("owner", "")

    for a_type, (severity, message) in hits.items():
        if a_type in active:
            if ts - int(active[a_type].get("lastHit", 0)) > 5000:
                try:
                    DEVICES.update_item(
                        Key={"deviceId": device_id},
                        UpdateExpression="SET #a.#t.lastHit = :ts",
                        ConditionExpression="attribute_exists(#a.#t)",
                        ExpressionAttributeNames={"#a": "active", "#t": a_type},
                        ExpressionAttributeValues={":ts": ts},
                    )
                except ClientError:
                    pass  # resolved meanwhile
        else:
            open_alert(device, a_type, severity, message, "CLOUD_RULE", ts)

    holds = {c[0]: c[4] for c in CONDITIONS}
    for a_type, info in active.items():
        if info.get("source") != "CLOUD_RULE" or a_type in hits:
            continue
        if ts - int(info.get("lastHit", 0)) >= holds.get(a_type, 0):
            resolve_alert(device, a_type, info, "readings back to normal")


def handle_presence(p):
    device_id = p["clientId"]
    device = get_device(device_id)
    ts = int(p.get("timestamp", now_ms()))
    if ts < int(device.get("presenceTs", 0)):
        return  # out-of-order event
    connected = p.get("eventType") == "connected"
    DEVICES.update_item(
        Key={"deviceId": device_id},
        UpdateExpression="SET presenceTs = :ts, #on = :on, disconnectReason = :r",
        ExpressionAttributeNames={"#on": "online"},
        ExpressionAttributeValues={":ts": ts, ":on": connected, ":r": p.get("disconnectReason", "")},
    )
    active = device.get("active", {}) or {}
    if connected:
        if "OFFLINE" in active:
            resolve_alert(device, "OFFLINE", active["OFFLINE"], "device reconnected")
        return
    reason = p.get("disconnectReason", "UNKNOWN")
    if reason == "DUPLICATE_CLIENTID":
        return  # another phone took the slot - not a failure
    # A browser closes its socket "politely" even when the app dies, so AWS may report
    # CLIENT_INITIATED_DISCONNECT. The real signal is OUR protocol: a device that leaves on
    # purpose sends a GOODBYE event first. No recent GOODBYE = unexpected loss.
    if ts - int(device.get("goodbyeAt", 0)) > GOODBYE_WINDOW_MS:
        time.sleep(1.5)  # the GOODBYE may still be in flight in a parallel invocation
        device = get_device(device_id)
    if ts - int(device.get("goodbyeAt", 0)) <= GOODBYE_WINDOW_MS:
        return  # graceful leave / auto-sleep
    detail = {
        "MQTT_KEEP_ALIVE_TIMEOUT": "no heartbeat - network silently lost",
        "CONNECTION_LOST": "connection dropped",
        "CLIENT_INITIATED_DISCONNECT": "socket closed without a goodbye - app crashed or was closed",
    }.get(reason, reason)
    open_alert(device, "OFFLINE", "CRITICAL", f"Device went offline unexpectedly: {detail} ({reason}).", "PRESENCE", ts)


def handle_event(e):
    device_id = e.get("id")
    if not device_id:
        return
    values = {":o": e.get("owner", ""), ":p": e.get("profile", ""), ":ts": now_ms()}
    expr = "SET #o = :o, #p = :p, lastEventAt = :ts"
    if e.get("type") == "GOODBYE":
        expr += ", #on = :f, goodbyeAt = :ts"
        values[":f"] = False
    names = {"#o": "owner", "#p": "profile"}
    if e.get("type") == "GOODBYE":
        names["#on"] = "online"
    DEVICES.update_item(Key={"deviceId": device_id}, UpdateExpression=expr,
                        ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def handler(event, _context):
    kind = event.get("kind")
    if kind == "telemetry":
        handle_telemetry(event)
    elif kind == "presence":
        handle_presence(event)
    elif kind == "event":
        handle_event(event)
    else:
        print(f"unknown input: {json.dumps(event)[:500]}")
