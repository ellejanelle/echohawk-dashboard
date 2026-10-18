// Research export. Mentor feedback (Oct 17): what EchoHawk learns should flow back
// to researchers and planners. One row per incident.
//
// No phone numbers, device ids, independence keys, transcripts or names are included.
// Time is kept to the minute. The CSV header must never include identifying columns.
const secsBetween = (a, b) =>
  a && b ? Math.round((new Date(b) - new Date(a)) / 1000) : "";

/**
 * Build a row per incident for the research export.
 * No identifying information: no independence_key, identifier, phone, device,
 * call_id or transcript fields.
 *
 * @param {import('./store.js').Store} store
 * @returns {object[]}
 */
export function researchRows(store) {
  return store.incidents.map((i) => {
    const packets = store.packets.filter((p) => p.incident_id === i.id);
    const by = (src) => packets.filter((p) => p.source === src).length;
    const units = i.dispatched || [];
    const firstAssigned = units.map((u) => u.at).filter(Boolean).sort()[0] || null;
    const onScene =
      units
        .flatMap((u) => (u.history || []).filter((h) => h.status === "on_scene").map((h) => h.at))
        .sort()[0] || null;

    return {
      incident_id: i.id,
      zone: i.zone_id,
      what: i.target,
      opened_minute: String(i.opened_at || "").slice(0, 16),
      reports: packets.length,
      independent_sources: i.independent_count || 0,
      by_call_ai: by("voice"),
      by_app: by("app"),
      by_chirp_or_node: by("ehawk"),
      by_alarm: by("telemetry"),
      heard_by_nodes: Math.max(0, ...packets.map((p) => (p.heard_by || []).length)),
      highest_rung: i.rung,
      needed_a_person: i.rung === "hand" ? 1 : 0,
      self_reported_severity_held: packets.filter((p) => p.reported_severity).length,
      units_sent: units.length,
      seconds_to_first_unit: secsBetween(i.opened_at, firstAssigned),
      seconds_to_on_scene: secsBetween(i.opened_at, onScene),
      disposition: i.disposition?.code || (i.closed_at ? "closed" : "open"),
    };
  });
}

/**
 * Serialise research rows to CSV. The header is fixed by the row shape;
 * special characters are escaped.
 *
 * @param {object[]} rows
 * @returns {string}
 */
export function toCsv(rows) {
  if (!rows.length) return "incident_id\n";
  const cols = Object.keys(rows[0]);
  const esc = (v) =>
    /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return (
    [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c] ?? "")).join(","))].join("\n") +
    "\n"
  );
}
