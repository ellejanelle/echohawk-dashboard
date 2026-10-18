import type { Item } from "./items";
import { tName, trig } from "../shared/labels";

export const FLAGS: [string, string][] = [["wrong_zone", "Wrong zone"], ["wrong_category", "Wrong category"], ["caller_distressed", "Caller distressed"], ["language_issue", "Language issue"], ["needs_interpreter", "Needs a human interpreter"]];

// Engine reasons are written for the audit log; say the same thing in plain words on the wall.
export function human(it: Item): string {
  const n = it.independent || 0, m = it.machine || 0, r = String(it.reason || "");
  if (it.triggers.length) return `Priority signal requiring human review: ${it.triggers.map(trig).join(", ")}.`;
  if (/^spread/.test(r)) return "Same problem now reported in the zone next door. It may be spreading.";
  if (!n && m) return `${m} alarm activation${m > 1 ? "s" : ""}, no people calling. Likely a power blip or wind, not ${m} separate emergencies.`;
  if (/high-consequence/.test(r)) return `${tName(it.target)} can get worse fast, so one report is enough to ask a person to check.`;
  if (it.rung === "hand") return `${n} different callers report the same thing here. That is enough to send help without waiting.`;
  if (it.rung === "ask") return `${n} caller${n > 1 ? "s" : ""} so far. Worth a quick look.`;
  return `${n || 1} report so far. The AI is watching for more before it asks you.`;
}

export function anyoneHurt(it: Item): string {
  if (it.intake_pending) return "Not confirmed";
  if (it.triggers.some((t) => ["breathing_qualified", "unconscious", "severe_bleeding", "insists_higher_severity"].includes(t)) || it.target === "person") return "Yes";
  if (it.kind === "call" && it.last.some((t) => /\b(no one|nobody|nadie)\b/i.test(t.text))) return "No";
  return "Not said";
}
