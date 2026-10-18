import { useEffect, useMemo, useState } from "react";
import { api, token } from "../shared/api";
import type { Call, Incident, Kit, Packet, Unit } from "../shared/types";
import { useEvents, useRefresher } from "../shared/sse";
import { duration, hms, useTick } from "../shared/time";
import { DeployBar, Toasts, useToasts } from "../shared/ui";
import { AppHeader, Icon, SUPERVISOR_TABS } from "../shared/Brand";
import { LiveCall } from "../shared/LiveCall";
import { UnitPill } from "../shared/Units";
import type { UnitStatus } from "../shared/types";
import { rdOf } from "../shared/laMap";
import { RUNG_LABEL, suggest, tName, trig, unitLabel, requestTitle } from "../shared/labels";
import { buildItems, type Item } from "./items";
import { FLAGS, anyoneHurt, human } from "./words";
import { langName, langNative } from "../shared/languages";

const TOK = token("dev-dispatcher");
const district = (z?: string | null) => (z && z !== "unknown" ? `Zone ${rdOf(z)}` : "Location not set");

function kitIcon(k: Kit) {
  const c = "#c2cbd8";
  if (/LIGHT/.test(k.kit_id)) return Icon.flashlight(c);
  if (/BAG/.test(k.kit_id)) return Icon.bag(c);
  return Icon.aid(c);
}

function rowColor(it: Item) {
  if (it.lane === "need") return "#e5484d";
  if (it.live) return "#3cc7b4";
  if (it.rung === "ask") return "#f2b43c";
  return "#8d9aae";
}

export function Console() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [incs, setIncs] = useState<Incident[]>([]);
  const [kits, setKits] = useState<Kit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const [flagOpen, setFlagOpen] = useState(false);
  const [sim, setSim] = useState(false);
  const [version, setVersion] = useState(0);
  const [watchdog, setWatchdog] = useState<Record<string, number>>({});
  const toasts = useToasts();
  useTick();

  const refresh = async () => {
    const [c, i, u] = await Promise.allSettled([api.calls(), api.incidents(), api.units()]);
    if (u.status === "fulfilled") setWatchdog(u.value.watchdog_s);
    if (c.status === "fulfilled" && Array.isArray(c.value)) setCalls(c.value);
    if (i.status === "fulfilled" && Array.isArray(i.value)) setIncs(i.value);
    setVersion((v) => v + 1);
  };
  const soon = useRefresher(refresh, 5000);
  const stream = useEvents(() => soon());
  useEffect(() => { api.kits().then((d) => setKits(d.kits || [])).catch(() => {}); }, []);

  // need first, then live AI calls, then the rest; newest first inside each group
  const items = useMemo(() => {
    const all = buildItems(calls, incs);
    const g = (x: Item) => (x.lane === "need" ? 0 : x.live ? 1 : x.lane === "ai" ? 2 : 3);
    return [...all].sort((a, b) => g(a) - g(b) || +new Date(b.last_at || b.start) - +new Date(a.last_at || a.start));
  }, [calls, incs]);
  const callsOnly = items.filter((x) => x.kind === "call");
  const groups: [string, Item[]][] = [["Calls", [...callsOnly].sort((a, b) => Number(b.live) - Number(a.live) || (a.lane === "need" ? 0 : 1) - (b.lane === "need" ? 0 : 1) || +new Date(b.start) - +new Date(a.start))], ["App, device and call reports", items.filter((x) => x.kind === "report")]];
  const ordered = groups.flatMap(([, l]) => l);
  const it = items.find((x) => x.id === selected) || ordered[0];
  const liveCount = items.filter((x) => x.live).length;

  useEffect(() => {
    if (!it) return;
    let alive = true;
    if (it.kind !== "call") api.incident(it.id).then((d) => alive && setPackets(d.packets || [])).catch(() => {});
    return () => { alive = false; };
  }, [it?.id, it?.kind, version]);
  useEffect(() => { setFlagOpen(false); }, [it?.id]);

  // ---------- actions ----------
  const deploy = async (x: Item, unit: Unit) => {
    if (!x.incident_id) { toasts.push("No line yet. Wait for the zone and what happened.", true); return false; }
    const r = await api.dispatch(TOK, x.incident_id, [unit]);
    r.ok ? toasts.push(`${unitLabel(unit)} sent to ${district(x.zone)}`) : toasts.push(r.data.error || "send failed", true);
    refresh(); return r.ok;
  };
  const take = async (x: Item) => {
    const r = await api.takeover(TOK, x.id);
    if (r.ok) { setJoined((s) => new Set(s).add(x.id)); toasts.push("You have the call. The caller was told a dispatcher is on the line."); } else toasts.push(r.data.error || "call is not live", true);
    refresh();
  };
  const join = async (x: Item) => {
    if (joined.has(x.id)) return;
    const r = await api.join(TOK, x.id);
    if (r.ok) { setJoined((s) => new Set(s).add(x.id)); toasts.push("Interpreter on. The AI goes quiet while you're on the line."); } else toasts.push(r.data.error || "call is not live", true);
  };
  const flag = async (x: Item, f: string) => {
    const r = await api.flag(TOK, x.id, f);
    r.ok ? toasts.push(f === "supervisor" ? "Pushed to the supervisor" : `Flagged: ${f.replace(/_/g, " ")}`) : toasts.push(r.data.error || "failed", true);
    setFlagOpen(false); refresh();
  };
  const push = async (x: Item) => {
    if (x.kind === "call") return flag(x, "supervisor");
    const r = await api.ack(TOK, x.id); r.ok ? toasts.push("Pushed to the supervisor") : toasts.push("failed", true);
  };
  const pushKit = async (k: Kit) => {
    if (!it || it.kind !== "call" || !it.live) return toasts.push("Pick a live call to send a kit card.", true);
    const r = await api.kit(TOK, it.id, k.kit_id); toasts.push(r.ok ? `${k.title} sent to the caller` : "failed", !r.ok);
  };
  const [demoCall, setDemoCall] = useState(false);
  const simulateCall = async () => {
    setDemoCall(true);
    const r = await fetch("/demo/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "spanish_water" }) }).catch(() => null);
    toasts.push(r?.ok ? "A Spanish-speaking caller is on the line. Click the call to listen in." : "Could not start the demo call", !r?.ok);
    setTimeout(() => { setDemoCall(false); refresh().then(() => setSelected(null)); }, 2500);
  };
  const simulate = async () => { setSim(true); const ok = await api.surge().catch(() => false); toasts.push(ok ? "20 scripted calls are coming in" : "simulation failed", !ok); setTimeout(() => setSim(false), 4000); };

  // keyboard: J/K move, T take, I interpreter, E/F/P/U/C send, S push
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase(), cur = ordered.findIndex((x) => x.id === it?.id);
      if (k === "j" || k === "arrowdown") { e.preventDefault(); const n = ordered[Math.min(ordered.length - 1, cur + 1)]; if (n) setSelected(n.id); return; }
      if (k === "k" || k === "arrowup") { e.preventDefault(); const n = ordered[Math.max(0, cur - 1)]; if (n) setSelected(n.id); return; }
      if (!it) return;
      const unit = ({ e: "ems", f: "fire", p: "police", u: "utility", c: "callback" } as Record<string, Unit>)[k];
      if (unit) deploy(it, unit);
      else if (k === "t" && it.kind === "call" && it.live) take(it);
      else if (k === "i" && it.kind === "call" && it.live) join(it);
      else if (k === "s") push(it);
    };
    addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey);
  });

  const live = !!it && it.kind === "call" && it.live;

  return (
    <div className="dispatch">
      <AppHeader tabs={SUPERVISOR_TABS} current="calls" role="Dispatcher" online={stream === "live"}
        right={<button className="btn-ghost simbtn" disabled={sim} onClick={simulate}>▶ Simulate calls</button>} />
      <div className="hero"><h1>Every voice, understood.</h1><span className="spacer" /><span className="keys"><kbd>J</kbd><kbd>K</kbd> move <kbd>T</kbd> take <kbd>E</kbd><kbd>F</kbd><kbd>P</kbd> send</span></div>

      <main className="dgrid">
        {/* ---------- live calls ---------- */}
        <section className="panel calls">
          <div className="ptitle">Live calls ({liveCount})<span className="spacer" /><button className="btn-ghost demo-call" disabled={demoCall} onClick={simulateCall}>{demoCall ? "Caller connecting…" : "▶ Simulate a live call"}</button></div>
          <div className="clist">
            {!items.length && <div className="empty" style={{ margin: 14 }}>No calls yet. Press ▶ Simulate a live call, or call the Retell number.</div>}
            {groups.map(([label, list]) => list.length > 0 && (
              <div key={label}>
                <div className="cgroup">{label}<span>{list.length}</span></div>
                {list.map((x) => (
                  <div key={x.id} className={`crow ${x.id === it?.id ? "on" : ""} ${x.lane === "need" ? "need" : ""}`} onClick={() => setSelected(x.id)}>
                    <span className="cic" style={{ background: x.id === it?.id && x.lane === "need" ? "#e5484d" : "transparent" }}>{Icon.phoneSolid(x.id === it?.id && x.lane === "need" ? "#fff" : rowColor(x), 20)}</span>
                    <div className="cmain">
                      <div className="cl1">{x.demo ? "Demo · " : ""}{x.source_label}{x.kind === "call" ? " · " + langName(x.language) : ""}{x.kind === "call" && x.language && x.language !== "en" && langNative(x.language) ? <span className="native"> {langNative(x.language)}</span> : null} · {district(x.zone)}</div>
                      <div className="cl2">{requestTitle(x)}{x.triggers.length > 0 && <span className="dotred" title="life-safety words heard" />}{x.flags.length > 0 && <span className="flagmark">⚑</span>}{x.dispatched.length > 0 && <span className="sentmark">✓ sent</span>}{x.kind === "call" && x.status === "transferred" && x.live && <span className="sentmark">you have it</span>}</div>
                    </div>
                    <span className="ctime">{x.live ? <span className="livedot">● {duration(x.start)}</span> : hms(x.last_at || x.start).slice(0, 5)}</span>
                    {Icon.chevron("#8d9aae")}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        {/* ---------- call with resident ---------- */}
        <section className="panel chat">
          {!it ? <div className="placeholder"><b>No call selected</b>Pick a call on the left.</div> : (
            <>
              <div className="ptitle">
                {it.demo ? "Demo call with resident" : it.kind === "call" ? "Call with resident" : it.source_label}
                <span className="spacer" />
                {live ? <span className="livetag"><i />Live · {duration(it.start)}</span> : <span className="muted small">{it.kind === "call" ? `ended · ${duration(it.start, it.end)}` : `first report ${hms(it.start).slice(0, 5)}`}</span>}
              </div>
              <div className="facts">
                <div><span>District</span><b>{it.zone && it.zone !== "unknown" ? rdOf(it.zone) : "Not set"}</b></div>
                <div><span>What</span><b>{requestTitle(it)}</b></div>
                <div><span>{it.kind === "call" ? "Language" : "Sources"}</span><b>{it.kind === "call" ? langName(it.language) : `${it.independent}${it.machine ? ` +${it.machine} alarm` : ""}`}</b></div>
                <div><span>Anyone hurt</span><b className={anyoneHurt(it) === "Yes" ? "red" : ""}>{anyoneHurt(it)}</b></div>
                <div><span>Status</span><b>{it.rung ? RUNG_LABEL[it.rung] : it.live ? "AI on the line" : "Handled"}</b></div>
              </div>
              <div className="actbar">
                {it.kind === "call" && it.live && it.status !== "transferred" && <button className="takebtn" onClick={() => take(it)}>{Icon.phoneSolid("#fff", 14)} Take the call</button>}
                {it.incident_id ? <DeployBar size="sm" dispatched={it.dispatched} suggested={it.intake_pending ? [] : suggest(it.action, it.target)} onSend={(u) => deploy(it, u)} /> : <span className="muted small">Deploy unlocks once the AI has the zone and what happened.</span>}
                <span className="spacer" />
                <button className="ghostsm" onClick={() => push(it)}>Push to supervisor</button>
                {it.kind === "call" && (
                  <span className="flagwrap">
                    <button className="ghostsm" onClick={() => setFlagOpen((f) => !f)}>⚑ Flag AI</button>
                    {flagOpen && <div className="flagmenu"><div className="lbl">Flag what the AI did</div>{FLAGS.map(([f, l]) => <button key={f} onClick={() => flag(it, f)}>{l}</button>)}</div>}
                  </span>
                )}
              </div>
              {it.incident_id && it.dispatched.length > 0 && <div className="units pad">{it.dispatched.map((d, n) => <UnitPill key={n} d={d} n={n} limit={watchdog[d.status || "assigned"]} onSet={async (k, st: UnitStatus) => { const r = await api.unitStatus(TOK, it.incident_id!, k, st); if (!r.ok) toasts.push(r.data.error || "Could not update", true); refresh(); }} />)}</div>}
              {(it.triggers.length > 0 || it.flags.length > 0 || it.dispatched.length > 0) && (
                <div className="chips pad">{it.triggers.map((t) => <span key={t} className="chip trig">⚠ heard: {trig(t)}</span>)}{it.flags.map((f) => <span key={f} className="chip flag">⚑ {f.replace(/_/g, " ")}</span>)}</div>
              )}
              {it.kind === "call" ? (
                <LiveCall call={{ id: it.id, language: it.language, live: it.live, status: it.status }} tok={TOK} version={version} joined={joined.has(it.id)}
                  onJoined={() => setJoined((s) => new Set(s).add(it.id))} onChanged={refresh} toast={toasts.push} />
              ) : (
                <div className="bubbles">
                  <div className="report">
                    <div className="rwhy">{human(it)}</div>
                    <div className="rsec">Reports on this line ({packets.length})</div>
                    {packets.map((p) => <div key={p.packet_id} className="rrow"><span>{p.source === "telemetry" ? "Alarm or sensor" : p.source === "voice" ? "Caller" : p.source}</span><span>{tName(p.target)}</span><span>severity {p.severity}</span><span className="muted">{hms(p.received_at)}</span></div>)}
                    {!packets.length && <div className="muted" style={{ paddingTop: 8 }}>No packet records found.</div>}
                    <div className="eng">Engine log: {it.reason}</div>
                    <div className="lc-hint" style={{ marginTop: 10 }}>This line was built from calls the AI already finished. Live calls you can listen to or take over are under Calls on the left.</div>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {/* ---------- action kits ---------- */}
        <section className="panel kits">
          <div className="ptitle">Action Kits</div>
          <div className="klist">
            {kits.map((k) => (
              <div key={k.kit_id} className="kcard" onClick={() => pushKit(k)} title={live ? "Send this card to the caller" : "Pick a live call to send"}>
                <span className="kic">{kitIcon(k)}</span>
                <div><b>{k.title}</b><span>{(k.display_steps && k.display_steps[0]) || k.summary || k.mode}</span>{k.medical_review === "pending" && <em>medical review pending</em>}</div>
                {Icon.chevron("#8d9aae")}
              </div>
            ))}
            {!kits.length && <div className="muted" style={{ padding: 14 }}>Loading kits…</div>}
          </div>
          {it?.kind === "call" && it.live && <button className="ghostsm" style={{ margin: 12 }} onClick={async () => { const r = await api.kit(TOK, it.id, null); toasts.push(r.ok ? "Kit closed on the resident app. Call stays connected." : "Could not close the kit", !r.ok); }}>Close caller's kit</button>}
          <div className="knote">Send instructions to the connected resident app. Pending medical kits are limited to demo calls.</div>
        </section>
      </main>
      <Toasts items={toasts.items} />
    </div>
  );
}
