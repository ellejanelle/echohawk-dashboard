// Turn calls and incidents into one list of cards, each in a lane.
import { SOURCE, sourcesLabel } from "../shared/labels";
import type { Call, Dispatched, Incident, Rung } from "../shared/types";

export type Lane = "need" | "ai" | "done";
export interface Item {
  demo?: boolean;
  source_label: string;
  intake_pending?: boolean;
  kind: "call" | "report";
  id: string;
  lane: Lane;
  live: boolean;
  rung: Rung | null;
  zone: string | null;
  target?: string;
  severity?: number | null;
  language?: string;
  start: string;
  end?: string | null;
  last_at?: string;
  action?: string;
  incident_id?: string | null;
  independent?: number;
  machine?: number;
  size?: number;
  triggers: string[];
  dispatched: Dispatched[];
  flags: string[];
  status?: string;
  last: { role: string; text: string; tr?: string }[];
  reason?: string;
  score?: number;
  trend?: string;
  spread?: string | null;
}

export function buildItems(calls: Call[], incs: Incident[]): Item[] {
  const items: Item[] = [];
  for (const c of calls) {
    const live = !c.ended_at;
    const flags = [...new Set((c.flags || []).map((f) => f.flag))];
    const hard = (c.triggers || []).length > 0;
    const sent = (c.dispatched || []).length > 0;
    let lane: Lane;
    if (c.status === "transferred" && live) lane = "need";
    else if (flags.length && !sent) lane = "need";
    else if (live) lane = c.rung === "hand" || hard ? "need" : "ai";
    else lane = (hard || c.status === "transferred") && !sent ? "need" : "done";
    items.push({
      kind: "call", source_label: SOURCE[c.source || "voice"] || c.source!, intake_pending: c.intake_pending, demo: c.resident_demo, id: c.id, lane, live, rung: lane === "done" ? null : c.rung || null, zone: c.zone_id && c.zone_id !== "unknown" ? c.zone_id : null,
      target: c.target, severity: c.severity, language: c.language, start: c.started_at, end: c.ended_at, action: c.action, incident_id: c.incident_id,
      independent: c.independent_count, size: c.incident_size, triggers: c.triggers || [], dispatched: c.dispatched || [], flags, status: c.status, last: c.last_turns || [],
    });
  }
  // a line already shown by a live call, or by a call that needs a person, does not get a second card
  const linked = new Set(items.filter((x) => x.incident_id && (x.live || x.lane === "need")).map((x) => x.incident_id));
  for (const x of incs) {
    if (linked.has(x.id)) continue;
    const sent = (x.dispatched || []).length > 0;
    const lane: Lane = sent ? "done" : x.rung === "watch" && !(x.triggers || []).length ? "done" : "need";
    items.push({
      kind: "report", source_label: sourcesLabel(x.source_counts) || "Report", intake_pending: x.intake_pending, id: x.id, lane, live: false, rung: x.rung, zone: x.zone_id, target: x.target, start: x.first_report_at || x.opened_at || "", last_at: x.last_packet_at,
      incident_id: x.id, independent: x.independent_count, machine: x.machine_count || 0, size: (x.packet_ids || []).length, triggers: x.triggers || [], dispatched: x.dispatched || [],
      flags: [], reason: x.last_reason, score: x.score, trend: x.trend, spread: x.spread_linked_incident_id, last: [],
    });
  }
  const order: Record<string, number> = { hand: 0, ask: 1, watch: 2 };
  const rank = (a: Item) => (a.triggers.length ? -1 : 0) + (a.rung ? order[a.rung] : 3);
  const t = (a: Item) => +new Date(a.last_at || a.start);
  items.sort((a, b) => (a.lane === "need" && b.lane === "need" ? rank(a) - rank(b) : 0) || Number(b.live) - Number(a.live) || t(b) - t(a));
  return items;
}
