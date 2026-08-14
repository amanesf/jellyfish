import * as THREE from 'three';
import { TANK_HEIGHT } from '../core/tank';
import { createJellyfish, rand, sharedTextures, type Jellyfish, type Species } from './jellyfish';

/**
 * The population, and the reason the tank never repeats (plan.md §1, §8.2).
 *
 * The requirement is stronger than "it loops seamlessly": nothing may come back.
 * An individual is a draw from the distribution with a seed that has never been
 * used — a different size, a different pulse period, a different number of
 * lobes on its bell, a different path through the flow. sakura learned this the
 * hard way with clouds that came back around by modular arithmetic
 * (image-sky-plan.md §2). The seed counter is what guarantees it here: it only
 * ever increases, so the hundredth jellyfish of a session cannot be the first
 * one again.
 *
 * **Nothing dies on a timer, and nothing sinks out of the world.** The
 * population used to turn over: each animal carried a lifetime of 95 to 225
 * seconds and faded out at the end of it, and anything that drifted below the
 * floor was retired on the spot — which is what was happening to the ones that
 * reached the bottom. Both are visible, and a tank where animals wink out while
 * you are watching one is not something you can watch for an hour; it is the
 * opposite of the only thing this app is for. The turnover was solving a
 * problem that does not exist. Novelty comes from the flow, which is
 * aperiodic, and from the Verlet chains, which never return to a pose: the same
 * eight animals never repeat themselves.
 *
 * So the tank is closed. The population changes only when the viewer moves the
 * 個体数 knob, and then it changes slowly, at the back of the tank, where a
 * tank's depth of water is already doing the fading.
 *
 * The flow they drift in is a curl-noise field — the curl of a vector potential
 * is divergence-free, which is what makes it look like water rather than like
 * wind: nothing is created or destroyed at any point in it, so the animals
 * fold and circulate instead of piling up in a corner.
 */

const MAX_POPULATION = 20;

/** How far above the floor and below the surface an animal may be. The bells
 * in the reference never touch either. */
const Y_LOW = 0.25;

/** Seconds an arrival takes to gain substance, and a departure to lose it.
 * Long, because the eye catches a change of opacity long before it catches a
 * change of position. */
const ARRIVE = 7, LEAVE = 5;
const Y_HIGH = TANK_HEIGHT - 0.35;

export interface Swarm {
  update: (dt: number, time: number, count: number, flow: number) => void;
  /** Back-to-front, for the transparent passes. */
  sortForCamera: (camera: THREE.Camera) => void;
  dispose: () => void;
}

interface Member {
  jelly: Jellyfish;
  age: number;
  /** Set only when the count knob drops: the animal fades out over LEAVE
   * seconds and is then removed. Nothing else ever sets it. */
  leaving: boolean;
  /** Turn rate and heading — a jellyfish points where it is going, slowly. */
  heading: THREE.Quaternion;
  targetTilt: THREE.Vector3;
}

/** The same hash the shader's noise is built on (scene/water.ts explains why
 * it is the sin-based one and not the popular fract-chain). */
function hash(x: number, y: number, z: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return v - Math.floor(v);
}

function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf), sz = zf * zf * (3 - 2 * zf);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (i: number, j: number, k: number) => hash(xi + i, yi + j, zi + k);
  const c00 = lerp(c(0, 0, 0), c(1, 0, 0), sx);
  const c10 = lerp(c(0, 1, 0), c(1, 1, 0), sx);
  const c01 = lerp(c(0, 0, 1), c(1, 0, 1), sx);
  const c11 = lerp(c(0, 1, 1), c(1, 1, 1), sx);
  return lerp(lerp(c00, c10, sy), lerp(c01, c11, sy), sz);
}

/**
 * The flow: the curl of a vector potential, which is divergence-free by
 * construction.
 *
 * That property is the whole reason for using it. A plain noise field has
 * sources and sinks in it, and animals carried by one end up piled in the
 * sinks — which is what the first version did, with all nine of them strung out
 * along a single diagonal like a shoal. Water has no sinks: what goes into a
 * region comes out of it, so the individuals fold past each other and spread.
 *
 * Three *independent* potentials, sampled at three offsets. Deriving all three
 * components from one scalar (the first attempt) is not a curl at all and gives
 * a field with a strong preferred direction.
 */
function curl(x: number, y: number, z: number, t: number, out: THREE.Vector3): void {
  const e = 0.3;
  const scale = 0.75;
  const px = (a: number, b: number, c: number) => noise3(a * scale + t * 0.02, b * scale, c * scale);
  const py = (a: number, b: number, c: number) => noise3(a * scale + 31.4, b * scale - t * 0.017, c * scale + 12.7);
  const pz = (a: number, b: number, c: number) => noise3(a * scale - 7.3, b * scale + 5.1, c * scale + t * 0.023);
  const dpz_dy = (pz(x, y + e, z) - pz(x, y - e, z)) / (2 * e);
  const dpy_dz = (py(x, y, z + e) - py(x, y, z - e)) / (2 * e);
  const dpx_dz = (px(x, y, z + e) - px(x, y, z - e)) / (2 * e);
  const dpz_dx = (pz(x + e, y, z) - pz(x - e, y, z)) / (2 * e);
  const dpy_dx = (py(x + e, y, z) - py(x - e, y, z)) / (2 * e);
  const dpx_dy = (px(x, y + e, z) - px(x, y - e, z)) / (2 * e);
  out.set(dpz_dy - dpy_dz, dpx_dz - dpz_dx, dpy_dx - dpx_dy);
}

export function createSwarm(scene: THREE.Scene, camPos: THREE.Vector3): Swarm {
  const shared = sharedTextures(camPos);
  const members: Member[] = [];
  let nextSeed = 1;
  let simTime = 0;
  let flowNow = 0.5;

  const flowField = (x: number, y: number, z: number, out: THREE.Vector3) => {
    curl(x, y, z, simTime, out);
    // Slower (item ③). The tank this is copied from is a still one: the water
    // moves a bell's width in a few seconds, not in one. At the old 0.9 + 2.4f
    // the whole population crossed the frame while you watched, which reads as
    // a current rather than as water.
    out.multiplyScalar(0.55 + flowNow * 1.5);
    // The tank is stirred from above, so there is a slow downwelling at the
    // wall and a rise up the middle. It is also what keeps animals off the
    // glass without a wall force that would look like a wall force.
    // Gentle, and gentler than the first version: at 0.10 the whole population
    // ended up in a knot on the axis, which is not how the reference's tank
    // looks — its animals are spread right across the width, and two of them
    // are nearly touching the glass.
    const r = Math.hypot(x, z) || 1e-5;
    out.x += (-x / r) * 0.035 * (r - 0.72);
    out.z += (-z / r) * 0.035 * (r - 0.72);
    out.y += (0.62 - r) * 0.06;
  };

  const spawn = (initial: boolean): Member => {
    const seed = nextSeed++;
    // Two thirds ribbons: in the reference the pale trailing ones outnumber the
    // warm bells, and they are what fills the tank.
    const species: Species = rand(seed, 0) < 0.36 ? 'bell' : 'ribbon';
    // Measured off the reference: its warm bells are 90-105 px across against
    // the tank's 704, so a bell radius is about 0.07 tank radii, and the pale
    // ones behind are half that. The first version was half again too big and
    // two of them filled the middle of the picture.
    // Measured off the reference at about 0.07 tank radii for a warm bell, and
    // then carried up by a third. The measurement is of the *reference*, whose
    // animals sit well back in a deep tank; at that size on a phone a bell is
    // 40 px across and its oral arms are a suggestion rather than a shape. The
    // animal is what the picture is for, so it is given the near half of the
    // depth range instead.
    const size = species === 'bell'
      ? 0.166 + rand(seed, 3) * 0.074
      : 0.088 + rand(seed, 3) * 0.060;
    // Slower, and slower than the textbook 0.8-1.4 Hz on purpose: those numbers
    // are for a small animal in open water, and what a big one in a display
    // tank does is closer to a stroke every two seconds. The rests between
    // bouts are in scene/jellyfish.ts.
    const period = species === 'bell'
      ? 1.55 + rand(seed, 4) * 0.75
      : 2.10 + rand(seed, 5) * 1.20;
    const jelly = createJellyfish({ species, seed, size, period }, shared);

    const angle = rand(seed, 6) * Math.PI * 2;
    // Spread across the whole annulus between the standpipe and the glass,
    // and biased outward by the square root so the *area* is covered evenly
    // rather than the radius — otherwise everything starts near the middle.
    // The middle is open now that the standpipe is gone, so the spawn annulus
    // is a disc with only enough of a hole to stop everything starting on the
    // axis at once.
    const inner = 0.10, outer = 0.86;
    const radius = Math.sqrt(inner * inner + rand(seed, 7) * (outer * outer - inner * inner));
    // Arrivals appear *in* the tank and fade up, rather than swimming in from
    // under the floor. The first version pushed them in from below Y_LOW and
    // most of them never made it: the flow is gentle and a jellyfish is barely
    // buoyant, so they hung under the floor until the out-of-bounds rule
    // retired them, and a tank asked for nine animals showed three.
    //
    // Fading in is not a dodge. At this size and this water, an animal a third
    // of the way back is already half-veiled (scene/jellyfish.ts), so something
    // gaining substance over three seconds reads as one swimming forward out of
    // the murk — which is exactly how they arrive in the reference.
    const y = Y_LOW + rand(seed, 8) * (Y_HIGH - Y_LOW);
    jelly.position.set(
      Math.cos(angle) * radius,
      y,
      // Arrivals come in at the *back*. This only ever happens because the
      // viewer asked for more animals, and it is the one moment the app has to
      // show something appearing: at the far wall there is a tank of water
      // between the animal and the eye, and that water is already most of the
      // way to hiding it, so it reads as one swimming forward out of the murk.
      initial ? Math.sin(angle) * radius : -Math.abs(Math.sin(angle) * radius) - 0.04,
    );
    jelly.fade = initial ? 1 : 0;
    scene.add(jelly.group, jelly.ribbons);

    return {
      jelly,
      age: initial ? rand(seed, 11) * 60 : 0,
      leaving: false,
      heading: new THREE.Quaternion(),
      targetTilt: new THREE.Vector3(),
    };
  };

  const retire = (m: Member) => {
    scene.remove(m.jelly.group, m.jelly.ribbons);
    m.jelly.dispose();
  };

  const force = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();
  const q = new THREE.Quaternion();

  return {
    update(dt, time, count, flow) {
      simTime = time;
      flowNow = flow;
      const wanted = Math.max(1, Math.min(MAX_POPULATION, Math.round(count)));
      const staying = members.filter((m) => !m.leaving);
      // One knob, both directions. An animal already on its way out is called
      // back rather than replaced if the knob comes back up — which is what
      // happens every time someone drags the slider past where they meant to
      // stop, and it should not cost the tank an animal.
      if (staying.length < wanted) {
        for (let i = members.length - 1; i >= 0 && staying.length < wanted; i--) {
          if (members[i].leaving) { members[i].leaving = false; staying.push(members[i]); }
        }
        while (staying.length < wanted) {
          const m = spawn(members.length === 0 || time < 0.5);
          members.push(m);
          staying.push(m);
        }
      } else if (staying.length > wanted) {
        // The oldest leaves first, and it leaves by *fading over LEAVE
        // seconds*, not by being deleted under the viewer's eye.
        let n = staying.length - wanted;
        while (n-- > 0) {
          let oldest = -1;
          for (let i = 0; i < members.length; i++) {
            if (members[i].leaving) continue;
            if (oldest < 0 || members[i].age > members[oldest].age) oldest = i;
          }
          if (oldest >= 0) members[oldest].leaving = true;
        }
      }

      // They keep out of each other's way.
      //
      // Without this the tank clumps, and it clumps worse now that nothing
      // dies: the flow is slow and divergence-free, but it still has slack
      // regions, and given ten minutes every animal finds one — a picture of
      // eight jellyfish with six of them in the same corner. Real ones do not
      // stack up either, and the reason is the same as the reason this works:
      // an animal displaces water, so the water between two of them pushes
      // them apart. Quadratic in the population, which is at most twenty.
      for (let a = 0; a < members.length; a++) {
        const ja = members[a].jelly;
        for (let b = a + 1; b < members.length; b++) {
          const jb = members[b].jelly;
          tmp.subVectors(ja.position, jb.position);
          const reach = (ja.size + jb.size) * 3.4;
          const d = tmp.length();
          if (d > reach || d < 1e-5) continue;
          const push = (1 - d / reach) * 0.55 * dt;
          tmp.multiplyScalar(push / d);
          ja.velocity.add(tmp);
          jb.velocity.sub(tmp);
        }
      }

      for (let i = members.length - 1; i >= 0; i--) {
        const m = members[i];
        const j = m.jelly;
        m.age += dt;

        // Thrust: the bell's contraction pushes it along its own axis. The
        // pulse is asymmetric (jellyfish.ts), so this is a series of surges,
        // and the drag between them is what makes it coast.
        // From the bell's own phase (jellyfish.ts), which is the only place
        // that knows it: this used to recompute a pulse here from the clock
        // with periods of its own — 1.2 and 1.9, which matched nothing — so the
        // animal surged on a beat its bell was not keeping, and it surged
        // straight through the rests.
        tmp.set(0, 1, 0).applyQuaternion(j.group.quaternion);
        // An upside-down animal does not drive itself into the floor.
        //
        // Letting them turn over (item 6) had a consequence: an inverted one
        // still pushed along its own axis, which now pointed down, so over a
        // few minutes the whole population swam itself into the bottom of the
        // tank. A real jellyfish inverted does not get thrust out of a stroke
        // either — it has statocysts, it knows which way up it is, and what a
        // stroke buys it in that attitude is a *righting* turn rather than
        // travel. So thrust falls away as the bell tips past horizontal, and
        // what is left of the stroke goes into standing back up (below).
        const upness = tmp.y * 0.5 + 0.5;
        j.velocity.addScaledVector(tmp, j.thrust * dt * j.size * 1.5 * (0.18 + 0.82 * upness));

        flowField(j.position.x, j.position.y, j.position.z, force);
        j.velocity.addScaledVector(force, dt * 0.55);
        j.velocity.multiplyScalar(Math.pow(0.14, dt)); // water, not air
        // Neutrally buoyant, and it has to be exactly that.
        //
        // This used to be a steady -0.02, "very slightly heavy", and over a
        // couple of minutes very slightly heavy is the whole tank: everything
        // ended up on the floor, where the out-of-bounds rule took it away.
        // That is the disappearing-at-the-bottom the tank was doing. A moon
        // jelly is the same density as the water it lives in; what keeps it off
        // the floor is that it pulses, and what brings it down is nothing.
        j.position.addScaledVector(j.velocity, dt);

        /*
         * Heading (item ⑥).
         *
         * It follows the flow, slowly, and never quite gets there — a jellyfish
         * that snapped to its velocity would read as a fish. What is new is that
         * it is no longer *held upright*: the old code pulled every target 72%
         * of the way back to straight up, so the animals rocked a few degrees
         * and nothing in the tank ever turned over. Real ones do, constantly.
         * A jellyfish has no way to right itself except by pulsing, so while it
         * is resting the water simply rolls it, and it can end up on its side or
         * fully inverted, and then swim off downward until it turns again.
         *
         * So the upright bias is the animal's own swimming: full while it is
         * pulsing, gone while it is resting, and slightly negative for a while
         * on some individuals — `keel` swings slowly between about -0.35 and
         * 0.85 on a per-animal cycle — which is what actually puts one upside
         * down rather than merely tilted.
         */
        const keel = 0.85 - 1.2 * (0.5 + 0.5 * Math.sin(time * 0.021 + rand(j.seed, 21) * 6.28))
                     * (1 - j.activity) * (0.35 + rand(j.seed, 22) * 0.75);
        // Righting: a swimming animal that finds itself over pulls harder
        // toward upright than one that is merely tilted, which is what a
        // statocyst is for. It is still slow — a few strokes, not a flip.
        const righting = j.activity * (1 - upness);
        tmp.copy(force).normalize();
        if (tmp.lengthSq() > 1e-6) {
          // Turning is much slower while resting: nothing is driving it but the
          // water, and the water turns a jellyfish over the way it turns a leaf.
          tmp.lerp(up, Math.max(-1, Math.min(1, keel + righting)));
          if (tmp.lengthSq() > 1e-6) {
            q.setFromUnitVectors(up, tmp.normalize());
            j.group.quaternion.slerp(q, 1 - Math.pow(0.55, dt * (0.25 + 0.75 * j.activity)));
          }
        }

        // Keep it off the glass and the pipe without anything that reads as a
        // wall: the flow already pushes inward, this only catches the strays.
        const r = Math.hypot(j.position.x, j.position.z);
        const outer = 0.92 - j.size;
        if (r > outer) {
          const k = outer / r;
          j.position.x *= k; j.position.z *= k;
          j.velocity.x *= 0.3; j.velocity.z *= 0.3;
        }

        // The floor and the surface, as water rather than as walls. A soft
        // push over the last fifth of a tank radius, and a hard stop behind it
        // that the push means nothing ever reaches. There is no rule below this
        // one: an animal at the bottom of the tank is an animal at the bottom
        // of the tank, and it stays there until the water moves it.
        const nearFloor = Y_LOW + 0.20 - j.position.y;
        if (nearFloor > 0) j.velocity.y += nearFloor * 0.55 * dt;
        const nearTop = j.position.y - (Y_HIGH - 0.20);
        if (nearTop > 0) j.velocity.y -= nearTop * 0.55 * dt;
        if (j.position.y > Y_HIGH) {
          j.position.y = Y_HIGH;
          j.velocity.y = Math.min(j.velocity.y, 0);
        }
        if (j.position.y < Y_LOW) {
          j.position.y = Y_LOW;
          j.velocity.y = Math.max(j.velocity.y, 0);
        }

        j.fade = m.leaving
          ? j.fade - dt / LEAVE
          : Math.min(1, j.fade + dt / ARRIVE);

        j.step(dt, time, flow, flowField);

        if (m.leaving && j.fade <= 0) {
          retire(m);
          members.splice(i, 1);
        }
      }
    },
    sortForCamera(camera) {
      // Transparent, depth-write off: the draw order *is* the depth sort.
      const eye = camera.position;
      for (const m of members) {
        const d = eye.distanceToSquared(m.jelly.position);
        m.jelly.group.renderOrder = 1000 - d;
        m.jelly.ribbons.renderOrder = 1000 - d + 0.5;
      }
    },
    dispose() {
      for (const m of members) retire(m);
      members.length = 0;
    },
  };
}
