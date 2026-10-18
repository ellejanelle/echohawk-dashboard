// LA map shared by the board and the replay: Leaflet (vendored, loaded as a global by the page) + Esri dark gray
// tiles (no key) + LAPD Reporting District polygons from the City of LA GIS. The browser fetches the polygons once,
// then posts them to the server so later loads and offline demos read data/rd_polygons.geojson.
import type * as Leaflet from "leaflet";

declare global { interface Window { L: typeof Leaflet } }

const ARCGIS = "https://maps.lacity.org/lahub/rest/services/LAPD/MapServer/4/query?where=1%3D1&outFields=REPDIST,PREC,APREC,BUREAU&outSR=4326&f=geojson&maxAllowableOffset=0.0002&geometryPrecision=5";

// Live-demo zones ("zone six") sit on 16 real West LA reporting districts so they land on the map.
export const DEMO_ZONES: Record<string, string> = { Z01: "0801", Z02: "0802", Z03: "0803", Z04: "0804", Z05: "0811", Z06: "0812", Z07: "0813", Z08: "0814", Z09: "0821", Z10: "0822", Z11: "0823", Z12: "0824", Z13: "0831", Z14: "0832", Z15: "0833", Z16: "0834" };
export const rdOf = (zone: string) => DEMO_ZONES[zone] || String(zone || "").padStart(4, "0");
export const RUNG_COLOR: Record<string, string> = { hand: "#e5484d", ask: "#f2b43c", watch: "#4c9cf0", machine: "#9b7bff", history: "#ff8a3d" };

type FC = { type: "FeatureCollection"; features: any[]; exceededTransferLimit?: boolean };

async function loadRD(say: (t: string) => void): Promise<FC> {
  try { const r = await fetch("/geo/rd"); if (r.ok) { const c = (await r.json()) as FC; if (!c.exceededTransferLimit) return c; } } catch { /* not cached yet */ }
  say("Loading LAPD reporting districts from the City of LA GIS (first time only)…");
  const all: FC = { type: "FeatureCollection", features: [] };
  for (let offset = 0; offset < 5000; offset += 1000) {
    const r = await fetch(`${ARCGIS}&orderByFields=OBJECTID&resultOffset=${offset}&resultRecordCount=1000`);
    if (!r.ok) throw new Error(`City GIS returned ${r.status}`);
    const page = await r.json();
    all.features.push(...(page.features || []));
    if (!page.exceededTransferLimit && !(page.properties && page.properties.exceededTransferLimit)) break;
  }
  fetch("/geo/rd", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(all) }).catch(() => {});
  return all;
}

export interface LAMap {
  map: Leaflet.Map;
  reset(): void;
  paint(rd: string, o: { rung?: string; intensity?: number; flagged?: boolean; label?: string }): boolean;
  focus(rds: string[]): void;
  dots(list: { rd: string; color: string; label?: string; size?: number; tag?: string }[]): void;
  areas(list: { lat: number; lon: number; radius_m: number; label: string }[]): void;
  destroy(): void;
}

export async function createLAMap(el: HTMLElement, say: (t: string) => void, center: [number, number] = [34.05, -118.4], zoom = 10): Promise<LAMap> {
  const L = window.L;
  if (!L) throw new Error("Leaflet not loaded");
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView(center, zoom);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors · Districts: City of LA GIS" }).addTo(map);
  map.createPane("labels");
  const lp = map.getPane("labels")!; lp.style.zIndex = "650"; lp.style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels" }).addTo(map);
  L.control.scale({ imperial: true, metric: false, position: "bottomleft" }).addTo(map);
  const dotLayer = L.layerGroup().addTo(map);
  const areaLayer = L.layerGroup().addTo(map);
  const byRD: Record<string, Leaflet.Path[]> = {};
  try {
    const gj = await loadRD(say);
    L.geoJSON(gj as any, {
      style: () => ({ color: "#3a4256", weight: 0.6, fillColor: "#4f9dff", fillOpacity: 0 }),
      onEachFeature: (f: any, l: any) => { const rd = String(f.properties.REPDIST).padStart(4, "0"); (byRD[rd] ||= []).push(l); l.bindTooltip(`RD ${rd} · ${f.properties.APREC || ""}`, { sticky: true }); },
    }).addTo(map);
    say(`${Object.keys(byRD).length} LAPD reporting districts`);
  } catch (e) { say(`District map unavailable (${(e as Error).message}); everything is still listed.`); }
  return {
    map,
    reset() { for (const ls of Object.values(byRD)) for (const l of ls) l.setStyle({ fillOpacity: 0, color: "#3a4256", weight: 0.6 }); },
    paint(rd, { rung = "watch", intensity = 0.35, flagged = false, label } = {}) {
      const ls = byRD[rd]; if (!ls) return false;
      const c = RUNG_COLOR[rung] || RUNG_COLOR.watch;
      for (const l of ls) { l.setStyle({ fillColor: c, fillOpacity: Math.min(0.75, intensity), color: flagged ? "#4f9dff" : c, weight: flagged ? 3 : 1.2 }); if (label) (l as any).setTooltipContent(label); }
      return true;
    },
    focus(rds) { const ls = rds.flatMap((rd) => byRD[rd] || []); if (ls.length) map.fitBounds(L.featureGroup(ls).getBounds(), { maxZoom: 14, padding: [20, 20] }); },
    dots(list) {
      dotLayer.clearLayers();
      for (const d of list) {
        const ls = byRD[d.rd]; if (!ls) continue;
        const c = L.featureGroup(ls).getBounds().getCenter();
        const m = L.circleMarker(c, { radius: d.size || 7, color: "#0b111a", weight: 2, fillColor: d.color, fillOpacity: 1, pane: "markerPane" });
        if (d.tag) m.bindTooltip(d.tag, { permanent: true, direction: "right", offset: [8, 0], className: "rdlabel" });
        else if (d.label) m.bindTooltip(d.label);
        m.addTo(dotLayer);
      }
    },
    areas(list) {
      areaLayer.clearLayers();
      for (const a of list) L.circle([a.lat, a.lon], { radius: a.radius_m, color: "#e5484d", weight: 2, dashArray: "6 4", fillColor: "#e5484d", fillOpacity: 0.12 }).bindTooltip(a.label, { sticky: true }).addTo(areaLayer);
    },
    destroy() { map.remove(); },
  };
}
