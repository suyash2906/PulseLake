"""PulseLake alert processor (AWS Lambda, invoked by IoT Rules and by the rule runner).

Inputs (field `kind` is added by the IoT Rule SQL):
  telemetry - pre-filtered by the rule: abnormal readings, readings that match a user rule
              (the rule SQL is compiled from the Rules & Actions table) + every 5th message
  presence  - AWS IoT lifecycle events ($aws/events/presence/...) for PHONE_* clients
  event     - device events (ONLINE / GOODBYE / FAULT_* / FALL_* / SOS / HR_CHECK / CHECK_OK)
  rule_hit / rule_clear - from the rule runner (absence rules, lake rules)

The CLOUD decides what is an alert (thresholds, frozen-sensor detection, unexpected disconnects,
user-defined rules). State lives in DynamoDB so we alert only on CHANGES (no spam) and can mark
alerts RESOLVED. Every alert is republished on MQTT topic pulselake/alerts (dashboard + S3
archive rule); CRITICAL ones are emailed through SNS (max 1 email per device per 2 minutes).
When a rule says so, the alert is handed to the action dispatcher (push to responders,
Step Functions escalation, device commands).
"""
import json
import math
import os
import time
import uuid
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
DEVICES = dynamodb.Table(os.environ["DEVICES_TABLE"])
ALERTS = dynamodb.Table(os.environ["ALERTS_TABLE"])
PLATFORM = dynamodb.Table(os.environ["PLATFORM_TABLE"]) if os.environ.get("PLATFORM_TABLE") else None
DISPATCHER = os.environ.get("DISPATCHER_FUNCTION", "")
SNS_TOPIC = os.environ.get("ALERT_TOPIC_ARN", "")
ALERT_MQTT_TOPIC = "pulselake/alerts"
ALERT_TTL_DAYS = 7
EMAIL_COOLDOWN_MS = 120_000
GOODBYE_WINDOW_MS = 15_000  # a disconnect within 15 s after GOODBYE is a planned leave
NOISE_LIMIT_DBA = 85  # NIOSH recommended exposure limit (8-h average); here: sustained level
NOISE_SUSTAIN_MS = 10_000
TZ_OFFSET_MIN = 330  # rule time windows are local time (IST, UTC+5:30)
DEFAULT_COOLDOWN_MIN = 10

sns = boto3.client("sns")
lambda_client = boto3.client("lambda")
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


# ----------------------------------------------------------------- predictive early warning
PREDICT_LIMIT_C = 70.0       # same limit as OVERHEAT
PREDICT_HORIZON_S = 60       # warn if the limit will be crossed within 60 s
PREDICT_MIN_SLOPE = 0.15     # C per second - ignore slow drift / noise
HIST_WINDOW_MS = 25_000      # fit the trend on the last 25 s (older calm readings would hide a new rise)
PREDICT_HOLD_MS = 6_000      # keep the warning a few seconds to avoid flapping


def predict_overheat(hist):
    """Least-squares trend line over recent [ts_ms, temp] samples.
    Returns (slope C/s, seconds until 70 C, fitted temp now) or None."""
    pts = [p for p in hist if hist[-1][0] - p[0] <= HIST_WINDOW_MS]
    if len(pts) < 4:
        return None
    t0 = pts[0][0]
    xs = [(p[0] - t0) / 1000.0 for p in pts]
    ys = [float(p[1]) for p in pts]
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    now_fit = my + slope * (xs[-1] - mx)
    if slope < PREDICT_MIN_SLOPE or ys[-1] >= PREDICT_LIMIT_C:
        return None
    eta = (PREDICT_LIMIT_C - max(now_fit, ys[-1])) / slope
    return (slope, eta, now_fit) if 0 < eta <= PREDICT_HORIZON_S else None


def fingerprint(m):
    """Readings that always carry noise on a healthy device. Identical values = frozen sensor."""
    return "|".join(str(m.get(k)) for k in ("temp", "hum", "volt", "acc", "vib"))


# ----------------------------------------------------------------- user rules (Rules & Actions)
_rules_cache = {"at": 0, "rules": []}
_zones_cache = {}
OPS = {">": lambda a, b: a > b, "<": lambda a, b: a < b, ">=": lambda a, b: a >= b, "<=": lambda a, b: a <= b}
URGENT_ALERTS = ("FALL", "SOS")  # never held back by a cooldown
EVENT_METRICS = ("hr",)  # measured on demand (events), not in every telemetry message


def load_rules():
    """Enabled rules from the platform table (cached 20 s per warm Lambda)."""
    if not PLATFORM:
        return []
    if time.time() - _rules_cache["at"] > 20:
        items = PLATFORM.query(KeyConditionExpression=Key("pk").eq("RULE")).get("Items", [])
        _rules_cache["rules"] = [from_ddb(i) for i in items if i.get("enabled")]
        _rules_cache["at"] = time.time()
    return _rules_cache["rules"]


def rule_by_id(rule_id):
    for r in load_rules():
        if r.get("ruleId") == rule_id:
            return r
    item = PLATFORM.get_item(Key={"pk": "RULE", "sk": rule_id}).get("Item") if PLATFORM else None
    return from_ddb(item) if item else None


def in_scope(rule, device_id):
    devices = rule.get("devices") or []
    if devices:
        return device_id in devices
    return not device_id.startswith("SIM_")  # "all phones" never includes the load-test fleet


def in_window(rule, ts_ms=None):
    w = rule.get("window")
    if not w:
        return True
    minute = int(((ts_ms or now_ms()) / 60000 + TZ_OFFSET_MIN) % 1440)

    def mins(hhmm):
        h, m = (hhmm or "0:0").split(":")
        return int(h) * 60 + int(m)

    a, b = mins(w.get("from")), mins(w.get("to"))
    return a <= minute < b if a <= b else (minute >= a or minute < b)


def zones_of(device_id):
    hit = _zones_cache.get(device_id)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    zones = {}
    if PLATFORM:
        res = PLATFORM.query(KeyConditionExpression=Key("pk").eq(f"DEV#{device_id}") & Key("sk").begins_with("ZONE#"))
        for z in res.get("Items", []):
            z = from_ddb(z)
            zones[z["name"]] = z
    _zones_cache[device_id] = (time.time(), zones)
    return zones


def distance_m(lat1, lon1, lat2, lon2):
    """Haversine distance in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(a))


METRIC_LABEL = {"hr": ("heart rate", "bpm"), "noise": ("noise", "dB(A)"), "temp": ("temperature", "C"),
                "hum": ("humidity", "%"), "bat": ("battery", "%"), "volt": ("voltage", "V"),
                "vibPeak": ("vibration", "m/s2"), "stillSec": ("time without movement", "s"),
                "stepsDay": ("steps today", ""), "spd": ("speed", "m/s")}


def evaluate_rules(device, values, ts, kinds=("live", "zone")):
    """Live/zone rules against one message. Returns (hits {code: (sev, msg, rule)}, evaluated codes, since map)."""
    device_id = device["deviceId"]
    owner = device.get("owner") or device_id
    since = dict(device.get("ruleSince") or {})
    hits, evaluated = {}, set()
    for rule in load_rules():
        if rule.get("kind") not in kinds or not in_scope(rule, device_id):
            continue
        rid, code = rule["ruleId"], rule["code"]
        cond, text = None, ""
        if rule["kind"] == "live":
            v = values.get(rule.get("metric"))
            if not isinstance(v, (int, float)) or isinstance(v, bool) or rule.get("op") not in OPS:
                continue  # this message does not carry the metric
            cond = OPS[rule["op"]](float(v), float(rule.get("value", 0)))
            label, unit = METRIC_LABEL.get(rule.get("metric"), (rule.get("metric"), ""))
            text = f"{owner}: {label} {v:g} {unit} ({rule['op']} {rule.get('value')}) - rule \"{rule['name']}\""
        elif rule["kind"] == "zone":
            lat, lon = values.get("lat"), values.get("lon")
            zone = zones_of(device_id).get(rule.get("zone"))
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or not zone:
                continue
            d = distance_m(lat, lon, float(zone["lat"]), float(zone["lon"]))
            outside = d > float(zone.get("radiusM", 300))
            cond = outside if rule.get("when", "outside") == "outside" else not outside
            text = (f"{owner} is {d:.0f} m from {rule.get('zone')} "
                    f"({'outside' if outside else 'inside'} the {float(zone.get('radiusM', 300)):.0f} m zone) - rule \"{rule['name']}\"")
        evaluated.add(code)
        if cond and in_window(rule, ts):
            since.setdefault(rid, ts)
            if ts - int(since[rid]) >= float(rule.get("forSec") or 0) * 1000:
                hits[code] = (rule.get("severity", "WARNING"), text, rule)
        else:
            since.pop(rid, None)
    return hits, evaluated, since


def actions_for(device, alert, rule=None):
    """The actions to run for a new alert: the rule's own, or every alert-rule that reacts to this type."""
    if rule:
        return dict(rule.get("actions") or {}), rule
    merged, first = {}, None
    for r in load_rules():
        if r.get("kind") == "alert" and alert["type"] in (r.get("alertTypes") or []) \
                and in_scope(r, device["deviceId"]) and in_window(r, alert["ts"]):
            for k, v in (r.get("actions") or {}).items():
                if v:
                    merged[k] = merged.get(k) or v
            first = first or r
    return merged, first


def dispatch(payload):
    """Hand an action request to the action dispatcher (async - never slows the alert path)."""
    if not DISPATCHER:
        return
    try:
        lambda_client.invoke(FunctionName=DISPATCHER, InvocationType="Event",
                             Payload=json.dumps(payload, default=str).encode())
    except ClientError as e:
        print(f"dispatch failed: {e}")


def run_actions(device, alert, rule=None):
    actions, matched = actions_for(device, alert, rule)
    actions = {k: v for k, v in actions.items() if v}
    if alert["source"] != "USER_RULE" and alert["source"] != "LAKE_RULE":
        actions.pop("email", None)  # built-in CRITICAL alerts are already emailed by maybe_email
    if not actions or alert["deviceId"].startswith("SIM_") and not (rule and rule.get("devices")):
        return False
    rule_id = matched["ruleId"] if matched else None
    if rule_id and alert["type"] not in URGENT_ALERTS:
        cool = (device.get("cool") or {}).get(rule_id, 0)
        cooldown = float((matched or {}).get("cooldownMin") or DEFAULT_COOLDOWN_MIN) * 60000
        if now_ms() - int(cool) < cooldown:
            print(json.dumps({"cooldown": rule_id, "device": alert["deviceId"]}))
            return False
    if rule_id:
        try:
            DEVICES.update_item(Key={"deviceId": alert["deviceId"]},
                                UpdateExpression="SET cool = if_not_exists(cool, :e)", ExpressionAttributeValues={":e": {}})
            DEVICES.update_item(Key={"deviceId": alert["deviceId"]}, UpdateExpression="SET cool.#r = :t",
                                ExpressionAttributeNames={"#r": rule_id}, ExpressionAttributeValues={":t": now_ms()})
            PLATFORM.update_item(Key={"pk": "RULE", "sk": rule_id},
                                 UpdateExpression="ADD hits :one SET lastFiredAt = :t",
                                 ConditionExpression="attribute_exists(pk)",
                                 ExpressionAttributeValues={":one": 1, ":t": now_ms()})
        except ClientError as e:
            print(f"rule bookkeeping failed: {e}")
    dispatch({"mode": "alert", "alert": alert, "actions": actions,
              "rule": {"ruleId": rule_id, "name": matched.get("name"), "code": matched.get("code")} if matched else None,
              "device": {"owner": device.get("owner", ""), "lat": device.get("lat"), "lon": device.get("lon")}})
    return True


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


URGENT_TYPES = ("FALL", "SOS")  # a person may be hurt: always email, no cooldown


def maybe_email(device, alert):
    if not SNS_TOPIC or alert["severity"] != "CRITICAL" or alert["status"] != "ACTIVE":
        return
    if alert["deviceId"].startswith("SIM_"):
        return  # virtual fleet (load test) never emails
    urgent = alert["type"] in URGENT_TYPES
    if not urgent and now_ms() - int(device.get("lastEmailAt", 0)) < EMAIL_COOLDOWN_MS:
        return
    if not urgent:
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


def open_alert(device, a_type, severity, message, source, hit_ts, extra=None, rule=None):
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
        **({"ruleId": rule["ruleId"], "ruleName": rule.get("name")} if rule else {}),
        **{k: v for k, v in (extra or {}).items() if v is not None},
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
                                                     "source": source, "since": ts, "lastHit": hit_ts,
                                                     **({"ruleId": rule["ruleId"], "kind": rule.get("kind"),
                                                         "absence": rule.get("absence") or ""} if rule else {})})},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return None  # already open
        raise
    ALERTS.put_item(Item=to_ddb({**alert, "pk": "ALERT", "sk": sk,
                                 "expiresAt": int(time.time()) + ALERT_TTL_DAYS * 86400}))
    publish_alert(alert)
    maybe_email(device, alert)
    if run_actions(device, alert, rule):
        try:  # remember that people were told, so they also hear when it is resolved
            DEVICES.update_item(Key={"deviceId": device["deviceId"]}, UpdateExpression="SET #a.#t.notified = :y",
                                ConditionExpression="attribute_exists(#a.#t)",
                                ExpressionAttributeNames={"#a": "active", "#t": a_type},
                                ExpressionAttributeValues={":y": True})
        except ClientError:
            pass
    print(json.dumps({"opened": alert}, default=str))
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
            # the stored alert may have expired (7-day TTL): never re-create it as an empty record
            ConditionExpression="attribute_exists(pk)",
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
    if info.get("notified"):
        dispatch({"mode": "resolved", "alert": alert, "reason": reason})
    print(json.dumps({"resolved": alert}, default=str))


def touch_alert(device_id, a_type, info, ts):
    """The condition is still true: keep the open alert alive (lastHit drives the resolve hold)."""
    if ts - int(info.get("lastHit", 0)) <= 5000:
        return
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

    # Noise exposure: only a SUSTAINED level counts (a single clap is not a hazard).
    noise = m.get("noise")
    loud_since = device.get("loudSince")
    if isinstance(noise, (int, float)) and noise > NOISE_LIMIT_DBA:
        loud_since = loud_since or int(_num(m, "ts"))
        if int(_num(m, "ts")) - int(loud_since) >= NOISE_SUSTAIN_MS:
            hits["NOISE_HIGH"] = ("WARNING", f"Noise {noise:.0f} dB(A) above the {NOISE_LIMIT_DBA} dB(A) exposure limit for over {NOISE_SUSTAIN_MS // 1000} s")
    else:
        loud_since = 0

    # Predictive analytics: fit a trend on recent temperatures and warn BEFORE the limit.
    msg_ts = int(_num(m, "ts"))
    hist = [p for p in (device.get("tempHist") or []) if msg_ts - p[0] <= HIST_WINDOW_MS and p[0] < msg_ts]
    hist = (hist + [[msg_ts, round(_num(m, "temp"), 2)]])[-15:]
    extra = {}
    prediction = predict_overheat(hist)
    if prediction:
        slope, eta, now_fit = prediction
        hits["PREDICTED_OVERHEAT"] = (
            "WARNING",
            f"Temperature rising {slope:.1f} C/s - predicted to exceed 70 C in ~{eta:.0f} s (now {now_fit:.1f} C)",
        )
        extra["PREDICTED_OVERHEAT"] = {"etaSec": round(eta, 1), "slope": round(slope, 2)}
    if "OVERHEAT" in hits and "PREDICTED_OVERHEAT" in active:
        lead = (ts - int(active["PREDICTED_OVERHEAT"].get("since", ts))) / 1000
        sev, text = hits["OVERHEAT"]
        hits["OVERHEAT"] = (sev, f"{text} - the cloud predicted it {lead:.0f} s in advance")
        extra["OVERHEAT"] = {"predictedLeadSec": round(lead, 1)}

    # User rules from the Rules & Actions engine (live metric thresholds, geofences)
    device["owner"] = m.get("owner", "") or device.get("owner", "")
    rule_hits, evaluated, rule_since = evaluate_rules(device, m, msg_ts)

    # Latest sensor state, read by the rule runner (absence rules) and the Responder app.
    sets = ["fingerprint = :fp", "frozenCount = :fc", "lastSeq = :sq", "lastTs = :mts", "lastSeen = :ts",
            "tempHist = :th", "loudSince = :ls", "#o = :o", "#p = :p", "health = :h", "#on = :on", "ruleSince = :rs",
            "bat = :bat", "chg = :chg", "motionPaused = :mp"]
    values = {":fp": fp, ":fc": frozen_count, ":sq": seq, ":mts": msg_ts, ":ts": ts,
              ":th": to_ddb(hist), ":ls": int(loud_since or 0),
              ":o": m.get("owner", ""), ":p": m.get("profile", ""),
              ":h": m.get("health", "OK"), ":on": True, ":rs": to_ddb(rule_since),
              ":bat": int(_num(m, "bat", 100)), ":chg": bool(m.get("chg")), ":mp": bool(m.get("mp"))}
    if isinstance(m.get("stillSec"), (int, float)):
        sets.append("lastMoveAt = :mv")
        values[":mv"] = int(ts - float(m["stillSec"]) * 1000)
    for field in ("stepsDay", "act"):
        if m.get(field) is not None:
            sets.append(f"{field} = :{field}")
            values[f":{field}"] = to_ddb(m[field])
    if isinstance(m.get("lat"), (int, float)) and isinstance(m.get("lon"), (int, float)):
        sets.append("lat = :lat, lon = :lon, gacc = :gacc, locAt = :ts")
        values.update({":lat": to_ddb(m["lat"]), ":lon": to_ddb(m["lon"]), ":gacc": to_ddb(m.get("gacc") or 0)})

    # Messages can arrive out of order (parallel Lambdas). Only a NEWER reading may change
    # alert state; the conditional write makes that check atomic.
    try:
        DEVICES.update_item(
            Key={"deviceId": device_id},
            UpdateExpression="SET " + ", ".join(sets),
            ConditionExpression="attribute_not_exists(lastTs) OR lastTs < :mts",
            ExpressionAttributeNames={"#o": "owner", "#p": "profile", "#on": "online"},  # DynamoDB reserved words
            ExpressionAttributeValues=values,
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return  # older than what we already processed
        raise
    if isinstance(m.get("lat"), (int, float)):
        device["lat"], device["lon"] = m["lat"], m.get("lon")

    for code, (severity, message, rule) in rule_hits.items():
        if code in active:
            touch_alert(device_id, code, active[code], ts)
        else:
            open_alert(device, code, severity, message, "USER_RULE", ts,
                       {"lat": m.get("lat"), "lon": m.get("lon")}, rule)
    for code, info in active.items():
        if info.get("source") != "USER_RULE" or info.get("kind") not in ("live", "zone") or code in rule_hits:
            continue
        quiet = ts - int(info.get("lastHit", 0))
        if code in evaluated and quiet >= 5000:
            resolve_alert(device, code, info, "condition no longer true")
        elif code not in evaluated:
            # the sensor stopped reporting (microphone or GPS switched off): close it after a while;
            # event-based readings (heart-rate checks) keep their alert open for 10 minutes
            rule = rule_by_id(info.get("ruleId")) or {}
            limit = 600_000 if rule.get("metric") in EVENT_METRICS else 60_000
            if quiet >= limit:
                resolve_alert(device, code, info, "no recent readings from that sensor")

    for a_type, (severity, message) in hits.items():
        if a_type in active:
            touch_alert(device_id, a_type, active[a_type], ts)
        else:
            open_alert(device, a_type, severity, message, "CLOUD_RULE", ts, extra.get(a_type))

    holds = {c[0]: c[4] for c in CONDITIONS}
    holds["PREDICTED_OVERHEAT"] = PREDICT_HOLD_MS
    holds["NOISE_HIGH"] = 5000
    for a_type, info in active.items():
        if info.get("source") != "CLOUD_RULE" or a_type in hits:
            continue
        if a_type == "PREDICTED_OVERHEAT" and "OVERHEAT" in hits:
            resolve_alert(device, a_type, info, "prediction confirmed - the device overheated")
        elif ts - int(info.get("lastHit", 0)) >= holds.get(a_type, 0):
            reason = "temperature trend stabilised" if a_type == "PREDICTED_OVERHEAT" else "readings back to normal"
            resolve_alert(device, a_type, info, reason)


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


def handle_safety_event(e):
    """Falls and SOS are detected ON THE PHONE (edge); the cloud alerts, emails and records them."""
    device = get_device(e["id"])
    device["owner"] = e.get("owner", device.get("owner", ""))
    active = device.get("active", {}) or {}
    owner = device["owner"] or e["id"]
    kind = e.get("type")
    ts = int(_num(e, "ts", now_ms()))
    where = {"lat": e.get("lat"), "lon": e.get("lon")} if isinstance(e.get("lat"), (int, float)) else {}
    if kind == "FALL_DETECTED":
        conf = f", confidence {_num(e, 'confidence'):.0f}/100" if e.get("confidence") is not None else ""
        open_alert(device, "FALL", "CRITICAL",
                   f"Fall detected for {owner}: impact {_num(e, 'impactG'):.1f} g, free fall {_num(e, 'freeFallMs'):.0f} ms, "
                   f"turned {_num(e, 'angleChange'):.0f} deg{conf}, no answer to 'Are you OK?' for 15 s",
                   "EDGE", ts, {"impactG": _num(e, "impactG"), "freeFallMs": _num(e, "freeFallMs"), **where})
    elif kind == "FALL_RESOLVED" and "FALL" in active:
        resolve_alert(device, "FALL", active["FALL"], f"{owner} confirmed they are OK")
    elif kind == "FALL_RECOVERED":
        # informational: the family hears it, nothing stays open
        alert = open_alert(device, "FALL_RECOVERED", "INFO",
                           f"{owner} fell (impact {_num(e, 'impactG'):.1f} g) but got up and walked within 15 s", "EDGE", ts)
        if alert:
            info = (get_device(device["deviceId"]).get("active") or {}).get("FALL_RECOVERED")
            if info:
                resolve_alert(device, "FALL_RECOVERED", info, "person is moving normally")
    elif kind == "SOS":
        open_alert(device, "SOS", "CRITICAL", f"{owner} pressed the SOS button and needs help", "EDGE", ts, where)
    elif kind == "SOS_CLEARED" and "SOS" in active:
        resolve_alert(device, "SOS", active["SOS"], f"{owner} cancelled the SOS")
    # FALL_CANCELLED = false alarm the person dismissed: no alert, but it is kept in the lake


def handle_hr_check(e):
    """Camera heart-rate measurement: keep the latest value and run heart-rate rules on it."""
    device = get_device(e["id"])
    device["owner"] = e.get("owner") or device.get("owner", "")
    bpm = _num(e, "bpm", 0)
    ts = now_ms()
    DEVICES.update_item(Key={"deviceId": e["id"]}, UpdateExpression="SET hr = :b, hrQuality = :q, hrAt = :t",
                        ExpressionAttributeValues={":b": int(bpm), ":q": to_ddb(_num(e, "quality", 0)), ":t": ts})
    hits, evaluated, _ = evaluate_rules(device, {"hr": bpm}, ts, kinds=("live",))
    active = device.get("active", {}) or {}
    for code, (severity, message, rule) in hits.items():
        if code not in active:
            open_alert(device, code, severity, message, "USER_RULE", ts, None, rule)
    for code, info in active.items():
        if info.get("source") == "USER_RULE" and code in evaluated and code not in hits:
            resolve_alert(device, code, info, f"heart rate back to {bpm:.0f} bpm")


def handle_check_ok(e):
    """The person answered the cloud's 'Are you OK?': count it as activity, close no-movement alerts."""
    device = get_device(e["id"])
    DEVICES.update_item(Key={"deviceId": e["id"]}, UpdateExpression="SET lastMoveAt = :t REMOVE asks",
                        ExpressionAttributeValues={":t": now_ms()})
    for code, info in (device.get("active") or {}).items():
        if info.get("absence") == "no_movement":
            resolve_alert(device, code, info, f"{e.get('owner') or e['id']} answered 'I'm OK'")


ANOMALY_LABEL = {"temp": ("temperature", "C"), "noise": ("noise level", "dB(A)")}


def handle_anomaly(m):
    """From the speed layer (lake writer): a reading is far outside THIS device's own normal (z-score)."""
    device = get_device(m["deviceId"])
    device["owner"] = m.get("owner") or device.get("owner", "")
    a_type = f"ANOMALY_{m['metric'].upper()}"
    active = device.get("active", {}) or {}
    label, unit = ANOMALY_LABEL.get(m["metric"], (m["metric"], ""))
    if m["kind"] == "anomaly":
        if a_type in active:
            touch_alert(m["deviceId"], a_type, active[a_type], now_ms())
            return
        direction = "above" if m["z"] > 0 else "below"
        open_alert(device, a_type, "INFO",
                   f"Unusual {label} for {device['owner'] or m['deviceId']}: {m['value']} {unit} is {abs(m['z']):.1f} "
                   f"standard deviations {direction} this device's normal ({m['mean']} ± {m['sd']} {unit}, streaming z-score)",
                   "STATS", now_ms(), {"z": m["z"]})
    elif a_type in active:
        resolve_alert(device, a_type, active[a_type], f"{label} back within the normal range ({m.get('value')} {unit})")


def handle_system_check(m):
    """Platform health from the rule runner, e.g. the data lake stopped receiving files."""
    device = get_device(m["deviceId"])
    device["owner"] = "PulseLake platform"
    active = device.get("active", {}) or {}
    if not m.get("ok"):
        if m["type"] not in active:
            open_alert(device, m["type"], m.get("severity", "WARNING"), m["message"], "PLATFORM", now_ms())
    elif m["type"] in active:
        resolve_alert(device, m["type"], active[m["type"]], m.get("message") or "healthy again")


def handle_rule_result(m):
    """From the rule runner: an absence or lake rule became true (rule_hit) or false (rule_clear)."""
    rule = rule_by_id(m.get("ruleId"))
    if not rule:
        return
    device = get_device(m["deviceId"])
    active = device.get("active", {}) or {}
    code = rule["code"]
    if m["kind"] == "rule_hit":
        if code in active:
            touch_alert(m["deviceId"], code, active[code], now_ms())
            return
        source = "LAKE_RULE" if rule.get("kind") == "lake" else "USER_RULE"
        open_alert(device, code, rule.get("severity", "WARNING"), m.get("message") or rule["name"], source, now_ms(),
                   {"lat": device.get("lat"), "lon": device.get("lon")}, rule)
    elif code in active:
        resolve_alert(device, code, active[code], m.get("message") or "condition no longer true")


def handle_event(e):
    device_id = e.get("id")
    if not device_id:
        return
    if e.get("type") in ("FALL_DETECTED", "FALL_RESOLVED", "FALL_RECOVERED", "SOS", "SOS_CLEARED"):
        handle_safety_event(e)
    elif e.get("type") == "HR_CHECK":
        handle_hr_check(e)
    elif e.get("type") == "CHECK_OK":
        handle_check_ok(e)
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
    elif kind in ("rule_hit", "rule_clear"):
        handle_rule_result(event)
    elif kind in ("anomaly", "anomaly_clear"):
        handle_anomaly(event)
    elif kind == "system_check":
        handle_system_check(event)
    else:
        print(f"unknown input: {json.dumps(event)[:500]}")
