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

/**
 * The same lamp as the animals see it: xyz is the lamp's colour at full
 * saturation, w is how far the knob is turned.
 *
 * A jellyfish is not a lit surface, it is a bag of water with light inside it.
 * Under a coloured lamp a tank of them does not go slightly magenta the way the
 * water does — the animals *become* the lamp, because almost all of what you
 * see of one is light that went in, bounced around inside and came back out.
 * So the water gets `LED`, which leans, and the animals get this, which
 * replaces: their own tone becomes the lamp's colour at their own brightness,
 * and the crown highlight is emitted in it.
 */
export const LED_JELLY = new THREE.Vector4(1, 1, 1, 0);

const REC709 = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

const strong = new THREE.Color();

export function setLed(v: number): void {
  if (v < 0.005) {
    LED.setRGB(1, 1, 1);
    LED_JELLY.set(1, 1, 1, 0);
    return;
  }
  // Full saturation for the animals, normalised to unit luminance so turning
  // the lamp cannot brighten or darken the tank — only colour it.
  strong.setHSL(0.86 - v * 0.50, 0.95, 0.55);
  strong.multiplyScalar(1 / Math.max(1e-3, REC709(strong)));
  LED_JELLY.set(strong.r, strong.g, strong.b, Math.min(1, v * 1.15));
  // 0.86 is magenta, 0.36 is green, and the knob walks between them.
  LED.setHSL(0.86 - v * 0.50, 0.62, 0.60);
  LED.multiplyScalar(1 / Math.max(1e-3, REC709(LED)));
  // The tint is a lean, not a paint: a third of the way from white to the lamp
  // colour is already unmistakable, and past that the ramps stop reading.
  LED.lerp(new THREE.Color(1, 1, 1), 0.55);
}
