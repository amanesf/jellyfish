import * as THREE from 'three';
import { EYE_DISTANCE, EYE_HEIGHT, PIPE_RADIUS, TANK_HEIGHT } from '../core/tank';
import { waterRamp } from './ramps';

/**
 * The body of water, and the light coming down through it (plan.md §8.1).
 *
 * One full-screen pass. The tank is a cylinder, so the segment of each ray that
 * is inside it comes out of a quadratic rather than a search — nothing marches
 * through the room, and the pass costs only the pixels the tank actually
 * covers. Everything outside the cylinder is left at zero for the plate to
 * cover.
 *
 * What the march accumulates is *how much light reaches the eye from along that
 * ray*, as one scalar. It is not a colour. The colour comes at the very end,
 * from a single lookup into the ramp measured off the reference — which is the
 * whole method (plan.md §2.1). Trying to integrate spectral absorption here and
 * arrive at the painting's blue would be the mistake sakura already made and
 * measured: the reference's water gets *bluer and deeper* as it darkens, not
 * greyer, and no product of a light colour with a transmittance does that.
 *
 * The light itself is above the tank, so the two things the march has to get
 * right are both vertical: light falls off with depth, and it arrives in
 * shafts. The shafts are not drawn as a separate effect — they are the ceiling
 * light seen through a rippling surface, so they come out of the same
 * occlusion function the surface uses, which is why they converge, wander and
 * fade with depth on their own.
 */

export interface Water {
  mesh: THREE.Mesh;
  /** simTime in seconds, and the flow knob, 0-1. */
  update: (time: number, flow: number, lightTint: number) => void;
  dispose: () => void;
}

/** Shared with scene/jellyfish.ts: a jellyfish sitting in this water has to be
 * veiled by exactly the same water in front of it, and by the same shafts. */
export const WATER_GLSL = /* glsl */ `
  const float TANK_HEIGHT = ${TANK_HEIGHT.toFixed(4)};
  const float PIPE_RADIUS = ${PIPE_RADIUS.toFixed(4)};

  /**
   * The hash the noise is built on.
   *
   * The sin-based one, deliberately, after the first version — the popular
   * fract(p*vec2(123.34,456.21)) chain — turned out to be badly non-uniform:
   * ported to the CPU and sampled, its mean came out at 0.228 with a large mass
   * exactly at zero, where a hash owes you 0.5. Every shaft was therefore built
   * on a field centred well below the 0.5 the contrast term expands around, so
   * *raising* the contrast pushed more of the tank to black instead of opening
   * the beams up. That is the kind of bug that reads as an art problem and gets
   * "fixed" by dialling numbers, which is what scripts/watermodel.js exists to
   * prevent.
   */
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * valueNoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  /**
   * How much of the ceiling light reaches a point in the tank.
   *
   * The surface ripples, so the light that gets through it is bunched into
   * bands; the deeper the point, the more those bands have spread and blurred
   * into each other. Both come from the same field sampled at a scale that
   * *grows with depth*, which is the cheap stand-in for actually refracting
   * through the surface, and it behaves the same way: sharp and contrasty just
   * under the surface, broad and soft at the bottom.
   */
  float shaft(vec3 p, float time, float flow) {
    float depth = clamp((TANK_HEIGHT - p.y) / TANK_HEIGHT, 0.0, 1.0);
    // Wide columns: the reference's beams are a third of the tank across. A
    // fine-grained field would be averaged away by the ray no matter how the
    // accumulation is weighted.
    float spread = mix(1.63, 1.35, depth);
    // Stretched three to one *along the view axis*.
    //
    // A shaft is a column, round in plan, and a ray that crosses the tank
    // horizontally cuts through several of them however wide they are — which
    // is why the first two attempts at this came out flat however much contrast
    // the field was given (measured spread 5-19 sRGB against the reference's
    // 17-70). Elongating the columns toward the camera keeps a ray inside one
    // of them for most of its path, so the contrast reaches the picture instead
    // of being integrated away. It is a fixed-camera liberty, and it is only
    // available *because* the camera is fixed: from any other angle these would
    // read as sheets rather than as beams.
    vec2 q = vec2(p.x, p.z * 0.327) * spread
           + vec2(time * 0.035 * (0.4 + flow), time * 0.021 * (0.4 + flow));
    float bands = fbm(q * 1.7) * 0.72 + fbm(q * 4.3 + 11.0) * 0.28;
    // Contrast falls with depth: near the surface the bands are separated by
    // near-dark water, far down they have merged into an even glow.
    // The solver wants both of these at their bounds (9.0 and 4.0) and is
    // arguing for a field with no depth behaviour at all, which is a sign the
    // model is short of a mechanism rather than that the beams really are as
    // hard at the floor as at the surface — it is buying spread in the deep
    // bands, where the reference's own spread is inflated by the wall panels
    // glowing through the far side of the glass. Kept inside the bounds, with
    // the falloff the surface argues for.
    float contrast = mix(6.00, 2.20, depth);
    return clamp(0.5 + (bands - 0.5) * 2.0 * contrast, 0.0, 1.6);
  }

  /** Light reaching depth y at all, before the shafts bunch it up. */
  float descent(float y) {
    return exp(-(TANK_HEIGHT - y) * 0.261);
  }
`;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec3 uCamPos;
  uniform mat4 uInvProj;
  uniform mat4 uCamMatrix;
  uniform float uTime;
  uniform float uFlow;
  uniform float uLightTint;
  uniform sampler2D uRamp;

  ${WATER_GLSL}

  /** Entry and exit of an infinite cylinder of radius r about the y axis. */
  bool cylinder(vec3 o, vec3 d, float r, out float t0, out float t1) {
    float a = dot(d.xz, d.xz);
    float b = 2.0 * dot(o.xz, d.xz);
    float c = dot(o.xz, o.xz) - r * r;
    float disc = b * b - 4.0 * a * c;
    if (disc <= 0.0) return false;
    float s = sqrt(disc);
    t0 = (-b - s) / (2.0 * a);
    t1 = (-b + s) / (2.0 * a);
    return true;
  }

  void main() {
    // The ray for this pixel, through the same projection the meshes use.
    vec4 clip = vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
    vec4 eye = uInvProj * clip;
    vec3 dir = normalize((uCamMatrix * vec4(eye.xy, -1.0, 0.0)).xyz);
    vec3 o = uCamPos;

    float t0, t1;
    if (!cylinder(o, dir, 1.0, t0, t1)) discard;
    // Clip to the water's own height. The caps are the plate's business — the
    // painted top surface and base disc stay painted — so a ray that leaves
    // through one of them simply stops there.
    float yTop = TANK_HEIGHT, yBot = 0.0;
    if (abs(dir.y) > 1e-5) {
      float ta = (yTop - o.y) / dir.y;
      float tb = (yBot - o.y) / dir.y;
      float lo = min(ta, tb), hi = max(ta, tb);
      t0 = max(t0, lo);
      t1 = min(t1, hi);
    } else if (o.y > yTop || o.y < yBot) {
      discard;
    }
    t0 = max(t0, 0.0);
    if (t1 <= t0) discard;

    // The standpipe stops the ray early. It is opaque, painted the colour of
    // the water immediately around it, and its only real job is to be
    // something the jellyfish can pass behind.
    float p0, p1;
    bool hitPipe = cylinder(o, dir, PIPE_RADIUS, p0, p1);
    if (hitPipe && p0 > t0 && p0 < t1) {
      vec3 hit = o + dir * p0;
      if (hit.y > yBot && hit.y < yTop) t1 = p0;
    }

    const int STEPS = 40;
    float dt = (t1 - t0) / float(STEPS);
    float light = 0.0;
    // Extinction along the ray, and it is not an optimisation — it is what
    // makes the shafts survive at all.
    //
    // A shaft is a vertical column of brighter water. A ray from this camera
    // crosses the tank almost horizontally, so it passes through many columns,
    // and an unweighted average along it returns the same number everywhere:
    // measured, the first version's water had a p10-p90 spread of 5-18 sRGB
    // per band against the reference's 17-70. It matched the reference's median
    // down all thirteen bands and still looked wrong, because the reference's
    // water is shot through with structure and that one had none.
    //
    // Weighting the accumulation toward the near end fixes it for a physical
    // reason rather than a graphical one: this water is turbid, most of what
    // reaches the eye scattered within a radius or so of the glass, and what
    // you see is therefore the pattern *near you*, not the average of the tank.
    // Solved, not chosen: scripts/watermodel.js --solve fits this and the five
    // constants in shaft()/descent() against the reference's band medians *and*
    // their p10-p90 spreads. See scripts/README.md for the loop.
    //
    // The gain below is the one place the solve is corrected afterwards. The
    // model does not include bloom or the Kuwahara pass, and measured against a
    // real capture those two lift the water by about 8 sRGB in green and blue,
    // so the solved 1.07 becomes 0.99 here. Everything else went in untouched.
    float sigma = 3.24;
    float transmit = 1.0;
    // Dither the start, so 40 steps do not band the tank into 40 rings. The
    // pattern is a function of the pixel only, so a frozen frame is still
    // byte-identical from one run to the next.
    float jitter = hash21(gl_FragCoord.xy) * dt;
    for (int i = 0; i < STEPS; i++) {
      vec3 p = o + dir * (t0 + jitter + float(i) * dt);
      float step = exp(-sigma * dt);
      light += descent(p.y) * shaft(p, uTime, uFlow) * transmit * (1.0 - step);
      transmit *= step;
    }
    // Normalised by how much of the ray actually contributed, so the tank's
    // edges — where a ray clips through only a little water — do not read as
    // much darker than its middle, which is not what the reference does.
    float reach = 1.0 - exp(-sigma * (t1 - t0));
    float s = clamp(light / max(0.25, reach) * 0.99, 0.0, 1.0);

    // The tank's wall is thick, and at the silhouette you are looking along it:
    // the water there is seen through far more acrylic and reads deeper. This
    // is the one place a geometric term touches the tone, and it is a term the
    // ray already has — how obliquely it passed through the wall.
    float u = length((o + dir * t0).xz);
    // Nearly nothing, and that is the measurement's answer: the solver pinned
    // this against "no darkening at all". The reference's tank does not go dark
    // at its silhouette the way a thick acrylic wall would, because the artist
    // painted a bright rim highlight there instead — and that rim is in the
    // plate, not here.
    s *= mix(1.0, 0.88, smoothstep(0.72, 1.0, u));

    vec3 col = texture2D(uRamp, vec2(s, 0.5)).rgb;
    // The light knob moves *along the measured ramp*, not away from it: cooler
    // means reading the ramp lower, where the reference's own water is deeper
    // and bluer. Nothing here invents a colour the painting does not contain.
    col = mix(col, texture2D(uRamp, vec2(s * 0.62, 0.5)).rgb, uLightTint);

    if (hitPipe && abs(t1 - p0) < 1e-4) {
      // The pipe: the same water, a shade lighter and flat, with a soft edge
      // where its own curvature turns away.
      vec3 hit = o + dir * p0;
      float curve = 1.0 - clamp(abs(hit.x) / PIPE_RADIUS, 0.0, 1.0);
      col = texture2D(uRamp, vec2(clamp(s * 1.06 + 0.05 * curve, 0.0, 1.0), 0.5)).rgb * 1.04;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createWater(): Water {
  const ramp = waterRamp();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCamPos: { value: new THREE.Vector3(0, EYE_HEIGHT, EYE_DISTANCE) },
      uInvProj: { value: new THREE.Matrix4() },
      uCamMatrix: { value: new THREE.Matrix4() },
      uTime: { value: 0 },
      uFlow: { value: 0.5 },
      uLightTint: { value: 0.0 },
      uRamp: { value: ramp },
    },
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return {
    mesh,
    update(time, flow, lightTint) {
      material.uniforms.uTime.value = time;
      material.uniforms.uFlow.value = flow;
      material.uniforms.uLightTint.value = lightTint;
    },
    dispose() {
      material.dispose();
      mesh.geometry.dispose();
      ramp.dispose();
    },
  };
}
