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
  const shotPose = (name) => { const s = world.shot(name); return { q: s.q, rad: s.p.length(), az: s.az, el: s.el, d: s.d, ax: s.ax, ay: s.ay }; };
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
    const fit = Math.pow(clamp(1.7 / (W / H), 1, 1.8), 0.85); // narrow window: step back so that the town still fits
    up.set(0, 1, 0).applyQuaternion(p.q);
    target.copy(up).multiplyScalar(p.rad);
    const az = p.az + yaw;
    dir.set(Math.sin(az) * Math.cos(p.el), Math.sin(p.el), Math.cos(az) * Math.cos(p.el)).applyQuaternion(p.q);
    cam.position.copy(target).addScaledVector(dir, p.d * fit);
    cam.up.copy(up);
    cam.lookAt(target);
    cam.setViewOffset(W, H, W * (0.5 - p.ax), H * (0.5 - p.ay), W, H);
    cam.updateMatrixWorld(); // the helper camera is never drawn, so its matrices are kept up to date here
  }

  let shotName = "overview", source = "api", from = null, to = null, zt = 1, dur = 2, softTimer = 0;
  // Fly to a shot; "click" flights (from the planet) can also be undone with Esc.
  function go(name, how) {
    if (!SHOTS[name]) name = "overview";
    source = how;
    if (name === shotName) return;
    shotName = name;
    if (!world) return; // the camera starts there once the world is built
    to = shotPose(name);
    if (reduce || !active()) { blend(to, to, 1); zt = 1; if (reduce) still(); return; }
    from = copyPose(pose);
    dur = name === "overview" || from.d > 10 ? 2.1 : 2.6;
    zt = 0;
    wake();
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
  let warm = 0, acc = 0, count = 0, fast = 0, ceiling = 1.08; // ceiling: just below the level that was too slow
  function watchSpeed(dt) { // too slow for a while: draw fewer pixels (first down to the screen's 1:1, then a bit below)
    warm += dt;
    if (warm < 4) return;
    acc += dt;
    count++;
    if (acc < 2) return;
    const avg = acc / count;
    acc = count = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), floor = (dpr * quality > 1.01 ? 1 : 0.75) / dpr;
    fast = avg < 1 / 57 ? fast + 1 : 0;
    if (avg > 1 / 45 && quality > floor + 0.001) { ceiling = quality; quality = Math.max(floor, quality * 0.85); resize(); }
    else if (fast >= 3) { // smooth again for a while: take some sharpness back, carefully
      fast = 0;
      ceiling = Math.min(1.08, ceiling * 1.02);
      const next = Math.min(1, ceiling * 0.92, quality * 1.1);
      if (next > quality + 0.01) { quality = next; resize(); }
    }
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
    if (W !== innerWidth || H !== innerHeight) resize();
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
    e.stopPropagation(); // only the zoom goes back; the start screen stays as it is
    go("overview", "click");
  }, true);

  document.addEventListener("visibilitychange", wake);
  addEventListener("resize", wake);
  new MutationObserver(wake).observe(home, { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(() => (reduce ? still() : wake())).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  new IntersectionObserver((list) => { onScreen = list[list.length - 1].isIntersecting; wake(); }).observe(cv);
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
    place(camera, pose, 0);
    world.update(0, 0, night, camera, base, buffer, target);
    const show = () => { if (world) wake(); };
    renderer.compileAsync(world.scene, camera).then(show, show);
  };
  if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 800 });
  else setTimeout(start, 120);
}
