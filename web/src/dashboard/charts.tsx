// Small SVG chart kit for the Insights / Lake Explorer tabs.
// Rules (dataviz method): one y-axis per chart, thin marks (2px lines, 4px rounded bar ends,
// 2px gaps), categorical colours in a fixed validated order, legend for >= 2 series plus direct
// end labels, recessive grid, text in ink colours (never the series colour), hover tooltips.
import { useMemo, useState, type ReactNode } from "react";

/** Validated on the dashboard surface #111a30 (dark): all checks pass. Fixed order, never cycled. */
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"];
/** Sequential blue ramp, dark surface: low values recede toward the surface. */
export const SEQ = ["#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6", "#cde2fb"];
export const STATUS = { critical: "#d03b3b", warning: "#fab219", info: "#898781" };

const INK = { primary: "#f0efec", secondary: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835" };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : Number.isInteger(v) ? String(v) : v.toFixed(1));

function Tooltip({ x, y, children }: { x: string; y: number; children: ReactNode }) {
  return (
    <div className="viz-tip" style={{ left: x, top: y }}>
      {children}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="viz-legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ line chart (change over time)
export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: (number | null)[]; // aligned with xLabels
}

export function LineChart({ xLabels, series, unit = "", height = 220 }: { xLabels: string[]; series: LineSeries[]; unit?: string; height?: number }) {
  const W = 720;
  const H = height;
  const pad = { l: 44, r: 110, t: 12, b: 26 };
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null))));
  const x = (i: number) => pad.l + (xLabels.length <= 1 ? 0 : (i / (xLabels.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const ticks = [0, max / 2, max];
  const every = Math.max(1, Math.ceil(xLabels.length / 7));
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (xLabels.length - 1));
    setHover(i >= 0 && i < xLabels.length ? i : null);
  };
  return (
    <div className="viz">
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <svg viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? INK.axis : INK.grid} strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="viz-tick">{fmt(t)}</text>
          </g>
        ))}
        {xLabels.map((l, i) => (i % every === 0 || i === xLabels.length - 1) && (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className="viz-tick">{l}</text>
        ))}
        {series.map((s) => {
          const pts = s.values.map((v, i) => (v === null ? null : [x(i), y(v)] as const));
          const d = pts.reduce((acc, p, i) => (p ? `${acc}${acc && pts[i - 1] ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}` : acc), "");
          const lastIdx = s.values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0).pop();
          return (
            <g key={s.key}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.length <= 20 && pts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r={3} fill={s.color} stroke="#111a30" strokeWidth={2} />)}
              {lastIdx !== undefined && series.length <= 4 && (
                <text x={x(lastIdx) + 8} y={y(s.values[lastIdx]!) + 4} className="viz-direct">{s.label}</text>
              )}
            </g>
          );
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke={INK.muted} strokeWidth={1} strokeDasharray="3 3" />}
        {hover !== null && series.map((s) => s.values[hover] !== null && (
          <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={5} fill={s.color} stroke="#111a30" strokeWidth={2} />
        ))}
      </svg>
      {hover !== null && (
        <Tooltip x={`${(x(hover) / W) * 100}%`} y={8}>
          <b>{xLabels[hover]}</b>
          {series.map((s) => (
            <div key={s.key}>
              <i style={{ background: s.color }} /> {s.label}: <b>{s.values[hover] === null ? "–" : `${fmt(s.values[hover]!)}${unit}`}</b>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ bar chart (magnitude per category; optional stacks that sum to a whole)
export interface BarStack {
  key: string;
  label: string;
  color: string;
  values: number[]; // aligned with categories
}

export function BarChart({ categories, stacks, unit = "", height = 220, horizontal = false }: { categories: string[]; stacks: BarStack[]; unit?: string; height?: number; horizontal?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = categories.map((_, i) => stacks.reduce((s, st) => s + (st.values[i] || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  if (horizontal) {
    const rowH = 30;
    const W = 720;
    const labelW = 250;
    const H = categories.length * rowH + 8;
    const bw = (v: number) => (v / max) * (W - labelW - 90);
    return (
      <div className="viz">
        <svg viewBox={`0 0 ${W} ${H}`} role="img">
          {categories.map((c, i) => {
            let acc = 0;
            return (
              <g key={c} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={0} y={i * rowH} width={W} height={rowH} fill={hover === i ? "rgba(255,255,255,0.03)" : "transparent"} />
                <text x={labelW - 8} y={i * rowH + 19} textAnchor="end" className="viz-label">{c}</text>
                {stacks.map((st) => {
                  const w = bw(st.values[i] || 0);
                  const r = <rect key={st.key} x={labelW + acc} y={i * rowH + 7} width={Math.max(0, w - (acc ? 2 : 0))} height={rowH - 14} rx={4} fill={st.color} />;
                  acc += w;
                  return r;
                })}
                <text x={labelW + acc + 8} y={i * rowH + 19} className="viz-value">{fmt(totals[i])}{unit}</text>
              </g>
            );
          })}
        </svg>
      </div>
    );
  }
  const W = 720;
  const H = height;
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const band = (W - pad.l - pad.r) / Math.max(1, categories.length);
  const bwid = Math.max(4, Math.min(36, band * 0.62));
  const y = (v: number) => (v / max) * (H - pad.t - pad.b);
  const every = Math.max(1, Math.ceil(categories.length / 8));
  return (
    <div className="viz">
      <Legend items={stacks.map((s) => ({ label: s.label, color: s.color }))} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={H - pad.b - y(t)} y2={H - pad.b - y(t)} stroke={t === 0 ? INK.axis : INK.grid} />
            <text x={pad.l - 6} y={H - pad.b - y(t) + 4} textAnchor="end" className="viz-tick">{fmt(t)}</text>
          </g>
        ))}
        {categories.map((c, i) => {
          const cx = pad.l + band * i + band / 2;
          let base = H - pad.b;
          return (
            <g key={c} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={cx - band / 2} y={pad.t} width={band} height={H - pad.t - pad.b} fill={hover === i ? "rgba(255,255,255,0.04)" : "transparent"} />
              {stacks.map((st, k) => {
                const h = y(st.values[i] || 0);
                if (h <= 0) return null;
                const gap = k > 0 ? 2 : 0;
                const top = base - h;
                const el = <rect key={st.key} x={cx - bwid / 2} y={top} width={bwid} height={Math.max(0, h - gap)} rx={k === stacks.length - 1 || stacks.length === 1 ? 4 : 0} fill={st.color} />;
                base = top;
                return el;
              })}
              {(i % every === 0 || i === categories.length - 1) && <text x={cx} y={H - 8} textAnchor="middle" className="viz-tick">{c}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip x={`${((pad.l + band * hover + band / 2) / W) * 100}%`} y={8}>
          <b>{categories[hover]}</b>
          {stacks.map((s) => (
            <div key={s.key}>
              <i style={{ background: s.color }} /> {s.label}: <b>{fmt(s.values[hover] || 0)}{unit}</b>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ heatmap (magnitude on two axes)
export function Heatmap({ rows, cols, value, unit = "", min, max }: { rows: string[]; cols: string[]; value: (r: string, c: string) => number | null; unit?: string; min: number; max: number }) {
  const [hover, setHover] = useState<{ r: string; c: string; v: number | null } | null>(null);
  const W = 720;
  const labelW = 84;
  const cw = (W - labelW) / cols.length;
  const ch = 22;
  const H = rows.length * ch + 24;
  const color = (v: number) => SEQ[Math.max(0, Math.min(SEQ.length - 1, Math.round(((v - min) / Math.max(1, max - min)) * (SEQ.length - 1))))];
  const cells = useMemo(() => rows.flatMap((r) => cols.map((c) => ({ r, c, v: value(r, c) }))), [rows, cols, value]);
  return (
    <div className="viz">
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {rows.map((r, i) => <text key={r} x={labelW - 8} y={i * ch + 15} textAnchor="end" className="viz-tick">{r}</text>)}
        {cols.map((c, j) => (j % 3 === 0) && <text key={c} x={labelW + j * cw + cw / 2} y={H - 6} textAnchor="middle" className="viz-tick">{c}</text>)}
        {cells.map(({ r, c, v }) => (
          <rect key={`${r}-${c}`} x={labelW + cols.indexOf(c) * cw + 1} y={rows.indexOf(r) * ch + 1} width={cw - 2} height={ch - 2} rx={3}
            fill={v === null ? "rgba(255,255,255,0.03)" : color(v)}
            onMouseEnter={() => setHover({ r, c, v })} onMouseLeave={() => setHover(null)} />
        ))}
      </svg>
      <div className="viz-scale">
        <span>{min}{unit}</span>
        <i style={{ background: `linear-gradient(90deg, ${SEQ.join(",")})` }} />
        <span>{max}{unit}</span>
        {hover && <b className="viz-hovernote">{hover.r} · {hover.c}:00 → {hover.v === null ? "no data" : `${hover.v}${unit}`}</b>}
      </div>
    </div>
  );
}
