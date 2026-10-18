import { useEffect, useRef, useState } from "react";
import { Logo } from "../shared/Brand";
import { b64, chirp, listen, NUS_UUIDS, signAck, unb64 } from "../app/frame";

// A pole node, standing in on a laptop for the demo. It hears reports from a personal eHawk tag over Bluetooth (the ESP32)
// and from phones by chirp, sends the sender a signed "picked up" receipt at once, forwards the report to dispatch
// (the gateway hop), and passes back the server's signed "delivered to dispatch" receipt.
const NODES = [
  { id: "N-0812-A", num: 1, label: "Pole A · Sunset & Swarthmore" },
  { id: "N-0812-B", num: 2, label: "Pole B · Via de la Paz" },
  { id: "N-0812-C", num: 3, label: "Pole C · Monument St" },
];
const TYPE = ["directive", "check-in", "SOS", "receipt"];
const TARGET = ["unknown", "power", "water", "gas", "power line", "structure fire", "wildfire", "road", "flood", "person", "vehicle"];
type Line = { at: string; kind: "in" | "out" | "net" | "warn"; text: string };
type Channel = "ble" | "sound";

export function Node() {
  const [nodeId, setNodeId] = useState(() => new URLSearchParams(location.search).get("node") || "N-0812-A");
  const node = NODES.find((n) => n.id === nodeId) || NODES[0];
  const [log, setLog] = useState<Line[]>([]);
  const [tag, setTag] = useState<string>("");
  const [ears, setEars] = useState(false);
  const [last, setLast] = useState<{ type: string; zone: number; seq: number; stage: number; incident?: string; rung?: string; channel: Channel } | null>(null);
  const bleRx = useRef<any>(null), bleDev = useRef<any>(null), stopEars = useRef<(() => void) | null>(null);
  const seen = useRef(new Map<string, { at: number; receipts: Uint8Array[] }>());
  const add = (kind: Line["kind"], text: string) => setLog((l) => [{ at: new Date().toLocaleTimeString(), kind, text }, ...l].slice(0, 80));

  const sendBack = async (bytes: Uint8Array, channel: Channel) => {
    if (channel === "ble" && bleRx.current) { await bleRx.current.writeValue(bytes); return; }
    if (channel === "sound") await chirp(bytes);
  };

  // the same message is type + zone + content + sequence (not the minute stamp or signature), same rule as the server
  const keyOf = (b: Uint8Array) => Array.from([...b.slice(0, 5), ...b.slice(9, 11)]).join(".");

  const onFrame = async (bytes: Uint8Array, channel: Channel) => {
    if (bytes.length !== 16) return;
    const type = bytes[0] & 0x0f;
    if (type !== 1 && type !== 2) return; // only reports; ignore receipts and directives (including our own chirps)
    const seq = (bytes[9] << 8) | bytes[10], zone = (bytes[1] << 8) | bytes[2];
    const key = keyOf(bytes), prior = seen.current.get(key);
    const how = channel === "ble" ? "Bluetooth" : "sound";
    if (prior && Date.now() - prior.at < 10 * 60 * 1000) {
      add("in", `Repeat of SOS #${seq} by ${how}. Already picked up; sending the receipts again, not forwarding twice.`);
      for (const r of prior.receipts) { await sendBack(r, channel); if (channel === "sound") await new Promise((z) => setTimeout(z, 2500)); }
      return;
    }
    add("in", `${TYPE[type]} #${seq} heard by ${how}: ${TARGET[bytes[3] >> 4]}, severity ${bytes[3] & 0x0f}, zone ${zone}`);
    const lang = ["en", "es", "ko", "zh", "tl", "hy", "vi", "fa", "ru", "ar", "ja", "hi", "th", "uk", "yue"][bytes[4] & 0x0f] || "en";
    const r1 = await signAck({ stage: 1, sequence: seq, node: node.num, language: lang });
    const entry = { at: Date.now(), receipts: [r1] };
    seen.current.set(key, entry);
    await sendBack(r1, channel);
    add("out", `Receipt 1 sent back by ${how}: picked up by ${node.id}`);
    setLast({ type: TYPE[type], zone, seq, stage: 1, channel });
    try {
      const res = await fetch("/device/packets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node_id: node.id, channel, frame_b64: b64(bytes) }) });
      const out = await res.json();
      if (!res.ok) { add("warn", `Dispatch refused it: ${out.error || res.status}`); return; }
      add("net", out.duplicate ? `Dispatch already had it from ${out.picked_up?.node || "another node"}; now heard by ${out.heard_by?.length} node(s)` : `Forwarded to dispatch: incident ${out.incident_id}, ${out.rung === "hand" ? "needs a person" : out.rung}`);
      if (out.ack_b64) {
        const r2 = unb64(out.ack_b64); entry.receipts.push(r2);
        if (channel === "sound") await new Promise((z) => setTimeout(z, 2500));
        await sendBack(r2, channel);
        add("out", `Receipt 2 sent back by ${how}: delivered to dispatch (signed by the server)`);
        setLast({ type: TYPE[type], zone, seq, stage: 2, incident: out.incident_id, rung: out.rung, channel });
      }
    } catch { add("warn", "No route to dispatch right now. Holding the report; the sender already has receipt 1."); }
  };

  const connectTag = async () => {
    try {
      const bt = (navigator as any).bluetooth;
      if (!bt) { add("warn", "This browser has no Bluetooth. Use Chrome."); return; }
      const dev = await bt.requestDevice({ filters: [{ namePrefix: "EchoHawk" }], optionalServices: [NUS_UUIDS.service] });
      const gatt = await dev.gatt.connect();
      const svc = await gatt.getPrimaryService(NUS_UUIDS.service);
      const tx = await svc.getCharacteristic(NUS_UUIDS.tx);
      bleRx.current = await svc.getCharacteristic(NUS_UUIDS.rx);
      bleDev.current = dev;
      await tx.startNotifications();
      tx.addEventListener("characteristicvaluechanged", (e: any) => onFrame(new Uint8Array(e.target.value.buffer.slice(0)), "ble"));
      dev.addEventListener("gattserverdisconnected", () => { setTag(""); add("warn", `${dev.name} disconnected`); });
      // time sync so the tag's reports carry the right minute
      const mins = Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 60000);
      await bleRx.current.writeValue(new Uint8Array([84, mins >>> 24, (mins >>> 16) & 255, (mins >>> 8) & 255, mins & 255]));
      setTag(dev.name || "eHawk tag"); add("net", `Connected to ${dev.name} over Bluetooth. Waiting for a report.`);
    } catch (e) { add("warn", `Bluetooth: ${(e as Error).message}`); }
  };

  const toggleEars = async () => {
    if (stopEars.current) { stopEars.current(); stopEars.current = null; setEars(false); return; }
    try { stopEars.current = await listen((b) => onFrame(b, "sound")); setEars(true); add("net", "Listening for phone chirps."); } catch (e) { add("warn", `Microphone: ${(e as Error).message}`); }
  };
  useEffect(() => () => { stopEars.current?.(); try { bleDev.current?.gatt?.disconnect(); } catch { /* gone */ } }, []);

  return (
    <div className="nodepage">
      <header className="nodehead"><Logo /><b>EchoHawk node</b><span className="sim">demo stand-in for a pole node</span>
        <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>{NODES.map((n) => <option key={n.id} value={n.id}>{n.id} · {n.label}</option>)}</select>
      </header>
      <div className="nodegrid">
        <section className="npanel">
          <h2>Hear</h2>
          <button className={`nbtn ${tag ? "on" : ""}`} onClick={connectTag}>{tag ? `● ${tag} (Bluetooth)` : "Connect an eHawk tag by Bluetooth"}</button>
          <button className={`nbtn ${ears ? "on" : ""}`} onClick={toggleEars}>{ears ? "● Listening for phone chirps" : "Listen for phone chirps"}</button>
          <p className="nhint">A real pole node hears by sound, Bluetooth and radio, and forwards over radio to a gateway with internet. Here the laptop is the node and its internet is the gateway hop.</p>
          <div className="chain">
            {["Report heard", "Receipt 1: picked up", "Forwarded to dispatch", "Receipt 2: delivered"].map((s, i) => {
              const done = last ? (i === 0 ? true : i === 1 ? last.stage >= 1 : last.stage >= 2) : false;
              return <div key={s} className={`ck ${done ? "ok" : ""}`}><span>{i + 1}</span>{s}</div>;
            })}
            {last && <div className="cklast">{last.type} #{last.seq} · zone {last.zone} · by {last.channel === "ble" ? "Bluetooth" : "sound"}{last.incident ? ` · ${last.incident}${last.rung === "hand" ? ", needs a person" : ""}` : ""}</div>}
          </div>
        </section>
        <section className="npanel">
          <h2>Log</h2>
          <div className="nlog">{!log.length && <div className="muted">Nothing yet.</div>}{log.map((l, i) => <div key={i} className={`nl ${l.kind}`}><time>{l.at}</time><span>{l.text}</span></div>)}</div>
        </section>
      </div>
    </div>
  );
}
