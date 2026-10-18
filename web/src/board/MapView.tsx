import { useEffect, useRef, useState } from "react";
import type { Incident, HistoryFile } from "../shared/types";
import { createLAMap, rdOf, RUNG_COLOR, type LAMap } from "../shared/laMap";
import { RUNG_LABEL, isMachineOnly, tName } from "../shared/labels";

// Real LAPD reporting districts with a dot per open line. The selected line's district fills amber, like the concept.
export const HIST_LABEL: Record<string, string> = { total: "all calls", violence: "violence", domestic: "domestic violence", robbery: "robbery", burglary: "burglary", medical: "medical" };

export function MapView({ incidents, flagged, counts, selected, onStatus, history, histCat }: {
  incidents: Incident[]; flagged: Set<string>; counts: Record<string, number>; selected: Incident | null; onStatus: (t: string) => void;
  history?: HistoryFile | null; histCat?: string | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [m, setM] = useState<LAMap | null>(null);
  const [err, setErr] = useState("");
  const focusKey = useRef("");
  useEffect(() => {
    if (!el.current) return;
    let alive = true, made: LAMap | null = null;
    createLAMap(el.current, onStatus).then((x) => { made = x; if (alive) setM(x); else x.destroy(); }).catch((e: unknown) => setErr(String((e instanceof Error ? e.message : e) || "Map failed to load")));
    return () => { alive = false; made?.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!m) return;
    m.reset();
    // history layer underneath: dispatched LAPD calls of one type per district over the baseline days
    if (history && histCat) {
      const vals = Object.values(history.rd).map((v) => v[histCat] || 0);
      const max = Math.max(1, ...vals);
      for (const [rd, v] of Object.entries(history.rd)) {
        const n = v[histCat] || 0; if (!n) continue;
        m.paint(rd, { rung: "history", intensity: 0.06 + 0.6 * Math.pow(n / max, 0.6), label: `District ${rd} · ${n} ${HIST_LABEL[histCat]} calls in ${history.days} days (about ${(n / history.days).toFixed(1)} a day)` });
      }
    }
    const top: Record<string, Incident> = {};
    for (const i of incidents) if (!top[i.zone_id]) top[i.zone_id] = i;
    const rds: string[] = [];
    for (const z of new Set([...Object.keys(top), ...flagged])) {
      const i = top[z], rd = rdOf(z), n = counts[z] || 0;
      const rung = i ? (isMachineOnly(i) ? "machine" : i.rung) : "watch";
      if (m.paint(rd, { rung, flagged: flagged.has(z), intensity: 0.16 + Math.min(0.3, n * 0.05), label: `District ${rd} · ${i ? tName(i.target) + " · " + RUNG_LABEL[i.rung].toLowerCase() : "watching"} · ${n} report(s) last hour${flagged.has(z) ? " · unusual volume" : ""}` })) rds.push(rd);
    }
    if (selected) m.paint(rdOf(selected.zone_id), { rung: "ask", intensity: 0.62, flagged: false, label: `District ${rdOf(selected.zone_id)} · ${tName(selected.target)}` });
    m.dots(incidents.map((i) => ({ rd: rdOf(i.zone_id), color: RUNG_COLOR[isMachineOnly(i) ? "machine" : i.rung], label: `${tName(i.target)} · ${i.independent_count} source(s)`, tag: selected?.id === i.id || i.rung === "hand" ? rdOf(i.zone_id) : undefined, size: i.rung === "hand" ? 8 : 6 })));
    m.areas(incidents.filter((i) => i.approx_area).map((i) => ({ lat: i.approx_area!.lat, lon: i.approx_area!.lon, radius_m: i.approx_area!.radius_m, label: `Heard by ${i.heard_by?.length || 0} node(s): ${i.heard_by?.join(", ")} · about ${i.approx_area!.radius_m} m across · simulated nodes` })));
    const key = rds.slice().sort().join();
    if (key !== focusKey.current && rds.length) { m.focus(rds); focusKey.current = key; }
  }, [m, incidents, flagged, counts, selected, history, histCat]);
  if (err) return <div className="empty">Map unavailable ({err}). The zone view has everything.</div>;
  return <div ref={el} className="lamap" />;
}
