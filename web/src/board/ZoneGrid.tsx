import { useLayoutEffect, useRef, useState } from "react";
import type { Incident } from "../shared/types";
import { ZONES, isMachineOnly, tIcon, tName, RUNG_LABEL } from "../shared/labels";

// The hero: 16 demo zones that light up as calls land. Color = highest rung, hatched violet = alarms only,
// pulsing blue outline = unusual volume vs baseline, amber animated link = same problem spreading next door.
export function ZoneGrid({ incidents, byId, flagged, counts, pings, alerted, selected }: {
  incidents: Incident[]; byId: Record<string, Incident>; flagged: Set<string>; counts: Record<string, number>;
  pings: Record<string, number>; alerted: Set<string>; selected: Set<string>;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const tiles = useRef<Record<string, HTMLDivElement | null>>({});
  const [links, setLinks] = useState<{ sx: number; sy: number; ex: number; ey: number }[]>([]);

  const edges = new Map<string, string>();
  for (const i of incidents) {
    const o = i.spread_linked_incident_id ? byId[i.spread_linked_incident_id] : undefined;
    if (!o || o.zone_id === i.zone_id) continue;
    edges.set([i.zone_id, o.zone_id].sort().join("|"), i.target);
  }
  const edgeKey = [...edges.keys()].join(",");

  useLayoutEffect(() => {
    const draw = () => {
      const w = wrap.current?.getBoundingClientRect(); if (!w) return;
      const out: typeof links = [];
      for (const k of edgeKey ? edgeKey.split(",") : []) {
        const [a, b] = k.split("|"); const ta = tiles.current[a], tb = tiles.current[b]; if (!ta || !tb) continue;
        const ra = ta.getBoundingClientRect(), rb = tb.getBoundingClientRect();
        const x1 = ra.left + ra.width / 2 - w.left, y1 = ra.top + ra.height / 2 - w.top, x2 = rb.left + rb.width / 2 - w.left, y2 = rb.top + rb.height / 2 - w.top;
        const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
        const clip = (r: DOMRect, cx: number, cy: number, vx: number, vy: number) => { const t = Math.min(vx ? r.width / 2 / Math.abs(vx) : Infinity, vy ? r.height / 2 / Math.abs(vy) : Infinity); return [cx + vx * t, cy + vy * t]; };
        const [ax, ay] = clip(ra, x1, y1, ux, uy), [bx, by] = clip(rb, x2, y2, -ux, -uy);
        out.push({ sx: ax - ux * 34, sy: ay - uy * 34, ex: bx + ux * 34, ey: by + uy * 34 });
      }
      setLinks(out);
    };
    draw();
    addEventListener("resize", draw);
    return () => removeEventListener("resize", draw);
  }, [edgeKey]);

  return (
    <div className="gridwrap" ref={wrap}>
      <div className="grid">
        {ZONES.map((z) => {
          const list = incidents.filter((i) => i.zone_id === z);
          const top = list[0];
          const n = counts[z] || list.reduce((a, i) => a + i.packet_ids.length, 0);
          const mo = list.length > 0 && list.every(isMachineOnly);
          const spreading = list.some((i) => i.spread_linked_incident_id && byId[i.spread_linked_incident_id]);
          const cls = ["tile", top ? (mo ? "machine" : `r-${top.rung}`) : "", flagged.has(z) ? "flag" : "", n ? "busy" : "", alerted.has(z) ? "alerted" : "", spreading ? "spreading" : "", selected.has(z) ? "sel" : ""].join(" ");
          return (
            <div key={z} className={cls} ref={(el) => { tiles.current[z] = el; }}>
              {pings[z] ? <div key={pings[z]} className="pingfx" /> : null}
              <div className="tz">{z}{alerted.has(z) && <span className="bang">!</span>}</div>
              {n > 0 && <div className="tb">{n}</div>}
              {flagged.has(z) && <div className="tflag">UNUSUAL VOLUME</div>}
              {spreading && <div className="tspread">SPREADING</div>}
              <div className="body">
                {!top ? (n ? <div className="ts">{n} call{n === 1 ? "" : "s"} · no details yet</div> : <div className="quiet">quiet</div>) : (
                  <>
                    <div className="ti">{tIcon(top.target)}</div>
                    <div className="tl">{mo ? "Alarms only" : tName(top.target)}{list.length > 1 && <span className="muted small"> +{list.length - 1} more</span>}</div>
                    <div className="ts">{mo ? `${top.machine_count} alarm activation${(top.machine_count || 0) > 1 ? "s" : ""} · machines, not people` : `${top.independent_count} caller${top.independent_count === 1 ? "" : "s"}${top.machine_count ? ` + ${top.machine_count} alarm` : ""} · ${RUNG_LABEL[top.rung].toLowerCase()}`}</div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <svg className="links">
        {links.map((l, i) => (
          <g key={i}>
            <line x1={l.sx} y1={l.sy} x2={l.ex} y2={l.ey} />
            <circle cx={l.sx} cy={l.sy} r="7" fill="#ffb020" />
            <circle cx={l.ex} cy={l.ey} r="7" fill="#ffb020" />
          </g>
        ))}
      </svg>
    </div>
  );
}
