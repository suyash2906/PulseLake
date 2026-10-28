"""PulseLake lake ETL: Bronze (raw JSON) -> Silver (Apache Iceberg lakehouse table) -> Gold (views).

Runs entirely on Amazon Athena (serverless SQL) - see lakehouse.py for the Iceberg design.
Modes ({"mode": ...}):
  incremental (default, hourly schedule) - profile data quality of the rows ingested since the last
       run (watermark on ingest time), then MERGE them into Silver. Re-reads a 10-minute overlap so
       files that landed late are not missed; MERGE makes the overlap harmless (idempotent).
  full     - MERGE all of Bronze (used after a history backfill, which writes old partitions)
  optimize - compaction: OPTIMIZE (bin-pack small files) + VACUUM (expire old snapshots)
The first run converts the old Parquet Silver table into an Iceberg table automatically.
Data-quality results go to s3://<lake>/quality/runs/ (table dq_runs -> view gold_data_quality).
Progress is written to SSM /pulselake/etl-status for the dashboard.
"""
import json
import os
import time

import boto3

from lakehouse import LAKEHOUSE_VIEWS, PROMOTED, create_sql, merge_sql, quality_sql

athena = boto3.client("athena")
glue = boto3.client("glue")
s3 = boto3.resource("s3")
ssm = boto3.client("ssm")

WORKGROUP = os.environ["ATHENA_WORKGROUP"]
DATABASE = os.environ["GLUE_DATABASE"]
BUCKET = os.environ["LAKE_BUCKET"]
STATUS_PARAM = os.environ["ETL_STATUS_PARAM"]
OLD_SILVER_PREFIX = "silver/telemetry/"  # v1-v3 plain Parquet table
SILVER_LOCATION = f"s3://{BUCKET}/silver/iceberg/telemetry/"
OVERLAP_MS = 10 * 60_000  # re-read window for late-landing files
COMPACT_HOUR_UTC = 21  # scheduled compaction once a day (02:30 IST)

GOLD_VIEWS = {
    # NIOSH: 85 dB(A) for 8 h = 100 % dose; every +3 dB halves the allowed time (3-dB exchange rate)
    "gold_noise_exposure": """
CREATE OR REPLACE VIEW gold_noise_exposure AS
SELECT device_id,
       date(event_time)                                                      AS day_utc,
       count(noise_dba)                                                      AS samples,
       round(10 * log10(avg(power(10, noise_dba / 10))), 1)                  AS leq_dba,
       max(noise_max_dba)                                                    AS max_dba,
       round(sum(CASE WHEN noise_dba > 85 THEN 1.0 / rate ELSE 0 END) / 60, 1) AS minutes_above_85,
       round(100 * sum(CASE WHEN noise_dba >= 80
                            THEN (1.0 / rate) / (28800 / power(2, (noise_dba - 85) / 3))
                            ELSE 0 END), 3)                                  AS niosh_dose_pct
FROM silver_telemetry
WHERE noise_dba IS NOT NULL
GROUP BY device_id, date(event_time)""",
    "gold_safety_events": """
CREATE OR REPLACE VIEW gold_safety_events AS
SELECT id                                                                      AS device_id,
       max(owner)                                                              AS person,
       sum(CASE WHEN type = 'FALL_DETECTED' THEN 1 ELSE 0 END)                 AS falls_alerted,
       sum(CASE WHEN type = 'FALL_CANCELLED' THEN 1 ELSE 0 END)                AS false_alarms_cancelled,
       sum(CASE WHEN type = 'SOS' THEN 1 ELSE 0 END)                           AS sos_presses,
       round(avg(CASE WHEN type IN ('FALL_DETECTED', 'FALL_CANCELLED') THEN impactg END), 1) AS avg_impact_g,
       max(CASE WHEN type = 'FALL_DETECTED' THEN from_unixtime(ts / 1000.0) END) AS last_fall_utc
FROM bronze_events
WHERE type IN ('FALL_DETECTED', 'FALL_CANCELLED', 'FALL_RESOLVED', 'SOS', 'SOS_CLEARED')
GROUP BY id""",
    "gold_device_hourly": """
CREATE OR REPLACE VIEW gold_device_hourly AS
SELECT device_id,
       date_trunc('hour', event_time)                         AS hour_utc,
       count(*)                                               AS messages,
       round(avg(temperature_c), 2)                           AS avg_temp_c,
       max(temperature_c)                                     AS max_temp_c,
       round(avg(humidity_pct), 1)                            AS avg_humidity_pct,
       round(max(vibration_peak), 2)                          AS max_vibration,
       min(battery_pct)                                       AS min_battery_pct,
       sum(CASE WHEN fault <> 'NONE' THEN 1 ELSE 0 END)       AS faulty_messages,
       round(avg(ingest_latency_ms))                          AS avg_latency_ms
FROM silver_telemetry
GROUP BY device_id, date_trunc('hour', event_time)""",
    "gold_fleet_health": """
CREATE OR REPLACE VIEW gold_fleet_health AS
SELECT device_id,
       max(owner)                                                           AS owner,
       max(profile)                                                         AS profile,
       count(*)                                                             AS total_messages,
       min(event_time)                                                      AS first_seen,
       max(event_time)                                                      AS last_seen,
       round(100.0 * sum(CASE WHEN health = 'OK' THEN 1 ELSE 0 END) / count(*), 1) AS healthy_pct,
       round(avg(temperature_c), 2)                                         AS avg_temp_c,
       round(max(vibration_peak), 2)                                        AS max_vibration,
       round(avg(ingest_latency_ms))                                        AS avg_latency_ms
FROM silver_telemetry
GROUP BY device_id""",
    "gold_alert_summary": """
CREATE OR REPLACE VIEW gold_alert_summary AS
SELECT deviceid AS device_id, type AS alert_type, severity,
       count(*) AS times_raised,
       min(from_unixtime(ts / 1000.0)) AS first_raised,
       max(from_unixtime(ts / 1000.0)) AS last_raised
FROM bronze_alerts
WHERE status = 'ACTIVE'
GROUP BY deviceid, type, severity""",
    # v3: activity per person per day -> personal baseline -> "less active than usual" lake rule
    "gold_daily_activity": """
CREATE OR REPLACE VIEW gold_daily_activity AS
SELECT device_id,
       date(event_time)                                                                   AS day_utc,
       max(owner)                                                                         AS owner,
       sum(steps)                                                                         AS steps,
       round(sum(CASE WHEN activity IN ('walk', 'active') THEN 1.0 / rate ELSE 0 END) / 60, 1) AS active_minutes,
       min(CASE WHEN activity IN ('walk', 'active') THEN event_time END)                  AS first_move_utc,
       max(CASE WHEN activity IN ('walk', 'active') THEN event_time END)                  AS last_move_utc,
       round(max(still_sec) / 60.0, 1)                                                    AS longest_still_min,
       max(sensor_source)                                                                 AS source
FROM silver_telemetry
GROUP BY device_id, date(event_time)""",
    "gold_baseline": """
CREATE OR REPLACE VIEW gold_baseline AS
SELECT device_id, max(owner) AS owner, count(*) AS days,
       round(avg(steps)) AS avg_steps, round(stddev_samp(steps)) AS sd_steps,
       round(avg(active_minutes), 1) AS avg_active_min, round(stddev_samp(active_minutes), 1) AS sd_active_min
FROM gold_daily_activity
WHERE day_utc < current_date AND day_utc >= current_date - interval '14' day
GROUP BY device_id""",
    "gold_heart_rate": """
CREATE OR REPLACE VIEW gold_heart_rate AS
SELECT id AS device_id, max(owner) AS person, date(from_unixtime(ts / 1000.0)) AS day_utc,
       count(*) AS checks, min(bpm) AS min_bpm, round(avg(bpm)) AS avg_bpm, max(bpm) AS max_bpm,
       round(avg(quality), 2) AS avg_quality
FROM bronze_events
WHERE type = 'HR_CHECK' AND bpm IS NOT NULL
GROUP BY id, date(from_unixtime(ts / 1000.0))""",
    # closing the loop: did the actions work? (response time of the people who were alerted)
    "gold_rule_effectiveness": """
CREATE OR REPLACE VIEW gold_rule_effectiveness AS
SELECT alerttype                                                                  AS alert_type,
       max(rulename)                                                              AS rule,
       count(DISTINCT CASE WHEN action = 'notify' THEN alertid END)               AS alerts,
       sum(CASE WHEN action = 'push' AND status = 'sent' THEN 1 ELSE 0 END)       AS pushes_sent,
       sum(CASE WHEN action = 'escalate' AND status = 'sent' THEN 1 ELSE 0 END)   AS escalations,
       sum(CASE WHEN action = 'ack' THEN 1 ELSE 0 END)                            AS acknowledged,
       sum(CASE WHEN action = 'unanswered' THEN 1 ELSE 0 END)                     AS unanswered,
       round(avg(CASE WHEN action = 'ack' THEN ackms END) / 1000.0, 1)            AS avg_ack_sec,
       sum(CASE WHEN action = 'command' THEN 1 ELSE 0 END)                        AS device_commands
FROM bronze_actions
WHERE alerttype IS NOT NULL
GROUP BY alerttype""",
}


def set_status(state, **extra):
    body = {"state": state, "at": int(time.time() * 1000), **extra}
    ssm.put_parameter(Name=STATUS_PARAM, Value=json.dumps(body, default=str)[:4000], Type="String", Overwrite=True)


def run_sql(sql, want_rows=False):
    """Run on Athena; returns (scanned bytes, rows as dicts, update count)."""
    qid = athena.start_query_execution(
        QueryString=sql, QueryExecutionContext={"Database": DATABASE}, WorkGroup=WORKGROUP
    )["QueryExecutionId"]
    while True:
        ex = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        state = ex["Status"]["State"]
        if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            break
        time.sleep(0.5)
    if state != "SUCCEEDED":
        raise RuntimeError(ex["Status"].get("StateChangeReason", state))
    scanned = ex["Statistics"].get("DataScannedInBytes", 0)
    rows, updated = [], None
    if want_rows or ex.get("StatementType") == "DML":
        res = athena.get_query_results(QueryExecutionId=qid, MaxResults=1000)
        updated = res.get("UpdateCount")
        data = res["ResultSet"]["Rows"]
        if want_rows and data:
            cols = [c.get("VarCharValue", "") for c in data[0]["Data"]]
            rows = [dict(zip(cols, [c.get("VarCharValue") for c in r["Data"]])) for r in data[1:]]
    return scanned, rows, updated


def has_new_data_since(ms):
    """Cheap S3 listing of today's + yesterday's bronze partitions (no Athena cost)."""
    newest = 0
    for days_ago in (0, 1):
        day = time.strftime("%Y-%m-%d", time.gmtime(time.time() - days_ago * 86400))
        for obj in s3.Bucket(BUCKET).objects.filter(Prefix=f"bronze/telemetry/dt={day}/"):
            newest = max(newest, int(obj.last_modified.timestamp() * 1000))
    return newest > ms


def silver_columns():
    """None if Silver does not exist yet; otherwise (is_iceberg, column names)."""
    try:
        t = glue.get_table(DatabaseName=DATABASE, Name="silver_telemetry")["Table"]
    except glue.exceptions.EntityNotFoundException:
        return None
    iceberg = (t.get("Parameters") or {}).get("table_type", "").upper() == "ICEBERG"
    return iceberg, {c["Name"] for c in t.get("StorageDescriptor", {}).get("Columns", [])}


def write_quality(rows, mode, now_ms):
    if not rows:
        return None
    out = []
    for r in rows:
        received = int(r["received"] or 0)
        dup, inv = int(r["duplicates"] or 0), int(r["invalid"] or 0)
        out.append({
            "run_at": now_ms, "mode": mode, "device_id": r["device_id"], "owner": r["owner"],
            "received": received, "duplicates": dup, "invalid": inv, "late": int(r["late"] or 0),
            "clock_ahead": int(r["clock_ahead"] or 0), "missing_fields": int(r["missing_fields"] or 0),
            "avg_latency_ms": float(r["avg_latency_ms"]) if r.get("avg_latency_ms") else None,
            "quality_pct": round(100.0 * (received - dup - inv) / received, 2) if received else None,
        })
    day = time.strftime("%Y-%m-%d", time.gmtime(now_ms / 1000))
    s3.Object(BUCKET, f"quality/runs/dt={day}/run-{now_ms}.json").put(
        Body="\n".join(json.dumps(x) for x in out).encode(), ContentType="application/x-ndjson")
    total = sum(x["received"] for x in out)
    bad = sum(x["duplicates"] + x["invalid"] for x in out)
    return {"received": total, "duplicates": sum(x["duplicates"] for x in out),
            "invalid": sum(x["invalid"] for x in out), "late": sum(x["late"] for x in out),
            "qualityPct": round(100.0 * (total - bad) / total, 2) if total else None}


def file_count():
    _, rows, _ = run_sql('SELECT count(*) AS files, sum(file_size_in_bytes) AS bytes FROM "silver_telemetry$files"', True)
    return {"files": int(rows[0]["files"] or 0), "bytes": int(rows[0]["bytes"] or 0)} if rows else {}


def handler(event, _context):
    mode = event.get("mode", "incremental")
    try:
        last = json.loads(ssm.get_parameter(Name=STATUS_PARAM)["Parameter"]["Value"])
    except Exception:
        last = {}
    watermark = int(last.get("watermark", 0))
    if event.get("trigger") == "schedule":
        if time.gmtime().tm_hour == COMPACT_HOUR_UTC and last.get("lastCompactDay") != time.strftime("%Y-%m-%d"):
            mode = "optimize"
        elif last.get("state") == "SUCCEEDED" and not has_new_data_since(int(last.get("at", 0))):
            print("scheduled run skipped: no new bronze data")
            return {"skipped": True}
    started = time.time()
    now_ms = int(started * 1000)
    steps, scanned = [], 0
    keep = {"watermark": watermark, "lastCompactDay": last.get("lastCompactDay")}
    try:
        info = silver_columns()
        if info is None or not info[0]:
            # first run, or migration from the v3 Parquet table: create the Iceberg table, load everything
            set_status("RUNNING", step="creating Iceberg Silver table", mode=mode, **keep)
            run_sql("DROP TABLE IF EXISTS silver_telemetry")
            s3.Bucket(BUCKET).objects.filter(Prefix=OLD_SILVER_PREFIX).delete()
            run_sql(create_sql(SILVER_LOCATION))
            steps.append("created Iceberg table silver_telemetry (partitioned by day)")
            info = silver_columns()
            mode, watermark = "full", 0
        columns = set(info[1])
        result = {"mode": mode}

        if mode == "optimize":
            set_status("RUNNING", step="compaction (OPTIMIZE + VACUUM)", mode=mode, **keep)
            before = file_count()
            scanned += run_sql("OPTIMIZE silver_telemetry REWRITE DATA USING BIN_PACK")[0]
            scanned += run_sql("VACUUM silver_telemetry")[0]
            after = file_count()
            steps.append(f"compacted {before.get('files')} -> {after.get('files')} data files")
            result.update(filesBefore=before.get("files"), filesAfter=after.get("files"))
            keep["lastCompactDay"] = time.strftime("%Y-%m-%d")
        else:
            high = now_ms - 5000  # a little behind "now": rows still in flight are taken next run
            if mode == "full":
                dq_window = merge_window = f"ingest_ts <= {high}"
            else:
                low = max(0, watermark - OVERLAP_MS)
                day = time.strftime("%Y-%m-%d", time.gmtime(max(0, low - 3600_000) / 1000))
                dq_window = f"dt >= '{day}' AND ingest_ts > {watermark} AND ingest_ts <= {high}"
                merge_window = f"dt >= '{day}' AND ingest_ts > {low} AND ingest_ts <= {high}"

            set_status("RUNNING", step="data-quality profiling", mode=mode, **keep)
            sc, dq_rows, _ = run_sql(quality_sql(dq_window), True)
            scanned += sc
            dq = write_quality(dq_rows, mode, now_ms)
            if dq:
                steps.append(f"quality: {dq['received']} rows, {dq['duplicates']} duplicates, {dq['invalid']} invalid, "
                             f"{dq['late']} late -> {dq['qualityPct']}% good")
                result["dq"] = dq

            # schema evolution: a new sensor in the ext map becomes a real column
            if any(int(r.get("with_rtt") or 0) for r in dq_rows):
                missing = [(c, t) for c, t, _, _ in PROMOTED if c not in columns]
                if missing:
                    set_status("RUNNING", step="schema evolution", mode=mode, **keep)
                    run_sql("ALTER TABLE silver_telemetry ADD COLUMNS (" + ", ".join(f"{c} {t}" for c, t in missing) + ")")
                    columns |= {c for c, _ in missing}
                    steps.append("schema evolved: added " + ", ".join(c for c, _ in missing))
                    result["schemaEvolved"] = [c for c, _ in missing]

            set_status("RUNNING", step="MERGE new rows into Iceberg Silver", mode=mode, **keep)
            sc, _, merged = run_sql(merge_sql(merge_window, columns))
            scanned += sc
            steps.append(f"merged {merged if merged is not None else '?'} new rows into silver_telemetry")
            result["rowsMerged"] = merged
            keep["watermark"] = high

        _, snap, _ = run_sql('SELECT snapshot_id, committed_at, operation FROM "silver_telemetry$snapshots" '
                             "ORDER BY committed_at DESC LIMIT 1", True)
        if snap:
            result["snapshot"] = snap[0]

        for name, sql in {**GOLD_VIEWS, **LAKEHOUSE_VIEWS}.items():
            set_status("RUNNING", step=f"gold view {name}", mode=mode, **keep)
            run_sql(sql)
        steps.append(f"{len(GOLD_VIEWS) + len(LAKEHOUSE_VIEWS)} Gold views refreshed")

        result.update(steps=steps, seconds=round(time.time() - started, 1), scannedBytes=scanned,
                      trigger=event.get("trigger", "manual"))
        set_status("SUCCEEDED", **result, **keep)
        print(json.dumps(result, default=str))
        return result
    except Exception as e:  # report failure to the dashboard (watermark unchanged -> retried next run)
        set_status("FAILED", error=str(e)[:1000], steps=steps, mode=mode,
                    watermark=watermark, lastCompactDay=last.get("lastCompactDay"))
        raise
