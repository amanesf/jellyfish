import * as THREE from 'three';

/**
 * Composites the foreground plate — the reference illustration with the tank's
 * water punched out (scripts/plate.js) — over the rendered water.
 *
 * Runs dead last, after OutputPass and the Kuwahara pass, and that ordering is
 * the point (sakura's effects/plateShader.ts makes the same argument): those
 * filters exist to push a 3D render toward illustration, and the plate *is* an
 * illustration. Running them over it would soften the room's linework and the
 * visitors' silhouettes. It also means "post-process only what is seen through
 * the acrylic" needs no mask — the plate is the mask.
 *
 * Blending is in display space, which is where the painting was made. The
 * plate's alpha is not binary: the vertical highlights down the cylinder come
 * through as partial coverage, so the water moves *behind* the glass rather
 * than the glass being painted on top of it.
 */
export const PlateShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tPlate: { value: null as THREE.Texture | null },
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
    uniform sampler2D tPlate;
    varying vec2 vUv;
    void main() {
      vec4 rendered = texture2D(tDiffuse, vUv);
      vec4 plate = texture2D(tPlate, vUv);
      gl_FragColor = vec4(mix(rendered.rgb, plate.rgb, plate.a), 1.0);
    }
  `,
};
