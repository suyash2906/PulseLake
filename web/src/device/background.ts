// Background mode for the phone IoT node: keep streaming after the user switches apps or turns
// the screen off, until the tab itself is closed.
//
// What browsers allow (and what they don't):
//  - Chrome (Android) freezes or heavily throttles hidden tabs, but NOT tabs that are playing
//    audio. We play an 18 Hz tone at -36 dBFS: phone speakers cannot reproduce anything below
//    ~150 Hz, so it is silent in practice, yet the tab counts as "playing media". Android then
//    keeps Chrome alive with a media notification ("PulseLake is monitoring"), the same way a
//    music website keeps playing with the screen off.
//  - A held Web Lock also keeps the page out of Chrome's tab freezing.
//  - Motion sensors (accelerometer / gyroscope) are NEVER delivered to hidden pages - a browser
//    privacy rule. So fall detection and step counting pause while hidden; the phone reports
//    "motion paused" so the cloud does not mistake it for "no movement".
//  - iPhone Safari suspends hidden tabs within seconds whatever we do (Apple's rule).

export interface BackgroundState {
  hidden: boolean; // page not visible (other app, screen off)
  keepAlive: boolean; // the silent media keep-alive is running
  hiddenSince: number | null;
  notifications: NotificationPermission | "unsupported";
  ios: boolean;
}

const SAMPLE_RATE = 8000;

/** 1 s of an 18 Hz sine (16-bit mono WAV): inaudible on phone speakers, loops seamlessly. */
function silentToneWav(): Blob {
  const n = SAMPLE_RATE;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 18 * i) / SAMPLE_RATE) * 512), true);
  return new Blob([buf], { type: "audio/wav" });
}

export class BackgroundKeeper {
  private audio: HTMLAudioElement | null = null;
  private releaseLock: (() => void) | null = null;
  state: BackgroundState = {
    hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
    keepAlive: false,
    hiddenSince: null,
    notifications: "Notification" in window ? Notification.permission : "unsupported",
    ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1),
  };
  onChange: (s: BackgroundState) => void = () => {};

  /**
   * Call synchronously inside a tap (browsers only start media playback from a user gesture).
   * Safe to call more than once.
   */
  prime(label: string) {
    if (!this.audio) {
      this.audio = new Audio(URL.createObjectURL(silentToneWav()));
      this.audio.loop = true;
      this.audio.setAttribute("playsinline", "");
      // if Android pauses it (e.g. a phone call), resume as soon as we can
      this.audio.addEventListener("pause", () => {
        this.set({ keepAlive: false });
        setTimeout(() => void this.audio?.play().then(() => this.set({ keepAlive: true })).catch(() => {}), 1500);
      });
    }
    this.audio
      .play()
      .then(() => this.set({ keepAlive: true }))
      .catch(() => this.set({ keepAlive: false }));
    this.mediaSession(label);
    this.holdLock();
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  stop() {
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.audio) {
      this.audio.loop = false;
      this.audio.pause();
      URL.revokeObjectURL(this.audio.src);
      this.audio = null;
    }
    this.releaseLock?.();
    this.releaseLock = null;
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
    this.set({ keepAlive: false });
  }

  /** Lets "Are you OK?" / messages reach the person while the tab is hidden. Needs a tap. */
  async enableNotifications() {
    if (!("Notification" in window)) return;
    const p = await Notification.requestPermission();
    this.set({ notifications: p });
    if (p === "granted" && "serviceWorker" in navigator) await navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }

  /** System notification (works while hidden) - tapping it brings the phone app back. */
  async notify(title: string, body: string, tag: string, critical = false) {
    if (!this.state.hidden || this.state.notifications !== "granted" || !("serviceWorker" in navigator)) return;
    try {
      const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
      await reg.showNotification(title, {
        body,
        tag,
        requireInteraction: critical,
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        data: { url: location.pathname + location.search },
        // vibrate is supported on Android but missing from the TS lib types
        ...({ vibrate: critical ? [500, 200, 500, 200, 900] : [200] } as object),
      });
    } catch {
      /* notifications unavailable - the command is still shown when the tab is opened */
    }
  }

  private mediaSession(label: string) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "PulseLake is monitoring",
      artist: label,
      album: "Close the tab to stop",
      artwork: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    });
    // the notification's pause button must not silently stop the monitoring
    try {
      navigator.mediaSession.setActionHandler("pause", () => void this.audio?.play());
      navigator.mediaSession.setActionHandler("stop", () => void this.audio?.play());
    } catch {
      /* action not supported */
    }
  }

  private holdLock() {
    const locks = (navigator as any).locks;
    if (!locks || this.releaseLock) return;
    locks
      .request("pulselake-keepalive", () => new Promise<void>((resolve) => (this.releaseLock = resolve)))
      .catch(() => {});
  }

  private onVisibility = () => {
    const hidden = document.visibilityState === "hidden";
    this.set({ hidden, hiddenSince: hidden ? Date.now() : null });
    if (!hidden && this.audio?.paused) void this.audio.play().then(() => this.set({ keepAlive: true })).catch(() => {});
  };

  private set(patch: Partial<BackgroundState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}
