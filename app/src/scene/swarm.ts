import * as THREE from 'three';
import { PIPE_RADIUS, TANK_HEIGHT } from '../core/tank';
import { createJellyfish, pulse, rand, sharedTextures, type Jellyfish, type Species } from './jellyfish';

/**
 * The population, and the reason the tank never repeats (plan.md §1, §8.2).
 *
 * The requirement is stronger than "it loops seamlessly": nothing may come back.
 * An individual that leaves is *gone*, and what takes its place is a new draw
 * from the same distribution with a seed that has never been used — a different
 * size, a different pulse period, a different number of lobes on its bell, a
 * different path through the flow. sakura learned this the hard way with clouds
 * that came back around by modular arithmetic (image-sky-plan.md §2), and the
 * fix there is the fix here: a lifetime and a fresh seed, never a wrap.
 *
 * The seed counter is what guarantees it. It only ever increases, so the
 * hundredth jellyfish of a session cannot be the first one again.
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
const Y_HIGH = TANK_HEIGHT - 0.35;

export interface Swarm {
  update: (dt: number, time: number, count: number, flow: number) => void;
  /** Back-to-front, for the transparent passes. */
  sortForCamera: (camera: THREE.Camera) => void;
  dispose: () => void;
}

interface Member {
  jelly: Jellyfish;
  /** Seconds. An individual is retired when it runs out, or when it leaves. */
  life: number;
  age: number;
  /** Turn rate and heading — a jellyfish points where it is going, slowly. */
  heading: THREE.Quaternion;
  targetTilt: THREE.Vector3;
}

/** Value noise, matching the shader's, so the water the jellyfish drift in is
 * the same field the light shafts come from. */
function hash21(x: number, y: number): number {
  let px = (x * 123.34) % 1, py = (y * 456.21) % 1;
  const d = px * px + py * py + px * 45.32 + py * 45.32;
  px = (px + d) % 1; py = (py + d) % 1;
  return (px * py * 43758.5453) % 1;
}

function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf), sz = zf * zf * (3 - 2 * zf);
  const corner = (i: number, j: number, k: number) => Math.abs(hash21(xi + i + (zi + k) * 57.1, yi + j + (zi + k) * 31.7));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = lerp(corner(0, 0, 0), corner(1, 0, 0), sx);
  const c10 = lerp(corner(0, 1, 0), corner(1, 1, 0), sx);
  const c01 = lerp(corner(0, 0, 1), corner(1, 0, 1), sx);
  const c11 = lerp(corner(0, 1, 1), corner(1, 1, 1), sx);
  return lerp(lerp(c00, c10, sy), lerp(c01, c11, sy), sz);
}

/** Curl of a scalar-derived potential. Divergence-free by construction. */
function curl(x: number, y: number, z: number, t: number, out: THREE.Vector3): void {
  const e = 0.35;
  const pot = (a: number, b: number, c: number) => noise3(a * 0.9 + t * 0.03, b * 0.9, c * 0.9 - t * 0.02);
  const dydz = (pot(x, y + e, z) - pot(x, y - e, z)) / (2 * e);
  const dzdy = (pot(x, y, z + e) - pot(x, y, z - e)) / (2 * e);
  const dxdz = (pot(x + e, y, z) - pot(x - e, y, z)) / (2 * e);
  out.set(dydz - dzdy, dxdz - dydz, dzdy - dxdz);
}

export function createSwarm(scene: THREE.Scene, camPos: THREE.Vector3): Swarm {
  const shared = sharedTextures(camPos);
  const members: Member[] = [];
  let nextSeed = 1;
  let simTime = 0;
  let flowNow = 0.5;

  const flowField = (x: number, y: number, z: number, out: THREE.Vector3) => {
    curl(x, y, z, simTime, out);
    out.multiplyScalar(0.9 + flowNow * 2.4);
    // The tank is stirred from above, so there is a slow downwelling at the
    // wall and a rise up the middle. It is also what keeps animals off the
    // glass without a wall force that would look like a wall force.
    const r = Math.hypot(x, z) || 1e-5;
    out.x += (-x / r) * 0.10 * (r - 0.55);
    out.z += (-z / r) * 0.10 * (r - 0.55);
    out.y += (0.55 - r) * 0.16;
  };

  const spawn = (initial: boolean): Member => {
    const seed = nextSeed++;
    // Two thirds ribbons: in the reference the pale trailing ones outnumber the
    // warm bells, and they are what fills the tank.
    const species: Species = rand(seed, 0) < 0.36 ? 'bell' : 'ribbon';
    const size = species === 'bell'
      ? 0.11 + rand(seed, 3) * 0.055
      : 0.05 + rand(seed, 3) * 0.035;
    const period = species === 'bell'
      ? 1.05 + rand(seed, 4) * 0.5
      : 1.5 + rand(seed, 5) * 0.9;
    const jelly = createJellyfish({ species, seed, size, period }, shared);

    const angle = rand(seed, 6) * Math.PI * 2;
    const radius = PIPE_RADIUS + 0.18 + rand(seed, 7) * (0.78 - PIPE_RADIUS);
    // An arriving animal starts low and rises, unless the tank is being filled
    // for the first time, in which case they are already spread through it.
    const y = initial
      ? Y_LOW + rand(seed, 8) * (Y_HIGH - Y_LOW)
      : Y_LOW - 0.15 - rand(seed, 8) * 0.3;
    jelly.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    jelly.fade = initial ? 1 : 0;
    scene.add(jelly.group, jelly.ribbons);

    return {
      jelly,
      life: 95 + rand(seed, 9) * 130,
      age: initial ? rand(seed, 11) * 60 : 0,
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
      while (members.length < wanted) members.push(spawn(members.length === 0 || time < 0.5));
      while (members.length > wanted) {
        // Retire the oldest rather than the newest: the newest has only just
        // arrived, and taking it back out is the one thing a viewer would see.
        let oldest = 0;
        for (let i = 1; i < members.length; i++) if (members[i].age > members[oldest].age) oldest = i;
        retire(members[oldest]);
        members.splice(oldest, 1);
      }

      for (let i = members.length - 1; i >= 0; i--) {
        const m = members[i];
        const j = m.jelly;
        m.age += dt;

        // Thrust: the bell's contraction pushes it along its own axis. The
        // pulse is asymmetric (jellyfish.ts), so this is a series of surges,
        // and the drag between them is what makes it coast.
        const phase = time / (j.species === 'bell' ? 1.2 : 1.9) + rand(j.seed, 1);
        const p = pulse(phase);
        const thrust = Math.max(0, p - pulse(phase - dt / 1.2)) / Math.max(dt, 1e-4);
        tmp.set(0, 1, 0).applyQuaternion(j.group.quaternion);
        j.velocity.addScaledVector(tmp, thrust * dt * j.size * 1.5);

        flowField(j.position.x, j.position.y, j.position.z, force);
        j.velocity.addScaledVector(force, dt * 0.55);
        j.velocity.multiplyScalar(Math.pow(0.14, dt)); // water, not air
        j.velocity.y -= 0.02 * dt;                      // very slightly heavy
        j.position.addScaledVector(j.velocity, dt);

        // Heading follows the flow, slowly, and never quite gets there. A
        // jellyfish that snapped to its velocity would read as a fish.
        tmp.copy(force).normalize();
        if (tmp.lengthSq() > 1e-6) {
          q.setFromUnitVectors(up, tmp.lerp(up, 0.72).normalize());
          j.group.quaternion.slerp(q, 1 - Math.pow(0.55, dt));
        }

        // Keep it off the glass and the pipe without anything that reads as a
        // wall: the flow already pushes inward, this only catches the strays.
        const r = Math.hypot(j.position.x, j.position.z);
        const inner = PIPE_RADIUS + j.size * 1.1;
        if (r < inner) {
          const k = inner / Math.max(r, 1e-4);
          j.position.x *= k; j.position.z *= k;
        }
        const outer = 0.92 - j.size;
        if (r > outer) {
          const k = outer / r;
          j.position.x *= k; j.position.z *= k;
          j.velocity.x *= 0.3; j.velocity.z *= 0.3;
        }

        j.fade = Math.min(1, j.fade + dt * 0.35);
        const left = m.life - m.age;
        if (left < 4) j.fade = Math.min(j.fade, Math.max(0, left / 4));
        if (j.position.y > Y_HIGH) {
          j.position.y = Y_HIGH;
          j.velocity.y = Math.min(j.velocity.y, 0);
        }

        j.step(dt, time, flow, flowField);

        // Gone means gone. The replacement is a new seed — never this one.
        if (m.age > m.life || j.position.y < Y_LOW - 0.6) {
          retire(m);
          members.splice(i, 1);
          members.push(spawn(false));
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
