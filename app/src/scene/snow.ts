import * as THREE from 'three';
import { PIPE_RADIUS, TANK_HEIGHT } from '../core/tank';
import { WATER_GLSL } from './water';
import { waterRamp } from './ramps';

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
    const r = Math.sqrt(PIPE_RADIUS * PIPE_RADIUS + t * (0.94 * 0.94 - PIPE_RADIUS * PIPE_RADIUS));
    const a = i * 2.399963; // golden angle
    position[i * 3] = Math.cos(a) * r;
    position[i * 3 + 1] = ((i * 0.6180339887) % 1) * TANK_HEIGHT;
    position[i * 3 + 2] = Math.sin(a) * r;
    seedAttr[i] = t;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seedAttr, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, TANK_HEIGHT / 2, 0), 3);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFlow: { value: 0.5 },
      uCamPos: { value: camPos },
      uRamp: { value: waterRamp() },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uFlow;
      varying float vLit;
      varying float vSeed;

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
      uniform sampler2D uRamp;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d);
        if (r > 0.25) discard;
        float soft = 1.0 - smoothstep(0.05, 0.25, r);
        vec3 col = texture2D(uRamp, vec2(clamp(0.55 + vLit * 0.5, 0.0, 1.0), 0.5)).rgb;
        gl_FragColor = vec4(col * (1.4 + vLit), soft * (0.25 + 0.55 * vLit));
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
