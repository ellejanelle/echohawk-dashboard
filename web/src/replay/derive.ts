// Everything the story says is derived here from the replay output. No number on the page is typed in by hand.
import type { Frame, ReplayData, ReplayIncident } from "../shared/types";

export const secs = (t: string) => { const [h, m, s] = t.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
export const hhmm = (x: number) => `${String(Math.floor(x / 3600) % 24).padStart(2, "0")}:${String(Math.floor(x / 60) % 60).padStart(2, "0")}`;
export const span = (a: string, b: string) => { const d = Math.round(secs(b) - secs(a)); return d < 120 ? `${d} seconds` : d < 7200 ? `${Math.round(d / 60)} minutes` : `${(d / 3600).toFixed(1)} hours`; };
export const ordinal = (k: number) => (k === 1 ? "first" : k === 2 ? "second" : k === 3 ? "third" : `${k}th`);

export type Cat = "flag" | "group" | "machine" | "single" | "crime";

export interface Story {
  F: Frame[]; I: ReplayIncident[];
  items: number; crimes: Frame[]; machine: Frame[]; machineLines: number;
  grouped: ReplayIncident[]; groupedCalls: number; flagRDs: Set<string>; needPerson: number;
  isItem: (f: Frame) => boolean; cat: (f: Frame) => Cat;
  burst: null | { inc: ReplayIncident; near: Frame[]; range: Frame[]; k: number; lastT: string };
  wave: null | { area: string; n: number; rds: [string, number][]; lines: number };
  pair: null | { inc: ReplayIncident; fs: Frame[]; between: number };
  crimeTypes: [string, number][];
}

export function derive(d: ReplayData): Story {
  const F = d.frames, I = d.incidents;
  const incOf: Record<string, ReplayIncident> = Object.fromEntries(I.map((i) => [i.id, i]));
  const firstOf: Record<string, number> = {};
  for (const f of F) if (f.incident && !(f.incident in firstOf)) firstOf[f.incident] = f.n;
  const isItem = (f: Frame) => !!f.passthrough || !f.incident || firstOf[f.incident] === f.n;
  const cat = (f: Frame): Cat => {
    if (f.passthrough) return "crime";
    const i = f.incident ? incOf[f.incident] : undefined;
    if (!i) return "single"; if (i.flag) return "flag"; if (i.machine) return "machine";
    return i.size > 1 ? "group" : "single";
  };
  const crimes = F.filter((f) => f.passthrough);
  const machine = F.filter((f) => f.machine);
  const grouped = I.filter((i) => i.size > 1);
  const flagged = I.filter((i) => i.flag);

  // the flagged line with the biggest burst around its flag
  let burst: Story["burst"] = null;
  for (const i of flagged) {
    const ft = secs(i.flag!.t);
    const near = F.filter((f) => f.incident === i.id && Math.abs(secs(f.t) - ft) <= 600);
    if (near.length && (!burst || near.length > burst.near.length)) burst = { inc: i, near, range: [], k: 0, lastT: "" };
  }
  if (burst) {
    const lo = Math.max(1, burst.near[0].n - 8), hi = Math.min(F.length, burst.near.at(-1)!.n + 2);
    burst.range = F.slice(lo - 1, hi);
    burst.k = burst.near.findIndex((f) => f.n === burst!.inc.flag!.ticket) + 1;
    burst.lastT = burst.near.at(-1)!.t;
  }

  // the area with the most machine activations
  const byArea: Record<string, Frame[]> = {};
  for (const f of machine) (byArea[f.area] ||= []).push(f);
  const topArea = Object.entries(byArea).sort((a, b) => b[1].length - a[1].length)[0];
  let wave: Story["wave"] = null;
  if (topArea) {
    const rds: Record<string, number> = {};
    for (const f of topArea[1]) rds[f.rd] = (rds[f.rd] || 0) + 1;
    wave = { area: topArea[0], n: topArea[1].length, rds: Object.entries(rds).sort((a, b) => b[1] - a[1]), lines: new Set(topArea[1].map((f) => f.incident)).size };
  }

  // people calling about the same thing, closest together in time
  const people = I.filter((i) => i.independent >= 2 && i.machine === 0 && i.target !== "crime").map((i) => ({ i, s: secs(i.last) - secs(i.opened) })).sort((a, b) => a.s - b.s)[0];
  let pair: Story["pair"] = null;
  if (people) { const fs = F.filter((f) => f.incident === people.i.id); pair = { inc: people.i, fs, between: fs.at(-1)!.n - fs[0].n - 1 }; }

  const ct: Record<string, number> = {};
  for (const f of crimes) ct[f.type] = (ct[f.type] || 0) + 1;

  return {
    F, I, items: F.filter(isItem).length, crimes, machine, machineLines: new Set(machine.map((f) => f.incident)).size,
    grouped, groupedCalls: grouped.reduce((a, i) => a + i.size, 0), flagRDs: new Set(d.flags.map((f) => f.zone_id)),
    needPerson: I.filter((i) => !i.machine && (i.rung === "hand" || i.rung === "ask")).length,
    isItem, cat, burst, wave, pair, crimeTypes: Object.entries(ct).sort((a, b) => b[1] - a[1]),
  };
}
