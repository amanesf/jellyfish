#!/usr/bin/env node
/**
 * sRGB <-> linear-HDR conversion through the exact output chain the renderer
 * applies (three.js ACESFilmicToneMapping at toneMappingExposure=1.0, then
 * sRGB encode, both in core/postFx.ts's OutputPass).
 *
 * Every colour constant in scene/ramps.ts and scene/water.ts is authored in *pre-
 * tonemap linear HDR*, but every target taken off the reference image is in
 * display sRGB. Converting by hand is where several of these constants went
 * wrong before — a value picked to "look like" sRGB(160,203,227) in HDR is not
 * that colour once ACES has compressed it. This does the round trip properly:
 * forward analytically, backward by bisection on each channel.
 *
 * Usage:
 *   node scripts/hdr.js --to-hdr 160,203,227
 *   node scripts/hdr.js --to-srgb 0.8174,1.9119,3.19
 */
const EXPOSURE = 1.0;

const IN_M = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const OUT_M = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

function hdrToSrgb(c) {
  const v = c.map((x) => (x * EXPOSURE) / 0.6);
  const a = mul(IN_M, v);
  const fit = a.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
  const b = mul(OUT_M, fit);
  return b.map((x) => {
    const y = Math.min(1, Math.max(0, x));
    return (y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055) * 255;
  });
}

/**
 * Inverse. ACES mixes the channels through two matrices, so a per-channel
 * closed form does not exist; this bisects on a scalar per channel while
 * holding the others, iterating the whole triple to convergence. Ten sweeps is
 * comfortably enough for sub-1/255 agreement, which the caller can verify with
 * --to-srgb on the result.
 */
function srgbToHdr(target) {
  let c = target.map((t) => Math.pow(t / 255, 2.2));
  for (let iter = 0; iter < 60; iter++) {
    for (let k = 0; k < 3; k++) {
      let lo = 0;
      let hi = 64;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const trial = c.slice();
        trial[k] = mid;
        if (hdrToSrgb(trial)[k] < target[k]) lo = mid;
        else hi = mid;
      }
      c[k] = (lo + hi) / 2;
    }
  }
  return c;
}

module.exports = { hdrToSrgb, srgbToHdr };

const [, , mode, arg] = process.argv;
const v = (arg || '').split(',').map(Number);
if (mode === '--to-hdr') {
  const hdr = srgbToHdr(v);
  console.log(`sRGB(${v.join(',')})  ->  HDR ${hdr.map((x) => x.toFixed(4)).join(', ')}`);
  console.log(`  round-trip check: sRGB(${hdrToSrgb(hdr).map((x) => x.toFixed(1)).join(', ')})`);
} else if (mode === '--to-srgb') {
  console.log(`HDR(${v.join(',')})  ->  sRGB ${hdrToSrgb(v).map((x) => x.toFixed(1)).join(', ')}`);
} else if (require.main === module) {
  console.error('usage: hdr.js --to-hdr r,g,b | --to-srgb r,g,b');
  process.exit(1);
}
