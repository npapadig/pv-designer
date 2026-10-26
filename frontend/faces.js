// Roof faces: draw the whole roof as one area, then cut it along a line (e.g. the ridge) into
// faces. Every face is an ordinary area layer (so nudge, edit and delete work on it) that carries
// pvFace = {tilt_deg, azimuth_deg}; a click on an area sets its own tilt and azimuth. Loaded
// after app.js and uses its map, areas, editGroup, addShape, latlngsOf, settings, api, toast,
// clearLayout, longEdgeAzimuth and state.
(() => {
  const LINE_STYLE = { color: "#a855f7", weight: 3, dashArray: "6 4" };
  const COMPASS = ["Β", "ΒΑ", "Α", "ΝΑ", "Ν", "ΝΔ", "Δ", "ΒΔ"];
  let cutter = null;
  let editing = false; // Leaflet.draw edit/delete mode: a click there must not open the face box

  L.drawLocal.draw.handlers.polyline.tooltip = {
    start: "Κάνε κλικ στη μία άκρη της γραμμής χωρισμού (π.χ. στην αρχή του κορφιά).",
    cont: "Κάνε κλικ για το επόμενο σημείο (ή στο ίδιο σημείο ξανά για τέλος).",
    end: "Κάνε κλικ στο τελευταίο σημείο ξανά ή πάτα «Τέλος γραμμής».",
  };

  const compass = (az) => COMPASS[Math.round((((az % 360) + 360) % 360) / 45) % 8];
  const faceNo = (layer) => areas.getLayers().indexOf(layer) + 1;

  function label(layer) {
    layer.unbindTooltip();
    const f = layer.pvFace;
    if (!f) return;
    layer.bindTooltip(`Πλευρά ${faceNo(layer)}<br>${fmt(f.tilt_deg)}° · ${fmt(f.azimuth_deg)}° ${compass(f.azimuth_deg)}`,
      { permanent: true, direction: "center", className: "face-label" });
  }

  // ---------- Slope arrows: an arrow on every face points down the slope (= the azimuth of its panels);
  // drag its head to turn it ----------
  const arrows = new Map(); // layer -> { line, head, len, dragging }
  const mPerDeg = 111320;

  function centerOf(layer) { // centre of the outline (average of the corners), inside for normal faces
    const pts = layer.getLatLngs()[0];
    const n = pts.length;
    return L.latLng(pts.reduce((s, p) => s + p.lat, 0) / n, pts.reduce((s, p) => s + p.lng, 0) / n);
  }
  function headAt(c, az, m) { // the point m metres from c towards azimuth az
    const r = (az * Math.PI) / 180;
    return L.latLng(c.lat + (Math.cos(r) * m) / mPerDeg, c.lng + (Math.sin(r) * m) / (mPerDeg * Math.cos((c.lat * Math.PI) / 180)));
  }
  function azimuthTo(c, p) {
    const dx = (p.lng - c.lng) * Math.cos((c.lat * Math.PI) / 180), dy = p.lat - c.lat;
    return ((Math.round((Math.atan2(dx, dy) * 180) / Math.PI) % 360) + 360) % 360;
  }
  const turn = (a, az) => { a.head.getElement()?.style.setProperty("--az", `${az + (map.getBearing ? map.getBearing() : 0)}deg`); };

  function placeArrow(layer, a, az) {
    const c = centerOf(layer), tip = headAt(c, az, a.len);
    a.line.setLatLngs([c, tip]);
    a.head.setLatLng(tip);
    turn(a, az);
  }

  function dropArrow(layer) {
    const a = arrows.get(layer);
    if (!a) return;
    a.line.remove(); a.head.remove();
    arrows.delete(layer);
  }

  function syncArrows() {
    const flat = state.projectType === "park" || state.roofType === "flat";
    for (const layer of [...arrows.keys()]) if (!areas.hasLayer(layer) || !layer.pvFace || flat) dropArrow(layer);
    if (flat) return;
    for (const layer of areas.getLayers()) {
      if (!layer.pvFace) continue;
      let a = arrows.get(layer);
      if (!a) {
        a = { len: 1, line: L.polyline([[0, 0], [0, 0]], { color: "#0f766e", weight: 3, opacity: 0.95, interactive: false, className: "face-arrow-line" }).addTo(map),
          head: L.marker([0, 0], { icon: L.divIcon({ className: "face-arrow-head", html: "<i></i>", iconSize: [26, 26], iconAnchor: [13, 13] }), keyboard: false, zIndexOffset: 900 }).addTo(map) };
        a.head.bindTooltip("Σύρε για να στρίψεις την κατεύθυνση της κλίσης", { direction: "top", offset: [0, -12] });
        arrows.set(layer, a);
        L.DomEvent.on(a.head.getElement(), "mousedown touchstart", (e) => startTurn(layer, a, e));
      }
      a.len = Math.max(1.2, Math.min(4, Math.sqrt(areaM2(layer)) * 0.3)); // metres
      if (!a.dragging) placeArrow(layer, a, layer.pvFace.azimuth_deg);
    }
  }
  const areaM2 = (layer) => { try { return window.L.GeometryUtil ? L.GeometryUtil.geodesicArea(layer.getLatLngs()[0]) : Math.abs(layer.getBounds().getNorth() - layer.getBounds().getSouth()) * mPerDeg * 5; } catch { return 25; } };

  function startTurn(layer, a, e0) {
    L.DomEvent.stop(e0);
    a.dragging = true;
    map.dragging.disable();
    let az = layer.pvFace.azimuth_deg;
    const c = centerOf(layer);
    const move = (e) => {
      const ev = e.touches ? e.touches[0] : e;
      az = azimuthTo(c, map.mouseEventToLatLng(ev));
      if (e.shiftKey) az = Math.round(az / 5) * 5; // Shift = in steps of 5°
      placeArrow(layer, a, az);
      layer.setTooltipContent?.(`Πλευρά ${faceNo(layer)}<br>${fmt(layer.pvFace.tilt_deg)}° · ${fmt(az)}° ${compass(az)}`);
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("touchmove", move);
      document.removeEventListener("mouseup", up); document.removeEventListener("touchend", up);
      map.dragging.enable();
      a.dragging = false;
      window.pvFaces.set(layer, layer.pvFace.tilt_deg, az); // saves, refreshes the labels and the list
    };
    document.addEventListener("mousemove", move); document.addEventListener("touchmove", move, { passive: true });
    document.addEventListener("mouseup", up); document.addEventListener("touchend", up);
  }

  map.on("rotate", () => arrows.forEach((a, layer) => turn(a, layer.pvFace?.azimuth_deg ?? 0)));
  map.on("zoomend", syncArrows);

  function refresh() {
    syncArrows();
    map.fire("pv:faces"); // the area list in the side panel shows the tilt and azimuth
    areas.getLayers().forEach(label);
    const n = areas.getLayers().filter((l) => l.pvFace).length;
    $("facesElec").hidden = !n;
    $("facesInfo").textContent = n
      ? `${n} πλευρά(ές) με δική τους κλίση και αζιμούθιο. Οι υπόλοιπες περιοχές παίρνουν τις κοινές ρυθμίσεις του βήματος «Πάνελ».`
      : "";
  }

  function setFace(layer, face) {
    layer.pvFace = face;
    refresh();
    clearLayout();
  }

  function openBox(layer, latlng) {
    if (editing || cutter) return;
    const s = settings();
    const f = layer.pvFace || { tilt_deg: s.tilt_deg, azimuth_deg: s.azimuth_deg };
    const roof0 = f.roof_tilt_deg ?? f.tilt_deg;
    const box = L.DomUtil.create("div", "face-box");
    box.innerHTML = `<b>Πλευρά ${faceNo(layer)}</b>
      <label>Κλίση πλευράς (°) <input name="roof" type="number" min="0" max="90" step="1" value="${roof0}"></label>
      <label class="radio switch"><input name="own" type="checkbox"${f.own_tilt ? " checked" : ""}> Άλλη κλίση για τα πάνελ (αλλιώς παράλληλα με την πλευρά)</label>
      <label name="ownRow">Κλίση πάνελ (°) <input name="tilt" type="number" min="0" max="90" step="1" value="${f.tilt_deg}"></label>
      <label>Αζιμούθιο (°) <input name="az" type="number" min="0" max="360" step="1" value="${f.azimuth_deg}"></label>
      <p class="muted small">0 = Βορράς, 90 = Ανατολή, 180 = Νότος, 270 = Δύση.</p>
      <div class="row">
        <button type="button" data-a="suggest" class="secondary">Πρόταση αζιμουθίου</button>
        ${layer.pvFace ? '<button type="button" data-a="common" class="ghost">Κοινές ρυθμίσεις</button>' : ""}
      </div>
      <button type="button" data-a="ok" class="primary">ΟΚ</button>`;
    const tilt = box.querySelector("[name=tilt]"), az = box.querySelector("[name=az]");
    const roof = box.querySelector("[name=roof]"), own = box.querySelector("[name=own]");
    const clamp = (v) => Math.min(90, Math.max(0, +v || 0));
    const syncOwn = () => { box.querySelector("[name=ownRow]").hidden = !own.checked; if (!own.checked) tilt.value = clamp(roof.value); };
    syncOwn();
    const save = () => {
      syncOwn();
      setFace(layer, {
        tilt_deg: own.checked ? clamp(tilt.value) : clamp(roof.value),
        roof_tilt_deg: clamp(roof.value), own_tilt: own.checked,
        azimuth_deg: ((+az.value || 0) % 360 + 360) % 360,
      });
    };
    tilt.onchange = save;
    roof.onchange = save;
    own.onchange = save;
    az.onchange = save;
    box.querySelector("[data-a=suggest]").onclick = () => {
      az.value = layer.pvSuggest ?? longEdgeAzimuth(layer);
      save();
    };
    box.querySelector("[data-a=ok]").onclick = () => { // take what was typed (even if the field is still focused) and close
      const changed = +tilt.value !== f.tilt_deg || +az.value !== f.azimuth_deg || +roof.value !== roof0 || own.checked !== !!f.own_tilt;
      if (layer.pvFace || changed) save();
      map.closePopup();
    };
    const common = box.querySelector("[data-a=common]");
    if (common) common.onclick = () => { map.closePopup(); setFace(layer, null); };
    L.popup().setLatLng(latlng || layer.getBounds().getCenter()).setContent(box).openOn(map);
  }

  // For the area list (shapes.js): the face of an area (its own or the common one) and a setter.
  window.pvFaces = {
    get(layer) {
      if (!areas.hasLayer(layer) || state.projectType === "park" || state.roofType === "flat") return null;
      const s = settings(), f = layer.pvFace || { tilt_deg: s.tilt_deg, azimuth_deg: s.azimuth_deg };
      return { ...f, dir: compass(f.azimuth_deg) };
    },
    set(layer, tilt, az) {
      const t = Math.min(90, Math.max(0, +tilt || 0)), old = layer.pvFace || {};
      // A face whose panels follow the roof keeps doing so: the typed tilt is then the slope of the face.
      const own = !!old.own_tilt;
      setFace(layer, {
        tilt_deg: t, roof_tilt_deg: own ? (old.roof_tilt_deg ?? t) : t, own_tilt: own,
        azimuth_deg: ((+az || 0) % 360 + 360) % 360,
      });
    },
  };

  areas.on("layeradd", (e) => {
    e.layer.on("click", (ev) => openBox(e.layer, ev.latlng));
    e.layer.on("edit editdrag pv:moved", syncArrows); // the arrow follows its face
    refresh();
  });
  areas.on("layerremove", refresh);
  map.on("draw:editstart draw:deletestart", () => { editing = true; arrows.forEach((a) => a.head.getElement()?.classList.add("off")); });
  map.on("draw:editstop draw:deletestop", () => { editing = false; arrows.forEach((a) => a.head.getElement()?.classList.remove("off")); });

  // ---------- Cutting ----------
  function showCutting(on) {
    $("btnSplit").hidden = on;
    $("splitActions").hidden = !on;
  }

  function startCut() {
    if (!areas.getLayers().length) return toast("Σχεδίασε πρώτα όλη τη στέγη ως μία περιοχή.");
    if (cutter) return;
    map.closePopup();
    cutter = new L.Draw.Polyline(map, { shapeOptions: LINE_STYLE, showLength: true, metric: true });
    // The line is not a shape of the project: use it here instead of firing the "created" event.
    cutter._fireCreatedEvent = function () {
      const line = this._poly.getLatLngs().map((p) => [p.lat, p.lng]);
      cut(line).catch((e) => toast(e.message, 6000));
    };
    cutter.on("disabled", () => { cutter = null; showCutting(false); });
    cutter.enable();
    showCutting(true);
  }

  async function cut(line) {
    const tilt = settings().tilt_deg;
    let made = 0;
    for (const layer of [...areas.getLayers()]) {
      const { pieces } = await api("/api/split", "POST", { area: latlngsOf(layer), line });
      if (pieces.length < 2) continue;
      for (const piece of pieces) {
        const part = L.polygon(piece.area);
        if (layer.pvNudge) part.pvNudge = [...layer.pvNudge]; // so "Επαναφορά" also moves the pieces back
        part.pvSuggest = piece.azimuth_deg;
        part.pvFace = { ...(layer.pvFace || { tilt_deg: tilt, roof_tilt_deg: tilt, own_tilt: false }), azimuth_deg: piece.azimuth_deg };
        addShape(part, "area");
      }
      areas.removeLayer(layer);
      editGroup.removeLayer(layer);
      made += pieces.length;
    }
    updateShapesInfo();
    refresh();
    if (!made) return toast("Η γραμμή δεν χωρίζει καμία περιοχή. Τράβηξέ τη από άκρη σε άκρη της στέγης.", 6000);
    clearLayout();
    toast(`Η στέγη χωρίστηκε σε ${made} πλευρές. Κάνε κλικ σε κάθε πλευρά για να ελέγξεις κλίση και αζιμούθιο.`, 7000);
  }

  // ---------- Roof type: a flat roof has no faces (the box hides), a park counts as flat ----------
  function syncRoof() {
    const park = state.projectType === "park";
    const flat = park || state.roofType === "flat";
    $("roofRow").hidden = park;
    $("facesBox").hidden = flat;
    document.querySelectorAll("input[name=roofType]").forEach((r) => { r.checked = r.value === (flat ? "flat" : "pitched"); });
  }

  // Choosing the roof also picks the mounting: racks on a flat roof, parallel on a pitched one.
  function setRoof(type) {
    if (type === "flat" && areas.getLayers().some((l) => l.pvFace)) {
      if (!confirm("Σε επίπεδη ταράτσα δεν χρειάζονται πλευρές στέγης: όλες οι περιοχές θα πάρουν την κοινή κλίση και το αζιμούθιο του βήματος «Πάνελ». Να συνεχίσω;")) {
        syncRoof();
        return;
      }
      areas.getLayers().forEach((l) => { l.pvFace = null; });
      refresh();
      clearLayout();
    }
    if (type === "flat") cutter?.disable();
    state.roofType = type;
    $("mounting").value = type === "flat" ? "rack" : "flush";
    $("mounting").dispatchEvent(new Event("change"));
    syncRoof();
  }
  document.querySelectorAll("input[name=roofType]").forEach((r) => r.addEventListener("change", () => setRoof(r.value)));

  $("btnSplit").onclick = startCut;
  $("btnSplitDone").onclick = () => cutter?.completeShape();
  $("btnSplitCancel").onclick = () => cutter?.disable();

  // ---------- Used by app.js and electrical.js ----------
  window.faces = {
    setRoof, syncRoof,
    // True when any area has its own tilt/azimuth: then layout, shading and production go per face.
    active: () => areas.getLayers().some((l) => l.pvFace),
    list: () => areas.getLayers().map((l) => ({ area: latlngsOf(l), ...(l.pvFace || {}) })),
    shadingFaces() {
      const l = state.layout;
      if (!l || !l.panel_face || l.panel_face.length !== panelsLayer.getLayers().length) return null;
      return { faces: l.faces.map((f) => ({ tilt_deg: f.tilt_deg, azimuth_deg: f.azimuth_deg })), panel_face: l.panel_face };
    },
    energyFaces() {
      const l = state.layout;
      if (!l || !l.faces) return null;
      const sh = (state.shading && state.shading.faces) || [];
      return l.faces.map((f, i) => ({
        kwp: f.kwp, tilt_deg: f.tilt_deg, azimuth_deg: f.azimuth_deg,
        shading_monthly_pct: sh[i] ? sh[i].monthly_loss_pct : null,
      }));
    },
    collect() {
      const list = areas.getLayers().map((l) => (l.pvFace ? { ...l.pvFace, suggest_deg: l.pvSuggest ?? null } : null));
      return list.some(Boolean) ? list : null;
    },
    // Results per face: panels, kWp, angles, shading and production.
    renderTable() {
      const box = $("facesTable");
      const l = state.layout;
      if (!l || !l.faces) { box.innerHTML = ""; return; }
      const sh = (state.shading && state.shading.faces) || [];
      const en = {};
      ((state.energy && state.energy.faces) || []).forEach((f, i) => { en[f.face ?? i] = f; });
      const rows = l.faces.map((f, i) => {
        const e = en[i];
        return `<tr><td>${i + 1}</td><td class="num">${fmt(f.count)}</td><td class="num">${fmt(f.kwp, 2)}</td>
          <td class="num">${fmt(f.tilt_deg)}°</td><td class="num">${fmt(f.azimuth_deg)}° ${compass(f.azimuth_deg)}</td>
          <td class="num">${sh[i] ? fmt(sh[i].annual_loss_pct, 1) + "%" : "–"}</td>
          <td class="num">${e ? fmt(e.annual_kwh) : "–"}</td><td class="num">${e ? fmt(e.specific_yield) : "–"}</td></tr>`;
      }).join("");
      box.innerHTML = `<h3>Ανά πλευρά στέγης</h3>
        <table class="losses faces-table">
          <tr class="head"><td>Πλευρά</td><td class="num">Πάνελ</td><td class="num">kWp</td><td class="num">Κλίση</td>
            <td class="num">Αζιμ.</td><td class="num">Σκίαση</td><td class="num">kWh/έτος</td><td class="num">kWh/kWp</td></tr>
          ${rows}
        </table>`;
    },
    load(list) {
      areas.getLayers().forEach((l, i) => {
        const f = (list || [])[i];
        l.pvFace = f ? { tilt_deg: f.tilt_deg, roof_tilt_deg: f.roof_tilt_deg ?? f.tilt_deg, own_tilt: !!f.own_tilt, azimuth_deg: f.azimuth_deg } : null;
        l.pvSuggest = f && f.suggest_deg != null ? f.suggest_deg : undefined;
      });
      refresh();
    },
  };
})();
