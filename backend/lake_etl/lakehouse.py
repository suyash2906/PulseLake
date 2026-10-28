"""Silver layer as an Apache Iceberg table (lakehouse) + data-quality scoring.

Why Iceberg instead of plain Parquet files:
  - INCREMENTAL loads: each run MERGEs only newly ingested Bronze rows (no full rebuild)
  - ACID + de-duplication: MERGE ... WHEN NOT MATCHED inserts each (device, timestamp) once
  - TIME TRAVEL: every load is a snapshot - SELECT ... FOR VERSION AS OF <snapshot>
  - SCHEMA EVOLUTION: new sensor fields become columns with ALTER TABLE ADD COLUMNS
  - COMPACTION: OPTIMIZE ... REWRITE DATA USING BIN_PACK merges small files
All of it runs on Amazon Athena (engine v3) with the AWS Glue Data Catalog - no new service.
"""

# (column, Iceberg type, expression over bronze_telemetry)
SILVER_COLUMNS = [
    ("device_id", "string", "id"),
    ("owner", "string", "owner"),
    ("profile", "string", "profile"),
    ("event_time", "timestamp", "CAST(from_unixtime(ts / 1000.0) AS timestamp(6))"),
    ("event_ts_ms", "bigint", "ts"),
    ("ingest_ts_ms", "bigint", "ingest_ts"),
    ("ingest_latency_ms", "bigint", "ingest_ts - ts"),
    ("seq", "bigint", "seq"),
    ("rate", "double", "coalesce(rate, 1)"),
    ("health", "string", "health"),
    ("fault", "string", "fault"),
    ("temperature_c", "double", "round(temp, 2)"),
    ("humidity_pct", "double", "round(hum, 2)"),
    ("voltage_v", "double", "round(volt, 3)"),
    ("battery_pct", "int", "bat"),
    ("charging", "boolean", "chg"),
    ("vibration_rms", "double", "vib"),
    ("vibration_peak", "double", "vibpeak"),
    ("noise_dba", "double", "round(noise, 1)"),
    ("noise_max_dba", "double", "round(noisemax, 1)"),
    ("steps", "int", "coalesce(steps, 0)"),
    ("steps_day", "int", "stepsday"),
    ("activity", "string", "act"),
    ("still_sec", "double", "stillsec"),
    ("lat", "double", "lat"),
    ("lon", "double", "lon"),
    ("gps_accuracy_m", "double", "gacc"),
    ("background", "boolean", "coalesce(bg, false)"),
    ("motion_paused", "boolean", "coalesce(mp, false)"),
    ("ext", "map<string,double>", "ext"),
    ("sensor_source", "string", "sensors"),
    ("dt", "string", "dt"),
]

# Schema evolution: sensors that arrive in the generic `ext` map are promoted to real columns
# the first time the ETL sees them (column, type, expression, ext key).
PROMOTED = [
    ("net_rtt_ms", "double", "element_at(ext, 'rtt')", "rtt"),
    ("net_downlink_mbps", "double", "element_at(ext, 'dl')", "dl"),
]

VALID = "temp BETWEEN -60 AND 150 AND hum BETWEEN 0 AND 100 AND bat BETWEEN 0 AND 100"


def create_sql(location):
    cols = ",\n  ".join(f"`{c}` {t}" for c, t, _ in SILVER_COLUMNS)
    return f"""
CREATE TABLE silver_telemetry (
  {cols}
)
PARTITIONED BY (day(event_time))
LOCATION '{location}'
TBLPROPERTIES ('table_type' = 'ICEBERG', 'format' = 'parquet', 'write_compression' = 'snappy')"""


def merge_sql(window, extra_columns):
    """Insert every new, valid, de-duplicated Bronze row exactly once (idempotent)."""
    cols = SILVER_COLUMNS + [(c, t, e) for c, t, e, _ in PROMOTED if c in extra_columns]
    select = ",\n      ".join(f"{e} AS {c}" for c, _, e in cols)
    names = ", ".join(c for c, _, _ in cols)
    values = ", ".join(f"s.{c}" for c, _, _ in cols)
    return f"""
MERGE INTO silver_telemetry t
USING (
  SELECT
      {select}
  FROM (
    SELECT b.*, row_number() OVER (PARTITION BY id, ts ORDER BY ingest_ts) AS rn
    FROM bronze_telemetry b
    WHERE {window} AND id IS NOT NULL AND ts IS NOT NULL AND {VALID}
  )
  WHERE rn = 1
) s
ON t.device_id = s.device_id AND t.event_ts_ms = s.event_ts_ms
WHEN NOT MATCHED THEN INSERT ({names}) VALUES ({values})"""


def quality_sql(window):
    """Data-quality profile of the newly ingested rows, per device."""
    return f"""
SELECT id AS device_id, max(owner) AS owner, count(*) AS received,
       count(*) - count(DISTINCT ts) AS duplicates,
       count_if(ts IS NULL OR temp IS NULL OR NOT ({VALID})) AS invalid,
       count_if(coalesce(sensors, '') <> 'synthetic' AND ingest_ts - ts > 60000) AS late,
       count_if(ts - ingest_ts > 60000) AS clock_ahead,
       count_if(owner IS NULL OR profile IS NULL OR health IS NULL) AS missing_fields,
       count_if(element_at(ext, 'rtt') IS NOT NULL) AS with_rtt,
       round(avg(CASE WHEN coalesce(sensors, '') <> 'synthetic' THEN ingest_ts - ts END)) AS avg_latency_ms
FROM bronze_telemetry
WHERE {window} AND id IS NOT NULL
GROUP BY id"""


# Gold views that need the v4 lakehouse tables
LAKEHOUSE_VIEWS = {
    # data quality per day and device, from the ETL's own profiling runs
    "gold_data_quality": """
CREATE OR REPLACE VIEW gold_data_quality AS
SELECT dt AS day_utc, device_id, max(owner) AS owner,
       sum(received) AS received, sum(duplicates) AS duplicates, sum(invalid) AS invalid,
       sum(late) AS late_over_60s, sum(clock_ahead) AS clock_ahead, sum(missing_fields) AS missing_fields,
       round(avg(avg_latency_ms)) AS avg_latency_ms,
       round(100.0 * (sum(received) - sum(duplicates) - sum(invalid)) / nullif(sum(received), 0), 2) AS quality_pct
FROM dq_runs
GROUP BY dt, device_id""",
    # batch layer of the Lambda architecture: per-minute stats, compared with the speed layer
    "gold_minute_stats": """
CREATE OR REPLACE VIEW gold_minute_stats AS
SELECT device_id,
       date_trunc('minute', event_time)                              AS minute_utc,
       count(*)                                                      AS msgs,
       round(avg(temperature_c), 2)                                  AS avg_temp_c,
       round(10 * log10(avg(power(10, noise_dba / 10))), 1)          AS noise_leq_dba,
       max(vibration_peak)                                           AS max_vibration,
       sum(steps)                                                    AS steps
FROM silver_telemetry
WHERE sensor_source <> 'synthetic'
GROUP BY device_id, date_trunc('minute', event_time)""",
    # statistical anomaly detection on history: hours that are > 3 standard deviations away
    # from that device's own normal (z-score) - no AI service, just SQL
    "gold_anomalies": """
CREATE OR REPLACE VIEW gold_anomalies AS
WITH hourly AS (
  SELECT device_id, max(owner) AS owner, date_trunc('hour', event_time) AS hour_utc,
         avg(temperature_c) AS temp, 10 * log10(avg(power(10, noise_dba / 10))) AS noise,
         max(vibration_peak) AS vib
  FROM silver_telemetry
  WHERE sensor_source <> 'synthetic'
  GROUP BY device_id, date_trunc('hour', event_time)
),
stats AS (
  SELECT device_id, count(*) AS hours,
         avg(temp) AS m_temp, stddev_samp(temp) AS s_temp,
         avg(noise) AS m_noise, stddev_samp(noise) AS s_noise,
         avg(vib) AS m_vib, stddev_samp(vib) AS s_vib
  FROM hourly GROUP BY device_id
)
SELECT h.device_id, h.owner, h.hour_utc, u.metric,
       round(u.value, 2) AS value, round(u.mean, 2) AS normal_mean, round(u.sd, 2) AS normal_sd,
       round((u.value - u.mean) / u.sd, 2) AS z_score
FROM hourly h
JOIN stats s ON h.device_id = s.device_id
CROSS JOIN UNNEST(
  ARRAY['temperature_c', 'noise_dba', 'vibration_peak'],
  ARRAY[h.temp, h.noise, h.vib],
  ARRAY[s.m_temp, s.m_noise, s.m_vib],
  ARRAY[s.s_temp, s.s_noise, s.s_vib]
) AS u(metric, value, mean, sd)
WHERE s.hours >= 4 AND u.sd > 0 AND u.value IS NOT NULL AND abs((u.value - u.mean) / u.sd) >= 3""",
}
