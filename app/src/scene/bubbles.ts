import * as THREE from 'three';
import { WATER_GLSL } from './water';
import { LED_JELLY } from './led';
import { TANK_HEIGHT } from '../core/tank';
import { COC_GLSL, cocUniforms } from '../core/dof';

/**
 * Bubbles, which is the one thing every aquarium has and this tank did not.
 *
 * Not decoration: a jellyfish kreisel is aerated, and the thin column of air
 * coming off the inlet is the only *vertical* motion in a picture where
 * everything else drifts. It is also the only thing in the tank that is
 * genuinely specular — a bubble is a mirror with a hole in it, dark in the
 * middle where you look straight through into the water behind and brilliant
 * around the edge where the sight-line grazes the wall of it. That single hard
 * ring is worth more キラキラ than any amount of brightening, because it is the
 * only element in the frame with a hard edge.
 *
 * A few things they have to do, or they read as floating dots:
 *
 *  - **rise fast, and faster as they grow.** A bubble is buoyant, not
 *    neutral. This is the opposite of everything else here, which is exactly
 *    why it works.
 *  - **wobble.** A rising bubble does not go straight up; it spirals, because
 *    its wake sheds alternately off each side. Two out-of-phase sines around
 *    the vertical, at a rate set by its size.
 *  - **come in trains, not evenly.** Aeration is a stream of pulses. The
 *    seeding puts them in loose groups with gaps between.
 */

const COUNT = 90;

const vertexShader = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uFlow;
  varying float vLit;
  varying vec3 vWorld;
  varying float vSize;

  ${WATER_GLSL}

  float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }

  void main() {
    // Where it enters the water and how big it is. A bigger bubble rises
    // faster — Stokes for the small ones, but the eye only needs the
    // monotonicity.
    float size = 0.006 + hash1(aSeed * 3.1) * 0.013;
    float rise = 0.20 + size * 22.0;

    // Trains rather than a metronome: the launch times are clumped, so a run
    // of bubbles comes up together and then the column is empty for a while.
    float group = floor(aSeed * 9.0);
    float phase = fract((uTime * rise) / (TANK_HEIGHT + 0.4)
                        + hash1(aSeed * 7.7) * 0.22 + group * 0.31);

    float y = -0.15 + phase * (TANK_HEIGHT + 0.35);

    // The column stands off the axis, where a kreisel's inlet is, and wanders
    // slowly so it is never a straight line of dots.
    float a = hash1(aSeed * 11.3) * 6.2831853;
    float r = 0.18 + hash1(aSeed * 5.9) * 0.42;
    vec3 p = vec3(cos(a) * r, y, sin(a) * r);

    // The spiral. Its wake sheds off alternate sides, so it corkscrews; the
    // amplitude grows as it accelerates.
    float w = uTime * (1.6 + size * 40.0) + aSeed * 17.0;
    float sway = 0.035 * (0.4 + phase);
    p.x += sin(w) * sway;
    p.z += cos(w * 0.87) * sway;

    vLit = descent(p.y) * shaft(p, uTime, uFlow);
    vWorld = p;
    vSize = size;

    vec4 mv = viewMatrix * vec4(p, 1.0);
    // Fades in at the bottom and pops at the top, both over a short stretch:
    // nothing should be seen arriving from nowhere or stopping dead.
    float alive = smoothstep(0.0, 0.10, phase) * (1.0 - smoothstep(0.93, 1.0, phase));
    gl_PointSize = size * 2600.0 * alive / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying float vLit;
  varying vec3 vWorld;
  varying float vSize;
  uniform vec3 uLed;
  uniform vec3 uEye;

  ${COC_GLSL}

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float r = sqrt(r2) * 2.0;

    // A bubble is a hole in the water with a mirror for a wall. Straight
    // through the middle you see the water behind it, barely disturbed; toward
    // the edge the sight-line grazes the surface, total internal reflection
    // takes over and it goes to a hard bright ring. That ring is the whole
    // reason to draw these.
    float rim = smoothstep(0.62, 0.97, r) * (1.0 - smoothstep(0.97, 1.0, r));
    // ...and one specular dot where the ceiling light lands, always high on the
    // bubble because the light is always above it.
    float spot = smoothstep(0.30, 0.0, length(d - vec2(-0.12, 0.17)));

    vec3 col = vec3(0.72, 0.86, 1.0) * rim * (0.55 + 0.9 * vLit)
             + vec3(1.0, 0.98, 0.94) * spot * (0.35 + 0.8 * vLit);
    col *= uLed;

    float a = clamp(rim * 0.85 + spot * 0.75, 0.0, 1.0);
    gl_FragColor = vec4(col, a);
    if (uMode > 0.5) gl_FragColor = vec4(vec3(circleOfConfusion(vWorld, uEye)), step(0.06, a));
  }
`;

export interface Bubbles {
  points: THREE.Points;
  update: (time: number, flow: number) => void;
  dispose: () => void;
}

export function createBubbles(camPos: THREE.Vector3): Bubbles {
  const position = new Float32Array(COUNT * 3);
  const seed = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) seed[i] = (i + 0.5) / COUNT;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, TANK_HEIGHT / 2, 0), 4);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...cocUniforms(),
      uTime: { value: 0 },
      uFlow: { value: 0.5 },
      uLed: { value: LED_JELLY },
      uEye: { value: camPos },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    // Additive: a bubble's rim is light bent round it, and where two overlap
    // there is more light, not less.
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  // In front of the animals: the aeration column stands nearer the glass than
  // most of them, and a bubble is small enough that being wrong about a few is
  // cheaper than sorting them every frame.
  points.renderOrder = 1400;

  return {
    points,
    update(time, flow) {
      material.uniforms.uTime.value = time;
      material.uniforms.uFlow.value = flow;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
