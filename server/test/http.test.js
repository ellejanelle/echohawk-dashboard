// HTTP API tests: B1 (zone_id street address reject), B2 (content_status none → watch), B3 (close auth),
// B4 (twists round-trip), B5 (cost/meter fields), B6 (kits 404).
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { Engine } from "../engine.js";
import { RetellHub } from "../retell_ws.js";
import { createHttpServer } from "../http.js";
import { loadAdjacency } from "../seed.js";

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

// B1: POST /packets rejects a street address zone_id with 400
test("B1: POST /packets rejects a street address as zone_id", async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/packets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "app",
        zone_id: "123 Main St",
        target: "power",
        action: "info_only",
        severity: 2,
        provenance: "firsthand",
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(Array.isArray(body.errors) && body.errors.length > 0, "errors array must be non-empty");
    assert.ok(body.errors.some((e) => /street/i.test(e) || /zone/i.test(e)), `expected a zone_id error, got: ${JSON.stringify(body.errors)}`);
  } finally {
    await ctx.close();
  }
});

// B2: POST /packets with content_status "none" returns 201 and rung "watch"
test("B2: POST /packets with content_status none returns 201 and rung watch", async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/packets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "app",
        zone_id: "Z04",
        target: "unknown",
        action: "unknown",
        severity: 1,
        content_status: "none",
        provenance: "firsthand",
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.rung, "watch");
  } finally {
    await ctx.close();
  }
});

// B3: POST /incidents/:id/close returns 403 for dispatcher when max_severity >= 4,
//     and 200 for supervisor token.
test("B3: close incident — 403 for dispatcher on high-severity, 200 for supervisor", async () => {
  const ctx = await boot();
  try {
    // Create a packet with severity 4 so the incident's max_severity becomes 4
    const pRes = await fetch(`${ctx.base}/packets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "app",
        zone_id: "Z05",
        target: "structure_fire",
        action: "dispatch_fire",
        severity: 4,
        provenance: "firsthand",
      }),
    });
    assert.equal(pRes.status, 201);
    const pBody = await pRes.json();
    const incidentId = pBody.incident_id;
    assert.ok(incidentId, "incident_id must be returned");

    // Dispatcher token → 403
    const dispRes = await fetch(`${ctx.base}/incidents/${incidentId}/close`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dev-dispatcher",
      },
      body: JSON.stringify({ reason: "resolved" }),
    });
    assert.equal(dispRes.status, 403);

    // Supervisor token → 200
    const supRes = await fetch(`${ctx.base}/incidents/${incidentId}/close`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dev-supervisor",
      },
      body: JSON.stringify({ reason: "resolved" }),
    });
    assert.equal(supRes.status, 200);
    const supBody = await supRes.json();
    assert.equal(supBody.ok, true);
  } finally {
    await ctx.close();
  }
});

// B4: POST /twists then GET /twists round-trips the entry
test("B4: POST /twists then GET /twists round-trips the entry", async () => {
  const ctx = await boot();
  try {
    const payload = { title: "Test twist", body: "Some content", author: "test" };
    const postRes = await fetch(`${ctx.base}/twists`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(postRes.status, 201);
    const created = await postRes.json();
    assert.ok(created.id, "created twist must have an id");
    assert.equal(created.title, payload.title);
    assert.equal(created.body, payload.body);

    const getRes = await fetch(`${ctx.base}/twists`);
    assert.equal(getRes.status, 200);
    const list = await getRes.json();
    assert.ok(Array.isArray(list), "GET /twists must return an array");
    const found = list.find((t) => t.id === created.id);
    assert.ok(found, "POSTed twist must appear in GET /twists");
    assert.equal(found.title, payload.title);
    assert.equal(found.body, payload.body);
  } finally {
    await ctx.close();
  }
});

// B5: GET /cost/meter has the fields ts, calls_active, paid_concurrency, retell_cents_today, stream
test("B5: GET /cost/meter has required fields", async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/cost/meter`);
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const field of ["ts", "calls_active", "paid_concurrency", "retell_cents_today", "stream"]) {
      assert.ok(Object.hasOwn(body, field), `missing field: ${field}`);
    }
  } finally {
    await ctx.close();
  }
});

// B6: GET /kits/EH-FAKE returns 404
test("B6: GET /kits/EH-FAKE returns 404", async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/kits/EH-FAKE`);
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});
