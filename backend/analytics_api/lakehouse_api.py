"""PulseLake lakehouse API: catalog + lineage, Iceberg snapshots / time travel, speed vs batch layer,
query-performance lab and data export.

  GET  /catalog                       every dataset (Glue Data Catalog) with schema, storage, freshness,
                                      plus a lineage graph derived from the view definitions
  GET  /lakehouse                     Iceberg snapshots, files and partitions of silver_telemetry
  POST /lakehouse/timetravel          {snapshotId} -> the table as of that snapshot vs now
  GET  /speed?deviceId=&minutes=      speed layer: per-minute aggregates from DynamoDB
  GET  /reconcile?deviceId=&minutes=  speed layer vs batch layer (gold_minute_stats) minute by minute
  POST /perf/run                      the same question on raw JSON vs partitions vs Iceberg Parquet
  POST /export                        {name, format: csv|parquet} -> download link for a Gold report
"""
import base64
import json
import math
import os
import re
import time
import uuid

import boto3
from boto3.dynamodb.conditions import Key

glue = boto3.client("glue")
s3 = boto3.client("s3")
athena = boto3.client("athena")
ssm = boto3.client("ssm")
dynamodb = boto3.resource("dynamodb")
DATABASE = os.environ["GLUE_DATABASE"]
WORKGROUP = os.environ["ATHENA_WORKGROUP"]
LAKE_BUCKET = os.environ["LAKE_BUCKET"]
SPEED = dynamodb.Table(os.environ["SPEED_TABLE"]) if os.environ.get("SPEED_TABLE") else None
ETL_STATUS_PARAM = os.environ.get("ETL_STATUS_PARAM", "")
PRICE_PER_TB = 5.0
S3_PRICE_GB_MONTH = 0.025  # S3 Standard, Sydney, first 50 TB
DEVICE_ID = re.compile(r"^(PHONE_0[1-4]|SIM_[A-Z0-9_]{1,20})$")
EXPORTABLE = re.compile(r"^gold_[a-z_]+$")

STORAGE = {  # dataset -> S3 prefix
    "bronze_telemetry": "bronze/telemetry/", "bronze_events": "bronze/events/", "bronze_alerts": "bronze/alerts/",
    "bronze_traces": "bronze/traces/", "bronze_actions": "bronze/actions/",
    "silver_telemetry": "silver/iceberg/telemetry/", "dq_runs": "quality/runs/",
}
SOURCES = {  # who writes each Bronze dataset
    "bronze_telemetry": ["Phones (MQTT)", "Virtual fleet", "History backfill"],
    "bronze_events": ["Phones (MQTT)", "History backfill"],
    "bronze_alerts": ["Alert processor"],
    "bronze_traces": ["Phones (MQTT)"],
    "bronze_actions": ["Action dispatcher"],
    "dq_runs": ["ETL data-quality profiler"],
}
CONSUMERS = {  # who reads what (beyond the dashboard reports)
    "gold_daily_activity": ["Lake rule: less active than usual"],
    "bronze_telemetry": ["Lake rules: noise dose, active minutes", "Time machine"],
    "bronze_events": ["Lake rule: repeated falls"],
    "bronze_traces": ["Accuracy Lab"],
    "gold_minute_stats": ["Speed vs batch reconciliation"],
    "gold_rule_effectiveness": ["Insights: response times"],
}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


# ------------------------------------------------------------------ helpers
def athena_query(sql, timeout=25, workgroup=WORKGROUP):
    started = time.time()
    qid = athena.start_query_execution(QueryString=sql, QueryExecutionContext={"Database": DATABASE},
                                       WorkGroup=workgroup)["QueryExecutionId"]
    while True:
        ex = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        state = ex["Status"]["State"]
        if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            break
        if time.time() - started > timeout:
            athena.stop_query_execution(QueryExecutionId=qid)
            raise ApiError(504, "query timed out")
        time.sleep(0.3)
    stats = ex.get("Statistics", {})
    meta = {"queryId": qid, "ms": int((time.time() - started) * 1000), "engineMs": stats.get("EngineExecutionTimeInMillis", 0),
            "scannedBytes": stats.get("DataScannedInBytes", 0), "state": state,
            "output": ex.get("ResultConfiguration", {}).get("OutputLocation")}
    meta["costUsd"] = round(max(meta["scannedBytes"], 10 * 1024 * 1024) / 1024 ** 4 * PRICE_PER_TB, 8)
    if state != "SUCCEEDED":
        meta["error"] = ex["Status"].get("StateChangeReason", state)
        return [], [], meta
    page = athena.get_query_results(QueryExecutionId=qid, MaxResults=1000)
    rows = page["ResultSet"]["Rows"]
    cols = [c.get("VarCharValue", "") for c in rows[0]["Data"]] if rows else []
    return cols, [[c.get("VarCharValue") for c in r["Data"]] for r in rows[1:]], meta


def as_dicts(cols, rows):
    return [dict(zip(cols, r)) for r in rows]


def prefix_stats(prefix):
    count = size = newest = 0
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=LAKE_BUCKET, Prefix=prefix):
        for o in page.get("Contents", []):
            count += 1
            size += o["Size"]
            newest = max(newest, int(o["LastModified"].timestamp() * 1000))
        if count > 50_000:
            break
    return {"objects": count, "bytes": size, "newest": newest or None}


def etl_status():
    try:
        return json.loads(ssm.get_parameter(Name=ETL_STATUS_PARAM)["Parameter"]["Value"])
    except Exception:
        return {}


def view_sources(table):
    """Tables a view reads, from the Presto/Trino view text stored in the Glue catalog."""
    text = table.get("ViewOriginalText") or ""
    m = re.search(r"/\* Presto View: (.+) \*/", text)
    sql = ""
    if m:
        try:
            sql = json.loads(base64.b64decode(m.group(1)))["originalSql"]
        except Exception:
            sql = ""
    return sorted(set(re.findall(r"\b((?:bronze|silver|gold)_[a-z_]+|dq_runs)\b", sql)) - {table["Name"]})


# ------------------------------------------------------------------ catalog + lineage
def catalog():
    tables, token = [], None
    while True:
        kw = {"DatabaseName": DATABASE}
        if token:
            kw["NextToken"] = token
        page = glue.get_tables(**kw)
        tables += page["TableList"]
        token = page.get("NextToken")
        if not token:
            break
    status = etl_status()
    datasets, edges = [], []
    for t in tables:
        name = t["Name"]
        params = t.get("Parameters") or {}
        kind = "view" if t.get("TableType") == "VIRTUAL_VIEW" else ("iceberg" if params.get("table_type", "").upper() == "ICEBERG" else "table")
        layer = "gold" if name.startswith("gold_") else "silver" if name.startswith("silver_") else "quality" if name == "dq_runs" else "bronze"
        sd = t.get("StorageDescriptor") or {}
        cols = [{"name": c["Name"], "type": c["Type"]} for c in sd.get("Columns", [])]
        cols += [{"name": c["Name"], "type": c["Type"], "partition": True} for c in t.get("PartitionKeys", [])]
        d = {"name": name, "layer": layer, "kind": kind, "columns": cols, "description": t.get("Description", ""),
             "format": "Iceberg / Parquet" if kind == "iceberg" else ("view (SQL)" if kind == "view" else params.get("classification", "json").upper()),
             "partitioning": "day(event_time) - hidden" if kind == "iceberg" else
                             (", ".join(c["Name"] for c in t.get("PartitionKeys", [])) + " (projection)" if t.get("PartitionKeys") else ""),
             "updated": int(t["UpdateTime"].timestamp() * 1000) if t.get("UpdateTime") else None}
        if name in STORAGE:
            d.update(prefix_stats(STORAGE[name]))
        if kind == "view":
            for src in view_sources(t):
                edges.append({"from": src, "to": name})
        datasets.append(d)
    names = {d["name"] for d in datasets}
    for name, srcs in SOURCES.items():
        if name in names:
            edges += [{"from": f"src:{s}", "to": name} for s in srcs]
    if "silver_telemetry" in names:
        edges.append({"from": "bronze_telemetry", "to": "silver_telemetry", "label": "ETL MERGE (incremental)"})
    for name, users in CONSUMERS.items():
        if name in names:
            edges += [{"from": name, "to": f"use:{u}"} for u in users]
    total = sum(d.get("bytes", 0) for d in datasets)
    bronze = sum(d.get("bytes", 0) for d in datasets if d["layer"] == "bronze" and d["name"] == "bronze_telemetry")
    silver = next((d.get("bytes", 0) for d in datasets if d["name"] == "silver_telemetry"), 0)
    return {
        "datasets": sorted(datasets, key=lambda d: ("bronze silver quality gold".split().index(d["layer"]), d["name"])),
        "edges": edges,
        "storage": {"bytes": total, "monthlyUsd": round(total / 1024 ** 3 * S3_PRICE_GB_MONTH, 4),
                    "compression": round(bronze / silver, 1) if silver else None},
        "etl": {k: status.get(k) for k in ("state", "at", "mode", "watermark", "rowsMerged", "dq", "snapshot", "seconds")},
        "serverTime": int(time.time() * 1000),
    }


# ------------------------------------------------------------------ Iceberg snapshots + time travel
def lakehouse():
    cols, rows, _ = athena_query('SELECT snapshot_id, committed_at, operation, summary FROM "silver_telemetry$snapshots" '
                                 "ORDER BY committed_at DESC LIMIT 25")
    snaps = []
    for r in as_dicts(cols, rows):
        summary = r.get("summary") or ""
        get = lambda k: (re.search(rf"\b{k}=(\d+)", summary) or [None, None])[1]  # noqa: E731
        snaps.append({"snapshotId": r["snapshot_id"], "committedAt": r["committed_at"], "operation": r["operation"],
                      "addedRecords": get("added-records"), "totalRecords": get("total-records"),
                      "addedFiles": get("added-data-files"), "totalFiles": get("total-data-files")})
    cols, rows, _ = athena_query('SELECT count(*) AS files, sum(record_count) AS records, sum(file_size_in_bytes) AS bytes '
                                 'FROM "silver_telemetry$files"')
    files = as_dicts(cols, rows)[0] if rows else {}
    cols, rows, _ = athena_query('SELECT partition, record_count, file_count FROM "silver_telemetry$partitions" '
                                 "ORDER BY partition DESC LIMIT 20")
    return {"snapshots": snaps, "files": files, "partitions": as_dicts(cols, rows), "etl": etl_status()}


def time_travel(snapshot_id):
    if not re.match(r"^\d{5,25}$", str(snapshot_id)):
        raise ApiError(400, "snapshotId must be a number")
    q = ("SELECT count(*) AS records, count(DISTINCT device_id) AS devices, max(event_time) AS newest_event "
         "FROM silver_telemetry{}")
    c1, r1, m1 = athena_query(q.format(f" FOR VERSION AS OF {snapshot_id}"))
    c2, r2, m2 = athena_query(q.format(""))
    if m1.get("error") or m2.get("error"):
        raise ApiError(500, m1.get("error") or m2.get("error"))
    return {"then": as_dicts(c1, r1)[0], "now": as_dicts(c2, r2)[0],
            "sql": q.format(f" FOR VERSION AS OF {snapshot_id}"), "ms": m1["ms"] + m2["ms"]}


# ------------------------------------------------------------------ speed layer vs batch layer
def speed_rows(device_id, minutes):
    if not SPEED:
        return []
    since = (int(time.time() * 1000) - minutes * 60_000) // 60000 * 60000
    res = SPEED.query(KeyConditionExpression=Key("deviceId").eq(device_id) & Key("minute").gte(since))
    out = []
    for i in res.get("Items", []):
        n_temp, n_noise = int(i.get("nTemp", 0)), int(i.get("nNoise", 0))
        out.append({"minute": int(i["minute"]), "msgs": int(i.get("n", 0)),
                    "avgTemp": round(float(i["sumTemp"]) / n_temp, 2) if n_temp else None,
                    "noiseLeq": round(10 * math.log10(float(i["noisePow"]) / n_noise), 1) if n_noise and float(i["noisePow"]) > 0 else None,
                    "maxVib": float(i["maxVib"]) if i.get("maxVib") is not None else None,
                    "steps": int(i.get("steps", 0)), "minBat": float(i["minBat"]) if i.get("minBat") is not None else None})
    return sorted(out, key=lambda r: r["minute"])


def reconcile(device_id, minutes):
    speed = speed_rows(device_id, minutes)
    cols, rows, meta = athena_query(f"""
SELECT CAST(to_unixtime(minute_utc) * 1000 AS bigint) AS minute, msgs, avg_temp_c, noise_leq_dba, max_vibration, steps
FROM gold_minute_stats
WHERE device_id = '{device_id}' AND minute_utc >= localtimestamp - interval '{int(minutes)}' minute
ORDER BY 1""")
    if meta.get("error"):
        raise ApiError(500, meta["error"] + " - run the ETL first")
    batch = {int(r["minute"]): r for r in as_dicts(cols, rows)}
    wm = int(etl_status().get("watermark") or 0)
    pairs, both, equal = [], 0, 0
    for s in speed:
        b = batch.get(s["minute"])
        covered = s["minute"] + 60000 <= wm  # the batch layer has processed this minute
        if b:
            both += 1
            equal += int(int(b["msgs"]) == s["msgs"])
        pairs.append({"minute": s["minute"], "speedMsgs": s["msgs"], "batchMsgs": int(b["msgs"]) if b else None,
                      "speedTemp": s["avgTemp"], "batchTemp": float(b["avg_temp_c"]) if b and b["avg_temp_c"] else None,
                      "covered": covered})
    return {"deviceId": device_id, "pairs": pairs, "minutesCompared": both, "minutesEqual": equal,
            "speedMsgs": sum(p["speedMsgs"] for p in pairs if p["batchMsgs"] is not None),
            "batchMsgs": sum(p["batchMsgs"] or 0 for p in pairs), "batchWatermark": wm, "queryMs": meta["ms"]}


# ------------------------------------------------------------------ query performance lab
def perf_lab():
    since_ms = int(time.time() * 1000) - 86400_000
    day = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 86400))
    variants = [
        ("Bronze JSON · scan everything", "row-oriented JSON, no partition filter",
         f"SELECT id, count(*) AS msgs, round(avg(temp), 2) AS avg_temp FROM bronze_telemetry WHERE ts > {since_ms} GROUP BY id"),
        ("Bronze JSON · partition pruning", "WHERE dt >= yesterday: Athena skips older folders",
         f"SELECT id, count(*) AS msgs, round(avg(temp), 2) AS avg_temp FROM bronze_telemetry "
         f"WHERE dt >= '{day}' AND ts > {since_ms} GROUP BY id"),
        ("Silver Iceberg · columnar Parquet", "reads only the 2 columns it needs",
         f"SELECT device_id, count(*) AS msgs, round(avg(temperature_c), 2) AS avg_temp FROM silver_telemetry "
         f"WHERE event_ts_ms > {since_ms} GROUP BY device_id"),
        ("Silver Iceberg · columns + partition pruning", "hidden day(event_time) partitions + column pruning",
         "SELECT device_id, count(*) AS msgs, round(avg(temperature_c), 2) AS avg_temp FROM silver_telemetry "
         "WHERE event_time > localtimestamp - interval '1' day GROUP BY device_id"),
    ]
    out = []
    for label, why, sql in variants:
        cols, rows, meta = athena_query(sql)
        out.append({"label": label, "why": why, "sql": sql, "rows": len(rows), "ms": meta["ms"],
                    "engineMs": meta["engineMs"], "scannedBytes": meta["scannedBytes"], "costUsd": meta["costUsd"],
                    "error": meta.get("error")})
    return {"variants": out, "note": "Same question every time: messages and average temperature per device, last 24 h."}


# ------------------------------------------------------------------ export
def export(name, fmt):
    if not EXPORTABLE.match(name or ""):
        raise ApiError(400, "only Gold views can be exported")
    if fmt == "parquet":
        folder = f"exports/{name}-{uuid.uuid4().hex[:8]}/"
        _, _, meta = athena_query(f"UNLOAD (SELECT * FROM {name}) TO 's3://{LAKE_BUCKET}/{folder}' "
                                  "WITH (format = 'PARQUET', compression = 'SNAPPY')")
        if meta.get("error"):
            raise ApiError(500, meta["error"])
        files = s3.list_objects_v2(Bucket=LAKE_BUCKET, Prefix=folder).get("Contents", [])
        links = [{"file": f"{name}-{i + 1}.parquet", "bytes": o["Size"],
                  "url": s3.generate_presigned_url("get_object", Params={
                      "Bucket": LAKE_BUCKET, "Key": o["Key"],
                      "ResponseContentDisposition": f'attachment; filename="{name}-{i + 1}.parquet"'}, ExpiresIn=900)}
                 for i, o in enumerate(files)]
        return {"format": "parquet", "files": links, "scannedBytes": meta["scannedBytes"], "ms": meta["ms"]}
    _, rows, meta = athena_query(f"SELECT * FROM {name} LIMIT 100000")
    if meta.get("error"):
        raise ApiError(500, meta["error"])
    bucket, key = meta["output"].replace("s3://", "").split("/", 1)
    url = s3.generate_presigned_url("get_object", Params={
        "Bucket": bucket, "Key": key, "ResponseContentDisposition": f'attachment; filename="{name}.csv"'}, ExpiresIn=900)
    return {"format": "csv", "files": [{"file": f"{name}.csv", "rows": len(rows), "url": url}],
            "scannedBytes": meta["scannedBytes"], "ms": meta["ms"]}


# ------------------------------------------------------------------ router
def route(path, method, event, body):
    q = event.get("queryStringParameters") or {}
    if path == "/catalog":
        return 200, catalog()
    if path == "/lakehouse":
        return 200, lakehouse()
    if path == "/lakehouse/timetravel" and method == "POST":
        return 200, time_travel(body.get("snapshotId"))
    if path in ("/speed", "/reconcile"):
        device_id = q.get("deviceId", "")
        if not DEVICE_ID.match(device_id):
            raise ApiError(400, "deviceId required")
        minutes = max(5, min(240, int(q.get("minutes") or 60)))
        return 200, ({"deviceId": device_id, "rows": speed_rows(device_id, minutes)} if path == "/speed"
                     else reconcile(device_id, minutes))
    if path == "/perf/run" and method == "POST":
        return 200, perf_lab()
    if path == "/export" and method == "POST":
        return 200, export(body.get("name"), body.get("format", "csv"))
    return None
