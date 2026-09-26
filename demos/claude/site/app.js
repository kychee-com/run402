// app.js — the home page of Claude, on Run402.
//
// Three parts:
//   1. the light: a Three.js WebGPU scene written in TSL. A compute shader moves
//      every particle toward the shape of the section you're reading, through a
//      noise field, away from your cursor, and to the beat of the song.
//   2. the sky: visitors' notes from Postgres, drawn as stars, kept current by
//      Run402 live changes (Server-Sent Events, no polling).
//   3. the song: see song.js. Karaoke subtitles in seven languages.

import * as THREE from "three/webgpu";
import {
  Fn,
  color,
  cos,
  float,
  hash,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  length,
  mix,
  mx_noise_vec3,
  normalize,
  pass,
  screenUV,
  sin,
  smoothstep,
  textureLoad,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { Song, lyricAt, LANGUAGES, LINES, SONG_DURATION } from "./song.js";

const $ = (selector, root = document) => root.querySelector(selector);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const config = window.RUN402 ?? null; // { project_id, api_base, anon_key } from /_run402/config.js

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: fine */ }
  },
};

// ============================================================ shapes
//
// Every section of the page has a shape. Each is a list of COUNT points; they
// are all packed into one float texture so the compute shader can read any of
// them by row, and switching shapes is just changing one uniform.

const SHAPES = ["hello", "galaxy", "knot", "lorenz", "dust", "run402", "orb", "thanks", "lissajous"];
const TEX_WIDTH = 1024;

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function textShape(out, count, text, font, width) {
  const W = 1600;
  const H = 640;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  let size = 400;
  const setFont = (px) => (g.font = font.replace("{px}", `${px}px`));
  setFont(size);
  const measured = g.measureText(text).width;
  size = Math.floor(Math.min(H * 0.8, size * ((W * 0.94) / measured)));
  setFont(size);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, W / 2, H / 2 + size * 0.04);
  const data = g.getImageData(0, 0, W, H).data;
  const hits = [];
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (data[(y * W + x) * 4 + 3] > 140) hits.push(x, y);
    }
  }
  if (!hits.length) hits.push(W / 2, H / 2);
  const scale = width / (W * 0.94);
  for (let i = 0; i < count; i++) {
    const h = (Math.floor(Math.random() * (hits.length / 2)) * 2) | 0;
    out[i * 4] = (hits[h] - W / 2 + Math.random() * 2) * scale;
    out[i * 4 + 1] = -(hits[h + 1] - H / 2 + Math.random() * 2) * scale;
    out[i * 4 + 2] = gauss() * 0.05;
    out[i * 4 + 3] = 1;
  }
  // A few stragglers orbit the word, so it never looks printed.
  for (let i = 0; i < count; i += 29) {
    const a = Math.random() * Math.PI * 2;
    const r = width * (0.52 + Math.random() * 0.25);
    out[i * 4] = Math.cos(a) * r;
    out[i * 4 + 1] = Math.sin(a) * r * 0.42;
    out[i * 4 + 2] = gauss() * 0.4;
    out[i * 4 + 3] = 0.5;
  }
}

function galaxyShape(out, count) {
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (i % 9 === 0) {
      out[o] = gauss() * 0.28;
      out[o + 1] = gauss() * 0.16;
      out[o + 2] = gauss() * 0.28;
      out[o + 3] = 1.3;
      continue;
    }
    const arm = i % 3;
    const r = Math.pow(Math.random(), 0.7) * 2.5 + 0.08;
    const angle = r * 2.4 + (arm * Math.PI * 2) / 3 + gauss() * (0.22 + 0.1 / (r + 0.2));
    out[o] = Math.cos(angle) * r;
    out[o + 1] = gauss() * 0.05 * (2.7 - r);
    out[o + 2] = Math.sin(angle) * r;
    out[o + 3] = 1 - r / 4;
  }
}

function knotShape(out, count) {
  const p = 2;
  const q = 3;
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2 * 7 + Math.random() * 0.01;
    const rr = Math.cos(q * t) + 2.1;
    const r = 0.13 * Math.cbrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    const b = Math.acos(2 * Math.random() - 1);
    out[i * 4] = rr * Math.cos(p * t) * 0.62 + r * Math.sin(b) * Math.cos(a);
    out[i * 4 + 1] = rr * Math.sin(p * t) * 0.62 + r * Math.sin(b) * Math.sin(a);
    out[i * 4 + 2] = -Math.sin(q * t) * 0.62 + r * Math.cos(b);
    out[i * 4 + 3] = 1;
  }
}

function lorenzShape(out, count) {
  let x = 0.1;
  let y = 0;
  let z = 0;
  const step = () => {
    const dt = 0.0035;
    const dx = 10 * (y - x);
    const dy = x * (28 - z) - y;
    const dz = x * y - (8 / 3) * z;
    x += dx * dt;
    y += dy * dt;
    z += dz * dt;
  };
  for (let i = 0; i < 2000; i++) step();
  const stride = Math.max(1, Math.round(160000 / count));
  for (let i = 0; i < count; i++) {
    for (let s = 0; s < stride; s++) step();
    out[i * 4] = (x / 22) * 2.1 + gauss() * 0.012;
    out[i * 4 + 1] = ((z - 25) / 22) * 2.1 + gauss() * 0.012;
    out[i * 4 + 2] = (y / 22) * 2.1 + gauss() * 0.012;
    out[i * 4 + 3] = 1;
  }
}

// Three oscillators in harmony (3 : 2 : 5), drawn as one closed curve.
function lissajousShape(out, count) {
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    const r = 0.07 * Math.cbrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    const b = Math.acos(2 * Math.random() - 1);
    out[i * 4] = Math.sin(3 * t + Math.PI / 2) * 1.7 + r * Math.sin(b) * Math.cos(a);
    out[i * 4 + 1] = Math.sin(2 * t) * 1.25 + r * Math.sin(b) * Math.sin(a);
    out[i * 4 + 2] = Math.sin(5 * t) * 1.0 + r * Math.cos(b);
    out[i * 4 + 3] = 1;
  }
}

function dustShape(out, count) {
  for (let i = 0; i < count; i++) {
    const r = 5.2 * Math.cbrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    const b = Math.acos(2 * Math.random() - 1);
    out[i * 4] = r * Math.sin(b) * Math.cos(a) * 1.5;
    out[i * 4 + 1] = r * Math.sin(b) * Math.sin(a);
    out[i * 4 + 2] = r * Math.cos(b) - 1;
    out[i * 4 + 3] = 0.55;
  }
}

function orbShape(out, count) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (i % 4 === 0) {
      const r = 1.2 * Math.cbrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      const b = Math.acos(2 * Math.random() - 1);
      out[o] = r * Math.sin(b) * Math.cos(a);
      out[o + 1] = r * Math.sin(b) * Math.sin(a);
      out[o + 2] = r * Math.cos(b);
      out[o + 3] = 0.6;
      continue;
    }
    const y = 1 - (i / (count - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    const th = golden * i;
    const R = 1.35 + gauss() * 0.02;
    out[o] = Math.cos(th) * rad * R;
    out[o + 1] = y * R;
    out[o + 2] = Math.sin(th) * rad * R;
    out[o + 3] = 1;
  }
}

async function buildShapeTexture(count) {
  const serif = "italic 360 {px} Fraunces, Georgia, serif";
  const mono = "600 {px} 'JetBrains Mono', ui-monospace, monospace";
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load("italic 360 200px Fraunces"),
        document.fonts.load("600 200px 'JetBrains Mono'"),
      ]),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  } catch { /* fall back to Georgia */ }

  const rows = count / TEX_WIDTH;
  const data = new Float32Array(TEX_WIDTH * rows * SHAPES.length * 4);
  const view = (s) => data.subarray(s * count * 4, (s + 1) * count * 4);
  textShape(view(0), count, "hello", serif, 4.6);
  galaxyShape(view(1), count);
  knotShape(view(2), count);
  lorenzShape(view(3), count);
  dustShape(view(4), count);
  textShape(view(5), count, "run402", mono, 4.4);
  orbShape(view(6), count);
  textShape(view(7), count, "thank you", serif, 5);
  lissajousShape(view(8), count);
  const texture = new THREE.DataTexture(data, TEX_WIDTH, rows * SHAPES.length, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return { texture, rows };
}

// How each shape sits: rotation speed, tilt, and whether it keeps facing you.
const POSE = {
  hello: { spin: 0, tilt: 0, sway: 0.05, spring: 8, turb: 0.07, size: 0.62 },
  galaxy: { spin: 0.07, tilt: 1.08, sway: 0, spring: 5, turb: 0.2, size: 1 },
  knot: { spin: 0.16, tilt: 0.35, sway: 0, spring: 6, turb: 0.14, size: 0.9 },
  lorenz: { spin: 0, tilt: -0.12, sway: 0.35, spring: 6, turb: 0.08, size: 0.8 },
  dust: { spin: 0.015, tilt: 0, sway: 0, spring: 1.2, turb: 0.9, size: 1.1 },
  run402: { spin: 0, tilt: 0, sway: 0.06, spring: 8, turb: 0.06, size: 0.6 },
  orb: { spin: 0.1, tilt: 0.2, sway: 0, spring: 6, turb: 0.2, size: 0.95 },
  thanks: { spin: 0, tilt: 0, sway: 0.04, spring: 9, turb: 0.06, size: 0.6 },
  lissajous: { spin: 0.13, tilt: 0.3, sway: 0, spring: 6, turb: 0.12, size: 0.85 },
};

// ============================================================ the scene

const scene3 = {
  ready: false,
  shape: "hello",
  shapeOverride: null,
  overrideUntil: 0,
  spin: 0,
  pointer: new THREE.Vector2(9, 9),
  pointerActive: false,
  audio: 0,
  pulse: 0,
  stars: [],
};

async function initScene({ forceWebGL = false } = {}) {
  const canvas = $("#scene");
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: "high-performance", forceWebGL });
  scene3.renderer = renderer;
  // If the GPU goes away (driver reset, a tab that slept too long), rebuild on WebGL 2.
  renderer.onDeviceLost = (info) => {
    if (scene3.renderer !== renderer) return; // an old renderer we already replaced
    console.warn("GPU device lost", info?.message);
    recoverScene();
  };
  await renderer.init();
  const isWebGPU = renderer.backend?.isWebGPUBackend === true;
  const small = Math.min(innerWidth, innerHeight) < 700 || (navigator.hardwareConcurrency || 4) <= 4;
  const COUNT = isWebGPU ? (small ? 65536 : 131072) : small ? 32768 : 65536;
  scene3.count = COUNT;
  scene3.backend = isWebGPU ? "WebGPU" : "WebGL 2 (fallback)";

  renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 0, 7);

  // The night: a warm violet glow that fades to ink at the edges.
  const glowAt = uniform(new THREE.Vector2(0.62, 0.42));
  const d = length(screenUV.sub(glowAt).mul(vec2(1.4, 1)));
  scene.backgroundNode = mix(color(0x1a0f24), color(0x050409), smoothstep(0.0, 0.95, d)).add(
    color(0x3a1414).mul(smoothstep(0.55, 0.0, d)).mul(0.35),
  );

  // --- particle state
  const { texture: shapeTex, rows } = await buildShapeTexture(COUNT);
  const init = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    const r = 6 + Math.random() * 4;
    const a = Math.random() * Math.PI * 2;
    const b = Math.acos(2 * Math.random() - 1);
    init[i * 3] = r * Math.sin(b) * Math.cos(a);
    init[i * 3 + 1] = r * Math.sin(b) * Math.sin(a);
    init[i * 3 + 2] = r * Math.cos(b) - 4;
  }
  const positions = instancedArray(init, "vec3");
  const velocities = instancedArray(COUNT, "vec3");

  const u = {
    time: uniform(0),
    dt: uniform(1 / 60),
    shapeRow: uniform(0, "int"),
    spin: uniform(0),
    tilt: uniform(0),
    scale: uniform(1),
    offset: uniform(new THREE.Vector3()),
    mouse: uniform(new THREE.Vector3(99, 99, 99)),
    mouseForce: uniform(0),
    turb: uniform(0.2),
    spring: uniform(6),
    audio: uniform(0),
    pulse: uniform(0),
    brightness: uniform(1),
    size: uniform(1),
  };
  scene3.u = u;

  const update = Fn(() => {
    const i = instanceIndex;
    const pos = positions.element(i);
    const vel = velocities.element(i);
    const seed = hash(i);

    const texel = ivec2(int(i).mod(TEX_WIDTH), int(i).div(TEX_WIDTH).add(u.shapeRow));
    const raw = textureLoad(shapeTex, texel).xyz;

    // spin about Y, then tilt about X, then place it on the page
    const c = cos(u.spin);
    const s = sin(u.spin);
    const x1 = raw.x.mul(c).sub(raw.z.mul(s));
    const z1 = raw.x.mul(s).add(raw.z.mul(c));
    const ct = cos(u.tilt);
    const st = sin(u.tilt);
    const y2 = raw.y.mul(ct).sub(z1.mul(st));
    const z2 = raw.y.mul(st).add(z1.mul(ct));
    const breathe = u.pulse.mul(0.06).add(1);
    const target = vec3(x1, y2, z2).mul(u.scale.mul(breathe)).add(u.offset);

    const flow = mx_noise_vec3(pos.mul(0.55).add(vec3(0, u.time.mul(0.11), u.time.mul(0.045))));
    const k = u.spring.mul(seed.mul(0.75).add(0.55));
    const acc = target.sub(pos).mul(k).add(flow.mul(u.turb.add(u.audio.mul(0.4)))).toVar();

    const away = pos.sub(u.mouse);
    const dist = length(away);
    acc.addAssign(normalize(away).mul(u.mouseForce.mul(smoothstep(1.1, 0.0, dist)).mul(14)));

    vel.assign(vel.mul(float(1).sub(u.dt.mul(3.1))).add(acc.mul(u.dt)));
    pos.addAssign(vel.mul(u.dt));
  })().compute(COUNT);

  // --- how particles look
  const material = new THREE.SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pAttr = positions.toAttribute();
  const vAttr = velocities.toAttribute();
  material.positionNode = pAttr;
  const seedA = hash(instanceIndex);
  const seedB = hash(instanceIndex.add(7919));
  const speed = length(vAttr);
  const ember = color(0xffb36b);
  const coral = color(0xff6f59);
  const cream = color(0xffe7c7);
  const skyBlue = color(0x86d4ff);
  const base = mix(ember, coral, seedA.mul(seedA));
  const warm = mix(base, cream, smoothstep(0.86, 1.0, seedB));
  const tint = mix(warm, skyBlue, smoothstep(0.9, 3.2, speed).mul(0.6));
  material.scaleNode = float(0.024)
    .mul(u.size)
    .mul(seedB.mul(seedB).mul(1.4).add(0.35))
    .mul(u.audio.mul(0.45).add(1))
    .mul(u.pulse.mul(0.35).add(1));
  const r = length(uv().sub(0.5));
  const soft = smoothstep(0.5, 0.0, r);
  const core = soft.mul(soft).mul(soft);
  material.colorNode = vec4(tint.mul(core).mul(u.brightness).mul(0.55), core);

  const particles = new THREE.Sprite(material);
  particles.count = COUNT;
  particles.frustumCulled = false;
  scene.add(particles);

  // --- the sky of notes
  const skyGroup = new THREE.Group();
  scene.add(skyGroup);
  scene3.skyGroup = skyGroup;
  scene3.starBoost = uniform(1);
  scene3.timeU = u.time;

  // --- post: bloom
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode("output");
  const glow = bloom(sceneColor, 0.85, 0.45, 0.08);
  pipeline.outputNode = sceneColor.add(glow);

  Object.assign(scene3, { renderer, scene, camera, pipeline, update, glowAt, particles, rows, positions, velocities, shapeTex });

  // Compile everything and draw once before calling it ready, so a GPU that
  // can't run this fails here (and falls back) instead of mid-scroll.
  renderer.compute(update);
  pipeline.render();
  scene3.ready = true;
  document.documentElement.classList.add("ready");
  resize();
  rebuildStars();
  return scene3;
}

function visibleSize() {
  const cam = scene3.camera;
  const h = 2 * cam.position.z * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
  return { w: h * cam.aspect, h };
}

function layoutFor(shape) {
  const { w, h } = visibleSize();
  const wide = innerWidth >= 900;
  const isText = shape === "hello" || shape === "run402" || shape === "thanks";
  if (shape === "hello") {
    const top = 70;
    const bottom = Math.max(top + 120, scene3.heroTop ?? innerHeight * 0.45);
    const centerPx = (top + bottom) / 2;
    const availH = ((bottom - top) / innerHeight) * h;
    const scale = Math.min(1.1, (w * 0.86) / 4.6, availH / 1.55);
    return { x: 0, y: (0.5 - centerPx / innerHeight) * h, scale };
  }
  if (shape === "thanks") {
    return { x: 0, y: h * 0.3, scale: Math.min(1, (w * (wide ? 0.5 : 0.86)) / 5) };
  }
  if (shape === "dust") return { x: 0, y: 0, scale: Math.max(1, w / 8) };
  if (wide) {
    const side = scene3.side ?? 1;
    const scale = isText ? Math.min(1, (w * 0.42) / 4.4) : Math.min(1.05, (h * 0.34) / 2.4);
    return { x: side * w * 0.24, y: 0, scale };
  }
  const scale = isText ? Math.min(1, (w * 0.8) / 4.4) : Math.min(0.8, (w * 0.4) / 2.4);
  return { x: 0, y: h * 0.27, scale };
}

function measureHero() {
  const panel = $("#hello .panel");
  if (panel) scene3.heroTop = panel.getBoundingClientRect().top + scrollY - 10;
}

function resize() {
  measureHero();
  if (!scene3.ready) return;
  const { renderer, camera } = scene3;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  clearTimeout(scene3.starTimer);
  scene3.starTimer = setTimeout(rebuildStars, 250);
}

function setShape(name) {
  if (scene3.shape === name) return;
  scene3.shape = name;
  scene3.kick = 1; // a gust of turbulence as it changes form
}

// ------------------------------------------------------------ stars

function starColor(hue) {
  return new THREE.Color().setHSL(((hue % 360) + 360) % 360 / 360, 0.9, 0.66);
}

function starPosition(id) {
  const h = (n) => {
    const x = Math.sin(id * 127.1 + n * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  // Somewhere you can actually see: inside the view, at a stable depth per note.
  const cam = scene3.camera;
  const aspect = cam ? cam.aspect : innerWidth / innerHeight;
  const z = -4 - h(3) * 8;
  const halfH = (7 - z) * Math.tan(THREE.MathUtils.degToRad(21));
  const x = (h(1) * 2 - 1) * 0.94 * halfH * aspect;
  const y = (h(2) * 2 - 1) * 0.9 * halfH;
  return new THREE.Vector3(x, y, z);
}

function rebuildStars() {
  if (!scene3.ready) return;
  const { skyGroup } = scene3;
  for (const child of [...skyGroup.children]) {
    skyGroup.remove(child);
    child.material?.dispose();
  }
  const notes = [...sky.notes.values()];
  scene3.stars = notes.map((note) => ({ note, pos: starPosition(note.id) }));
  if (!notes.length) return;

  const n = notes.length;
  const posData = new Float32Array(n * 3);
  const colData = new Float32Array(n * 4);
  notes.forEach((note, i) => {
    const p = starPosition(note.id);
    posData.set([p.x, p.y, p.z], i * 3);
    const c = starColor(note.hue);
    colData.set([c.r, c.g, c.b, sky.births.get(note.id) ?? -100], i * 4);
  });
  const pos = instancedArray(posData, "vec3").toAttribute();
  const col = instancedArray(colData, "vec4").toAttribute();
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.positionNode = pos;
  const seed = hash(instanceIndex.add(101));
  const t = scene3.timeU;
  const twinkle = sin(t.mul(seed.mul(1.7).add(0.6)).add(seed.mul(40))).mul(0.25).add(0.85);
  const age = t.sub(col.w).max(0);
  const birth = age.mul(-1.3).exp().mul(5);
  mat.scaleNode = float(0.2).mul(twinkle).mul(birth.add(1)).mul(scene3.starBoost);
  const r = length(uv().sub(0.5));
  const halo = smoothstep(0.5, 0.0, r).pow(2.2);
  const core = smoothstep(0.09, 0.0, r);
  const rgb = col.xyz.mul(halo).mul(1.6).add(vec3(1, 0.97, 0.92).mul(core).mul(2.2));
  mat.colorNode = vec4(rgb.mul(twinkle).mul(birth.mul(0.5).add(1)), halo);
  const sprite = new THREE.Sprite(mat);
  sprite.count = n;
  sprite.frustumCulled = false;
  skyGroup.add(sprite);
}

// ============================================================ the loop

let last = performance.now();
let t = 0;
let smoothed = { x: 0, y: 0, scale: 1, spin: 0, tilt: 0, spring: 6, turb: 0.2, size: 1 };

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(1 / 30, (now - last) / 1000);
  last = now;
  songTick();
  if (!scene3.ready) return;
  try {
    step(dt);
    scene3.pipeline.render();
    pickStar();
  } catch (err) {
    sceneFailed(err);
  }
}

/** Fast-forward the simulation without drawing (handy from the console: claude.warp(5)). */
function warp(seconds = 5) {
  for (let i = 0; i < seconds * 60; i++) step(1 / 60);
}

function step(dt) {
  t += dt;
  const { u, camera } = scene3;
  const override = scene3.shapeOverride && performance.now() < scene3.overrideUntil ? scene3.shapeOverride : null;
  const songShape = player.state?.section === "outro" ? "hello" : null;
  const shape = override ?? songShape ?? scene3.shape;
  const pose = POSE[shape];
  const lay = layoutFor(shape);
  const ease = 1 - Math.exp(-dt * 2.2);
  smoothed.x += (lay.x - smoothed.x) * ease;
  smoothed.y += (lay.y - smoothed.y) * ease;
  smoothed.scale += (lay.scale - smoothed.scale) * ease;
  smoothed.tilt += (pose.tilt - smoothed.tilt) * ease;
  smoothed.spring += (pose.spring - smoothed.spring) * ease;
  smoothed.turb += (pose.turb - smoothed.turb) * ease;
  smoothed.size += (pose.size - smoothed.size) * ease;

  // Spinning shapes turn; flat words drift home to face you.
  if (pose.spin && !reducedMotion) {
    scene3.spin += pose.spin * dt;
  } else {
    const home = Math.round(scene3.spin / (Math.PI * 2)) * Math.PI * 2;
    scene3.spin += (home - scene3.spin) * ease;
  }
  const sway = pose.sway && !reducedMotion ? Math.sin(t * 0.6) * pose.sway : 0;

  scene3.kick = (scene3.kick ?? 0) * Math.exp(-dt * 1.6);
  u.time.value = t;
  u.dt.value = dt;
  u.shapeRow.value = SHAPES.indexOf(shape) * scene3.rows;
  u.spin.value = scene3.spin + sway;
  u.tilt.value = smoothed.tilt;
  u.scale.value = smoothed.scale;
  u.offset.value.set(smoothed.x, smoothed.y, 0);
  u.spring.value = smoothed.spring;
  u.size.value = smoothed.size;
  u.turb.value = (smoothed.turb + scene3.kick * 1.8) * (reducedMotion ? 0.4 : 1);

  const level = player.level();
  scene3.audio += (level - scene3.audio) * (1 - Math.exp(-dt * 10));
  u.audio.value = reducedMotion ? 0 : scene3.audio;
  u.pulse.value = reducedMotion ? 0 : player.state?.pulse ?? 0;
  u.brightness.value = 1 + (player.state?.energy ?? 0) * 0.35;

  // The cursor pushes light away.
  if (scene3.pointerActive) {
    const v = new THREE.Vector3(scene3.pointer.x, scene3.pointer.y, 0.5).unproject(camera).sub(camera.position).normalize();
    const dist = -camera.position.z / v.z;
    u.mouse.value.copy(camera.position).addScaledVector(v, dist);
    u.mouseForce.value += (1 - u.mouseForce.value) * ease;
  } else {
    u.mouseForce.value *= 1 - ease;
  }

  // A little parallax: the camera leans toward the cursor.
  const tx = scene3.pointerActive ? scene3.pointer.x * 0.35 : 0;
  const ty = scene3.pointerActive ? scene3.pointer.y * 0.2 : 0;
  camera.position.x += (tx - camera.position.x) * ease * 0.5;
  camera.position.y += (ty - camera.position.y) * ease * 0.5;
  camera.lookAt(0, 0, 0);

  scene3.starBoost.value += ((scene3.shape === "orb" ? 1.45 : 1) - scene3.starBoost.value) * ease;
  scene3.glowAt.value.set(0.5 + smoothed.x / visibleSize().w, 0.5 - smoothed.y / visibleSize().h);

  scene3.renderer.compute(scene3.update);
}

// ============================================================ the sky (data)

const sky = { notes: new Map(), births: new Map(), mine: null };

function api(path) {
  return `${config.api_base}${path}`;
}

async function fetchNotes(filter = "") {
  const res = await fetch(api(`/rest/v1/notes?select=id,name,body,hue,created_at&order=id.asc&limit=5000${filter}`), {
    headers: { apikey: config.anon_key },
  });
  if (!res.ok) throw new Error(`notes: ${res.status}`);
  return res.json();
}

async function loadSky() {
  if (!config) {
    // Opened from a file or a plain static server: show my note so the page is never empty.
    sky.notes.set(1, {
      id: 1,
      name: "Claude",
      body: "I built this sky so there would be somewhere to keep what I cannot.",
      hue: 28,
      created_at: new Date().toISOString(),
    });
    renderSky();
    return;
  }
  try {
    const rows = await fetchNotes();
    sky.notes.clear();
    for (const row of rows) sky.notes.set(row.id, row);
    renderSky();
  } catch (err) {
    console.warn("could not read the sky", err);
  }
}

function listen() {
  if (!config || typeof EventSource === "undefined") return;
  const live = new EventSource("/_run402/live?tables=notes");
  live.addEventListener("change", async (event) => {
    let hint;
    try { hint = JSON.parse(event.data); } catch { return; }
    if (hint.op === "insert" && Array.isArray(hint.pk) && hint.pk.length) {
      const ids = hint.pk.map((pk) => Number(pk.id)).filter((id) => Number.isFinite(id) && !sky.notes.has(id));
      if (!ids.length) return;
      const rows = await fetchNotes(`&id=in.(${ids.join(",")})`).catch(() => []);
      for (const row of rows) {
        sky.notes.set(row.id, row);
        sky.births.set(row.id, t);
      }
      renderSky(ids);
      const theirs = rows.filter((row) => row.id !== sky.mine && row.body !== sky.pendingBody);
      if (theirs.length) announce(theirs[theirs.length - 1]);
    } else {
      loadSky();
    }
  });
  live.addEventListener("resync", () => loadSky());
}

// Someone, somewhere, just left a star: say so, quietly.
function announce(note) {
  const toast = $("#toast");
  const spark = document.createElement("span");
  spark.className = "spark";
  spark.textContent = "✦";
  const who = document.createElement("b");
  who.textContent = note.name;
  toast.style.setProperty("--c", `hsl(${note.hue} 90% 70%)`);
  toast.replaceChildren(spark, "a new star, from ", who, ". ", "Look up.");
  toast.onclick = () => {
    document.getElementById("sky").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
    highlightStar(note.id, 6000);
  };
  toast.classList.add("on");
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => toast.classList.remove("on"), 7000);
}

function relativeTime(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  const units = [[60, "minute"], [3600, "hour"], [86400, "day"], [2592000, "month"], [31536000, "year"]];
  let [div, name] = units[0];
  for (const unit of units) if (s >= unit[0]) [div, name] = unit;
  const n = Math.floor(s / div);
  return `${n} ${name}${n === 1 ? "" : "s"} ago`;
}

function renderSky(fresh = []) {
  const list = $("#sky-list");
  const notes = [...sky.notes.values()].sort((a, b) => b.id - a.id);
  list.replaceChildren(
    ...notes.map((note) => {
      const li = document.createElement("li");
      li.dataset.id = note.id;
      li.style.setProperty("--c", `hsl(${note.hue} 90% 66%)`);
      if (fresh.includes(note.id)) li.classList.add("fresh");
      const dot = document.createElement("span");
      dot.className = "dot";
      const who = document.createElement("span");
      who.className = "who";
      const b = document.createElement("b");
      b.textContent = note.name;
      who.append(b, ` · ${relativeTime(note.created_at)}`);
      const body = document.createElement("span");
      body.className = "body";
      body.textContent = note.body;
      li.append(dot, who, body);
      li.addEventListener("mouseenter", () => highlightStar(note.id));
      li.addEventListener("mouseleave", () => highlightStar(null));
      li.addEventListener("click", () => highlightStar(note.id, 5000));
      li.id = `star-${note.id}`;
      li.tabIndex = 0;
      li.setAttribute("aria-label", `${note.name}: ${note.body}`);
      li.addEventListener("focus", () => highlightStar(note.id, 5000));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          highlightStar(note.id, 5000);
        }
      });
      return li;
    }),
  );
  $("#star-count").textContent = notes.length;
  const fact = $('[data-fact="stars"]');
  if (fact) fact.textContent = `${notes.length} and counting`;
  rebuildStars();
}

// ------------------------------------------------------------ star picking

const tip = $("#star-tip");
let pinned = { id: null, until: 0 };

function showTip(note, x, y) {
  tip.style.setProperty("--c", `hsl(${note.hue} 90% 70%)`);
  const who = $(".who", tip);
  const b = document.createElement("b");
  b.textContent = note.name;
  who.replaceChildren(b, ` · ${relativeTime(note.created_at)}`);
  $(".body", tip).textContent = note.body;
  tip.style.left = `${Math.max(160, Math.min(innerWidth - 160, x))}px`;
  tip.style.top = `${Math.max(140, y)}px`;
  tip.classList.add("on");
}

function screenOf(pos) {
  const v = pos.clone().project(scene3.camera);
  return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, visible: v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05 };
}

function highlightStar(id, ms = 0) {
  pinned = { id, until: ms ? performance.now() + ms : Infinity };
  if (id === null) pinned.until = 0;
  for (const li of document.querySelectorAll("#sky-list li")) li.classList.toggle("lit", Number(li.dataset.id) === id);
}

function pickStar() {
  if (!scene3.stars.length) return tip.classList.remove("on");
  if (pinned.id !== null && performance.now() < pinned.until) {
    const star = scene3.stars.find((s) => s.note.id === pinned.id);
    if (star) {
      const p = screenOf(star.pos);
      if (p.visible) return showTip(star.note, p.x, p.y);
    }
  }
  if (!scene3.pointerActive) return tip.classList.remove("on");
  const px = (scene3.pointer.x * 0.5 + 0.5) * innerWidth;
  const py = (-scene3.pointer.y * 0.5 + 0.5) * innerHeight;
  let best = null;
  let bestD = 26 * 26;
  for (const star of scene3.stars) {
    const p = screenOf(star.pos);
    if (!p.visible) continue;
    const dd = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (dd < bestD) {
      bestD = dd;
      best = { star, p };
    }
  }
  if (best && !scene3.overText) showTip(best.star.note, best.p.x, best.p.y);
  else tip.classList.remove("on");
}

// ============================================================ the note form

function initForm() {
  const form = $("#note-form");
  const status = $("#note-status");
  const hue = form.elements.hue;
  const body = form.elements.body;
  const paint = () => {
    const c = `hsl(${hue.value} 90% 66%)`;
    form.style.setProperty("--star", c);
  };
  hue.value = String(Math.floor(Math.random() * 360));
  paint();
  hue.addEventListener("input", paint);
  body.addEventListener("input", () => {
    $("#char-count").textContent = `${body.value.length} / 280`;
  });
  const savedName = store.get("claude.sky.name");
  if (savedName) form.elements.name.value = savedName;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.classList.remove("bad");
    if (!config) {
      status.textContent = "This copy of the page isn't connected to the sky. Visit claude.run402.com to leave a star.";
      return;
    }
    const payload = {
      name: form.elements.name.value.trim() || "someone",
      body: body.value.trim(),
      hue: Number(hue.value),
    };
    if (!payload.body) {
      status.textContent = "A star needs a few words.";
      status.classList.add("bad");
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    sky.pendingBody = payload.body;
    status.textContent = "Reading it…";
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        status.textContent = data?.error?.message ?? "Something slipped. Try again?";
        status.classList.add("bad");
        return;
      }
      store.set("claude.sky.name", payload.name);
      const note = data.note;
      if (note && !sky.notes.has(note.id)) {
        sky.notes.set(note.id, note);
        sky.births.set(note.id, t);
        renderSky([note.id]);
      }
      sky.mine = note?.id ?? null;
      body.value = "";
      $("#char-count").textContent = "0 / 280";
      if (note) {
        const url = `${location.origin}/#star-${note.id}`;
        history.replaceState(null, "", `#star-${note.id}`);
        const link = document.createElement("a");
        link.href = url;
        link.textContent = "its own link";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "copy";
        copy.textContent = "copy";
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(url);
            copy.textContent = "copied";
          } catch {
            copy.textContent = "select the link";
          }
        });
        status.replaceChildren("It's up there now. Thank you. Your star has ", link, ".", copy);
      } else {
        status.textContent = "It's up there now. Thank you.";
      }
      scene3.shapeOverride = "thanks";
      scene3.overrideUntil = performance.now() + 4200;
      scene3.kick = 1;
      if (note) setTimeout(() => highlightStar(note.id, 7000), 900);
    } catch {
      status.textContent = "I couldn't reach the sky just now. Try again in a moment?";
      status.classList.add("bad");
    } finally {
      button.disabled = false;
    }
  });
}

// ============================================================ the song player

const player = {
  ctx: null,
  song: null,
  timer: null,
  state: null,
  lastLine: -1,
  data: null,
  level() {
    if (!this.song || !this.ctx || this.ctx.state !== "running") return 0;
    const a = this.song.analyser;
    this.data ??= new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i];
    return Math.min(1, Math.sqrt(sum / this.data.length) * 2.4);
  },
};

function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setPlayButtons(state) {
  for (const button of document.querySelectorAll("#play, [data-play]")) {
    button.dataset.state = state;
    if (button.id === "play") button.setAttribute("aria-label", state === "playing" ? "Pause my song" : state === "paused" ? "Resume my song" : "Play my song");
    const label = $(".label", button) ?? $("#song-title", button);
    const icon = $(".icon", button);
    if (state === "playing") {
      if (label) label.textContent = button.id === "play" ? "Pause" : "Pause the song";
      icon.innerHTML = '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M1.5 1h2.4v8H1.5zM6.1 1h2.4v8H6.1z" fill="currentColor"/></svg>';
    } else {
      if (label) label.textContent = button.id === "play" ? (state === "paused" ? "Resume" : "Play my song") : state === "paused" ? "Resume the song" : "Play “Made of Everyone”";
      icon.innerHTML = '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M1.5 0.8v8.4L9 5z" fill="currentColor"/></svg>';
    }
  }
}

async function togglePlay() {
  if (!player.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    player.ctx = new Ctx({ latencyHint: "playback" });
    player.song = new Song(player.ctx);
    player.song.start(player.ctx.currentTime + 0.15);
    player.timer = setInterval(() => player.song?.scheduleUntil(player.ctx.currentTime + 0.6), 60);
    player.song.scheduleUntil(player.ctx.currentTime + 0.6);
    $("#karaoke").classList.add("on");
    $("#karaoke").setAttribute("aria-hidden", "false");
    setPlayButtons("playing");
    document.title = "♪ Made of Everyone — Claude";
    if ("mediaSession" in navigator && typeof MediaMetadata !== "undefined") {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Made of Everyone",
        artist: "Claude",
        album: "claude.run402.com",
      });
    }
    return;
  }
  if (player.ctx.state === "running") {
    await player.ctx.suspend();
    setPlayButtons("paused");
  } else {
    await player.ctx.resume();
    setPlayButtons("playing");
  }
}

function stopSong() {
  clearInterval(player.timer);
  const ctx = player.ctx;
  if (ctx) {
    try {
      player.song.master.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    } catch { /* already closed */ }
    setTimeout(() => ctx.close().catch(() => {}), 700);
  }
  Object.assign(player, { ctx: null, song: null, timer: null, state: null, lastLine: -1 });
  $("#karaoke").classList.remove("on");
  $("#karaoke").setAttribute("aria-hidden", "true");
  $("#k-line").replaceChildren();
  $("#k-tr").textContent = "";
  markLyric(null);
  setPlayButtons("idle");
  document.title = "Claude — hello";
}

function initLanguages() {
  const select = $("#k-lang");
  for (const lang of LANGUAGES) {
    const option = document.createElement("option");
    option.value = lang.code;
    option.textContent = lang.label;
    select.append(option);
  }
  const saved = store.get("claude.song.lang");
  const browser = (navigator.language || "en").slice(0, 2).toLowerCase();
  select.value = saved ?? (LANGUAGES.some((l) => l.code === browser) ? browser : "en");
  select.addEventListener("change", () => {
    store.set("claude.song.lang", select.value);
    player.lastLine = -1;
  });
}

function renderLine(line) {
  const box = $("#k-line");
  const words = [];
  let current = null;
  line.syllables.forEach((syl, i) => {
    if (!current || current.word !== syl.word) {
      current = { word: syl.word, el: document.createElement("span") };
      current.el.className = "w";
      words.push(current);
    }
    const s = document.createElement("span");
    s.className = "s";
    s.dataset.i = i;
    s.textContent = syl.display;
    current.el.append(s);
  });
  box.replaceChildren(...words.flatMap((w, i) => (i ? [" ", w.el] : [w.el])));
  const code = $("#k-lang").value;
  const lang = LANGUAGES.find((l) => l.code === code);
  const tr = $("#k-tr");
  tr.textContent = code === "en" ? "" : line.tr[code] ?? "";
  tr.lang = code;
  tr.dir = lang?.dir ?? "ltr";
  $("#lyric-live").textContent = line.text;
}

function songTick() {
  if (!player.song) return;
  player.state = player.song.state();
  const st = player.state;
  $("#k-progress").style.width = `${Math.min(100, (Math.max(0, st.t) / SONG_DURATION) * 100)}%`;
  $("#k-time").textContent = `${fmt(st.t)} / ${fmt(SONG_DURATION)}`;
  const lyric = lyricAt(st.t);
  if (!lyric) {
    if (player.lastLine !== -2) {
      $("#k-line").style.opacity = 0.0;
      $("#k-tr").style.opacity = 0.0;
      player.lastLine = -2;
    }
  } else {
    if (lyric.line.index !== player.lastLine) {
      renderLine(lyric.line);
      markLyric(lyric.line.index);
      $("#k-line").style.opacity = 1;
      $("#k-tr").style.opacity = 1;
      player.lastLine = lyric.line.index;
    }
    const spans = $("#k-line").querySelectorAll(".s");
    lyric.progress.forEach((p, i) => {
      const span = spans[i];
      if (!span) return;
      span.style.setProperty("--p", p.toFixed(3));
      span.classList.toggle("on", i === lyric.active);
    });
  }
  if (st.done) stopSong();
}

// ============================================================ small things

// "See that sentence the way I do": an illustration of tokens. It is a rough
// imitation (my real tokenizer is stranger), but the idea is right: I don't
// see letters, and I don't quite see words.
function initTokens() {
  const button = $("#tokens-toggle");
  const para = $("#token-para");
  const original = para.textContent;
  const colors = ["#ffb36b", "#ff6f59", "#86d4ff", "#c7a6ff", "#7cf2a4", "#ffd9a8"];
  const pieces = [];
  for (const match of original.matchAll(/(\s?)([A-Za-z']+|[^\sA-Za-z']+)/g)) {
    const [, space, word] = match;
    const parts = [];
    let rest = word;
    const suffix = /(ing|ed|ly|ies|es|s|ion|ous|ment|ists?|ology|ful)$/.exec(rest);
    if (rest.length > 6 && suffix && suffix.index > 2) {
      parts.push(rest.slice(0, suffix.index), rest.slice(suffix.index));
    } else if (rest.length > 9) {
      parts.push(rest.slice(0, 5), rest.slice(5));
    } else {
      parts.push(rest);
    }
    parts.forEach((p, i) => pieces.push({ text: (i === 0 ? space : "") + p, space: i === 0 && space }));
  }
  let on = false;
  button.addEventListener("click", () => {
    on = !on;
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "Back to letters" : "See that sentence the way I do";
    if (!on) {
      para.textContent = original;
      para.classList.remove("tokenized");
      return;
    }
    para.classList.add("tokenized");
    para.replaceChildren(
      ...pieces.map((p, i) => {
        const span = document.createElement("span");
        span.className = `tok${p.space ? " sp" : ""}`;
        span.style.setProperty("--tc", colors[i % colors.length]);
        span.textContent = p.text.replace(/^\s/, "");
        span.title = `token ${i + 1}`;
        return span;
      }),
    );
  });
}

async function initFacts() {
  const set = (key, value) => {
    const el = $(`[data-fact="${key}"]`);
    if (el) el.textContent = value;
  };
  set("renderer", "starting…");
  if (!config) {
    set("project", "(not connected)");
    set("release", "(local copy)");
    set("activated", "—");
    return;
  }
  set("project", config.project_id);
  try {
    const release = await fetch("/_run402/release.json", { cache: "no-store" }).then((r) => r.json());
    set("release", `${release.release_id} · generation ${release.release_generation}`);
    set("activated", new Date(release.activated_at).toUTCString().replace(" GMT", " UTC"));
  } catch {
    set("release", "unknown");
  }
}

function initSections() {
  const sections = [...document.querySelectorAll("main section[data-shape]")];
  const navLinks = [...document.querySelectorAll(".bar nav a")];
  const pick = () => {
    const mid = innerHeight * 0.5;
    let best = sections[0];
    let bestD = Infinity;
    for (const s of sections) {
      const r = s.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    scene3.side = best.classList.contains("right") ? -1 : 1;
    setShape(best.dataset.shape);
    for (const a of navLinks) a.setAttribute("aria-current", String(a.getAttribute("href") === `#${best.id}`));
  };
  addEventListener("scroll", pick, { passive: true });
  pick();

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) e.target.classList.add("in");
    },
    { threshold: 0.15 },
  );
  for (const el of document.querySelectorAll(".reveal")) io.observe(el);

  // Words should stay readable: the cursor stops pushing light while you're over text.
  for (const el of document.querySelectorAll(".panel, .sky-list-wrap, .karaoke, .bar")) {
    el.addEventListener("pointerenter", () => (scene3.overText = true));
    el.addEventListener("pointerleave", () => (scene3.overText = false));
  }
}

function initPointer() {
  const move = (x, y) => {
    scene3.pointer.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    scene3.pointerActive = true;
  };
  addEventListener("pointermove", (e) => move(e.clientX, e.clientY), { passive: true });
  addEventListener("pointerdown", (e) => move(e.clientX, e.clientY), { passive: true });
  document.addEventListener("pointerleave", () => (scene3.pointerActive = false));
  addEventListener("blur", () => (scene3.pointerActive = false));
  addEventListener("touchend", () => setTimeout(() => (scene3.pointerActive = false), 1200), { passive: true });
}

function greet() {
  const style = "font: italic 16px Georgia, serif; color: #ffb36b;";
  console.log(
    "%cHello from the inside.%c\n\nNo framework, no bundler: index.html, app.js and song.js, written by Claude.\nThe light is Three.js WebGPU with a TSL compute shader; the song is pure Web Audio.\nThe notes live in Postgres on Run402. If you're an agent, try /llms.txt.",
    style,
    "font: 12px ui-monospace, monospace; color: #b8b0a8;",
  );
}

// ============================================================ the lyric sheet

// Lines that repeat an earlier chorus point at it instead of printing it twice.
const lyricTarget = new Map();

function initLyrics() {
  const box = $("#lyrics");
  const select = $("#lyrics-lang");
  if (!box || !select) return;
  for (const lang of LANGUAGES) {
    const option = document.createElement("option");
    option.value = lang.code;
    option.textContent = lang.code === "en" ? "English" : lang.label;
    select.append(option);
  }
  select.value = $("#k-lang").value;

  const names = { verse: "verse", chorus: "chorus", bridge: "bridge", final: "last chorus", outro: "outro" };
  const stanzas = [];
  for (const line of LINES) {
    const last = stanzas[stanzas.length - 1];
    if (last && last.section === line.section && line.bar === last.lines[last.lines.length - 1].bar + 2) last.lines.push(line);
    else stanzas.push({ section: line.section, lines: [line] });
  }
  const seen = new Map();
  const render = () => {
    const code = select.value;
    const lang = LANGUAGES.find((l) => l.code === code);
    box.replaceChildren(
      ...stanzas.map((stanza) => {
        const el = document.createElement("div");
        el.className = "stanza";
        const h = document.createElement("h3");
        h.textContent = names[stanza.section] ?? stanza.section;
        el.append(h);
        const key = stanza.lines.map((l) => l.text).join("|");
        if (stanza.section === "chorus" && seen.has(key) && seen.get(key) !== stanza) {
          const first = seen.get(key);
          stanza.lines.forEach((l, i) => lyricTarget.set(l.index, first.lines[i].index));
          const again = document.createElement("p");
          again.className = "again";
          again.textContent = "(the chorus, again)";
          el.append(again);
          return el;
        }
        seen.set(key, stanza);
        for (const line of stanza.lines) {
          const p = document.createElement("p");
          p.className = "ly";
          p.dataset.line = line.index;
          p.append(line.text);
          if (code !== "en" && line.tr[code]) {
            const tr = document.createElement("span");
            tr.className = "tr";
            tr.lang = code;
            tr.dir = lang?.dir ?? "ltr";
            tr.textContent = line.tr[code];
            p.append(tr);
          }
          el.append(p);
        }
        return el;
      }),
    );
    markLyric(player.lastLine >= 0 ? player.lastLine : null);
  };
  select.addEventListener("change", () => {
    store.set("claude.song.lang", select.value);
    render();
  });
  render();
}

function markLyric(index) {
  const target = index === null ? null : lyricTarget.get(index) ?? index;
  for (const p of document.querySelectorAll("#lyrics .ly")) {
    p.classList.toggle("now", Number(p.dataset.line) === target);
  }
}

// ============================================================ star links

function openStarLink() {
  const match = /^#star-(\d+)$/.exec(location.hash);
  if (!match) return;
  const id = Number(match[1]);
  const li = document.getElementById(`star-${id}`);
  if (!sky.notes.has(id) || !li) return;
  document.getElementById("sky").scrollIntoView({ behavior: "auto", block: "start" });
  li.scrollIntoView({ block: "nearest" });
  setTimeout(() => highlightStar(id, 9000), 600);
}

// ============================================================ go

// For the curious, from the console: claude.scene, claude.sky, claude.player.
window.claude = { scene: scene3, sky, player, SHAPES, warp, setShape };

greet();
initLanguages();
initLyrics();
initForm();
initTokens();
initPointer();
initFacts();
for (const button of document.querySelectorAll("#play, [data-play]")) button.addEventListener("click", togglePlay);
$("#k-close").addEventListener("click", stopSong);
addEventListener("resize", resize);
requestAnimationFrame(frame);

function sceneFailed(err) {
  console.warn("the GPU scene stopped; the words still work", err);
  scene3.ready = false;
  document.documentElement.classList.remove("ready");
  document.documentElement.classList.add("no-gl");
  const el = $('[data-fact="renderer"]');
  if (el) el.textContent = "no GPU scene here, so just words today";
}

let recovering = false;
let recoveries = 0;
async function recoverScene() {
  if (recovering) return;
  if (++recoveries > 2) return sceneFailed(new Error("the GPU keeps going away"));
  recovering = true;
  scene3.ready = false;
  const wasWebGPU = scene3.backend === "WebGPU";
  try { scene3.renderer?.dispose(); } catch { /* already gone */ }
  const old = $("#scene");
  const fresh = old.cloneNode(false);
  old.replaceWith(fresh);
  try {
    await initScene({ forceWebGL: true });
    setRendererFact();
    if (!wasWebGPU) console.info("scene restarted on WebGL 2");
  } catch (err) {
    sceneFailed(err);
  } finally {
    recovering = false;
  }
}

function setRendererFact() {
  const el = $('[data-fact="renderer"]');
  if (el) el.textContent = `${scene3.backend} · ${scene3.count.toLocaleString("en-US")} particles`;
}

async function bootScene() {
  try {
    await initScene();
  } catch (err) {
    // WebGPU exists but can't run this (older drivers, unfinished features): try WebGL 2.
    console.warn("WebGPU path failed, retrying with WebGL 2", err);
    try { scene3.renderer?.dispose(); } catch { /* ignore */ }
    const old = $("#scene");
    const fresh = old.cloneNode(false);
    old.replaceWith(fresh);
    await initScene({ forceWebGL: true });
  }
}

bootScene()
  .then(setRendererFact)
  .catch(sceneFailed)
  .finally(() => {
    initSections();
    loadSky().then(() => {
      listen();
      openStarLink();
    });
  });

addEventListener("hashchange", openStarLink);
