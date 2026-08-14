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
    base *= 1.0 + (uFacing > 0.0 ? 1.35 : 0.30) * lit;

    // The rim, which is the whole point of the exercise.
    //
    // What tells you a tank is full of clear water is its far bottom edge seen
    // through the water — so the edge has to be *visible*, and a flat disc has
    // no edge. This is the light that grazes it: brightest in the last few
    // percent of the radius, where the disc meets the acrylic, which is also
    // exactly where the reference paints a thin bright line around the base.
    float rim = smoothstep(0.93, 1.0, r);
    base += texture2D(uWaterRamp, vec2(0.86, 0.5)).rgb * rim * (0.30 + 0.55 * lit);

    // The water standing in front of it. The far half of each disc is two
    // radii of water away and the near half is none, so the disc veils across
    // its own width — which is the depth cue the whole thing exists for.
    float dist = length(uCamPos - vWorld);
    float veil = 1.0 - exp(-max(0.0, dist - 5.6) * 0.24);
    float ws = clamp(lit * 1.3, 0.0, 1.0);
    vec3 col = mix(base, texture2D(uWaterRamp, vec2(ws, 0.5)).rgb, veil * 0.58);

    col *= uLed;

    // Sharp, always: it is a background plane and blurring it would put the
    // tank's own structure out of focus (core/dof.ts).
    if (uMode > 0.5) discard;
    gl_FragColor = vec4(col, 1.0);
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
