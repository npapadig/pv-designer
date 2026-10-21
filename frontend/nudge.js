// Nudge: moves every drawn area and obstacle together by a few cm/m, so the drawing can be
// lined up with satellite imagery that is slightly offset. Loaded after app.js and uses its
// map, areas, keepouts and clearLayout. The coordinates themselves change, so saving a
// project keeps the new positions.
(() => {
  const EARTH_R = 6378137; // m, same sphere as Leaflet's Web Mercator
  const DIRS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
  const KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  let total = [0, 0]; // metres east, north since the last reset

  const shapes = () => [...areas.getLayers(), ...keepouts.getLayers()];
  const stepM = () => +document.querySelector("input[name=nudgeStep]:checked").value;

  // Shift every shape by (east, north) metres. One reference latitude for all shapes keeps
  // the move rigid; over a roof the difference is far below a millimetre.
  function shift(layers, east, north) {
    if (!layers.length) return;
    const lat = L.featureGroup(layers).getBounds().getCenter().lat;
    const dLat = (north / EARTH_R) * (180 / Math.PI);
    const dLng = (east / (EARTH_R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
    for (const l of layers) {
      const move = (p) => (Array.isArray(p) ? p.map(move) : L.latLng(p.lat + dLat, p.lng + dLng));
      l.setLatLngs(move(l.getLatLngs()));
      const off = l.pvNudge || [0, 0];
      l.pvNudge = [off[0] + east, off[1] + north];
      if (l.editing && l.editing.enabled() && l.editing.updateMarkers) l.editing.updateMarkers();
    }
  }

  function nudge(dir) {
    const layers = shapes();
    if (!layers.length) return toast("Σχεδίασε πρώτα μια περιοχή.");
    const m = stepM();
    const [ex, ny] = DIRS[dir];
    shift(layers, ex * m, ny * m);
    total = [total[0] + ex * m, total[1] + ny * m];
    clearLayout();
    show();
  }

  // Each shape goes back by its own offset, so shapes drawn after a nudge stay where they are.
  function reset() {
    for (const l of shapes()) {
      if (!l.pvNudge) continue;
      shift([l], -l.pvNudge[0], -l.pvNudge[1]);
      delete l.pvNudge;
    }
    total = [0, 0];
    clearLayout();
    show();
  }

  function show() {
    const part = (v, pos, neg) => (Math.abs(v) < 0.005 ? "" : `${fmt(Math.abs(v), 1)} m ${v > 0 ? pos : neg}`);
    const txt = [part(total[1], "Β", "Ν"), part(total[0], "Α", "Δ")].filter(Boolean).join(", ");
    $("nudgeInfo").textContent = txt ? `Μετακινήθηκαν ${txt}.` : "Δεν έχουν μετακινηθεί.";
  }

  // A new or loaded project has no moved shapes: start counting from zero again.
  function onRemove() {
    if (!shapes().some((l) => l.pvNudge)) { total = [0, 0]; show(); }
  }
  areas.on("layerremove", onRemove);
  keepouts.on("layerremove", onRemove);

  document.querySelectorAll("[data-nudge]").forEach((b) => { b.onclick = () => nudge(b.dataset.nudge); });
  $("btnNudgeReset").onclick = reset;

  // Shift + arrow keys, only while the "Χώρος" step is open and no field has the focus.
  document.addEventListener("keydown", (e) => {
    if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !KEYS[e.key]) return;
    if (!$("secSite").classList.contains("active")) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    e.stopPropagation(); // keep Leaflet from also panning the map
    nudge(KEYS[e.key]);
  }, true);

  show();
})();
