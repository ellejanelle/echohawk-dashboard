// Baselines, zone adjacency, and the synthetic 20-call script.
// Spec: docs/IMPLEMENTATION_PLAN.md Section 8.
// Run `npm run seed` to replay the script against a running server.
import { readFileSync, existsSync } from "node:fs";

// Demo zones: a 4×4 grid Z01..Z16 with 8-neighbour adjacency (synthetic; labeled on the board).
// LAPD reporting districts are also loaded when the baseline CSV is present; their adjacency is
// approximated by numeric neighbours in the same area — replace with the GeoHub polygon layer
// once downloaded.
export function loadAdjacency() {
  const adj = {};
  const id = (r, c) => `Z${String(r * 4 + c + 1).padStart(2, "0")}`;

  // Build 8-neighbour adjacency for the 4×4 demo grid
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      adj[id(r, c)] = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < 4 && cc >= 0 && cc < 4) adj[id(r, c)].push(id(rr, cc));
        }
      }
    }
  }

  // Optional LAPD reporting-district adjacency
  if (existsSync("data/rd_baseline_by_hour.csv")) {
    const rds = new Set(
      readFileSync("data/rd_baseline_by_hour.csv", "utf8")
        .split("\n")
        .slice(1)
        .map((l) => l.split(",")[1])
        .filter(Boolean)
    );
    for (const rd of rds) {
      const n = Number(rd);
      adj[rd] = [String(n - 1).padStart(4, "0"), String(n + 1).padStart(4, "0")].filter((x) => rds.has(x));
    }
  }
  return adj;
}

export function loadBaselines(store) {
  // Synthetic grid: quiet zones, 0.2 incidents per 15 minutes at every hour
  // (team judgment for the demo; agencies set their own baselines)
  for (let i = 1; i <= 16; i++) {
    for (let h = 0; h < 24; h++) {
      store.baselines.push({
        zone_id: `Z${String(i).padStart(2, "0")}`,
        hour: h,
        mean_per_15min: 0.2,
        source: "synthetic",
        computed_at: new Date().toISOString(),
      });
    }
  }

  if (existsSync("data/rd_baseline_by_hour.csv")) {
    const lines = readFileSync("data/rd_baseline_by_hour.csv", "utf8").trim().split("\n").slice(1);
    for (const l of lines) {
      const [area, rd, hour, total, mean_per_hour] = l.split(",");
      if (!rd) continue;
      store.baselines.push({
        zone_id: rd,
        hour: Number(hour),
        mean_per_15min: Number(mean_per_hour) / 4,
        source: "lapd_cfs",
        area,
        computed_at: new Date().toISOString(),
      });
    }
  }
  store.save();
}

// Twenty synthetic calls for the demo stage. "text" is what the caller said;
// the server extracts the fields from it at replay time.
export const SCRIPT = [
  { t: 0,  source: "voice",     identifier: "c1",      text: "This is zone Z06. Our water pressure dropped to almost nothing a few minutes ago. No emergency, just reporting.", language: "en" },
  { t: 6,  source: "voice",     identifier: "c2",      text: "Zona Z07, la presión de agua está muy baja desde hace un rato. No es emergencia.", language: "es" },
  { t: 9,  source: "voice",     identifier: "c3",      text: "Zone Z06 again, different house. Water pressure is gone and the street has a wet patch.", language: "en" },
  { t: 12, source: "voice",     identifier: "c4",      text: "Zone Z10, water pressure dropped here too.", language: "en" },
  { t: 3,  source: "voice",     identifier: "c5",      text: "Zone Z13, my power is out and it's completely dark and I need someone here NOW, this is an emergency!", language: "en" },
  { t: 14, source: "voice",     identifier: "c6",      text: "Zone Z02, my husband cut his leg and he's bleeding badly, there's blood everywhere.", language: "en" },
  { t: 15, source: "voice",     identifier: "c7",      text: "Zone Z09, my mother collapsed, she's sort of breathing, like gasping.", language: "en" },
  { t: 4,  source: "voice",     identifier: "c8",      text: "Zona Z04, se fue la luz en mi casa, nada más quería saber cuándo regresa.", language: "es" },
  { t: 8,  source: "voice",     identifier: "c9",      text: "Zona Z11, hay un cable caído en la calle y chispas.", language: "es" },
  { t: 2,  source: "voice",     identifier: "c10",     text: "", language: "und", hangup: true },
  { t: 7,  source: "voice",     identifier: "c11",     text: "???", language: "und", unintelligible: true },
  { t: 1,  source: "telemetry", identifier: "alarm-a", zone_id: "Z03", target: "structure_fire", severity: 2, text: "alarm activation" },
  { t: 2,  source: "telemetry", identifier: "alarm-b", zone_id: "Z03", target: "structure_fire", severity: 2, text: "alarm activation" },
  { t: 3,  source: "telemetry", identifier: "alarm-c", zone_id: "Z03", target: "structure_fire", severity: 2, text: "alarm activation" },
  { t: 4,  source: "telemetry", identifier: "alarm-d", zone_id: "Z03", target: "structure_fire", severity: 2, text: "alarm activation" },
  { t: 5,  source: "telemetry", identifier: "alarm-e", zone_id: "Z03", target: "structure_fire", severity: 2, text: "alarm activation" },
  { t: 0,  source: "voice",     identifier: "c12",     text: "Zone Z15, noise complaint, party next door.", language: "en" },
  { t: 5,  source: "voice",     identifier: "c13",     text: "Zone Z16, a tree is down across the road, no one hurt.", language: "en" },
  { t: 10, source: "voice",     identifier: "c14",     text: "Zone Z01, streetlight out on my corner.", language: "en" },
  { t: 11, source: "voice",     identifier: "c15",     text: "Zone Z08, when is trash pickup this week?", language: "en" },
];

export async function replayScript(baseUrl = "http://localhost:8787") {
  const { extractRules } = await import("./llm.js");
  for (const call of [...SCRIPT].sort((a, b) => a.t - b.t)) {
    let body;
    if (call.source === "telemetry") {
      body = { ...call };
    } else {
      const f = extractRules(call.text);
      body = {
        source: "voice",
        identifier: call.identifier,
        zone_id: f.zone_id || "unknown",
        target: f.target,
        severity: f.severity,
        action: f.action,
        language: call.language,
        text: call.text,
        content_status: f.complete ? "extracted" : "none",
        provenance: "simulated",
      };
    }
    const r = await fetch(`${baseUrl}/packets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(call.identifier, r.status, await r.text());
  }
}

if (process.argv[1] && process.argv[1].endsWith("seed.js")) {
  replayScript(process.argv[2]).catch((e) => { console.error(e); process.exit(1); });
}
