# PulseLake — Real-Time IoT Analytics on a Cloud Data Lake (AWS)

Cloud Computing mini-project. Four smartphones act as **IoT devices**: they stream their real motion
sensors (plus slider-controlled temperature/humidity) to **AWS IoT Core**, can **inject failures**, and a
PC **Mission Control dashboard** shows the fleet live, raises alerts, and queries the history stored in an
**S3 data lake** with **Amazon Athena**. Everything is serverless, defined as code, and runs on AWS
credits with a hard spending cap.

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

### Why this is a *data lake* (not just a bucket)
Raw IoT data is stored unchanged (Bronze), processed copies in an analytics format (Silver, Parquet), and
curated aggregates (Gold, Athena views). Data is partitioned by date/hour, described in a central catalog
(Glue) and queried **schema-on-read** with Athena — storage and compute are separated.

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
backend/fleet_simulator/     Virtual fleet for the scalability test (Lambda)
backend/kill_switch/         Budget-triggered shutdown (Lambda)
docs/report.md               Project report
docs/demo-script.md          Step-by-step demo-day script
docs/viva-qa.md              Viva questions and answers
web/                         React + TypeScript: index.html (dashboard), device.html (phone)
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

Open the printed **Dashboard** URL on the PC and the **Phone app** URL on each phone.

## Cost control
- Only pay-per-use services: idle cost ≈ $0. Estimated ≈ $0.05 per hour with 4 phones streaming at 1 Hz.
- AWS Budgets emails at $5 / $8 / $9 / $18 / $22 of real usage.
- Kill switch: at the phase cap ($9 testing, $22 demo) it disables all IoT rules and blocks device
  connections automatically.
- Phones auto-sleep after 10 min without activity; Athena queries are preset and capped at 100 MB scanned.
