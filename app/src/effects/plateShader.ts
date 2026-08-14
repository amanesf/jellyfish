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
    /** The painted cylinder's axis and radius, in frame pixels as a fraction
     * of the frame's width — core/measured.ts, written by scripts/geom.js. */
    uAxis: { value: 449.0 / 896.0 },
    uRadius: { value: 352.0 / 896.0 },
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
    uniform float uAxis;
    uniform float uRadius;
    varying vec2 vUv;

    void main() {
      vec4 plate = texture2D(tPlate, vUv);

      /*
       * Refraction through the wall.
       *
       * The tank is a cylinder of thick acrylic full of water, and the whole of
       * it is a lens. Nothing in the render knew that: the water was drawn with
       * a pinhole camera and the painted cylinder was laid over the front of
       * it, so the picture was geometrically a flat aquarium with a curved
       * photograph in front. What a real one does is unmistakable once you look
       * for it — the image behind the glass is *stretched horizontally* near
       * the axis and squeezed hard toward the two edges, because there the wall
       * is nearly edge-on to the eye and its normal turns away fastest.
       *
       * Snell at a cylinder, kept to the horizontal because that is the only
       * axis the wall curves in. u is the position across the cylinder, -1 at
       * the left edge and 1 at the right; the surface normal there makes an
       * angle asin(u) with the view, and the ray inside is bent to
       * asin(u / n) with n the ratio of the water's index to air's — 1.34, near
       * enough for acrylic and water together, which differ by two percent.
       * The displacement is the difference between where the bent ray lands and
       * where the straight one would have, and it goes to zero on the axis and
       * to its maximum at the rim, which is exactly where the eye expects it.
       *
       * Held to a fraction of what the geometry says. The full bend at the rim
       * is over forty pixels, and the plate — the painting — cannot move with
       * it: the water would slide out from behind its own glass. A third of it
       * is enough to read as thickness and small enough that the seam holds.
       */
      float u = clamp((vUv.x - uAxis) / uRadius, -1.0, 1.0);
      float bend = (asin(u) - asin(u / 1.34)) * uRadius * 0.26;
      // Only where there is glass to refract through: full inside the tank,
      // out to nothing across the last of the rim, and never on the room.
      float inTank = 1.0 - smoothstep(0.86, 1.0, abs(u));
      /*
       * ...and it lets go at the lid and the base.
       *
       * The refraction bends the render and cannot bend the painting, which is
       * fine in the middle of the tank where the two are not touching and
       * wrong at the two ends where they are. The water's ceiling and floor
       * (scene/decks.ts) are ellipses drawn to land on the painted lid and
       * base to the pixel, and a horizontal displacement slides one off the
       * other: the ceiling came out visibly warped against the rim it is
       * supposed to sit inside.
       *
       * So the bend fades over the top eighth and the bottom eighth of the
       * frame. Physically it should not — but what it costs is refraction in
       * the two bands where there is least to refract, and what it buys is the
       * seam holding, which is the difference between a tank and a
       * compositing mistake.
       */
      inTank *= smoothstep(0.0, 0.13, vUv.y) * smoothstep(1.0, 0.87, vUv.y);
      vec2 ruv = vec2(vUv.x - bend * inTank, vUv.y);

      // ...and the fine distortion, from the bands themselves. Each painted
      // highlight down the cylinder is a place where the surface turns, and a
      // turn in the surface is a kink in what you see through it.
      float gx = texture2D(tPlate, vUv + vec2(uTexel.x * 2.0, 0.0)).a
               - texture2D(tPlate, vUv - vec2(uTexel.x * 2.0, 0.0)).a;
      ruv.x -= gx * 0.010 * inTank;

      vec3 scene = texture2D(tDiffuse, ruv).rgb;

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
      col += vec3(0.86, 0.93, 1.0) * spec * breathe * 0.95;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
