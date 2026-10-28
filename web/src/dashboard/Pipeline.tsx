import { useEffect, useRef } from "react";
import { api } from "./api";
import { fleet, type MessageKind } from "./store";

// Live architecture diagram: every real message becomes a glowing particle that travels
// through the AWS services it actually passes through.

const W = 1100;
const H = 385;

interface Node {
  key: string;
  x: number;
  y: number;
  icon: string;
  title: string;
  sub: string;
  count: number;
  pulse: number;
  color: string;
}

const N = (key: string, x: number, y: number, icon: string, title: string, sub: string, color: string): Node => ({
  key, x, y, icon, title, sub, count: 0, pulse: 0, color,
});

const COLORS = {
  telemetry: "#4cc9f0",
  dashboard: "#7b61ff",
  abnormal: "#ffc23d",
  alert: "#ff4d6d",
  event: "#b388ff",
  lake: "#2ee6a6",
  push: "#ff9f43",
  command: "#f15bb5",
};

interface Particle {
  path: number[];
  seg: number;
  t: number;
  color: string;
  size: number;
}

export function Pipeline() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const nodes: Node[] = [
      N("dev", 85, 150, "📱", "IoT devices", "edge: 60 Hz → 1 msg/s", "#4cc9f0"),
      N("iot", 270, 150, "☁️", "AWS IoT Core", "MQTT broker", "#4cc9f0"),
      N("dash", 270, 42, "🖥️", "Dashboard", "live subscription", "#7b61ff"),
      N("rules", 455, 150, "🧮", "Rules Engine", "SQL on every message", "#4cc9f0"),
      N("sqs", 640, 70, "📥", "Amazon SQS", "buffer queue", "#2ee6a6"),
      N("writer", 820, 70, "λ", "Lake writer", "1 file per batch", "#2ee6a6"),
      N("s3", 1000, 70, "🪣", "S3 data lake", "Bronze → Silver → Gold", "#2ee6a6"),
      N("alert", 640, 232, "λ", "Alert processor", "rules + prediction", "#ffc23d"),
      N("ddb", 820, 232, "🗄️", "DynamoDB", "state + alerts", "#ffc23d"),
      N("sns", 1000, 232, "✉️", "Amazon SNS", "email alerts", "#ff4d6d"),
      // v3: UNDERSTAND + ACT
      N("runner", 455, 340, "⏱", "Rule runner", "absence + lake rules /min", "#2ee6a6"),
      N("act", 640, 340, "λ", "Action dispatcher", "push · commands · log", "#ff9f43"),
      N("sfn", 820, 340, "🪜", "Step Functions", "escalation workflow", "#ff9f43"),
      N("resp", 1000, 340, "📲", "Responder phones", "Web Push", "#ff9f43"),
    ];
    const idx = Object.fromEntries(nodes.map((n, i) => [n.key, i]));
    const edges = [
      ["dev", "iot"], ["iot", "dash"], ["iot", "rules"], ["rules", "sqs"], ["sqs", "writer"],
      ["writer", "s3"], ["rules", "alert"], ["alert", "ddb"], ["alert", "sns"],
      ["runner", "alert"], ["alert", "act"], ["act", "sfn"], ["sfn", "resp"], ["act", "iot"],
    ].map(([a, b]) => [idx[a], idx[b]]);
    const P = (...keys: string[]) => keys.map((k) => idx[k]);

    const particles: Particle[] = [];
    let budget = 0; // limit how many particles we draw per second (counters stay exact)
    let queued = 0;
    let lastBronze = -1;

    const spawn = (path: number[], color: string, size = 3) => {
      if (budget <= 0) return;
      budget--;
      particles.push({ path, seg: 0, t: 0, color, size });
    };

    const unsub = fleet.onMessage((kind: MessageKind) => {
      const c = (k: string) => nodes[idx[k]].count++;
      if (kind === "telemetry" || kind === "abnormal") {
        c("dev"); c("iot"); c("dash"); c("rules");
        queued++;
        nodes[idx.sqs].count = queued;
        spawn(P("dev", "iot", "rules", "sqs"), COLORS.telemetry);
        spawn(P("iot", "dash"), COLORS.dashboard, 2);
        if (kind === "abnormal") {
          c("alert");
          spawn(P("rules", "alert"), COLORS.abnormal, 4);
        }
      } else if (kind === "event" || kind === "presence") {
        c("iot"); c("rules"); c("alert");
        spawn(P("dev", "iot", "rules", "alert"), COLORS.event, 4);
      } else if (kind === "alert" || kind === "alert-critical") {
        c("ddb");
        spawn(P("alert", "ddb"), COLORS.alert, 4);
        if (kind === "alert-critical") {
          c("sns");
          spawn(P("alert", "sns"), COLORS.alert, 5);
        }
      } else if (kind === "alert-lake") {
        c("runner"); c("ddb");
        spawn(P("runner", "alert", "ddb"), COLORS.lake, 5);
      } else if (kind === "action-push") {
        c("act"); c("resp");
        spawn(P("alert", "act", "sfn", "resp"), COLORS.push, 5);
      } else if (kind === "action-escalate") {
        c("act"); c("sfn");
        spawn(P("alert", "act", "sfn"), COLORS.alert, 6);
      } else if (kind === "action-command") {
        c("act");
        spawn(P("act", "iot", "dev"), COLORS.command, 5);
      } else if (kind === "action-other") {
        c("act");
        nodes[idx.act].pulse = 1;
      }
    });

    // The lake writer flushes in batches: watch the Bronze file count and animate each flush.
    const pollLake = async () => {
      try {
        const lake = await api.lake();
        const bronze = lake.layers.find((l) => l.prefix === "bronze/telemetry/")?.objects ?? 0;
        if (lastBronze >= 0 && bronze > lastBronze) {
          const files = bronze - lastBronze;
          nodes[idx.writer].count += files;
          queued = 0;
          nodes[idx.sqs].count = 0;
          for (let i = 0; i < Math.min(6, files * 2); i++) {
            budget = Math.max(budget, 1);
            spawn(P("sqs", "writer", "s3"), COLORS.lake, 6);
          }
        }
        lastBronze = bronze;
        nodes[idx.s3].count = bronze;
      } catch {
        /* ignore */
      }
    };
    void pollLake();
    const lakeTimer = window.setInterval(pollLake, 15_000);
    const budgetTimer = window.setInterval(() => (budget = 30), 1000);

    let raf = 0;
    let last = performance.now();
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const dpr = window.devicePixelRatio || 1;
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (canvas.width !== Math.round(cw * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      const s = Math.min(cw / W, ch / H);
      const ox = (cw - W * s) / 2;
      const oy = (ch - H * s) / 2;
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      ctx.clearRect(-ox / s, -oy / s, cw / s, ch / s);

      // edges
      for (const [a, b] of edges) {
        const A = nodes[a];
        const B = nodes[b];
        const g = ctx.createLinearGradient(A.x, A.y, B.x, B.y);
        g.addColorStop(0, "rgba(120,160,255,0.10)");
        g.addColorStop(1, "rgba(120,160,255,0.28)");
        ctx.strokeStyle = g;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = -now / 40;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.t += dt * 2.6;
        if (p.t >= 1) {
          nodes[p.path[p.seg + 1]].pulse = 1;
          p.seg++;
          p.t = 0;
          if (p.seg >= p.path.length - 1) {
            particles.splice(i, 1);
            continue;
          }
        }
        const A = nodes[p.path[p.seg]];
        const B = nodes[p.path[p.seg + 1]];
        const e = p.t < 0.5 ? 2 * p.t * p.t : 1 - (-2 * p.t + 2) ** 2 / 2; // ease in-out
        const x = A.x + (B.x - A.x) * e;
        const y = A.y + (B.y - A.y) * e;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 14;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // nodes
      for (const n of nodes) {
        n.pulse = Math.max(0, n.pulse - dt * 2.5);
        const w = 150;
        const h = 58;
        const x = n.x - w / 2;
        const y = n.y - h / 2;
        ctx.shadowColor = n.color;
        ctx.shadowBlur = 6 + n.pulse * 26;
        ctx.fillStyle = `rgba(17,26,48,${0.92})`;
        roundRect(ctx, x, y, w, h, 12);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = n.pulse > 0.05 ? n.color : "rgba(120,160,255,0.25)";
        ctx.lineWidth = 1 + n.pulse * 1.5;
        ctx.stroke();
        ctx.font = "20px system-ui, 'Segoe UI Emoji'";
        ctx.textBaseline = "middle";
        ctx.fillStyle = n.icon === "λ" ? n.color : "#fff";
        ctx.fillText(n.icon, x + 10, n.y - 1);
        ctx.fillStyle = "#e8eeff";
        ctx.font = "600 13px Inter, system-ui, sans-serif";
        ctx.fillText(n.title, x + 38, n.y - 12);
        ctx.fillStyle = "#8a97b8";
        ctx.font = "10px Inter, system-ui, sans-serif";
        ctx.fillText(n.sub, x + 38, n.y + 3);
        ctx.fillStyle = n.color;
        ctx.font = "600 11px 'JetBrains Mono', Consolas, monospace";
        const label = n.key === "s3" ? `${n.count} bronze files` : n.key === "sqs" ? `${n.count} waiting` : `${n.count.toLocaleString()}`;
        ctx.fillText(label, x + 38, n.y + 17);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      unsub();
      cancelAnimationFrame(raf);
      clearInterval(lakeTimer);
      clearInterval(budgetTimer);
    };
  }, []);

  return (
    <section className="card pipeline">
      <h3>
        Live data flow <small>each dot is a real message travelling through AWS</small>
      </h3>
      <canvas ref={canvasRef} className="pipe-canvas" />
      <div className="pipe-legend">
        <span style={{ color: COLORS.telemetry }}>● telemetry</span>
        <span style={{ color: COLORS.dashboard }}>● live view</span>
        <span style={{ color: COLORS.abnormal }}>● abnormal → Lambda</span>
        <span style={{ color: COLORS.event }}>● device event</span>
        <span style={{ color: COLORS.alert }}>● alert</span>
        <span style={{ color: COLORS.lake }}>● batch written to S3</span>
        <span style={{ color: COLORS.push }}>● push to a person</span>
        <span style={{ color: COLORS.command }}>● command to a device</span>
      </div>
    </section>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
