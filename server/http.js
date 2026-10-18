// HTTP API, SSE event stream, Retell webhook, static UIs. No framework — node:http only.
// Spec: docs/BUILD_SPEC.md §6, docs/API.md.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { config } from "./config.js";
import { makePacket } from "./schema.js";
import { scheduleCallback, recordCallback, openCallbacks } from "./callbacks.js";
import { catalog, getKit, showKitCard } from "./kits.js";
import { scanTurn } from "./triggers.js";
import { encodeFrame, toBase64, TARGET_CODES, ACTION_CODES, LANG_CODES } from "../device/frame.js";
import { parseSameHeader, actionForEvent } from "./same_decoder.js";
import { runReplay, availableDays } from "./replay.js";
import { Broadcasts, AGENCIES, KINDS } from "./broadcasts.js";
import { LANGUAGES } from "./languages.js";
import { initUnit, setUnitStatus, unitBoard, closeWithDisposition, updatesForDevice, addStop, DISPOSITIONS, WATCHDOG_S } from "./units.js";
import { triageSelfReport } from "./triage.js";
import { recordHearing, rememberFirst, zoneOfNode, readFrame, ackFrame, DEMO_NODES } from "./relay.js";
import { researchRows, toCsv } from "./research.js";
import { translate } from "./llm.js";
import { createResidentApi } from "./resident.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".csv": "text/csv", ".png": "image/png",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
};

// -------------------------------------------------------------------------
// Retell webhook signature (retell-sdk 6.2.7 lib/webhook_auth.js compatible)
// Header: x-retell-signature = "v=<unix ms>,d=<hex HMAC-SHA256(rawBody + timestamp)>"
// Secret: the Retell API key. Rejected when |now – timestamp| > 5 minutes.
// Constant-time compare to prevent timing attacks.
// -------------------------------------------------------------------------
export function verifyRetellSignature(rawBody, signatureHeader, secret, { now = Date.now(), timeoutMs = 5 * 60 * 1000 } = {}) {
  if (!secret || !signatureHeader) return false;
  const m = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(String(signatureHeader).trim());
  if (!m) return false;
  const ts = Number(m[1]);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > timeoutMs) return false;
  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(rawBody), Buffer.from(String(ts))]))
    .digest();
  try { return timingSafeEqual(Buffer.from(m[2], "hex"), expected); } catch { return false; }
}

/** Build a Retell-format signature header (used in tests and the fake webhook sender). */
export function signRetellWebhook(rawBody, secret, ts = Date.now()) {
  return `v=${ts},d=${createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(rawBody), Buffer.from(String(ts))]))
    .digest("hex")}`;
}

// -------------------------------------------------------------------------
// HTTP server factory
// -------------------------------------------------------------------------
export function createHttpServer({ store, engine, hub }) {
  const resident = createResidentApi({ store, engine, hub });
  const sseClients = new Set();
  const broadcasts = new Broadcasts(store, { frameKey: config.frameKey });

  // Offline phrasebook: what a device says for each signed directive
  const PHRASES = {
    evacuate:          "Evacuate now. Take your bag and your people. Leave the zone.",
    shelter_in_place:  "Shelter in place. Close windows and doors. Stay inside until the all clear.",
    all_clear:         "All clear. You can return to normal activity.",
    info_only:         "Information notice. Open the EchoHawk app for details.",
  };
  const phraseCache = {};

  // Broadcast every stored event to SSE subscribers
  store.onEvent((ev) => {
    const data = `event: ${ev.event_type}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of sseClients) res.write(data);
  });

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  // Role from Bearer token or ?token= query parameter
  const role = (req) => {
    const tok =
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "") ||
      new URL(req.url, "http://x").searchParams.get("token");
    if (tok === config.tokens.agency) return "agency";
    if (tok === config.tokens.supervisor) return "supervisor";
    if (tok === config.tokens.dispatcher) return "dispatcher";
    return "anon";
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
      return res.end();
    }

    try {
      // Resident / relay API (returns false when path does not match)
      if (await resident(req, res, url)) return;

      // ── health ────────────────────────────────────────────────────────────
      if (path === "/health") {
        return json(res, 200, {
          ok: true, calls_active: hub.sessions.size,
          requests_open: store.packets.filter((p) => store.incidents.some((i) => i.id === p.incident_id && !i.closed_at)).length +
            store.calls.filter((c) => !c.ended_at && !store.packets.some((p) => p.call_id === c.id)).length,
          paid_concurrency: config.paidConcurrency, mode: hub.mode(),
        });
      }

      // ── Retell webhook ────────────────────────────────────────────────────
      if (path === "/webhooks/retell" && method === "POST") {
        const raw = await readBody(req);
        if (!verifyRetellSignature(raw, req.headers["x-retell-signature"], config.retellWebhookSecret)) {
          store.appendEvent({ event_type: "webhook_rejected", actor: "system", provenance: "firsthand", payload_json: { reason: "bad signature" } });
          return json(res, 401, { error: "bad signature" });
        }
        let body = {};
        try { body = JSON.parse(raw.toString()); } catch {}
        const ev = body.event; const call = body.call || {};
        store.appendEvent({ event_type: `retell_${ev}`, call_id: call.call_id || null, actor: "system", provenance: "firsthand", payload_json: { status: call.call_status, analysis: ev === "call_analyzed" ? call.call_analysis : undefined } });
        if (ev === "call_analyzed" && call.call_analysis?.custom_analysis_data) {
          const pk = store.packets.find((p) => p.call_id === call.call_id);
          if (pk && !pk.human_edited) {
            const a = call.call_analysis.custom_analysis_data;
            pk.post_call = a;
            store.appendEvent({ event_type: "packet_reconciled", packet_id: pk.packet_id, call_id: call.call_id, actor: "system", provenance: "firsthand", payload_json: a });
          }
        }
        return json(res, 200, { ok: true });
      }

      // ── device packets (node relay) ───────────────────────────────────────
      // One chirp heard by several nodes counts once; which nodes heard narrows location.
      const devicePacket = (body) => {
        let frame = null;
        if (body.frame_b64) {
          frame = readFrame(body.frame_b64, config.frameKey);
          if (!frame.ok) {
            store.appendEvent({ event_type: "frame_rejected", actor: "device", provenance: "forwarded", payload_json: { node_id: String(body.node_id || ""), error: frame.error } });
            return { status: 400, body: { error: frame.error } };
          }
        }
        // Signed ack back to the sender: "delivered to dispatch"
        const receipt = frame && body.node_id
          ? toBase64(ackFrame({ stage: "delivered", sequence: frame.sequence, node: String(body.node_id), language: frame.language }, config.frameKey))
          : null;
        const hearing = recordHearing(store, body);
        if (hearing.duplicate) {
          return { status: 200, body: { duplicate: true, packet_id: hearing.packet?.packet_id || null, incident_id: hearing.packet?.incident_id || null, heard_by: hearing.heard_by, approx_area: hearing.packet?.approx_area || null, picked_up: hearing.packet?.picked_up || null, ack_b64: receipt } };
        }
        const input = frame ? { ...frame.fields, ...body, ...frame.fields } : body;
        const zone = input.zone_id || zoneOfNode(hearing.node) || undefined;
        const { packet, errors } = makePacket({ ...input, zone_id: zone, source: body.source || "ehawk", provenance: body.provenance || "forwarded" });
        if (errors.length) return { status: 400, body: { errors } };
        const triggers = input.text ? scanTurn(input.text) : { hard: [], soft: [] };
        if (frame?.type === "sos") triggers.hard = [...new Set([...triggers.hard, "sos_beacon"])];
        triageSelfReport(packet, triggers);
        packet.packet_id ||= store.nextId("pk");
        rememberFirst(store, hearing.key, hearing.node, packet, Date.now(), hearing.channel);
        if (frame) {
          packet.request_kind = frame.type === "sos" ? "help_request" : "report";
          packet.intake_pending = frame.type === "sos";
          packet.frame_type = frame.type;
          packet.frame_sequence = frame.sequence;
          packet.delivered_at = new Date().toISOString();
        }
        const out = engine.ingest(packet, { triggers });
        if (frame && hearing.node) {
          store.appendEvent({ event_type: "report_picked_up", packet_id: packet.packet_id, incident_id: out.incident?.id || null, actor: "device", provenance: "forwarded", payload_json: { node_id: hearing.node, channel: hearing.channel, sequence: frame.sequence, zone_id: packet.zone_id } });
        }
        return { status: 201, body: { packet_id: packet.packet_id, incident_id: out.incident?.id || null, rung: out.rung, severity: packet.severity, triage_note: packet.triage_note || null, heard_by: packet.heard_by || [], approx_area: packet.approx_area || null, picked_up: packet.picked_up || null, ack_b64: receipt } };
      };

      // ── demo endpoints ────────────────────────────────────────────────────
      if (path === "/demo/reset" && method === "POST") {
        if (role(req) !== "supervisor") return json(res, 401, { error: "supervisor sign-in required" });
        const cleared = {};
        for (const t of ["calls", "turns", "packets", "incidents", "events", "kitShows", "callbacks", "zoneWindows", "costMeter", "broadcasts", "alerts"]) {
          cleared[t] = (store[t] || []).length; store[t] = [];
        }
        store.relays = {};
        store.save();
        store.appendEvent({ event_type: "demo_reset", actor: "supervisor", provenance: "firsthand", payload_json: { cleared } });
        return json(res, 200, { ok: true, cleared });
      }

      if (path === "/nodes" && method === "GET") return json(res, 200, { simulated: true, nodes: DEMO_NODES });

      if (path === "/demo/relay" && method === "POST") {
        const frame_id = `demo-${Date.now()}`;
        const results = [];
        for (const node_id of ["N-0812-A", "N-0812-B", "N-0812-C"]) {
          results.push(devicePacket({ frame_id, node_id, identifier: "demo-phone-relay", target: "person", severity: 5, action: "welfare_check", text: "trapped, can't get out", content_status: "extracted" }).body);
        }
        return json(res, 201, { ok: true, results });
      }

      // ── packets and incidents ─────────────────────────────────────────────
      if (path === "/packets" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const { packet, errors } = makePacket(body);
        if (errors.length) return json(res, 400, { errors });
        const triggers = body.text ? scanTurn(body.text) : { hard: [], soft: [] };
        triageSelfReport(packet, triggers);
        const out = engine.ingest(packet, { triggers });
        return json(res, 201, { packet_id: packet.packet_id, incident_id: out.incident?.id || null, rung: out.rung, reason: out.reason, severity: packet.severity, triage_note: packet.triage_note || null });
      }

      if (path === "/device/packets" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = devicePacket(body);
        return json(res, out.status, out.body);
      }

      if (path === "/incidents" && method === "GET") {
        const rung = url.searchParams.get("rung");
        let list = engine.ranked();
        if (rung) list = list.filter((i) => i.rung === rung);
        return json(res, 200, list);
      }
      if (path.startsWith("/incidents/") && method === "GET" && !path.match(/\/incidents\/[^/]+\//)) {
        const id = path.split("/")[2];
        const inc = store.incidents.find((i) => i.id === id);
        if (!inc) return json(res, 404, { error: "not found" });
        return json(res, 200, { ...inc, keys: undefined, packets: store.packets.filter((p) => p.incident_id === id), events: store.events.filter((e) => e.incident_id === id) });
      }
      if (path.match(/^\/incidents\/[^/]+\/ack$/) && method === "POST") {
        const id = path.split("/")[2]; const r = role(req);
        if (r === "anon") return json(res, 401, { error: "token" });
        store.appendEvent({ event_type: "acknowledged_by_human", incident_id: id, actor: r, provenance: "firsthand", payload_json: {} });
        return json(res, 200, { ok: true });
      }
      if (path.match(/^\/incidents\/[^/]+\/close$/) && method === "POST") {
        const id = path.split("/")[2]; const r = role(req);
        if (r === "anon") return json(res, 401, { error: "token" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = engine.close(id, r, body.reason || "");
        return json(res, out.ok ? 200 : out.status, out);
      }
      if (path.match(/^\/incidents\/[^/]+\/callback$/) && method === "POST") {
        const id = path.split("/")[2];
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const row = scheduleCallback(store, id, Number(body.attempt_no) || 1);
        return json(res, 201, row);
      }
      if (path.match(/^\/incidents\/[^/]+\/dispatch$/) && method === "POST") {
        const id = path.split("/")[2]; const r = role(req);
        if (r === "anon") return json(res, 401, { error: "token" });
        const inc = store.incidents.find((i) => i.id === id);
        if (!inc) return json(res, 404, { error: "not found" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const units = (Array.isArray(body.units) ? body.units : [body.units]).filter((u) => ["ems", "fire", "police", "utility", "callback"].includes(u));
        if (!units.length) return json(res, 400, { error: "units: ems | fire | police | utility | callback" });
        const at = new Date().toISOString();
        inc.dispatched = [...(inc.dispatched || []), ...units.map((u) => initUnit({ unit: u, at, by: r, note: String(body.note || "").slice(0, 200) }))];
        store.appendEvent({ event_type: "units_dispatched", incident_id: id, actor: r, provenance: "firsthand", payload_json: { units, zone_id: inc.zone_id, target: inc.target, note: body.note || "" } });
        store.save();
        return json(res, 200, { ok: true, dispatched: inc.dispatched });
      }
      if (path.match(/^\/calls\/[^/]+\/flag$/) && method === "POST") {
        const id = path.split("/")[2]; const r = role(req);
        if (r === "anon") return json(res, 401, { error: "token" });
        const c = store.calls.find((x) => x.id === id);
        if (!c) return json(res, 404, { error: "not found" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const flag = String(body.flag || "review").slice(0, 40);
        c.flags = [...(c.flags || []), { flag, at: new Date().toISOString(), by: r }];
        store.appendEvent({ event_type: "call_flagged", call_id: id, actor: r, provenance: "firsthand", payload_json: { flag } });
        store.save();
        return json(res, 200, { ok: true, flags: c.flags });
      }

      if (path === "/demo/call" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const scenario = ["spanish_water", "spanish", "water", "bleeding", "breathing"].includes(body.scenario) ? body.scenario : "spanish_water";
        const { spawn } = await import("node:child_process");
        const child = spawn(process.execPath, [join(root, "server/fake_retell_client.js"), `ws://127.0.0.1:${config.port}`, scenario, "--hold", "180"], { cwd: root, stdio: "ignore", detached: true });
        child.unref();
        return json(res, 202, { ok: true, scenario, hold_seconds: 180 });
      }
      if (path === "/demo/surge" && method === "POST") {
        const { replayScript } = await import("./seed.js");
        replayScript(`http://127.0.0.1:${config.port}`).catch((e) => console.error("surge", e.message));
        return json(res, 202, { ok: true, calls: 20 });
      }

      // ── public alerts ─────────────────────────────────────────────────────
      if (path === "/phrasebook" && method === "GET") {
        const lang = url.searchParams.get("lang") || "en";
        const src = PHRASES;
        if (lang === "en" || !LANGUAGES.some((l) => l.code === lang)) return json(res, 200, { lang: "en", machine: false, phrases: src });
        if (!phraseCache[lang]) {
          const entries = await Promise.all(Object.entries(src).map(async ([k, v]) => [k, await Promise.race([translate(v, lang, "en"), new Promise((r) => setTimeout(() => r(null), 8000))]).catch(() => null)]));
          if (entries.every(([, v]) => v && !v.startsWith(`[${lang}]`))) phraseCache[lang] = Object.fromEntries(entries);
          else return json(res, 200, { lang: "en", machine: false, phrases: src, note: "translation unavailable right now" });
        }
        return json(res, 200, { lang, machine: true, phrases: phraseCache[lang] });
      }
      if (path === "/languages" && method === "GET") return json(res, 200, LANGUAGES);
      if (path === "/agencies" && method === "GET") return json(res, 200, { agencies: AGENCIES, kinds: KINDS });
      if (path === "/agency/login" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const ag = AGENCIES.find((a) => a.id === body.agency);
        if (!ag || !String(body.name || "").trim()) return json(res, 400, { error: "pick your agency and enter your name" });
        if (body.passcode !== config.tokens.agency) {
          store.appendEvent({ event_type: "agency_login_failed", actor: "agency", provenance: "firsthand", payload_json: { agency: ag.id, name: String(body.name).slice(0, 60) } });
          return json(res, 401, { error: "wrong passcode" });
        }
        store.appendEvent({ event_type: "agency_login", actor: "agency", provenance: "firsthand", payload_json: { agency: ag.id, name: String(body.name).slice(0, 60) } });
        return json(res, 200, { ok: true, token: config.tokens.agency, agency: ag, name: String(body.name).slice(0, 60) });
      }

      const actorOf = (req) => {
        const r = role(req);
        const agency = AGENCIES.find((a) => a.id === req.headers["x-agency"]);
        return { role: r, agency: r === "agency" ? agency?.name || "Agency" : "EchoHawk supervisor", name: String(req.headers["x-operator"] || (r === "supervisor" ? "Supervisor" : "")).slice(0, 60) };
      };

      if (path === "/broadcasts" && method === "GET") {
        if (role(req) === "anon") return json(res, 401, { error: "token" });
        return json(res, 200, broadcasts.list());
      }
      if (path === "/broadcasts" && method === "POST") {
        const a = actorOf(req);
        if (a.role !== "agency" && a.role !== "supervisor") return json(res, 401, { error: "agency or supervisor sign-in required" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = broadcasts.create(body, a);
        return json(res, out.ok ? 201 : out.status, out);
      }
      if (path.match(/^\/broadcasts\/[^/]+\/send$/) && method === "POST") {
        const a = actorOf(req);
        if (a.role === "anon" || a.role === "dispatcher") return json(res, 401, { error: "agency or supervisor sign-in required" });
        const out = broadcasts.send(path.split("/")[2], a);
        return json(res, out.ok ? 200 : out.status, out);
      }
      if (path.match(/^\/broadcasts\/[^/]+\/cancel$/) && method === "POST") {
        const a = actorOf(req);
        if (a.role === "anon" || a.role === "dispatcher") return json(res, 401, { error: "agency or supervisor sign-in required" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = broadcasts.cancel(path.split("/")[2], a, body.reason);
        return json(res, out.ok ? 200 : out.status, out);
      }
      if (path === "/broadcasts/active" && method === "GET") {
        return json(res, 200, broadcasts.activeFor(url.searchParams.get("zone") || "", url.searchParams.get("lang") || "en"));
      }
      if (path.match(/^\/broadcasts\/[^/]+\/ack$/) && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = broadcasts.ack(path.split("/")[2], body.status);
        if (out.ok && body.status === "need_help" && body.zone) {
          const { packet, errors } = makePacket({ source: "app", identifier: String(body.device || "app-anon").slice(0, 60), zone_id: String(body.zone), target: "person", severity: 4, action: "welfare_check", content_status: "extracted", provenance: "firsthand", language: String(body.lang || "en") });
          if (!errors.length) out.incident_id = engine.ingest(packet, { triggers: { hard: ["asks_for_human"], soft: [] } }).incident?.id || null;
        }
        return json(res, out.ok ? 200 : out.status, out);
      }

      // ── units and dispositions ────────────────────────────────────────────
      if (path === "/units" && method === "GET") return json(res, 200, { units: unitBoard(store, Date.now(), engine.adjacency), watchdog_s: WATCHDOG_S, dispositions: DISPOSITIONS });
      if (path.match(/^\/incidents\/[^/]+\/units\/\d+\/status$/) && method === "POST") {
        const r = role(req); if (r === "anon") return json(res, 401, { error: "token" });
        const [,, id,, n] = path.split("/");
        const inc = store.incidents.find((i) => i.id === id); if (!inc) return json(res, 404, { error: "not found" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = setUnitStatus(store, inc, Number(n), body.status, r);
        return json(res, out.ok ? 200 : out.status, out);
      }
      if (path.match(/^\/incidents\/[^/]+\/units\/\d+\/stop$/) && method === "POST") {
        const r = role(req); if (r === "anon") return json(res, 401, { error: "token" });
        const [,, id,, n] = path.split("/");
        const inc = store.incidents.find((i) => i.id === id); if (!inc) return json(res, 404, { error: "not found" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const target = store.incidents.find((i) => i.id === body.incident_id);
        const out = addStop(store, inc, Number(n), target, r);
        return json(res, out.ok ? 200 : out.status, out);
      }
      if (path.match(/^\/incidents\/[^/]+\/disposition$/) && method === "POST") {
        const r = role(req); if (r === "anon") return json(res, 401, { error: "token" });
        const inc = store.incidents.find((i) => i.id === path.split("/")[2]); if (!inc) return json(res, 404, { error: "not found" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = closeWithDisposition(store, engine, inc, body.disposition, r, body.note || "");
        return json(res, out.ok ? 200 : out.status, out);
      }

      // ── history, research, misc ───────────────────────────────────────────
      if (path === "/history/rd" && method === "GET") {
        const f = join(root, "data/history_by_rd.json");
        if (!existsSync(f)) return json(res, 404, { error: "no history file" });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(await readFile(f));
      }
      if (path === "/research/export.csv" && method === "GET") {
        if (role(req) === "anon") return json(res, 401, { error: "token" });
        res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=echohawk_research_export.csv" });
        return res.end(toCsv(researchRows(store)));
      }

      if (path === "/my/updates" && method === "GET") return json(res, 200, updatesForDevice(store, url.searchParams.get("device") || "", url.searchParams.get("zone") || ""));
      if (path === "/zones/windows" && method === "GET") return json(res, 200, store.zoneWindows.slice(-2000));
      if (path.match(/^\/callbacks\/[^/]+\/result$/) && method === "POST") {
        const id = path.split("/")[2];
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = recordCallback(store, id, body.result);
        return json(res, out.ok ? 200 : out.status, out);
      }
      if (path === "/callbacks/open" && method === "GET") return json(res, 200, openCallbacks(store));

      // ── calls, transcripts, interpreter mode ──────────────────────────────
      if (path === "/calls" && method === "GET") {
        const active = url.searchParams.get("status") === "active";
        const calls = store.calls
          .filter((c) => !active || (!c.ended_at && (c.status === "active" || c.status === "transferred")))
          .map((c) => {
            const pk = store.packets.find((p) => p.call_id === c.id);
            const inc = pk?.incident_id ? store.incidents.find((i) => i.id === pk.incident_id) : null;
            return { ...c, source: pk?.source || (c.direction === "web" ? "app" : "voice"), intake_pending: pk?.intake_pending, target: pk?.target, severity: pk?.severity, zone_id: pk?.zone_id, rung: inc?.rung || null, elapsed_s: Math.round((Date.now() - new Date(c.started_at)) / 1000), action: pk?.action, incident_id: inc?.id || null, incident_target: inc?.target || null, incident_zone: inc?.zone_id || null, independent_count: inc?.independent_count || 0, incident_size: inc?.packet_ids?.length || 0, triggers: inc?.triggers || [], dispatched: inc?.dispatched || [], last_turns: store.turns.filter((t) => t.call_id === c.id).slice(-2).map((t) => ({ role: t.role, text: t.text_original, tr: t.text_translated || null })) };
          });
        return json(res, 200, calls);
      }
      if (path.match(/^\/calls\/[^/]+\/transcript$/) && method === "GET") {
        const id = path.split("/")[2];
        return json(res, 200, store.turns.filter((t) => t.call_id === id));
      }
      if (path.match(/^\/calls\/[^/]+\/takeover$/) && method === "POST") {
        const id = path.split("/")[2];
        if (role(req) === "anon") return json(res, 401, { error: "token" });
        const out = await hub.takeover(id, "console");
        return json(res, out.ok ? 200 : out.status, out);
      }
      if (path.match(/^\/calls\/[^/]+\/join$/) && method === "POST") {
        const id = path.split("/")[2];
        if (role(req) === "anon") return json(res, 401, { error: "token" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = hub.join(id, body.dispatcher_id || "dispatcher");
        return json(res, out.ok ? 200 : out.status, out);
      }
      if (path.match(/^\/calls\/[^/]+\/say$/) && method === "POST") {
        const id = path.split("/")[2];
        if (role(req) === "anon") return json(res, 401, { error: "token" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = await hub.say(id, body.text || "", body.lang_from || "en");
        return json(res, out.ok ? 200 : out.status, out);
      }
      if (path.match(/^\/calls\/[^/]+\/language$/) && method === "POST") {
        const id = path.split("/")[2];
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        hub.setLanguage(id, body.lang);
        return json(res, 200, { ok: true });
      }
      if (path.match(/^\/calls\/[^/]+\/kit$/) && method === "POST") {
        const id = path.split("/")[2];
        if (role(req) === "anon") return json(res, 401, { error: "token" });
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        if (!body.kit_id) {
          for (const shown of store.kitShows) if (shown.call_id === id && !shown.closed_at) shown.closed_at = new Date().toISOString();
          store.save();
          store.appendEvent({ event_type: "kit_changed_by_human", call_id: id, actor: "dispatcher", provenance: "firsthand", payload_json: { kit_id: null, action: "closed" } });
          return json(res, 200, { ok: true, closed: true });
        }
        const out = showKitCard({ kit_id: body.kit_id, call_id: id }, store, "dispatcher");
        if (out.ok) store.appendEvent({ event_type: "kit_changed_by_human", call_id: id, actor: "dispatcher", provenance: "firsthand", payload_json: { kit_id: body.kit_id } });
        return json(res, out.ok ? 200 : out.status, out);
      }

      if (path === "/events/stream" && method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        res.write(`event: hello\ndata: {}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (path === "/events" && method === "GET") return json(res, 200, store.events.slice(-500));

      // ── kits ──────────────────────────────────────────────────────────────
      if (path === "/kits" && method === "GET") return json(res, 200, catalog);
      if (path.startsWith("/kits/") && method === "GET") {
        const k = getKit(path.split("/")[2]);
        return k ? json(res, 200, k) : json(res, 404, { error: "not in catalog" });
      }
      if (path === "/tools/show_kit_card" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const out = showKitCard(body, store, "ai");
        return json(res, out.ok ? 200 : out.status, out);
      }

      // ── SAME alerts and frames ────────────────────────────────────────────
      if (path === "/alerts/same" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        let event_code = body.event_code, zone = body.zone, locations = body.locations;
        if (body.header) {
          const parsed = parseSameHeader(body.header);
          if (parsed.error) return json(res, 400, { error: parsed.error });
          event_code = parsed.event; zone = Number(parsed.locations[0]); locations = parsed.locations;
        }
        const action = actionForEvent(event_code);
        const seq = (store.alerts ||= []).length + 1;
        const frame = encodeFrame({ type: "directive", zone: Number(zone) || 0, target: body.target || "unknown", severity: event_code === "EVI" ? 5 : event_code === "SPW" ? 4 : 2, action, language: body.language || "en", sequence: seq }, config.frameKey);
        const alert = { id: store.nextId("al"), ...body, event_code, zone, locations, action, frame_b64: toBase64(frame), created_at: new Date().toISOString() };
        store.alerts.push(alert);
        store.appendEvent({ event_type: "alert_received", actor: "device", provenance: "firsthand", payload_json: { event_code, locations } });
        store.appendEvent({ event_type: "alert_revoiced", actor: "device", provenance: "firsthand", payload_json: { language: body.language || "en", action } });
        return json(res, 201, alert);
      }
      if (path.match(/^\/alerts\/directive\/[^/]+\/frame$/) && method === "GET") {
        const id = path.split("/")[3];
        const a = (store.alerts || []).find((x) => x.id === id);
        return a ? json(res, 200, { frame_b64: a.frame_b64 }) : json(res, 404, { error: "not found" });
      }
      if (path === "/frames/codes" && method === "GET") return json(res, 200, { TARGET_CODES, ACTION_CODES, LANG_CODES });

      // ── twists and cost ───────────────────────────────────────────────────
      if (path === "/twists" && method === "GET") return json(res, 200, store.twists);
      if (path === "/twists" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const row = { id: store.nextId("tw"), received_at: new Date().toISOString(), ...body };
        store.twists.push(row); store.save();
        return json(res, 201, row);
      }
      if (path === "/cost/meter" && method === "GET") {
        const minutes = store.calls.reduce((a, c) => a + ((new Date(c.ended_at || Date.now()) - new Date(c.started_at)) / 60000), 0);
        return json(res, 200, { ts: new Date().toISOString(), calls_active: hub.sessions.size, paid_concurrency: config.paidConcurrency, retell_cents_today: Math.round(minutes * 11), dispatcher_minutes_saved_est: Math.round(store.calls.filter((c) => c.status === "ended").length * 3), stream: hub.mode(), basis: "Retell ~ $0.11/min example rate; minutes saved assumes 3 per fully automated call (team judgment)" });
      }

      // ── map polygons ──────────────────────────────────────────────────────
      if (path === "/geo/rd" && method === "GET") {
        if (!existsSync(join(root, "data/rd_polygons.geojson"))) return json(res, 404, { error: "not cached yet" });
        const data = await readFile(join(root, "data/rd_polygons.geojson"));
        res.writeHead(200, { "content-type": "application/json" }); return res.end(data);
      }
      if (path === "/geo/rd" && method === "POST") {
        const raw = (await readBody(req)).toString();
        let gj; try { gj = JSON.parse(raw); } catch { return json(res, 400, { error: "bad json" }); }
        if (gj.type !== "FeatureCollection" || !Array.isArray(gj.features) || !gj.features.length || !("REPDIST" in (gj.features[0].properties || {}))) return json(res, 400, { error: "not an LAPD reporting district FeatureCollection" });
        await writeFile(join(root, "data/rd_polygons.geojson"), JSON.stringify(gj));
        return json(res, 201, { ok: true, features: gj.features.length });
      }

      // ── replay ────────────────────────────────────────────────────────────
      if (path === "/replay/days" && method === "GET") return json(res, 200, availableDays());
      if (path === "/replay/run" && method === "GET") {
        const out = runReplay(url.searchParams.get("date") || "2025-01-07", { fromHour: Number(url.searchParams.get("from") ?? 0), toHour: Number(url.searchParams.get("to") ?? 24) });
        return json(res, out.error ? 404 : 200, out);
      }

      // ── static UIs ────────────────────────────────────────────────────────
      if (path === "/app") { res.writeHead(302, { location: "/app/" }); return res.end(); }
      if (path === "/app/precache.json") {
        const data = await readFile(join(root, "web/dist/resident-precache.json"));
        res.writeHead(200, { "content-type": "application/json" }); return res.end(data);
      }
      const built = (name) => existsSync(join(root, `web/dist/${name}/index.html`)) ? `/web/dist/${name}/index.html` : `/${name}/index.html`;
      const map = {
        "/": built("board"), "/board": built("board"), "/console": built("console"), "/replay": built("replay"),
        "/alerts": built("alerts"), "/node": built("node"), "/app": built("app"), "/app/": built("app"),
        "/app/index.html": built("app"), "/app/legacy": "/app/index.html", "/legacy/app": "/app/index.html",
        "/app/standard": built("standard"), "/chirp": "/device/chirp_send.html",
        "/legacy/board": "/board/index.html", "/legacy/console": "/console/index.html", "/legacy/replay": "/replay/index.html",
      };
      let file = map[path] || (path.startsWith("/assets/") ? "/web/dist" + path : path);
      const full = join(root, file);
      const PUBLIC = ["/app/", "/board/", "/console/", "/replay/", "/device/", "/vendor/", "/web/dist/"];
      if (full.startsWith(root) && PUBLIC.some((d) => file.startsWith(d)) && existsSync(full) && !full.includes("node_modules") && !full.includes("/.")) {
        const data = await readFile(full);
        res.writeHead(200, { "content-type": MIME[extname(full)] || "application/octet-stream" });
        return res.end(data);
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      console.error(e);
      return json(res, 500, { error: String(e.message || e) });
    }
  });

  return server;
}
