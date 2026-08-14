import * as THREE from 'three';
import { WATER_GLSL } from './water';
import { waterRamp } from './ramps';
import { LED_JELLY } from './led';
import { TANK_HEIGHT } from '../core/tank';
import { COC_GLSL, cocUniforms } from '../core/dof';

/**
 * The two discs that close the water: the tank's ceiling and its floor.
 *
 * The water had no top and no bottom. It was a ray-marched body with the
 * painting's own lid and base in front of it, which meant the one thing a
 * cylinder of water actually shows you was missing — that you are looking
 * *through* it at something. A tank reads as transparent because you can see
 * its far bottom edge through two metres of water, dimmer and bluer than the
 * near edge but plainly there, and no amount of work on the water itself can
 * say that if there is nothing at the ends of it to be seen through.
 *
 * So: two discs at the tank's radius, one at the surface and one on the floor,
 * in the deep navy the water ramp bottoms out at. The camera sits at 1.30 of
 * the tank's 2.83, so it looks up at the underside of one and down at the top
 * of the other, and both arrive as ellipses — the same two ellipses
 * scripts/geom.js measured the cylinder from, which is why they land on the
 * painted lid and base rather than beside them.
 *
 * They are drawn between the water and the animals: after the water, because
 * they are in it, and before the animals, because the animals swim in front of
 * them. Everything in this scene is transparent with depth writing off, so the
 * draw order is the whole of the depth sort (scene/swarm.ts).
 */

const vertexShader = /* glsl */ `
  varying vec3 vWorld;
  varying vec2 vLocal;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vLocal = position.xy;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vWorld;
  varying vec2 vLocal;

  uniform sampler2D uWaterRamp;
  uniform vec3 uCamPos;
  uniform float uTime;
  uniform float uFlow;
  uniform vec3 uLed;
  /** 1 for the floor, -1 for the ceiling. */
  uniform float uFacing;

  ${WATER_GLSL}
  ${COC_GLSL}

  void main() {
    float r = length(vLocal);
    if (r > 1.0) discard;

    // The plate this is: navy, and darker than any water in front of it. The
    // ramp's own bottom is the darkest measured blue in the picture, and the
    // disc sits below even that — it is a painted surface in shadow, not water.
    vec3 base = texture2D(uWaterRamp, vec2(0.06, 0.5)).rgb * 0.62;

    // Lit by the same ceiling as everything else, and only just: the floor
    // catches a little of the shafts, the underside of the lid catches almost
    // nothing, which is what puts the two of them at different tones and stops
    // the tank looking like a tube with two identical caps.
    float lit = descent(vWorld.y) * shaft(vWorld, uTime, uFlow);
    base *= 1.0 + (uFacing > 0.0 ? 0.55 : 0.15) * lit;

    /*
     * Caustics.
     *
     * The tank is lit from a ceiling through a moving water surface, and what
     * that does to the floor of any real tank is throw a net of bright lines
     * across it that crawls and re-knits itself continuously. It is the most
     * alive thing in an aquarium and the picture had none of it.
     *
     * Built the way a caustic actually forms rather than as a texture: a
     * caustic is a fold in the wavefront, a place where rays that left the
     * surface far apart arrive together, so it is a thin bright line with a
     * hard core and a soft skirt — not a blob. Ridges of a noise field give
     * exactly that shape, and raising them to a power puts the core where it
     * belongs.
     *
     * Two nets at different scales drifting at different rates, so the pattern
     * never repeats and never reads as a scrolling texture. The floor takes it
     * at full strength; the underside of the lid takes a fifth, because what
     * reaches it is only what has bounced back up.
     */
    vec2 cw = vLocal * 3.4 + vec2(uTime * 0.055, uTime * -0.041);
    float n1 = fbm(cw * 1.9);
    float n2 = fbm(cw * 1.9 + vec2(5.2, 1.3) + uTime * 0.03);
    float ridge = (1.0 - abs(n1 * 2.0 - 1.0)) * (1.0 - abs(n2 * 2.0 - 1.0));
    float caustic = pow(clamp(ridge, 0.0, 1.0), 3.4);
    // A coarser net over it: the bright cells the fine lines run between,
    // which is what gives the pattern its large-scale structure.
    float coarse = pow(clamp(1.0 - abs(fbm(cw * 0.62 - uTime * 0.02) * 2.0 - 1.0), 0.0, 1.0), 2.2);
    caustic *= 0.45 + 0.85 * coarse;

    // Drawn by the shafts' own light, so the net is bright where a beam lands
    // and absent where none does — which is what ties the pattern on the floor
    // to the columns standing over it.
    float reach = uFacing > 0.0 ? 1.0 : 0.20;
    base += texture2D(uWaterRamp, vec2(0.97, 0.5)).rgb * caustic * lit * reach * 1.5;

    // The rim, which is the whole point of the exercise.
    //
    // What tells you a tank is full of clear water is its far bottom edge seen
    // through the water — so the edge has to be *visible*, and a flat disc has
    // no edge. This is the light that grazes it: brightest in the last few
    // percent of the radius, where the disc meets the acrylic, which is also
    // exactly where the reference paints a thin bright line around the base.
    // Thin, and only where the disc actually meets the acrylic. The first
    // version made this a bright band a tenth of the radius wide, which is not
    // a waterline — it is a drawn ellipse, and a drawn ellipse is most of why
    // the discs looked stuck on top of the painting rather than inside it.
    float rim = smoothstep(0.975, 0.998, r);
    base += texture2D(uWaterRamp, vec2(0.80, 0.5)).rgb * rim * (0.14 + 0.30 * lit);

    /*
     * The water in front of it, done as *transmittance* rather than as a mix,
     * and this is the whole of why the discs were floating off the picture.
     *
     * The water is a full-screen pass that has already been drawn when these
     * are composited. A disc drawn opaque therefore does not sit in the water —
     * it replaces every metre of water between itself and the eye, which for
     * the far half of a disc is the whole depth of the tank. Mixing 58% of the
     * water's colour back in, which is what this did, is a paint job standing
     * in for an occlusion: it lightened the disc without ever putting anything
     * in front of it, so the disc came out as a pale flat lens lying on the
     * glass.
     *
     * What the disc actually is, is a dark surface seen *through* a column of
     * water. So its alpha is the transmittance of that column — one at the near
     * edge, where there is no water in the way, falling to nearly nothing at
     * the far edge two radii back — and the water pass already on the screen
     * supplies the rest. The far edge of each disc now dissolves into the water
     * instead of being drawn on it, which is what the eye reads as depth.
     */
    float dist = length(uCamPos - vWorld);
    float through = exp(-max(0.0, dist - 5.6) * 0.30);

    vec3 col = base * uLed;

    // Sharp, always: it is a background plane and blurring it would put the
    // tank's own structure out of focus (core/dof.ts).
    if (uMode > 0.5) discard;
    // ...and the very edge of the disc fades rather than ending, because the
    // acrylic it runs into is painted and the seam has to be given somewhere
    // to happen.
    float edge = 1.0 - smoothstep(0.992, 1.0, r);
    gl_FragColor = vec4(col, clamp(through, 0.0, 1.0) * edge);
  }
`;

export interface Decks {
  group: THREE.Group;
  update: (time: number, flow: number) => void;
  dispose: () => void;
}

export function createDecks(camPos: THREE.Vector3): Decks {
  const ramp = waterRamp();
  const geometry = new THREE.CircleGeometry(1, 128);
  const group = new THREE.Group();
  const materials: THREE.ShaderMaterial[] = [];

  for (const facing of [1, -1]) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...cocUniforms(),
        uWaterRamp: { value: ramp },
        uCamPos: { value: camPos },
        uTime: { value: 0 },
        uFlow: { value: 0.5 },
        uLed: { value: LED_JELLY },
        uFacing: { value: facing },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      // Both faces: the camera is inside the height of the tank, so it sees the
      // top of the floor and the underside of the lid.
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = facing > 0 ? 0 : TANK_HEIGHT;
    mesh.frustumCulled = false;
    // After the water (-1), before the animals (about 1000).
    mesh.renderOrder = 0;
    materials.push(material);
    group.add(mesh);
  }

  return {
    group,
    update(time, flow) {
      for (const m of materials) {
        m.uniforms.uTime.value = time;
        m.uniforms.uFlow.value = flow;
      }
    },
    dispose() {
      geometry.dispose();
      for (const m of materials) m.dispose();
      ramp.dispose();
    },
  };
}
