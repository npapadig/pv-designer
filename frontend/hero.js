// Start-screen diorama: a small house with solar panels, a battery and an EV charger under a sky that follows the
// user's real clock. Sunlight flows as glowing particles to the house, battery and car; at night the battery
// feeds the windows. Hovering the scene "spins" the day; leaving lets it ease back to the real time.
// Pure canvas, no assets. Stops itself when the tab or the start screen is hidden.
(() => {
  const home = document.getElementById("home");
  if (!home) return;
  const W = 360, H = 220;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cv = document.createElement("canvas");
  cv.id = "heroScene";
  cv.setAttribute("aria-hidden", "true");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = W * dpr; cv.height = H * dpr;
  home.prepend(cv);
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);

  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const lerpCol = (a, b, t) => `rgb(${a.map((v, i) => Math.round(mix(v, b[i], t))).join(",")})`;
  const rnd = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  // Sky: [hour, top, bottom]
  const SKY = [
    [0, "#070b22", "#14204f"], [4.5, "#10173e", "#3a3470"], [6.2, "#5b5fa8", "#ff9a6b"], [8, "#4a9cf0", "#ffd9a6"],
    [11, "#3d8fe8", "#bfe6ff"], [15, "#3d8fe8", "#c9ecff"], [17.8, "#5a7fd0", "#ffc27a"], [19.4, "#7a4f9e", "#ff7a59"],
    [20.8, "#1c1d52", "#9a4f84"], [22, "#0a0f2e", "#17224f"], [24, "#070b22", "#14204f"],
  ].map(([h, a, b]) => [h, hex(a), hex(b)]);
  function sky(h) {
    let i = 1;
    while (i < SKY.length - 1 && SKY[i][0] < h) i++;
    const [h0, t0, b0] = SKY[i - 1], [h1, t1, b1] = SKY[i];
    const t = clamp((h - h0) / (h1 - h0));
    return [lerpCol(t0, t1, t), lerpCol(b0, b1, t)];
  }

  const power = (h) => (h > 6 && h < 20 ? Math.sin(Math.PI * (h - 6) / 14) : 0);
  const battery = (h) => (h >= 6 && h <= 20 ? 0.25 + 0.7 * (1 - Math.cos(Math.PI * (h - 6) / 14)) / 2
    : 0.95 - (h > 20 ? h - 20 : h + 4) * 0.07);

  // Energy paths (cubic bezier points): panels -> house / battery / car, battery -> house.
  const PATHS = {
    house: [[150, 118], [152, 140], [138, 150], [122, 158]],
    batt: [[152, 110], [172, 88], [202, 98], [214, 132]],
    car: [[158, 106], [212, 66], [252, 82], [286, 142]],
    night: [[206, 158], [182, 168], [150, 168], [128, 160]],
  };
  const bez = (p, t) => {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0], a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]];
  };

  let parts = [], warp = 0, hover = false, mx = -1, last = 0, raf = 0, cloudX = 40, ptrX = 0;

  function hours() {
    const d = new Date();
    return (d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600 + warp + 48) % 24;
  }

  function glow(x, y, r, col, a) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col.replace("A", a));
    gr.addColorStop(1, col.replace("A", 0));
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

  function draw(h, t) {
    const p = power(h), day = clamp(p * 3), night = 1 - day;
    const [top, bot] = sky(h);
    g.save();
    rr(0, 0, W, H, 26); g.clip();
    const sg = g.createLinearGradient(0, 0, 0, 170);
    sg.addColorStop(0, top); sg.addColorStop(1, bot);
    g.fillStyle = sg; g.fillRect(0, 0, W, H);

    // stars
    if (night > 0.02) {
      for (let i = 0; i < 46; i++) {
        const tw = 0.55 + 0.45 * Math.sin(t * 1.6 + i * 3.1);
        g.globalAlpha = night * tw * (0.35 + 0.5 * rnd(i + 9));
        g.fillStyle = "#fff";
        g.beginPath(); g.arc(rnd(i) * W, rnd(i + 50) * 120, 0.5 + rnd(i + 99) * 0.9, 0, TAU); g.fill();
      }
      g.globalAlpha = 1;
    }

    // sun (6-20) and moon (20-6) on a shared arc
    const sunUp = h >= 6 && h <= 20;
    const k = sunUp ? (h - 6) / 14 : ((h >= 20 ? h - 20 : h + 4) / 10);
    const ax = 34 + k * (W - 68), ay = 150 - Math.sin(Math.PI * k) * (sunUp ? 112 : 96);
    if (sunUp) {
      glow(ax, ay, 70, "rgba(255,190,80,A)", 0.55);
      g.fillStyle = "#ffd25e"; g.beginPath(); g.arc(ax, ay, 14, 0, TAU); g.fill();
      g.strokeStyle = "rgba(255,214,110,0.55)"; g.lineWidth = 1.6; g.lineCap = "round";
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * TAU + t * 0.25, r1 = 19 + (i % 2) * 2, r2 = 25 + (i % 2) * 5 + Math.sin(t * 2 + i) * 1.5;
        g.beginPath(); g.moveTo(ax + Math.cos(a) * r1, ay + Math.sin(a) * r1); g.lineTo(ax + Math.cos(a) * r2, ay + Math.sin(a) * r2); g.stroke();
      }
    } else {
      glow(ax, ay, 46, "rgba(190,210,255,A)", 0.3);
      g.fillStyle = "#eef2ff"; g.beginPath(); g.arc(ax, ay, 11, 0, TAU); g.fill();
      g.fillStyle = top; g.beginPath(); g.arc(ax + 5, ay - 3, 10, 0, TAU); g.fill();
    }

    // cloud, shying away from the pointer
    const want = mx >= 0 ? clamp(40 + (mx < W / 2 ? 190 : -40), 10, 270) : 40 + 110 * (0.5 + 0.5 * Math.sin(t * 0.05));
    cloudX += (want - cloudX) * (mx >= 0 ? 0.02 : 0.004);
    g.fillStyle = `rgba(255,255,255,${0.1 + 0.55 * day})`;
    g.beginPath(); // one path, so the puffs do not show their overlaps
    [[0, 0, 15], [16, -6, 19], [34, 0, 14], [18, 5, 16]].forEach(([dx, dy, r]) => { g.moveTo(cloudX + dx + r, 52 + dy); g.arc(cloudX + dx, 52 + dy, r, 0, TAU); });
    g.fill();

    // hills
    g.fillStyle = lerpCol(hex("#2a7a58"), hex("#0c2a34"), night * 0.9);
    g.beginPath(); g.moveTo(0, 160); g.quadraticCurveTo(70, 138, 150, 158); g.quadraticCurveTo(250, 178, W, 150); g.lineTo(W, H); g.lineTo(0, H); g.fill();
    g.fillStyle = lerpCol(hex("#38996a"), hex("#12384a"), night * 0.9);
    g.beginPath(); g.moveTo(0, 172); g.quadraticCurveTo(120, 160, 220, 172); g.quadraticCurveTo(300, 180, W, 168); g.lineTo(W, H); g.lineTo(0, H); g.fill();

    // house
    const wall = lerpCol(hex("#f4efe6"), hex("#3a4466"), night * 0.75);
    g.fillStyle = wall; rr(82, 126, 76, 44, 3); g.fill();
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
    // door and windows
    g.fillStyle = lerpCol(hex("#7a4a35"), hex("#2a2038"), night * 0.6); rr(114, 148, 12, 22, 2); g.fill();
    [[90, 136], [136, 136]].forEach(([x, y]) => {
      g.fillStyle = lerpCol(hex("#8fc6ee"), hex("#ffcf70"), night); rr(x, y, 14, 12, 2); g.fill();
      if (night > 0.2) glow(x + 7, y + 6, 26, "rgba(255,200,100,A)", 0.5 * night);
    });

    // battery
    const lv = battery(h);
    g.fillStyle = "rgba(10,16,34,0.55)"; rr(204, 130, 22, 40, 5); g.fill();
    g.fillStyle = lv > 0.3 ? "#2dd4bf" : "#ffb547";
    rr(207, 133 + 34 * (1 - lv), 16, 34 * lv, 3); g.fill();
    g.fillStyle = "#cfd6e8"; rr(211, 126, 8, 5, 1.5); g.fill();
    if (p > 0.1 || night > 0.5) glow(215, 150, 26, "rgba(45,212,191,A)", 0.12 + 0.1 * Math.sin(t * 3));

    // EV charger and car
    g.fillStyle = "#cfd6e8"; rr(256, 142, 8, 28, 3); g.fill();
    g.fillStyle = p > 0.1 ? "#4ade80" : "#6b7692"; g.beginPath(); g.arc(260, 149, 2.2, 0, TAU); g.fill();
    if (p > 0.1) glow(260, 149, 12, "rgba(74,222,128,A)", 0.5 + 0.3 * Math.sin(t * 4));
    g.strokeStyle = "#8d97b0"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(264, 160); g.quadraticCurveTo(272, 176, 280, 164); g.stroke();
    g.fillStyle = "#e8ecf6"; rr(274, 150, 66, 18, 7); g.fill();
    g.fillStyle = "#e8ecf6"; g.beginPath(); g.moveTo(286, 151); g.quadraticCurveTo(294, 136, 308, 136); g.quadraticCurveTo(322, 136, 328, 151); g.fill();
    g.fillStyle = lerpCol(hex("#7fb3e6"), hex("#1c2440"), night * 0.8);
    g.beginPath(); g.moveTo(291, 150); g.quadraticCurveTo(297, 140, 307, 140); g.lineTo(307, 150); g.fill();
    g.beginPath(); g.moveTo(311, 150); g.lineTo(311, 140); g.quadraticCurveTo(320, 140, 324, 150); g.fill();
    g.fillStyle = "#1a2036";
    [290, 322].forEach((x) => { g.beginPath(); g.arc(x, 168, 6, 0, TAU); g.fill(); });
    g.fillStyle = "#aab3c8";
    [290, 322].forEach((x) => { g.beginPath(); g.arc(x, 168, 2.4, 0, TAU); g.fill(); });
    if (night > 0.3) glow(341, 158, 18, "rgba(255,240,190,A)", 0.5 * night);

    // flowing energy
    g.globalCompositeOperation = "lighter";
    for (const q of parts) {
      for (let j = 0; j < 4; j++) {
        const [x, y] = bez(PATHS[q.path], clamp(q.t - j * 0.018));
        glow(x, y, 7 - j, q.path === "night" ? "rgba(45,212,191,A)" : "rgba(255,196,70,A)", (1 - j * 0.25) * 0.9);
      }
    }
    g.globalCompositeOperation = "source-over";

    // pointer sparkle: a little fast-forward hint
    if (hover) {
      g.fillStyle = "rgba(255,255,255,0.7)"; g.font = "600 10px system-ui, sans-serif";
      g.fillText(`${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`, W - 40, 20);
    }
    g.restore();
  }

  function step(dt, h) {
    const p = power(h);
    if (hover) warp += dt * 2.4; // hovering: 2.4 hours per second
    else if (warp !== 0) { // ease back to the real time along the shortest way
      const w = ((warp + 12) % 24 + 24) % 24 - 12;
      warp = Math.abs(w) < 0.01 ? 0 : w * (1 - Math.min(1, dt * 1.6));
    }
    const rate = (hover ? 2 : 1);
    const spawn = (path, n) => { if (Math.random() < n * dt * rate) parts.push({ path, t: 0, v: 0.35 + Math.random() * 0.25 }); };
    if (p > 0.05) {
      spawn("house", 5 * p); spawn("car", 3 * p);
      if (battery(h) < 0.95) spawn("batt", 4 * p);
    } else if (battery(h) > 0.28) spawn("night", 3.2);
    parts = parts.filter((q) => (q.t += q.v * dt) < 1);
  }

  function frame(now) {
    raf = 0;
    if (!active()) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const h = hours();
    step(dt, h);
    draw(h, now / 1000);
    raf = requestAnimationFrame(frame);
  }

  const active = () => !document.hidden && !home.hidden && cv.getClientRects().length > 0;
  function wake() {
    if (reduce) { if (active()) draw(hours(), 0); cv.classList.add("on"); return; }
    if (!raf && active()) { last = performance.now(); raf = requestAnimationFrame(frame); }
    cv.classList.toggle("on", active());
  }

  addEventListener("pointermove", (e) => {
    if (!active()) return;
    const r = cv.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    hover = inside && !reduce;
    mx = e.clientX >= r.left - 160 && e.clientY >= r.top - 120 ? clamp(e.clientX - r.left, 0, W) : -1;
  }, { passive: true });
  document.addEventListener("pointerleave", () => { hover = false; mx = -1; });
  document.addEventListener("visibilitychange", wake);
  addEventListener("resize", wake);
  new MutationObserver(wake).observe(home, { attributes: true, attributeFilter: ["hidden"] });
  wake();
})();
