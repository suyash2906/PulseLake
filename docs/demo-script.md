# PulseLake: Demo-Day Script (≈ 10 minutes)

## The day before
1. `aws login --region ap-southeast-2` (click **Blank Slate**).
2. `./scripts/phase.ps1 -Phase demo`: raises the kill-switch cap from $9 to $22.
3. Optional clean slate: `./scripts/reset-data.ps1` (type RESET). Then do one 5-minute rehearsal, so the time
   machine has a session to replay.
4. Charge the 4 phones. Put them on a **mobile hotspot** (college Wi-Fi often blocks WebSockets).
5. On iPhones: Settings → Apps → Safari → Advanced → **Motion & Orientation Access ON**.
6. Record a backup screen video of a full run (in case of network trouble).

## Setup (before the teacher arrives)
- PC: open https://d16yre0rlmnv4p.cloudfront.net, go full screen (F11) and click 🔇 so it shows 🔊 (alarm sound).
- Phones: scan the **📲 Join** QR code, pick PHONE 01-04, enter a name and a device type, then tap Connect.
- Check: 4 cards are green, the "Live data flow" diagram shows moving dots, msgs/sec ≈ 4.

## The demo

| Time | Who | Action | What to say |
|---|---|---|---|
| 0:00 | Presenter | Show the **Live data flow** diagram | "Every dot is a real message: phone → AWS IoT Core → Rules Engine → SQS → S3 data lake. No servers; everything is serverless." |
| 1:00 | Phone 1 | Tilt and turn the phone | "The 3D phone on screen copies the real phone. 60 sensor readings per second are summarised on the phone itself: edge computing." |
| 2:00 | Phone 2 | Press **Overheat** | "The phone only sends temperatures. Watch the cloud **predict** the failure…" (purple countdown) "…and now OVERHEAT: the cloud warned us ~16 seconds before." Email arrives. |
| 3:30 | Phone 2 | Press **Recover** | Alert becomes RESOLVED automatically. |
| 4:00 | Phone 3 | Press **Crash** | "The device died without telling anyone. AWS IoT noticed the lost connection: OFFLINE in seconds." Then **Reboot**. |
| 5:00 | Phone 4 | Turn **Wi-Fi/data off** | "A silent network loss: the dashboard shows SIGNAL LOST after 5 s, and AWS confirms OFFLINE after the MQTT keep-alive expires. The feed shows exactly how many seconds it took." Turn it back on. |
| 6:00 | Phone 1 | Shake hard | VIBRATION warning. |
| 6:15 | Phone 2 (Elderly care) | Hold it upright, then **drop it onto a pillow** from about 1 m | "Free fall, impact, stillness, all detected on the phone at 60 Hz." The phone asks "Are you OK?". Let the 15 s run out: FALL banner, alarm and email. Then tap "I'm OK now", and the alert is RESOLVED. Repeat once and tap "I'm OK" during the countdown: a false alarm, kept for analytics. |
| 7:00 | Phone 3 (City noise node) | Tap **Enable noise sensor**, then play loud music or clap near it for over 10 s | "Only the number leaves the phone, never audio." The dB(A) meter rises, and a NOISE_HIGH warning follows after 10 s above 85. |
| 7:30 | Any phone | Tilt slowly: flat, upright, on its side, upside down | The 3D twin follows with the exact angles, about 1 s behind. Compare the F/B and L/R numbers on the phone with the dashboard card. Click the phone to enlarge it. |
| 6:30 | Presenter | Dashboard: **📍 Locate** on a card | The phone flashes and vibrates: a command sent back through the IoT Device Shadow. |
| 7:00 | Presenter | Tab **🪣 Data lake** → **Run ETL** | "Raw JSON (Bronze) becomes clean Parquet (Silver) and Gold views. 18× smaller." Run *Fleet health report* and *Alerts per device*. Show the SQL. |
| 8:00 | Presenter | **Time machine** → replay the rehearsal at 4× | "Because a data lake keeps raw data, we can replay history." |
| 9:00 | Presenter | Tab **🚀 Scale test** → 200 devices × 60 s | "Elasticity: from 4 to 200 devices, ~200 msgs/s, through the same pipeline, and we added zero servers." (≈ $0.04 of credits) |
| 10:00 | Presenter | Header **credits meter**; mention the kill switch | "The whole project cost under $1. AWS Budgets plus an automatic kill switch guarantee the cap." |

## If something goes wrong
- A phone is stuck on CONNECTING → switch it to the hotspot / mobile data; reload the page.
- iPhone tilt does nothing → tap **Enable motion sensors** on the phone (or the Settings toggle above).
- Nothing connects at all → `./scripts/status.ps1`. If "KILLED", run `./scripts/phase.ps1 -Phase demo`.
- Total network failure → play the backup video, then show the **time machine** replay.

## After the evaluation
`./scripts/teardown.ps1` (type DELETE): removes everything, so nothing can cost money afterwards.
