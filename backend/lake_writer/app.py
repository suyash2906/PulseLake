"""PulseLake lake writer - our own micro-batching "firehose".

SQS event source mapping invokes this function with up to ~60 s worth of telemetry
(MaximumBatchingWindowInSeconds=60). We write the whole batch as ONE JSON-lines file
into the Bronze layer, partitioned by ingest time (UTC), exactly like Firehose would:
  s3://<lake>/bronze/telemetry/dt=YYYY-MM-DD/hr=HH/<timestamp>-<id>.json
Raw messages are stored unchanged (Bronze = source of truth).
"""
import json
import os
import time
import uuid

import boto3

s3 = boto3.client("s3")
BUCKET = os.environ["LAKE_BUCKET"]
PREFIX = "bronze/telemetry"


def handler(event, _context):
    lines = []
    skipped = 0
    for record in event.get("Records", []):
        body = record.get("body", "").strip()
        try:
            json.loads(body)
            lines.append(body)
        except ValueError:
            skipped += 1
    if not lines:
        return {"written": 0, "skipped": skipped}

    now = time.gmtime()
    key = (
        f"{PREFIX}/dt={time.strftime('%Y-%m-%d', now)}/hr={time.strftime('%H', now)}/"
        f"{time.strftime('%Y%m%dT%H%M%SZ', now)}-{uuid.uuid4().hex[:8]}.json"
    )
    s3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=("\n".join(lines) + "\n").encode("utf-8"),
        ContentType="application/x-ndjson",
    )
    print(json.dumps({"written": len(lines), "skipped": skipped, "key": key}))
    return {"written": len(lines), "skipped": skipped, "key": key}
