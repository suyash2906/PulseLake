# PulseLake: Demo-Day Script (about 12 minutes)

The story: **a data lake that senses, understands and acts.** The same platform serves different use cases.
We show two of them live, family care and lone-worker safety, with real phones.

## Who holds what
| Device | Role | App |
|---|---|---|
| Android 1 | "Grandma" living alone (Family care pack) | Phone app `device.html`, slot PHONE 01 |
| Android 2 | "Arjun", factory worker (Lone worker pack) | Phone app `device.html`, slot PHONE 02 |
| iPhone 1 | "Rahul", Grandma's son, **first contact** | Responder app, installed on the Home Screen |
| iPhone 2 | "Priya", Grandma's daughter, **backup** + Arjun's supervisor | Responder app, installed on the Home Screen |
| PC | Mission Control (cloud view) | Dashboard |

## The day before
1. `aws login --region ap-southeast-2` (click **Blank Slate**).
2. `./scripts/phase.ps1 -Phase demo`: raises the kill-switch cap from $9 to $22.
3. Optional clean slate: `./scripts/reset-data.ps1` (type RESET). Rules, responders and zones are kept.
4. Dashboard → **⚡ Rules & Actions**:
   - Install **Family care** on P01 and **Lone worker** on P02.
   - Press **History** on PHONE 01 (14 days of labelled synthetic history for the baseline rule; the ETL runs automatically).
5. On Android 1, open the phone app:
   - Join as PHONE 01 "Grandma", Elderly care.
   - Sensor hub → Location **Always** → **Save this place as zone "Home"**.
   - Turn on **Continuous monitoring**.
6. On Android 2, join as PHONE 02 "Arjun", Factory worker. Enable the noise sensor, set Location **Always** and save zone **"Site"**.
7. Pair the responders:
   - On the PC (Rules tab → People → **Pair**), or on the monitored phone ("Who gets my alerts?" → Add a responder).
   - On each iPhone: scan the QR code, choose a role, then **Add to Home Screen**, open it from there, and tap **Enable notifications**.
   - Press **Test notification**.
8. Accuracy Lab:
   - Record about 10 pillow drops and 10 "sit down hard / jump / walk" movements.
   - Label them, press **Evaluate detector** and note the numbers for the viva.
9. Charge everything and use a **mobile hotspot** (college Wi-Fi often blocks WebSockets). Record a backup video.

## The demo
| Time | Who | Action | What to say |
|---|---|---|---|
| 0:00 | Presenter | Live tab: pipeline diagram + fleet map | "Every dot is a real message. Phones are IoT sensor nodes: motion, steps, sound, GPS, heart rate. Everything lands in an S3 data lake, and the bottom row is new: the platform **acts**." |
| 1:00 | Presenter | Rules tab: the packs and rule table | "Same platform, different use cases: a pack is just a set of rules. WHEN the data says X, THEN act." Open **Compiled SQL**: "our live rules become part of the AWS IoT Rule SQL, so the managed Rules Engine filters for us." |
| 2:00 | Presenter | **＋ New rule**: Heart rate > 120 → push | Save. The toast says the IoT Rule was re-compiled. |
| 2:30 | Grandma | Sensor hub → **Measure** heart rate (finger on the camera + flash, 20 s) | "Only the number leaves the phone, never the video." The BPM appears on the dashboard card and in the lake. |
| 3:30 | Grandma | **Drop the phone onto a pillow**, don't answer "Are you OK?" | Countdown 15 s, then FALL. **Rahul's iPhone buzzes** even with the app closed. Show the Step Functions **workflow ↗** link: "it is now waiting for a human". |
| 4:30 | Rahul | Do nothing for 60 s | The escalation moves to **level 2**: **Priya's iPhone buzzes** too, and an email goes out. The dashboard bar shows "escalated to everyone". |
| 5:00 | Priya | Tap **I'm handling it** (show Call / Call 112 / Navigate) | Grandma's phone shows **"Priya is responding"**. The dashboard shows the response time. "The workflow resumed through a task token, and the person on the floor knows help is coming." |
| 6:00 | Grandma | **I'm OK now** | The alert is RESOLVED; responders get "✅ Resolved". |
| 6:30 | Presenter | **Act on a device → Ask "Are you OK?"** to Grandma | "The same prompt the 'no movement for 3 hours' rule sends automatically. If nobody answers in 5 minutes, the family is told." Grandma taps Yes. |
| 7:15 | Arjun | Play loud music / clap near the phone for 10+ s | NOISE rule fires: **Arjun's phone shows "wear hearing protection"**, Priya (supervisor) gets a push. |
| 8:00 | Arjun | Walk out of the room/building (or show the zone on the map) | "Left the site" geofence rule (when outside the zone radius). |
| 8:30 | Presenter | Rules tab: lake rule **"Less active than usual" → ▶ Run now** | "Athena compares today's REAL steps with Grandma's own 14-day baseline from the Gold layer. History is not just storage, it drives an action." |
| 9:30 | Presenter | Accuracy Lab: confusion matrix, best settings, **Apply to phones** | "We measured it: X of Y test falls caught, Z false alarms. A phone dropped on its own looks exactly like a fall to the accelerometer, which is why the person gets 15 seconds to answer first. The best thresholds go to every phone over the air through the Device Shadow." |
| 10:30 | Presenter | Data lake tab: Run ETL, then Gold · rules (response time) and Gold · daily activity | "Every action is in the lake too: we can measure how fast the family responds." |
| 11:30 | Presenter | Credits meter + kill switch | "The whole project costs under 2 dollars of credits; AWS Budgets plus our kill switch stop everything before the cap." |

## If something goes wrong
- **No push on iPhone:** it must be opened from the Home Screen icon (iOS 16.4+), with notifications allowed in Settings → Notifications → Responder. Use **Test notification**.
- **No push on Android:** Chrome → site settings → Notifications → allow.
- **A phone is stuck on CONNECTING:** switch to the hotspot / mobile data and reload.
- **The heart rate says "signal too weak":** cover both the camera AND the flash with a fingertip, press lightly and keep still. iPhones have no flash control, so use an Android.
- **Nothing connects:** run `./scripts/status.ps1`. If it says KILLED, run `./scripts/phase.ps1 -Phase demo`.
- **Total network failure:** play the backup video, then show the time machine and the lake reports.

## After the evaluation
`./scripts/teardown.ps1` (type DELETE) removes everything, so nothing can cost money afterwards.
