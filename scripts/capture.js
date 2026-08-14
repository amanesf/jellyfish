#!/usr/bin/env node
/**
 * Deterministic headless capture of app/ at the reference image's resolution.
 *
 * The scene freezes when the page is loaded with ?t=<seconds> (see main.ts), so
 * two captures of the same commit at the same t are byte-comparable and any
 * measured difference is attributable to the change under test — which is the
 * whole point of plan.md §2's 決定論 policy.
 *
 * Usage: node scripts/capture.js [outPath] [t]
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const OUT = process.argv[2] || '/tmp/shot.png';
const T = process.argv[3] || '0';
// Defaults are the reference image's frame, which every measurement script
// assumes. CAPTURE_W/CAPTURE_H override it to check other viewport shapes —
// notably the Pixel 10 Pro's 998x448 landscape, where core/frame.ts crops the
// frame instead of stretching it.
const WIDTH = Number(process.env.CAPTURE_W || 896);
const HEIGHT = Number(process.env.CAPTURE_H || 1200);
const PORT = 5199;

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in 60s')), 60000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Local:')) {
        clearTimeout(timer);
        setTimeout(resolve, 500);
      }
    });
    proc.stderr.on('data', (c) => process.stderr.write(c));
  });
}

(async () => {
  const appDir = path.join(__dirname, '..', 'app');
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group: npx is only a launcher, so killing the npx pid
    // leaves the actual vite server holding the port.
    detached: true,
  });
  try {
    await waitForServer(vite);
    const browser = await chromium.launch({
      // The image this container ships is pinned under /opt/pw-browsers and
      // will not match whatever revision the installed playwright package
      // wants; the environment explicitly says to point at it rather than
      // download a second copy.
      executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-sandbox',
      ],
    });
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    // Measurement mode by default. The app's own layout is a portrait page
    // whose canvas is a band across the top (app/src/style.css), so a plain
    // capture at 896x1200 would return a crop of the wrong shape and every fitted crop
    // box in scripts/README.md would miss. `fit=frame` hands the viewport to
    // the picture, which is the frame all the statistics assume. Pass
    // `fit=page` as the extra argument to capture the real app layout instead.
    const extra = process.argv[4] ? `&${process.argv[4]}` : '';
    const fit = /(^|&)fit=/.test(extra) ? '' : '&fit=frame';
    await page.goto(`http://localhost:${PORT}/?t=${T}${fit}${extra}`, { waitUntil: 'networkidle' });
    // Read the canvas out from inside a frame callback rather than using
    // page.screenshot(): under SwiftShader a frame takes long enough that the
    // compositor path times out, and the app's own rAF handler was registered
    // first, so by the time ours runs the frame is drawn and the drawing
    // buffer is still readable in this task.
    //
    // Several frames first: the plate loads asynchronously, and the swarm is
    // still fading its first individuals in on frame 0.
    const dataUrl = await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const tick = () => {
            if (++n < 8) return requestAnimationFrame(tick);
            const canvas = document.querySelector('canvas');
            res(canvas.toDataURL('image/png'));
          };
          requestAnimationFrame(tick);
        }),
      { timeout: 180000 },
    );
    require('fs').writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
    await browser.close();
    if (errors.length) {
      console.error('page errors:\n' + errors.join('\n'));
      process.exitCode = 1;
    }
    console.log(`captured ${OUT} (t=${T})`);
  } finally {
    try {
      process.kill(-vite.pid, 'SIGKILL');
    } catch {
      vite.kill('SIGKILL');
    }
  }
})();
