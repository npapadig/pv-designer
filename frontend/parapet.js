// Parapet (στηθαίο) per side, in the step «Χώρος». Every side of a panel area can have a wall or not: `layer.pvParapet` is an array with
// one flag per side (a missing array = all sides). A grey wall on the map switches its side off (a click); a dashed line marks a side
// without a wall, and a click on it switches the wall on again. Under each area of the list there is a «Στηθαίο» row: one switch for all
// sides and a button for each side. The height and thickness are the fields of the box «Στηθαίο» (index.html, #parapetBox).
// app.js builds the walls (parapetObstacles) and the shading uses them; this file keeps the flags, the controls and the dashed lines.
(() => {
  const ring = (layer) => latlngsOf(layer);

  // Flags of a side each; a changed number of vertices (the outline was edited) starts again with all sides on.
  function flags(layer) {
    const n = ring(layer).length;
    return layer.pvParapet && layer.pvParapet.length === n ? layer.pvParapet : Array(n).fill(true);
  }

  function changed() {
    if (typeof clearShading === "function") clearShading(); // the shading of the old walls is out of date
    map.fire("pv:shapes");                                    // the list of areas is drawn again
  }

  function set(layer, side, on) {
    const f = [...flags(layer)];
    f[side] = on;
    layer.pvParapet = f.every(Boolean) ? undefined : f;
    changed();
  }

  function setAll(layer, on) {
    layer.pvParapet = on ? undefined : Array(ring(layer).length).fill(false);
    changed();
  }

  const onSite = () => document.getElementById("secSite").classList.contains("active");

  // The sides without a wall as dashed lines (only while the step «Χώρος» is open), into the group of walls.
  function drawOff(group) {
    if (!onSite()) return;
    areas.getLayers().forEach((layer) => {
      const ll = ring(layer);
      const f = flags(layer);
      ll.forEach((a, i) => {
        if (f[i] !== false) return;
        const b = ll[(i + 1) % ll.length];
        L.polyline([a, b], { color: "#374151", weight: 3, dashArray: "2 7", opacity: 0.8 })
          .on("click", (e) => { L.DomEvent.stopPropagation(e); set(layer, i, true); })
          .addTo(group);
      });
    });
  }

  // A click on a wall: that side has no wall any more.
  function wallClicked(layerId, side) {
    const layer = areas.getLayer(layerId);
    if (layer && onSite() && side != null) set(layer, side, false);
  }

  // The row «Στηθαίο» of an area (called by shapes.js whenever the list is drawn).
  function renderRow(row, layer) {
    let box = row.querySelector(".shape-parapet");
    if (!box) return;
    const applies = parapetApplies() && document.getElementById("parapetOn").checked;
    box.hidden = !applies;
    if (!applies) return;
    const f = flags(layer);
    const sig = f.map((x) => (x ? 1 : 0)).join("");
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const all = f.every(Boolean), none = f.every((x) => !x);
    box.innerHTML = `<label class="pp-all"><input type="checkbox" ${all ? "checked" : ""} aria-label="Στηθαίο σε όλες τις πλευρές"><span>Στηθαίο</span></label>
      <span class="pp-sides">${f.map((on, i) => `<button type="button" class="pp-side${on ? " on" : ""}" data-side="${i}" title="Πλευρά ${i + 1}" aria-pressed="${on}">${i + 1}</button>`).join("")}</span>`;
    const chk = box.querySelector("input");
    chk.indeterminate = !all && !none;
    chk.onchange = () => setAll(layer, chk.checked);
    box.querySelectorAll(".pp-side").forEach((b) => (b.onclick = () => set(layer, +b.dataset.side, !f[+b.dataset.side])));
  }

  document.getElementById("parapetOn").addEventListener("input", () => map.fire("pv:shapes"));
  // The dashed lines belong to the step «Χώρος»: draw the walls again when the step opens or closes.
  new MutationObserver(() => drawParapet()).observe(document.getElementById("secSite"), { attributes: true, attributeFilter: ["class"] });
  window.pvParapet = { flags, set, setAll, drawOff, wallClicked, renderRow, collect: () => areas.getLayers().map((l) => l.pvParapet || null) };
})();
