// Public alerts: agencies issue protective actions with a second approver; the supervisor can only advise or request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { Broadcasts } from "../broadcasts.js";
import { decodeFrame, fromBase64 } from "../../device/frame.js";

const KEY = "test-key";
const mk = () => new Broadcasts(new Store(), { frameKey: KEY });
const oem = (name) => ({ role: "agency", agency: "LA County Office of Emergency Management", name });
const sup = { role: "supervisor", agency: "EchoHawk supervisor", name: "Supervisor" };

test("an evacuation order needs a second agency person to send it", () => {
  const b = mk();
  const { broadcast } = b.create({ kind: "evacuation_order", zones: ["Z06"], message: "Fire moving toward Zone 6." }, oem("Dana"));
  assert.equal(broadcast.status, "draft");
  const same = b.send(broadcast.id, oem("Dana"));
  assert.equal(same.ok, false); assert.equal(same.status, 409);
  const other = b.send(broadcast.id, oem("Luis"));
  assert.equal(other.ok, true); assert.equal(other.broadcast.status, "active");
  assert.equal(other.broadcast.approved_by.name, "Luis");
});

test("the supervisor cannot issue a protective action, only request one", () => {
  const b = mk();
  assert.equal(b.create({ kind: "shelter_in_place", zones: ["Z06"], message: "x" }, sup).status, 403);
  const r = b.create({ kind: "shelter_in_place", zones: ["Z06"], message: "Gas leak", request: true }, sup);
  assert.equal(r.broadcast.status, "requested");
  assert.equal(b.send(r.broadcast.id, sup).status, 403);
});

test("a supervisor advisory goes out at once and reaches the zone's app in English", () => {
  const b = mk();
  const r = b.create({ kind: "advisory", zones: ["Z06"], message: "We know about the water outage in Zone 6. Crews are on it. No need to call." }, sup);
  assert.equal(r.broadcast.status, "active");
  const seen = b.activeFor("Z06", "ko");
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /water outage/);
  assert.equal(b.activeFor("Z07", "en").length, 0);
});

test("each zone gets a signed frame an eHawk can verify", () => {
  const b = mk();
  const { broadcast } = b.create({ kind: "evacuation_warning", zones: ["Z06", "Z07"], message: "Get ready." }, oem("Dana"));
  b.send(broadcast.id, oem("Luis"));
  const f = decodeFrame(fromBase64(broadcast.frames[0].b64), KEY);
  assert.equal(f.ok, true); assert.equal(f.zone, 6); assert.equal(f.action, "evacuate");
});

test("an agency all clear lifts the active order in that zone", () => {
  const b = mk();
  const { broadcast: order } = b.create({ kind: "evacuation_order", zones: ["Z06"], message: "Leave." }, oem("Dana"));
  b.send(order.id, oem("Luis"));
  assert.equal(b.create({ kind: "all_clear", zones: ["Z06"], message: "You may return." }, sup).status, 403);
  const { broadcast: clear } = b.create({ kind: "all_clear", zones: ["Z06"], message: "You may return." }, oem("Dana"));
  assert.equal(b.send(clear.id, oem("Dana")).ok, true);
  assert.equal(order.status, "cancelled");
  assert.deepEqual(b.activeFor("Z06").map((x) => x.kind), ["all_clear"]);
});

test("a resident who replies I need help shows up as needs a person", async () => {
  const { createHttpServer } = await import("../http.js");
  const { Engine } = await import("../engine.js");
  const store = new Store(); const engine = new Engine(store, { adjacency: {} });
  const hub = { sessions: new Map(), mode: () => "tuesday", attach() {} };
  const server = createHttpServer({ store, engine, hub }); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = (who) => ({ authorization: "Bearer dev-agency", "x-operator": who, "x-agency": "lasd", "content-type": "application/json" });
  const made = await (await fetch(`${base}/broadcasts`, { method: "POST", headers: H("Dana"), body: JSON.stringify({ kind: "evacuation_order", zones: ["Z06"], message: "Leave now." }) })).json();
  await fetch(`${base}/broadcasts/${made.broadcast.id}/send`, { method: "POST", headers: H("Luis") });
  const ack = await (await fetch(`${base}/broadcasts/${made.broadcast.id}/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "need_help", zone: "Z06", device: "app-test" }) })).json();
  const inc = store.incidents.find((i) => i.id === ack.incident_id);
  assert.equal(inc.rung, "hand");
  server.close();
});
