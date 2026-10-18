// 16-byte signed frame for chirp and LoRa (docs/docs/IMPLEMENTATION_PLAN.md Section 4).
// byte0: version(4) | type(4); bytes1-2 zone; byte3 target(4)|severity(4); byte4 action(4)|language(4);
// bytes5-8 issued_at minutes since 2025-01-01 UTC; bytes9-10 sequence; bytes11-15 HMAC-SHA256 truncated to 40 bits.
import { createHmac, timingSafeEqual } from "node:crypto";

export const TYPES = { directive: 0, checkin: 1, sos: 2, ack: 3 };
export const EPOCH_MS = Date.UTC(2025, 0, 1);
export const TARGET_CODES = ["unknown", "power", "water", "gas", "power_line", "structure_fire", "wildfire", "road", "flood", "person", "vehicle"];
export const ACTION_CODES = ["unknown", "dispatch_ems", "dispatch_fire", "dispatch_police", "welfare_check", "info_only", "deflect_311", "shelter_in_place", "evacuate", "all_clear"];
// 4-bit field: the original 8 keep their codes; the other 7 of the 15 recognized languages follow (index 15 = unknown)
export const LANG_CODES = ["en", "es", "ko", "zh", "tl", "hy", "vi", "fa", "ru", "ar", "ja", "hi", "th", "uk", "yue"];

export function encodeFrame({ type, zone, target, severity, action, language, issuedAtMs = Date.now(), sequence }, key) {
  const b = Buffer.alloc(16);
  b[0] = (1 << 4) | (TYPES[type] & 0x0f);
  b.writeUInt16BE(zone & 0xffff, 1);
  b[3] = ((TARGET_CODES.indexOf(target) & 0x0f) << 4) | (severity & 0x0f);
  b[4] = ((ACTION_CODES.indexOf(action) & 0x0f) << 4) | (LANG_CODES.indexOf(language) & 0x0f);
  b.writeUInt32BE(Math.floor((issuedAtMs - EPOCH_MS) / 60000) >>> 0, 5);
  b.writeUInt16BE(sequence & 0xffff, 9);
  const mac = createHmac("sha256", key).update(b.subarray(0, 11)).digest().subarray(0, 5);
  mac.copy(b, 11);
  return b;
}

export function decodeFrame(buf, key, replay = new ReplayWindow()) {
  const b = Buffer.from(buf);
  if (b.length !== 16) return { ok: false, error: "bad length" };
  const mac = createHmac("sha256", key).update(b.subarray(0, 11)).digest().subarray(0, 5);
  if (!timingSafeEqual(mac, b.subarray(11, 16))) return { ok: false, error: "signature invalid" };
  const sequence = b.readUInt16BE(9);
  if (!replay.accept(sequence)) return { ok: false, error: "rejected: replay" };
  const typeCode = b[0] & 0x0f;
  return {
    ok: true,
    type: Object.keys(TYPES).find((k) => TYPES[k] === typeCode),
    zone: b.readUInt16BE(1),
    target: TARGET_CODES[b[3] >> 4] || "unknown",
    severity: b[3] & 0x0f,
    action: ACTION_CODES[b[4] >> 4] || "unknown",
    language: LANG_CODES[b[4] & 0x0f] || "en",
    issuedAt: new Date(EPOCH_MS + b.readUInt32BE(5) * 60000).toISOString(),
    sequence,
  };
}

// 64-wide sliding window anti-replay (team default from the spec).
export class ReplayWindow {
  constructor(size = 64) { this.size = size; this.max = -1; this.seen = new Set(); }
  accept(seq) {
    if (this.max === -1) { this.max = seq; this.seen.add(seq); return true; }
    if (seq > this.max) { this.max = seq; this.seen.add(seq); for (const s of this.seen) if (s <= this.max - this.size) this.seen.delete(s); return true; }
    if (seq <= this.max - this.size) return false;
    if (this.seen.has(seq)) return false;
    this.seen.add(seq); return true;
  }
}

export const toBase64 = (buf) => Buffer.from(buf).toString("base64");
export const fromBase64 = (s) => Buffer.from(s, "base64");
