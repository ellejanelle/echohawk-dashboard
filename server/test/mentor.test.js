// Mentor feedback, Oct 17: one unit covers nearby calls; the app cannot set its own priority; one chirp heard by several
// nodes counts once and narrows the area; research export carries no identifiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { Engine } from "../engine.js";
import { makePacket } from "../schema.js";
import { initUnit, unitBoard, addStop } from "../units.js";
import { triageSelfReport } from "../triage.js";
import { scanTurn } from "../triggers.js";
import { approxArea } from "../relay.js";
import { researchRows, toCsv } from "../research.js";

const ADJ = { Z06: ["Z07"], Z07: ["Z06"] };
const pk = (o) => makePacket({ source: "app", severity: 2, action: "info_only", provenance: "firsthand", content_status: "extracted", ...o }).packet;

function scene() {
  const store = new Store(); const engine = new Engine(store, { adjacency: ADJ });
  const main = engine.ingest(pk({ identifier: "a", zone_id: "Z06", target: "water" })).incident;
  const next = engine.ingest(pk({ identifier: "b", zone_id: "Z07", target: "power" })).incident;
  const gas = engine.ingest(pk({ identifier: "c", zone_id: "Z06", target: "person" })).incident;
  main.dispatched = [initUnit({ unit: "utility", at: new Date().toISOString(), by: "dispatcher" })];
  return { store, engine, main, next, gas };
}

test("a utility crew already out is offered the power call next door, not the person call", () => {
  const { store } = scene();
  const [u] = unitBoard(store, Date.now(), ADJ);
  assert.deepEqual(u.nearby.map((x) => [x.zone_id, x.target, x.where]), [["Z07", "power", "next district"]]);
});

test("adding the stop puts the same crew on the second incident, and a wrong-type stop is refused", () => {
  const { store, main, next, gas } = scene();
  const out = addStop(store, main, 0, next, "dispatcher");
  assert.equal(out.ok, true);
  assert.equal(next.dispatched[0].unit, "utility");
  assert.equal(next.dispatched[0].shared_from.incident_id, main.id);
  assert.equal(addStop(store, main, 0, gas, "dispatcher").status, 409);
  const rows = unitBoard(store, Date.now(), ADJ);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.incident_id === main.id).nearby.length, 0); // already covered
});

test("a call that needs a person never becomes a shared stop", () => {
  const { store, engine, main } = scene();
  const hand = engine.ingest(pk({ identifier: "d", zone_id: "Z07", target: "power" }), { triggers: { hard: ["trapped"], soft: [] } }).incident;
  assert.equal(hand.rung, "hand");
  assert.equal(addStop(store, main, 0, hand, "dispatcher").status, 409);
});

test("an app report marked severity 5 for a cat in a tree is held at 3", () => {
  const p = pk({ identifier: "e", zone_id: "Z06", target: "person", severity: 5 });
  triageSelfReport(p, scanTurn("my cat is stuck in a tree"));
  assert.equal(p.severity, 3); assert.equal(p.reported_severity, 5); assert.match(p.triage_note, /held at 3/);
});

test("an app report with danger words keeps its severity and needs a person", () => {
  const store = new Store(); const engine = new Engine(store, { adjacency: {} });
  const p = pk({ identifier: "f", zone_id: "Z06", target: "person", severity: 5 });
  const tr = scanTurn("my dad is not breathing");
  triageSelfReport(p, tr);
  assert.equal(p.severity, 5);
  assert.equal(engine.ingest(p, { triggers: tr }).rung, "hand");
});

test("phone calls are not touched by self-report triage", () => {
  const p = pk({ source: "voice", identifier: "g", zone_id: "Z06", target: "person", severity: 5 });
  triageSelfReport(p, { hard: [] });
  assert.equal(p.severity, 5);
});

test("the area from three hearing nodes covers all three", () => {
  const a = approxArea(["N-0812-A", "N-0812-B", "N-0812-C"]);
  assert.equal(a.nodes, 3); assert.equal(a.simulated, true);
  assert.ok(a.radius_m > 120 && a.radius_m < 600, `radius ${a.radius_m}`);
});

test("one chirp relayed by three nodes is one report heard by three, over HTTP", async () => {
  const { createHttpServer } = await import("../http.js");
  const store = new Store(); const engine = new Engine(store, { adjacency: {} });
  const hub = { sessions: new Map(), mode: () => "tuesday", attach() {} };
  const server = createHttpServer({ store, engine, hub }); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
  const out = await (await fetch(`${base}/demo/relay`, { method: "POST" })).json();
  assert.equal(out.results[0].heard_by.length, 1);
  assert.equal(out.results[2].duplicate, true);
  assert.equal(store.packets.length, 1);
  assert.deepEqual(store.packets[0].heard_by, ["N-0812-A", "N-0812-B", "N-0812-C"]);
  const [inc] = await (await fetch(`${base}/incidents`)).json();
  assert.equal(inc.independent_count, 1);
  assert.equal(inc.rung, "hand"); // "trapped"
  assert.equal(inc.heard_by.length, 3);
  assert.equal(inc.approx_area.nodes, 3);
  const csv = await (await fetch(`${base}/research/export.csv`, { headers: { authorization: "Bearer dev-supervisor" } })).text();
  assert.match(csv.split("\n")[0], /seconds_to_first_unit/);
  assert.match(csv.split("\n")[1], /,3,/); // heard_by_nodes
  assert.equal((await fetch(`${base}/research/export.csv`)).status, 401);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test("the research export carries no phone, device or caller identifiers", () => {
  const { store } = scene();
  const csv = toCsv(researchRows(store));
  const header = csv.split("\n")[0];
  for (const bad of ["independence_key", "identifier", "phone", "device", "call_id", "transcript"]) assert.ok(!header.includes(bad), bad);
  for (const p of store.packets) assert.ok(!csv.includes(p.independence_key));
});

test("an app report of a fire keeps the severity the resident gave", () => {
  const p = pk({ identifier: "h", zone_id: "Z06", target: "structure_fire", severity: 5 });
  triageSelfReport(p, { hard: [] });
  assert.equal(p.severity, 5);
});

test("reset demo clears live data for a supervisor only and keeps baselines", async () => {
  const { createHttpServer } = await import("../http.js");
  const store = new Store(); const engine = new Engine(store, { adjacency: {} });
  store.baselines = [{ zone_id: "Z06", hour: 1, mean_per_15min: 0.2 }];
  const hub = { sessions: new Map(), mode: () => "tuesday", attach() {} };
  const server = createHttpServer({ store, engine, hub }); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/demo/relay`, { method: "POST" });
    assert.equal(store.incidents.length, 1);
    assert.equal((await fetch(`${base}/demo/reset`, { method: "POST", headers: { authorization: "Bearer dev-dispatcher" } })).status, 401);
    const out = await (await fetch(`${base}/demo/reset`, { method: "POST", headers: { authorization: "Bearer dev-supervisor" } })).json();
    assert.equal(out.cleared.incidents, 1);
    assert.equal(store.incidents.length, 0); assert.equal(store.packets.length, 0);
    assert.equal(store.baselines.length, 1);
    assert.deepEqual(store.events.map((e) => e.event_type), ["demo_reset"]);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test("a signed SOS chirp heard by a node is picked up, lands as needs-a-person, and gets a signed receipt back", async () => {
  const { createHttpServer } = await import("../http.js");
  const { encodeFrame, decodeFrame, toBase64, fromBase64, ReplayWindow } = await import("../../device/frame.js");
  const { config } = await import("../config.js");
  const store = new Store(); const engine = new Engine(store, { adjacency: {} });
  const hub = { sessions: new Map(), mode: () => "tuesday", attach() {} };
  const server = createHttpServer({ store, engine, hub }); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/device/packets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const sos = toBase64(encodeFrame({ type: "sos", zone: 6, target: "person", severity: 5, action: "dispatch_ems", language: "es", sequence: 4242 }, config.frameKey));
    const first = await (await post({ node_id: "N-0812-A", channel: "ble", frame_b64: sos })).json();
    assert.equal(first.picked_up.node, "N-0812-A"); assert.equal(first.picked_up.channel, "ble");
    assert.equal(first.rung, "hand");
    const ack = decodeFrame(fromBase64(first.ack_b64), config.frameKey, new ReplayWindow());
    assert.equal(ack.type, "ack"); assert.equal(ack.sequence, 4242); assert.equal(ack.severity, 2); assert.equal(ack.zone, 1);
    // the beacon repeats a minute later, heard by sound at another node: still one report, and still a receipt
    const again = toBase64(encodeFrame({ type: "sos", zone: 6, target: "person", severity: 5, action: "dispatch_ems", language: "es", sequence: 4242, issuedAtMs: Date.now() + 60000 }, config.frameKey));
    const dup = await (await post({ node_id: "N-0812-B", channel: "sound", frame_b64: again })).json();
    assert.equal(dup.duplicate, true); assert.ok(dup.ack_b64);
    assert.equal(store.packets.length, 1);
    assert.deepEqual(store.packets[0].hearings.map((h) => h.channel), ["ble", "sound"]);
    // a forged frame is refused
    const bad = Buffer.from(fromBase64(sos)); bad[3] ^= 0xff;
    assert.equal((await post({ node_id: "N-0812-C", channel: "sound", frame_b64: toBase64(bad) })).status, 400);
  } finally { server.closeAllConnections?.(); server.close(); }
});
