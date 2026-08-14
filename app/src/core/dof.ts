import * as THREE from 'three';
import { EYE_DISTANCE } from './tank';

/**
 * Depth of field, and the buffer it needs.
 *
 * A normal DoF pass reads the depth buffer. There is no depth buffer here:
 * every single thing in the tank is transparent and drawn with depthWrite off,
 * because the draw order *is* the depth sort (scene/swarm.ts). The water is a
 * full-screen ray-marched quad and does not have a depth in the usual sense at
 * all. So the blur radius has to come from somewhere else.
 *
 * It comes from a second render of the same scene. Every material in the tank
 * carries the `uMode` uniform below, shared, one object: flip it to 1 and each
 * shader writes its own circle of confusion instead of its colour. That is one
 * extra pass over geometry the scene already has, with no duplicate meshes to
 * keep in sync and no override material — which could not work here anyway,
 * since the bell's entire shape lives in its vertex shader.
 *
 * In that pass the alpha is thresholded rather than kept. A tentacle is drawn
 * at an alpha of a few percent, and a CoC blended at a few percent is the
 * water's CoC, not the tentacle's — the strand would be sharp along its length
 * and blurred everywhere the water showed through it, which is worse than no
 * depth of field at all. Anything that draws at all claims the pixel, and the
 * back-to-front order then leaves the nearest thing's CoC standing.
 */

/** 0 to draw the picture, 1 to draw the circle of confusion. */
export const RENDER_MODE = { value: 0 };

/**
 * Where the focal plane sits, in tank radii from the eye.
 *
 * A little in front of the axis. The animals that carry the picture are the
 * ones in the near half of the water — that is why they were given the near
 * half of the depth range to spawn in (scene/swarm.ts) — and the far wall is
 * two radii behind them.
 */
export const FOCUS = { value: EYE_DISTANCE - 0.62 };

/** How far out of focus a thing has to be to reach the full blur. Wide: the
 * whole tank is only two radii deep, and a range much tighter than this puts
 * the entire far half at maximum blur, which reads as fog rather than as
 * a lens. */
export const RANGE = { value: 2.35 };

/** Dropped into every shader that draws inside the tank. */
export const COC_GLSL = /* glsl */ `
  uniform float uMode;
  uniform float uFocus;
  uniform float uRange;

  float circleOfConfusion(vec3 world, vec3 eye) {
    return clamp(abs(distance(world, eye) - uFocus) / uRange, 0.0, 1.0);
  }
`;

/** The three uniforms COC_GLSL declares, for a material's uniform block. */
export function cocUniforms() {
  return { uMode: RENDER_MODE, uFocus: FOCUS, uRange: RANGE };
}

/**
 * The blur.
 *
 * A spiral of taps rather than a separable gaussian, because the radius varies
 * per pixel and a separable blur cannot honour that: the horizontal pass would
 * have to know the vertical pass's radius. Sixteen taps on a golden-angle
 * spiral is a good enough disc at the radii this uses, and a disc is what a
 * lens actually leaves — the point of the exercise is the shape of an
 * out-of-focus highlight.
 *
 * Each tap is weighted by *its own* CoC, so a sharp foreground cannot be
 * smeared outward by a blurred background sampling it. The classic bleed.
 */
export const DofShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tCoC: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    /** Maximum blur radius, in buffer pixels at 896x1200. */
    uMaxRadius: { value: 5.5 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tCoC;
    uniform vec2 uTexel;
    uniform float uMaxRadius;
    varying vec2 vUv;

    const int TAPS = 16;

    void main() {
      float coc = texture2D(tCoC, vUv).r;
      float radius = coc * uMaxRadius;
      vec4 here = texture2D(tDiffuse, vUv);
      if (radius < 0.6) { gl_FragColor = here; return; }

      vec3 sum = here.rgb;
      float weight = 1.0;
      // 2.39996 is the golden angle: successive taps land as far from each
      // other as they can, so sixteen of them cover the disc evenly instead of
      // falling into spokes.
      for (int i = 1; i <= TAPS; i++) {
        float t = float(i) / float(TAPS);
        float a = float(i) * 2.39996;
        vec2 off = vec2(cos(a), sin(a)) * sqrt(t) * radius * uTexel;
        vec2 uv = vUv + off;
        // Its own blur, not this pixel's: a tap that is in focus does not
        // belong in an out-of-focus pixel's average, or every sharp edge grows
        // a halo of itself.
        float w = texture2D(tCoC, uv).r;
        w = smoothstep(0.0, 0.35, w);
        sum += texture2D(tDiffuse, uv).rgb * w;
        weight += w;
      }
      gl_FragColor = vec4(sum / weight, here.a);
    }
  `,
};
