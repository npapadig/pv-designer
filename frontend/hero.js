// Start-screen scene: a house with solar panels, a battery and an EV charger that fills the free part of the start
// screen. The light theme is day (sun; the panels charge the battery and feed the house and the car); the dark theme
// is night (moon; the battery feeds the house). Pure canvas, no assets. Stops itself when the tab or the screen is hidden.
(() => {
  const home = document.getElementById("home");
  if (!home) return;
  const root = document.documentElement;
  const GW = 360, GH = 220; // the scene is drawn in these units, then scaled to the window
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cv = document.createElement("canvas");
  cv.id = "heroScene";
  cv.setAttribute("aria-hidden", "true");
  home.prepend(cv);
  const g = cv.getContext("2d");
  let VW = 0, VH = 0, S = 1, OX = 0, OY = 0;

  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const lerpCol = (a, b, t) => `rgb(${a.map((v, i) => Math.round(mix(v, b[i], t))).join(",")})`;
  const rnd = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const isLight = () => root.dataset.theme === "light";

  const DAY = [hex("#3d8fe8"), hex("#c9ecff")], NIGHT = [hex("#070b22"), hex("#17224f")];

  // Cables as polylines: panels -> junction -> house / battery / charger; at night battery -> house / charger.
  const WIRES = {
    panel: [[150, 116], [161, 124], [161, 176]],
    house: [[161, 176], [161, 164], [158, 164]],
    batt: [[161, 176], [215, 176], [215, 171]],
    car: [[161, 176], [260, 176], [260, 171]],
    nHouse: [[215, 171], [215, 176], [161, 176], [161, 164], [158, 164]],
    nCar: [[215, 171], [215, 176], [260, 176], [260, 171]],
  };
  const lens = (w) => { let tot = 0; const c = [0]; for (let k = 1; k < w.length; k++) { tot += Math.hypot(w[k][0] - w[k - 1][0], w[k][1] - w[k - 1][1]); c.push(tot); } return { c, tot }; };
  Object.keys(WIRES).forEach((k) => { WIRES[k] = { pts: WIRES[k], ...lens(WIRES[k]) }; });
  const along = (w, f) => {
    const d = clamp(f) * w.tot; let k = 1;
    while (k < w.pts.length - 1 && w.c[k] < d) k++;
    const u = (d - w.c[k - 1]) / ((w.c[k] - w.c[k - 1]) || 1), a = w.pts[k - 1], b = w.pts[k];
    return [mix(a[0], b[0], u), mix(a[1], b[1], u)];
  };

  let parts = [], last = 0, raf = 0;
  let night = isLight() ? 0 : 1; // 0 = day, 1 = night; eases when the theme changes
  let lv = night ? 0.9 : 0.3; // battery level: charges by day, drains by night

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    VW = innerWidth; VH = innerHeight;
    cv.width = Math.round(VW * dpr); cv.height = Math.round(VH * dpr);
    S = clamp(Math.min(VW * 0.7 / GW, VH * 0.85 / GH), 0.8, 4.5);
    OX = VW - GW * S - Math.min(VW * 0.03, 40); OY = VH - GH * S;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function glow(x, y, r, col, a) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col.replace("A", a));
    gr.addColorStop(1, col.replace("A", 0));
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

  function draw(t) {
    const day = 1 - night, p = day; // panel output follows the day
    const top = lerpCol(DAY[0], NIGHT[0], night), bot = lerpCol(DAY[1], NIGHT[1], night);
    g.clearRect(0, 0, VW, VH);
    // sky over the whole window (screen space)
    const sg = g.createLinearGradient(0, 0, 0, VH - 50 * S);
    sg.addColorStop(0, top); sg.addColorStop(1, bot);
    g.fillStyle = sg; g.fillRect(0, 0, VW, VH);
    if (night > 0.02) {
      for (let i = 0; i < 90; i++) {
        const tw = 0.55 + 0.45 * Math.sin(t * 1.6 + i * 3.1);
        g.globalAlpha = night * tw * (0.35 + 0.5 * rnd(i + 9));
        g.fillStyle = "#fff";
        g.beginPath(); g.arc(rnd(i) * VW, rnd(i + 50) * VH * 0.6, (0.5 + rnd(i + 99) * 0.9) * Math.max(1, S * 0.5), 0, TAU); g.fill();
      }
      g.globalAlpha = 1;
    }

    g.save();
    g.translate(OX, OY); g.scale(S, S);
    const L = -OX / S, R = (VW - OX) / S, B = (VH - OY) / S;

    // sun (day) and moon (night), fixed in the sky; only the theme decides which one is up
    const ax = 215, ay = 46;
    if (day > 0.02) {
      g.globalAlpha = day;
      glow(ax, ay, 90, "rgba(255,190,80,A)", 0.55);
      g.fillStyle = "#ffd25e"; g.beginPath(); g.arc(ax, ay, 15, 0, TAU); g.fill();
      g.strokeStyle = "rgba(255,214,110,0.55)"; g.lineWidth = 1.6; g.lineCap = "round";
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * TAU + t * 0.25, r1 = 20 + (i % 2) * 2, r2 = 26 + (i % 2) * 5 + Math.sin(t * 2 + i) * 1.5;
        g.beginPath(); g.moveTo(ax + Math.cos(a) * r1, ay + Math.sin(a) * r1); g.lineTo(ax + Math.cos(a) * r2, ay + Math.sin(a) * r2); g.stroke();
      }
      g.globalAlpha = 1;
    }
    if (night > 0.02) {
      g.globalAlpha = night;
      glow(ax, ay, 60, "rgba(190,210,255,A)", 0.3);
      g.save(); g.beginPath(); g.arc(ax, ay, 13, 0, TAU); g.clip(); // crescent: the disc minus an offset disc
      g.fillStyle = "#eef2ff"; g.beginPath(); g.rect(ax - 20, ay - 20, 40, 40); g.arc(ax + 6, ay - 3, 12, 0, TAU); g.fill("evenodd"); g.restore();
      g.globalAlpha = 1;
    }

    // clouds drifting slowly
    g.fillStyle = `rgba(255,255,255,${0.1 + 0.55 * day})`;
    g.beginPath(); // one path, so the puffs do not show their overlaps
    for (let c = 0; c < 3; c++) {
      const cx = L + ((t * (3 + c) + c * 170) % (R - L + 120)) - 60, cy = 34 + c * 26;
      [[0, 0, 15], [16, -6, 19], [34, 0, 14], [18, 5, 16]].forEach(([dx, dy, r]) => { g.moveTo(cx + dx + r, cy + dy); g.arc(cx + dx, cy + dy, r, 0, TAU); });
    }
    g.fill();

    // hills
    g.fillStyle = lerpCol(hex("#2a7a58"), hex("#0c2a34"), night * 0.9);
    g.beginPath(); g.moveTo(L, 160); g.quadraticCurveTo(70, 138, 150, 158); g.quadraticCurveTo(250, 178, R, 150); g.lineTo(R, B); g.lineTo(L, B); g.fill();
    g.fillStyle = lerpCol(hex("#38996a"), hex("#12384a"), night * 0.9);
    g.beginPath(); g.moveTo(L, 172); g.quadraticCurveTo(120, 160, 220, 172); g.quadraticCurveTo(300, 180, R, 168); g.lineTo(R, B); g.lineTo(L, B); g.fill();

    // house
    g.fillStyle = lerpCol(hex("#f4efe6"), hex("#3a4466"), night * 0.75); rr(82, 126, 76, 44, 3); g.fill();
    g.fillStyle = lerpCol(hex("#b4543f"), hex("#4a2a3a"), night * 0.7);
    g.beginPath(); g.moveTo(70, 129); g.lineTo(120, 92); g.lineTo(172, 129); g.closePath(); g.fill();
    // panels on the right slope
    const ux = 52 / 63.7, uy = 37 / 63.7, nx = -uy, ny = ux;
    for (let i = 0; i < 3; i++) {
      const t0 = 0.12 + i * 0.27, t1 = t0 + 0.24;
      const P = (s, d) => [120 + ux * 63.7 * s + nx * d, 92 + uy * 63.7 * s + ny * d];
      const q = [P(t0, 4), P(t1, 4), P(t1, 15), P(t0, 15)];
      g.fillStyle = lerpCol(hex("#17306b"), hex("#2c63c9"), p);
      g.beginPath(); q.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
      g.strokeStyle = `rgba(150,200,255,${0.35 + 0.4 * p})`; g.lineWidth = 0.7; g.stroke();
      if (p > 0.1) { // glint sweeping over the cells
        const gs = ((t * 0.35 + i * 0.2) % 1.6) - 0.3, gp = P(t0 + (t1 - t0) * gs, 9.5);
        if (gs > 0 && gs < 1) glow(gp[0], gp[1], 9, "rgba(255,240,180,A)", 0.5 * p);
      }
    }
    // door and windows (lit by the battery at night)
    g.fillStyle = lerpCol(hex("#7a4a35"), hex("#2a2038"), night * 0.6); rr(114, 148, 12, 22, 2); g.fill();
    [[90, 136], [136, 136]].forEach(([x, y]) => {
      g.fillStyle = lerpCol(hex("#8fc6ee"), hex("#ffcf70"), night); rr(x, y, 14, 12, 2); g.fill();
      if (night > 0.2) glow(x + 7, y + 6, 26, "rgba(255,200,100,A)", 0.5 * night);
    });

    // battery
    g.fillStyle = "rgba(10,16,34,0.55)"; rr(204, 130, 22, 40, 5); g.fill();
    g.fillStyle = lv > 0.3 ? "#2dd4bf" : "#ffb547";
    rr(207, 133 + 34 * (1 - lv), 16, 34 * lv, 3); g.fill();
    g.fillStyle = "#cfd6e8"; rr(211, 126, 8, 5, 1.5); g.fill();
    glow(215, 150, 26, "rgba(45,212,191,A)", 0.12 + 0.1 * Math.sin(t * 3));

    // EV charger and car
    g.fillStyle = "#cfd6e8"; rr(256, 142, 8, 28, 3); g.fill();
    g.fillStyle = p > 0.1 ? "#4ade80" : "#6b7692"; g.beginPath(); g.arc(260, 149, 2.2, 0, TAU); g.fill();
    if (p > 0.1) glow(260, 149, 12, "rgba(74,222,128,A)", (0.5 + 0.3 * Math.sin(t * 4)) * p);
    g.strokeStyle = "#8d97b0"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(264, 160); g.quadraticCurveTo(272, 176, 280, 164); g.stroke();
    g.fillStyle = "#e8ecf6"; rr(274, 150, 66, 18, 7); g.fill();
    g.beginPath(); g.moveTo(286, 151); g.quadraticCurveTo(294, 136, 308, 136); g.quadraticCurveTo(322, 136, 328, 151); g.fill();
    g.fillStyle = lerpCol(hex("#7fb3e6"), hex("#1c2440"), night * 0.8);
    g.beginPath(); g.moveTo(291, 150); g.quadraticCurveTo(297, 140, 307, 140); g.lineTo(307, 150); g.fill();
    g.beginPath(); g.moveTo(311, 150); g.lineTo(311, 140); g.quadraticCurveTo(320, 140, 324, 150); g.fill();
    g.fillStyle = "#1a2036";
    [290, 322].forEach((x) => { g.beginPath(); g.arc(x, 168, 6, 0, TAU); g.fill(); });
    g.fillStyle = "#aab3c8";
    [290, 322].forEach((x) => { g.beginPath(); g.arc(x, 168, 2.4, 0, TAU); g.fill(); });
    if (night > 0.3) glow(341, 158, 18, "rgba(255,240,190,A)", 0.5 * night);

    // cables
    g.lineCap = "round"; g.lineJoin = "round";
    const wirePath = (w) => { g.beginPath(); w.pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); };
    ["panel", "house", "batt", "car"].forEach((k) => {
      wirePath(WIRES[k]); g.strokeStyle = lerpCol(hex("#2b3348"), hex("#0a0f1e"), night * 0.6); g.lineWidth = 2.6; g.stroke();
      wirePath(WIRES[k]); g.strokeStyle = lerpCol(hex("#6d7893"), hex("#3a4666"), night); g.lineWidth = 1.2; g.stroke();
    });
    // energy pulses travelling along the cables
    for (const q of parts) {
      const w = WIRES[q.path], col = q.path[0] === "n" ? "45,212,191" : "255,196,70";
      for (let j = 0; j < 5; j++) {
        const [x, y] = along(w, q.t - j * 0.012);
        g.fillStyle = `rgba(${col},${(1 - j * 0.2) * (j ? 0.55 : 1)})`;
        g.beginPath(); g.arc(x, y, 1.9 - j * 0.2, 0, TAU); g.fill();
        if (!j) glow(x, y, 6, `rgba(${col},A)`, 0.4);
      }
    }
    g.restore();
  }

  function step(dt) {
    const target = isLight() ? 0 : 1;
    night += clamp(target - night, -dt * 0.9, dt * 0.9);
    const spawn = (path, n) => { if (Math.random() < n * dt) parts.push({ path, t: 0, v: 0.5 / WIRES[path].tot * 60 }); };
    if (night < 0.5) {
      spawn("panel", 2.2); // the stretch from the roof to the junction; branches follow when it arrives
      for (const q of parts) if (q.path === "panel" && !q.done && q.t > 0.98) {
        q.done = true; // reached the junction: split to the house, the car and the battery (if not full)
        parts.push({ path: "house", t: 0, v: 0.5 / WIRES.house.tot * 60 }, { path: "car", t: 0, v: 0.5 / WIRES.car.tot * 60 });
        if (lv < 0.97) parts.push({ path: "batt", t: 0, v: 0.5 / WIRES.batt.tot * 60 });
      }
      if (lv < 0.97) lv = Math.min(0.97, lv + dt * 0.035);
    } else if (lv > 0.22) { spawn("nHouse", 1.2); spawn("nCar", 1.2); lv = Math.max(0.2, lv - dt * 0.035); }
    parts = parts.filter((q) => (q.t += q.v * dt) < 1);
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

  function wake() {
    if (!VW || VW !== innerWidth || VH !== innerHeight) resize();
    if (reduce) { if (active()) { night = isLight() ? 0 : 1; draw(0); } cv.classList.add("on"); return; }
    if (!raf && active()) { last = performance.now(); raf = requestAnimationFrame(frame); }
    cv.classList.toggle("on", active());
  }

  document.addEventListener("visibilitychange", wake);
  addEventListener("resize", wake);
  new MutationObserver(wake).observe(home, { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(wake).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  wake();
})();
