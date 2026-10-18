// The ESP32 relay node's WebSocket protocol (firmware/relay_node/PROTOCOL.md) against the server.
import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Store } from "../store.js";
import { Engine } from "../engine.js";
import { RetellHub } from "../retell_ws.js";
import { createHttpServer } from "../http.js";
import { attachNodeSocket } from "../node_ws.js";
import { loadAdjacency } from "../seed.js";

async function boot() {
  const store = new Store();
  const engine = new Engine(store, { adjacency: loadAdjacency() });
  const hub = new RetellHub({ store, engine });
  const server = createHttpServer({ store, engine, hub });
  hub.attach(server);
  attachNodeSocket(server, { store });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const close = () => { for (const c of hub.wss.clients) c.terminate(); server.closeAllConnections?.(); return new Promise((r) => server.close(r)); };
  return { store, engine, port, close };
}
const connect = (port) => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/node`); ws.once("open", () => res(ws)); ws.once("error", rej); });
const next = (ws) => new Promise((res) => ws.once("message", (d) => res(JSON.parse(d.toString()))));

test("node: alert over the websocket lands on the board as one SOS, is acked, resends dedupe, cancel is noted", async () => {
  const { store, engine, port, close } = await boot();
  try {
    const ws = await connect(port);
    ws.send(JSON.stringify({ type: "hello", node_id: "echohawk-01", mic: false, sample_rate: 16000 }));
    const alert = { type: "alert", node_id: "echohawk-01", event_id: "echohawk-01-0000beef", service: "call_center", audio: false, rssi: -50, uptime_ms: 1234 };
    ws.send(JSON.stringify(alert));
    const ack = await next(ws);
    assert.deepEqual(ack, { type: "ack", event_id: alert.event_id });
    assert.equal(store.packets.length, 1);
    const inc = engine.ranked()[0];
    assert.equal(inc.rung, "hand");
    assert.equal(inc.picked_up.node, "echohawk-01");
    assert.equal(inc.picked_up.channel, "wifi");
    // the node did not hear the ack: it resends the same event_id
    ws.send(JSON.stringify(alert));
    const ack2 = await next(ws);
    assert.equal(ack2.event_id, alert.event_id);
    assert.equal(store.packets.length, 1, "resend counted once");
    assert.equal(store.incidents.length, 1);
    // cancel
    ws.send(JSON.stringify({ type: "cancel", node_id: "echohawk-01", event_id: "echohawk-01-0000c0de", service: "call_center", ref_event_id: alert.event_id, uptime_ms: 9999 }));
    const ack3 = await next(ws);
    assert.equal(ack3.event_id, "echohawk-01-0000c0de");
    assert.ok(store.incidents[0].sender_cancelled_at);
    assert.ok(!store.incidents[0].closed_at, "a cancel never closes the incident");
    // audio_start is answered with stop_audio (audio is not stored in this build)
    ws.send(JSON.stringify({ type: "audio_start", node_id: "echohawk-01", event_id: alert.event_id, sample_rate: 16000, format: "pcm_s16le", channels: 1 }));
    const stop = await next(ws);
    assert.equal(stop.type, "stop_audio");
    ws.close();
  } finally { await close(); }
});

test("node: the /node page still serves over plain HTTP and the Retell upgrade path still works", async () => {
  const { port, close } = await boot();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/node`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    const bad = new WebSocket(`ws://127.0.0.1:${port}/nothing`);
    await new Promise((res) => { bad.once("error", res); bad.once("close", res); });
  } finally { await close(); }
});
