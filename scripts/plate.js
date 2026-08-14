#!/usr/bin/env node
/**
 * Builds the foreground plate: the illustration with the tank's water punched
 * out, so the live scene can be rendered behind it (plan.md §4).
 *
 * Everything that is not water stays as painted pixels at full alpha — the
 * room, the wall panels, the floor, the rim of the cylinder, and the girl
 * standing in front of it. The jellyfish and the water they hang in are removed
 * entirely; those are the engine's job.
 *
 * Two inputs, which is the arrangement sakura's scripts/plate.js calls ideal
 * and rarely got:
 *
 *  - the **keyed** file, with the water flooded flat by hand. The matte comes
 *    from this, which makes it an ordinary chroma key rather than the geometric
 *    matte this script used to build. A hand key knows the girl's pale hair
 *    from a pale jellyfish, and it knows her sleeve is not glass — neither of
 *    which any threshold on the artwork could tell reliably.
 *  - the **artwork**, the same composition without the girl, still carrying the
 *    acrylic. The flood covers the vertical highlights down the cylinder, so
 *    they cannot be recovered from the keyed file; they are measured from the
 *    artwork instead and re-applied as partial alpha (see below).
 *
 * The girl exists only in the keyed file, so every opaque pixel comes from
 * there. The artwork is consulted only inside the flood.
 *
 *   node scripts/plate.js --preview   # /tmp/plate-preview.png, over magenta
 *   node scripts/plate.js             # writes app/public/plate.webp
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { REF, tank } = require('./reference');

/** The hand-keyed file: the artwork with the water flooded, and the girl. */
const KEYED = path.join(__dirname, '..', '1786669093785.png');
const OUT = path.join(__dirname, '..', 'app', 'public', 'plate.webp');
const TANK = tank();

/** The flooded colour, taken as the modal pixel of the keyed image — 20.2% of
 * the frame on its own, with the next five modes the same colour ±2 from PNG
 * re-encoding, together another 29%. */
const KEY = [152, 59, 114];

/**
 * Everything within this distance of the key is water.
 *
 * Binary rather than a ramp, for the reason sakura found: a narrow tolerance
 * leaves a magenta rim wherever an antialiased edge meets the flood, and
 * nothing partially-keyed survives to be un-mixed.
 *
 * The value is what the girl allows. She is the tightest constraint in the
 * picture, not the tank: her hair sits 87 from the key and her shirt 85, so at
 * sakura's 105 she comes out full of holes. At 60 both survive with room, and
 * what is left over — the parts of her arm and socks that are *literally* the
 * flood colour, 5 and 12 away, where the hand key ran over her — is dealt with
 * by the component filter below rather than by the threshold.
 */
const KEY_TOLERANCE = 60;

const dist = (r, g, b) => Math.hypot(r - KEY[0], g - KEY[1], b - KEY[2]);

/** Separable box blur along x only, on a scalar field. Three passes is a good
 * enough gaussian, and the only thing it is used for is a baseline. */
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

/** Separable box blur in both axes. */
function blurXY(src, W, H, radius, passes = 2) {
  const a = blurX(src, W, H, radius, passes);
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

/** Grey-scale opening: erode then dilate, in a square window. Removes anything
 * *brighter* than its surroundings and narrower than the window — every
 * jellyfish, every mote of marine snow — while leaving the broad acrylic bands
 * and the water's own gradient where they are. */
function open(src, W, H, radius) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  const pass = (input, output, pick) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = pick === Math.min ? Infinity : -Infinity;
        for (let dx = -radius; dx <= radius; dx++) {
          v = pick(v, input[y * W + Math.min(W - 1, Math.max(0, x + dx))]);
        }
        output[y * W + x] = v;
      }
    }
    const col = new Float32Array(H);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) col[y] = output[y * W + x];
      for (let y = 0; y < H; y++) {
        let v = pick === Math.min ? Infinity : -Infinity;
        for (let dy = -radius; dy <= radius; dy++) v = pick(v, col[Math.min(H - 1, Math.max(0, y + dy))]);
        output[y * W + x] = v;
      }
    }
  };
  pass(src, tmp, Math.min);
  pass(tmp, out, Math.max);
  return out;
}

async function raw(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height, C: info.channels };
}

async function main() {
  const keyed = await raw(KEYED);
  const art = await raw(REF);
  const { W, H, C } = keyed;
  if (art.W !== W || art.H !== H) throw new Error('the keyed file and the artwork are different sizes');

  // --- the matte, from the hand key -----------------------------------------
  const water = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (dist(keyed.data[i * C], keyed.data[i * C + 1], keyed.data[i * C + 2]) < KEY_TOLERANCE) water[i] = 1;
  }

  // Only the flood itself, not every patch of that colour.
  //
  // The hand key ran over parts of the girl — her forearm, a shoulder, some
  // hair, one sock — which come back 5 to 12 from the key, which is to say they
  // *are* the flood colour and no threshold can tell them apart from it. What
  // tells them apart is where they sit: a piece of tank reaches the tank's own
  // edge, and a hole in the girl does not. So a small island is kept as water
  // only if it touches the silhouette scripts/geom.js measured — which keeps
  // the 4,070-px gap between her legs, where the tank really does show through
  // down to the base, and drops the four islands on her upper body.
  //
  // The dropped ones cannot simply be painted: painting them means painting
  // them *the flood colour*, which is how a magenta patch ended up behind her
  // hip. They are inpainted from their surroundings instead, below.
  const nearEdge = (x, y) => {
    const u = (x - TANK.x0) / TANK.R;
    if (Math.abs(u) > 0.995) return true;
    const f = Math.sqrt(Math.max(0, 1 - u * u));
    return Math.abs(y - (TANK.botYc + TANK.botB * f)) < 12
        || Math.abs(y - (TANK.topYc + TANK.topB * f)) < 12
        || Math.abs(Math.abs(x - TANK.x0) - TANK.R) < 12;
  };
  const MIN_COMPONENT = W * H * 0.005;
  const seen = new Uint8Array(W * H);
  const inpaint = new Uint8Array(W * H);
  let droppedPixels = 0, droppedIslands = 0;
  for (let start = 0; start < W * H; start++) {
    if (!water[start] || seen[start]) continue;
    const stack = [start], component = [];
    let touchesEdge = false;
    seen[start] = 1;
    while (stack.length) {
      const q = stack.pop();
      component.push(q);
      const x = q % W, y = (q / W) | 0;
      if (!touchesEdge && nearEdge(x, y)) touchesEdge = true;
      for (const n of [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, y > 0 ? q - W : -1, y < H - 1 ? q + W : -1]) {
        if (n >= 0 && water[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    if (component.length < MIN_COMPONENT && !touchesEdge) {
      for (const q of component) { water[q] = 0; inpaint[q] = 1; }
      droppedPixels += component.length;
      droppedIslands++;
    }
  }
  console.log(`components   ${droppedIslands} islands (${droppedPixels} px) inpainted — the hand key over the girl`);

  // --- the acrylic, separated from the water it is mixed with ---------------
  //
  // The vertical bands down the cylinder, and the bright rim at each side, are
  // what make the tank read as thick acrylic rather than as a hole in the
  // picture — and the flood covers them, so they come from the artwork.
  //
  // Work on luminance: the bands are achromatic veils over a blue field, so
  // their signature is a lift in brightness that barely moves the hue.
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    lum[i] = 0.2126 * art.data[i * art.C] + 0.7152 * art.data[i * art.C + 1] + 0.0722 * art.data[i * art.C + 2];
  }
  // Opening first, so no jellyfish reaches the baseline or the band; then a
  // softening, because a square structuring element leaves plateaus with square
  // corners and those tile the tank with faint rectangles.
  const opened = blurXY(open(lum, W, H, 26), W, H, 9);
  // The water on its own is smooth across the tank; the bands are not. So the
  // baseline is that field blurred hard in x, and the band is what stands above
  // it. Blurring in x only keeps the water's *vertical* gradient — which is
  // real, the light comes from above — out of the band.
  const base = blurX(opened, W, H, 60);

  /** Luminance lift, in 0-255, that a band has to reach to count as fully
   * covering acrylic, and the level below which it is the water's own
   * mottling. */
  const FULL = 55, FLOOR = 6;
  const coverage = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    coverage[i] = Math.min(1, Math.max(0, (opened[i] - base[i] - FLOOR) / (FULL - FLOOR)));
  }
  const cover2 = blurXY(coverage, W, H, 13);

  // Fill the dropped islands from their surroundings, one dilation at a time,
  // so what shows there is her skin and her sock rather than the key.
  const paint = Buffer.from(keyed.data);
  for (let pass = 0; pass < 40; pass++) {
    let filled = 0;
    const todo = [];
    for (let i = 0; i < W * H; i++) {
      if (!inpaint[i]) continue;
      const x = i % W, y = (i / W) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (const q of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (q < 0 || inpaint[q] || water[q]) continue;
        r += paint[q * C]; g += paint[q * C + 1]; b += paint[q * C + 2]; n++;
      }
      if (n) todo.push([i, r / n, g / n, b / n]);
    }
    for (const [i, r, g, b] of todo) {
      paint[i * C] = r; paint[i * C + 1] = g; paint[i * C + 2] = b;
      inpaint[i] = 0;
      filled++;
    }
    if (!filled) break;
  }

  const rgba = Buffer.alloc(W * H * 4);
  let punched = 0, glassPixels = 0;
  for (let i = 0; i < W * H; i++) {
    let r, g, b, alpha;
    if (!water[i]) {
      // Painted. From the keyed file, which is the only one the girl is in.
      r = paint[i * C]; g = paint[i * C + 1]; b = paint[i * C + 2];
      alpha = 1;
    } else {
      const cover = cover2[i];
      // Un-mix: C_obs = cover*C_glass + (1-cover)*C_water, with C_water taken as
      // the observed colour scaled to the baseline luminance. The water is one
      // hue, so a luminance scale describes it and avoids smearing chroma
      // across the tank.
      const ar = art.data[i * art.C], ag = art.data[i * art.C + 1], ab = art.data[i * art.C + 2];
      if (cover > 0.004) {
        const wScale = base[i] / Math.max(1e-3, opened[i]);
        const un = (c) => (c - (1 - cover) * c * wScale) / cover;
        r = un(ar); g = un(ag); b = un(ab);
        glassPixels++;
      } else {
        r = ar; g = ag; b = ab;
      }
      alpha = cover;
      punched += 1 - alpha;
    }
    rgba[i * 4] = Math.min(255, Math.max(0, Math.round(r)));
    rgba[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(g)));
    rgba[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(b)));
    rgba[i * 4 + 3] = Math.round(alpha * 255);
  }

  console.log(`keyed        ${(100 * water.reduce((a, b) => a + b, 0) / (W * H)).toFixed(1)}% of the frame is water`);
  console.log(`punched      ${(100 * punched / (W * H)).toFixed(1)}% fully open`);
  console.log(`part-alpha   ${(100 * glassPixels / (W * H)).toFixed(1)}% carries acrylic`);

  // A sanity check against the measured geometry, not a matte: if the hand key
  // and scripts/geom.js disagree about where the tank is, one of them is
  // looking at a different picture.
  let inside = 0, insideKeyed = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x - TANK.x0) / (TANK.R - 40);
      if (Math.abs(u) >= 1) continue;
      const f = Math.sqrt(Math.max(0, 1 - u * u));
      if (y < TANK.topYc + TANK.topB * f + 40 || y > TANK.botYc + TANK.botB * f - 60) continue;
      inside++;
      if (water[y * W + x]) insideKeyed++;
    }
  }
  console.log(`agreement    ${(100 * insideKeyed / inside).toFixed(1)}% of the measured tank interior is keyed`);

  if (process.argv.includes('--preview')) {
    // Over magenta, which nothing in the picture is, so any leak is obvious.
    const pv = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const a = rgba[i * 4 + 3] / 255;
      pv[i * 3] = rgba[i * 4] * a + 255 * (1 - a);
      pv[i * 3 + 1] = rgba[i * 4 + 1] * a;
      pv[i * 3 + 2] = rgba[i * 4 + 2] * a + 255 * (1 - a);
    }
    await sharp(pv, { raw: { width: W, height: H, channels: 3 } }).png().toFile('/tmp/plate-preview.png');
    console.log('wrote /tmp/plate-preview.png');
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .webp({ quality: 92, alphaQuality: 100 }).toFile(OUT);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}
main();
