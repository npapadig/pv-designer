// Start-screen "energy card": a glass card in the bottom-right corner with a slow aurora behind an abstract
// isometric solar system (panel array, storage, load). Light drifts across the panels, energy runs along thin
// glowing traces, and a sun/moon marker follows the user's real clock. The card tilts gently towards the pointer
// and a soft light follows it. Pure canvas + CSS, no assets, no text. Decorative only (aria-hidden, no pointer
// events). Stops when the tab or the start screen is hidden; one still frame with prefers-reduced-motion.
(() => {
  const home = document.getElementById("home");
  if (!home) return;
  const W = 400, H = 270;
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const card = document.createElement("div");
  card.id = "heroScene";
  card.setAttribute("aria-hidden", "true");
  const cv = document.createElement("canvas");
  card.append(cv);
  home.prepend(card);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);

  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);

  // ---- palettes (dark / light), matched to style.css tokens ----
  const PAL = {
    dark: {
      base: ["#0c1222", "#0a0f1c"], aur: ["255,138,61", "45,212,191", "88,96,220"], aurA: [0.24, 0.2, 0.3],
      dot: "255,255,255", dotA: 0.16, trace: "255,255,255", traceA: 0.14,
      panel: ["#2c4372", "#0c1328"], panelEdge: "rgba(170,200,255,0.26)", frame: "rgba(255,255,255,0.1)",
      amber: "255,181,71", teal: "45,212,191", glowOp: "lighter",
      boxTop: "#2a3654", boxL: "#18213a", boxR: "#111829", boxEdge: "rgba(255,255,255,0.10)",
      glass: "rgba(255,255,255,0.05)", glassEdge: "rgba(255,255,255,0.22)", arc: "255,255,255", arcA: 0.14,
      spot: "255,255,255", spotA: 0.07, moon: "200,215,255",
    },
    light: {
      base: ["#fbfcff", "#eef2f9"], aur: ["255,138,61", "13,148,136", "99,102,241"], aurA: [0.26, 0.14, 0.16],
      dot: "17,24,39", dotA: 0.16, trace: "17,24,39", traceA: 0.1,
      panel: ["#2c3d64", "#121a31"], panelEdge: "rgba(255,255,255,0.28)", frame: "rgba(17,24,39,0.18)",
      amber: "240,120,30", teal: "13,148,136", glowOp: "source-over",
      boxTop: "#ffffff", boxL: "#e6eaf3", boxR: "#d4dbe8", boxEdge: "rgba(17,24,39,0.14)",
      glass: "rgba(255,255,255,0.45)", glassEdge: "rgba(17,24,39,0.22)", arc: "17,24,39", arcA: 0.16,
      spot: "255,170,90", spotA: 0.12, moon: "90,110,170",
    },
  };

  // ---- isometric projection ----
  const S = 29, OX = 182, OY = 118;
  let shiftX = 0, shiftY = 0; // pointer parallax of the scene layer
  const iso = (x, y, z = 0) => [OX + shiftX + (x - y) * 0.866 * S, OY + shiftY + (x + y) * 0.5 * S - z * S];
  function poly(pts) {
    g.beginPath();
    pts.forEach((p, i) => { const [sx, sy] = iso(...p); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
    g.closePath();
  }

  // ---- the day ----
  const power = (h) => (h > 6 && h < 20 ? Math.sin(Math.PI * (h - 6) / 14) : 0);
  const charge = (h) => (h >= 6 && h <= 20 ? 0.25 + 0.7 * (1 - Math.cos(Math.PI * (h - 6) / 14)) / 2
    : 0.95 - (h > 20 ? h - 20 : h + 4) * 0.07);
  const hours = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };

  // ---- energy traces (world polylines on the ground) ----
  const ARR = { x0: 0, x1: 4, y0: 0, y1: 2.4, zf: 0.35, zb: 1.5 };
  const BAT = { x0: -0.45, x1: 0.4, y0: 2.9, y1: 3.8, h: 1.6 };
  const LOAD = { x0: 5.0, x1: 6.6, y0: 0.2, y1: 1.8, h: 1.1 };
  const mkPath = (pts) => {
    const seg = []; let len = 0;
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [iso(...pts[i - 1]), iso(...pts[i])];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]); seg.push(l); len += l;
    }
    return { pts, seg, len };
  };
  const TR = {
    toLoad: [[3.0, 2.4, 0], [3.0, 2.8, 0], [5.8, 2.8, 0], [5.8, 1.8, 0]],
    toBat: [[1.0, 2.4, 0], [1.0, 3.35, 0], [0.4, 3.35, 0]],
    batLoad: [[0.4, 3.35, 0], [1.0, 3.35, 0], [1.0, 2.8, 0], [5.8, 2.8, 0], [5.8, 1.8, 0]],
  };
  function at(path, d) { // world point at distance d (screen units) along the path
    let i = 0;
    while (i < path.seg.length - 1 && d > path.seg[i]) { d -= path.seg[i]; i++; }
    const t = clamp(d / path.seg[i]);
    const [a, b] = [path.pts[i], path.pts[i + 1]];
    return [mix(a[0], b[0], t), mix(a[1], b[1], t), 0];
  }

  // ---- pointer (eased) ----
  let ptr = { x: 0, y: 0, in: 0 }, tgt = { x: 0, y: 0, in: 0 }, spot = [W * 0.7, H * 0.2];
  addEventListener("pointermove", (e) => {
    const r = card.getBoundingClientRect();
    if (!r.width) return;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    tgt.x = clamp((e.clientX - cx) / 520, -1, 1);
    tgt.y = clamp((e.clientY - cy) / 420, -1, 1);
    const dist = Math.hypot(Math.max(0, r.left - e.clientX, e.clientX - r.right), Math.max(0, r.top - e.clientY, e.clientY - r.bottom));
    tgt.in = clamp(1 - dist / 260);
    spot = [clamp(e.clientX - r.left, -60, W + 60), clamp(e.clientY - r.top, -60, H + 60)];
  }, { passive: true });
  document.addEventListener("pointerleave", () => { tgt = { x: 0, y: 0, in: 0 }; });

  // ---- drawing ----
  function glow(x, y, r, rgb, a) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${rgb},${a})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function background(P, t, p, sun) {
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, P.base[0]); bg.addColorStop(1, P.base[1]);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // aurora: soft blobs drifting on slow Lissajous paths. The warm one sits by the sun (so the light makes
    // sense), teal and indigo carry the night.
    const day = clamp(p * 1.6), ax = -ptr.x * 14, ay = -ptr.y * 10;
    g.globalCompositeOperation = P.glowOp;
    const blobs = [
      [sun[0] + 30 * Math.sin(t * 0.07), sun[1] + 40 + 20 * Math.cos(t * 0.05), 210, P.aur[0], P.aurA[0] * (0.2 + 0.8 * day)],
      [W * (0.12 + 0.1 * Math.cos(t * 0.06)), H * (1.0 + 0.06 * Math.sin(t * 0.08)), 230, P.aur[1], P.aurA[1] * (0.75 + 0.45 * (1 - day))],
      [W * (0.8 + 0.12 * Math.sin(t * 0.045 + 2)), H * (0.85 + 0.12 * Math.sin(t * 0.055)), 210, P.aur[2], P.aurA[2] * (0.55 + 0.45 * (1 - day))],
    ];
    for (const [x, y, r, c, a] of blobs) glow(x + ax, y + ay, r, c, a);
    g.globalCompositeOperation = "source-over";
  }

  function grid(P) {
    for (let x = -4; x <= 9; x++) for (let y = -3; y <= 7; y++) {
      const d = Math.hypot(x - 2.6, y - 1.8);
      const a = P.dotA * clamp(1 - d / 6.8) ** 1.4;
      if (a < 0.01) continue;
      const [sx, sy] = iso(x, y);
      g.fillStyle = `rgba(${P.dot},${a})`;
      g.fillRect(sx - 0.7, sy - 0.7, 1.4, 1.4);
    }
  }

  function sunPos(h) {
    const cx = W * 0.5 + ptr.x * 4, cy = 182, rx = 184, ry = 152;
    const isDay = h >= 6 && h < 20;
    const f = isDay ? (h - 6) / 14 : ((h - 20 + 24) % 24) / 10;
    const a = Math.PI + f * Math.PI;
    return { cx, cy, rx, ry, a, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), isDay };
  }

  function sunArc(P, h, t) {
    // the sun's path as a fine dotted arc; the part already travelled is a soft solid trail
    const { cx, cy, rx, ry, a, x, y, isDay } = sunPos(h);
    const rgb = isDay ? P.amber : P.moon;
    g.save();
    g.lineCap = "round"; g.lineWidth = 1;
    g.setLineDash([1, 5]);
    g.strokeStyle = `rgba(${P.arc},${P.arcA})`;
    g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, a, TAU); g.stroke();
    g.setLineDash([]);
    const tr = g.createLinearGradient(cx - rx, cy, x, y);
    tr.addColorStop(0, `rgba(${rgb},0)`); tr.addColorStop(1, `rgba(${rgb},${isDay ? 0.75 : 0.5})`);
    g.strokeStyle = tr; g.lineWidth = 1.3;
    g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, Math.PI, a); g.stroke();
    g.restore();
    g.globalCompositeOperation = P.glowOp;
    if (isDay) {
      const breathe = 1 + 0.06 * Math.sin(t * 0.8);
      glow(x, y, 80 * breathe, P.amber, 0.2);
      glow(x, y, 14, P.amber, 0.9);
      g.fillStyle = "rgba(255,248,236,1)";
    } else {
      glow(x, y, 36, P.moon, 0.2);
      g.fillStyle = `rgba(${P.moon},0.95)`;
    }
    g.globalCompositeOperation = "source-over";
    g.beginPath(); g.arc(x, y, isDay ? 3.2 : 2.4, 0, TAU); g.fill();
  }

  function traces(P, t, flows) {
    g.lineWidth = 1; g.lineJoin = "round"; g.lineCap = "round";
    for (const k in TR) {
      const path = TR[k];
      g.strokeStyle = `rgba(${P.trace},${P.traceA})`;
      g.beginPath();
      path.pts.forEach((p, i) => { const [sx, sy] = iso(...p); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
      g.stroke();
      const f = flows[k];
      if (f.a < 0.02) continue;
      // comets: a bright head with a fading tail, evenly spaced, gliding at a calm constant speed
      g.globalCompositeOperation = P.glowOp;
      const gap = 80, speed = 30, tail = 34, n = Math.ceil((path.len + tail) / gap);
      for (let i = 0; i < n; i++) {
        const head = (t * speed + i * gap) % (n * gap);
        if (head > path.len + tail) continue;
        const fade = f.a * smooth(clamp(head / 20));
        // the streak: short segments from tail (transparent) to head (bright)
        for (let j = 0, steps = 10; j < steps; j++) {
          const d0 = head - tail * (1 - j / steps), d1 = head - tail * (1 - (j + 1) / steps);
          if (d1 < 0 || d0 > path.len) continue;
          const [ax, ay] = iso(...at(path, clamp(d0, 0, path.len))), [bx, by] = iso(...at(path, clamp(d1, 0, path.len)));
          g.strokeStyle = `rgba(${f.c},${fade * ((j + 1) / steps) ** 2})`; g.lineWidth = 1.6;
          g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
        }
        if (head <= path.len) {
          const [sx, sy] = iso(...at(path, head));
          glow(sx, sy, 12, f.c, 0.4 * fade);
          g.fillStyle = `rgba(255,250,240,${0.9 * fade})`;
          g.beginPath(); g.arc(sx, sy, 1.3, 0, TAU); g.fill();
        }
      }
      g.lineWidth = 1;
      g.globalCompositeOperation = "source-over";
    }
  }

  function box(P, b, solid) {
    const { x0, x1, y0, y1, h, z0 = 0 } = b;
    const top = [[x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]];
    const left = [[x0, y1, z0], [x1, y1, z0], [x1, y1, h], [x0, y1, h]];
    const right = [[x1, y0, z0], [x1, y1, z0], [x1, y1, h], [x1, y0, h]];
    g.lineWidth = 1; g.strokeStyle = solid ? P.boxEdge : P.glassEdge;
    for (const [f, c] of [[left, P.boxL], [right, P.boxR], [top, P.boxTop]]) {
      poly(f); g.fillStyle = solid ? c : P.glass; g.fill(); g.stroke();
    }
  }

  function array(P, t, p) {
    const { x0, x1, y0, y1, zf, zb } = ARR;
    const z = (y) => mix(zb, zf, (y - y0) / (y1 - y0));
    // soft ground shadow, slid by the sun
    const sh = (p > 0 ? 0.6 : 0) * (1 - 2 * Math.abs(0.5 - clamp((hours() - 6) / 14)));
    poly([[x0 + 0.3, y0 + 0.5, 0], [x1 + 0.3, y0 + 0.5, 0], [x1 + 0.3, y1 + 0.3, 0], [x0 + 0.3, y1 + 0.3, 0]]);
    g.fillStyle = `rgba(0,0,10,${0.1 + 0.08 * sh})`; g.fill();
    // legs
    g.strokeStyle = P.frame; g.lineWidth = 1.2;
    for (const [x, y] of [[x0 + 0.25, y0 + 0.2], [x1 - 0.25, y0 + 0.2], [x0 + 0.25, y1 - 0.2], [x1 - 0.25, y1 - 0.2]]) {
      const [ax, ay] = iso(x, y, 0), [bx, by] = iso(x, y, z(y));
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    }
    // frame thickness (front lip)
    poly([[x0, y1, zf], [x1, y1, zf], [x1, y1, zf - 0.09], [x0, y1, zf - 0.09]]);
    g.fillStyle = P.panel[1]; g.fill();
    poly([[x1, y0, zb], [x1, y1, zf], [x1, y1, zf - 0.09], [x1, y0, zb - 0.09]]);
    g.fillStyle = P.panel[1]; g.fill();
    // tiles
    const cols = 5, rows = 3, gap = 0.06;
    const tw = (x1 - x0) / cols, th = (y1 - y0) / rows;
    const tiles = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const ax = x0 + c * tw + gap, bx = x0 + (c + 1) * tw - gap;
      const ay = y0 + r * th + gap, by = y0 + (r + 1) * th - gap;
      tiles.push({ ax, bx, ay, by, pts: [[ax, ay, z(ay)], [bx, ay, z(ay)], [bx, by, z(by)], [ax, by, z(by)]] });
    }
    // glass base: the sky's reflection, lighter at the back rows
    const [bx0, by0] = iso(x0, y0, zb), [bx1, by1] = iso(x1, y1, zf);
    const [lx, ly] = iso(x0, y1, zf), [rx, ry] = iso(x1, y0, zb);
    const base = g.createLinearGradient(bx0, by0, bx1, by1);
    base.addColorStop(0, P.panel[0]); base.addColorStop(1, P.panel[1]);
    g.beginPath();
    for (const q of tiles) q.pts.forEach((pt, i) => { const [sx, sy] = iso(...pt); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
    g.fillStyle = base; g.fill();
    // one continuous specular sheen gliding across the whole array (it reads as glass, not as tiles)
    g.save(); g.clip();
    const band = ((t * 0.035) % 1.7) - 0.35, warm = p > 0.02;
    const sg = g.createLinearGradient(lx, ly, rx, ry);
    const ssc = warm ? "255,214,170" : "160,200,255", k = 0.14 + 0.5 * Math.max(p, 0.25);
    for (const [o, a] of [[-0.22, 0], [-0.06, 0.35], [0, 1], [0.05, 0.35], [0.2, 0]]) {
      const pos = band + o;
      if (pos >= 0 && pos <= 1) sg.addColorStop(pos, `rgba(${ssc},${a * k})`);
    }
    g.fillStyle = sg; g.fillRect(0, 0, W, H);
    if (warm) { // warm light from the sun's side
      const wg = g.createLinearGradient(rx, ry, lx, ly);
      wg.addColorStop(0, `rgba(${P.amber},${0.3 * p})`); wg.addColorStop(0.7, `rgba(${P.amber},0)`);
      g.fillStyle = wg; g.fillRect(0, 0, W, H);
    }
    if (ptr.in > 0.01) glow(spot[0], spot[1], 120, "255,255,255", 0.22 * ptr.in);
    g.restore();
    // cell lines + crisp tile edges
    g.lineWidth = 0.5; g.strokeStyle = "rgba(255,255,255,0.08)";
    g.beginPath();
    for (const { ax, bx, ay, by } of tiles) {
      for (const f of [1 / 3, 2 / 3]) {
        const xm = mix(ax, bx, f); g.moveTo(...iso(xm, ay, z(ay))); g.lineTo(...iso(xm, by, z(by)));
      }
      const ym = (ay + by) / 2; g.moveTo(...iso(ax, ym, z(ym))); g.lineTo(...iso(bx, ym, z(ym)));
    }
    g.stroke();
    g.lineWidth = 0.7; g.strokeStyle = P.panelEdge;
    for (const q of tiles) { poly(q.pts); g.stroke(); }
    // a thin amber rim on the top edge while producing
    if (p > 0.02) {
      g.globalCompositeOperation = P.glowOp;
      g.strokeStyle = `rgba(${P.amber},${0.55 * p})`; g.lineWidth = 1;
      g.beginPath(); g.moveTo(...iso(x0, y0, zb)); g.lineTo(...iso(x1, y0, zb)); g.stroke();
      g.globalCompositeOperation = "source-over";
    }
  }

  function storage(P, soc, t, charging, discharging) {
    const b = BAT, ins = 0.1, lv = Math.max(0.06, b.h * soc * 0.94);
    // glass body, then the glowing charge level inside, then the front glass edges
    box(P, b, false);
    const inner = { x0: b.x0 + ins, x1: b.x1 - ins, y0: b.y0 + ins, y1: b.y1 - ins, h: lv };
    const [tx, ty] = iso(inner.x1, inner.y1, lv), [bx, by] = iso(inner.x1, inner.y1, 0);
    const lg = g.createLinearGradient(tx, ty, bx, by);
    lg.addColorStop(0, `rgba(${P.teal},0.85)`); lg.addColorStop(1, `rgba(${P.teal},0.25)`);
    const { x0, x1, y0, y1 } = inner;
    poly([[x0, y1, 0], [x1, y1, 0], [x1, y1, lv], [x0, y1, lv]]); g.fillStyle = lg; g.fill();
    poly([[x1, y0, 0], [x1, y1, 0], [x1, y1, lv], [x1, y0, lv]]); g.fillStyle = lg; g.fill();
    const pulse = charging || discharging ? 0.6 + 0.4 * Math.sin(t * 1.6) : 0.5;
    poly([[x0, y0, lv], [x1, y0, lv], [x1, y1, lv], [x0, y1, lv]]);
    g.fillStyle = `rgba(${P.teal},${0.55 + 0.3 * pulse})`; g.fill();
    g.globalCompositeOperation = P.glowOp;
    const [gx, gy] = iso((x0 + x1) / 2, (y0 + y1) / 2, lv);
    glow(gx, gy, 26, P.teal, 0.22 * pulse);
    g.globalCompositeOperation = "source-over";
    // glass edges in front
    g.strokeStyle = P.glassEdge; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(...iso(b.x1, b.y1, 0)); g.lineTo(...iso(b.x1, b.y1, b.h));
    g.moveTo(...iso(b.x0, b.y1, b.h)); g.lineTo(...iso(b.x1, b.y1, b.h)); g.lineTo(...iso(b.x1, b.y0, b.h));
    g.stroke();
  }

  function load(P, a, rgb) {
    // two stacked slabs with a glowing seam between them: the light shows energy being used
    const { x0, x1, y0, y1 } = LOAD, z = 0.62;
    box(P, { x0, x1, y0, y1, h: z }, true);
    const seam = (alpha, w) => {
      g.strokeStyle = `rgba(${rgb},${alpha})`; g.lineWidth = w;
      g.beginPath(); g.moveTo(...iso(x0, y1, z)); g.lineTo(...iso(x1, y1, z)); g.lineTo(...iso(x1, y0, z)); g.stroke();
    };
    g.globalCompositeOperation = P.glowOp;
    seam(0.12 * (0.3 + a), 6); seam(0.25 + 0.65 * a, 1.2);
    g.globalCompositeOperation = "source-over";
    box(P, { x0: x0 + 0.08, x1: x1 - 0.08, y0: y0 + 0.08, y1: y1 - 0.08, h: LOAD.h, z0: z + 0.07 }, true);
    g.globalCompositeOperation = P.glowOp;
    glow(...iso(x1, y1, z), 40, rgb, 0.2 * a);
    g.globalCompositeOperation = "source-over";
  }

  function draw(t) {
    const P = root.dataset.theme === "light" ? PAL.light : PAL.dark;
    const h = hours(), p = power(h), soc = charge(h);
    const charging = p > 0.05 && soc < 0.95, night = p <= 0.05 && soc > 0.28;
    shiftX = ptr.x * 5; shiftY = ptr.y * 4;
    g.clearRect(0, 0, W, H);
    const sp = sunPos(h);
    background(P, t, p, [sp.x, sp.y]);
    sunArc(P, h, t);
    grid(P);
    traces(P, t, {
      toLoad: { a: clamp(p * 1.4), c: P.amber },
      toBat: { a: charging ? clamp(p * 1.4) : 0, c: P.amber },
      batLoad: { a: night ? 0.9 : 0, c: P.teal },
    });
    array(P, t, p);
    storage(P, soc, t, charging, night);
    load(P, Math.max(clamp(p * 1.4), night ? 0.8 : 0.1), p > 0.05 ? P.amber : P.teal);
    // the pointer's soft light
    if (ptr.in > 0.01) {
      g.globalCompositeOperation = P.glowOp;
      glow(spot[0], spot[1], 170, P.spot, P.spotA * ptr.in);
      g.globalCompositeOperation = "source-over";
    }
  }

  // ---- loop ----
  let raf = 0, t0 = performance.now(), last = 0;
  const active = () => !document.hidden && !home.hidden && card.getClientRects().length > 0;
  function frame(now) {
    raf = 0;
    if (!active()) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const k = 1 - Math.exp(-dt * 4); // critically-damped-ish easing towards the pointer
    ptr.x = mix(ptr.x, tgt.x, k); ptr.y = mix(ptr.y, tgt.y, k); ptr.in = mix(ptr.in, tgt.in, k);
    card.style.setProperty("--rx", `${(-ptr.y * 5).toFixed(2)}deg`);
    card.style.setProperty("--ry", `${(ptr.x * 7).toFixed(2)}deg`);
    card.style.setProperty("--gx", `${(50 + ptr.x * 40).toFixed(1)}%`);
    draw((now - t0) / 1000);
    raf = requestAnimationFrame(frame);
  }
  function wake() {
    const on = active();
    card.classList.toggle("on", on);
    if (!on) return;
    if (reduce) { draw(20); return; }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  for (const k in TR) TR[k] = mkPath(TR[k]);
  document.addEventListener("visibilitychange", wake);
  addEventListener("resize", wake);
  new MutationObserver(wake).observe(home, { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(() => { if (reduce && active()) draw(20); }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  if (reduce) setInterval(() => { if (active()) draw(20); }, 60000);
  wake();
})();
