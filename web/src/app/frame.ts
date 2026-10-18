// Signed 16-byte directive frames (same layout as device/frame.js) and the ggwave audio modem, in the browser.
// Verify key: demo value matching the server default ECHOHAWK_FRAME_KEY. In production the app ships an agency verify key.
const FRAME_KEY = "dev-frame-key";
export const TARGET_CODES = ["unknown", "power", "water", "gas", "power_line", "structure_fire", "wildfire", "road", "flood", "person", "vehicle"];
export const ACTION_CODES = ["unknown", "dispatch_ems", "dispatch_fire", "dispatch_police", "welfare_check", "info_only", "deflect_311", "shelter_in_place", "evacuate", "all_clear"];
export const LANG_CODES = ["en", "es", "ko", "zh", "tl", "hy", "vi", "fa", "ru", "ar", "ja", "hi", "th", "uk", "yue"];
const TYPES = ["directive", "checkin", "sos", "ack"];
const EPOCH_MS = Date.UTC(2025, 0, 1);

export interface Frame { ok: true; type: string; zone: number; target: string; severity: number; action: string; language: string; issuedAt: string; sequence: number }
export type Verified = Frame | { ok: false; error: string };

async function hmac(bytes: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(FRAME_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes.slice(0, 11) as BufferSource)).slice(0, 5);
}

let maxSeq = -1;
export async function verifyFrame(bytes: Uint8Array): Promise<Verified> {
  if (bytes.length !== 16) return { ok: false, error: "bad length" };
  const mac = await hmac(bytes);
  if (!mac.every((b, i) => b === bytes[11 + i])) return { ok: false, error: "signature invalid" };
  const seq = (bytes[9] << 8) | bytes[10];
  if (seq <= maxSeq) return { ok: false, error: "replay rejected" };
  maxSeq = seq;
  const mins = (((bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8]) >>> 0);
  return { ok: true, type: TYPES[bytes[0] & 0x0f], zone: (bytes[1] << 8) | bytes[2], target: TARGET_CODES[bytes[3] >> 4] || "unknown", severity: bytes[3] & 0x0f, action: ACTION_CODES[bytes[4] >> 4] || "unknown", language: LANG_CODES[bytes[4] & 0x0f] || "en", issuedAt: new Date(EPOCH_MS + mins * 60000).toISOString(), sequence: seq };
}

// a "picked up" or "delivered" receipt for a report this phone sent: signed ack frame, same sequence as the report.
// Stage: 1 picked up by a node, 2 delivered to dispatch, 3 unit assigned. Zone field carries the node number.
export const ACK_LABEL: Record<number, string> = { 1: "Picked up by a node", 2: "Delivered to dispatch", 3: "A unit is assigned" };
export async function readAck(bytes: Uint8Array, sequence: number): Promise<{ stage: number; node: number } | null> {
  if (bytes.length !== 16 || (bytes[0] & 0x0f) !== 3) return null;
  const mac = await hmac(bytes);
  if (!mac.every((b, i) => b === bytes[11 + i])) return null;
  if (((bytes[9] << 8) | bytes[10]) !== sequence) return null;
  return { stage: bytes[3] & 0x0f, node: (bytes[1] << 8) | bytes[2] };
}

// a node's own receipt (stage 1, picked up) signed on the spot, before any network
export const signAck = (a: { stage: number; sequence: number; node: number; language?: string }) =>
  signFrame({ type: "ack", zone: a.node, target: "unknown", severity: a.stage, action: "unknown", language: a.language || "en", sequence: a.sequence });
export const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const NUS_UUIDS = { service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e", rx: "6e400002-b5a3-f393-e0a9-e50e24dcca9e", tx: "6e400003-b5a3-f393-e0a9-e50e24dcca9e" };

// Bluetooth to an EchoHawk node (ESP32) using the Nordic UART service: write the 16-byte frame, receipts come back as
// notifications. Web Bluetooth works in Chrome on Android, Mac, Windows and ChromeOS; not in Safari or on iPhone.
const NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e", NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e", NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
export const bleAvailable = () => typeof navigator !== "undefined" && "bluetooth" in navigator;
export async function sendBle(frame: Uint8Array, onReceipt: (bytes: Uint8Array) => void): Promise<{ name: string; close: () => void }> {
  const bt = (navigator as any).bluetooth;
  const device = await bt.requestDevice({ filters: [{ namePrefix: "EchoHawk" }], optionalServices: [NUS] });
  const server = await device.gatt.connect();
  const svc = await server.getPrimaryService(NUS);
  const tx = await svc.getCharacteristic(NUS_TX);
  await tx.startNotifications();
  tx.addEventListener("characteristicvaluechanged", (e: any) => onReceipt(new Uint8Array(e.target.value.buffer)));
  const rx = await svc.getCharacteristic(NUS_RX);
  await rx.writeValue(frame);
  return { name: device.name || "EchoHawk node", close: () => { try { device.gatt.disconnect(); } catch { /* gone */ } } };
}

export async function signFrame(f: { type: string; zone: number; target: string; severity: number; action: string; language: string; sequence: number }) {
  const b = new Uint8Array(16);
  b[0] = (1 << 4) | TYPES.indexOf(f.type); b[1] = f.zone >> 8; b[2] = f.zone & 0xff;
  b[3] = (TARGET_CODES.indexOf(f.target) << 4) | f.severity;
  b[4] = (ACTION_CODES.indexOf(f.action) << 4) | Math.max(0, LANG_CODES.indexOf(f.language === "fil" ? "tl" : f.language)) ;
  const mins = Math.floor((Date.now() - EPOCH_MS) / 60000) >>> 0;
  b[5] = mins >>> 24; b[6] = (mins >>> 16) & 0xff; b[7] = (mins >>> 8) & 0xff; b[8] = mins & 0xff; b[9] = f.sequence >> 8; b[10] = f.sequence & 0xff;
  b.set(await hmac(b), 11);
  return b;
}

// ---- ggwave (vendored at /vendor/ggwave.js, loaded by the page as a global) ----
declare global { interface Window { ggwave_factory?: () => Promise<any> } }
let gg: any = null, inst: any = null, ctx: AudioContext | null = null;
export async function prepareChirp() {
  ctx ||= new AudioContext({ sampleRate: 48000 });
  if (ctx.state === 'suspended') await ctx.resume();
}
async function init() {
  if (gg) return;
  if (!window.ggwave_factory) throw new Error("chirp modem not loaded");
  gg = await window.ggwave_factory();
  const p = gg.getDefaultParameters(); p.sampleRateInp = 48000; p.sampleRateOut = 48000; p.payloadLength = 16;
  inst = gg.init(p);
  ctx ||= new AudioContext({ sampleRate: 48000 });
}
function convert(src: ArrayBufferView, Type: any) { const buf = new ArrayBuffer(src.byteLength); new (src.constructor as any)(buf).set(src); return new Type(buf); }

export async function listen(onBytes: (b: Uint8Array) => void): Promise<() => void> {
  await prepareChirp();
  await init();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false } });
  const src = ctx!.createMediaStreamSource(stream);
  const node = ctx!.createScriptProcessor(1024, 1, 1);
  node.onaudioprocess = (e) => { const res = gg.decode(inst, convert(new Float32Array(e.inputBuffer.getChannelData(0)), Int8Array)); if (res && res.length) onBytes(new Uint8Array(res)); };
  src.connect(node); node.connect(ctx!.destination);
  return () => { node.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); };
}

export async function chirp(bytes: Uint8Array) {
  await prepareChirp();
  await init();
  const wave = gg.encode(inst, bytes, gg.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, 10);
  const buf = convert(new Int8Array(wave), Float32Array);
  const ab = ctx!.createBuffer(1, buf.length, 48000); ab.getChannelData(0).set(buf);
  const s = ctx!.createBufferSource(); s.buffer = ab; s.connect(ctx!.destination); s.start(0);
}

const SPEECH: Record<string, string> = { en: "en-US", es: "es-MX", zh: "zh-CN", yue: "zh-HK", ko: "ko-KR", fil: "fil-PH", hy: "hy-AM", vi: "vi-VN", fa: "fa-IR", ru: "ru-RU", ar: "ar-SA", ja: "ja-JP", hi: "hi-IN", th: "th-TH", uk: "uk-UA" };
export function speak(text: string, lang: string) { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = SPEECH[lang] || "en-US"; speechSynthesis.speak(u); } catch { /* no speech */ } }
