// Post one signed SOS to a deployed EchoHawk server and check the button path end to end.
// Usage: node scripts/railway_check.mjs https://<domain> <ECHOHAWK_FRAME_KEY>
import { createHmac } from "node:crypto";
const [base, KEY] = process.argv.slice(2);
if (!base || !KEY) { console.error("usage: node scripts/railway_check.mjs https://<domain> <frame key>"); process.exit(2); }
const B = base.replace(/\/+$/, "");
const sign = (f) => { createHmac("sha256", KEY).update(f.subarray(0, 11)).digest().subarray(0, 5).copy(f, 11); return f; };
const seq = Math.floor(Math.random() * 0xffff);
const f = Buffer.alloc(16); f[0] = (1 << 4) | 2; f[1] = 0; f[2] = 6; f[3] = (9 << 4) | 5; f[4] = (1 << 4) | 0;
const m = Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 60000); f[5] = m >>> 24; f[6] = (m >>> 16) & 255; f[7] = (m >>> 8) & 255; f[8] = m & 255; f[9] = seq >> 8; f[10] = seq & 255; sign(f);
const post = (p, b) => fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const body = { node_id: "N-0812-A", channel: "wifi", frame_b64: f.toString("base64") };
const h = await (await fetch(B + "/health")).json(); console.log("health:", h.ok ? "ok" : h);
const [s1, o1] = await post("/device/packets", body); console.log("signed SOS:", s1, o1.incident_id || o1.error, o1.rung || "");
const [s2, o2] = await post("/device/packets", body); console.log("same SOS again:", s2, "duplicate", o2.duplicate, "same incident", o2.incident_id === o1.incident_id);
const ack = Buffer.from(o1.ack_b64 || "", "base64");
const ok = ack.length === 16 && createHmac("sha256", KEY).update(ack.subarray(0, 11)).digest().subarray(0, 5).equals(ack.subarray(11));
console.log("receipt:", ok ? `valid, stage ${ack[3] & 15}, seq ${((ack[9] << 8) | ack[10]) === seq ? "matches" : "MISMATCH"}` : "MISSING or invalid");
const inc = (await (await fetch(B + "/incidents")).json()).find((i) => i.id === o1.incident_id);
console.log("on the board:", inc ? `${inc.id} ${inc.zone_id} ${inc.target} ${inc.rung}` : "NOT FOUND");
process.exit(s1 === 201 && o2.duplicate && ok && inc ? 0 : 1);
