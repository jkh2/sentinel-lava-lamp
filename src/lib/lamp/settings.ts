import type { PaletteId } from "@/lib/lamp/palettes";

export interface LampSettings {
  heat: number;
  rise: number;
  thickness: number;
  swirl: number;
  wax: number;
  chill: number;
  glow: number;
  drive: number;
  palette: PaletteId;
  volume: number;
  paused: boolean;
  drip: boolean;
}

export const DEFAULT_SETTINGS: LampSettings = {
  heat: 0.25,
  rise: 0.18,
  thickness: 0.39,
  swirl: 0.26,
  wax: 0.99,
  chill: 0.3,
  glow: 0.25,
  drive: 0.86,
  palette: "amber",
  volume: 0.84,
  paused: false,
  drip: false,
};

const KEY = "sentinel-lava-v2";

export function readStoredSettings(): Partial<LampSettings> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<LampSettings>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStoredSettings(settings: LampSettings) {
  const { paused: _paused, drip: _drip, ...rest } = settings;
  localStorage.setItem(KEY, JSON.stringify(rest));
}
