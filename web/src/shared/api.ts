// Thin client for the EchoHawk Node server. Same origin in production (the server serves web/dist).
import type { Packet, Call, Incident, ZoneWindow, Turn, Kit, OpenCallback, Health, Meter, EventRow, UnitRow, HistoryFile } from "./types";

export function token(fallback: string): string {
  return new URLSearchParams(location.search).get("token") || fallback;
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json() as Promise<T>;
}

export async function post<T = Record<string, unknown>>(url: string, tok: string, body: unknown = {}): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  let data = {} as T & { error?: string };
  try { data = await r.json(); } catch { /* empty body */ }
  return { ok: r.ok, status: r.status, data };
}

const enc = encodeURIComponent;
export const api = {
  incidents: () => getJSON<Incident[]>("/incidents"),
  incident: (id: string) => getJSON<Incident & { packets: Packet[]; events: EventRow[] }>(`/incidents/${enc(id)}`),
  windows: () => getJSON<ZoneWindow[]>("/zones/windows"),
  calls: () => getJSON<Call[]>("/calls"),
  transcript: (id: string) => getJSON<Turn[]>(`/calls/${enc(id)}/transcript`),
  kits: () => getJSON<{ kits: Kit[] }>("/kits"),
  callbacks: () => getJSON<OpenCallback[]>("/callbacks/open"),
  health: () => getJSON<Health>("/health"),
  meter: () => getJSON<Meter>("/cost/meter"),
  replayDays: () => getJSON<string[]>("/replay/days"),
  replay: (date: string, from: number, to: number) => getJSON<import("./types").ReplayData>(`/replay/run?date=${enc(date)}&from=${from}&to=${to}`),

  dispatch: (tok: string, incidentId: string, units: string[], note = "") => post<{ dispatched: Incident["dispatched"] }>(`/incidents/${enc(incidentId)}/dispatch`, tok, { units, note }),
  ack: (tok: string, incidentId: string) => post(`/incidents/${enc(incidentId)}/ack`, tok),
  close: (tok: string, incidentId: string, reason: string) => post(`/incidents/${enc(incidentId)}/close`, tok, { reason }),
  flag: (tok: string, callId: string, flag: string) => post(`/calls/${enc(callId)}/flag`, tok, { flag }),
  takeover: (tok: string, callId: string) => post(`/calls/${enc(callId)}/takeover`, tok),
  join: (tok: string, callId: string) => post(`/calls/${enc(callId)}/join`, tok, { dispatcher_id: "console" }),
  say: (tok: string, callId: string, text: string, lang_from: string) => post<{ lang_to: string; sent_text: string }>(`/calls/${enc(callId)}/say`, tok, { text, lang_from }),
  kit: (tok: string, callId: string, kit_id: string | null) => post(`/calls/${enc(callId)}/kit`, tok, { kit_id }),
  surge: () => fetch("/demo/surge", { method: "POST" }).then((r) => r.ok),
  units: () => getJSON<{ units: UnitRow[]; watchdog_s: Record<string, number>; dispositions: Record<string, string> }>("/units"),
  unitStatus: (tok: string, incidentId: string, n: number, status: string) => post(`/incidents/${enc(incidentId)}/units/${n}/status`, tok, { status }),
  addStop: (tok: string, incidentId: string, n: number, targetId: string) => post(`/incidents/${enc(incidentId)}/units/${n}/stop`, tok, { incident_id: targetId }),
  resetDemo: (tok: string) => post<{ cleared: Record<string, number> }>("/demo/reset", tok),
  relayDemo: () => fetch("/demo/relay", { method: "POST" }).then((r) => r.ok),
  history: () => getJSON<HistoryFile>("/history/rd"),
  disposition: (tok: string, incidentId: string, disposition: string, note = "") => post<{ callback_id: string | null }>(`/incidents/${enc(incidentId)}/disposition`, tok, { disposition, note }),
};

