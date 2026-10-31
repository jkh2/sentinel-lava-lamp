import {
  CAP_TOP,
  insideGlass,
  lampLayout,
  lampToScreen,
  screenToLamp,
  type LampLayout,
} from "@/lib/lamp/geometry";
import { GOB_SLOTS, WaxGobs } from "@/lib/lamp/gobs";
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
  /** How far the music may swing the light's color around the wheel (0–1). */
  hue: number;
  /** Strength of the cymatic figures notes press into the smoke (0 = off). */
  cymatics: number;
  /** While music plays, how much it leads the smoke over the lamp's own drift (0–1). */
  lead: number;
  /** How hard each beat pushes a burst of smoke and a flash of light (0–1). */
  beats: number;
  /** How much the wax and lamp glow pulse on beats (0–1). */
  pulse: number;
  /** How quickly an earlier note's figure gives way to the new note's (0–1). */
  snap: number;
  /** The figure's medium: a round water dish (CymaScope-like) or a square plate. */
  plate: "water" | "square";
  paused: boolean;
  palette: Palette;
}

/** Live analysis of the playing track; `live` is false when nothing is analysable. */
export interface MusicState {
  bass: number;
  mid: number;
  treble: number;
  live: boolean;
  /** Dominant note (MIDI), -1 when none. */
  noteMidi: number;
  noteStrength: number;
  /** Onset counter; a change means a note was just struck. */
  onsets: number;
  onsetStrength: number;
}

/** One ringing Chladni mode of the room's "plate". */
interface PlateMode {
  n: number;
  m: number;
  sign: number;
  rot: number;
  amp: number;
  midi: number;
}

/**
 * Chladni mode for a note (from Cymatic Cosmos): the pitch class picks the
 * figure, each octave above the fourth adds a ring, and odd notes take the
 * antisymmetric form so neighbouring notes look distinct.
 */
const MODES: Array<[number, number]> = [
  [1, 3], [2, 3], [1, 4], [2, 5], [3, 4], [1, 5], [3, 5], [2, 7], [4, 5], [3, 7], [1, 6], [4, 7],
];
function modeFor(midi: number): Omit<PlateMode, "amp"> {
  const pc = ((midi % 12) + 12) % 12;
  const [a, b] = MODES[pc] ?? [1, 3];
  const lift = Math.max(0, Math.min(2, Math.floor(midi / 12) - 4));
  return { n: a + lift, m: b + lift, sign: midi % 2 === 0 ? 1 : -1, rot: pc * 0.2618, midi };
}
/**
 * Water-dish figure for a note. Petal count walks the circle of fifths, so
 * notes that sound close in harmony look close (C 5 petals, G 6, D 7 …) while
 * clashing neighbours look very different (C 5, C# 12). Each octave above the
 * second adds a ring, as rising pitch enriches a CymaScope image.
 */
function waterModeFor(midi: number): Omit<PlateMode, "amp"> {
  const pc = ((midi % 12) + 12) % 12;
  const folds = 5 + ((pc * 7) % 12);
  const rings = 2 + Math.max(0, Math.min(3, Math.floor(midi / 12) - 3));
  return { n: folds, m: rings, sign: midi % 2 === 0 ? 1 : -1, rot: pc * 0.2618, midi };
}
const PLATE_SLOTS = 3;

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

interface Format {
  internal: number;
  format: number;
  type: number;
  filter: number;
  signed: boolean;
}

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

function makeProgram(gl: WebGL2RenderingContext, fs: string): Program {
  const prog = gl.createProgram();
  if (!prog) throw new Error("Failed to create program");
  const v = compile(gl, gl.VERTEX_SHADER, S.VERT);
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
    if (info.name.endsWith("[0]")) {
      uniforms[info.name.slice(0, -3)] = uniforms[info.name];
    }
  }
  return { id: prog, uniforms };
}

function renderable(gl: WebGL2RenderingContext, internal: number, format: number, type: number) {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) return false;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  return ok;
}

function pickFormat(gl: WebGL2RenderingContext): Format {
  gl.getExtension("EXT_color_buffer_float");
  gl.getExtension("EXT_color_buffer_half_float");
  const floatLinear = !!gl.getExtension("OES_texture_float_linear");
  // RGBA16F is filterable in core WebGL2; 32F needs the extension.
  if (renderable(gl, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)) {
    return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR, signed: true };
  }
  if (renderable(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT)) {
    return {
      internal: gl.RGBA32F,
      format: gl.RGBA,
      type: gl.FLOAT,
      filter: floatLinear ? gl.LINEAR : gl.NEAREST,
      signed: true,
    };
  }
  return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR, signed: false };
}

function hash(n: number) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
/** Rotate an RGB color around the grey axis by `turns` of the color wheel. */
function hueRotate(c: [number, number, number], turns: number): [number, number, number] {
  const a = turns * Math.PI * 2;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const k = 0.57735027;
  const dot = (c[0] + c[1] + c[2]) * k;
  const cross: [number, number, number] = [
    k * (c[2] - c[1]),
    k * (c[0] - c[2]),
    k * (c[1] - c[0]),
  ];
  return [0, 1, 2].map((i) =>
    Math.max(0, (c[i] ?? 0) * ca + (cross[i] ?? 0) * sa + k * dot * (1 - ca)),
  ) as [number, number, number];
}

/** Smooth, non-repeating 1D value noise in [-1, 1]. */
function noise1(t: number) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return (hash(i) + (hash(i + 1) - hash(i)) * u) * 2 - 1;
}

const EMITTERS = 6;

export class LampEngine {
  readonly canvas: HTMLCanvasElement;
  params: LampParams;
  bass = 0;
  music: MusicState = {
    bass: 0,
    mid: 0,
    treble: 0,
    live: false,
    noteMidi: -1,
    noteStrength: 0,
    onsets: 0,
    onsetStrength: 0,
  };
  time = 0;
  destroyed = false;
  private gl: WebGL2RenderingContext;
  private format: Format;
  private programs: Record<
    | "splat"
    | "inject"
    | "forces"
    | "advect"
    | "divergence"
    | "curl"
    | "vorticity"
    | "pressure"
    | "gradient"
    | "scale"
    | "backdrop"
    | "lamp"
    | "prefilter"
    | "blur"
    | "final",
    Program
  >;
  private vao: WebGLVertexArrayObject;
  private velocity!: DoubleFBO;
  private dye!: DoubleFBO;
  private pressure!: DoubleFBO;
  private divergence!: FBO;
  private curl!: FBO;
  private scene!: FBO;
  private comp!: FBO;
  private bloomA!: DoubleFBO;
  private bloomB!: DoubleFBO;
  private envTex: WebGLTexture;
  private noiseTex: WebGLTexture;
  private gobs = new WaxGobs();
  private layout: LampLayout = lampLayout(1280, 800);
  private cssW = 0;
  private cssH = 0;
  private renderScale = 1;
  private allocatedFor = "";
  private simAspect = 0;
  private frameEma = 16;
  private slowFor = 0;
  private fastFor = 0;
  private emitA = new Float32Array(EMITTERS * 4);
  private emitB = new Float32Array(EMITTERS * 4);
  /** Current color-wheel offset of the light (turns), driven by the music. */
  private hue = 0;
  /** Beat flash, decays over a fraction of a second. */
  private flash = 0;
  private prevMusicBass = 0;
  private energy = 0;
  private modes: PlateMode[] = [];
  /** Pitch heard this frame, and since when (for the ~70 ms settle). */
  private candNote = -1;
  private candSince = 0;
  /** The pitch that currently owns the plate, or -1. */
  private curNote = -1;
  private seenOnsets = 0;
  /** Onset counter last seen by the beat flash (separate from the cymatics one). */
  private seenBeatOnsets = 0;
  private modeA = new Float32Array(PLATE_SLOTS * 4);
  private readonly smokeOn: boolean;

  constructor(canvas: HTMLCanvasElement, params: LampParams) {
    this.canvas = canvas;
    this.params = params;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is required for the lava lamp.");
    this.gl = gl;
    this.format = pickFormat(gl);
    this.smokeOn = this.format.signed;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    this.programs = {
      splat: makeProgram(gl, S.SPLAT),
      inject: makeProgram(gl, S.INJECT),
      forces: makeProgram(gl, S.FORCES),
      advect: makeProgram(gl, S.ADVECT),
      divergence: makeProgram(gl, S.DIVERGENCE),
      curl: makeProgram(gl, S.CURL),
      vorticity: makeProgram(gl, S.VORTICITY),
      pressure: makeProgram(gl, S.PRESSURE),
      gradient: makeProgram(gl, S.GRADIENT),
      scale: makeProgram(gl, S.SCALE),
      backdrop: makeProgram(gl, S.BACKDROP),
      lamp: makeProgram(gl, S.LAMP_PASS),
      prefilter: makeProgram(gl, S.BLOOM_PREFILTER),
      blur: makeProgram(gl, S.BLUR),
      final: makeProgram(gl, S.FINAL),
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

    this.envTex = this.loadTexture("/env-studio.jpg", [10, 9, 9, 255], true);
    this.noiseTex = this.loadTexture("/blue-noise.png", [128, 128, 128, 255], false);

    this.gobs.seed();
    this.resize();
  }

  // ---- resources ----------------------------------------------------------

  private loadTexture(src: string, fallback: number[], mips: boolean) {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("Failed to create texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(fallback));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mips ? gl.LINEAR : gl.NEAREST);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (this.destroyed) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      if (mips) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      }
    };
    img.src = src;
    return tex;
  }

  private makeFBO(width: number, height: number, linear = true): FBO {
    const gl = this.gl;
    const { internal, format, type, filter } = this.format;
    const texture = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!texture || !fbo) throw new Error("Failed to allocate field buffer");
    const f = linear ? filter : gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture, fbo, width, height, texel: [1 / width, 1 / height] };
  }

  private freeFBO(f: FBO | undefined) {
    if (!f) return;
    this.gl.deleteTexture(f.texture);
    this.gl.deleteFramebuffer(f.fbo);
  }

  private makeDouble(width: number, height: number, linear = true): DoubleFBO {
    let a = this.makeFBO(width, height, linear);
    let b = this.makeFBO(width, height, linear);
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

  private freeDouble(d: DoubleFBO | undefined) {
    if (!d) return;
    this.freeFBO(d.read);
    this.freeFBO(d.write);
  }

  /** Called every frame; cheap unless the canvas size or quality changed. */
  resize() {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw < 4 || ch < 4) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.round(cw * dpr);
    let h = Math.round(ch * dpr);
    const cap = 2.6e6;
    if (w * h > cap) {
      const k = Math.sqrt(cap / (w * h));
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (cw !== this.cssW || ch !== this.cssH) {
      this.cssW = cw;
      this.cssH = ch;
      this.layout = lampLayout(cw, ch);
    }
    const key = `${w}x${h}@${this.renderScale.toFixed(2)}`;
    if (key === this.allocatedFor) return true;
    this.allocatedFor = key;

    const aspect = w / h;
    const narrow = cw < 840;
    // Fluid grids follow the screen's aspect. Rebuild only when it changes
    // enough to matter, so a scrollbar or URL bar doesn't wipe the smoke.
    if (!this.velocity || Math.abs(aspect - this.simAspect) / this.simAspect > 0.08) {
      this.simAspect = aspect;
      const simMin = narrow ? 96 : 120;
      const dyeMin = narrow ? 256 : 380;
      const dims = (m: number) =>
        aspect >= 1
          ? { w: Math.round(m * aspect), h: m }
          : { w: m, h: Math.round(m / aspect) };
      const sim = dims(simMin);
      const dye = dims(dyeMin);
      this.freeDouble(this.velocity);
      this.freeDouble(this.dye);
      this.freeDouble(this.pressure);
      this.freeFBO(this.divergence);
      this.freeFBO(this.curl);
      this.velocity = this.makeDouble(sim.w, sim.h);
      this.dye = this.makeDouble(dye.w, dye.h);
      this.pressure = this.makeDouble(sim.w, sim.h, false);
      this.divergence = this.makeFBO(sim.w, sim.h, false);
      this.curl = this.makeFBO(sim.w, sim.h, false);
      this.prewarm();
    }

    const rw = Math.max(2, Math.round(w * this.renderScale));
    const rh = Math.max(2, Math.round(h * this.renderScale));
    this.freeFBO(this.scene);
    this.freeFBO(this.comp);
    this.freeDouble(this.bloomA);
    this.freeDouble(this.bloomB);
    this.scene = this.makeFBO(Math.max(2, rw >> 1), Math.max(2, rh >> 1));
    this.comp = this.makeFBO(rw, rh);
    this.bloomA = this.makeDouble(Math.max(2, rw >> 2), Math.max(2, rh >> 2));
    this.bloomB = this.makeDouble(Math.max(2, rw >> 3), Math.max(2, rh >> 3));
    return true;
  }

  // ---- helpers ------------------------------------------------------------

  private blit(target: FBO | null) {
    const gl = this.gl;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.width, target.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bind(unit: number, texture: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  private aspect() {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }

  private setLayout(p: Program) {
    const gl = this.gl;
    const l = this.layout;
    gl.uniform3f(p.uniforms.uLayout, l.cx, l.floor, l.height);
    gl.uniform1f(p.uniforms.uAspect, this.aspect());
  }

  /** The palette's own lamp light, before the music recolors it. */
  private baseLight(): [number, number, number] {
    const pal = this.params.palette;
    const k =
      (0.5 + this.params.glow * 1.2) *
      (1 + this.bass * this.params.drive * 0.7 + this.flash * this.params.pulse * 0.55);
    return [
      (pal.mid[0] * 0.55 + pal.hot[0] * 0.45) * k,
      (pal.mid[1] * 0.55 + pal.hot[1] * 0.45) * k,
      (pal.mid[2] * 0.55 + pal.hot[2] * 0.45) * k,
    ];
  }

  private lightColor(): [number, number, number] {
    const base = this.baseLight();
    const c = hueRotate(base, this.hue);
    // keep perceived brightness steady through the rotation, then flash on beats
    const lum = (v: [number, number, number]) => v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
    const keep = lum(base) / Math.max(1e-4, lum(c));
    const fix = Math.min(1.6, Math.max(0.6, keep));
    const f = 1 + this.flash * 0.4;
    return [c[0] * fix * f, c[1] * fix * f, c[2] * fix * f];
  }

  /**
   * Music → color and energy. Bass-heavy passages keep the palette's color;
   * as mids and highs take over the light swings around the wheel (by up to
   * `hue` × 0.42 turns). Smoothed so it flows instead of flickering.
   */
  private updateMusic(dt: number) {
    const m = this.music;
    const amount = this.params.hue;
    let target = 0;
    if (m.live) {
      const total = m.bass + m.mid + m.treble + 0.05;
      const bright = (m.mid * 0.55 + m.treble * 1.0) / total;
      const shift = Math.min(1, Math.max(0, (bright - 0.18) / 0.5));
      const level = Math.min(1, total / 1.2);
      // a slow drift so long, even passages still breathe in color
      const drift = noise1(this.time * 0.05 + 7.7) * 0.12 * level;
      // negative turns: warm lamps swing through rose and magenta toward violet
      target = -(shift * 0.42 + drift) * amount;
      const onset = Math.max(0, m.bass - this.prevMusicBass);
      if (onset > 0.04) this.flash = Math.max(this.flash, Math.min(1, onset * 4) * this.params.drive);
      // every detected onset (a drum hit, a struck chord) fires a burst too,
      // so the show keeps time with the song instead of waiting for big bass jumps
      if (m.onsets !== this.seenBeatOnsets) {
        const hit = (0.4 + 0.6 * m.onsetStrength) * (0.35 + this.params.beats * 0.9);
        this.flash = Math.max(this.flash, Math.min(1.2, hit));
      }
      this.energy += (level - this.energy) * Math.min(1, dt * 3);
    } else {
      this.energy += (0 - this.energy) * Math.min(1, dt * 1.5);
    }
    this.seenBeatOnsets = m.onsets;
    this.prevMusicBass = m.bass;
    const rate = m.live ? 1.4 : 0.6;
    this.hue += (target - this.hue) * Math.min(1, dt * rate);
    this.flash *= Math.exp(-dt * 5);
    this.updateModes(dt);
  }

  /**
   * Notes ring the room like a Chladni plate. A struck note excites its mode;
   * a held note keeps it ringing; everything decays over a couple of seconds.
   * Up to three modes overlap, so chords and melodies morph the figure.
   */
  private updateModes(dt: number) {
    const m = this.music;
    const on = m.live && this.params.cymatics > 0.001;
    const struck = m.onsets !== this.seenOnsets;
    this.seenOnsets = m.onsets;
    // Like a bowed plate: the figure belongs to the pitch sounding NOW. A new
    // pitch takes the plate as soon as it has held ~70 ms (so a passing blip
    // does not redraw the room), and the figures of earlier notes give way at
    // the rate set by `snap`, instead of all ringing together into mud.
    if (m.noteMidi !== this.candNote) {
      this.candNote = m.noteMidi;
      // wall clock, not simulation time: musical timing must not stretch
      // when the browser throttles frames
      this.candSince = performance.now() / 1000;
    }
    // smoke needs a moment to draw a figure: a pitch must hold 0.12-0.32 s
    // (Pattern change: instant … lingering) before it takes the plate
    const settle = 0.32 - this.params.snap * 0.2;
    const settled =
      this.candNote >= 0 &&
      performance.now() / 1000 - this.candSince > settle &&
      m.noteStrength > 0.06;
    const changed = settled && this.candNote !== this.curNote;
    if (changed) this.curNote = this.candNote;
    if (on && settled && (changed || struck || m.noteStrength > 0.15)) {
      const midi = this.curNote;
      const target = Math.min(
        1,
        0.5 + m.noteStrength * 0.4 + (struck ? m.onsetStrength * 0.4 : 0),
      );
      const same = this.modes.find((p) => p.midi === midi);
      if (same) {
        if (changed || struck) same.amp = Math.max(same.amp, target);
        else {
          // a held note keeps its figure ringing
          const hold = m.noteStrength * 0.75;
          if (same.amp < hold) same.amp += (hold - same.amp) * Math.min(1, dt * 1.5);
        }
      } else {
        if (this.modes.length >= PLATE_SLOTS) {
          this.modes.sort((a, b) => b.amp - a.amp);
          this.modes.pop();
        }
        const shape = this.params.plate === "water" ? waterModeFor(midi) : modeFor(midi);
        this.modes.push({ ...shape, amp: target });
      }
    }
    if (!settled && m.noteStrength < 0.05) this.curNote = -1;
    const giveWay = 1.6 - this.params.snap * 1.42; // lingering 1.6 s … instant 0.18 s
    for (const p of this.modes) {
      const tau = !on ? 0.6 : p.midi === this.curNote ? 2.2 : giveWay;
      p.amp *= Math.exp(-dt / tau);
    }
    this.modes = this.modes.filter((p) => p.amp > 0.02);
    const a = this.modeA;
    a.fill(0);
    this.modes.forEach((p, i) => {
      const o = i * 4;
      a[o] = p.n;
      a[o + 1] = p.m;
      a[o + 2] = p.sign * p.amp;
      a[o + 3] = p.rot;
    });
  }

  /** Dev/QA view of the plate: which notes' figures are ringing, and how hard. */
  plateState() {
    return {
      owner: this.curNote,
      cand: this.candNote,
      held: Math.round((performance.now() / 1000 - this.candSince) * 100) / 100,
      settle: 0.32 - this.params.snap * 0.2,
      live: this.music.live,
      modes: this.modes.map((p) => ({ midi: p.midi, amp: Math.round(p.amp * 100) / 100 })),
    };
  }

  private setPlate(prog: Program) {
    const gl = this.gl;
    const aspect = this.aspect();
    const c = lampToScreen(this.layout, aspect, 0, 0.56);
    const k = this.params.cymatics;
    gl.uniform4fv(prog.uniforms.uModes, this.modeA);
    // plate centred on the glass; radius in screen heights
    gl.uniform3f(prog.uniforms.uPlate, c.u, c.v, this.layout.height * 0.36);
    gl.uniform1f(prog.uniforms.uSpread, 2.6);
    gl.uniform1f(prog.uniforms.uCym, k);
    gl.uniform1f(prog.uniforms.uWater, this.params.plate === "water" ? 1 : 0);
  }

  // ---- public API ---------------------------------------------------------

  seed() {
    this.gobs.seed();
  }

  /**
   * Pointer drag in bottom-left screen UV. Inside the glass it nudges the wax
   * (or drips a new gob); outside it pushes the smoke around.
   */
  drag(u: number, v: number, du: number, dv: number, drip: boolean) {
    const aspect = this.aspect();
    const p = screenToLamp(this.layout, aspect, u, v);
    if (insideGlass(p.x, p.y)) {
      const scale = this.layout.height;
      this.gobs.stir(p.x, p.y, (du * aspect) / scale, dv / scale, drip, this.params.wax);
      return;
    }
    if (!this.smokeOn || !this.velocity) return;
    const gl = this.gl;
    const sp = this.programs.splat;
    gl.useProgram(sp.id);
    gl.uniform2f(sp.uniforms.uPoint, u, v);
    gl.uniform1f(sp.uniforms.uAspect, aspect);
    this.bind(0, this.velocity.read.texture);
    gl.uniform1i(sp.uniforms.uTarget, 0);
    gl.uniform3f(sp.uniforms.uColor, du * 5200, dv * 5200, 0);
    gl.uniform1f(sp.uniforms.uRadius, 0.0022);
    this.blit(this.velocity.write);
    this.velocity.swap();
    this.bind(0, this.dye.read.texture);
    const amount = Math.min(0.1, Math.hypot(du, dv) * 3);
    gl.uniform3f(sp.uniforms.uColor, amount, 0.03, amount * this.hue);
    gl.uniform1f(sp.uniforms.uRadius, 0.0016);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  step(dt: number) {
    if (this.destroyed) return;
    if (!this.resize()) return;
    const t = Math.min(Math.max(dt, 1 / 240), 1 / 30);
    this.govern(dt);
    if (!this.params.paused) {
      this.time += t;
      this.updateMusic(t);
      const p = this.params;
      this.gobs.update(t, {
        heat: p.heat,
        rise: p.rise,
        thickness: p.thickness,
        swirl: p.swirl,
        wax: p.wax,
        chill: p.chill,
        drive: p.drive,
        bass: this.bass,
      });
      if (this.smokeOn) this.simulate(t);
    }
    this.render();
  }

  /** Run physics forward by `seconds` without rendering (dev QA). */
  advance(seconds: number) {
    const p = this.params;
    for (let t = 0; t < seconds; t += 1 / 30) {
      this.time += 1 / 30;
      this.updateMusic(1 / 30);
      this.gobs.update(1 / 30, {
        heat: p.heat,
        rise: p.rise,
        thickness: p.thickness,
        swirl: p.swirl,
        wax: p.wax,
        chill: p.chill,
        drive: p.drive,
        bass: this.bass,
      });
      if (this.smokeOn) this.simulate(1 / 30);
    }
  }

  destroy() {
    // Don't lose the context: React's dev double-mount reuses this canvas.
    this.destroyed = true;
  }

  // ---- adaptive quality: hold frame pacing on slower GPUs ----------------

  private govern(dt: number) {
    const ms = dt * 1000;
    if (ms > 200) return; // tab was hidden; ignore
    this.frameEma += (ms - this.frameEma) * 0.05;
    if (this.frameEma > 24) {
      this.slowFor += dt;
      this.fastFor = 0;
    } else if (this.frameEma < 14) {
      this.fastFor += dt;
      this.slowFor = 0;
    } else {
      this.slowFor = 0;
      this.fastFor = 0;
    }
    if (this.slowFor > 1.5 && this.renderScale > 0.55) {
      this.renderScale = Math.max(0.55, this.renderScale * 0.85);
      this.slowFor = 0;
      this.frameEma = 16;
    } else if (this.fastFor > 6 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale * 1.1);
      this.fastFor = 0;
    }
  }

  // ---- smoke --------------------------------------------------------------

  /** Run the smoke for a few seconds up front so the first frame has wisps. */
  private prewarm() {
    if (!this.smokeOn) return;
    const keep = this.time;
    for (let i = 0; i < 240; i++) {
      this.time += 1 / 30;
      this.simulate(1 / 30);
    }
    this.time = keep;
  }

  private updateEmitters() {
    const a = this.emitA;
    const b = this.emitB;
    a.fill(0);
    b.fill(0);
    const t = this.time;
    const bass = this.bass * this.params.drive;
    // four wandering sources below the frame that breathe out wide puffs
    for (let i = 0; i < 4; i++) {
      const o = i * 4;
      const lane = (i + 0.5) / 4;
      const x = lane + 0.1 * noise1(t * 0.03 + i * 37.7);
      // bursty: mostly quiet, then a soft swell of smoke. While music plays,
      // the lamp's own weather steps back (by `lead`) so the song is what you see.
      const live = this.music.live;
      const own = live ? 1 - this.params.lead * 0.75 : 1;
      const swell = (noise1(t * 0.16 + i * 11.3) * 1.25 + 0.15) * own;
      // music: bass swells every source, beats push out a burst
      const music = live
        ? this.music.bass * this.params.drive * (0.6 + this.params.lead * 0.8) +
          this.flash * (0.6 + this.params.beats * 1.4)
        : 0;
      const puff = Math.max(0, swell) ** 1.5 + music;
      a[o] = Math.min(0.9, Math.max(0.1, x));
      a[o + 1] = 0.03;
      a[o + 2] = 0.0035 + 0.0025 * (noise1(t * 0.07 + i * 5.1) * 0.5 + 0.5);
      a[o + 3] = 0.3 * puff;
      b[o] = 1.2 * puff;
      b[o + 1] = noise1(t * 0.2 + i * 3.3) * 8;
      b[o + 2] = 10 + puff * 10;
      b[o + 3] = this.hue; // color tag: smoke remembers the light it was born in
    }
    // warm air off the cap: a thin, hot plume that pulses with the bass
    const aspect = this.aspect();
    const cap = lampToScreen(this.layout, aspect, 0, CAP_TOP + 0.02);
    const o = 4 * 4;
    a[o] = cap.u + noise1(t * 0.3) * 0.002;
    a[o + 1] = cap.v;
    a[o + 2] = 0.0005;
    a[o + 3] = 1.6 + bass * 2.2;
    b[o] = 0.9 + bass * 1.4;
    b[o + 1] = noise1(t * 0.5 + 9) * 6;
    b[o + 2] = 14 + bass * 20;
    b[o + 3] = this.hue;
  }

  private simulate(dt: number) {
    const gl = this.gl;
    const vel = this.velocity;
    const dye = this.dye;
    const texel = vel.read.texel;
    const aspect = this.aspect();
    this.updateEmitters();

    const inj = this.programs.inject;
    gl.useProgram(inj.id);
    this.bind(0, dye.read.texture);
    gl.uniform1i(inj.uniforms.uDye, 0);
    gl.uniform4fv(inj.uniforms.uEmitA, this.emitA);
    gl.uniform4fv(inj.uniforms.uEmitB, this.emitB);
    gl.uniform1f(inj.uniforms.uAspect, aspect);
    gl.uniform1f(inj.uniforms.uDt, dt);
    this.setPlate(inj);
    gl.uniform1f(inj.uniforms.uTag, this.hue);
    this.blit(dye.write);
    dye.swap();

    const f = this.programs.forces;
    gl.useProgram(f.id);
    this.bind(0, vel.read.texture);
    this.bind(1, dye.read.texture);
    gl.uniform1i(f.uniforms.uVelocity, 0);
    gl.uniform1i(f.uniforms.uDye, 1);
    gl.uniform4fv(f.uniforms.uEmitA, this.emitA);
    gl.uniform4fv(f.uniforms.uEmitB, this.emitB);
    gl.uniform1f(f.uniforms.uAspect, aspect);
    gl.uniform1f(f.uniforms.uDt, dt);
    gl.uniform1f(f.uniforms.uTime, this.time);
    const treble = this.music.live ? this.music.treble * this.params.drive : 0;
    gl.uniform1f(f.uniforms.uTurb, 0.9 + this.params.swirl * 1.8 + treble * 2.2);
    gl.uniform1f(f.uniforms.uBuoy, 24);
    gl.uniform2f(f.uniforms.uTexel, texel[0], texel[1]);
    this.setPlate(f);
    this.blit(vel.write);
    vel.swap();

    const c = this.programs.curl;
    gl.useProgram(c.id);
    this.bind(0, vel.read.texture);
    gl.uniform1i(c.uniforms.uVelocity, 0);
    gl.uniform2f(c.uniforms.uTexel, texel[0], texel[1]);
    this.blit(this.curl);

    const vo = this.programs.vorticity;
    gl.useProgram(vo.id);
    this.bind(0, vel.read.texture);
    this.bind(1, this.curl.texture);
    gl.uniform1i(vo.uniforms.uVelocity, 0);
    gl.uniform1i(vo.uniforms.uCurl, 1);
    gl.uniform2f(vo.uniforms.uTexel, texel[0], texel[1]);
    gl.uniform1f(vo.uniforms.uCurlStrength, 6);
    gl.uniform1f(vo.uniforms.uDt, dt);
    this.blit(vel.write);
    vel.swap();

    const dv = this.programs.divergence;
    gl.useProgram(dv.id);
    this.bind(0, vel.read.texture);
    gl.uniform1i(dv.uniforms.uVelocity, 0);
    gl.uniform2f(dv.uniforms.uTexel, texel[0], texel[1]);
    this.blit(this.divergence);

    const sc = this.programs.scale;
    gl.useProgram(sc.id);
    this.bind(0, this.pressure.read.texture);
    gl.uniform1i(sc.uniforms.uTexture, 0);
    gl.uniform1f(sc.uniforms.uValue, 0.8);
    this.blit(this.pressure.write);
    this.pressure.swap();

    const pr = this.programs.pressure;
    gl.useProgram(pr.id);
    this.bind(1, this.divergence.texture);
    gl.uniform1i(pr.uniforms.uDivergence, 1);
    gl.uniform1i(pr.uniforms.uPressure, 0);
    gl.uniform2f(pr.uniforms.uTexel, texel[0], texel[1]);
    for (let i = 0; i < 20; i++) {
      this.bind(0, this.pressure.read.texture);
      this.blit(this.pressure.write);
      this.pressure.swap();
    }

    const gr = this.programs.gradient;
    gl.useProgram(gr.id);
    this.bind(0, this.pressure.read.texture);
    this.bind(1, vel.read.texture);
    gl.uniform1i(gr.uniforms.uPressure, 0);
    gl.uniform1i(gr.uniforms.uVelocity, 1);
    gl.uniform2f(gr.uniforms.uTexel, texel[0], texel[1]);
    this.blit(vel.write);
    vel.swap();

    const ad = this.programs.advect;
    gl.useProgram(ad.id);
    this.bind(0, vel.read.texture);
    this.bind(1, vel.read.texture);
    gl.uniform1i(ad.uniforms.uVelocity, 0);
    gl.uniform1i(ad.uniforms.uSource, 1);
    gl.uniform2f(ad.uniforms.uTexel, texel[0], texel[1]);
    gl.uniform1f(ad.uniforms.uDt, dt);
    gl.uniform1f(ad.uniforms.uDissipation, Math.exp(-0.25 * dt));
    this.blit(vel.write);
    vel.swap();

    this.bind(0, vel.read.texture);
    this.bind(1, dye.read.texture);
    gl.uniform1f(ad.uniforms.uDissipation, Math.exp(-0.11 * dt));
    this.blit(dye.write);
    dye.swap();
  }

  // ---- render -------------------------------------------------------------

  private render() {
    const gl = this.gl;
    const pal = this.params.palette;
    const light = this.lightColor();
    const bass = this.bass * this.params.drive;

    // 1. backdrop + smoke (half res)
    const bd = this.programs.backdrop;
    gl.useProgram(bd.id);
    this.setLayout(bd);
    if (this.dye) this.bind(0, this.dye.read.texture);
    gl.uniform1i(bd.uniforms.uDye, 0);
    gl.uniform3f(bd.uniforms.uLight, light[0], light[1], light[2]);
    const base = this.baseLight();
    gl.uniform3f(bd.uniforms.uLightBase, base[0], base[1], base[2]);
    gl.uniform1f(bd.uniforms.uTagMix, Math.min(1, this.params.hue * 1.2));
    gl.uniform1f(bd.uniforms.uSmokeOn, this.smokeOn ? 1 : 0);
    this.blit(this.scene);

    // 2. lamp over the backdrop (HDR)
    const lp = this.programs.lamp;
    gl.useProgram(lp.id);
    this.setLayout(lp);
    this.bind(0, this.scene.texture);
    this.bind(1, this.envTex);
    gl.uniform1i(lp.uniforms.uScene, 0);
    gl.uniform1i(lp.uniforms.uEnv, 1);
    gl.uniform2f(lp.uniforms.uResolution, this.comp.width, this.comp.height);
    gl.uniform1f(lp.uniforms.uTime, this.time);
    gl.uniform1f(lp.uniforms.uGlow, this.params.glow);
    // the wax glows with the low end and flares on beats
    gl.uniform1f(lp.uniforms.uBass, bass + this.flash * this.params.pulse * 0.8);
    gl.uniform3f(lp.uniforms.uCool, pal.cool[0], pal.cool[1], pal.cool[2]);
    gl.uniform3f(lp.uniforms.uMid, pal.mid[0], pal.mid[1], pal.mid[2]);
    gl.uniform3f(lp.uniforms.uHot, pal.hot[0], pal.hot[1], pal.hot[2]);
    gl.uniform3f(lp.uniforms.uLiquid, pal.liquid[0], pal.liquid[1], pal.liquid[2]);
    gl.uniform3f(lp.uniforms.uLight, light[0], light[1], light[2]);
    const blobs = this.gobs.pack(this.params.wax);
    gl.uniform4fv(lp.uniforms.uBlobA, blobs, 0, GOB_SLOTS * 4);
    gl.uniform4fv(lp.uniforms.uBlobB, blobs, GOB_SLOTS * 4, GOB_SLOTS * 4);
    this.blit(this.comp);

    // 3. bloom
    const pf = this.programs.prefilter;
    gl.useProgram(pf.id);
    this.bind(0, this.comp.texture);
    gl.uniform1i(pf.uniforms.uTexture, 0);
    gl.uniform2f(pf.uniforms.uTexel, this.comp.texel[0], this.comp.texel[1]);
    gl.uniform1f(pf.uniforms.uThreshold, 0.55);
    this.blit(this.bloomA.read);

    const bl = this.programs.blur;
    gl.useProgram(bl.id);
    gl.uniform1i(bl.uniforms.uTexture, 0);
    const blur = (d: DoubleFBO) => {
      this.bind(0, d.read.texture);
      gl.uniform2f(bl.uniforms.uDir, d.read.texel[0], 0);
      this.blit(d.write);
      d.swap();
      this.bind(0, d.read.texture);
      gl.uniform2f(bl.uniforms.uDir, 0, d.read.texel[1]);
      this.blit(d.write);
      d.swap();
    };
    blur(this.bloomA);
    // downsample A into B, then blur wider
    this.bind(0, this.bloomA.read.texture);
    gl.uniform2f(bl.uniforms.uDir, this.bloomA.read.texel[0] * 0.5, this.bloomA.read.texel[1] * 0.5);
    this.blit(this.bloomB.read);
    blur(this.bloomB);
    blur(this.bloomB);

    // 4. final
    const fp = this.programs.final;
    gl.useProgram(fp.id);
    this.setLayout(fp);
    this.bind(0, this.comp.texture);
    this.bind(1, this.bloomA.read.texture);
    this.bind(2, this.bloomB.read.texture);
    this.bind(3, this.noiseTex);
    gl.uniform1i(fp.uniforms.uComp, 0);
    gl.uniform1i(fp.uniforms.uBloomA, 1);
    gl.uniform1i(fp.uniforms.uBloomB, 2);
    gl.uniform1i(fp.uniforms.uNoise, 3);
    gl.uniform2f(fp.uniforms.uNoiseOffset, Math.random(), Math.random());
    gl.uniform1f(fp.uniforms.uBloom, 0.35 + this.params.glow * 0.5 + bass * 0.25);
    gl.uniform1f(fp.uniforms.uExposure, 1.15);
    this.blit(null);
  }
}
