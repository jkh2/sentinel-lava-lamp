import { lampFrame, type LampFrame } from "@/lib/lamp/geometry";
import { WaxGobs } from "@/lib/lamp/gobs";
import type { Palette } from "@/lib/lamp/palettes";
import * as S from "./shaders";

export interface LampParams {
  heat: number;
  rise: number;
  thickness: number;
  swirl: number;
  wax: number;
  chill: number;
  glow: number;
  drive: number;
  paused: boolean;
  palette: Palette;
}

interface FBO {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texel: [number, number];
}

interface DoubleFBO {
  read: FBO;
  write: FBO;
  swap: () => void;
}

interface Program {
  id: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

const SIM_ASPECT = 3.2;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("Failed to create shader");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    const log = gl.getShaderInfoLog(sh) || "empty log";
    gl.deleteShader(sh);
    throw new Error(`${kind} shader: ${log}`);
  }
  return sh;
}

function makeProgram(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const prog = gl.createProgram();
  if (!prog) throw new Error("Failed to create program");
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) ?? "program link failed");
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (!info) continue;
    uniforms[info.name] = gl.getUniformLocation(prog, info.name);
  }
  return { id: prog, uniforms };
}

function supportFormat(
  gl: WebGL2RenderingContext,
  internal: number,
  format: number,
  type: number,
) {
  const tex = gl.createTexture();
  if (!tex) return false;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, 8, 8, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  if (!fbo) return false;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  return ok;
}

function pickFormat(gl: WebGL2RenderingContext) {
  gl.getExtension("EXT_color_buffer_float");
  gl.getExtension("EXT_color_buffer_half_float");
  gl.getExtension("OES_texture_float_linear");
  gl.getExtension("OES_texture_half_float_linear");
  if (supportFormat(gl, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)) {
    return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST };
  }
  if (supportFormat(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT)) {
    return { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.LINEAR };
  }
  return { internal: gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR };
}

export class LampEngine {
  readonly canvas: HTMLCanvasElement;
  params: LampParams;
  bass = 0;
  time = 0;
  private gl: WebGL2RenderingContext;
  private format: ReturnType<typeof pickFormat>;
  private programs: {
    splat: Program;
    vortex: Program;
    advect: Program;
    divergence: Program;
    curl: Program;
    vorticity: Program;
    pressure: Program;
    gradient: Program;
    diffuse: Program;
    clear: Program;
    thermal: Program;
    forces: Program;
    sharpen: Program;
    smoke: Program;
    display: Program;
  };
  private vao: WebGLVertexArrayObject;
  private dye!: DoubleFBO;
  private velocity!: DoubleFBO;
  private pressure!: DoubleFBO;
  private divergence!: FBO;
  private curl!: FBO;
  private simW = 0;
  private pressureIters = 20;
  private lastW = 0;
  private lastH = 0;
  private needsSeed = true;
  private gobs = new WaxGobs();
  destroyed = false;

  constructor(canvas: HTMLCanvasElement, params: LampParams) {
    this.canvas = canvas;
    this.params = params;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is required for the lava lamp.");
    this.gl = gl;
    this.format = pickFormat(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    this.programs = {
      splat: makeProgram(gl, S.VERT, S.SPLAT),
      vortex: makeProgram(gl, S.VERT, S.VORTEX),
      advect: makeProgram(gl, S.VERT, S.ADVECT),
      divergence: makeProgram(gl, S.VERT, S.DIVERGENCE),
      curl: makeProgram(gl, S.VERT, S.CURL),
      vorticity: makeProgram(gl, S.VERT, S.VORTICITY),
      pressure: makeProgram(gl, S.VERT, S.PRESSURE),
      gradient: makeProgram(gl, S.VERT, S.GRADIENT),
      diffuse: makeProgram(gl, S.VERT, S.DIFFUSE),
      clear: makeProgram(gl, S.VERT, S.CLEAR),
      thermal: makeProgram(gl, S.VERT, S.THERMAL),
      forces: makeProgram(gl, S.VERT, S.FORCES),
      sharpen: makeProgram(gl, S.VERT, S.SHARPEN),
      smoke: makeProgram(gl, S.VERT, S.SMOKE_FORCE),
      display: makeProgram(gl, S.VERT, S.DISPLAY),
    };

    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Failed to create VAO");
    this.vao = vao;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.allocate();
    this.resize();
    if (this.lastW > 2) {
      this.seed();
      this.draw();
    }
  }

  private allocate() {
    const narrow = this.canvas.clientWidth > 0 && this.canvas.clientWidth < 840;
    const base = narrow ? 96 : 128;
    const dyeBase = narrow ? 168 : 220;
    this.pressureIters = narrow ? 16 : 22;
    const sim = { width: base, height: Math.round(base * SIM_ASPECT) };
    const dye = { width: dyeBase, height: Math.round(dyeBase * SIM_ASPECT) };
    this.simW = sim.width;
    this.velocity = this.makeDouble(sim.width, sim.height);
    this.dye = this.makeDouble(dye.width, dye.height);
    this.pressure = this.makeDouble(sim.width, sim.height);
    this.divergence = this.makeFBO(sim.width, sim.height);
    this.curl = this.makeFBO(sim.width, sim.height);
    this.needsSeed = true;
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.clientWidth < 4 || this.canvas.clientHeight < 4) return;
    if (w === this.lastW && h === this.lastH) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.lastW = w;
    this.lastH = h;
    gl.viewport(0, 0, w, h);
  }

  private makeFBO(width: number, height: number): FBO {
    const gl = this.gl;
    const { internal, format, type, filter } = this.format;
    const texture = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!texture || !fbo) throw new Error("Failed to allocate field buffer");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture, fbo, width, height, texel: [1 / width, 1 / height] };
  }

  private makeDouble(width: number, height: number): DoubleFBO {
    let a = this.makeFBO(width, height);
    let b = this.makeFBO(width, height);
    return {
      get read() {
        return a;
      },
      get write() {
        return b;
      },
      swap() {
        const t = a;
        a = b;
        b = t;
      },
    };
  }

  private blit(target: FBO | null) {
    const gl = this.gl;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.width, target.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bind(unit: number, texture: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  splat(
    x: number,
    y: number,
    vx: number,
    vy: number,
    color: [number, number, number],
    radius: number,
  ) {
    const gl = this.gl;
    const aspect = 1 / SIM_ASPECT;
    const sp = this.programs.splat;
    gl.useProgram(sp.id);
    this.bind(0, this.velocity.read.texture);
    gl.uniform1i(sp.uniforms.uTarget, 0);
    gl.uniform2f(sp.uniforms.uPoint, x, y);
    gl.uniform3f(sp.uniforms.uColor, vx, vy, 0);
    gl.uniform1f(sp.uniforms.uRadius, radius);
    gl.uniform1f(sp.uniforms.uAspect, aspect);
    this.blit(this.velocity.write);
    this.velocity.swap();

    this.bind(0, this.dye.read.texture);
    gl.uniform1i(sp.uniforms.uTarget, 0);
    gl.uniform3f(sp.uniforms.uColor, color[0], color[1], color[2]);
    gl.uniform1f(sp.uniforms.uRadius, radius * 0.92);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  stir(x: number, y: number, dx: number, dy: number, drip: boolean) {
    this.gobs.stir(x, y, dx, dy, drip);
  }

  private vortex(x: number, y: number, strength: number, radius: number) {
    const gl = this.gl;
    const p = this.programs.vortex;
    gl.useProgram(p.id);
    this.bind(0, this.velocity.read.texture);
    gl.uniform1i(p.uniforms.uTarget, 0);
    gl.uniform2f(p.uniforms.uPoint, x, y);
    gl.uniform1f(p.uniforms.uStrength, strength);
    gl.uniform1f(p.uniforms.uRadius, radius);
    gl.uniform1f(p.uniforms.uAspect, 1 / SIM_ASPECT);
    this.blit(this.velocity.write);
    this.velocity.swap();
  }

  seed() {
    this.gobs.seed();
    this.needsSeed = false;
  }

  private clearFields() {
    const gl = this.gl;
    for (const fbo of [
      this.dye.read,
      this.dye.write,
      this.velocity.read,
      this.velocity.write,
      this.pressure.read,
      this.pressure.write,
      this.divergence,
      this.curl,
    ]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
      gl.viewport(0, 0, fbo.width, fbo.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  step(dt: number) {
    if (this.destroyed) return;
    this.resize();
    if (!this.dye) return;
    if (this.needsSeed && this.lastW > 2) this.seed();
    if (this.params.paused) {
      this.draw();
      return;
    }
    const t = Math.min(Math.max(dt, 0.001), 0.033);
    this.time += t;
    const p = this.params;
    this.gobs.update(
      t,
      p.heat,
      p.rise,
      p.thickness,
      p.swirl,
      p.wax,
      p.chill,
      p.drive,
      this.bass,
    );
    this.draw();
    return;
  }

  private smokePuff(x: number, y: number, amount: number, lift: number) {
    const gl = this.gl;
    const aspect = gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight);
    const sp = this.programs.splat;
    gl.useProgram(sp.id);
    this.bind(0, this.velocity.read.texture);
    gl.uniform1i(sp.uniforms.uTarget, 0);
    gl.uniform2f(sp.uniforms.uPoint, x, y);
    gl.uniform3f(sp.uniforms.uColor, (Math.random() - 0.5) * 8, lift, 0);
    gl.uniform1f(sp.uniforms.uRadius, 0.012);
    gl.uniform1f(sp.uniforms.uAspect, aspect);
    this.blit(this.velocity.write);
    this.velocity.swap();

    this.bind(0, this.dye.read.texture);
    gl.uniform1i(sp.uniforms.uTarget, 0);
    gl.uniform3f(sp.uniforms.uColor, amount, amount * 0.4, 0);
    gl.uniform1f(sp.uniforms.uRadius, 0.02 + amount * 0.03);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  private smokeStep(dt: number) {
    const gl = this.gl;
    const frame = this.frame();
    const puff = 0.16 + this.bass * this.params.drive * 0.55;
    const foot = frame.cy - frame.height * 0.46;
    const sway = Math.sin(this.time * 0.7) * 0.05;
    this.smokePuff(frame.cx - 0.05 + sway, foot, puff, 28 + this.bass * 50);
    this.smokePuff(frame.cx + 0.06 - sway * 0.6, foot + 0.03, puff * 0.7, 18 + this.bass * 30);

    const dye = this.dye;
    const vel = this.velocity;
    const texel = vel.read.texel;
    const smoke = this.programs.smoke;
    gl.useProgram(smoke.id);
    this.bind(0, vel.read.texture);
    this.bind(1, dye.read.texture);
    gl.uniform1i(smoke.uniforms.uVelocity, 0);
    gl.uniform1i(smoke.uniforms.uDye, 1);
    gl.uniform1f(smoke.uniforms.uDt, dt);
    gl.uniform1f(smoke.uniforms.uBass, this.bass * this.params.drive);
    gl.uniform1f(smoke.uniforms.uTime, this.time);
    this.blit(vel.write);
    vel.swap();

    const adv = this.programs.advect;
    gl.useProgram(adv.id);
    this.bind(0, vel.read.texture);
    this.bind(1, vel.read.texture);
    gl.uniform1i(adv.uniforms.uVelocity, 0);
    gl.uniform1i(adv.uniforms.uSource, 1);
    gl.uniform2f(adv.uniforms.uTexel, texel[0], texel[1]);
    gl.uniform2f(adv.uniforms.uVelTexel, texel[0], texel[1]);
    gl.uniform1f(adv.uniforms.uDt, dt);
    gl.uniform1f(adv.uniforms.uDissipation, 1);
    this.blit(vel.write);
    vel.swap();

    this.bind(0, vel.read.texture);
    this.bind(1, dye.read.texture);
    gl.uniform1i(adv.uniforms.uVelocity, 0);
    gl.uniform1i(adv.uniforms.uSource, 1);
    gl.uniform2f(adv.uniforms.uTexel, dye.read.texel[0], dye.read.texel[1]);
    gl.uniform1f(adv.uniforms.uDissipation, Math.exp(-0.22 * dt));
    this.blit(dye.write);
    dye.swap();
  }

  private frame(): LampFrame {
    const rect = this.canvas.getBoundingClientRect();
    return lampFrame(rect.width || this.canvas.clientWidth, rect.height || this.canvas.clientHeight);
  }

  draw() {
    const gl = this.gl;
    const p = this.programs.display;
    const frame = this.frame();
    const pal = this.params.palette;
    gl.useProgram(p.id);
    this.bind(0, this.dye.read.texture);
    gl.uniform1i(p.uniforms.uDye, 0);
    gl.uniform2f(p.uniforms.uDyeTexel, this.dye.read.texel[0], this.dye.read.texel[1]);
    gl.uniform2f(p.uniforms.uResolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(p.uniforms.uTime, this.time);
    gl.uniform1f(p.uniforms.uGlow, this.params.glow);
    gl.uniform1f(p.uniforms.uThreshold, 0.72 - this.params.wax * 0.46);
    gl.uniform1f(p.uniforms.uBass, this.bass);
    gl.uniform3f(p.uniforms.uCool, pal.cool[0], pal.cool[1], pal.cool[2]);
    gl.uniform3f(p.uniforms.uMid, pal.mid[0], pal.mid[1], pal.mid[2]);
    gl.uniform3f(p.uniforms.uHot, pal.hot[0], pal.hot[1], pal.hot[2]);
    gl.uniform3f(p.uniforms.uLiquid, pal.liquid[0], pal.liquid[1], pal.liquid[2]);
    gl.uniform1f(p.uniforms.uLampH, frame.height);
    gl.uniform1f(p.uniforms.uLampAspect, frame.aspect);
    gl.uniform2f(p.uniforms.uLampCenter, frame.cx, frame.cy);
    const blobs = this.gobs.pack();
    gl.uniform4fv(p.uniforms["uBlobs[0]"] ?? p.uniforms.uBlobs, blobs);
    this.blit(null);
  }

  destroy() {
    this.destroyed = true;
  }
}
