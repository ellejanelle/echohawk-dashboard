import { useEffect, useMemo, useRef, useState } from "react";
import type { Frame } from "../shared/types";
import { hhmm, secs, type Story } from "./derive";
import { Ticket } from "./chapters";

interface Bucket { b: number; calls: number; person: Set<string>; flags: number }

// The whole night on a timeline: one chart, the dispatcher's queue on the left, the supervisor's lines on the right.
export function FreePlay({ S }: { S: Story }) {
  const B = useMemo<Bucket[]>(() => {
    const b0 = Math.floor(secs(S.F[0].t) / 900), b1 = Math.floor(secs(S.F.at(-1)!.t) / 900);
    const out: Bucket[] = []; for (let b = b0; b <= b1; b++) out.push({ b, calls: 0, person: new Set(), flags: 0 });
    for (const f of S.F) { const x = out[Math.floor(secs(f.t) / 900) - b0]; x.calls++; if (!f.passthrough && !f.machine && f.incident && (f.rung === "hand" || f.rung === "ask")) x.person.add(f.incident); if (f.flagged) x.flags++; }
    return out;
  }, [S]);
  const start = B[0].b * 900, end = (B.at(-1)!.b + 1) * 900;
  const [clock, setClock] = useState(start);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(300);
  const last = useRef(0);
  const svg = useRef<SVGSVGElement>(null);
  const [W, setW] = useState(1200);

  useEffect(() => { const r = () => setW(svg.current?.clientWidth || 1200); r(); addEventListener("resize", r); return () => removeEventListener("resize", r); }, []);
  useEffect(() => {
    if (!playing) return;
    let on = true; last.current = 0;
    const tick = (ts: number) => {
      if (!on) return;
      const dt = last.current ? (ts - last.current) / 1000 : 0; last.current = ts;
      setClock((c) => { const n = Math.min(end, c + dt * speed); if (n >= end) setPlaying(false); return n; });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { on = false; };
  }, [playing, speed, end]);

  const shown = S.F.filter((f) => secs(f.t) <= clock);
  const by: Record<string, { rd: string; area: string; target: string; n: number; machine: number; rung: Frame["rung"]; first: string; last: string; flagAt: string | null; reason: string }> = {};
  let crime = 0;
  for (const f of shown) {
    if (f.passthrough) { crime++; continue; }
    if (!f.incident) continue;
    const l = (by[f.incident] ||= { rd: f.rd, area: f.area, target: f.target, n: 0, machine: 0, rung: "watch", first: f.t, last: f.t, flagAt: null, reason: "" });
    l.n++; if (f.machine) l.machine++; l.rung = f.rung; l.last = f.t; l.reason = f.reason; if (f.flagged && !l.flagAt) l.flagAt = f.t;
  }
  const all = Object.values(by), order = { hand: 0, ask: 1, watch: 2 };
  const matter = all.filter((l) => l.n > 1 || l.rung !== "watch" || l.flagAt).sort((a, b) => Number(!!b.flagAt) - Number(!!a.flagAt) || order[a.rung] - order[b.rung] || b.n - a.n);

  // chart
  const H = 150, pad = 26, max = Math.max(...B.map((x) => x.calls)), bw = (W - 2 * pad) / B.length, y = (v: number) => H - 20 - (v / max) * (H - 40);
  const px = pad + ((clock - start) / 900) * bw;
  const jump = (e: React.MouseEvent) => { const r = svg.current!.getBoundingClientRect(); const k = (e.clientX - r.left - pad) / (r.width - 2 * pad); setClock(Math.max(start, Math.min(end, start + k * B.length * 900))); };

  return (
    <section className="free">
      <div className="fpbar">
        <button className="play" onClick={() => { if (clock >= end) setClock(start); setPlaying((p) => !p); }}>{playing ? "❚❚ Pause" : "▶ Play"}</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}><option value={120}>2 min per second</option><option value={300}>5 min per second</option><option value={900}>15 min per second</option></select>
        <div className="fclock">{hhmm(clock)}</div>
        <span className="muted small">Grey bars: tickets dispatch read per 15 minutes. Green: EchoHawk lines asking a person to look. Blue diamonds: baseline flags. Click the chart to jump.</span>
      </div>
      <svg ref={svg} className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onClick={jump}>
        {B.map((x, i) => { const X = pad + i * bw, past = x.b * 900 <= clock; return (
          <g key={x.b}>
            <rect x={X + 1} y={y(x.calls)} width={Math.max(1, bw - 2)} height={H - 20 - y(x.calls)} rx="2" fill={past ? "#59627a" : "#2c3240"} />
            {x.person.size > 0 && <rect x={X + bw * 0.25} y={y(x.person.size)} width={bw * 0.5} height={H - 20 - y(x.person.size)} rx="2" fill={past ? "#3ddc97" : "#1f5a44"} />}
            {x.flags > 0 && <path d={`M${X + bw / 2} ${y(x.calls) - 14} l6 6 l-6 6 l-6 -6z`} fill="#4f9dff" />}
            {x.b % 4 === 0 && <text x={X} y={H - 5} fill="#8b93a7" fontSize="11">{hhmm(x.b * 900)}</text>}
          </g>
        ); })}
        <line x1={px} x2={px} y1={6} y2={H - 18} stroke="#eef0f6" strokeWidth="2" />
        <text x={W - pad} y={16} textAnchor="end" fill="#8b93a7" fontSize="11">peak {max} tickets per 15 min</text>
      </svg>
      <div className="fpcols">
        <div className="col left"><h3>Dispatcher's view · as it happened</h3><div><span className="count2">{shown.length}</span> <span className="muted">separate tickets so far, read one at a time, newest on top</span></div>
          <div className="queue scroll">{shown.length ? shown.slice(-40).reverse().map((f) => <Ticket key={f.n} f={f} />) : <div className="muted">No calls yet.</div>}</div></div>
        <div className="col right"><h3>Supervisor's view · with EchoHawk</h3>
          <div className="muted"><span className="count2" style={{ color: "var(--ok)" }}>{matter.length}</span> lines worth a look · <b>{crime}</b> crime calls passed to dispatch unchanged · <b>{all.length - matter.length}</b> single reports watched quietly</div>
          <div className="scroll">{matter.length ? matter.map((l, k) => (
            <div key={k} className={`ln ${l.flagAt ? "flagged" : ""}`}>
              <div className="top"><span className={`pill ${l.rung}`}>{l.rung}</span><b>RD {l.rd}</b><span className="muted">{l.area}</span>{l.flagAt && <span className="tag flag">flagged {l.flagAt.slice(0, 5)}</span>}{l.machine > 0 && <span className="tag machine">{l.machine} machine</span>}</div>
              <div>{l.n} call{l.n > 1 ? "s" : ""} → 1 line · {l.target.replace("_", " ")}</div>
              <div className="why">{l.machine && l.machine === l.n ? "Alarm activations only. Not counted as people calling." : l.reason} · {l.first.slice(0, 5)} to {l.last.slice(0, 5)}</div>
            </div>
          )) : <div className="muted">Nothing grouped yet.</div>}</div></div>
      </div>
    </section>
  );
}
