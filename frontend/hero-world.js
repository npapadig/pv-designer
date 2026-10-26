// The start-screen world for hero.js: a small planet with an electrified town (modern white two-storey houses with
// solar roofs, home batteries, wall chargers and electric cars), far behind it a solar park with big battery
// containers, pylons and cables to the town (the energy pulses only travel inside cables), and a lot of nature:
// snowy mountains, lakes, a river, fields and forests. Sky, sun, moon, stars and clouds around it.
// update() moves everything between day (night = 0, light theme) and night (night = 1, dark theme).
import * as THREE from "./vendor/three/three.module.min.js";
import {
  V3, TAU, clamp, mix, smooth, rng, fbm, Globe, Kit, partMatrix, beamMatrix, prismGeometry, triangleGeometry,
  roundedBoxGeometry, tubeGeometry, tag, mergeGeometries, patchGeometry, stripGeometry, smoothPath, textures,
  treeGeometry, treeMaterial, mountainGeometry,
} from "./hero-kit.js";

export const R = 10; // planet radius
const M = 0.05; // one metre
const color = (h) => new THREE.Color(h);
const drop = (x, z) => (M * (x * x + z * z)) / (2 * R); // metres the round ground falls away from a flat house plan

// Layout in the town frame (u to the right, v towards the viewer, in planet units).
const PARK = [7.4, -2.6, -0.3]; // solar park centre and turn: far to the right of the town, seen well from the wide view
const PARK_SUB = [-1.3, 1.05]; // substation (in the park's own frame), where the line to the town starts
const PARK_YARD = [-1.3, -0.1]; // battery containers (park frame)
const LAKES = [[-3.9, 1.75, 1.8, 1.5, 0.2], [1.75, -3.05, 1.45, 0.85, -0.25], [5.3, 0.75, 1.15, 0.8, 0.4]]; // u, v, w, h, turn
const RIVER = smoothPath([[-1.7, -4.25], [-2.5, -3.45], [-3.6, -3.0], [-4.4, -2.0], [-4.9, -0.8], [-4.8, 0.35], [-4.45, 1.12]], 60);
const MOUNTAINS = [ // u, v, base radius, height, shape, turn
  [-2.2, -4.95, 1.75, 1.75, 0, 0.3], [-0.85, -5.35, 1.45, 1.35, 1, 1.1], [-3.7, -4.3, 1.5, 1.4, 2, 2.0],
  [0.45, -5.55, 1.2, 1.0, 0, 2.6], [-4.95, -3.3, 1.3, 1.15, 1, 0.7], [8.9, -5.2, 1.6, 1.5, 2, 1.5], [10.2, -3.2, 1.15, 0.95, 0, 0.2],
  [3.6, -5.6, 1.25, 1.1, 1, 0.9],
];
const HOUSES = [ // u, v, turn, mirrored, gable roof
  [-2.0, -0.76, 0.05, false, true], [-0.7, -0.79, -0.03, true, false], [0.6, -0.76, 0.03, false, true],
  [1.9, -0.73, -0.05, true, true], [-1.35, 0.61, -0.04, true, true], [-0.05, 0.63, 0.03, false, false],
  [1.25, 0.6, -0.02, true, true], [2.55, 0.58, 0.05, false, true],
];
const STREET_A = [[-3.5, 0], [3.62, 0]];
const STREET_B = [[-2.9, 1.38], [2.95, 1.38], [3.42, 1.18], [3.62, 0.62], [3.62, 0.05]];
const KIOSK = [3.98, -0.42];
const FIELDS = [ // u, v, w, h, turn, texture
  [-2.6, -2.15, 1.5, 0.95, 0.2, "wheat"], [-0.6, -2.55, 1.2, 0.9, -0.1, "crop"], [0.05, -3.65, 1.0, 0.7, 0.15, "dry"],
  [3.4, -3.3, 1.2, 0.9, -0.25, "wheat"], [-2.3, 3.1, 1.1, 0.8, 0.35, "crop"], [2.7, 2.6, 1.3, 0.8, 0.1, "crop"],
  [7.0, 0.35, 1.0, 0.75, -0.3, "wheat"],
];

// Camera shots: target point (frame + u, v), camera direction above the ground there (az, el), a starting distance
// and its limits. hero.js moves the target and sets the distance so that the shot's subject (see subject()) fits the
// free part of the screen next to or below the start screen's cards.
export const SHOTS = {
  overview: { frame: "town", at: [3.6, -1.1], az: 0.35, el: 0.72, d: 17, dMin: 11, dMax: 30 },
  town: { frame: "town", at: [1.6, 0.1], az: 0.42, el: 0.5, d: 6, dMin: 3.2, dMax: 28 },
  park: { frame: "park", at: [-0.2, 0.2], az: -0.9, el: 0.62, d: 6, dMin: 3.2, dMax: 28 },
};

// Built in a few steps that give the browser a breath in between, so the start screen never feels stuck.
const rest = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function buildWorld(renderer) {
  const scene = new THREE.Scene();
  const own = new Set();
  const keep = (x) => (own.add(x), x);
  const rand = rng(20261026);
  const globe = new Globe(R);
  const town = globe.frame(new V3(0, 1, 0), new V3(0, 0, 1));
  const park = globe.sub(town, PARK[0], PARK[1], PARK[2]);
  const frames = { town, park };
  // (u, v) of a unit direction in the town frame (the inverse of globe.dir).
  const uvOf = (d) => {
    const th = Math.acos(clamp(d.dot(town.n), -1, 1)), s = th < 1e-6 ? R : (R * th) / Math.sin(th);
    return [s * d.dot(town.r), s * d.dot(town.f)];
  };
  const parkUV = (u, v) => uvOf(globe.dir(park, u, v));
  const SUB = parkUV(...PARK_SUB);
  const ROAD = [[3.62, 0], [4.3, -0.42], [4.95, -0.95], [5.55, -1.4], parkUV(PARK_SUB[0] + 0.32, PARK_SUB[1] + 0.22)];
  // the direction the wide view looks from: only what can be seen from there gets trees
  const viewAxis = (() => {
    const s = SHOTS.overview, P = globe.pose(town, ...s.at);
    const dir = new V3(Math.sin(s.az) * Math.cos(s.el), Math.sin(s.el), Math.cos(s.az) * Math.cos(s.el)).applyQuaternion(P.q);
    return P.p.clone().addScaledVector(dir, s.d).normalize();
  })();

  // ---------- ground: flat where things stand, gentle hills elsewhere ----------
  const segDist = (u, v, a, b) => {
    const du = b[0] - a[0], dv = b[1] - a[1], t = clamp(((u - a[0]) * du + (v - a[1]) * dv) / (du * du + dv * dv));
    return Math.hypot(u - a[0] - du * t, v - a[1] - dv * t);
  };
  const zones = [[-1.9, 0.3, 1.55], [0.1, 0.3, 1.6], [2.1, 0.3, 1.6], [3.7, 0.1, 1.0], [PARK[0], PARK[1], 2.15],
    ...LAKES.map(([u, v, w, h]) => [u, v, Math.max(w, h) * 0.62]), ...FIELDS.map(([u, v, w, h]) => [u, v, Math.max(w, h) * 0.62])];
  const lanes = [[KIOSK, SUB, 0.5], ...ROAD.slice(1).map((p, k) => [ROAD[k], p, 0.3]), ...RIVER.slice(1).map((p, k) => [RIVER[k], p, 0.22])]
    .map(([a, b, w]) => [a, b, w, Math.min(a[0], b[0]) - w - 0.6, Math.max(a[0], b[0]) + w + 0.6, Math.min(a[1], b[1]) - w - 0.6, Math.max(a[1], b[1]) + w + 0.6]);
  const flat = (u, v) => {
    let f = 1;
    for (const [zu, zv, r] of zones) if (Math.abs(u - zu) < r + 0.8 && Math.abs(v - zv) < r + 0.8) f *= smooth(r, r + 0.8, Math.hypot(u - zu, v - zv));
    for (const [a, b, w, u0, u1, v0, v1] of lanes) if (u > u0 && u < u1 && v > v0 && v < v1) f *= smooth(w, w + 0.5, segDist(u, v, a, b));
    return f;
  };
  const hill = (d) => Math.pow(Math.max(0, fbm(d.x * 2.1 + 1.3, d.y * 2.1 - 0.7, d.z * 2.1 + 2.1, 4) + 0.06), 1.3) * 1.35;
  globe.height = (d) => { const [u, v] = uvOf(d); return hill(d) * flat(u, v); };
  const forest = (d) => smooth(0.02, 0.26, fbm(d.x * 3.3 - 4, d.y * 3.3 + 1, d.z * 3.3, 3));

  // ---------- textures, materials, shapes ----------
  const T = {};
  for (const k of ["panel", "wood", "garage", "glass", "glow", "container", "lawn", "road", "spot", "bolt", "sun", "sunDisc", "moon", "ripples"]) T[k] = keep(textures[k]());
  T.wheat = keep(textures.field("#dcbc62", "#c9a24e"));
  T.crop = keep(textures.field("#93c95f", "#7bb24f"));
  T.dry = keep(textures.field("#c2c574", "#adb262"));
  T.ripples.repeat.set(3, 3);
  const std = (o) => keep(new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...o }));
  const flatMat = (o) => keep(new THREE.MeshBasicMaterial({ toneMapped: false, ...o }));
  const mat = {
    white: std({ color: "#f4f2ed" }),
    dark: std({ color: "#2f333a", roughness: 0.55 }),
    roof: std({ color: "#b9bdc2", roughness: 0.95 }),
    wood: std({ map: T.wood, roughness: 0.7 }),
    garage: std({ map: T.garage, roughness: 0.45, metalness: 0.25 }),
    glass: std({ map: T.glass, roughness: 0.06, metalness: 0.1, envMapIntensity: 1.4 }),
    panel: std({ map: T.panel, roughness: 0.2, metalness: 0.35, envMapIntensity: 1.2 }),
    metal: std({ color: "#a3abb5", roughness: 0.4, metalness: 0.65 }),
    insulator: std({ color: "#d8dde2", roughness: 0.3 }),
    paving: std({ color: "#d2cdc3", roughness: 0.95 }),
    stone: std({ color: "#e2ded6", roughness: 0.9 }),
    car: std({ color: "#ffffff", roughness: 0.3, metalness: 0.35, envMapIntensity: 1.0 }),
    carGlass: std({ color: "#18202b", roughness: 0.05, metalness: 0.3, envMapIntensity: 1.5 }),
    tyre: std({ color: "#1c1e22", roughness: 0.8 }),
    leaf: std({ color: "#ffffff", roughness: 0.9 }),
    rock: std({ color: "#9a9a92", roughness: 0.9, flatShading: true }),
    mountain: std({ vertexColors: true, flatShading: true, roughness: 0.92 }),
    container: std({ map: T.container, roughness: 0.5, metalness: 0.15 }),
    concrete: std({ color: "#cfcbc4", roughness: 0.95 }),
    kiosk: std({ color: "#a9bcb1", roughness: 0.8 }),
    lawn: std({ map: T.lawn, roughness: 1 }),
    road: std({ map: T.road, roughness: 0.92 }),
    gravel: std({ color: "#c7c79a", roughness: 1 }),
    water: std({ color: "#3a8cc4", roughness: 0.1, metalness: 0.1, envMapIntensity: 1.25, normalMap: T.ripples, normalScale: new THREE.Vector2(0.3, 0.3) }),
    sand: std({ color: "#ddd2a2", roughness: 1 }),
    bank: std({ color: "#8aa860", roughness: 1 }),
    cable: std({ color: "#2a2e36", roughness: 0.6 }),
    led: flatMat({ color: "#ffffff" }),
    bolt: flatMat({ color: "#45f2dc", map: T.bolt, transparent: true }),
    lamp: flatMat({ color: "#555555" }),
    head: flatMat({ color: "#ffffff" }),
    tail: flatMat({ color: "#ff3b4e" }),
    winGlow: flatMat({ map: T.glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
  for (const k of ["led", "bolt", "lamp", "head", "tail", "winGlow", "glass", "lawn", "road", "gravel", "water", "sand", "bank", "paving", "cable"]) mat[k].userData.cast = false;
  const treeMat = keep(treeMaterial()), treeFar = keep(treeMaterial());
  treeFar.userData.cast = false;
  const G = {
    box: keep(new THREE.BoxGeometry(1, 1, 1)),
    cyl: keep(new THREE.CylinderGeometry(0.5, 0.5, 1, 12)),
    ball: keep(new THREE.IcosahedronGeometry(1, 2)),
    puff: keep(new THREE.IcosahedronGeometry(1, 3)),
    rock: keep(new THREE.DodecahedronGeometry(1, 0)),
    prism: keep(prismGeometry()),
    tri: keep(triangleGeometry()),
    plane: keep(new THREE.PlaneGeometry(1, 1)),
    decal: keep(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
    carBody: keep(roundedBoxGeometry(1.86, 0.78, 4.62, 0.3)),
    carTop: keep(roundedBoxGeometry(1.58, 0.68, 2.7, 0.3)),
    carRoof: keep(roundedBoxGeometry(1.42, 0.18, 1.95, 0.08, 2)),
    wheel: keep(new THREE.CylinderGeometry(0.37, 0.37, 0.27, 16).rotateZ(Math.PI / 2)),
    trees: [0, 1, 2, 3].map((k) => ({ near: keep(treeGeometry(k, true)), far: keep(treeGeometry(k, false)) })),
    mountains: [3, 7, 11].map((s) => keep(mountainGeometry(s))),
  };
  const kit = new Kit();
  const add = (g, m, x, c) => kit.add(g, m, x, c);

  // Things that change with day and night, filled while building.
  const windows = []; // { ref, pool, th, b }
  const leds = []; // battery level lights { ref, k }
  const glowPts = []; // [x, y, z, r, g, b, size, kind]  kind: 0 night only, 1 always, 2 blinking at night
  const routes = []; // energy routes { pts, mode, r, glow }  mode: 0 day, 1 night, 2 always
  const blobs = []; // soft shadows under things (matrices)
  const pools = []; // light pools on the ground { m, lamp }
  const glow = (p, c, size, kind = 0) => glowPts.push([p.x, p.y, p.z, c.r, c.g, c.b, size, kind]);
  const WARM = color("#ffb766"), TEALC = color("#2ff0d6"), RED = color("#ff3046");

  // ---------- sky (a gradient behind everything), stars, sun, moon ----------
  const skyU = {
    uRes: { value: new THREE.Vector2(1, 1) }, uTop: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uLow: { value: new THREE.Color() },
    uSun: { value: new THREE.Vector2() }, uSunCol: { value: color("#ffcf7a") }, uSunAmt: { value: 1 },
    uMoon: { value: new THREE.Vector2() }, uMoonCol: { value: color("#8fa2ff") }, uMoonAmt: { value: 0 },
    uPlanet: { value: new THREE.Vector3() }, uLimb: { value: new THREE.Color() },
  };
  const sky = new THREE.Mesh(keep(new THREE.PlaneGeometry(2, 2)), keep(new THREE.ShaderMaterial({
    uniforms: skyU, depthTest: false, depthWrite: false,
    vertexShader: "void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }",
    fragmentShader: `
      uniform vec2 uRes, uSun, uMoon; uniform vec3 uTop, uMid, uLow, uSunCol, uMoonCol, uPlanet, uLimb; uniform float uSunAmt, uMoonAmt;
      void main() {
        vec2 p = gl_FragCoord.xy; float y = p.y / uRes.y;
        vec3 c = mix(uLow, uMid, smoothstep(0.0, 0.55, y));
        c = mix(c, uTop, smoothstep(0.45, 1.0, y));
        float dl = max(length(p - uPlanet.xy) - uPlanet.z, 0.0) / uRes.y;
        c += uLimb * exp(-dl * 7.0);
        float ds = length(p - uSun) / uRes.y;
        c += uSunCol * uSunAmt * (0.3 * exp(-ds * 6.0) + 0.45 * exp(-ds * 22.0));
        float dm = length(p - uMoon) / uRes.y;
        c += uMoonCol * uMoonAmt * 0.3 * exp(-dm * 8.0);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  })));
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  const starU = { uNight: { value: 0 }, uTime: { value: 0 }, uPR: { value: 1 } };
  {
    const N = 1600, pos = new Float32Array(N * 3), size = new Float32Array(N), ph = new Float32Array(N), d = new V3();
    for (let i = 0; i < N;) {
      d.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      if (d.lengthSq() > 1 || d.lengthSq() < 0.01) continue;
      d.normalize().multiplyScalar(420);
      pos.set([d.x, d.y, d.z], i * 3);
      size[i] = 0.9 + Math.pow(rand(), 3) * 2.8;
      ph[i] = rand() * TAU;
      i++;
    }
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    g.setAttribute("phase", new THREE.BufferAttribute(ph, 1));
    const stars = new THREE.Points(g, keep(new THREE.ShaderMaterial({
      uniforms: starU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float size, phase; uniform float uTime, uNight, uPR; varying float vA;
        void main() {
          vA = uNight * (0.6 + 0.4 * sin(uTime * (0.8 + fract(phase * 3.7) * 1.6) + phase));
          gl_PointSize = size * uPR * 2.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vA;
        void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float a = vA * smoothstep(1.0, 0.0, d); gl_FragColor = vec4(vec3(0.95, 0.97, 1.0) * a, a); }`,
    })));
    stars.frustumCulled = false;
    scene.add(stars);
  }
  const sprite = (map, blending) => {
    const s = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, fog: false, toneMapped: false, blending })));
    scene.add(s);
    return s;
  };
  const sun = sprite(T.sun, THREE.AdditiveBlending), sunDisc = sprite(T.sunDisc, THREE.NormalBlending), moon = sprite(T.moon, THREE.NormalBlending);

  // ---------- light ----------
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  const key = new THREE.DirectionalLight(0xffffff, 2.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 2, far: 60 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  const focusUV = [3.0, -1.2], focusPoint = globe.point(town, ...focusUV); // between the town and the park
  key.target.position.copy(focusPoint);
  scene.add(hemi, key, key.target);
  // low golden sun from the right (long shadows to the left), moonlight from higher up
  const SUN_DIR = new V3().addScaledVector(town.r, 0.8).addScaledVector(town.n, 0.5).addScaledVector(town.f, 0.33).normalize();
  const MOON_DIR = new V3().addScaledVector(town.r, 0.45).addScaledVector(town.n, 0.78).addScaledVector(town.f, 0.42).normalize();
  scene.fog = new THREE.Fog(0xffffff, 24, 70);

  // Reflections: a soft sky-and-ground picture for glass, panels, water and cars.
  {
    const pm = new THREE.PMREMGenerator(renderer), envScene = new THREE.Scene();
    const eg = new THREE.SphereGeometry(50, 32, 16), em = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: "varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `varying vec3 vP; void main() {
        vec3 top = vec3(0.38, 0.58, 0.9), hor = vec3(1.0, 0.93, 0.82), gnd = vec3(0.22, 0.3, 0.17);
        vec3 c = vP.y > 0.0 ? mix(hor, top, pow(vP.y, 0.55)) : mix(hor, gnd, pow(-vP.y, 0.35));
        c += vec3(1.0, 0.85, 0.6) * pow(max(dot(vP, normalize(vec3(0.8, 0.5, 0.33))), 0.0), 64.0) * 6.0;
        gl_FragColor = vec4(c, 1.0); }`,
    });
    envScene.add(new THREE.Mesh(eg, em));
    const rt = keep(pm.fromScene(envScene, 0.03));
    scene.environment = rt.texture;
    pm.dispose(); eg.dispose(); em.dispose();
  }
  await rest();

  // ---------- planet ----------
  await rest();
  const rimU = { value: new THREE.Color() };
  {
    const pg = new THREE.SphereGeometry(R, 288, 176).rotateZ(Math.PI / 2);
    const pp = pg.attributes.position, cols = new Float32Array(pp.count * 3), d = new V3(), c = new THREE.Color();
    const GR = [color("#74bf55"), color("#55a347"), color("#93cf64"), color("#3b8540"), color("#b4c065")], hidden = color("#4f9a45");
    for (let i = 0; i < pp.count; i++) {
      if (i && i % 9000 === 0) await rest();
      d.fromBufferAttribute(pp, i).normalize();
      if (d.dot(viewAxis) < -0.25) { cols.set([hidden.r, hidden.g, hidden.b], i * 3); continue; } // never seen: keep it simple
      const h = globe.height(d);
      pp.setXYZ(i, d.x * (R + h), d.y * (R + h), d.z * (R + h));
      const n1 = fbm(d.x * 3.2, d.y * 3.2, d.z * 3.2, 3), n2 = fbm(d.x * 9 + 4, d.y * 9, d.z * 9, 2);
      c.copy(GR[0]).lerp(GR[1], smooth(-0.25, 0.3, n1)).lerp(GR[2], smooth(0.15, 0.45, n2) * 0.45)
        .lerp(GR[4], smooth(0.3, 0.55, -n1) * 0.5).lerp(GR[3], forest(d) * 0.6).lerp(GR[2], clamp(h * 0.8) * 0.3);
      cols.set([c.r, c.g, c.b], i * 3);
    }
    pg.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    pg.computeVertexNormals();
    const pmat = std({ vertexColors: true, roughness: 1 });
    pmat.onBeforeCompile = (sh) => {
      sh.uniforms.uRim = rimU;
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform vec3 uRim;").replace("#include <opaque_fragment>",
        "outgoingLight += uRim * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.6);\n#include <opaque_fragment>");
    };
    const planet = new THREE.Mesh(keep(pg), pmat);
    planet.receiveShadow = true; // (casting its own hill shadows would cost a lot for little)
    scene.add(planet);
  }
  // Glow of the air around the planet, strongest at its edge.
  const atmoU = { uColor: { value: new THREE.Color() }, uAmt: { value: 1 } };
  scene.add(new THREE.Mesh(keep(new THREE.SphereGeometry(R * 1.1, 96, 64)), keep(new THREE.ShaderMaterial({
    uniforms: atmoU, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vN, vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uAmt; varying vec3 vN, vV;
      void main() { float k = clamp(-dot(normalize(vN), normalize(vV)) / 0.42, 0.0, 1.0); gl_FragColor = vec4(uColor * pow(k, 3.0) * uAmt, 1.0);
      #include <colorspace_fragment>
      }`,
  }))));

  // ---------- ground pieces: lakes, river, fields, roads ----------
  await rest();
  const disc = (wobble) => (x, y) => {
    const X = 2 * x, Y = 2 * y, dx = X * Math.sqrt(1 - (Y * Y) / 2), dy = Y * Math.sqrt(1 - (X * X) / 2), k = 1 + wobble(Math.atan2(dy, dx));
    return [(dx * k) / 2, (dy * k) / 2];
  };
  const ground = (geos, m) => { const me = new THREE.Mesh(keep(mergeGeometries(geos)), m); me.receiveShadow = true; scene.add(me); return me; };
  const shores = [], waters = [];
  LAKES.forEach(([u, v, w, h, turn], k) => {
    const shape = disc((a) => 0.1 * Math.sin(3 * a + 1 + k) + 0.06 * Math.sin(5 * a + 2 + k * 2));
    shores.push(patchGeometry(globe, town, u, v, w * 1.14, h * 1.16, { turn, lift: 0.004, nx: 24, ny: 24, shape }));
    waters.push(patchGeometry(globe, town, u, v, w, h, { turn, lift: 0.007, nx: 24, ny: 24, shape, uv: [w * 2, h * 2] }));
  });
  ground(shores, mat.sand);
  ground([stripGeometry(globe, town, RIVER, (t) => 0.2 + 0.12 * t, { lift: 0.0045, tile: 0.5, step: 0.05 })], mat.bank);
  waters.push(stripGeometry(globe, town, RIVER, (t) => 0.11 + 0.1 * t, { lift: 0.0068, tile: 0.5, step: 0.05 }));
  ground(waters, mat.water);
  const fieldMats = {};
  for (const [u, v, w, h, turn, tx] of FIELDS) {
    if (!fieldMats[tx]) { fieldMats[tx] = std({ map: T[tx], roughness: 1 }); fieldMats[tx].userData.cast = false; }
    ground([patchGeometry(globe, town, u, v, w, h, { turn, lift: 0.004, nx: 10, ny: 10, uv: [1, 6] })], fieldMats[tx]);
  }
  ground([stripGeometry(globe, town, STREET_A, 0.31, { tile: 0.7 }), stripGeometry(globe, town, STREET_B, 0.29, { tile: 0.7, lift: 0.0062 }),
    stripGeometry(globe, town, ROAD, 0.24, { tile: 0.7, lift: 0.0064 })], mat.road);

  // ---------- mountains with snow ----------
  for (const [u, v, r, h, shape, turn] of MOUNTAINS) {
    add(G.mountains[shape], mat.mountain, globe.matrix(town, u, v, -0.3, turn, 1).multiply(partMatrix(0, 0, 0, r, h + 0.3, r)));
    add(G.mountains[(shape + 1) % 3], mat.mountain, globe.matrix(town, u + r * 0.55, v + r * 0.25, -0.3, turn + 1, 1).multiply(partMatrix(0, 0, 0, r * 0.6, h * 0.62 + 0.3, r * 0.6)));
  }

  // ---------- trees (one piece each), bushes, rocks ----------
  const LEAVES = ["#4f9a45", "#5aa64c", "#3f8a3e", "#6bb055", "#367d3b", "#7cb85a"].map(color);
  const PINES = ["#2f6f3f", "#3b7d47", "#2a6438", "#356f44"].map(color);
  const CYPRESS = ["#2d5f37", "#335f3a"].map(color);
  function tree(u, v, s, kind, near = false) {
    const Mx = globe.matrix(town, u, v, -0.012, rand() * TAU, M * s);
    const pal = kind === 1 ? PINES : kind === 2 ? CYPRESS : LEAVES;
    const col = pal[Math.floor(rand() * pal.length)].clone().multiplyScalar(0.9 + rand() * 0.2);
    const close = near || Math.hypot(u - 0.4, v) < 4.2; // only trees near the town cast real shadows
    add(near ? G.trees[kind].near : G.trees[kind].far, close ? treeMat : treeFar, Mx, col);
    if (near) blobs.push(globe.matrix(town, u, v, 0.012, 0, M * s * (kind === 2 ? 3 : 5.5)));
  }
  const bush = (Mx, r, col) => add(G.ball, mat.leaf, Mx.clone().multiply(partMatrix(0, r * 0.7, 0, r, r * 0.85, r)), col);

  // ---------- the town ----------
  await rest();
  const lawns = [], drives = [], branchA = [], branchB = [];
  HOUSES.forEach(([hu, hv, turn, mirrored, gable], index) => {
    const Hm = globe.matrix(town, hu, hv, 0, turn, M);
    const sx = mirrored ? -1 : 1, c = Math.cos(turn), s = Math.sin(turn);
    const toUV = (x, z) => [hu + M * (sx * x * c + z * s), hv + M * (-sx * x * s + z * c)];
    const L = (x, y, z) => new V3(sx * x, y, z).applyMatrix4(Hm);
    const P = (g, m, x, y, z, w, h, d, ry = 0, rx = 0, rz = 0, col = null) =>
      add(g, m, Hm.clone().multiply(partMatrix(sx * x, y, z, w, h, d, sx * ry, rx, sx * rz)), col);
    const win = (x, y, z, w, h, d, spill = 0) => {
      P(G.box, mat.glass, x, y, z, w, h, d);
      const wi = { ref: P(G.box, mat.winGlow, x, y, z, w + 0.02, h + 0.02, d + 0.03), th: 0.25 + rand() * 0.45, b: rand() < 0.12 ? 0.1 : 0.65 + rand() * 0.35, pool: null };
      if (spill) {
        const pz = z + spill * 1.7;
        wi.pool = { m: Hm.clone().multiply(partMatrix(sx * x, 0.24 - drop(x, pz), pz, w * 1.5, 1, 2.8)) };
        pools.push(wi.pool);
      }
      windows.push(wi);
    };
    // left wing: two floors, flat roof with 12 solar panels
    P(G.box, mat.white, -4.8, 2.9, 0, 7.6, 6.8, 8);
    P(G.box, mat.roof, -4.8, 6.36, 0, 7.4, 0.1, 7.8);
    P(G.box, mat.dark, -4.8, 6.5, 4.06, 7.92, 0.42, 0.26); P(G.box, mat.dark, -4.8, 6.5, -4.06, 7.92, 0.42, 0.26);
    P(G.box, mat.dark, -8.73, 6.5, 0, 0.26, 0.42, 8.38); P(G.box, mat.dark, -0.87, 6.5, 0, 0.26, 0.42, 8.38);
    for (let r = 0; r < 2; r++) {
      P(G.box, mat.dark, -4.8, 6.55, 0.95 - r * 1.95, 6.6, 0.12, 0.9);
      for (let k = 0; k < 6; k++) P(G.box, mat.panel, -4.8 + (k - 2.5) * 1.08, 6.86, 0.95 - r * 1.95, 1.02, 0.05, 1.7, 0, 0.21);
    }
    win(-6.2, 1.45, 4.03, 3.8, 2.4, 0.06, 1);
    P(G.box, mat.wood, -3.5, 1.65, 4.05, 1.2, 3.3, 0.1);
    win(-6.65, 4.65, 4.03, 2.9, 1.9, 0.06);
    P(G.box, mat.wood, -4.1, 4.7, 4.05, 1.7, 2.75, 0.1);
    win(-2.2, 4.65, 4.03, 1.7, 1.9, 0.06);
    win(-8.63, 3.6, 0.6, 0.06, 2.2, 2.4);
    win(-5.0, 1.5, -4.03, 4.0, 2.4, 0.06, -1);
    win(-5.0, 4.65, -4.03, 3.0, 1.9, 0.06);
    // home battery on the wall with its level lights
    P(G.box, mat.dark, -1.95, 1.2, 4.14, 0.8, 1.4, 0.26);
    for (let k = 0; k < 4; k++) leds.push({ ref: P(G.box, mat.led, -1.95, 0.72 + k * 0.27, 4.28, 0.12, 0.18, 0.02), k });
    // right wing: two floors, gable with a glass front (or a flat roof with more panels)
    const RW = gable ? 5.8 : 6.3;
    P(G.box, mat.white, 2.1, (RW - 0.5) / 2, 0.5, 6.2, RW + 0.5, 8.2);
    if (gable) {
      P(G.prism, mat.white, 2.1, RW, 0.5, 6.2, 2.6, 8.2);
      const slope = Math.atan2(2.6, 3.1), len = Math.hypot(3.1, 2.6) + 0.5, sn = Math.sin(slope), cs = Math.cos(slope);
      for (const sd of [-1, 1]) P(G.box, mat.dark, 2.1 + sd * (1.55 + 0.13 * sn + 0.25 * cs), RW + 1.3 + 0.13 * cs - 0.25 * sn, 0.5, len, 0.26, 8.9, 0, 0, -sd * slope);
      P(G.tri, mat.glass, 2.1, RW + 0.12, 4.63, 5.0, 2.05, 1);
      windows.push({ ref: P(G.tri, mat.winGlow, 2.1, RW + 0.12, 4.645, 5.0, 2.05, 1), th: 0.3 + rand() * 0.3, b: 0.85, pool: null });
      win(2.1, 4.35, 4.63, 5.0, 2.3, 0.06);
    } else {
      P(G.box, mat.roof, 2.1, RW + 0.05, 0.5, 6.0, 0.1, 8.0);
      P(G.box, mat.dark, 2.1, RW + 0.2, 4.62, 6.4, 0.42, 0.26); P(G.box, mat.dark, 2.1, RW + 0.2, -3.62, 6.4, 0.42, 0.26);
      P(G.box, mat.dark, -0.93, RW + 0.2, 0.5, 0.26, 0.42, 8.5); P(G.box, mat.dark, 5.13, RW + 0.2, 0.5, 0.26, 0.42, 8.5);
      P(G.box, mat.dark, 2.1, RW + 0.24, 0.9, 5.4, 0.12, 0.9);
      for (let k = 0; k < 5; k++) P(G.box, mat.panel, 2.1 + (k - 2) * 1.08, RW + 0.55, 0.9, 1.02, 0.05, 1.7, 0, 0.21);
      win(2.1, 4.45, 4.63, 5.0, 2.0, 0.06);
    }
    P(G.box, mat.wood, 0.0, 1.2, 4.66, 1.15, 2.4, 0.08);
    win(3.0, 1.5, 4.63, 3.4, 2.3, 0.06, 1);
    win(5.23, 4.4, 0.8, 0.06, 1.6, 2.6);
    P(G.box, mat.dark, 0.3, 2.78, 5.2, 2.2, 0.14, 1.2);
    // garage with a dark door and the wall charger (teal bolt)
    P(G.box, mat.white, 7.5, 1.4, 0.75, 4.6, 3.8, 6.7);
    P(G.box, mat.dark, 7.5, 3.42, 0.75, 4.9, 0.3, 7.0);
    P(G.box, mat.garage, 7.55, 1.3, 4.12, 3.5, 2.6, 0.06);
    P(G.box, mat.dark, 5.55, 1.25, 4.18, 0.42, 0.58, 0.16);
    P(G.plane, mat.bolt, 5.55, 1.27, 4.27, 0.26, 0.34, 1);
    glow(L(5.55, 1.27, 4.35), TEALC, 0.05, 1);
    for (const [x, y, z] of [[-0.75, 2.05, 4.68], [9.95, 2.6, 4.13]]) { P(G.box, mat.lamp, x, y, z, 0.16, 0.3, 0.06); glow(L(x, y, z + 0.1), WARM, 0.06, 0); }
    // electric car on the drive, nose to the garage: silver roof over dark glass
    {
      const cz = 7.7, cx = 7.55, C = Hm.clone().multiply(partMatrix(sx * cx, -drop(cx, cz), cz, 1, 1, 1, Math.PI));
      const A = (g, m, x, y, z, w = 1, h = 1, d = 1, col = null) => add(g, m, C.clone().multiply(partMatrix(x, y, z, w, h, d)), col);
      const shade = [0.72, 0.86, 0.95, 0.6][index % 4], body = new THREE.Color(shade, shade * 1.01, shade * 1.03);
      A(G.carBody, mat.car, 0, 0.72, 0, 1, 1, 1, body);
      A(G.carTop, mat.carGlass, 0, 1.3, -0.25);
      A(G.carRoof, mat.car, 0, 1.62, -0.3, 1, 1, 1, body);
      for (const wx of [-0.84, 0.84]) for (const wz of [-1.45, 1.45]) A(G.wheel, mat.tyre, wx, 0.37, wz);
      for (const wx of [-0.62, 0.62]) A(G.box, mat.head, wx, 0.86, 2.29, 0.38, 0.07, 0.04);
      A(G.box, mat.tail, 0, 0.92, -2.3, 1.5, 0.07, 0.04);
      blobs.push(Hm.clone().multiply(partMatrix(sx * cx, 0.18 - drop(cx, cz), cz, 2.6, 1, 5.4)));
    }
    // cables: roof panels -> battery (day), battery -> charger -> car (always), street -> battery (always)
    const wire = (pts, mode, r = 0.012) => routes.push({ pts: pts.map(([x, y, z]) => L(x, y < 0.5 ? y - drop(x, z) : y, z)), mode, r });
    wire([[-1.25, 6.6, 4.13], [-1.25, 6.2, 4.13], [-1.25, 2.2, 4.13], [-1.6, 1.95, 4.15]], 0);
    wire([[-1.55, 0.75, 4.18], [-1.1, 0.18, 4.25], [-0.85, 0.12, 4.85], [5.3, 0.12, 4.85], [5.48, 0.14, 4.35], [5.55, 0.94, 4.27],
      [5.62, 0.26, 4.8], [6.0, 0.12, 5.5], [6.5, 0.45, 5.95], [6.62, 0.86, 6.05]], 2);
    const edge = hv > 0 ? 1.38 - 0.16 : -0.16, zEdge = (edge - hv) / M / c;
    wire([[-1.95, 0.1, zEdge - 0.2], [-1.95, 0.12, 4.6], [-1.95, 0.5, 4.2]], 2, 0.011);
    (hv > 0 ? branchB : branchA).push(toUV(-1.95, zEdge)[0]);
    // garden: lawn with mowing stripes, drive, stepping stones, bushes, trees, hedge
    lawns.push(patchGeometry(globe, town, ...toUV(0, 1.5), 26 * M, 21 * M, { turn, lift: 0.005, nx: 6, ny: 6, uv: [1, 5] }));
    drives.push(patchGeometry(globe, town, ...toUV(7.55, 8.05), 4.0 * M, 8.0 * M, { turn, lift: 0.006, nx: 2, ny: 4 }));
    for (let z = 5.7; z < zEdge - 0.4; z += 1.2) P(G.box, mat.stone, 0.0, 0.04 - drop(0, z), z, 1.15, 0.1, 0.55);
    for (const [x, z, r] of [[-7.9, 5.0, 0.72], [-6.7, 5.0, 0.62], [-5.5, 5.0, 0.7], [-4.3, 5.0, 0.6], [-0.95, 5.05, 0.5], [10.45, 3.2, 0.8], [10.6, 1.4, 0.65], [-10.2, -6.6, 0.95]]) {
      bush(Hm.clone().multiply(partMatrix(sx * x, -drop(x, z), z, 1, 1, 1)), r, LEAVES[(index + Math.round(x)) & 3].clone().multiplyScalar(1.05));
    }
    P(G.box, mat.leaf, 0, 0.45 - drop(0, -9.2), -9.2, 25.5, 0.9, 0.8, 0, 0, 0, LEAVES[4]);
    tree(...toUV(-10.6, -6.4), 1.05, 0, true);
    tree(...toUV(11.0, -6.9), 0.95, index % 3 ? 0 : 1, true);
    if (index % 2) tree(...toUV(-11.3, 9.4), 0.75, 2, true);
    blobs.push(Hm.clone().multiply(partMatrix(sx * 1.0, 0.15, 0.4, 22, 1, 12)));
  });
  ground(lawns, mat.lawn);
  ground(drives, mat.paving);

  // street lamps along the streets
  const lamp = (u, v, side) => {
    const Mx = globe.matrix(town, u, v, 0, side > 0 ? 0 : Math.PI, M);
    const part = (g, m, x, y, z, a, b, cc) => add(g, m, Mx.clone().multiply(partMatrix(x, y, z, a, b, cc)));
    part(G.cyl, mat.dark, 0, 2.8, 0, 0.16, 5.6, 0.16);
    part(G.box, mat.dark, 0, 5.55, 0.45, 0.12, 0.1, 1.0);
    part(G.box, mat.dark, 0, 5.5, 0.95, 0.34, 0.14, 0.62);
    part(G.box, mat.lamp, 0, 5.42, 0.95, 0.26, 0.04, 0.5);
    glow(new V3(0, 5.3, 0.95).applyMatrix4(Mx), WARM, 0.2, 0);
    pools.push({ m: Mx.clone().multiply(partMatrix(0, 0.25, 0.95, 5.6, 1, 5.6)), lamp: true });
  };
  [-2.6, -1.3, 0, 1.3, 2.6].forEach((u, k) => lamp(u, k % 2 ? 0.2 : -0.2, k % 2 ? -1 : 1));
  [-1.9, 0.6, 3.0].forEach((u) => lamp(u, 1.58, -1));

  // town substation (kiosk) and the cables along the streets to every house
  {
    const Mx = globe.matrix(town, KIOSK[0], KIOSK[1], 0, -0.5, M);
    add(G.box, mat.kiosk, Mx.clone().multiply(partMatrix(0, 1.1, 0, 2.4, 2.2, 1.6)));
    add(G.box, mat.dark, Mx.clone().multiply(partMatrix(0, 2.3, 0, 2.7, 0.22, 1.9)));
    add(G.box, mat.dark, Mx.clone().multiply(partMatrix(0, 1.0, 0.81, 1.6, 1.6, 0.04)));
    glow(new V3(0.9, 1.9, 0.85).applyMatrix4(Mx), TEALC, 0.05, 1);
    const groundWire = (uv, mode, r = 0.013) => routes.push({ pts: uv.map(([u, v]) => globe.point(town, u, v, 0.012)), mode, r });
    groundWire([KIOSK, [3.75, -0.17], [3.4, -0.17], [Math.min(...branchA) - 0.05, -0.17]], 2);
    groundWire([KIOSK, [3.84, -0.1], [3.84, 0.6], [3.55, 1.22], [3.0, 1.22], [Math.min(...branchB) - 0.05, 1.22]], 2);
  }

  // ---------- solar park, battery containers, substation, pylons ----------
  await rest();
  {
    const rows = 7, cols = 15, tilt = 0.5;
    ground([patchGeometry(globe, park, 0.2, -0.05, 2.25, 2.0, { lift: 0.004, nx: 12, ny: 12 })], mat.gravel);
    for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
      const Mx = globe.matrix(park, -0.72 + k * 0.14, -0.85 + r * 0.27, 0, 0, 1);
      const part = (g, m, x, y, z, a, b, cc, rx = 0) => add(g, m, Mx.clone().multiply(partMatrix(x, y, z, a, b, cc, 0, rx)));
      for (const sgn of [-1, 1]) part(G.box, mat.panel, 0, 0.055 - sgn * 0.052 * Math.sin(tilt), sgn * 0.052 * Math.cos(tilt), 0.128, 0.006, 0.1, tilt);
      part(G.box, mat.metal, 0, 0.022, 0.07, 0.008, 0.044, 0.008);
      part(G.box, mat.metal, 0, 0.05, -0.07, 0.008, 0.1, 0.008);
    }
    // battery containers on a concrete pad
    const yard = globe.sub(park, PARK_YARD[0], PARK_YARD[1], Math.PI / 2);
    ground([patchGeometry(globe, yard, 0, 0, 1.6, 0.75, { lift: 0.005, nx: 4, ny: 4 })], mat.concrete);
    for (let r = 0; r < 2; r++) for (let k = 0; k < 3; k++) {
      const Mx = globe.matrix(yard, -0.48 + k * 0.48, -0.15 + r * 0.32, 0, 0, 1);
      add(G.box, mat.container, Mx.clone().multiply(partMatrix(0, 0.075, 0, 0.42, 0.15, 0.13)));
      add(G.box, mat.dark, Mx.clone().multiply(partMatrix(0, 0.155, 0, 0.43, 0.012, 0.14)));
      glow(new V3(0.15, 0.06, 0.07).applyMatrix4(Mx), TEALC, 0.03, 1);
      blobs.push(Mx.clone().multiply(partMatrix(0, 0.006, 0, 0.6, 1, 0.3)));
    }
    // substation: transformer, and a gantry where the line to the town starts
    const sub = globe.sub(park, PARK_SUB[0], PARK_SUB[1], 0);
    ground([patchGeometry(globe, sub, 0, 0, 0.7, 0.55, { lift: 0.005, nx: 2, ny: 2 })], mat.concrete);
    const Sm = globe.matrix(sub, 0, 0, 0, 0, M);
    add(G.box, mat.kiosk, Sm.clone().multiply(partMatrix(0, 1.4, -2.6, 2.8, 2.8, 2.2)));
    for (let k = -2; k <= 2; k++) add(G.box, mat.dark, Sm.clone().multiply(partMatrix(k * 0.5, 1.3, -1.42, 0.08, 2.2, 0.3)));
    const rowEnd = (k) => globe.point(park, -0.72 + k * 0.14, 1.0, 0.012);
    routes.push({ pts: [rowEnd(14), rowEnd(7), rowEnd(0), globe.point(park, -1.05, 1.02, 0.012), globe.point(sub, 0, -0.09, 0.03)], mode: 0, r: 0.016 });
    const toYard = [globe.point(sub, -0.06, -0.06, 0.03), globe.point(park, -1.55, 0.75, 0.012), globe.point(yard, 0.7, 0.02, 0.012), globe.point(yard, -0.55, 0.02, 0.012)];
    routes.push({ pts: toYard, mode: 0, r: 0.015 });
    routes.push({ pts: [...toYard].reverse(), mode: 1, r: 0.015 });

    // pylons from the substation to the town, with three conductors that sag between them
    const end = [KIOSK[0] + 0.55, KIOSK[1] - 0.35], N = 4, head = Math.atan2(end[0] - SUB[0], end[1] - SUB[1]);
    const Gm = globe.matrix(town, SUB[0], SUB[1], 0, head, M);
    for (const x of [-5, 0, 5]) add(G.cyl, mat.dark, Gm.clone().multiply(partMatrix(x, 3.8, 0, 0.35, 7.6, 0.35)));
    add(G.box, mat.dark, Gm.clone().multiply(partMatrix(0, 7.6, 0, 11, 0.3, 0.3)));
    const pylon = (u, v, small) => {
      const Mx = globe.matrix(town, u, v, 0, head, M * (small ? 0.75 : 1));
      const beam = (a, b, t) => add(G.box, mat.metal, Mx.clone().multiply(beamMatrix(a, b, t)));
      const W = (w, y) => [new V3(-w, y, -w), new V3(w, y, -w), new V3(w, y, w), new V3(-w, y, w)];
      const lv = [0, 4.4, 8.4, 12.0, 15.2].map((y) => W(mix(2.7, 0.8, y / 15.2), y));
      for (let k = 0; k < 4; k++) { beam(lv[0][k], lv[4][k], 0.42); beam(lv[4][k], new V3(0, 18.8, 0), 0.26); }
      for (let l = 1; l < 5; l++) for (let k = 0; k < 4; k++) beam(lv[l][k], lv[l][(k + 1) % 4], 0.2);
      for (let l = 0; l < 4; l++) for (let k = 0; k < 4; k++) { beam(lv[l][k], lv[l + 1][(k + 1) % 4], 0.16); beam(lv[l][(k + 1) % 4], lv[l + 1][k], 0.16); }
      for (const z of [-0.6, 0.6]) beam(new V3(-5.4, 15.2, z), new V3(5.4, 15.2, z), 0.24);
      for (const x of [-5.2, 5.2]) beam(new V3(x, 15.2, 0), new V3(Math.sign(x) * 0.8, 12.6, 0), 0.2);
      for (const [x, y] of [[-5.0, 14.2], [5.0, 14.2], [0, 18.7]]) add(G.cyl, mat.insulator, Mx.clone().multiply(partMatrix(x, y, 0, 0.28, 1.2, 0.28)));
      glow(new V3(0, 19.4, 0).applyMatrix4(Mx), RED, 0.12, 2);
      return [new V3(-5.0, 13.6, 0), new V3(5.0, 13.6, 0), new V3(0, 19.25, 0)].map((p) => p.applyMatrix4(Mx));
    };
    const tips = [[-4, 7.75], [4, 7.75], [0, 7.75]].map(([x, y]) => [new V3(x, y, 0).applyMatrix4(Gm)]);
    for (let k = 1; k <= N; k++) {
      const f = k / N, t = pylon(mix(SUB[0], end[0], f), mix(SUB[1], end[1], f), k === N);
      t.forEach((p, w) => tips[w].push(p));
    }
    for (let w = 0; w < 3; w++) {
      const pts = [tips[w][0]];
      for (let k = 1; k < tips[w].length; k++) {
        const a = tips[w][k - 1], b = tips[w][k];
        for (let i = 1; i <= 10; i++) {
          const t = i / 10, p = a.clone().lerp(b, t);
          if (i < 10) p.addScaledVector(p.clone().normalize(), -0.07 * 4 * t * (1 - t));
          pts.push(p);
        }
      }
      const kp = globe.point(town, KIOSK[0] + 0.04 * (w - 1), KIOSK[1], 2.3 * M);
      pts.push(kp.clone().lerp(pts[pts.length - 1], 0.5).addScaledVector(kp.clone().normalize(), -0.03), kp);
      routes.push({ pts, mode: 2, r: 0.007, glow: 0.014 });
    }
  }

  // forests and single trees wherever there is free land in view (more where the noise says "forest" and at the
  // foot of the mountains, where they are mostly pines), plus cypresses along the road, bushes and rocks
  await rest();
  {
    const inField = (u, v) => FIELDS.some(([fu, fv, w, h]) => Math.abs(u - fu) < w * 0.62 && Math.abs(v - fv) < h * 0.62);
    const free = (u, v) => {
      if (LAKES.some(([lu, lv, w, h]) => Math.hypot((u - lu) / (w * 0.62), (v - lv) / (h * 0.62)) < 1.05)) return false;
      if (u > -3.4 && u < 4.4 && v > -1.35 && v < 1.75) return false; // the town
      if (Math.hypot(u - PARK[0], v - PARK[1]) < 2.05) return false;
      if (MOUNTAINS.some(([mu, mv, r]) => Math.hypot(u - mu, v - mv) < r * 0.8)) return false;
      if (inField(u, v)) return false;
      return lanes.every(([a, b, w, u0, u1, v0, v1]) => u < u0 || u > u1 || v < v0 || v > v1 || segDist(u, v, a, b) > w * 0.7);
    };
    const nearMountain = (u, v) => MOUNTAINS.reduce((m, [mu, mv, r]) => Math.max(m, smooth(r * 1.7, r * 0.85, Math.hypot(u - mu, v - mv))), 0);
    const seen = Math.cos(1.25);
    let placed = 0;
    for (let k = 0; k < 26000 && placed < 1500; k++) {
      const u = (rand() * 2 - 1) * 11, v = (rand() * 2 - 1) * 10.5;
      const d = globe.dir(town, u, v);
      if (d.dot(viewAxis) < seen || !free(u, v)) continue;
      const nm = nearMountain(u, v), fo = forest(d);
      if (rand() > 0.05 + fo * 0.95 + nm * 0.7) continue;
      const kind = nm > 0.25 || globe.height(d) > 0.45 ? (rand() < 0.85 ? 1 : 0) : rand() < 0.2 ? 1 : rand() < 0.08 ? 2 : 0;
      tree(u, v, 0.85 + rand() * 0.8 + nm * 0.3, kind);
      placed++;
    }
    for (let k = 0; k < 10; k++) { // cypresses along the road to the park
      const t = (k + 0.5) / 10, i = Math.min(ROAD.length - 2, Math.floor(t * (ROAD.length - 1))), f = t * (ROAD.length - 1) - i;
      const u = mix(ROAD[i][0], ROAD[i + 1][0], f), v = mix(ROAD[i][1], ROAD[i + 1][1], f), side = k % 2 ? 0.22 : -0.22;
      const du = ROAD[i + 1][0] - ROAD[i][0], dv = ROAD[i + 1][1] - ROAD[i][1], l = Math.hypot(du, dv) || 1;
      tree(u + (dv / l) * side, v - (du / l) * side, 0.9, 2);
    }
    for (let k = 0; k < 260; k++) {
      const u = (rand() * 2 - 1) * 9.5, v = (rand() * 2 - 1) * 9.5;
      if (globe.dir(town, u, v).dot(viewAxis) > seen && free(u, v)) tree(u, v, 0.6 + rand() * 0.9, 3);
    }
    for (let k = 0; k < 50; k++) {
      const u = (rand() * 2 - 1) * 9, v = (rand() * 2 - 1) * 9, s = 0.03 + rand() * 0.07;
      if (free(u, v)) add(G.rock, mat.rock, globe.matrix(town, u, v, -s * 0.3, rand() * TAU, 1).multiply(partMatrix(0, 0, 0, s * 1.3, s * 0.8, s)));
    }
  }
  await rest();
  kit.build(scene);
  const setColor = (ref, cc) => { ref.g.mesh.setColorAt(ref.i, cc); ref.g.mesh.instanceColor.needsUpdate = true; };

  // soft shadows under houses, cars, trees
  {
    const m = new THREE.InstancedMesh(G.decal, keep(new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: T.spot, transparent: true, opacity: 0.34, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })), blobs.length);
    blobs.forEach((x, i) => m.setMatrixAt(i, x));
    m.renderOrder = 1;
    scene.add(m);
  }
  // light pools on the ground (street lamps, windows): added light, only at night
  const poolMesh = new THREE.InstancedMesh(G.decal, keep(new THREE.MeshBasicMaterial({ map: T.spot, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3 })), pools.length);
  pools.forEach((p, i) => { poolMesh.setMatrixAt(i, p.m); poolMesh.setColorAt(i, new THREE.Color(0, 0, 0)); p.i = i; });
  poolMesh.renderOrder = 2;
  scene.add(poolMesh);

  // ---------- cables, and the energy that flows inside them ----------
  await rest();
  const flowU = { uTime: { value: 0 }, uNight: { value: 0 }, uDay: { value: color("#ffc23d") }, uNightCol: { value: color("#2ff3dc") } };
  {
    const cables = [], flows = [];
    for (const rt of routes) {
      const cg = tubeGeometry(rt.pts, rt.r, 5);
      cg.deleteAttribute("along");
      cables.push(cg);
      const fg = tubeGeometry(rt.pts, rt.glow || rt.r * 1.8, 6);
      fg.deleteAttribute("uv");
      flows.push(tag(tag(fg, "mode", rt.mode), "seed", rand()));
    }
    scene.add(new THREE.Mesh(keep(mergeGeometries(cables)), mat.cable));
    const fm = new THREE.Mesh(keep(mergeGeometries(flows)), keep(new THREE.ShaderMaterial({
      uniforms: flowU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float along, mode, seed; uniform float uNight; varying float vAlong, vVis, vSeed; varying vec3 vN, vV;
        void main() {
          vAlong = along; vSeed = seed;
          vVis = mode < 0.5 ? 1.0 - smoothstep(0.25, 0.6, uNight) : (mode < 1.5 ? smoothstep(0.4, 0.75, uNight) : 1.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uTime, uNight; uniform vec3 uDay, uNightCol; varying float vAlong, vVis, vSeed; varying vec3 vN, vV;
        void main() {
          float x = fract(vAlong / 0.55 - uTime * 0.9 + vSeed);
          float pulse = smoothstep(0.55, 0.95, x) * (1.0 - smoothstep(0.95, 1.0, x));
          float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
          float a = (0.06 + 0.2 * uNight + pulse * 2.2) * edge * vVis;
          gl_FragColor = vec4(mix(uDay, uNightCol, uNight) * a, 1.0);
          #include <colorspace_fragment>
        }`,
    })));
    fm.renderOrder = 3;
    scene.add(fm);
  }

  // ---------- glowing points: lamps, chargers, battery lights, pylon lights ----------
  const glowU = { uNight: { value: 0 }, uTime: { value: 0 }, uScale: { value: 500 } };
  {
    const n = glowPts.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), kind = new Float32Array(n);
    glowPts.forEach(([x, y, z, r, g, b, sz, k], i) => { pos.set([x, y, z], i * 3); col.set([r, g, b], i * 3); size[i] = sz; kind[i] = k; });
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    g.setAttribute("kind", new THREE.BufferAttribute(kind, 1));
    const pts = new THREE.Points(g, keep(new THREE.ShaderMaterial({
      uniforms: glowU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute vec3 color; attribute float size, kind; uniform float uNight, uTime, uScale; varying vec3 vC; varying float vA;
        void main() {
          vA = kind < 0.5 ? uNight : (kind < 1.5 ? mix(0.45, 1.0, uNight) : uNight * step(0.55, fract(uTime * 0.6 + position.x * 0.37)));
          vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          mv.xyz += normalize(-mv.xyz) * 0.15;
          gl_PointSize = clamp(size * uScale / -mv.z, 0.0, 256.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float g = exp(-d * d * 4.0) * (1.0 - smoothstep(0.7, 1.0, d)) + 0.6 * exp(-d * d * 40.0);
          gl_FragColor = vec4(vC * g * vA * 1.4, 1.0);
          #include <colorspace_fragment>
        }`,
    })));
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    scene.add(pts);
  }

  // ---------- clouds drifting slowly along the planet's edge; they step aside when they would hide the view ----------
  const clouds = new THREE.Group();
  const cloudMat = std({ color: "#ffffff", roughness: 1, emissive: "#ffffff", emissiveIntensity: 0.25 });
  const cloudList = [], puffs = [];
  {
    const side = new V3().crossVectors(viewAxis, town.n).normalize();
    for (let k = 0; k < 10; k++) {
      const d = viewAxis.clone().applyAxisAngle(side, 0.86 + rand() * 0.24).applyAxisAngle(viewAxis, -0.9 + k * 0.46 + rand() * 0.15);
      const F = globe.frame(d, viewAxis), centre = d.clone().multiplyScalar(R + 1.5 + rand() * 1.4);
      const base = new THREE.Matrix4().compose(centre, F.q, new V3(1, 1, 1));
      const n = 5 + Math.floor(rand() * 4), w = 0.7 + rand() * 0.6, first = puffs.length;
      for (let j = 0; j < n; j++) {
        const x = (j / (n - 1) - 0.5) * 2 * w, r = (0.22 + rand() * 0.2) * (1.25 - Math.abs(x) / (w * 1.6));
        puffs.push(base.clone().multiply(partMatrix(x, r * 0.35 + rand() * 0.08, (rand() - 0.5) * 0.3, r * 1.3, r, r * 1.1)));
      }
      cloudList.push({ centre, first, n, fade: 1 });
    }
  }
  const cloudMesh = new THREE.InstancedMesh(G.puff, cloudMat, puffs.length);
  puffs.forEach((m, i) => cloudMesh.setMatrixAt(i, m));
  clouds.add(cloudMesh);
  scene.add(clouds);
  const parkPoint = globe.point(park, 0, 0), townPoint = globe.point(town, 0.4, 0);
  const segPoint = (p, a, b) => { const ab = b.clone().sub(a), t = clamp(p.clone().sub(a).dot(ab) / ab.lengthSq()); return p.distanceTo(a.clone().addScaledVector(ab, t)); };
  const cm1 = new THREE.Matrix4(), cm2 = new THREE.Matrix4(), cm3 = new THREE.Matrix4(), cw = new V3();
  function moveClouds(cam, look, dt) {
    clouds.updateMatrixWorld();
    let moved = false;
    for (const cl of cloudList) {
      cw.copy(cl.centre).applyMatrix4(clouds.matrixWorld);
      const near = Math.min(segPoint(cw, cam.position, look), segPoint(cw, cam.position, parkPoint), segPoint(cw, cam.position, townPoint), cw.distanceTo(cam.position) - 1);
      const goal = smooth(1.1, 2.3, near);
      if (Math.abs(goal - cl.fade) < 0.004) continue;
      cl.fade = dt ? cl.fade + (goal - cl.fade) * Math.min(1, dt * 3) : goal;
      const f = Math.max(cl.fade, 0.001);
      cm1.makeTranslation(cl.centre.x, cl.centre.y, cl.centre.z).multiply(cm2.makeScale(f, f, f)).multiply(cm3.makeTranslation(-cl.centre.x, -cl.centre.y, -cl.centre.z));
      for (let j = 0; j < cl.n; j++) cloudMesh.setMatrixAt(cl.first + j, cm2.multiplyMatrices(cm1, puffs[cl.first + j]));
      moved = true;
    }
    if (moved) cloudMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------- day <-> night ----------
  const C = { // [day, night, sunset (mixed in during the change)]
    top: [color("#78b6ec"), color("#050816"), color("#56649f")], mid: [color("#b7daf5"), color("#0c1331"), color("#c487a3")],
    low: [color("#fbe3bf"), color("#221d4a"), color("#ff9d6b")], limb: [color("#fff1dc"), color("#2c3a8a"), color("#ffb37e")],
    hemiSky: [color("#cfe4ff"), color("#34428a"), color("#f3b38f")], hemiGround: [color("#6e8a4d"), color("#0b0e1c"), color("#6a5040")],
    key: [color("#ffe7c2"), color("#9fb3ff"), color("#ff9550")], fog: [color("#dce8f0"), color("#121838"), color("#e9a38c")],
    atmo: [color("#7fc2ff"), color("#4b5bd6"), color("#ffb48e")], rim: [color("#bfe3ff"), color("#4a5bd0"), color("#ffc29a")],
    cloud: [color("#ffffff"), color("#5d6aa3"), color("#ffd2b8")], water: [color("#3a8cc4"), color("#1d3f78"), color("#c98a8a")],
    waterGlow: [color("#000000"), color("#0f3a78"), color("#3a1f2a")],
  };
  const tmp = new THREE.Color(), led = new THREE.Color(), lampOff = color("#5a5a5a"), lampOn = color("#ffe2a6");
  const lerp3 = (out, set, night, dusk) => out.lerpColors(set[0], set[1], night).lerp(set[2], dusk);
  let lastNight = -1, level = 0.6, lastBars = -1;
  const v = new V3(), sunPos = new V3(), moonPos = new V3(), oc = new THREE.Vector2(), lc = new THREE.Vector2(), e = new V3(), up = new V3();
  const project = (p, cam, out) => { v.copy(p).project(cam); out.set((v.x * 0.5 + 0.5) * skyU.uRes.value.x, (v.y * 0.5 + 0.5) * skyU.uRes.value.y); };
  // A far point of the sky at the screen position (x, y as fractions from the top-left) of camera cam.
  const skyPoint = (cam, x, y, out) => out.set(x * 2 - 1, 1 - y * 2, 0.5).unproject(cam).sub(cam.position).normalize().multiplyScalar(380).add(cam.position);

  function update(time, dt, night, cam, base, buffer, look) {
    const dusk = Math.pow(Math.sin(Math.PI * night), 2) * 0.85;
    skyU.uRes.value.copy(buffer);
    lerp3(skyU.uTop.value, C.top, night, dusk * 0.6);
    lerp3(skyU.uMid.value, C.mid, night, dusk);
    lerp3(skyU.uLow.value, C.low, night, dusk);
    lerp3(skyU.uLimb.value, C.limb, night, dusk).multiplyScalar(mix(0.08, 0.3, night));
    lerp3(hemi.color, C.hemiSky, night, dusk * 0.5);
    lerp3(hemi.groundColor, C.hemiGround, night, dusk * 0.5);
    hemi.intensity = mix(0.8, 0.32, night);
    lerp3(key.color, C.key, night, dusk);
    key.intensity = mix(3.1, 0.5, night) * (1 - 0.55 * dusk);
    v.copy(SUN_DIR).lerp(MOON_DIR, smooth(0.35, 0.65, night)).addScaledVector(town.n, -0.4 * dusk).normalize();
    key.position.copy(focusPoint).addScaledVector(v, 30);
    scene.environmentIntensity = mix(0.55, 0.12, night);
    lerp3(scene.fog.color, C.fog, night, dusk * 0.7);
    lerp3(atmoU.uColor.value, C.atmo, night, dusk);
    atmoU.uAmt.value = mix(0.32, 0.7, night);
    lerp3(rimU.value, C.rim, night, dusk).multiplyScalar(mix(0.3, 0.28, night));
    lerp3(cloudMat.color, C.cloud, night, dusk * 0.8);
    cloudMat.emissive.copy(cloudMat.color);
    cloudMat.emissiveIntensity = mix(0.28, 0.32, night);
    lerp3(mat.water.color, C.water, night, dusk * 0.5);
    lerp3(mat.water.emissive, C.waterGlow, night, dusk * 0.5);
    T.ripples.offset.set(time * 0.012, time * 0.007);
    treeMat.color.setScalar(mix(1, 0.78, night)); // forests a little darker at night
    treeFar.color.copy(treeMat.color);
    mat.lamp.color.lerpColors(lampOff, lampOn, night);
    starU.uNight.value = smooth(0.35, 0.9, night);
    starU.uTime.value = time;
    starU.uPR.value = renderer.getPixelRatio();
    flowU.uTime.value = time;
    flowU.uNight.value = night;
    glowU.uNight.value = night;
    glowU.uTime.value = time;
    glowU.uScale.value = buffer.y / (2 * Math.tan((cam.fov * Math.PI) / 360));
    clouds.rotateOnWorldAxis(viewAxis, dt * 0.006);
    moveClouds(cam, look, dt);
    // the sun goes down behind the planet and the moon comes up (screen positions of the wide view)
    const s1 = smooth(0, 0.6, night), m1 = smooth(0.4, 1, night);
    skyPoint(base, mix(0.86, 0.99, s1), mix(0.3, 0.82, s1), sunPos);
    skyPoint(base, mix(0.64, 0.75, m1), mix(0.78, 0.22, m1), moonPos);
    sun.position.copy(sunPos);
    sunDisc.position.copy(sunPos);
    moon.position.copy(moonPos);
    const unit = 380 * 2 * Math.tan((base.fov * Math.PI) / 360);
    sun.scale.setScalar(unit * 0.3);
    sunDisc.scale.setScalar(unit * 0.05);
    moon.scale.setScalar(unit * 0.15);
    sun.material.opacity = (1 - smooth(0.45, 0.65, night)) * 0.85;
    sunDisc.material.opacity = 1 - smooth(0.45, 0.65, night);
    moon.material.opacity = smooth(0.4, 0.7, night);
    project(sunPos, cam, skyU.uSun.value);
    project(moonPos, cam, skyU.uMoon.value);
    skyU.uSunAmt.value = 1 - smooth(0.2, 0.7, night);
    skyU.uMoonAmt.value = smooth(0.5, 1, night);
    // the planet's outline on the screen, for the haze in the sky around it
    project(v.set(0, 0, 0), cam, oc);
    e.copy(cam.position);
    const dist2 = e.lengthSq(), k = (R * R) / dist2;
    up.set(0, 1, 0).applyQuaternion(cam.quaternion).addScaledVector(e, -up.dot(e) / dist2).normalize();
    project(v.copy(e).multiplyScalar(k).addScaledVector(up, R * Math.sqrt(1 - k)), cam, lc);
    skyU.uPlanet.value.set(oc.x, oc.y, oc.distanceTo(lc));
    // windows and garden lights come on one by one as it gets dark
    if (Math.abs(night - lastNight) > 0.002) {
      lastNight = night;
      for (const w of windows) {
        const b = smooth(w.th, w.th + 0.25, night) * w.b;
        setColor(w.ref, tmp.setRGB(b, b, b));
        if (w.pool) poolMesh.setColorAt(w.pool.i, tmp.copy(WARM).multiplyScalar(b * 0.55));
      }
      for (const p of pools) if (p.lamp) poolMesh.setColorAt(p.i, tmp.copy(WARM).multiplyScalar(smooth(0.3, 0.8, night) * 0.55));
      poolMesh.instanceColor.needsUpdate = true;
      poolMesh.visible = night > 0.05;
    }
    // home battery lights: they fill up by day and empty slowly at night
    level = clamp(level + dt * (night < 0.5 ? 0.05 : -0.025), 0.25, 1);
    const bars = Math.ceil(level * 4 - 0.01) + (night < 0.5 ? Math.floor(time * 2) % 2 : 0);
    if (bars !== lastBars) {
      lastBars = bars;
      for (const l of leds) setColor(l.ref, l.k < bars ? led.set("#2ff0c8") : led.set("#24413d"));
    }
  }

  // A named shot (see SHOTS) as numbers, so that the camera can move smoothly from one shot to another.
  function shot(name) {
    const s = SHOTS[name], P = globe.pose(frames[s.frame], s.at[0], s.at[1]);
    return { p: P.p, q: P.q, az: s.az, el: s.el, d: s.d, dMin: s.dMin, dMax: s.dMax };
  }
  // What each shot must show (points of a box over it): hero.js fits them into the free part of the screen.
  const box = (F, u0, u1, v0, v1, h) => {
    const out = [];
    for (const u of [u0, (u0 + u1) / 2, u1]) for (const v of [v0, (v0 + v1) / 2, v1]) for (const y of [0, h]) out.push(globe.point(F, u, v, y));
    return out;
  };
  const SUBJECTS = {
    town: box(town, 0.05, 3.35, -1.3, 1.45, 0.45), // the four houses on the right, close up
    park: [...box(park, -1.8, 1.4, -1.0, 1.45, 0.22), globe.point(town, ...SUB, 0.4)],
  };
  SUBJECTS.overview = [...box(town, -2.8, 3.4, -1.3, 1.5, 0.45), ...SUBJECTS.park];
  const subject = (name) => SUBJECTS[name];
  const ball = new THREE.Sphere(new V3(), R + 0.2);
  const hits = (ray) => ray.intersectsSphere(ball);

  function dispose() {
    scene.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    own.forEach((x) => x.dispose && x.dispose());
    own.clear();
  }

  return { scene, update, shot, subject, hits, dispose };
}
