import { useEffect, useState } from "react";
import { api, type CostInfo } from "./api";

/** Header widget: real usage (AWS Budgets) against the project's phase cap. */
export function CostMeter() {
  const [c, setC] = useState<CostInfo | null>(null);
  useEffect(() => {
    const load = () => api.cost().then(setC).catch(() => {});
    load();
    const t = setInterval(load, 10 * 60_000); // Budgets itself only updates a few times a day
    return () => clearInterval(t);
  }, []);
  if (!c || c.usedUsd === undefined) return null;
  const pct = Math.min(100, (c.usedUsd / c.phaseCapUsd) * 100);
  const tone = pct > 80 ? "fail" : pct > 50 ? "warn" : "ok";
  return (
    <div
      className={`kpi cost t-${tone}`}
      title={`AWS Budgets (updates a few times a day). Plan: ${c.plan ?? "?"}. Credits left: $${c.creditsLeftUsd?.toFixed(2) ?? "?"}. Kill switch at $${c.phaseCapUsd} (${c.phase} phase).`}
    >
      <span>Credits used · {c.phase}</span>
      <b className="mono">${c.usedUsd.toFixed(2)} / ${c.phaseCapUsd}</b>
      <div className="cost-bar"><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
