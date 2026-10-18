// Security tests: Retell webhook signature and device frame integrity / anti-replay.
import test from "node:test";
import assert from "node:assert/strict";
import { verifyRetellSignature, signRetellWebhook } from "../http.js";
import { encodeFrame, decodeFrame, ReplayWindow } from "../../device/frame.js";

// ── helpers ──────────────────────────────────────────────────────────────────
const SECRET = "retell_test_key_abc123";
const FRAME_KEY = "frame_test_key_xyz789";
const BODY = Buffer.from(JSON.stringify({ event: "call_started", call: { call_id: "c1" } }));
const NOW = Date.now();

const goodFrame = () =>
  encodeFrame({ type: "directive", zone: 7, target: "water", severity: 3, action: "evacuate", language: "en", sequence: 1 }, FRAME_KEY);

// ── Retell webhook signature ──────────────────────────────────────────────────

test("S1 valid signature is accepted", () => {
  const sig = signRetellWebhook(BODY, SECRET, NOW);
  assert.equal(verifyRetellSignature(BODY, sig, SECRET, { now: NOW }), true);
});

test("S2 wrong key is rejected", () => {
  const sig = signRetellWebhook(BODY, SECRET, NOW);
  assert.equal(verifyRetellSignature(BODY, sig, "wrong_key", { now: NOW }), false);
});

test("S3 tampered body is rejected", () => {
  const sig = signRetellWebhook(BODY, SECRET, NOW);
  const tampered = Buffer.from(BODY.toString() + "x");
  assert.equal(verifyRetellSignature(tampered, sig, SECRET, { now: NOW }), false);
});

test("S4 stale timestamp (>5 min old) is rejected", () => {
  const staleTs = NOW - 6 * 60 * 1000; // 6 minutes ago
  const sig = signRetellWebhook(BODY, SECRET, staleTs);
  assert.equal(verifyRetellSignature(BODY, sig, SECRET, { now: NOW }), false);
});

test("S4b future timestamp (>5 min ahead) is rejected", () => {
  const futureTs = NOW + 6 * 60 * 1000;
  const sig = signRetellWebhook(BODY, SECRET, futureTs);
  assert.equal(verifyRetellSignature(BODY, sig, SECRET, { now: NOW }), false);
});

test("S4c timestamp exactly at 5-min boundary is accepted", () => {
  const boundaryTs = NOW - 5 * 60 * 1000 + 1; // 1 ms inside the window
  const sig = signRetellWebhook(BODY, SECRET, boundaryTs);
  assert.equal(verifyRetellSignature(BODY, sig, SECRET, { now: NOW }), true);
});

// ── Frame integrity: 1-bit flip rejected ─────────────────────────────────────

test("S5 a 1-bit flip in any payload byte is rejected by the truncated HMAC tag", () => {
  const frame = goodFrame();
  // Flip a bit in byte 3 (target|severity nibbles — part of authenticated prefix)
  const flipped = Buffer.from(frame);
  flipped[3] ^= 0x01;
  const result = decodeFrame(flipped, FRAME_KEY);
  assert.equal(result.ok, false);
  assert.match(result.error, /signature/);
});

test("S5b a 1-bit flip in the HMAC tag itself is rejected", () => {
  const frame = goodFrame();
  const flipped = Buffer.from(frame);
  flipped[11] ^= 0x80; // flip MSB of first tag byte
  const result = decodeFrame(flipped, FRAME_KEY);
  assert.equal(result.ok, false);
});

// ── Replay window ─────────────────────────────────────────────────────────────

test("S6 replay window accepts out-of-order sequences within the 64-slot window", () => {
  const rw = new ReplayWindow(64);
  // Advance the max to 100
  for (let i = 0; i <= 100; i++) rw.accept(i);
  // Sequence 37 is exactly at the edge (100 - 64 + 1 = 37), should be accepted if not seen
  const fresh = new ReplayWindow(64);
  fresh.accept(100); // set max = 100; 37..100 are valid
  assert.equal(fresh.accept(37), true,  "seq 37 (oldest valid slot) should be accepted");
  assert.equal(fresh.accept(80), true,  "seq 80 (within window, unseen) should be accepted");
  assert.equal(fresh.accept(99), true,  "seq 99 (within window, unseen) should be accepted");
});

test("S6b replay window rejects duplicate sequence within the window", () => {
  const rw = new ReplayWindow(64);
  assert.equal(rw.accept(50), true);
  assert.equal(rw.accept(50), false, "duplicate seq should be rejected");
});

test("S6c replay window rejects sequence beyond (behind) the 64-slot window", () => {
  const rw = new ReplayWindow(64);
  rw.accept(100); // max = 100; sequences <= 36 are outside window
  assert.equal(rw.accept(36), false, "seq 36 is outside the 64-wide window");
  assert.equal(rw.accept(0),  false, "seq 0 is far outside the window");
});

test("S6d a valid frame is accepted exactly once by the replay window, then rejected on replay", () => {
  const rw = new ReplayWindow(64);
  const frame = encodeFrame({ type: "directive", zone: 1, target: "road", severity: 2, action: "info_only", language: "en", sequence: 42 }, FRAME_KEY);
  const r1 = decodeFrame(frame, FRAME_KEY, rw);
  assert.equal(r1.ok, true);
  const r2 = decodeFrame(frame, FRAME_KEY, rw);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /replay/);
});
