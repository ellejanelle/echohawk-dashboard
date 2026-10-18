import { useEffect, useState } from "react";
import { Logo } from "../shared/Brand";
import { useEvents, useRefresher } from "../shared/sse";
import { hms, useTick } from "../shared/time";
import { ZONES } from "../shared/labels";
import { rdOf } from "../shared/laMap";
import { LANGUAGES } from "../shared/languages";
import { Toasts, useToasts } from "../shared/ui";

type Kind = "evacuation_order" | "evacuation_warning" | "shelter_in_place" | "advisory" | "all_clear";
interface Agency { id: string; name: string }
interface Who { role: string; agency: string; name: string }
interface Broadcast {
  id: string; kind: Kind; label: string; zones: string[]; message: string; instructions: string; hazard: string; status: "requested" | "draft" | "active" | "cancelled";
  created_at: string; created_by: Who; approved_by: Who | null; sent_at: string | null; cancelled_at?: string; cancelled_by?: Who & { reason: string };
  translations: Record<string, { text: string; machine: boolean }>; frames: { zone: string; b64: string }[]; acks: { safe: number; need_help: number; left: number };
}
interface Session { token: string; agency: Agency; name: string }

const KIND_META: Record<Kind, { label: string; cls: string; lead: string; note: string }> = {
  evacuation_order: { label: "Evacuation order", cls: "red", lead: "Leave now.", note: "Immediate threat to life. Needs a second person to send." },
  evacuation_warning: { label: "Evacuation warning", cls: "amber", lead: "Get ready to leave.", note: "Potential threat. Needs a second person to send." },
  shelter_in_place: { label: "Shelter in place", cls: "amber", lead: "Stay inside.", note: "Needs a second person to send." },
  advisory: { label: "Advisory", cls: "blue", lead: "", note: "Information only. No protective action." },
  all_clear: { label: "All clear", cls: "green", lead: "", note: "Lifts earlier alerts for these zones." },
};
const PROTECTIVE: Kind[] = ["evacuation_order", "evacuation_warning", "shelter_in_place"];

function loadSession(): Session | null { try { const s = sessionStorage.getItem("eh-agency"); return s ? JSON.parse(s) : null; } catch { return null; } }

export function Alerts() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  useEffect(() => {
    fetch("/agencies").then((r) => r.json()).then((d) => setAgencies(d.agencies || [])).catch(() => {});
  }, []);
  if (!session) return <Login agencies={agencies} onIn={(s) => { try { sessionStorage.setItem("eh-agency", JSON.stringify(s)); } catch { /* private mode */ } setSession(s); }} />;
  return <AgencyConsole session={session} onOut={() => { try { sessionStorage.removeItem("eh-agency"); } catch { /* ignore */ } setSession(null); }} />;
}

function Login({ agencies, onIn }: { agencies: Agency[]; onIn: (s: Session) => void }) {
  const [agency, setAgency] = useState("lac-oem");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const go = async () => {
    setErr("");
    let r: Response;
    try {
      r = await fetch("/agency/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agency, name, passcode: pass }) });
    } catch {
      return setErr("Network error. Could not reach the server.");
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setErr(d.error || "Could not sign in");
    onIn({ token: d.token, agency: d.agency, name: d.name });
  };
  return (
    <div className="login">
      <div className="lbox">
        <div className="lmark"><Logo size={34} color="#f2b43c" /><span>EchoHawk <b>Public Alerts</b></span></div>
        <p className="lsub">For alerting agencies only. Evacuation orders, warnings and shelter in place go to the EchoHawk app and to eHawk household devices in the zones you pick, in 15 languages.</p>
        <label>Agency</label>
        <select value={agency} onChange={(e) => setAgency(e.target.value)}>{agencies.length ? agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>) : <option value="lac-oem">LA County OEM (loading…)</option>}</select>
        <label>Your name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown on every alert you draft or approve" />
        <label>Agency passcode</label>
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} placeholder="Demo passcode: dev-agency" />
        {err && <div className="lerr">{err}</div>}
        <button className="btn-amber" onClick={go}>Sign in</button>
        <div className="lfoot">Every sign-in, draft, approval and cancel is logged with your name and agency.</div>
      </div>
    </div>
  );
}

function AgencyConsole({ session, onOut }: { session: Session; onOut: () => void }) {
  const H = { authorization: `Bearer ${session.token}`, "content-type": "application/json", "x-agency": session.agency.id, "x-operator": session.name };
  const [list, setList] = useState<Broadcast[]>([]);
  const [kind, setKind] = useState<Kind>("evacuation_warning");
  const [zones, setZones] = useState<Set<string>>(new Set());
  const [hazard, setHazard] = useState("");
  const [message, setMessage] = useState("");
  const [instructions, setInstructions] = useState("");
  const [ehawk, setEhawk] = useState(true);
  const toasts = useToasts();
  useTick(5000);

  const refresh = async () => {
    let r: Response;
    try {
      r = await fetch("/broadcasts", { headers: H });
    } catch {
      return; // network error: keep existing list, retry on next poll
    }
    if (r.status === 401) return onOut();
    if (r.ok) setList(await r.json().catch(() => []));
  };
  const soon = useRefresher(refresh, 4000);
  const stream = useEvents((ev) => { if (ev.event_type.startsWith("alert_")) soon(); });

  const requested = list.filter((b) => b.status === "requested");
  const drafts = list.filter((b) => b.status === "draft");
  const active = list.filter((b) => b.status === "active");
  const past = list.filter((b) => b.status === "cancelled").slice(0, 8);
  const preview = [KIND_META[kind].lead, message.trim(), instructions.trim()].filter(Boolean).join(" ");

  const toggle = (z: string) => setZones((s) => { const n = new Set(s); n.has(z) ? n.delete(z) : n.add(z); return n; });
  const draft = async () => {
    if (!zones.size) return toasts.push("Pick at least one zone.", true);
    if (!message.trim()) return toasts.push("Write the message residents will read.", true);
    let r: Response;
    try {
      r = await fetch("/broadcasts", { method: "POST", headers: H, body: JSON.stringify({ kind, zones: [...zones], hazard, message, instructions, ehawk }) });
    } catch {
      return toasts.push("Network error. Could not save.", true);
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toasts.push(d.error || "Could not save", true);
    toasts.push(PROTECTIVE.includes(kind) ? "Draft saved. A second person from an agency has to approve and send it." : "Draft saved. Send it from the queue.");
    setMessage(""); setInstructions(""); setHazard(""); setZones(new Set()); refresh();
  };
  const send = async (b: Broadcast) => {
    let r: Response;
    try {
      r = await fetch(`/broadcasts/${b.id}/send`, { method: "POST", headers: H, body: "{}" });
    } catch {
      return toasts.push("Network error. Could not send.", true);
    }
    const d = await r.json().catch(() => ({}));
    r.ok ? toasts.push(`${b.label} sent to ${b.zones.map((z) => `zone ${rdOf(z)}`).join(", ")}`) : toasts.push(d.error || "Could not send", true);
    refresh();
  };
  const cancel = async (b: Broadcast) => {
    const reason = b.status === "active" ? "lifted" : "withdrawn";
    let r: Response;
    try {
      r = await fetch(`/broadcasts/${b.id}/cancel`, { method: "POST", headers: H, body: JSON.stringify({ reason }) });
    } catch {
      return toasts.push("Network error. Could not cancel.", true);
    }
    const d = await r.json().catch(() => ({}));
    r.ok ? toasts.push(b.status === "active" ? "Alert lifted" : "Draft withdrawn") : toasts.push(d.error || "Could not cancel", true);
    refresh();
  };
  const adopt = (b: Broadcast) => { setKind(b.kind); setZones(new Set(b.zones)); setHazard(b.hazard); setMessage(b.message); setInstructions(b.instructions); toasts.push("Request copied into the editor. Check it, then save as your draft."); };
  const mine = (b: Broadcast) => b.created_by.role === "agency" && b.created_by.name.trim().toLowerCase() === session.name.trim().toLowerCase();

  return (
    <div className="alertsapp">
      <header className="ahead">
        <a className="mark" href="/board"><Logo color="#f2b43c" /><span>EchoHawk</span></a>
        <span className="atitle">Public Alerts</span>
        <span className="spacer" />
        <span className={`sys ${stream === "live" ? "" : "off"}`}><i />{stream === "live" ? "Connected" : "Reconnecting…"}</span>
        <span className="divider" />
        <div className="who"><b>{session.name}</b><span>{session.agency.name}</span></div>
        <button className="btn-ghost" onClick={onOut}>Sign out</button>
      </header>

      <div className="agrid">
        <section className="panel compose">
          <div className="ptitle">New alert</div>
          <div className="kinds">{(Object.keys(KIND_META) as Kind[]).map((k) => <button key={k} className={`kind ${KIND_META[k].cls} ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>{KIND_META[k].label}</button>)}</div>
          <div className="knote">{KIND_META[kind].note}</div>
          <label>Zones <span className="muted small">{zones.size ? `${zones.size} selected` : "tap to select"}</span></label>
          <div className="zpick">{ZONES.map((z) => <button key={z} className={zones.has(z) ? "on" : ""} onClick={() => toggle(z)}><b>{rdOf(z)}</b><span>{z}</span></button>)}</div>
          <label>Hazard</label>
          <input value={hazard} onChange={(e) => setHazard(e.target.value)} placeholder="Brush fire, gas leak, water main break…" />
          <label>Message <span className={`muted small ${message.length > 300 ? "warn" : ""}`}>{message.length}/360</span></label>
          <textarea value={message} maxLength={360} onChange={(e) => setMessage(e.target.value)} placeholder="What is happening and where, in plain words." rows={3} />
          <label>What to do</label>
          <textarea value={instructions} maxLength={360} onChange={(e) => setInstructions(e.target.value)} placeholder="Route out, shelter location, what to bring." rows={2} />
          <label className="chk"><input type="checkbox" checked readOnly /> EchoHawk app (text, read aloud, in 15 languages)</label>
          <label className="chk"><input type="checkbox" checked={ehawk} onChange={(e) => setEhawk(e.target.checked)} /> eHawk devices and offline phones (signed chirp, spoken from the device's phrasebook)</label>
          {preview && <div className={`preview ${KIND_META[kind].cls}`}><span>{KIND_META[kind].label}</span>{preview}</div>}
          <button className="btn-amber wide" onClick={draft}>Save draft</button>
          <div className="fine">Not a Wireless Emergency Alert. WEA and IPAWS stay with your existing alerting system; this reaches EchoHawk residents and devices, including in languages WEA does not carry today.</div>
        </section>

        <section className="panel queue">
          <div className="ptitle">Waiting for approval<span className="cnt">{requested.length + drafts.length}</span></div>
          <div className="qlist">
            {!requested.length && !drafts.length && <div className="empty">Nothing waiting.</div>}
            {requested.map((b) => (
              <div key={b.id} className="qcard req">
                <div className="qtop"><span className={`kchip ${KIND_META[b.kind].cls}`}>{b.label}</span><span className="from">Requested by the EchoHawk supervisor</span><span className="t">{hms(b.created_at).slice(0, 5)}</span></div>
                <div className="qzones">{b.zones.map((z) => `Zone ${rdOf(z)}`).join(", ")}{b.hazard ? ` · ${b.hazard}` : ""}</div>
                <div className="qmsg">{b.message}</div>
                <div className="qacts"><button className="btn-amber" onClick={() => adopt(b)}>Review in editor</button><button className="btn-ghost" onClick={() => cancel(b)}>Decline</button></div>
              </div>
            ))}
            {drafts.map((b) => {
              const own = mine(b) && PROTECTIVE.includes(b.kind);
              return (
                <div key={b.id} className="qcard">
                  <div className="qtop"><span className={`kchip ${KIND_META[b.kind].cls}`}>{b.label}</span><span className="from">Drafted by {b.created_by.name}, {b.created_by.agency}</span><span className="t">{hms(b.created_at).slice(0, 5)}</span></div>
                  <div className="qzones">{b.zones.map((z) => `Zone ${rdOf(z)}`).join(", ")}{b.hazard ? ` · ${b.hazard}` : ""}</div>
                  <div className="qmsg">{[KIND_META[b.kind].lead, b.message, b.instructions].filter(Boolean).join(" ")}</div>
                  <div className="qacts">
                    <button className="btn-send" disabled={own} onClick={() => send(b)} title={own ? "You drafted this. A second person has to send it." : "Approve and send"}>{own ? "Waiting for a second person" : "Approve and send"}</button>
                    <button className="btn-ghost" onClick={() => cancel(b)}>Withdraw</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel live">
          <div className="ptitle">Active now<span className="cnt live">{active.length}</span></div>
          <div className="qlist">
            {!active.length && <div className="empty">No active alerts.</div>}
            {active.map((b) => (
              <div key={b.id} className={`acard ${KIND_META[b.kind].cls}`}>
                <div className="qtop"><span className={`kchip ${KIND_META[b.kind].cls}`}>{b.label}</span><span className="t">sent {hms(b.sent_at || b.created_at).slice(0, 5)}</span></div>
                <div className="qzones">{b.zones.map((z) => `Zone ${rdOf(z)}`).join(", ")}{b.hazard ? ` · ${b.hazard}` : ""}</div>
                <div className="qmsg">{b.translations.en?.text || b.message}</div>
                <div className="astats">
                  <span><b>{b.acks.safe}</b> safe</span><span className="red"><b>{b.acks.need_help}</b> need help</span><span><b>{b.acks.left}</b> left the area</span>
                </div>
                <div className="langs" title="Machine translated by the model; English is the source">
                  {LANGUAGES.map((l) => <i key={l.code} className={b.translations[l.code] ? "ok" : ""} title={`${l.name}${b.translations[l.code] ? "" : " (pending)"}`}>{l.code}</i>)}
                </div>
                <div className="sig">Drafted by {b.created_by.name} · approved by {b.approved_by?.name} ({b.approved_by?.agency}){b.frames.length ? ` · ${b.frames.length} signed chirp frame${b.frames.length > 1 ? "s" : ""}` : ""}</div>
                <div className="qacts"><button className="btn-ghost" onClick={() => cancel(b)}>Lift alert</button></div>
              </div>
            ))}
            {past.length > 0 && <div className="lcsub">Lifted or withdrawn</div>}
            {past.map((b) => <div key={b.id} className="pastrow"><span className={`kchip ${KIND_META[b.kind].cls}`}>{b.label}</span><span>{b.zones.map((z) => rdOf(z)).join(", ")}</span><span className="muted small">{b.cancelled_by?.reason} by {b.cancelled_by?.name}</span></div>)}
          </div>
        </section>
      </div>
      <Toasts items={toasts.items} />
    </div>
  );
}
