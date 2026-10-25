export interface WaxGob {
  x: number;
  y: number;
  base: number;
  r: number;
  temp: number;
  vx: number;
  vy: number;
  phase: number;
  goal?: number;
}

export const GOB_SLOTS = 8;

export class WaxGobs {
  blobs: WaxGob[] = [];
  time = 0;
  private emit = 0;
  private prevBass = 0;

  seed() {
    this.time = 0;
    this.emit = 1.2;
    this.blobs = [
      { x: 0.5, y: 0.14, base: 0.36, r: 0.36, temp: 0.95, vx: 0, vy: 0, phase: 0.4 },
      { x: 0.44, y: 0.34, base: 0.16, r: 0.16, temp: 0.9, vx: 0.01, vy: 0.03, phase: 1.7 },
      { x: 0.58, y: 0.5, base: 0.14, r: 0.14, temp: 0.55, vx: -0.012, vy: 0.015, phase: 3.1 },
      { x: 0.42, y: 0.66, base: 0.13, r: 0.13, temp: 0.28, vx: 0.01, vy: -0.025, phase: 4.4 },
      { x: 0.6, y: 0.8, base: 0.12, r: 0.12, temp: 0.16, vx: -0.008, vy: -0.03, phase: 5.6 },
    ];
  }

  update(
    dt: number,
    heat: number,
    rise: number,
    thickness: number,
    swirl: number,
    wax: number,
    chill: number,
    drive: number,
    bass: number,
  ) {
    const step = Math.min(Math.max(dt, 0.001), 0.033);
    this.time += step;
    const pool = this.blobs[0];
    if (!pool) return;

    const pace = Math.pow(rise, 0.8);
    const scale = 0.45 + wax * 0.95;
    const onset = Math.max(0, bass - this.prevBass);
    this.prevBass = bass;
    for (const b of this.blobs) {
      if (!b.base) b.base = b.r || 0.12;
      if (!b.phase) b.phase = Math.random() * 6.28;
      if (b.goal == null) b.goal = b.base;
      if (b !== pool) {
        const rate = b.base > b.goal ? 2.4 : 0.8;
        b.base += (b.goal - b.base) * Math.min(1, step * rate);
      }
      const breathe = 1 + Math.sin(this.time * 0.65 + b.phase) * 0.045;
      const pulse = b === pool ? 1 + bass * drive * 0.14 : 1;
      const cap = b === pool ? 0.48 : 0.26;
      b.r = Math.min(cap, b.base * scale * breathe * pulse);
      const low = b.y < 0.22 ? 1 : 0;
      b.temp += heat * low * (1.08 - b.temp) * step * 0.85;
      const high = b.y > 0.7 ? Math.min(1, (b.y - 0.7) / 0.2) : 0;
      b.temp += (0.08 - b.temp) * chill * high * step * 1.15;
      b.temp += (0.5 - b.temp) * step * 0.02;
      b.temp = Math.min(1.15, Math.max(0.05, b.temp));

      const climb = (b.temp - 0.48) * (0.01 + pace * 0.74);
      b.vy += (climb - b.vy) * Math.min(1, step * (0.28 + rise * 2.4) / (0.45 + thickness));
      const amp = 0.004 + pace * (0.03 + swirl * 0.12);
      const wander =
        Math.sin(this.time * (0.23 + rise * 0.55) + b.phase) * amp +
        Math.sin(this.time * (0.57 + swirl * 0.35) + b.phase * 1.8) * amp * 0.75;
      b.vx += (wander - b.vx) * Math.min(1, step * (0.25 + rise * 1.4));
      if (Math.random() < step * (0.35 + swirl * 1.8)) {
        b.vx += (Math.random() - 0.5) * amp * 1.6;
        b.vy += (Math.random() - 0.5) * amp * 0.7;
      }
      if (b !== pool && b.y < 0.48) {
        b.vy += bass * drive * 0.85 * step;
        if (onset > 0.025) b.vy += onset * drive * 0.45;
      }

      b.x += b.vx * step;
      b.y += b.vy * step;

      const side = 0.2 + b.r * 0.15;
      if (b.x < side) {
        b.x = side;
        b.vx = Math.abs(b.vx) * 0.5;
      }
      if (b.x > 1 - side) {
        b.x = 1 - side;
        b.vx = -Math.abs(b.vx) * 0.5;
      }
      if (b.y < 0.07) {
        b.y = 0.07;
        b.vy = Math.abs(b.vy) * 0.25;
      }
      if (b.y > 0.9) {
        b.y = 0.9;
        b.vy = -Math.abs(b.vy) * 0.45;
      }
    }

    pool.x += (0.5 - pool.x) * Math.min(1, step * 0.6);
    pool.y += (0.12 - pool.y) * Math.min(1, step * 1.4);
    pool.vx *= 0.9;
    pool.vy *= 0.8;

    for (let i = 0; i < this.blobs.length; i++) {
      for (let j = i + 1; j < this.blobs.length; j++) {
        const a = this.blobs[i];
        const b = this.blobs[j];
        if (!a || !b) continue;
        if (i === 0 && b.y < 0.36) continue;
        const dx = b.x - a.x;
        const dy = (b.y - a.y) * 2.4;
        const dist = Math.hypot(dx, dy) || 0.0001;
        const min = (a.r + b.r) * 0.28;
        if (dist < min) {
          const push = (min - dist) * 0.5;
          const nx = dx / dist;
          const ny = dy / dist;
          if (i !== 0) {
            a.x -= nx * push;
            a.y -= (ny * push) / 2.4;
          }
          b.x += nx * push;
          b.y += (ny * push) / 2.4;
        }
      }
    }

    this.emit -= step;
    if (this.emit <= 0 && this.blobs.length < GOB_SLOTS && pool.temp > 0.7) {
      this.emit = 3.2 + (1 - heat) * 2.4 + (1 - rise) * 10;
      this.blobs.push({
        x: pool.x + (Math.random() - 0.5) * 0.04,
        y: pool.y + 0.02,
        r: 0,
        base: 0.028,
        goal: 0.11 + Math.random() * 0.04,
        temp: 0.8 + heat * 0.18,
        vx: (Math.random() - 0.5) * 0.008,
        vy: 0.008 + pace * 0.02,
        phase: Math.random() * 6.28,
      });
    }

    for (let i = this.blobs.length - 1; i >= 1; i--) {
      const b = this.blobs[i];
      if (!b) continue;
      const close = Math.hypot(b.x - pool.x, (b.y - pool.y) * 2.2);
      if (b.temp < 0.4 && b.y < 0.36 && close < pool.r * 1.05) {
        b.goal = 0.016;
        b.x += (pool.x - b.x) * Math.min(1, step * 1.5);
        b.y += (pool.y + 0.015 - b.y) * Math.min(1, step * 1.8);
        if (b.base < 0.03) this.blobs.splice(i, 1);
      }
    }
  }

  stir(x: number, y: number, dx: number, dy: number, drip: boolean) {
    if (drip && this.blobs.length < GOB_SLOTS) {
      this.blobs.push({
        x,
        y,
        r: 0,
        base: 0.11,
        goal: 0.12,
        temp: 0.9,
        vx: dx * 1.5,
        vy: dy * 1.5,
        phase: Math.random() * 6.28,
      });
      return;
    }
    let nearest = 0;
    let best = 1e9;
    for (let i = 0; i < this.blobs.length; i++) {
      const b = this.blobs[i];
      if (!b) continue;
      const d = Math.hypot(b.x - x, (b.y - y) * 2.2);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    const b = this.blobs[nearest];
    if (!b || nearest === 0) return;
    b.vx += dx * 2.2;
    b.vy += dy * 2.2;
  }

  pack(): Float32Array {
    const data = new Float32Array(GOB_SLOTS * 4);
    for (let i = 0; i < GOB_SLOTS; i++) {
      const b = this.blobs[i];
      const o = i * 4;
      if (!b) continue;
      data[o] = b.x;
      data[o + 1] = b.y;
      data[o + 2] = b.r;
      data[o + 3] = b.temp;
    }
    return data;
  }
}
