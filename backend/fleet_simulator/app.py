"""PulseLake virtual fleet - a scalability / elasticity test.

Publishes telemetry for N virtual devices (SIM_001..SIM_N) once per second for S seconds
through the SAME pipeline the phones use (IoT Core -> Rules -> SQS -> S3 lake, alert
Lambda, dashboard). Nothing is pre-provisioned: IoT Core, Lambda, SQS and DynamoDB scale
on their own - that is the point of the demo.

Hard limits (cost safety): max 200 devices, max 120 s per run. Each run costs ~$0.08.
Progress is written to SSM /pulselake/sim-status for the dashboard.

Second mode, {"mode": "backfill", "deviceId": "PHONE_01", "owner": "Grandma", "profile": "elderly"}:
writes N past days of SYNTHETIC history (one summary per minute, sensors = "synthetic") straight
into the Bronze layer, so baseline rules ("less active than usual") have a personal history to
compare today's REAL data with. It never goes through IoT Core (no messaging cost) and is
clearly labelled in every layer of the lake.
"""
import json
import math
import os
import random
import time
from concurrent.futures import ThreadPoolExecutor

import boto3

ssm = boto3.client("ssm")
s3 = boto3.client("s3")
STATUS_PARAM = os.environ["SIM_STATUS_PARAM"]
LAKE_BUCKET = os.environ.get("LAKE_BUCKET", "")
TZ_OFFSET_MIN = 330  # the synthetic person lives in India (IST)
MAX_DEVICES = 200
MAX_SECONDS = 120
PROFILES = [("worker", 32), ("elderly", 26), ("city", 30), ("warehouse", 28)]

_iot_data = None


def iot_data():
    global _iot_data
    if _iot_data is None:
        endpoint = boto3.client("iot").describe_endpoint(endpointType="iot:Data-ATS")["endpointAddress"]
        _iot_data = boto3.client("iot-data", endpoint_url=f"https://{endpoint}",
                                 config=boto3.session.Config(max_pool_connections=64))
    return _iot_data


def set_status(state, **extra):
    body = {"state": state, "at": int(time.time() * 1000), **extra}
    ssm.put_parameter(Name=STATUS_PARAM, Value=json.dumps(body), Type="String", Overwrite=True)


class VirtualDevice:
    def __init__(self, n, seconds):
        self.id = f"SIM_{n:03d}"
        self.profile, self.base = random.choice(PROFILES)
        self.temp = self.base + random.uniform(-2, 2)
        self.bat = random.uniform(40, 100)
        self.seq = 0
        # ~6% of the fleet develops a problem during the run
        self.fault_at = random.uniform(0.2, 0.7) * seconds if random.random() < 0.06 else None
        self.fault = random.choice(["OVERHEAT", "BATTERY_CRITICAL"]) if self.fault_at else "NONE"
        self.phase = random.uniform(0, math.tau)

    def tick(self, t):
        self.seq += 1
        faulty = self.fault_at is not None and t >= self.fault_at
        if faulty and self.fault == "OVERHEAT":
            self.temp = min(98, self.temp + random.uniform(1.5, 3))
        else:
            self.temp += (self.base - self.temp) * 0.2 + random.uniform(-0.3, 0.3)
        bat = 3 if faulty and self.fault == "BATTERY_CRITICAL" else self.bat
        vib = abs(0.3 * math.sin(t / 3 + self.phase)) + random.uniform(0, 0.2)
        health = "OK"
        if self.temp > 70:
            health = "FAILED"
        elif bat < 10:
            health = "WARNING"
        return {
            "v": 1, "id": self.id, "owner": "virtual", "profile": self.profile, "seq": self.seq,
            "ts": int(time.time() * 1000), "rate": 1, "health": health,
            "fault": self.fault if faulty else "NONE",
            "temp": round(self.temp, 1), "hum": round(50 + random.uniform(-3, 3), 1),
            "volt": round(5 + random.uniform(-0.03, 0.03), 2), "bat": round(bat), "chg": False,
            "vib": round(vib, 2), "vibPeak": round(vib * 1.6, 2),
            "acc": [round(random.uniform(-0.05, 0.05), 2), round(random.uniform(-0.05, 0.05), 2), 9.81],
            "ori": [], "noise": round(55 + 10 * abs(math.sin(t / 9 + self.phase)) + random.uniform(-2, 2), 1), "sensors": "simulated",
        }


def synthetic_day(device_id, owner, profile, day_start_ms, rng):
    """One day of minute summaries for a person with a normal routine (local time IST)."""
    worker = profile == "worker"
    wake = 6 * 60 + 30 + rng.randint(-30, 30)
    sleep = 22 * 60 + rng.randint(-30, 30)
    walks = [(7 * 60 + 5, 35)] + ([(18 * 60, 30)] if rng.random() < 0.6 else [])
    if worker:
        walks = [(9 * 60, 8 * 60)]  # on the move for the whole shift
    rows, still_since, bat = [], day_start_ms, 100.0
    for minute in range(1440):
        ts = day_start_ms + minute * 60_000
        local = (minute + TZ_OFFSET_MIN) % 1440
        awake = wake <= local < sleep
        steps = 0
        if awake:
            in_walk = any(start <= local < start + length for start, length in walks)
            if in_walk:
                steps = rng.randint(10, 40) if worker else rng.randint(70, 100)
            elif not (14 * 60 <= local < 15 * 60 + 30) and rng.random() < 0.08:  # chores, not during the nap
                steps = rng.randint(8, 35)
        act = "walk" if steps >= 30 else ("active" if steps > 0 and rng.random() < 0.1 else "still")
        if steps:
            still_since = ts
        charging = not awake
        bat = min(100.0, bat + 0.4) if charging else max(5.0, bat - rng.uniform(0.05, 0.11))
        rows.append({
            "v": 1, "id": device_id, "owner": owner, "profile": profile, "seq": minute, "ts": ts,
            "rate": round(1 / 60, 6), "health": "OK", "fault": "NONE",
            "temp": round(27 + 2 * math.sin((local - 14 * 60) / 1440 * math.tau) + rng.uniform(-0.3, 0.3), 1),
            "hum": round(52 + rng.uniform(-3, 3), 1), "volt": 5.0, "bat": round(bat), "chg": charging,
            "vib": round(0.6 if steps else 0.05, 2), "vibPeak": round(3.5 if steps else 0.2, 2), "acc": [0, 0, 9.81],
            "noise": round((78 if worker and awake and 9 * 60 <= local < 17 * 60 else 48 if awake else 32) + rng.uniform(-4, 4), 1),
            "steps": steps, "act": act, "stillSec": int((ts - still_since) / 1000),
            "sensors": "synthetic", "thing": device_id, "ingest_ts": ts + 200,
        })
    hr = {"v": 1, "id": device_id, "owner": owner, "profile": profile, "type": "HR_CHECK", "fault": "NONE", "health": "OK",
          "ts": day_start_ms + ((9 * 60 - TZ_OFFSET_MIN) % 1440) * 60_000, "bpm": rng.randint(66, 80), "quality": 0.8,
          "ingest_ts": day_start_ms + 1}
    return rows, hr


def backfill(event):
    device_id = event["deviceId"]
    owner, profile = event.get("owner", "Demo"), event.get("profile", "elderly")
    days = max(3, min(14, int(event.get("days", 14))))
    rng = random.Random(f"{device_id}-{owner}")  # same person -> same history every time
    today0 = int(time.time() // 86400) * 86400_000
    written = []
    for d in range(days, 0, -1):
        start = today0 - d * 86400_000
        day = time.strftime("%Y-%m-%d", time.gmtime(start / 1000))
        rows, hr = synthetic_day(device_id, owner, profile, start, rng)
        s3.put_object(Bucket=LAKE_BUCKET, Key=f"bronze/telemetry/dt={day}/hr=00/synthetic-{device_id}.json",
                      Body="\n".join(json.dumps(r) for r in rows).encode(), ContentType="application/json")
        s3.put_object(Bucket=LAKE_BUCKET, Key=f"bronze/events/dt={day}/synthetic-{device_id}.json",
                      Body=json.dumps(hr).encode(), ContentType="application/json")
        written.append({"day": day, "steps": sum(r["steps"] for r in rows)})
    result = {"mode": "backfill", "deviceId": device_id, "owner": owner, "days": written}
    print(json.dumps(result))
    return result


def handler(event, _context):
    if event.get("mode") == "backfill":
        return backfill(event)
    devices = max(1, min(MAX_DEVICES, int(event.get("devices", 50))))
    seconds = max(5, min(MAX_SECONDS, int(event.get("seconds", 60))))
    fleet = [VirtualDevice(i + 1, seconds) for i in range(devices)]
    client = iot_data()
    sent = errors = 0
    started = time.time()
    quota = {"day": event.get("day"), "runsToday": event.get("runsToday", 1)}  # daily limit bookkeeping
    set_status("RUNNING", devices=devices, seconds=seconds, sent=0, startedAt=int(started * 1000), **quota)

    def publish(dev, t):
        msg = dev.tick(t)
        client.publish(topic=f"pulselake/devices/{dev.id}/telemetry", qos=0, payload=json.dumps(msg))

    with ThreadPoolExecutor(max_workers=48) as pool:
        for second in range(seconds):
            tick_start = time.time()
            futures = [pool.submit(publish, d, second) for d in fleet]
            for f in futures:
                try:
                    f.result()
                    sent += 1
                except Exception as e:  # count, keep going
                    errors += 1
                    if errors < 5:
                        print(f"publish error: {e}")
            if second % 10 == 9:
                set_status("RUNNING", devices=devices, seconds=seconds, sent=sent, errors=errors,
                           elapsed=second + 1, startedAt=int(started * 1000), **quota)
            time.sleep(max(0.0, 1.0 - (time.time() - tick_start)))

    result = {"devices": devices, "seconds": seconds, "sent": sent, "errors": errors,
              "faultyDevices": sum(1 for d in fleet if d.fault_at is not None),
              "durationSec": round(time.time() - started, 1), "startedAt": int(started * 1000)}
    set_status("DONE", **result, **quota)
    print(json.dumps(result))
    return result
