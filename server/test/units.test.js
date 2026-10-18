// After dispatch: unit status with watchdog timers, closing with a disposition, and updates back to the reporter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { Engine } from "../engine.js";
import { makePacket } from "../schema.js";
import { initUnit, setUnitStatus, unitBoard, closeWithDisposition, updatesForDevice } from "../units.js";

function setup() {
  const store = new Store(); const engine = new Engine(store, { adjacency: {} });
  const { packet } = makePacket({ source: "app", identifier: "app-1", zone_id: "Z06", target: "water", severity: 3, action: "info_only", provenance: "firsthand", content_status: "extracted" });
  const inc = engine.ingest(packet, {}).incident;
  inc.dispatched = [initUnit({ unit: "utility", at: new Date(Date.now() - 5 * 60000).toISOString(), by: "dispatcher" })];
  return { store, engine, inc };
}

test("units move assigned -> en route -> on scene, and skipping a step is refused", () => {
  const { store, inc } = setup();
  assert.equal(setUnitStatus(store, inc, 0, "on_scene", "dispatcher").status, 409);
  assert.equal(setUnitStatus(store, inc, 0, "en_route", "dispatcher").ok, true);
  assert.equal(setUnitStatus(store, inc, 0, "on_scene", "dispatcher").ok, true);
  assert.equal(inc.dispatched[0].history.length, 3);
});

test("the watchdog flags a unit left in assigned past its limit", () => {
  const { store } = setup();
  const [u] = unitBoard(store);
  assert.equal(u.status, "assigned"); assert.equal(u.overdue, true);
});

test("unable to locate closes the incident and schedules a callback", () => {
  const { store, engine, inc } = setup();
  const out = closeWithDisposition(store, engine, inc, "unable_to_locate", "supervisor");
  assert.equal(out.ok, true); assert.ok(out.callback_id);
  assert.ok(inc.closed_at); assert.equal(inc.dispatched[0].status, "cleared");
});

test("the person who reported from the app sees the unit status", () => {
  const { store, inc } = setup();
  setUnitStatus(store, inc, 0, "en_route", "dispatcher");
  const [u] = updatesForDevice(store, "app-1", "Z06");
  assert.equal(u.message, "A unit is on the way.");
  assert.equal(updatesForDevice(store, "someone-else", "Z06").length, 0);
});
