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
 * The band the key softens across.
 *
 * Tight, and it has to be, because of her hair. The ponytail runs from silver
 * through peach to pink, and pink hair is *near* the flood: sampled through the
 * nape and the ponytail, hair pixels sit 55 to 110 from the key while the flood
 * showing between the strands sits under 12. A tolerance loose enough to be
 * comfortable — the 60 this started at, let alone sakura's 105 — eats the
 * strands and hands back a ponytail full of ragged holes.
 *
 * Not a threshold — a ramp, and the difference is the whole of the girl's
 * outline. A threshold gives every pixel alpha 0 or alpha 1, so her silhouette
 * arrives at the screen as a one-bit staircase: the ジャギジャギ edge down her
 * arm, her hip and her ponytail. She was drawn with an antialiased outline, and
 * an antialiased outline is a *coverage* measurement — pixels that are part her
 * and part flood, at every fraction in between. Reading that fraction back is
 * what the ramp does.
 *
 * Below KEY_IN the pixel is flood; above KEY_OUT it is paint; between them the
 * position in the band is the paint's coverage. The old cut of 26 sits in the
 * middle of it, so nothing about *which* side of the argument a pixel lands on
 * has changed — only that the ones in the band now arrive as partial coverage
 * instead of being rounded. Her hair is still far outside: the strands sample
 * 55 to 110 and the flood between them under 12.
 */
const KEY_IN = 16, KEY_OUT = 36;
/** The cut, where a pixel is more flood than paint. Everything that reasons
 * about the matte as a region — the connected components, the geometry check —
 * uses this; only the compositing uses the ramp. */
const KEY_TOLERANCE = (KEY_IN + KEY_OUT) / 2;

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
  //
  // `paintCover` is the fraction of the pixel that is picture rather than
  // flood, read off the ramp; `water` is the same thing rounded, for everything
  // downstream that needs a region rather than a coverage.
  const paintCover = new Float32Array(W * H);
  const water = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const d = dist(keyed.data[i * C], keyed.data[i * C + 1], keyed.data[i * C + 2]);
    paintCover[i] = Math.min(1, Math.max(0, (d - KEY_IN) / (KEY_OUT - KEY_IN)));
    if (d < KEY_TOLERANCE) water[i] = 1;
  }

  // --- the spill, unmixed out of the edge -----------------------------------
  //
  // A hand key over an antialiased edge leaves a band of pixels that are part
  // flood and part girl, and their colour is the mixture: her skin pulled
  // toward magenta. Whatever the matte does with them, painting them as
  // observed puts a pink seam all the way round her.
  //
  // The band used to be taken out of the argument entirely — the water pulled
  // back a pixel and anything with a magenta cast inpainted from its
  // neighbours. That removes the seam by removing the edge: it fills her
  // outline with a guess and leaves the matte one-bit, which is the staircase.
  //
  // The mixture is a two-colour one and the key colour is known, so it can
  // simply be solved instead. Each pixel is C_obs = a*C_paint + (1-a)*KEY with
  // a already measured above, so C_paint = (C_obs - (1-a)*KEY) / a. The edge
  // comes back in her own colours, at its own coverage, and the flood behind it
  // is gone rather than averaged away — which is what an antialiased edge over
  // the live water needs to be.
  //
  // This is the unmixing the acrylic explicitly does *not* get (see below), and
  // the difference is that here the background is a flat colour that is not in
  // the painting, while there it is water the painter painted.
  const unmix = (i, a) => {
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = (keyed.data[i * C + k] - (1 - a) * KEY[k]) / a;
      out[k] = Math.min(255, Math.max(0, v));
    }
    return out;
  };

  // Only the flood itself, not every patch of that colour.
  //
  // The hand key ran over the edges of the girl — antialiased pixels along her
  // arm, her shoulder, a sock — which come back 5 to 12 from the key, which is
  // to say they *are* the flood colour and no threshold can tell them apart
  // from it. What tells them apart is size. The genuine gaps in her silhouette
  // are big: 4,070 px between her legs, and 629 to 927 px each for the four
  // openings around her nape and her ponytail, all of which are tank and have
  // to stay tank. The spill is 700-odd specks, almost all of them under 40 px.
  //
  // Cutting at 100 px separates the two cleanly — there is nothing between 160
  // and 629 to argue about. The dropped ones cannot simply be painted: painting
  // them means painting them *the flood colour*, which is how a magenta patch
  // ended up behind her hip. They are inpainted from their surroundings below.
  const MIN_COMPONENT = 100;
  const seen = new Uint8Array(W * H);
  const inpaint = new Uint8Array(W * H);
  let droppedPixels = 0, droppedIslands = 0;
  for (let start = 0; start < W * H; start++) {
    if (!water[start] || seen[start]) continue;
    const stack = [start], component = [];
    seen[start] = 1;
    while (stack.length) {
      const q = stack.pop();
      component.push(q);
      const x = q % W, y = (q / W) | 0;
      for (const n of [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, y > 0 ? q - W : -1, y < H - 1 ? q + W : -1]) {
        if (n >= 0 && water[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    if (component.length < MIN_COMPONENT) {
      for (const q of component) { water[q] = 0; paintCover[q] = 1; inpaint[q] = 1; }
      droppedPixels += component.length;
      droppedIslands++;
    }
  }
  console.log(`components   ${droppedIslands} specks (${droppedPixels} px) inpainted — the hand key over the girl's edges`);

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

  // --- the artwork's own jellyfish, taken out of the glass -------------------
  //
  // Everything inside the flood is drawn from the *artwork*, at the acrylic's
  // coverage — and the artwork still has the painted jellyfish in it. At
  // alpha 0.05 to 0.36 they are faint, but they are there, and they do not
  // move: a stationary ghost of a jellyfish sat in the top middle of the frame
  // while the live ones swam past behind it. Everything the plate contributes
  // inside the tank is meant to be the *glass*, which has no animals on it.
  //
  // Removed the same way the coverage baseline removes them: a grey-scale
  // opening wider than any bell, per channel, then a softening. The acrylic's
  // broad vertical bands and the water's own vertical gradient survive a
  // 26 px opening; a jellyfish does not.
  const glassRGB = [0, 1, 2].map((k) => {
    const ch = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) ch[i] = art.data[i * art.C + k];
    return blurXY(open(ch, W, H, 26), W, H, 9);
  });

  // The sparkle on the floor by her right shoe. It is a decoration the artwork
  // came with, not part of the room, and it is the one thing in the frame that
  // has no business being in a photograph of an aquarium. Detected rather than
  // boxed out: inside its own neighbourhood it is the only thing brighter than
  // 90 (the wet floor there sits at 13-52 and the star's centre at 155), so a
  // threshold finds it without touching the shoe beside it.
  let sparkle = 0;
  for (let y = 1118; y < 1168; y++) {
    for (let x = 816; x < 870; x++) {
      const i = y * W + x;
      const L = 0.2126 * keyed.data[i * C] + 0.7152 * keyed.data[i * C + 1] + 0.0722 * keyed.data[i * C + 2];
      if (L > 90) {
        // With a margin, so the star's own soft edge goes with it.
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const q = (y + dy) * W + (x + dx);
            if (q >= 0 && q < W * H && !inpaint[q] && !water[q]) { inpaint[q] = 1; sparkle++; }
          }
        }
      }
    }
  }
  console.log(`sparkle      ${sparkle} px removed from the floor`);

  // Fill the dropped islands from their surroundings, one dilation at a time,
  // so what shows there is her skin and her sock rather than the key.
  // --- the spill that is past unmixing --------------------------------------
  //
  // Unmixing handles the pixels the ramp calls partial. It is not the whole of
  // the spill: measured on the keyed file, the magenta cast (r+b)/2 - g runs
  // to a median of 38.5 in the first two pixels outside the matte and 16 in the
  // next two, against 4 in the picture at large. That is the flood glowing
  // several pixels into her through the source's own soft edges and its PNG
  // re-encoding, and no threshold on distance-to-key can reach it: those pixels
  // sit 60 to 90 from the key, which is where her pink hair also lives.
  //
  // So it is taken off by *distance to the matte* instead, and only the excess
  // is taken. The cap is the picture's own: away from the water 99.5% of pixels
  // are under a cast of 22.5, so anything above that within a couple of pixels
  // of the flood is the flood. Her hair keeps every bit of pink it has anywhere
  // else in the frame.
  const distToWater = new Int16Array(W * H).fill(999);
  for (let i = 0; i < W * H; i++) if (water[i]) distToWater[i] = 0;
  for (let r = 1; r <= 4; r++) {
    const ring = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (distToWater[i] !== 999) continue;
        for (const q of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
          if (q >= 0 && distToWater[q] === r - 1) { ring.push(i); break; }
        }
      }
    }
    for (const i of ring) distToWater[i] = r;
  }
  /** Cast the picture is allowed to have at each distance from the flood. */
  const CAST_CAP = [14, 14, 16, 20, 26];
  let despilled = 0;
  const despill = (rgb, i) => {
    const d = distToWater[i];
    if (d > 4) return rgb;
    const excess = (rgb[0] + rgb[2]) / 2 - rgb[1] - CAST_CAP[d];
    if (excess <= 0) return rgb;
    despilled++;
    return [Math.max(0, rgb[0] - excess), rgb[1], Math.max(0, rgb[2] - excess)];
  };

  // Which pixels were filled, kept because the fill loop clears the flag as it
  // goes: a filled pixel is fully painted whatever its coverage measured, since
  // what it measured was the key running over her.
  /*
   * Antialias the matte.
   *
   * Measured across her arm, the coverage went 6, 127, 255 in three
   * consecutive pixels: the ramp is *there* but it is one pixel wide, which is
   * a hard edge with a single grey pixel on it — and a hard edge on a figure
   * this size is the ジャギジャギ staircase down her arm and her ponytail.
   *
   * The ramp cannot simply be widened. It is held tight (KEY_IN/KEY_OUT above)
   * because her pink hair lives 55 to 110 from the key and a loose tolerance
   * eats the strands. What can be done instead is to reconstruct the coverage
   * the way an antialiased edge would have measured it: a one-pixel tent over
   * the coverage field. Away from an edge the field is flat 0 or flat 1 and a
   * blur changes nothing; across one it gives the two or three intermediate
   * values the silhouette needs to stop being a staircase.
   *
   * One pixel and no more. Two is a halo.
   */
  const softCover = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(H - 1, Math.max(0, y + dy));
          const xx = Math.min(W - 1, Math.max(0, x + dx));
          // A tent rather than a box: the centre pixel keeps most of its own
          // value, so a one-pixel feature is softened and not erased.
          const w = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
          sum += paintCover[yy * W + xx] * w;
          n += w;
        }
      }
      softCover[y * W + x] = sum / n;
    }
  }
  paintCover.set(softCover);

  const inpaintedAt = Uint8Array.from(inpaint);
  const paint = Buffer.from(keyed.data);
  for (let pass = 0; pass < 40; pass++) {
    let filled = 0;
    const todo = [];
    for (let i = 0; i < W * H; i++) {
      if (!inpaint[i]) continue;
      const x = i % W, y = (i / W) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (const q of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        // Fully painted neighbours only. A pixel still carrying part of the
        // flood would spread the very colour this is removing.
        if (q < 0 || inpaint[q] || paintCover[q] < 1) continue;
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
  let punched = 0, glassPixels = 0, softPixels = 0;
  for (let i = 0; i < W * H; i++) {
    let r, g, b, alpha;
    const a = inpaintedAt[i] ? 1 : paintCover[i];
    if (a > 0 && a < 1) {
      // Her outline. Two layers over one pixel: the picture at coverage `a`,
      // and behind it the water showing through the rest, itself veiled by
      // whatever acrylic stands there. Composited in that order and stored
      // straight (un-premultiplied), because effects/plateShader.ts mixes with
      // the plate's alpha rather than adding a premultiplied colour.
      const cover = cover2[i];
      const front = despill(unmix(i, a), i);
      const back = a + (1 - a) * cover;
      alpha = back;
      r = (a * front[0] + (1 - a) * cover * glassRGB[0][i]) / alpha;
      g = (a * front[1] + (1 - a) * cover * glassRGB[1][i]) / alpha;
      b = (a * front[2] + (1 - a) * cover * glassRGB[2][i]) / alpha;
      punched += 1 - alpha;
      softPixels++;
    } else if (a >= 1) {
      // Painted. From the keyed file, which is the only one the girl is in.
      [r, g, b] = despill([paint[i * C], paint[i * C + 1], paint[i * C + 2]], i);
      alpha = 1;
    } else {
      // The artwork's own pixels, unchanged. An earlier version un-mixed them
      // here — solving C_obs = cover*C_glass + (1-cover)*C_water for the glass
      // — which is the right thing to do in principle and the wrong thing to do
      // to a painting: it darkened the acrylic wherever the coverage was
      // partial, and the whole point of a plate is that the painted pixels
      // arrive at the screen as painted. Only the alpha is computed.
      const cover = cover2[i];
      r = glassRGB[0][i]; g = glassRGB[1][i]; b = glassRGB[2][i];
      if (cover > 0.004) glassPixels++;
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
  console.log(`soft edge    ${softPixels} px of antialiased outline unmixed off the key`);
  console.log(`despill      ${despilled} px within 4 px of the matte had the flood's cast taken off`);

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
