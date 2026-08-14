import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { AnisotropicKuwaharaPass } from '../effects/anisotropicKuwahara';
import { PlateShader } from '../effects/plateShader';
import { DofShader, RENDER_MODE } from './dof';
import { FRAME_WIDTH, FRAME_HEIGHT } from './tank';

/**
 * The post chain, in the order that matters:
 *
 *   render -> bloom -> OutputPass (ACES + sRGB) -> Kuwahara -> plate
 *
 * Bloom before the tonemap, because it is light and light adds in linear.
 * Kuwahara after it, because the brush marks belong on the finished picture,
 * not on HDR values. The plate last, because it is already a painting
 * (effects/plateShader.ts).
 *
 * Every radius below is in *buffer pixels* at 896x1200 and means nothing at
 * another resolution, which is why core/renderer.ts pins the buffer.
 */
export interface PostFx {
  composer: EffectComposer;
  setPlate: (texture: THREE.Texture) => void;
  /** The clock, for the acrylic's specular (effects/plateShader.ts). */
  setTime: (t: number) => void;
  /** Draws the frame: the circle-of-confusion buffer first, then the chain.
   * Call this rather than composer.render() — the depth of field has no depth
   * buffer to read and needs that first pass (core/dof.ts). */
  render: () => void;
  dispose: () => void;
}

export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostFx {
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(FRAME_WIDTH, FRAME_HEIGHT, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  }));
  composer.setSize(FRAME_WIDTH, FRAME_HEIGHT);

  composer.addPass(new RenderPass(scene, camera));

  // Only the bells and the brightest shafts should bloom, so the threshold sits
  // above the water's own top end: the measured water ramp tops out around
  // sRGB 210 (0.66 linear) and the bells reach past 240.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(FRAME_WIDTH, FRAME_HEIGHT),
    // Carried up, and the threshold down to just above the water's own top
    // end: the picture wanted more キラキラ, and bloom is where it comes from —
    // it is what puts a halo on a lit crown and a glow around every mote of
    // marine snow that crosses a light shaft.
    0.62, // strength
    0.92, // radius
    0.50, // threshold, in linear light before the tonemap
  );
  composer.addPass(bloom);

  composer.addPass(new OutputPass());

  // The painterly blur the制作メモ asks for: 3D's "too smooth, too clean" is
  // suppressed by averaging along the form and holding at its boundary, which
  // is the mark a loaded brush leaves.
  const kuwahara = new AnisotropicKuwaharaPass(FRAME_WIDTH, FRAME_HEIGHT);
  composer.addPass(kuwahara);

  /*
   * The circle-of-confusion buffer, at half resolution.
   *
   * A quarter is plenty, and it is a quarter of the cost of a half: the buffer
   * feeds a blur *radius*, and a radius does not need to be sharp — what it
   * must not do is have edges of its own, which is why it is sampled with
   * LinearFilter and why the pass that reads it weights each tap by that tap's
   * own value.
   *
   * It is also refreshed every other frame. It is a second full render of the
   * scene, which is the most expensive single thing in the chain, and what it
   * measures is how far each animal is from the focal plane — a quantity that
   * changes over seconds, not frames. A frame-old blur radius is not a visible
   * error; a second scene render every frame is a visible frame rate.
   */
  const cocTarget = new THREE.WebGLRenderTarget(FRAME_WIDTH / 4, FRAME_HEIGHT / 4, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });

  let cocAge = 2;
  const dof = new ShaderPass(DofShader);
  dof.uniforms.tCoC.value = cocTarget.texture;
  dof.uniforms.uTexel.value.set(1 / FRAME_WIDTH, 1 / FRAME_HEIGHT);
  // After the tonemap and the brush marks, before the plate: the blur belongs
  // on the finished picture of the water, and it must not touch the painting —
  // the room is not behind the glass and is not out of focus.
  composer.addPass(dof);

  const plate = new ShaderPass(PlateShader);
  plate.renderToScreen = true;
  composer.addPass(plate);

  return {
    composer,
    setPlate(texture) {
      plate.uniforms.tPlate.value = texture;
    },
    setTime(t) {
      plate.uniforms.uTime.value = t;
    },
    render() {
      // Same scene, same camera, every material flipped to write its own CoC.
      // No duplicate meshes and no override material — which could not work
      // here in any case, since the bell's whole shape lives in its vertex
      // shader (scene/jellyfish.ts).
      cocAge++;
      if (cocAge >= 2) {
        cocAge = 0;
        RENDER_MODE.value = 1;
        const previous = renderer.getRenderTarget();
        renderer.setRenderTarget(cocTarget);
        renderer.clear();
        renderer.render(scene, camera);
        renderer.setRenderTarget(previous);
        RENDER_MODE.value = 0;
      }
      composer.render();
    },
    dispose() {
      cocTarget.dispose();
      composer.dispose();
    },
  };
}
