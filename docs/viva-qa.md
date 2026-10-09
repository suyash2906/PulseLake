# PulseLake — Viva Questions & Answers

Short, honest answers you can say out loud. Every answer points to something you can **show** live.

## Concept

**Q: What is your project in one line?**
A real-time IoT analytics system on AWS: four phones act as IoT sensors, AWS detects failures within
seconds, and every reading is stored in an S3 data lake that we analyse with SQL (Athena).

**Q: Why is this "cloud computing"?**
No servers of ours exist. Every component is a managed, pay-per-use cloud service (IoT Core, Lambda,
S3, DynamoDB, Athena…). It scales automatically, costs ≈ $0 when idle, and the whole system is created
and deleted from one CloudFormation template (Infrastructure as Code).

**Q: Which service models do you use?**
Mostly **PaaS / serverless (FaaS)**: Lambda is Function-as-a-Service; IoT Core, DynamoDB, S3, Athena,
SQS, SNS are fully managed platform services. Nothing is IaaS (no EC2 virtual machines).

**Q: Why is this a data lake and not just an S3 bucket?**
1. Raw data is kept unchanged (Bronze) — we never lose the original.
2. Processed copies exist in an analytics format (Silver = Parquet, cleaned and de-duplicated).
3. Curated aggregates for reporting (Gold = Athena views).
4. Data is partitioned by date/hour and described in a central catalog (Glue).
5. It is queried **schema-on-read** — the schema is applied when we query, not when we store —
   and storage (S3) is separated from compute (Athena).

**Q: What is schema-on-read?**
We store JSON as it arrives. The Glue table only describes how to read it; Athena applies that schema at
query time. A database (schema-on-write) would force the structure before inserting.

**Q: Bronze / Silver / Gold?**
Medallion architecture. Bronze = raw, Silver = cleaned + typed + Parquet, Gold = business-level
aggregates. Our Gold layer is **logical** (Athena views), not physically stored data.

## IoT

**Q: Why MQTT and not HTTP?**
MQTT is the standard IoT protocol: a lightweight publish/subscribe protocol with one persistent
connection, small headers, QoS levels, keep-alive heartbeats, and the broker (IoT Core) fans messages out to
many subscribers (dashboard, rules) without the device knowing about them.

**Q: How do the phones authenticate?**
Amazon Cognito Identity Pool gives each browser temporary AWS credentials (guest role, ~1 hour). The
connection URL is signed with AWS Signature V4. The guest role may only connect as `PHONE_0x`/`dash-*`
and only publish/subscribe to `pulselake/*` topics — least privilege. No secret is stored in the app.

**Q: What is a Thing?**
An entry in the AWS IoT device registry. Our phones are registered Things PHONE_01–PHONE_04 with
attributes (slot, kind). The MQTT client ID equals the Thing name.

**Q: How do you detect a device that just dies?**
Two levels:
1. Dashboard heartbeat: no message for 5 s → SIGNAL LOST (application level).
2. AWS IoT lifecycle events: when a connection drops without a proper DISCONNECT, AWS publishes a
   `disconnected` event on `$aws/events/presence/...` (immediately if the socket closes, or after
   ≈ 1.5 × the MQTT keep-alive if the network silently disappears). Our rule sends it to Lambda →
   OFFLINE alert + email. *(Show: press Crash on a phone, or switch Wi-Fi off.)*

**Q: What does the Rules Engine do?**
It runs SQL on every MQTT message. Example: our alert rule only forwards abnormal readings (or every 5th
message as a heartbeat sample) to Lambda — filtering in the cloud's edge reduces Lambda calls by ~80%.

## Processing & storage

**Q: Who decides that a device failed — the phone or the cloud?**
The cloud. The phone just sends readings (e.g. temperature 85 °C). The Alert Lambda applies the rules
(temp > 70 → OVERHEAT, voltage > 6 → POWER SURGE, identical readings → SENSOR FROZEN, lost connection →
OFFLINE) and keeps state in DynamoDB so it alerts only on changes and marks alerts RESOLVED.

**Q: Why SQS + Lambda between IoT Core and S3?**
Writing one S3 file per message would create thousands of tiny files (slow and expensive to query). SQS
buffers the messages and Lambda is invoked once per ~60 s with the whole batch, writing one file per
minute — *micro-batching*. (Amazon Data Firehose does the same thing, but it is not available on the
AWS Free plan, so we built the equivalent from SQS + Lambda.)

**Q: Why DynamoDB and S3 both?**
Different jobs. DynamoDB = current state, millisecond reads (is PHONE_02 failing right now?).
S3 = the full history for analytics (what happened in the last 24 h?). Hot path vs cold path —
a lambda-architecture idea.

**Q: Why Parquet in Silver?**
Columnar + compressed: Athena reads only the columns a query needs, so it scans fewer bytes → faster
and cheaper (Athena charges per byte scanned).

**Q: What is partition projection?**
Athena calculates partition locations (dt=…/hr=…) from rules in the table definition instead of a Glue
crawler discovering them. No crawler runs → no crawler cost, and new data is queryable immediately.

## Cost & security

**Q: How much does it cost?**
≈ $0.05 per hour with 4 phones at 1 message/s; ≈ $0 when idle. We had a hard cap of $25 of AWS credits
($10 testing, $15 demo) enforced by AWS Budgets and an automatic kill switch. *(Show: scripts/status.ps1.)*

**Q: What happens if someone spams the system?**
The kill switch disables all IoT rules and blocks connections when the budget cap is reached. Athena
queries are preset only and capped at 100 MB scanned each. Phones auto-sleep after 10 idle minutes.

**Q: Security measures?**
TLS everywhere, temporary credentials (Cognito), least-privilege IAM roles per Lambda, private S3
buckets (website served only through CloudFront with Origin Access Control), no public write access
to the lake.

## Limitations & future scope
- Guest identities: anyone with the link could join a slot → future: authenticated users / X.509 device
  certificates.
- Rule-based detection → future: ML anomaly detection (e.g. Amazon SageMaker / Lookout).
- Phones simulate temperature/humidity → future: real ESP32/Raspberry Pi sensors (same MQTT topics).
- Single region → future: multi-region, IoT fleet indexing, Grafana/QuickSight dashboards.
