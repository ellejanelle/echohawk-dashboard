// SAME decoder tests: SD1–SD4.
import test from "node:test";
import assert from "node:assert/strict";
import { parseSameHeader, actionForEvent } from "../same_decoder.js";
import { Store } from "../store.js";
import { Engine } from "../engine.js";
import { RetellHub } from "../retell_ws.js";
import { createHttpServer } from "../http.js";
import { loadAdjacency } from "../seed.js";

// SD1: parse a well-formed SAME header
test("SD1: parseSameHeader parses a valid header", () => {
  const result = parseSameHeader("ZCZC-WXR-SPW-006037+0100-2911830-KLOX/NWS-");
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`);
  assert.equal(result.originator, "WXR");
  assert.equal(result.event, "SPW");
  assert.deepEqual(result.locations, ["006037"]);
  assert.equal(result.durationMinutes, 60);
  assert.deepEqual(result.issued, { dayOfYear: 291, hhmm: "1830" });
  assert.equal(result.sender, "KLOX/NWS");
});

// SD2: parse an EVI (evacuate) header with multiple location codes
test("SD2: parseSameHeader parses EVI with multiple locations", () => {
  const result = parseSameHeader("ZCZC-WXR-EVI-006037-006038+0200-3051215-KBUR/NWS-");
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`);
  assert.equal(result.event, "EVI");
  assert.deepEqual(result.locations, ["006037", "006038"]);
  assert.equal(result.durationMinutes, 120);
  assert.deepEqual(result.issued, { dayOfYear: 305, hhmm: "1215" });
  assert.equal(result.sender, "KBUR/NWS");
});

// SD3: malformed header (missing ZCZC) returns {error}
test("SD3: parseSameHeader returns error for malformed header", () => {
  const result = parseSameHeader("WXR-SPW-006037+0100-2911830-KLOX/NWS-");
  assert.ok(result.error, "expected an error field");
});

// SD4: POST /alerts/same with {header: "..."} produces 201 with correct event_code and action
test("SD4: POST /alerts/same with header field returns 201 and correct action", async () => {
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

  try {
    const res = await fetch(`${base}/alerts/same`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ header: "ZCZC-WXR-SPW-006037+0100-2911830-KLOX/NWS-" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.event_code, "SPW");
    assert.equal(body.zone, 6037);
    assert.equal(body.action, "shelter_in_place");
    assert.ok(body.frame_b64, "frame_b64 must be present");
  } finally {
    await close();
  }
});
