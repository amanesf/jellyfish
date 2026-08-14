#!/usr/bin/env node
/**
 * Builds the foreground plate: the reference illustration with the *water* of
 * the tank punched out, so the live scene can be rendered behind it (plan.md
 * §4).
 *
 * Everything that is not water stays as painted pixels at full alpha — the
 * room, the side tanks, the visitors, the floor, the rim of the cylinder and
 * the water's own top surface. The jellyfish and the water they hang in are
 * removed entirely; those are the engine's job.
 *
 * Two things make this different from sakura's scripts/plate.js, which keyed a
 * hand-flooded copy of its reference:
 *
 *  - **The matte is geometric.** The punch-out is the inside of a cylinder, and
 *    scripts/geom.js has already measured that cylinder off the paint. Colour
 *    cannot do this job here: the room behind the tank is dark *blue*, the side
 *    tanks are lit blue, and a threshold that keeps the water keeps them too.
 *
 *  - **The acrylic survives as partial alpha.** The vertical white bands down
 *    the cylinder, and the bright rim at each side, are what make the tank read
 *    as thick acrylic rather than as a hole in the picture. They are
 *    `water x glass` mixtures, so they are separated here rather than kept or
 *    dropped: the band is measured as the part of the water's colour that is
 *    coherent down a column, the mix is inverted to recover the glass's own
 *    colour, and the coverage becomes the plate's alpha.
 *
 *   node scripts/plate.js --preview   # /tmp/plate-preview.png, over magenta
 *   node scripts/plate.js             # writes app/public/plate.webp
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const { REF, tank } = require('./reference');
const OUT = path.join(__dirname, '..', 'app', 'public', 'plate.webp');

/** The tank, as measured by scripts/geom.js into scripts/tank.json. */
const TANK = tank();

/**
 * How far inside the silhouette the punch-out stops, in pixels.
 *
 * Not a safety margin against a bad fit — the fit lands on the paint. It is
 * the acrylic wall itself: at the edge of a cylinder you are looking *along*
 * the wall, through 15-odd pixels of solid material that no amount of alpha
 * blending will make behave like water. Keeping the painted edge keeps the
 * refraction the artist already drew there.
 */
const WALL = 14;

/** The same clearance at the foot of the tank, where the painted shadow of the
 * base disc needs to stay painted. */
const BASE = 34;

/** Where the water begins under the top surface, and ends above the base.
 * The two arcs are the near halves of the measured ellipses. */
const waterTop = (u) => TANK.topYc + TANK.topB * Math.sqrt(Math.max(0, 1 - u * u));
const waterBot = (u) => TANK.botYc + TANK.botB * Math.sqrt(Math.max(0, 1 - u * u));

/** Smoothstep, for the one-pixel feather on the geometric edges. */
const feather = (edge, x) => {
  const t = Math.min(1, Math.max(0, (x - edge) / 1.5 + 0.5));
  return t * t * (3 - 2 * t);
};

/** Separable box blur along x only, on a scalar field. Repeated three times it
 * is a good enough gaussian, and the only thing it is used for is a baseline. */
function blurX(src, W, H, radius, passes = 3) {
  let a = Float32Array.from(src), b = new Float32Array(W * H);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += a[row + Math.min(W - 1, Math.max(0, x))];
      const n = radius * 2 + 1;
      for (let x = 0; x < W; x++) {
        b[row + x] = sum / n;
        sum -= a[row + Math.min(W - 1, Math.max(0, x - radius))];
        sum += a[row + Math.min(W - 1, Math.max(0, x + radius + 1))];
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

/** Separable box blur in both axes, for softening a coverage field. */
function blurXY(src, W, H, radius, passes = 2) {
  let a = blurX(src, W, H, radius, passes);
  const col = new Float32Array(H);
  for (let p = 0; p < passes; p++) {
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) col[y] = a[y * W + x];
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += col[Math.min(H - 1, Math.max(0, y))];
      const n = radius * 2 + 1;
      for (let y = 0; y < H; y++) {
        a[y * W + x] = sum / n;
        sum -= col[Math.min(H - 1, Math.max(0, y - radius))];
        sum += col[Math.min(H - 1, Math.max(0, y + radius + 1))];
      }
    }
  }
  return a;
}

/** Marks every pixel enclosed by the mask as part of it, by filling *inwards*
 * from the frame's border through everything unmasked: whatever the border
 * cannot reach is surrounded. (sakura's scripts/plate.js does the same.) */
function fillEnclosed(mask, W, H) {
  const outside = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => {
    const p = y * W + x;
    if (!mask[p] && !outside[p]) { outside[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % W, y = (p / W) | 0;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }
  for (let p = 0; p < W * H; p++) if (!outside[p]) mask[p] = 1;
}

/** Grey-scale opening: erode then dilate, in a square window. Removes anything
 * *brighter* than its surroundings and narrower than the window — every
 * jellyfish, every mote of marine snow — while leaving the broad bands and the
 * water's own gradient where they are. */
function open(src, W, H, radius) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  const pass = (input, output, pick) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = pick === Math.min ? Infinity : -Infinity;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = Math.min(W - 1, Math.max(0, x + dx));
          v = pick(v, input[y * W + xx]);
        }
        output[y * W + x] = v;
      }
    }
    const col = new Float32Array(H);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) col[y] = output[y * W + x];
      for (let y = 0; y < H; y++) {
        let v = pick === Math.min ? Infinity : -Infinity;
        for (let dy = -radius; dy <= radius; dy++) {
          v = pick(v, col[Math.min(H - 1, Math.max(0, y + dy))]);
        }
        output[y * W + x] = v;
      }
    }
  };
  pass(src, tmp, Math.min);
  pass(tmp, out, Math.max);
  return out;
}

async function main() {
  const { data, info } = await sharp(REF).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;

  // --- the geometric matte --------------------------------------------------
  // 1 where the engine's water shows through, 0 where the painting stays.
  const water = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5 - TANK.x0) / (TANK.R - WALL);
      if (Math.abs(u) >= 1) continue;
      const top = waterTop(u * (TANK.R - WALL) / TANK.R) + WALL * 0.5;
      // More clearance at the bottom than at the sides: the base disc carries a
      // painted shadow line where the glass meets it, and punching into it
      // leaves a ragged black fringe that the foreground rule below then keeps.
      const bot = waterBot(u * (TANK.R - WALL) / TANK.R) - BASE;
      const inside = Math.min(
        feather(top, y),
        feather(y, bot),
        feather(Math.abs(x + 0.5 - TANK.x0), TANK.R - WALL),
      );
      water[y * W + x] = inside;
    }
  }

  // --- what stands in front of the tank -------------------------------------
  //
  // The visitors at the bottom of the frame are *inside* the cylinder in image
  // space and in front of it in the world, so the geometric matte punches them
  // out. They come back here: against lit water a silhouette is both far darker
  // and far less blue than anything in the tank (measured: L 17-25 and b-r
  // 29-33 through the near visitor, against L 68 and b-r 99 for the water
  // beside him), which separates them without a hand-drawn mask.
  //
  // Small dark specks pass that test too — gaps between tentacles, the darker
  // side of the central pipe — so only components big enough to be a person are
  // kept, and their enclosed holes are filled so a shirt highlight cannot punch
  // a window through someone's back.
  const solid = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (water[i] < 0.5) continue;
    const r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
    if (0.2126 * r + 0.7152 * g + 0.0722 * b < 45 && b - r < 55) solid[i] = 1;
  }
  const MIN_AREA = 800;
  const seen = new Uint8Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (!solid[start] || seen[start]) continue;
    const stack = [start], component = [];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      component.push(p);
      const x = p % W, y = (p / W) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && solid[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (component.length < MIN_AREA) for (const p of component) solid[p] = 0;
  }
  fillEnclosed(solid, W, H);

  // --- the acrylic, separated from the water it is mixed with ---------------
  //
  // Work on luminance: the bands are achromatic veils over a blue field, so
  // their signature is a lift in brightness that does not move the hue much.
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    lum[i] = 0.2126 * data[i * C] + 0.7152 * data[i * C + 1] + 0.0722 * data[i * C + 2];
  }
  // Opening first, so no jellyfish reaches the baseline or the band.
  // Softened after the opening: a square structuring element leaves plateaus
  // with square corners, and those tile the tank with faint rectangles once the
  // baseline is subtracted. The bands are two orders of magnitude wider than
  // this blur, so nothing real is lost.
  const opened = blurXY(open(lum, W, H, 26), W, H, 9);
  // The water on its own is smooth across the tank; the bands are not. So the
  // baseline is the opened field blurred hard in x, and the band is what stands
  // above it. Blurring in x only keeps the water's *vertical* gradient — which
  // is real, the light comes from above — out of the band.
  const base = blurX(opened, W, H, 60);

  /** Luminance lift, in 0-255, that a band has to reach to count as fully
   * covering acrylic. Measured: the brightest band centres sit ~55 above their
   * local baseline, the faint inner ones ~15, and the water's own mottling
   * stays under 6. */
  const FULL = 55, FLOOR = 6;

  // The opening's window is square, so its output has square corners, and a
  // coverage field taken straight from it tiles the tank with faint rectangles.
  // Blurring the coverage — not the luminance it came from — removes them
  // without softening the bands themselves, which are far wider than this.
  const coverage = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    coverage[i] = Math.min(1, Math.max(0, (opened[i] - base[i] - FLOOR) / (FULL - FLOOR)));
  }
  const cover2 = blurXY(coverage, W, H, 13);

  const rgba = Buffer.alloc(W * H * 4);
  let punched = 0, glassPixels = 0;
  for (let i = 0; i < W * H; i++) {
    const inWater = solid[i] ? 0 : water[i];
    let r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
    let alpha = 1 - inWater;
    if (inWater > 0) {
      const cover = cover2[i];
      // Un-mix: C_obs = cover*C_glass + (1-cover)*C_water, and C_water is the
      // baseline colour at this pixel, taken as the observed colour scaled to
      // the baseline luminance (the water is one hue, so a luminance scale is
      // enough to describe it and avoids blurring the chroma across the tank).
      if (cover > 0.004) {
        const wScale = base[i] / Math.max(1e-3, opened[i]);
        const un = (c) => (c - (1 - cover) * c * wScale) / cover;
        r = un(r); g = un(g); b = un(b);
        glassPixels++;
      }
      alpha = Math.max(alpha, cover * inWater);
      punched += 1 - alpha;
    }
    rgba[i * 4] = Math.min(255, Math.max(0, Math.round(r)));
    rgba[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(g)));
    rgba[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(b)));
    rgba[i * 4 + 3] = Math.round(alpha * 255);
  }

  console.log(`punched      ${(100 * punched / (W * H)).toFixed(1)}% of the frame`);
  console.log(`part-alpha   ${(100 * glassPixels / (W * H)).toFixed(1)}% carries acrylic`);

  if (process.argv.includes('--preview')) {
    // Over magenta, which nothing in the picture is, so any leak is obvious.
    const pv = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const a = rgba[i * 4 + 3] / 255;
      pv[i * 3] = rgba[i * 4] * a + 255 * (1 - a);
      pv[i * 3 + 1] = rgba[i * 4 + 1] * a + 0 * (1 - a);
      pv[i * 3 + 2] = rgba[i * 4 + 2] * a + 255 * (1 - a);
    }
    await sharp(pv, { raw: { width: W, height: H, channels: 3 } })
      .png().toFile('/tmp/plate-preview.png');
    console.log('wrote /tmp/plate-preview.png');
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .webp({ quality: 92, alphaQuality: 100 }).toFile(OUT);
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${kb} KB)`);
}
main();
