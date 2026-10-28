# PulseLake: A Cloud Data Lake for Real-Time IoT Analytics on AWS

**Subject:** Cloud Computing · **Type:** Mini project · **Platform:** Amazon Web Services (region ap-southeast-2, Sydney)

---

## Abstract

PulseLake is a serverless IoT data-lake platform built entirely on AWS that **senses, stores, understands and acts**.
Smartphones act as multi-sensor IoT devices: motion, steps and activity, sound level, GPS, camera heart rate and
battery. They stream to AWS IoT Core, and users can inject failures (overheat, power surge, crash, network loss).
Version 3 adds a no-code **Rules & Actions engine**:
- Rules can watch the live stream, geofences, things that did *not* happen, and the lake's history (Athena).
- Actions reach people: push notifications to a Responder app, with an AWS Step Functions escalation when nobody
  acknowledges.
- Actions also reach devices: messages and "Are you OK?" prompts.

The same platform serves different use cases through rule packs (family care, lone worker, city noise, asset
tracking). The fall detector's accuracy is measured on labelled recordings in an Accuracy Lab. The cloud detects failures in real time, including devices that
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
- (v3) **Act on the data:**
  - user-defined rules over live data, absence and lake history;
  - notify the right people with acknowledgement and escalation;
  - send commands back to devices.
- (v3) Support real use cases through rule packs, e.g. an elderly parent living alone whose children must be told
  when they fall or stop moving.
- (v3) Measure detection accuracy on recorded data instead of claiming it.

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
| Workflow orchestration (v3) | AWS Step Functions escalation with the task-token callback pattern (human in the loop) |
| Closed-loop analytics (v3) | Lake (Athena) rules trigger actions; every action is written back to the lake and measured |
| Push messaging (v3) | Web Push (VAPID) from Lambda to an installable web app; keys in SSM SecureString |
| Edge ↔ cloud model loop (v3) | Cloud re-runs the edge detector on lake data, pushes tuned thresholds via Device Shadow |

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
| AWS IAM | 14 least-privilege roles |
| AWS Step Functions (v3) | Escalation workflow: notify → wait for acknowledgement → escalate → UNANSWERED |
| AWS Lambda (v3, +3) | rule-runner (Python), action-dispatcher and accuracy-lab (Node.js 22, bundled with esbuild) |
| Amazon DynamoDB (v3) | Single-table `pulselake-platform`: rules, responders, pairing codes, zones, escalations, actions, lab |

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

### 6.9 Version 3: more sensors on the phone (Sense)
- **Steps and activity:** the acceleration magnitude is smoothed and compared with its slow average (gravity). A step
  is a peak above +1.2 m/s² after a dip below +0.2 m/s². Only *regular* runs of four or more steps, 0.25-2 s apart,
  count, so a single bump never does. Activity (still / walking / active) comes from cadence and movement RMS, and
  "seconds without movement" is sent with every message.
- **GPS with privacy levels:** off, emergency only, or always (rounded to ~100 m, exact during an emergency). Named
  zones (Home, Site, Depot) are saved from the phone for geofence rules.
- **Camera heart rate (PPG):** a fingertip covers the rear camera and flash, and the red brightness is sampled at
  ~30 fps for 20 s. The signal is resampled, detrended and smoothed, then autocorrelation over 40-200 bpm finds the
  pulse period. A quality score rejects weak signals. Only the number is sent. The reading is approximate, not
  medical.
- **Sound bang:** a jump of 15 dB or more to at least 75 dB(A) at the moment of impact adds evidence to a fall.
- **Commands from the cloud:** a message, an "Are you OK?" prompt, "help is coming", and a sampling-rate boost.

### 6.10 Rules & Actions engine (Understand + Act)
Rules live in a single DynamoDB table and are built without code in the dashboard. There are five kinds:

| Kind | Evaluated by | Example |
|---|---|---|
| Live | Alert Lambda, on every forwarded message | heart rate > 120 bpm; noise > 85 dB(A) for 10 s |
| Zone | Alert Lambda (haversine distance) | leaves zone "Home" between 22:00 and 06:00 |
| Absence | Rule-runner Lambda, every minute | no movement for 3 h during the day (first asks "Are you OK?"); no data for 10 min; battery < 15% and not charging |
| Lake | Rule-runner Lambda → Athena | steps today below 60% of the person's own 14-day average; daily noise dose > 50%; ≥ 2 falls in 7 days |
| On alert | Alert Lambda | fall or SOS → push + escalate + email |

- **Compiled into the IoT Rule.** Live-rule thresholds are compiled into the `WHERE` clause of the AWS IoT Rule
  (`ReplaceTopicRule`), so the managed Rules Engine forwards only the messages that matter.
- **Packs.** Use-case packs install a set of rules on chosen devices:
  - Family care: 9 rules.
  - Lone worker: 5 rules.
  - City noise: 3 rules.
  - Asset tracking: 4 rules.
- **Actions.** These run in a Node.js *action dispatcher*:
  - Web Push to the device's responders;
  - a Step Functions escalation;
  - email;
  - device commands.
- **Action log.** Every action is logged to `bronze/actions`, a recent-actions table, and the MQTT topic
  `pulselake/actions` (live action log).

### 6.11 Responders and escalation
- **Responder app.** The people who receive alerts use an installable web app (`responder.html`).
- **Pairing.** It pairs with a 6-digit one-time code created on the monitored phone (valid 10 minutes, single use).
  The server stores only a hash of the responder's token.
- **Push.** The app subscribes to Web Push with the platform's VAPID key, so alerts arrive even when it is closed.
- **Responding.** An alert shows the evidence and a map, plus **I'm handling it**, **Call**, **Call 112** and
  **Navigate**.
- **Escalation workflow.** An AWS Step Functions workflow uses the callback pattern:
  1. Notify level-1 responders and wait up to 60 s for a task-token callback.
  2. Otherwise notify everyone and send an email, then wait 120 s.
  3. Otherwise mark the alert UNANSWERED.
- **Acknowledgement.** "I'm handling it" calls `SendTaskSuccess`. The parent's phone then shows "Priya is responding",
  and the response time is stored in the lake (`gold_rule_effectiveness`).

### 6.12 Accuracy Lab
1. Every fall candidate (free fall, or an impact above 2.2 g) uploads a 9.5 s raw accelerometer trace to
   `bronze/traces` through a dedicated IoT Rule.
2. Traces are labelled in the dashboard.
3. A Node.js Lambda runs the **same `fall.ts` file the phones run** (bundled with esbuild) over every labelled trace for
   300 threshold settings. It reports the confusion matrix, sensitivity, specificity and F1.
4. The best setting is pushed to all phones through the Device Shadow's desired state.

### 6.13 Lake additions
- **New Bronze datasets:** `bronze_traces` and `bronze_actions`.
- **New Silver columns:** steps, activity, still time, GPS.
- **New Gold views:**
  - `gold_daily_activity`
  - `gold_baseline` (14-day mean and standard deviation per person)
  - `gold_heart_rate`
  - `gold_rule_effectiveness`
- **Demo history:** a *backfill* mode of the fleet simulator writes 14 days of clearly labelled synthetic history
  (`sensors = 'synthetic'`), so baseline rules have a personal "normal" to compare today's real data against.

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

- Guest identities: anyone with the link can join a slot, and the dashboard has no operator login. *Future:*
  authenticated users (Cognito user pool) or X.509 device certificates.
- A web page cannot sense in the background. The platform raises "monitoring stopped" when a phone goes silent.
  *Future:* a native app or a wearable, using the same cloud.
- No automatic emergency-service call: browsers cannot place calls, and SMS to India needs DLT registration. The
  platform escalates to people who call with one tap. *Future:* Amazon Connect voice escalation or a 24x7 response
  centre.
- A phone dropped on its own is indistinguishable from a fall for the accelerometer. That is why the 15 s
  "Are you OK?" step exists.
- Rule-based and linear-trend detection. *Future:* machine-learning anomaly detection.
- Temperature/humidity are simulated on phones. *Future:* ESP32 / Raspberry Pi sensors on the same MQTT topics.
- Single region. *Future:* multi-region replication, IoT fleet indexing, Grafana dashboards.

## 12. Conclusion

PulseLake shows that a complete real-time IoT analytics platform can be built entirely from managed cloud services,
without a single server. It covers live monitoring, cloud-side failure detection and prediction, a layered data lake with
SQL analytics, history replay, and elastic scaling.

Version 3 closes the loop from data to action. Rules over live data, absence and lake history reach real people's
phones, escalate through a workflow when nobody answers, and send commands back to devices. The detector's accuracy is
measured on the lake's own recordings. The same platform serves several use cases by changing rules, not code. It costs
cents to run and can be recreated or deleted with one command.

## References
- AWS IoT Core Developer Guide: MQTT, rules, lifecycle events, device shadows
- Amazon Athena User Guide: CTAS, partition projection
- AWS Lambda Developer Guide: SQS event source mapping, function URLs
- AWS Well-Architected Framework: Serverless Applications Lens; Cost Optimization Pillar
