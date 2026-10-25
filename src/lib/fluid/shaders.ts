export const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const BILERP = `
vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize) {
  vec2 st = uv / max(tsize, vec2(1e-6)) - 0.5;
  vec2 iuv = floor(st);
  vec2 fuv = fract(st);
  vec4 a = texture(sam, (iuv + vec2(0.5, 0.5)) * tsize);
  vec4 b = texture(sam, (iuv + vec2(1.5, 0.5)) * tsize);
  vec4 c = texture(sam, (iuv + vec2(0.5, 1.5)) * tsize);
  vec4 d = texture(sam, (iuv + vec2(1.5, 1.5)) * tsize);
  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}
`;

const GLASS = `
float insideGlass(vec2 uv, float aspect) {
  vec2 p = (uv - 0.5) * vec2(1.0, aspect);
  float r = 0.47;
  float halfLen = aspect * 0.5 - r;
  vec2 pa = p - vec2(0.0, -halfLen);
  vec2 ba = vec2(0.0, max(halfLen * 2.0, 0.001));
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return smoothstep(0.03, -0.02, length(pa - ba * h) - r);
}
`;

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
  fragColor = base + vec4(uColor * g, g);
}
`;

export const VORTEX = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTarget;
uniform vec2 uPoint;
uniform float uStrength;
uniform float uRadius;
uniform float uAspect;
void main() {
  vec2 d = vUv - uPoint;
  d.x *= uAspect;
  float g = exp(-dot(d, d) / max(uRadius, 1e-6));
  vec2 tang = vec2(-d.y, d.x);
  tang /= length(d) + 1e-5;
  vec4 base = texture(uTarget, vUv);
  fragColor = base + vec4(tang * (uStrength * g), 0.0, 0.0);
}
`;

export const ADVECT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uVelTexel;
uniform float uDt;
uniform float uDissipation;
${BILERP}
void main() {
  vec2 vel = bilerp(uVelocity, vUv, uVelTexel).xy;
  vec2 coord = vUv - uDt * vel * uTexel;
  fragColor = uDissipation * bilerp(uSource, clamp(coord, vec2(0.001), vec2(0.999)), uTexel);
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
  float len = length(force) + 1e-5;
  force = (force / len) * uCurlStrength * C;
  force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  fragColor = vec4(vel, 0.0, 1.0);
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
  vec2 vel = texture(uVelocity, vUv).xy;
  vel -= vec2(R - L, T - B);
  fragColor = vec4(vel, 0.0, 1.0);
}
`;

export const DIFFUSE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uAlpha;
uniform float uBeta;
void main() {
  vec4 L = texture(uTexture, vUv - vec2(uTexel.x, 0.0));
  vec4 R = texture(uTexture, vUv + vec2(uTexel.x, 0.0));
  vec4 B = texture(uTexture, vUv - vec2(0.0, uTexel.y));
  vec4 T = texture(uTexture, vUv + vec2(0.0, uTexel.y));
  vec4 C = texture(uTexture, vUv);
  fragColor = (L + R + B + T + uAlpha * C) / uBeta;
}
`;

export const CLEAR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform float uValue;
void main() {
  fragColor = uValue * texture(uTexture, vUv);
}
`;

export const THERMAL = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform float uDt;
uniform float uHeat;
uniform float uChill;
uniform float uBass;
uniform float uDrive;
uniform float uAspect;
${GLASS}
void main() {
  vec4 dye = texture(uDye, vUv);
  float wax = dye.r;
  float temp = dye.g;
  float glass = insideGlass(vUv, uAspect);
  float coil = exp(-pow((vUv.y - 0.075) / 0.065, 2.0));
  coil *= smoothstep(0.14, 0.3, vUv.x) * smoothstep(0.86, 0.7, vUv.x);
  float drive = uHeat * (0.7 + uBass * uDrive * 1.85);
  temp += drive * coil * uDt * (0.45 + wax) * 9.0;
  float cool = smoothstep(0.58, 0.94, vUv.y);
  temp += (0.16 - temp) * uChill * (0.05 + cool * 2.4) * uDt * 2.4;
  temp = clamp(temp, 0.0, 1.35);
  wax = max(wax, 0.0) * glass;
  fragColor = vec4(wax, temp * glass, 0.0, 1.0);
}
`;

export const FORCES = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uDye;
uniform float uDt;
uniform float uRise;
uniform float uCap;
uniform float uBass;
uniform float uDrive;
uniform float uTime;
uniform vec2 uDyeTexel;
uniform float uAspect;
${GLASS}
void main() {
  vec2 vel = texture(uVelocity, vUv).xy;
  vec4 dye = texture(uDye, vUv);
  float dense = smoothstep(0.28, 0.72, dye.r);
  float temp = dye.g;
  float glass = insideGlass(vUv, uAspect);
  vec2 stepUv = uDyeTexel * 3.0;
  float l = texture(uDye, vUv - vec2(stepUv.x, 0.0)).r;
  float rgt = texture(uDye, vUv + vec2(stepUv.x, 0.0)).r;
  float b = texture(uDye, vUv - vec2(0.0, stepUv.y)).r;
  float t = texture(uDye, vUv + vec2(0.0, stepUv.y)).r;
  vec2 grad = vec2(rgt - l, t - b);
  vel += grad * 220.0 * uDt;
  vel.y += (temp - 0.46) * dense * uRise * uDt;
  vel.x -= (vUv.x - 0.5) * 3.5 * uDt;
  vel.x += sin(vUv.y * 8.0 + uTime * 0.55) * dense * 16.0 * uDt;
  vel.x += cos(uTime * 0.32 + vUv.y * 3.0) * 7.0 * uDt;
  float coil = exp(-pow((vUv.y - 0.1) / 0.07, 2.0));
  vel.y += uBass * uDrive * dense * 28.0 * coil * uDt;
  float sp = length(vel);
  if (sp > uCap) vel *= uCap / sp;
  vel *= glass;
  fragColor = vec4(vel, 0.0, 1.0);
}
`;

export const SHARPEN = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform vec2 uTexel;
uniform float uAspect;
${GLASS}
void main() {
  vec4 c = texture(uDye, vUv);
  float w = c.r;
  float l = texture(uDye, vUv - vec2(uTexel.x, 0.0)).r;
  float rgt = texture(uDye, vUv + vec2(uTexel.x, 0.0)).r;
  float b = texture(uDye, vUv - vec2(0.0, uTexel.y)).r;
  float t = texture(uDye, vUv + vec2(0.0, uTexel.y)).r;
  float avg = 0.25 * (l + rgt + b + t);
  float sharpened = clamp(w + (w - avg) * 0.9, 0.0, 1.65);
  float glass = insideGlass(vUv, uAspect);
  float wax = mix(w, sharpened, 0.28) * glass;
  fragColor = vec4(wax, c.g * glass, 0.0, 1.0);
}
`;

export const SMOKE_FORCE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uDye;
uniform float uDt;
uniform float uBass;
uniform float uTime;
void main() {
  vec2 vel = texture(uVelocity, vUv).xy;
  float smoke = texture(uDye, vUv).r;
  vel.y += smoke * (70.0 + uBass * 120.0) * uDt;
  vel.x += sin(vUv.y * 5.0 + uTime * 0.35) * smoke * 36.0 * uDt;
  vel.x += cos(uTime * 0.22 + vUv.y * 2.4) * smoke * 14.0 * uDt;
  vel *= exp(-0.35 * uDt);
  float sp = length(vel);
  if (sp > 90.0) vel *= 90.0 / sp;
  fragColor = vec4(vel, 0.0, 1.0);
}
`;

export const DISPLAY = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform vec2 uDyeTexel;
uniform vec2 uResolution;
uniform float uTime;
uniform float uGlow;
uniform float uThreshold;
uniform float uBass;
uniform vec3 uCool;
uniform vec3 uMid;
uniform vec3 uHot;
uniform vec3 uLiquid;
uniform float uLampH;
uniform float uLampAspect;
uniform vec2 uLampCenter;
uniform vec4 uBlobs[8];
${BILERP}

float sdCapsule(vec2 p, float aspect) {
  vec2 s = vec2(p.x, p.y * aspect);
  float r = 0.47;
  float halfLen = aspect * 0.5 - r;
  vec2 pa = s - vec2(0.0, -halfLen);
  vec2 ba = vec2(0.0, max(halfLen * 2.0, 0.001));
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + vec2(r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float screenAspect = uResolution.x / max(uResolution.y, 1.0);
  float lampW = uLampH / uLampAspect / screenAspect;
  vec2 p = (vUv - uLampCenter) / vec2(lampW, uLampH);
  vec2 s = vec2(p.x, p.y * uLampAspect);

  vec2 bgv = vUv - vec2(uLampCenter.x, uLampCenter.y - 0.04);
  float vig = smoothstep(1.2, 0.12, length(bgv * vec2(screenAspect * 0.75, 1.0)));
  vec3 room = mix(vec3(0.025, 0.016, 0.012), vec3(0.09, 0.045, 0.022), vig * 0.65);
  float floorY = uLampCenter.y - uLampH * 0.58;
  float floorGlow = exp(-pow((vUv.y - floorY) * 7.5, 2.0)) * exp(-pow((vUv.x - uLampCenter.x) * 2.6, 2.0));
  room += uHot * floorGlow * (0.22 + uBass * 0.55) * uGlow;

  float d = sdCapsule(p, uLampAspect);
  float aura = exp(-max(d, 0.0) * 14.0);
  vec3 col = room + uHot * aura * 0.22 * uGlow;

  if (d < 0.03) {
    float e = 0.006;
    float dx = sdCapsule(p + vec2(e, 0.0), uLampAspect) - sdCapsule(p - vec2(e, 0.0), uLampAspect);
    float dy = sdCapsule(p + vec2(0.0, e), uLampAspect) - sdCapsule(p - vec2(0.0, e), uLampAspect);
    vec2 n = normalize(vec2(dx, dy) + 1e-4);
    vec2 dyeUv = clamp(p + 0.5, 0.001, 0.999);
    float nearWall = smoothstep(-0.22, -0.02, d);
    dyeUv += n * 0.04 * nearWall;
    dyeUv = clamp(dyeUv, 0.001, 0.999);

    float field = 0.0;
    float heatW = 0.0;
    vec2 grad = vec2(0.0);
    for (int i = 0; i < 8; i++) {
      vec4 blob = uBlobs[i];
      float rad = blob.z;
      if (rad < 0.001) continue;
      vec2 delta = vec2(dyeUv.x - blob.x, (dyeUv.y - blob.y) * uLampAspect);
      float q = dot(delta, delta) / max(rad * rad, 1e-4);
      float g = exp(-q);
      field += g;
      heatW += g * blob.w;
      grad += g * delta / max(rad * rad, 1e-4);
    }
    float temp = clamp(heatW / max(field, 1e-4), 0.0, 1.2);
    float body = smoothstep(0.42, 0.92, field);
    float core = smoothstep(0.85, 2.1, field);
    vec3 waxCol = mix(uCool, uMid, smoothstep(0.18, 0.55, temp));
    waxCol = mix(waxCol, uHot, smoothstep(0.48, 0.95, temp));
    float skin = body * (1.0 - core);
    waxCol *= mix(1.35, 0.38, core);
    waxCol += uHot * skin * (0.65 + uGlow * 0.85);
    float shaft = exp(-pow((dyeUv.x - 0.44) * 2.2, 2.0)) * exp(-dyeUv.y * 1.45);
    waxCol += mix(uMid, uHot, temp) * exp(-core * 1.7) * shaft * (0.45 + uGlow * 0.7);

    float gradLen = length(grad);
    vec2 outN = gradLen > 1e-3 ? -grad / gradLen : vec2(0.0, 1.0);
    float specMask = smoothstep(0.04, 0.35, gradLen) * body;
    float spec = pow(clamp(dot(outN, normalize(vec2(-0.58, 0.76))), 0.0, 1.0), 26.0);
    waxCol += vec3(1.0, 0.96, 0.88) * spec * specMask * 0.95;
    float spec2 = pow(clamp(dot(outN, normalize(vec2(0.7, 0.35))), 0.0, 1.0), 48.0);
    waxCol += vec3(1.0, 0.98, 0.94) * spec2 * specMask * 0.45;

    vec3 liquid = uLiquid * 0.22 + vec3(0.02, 0.01, 0.006);
    liquid += uHot * shaft * (0.28 + uBass * 0.45) * uGlow;
    liquid += uMid * 0.05 * (1.0 - dyeUv.y);
    vec3 inside = mix(liquid, waxCol, clamp(body, 0.0, 0.9));

    float shell = smoothstep(-0.08, -0.015, d) * (1.0 - smoothstep(-0.015, 0.02, d));
    inside = mix(inside, inside * 0.55 + vec3(0.62, 0.7, 0.74), shell * 0.35);

    float depth = smoothstep(-0.02, -0.28, d);
    inside *= mix(0.62, 1.0, depth);

    float streak = exp(-pow((p.x + 0.30) * 5.5, 2.0)) * smoothstep(-0.02, -0.2, d);
    streak *= smoothstep(-0.42, 0.05, p.y) * smoothstep(0.46, 0.02, p.y);
    inside += vec3(1.0, 0.97, 0.9) * streak * 0.45;

    float rim = smoothstep(-0.02, 0.0, d) * (1.0 - smoothstep(0.0, 0.028, d));
    inside += vec3(1.0, 0.96, 0.9) * rim;

    col = mix(col, inside, 1.0 - smoothstep(-0.01, 0.025, d));
  }

  float baseCy = -uLampAspect * 0.5 + 0.02;
  float base = sdRoundBox(s - vec2(0.0, baseCy), vec2(0.58, 0.4), 0.14);
  float capCy = uLampAspect * 0.5 - 0.01;
  float cap = sdRoundBox(s - vec2(0.0, capCy), vec2(0.4, 0.2), 0.1);

  if (base < 0.0) {
    float band = smoothstep(baseCy - 0.28, baseCy + 0.32, s.y);
    vec3 metal = mix(vec3(0.05, 0.035, 0.028), vec3(0.42, 0.28, 0.14), band);
    metal += vec3(1.0, 0.94, 0.82) * exp(-pow((s.x + 0.26) * 6.5, 2.0)) * 0.18;
    float slit = exp(-pow((s.y - (baseCy + 0.16)) * 9.0, 2.0));
    slit *= smoothstep(0.42, 0.08, abs(s.x));
    metal += mix(uMid, uHot, 0.5 + 0.5 * uBass) * slit * (0.45 + uBass * 1.1) * uGlow;
    float rim = smoothstep(0.0, -0.02, base) * smoothstep(-0.08, 0.0, base);
    metal += vec3(0.85, 0.75, 0.55) * rim;
    col = metal;
  }

  if (cap < 0.0) {
    float band = smoothstep(capCy - 0.16, capCy + 0.16, s.y);
    vec3 metal = mix(vec3(0.08, 0.06, 0.045), vec3(0.55, 0.4, 0.22), band);
    metal += vec3(1.0, 0.95, 0.85) * exp(-pow((s.x + 0.20) * 8.0, 2.0)) * 0.22;
    col = metal;
  }

  col = 1.0 - exp(-col * 1.08);
  float hash = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (hash - 0.5) * 0.004;
  float glassA = 1.0 - smoothstep(-0.002, 0.01, d);
  float hardware = max(1.0 - smoothstep(0.0, 0.016, base), 1.0 - smoothstep(0.0, 0.016, cap));
  float body = max(glassA, hardware);
  float auraA = aura * 0.4;
  float alpha = max(body, max(auraA, floorGlow * 0.35));
  vec3 glowCol = uHot * (aura * 0.28 + floorGlow * 0.45) * uGlow;
  fragColor = vec4(mix(glowCol, col, body), alpha);
}
`;
