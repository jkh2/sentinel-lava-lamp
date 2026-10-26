/**
 * Lamp geometry, shared by the renderer, the wax physics and pointer input so
 * all three agree on where the glass is.
 *
 * "Lamp space": origin at the centre of the base's footprint, +y up, one unit
 * equals the lamp's full height. The shader carries an exact GLSL copy of the
 * profile functions below (see LAMP_GLSL in shaders.ts) — change both together.
 */

export const BASE_TOP = 0.29;
export const GLASS_BOTTOM = 0.285;
export const GLASS_TOP = 0.875;
export const CAP_BOTTOM = 0.865;
export const CAP_TOP = 0.975;

/** Classic rocket profile: flares out to a belly low on the glass, then tapers. */
export function glassRadius(y: number): number {
  const t = Math.min(1, Math.max(0, (y - GLASS_BOTTOM) / (GLASS_TOP - GLASS_BOTTOM)));
  if (t < 0.3) {
    const k = (0.3 - t) / 0.3;
    return 0.09 - 0.018 * k * k;
  }
  return 0.09 - 0.038 * Math.pow((t - 0.3) / 0.7, 1.5);
}

/** Inner (liquid) radius: glass wall is ~4% of the radius thick. */
export function innerRadius(y: number): number {
  return glassRadius(y) * 0.955;
}

export interface LampLayout {
  /** Lamp height as a fraction of the screen height. */
  height: number;
  /** Screen-UV x of the lamp axis. */
  cx: number;
  /** Screen-UV y of the base's footprint (table contact line). */
  floor: number;
}

export function lampLayout(screenWidth: number, screenHeight: number): LampLayout {
  const narrow = screenWidth < 840;
  const tall = screenHeight > screenWidth * 1.4;
  return {
    height: tall ? 0.74 : narrow ? 0.8 : 0.84,
    cx: 0.5,
    floor: tall ? 0.15 : 0.085,
  };
}

/** Bottom-left screen UV → lamp space. */
export function screenToLamp(
  layout: LampLayout,
  aspect: number,
  u: number,
  v: number,
): { x: number; y: number } {
  return {
    x: ((u - layout.cx) * aspect) / layout.height,
    y: (v - layout.floor) / layout.height,
  };
}

/** Lamp space → bottom-left screen UV. */
export function lampToScreen(
  layout: LampLayout,
  aspect: number,
  x: number,
  y: number,
): { u: number; v: number } {
  return {
    u: layout.cx + (x * layout.height) / aspect,
    v: layout.floor + y * layout.height,
  };
}

export function insideGlass(x: number, y: number, slack = 0): boolean {
  if (y < GLASS_BOTTOM + 0.01 || y > GLASS_TOP - 0.005) return false;
  return Math.abs(x) < innerRadius(y) + slack;
}

/** Client pixel → bottom-left screen UV of the canvas. */
export function clientToScreenUv(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { u: number; v: number; aspect: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return {
    u: (clientX - rect.left) / rect.width,
    v: 1 - (clientY - rect.top) / rect.height,
    aspect: rect.width / rect.height,
  };
}
