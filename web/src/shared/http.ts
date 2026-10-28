// Calls the PulseLake API (analytics Lambda, Function URL) from any page.
import { loadConfig } from "./awsIot";

export async function apiCall<T>(path: string, opts: { method?: "GET" | "POST"; body?: object; token?: string } = {}): Promise<T> {
  const cfg = await loadConfig();
  if (!cfg.analyticsUrl) throw new Error("analyticsUrl missing in config.json");
  const headers: Record<string, string> = {};
  if (opts.body) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${cfg.analyticsUrl}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}
