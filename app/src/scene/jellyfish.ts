import * as THREE from 'three';
import { WATER_GLSL } from './water';
import { bellRamp, veilRamp, waterRamp } from './ramps';
import { LED_JELLY } from './led';
import { TANK_HEIGHT } from '../core/tank';
import { COC_GLSL, cocUniforms } from '../core/dof';

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

/**
 * The bell's shape at one instant, on the CPU.
 *
 * The vertex shader is the authority on where the skirt is; this is the same
 * arithmetic, evaluated for one angle at the rim, so the tentacles can be hung
 * off the rim *where the rim actually is* rather than off a circle of fixed
 * radius. Keep the two in step — every constant here has a twin in bellVertex.
 */
export function rimPoint(
  angleFrac: number, pulse: number, seed: number, time: number, lag: number,
  aRim: number, out: THREE.Vector3,
): void {
  const ang = angleFrac * Math.PI * 2;
  let p = pulse - aRim * 0.32 * lag;
  p = p - Math.floor(p);
  const smooth = (u: number) => { const c = Math.min(1, Math.max(0, u)); return c * c * (3 - 2 * c); };
  const contract = p < 0.25 ? smooth(p / 0.25) : 1 - smooth((p - 0.25) / 0.75);

  const lobes = Math.cos(ang * 16 + seed * 6.28 + Math.sin(time * 0.35 + seed) * 0.6);
  const scallop = 1 - 0.055 * lobes * aRim * aRim;
  const sweep = aRim * 1.5707963 * 1.26;
  const radius = Math.sin(sweep);
  const height = Math.cos(sweep) * 0.67;
  const squeeze = 1 - 0.24 * contract;
  const stretch = 1 + 0.30 * contract;
  const curl = 0.34 * contract * aRim * aRim;
  out.set(
    Math.cos(ang) * radius * scallop * squeeze,
    height * stretch - curl - 0.16 * aRim * aRim * aRim + 0.075 * lobes * aRim * aRim,
    Math.sin(ang) * radius * scallop * squeeze,
  );
}

const bellVertex = /* glsl */ `
  uniform float uPulse;
  uniform float uSeed;
  uniform float uTime;
  uniform float uLag;    // 1 while swimming, 0 while the bell rests
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
    //
    // The lag is scaled by uLag, which falls to zero when the animal stops
    // swimming. It has to: with a fixed lag there is no phase at which the
    // whole bell is relaxed — the rim is always a third of a stroke behind the
    // crown — so a bell frozen at any phase is a bell frozen mid-stroke. Letting
    // the lag run out as the animal comes to rest lets the rim catch up with
    // the crown, and the bell parks *open*, which is what a resting one does.
    float lag = aRim * 0.32 * uLag;
    float p = uPulse - lag;
    p = p - floor(p);
    float contract = p < 0.25 ? smoothstep(0.0, 1.0, p / 0.25)
                              : 1.0 - smoothstep(0.0, 1.0, (p - 0.25) / 0.75);

    // Scalloped, not smooth: sixteen lobes that pull the rim *in*, deepening
    // toward the edge, plus a slow wander so no two moments are the same.
    // Counted off the reference, where they are unmistakable — the rim is a
    // row of rounded tabs, not a circle — and given four times the depth they
    // had, because at 0.085 the scallop was inside the width of one pixel.
    float lobes = cos(ang * 16.0 + uSeed * 6.28 + sin(uTime * 0.35 + uSeed) * 0.6);
    float scallop = 1.0 - 0.055 * lobes * aRim * aRim;
    vLobe = lobes;

    // Past the equator, and this is the difference between a jellyfish and a
    // beanie.
    //
    // The dome used to sweep exactly 90 degrees, so its widest point *was* its
    // last point: the silhouette ended in a straight horizontal cut and the
    // animal read as a cap with threads glued under it. A bell does not end at
    // its equator — the skirt carries on past it and hangs down, which is why
    // the reference's silhouette ends in a row of scalloped tabs and why you
    // can see the underside of the animal at all. 113 degrees puts the rim
    // four tenths of a radius below the widest point, which is where the
    // reference's is.
    float sweep = aRim * 1.5707963 * 1.26;
    float radius = sin(sweep);
    // Flattened. A sphere swept past its equator is a ball with a skirt; the
    // reference's bells are three units across to two high, a wide shallow
    // dome that the skirt hangs off. Measured on the big one at the middle of
    // the frame: 110 px across the crown, 74 px from crown to rim.
    float height = cos(sweep) * 0.67;

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
    // The scallops go up and down as well as in and out. Pulling the tabs in
    // radially only shows on the two edges of the silhouette, where it is a
    // pixel of waviness; letting them hang at different heights is what makes
    // the rim read as a row of tabs from any angle, which is how the reference
    // reads from every angle it shows.
    p3.y += 0.075 * lobes * aRim * aRim;

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

  uniform sampler2D uRamp;      // the pigment: the measured warm population
  uniform sampler2D uVeilRamp;  // the tissue: the measured pale population
  uniform sampler2D uWaterRamp;
  uniform vec3 uCamPos;
  uniform float uTime;
  uniform float uFlow;
  uniform float uFade;   // 0 while a new individual is still arriving
  uniform vec4 uLed;     // xyz the lamp's colour, w how far it is turned

  ${WATER_GLSL}
  ${COC_GLSL}

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

    /*
     * Subsurface scattering, of the kind a thin translucent sheet actually does.
     *
     * What was here was a single transmission term: brightness where the sheet
     * is edge-on. That is the *silhouette* half of the effect and it misses the
     * half that makes a jellyfish look like a jellyfish — light that goes in
     * one side, bounces around inside the tissue and comes out the other,
     * toward the eye. Two things follow from that and neither is reachable
     * without a real scattering term:
     *
     *  - it is strongest when you are looking *along* the light, i.e. when the
     *    lamp is behind the animal. The ceiling is the only light in this tank,
     *    so this is what lights an animal from above while you look at it from
     *    the side, and it is why a bell over your eyeline glows and the same
     *    bell below it does not.
     *  - it *reddens with path length*. Scattering is wavelength-dependent;
     *    blue is scattered out of the beam first, so the longer the path the
     *    warmer what survives. On a jellyfish this is very visible: the thin
     *    crown transmits nearly white and the thick shoulder transmits amber.
     *
     * The thickness below is the path a ray takes through the dome at this point: short
     * where the sheet faces you, long where it is edge-on, and longer still
     * through the crown, which is where the animal is deepest front to back.
     */
    float thickness = mix(0.25, 1.0, facing) * (1.0 + 0.9 * (1.0 - vRim));
    // Forward scatter: the lobe around the direction the light is travelling.
    float forward = pow(max(dot(V, -L), 0.0), 3.0);
    // Back scatter, much weaker and much broader — the diffuse glow the tissue
    // has from every direction.
    float wrap = max(0.0, (dot(vNormalW, L) + 0.6) / 1.6);
    float sss = (0.62 * forward + 0.38 * wrap) * exp(-thickness * 0.85) * lit;

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
    // Sixteen, because the animal is an アカクラゲ (Chrysaora pacifica) and
    // sixteen radial brown bands is the field mark it is named for — a 9-15 cm
    // bell with sixteen stripes running from the crown out to the margin, and
    // the tentacles hanging in eight groups between them. Fourteen was a guess
    // off the painting; sixteen is the animal.
    //
    // The stripe is a wedge, not a stripe: it is a hair at the crown and widens
    // as it runs out, because it follows a radial canal that widens with the
    // bell. Raising the cosine to a power that *falls* with vRim is what draws
    // that, and it is why the reference's bells look drawn on rather than
    // striped like a beach ball.
    float band = 0.5 + 0.5 * cos(vAngle * 100.5310);
    float canal = pow(band, mix(16.0, 4.5, smoothstep(0.1, 1.0, vRim)));
    // The canals carry a lot more of the bell than they were given. In the
    // reference they are the *structure* of the animal — hard bright lines from
    // the crown to the rim over a saturated ground — and at 0.10 they were a
    // texture you had to look for. The rim is also brighter than the dome: a
    // bell is a thin sheet seen through its own edge there, and that edge is
    // where the reference puts its most saturated orange.
    // The crown, explicitly. The reference's bells are near white-hot at the
    // top and deepen to a saturated orange at the skirt, and a N·L term cannot
    // say that on a dome this shallow — its top and its shoulder differ by very
    // little. The gradient is the animal's own pigment, not its lighting.
    float crown = 1.0 - smoothstep(0.0, 0.72, vRim);
    float s = 0.24 + 0.30 * top * lit + 0.46 * through * lit + 0.05 * vLobe * vRim
            + 0.46 * crown
            - 0.50 * canal * smoothstep(0.06, 0.55, vRim);

    // Coarse on purpose. Four steps, softly joined: precise shading here turns
    // the bell into a glass ball, and the reference's bells are flat masses
    // with one bright crown and one dark underside.
    // Less posterised than it was. Four hard steps on a dome twice the size is
    // no longer "a flat mass with one bright crown" — it is a paper cut-out,
    // because at this scale each step is thirty pixels wide and the eye reads
    // the step and not the curve.
    float banded = floor(s * 5.0 + 0.5) / 5.0;
    s = clamp(mix(s, banded, 0.34), 0.0, 1.0);

    // Two tissues, and this is what the bell was missing (item 4).
    //
    // The whole dome was one lookup into the bell ramp, which is a measured
    // population of *saturated orange* pixels — so every bell in the tank came
    // out a solid orange cap, and an アカクラゲ's bell is not orange. It is
    // nearly colourless, a faintly pink glass dome, and the colour on it is
    // sixteen radial brown bands running from the crown to the margin. The
    // orange in the reference painting *is* those bands, read at a size where
    // they merge.
    //
    // So the ground is the pale-tissue ramp — the same one the oral arms and
    // the trailing animals are drawn from, which is the right population for
    // tissue that is tissue — and the bell ramp becomes the pigment laid over
    // it. Nothing leaves the measured palette; the two measured populations are
    // simply put where each belongs.
    vec3 flesh = texture2D(uVeilRamp, vec2(s, 0.5)).rgb;
    vec3 pigment = texture2D(uRamp, vec2(s, 0.5)).rgb;
    // The bands, plus the faint overall warmth the bell has between them, plus
    // the margin: the stripes broaden and run together at the very edge, which
    // is why an akakurage seen from the side has a dark hem.
    float mark = canal * smoothstep(0.02, 0.26, vRim);

    /*
     * The animal's insides, which it had none of.
     *
     * A scyphozoan bell is not a coloured shell — it is a transparent dome with
     * organs suspended under it, and on an akakurage you can see all of them
     * through it. Three, and they are what the bell was missing:
     *
     *  - the **stomach**, four gastric pouches around the mouth. They sit under
     *    the middle of the bell, they are the densest thing in the animal, and
     *    they are why the crown of a real one is not its palest part.
     *  - the **gonads**, four horseshoes following the outer edge of those
     *    pouches, at about half way out. These are the strongest markings on
     *    the animal after the stripes, and on a mature one they are what the
     *    eye actually reads as "jellyfish" from across a room.
     *  - the **rhopalia**, the eight sense organs at the margin, one in each
     *    notch between two clusters of tentacles. Tiny, dark, and the reason
     *    the rim is not an even scallop.
     *
     * All four-fold, all keyed off the same angle the stripes are, so they line
     * up with the quadrants of the animal the way they do on the real one.
     */
    float quad = cos(vAngle * 25.1327);            // four, around the bell
    float pouch = smoothstep(0.30, 0.0, vRim) * (0.45 + 0.55 * smoothstep(-0.2, 0.9, quad));
    // A horseshoe: an arc of a ring, open toward the middle of each quadrant.
    float ring = exp(-pow((vRim - 0.46) / 0.11, 2.0));
    float gonad = ring * smoothstep(-0.15, 0.75, quad);
    // Eight, in the gaps between the tentacle clusters, right at the margin.
    float rhopalia = pow(0.5 + 0.5 * cos(vAngle * 50.2655 + 3.14159), 26.0)
                   * smoothstep(0.86, 0.99, vRim);

    float organs = clamp(0.62 * pouch + 0.78 * gonad + 0.9 * rhopalia, 0.0, 1.0);
    // The ground is pigmented too, not only the bands. At 0.16 the bell was
    // six parts pale tissue to one part colour and came out *pink*; the
    // reference's are orange all over, with the bands darker orange over it.
    float stain = clamp(0.90 + 0.10 * mark + 0.10 * smoothstep(0.80, 1.0, vRim)
                        + 0.20 * organs, 0.0, 1.0);
    vec3 col = mix(flesh, pigment, stain);

    /*
     * The subumbrella — the inside of the bell, which is what an upside-down
     * animal shows you.
     *
     * It is a different surface and it has to look like one, or a bell seen
     * from below is just a dimmer bell seen from above. Three differences, all
     * of them things you can see on a jellyfish in a tank: it is much paler,
     * because the pigment is in the outer surface and you are looking at the
     * bands from behind; it carries the *coronal muscle*, a set of fine
     * concentric rings that is the only structured thing on it; and the organs
     * read harder, because nothing is in front of them.
     */
    if (!gl_FrontFacing) {
      float muscle = 0.5 + 0.5 * cos(vRim * 96.0);
      col = mix(flesh, col, 0.42);
      col *= 1.0 - 0.16 * pow(muscle, 3.0) * smoothstep(0.25, 0.95, vRim);
      col = mix(col, pigment, organs * 0.35);
    }

    // The wet sheen on the crown.
    //
    // The measured ramp stops at 253,200,139, because that is the brightest the
    // reference's bells *are* on average — and the reference also paints a hard
    // near-white highlight across the top of each crown that no average can
    // contain. Added rather than looked up, warm, and narrow: it is the ceiling
    // light on a wet dome. It is also what gives each animal the orange halo in
    // the reference, since it is the only part of a jellyfish bright enough to
    // reach the bloom threshold.
    float sheen = pow(max(top, 0.0), 7.0) * (1.0 - smoothstep(0.15, 0.62, vRim));
    // Carried up: the animals are the lit thing in a dark room and the crown
    // is the only part of one bright enough to reach the bloom threshold, so
    // this term is the whole of the halo each of them has.
    // Brighter, because the bell is opaque now. A solid dome with no highlight
    // on it is a plastic toy; the reference's crowns go to near-white and it is
    // the only part of the animal that reaches the bloom threshold, so this
    // term is also the whole of the orange halo each one carries.
    col += vec3(1.30, 0.92, 0.44) * sheen * lit;

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
    col = mix(col, texture2D(uWaterRamp, vec2(ws, 0.5)).rgb, veil * 0.40);

    // Translucent, and translucent the way a bell is: a thin dome seen through
    // its own thickness. Face-on you are looking through one sheet and the
    // water behind shows; at the silhouette the sight-line runs along the sheet
    // and it goes solid, which is exactly where the reference's bells carry
    // their most saturated orange. Drawn opaque — which is what this was — a
    // bell is a plastic toy in the water rather than a thing made of water.
    // The lamp takes the animal over.
    //
    // Multiplying by a tint — which is what this did — leaves an orange bell
    // orange under a cyan lamp, only muddier, because orange has almost no blue
    // for a blue lamp to multiply. That is right for a lit wall and wrong for a
    // jellyfish: nearly everything you see of one is light that went in, rattled
    // around inside and came back out, so under a coloured lamp the animals
    // *become* the lamp. Its own tone is kept as brightness and the hue is the
    // lamp's, at the strength the knob is turned to.
    float bright = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, uLed.rgb * bright, uLed.w);
    // ...and the crown highlight is emitted in it, which is what makes the
    // bloom halo around each animal come up in the lamp's colour too.
    col += uLed.rgb * sheen * lit * uLed.w * 0.55;
    // Thinner than it was. What the reference has and this did not is 透明感:
    // you should be able to see the water, the marine snow and the animal's own
    // far side through the face of a bell, and only the silhouette — where the
    // sight-line runs along the sheet — should go anywhere near solid.
    /*
     * ...and what the scattering carries out with it, which is the warm half.
     *
     * Added rather than mixed, because it is light and light adds, and taken
     * from the pigment ramp at a position set by the path length: a short path
     * fetches the ramp's pale top, a long one its deep amber. That is the
     * reddening described above, and it is read out of the measured population
     * rather than invented, so the animal still cannot leave the palette.
     */
    vec3 deep = texture2D(uRamp, vec2(clamp(1.0 - thickness * 0.42, 0.05, 0.95), 0.5)).rgb;
    col += deep * sss * 0.58 * (0.5 + 0.5 * stain);

    // A cold rim off the far side.
    //
    // The tank's light is a ceiling light, and everything in the picture is lit
    // from that one direction — so an animal's silhouette dies into the water
    // behind it. What separates it is the water's own glow coming past it: a
    // thin cold edge where the sheet is most nearly edge-on. Taken from the
    // water ramp, so it is the water's blue and not a light invented here.
    // Measured, not judged. The reference's bell population averages
    // R226 G155 B119 — green well above blue, which is what "orange" is in
    // numbers. This pipeline was landing R211 G120 B142, blue *above* green: a
    // magenta bell. The cold rim was most of it. A rim taken straight out of
    // the water ramp is pure blue laid along every silhouette in the tank, and
    // a bell is mostly silhouette. Halved, and warmed halfway to neutral so it
    // still separates the animal from the water behind it without repainting
    // the animal.
    float edge = pow(facing, 7.0);
    col += mix(texture2D(uWaterRamp, vec2(0.92, 0.5)).rgb, vec3(0.55, 0.52, 0.45), 0.5)
         * edge * (0.55 + 0.45 * lit) * 0.7;

    /*
     * Saturation (item 1).
     *
     * The reference's bells are the one hot thing in a cold picture: a
     * near-vermilion orange against cyan water, complementary and at full
     * chroma, and they read as light sources rather than as objects because of
     * it. The measured ramp has that chroma in it — the population it was taken
     * from is those bells — but the shading term spends most of its time in the
     * ramp's middle, and the middle of any measured population is where the
     * chroma has been averaged down. Expanded about the fragment's own
     * luminance, so the chroma rises and the tone does not move: nothing about
     * the picture's exposure changes.
     */
    float bellLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    // 1.45 overshot: measured against the reference the bells came out R239
    // G129 against its R226 G155 — the right hue family, too far round toward
    // vermilion. The ramp is already saturated (its population was selected for
    // strongly warm pixels, which is the saturated tail of the real bells), so
    // this only has to lift the middle of it.
    col = max(vec3(0.0), mix(vec3(bellLum), col, 1.16));

    /*
     * How solid the bell is, and the last and largest reason its colour was
     * wrong.
     *
     * At 0.20 base the *face* of a bell was one fifth animal and four fifths
     * the water behind it — so the pixel a viewer calls "the bell's colour" was
     * mostly tank. That is the whole of the residual blue: measured, the
     * composited bells came out B130 against G119 while the reference's are
     * G155 against B119, and the ramp being sampled is orange in both cases.
     *
     * "You should see the water through it" was right about a jellyfish and
     * wrong about this one. An akakurage's umbrella is thin but it is
     * pigmented, and in the reference you cannot see the far wall through the
     * middle of a bell — you see it through the skirt and around the margin,
     * which is where the sheet actually thins. So the body is solid and the
     * transparency is put where the animal has it.
     */
    float body = 0.62 + 0.26 * facing - 0.24 * smoothstep(0.72, 1.0, vRim);
    // The far surface of the same bell, at a third the weight: it is behind a
    // whole animal's worth of tissue, and drawn at full strength it doubles
    // every marking on the near side.
    if (!gl_FrontFacing) body *= 0.34;
    gl_FragColor = vec4(col, uFade * clamp(body, 0.0, 1.0));
    // For the depth-of-field buffer (core/dof.ts). The alpha is thresholded
    // rather than kept: a bell drawn at a third of an alpha would otherwise
    // blend its CoC with the water's and come out half sharp.
    if (uMode > 0.5) gl_FragColor = vec4(vec3(circleOfConfusion(vWorld, uCamPos)), step(0.04, gl_FragColor.a));
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

  /** Where this strand sits in its own sway cycle. Neighbouring strands must
   * not agree, or the curtain ripples as one sheet. */
  readonly sway: number;

  constructor(nodes: number, segment: number, root: THREE.Vector3, sway = 0) {
    this.nodes = nodes;
    this.segment = segment;
    this.sway = sway;
    this.pos = new Float32Array(nodes * 3);
    this.prev = new Float32Array(nodes * 3);
    for (let i = 0; i < nodes; i++) {
      this.pos[i * 3] = root.x;
      this.pos[i * 3 + 1] = root.y - i * segment;
      this.pos[i * 3 + 2] = root.z;
    }
    this.prev.set(this.pos);
  }

  step(dt: number, time: number, root: THREE.Vector3, flow: (x: number, y: number, z: number, out: THREE.Vector3) => void, drag: number) {
    const f = new THREE.Vector3();
    for (let i = 1; i < this.nodes; i++) {
      const k = i * 3;
      const px = this.pos[k], py = this.pos[k + 1], pz = this.pos[k + 2];
      flow(px, py, pz, f);
      // A ripple along the strand, and without it every thread in the tank is
      // straight.
      //
      // The curl field is smooth over about a tank radius, which is far longer
      // than a tentacle: every node of a strand samples very nearly the same
      // vector, so the whole thing is towed rigidly and forty of them read as a
      // broom rather than as a curtain. What bends a real one is turbulence at
      // its own scale — eddies the width of the strand — and that is what this
      // is: a travelling wave down the chain, out of phase with its neighbours,
      // growing toward the tip where there is nothing to hold it.
      const t = i / this.nodes;
      const w = t * t * 0.55;
      f.x += Math.sin(time * 1.15 + i * 0.85 + this.sway) * w;
      f.z += Math.cos(time * 0.93 + i * 0.72 + this.sway * 1.7) * w;
      // Verlet with drag, and a real sag.
      //
      // Gravity here used to be 0.05 against a flow field an order of magnitude
      // stronger, on the reasoning that jellyfish tissue is nearly neutrally
      // buoyant. It is — but a tentacle is also being *towed*, and with nothing
      // pulling down every strand in the tank streamed horizontally behind its
      // animal like a windsock. The reference's hang: they fall away from the
      // rim and the water bends them, rather than the water carrying them and
      // nothing bending them back.
      const vx = (px - this.prev[k]) * drag + (f.x - 0.0) * dt * dt;
      const vy = (py - this.prev[k + 1]) * drag + (f.y - 0.52) * dt * dt;
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
  uniform float uFrill;
  uniform float uSeed;
  uniform vec3 uCamPos;
  varying float vAlong;
  varying float vSide;
  varying float vTurn;
  varying vec3 vWorld;

  void main() {
    vec3 world = position;
    vec3 view = normalize(uCamPos - world);
    vec3 side = normalize(cross(normalize(aTangent), view));
    // Tapered: an oral arm is widest where it leaves the bell and comes to
    // nothing at the tip.
    float w = uWidth * (1.0 - aAlong) * (1.0 - aAlong * 0.4);

    /*
     * The ruffle, in the *silhouette* — which is the thing three attempts at
     * this missed and the reference makes obvious.
     *
     * Zoom into 1786667042546.png and an oral arm is a strip of white crepe
     * paper: its edge is torn, lumpy and scalloped, never straight for the
     * length of a bell, and it is that ragged outline you recognise from across
     * a room. Every version of this so far drew a smooth-edged ribbon and put
     * the frill in the *shading* — stripes on a straight strip — which is why
     * it kept reading as a painted band however the brightness was tuned.
     *
     * Two things do it, and both have to be in the geometry:
     *
     *  - the width varies along the arm at two incommensurate rates, so the
     *    edge is a run of lobes and pinches rather than a taper.
     *  - the arm twists. A frilled sheet in water turns over on itself every
     *    few centimetres, and each time it turns edge-on it nearly disappears
     *    and then opens out again. The ribbon is billboarded at the camera, so
     *    a twist is exactly a periodic collapse of its width — which is also
     *    why a real one looks like a run of separate scraps when it is one
     *    continuous sheet.
     */
    float lobes = 0.60 + 0.40 * sin(aAlong * 26.0 + uSeed * 6.28)
                       + 0.20 * sin(aAlong * 61.0 - uSeed * 3.10);
    float twist = 0.28 + 0.72 * abs(cos(aAlong * 8.5 + uSeed * 5.7));
    w *= mix(1.0, lobes * twist, uFrill);
    vTurn = twist;

    world += side * aSide * w;
    vAlong = aAlong;
    vSide = aSide;
    vWorld = world;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const veilFragment = /* glsl */ `
  precision highp float;
  varying float vAlong;
  varying float vSide;
  varying float vTurn;
  varying vec3 vWorld;
  uniform sampler2D uRamp;
  uniform sampler2D uWaterRamp;
  uniform vec3 uCamPos;
  uniform float uTime;
  uniform float uFlow;
  uniform float uFade;
  uniform float uFrill;
  uniform vec4 uLed;

  ${WATER_GLSL}
  ${COC_GLSL}

  void main() {
    float lit = descent(vWorld.y) * shaft(vWorld, uTime, uFlow);
    // Frilled rather than smooth: the arms in the reference are ruffled sheets,
    // and what reads as ruffle at this size is a fast variation in brightness
    // along the arm, not geometry.
    // Ruffled across the sheet as well as along it.
    //
    // One sine along the arm gives a ribbon with stripes on it. What makes the
    // reference's oral arms read as a *frill* is that the folds run out to the
    // edge and the edge is therefore ragged: the sheet is dense where a fold
    // turns toward you and nearly gone between folds, and both vary across the
    // width. Two frequencies crossed, and the outer edge of the ribbon weighted
    // so it is the part that breaks up.
    float frill = 0.5 + 0.5 * sin(vAlong * 62.0 + vWorld.y * 6.0 + vSide * 2.4);
    frill *= 0.55 + 0.45 * (0.5 + 0.5 * sin(vAlong * 17.0 - vSide * 5.5));
    frill = mix(frill, frill * (1.0 - 0.55 * abs(vSide)), uFrill);
    // Kept off the top of the ramp. The veil ramp's last bucket is the
    // brightest thing in the picture by a distance, and the bloom threshold
    // sits below it: an arm crossing a light shaft went to white and smeared a
    // headlight across the glass. Tissue this thin is bright, not incandescent.
    // The arms are the brightest thing in the water and the tentacles are not.
    // In the reference an oral arm is near-white where a fold turns to the
    // light, and it holds that brightness most of the way down its length —
    // the old fall of 0.32 with distance had the ribbon fading out half way,
    // which is what a tentacle does, not an arm.
    // High contrast, because the reference's arms are nearly black and white: a
    // fold turned to the light goes to paper-white and the crease beside it
    // drops to the water's own dark blue. One tone with a gentle ripple on it
    // is a ribbon; this is lace.
    float s = 0.30 + 0.34 * lit + uFrill * (0.30 * frill + 0.34 * vTurn)
            - (0.32 - 0.10 * uFrill) * vAlong
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
    // The lamp takes the tissue over the same way it takes the bell over: what
    // you see of an oral arm is light that passed through it.
    float bright = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, uLed.rgb * bright, uLed.w);

    // Two different tissues out of one shader.
    //
    // An oral arm is a frilled sheet and reads as lace: the ruffle drives its
    // opacity, dense where it folds and nearly clear between. A tentacle is
    // not a sheet at all — it is a single fishing line, one or two pixels
    // wide, and the reference's are the highest-contrast thing in the water
    // after the bells. Giving it the arm's lacy alpha made it disappear
    // entirely, which is why the tank had no threads in it.
    // Low, because these overlap.
    //
    // Nine wide sheets at half opacity each compose to opaque however lacy any
    // one of them is: 1 - 0.5^9 is 998 parts in a thousand, and the animal grew
    // a smooth white sleeve. There are five arms now and each is faint enough
    // that five of them stacked still show the water. Sharpened as well — the
    // gaps between folds have to go to *nothing*, or the frill is a stripe.
    // Dense enough to be seen. At 0.05 to 0.35 the ribbon was a rumour: the
    // reference's arms are substantial, you cannot see the far side of the
    // tank through one, and only their *edges* break up into lace. The folds
    // still drive the opacity — that is what makes an edge ragged rather than
    // cut — but they drive it between a half and a whole rather than between
    // nothing and a third.
    // Denser where the sheet is face-on, nearly gone where the twist has turned
    // it edge-on, so the arm breaks into scraps the way the painted one does.
    float lace = (0.16 + 0.55 * pow(frill, 1.4)) * (0.30 + 0.70 * vTurn);
    float a = uFade * (1.0 - vAlong * (0.72 - 0.22 * uFrill)) * mix(0.52, lace, uFrill);
    gl_FragColor = vec4(col, a);
    if (uMode > 0.5) gl_FragColor = vec4(vec3(circleOfConfusion(vWorld, uCamPos)), step(0.02, a));
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
  /** How hard the bell is pushing right now, along its own axis. Written by
   * `step`; the swarm reads it rather than recomputing the pulse from the clock,
   * which it used to do with periods of its own that did not match these. */
  thrust: number;
  /** 1 while swimming, 0 while resting. The swarm uses it to stop steering an
   * animal that is not swimming — a jellyfish at rest goes where the water
   * takes it, including over. */
  activity: number;
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
      ...cocUniforms(),
      uTime: { value: 0 },
      uLag: { value: 1 },
      uFlow: { value: 0.5 },
      uFade: { value: 0 },
      uRamp: { value: shared.bell },
      uVeilRamp: { value: shared.veil },
      uLed: { value: LED_JELLY },
      uWaterRamp: { value: shared.water },
      uCamPos: { value: shared.camPos },
    },
    vertexShader: bellVertex,
    fragmentShader: bellFragment,
    transparent: true,
    depthWrite: false,
    /*
     * Both sides, and this is a bug fix rather than a preference.
     *
     * Front faces only was fine while every animal was upright: you were always
     * looking at the outside of the dome. Now that they turn over (swarm.ts) an
     * inverted one presents its *underside* to the camera — and every face of a
     * dome seen from underneath is a back face, so the whole bell was culled
     * and an upside-down jellyfish arrived as a set of tentacles with nothing
     * on the end of them.
     *
     * The old objection — that drawing both sides at equal weight turns a bell
     * into a muddle of its own far side — is answered by not drawing them at
     * equal weight. The fragment shader knows which side it is on, and the
     * subumbrella is a different surface: paler, ringed with muscle, and far
     * fainter, because it is the inside of the animal.
     */
    side: THREE.DoubleSide,
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
  // Oral arms: short, wide and many. They were six long thin straps eight bell
  // radii long, which is a tentacle's shape, not an arm's — in the reference
  // they are a dense frilled mass hanging a bell-and-a-half below the animal
  // and half as wide as the bell itself. That mass is most of what a sea nettle
  // *is* at this size, and the app simply did not have it.
  // Four, which is what a Chrysaora has: four long frilled oral arms hanging
  // from the corners of the mouth, not a ring of them.
  const armCount = 4;
  // Forty, in eight groups of five. An アカクラゲ carries 40-56 tentacles, and
  // they do not come off the margin evenly — they hang in eight clusters, one
  // per octant of the bell, with a gap between each cluster. That grouping is
  // visible from across a room, and a ring of evenly spaced threads is the
  // clearest way to say "not this animal".
  const tentacleCount = species === 'bell' ? 40 : 32;
  const CLUSTERS = 8;
  /*
   * The oral arms, measured off the reference rather than guessed (item: the
   * frilly ones, 1786667042546.png).
   *
   * Looking at the painting properly settles an argument this file has been
   * having with itself. The animal in it is *mostly oral arm*: a small
   * intensely orange bell, maybe a fifth of the creature, and behind it a long
   * white ruffled ribbon three to five bell-widths long that curls through big
   * lazy S-shapes and is the single brightest thing in the tank. The fine
   * tentacles are there too, but they are hair — they read as a few pale
   * curves crossing the ribbon, not as a curtain.
   *
   * Overshot once, badly, and the correction is recorded because the failure
   * is instructive: at 0.86 radii wide and half opaque, four arms compose to an
   * opaque white slab that swallows the bell — the animal became a paper bag.
   * Four overlapping sheets multiply, so an arm has to be far more transparent
   * than it looks like it should be for four of them to read as one ribbon.
   *
   * This had it the other way round. The arms were 2.3 bell radii of narrow
   * lace at five percent alpha, which is invisible, and forty tentacles at full
   * length did all the work — so every animal was a small cap towing a broom,
   * and the reference's animals tow a *banner*. Four and a half radii of arm,
   * at twice the node count so the S-curves have somewhere to happen.
   */
  const armNodes = species === 'bell' ? 22 : 24;
  const armSegment = size * (species === 'bell' ? 0.21 : 0.30);
  const tentacleNodes = species === 'bell' ? 18 : 24;
  // Shorter than they were. Eighteen nodes at 0.86 bell radii is fifteen radii
  // of thread, which on the biggest animals reached from the lid of the tank to
  // the floor: the picture was more tentacle than water. Long is right —
  // an akakurage trails metres of it — but the tank has to stay a tank.
  const tentacleSegment = size * (species === 'bell' ? 0.52 : 0.78);

  /**
   * Where a strand is attached, as a place *on the bell* rather than as a fixed
   * offset from the animal's middle.
   *
   * This is item ⑤, and it was the thing making the tentacles look glued on: a
   * strand hung from a constant point at 0.90 radii, so when the bell squeezed
   * to 0.76 of its width and curled its skirt under, the rim moved and the
   * threads did not. The animal pulsed inside a stationary curtain. An anchor
   * is now an angle and a height *up the dome*, and its position is read off
   * the same shape function the vertex shader draws — so the rim tows its own
   * tentacles, and the little flick each stroke puts into them is the bell's
   * own movement rather than anything scripted.
   */
  interface Anchor { angle: number; rim: number; }
  const chains: { chain: Chain; kind: 'arm' | 'tentacle'; at: Anchor }[] = [];
  const root = new THREE.Vector3();
  /*
   * All four arms out of one place, and that place is inside the bell.
   *
   * They were hung at four points spread around the dome at 0.42 of the way up
   * its side, which put them on the *outside* of the umbrella above its widest
   * point — four separate ribbons stuck to the top of the animal like
   * streamers taped to a hat. An oral arm is not attached to the umbrella at
   * all: the four of them are the corners of one mouth, on a stalk hanging
   * under the middle of the subumbrella, and they leave the animal together
   * from that single point and only separate further down.
   */
  for (let i = 0; i < armCount; i++) {
    const angle = i / armCount;
    chains.push({ chain: new Chain(armNodes, armSegment, root, rand(seed, 80 + i) * 6.28), kind: 'arm', at: { angle, rim: 0 } });
  }
  /** How far under the crown the mouth hangs, in bell radii. Past the skirt,
   * which sits near -0.4, so the arms leave from inside the bell. */
  const ARM_DROP = 0.62;
  for (let i = 0; i < tentacleCount; i++) {
    // Eight clusters, five or so strands each, with the gaps between clusters
    // wider than the gaps within one.
    const cluster = Math.floor(i / (tentacleCount / CLUSTERS));
    const within = (i % (tentacleCount / CLUSTERS)) / (tentacleCount / CLUSTERS);
    const angle = (cluster + 0.18 + within * 0.64 + rand(seed, 30 + i) * 0.06) / CLUSTERS;
    // Each strand a different length. Identical strands drift as one sheet,
    // which is the single clearest tell that a jellyfish is a simulation: real
    // tentacles are ragged and cross each other.
    const vary = 0.65 + rand(seed, 50 + i) * 0.8;
    chains.push({ chain: new Chain(tentacleNodes, tentacleSegment * vary, root, rand(seed, 90 + i) * 6.28), kind: 'tentacle', at: { angle, rim: 1 } });
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
        ...cocUniforms(),
        // Wide. An oral arm in the reference is most of a bell across at the
        // mouth, not a tenth of one — it is a ribbon, and its width is what
        // makes it read as tissue rather than as string.
        uSeed: { value: rand(seed, 2) },
        uWidth: { value: kind === 'arm' ? size * (species === 'bell' ? 0.54 : 0.38) : size * 0.011 },
        uCamPos: { value: shared.camPos },
        uRamp: { value: shared.veil },
        uLed: { value: LED_JELLY },
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

  // The swimming state (see `step`). Integrated, not evaluated — a resting
  // animal has no closed-form phase.
  let phase = rand(seed, 1);
  let activity = 1;
  let restLeft = rand(seed, 12) * 14;
  let strokesLeft = 2 + Math.floor(rand(seed, 13) * 6);
  let lastPulse = pulse(phase);
  const anchor = new THREE.Vector3();

  const jelly: Jellyfish = {
    group,
    ribbons: ribbonGroup,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    species,
    seed,
    size,
    fade: 0,
    thrust: 0,
    activity: 1,
    step(dt, time, flow, flowField) {
      /*
       * The pulse, and the *rests* between bouts of it (item ③).
       *
       * The phase used to be `time / period`, which is a metronome: every
       * animal in the tank pulsed forever at its own fixed rate and none of
       * them ever stopped. Real ones do stop. A sea nettle swims in bouts —
       * a few strokes to climb, then it stops pulsing entirely and hangs
       * there, drifting and turning over in whatever the water is doing,
       * before it starts again. The stillness is most of what makes watching
       * one restful, and a tank of ceaseless pumping is a tank of machinery.
       *
       * So the phase is integrated rather than evaluated, and it only advances
       * while the animal is swimming. A rest is taken at the *end* of a stroke
       * (an integer phase), lasts a few seconds to the better part of a minute,
       * and both the decision and its length come out of the seed, so a frozen
       * frame still reproduces.
       */
      const stroke = Math.floor(phase);
      if (restLeft > 0) {
        restLeft -= dt;
        // Down over about a third of a second, so the bell coasts to a stop
        // rather than stalling — and uLag with it, which lets the rim catch up
        // and the bell park open (see bellVertex).
        activity = Math.max(0, activity - dt * 3.0);
      } else {
        // Back up over about a second: the first stroke out of a rest is a
        // slow one.
        activity = Math.min(1, activity + dt);
        const next = phase + (dt / period) * activity;
        if (Math.floor(next) > stroke) {
          phase = Math.floor(next);
          // Bouts of two to seven strokes, then a rest of 4 to 26 seconds.
          strokesLeft--;
          if (strokesLeft <= 0) {
            restLeft = 4 + rand(seed, 600 + (stroke % 71)) * 22;
            strokesLeft = 2 + Math.floor(rand(seed, 700 + (stroke % 67)) * 6);
          }
        } else {
          phase = next;
        }
      }
      jelly.activity = activity;

      // What the bell is pushing with, from the phase the bell actually has.
      const pNow = pulse(phase);
      jelly.thrust = Math.max(0, pNow - lastPulse) / Math.max(dt, 1e-4);
      lastPulse = pNow;

      bellMat.uniforms.uPulse.value = phase;
      bellMat.uniforms.uLag.value = activity;
      bellMat.uniforms.uTime.value = time;
      bellMat.uniforms.uFlow.value = flow;
      bellMat.uniforms.uFade.value = jelly.fade;
      group.position.copy(jelly.position);

      for (const ribbons of [arms, tentacles]) {
        ribbons.material.uniforms.uTime.value = time;
        ribbons.material.uniforms.uFlow.value = flow;
        ribbons.material.uniforms.uFade.value = jelly.fade;
      }

      // Hung off the bell where the bell *is* this frame: the same shape
      // function the vertex shader draws, evaluated at each strand's angle. The
      // squeeze, the curl of the skirt and the scallop all move the anchor, so
      // a stroke tows the whole curtain with it.
      const seedAngle = bellMat.uniforms.uSeed.value as number;
      for (const c of chains) {
        rimPoint(c.at.angle, phase, seedAngle, time, activity, c.at.rim, anchor);
        if (c.kind === 'arm') {
          // Down the axis to the mouth, with a hair of spread so the four do
          // not begin as a single line.
          const a = c.at.angle * Math.PI * 2;
          anchor.x += Math.cos(a) * 0.05;
          anchor.z += Math.sin(a) * 0.05;
          anchor.y -= ARM_DROP;
        }
        anchor.multiplyScalar(size).applyQuaternion(group.quaternion).add(jelly.position);
        c.chain.step(dt, time, anchor, flowField, c.kind === 'arm' ? 0.90 : 0.94);
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
