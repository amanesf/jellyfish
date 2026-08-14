import './style.css';
import * as THREE from 'three';
import { createRenderer } from './core/renderer';
import { createCamera, FRAME_HEIGHT, FRAME_WIDTH } from './core/tank';
import { createPostFx } from './core/postFx';
import { createWater } from './scene/water';
import { createSnow } from './scene/snow';
import { createDecks } from './scene/decks';
import { createSwarm } from './scene/swarm';
import { createControls } from './ui/controls';
import { setLed } from './scene/led';

/**
 * The app.
 *
 * `?fit=frame` gives the whole viewport to the picture and hides everything
 * else — the shape scripts/capture.js measures in. Applied before the renderer
 * exists so the first frame is already the right one.
 */
const params = new URLSearchParams(window.location.search);
if (params.get('fit') === 'frame') document.documentElement.classList.add('fit-frame');

const host = document.querySelector<HTMLDivElement>('#app')!;
const renderer = createRenderer(host);
const camera = createCamera();
const scene = new THREE.Scene();

const water = createWater();
scene.add(water.mesh);

const decks = createDecks(camera.position);
scene.add(decks.group);

const snow = createSnow(camera.position);
scene.add(snow.points);

const swarm = createSwarm(scene, camera.position);

const postFx = createPostFx(renderer, scene, camera);
new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}plate.webp`, (texture) => {
  // Sampled raw, *not* as sRGB.
  //
  // effects/plateShader.ts runs after OutputPass, so the buffer it blends into
  // is already display-space sRGB and the plate has to be too. Tagging the
  // texture SRGBColorSpace makes three.js linearise it on sampling, and the
  // painting then arrives on screen a stop and a half dark — which is exactly
  // what it was doing.
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  postFx.setPlate(texture);
});

const controls = createControls(document.querySelector<HTMLElement>('#console')!);

// The water pass needs the same ray the meshes are projected with.
const waterUniforms = (water.mesh.material as THREE.ShaderMaterial).uniforms;
waterUniforms.uCamPos.value = camera.position;
waterUniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
waterUniforms.uCamMatrix.value.copy(camera.matrixWorld);

/**
 * The clock.
 *
 * Two rules, both from sakura (image-sky-plan.md §4), and both load-bearing for
 * the measure loop:
 *
 *  - the scene advances on a *fixed* step, so the same simTime always produces
 *    the same picture whatever frame rate the machine managed. The jellyfish
 *    are Verlet chains, which are integrated rather than evaluated, so this is
 *    the only way they can reproduce at all.
 *  - `?t=<seconds>` freezes the scene at that simTime by stepping the
 *    simulation up to it and then stopping. A capture of `?t=90` is the same
 *    image on any machine, which is what makes a measured statistic mean
 *    anything.
 */
const STEP = 1 / 60;
const frozenAt = params.has('t') ? Number(params.get('t')) : null;
let simTime = 0;
let carry = 0;
let last = performance.now();

function step(dt: number): void {
  simTime += dt;
  // Two minutes for a full turn of the wheel, which is about what the tanks
  // this is copied from take.
  setLed(controls.ledAuto() ? (simTime / 120) % 1 : 0);
  postFx.setTime(simTime);
  water.update(simTime, controls.flow(), controls.light());
  decks.update(simTime, controls.flow());
  snow.update(simTime, controls.flow());
  swarm.update(dt, simTime, controls.count(), controls.flow());
}

// A frozen frame is simulated from zero rather than teleported to: a Verlet
// chain has no closed form, and its shape at t is the whole history of the
// water it hung in. 90 seconds of catch-up is about a second of wall clock.
if (frozenAt !== null) {
  const target = Math.max(0, frozenAt);
  while (simTime < target) step(STEP);
  swarm.sortForCamera(camera);
  postFx.render();
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (frozenAt !== null) {
    // Frozen still means *drawn*, every frame. The drawing buffer is not
    // preserved between frames, so a frozen page that skipped the render would
    // hand scripts/capture.js a cleared canvas — which is exactly what it did.
    swarm.sortForCamera(camera);
    postFx.render();
    return;
  }

  const elapsed = Math.min(0.25, (now - last) / 1000);
  last = now;
  carry += elapsed;
  // Clamped: after a tab has been in the background for a minute, catching up
  // every step would stall for a second. The scene simply resumes.
  let steps = 0;
  while (carry >= STEP && steps < 8) {
    step(STEP);
    carry -= STEP;
    steps++;
  }
  if (steps === 8) carry = 0;

  swarm.sortForCamera(camera);
  postFx.render();
}
requestAnimationFrame(frame);

// The picture is always rendered at the reference frame's own resolution and
// scaled by CSS (core/renderer.ts), so there is nothing to do on resize except
// keep the canvas' backing store from being changed by three.js.
window.addEventListener('resize', () => renderer.setSize(FRAME_WIDTH, FRAME_HEIGHT, false));

// For scripts/capture.js: it drives the knobs and reads the clock through this.
Object.assign(window as unknown as Record<string, unknown>, {
  jelly: {
    setValue: (key: string, value: number) => controls.setValue(key, value),
    simTime: () => simTime,
    frozen: frozenAt !== null,
  },
});
