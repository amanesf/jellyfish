import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Anisotropic Kuwahara filter (Kyprianidis, Kang & Döllner 2009), the
 * painterly-abstraction filter that the plain Kuwahara this replaces is the
 * 1976 ancestor of.
 *
 * Plain Kuwahara splits a *square* neighbourhood into four axis-aligned
 * quadrants and outputs the mean of the lowest-variance one. That keeps edges
 * crisp, but because the kernel has no idea which way the picture is going, it
 * carves flat regions into little axis-aligned blocks — visible clumping that
 * reads as a JPEG artefact rather than as brushwork, and it cannot follow the
 * curve of a form.
 *
 * The anisotropic version first estimates local orientation from the
 * structure tensor, then shapes its kernel into an *ellipse aligned with that
 * orientation* — long along the direction the image is coherent in, narrow
 * across it. Averaging then happens along the form rather than across it, so
 * the output picks up directional strokes that follow the silhouette and the
 * shading boundaries. That directional smear along a form, holding hard at its
 * boundary, is exactly the mark a loaded brush leaves, which is why this is
 * the standard filter for an oil/gouache look rather than a "smoothed photo"
 * look.
 *
 * Three passes: structure tensor, tensor blur, then the filter itself. The
 * tensor blur is not optional — an unsmoothed tensor gives a per-pixel
 * orientation that jitters, and the strokes come out as noise instead of
 * following a direction over any distance.
 */

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/** Pass 1: Sobel derivatives -> structure tensor (E, F, G) packed into rgb. */
const TensorShader = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: QUAD_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec3 tl = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
      vec3 tc = texture2D(tDiffuse, vUv + uTexel * vec2( 0.0,  1.0)).rgb;
      vec3 tr = texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
      vec3 ml = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  0.0)).rgb;
      vec3 mr = texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  0.0)).rgb;
      vec3 bl = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
      vec3 bc = texture2D(tDiffuse, vUv + uTexel * vec2( 0.0, -1.0)).rgb;
      vec3 br = texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb;

      // Scharr weights rather than plain Sobel: better rotational symmetry,
      // which matters here because the whole point is estimating an angle.
      vec3 gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
      vec3 gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);

      gl_FragColor = vec4(dot(gx, gx), dot(gy, gy), dot(gx, gy), 1.0);
    }`,
};

/** Pass 2: separable Gaussian blur of the tensor field. */
const TensorBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDirection: { value: new THREE.Vector2(1, 0) },
  },
  vertexShader: QUAD_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform vec2 uDirection;
    varying vec2 vUv;
    void main() {
      vec2 step = uTexel * uDirection;
      vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;
      sum += texture2D(tDiffuse, vUv + step * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv - step * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv + step * 3.2307692308) * 0.0702702703;
      sum += texture2D(tDiffuse, vUv - step * 3.2307692308) * 0.0702702703;
      gl_FragColor = sum;
    }`,
};

/** Pass 3: the filter. */
const FilterShader = {
  uniforms: {
    tDiffuse: { value: null },
    tTensor: { value: null },
    uTexel: { value: new THREE.Vector2() },
    // Three, not four.
    //
    // The kernel is the brush, and a four-pixel brush is wider than a tentacle.
    // Everything fine in the tank — the threads, the frill on an oral arm, the
    // canals on a bell — was being averaged into its neighbours, and what came
    // back was the soft blob the animals had for a silhouette. The mark still
    // reads as a mark at three, and the strands survive it.
    uRadius: { value: 3.0 },
    uSharpness: { value: 4.0 },
    uQ: { value: 1.6 },
    uAlpha: { value: 1.0 },
    uStrength: { value: 1.0 },
  },
  vertexShader: QUAD_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tTensor;
    uniform vec2 uTexel;
    uniform float uRadius;
    uniform float uSharpness;
    uniform float uQ;
    uniform float uAlpha;
    uniform float uStrength;
    varying vec2 vUv;

    void main() {
      vec3 original = texture2D(tDiffuse, vUv).rgb;

      vec3 g = texture2D(tTensor, vUv).rgb;
      float E = g.x, G = g.y, F = g.z;

      // Eigen-decomposition of the 2x2 symmetric tensor [[E,F],[F,G]].
      float disc = sqrt(max((E - G) * (E - G) + 4.0 * F * F, 0.0));
      float lambda1 = 0.5 * (E + G + disc);
      float lambda2 = 0.5 * (E + G - disc);

      // Minor eigenvector = the direction the image varies *least* in, i.e.
      // the direction to smear along.
      vec2 dir = vec2(lambda1 - E, -F);
      float dirLen = length(dir);
      dir = dirLen > 1e-8 ? dir / dirLen : vec2(1.0, 0.0);

      // Anisotropy in [0,1]: 0 where the neighbourhood is isotropic (a flat
      // region, no direction to follow), 1 on a strong straight edge.
      float sum2 = lambda1 + lambda2;
      float anisotropy = sum2 > 1e-8 ? (lambda1 - lambda2) / sum2 : 0.0;

      // Ellipse axes: stretch along the coherent direction, squeeze across it,
      // by an amount that grows with anisotropy. In a flat region this stays
      // a circle and the filter degrades gracefully to ordinary Kuwahara.
      float scaleAlong = uRadius * clamp((uAlpha + anisotropy) / uAlpha, 0.1, 2.0);
      float scaleAcross = uRadius * clamp(uAlpha / (uAlpha + anisotropy), 0.1, 2.0);

      float c = dir.x, sn = dir.y;

      // Four sectors, weighted smoothly by angle rather than by a hard
      // quadrant test — a hard test is what gives plain Kuwahara its blocky
      // seams, because a sample sitting right on a boundary flips entirely
      // from one sector to the other.
      vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
      vec3 q0 = vec3(0.0), q1 = vec3(0.0), q2 = vec3(0.0), q3 = vec3(0.0);
      float n0 = 0.0, n1 = 0.0, n2 = 0.0, n3 = 0.0;

      // Walk the *unit disc* and map each sample out to the oriented ellipse,
      // rather than walking a pixel bounding box and mapping back. Same
      // kernel, but the sector angle and radial falloff are then read
      // straight off the unit-space coordinate, with no matrix inverse to get
      // wrong — the first version of this inverted the ellipse transform as a
      // transpose instead, which silently un-aligned the kernel from the
      // orientation it had just measured and turned the whole filter into a
      // plain blur.
      // Three, not four. This is a 2R+1 square of taps per pixel over the whole
      // frame — 81 of them at R=4, against 49 at R=3 — and it is the single most
      // expensive thing in the post chain. The brush mark it leaves is a little
      // finer at 3, which at this resolution is not a loss.
      const int R = 3;
      for (int j = -R; j <= R; j++) {
        for (int i = -R; i <= R; i++) {
          vec2 u = vec2(float(i), float(j)) / float(R);
          float rr = dot(u, u);
          if (rr > 1.0) continue;

          vec2 e = vec2(u.x * scaleAlong, u.y * scaleAcross);
          vec2 offset = vec2(c * e.x - sn * e.y, sn * e.x + c * e.y);
          vec3 col = texture2D(tDiffuse, vUv + offset * uTexel).rgb;

          float radial = exp(-2.0 * rr);
          float ang = atan(u.y, u.x);

          float w0 = pow(max(0.0, cos(ang)), uSharpness) * radial;
          float w1 = pow(max(0.0, cos(ang - 1.5707963)), uSharpness) * radial;
          float w2 = pow(max(0.0, -cos(ang)), uSharpness) * radial;
          float w3 = pow(max(0.0, cos(ang + 1.5707963)), uSharpness) * radial;

          m0 += col * w0; q0 += col * col * w0; n0 += w0;
          m1 += col * w1; q1 += col * col * w1; n1 += w1;
          m2 += col * w2; q2 += col * col * w2; n2 += w2;
          m3 += col * w3; q3 += col * col * w3; n3 += w3;
        }
      }

      vec3 acc = vec3(0.0);
      float accW = 0.0;
      const vec3 LUMA = vec3(0.299, 0.587, 0.114);

      // Sector weight must be *scale-free*. The textbook form 1/(1+sigma^q)
      // assumes sigma of order 1, but in a smoothly shaded image the sector
      // variances are all of order 1e-3, so every weight comes out at
      // essentially 1 and the output is the plain mean of all four sectors —
      // i.e. a blur, which is what the first version of this produced.
      // Raising variance to a negative power instead makes the comparison
      // purely relative, so the flattest sector dominates no matter how small
      // the absolute variances are.
      n0 = max(n0, 1e-4); m0 /= n0; q0 = max(q0 / n0 - m0 * m0, 0.0);
      float v0 = pow(dot(q0, LUMA) + 1e-6, -uQ);
      acc += m0 * v0; accW += v0;

      n1 = max(n1, 1e-4); m1 /= n1; q1 = max(q1 / n1 - m1 * m1, 0.0);
      float v1 = pow(dot(q1, LUMA) + 1e-6, -uQ);
      acc += m1 * v1; accW += v1;

      n2 = max(n2, 1e-4); m2 /= n2; q2 = max(q2 / n2 - m2 * m2, 0.0);
      float v2 = pow(dot(q2, LUMA) + 1e-6, -uQ);
      acc += m2 * v2; accW += v2;

      n3 = max(n3, 1e-4); m3 /= n3; q3 = max(q3 / n3 - m3 * m3, 0.0);
      float v3 = pow(dot(q3, LUMA) + 1e-6, -uQ);
      acc += m3 * v3; accW += v3;

      vec3 painted = accW > 1e-6 ? acc / accW : original;
      gl_FragColor = vec4(mix(original, painted, uStrength), 1.0);
    }`,
};

export class AnisotropicKuwaharaPass extends Pass {
  private tensorRT: THREE.WebGLRenderTarget;
  private tensorRT2: THREE.WebGLRenderTarget;
  private tensorMaterial: THREE.ShaderMaterial;
  private blurMaterial: THREE.ShaderMaterial;
  private filterMaterial: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor(width: number, height: number) {
    super();
    const rtOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // Half-float: the tensor components are squared gradients, so they blow
      // well past 1.0 and an 8-bit target would clip them all to the same
      // value and flatten every orientation estimate to nothing.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
    };
    this.tensorRT = new THREE.WebGLRenderTarget(width, height, rtOptions);
    this.tensorRT2 = new THREE.WebGLRenderTarget(width, height, rtOptions);

    this.tensorMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(TensorShader.uniforms),
      vertexShader: TensorShader.vertexShader,
      fragmentShader: TensorShader.fragmentShader,
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(TensorBlurShader.uniforms),
      vertexShader: TensorBlurShader.vertexShader,
      fragmentShader: TensorBlurShader.fragmentShader,
    });
    this.filterMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(FilterShader.uniforms),
      vertexShader: FilterShader.vertexShader,
      fragmentShader: FilterShader.fragmentShader,
    });

    this.quad = new FullScreenQuad(this.tensorMaterial);
    this.setSize(width, height);
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.filterMaterial.uniforms;
  }

  setSize(width: number, height: number): void {
    this.tensorRT.setSize(width, height);
    this.tensorRT2.setSize(width, height);
    const texel = new THREE.Vector2(1 / width, 1 / height);
    this.tensorMaterial.uniforms.uTexel.value.copy(texel);
    this.blurMaterial.uniforms.uTexel.value.copy(texel);
    this.filterMaterial.uniforms.uTexel.value.copy(texel);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.tensorMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.tensorMaterial;
    renderer.setRenderTarget(this.tensorRT);
    this.quad.render(renderer);

    this.quad.material = this.blurMaterial;
    this.blurMaterial.uniforms.tDiffuse.value = this.tensorRT.texture;
    this.blurMaterial.uniforms.uDirection.value.set(1, 0);
    renderer.setRenderTarget(this.tensorRT2);
    this.quad.render(renderer);

    this.blurMaterial.uniforms.tDiffuse.value = this.tensorRT2.texture;
    this.blurMaterial.uniforms.uDirection.value.set(0, 1);
    renderer.setRenderTarget(this.tensorRT);
    this.quad.render(renderer);

    this.filterMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.filterMaterial.uniforms.tTensor.value = this.tensorRT.texture;
    this.quad.material = this.filterMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  dispose(): void {
    this.tensorRT.dispose();
    this.tensorRT2.dispose();
    this.tensorMaterial.dispose();
    this.blurMaterial.dispose();
    this.filterMaterial.dispose();
    this.quad.dispose();
  }
}
