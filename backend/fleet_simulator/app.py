"""PulseLake virtual fleet - a scalability / elasticity test.

Publishes telemetry for N virtual devices (SIM_001..SIM_N) once per second for S seconds
through the SAME pipeline the phones use (IoT Core -> Rules -> SQS -> S3 lake, alert
Lambda, dashboard). Nothing is pre-provisioned: IoT Core, Lambda, SQS and DynamoDB scale
on their own - that is the point of the demo.

Hard limits (cost safety): max 200 devices, max 120 s per run. Each run costs ~$0.08.
Progress is written to SSM /pulselake/sim-status for the dashboard.
"""
import json
import math
import os
import random
import time
from concurrent.futures import ThreadPoolExecutor

import boto3

ssm = boto3.client("ssm")
STATUS_PARAM = os.environ["SIM_STATUS_PARAM"]
MAX_DEVICES = 200
MAX_SECONDS = 120
PROFILES = [("motor", 48), ("cold", 4), ("truck", 31), ("wearable", 36.6)]

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
            "ori": [], "sensors": "simulated",
        }


def handler(event, _context):
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
