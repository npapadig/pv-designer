// Shapes like in a drawing program: a double-click on an area or obstacle selects the whole shape
// (dashed outline + corner handles). Then: drag = move, Delete = delete, Ctrl+C / Ctrl+V = copy and
// paste, Esc = done; Ctrl+Z / Ctrl+Y undo and redo any change of the shapes. Also the tree tool, the
// same actions as buttons on the map, and lists of the shapes, with names, in the side panel. Loaded
// after draw.js and uses app.js's map, areas, keepouts, panelsLayer, editGroup, drawControl, addShape,
// setObstacleHeight, shapeName, updateShapesInfo, clearLayout, clearShading, fmt and toast.
(() => {
  const PICK = "Διάλεξε πρώτα ένα σχήμα (διπλό κλικ).";
  const DBL_MS = 300; // a single click on a shape waits this long, in case it becomes a double-click
  const PASTE_PX = 24; // a pasted copy lands this far right and down (on screen) from the original

  let selected = null; // the selected shape layer
  let clip = null; // the copied shape: { kind, pts, height, face, suggest }
  let drawingNow = false; // a Leaflet.draw tool is active (new shape, roof cut line)

  const ring = (layer) => layer.getLatLngs()[0] || [];
  const kindOf = (layer) => (keepouts.hasLayer(layer) ? "keepout" : "area");
  const busy = () => drawingNow || !!window.drawTools?.editing;

  // ---------- Selecting ----------
  function select(layer) {
    if (selected === layer) return;
    deselect();
    map.closePopup();
    selected = layer;
    L.DomUtil.addClass(layer.getElement(), "pv-selected");
    layer.editing.enable(); // corner handles: drag a corner, click a side's middle dot for a new one
    barTitle(layer);
    bar.hidden = false;
    showButtons();
    showLists();
  }

  function barTitle(layer) {
    bar.querySelector("b").textContent = `${kindOf(layer) === "keepout" ? "Επιλεγμένο εμπόδιο" : "Επιλεγμένη περιοχή πάνελ"}: ${shapeName(layer)}`;
  }

  function deselect() {
    if (!selected) return;
    const layer = selected;
    selected = null;
    const el = layer.getElement();
    if (el) L.DomUtil.removeClass(el, "pv-selected");
    if (layer.editing.enabled()) layer.editing.disable();
    bar.hidden = true;
    showButtons();
    showLists();
  }

  // ---------- Copy, paste, delete ----------
  // A copy keeps everything that belongs to the shape: obstacle height, roof face tilt and azimuth.
  function copy() {
    if (!selected) return toast(PICK);
    clip = {
      kind: kindOf(selected),
      pts: ring(selected).map((p) => L.latLng(p.lat, p.lng)),
      height: selected.pvHeight,
      face: selected.pvFace ? { ...selected.pvFace } : null,
      suggest: selected.pvSuggest,
      tree: !!selected.pvTree,
    };
    showButtons();
    toast("Αντιγράφηκε. Πάτα Ctrl+V (ή «Επικόλληση») για να βάλεις ένα αντίγραφο.");
  }

  function paste() {
    if (!clip) return toast("Αντίγραψε πρώτα ένα σχήμα: διπλό κλικ πάνω του και μετά Ctrl+C.");
    if (busy()) return;
    // Every paste lands a bit further on, so pasting several times does not stack the copies.
    const c = L.latLngBounds(clip.pts).getCenter();
    const to = map.unproject(map.project(c).add([PASTE_PX, PASTE_PX]));
    clip.pts = clip.pts.map((p) => L.latLng(p.lat + to.lat - c.lat, p.lng + to.lng - c.lng));
    const layer = L.polygon(clip.pts);
    if (clip.face) layer.pvFace = { ...clip.face };
    if (clip.suggest != null) layer.pvSuggest = clip.suggest;
    if (clip.tree) { layer.pvTree = true; layer.pvName = treeName(); }
    addShape(layer, clip.kind, clip.height);
    clearLayout();
    select(layer);
  }

  function remove() {
    if (!selected) return toast(PICK);
    const layer = selected;
    deselect();
    areas.removeLayer(layer);
    keepouts.removeLayer(layer);
    editGroup.removeLayer(layer);
    updateShapesInfo();
    clearLayout();
  }

  // ---------- Undo / redo ----------
  // A step is the whole drawing (every shape with its points, height, name and roof face) as JSON.
  // Every change of the shapes ends with clearLayout(), because the panels no longer fit; that
  // includes the changes made by draw.js and faces.js. So a step is recorded there.
  const MAX_STEPS = 100;
  const undoList = [], redoList = [];
  let last = "[]"; // the drawing after the last recorded step
  let holding = false; // while a shape is dragged: one step at the end
  let restoring = false;

  function snapshot() {
    const one = (l) => ({
      kind: kindOf(l), pts: ring(l).map((p) => [p.lat, p.lng]), height: l.pvHeight ?? null, name: l.pvName ?? null,
      face: l.pvFace || null, suggest: l.pvSuggest ?? null, tree: !!l.pvTree,
    });
    return JSON.stringify([...areas.getLayers(), ...keepouts.getLayers()].map(one));
  }

  function record() {
    if (holding || restoring) return;
    const now = snapshot();
    if (now === last) return; // e.g. a setting changed, not a shape
    undoList.push(last);
    if (undoList.length > MAX_STEPS) undoList.shift();
    redoList.length = 0;
    last = now;
    showButtons();
  }
  const clearLayoutFirst = clearLayout;
  window.clearLayout = function () { clearLayoutFirst(); record(); };

  // A new or opened project starts with an empty history.
  function resetHistory() {
    undoList.length = redoList.length = 0;
    last = snapshot();
    showButtons();
  }

  // Shapes that are still the same (same number and kinds) change in place, so the selection and
  // the edit mode stay; otherwise all shapes are drawn again.
  function restore(json) {
    const list = JSON.parse(json);
    const layers = [...areas.getLayers(), ...keepouts.getLayers()];
    restoring = true;
    map.closePopup();
    if (layers.length === list.length && list.every((s, i) => kindOf(layers[i]) === s.kind && !!layers[i].pvTree === !!s.tree)) {
      list.forEach((s, i) => {
        const l = layers[i];
        l.pvName = s.name ?? undefined;
        l.setLatLngs([s.pts.map((p) => L.latLng(p[0], p[1]))]);
        if (s.kind === "keepout") setObstacleHeight(l, s.height);
      });
    } else {
      deselect();
      for (const l of layers) { areas.removeLayer(l); keepouts.removeLayer(l); editGroup.removeLayer(l); }
      for (const s of list) {
        const l = L.polygon(s.pts);
        if (s.name != null) l.pvName = s.name;
        if (s.tree) l.pvTree = true;
        addShape(l, s.kind, s.height);
      }
    }
    window.faces?.load(list.filter((s) => s.kind === "area").map((s) => (s.face ? { ...s.face, suggest_deg: s.suggest } : null)));
    updateShapesInfo();
    clearLayout();
    restoring = false;
    last = snapshot();
    map.fire("pv:restored");
    showButtons();
  }

  // While a new shape is being drawn, Ctrl+Z takes back its last point instead.
  function undo() {
    const pen = Object.values(drawControl._toolbars.draw._modes).find((m) => m.handler.enabled())?.handler;
    if (pen) return pen.deleteLastVertex?.();
    if (drawingNow || drag) return;
    if (!undoList.length) return toast("Δεν υπάρχει κάτι για αναίρεση.");
    redoList.push(last);
    restore(undoList.pop());
  }

  function redo() {
    if (drawingNow || drag) return;
    if (!redoList.length) return toast("Δεν υπάρχει κάτι για επανάληψη.");
    undoList.push(last);
    restore(redoList.pop());
  }

  // ---------- Moving with the mouse ----------
  let drag = null; // { layer, start, pts, moved }
  let justDragged = false; // the click that ends a move must not open the shape's box

  function dragStart(layer, e) {
    if (layer !== selected || busy() || e.originalEvent.button !== 0) return;
    L.DomEvent.preventDefault(e.originalEvent); // no text selection while dragging
    map.dragging.disable(); // the map stays still, the shape moves
    drag = { layer, start: e.latlng, pts: ring(layer).map((p) => L.latLng(p.lat, p.lng)), moved: false };
    map.on("mousemove", dragMove);
    L.DomEvent.on(document, "mouseup", dragEnd);
  }

  function dragMove(e) {
    if (!drag.moved) {
      const px = map.latLngToContainerPoint(e.latlng).distanceTo(map.latLngToContainerPoint(drag.start));
      if (px < 3) return; // a click, not a move
      drag.moved = true;
      map.closePopup();
      holding = true; // one undo step for the whole move
      clearLayout(); // the panels do not move with the shape
      if (drag.layer.editing.enabled()) drag.layer.editing.disable(); // handles come back at the end
    }
    const dLat = e.latlng.lat - drag.start.lat, dLng = e.latlng.lng - drag.start.lng;
    drag.layer.setLatLngs([drag.pts.map((p) => L.latLng(p.lat + dLat, p.lng + dLng))]);
  }

  function dragEnd() {
    map.off("mousemove", dragMove);
    L.DomEvent.off(document, "mouseup", dragEnd);
    map.dragging.enable();
    const d = drag;
    drag = null;
    if (!d || !d.moved) return;
    justDragged = true;
    holding = false;
    if (selected === d.layer) d.layer.editing.enable();
    // A roof face keeps its label in the middle.
    const tip = d.layer.getTooltip();
    if (tip && tip.options.permanent && d.layer.isTooltipOpen()) { d.layer.closeTooltip(); d.layer.openTooltip(); }
    d.layer.fire("edit"); // draw.js: lengths again and the panel layout is out of date
  }

  // ---------- Tree ----------
  // Press on the centre of the tree and drag out to the edge of its crown (a click alone makes one
  // 4 m wide). It is kept as an ordinary obstacle polygon of 24 points, so shading and layout need
  // nothing new; on the map it looks like a tree (shapes.css).
  const TREE_POINTS = 24, TREE_M = 6, TREE_R = 2;
  let tree = null; // the tool while it is on: { center, circle, tip }

  // The look: a crown darker in the middle, with a ruffled edge like leaves.
  document.body.insertAdjacentHTML("afterbegin", `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <radialGradient id="pvTreeFill"><stop offset="0" stop-color="#166534"/><stop offset="0.65" stop-color="#22c55e"/>
      <stop offset="1" stop-color="#4ade80"/></radialGradient>
    <filter id="pvTree" x="-15%" y="-15%" width="130%" height="130%">
      <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="7" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="7" xChannelSelector="R" yChannelSelector="G"/>
      <feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000" flood-opacity="0.6"/>
    </filter></svg>`);

  function treeName() {
    const used = new Set(keepouts.getLayers().map((l) => l.pvName));
    let n = 1;
    while (used.has(`Δέντρο ${n}`)) n++;
    return `Δέντρο ${n}`;
  }

  const treeTip = (r) => (r ? `Ακτίνα ${fmt(r, 1)} m · Ø ${fmt(2 * r, 1)} m`
    : "Πάτα στο κέντρο του δέντρου και σύρε ως την άκρη του φυλλώματος. Esc = ακύρωση.");

  function startTree() {
    if (tree) return;
    Object.values(drawControl._toolbars.draw._modes).forEach((m) => m.handler.disable());
    map.fire("draw:drawstart", { layerType: "tree" }); // ends other tools, editing and the selection
    tree = { center: null, circle: null, tip: L.tooltip({ direction: "right", offset: [16, 0], className: "pv-tree-tip" }) };
    map.dragging.disable();
    L.DomUtil.addClass(container, "pv-tree-drawing");
    map.on("mousemove", treeMove);
    map.on("mousedown", treeDown);
  }

  // handover: another tool has just started, so drawing goes on (no "draw:drawstop").
  function stopTree(handover) {
    if (!tree) return;
    map.off("mousemove", treeMove);
    map.off("mousedown", treeDown);
    L.DomEvent.off(document, "mouseup", treeUp);
    if (tree.circle) tree.circle.remove();
    tree.tip.remove();
    tree = null;
    map.dragging.enable();
    L.DomUtil.removeClass(container, "pv-tree-drawing");
    if (handover !== true) map.fire("draw:drawstop", { layerType: "tree" });
  }

  function treeMove(e) {
    const r = tree.center ? map.distance(tree.center, e.latlng) : 0;
    if (tree.circle) tree.circle.setRadius(Math.max(r, 0.1));
    tree.tip.setLatLng(e.latlng).setContent(treeTip(r));
    if (!tree.tip.isOpen()) tree.tip.openOn(map);
  }

  function treeDown(e) {
    if (e.originalEvent.button !== 0) return;
    L.DomEvent.preventDefault(e.originalEvent);
    tree.center = e.latlng;
    tree.circle = L.circle(e.latlng, { radius: 0.1, interactive: false, color: "#22c55e", weight: 2, dashArray: "6 5", fillColor: "#22c55e", fillOpacity: 0.25 }).addTo(map);
    L.DomEvent.on(document, "mouseup", treeUp);
  }

  function treeUp() {
    const center = tree.center, r = tree.circle.getRadius();
    stopTree();
    justDragged = true; // the click that follows must not open a box under the tree
    const radius = r < 0.3 ? TREE_R : r;
    // 24 points around the centre, in local metres as in draw.js.
    const north = map.distance(center, L.latLng(center.lat + 0.001, center.lng)) / 0.001;
    const east = map.distance(center, L.latLng(center.lat, center.lng + 0.001)) / 0.001;
    const pts = [...Array(TREE_POINTS)].map((_, k) => {
      const a = (2 * Math.PI * k) / TREE_POINTS;
      return L.latLng(center.lat + (radius * Math.sin(a)) / north, center.lng + (radius * Math.cos(a)) / east);
    });
    const layer = L.polygon(pts);
    layer.pvTree = true;
    layer.pvName = treeName();
    addShape(layer, "keepout", TREE_M);
    clearLayout();
  }

  // Another drawing tool ends this one.
  map.on("draw:drawstart", (e) => { if (e.layerType !== "tree") stopTree(true); });

  // ---------- Mouse on the shapes ----------
  function onDblclick(e) {
    if (busy()) return;
    L.DomEvent.stop(e); // no zoom-in on a double-click over a shape
    select(e.target);
  }
  for (const g of [areas, keepouts]) {
    g.on("layeradd", (e) => e.layer.on({ dblclick: onDblclick, mousedown: (ev) => dragStart(e.layer, ev) }));
    g.on("layerremove", (e) => { if (e.layer === selected) deselect(); });
  }

  // Panels lie on top of their area: a double-click or a drag on them is meant for the area below.
  function inside(p, pts) {
    let ins = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) ins = !ins;
    }
    return ins;
  }
  panelsLayer.on("dblclick", (e) => {
    const area = areas.getLayers().find((l) => inside(e.latlng, ring(l)));
    if (!area || busy()) return;
    L.DomEvent.stop(e);
    select(area);
  });
  panelsLayer.on("mousedown", (e) => { if (selected && inside(e.latlng, ring(selected))) dragStart(selected, e); });

  // A single click on a shape opens its box (obstacle height, roof face) only once it is clear that
  // no second click follows, so a double-click selects without flashing that box.
  const container = map.getContainer();
  let pending = 0;
  container.addEventListener("mousedown", () => { justDragged = false; }, true);
  container.addEventListener("click", (e) => {
    const t = e.target;
    if (!e.isTrusted || !(t instanceof SVGElement) || !t.classList.contains("pv-shape") || busy()) return;
    e.stopPropagation();
    clearTimeout(pending);
    if (justDragged || e.detail > 1) return;
    const init = {
      bubbles: true, cancelable: true, view: window, detail: 0, button: e.button, buttons: e.buttons,
      clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
    };
    pending = setTimeout(() => { if (t.isConnected) t.dispatchEvent(new MouseEvent("click", init)); }, DBL_MS);
  }, true);

  // A click elsewhere on the map (also on another shape) ends the selection.
  map.on("click", (e) => {
    if (selected && !justDragged && e.originalEvent.target !== selected.getElement()) deselect();
  });
  map.on("draw:drawstart", () => { drawingNow = true; deselect(); });
  map.on("draw:drawstop", () => { drawingNow = false; });
  map.on("draw:editstart", deselect);

  // ---------- Lists in the side panel ----------
  // One row per panel area (number, name, m²) and per obstacle (number, name, height). A click on a
  // row selects the shape on the map, and a shape selected on the map lights up its row.
  const LISTS = {
    area: { group: areas, box: document.getElementById("areaList"), title: "Χώρος" },
    keepout: { group: keepouts, box: document.getElementById("keepoutList"), title: "Εμπόδιο" },
  };
  const m2 = (layer) => window.drawTools.area(ring(layer));

  function makeRow(kind, layer) {
    const row = document.createElement("div");
    row.className = `shape-row ${kind}${layer.pvTree ? " tree" : ""}`;
    row.pvLayer = layer;
    row.innerHTML = `<span class="shape-no"></span>
      <input name="name" maxlength="40" autocomplete="off" placeholder="${kind === "area" ? "π.χ. νότια στέγη" : "π.χ. δέντρο, φράχτης"}">
      ${kind === "area" ? '<span class="shape-num shape-m2"></span>'
        : '<label class="shape-num"><input name="height" type="number" min="0" step="0.5" aria-label="Ύψος σε μέτρα"><span>m</span></label>'}
      <button type="button" class="ghost icon-btn shape-del" title="Διαγραφή" aria-label="Διαγραφή">${ICONS.remove}</button>`;
    return row;
  }

  // A field the user is typing in keeps its text.
  const setValue = (input, v) => { if (input !== document.activeElement && input.value !== String(v)) input.value = v; };

  function renderList(kind) {
    const { group, box, title } = LISTS[kind];
    const rowsBox = box.querySelector(".shape-rows");
    const layers = group.getLayers();
    let rows = [...rowsBox.children];
    if (rows.length !== layers.length || rows.some((r, i) => r.pvLayer !== layers[i])) {
      rowsBox.replaceChildren(...layers.map((l) => makeRow(kind, l)));
      rows = [...rowsBox.children];
    }
    rows.forEach((row, i) => {
      const l = row.pvLayer;
      row.querySelector(".shape-no").textContent = `${title} ${i + 1}`;
      row.querySelector("[name=name]").setAttribute("aria-label", `Όνομα: ${title} ${i + 1}`);
      setValue(row.querySelector("[name=name]"), l.pvName || "");
      if (kind === "area") row.querySelector(".shape-m2").textContent = `${fmt(m2(l), 1)} m²`;
      else setValue(row.querySelector("[name=height]"), l.pvHeight ?? 0);
      row.classList.toggle("on", l === selected);
    });
    box.hidden = !layers.length;
    if (kind === "area") {
      const total = layers.reduce((sum, l) => sum + m2(l), 0);
      box.querySelector("h3").textContent = layers.length > 1 ? `Χώροι πάνελ · ${fmt(total, 1)} m²` : "Χώροι πάνελ";
    }
  }

  let listsQueued = false;
  function showLists() {
    if (listsQueued) return;
    listsQueued = true;
    queueMicrotask(() => { listsQueued = false; for (const kind in LISTS) renderList(kind); });
  }
  keepouts.on("layeradd layerremove", showLists);
  areas.on("layeradd layerremove", showLists);
  areas.on("layeradd", (e) => e.layer.on("edit editdrag pv:moved", showLists)); // the m² while it changes
  map.on("pv:shapes pv:restored", showLists);

  for (const { box } of Object.values(LISTS)) {
    const layerOf = (el) => el.closest(".shape-row")?.pvLayer;
    box.addEventListener("click", (e) => {
      const layer = layerOf(e.target);
      if (!layer) return;
      if (e.target.closest(".shape-del")) { select(layer); return remove(); }
      if (e.target.closest("input, label")) return;
      select(layer);
      const c = layer.getBounds().getCenter();
      if (!map.getBounds().contains(c)) map.panTo(c); // bring it into view
    });
    box.addEventListener("focusin", (e) => {
      const layer = layerOf(e.target);
      if (layer && e.target.matches("input") && !busy()) select(layer);
    });
    box.addEventListener("input", (e) => {
      const layer = layerOf(e.target);
      if (!layer || e.target.name !== "name") return;
      layer.pvName = e.target.value.trim() || undefined;
      const tip = layer.getTooltip();
      if (tip?.isOpen()) tip.update();
      if (layer === selected) barTitle(layer);
    });
    box.addEventListener("change", (e) => {
      const layer = layerOf(e.target);
      if (!layer) return;
      if (e.target.name === "height") {
        setObstacleHeight(layer, e.target.value);
        clearShading();
      }
      record();
    });
  }

  // ---------- Keyboard ----------
  // Not while typing in a field, and not while the home screen covers the map. The key's place
  // (e.code) as well as its letter, so that Ctrl+C / Ctrl+V also work with the Greek layout.
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const homeOpen = () => { const h = document.getElementById("home"); return !!h && !h.hidden; };
  const letter = (e, l) => e.code === `Key${l.toUpperCase()}` || e.key.toLowerCase() === l;
  document.addEventListener("keydown", (e) => {
    if (typing(e.target) || homeOpen() || e.altKey) return;
    const ctrl = e.ctrlKey || e.metaKey;
    let act = null;
    if (!ctrl && e.key === "Escape" && tree) act = () => stopTree();
    else if (!ctrl && e.key === "Escape" && selected) act = deselect;
    else if (!ctrl && (e.key === "Delete" || e.key === "Backspace") && selected && !busy()) act = remove;
    else if (ctrl && !e.shiftKey && letter(e, "c") && selected && String(window.getSelection()) === "") act = copy;
    else if (ctrl && !e.shiftKey && letter(e, "v") && clip && !busy()) act = paste;
    else if (ctrl && !e.shiftKey && letter(e, "z")) act = undo;
    else if (ctrl && (letter(e, "y") || (e.shiftKey && letter(e, "z")))) act = redo;
    if (!act) return;
    e.preventDefault();
    act();
  });

  // ---------- Buttons on the map ----------
  const svg = (paths) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>'),
    redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/>'),
    copy: svg('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
    paste: svg('<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M16 4h2a2 2 0 0 1 2 2v4"/><path d="M21 14H11"/><path d="m15 10-4 4 4 4"/>'),
    remove: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>'),
  };
  // In the toolbar of draw.js: [group, name, help id, title, action].
  const BUTTONS = [
    ["history", "undo", "map-undo", "Αναίρεση της τελευταίας αλλαγής (Ctrl+Z)", undo],
    ["history", "redo", "map-redo", "Επανάληψη (Ctrl+Y)", redo],
    ["clipboard", "copy", "map-copy", "Αντιγραφή του επιλεγμένου σχήματος (Ctrl+C)", copy],
    ["clipboard", "paste", "map-paste", "Επικόλληση αντιγράφου (Ctrl+V)", paste],
    ["clipboard", "remove", "map-delete", "Διαγραφή του επιλεγμένου σχήματος (Delete)", remove],
  ];
  const buttons = {};
  for (const [group, name, help, title, onClick] of BUTTONS) {
    buttons[name] = drawTools.addTool({ group, help, title, onClick, icon: ICONS[name] });
  }

  // Buttons that would only show a hint look faded.
  function showButtons() {
    const on = { copy: selected, remove: selected, paste: clip, undo: undoList.length, redo: redoList.length };
    for (const [name, yes] of Object.entries(on)) L.DomUtil[yes ? "removeClass" : "addClass"](buttons[name], "pv-off");
  }

  // The hint bar while a shape is selected (same look as the edit bar of draw.js).
  const bar = L.DomUtil.create("div", "pv-editbar pv-selbar", container);
  bar.hidden = true;
  bar.dataset.help = "bar-select";
  bar.innerHTML = `<div class="pv-editbar-text"><b></b>
      <span>Σύρε το για να το μετακινήσεις · σύρε μια κορυφή για να την αλλάξεις · Delete = διαγραφή ·
      Ctrl+C και Ctrl+V = αντίγραφο · Ctrl+Z = αναίρεση · Esc = τέλος.</span></div>
    <div class="pv-editbar-actions"><button type="button" data-a="done"><svg class="ic"><use href="#i-check"/></svg>Τέλος</button></div>`;
  L.DomEvent.disableClickPropagation(bar);
  L.DomEvent.disableScrollPropagation(bar);
  bar.querySelector("[data-a=done]").onclick = deselect;
  showButtons();
  showLists();

  window.shapes = {
    select, deselect, copy, paste, remove, undo, redo, record, resetHistory, startTree, stopTree,
    get selected() { return selected; },
  };
})();
