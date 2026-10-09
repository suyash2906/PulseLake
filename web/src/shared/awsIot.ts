// Connects a browser (phone or dashboard) to AWS IoT Core over MQTT/WebSocket.
//
// Flow:  Cognito Identity Pool (guest identity) -> temporary AWS credentials
//        -> SigV4-presigned wss:// URL for the IoT data endpoint -> mqtt.js client.
// No AWS SDK needed: the two Cognito calls are plain HTTPS and the SigV4 signing
// uses the browser's Web Crypto API.
import mqtt, { type MqttClient, type IClientOptions } from "mqtt";

export interface AppConfig {
  region: string;
  identityPoolId: string;
  iotEndpoint: string; // xxxxx-ats.iot.<region>.amazonaws.com
  analyticsUrl?: string;
  deviceUrl?: string;
  stage?: string;
}

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number; // epoch ms
}

let configPromise: Promise<AppConfig> | null = null;
export function loadConfig(): Promise<AppConfig> {
  configPromise ??= fetch("/config.json", { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("config.json missing - run scripts/deploy.ps1");
    return r.json();
  });
  return configPromise;
}

// ---------------------------------------------------------------- Cognito
async function cognito(region: string, target: string, body: object) {
  const res = await fetch(`https://cognito-identity.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Cognito ${target} failed: ${json.message ?? res.status}`);
  return json;
}

const ID_KEY = "pulselake.identityId";

async function getGuestCredentials(cfg: AppConfig): Promise<AwsCreds> {
  // Re-use one guest identity per browser so we don't create a new one on every reload.
  let identityId = safeGet(ID_KEY);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!identityId) {
      identityId = (await cognito(cfg.region, "GetId", { IdentityPoolId: cfg.identityPoolId })).IdentityId as string;
      safeSet(ID_KEY, identityId);
    }
    try {
      const { Credentials: c } = await cognito(cfg.region, "GetCredentialsForIdentity", { IdentityId: identityId });
      return {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretKey,
        sessionToken: c.SessionToken,
        expiresAt: Math.floor(Number(c.Expiration) * 1000),
      };
    } catch (e) {
      if (attempt === 1) throw e;
      identityId = null; // stale identity (e.g. pool was re-created) -> get a fresh one
      safeSet(ID_KEY, "");
    }
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------- SigV4
const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (s: string) => toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

async function presignIotUrl(cfg: AppConfig, creds: AwsCreds): Promise<string> {
  const service = "iotdevicegateway";
  const host = cfg.iotEndpoint;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20261005T120000Z
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${cfg.region}/${service}/aws4_request`;
  const query =
    "X-Amz-Algorithm=AWS4-HMAC-SHA256" +
    `&X-Amz-Credential=${encodeURIComponent(`${creds.accessKeyId}/${scope}`)}` +
    `&X-Amz-Date=${amzDate}` +
    "&X-Amz-SignedHeaders=host";
  const canonicalRequest = ["GET", "/mqtt", query, `host:${host}\n`, "host", await sha256Hex("")].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  let key = await hmac(enc.encode(`AWS4${creds.secretAccessKey}`) as BufferSource, dateStamp);
  key = await hmac(key, cfg.region);
  key = await hmac(key, service);
  key = await hmac(key, "aws4_request");
  const signature = toHex(await hmac(key, stringToSign));
  // IoT expects the session token appended AFTER signing.
  return `wss://${host}/mqtt?${query}&X-Amz-Signature=${signature}&X-Amz-Security-Token=${encodeURIComponent(creds.sessionToken)}`;
}

// ---------------------------------------------------------------- MQTT
export type ConnState = "connecting" | "online" | "reconnecting" | "offline" | "blocked";

export interface IotConnection {
  client: MqttClient;
  /**
   * graceful=true sends an MQTT DISCONNECT (AWS logs CLIENT_INITIATED_DISCONNECT).
   * graceful=false just drops the socket like a crashed device (AWS logs CONNECTION_LOST).
   */
  close: (graceful?: boolean) => void;
}

export interface ConnectOptions {
  clientId: string;
  onState?: (s: ConnState, detail?: string) => void;
  will?: IClientOptions["will"];
}

/**
 * Opens an MQTT 5 connection to AWS IoT Core. mqtt.js handles reconnects; we keep a
 * freshly signed URL ready (re-signed every 4 min, new credentials 5 min before expiry)
 * so every reconnect uses valid credentials.
 */
export async function connectIot(opts: ConnectOptions): Promise<IotConnection> {
  const cfg = await loadConfig();
  let creds = await getGuestCredentials(cfg);
  let url = await presignIotUrl(cfg, creds);
  let stopped = false;

  const refresh = async () => {
    try {
      if (creds.expiresAt - Date.now() < 5 * 60_000) creds = await getGuestCredentials(cfg);
      url = await presignIotUrl(cfg, creds);
    } catch (e) {
      console.warn("credential refresh failed", e);
    }
  };
  const timer = setInterval(refresh, 4 * 60_000);

  opts.onState?.("connecting");
  const client = mqtt.connect(url, {
    clientId: opts.clientId,
    protocolVersion: 5,
    keepalive: 30, // AWS IoT minimum; disconnect detected after ~1.5x this (measured in Phase 2)
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 15_000,
    will: opts.will,
    transformWsUrl: () => url,
  });

  client.on("connect", () => opts.onState?.("online"));
  client.on("reconnect", () => {
    void refresh();
    opts.onState?.("reconnecting");
  });
  client.on("offline", () => !stopped && opts.onState?.("offline"));
  client.on("error", (e) => console.warn("mqtt error", e.message));
  client.on("disconnect", (packet) => {
    // 0x8E "session taken over": another browser connected with the same client ID.
    if (packet.reasonCode === 0x8e) {
      stopped = true;
      client.end(true);
      opts.onState?.("blocked", "Another device took this slot");
    }
  });

  return {
    client,
    close: (graceful = true) => {
      stopped = true;
      clearInterval(timer);
      client.end(!graceful); // mqtt.js: end(true) destroys the socket without DISCONNECT
      opts.onState?.("offline");
    },
  };
}

// localStorage can throw (private mode etc.)
function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k) || null;
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
