// 3D view of the finished design (three.js): the roof areas, the panels (row tilt and direction), obstacles and trees,
// optionally the whole building with walls of a chosen height, and the sun shadows. It only reads what the project
// already holds (app.js globals) and calculates nothing: it is a picture, not a result. Drag = turn, wheel = zoom,
// Shift+drag or right drag = move.
import * as THREE from "./vendor/three/three.module.min.js";

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const MONTHS = ["Ιαν", "Φεβ", "Μαρ", "Απρ", "Μάι", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ"];
let box = null, renderer = null, scene = null, camera = null, root = null, sun = null, raf = 0, S = null;
const view = { whole: false, height: 10, shadows: true, month: 5, hour: 13, theta: 0.6, phi: 1.0, dist: 40, size: 20, target: new THREE.Vector3() };

// ---------- Project data -> local metres ([east, north]; in the scene x = east, y = up, z = -north) ----------
function build() {
  const areaLayers = areas.getLayers(), polys = areaLayers.map(latlngsOf);
  const all = polys.flat();
  if (!all.length) return null;
  const lat0 = all.reduce((a, p) => a + p[0], 0) / all.length, lng0 = all.reduce((a, p) => a + p[1], 0) / all.length;
  const kx = 111320 * Math.cos(lat0 * DEG), ky = 110540;
  const ring = (p) => p.map((q) => [(q[1] - lng0) * kx, (q[0] - lat0) * ky]);
  const eave = view.whole ? view.height : 0;

  // Every area is a roof face; a face with a roof slope rises away from its downhill direction (the azimuth).
  const faces = areaLayers.map((l, i) => {
    const f = l.pvFace, pts = ring(polys[i]);
    const tilt = (f && (f.roof_tilt_deg ?? f.tilt_deg)) || 0, az = f ? f.azimuth_deg : 180;
    const d = [Math.sin(az * DEG), Math.cos(az * DEG)];
    const lo = Math.max(...pts.map((p) => p[0] * d[0] + p[1] * d[1]));
    const z = (p) => eave + (tilt > 0 ? (lo - (p[0] * d[0] + p[1] * d[1])) * Math.tan(tilt * DEG) : 0);
    return { pts, z };
  });
  const inside = (p, pts) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if ((pts[i][1] > p[1]) !== (pts[j][1] > p[1]) &&
        p[0] < ((pts[j][0] - pts[i][0]) * (p[1] - pts[i][1])) / (pts[j][1] - pts[i][1]) + pts[i][0]) c = !c;
    }
    return c;
  };
  const roofAt = (p) => { const f = faces.find((q) => inside(p, q.pts)); return f ? f.z(p) : null; };
  return { lat0, ring, eave, faces, roofAt };
}

const V = (p, y) => new THREE.Vector3(p[0], y, -p[1]);
const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide, ...o });
const centre = (pts) => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];

function polyMesh(pts, zOf, material) {
  const tri = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p[0], p[1])), []);
  const pos = [];
  pts.forEach((p) => pos.push(p[0], zOf(p), -p[1]));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(tri.flat());
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.castShadow = m.receiveShadow = true;
  return m;
}

// Vertical walls and a flat top over a footprint.
function prism(pts, y0, y1, material) {
  const n = pts.length, pos = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    pos.push(a[0], y0, -a[1], b[0], y0, -b[1], b[0], y1, -b[1], a[0], y0, -a[1], b[0], y1, -b[1], a[0], y1, -a[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const walls = new THREE.Mesh(g, material);
  walls.castShadow = walls.receiveShadow = true;
  const grp = new THREE.Group();
  grp.add(walls, polyMesh(pts, () => y1, material));
  return grp;
}

function populate() {
  root.clear();
  const light = document.documentElement.dataset.theme === "light";
  const col = {
    ground: light ? 0xcfd8c6 : 0x1d2a26, roof: light ? 0xb8b2a8 : 0x6b7280, wall: light ? 0xf1ede4 : 0x9aa3b2,
    obstacle: 0xe11d48, panel: 0x1e3a8a, frame: 0x93c5fd, trunk: 0x7c5a3a, crown: 0x22a55a,
  };
  scene.background = new THREE.Color(light ? 0xe8eef7 : 0x0b1020);
  box.style.background = light ? "#e8eef7" : "#0b1020";

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), mat(col.ground));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  const grid = new THREE.GridHelper(200, 100, light ? 0x94a3b8 : 0x334155, light ? 0xcbd5e1 : 0x1e293b);
  root.add(ground, grid);

  S.faces.forEach((f) => {
    if (view.whole) root.add(prism(f.pts, 0, S.eave, mat(col.wall)));
    root.add(polyMesh(f.pts, (p) => f.z(p) + 0.001, mat(col.roof)));
  });

  // Panels: tilted rectangles built from the footprint; rows face the azimuth and rise towards the back.
  const lay = state.layout || {}, set = settings();
  const pos = [], edges = [];
  panelsLayer.getLayers().map(latlngsOf).forEach((pl, i) => {
    const pts = S.ring(pl);
    const k = lay.panel_face && lay.faces ? lay.faces[lay.panel_face[i]] : null;
    const tilt = (k ? k.tilt_deg : lay.tilt_deg ?? set.tilt_deg) || 0;
    const az = k ? k.azimuth_deg : lay.azimuth_deg ?? set.azimuth_deg;
    const d = [Math.sin(az * DEG), Math.cos(az * DEG)];
    const dots = pts.map((p) => p[0] * d[0] + p[1] * d[1]), hi = Math.max(...dots);
    const flush = set.mounting === "flush";
    const base = (S.roofAt(centre(pts)) ?? S.eave) + 0.08;
    const q = pts.map((p, j) => V(p, base + (flush ? 0 : 0.3 + (hi - dots[j]) * Math.tan(tilt * DEG))));
    [0, 1, 2, 0, 2, 3].forEach((j) => pos.push(q[j].x, q[j].y, q[j].z));
    q.forEach((v, j) => { const w = q[(j + 1) % q.length]; edges.push(v.x, v.y, v.z, w.x, w.y, w.z); });
  });
  if (pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: col.panel, roughness: 0.3, metalness: 0.5, side: THREE.DoubleSide }));
    m.castShadow = m.receiveShadow = true;
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.Float32BufferAttribute(edges, 3));
    root.add(m, new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: col.frame })));
  }

  // Obstacles (prisms) and trees (trunk and crown): on the roof when inside an area, otherwise on the ground.
  keepouts.getLayers().forEach((l) => {
    const pts = S.ring(latlngsOf(l)), h = l.pvHeight || 0, c = centre(pts);
    const y0 = S.roofAt(c) ?? 0;
    if (l.pvTree) {
      const r = Math.max(0.3, ...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
      const H = h || 4, trunk = Math.min(H * 0.45, 3);
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, trunk, 8), mat(col.trunk));
      t.position.set(c[0], y0 + trunk / 2, -c[1]);
      const cr = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat(col.crown));
      cr.scale.set(r, Math.max(0.5, (H - trunk) / 2), r);
      cr.position.set(c[0], y0 + trunk + (H - trunk) / 2, -c[1]);
      t.castShadow = cr.castShadow = true;
      root.add(t, cr);
    } else {
      root.add(prism(pts, y0, y0 + Math.max(h, 0.2), mat(col.obstacle, { transparent: true, opacity: h ? 0.9 : 0.5 })));
    }
  });
  // The parapet of the shading step, when it is on.
  parapetObstacles().forEach((o) => {
    const pts = S.ring(o.polygon), y0 = S.roofAt(centre(pts)) ?? S.eave;
    root.add(prism(pts, y0, y0 + o.height_m, mat(col.wall)));
  });

  const all = S.faces.flatMap((f) => f.pts);
  const lo = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))];
  const hi = [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
  view.target.set((lo[0] + hi[0]) / 2, S.eave / 2, -(lo[1] + hi[1]) / 2);
  view.size = Math.max(hi[0] - lo[0], hi[1] - lo[1], 6);
}

// The sun on the 21st of the chosen month at the chosen solar hour (a picture, not a calculation of results).
function updateSun() {
  const doy = [21, 52, 80, 111, 141, 172, 202, 233, 264, 294, 325, 355][view.month];
  const dec = 23.45 * Math.sin(((360 / 365) * (284 + doy)) * DEG) * DEG;
  const lat = S.lat0 * DEG, ha = (view.hour - 12) * 15 * DEG;
  const el = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha) * Math.cos(dec), Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(ha));
  const up = el > 0.02, r = view.size * 3 + 40;
  sun.position.set(Math.sin(az) * Math.cos(el) * r + view.target.x, Math.sin(el) * r, -Math.cos(az) * Math.cos(el) * r + view.target.z);
  sun.target.position.copy(view.target);
  sun.intensity = up ? 2.4 : 0.05;
  sun.castShadow = view.shadows && up;
  const s = view.size * 1.6;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: r * 2.5 });
  sun.shadow.camera.updateProjectionMatrix();
  $("v3Info").textContent = up ? `Ήλιος: ύψος ${Math.round(el / DEG)}°` : "Ο ήλιος είναι κάτω από τον ορίζοντα.";
}

// ---------- Camera and loop ----------
function resize() {
  const w = box.clientWidth, h = box.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
function frame() {
  raf = requestAnimationFrame(frame);
  const { theta, phi, dist, target } = view;
  camera.position.set(target.x + dist * Math.sin(phi) * Math.sin(theta), target.y + dist * Math.cos(phi), target.z + dist * Math.sin(phi) * Math.cos(theta));
  camera.lookAt(target);
  renderer.render(scene, camera);
}

function refresh() {
  S = build();
  if (!S) return false;
  populate();
  updateSun();
  return true;
}

function setup() {
  box = document.createElement("div");
  box.id = "view3d";
  box.innerHTML = `
    <div class="v3-bar">
      <b>3D προβολή</b>
      <span class="seg" role="group"><button type="button" data-w="0">Μόνο ταράτσα</button><button type="button" data-w="1">Όλο το κτίριο</button></span>
      <label id="v3HeightRow">Ύψος κτιρίου (m) <input id="v3Height" type="number" min="2" max="100" step="0.5"></label>
      <label><input id="v3Shadows" type="checkbox"> Σκιές ήλιου</label>
      <label>Μήνας <select id="v3Month"></select></label>
      <label>Ώρα <span id="v3HourLabel"></span> <input id="v3Hour" type="range" min="6" max="20" step="0.5"></label>
      <span id="v3Info" class="muted small"></span>
      <span class="v3-sp"></span>
      <button id="v3Close" type="button" class="ghost">Κλείσιμο</button>
    </div>
    <div class="v3-hint">Σύρε για περιστροφή · ρόδα για ζουμ · Shift+σύρε για μετακίνηση</div>`;
  document.body.append(box);
  const cv = document.createElement("canvas");
  box.prepend(cv);
  try { renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true }); } catch { renderer = null; }
  if (!renderer) { box.remove(); box = null; toast("Η συσκευή σου δεν υποστηρίζει 3D (WebGL)."); return false; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000);
  root = new THREE.Group();
  sun = new THREE.DirectionalLight(0xfff4d6, 2.4);
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  scene.add(root, new THREE.HemisphereLight(0xdbeafe, 0x334155, 0.9), sun, sun.target);

  MONTHS.forEach((m, i) => $("v3Month").add(new Option(m, i)));
  box.sync = () => {
    box.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", (b.dataset.w === "1") === view.whole));
    $("v3HeightRow").hidden = !view.whole;
    $("v3Height").value = view.height;
    $("v3Shadows").checked = view.shadows;
    $("v3Month").value = view.month;
    $("v3Hour").value = view.hour;
    $("v3HourLabel").textContent = `${Math.floor(view.hour)}:${view.hour % 1 ? "30" : "00"}`;
  };
  box.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { view.whole = b.dataset.w === "1"; box.sync(); refresh(); }));
  $("v3Height").oninput = () => { view.height = Math.max(2, +$("v3Height").value || 10); refresh(); };
  $("v3Shadows").onchange = () => { view.shadows = $("v3Shadows").checked; updateSun(); };
  $("v3Month").onchange = () => { view.month = +$("v3Month").value; updateSun(); };
  $("v3Hour").oninput = () => { view.hour = +$("v3Hour").value; box.sync(); updateSun(); };
  $("v3Close").onclick = close;

  // Mouse / touch: one pointer turns (Shift or right button moves), the wheel zooms.
  let drag = null;
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 }; });
  cv.addEventListener("pointerup", () => { drag = null; });
  cv.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const k = view.dist * 0.0016;
      const right = new THREE.Vector3(Math.cos(view.theta), 0, -Math.sin(view.theta));
      const fwd = new THREE.Vector3(-Math.sin(view.theta), 0, -Math.cos(view.theta));
      view.target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k);
    } else {
      view.theta -= dx * 0.006;
      view.phi = Math.min(1.5, Math.max(0.12, view.phi - dy * 0.006));
    }
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.dist = Math.min(1500, Math.max(3, view.dist * Math.exp(e.deltaY * 0.001)));
  }, { passive: false });
  addEventListener("resize", () => box.classList.contains("on") && resize());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && box.classList.contains("on")) { close(); e.stopImmediatePropagation(); }
  }, true);
  return true;
}

function open() {
  if (!areas.getLayers().length) return toast("Σχεδίασε πρώτα μια περιοχή στον χάρτη για να δεις το 3D.");
  if (!box && !setup()) return;
  box.classList.add("on");
  box.sync();
  resize();
  if (!refresh()) return close();
  view.dist = view.size * 2.2;
  cancelAnimationFrame(raf);
  frame();
}
function close() {
  cancelAnimationFrame(raf);
  box?.classList.remove("on");
}

$("btn3d").onclick = open;
window.view3d = { open, close };
