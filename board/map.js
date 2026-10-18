// Shared map for the supervisor board and the replay: Leaflet + CARTO dark tiles + LAPD reporting district polygons.
// Polygons come from the City of LA GIS service (LAPD MapServer layer 4, "LAPD Reporting Districts"). The browser fetches
// them once, then posts them to the server so later loads (and offline demos) read the local copy in data/.
window.EH_MAP = (() => {
  const ARCGIS = "https://maps.lacity.org/lahub/rest/services/LAPD/MapServer/4/query?where=1%3D1&outFields=REPDIST,PREC,APREC,BUREAU&outSR=4326&f=geojson&maxAllowableOffset=0.0002&geometryPrecision=5";
  // Live-demo zones (callers say "zone six") are placed on 16 real West LA reporting districts so they land on the map.
  const DEMO_ZONES = { Z01: "0801", Z02: "0802", Z03: "0803", Z04: "0804", Z05: "0811", Z06: "0812", Z07: "0813", Z08: "0814", Z09: "0821", Z10: "0822", Z11: "0823", Z12: "0824", Z13: "0831", Z14: "0832", Z15: "0833", Z16: "0834" };
  const rdOf = (zone) => DEMO_ZONES[zone] || String(zone || "").padStart(4, "0");
  const RUNG_COLOR = { hand: "#ff5d5d", ask: "#ffb020", watch: "#5aa0ff" };

  async function loadRD(status) {
    const say = (t) => status && (status.textContent = t);
    try { const r = await fetch("/geo/rd"); if (r.ok) { const c = await r.json(); if (!c.exceededTransferLimit) return c; } } catch {}
    say("Loading LAPD reporting districts from the City of LA GIS (first time only)…");
    // the service returns at most 1000 features per request; page with resultOffset until it says there is no more
    const all = { type: "FeatureCollection", features: [] };
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

  async function create(el, { status, center = [34.05, -118.4], zoom = 10 } = {}) {
    const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(center, zoom);
    // Esri dark gray canvas: no API key required. Labels come as a separate reference layer drawn above the polygons.
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors · Districts: City of LA GIS" }).addTo(map);
    map.createPane("labels"); map.getPane("labels").style.zIndex = 650; map.getPane("labels").style.pointerEvents = "none";
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels" }).addTo(map);
    const byRD = {};
    let layer = null;
    try {
      const gj = await loadRD(status);
      layer = L.geoJSON(gj, {
        style: () => ({ color: "#3a4256", weight: 0.6, fillColor: "#5aa0ff", fillOpacity: 0 }),
        onEachFeature: (f, l) => { const rd = String(f.properties.REPDIST).padStart(4, "0"); (byRD[rd] ||= []).push(l); l.bindTooltip(`RD ${rd} · ${f.properties.APREC || ""}`, { sticky: true }); },
      }).addTo(map);
      status && (status.textContent = `${Object.keys(byRD).length} LAPD reporting districts`);
    } catch (e) { status && (status.textContent = `District map unavailable (${e.message}); incidents still listed.`); }

    return {
      map, byRD, rdOf,
      reset() { for (const ls of Object.values(byRD)) for (const l of ls) l.setStyle({ fillOpacity: 0, color: "#3a4256", weight: 0.6 }); },
      paint(rd, { rung, intensity = 0.35, flagged = false, label } = {}) {
        const ls = byRD[rd]; if (!ls) return false;
        for (const l of ls) {
          l.setStyle({ fillColor: RUNG_COLOR[rung] || "#5aa0ff", fillOpacity: Math.min(0.75, intensity), color: flagged ? "#5aa0ff" : (RUNG_COLOR[rung] || "#3a4256"), weight: flagged ? 3 : 1.2 });
          if (label) l.setTooltipContent(label);
        }
        return true;
      },
      focus(rds) { const ls = rds.flatMap((rd) => byRD[rd] || []); if (ls.length) map.fitBounds(L.featureGroup(ls).getBounds(), { maxZoom: 14, padding: [20, 20] }); },
    };
  }
  return { create, rdOf, DEMO_ZONES, RUNG_COLOR };
})();
