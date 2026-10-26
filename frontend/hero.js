// Start-screen scene in 3D (three.js, WebGL): a small planet at the bottom right (about a fifth of it in view) with an
// electrified town, and further away a solar park with big batteries and pylons to the town (hero-world.js).
// The theme decides the time of day: light theme = day with the sun, dark theme = night with the moon; a change
// plays a short sunset or sunrise. A click on the planet flies the camera to the town, another click or Esc flies
// back. window.heroScene.focus("town" | "park" | "overview") lets the start screen (home.js) show the part of the
// planet that fits the user's choice. It draws only while the start screen is shown, the tab is visible and the
// canvas is on screen; with prefers-reduced-motion it draws still pictures; without WebGL a painted backdrop.
import * as THREE from "./vendor/three/three.module.min.js";
import { buildWorld, SHOTS } from "./hero-world.js";
import { clamp, mix, ease } from "./hero-kit.js";

const home = document.getElementById("home");
if (home) setup(home);

function setup(home) {
  const root = document.documentElement;
  const isLight = () => root.dataset.theme === "light";
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let reduce = motion.matches;
  const cv = document.createElement("canvas");
  cv.id = "heroScene";
  cv.setAttribute("aria-hidden", "true");
  home.prepend(cv);
  let gl = null;
  try {
    gl = cv.getContext("webgl2", {
      antialias: (window.devicePixelRatio || 1) < 1.4, alpha: false, stencil: false, // sharp screens are smooth enough without it
      powerPreference: "high-performance", failIfMajorPerformanceCaveat: true,
    });
  } catch { gl = null; }
  // No (fast) WebGL: a calm painted planet made with CSS gradients instead.
  if (!gl) {
    const flat = document.createElement("div");
    flat.id = "heroScene";
    flat.className = "flat on";
    flat.setAttribute("aria-hidden", "true");
    cv.replaceWith(flat);
    window.heroScene = { focus() {} };
    return;
  }

  const renderer = new THREE.WebGLRenderer({ canvas: cv, context: gl });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.3, 900);
  const base = new THREE.PerspectiveCamera(30, 1, 0.3, 900); // the wide view without any sway: sun and moon sit in its sky
  const buffer = new THREE.Vector2();
  let world = null, W = 0, H = 0, quality = 1, raf = 0, last = 0, time = 0, lost = false, onScreen = true;

  // ---------- camera: named shots and smooth flights between them ----------
  const pose = { q: new THREE.Quaternion(), rad: 10, az: 0, el: 0, d: 1, ax: 0.5, ay: 0.5 };
  const copyPose = (p) => ({ q: p.q.clone(), rad: p.rad, az: p.az, el: p.el, d: p.d, ax: p.ax, ay: p.ay });

  // The free part of the screen (fractions, from the top-left): beside the cards on the right, or below them.
  const wrap = home.querySelector(".home-wrap");
  function freeArea() {
    let right = 0, bottom = 0;
    for (const el of wrap ? wrap.children : []) {
      if (el.hidden || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.top > H) continue;
      right = Math.max(right, Math.min(r.right, W));
      bottom = Math.max(bottom, Math.min(r.bottom, H));
    }
    const gap = 16, side = { x0: (right + gap) / W, y0: 0.2, x1: 1, y1: 1 }, below = { x0: 0.26, y0: (bottom + gap) / H, x1: 1, y1: 1 };
    const area = (a, wMin, hMin) => ((a.x1 - a.x0) * W >= wMin && (a.y1 - a.y0) * H >= hMin ? (a.x1 - a.x0) * (a.y1 - a.y0) * W * H : 0);
    const s = area(side, 170, 300), b = area(below, 420, 170);
    const pick = !s && !b ? { x0: 0.62, y0: 0.55, x1: 1, y1: 1 } : s >= b ? side : below; // no room at all: the lower right corner
    pick.wide = { x0: 0.4, y0: clamp(below.y0 - 0.12, 0.42, 0.56), x1: 0.985, y1: 0.97 }; // the wide view: town and park together
    return pick;
  }
  // A shot moved and set back or forth so that its subject sits inside the area (with a margin around it).
  const fitCam = new THREE.PerspectiveCamera(30, 1, 0.3, 900), pv = new THREE.Vector3();
  function shotPose(name) {
    const s = world.shot(name), pts = world.subject(name);
    const free = freeArea(), A = name === "overview" ? free.wide : free;
    const cx = (A.x0 + A.x1) / 2, cy = (A.y0 + A.y1) / 2, aw = (A.x1 - A.x0) * 0.86, ah = (A.y1 - A.y0) * 0.86;
    const shape = (aw * W) / (ah * H); // wide and low area: look flatter; narrow and tall: look more from above
    const el = name === "overview" ? s.el : s.el + clamp((1.4 - shape) * 0.08, -0.12, 0.1);
    const p = { q: s.q, rad: s.p.length(), az: s.az, el, d: s.d, ax: cx, ay: cy, area: A };
    fitCam.aspect = W / H;
    for (let k = 0; k < 5; k++) {
      place(fitCam, p, 0);
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9;
      for (const w of pts) {
        pv.copy(w).project(fitCam);
        const fx = (pv.x + 1) / 2, fy = (1 - pv.y) / 2;
        x0 = Math.min(x0, fx); x1 = Math.max(x1, fx); y0 = Math.min(y0, fy); y1 = Math.max(y1, fy);
      }
      p.ax = clamp(p.ax + cx - (x0 + x1) / 2, 0.2, 1.1);
      p.ay = clamp(p.ay + cy - (y0 + y1) / 2, 0.2, 1.2);
      p.d = clamp(p.d * Math.max((x1 - x0) / aw, (y1 - y0) / ah), s.dMin, s.dMax);
    }
    return p;
  }
  // Close to the town or the park, only the free area stays clear: the rest fades out behind the cards.
  function setMask(p) {
    if (!p.area || shotName === "overview") { cv.style.removeProperty("--hero-rx"); cv.style.removeProperty("--hero-ry"); return; }
    cv.style.setProperty("--hero-rx", `${clamp(((1 - p.area.x0) * 100 + 8) / 0.55, 40, 95).toFixed(1)}%`);
    cv.style.setProperty("--hero-ry", `${clamp(((1 - p.area.y0) * 100 + 8) / 0.55, 40, 95).toFixed(1)}%`);
  }
  function blend(a, b, t) {
    pose.q.slerpQuaternions(a.q, b.q, t);
    pose.rad = mix(a.rad, b.rad, t);
    pose.az = mix(a.az, b.az, t);
    pose.el = mix(a.el, b.el, t);
    pose.d = Math.exp(mix(Math.log(a.d), Math.log(b.d), t));
    pose.ax = mix(a.ax, b.ax, t);
    pose.ay = mix(a.ay, b.ay, t);
  }
  const up = new THREE.Vector3(), target = new THREE.Vector3(), dir = new THREE.Vector3();
  function place(cam, p, yaw) {
    up.set(0, 1, 0).applyQuaternion(p.q);
    target.copy(up).multiplyScalar(p.rad);
    const az = p.az + yaw;
    dir.set(Math.sin(az) * Math.cos(p.el), Math.sin(p.el), Math.cos(az) * Math.cos(p.el)).applyQuaternion(p.q);
    cam.position.copy(target).addScaledVector(dir, p.d);
    cam.up.copy(up);
    cam.lookAt(target);
    cam.setViewOffset(W, H, W * (0.5 - p.ax), H * (0.5 - p.ay), W, H);
    cam.updateMatrixWorld(); // the helper camera is never drawn, so its matrices are kept up to date here
  }

  let shotName = "overview", source = "api", from = null, to = null, zt = 1, dur = 2, softTimer = 0;
  // Fly to a shot; "click" flights (from the planet) can also be undone with Esc.
  function go(name, how, again = false) {
    if (!SHOTS[name]) name = "overview";
    source = how;
    if (name === shotName && !again) return;
    shotName = name;
    if (!world) return; // the camera starts there once the world is built
    to = shotPose(name);
    setMask(to);
    if (reduce || !active()) { blend(to, to, 1); zt = 1; if (reduce) still(); return; }
    from = copyPose(pose);
    dur = again ? 1.2 : name === "overview" || from.d > 10 ? 2.1 : 2.6;
    zt = 0;
    wake();
  }
  // The cards changed (another step of the start screen, the saved projects arrived) or the window: frame again.
  let reframeAsked = 0;
  function reframe() {
    if (reframeAsked || !world) return;
    reframeAsked = requestAnimationFrame(() => {
      reframeAsked = 0;
      if (!world) return;
      place(base, shotPose("overview"), 0);
      const p = shotPose(shotName);
      const moved = Math.abs(p.ax - pose.ax) + Math.abs(p.ay - pose.ay) + Math.abs(Math.log(p.d / pose.d));
      if (zt < 1) { to = p; setMask(p); } else if (moved > 0.01) go(shotName, source, true);
    });
  }
  function focus(name, soft = false) {
    clearTimeout(softTimer);
    if (soft) softTimer = setTimeout(() => go(name, "api"), 260); // pointer resting on a card: wait a moment
    else go(name, "api");
  }
  window.heroScene = { focus };

  // ---------- time of day, sway, pointer parallax ----------
  let nightLin = isLight() ? 0 : 1, night = nightLin, sway = 0, par = 0, parGoal = 0;
  function step(dt) {
    time += dt;
    nightLin += clamp((isLight() ? 0 : 1) - nightLin, -dt / 2.4, dt / 2.4);
    night = nightLin * nightLin * (3 - 2 * nightLin);
    if (zt < 1) { zt = Math.min(1, zt + dt / dur); blend(from, to, ease(zt)); }
    par += (parGoal - par) * (1 - Math.exp(-dt * 2.5));
    const calm = 1 - 0.5 * clamp((15.5 - pose.d) / 10);
    sway = (0.035 * Math.sin((time * Math.PI * 2) / 46) + par) * calm; // only around the vertical: no bobbing up and down
  }
  function draw(dt) {
    place(camera, pose, sway);
    world.update(time, dt, night, camera, base, buffer, target);
    renderer.render(world.scene, camera);
  }

  // ---------- running only when it is seen ----------
  const active = () => !lost && !document.hidden && !home.hidden && onScreen && cv.getClientRects().length > 0;
  function resize() {
    W = innerWidth;
    H = innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * quality);
    renderer.setSize(W, H, false);
    renderer.getDrawingBufferSize(buffer);
    camera.aspect = base.aspect = W / H;
    if (world) place(base, shotPose("overview"), 0);
  }
  let warm = 0, acc = 0, count = 0;
  function watchSpeed(dt) { // too slow for a while: draw fewer pixels (first down to the screen's 1:1, then a bit below)
    warm += dt;
    if (warm < 4) return;
    acc += dt;
    count++;
    if (acc < 2) return;
    const avg = acc / count;
    acc = count = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), floor = (dpr * quality > 1.01 ? 1 : 0.75) / dpr;
    // Only ever down, never back up: every resize clears the canvas, and going up and down again made the
    // picture flash black every few seconds on slower graphics cards.
    if (avg > 1 / 45 && quality > floor + 0.001) { quality = Math.max(floor, quality * 0.85); resize(); }
  }
  function frame(now) {
    raf = 0;
    if (!active()) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    step(dt);
    draw(dt);
    if (!cv.classList.contains("on")) cv.classList.add("on");
    watchSpeed(dt);
    raf = requestAnimationFrame(frame);
  }
  function still() {
    if (!world) return;
    if (W !== innerWidth || H !== innerHeight) resize();
    nightLin = night = isLight() ? 0 : 1;
    if (zt < 1) { zt = 1; blend(to, to, 1); }
    time = 2.5;
    sway = 0;
    draw(0);
    cv.classList.add("on");
  }
  function wake() {
    if (!world) return;
    if (W !== innerWidth || H !== innerHeight) { resize(); reframe(); }
    const on = active();
    if (!on) cv.classList.remove("on");
    if (reduce) { if (on) still(); return; }
    if (on && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  // ---------- clicks, keys, pointer ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const overPlanet = (e) => { ndc.set((e.clientX / W) * 2 - 1, 1 - (e.clientY / H) * 2); ray.setFromCamera(ndc, camera); return world.hits(ray.ray); };
  // Only the free background counts: cards, buttons and texts keep their own clicks.
  const bare = (e) => home.contains(e.target) && !e.target.closest("button, a, input, select, textarea, label, p, h1, h3, small, .proj, .home-head");
  home.addEventListener("click", (e) => {
    if (!world || !active() || !bare(e)) return;
    if (shotName !== "overview") go("overview", "click");
    else if (overPlanet(e)) go("town", "click");
  });
  home.addEventListener("pointermove", (e) => {
    parGoal = (e.clientX / (W || 1) - 0.5) * 0.05;
    if (!world || !active()) return;
    const want = bare(e) ? (shotName !== "overview" ? "zoom-out" : overPlanet(e) ? "zoom-in" : "") : "";
    if (home.style.cursor !== want) home.style.cursor = want;
  });
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !world || !active() || shotName === "overview" || source !== "click") return;
    if (document.querySelector(".home-sources-box:not([hidden])")) return; // a window on top closes first
    e.stopPropagation(); // only the zoom goes back; the start screen stays as it is
    go("overview", "click");
  }, true);

  document.addEventListener("visibilitychange", wake);
  addEventListener("resize", wake);
  new MutationObserver(wake).observe(home, { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(() => (reduce ? still() : wake())).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  new IntersectionObserver((list) => { onScreen = list[list.length - 1].isIntersecting; wake(); }).observe(cv);
  if (wrap && "ResizeObserver" in window) new ResizeObserver(reframe).observe(wrap);
  motion.addEventListener("change", () => { reduce = motion.matches; wake(); });
  cv.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lost = true; cancelAnimationFrame(raf); raf = 0; });
  cv.addEventListener("webglcontextrestored", () => {
    lost = false;
    if (!world) return;
    world.dispose();
    world = null;
    buildWorld(renderer).then((w) => { world = w; resize(); wake(); });
  });
  addEventListener("pagehide", (e) => { if (!e.persisted && world) { cancelAnimationFrame(raf); world.dispose(); renderer.dispose(); world = null; } });

  // Build the world after the start screen has been painted, compile its shaders in the background, then show it.
  const start = async () => {
    const w = await buildWorld(renderer);
    if (!cv.isConnected) { w.dispose(); return; }
    world = w;
    resize();
    const p = shotPose(shotName);
    blend(p, p, 1);
    setMask(p);
    place(camera, pose, 0);
    world.update(0, 0, night, camera, base, buffer, target);
    const show = () => { if (world) wake(); };
    renderer.compileAsync(world.scene, camera).then(show, show);
  };
  if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 800 });
  else setTimeout(start, 120);
}
