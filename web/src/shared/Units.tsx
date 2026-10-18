import type { Dispatched, UnitRow, UnitStatus } from "./types";
import { unitLabel } from "./labels";

export const STATUS_LABEL: Record<UnitStatus, string> = { assigned: "Assigned", en_route: "En route", on_scene: "On scene", cleared: "Cleared", cancelled: "Cancelled" };
const NEXT_LABEL: Partial<Record<UnitStatus, string>> = { en_route: "En route", on_scene: "On scene", cleared: "Clear", cancelled: "Cancel" };
const NEXT: Record<UnitStatus, UnitStatus[]> = { assigned: ["en_route", "cancelled"], en_route: ["on_scene", "cancelled"], on_scene: ["cleared"], cleared: [], cancelled: [] };
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

// One unit with its status, time in status, and the next status buttons (in production these come from CAD).
export function UnitPill({ d, n, limit, onSet }: { d: Dispatched; n: number; limit?: number; onSet: (n: number, s: UnitStatus) => void }) {
  const st = (d.status || "assigned") as UnitStatus;
  const secs = Math.round((Date.now() - new Date(d.status_at || d.at).getTime()) / 1000);
  const over = limit != null && secs > limit && st !== "cleared" && st !== "cancelled";
  return (
    <span className={`upill ${st} ${over ? "over" : ""}`} onClick={(e) => e.stopPropagation()}>
      <b>{unitLabel(d.unit)}</b><span className="ust">{STATUS_LABEL[st]}</span>
      {st !== "cleared" && st !== "cancelled" && <span className="utm" title={limit ? `watchdog ${mmss(limit)}` : ""}>{mmss(secs)}</span>}
      {NEXT[st].map((x) => <button key={x} onClick={() => onSet(n, x)}>{NEXT_LABEL[x]}</button>)}
    </span>
  );
}

export function rowsOverdue(rows: UnitRow[]) { return rows.filter((r) => r.overdue).length; }
