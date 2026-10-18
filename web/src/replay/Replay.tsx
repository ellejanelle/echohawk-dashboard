import { useEffect, useMemo, useState } from "react";
import { api } from "../shared/api";
import type { ReplayData } from "../shared/types";
import { AppHeader, SUPERVISOR_TABS } from "../shared/Brand";
import { derive, hhmm } from "./derive";
import { CHAPTERS } from "./chapters";
import { FreePlay } from "./FreePlay";

export function Replay() {
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState("2025-01-07");
  const [win, setWin] = useState("15-24");
  const [D, setD] = useState<ReplayData | null>(null);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"story" | "free">("story");
  const [ch, setCh] = useState(0);

  useEffect(() => { api.replayDays().then((d) => { setDays(d); if (d.length && !d.includes(day)) setDay(d[0]); }).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const [from, to] = win.split("-").map(Number);
    setD(null); setErr(""); setCh(0);
    api.replay(day, from, to).then((d) => { if (d.error || !d.frames?.length) setErr(d.error || "No calls in this window."); else setD(d); }).catch((e) => setErr(String(e.message || e)));
  }, [day, win]);

  const S = useMemo(() => (D ? derive(D) : null), [D]);
  const live = S ? CHAPTERS.filter((c) => c.show(S)) : [];
  const c = live[Math.min(ch, live.length - 1)];
  const go = (i: number) => setCh(Math.max(0, Math.min(live.length - 1, i)));
  const next = () => (ch >= live.length - 1 ? setMode("free") : go(ch + 1));

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (mode !== "story") return; if (e.key === "ArrowRight") next(); if (e.key === "ArrowLeft") go(ch - 1); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  });

  return (
    <div className="replay">
      <AppHeader tabs={SUPERVISOR_TABS} current="replay" role="Supervisor" online
        right={<>
          <select value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day">{days.map((d) => <option key={d}>{d}</option>)}</select>
          <select value={win} onChange={(e) => setWin(e.target.value)} aria-label="Hours"><option value="15-24">3 PM to midnight</option><option value="18-22">6 PM to 10 PM</option><option value="0-24">Full day</option></select>
          <div className="seg"><button className={mode === "story" ? "on" : ""} onClick={() => setMode("story")}>Story</button><button className={mode === "free" ? "on" : ""} onClick={() => setMode("free")}>Free play</button></div>
        </>} />
      <div className="rsub">A real LA night, <span className="muted">as it happened</span> vs. <b>with EchoHawk</b></div>

      {!S || !D ? <section className="story"><div className="headline">{err || "Loading the night…"}</div></section>
        : mode === "story" && c ? (
          <section className="story">
            <div className="kicker">Chapter {ch + 1} of {live.length}</div>
            <div className="headline">{c.head(S, D)}</div>
            <p className="sub">{c.sub(S, D)}</p>
            <div className="stage" key={`${D.date}-${D.fromHour}-${c.id}`}><c.Body S={S} D={D} toFree={() => setMode("free")} /></div>
            <div className="navbar">
              <button disabled={ch === 0} onClick={() => go(ch - 1)}>← Back</button>
              <div className="dots">{live.map((_, k) => <span key={k} className={k === ch ? "on" : ""} onClick={() => go(k)} />)}</div>
              <button className="next" onClick={next}>{ch === live.length - 1 ? "Free play →" : "Next →"}</button>
              <span className="spacer" /><span className="muted small">Arrow keys work too</span>
            </div>
          </section>
        ) : <FreePlay key={`${D.date}-${D.fromHour}`} S={S} />}

      {D && <footer className="source">Source: {D.source}. {D.totals.calls} calls, {D.date}, {hhmm(D.fromHour * 3600)} to {D.toHour === 24 ? "24:00" : hhmm(D.toHour * 3600)}. Call types mapped to EchoHawk categories by radio-code family (team mapping); 906 alarm codes are machine sources. No response times or outcomes in the data, so none are claimed.</footer>}
    </div>
  );
}
