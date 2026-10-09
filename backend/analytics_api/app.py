"""PulseLake analytics API (Lambda Function URL).

GET  /fleet            current device registry/state (DynamoDB)
GET  /alerts           recent alerts (DynamoDB)
GET  /queries          list of preset analytics queries
GET  /query/<name>     run a preset Athena SQL query on the data lake (schema-on-read)
POST /sql              Query Lab: one read-only SELECT (max 200 rows)
GET  /lake             object count / size per data-lake layer (S3)
POST /etl/run          start the Bronze -> Silver -> Gold ETL (async Lambda)
GET  /etl/status       last ETL run
GET  /sessions         past phone sessions found in the lake (for the time machine)
GET  /replay?start=&end=  raw telemetry + events + alerts of a window (max 15 min) to replay
POST /simulate         start the virtual-fleet load test (max 200 devices x 120 s)
GET  /simulate/status  progress of the load test
GET  /cost             real usage from AWS Budgets + remaining credits

Safety: this role can only READ the lake (it has no Glue create/delete rights and may only
write Athena results), Query Lab accepts a single SELECT/WITH statement, and the Athena
workgroup caps every query at 100 MB scanned - so this public endpoint cannot run up a bill.
"""
import base64
import json
import os
import re
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

athena = boto3.client("athena")
s3 = boto3.client("s3")
lambda_client = boto3.client("lambda")
ssm = boto3.client("ssm")
dynamodb = boto3.resource("dynamodb")
DEVICES = dynamodb.Table(os.environ["DEVICES_TABLE"])
ALERTS = dynamodb.Table(os.environ["ALERTS_TABLE"])
WORKGROUP = os.environ["ATHENA_WORKGROUP"]
DATABASE = os.environ["GLUE_DATABASE"]
LAKE_BUCKET = os.environ["LAKE_BUCKET"]
PRICE_PER_TB = 5.0  # Athena USD per TB scanned (10 MB minimum per query)

SINCE = "dt >= date_format(current_date - interval '1' day, '%Y-%m-%d')"
PHONES = "id NOT LIKE 'SIM\\_%' ESCAPE '\\'"  # exclude the virtual load-test fleet

QUERIES = {
    "fleet_summary": {
        "title": "Fleet summary (last 24 h)",
        "layer": "bronze",
        "sql": f"""
SELECT id AS device, max(owner) AS owner, count(*) AS messages,
       round(avg(temp), 1) AS avg_temp_c, max(temp) AS max_temp_c,
       round(max(vibpeak), 1) AS max_vibration, min(bat) AS min_battery,
       sum(CASE WHEN fault <> 'NONE' THEN 1 ELSE 0 END) AS faulty_msgs,
       date_format(from_unixtime(max(ts) / 1000), '%H:%i:%s') AS last_seen_utc
FROM bronze_telemetry
WHERE {SINCE} AND {PHONES}
GROUP BY id
ORDER BY id""",
    },
    "scale_test_summary": {
        "title": "Virtual fleet load tests (last 24 h)",
        "layer": "bronze",
        "sql": f"""
SELECT date_format(date_trunc('minute', from_unixtime(ts / 1000)), '%H:%i') AS minute_utc,
       count(DISTINCT id) AS virtual_devices, count(*) AS messages,
       round(count(*) / 60.0, 1) AS msgs_per_sec,
       sum(CASE WHEN health <> 'OK' THEN 1 ELSE 0 END) AS unhealthy_msgs,
       round(avg(ingest_ts - ts)) AS avg_ingest_ms
FROM bronze_telemetry
WHERE {SINCE} AND id LIKE 'SIM\\_%' ESCAPE '\\'
GROUP BY 1
ORDER BY 1""",
    },
    "alerts_by_device": {
        "title": "Alerts raised per device and type (last 24 h)",
        "layer": "bronze",
        "sql": f"""
SELECT deviceid AS device, type, severity, count(*) AS alerts
FROM bronze_alerts
WHERE status = 'ACTIVE' AND {SINCE} AND deviceid NOT LIKE 'SIM\\_%' ESCAPE '\\'
GROUP BY deviceid, type, severity
ORDER BY alerts DESC, device""",
    },
    "temperature_per_minute": {
        "title": "Average temperature per minute (last 2 h)",
        "layer": "bronze",
        "sql": f"""
SELECT date_format(from_unixtime(ts / 1000), '%H:%i') AS minute_utc, id AS device,
       round(avg(temp), 1) AS avg_temp_c, round(max(vibpeak), 1) AS max_vibration
FROM bronze_telemetry
WHERE {SINCE} AND {PHONES} AND ts > to_unixtime(current_timestamp - interval '2' hour) * 1000
GROUP BY 1, 2
ORDER BY 1, 2""",
    },
    "fault_timeline": {
        "title": "Injected faults timeline (last 24 h)",
        "layer": "bronze",
        "sql": f"""
SELECT date_format(from_unixtime(ts / 1000), '%H:%i:%s') AS time_utc, id AS device, owner, type, fault
FROM bronze_events
WHERE type IN ('FAULT_INJECTED', 'FAULT_CLEARED') AND {SINCE}
ORDER BY ts DESC
LIMIT 50""",
    },
    "gold_fleet_health": {
        "title": "Gold · fleet health report",
        "layer": "gold",
        "sql": "SELECT * FROM gold_fleet_health ORDER BY device_id",
    },
    "gold_device_hourly": {
        "title": "Gold · hourly stats per device",
        "layer": "gold",
        "sql": "SELECT * FROM gold_device_hourly ORDER BY hour_utc DESC, device_id LIMIT 100",
    },
    "gold_alert_summary": {
        "title": "Gold · alert summary",
        "layer": "gold",
        "sql": "SELECT * FROM gold_alert_summary ORDER BY times_raised DESC",
    },
}

ETL_FUNCTION = os.environ.get("ETL_FUNCTION", "")
ETL_STATUS_PARAM = os.environ.get("ETL_STATUS_PARAM", "")
SIM_FUNCTION = os.environ.get("SIM_FUNCTION", "")
SIM_STATUS_PARAM = os.environ.get("SIM_STATUS_PARAM", "")
PHASE_PARAM = os.environ.get("PHASE_PARAM", "")
BUDGET_NAME = "pulselake-total-cap"
FORBIDDEN = re.compile(r"\b(insert|update|delete|drop|create|alter|unload|msck|grant|revoke|call)\b", re.I)


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=lambda d: int(d) if isinstance(d, Decimal) and d == int(d) else float(d)),
    }


def run_query(name, sql=None):
    q = QUERIES[name] if name in QUERIES else {"title": "Query Lab", "layer": "custom", "sql": sql}
    started = time.time()
    qid = athena.start_query_execution(
        QueryString=q["sql"],
        QueryExecutionContext={"Database": DATABASE},
        WorkGroup=WORKGROUP,
    )["QueryExecutionId"]
    while True:
        ex = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        state = ex["Status"]["State"]
        if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            break
        if time.time() - started > 25:
            athena.stop_query_execution(QueryExecutionId=qid)
            return respond(504, {"error": "query timed out"})
        time.sleep(0.4)
    if state != "SUCCEEDED":
        return respond(500, {"error": ex["Status"].get("StateChangeReason", state), "sql": q["sql"]})

    page = athena.get_query_results(QueryExecutionId=qid, MaxResults=200)
    rows = page["ResultSet"]["Rows"]
    columns = [c.get("VarCharValue", "") for c in rows[0]["Data"]] if rows else []
    data = [[c.get("VarCharValue") for c in r["Data"]] for r in rows[1:]]
    scanned = ex["Statistics"].get("DataScannedInBytes", 0)
    billed = max(scanned, 10 * 1024 * 1024)
    return respond(200, {
        "name": name,
        "title": q["title"],
        "layer": q["layer"],
        "sql": q["sql"].strip(),
        "columns": columns,
        "rows": data,
        "stats": {
            "queryId": qid,
            "engineMs": ex["Statistics"].get("EngineExecutionTimeInMillis", 0),
            "totalMs": int((time.time() - started) * 1000),
            "scannedBytes": scanned,
            "costUsd": round(billed / 1024**4 * PRICE_PER_TB, 8),
        },
    })


def lake_stats():
    layers = {"bronze/telemetry/": "Bronze · telemetry (JSON)", "bronze/events/": "Bronze · device events (JSON)",
              "bronze/alerts/": "Bronze · alerts (JSON)", "silver/": "Silver · curated (Parquet)",
              "athena-results/": "Athena query results"}
    out = []
    for prefix, label in layers.items():
        count = size = 0
        newest = None
        token = None
        while True:
            kw = {"Bucket": LAKE_BUCKET, "Prefix": prefix, "MaxKeys": 1000}
            if token:
                kw["ContinuationToken"] = token
            page = s3.list_objects_v2(**kw)
            for o in page.get("Contents", []):
                count += 1
                size += o["Size"]
                if newest is None or o["LastModified"] > newest[0]:
                    newest = (o["LastModified"], o["Key"])
            token = page.get("NextContinuationToken")
            if not token or count > 20000:
                break
        out.append({"prefix": prefix, "label": label, "objects": count, "bytes": size,
                    "newestKey": newest[1] if newest else None,
                    "newestAt": newest[0].isoformat() if newest else None})
    return respond(200, {"bucket": LAKE_BUCKET, "layers": out})


def athena_rows(sql, max_rows=20000, timeout=25):
    """Run SQL and return (columns, rows) with pagination."""
    started = time.time()
    qid = athena.start_query_execution(
        QueryString=sql, QueryExecutionContext={"Database": DATABASE}, WorkGroup=WORKGROUP
    )["QueryExecutionId"]
    while True:
        ex = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        state = ex["Status"]["State"]
        if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            break
        if time.time() - started > timeout:
            athena.stop_query_execution(QueryExecutionId=qid)
            raise TimeoutError("query timed out")
        time.sleep(0.3)
    if state != "SUCCEEDED":
        raise RuntimeError(ex["Status"].get("StateChangeReason", state))
    columns, rows, token = None, [], None
    while True:
        kw = {"QueryExecutionId": qid, "MaxResults": 1000}
        if token:
            kw["NextToken"] = token
        page = athena.get_query_results(**kw)
        data = page["ResultSet"]["Rows"]
        if columns is None:
            columns = [c.get("VarCharValue", "") for c in data[0]["Data"]] if data else []
            data = data[1:]
        rows.extend([c.get("VarCharValue") for c in r["Data"]] for r in data)
        token = page.get("NextToken")
        if not token or len(rows) >= max_rows:
            break
    return columns or [], rows


def _num(v, cast=float):
    try:
        return cast(v)
    except (TypeError, ValueError):
        return None


def _arr(v):
    try:
        return json.loads(v) if v else []
    except ValueError:
        return []


# ----------------------------------------------------------------- time machine
def sessions():
    """Group minutes that contain phone telemetry into 'sessions' (gaps > 3 min split them)."""
    _, rows = athena_rows(f"""
SELECT to_unixtime(date_trunc('minute', from_unixtime(ts / 1000))) * 1000 AS minute_ms,
       count(*) AS messages, count(DISTINCT id) AS devices,
       array_join(array_agg(DISTINCT owner), ',') AS owners
FROM bronze_telemetry
WHERE dt >= date_format(current_date - interval '7' day, '%Y-%m-%d') AND {PHONES}
GROUP BY 1
ORDER BY 1""", max_rows=10000)
    out = []
    for minute_ms, messages, devices, owners in rows:
        m = int(float(minute_ms))
        if out and m - out[-1]["end"] <= 3 * 60_000:
            s = out[-1]
            s["end"] = m + 60_000
            s["messages"] += int(messages)
            s["devices"] = max(s["devices"], int(devices))
            s["owners"] = sorted(set(s["owners"]) | set(filter(None, (owners or "").split(","))))
        else:
            out.append({"start": m, "end": m + 60_000, "messages": int(messages), "devices": int(devices),
                        "owners": sorted(filter(None, (owners or "").split(",")))})
    return respond(200, {"sessions": list(reversed(out))[:30]})


def replay(start, end):
    """Everything the lake knows about one time window, ready to be replayed by the dashboard."""
    if end <= start or end - start > 15 * 60_000:
        return respond(400, {"error": "window must be 1 ms - 15 min"})
    d1 = time.strftime("%Y-%m-%d", time.gmtime(start / 1000))
    d2 = time.strftime("%Y-%m-%d", time.gmtime(end / 1000))
    window = f"dt BETWEEN '{d1}' AND '{d2}' AND ts BETWEEN {start} AND {end}"
    started = time.time()
    cols, rows = athena_rows(f"""
SELECT id, owner, profile, seq, ts, rate, health, fault, temp, hum, volt, bat, chg, vib, vibpeak, acc, ori, sensors
FROM bronze_telemetry WHERE {window} AND {PHONES} ORDER BY ts LIMIT 20000""")
    keep_ori = len(rows) <= 8000  # keep the response well under Lambda's 6 MB limit
    telemetry = []
    for r in rows:
        rec = dict(zip(cols, r))
        telemetry.append({
            "v": 1, "id": rec["id"], "owner": rec["owner"], "profile": rec["profile"],
            "seq": _num(rec["seq"], int), "ts": _num(rec["ts"], int), "rate": _num(rec["rate"]) or 1,
            "health": rec["health"], "fault": rec["fault"], "temp": _num(rec["temp"]), "hum": _num(rec["hum"]),
            "volt": _num(rec["volt"]), "bat": _num(rec["bat"], int), "chg": rec["chg"] == "true",
            "vib": _num(rec["vib"]), "vibPeak": _num(rec["vibpeak"]), "acc": _arr(rec["acc"]),
            "ori": _arr(rec["ori"]) if keep_ori else [], "sensors": rec["sensors"],
        })
    _, ev_rows = athena_rows(f"""
SELECT id, owner, profile, ts, type, fault, health FROM bronze_events
WHERE dt BETWEEN '{d1}' AND '{d2}' AND ts BETWEEN {start} AND {end} ORDER BY ts""")
    events = [{"v": 1, "id": a, "owner": b, "profile": c, "ts": _num(d, int), "type": e, "fault": f, "health": g}
              for a, b, c, d, e, f, g in ev_rows]
    # a RESOLVED record keeps the original ts; replay it at the moment it was resolved
    _, al_rows = athena_rows(f"""
SELECT alertid, deviceid, owner, ts, type, severity, status, message, source,
       coalesce(resolvedat, ts) AS at
FROM bronze_alerts
WHERE dt BETWEEN '{d1}' AND '{d2}' AND coalesce(resolvedat, ts) BETWEEN {start} AND {end}
  AND deviceid NOT LIKE 'SIM\\_%' ESCAPE '\\' ORDER BY 10""")
    alerts = [{"alertId": a, "deviceId": b, "owner": c, "ts": _num(d, int), "type": e, "severity": f,
               "status": g, "message": h, "source": i, "at": _num(j, int)}
              for a, b, c, d, e, f, g, h, i, j in al_rows]
    return respond(200, {"start": start, "end": end, "telemetry": telemetry, "events": events, "alerts": alerts,
                         "queryMs": int((time.time() - started) * 1000), "orientationIncluded": keep_ori})


# ----------------------------------------------------------------- virtual fleet (load test)
SIM_MAX_RUNS_PER_DAY = 10


def simulate_status():
    try:
        return json.loads(ssm.get_parameter(Name=SIM_STATUS_PARAM)["Parameter"]["Value"])
    except Exception:
        return {"state": "NEVER_RUN"}


def simulate(body):
    status = simulate_status()
    now = int(time.time() * 1000)
    if status.get("state") == "RUNNING" and now - int(status.get("at", 0)) < 30_000:
        return respond(409, {"error": "a load test is already running", "status": status})
    today = time.strftime("%Y-%m-%d", time.gmtime())
    runs_today = int(status.get("runsToday", 0)) if status.get("day") == today else 0
    if runs_today >= SIM_MAX_RUNS_PER_DAY:
        return respond(429, {"error": f"daily limit of {SIM_MAX_RUNS_PER_DAY} load tests reached (cost safety)"})
    devices = max(1, min(200, int(body.get("devices", 100))))
    seconds = max(10, min(120, int(body.get("seconds", 60))))
    queued = {"state": "STARTING", "at": now, "devices": devices, "seconds": seconds,
              "day": today, "runsToday": runs_today + 1}
    ssm.put_parameter(Name=SIM_STATUS_PARAM, Value=json.dumps(queued), Type="String", Overwrite=True)
    lambda_client.invoke(FunctionName=SIM_FUNCTION, InvocationType="Event",
                         Payload=json.dumps({"devices": devices, "seconds": seconds,
                                             "day": today, "runsToday": runs_today + 1}).encode())
    return respond(202, queued)


# ----------------------------------------------------------------- credits meter
def cost():
    account = boto3.client("sts").get_caller_identity()["Account"]
    out = {"capUsd": 25.0}
    try:
        b = boto3.client("budgets").describe_budget(AccountId=account, BudgetName=BUDGET_NAME)["Budget"]
        out["usedUsd"] = float(b["CalculatedSpend"]["ActualSpend"]["Amount"])
        forecast = b["CalculatedSpend"].get("ForecastedSpend")
        if forecast:
            out["forecastUsd"] = float(forecast["Amount"])
        out["budgetUpdated"] = b.get("LastUpdatedTime").isoformat() if b.get("LastUpdatedTime") else None
    except Exception as e:
        out["budgetError"] = str(e)[:200]
    try:
        plan = boto3.client("freetier", region_name="us-east-1").get_account_plan_state()
        out["plan"] = plan.get("accountPlanType")
        out["creditsLeftUsd"] = float(plan.get("accountPlanRemainingCredits", {}).get("amount", 0))
    except Exception as e:
        out["planError"] = str(e)[:200]
    try:
        out["phase"] = ssm.get_parameter(Name=PHASE_PARAM)["Parameter"]["Value"]
    except Exception:
        out["phase"] = "testing"
    out["phaseCapUsd"] = 22.0 if out["phase"] == "demo" else 9.0
    return respond(200, out)


def read_body(event):
    body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    try:
        return json.loads(body)
    except ValueError:
        return {}


def query_lab(sql: str):
    sql = sql.strip().rstrip(";").strip()
    if not sql or len(sql) > 4000:
        return respond(400, {"error": "Write one SELECT query (max 4000 characters)."})
    if ";" in sql or not re.match(r"^(select|with)\b", sql, re.I) or FORBIDDEN.search(sql):
        return respond(400, {"error": "Query Lab is read-only: a single SELECT / WITH statement only."})
    if not re.search(r"\blimit\s+\d+\s*$", sql, re.I):
        sql = f"{sql}\nLIMIT 200"
    return run_query("__lab__", sql)


def handler(event, _context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    if method == "OPTIONS":
        return respond(200, {})
    path = event.get("rawPath", "/").rstrip("/") or "/"

    if path == "/fleet":
        return respond(200, {"devices": DEVICES.scan().get("Items", [])})
    if path == "/alerts":
        res = ALERTS.query(KeyConditionExpression=Key("pk").eq("ALERT"), ScanIndexForward=False, Limit=50)
        items = [{k: v for k, v in i.items() if k not in ("pk", "sk", "expiresAt")} for i in res.get("Items", [])]
        return respond(200, {"alerts": items})
    if path == "/queries":
        return respond(200, {"queries": [{"name": k, "title": v["title"], "layer": v["layer"]} for k, v in QUERIES.items()]})
    if path.startswith("/query/"):
        name = path.split("/", 2)[2]
        if name not in QUERIES:
            return respond(404, {"error": f"unknown query {name}"})
        return run_query(name)
    if path == "/lake":
        return lake_stats()
    if path == "/sql" and method == "POST":
        return query_lab(read_body(event).get("sql", ""))
    if path == "/etl/run" and method == "POST":
        lambda_client.invoke(FunctionName=ETL_FUNCTION, InvocationType="Event",
                             Payload=json.dumps({"trigger": "dashboard"}).encode())
        return respond(202, {"started": True})
    if path == "/etl/status":
        value = ssm.get_parameter(Name=ETL_STATUS_PARAM)["Parameter"]["Value"]
        return respond(200, json.loads(value))
    if path == "/sessions":
        return sessions()
    if path == "/replay":
        q = event.get("queryStringParameters") or {}
        start, end = _num(q.get("start"), int), _num(q.get("end"), int)
        if start is None or end is None:
            return respond(400, {"error": "start and end (epoch ms) are required"})
        return replay(start, end)
    if path == "/simulate" and method == "POST":
        return simulate(read_body(event))
    if path == "/simulate/status":
        return respond(200, simulate_status())
    if path == "/cost":
        return cost()
    return respond(404, {"error": "not found",
                         "routes": ["/fleet", "/alerts", "/queries", "/query/<name>", "/sql", "/lake", "/etl/run",
                                    "/etl/status", "/sessions", "/replay", "/simulate", "/simulate/status", "/cost"]})
