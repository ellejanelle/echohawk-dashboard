// Acceptance tests for the callback ladder — IMPLEMENTATION_PLAN.md A18.
// A18: callback no_answer leaves the incident open and schedules the next step; nothing marks it resolved.
// Three-attempt cap: a no_answer on attempt 3 does NOT schedule attempt 4.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { Engine } from "../engine.js";
import { makePacket } from "../schema.js";
import { loadAdjacency } from "../seed.js";
import { scheduleCallback, recordCallback, openCallbacks } from "../callbacks.js";
import { createHttpServer } from "../http.js";
import { RetellHub } from "../retell_ws.js";

// -----------------------------------------------------------------------
// Pure unit tests (no HTTP)
// -----------------------------------------------------------------------

function makeIncident(store) {
  const eng = new Engine(store, { adjacency: loadAdjacency() });
  const { packet } = makePacket({ source: "app", zone_id: "Z07", target: "power", severity: 2, action: "info_only", provenance: "firsthand" });
  const out = eng.ingest(packet);
  return out.incident;
}

test("A18: scheduleCallback pushes a pending row and emits callback_scheduled", () => {
  const store = new Store();
  const incident = makeIncident(store);
  const cb = scheduleCallback(store, incident.id, 1);

  assert.equal(cb.incident_id, incident.id);
  assert.equal(cb.attempt_no, 1);
  assert.equal(cb.result, "pending");
  assert.equal(cb.attempted_at, null);
  assert.equal(cb.next_step, "call");

  const ev = store.events.find((e) => e.event_type === "callback_scheduled");
  assert.ok(ev, "callback_scheduled event must be emitted");
  assert.equal(ev.incident_id, incident.id);
});

test("A18: no_answer leaves incident open and schedules attempt+1 (not resolved)", () => {
  const store = new Store();
  const incident = makeIncident(store);
  const cb1 = scheduleCallback(store, incident.id, 1);

  // Mark the callback as no_answer
  const result = recordCallback(store, cb1.id, "no_answer");
  assert.equal(result.ok, true);
  assert.equal(result.callback.result, "no_answer");

  // The incident must still have no closed_at (engine stores it as null when never closed)
  const inc = store.incidents.find((i) => i.id === incident.id);
  assert.ok(!inc.closed_at, "incident must not be closed after no_answer");

  // A callback_no_answer event must be emitted
  const noAnswerEv = store.events.find((e) => e.event_type === "callback_no_answer");
  assert.ok(noAnswerEv, "callback_no_answer event must be emitted");
  assert.equal(noAnswerEv.incident_id, incident.id);

  // A second callback (attempt 2) must have been automatically scheduled
  const attempt2 = store.callbacks.find((c) => c.incident_id === incident.id && c.attempt_no === 2);
  assert.ok(attempt2, "attempt 2 must be automatically scheduled after no_answer on attempt 1");
  assert.equal(attempt2.result, "pending");
});

test("A18: three-attempt cap — no_answer on attempt 3 does NOT schedule attempt 4", () => {
  const store = new Store();
  const incident = makeIncident(store);

  // Walk through attempts 1→2→3, all no_answer
  let cb = scheduleCallback(store, incident.id, 1);
  recordCallback(store, cb.id, "no_answer");

  cb = store.callbacks.find((c) => c.incident_id === incident.id && c.attempt_no === 2);
  assert.ok(cb, "attempt 2 must exist");
  recordCallback(store, cb.id, "no_answer");

  cb = store.callbacks.find((c) => c.incident_id === incident.id && c.attempt_no === 3);
  assert.ok(cb, "attempt 3 must exist");
  recordCallback(store, cb.id, "no_answer");

  // No attempt 4 must have been created
  const attempt4 = store.callbacks.find((c) => c.incident_id === incident.id && c.attempt_no === 4);
  assert.equal(attempt4, undefined, "attempt 4 must NOT be scheduled when the cap is reached");

  // The incident is still open (null or undefined both mean never closed)
  const inc = store.incidents.find((i) => i.id === incident.id);
  assert.ok(!inc.closed_at, "incident must still be open after exhausting three attempts");
});

test("A18: openCallbacks returns the incident in the open list after no_answer", () => {
  const store = new Store();
  const incident = makeIncident(store);
  const cb = scheduleCallback(store, incident.id, 1);
  recordCallback(store, cb.id, "no_answer");

  const open = openCallbacks(store);
  assert.ok(open.length > 0, "openCallbacks must return at least one row");
  const row = open.find((r) => r.incident_id === incident.id);
  assert.ok(row, "the incident with a no_answer callback must appear in openCallbacks");
  assert.equal(row.zone_id, "Z07");
  assert.equal(row.target, "power");
  assert.ok(row.attempts >= 1);
});

test("A18: answered callback removes incident from openCallbacks", () => {
  const store = new Store();
  const incident = makeIncident(store);
  const cb = scheduleCallback(store, incident.id, 1);
  recordCallback(store, cb.id, "answered");

  const open = openCallbacks(store);
  const row = open.find((r) => r.incident_id === incident.id);
  assert.equal(row, undefined, "answered incident must not appear in openCallbacks");
});

// -----------------------------------------------------------------------
// HTTP route tests
// -----------------------------------------------------------------------

async function boot() {
  const store = new Store();
  const engine = new Engine(store, { adjacency: loadAdjacency() });
  const hub = new RetellHub({ store, engine });
  const server = createHttpServer({ store, engine, hub });
  hub.attach(server);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  const close = () => {
    for (const c of hub.wss.clients) c.terminate();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  };
  return { store, engine, hub, server, port, base, close };
}

test("HTTP: POST /incidents/:id/callback schedules a callback row", async () => {
  const ctx = await boot();
  try {
    // Create an incident via a packet
    const pRes = await fetch(`${ctx.base}/packets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "app", zone_id: "Z08", target: "water", severity: 2, action: "info_only", provenance: "firsthand" }),
    });
    assert.equal(pRes.status, 201);
    const { incident_id } = await pRes.json();
    assert.ok(incident_id);

    const cbRes = await fetch(`${ctx.base}/incidents/${incident_id}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt_no: 1 }),
    });
    assert.equal(cbRes.status, 201);
    const cb = await cbRes.json();
    assert.equal(cb.incident_id, incident_id);
    assert.equal(cb.attempt_no, 1);
    assert.equal(cb.result, "pending");
  } finally {
    await ctx.close();
  }
});

test("HTTP: POST /callbacks/:id/result records a result and GET /callbacks/open reflects it", async () => {
  const ctx = await boot();
  try {
    // Create packet → incident → callback
    const pRes = await fetch(`${ctx.base}/packets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "app", zone_id: "Z09", target: "gas", severity: 3, action: "dispatch_fire", provenance: "firsthand" }),
    });
    const { incident_id } = await pRes.json();

    const cbRes = await fetch(`${ctx.base}/incidents/${incident_id}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cb = await cbRes.json();

    // Record no_answer
    const recRes = await fetch(`${ctx.base}/callbacks/${cb.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: "no_answer" }),
    });
    assert.equal(recRes.status, 200);
    const rec = await recRes.json();
    assert.equal(rec.ok, true);
    assert.equal(rec.callback.result, "no_answer");

    // GET /callbacks/open should include this incident
    const openRes = await fetch(`${ctx.base}/callbacks/open`);
    assert.equal(openRes.status, 200);
    const open = await openRes.json();
    assert.ok(Array.isArray(open));
    const row = open.find((r) => r.incident_id === incident_id);
    assert.ok(row, "incident must appear in /callbacks/open after a no_answer");
    assert.equal(row.zone_id, "Z09");
  } finally {
    await ctx.close();
  }
});

test("HTTP: POST /callbacks/:id/result with invalid result returns 400", async () => {
  const ctx = await boot();
  try {
    const pRes = await fetch(`${ctx.base}/packets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "app", zone_id: "Z10", target: "flood", severity: 2, action: "info_only", provenance: "firsthand" }),
    });
    const { incident_id } = await pRes.json();

    const cbRes = await fetch(`${ctx.base}/incidents/${incident_id}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cb = await cbRes.json();

    const badRes = await fetch(`${ctx.base}/callbacks/${cb.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: "resolved" }),
    });
    assert.equal(badRes.status, 400);
  } finally {
    await ctx.close();
  }
});
