// Moving panels by hand on top of the automatic layout, and checking which placement rules they break.
// The panels are the polygons of panelsLayer, so shading, production, electrical and saving use the moved
// positions with no extra step. Dragging works in lat/lng, so it is the same on a rotated map.
// Rules are checked by the server (POST /api/layout/check, backend/manual.py).
(() => {
  const SNAP_M = 0.3;      // corners closer than this snap together
  const CLICK_PX = 3;      // less movement than this is a click, not a drag
  const MAX_ROWS = 30;     // rows of the list of broken rules
  const REASONS = {
    outside: "Εκτός περιγράμματος", edge: "Κοντά στο περίγραμμα", ridge: "Κοντά στη γραμμή διαχωρισμού πλευρών",
    obstacle: "Κοντά σε εμπόδιο", overlap: "Επικάλυψη με άλλο πάνελ", shade: "Υπερβολική σκίαση",
  };

  const on = () => $("manualOn").checked;
  const layers = () => panelsLayer.getLayers();
  const selected = new Set();
  const undoStack = [];
  let seq = 0, checkTimer = null;

  // ---------- Look: selection (yellow), broken rules (red) ----------
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
  }

  // ---------- Dragging ----------
  const toM = (lat0) => [111320 * Math.cos((lat0 * Math.PI) / 180), 110540]; // metres per degree (lng, lat)
  let drag = null;

  function onDown(e) {
    if (!on() || e.button !== 0) return;
    const path = e.target.closest?.("path");
    const hit = path && layers().find((l) => l.getElement?.() === path);
    if (!hit) return;
    e.stopPropagation(); // the map must not pan
    e.preventDefault();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) { if (selected.has(hit)) selected.delete(hit); else selected.add(hit); restyleAll(); }
    else if (!selected.has(hit)) select([hit]);
    if (!selected.has(hit)) return; // it was just taken out of the selection: nothing to drag
    const moving = [...selected];
    const start = map.mouseEventToLatLng(e);
    const still = layers().filter((l) => !selected.has(l));
    const [kx, ky] = toM(start.lat);
    drag = {
      hit, additive, moving, start, x0: e.clientX, y0: e.clientY, moved: false, kx, ky,
      orig: moving.map((l) => l.getLatLngs()[0].map((p) => [p.lat, p.lng])),
      // corners of the panels that stay, in metres around the start point (for the snap)
      corners: still.flatMap((l) => l.getLatLngs()[0].map((p) => [(p.lng - start.lng) * kx, (p.lat - start.lat) * ky])),
    };
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
    let dlat = cur.lat - drag.start.lat, dlng = cur.lng - drag.start.lng;
    if ($("manualSnap").checked && drag.corners.length) {
      // the corners of the panel that was grabbed, moved by the mouse, against the corners that stay
      const idx = drag.moving.indexOf(drag.hit);
      let best = null;
      for (const [lat, lng] of drag.orig[idx]) {
        const mx = (lng + dlng - drag.start.lng) * drag.kx, my = (lat + dlat - drag.start.lat) * drag.ky;
        for (const [cx, cy] of drag.corners) {
          const d = Math.hypot(cx - mx, cy - my);
          if (d < SNAP_M && (!best || d < best.d)) best = { d, ax: cx - mx, ay: cy - my };
        }
      }
      if (best) { dlng += best.ax / drag.kx; dlat += best.ay / drag.ky; }
    }
    drag.moving.forEach((l, i) => l.setLatLngs([drag.orig[i].map(([lat, lng]) => [lat + dlat, lng + dlng])]));
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("manual-dragging");
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.moved) { // a click: without Shift/Ctrl it selects just this panel
      if (!d.additive) select([d.hit]);
      return;
    }
    undoStack.push(d.moving.map((l, i) => [l, d.orig[i]]));
    if (undoStack.length > 30) undoStack.shift();
    afterChange();
  }

  // Positions changed: results that depend on them are out of date, the rules are checked again.
  function afterChange() {
    $("manualUndo").disabled = !undoStack.length;
    state.layout = { ...(state.layout || {}), manual: true };
    clearShading();
    toast("Η διάταξη άλλαξε· ξαναϋπολόγισε σκιάσεις και παραγωγή όταν τελειώσεις.", 4000);
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => runCheck(false).catch(() => {}), 250);
  }

  function undo() {
    const last = undoStack.pop();
    if (!last) return;
    last.forEach(([l, pts]) => l.setLatLngs([pts]));
    afterChange();
  }

  // ---------- Checking the rules ----------
  function request(withShade) {
    const s = settings();
    const obstacles = keepouts.getLayers().map((l) => ({ polygon: latlngsOf(l), height_m: l.pvHeight || 0 }));
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
      selected.clear(); undoStack.length = 0; drag = null;
      $("manualUndo").disabled = true;
      $("manualList").innerHTML = "";
    },
    loaded() {
      this.reset();
      if (state.layout?.manual) runCheck(false).catch(() => {});
    },
    // True when it is fine to replace the panels with a new automatic layout.
    confirmReplace: () => !state.layout?.manual || confirm("Έχεις μετακινήσει πάνελ με το χέρι. Η νέα τοποθέτηση θα τα αντικαταστήσει. Να συνεχίσω;"),
  };

  map.getContainer().addEventListener("mousedown", onDown, true);
  $("manualOn").onchange = () => {
    document.body.classList.toggle("manual-moving", on());
    if (on() && !layers().length) toast("Κάνε πρώτα τοποθέτηση πάνελ για να τα μετακινήσεις.", 4000);
    if (!on()) select([]);
  };
  map.on("click", () => { if (on() && !drag) select([]); });
  $("manualAll").onclick = () => select(layers());
  $("manualNone").onclick = () => select([]);
  $("manualUndo").onclick = undo;
  $("manualCheck").onclick = () => withBusy($("manualCheck"), () => runCheck(true));
})();
