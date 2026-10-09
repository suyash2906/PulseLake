"""PulseLake analytics API (Lambda Function URL).

GET  /fleet            current device registry/state (DynamoDB)
GET  /alerts           recent alerts (DynamoDB)
GET  /queries          list of preset analytics queries
GET  /query/<name>     run a preset Athena SQL query on the data lake (schema-on-read)
POST /sql              Query Lab: one read-only SELECT (max 200 rows)
GET  /lake             object count / size per data-lake layer (S3)
POST /etl/run          start the Bronze -> Silver -> Gold ETL (async Lambda)
GET  /etl/status       last ETL run

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
WHERE {SINCE}
GROUP BY id
ORDER BY id""",
    },
    "alerts_by_device": {
        "title": "Alerts raised per device and type (last 24 h)",
        "layer": "bronze",
        "sql": f"""
SELECT deviceid AS device, type, severity, count(*) AS alerts
FROM bronze_alerts
WHERE status = 'ACTIVE' AND {SINCE}
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
WHERE {SINCE} AND ts > to_unixtime(current_timestamp - interval '2' hour) * 1000
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
    return respond(404, {"error": "not found",
                         "routes": ["/fleet", "/alerts", "/queries", "/query/<name>", "/sql", "/lake", "/etl/run", "/etl/status"]})
