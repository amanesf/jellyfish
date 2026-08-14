import * as THREE from 'three';

/**
 * The tank's own lamp (plan.md §6).
 *
 * Every public jellyfish tank has one of these: a strip of LEDs over the water
 * that the aquarium turns to a colour, so the animals come up magenta, then
 * violet, then cyan, then green. It is not the room's light and it is not the
 * water's colour — 水の色 says what the water is, this says what is *shining
 * into* it, and the two are independent the way they are in the building.
 *
 * At 0 the lamp is white and the picture is exactly the one measured off the
 * reference. That is the position the ramps were fitted at, so it has to be
 * reachable, and it is the default.
 *
 * The wheel runs magenta → violet → blue → cyan → green, which is the sweep the
 * real ones do, and it stops there: past green an aquarium LED goes amber and a
 * moon jelly under amber light looks ill. Saturation is deliberately low. A
 * fully saturated lamp destroys the ramps — every tone in the picture collapses
 * onto one hue and the bells stop being a different colour from the water — and
 * what a real tank does is *tint*, not replace.
 *
 * Held at constant luminance, so this is a colour control and never a dimmer.
 * One shared instance: every material holds this same object in its uniform, so
 * setting it once moves the whole scene.
 */
export const LED = new THREE.Color(1, 1, 1);

const REC709 = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

export function setLed(v: number): void {
  if (v < 0.005) {
    LED.setRGB(1, 1, 1);
    return;
  }
  // 0.86 is magenta, 0.36 is green, and the knob walks between them.
  LED.setHSL(0.86 - v * 0.50, 0.62, 0.60);
  LED.multiplyScalar(1 / Math.max(1e-3, REC709(LED)));
  // The tint is a lean, not a paint: a third of the way from white to the lamp
  // colour is already unmistakable, and past that the ramps stop reading.
  LED.lerp(new THREE.Color(1, 1, 1), 0.55);
}
