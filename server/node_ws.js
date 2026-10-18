// WebSocket endpoint for the ESP32 relay node (firmware: relay_node.ino, protocol: firmware/relay_node/PROTOCOL.md).
// The node connects to wss://<host>/node and sends JSON text frames; the server answers every alert and cancel with
// {"type":"ack","event_id"} once the report is on the board. Until it is acked, the node resends every 5 s, so a
// dropped connection is safe: the same event_id maps to the same sequence and the server counts it once.
//
// Trust note: this node does not sign the 16-byte frame itself; the server signs it on the node's behalf when the
// alert arrives over the authenticated-by-nothing-but-Wi-Fi socket. The packet carries provenance "forwarded" and
// payload signed_by "gateway" so the board can tell it apart from a tag-signed report.
import { WebSocketServer } from "ws";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { encodeFrame, toBase64 } from "../device/frame.js";

const SERVICE = {
  call_center: { target: "person", action: "welfare_check", severity: 5 },
  police:      { target: "crime", action: "dispatch_police", severity: 5 },
  ambulance:   { target: "person", action: "dispatch_ems", severity: 5 },
  hospital:    { target: "person", action: "dispatch_ems", severity: 4 },
};
// TARGET/ACTION codes the 16-byte frame can carry (device/frame.js); "crime" is not in the frame table, so it rides as person
const FRAME_TARGET = (t) => (["person", "power", "water", "gas", "power_line", "structure_fire", "wildfire", "road", "flood", "vehicle"].includes(t) ? t : "person");

/** event_id -> 16-bit sequence, stable so resends dedupe to one report. */
export const sequenceOf = (eventId) => createHash("sha256").update(String(eventId)).digest().readUInt16BE(0);

export function attachNodeSocket(server, { store, zone = 6 } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const nodes = new Map(); // ws -> { node_id, mic }
  server.on("upgrade", (req, socket, head) => {
    if (!/^\/node(\?|$)/.test(req.url)) return;
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws) {
    nodes.set(ws, { node_id: "", mic: false, audio: false });
    ws.on("message", (data, isBinary) => {
      const n = nodes.get(ws);
      if (isBinary) { if (!n.audio) { n.audio = true; console.log(`[node ${n.node_id}] audio frames arriving (not stored in this build)`); } return; }
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      const nodeId = String(msg.node_id || n.node_id || "relay-node").slice(0, 40);
      n.node_id = nodeId;
      if (msg.type === "hello") {
        n.mic = !!msg.mic;
        store.appendEvent({ event_type: "node_connected", actor: "device", provenance: "forwarded", payload_json: { node_id: nodeId, mic: n.mic, channel: "wifi" } });
        return;
      }
      if (msg.type === "alert") {
        const svc = SERVICE[msg.service] || SERVICE.call_center;
        const sequence = sequenceOf(msg.event_id);
        const frame = encodeFrame({ type: "sos", zone, target: FRAME_TARGET(svc.target), severity: svc.severity, action: svc.action, language: "en", sequence }, config.frameKey);
        const out = server.devicePacket({ node_id: nodeId, channel: "wifi", frame_b64: toBase64(frame), signed_by: "gateway", service: msg.service, event_id: String(msg.event_id || "") });
        if (out.status === 201 || out.status === 200) {
          ws.send(JSON.stringify({ type: "ack", event_id: msg.event_id }));
          console.log(`[node ${nodeId}] alert ${msg.event_id} -> ${out.body.duplicate ? "already on the board" : `incident ${out.body.incident_id}`}, acked`);
        } else {
          console.error(`[node ${nodeId}] alert ${msg.event_id} refused: ${JSON.stringify(out.body)} (not acked; node will retry)`);
        }
        return;
      }
      if (msg.type === "cancel") {
        const out = server.deviceCancel({ sequence: sequenceOf(msg.ref_event_id), node_id: nodeId });
        ws.send(JSON.stringify({ type: "ack", event_id: msg.event_id })); // ack either way so the node stops repeating
        console.log(`[node ${nodeId}] cancel of ${msg.ref_event_id}: ${out.status === 200 ? `noted on ${out.body.incident_id}` : out.body.error}`);
        return;
      }
      if (msg.type === "audio_start" || msg.type === "audio_stop") {
        n.audio = false;
        store.appendEvent({ event_type: msg.type === "audio_start" ? "node_audio_started" : "node_audio_stopped", actor: "device", provenance: "forwarded", payload_json: { node_id: nodeId, event_id: String(msg.event_id || "") } });
        if (msg.type === "audio_start") ws.send(JSON.stringify({ type: "stop_audio" })); // audio is not stored in this build
      }
    });
    ws.on("close", () => nodes.delete(ws));
    ws.on("error", () => nodes.delete(ws));
  }
  return { wss, nodes };
}
