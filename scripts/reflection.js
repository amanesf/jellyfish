#!/usr/bin/env node
/**
 * Builds the gallery reflection: what the tank's acrylic throws back at you.
 *
 * The tank in the plate is a window with nothing on it, and a window with
 * nothing on it is a hole. What a real one carries is the room behind the
 * viewer — the lit cases along the far wall, the visitors in front of them —
 * smeared out by the curve of the cylinder and by the fact that it is a wet
 * surface rather than a mirror.
 *
 * That room is 1786681105779.png. It arrives here as a photograph of a gallery
 * and has to leave as *something you never quite read*: if a visitor in the
 * reflection is legible, the eye goes to them and the tank stops being the
 * subject. So it is blurred well past recognition, darkened, and desaturated
 * toward the blue the rest of the picture is lit in. What survives is the
 * pattern — bright rectangles at eye height, dark uprights between them, a warm
 * scatter of people below — and that pattern is all a reflection needs to be.
 *
 *   node scripts/reflection.js      # writes app/public/reflection.webp
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SRC = path.join(__dirname, '..', '1786681105779.png');
const OUT = path.join(__dirname, '..', 'app', 'public', 'reflection.webp');

/** Small on purpose. The shader samples this with linear filtering across the
 * whole width of the tank, so anything finer than this is blur that costs
 * bytes. 512 wide is about 14 px per source metre — a person is two pixels. */
const W = 512, H = 288;

async function main() {
  const meta = await sharp(SRC).metadata();
  const img = await sharp(SRC)
    .resize(W, H, { fit: 'fill' })
    // Radius 9 at this size is radius 25 on the original: past the point where
    // a face is a face.
    .blur(9)
    // Toward the blue everything else in this picture is lit in, and down. A
    // reflection is *added* to the water in the shader, so its absolute level
    // is what decides whether the glass reads as glass or as a projector.
    .modulate({ brightness: 0.62, saturation: 0.45 })
    .tint({ r: 150, g: 190, b: 255 })
    .toBuffer();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await sharp(img).webp({ quality: 82 }).toFile(OUT);
  const { size } = fs.statSync(OUT);
  console.log(`source       ${meta.width}x${meta.height}`);
  console.log(`wrote        ${path.relative(process.cwd(), OUT)} (${W}x${H}, ${(size / 1024).toFixed(0)} KB)`);
}
main();
