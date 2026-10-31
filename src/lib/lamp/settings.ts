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
  /** How much the music recolors the light and smoke (0 = lamp color only). */
  hue: number;
  /** How strongly notes draw Chladni figures in the smoke (0 = off). */
  cymatics: number;
  /** While music plays, how much it leads the smoke over the lamp's own drift. */
  lead: number;
  /** How hard each beat pushes smoke and flashes the light. */
  beats: number;
  /** How much the wax and glow flare on beats. */
  pulse: number;
  /** How readily a sound counts as a beat (higher hears more beats). */
  sensitivity: number;
  /** How quickly the old note's figure gives way when the note changes. */
  snap: number;
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
  hue: 0.6,
  cymatics: 0.65,
  lead: 0.7,
  beats: 0.65,
  pulse: 0.55,
  sensitivity: 0.5,
  snap: 0.65,
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
