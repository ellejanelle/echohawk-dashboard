// D4 Wi-Fi tag device test: POST /device/packets with a signed SOS frame.
// Boot pattern follows server/test/protocol.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { Engine } from "../engine.js";
import { RetellHub } from "../retell_ws.js";
import { createHttpServer } from "../http.js";
import { loadAdjacency } from "../seed.js";
import { encodeFrame, decodeFrame, toBase64, ReplayWindow } from "../../device/frame.js";

// ── boot / teardown helpers (same pattern as protocol.test.js) ──────────────

async function boot() {
  const store = new Store();
  const engine = new Engine(store, { adjacency: loadAdjacency() });
  const hub = new RetellHub({ store, engine });
  const server = createHttpServer({ store, engine, hub });
  hub.attach(server);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const close = () => {
    for (const c of hub.wss.clients) c.terminate();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  };
  return { store, engine, hub, server, port, close };
}

async function withServer(fn) {
  const ctx = await boot();
  try { await fn(ctx); } finally { await ctx.close(); }
}

// ── frame builder ────────────────────────────────────────────────────────────

// Use the same default key that config.js uses in test (no .env present).
const FRAME_KEY = "dev-frame-key";
const SEQ = 42;

function sosSigned(seq = SEQ) {
  const buf = encodeFrame(
    { type: "sos", zone: 6, target: "person", severity: 5, action: "dispatch_ems", language: "en", sequence: seq },
    FRAME_KEY
  );
  return toBase64(buf);
}

// ── D4-W1: valid signed SOS → 201, rung=hand, ack_b64 carries same sequence ─

test("D4-W1: signed SOS frame returns 201, rung=hand, valid ack receipt", () => withServer(async ({ port }) => {
  const frame_b64 = sosSigned(SEQ);
  const body = { node_id: "TAG-01-WIFI", channel: "wifi", frame_b64 };
  const res = await fetch(`http://localhost:${port}/device/packets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201);
  const data = await res.json();

  // Response shape
  assert.ok(data.packet_id, "has packet_id");
  assert.equal(data.rung, "hand", "SOS from a person is hand rung");
  assert.ok(data.ack_b64, "ack_b64 is present");

  // Verify ack_b64: decode it with the frame key; it must carry the same sequence
  const ack = decodeFrame(Buffer.from(data.ack_b64, "base64"), FRAME_KEY, new ReplayWindow());
  assert.equal(ack.ok, true, `ack decodes cleanly: ${ack.error}`);
  assert.equal(ack.type, "ack", "ack frame type is 'ack'");
  assert.equal(ack.sequence, SEQ, "ack sequence matches the original SOS sequence");
}));

// ── D4-W2: same frame again → 200 duplicate, counted once ───────────────────

test("D4-W2: duplicate frame returns 200 and store has exactly one packet", () => withServer(async ({ port, store }) => {
  const frame_b64 = sosSigned(SEQ);
  const body = { node_id: "TAG-01-WIFI", channel: "wifi", frame_b64 };
  const opts = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r1 = await fetch(`http://localhost:${port}/device/packets`, opts);
  assert.equal(r1.status, 201);

  const r2 = await fetch(`http://localhost:${port}/device/packets`, opts);
  assert.equal(r2.status, 200);
  const dup = await r2.json();
  assert.equal(dup.duplicate, true, "response flags duplicate:true");

  // Exactly one packet in the store
  assert.equal(store.packets.length, 1, "duplicate is not double-counted");
}));

// ── D4-W3: one flipped bit → 400 bad signature ───────────────────────────────

test("D4-W3: frame with one flipped bit returns 400", () => withServer(async ({ port }) => {
  const raw = encodeFrame(
    { type: "sos", zone: 6, target: "person", severity: 5, action: "dispatch_ems", language: "en", sequence: 99 },
    FRAME_KEY
  );
  // Flip one bit in the signature bytes (last 5 bytes)
  const tampered = Buffer.from(raw);
  tampered[11] ^= 0x01;
  const body = { node_id: "TAG-01-WIFI", channel: "wifi", frame_b64: toBase64(tampered) };
  const res = await fetch(`http://localhost:${port}/device/packets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error, "error field present");
}));

// ── D4-W4: node page gets receipt 1 ("picked up") signed by the server ───────

test("D4-W4: /device/receipt returns a valid stage-1 ack for the node without the page holding the key", () => withServer(async ({ port }) => {
  const res = await fetch(`http://localhost:${port}/device/receipt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ node_id: "N-0812-A", sequence: SEQ, language: "en" }),
  });
  assert.equal(res.status, 200);
  const { ack_b64 } = await res.json();
  const ack = decodeFrame(Buffer.from(ack_b64, "base64"), FRAME_KEY, new ReplayWindow());
  assert.equal(ack.ok, true);
  assert.equal(ack.type, "ack");
  assert.equal(ack.sequence, SEQ);
  assert.equal(ack.severity, 1); // stage 1: picked up
  assert.equal(ack.zone, 1);     // node number of N-0812-A
  const bad = await fetch(`http://localhost:${port}/device/receipt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ node_id: "N-9999-X", sequence: SEQ }),
  });
  assert.equal(bad.status, 400);
}));

// ── D4-W5: snapshot path is configurable and the store reloads from it ───────

test("D4-W5: Store persists to a configurable path and reloads after a restart", async () => {
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(mkdtempSync(join(tmpdir(), "ehawk-")), "nested", "db.json");
  const a = new Store(path);
  a.incidents.push({ id: "inc_test", rung: "hand" });
  a.save();
  assert.equal(existsSync(path), true);
  const b = new Store(path);
  assert.equal(b.incidents.length, 1);
  assert.equal(b.incidents[0].id, "inc_test");
});
