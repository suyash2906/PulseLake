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

**Q: How does the early warning (prediction) work?**
The Alert Lambda stores the last 25 seconds of each device's temperature in DynamoDB and fits a least-squares trend line.
If the line rises faster than 0.15 °C/s and will cross 70 °C within 60 s, it raises PREDICTED_OVERHEAT. When the real
overheat happens, the alert records the lead time. We measured 16-17 s of warning. This is the basic idea behind
**predictive maintenance**. *(Show: press Overheat and watch the purple countdown.)*

**Q: What is the time machine and why is it a data-lake feature?**
Because Bronze keeps every raw message, Athena can pull any past window and the dashboard replays it exactly as it
happened. A database that only stores the current state could not do that. It also lets us re-run analytics on old
data with new rules.

**Q: How do you prove the system scales?**
The scale test launches up to 200 virtual devices from a Lambda function through the same pipeline. Messages per second
jump from ~4 to ~200, alerts are raised for the virtual devices that fail, every message lands in S3, and we changed
nothing. That is elasticity. *(Show: Scale test tab.)*

**Q: Where is edge computing in your project?**
On each phone. It reads the accelerometer about 60 times a second and sends only a 1-per-second summary (vibration RMS,
peak and 10 orientation samples). That is ~98% less data than streaming raw samples.

**Q: Did you use S3 storage classes (IA / Glacier)?**
We evaluated them and decided not to. Standard-IA and Intelligent-Tiering bill every object under 128 KB as 128 KB, and
our batch files are smaller, so tiering would cost more. Converting to compressed Parquet in Silver saves more for our
data. Knowing when *not* to use a feature is part of cost optimisation.

## Version 2: safety, noise and the 3D twin

**Q: How does fall detection work, and why on the phone?**
The phone reads its accelerometer about 60 times a second and runs the three-phase model used in fall-detection
research: *free fall* (total acceleration near 0 g for at least 80 ms), then an *impact* (a spike of at least 2 g within
1 s), then *stillness* for 2 s. It also measures how much the phone's orientation changed. This must run at the edge,
because the cloud only receives one summary per second, and a free fall lasts less than half a second. The cloud does
what a phone cannot: it raises the alert, emails a caregiver, stores the event in the data lake and reports on it.

**Q: What stops false alarms?**
Two things. First, all three phases must happen in order. Shaking, walking or putting the phone down does not do that,
and we tested each case. Second, there is a 15-second "Are you OK?" countdown, the same idea as smartwatch fall
detection. If the person taps "I'm OK", nothing is sent except a FALL_CANCELLED record, which we keep in the lake to
measure the false-alarm rate (report: *falls, false alarms and SOS*).

**Q: Isn't recording audio a privacy problem?**
We never record or send audio. The phone turns the microphone signal into a single number (sound level in dB(A))
every 100 ms, and only that number leaves the device. This is privacy by design through edge processing.

**Q: How accurate are the noise numbers?**
Approximate. Phone microphones are not calibrated instruments, which is a known limitation in noise-crowdsensing
research. We apply the A-weighting curve in software and let the user set a calibration offset against a reference
meter. The cloud alerts on *sustained* levels above 85 dB(A), the NIOSH occupational limit, and the Gold layer
computes the NIOSH daily noise dose (100% = 85 dB(A) for 8 hours, with a 3 dB exchange rate).

**Q: Why quaternions for the 3D twin?**
The phone reports Euler angles (alpha, beta, gamma). Interpolating Euler angles fails near ±90° and ±180° (gimbal
lock and wrap-around), which made version 1 jumpy and inaccurate. We convert each sample to a quaternion on the phone
(W3C Z-X'-Y'' order), send 20 samples per second inside the normal 1-per-second message, and the dashboard
interpolates with SLERP (spherical linear interpolation). It plays them about 1.2 s late, so it always has the next
sample. The result is exact angles, smooth 60 fps motion and no extra messages, so no extra cost. A live mode at
15-20 messages per second would remove the delay but cost about $0.10 per hour per phone, so we chose accuracy at
zero extra cost.

## Version 3: a data lake that acts

**Q: What is the real use case? Isn't this just a dashboard?**
No. Version 3 closes the loop: **Sense → Store → Understand → Act.** Phones collect many kinds of data, and the data
lake stores it all. Rules decide when something matters, and the platform then acts. It notifies the right person's
phone, escalates if nobody answers, and sends commands back to the device. The same platform serves several use cases
through rule packs: an elderly parent living alone (the family is alerted), a lone factory worker (the supervisor is
alerted), a city noise node, and asset tracking. Changing the use case means changing rules, not code.

**Q: Your teacher's scenario: my parents live in another home and one of them falls. What exactly happens?**
1. The phone detects free fall → impact → stillness and asks "Are you OK?" for 15 s.
2. With no answer, a FALL_DETECTED event goes to AWS IoT Core. The alert Lambda opens a CRITICAL alert, and the
   "Family care" rule hands it to the action dispatcher.
3. That starts a **Step Functions** escalation:
   - The son's phone gets a push notification even if the app is closed.
   - The workflow then *waits* for someone to tap "I'm handling it" (task-token callback).
   - After 60 s with no answer, every family member is notified and an email is sent.
   - After 2 more minutes, the alert is marked UNANSWERED.
4. When someone taps "I'm handling it", the workflow resumes and the parent's phone shows "Priya is responding".
5. The response time is stored in the lake.

**Q: Why can't it call an ambulance automatically?**
- A browser cannot place phone calls.
- SMS to Indian numbers requires DLT registration and costs money.
- Auto-dialling 112 from a prototype would be irresponsible because of false alarms.

Commercial medical-alert systems route alerts to a human response centre for the same reason. Our system escalates to
people, who get one-tap **Call {parent}**, **Call 112** and **Navigate** buttons. A voice-call integration (e.g. Amazon
Connect) is future scope.

**Q: How does the system "understand"? You said no AI.**
Rules plus context, no AI service:
- **Thresholds held over time.** For example "noise > 85 for 10 s".
- **Time windows.** For example "only at night".
- **Geofences.** For example "left the Home zone at night".
- **Absence.** For example "no movement for 3 hours during the day". The phone first asks "Are you OK?", and only an
  unanswered question alerts the family.
- **Personal baselines from the lake.** "Less active than usual" compares today's real steps with that person's own
  14-day average from the Gold layer. A rule based on the person's own normal is far more meaningful than a fixed
  number.

**Q: Where does the data lake drive actions?**
- **Lake rules.** Every hour the rule runner runs Athena SQL over Bronze/Gold (steps vs baseline, daily NIOSH noise
  dose, repeated falls), and any rows that come back become alerts and actions.
- **Accuracy Lab.** It uses the lake's raw motion traces to tune the fall detector.
- **Rule effectiveness.** Every action taken is written back to the lake (bronze/actions), so we can measure how fast
  people respond (gold_rule_effectiveness).

**Q: How do your rules relate to the AWS IoT Rules Engine?**
The Rules Engine filters in SQL before anything reaches Lambda. When a user saves a live rule (e.g. noise > 85 on
PHONE_02), our API *compiles* it into the IoT Rule's `WHERE` clause with `ReplaceTopicRule`. The managed Rules Engine
then forwards exactly the messages that matter. The dashboard shows the compiled SQL.

**Q: Why Step Functions instead of a simple timer in Lambda?**
An escalation is a long-running workflow: wait, branch on a human answer, time out, retry with someone else. A Lambda
cannot wait minutes for a person. Step Functions' *callback pattern* (`.waitForTaskToken`) pauses the workflow at no
compute cost until `SendTaskSuccess` arrives (the ack) or the timeout fires. It is visible as a graph for every alert,
and it costs nothing at our volume (4,000 free state transitions a month, about 8 per escalation).

**Q: How do notifications reach a phone when the app is closed, for free?**
Through **Web Push**:
1. The Responder app is an installable web app (PWA) with a service worker.
2. It subscribes with our VAPID public key.
3. A Node.js Lambda signs each message with the private key, which is kept in SSM Parameter Store as an encrypted
   SecureString.
4. The browser's push service (Google for Android, Apple for iPhone) delivers it.

There is no SMS cost. On iPhone it works when the app is added to the Home Screen (iOS 16.4+).

**Q: How are responders authenticated?**
1. The monitored phone creates a one-time 6-digit pairing code. It is valid for 10 minutes and works once, which proves
   physical access to the phone.
2. The responder enters it and receives a random token.
3. The server stores only the token's SHA-256 hash.

Phones may publish data topics, but only the cloud may publish to `devices/*/commands` (IAM policy).

**Q: What new sensors did you add, and how accurate are they?**
- **Steps and activity:** peak detection with regularity checks. It counted 49 of 50 steps on a test signal; we verify
  on the real phone by counting 50 steps.
- **GPS:** three privacy levels. Location is rounded to about 100 m unless there is an emergency.
- **Camera heart rate:** photoplethysmography (PPG). The fingertip covers the camera and flash, the brightness pulses
  with each heartbeat, and autocorrelation finds the period. It is approximate and not a medical device.
- **Sound bang detection:** adds evidence to a fall.

The temperature and humidity sliders are labelled "virtual sensors": stand-ins for external sensors such as an ESP32.

**Q: How accurate is your fall detection?**
We measure it instead of claiming it, in the Accuracy Lab:
1. Each fall candidate uploads a 9.5 s raw accelerometer trace to the lake.
2. We label the traces (test fall, phone dropped, sat down hard, walking, jump).
3. A Lambda re-runs the phone's own `fall.ts` code (the same file, bundled for the cloud) over 300 threshold settings
   and reports sensitivity, specificity and F1.
4. The best setting is pushed to every phone over the air via the Device Shadow.

*(Quote our measured numbers here.)* The key honest finding: a phone dropped on its own produces the same signal as a
fall. The accelerometer alone cannot tell them apart, which is exactly why the person gets 15 s to answer "Are you OK?"
before anyone is alerted.

**Q: The phone must keep the web page open. Isn't that unrealistic?**
It is the main limit of a web prototype, and we handle it openly:
- The "monitoring stopped" rule alerts the family when a phone goes silent, so a gap in protection is never silent.
- A native app or a wearable is the production path.

The cloud side (rules, lake, escalation, push) would stay exactly the same.

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
  certificates. The dashboard (rules, commands) has no operator login yet → future: Cognito user pool.
- Web pages cannot sense in the background → future: native Android/iOS app or a wearable (same cloud).
- No automatic emergency call → future: Amazon Connect voice escalation / a 24x7 response centre.
- Rule-based detection → future: ML anomaly detection (e.g. Amazon SageMaker / Lookout).
- Phones simulate temperature/humidity → future: real ESP32/Raspberry Pi sensors (same MQTT topics).
- Single region → future: multi-region, IoT fleet indexing, Grafana/QuickSight dashboards.
