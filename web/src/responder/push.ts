// Web Push for the Responder app: service worker + PushManager subscription (VAPID).
// Android Chrome: works in the browser. iPhone (iOS 16.4+): only after "Add to Home Screen",
// opened from the home-screen icon.

export interface PushSupport {
  ok: boolean;
  ios: boolean;
  standalone: boolean;
  reason?: string;
}

export function pushSupport(): PushSupport {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true;
  if (!("serviceWorker" in navigator)) return { ok: false, ios, standalone, reason: "This browser has no service workers." };
  if (!("PushManager" in window) || !("Notification" in window)) {
    return {
      ok: false,
      ios,
      standalone,
      reason: ios && !standalone ? "On iPhone, add this app to your Home Screen first (Share → Add to Home Screen), then open it from there." : "This browser cannot receive push notifications.",
    };
  }
  return { ok: true, ios, standalone };
}

export async function registerWorker() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Must run from a tap (permission prompt). Returns the subscription to send to the API. */
export async function enablePush(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  const reg = (await registerWorker())!;
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked. Allow them in the browser / phone settings.");
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidPublicKey) }));
  return sub.toJSON();
}

function b64ToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
