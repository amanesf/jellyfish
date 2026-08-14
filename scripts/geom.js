#!/usr/bin/env node
/**
 * Measures the tank's geometry out of the reference image, and draws it back
 * over the picture so the fit can be checked.
 *
 * plan.md §9 phase 5: the cylinder's radius, its two ellipses and the camera
 * that sees them are not allowed to be "about here" numbers. They come from
 * edges found in the reference, and the overlay this writes is the check that
 * they landed on the paint.
 *
 * The tank is a vertical cylinder, so its top and bottom circles project to
 * two ellipses that share a vertical axis and a semi-major axis (the tank's
 * screen radius). Four numbers therefore describe the whole silhouette:
 * x0, R, and each ellipse's centre row and semi-minor axis.
 *
 *   node scripts/geom.js            # print the fit
 *   node scripts/geom.js --overlay  # + /tmp/geom.png with the fit drawn on
 *   node scripts/geom.js --write    # + scripts/tank.json, which everything reads
 */
const sharp = require('sharp');
const fs = require('fs');
const { REF, TANK_FILE } = require('./reference');

/** Blueness, which is what separates lit water from the unlit room far more
 * cleanly than luminance does — the room is dark *and* blue, but never this
 * blue (see the traces in the commit that added this file). */
const blueness = (r, g, b) => b - r;

async function main() {
  const { data, info } = await sharp(REF).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const bl = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) bl[i] = blueness(data[i * C], data[i * C + 1], data[i * C + 2]);

  // A column of the blueness field, smoothed, so a single painted highlight
  // does not read as an edge.
  const smoothRow = (y) => {
    const row = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -4; dy <= 4; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        s += bl[yy * W + x]; n++;
      }
      row[x] = s / n;
    }
    return row;
  };

  // --- side edges -----------------------------------------------------------
  // Taken over the rows where the room behind the tank is dark on both sides
  // (above the side tanks' glow), which is where the step is unambiguous.
  const lefts = [], rights = [];
  for (let y = 200; y <= 460; y += 4) {
    const row = smoothRow(y);
    let bestL = 0, bestLx = -1, bestR = 0, bestRx = -1;
    for (let x = 40; x < 200; x++) {
      const d = row[x + 6] - row[x - 6];
      if (d > bestL) { bestL = d; bestLx = x; }
    }
    for (let x = W - 200; x < W - 40; x++) {
      const d = row[x - 6] - row[x + 6];
      if (d > bestR) { bestR = d; bestRx = x; }
    }
    if (bestLx > 0) lefts.push(bestLx);
    if (bestRx > 0) rights.push(bestRx);
  }
  const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  const xL = median(lefts), xR = median(rights);
  const x0 = (xL + xR) / 2, R = (xR - xL) / 2;

  // --- silhouette, for the two ellipses -------------------------------------
  // The topmost and bottommost blue pixel of each column inside the tank. The
  // top silhouette is the top circle's *far* arc (highest at the centre); the
  // bottom silhouette is the bottom circle's *near* arc (lowest at the centre).
  /** Lit glass: blue *and* bright. The unlit room is blue too — b-r reaches 44
   * at the top of the frame — so blueness alone puts the silhouette on row 1. */
  const lit = (x, y) => {
    const p = (y * W + x) * C;
    return data[p + 2] - data[p] > 60 && data[p + 2] > 90;
  };
  const topY = new Float32Array(W).fill(NaN), botY = new Float32Array(W).fill(NaN);
  for (let x = Math.ceil(xL) + 6; x <= Math.floor(xR) - 6; x++) {
    for (let y = 0; y < H; y++) if (lit(x, y)) { topY[x] = y; break; }
    // The foot of the water is *not* the bottommost lit pixel. Below the base
    // the polished floor carries a reflection of the tank that is every bit as
    // blue and as bright as the tank itself, and taking the last lit row put
    // the bottom ellipse's semi-minor axis at 2.7 px — a flat line, and a
    // camera solved from it that sat 17 radii away through an 11-degree lens.
    //
    // What separates them is the base: a dark band under the glass, in every
    // column. So the foot of the water is the end of the *last* lit run that
    // begins above the base — the reflection's own run begins below it.
    //
    // Neither simpler rule works. The bottommost lit pixel lands in the
    // reflection and flattens the ellipse to a 2.7 px semi-minor axis (a
    // camera 17 radii away through an 11-degree lens); the first dark run
    // lands at row 250, in the dark water at the left of the picture.
    if (!Number.isFinite(topY[x])) continue;
    let run = 0;
    for (let y = Math.round(topY[x]); y < H; y++) {
      if (lit(x, y)) {
        run++;
      } else {
        // A run counts as the tank's foot only if it is tall enough to be
        // water and starts above the base; the mirrored tank on the floor
        // below fails the second test, which is what separates them.
        if (run >= 25 && y - run < H * 0.9) botY[x] = y - 1;
        run = 0;
      }
    }
  }

  /** Fit `yc ± b*sqrt(1-u^2)` to a silhouette by least squares on (u, y). */
  const fitArc = (ys, sign, xlo, xhi) => {
    let sa = 0, sb = 0, sab = 0, saa = 0, n = 0;
    for (let x = xlo; x <= xhi; x++) {
      const y = ys[x];
      if (!Number.isFinite(y)) continue;
      const u = (x - x0) / R;
      if (Math.abs(u) > 0.98) continue;
      const f = sign * Math.sqrt(1 - u * u);
      sa += f; sb += y; sab += f * y; saa += f * f; n++;
    }
    const b = (n * sab - sa * sb) / (n * saa - sa * sa);
    const yc = (sb - b * sa) / n;
    return { yc, b: b * sign, n };
  };
  const top = fitArc(topY, -1, Math.ceil(xL) + 8, Math.floor(xR) - 8);
  const bot = fitArc(botY, +1, Math.ceil(xL) + 8, Math.floor(xR) - 8);

  const fmt = (v) => v.toFixed(1);
  console.log(`frame        ${W}x${H}`);
  console.log(`side edges   xL=${fmt(xL)} xR=${fmt(xR)}  (spread ${fmt(Math.max(...lefts) - Math.min(...lefts))}/${fmt(Math.max(...rights) - Math.min(...rights))})`);
  console.log(`cylinder     x0=${fmt(x0)} R=${fmt(R)}`);
  console.log(`top ellipse  yc=${fmt(top.yc)} b=${fmt(top.b)}  (n=${top.n})`);
  console.log(`bot ellipse  yc=${fmt(bot.yc)} b=${fmt(bot.b)}  (n=${bot.n})`);
  console.log(`aspect       b/R top ${(top.b / R).toFixed(3)}  bottom ${(bot.b / R).toFixed(3)}`);

  // --- the camera that sees those ellipses ----------------------------------
  //
  // Solved, not chosen. A horizontal circle of radius r whose centre sits a
  // vertical distance z from the eye projects to an ellipse whose axis ratio is
  // sin(elevation) = z / hypot(d, z), so each ellipse gives its own z/d, and the
  // gap between the two ellipse centres in the image gives the focal length:
  //
  //   y = cy - f*z/d   =>   yBot - yTop = f*(zTop + zBot)/d
  //
  // Everything is expressed in tank radii, because the scene has no other
  // length scale — app/src/core/tank.ts places the cylinder at radius 1.
  const zOverD = (ratio) => ratio / Math.sqrt(1 - ratio * ratio);
  const zTop = zOverD(Math.abs(top.b) / R);   // eye is this far *below* the top rim
  const zBot = zOverD(Math.abs(bot.b) / R);   // ...and this far above the floor
  const f = (bot.yc - top.yc) / (zTop + zBot);
  const d = f / R;                            // eye distance, in tank radii
  const height = (zTop + zBot) * d;           // tank height, in tank radii
  const eyeAboveFloor = zBot * d;
  const cy = top.yc + f * zTop;               // principal point, in image rows
  const fovY = 2 * Math.atan(H / 2 / f) * 180 / Math.PI;
  console.log(`camera       f=${fmt(f)}px  fovY=${fovY.toFixed(2)}deg  cy=${fmt(cy)} (frame centre ${H / 2})`);
  console.log(`in radii     eyeDistance=${d.toFixed(3)}  tankHeight=${height.toFixed(3)}  eyeAboveFloor=${eyeAboveFloor.toFixed(3)}`);

  // --- the standpipe ---------------------------------------------------------
  // It has no silhouette against the room, so it is measured where it *does*
  // give an edge: down the middle of the tank, in a median-of-column profile
  // that the jellyfish cannot move. On the axis a screen half-width converts
  // straight to a radius, r = halfWidth * eyeDistance / focal.
  const colMedian = new Float32Array(W).fill(NaN);
  for (let x = Math.round(x0) - 140; x <= Math.round(x0) + 140; x++) {
    const col = [];
    for (let y = Math.round(top.yc) + 120; y < Math.round(bot.yc) - 120; y += 2) {
      const p = (y * W + x) * C;
      col.push(0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]);
    }
    col.sort((a, b) => a - b);
    colMedian[x] = col[col.length >> 1];
  }
  const edge = (lo, hi) => {
    let best = 0, bestX = NaN;
    for (let x = lo; x <= hi; x++) {
      const g = Math.abs(colMedian[x + 6] - colMedian[x - 6]);
      if (Number.isFinite(g) && g > best) { best = g; bestX = x; }
    }
    return bestX;
  };
  const pipeL = edge(Math.round(x0) - 130, Math.round(x0) - 20);
  const pipeR = edge(Math.round(x0) + 20, Math.round(x0) + 130);
  const pipeRadius = ((pipeR - pipeL) / 2) * d / f;
  console.log(`standpipe    edges ${pipeL} / ${pipeR}  ->  radius ${pipeRadius.toFixed(4)} tank radii`);

  if (process.argv.includes('--write')) {
    fs.writeFileSync(TANK_FILE, JSON.stringify({
      frame: { width: W, height: H },
      x0, R,
      topYc: top.yc, topB: Math.abs(top.b),
      botYc: bot.yc, botB: Math.abs(bot.b),
      focal: f, principalY: cy,
      eyeDistance: d, tankHeight: height, eyeHeight: eyeAboveFloor,
      pipeRadius,
    }, null, 2) + '\n');
    console.log(`wrote ${TANK_FILE}`);

    // The app reads the same numbers, generated rather than transcribed: a
    // measurement copied by hand into a source file is a measurement that will
    // still be there after the reference is replaced (scripts/reference.js).
    const ts = `// Generated by scripts/geom.js — do not edit by hand.
//
// The tank, measured off ${require('path').basename(REF)}. Rerun
// \`node scripts/geom.js --write\` after replacing the reference.
export const MEASURED = {
  /** The reference frame. Every fitted constant in this project is in these
   * pixels (scripts/README.md). */
  frameWidth: ${W},
  frameHeight: ${H},
  /** The cylinder's screen axis and radius. */
  x0: ${x0.toFixed(2)},
  R: ${R.toFixed(2)},
  /** The two ellipses: centre row, and semi-minor axis. */
  topYc: ${top.yc.toFixed(2)},
  topB: ${Math.abs(top.b).toFixed(2)},
  botYc: ${bot.yc.toFixed(2)},
  botB: ${Math.abs(bot.b).toFixed(2)},
  /** Focal length in frame pixels and the principal point's row, solved from
   * the ellipses rather than picked. */
  focal: ${f.toFixed(1)},
  principalY: ${cy.toFixed(1)},
  /** In tank radii — the scene has no other length scale. */
  eyeDistance: ${d.toFixed(3)},
  tankHeight: ${height.toFixed(3)},
  eyeHeight: ${eyeAboveFloor.toFixed(3)},
  /** The standpipe, from its edges in a median-of-column profile. */
  pipeRadius: ${pipeRadius.toFixed(3)},
} as const;
`;
    fs.writeFileSync(require('path').join(__dirname, '..', 'app', 'src', 'core', 'measured.ts'), ts);
    console.log('wrote app/src/core/measured.ts');
  }

  if (process.argv.includes('--overlay')) {
    const out = Buffer.from(data.subarray(0, W * H * C));
    const dot = (x, y, c) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const p = (y * W + x) * C;
      out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2];
    };
    for (let x = Math.ceil(xL); x <= Math.floor(xR); x++) {
      const u = (x - x0) / R, f = Math.sqrt(Math.max(0, 1 - u * u));
      for (const [yc, b, col] of [[top.yc, top.b, [255, 60, 60]], [bot.yc, bot.b, [60, 255, 120]]]) {
        for (const s of [-1, 1]) for (let t = -1; t <= 1; t++) dot(x, yc + s * b * f + t, col);
      }
    }
    for (let y = 0; y < H; y++) for (const x of [xL, xR]) for (let t = -1; t <= 1; t++) dot(x + t, y, [255, 255, 0]);
    await sharp(out, { raw: { width: W, height: H, channels: C } })
      .png().toFile('/tmp/geom.png');
    console.log('wrote /tmp/geom.png');
  }
}
main();
