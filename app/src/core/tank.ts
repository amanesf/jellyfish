import * as THREE from 'three';
import { MEASURED } from './measured';

/**
 * The tank, and the camera that sees it.
 *
 * Nothing here is chosen. `./measured.ts` is written by scripts/geom.js
 * straight from the reference — generated rather than transcribed, because a
 * measurement copied into a source file by hand is a measurement that outlives
 * the image it came from, which is the failure sakura's scripts/README.md opens
 * by warning about.
 *
 * The 3D cylinder has to land on the painted one to the pixel: the plate is a
 * hole cut in that painting, so a silhouette a few pixels wide of the paint
 * puts water outside the acrylic or stops it short of it, and either reads
 * instantly as a compositing mistake rather than as a tank.
 *
 * The scene has no other length scale, so the tank's radius *is* the unit. The
 * cylinder stands on y = 0 with its axis on y.
 */
export { MEASURED };

export const FRAME_WIDTH = MEASURED.frameWidth;
export const FRAME_HEIGHT = MEASURED.frameHeight;
export const TANK_HEIGHT = MEASURED.tankHeight;
export const EYE_DISTANCE = MEASURED.eyeDistance;
export const EYE_HEIGHT = MEASURED.eyeHeight;
export const PIPE_RADIUS = MEASURED.pipeRadius;

/**
 * The projection.
 *
 * Not `PerspectiveCamera(fov, aspect)`: the principal point is not the frame's
 * centre — the eye is a little below the tank's middle and the lens is not
 * pointed at it — and a symmetric frustum cannot express that. Building the
 * matrix from the focal length and the principal point directly is the same
 * thing sakura does with setViewOffset, minus the indirection.
 */
export function tankProjection(width = FRAME_WIDTH, height = FRAME_HEIGHT): THREE.Matrix4 {
  const f = MEASURED.focal * (height / FRAME_HEIGHT);
  const cx = MEASURED.x0 * (width / FRAME_WIDTH);
  const cy = MEASURED.principalY * (height / FRAME_HEIGHT);
  const near = 0.1, far = 100;
  const m = new THREE.Matrix4();
  m.set(
    (2 * f) / width, 0, -(2 * cx / width - 1), 0,
    0, (2 * f) / height, (2 * cy / height - 1), 0,
    0, 0, -(far + near) / (far - near), -(2 * far * near) / (far - near),
    0, 0, -1, 0,
  );
  return m;
}

export function createCamera(): THREE.PerspectiveCamera {
  // A PerspectiveCamera for the type, with its projection replaced. The near
  // and far planes above are the only thing three.js still needs from it.
  const camera = new THREE.PerspectiveCamera(
    2 * Math.atan(FRAME_HEIGHT / 2 / MEASURED.focal) * 180 / Math.PI,
    FRAME_WIDTH / FRAME_HEIGHT,
    0.1,
    100,
  );
  camera.position.set(0, EYE_HEIGHT, EYE_DISTANCE);
  camera.lookAt(0, EYE_HEIGHT, 0);
  camera.projectionMatrix.copy(tankProjection());
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  // three.js would recompute the projection on any resize and undo the above.
  camera.updateProjectionMatrix = () => {};
  camera.updateMatrixWorld(true);
  return camera;
}
