// Plain-language labels shared by every screen. The engine's words are for the audit log; these are for people.
import type { Incident, Rung, Unit } from "./types";

export const TARGET: Record<string, [string, string]> = {
  power: ["⚡", "Power outage"], water: ["💧", "Water pressure loss"], gas: ["🔥", "Gas smell or leak"], power_line: ["⚠️", "Downed power line"],
  structure_fire: ["🔥", "Fire"], wildfire: ["🔥", "Wildfire"], road: ["🚧", "Road hazard"], flood: ["🌊", "Flooding"],
  person: ["🚑", "Injured or sick person"], vehicle: ["🚗", "Traffic collision"], alarm: ["🔔", "Alarm activation"], crime: ["🚓", "Crime report"],
  noise: ["🔊", "Noise complaint"], info: ["ℹ️", "Information request"], unknown: ["❔", "Not clear yet"],
};
export const tIcon = (t?: string) => (TARGET[t || "unknown"] || TARGET.unknown)[0];
export const tName = (t?: string) => (TARGET[t || "unknown"] || [null, String(t || "unknown").replace(/_/g, " ")])[1] as string;

export const TRIG: Record<string, string> = {
  asks_for_human: "asked for a person", sos_beacon: "emergency help requested", breathing_qualified: "trouble breathing", dependent_alone: "child or dependent alone", distress: "caller in distress",
  electrical: "live electrical hazard", gas_or_pressure: "gas or pressure hazard", insists_higher_severity: "says it is worse", self_harm: "self harm risk",
  severe_bleeding: "severe bleeding", third_party_vulnerable: "vulnerable person", trapped: "someone trapped", unconscious: "unconscious", violence: "violence",
};
export const trig = (t: string) => TRIG[t] || t.replace(/_/g, " ");
export const plainReason = (r?: string) =>
  String(r || "").replace(/hard trigger: ([a-z_, ]+)/, (_, x: string) => "priority signal: " + x.split(/,\s*/).map(trig).join(", ")).replace(/independent sources/g, "independent sources");

export const RUNG_LABEL: Record<Rung, string> = { hand: "Needs a person", ask: "Check now", watch: "Watching" };

export const UNITS: { id: Unit; label: string; icon: string; key: string }[] = [
  { id: "ems", label: "EMS", icon: "✚", key: "E" },
  { id: "fire", label: "Fire", icon: "🔥", key: "F" },
  { id: "police", label: "Police", icon: "⛨", key: "P" },
  { id: "utility", label: "Utility", icon: "⚡", key: "U" },
  { id: "callback", label: "Callback", icon: "↩", key: "C" },
];
export const unitLabel = (u: string) => UNITS.find((x) => x.id === u)?.label || u;

// Which service fits: the AI's extracted action first, the line's category second.
export function suggest(action?: string, target?: string): Unit[] {
  const byAction: Record<string, Unit[]> = { dispatch_ems: ["ems"], dispatch_fire: ["fire"], dispatch_police: ["police"], welfare_check: ["police"], info_only: ["callback"], deflect_311: ["callback"] };
  if (action && byAction[action]) return byAction[action];
  const byTarget: Record<string, Unit[]> = { person: ["ems"], structure_fire: ["fire", "ems"], wildfire: ["fire"], gas: ["fire", "utility"], power_line: ["utility", "fire"], power: ["utility"], water: ["utility"], flood: ["fire", "utility"], road: ["police"], vehicle: ["police", "ems"], crime: ["police"], alarm: ["police"] };
  return byTarget[target || ""] || ["callback"];
}

export const isMachineOnly = (i: Incident) => !i.independent_count && (i.machine_count || 0) > 0;

export const ZONES = Array.from({ length: 16 }, (_, i) => `Z${String(i + 1).padStart(2, "0")}`);

export const SOURCE: Record<string, string> = { voice: 'Phone call', app: 'App request', ehawk: 'Device request', field_unit: 'Field report', telemetry: 'Alarm or sensor' };
export const sourcesLabel = (counts?: Record<string, number>) => Object.entries(counts || {}).filter(([, n]) => n > 0).map(([source, n]) => `${n} ${SOURCE[source]?.toLowerCase() || source}${n > 1 ? 's' : ''}`).join(' · ');
export const requestTitle = (request: { intake_pending?: boolean; target?: string }) => request.intake_pending ? 'Emergency help requested' : tName(request.target);
