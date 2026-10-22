// Ruler: click two or more points on the map for the length of every piece and the total, e.g. to
// check the map against a length that is known. Nothing of it is saved in the project. Loaded after
// shapes.js and uses app.js's map, drawControl and fmt and draw.js's drawTools.
(() => {
  const TEAL = "#2dd4bf";
  map.createPane("pvRuler").style.zIndex = 615; // over the shapes, under the length labels
  map.getPane("pvRuler").style.pointerEvents = "none";
  const LINE = { pane: "pvRuler", interactive: false, color: TEAL, weight: 3, dashArray: "8 6", lineCap: "round" };
  const DOT = { pane: "pvRuler", interactive: false, radius: 4.5, color: "#0f766e", weight: 2, fillColor: "#fff", fillOpacity: 1 };
  const drawn = L.layerGroup().addTo(map);

  let on = false;
  let pts = [];
  let mouse = null; // where the next piece would end

  const lengthOf = (list) => list.reduce((sum, p, i) => (i ? sum + drawTools.meters(list[i - 1], p) : 0), 0);

  function draw() {
    drawn.clearLayers();
    const all = mouse && pts.length ? [...pts, mouse] : pts;
    if (all.length > 1) drawn.addLayer(L.polyline(all, LINE));
    pts.forEach((p) => drawn.addLayer(L.circleMarker(p, DOT)));
    for (let i = 0; i + 1 < all.length; i++) {
      const m = drawTools.edgeLabel(all[i], all[i + 1], mouse && i === all.length - 2 ? "ruler live" : "ruler");
      if (m) drawn.addLayer(m);
    }
    const parts = pts.length - 1;
    total.textContent = parts < 1 ? "κάνε κλικ σε δύο σημεία"
      : `${fmt(lengthOf(pts), 2)} m${parts > 1 ? ` (${parts} τμήματα)` : ""}`;
  }

  function start() {
    if (on) return;
    Object.values(drawControl._toolbars.draw._modes).forEach((m) => m.handler.disable());
    map.fire("draw:drawstart", { layerType: "ruler" }); // ends the other tools, editing and the selection
    on = true;
    pts = [];
    mouse = null;
    map.doubleClickZoom.disable(); // two quick clicks are two points
    L.DomUtil.addClass(map.getContainer(), "pv-ruling");
    bar.hidden = false;
    map.on("click", addPoint);
    map.on("mousemove", follow);
    map.on("mouseout", leave);
    draw();
  }

  // handover: another tool has just started, so drawing goes on (no "draw:drawstop").
  function stop(handover) {
    if (!on) return;
    on = false;
    pts = [];
    mouse = null;
    drawn.clearLayers();
    map.doubleClickZoom.enable();
    L.DomUtil.removeClass(map.getContainer(), "pv-ruling");
    bar.hidden = true;
    map.off("click", addPoint);
    map.off("mousemove", follow);
    map.off("mouseout", leave);
    if (handover !== true) map.fire("draw:drawstop", { layerType: "ruler" });
  }

  function addPoint(e) { pts.push(e.latlng); draw(); }
  function follow(e) { mouse = e.latlng; draw(); }
  function leave() { mouse = null; draw(); }

  map.on("draw:drawstart", (e) => { if (e.layerType !== "ruler") stop(true); });

  // Backspace takes back the last point, Esc ends; not while typing in a field.
  document.addEventListener("keydown", (e) => {
    if (!on || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === "Escape") stop();
    else if (e.key === "Backspace" || e.key === "Delete") { pts.pop(); draw(); }
    else return;
    e.preventDefault();
  });

  // ---------- Button and bar ----------
  // The button is in the toolbar of draw.js, which also lights it up while the ruler is on.
  drawTools.addTool({
    group: "edit", help: "map-ruler", layerType: "ruler", onClick: start,
    title: "Χάρακας: μέτρησε αποστάσεις πάνω στον χάρτη",
    icon: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg>`,
  });

  const bar = L.DomUtil.create("div", "pv-editbar pv-rulerbar", map.getContainer());
  bar.hidden = true;
  bar.dataset.help = "bar-ruler";
  bar.innerHTML = `<div class="pv-editbar-text"><b>Χάρακας · <span data-total></span></b>
      <span>Κλικ σε σημεία του χάρτη, π.χ. στις άκρες ενός μήκους που ξέρεις · Backspace = σβήσε το τελευταίο ·
      Esc = τέλος. Δεν αποθηκεύεται στο έργο.</span></div>
    <div class="pv-editbar-actions"><button type="button" class="secondary" data-a="clear">Καθάρισμα</button>
      <button type="button" data-a="done"><svg class="ic"><use href="#i-check"/></svg>Τέλος</button></div>`;
  const total = bar.querySelector("[data-total]");
  L.DomEvent.disableClickPropagation(bar);
  L.DomEvent.disableScrollPropagation(bar);
  bar.querySelector("[data-a=clear]").onclick = () => { pts = []; draw(); };
  bar.querySelector("[data-a=done]").onclick = () => stop();

  window.ruler = { start, stop, get on() { return on; } };
})();
