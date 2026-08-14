import * as THREE from 'three';
import { WATER_GLSL } from './water';
import { bellRamp, veilRamp, waterRamp } from './ramps';
import { LED } from './led';
import { TANK_HEIGHT } from '../core/tank';

/**
 * One jellyfish: a bell that swims by pulsing, and the arms and tentacles that
 * hang off it (plan.md §8.2).
 *
 * Two species are in the reference and both are built from this file. The
 * warm-belled one at the front is a short, heavy dome with thick oral arms; the
 * pale ribbons behind it are the same animal with a small bell and very long
 * arms, which is what those actually are — the painting is nearly all oral arm
 * and hardly any bell.
 *
 * Three things about the bell are deliberate departures from what a physical
 * renderer would do, and each is the anime-look rule from plan.md §2.1:
 *
 *  - the shading term is *posterised* before it indexes the ramp, because
 *    precise shading on a translucent dome reads as a glass ball. Coarse
 *    shadows keep it a single soft mass.
 *  - the rim is *scalloped inward*, not smoothly domed. A purely convex bell
 *    reads as candyfloss for the same reason a purely convex cloud does.
 *  - the colour never leaves the measured ramp. The bell's glow is the ramp's
 *    own top end, reached by the transmission term, not a warm light added on.
 */

export type Species = 'bell' | 'ribbon';

export interface JellyfishOptions {
  species: Species;
  seed: number;
  /** Bell radius in tank radii. */
  size: number;
  /** Seconds per pulse. Real jellyfish sit near 0.8-1.4 Hz; the ribbons are
   * slower because they are bigger. */
  period: number;
}

/** Deterministic per-individual randomness. Nothing in the scene uses Math.random:
 * a jellyfish is a pure function of its seed, so a frozen frame reproduces. */
export function rand(seed: number, n: number): number {
  const x = Math.sin(seed * 127.1 + n * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The pulse.
 *
 * Asymmetric on purpose, and this is the single thing that makes the motion
 * read as an animal rather than as a sine wave: the muscle contracts fast and
 * relaxes slowly, roughly a quarter of the cycle against three quarters. The
 * bell's thrust follows the contraction, so an individual surges and then
 * coasts.
 */
export function pulse(phase: number): number {
  const t = phase - Math.floor(phase);
  const CONTRACT = 0.25;
  if (t < CONTRACT) {
    const u = t / CONTRACT;
    return u * u * (3 - 2 * u);
  }
  const u = (t - CONTRACT) / (1 - CONTRACT);
  return 1 - u * u * (3 - 2 * u);
}

const bellVertex = /* glsl */ `
  uniform float uPulse;
  uniform float uSeed;
  uniform float uTime;
  varying float vRim;      // 0 at the crown, 1 at the rim
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying float vLobe;
  varying float vAngle;

  // aRim: 0..1 up the dome. aAngle: 0..1 around it.
  attribute float aRim;
  attribute float aAngle;

  void main() {
    float ang = aAngle * 6.2831853;

    // The edge lags the crown. The muscle contracts from the top down, so the
    // rim is still finishing the last stroke when the crown starts the next —
    // which is the whole of why a bell looks like it is flowing rather than
    // opening and shutting.
    float lag = aRim * 0.32;
    float p = uPulse - lag;
    p = p - floor(p);
    float contract = p < 0.25 ? smoothstep(0.0, 1.0, p / 0.25)
                              : 1.0 - smoothstep(0.0, 1.0, (p - 0.25) / 0.75);

    // Scalloped, not smooth: eight lobes that pull the rim *in*, deepening
    // toward the edge, plus a slow wander so no two moments are the same.
    float lobes = cos(ang * 8.0 + uSeed * 6.28 + sin(uTime * 0.35 + uSeed) * 0.6);
    float scallop = 1.0 - 0.085 * lobes * aRim * aRim;
    vLobe = lobes;

    float radius = sin(aRim * 1.5707963);
    float height = cos(aRim * 1.5707963);

    // Contraction squeezes the bell narrower and taller, and curls the rim
    // under — the skirt, which is where the light gets through.
    float squeeze = 1.0 - 0.24 * contract;
    float stretch = 1.0 + 0.30 * contract;
    float curl = 0.34 * contract * aRim * aRim;

    vec3 p3 = vec3(
      cos(ang) * radius * scallop * squeeze,
      height * stretch - curl,
      sin(ang) * radius * scallop * squeeze
    );
    // A shallow bowl under the rim, so the silhouette has a concavity in it.
    p3.y -= 0.16 * aRim * aRim * aRim;

    vec4 world = modelMatrix * vec4(p3, 1.0);
    vWorld = world.xyz;
    vRim = aRim;
    vAngle = aAngle;
    vNormalW = normalize(mat3(modelMatrix) * normalize(vec3(p3.x, p3.y * 0.75 + 0.25, p3.z)));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const bellFragment = /* glsl */ `
  precision highp float;
  varying float vRim;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying float vLobe;
  varying float vAngle;

  uniform sampler2D uRamp;
  uniform sampler2D uWaterRamp;
  uniform vec3 uCamPos;
  uniform float uTime;
  uniform float uFlow;
  uniform float uFade;   // 0 while a new individual is still arriving
  uniform vec3 uLed;

  ${WATER_GLSL}

  void main() {
    vec3 V = normalize(uCamPos - vWorld);
    vec3 L = vec3(0.0, 1.0, 0.0);   // the ceiling, and nothing else

    // Transmission: the bell is thin, and what makes it glow is the light
    // coming *through* it from above, strongest where the sheet is edge-on to
    // the eye and where it is thinnest, at the rim.
    float facing = 1.0 - abs(dot(vNormalW, V));
    float through = pow(facing, 1.5) * (0.35 + 0.65 * vRim);

    float top = max(dot(vNormalW, L), 0.0);
    float lit = descent(vWorld.y) * shaft(vWorld, uTime, uFlow);

    // The radial stripes. Every bell in the reference has them — the canals
    // running from the crown to the rim — and they are most of what says
    // "jellyfish" rather than "translucent dome" at this size. Counted off the
    // reference: fourteen, fading out toward the crown.
    // The radial canals, and they are *dark*.
    //
    // They were being added as brightness, which is backwards: in the
    // reference they are hard thin lines running from the crown to the rim,
    // darker than the bell they cross, and they are the single most
    // recognisable thing about the animal. Narrow, too — the line is thin and
    // the gap between lines is wide, which a plain raised cosine cannot say;
    // raising it to a power puts the width where the reference has it.
    float canal = pow(0.5 + 0.5 * cos(vAngle * 87.9646), 5.0);
    // The canals carry a lot more of the bell than they were given. In the
    // reference they are the *structure* of the animal — hard bright lines from
    // the crown to the rim over a saturated ground — and at 0.10 they were a
    // texture you had to look for. The rim is also brighter than the dome: a
    // bell is a thin sheet seen through its own edge there, and that edge is
    // where the reference puts its most saturated orange.
    float s = 0.34 + 0.42 * top * lit + 0.60 * through * lit + 0.08 * vLobe * vRim
            - 0.30 * canal * smoothstep(0.10, 0.65, vRim)
            + 0.16 * smoothstep(0.74, 1.0, vRim);

    // Coarse on purpose. Four steps, softly joined: precise shading here turns
    // the bell into a glass ball, and the reference's bells are flat masses
    // with one bright crown and one dark underside.
    // Less posterised than it was. Four hard steps on a dome twice the size is
    // no longer "a flat mass with one bright crown" — it is a paper cut-out,
    // because at this scale each step is thirty pixels wide and the eye reads
    // the step and not the curve.
    float banded = floor(s * 5.0 + 0.5) / 5.0;
    s = clamp(mix(s, banded, 0.34), 0.0, 1.0);

    vec3 col = texture2D(uRamp, vec2(s, 0.5)).rgb;

    // The water in front of it. Same ramp, same shafts as scene/water.ts, so a
    // jellyfish deep in the tank sits *in* the water rather than on top of it.
    float dist = length(uCamPos - vWorld);
    // Veiled by depth, but the tank is only two radii deep and the veil was
    // eating four fifths of an animal at the back wall — which is most of the
    // population, and it is why the tank read as a painted blue surface with a
    // couple of smudges on it. Water this clear does not do that: the reference
    // shows its far animals plainly, dimmer and bluer but *there*.
    float veil = 1.0 - exp(-max(0.0, dist - 5.6) * 0.24);
    float ws = clamp(descent(vWorld.y) * shaft(vWorld, uTime, uFlow) * 1.3, 0.0, 1.0);
    col = mix(col, texture2D(uWaterRamp, vec2(ws, 0.5)).rgb, veil * 0.58);

    // Translucent, and translucent the way a bell is: a thin dome seen through
    // its own thickness. Face-on you are looking through one sheet and the
    // water behind shows; at the silhouette the sight-line runs along the sheet
    // and it goes solid, which is exactly where the reference's bells carry
    // their most saturated orange. Drawn opaque — which is what this was — a
    // bell is a plastic toy in the water rather than a thing made of water.
    col *= uLed;
    float body = 0.30 + 0.50 * facing + 0.24 * smoothstep(0.62, 1.0, vRim);
    gl_FragColor = vec4(col, uFade * clamp(body, 0.0, 1.0));
  }
`;

/** The dome, as an indexed grid in (rim, angle). Built once and shared. */
function bellGeometry(rings = 18, segments = 40): THREE.BufferGeometry {
  const position: number[] = [], aRim: number[] = [], aAngle: number[] = [], index: number[] = [];
  for (let r = 0; r <= rings; r++) {
    for (let a = 0; a <= segments; a++) {
      position.push(0, 0, 0); // the vertex shader places every vertex
      aRim.push(r / rings);
      aAngle.push(a / segments);
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let a = 0; a < segments; a++) {
      const i = r * row + a;
      index.push(i, i + row, i + 1, i + 1, i + row, i + row + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('aRim', new THREE.Float32BufferAttribute(aRim, 1));
  g.setAttribute('aAngle', new THREE.Float32BufferAttribute(aAngle, 1));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  return g;
}

/**
 * A Verlet chain: one oral arm or one tentacle.
 *
 * Nothing about how these move is animated. They are hung off the bell and left
 * to the water — each node keeps its distance from the last, loses speed to
 * drag, and drifts with the flow, so the shapes that come out (the long trailing
 * S, the curl when the animal turns, the slow straightening as it coasts) are
 * consequences of how the bell moved rather than curves anybody drew.
 */
class Chain {
  pos: Float32Array;
  prev: Float32Array;
  readonly nodes: number;
  readonly segment: number;

  constructor(nodes: number, segment: number, root: THREE.Vector3) {
    this.nodes = nodes;
    this.segment = segment;
    this.pos = new Float32Array(nodes * 3);
    this.prev = new Float32Array(nodes * 3);
    for (let i = 0; i < nodes; i++) {
      this.pos[i * 3] = root.x;
      this.pos[i * 3 + 1] = root.y - i * segment;
      this.pos[i * 3 + 2] = root.z;
    }
    this.prev.set(this.pos);
  }

  step(dt: number, root: THREE.Vector3, flow: (x: number, y: number, z: number, out: THREE.Vector3) => void, drag: number) {
    const f = new THREE.Vector3();
    for (let i = 1; i < this.nodes; i++) {
      const k = i * 3;
      const px = this.pos[k], py = this.pos[k + 1], pz = this.pos[k + 2];
      flow(px, py, pz, f);
      // Verlet with drag. Jellyfish arms are close to neutrally buoyant, so
      // gravity is a whisper and the water does nearly all the work.
      const vx = (px - this.prev[k]) * drag + (f.x - 0.0) * dt * dt;
      const vy = (py - this.prev[k + 1]) * drag + (f.y - 0.05) * dt * dt;
      const vz = (pz - this.prev[k + 2]) * drag + (f.z - 0.0) * dt * dt;
      this.prev[k] = px; this.prev[k + 1] = py; this.prev[k + 2] = pz;
      this.pos[k] = px + vx; this.pos[k + 1] = py + vy; this.pos[k + 2] = pz + vz;
    }
    this.pos[0] = root.x; this.pos[1] = root.y; this.pos[2] = root.z;
    this.prev[0] = root.x; this.prev[1] = root.y; this.prev[2] = root.z;
    // Distance constraints, root outward. Three passes is enough for a chain
    // this soft, and more only makes it stiffer than an arm should be.
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < this.nodes; i++) {
        const a = (i - 1) * 3, b = i * 3;
        let dx = this.pos[b] - this.pos[a];
        let dy = this.pos[b + 1] - this.pos[a + 1];
        let dz = this.pos[b + 2] - this.pos[a + 2];
        const len = Math.hypot(dx, dy, dz) || 1e-6;
        const k = (len - this.segment) / len;
        this.pos[b] -= dx * k; this.pos[b + 1] -= dy * k; this.pos[b + 2] -= dz * k;
      }
    }
  }
}

const veilVertex = /* glsl */ `
  attribute float aSide;
  attribute float aAlong;
  attribute vec3 aTangent;
  uniform float uWidth;
  uniform vec3 uCamPos;
  varying float vAlong;
  varying vec3 vWorld;

  void main() {
    vec3 world = position;
    vec3 view = normalize(uCamPos - world);
    vec3 side = normalize(cross(normalize(aTangent), view));
    // Tapered: an oral arm is widest where it leaves the bell and comes to
    // nothing at the tip.
    float w = uWidth * (1.0 - aAlong) * (1.0 - aAlong * 0.4);
    world += side * aSide * w;
    vAlong = aAlong;
    vWorld = world;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const veilFragment = /* glsl */ `
  precision highp float;
  varying float vAlong;
  varying vec3 vWorld;
  uniform sampler2D uRamp;
  uniform sampler2D uWaterRamp;
  uniform vec3 uCamPos;
  uniform float uTime;
  uniform float uFlow;
  uniform float uFade;
  uniform float uFrill;
  uniform vec3 uLed;

  ${WATER_GLSL}

  void main() {
    float lit = descent(vWorld.y) * shaft(vWorld, uTime, uFlow);
    // Frilled rather than smooth: the arms in the reference are ruffled sheets,
    // and what reads as ruffle at this size is a fast variation in brightness
    // along the arm, not geometry.
    float frill = 0.5 + 0.5 * sin(vAlong * 90.0 + vWorld.y * 6.0);
    // Kept off the top of the ramp. The veil ramp's last bucket is the
    // brightest thing in the picture by a distance, and the bloom threshold
    // sits below it: an arm crossing a light shaft went to white and smeared a
    // headlight across the glass. Tissue this thin is bright, not incandescent.
    float s = 0.30 + 0.34 * lit + uFrill * 0.20 * frill - 0.32 * vAlong
            + (1.0 - uFrill) * 0.16;
    float banded = floor(s * 5.0 + 0.5) / 5.0;
    s = clamp(mix(s, banded, 0.4), 0.0, 1.0);

    vec3 col = texture2D(uRamp, vec2(s, 0.5)).rgb;
    float dist = length(uCamPos - vWorld);
    // Veiled by depth, but the tank is only two radii deep and the veil was
    // eating four fifths of an animal at the back wall — which is most of the
    // population, and it is why the tank read as a painted blue surface with a
    // couple of smudges on it. Water this clear does not do that: the reference
    // shows its far animals plainly, dimmer and bluer but *there*.
    float veil = 1.0 - exp(-max(0.0, dist - 5.6) * 0.24);
    float ws = clamp(lit * 1.3, 0.0, 1.0);
    col = mix(col, texture2D(uWaterRamp, vec2(ws, 0.5)).rgb, veil * 0.58);

    // Thin tissue, and *thin* is the word the last version did not honour: at
    // 0.92 an oral arm was an opaque tube, and six of them made a solid white
    // sausage hanging off a solid pink dome. An oral arm is a frilled sheet one
    // cell thick. You see the water through it, you see the animal's own other
    // arms through it, and the ruffles are what little of it is dense enough to
    // read at all.
    //
    // So the frill drives the *opacity* and not only the tone: dense where the
    // sheet folds back on itself, nearly clear between. That is what makes a
    // lace edge rather than a painted ribbon, and it is most of the 透明感 the
    // reference has and this did not.
    col *= uLed;
    // Two different tissues out of one shader.
    //
    // An oral arm is a frilled sheet and reads as lace: the ruffle drives its
    // opacity, dense where it folds and nearly clear between. A tentacle is
    // not a sheet at all — it is a single fishing line, one or two pixels
    // wide, and the reference's are the highest-contrast thing in the water
    // after the bells. Giving it the arm's lacy alpha made it disappear
    // entirely, which is why the tank had no threads in it.
    float lace = 0.16 + 0.34 * frill;
    float a = uFade * (1.0 - vAlong * 0.72) * mix(0.78, lace, uFrill);
    gl_FragColor = vec4(col, a);
  }
`;

export interface Jellyfish {
  /** The bell, at the animal's position. */
  group: THREE.Group;
  /** The arms and tentacles. Their vertices are chain nodes, which are already
   * in world space, so this group must stay at the identity — it is added to
   * the scene beside `group`, never inside it. */
  ribbons: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  species: Species;
  seed: number;
  size: number;
  fade: number;
  step: (dt: number, time: number, flow: number, flowField: (x: number, y: number, z: number, out: THREE.Vector3) => void) => void;
  dispose: () => void;
}

const sharedBell = { geometry: null as THREE.BufferGeometry | null };

export function createJellyfish(opts: JellyfishOptions, shared: {
  bell: THREE.DataTexture;
  veil: THREE.DataTexture;
  water: THREE.DataTexture;
  camPos: THREE.Vector3;
}): Jellyfish {
  const { species, seed, size, period } = opts;
  if (!sharedBell.geometry) sharedBell.geometry = bellGeometry();

  const group = new THREE.Group();
  const bellMat = new THREE.ShaderMaterial({
    uniforms: {
      uPulse: { value: rand(seed, 1) },
      uSeed: { value: rand(seed, 2) },
      uTime: { value: 0 },
      uFlow: { value: 0.5 },
      uFade: { value: 0 },
      uRamp: { value: shared.bell },
      uLed: { value: LED },
      uWaterRamp: { value: shared.water },
      uCamPos: { value: shared.camPos },
    },
    vertexShader: bellVertex,
    fragmentShader: bellFragment,
    transparent: true,
    depthWrite: false,
    // Front faces only. Drawing both and blending them at equal weight turned
    // every bell into a muddle of its own far side; the reference's bells are
    // single clean masses, and what little of the underside shows through is
    // already carried by the transmission term.
    side: THREE.FrontSide,
    blending: THREE.NormalBlending,
  });
  const bell = new THREE.Mesh(sharedBell.geometry, bellMat);
  bell.scale.setScalar(size);
  bell.frustumCulled = false;
  group.add(bell);

  // The two species differ only in how much of them is arm.
  //
  // Lengths are in bell radii, and they are long: in the reference a bell is
  // about 90 px across and its tentacles trail three to four bell widths
  // behind it. The first version's strands were a third of that and read as
  // stubble.
  const armCount = species === 'bell' ? 6 : 5;
  // The reference's animals trail a *curtain* — twenty-odd threads at least,
  // crossing each other and streaming much further than the bell is wide.
  const tentacleCount = species === 'bell' ? 24 : 28;
  const armNodes = species === 'bell' ? 20 : 26;
  const armSegment = size * (species === 'bell' ? 0.42 : 0.68);
  const tentacleNodes = species === 'bell' ? 18 : 24;
  const tentacleSegment = size * (species === 'bell' ? 0.86 : 1.35);

  const chains: { chain: Chain; kind: 'arm' | 'tentacle'; anchor: THREE.Vector3 }[] = [];
  const root = new THREE.Vector3();
  for (let i = 0; i < armCount; i++) {
    const a = (i / armCount) * Math.PI * 2 + rand(seed, 10 + i) * 0.5;
    const anchor = new THREE.Vector3(Math.cos(a) * size * 0.30, -size * 0.12, Math.sin(a) * size * 0.30);
    chains.push({ chain: new Chain(armNodes, armSegment, root), kind: 'arm', anchor });
  }
  for (let i = 0; i < tentacleCount; i++) {
    const a = (i / tentacleCount) * Math.PI * 2 + rand(seed, 30 + i) * 0.4;
    const anchor = new THREE.Vector3(Math.cos(a) * size * 0.95, -size * 0.02, Math.sin(a) * size * 0.95);
    // Each strand a different length. Identical strands drift as one sheet,
    // which is the single clearest tell that a jellyfish is a simulation: real
    // tentacles are ragged and cross each other.
    const vary = 0.65 + rand(seed, 50 + i) * 0.8;
    chains.push({ chain: new Chain(tentacleNodes, tentacleSegment * vary, root), kind: 'tentacle', anchor });
  }

  // One ribbon mesh for the arms and one for the tentacles, so the whole
  // animal is four draw calls however many strands it has.
  const buildRibbons = (kind: 'arm' | 'tentacle') => {
    const set = chains.filter((c) => c.kind === kind);
    const nodes = set[0].chain.nodes;
    const verts = set.length * nodes * 2;
    const geometry = new THREE.BufferGeometry();
    const position = new Float32Array(verts * 3);
    const tangent = new Float32Array(verts * 3);
    const side = new Float32Array(verts);
    const along = new Float32Array(verts);
    const index: number[] = [];
    for (let c = 0; c < set.length; c++) {
      for (let n = 0; n < nodes; n++) {
        const base = (c * nodes + n) * 2;
        side[base] = -1; side[base + 1] = 1;
        along[base] = along[base + 1] = n / (nodes - 1);
        if (n < nodes - 1) {
          index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
      }
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aTangent', new THREE.BufferAttribute(tangent, 3));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geometry.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    geometry.setIndex(index);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        // Slender. The arms were a third of a bell radius wide, which on a
        // six-armed animal is a solid mass; the reference's are ribbons a
        // tenth of the bell across, and it is the *number* of them crossing
        // each other that fills the space, not the width of any one.
        uWidth: { value: kind === 'arm' ? size * (species === 'bell' ? 0.15 : 0.09) : size * 0.022 },
        uCamPos: { value: shared.camPos },
        uRamp: { value: shared.veil },
        uLed: { value: LED },
        uWaterRamp: { value: shared.water },
        uTime: { value: 0 },
        uFlow: { value: 0.5 },
        uFade: { value: 0 },
        uFrill: { value: kind === 'arm' ? 1 : 0 },
      },
      vertexShader: veilVertex,
      fragmentShader: veilFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return { mesh, material, geometry, set, nodes, position, tangent };
  };
  const arms = buildRibbons('arm');
  const tentacles = buildRibbons('tentacle');
  const ribbonGroup = new THREE.Group();
  ribbonGroup.add(arms.mesh, tentacles.mesh);
  ribbonGroup.matrixAutoUpdate = false;

  const jelly: Jellyfish = {
    group,
    ribbons: ribbonGroup,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    species,
    seed,
    size,
    fade: 0,
    step(dt, time, flow, flowField) {
      const phase = time / period + rand(seed, 1);
      bellMat.uniforms.uPulse.value = phase;
      bellMat.uniforms.uTime.value = time;
      bellMat.uniforms.uFlow.value = flow;
      bellMat.uniforms.uFade.value = jelly.fade;
      group.position.copy(jelly.position);

      for (const ribbons of [arms, tentacles]) {
        ribbons.material.uniforms.uTime.value = time;
        ribbons.material.uniforms.uFlow.value = flow;
        ribbons.material.uniforms.uFade.value = jelly.fade;
      }

      const anchor = new THREE.Vector3();
      for (const c of chains) {
        anchor.copy(c.anchor).applyQuaternion(group.quaternion).add(jelly.position);
        c.chain.step(dt, anchor, flowField, c.kind === 'arm' ? 0.90 : 0.94);
      }

      // Copy the chains into the ribbon meshes.
      for (const ribbons of [arms, tentacles]) {
        const { set, nodes, position, tangent } = ribbons;
        for (let c = 0; c < set.length; c++) {
          const p = set[c].chain.pos;
          for (let n = 0; n < nodes; n++) {
            const a = Math.max(0, n - 1) * 3, b = Math.min(nodes - 1, n + 1) * 3;
            const tx = p[b] - p[a], ty = p[b + 1] - p[a + 1], tz = p[b + 2] - p[a + 2];
            for (let s = 0; s < 2; s++) {
              const v = ((c * nodes + n) * 2 + s) * 3;
              position[v] = p[n * 3];
              position[v + 1] = p[n * 3 + 1];
              position[v + 2] = p[n * 3 + 2];
              tangent[v] = tx; tangent[v + 1] = ty; tangent[v + 2] = tz;
            }
          }
        }
        ribbons.geometry.attributes.position.needsUpdate = true;
        ribbons.geometry.attributes.aTangent.needsUpdate = true;
      }
    },
    dispose() {
      bellMat.dispose();
      for (const r of [arms, tentacles]) { r.material.dispose(); r.geometry.dispose(); }
    },
  };
  return jelly;
}

/** The textures every individual shares. One set for the whole swarm — the
 * ramps are the picture's, not an individual's. */
export function sharedTextures(camPos: THREE.Vector3) {
  return { bell: bellRamp(), veil: veilRamp(), water: waterRamp(), camPos };
}

export { TANK_HEIGHT };
