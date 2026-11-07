// Floor plan on the map: an image the user places under the drawings, moves, rotates, sizes with two
// points of known distance and makes see-through, then locks to draw the roof on top of it. Corner handles
// grow or shrink it (the opposite corner stays), the round handle on top turns it (Shift = steps of 15°), the
// wheel grows it (Shift+wheel turns it), and «Ταίριαξε με τον χάρτη» lines it up with the satellite picture from
// two matching points (size, turn and place at once).
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
  // The frame with the handles follows the picture (same place and turn, its own size in pixels).
  const frame = document.createElement("div");
  frame.className = "plan-frame leaflet-zoom-animated";
  frame.hidden = true;
  frame.innerHTML = '<i class="ph" data-c="-1,-1"></i><i class="ph" data-c="1,-1"></i><i class="ph" data-c="1,1"></i><i class="ph" data-c="-1,1"></i><i class="ph rot" data-c="rot" title="Γύρισέ το"></i>';
  pane.appendChild(frame);
  L.DomEvent.disableClickPropagation(frame);

  // ---------- Drawing the image ----------
  const metresPerPixel = (lat, zoom) => (EARTH * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom);

  function place(pt, zoom) {
    const scale = p.widthM / metresPerPixel(p.center.lat, zoom) / p.natW;
    img.style.transform = `translate(${pt.x}px, ${pt.y}px) rotate(${p.rot}deg) scale(${scale}) translate(-50%, -50%)`;
    frame.style.width = `${p.natW * scale}px`;
    frame.style.height = `${p.natH * scale}px`;
    frame.style.transform = `translate(${pt.x}px, ${pt.y}px) rotate(${p.rot}deg) translate(-50%, -50%)`;
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
    ["btnPlanCenter", "btnPlanScale", "btnPlanFit", "planRot", "planRotNum", "planWidth", "btnPlanReplace"]
      .forEach((id) => { $(id).disabled = p.locked; });
    document.querySelectorAll("#planNudge button").forEach((b) => { b.disabled = p.locked; });
    if (p.locked) { cancelScale(); cancelFit(); }
    showFrame();
  }
  // Handles only while the picture can be changed by hand.
  function showFrame() {
    frame.hidden = !(p.image && p.natW) || p.locked || scaling || fitting;
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
    cancelFit();
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
    if (p.locked || scaling || fitting || e.button !== 0) return;
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

  // ---------- Handles: corners grow or shrink, the round one turns ----------
  // Grow the plan by f around the layer point a (a stays where it is).
  function scaleAbout(a, f) {
    const c = map.latLngToLayerPoint(p.center);
    p.center = map.layerPointToLatLng(a.add(c.subtract(a).multiplyBy(f)));
    p.widthM *= f;
  }
  const rad = (d) => (d * Math.PI) / 180;
  let grab = null;
  frame.addEventListener("pointerdown", (e) => {
    const h = e.target.closest(".ph");
    if (!h || p.locked || scaling || fitting || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    h.setPointerCapture(e.pointerId);
    map.dragging.disable();
    const c = map.latLngToLayerPoint(p.center);
    if (h.dataset.c === "rot") { grab = { kind: "rot", c }; return; }
    // the corner and the opposite one (which stays) in layer points
    const [sx, sy] = h.dataset.c.split(",").map(Number);
    const w = frame.offsetWidth / 2, hh = frame.offsetHeight / 2, r = rad(p.rot);
    const off = L.point(sx * w * Math.cos(r) - sy * hh * Math.sin(r), sx * w * Math.sin(r) + sy * hh * Math.cos(r));
    grab = { kind: "size", c, corner: c.add(off), anchor: c.subtract(off), w0: p.widthM, center0: p.center };
  });
  frame.addEventListener("pointermove", (e) => {
    if (!grab) return;
    const pt = map.mouseEventToLayerPoint(e);
    if (grab.kind === "rot") {
      let deg = (Math.atan2(pt.x - grab.c.x, -(pt.y - grab.c.y)) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      setRot(deg);
      return;
    }
    const d = grab.corner.subtract(grab.anchor), v = pt.subtract(grab.anchor);
    const f = Math.max(0.05, (v.x * d.x + v.y * d.y) / (d.x * d.x + d.y * d.y)); // along the diagonal: the shape stays
    p.center = map.layerPointToLatLng(grab.anchor.add(map.latLngToLayerPoint(grab.center0).subtract(grab.anchor).multiplyBy(f)));
    p.widthM = grab.w0 * f;
    syncControls();
    update();
  });
  const endGrab = () => { if (grab) { grab = null; map.dragging.enable(); } };
  frame.addEventListener("pointerup", endGrab);
  frame.addEventListener("pointercancel", endGrab);

  // The wheel over the picture grows it around the pointer; with Shift it turns it (a little at a time).
  img.addEventListener("wheel", (e) => {
    if (p.locked || scaling || fitting) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    if (e.shiftKey) setRot(p.rot + dir * 0.5);
    else { scaleAbout(map.mouseEventToLayerPoint(e), Math.pow(1.03, dir)); syncControls(); update(); }
  }, { passive: false });

  // ---------- Scale from two points of known distance ----------
  const marks = L.layerGroup().addTo(map);
  let scaling = false, fitting = false, pts = [], fitPts = [];

  function startScale() {
    scaling = true;
    pts = [];
    marks.clearLayers();
    $("planScaleRow").hidden = false;
    $("planScaleSet").hidden = true;
    $("planScaleInfo").textContent = "Κάνε κλικ στο 1ο σημείο της κάτοψης.";
    img.classList.add("measuring");
    map.getContainer().classList.add("plan-measuring");
    showFrame();
  }

  function cancelScale() {
    if (!scaling) return;
    scaling = false;
    pts = [];
    marks.clearLayers();
    $("planScaleRow").hidden = true;
    img.classList.remove("measuring");
    map.getContainer().classList.remove("plan-measuring");
    showFrame();
  }

  // ---------- Line it up with the map: two features, each clicked on the plan and then on the map ----------
  const FIT_TEXT = [
    "1/4: Κάνε κλικ σε ένα αναγνωρίσιμο σημείο ΠΑΝΩ ΣΤΗΝ ΚΑΤΟΨΗ (π.χ. μια γωνία του κτιρίου).",
    "2/4: Τώρα κάνε κλικ στο ΙΔΙΟ σημείο στον δορυφορικό ΧΑΡΤΗ (εκεί που πρέπει να πάει).",
    "3/4: Διάλεξε ένα δεύτερο σημείο, μακριά από το πρώτο, ΠΑΝΩ ΣΤΗΝ ΚΑΤΟΨΗ.",
    "4/4: Και το ίδιο σημείο στον ΧΑΡΤΗ.",
  ];
  const FIT_COLORS = ["#ff8a3d", "#14b8a6", "#ff8a3d", "#14b8a6"];
  const FIT_LABELS = ["Α κάτοψη", "Α χάρτης", "Β κάτοψη", "Β χάρτης"];
  function startFit() {
    cancelScale();
    fitting = true;
    fitPts = [];
    marks.clearLayers();
    $("planFitRow").hidden = false;
    $("planFitInfo").textContent = FIT_TEXT[0];
    img.classList.add("measuring");
    map.getContainer().classList.add("plan-measuring");
    showFrame();
  }
  function cancelFit() {
    if (!fitting) return;
    fitting = false;
    fitPts = [];
    marks.clearLayers();
    $("planFitRow").hidden = true;
    img.classList.remove("measuring");
    map.getContainer().classList.remove("plan-measuring");
    showFrame();
  }
  // The turn, size and place that bring the two points on the plan onto the two on the map.
  function applyFit() {
    const [p1, q1, p2, q2] = fitPts.map((ll) => map.latLngToLayerPoint(ll));
    const vp = p2.subtract(p1), vq = q2.subtract(q1);
    const lp = Math.hypot(vp.x, vp.y), lq = Math.hypot(vq.x, vq.y);
    if (lp < 8 || lq < 8) { toast("Τα δύο σημεία είναι πολύ κοντά· διάλεξε σημεία πιο μακριά το ένα από το άλλο.", 6000); return false; }
    const s = lq / lp, d = Math.atan2(vq.y, vq.x) - Math.atan2(vp.y, vp.x);
    const rel = map.latLngToLayerPoint(p.center).subtract(p1);
    const moved = L.point(rel.x * Math.cos(d) - rel.y * Math.sin(d), rel.x * Math.sin(d) + rel.y * Math.cos(d)).multiplyBy(s);
    p.center = map.layerPointToLatLng(q1.add(moved));
    p.widthM *= s;
    setRot(p.rot + (d * 180) / Math.PI);
    return true;
  }
  map.on("click", (e) => {
    if (!fitting || fitPts.length >= 4) return;
    const i = fitPts.length;
    fitPts.push(e.latlng);
    L.circleMarker(e.latlng, { radius: 6, color: "#fff", weight: 2, fillColor: FIT_COLORS[i], fillOpacity: 1, interactive: false })
      .bindTooltip(FIT_LABELS[i], { permanent: true, direction: "top", offset: [0, -6] }).addTo(marks);
    if (i === 3) {
      const ok = applyFit();
      cancelFit();
      if (ok) toast("Η κάτοψη ταίριαξε με τον χάρτη. Αν θες, διόρθωσέ την ακόμα με τις λαβές.", 6000);
      return;
    }
    $("planFitInfo").textContent = FIT_TEXT[i + 1];
  });

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
  $("btnPlanFit").onclick = startFit;
  $("btnPlanFitCancel").onclick = cancelFit;
  // Small steps: one press = 1 % bigger or smaller / 0,1° (with Shift ten times as much), around the middle.
  document.querySelectorAll("#planNudge button").forEach((b) => (b.onclick = (e) => {
    const k = e.shiftKey ? 10 : 1, dir = +b.dataset.dir;
    if (b.dataset.what === "size") { scaleAbout(map.latLngToLayerPoint(p.center), Math.pow(1.01, dir * k)); syncControls(); update(); }
    else setRot(Math.round((p.rot + dir * 0.1 * k) * 10) / 10);
  }));
  $("btnPlanScaleCancel").onclick = cancelScale;
  $("btnPlanScaleOk").onclick = applyScale;
  $("planDist").addEventListener("keydown", (e) => { if (e.key === "Enter") applyScale(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { cancelScale(); cancelFit(); } });

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

  window.plan = { pickFile, start, clear, collect, load, askWhere, centerOn, active: () => !!p.image };
  refresh();
})();
