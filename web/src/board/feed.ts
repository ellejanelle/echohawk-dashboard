import type { EventRow, Incident } from "../shared/types";
import { RUNG_LABEL, plainReason, tName, trig, unitLabel, SOURCE, requestTitle } from "../shared/labels";

export const FEED_COLOR: Record<string, string> = {
  packet_created: "var(--watch)", incident_opened: "var(--watch)", rung_changed: "var(--hand)", trigger_fired: "var(--hand)", incident_spread: "var(--ask)",
  scan_flagged: "var(--ask)", units_dispatched: "var(--ok)", call_flagged: "var(--machine)", transfer_started: "var(--ok)", kit_shown: "var(--muted)",
  callback_no_answer: "var(--ask)", dispatcher_joined: "var(--ok)", dispatcher_said: "var(--muted)",
  unit_status: "var(--teal)", incident_disposition: "var(--muted)", report_picked_up: "var(--hand)", relay_heard: "var(--muted)",
  alert_sent: "var(--ask)", alert_requested: "var(--ask)", alert_cancelled: "var(--muted)", alert_ack: "var(--ok)",
};
export const FEED_TYPES = new Set(Object.keys(FEED_COLOR));

// One human sentence per event, instead of raw JSON.
export function feedLine(ev: EventRow, byId: Record<string, Incident>): { where: string; text: string } {
  const p = ev.payload_json || {}, i = ev.incident_id ? byId[ev.incident_id] : undefined;
  const where = String(p.zone_id || i?.zone_id || "");
  const t = p.target || i?.target;
  const title = requestTitle({ target: t, intake_pending: p.intake_pending ?? i?.intake_pending });
  switch (ev.event_type) {
    case "report_picked_up": return { where: where || "no zone", text: `eHawk SOS picked up by ${p.node_id} over ${p.channel === "ble" ? "Bluetooth" : p.channel}, receipt sent back` };
    case "relay_heard": return { where: where || "", text: `same report also heard by ${p.node_id} (${p.channel === "ble" ? "Bluetooth" : p.channel}), counted once` };
    case "packet_created": return { where: where || "no zone", text: p.source === "telemetry" ? "alarm activation (machine)" : p.content_status === "none" ? "call with no usable details (counted for volume only)" : `${title} · new ${(SOURCE[p.source] || "request").toLowerCase()}` };
    case "incident_opened": return { where, text: `new incident: ${title}` };
    case "rung_changed": return { where, text: `${title} moved to ${RUNG_LABEL[p.to as keyof typeof RUNG_LABEL] || p.to} (${plainReason(p.reason)})` };
    case "trigger_fired": return { where, text: `priority signal: ${(p.triggers || []).map(trig).join(", ")}` };
    case "incident_spread": return { where: (p.zones || []).join(" and "), text: `${tName(p.target)} spreading across neighboring zones` };
    case "scan_flagged": return { where, text: `unusual volume: ${p.n} reports in 15 min` };
    case "units_dispatched": return { where, text: `${(p.units || []).map(unitLabel).join(", ")} sent by ${ev.actor || ""}` };
    case "call_flagged": return { where: "", text: `AI call flagged for review: ${String(p.flag || "").replace(/_/g, " ")}` };
    case "transfer_started": return { where: "", text: "AI call handed to a dispatcher" };
    case "kit_shown": return { where, text: "caller sent a safety card" };
    case "callback_no_answer": return { where, text: "callback not answered" };
    case "dispatcher_joined": return { where: "", text: "dispatcher joined a live call" };
    case "dispatcher_said": return { where: "", text: "dispatcher spoke on a live call" };
    case "unit_status": return { where, text: `${String(p.unit || "").toUpperCase()} ${String(p.status || "").replace("_", " ")}` };
    case "incident_disposition": return { where, text: `closed: ${String(p.disposition || "").replace(/_/g, " ")}` };
    case "alert_sent": return { where: (p.zones || []).join(", "), text: `public alert sent: ${String(p.kind || "").replace(/_/g, " ")} (${p.by?.agency || ""})` };
    case "alert_requested": return { where: (p.zones || []).join(", "), text: `asked agencies for: ${String(p.kind || "").replace(/_/g, " ")}` };
    case "alert_cancelled": return { where: "", text: "public alert lifted" };
    case "alert_ack": return { where: "", text: p.status === "need_help" ? "resident replied: NEED HELP" : p.status === "safe" ? "resident replied: safe" : "resident replied: left the area" };
    default: return { where: "", text: ev.event_type };
  }
}
