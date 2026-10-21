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

  function refresh() {
    areas.getLayers().forEach(label);
    const n = areas.getLayers().filter((l) => l.pvFace).length;
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
    const box = L.DomUtil.create("div", "face-box");
    box.innerHTML = `<b>Πλευρά ${faceNo(layer)}</b>
      <label>Κλίση (°) <input name="tilt" type="number" min="0" max="90" step="1" value="${f.tilt_deg}"></label>
      <label>Αζιμούθιο (°) <input name="az" type="number" min="0" max="360" step="1" value="${f.azimuth_deg}"></label>
      <p class="muted small">0 = Βορράς, 90 = Ανατολή, 180 = Νότος, 270 = Δύση.</p>
      <div class="row">
        <button type="button" data-a="suggest" class="secondary">Πρόταση αζιμουθίου</button>
        ${layer.pvFace ? '<button type="button" data-a="common" class="ghost">Κοινές ρυθμίσεις</button>' : ""}
      </div>`;
    const tilt = box.querySelector("[name=tilt]"), az = box.querySelector("[name=az]");
    const save = () => setFace(layer, {
      tilt_deg: Math.min(90, Math.max(0, +tilt.value || 0)),
      azimuth_deg: ((+az.value || 0) % 360 + 360) % 360,
    });
    tilt.onchange = save;
    az.onchange = save;
    box.querySelector("[data-a=suggest]").onclick = () => {
      az.value = layer.pvSuggest ?? longEdgeAzimuth(layer);
      save();
    };
    const common = box.querySelector("[data-a=common]");
    if (common) common.onclick = () => { map.closePopup(); setFace(layer, null); };
    L.popup().setLatLng(latlng || layer.getBounds().getCenter()).setContent(box).openOn(map);
  }

  areas.on("layeradd", (e) => {
    e.layer.on("click", (ev) => openBox(e.layer, ev.latlng));
    refresh();
  });
  areas.on("layerremove", refresh);
  map.on("draw:editstart draw:deletestart", () => (editing = true));
  map.on("draw:editstop draw:deletestop", () => (editing = false));

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
        part.pvFace = { tilt_deg: layer.pvFace ? layer.pvFace.tilt_deg : tilt, azimuth_deg: piece.azimuth_deg };
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

  $("btnSplit").onclick = startCut;
  $("btnSplitDone").onclick = () => cutter?.completeShape();
  $("btnSplitCancel").onclick = () => cutter?.disable();

  // ---------- Used by app.js and electrical.js ----------
  window.faces = {
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
    load(list) {
      areas.getLayers().forEach((l, i) => {
        const f = (list || [])[i];
        l.pvFace = f ? { tilt_deg: f.tilt_deg, azimuth_deg: f.azimuth_deg } : null;
        l.pvSuggest = f && f.suggest_deg != null ? f.suggest_deg : undefined;
      });
      refresh();
    },
  };
})();
