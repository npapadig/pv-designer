// Building blocks for the start-screen scene (hero.js / hero-world.js): small maths, a seeded random, noise,
// places on the planet, instancing, tubes and strips on the ground, and textures painted on canvases.
// Everything is made here in code: no image or model files.
import * as THREE from "./vendor/three/three.module.min.js";

export const V3 = THREE.Vector3;
export const TAU = Math.PI * 2;
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
export const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Seeded random numbers (mulberry32), so the town looks the same every time.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Classic 3D gradient noise (-1..1) and a few octaves of it.
const PERM = new Uint8Array(512);
{
  const r = rng(11), p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const grad = (h, x, y, z) => {
  const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
};
export function noise3(x, y, z) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  x -= X; y -= Y; z -= Z;
  const xi = X & 255, yi = Y & 255, zi = Z & 255;
  const u = fade(x), v = fade(y), w = fade(z);
  const A = PERM[xi] + yi, AA = PERM[A] + zi, AB = PERM[A + 1] + zi;
  const B = PERM[xi + 1] + yi, BA = PERM[B] + zi, BB = PERM[B + 1] + zi;
  return mix(
    mix(mix(grad(PERM[AA] & 15, x, y, z), grad(PERM[BA] & 15, x - 1, y, z), u),
      mix(grad(PERM[AB] & 15, x, y - 1, z), grad(PERM[BB] & 15, x - 1, y - 1, z), u), v),
    mix(mix(grad(PERM[AA + 1] & 15, x, y, z - 1), grad(PERM[BA + 1] & 15, x - 1, y, z - 1), u),
      mix(grad(PERM[AB + 1] & 15, x, y - 1, z - 1), grad(PERM[BB + 1] & 15, x - 1, y - 1, z - 1), u), v), w);
}
export function fbm(x, y, z, octaves = 3) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) { s += a * noise3(x * f, y * f, z * f); f *= 2.03; a *= 0.5; }
  return s;
}

// ---------- places on the planet ----------
const UP = new V3(0, 1, 0);
// A ball of radius R with an optional ground height (hills) as a function of the unit direction.
export class Globe {
  constructor(R) { this.R = R; this.height = () => 0; }
  // A frame at the unit direction n: f = "forward" (towards the viewer), r = right. q turns local axes into it.
  frame(n, fHint) {
    n = n.clone().normalize();
    const f = fHint.clone().addScaledVector(n, -fHint.dot(n)).normalize();
    const r = new V3().crossVectors(n, f);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, n, f));
    return { n, f, r, q };
  }
  // The unit direction at (u to the right, v forward) of frame F, measured along the ground.
  dir(F, u, v, out = new V3()) {
    const rho = Math.hypot(u, v);
    if (rho < 1e-9) return out.copy(F.n);
    const th = rho / this.R, s = Math.sin(th) / rho;
    return out.copy(F.n).multiplyScalar(Math.cos(th)).addScaledVector(F.r, u * s).addScaledVector(F.f, v * s).normalize();
  }
  point(F, u, v, h = 0) { const d = this.dir(F, u, v); return d.multiplyScalar(this.R + this.height(d) + h); }
  // Position and orientation there: local y = up, local z = the frame's forward, turned by `turn` around up.
  pose(F, u, v, h = 0, turn = 0) {
    const d = this.dir(F, u, v);
    const q = new THREE.Quaternion().setFromUnitVectors(F.n, d).multiply(F.q);
    if (turn) q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, turn));
    return { p: d.clone().multiplyScalar(this.R + this.height(d) + h), q, n: d };
  }
  matrix(F, u, v, h = 0, turn = 0, s = 1) {
    const P = this.pose(F, u, v, h, turn);
    return new THREE.Matrix4().compose(P.p, P.q, new V3(s, s, s));
  }
  // A new frame at (u, v) of F, turned by `turn`.
  sub(F, u, v, turn = 0) {
    const P = this.pose(F, u, v, 0, turn);
    return { n: P.n, f: new V3(0, 0, 1).applyQuaternion(P.q), r: new V3(1, 0, 0).applyQuaternion(P.q), q: P.q };
  }
  // Ground distance between two unit directions.
  dist(a, b) { return this.R * Math.acos(clamp(a.dot(b), -1, 1)); }
}

// ---------- instancing: many copies of the same shape and material in one draw ----------
const WHITE = new THREE.Color(1, 1, 1);
export class Kit {
  constructor() { this.groups = new Map(); }
  add(geo, mat, matrix, color = null) {
    const key = geo.uuid + mat.uuid;
    let g = this.groups.get(key);
    if (!g) this.groups.set(key, (g = { geo, mat, list: [], cols: [], mesh: null }));
    g.list.push(matrix);
    g.cols.push(color);
    return { g, i: g.list.length - 1 };
  }
  build(parent) {
    for (const g of this.groups.values()) {
      const m = new THREE.InstancedMesh(g.geo, g.mat, g.list.length);
      g.list.forEach((x, i) => m.setMatrixAt(i, x));
      if (g.cols.some(Boolean)) g.cols.forEach((c, i) => m.setColorAt(i, c || WHITE));
      m.castShadow = g.mat.userData.cast !== false;
      m.receiveShadow = g.mat.userData.receive !== false;
      m.computeBoundingSphere();
      parent.add(m);
      g.mesh = m;
    }
    return this;
  }
}

// Matrix of a box-like part: centre (x, y, z), size (sx, sy, sz), turned by ry (around y) and then rz/rx.
const _e = new THREE.Euler(), _q = new THREE.Quaternion();
export function partMatrix(x, y, z, sx, sy, sz, ry = 0, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, "YXZ");
  return new THREE.Matrix4().compose(new V3(x, y, z), _q.setFromEuler(_e), new V3(sx, sy, sz));
}
// Matrix of a thin beam from point a to point b (local units), with thickness t (and depth d).
const _yAxis = new V3(0, 1, 0);
export function beamMatrix(a, b, t, d = t) {
  const dir = new V3().subVectors(b, a), len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(_yAxis, dir.normalize());
  return new THREE.Matrix4().compose(new V3().addVectors(a, b).multiplyScalar(0.5), q, new V3(t, len, d));
}

// ---------- shapes ----------
// A unit gable prism: x -0.5..0.5, y 0..1 (ridge along z at the top), z -0.5..0.5.
export function prismGeometry() {
  const p = [-0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0.5, 0.5, 0, -0.5, -0.5, 0, -0.5, 0, 1, -0.5,
    -0.5, 0, -0.5, -0.5, 0, 0.5, 0, 1, 0.5, -0.5, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5,
    0.5, 0, 0.5, 0.5, 0, -0.5, 0, 1, -0.5, 0.5, 0, 0.5, 0, 1, -0.5, 0, 1, 0.5];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Array((p.length / 3) * 2).fill(0.5), 2));
  g.computeVertexNormals();
  return g;
}
// A unit triangle facing +z: base -0.5..0.5 at y = 0, tip at y = 1.
export function triangleGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
  g.computeVertexNormals();
  return g;
}
// A box with rounded edges (w, h, d in local units, radius r), centred. k = segments of each rounded edge.
export function roundedBoxGeometry(w, h, d, r, k = 4) {
  const n = 2 * (k + 1), s0 = 1 / (k + 1), half = [w / 2, h / 2, d / 2];
  const g = new THREE.BoxGeometry(2, 2, 2, n, n, n);
  const p = g.attributes.position, nr = g.attributes.normal, x = new V3(), c = new V3();
  // the middle segment of each side stays flat, the outer k segments bend around the edge
  const map = (s, H) => {
    const a = Math.abs(s);
    return a <= s0 ? (s / s0) * (H - r) : Math.sign(s) * (H - r + ((a - s0) / (1 - s0)) * r);
  };
  for (let i = 0; i < p.count; i++) {
    x.set(map(p.getX(i), half[0]), map(p.getY(i), half[1]), map(p.getZ(i), half[2]));
    c.set(clamp(x.x, r - half[0], half[0] - r), clamp(x.y, r - half[1], half[1] - r), clamp(x.z, r - half[2], half[2] - r));
    x.sub(c);
    const l = x.length();
    if (l < 1e-9) x.set(nr.getX(i), nr.getY(i), nr.getZ(i));
    else x.divideScalar(l);
    nr.setXYZ(i, x.x, x.y, x.z);
    p.setXYZ(i, c.x + x.x * r, c.y + x.y * r, c.z + x.z * r);
  }
  return g;
}

// ---------- nature: trees made of one piece, mountains ----------
// Paints a geometry with one colour and marks it as leaves (1, tinted per tree) or wood/rock (0).
function paint(g, c, leaf, shade = null) {
  const n = g.attributes.position.count, col = new Float32Array(n * 3), lf = new Float32Array(n).fill(leaf), p = g.attributes.position;
  for (let i = 0; i < n; i++) {
    const k = shade ? shade(p.getX(i), p.getY(i), p.getZ(i)) : 1;
    col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("leaf", new THREE.BufferAttribute(lf, 1));
  return g;
}
// A whole tree in one geometry (metres, ground at y = 0): 0 round, 1 pine, 2 cypress, 3 bush. fine = more detail.
export function treeGeometry(kind, fine) {
  const bark = new THREE.Color("#7a5a3c"), leaf = new THREE.Color(1, 1, 1);
  const lit = (top) => (x, y) => 0.8 + 0.3 * clamp(y / top); // a little lighter at the top, like light from the sky
  const ball = (r, x, y, z, sy = 1) => new THREE.IcosahedronGeometry(r, fine ? 2 : 1).scale(1, sy, 1).translate(x, y, z);
  const parts = [];
  if (kind === 0) {
    parts.push(paint(new THREE.CylinderGeometry(0.16, 0.22, 2.6, 6).translate(0, 1.3, 0), bark, 0));
    const crowns = fine ? [ball(1.95, 0, 3.9, 0, 1.08), ball(1.25, 0.95, 3.2, 0.5), ball(1.2, -0.8, 3.4, -0.55)] : [ball(2.0, 0, 3.9, 0, 1.08), ball(1.3, 0.9, 3.15, 0.45)];
    for (const b of crowns) parts.push(paint(b, leaf, 1, lit(6)));
  } else if (kind === 1) {
    parts.push(paint(new THREE.CylinderGeometry(0.14, 0.18, 1.6, 6).translate(0, 0.8, 0), bark, 0));
    const seg = fine ? 10 : 7;
    for (const [r, h, y] of [[1.6, 3.0, 2.6], [1.25, 2.5, 4.2], [0.85, 1.9, 5.6]]) parts.push(paint(new THREE.ConeGeometry(r, h, seg).translate(0, y, 0), leaf, 1, lit(6.5)));
  } else if (kind === 2) {
    parts.push(paint(new THREE.CylinderGeometry(0.12, 0.16, 1.0, 6).translate(0, 0.5, 0), bark, 0));
    parts.push(paint(ball(0.9, 0, 3.4, 0, 2.9), leaf, 1, lit(6)));
  } else {
    parts.push(paint(ball(1, 0, 0.7, 0, 0.85), leaf, 1, lit(1.6)));
  }
  for (const g of parts) g.deleteAttribute("uv");
  return mergeGeometries(parts);
}
// Leaves take the tree's own colour (instance colour); trunks keep their bark colour.
export function treeMaterial(o = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, ...o });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float leaf;")
      .replace("#include <color_vertex>", "vColor = color;\n#ifdef USE_INSTANCING_COLOR\nvColor *= mix(vec3(1.0), instanceColor.xyz, leaf);\n#endif");
  };
  m.customProgramCacheKey = () => "hero-tree";
  return m;
}
// A faceted mountain (base radius 1, height 1, base at y = 0) with rock, snow on top and grass at the foot.
export function mountainGeometry(seed) {
  const r = rng(seed);
  const g = new THREE.ConeGeometry(1, 1, 11, 6, true).translate(0, 0.5, 0);
  const p = g.attributes.position, lean = (r() - 0.5) * 0.35, o = r() * 10;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x);
    const k = 1 + 0.28 * noise3(Math.cos(a) * 1.3 + o, y * 2.4, Math.sin(a) * 1.3 + o) * (1 - y);
    const h = y + 0.12 * noise3(Math.cos(a) * 2 + o, y * 3, Math.sin(a) * 2) * y * (1 - y) * 4;
    p.setXYZ(i, x * k + lean * h * h, h, z * k);
  }
  const ng = g.toNonIndexed();
  g.dispose();
  ng.computeVertexNormals();
  const q = ng.attributes.position, n = q.count, col = new Float32Array(n * 3);
  const snow = new THREE.Color("#f2f5fa"), rockA = new THREE.Color("#8e909b"), rockB = new THREE.Color("#71747f"), grass = new THREE.Color("#6f9a52"), c = new THREE.Color();
  for (let t = 0; t < n; t += 3) {
    const y = (q.getY(t) + q.getY(t + 1) + q.getY(t + 2)) / 3, cx = q.getX(t) + q.getX(t + 1) + q.getX(t + 2), cz = q.getZ(t) + q.getZ(t + 1) + q.getZ(t + 2);
    const line = 0.6 + 0.09 * noise3(cx * 1.7 + o, 0, cz * 1.7);
    if (y > line) c.copy(snow);
    else if (y < 0.16) c.copy(grass).lerp(rockB, y / 0.16);
    else c.copy(rockA).lerp(rockB, 0.5 + 0.5 * noise3(cx * 3, y * 6 + o, cz * 3));
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (t + k) * 3);
  }
  ng.setAttribute("color", new THREE.BufferAttribute(col, 3));
  ng.deleteAttribute("uv");
  return ng;
}

// A tube along points (world units). "along" = distance from the start, for the energy pulses.
export function tubeGeometry(points, radius, radial = 5, start = 0) {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.5);
  const len = curve.getLength();
  const g = new THREE.TubeGeometry(curve, clamp(Math.ceil(len / 0.06), 4, 240), radius, radial, false);
  const uv = g.attributes.uv, along = new Float32Array(uv.count);
  for (let i = 0; i < uv.count; i++) along[i] = start + uv.getX(i) * len;
  g.setAttribute("along", new THREE.BufferAttribute(along, 1));
  g.userData.len = len;
  return g;
}
// Adds a constant attribute (one value per vertex) to a geometry.
export function tag(g, name, value) {
  g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(value), 1));
  return g;
}
// Joins indexed geometries that have the same attributes into one (one draw call).
export function mergeGeometries(list) {
  const names = Object.keys(list[0].attributes).filter((n) => list.every((g) => g.attributes[n]));
  const out = new THREE.BufferGeometry();
  let verts = 0, idx = 0;
  for (const g of list) { verts += g.attributes.position.count; idx += g.index ? g.index.count : g.attributes.position.count; }
  for (const n of names) {
    const size = list[0].attributes[n].itemSize, arr = new Float32Array(verts * size);
    let o = 0;
    for (const g of list) { arr.set(g.attributes[n].array, o); o += g.attributes[n].count * size; }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  const index = new Uint32Array(idx);
  let io = 0, vo = 0;
  for (const g of list) {
    const c = g.attributes.position.count;
    if (g.index) for (let k = 0; k < g.index.count; k++) index[io++] = g.index.array[k] + vo;
    else for (let k = 0; k < c; k++) index[io++] = k + vo;
    vo += c;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  list.forEach((g) => g.dispose());
  return out;
}

// Faces of a grid of (nx+1) x (ny+1) points, turned so that they look outwards (away from the planet centre).
function gridIndex(nx, ny, pos) {
  const idx = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const A = new V3().fromArray(pos, idx[0] * 3), B = new V3().fromArray(pos, idx[1] * 3), Cc = new V3().fromArray(pos, idx[2] * 3);
  const nrm = new V3().crossVectors(B.clone().sub(A), Cc.clone().sub(A));
  if (nrm.dot(A) < 0) for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
  return idx;
}
// A flat piece of ground lying on the planet: centre (cu, cv) of frame F, size w x h, turned, lifted.
// shape(x, y) (x, y in -0.5..0.5) can move the points, e.g. to make a round lake.
export function patchGeometry(globe, F, cu, cv, w, h, { turn = 0, lift = 0.004, nx = 8, ny = 8, uv = [1, 1], shape = null } = {}) {
  const pos = [], uvs = [], nor = [], c = Math.cos(turn), s = Math.sin(turn);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    let x = i / nx - 0.5, y = j / ny - 0.5;
    if (shape) [x, y] = shape(x, y);
    const lx = x * w, ly = y * h;
    const p = globe.point(F, cu + lx * c + ly * s, cv - lx * s + ly * c, lift);
    pos.push(p.x, p.y, p.z);
    const nn = p.clone().normalize();
    nor.push(nn.x, nn.y, nn.z);
    uvs.push((i / nx) * uv[0], (j / ny) * uv[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(gridIndex(nx, ny, pos));
  return g;
}
// Smooth (u, v) path through the given points (n points out).
export function smoothPath(pts, n) {
  return new THREE.CatmullRomCurve3(pts.map(([u, v]) => new V3(u, v, 0)), false, "centripetal").getPoints(n).map((p) => [p.x, p.y]);
}
// A band (road, path, river) along (u, v) points of frame F, width w (or w(t), t = 0..1 along the band).
// uv: x across, y = distance / tile.
export function stripGeometry(globe, F, pts, w, { lift = 0.006, tile = 1, step = 0.08 } = {}) {
  const dense = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [u0, v0] = pts[k], [u1, v1] = pts[k + 1], n = Math.max(1, Math.ceil(Math.hypot(u1 - u0, v1 - v0) / step));
    for (let i = 0; i < n; i++) dense.push([mix(u0, u1, i / n), mix(v0, v1, i / n)]);
  }
  dense.push(pts[pts.length - 1]);
  const pos = [], uvs = [], nor = [];
  let dist = 0;
  dense.forEach(([u, v], k) => {
    const a = dense[Math.max(0, k - 1)], b = dense[Math.min(dense.length - 1, k + 1)];
    let tu = b[0] - a[0], tv = b[1] - a[1];
    const l = Math.hypot(tu, tv) || 1;
    tu /= l; tv /= l;
    if (k) dist += Math.hypot(u - dense[k - 1][0], v - dense[k - 1][1]);
    const ww = typeof w === "function" ? w(k / (dense.length - 1)) : w;
    for (const side of [-0.5, 0.5]) {
      const p = globe.point(F, u + tv * ww * side, v - tu * ww * side, lift);
      pos.push(p.x, p.y, p.z);
      const nn = p.clone().normalize();
      nor.push(nn.x, nn.y, nn.z);
      uvs.push(side + 0.5, dist / tile);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(gridIndex(1, dense.length - 1, pos));
  return g;
}

// ---------- textures painted on canvases ----------
export function canvasTexture(w, h, draw, { color = true, wrap = false } = {}) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
const rgb = (r, g, b, a = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;

export const textures = {
  // Solar panel: dark blue cells, thin silver frame.
  panel: () => canvasTexture(96, 160, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, "#28508f"); gr.addColorStop(0.5, "#1a3a74"); gr.addColorStop(1, "#13295a");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(160,195,245,0.5)"; g.lineWidth = 1;
    for (let i = 1; i < 6; i++) { const x = 5 + ((w - 10) * i) / 6; g.beginPath(); g.moveTo(x, 5); g.lineTo(x, h - 5); g.stroke(); }
    for (let j = 1; j < 10; j++) { const y = 5 + ((h - 10) * j) / 10; g.beginPath(); g.moveTo(5, y); g.lineTo(w - 5, y); g.stroke(); }
    g.strokeStyle = "#d7dce3"; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4);
  }),
  // Vertical wooden slats.
  wood: () => canvasTexture(128, 128, (g, w, h) => {
    const r = rng(5);
    g.fillStyle = "#5c3a1f"; g.fillRect(0, 0, w, h);
    const n = 10, sw = w / n;
    for (let i = 0; i < n; i++) {
      const l = 0.82 + r() * 0.32;
      g.fillStyle = rgb(184 * l, 128 * l, 80 * l);
      g.fillRect(i * sw + 1.2, 0, sw - 2.4, h);
      g.strokeStyle = rgb(120 * l, 76 * l, 40 * l, 0.35);
      for (let k = 0; k < 2; k++) { const x = i * sw + 3 + r() * (sw - 6); g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + 1.5, h * 0.35, x - 1.5, h * 0.65, x, h); g.stroke(); }
    }
  }),
  // Dark sectional garage door.
  garage: () => canvasTexture(64, 64, (g, w, h) => {
    g.fillStyle = "#33373e"; g.fillRect(0, 0, w, h);
    for (let j = 1; j < 6; j++) { const y = (j * h) / 6; g.fillStyle = "#1b1e22"; g.fillRect(0, y - 1, w, 1.5); g.fillStyle = "rgba(255,255,255,0.08)"; g.fillRect(0, y + 0.5, w, 1); }
  }),
  // Window glass by day: sky reflection, thin dark frame, one mullion.
  glass: () => canvasTexture(128, 128, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "#9cc0da"); gr.addColorStop(0.5, "#4a6d88"); gr.addColorStop(1, "#24384b");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,0.22)";
    g.beginPath(); g.moveTo(w * 0.18, 0); g.lineTo(w * 0.42, 0); g.lineTo(w * 0.12, h); g.lineTo(-w * 0.12, h); g.fill();
    g.strokeStyle = "#262a30"; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
    g.lineWidth = 3; g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
  }),
  // Window at night: warm light inside, a lamp glow, the same frame.
  glow: () => canvasTexture(128, 128, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "#ffe9c2"); gr.addColorStop(1, "#ffa24f");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(w * 0.3, h * 0.28, 2, w * 0.3, h * 0.28, w * 0.55);
    rg.addColorStop(0, "rgba(255,252,236,0.95)"); rg.addColorStop(1, "rgba(255,252,236,0)");
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(120,60,20,0.22)"; g.fillRect(w * 0.62, h * 0.55, w * 0.26, h * 0.45);
    g.strokeStyle = "#2b2420"; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
    g.lineWidth = 3; g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
  }),
  // Battery container: white ribbed steel, teal stripe, doors.
  container: () => canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = "#eef1f4"; g.fillRect(0, 0, w, h);
    for (let x = 3; x < w; x += 5) { g.fillStyle = "rgba(120,135,150,0.22)"; g.fillRect(x, 0, 1.5, h); }
    g.fillStyle = "#1fbfac"; g.fillRect(0, h * 0.64, w, h * 0.1);
    g.strokeStyle = "rgba(90,100,115,0.55)"; g.lineWidth = 1.5;
    for (const x of [0.16, 0.42, 0.68]) g.strokeRect(w * x, h * 0.12, w * 0.16, h * 0.44);
    g.fillStyle = "#9aa6b2"; for (const x of [0.18, 0.44, 0.7]) g.fillRect(w * x, h * 0.18, w * 0.12, h * 0.08);
  }),
  // Lawn with soft mowing stripes.
  lawn: () => canvasTexture(64, 64, (g, w, h) => {
    for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? "#86c766" : "#78bb5a"; g.fillRect(0, (i * h) / 4, w, h / 4); }
  }, { wrap: true }),
  // Field with rows of crops (stripes), in two tones.
  field: (a, b) => canvasTexture(64, 64, (g, w, h) => {
    g.fillStyle = a; g.fillRect(0, 0, w, h);
    g.fillStyle = b; for (let i = 0; i < 8; i++) g.fillRect(0, (i * h) / 8, w, h / 16);
  }, { wrap: true }),
  // Asphalt with a dashed centre line (uv: x across, y along).
  road: () => canvasTexture(64, 64, (g, w, h) => {
    g.fillStyle = "#5d6269"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#c9cdd2"; g.fillRect(0, 0, w * 0.06, h); g.fillRect(w * 0.94, 0, w * 0.06, h);
    g.fillStyle = "rgba(255,255,255,0.85)"; g.fillRect(w * 0.48, 0, w * 0.04, h * 0.5);
  }, { wrap: true }),
  // Soft round spot, grey levels on black: light pools (added light) and soft shadows under things (alpha mask).
  spot: () => canvasTexture(64, 64, (g, w, h) => {
    g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    rg.addColorStop(0, "#fff"); rg.addColorStop(0.4, "#777"); rg.addColorStop(0.75, "#1c1c1c"); rg.addColorStop(1, "#000");
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
  }, { color: false }),
  // Small ripples for water (a normal map that tiles); moved slowly so the water seems to live.
  ripples: () => canvasTexture(128, 128, (g, w, h) => {
    const WAVES = [[3, 1, 0.3, 1], [1, 4, 1.7, 0.8], [5, -2, 2.1, 0.5], [-2, 6, 0.9, 0.45], [7, 3, 4.0, 0.3], [-6, 5, 2.6, 0.25]];
    const hgt = (x, y) => WAVES.reduce((s, [a, b, ph, amp]) => s + amp * Math.sin(TAU * ((a * x) / w + (b * y) / h) + ph), 0);
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const nx = -(hgt(x + 1, y) - hgt(x - 1, y)), ny = -(hgt(x, y + 1) - hgt(x, y - 1)), l = Math.hypot(nx, ny, 1), i = (y * w + x) * 4;
      img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, { color: false, wrap: true }),
  // Lightning bolt (white on transparent): tinted teal on the chargers.
  bolt: () => canvasTexture(64, 64, (g) => {
    g.fillStyle = "#fff";
    g.beginPath(); g.moveTo(38, 4); g.lineTo(14, 36); g.lineTo(30, 36); g.lineTo(24, 60); g.lineTo(50, 26); g.lineTo(34, 26); g.lineTo(40, 4); g.closePath(); g.fill();
  }),
  // Sun: a warm halo (added light) and a clear golden disc on top of it.
  sun: () => canvasTexture(256, 256, (g, w, h) => {
    const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    rg.addColorStop(0, "rgba(255,214,140,0.9)"); rg.addColorStop(0.18, "rgba(255,196,110,0.45)");
    rg.addColorStop(0.45, "rgba(255,180,100,0.12)"); rg.addColorStop(1, "rgba(255,170,90,0)");
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
  }),
  sunDisc: () => canvasTexture(128, 128, (g, w, h) => {
    const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    rg.addColorStop(0, "rgba(255,253,236,1)"); rg.addColorStop(0.62, "rgba(255,240,190,1)"); rg.addColorStop(0.8, "rgba(255,214,120,0.6)"); rg.addColorStop(1, "rgba(255,200,100,0)");
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
  }),
  // Crescent moon with a faint earthshine and halo.
  moon: () => canvasTexture(256, 256, (g, w, h) => {
    const c = w / 2, r = w * 0.2;
    const halo = g.createRadialGradient(c, c, r * 0.8, c, c, w / 2);
    halo.addColorStop(0, "rgba(190,205,255,0.32)"); halo.addColorStop(1, "rgba(190,205,255,0)");
    g.fillStyle = halo; g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(150,162,205,0.28)"; g.beginPath(); g.arc(c, c, r, 0, TAU); g.fill();
    const k = document.createElement("canvas"); k.width = w; k.height = h;
    const q = k.getContext("2d"), lit = q.createRadialGradient(c + r * 0.4, c + r * 0.3, r * 0.1, c, c, r);
    lit.addColorStop(0, "#fffbea"); lit.addColorStop(1, "#efe0b0");
    q.fillStyle = lit; q.beginPath(); q.arc(c, c, r, 0, TAU); q.fill();
    q.globalCompositeOperation = "destination-out";
    q.beginPath(); q.arc(c - r * 0.45, c - r * 0.3, r * 0.92, 0, TAU); q.fill();
    g.drawImage(k, 0, 0);
  }),
};
