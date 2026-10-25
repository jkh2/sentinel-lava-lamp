/** Shared by the beauty pass and pointer stirring so both agree. */

export interface LampFrame {
  height: number;
  aspect: number;
  cx: number;
  cy: number;
}

export function lampFrame(screenWidth: number, screenHeight: number): LampFrame {
  const narrow = screenWidth < 840;
  return {
    height: narrow ? 0.9 : 0.84,
    aspect: 3.2,
    cx: 0.5,
    cy: narrow ? 0.47 : 0.5,
  };
}

export function lampWidth(frame: LampFrame, screenAspect: number) {
  return frame.height / frame.aspect / Math.max(screenAspect, 0.01);
}

/** Bottom-left UV, matching the WebGL beauty pass. Null when outside the glass. */
export function clientToLampUv(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = 1 - (clientY - rect.top) / rect.height;
  const frame = lampFrame(rect.width, rect.height);
  const screenAspect = rect.width / rect.height;
  const lampW = lampWidth(frame, screenAspect);
  const px = (x - frame.cx) / lampW;
  const py = (y - frame.cy) / frame.height;
  const aspect = frame.aspect;
  const sx = px;
  const sy = py * aspect;
  const radius = 0.47;
  const halfLen = aspect * 0.5 - radius;
  const span = halfLen * 2 || 1;
  const t = Math.min(1, Math.max(0, (sy + halfLen) / span));
  const cy = -halfLen + t * span;
  const dist = Math.hypot(sx, sy - cy) - radius;
  if (dist > 0.02) return null;
  return {
    x: Math.min(0.98, Math.max(0.02, px + 0.5)),
    y: Math.min(0.98, Math.max(0.02, py + 0.5)),
  };
}
