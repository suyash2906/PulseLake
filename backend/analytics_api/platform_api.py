"""PulseLake platform API: Rules & Actions, responders (pairing, push, ack), zones, Accuracy Lab.

Routes (all JSON, same Function URL as the analytics API):
  GET  /rules                 list rules            POST /rules           create / update a rule
  POST /rules/delete          {ruleId}              POST /rules/toggle    {ruleId, enabled}
  POST /rules/pack            install a use-case pack {pack, rules[], devices[]}
  GET  /rules/sql             current AWS IoT Rule SQL (compiled from the rules)
  POST /rules/compile         re-compile the IoT Rule SQL
  POST /rules/run             {ruleId} run a lake rule now (Athena)
  POST /pair/start            {deviceId, owner} -> one-time 6-digit code (10 min)
  POST /pair                  {code, name, level} -> responder token
  GET  /responder/me          (Bearer token) paired devices, live state, recent alerts
  POST /responder/subscribe   (Bearer) store the Web Push subscription
  POST /responder/test        (Bearer) send a test notification
  POST /responder/unpair      (Bearer) {deviceId}
  POST /ack                   (Bearer) {alertId} "I'm handling it"
  GET  /zones  POST /zones    named places for geofence rules
  GET  /responders  GET /actions  GET /escalations   (dashboard)
  POST /command               {deviceId, cmd, text} send a message / "Are you OK?" to a device
  GET  /lab/traces  GET /lab/trace?key=  POST /lab/label  POST /lab/run  GET /lab/result

Security model (prototype): responders authenticate with a random token whose hash is stored;
a pairing code proves physical access to the monitored phone and works once, for 10 minutes.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
PLATFORM = dynamodb.Table(os.environ["PLATFORM_TABLE"])
DEVICES = dynamodb.Table(os.environ["DEVICES_TABLE"])
ALERTS = dynamodb.Table(os.environ["ALERTS_TABLE"])
LAKE_BUCKET = os.environ["LAKE_BUCKET"]
DISPATCHER = os.environ.get("DISPATCHER_FUNCTION", "")
RULE_RUNNER = os.environ.get("RULE_RUNNER_FUNCTION", "")
ACCURACY_LAB = os.environ.get("ACCURACY_LAB_FUNCTION", "")
TELEMETRY_RULE = os.environ.get("TELEMETRY_RULE_NAME", "pulselake_telemetry_alerts")
lambda_client = boto3.client("lambda")
iot = boto3.client("iot")
s3 = boto3.client("s3")

DEVICE_ID = re.compile(r"^(PHONE_0[1-4]|SIM_[A-Z0-9_]{1,20})$")
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
KINDS = ("live", "zone", "absence", "lake", "alert")
SEVERITIES = ("INFO", "WARNING", "CRITICAL")
OPS = (">", "<", ">=", "<=")
METRICS = ("hr", "noise", "temp", "hum", "bat", "volt", "vibPeak", "stillSec", "stepsDay", "spd")
TELEMETRY_METRICS = ("noise", "temp", "hum", "bat", "volt", "vibPeak", "stillSec", "stepsDay", "spd")
ABSENCE = ("no_movement", "offline", "battery")
TEMPLATES = ("steps_below_baseline", "active_minutes_low", "noise_dose", "falls_week")
ALERT_TYPES = ("FALL", "SOS", "FALL_RECOVERED", "OFFLINE", "OVERHEAT", "PREDICTED_OVERHEAT", "POWER_SURGE",
               "BATTERY_LOW", "NOISE_HIGH", "VIBRATION", "SENSOR_FROZEN")
RESERVED_CODES = set(ALERT_TYPES)
TRACE_LABELS = ("fall", "dropped", "sat", "walk", "jump", "other", "ignore")

# Must match the IoT Rule in infra/pulselake.yaml (the compiler appends user conditions to it)
BASE_SQL = "SELECT *, 'telemetry' AS kind FROM 'pulselake/devices/+/telemetry'"
BASE_WHERE = ("fault <> 'NONE' OR health <> 'OK' OR temp > 55 OR volt > 6 OR bat < 10 OR noise > 85 "
              "OR vibPeak > 15 OR seq % 5 = 0")


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def now_ms():
    return int(time.time() * 1000)


def plain(obj):
    return json.loads(json.dumps(obj, default=lambda d: int(d) if d == int(d) else float(d)))


def to_ddb(obj):
    return json.loads(json.dumps(obj), parse_float=Decimal)


def invoke(fn, payload, sync=False):
    res = lambda_client.invoke(FunctionName=fn, InvocationType="RequestResponse" if sync else "Event",
                               Payload=json.dumps(payload, default=str).encode())
    if not sync:
        return None
    body = json.loads(res["Payload"].read() or b"null")
    if res.get("FunctionError"):
        raise ApiError(500, (body or {}).get("errorMessage", "function failed"))
    return body


# ================================================================== rules
def list_rules():
    items = PLATFORM.query(KeyConditionExpression=Key("pk").eq("RULE")).get("Items", [])
    rules = [plain({k: v for k, v in i.items() if k not in ("pk", "sk")}) for i in items]
    return sorted(rules, key=lambda r: r.get("createdAt", 0))


def code_from(name, existing, own_code=None):
    base = re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")[:24].strip("_") or "RULE"
    if base in RESERVED_CODES:
        base = f"R_{base}"[:24]
    code, n = base, 2
    while code in existing and code != own_code:
        code = f"{base[:21]}_{n}"
        n += 1
    return code


def validate_rule(r):
    kind = r.get("kind")
    if kind not in KINDS:
        raise ApiError(400, "kind must be one of " + ", ".join(KINDS))
    name = str(r.get("name") or "").strip()[:60]
    if not name:
        raise ApiError(400, "a rule needs a name")
    devices = [d for d in (r.get("devices") or []) if isinstance(d, str)]
    if any(not DEVICE_ID.match(d) for d in devices):
        raise ApiError(400, "unknown device in scope")
    out = {"name": name, "kind": kind, "devices": devices, "enabled": bool(r.get("enabled", True)),
           "severity": r.get("severity") if r.get("severity") in SEVERITIES else "WARNING"}
    if r.get("pack"):
        out["pack"] = str(r["pack"])[:20]

    def num(key, lo, hi, default=None):
        try:
            v = float(r.get(key, default))
        except (TypeError, ValueError):
            raise ApiError(400, f"{key} must be a number")
        if not lo <= v <= hi:
            raise ApiError(400, f"{key} must be between {lo} and {hi}")
        return int(v) if v == int(v) else v

    if kind == "live":
        if r.get("metric") not in METRICS or r.get("op") not in OPS:
            raise ApiError(400, "live rules need a known metric and an operator")
        out.update(metric=r["metric"], op=r["op"], value=num("value", -1000, 100000), forSec=num("forSec", 0, 3600, 0))
    elif kind == "zone":
        zone = str(r.get("zone") or "").strip()[:20]
        if not zone:
            raise ApiError(400, "zone rules need a zone name")
        out.update(zone=zone, when="inside" if r.get("when") == "inside" else "outside")
    elif kind == "absence":
        if r.get("absence") not in ABSENCE:
            raise ApiError(400, "absence must be one of " + ", ".join(ABSENCE))
        out.update(absence=r["absence"], minutes=num("minutes", 1, 1440))
    elif kind == "lake":
        if r.get("template") not in TEMPLATES:
            raise ApiError(400, "unknown lake template")
        out.update(template=r["template"], param=num("param", 0, 100000), everyMin=num("everyMin", 5, 1440, 60))
    elif kind == "alert":
        types = [t for t in (r.get("alertTypes") or []) if t in ALERT_TYPES]
        if not types:
            raise ApiError(400, "alert rules need at least one alert type")
        out["alertTypes"] = types
    w = r.get("window")
    if w and w.get("from") and w.get("to"):
        if not HHMM.match(w["from"]) or not HHMM.match(w["to"]):
            raise ApiError(400, "time window must be HH:MM")
        out["window"] = {"from": w["from"], "to": w["to"]}
    a = r.get("actions") or {}
    actions = {k: True for k in ("push", "escalate", "email", "askOk", "boost") if a.get(k)}
    if a.get("message"):
        actions["message"] = str(a["message"])[:120]
    if actions.get("askOk") and not (kind == "absence" and out.get("absence") == "no_movement"):
        actions.pop("askOk")
    out["actions"] = actions
    out["cooldownMin"] = num("cooldownMin", 0, 1440, 10)
    return out


def save_rule(body, existing_rules=None):
    rules = existing_rules if existing_rules is not None else list_rules()
    clean = validate_rule(body)
    rule_id = body.get("ruleId") if isinstance(body.get("ruleId"), str) else None
    old = next((r for r in rules if r["ruleId"] == rule_id), None) if rule_id else None
    rule_id = rule_id if old else secrets.token_hex(5)
    codes = {r["code"] for r in rules if r["ruleId"] != rule_id}
    clean["ruleId"] = rule_id
    clean["code"] = old["code"] if old and old.get("name") == clean["name"] else code_from(clean["name"], codes)
    clean["createdAt"] = (old or {}).get("createdAt", now_ms())
    clean["hits"] = (old or {}).get("hits", 0)
    for k in ("lastFiredAt", "lastRunAt", "lastRun"):
        if old and k in old:
            clean[k] = old[k]
    PLATFORM.put_item(Item=to_ddb({"pk": "RULE", "sk": rule_id, **clean}))
    rules[:] = [r for r in rules if r["ruleId"] != rule_id] + [clean]
    return clean


def compile_rules():
    """User live-rule thresholds become extra OR clauses of the AWS IoT Rule, so the managed
    Rules Engine forwards exactly the messages that matter to the alert Lambda."""
    clauses = []
    for r in list_rules():
        if not r.get("enabled") or r.get("kind") != "live" or r.get("metric") not in TELEMETRY_METRICS:
            continue
        cond = f"{r['metric']} {r['op']} {float(r['value']):g}"
        if r.get("devices"):
            scope = " OR ".join(f"topic(3) = '{d}'" for d in r["devices"])
            cond = f"(({scope}) AND {cond})"
        if cond not in clauses:
            clauses.append(cond)
    where = " OR ".join([BASE_WHERE] + clauses)
    sql = f"{BASE_SQL} WHERE {where}"
    current = iot.get_topic_rule(ruleName=TELEMETRY_RULE)["rule"]
    if current.get("sql", "").strip() != sql:
        payload = {"sql": sql, "description": current.get("description", ""), "actions": current["actions"],
                   "ruleDisabled": current.get("ruleDisabled", False),  # the kill switch may have disabled it
                   "awsIotSqlVersion": current.get("awsIotSqlVersion", "2016-03-23")}
        if current.get("errorAction"):
            payload["errorAction"] = current["errorAction"]
        iot.replace_topic_rule(ruleName=TELEMETRY_RULE, topicRulePayload=payload)
    return {"sql": sql, "userClauses": len(clauses), "disabled": current.get("ruleDisabled", False)}


def install_pack(body):
    pack = str(body.get("pack") or "")[:20]
    devices = sorted(d for d in (body.get("devices") or []) if isinstance(d, str) and DEVICE_ID.match(d))
    if not pack or not devices:
        raise ApiError(400, "choose a pack and at least one device")
    rules = list_rules()
    for r in [r for r in rules if r.get("pack") == pack and sorted(r.get("devices") or []) == devices]:
        PLATFORM.delete_item(Key={"pk": "RULE", "sk": r["ruleId"]})
        rules.remove(r)
    saved = [save_rule({**draft, "pack": pack, "devices": devices}, rules) for draft in (body.get("rules") or [])[:20]]
    return saved


# ================================================================== responders
def hash_secret(s):
    return hashlib.sha256(s.encode()).hexdigest()


def auth(event):
    header = (event.get("headers") or {}).get("authorization", "")
    token = header[7:] if header.lower().startswith("bearer ") else ""
    rid, _, secret = token.partition(".")
    if not rid or not secret:
        raise ApiError(401, "not paired - pair this phone first")
    prof = PLATFORM.get_item(Key={"pk": f"RESP#{rid}", "sk": "PROFILE"}).get("Item")
    if not prof or not hmac.compare_digest(prof.get("tokenHash", ""), hash_secret(secret)):
        raise ApiError(401, "unknown or revoked responder - pair again")
    return plain(prof)


def my_links(rid):
    res = PLATFORM.query(KeyConditionExpression=Key("pk").eq(f"RESP#{rid}") & Key("sk").begins_with("DEV#"))
    return [plain(i) for i in res.get("Items", [])]


def pair_start(body):
    device_id = body.get("deviceId", "")
    if not DEVICE_ID.match(device_id):
        raise ApiError(400, "unknown device")
    for _ in range(5):
        code = f"{secrets.randbelow(1_000_000):06d}"
        try:
            PLATFORM.put_item(
                Item={"pk": f"PAIR#{code}", "sk": "CODE", "deviceId": device_id,
                      "owner": str(body.get("owner") or "")[:30], "profile": str(body.get("profile") or "")[:20],
                      "ownerPhone": re.sub(r"[^\d+]", "", str(body.get("phone") or ""))[:16],
                      "expiresAt": int(time.time()) + 600},
                ConditionExpression="attribute_not_exists(pk)")
            return {"code": code, "expiresAt": (int(time.time()) + 600) * 1000}
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
    raise ApiError(503, "try again")


def pair(event, body):
    code = re.sub(r"\D", "", str(body.get("code") or ""))
    item = PLATFORM.get_item(Key={"pk": f"PAIR#{code}", "sk": "CODE"}).get("Item") if len(code) == 6 else None
    if not item or int(item.get("expiresAt", 0)) < time.time():
        raise ApiError(404, "That code is wrong or has expired. Create a new one on the monitored phone.")
    PLATFORM.delete_item(Key={"pk": f"PAIR#{code}", "sk": "CODE"})  # single use
    name = str(body.get("name") or "").strip()[:30] or "Responder"
    level = 2 if str(body.get("level")) == "2" else 1
    token = None
    try:  # an already-paired phone adds another device to the same identity
        prof = auth(event)
        rid = prof["rid"]
    except ApiError:
        rid, secret = secrets.token_hex(6), secrets.token_urlsafe(24)
        token = f"{rid}.{secret}"
        PLATFORM.put_item(Item={"pk": f"RESP#{rid}", "sk": "PROFILE", "rid": rid, "name": name,
                                "phone": str(body.get("phone") or "")[:20], "tokenHash": hash_secret(secret),
                                "createdAt": now_ms()})
    device_id, owner = item["deviceId"], item.get("owner", "")
    PLATFORM.put_item(Item={"pk": f"DEV#{device_id}", "sk": f"RESP#{rid}", "rid": rid, "name": name, "level": level,
                            "since": now_ms()})
    PLATFORM.put_item(Item={"pk": f"RESP#{rid}", "sk": f"DEV#{device_id}", "deviceId": device_id, "owner": owner,
                            "profile": item.get("profile", ""), "ownerPhone": item.get("ownerPhone", ""),
                            "level": level, "since": now_ms()})
    return {"token": token, "rid": rid, "device": {"deviceId": device_id, "owner": owner}, "level": level}


def recent_alerts(device_ids, limit=40):
    res = ALERTS.query(KeyConditionExpression=Key("pk").eq("ALERT"), ScanIndexForward=False, Limit=200)
    items = [plain({k: v for k, v in i.items() if k not in ("pk", "sk", "expiresAt")})
             for i in res.get("Items", []) if i.get("deviceId") in device_ids]
    return items[:limit]


DEVICE_FIELDS = ("owner", "profile", "online", "lastSeen", "bat", "chg", "stepsDay", "act", "lastMoveAt", "hr", "hrAt",
                 "hrQuality", "lat", "lon", "gacc", "locAt", "health")


def responder_me(prof):
    links = my_links(prof["rid"])
    ids = [l["deviceId"] for l in links]
    devices = []
    if ids:
        got = dynamodb.batch_get_item(RequestItems={DEVICES.name: {"Keys": [{"deviceId": i} for i in ids]}})
        state = {d["deviceId"]: plain(d) for d in got["Responses"].get(DEVICES.name, [])}
        for l in links:
            d = state.get(l["deviceId"], {})
            devices.append({"deviceId": l["deviceId"], "level": l.get("level", 1), "pairedOwner": l.get("owner", ""),
                            "ownerPhone": l.get("ownerPhone", ""),
                            **{k: d.get(k) for k in DEVICE_FIELDS},
                            "activeTypes": sorted((d.get("active") or {}).keys())})
    return {"rid": prof["rid"], "name": prof.get("name"), "push": bool(prof.get("sub")), "devices": devices,
            "alerts": recent_alerts(set(ids)), "serverTime": now_ms()}


def ack(prof, body):
    alert_id = str(body.get("alertId") or "")
    ids = {l["deviceId"] for l in my_links(prof["rid"])}
    alert = next((a for a in recent_alerts(ids, 200) if a.get("alertId") == alert_id), None)
    if not alert:
        raise ApiError(404, "alert not found for your devices")
    return invoke(DISPATCHER, {"mode": "ack", "alert": alert, "alertId": alert_id, "rid": prof["rid"],
                               "name": prof.get("name", "Responder")}, sync=True)


# ================================================================== lab (fall-detector accuracy)
def lab_traces():
    labels = {i["sk"]: i.get("label") for i in
              PLATFORM.query(KeyConditionExpression=Key("pk").eq("TRACE")).get("Items", [])}
    out, token = [], None
    while True:
        kw = {"Bucket": LAKE_BUCKET, "Prefix": "bronze/traces/", "MaxKeys": 1000}
        if token:
            kw["ContinuationToken"] = token
        page = s3.list_objects_v2(**kw)
        for o in page.get("Contents", []):
            # key: bronze/traces/dt=<day>/<id>__<ts>__<traceId>__<peakG>__<detected>__<trigger>.json
            parts = o["Key"].rsplit("/", 1)[-1][:-5].split("__")
            if len(parts) < 6:
                continue
            out.append({"key": o["Key"], "deviceId": parts[0], "ts": int(parts[1]) if parts[1].isdigit() else 0,
                        "traceId": parts[2], "peakG": float(parts[3]) if re.match(r"^[\d.]+$", parts[3]) else None,
                        "detected": parts[4] == "true", "trigger": parts[5], "bytes": o["Size"],
                        "label": labels.get(o["Key"])})
        token = page.get("NextContinuationToken")
        if not token or len(out) > 2000:
            break
    out.sort(key=lambda t: t["ts"], reverse=True)
    return {"traces": out[:300]}


def lab_trace(key):
    if not key.startswith("bronze/traces/") or ".." in key:
        raise ApiError(400, "bad key")
    body = json.loads(s3.get_object(Bucket=LAKE_BUCKET, Key=key)["Body"].read())
    return {"key": key, "samples": body.get("samples", []), "owner": body.get("owner"), "trigger": body.get("trigger")}


# ================================================================== router
def route(path, method, event, body):
    """Returns (status, body) or None if the path is not a platform route."""
    if path == "/rules" and method == "GET":
        return 200, {"rules": list_rules()}
    if path == "/rules" and method == "POST":
        rule = save_rule(body)
        return 200, {"rule": rule, "compiled": compile_rules()}
    if path == "/rules/delete" and method == "POST":
        PLATFORM.delete_item(Key={"pk": "RULE", "sk": str(body.get("ruleId"))})
        return 200, {"deleted": True, "compiled": compile_rules()}
    if path == "/rules/toggle" and method == "POST":
        PLATFORM.update_item(Key={"pk": "RULE", "sk": str(body.get("ruleId"))}, UpdateExpression="SET enabled = :e",
                             ConditionExpression="attribute_exists(pk)", ExpressionAttributeValues={":e": bool(body.get("enabled"))})
        return 200, {"ok": True, "compiled": compile_rules()}
    if path == "/rules/pack" and method == "POST":
        saved = install_pack(body)
        return 200, {"rules": saved, "compiled": compile_rules()}
    if path == "/rules/sql":
        rule = iot.get_topic_rule(ruleName=TELEMETRY_RULE)["rule"]
        return 200, {"sql": rule.get("sql"), "disabled": rule.get("ruleDisabled", False), "ruleName": TELEMETRY_RULE}
    if path == "/rules/compile" and method == "POST":
        return 200, compile_rules()
    if path == "/rules/run" and method == "POST":
        return 200, invoke(RULE_RUNNER, {"ruleId": str(body.get("ruleId")), "force": True}, sync=True)

    if path == "/pair/start" and method == "POST":
        return 200, pair_start(body)
    if path == "/pair" and method == "POST":
        return 200, pair(event, body)
    if path == "/responder/me":
        return 200, responder_me(auth(event))
    if path == "/responder/subscribe" and method == "POST":
        prof = auth(event)
        sub = body.get("subscription") or {}
        if not str(sub.get("endpoint", "")).startswith("https://") or not (sub.get("keys") or {}).get("p256dh"):
            raise ApiError(400, "invalid push subscription")
        PLATFORM.update_item(Key={"pk": f"RESP#{prof['rid']}", "sk": "PROFILE"}, UpdateExpression="SET #s = :s, subAt = :t",
                             ExpressionAttributeNames={"#s": "sub"},
                             ExpressionAttributeValues={":s": {"endpoint": sub["endpoint"], "keys": {
                                 "p256dh": sub["keys"]["p256dh"], "auth": sub["keys"].get("auth", "")}}, ":t": now_ms()})
        return 200, {"ok": True}
    if path == "/responder/test" and method == "POST":
        prof = auth(event)
        return 200, invoke(DISPATCHER, {"mode": "test-push", "rid": prof["rid"]}, sync=True)
    if path == "/responder/unpair" and method == "POST":
        prof = auth(event)
        device_id = str(body.get("deviceId"))
        PLATFORM.delete_item(Key={"pk": f"RESP#{prof['rid']}", "sk": f"DEV#{device_id}"})
        PLATFORM.delete_item(Key={"pk": f"DEV#{device_id}", "sk": f"RESP#{prof['rid']}"})
        return 200, {"ok": True}
    if path == "/ack" and method == "POST":
        return 200, ack(auth(event), body)

    if path == "/zones" and method == "POST":
        device_id = body.get("deviceId", "")
        name = str(body.get("name") or "").strip()[:20]
        try:
            lat, lon, radius = float(body["lat"]), float(body["lon"]), float(body.get("radiusM", 300))
        except (KeyError, TypeError, ValueError):
            raise ApiError(400, "lat, lon and radiusM are required")
        if not DEVICE_ID.match(device_id) or not name or not (-90 <= lat <= 90 and -180 <= lon <= 180 and 20 <= radius <= 20000):
            raise ApiError(400, "invalid zone")
        PLATFORM.put_item(Item=to_ddb({"pk": f"DEV#{device_id}", "sk": f"ZONE#{name}", "deviceId": device_id, "name": name,
                                       "lat": round(lat, 6), "lon": round(lon, 6), "radiusM": radius, "at": now_ms()}))
        return 200, {"ok": True}
    if path == "/zones":
        items = PLATFORM.scan(FilterExpression=Attr("sk").begins_with("ZONE#")).get("Items", [])
        return 200, {"zones": [plain({k: v for k, v in i.items() if k not in ("pk", "sk")}) for i in items]}
    if path == "/responders":
        items = PLATFORM.scan(FilterExpression=Attr("pk").begins_with("DEV#") & Attr("sk").begins_with("RESP#")).get("Items", [])
        links = [plain(i) for i in items]
        push_on = set()
        if links:
            got = dynamodb.batch_get_item(RequestItems={PLATFORM.name: {"Keys": [
                {"pk": f"RESP#{rid}", "sk": "PROFILE"} for rid in {l["rid"] for l in links}]}})
            push_on = {p["rid"] for p in got["Responses"].get(PLATFORM.name, []) if p.get("sub")}
        return 200, {"responders": [{"deviceId": l["pk"][4:], "rid": l["rid"], "name": l.get("name"), "level": l.get("level", 1),
                                     "push": l["rid"] in push_on, "since": l.get("since")} for l in links]}
    if path == "/actions":
        res = PLATFORM.query(KeyConditionExpression=Key("pk").eq("ACTION"), ScanIndexForward=False, Limit=80)
        return 200, {"actions": [plain({k: v for k, v in i.items() if k not in ("pk", "sk", "expiresAt")})
                                 for i in res.get("Items", [])]}
    if path == "/escalations":
        items = PLATFORM.scan(FilterExpression=Attr("pk").begins_with("ESC#")).get("Items", [])
        return 200, {"escalations": [plain({**{k: v for k, v in i.items() if k not in ("token", "sk")}, "alertId": i["pk"][4:]})
                                     for i in items]}
    if path == "/command" and method == "POST":
        device_id = body.get("deviceId", "")
        cmd = body.get("cmd")
        if not DEVICE_ID.match(device_id) or cmd not in ("MESSAGE", "ASK_OK", "ALARM"):
            raise ApiError(400, "invalid command")
        invoke(DISPATCHER, {"mode": "command", "deviceId": device_id, "cmd": cmd, "text": str(body.get("text") or "")[:120],
                            "from": "Mission Control", "timeoutSec": 120})
        return 202, {"sent": True}

    if path == "/lab/traces":
        return 200, lab_traces()
    if path == "/lab/trace":
        return 200, lab_trace(((event.get("queryStringParameters") or {}).get("key")) or "")
    if path == "/lab/label" and method == "POST":
        key, label = str(body.get("key") or ""), body.get("label")
        if not key.startswith("bronze/traces/") or label not in TRACE_LABELS:
            raise ApiError(400, "label must be one of " + ", ".join(TRACE_LABELS))
        PLATFORM.put_item(Item={"pk": "TRACE", "sk": key, "label": label, "at": now_ms()})
        return 200, {"ok": True}
    if path == "/lab/run" and method == "POST":
        return 200, invoke(ACCURACY_LAB, {}, sync=True)
    if path == "/lab/result":
        item = PLATFORM.get_item(Key={"pk": "LAB", "sk": "RESULT"}).get("Item")
        return 200, plain({k: v for k, v in (item or {}).items() if k not in ("pk", "sk")})
    return None
