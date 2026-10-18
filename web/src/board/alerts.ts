// Alert model for the supervisor board: what pops, how it reads in plain words, and the evidence behind it.
import type { Incident } from "../shared/types";
import { isMachineOnly, plainReason, tName, trig, requestTitle } from "../shared/labels";

export type AlertKind = "spread" | "scan" | "trigger" | "hand";
export interface Alert {
  key: string;
  kind: AlertKind;
  level: "hand" | "ask";
  at: string;
  zones: string[];
  incidentIds: string[];
  triggers: string[];
  target?: string;
  scan?: { n: number; p_tail: number | null; lambda?: number };
}
export interface HistEntry { key: string; at: string; closed: false | "dismissed" | "acknowledged"; snap?: Alert }

export const PRIO: Record<AlertKind, number> = { spread: 0, scan: 1, trigger: 2, hand: 3 };

export function mergeAlert(list: Alert[], key: string, patch: Omit<Partial<Alert>, "key">): { list: Alert[]; isNew: boolean } {
  const cur = list.find((a) => a.key === key);
  if (!cur) {
    const a: Alert = { key, kind: patch.kind || "hand", level: patch.level || "hand", at: new Date().toISOString(), zones: patch.zones || [], incidentIds: patch.incidentIds || [], triggers: patch.triggers || [], target: patch.target, scan: patch.scan };
    return { list: [a, ...list], isNew: true };
  }
  const a: Alert = { ...cur, zones: [...cur.zones], incidentIds: [...cur.incidentIds], triggers: [...cur.triggers] };
  for (const z of patch.zones || []) if (!a.zones.includes(z)) a.zones.push(z);
  for (const id of patch.incidentIds || []) if (!a.incidentIds.includes(id)) a.incidentIds.push(id);
  for (const t of patch.triggers || []) if (!a.triggers.includes(t)) a.triggers.push(t);
  if (patch.level === "hand") a.level = "hand";
  if (patch.kind === "trigger" && a.kind === "hand") a.kind = "trigger";
  if (patch.scan) a.scan = patch.scan;
  return { list: list.map((x) => (x.key === key ? a : x)), isNew: false };
}

const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60000))} min`;

export interface Described { kind: string; title: string; hint: string; cls: "" | "amber" | "violet"; ev: string[]; incs: Incident[] }

export function describe(a: Alert, byId: Record<string, Incident>): Described {
  const incs = a.incidentIds.map((id) => byId[id]).filter(Boolean);
  const indep = incs.reduce((s, i) => s + (i.independent_count || 0), 0);
  const mach = incs.reduce((s, i) => s + (i.machine_count || 0), 0);
  const calls = incs.reduce((s, i) => s + i.packet_ids.length, 0);
  const t0 = incs.length ? Math.min(...incs.map((i) => +new Date(i.first_report_at))) : 0;
  const t1 = incs.length ? Math.max(...incs.map((i) => +new Date(i.last_packet_at))) : 0;
  const target = a.target || incs[0]?.target;
  const titleName = incs[0]?.intake_pending ? requestTitle(incs[0]) : tName(target);
  const ev: string[] = [];
  let kind = "NEEDS A PERSON", title = "", hint = "", cls: Described["cls"] = "";
  if (a.kind === "spread") {
    kind = "BIGGER ISSUE";
    const order = [...incs].sort((x, y) => +new Date(x.first_report_at) - +new Date(y.first_report_at)).map((x) => x.zone_id);
    title = `${titleName} spreading ${[...new Set([...order, ...a.zones])].join(" → ")}`;
    hint = "Same problem in neighboring zones at the same time. Treat it as one area event, not separate calls.";
  } else if (a.kind === "scan" && a.scan) {
    const s = a.scan, mo = incs.length > 0 && incs.every(isMachineOnly), z = a.zones[0];
    kind = mo ? "ALARMS ONLY" : "UNUSUAL VOLUME"; cls = mo ? "violet" : "amber";
    title = mo ? `${s.n} alarm activations in ${z} in 15 min` : `${s.n} reports in ${z} in 15 min`;
    if (s.lambda) ev.push(`${(s.n / s.lambda).toFixed(1)}x this hour's normal (${s.lambda < 1 ? s.lambda.toFixed(2) : s.lambda.toFixed(1)} per 15 min, ${z?.startsWith("Z") ? "demo baseline" : "LAPD baseline"})`);
    if (s.p_tail != null) ev.push(`chance by luck ${s.p_tail < 1e-6 ? "under 1 in a million" : "1 in " + Math.round(1 / s.p_tail).toLocaleString()}`);
    hint = mo ? "Machines, not people. Likely one cause (power or wind). Check one address before sending a truck to each alarm." : "More calls than this zone gets at this hour. Something bigger may be happening here.";
  } else if (a.kind === "trigger") {
    title = `${titleName} in ${a.zones.join(", ")} · priority signal: ${a.triggers.map(trig).join(", ")}`;
    hint = "An emergency request or safety trigger needs human review. Confirm the situation and location.";
  } else {
    title = `${titleName} in ${a.zones.join(", ")}`;
    hint = incs[0]?.last_reason ? `Why: ${plainReason(incs[0].last_reason)}` : "";
  }
  const lead: string[] = [];
  if (calls) {
    if (indep) lead.push(`${indep} independent source${indep === 1 ? "" : "s"}`);
    if (mach) lead.push(`${mach} alarm activation${mach === 1 ? "" : "s"} (machines, not counted as callers)`);
    lead.push(`${calls} request${calls === 1 ? "" : "s"} → ${Math.max(1, incs.length)} incident${incs.length > 1 ? "s" : ""}`);
  }
  // the scan alert is about one 15-minute window, so a long line-wide time span would contradict its headline
  if (t0 && t1 && calls > 1 && a.kind !== "scan" && t1 - t0 <= 30 * 60000) ev.push(`within ${mins(t1 - t0)}`);
  if (a.triggers.length && a.kind !== "trigger") ev.push(`heard: ${a.triggers.map(trig).join(", ")}`);
  if (!cls && a.level !== "hand") cls = "amber";
  return { kind, title, hint, cls, ev: [...lead, ...ev], incs };
}
