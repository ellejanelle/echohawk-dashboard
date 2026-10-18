// Replay a real LAPD day through the EchoHawk engine (no Retell, no network).
// Source: LAPD Calls for Service 2024 to Present (data.lacity.org xjgu-z4ju), dispatched incidents,
// officer-initiated rows removed in prep_lapd.py.
//
// What the data can show: arrival order, how many separate tickets a dispatcher handled,
// and when EchoHawk would have grouped and flagged them.
// What it cannot show: response times or outcomes (the dataset has neither), so the page
// never claims them.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { makePacket } from "./schema.js";
import { loadAdjacency, loadBaselines } from "./seed.js";

// LAPD call type text → EchoHawk target/action/severity/source (radio-code families; team mapping, not LAPD's)
const RULES = [
  [/^906|RINGER|SILENT|ALARM/i,            { source: "telemetry", target: "alarm",          action: "dispatch_police", severity: 2 }],
  [/\bFIRE\b|\bFD\b/i,                      {                      target: "structure_fire", action: "dispatch_fire",   severity: 4 }],
  [/^90[47]|^918|^927|AMB|CPI|O\/D|SUICIDE|DEAD|D\/B/i, {         target: "person",         action: "dispatch_ems",    severity: 4 }],
  [/T\/C|TRAFFIC|^961/i,                    {                      target: "vehicle",         action: "dispatch_police", severity: 3 }],
  [/^903|HAZARD|WIRE|TREE|FLOOD/i,          {                      target: "road",            action: "dispatch_police", severity: 3 }],
  [/^900|UNKNOWN/i,                         {                      target: "unknown",         action: "dispatch_police", severity: 3 }],
  [/W\/GUN|SHOTS|^246|^211|ROBBERY|^245/i, {                      target: "crime",           action: "dispatch_police", severity: 4 }],
  [/./,                                      {                      target: "crime",           action: "dispatch_police", severity: 2 }],
];
export const classify = (text) => ({ source: "voice", ...RULES.find(([re]) => re.test(text))[1] });

export function availableDays() {
  if (!existsSync("data/replay")) return [];
  return readdirSync("data/replay")
    .filter((f) => /^lapd_\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .map((f) => f.slice(5, 15))
    .sort();
}

export function runReplay(date, { fromHour = 0, toHour = 24 } = {}) {
  const file = `data/replay/lapd_${date}.csv`;
  if (!existsSync(file)) return { error: `no replay file for ${date}`, days: availableDays() };

  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const head = lines.shift().split(",");
  const col = (n) => head.indexOf(n);

  const rows = lines
    .map((l) => l.split(","))
    .map((c) => ({ id: c[col("incident_number")], area: c[col("area_occ")], rd: c[col("rpt_dist")], ts: c[col("ts")], type: c[col("call_type_text")] }))
    .filter((r) => { const h = Number(r.ts.slice(11, 13)); return h >= fromHour && h < toHour; })
    .sort((a, b) => a.ts.localeCompare(b.ts));

  // Fresh in-memory engine with the real LAPD hourly baselines.
  // Timestamps are kept as local wall-clock in UTC form so they line up with the baseline's local hour.
  const store = new Store();
  loadBaselines(store);
  const engine = new Engine(store, { adjacency: loadAdjacency() });
  const flags = [];
  store.onEvent((e) => { if (e.event_type === "scan_flagged") flags.push(e.payload_json); });

  const frames = [];
  for (const r of rows) {
    const k = classify(r.type);
    if (k.target === "crime") {
      // Individual crimes are not area events: EchoHawk passes them to dispatch unchanged, one ticket each
      frames.push({ t: r.ts.slice(11, 19), id: r.id, rd: r.rd, area: r.area, type: r.type, target: "crime", machine: false, incident: "solo_" + r.id, incident_size: 1, independent: 1, machine_count: 0, rung: "watch", reason: "individual call, dispatched as usual", flagged: null, passthrough: true });
      continue;
    }
    const { packet, errors } = makePacket({ source: k.source, identifier: r.id, zone_id: r.rd, target: k.target, severity: k.severity, action: k.action, provenance: "simulated", content_status: "extracted" });
    if (errors.length) continue;
    packet.received_at = r.ts.replace(" ", "T") + "Z";
    const before = flags.length;
    const out = engine.ingest(packet, {});
    const inc = out.incident;
    frames.push({
      t: r.ts.slice(11, 19), id: r.id, rd: r.rd, area: r.area, type: r.type, target: k.target, machine: k.source === "telemetry",
      incident: inc?.id || null, incident_size: inc?.packet_ids.length || 0, independent: inc?.independent_count || 0, machine_count: inc?.machine_count || 0,
      rung: inc?.rung || "watch", reason: inc?.last_reason || "", flagged: flags.length > before ? flags.at(-1) : null,
    });
  }
  frames.forEach((f, i) => { f.n = i + 1; }); // 1-based ticket number in arrival order

  const passthrough = frames.filter((f) => f.passthrough).length;
  const incidents = store.incidents.map((i) => ({
    id: i.id, rd: i.zone_id, target: i.target, size: i.packet_ids.length, independent: i.independent_count,
    machine: i.machine_count || 0, rung: i.rung, opened: i.opened_at.slice(11, 19), last: i.last_packet_at.slice(11, 19),
    reason: i.last_reason, ...incidentTrail(frames, i.id),
  }));
  const multi = incidents.filter((i) => i.size > 1);

  return {
    date, fromHour, toHour, source: "LAPD Calls for Service (data.lacity.org xjgu-z4ju), officer-initiated removed",
    totals: { calls: frames.length, tickets_as_it_happened: frames.length, echohawk_lines: incidents.length + passthrough, passthrough_crime: passthrough, grouped_lines: multi.length, calls_in_groups: multi.reduce((a, i) => a + i.size, 0), machine_calls: frames.filter((f) => f.machine).length, scan_flags: flags.length },
    frames, incidents, flags: flags.map((f) => ({ ...f, time: f.window_start.slice(11, 16) })),
  };
}

/** Where an incident sits in the arrival stream: its area, which ticket numbers fed it, when scan flagged it. */
function incidentTrail(frames, id) {
  const fs = frames.filter((f) => f.incident === id);
  const fl = fs.find((f) => f.flagged);
  return {
    area: fs[0]?.area || "",
    ticket_numbers: fs.map((f) => f.n),
    call_types: [...new Set(fs.map((f) => f.type))],
    flag: fl ? { t: fl.t, ticket: fl.n, nth_in_line: fs.indexOf(fl) + 1, window_n: fl.flagged.n, p_tail: fl.flagged.p_tail, lambda: fl.flagged.lambda } : null,
  };
}
