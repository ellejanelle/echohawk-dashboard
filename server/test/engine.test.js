// Acceptance tests A3 to A11, A17, A18 (docs/docs/IMPLEMENTATION_PLAN.md Section 5). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { Engine } from "../engine.js";
import { makePacket, independenceKey } from "../schema.js";
import { scanTurn } from "../triggers.js";
import { showKitCard, getKit } from "../kits.js";
import { loadAdjacency } from "../seed.js";

const adjacency = loadAdjacency();
const mk = (over) => makePacket({ source: "voice", zone_id: "Z06", target: "water", severity: 2, action: "deflect_311", identifier: "x", ...over }).packet;

test("A3 packet with no extractable content still ingests as a watch item", () => {
  const store = new Store(); const eng = new Engine(store, { adjacency });
  const { packet, errors } = makePacket({ source: "voice", identifier: "hangup-1", zone_id: "Z01", content_status: "none" });
  assert.equal(errors.length, 0);
  const out = eng.ingest(packet);
  assert.equal(out.rung, "watch");
  assert.equal(store.packets.length, 1);
  assert.ok(store.zoneWindows.find((w) => w.zone_id === "Z01" && w.n === 1));
});

test("A4 five repeat SOS transmissions share one key and count as one independent source", () => {
  const store = new Store(); const eng = new Engine(store, { adjacency });
  const key = independenceKey("device-77", "Z05");
  let inc;
  for (let i = 0; i < 5; i++) inc = eng.ingest(mk({ source: "ehawk", zone_id: "Z05", target: "person", severity: 5, action: "dispatch_ems", independence_key: key, provenance: i ? "repeat_beacon" : "firsthand" })).incident;
  assert.equal(store.incidents.length, 1);
  assert.equal(inc.independent_count, 1);
  assert.equal(inc.packet_ids.length, 5);
});

test("A5 three independent callers, same zone and target, within 15 minutes reach hand", () => {
  const store = new Store(); const eng = new Engine(store, { adjacency });
  let out;
  for (const id of ["a", "b", "c"]) out = eng.ingest(mk({ identifier: id }));
  assert.equal(out.rung, "hand");
  assert.ok(out.incident.score >= 0.85);
  assert.equal(eng.ranked()[0].id, out.incident.id);
});

test("A6 one frantic single caller at severity 5 stays below hand and is damped", () => {
  const store = new Store(); const eng = new Engine(store, { adjacency });
  const out = eng.ingest(mk({ identifier: "frantic", zone_id: "Z13", target: "power", severity: 5, action: "deflect_311" }), { triggers: scanTurn("I need someone here NOW this is an emergency") });
  assert.notEqual(out.rung, "hand");
  assert.ok(out.incident.score <= 0.6 * 0.85 + 0.1, `score ${out.incident.score} should be capped`);
});

test("A7 same target in adjacent zones links incidents and flags spread", () => {
  const store = new Store(); const eng = new Engine(store, { adjacency });
  eng.ingest(mk({ identifier: "p", zone_id: "Z06" }));
  const out = eng.ingest(mk({ identifier: "q", zone_id: "Z07" }));
  assert.ok(out.incident.spread_linked_incident_id, "should link to the Z06 incident");
  assert.ok(store.events.some((e) => e.event_type === "incident_spread"));
});

test("A8 qualified breathing fires a hard trigger", () => {
  const t = scanTurn("She's sort of breathing, like gasping");
  assert.ok(t.isHard); assert.ok(t.hard.includes("breathing_qualified"));
  const t2 = scanTurn("yes he's breathing fine and talking");
  assert.equal(t2.isHard, false);
});

test("A9 hard trigger with no matching kit still escalates to hand", () => {
  const store = new Store(); const eng = new Engine(store, { adjacency });
  const out = eng.ingest(mk({ identifier: "z", zone_id: "Z09", target: "person", severity: 5, action: "dispatch_ems" }), { triggers: scanTurn("my mother collapsed and she's gasping") });
  assert.equal(out.rung, "hand");
  assert.ok(store.events.some((e) => e.event_type === "trigger_fired"));
});

test("A10 show_kit_card rejects ids not in the catalog", () => {
  const store = new Store();
  const out = showKitCard({ kit_id: "EH-FAKE-999" }, store);
  assert.equal(out.ok, false); assert.equal(out.status, 404);
  assert.equal(store.kitShows.length, 0);
});

test("A11 kit script lines are returned verbatim from the catalog", () => {
  const store = new Store();
  const out = showKitCard({ kit_id: "EH-BLEED-001", call_id: "c" }, store);
  assert.equal(out.ok, true);
  assert.deepEqual(out.script_lines, getKit("EH-BLEED-001").script_lines);
  assert.equal(out.review_status, "pending");
  assert.ok(!out.script_lines.join(" ").toLowerCase().includes("tourniquet"), "no improvised tourniquet instruction");
});

test("A17 high-severity incident closes only by a supervisor", () => {
  const store = new Store(); const eng = new Engine(store, { adjacency });
  const out = eng.ingest(mk({ identifier: "s", zone_id: "Z02", target: "person", severity: 5, action: "dispatch_ems" }));
  assert.equal(eng.close(out.incident.id, "dispatcher", "done").status, 403);
  assert.equal(eng.close(out.incident.id, "system", "auto").status, 403);
  assert.equal(eng.close(out.incident.id, "supervisor", "resolved on scene").ok, true);
});

test("A18 no-answer callback leaves the incident open", () => {
  const store = new Store(); const eng = new Engine(store, { adjacency });
  const out = eng.ingest(mk({ identifier: "w", zone_id: "Z12", target: "person", severity: 4, action: "welfare_check" }));
  store.callbacks.push({ id: "cb1", incident_id: out.incident.id, attempt_no: 1, attempted_at: new Date().toISOString(), result: "no_answer", next_step: "retry" });
  const inc = store.incidents.find((i) => i.id === out.incident.id);
  assert.equal(inc.closed_at, null);
});

test("machine sources (alarm activations) never count as independent callers", () => {
  const store = new Store(); const eng = new Engine(store, { adjacency });
  let out;
  for (let i = 0; i < 5; i++) out = eng.ingest(mk({ source: "telemetry", identifier: `alarm-${i}`, zone_id: "Z03", target: "structure_fire", severity: 2, action: "dispatch_fire" }));
  assert.equal(out.incident.independent_count, 0);
  assert.equal(out.incident.machine_count, 5);
  assert.notEqual(out.rung, "hand");
});

test("street addresses are rejected as zone ids", () => {
  const { errors } = makePacket({ source: "app", zone_id: "1234 Main St", target: "power", identifier: "a" });
  assert.ok(errors.some((e) => /street address/.test(e)));
});

test("spoken zone numbers from speech-to-text map to zone ids", async () => {
  const { extractZone } = await import("../llm.js");
  assert.equal(extractZone("zone six, water pressure gone"), "Z06");
  assert.equal(extractZone("Zone zero six"), "Z06");
  assert.equal(extractZone("zona seis, sin luz"), "Z06");
  assert.equal(extractZone("Zone three o six. Our water pressure dropped."), "0306");
  assert.equal(extractZone("RD 0802 structure fire"), "0802");
  assert.equal(extractZone("Zona Z04."), "Z04");
  assert.equal(extractZone("no zone here"), null);
});
