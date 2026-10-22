// Drawing aids on the map: the length of every side of the drawn areas and obstacles, live while
// drawing and afterwards. Loaded after app.js and uses its map, areas, keepouts, drawControl and fmt.
(() => {
  // ---------- Distances ----------
  // Local metres on the WGS84 ellipsoid (meridian and prime-vertical radii at the mean latitude):
  // millimetre-accurate for the short sides of a roof.
  const A = 6378137, E2 = 0.00669437999014;
  const RAD = Math.PI / 180;
  function radii(lat) {
    const s = Math.sin(lat * RAD), w = 1 - E2 * s * s;
    return { north: (A * (1 - E2)) / (w * Math.sqrt(w)) * RAD, east: (A / Math.sqrt(w)) * Math.cos(lat * RAD) * RAD };
  }
  function meters(a, b) {
    const r = radii((a.lat + b.lat) / 2);
    return Math.hypot((b.lng - a.lng) * r.east, (b.lat - a.lat) * r.north);
  }

  // ---------- Side labels ----------
  const MIN_PX = 46; // sides shorter than this on screen get no label (it would cover the side)
  map.createPane("pvLabels").style.zIndex = 620;
  const labels = new Map(); // shape layer -> L.LayerGroup of its labels
  const draft = L.layerGroup().addTo(map); // labels of the shape being drawn

  function label(a, b, cls) {
    const len = meters(a, b);
    const pa = map.project(a), pb = map.project(b);
    if (pa.distanceTo(pb) < MIN_PX || len < 0.005) return null;
    let ang = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180; // keep the text upright
    const icon = L.divIcon({
      className: `pv-edge ${cls || ""}`, iconSize: [0, 0],
      html: `<span style="--a:${ang.toFixed(1)}deg">${fmt(len, 2)} m</span>`,
    });
    return L.marker(L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2), { icon, pane: "pvLabels", interactive: false, keyboard: false });
  }

  // One label per side; `closed` adds the side from the last point back to the first.
  function sideLabels(pts, closed, cls, group) {
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const m = label(pts[i], pts[(i + 1) % n], typeof cls === "function" ? cls(i) : cls);
      if (m) group.addLayer(m);
    }
    return group;
  }

  const ring = (layer) => layer.getLatLngs()[0] || [];
  const kindClass = (layer) => (layer.pvKind === "keepout" ? "keepout" : "area");

  function refresh(layer) {
    let group = labels.get(layer);
    if (!group) labels.set(layer, (group = L.layerGroup().addTo(map)));
    group.clearLayers();
    sideLabels(ring(layer), true, kindClass(layer), group);
  }
  const refreshAll = () => labels.forEach((_, layer) => refresh(layer));

  function watch(e) {
    const layer = e.layer;
    layer.on("editdrag edit pv:moved", () => refresh(layer));
    refresh(layer);
  }
  function unwatch(e) {
    const group = labels.get(e.layer);
    if (group) map.removeLayer(group);
    labels.delete(e.layer);
  }
  for (const g of [areas, keepouts]) {
    g.on("layeradd", watch);
    g.on("layerremove", unwatch);
  }
  map.on("zoomend", refreshAll);

  // Nudge and other code move shapes with setLatLngs, which fires no event of its own.
  const setLatLngs = L.Polyline.prototype.setLatLngs;
  L.Polyline.include({
    setLatLngs(latlngs) {
      const r = setLatLngs.call(this, latlngs);
      this.fire("pv:moved");
      return r;
    },
  });

  // ---------- Look of lines and handles ----------
  // A soft dark halo keeps the lines readable on bright roofs; an SVG filter, because CSS
  // drop-shadow() is not applied to SVG shapes in every browser.
  document.body.insertAdjacentHTML("afterbegin", `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <filter id="pvHalo" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="0" stdDeviation="1.2" flood-color="#000" flood-opacity="0.75"/>
    </filter></svg>`);
  const HANDLE = L.divIcon({ className: "leaflet-div-icon leaflet-editing-icon pv-handle", iconSize: [14, 14] });
  const DRAFT_AREA = { color: "#ffc53d", fillColor: "#ffc53d" };
  const DRAFT_KEEPOUT = { color: "#ff4d6d", fillColor: "#ff4d6d" };

  // ---------- Live labels while drawing ----------
  let drawing = null; // the active Leaflet.draw handler
  let mouse = null;

  function drawDraft() {
    draft.clearLayers();
    if (!drawing) return;
    const cls = document.querySelector("input[name=drawMode]:checked")?.value === "keepout" ? "keepout draft" : "area draft";
    if (drawing.type === "rectangle") {
      if (drawing._shape) sideLabels(drawing._shape.getLatLngs()[0], true, cls, draft);
      return;
    }
    const pts = (drawing._markers || []).map((m) => m.getLatLng());
    if (!pts.length) return;
    if (mouse) pts.push(mouse);
    // The side to the mouse is the one being drawn now; the closing side is only a preview.
    sideLabels(pts, false, (i) => (mouse && i === pts.length - 2 ? `${cls} live` : cls), draft);
    if (mouse && pts.length > 2) {
      const m = label(mouse, pts[0], `${cls} closing`);
      if (m) draft.addLayer(m);
    }
  }

  map.on("draw:drawstart", (e) => {
    const mode = drawControl._toolbars.draw._modes[e.layerType];
    drawing = mode ? mode.handler : null;
    if (drawing) {
      const keepout = document.querySelector("input[name=drawMode]:checked")?.value === "keepout";
      Object.assign(drawing.options.shapeOptions, keepout ? DRAFT_KEEPOUT : DRAFT_AREA);
      drawing.options.icon = drawing.options.touchIcon = HANDLE;
    }
    mouse = null;
    drawDraft();
  });
  map.on("draw:drawstop", () => { drawing = null; mouse = null; drawDraft(); });
  map.on("draw:drawvertex", drawDraft);
  map.on("mousemove", (e) => {
    if (!drawing) return;
    mouse = drawing.type === "rectangle" ? null : e.latlng;
    drawDraft();
  });

  // ---------- Panel cells ----------
  // Thin lines over each panel: the gap of half-cut modules across the middle (zoom 19+) and
  // six cell columns along the long side (zoom 21+). Kept in their own layers, so the panel
  // layers (whose order the shading results follow) stay untouched.
  map.createPane("pvCells").style.zIndex = 401;
  map.getPane("pvCells").style.pointerEvents = "none";
  const LINE = { pane: "pvCells", interactive: false, color: "#cbd5e1", lineCap: "butt" };
  const gapLines = L.polyline([], { ...LINE, weight: 1, opacity: 0.7 });
  const cellLines = L.polyline([], { ...LINE, weight: 0.6, opacity: 0.35 });
  const COLS = 6;
  const lerp = (a, b, t) => [a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t];

  function rebuildCells() {
    const gaps = [], cells = [];
    for (const panel of panelsLayer.getLayers()) {
      const c = panel.getLatLngs()[0];
      if (!c || c.length !== 4) continue;
      // Long sides: a→b and d→c (a, b, c, d in order around the panel).
      let [a, b, cc, d] = c;
      if (meters(a, b) < meters(b, cc)) [a, b, cc, d] = [b, cc, d, a];
      gaps.push([lerp(a, b, 0.5), lerp(d, cc, 0.5)]);
      for (let k = 1; k < COLS; k++) cells.push([lerp(a, d, k / COLS), lerp(b, cc, k / COLS)]);
    }
    gapLines.setLatLngs(gaps);
    cellLines.setLatLngs(cells);
    showCells();
  }
  function showCells() {
    const z = map.getZoom(), n = panelsLayer.getLayers().length;
    const toggle = (layer, on) => (on ? map.addLayer(layer) : map.removeLayer(layer));
    toggle(gapLines, n && z >= 19);
    toggle(cellLines, n && z >= 21);
  }
  let cellsTimer = 0; // one rebuild after a whole layout is added or cleared
  panelsLayer.on("layeradd layerremove", () => {
    clearTimeout(cellsTimer);
    cellsTimer = setTimeout(rebuildCells, 0);
  });
  map.on("zoomend", showCells);

  window.drawTools = { meters, refresh, refreshAll };
})();
