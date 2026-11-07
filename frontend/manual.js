// Editing panels by hand on top of the automatic layout: add, move, turn, delete them (and, in east-west, switch
// them between the east and the west side). Every selected panel has its own round handle to turn it freely, and
// a click on a panel opens a small box for its tilt and direction (see «Ανά πάνελ» below), and check which
// placement rules they break. The panels are the polygons of panelsLayer, so shading, production, electrical
// and saving use the edited positions with no extra step. Everything works in lat/lng (metres around a local
// origin), so it is the same on a rotated map. Rules are checked by the server (POST /api/layout/check,
// backend/manual.py).
(() => {
  const SNAP_M = 0.25;     // an edge closer than this to a neighbour's edge snaps to it
  const NEAR_M = 1.5;      // only panels this close (along both directions) are snap targets
  const CLICK_PX = 3;      // less movement than this is a click, not a drag
  const STEP_M = 0.05;     // one arrow key press moves the selection this far (Shift: STEP_BIG_M)
  const STEP_BIG_M = 0.25;
  const NUDGE_MERGE_MS = 1000; // arrow presses this close together are one step for the undo
  const MAX_ROWS = 30;     // rows of the list of broken rules
  const MAX_HANDLES = 12;  // so many selected panels each show a handle; more would only clutter the map
  const ROT_SNAP = 15;     // Shift while turning: steps of this many degrees
  const REASONS = {
    outside: "Εκτός περιγράμματος", edge: "Κοντά στο περίγραμμα", ridge: "Κοντά στη γραμμή διαχωρισμού πλευρών",
    obstacle: "Κοντά σε εμπόδιο", overlap: "Επικάλυψη με άλλο πάνελ", shade: "Υπερβολική σκίαση",
  };
  const GHOST_STYLE = { color: "#facc15", weight: 2, dashArray: "5 3", fillColor: PANEL_FILL, fillOpacity: 0.55, interactive: false };

  const on = () => $("manualOn").checked;
  const layers = () => panelsLayer.getLayers();
  const selected = new Set();
  const undoStack = [];
  let seq = 0, checkTimer = null;
  let adding = false, flip = false, ghost = null, hover = null, nudging = null;
  const handleLayer = L.layerGroup().addTo(map); // the round handles of the selected panels
  let handles = [];                             // { l, marker, line }

  // ---------- Geometry: metres around a local origin ----------
  const rad = (d) => (d * Math.PI) / 180;
  const kOf = (lat0) => [111320 * Math.cos(rad(lat0)), 110540]; // metres per degree (lng, lat)
  const ringOf = (l) => l.getLatLngs()[0].map((p) => [p.lat, p.lng]);
  const centroidOf = (ring) => [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
  const toXY = (ring, o, kx, ky) => ring.map(([la, ln]) => [(ln - o[1]) * kx, (la - o[0]) * ky]);
  const fromXY = (pts, o, kx, ky) => pts.map(([x, y]) => [o[0] + y / ky, o[1] + x / kx]);
  // The frame of a panel face: u runs the way the panels look (azimuth), v across.
  const frame = (az) => ({ ux: Math.sin(rad(az)), uy: Math.cos(rad(az)), vx: Math.cos(rad(az)), vy: -Math.sin(rad(az)) });
  function extent(pts, f) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of pts) {
      const u = x * f.ux + y * f.uy, v = x * f.vx + y * f.vy;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    return { u0, u1, v0, v1 };
  }
  const rectOf = (cu, cv, depth, across, f) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => {
    const u = cu + (su * depth) / 2, v = cv + (sv * across) / 2;
    return [u * f.ux + v * f.vx, u * f.uy + v * f.vy];
  });

  // ---------- Which face a panel belongs to, and its tilt and azimuth ----------
  // state.layout.panel_face is parallel to the panels; the layers keep their face in pvFaceIdx so adding and
  // deleting (and an undo that puts a panel back at the end) cannot mix them up.
  function ensureFaces() {
    const lay = state.layout, all = layers();
    if (lay?.panel_face && lay.panel_face.length === all.length) all.forEach((l, i) => { if (l.pvFaceIdx === undefined) l.pvFaceIdx = lay.panel_face[i]; });
  }
  function planeOf(l) {
    if (l.pvPlane) return l.pvPlane; // this panel has its own tilt / direction
    const lay = state.layout || {}, set = settings();
    const f = lay.faces && l.pvFaceIdx != null ? lay.faces[l.pvFaceIdx] : null;
    return { tilt: (f ? f.tilt_deg : lay.tilt_deg ?? set.tilt_deg) || 0, az: f ? f.azimuth_deg : lay.azimuth_deg ?? set.azimuth_deg };
  }

  // The footprint turned by 90°: landscape instead of portrait, or back. A tilted panel is shorter on the map
  // than it is long (depth = length × cos tilt), so the two sides are not just swapped.
  function turned(pts, plane) {
    const f = frame(plane.az), cos = Math.max(Math.cos(rad(plane.tilt)), 0.2), e = extent(pts, f);
    return rectOf((e.u0 + e.u1) / 2, (e.v0 + e.v1) / 2, (e.v1 - e.v0) * cos, (e.u1 - e.u0) / cos, f);
  }

  // ---------- Own tilt and direction of one panel ----------
  // The panel gets its own plane: the footprint is turned to look the new way and, when the tilt changes, made as
  // deep as a panel of that tilt is on the map (length × cos tilt). The centre stays.
  function applyPlane(l, tilt, az) {
    const ring = ringOf(l), o = centroidOf(ring), [kx, ky] = kOf(o[0]), old = planeOf(l);
    const e = extent(toXY(ring, o, kx, ky), frame(old.az));
    const cosOld = Math.max(Math.cos(rad(old.tilt)), 0.2), cosNew = Math.max(Math.cos(rad(tilt)), 0.2);
    const along = (e.u1 - e.u0) / cosOld, across = e.v1 - e.v0;
    az = ((az % 360) + 360) % 360;
    l.setLatLngs([fromXY(rectOf(0, 0, along * cosNew, across, frame(az)), o, kx, ky)]);
    l.pvPlane = { tilt, az };
  }
  const planeKey = (p) => `${Math.round(p.tilt)}|${Math.round(((p.az % 360) + 360) % 360) % 360}`;

  // Panels with an own plane become faces of their own (one per tilt and direction) after the faces of the layout,
  // so shading, production, the strings and the 3D view treat them like any other face. lay.custom_from is the first
  // such face; lay.synth_faces says that the layout had no faces before (face 0 is then its single plane).
  function rebuildFaces() {
    const lay = state.layout, all = layers(), w = +$("panelPower").value || 0;
    const customs = all.filter((l) => l.pvPlane);
    if (!customs.length && lay.custom_from == null) return;
    const first = lay.custom_from ?? (lay.faces ? lay.faces.length : 1);
    let base = lay.faces ? lay.faces.slice(0, first) : null;
    if (!base) {
      const set = settings();
      base = [{ tilt_deg: lay.tilt_deg ?? set.tilt_deg, azimuth_deg: lay.azimuth_deg ?? set.azimuth_deg, row_gap_m: lay.row_gap_m }];
      lay.synth_faces = true;
    }
    if (!customs.length) { // the last own plane is gone: back to the faces the layout had
      if (lay.synth_faces) { delete lay.faces; delete lay.panel_face; delete lay.synth_faces; } else lay.faces = base;
      delete lay.custom_from;
      return;
    }
    const keys = [], extra = [];
    customs.forEach((l) => {
      const k = planeKey(l.pvPlane);
      if (!keys.includes(k)) {
        keys.push(k);
        extra.push({ tilt_deg: Math.round(l.pvPlane.tilt), azimuth_deg: Math.round(l.pvPlane.az) % 360, row_gap_m: base[0].row_gap_m });
      }
      l.pvFaceIdx = first + keys.indexOf(k);
    });
    all.forEach((l) => { if (!l.pvPlane) l.pvFaceIdx = l.pvFaceIdx != null && l.pvFaceIdx < first ? l.pvFaceIdx : 0; });
    lay.faces = base.concat(extra);
    lay.custom_from = first;
    lay.panel_face = all.map((l) => l.pvFaceIdx);
    lay.faces.forEach((f, i) => { f.count = lay.panel_face.filter((x) => x === i).length; f.kwp = Math.round(f.count * w) / 1000; });
  }

  // ---------- Snapping to the neighbours ----------
  const gaps = () => {
    const col = +$("colGap").value || 0;
    return { col, row: typeof state.layout?.row_gap_m === "number" ? state.layout.row_gap_m : col };
  };
  // How far (metres, east / north) a panel at ringXY must move for its edges to meet those of the panels
  // around it: edge on edge, or one gap apart (the gap between columns or rows of the settings).
  function snapShift(ringXY, othersXY, az) {
    const f = frame(az), g = extent(ringXY, f), gap = gaps();
    const close = (a0, a1, b0, b1) => Math.max(a0 - b1, b0 - a1) <= NEAR_M;
    let bu = null, bv = null;
    const better = (d, best) => (Math.abs(d) <= SNAP_M && (best === null || Math.abs(d) < Math.abs(best)) ? d : best);
    for (const o of othersXY) {
      const e = extent(o, f);
      if (!close(g.u0, g.u1, e.u0, e.u1) || !close(g.v0, g.v1, e.v0, e.v1)) continue;
      for (const d of [e.u0 - g.u0, e.u1 - g.u1, e.u1 + gap.row - g.u0, e.u0 - gap.row - g.u1]) bu = better(d, bu);
      for (const d of [e.v0 - g.v0, e.v1 - g.v1, e.v1 + gap.col - g.v0, e.v0 - gap.col - g.v1]) bv = better(d, bv);
    }
    bu ??= 0; bv ??= 0;
    return [bu * f.ux + bv * f.vx, bu * f.uy + bv * f.vy];
  }

  // ---------- Selection ----------
  function restyle(l) {
    const sel = selected.has(l), bad = !!l.pvBad;
    l.setStyle({
      color: bad ? "#ef4444" : sel ? "#facc15" : PANEL_STYLE.color,
      weight: bad ? 3 : sel ? 2.4 : PANEL_STYLE.weight,
      opacity: bad || sel ? 1 : PANEL_STYLE.opacity,
      dashArray: bad && sel ? "5 3" : null,
    });
    if (bad || sel) l.bringToFront();
  }
  const restyleAll = () => layers().forEach(restyle);

  function select(list, add) {
    if (!add) selected.clear();
    list.forEach((l) => selected.add(l));
    restyleAll();
    updateUi();
  }

  function updateUi() {
    const n = selected.size;
    $("manualDel").disabled = $("manualRot").disabled = $("manualFlip").disabled = !n;
    const ew = isEwLayout();
    $("manualEw").hidden = !ew;
    $("manualUndo").disabled = !undoStack.length;
    $("manualAdd").classList.toggle("active", adding);
    $("manualAdd").textContent = adding ? "✓ Τέλος προσθήκης" : "＋ Προσθήκη πάνελ";
    updateHandles();
    $("manualStatus").textContent = adding
      ? "Κάνε κλικ στον χάρτη όπου θέλεις πάνελ· όσα θέλεις. R = γύρισέ το στο πλάι, Esc = τέλος."
      : ew
        ? `Πάνελ: ${layers().length} · ανατολή ${layers().filter((l) => !l.pvFaceIdx).length} · δύση ${layers().filter((l) => l.pvFaceIdx === 1).length} · επιλεγμένα: ${n}`
        : `Πάνελ: ${layers().length} · επιλεγμένα: ${n}`;
  }

  // ---------- State that follows the panels ----------
  // A layout may not exist yet (panels are added to an empty map): then a minimal one is made from the area.
  function ensureLayout() {
    if (state.layout) return;
    const area = areas.getLayers()[0];
    const c = area.getBounds().getCenter();
    const [kx, ky] = kOf(c.lat), pts = toXY(ringOf(area), [c.lat, c.lng], kx, ky);
    const m2 = Math.abs(pts.reduce((a, p, i) => a + (p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1]), 0)) / 2;
    state.layout = { count: 0, kwp: 0, area_m2: Math.round(m2 * 10) / 10, module_area_m2: 0, row_gap_m: null, center: [c.lat, c.lng] };
  }

  function syncState() {
    ensureLayout();
    const lay = state.layout, all = layers(), w = +$("panelPower").value || 0;
    lay.count = all.length;
    lay.kwp = Math.round(all.length * w) / 1000;
    lay.module_area_m2 = Math.round(all.length * (+$("panelWidth").value || 0) * (+$("panelLength").value || 0) * 10) / 10;
    rebuildFaces();
    if (lay.panel_face && lay.faces) {
      lay.panel_face = all.map((l) => l.pvFaceIdx ?? 0);
      lay.faces.forEach((f, i) => { f.count = lay.panel_face.filter((x) => x === i).length; f.kwp = Math.round(f.count * w) / 1000; });
    }
  }

  // Positions or panels changed: results that depend on them are out of date, the rules are checked again.
  function afterChange() {
    [...selected].forEach((l) => { if (!panelsLayer.hasLayer(l)) selected.delete(l); });
    const stale = !!(state.shading || state.energy);
    syncState();
    state.layout = { ...state.layout, manual: true };
    clearShading();
    window.elec?.reset();
    renderResults();
    restyleAll();
    updateUi();
    if (stale) toast("Η διάταξη άλλαξε· ξαναϋπολόγισε σκιάσεις, ηλεκτρολογικά και παραγωγή όταν τελειώσεις.", 4000);
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => runCheck(false).catch(() => {}), 250);
  }

  function push(undoFn) {
    undoStack.push(undoFn);
    if (undoStack.length > 30) undoStack.shift();
  }

  function undo() {
    const last = undoStack.pop();
    if (!last) return;
    nudging = null;
    last();
    afterChange();
  }

  // ---------- Dragging ----------
  let drag = null;

  function onDown(e) {
    if (!on() || adding || e.button !== 0) return;
    const path = e.target.closest?.("path");
    const hit = path && layers().find((l) => l.getElement?.() === path);
    if (!hit) return;
    e.stopPropagation(); // the map must not pan
    e.preventDefault();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) { if (selected.has(hit)) selected.delete(hit); else selected.add(hit); restyleAll(); updateUi(); }
    else if (!selected.has(hit)) select([hit]);
    if (!selected.has(hit)) return; // it was just taken out of the selection: nothing to drag
    ensureFaces();
    const moving = [...selected];
    const start = map.mouseEventToLatLng(e), o = [start.lat, start.lng];
    const [kx, ky] = kOf(start.lat);
    drag = {
      hit, additive, moving, start, x0: e.clientX, y0: e.clientY, moved: false, kx, ky, az: planeOf(hit).az,
      orig: moving.map(ringOf),
      // the panels that stay, in metres around the start point (for the snap)
      others: layers().filter((l) => !selected.has(l)).map((l) => toXY(ringOf(l), o, kx, ky)),
    };
    drag.origXY = drag.orig.map((r) => toXY(r, o, kx, ky));
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function onMove(e) {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < CLICK_PX) return;
      drag.moved = true;
      document.body.classList.add("manual-dragging");
    }
    const cur = map.mouseEventToLatLng(e);
    let dx = (cur.lng - drag.start.lng) * drag.kx, dy = (cur.lat - drag.start.lat) * drag.ky;
    if ($("manualSnap").checked && drag.others.length) {
      // the panel that was grabbed, moved by the mouse, against the panels that stay
      const ring = drag.origXY[drag.moving.indexOf(drag.hit)].map(([x, y]) => [x + dx, y + dy]);
      const [sx, sy] = snapShift(ring, drag.others, drag.az);
      dx += sx; dy += sy;
    }
    drag.moving.forEach((l, i) => l.setLatLngs([drag.orig[i].map(([lat, lng]) => [lat + dy / drag.ky, lng + dx / drag.kx])]));
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("manual-dragging");
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.moved) { // a click: without Shift/Ctrl it selects just this panel and opens its box (tilt, direction, delete)
      if (!d.additive) { select([d.hit]); openEditor(d.hit); }
      return;
    }
    nudging = null;
    push(() => d.moving.forEach((l, i) => l.setLatLngs([d.orig[i]])));
    afterChange();
  }

  // ---------- Adding panels ----------
  function nearestPanel(lat, lng) {
    const [kx, ky] = kOf(lat);
    let best = null, bd = Infinity;
    for (const l of layers()) {
      const c = centroidOf(ringOf(l)), d = Math.hypot((c[1] - lng) * kx, (c[0] - lat) * ky);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }

  // A new panel copies the panel nearest to it (same size, direction and roof face), so a panel put at the end
  // of a row or on another face matches its neighbours. Without any panel it is made from the settings.
  function proposal(lat, lng) {
    const near = nearestPanel(lat, lng);
    let base;
    if (near) {
      const ring = ringOf(near), o = centroidOf(ring), [kx, ky] = kOf(o[0]);
      base = { pts: toXY(ring, o, kx, ky), plane: planeOf(near), face: near.pvFaceIdx ?? null, custom: !!near.pvPlane };
    } else {
      const s = settings(), lay = state.layout, f0 = lay?.faces?.[0];
      const plane = f0 ? { tilt: f0.tilt_deg, az: f0.azimuth_deg } : { tilt: s.tilt_deg, az: s.azimuth_deg };
      const [across, along] = s.orientation === "landscape" ? [s.panel_length_m, s.panel_width_m] : [s.panel_width_m, s.panel_length_m];
      base = { pts: rectOf(0, 0, along * Math.cos(rad(plane.tilt)), across, frame(plane.az)), plane, face: f0 ? 0 : null };
    }
    if (flip) base.pts = turned(base.pts, base.plane);
    // East-west: the user may choose the side of the new panel instead of taking the neighbour's.
    const side = $("manualSide").value;
    if (isEwLayout() && side !== "auto") base.face = +side;
    return base;
  }

  // Where a panel put with its centre at latlng ends up (after the snap) and which face it gets.
  function placement(latlng) {
    const p = proposal(latlng.lat, latlng.lng), o = [latlng.lat, latlng.lng], [kx, ky] = kOf(latlng.lat);
    let pts = p.pts;
    if ($("manualSnap").checked) {
      const [sx, sy] = snapShift(pts, layers().map((l) => toXY(ringOf(l), o, kx, ky)), p.plane.az);
      pts = pts.map(([x, y]) => [x + sx, y + sy]);
    }
    return { ring: fromXY(pts, o, kx, ky), face: p.face, plane: p.custom ? p.plane : null };
  }

  const removeGhost = () => { hover = null; if (ghost) { ghost.remove(); ghost = null; } };
  function showGhost(latlng) {
    hover = latlng;
    const { ring, face } = placement(latlng);
    const fillColor = isEwLayout() && face === 1 ? PANEL_FILL_WEST : PANEL_FILL;
    if (!ghost) ghost = L.polygon(ring, { ...GHOST_STYLE, fillColor }).addTo(map);
    else { ghost.setLatLngs([ring]); ghost.setStyle({ fillColor }); }
  }

  function place(latlng) {
    ensureLayout();
    ensureFaces();
    const { ring, face, plane } = placement(latlng);
    const layer = addPanel(ring);
    if (face != null) layer.pvFaceIdx = face;
    if (plane) layer.pvPlane = { ...plane }; // next to a panel with its own tilt / direction: the same
    nudging = null;
    push(() => { panelsLayer.removeLayer(layer); selected.delete(layer); });
    select([layer]);
    afterChange();
  }

  function setAdding(v) {
    if (v && !areas.getLayers().length) { toast("Σχεδίασε πρώτα μια περιοχή στον χάρτη.", 4000); return; }
    adding = v;
    flip = false;
    document.body.classList.toggle("manual-adding", v);
    if (v && !on()) { $("manualOn").checked = true; $("manualOn").onchange(); }
    if (!v) removeGhost();
    updateUi();
  }

  // ---------- Deleting, turning, nudging the selection ----------
  function removeSelected() {
    const gone = [...selected];
    if (!gone.length) return;
    ensureFaces();
    gone.forEach((l) => panelsLayer.removeLayer(l));
    selected.clear();
    nudging = null;
    push(() => gone.forEach((l) => panelsLayer.addLayer(l)));
    afterChange();
  }

  // East-west: the selected panels switch sides (the footprint stays, the panel now leans the other way).
  function flipSelected() {
    const list = [...selected];
    if (!list.length) return;
    if (!isEwLayout()) { toast("Η αλλαγή πλευράς είναι για διάταξη ανατολή-δύση.", 4000); return; }
    ensureFaces();
    const before = list.map((l) => [l.pvFaceIdx ?? 0, l.pvPlane ? { ...l.pvPlane } : null, ringOf(l)]);
    list.forEach((l) => {
      if (l.pvPlane) applyPlane(l, l.pvPlane.tilt, l.pvPlane.az + 180); // an own plane: turned half way round
      else l.pvFaceIdx = 1 - (l.pvFaceIdx ?? 0);
    });
    nudging = null;
    push(() => list.forEach((l, i) => { l.pvFaceIdx = before[i][0]; l.pvPlane = before[i][1] || undefined; l.setLatLngs([before[i][2]]); }));
    afterChange();
  }

  function rotateSelected() {
    const list = [...selected];
    if (!list.length) return;
    ensureFaces();
    const before = list.map(ringOf);
    list.forEach((l) => {
      const ring = ringOf(l), o = centroidOf(ring), [kx, ky] = kOf(o[0]);
      l.setLatLngs([fromXY(turned(toXY(ring, o, kx, ky), planeOf(l)), o, kx, ky)]);
    });
    nudging = null;
    push(() => list.forEach((l, i) => l.setLatLngs([before[i]])));
    afterChange();
  }

  // The directions of the screen (right and up) as unit vectors east/north: the arrows follow the screen, also
  // on a rotated map.
  function screenAxes() {
    const c = map.getSize().divideBy(2), a = map.containerPointToLatLng(c), [kx, ky] = kOf(a.lat);
    const unit = (p) => { const x = (p.lng - a.lng) * kx, y = (p.lat - a.lat) * ky, n = Math.hypot(x, y) || 1; return [x / n, y / n]; };
    return { right: unit(map.containerPointToLatLng(c.add([50, 0]))), up: unit(map.containerPointToLatLng(c.add([0, -50]))) };
  }

  function nudge(right, up, big) {
    const list = [...selected];
    if (!list.length) return;
    const ax = screenAxes(), step = big ? STEP_BIG_M : STEP_M;
    const mx = (ax.right[0] * right + ax.up[0] * up) * step, my = (ax.right[1] * right + ax.up[1] * up) * step;
    const merge = nudging && Date.now() - nudging.t < NUDGE_MERGE_MS && nudging.list.length === list.length && list.every((l) => nudging.list.includes(l));
    if (!merge) {
      const before = list.map(ringOf);
      nudging = { list, t: 0 };
      push(() => list.forEach((l, i) => l.setLatLngs([before[i]])));
    }
    nudging.t = Date.now();
    list.forEach((l) => {
      const ring = ringOf(l), [kx, ky] = kOf(ring[0][0]);
      l.setLatLngs([ring.map(([lat, lng]) => [lat + my / ky, lng + mx / kx])]);
    });
    const keep = nudging; // afterChange keeps the merge window open
    afterChange();
    nudging = keep;
  }

  // ---------- A round handle on every selected panel: turn it freely ----------
  // The handle sits in front of the panel (the way it looks); dragging it points the panel at the pointer.
  const mPerPx = (lat) => (40075016.686 * Math.cos(rad(lat))) / (256 * 2 ** map.getZoom());
  function handleSpot(l) {
    const ring = ringOf(l), c = centroidOf(ring), plane = planeOf(l), [kx, ky] = kOf(c[0]);
    const e = extent(toXY(ring, c, kx, ky), frame(plane.az));
    const half = (e.u1 - e.u0) / 2, dir = [Math.sin(rad(plane.az)), Math.cos(rad(plane.az))];
    const at = (d) => [c[0] + (dir[1] * d) / ky, c[1] + (dir[0] * d) / kx];
    return { from: at(half), to: at(half + Math.max(24 * mPerPx(c[0]), 0.4)) };
  }
  function layoutHandle(h) {
    const s = handleSpot(h.l);
    h.line.setLatLngs([s.from, s.to]);
    h.marker.setLatLng(s.to);
  }
  function updateHandles() {
    handleLayer.clearLayers();
    handles = [];
    if (!on() || adding || drag || !selected.size || selected.size > MAX_HANDLES || window.faces?.active()) return;
    selected.forEach((l) => {
      if (!panelsLayer.hasLayer(l)) return;
      const line = L.polyline([[0, 0], [0, 0]], { color: "#ff8a3d", weight: 2, interactive: false }).addTo(handleLayer);
      const marker = L.marker([0, 0], { icon: L.divIcon({ className: "pv-rot", iconSize: [20, 20] }), keyboard: false, title: "Γύρισέ το" }).addTo(handleLayer);
      const h = { l, line, marker };
      marker.on("mousedown", (ev) => startTurn(h, ev.originalEvent));
      layoutHandle(h);
      handles.push(h);
    });
  }
  map.on("zoomend rotate", () => handles.forEach(layoutHandle));

  let turn = null;
  function startTurn(h, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    map.dragging.disable();
    ensureFaces();
    const ring = ringOf(h.l), plane = planeOf(h.l);
    turn = { h, c: map.latLngToContainerPoint(centroidOf(ring)), before: ring, plane: { ...plane }, own: h.l.pvPlane ? { ...h.l.pvPlane } : null, moved: false };
    h.marker.bindTooltip(`${Math.round(plane.az)}°`, { permanent: true, direction: "top", offset: [0, -12] }).openTooltip();
    document.addEventListener("mousemove", onTurn);
    document.addEventListener("mouseup", endTurn);
  }
  function onTurn(e) {
    if (!turn) return;
    const p = map.mouseEventToContainerPoint(e);
    let az = (Math.atan2(p.x - turn.c.x, -(p.y - turn.c.y)) * 180) / Math.PI - (map.getBearing ? map.getBearing() : 0);
    if (e.shiftKey) az = Math.round(az / ROT_SNAP) * ROT_SNAP;
    az = ((az % 360) + 360) % 360;
    turn.moved = true;
    applyPlane(turn.h.l, turn.plane.tilt, az);
    layoutHandle(turn.h);
    turn.h.marker.setTooltipContent(`${Math.round(az)}°`);
  }
  function endTurn() {
    document.removeEventListener("mousemove", onTurn);
    document.removeEventListener("mouseup", endTurn);
    map.dragging.enable();
    const t = turn;
    turn = null;
    if (!t) return;
    t.h.marker.unbindTooltip();
    if (!t.moved) return;
    nudging = null;
    push(() => { t.h.l.pvPlane = t.own || undefined; t.h.l.setLatLngs([t.before]); });
    afterChange();
  }

  // ---------- A click on a panel: its tilt and direction, or delete ----------
  let editorPopup = null;
  function openEditor(l) {
    closeEditor();
    if (window.faces?.active()) return; // on a roof with faces the tilt and direction belong to the face
    const plane = planeOf(l), n = layers().indexOf(l) + 1;
    const box = document.createElement("div");
    box.className = "pv-panel-edit";
    box.innerHTML = `<b>Πάνελ #${n}</b>
      <label>Κλίση ως προς το έδαφος (°) <input class="pv-tilt" type="number" min="0" max="90" step="1" value="${Math.round(plane.tilt * 10) / 10}"></label>
      <label>Κατεύθυνση (°) <input class="pv-az" type="number" min="0" max="360" step="1" value="${Math.round(plane.az * 10) / 10}"></label>
      <small>Κατεύθυνση: 0 = Βορράς, 90 = Ανατολή, 180 = Νότος, 270 = Δύση.</small>
      <div class="pv-edit-btns"><button type="button" class="pv-apply">Εφαρμογή</button><button type="button" class="pv-del secondary">Διαγραφή πάνελ</button></div>`;
    const apply = () => {
      const tilt = parseFloat(box.querySelector(".pv-tilt").value), az = parseFloat(box.querySelector(".pv-az").value);
      if (!(tilt >= 0 && tilt <= 90) || !(az >= 0 && az <= 360)) { toast("Η κλίση είναι από 0 έως 90° και η κατεύθυνση από 0 έως 360°.", 5000); return; }
      const list = selected.size ? [...selected] : [l];
      ensureFaces();
      const before = list.map((x) => [x, x.pvPlane ? { ...x.pvPlane } : null, ringOf(x)]);
      list.forEach((x) => applyPlane(x, tilt, az));
      nudging = null;
      push(() => before.forEach(([x, pl, ring]) => { x.pvPlane = pl || undefined; x.setLatLngs([ring]); }));
      closeEditor();
      afterChange();
    };
    box.querySelector(".pv-apply").onclick = apply;
    box.querySelector(".pv-del").onclick = () => { closeEditor(); if (!selected.has(l)) select([l]); removeSelected(); };
    box.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } if (e.key === "Escape") closeEditor(); });
    editorPopup = L.popup({ closeButton: true, autoClose: true, closeOnClick: false, className: "pv-edit-pop", offset: [0, -4] })
      .setLatLng(centroidOf(ringOf(l))).setContent(box).openOn(map);
  }
  function closeEditor() { if (editorPopup) { map.closePopup(editorPopup); editorPopup = null; } }

  // ---------- Right click on a panel deletes it; Ctrl + drag on empty ground selects the panels inside ----------
  function onContext(e) {
    if (!on() || adding) return;
    const path = e.target.closest?.("path");
    const hit = path && layers().find((l) => l.getElement?.() === path);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    if (!selected.has(hit)) select([hit]);
    removeSelected();
  }
  let marquee = null;
  function onMarqueeDown(e) {
    if (!on() || adding || e.button !== 0 || !(e.ctrlKey || e.metaKey) || e.target.closest?.(".leaflet-marker-icon, .leaflet-popup")) return;
    const path = e.target.closest?.("path");
    if (path && layers().some((l) => l.getElement?.() === path)) return; // on a panel: Ctrl+click adds it to the selection
    e.stopPropagation();
    e.preventDefault();
    map.dragging.disable();
    const box = document.createElement("div");
    box.className = "pv-marquee";
    map.getContainer().appendChild(box);
    const r = map.getContainer().getBoundingClientRect();
    marquee = { box, x0: e.clientX - r.left, y0: e.clientY - r.top, add: e.shiftKey };
    document.addEventListener("mousemove", onMarqueeMove);
    document.addEventListener("mouseup", onMarqueeUp);
  }
  const marqueeRect = (e, m) => {
    const r = map.getContainer().getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    return { x0: Math.min(m.x0, x), y0: Math.min(m.y0, y), x1: Math.max(m.x0, x), y1: Math.max(m.y0, y) };
  };
  function onMarqueeMove(e) {
    if (!marquee) return;
    const q = marqueeRect(e, marquee);
    Object.assign(marquee.box.style, { left: `${q.x0}px`, top: `${q.y0}px`, width: `${q.x1 - q.x0}px`, height: `${q.y1 - q.y0}px` });
  }
  function onMarqueeUp(e) {
    document.removeEventListener("mousemove", onMarqueeMove);
    document.removeEventListener("mouseup", onMarqueeUp);
    map.dragging.enable();
    const m = marquee;
    marquee = null;
    if (!m) return;
    const q = marqueeRect(e, m);
    m.box.remove();
    const inside = layers().filter((l) => {
      const p = map.latLngToContainerPoint(centroidOf(ringOf(l)));
      return p.x >= q.x0 && p.x <= q.x1 && p.y >= q.y0 && p.y <= q.y1;
    });
    select(inside, m.add);
    if (inside.length) toast(`Επιλέχθηκαν ${inside.length} πάνελ. Πάτα Delete για διαγραφή.`, 4000);
  }

  // ---------- Checking the rules ----------
  function request(withShade) {
    const s = settings();
    const obstacles = obstaclesWithHeights();
    return {
      panels: layers().map(latlngsOf),
      areas: areas.getLayers().map(latlngsOf),
      use_ridge: !!window.faces?.active(),
      keepouts: keepouts.getLayers().map(latlngsOf),
      setback_m: s.setback_m, ridge_gap_m: s.ridge_gap_m, obstacle_gap_m: s.obstacle_gap_m,
      check_shade: withShade, max_shade_pct: +$("maxShade").value || 0, obstacles,
      tilt_deg: s.tilt_deg, azimuth_deg: s.azimuth_deg, mounting: s.mounting,
      ...(window.faces?.shadingFaces() || {}),
    };
  }

  async function runCheck(withShade) {
    if (!layers().length || !areas.getLayers().length) { clearMarks(); return; }
    const mine = ++seq;
    const res = await api("/api/layout/check", "POST", request(withShade));
    if (mine !== seq) return; // a newer check has been started
    const bad = new Map(res.violations.map((v) => [v.index, v.reasons]));
    layers().forEach((l, i) => { l.pvBad = bad.get(i) || null; });
    restyleAll();
    syncFaces(res.area_of);
    render(res);
  }

  // On a roof with faces a panel moved onto another face belongs to that face now (its counts and kWp).
  function syncFaces(areaOf) {
    const l = state.layout;
    if (!window.faces?.active() || !l || !l.panel_face || l.panel_face.length !== areaOf.length) return;
    const next = l.panel_face.map((f, i) => (areaOf[i] >= 0 ? areaOf[i] : f));
    if (next.every((f, i) => f === l.panel_face[i])) return;
    l.panel_face = next;
    layers().forEach((p, i) => { p.pvFaceIdx = next[i]; });
    const w = +$("panelPower").value;
    l.faces.forEach((f, i) => { f.count = next.filter((x) => x === i).length; f.kwp = Math.round(f.count * w) / 1000; });
  }

  function clearMarks() {
    layers().forEach((l) => { l.pvBad = null; });
    restyleAll();
    $("manualList").innerHTML = "";
  }

  function render(res) {
    const box = $("manualList");
    if (!res.count_bad) {
      box.innerHTML = `<p class="ok">Κανένα πάνελ δεν παραβιάζει περιορισμούς.</p>`;
      return;
    }
    const all = layers();
    const reasonLine = (code, n) => `<li><button type="button" data-reason="${code}"><b>${n}</b><span>${REASONS[code]}</span></button></li>`;
    const rows = res.violations.slice(0, MAX_ROWS).map((v) =>
      `<li><button type="button" data-panel="${v.index}"><b>#${v.index + 1}</b><span>${v.reasons.map((r) => `<span>${REASONS[r]}</span>`).join(", ")}</span></button></li>`).join("");
    const more = res.violations.length > MAX_ROWS ? `<p class="more">… ${res.violations.length - MAX_ROWS} ακόμα</p>` : "";
    box.innerHTML = `<p class="bad">Πάνελ που παραβιάζουν περιορισμούς: ${res.count_bad}</p>
      <ul>${Object.entries(res.by_reason).map(([c, n]) => reasonLine(c, n)).join("")}</ul><hr><ul>${rows}</ul>${more}`;
    box.querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        const idx = b.dataset.panel != null ? [+b.dataset.panel]
          : res.violations.filter((v) => v.reasons.includes(b.dataset.reason)).map((v) => v.index);
        select(idx.map((i) => all[i]).filter(Boolean));
        if (idx.length) map.panTo(all[idx[0]].getBounds().getCenter());
      };
    });
  }

  // ---------- Hooks for app.js ----------
  window.manual = {
    // A new layout replaced the panels, or a project was loaded.
    reset() {
      closeEditor(); selected.clear(); undoStack.length = 0; drag = null; nudging = null;
      setAdding(false);
      $("manualList").innerHTML = "";
      updateUi();
    },
    loaded() {
      this.reset();
      if (state.layout?.manual) runCheck(false).catch(() => {});
    },
    // True when it is fine to replace the panels with a new automatic layout.
    confirmReplace: () => !state.layout?.manual || confirm("Έχεις επεξεργαστεί πάνελ με το χέρι. Η νέα τοποθέτηση θα τα αντικαταστήσει. Να συνεχίσω;"),
  };

  // ---------- Wiring ----------
  map.getContainer().addEventListener("mousedown", onDown, true);
  map.getContainer().addEventListener("mousedown", onMarqueeDown, true);
  map.getContainer().addEventListener("contextmenu", onContext, true);
  $("manualOn").onchange = () => {
    document.body.classList.toggle("manual-moving", on());
    if (on() && !adding && !layers().length) toast("Κάνε πρώτα τοποθέτηση πάνελ, ή πάτα «Προσθήκη πάνελ» για να βάλεις μόνος σου.", 4000);
    if (!on()) { setAdding(false); closeEditor(); select([]); }
  };
  map.on("click", () => { if (on() && !drag && !adding) { closeEditor(); select([]); } });
  // Adding listens to the plain DOM click: a click on the drawn area or on a panel never reaches the map
  // otherwise. A press that moved (the map was dragged) is not a click.
  let press = null;
  map.getContainer().addEventListener("mousedown", (e) => { press = [e.clientX, e.clientY]; }, true);
  map.getContainer().addEventListener("click", (e) => {
    if (!adding || e.button !== 0 || !(e.target === map.getContainer() || e.target.closest?.(".leaflet-pane")) || e.target.closest?.(".leaflet-popup, button, a")) return;
    if (press && Math.hypot(e.clientX - press[0], e.clientY - press[1]) > CLICK_PX) return;
    e.stopPropagation();
    place(map.mouseEventToLatLng(e));
  }, true);
  map.on("mousemove", (e) => { if (adding) showGhost(e.latlng); });
  map.getContainer().addEventListener("mouseleave", removeGhost);
  $("manualAdd").onclick = () => setAdding(!adding);
  $("manualDel").onclick = removeSelected;
  $("manualRot").onclick = rotateSelected;
  $("manualFlip").onclick = flipSelected;
  $("manualSide").onchange = () => { if (hover) showGhost(hover); };
  $("manualAll").onclick = () => select(layers());
  $("manualNone").onclick = () => select([]);
  $("manualUndo").onclick = undo;
  $("manualCheck").onclick = () => withBusy($("manualCheck"), () => runCheck(true));

  // Keys work while the editing is on, unless a field is being typed in.
  document.addEventListener("keydown", (e) => {
    if (!on() || e.target.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable]")) return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (key === "z") { e.preventDefault(); undo(); }
      return;
    }
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, 1], arrowdown: [0, -1] };
    if (arrows[key] && selected.size) { e.preventDefault(); nudge(...arrows[key], e.shiftKey); }
    else if (key === "delete" || key === "backspace") { if (selected.size) { e.preventDefault(); removeSelected(); } }
    else if (key === "f") flipSelected();
    else if (key === "r") {
      if (adding) { flip = !flip; if (hover) showGhost(hover); }
      else rotateSelected();
    } else if (key === "escape") { closeEditor(); if (adding) setAdding(false); else select([]); }
  });
  panelsLayer.on("layeradd layerremove", () => requestAnimationFrame(updateUi)); // the count follows any layout, load or edit
  updateUi();
})();
