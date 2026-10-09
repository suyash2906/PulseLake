import { useEffect, useRef } from "react";

/** Tiny canvas line chart with a glowing gradient fill. */
export function Sparkline(props: {
  values: number[];
  color: string;
  min?: number;
  max?: number;
  height?: number;
  threshold?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { values, color, height = 44 } = props;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    c.width = w * dpr;
    c.height = height * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, height);
    if (values.length < 2) return;
    const lo = props.min ?? Math.min(...values);
    const hi = Math.max(props.max ?? Math.max(...values), lo + 1e-6);
    const x = (i: number) => (i / (values.length - 1)) * w;
    const y = (v: number) => height - 3 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (height - 6);

    if (props.threshold !== undefined && props.threshold <= hi && props.threshold >= lo) {
      ctx.strokeStyle = "rgba(255,77,109,0.45)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y(props.threshold));
      ctx.lineTo(w, y(props.threshold));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.lineTo(w, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, color + "55");
    g.addColorStop(1, color + "00");
    ctx.fillStyle = g;
    ctx.fill();
  }, [values, color, height, props.min, props.max, props.threshold]);

  return <canvas ref={ref} style={{ width: "100%", height, display: "block" }} />;
}
