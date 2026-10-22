// Shapes like in a drawing program: a double-click on an area or obstacle selects the whole shape
// (dashed outline + corner handles). Then: drag = move, Delete = delete, Ctrl+C / Ctrl+V = copy and
// paste, Esc = done; Ctrl+Z / Ctrl+Y undo and redo any change of the shapes. The same actions as
// buttons on the map. Loaded after draw.js and uses app.js's map, areas, keepouts, panelsLayer,
// editGroup, drawControl, addShape, setObstacleHeight, updateShapesInfo, clearLayout and toast.
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
    bar.querySelector("b").textContent = kindOf(layer) === "keepout" ? "Επιλεγμένο εμπόδιο" : "Επιλεγμένη περιοχή πάνελ";
    bar.hidden = false;
    showButtons();
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
      face: l.pvFace || null, suggest: l.pvSuggest ?? null,
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
    if (layers.length === list.length && list.every((s, i) => kindOf(layers[i]) === s.kind)) {
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
    if (!ctrl && e.key === "Escape" && selected) act = deselect;
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
  const BUTTONS = [
    ["undo", "Αναίρεση της τελευταίας αλλαγής (Ctrl+Z)", undo],
    ["redo", "Επανάληψη (Ctrl+Y)", redo],
    ["copy", "Αντιγραφή του επιλεγμένου σχήματος (Ctrl+C)", copy],
    ["paste", "Επικόλληση αντιγράφου (Ctrl+V)", paste],
    ["remove", "Διαγραφή του επιλεγμένου σχήματος (Delete)", remove],
  ];
  const buttons = {};
  const Tools = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const box = L.DomUtil.create("div", "leaflet-bar pv-shape-tools");
      for (const [name, title, fn] of BUTTONS) {
        const b = (buttons[name] = L.DomUtil.create("a", "", box));
        b.href = "#";
        b.title = title;
        b.setAttribute("role", "button");
        b.setAttribute("aria-label", title);
        b.innerHTML = ICONS[name];
        L.DomEvent.on(b, "click", (e) => { L.DomEvent.preventDefault(e); fn(); });
      }
      L.DomEvent.disableClickPropagation(box);
      return box;
    },
  });
  map.addControl(new Tools());

  // Buttons that would only show a hint look faded.
  function showButtons() {
    const on = { copy: selected, remove: selected, paste: clip, undo: undoList.length, redo: redoList.length };
    for (const [name, yes] of Object.entries(on)) L.DomUtil[yes ? "removeClass" : "addClass"](buttons[name], "pv-off");
  }

  // The hint bar while a shape is selected (same look as the edit bar of draw.js).
  const bar = L.DomUtil.create("div", "pv-editbar pv-selbar", container);
  bar.hidden = true;
  bar.innerHTML = `<div class="pv-editbar-text"><b></b>
      <span>Σύρε το για να το μετακινήσεις · σύρε μια κορυφή για να την αλλάξεις · Delete = διαγραφή ·
      Ctrl+C και Ctrl+V = αντίγραφο · Ctrl+Z = αναίρεση · Esc = τέλος.</span></div>
    <div class="pv-editbar-actions"><button type="button" data-a="done"><svg class="ic"><use href="#i-check"/></svg>Τέλος</button></div>`;
  L.DomEvent.disableClickPropagation(bar);
  L.DomEvent.disableScrollPropagation(bar);
  bar.querySelector("[data-a=done]").onclick = deselect;
  showButtons();

  window.shapes = {
    select, deselect, copy, paste, remove, undo, redo, record, resetHistory,
    get selected() { return selected; },
  };
})();
