export type PaletteId = "amber" | "magma" | "absinthe" | "tide" | "violet" | "rose";

export interface Palette {
  id: PaletteId;
  label: string;
  cool: [number, number, number];
  mid: [number, number, number];
  hot: [number, number, number];
  liquid: [number, number, number];
}

export const PALETTES: Palette[] = [
  {
    id: "amber",
    label: "Amber",
    cool: [0.62, 0.1, 0.04],
    mid: [1.05, 0.42, 0.08],
    hot: [1.15, 0.82, 0.38],
    liquid: [0.18, 0.07, 0.03],
  },
  {
    id: "magma",
    label: "Magma",
    cool: [0.42, 0.02, 0.05],
    mid: [0.95, 0.12, 0.04],
    hot: [1.2, 0.72, 0.16],
    liquid: [0.12, 0.02, 0.03],
  },
  {
    id: "absinthe",
    label: "Absinthe",
    cool: [0.02, 0.22, 0.1],
    mid: [0.18, 0.85, 0.38],
    hot: [0.85, 1.05, 0.55],
    liquid: [0.02, 0.08, 0.05],
  },
  {
    id: "tide",
    label: "Tide",
    cool: [0.02, 0.12, 0.28],
    mid: [0.05, 0.55, 0.72],
    hot: [0.75, 0.95, 1.0],
    liquid: [0.02, 0.05, 0.1],
  },
  {
    id: "violet",
    label: "Violet",
    cool: [0.18, 0.04, 0.28],
    mid: [0.62, 0.18, 0.85],
    hot: [1.0, 0.72, 0.95],
    liquid: [0.06, 0.03, 0.1],
  },
  {
    id: "rose",
    label: "Rose",
    cool: [0.38, 0.05, 0.16],
    mid: [1.0, 0.28, 0.48],
    hot: [1.05, 0.78, 0.72],
    liquid: [0.12, 0.03, 0.06],
  },
];

export function paletteById(id: PaletteId): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
