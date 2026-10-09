# PulseLake: A Cloud Data Lake for Real-Time IoT Analytics on AWS

**Subject:** Cloud Computing · **Type:** Mini project · **Platform:** Amazon Web Services (region ap-southeast-2, Sydney)

---

## Abstract

PulseLake is a serverless IoT analytics platform built entirely on AWS. Four smartphones act as IoT devices: they stream
real motion-sensor readings plus user-controlled environment values over MQTT to AWS IoT Core, and users can inject
failures (overheat, power surge, crash, network loss). The cloud detects failures in real time, including devices that
die silently. It also **predicts** an overheat before it happens. It raises alerts on a live dashboard and by email, and
stores every reading in an S3 data lake organised as Bronze, Silver and Gold layers that is queried with SQL (Amazon
Athena). The system adds a *time machine* that replays any past session from the lake. A *scalability test* launches up
to 200 virtual devices through the same pipeline. Everything is defined as code (AWS CloudFormation), costs about $0
when idle, and is protected by AWS Budgets and an automatic kill switch.

## 1. Problem statement

IoT fleets produce continuous streams of sensor data. Organisations need two things from that data at the same time:

1. **Real-time insight**: know within seconds when a device fails or is about to fail.
2. **Historical insight**: keep all raw data cheaply and analyse it later in ways not planned in advance.

Traditional on-premise systems need servers sized for peak load, separate databases for live state and history, and
manual scaling. The project shows how cloud services solve both needs with no servers to manage.

## 2. Objectives

- Ingest live telemetry from real devices (smartphones) using the industry IoT protocol (MQTT).
- Detect failures in the cloud: threshold breaches, frozen sensors, and unexpected disconnects.
- Predict failures before they happen using trend analysis (predictive maintenance).
- Store all data in a data lake with raw (Bronze), cleaned (Silver) and aggregated (Gold) layers.
- Query the lake with SQL without managing a database (schema-on-read).
- Demonstrate elasticity with a large virtual fleet through the same pipeline.
- Keep the total cost under a hard cap of USD 25 of AWS credits.

## 3. Cloud computing concepts demonstrated

| Concept | Where it appears |
|---|---|
| Serverless / Function-as-a-Service | 6 AWS Lambda functions; no EC2 instances at all |
| Platform-as-a-Service | IoT Core, DynamoDB, S3, SQS, SNS, Athena, Glue, CloudFront are fully managed |
| Elasticity & auto-scaling | 4 phones → 200 virtual devices with zero configuration change |
| Pay-as-you-go | ≈ $0.05 per hour with 4 phones; ≈ $0 idle; Athena billed per byte scanned |
| Event-driven architecture | MQTT messages trigger rules, which trigger Lambda, SQS, S3 and SNS |
| Data lake / schema-on-read | S3 + Glue Data Catalog + Athena; medallion layers |
| Infrastructure as Code | Whole system created/deleted by CloudFormation templates and one script |
| Edge computing | Each phone reads its accelerometer ~60×/s and sends a 1-per-second summary (~98% less data) |
| Security / identity | Cognito temporary credentials, SigV4 signing, least-privilege IAM roles, private buckets |
| Cost governance (FinOps) | AWS Budgets, automatic kill switch, scan caps, auto-sleep, teardown |

## 4. Architecture

```
   4 PHONES (IoT Things PHONE_01..04)                 PC "Mission Control" dashboard
       │  MQTT over WebSocket + TLS                       ▲ live MQTT      ▲ REST
       │  Cognito guest credentials (SigV4)               │                │
       ▼                                                  │                │
   ┌──────────────────────────────────────────────────────┴─┐    Analytics API (Lambda URL)
   │                AWS IoT Core (MQTT broker)              │            │
   │        Rules Engine: SQL evaluated on every message    │            ▼
   └───┬──────────────────┬───────────────────┬─────────────┘   Athena ◄─ Glue Data Catalog
       │ abnormal or      │ every reading     │ lifecycle            │
       │ every 5th msg    │                   │ events               │
       ▼                  ▼                   ▼                      ▼
   Alert Lambda ◄──── SQS queue         ($aws/events/presence)   S3 DATA LAKE
   (rules + prediction)   │                                       ├─ bronze/  raw JSON
     │   │   │            ▼                                       ├─ silver/  Parquet (ETL)
     │   │   └► SNS email Lake-writer Lambda (1 file per batch) ──┤  gold      Athena views
     │   └► DynamoDB (device state, alert history)                │
     └► MQTT pulselake/alerts ──► dashboard + S3 alert archive ───┘
                       EventBridge Scheduler ─► ETL Lambda (hourly, skips if no new data)
   Hosting: S3 + CloudFront (HTTPS) · IaC: CloudFormation · Safety: Budgets → SNS → kill switch
```

### 4.1 Data flow of one reading
1. The phone samples motion at ~60 Hz, summarises it (vibration RMS/peak, 10 orientation samples) and publishes one
   JSON message per second to `pulselake/devices/PHONE_0x/telemetry`.
2. IoT Core delivers it to the dashboard (live view) and evaluates five rules.
3. Rule `bronze_telemetry` sends it to SQS; the lake-writer Lambda receives a batch and writes **one** JSON-lines file
   into `s3://…/bronze/telemetry/dt=YYYY-MM-DD/hr=HH/`.
4. Rule `telemetry_alerts` forwards it to the Alert Lambda only if it is abnormal, or if it is every 5th message (a
   heartbeat sample). This cuts Lambda invocations by about 80%.
5. The Alert Lambda compares the reading with the device state in DynamoDB, opens or resolves alerts, republishes them on
   MQTT and emails CRITICAL ones through SNS.

## 5. AWS services used

| Service | Role in the project |
|---|---|
| AWS IoT Core | MQTT broker, Thing Registry (PHONE_01..04), Rules Engine, Device Shadow, lifecycle events |
| Amazon Cognito | Identity pool that issues short-lived AWS credentials to browsers |
| AWS Lambda (6) | alert-processor, lake-writer, lake-etl, analytics-api, fleet-simulator, kill-switch (Python 3.12) |
| Amazon SQS | Buffer between IoT Core and the lake writer (micro-batching) |
| Amazon S3 | Data lake (bronze/silver), website hosting, deployment artifacts |
| AWS Glue Data Catalog | Table definitions with partition projection (no crawler) |
| Amazon Athena | Serverless SQL on S3 (2 workgroups, 100 MB scan cap per query) |
| Amazon DynamoDB | Device state and alert history (on-demand, TTL 7 days) |
| Amazon SNS | Email notifications for critical alerts and budget alerts |
| Amazon EventBridge Scheduler | Hourly ETL trigger |
| Amazon CloudFront | HTTPS delivery of the dashboard and phone app |
| AWS CloudFormation | Infrastructure as Code (2 stacks) |
| AWS Budgets | Cost tracking and alerts at $5 / $8 / $9 / $18 / $22 |
| AWS Systems Manager Parameter Store | Phase, kill-switch, ETL and load-test status |
| Amazon CloudWatch Logs | Lambda logs with 7-day retention |
| AWS IAM | 9 least-privilege roles |

## 6. Implementation

### 6.1 Device application (phone)
A React/TypeScript web page served over HTTPS. It is a web page and not an installed app, so any phone can join by
scanning a QR code. It reads the DeviceMotion/DeviceOrientation sensors (and the Battery API on Android), simulates
temperature, humidity and voltage from sliders, and offers six fault buttons. Each phone is an IoT Thing and uses
its Thing name as the MQTT client ID. A screen wake-lock keeps it streaming, and it auto-sleeps after 10 minutes of
inactivity to save credits.

### 6.2 Secure connection without secrets
The browser asks Cognito for a guest identity and temporary credentials. It signs the IoT WebSocket URL with AWS
Signature Version 4 using the Web Crypto API and connects with MQTT 5. The guest role may only connect as `PHONE_0*` or
`dash-*` and only use `pulselake/*` topics and the phones' shadows.

### 6.3 Real-time failure detection (cloud side)
The Alert Lambda decides; the phone only reports readings.

| Alert | Rule |
|---|---|
| OVERHEAT (critical) | temperature > 70 °C |
| POWER_SURGE (critical) | voltage > 6 V |
| OFFLINE (critical) | disconnect without a prior GOODBYE message |
| BATTERY_LOW | battery < 10 % |
| VIBRATION | acceleration peak > 15 m/s² (phone shaken) |
| SENSOR_FROZEN | three identical readings in a row |
| PREDICTED_OVERHEAT | trend line crosses 70 °C within 60 s |

Engineering details that made it reliable:
- **De-duplication:** alerts are opened with conditional DynamoDB writes, so an alert fires only once per incident and
  is RESOLVED automatically.
- **Out-of-order protection:** parallel Lambda invocations can process messages out of order. A conditional write on
  the last processed timestamp drops older messages, and asynchronous retries are disabled so stale messages are never
  replayed.
- **Real crash detection:** browsers close their sockets politely even when the app dies, so AWS reports
  `CLIENT_INITIATED_DISCONNECT`. The project adds its own protocol: devices leaving on purpose send `GOODBYE` first.
  Any disconnect without a recent GOODBYE is treated as a failure.

### 6.4 Predictive analytics (early warning)
For each device the Lambda keeps the last 25 seconds of temperatures in DynamoDB and fits a least-squares line. If the
slope is above 0.15 °C/s and the line crosses 70 °C within 60 s, it raises PREDICTED_OVERHEAT. When the real OVERHEAT
follows, the alert records how many seconds in advance the cloud predicted it. The dashboard shows a live countdown.

### 6.5 Data lake (medallion architecture)
- **Bronze:** raw JSON exactly as received, partitioned `dt=/hr=`, written in batches by the lake writer (telemetry)
  and by IoT rule S3 actions (events, alerts).
- **Silver:** an Athena CTAS job converts Bronze to Parquet (Snappy). It de-duplicates with `row_number()`, rejects
  impossible readings (data-quality rules), renames and types columns, and adds ingest latency.
- **Gold:** Athena views `gold_device_hourly`, `gold_fleet_health` and `gold_alert_summary`. These are logical views,
  not stored data.
- The ETL runs from a dashboard button or hourly from EventBridge Scheduler. It skips itself when no new data arrived.
- Glue tables use **partition projection**, so new partitions are queryable immediately and no crawler is needed.

### 6.6 Analytics and time machine
The analytics Lambda exposes preset reports and a read-only *Query Lab* (single SELECT, max 200 rows, enforced 100 MB
scan cap). The *time machine* finds past sessions in Bronze and replays any 10-minute window through the dashboard at 1×
to 8× speed, including joins, injected faults and alerts. This demonstrates why a data lake keeps raw data.

### 6.7 Scalability test
The fleet-simulator Lambda publishes telemetry for up to 200 virtual devices (`SIM_001…`) once per second for up to
120 s, through the same IoT Core → rules → SQS → S3 / Lambda pipeline. About 6% of the virtual devices develop faults,
so the alert path is exercised at scale. Hard limits are 200 devices, 120 s and 10 runs per day.

### 6.8 Infrastructure as Code and cost safety
Two CloudFormation stacks: `pulselake-budget` (deployed first) and `pulselake`. One PowerShell script deploys
everything; another deletes everything. Cost is protected in five layers: the AWS Free plan (the card cannot be
charged), AWS Budgets alerts, the kill switch, behaviour limits (auto-sleep, scan caps, load-test limits), and teardown.

## 7. Results (measured)

| Test | Result |
|---|---|
| Phone → dashboard latency (India → Sydney → India) | ≈ 0.3 s |
| Injected overheat → cloud alert | ≈ 1 s after the limit is crossed |
| Prediction lead time | overheat predicted **16-17 s in advance** |
| App crash → dashboard OFFLINE | 0.5 s; cloud OFFLINE alert + email in ≈ 3 s |
| Wi-Fi switched off → AWS disconnect event | *measured on demo phones: see dashboard feed "detected N s after last message"* (expected ≈ 1.5 × 30 s keep-alive) |
| ETL Bronze → Silver → Gold | 5 s; 328 KB of JSON → 18 KB Parquet (≈ 18× smaller) |
| Athena preset reports | 1-2 s each, $0.00005 each (10 MB minimum billing) |
| Load test 50 devices × 30 s | 1,500 messages, 0 errors, peak 67 msgs/s, 4 faults detected, no configuration change |
| Kill switch (simulated $9.50 alert) | all 5 rules disabled, connections denied, simulator frozen; re-armed by script |

## 8. Cost analysis

| Item | Approx. per hour (4 phones, 1 msg/s) |
|---|---|
| IoT Core messaging + delivery | $0.03 |
| IoT rules, SQS, Lambda, DynamoDB | ~$0.01 |
| S3, Athena, CloudFront, Cognito, SNS | ~$0 (free tier / pennies) |
| **Total** | **≈ $0.05 per hour, ≈ $0 idle** |

Real usage for the whole development and testing period stayed under **$1** of a $25 cap. Storage tiering
(S3 Standard-IA / Intelligent-Tiering) was evaluated and rejected: those classes bill objects smaller than 128 KB as
128 KB, so for this project's small files they would *increase* cost. Compacting to Parquet in Silver is the
cost optimisation that fits this data.

## 9. Security

- No long-lived secrets in the apps: Cognito issues temporary credentials and the URL is signed with SigV4.
- Least-privilege IAM: every Lambda has its own role. The analytics API can only read the lake, so Query Lab cannot
  drop or create tables.
- Private S3 buckets; the website is reachable only through CloudFront with Origin Access Control.
- TLS everywhere (HTTPS, WSS).

## 10. Challenges and solutions

| Challenge | Solution |
|---|---|
| The account (AWS Free plan, "new AWS experience") is locked to one region by a service control policy | Deployed to Sydney (ap-southeast-2) and signed in with `aws login` to the project region |
| Amazon Data Firehose and Kinesis are blocked on the Free plan | Built equivalent micro-batching with SQS + a Lambda event source mapping (60 s batching window) |
| Public Lambda URL returned 403 | Added the second permission (`lambda:InvokeFunction` via function URL) that AWS has required since Oct 2025 |
| `owner` and `online` are DynamoDB reserved words | Expression attribute names |
| Alerts flapping because of parallel / retried invocations | Conditional writes on last timestamp; async retries disabled |
| A browser crash looks like a normal disconnect to AWS | Application-level GOODBYE protocol |
| Athena CTAS blocked by an enforced workgroup | Separate ETL workgroup with the same scan cap |

## 11. Limitations and future scope

- Guest identities: anyone with the link can join a slot. *Future:* authenticated users or X.509 device certificates.
- Rule-based and linear-trend detection. *Future:* machine-learning anomaly detection.
- Temperature/humidity are simulated on phones. *Future:* ESP32 / Raspberry Pi sensors on the same MQTT topics.
- Single region. *Future:* multi-region replication, IoT fleet indexing, Grafana dashboards.

## 12. Conclusion

PulseLake shows that a complete real-time IoT analytics platform can be built entirely from managed cloud services,
without a single server. It covers live monitoring, cloud-side failure detection and prediction, a layered data lake with
SQL analytics, history replay, and elastic scaling. It costs cents to run and can be recreated or deleted with one
command.

## References
- AWS IoT Core Developer Guide: MQTT, rules, lifecycle events, device shadows
- Amazon Athena User Guide: CTAS, partition projection
- AWS Lambda Developer Guide: SQS event source mapping, function URLs
- AWS Well-Architected Framework: Serverless Applications Lens; Cost Optimization Pillar
