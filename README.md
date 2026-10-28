# PulseLake — Real-Time IoT Analytics on a Cloud Data Lake (AWS)

Cloud Computing mini-project. Smartphones act as **IoT devices**: they stream their real sensors (motion,
steps and activity, sound level, GPS, camera heart rate, battery, plus slider-controlled virtual sensors)
to **AWS IoT Core**. Everything lands in an **S3 data lake** (Bronze / Silver / Gold, queried with
**Amazon Athena**), and a **Rules & Actions engine** acts on the live stream and on the lake's history.
It sends push alerts to the phones of the people responsible, escalates with **AWS Step Functions** when
nobody answers, and sends commands back to the devices.

**Sense → Store → Understand → Act.** The same platform serves several use cases through rule packs:
family care (a parent living alone), lone-worker safety, city noise monitoring and asset tracking.
Everything is serverless, defined as code, and runs on AWS credits with a hard spending cap.

### Version 3: from "showing data" to "acting on data"
| Layer | What is new |
|---|---|
| Sense | Step counter + activity recognition, GPS with privacy levels, camera heart-rate check (PPG), sound "bang" detection, "Are you OK?" prompts sent by the cloud |
| Store | New Bronze datasets (raw motion traces, every action taken) and Gold views for daily activity, a personal 14-day baseline, heart rate and rule effectiveness |
| Understand | No-code **rules**: live thresholds (compiled into the AWS IoT Rule SQL), geofences, absence rules (no movement, no data), **lake rules** (Athena over history, e.g. "less active than usual") |
| Act | **Responder app** (installable PWA, Web Push), **Step Functions escalation** (level 1 → wait for acknowledgement → level 2 + email → UNANSWERED), device commands, action log in the lake |
| Trust | **Accuracy Lab**: labelled recordings, the phones' own fall detector re-run in the cloud over 300 threshold settings, best setting pushed over the air |

## Architecture

```
          4 PHONES (IoT Things PHONE_01..04)           PC "Mission Control" dashboard
              │  MQTT over WebSocket (TLS)                ▲ live MQTT      ▲ REST (Lambda URL)
              │  Cognito guest identity                   │                │
              ▼                                           │                │
        ┌─────────────────────────────────────────────────┴──┐     Analytics API (Lambda)
        │                   AWS IoT Core                      │            │
        │        message broker + Rules Engine (SQL)         │            ▼
        └───┬──────────────┬─────────────────┬───────────────┘   Athena ◄── Glue Data Catalog
            │              │                 │                       │      (schema-on-read)
   abnormal/heartbeat   all telemetry    lifecycle events            │
            ▼              ▼                 ▼                       ▼
      Alert Lambda ◄──── SQS queue      $aws/events/presence ──► S3 DATA LAKE
        │  │   │           │                                    ├─ bronze/  raw JSON (telemetry, events, alerts)
        │  │   └► SNS email│                                    ├─ silver/  cleaned Parquet (ETL)
        │  └► DynamoDB     ▼                                    └─ gold     Athena views (aggregates)
        └► MQTT pulselake/alerts ──► dashboard + S3 alert archive
                      Lake-writer Lambda (1 file / minute)
```

| Layer | AWS service | Why |
|---|---|---|
| Device identity | Amazon Cognito (identity pool, guest role) | Phones get short-lived credentials, no secrets in the app |
| Device registry | AWS IoT Thing Registry | PHONE_01..04 registered as Things |
| Ingestion | AWS IoT Core (MQTT broker) | Standard IoT protocol, millions of devices capable |
| Stream processing | IoT Rules Engine (SQL) | Filters at the edge of the cloud: only abnormal data reaches Lambda |
| Real-time detection | AWS Lambda (Python) | Cloud decides what is a failure, de-duplicates, resolves |
| State | Amazon DynamoDB | Device state + alert history (on-demand, TTL) |
| Notification | Amazon SNS | Email for CRITICAL alerts |
| Buffering | Amazon SQS + Lambda batch writer | Micro-batching: one S3 file per minute instead of thousands |
| Storage | Amazon S3 | The data lake (bronze / silver / gold) |
| Catalog | AWS Glue Data Catalog | Table schemas with partition projection (no crawler cost) |
| Analytics | Amazon Athena | SQL directly on S3, pay per data scanned (capped 100 MB/query) |
| Hosting | Amazon S3 + CloudFront | HTTPS (phone sensors require a secure page) |
| Infrastructure as Code | AWS CloudFormation | Whole system created/deleted with one command |
| Cost safety | AWS Budgets + kill-switch Lambda | Automatic shutdown before the money cap |
| Rules & actions (v3) | DynamoDB single table + rule runner Lambda (EventBridge Scheduler, every minute) | User-defined rules on live data, absence and lake history |
| Escalation (v3) | AWS Step Functions (task-token callback) | Waits for a human acknowledgement, escalates, gives up visibly |
| Notifications (v3) | Web Push (VAPID) from a Node.js Lambda; keys in SSM SecureString | Alerts reach a phone even when the app is closed, at no cost |
| Accuracy (v3) | Node.js Lambda running the phones' own detector code | Measured sensitivity / specificity instead of claims |

### Why this is a *data lake* (not just a bucket)
Raw IoT data is stored unchanged (Bronze), processed copies in an analytics format (Silver, Parquet), and
curated aggregates (Gold, Athena views). Data is partitioned by date/hour, described in a central catalog
(Glue) and queried **schema-on-read** with Athena — storage and compute are separated.

### Use cases (version 2)
- **Fall detection (worker and elderly safety):** a free-fall, impact and stillness model runs on the phone at 60 Hz,
  followed by a 15 s "Are you OK?" countdown. The cloud raises a CRITICAL FALL alert, sends email and stores it in
  the lake. An SOS button is also included.
- **Noise monitoring (smart city / factory):** an A-weighted sound level is computed on the phone, and only the
  number is sent. The cloud alerts on sustained levels above 85 dB(A), and the Gold layer computes the NIOSH daily
  noise dose.
- **Accurate 3D twin:** 20 quaternion samples per second, played with SLERP interpolation about 1.2 s behind the
  phone. Exact angles, Re-center, live angle readout, click to enlarge.

### Extra capabilities
- **Predictive early warning:** the Alert Lambda fits a trend line on the last 25 s of temperatures and raises
  `PREDICTED_OVERHEAT` before the limit is crossed (measured: 16-17 s in advance).
- **Time machine:** replay any past session from the Bronze layer on the dashboard at 1×-8× speed.
- **Scalability test:** a Lambda launches up to 200 virtual devices through the same pipeline (elasticity demo,
  hard-capped at 200 devices × 120 s, 10 runs/day).
- **Device Shadow:** the dashboard can change a phone's data rate, reset a fault remotely, or make it flash (Locate).
- **Scan to join:** QR code on the dashboard. A **credits meter** shows real usage from AWS Budgets.

### Two kinds of failure detection
1. **Injected fault** (phone button: Overheat, Power Surge, Battery Critical, Sensor Freeze) → the phone
   simply sends abnormal readings → IoT Rule filter → Alert Lambda decides → red card + alarm + email.
2. **Real failure** (Crash button, Wi-Fi off, browser closed) → the phone says nothing; the dashboard shows
   *SIGNAL LOST* after 5 s and AWS IoT publishes a lifecycle *disconnected* event after the MQTT keep-alive
   expires → *OFFLINE* alert. Nobody told the cloud — it found out.

## Repository

```
infra/budget.yaml            Budget + alert topic (deployed first)
infra/pulselake.yaml         Main CloudFormation stack
backend/alert_processor/     Real-time failure detection (Lambda)
backend/lake_writer/         SQS -> S3 bronze micro-batch writer (Lambda)
backend/analytics_api/       Athena / DynamoDB API for the dashboard (Lambda URL)
backend/lake_etl/            Bronze -> Silver (Parquet) -> Gold (views) ETL on Athena
backend/fleet_simulator/     Virtual fleet for the scalability test + synthetic history backfill (Lambda)
backend/kill_switch/         Budget-triggered shutdown (Lambda)
backend/rule_runner/         Absence + lake rules every minute (Lambda, Athena)
backend/action_dispatcher/   Push, escalation, device commands, action log (Node.js Lambda)
backend/accuracy_lab/        Fall-detector evaluation over labelled traces (Node.js Lambda)
backend/analytics_api/platform_api.py  Rules, pairing, responders, zones, lab API routes
docs/report.md               Project report
docs/demo-script.md          Step-by-step demo-day script
docs/viva-qa.md              Viva questions and answers
web/                         React + TypeScript: index.html (dashboard), device.html (phone IoT node),
                             responder.html (Responder app for the people who receive alerts)
scripts/                     deploy / status / phase / teardown (PowerShell)
```

## Run it

```powershell
aws login --region ap-southeast-2                      # sign in (browser)
./scripts/deploy.ps1 -AlertEmail you@example.com      # first deploy (~10 min)
./scripts/status.ps1                                  # money used, phase, kill switch
./scripts/phase.ps1 -Phase demo                       # before demo day (cap $9 -> $22)
./scripts/reset-data.ps1                              # wipe test data, keep the system
./scripts/teardown.ps1                                # after evaluation: delete everything
```

Open the printed **Dashboard** URL on the PC, the **Phone app** URL on each monitored phone, and the
**Responder app** on the phones that should receive alerts (on iPhone: Share → Add to Home Screen first).

Limits, stated honestly: a web page cannot sense in the background (the platform raises "monitoring
stopped" when a phone goes quiet; a native app or wearable is future scope); browsers cannot place phone
calls and SMS to India needs DLT registration, so the platform escalates to people who call with one tap;
the camera heart rate is approximate, not a medical device.

## Cost control
- Only pay-per-use services: idle cost ≈ $0. Estimated ≈ $0.05 per hour with 4 phones streaming at 1 Hz.
- AWS Budgets emails at $5 / $8 / $9 / $18 / $22 of real usage.
- Kill switch: at the phase cap ($9 testing, $22 demo) it disables all IoT rules and blocks device
  connections automatically.
- Phones auto-sleep after 10 min without activity; Athena queries are preset and capped at 100 MB scanned.
