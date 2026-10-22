// Floor plan on the map: an image the user places under the drawings, moves, rotates, sizes with two
// points of known distance and makes see-through, then locks to draw the roof on top of it.
// Uses app.js globals (map, $, toast, fmt). No library: an <img> in its own Leaflet pane.
(() => {
  const EARTH = 40075016.686; // equator length in metres (Web Mercator)
  const PANE_EDIT = "450", PANE_LOCKED = "350"; // above the drawings while editing, under them when locked
  const MAX_MB = 25;

  const p = { image: "", natW: 0, natH: 0, center: null, widthM: 20, rot: 0, opacity: 0.6, locked: false };

  const pane = map.createPane("planPane");
  const img = document.createElement("img");
  img.className = "plan-img leaflet-zoom-animated";
  img.alt = "Κάτοψη";
  img.draggable = false;
  img.hidden = true;
  pane.appendChild(img);
  L.DomEvent.disableClickPropagation(img);
  L.DomEvent.disableScrollPropagation(img);

  // ---------- Drawing the image ----------
  const metresPerPixel = (lat, zoom) => (EARTH * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom);

  function place(pt, zoom) {
    const scale = p.widthM / metresPerPixel(p.center.lat, zoom) / p.natW;
    img.style.transform = `translate(${pt.x}px, ${pt.y}px) rotate(${p.rot}deg) scale(${scale}) translate(-50%, -50%)`;
  }
  function update() {
    if (!p.image || !p.natW) return;
    place(map.latLngToLayerPoint(p.center), map.getZoom());
  }
  map.on("zoom viewreset zoomend", update);
  // Follow Leaflet's zoom animation like its own image overlays do.
  map.on("zoomanim", (e) => { if (p.image && p.natW) place(map._latLngToNewLayerPoint(p.center, e.zoom, e.center), e.zoom); });

  function applyStyle() {
    img.style.opacity = p.opacity;
    pane.style.zIndex = p.locked ? PANE_LOCKED : PANE_EDIT;
    img.classList.toggle("locked", p.locked);
    ["btnPlanCenter", "btnPlanScale", "planRot", "planRotNum", "planWidth", "btnPlanReplace"]
      .forEach((id) => { $(id).disabled = p.locked; });
    if (p.locked) cancelScale();
  }

  function syncControls() {
    $("planEmpty").hidden = !!p.image;
    $("planTools").hidden = !p.image;
    $("planRot").value = p.rot;
    $("planRotNum").value = Math.round(p.rot * 10) / 10;
    $("planWidth").value = Math.round(p.widthM * 10) / 10;
    $("planOpacity").value = Math.round(p.opacity * 100);
    $("planLock").checked = p.locked;
  }

  function refresh() {
    img.hidden = !p.image;
    applyStyle();
    syncControls();
    update();
  }

  // ---------- Loading a picture ----------
  function readImage(src) {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve(probe);
      probe.onerror = () => reject(new Error("Η εικόνα δεν άνοιξε. Δοκίμασε άλλο αρχείο PNG ή JPG."));
      probe.src = src;
    });
  }

  function checkFile(file) {
    if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error("Η κάτοψη πρέπει να είναι εικόνα PNG ή JPG.");
    if (file.size > MAX_MB * 1024 * 1024) throw new Error(`Η εικόνα είναι πολύ μεγάλη (πάνω από ${MAX_MB} MB).`);
  }

  // The part of the map not covered by the side panel (on phones the panel is a sheet at the bottom).
  function visibleBox() {
    const W = window.innerWidth, H = window.innerHeight;
    const sb = $("sidebar").getBoundingClientRect();
    const open = !document.body.classList.contains("collapsed");
    if (!open) return { x0: 0, x1: W, y0: 0, y1: H };
    return W > 760 ? { x0: sb.right, x1: W, y0: 0, y1: H } : { x0: 0, x1: W, y0: 0, y1: sb.top };
  }
  function visibleCenter() {
    const b = visibleBox();
    return map.containerPointToLatLng([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]);
  }
  // Bring a point to the middle of the free part of the screen.
  function centerOn(latlng, zoom) {
    const b = visibleBox();
    const offset = L.point((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2).subtract(map.getSize().divideBy(2));
    map.setView(map.unproject(map.project(latlng, zoom).subtract(offset), zoom), zoom);
  }
  // A new plan starts at about half the free part of the screen.
  function startWidthM() {
    const b = visibleBox();
    const px = Math.min(b.x1 - b.x0, (b.y1 - b.y0) * (p.natW / p.natH)) * 0.6;
    return px * metresPerPixel(map.getCenter().lat, map.getZoom());
  }

  const imageUrl = (id) => `/api/plans/${encodeURIComponent(id)}`;

  // The picture is kept on this computer (data/plans/) and the project stores only its id.
  async function upload(file) {
    const r = await fetch("/api/plans", { method: "POST", headers: { "Content-Type": file.type }, body: file });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : "Η κάτοψη δεν ανέβηκε.");
    return d.id;
  }

  function show(id, probe) {
    p.image = id;
    p.natW = probe.naturalWidth;
    p.natH = probe.naturalHeight;
    img.src = probe.src;
  }

  async function setImage(file, keepPlace, at) {
    checkFile(file);
    loading++;
    const id = await upload(file);
    show(id, await readImage(imageUrl(id)));
    if (!keepPlace) {
      p.center = at ? L.latLng(at) : visibleCenter();
      p.widthM = Math.max(5, Math.round(startWidthM()));
      p.rot = 0;
      p.opacity = 0.6;
      p.locked = false;
    }
    refresh();
  }

  let onPicked = null;
  function pickFile(cb) {
    onPicked = cb;
    $("planFile").value = "";
    $("planFile").click();
  }
  $("planFile").onchange = () => {
    const file = $("planFile").files[0];
    const cb = onPicked;
    onPicked = null;
    if (file && cb) cb(file);
  };

  // A new plan from the box: put it in the middle of the map (or at the place of a new building).
  async function start(file, keepPlace = false, at = null) {
    try {
      await setImage(file, keepPlace, at);
      $("planBox").open = true;
      if (at) toast("Σύρε την κάτοψη ώστε να ταιριάξει στη θέση της και πάτα «Κλίμακα» για το σωστό μέγεθος.", 7000);
      else if (!keepPlace) toast("Βρες τη διεύθυνση, πάτα «Στο κέντρο του χάρτη» και σύρε την κάτοψη στη θέση της.", 7000);
    } catch (e) { toast(e.message, 6000); }
  }

  // ---------- New building: first where it will stand, then the floor plan ----------
  let asking = null; // "where" | "plan" | null
  let where = null, whereMark = null;
  function ask(step) {
    asking = step;
    $("planAsk").hidden = !step;
    $("planAskWhere").hidden = step !== "where";
    $("planAskPlan").hidden = step !== "plan";
    map.getContainer().classList.toggle("plan-where", step === "where");
    if (!step && whereMark) { whereMark.remove(); whereMark = null; }
  }
  function askWhere() {
    where = null;
    ask("where");
  }
  function located(latlng) {
    if (asking !== "where") return;
    where = L.latLng(latlng);
    if (!whereMark) whereMark = L.circleMarker(where, { radius: 9, color: "#fff", weight: 3, fillColor: "#ff8a3d", fillOpacity: 1, interactive: false });
    whereMark.setLatLng(where).addTo(map);
    ask("plan");
  }
  map.on("click", (e) => {
    if (asking !== "where" || window.drawTools?.editing) return;
    centerOn(e.latlng, Math.max(map.getZoom(), 19));
    located(e.latlng);
  });
  document.addEventListener("pv:found", (e) => located(e.detail)); // address search (app.js)
  map.on(L.Draw.Event.CREATED, (e) => { if (asking === "where") located(e.layer.getBounds().getCenter()); });
  $("btnPlanAskSkip").onclick = () => { where = null; ask("plan"); };
  $("btnPlanAskNo").onclick = () => ask(null);
  $("btnPlanAskUpload").onclick = () => pickFile(async (f) => {
    const at = where;
    ask(null);
    await start(f, false, at);
  });

  let loading = 0; // a newer load or clear makes an older, still loading picture stale
  function clear() {
    loading++;
    cancelScale();
    ask(null);
    Object.assign(p, { image: "", natW: 0, natH: 0, center: null, widthM: 20, rot: 0, opacity: 0.6, locked: false });
    img.removeAttribute("src");
    refresh();
  }

  // ---------- Saved with the project ----------
  function collect() {
    if (!p.image) return null;
    return {
      image: p.image, center: [p.center.lat, p.center.lng], width_m: Math.round(p.widthM * 1000) / 1000,
      rotation_deg: Math.round(p.rot * 10) / 10, opacity: p.opacity, locked: p.locked,
    };
  }

  // Values are set at once (so the project counts as unchanged); the picture follows when it arrives.
  async function load(saved) {
    clear();
    if (!saved || !saved.image) return;
    const ticket = loading;
    Object.assign(p, {
      image: saved.image, center: L.latLng(saved.center), widthM: +saved.width_m || 20,
      rot: +saved.rotation_deg || 0, opacity: saved.opacity ?? 0.6, locked: !!saved.locked,
    });
    syncControls();
    applyStyle();
    try {
      const probe = await readImage(imageUrl(saved.image));
      if (ticket !== loading) return;
      show(saved.image, probe);
      refresh();
    } catch {
      if (ticket === loading) toast("Η εικόνα της κάτοψης δεν βρέθηκε σε αυτόν τον υπολογιστή.", 6000);
    }
  }

  // ---------- Moving with the mouse ----------
  let drag = null;
  img.addEventListener("pointerdown", (e) => {
    if (p.locked || scaling || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    img.setPointerCapture(e.pointerId);
    map.dragging.disable();
    drag = { x: e.clientX, y: e.clientY, from: map.latLngToLayerPoint(p.center) };
    img.classList.add("dragging");
  });
  img.addEventListener("pointermove", (e) => {
    if (!drag) return;
    p.center = map.layerPointToLatLng(drag.from.add([e.clientX - drag.x, e.clientY - drag.y]));
    update();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    map.dragging.enable();
    img.classList.remove("dragging");
  };
  img.addEventListener("pointerup", endDrag);
  img.addEventListener("pointercancel", endDrag);

  // ---------- Scale from two points of known distance ----------
  const marks = L.layerGroup().addTo(map);
  let scaling = false, pts = [];

  function startScale() {
    scaling = true;
    pts = [];
    marks.clearLayers();
    $("planScaleRow").hidden = false;
    $("planScaleSet").hidden = true;
    $("planScaleInfo").textContent = "Κάνε κλικ στο 1ο σημείο της κάτοψης.";
    img.classList.add("measuring");
    map.getContainer().classList.add("plan-measuring");
  }

  function cancelScale() {
    scaling = false;
    pts = [];
    marks.clearLayers();
    $("planScaleRow").hidden = true;
    img.classList.remove("measuring");
    map.getContainer().classList.remove("plan-measuring");
  }

  map.on("click", (e) => {
    if (!scaling || pts.length >= 2) return;
    pts.push(e.latlng);
    L.circleMarker(e.latlng, { radius: 5, color: "#fff", weight: 2, fillColor: "#ff8a3d", fillOpacity: 1 }).addTo(marks);
    if (pts.length === 1) {
      $("planScaleInfo").textContent = "Κάνε κλικ στο 2ο σημείο.";
      return;
    }
    L.polyline(pts, { color: "#ff8a3d", weight: 3, dashArray: "6 6" }).addTo(marks);
    const now = map.distance(pts[0], pts[1]);
    $("planScaleInfo").textContent = `Τώρα η απόσταση είναι ${fmt(now, 2)} m. Γράψε πόσα μέτρα είναι στην πραγματικότητα:`;
    $("planScaleSet").hidden = false;
    $("planDist").value = Math.round(now * 100) / 100;
    $("planDist").select();
  });

  // Grow or shrink the plan around the first point, so that point stays where it is.
  function applyScale() {
    const real = +$("planDist").value;
    const now = map.distance(pts[0], pts[1]);
    if (!(real > 0) || !(now > 0)) return toast("Γράψε την πραγματική απόσταση σε μέτρα.");
    const f = real / now;
    const a = map.latLngToLayerPoint(pts[0]), c = map.latLngToLayerPoint(p.center);
    p.center = map.layerPointToLatLng(a.add(c.subtract(a).multiplyBy(f)));
    p.widthM *= f;
    cancelScale();
    refresh();
    toast(`Η κλίμακα ορίστηκε: πλάτος κάτοψης ${fmt(p.widthM, 1)} m.`);
  }

  // ---------- Controls ----------
  $("btnPlanUpload").onclick = () => pickFile((f) => start(f));
  $("btnPlanReplace").onclick = () => pickFile((f) => start(f, true));
  $("btnPlanRemove").onclick = () => { if (confirm("Να αφαιρεθεί η κάτοψη από το έργο;")) clear(); };
  $("btnPlanCenter").onclick = () => { p.center = visibleCenter(); update(); };
  $("btnPlanScale").onclick = startScale;
  $("btnPlanScaleCancel").onclick = cancelScale;
  $("btnPlanScaleOk").onclick = applyScale;
  $("planDist").addEventListener("keydown", (e) => { if (e.key === "Enter") applyScale(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && scaling) cancelScale(); });

  const setRot = (v) => {
    p.rot = ((((+v || 0) + 180) % 360) + 360) % 360 - 180;
    syncControls();
    update();
  };
  $("planRot").addEventListener("input", () => setRot($("planRot").value));
  $("planRotNum").addEventListener("change", () => setRot($("planRotNum").value));
  $("planWidth").addEventListener("change", () => {
    const w = +$("planWidth").value;
    if (w > 0) { p.widthM = w; update(); }
    syncControls();
  });
  $("planOpacity").addEventListener("input", () => { p.opacity = +$("planOpacity").value / 100; applyStyle(); });
  $("planLock").addEventListener("change", () => { p.locked = $("planLock").checked; applyStyle(); });

  window.plan = { pickFile, start, clear, collect, load, askWhere, active: () => !!p.image };
  refresh();
})();
