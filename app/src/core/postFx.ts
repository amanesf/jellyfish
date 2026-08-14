import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { AnisotropicKuwaharaPass } from '../effects/anisotropicKuwahara';
import { PlateShader } from '../effects/plateShader';
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
    0.52, // strength
    0.92, // radius
    0.56, // threshold, in linear light before the tonemap
  );
  composer.addPass(bloom);

  composer.addPass(new OutputPass());

  // The painterly blur the制作メモ asks for: 3D's "too smooth, too clean" is
  // suppressed by averaging along the form and holding at its boundary, which
  // is the mark a loaded brush leaves.
  const kuwahara = new AnisotropicKuwaharaPass(FRAME_WIDTH, FRAME_HEIGHT);
  composer.addPass(kuwahara);

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
    dispose() {
      composer.dispose();
    },
  };
}
