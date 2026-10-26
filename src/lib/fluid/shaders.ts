/**
 * GLSL for the lamp. Three groups:
 *  1. Stable-fluids smoke solver (adapted from navier-stokes-laboratory):
 *     density in .r, temperature in .g, buoyancy + vorticity confinement.
 *  2. Scene passes: lit backdrop + smoke → lamp (glass, wax, metal) → bloom.
 *  3. Final pass: table reflection, bloom, ACES tonemap, grain.
 */

export const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const NOISE = `
float hash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
        mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
        mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z) * 2.0 - 1.0;
}
`;

/** Exact mirror of src/lib/lamp/geometry.ts. */
const LAMP = `
const float BASE_TOP = 0.29;
const float GLASS_BOTTOM = 0.285;
const float GLASS_TOP = 0.875;
const float CAP_BOTTOM = 0.865;
const float CAP_TOP = 0.975;
uniform vec3 uLayout; // cx, floor, height (screen uv)
uniform float uAspect;

vec2 toLamp(vec2 uv) {
  return vec2((uv.x - uLayout.x) * uAspect / uLayout.z, (uv.y - uLayout.y) / uLayout.z);
}
vec2 toScreen(vec2 p) {
  return vec2(uLayout.x + p.x * uLayout.z / uAspect, uLayout.y + p.y * uLayout.z);
}
float glassR(float y) {
  float t = clamp((y - GLASS_BOTTOM) / (GLASS_TOP - GLASS_BOTTOM), 0.0, 1.0);
  if (t < 0.3) {
    float k = (0.3 - t) / 0.3;
    return 0.09 - 0.018 * k * k;
  }
  return 0.09 - 0.038 * pow((t - 0.3) / 0.7, 1.5);
}
float baseR(float y) {
  float t = clamp(y / BASE_TOP, 0.0, 1.0);
  float r = mix(0.122, 0.074, t);
  r += 0.005 * smoothstep(0.022, 0.012, y);
  r += 0.0045 * smoothstep(0.955, 0.975, t);
  return r;
}
float capR(float y) {
  float t = clamp((y - CAP_BOTTOM) / (CAP_TOP - CAP_BOTTOM), 0.0, 1.0);
  float r = mix(0.062, 0.037, t);
  r += 0.0035 * smoothstep(0.1, 0.05, t);
  if (y > CAP_TOP) {
    float k = clamp((y - CAP_TOP) / 0.011, 0.0, 1.0);
    r = 0.037 * sqrt(max(0.0, 1.0 - k * k));
  }
  return r;
}
`;

// ---------------------------------------------------------------------------
// 1. Smoke solver
// ---------------------------------------------------------------------------

export const SPLAT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTarget;
uniform vec2 uPoint;
uniform vec3 uColor;
uniform float uRadius;
uniform float uAspect;
void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  float g = exp(-dot(p, p) / max(uRadius, 1e-6));
  vec4 base = texture(uTarget, vUv);
  fragColor = base + vec4(uColor * g, 0.0);
}
`;

/** Adds smoke from up to 6 emitters and cools the temperature channel. */
export const INJECT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform vec4 uEmitA[6]; // x, y, radius, density/s
uniform vec4 uEmitB[6]; // temp/s, vx, vy, color tag (hue turns)
uniform float uAspect;
uniform float uDt;
void main() {
  // .r density, .g temperature, .b density × color tag (so b/r is the tag)
  vec4 d = texture(uDye, vUv);
  for (int i = 0; i < 6; i++) {
    vec4 a = uEmitA[i];
    if (a.z <= 0.0) continue;
    vec2 p = vUv - a.xy;
    p.x *= uAspect;
    float g = exp(-dot(p, p) / a.z);
    float add = a.w * g * uDt;
    d.r += add;
    d.b += add * uEmitB[i].w;
    d.g += uEmitB[i].x * g * uDt;
  }
  d.g *= exp(-0.12 * uDt);
  if (d.r > 2.5) {
    d.b *= 2.5 / d.r;
    d.r = 2.5;
  }
  d.g = min(d.g, 4.0);
  fragColor = vec4(d.rgb, 1.0);
}
`;

export const FORCES = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uDye;
uniform vec4 uEmitA[6];
uniform vec4 uEmitB[6];
uniform float uAspect;
uniform float uDt;
uniform float uTime;
uniform float uTurb;
uniform float uBuoy;
${NOISE}
void main() {
  vec2 vel = texture(uVelocity, vUv).xy;
  vec2 dye = texture(uDye, vUv).rg;
  // hot smoke rises, dense cool smoke settles a little
  vel.y += (dye.g * uBuoy - dye.r * 6.0) * uDt;

  for (int i = 0; i < 6; i++) {
    vec4 a = uEmitA[i];
    if (a.z <= 0.0) continue;
    vec2 p = vUv - a.xy;
    p.x *= uAspect;
    float g = exp(-dot(p, p) / (a.z * 2.5));
    vel += uEmitB[i].yz * g * uDt * 8.0;
  }

  // slow, evolving room draft: curl of 3D value noise (divergence-free)
  vec3 q = vec3(vUv.x * uAspect * 1.1, vUv.y * 1.1, uTime * 0.035);
  float e = 0.02;
  float n1 = vnoise(q + vec3(0.0, e, 0.0)) + 0.5 * vnoise(q * 2.3 + vec3(0.0, e * 2.3, 7.0));
  float n2 = vnoise(q - vec3(0.0, e, 0.0)) + 0.5 * vnoise(q * 2.3 - vec3(0.0, e * 2.3, -7.0));
  float n3 = vnoise(q + vec3(e, 0.0, 0.0)) + 0.5 * vnoise(q * 2.3 + vec3(e * 2.3, 0.0, 7.0));
  float n4 = vnoise(q - vec3(e, 0.0, 0.0)) + 0.5 * vnoise(q * 2.3 - vec3(e * 2.3, 0.0, -7.0));
  vec2 curl = vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
  vel += curl * uTurb * uDt;

  vel *= exp(-0.12 * uDt);
  // keep semi-Lagrangian steps short: fast hot jets otherwise alias into grit
  float sp = length(vel);
  if (sp > 90.0) vel *= 90.0 / sp;
  float wall = smoothstep(0.0, 0.04, vUv.x) * smoothstep(0.0, 0.04, 1.0 - vUv.x) *
               smoothstep(0.0, 0.008, vUv.y);
  vel *= wall;
  fragColor = vec4(vel, 0.0, 1.0);
}
`;

export const ADVECT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uDt;
uniform float uDissipation;
void main() {
  vec2 vel = texture(uVelocity, vUv).xy;
  vec2 coord = vUv - uDt * vel * uTexel;
  fragColor = uDissipation * texture(uSource, coord);
}
`;

export const DIVERGENCE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}
`;

export const CURL = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  fragColor = vec4(R - L - T + B, 0.0, 0.0, 1.0);
}
`;

export const VORTICITY = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec2 uTexel;
uniform float uCurlStrength;
uniform float uDt;
void main() {
  float L = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-5;
  force *= uCurlStrength * C;
  force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  fragColor = vec4(clamp(vel, vec2(-1000.0), vec2(1000.0)), 0.0, 1.0);
}
`;

export const PRESSURE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
void main() {
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float div = texture(uDivergence, vUv).x;
  fragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}
`;

export const GRADIENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  vec2 vel = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  fragColor = vec4(vel, 0.0, 1.0);
}
`;

export const SCALE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform float uValue;
void main() {
  fragColor = uValue * texture(uTexture, vUv);
}
`;

// ---------------------------------------------------------------------------
// 2. Scene
// ---------------------------------------------------------------------------

/** Wall, table and smoke, lit by the lamp. Rendered at reduced resolution. */
export const BACKDROP = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform vec3 uLight;
uniform vec3 uLightBase;
uniform float uTagMix;
uniform float uSmokeOn;
${LAMP}
${NOISE}
vec3 hueRotate(vec3 c, float turns) {
  float a = turns * 6.2831853;
  vec3 k = vec3(0.57735027);
  float ca = cos(a);
  return max(c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca), vec3(0.0));
}
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
void main() {
  vec2 p = toLamp(vUv);
  // the glowing glass acts as a vertical line light
  float dl = segDist(p, vec2(0.0, 0.34), vec2(0.0, 0.78));
  float fall = 1.0 / (1.0 + dl * dl * 9.0);

  // back wall: dark plaster, warm pool of light around the lamp
  float grain = vnoise(vec3(vUv * vec2(uAspect, 1.0) * 140.0, 0.0)) * 0.5 +
                vnoise(vec3(vUv * vec2(uAspect, 1.0) * 23.0, 3.0)) * 0.5;
  vec3 wall = vec3(0.010, 0.009, 0.010) * (1.0 + grain * 0.12);
  wall += uLight * (0.016 + 0.2 * fall * fall) * (1.0 + grain * 0.05);
  // soft shadow of the lamp body thrown up the wall behind it
  float body = smoothstep(0.03, 0.15, abs(p.x)) ;
  wall *= mix(0.55, 1.0, max(body, smoothstep(0.98, 1.2, p.y)));

  // table: horizon slightly above the base footprint
  float horizon = 0.06;
  vec3 col = wall;
  if (p.y < horizon) {
    float depth = clamp((horizon - p.y) / 0.35, 0.0, 1.0);
    vec3 table = vec3(0.016, 0.011, 0.008) * (0.8 + depth * 0.5);
    float wood = vnoise(vec3(p.x * 3.0, p.y * 90.0 / (0.3 + depth), 1.0));
    table *= 1.0 + wood * 0.18;
    float pool = exp(-pow(p.x / (0.42 + depth * 0.3), 2.0) - pow((p.y - 0.01) / 0.07, 2.0));
    table += uLight * pool * 0.16;
    float contact = smoothstep(0.17, 0.1, length(vec2(p.x, (p.y - 0.004) * 3.2)));
    table *= 1.0 - contact * 0.8;
    float edge = smoothstep(0.004, 0.0, abs(p.y - horizon));
    table += uLight * edge * 0.01;
    col = mix(table, wall, smoothstep(horizon - 0.002, horizon + 0.002, p.y));
  }

  if (uSmokeOn > 0.5) {
    vec3 dye = texture(uDye, vUv).rgb;
    float d = dye.r;
    // each puff keeps the color of the light it was released under
    float tag = dye.b / max(dye.r, 0.02);
    vec3 born = hueRotate(uLightBase, tag);
    float lb = dot(uLightBase, vec3(0.2126, 0.7152, 0.0722));
    float lr = dot(born, vec3(0.2126, 0.7152, 0.0722));
    born *= clamp(lb / max(lr, 1e-4), 0.6, 1.6);
    vec3 smokeLight = mix(uLight, born, uTagMix * 0.7);
    // march toward the lamp to fake self-shadowing
    vec2 lp = toScreen(vec2(0.0, clamp(p.y, 0.36, 0.76)));
    vec2 dir = lp - vUv;
    float len = length(dir * vec2(uAspect, 1.0));
    float reach = min(len, 0.3);
    vec2 stepUv = dir / 6.0 * (reach / max(len, 1e-4));
    float acc = 0.0;
    vec2 s = vUv;
    for (int i = 0; i < 6; i++) {
      s += stepUv;
      acc += texture(uDye, s).r;
    }
    // optical depth toward the lamp, scaled by how far we actually marched
    float shadow = mix(0.4, 1.0, exp(-acc * (reach / 0.3) * 0.45));
    vec3 lit = smokeLight * (0.05 + 1.35 * fall) * shadow;
    // multiple scattering: thick smoke takes on the room's own light, so a
    // dense knot reads as a lit billow, never as a dark stain
    vec3 scatter = col * 1.5 + vec3(0.02, 0.022, 0.027);
    float alpha = 1.0 - exp(-d * 1.15);
    vec3 smoke = (scatter + lit) * alpha;
    col = col * (1.0 - alpha * 0.35) + smoke;
  }
  fragColor = vec4(col, 1.0);
}
`;

export const LAMP_PASS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uEnv;
uniform vec2 uResolution;
uniform float uTime;
uniform float uGlow;
uniform float uBass;
uniform vec3 uCool;
uniform vec3 uMid;
uniform vec3 uHot;
uniform vec3 uLiquid;
uniform vec3 uLight;
uniform vec4 uBlobA[16];
uniform vec4 uBlobB[16];
${LAMP}
const float PI = 3.14159265;

vec3 env(vec3 d, float lod) {
  float u = atan(d.x, -d.z) / (2.0 * PI) + 0.5 + 0.07;
  float v = acos(clamp(d.y, -1.0, 1.0)) / PI;
  vec3 c = textureLod(uEnv, vec2(u, v), lod).rgb;
  c = pow(c, vec3(2.2));
  // the env is an 8-bit tonemapped JPG: re-expand the strip lights to HDR
  return c * 0.6 + pow(c, vec3(4.0)) * 7.0;
}
float fresnel(float cosT, float f0) {
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosT, 0.0, 1.0), 5.0);
}
float bulb(float y) {
  return exp(-(y - GLASS_BOTTOM) / 0.2) * (0.5 + uGlow * 1.2) * (1.0 + uBass * 0.7);
}
vec3 waxColor(float t) {
  vec3 c = mix(uCool, uMid, smoothstep(0.2, 0.6, t));
  return mix(c, uHot, smoothstep(0.6, 1.05, t));
}
// surface-of-revolution normal for radius R at height y with slope dR
vec3 revNormal(float x, float R, float dR) {
  float nx = clamp(x / max(R, 1e-4), -1.0, 1.0);
  return normalize(vec3(nx, -dR, sqrt(max(0.0, 1.0 - nx * nx))));
}

vec3 metal(vec2 p, float R, float dR, vec3 tint, float rough) {
  vec3 n = revNormal(p.x, R, dR);
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
  float brush = fract(sin(floor(p.y * 900.0) * 91.7) * 4375.5) - 0.5;
  vec3 c = env(r, rough) * tint * (1.0 + brush * 0.1);
  c += tint * 0.006;
  return c * fresnel(n.z, 0.6);
}

void main() {
  vec2 p = toLamp(vUv);
  float px = 1.5 / (uLayout.z * uResolution.y);
  vec3 col = texture(uScene, vUv).rgb;
  float glow = (0.5 + uGlow * 1.2) * (1.0 + uBass * 0.7);

  // ---- glass, liquid and wax --------------------------------------------
  if (p.y > GLASS_BOTTOM - 0.01 && p.y < GLASS_TOP + 0.01) {
    float R = glassR(p.y);
    float dR = (glassR(p.y + 0.002) - glassR(p.y - 0.002)) / 0.004;
    float cover = clamp((R - abs(p.x)) / px, 0.0, 1.0);
    if (cover > 0.0) {
      vec3 n = revNormal(p.x, R, dR);
      float nx = n.x;
      float Rin = R * 0.955;
      float b = bulb(p.y);

      // looking through a liquid-filled cylinder: the room behind is
      // flipped, squeezed and split slightly by dispersion
      vec2 base = vec2(-p.x * 0.42, p.y + 0.01);
      vec3 through;
      through.r = texture(uScene, toScreen(base + vec2(p.x * 0.03, 0.0))).r;
      through.g = texture(uScene, toScreen(base)).g;
      through.b = texture(uScene, toScreen(base - vec2(p.x * 0.03, 0.0))).b;
      vec3 tint = mix(vec3(1.0), uLiquid * 3.0, 0.55);
      vec3 inside = through * tint * 0.4;
      // light from the bulb scattering in the liquid
      float haze = b * (0.6 + 0.4 * (1.0 - abs(nx)));
      inside += uLiquid * haze * 0.55 + uLight * haze * 0.05;

      // wax: metaballs with elliptical, rotated kernels
      if (abs(p.x) < Rin + px) {
        float F = 0.0;
        float Tw = 0.0;
        vec2 g = vec2(0.0);
        for (int i = 0; i < 16; i++) {
          vec4 A = uBlobA[i];
          if (A.z < 0.001) continue;
          vec4 B = uBlobB[i];
          vec2 d = p - A.xy;
          float c = cos(B.y), s = sin(B.y);
          vec2 q = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
          float sq = sqrt(B.x);
          q.y /= sq;
          q.x *= sq;
          float Rk = A.z * 1.739;
          float x = dot(q, q) / (Rk * Rk);
          if (x >= 1.0) continue;
          float k = 1.0 - x;
          float f = k * k * k;
          F += f;
          Tw += f * A.w;
          vec2 gq = -6.0 * k * k * vec2(q.x * sq, q.y / sq) / (Rk * Rk);
          g += vec2(c * gq.x + s * gq.y, -s * gq.x + c * gq.y);
        }
        const float TH = 0.3;
        float w = max(fwidth(F), 1e-4);
        float edgeIn = clamp((Rin - abs(p.x)) / px, 0.0, 1.0);
        float a = smoothstep(-w, w, F - TH) * edgeIn;
        if (a > 0.0) {
          float temp = Tw / max(F, 1e-4);
          float h = clamp((F - TH) / 0.9, 0.0, 1.0);
          vec3 wn = normalize(vec3(-g * 0.055, 1.0));
          vec3 wc = waxColor(min(temp, 0.8));
          // translucent: thin skin passes the bulb's light, the core holds it
          float thick = sqrt(h);
          vec3 L = normalize(vec3(-0.15, -0.85, 0.5));
          float wrap = clamp((dot(wn, L) + 0.6) / 1.6, 0.0, 1.0);
          vec3 trans = wc * mix(wc, uMid, 0.5) * 1.05 * exp(-thick * 2.6) * (0.3 + b * 0.75);
          vec3 diff = wc * wrap * (0.18 + b * 0.9);
          vec3 core = wc * 0.08 * (1.0 - thick * 0.6);
          float rim = pow(1.0 - wn.z, 2.0);
          vec3 sss = mix(uMid, uHot, 0.6) * rim * (0.25 + b * 0.8) * 0.8;
          vec3 heat = wc * smoothstep(0.8, 1.15, temp) * 0.12 * glow;
          vec3 spec = env(reflect(vec3(0.0, 0.0, -1.0), wn), 1.5) * fresnel(wn.z, 0.035) * 0.6;
          vec3 waxCol = trans + diff + core + sss + heat + spec;
          // warmer wax lights the liquid around it
          inside = mix(inside, waxCol, a);
        } else {
          inside += uLight * smoothstep(0.0, TH, F) * 0.04 * b;
        }
      }

      // glass wall: thick at the silhouette, catches the bulb on its edges
      float ax = abs(nx);
      float wallBand = smoothstep(0.955, 0.99, ax);
      inside *= 1.0 - smoothstep(0.82, 1.0, ax) * 0.45;
      inside += uLight * wallBand * b * 0.55;
      inside += uLiquid * wallBand * 0.15;

      // reflections of the room (studio strip lights) on the curved glass
      vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
      float fr = fresnel(n.z, 0.04);
      vec3 refl = env(r, 0.6);
      inside += refl * (0.012 + fr * 0.9) * 0.38;

      col = mix(col, inside, cover);
    }
  }

  // light leaking where the glass meets the base collar
  float leak = exp(-pow((p.y - BASE_TOP - 0.004) / 0.0045, 2.0)) *
               smoothstep(0.0, 0.002, glassR(p.y) - abs(p.x));
  col += uLight * leak * glow * 0.9;

  // ---- base -------------------------------------------------------------
  if (p.y > -0.002 && p.y < BASE_TOP + 0.002) {
    float R = baseR(p.y);
    float dR = (baseR(p.y + 0.002) - baseR(max(0.0, p.y - 0.002))) / 0.004;
    float cover = clamp((R - abs(p.x)) / px, 0.0, 1.0) *
                  clamp((p.y + 0.001) / px, 0.0, 1.0) *
                  clamp((BASE_TOP + 0.001 - p.y) / px, 0.0, 1.0);
    if (cover > 0.0) {
      vec3 m = metal(p, R, dR, vec3(0.34, 0.33, 0.33), 1.6);
      // warm spill from the glass above onto the upper base
      float up = smoothstep(BASE_TOP - 0.09, BASE_TOP, p.y);
      m += uLight * up * up * 0.18 * glow * (1.0 - abs(p.x) / R * 0.5);
      // seam rings
      float seam = exp(-pow((p.y - 0.022) / 0.002, 2.0)) + exp(-pow((p.y - (BASE_TOP - 0.012)) / 0.0018, 2.0));
      m *= 1.0 - seam * 0.5;
      // ambient occlusion where it meets the table
      m *= mix(0.35, 1.0, smoothstep(0.0, 0.05, p.y));
      col = mix(col, m, cover);
    }
  }

  // ---- cap --------------------------------------------------------------
  if (p.y > CAP_BOTTOM - 0.002 && p.y < CAP_TOP + 0.013) {
    float R = capR(p.y);
    float dR = (capR(p.y + 0.002) - capR(p.y - 0.002)) / 0.004;
    float cover = clamp((R - abs(p.x)) / px, 0.0, 1.0) *
                  clamp((p.y - CAP_BOTTOM + 0.001) / px, 0.0, 1.0);
    if (cover > 0.0) {
      vec3 m = metal(p, R, dR, vec3(0.34, 0.33, 0.33), 1.3);
      float under = smoothstep(CAP_BOTTOM + 0.035, CAP_BOTTOM, p.y);
      m += uLight * under * 0.16 * glow;
      col = mix(col, m, cover);
    }
  }

  fragColor = vec4(col, 1.0);
}
`;

export const BLOOM_PREFILTER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uThreshold;
void main() {
  vec3 c = texture(uTexture, vUv + uTexel * vec2(-0.5, -0.5)).rgb +
           texture(uTexture, vUv + uTexel * vec2(0.5, -0.5)).rgb +
           texture(uTexture, vUv + uTexel * vec2(-0.5, 0.5)).rgb +
           texture(uTexture, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + 0.25, 0.0, 0.5);
  soft = soft * soft / 0.5;
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  fragColor = vec4(c * w, 1.0);
}
`;

export const BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform vec2 uDir;
void main() {
  vec3 c = texture(uTexture, vUv).rgb * 0.227027;
  c += texture(uTexture, vUv + uDir * 1.384615).rgb * 0.316216;
  c += texture(uTexture, vUv - uDir * 1.384615).rgb * 0.316216;
  c += texture(uTexture, vUv + uDir * 3.230769).rgb * 0.070270;
  c += texture(uTexture, vUv - uDir * 3.230769).rgb * 0.070270;
  fragColor = vec4(c, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 3. Final
// ---------------------------------------------------------------------------

export const FINAL = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uComp;
uniform sampler2D uBloomA;
uniform sampler2D uBloomB;
uniform sampler2D uNoise;
uniform vec2 uNoiseOffset;
uniform float uBloom;
uniform float uExposure;
${LAMP}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec3 col = texture(uComp, vUv).rgb;
  vec2 p = toLamp(vUv);
  // glossy table: mirrored, blurred lamp below the footprint line
  if (p.y < 0.0) {
    vec2 m = toScreen(vec2(p.x, -p.y));
    float fade = exp(p.y * 9.0) * smoothstep(0.3, 0.1, abs(p.x));
    vec3 refl = texture(uComp, m).rgb * 0.5 + texture(uBloomA, m).rgb * 2.0;
    col += refl * fade * 0.13;
  }
  vec3 bloom = texture(uBloomA, vUv).rgb * 0.55 + texture(uBloomB, vUv).rgb * 0.85;
  col += bloom * uBloom;
  col = aces(col * uExposure);
  vec2 v = vUv - 0.5;
  col *= 1.0 - dot(v * vec2(1.1, 0.9), v * vec2(1.1, 0.9)) * 0.55;
  col = pow(col, vec3(1.0 / 2.2));
  float n = texture(uNoise, gl_FragCoord.xy / 128.0 + uNoiseOffset).r;
  col += (n - 0.5) * (1.6 / 255.0 + 0.018 * (1.0 - col.g));
  fragColor = vec4(col, 1.0);
}
`;
