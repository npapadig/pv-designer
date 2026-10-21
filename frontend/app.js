// PV Designer frontend: map drawing, panel layout and energy results.

const PANEL_PRESETS = [
  { name: "Γενικό 410 W (1722 × 1134 mm)", power: 410, width: 1.134, length: 1.722 },
  { name: "Γενικό 450 W (1903 × 1134 mm)", power: 450, width: 1.134, length: 1.903 },
  { name: "Γενικό 500 W (1961 × 1134 mm)", power: 500, width: 1.134, length: 1.961 },
  { name: "Γενικό 550 W (2278 × 1134 mm)", power: 550, width: 1.134, length: 2.278 },
  { name: "Γενικό 600 W (2384 × 1134 mm)", power: 600, width: 1.134, length: 2.384 },
  { name: "Δικό μου (συμπληρώνω τα στοιχεία)", power: null },
];
const MONTHS = ["Ιαν", "Φεβ", "Μαρ", "Απρ", "Μάι", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ"];

const $ = (id) => document.getElementById(id);
const state = { projectId: null, layout: null, energy: null };
let chart = null;

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
L.control.layers({
  "Δορυφόρος (Esri)": satellite,
  "Δορυφόρος (Esri Clarity, συχνά πιο καθαρός)": clarity,
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

function addShape(layer, kind) {
  layer.setStyle(kind === "keepout" ? KEEPOUT_STYLE : AREA_STYLE);
  layer.pvKind = kind;
  (kind === "keepout" ? keepouts : areas).addLayer(layer);
  editGroup.addLayer(layer);
  updateShapesInfo();
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
  $("azimuth").value = Math.round(az);
  toast(`Αζιμούθιο: ${Math.round(az)}°`);
};
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

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
  state.energy = null;
  renderResults();
}

async function runLayout() {
  const areaLayers = areas.getLayers();
  if (!areaLayers.length) throw new Error("Σχεδίασε πρώτα μια περιοχή στον χάρτη.");
  const s = settings();
  const ko = keepouts.getLayers().map(latlngsOf);
  panelsLayer.clearLayers();

  const total = { count: 0, kwp: 0, area_m2: 0, module_area_m2: 0, row_gap_m: null, center: null };
  for (const layer of areaLayers) {
    const res = await api("/api/layout", "POST", { ...s, area: latlngsOf(layer), keepouts: ko });
    res.panels.forEach((p) =>
      L.polygon(p, { color: "#dbeafe", weight: 0.5, fillColor: "#2563eb", fillOpacity: 0.75 }).addTo(panelsLayer)
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
  state.energy = null;
  renderResults();
  if (!total.count) toast("Δεν χωράει κανένα πάνελ. Δοκίμασε μικρότερη απόσταση από τα άκρα ή οριζόντια πάνελ.", 6000);
}
$("btnLayout").onclick = () => withBusy($("btnLayout"), runLayout);

// ---------- Energy ----------
async function runEnergy() {
  if (!state.layout || !state.layout.count) await runLayout();
  if (!state.layout.count) return;
  const s = settings();
  const [lat, lon] = state.layout.center;
  state.energy = await api("/api/energy", "POST", {
    lat, lon, kwp: state.layout.kwp, tilt_deg: s.tilt_deg, azimuth_deg: s.azimuth_deg, loss_pct: +$("loss").value,
  });
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
      (e ? ` Ακτινοβολία στο επίπεδο πάνελ ${fmt(e.annual_irradiation)} kWh/m² ανά έτος. Πηγή: ${e.source === "PVGIS" ? "PVGIS (ΕΕ)" : "πρόχειρο μοντέλο χωρίς internet"}.` : "")
    : "";
  $("energyWarning").hidden = !(e && e.warning);
  $("energyWarning").textContent = e && e.warning ? e.warning : "";

  if (chart) { chart.destroy(); chart = null; }
  if (e) {
    chart = new Chart($("chart"), {
      type: "bar",
      data: {
        labels: e.monthly.map((m) => MONTHS[m.month - 1]),
        datasets: [{ label: "Παραγωγή (kWh)", data: e.monthly.map((m) => m.kwh), backgroundColor: "#f59e0b" }],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { title: { display: true, text: "kWh" } } } },
    });
  }
}

$("btnReport").onclick = () => {
  if (!state.layout) return toast("Κάνε πρώτα τοποθέτηση πάνελ.");
  document.title = `${$("projectName").value} – PV Designer`;
  window.print();
};

// ---------- Projects ----------
function collectProject() {
  return {
    name: $("projectName").value || "Χωρίς όνομα",
    settings: { ...settings(), loss_pct: +$("loss").value, preset: $("panelPreset").value },
    areas: areas.getLayers().map(latlngsOf),
    keepouts: keepouts.getLayers().map(latlngsOf),
    layout: state.layout ? { ...state.layout, panels: panelsLayer.getLayers().map(latlngsOf) } : null,
    energy: state.energy,
    view: { center: map.getCenter(), zoom: map.getZoom() },
  };
}

function resetProject() {
  areas.clearLayers(); keepouts.clearLayers(); editGroup.clearLayers();
  state.projectId = null;
  $("projectName").value = "Νέο έργο";
  clearLayout();
  updateShapesInfo();
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
  (p.areas || []).forEach((a) => addShape(L.polygon(a), "area"));
  (p.keepouts || []).forEach((k) => addShape(L.polygon(k), "keepout"));
  if (p.layout) {
    p.layout.panels.forEach((pp) =>
      L.polygon(pp, { color: "#dbeafe", weight: 0.5, fillColor: "#2563eb", fillOpacity: 0.75 }).addTo(panelsLayer)
    );
    const { panels, ...rest } = p.layout;
    state.layout = rest;
  }
  state.energy = p.energy || null;
  renderResults();
  if (p.view) map.setView(p.view.center, p.view.zoom);
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
