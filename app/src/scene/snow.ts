import * as THREE from 'three';
import { COC_GLSL, cocUniforms } from '../core/dof';
import { TANK_HEIGHT } from '../core/tank';
import { WATER_GLSL } from './water';
import { waterRamp } from './ramps';
import { LED } from './led';

/**
 * Marine snow — the drifting motes that fill the reference's water.
 *
 * Uniformly distributed through the tank, not thickened with depth: the water
 * is being stirred, so there is no reason for the particles to settle, and the
 * reference agrees (its motes are as dense at the top as at the bottom).
 *
 * They are lit by the same shafts as everything else, which is what stops them
 * reading as dust on the screen: a mote in a beam is bright, the same mote a
 * second later is not, and that flicker across the whole tank is most of what
 * gives the water its texture.
 */
export interface Snow {
  points: THREE.Points;
  update: (time: number, flow: number) => void;
  dispose: () => void;
}

const COUNT = 2400;

export function createSnow(camPos: THREE.Vector3): Snow {
  const position = new Float32Array(COUNT * 3);
  const seedAttr = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    // A deterministic spiral rather than random(): equal-area in the disc, so
    // the density really is uniform, and reproducible without storing a seed.
    const t = (i + 0.5) / COUNT;
    // The full disc: there is no standpipe to keep out of any more.
    const r = Math.sqrt(t) * 0.94;
    const a = i * 2.399963; // golden angle
    position[i * 3] = Math.cos(a) * r;
    // Height from a hash, not from a second irrational rotation. The golden
    // angle in x/z and a golden-ratio walk in y stay in step with each other:
    // motes at a similar height end up at a similar bearing, and the field
    // grows a dense bank that catches a light shaft and reads as a cloud of
    // steam near the top of the tank. Decorrelating the axis kills it.
    const h = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    position[i * 3 + 1] = (h - Math.floor(h)) * TANK_HEIGHT;
    position[i * 3 + 2] = Math.sin(a) * r;
    seedAttr[i] = t;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seedAttr, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, TANK_HEIGHT / 2, 0), 3);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...cocUniforms(),
      uEye: { value: camPos },
      uTime: { value: 0 },
      uFlow: { value: 0.5 },
      uCamPos: { value: camPos },
      uRamp: { value: waterRamp() },
      uLed: { value: LED },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uFlow;
      varying float vLit;
      varying float vSeed;
      varying vec3 vWorld;

      ${WATER_GLSL}

      void main() {
        vec3 p = position;
        // Drift: slow, and different for every mote, so the field never reads
        // as one sheet sliding past.
        float t = uTime * (0.35 + uFlow * 0.9);
        p.y += sin(t * 0.21 + aSeed * 40.0) * 0.09 - mod(t * 0.012 + aSeed, 1.0) * 0.0;
        p.x += sin(t * 0.17 + aSeed * 70.0) * 0.05;
        p.z += cos(t * 0.13 + aSeed * 55.0) * 0.05;
        vLit = descent(p.y) * shaft(p, uTime, uFlow);
        vWorld = p;
        vSeed = aSeed;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // Sized in buffer pixels at the reference's own resolution, like every
        // other fitted constant here (core/renderer.ts). The reference's motes
        // are 2-4 px across at the front of the tank, and the eye sits 6.6
        // radii back, so the constant is that width times that distance.
        gl_PointSize = (1.0 + 1.6 * fract(aSeed * 13.0)) * 15.0 / -mv.z;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vLit;
      varying float vSeed;
      varying vec3 vWorld;
      uniform sampler2D uRamp;
      uniform vec3 uLed;
      uniform float uTime;
      uniform vec3 uEye;
      ${COC_GLSL}
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d);
        if (r > 0.25) discard;
        float soft = 1.0 - smoothstep(0.05, 0.25, r);
        // White, not blue.
        //
        // These used to be tinted with the water ramp, on the reasoning that a
        // mote is lit by the same water everything else is — which is true of
        // the light reaching it and false of the mote itself. Marine snow is
        // detritus: it is achromatic, and against a blue field it reads *warm*.
        // Painted in the water's own blue it disappeared into the water, and
        // the tank lost the one thing that says there is a volume of water
        // between the eye and the far wall rather than a painted surface. The
        // reference has hundreds of them and they are the brightest small
        // thing in the frame.
        vec3 col = mix(vec3(0.62, 0.78, 0.95), vec3(1.0, 0.99, 0.96), vLit);
        // Additive, so the brightness is capped rather than left to the shaft:
        // where a beam crosses a dense patch the sum ran past white and the
        // patch stopped being made of motes.
        // Twinkle (item 7).
        //
        // A mote of marine snow is a flake, not a sphere: it turns as it falls,
        // and every so often a face of it comes square to the light and it
        // flares for half a second. That intermittency is most of what reads as
        // キラキラ — a field of steadily lit dots reads as dust on the lens.
        // Two incommensurate rates per mote, so no two flare together and the
        // pattern never comes round again.
        float turn = sin(uTime * (0.9 + vSeed * 1.7) + vSeed * 41.0)
                   * sin(uTime * (0.31 + vSeed * 0.6) + vSeed * 17.0);
        float flare = pow(max(0.0, turn), 6.0);
        // The flare is a *core*, much smaller than the mote, which is what
        // keeps it a glint rather than a swelling.
        float glint = flare * (1.0 - smoothstep(0.0, 0.06, r));
        vec3 lit = col * uLed * min(1.7, 0.9 + 1.5 * vLit);
        lit += uLed * glint * (0.7 + 1.5 * vLit);
        gl_FragColor = vec4(lit, soft * (0.30 + 0.52 * vLit) + glint * 0.55);
        // A mote at the back of the tank is as out of focus as anything else
        // there, and this is where it shows most: the near snow stays as
        // pin-points and the far snow goes to soft discs, which is the single
        // clearest depth cue the water has.
        if (uMode > 0.5) gl_FragColor = vec4(vec3(circleOfConfusion(vWorld, uEye)), step(0.02, gl_FragColor.a));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 0;

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
