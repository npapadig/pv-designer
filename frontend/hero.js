// Start-screen scene: a small painted planet (about a fifth of it shows, bottom right) with a little electrified town
// of modern white houses with solar roofs, EV chargers and cars, and, further away, a solar park with big batteries
// connected to the town by pylons. Energy travels only through cables. The theme decides day (light: sun, the park
// charges the batteries and feeds the town) or night (dark: moon, batteries feed the town). A click on the planet zooms
// in towards the town; another click or Esc zooms out. Pure canvas, no assets. Stops itself when the tab or the screen
// is hidden and is drawn once, still, with prefers-reduced-motion.
(() => {
  const home = document.getElementById("home");
  if (!home) return;
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cv = document.createElement("canvas");
  cv.id = "heroScene";
  cv.setAttribute("aria-hidden", "true");
  home.prepend(cv);
  const g = cv.getContext("2d");

  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const rnd = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const isLight = () => root.dataset.theme === "light";
  const hexCache = new Map();
  const hex = (s) => { let v = hexCache.get(s); if (!v) { v = [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)); hexCache.set(s, v); } return v; };
  const rgbMix = (a, b, t) => a.map((v, i) => Math.round(mix(v, b[i], t)));
  const lerpCol = (a, b, t) => `rgb(${rgbMix(a, b, t).join(",")})`;

  let VW = 0, VH = 0, R = 400, k = 0.57, CX = 0, CY = 0;
  let night = isLight() ? 0 : 1; // 0 = day, 1 = night; eases when the theme changes
  let zt = 0, z = 0; // zoom target and current (0 = whole view, 1 = close to the town)
  let lv = night ? 0.9 : 0.3; // battery level: charges by day, drains by night
  let pulses = [], last = 0, raf = 0;
  const C = (d, n, amount = 1) => lerpCol(hex(d), hex(n), night * amount); // colour for the current time of day

  // Layout on the planet, by angle from the top (radians); the planet is drawn in a frame centred on its middle.
  const CITY0 = -0.05, CITY_STEP = 0.1, HOUSES = 6, CITY_MID = CITY0 + CITY_STEP * (HOUSES - 1) / 2;
  const PYLONS = [-0.5, -0.4, -0.3, -0.2, -0.1];
  const PARK0 = -0.9, PARK_STEP = 0.0235, PANELS = 12, BATT = [-0.65, -0.6, -0.55];
  const houseAngle = (i) => CITY0 + i * CITY_STEP;
  const pol = (a, r) => [r * Math.sin(a), -r * Math.cos(a)];

  // Cables as polylines in the planet frame (rebuilt when the size changes).
  let PARKBUS, MAIN, TWIN, TAPS;
  const lens = (pts) => { let tot = 0; const c = [0]; for (let j = 1; j < pts.length; j++) { tot += Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]); c.push(tot); } return { pts, c, tot }; };
  const arc = (a0, a1, r) => { const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 0.008)), o = []; for (let j = 0; j <= n; j++) o.push(pol(mix(a0, a1, j / n), r)); return o; };
  const sagging = (r, drop) => { const o = []; for (let p = 0; p < PYLONS.length - 1; p++) for (let j = 0; j < 10; j++) { const s = j / 10; o.push(pol(mix(PYLONS[p], PYLONS[p + 1], s), r - drop * Math.sin(Math.PI * s))); } o.push(pol(PYLONS[PYLONS.length - 1], r)); return o; };
  function buildPaths() {
    const under = R - 6 * k, top = R + 38 * k;
    PARKBUS = lens(arc(PARK0, -0.53, under));
    MAIN = lens([...arc(-0.53, PYLONS[0], under), pol(PYLONS[0], top), ...sagging(top, 4 * k), pol(PYLONS[PYLONS.length - 1], under), ...arc(PYLONS[PYLONS.length - 1], houseAngle(HOUSES - 1) + 0.05, under)]);
    TWIN = sagging(R + 31 * k, 4 * k);
    TAPS = Array.from({ length: HOUSES }, (_, i) => { const a = houseAngle(i) - 24 * k / R; return lens([pol(a, under), pol(a, R + 33 * k)]); });
  }
  const along = (w, f) => {
    const d = clamp(f) * w.tot; let j = 1;
    while (j < w.pts.length - 1 && w.c[j] < d) j++;
    const u = (d - w.c[j - 1]) / ((w.c[j] - w.c[j - 1]) || 1), a = w.pts[j - 1], b = w.pts[j];
    return [mix(a[0], b[0], u), mix(a[1], b[1], u)];
  };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    VW = innerWidth; VH = innerHeight;
    cv.width = Math.round(VW * dpr); cv.height = Math.round(VH * dpr);
    R = clamp(Math.min(VH * 0.95, VW * 0.62), 260, 1100);
    k = R / 560;
    CX = VW * 0.64; CY = VH + R * 0.5;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildPaths();
  }

  function glow(x, y, r, col, a) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col.replace("A", a));
    gr.addColorStop(1, col.replace("A", 0));
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  const quad = (pts) => { g.beginPath(); pts.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
  // Draws something standing on the planet at angle a, in units where 1 = k pixels, ground at y = 0, up is negative.
  const place = (a, fn, ...args) => { g.save(); g.rotate(a); g.translate(0, -R); g.scale(k, k); fn(...args); g.restore(); };

  // ---- things on the planet (local units) ----
  function tree(s, sh) {
    g.fillStyle = C("#7a5636", "#2a2030"); g.fillRect(-0.9 * s, -5 * s, 1.8 * s, 5 * s);
    [[0, -9, 5.2, "#3f9a52", "#14402e"], [-2.6, -7, 3.6, "#47a85a", "#184a34"], [2.8, -7.5, 3.8, "#37893f", "#123a28"]].forEach(([x, y, r, d, n]) => {
      g.fillStyle = C(d, n); g.beginPath(); g.arc(x * s, y * s, r * s, 0, TAU); g.fill();
    });
    g.fillStyle = `rgba(255,220,120,${0.22 * (1 - night)})`; g.beginPath(); g.arc(1.8 * s, -10.5 * s, 2.6 * s, 0, TAU); g.fill();
    if (sh) { g.fillStyle = "rgba(0,0,0,0.12)"; g.beginPath(); g.ellipse(0, 0.6, 5 * s, 1.2, 0, 0, TAU); g.fill(); }
  }
  function bush(r) { g.fillStyle = C("#3f9a52", "#164430"); g.beginPath(); g.arc(0, -r * 0.6, r, 0, TAU); g.fill(); g.fillStyle = C("#58b866", "#1d5538"); g.beginPath(); g.arc(-r * 0.3, -r, r * 0.55, 0, TAU); g.fill(); }
  const CARS = [["#8a909a", "#3a4050"], ["#eceff5", "#6a7088"], ["#55657e", "#232c42"], ["#b9bfca", "#4a5066"]];
  function car(i) {
    const [d, n] = CARS[i % CARS.length];
    g.fillStyle = C(d, n); rr(-12, -6.4, 24, 4.6, 2); g.fill();
    g.beginPath(); g.moveTo(-7, -6.2); g.quadraticCurveTo(-4.5, -10.5, 0, -10.5); g.quadraticCurveTo(5, -10.5, 8, -6.2); g.fill();
    g.fillStyle = C("#7fb3d6", "#1a2236"); g.beginPath(); g.moveTo(-5.4, -6.6); g.quadraticCurveTo(-3.6, -9.2, -0.3, -9.2); g.lineTo(-0.3, -6.6); g.fill();
    g.beginPath(); g.moveTo(0.9, -6.6); g.lineTo(0.9, -9.2); g.quadraticCurveTo(4, -9.2, 5.8, -6.6); g.fill();
    g.fillStyle = "#1a2036"; [-7, 7].forEach((x) => { g.beginPath(); g.arc(x, -1.8, 2.1, 0, TAU); g.fill(); });
    g.fillStyle = "#aab3c8"; [-7, 7].forEach((x) => { g.beginPath(); g.arc(x, -1.8, 0.8, 0, TAU); g.fill(); });
    if (night > 0.3) { g.fillStyle = `rgba(255,240,190,${night})`; g.fillRect(11.4, -5.4, 1.2, 1.2); }
  }
  function house(i) {
    const flip = rnd(i * 3 + 5) > 0.5 ? -1 : 1;
    const lit = clamp((night - 0.25 - 0.4 * rnd(i + 21)) * 3);
    const wall = C("#f4f2ec", "#444c70", 0.8), wall2 = C("#e6e3da", "#3a4262", 0.8);
    g.save(); g.scale(flip, 1);
    // lower floor, upper floor
    g.fillStyle = wall; g.fillRect(-22, -18, 44, 18); g.fillRect(-4, -34, 26, 16);
    g.fillStyle = wall2; g.fillRect(-22, -2, 44, 2);
    // flat roofs with a thin edge
    g.fillStyle = C("#3b414c", "#1c2132"); g.fillRect(-5, -35.2, 28, 1.6); g.fillRect(-23, -19.2, 19, 1.4);
    // garage door, wood cladding, charger on the wall, front door
    g.fillStyle = C("#3a3f49", "#171b28"); rr(-20, -14, 14, 14, 1); g.fill();
    g.strokeStyle = C("#565c68", "#262c40"); g.lineWidth = 0.5;
    for (let j = 1; j < 4; j++) { g.beginPath(); g.moveTo(-20, -14 + j * 3.5); g.lineTo(-6, -14 + j * 3.5); g.stroke(); }
    g.fillStyle = C("#a8703f", "#4a3030"); g.fillRect(-4, -34, 4, 34);
    g.strokeStyle = C("#7e4f2b", "#33202a"); g.lineWidth = 0.4;
    for (let x = -3; x < 0; x += 1) { g.beginPath(); g.moveTo(x, -34); g.lineTo(x, 0); g.stroke(); }
    g.fillStyle = C("#3c4047", "#1b1e28"); rr(-5.8, -10, 1.8, 5, 0.6); g.fill();
    g.strokeStyle = "#35e0cf"; g.lineWidth = 0.5; g.beginPath(); g.moveTo(-5.2, -9); g.lineTo(-4.4, -7.6); g.lineTo(-5.4, -7.4); g.lineTo(-4.6, -6); g.stroke();
    // big glass surfaces with warm light
    const glass = lerpCol(hex("#a9d2ea"), hex("#ffd27a"), clamp(0.15 + lit * 0.85));
    g.fillStyle = glass; g.fillRect(1, -31, 19, 10); g.fillRect(2, -15.5, 18, 12);
    g.fillStyle = `rgba(255,255,255,${0.35 * (1 - lit)})`;
    g.beginPath(); g.moveTo(1, -31); g.lineTo(8, -31); g.lineTo(1, -23); g.fill();
    g.fillStyle = C("#3b414c", "#1c2132"); g.fillRect(10.2, -31, 0.7, 10); g.fillRect(10.7, -15.5, 0.7, 12);
    g.fillStyle = C("#6a4a30", "#2a2030"); g.fillRect(-26, -19.2, 22, 0.8); // terrace railing line
    // solar panels: on the upper roof and on the terrace roof (low slope)
    const panel = (x, y) => {
      g.fillStyle = lerpCol(hex("#2c63c9"), hex("#17306b"), night * 0.8);
      quad([[x, y], [x + 4, y - 1.4], [x + 4, y - 2.8], [x, y - 1.4]]); g.fill();
      g.strokeStyle = `rgba(170,210,255,${0.55 - 0.3 * night})`; g.lineWidth = 0.3; g.stroke();
    };
    for (let j = 0; j < 5; j++) panel(-3 + j * 5, -35.2);
    for (let j = 0; j < 3; j++) panel(-21 + j * 5.5, -19.2);
    g.restore();
    // car parked in front of the garage and bushes (not mirrored, so it stays in front of the same side)
    g.save(); g.translate(-13 * flip, 2); g.scale(flip, 1); car(i + (rnd(i) > 0.5 ? 1 : 0)); g.restore();
    g.save(); g.translate(24, 0); bush(3.3); g.restore();
    g.save(); g.translate(-25, 0); bush(2.6); g.restore();
    return lit;
  }
  function panelRow(j) {
    const r = rnd(j + 40);
    for (let row = 0; row < 2; row++) {
      g.save();
      if (row === 0) { g.translate(0, -3); g.scale(0.78, 0.78); } else g.translate(7, 0);
      g.strokeStyle = C("#6b7385", "#2a3150"); g.lineWidth = 0.8; g.beginPath(); g.moveTo(-2.5, 0); g.lineTo(-2.5, -3.6); g.moveTo(3, 0); g.lineTo(3, -6); g.stroke();
      g.fillStyle = lerpCol(hex(row ? "#2f67cc" : "#4a79d0"), hex(row ? "#162c63" : "#1f3a78"), night * 0.8);
      quad([[-5.5, -3.4], [5.5, -7.2], [5.5, -9], [-5.5, -5.2]]); g.fill();
      g.strokeStyle = `rgba(180,215,255,${0.5 - 0.3 * night})`; g.lineWidth = 0.3; g.stroke();
      g.restore();
    }
    void r;
  }
  function battery(j, stack) {
    for (let s = 0; s < stack; s++) {
      const y = -s * 10.4;
      g.fillStyle = C("#dfe3e9", "#4a5272", 0.8); rr(-12, y - 10, 24, 10, 0.8); g.fill();
      g.fillStyle = "#2dd4bf"; g.fillRect(-12, y - 6, 24, 1.4);
      g.strokeStyle = C("#aab1bd", "#2b3150"); g.lineWidth = 0.3;
      for (let x = -9; x <= 9; x += 3) { g.beginPath(); g.moveTo(x, y - 9.4); g.lineTo(x, y - 6.8); g.moveTo(x, y - 4.4); g.lineTo(x, y - 0.6); g.stroke(); }
      const led = lv > 0.3 ? "#4ade80" : "#ffb547";
      g.fillStyle = led; g.fillRect(8.5, y - 9, 2, 1.2);
    }
  }
  function pylon(a, t) {
    place(a, () => {
      g.strokeStyle = C("#6b7385", "#3a4260"); g.lineWidth = 0.9; g.lineCap = "round";
      g.beginPath(); g.moveTo(-4, 0); g.lineTo(-1.2, -38); g.moveTo(4, 0); g.lineTo(1.2, -38);
      g.moveTo(-9, -38); g.lineTo(9, -38); g.moveTo(-7, -31); g.lineTo(7, -31);
      for (let y = 0; y > -30; y -= 10) { g.moveTo(-4 + y * -0.07, y); g.lineTo(4 + y * 0.07, y - 10); g.moveTo(4 + y * 0.07, y); g.lineTo(-4 + y * -0.07, y - 10); }
      g.stroke();
      if (night > 0.3) { const bl = 0.5 + 0.5 * Math.sin(t * 3 + a * 9); g.fillStyle = `rgba(255,80,80,${night * bl})`; g.beginPath(); g.arc(0, -40, 1.2, 0, TAU); g.fill(); }
    });
  }

  function wire(pts, w, dark, light) {
    g.beginPath(); pts.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = dark; g.lineWidth = w * 1.9; g.stroke();
    g.strokeStyle = light; g.lineWidth = w * 0.8; g.stroke();
  }

  function draw(t) {
    const e = z * z * (3 - 2 * z); // eased zoom
    const day = 1 - night;
    g.clearRect(0, 0, VW, VH);
    // sky over the whole window (screen space)
    const sg = g.createLinearGradient(0, 0, 0, VH);
    sg.addColorStop(0, lerpCol(hex("#3d8fe8"), hex("#070b22"), night)); sg.addColorStop(1, lerpCol(hex("#c9ecff"), hex("#17224f"), night));
    g.fillStyle = sg; g.fillRect(0, 0, VW, VH);
    if (night > 0.02) {
      for (let i = 0; i < 90; i++) {
        const tw = 0.55 + 0.45 * Math.sin(t * 1.6 + i * 3.1);
        g.globalAlpha = night * tw * (0.35 + 0.5 * rnd(i + 9));
        g.fillStyle = "#fff";
        g.beginPath(); g.arc(rnd(i) * VW, rnd(i + 50) * VH * 0.7, 0.6 + rnd(i + 99) * 1.1, 0, TAU); g.fill();
      }
      g.globalAlpha = 1;
    }
    // sun (day) / moon (night): fixed in the sky, only the theme decides which one is up
    const ax = VW * 0.8, ay = VH * 0.27, sr = clamp(Math.min(VW, VH) * 0.045, 18, 52);
    if (day > 0.02) {
      g.globalAlpha = day;
      glow(ax, ay, sr * 5, "rgba(255,190,80,A)", 0.5);
      g.fillStyle = "#ffd25e"; g.beginPath(); g.arc(ax, ay, sr, 0, TAU); g.fill();
      g.strokeStyle = "rgba(255,214,110,0.55)"; g.lineWidth = Math.max(1.5, sr * 0.1); g.lineCap = "round";
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * TAU + t * 0.2, r1 = sr * 1.3, r2 = sr * (1.65 + (i % 2) * 0.3 + Math.sin(t * 2 + i) * 0.08);
        g.beginPath(); g.moveTo(ax + Math.cos(a) * r1, ay + Math.sin(a) * r1); g.lineTo(ax + Math.cos(a) * r2, ay + Math.sin(a) * r2); g.stroke();
      }
      g.globalAlpha = 1;
    }
    if (night > 0.02) {
      g.globalAlpha = night;
      glow(ax, ay, sr * 4, "rgba(190,210,255,A)", 0.28);
      g.save(); g.beginPath(); g.arc(ax, ay, sr * 0.9, 0, TAU); g.clip();
      g.fillStyle = "#eef2ff"; g.beginPath(); g.rect(ax - sr * 2, ay - sr * 2, sr * 4, sr * 4); g.arc(ax + sr * 0.45, ay - sr * 0.2, sr * 0.82, 0, TAU); g.fill("evenodd"); g.restore();
      g.globalAlpha = 1;
    }
    // clouds drifting slowly
    g.fillStyle = `rgba(255,255,255,${0.08 + 0.5 * day})`;
    g.beginPath();
    for (let c = 0; c < 3; c++) {
      const u = Math.max(40, VW * 0.04), cx = ((t * (5 + c * 2) + c * VW * 0.4) % (VW + 6 * u)) - 3 * u, cy = VH * (0.12 + c * 0.14);
      [[0, 0, 0.8], [0.9, -0.3, 1.0], [1.9, 0, 0.75], [1, 0.3, 0.85]].forEach(([dx, dy, r]) => { g.moveTo(cx + dx * u + r * u * 0.8, cy + dy * u); g.arc(cx + dx * u, cy + dy * u, r * u * 0.8, 0, TAU); });
    }
    g.fill();

    // ---- planet, with the zoom towards the town ----
    const pc = pol(CITY_MID, R), pcx = CX + pc[0], pcy = CY + pc[1];
    const tx = VW * 0.66, ty = VH * 0.66;
    g.save();
    g.translate(mix(pcx, tx, e), mix(pcy, ty, e)); g.rotate(-CITY_MID * e); g.scale(mix(1, 2.7, e), mix(1, 2.7, e));
    g.translate(-pcx, -pcy); g.translate(CX, CY);

    glow(0, 0, R * 1.16, `rgba(${rgbMix([130, 200, 255], [110, 120, 255], night).join(",")},A)`, 0.45 + 0.1 * day);
    // body
    const bg = g.createRadialGradient(R * 0.3, -R * 0.7, R * 0.1, 0, 0, R);
    bg.addColorStop(0, C("#6cc77a", "#2a6a5e")); bg.addColorStop(0.6, C("#4aa860", "#1c5058")); bg.addColorStop(1, C("#2f8a55", "#123448"));
    g.fillStyle = bg; g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fill();
    g.save(); g.beginPath(); g.arc(0, 0, R, 0, TAU); g.clip();
    for (let i = 0; i < 40; i++) { // painted patches of fields and meadows
      const a = -1.5 + rnd(i) * 3, rad = R * (0.9 + rnd(i + 70) * 0.09), [px, py] = pol(a, rad);
      g.fillStyle = rnd(i + 3) > 0.5 ? C("#8fd486", "#1f5448") : C("#2e8a58", "#0d2e3a");
      g.globalAlpha = 0.28; g.beginPath(); g.ellipse(px, py, R * (0.03 + rnd(i + 9) * 0.07), R * (0.012 + rnd(i + 17) * 0.02), a, 0, TAU); g.fill();
    }
    g.globalAlpha = 1;
    g.restore();
    g.strokeStyle = `rgba(255,226,140,${0.5 * day + 0.12})`; g.lineWidth = 2 * k; g.beginPath(); g.arc(0, 0, R - k, -1.25, 1.25); g.stroke();

    // scattered trees in the open stretches
    for (let i = 0; i < 46; i++) {
      const a = -1.35 + rnd(i + 200) * 2.5;
      if ((a > -0.97 && a < -0.45) || (a > -0.12 && a < 0.58)) continue;
      place(a, tree, 0.7 + rnd(i + 5) * 0.7, true);
    }
    // park: rows of panels and the big batteries
    for (let j = 0; j < PANELS; j++) place(PARK0 + j * PARK_STEP, panelRow, j);
    BATT.forEach((a, j) => place(a, battery, j, j === 1 ? 1 : 2));
    // town
    const litHouses = [];
    for (let i = 0; i < HOUSES; i++) {
      place(houseAngle(i), () => { litHouses[i] = house(i); });
      if (i < HOUSES - 1) place(houseAngle(i) + CITY_STEP / 2, tree, 0.55 + rnd(i + 80) * 0.25, false);
    }
    place(houseAngle(HOUSES - 1) + CITY_STEP * 0.7, tree, 0.8, true);
    place(houseAngle(0) - CITY_STEP * 0.6, tree, 0.75, true);
    // pylons and cables
    PYLONS.forEach((a) => pylon(a, t));
    g.lineCap = "round"; g.lineJoin = "round";
    const wd = C("#2b3348", "#0a0f1e", 0.6), wl = C("#7d88a4", "#46517a");
    wire(TWIN, k * 0.55, "rgba(30,36,56,0.55)", "rgba(120,130,160,0.4)");
    wire(MAIN.pts.filter((p) => Math.hypot(p[0], p[1]) > R + 3 * k), k * 0.7, wd, wl);
    const hide = "rgba(20,28,40,0.5)", hl = "rgba(150,160,185,0.38)";
    wire(PARKBUS.pts, k * 0.8, hide, hl);
    wire(MAIN.pts.filter((p) => Math.hypot(p[0], p[1]) < R), k * 0.8, hide, hl);
    TAPS.forEach((w) => wire(w.pts, k * 0.8, wd, wl));
    // window light of the town at night
    if (night > 0.2) litHouses.forEach((l, i) => { if (l > 0.05) { const [x, y] = pol(houseAngle(i), R + 22 * k); glow(x, y, 46 * k, "rgba(255,200,100,A)", 0.4 * l); } });
    BATT.forEach((a) => { if (night > 0.3) { const [x, y] = pol(a, R + 8 * k); glow(x, y, 22 * k, "rgba(45,212,191,A)", 0.22 * night); } });
    // energy pulses, only inside cables
    const col = night > 0.5 ? "45,212,191" : "255,196,70";
    for (const q of pulses) {
      for (let j = 0; j < 5; j++) {
        const f = q.dir > 0 ? q.t - j * 0.012 : 1 - q.t + j * 0.012;
        if (f < 0 || f > 1) continue;
        const [x, y] = along(q.w, f);
        g.fillStyle = `rgba(${col},${(1 - j * 0.2) * (j ? 0.55 : 1)})`;
        g.beginPath(); g.arc(x, y, (1.7 - j * 0.2) * k, 0, TAU); g.fill();
        if (!j) glow(x, y, 6 * k, `rgba(${col},A)`, 0.45);
      }
    }
    g.restore();
  }

  function step(dt) {
    night += clamp((isLight() ? 0 : 1) - night, -dt * 0.9, dt * 0.9);
    z += clamp(zt - z, -dt * 0.9, dt * 0.9);
    const spawn = (w, rate, dir, speed) => { if (Math.random() < rate * dt) pulses.push({ w, t: 0, dir, v: speed * R / w.tot }); };
    if (night < 0.5) {
      spawn(PARKBUS, 2.4, 1, 0.16); spawn(MAIN, 1.4, 1, 0.18);
      TAPS.forEach((w) => spawn(w, 0.3, -1, 0.1));
      if (lv < 0.97) lv = Math.min(0.97, lv + dt * 0.035);
    } else {
      spawn(MAIN, 1.3, 1, 0.18);
      TAPS.forEach((w, i) => spawn(w, 0.45 * clamp((night - 0.4 - 0.2 * rnd(i + 21)) * 4), 1, 0.1));
      if (lv > 0.22) lv = Math.max(0.2, lv - dt * 0.035);
    }
    pulses = pulses.filter((q) => (q.t += q.v * dt) < 1.06);
  }

  const active = () => !document.hidden && !home.hidden && cv.getClientRects().length > 0;

  function frame(now) {
    raf = 0;
    if (!active()) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    step(dt);
    draw(now / 1000);
    raf = requestAnimationFrame(frame);
  }

  function still() { night = isLight() ? 0 : 1; z = zt; draw(0); }
  function wake() {
    if (!VW || VW !== innerWidth || VH !== innerHeight) resize();
    if (reduce) { if (active()) still(); cv.classList.add("on"); return; }
    if (!raf && active()) { last = performance.now(); raf = requestAnimationFrame(frame); }
    cv.classList.toggle("on", active());
  }

  // Zoom: a click on the bare planet goes in; a click on bare background (or Esc) goes out. Cards and buttons are untouched.
  const onPlanet = (e) => Math.hypot(e.clientX - CX, e.clientY - CY) <= R;
  const bare = (e) => e.target === home || e.target === cv;
  function setZoom(v) { zt = v; if (reduce && active()) still(); }
  home.addEventListener("click", (e) => {
    if (!bare(e) || cv.hidden || !cv.getClientRects().length) return;
    if (zt) setZoom(0); else if (onPlanet(e)) setZoom(1);
  });
  home.addEventListener("pointermove", (e) => { home.style.cursor = bare(e) && (zt || onPlanet(e)) ? (zt ? "zoom-out" : "zoom-in") : ""; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && zt && active()) setZoom(0); });

  document.addEventListener("visibilitychange", wake);
  addEventListener("resize", wake);
  new MutationObserver(wake).observe(home, { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(wake).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  wake();
})();
