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
    uTexel: { value: new THREE.Vector2(1 / 896, 1 / 1200) },
    uTime: { value: 0 },
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
    uniform vec2 uTexel;
    uniform float uTime;
    varying vec2 vUv;

    void main() {
      vec3 scene = texture2D(tDiffuse, vUv).rgb;
      vec4 plate = texture2D(tPlate, vUv);

      /*
       * The tank's own grade — the live scene only, never the painting.
       *
       * Applied here rather than in the water and jellyfish shaders because it
       * is one decision about the picture, not five about materials, and
       * because it must stop at the plate: the room, the panels and the girl
       * are painted pixels and they arrive at the screen as painted.
       *
       * A lift, a little saturation, and a slow swell in the light. The swell
       * is very low frequency in space — a couple of lobes across the whole
       * tank — so it reads as the water above the tank moving rather than as
       * anything in the water moving, and it is deliberately out of step with
       * the shimmer inside scene/water.ts so the two never beat together.
       */
      float swell = 1.0 + 0.045 * sin(uTime * 0.27 + vUv.y * 2.1)
                        + 0.030 * sin(uTime * 0.17 - vUv.x * 1.6 + 2.2);
      vec3 lit = scene * 1.13 * swell;
      float lum = dot(lit, vec3(0.2126, 0.7152, 0.0722));
      lit = clamp(mix(vec3(lum), lit, 1.15), 0.0, 1.0);

      vec3 col = mix(lit, plate.rgb, plate.a);

      /*
       * The specular on the acrylic.
       *
       * A curved sheet of thick acrylic in a lit room does not read as glass
       * until something on it is *brighter than anything behind it*. The plate
       * carries the painted bands as partial coverage, which gives the tank its
       * body, but nothing in the frame was actually specular: every pixel of
       * the cylinder was dimmer than the water it stood in front of.
       *
       * The highlight is put where a real one is — at the *edges* of those
       * bands, where the surface turns fastest — rather than over them, and it
       * is found rather than drawn: the horizontal gradient of the plate's own
       * alpha is large exactly along those turns and nowhere else. That keeps
       * the lit area to a few thin vertical lines a handful of pixels wide,
       * which is the whole trick. A specular with area is a white wash, and a
       * white wash over a tank is a lens flare.
       *
       * It breathes, very slightly and very slowly, because the water surface
       * above it moves and the room's light arrives through it.
       */
      float aL = texture2D(tPlate, vUv - vec2(uTexel.x * 1.5, 0.0)).a;
      float aR = texture2D(tPlate, vUv + vec2(uTexel.x * 1.5, 0.0)).a;
      float turn = abs(aR - aL);
      // Only on the glass itself: where the plate is opaque it is the room, and
      // where it is fully open it is water.
      float glass = smoothstep(0.02, 0.20, plate.a) * (1.0 - smoothstep(0.72, 0.95, plate.a));
      float spec = smoothstep(0.035, 0.16, turn) * glass;
      // Sharpened once more, so the line has a core rather than a shoulder.
      spec *= spec;
      float breathe = 0.72 + 0.28 * sin(uTime * 0.21 + vUv.y * 5.3);
      col += vec3(0.86, 0.93, 1.0) * spec * breathe * 0.46;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
