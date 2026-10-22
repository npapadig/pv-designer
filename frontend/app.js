// PV Designer frontend: map drawing, panel layout, energy and financial results.

const PANEL_PRESETS = [
  // Electrical values (voc, isc, vmp, imp) are typical of current half-cell mono modules.
  { name: "Γενικό 410 W (1722 × 1134 mm)", power: 410, width: 1.134, length: 1.722, voc: 37.3, isc: 13.9, vmp: 31.0, imp: 13.23 },
  { name: "Γενικό 450 W (1903 × 1134 mm)", power: 450, width: 1.134, length: 1.903, voc: 41.3, isc: 13.9, vmp: 34.4, imp: 13.09 },
  { name: "Γενικό 500 W (1961 × 1134 mm)", power: 500, width: 1.134, length: 1.961, voc: 45.0, isc: 14.0, vmp: 37.6, imp: 13.3 },
  { name: "Γενικό 550 W (2278 × 1134 mm)", power: 550, width: 1.134, length: 2.278, voc: 49.9, isc: 14.0, vmp: 41.9, imp: 13.13 },
  { name: "Γενικό 600 W (2384 × 1134 mm)", power: 600, width: 1.134, length: 2.384, voc: 53.1, isc: 14.3, vmp: 44.6, imp: 13.45 },
  { name: "Δικό μου (συμπληρώνω τα στοιχεία)", power: null },
];
const MONTHS = ["Ιαν", "Φεβ", "Μαρ", "Απρ", "Μάι", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ"];

const $ = (id) => document.getElementById(id);
const state = { projectId: null, layout: null, energy: null, shading: null, finance: null };
let chart = null;
let financeChart = null;

// ---------- Map ----------
const MAX_ZOOM = 23;
const map = L.map("map", { maxZoom: MAX_ZOOM }).setView([37.9838, 23.7275], 17);

// Esri imagery is sharper in some places than others (zoom 17 in rural areas, up to
// 21+ in cities). Above the best available level Esri serves "Map data not yet
// available" tiles, so each Esri layer stretches its sharpest real tiles instead.
function esriLayer(url, label) {
  const layer = L.tileLayer(url, { maxNativeZoom: 19, maxZoom: MAX_ZOOM, attribution: `${label} © Esri, Maxar` });
  layer.tilemapUrl = url.replace("/tile/{z}/{y}/{x}", "/tilemap");
  return layer;
}
const satellite = esriLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", "Imagery"
).addTo(map);
const clarity = esriLayer(
  "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", "Clarity"
);
const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxNativeZoom: 19, maxZoom: MAX_ZOOM, attribution: "© OpenStreetMap",
});
// Hellenic Cadastre aerial orthophotos (free WMS, Greece only, imagery from about
// 2007-2009). Requested in EPSG:4326, which the service has long supported.
const ktimatologio = L.tileLayer.wms("http://gis.ktimanet.gr/wms/wmsopen/wmsserver.aspx", {
  layers: "KTBASEMAP", format: "image/jpeg", version: "1.1.1", crs: L.CRS.EPSG4326,
  maxNativeZoom: 20, maxZoom: MAX_ZOOM, attribution: "Ορθοφωτογραφίες © Ελληνικό Κτηματολόγιο",
});
const layersControl = L.control.layers({
  "Δορυφόρος (Esri)": satellite,
  "Δορυφόρος (Esri Clarity, συχνά πιο καθαρός)": clarity,
  "Ορθοφωτογραφίες Κτηματολογίου (Ελλάδα, 2007-09)": ktimatologio,
  "Χάρτης δρόμων": streets,
}).addTo(map);

// Ask Esri's tilemap which zoom levels have real imagery at the map centre.
const nativeZoomCache = new Map();
async function bestNativeZoom(layer) {
  const c = map.getCenter();
  const key = `${layer.tilemapUrl}|${c.lat.toFixed(3)}|${c.lng.toFixed(3)}`;
  if (!nativeZoomCache.has(key)) nativeZoomCache.set(key, await queryNativeZoom(layer, c));
  return nativeZoomCache.get(key);
}

async function queryNativeZoom(layer, c) {
  for (let z = 22; z >= 16; z--) {
    const n = 2 ** z;
    const x = Math.floor(((c.lng + 180) / 360) * n);
    const latR = (c.lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
    try {
      const r = await fetch(`${layer.tilemapUrl}/${z}/${y}/${x}/1/1?f=json`);
      const d = await r.json();
      if (d.data && d.data[0] === 1) return z;
    } catch {
      return null; // tilemap not reachable: keep the current setting
    }
  }
  return null;
}

let tilemapTimer = null;
function refreshNativeZoom() {
  clearTimeout(tilemapTimer);
  tilemapTimer = setTimeout(async () => {
    for (const layer of [satellite, clarity]) {
      if (!map.hasLayer(layer)) continue;
      const z = await bestNativeZoom(layer);
      if (z && z !== layer.options.maxNativeZoom) {
        layer.options.maxNativeZoom = z;
        layer.redraw();
      }
    }
  }, 400);
}
map.on("moveend baselayerchange", refreshNativeZoom);
refreshNativeZoom();
L.control.scale({ imperial: false }).addTo(map);

const areas = new L.FeatureGroup().addTo(map);
const keepouts = new L.FeatureGroup().addTo(map);
const panelsLayer = new L.FeatureGroup().addTo(map);
const shadowsLayer = new L.FeatureGroup().addTo(map);
const AREA_STYLE = { color: "#f59e0b", weight: 2, fillOpacity: 0.08 };
const KEEPOUT_STYLE = { color: "#ef4444", weight: 2, fillOpacity: 0.3 };

L.drawLocal.draw.toolbar.buttons.polygon = "Σχεδίαση πολυγώνου";
L.drawLocal.draw.toolbar.buttons.rectangle = "Σχεδίαση ορθογωνίου";
L.drawLocal.draw.handlers.polygon.tooltip = {
  start: "Κάνε κλικ για να ξεκινήσεις.",
  cont: "Κάνε κλικ για το επόμενο σημείο.",
  end: "Κάνε κλικ στο πρώτο σημείο για να κλείσει.",
};

const editGroup = new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  draw: {
    polygon: { allowIntersection: false, showArea: true, shapeOptions: AREA_STYLE },
    rectangle: { shapeOptions: AREA_STYLE },
    polyline: false, circle: false, marker: false, circlemarker: false,
  },
  edit: { featureGroup: editGroup },
}));

function drawMode() {
  return document.querySelector("input[name=drawMode]:checked").value;
}

function addShape(layer, kind, height) {
  layer.setStyle(kind === "keepout" ? KEEPOUT_STYLE : AREA_STYLE);
  layer.pvKind = kind;
  if (kind === "keepout") setObstacleHeight(layer, height ?? +$("obstacleHeight").value);
  (kind === "keepout" ? keepouts : areas).addLayer(layer);
  editGroup.addLayer(layer);
  updateShapesInfo();
}

// Obstacles carry a height (m above the panel surface) used by the shading analysis.
function setObstacleHeight(layer, h) {
  layer.pvHeight = Math.max(0, +h || 0);
  layer.bindTooltip(layer.pvHeight ? `Εμπόδιο ${fmt(layer.pvHeight, 1)} m` : "Εμπόδιο (χωρίς σκιά)");
  layer.off("click").on("click", () => {
    const box = L.DomUtil.create("div");
    box.innerHTML = `<label>Ύψος εμποδίου (m) <input type="number" min="0" step="0.5" value="${layer.pvHeight}"></label>`;
    const input = box.querySelector("input");
    input.onchange = () => { setObstacleHeight(layer, input.value); clearShading(); };
    L.popup().setLatLng(layer.getBounds().getCenter()).setContent(box).openOn(map);
    setTimeout(() => input.focus(), 50);
  });
}

map.on(L.Draw.Event.CREATED, (e) => {
  addShape(e.layer, drawMode());
  clearLayout();
});
map.on(L.Draw.Event.EDITED, clearLayout);
map.on(L.Draw.Event.DELETED, (e) => {
  e.layers.eachLayer((l) => { areas.removeLayer(l); keepouts.removeLayer(l); });
  updateShapesInfo();
  clearLayout();
});

function latlngsOf(layer) {
  return layer.getLatLngs()[0].map((p) => [p.lat, p.lng]);
}

function updateShapesInfo() {
  const a = areas.getLayers().length, k = keepouts.getLayers().length;
  $("shapesInfo").textContent = a === 0 ? "Καμία περιοχή." : `${a} περιοχή(ές), ${k} εμπόδιο(α).`;
}

// ---------- Search ----------
async function search() {
  const q = $("searchBox").value.trim();
  if (!q) return;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const res = await r.json();
    if (!res.length) return toast("Δεν βρέθηκε η διεύθυνση.");
    if (!$("projectAddress").value) $("projectAddress").value = q;
    map.setView([+res[0].lat, +res[0].lon], 19);
  } catch {
    toast("Η αναζήτηση απέτυχε. Έλεγξε τη σύνδεση στο internet.");
  }
}
$("btnSearch").onclick = search;
$("searchBox").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });

// ---------- Panel presets ----------
PANEL_PRESETS.forEach((p, i) => $("panelPreset").add(new Option(p.name, i)));
function applyPreset() {
  const p = PANEL_PRESETS[$("panelPreset").value];
  if (p.power) {
    $("panelPower").value = p.power;
    $("panelWidth").value = p.width;
    $("panelLength").value = p.length;
  }
}
$("panelPreset").onchange = applyPreset;
applyPreset();

$("mounting").onchange = () => {
  // Pitched roofs are usually 20–35°; racks on flat roofs are usually lower.
  if ($("mounting").value === "rack" && +$("tilt").value > 20) $("tilt").value = 15;
};

// Azimuth facing away from the longest edge of the first area, on the side closest to south.
$("btnAutoAz").onclick = (e) => {
  e.preventDefault();
  const layer = areas.getLayers()[0];
  if (!layer) return toast("Σχεδίασε πρώτα μια περιοχή.");
  const az = longEdgeAzimuth(layer);
  $("azimuth").value = az;
  toast(`Αζιμούθιο: ${az}°`);
};
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function longEdgeAzimuth(layer) {
  const pts = layer.getLatLngs()[0];
  let best = null, bestLen = -1;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = map.distance(a, b);
    if (len > bestLen) { bestLen = len; best = [a, b]; }
  }
  const [a, b] = best;
  const dy = b.lat - a.lat, dx = (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180);
  const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  const options = [(bearing + 90) % 360, (bearing + 270) % 360];
  const az = options.reduce((x, y) => (angDiff(x, 180) <= angDiff(y, 180) ? x : y));
  return Math.round(az) % 360;
}

// ---------- API helpers ----------
async function api(path, method = "GET", body) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = typeof data.detail === "string" ? data.detail : "Κάτι πήγε στραβά.";
    throw new Error(msg);
  }
  return data;
}

function toast(msg, ms = 3500) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

async function withBusy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, 6000); } finally { btn.disabled = false; }
}

function settings() {
  const rowGap = $("rowGap").value;
  return {
    panel_width_m: +$("panelWidth").value,
    panel_length_m: +$("panelLength").value,
    panel_power_w: +$("panelPower").value,
    orientation: $("orientation").value,
    azimuth_deg: +$("azimuth").value,
    tilt_deg: +$("tilt").value,
    mounting: $("mounting").value,
    row_spacing_m: rowGap === "" ? null : +rowGap,
    col_spacing_m: +$("colGap").value,
    setback_m: +$("setback").value,
  };
}

// ---------- Layout ----------
function clearLayout() {
  panelsLayer.clearLayers();
  state.layout = null;
  clearShading();
  window.elec?.reset();
}

const PANEL_STYLE = { color: "#dbeafe", weight: 0.5, fillColor: "#2563eb", fillOpacity: 0.75 };
const addPanel = (latlngs) => L.polygon(latlngs, PANEL_STYLE).addTo(panelsLayer);

async function runLayout() {
  const areaLayers = areas.getLayers();
  if (!areaLayers.length) throw new Error("Σχεδίασε πρώτα μια περιοχή στον χάρτη.");
  const s = settings();
  const ko = keepouts.getLayers().map(latlngsOf);
  panelsLayer.clearLayers();

  // Roof faces with their own tilt/azimuth: one request for all, with the face of every panel.
  if (window.faces?.active()) {
    const { panels, ...res } = await api("/api/layout/faces", "POST", { ...s, keepouts: ko, faces: faces.list() });
    panels.forEach((p) => addPanel(p));
    state.layout = res;
    clearShading();
    window.elec?.reset();
    if (!res.count) toast("Δεν χωράει κανένα πάνελ. Δοκίμασε μικρότερη απόσταση από τα άκρα ή οριζόντια πάνελ.", 6000);
    return;
  }

  const total = { count: 0, kwp: 0, area_m2: 0, module_area_m2: 0, row_gap_m: null, center: null };
  for (const layer of areaLayers) {
    const res = await api("/api/layout", "POST", { ...s, area: latlngsOf(layer), keepouts: ko });
    res.panels.forEach((p) =>
      addPanel(p)
    );
    total.count += res.count;
    total.kwp += res.kwp;
    total.area_m2 += res.area_m2;
    total.module_area_m2 += res.module_area_m2;
    total.row_gap_m = res.row_gap_m;
    total.center = total.center || res.center;
  }
  total.kwp = Math.round(total.kwp * 1000) / 1000;
  state.layout = total;
  clearShading();
  window.elec?.reset();
  if (!total.count) toast("Δεν χωράει κανένα πάνελ. Δοκίμασε μικρότερη απόσταση από τα άκρα ή οριζόντια πάνελ.", 6000);
}
$("btnLayout").onclick = () => withBusy($("btnLayout"), runLayout);

// ---------- Shading ----------
function shadingInput() {
  const s = settings();
  return {
    panels: panelsLayer.getLayers().map(latlngsOf),
    obstacles: keepouts.getLayers().map((l) => ({ polygon: latlngsOf(l), height_m: l.pvHeight || 0 })),
    tilt_deg: s.tilt_deg, azimuth_deg: s.azimuth_deg, mounting: s.mounting,
    ...(window.faces?.shadingFaces() || {}),
  };
}

function clearShading() {
  state.shading = null;
  state.energy = null;
  state.finance = null;
  colorPanels();
  refreshShadows();
  renderResults();
}

function lossColor(pct) {
  if (pct < 1) return "#2563eb";
  if (pct < 5) return "#facc15";
  if (pct < 10) return "#f97316";
  return "#dc2626";
}

function colorPanels() {
  const losses = state.shading && state.shading.panel_loss_pct;
  panelsLayer.getLayers().forEach((l, i) => {
    const pct = losses ? losses[i] : null;
    l.setStyle({ fillColor: pct == null ? "#2563eb" : lossColor(pct) });
    if (pct == null) l.unbindTooltip(); else l.bindTooltip(`Σκίαση: ${fmt(pct, 1)}% τον χρόνο`);
  });
  $("shadingLegend").hidden = !losses;
}

async function runShading() {
  if (!state.layout || !state.layout.count) await runLayout();
  if (!state.layout.count) return;
  toast("Υπολογισμός σκιάσεων… (σε μεγάλα έργα παίρνει λίγα δευτερόλεπτα)", 15000);
  state.shading = await api("/api/shading", "POST", shadingInput());
  $("toast").hidden = true;
  state.energy = null;
  state.finance = null;
  colorPanels();
  renderResults();
}
$("btnShading").onclick = () => withBusy($("btnShading"), runShading);

function renderShadingInfo() {
  const sh = state.shading;
  if (!sh) { $("shadingInfo").textContent = ""; return; }
  const why = [];
  if (sh.obstacles_used) why.push(`${sh.obstacles_used} εμπόδιο(α) με ύψος`);
  if (sh.row_shading) why.push("σκίαση μεταξύ σειρών");
  $("shadingInfo").textContent = why.length
    ? `Απώλεια από σκιάσεις: ${fmt(sh.annual_loss_pct, 1)}% τον χρόνο (από ${why.join(" και ")}). ` +
      `Άμεσος ήλιος ${fmt(sh.beam_loss_pct, 1)}%, διάχυτο φως ουρανού ${fmt(sh.diffuse_loss_pct, 1)}%. ` +
      `Το πιο σκιασμένο πάνελ χάνει ${fmt(sh.worst_panel_loss_pct, 1)}%.`
    : "Δεν υπάρχει σκίαση: δεν έχεις εμπόδια με ύψος και τα πάνελ είναι παράλληλα με τη στέγη.";
}

// Shadows at a chosen moment (browser local time, on the 21st of the month).
MONTHS.forEach((m, i) => $("shadowMonth").add(new Option(m, i)));
$("shadowMonth").value = 11;
let shadowTimer = null;
function refreshShadows() {
  const on = $("showShadows").checked;
  $("shadowControls").hidden = !on;
  const h = +$("shadowHour").value;
  $("shadowHourLabel").textContent = `${Math.floor(h)}:${h % 1 ? "30" : "00"}`;
  clearTimeout(shadowTimer);
  if (!on) { shadowsLayer.clearLayers(); $("sunInfo").textContent = ""; return; }
  shadowTimer = setTimeout(async () => {
    const input = shadingInput();
    if (!input.panels.length && !input.obstacles.length) {
      shadowsLayer.clearLayers();
      $("sunInfo").textContent = "Σχεδίασε εμπόδια ή τοποθέτησε πάνελ για να δεις σκιές.";
      return;
    }
    const when = new Date(new Date().getFullYear(), +$("shadowMonth").value, 21, Math.floor(h), (h % 1) * 60);
    try {
      const r = await api("/api/shadows", "POST", { ...input, when: when.toISOString() });
      shadowsLayer.clearLayers();
      r.shadows.forEach((p) =>
        L.polygon(p, { stroke: false, fillColor: "#111827", fillOpacity: 0.45, interactive: false }).addTo(shadowsLayer)
      );
      $("sunInfo").textContent = r.sun_elevation > 3
        ? `Ήλιος: ύψος ${fmt(r.sun_elevation)}°, αζιμούθιο ${fmt(r.sun_azimuth)}°.`
        : "Ο ήλιος είναι κάτω από τον ορίζοντα.";
    } catch (e) { toast(e.message); }
  }, 150);
}
["showShadows", "shadowMonth", "shadowHour"].forEach((id) => $(id).addEventListener("input", refreshShadows));
refreshShadows();

// ---------- Energy ----------
async function runEnergy() {
  if (!state.layout || !state.layout.count) await runLayout();
  if (!state.layout.count) return;
  if (!state.shading) await runShading();
  if (window.elec?.detailed()) {
    state.energy = await elec.simulate();
    return renderResults();
  }
  const s = settings();
  const [lat, lon] = state.layout.center;
  state.energy = await api("/api/energy", "POST", {
    lat, lon, kwp: state.layout.kwp, tilt_deg: s.tilt_deg, azimuth_deg: s.azimuth_deg, loss_pct: +$("loss").value,
    shading_monthly_pct: state.shading ? state.shading.monthly_loss_pct : null,
    faces: window.faces?.energyFaces() || null,
  });
  state.finance = null;
  renderResults();
}
$("btnEnergy").onclick = () => withBusy($("btnEnergy"), runEnergy);

// ---------- Results ----------
const fmt = (n, d = 0) => (n == null ? "–" : Number(n).toLocaleString("el-GR", { maximumFractionDigits: d }));

function renderResults() {
  const l = state.layout, e = state.energy;
  $("statCount").textContent = l ? fmt(l.count) : "–";
  $("statKwp").textContent = l ? fmt(l.kwp, 2) : "–";
  $("statKwh").textContent = e ? fmt(e.annual_kwh) : "–";
  $("statYield").textContent = e ? fmt(e.specific_yield) : "–";
  $("statExtra").textContent = l
    ? `Επιφάνεια περιοχής ${fmt(l.area_m2, 1)} m², επιφάνεια πάνελ ${fmt(l.module_area_m2, 1)} m², κενό σειρών ${fmt(l.row_gap_m, 2)} m.` +
      (state.shading ? ` Απώλειες σκίασης ${fmt(state.shading.annual_loss_pct, 1)}%.` : "") +
      (e && e.annual_kwh_unshaded ? ` Χωρίς σκιές θα ήταν ${fmt(e.annual_kwh_unshaded)} kWh.` : "") +
      (e ? ` Ακτινοβολία στο επίπεδο πάνελ ${fmt(e.annual_irradiation)} kWh/m² ανά έτος. Πηγή: ${e.source.startsWith("PVGIS") ? "PVGIS (ΕΕ)" : "πρόχειρο μοντέλο χωρίς internet"}.` : "")
    : "";
  renderShadingInfo();
  $("energyWarning").hidden = !(e && e.warning);
  $("energyWarning").textContent = e && e.warning ? e.warning : "";

  if (chart) { chart.destroy(); chart = null; }
  if (e) {
    chart = new Chart($("chart"), {
      type: "bar",
      data: {
        labels: e.monthly.map((m) => MONTHS[m.month - 1]),
        datasets: [
          { label: "Παραγωγή (kWh)", data: e.monthly.map((m) => m.kwh), backgroundColor: "#f59e0b" },
          ...(e.annual_kwh_unshaded ? [{
            label: "Χάνεται από σκιές (kWh)",
            data: e.monthly.map((m) => Math.round((m.kwh_unshaded - m.kwh) * 10) / 10),
            backgroundColor: "#9ca3af",
          }] : []),
        ],
      },
      options: {
        plugins: { legend: { display: !!e.annual_kwh_unshaded, labels: { boxWidth: 12 } } },
        scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: "kWh" } } },
      },
    });
  }
  window.elec?.render();
  window.faces?.renderTable();
  renderFinance();
}

// ---------- Financial analysis ----------
// Input id -> API field. Defaults in index.html are typical for Greece.
const FINANCE_FIELDS = {
  finCapex: "capex_per_kwp", finSubsidy: "subsidy_eur", finScheme: "scheme", finSelf: "self_consumption_pct",
  finConsumption: "annual_consumption_kwh", finRetail: "retail_price", finExport: "export_price",
  finOffset: "offset_price", finEscalation: "price_escalation_pct", finDegradation: "degradation_pct",
  finOm: "om_per_kwp", finOmEsc: "om_escalation_pct", finInvYear: "inverter_replacement_year",
  finInvCost: "inverter_cost_per_kwp", finDiscount: "discount_rate_pct", finLife: "lifetime_years",
};

function financeSettings() {
  const out = {};
  for (const [id, key] of Object.entries(FINANCE_FIELDS)) {
    const v = $(id).value;
    out[key] = id === "finScheme" ? v : v === "" ? null : +v;
  }
  return out;
}

function updateSchemeFields() {
  const scheme = $("finScheme").value;
  $("finExportLabel").hidden = scheme !== "net_billing";
  $("finOffsetLabel").hidden = scheme !== "net_metering";
}
$("finScheme").onchange = updateSchemeFields;
updateSchemeFields();

async function runFinance() {
  if (!state.energy) await runEnergy();
  if (!state.energy) return;
  state.finance = await api("/api/finance", "POST", {
    ...financeSettings(), kwp: state.layout.kwp, annual_kwh: state.energy.annual_kwh,
  });
  renderFinance();
}
$("btnFinance").onclick = () => withBusy($("btnFinance"), runFinance);

const eur = (n) => (n == null ? "–" : `${fmt(n)} €`);

function renderFinance() {
  const f = state.finance;
  $("financeResults").hidden = !f;
  if (financeChart) { financeChart.destroy(); financeChart = null; }
  if (!f) return;
  $("finPayback").textContent = f.payback_years == null ? "δεν αποσβένεται" : fmt(f.payback_years, 1);
  $("finIrr").textContent = f.irr_pct == null ? "–" : `${fmt(f.irr_pct, 1)}%`;
  $("finNpv").textContent = eur(f.npv);
  $("finLcoe").textContent = fmt(f.lcoe, 3);
  const life = f.years.length;
  $("finExtra").textContent =
    `Κόστος συστήματος ${eur(f.capex)}` + (f.investment !== f.capex ? `, μετά την επιδότηση ${eur(f.investment)}` : "") +
    `. Όφελος 1ου έτους ${eur(f.first_year_benefit)} (καθαρό ${eur(f.first_year_net)} μετά τη συντήρηση).` +
    ` Συνολικό καθαρό κέρδος σε ${life} χρόνια ${eur(f.years[life - 1].cumulative)}` +
    (f.roi_pct == null ? "." : ` (ROI ${fmt(f.roi_pct)}%).`) +
    (f.discounted_payback_years == null ? "" : ` Απόσβεση με αναγωγή σε σημερινές τιμές: ${fmt(f.discounted_payback_years, 1)} έτη.`);
  // Year 0 is the investment itself.
  const years = [{ year: 0, net: -f.investment, cumulative: -f.investment }, ...f.years];
  financeChart = new Chart($("financeChart"), {
    data: {
      labels: years.map((y) => y.year),
      datasets: [
        { type: "line", label: "Σωρευτικό (€)", data: years.map((y) => y.cumulative), borderColor: "#16a34a",
          backgroundColor: "#16a34a", pointRadius: 0, tension: 0.2 },
        { type: "bar", label: "Καθαρό ανά έτος (€)", data: years.map((y) => y.net),
          backgroundColor: years.map((y) => (y.net < 0 ? "#ef4444" : "#f59e0b")) },
      ],
    },
    options: {
      plugins: { legend: { labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${eur(c.raw)}` } } },
      scales: { x: { title: { display: true, text: "Έτος" } }, y: { title: { display: true, text: "€" } } },
    },
  });
}

// ---------- PDF report ----------
async function downloadReport() {
  if (!state.layout || !state.layout.count) await runLayout();
  if (!state.layout.count) return;
  if (!state.energy) {
    try { await runEnergy(); } catch (e) { toast(`Η αναφορά θα βγει χωρίς παραγωγή: ${e.message}`, 6000); }
  }
  toast("Ετοιμάζεται η αναφορά…", 15000);
  const r = await fetch("/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collectProject()),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(typeof data.detail === "string" ? data.detail : "Η αναφορά δεν δημιουργήθηκε.");
  }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `Μελέτη ΦΒ - ${$("projectName").value || "έργο"}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast("Η αναφορά κατέβηκε στα «Λήψεις» (Downloads).", 5000);
}
$("btnReport").onclick = () => withBusy($("btnReport"), downloadReport);

// The author is usually the same for every project, so remember it on this computer.
const AUTHOR_KEY = "pv-designer.author";
try { $("reportAuthor").value = localStorage.getItem(AUTHOR_KEY) || ""; } catch {}
$("reportAuthor").onchange = () => { try { localStorage.setItem(AUTHOR_KEY, $("reportAuthor").value); } catch {} };

// ---------- Projects ----------
function collectProject() {
  return {
    name: $("projectName").value || "Χωρίς όνομα",
    settings: {
      ...settings(), loss_pct: +$("loss").value, preset: $("panelPreset").value,
      panel_name: PANEL_PRESETS[$("panelPreset").value].power ? PANEL_PRESETS[$("panelPreset").value].name : null,
    },
    report_info: { client: $("clientName").value, address: $("projectAddress").value, author: $("reportAuthor").value },
    areas: areas.getLayers().map(latlngsOf),
    area_faces: window.faces?.collect() || null,
    keepouts: keepouts.getLayers().map(latlngsOf),
    keepout_heights: keepouts.getLayers().map((l) => l.pvHeight || 0),
    shading: state.shading,
    layout: state.layout ? { ...state.layout, panels: panelsLayer.getLayers().map(latlngsOf) } : null,
    energy: state.energy,
    finance_settings: financeSettings(),
    finance: state.finance,
    electrical: window.elec?.collect(),
    view: { center: map.getCenter(), zoom: map.getZoom() },
  };
}

function resetProject() {
  areas.clearLayers(); keepouts.clearLayers(); editGroup.clearLayers();
  window.plan?.clear();
  state.projectId = null;
  $("projectName").value = "Νέο έργο";
  $("clientName").value = "";
  $("projectAddress").value = "";
  clearLayout();
  updateShapesInfo();
  markSaved();
}

// What the project looked like when it was last saved or opened, to warn before unsaved work is lost.
let savedSnapshot = "";
function projectSnapshot() {
  const { view, ...rest } = collectProject();
  return JSON.stringify(rest);
}
function markSaved() { savedSnapshot = projectSnapshot(); }
function hasUnsavedWork() {
  return (areas.getLayers().length > 0 || !!state.projectId) && projectSnapshot() !== savedSnapshot;
}

function loadProject(p) {
  resetProject();
  state.projectId = p.id;
  $("projectName").value = p.name;
  const s = p.settings || {};
  if (s.preset != null) $("panelPreset").value = s.preset;
  const set = (id, v) => { if (v != null) $(id).value = v; };
  set("panelPower", s.panel_power_w); set("panelWidth", s.panel_width_m); set("panelLength", s.panel_length_m);
  set("orientation", s.orientation); set("azimuth", s.azimuth_deg); set("tilt", s.tilt_deg);
  set("mounting", s.mounting); set("colGap", s.col_spacing_m); set("setback", s.setback_m); set("loss", s.loss_pct);
  $("rowGap").value = s.row_spacing_m == null ? "" : s.row_spacing_m;
  const info = p.report_info || {};
  $("clientName").value = info.client || "";
  $("projectAddress").value = info.address || "";
  if (info.author) $("reportAuthor").value = info.author;
  (p.areas || []).forEach((a) => addShape(L.polygon(a), "area"));
  window.faces?.load(p.area_faces);
  // Projects saved before shading analysis have no heights: their obstacles cast no shadow.
  (p.keepouts || []).forEach((k, i) => addShape(L.polygon(k), "keepout", (p.keepout_heights || [])[i] || 0));
  if (p.layout) {
    p.layout.panels.forEach((pp) =>
      addPanel(pp)
    );
    const { panels, ...rest } = p.layout;
    state.layout = rest;
  }
  for (const [id, key] of Object.entries(FINANCE_FIELDS)) {
    const v = (p.finance_settings || {})[key];
    if (v !== undefined) $(id).value = v ?? "";
  }
  updateSchemeFields();
  state.shading = p.shading || null;
  state.energy = p.energy || null;
  state.finance = p.finance || null;
  colorPanels();
  window.elec?.load(p.electrical);
  renderResults();
  if (p.view) map.setView(p.view.center, p.view.zoom);
  markSaved();
}

async function refreshProjectList() {
  const list = await api("/api/projects");
  const sel = $("projectList");
  sel.length = 1;
  list.forEach((p) => sel.add(new Option(p.name, p.id)));
  sel.value = state.projectId || "";
}

$("btnSave").onclick = () => withBusy($("btnSave"), async () => {
  const data = collectProject();
  const saved = state.projectId
    ? await api(`/api/projects/${state.projectId}`, "PUT", data)
    : await api("/api/projects", "POST", data);
  state.projectId = saved.id;
  markSaved();
  await refreshProjectList();
  toast("Το έργο αποθηκεύτηκε.");
});

$("projectList").onchange = async () => {
  const id = $("projectList").value;
  if (!id) return;
  try { loadProject(await api(`/api/projects/${id}`)); } catch (e) { toast(e.message); }
};

$("btnNew").onclick = () => { resetProject(); $("projectList").value = ""; };

$("btnDelete").onclick = () => withBusy($("btnDelete"), async () => {
  if (!state.projectId) return toast("Δεν έχει ανοίξει αποθηκευμένο έργο.");
  if (!confirm(`Να διαγραφεί το έργο «${$("projectName").value}»;`)) return;
  await api(`/api/projects/${state.projectId}`, "DELETE");
  resetProject();
  await refreshProjectList();
  toast("Το έργο διαγράφηκε.");
});

refreshProjectList().catch(() => toast("Δεν βρέθηκε ο server. Ξεκίνα την εφαρμογή με το αρχείο εκκίνησης."));

api("/api/version").then((v) => {
  $("appVersion").textContent = `v${v.version}`;
  document.title = `PV Designer v${v.version}`;
}).catch(() => {});

// ---------- Google satellite (Map Tiles API, needs the owner's own key) ----------
const GOOGLE_TILES = "https://tile.googleapis.com/v1";
const google = { layer: null, key: "", session: "", attribution: "" };

async function startGoogle(key) {
  const r = await fetch(`${GOOGLE_TILES}/createSession?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "satellite", language: "el-GR", region: "GR" }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.session) {
    throw new Error((d.error && d.error.message) || `Η Google απάντησε με σφάλμα ${r.status}.`);
  }
  google.key = key;
  google.session = d.session;
  const url = `${GOOGLE_TILES}/2dtiles/{z}/{x}/{y}?session=${d.session}&key=${encodeURIComponent(key)}`;
  if (google.layer) {
    google.layer.setUrl(url);
  } else {
    google.layer = L.tileLayer(url, { maxNativeZoom: 20, maxZoom: MAX_ZOOM, attribution: "Google" });
    layersControl.addBaseLayer(google.layer, "Δορυφόρος Google");
  }
  // Make Google the visible base map.
  [satellite, clarity, ktimatologio, streets].forEach((l) => map.removeLayer(l));
  google.layer.addTo(map);
  refreshGoogleViewport();
}

// Google requires showing its copyright text, and tells us the sharpest zoom per area.
let googleTimer = null;
function refreshGoogleViewport() {
  clearTimeout(googleTimer);
  googleTimer = setTimeout(async () => {
    if (!google.layer || !map.hasLayer(google.layer)) return;
    const b = map.getBounds();
    const q = new URLSearchParams({
      session: google.session, key: google.key, zoom: Math.min(map.getZoom(), 22),
      north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(),
    });
    try {
      const d = await (await fetch(`${GOOGLE_TILES}/viewport?${q}`)).json();
      const text = `Google${d.copyright ? " · " + d.copyright : ""}`;
      if (text !== google.attribution) {
        map.attributionControl.removeAttribution(google.attribution || "Google");
        map.attributionControl.addAttribution(text);
        google.attribution = text;
      }
      const c = map.getCenter();
      const zooms = (d.maxZoomRects || [])
        .filter((z) => c.lat <= z.north && c.lat >= z.south && c.lng <= z.east && c.lng >= z.west)
        .map((z) => z.maxZoom);
      const best = zooms.length ? Math.max(...zooms) : null;
      if (best && best !== google.layer.options.maxNativeZoom) {
        google.layer.options.maxNativeZoom = best;
        google.layer.redraw();
      }
    } catch {
      // Viewport info is optional; tiles still work without it.
    }
  }, 400);
}
map.on("moveend baselayerchange", refreshGoogleViewport);

function setGoogleStatus(msg) { $("googleStatus").textContent = msg; }

$("btnGoogleKey").onclick = () => withBusy($("btnGoogleKey"), async () => {
  const key = $("googleKey").value.trim();
  await api("/api/settings", "PUT", { google_maps_key: key });
  if (!key) {
    setGoogleStatus("Το κλειδί αφαιρέθηκε.");
    if (google.layer) { map.removeLayer(google.layer); satellite.addTo(map); }
    return;
  }
  try {
    await startGoogle(key);
    setGoogleStatus("✓ Ο χάρτης Google είναι ενεργός.");
    toast("Ο χάρτης Google ενεργοποιήθηκε.");
  } catch (e) {
    setGoogleStatus(`Δεν δούλεψε το κλειδί: ${e.message}`);
  }
});

api("/api/settings").then(async (s) => {
  if (!s.google_maps_key) return;
  $("googleKey").value = s.google_maps_key;
  try {
    await startGoogle(s.google_maps_key);
    setGoogleStatus("✓ Ο χάρτης Google είναι ενεργός.");
  } catch (e) {
    setGoogleStatus(`Δεν δούλεψε το κλειδί: ${e.message}`);
  }
}).catch(() => {});
