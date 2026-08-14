import * as THREE from 'three';
import { EYE_DISTANCE, EYE_HEIGHT, TANK_HEIGHT } from '../core/tank';
import { waterRamp } from './ramps';
import { LED } from './led';

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
    //
    // The solver wants both of these at their bounds, 9.0 and 4.0, and they are
    // held back at 6.00 and 2.20 because it is only buying spread in the deep
    // bands, where the reference's own spread is inflated by the wall panels
    // glowing through the far side of the glass.
    //
    // Tried at the bounds, and *measured on a real capture* rather than on the
    // model: the profile's RMSE went from 10.35 to 11.60. So the solver is
    // wrong here in the way it is wrong about everything the model has no term
    // for, and the answer is not to argue about it in prose — it is to run
    // scripts/waterprofile.js on a capture, which is what settled it.
    //
    // The model's own floor is a cost of 10.765 whatever these two are, because
    // what it cannot reproduce is the *shape* of the reference's spread — peaks
    // at bands 0, 5-6 and 10, which are the wall panels and the animals — and
    // not its size. Under 5 is not reachable without giving the water a term
    // for things that are not water, and that is the wrong trade.
    float contrast = mix(3.20, 1.40, depth);
    // Expanded about the field's *own* mean, and normalised to one.
    //
    // This used to expand about 0.5 and return a number centred on 0.5, which
    // quietly made the tank's overall brightness a function of wherever the
    // noise happened to be. Two reasons it matters. The field's mean is not
    // 0.5 — four octaves at halving amplitude sum to 0.9375 of a unit-mean
    // noise, so it is 0.469 — and at a contrast of 6 that 0.031 offset is
    // multiplied to 0.37 and then clamped, which is most of the range. And the
    // shafts are wide: at this spread the whole tank spans about three noise
    // cells, so there is no averaging to save it — the tank sits inside one
    // lobe and takes that lobe's level as its exposure.
    //
    // Which turned the 水流 knob into a brightness control by accident. It
    // offsets the field's phase, so moving it slid the tank onto a different
    // lobe: measured, the profile's RMSE went from 10.28 at flow 0 to 56.42 at
    // flow 0.5, and the water came back milky. Centred on the true mean and
    // returning a multiplier around 1.0, the tone is set by descent() alone and
    // the field only says where the beams are.
    const float FIELD_MEAN = 0.469;
    // The scale is what the old expression averaged to, so the water's tone is
    // where it was fitted; all that has changed is that it no longer moves.
    return clamp(0.30 * (1.0 + (bands - FIELD_MEAN) * 2.0 * contrast), 0.0, 1.6);
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
  uniform vec3 uLed;
  uniform sampler2D uRamp;
  uniform sampler2D uReflect;

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

    // There is no standpipe.
    //
    // There used to be an opaque column up the axis, whose only job was to be
    // something the animals could pass behind. It cost the tank its depth: a
    // cylinder of tank-coloured nothing standing in the middle of the frame
    // reads as a wall, and everything behind it was hidden rather than merely
    // far away. What makes an animal read as deep is the water in front of it,
    // and the water is better at it.

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
    // Clearer water.
    //
    // Extinction along the ray decides how much of the tank you are looking
    // *through* rather than at: at 3.24 almost everything reaching the eye was
    // scattered within a third of a radius of the glass, so the far half of the
    // tank contributed nothing and the water read as a painted surface a little
    // way in. Lower, and the ray keeps gathering across the whole tank — which
    // is what makes a body of water look like one.
    float sigma = 2.05;
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

    // The sides of the cylinder, where the wall stops being a window and
    // starts being a lens.
    //
    // This used to *darken* here, on the reasoning that the sight-line runs
    // along a thick acrylic wall. That is true of the acrylic and false of the
    // picture: a round tank refracts, and near the silhouette the ray you
    // follow back into the water has been bent along the glass, so it has
    // travelled through far more lit water than the geometry says. Real
    // cylindrical tanks are *brighter* at their two sides, brightly enough that
    // the far wall smears out into a band of light — and the reference has
    // exactly that band down both edges.
    // How obliquely the ray met the wall, and it has to be measured as an
    // *angle*, not as a radius.
    //
    // This was the length of the entry point in xz, the distance of that point
    // from the axis — and the entry point is on the cylinder, so it is 1.0 for
    // every ray in the frame. Every term keyed to it therefore applied
    // everywhere at full strength: the side brightening lifted the whole tank
    // instead of its two edges, and the reflection pasted the gallery flat
    // across the middle of the glass. What "near the silhouette" actually means
    // is that the wall's normal has turned away from the eye.
    vec2 nrm = normalize((o + dir * t0).xz);
    float edge = 1.0 - abs(dot(nrm, normalize(dir.xz)));
    // Across the whole visible width, not just the last few pixels.
    //
    // The band was keyed to edge 0.55-0.96, and edge only reaches 1.0 exactly
    // at the tangent — which the plate's painted acrylic rim is standing in
    // front of. So the brightening was almost entirely hidden behind the paint
    // and a round tank came out flat-lit, which is the opposite of what a round
    // tank does. It starts as soon as the wall begins to turn away.
    s *= mix(1.0, 1.55, smoothstep(0.10, 0.80, edge));

    vec3 col = texture2D(uRamp, vec2(s, 0.5)).rgb;
    // The knob is a *colour*, not a level.
    //
    // It used to read the ramp lower, which is the same water seen deeper — so
    // the only thing it could do was darken, and a tank asked for a different
    // light went black instead. What a viewer wants from this knob is the
    // aquarium's own lamp colour, and that is a chromaticity, not an exposure.
    //
    // The centre is untouched: at 0.5 the water is exactly the colour measured
    // off the reference and nothing here has moved it. Away from centre the
    // gain leans the ramp toward indigo one way and toward the green-teal of a
    // moon-jelly tank the other, in *linear* light and before the tonemap, so
    // the picture keeps its tonal shape and only its hue turns. Luminance is
    // held to within a few percent so the knob cannot be used as a dimmer.
    float k = uLightTint * 2.0 - 1.0;
    vec3 gain = k < 0.0
      ? mix(vec3(1.0), vec3(0.76, 0.90, 1.20), -k)
      : mix(vec3(1.0), vec3(0.88, 1.15, 0.97), k);
    col *= gain;

    // The acrylic's own gloss: a hard, narrow specular right at the turn of
    // the cylinder, where the wall is edge-on and throws the room back at you.
    // Without it the tank has no surface at all — the water simply stops — and
    // a surface is the difference between a tank and a cylinder-shaped hole.
    float gloss = smoothstep(0.74, 0.95, edge);
    col += vec3(0.055, 0.085, 0.125) * gloss;

    // ...and what it throws back is the gallery (scripts/reflection.js).
    //
    // A cylinder is a mirror that compresses: dead centre it shows you what is
    // directly behind you, and the whole rest of the room is squeezed into the
    // last tenth of the width at each side. That squeeze is the mapping — the
    // angle of the wall where the ray entered, not the screen position — and it
    // is why a reflection on a round tank reads as round and a flat one pasted
    // across the glass does not.
    //
    // Weighted by Fresnel, so it is nearly absent face-on and unmistakable at
    // the two edges, which is where a real one lives. Kept dim and blurred past
    // reading: a legible visitor in the reflection takes the eye off the tank,
    // and the tank is the subject.
    float mirrorX = 0.5 + asin(clamp(nrm.x, -1.0, 1.0)) / 3.14159265;
    // Fresnel, but a *glass* Fresnel rather than a mathematician's one. At an
    // exponent of 3.2 the room was confined to the outermost few pixels of the
    // tank, which the plate then covers: the reflection was in the render and
    // could not be seen. Acrylic mirrors well before grazing, and it has a
    // floor — there is always a little of the room in the glass.
    float fresnel = 0.10 + 0.90 * pow(edge, 1.5);
    vec3 room = texture2D(uReflect, vec2(mirrorX, clamp(0.34 + vUv.y * 0.40, 0.0, 1.0))).rgb;
    col += room * fresnel * 0.55;

    col *= uLed;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createWater(): Water {
  const ramp = waterRamp();
  // A 1x1 white stand-in until the file lands, so the tank is never wrong while
  // it loads — the reflection is additive, so an early frame is simply a tank
  // with a clean surface.
  const reflection = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  reflection.needsUpdate = true;
  new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}reflection.webp`, (tex) => {
    // Sampled *as sRGB*, unlike the plate.
    //
    // The plate is composited after OutputPass, in display space, so it is
    // tagged NoColorSpace. This is added to `col`, which is linear light before
    // the tonemap, so it has to be linearised on sampling — and the difference
    // is not subtle. Left raw, an sRGB 0.6 arrived as a linear 0.6 against
    // water that runs 0.02 to 0.4, and the reflection was several times
    // brighter than the tank it was reflecting in: the profile's RMSE went from
    // 10.35 to 56.78 and the water came back as milk.
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    material.uniforms.uReflect.value = tex;
  });
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCamPos: { value: new THREE.Vector3(0, EYE_HEIGHT, EYE_DISTANCE) },
      uInvProj: { value: new THREE.Matrix4() },
      uCamMatrix: { value: new THREE.Matrix4() },
      uTime: { value: 0 },
      uFlow: { value: 0.5 },
      uLightTint: { value: 0.0 },
      uLed: { value: LED },
      uRamp: { value: ramp },
      uReflect: { value: reflection },
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
