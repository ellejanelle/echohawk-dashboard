// A1 (websocket protocol), A2 (packet before call end), A13 (interpreter mode path), A14 (webhook signature), A15 (frame + replay)
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import WebSocket from "ws";
import { Store } from "../store.js";
import { Engine } from "../engine.js";
import { RetellHub } from "../retell_ws.js";
import { createHttpServer, verifyRetellSignature, signRetellWebhook } from "../http.js";
import { loadAdjacency } from "../seed.js";
import { encodeFrame, decodeFrame, ReplayWindow } from "../../device/frame.js";

async function boot() {
  const store = new Store(); const engine = new Engine(store, { adjacency: loadAdjacency() });
  const hub = new RetellHub({ store, engine }); const server = createHttpServer({ store, engine, hub }); hub.attach(server);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const close = () => { for (const c of hub.wss.clients) c.terminate(); server.closeAllConnections?.(); return new Promise((r) => server.close(r)); };
  return { store, engine, hub, server, port, close };
}
// Every test closes its server in `finally`, so one failed assertion cannot leave a handle open and hang the runner.
async function withServer(fn) { const ctx = await boot(); const sockets = []; ctx.connect = (id) => { const ws = connect(ctx.port, id); sockets.push(ws); return ws; }; try { await fn(ctx); } finally { for (const ws of sockets) try { ws.terminate(); } catch {} await ctx.close(); } }
// Buffer every message from the moment the socket is created, because the server sends `config` before the
// client's `open` event resolves. `once` checks the buffer first, then waits.
function connect(port, callId) {
  const ws = new WebSocket(`ws://localhost:${port}/retell/llm/${callId}`);
  const buf = []; const waiters = [];
  ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); const i = waiters.findIndex((w) => w.pred(m)); if (i >= 0) { const w = waiters.splice(i, 1)[0]; w.resolve(m); } else buf.push(m); });
  ws.next = (pred) => { const i = buf.findIndex(pred); if (i >= 0) return Promise.resolve(buf.splice(i, 1)[0]); return new Promise((resolve) => waiters.push({ pred, resolve })); };
  ws.ready = new Promise((r) => ws.on("open", r));
  return ws;
}
const once = (ws, pred) => ws.next(pred);

test("A1 + A2: websocket protocol handled; packet created before call end", () => withServer(async (ctx) => {
  const ws = ctx.connect("call_test_1"); await ws.ready;
  const cfg = await once(ws, (m) => m.response_type === "config");
  assert.equal(cfg.config.auto_reconnect, true);
  ws.send(JSON.stringify({ interaction_type: "ping_pong", timestamp: 123 }));
  const pong = await once(ws, (m) => m.response_type === "ping_pong"); assert.equal(pong.timestamp, 123);
  const transcript = [{ role: "agent", content: "How can I help?" }, { role: "user", content: "Zone Z06, our water pressure dropped to nothing, no one is hurt." }];
  ws.send(JSON.stringify({ interaction_type: "update_only", transcript }));
  ws.send(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript }));
  const resp = await once(ws, (m) => m.response_type === "response" && m.response_id === 1);
  assert.ok(resp.content.length > 0);
  assert.equal(ctx.store.packets.length, 1, "packet exists while the call is still live");
  assert.equal(ctx.store.packets[0].zone_id, "Z06");
  assert.equal(ctx.store.packets[0].target, "water");
}));

test("A8 over the wire: qualified breathing triggers transfer with no kit", () => withServer(async (ctx) => {
  const ws = ctx.connect("call_test_2"); await ws.ready; await once(ws, (m) => m.response_type === "config");
  const transcript = [{ role: "user", content: "Zone Z09, my mother collapsed, she's sort of breathing, like gasping." }];
  ws.send(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript }));
  const resp = await once(ws, (m) => m.response_type === "response" && m.response_id !== 0);
  assert.match(resp.content, /connecting you to a dispatcher/i);
  assert.ok(ctx.store.events.some((e) => e.event_type === "trigger_fired"));
  assert.ok(ctx.store.events.some((e) => e.event_type === "transfer_started"));
  assert.equal(ctx.store.kitShows.length, 0, "no kit for breathing; transfer is not delayed");
  assert.equal(ctx.store.packets[0].target, "person");
  assert.equal(ctx.store.packets[0].severity, 5);
}));

test("A9/A11 over the wire: bleeding fires transfer AND the approved card, read verbatim", () => withServer(async (ctx) => {
  const ws = ctx.connect("call_test_3"); await ws.ready; await once(ws, (m) => m.response_type === "config");
  const transcript = [{ role: "user", content: "Zone Z02, my husband cut his leg and he's bleeding badly, blood everywhere." }];
  ws.send(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript }));
  const meta = await once(ws, (m) => m.response_type === "metadata");
  assert.equal(meta.metadata.show_kit_card.kit_id, "EH-BLEED-001");
  const resp = await once(ws, (m) => m.response_type === "response" && m.response_id !== 0);
  assert.equal(resp.content, meta.metadata.show_kit_card.script_lines.join(" "));
  assert.ok(ctx.store.events.some((e) => e.event_type === "transfer_started"));
}));

test("A13: interpreter mode join + say pushes agent_interrupt in the caller's language path", () => withServer(async (ctx) => {
  const ws = ctx.connect("call_test_4"); await ws.ready; await once(ws, (m) => m.response_type === "config");
  ws.send(JSON.stringify({ interaction_type: "call_details", call: { call_id: "call_test_4", metadata: { language: "es" } } }));
  await new Promise((r) => setTimeout(r, 50));
  const j = await fetch(`http://localhost:${ctx.port}/calls/call_test_4/join`, { method: "POST", headers: { authorization: "Bearer dev-dispatcher", "content-type": "application/json" }, body: JSON.stringify({ dispatcher_id: "d1" }) });
  assert.equal(j.status, 200);
  const p = once(ws, (m) => m.response_type === "agent_interrupt");
  const s = await fetch(`http://localhost:${ctx.port}/calls/call_test_4/say`, { method: "POST", headers: { authorization: "Bearer dev-dispatcher", "content-type": "application/json" }, body: JSON.stringify({ text: "Help is on the way. Stay on the line.", lang_from: "en" }) });
  assert.equal(s.status, 200);
  const m = await p;
  assert.ok(m.content.length > 0);
  const body = await s.json(); assert.equal(body.lang_to, "es");
  assert.ok(ctx.store.turns.some((t) => t.role === "dispatcher"));
}));

test("A14: webhook signature follows the Retell format; bad or stale signatures are rejected 401 and logged", () => withServer(async (ctx) => {
  const secret = "key_test"; // Retell uses the API key as the HMAC secret
  const raw = Buffer.from(JSON.stringify({ event: "call_ended", call: { call_id: "x" } }));
  const good = signRetellWebhook(raw, secret);
  assert.match(good, /^v=\d+,d=[0-9a-f]{64}$/);
  assert.equal(verifyRetellSignature(raw, good, secret), true);
  assert.equal(verifyRetellSignature(raw, good, "other-key"), false);
  assert.equal(verifyRetellSignature(Buffer.from("{}"), good, secret), false, "body tamper");
  assert.equal(verifyRetellSignature(raw, "deadbeef", secret), false, "wrong format");
  assert.equal(verifyRetellSignature(raw, signRetellWebhook(raw, secret, Date.now() - 6 * 60 * 1000), secret), false, "stale timestamp");
  const r = await fetch(`http://localhost:${ctx.port}/webhooks/retell`, { method: "POST", headers: { "content-type": "application/json", "x-retell-signature": "v=1,d=" + "0".repeat(64) }, body: raw });
  assert.equal(r.status, 401);
  assert.ok(ctx.store.events.some((e) => e.event_type === "webhook_rejected"));
}));

test("A15 (server side): 16-byte frame signs, decodes, and rejects replay", () => {
  const key = "k";
  const f = encodeFrame({ type: "directive", zone: 802, target: "wildfire", severity: 5, action: "evacuate", language: "es", sequence: 7 }, key);
  assert.equal(f.length, 16);
  const rw = new ReplayWindow();
  const d = decodeFrame(f, key, rw);
  assert.equal(d.ok, true); assert.equal(d.zone, 802); assert.equal(d.target, "wildfire"); assert.equal(d.action, "evacuate"); assert.equal(d.language, "es"); assert.equal(d.severity, 5);
  assert.equal(decodeFrame(f, key, rw).error, "rejected: replay");
  const tampered = Buffer.from(f); tampered[3] ^= 0x10;
  assert.equal(decodeFrame(tampered, key, new ReplayWindow()).error, "signature invalid");
  assert.equal(decodeFrame(f, "wrong", new ReplayWindow()).error, "signature invalid");
});

test("streaming transcript: growing turns are updated, not frozen at the first fragment", () => withServer(async (ctx) => {
  const ws = ctx.connect("call_stream"); await ws.ready; await once(ws, (m) => m.response_type === "config");
  ws.send(JSON.stringify({ interaction_type: "update_only", transcript: [{ role: "user", content: "Zone" }] }));
  ws.send(JSON.stringify({ interaction_type: "update_only", transcript: [{ role: "user", content: "Zone six, our water" }] }));
  const full = [{ role: "user", content: "Zone six, our water pressure dropped to nothing, no one is hurt." }];
  ws.send(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript: full }));
  const resp = await once(ws, (m) => m.response_type === "response" && m.response_id !== 0);
  const turns = ctx.store.turns.filter((t) => t.call_id === "call_stream");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text_original, full[0].content);
  assert.equal(ctx.store.packets[0].zone_id, "Z06");
  assert.equal(ctx.store.packets[0].target, "water");
  assert.match(resp.content, /zone 6/i);
}));

// Replays of the two real test calls from Oct 17 that went wrong (repeat loop; Spanish answered in English).
async function talk(ws, transcript, rid) {
  ws.send(JSON.stringify({ interaction_type: "response_required", response_id: rid, transcript }));
  const r = await once(ws, (m) => m.response_type === "response" && m.response_id === rid);
  transcript.push({ role: "agent", content: r.content });
  return r;
}

test("no-key dialog never repeats the hurt question and ends the call after the wrap-up", () => withServer(async (ctx) => {
  const ws = ctx.connect("call_norepeat"); await ws.ready; await once(ws, (m) => m.response_type === "config");
  const tr = [{ role: "user", content: "Zone six. Our water pressure dropped to nothing." }];
  const r1 = await talk(ws, tr, 1); assert.match(r1.content, /zone 6.*anyone hurt/i);
  tr.push({ role: "user", content: "No." });
  const r2 = await talk(ws, tr, 2); assert.doesNotMatch(r2.content, /anyone hurt or in danger/i); assert.match(r2.content, /anything else/i);
  tr.push({ role: "user", content: "No, that's it." });
  const r3 = await talk(ws, tr, 3); assert.equal(r3.end_call, true); assert.match(r3.content, /stay safe/i);
  assert.ok(!ctx.store.events.some((e) => e.event_type === "transfer_started"), "a water report is not transferred");
}));

test("yes to 'anyone hurt' transfers", () => withServer(async (ctx) => {
  const ws = ctx.connect("call_hurt"); await ws.ready; await once(ws, (m) => m.response_type === "config");
  const tr = [{ role: "user", content: "Zone seven, a tree is down blocking the road." }];
  await talk(ws, tr, 1);
  tr.push({ role: "user", content: "Yes, my neighbor is under it." });
  const r = await talk(ws, tr, 2); assert.match(r.content, /connecting you to a dispatcher/i);
}));

test("Spanish caller gets Spanish replies and the Spanish card with no language tag from Retell", () => withServer(async (ctx) => {
  const ws = ctx.connect("call_es"); await ws.ready; await once(ws, (m) => m.response_type === "config");
  const tr = [{ role: "user", content: "Zona cuatro, se fue la luz." }];
  const r = await talk(ws, tr, 1);
  assert.match(r.content, /linterna|luz|Puedo/i);
  assert.equal(ctx.store.calls.find((c) => c.id === "call_es").language, "es");
  tr.push({ role: "user", content: "No, nadie está herido." });
  const r2 = await talk(ws, tr, 2); assert.doesNotMatch(r2.content, /\b(the|you|zone)\b/i);
}));

test("the line greets first and says it is automated", async () => {
  const { GREETING } = await import("../retell_ws.js");
  assert.match(GREETING, /automated assistant/);
  assert.match(GREETING, /person/);
});
