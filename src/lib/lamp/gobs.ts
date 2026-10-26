import { GLASS_BOTTOM, GLASS_TOP, innerRadius } from "./geometry.ts";

/**
 * Wax physics for the lamp, in lamp space (see geometry.ts).
 *
 * Nothing here runs on a cycle. Motion comes from heat:
 *  - The coil heats a pool of wax at the bottom. When it gets warm enough it
 *    domes up into a bud that draws wax from the pool, stretches into a neck
 *    and pinches off.
 *  - Each blob carries its own temperature and trades heat with the liquid
 *    around it. Small blobs heat and cool faster (surface vs. volume).
 *  - Buoyancy follows temperature. Drag is Stokes-like, so big warm blobs rise
 *    faster than small ones and everything moves slower in thicker liquid.
 *  - The liquid itself carries slow convection currents built from evolving
 *    3D value noise — never periodic.
 *  - Blobs stretch along their motion, wobble on a damped spring when they
 *    detach or bump, flatten against the top, cool, sink and rejoin the pool.
 */

export interface Gob {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Wax amount, as an unscaled squared radius. */
  a: number;
  temp: number;
  /** Elongation along `ang` (1 = round, >1 stretched, <1 squashed). */
  s: number;
  sv: number;
  ang: number;
  seed: number;
  /** Still tethered to the pool and drawing wax from it. */
  bud: boolean;
  budGoal: number;
  /** Index of the gob this one is draining into, or -1. */
  into: number;
  age: number;
}

export const GOB_SLOTS = 16;
const POOL_Y = GLASS_BOTTOM + 0.03;
const POOL_STRETCH = 0.34;

function fract(v: number) {
  return v - Math.floor(v);
}
function hash3(x: number, y: number, z: number) {
  return fract(Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453);
}
function smooth(f: number) {
  return f * f * (3 - 2 * f);
}
/** Smooth 3D value noise in [-1, 1]. */
function noise3(x: number, y: number, z: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const fz = smooth(z - iz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), fx);
  const x10 = lerp(c(0, 1, 0), c(1, 1, 0), fx);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), fx);
  const x11 = lerp(c(0, 1, 1), c(1, 1, 1), fx);
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz) * 2 - 1;
}

export interface WaxInputs {
  heat: number;
  rise: number;
  thickness: number;
  swirl: number;
  wax: number;
  chill: number;
  drive: number;
  bass: number;
}

export class WaxGobs {
  blobs: Gob[] = [];
  time = 0;
  private budCooldown = 0;
  private prevBass = 0;
  private packed = new Float32Array(GOB_SLOTS * 8);

  private make(partial: Partial<Gob>): Gob {
    return {
      x: 0,
      y: 0.5,
      vx: 0,
      vy: 0,
      a: 0.0006,
      temp: 0.5,
      s: 1,
      sv: 0,
      ang: 0,
      seed: Math.random() * 1000,
      bud: false,
      budGoal: 0,
      into: -1,
      age: 0,
      ...partial,
    };
  }

  /** Start mid-cycle so the lamp is alive on first paint. */
  seed() {
    this.time = Math.random() * 500;
    this.budCooldown = 3;
    this.blobs = [
      this.make({ x: 0, y: POOL_Y, a: 0.056 * 0.056, temp: 0.78, s: POOL_STRETCH }),
      this.make({ x: -0.018, y: 0.44, a: 0.032 * 0.032, temp: 0.8, vy: 0.02, s: 1.25 }),
      this.make({ x: 0.022, y: 0.6, a: 0.024 * 0.024, temp: 0.62, vy: 0.012 }),
      this.make({ x: -0.006, y: 0.8, a: 0.03 * 0.03, temp: 0.36, vy: 0.002, s: 0.85 }),
      this.make({ x: 0.03, y: 0.68, a: 0.017 * 0.017, temp: 0.3, vy: -0.01 }),
    ];
  }

  private liquidTemp(y: number, heat: number) {
    const t = (y - GLASS_BOTTOM) / (GLASS_TOP - GLASS_BOTTOM);
    return 0.2 + (0.35 + heat * 0.75) * Math.exp(-t / 0.22) + 0.22 * (1 - t);
  }

  /** Divergence-free convection: curl of an evolving noise stream function. */
  private current(x: number, y: number, swirl: number, heat: number) {
    const z = this.time * (0.025 + swirl * 0.05);
    const f = 7.5;
    const e = 0.01;
    const psi = (px: number, py: number) =>
      noise3(px * f, py * f, z) + 0.45 * noise3(px * f * 2.1 + 17, py * f * 2.1, z * 1.7);
    const dpdy = (psi(x, y + e) - psi(x, y - e)) / (2 * e);
    const dpdx = (psi(x + e, y) - psi(x - e, y)) / (2 * e);
    const amp = 0.0011 * (0.3 + swirl * 2.6);
    const r = innerRadius(y);
    const lateral = 1 - Math.min(1, (x / r) * (x / r));
    // Warm liquid wells up the middle and slides down the walls.
    const updraft = (0.0015 + heat * 0.003) * (lateral * 1.6 - 0.6);
    return { ux: dpdy * amp, uy: -dpdx * amp + updraft };
  }

  update(dt: number, p: WaxInputs) {
    const step = Math.min(Math.max(dt, 0.001), 0.033);
    this.time += step;
    const pool = this.blobs[0];
    if (!pool) return;

    const scale = 0.72 + p.wax * 0.5;
    const pace = 0.45 + p.rise * 2.4;
    const visc = 0.45 + p.thickness * 1.7;
    const bass = p.bass * p.drive;
    const onset = Math.max(0, p.bass - this.prevBass) * p.drive;
    this.prevBass = p.bass;
    const coil = (0.25 + p.heat * 1.1) * (1 + bass * 1.4);

    // ---- pool: heated by the coil, feeds buds -------------------------------
    pool.temp += (1.25 - pool.temp) * coil * 0.05 * step;
    pool.temp += (0.35 - pool.temp) * 0.012 * step;
    pool.x += (0 - pool.x) * step * 0.8;
    // the pool rests on the glass floor whatever its size
    const restY = GLASS_BOTTOM + 0.006 + Math.sqrt(pool.a) * scale * Math.sqrt(POOL_STRETCH) * 0.45;
    pool.y += (restY - pool.y) * step * 2;
    pool.vx = 0;
    pool.vy = 0;
    const poolR = Math.sqrt(pool.a) * scale;
    const poolTop = pool.y + poolR * Math.sqrt(POOL_STRETCH) * 0.85;
    pool.s += (POOL_STRETCH - pool.s) * step * 2 + pool.sv * step;
    pool.sv *= Math.exp(-step * 3);

    this.budCooldown -= step * (1 + bass * 2);
    const hasBud = this.blobs.some((b) => b.bud);
    if (
      !hasBud &&
      this.budCooldown <= 0 &&
      pool.temp > 0.66 &&
      pool.a > 0.03 * 0.03 &&
      this.blobs.length < GOB_SLOTS
    ) {
      const lean = noise3(this.time * 0.13, 3.3, 9.1);
      const big = 0.016 + Math.random() * 0.018 + p.heat * 0.008 + bass * 0.01;
      pool.a -= 0.006 * 0.006;
      this.blobs.push(
        this.make({
          x: lean * poolR * 0.55,
          y: poolTop - 0.004,
          a: 0.006 * 0.006,
          temp: pool.temp,
          s: 1.1,
          bud: true,
          budGoal: big * big,
        }),
      );
      this.budCooldown = (2.5 + Math.random() * 4) / (0.4 + p.heat * 1.2) + (1 - p.rise) * 3;
    }

    // ---- free blobs and buds ------------------------------------------------
    for (let i = 1; i < this.blobs.length; i++) {
      const b = this.blobs[i];
      if (!b) continue;
      b.age += step;
      const r = Math.sqrt(b.a) * scale;
      const rn = Math.max(0.35, r / 0.03);

      // Heat exchange, faster for small blobs. The middle of the bottle is
      // nearly insulating: wax picks up heat by the coil, sheds it under the
      // cap and mostly coasts in between, which is what keeps a lamp cycling
      // instead of hovering.
      const tl = this.liquidTemp(b.y, p.heat);
      const fromBottom = (b.y - GLASS_BOTTOM) / (GLASS_TOP - GLASS_BOTTOM);
      const nearCoil = Math.exp(-fromBottom / 0.12);
      const top = Math.max(0, (b.y - (GLASS_TOP - 0.14)) / 0.14);
      const exchange = 0.008 + 0.11 * nearCoil;
      b.temp += (tl - b.temp) * (exchange / rn) * step;
      b.temp += (0.06 - b.temp) * top * (0.07 + p.chill * 0.4) * step / rn;
      b.temp = Math.min(1.25, Math.max(0.02, b.temp));

      const { ux, uy } = this.current(b.x, b.y, p.swirl, p.heat);
      const buoy = 0.037 * pace * (b.temp - 0.5);
      const drag = (0.00045 * visc) / Math.max(r * r, 0.00012);

      if (b.bud) {
        // Draw wax from the pool while tethered just above it.
        const rate = (0.6 + p.heat * 1.4 + bass * 2 + onset * 12) * b.budGoal * 0.12;
        const take = Math.min(rate * step, pool.a - 0.022 * 0.022);
        if (take > 0) {
          b.a += take;
          pool.a -= take;
        }
        b.temp += (pool.temp - b.temp) * step * 0.8;
        const fill = Math.min(1, b.a / b.budGoal);
        const tether = poolTop + r * (0.25 + fill * 0.55);
        b.vy += ((tether - b.y) * 2.5 - b.vy * 1.8) * step + buoy * 0.4 * step;
        b.vx += (-b.x * 0.4 - b.vx * 1.2) * step + ux * step;
        b.s += (1.3 + fill * 0.55 - b.s) * step * 1.5;
        if (fill >= 1 || pool.a <= 0.0225 * 0.0225) {
          b.bud = false;
          b.vy = Math.max(b.vy, 0.006 + buoy * 0.5);
          b.sv -= 0.9; // snap of the neck breaking
        }
      } else {
        b.vx += ((ux - b.vx) * drag) * step;
        b.vy += (buoy + (uy - b.vy) * drag) * step;
        if (onset > 0.03 && b.y < 0.55 && b.temp > 0.55) b.vy += onset * 0.03;
        const cap = 0.09 * pace;
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > cap) {
          b.vx *= cap / sp;
          b.vy *= cap / sp;
        }

        // shape: stretched along motion, damped spring → wobble
        const speed = Math.hypot(b.vx, b.vy);
        let target = 1 + Math.min(0.75, speed * 14);
        const nearTop = GLASS_TOP - 0.01 - r;
        if (b.y > nearTop - r * 0.4) target = 0.72;
        const w = 2.4;
        b.sv += (-(w * w) * (b.s - target) - 2 * 0.22 * w * b.sv) * step;
        if (speed > 0.004) {
          const want = Math.atan2(b.vx, b.vy);
          let d = want - b.ang;
          if (d > Math.PI / 2) d -= Math.PI;
          if (d < -Math.PI / 2) d += Math.PI;
          b.ang += d * Math.min(1, step * 1.2);
        } else {
          b.ang *= 1 - Math.min(1, step * 0.6);
        }
      }
      b.s += b.sv * step;
      b.s = Math.min(2.4, Math.max(0.55, b.s));

      b.x += b.vx * step;
      b.y += b.vy * step;

      // glass walls and top
      const sq = Math.sqrt(b.s);
      const rx = r / sq;
      const ry = r * sq;
      const wall = innerRadius(b.y) - rx * 0.82;
      if (Math.abs(b.x) > wall) {
        b.x = Math.sign(b.x) * Math.max(0, wall);
        b.vx = -b.vx * 0.2;
        b.sv += 0.3 * Math.min(1, Math.abs(b.vx) * 40);
      }
      const ceiling = GLASS_TOP - 0.012 - ry * 0.75;
      if (b.y > ceiling) {
        b.y = ceiling;
        if (b.vy > 0) b.sv -= b.vy * 8;
        b.vy = Math.min(0, b.vy) * 0.3;
      }

      // sinking wax rejoins the pool
      if (!b.bud && b.into < 0 && b.vy <= 0.002 && b.y - ry < poolTop + 0.004) {
        b.into = 0;
      }
      if (b.y < poolTop - ry * 0.6) b.y = poolTop - ry * 0.6;
    }

    // ---- contact between blobs: squash, occasionally coalesce ---------------
    for (let i = 1; i < this.blobs.length; i++) {
      const a = this.blobs[i];
      if (!a || a.into >= 0) continue;
      for (let j = i + 1; j < this.blobs.length; j++) {
        const b = this.blobs[j];
        if (!b || b.into >= 0) continue;
        const ra = Math.sqrt(a.a) * scale;
        const rb = Math.sqrt(b.a) * scale;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1e-5;
        const min = (ra + rb) * 0.86;
        if (dist >= min) continue;
        const rel = Math.hypot(b.vx - a.vx, b.vy - a.vy);
        const alike =
          Math.abs(a.temp - b.temp) < 0.2 &&
          !a.bud &&
          !b.bud &&
          Math.sqrt(a.a + b.a) * scale < 0.05;
        if (alike && rel < 0.025 && Math.random() < step * 0.25) {
          if (a.a >= b.a) b.into = i;
          else a.into = j;
          continue;
        }
        const push = (min - dist) * 0.5;
        const nx = dx / dist;
        const ny = dy / dist;
        const wa = b.a / (a.a + b.a);
        const wb = 1 - wa;
        a.x -= nx * push * wa;
        a.y -= ny * push * wa;
        b.x += nx * push * wb;
        b.y += ny * push * wb;
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          a.vx += nx * vn * wa;
          a.vy += ny * vn * wa;
          b.vx -= nx * vn * wb;
          b.vy -= ny * vn * wb;
          a.sv -= Math.abs(vn) * 6;
          b.sv -= Math.abs(vn) * 6;
        }
      }
    }

    // ---- drain merging blobs smoothly into their target ---------------------
    for (let i = this.blobs.length - 1; i >= 1; i--) {
      const b = this.blobs[i];
      if (!b || b.into < 0) continue;
      const t = this.blobs[b.into];
      if (!t || t === b) {
        b.into = -1;
        continue;
      }
      const flow = Math.min(b.a, (b.a * 0.9 + 0.00002) * step);
      const total = t.a + flow;
      t.temp = (t.temp * t.a + b.temp * flow) / total;
      if (t !== pool) {
        t.vx = (t.vx * t.a + b.vx * flow) / total;
        t.vy = (t.vy * t.a + b.vy * flow) / total;
      }
      t.a = total;
      b.a -= flow;
      b.x += (t.x - b.x) * Math.min(1, step * 1.1);
      b.y += (t.y - b.y) * Math.min(1, step * 1.1);
      if (b.a < 0.003 * 0.003) {
        t.a += b.a;
        this.blobs.splice(i, 1);
        for (const o of this.blobs) {
          if (o.into === i) o.into = b.into > i ? b.into - 1 : b.into;
          else if (o.into > i) o.into -= 1;
        }
      }
    }

    // ---- a big, fast, stretched blob sometimes tears in two -----------------
    for (let i = 1; i < this.blobs.length && this.blobs.length < GOB_SLOTS; i++) {
      const b = this.blobs[i];
      if (!b || b.bud || b.into >= 0) continue;
      const r = Math.sqrt(b.a) * scale;
      if (r > 0.036 && b.s > 1.45 && b.vy > 0.015 && Math.random() < step * 0.08) {
        const share = 0.42 + Math.random() * 0.12;
        const off = r * 0.55;
        const ox = Math.sin(b.ang) * off;
        const oy = Math.cos(b.ang) * off;
        const lower = this.make({
          x: b.x - ox,
          y: b.y - oy,
          vx: b.vx * 0.8,
          vy: b.vy * 0.7,
          a: b.a * (1 - share),
          temp: b.temp - 0.04,
          s: 1.2,
          sv: 0.6,
          ang: b.ang,
        });
        b.a *= share;
        b.x += ox * 0.6;
        b.y += oy * 0.6;
        b.sv += 0.8;
        this.blobs.push(lower);
        break;
      }
    }
  }

  stir(x: number, y: number, dx: number, dy: number, drip: boolean, wax: number) {
    if (drip) {
      if (this.blobs.length >= GOB_SLOTS) return;
      this.blobs.push(
        this.make({ x, y, vx: dx * 1.2, vy: dy * 1.2, a: 0.02 * 0.02, temp: 0.9, s: 1.3, sv: 0.5 }),
      );
      return;
    }
    const scale = 0.72 + wax * 0.5;
    for (let i = 1; i < this.blobs.length; i++) {
      const b = this.blobs[i];
      if (!b) continue;
      const r = Math.sqrt(b.a) * scale;
      const d = Math.hypot(b.x - x, b.y - y);
      const reach = r + 0.035;
      if (d > reach) continue;
      const k = 1 - d / reach;
      b.vx += dx * 3 * k;
      b.vy += dy * 3 * k;
      b.sv += Math.hypot(dx, dy) * 30 * k;
      if (b.bud && Math.hypot(dx, dy) > 0.004) {
        b.bud = false;
        b.sv -= 0.6;
      }
    }
  }

  /** Two vec4 per slot: (x, y, r, temp) and (stretch, angle, 0, 0). */
  pack(wax: number): Float32Array {
    const scale = 0.72 + wax * 0.5;
    const data = this.packed;
    data.fill(0);
    for (let i = 0; i < GOB_SLOTS; i++) {
      const b = this.blobs[i];
      if (!b) continue;
      const o = i * 4;
      data[o] = b.x;
      data[o + 1] = b.y;
      data[o + 2] = Math.sqrt(b.a) * scale;
      data[o + 3] = b.temp;
      const q = GOB_SLOTS * 4 + o;
      data[q] = b.s;
      data[q + 1] = b.ang;
    }
    return data;
  }
}
