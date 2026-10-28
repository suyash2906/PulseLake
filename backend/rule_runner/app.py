"""PulseLake rule runner (Lambda, every minute via EventBridge Scheduler).

Evaluates the rules that a single message cannot trigger:
  absence - something did NOT happen: no movement for N minutes, no data (monitoring lost),
            battery low and not charging. Reads the latest device state from DynamoDB.
            "askOk" rules first send "Are you OK?" to the phone and only alert if nobody answers.
  lake    - questions about history, answered by Amazon Athena over the S3 data lake on a
            schedule: activity below the person's own 14-day baseline, daily noise dose,
            repeated falls. The data lake is not just storage - it drives actions.

Results go to the alert processor ({"kind": "rule_hit" | "rule_clear"}), which owns the alert
life-cycle and hands actions to the dispatcher. Only CHANGES are sent (cheap and quiet).

Direct invocation {"ruleId": "...", "force": true} runs one lake rule now (dashboard "Run now").
"""
import json
import os
import time

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
DEVICES = dynamodb.Table(os.environ["DEVICES_TABLE"])
PLATFORM = dynamodb.Table(os.environ["PLATFORM_TABLE"])
ALERT_FUNCTION = os.environ["ALERT_FUNCTION"]
DISPATCHER = os.environ["DISPATCHER_FUNCTION"]
WORKGROUP = os.environ["ATHENA_WORKGROUP"]
DATABASE = os.environ["GLUE_DATABASE"]
TZ_OFFSET_MIN = 330  # IST
ASK_TIMEOUT_MS = 5 * 60_000  # how long the person has to answer "Are you OK?"
ONLINE_MS = 90_000  # a device that reported in the last 90 s is "online"

athena = boto3.client("athena")
lambda_client = boto3.client("lambda")
s3 = boto3.client("s3")
LAKE_BUCKET = os.environ.get("LAKE_BUCKET", "")
LAKE_STALE_MS = 5 * 60_000  # phones streaming but no new Bronze file for 5 min = pipeline problem
PLATFORM_DEVICE = "DATA_LAKE"


def now_ms():
    return int(time.time() * 1000)


def plain(obj):
    return json.loads(json.dumps(obj, default=lambda d: int(d) if d == int(d) else float(d)))


def local_minutes(ts_ms):
    return int((ts_ms / 60000 + TZ_OFFSET_MIN) % 1440)


def in_window(rule, ts_ms):
    w = rule.get("window")
    if not w:
        return True
    m = local_minutes(ts_ms)

    def mins(hhmm):
        h, mm = (hhmm or "0:0").split(":")
        return int(h) * 60 + int(mm)

    a, b = mins(w.get("from")), mins(w.get("to"))
    return a <= m < b if a <= b else (m >= a or m < b)


def in_scope(rule, device_id):
    devices = rule.get("devices") or []
    return device_id in devices if devices else not device_id.startswith("SIM_")


def send(kind, device_id, rule, message=""):
    lambda_client.invoke(FunctionName=ALERT_FUNCTION, InvocationType="Event", Payload=json.dumps(
        {"kind": kind, "deviceId": device_id, "ruleId": rule["ruleId"], "message": message}).encode())


def ask_ok(device, rule):
    lambda_client.invoke(FunctionName=DISPATCHER, InvocationType="Event", Payload=json.dumps({
        "mode": "command", "deviceId": device["deviceId"], "cmd": "ASK_OK", "ruleId": rule["ruleId"],
        "ruleName": rule.get("name"), "timeoutSec": ASK_TIMEOUT_MS // 1000, "from": "PulseLake",
        "text": "Are you OK?"}).encode())
    DEVICES.update_item(Key={"deviceId": device["deviceId"]}, UpdateExpression="SET asks = if_not_exists(asks, :e)",
                        ExpressionAttributeValues={":e": {}})
    DEVICES.update_item(Key={"deviceId": device["deviceId"]}, UpdateExpression="SET asks.#r = :t",
                        ExpressionAttributeNames={"#r": rule["ruleId"]}, ExpressionAttributeValues={":t": now_ms()})


def clear_ask(device, rule):
    if rule["ruleId"] in (device.get("asks") or {}):
        DEVICES.update_item(Key={"deviceId": device["deviceId"]}, UpdateExpression="REMOVE asks.#r",
                            ExpressionAttributeNames={"#r": rule["ruleId"]})


def fmt_minutes(ms):
    m = ms / 60000
    return f"{m:.0f} min" if m < 120 else f"{m / 60:.1f} h"


# ----------------------------------------------------------------- absence rules
def absence(rule, device, now):
    """Returns (condition, message)."""
    owner = device.get("owner") or device["deviceId"]
    last_seen = int(device.get("lastSeen", 0))
    online = now - last_seen < ONLINE_MS
    kind = rule.get("absence")
    n = float(rule.get("minutes") or 0)
    if kind == "no_movement":
        if not online:
            return False, ""  # no data at all is the "offline" rule's job
        if device.get("motionPaused"):
            return False, ""  # phone app in the background: movement is unknown, not absent
        still_ms = now - int(device.get("lastMoveAt") or now)
        return still_ms >= n * 60000, f"No movement from {owner} for {fmt_minutes(still_ms)}"
    if kind == "offline":
        if not last_seen or now - last_seen > 24 * 3600_000:
            return False, ""  # never used / long retired slot
        gap = now - last_seen
        why = "the app was closed" if int(device.get("goodbyeAt", 0)) >= last_seen - 15000 else "the connection was lost"
        return gap >= n * 60000, f"Monitoring stopped: no data from {owner}'s phone for {fmt_minutes(gap)} ({why})"
    if kind == "battery":
        bat = int(device.get("bat", 100))
        return online and bat < n and not device.get("chg"), f"{owner}'s phone battery is at {bat}% and not charging"
    return False, ""


def run_absence(rules, devices, now):
    changes = 0
    for rule in rules:
        for device in devices:
            if not in_scope(rule, device["deviceId"]):
                continue
            active = device.get("active") or {}
            is_open = rule["code"] in active
            cond, message = absence(rule, device, now)
            cond = cond and in_window(rule, now)
            if cond and rule.get("absence") == "no_movement" and (rule.get("actions") or {}).get("askOk"):
                asked = (device.get("asks") or {}).get(rule["ruleId"])
                if not asked:
                    ask_ok(device, rule)  # give the person a chance first
                    changes += 1
                    continue
                if now - int(asked) < ASK_TIMEOUT_MS:
                    continue
                message += " and no answer to 'Are you OK?'"
            if cond and not is_open:
                send("rule_hit", device["deviceId"], rule, message)
                changes += 1
            elif not cond:
                clear_ask(device, rule)
                if is_open:
                    send("rule_clear", device["deviceId"], rule, "back to normal")
                    changes += 1
    return changes


# ----------------------------------------------------------------- lake rules (Athena)
def lake_sql(rule, now):
    """SQL template -> rows (device_id, value, detail...). UTC dates (partitions are UTC)."""
    today = time.strftime("%Y-%m-%d", time.gmtime(now / 1000))
    d7 = time.strftime("%Y-%m-%d", time.gmtime(now / 1000 - 7 * 86400))
    p = float(rule.get("param") or 0)
    # waking day 07:00-21:00 local: compare with the part of the baseline expected by now
    frac = min(1.0, max(0.05, (local_minutes(now) - 7 * 60) / (14 * 60)))
    t = rule.get("template")
    if t == "steps_below_baseline":
        return f"""
WITH today AS (
  SELECT id AS device_id, max(owner) AS owner, sum(coalesce(steps, 0)) AS steps
  FROM bronze_telemetry WHERE dt = '{today}' AND sensors <> 'synthetic' GROUP BY id),
base AS (
  SELECT device_id, avg(steps) AS avg_steps, count(*) AS days
  FROM gold_daily_activity
  WHERE day_utc < date '{today}' AND day_utc >= date '{today}' - interval '14' day
  GROUP BY device_id)
SELECT t.device_id, t.owner, t.steps, round(b.avg_steps) AS baseline_day,
       round(b.avg_steps * {frac:.3f}) AS expected_by_now, b.days AS baseline_days
FROM today t JOIN base b ON t.device_id = b.device_id
WHERE b.days >= 3 AND t.steps < b.avg_steps * {frac:.3f} * {p / 100:.3f}"""
    if t == "active_minutes_low":
        return f"""
SELECT id AS device_id, max(owner) AS owner,
       round(sum(CASE WHEN act IN ('walk', 'active') THEN 1.0 / coalesce(rate, 1) ELSE 0 END) / 60, 1) AS active_min,
       round({p * frac:.1f}) AS expected_by_now
FROM bronze_telemetry WHERE dt = '{today}' AND sensors <> 'synthetic'
GROUP BY id
HAVING sum(CASE WHEN act IN ('walk', 'active') THEN 1.0 / coalesce(rate, 1) ELSE 0 END) / 60 < {p * frac:.1f}"""
    if t == "noise_dose":
        return f"""
SELECT id AS device_id, max(owner) AS owner,
       round(100 * sum(CASE WHEN noise >= 80 THEN (1.0 / coalesce(rate, 1)) / (28800 / power(2, (noise - 85) / 3))
                            ELSE 0 END), 1) AS dose_pct,
       round(10 * log10(avg(power(10, noise / 10))), 1) AS leq_dba
FROM bronze_telemetry WHERE dt = '{today}' AND noise IS NOT NULL
GROUP BY id
HAVING 100 * sum(CASE WHEN noise >= 80 THEN (1.0 / coalesce(rate, 1)) / (28800 / power(2, (noise - 85) / 3))
                      ELSE 0 END) > {p}"""
    if t == "falls_week":
        return f"""
SELECT id AS device_id, max(owner) AS owner, count(*) AS falls,
       date_format(from_unixtime(max(ts) / 1000), '%Y-%m-%d %H:%i') AS last_fall_utc
FROM bronze_events WHERE dt >= '{d7}' AND type = 'FALL_DETECTED'
GROUP BY id HAVING count(*) >= {int(p)}"""
    raise ValueError(f"unknown lake template {t}")


def lake_message(rule, row):
    t = rule.get("template")
    who = row.get("owner") or row["device_id"]
    if t == "steps_below_baseline":
        return (f"{who} has walked {row['steps']} steps today. By now they usually have about "
                f"{row['expected_by_now']} (their {row['baseline_days']}-day average is {row['baseline_day']} a day) - "
                f"less active than usual")
    if t == "active_minutes_low":
        return f"{who} has been active for only {row['active_min']} min today (expected about {row['expected_by_now']} by now)"
    if t == "noise_dose":
        return f"{who}: today's noise dose is {row['dose_pct']}% of the NIOSH daily limit (average {row['leq_dba']} dB(A))"
    if t == "falls_week":
        return f"{who} has fallen {row['falls']} times in the last 7 days (last {row['last_fall_utc']} UTC) - fall-risk trend"
    return rule["name"]


def athena_rows(sql, timeout=40):
    started = time.time()
    qid = athena.start_query_execution(QueryString=sql, QueryExecutionContext={"Database": DATABASE},
                                       WorkGroup=WORKGROUP)["QueryExecutionId"]
    while True:
        ex = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        state = ex["Status"]["State"]
        if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            break
        if time.time() - started > timeout:
            athena.stop_query_execution(QueryExecutionId=qid)
            raise TimeoutError("lake rule query timed out")
        time.sleep(0.4)
    if state != "SUCCEEDED":
        raise RuntimeError(ex["Status"].get("StateChangeReason", state))
    rows = athena.get_query_results(QueryExecutionId=qid, MaxResults=500)["ResultSet"]["Rows"]
    cols = [c.get("VarCharValue", "") for c in rows[0]["Data"]] if rows else []
    data = [dict(zip(cols, [c.get("VarCharValue") for c in r["Data"]])) for r in rows[1:]]
    return cols, data, ex["Statistics"].get("DataScannedInBytes", 0), int((time.time() - started) * 1000)


def run_lake_rule(rule, devices_by_id, now, force=False):
    if not force and not in_window(rule, now):
        return {"skipped": "outside its time window"}
    sql = lake_sql(rule, now)
    cols, rows, scanned, ms = athena_rows(sql)
    hits = {}
    for row in rows:
        if in_scope(rule, row["device_id"]):
            hits[row["device_id"]] = lake_message(rule, row)
    for device_id, message in hits.items():
        device = devices_by_id.get(device_id, {"deviceId": device_id})
        if rule["code"] not in (device.get("active") or {}):
            send("rule_hit", device_id, rule, message)
    for device_id, device in devices_by_id.items():
        if device_id not in hits and rule["code"] in (device.get("active") or {}):
            send("rule_clear", device_id, rule, "back to normal in the latest lake check")
    PLATFORM.update_item(Key={"pk": "RULE", "sk": rule["ruleId"]}, UpdateExpression="SET lastRunAt = :t, lastRun = :r",
                         ConditionExpression="attribute_exists(pk)",
                         ExpressionAttributeValues={":t": now, ":r": {"rows": len(rows), "hits": len(hits),
                                                                       "ms": ms, "scannedBytes": int(scanned)}})
    return {"sql": sql.strip(), "columns": cols, "rows": [[r.get(c) for c in cols] for r in rows],
            "hits": len(hits), "ms": ms, "scannedBytes": scanned}


# ----------------------------------------------------------------- data freshness (platform health)
def newest_bronze_ms(now):
    newest = 0
    for hours_ago in (0, 1):
        t = time.gmtime(now / 1000 - hours_ago * 3600)
        prefix = f"bronze/telemetry/dt={time.strftime('%Y-%m-%d', t)}/hr={time.strftime('%H', t)}/"
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=LAKE_BUCKET, Prefix=prefix):
            for o in page.get("Contents", []):
                newest = max(newest, int(o["LastModified"].timestamp() * 1000))
    return newest


def lake_freshness(devices, by_id, now):
    """Data observability: if phones are streaming, Bronze must keep receiving files."""
    streaming = [d for d in devices if not str(d["deviceId"]).startswith(("SIM_", PLATFORM_DEVICE))
                 and now - int(d.get("lastSeen", 0)) < ONLINE_MS]
    is_open = "LAKE_STALE" in ((by_id.get(PLATFORM_DEVICE) or {}).get("active") or {})
    if not LAKE_BUCKET or (not streaming and not is_open):
        return None
    newest = newest_bronze_ms(now)
    stale = bool(streaming) and now - newest > LAKE_STALE_MS
    if stale != is_open:
        age = "never" if not newest else fmt_minutes(now - newest) + " ago"
        lambda_client.invoke(FunctionName=ALERT_FUNCTION, InvocationType="Event", Payload=json.dumps({
            "kind": "system_check", "deviceId": PLATFORM_DEVICE, "type": "LAKE_STALE", "ok": not stale,
            "severity": "WARNING",
            "message": (f"Data lake is stale: {len(streaming)} device(s) streaming but the newest Bronze file is {age}"
                        if stale else f"Bronze is receiving data again (newest file {age})")}).encode())
    return {"newestBronzeAgeSec": round((now - newest) / 1000) if newest else None, "stale": stale}


# ----------------------------------------------------------------- entry point
def handler(event, _context):
    now = now_ms()
    rules = [plain(r) for r in PLATFORM.query(KeyConditionExpression=Key("pk").eq("RULE")).get("Items", [])]
    devices = [plain(d) for d in DEVICES.scan().get("Items", [])]
    by_id = {d["deviceId"]: d for d in devices}

    if event.get("ruleId"):  # "Run now" from the dashboard
        rule = next((r for r in rules if r["ruleId"] == event["ruleId"]), None)
        if not rule or rule.get("kind") != "lake":
            return {"error": "not a lake rule"}
        try:
            return run_lake_rule(rule, by_id, now, force=True)
        except Exception as e:  # report to the dashboard
            return {"error": str(e)[:500]}

    enabled = [r for r in rules if r.get("enabled")]
    changes = run_absence([r for r in enabled if r.get("kind") == "absence"],
                          [d for d in devices if d.get("lastSeen")], now)
    lake_runs = []
    for rule in (r for r in enabled if r.get("kind") == "lake"):
        every = float(rule.get("everyMin") or 60) * 60000
        if now - int(rule.get("lastRunAt") or 0) < every:
            continue
        try:
            res = run_lake_rule(rule, by_id, now)
            lake_runs.append({"rule": rule["name"], **{k: v for k, v in res.items() if k in ("hits", "ms", "skipped")}})
        except Exception as e:
            print(f"lake rule {rule['name']} failed: {e}")
            try:  # do not retry every minute
                PLATFORM.update_item(Key={"pk": "RULE", "sk": rule["ruleId"]}, UpdateExpression="SET lastRunAt = :t, lastRun = :r",
                                     ExpressionAttributeValues={":t": now, ":r": {"error": str(e)[:300]}})
            except ClientError:
                pass
    try:
        freshness = lake_freshness(devices, by_id, now)
    except Exception as e:
        freshness = {"error": str(e)[:200]}
    out = {"absenceChanges": changes, "lakeRuns": lake_runs}
    if freshness and freshness.get("stale"):
        out["freshness"] = freshness
    if changes or lake_runs:
        print(json.dumps(out))
    return out
