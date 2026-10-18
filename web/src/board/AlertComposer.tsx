import { useState } from "react";
import { rdOf } from "../shared/laMap";
import { ZONES } from "../shared/labels";

// The supervisor's side of public alerting. EchoHawk can tell residents what it knows (an advisory goes out at once)
// and can ask an agency for a protective action (it lands in the agency's Public Alerts queue as a request).
// Evacuation orders, warnings and shelter in place are issued by the agencies, never from this board.
type Mode = "advisory" | "request";
const REQ_KINDS = [["evacuation_warning", "Evacuation warning"], ["evacuation_order", "Evacuation order"], ["shelter_in_place", "Shelter in place"]] as const;

export function AlertComposer({ tok, initialZones, initialHazard, onClose, toast }: { tok: string; initialZones: string[]; initialHazard: string; onClose: () => void; toast: (t: string, err?: boolean) => void }) {
  const [mode, setMode] = useState<Mode>("advisory");
  const [kind, setKind] = useState<string>("evacuation_warning");
  const [zones, setZones] = useState<Set<string>>(new Set(initialZones));
  const [message, setMessage] = useState(initialHazard ? `We know about the ${initialHazard.toLowerCase()} in your area. Crews have been notified. You do not need to call unless someone is hurt or in danger.` : "");
  const [busy, setBusy] = useState(false);
  const toggle = (z: string) => setZones((s) => { const n = new Set(s); n.has(z) ? n.delete(z) : n.add(z); return n; });
  const submit = async () => {
    if (!zones.size || !message.trim()) return toast("Pick zones and write the message.", true);
    setBusy(true);
    const body = mode === "advisory" ? { kind: "advisory", zones: [...zones], message, hazard: initialHazard } : { kind, zones: [...zones], message, hazard: initialHazard, request: true };
    let r: Response | null = null;
    try {
      r = await fetch("/broadcasts", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "x-operator": "Supervisor" }, body: JSON.stringify(body) });
    } catch {
      setBusy(false);
      return toast("Network error. Could not send.", true);
    }
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return toast(d.error || "Could not send", true);
    toast(mode === "advisory" ? `Advisory sent to ${zones.size} zone${zones.size > 1 ? "s" : ""} in 15 languages` : "Request sent to the alerting agencies' queue");
    onClose();
  };
  return (
    <div className="slideover" onClick={onClose}>
      <div className="acomp" onClick={(e) => e.stopPropagation()}>
        <div className="sohead"><div><b>Public alert</b><span>Reaches the EchoHawk app and eHawk devices in the zones you pick</span></div><span className="spacer" /><button className="x" onClick={onClose}>✕</button></div>
        <div className="amodes">
          <button className={mode === "advisory" ? "on" : ""} onClick={() => setMode("advisory")}><b>Send an advisory</b><span>Information only, goes out now. "We know, crews are on it, no need to call."</span></button>
          <button className={mode === "request" ? "on" : ""} onClick={() => setMode("request")}><b>Ask an agency for a protective action</b><span>Evacuation or shelter in place. OEM, Sheriff or Fire reviews it and a second person approves before it goes out.</span></button>
        </div>
        {mode === "request" && <div className="akinds">{REQ_KINDS.map(([k, l]) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{l}</button>)}</div>}
        <div className="alab">Zones</div>
        <div className="azones">{ZONES.map((z) => <button key={z} className={zones.has(z) ? "on" : ""} onClick={() => toggle(z)}>{rdOf(z)}</button>)}</div>
        <div className="alab">Message <span>{message.length}/360</span></div>
        <textarea value={message} maxLength={360} rows={4} onChange={(e) => setMessage(e.target.value)} />
        <div className="afoot">
          <span className="muted small">{mode === "advisory" ? "Translated into 15 languages and read aloud in the app." : "Lands in the Public Alerts queue at /alerts for agency review."}</span>
          <button className={mode === "advisory" ? "btn-teal" : "btn-amber"} disabled={busy} onClick={submit}>{busy ? "Sending…" : mode === "advisory" ? "Send advisory" : "Send request"}</button>
        </div>
      </div>
    </div>
  );
}
