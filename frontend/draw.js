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

  // With `onClick` the label is a button (in edit mode: change that side).
  function label(a, b, cls, onClick) {
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
    const m = L.marker(L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2), { icon, pane: "pvLabels", interactive: !!onClick, keyboard: false });
    if (onClick) m.on("click", (e) => { L.DomEvent.stop(e); onClick(); });
    return m;
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
    if (layer.pvTree) return; // a tree's 24 short sides would only hide it (its size is in its tooltip)
    const pts = ring(layer), n = pts.length;
    for (let i = 0; i < n; i++) {
      const m = label(pts[i], pts[(i + 1) % n], kindClass(layer), editing ? () => sideBox(layer, i) : null);
      if (m) group.addLayer(m);
    }
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
    if (editing && !shapes().length) stop(true); // e.g. another project was opened
  }
  for (const g of [areas, keepouts]) {
    g.on("layeradd", watch);
    g.on("layerremove", unwatch);
  }
  map.on("zoomend", refreshAll);

  // The side box, undo and dragging a selected shape (shapes.js) move shapes with setLatLngs, which fires no event of its own. Leaflet.draw's
  // editor also keeps a reference to the old points, so point it at the new ones (and redraw its handles).
  const setLatLngs = L.Polyline.prototype.setLatLngs;
  L.Polyline.include({
    setLatLngs(latlngs) {
      const r = setLatLngs.call(this, latlngs);
      if (this.editing instanceof L.Edit.Poly) {
        this.fire("revert-edited", { layer: this });
        if (this.editing.enabled()) { this.editing.removeHooks(); this.editing.addHooks(); }
      }
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
    const cls = document.querySelector("input[name=drawMode]:checked")?.value !== "area" ? "keepout draft" : "area draft";
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
    stop(true);
    const mode = drawControl._toolbars.draw._modes[e.layerType];
    drawing = mode ? mode.handler : null;
    if (drawing) {
      const keepout = document.querySelector("input[name=drawMode]:checked")?.value !== "area"; // also «Δέντρο»
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

  // ---------- Editing ----------
  // An "Επεξεργασία" button on the map turns on handles for every area and obstacle: drag a corner,
  // click the faint dot in the middle of a side for a new corner, click a corner to remove it, click
  // a side's length to type a new length or push the side in or out.
  const shapes = () => [...areas.getLayers(), ...keepouts.getLayers()];
  let editing = false;
  let saved = null; // shape -> its points before editing, for "Ακύρωση"
  L.Edit.PolyVerticesEdit.prototype.options.icon = HANDLE;
  L.Edit.PolyVerticesEdit.prototype.options.touchIcon = HANDLE;

  const PENCIL = `<svg class="ic" viewBox="0 0 24 24"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`;
  let editButton = null;
  const EditControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const box = L.DomUtil.create("div", "leaflet-bar pv-edit-control");
      editButton = L.DomUtil.create("a", "", box);
      editButton.href = "#";
      editButton.setAttribute("role", "button");
      editButton.title = "Επεξεργασία σχημάτων: κορυφές, μήκη πλευρών";
      editButton.innerHTML = `${PENCIL}<span>Επεξεργασία</span>`;
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.on(editButton, "click", (e) => { L.DomEvent.preventDefault(e); editing ? stop(true) : start(); });
      return box;
    },
  });
  map.addControl(new EditControl());

  const bar = L.DomUtil.create("div", "pv-editbar", map.getContainer());
  bar.hidden = true;
  bar.innerHTML = `<div class="pv-editbar-text"><b>Επεξεργασία σχημάτων</b>
      <span>Σύρε μια κορυφή για να τη μετακινήσεις · κλικ στη μισοδιάφανη κουκκίδα στη μέση μιας πλευράς = νέα κορυφή ·
      κλικ σε κορυφή = αφαίρεση · κλικ στο μήκος μιας πλευράς = νέο μήκος ή μετακίνηση της πλευράς.</span></div>
    <div class="pv-editbar-actions"><button type="button" data-a="done"><svg class="ic"><use href="#i-check"/></svg>Τέλος</button>
      <button type="button" class="secondary" data-a="cancel">Ακύρωση</button></div>`;
  L.DomEvent.disableClickPropagation(bar);
  L.DomEvent.disableScrollPropagation(bar);
  bar.querySelector("[data-a=done]").onclick = () => stop(true);
  bar.querySelector("[data-a=cancel]").onclick = () => stop(false);

  function start() {
    const list = shapes();
    if (!list.length) return toast("Σχεδίασε πρώτα μια περιοχή.");
    map.closePopup();
    Object.values(drawControl._toolbars.draw._modes).forEach((m) => m.handler.disable());
    saved = new Map(list.map((l) => [l, ring(l).map((p) => L.latLng(p.lat, p.lng))]));
    editing = true;
    map.fire("draw:editstart"); // faces.js: no face box while editing
    list.forEach((l) => l.editing.enable());
    L.DomUtil.addClass(map.getContainer(), "pv-editing");
    L.DomUtil.addClass(editButton, "active");
    bar.hidden = false;
    refreshAll();
  }

  // keep = false puts every shape back as it was before editing.
  function stop(keep) {
    if (!editing) return;
    map.closePopup();
    editing = false;
    let moved = false;
    for (const l of shapes()) {
      if (l.editing.enabled()) l.editing.disable();
      const before = saved.get(l);
      if (!keep && before) {
        const now = ring(l);
        if (now.length !== before.length || now.some((p, i) => !p.equals(before[i]))) {
          l.setLatLngs([before]);
          moved = true;
        }
      }
    }
    saved = null;
    map.fire("draw:editstop");
    L.DomUtil.removeClass(map.getContainer(), "pv-editing");
    L.DomUtil.removeClass(editButton, "active");
    bar.hidden = true;
    refreshAll();
    if (moved) clearLayout();
  }

  // Any change of a shape makes the panel layout out of date.
  const changed = () => clearLayout();
  for (const g of [areas, keepouts]) g.on("layeradd", (e) => e.layer.on("edit", changed));

  // ---------- Side box: new length, push in/out, new corner ----------
  // Geometry in local metres (x east, y north) around the shape, as in meters() above.
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const mul = (a, k) => [a[0] * k, a[1] * k];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const norm = (a) => Math.hypot(a[0], a[1]);
  // Where the line p + t·d meets the line q + s·e; null when they are (almost) parallel.
  function meet(p, d, q, e) {
    const c = cross(d, e);
    if (Math.abs(c) < 1e-3 * norm(d) * norm(e)) return null;
    return add(p, mul(d, cross(sub(q, p), e) / c));
  }
  function local(pts) {
    const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const lng0 = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
    const r = radii(lat0);
    return {
      xy: pts.map((p) => [(p.lng - lng0) * r.east, (p.lat - lat0) * r.north]),
      back: ([x, y]) => L.latLng(lat0 + y / r.north, lng0 + x / r.east),
    };
  }
  // Area in m², in the same local metres as the side lengths.
  function area(pts) {
    if (pts.length < 3) return 0;
    const { xy } = local(pts);
    let twice = 0;
    for (let i = 0; i < xy.length; i++) twice += cross(xy[i], xy[(i + 1) % xy.length]);
    return Math.abs(twice) / 2;
  }
  function reshape(layer, fn) {
    const { xy, back } = local(ring(layer));
    fn(xy, xy.length);
    layer.setLatLngs([xy.map(back)]);
    changed();
  }

  // Side i (corner i -> corner i+1) gets length `len`: corner i stays, corner i+1 moves along the
  // side and the next side slides with it, keeping its direction (a rectangle stays a rectangle).
  function setLength(layer, i, len) {
    reshape(layer, (xy, n) => {
      const j = (i + 1) % n, k = (i + 2) % n;
      const A = xy[i], B = xy[j], C = xy[k], D = xy[(i + 3) % n];
      const u = mul(sub(B, A), 1 / norm(sub(B, A)));
      const B2 = add(A, mul(u, len));
      const bc = sub(C, B);
      if (Math.abs(cross(u, bc)) > 0.05 * norm(bc)) xy[k] = meet(B2, bc, C, sub(D, C)) || add(C, sub(B2, B));
      xy[j] = B2;
    });
  }

  // Side i moves parallel by `dist` m (positive = outwards); its neighbours stretch to follow it.
  function pushSide(layer, i, dist) {
    reshape(layer, (xy, n) => {
      const j = (i + 1) % n;
      const P = xy[(i - 1 + n) % n], A = xy[i], B = xy[j], C = xy[(i + 2) % n];
      const ab = sub(B, A), l = norm(ab);
      let twiceArea = 0;
      for (let q = 0; q < n; q++) twiceArea += cross(xy[q], xy[(q + 1) % n]);
      // Outward normal: right of the side for a counter-clockwise ring, left for a clockwise one.
      const out = mul([ab[1] / l, -ab[0] / l], twiceArea >= 0 ? dist : -dist);
      const A1 = add(A, out), B1 = add(B, out);
      xy[i] = meet(A1, ab, P, sub(A, P)) || A1;
      xy[j] = meet(A1, ab, C, sub(C, B)) || B1;
    });
  }

  function addCorner(layer, i) {
    const pts = ring(layer).slice(), n = pts.length;
    const a = pts[i], b = pts[(i + 1) % n];
    pts.splice(i + 1, 0, L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2));
    layer.setLatLngs([pts]);
    changed();
  }

  const marks = L.layerGroup().addTo(map); // the chosen side and its fixed corner while the box is open
  let openBox = null;
  let pushStep = 0.1;
  function sideBox(layer, i) {
    const pts = ring(layer), n = pts.length;
    const a = pts[i], b = pts[(i + 1) % n], len = meters(a, b);
    const box = L.DomUtil.create("div", "pv-side-box");
    box.innerHTML = `<b>Πλευρά ${i + 1} · ${fmt(len, 2)} m</b>
      <label>Νέο μήκος (m) <input name="len" type="number" min="0.1" step="0.01" value="${len.toFixed(2)}"></label>
      <p class="muted small">Η κορυφή με τον λευκό κύκλο μένει στη θέση της· η επόμενη πλευρά μετακινείται παράλληλα.</p>
      <label>Μετακίνηση πλευράς (m) <input name="push" type="number" min="0.01" step="0.05" value="${pushStep}"></label>
      <div class="row">
        <button type="button" data-a="out" class="secondary">Προς τα έξω</button>
        <button type="button" data-a="in" class="secondary">Προς τα μέσα</button>
      </div>
      <button type="button" data-a="corner" class="ghost">Νέα κορυφή στη μέση της πλευράς</button>`;
    const lenInput = box.querySelector("[name=len]"), push = box.querySelector("[name=push]");
    const again = () => sideBox(layer, i);
    lenInput.onchange = () => {
      const v = +lenInput.value;
      if (!(v > 0.05)) return toast("Γράψε ένα μήκος σε μέτρα, π.χ. 8,5.");
      setLength(layer, i, v);
      again();
    };
    const pushBy = (sign) => {
      pushStep = Math.abs(+push.value) || 0.1;
      pushSide(layer, i, sign * pushStep);
      again();
    };
    box.querySelector("[data-a=out]").onclick = () => pushBy(1);
    box.querySelector("[data-a=in]").onclick = () => pushBy(-1);
    box.querySelector("[data-a=corner]").onclick = () => { map.closePopup(); addCorner(layer, i); };

    // Keep the box clear of the side panel, the edit bar on top and the results dock below.
    const left = map.getContainer().querySelector(".leaflet-top.leaflet-left").offsetLeft;
    const popup = L.popup({ className: "pv-side-popup", autoPanPaddingTopLeft: [left + 20, 120], autoPanPaddingBottomRight: [70, 110] })
      .setLatLng(L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2)).setContent(box);
    popup.on("remove", () => { if (openBox === popup) { openBox = null; marks.clearLayers(); } });
    openBox = popup; // set first: opening it closes the previous box, which must not clear these marks
    popup.openOn(map);
    marks.clearLayers();
    marks.addLayer(L.polyline([a, b], { pane: "pvLabels", interactive: false, color: "#ffc53d", weight: 6, opacity: 0.55, lineCap: "round" }));
    marks.addLayer(L.circleMarker(a, { pane: "pvLabels", interactive: false, radius: 10, color: "#fff", weight: 2.5, fill: false }));
    setTimeout(() => { lenInput.focus(); lenInput.select(); }, 50);
  }

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

  // ---------- Compass ----------
  // The map is always north-up, so the rose is fixed: Β (north) on top, Α (east) right.
  const Compass = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const box = L.DomUtil.create("div", "pv-compass");
      box.title = "Βορράς πάνω";
      box.setAttribute("aria-label", "Πυξίδα: Βορράς πάνω, Νότος κάτω, Ανατολή δεξιά, Δύση αριστερά");
      box.innerHTML = `<svg viewBox="0 0 80 80" aria-hidden="true">
        <defs><linearGradient id="pvNeedle" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffc53d"/><stop offset="1" stop-color="#ff4d6d"/></linearGradient></defs>
        <circle class="ring" cx="40" cy="40" r="27"/>
        <g class="ticks">${[...Array(8)].map((_, k) => `<line x1="40" y1="${k % 2 ? 15.5 : 14}" x2="40" y2="18" transform="rotate(${k * 45} 40 40)"/>`).join("")}</g>
        <path class="north" d="M40 17 L46 40 L34 40 Z"/>
        <path class="south" d="M40 63 L46 40 L34 40 Z"/>
        <circle class="pin" cx="40" cy="40" r="2.6"/>
        <text class="n" x="40" y="7.5">Β</text><text x="40" y="73">Ν</text>
        <text x="73" y="40.5">Α</text><text x="7" y="40.5">Δ</text>
      </svg>`;
      return box;
    },
  });
  map.addControl(new Compass());

  window.drawTools = {
    meters, area, refresh, refreshAll, edgeLabel: label,
    get editing() { return editing; },
  };
})();
