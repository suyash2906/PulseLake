"""PulseLake lake ETL: Bronze (raw JSON) -> Silver (clean Parquet) -> Gold (Athena views).

Runs entirely on Amazon Athena (serverless SQL):
  1. DROP silver_telemetry + delete its S3 files       (full refresh - data is small)
  2. CTAS: read bronze JSON, de-duplicate, validate, rename/convert types, write Parquet
     partitioned by date into s3://<lake>/silver/telemetry/
  3. CREATE OR REPLACE the Gold views (hourly stats, fleet health, alert summary)
Progress is written to SSM parameter /pulselake/etl-status so the dashboard can show it.
Invoke asynchronously ({"trigger": "dashboard"}) - a run takes ~20-40 s.
"""
import json
import os
import time

import boto3

athena = boto3.client("athena")
s3 = boto3.resource("s3")
ssm = boto3.client("ssm")

WORKGROUP = os.environ["ATHENA_WORKGROUP"]
DATABASE = os.environ["GLUE_DATABASE"]
BUCKET = os.environ["LAKE_BUCKET"]
STATUS_PARAM = os.environ["ETL_STATUS_PARAM"]
SILVER_PREFIX = "silver/telemetry/"

SILVER_CTAS = f"""
CREATE TABLE silver_telemetry
WITH (
  format = 'PARQUET',
  write_compression = 'SNAPPY',
  external_location = 's3://{BUCKET}/{SILVER_PREFIX}',
  partitioned_by = ARRAY['dt']
) AS
SELECT device_id, owner, profile, event_time, event_ts_ms, ingest_latency_ms, seq, rate, health, fault,
       temperature_c, humidity_pct, voltage_v, battery_pct, charging, vibration_rms, vibration_peak,
       noise_dba, noise_max_dba, sensor_source, dt
FROM (
  SELECT
    id                                   AS device_id,
    owner,
    profile,
    from_unixtime(ts / 1000.0)           AS event_time,
    ts                                   AS event_ts_ms,
    ingest_ts - ts                       AS ingest_latency_ms,
    seq,
    coalesce(rate, 1)                    AS rate,
    health,
    fault,
    round(temp, 2)                       AS temperature_c,
    round(hum, 2)                        AS humidity_pct,
    round(volt, 3)                       AS voltage_v,
    bat                                  AS battery_pct,
    chg                                  AS charging,
    vib                                  AS vibration_rms,
    vibpeak                              AS vibration_peak,
    round(noise, 1)                      AS noise_dba,
    round(noisemax, 1)                   AS noise_max_dba,
    sensors                              AS sensor_source,
    dt,
    row_number() OVER (PARTITION BY id, ts ORDER BY ingest_ts) AS rn
  FROM bronze_telemetry
  WHERE id IS NOT NULL AND ts IS NOT NULL
    AND temp BETWEEN -60 AND 150          -- data-quality rules: drop impossible readings
    AND hum BETWEEN 0 AND 100
    AND bat BETWEEN 0 AND 100
)
WHERE rn = 1                              -- de-duplicate (MQTT QoS0 can repeat)
"""

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
}


def set_status(state, **extra):
    body = {"state": state, "at": int(time.time() * 1000), **extra}
    ssm.put_parameter(Name=STATUS_PARAM, Value=json.dumps(body)[:4000], Type="String", Overwrite=True)


def run_sql(sql):
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
    return ex["Statistics"].get("DataScannedInBytes", 0)


def has_new_data_since(ms):
    """Cheap S3 listing of today's + yesterday's bronze partitions (no Athena cost)."""
    newest = 0
    for days_ago in (0, 1):
        day = time.strftime("%Y-%m-%d", time.gmtime(time.time() - days_ago * 86400))
        for obj in s3.Bucket(BUCKET).objects.filter(Prefix=f"bronze/telemetry/dt={day}/"):
            newest = max(newest, int(obj.last_modified.timestamp() * 1000))
    return newest > ms


def handler(event, _context):
    if event.get("trigger") == "schedule":
        try:
            last = json.loads(ssm.get_parameter(Name=STATUS_PARAM)["Parameter"]["Value"])
        except Exception:
            last = {}
        if last.get("state") == "SUCCEEDED" and not has_new_data_since(int(last.get("at", 0))):
            print("scheduled run skipped: no new bronze data")
            return {"skipped": True}
    started = time.time()
    steps = []
    scanned = 0
    try:
        set_status("RUNNING", step="drop silver")
        run_sql("DROP TABLE IF EXISTS silver_telemetry")
        s3.Bucket(BUCKET).objects.filter(Prefix=SILVER_PREFIX).delete()
        steps.append("dropped old silver")

        set_status("RUNNING", step="bronze -> silver (Parquet)")
        scanned += run_sql(SILVER_CTAS)
        rows = sum(1 for _ in s3.Bucket(BUCKET).objects.filter(Prefix=SILVER_PREFIX))
        steps.append(f"silver written ({rows} Parquet files)")

        for name, sql in GOLD_VIEWS.items():
            set_status("RUNNING", step=f"gold view {name}")
            run_sql(sql)
            steps.append(f"view {name}")

        result = {"steps": steps, "seconds": round(time.time() - started, 1), "scannedBytes": scanned,
                  "trigger": event.get("trigger", "manual")}
        set_status("SUCCEEDED", **result)
        print(json.dumps(result))
        return result
    except Exception as e:  # report failure to the dashboard
        set_status("FAILED", error=str(e)[:1000], steps=steps)
        raise
