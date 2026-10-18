#!/usr/bin/env node
// USB bridge: the laptop the ESP32 is plugged into stands in for a pole node.
// It reads the chip's serial output; an alert line becomes a signed SOS posted to the EchoHawk server, and the
// server's signed receipt is written back to the chip. A cancel line is logged on the incident as "sender cancelled"
// (a person still closes it on the board; nothing automated closes an SOS).
//
// Install once (Node 20+):   npm install serialport
// Run:                       node scripts/usb_bridge.mjs
//
// Settings (environment variables, all optional):
//   SERVER_URL      https://echohawk-production-505f.up.railway.app   (no trailing slash)
//   FRAME_KEY       dev-frame-key           must equal the server's ECHOHAWK_FRAME_KEY
//   SERIAL_PORT     auto                    e.g. /dev/cu.usbserial-0001 (Mac) or COM5 (Windows); auto picks the first USB serial port
//   BAUD            115200                  the number in the sketch's Serial.begin(...)
//   ALERT_MATCH     SOS|ALERT               regex; a serial line matching it sends the SOS (case-insensitive)
//   CANCEL_MATCH    CANCEL                  regex; a serial line matching it cancels
//   DEVICE_ID       auto                    device identity; auto = the chip's MAC if the sketch prints "MAC: xx:xx:..." at boot
//   ZONE            6                       zone number the tag reports from (demo: 6 = Z06)
//
// Device identity: the ESP32's factory MAC address is its serial number. If the sketch prints it (WiFi.macAddress() or
// esp_read_mac), the bridge picks it up; otherwise set DEVICE_ID. The id goes in node_id as TAG-<id> so the board shows
// which device pressed. The HMAC signature proves the frame came from a device holding the key; the id itself is not signed.

import { createHmac } from "node:crypto";

const SERVER_URL = (process.env.SERVER_URL || "https://echohawk-production-505f.up.railway.app").replace(/\/+$/, "");
const FRAME_KEY = process.env.FRAME_KEY || "dev-frame-key";
const BAUD = Number(process.env.BAUD || 115200);
const ALERT = new RegExp(process.env.ALERT_MATCH || "SOS|ALERT", "i");
const CANCEL = new RegExp(process.env.CANCEL_MATCH || "CANCEL", "i");
const ZONE = Number(process.env.ZONE || 6);
const REPEAT_MS = 5000;
let deviceId = process.env.DEVICE_ID || "";

let SerialPort, ReadlineParser;
try { ({ SerialPort, ReadlineParser } = await import("serialport")); }
catch { console.error("Missing dependency. Run:  npm install serialport   (in the repo folder), then start the bridge again."); process.exit(2); }

async function pickPort() {
  if (process.env.SERIAL_PORT && process.env.SERIAL_PORT !== "auto") return process.env.SERIAL_PORT;
  const ports = await SerialPort.list();
  const usb = ports.filter((p) => /usb|wch|cp210|ch340|silabs|ftdi/i.test(`${p.path} ${p.manufacturer || ""} ${p.vendorId || ""}`));
  const pick = usb[0] || ports[0];
  if (!pick) { console.error("No serial port found. Plug the ESP32 in and close Arduino's Serial Monitor."); process.exit(2); }
  console.log(`serial ports: ${ports.map((p) => p.path).join(", ")} -> using ${pick.path}`);
  return pick.path;
}

// ── 16-byte frame, same layout and key as device/frame.js and the firmware ─────────────────────────────────────────
function sosFrame(sequence) {
  const f = Buffer.alloc(16);
  f[0] = (1 << 4) | 2;                       // version 1, type 2 = SOS
  f[1] = ZONE >> 8; f[2] = ZONE & 255;       // zone
  f[3] = (9 << 4) | 5;                       // target 9 = person, severity 5
  f[4] = (1 << 4) | 0;                       // action 1 = dispatch_ems, language 0 = en
  const m = Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 60000);
  f[5] = m >>> 24; f[6] = (m >>> 16) & 255; f[7] = (m >>> 8) & 255; f[8] = m & 255;
  f[9] = sequence >> 8; f[10] = sequence & 255;
  createHmac("sha256", FRAME_KEY).update(f.subarray(0, 11)).digest().subarray(0, 5).copy(f, 11);
  return f;
}
function verifyAck(ack, sequence) {
  if (ack.length !== 16 || (ack[0] & 15) !== 3) return null;
  const mac = createHmac("sha256", FRAME_KEY).update(ack.subarray(0, 11)).digest().subarray(0, 5);
  if (!mac.equals(ack.subarray(11)) || ((ack[9] << 8) | ack[10]) !== sequence) return null;
  return { stage: ack[3] & 15, node: (ack[1] << 8) | ack[2] };
}

const nodeId = () => `TAG-${(deviceId || "USB").replace(/[^A-Za-z0-9]/g, "").slice(-12).toUpperCase() || "USB"}`;
const post = (path, body) => fetch(`${SERVER_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ── one emergency = one sequence; repeat every 5 s until the server confirms ──────────────────────────────────────
let active = null; // { sequence, frame, timer, incident_id }
async function sendOnce(port) {
  if (!active) return;
  const { sequence, frame } = active;
  try {
    const r = await post("/device/packets", { node_id: nodeId(), channel: "wifi", frame_b64: frame.toString("base64") });
    const out = await r.json().catch(() => ({}));
    if (r.status === 400) { console.error(`server refused the frame: ${out.error || out.errors}. FRAME_KEY must equal the server's ECHOHAWK_FRAME_KEY.`); stop(); return; }
    if (!r.ok) { console.error(`server ${r.status}; retrying in ${REPEAT_MS / 1000} s`); return; }
    active.incident_id = out.incident_id || active.incident_id;
    const ack = out.ack_b64 ? verifyAck(Buffer.from(out.ack_b64, "base64"), sequence) : null;
    console.log(`${out.duplicate ? "already on the board" : "on the board"}: incident ${active.incident_id} (${out.rung === "hand" ? "needs a person" : out.rung || "duplicate"}), receipt ${ack ? `valid, stage ${ack.stage} (delivered)` : "missing"}`);
    if (ack) {
      try { port.write(`ACK ${out.ack_b64}\n`); } catch { /* the sketch may not read serial; fine */ }
      clearInterval(active.timer); active.timer = null; // delivered: stop repeating, keep the incident for cancel
    }
  } catch (e) { console.error(`no route to the server (${e.message}); retrying in ${REPEAT_MS / 1000} s`); }
}
function start(port) {
  if (active) { console.log("SOS already active; ignoring repeat press"); return; }
  const sequence = Math.floor(Math.random() * 0xffff);
  active = { sequence, frame: sosFrame(sequence), timer: null, incident_id: null };
  console.log(`SOS #${sequence} from ${nodeId()} -> ${SERVER_URL}`);
  sendOnce(port);
  active.timer = setInterval(() => sendOnce(port), REPEAT_MS);
}
async function stop() {
  if (!active) return;
  if (active.timer) clearInterval(active.timer);
  const { incident_id, sequence } = active; active = null;
  if (!incident_id) { console.log("SOS cancelled before delivery"); return; }
  try {
    const r = await post("/device/cancel", { incident_id, sequence, node_id: nodeId() });
    console.log(r.ok ? `cancel noted on ${incident_id} (a person closes it on the board)` : `cancel not recorded: server ${r.status}`);
  } catch (e) { console.error(`could not note the cancel: ${e.message}`); }
}

// ── serial ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const path = await pickPort();
const port = new SerialPort({ path, baudRate: BAUD });
const lines = port.pipe(new ReadlineParser({ delimiter: "\n" }));
port.on("open", () => console.log(`listening on ${path} at ${BAUD}; alert = /${ALERT.source}/i, cancel = /${CANCEL.source}/i; server ${SERVER_URL}`));
port.on("error", (e) => { console.error(`serial: ${e.message}`); process.exit(1); });
lines.on("data", (raw) => {
  const line = String(raw).trim(); if (!line) return;
  console.log(`chip> ${line}`);
  const mac = line.match(/([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i);
  if (mac && !process.env.DEVICE_ID) { deviceId = mac[1].replace(/:/g, ""); console.log(`device id from chip: ${mac[1]} -> ${nodeId()}`); }
  if (CANCEL.test(line)) return stop();
  if (ALERT.test(line)) return start(port);
});
