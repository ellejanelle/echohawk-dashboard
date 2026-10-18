import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Frame, ReplayData } from "../shared/types";
import { createLAMap } from "../shared/laMap";
import { ordinal, span, type Cat, type Story } from "./derive";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Run an async animation script once per mount; `alive()` turns false when the chapter changes.
function useScript(fn: (alive: () => boolean) => Promise<void>) {
  useEffect(() => { let on = true; fn(() => on); return () => { on = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

function CountUp({ to, ms = 1400, start = true, className }: { to: number; ms?: number; start?: boolean; className?: string }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!start) return;
    let on = true; const t0 = performance.now();
    const step = () => { if (!on) return; const k = Math.min(1, (performance.now() - t0) / ms); setV(Math.round(to * (1 - (1 - k) ** 3))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step); return () => { on = false; };
  }, [to, ms, start]);
  return <span className={className}>{v}</span>;
}

export function Ticket({ f, cls = "" }: { f: Frame; cls?: string }) {
  return <div className={`tk ${cls}`}><span className="n">#{f.n}</span><span className="t">{f.t}</span><span className="rd">{f.rd}</span><span>{f.type}</span></div>;
}

const fmtP = (p: number) => { if (!p) return "n/a"; const e = Math.floor(Math.log10(p)); return <>{(p / 10 ** e).toFixed(1)} × 10<sup>{e}</sup></>; };

export interface Chapter { id: string; show: (S: Story) => boolean; head: (S: Story, D: ReplayData) => string; sub: (S: Story, D: ReplayData) => ReactNode; Body: (p: { S: Story; D: ReplayData; toFree: () => void }) => ReactNode }

// ---------- 1. the night in numbers ----------
function Numbers({ S }: { S: Story }) {
  const [shownL, setShownL] = useState(0), [shownR, setShownR] = useState(0), [rightOn, setRightOn] = useState(false), [rows, setRows] = useState(false);
  const order: Record<Cat, number> = { flag: 0, group: 1, machine: 2, single: 3, crime: 4 };
  const sorted = S.F.filter(S.isItem).sort((a, b) => order[S.cat(a)] - order[S.cat(b)] || a.n - b.n);
  useScript(async (alive) => {
    for (let i = 0; i <= S.F.length && alive(); i += 12) { setShownL(i); await sleep(14); }
    setShownL(S.F.length); await sleep(400); if (!alive()) return;
    setRightOn(true);
    for (let i = 0; i <= sorted.length && alive(); i += 12) { setShownR(i); await sleep(14); }
    setShownR(sorted.length); setRows(true);
  });
  return (
    <>
      <div className="col left"><h3>As it happened</h3><div><CountUp className="big bigl" to={S.F.length} /></div><div className="cap">separate tickets, one per call, read in arrival order</div>
        <div className="wall">{S.F.map((f, k) => <i key={f.n} className={`chip ${k < shownL ? "" : "hidden"}`} />)}</div></div>
      <div className="col right"><h3>With EchoHawk</h3><div><CountUp className="big bigr" to={S.items} start={rightOn} /></div><div className="cap">items after grouping, one chip per line or ticket, sorted by what it is</div>
        <div className="wall">{sorted.map((f, k) => <i key={f.n} className={`chip ${k < shownR ? S.cat(f) : "hidden"}`} />)}</div>
        <div className="legend"><span><i style={{ background: "var(--watch)" }} />flagged vs baseline</span><span><i style={{ background: "var(--ok)" }} />grouped with other calls</span><span><i style={{ background: "var(--machine)" }} />alarm, machine source</span><span><i style={{ background: "#4b5466" }} />single report, watched</span><span><i style={{ background: "var(--crime)" }} />crime, passed to dispatch</span></div>
        {rows && <div className="rows">
          {([[S.needPerson, "lines asking a person to look (people calling, hand or ask rung)"], [S.crimes.length, "crime calls passed to dispatch unchanged"], [S.machine.length, `alarm activations labeled machine, in ${S.machineLines} lines`], [S.groupedCalls, `calls grouped into ${S.grouped.length} lines`], [S.flagRDs.size, "districts flagged against their own LAPD baseline"]] as [number, string][]).map(([v, t]) => <div key={t} className="row"><b>{v}</b><span>{t}</span></div>)}
        </div>}
      </div>
    </>
  );
}

// ---------- 2. spot the pattern ----------
function Pattern({ S }: { S: Story }) {
  const b = S.burst!, inc = b.inc, fl = inc.flag!;
  const [q, setQ] = useState<Frame[]>([]), [k, setK] = useState(0), [others, setOthers] = useState(0), [flagOn, setFlagOn] = useState(false), [done, setDone] = useState(false), [hl, setHl] = useState(false);
  useScript(async (alive) => {
    for (const f of b.range) {
      if (!alive()) return;
      setQ((x) => [...x, f].slice(-11));
      if (f.incident === inc.id && b.near.includes(f)) { setK((x) => x + 1); if (f.flagged) { setFlagOn(true); await sleep(1600); } }
      else setOthers((x) => x + 1);
      await sleep(f.incident === inc.id ? 520 : 380);
    }
    if (alive()) setDone(true);
  });
  return (
    <>
      <div className="col left"><h3>As it happened · dispatch queue</h3><div className="cap">Tickets {b.range[0].n} to {b.range.at(-1)!.n}, {b.range[0].t} to {b.range.at(-1)!.t}. All look the same.</div>
        <div className="queue">{q.map((f) => <Ticket key={f.n} f={f} cls={hl && b.near.includes(f) ? "hl" : ""} />)}</div>
        {done && <button className="reveal" onClick={() => setHl(true)}>Show which ones were RD {inc.rd}</button>}</div>
      <div className="col right"><h3>With EchoHawk · supervisor board</h3>
        <div className={`scard ${flagOn ? "flagged" : ""}`}><div className="top"><span className="rdn">RD {inc.rd}</span><span className="muted">{inc.area}</span><span className="tag machine">machine source</span><span className="tag">0 independent callers</span>{flagOn && <span className="tag flag">flagged {fl.t}</span>}</div>
          <div className="count">{k}</div><div className="cap">activations in this burst · {inc.call_types.join(", ")}</div></div>
        <div className={`banner ${flagOn ? "show" : ""}`}><b>Flagged at {fl.t}</b>, ticket #{fl.ticket}, the {ordinal(b.k)} activation of this burst.<br />{fl.window_n} activations in one 15-minute window where LAPD history for RD {inc.rd} at this hour expects {fl.lambda.toFixed(3)}. Chance of that by luck: p = {fmtP(fl.p_tail)}.<br /><span className="muted">{b.near.length - b.k} more activations arrived after the flag, over the next {span(fl.t, b.lastT)}.</span></div>
        {others > 0 && <div className="cap" style={{ marginTop: 12 }}>{others} other call{others > 1 ? "s" : ""} in this stretch went to dispatch as usual.</div>}
      </div>
    </>
  );
}

// ---------- 3. machines are not people ----------
function Machines({ S }: { S: Story }) {
  const w = S.wave!, max = w.rds[0][1];
  const el = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState("");
  useEffect(() => {
    let on = true, m: Awaited<ReturnType<typeof createLAMap>> | null = null;
    createLAMap(el.current!, (t) => on && setSt(t)).then((x) => {
      m = x; if (!on) return x.destroy();
      for (const [rd, n] of w.rds) x.paint(rd, { rung: "machine", flagged: S.flagRDs.has(rd), intensity: 0.25 + Math.min(0.5, n * 0.05), label: `RD ${rd} · ${n} alarm activation(s)` });
      x.focus(w.rds.map(([rd]) => rd));
    }).catch(() => on && setSt("Map unavailable here; counts are on the right."));
    return () => { on = false; m?.destroy(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="col left"><h3>As it happened</h3><div><span className="big bigl">{w.n}</span></div><div className="cap">separate alarm tickets in {w.area}, each one read and decided on its own</div><div ref={el} className="smap" /><div className="cap small">{st}</div></div>
      <div className="col right"><h3>With EchoHawk</h3><div><span className="big" style={{ color: "var(--machine)" }}>{w.lines}</span> <span className="cap">lines, labeled machine, 0 counted as callers</span></div>
        <div className="bars">{w.rds.slice(0, 12).map(([rd, n]) => <div key={rd} className="hbar"><span>RD {rd}{S.flagRDs.has(rd) && <span className="tag flag"> flagged</span>}</span><div><div className="fill" style={{ width: `${(n / max) * 100}%` }} /></div><span className="v">{n}</span></div>)}</div>
        <div className="cap" style={{ marginTop: 14 }}>Alarm calls (radio code 906: ringers, silent alarms) are telemetry. They can trip the baseline flag and the spread check across neighboring districts, which is how a wave shows up, but they never count as independent callers.</div></div>
    </>
  );
}

// ---------- 4. two people, one event ----------
function Pair({ S }: { S: Story }) {
  const p = S.pair!, F = S.F, a = p.fs[0].n, z = p.fs.at(-1)!.n;
  const seg = F.slice(Math.max(0, a - 4), Math.min(F.length, z + 3));
  const show: (Frame | { gap: number })[] = seg.length > 16 ? [...F.slice(Math.max(0, a - 4), a + 2), { gap: z - a - 3 }, ...F.slice(z - 2, Math.min(F.length, z + 3))] : seg;
  const [q, setQ] = useState<(Frame | { gap: number })[]>([]), [cnt, setCnt] = useState(1), [on, setOn] = useState(false), [hl, setHl] = useState(false);
  useScript(async (alive) => {
    for (const f of show) {
      if (!alive()) return;
      setQ((x) => [...x, f]);
      if ("gap" in f) { await sleep(500); continue; }
      const mine = f.incident === p.inc.id;
      if (mine && f.n !== a) { await sleep(300); setCnt(p.fs.findIndex((x) => x.n === f.n) + 1); setOn(true); }
      await sleep(mine ? 900 : 420);
    }
    await sleep(600); if (alive()) setHl(true);
  });
  return (
    <>
      <div className="col left"><h3>As it happened · dispatch queue</h3><div className="cap">Two tickets, {p.between ? `${p.between} other ticket${p.between > 1 ? "s" : ""} in between` : "back to back"}. Nothing on the ticket says they are the same event.</div>
        <div className="queue">{q.map((f, k) => ("gap" in f ? <div key={`g${k}`} className="tk gap">… {f.gap} other tickets …</div> : <Ticket key={f.n} f={f} cls={hl && p.fs.includes(f) ? "hlp" : ""} />))}</div></div>
      <div className="col right"><h3>With EchoHawk · supervisor board</h3>
        <div className={`scard ${on ? "flagged" : ""}`}><div className="top"><span className="rdn">RD {p.inc.rd}</span><span className="muted">{p.inc.area}</span><span className={`pill ${on ? p.inc.rung : "watch"}`}>{on ? p.inc.rung : "watch"}</span><span className="tag ind">{on ? p.inc.independent : 1} independent caller{on ? "s" : ""}</span></div>
          <div className="count">{cnt}</div><div className="cap">{p.inc.call_types.join(", ")} · {p.fs[0].t} to {p.fs.at(-1)!.t}</div></div>
        <div className={`banner ${on ? "show" : ""}`}>Second independent caller in the same district and category. The line moves to <b>{p.inc.rung}</b>: {p.inc.reason}.</div></div>
    </>
  );
}

// ---------- 5. crimes go straight through ----------
function Crimes({ S }: { S: Story }) {
  const top = S.crimeTypes.slice(0, 10), max = top[0][1];
  return (
    <>
      <div className="col left"><h3>As it happened</h3><div><span className="big bigl">{S.crimes.length}</span></div><div className="cap">crime tickets</div>
        <div className="bars">{top.map(([t, n]) => <div key={t} className="hbar"><span>{t}</span><div><div className="fill" style={{ background: "var(--crime)", width: `${(n / max) * 100}%` }} /></div><span className="v">{n}</span></div>)}</div></div>
      <div className="col right"><h3>With EchoHawk</h3><div><span className="big bigl">{S.crimes.length}</span></div><div className="cap">crime tickets, the same number, the same order</div>
        <div className="honest" style={{ marginTop: 16, fontSize: 17 }}>A crime report is about one victim and one scene. Merging it with a neighbor's call could hide a second crime, so EchoHawk passes each one to dispatch as its own ticket, exactly as it arrived.<br /><br /><span className="muted">Call types grouped as crime here: everything that is not an alarm, injury, traffic, hazard, fire, or unknown-trouble code.</span></div></div>
    </>
  );
}

function Honest({ D, toFree }: { D: ReplayData; toFree: () => void }) {
  return (
    <div className="col" style={{ flex: 1 }}>
      <ul className="honest">
        <li><b>It shows</b> the real arrival order of {D.totals.calls} LAPD calls for service, how many separate tickets dispatch handled, and the exact moment EchoHawk would have grouped or flagged them, using the same engine that runs the live demo.</li>
        <li><b>It does not show</b> response times or outcomes. The public dataset has neither, so this replay makes no claim that anyone was helped faster.</li>
        <li><b>Flags</b> compare each district's 15-minute count with its own LAPD history for that hour of the day (Poisson tail, flag when p is under the threshold).</li>
        <li><b>Categories</b> come from mapping LAPD call-type text by radio-code family (team mapping, not LAPD's). Officer-initiated calls were removed.</li>
      </ul>
      <button className="cta" onClick={toFree}>Free play the whole night →</button>
    </div>
  );
}

export const CHAPTERS: Chapter[] = [
  { id: "numbers", show: () => true, head: (_S, D) => `${D.totals.calls} calls reached dispatch. Every one was its own ticket.`,
    sub: (_S, D) => `${String(D.fromHour).padStart(2, "0")}:00 to ${D.toHour === 24 ? "midnight" : `${String(D.toHour).padStart(2, "0")}:00`} on ${D.date}, LAPD calls for service. On the left, the night the way a dispatcher saw it. On the right, the same calls sorted by EchoHawk.`,
    Body: ({ S }) => <Numbers S={S} /> },
  { id: "pattern", show: (S) => !!S.burst, head: (S) => `RD ${S.burst!.inc.rd} rang ${S.burst!.near.length} times in ${span(S.burst!.near[0].t, S.burst!.lastT)}. EchoHawk flagged it at the ${ordinal(S.burst!.k)} ring.`,
    sub: () => "Watch the queue fill. To a dispatcher these look like any other tickets. EchoHawk stacks them into one line and checks the count against this district's own LAPD history for this hour.",
    Body: ({ S }) => <Pattern S={S} /> },
  { id: "machines", show: (S) => !!S.wave, head: (S) => `${S.machine.length} alarm activations. EchoHawk counted zero of them as people calling.`,
    sub: (S) => `${S.wave!.n} of them were in ${S.wave!.area}, across ${S.wave!.rds.length} reporting districts. EchoHawk labels every alarm as a machine source, so a wave of ringers never looks like a crowd of witnesses.`,
    Body: ({ S }) => <Machines S={S} /> },
  { id: "pair", show: (S) => !!S.pair, head: (S) => `${S.pair!.inc.independent} separate callers, ${span(S.pair!.fs[0].t, S.pair!.fs.at(-1)!.t)} apart, same district, same kind of call.`,
    sub: (S) => `In the queue, nothing on either ticket links them. EchoHawk puts them on one line with ${S.pair!.inc.independent} independent callers, and that count is what moves a line up the ladder.`,
    Body: ({ S }) => <Pair S={S} /> },
  { id: "crimes", show: (S) => S.crimes.length > 0, head: (S) => `${S.crimes.length} individual crime calls went straight through, unchanged.`,
    sub: () => "EchoHawk does not merge or delay a single report of a crime. Those stay one call, one ticket, dispatched as usual. Grouping is only for area events: alarms, injuries, hazards, fires.",
    Body: ({ S }) => <Crimes S={S} /> },
  { id: "honest", show: () => true, head: () => "What this replay shows, and what it does not.", sub: () => "", Body: ({ D, toFree }) => <Honest D={D} toFree={toFree} /> },
];
