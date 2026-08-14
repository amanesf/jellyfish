#!/usr/bin/env node
/**
 * A CPU port of scene/water.ts's fragment shader, plus the renderer's ACES and
 * sRGB encode — so the water's constants can be *solved* against the reference
 * instead of guessed and re-rendered.
 *
 * This is sakura's scripts/skymodel.js, and it exists for the same reason: one
 * capture under SwiftShader costs three minutes, a solve costs seconds, and the
 * first three attempts at the shafts here were spent capturing.
 *
 * Two cautions, both inherited and both real:
 *  - the post chain (bloom, Kuwahara) is not modelled, so a solved parameter
 *    set has to be checked against a real capture before it is trusted;
 *  - the solver will happily pin a parameter against a bound for a fraction of
 *    a point. Bounds below are the physically sensible range, and a parameter
 *    sitting on one is a result to argue with, not to accept.
 *
 * What it fits is not just the tone. plan.md's acceptance test was the band
 * medians, and the first render passed it (RMSE 4.8) while looking obviously
 * wrong, because its water had no structure in it. So the cost here is the
 * medians *and* each band's p10-p90 spread, which is where the light shafts
 * live.
 *
 *   node scripts/watermodel.js --profile [--set SIGMA=1.4 ...]
 *   node scripts/watermodel.js --solve
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { hdrToSrgb } = require('./hdr');

const { REF, tank } = require('./reference');
const RAMPS = JSON.parse(fs.readFileSync(path.join(__dirname, 'ramps.json'), 'utf8'));

const TANK = tank();
const FRAME_W = TANK.frame.width, FRAME_H = TANK.frame.height;
const TANK_HEIGHT = TANK.tankHeight, EYE_D = TANK.eyeDistance, EYE_H = TANK.eyeHeight;
const PIPE_R = Number(process.env.PIPE_R || 0.155);
const BANDS = 13;

/** The parameters under test — the ones scene/water.ts spells out. */
const P = {
  SIGMA: 1.15,        // extinction along the ray, per tank radius
  GAIN: 1.30,         // scattered light -> ramp position
  DESCENT: 0.42,      // how fast the ceiling light dies with depth
  CONTRAST_TOP: 3.20, // shaft contrast just under the surface
  CONTRAST_BOT: 0.85, // ...and at the floor, where the beams have merged
  SPREAD_TOP: 1.35,   // shaft field scale near the surface
  SPREAD_BOT: 0.42,
  Z_SQUASH: 0.33,     // how far the columns are stretched toward the camera
  WALL: 0.72,         // where the oblique-wall darkening starts
  WALL_DEPTH: 0.72,   // ...and how dark it gets at the silhouette
};
const BOUNDS = {
  SIGMA: [0.35, 4.0], GAIN: [0.6, 2.6], DESCENT: [0.05, 1.2],
  CONTRAST_TOP: [0.5, 9.0], CONTRAST_BOT: [0.2, 4.0],
  SPREAD_TOP: [0.4, 4.0], SPREAD_BOT: [0.1, 2.0],
  Z_SQUASH: [0.05, 1.0], WALL: [0.4, 0.95], WALL_DEPTH: [0.4, 1.0],
};

// --- the shader's own noise, ported exactly ---------------------------------
const fract = (x) => x - Math.floor(x);
function hash21(x, y) {
  return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
}
function valueNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy), b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1), d = hash21(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
function fbm(x, y) {
  let v = 0, amp = 0.5;
  for (let i = 0; i < 4; i++) { v += amp * valueNoise(x, y); x *= 2.03; y *= 2.03; amp *= 0.5; }
  return v;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function shaft(px, py, pz, time, flow, p) {
  const depth = clamp((TANK_HEIGHT - py) / TANK_HEIGHT, 0, 1);
  const spread = p.SPREAD_TOP + (p.SPREAD_BOT - p.SPREAD_TOP) * depth;
  const qx = px * spread + time * 0.035 * (0.4 + flow);
  const qy = pz * p.Z_SQUASH * spread + time * 0.021 * (0.4 + flow);
  const bands = fbm(qx * 1.7, qy * 1.7) * 0.72 + fbm(qx * 4.3 + 11, qy * 4.3 + 11) * 0.28;
  const contrast = p.CONTRAST_TOP + (p.CONTRAST_BOT - p.CONTRAST_TOP) * depth;
  return clamp(0.5 + (bands - 0.5) * 2 * contrast, 0, 1.6);
}
const descent = (y, p) => Math.exp(-(TANK_HEIGHT - y) * p.DESCENT);

function sampleRamp(table, s) {
  const n = table.length;
  const t = clamp(s, 0, 1) * (n - 1);
  const i = Math.floor(t), f = t - i, j = Math.min(n - 1, i + 1);
  return [0, 1, 2].map((k) => table[i][k] * (1 - f) + table[j][k] * f);
}

/** One pixel of scene/water.ts, returned in display sRGB. NaN outside the tank. */
function shadePixel(px, py, time, flow, p) {
  // The same ray the shader builds, from the same measured projection.
  const dx = (px + 0.5 - TANK.x0) / TANK.focal;
  const dy = -(py + 0.5 - TANK.principalY) / TANK.focal;
  const len = Math.hypot(dx, dy, 1);
  const d = [dx / len, dy / len, -1 / len];
  const o = [0, EYE_H, EYE_D];

  const cyl = (r) => {
    const a = d[0] * d[0] + d[2] * d[2];
    const b = 2 * (o[0] * d[0] + o[2] * d[2]);
    const c = o[0] * o[0] + o[2] * o[2] - r * r;
    const disc = b * b - 4 * a * c;
    if (disc <= 0) return null;
    const s = Math.sqrt(disc);
    return [(-b - s) / (2 * a), (-b + s) / (2 * a)];
  };
  const hit = cyl(1);
  if (!hit) return null;
  let [t0, t1] = hit;
  const ta = (TANK_HEIGHT - o[1]) / d[1], tb = (0 - o[1]) / d[1];
  t0 = Math.max(t0, Math.min(ta, tb));
  t1 = Math.min(t1, Math.max(ta, tb));
  t0 = Math.max(t0, 0);
  if (t1 <= t0) return null;

  const pipe = cyl(PIPE_R);
  let onPipe = false;
  if (pipe && pipe[0] > t0 && pipe[0] < t1) {
    const hy = o[1] + d[1] * pipe[0];
    if (hy > 0 && hy < TANK_HEIGHT) { t1 = pipe[0]; onPipe = true; }
  }

  const STEPS = 40;
  const dt = (t1 - t0) / STEPS;
  let light = 0, transmit = 1;
  const jitter = hash21(px, py) * dt;
  for (let i = 0; i < STEPS; i++) {
    const t = t0 + jitter + i * dt;
    const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
    const step = Math.exp(-p.SIGMA * dt);
    light += descent(y, p) * shaft(x, y, z, time, flow, p) * transmit * (1 - step);
    transmit *= step;
  }
  const reach = 1 - Math.exp(-p.SIGMA * (t1 - t0));
  let s = clamp((light / Math.max(0.25, reach)) * p.GAIN, 0, 1);
  const u = Math.hypot(o[0] + d[0] * t0, o[2] + d[2] * t0);
  const wall = clamp((u - p.WALL) / (1 - p.WALL), 0, 1);
  s *= 1 + (p.WALL_DEPTH - 1) * (wall * wall * (3 - 2 * wall));
  if (onPipe) s = clamp(s * 1.06 + 0.05, 0, 1);
  return hdrToSrgb(sampleRamp(RAMPS.water, s));
}

// --- band statistics, on the same bands scripts/waterprofile.js uses --------
function bandOf(px, py) {
  const u = (px - TANK.x0) / (TANK.R - 40);
  if (Math.abs(u) >= 1) return -1;
  const f = Math.sqrt(Math.max(0, 1 - u * u));
  const top = TANK.topYc + TANK.topB * f + 30;
  const bot = TANK.botYc + TANK.botB * f - 60;
  if (py <= top || py >= bot) return -1;
  return Math.floor(((py - top) / (bot - top)) * BANDS);
}

const STRIDE = 3; // every third pixel; the statistics are unchanged and it is 9x faster

function modelProfile(p, time = 60, flow = 0.45) {
  const bands = Array.from({ length: BANDS }, () => ({ r: [], g: [], b: [], l: [] }));
  for (let py = 0; py < FRAME_H; py += STRIDE) {
    for (let px = 0; px < FRAME_W; px += STRIDE) {
      const band = bandOf(px, py);
      if (band < 0 || band >= BANDS) continue;
      const c = shadePixel(px, py, time, flow, p);
      if (!c) continue;
      bands[band].r.push(c[0]); bands[band].g.push(c[1]); bands[band].b.push(c[2]);
      bands[band].l.push(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
    }
  }
  return bands.map((b) => {
    const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
    const q = (a, t) => a[Math.min(a.length - 1, Math.floor(t * a.length))];
    const l = [...b.l].sort((x, y) => x - y);
    return { rgb: [med(b.r), med(b.g), med(b.b)], spread: q(l, 0.9) - q(l, 0.1) };
  });
}

async function referenceProfile() {
  const { data, info } = await sharp(REF).raw().toBuffer({ resolveWithObject: true });
  const { width: W, channels: C } = info;
  const lum = (i) => 0.2126 * data[i * C] + 0.7152 * data[i * C + 1] + 0.0722 * data[i * C + 2];
  // Erode, to drop the jellyfish and the motes before measuring the water.
  const H = info.height;
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = lum(i);
  const er = new Float32Array(W * H);
  const tmp = new Float32Array(W * H);
  const R = 14;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = Infinity;
    for (let d = -R; d <= R; d++) v = Math.min(v, L[y * W + clamp(x + d, 0, W - 1)]);
    tmp[y * W + x] = v;
  }
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    let v = Infinity;
    for (let d = -R; d <= R; d++) v = Math.min(v, tmp[clamp(y + d, 0, H - 1) * W + x]);
    er[y * W + x] = v;
  }
  const bands = Array.from({ length: BANDS }, () => ({ r: [], g: [], b: [], l: [] }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const band = bandOf(x, y);
    if (band < 0 || band >= BANDS) continue;
    const i = y * W + x;
    if (L[i] - er[i] > 7) continue;
    bands[band].r.push(data[i * C]); bands[band].g.push(data[i * C + 1]); bands[band].b.push(data[i * C + 2]);
    bands[band].l.push(L[i]);
  }
  return bands.map((b) => {
    const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
    const q = (a, t) => a[Math.min(a.length - 1, Math.floor(t * a.length))];
    const l = [...b.l].sort((x, y) => x - y);
    return { rgb: [med(b.r), med(b.g), med(b.b)], spread: q(l, 0.9) - q(l, 0.1) };
  });
}

/** Tone first, structure a close second. The spread term is scaled so that
 * being 30 sRGB short of the reference's contrast costs about as much as being
 * 10 out on a channel — which is roughly how the two read on screen. */
function cost(model, ref) {
  let sq = 0, n = 0, sp = 0;
  for (let i = 0; i < BANDS; i++) {
    for (let k = 0; k < 3; k++) { const d = model[i].rgb[k] - ref[i].rgb[k]; sq += d * d; n++; }
    const ds = (model[i].spread - ref[i].spread) / 3;
    sp += ds * ds;
  }
  return Math.sqrt(sq / n) + Math.sqrt(sp / BANDS);
}

(async () => {
  for (const arg of process.argv) {
    const m = /^--set$/.test(arg) ? null : /^([A-Z_]+)=(-?[\d.]+)$/.exec(arg);
    if (m && m[1] in P) P[m[1]] = Number(m[2]);
  }
  const ref = await referenceProfile();

  if (process.argv.includes('--solve')) {
    let best = { ...P }, bestCost = cost(modelProfile(best), ref);
    console.log(`start  cost ${bestCost.toFixed(3)}`);
    const keys = Object.keys(P);
    for (let sweep = 0; sweep < 6; sweep++) {
      for (const k of keys) {
        const [lo, hi] = BOUNDS[k];
        let improved = false;
        for (const scale of [0.6, 0.8, 0.9, 1.1, 1.25, 1.6]) {
          const trial = { ...best, [k]: clamp(best[k] * scale, lo, hi) };
          const c = cost(modelProfile(trial), ref);
          if (c < bestCost - 1e-4) { best = trial; bestCost = c; improved = true; }
        }
        if (improved) console.log(`  ${k.padEnd(13)} ${best[k].toFixed(3).padStart(7)}   cost ${bestCost.toFixed(3)}`);
      }
    }
    console.log('\nsolved:');
    for (const k of keys) {
      const [lo, hi] = BOUNDS[k];
      const pinned = Math.abs(best[k] - lo) < 1e-6 || Math.abs(best[k] - hi) < 1e-6;
      console.log(`  ${k.padEnd(13)} ${best[k].toFixed(4)}${pinned ? '   <-- pinned against its bound; argue with this one' : ''}`);
    }
    Object.assign(P, best);
  }

  const model = modelProfile(P);
  console.log('\nband   reference          model            delta        spread ref / model');
  for (let i = 0; i < BANDS; i++) {
    const a = ref[i].rgb, b = model[i].rgb.map((v) => Math.round(v));
    const d = [0, 1, 2].map((k) => b[k] - a[k]);
    console.log(`${String(i).padStart(2)}   rgb(${a.map((v) => String(v).padStart(3)).join(',')})   rgb(${b.map((v) => String(v).padStart(3)).join(',')})  ${d.map((v) => (v > 0 ? '+' : '') + v).join(' ').padStart(12)}    ${ref[i].spread.toFixed(0).padStart(3)} / ${model[i].spread.toFixed(0).padStart(3)}`);
  }
  console.log(`\ncost ${cost(model, ref).toFixed(3)}`);
})();
