import { useEffect, useRef, useState } from "react";
import { Logo } from "../shared/Brand";
import { LANGUAGES, langName } from "../shared/languages";
import { rdOf } from "../shared/laMap";
import { chirp, listen, signFrame, speak, verifyFrame, readAck, sendBle, bleAvailable, ACK_LABEL, type Verified } from "./frame";

// ---------- device storage (try/catch: private mode and some webviews throw) ----------
const S = <T,>(k: string, v?: T): T | null => { try { if (v !== undefined) localStorage.setItem(k, JSON.stringify(v)); const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch { return v ?? null; } };
interface Me { zone: string; lang: string; dependent: "no" | "yes"; contact: string; line: string }
const DEFAULT_ME: Me = { zone: "", lang: "en", dependent: "no", contact: "", line: "" };
const deviceId = S<string>("device_id") || S("device_id", "app-" + Math.random().toString(36).slice(2, 10))!;
interface Alert { id: string; kind: string; label: string; zones: string[]; sent_at: string; agency: string; text: string; language: string; machine_translated: boolean }
interface Update { incident_id: string; zone_id: string; target: string; units: { unit: string; status: string; at: string }[]; disposition: string | null; message: string; updated_at: string }
interface Kit { kit_id: string; title: string; mode: string; medical_review: string; requires_human?: boolean; display_steps?: string[]; display_steps_es?: string[]; script_lines?: string[]; authority?: string; reference_url?: string; last_source_check?: string }
type View = "home" | "checkin" | "kits" | "beacon" | "me";

// Zone the user types: "Z06", "6", "0812" all work; the server's zones are Z01..Z16 on the demo grid or real districts.
const normZone = (z: string) => { const t = z.trim().toUpperCase(); const m = t.match(/^Z?0?(\d{1,2})$/); if (m && +m[1] >= 1 && +m[1] <= 16) return `Z${m[1].padStart(2, "0")}`; const rd = t.match(/^(?:RD\s*)?(\d{3,4})$/); return rd ? rd[1].padStart(4, "0") : t; };
const DEMO: Record<string, string> = { "0801": "Z01", "0802": "Z02", "0803": "Z03", "0804": "Z04", "0811": "Z05", "0812": "Z06", "0813": "Z07", "0814": "Z08", "0821": "Z09", "0822": "Z10", "0823": "Z11", "0824": "Z12", "0831": "Z13", "0832": "Z14", "0833": "Z15", "0834": "Z16" };
const serverZone = (z: string) => DEMO[z] || z;
const TARGET_NAME: Record<string, string> = { power: "Power out", water: "Water pressure", gas: "Gas smell", power_line: "Downed power line", structure_fire: "Building fire", wildfire: "Brush fire", flood: "Flooding", road: "Road blocked", person: "Person needs help", unknown: "Something else" };
const KIND_CLS: Record<string, string> = { evacuation_order: "red", evacuation_warning: "amber", shelter_in_place: "amber", advisory: "blue", all_clear: "green" };

export function App() {
  const [view, setView] = useState<View>("home");
  const [me, setMeState] = useState<Me>({ ...DEFAULT_ME, ...(S<Me>("me") || {}) });
  const [online, setOnline] = useState(navigator.onLine);
  const [alerts, setAlerts] = useState<Alert[]>(S<Alert[]>("alerts") || []);
  const [replied, setReplied] = useState<Record<string, string>>(S("alert_replies") || {});
  const [chirpMsg, setChirpMsg] = useState<{ ok: boolean; title: string; body: string } | null>(null);
  const [updates, setUpdates] = useState<Update[]>(S<Update[]>("updates") || []);
  useEffect(() => {
    if (!me.zone) return;
    let alive = true;
    const pull = () => fetch(`/my/updates?device=${encodeURIComponent(deviceId)}&zone=${encodeURIComponent(serverZone(me.zone))}`).then((r) => r.json()).then((u: Update[]) => { if (alive) { setUpdates(u); S("updates", u); } }).catch(() => {});
    pull(); const t = setInterval(pull, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [me.zone]);
  const saveMe = (m: Me) => { setMeState(m); S("me", m); };

  useEffect(() => { const up = () => setOnline(true), down = () => setOnline(false); addEventListener("online", up); addEventListener("offline", down); return () => { removeEventListener("online", up); removeEventListener("offline", down); }; }, []);
  useEffect(() => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {}); }, []);

  // alerts for my zone in my language; last known set stays on the phone for when the network drops
  const spoken = useRef(new Set<string>(S<string[]>("alerts_spoken") || []));
  useEffect(() => {
    if (!me.zone) return;
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch(`/broadcasts/active?zone=${encodeURIComponent(serverZone(me.zone))}&lang=${me.lang}`);
        if (!r.ok || !alive) return;
        const list: Alert[] = await r.json();
        setAlerts(list); S("alerts", list);
        for (const a of list) if (!spoken.current.has(a.id + a.language)) { spoken.current.add(a.id + a.language); S("alerts_spoken", [...spoken.current]); speak(a.text, a.language); if (navigator.vibrate) navigator.vibrate([300, 120, 300]); }
      } catch { /* offline: keep the cached alerts */ }
    };
    pull(); const t = setInterval(pull, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [me.zone, me.lang]);

  // phrasebook for chirps in my language, cached for offline use
  useEffect(() => { fetch(`/phrasebook?lang=${me.lang}`).then((r) => r.json()).then((d) => S(`phrases_${me.lang}`, d)).catch(() => {}); }, [me.lang]);

  const reply = async (a: Alert, status: "safe" | "need_help" | "left") => {
    setReplied((r) => { const n = { ...r, [a.id]: status }; S("alert_replies", n); return n; });
    try { await fetch(`/broadcasts/${a.id}/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, zone: serverZone(me.zone), device: deviceId, lang: me.lang }) }); } catch { /* queued visually; resend not needed for the demo */ }
  };

  const onFrame = async (bytes: Uint8Array) => {
    const f: Verified = await verifyFrame(bytes);
    if (!f.ok) return setChirpMsg({ ok: false, title: "Chirp heard, not trusted", body: `${f.error}. Nothing is shown or spoken from an unsigned or replayed alert.` });
    const book = S<{ lang: string; phrases: Record<string, string> }>(`phrases_${me.lang}`) || S<{ lang: string; phrases: Record<string, string> }>("phrases_en");
    const fallback: Record<string, string> = { evacuate: "Evacuate now. Take your bag and your people. Leave the zone.", shelter_in_place: "Shelter in place. Close windows and doors. Stay inside until the all clear.", all_clear: "All clear. You can return to normal activity.", info_only: "Information notice. Open the EchoHawk app for details." };
    const line = book?.phrases?.[f.action] || fallback[f.action] || fallback.info_only;
    setChirpMsg({ ok: true, title: `${f.action.replace(/_/g, " ")} · zone ${f.zone}`, body: line });
    speak(line, book?.lang || "en"); if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  };

  return (
    <div className="phone">
      <header className="ph-head">
        <Logo size={34} color="#c8333a" /><span className="ph-brand">EchoHawk</span>
        <span className="spacer" /><a href="/app/" style={{fontSize:14, marginRight:12}}>Simple mode</a>
        <span className={`ph-net ${online ? "" : "off"}`}><i />{online ? "Online" : "Offline"}</span>
      </header>
      <main className="ph-main">
        {view === "home" && <Home me={me} updates={updates} alerts={alerts} replied={replied} onReply={reply} go={setView} onFrame={onFrame} chirpMsg={chirpMsg} />}
        {view === "checkin" && <CheckIn me={me} go={setView} />}
        {view === "kits" && <Kits me={me} />}
        {view === "beacon" && <Beacon me={me} />}
        {view === "me" && <MeView me={me} save={(m) => { saveMe(m); setView("home"); }} />}
      </main>
      <nav className="ph-nav">
        {([["home", "Home", "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"], ["kits", "Kits", "M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10"], ["beacon", "Beacon", "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"], ["me", "Me", "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-7 8-7s8 3 8 7"]] as [View, string, string][]).map(([v, label, d]) => (
          <button key={v} className={view === v || (v === "home" && view === "checkin") ? "on" : ""} onClick={() => setView(v)}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill={v === "home" && (view === "home" || view === "checkin") ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Home({ me, updates, alerts, replied, onReply, go, onFrame, chirpMsg }: { me: Me; updates: Update[]; alerts: Alert[]; replied: Record<string, string>; onReply: (a: Alert, s: "safe" | "need_help" | "left") => void; go: (v: View) => void; onFrame: (b: Uint8Array) => void; chirpMsg: { ok: boolean; title: string; body: string } | null }) {
  const [listening, setListening] = useState(false);
  const stop = useRef<null | (() => void)>(null);
  const toggleListen = async () => {
    if (stop.current) { stop.current(); stop.current = null; setListening(false); return; }
    try { stop.current = await listen(onFrame); setListening(true); } catch (e) { alert(`Could not start listening: ${(e as Error).message}`); }
  };
  useEffect(() => () => stop.current?.(), []);
  const call = () => { if (!me.line) { alert("Add the support line number under Me. In a real deployment the city sets it."); go("me"); return; } location.href = `tel:${me.line}`; };
  return (
    <>
      {alerts.filter((a) => a.kind !== "all_clear" || !replied[a.id]).map((a) => (
        <div key={a.id} className={`ph-alert ${KIND_CLS[a.kind] || "blue"}`}>
          <div className="pa-top"><b>{a.label}</b><span>{a.agency}</span></div>
          <p>{a.text}</p>
          {a.machine_translated && <div className="pa-mt">Translated automatically into {langName(a.language)}.</div>}
          <div className="pa-acts">
            <button onClick={() => speak(a.text, a.language)}>🔊 Read aloud</button>
            {a.kind !== "advisory" && a.kind !== "all_clear" && (replied[a.id]
              ? <span className="pa-done">{replied[a.id] === "need_help" ? "Help requested. A dispatcher can see you." : replied[a.id] === "left" ? "Marked: you left the area." : "Marked safe."}</span>
              : <><button onClick={() => onReply(a, "safe")}>I'm safe</button><button onClick={() => onReply(a, "left")}>I've left</button><button className="help" onClick={() => onReply(a, "need_help")}>I need help</button></>)}
          </div>
        </div>
      ))}
      {updates.slice(0, 3).map((u) => (
        <div key={u.incident_id} className={`ph-update ${u.disposition ? "done" : ""}`}>
          <span className="pu-dot" />
          <div><b>Your report · {TARGET_NAME[u.target] || u.target.replace(/_/g, " ")}</b><span>{u.message}</span>{u.units.length > 0 && <small>{u.units.map((x) => `${x.unit.toUpperCase()} ${x.status.replace("_", " ")}`).join(" · ")}</small>}</div>
        </div>
      ))}
      <h1 className="ph-hero">Here when you need us.</h1>
      <p className="ph-sub">Stay informed. Check in. Stay connected.</p>
      <div className="ph-card area" onClick={() => go("me")}>
        <svg viewBox="0 0 24 24" width="24" height="24"><path fill="#c8333a" d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" /></svg>
        <span>Your area · <b>{me.zone ? `Zone ${rdOf(serverZone(me.zone))}` : "not set"}</b></span>
        <span className="spacer" /><a>Change</a>
      </div>
      <button className="ph-call" onClick={call}>
        <svg viewBox="0 0 24 24" width="30" height="30"><path fill="#fff" d="M21 16.6v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.1 3.9 2 2 0 0 1 3.1 1.7h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L7.1 9.5a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1z" /></svg>
        <div><b>Call the support line</b><span>Emergency overflow &amp; non-emergency support</span></div>
        <span className="chev">›</span>
      </button>
      <div className="ph-grid">
        <button className="ph-tile" onClick={() => go("checkin")}><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#c8333a" strokeWidth="1.6" strokeLinejoin="round"><path d="M4 5h16v11H9l-5 4z" /></svg><b>Check in</b><span>Share what you see</span><i>›</i></button>
        <button className="ph-tile" onClick={() => go("kits")}><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#c8333a" strokeWidth="1.6" strokeLinejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10" /></svg><b>Action Kits</b><span>Ready, even offline</span><i>›</i></button>
      </div>
      <div className="ph-signal">
        <div className="ps-top"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#c8333a" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="2" fill="#c8333a" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" /></svg>
          <div><b>Alerts, even without a signal</b><span>In an outage, an eHawk or a nearby speaker can play a short chirp with a signed alert. Your phone hears it, checks the signature, and reads it out in your language.</span></div></div>
        <button className={`ps-listen ${listening ? "on" : ""}`} onClick={toggleListen}>{listening ? "● Listening… tap to stop" : "Listen for a chirp"}</button>
        {chirpMsg && <div className={`ps-msg ${chirpMsg.ok ? "ok" : "bad"}`}><b>{chirpMsg.title}</b><span>{chirpMsg.body}</span>{chirpMsg.ok && <small>Verified on this phone, no network needed.</small>}</div>}
      </div>
      <div className="ph-911">ⓘ For immediate danger, call 911.</div>
    </>
  );
}

function CheckIn({ me, go }: { me: Me; go: (v: View) => void }) {
  const [hurt, setHurt] = useState("no"), [target, setTarget] = useState("power"), [sev, setSev] = useState(3), [text, setText] = useState(""), [status, setStatus] = useState("");
  const [queue, setQueue] = useState<any[]>(S<any[]>("queue") || []);
  const flush = async () => {
    let q = S<any[]>("queue") || []; if (!q.length) return;
    if (!navigator.onLine) { setStatus(`Offline. ${q.length} waiting; they send when you are back online.`); return; }
    const rest: any[] = [];
    for (const p of q) { try { const r = await fetch("/packets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }); if (!r.ok) throw new Error(); setStatus("Sent. Dispatch can see it."); } catch { rest.push(p); } }
    S("queue", rest); setQueue(rest);
  };
  useEffect(() => { flush(); addEventListener("online", flush); return () => removeEventListener("online", flush); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    if (!me.zone) { setStatus("Set your area under Me first."); return; }
    const pkt = { source: "app", identifier: deviceId, zone_id: serverZone(me.zone), target, severity: hurt === "yes" ? Math.max(sev, 4) : sev, action: hurt === "yes" ? "dispatch_ems" : sev >= 4 ? "welfare_check" : "info_only", language: me.lang, provenance: "firsthand", text, dependent_in_household: me.dependent === "yes", ts_device: new Date().toISOString() };
    const q = [...(S<any[]>("queue") || []), pkt]; S("queue", q); setQueue(q); setStatus("Saved on this phone."); await flush();
    if (hurt === "yes") setStatus((s) => s + " Someone is hurt: call the support line too.");
  };
  return (
    <>
      <button className="ph-back" onClick={() => go("home")}>‹ Home</button>
      <h1 className="ph-h">Check in</h1>
      <p className="ph-sub">Four questions. It reaches the same board the phone line feeds. If someone is hurt, call too.</p>
      <div className="ph-form">
        <label>Is anyone hurt?</label>
        <div className="seg3">{[["no", "No"], ["yes", "Yes"], ["unknown", "Not sure"]].map(([v, l]) => <button key={v} className={hurt === v ? "on" : ""} onClick={() => setHurt(v)}>{l}</button>)}</div>
        <label>What do you see?</label>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>{[["power", "Power out"], ["water", "Water pressure or main"], ["gas", "Gas smell"], ["power_line", "Downed power line"], ["structure_fire", "Building fire"], ["wildfire", "Brush or wildfire"], ["flood", "Flooding"], ["road", "Road blocked"], ["person", "Person needs help"], ["unknown", "Something else"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <label>How bad? <span>{sev} of 5</span></label>
        <input type="range" min={1} max={5} value={sev} onChange={(e) => setSev(+e.target.value)} />
        <label>Anything else (optional)</label>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Smell is strongest near the alley" />
        <button className="ph-primary" onClick={send}>Send check-in</button>
        {status && <div className="ph-status">{status}</div>}
        {queue.length > 0 && <div className="ph-status">{queue.length} waiting to send</div>}
      </div>
    </>
  );
}

function Kits({ me }: { me: Me }) {
  const [kits, setKits] = useState<Kit[] | null>(S<{ kits: Kit[] }>("kits")?.kits || null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { fetch("/kits").then((r) => r.json()).then((d) => { S("kits", d); setKits(d.kits || []); }).catch(() => {}); }, []);
  if (!kits) return <div className="ph-empty">Open this once while online to keep the kits on your phone.</div>;
  return (
    <>
      <h1 className="ph-h">Action Kits</h1>
      <p className="ph-sub">Short, sourced steps, saved on this phone. Shown word for word from the approved catalog.</p>
      {kits.map((k) => {
        const steps = me.lang === "es" && k.display_steps_es?.length ? k.display_steps_es : k.display_steps || [];
        return (
          <div key={k.kit_id} className={`ph-kit ${open === k.kit_id ? "open" : ""}`}>
            <button className="pk-head" onClick={() => setOpen(open === k.kit_id ? null : k.kit_id)}>
              <b>{k.title}</b><span>{k.medical_review === "pending" ? "Pending medical review" : k.mode}{k.requires_human ? " · call a person too" : ""}</span><i>{open === k.kit_id ? "–" : "+"}</i>
            </button>
            {open === k.kit_id && <div className="pk-body"><ol>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol><small>Source: {k.authority || "unverified"} · checked {k.last_source_check || "unverified"}{me.lang !== "en" && me.lang !== "es" ? ` · shown in English: a reviewed ${langName(me.lang)} version is not available yet` : ""}</small></div>}
          </div>
        );
      })}
    </>
  );
}

function Beacon({ me }: { me: Me }) {
  const [on, setOn] = useState(false), [log, setLog] = useState("");
  const [stages, setStages] = useState<{ stage: number; node: number; how: string; at: string }[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null), stopListen = useRef<(() => void) | null>(null), ble = useRef<{ close: () => void } | null>(null);
  // one emergency keeps one sequence, so every node and every repeat is recognized as the same report
  const seq = useRef(Math.floor(Math.random() * 60000));
  const zone = () => parseInt(serverZone(me.zone || "0").replace(/\D/g, ""), 10) || 0;
  const sos = () => signFrame({ type: "sos", zone: zone(), target: "person", severity: 5, action: "dispatch_ems", language: me.lang, sequence: seq.current });
  const gotReceipt = async (bytes: Uint8Array, how: string) => {
    const r = await readAck(bytes, seq.current); if (!r) return;
    setStages((xs) => xs.some((x) => x.stage === r.stage) ? xs : [...xs, { ...r, how, at: new Date().toLocaleTimeString() }].sort((a, b) => a.stage - b.stage));
    if (navigator.vibrate) navigator.vibrate(r.stage === 1 ? [120] : [120, 80, 120]);
    // picked up: stop chirping, keep listening for the dispatch receipt
    if (timer.current) { clearInterval(timer.current); timer.current = null; setLog("Picked up. Stopped repeating, still listening for dispatch."); }
  };
  const stopAll = () => { if (timer.current) clearInterval(timer.current); timer.current = null; stopListen.current?.(); stopListen.current = null; ble.current?.close(); ble.current = null; setOn(false); };
  const toggle = async () => {
    if (on) { stopAll(); setLog("Stopped."); return; }
    seq.current = (seq.current + 1) & 0xffff; setStages([]);
    try {
      stopListen.current = await listen((b) => gotReceipt(b, "sound"));
      const tick = async () => { await chirp(await sos()); setLog(`SOS sent ${new Date().toLocaleTimeString()}, listening for a node…`); };
      await tick(); timer.current = setInterval(tick, 6000); setOn(true);
    } catch (e) { setLog(`Could not start: ${(e as Error).message}`); }
  };
  const viaBle = async () => {
    seq.current = (seq.current + 1) & 0xffff; setStages([]);
    try { ble.current = await sendBle(await sos(), (b) => gotReceipt(b, "Bluetooth")); setOn(true); setLog("SOS sent by Bluetooth, waiting for the node…"); }
    catch (e) { setLog(`Bluetooth: ${(e as Error).message}`); }
  };
  useEffect(() => () => stopAll(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <h1 className="ph-h">Beacon</h1>
      <p className="ph-sub">Sends a signed SOS to the nearest EchoHawk node with no cell signal: by sound (arm's reach) or by Bluetooth. You get a receipt when a node picks it up and another when dispatch has it.</p>
      <button className={`ph-beacon ${on ? "on" : ""}`} onClick={toggle}>{on ? "Stop" : "Start sound beacon"}</button>
      {bleAvailable() ? <button className="ph-ble" onClick={viaBle}>Send by Bluetooth to a node</button> : <div className="ph-status center small">Bluetooth sending needs Chrome on Android or a laptop. iPhone browsers don't allow it.</div>}
      {log && <div className="ph-status center">{log}</div>}
      <div className="ph-receipts">
        {[1, 2].map((st) => { const r = stages.find((x) => x.stage === st); return (
          <div key={st} className={`ph-rc ${r ? "ok" : ""}`}><span className="dot" /><div><b>{ACK_LABEL[st]}</b><span>{r ? `${st === 1 ? `Node ${r.node}` : "Dispatch"} · by ${r.how} · ${r.at}` : "Waiting"}</span></div></div>
        ); })}
      </div>
    </>
  );
}

function MeView({ me, save }: { me: Me; save: (m: Me) => void }) {
  const [m, setM] = useState<Me>(me);
  return (
    <>
      <h1 className="ph-h">Me</h1>
      <p className="ph-sub">Saved only on this phone. Nothing leaves it unless you check in, reply to an alert, or call.</p>
      <div className="ph-form">
        <label>My area (zone or district, never an address)</label>
        <input value={m.zone} onChange={(e) => setM({ ...m, zone: e.target.value })} onBlur={() => setM((x) => ({ ...x, zone: x.zone ? normZone(x.zone) : "" }))} placeholder="0802 or Z06" />
        <label>Language for alerts</label>
        <select value={m.lang} onChange={(e) => setM({ ...m, lang: e.target.value })}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.native}{l.native !== l.name ? ` · ${l.name}` : ""}</option>)}</select>
        <label>Anyone at home who depends on power or help to move?</label>
        <div className="seg3">{[["no", "No"], ["yes", "Yes"]].map(([v, l]) => <button key={v} className={m.dependent === v ? "on" : ""} onClick={() => setM({ ...m, dependent: v as "no" | "yes" })}>{l}</button>)}</div>
        <label>Emergency contact (name, number)</label>
        <input value={m.contact} onChange={(e) => setM({ ...m, contact: e.target.value })} placeholder="Maria, 213 555 0100" />
        <label>Support line number (set by your city)</label>
        <input value={m.line} onChange={(e) => setM({ ...m, line: e.target.value })} placeholder="+1 …" />
        <button className="ph-primary" onClick={() => save({ ...m, zone: m.zone ? normZone(m.zone) : "" })}>Save on this phone</button>
      </div>
    </>
  );
}
