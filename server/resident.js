// Resident calls and delivery receipts.
// A resident capability only opens its own call.
// Spec: docs/BUILD_SPEC.md §6.3, docs/IMPLEMENTATION_PLAN.md §3.3.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { makePacket } from "./schema.js";
import { getKit, showKitCard } from "./kits.js";
import { validateEnvelope } from "../app/relay-protocol.js";
import { triageSelfReport } from "./triage.js";
import { scanTurn } from "./triggers.js";
import { readFrame, frameKey, RELAY_WINDOW_MS } from "./relay.js";
import { config } from "./config.js";

const secret = () => randomBytes(32).toString("hex");
const equal = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createResidentApi({ store, engine, hub, fetchImpl = fetch }) {
  const capabilities = new Map(); // call_id → { token, expires }
  const creationTimes = new Map(); // IP → [ts]
  const starting = new Set();     // packet_ids currently mid-setup

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };

  const body = async (req) => {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 8192) throw Object.assign(new Error("Request too large"), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
    catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
  };

  const liveReady = () =>
    process.env.RESIDENT_LIVE_ENABLED === "true" &&
    !!process.env.RETELL_API_KEY &&
    !!process.env.RETELL_AGENT_ID &&
    !!process.env.RESIDENT_ACCESS_CODE;

  const auth = (req, id) => {
    const cap = capabilities.get(id);
    return cap && cap.expires > Date.now() &&
      equal((req.headers.authorization || "").replace(/^Bearer /, ""), cap.token);
  };

  const snapshot = (id) => {
    const c = store.calls.find((x) => x.id === id);
    const session = hub.sessions.get(id);
    const shown = store.kitShows.filter((x) => x.call_id === id && !x.closed_at).at(-1);
    const kit = shown && getKit(shown.kit_id);
    const allowed = kit && (c?.resident_demo || kit.medical_review !== "pending");
    return {
      id, status: !c || c.ended_at ? "ended" : session ? "connected" : "connecting",
      started_at: c?.started_at, ended_at: c?.ended_at,
      demo: !!c?.resident_demo, line: c?.resident_line,
      dispatcher_connected: !!c?.dispatcher_id,
      kit: allowed ? { ...kit, show_id: shown.id } : null,
      messages: store.turns.filter((t) => t.call_id === id).slice(-40)
        .map((t) => ({ id: t.id, role: t.role, text: t.text_translated || t.text_original })),
    };
  };

  function finish(id) {
    const s = hub.sessions.get(id);
    if (s?.residentDemo) s.ws.close();
    const c = store.calls.find((x) => x.id === id);
    if (c && !c.ended_at) {
      c.ended_at = new Date().toISOString(); c.status = "ended";
      store.appendEvent({ event_type: "call_ended", call_id: id, actor: "device", provenance: "firsthand", payload_json: {} });
      store.save();
    }
  }

  function receive(envelope, source, gatewayId) {
    const error = validateEnvelope(envelope);
    if (error) return { status: 400, value: { error } };

    // Idempotent: return the same receipt for a retried message_id
    const old = store.events.find(
      (e) => e.event_type === "resident_report_received" && e.payload_json?.message_id === envelope.message_id
    );
    if (old) return { status: 200, value: { ...old.payload_json.receipt, duplicate: true } };

    // Optional radio frame: verify signature and cross-check fields
    let radioKey = null, frame = null;
    if (envelope.frame_b64) {
      frame = readFrame(envelope.frame_b64, config.frameKey);
      if (!frame.ok) return { status: 400, value: { error: frame.error } };
      if (
        frame.type !== (envelope.type === "beacon" ? "sos" : "checkin") ||
        frame.target !== envelope.target ||
        frame.severity !== envelope.severity ||
        frame.action !== envelope.action ||
        frame.fields.zone_id !== envelope.zone_id
      ) return { status: 400, value: { error: "Radio frame does not match this report" } };

      radioKey = frameKey({ frame_b64: envelope.frame_b64 });
      const prior = store.relays?.[radioKey];
      const packet = prior && Date.now() - prior.first_ms <= RELAY_WINDOW_MS &&
        store.packets.find((p) => p.packet_id === prior.packet_id);
      if (packet) {
        const receipt = { version: 1, message_id: envelope.message_id, state: "dashboard_received", packet_id: packet.packet_id, incident_id: packet.incident_id || null, received_at: new Date().toISOString() };
        store.appendEvent({ event_type: "resident_report_received", packet_id: packet.packet_id, actor: "device", provenance: "forwarded", payload_json: { message_id: envelope.message_id, receipt } });
        store.save();
        return { status: 200, value: { ...receipt, duplicate: true } };
      }
    }

    const { packet, errors } = makePacket({
      source,
      identifier: envelope.device_id,
      zone_id: envelope.zone_id,
      target: envelope.target,
      severity: envelope.severity,
      action: envelope.action,
      text: envelope.text,
      provenance: source === "app" ? "firsthand" : "forwarded",
      ts_device: envelope.created_at,
    });
    if (errors.length) return { status: 400, value: { error: errors.join("; ") } };

    packet.request_kind = envelope.type === "beacon" ? "help_request" : "report";
    packet.intake_pending = envelope.type === "beacon";
    packet.relay_message_id = envelope.message_id;
    packet.relay_gateway_id = gatewayId || null;

    const triggers = scanTurn(envelope.text);
    if (envelope.type === "beacon") triggers.hard = [...new Set([...triggers.hard, "sos_beacon"])];
    triageSelfReport(packet, triggers);

    if (frame) {
      packet.frame_type = frame.type;
      packet.frame_sequence = frame.sequence;
      packet.delivered_at = new Date().toISOString();
    }

    const out = engine.ingest(packet, { triggers });
    if (radioKey) {
      store.relays ||= {};
      store.relays[radioKey] = { packet_id: packet.packet_id, heard_by: [], hearings: [], first_ms: Date.now() };
    }

    const receipt = { version: 1, message_id: envelope.message_id, state: "dashboard_received", packet_id: packet.packet_id, incident_id: out.incident?.id || null, received_at: new Date().toISOString() };
    store.appendEvent({ event_type: "resident_report_received", packet_id: packet.packet_id, actor: "device", provenance: packet.provenance, payload_json: { message_id: envelope.message_id, gateway_id: gatewayId || null, receipt } });
    store.save();
    return { status: 201, value: receipt };
  }

  return async (req, res, url) => {
    if (!url.pathname.startsWith("/resident/") && url.pathname !== "/relay/ingest") return false;
    try {
      const p = url.pathname;

      if (p === "/resident/config" && req.method === "GET") {
        send(res, 200, { live_available: liveReady(), demo_available: true });
        return true;
      }

      if (p === "/resident/reports" && req.method === "POST") {
        const result = receive(await body(req), "app");
        send(res, result.status, result.value);
        return true;
      }

      if (p === "/relay/ingest" && req.method === "POST") {
        const token = (req.headers.authorization || "").replace(/^Bearer /, "");
        if (!process.env.RELAY_GATEWAY_TOKEN || !equal(token, process.env.RELAY_GATEWAY_TOKEN)) {
          send(res, 401, { error: "Gateway authentication required" }); return true;
        }
        const b = await body(req);
        if (typeof b.gateway_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.gateway_id)) {
          send(res, 400, { error: "Invalid gateway_id" }); return true;
        }
        const result = receive(b.envelope, "ehawk", b.gateway_id);
        send(res, result.status, result.value);
        return true;
      }

      if (p === "/resident/calls" && req.method === "POST") {
        const b = await body(req);
        if (!["demo", "live"].includes(b.mode) || !["emergency", "nonemergency"].includes(b.line)) {
          send(res, 400, { error: "Choose a call mode and line" }); return true;
        }
        const now = Date.now();
        // Evict expired capabilities
        for (const [key, cap] of capabilities) {
          if (cap.expires < now) {
            if (store.calls.find((c) => c.id === key)?.resident_demo) finish(key);
            capabilities.delete(key);
          }
        }
        // Rate-limit per IP
        const ip = req.socket.remoteAddress || "local";
        const recent = (creationTimes.get(ip) || []).filter((t) => t > now - 60000);
        if (recent.length >= 6) { send(res, 429, { error: "Please wait a minute before starting another call" }); return true; }
        creationTimes.set(ip, [...recent, now]);

        if (b.mode === "live" && (!liveReady() || !equal(b.access_code, process.env.RESIDENT_ACCESS_CODE))) {
          send(res, 403, { error: "Live calls need an enabled agent and the pilot access code" }); return true;
        }

        // Save the request before contacting the voice provider.
        // Loss of audio must not hide a request for help.
        let received = null;
        if (b.line === "emergency") {
          const request = b.request || {
            version: 1, message_id: randomUUID(), device_id: "app-" + randomUUID(),
            type: "beacon", zone_id: "unknown", target: "person", severity: 3, action: "unknown",
            text: "Emergency help requested from the app",
            created_at: new Date(now).toISOString(), expires_at: new Date(now + 600000).toISOString(),
          };
          if (request.type !== "beacon") { send(res, 400, { error: "Emergency calls require a help request" }); return true; }
          received = receive(request, "app");
          if (received.status >= 400) { send(res, received.status, received.value); return true; }
        }

        const packetId = received?.value.packet_id;
        if (packetId && (starting.has(packetId) || store.calls.some((c) => c.request_packet_id === packetId && !c.ended_at))) {
          send(res, 409, { error: "This emergency request already has a call starting or connected.", receipt: received.value }); return true;
        }
        if (packetId) starting.add(packetId);
        try {
          let id, connection;
          if (b.mode === "live") {
            const r = await fetchImpl("https://api.retellai.com/v3/create-web-call", {
              method: "POST",
              headers: { authorization: `Bearer ${process.env.RETELL_API_KEY}`, "content-type": "application/json" },
              body: JSON.stringify({ agent_id: process.env.RETELL_AGENT_ID, metadata: { source: "resident_app", line: b.line, language: "en" } }),
              signal: AbortSignal.timeout(15000),
            });
            if (!r.ok) {
              send(res, 502, { error: received ? "Your emergency request reached the dashboard, but the voice call could not connect." : "The voice service could not start the call. Please try again." });
              return true;
            }
            connection = await r.json();
            id = connection.call_id;
            if (!id || !connection.access_token) throw new Error("Voice service returned incomplete connection details");
          } else {
            id = `app_demo_${randomBytes(8).toString("hex")}`;
          }

          const token = secret();
          capabilities.set(id, { token, expires: now + 4 * 3600000 });

          if (b.mode === "demo") {
            // Simulate a WebSocket so the demo call works without Retell
            const ws = new EventEmitter();
            ws.readyState = 1;
            ws.send = (raw) => {
              const msg = JSON.parse(raw);
              if (msg.response_type === "agent_interrupt" && msg.content) {
                store.appendEvent({ event_type: "resident_audio", call_id: id, actor: "dispatcher", provenance: "simulated", payload_json: {} });
              }
            };
            ws.close = () => { if (ws.readyState === 1) { ws.readyState = 3; ws.emit("close"); } };
            hub.onConnection(ws, id);
            const s = hub.sessions.get(id);
            s.residentDemo = true;
            hub.absorbTranscript(s, [{ role: "agent", content: "This is a demo call. Tell me what you need help with, or open the dispatcher console to join and send instructions." }]);
          }

          let c = store.calls.find((x) => x.id === id);
          if (!c) { c = { id, started_at: new Date().toISOString(), status: "active", language: "en", ended_at: null }; store.calls.push(c); }

          if (received) {
            const packet = store.packets.find((p) => p.packet_id === received.value.packet_id);
            packet.call_id = id;
            packet.request_kind = "emergency_call";
            c.request_packet_id = packet.packet_id;
            store.appendEvent({ event_type: "resident_request_linked", call_id: id, packet_id: packet.packet_id, incident_id: packet.incident_id, actor: "device", provenance: packet.provenance, payload_json: {} });
          }

          Object.assign(c, { language: "en", direction: "web", resident_demo: b.mode === "demo", resident_line: b.line });
          store.save();
          send(res, 201, { ...(connection || {}), call_id: id, resident_token: token, demo: b.mode === "demo", receipt: received?.value });
          return true;
        } finally {
          if (packetId) starting.delete(packetId);
        }
      }

      const match = /^\/resident\/calls\/([^/]+)(?:\/(message|end))?$/.exec(p);
      if (match) {
        const [, id, action] = match;
        if (!auth(req, id)) { send(res, 403, { error: "This call belongs to another session or has expired" }); return true; }

        if (!action && req.method === "GET") { send(res, 200, snapshot(id)); return true; }

        if (action === "end" && req.method === "POST") {
          const s = hub.sessions.get(id);
          // Real audio is ended by the SDK; never pretend an HTTP request disconnected Retell
          if (s && !s.residentDemo) { send(res, 409, { error: "End the voice connection before closing this call" }); return true; }
          finish(id);
          send(res, 200, snapshot(id));
          return true;
        }

        if (action === "message" && req.method === "POST") {
          const s = hub.sessions.get(id);
          if (!s?.residentDemo) { send(res, 409, { error: "Text input is available only during a demo call" }); return true; }
          const b = await body(req);
          const text = typeof b.text === "string" ? b.text.trim().slice(0, 1000) : "";
          if (!text) { send(res, 400, { error: "Enter a message" }); return true; }
          hub.absorbTranscript(s, [...s.transcript, { role: "user", content: text }]);
          const existing = store.packets.find((p) => p.call_id === id);
          if (existing && /bleed/i.test(text)) {
            engine.refine(existing, { target: "person", severity: 5, action: "dispatch_ems", content_status: "partial" }, { hard: ["severe_bleeding"], soft: [] });
          }
          if (!s.packetSent && !existing) {
            const { packet } = makePacket({ source: "app", identifier: id, call_id: id, zone_id: "unknown", target: /bleed/i.test(text) ? "person" : "unknown", severity: /bleed/i.test(text) ? 5 : 2, action: /bleed/i.test(text) ? "dispatch_ems" : "info_only", provenance: "simulated", content_status: "partial" });
            engine.ingest(packet, {});
            s.packetSent = true;
          }
          if (!s.dispatcherJoined) {
            if (/bleed/i.test(text)) showKitCard({ kit_id: "EH-BLEED-001", call_id: id }, store, "ai");
            hub.absorbTranscript(s, [...s.transcript, { role: "agent", content: /bleed/i.test(text) ? "I have opened the bleeding kit preview. A dispatcher can join this same demo call." : "Your demo report is visible in the dashboard. A dispatcher can join this call and send a kit." }]);
          }
          store.save();
          send(res, 200, snapshot(id));
          return true;
        }
      }

      send(res, 404, { error: "Not found" });
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : "The connection could not be completed" });
    }
    return true;
  };
}
