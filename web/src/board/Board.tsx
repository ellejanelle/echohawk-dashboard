import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, token } from "../shared/api";
import type { Call, EventRow, Health, Incident, OpenCallback, Unit, ZoneWindow } from "../shared/types";
import { useEvents, useRefresher } from "../shared/sse";
import { ago, duration, hms, useTick } from "../shared/time";
import { DeployBar, Toasts, useToasts } from "../shared/ui";
import { LiveCall, langName } from "../shared/LiveCall";
import { AppHeader, Icon, SUPERVISOR_TABS } from "../shared/Brand";
import { rdOf } from "../shared/laMap";
import { isMachineOnly, plainReason, suggest, tName, trig, sourcesLabel, requestTitle, SOURCE } from "../shared/labels";
import { ZoneGrid } from "./ZoneGrid";
import { UnitPill, STATUS_LABEL, mmss } from "../shared/Units";
import type { HistoryFile, UnitRow, UnitStatus } from "../shared/types";
import { AlertComposer } from "./AlertComposer";
import { MapView, HIST_LABEL } from "./MapView";
import { describe, mergeAlert, PRIO, type Alert, type HistEntry } from "./alerts";
import { FEED_TYPES, feedLine } from "./feed";

const TOK = token("dev-supervisor");
const PRIO_LABEL = { hand: "HAND", ask: "ASK", watch: "WATCH" } as const;

// ---------- sound ----------
let audio: AudioContext | null = null;
let lastChime = 0;
function chime(level: "hand" | "ask") {
  if (!audio || Date.now() - lastChime < 1500) return;
  lastChime = Date.now();
  (level === "hand" ? [880, 660, 880] : [660, 880]).forEach((f, k) => {
    const o = audio!.createOscillator(), g = audio!.createGain(), t = audio!.currentTime + k * 0.16;
    o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(audio!.destination); o.start(t); o.stop(t + 0.15);
  });
}

// The subtitle under each report: what the people (or machines) on this line are saying, in one plain sentence.
function reportLine(i: Incident): string {
  if (i.intake_pending) return 'Awaiting details. Confirm what happened and the location.';
  if (isMachineOnly(i)) return `${i.machine_count} alarm activation${(i.machine_count || 0) > 1 ? "s" : ""}, no people calling yet.`;
  if ((i.triggers || []).length) return `Priority signal: ${(i.triggers || []).map(trig).join(", ")}.`;
  const n = i.independent_count;
  if (i.spread_linked_incident_id) return `${n > 1 ? "Multiple residents" : "A resident"} reporting it, also reported next door.`;
  return n > 1 ? `${n} separate sources reporting the same thing.` : "One report so far. Watching for more.";
}

type SortKey = "priority" | "district" | "report" | "sources";

export function Board() {
  const [inc, setInc] = useState<Incident[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [listen, setListen] = useState<string | null>(null);
  const [joinedCalls, setJoinedCalls] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);
  const [demoCall, setDemoCall] = useState(false);
  const [compose, setCompose] = useState<{ zones: string[]; hazard: string } | null>(null);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [watchdog, setWatchdog] = useState<Record<string, number>>({});
  const [dispositions, setDispositions] = useState<Record<string, string>>({});
  const toasts = useToasts();
  useTick();
  const [win, setWin] = useState<ZoneWindow[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [cbs, setCbs] = useState<OpenCallback[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [hist, setHist] = useState<HistEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [feed, setFeed] = useState<{ id: number; ts: string; where: string; text: string }[]>([]);
  const [view, setView] = useState<"map" | "zones">("map");
  const [histCat, setHistCat] = useState<string>("");
  const [history, setHistory] = useState<HistoryFile | null>(null);
  useEffect(() => { if (histCat && !history) api.history().then(setHistory).catch(() => setMapNote("History file not found on the server.")); }, [histCat, history]);
  const [mapNote, setMapNote] = useState("");
  const [pings, setPings] = useState<Record<string, number>>({});
  const [zoneSel, setZoneSel] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "priority", dir: 1 });
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [closeErr, setCloseErr] = useState<Record<string, string>>({});
  const [soundOn, setSoundOn] = useState(false);
  const [surging, setSurging] = useState(false);
  const [edge, setEdge] = useState(0);
  const trigSeen = useRef(new Set<string>());
  const incRef = useRef<Record<string, Incident>>({});

  const byId = useMemo(() => Object.fromEntries(inc.map((i) => [i.id, i])), [inc]);
  incRef.current = byId;

  const refresh = async () => {
    const [a, b, c, e, f, g] = await Promise.allSettled([api.incidents(), api.windows(), api.health(), api.callbacks(), api.calls(), api.units()]);
    if (g.status === "fulfilled") { setUnits(g.value.units); setWatchdog(g.value.watchdog_s); setDispositions(g.value.dispositions); }
    if (f.status === "fulfilled" && Array.isArray(f.value)) setCalls(f.value);
    setVersion((v) => v + 1);
    if (a.status === "fulfilled" && Array.isArray(a.value)) { setInc(a.value); incRef.current = Object.fromEntries(a.value.map((i) => [i.id, i])); }
    if (b.status === "fulfilled" && Array.isArray(b.value)) setWin(b.value);
    if (c.status === "fulfilled") setHealth(c.value);
    if (e.status === "fulfilled" && Array.isArray(e.value)) setCbs(e.value);
  };
  const soon = useRefresher(refresh, 5000);

  const raise = (key: string, patch: Omit<Partial<Alert>, "key">) => {
    if (hist.find((h) => h.key === key && h.closed)) return; // already handled, do not nag
    setAlerts((list) => {
      const { list: next, isNew } = mergeAlert(list, key, patch);
      if (isNew) { setMinimized(false); setEdge((x) => x + 1); chime(patch.level || "hand"); }
      return next;
    });
    setHist((h) => (h.find((x) => x.key === key) ? h : [{ key, at: new Date().toISOString(), closed: false }, ...h]));
  };

  const stream = useEvents(async (ev: EventRow) => {
    const p = ev.payload_json || {};
    if (ev.event_type === "incident_closed" || ev.event_type === "acknowledged_by_human") return soon();
    if (ev.event_type === "packet_created" && p.zone_id) setPings((x) => ({ ...x, [p.zone_id]: Date.now() }));
    if (ev.incident_id && !incRef.current[ev.incident_id]) await refresh();
    if (FEED_TYPES.has(ev.event_type)) {
      const k = ev.incident_id + (p.triggers || []).join();
      const dupe = ev.event_type === "trigger_fired" && trigSeen.current.has(k);
      if (ev.event_type === "trigger_fired") trigSeen.current.add(k);
      if (!dupe) { const l = feedLine(ev, incRef.current); setFeed((f) => [{ id: Math.random(), ts: ev.ts_server, where: l.where && /^Z\d\d$/.test(l.where) ? `District ${rdOf(l.where)}` : l.where, text: l.text }, ...f].slice(0, 60)); }
    }
    const i = ev.incident_id ? incRef.current[ev.incident_id] : undefined;
    if (ev.event_type === "scan_flagged" && p.zone_id && p.zone_id !== "unknown") raise("scan:" + p.zone_id, { kind: "scan", level: "ask", zones: [p.zone_id], incidentIds: Object.values(incRef.current).filter((x) => x.zone_id === p.zone_id).map((x) => x.id), scan: { n: p.n, p_tail: p.p_tail, lambda: p.lambda } });
    if (ev.event_type === "incident_spread") {
      const open = alerts.find((x) => x.kind === "spread" && x.target === p.target && (p.zones || []).some((z: string) => x.zones.includes(z)));
      raise(open ? open.key : `spread:${p.target}:${[...(p.zones || [])].sort()[0]}`, { kind: "spread", level: "hand", target: p.target, zones: p.zones, incidentIds: [ev.incident_id, p.linked_incident_id].filter(Boolean) as string[] });
    }
    if (ev.event_type === "trigger_fired" && i) raise("inc:" + i.id, { kind: "trigger", level: "hand", target: i.target, zones: [i.zone_id], incidentIds: [i.id], triggers: p.triggers || [] });
    if (ev.event_type === "rung_changed" && p.to === "hand" && i) raise("inc:" + i.id, { kind: "hand", level: "hand", target: i.target, zones: [i.zone_id], incidentIds: [i.id] });
    soon();
  });

  // ---------- derived ----------
  const now = Date.now();
  const flagged = useMemo(() => new Set(win.filter((w) => w.flagged && now - +new Date(w.window_start) < 2 * 3600e3).map((w) => w.zone_id)), [win, now]);
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const w of win) if (now - +new Date(w.window_start) < 3600e3) c[w.zone_id] = (c[w.zone_id] || 0) + w.n; return c; }, [win, now]);
  const sortedAlerts = [...alerts].sort((x, y) => PRIO[x.kind] - PRIO[y.kind] || (y.at < x.at ? -1 : 1));
  const topAlert = sortedAlerts.find((a) => a.key === expanded) || sortedAlerts[0];
  const restAlerts = sortedAlerts.filter((a) => a !== topAlert);
  const alertedZones = new Set(alerts.flatMap((a) => a.zones));
  const n = { hand: inc.filter((i) => i.rung === "hand").length, ask: inc.filter((i) => i.rung === "ask").length, watch: inc.filter((i) => i.rung === "watch").length };
  const order = { hand: 0, ask: 1, watch: 2 };
  const rows = [...inc].sort((a, b) => {
    const d = sort.k === "priority" ? order[a.rung] - order[b.rung] || b.independent_count - a.independent_count
      : sort.k === "district" ? rdOf(a.zone_id).localeCompare(rdOf(b.zone_id))
      : sort.k === "report" ? tName(a.target).localeCompare(tName(b.target))
      : b.independent_count + (b.machine_count || 0) - (a.independent_count + (a.machine_count || 0));
    return d * sort.dir;
  });
  const selInc = sel ? byId[sel] || null : null;
  const liveCalls = calls.filter((c) => !c.ended_at).sort((a, b) => +new Date(a.started_at) - +new Date(b.started_at));
  const recentCalls = calls.filter((c) => c.ended_at).sort((a, b) => +new Date(b.started_at) - +new Date(a.started_at)).slice(0, 4);
  const listenCall = listen ? calls.find((c) => c.id === listen) || null : null;
  const liveCallFor = (incId: string) => liveCalls.find((c) => c.incident_id === incId);
  const simulateCall = async () => {
    setDemoCall(true);
    const r = await fetch("/demo/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "spanish_water" }) }).catch(() => null);
    toasts.push(r?.ok ? "A Spanish-speaking caller is on the line. Open it under Live calls to listen in." : "Could not start the demo call", !r?.ok);
    setTimeout(() => { setDemoCall(false); refresh(); }, 2500);
  };

  // ---------- actions ----------
  const deploy = async (ids: string[], unit: Unit) => {
    const r = await Promise.all(ids.map((id) => api.dispatch(TOK, id, [unit], "from supervisor board")));
    await refresh();
    return r.every((x) => x.ok);
  };
  const ack = async (id: string) => { await api.ack(TOK, id); setAcked((s) => new Set(s).add(id)); };
  const closeAs = async (id: string, code: string) => {
    if (!code) return;
    const r = await api.disposition(TOK, id, code);
    if (!r.ok) setCloseErr((e) => ({ ...e, [id]: r.data.error || "Could not close" }));
    else { setSel(null); toasts.push(code === "unable_to_locate" ? "Closed. A callback to the caller is scheduled (silence panel)." : `Closed: ${dispositions[code]}`); }
    refresh();
  };
  const addStop = async (incId: string, unitN: number, targetId: string) => { const r = await api.addStop(TOK, incId, unitN, targetId); if (!r.ok) toasts.push(r.data.error || "Could not add the stop", true); else toasts.push("Stop added. The same crew covers both."); refresh(); };
  const relayDemo = async () => { await api.relayDemo(); toasts.push("A phone chirped an SOS. Three pole nodes heard it; it counts once."); refresh(); };
  const setUnit = async (incId: string, unitN: number, status: UnitStatus) => { const r = await api.unitStatus(TOK, incId, unitN, status); if (!r.ok) toasts.push(r.data.error || "Could not update", true); refresh(); };
  const closeAlert = (key: string, how: "dismissed" | "acknowledged") => {
    const a = alerts.find((x) => x.key === key);
    setAlerts((l) => l.filter((x) => x.key !== key));
    setHist((h) => h.map((x) => (x.key === key ? { ...x, closed: how, snap: a } : x)));
    if (expanded === key) setExpanded(null);
  };
  const ackAlert = async (a: Alert) => { await Promise.allSettled(a.incidentIds.map(ack)); closeAlert(a.key, "acknowledged"); refresh(); };
  const reopen = (key: string) => { const h = hist.find((x) => x.key === key); if (!h?.snap) return; setHist((l) => l.map((x) => (x.key === key ? { ...x, closed: false } : x))); setAlerts((l) => [h.snap!, ...l]); setExpanded(key); setMinimized(false); };
  const showOnMap = (a: Alert) => {
    setMinimized(true);
    if (a.incidentIds[0]) setSel(a.incidentIds[0]);
    setZoneSel(new Set(a.zones)); setPings((p) => ({ ...p, ...Object.fromEntries(a.zones.map((z) => [z, Date.now()])) }));
    setTimeout(() => setZoneSel(new Set()), 2500);
    document.querySelector(".mappanel")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const [armReset, setArmReset] = useState(false);
  const resetDemo = async () => {
    if (!armReset) { setArmReset(true); setTimeout(() => setArmReset(false), 4000); return; }
    setArmReset(false);
    const r = await api.resetDemo(TOK);
    if (!r.ok) toasts.push(r.data.error || "Could not reset", true); else location.reload();
  };
  const surge = async () => { setSurging(true); await api.surge().catch(() => false); setTimeout(() => setSurging(false), 5000); };
  const armSound = () => { if (!audio) { try { audio = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(); setSoundOn(true); } catch { /* no audio */ } } };
  const sortBy = (k: SortKey) => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : 1 }));
  const CH: Record<string, string> = { ble: "Bluetooth", sound: "sound", radio: "radio", wifi: "Wi-Fi" };
  const Th = ({ k, children }: { k: SortKey; children: string }) => <th onClick={() => sortBy(k)} className="sortable">{children} <span className={`sorti ${sort.k === k ? "on" : ""}`}>{sort.k === k && sort.dir === -1 ? "▾" : "▴"}</span></th>;

  return (
    <div className="overview" onPointerDown={armSound}>
      <div key={edge} className={edge ? "edge go" : "edge"} />
      <AppHeader tabs={SUPERVISOR_TABS} current="overview" role="Supervisor" online={stream === "live"}
        right={<>
          <button className="bellbtn" title={soundOn ? "Alert sound on" : "Click anywhere to turn on alert sound"} onClick={() => setMinimized(false)}>{Icon.bell(alerts.length ? "#f2b43c" : "#8d9aae")}{alerts.length > 0 && <span className="n">{alerts.length}</span>}</button>
          <button className="btn-ghost pubbtn" onClick={() => setCompose({ zones: [], hazard: "" })}>📣 Public alert</button>
          <button className={`btn-ghost resetbtn ${armReset ? "armed" : ""}`} onClick={resetDemo} title="Clear calls, reports, units and alerts for a fresh demo">{armReset ? "Click again to clear everything" : "↺ Reset demo"}</button>
          <button className="btn-ghost surgebtn" disabled={surging} onClick={surge}>{surging ? "Demo running…" : "▶ Run demo surge"}</button>
        </>} />

      <div className="alerts">
        {minimized && alerts.length > 0 ? (
          <div className="more" onClick={() => setMinimized(false)}>{alerts.length} alert{alerts.length > 1 ? "s" : ""} open · show</div>
        ) : (
          <>
            {topAlert && (() => {
              const d = describe(topAlert, byId);
              const ids = d.incs.map((i) => i.id);
              const title = d.title.replace(/\bZ(\d\d)\b/g, (z) => `District ${rdOf(z)}`);
              return (
                <div className={`alert ${d.cls}`}>
                  <div className="ah"><span className="kind">{d.kind}</span><time>{hms(topAlert.at)}</time></div>
                  <div className="title">{title}</div>
                  <div className="ev">{d.ev.map((e, k) => <span key={k}>{e}</span>)}</div>
                  {d.hint && <div className="hint">{d.hint}</div>}
                  <div className="acts">
                    {d.incs.length > 0 && <DeployBar size="sm" withCallback={false} dispatched={d.incs.flatMap((i) => i.dispatched || [])} suggested={[...new Set(d.incs.flatMap((i) => i.intake_pending ? [] : suggest(undefined, i.target)))]} onSend={(u) => deploy(ids, u)} />}
                    <span className="right">
                      <button onClick={() => showOnMap(topAlert)}>Show on map</button>
                      <button onClick={() => setMinimized(true)}>Minimize</button>
                      {d.incs.length > 0 && <button onClick={() => ackAlert(topAlert)}>Acknowledge</button>}
                      <button onClick={() => closeAlert(topAlert.key, "dismissed")}>Dismiss</button>
                    </span>
                  </div>
                </div>
              );
            })()}
            {restAlerts.slice(0, 2).map((a) => { const d = describe(a, byId); return (
              <div key={a.key} className={`bar ${d.cls}`} onClick={() => setExpanded(a.key)}><span className="kind">{d.kind}</span><span className="bt">{d.title.replace(/\bZ(\d\d)\b/g, (z) => `District ${rdOf(z)}`)}</span><span className="go">open</span></div>
            ); })}
          </>
        )}
      </div>

      <div className="hero"><h1>A clearer picture. A faster decision.</h1></div>

      <div className="statrow">
        <div className="stat"><span className="si">{Icon.person("#e5484d")}</span><div><span>Needs a person</span><b>{String(n.hand).padStart(2, "0")}</b></div></div>
        <div className="stat"><span className="si">{Icon.clipboard("#f2b43c")}</span><div><span>Verify</span><b>{String(n.ask).padStart(2, "0")}</b></div></div>
        <div className="stat"><span className="si">{Icon.eye("#4c9cf0")}</span><div><span>Watching</span><b>{String(n.watch).padStart(2, "0")}</b></div></div>
        <div className="stat clickable" onClick={() => { if (liveCalls[0]) setListen(liveCalls[0].id); else document.getElementById("livecalls")?.scrollIntoView({ behavior: "smooth", block: "center" }); }} title="Open requests include calls, app requests and device reports"><span className="si">{Icon.phone("#3cc7b4")}</span><div><span>Open requests</span><b>{String(health?.requests_open ?? 0).padStart(2, "0")}</b></div></div>
      </div>

      <div className="split">
        <section className="panel incpanel">
          <div className="ptitle">Current incidents<span className="spacer" />{inc.length > 0 && <span className="muted small">{inc.reduce((a, i) => a + i.packet_ids.length, 0)} requests → {inc.length} incidents</span>}</div>
          <table className="inctable">
            <thead><tr><Th k="priority">Priority</Th><Th k="district">District</Th><Th k="report">Report</Th><Th k="sources">Sources</Th><th /></tr></thead>
            <tbody>
              {rows.map((i) => {
                const mo = isMachineOnly(i), open = sel === i.id;
                return (
                  <Fragment key={i.id}>
                  <tr className={open ? "on" : ""} onClick={() => setSel(open ? null : i.id)} aria-expanded={open}>
                    <td><span className={`prio ${mo ? "machine" : i.rung}`}>{mo ? "ALARM" : PRIO_LABEL[i.rung]}</span></td>
                    <td className="dist">{i.zone_id === "unknown" ? "Not set" : rdOf(i.zone_id)}</td>
                    <td><div className="rt">{requestTitle(i)}{i.spread_linked_incident_id && <span className="mini spread">spreading</span>}{flagged.has(i.zone_id) && <span className="mini flag">unusual volume</span>}{(i.dispatched || []).length > 0 && <span className="mini sent">units sent</span>}</div><div className="rs">{reportLine(i)}</div><div className="rs">{sourcesLabel(i.source_counts)}</div></td>
                    <td className="src">{i.independent_count}{i.machine_count ? <span className="muted small"> +{i.machine_count} alarm</span> : null}</td>
                    <td className="chev" title={open ? "Hide details" : "Show details and send help"}><span className={`chevi ${open ? "open" : ""}`}>{Icon.chevron(open ? "#3cc7b4" : "#8d9aae")}</span></td>
                  </tr>
                  {open && selInc && (
                    <tr className="exprow"><td colSpan={5}>
                      <div className="drawer">
                  <div className="dtop"><span className="muted small">First report {ago(selInc.first_report_at)} ago{selInc.zone_id !== rdOf(selInc.zone_id) ? ` · demo zone ${selInc.zone_id}` : ""}</span></div>
                  <div className="dstats"><span><b>{selInc.packet_ids.length}</b> requests → <b>1</b> incident</span><span><b>{selInc.independent_count}</b> independent</span>{!!selInc.machine_count && <span><b>{selInc.machine_count}</b> machine</span>}<span>confidence* <b>{Number(selInc.score).toFixed(2)}</b>{selInc.trend === "rising" ? " ↑" : ""}</span></div>
                  <div className="why">{closeErr[selInc.id] || (isMachineOnly(selInc) ? "Only alarm activations so far. Likely one cause (power or wind), not separate emergencies. Confirm one address first." : plainReason(selInc.last_reason))}</div>
                  {!!selInc.heard_by?.length && <div className="relayline">📡 {selInc.picked_up ? `Picked up by ${selInc.picked_up.node} over ${CH[selInc.picked_up.channel] || selInc.picked_up.channel} at ${hms(selInc.picked_up.at)}${selInc.delivered_at ? ", receipt sent back to the sender" : ""}. ` : ""}Heard by {selInc.heard_by.length} node{selInc.heard_by.length > 1 ? "s" : ""} ({selInc.heard_by.join(", ")}), counted once.{selInc.approx_area ? ` Came from within about ${selInc.approx_area.radius_m} m of those poles (circle on the map). Simulated node positions.` : ""}</div>}
                  {!!selInc.self_reported_held && <div className="relayline held">⚖ {selInc.triage_note}. The app cannot set its own priority.</div>}
                  <div className="chips">{(selInc.triggers || []).map((t) => <span key={t} className="chip trig">heard: {trig(t)}</span>)}{acked.has(selInc.id) && <span className="chip">seen by supervisor</span>}</div>
                  {(selInc.dispatched || []).length > 0 && <div className="units">{(selInc.dispatched || []).map((d, unitN) => <UnitPill key={unitN} d={d} n={unitN} limit={watchdog[d.status || "assigned"]} onSet={(k, st) => setUnit(selInc.id, k, st)} />)}</div>}
                  <div className="dacts">
                    <DeployBar withCallback={false} dispatched={selInc.dispatched} suggested={selInc.intake_pending ? [] : suggest(undefined, selInc.target)} onSend={(u) => deploy([selInc.id], u)} />
                    <span className="spacer" />
                    <button className="pubbtn" onClick={() => setCompose({ zones: [selInc.zone_id], hazard: tName(selInc.target) })}>📣 Alert residents</button>
                {liveCallFor(selInc.id) && <button className="listenbtn" onClick={() => setListen(liveCallFor(selInc.id)!.id)}>{Icon.phone("#3cc7b4", 14)} Listen to the live call</button>}
                <button onClick={() => ack(selInc.id)} disabled={acked.has(selInc.id)}>{acked.has(selInc.id) ? "Seen" : "Mark seen"}</button>
                    <select className="closeas" value="" onChange={(e) => closeAs(selInc.id, e.target.value)}><option value="">Close as…</option>{Object.entries(dispositions).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  </div>
                </div>
                    </td></tr>
                  )}
                  </Fragment>
                );
              })}
              {!inc.length && <tr><td colSpan={5}><div className="empty">All quiet. Press <b>Run demo surge</b> to play the 20-call stage script, or place a real call.</div></td></tr>}
            </tbody>
          </table>
        </section>

        <section className="panel mappanel">
          <div className="maphead">
            <span className="maptitle">Los Angeles</span>
            <div className="tabs"><button className={view === "map" ? "on" : ""} onClick={() => setView("map")}>Map</button><button className={view === "zones" ? "on" : ""} onClick={() => setView("zones")}>Zones</button></div>
            {view === "map" && <select className="histsel" value={histCat} onChange={(e) => setHistCat(e.target.value)} title="Shade districts by past calls of one type">
              <option value="">History: off</option>
              {Object.entries(HIST_LABEL).map(([k, v]) => <option key={k} value={k}>History: {v}</option>)}
            </select>}
          </div>
          {view === "map" ? (
            <div className="mapwrap">
              <MapView incidents={inc} flagged={flagged} counts={counts} selected={selInc} onStatus={setMapNote} history={history} histCat={histCat || null} />
              <div className="maplegend"><span><i style={{ background: "var(--hand)" }} />Needs a person</span><span><i style={{ background: "var(--ask)" }} />Verify</span><span><i style={{ background: "var(--watch)" }} />Watching</span><span><i style={{ background: "var(--machine)" }} />Alarms only</span><span><i className="ring" />District boundary</span>{histCat && <span><i style={{ background: "#ff8a3d" }} />Past {HIST_LABEL[histCat]} calls</span>}</div>
            </div>
          ) : (
            <div className="zonewrap"><ZoneGrid incidents={inc} byId={byId} flagged={flagged} counts={counts} pings={pings} alerted={alertedZones} selected={zoneSel} /></div>
          )}
          <div className="mapnote">{view === "map" ? (histCat && history ? `History: dispatched LAPD calls coded as ${HIST_LABEL[histCat]}, ${history.days} days ${history.from} to ${history.to} (fire week excluded). Calls, not confirmed crimes. ` : "") + `LAPD reporting districts, City of LA GIS. ${mapNote}` : "Demo zones Z01 to Z16 for the stage. They sit on West LA districts 0801 to 0834 on the map."}</div>
        </section>
      </div>

      <div className="activity">
        <span className="alabel">{Icon.clock("#c2cbd8")} Recent activity</span>
        <div className="aitems">
          {!feed.length && <span className="muted">Waiting for calls.</span>}
          {feed.slice(0, 4).map((f) => <span key={f.id} className="aitem"><time>{hms(f.ts || new Date().toISOString()).slice(0, 5)}</time>{f.where ? `${f.where} · ` : ""}{f.text}</span>)}
        </div>
        <span className="disclaim">Confidence scores are heuristics, not final determinations. Alarms never count as callers.</span>
        <span title="Confidence is 1 - p^n over independent callers, not a calibrated probability.">{Icon.info("#8d9aae")}</span>
      </div>

      <div className="lower three">
        <section className="panel" id="livecalls"><div className="ptitle">Live calls<span className="livecount">{liveCalls.length}</span><span className="spacer" /><button className="btn-ghost demo-call" onClick={relayDemo} title="A phone in airplane mode chirps an SOS near three pole nodes">📡 Chirp relay</button><button className="btn-ghost demo-call" disabled={demoCall} onClick={simulateCall}>{demoCall ? "Connecting…" : "▶ Simulate a live call"}</button></div>
          <div className="lcl">
            {!liveCalls.length && <div className="muted lcempty">No one on the line right now. Calls appear here the moment Retell connects them.</div>}
            {liveCalls.map((c) => (
              <div key={c.id} className="lcrow" onClick={() => setListen(c.id)}>
                <span className="lcdot" />
                <div className="lcm"><b>{langName(c.language)} · {c.zone_id && c.zone_id !== "unknown" ? `District ${rdOf(c.zone_id)}` : "zone not given yet"}</b><span>{(c.last_turns || []).filter((t) => t.role === "user").slice(-1)[0]?.text || "AI is answering…"}</span></div>
                <span className="lct">{duration(c.started_at)}</span>
                <button className="listenbtn" onClick={(e) => { e.stopPropagation(); setListen(c.id); }}>{Icon.phone("#3cc7b4", 14)} Listen</button>
              </div>
            ))}
            {recentCalls.length > 0 && <div className="lcsub">Ended</div>}
            {recentCalls.map((c) => (
              <div key={c.id} className="lcrow ended" onClick={() => setListen(c.id)}>
                <span className="lcdot off" />
                <div className="lcm"><b>{langName(c.language)} · {c.zone_id && c.zone_id !== "unknown" ? `District ${rdOf(c.zone_id)}` : "no zone"}</b><span>{SOURCE[c.source || "voice"]} · {requestTitle(c)}{c.status === "transferred" ? " · handed to a dispatcher" : ""}</span></div>
                <span className="lct">{hms(c.started_at).slice(0, 5)}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel" id="units"><div className="ptitle">Units in the field<span className="livecount">{units.length}</span>{units.some((u) => u.overdue) && <span className="overcount">{units.filter((u) => u.overdue).length} overdue</span>}</div>
          <div className="lcl">
            {!units.length && <div className="muted lcempty">No units out. Units appear here when someone taps Send. A unit already out is offered nearby calls it can also cover.</div>}
            {units.map((u) => (
              <div key={u.incident_id + u.n} className={`urow ${u.overdue ? "over" : ""}`} onClick={() => setSel(u.incident_id)}>
                <b>{u.unit.toUpperCase()}</b>
                <div className="lcm"><b>District {rdOf(u.zone_id)} · {tName(u.target)}{u.shared_from ? " · added stop" : ""}</b><span>{STATUS_LABEL[u.status]} for {mmss(u.seconds)}{u.limit_s ? ` · check at ${mmss(u.limit_s)}` : ""}{u.overdue ? " · OVERDUE, check on this unit" : ""}</span>
                  {!!u.nearby?.length && <span className="nearby" onClick={(e) => e.stopPropagation()}>Also nearby: {u.nearby.map((x) => <button key={x.incident_id} title={`${x.independent_count} source(s), ${x.where}`} onClick={() => addStop(u.incident_id, u.n, x.incident_id)}>+ {tName(x.target)}, District {rdOf(x.zone_id)}</button>)}</span>}</div>
                <span className="unext" onClick={(e) => e.stopPropagation()}>{u.next.filter((x) => x !== "cancelled").map((x) => <button key={x} onClick={() => setUnit(u.incident_id, u.n, x)}>{STATUS_LABEL[x]}</button>)}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel"><div className="ptitle">Alert history</div>
          <div className="feed">
            {!hist.length && <div className="muted">No alerts yet.</div>}
            {hist.map((h) => { const a = alerts.find((x) => x.key === h.key) || h.snap; if (!a) return null; const d = describe(a, byId); return (
              <div key={h.key}><time>{hms(h.at).slice(0, 5)}</time><span className="k" style={{ background: d.cls === "violet" ? "var(--machine)" : d.cls === "amber" ? "var(--ask)" : "var(--hand)" }} /><span>{d.title.replace(/\bZ(\d\d)\b/g, (z) => `District ${rdOf(z)}`)}</span><span className="st">{h.closed ? h.closed : <a href="#" onClick={(e) => { e.preventDefault(); reopen(h.key); }}>open</a>}</span></div>
            ); })}
          </div>
        </section>
        <section className="panel"><div className="ptitle">Silence panel · callbacks nobody answered</div>
          <div className="feed">
            {!cbs.length && <div className="muted">No open callbacks.</div>}
            {cbs.map((c, k) => <div key={k}><span className="k" style={{ background: "var(--ask)" }} /><span><b>District {rdOf(c.zone_id || "")}</b> · {tName(c.target)} · {c.attempts} attempt{c.attempts === 1 ? "" : "s"}, last: {c.last_result}{c.minutes_since_first_report != null ? ` · ${c.minutes_since_first_report} min since first report` : ""}</span></div>)}
          </div>
        </section>
      </div>
      {listenCall && (
        <div className="slideover" onClick={() => setListen(null)}>
          <div className="sopanel" onClick={(e) => e.stopPropagation()}>
            <div className="sohead">
              <div><b>{langName(listenCall.language)} caller · {listenCall.zone_id && listenCall.zone_id !== "unknown" ? `District ${rdOf(listenCall.zone_id)}` : "zone not given yet"}</b>
                <span>{tName(listenCall.target)}{listenCall.rung ? ` · ${listenCall.rung === "hand" ? "needs a person" : listenCall.rung === "ask" ? "verify" : "watching"}` : ""}</span></div>
              <span className="spacer" />
              {!listenCall.ended_at ? <span className="livetag"><i />Live · {duration(listenCall.started_at)}</span> : <span className="muted small">ended · {duration(listenCall.started_at, listenCall.ended_at)}</span>}
              <button className="x" onClick={() => setListen(null)}>✕</button>
            </div>
            {listenCall.incident_id && byId[listenCall.incident_id] && (
              <div className="soacts"><DeployBar size="sm" withCallback={false} dispatched={byId[listenCall.incident_id].dispatched} suggested={suggest(listenCall.action, listenCall.target)} onSend={(u) => deploy([listenCall.incident_id!], u)} /></div>
            )}
            <LiveCall call={{ id: listenCall.id, language: listenCall.language, live: !listenCall.ended_at, status: listenCall.status }} tok={TOK} version={version} joined={joinedCalls.has(listenCall.id)}
              onJoined={() => setJoinedCalls((s) => new Set(s).add(listenCall.id))} onChanged={refresh} toast={toasts.push} showTakeover />
          </div>
        </div>
      )}
      {compose && <AlertComposer tok={TOK} initialZones={compose.zones} initialHazard={compose.hazard} onClose={() => setCompose(null)} toast={toasts.push} />}
      <Toasts items={toasts.items} />
    </div>
  );
}
