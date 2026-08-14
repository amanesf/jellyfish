#!/usr/bin/env node
/**
 * The water's colour, band by band down the tank — the statistic the render's
 * water is fitted against (plan.md §7, §9 acceptance).
 *
 * sakura's scripts/skyprofile.js does the same job for a sky, and for the same
 * reason: "the water looks too bright" is not something anyone can act on, but
 * "band 3 is 41 sRGB above the reference and band 11 is 6 below, so the falloff
 * is too weak and the gain too high" is.
 *
 * Only *water* pixels count. The jellyfish and the marine snow are removed by a
 * grey-scale opening (anything brighter than its surroundings and narrower than
 * the window), and the acrylic highlights by taking the median of each band
 * rather than its mean — the bands are a minority of any row.
 *
 *   node scripts/waterprofile.js 1786664132447.png /tmp/shot.png [--bands 13]
 */
const sharp = require('sharp');
const { tank } = require('./reference');

const TANK = tank();

function openMin(lum, W, H, radius) {
  // Erode only: for *removing* bright things before a median, the dilate half
  // of an opening is not needed and would drag the bands back in.
  const out = new Float32Array(W * H);
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = Infinity;
      for (let d = -radius; d <= radius; d++) v = Math.min(v, lum[y * W + Math.min(W - 1, Math.max(0, x + d))]);
      tmp[y * W + x] = v;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let v = Infinity;
      for (let d = -radius; d <= radius; d++) v = Math.min(v, tmp[Math.min(H - 1, Math.max(0, y + d)) * W + x]);
      out[y * W + x] = v;
    }
  }
  return out;
}

async function profile(file, bands) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  if (W !== TANK.frame.width || H !== TANK.frame.height) {
    throw new Error(`${file} is ${W}x${H}, not the reference frame`);
  }
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    lum[i] = 0.2126 * data[i * C] + 0.7152 * data[i * C + 1] + 0.0722 * data[i * C + 2];
  }
  const floorField = openMin(lum, W, H, 14);

  const rows = [];
  for (let band = 0; band < bands; band++) {
    const bucket = [[], [], []];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x - TANK.x0) / (TANK.R - 40);
        if (Math.abs(u) >= 1) continue;
        const f = Math.sqrt(Math.max(0, 1 - u * u));
        const top = TANK.topYc + TANK.topB * f + 30;
        const bot = TANK.botYc + TANK.botB * f - 60;
        if (y <= top || y >= bot) continue;
        const t = (y - top) / (bot - top);
        if (Math.floor(t * bands) !== band) continue;
        const i = y * W + x;
        // Anything more than a little above its own eroded floor is a jellyfish,
        // a mote, or an acrylic band. It is not water.
        if (lum[i] - floorField[i] > 7) continue;
        for (let k = 0; k < 3; k++) bucket[k].push(data[i * C + k]);
      }
    }
    const med = bucket.map((a) => {
      a.sort((p, q) => p - q);
      return a.length ? a[a.length >> 1] : NaN;
    });
    // Median alone is not enough, and this project found that out the hard
    // way: a first render matched the reference's median down every band to
    // RMSE 4.8 while looking obviously wrong, because its water was the *same
    // colour everywhere* and the reference's is shot through with shafts. So
    // the spread of each band is reported beside its centre — that is the
    // statistic the light shafts actually live in.
    const ls = bucket[0].map((_, i) => 0.2126 * bucket[0][i] + 0.7152 * bucket[1][i] + 0.0722 * bucket[2][i]);
    ls.sort((p, q) => p - q);
    const at = (q) => (ls.length ? ls[Math.min(ls.length - 1, Math.floor(q * ls.length))] : NaN);
    rows.push({ band, n: bucket[0].length, rgb: med, p10: at(0.1), p90: at(0.9) });
  }
  return rows;
}

(async () => {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const bandsArg = process.argv.indexOf('--bands');
  const bands = bandsArg > 0 ? Number(process.argv[bandsArg + 1]) : 13;
  const [refFile, renderFile] = files;
  const ref = await profile(refFile, bands);
  const render = renderFile ? await profile(renderFile, bands) : null;

  console.log('band   depth      reference          render          delta        p10-p90 ref / render');
  let sq = 0, n = 0;
  for (let i = 0; i < bands; i++) {
    const a = ref[i].rgb;
    const label = `${String(i).padStart(2)}  ${((i + 0.5) / bands).toFixed(2)}   rgb(${a.map((v) => String(v).padStart(3)).join(',')})`;
    if (!render) { console.log(label); continue; }
    const b = render[i].rgb;
    const d = [0, 1, 2].map((k) => b[k] - a[k]);
    for (const v of d) { sq += v * v; n++; }
    const spread = `${(ref[i].p90 - ref[i].p10).toFixed(0).padStart(3)} / ${(render[i].p90 - render[i].p10).toFixed(0).padStart(3)}`;
    console.log(`${label}   rgb(${b.map((v) => String(v).padStart(3)).join(',')})   ${d.map((v) => (v > 0 ? '+' : '') + v).join(' ').padStart(14)}   ${spread}`);
  }
  if (render) console.log(`\nRMSE ${Math.sqrt(sq / n).toFixed(2)}  (acceptance: under 5)`);
})();
