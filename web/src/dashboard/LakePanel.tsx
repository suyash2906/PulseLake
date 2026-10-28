import { useEffect, useRef, useState } from "react";
import { api, fmtBytes, type EtlStatus, type LakeLayer, type QueryResult } from "./api";

const LAB_EXAMPLE = `SELECT id AS device, count(*) AS messages, round(avg(temp), 1) AS avg_temp
FROM bronze_telemetry
WHERE dt = date_format(current_date, '%Y-%m-%d')
GROUP BY id`;

/** Data lake: medallion layers, ETL trigger, preset Athena queries and a read-only Query Lab. */
export function LakePanel() {
  const [queries, setQueries] = useState<{ name: string; title: string; layer: string }[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [layers, setLayers] = useState<LakeLayer[]>([]);
  const [showSql, setShowSql] = useState(false);
  const [lab, setLab] = useState(false);
  const [labSql, setLabSql] = useState(LAB_EXAMPLE);
  const [etl, setEtl] = useState<EtlStatus>({ state: "NEVER_RUN" });
  const etlTimer = useRef<number>();

  const refreshLayers = () => api.lake().then((r) => setLayers(r.layers)).catch(() => {});

  useEffect(() => {
    api.queries().then(setQueries).catch((e) => setError(e.message));
    api.etlStatus().then(setEtl).catch(() => {});
    refreshLayers();
    const t = setInterval(refreshLayers, 30_000);
    return () => {
      clearInterval(t);
      clearInterval(etlTimer.current);
    };
  }, []);

  const exec = async (key: string, fn: () => Promise<QueryResult>) => {
    setSelected(key);
    setRunning(true);
    setError("");
    try {
      setResult(await fn());
    } catch (e: any) {
      setError(e.message.includes("does not exist") ? `${e.message} - run the ETL first to build Silver/Gold.` : e.message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const runEtl = async () => {
    setEtl({ state: "RUNNING", step: "starting" });
    await api.etlRun().catch((e) => setEtl({ state: "FAILED", error: e.message }));
    clearInterval(etlTimer.current);
    etlTimer.current = window.setInterval(async () => {
      const s = await api.etlStatus().catch(() => null);
      if (!s) return;
      setEtl(s);
      if (s.state !== "RUNNING") {
        clearInterval(etlTimer.current);
        refreshLayers();
      }
    }, 1500);
  };

  const bronze = layers.filter((l) => l.prefix.startsWith("bronze/"));
  const bronzeFiles = bronze.reduce((n, l) => n + l.objects, 0);
  const bronzeBytes = bronze.reduce((n, l) => n + l.bytes, 0);
  const silver = layers.find((l) => l.prefix === "silver/");
  const etlRunning = etl.state === "RUNNING";

  return (
    <section className="card lake">
      <h3>
        Data lake <small>Amazon S3 · AWS Glue Data Catalog · Amazon Athena (schema-on-read)</small>
      </h3>

      <div className={`medallion ${etlRunning ? "flowing" : ""}`}>
        <div className="zone bronze">
          <span className="tag">BRONZE</span>
          <b>Raw JSON</b>
          <small className="mono">{bronzeFiles.toLocaleString()} files · {fmtBytes(bronzeBytes)}</small>
          <small>telemetry · events · alerts · traces · actions</small>
        </div>
        <div className="pipe"><i /><i /><i /></div>
        <div className="zone silver">
          <span className="tag">SILVER</span>
          <b>Clean Parquet</b>
          <small className="mono">{silver ? `${silver.objects} files · ${fmtBytes(silver.bytes)}` : "–"}</small>
          <small>de-duplicated · validated · typed</small>
        </div>
        <div className="pipe"><i /><i /><i /></div>
        <div className="zone gold">
          <span className="tag">GOLD</span>
          <b>Athena views</b>
          <small className="mono">9 views</small>
          <small>health · noise · safety · activity · baseline · rules</small>
        </div>
        <div className="etl">
          <button className="etl-btn" disabled={etlRunning} onClick={runEtl}>
            {etlRunning ? <><span className="spinner" /> ETL running…</> : "⚙️ Run ETL  Bronze → Silver → Gold"}
          </button>
          <small className={`etl-st st-${etl.state.toLowerCase()}`}>
            {etl.state === "RUNNING" && `Step: ${etl.step}`}
            {etl.state === "SUCCEEDED" && `Last run OK in ${etl.seconds}s · ${etl.at ? new Date(etl.at).toLocaleTimeString() : ""}`}
            {etl.state === "FAILED" && `Failed: ${etl.error}`}
            {etl.state === "NEVER_RUN" && "Never run - Silver & Gold are empty"}
          </small>
        </div>
      </div>

      <div className="qbtns">
        {queries.map((q) => (
          <button key={q.name} className={selected === q.name ? "sel" : ""} disabled={running} onClick={() => exec(q.name, () => api.query(q.name))}>
            <span className={`lyr l-${q.layer}`}>{q.layer}</span>
            {q.title.replace(/^Gold · /, "")}
          </button>
        ))}
        <button className={`lab-toggle ${lab ? "sel" : ""}`} onClick={() => setLab(!lab)}>🧪 Query Lab</button>
      </div>

      {lab && (
        <div className="lab">
          <textarea className="mono" value={labSql} spellCheck={false} onChange={(e) => setLabSql(e.target.value)} rows={5} />
          <div className="lab-row">
            <small>Tables: bronze_telemetry · bronze_events · bronze_alerts · bronze_traces · bronze_actions · silver_telemetry · gold_* views. Read-only, max 200 rows, 100 MB scan cap.</small>
            <button className="etl-btn" disabled={running} onClick={() => exec("__lab__", () => api.sql(labSql))}>▶ Run SQL</button>
          </div>
        </div>
      )}

      {running && <div className="qrun"><span className="spinner" /> Athena is scanning the lake…</div>}
      {error && <div className="qerr">{error}</div>}

      {result && !running && (
        <div className="qres">
          <div className="qstats mono">
            <span>⏱ {result.stats.totalMs} ms</span>
            <span>📦 scanned {fmtBytes(result.stats.scannedBytes)}</span>
            <span>💲 ${result.stats.costUsd.toFixed(6)}</span>
            <span>{result.rows.length} rows</span>
            <button className="link" onClick={() => setShowSql(!showSql)}>{showSql ? "hide SQL" : "show SQL"}</button>
          </div>
          {showSql && <pre className="sql">{result.sql}</pre>}
          <div className="tablewrap">
            <table>
              <thead>
                <tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i} style={{ animationDelay: `${Math.min(i, 20) * 25}ms` }}>
                    {r.map((v, j) => <td key={j} className="mono">{v ?? "–"}</td>)}
                  </tr>
                ))}
                {!result.rows.length && (
                  <tr><td colSpan={result.columns.length || 1} className="emptyrow">No rows yet - telemetry reaches S3 about 60 s after it is sent.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
