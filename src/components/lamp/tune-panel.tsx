import { PALETTES, type PaletteId } from "@/lib/lamp/palettes";
import type { LampSettings } from "@/lib/lamp/settings";
import { Pause, Play, RotateCcw } from "lucide-react";

function feel(value: number, low: string, mid: string, high: string) {
  if (value < 0.34) return low;
  if (value < 0.67) return mid;
  return high;
}

function Slider({
  label,
  value,
  low,
  mid,
  high,
  onChange,
}: {
  label: string;
  value: number;
  low: string;
  mid: string;
  high: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider">
      <span className="slider-label">
        <b>{label}</b>
        <span className="slider-value">{feel(value, low, mid, high)}</span>
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function TunePanel({
  settings,
  onChange,
  onReheat,
  open,
}: {
  settings: LampSettings;
  onChange: (patch: Partial<LampSettings>) => void;
  onReheat: () => void;
  open: boolean;
}) {
  return (
    <section className="panel tune-panel" aria-label="Wax controls" data-open={open}>
      <div className="panel-head">
        <h2>Tune</h2>
      </div>
      <div className="swatches" role="listbox" aria-label="Wax color">
        {PALETTES.map((palette) => (
          <button
            key={palette.id}
            type="button"
            className="swatch"
            data-palette={palette.id}
            data-on={settings.palette === palette.id}
            role="option"
            aria-selected={settings.palette === palette.id}
            aria-label={palette.label}
            onClick={() => onChange({ palette: palette.id as PaletteId })}
          />
        ))}
      </div>
      <Slider
        label="Coil"
        value={settings.heat}
        low="cool"
        mid="warm"
        high="hot"
        onChange={(heat) => onChange({ heat })}
      />
      <Slider
        label="Rise"
        value={settings.rise}
        low="still"
        mid="steady"
        high="eager"
        onChange={(rise) => onChange({ rise })}
      />
      <Slider
        label="Thickness"
        value={settings.thickness}
        low="thin"
        mid="syrup"
        high="tar"
        onChange={(thickness) => onChange({ thickness })}
      />
      <Slider
        label="Swirl"
        value={settings.swirl}
        low="calm"
        mid="curling"
        high="wild"
        onChange={(swirl) => onChange({ swirl })}
      />
      <Slider
        label="Size"
        value={settings.wax}
        low="beads"
        mid="gobs"
        high="globs"
        onChange={(wax) => onChange({ wax })}
      />
      <Slider
        label="Chill"
        value={settings.chill}
        low="holds heat"
        mid="cycles"
        high="quenches"
        onChange={(chill) => onChange({ chill })}
      />
      <Slider
        label="Glow"
        value={settings.glow}
        low="dim"
        mid="lamp"
        high="blaze"
        onChange={(glow) => onChange({ glow })}
      />
      <Slider
        label="Music drive"
        value={settings.drive}
        low="ignore"
        mid="follow"
        high="kick"
        onChange={(drive) => onChange({ drive })}
      />
      <Slider
        label="Music color"
        value={settings.hue}
        low="lamp only"
        mid="tinted"
        high="light show"
        onChange={(hue) => onChange({ hue })}
      />
      <Slider
        label="Cymatics"
        value={settings.cymatics}
        low="off"
        mid="patterns"
        high="resonant"
        onChange={(cymatics) => onChange({ cymatics })}
      />
      <div className="tune-actions">
        <button type="button" className="btn grow" onClick={onReheat}>
          <RotateCcw size={16} aria-hidden />
          Reheat
        </button>
        <button
          type="button"
          className="btn"
          data-on={settings.drip}
          onClick={() => onChange({ drip: !settings.drip })}
        >
          Drip
        </button>
        <button
          type="button"
          className="btn"
          data-on={settings.paused}
          onClick={() => onChange({ paused: !settings.paused })}
        >
          {settings.paused ? <Play size={16} aria-hidden /> : <Pause size={16} aria-hidden />}
          {settings.paused ? "Resume" : "Pause"}
        </button>
      </div>
    </section>
  );
}
