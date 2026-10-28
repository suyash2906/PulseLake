// Rules & Actions: "WHEN the data says X, THEN do Y" - the Understand + Act half of the platform.
// Use-case packs, a no-code rule builder, the IoT Rule SQL compiled from the rules, people who
// receive actions (responders), escalations (Step Functions) and the live action log.
import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { loadConfig } from "../shared/awsIot";
import {
  ABSENCE,
  ALERT_TYPES,
  LAKE_TEMPLATES,
  METRICS,
  PACKS,
  describeRule,
  type Op,
  type Rule,
  type RuleKind,
  type Severity,
} from "../shared/rules";
import { SLOTS } from "../shared/types";
import { api, fmtBytes, type CompileResult, type Escalation, type LakeRuleRun, type ResponderLink } from "./api";
import { fleet, useFleet } from "./store";

const KIND_META: Record<RuleKind, { icon: string; label: string; hint: string }> = {
  live: { icon: "⚡", label: "Live", hint: "a value in the live stream" },
  zone: { icon: "📍", label: "Zone", hint: "GPS inside / outside a place" },
  absence: { icon: "⏳", label: "Absence", hint: "something did NOT happen" },
  lake: { icon: "🪣", label: "Lake", hint: "Athena SQL over history" },
  alert: { icon: "🚨", label: "On alert", hint: "react to a built-in alert" },
};

export function RulesPanel() {
  const snap = useFleet();
  const [rules, setRules] = useState<Rule[]>([]);
  const [sql, setSql] = useState<{ sql: string; disabled: boolean } | null>(null);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const [run, setRun] = useState<{ rule: Rule; res: LakeRuleRun | null } | null>(null);
  const [responders, setResponders] = useState<ResponderLink[]>([]);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [machineArn, setMachineArn] = useState("");

  const refresh = () => {
    api.rules().then(setRules).catch((e) => setError(e.message));
    api.ruleSql().then(setSql).catch(() => {});
    api.responders().then(setResponders).catch(() => {});
    api.escalations().then(setEscalations).catch(() => {});
  };
  useEffect(() => {
    refresh();
    api.actions().then((a) => fleet.setActions(a)).catch(() => {});
    loadConfig().then((c) => setMachineArn(c.escalationArn ?? "")).catch(() => {});
    const t = setInterval(() => {
      api.escalations().then(setEscalations).catch(() => {});
      api.rules().then(setRules).catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, []);

  const compiled = (c: CompileResult, what: string) => {
    setSql({ sql: c.sql, disabled: c.disabled });
    setToast(`${what} · AWS IoT Rule re-compiled with ${c.userClauses} user condition${c.userClauses === 1 ? "" : "s"}`);
    setTimeout(() => setToast(""), 6000);
    refresh();
  };
  const guard = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const devicesSeen = SLOTS.filter((id) => snap.devices[id]?.owner);
  const owners = Object.fromEntries(SLOTS.map((id) => [id, snap.devices[id]?.owner ?? ""]));

  return (
    <section className="card rules">
      <h3>
        Rules &amp; Actions <small>WHEN the data says X → THEN act · Sense → Store → Understand → Act</small>
      </h3>

      <Packs devices={devicesSeen} onInstalled={(c, n) => compiled(c, `${n} rules installed`)} onError={setError} />

      <div className="rules-head">
        <h4>Rules <span className="mono">{rules.filter((r) => r.enabled).length} on / {rules.length}</span></h4>
        <button className="etl-btn" onClick={() => setEditing({ kind: "live", severity: "WARNING", actions: { push: true }, metric: "noise", op: ">", value: 85 })}>
          ＋ New rule
        </button>
      </div>
      <div className="tablewrap">
        <table className="rules-table">
          <thead>
            <tr>
              <th />
              <th>Rule</th>
              <th>When → Then</th>
              <th>Devices</th>
              <th>Fired</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const d = describeRule(r);
              return (
                <tr key={r.ruleId} className={r.enabled ? "" : "off"}>
                  <td>
                    <button className={`switch ${r.enabled ? "on" : ""}`} title={r.enabled ? "Disable" : "Enable"}
                      onClick={() => guard(async () => compiled((await api.toggleRule(r.ruleId, !r.enabled)).compiled, r.enabled ? "Rule disabled" : "Rule enabled"))}>
                      <i />
                    </button>
                  </td>
                  <td>
                    <span className={`kind k-${r.kind}`}>{KIND_META[r.kind].icon} {KIND_META[r.kind].label}</span>
                    <b>{r.name}</b>
                    <small className="mono">{r.code} · {r.severity}{r.pack ? ` · pack: ${r.pack}` : ""}</small>
                  </td>
                  <td className="whenthen">
                    <span>WHEN {d.when}</span>
                    <span>THEN {d.then}</span>
                    {r.kind === "lake" && r.lastRunAt ? <small className="mono">last check {new Date(r.lastRunAt).toLocaleTimeString()}</small> : null}
                  </td>
                  <td className="mono small">{(r.devices ?? []).length ? r.devices!.map((x) => x.replace("PHONE_", "P")).join(" ") : "all"}</td>
                  <td className="mono">{r.hits ?? 0}{r.lastFiredAt ? <small>{new Date(r.lastFiredAt).toLocaleTimeString()}</small> : null}</td>
                  <td className="row-btns">
                    {r.kind === "lake" && (
                      <button title="Run this lake rule now (Athena)" onClick={() => { setRun({ rule: r, res: null }); api.runRule(r.ruleId).then((res) => setRun({ rule: r, res })).catch((e) => setRun({ rule: r, res: { error: e.message } })); }}>
                        ▶
                      </button>
                    )}
                    <button title="Edit" onClick={() => setEditing(r)}>✎</button>
                    <button title="Delete" onClick={() => confirm(`Delete rule "${r.name}"?`) && guard(async () => compiled((await api.deleteRule(r.ruleId)).compiled, "Rule deleted"))}>🗑</button>
                  </td>
                </tr>
              );
            })}
            {!rules.length && (
              <tr><td colSpan={6} className="emptyrow">No rules yet - install a use-case pack above or create one.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {run && <LakeRun run={run} onClose={() => setRun(null)} />}

      {sql && <CompiledSql sql={sql.sql} disabled={sql.disabled} />}

      <div className="rules-grid">
        <People responders={responders} owners={owners} onChanged={refresh} />
        <Escalations list={escalations} machineArn={machineArn} owners={owners} />
      </div>

      <DeviceCommand />

      <ActionLogView />

      {toast && <div className="toast">{toast}</div>}
      {error && <div className="qerr">{error}</div>}
      {editing &&
        createPortal(
          <RuleEditor
            initial={editing}
            onClose={() => setEditing(null)}
            onSaved={(c) => {
              setEditing(null);
              compiled(c, "Rule saved");
            }}
          />,
          document.body,
        )}
    </section>
  );
}

// ------------------------------------------------------------------ packs
function Packs({ devices, onInstalled, onError }: { devices: string[]; onInstalled: (c: CompileResult, n: number) => void; onError: (e: string) => void }) {
  const [target, setTarget] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState("");
  return (
    <div className="packs">
      {PACKS.map((p) => {
        const sel = target[p.key] ?? [];
        return (
          <div key={p.key} className="pack">
            <div className="pack-top">
              <span className="pack-ico">{p.icon}</span>
              <div>
                <b>{p.label}</b>
                <small>{p.who}</small>
              </div>
            </div>
            <ul>
              {p.rules.slice(0, 4).map((r) => <li key={r.name}>{r.name}</li>)}
              {p.rules.length > 4 && <li className="more">+{p.rules.length - 4} more</li>}
            </ul>
            <div className="chips">
              {SLOTS.map((id) => (
                <button key={id} className={`chip-btn ${sel.includes(id) ? "on" : ""} ${devices.includes(id) ? "" : "idle"}`}
                  onClick={() => setTarget({ ...target, [p.key]: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] })}>
                  {id.replace("PHONE_", "P")}
                </button>
              ))}
            </div>
            <button className="etl-btn" disabled={!sel.length || busy === p.key}
              onClick={async () => {
                setBusy(p.key);
                try {
                  const r = await api.installPack(p.key, p.rules, sel);
                  onInstalled(r.compiled, r.rules.length);
                } catch (e: any) {
                  onError(e.message);
                } finally {
                  setBusy("");
                }
              }}>
              {busy === p.key ? "Installing…" : `Install ${p.rules.length} rules`}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ editor
function RuleEditor({ initial, onClose, onSaved }: { initial: Partial<Rule>; onClose: () => void; onSaved: (c: CompileResult) => void }) {
  const [r, setR] = useState<Partial<Rule>>({ actions: {}, devices: [], severity: "WARNING", ...initial });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Rule>) => setR((x) => ({ ...x, ...patch }));
  const act = (patch: Partial<NonNullable<Rule["actions"]>>) => setR((x) => ({ ...x, actions: { ...(x.actions ?? {}), ...patch } }));
  const kind = (r.kind ?? "live") as RuleKind;
  const preview = describeRule({ ...(r as Rule), kind });
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.saveRule({ ...r, kind });
      onSaved(res.compiled);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  const pickKind = (k: RuleKind) => {
    const defaults: Record<RuleKind, Partial<Rule>> = {
      live: { metric: "hr", op: ">", value: 120, forSec: 0 },
      zone: { zone: "Home", when: "outside" },
      absence: { absence: "no_movement", minutes: 60 },
      lake: { template: "steps_below_baseline", param: 60, everyMin: 60 },
      alert: { alertTypes: ["FALL", "SOS"] },
    };
    set({ kind: k, ...defaults[k] });
  };
  return (
    <div className="qr-overlay" onClick={onClose}>
      <div className="rule-editor" onClick={(e) => e.stopPropagation()}>
        <h2>{r.ruleId ? "Edit rule" : "New rule"}</h2>
        <input className="re-name" placeholder="Rule name, e.g. Heart rate high" value={r.name ?? ""} onChange={(e) => set({ name: e.target.value })} />

        <label>WHEN</label>
        <div className="re-kinds">
          {(Object.keys(KIND_META) as RuleKind[]).map((k) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => pickKind(k)}>
              <span>{KIND_META[k].icon}</span>
              <b>{KIND_META[k].label}</b>
              <small>{KIND_META[k].hint}</small>
            </button>
          ))}
        </div>

        <div className="re-row">
          {kind === "live" && (
            <>
              <select value={r.metric} onChange={(e) => set({ metric: e.target.value })}>
                {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label} ({m.unit})</option>)}
              </select>
              <select value={r.op} onChange={(e) => set({ op: e.target.value as Op })}>
                {[">", "<", ">=", "<="].map((o) => <option key={o}>{o}</option>)}
              </select>
              <input type="number" value={r.value ?? 0} onChange={(e) => set({ value: Number(e.target.value) })} />
              <span>for</span>
              <input type="number" min={0} value={r.forSec ?? 0} onChange={(e) => set({ forSec: Number(e.target.value) })} />
              <span>s</span>
            </>
          )}
          {kind === "zone" && (
            <>
              <select value={r.when} onChange={(e) => set({ when: e.target.value as "outside" | "inside" })}>
                <option value="outside">leaves</option>
                <option value="inside">is inside</option>
              </select>
              <span>zone</span>
              <select value={r.zone} onChange={(e) => set({ zone: e.target.value })}>
                {["Home", "Site", "Depot"].map((z) => <option key={z}>{z}</option>)}
              </select>
              <small className="re-hint">The zone is saved from the phone: Sensor hub → Location → "Save this place as zone".</small>
            </>
          )}
          {kind === "absence" && (
            <>
              <select value={r.absence} onChange={(e) => set({ absence: e.target.value as Rule["absence"] })}>
                {ABSENCE.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
              <input type="number" min={1} value={r.minutes ?? 60} onChange={(e) => set({ minutes: Number(e.target.value) })} />
              <span>{ABSENCE.find((a) => a.key === r.absence)?.unit}</span>
            </>
          )}
          {kind === "lake" && (
            <>
              <select value={r.template} onChange={(e) => set({ template: e.target.value, param: LAKE_TEMPLATES.find((t) => t.key === e.target.value)?.def })}>
                {LAKE_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label.replace("{n}", "N")}</option>)}
              </select>
              <span>N =</span>
              <input type="number" value={r.param ?? 0} onChange={(e) => set({ param: Number(e.target.value) })} />
              <span>check every</span>
              <input type="number" min={5} value={r.everyMin ?? 60} onChange={(e) => set({ everyMin: Number(e.target.value) })} />
              <span>min</span>
            </>
          )}
          {kind === "alert" && (
            <div className="chips wrap">
              {ALERT_TYPES.map((t) => {
                const on = (r.alertTypes ?? []).includes(t.key);
                return (
                  <button key={t.key} className={`chip-btn ${on ? "on" : ""}`}
                    onClick={() => set({ alertTypes: on ? (r.alertTypes ?? []).filter((x) => x !== t.key) : [...(r.alertTypes ?? []), t.key] })}>
                    {t.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="re-row">
          <label className="inline"><input type="checkbox" checked={!!r.window} onChange={(e) => set({ window: e.target.checked ? { from: "22:00", to: "06:00" } : undefined })} /> only between</label>
          {r.window && (
            <>
              <input type="time" value={r.window.from} onChange={(e) => set({ window: { ...r.window!, from: e.target.value } })} />
              <span>and</span>
              <input type="time" value={r.window.to} onChange={(e) => set({ window: { ...r.window!, to: e.target.value } })} />
              <small className="re-hint">India time</small>
            </>
          )}
        </div>

        <label>ON DEVICES <small>(none selected = all phones)</small></label>
        <div className="chips">
          {SLOTS.map((id) => {
            const on = (r.devices ?? []).includes(id);
            return (
              <button key={id} className={`chip-btn ${on ? "on" : ""}`} onClick={() => set({ devices: on ? (r.devices ?? []).filter((x) => x !== id) : [...(r.devices ?? []), id] })}>
                {id.replace("_", " ")}
              </button>
            );
          })}
        </div>

        <label>THEN</label>
        <div className="re-actions">
          <Check on={!!r.actions?.push} set={(v) => act({ push: v })} label="📲 Push to responders" />
          <Check on={!!r.actions?.escalate} set={(v) => act({ escalate: v })} label="🪜 Escalate (Step Functions: wait for ack, then backup, then UNANSWERED)" />
          <Check on={!!r.actions?.email} set={(v) => act({ email: v })} label="✉️ Email" />
          {kind === "absence" && r.absence === "no_movement" && <Check on={!!r.actions?.askOk} set={(v) => act({ askOk: v })} label="🙋 First ask 'Are you OK?' on the phone (5 min)" />}
          <Check on={!!r.actions?.boost} set={(v) => act({ boost: v })} label="📈 Boost device sampling to 4 Hz" />
          <div className="re-msg">
            <Check on={r.actions?.message !== undefined} set={(v) => act({ message: v ? "Please check your phone" : undefined })} label="💬 Show a message on the device:" />
            {r.actions?.message !== undefined && <input value={r.actions.message} maxLength={120} onChange={(e) => act({ message: e.target.value })} />}
          </div>
        </div>

        <div className="re-row">
          <span>Severity</span>
          <select value={r.severity} onChange={(e) => set({ severity: e.target.value as Severity })}>
            {["INFO", "WARNING", "CRITICAL"].map((s) => <option key={s}>{s}</option>)}
          </select>
          <span>Cooldown</span>
          <input type="number" min={0} value={r.cooldownMin ?? 10} onChange={(e) => set({ cooldownMin: Number(e.target.value) })} />
          <span>min between notifications</span>
        </div>

        <div className="re-preview">
          <span>WHEN {preview.when}</span>
          <span>THEN {preview.then}</span>
        </div>
        {error && <div className="qerr">{error}</div>}
        <div className="re-btns">
          <button className="etl-btn" onClick={onClose}>Cancel</button>
          <button className="etl-btn primary" disabled={busy || !r.name?.trim()} onClick={save}>{busy ? "Saving…" : "Save rule"}</button>
        </div>
      </div>
    </div>
  );
}

function Check({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) {
  return (
    <label className="inline">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );
}

// ------------------------------------------------------------------ compiled SQL, lake run
function CompiledSql({ sql, disabled }: { sql: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const parts = useMemo(() => {
    const where = sql.split(" WHERE ")[1] ?? "";
    return where.split(" OR ").map((c) => c.trim());
  }, [sql]);
  const base = new Set(["fault <> 'NONE'", "health <> 'OK'", "temp > 55", "volt > 6", "bat < 10", "noise > 85", "vibPeak > 15", "seq % 5 = 0"]);
  return (
    <div className="compiled">
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} AWS IoT Rule SQL, compiled from these rules{disabled ? " (rule DISABLED by the kill switch)" : ""}
      </button>
      {open && (
        <pre className="sql">
          <span>{sql.split(" WHERE ")[0]}</span>
          {"\nWHERE "}
          {parts.map((p, i) => (
            <span key={i} className={base.has(p) ? "" : "user"}>
              {i ? "\n   OR " : ""}
              {p}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function LakeRun({ run, onClose }: { run: { rule: Rule; res: LakeRuleRun | null }; onClose: () => void }) {
  const r = run.res;
  return (
    <div className="lakerun">
      <div className="lakerun-head">
        <b>🪣 {run.rule.name}</b>
        <button className="link" onClick={onClose}>close</button>
      </div>
      {!r && <div className="qrun"><span className="spinner" /> Athena is checking the data lake…</div>}
      {r?.error && <div className="qerr">{r.error}</div>}
      {r?.skipped && <div className="qerr">{r.skipped}</div>}
      {r?.sql && (
        <>
          <div className="qstats mono">
            <span>⏱ {r.ms} ms</span>
            <span>📦 {fmtBytes(r.scannedBytes ?? 0)}</span>
            <span>{r.rows?.length ?? 0} rows → {r.hits} alert{r.hits === 1 ? "" : "s"}</span>
          </div>
          <pre className="sql">{r.sql}</pre>
          <div className="tablewrap">
            <table>
              <thead><tr>{r.columns!.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {r.rows!.map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j} className="mono">{v ?? "–"}</td>)}</tr>)}
                {!r.rows!.length && <tr><td colSpan={r.columns!.length || 1} className="emptyrow">No device matches the condition right now.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ people (responders) + pairing + demo history
function People({ responders, owners, onChanged }: { responders: ResponderLink[]; owners: Record<string, string>; onChanged: () => void }) {
  const [pair, setPair] = useState<{ deviceId: string; code: string; expiresAt: number; svg: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const startPair = async (deviceId: string) => {
    const cfg = await loadConfig();
    const r = await api.pairStart(deviceId, owners[deviceId] || deviceId);
    const url = `${cfg.webUrl ?? location.origin}/responder.html?code=${r.code}`;
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#060a14", light: "#ffffff" } });
    setPair({ deviceId, ...r, svg });
  };
  const backfill = async (deviceId: string) => {
    const owner = owners[deviceId] || prompt("Name of the person for the demo history?", "Grandma") || "Demo";
    const profile = fleet.getSnapshot().devices[deviceId]?.profile ?? "elderly";
    setBusy(deviceId);
    setMsg("");
    try {
      const r = await api.backfill(deviceId, owner, profile);
      const avg = Math.round(r.days.reduce((s, d) => s + d.steps, 0) / r.days.length);
      setMsg(`${deviceId}: ${r.days.length} days of synthetic history written to Bronze (avg ${avg.toLocaleString()} steps/day). ETL started - the 14-day baseline will be ready in ~30 s.`);
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="people">
      <h4>Who receives the actions <small>Responder app · Web Push</small></h4>
      {SLOTS.map((id) => {
        const list = responders.filter((r) => r.deviceId === id);
        return (
          <div key={id} className="people-row">
            <div>
              <b>{id.replace("_", " ")}</b>
              <small>{owners[id] || "—"}</small>
            </div>
            <div className="people-list">
              {list.map((r) => (
                <span key={r.rid} className={`person ${r.push ? "push" : ""}`} title={r.push ? "notifications on" : "notifications not enabled yet"}>
                  {r.level === 1 ? "①" : "②"} {r.name} {r.push ? "🔔" : "🔕"}
                </span>
              ))}
              {!list.length && <span className="none">no responders</span>}
            </div>
            <div className="people-btns">
              <button onClick={() => startPair(id).catch((e) => setMsg(e.message))}>Pair</button>
              <button title="Write 14 days of labelled synthetic history for baseline rules" disabled={busy === id} onClick={() => backfill(id)}>
                {busy === id ? "…" : "History"}
              </button>
            </div>
          </div>
        );
      })}
      {msg && <small className="people-msg">{msg}</small>}
      {pair &&
        createPortal(
          <div className="qr-overlay" onClick={() => { setPair(null); onChanged(); }}>
            <div className="qr-card" onClick={(e) => e.stopPropagation()}>
              <h2>Scan with the responder's phone</h2>
              <div className="qr" dangerouslySetInnerHTML={{ __html: pair.svg }} />
              <p className="mono pair-big">{pair.code.replace(/(\d{3})(\d{3})/, "$1 $2")}</p>
              <small>
                Alerts of <b>{pair.deviceId.replace("_", " ")}</b> ({owners[pair.deviceId] || "no owner yet"}) will go to that phone. Code valid 10 minutes, works once.
              </small>
              <button className="etl-btn" onClick={() => { setPair(null); onChanged(); }}>Done</button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function Escalations({ list, machineArn, owners }: { list: Escalation[]; machineArn: string; owners: Record<string, string> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const sorted = [...list].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 6);
  const region = machineArn.split(":")[3] ?? "ap-southeast-2";
  const link = (id: string) =>
    machineArn ? `https://${region}.console.aws.amazon.com/states/home?region=${region}#/v2/executions/details/${machineArn.replace(":stateMachine:", ":execution:")}:${id}` : "";
  return (
    <div className="escalations">
      <h4>Escalations <small>AWS Step Functions · callback pattern</small></h4>
      <div className="esc-steps">
        <span>① notify first contact</span>
        <i>60 s</i>
        <span>② notify everyone + email</span>
        <i>120 s</i>
        <span className="fail">UNANSWERED</span>
      </div>
      {sorted.map((e) => {
        const secs = Math.round((Date.now() - (e.startedAt ?? Date.now())) / 1000);
        return (
          <div key={e.alertId} className={`esc st-${e.status.toLowerCase()}`}>
            <b>{owners[e.deviceId] || e.deviceId}</b>
            <span>
              {e.status === "DONE" ? (e.ackBy ? `✅ ${e.ackBy} responded in ${Math.round(((e.ackAt ?? 0) - (e.startedAt ?? 0)) / 1000)} s` : "✅ resolved") : e.status === "UNANSWERED" ? "‼️ unanswered" : `⏳ level ${e.level} · ${secs}s`}
            </span>
            {link(e.alertId) && <a href={link(e.alertId)} target="_blank" rel="noreferrer">workflow ↗</a>}
          </div>
        );
      })}
      {!sorted.length && <small className="none">No escalations yet. They start when a rule with "Escalate" fires (e.g. a fall).</small>}
    </div>
  );
}

function DeviceCommand() {
  const [device, setDevice] = useState<string>(SLOTS[0]);
  const [text, setText] = useState("Please call me when you see this");
  const [sent, setSent] = useState("");
  const send = async (cmd: "MESSAGE" | "ASK_OK") => {
    try {
      await api.command(device, cmd, text);
      setSent(`${cmd === "ASK_OK" ? "Asked 'Are you OK?'" : "Message sent"} → ${device}`);
      setTimeout(() => setSent(""), 4000);
    } catch (e: any) {
      setSent(e.message);
    }
  };
  return (
    <div className="devcmd">
      <h4>Act on a device <small>cloud → device commands (MQTT)</small></h4>
      <div className="re-row">
        <select value={device} onChange={(e) => setDevice(e.target.value)}>
          {SLOTS.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
        <input value={text} maxLength={120} onChange={(e) => setText(e.target.value)} />
        <button className="etl-btn" onClick={() => send("MESSAGE")}>💬 Send message</button>
        <button className="etl-btn" onClick={() => send("ASK_OK")}>🙋 Ask "Are you OK?"</button>
      </div>
      {sent && <small className="mono">{sent}</small>}
    </div>
  );
}

function ActionLogView() {
  const snap = useFleet();
  const ICON: Record<string, string> = { push: "📲", escalate: "🪜", email: "✉️", command: "↩️", ack: "✋", unanswered: "‼️", resolved: "✅", notify: "⚡" };
  return (
    <div className="actionlog">
      <h4>Action log <small>every action is also written to the lake: bronze/actions → gold_rule_effectiveness</small></h4>
      <ul>
        {snap.actions.slice(0, 40).map((a, i) => (
          <li key={`${a.ts}-${i}`} className={`al-${a.status} al-${a.action}`}>
            <span className="ico">{ICON[a.action] ?? "•"}</span>
            <time className="mono">{new Date(a.ts).toLocaleTimeString()}</time>
            <b>{a.action}</b>
            <span className="txt">
              {a.target ? `${a.target} · ` : ""}
              {a.detail}
              {a.ruleName ? <em> · {a.ruleName}</em> : null}
            </span>
            <span className={`st st-${a.status}`}>{a.status}</span>
          </li>
        ))}
        {!snap.actions.length && <li className="none">No actions yet.</li>}
      </ul>
    </div>
  );
}

