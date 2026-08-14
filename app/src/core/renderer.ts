import * as THREE from 'three';
import { FRAME_WIDTH, FRAME_HEIGHT } from './tank';

/**
 * The renderer, and the one decision in it worth explaining: the drawing buffer
 * is pinned to the reference frame's own 896x1200 and the canvas is scaled to
 * whatever size CSS gave it.
 *
 * This is a correctness choice, not a performance one — the same one sakura's
 * main.ts makes for the same reason. Every fitted constant here is expressed in
 * *buffer pixels*: the bloom radius, the Kuwahara kernel, the plate's texels,
 * the marine snow's point size. Sizing the buffer to the element instead would
 * make each of those cover a different fraction of the picture on every screen,
 * so two devices showing the same simTime would not agree on the image — and
 * neither would agree with what scripts/capture.js measures, which is the only
 * version of the picture that has been fitted to anything.
 */
export function createRenderer(host: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // the Kuwahara pass is the edge treatment; see effects/
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(FRAME_WIDTH, FRAME_HEIGHT, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // 1.0 exactly. scene/ramps.ts is stored inverse-tonemapped through this
  // operator at this exposure; change it and the ramps have to be regenerated.
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 1);
  const canvas = renderer.domElement;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  host.appendChild(canvas);
  return renderer;
}
