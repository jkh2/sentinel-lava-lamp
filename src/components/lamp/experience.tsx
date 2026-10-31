import { useEffect, useRef, useState } from "react";
import { ListeningRig } from "@/lib/audio/rig";
import { LampEngine } from "@/lib/fluid/engine";
import { paletteById } from "@/lib/lamp/palettes";
import { clientToScreenUv } from "@/lib/lamp/geometry";
import {
  DEFAULT_SETTINGS,
  readStoredSettings,
  writeStoredSettings,
  type LampSettings,
} from "@/lib/lamp/settings";
import { ListenDock } from "@/components/lamp/listen-dock";
import { TunePanel } from "@/components/lamp/tune-panel";

export function LampExperience() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<LampEngine | null>(null);
  const rigRef = useRef<ListeningRig | null>(null);
  const settingsRef = useRef<LampSettings>(DEFAULT_SETTINGS);
  const dripRef = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [settings, setSettings] = useState<LampSettings>(DEFAULT_SETTINGS);
  const [glError, setGlError] = useState("");
  const [sheet, setSheet] = useState<"listen" | "tune" | null>(null);
  const [chrome, setChrome] = useState(true);
  settingsRef.current = settings;
  dripRef.current = settings.drip;

  useEffect(() => {
    const stored = readStoredSettings();
    setSettings((current) => {
      const next = { ...current, ...stored, paused: false };
      settingsRef.current = next;
      return next;
    });
    if (localStorage.getItem("sentinel-lamp-chrome") === "0") setChrome(false);
  }, []);

  useEffect(() => {
    writeStoredSettings(settings);
    rigRef.current?.setVolume(settings.volume);
  }, [settings]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rig = new ListeningRig();
    rig.volume = settingsRef.current.volume;
    rig.audio.volume = settingsRef.current.volume;
    rigRef.current = rig;

    let engine: LampEngine;
    try {
      const initial = settingsRef.current;
      engine = new LampEngine(canvas, {
        ...initial,
        palette: paletteById(initial.palette),
      });
    } catch (err) {
      setGlError(err instanceof Error ? err.message : "The lamp could not start.");
      return () => rig.destroy();
    }
    engineRef.current = engine;
    if (import.meta.env.DEV) {
      // QA hook: fast-forward the physics without rendering every step.
      const w = window as unknown as {
        __lampAdvance?: (s: number) => void;
        __lampTrackTime?: () => number;
        __lampSeek?: (t: number) => void;
        __lampNote?: () => { midi: number; strength: number; onsets: number; bass: number; mid: number };
      };
      w.__lampAdvance = (s) => engine.advance(s);
      (w as unknown as { __lampPlate?: () => unknown }).__lampPlate = () => engine.plateState();
      w.__lampTrackTime = () => (rig.audio.paused ? -1 : rig.audio.currentTime);
      w.__lampNote = () => ({ midi: rig.noteMidi, strength: rig.noteStrength, onsets: rig.onsets, bass: rig.bass, mid: rig.mid });
      w.__lampSeek = (t) => {
        rig.audio.currentTime = t;
      };
    }

    let paletteId = settingsRef.current.palette;
    let palette = paletteById(paletteId);
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.25) : 1 / 60;
      last = now;
      const current = settingsRef.current;
      if (current.palette !== paletteId) {
        paletteId = current.palette;
        palette = paletteById(paletteId);
      }
      rig.sample();
      const p = engine.params;
      p.heat = current.heat;
      p.rise = current.rise;
      p.thickness = current.thickness;
      p.swirl = current.swirl;
      p.wax = current.wax;
      p.chill = current.chill;
      p.glow = current.glow;
      p.drive = current.drive;
      p.hue = current.hue;
      p.cymatics = current.cymatics;
      p.lead = current.lead;
      p.beats = current.beats;
      p.pulse = current.pulse;
      p.snap = current.snap;
      p.paused = current.paused;
      p.palette = palette;
      rig.sensitivity = current.sensitivity;
      engine.bass = rig.bass;
      // Live when an uploaded file plays, or when the lamp is hearing a shared
      // tab or the room. A YouTube iframe alone cannot be read by the page.
      const m = engine.music;
      m.live = rig.live;
      m.bass = rig.bass;
      m.mid = rig.mid;
      m.treble = rig.treble;
      m.noteMidi = rig.noteMidi;
      m.noteStrength = rig.noteStrength;
      m.onsets = rig.onsets;
      m.onsetStrength = rig.onsetStrength;
      engine.step(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onDown = (event: PointerEvent) => {
      const uv = clientToScreenUv(canvas, event.clientX, event.clientY);
      if (!uv) return;
      pointers.current.set(event.pointerId, { x: uv.u, y: uv.v });
      canvas.setPointerCapture(event.pointerId);
      if (dripRef.current) engine.drag(uv.u, uv.v, 0, 0, true);
    };
    const onMove = (event: PointerEvent) => {
      const prev = pointers.current.get(event.pointerId);
      if (!prev) return;
      const uv = clientToScreenUv(canvas, event.clientX, event.clientY);
      if (!uv) return;
      engine.drag(uv.u, uv.v, uv.u - prev.x, uv.v - prev.y, false);
      pointers.current.set(event.pointerId, { x: uv.u, y: uv.v });
    };
    const onUp = (event: PointerEvent) => {
      pointers.current.delete(event.pointerId);
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      engine.destroy();
      engineRef.current = null;
      rig.destroy();
      rigRef.current = null;
    };
  }, [7]);

  const toggleChrome = () => {
    setChrome((value) => {
      const next = !value;
      localStorage.setItem("sentinel-lamp-chrome", next ? "1" : "0");
      return next;
    });
  };

  return (
    <main className="lamp-app" data-chrome={chrome ? "true" : "false"}>
      <canvas
        ref={canvasRef}
        className="lamp-canvas"
        aria-label="Virtual lava lamp. Drag inside the glass to stir the wax, or outside it to push the smoke."
      />
      <header className="brand">
        <p className="eyebrow">Sentinel</p>
        <h1>Lava Lamp</h1>
        <p className="tag">Heat-driven wax, Navier–Stokes smoke. Drag the glass to stir, or the air to push the smoke.</p>
      </header>
      {glError ? (
        <div className="gl-error">
          <p>{glError}</p>
        </div>
      ) : null}
      <ListenDock
        rigRef={rigRef}
        volume={settings.volume}
        onVolume={(volume) => setSettings((s) => ({ ...s, volume }))}
        open={sheet === "listen"}
      />
      <TunePanel
        settings={settings}
        onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        onReheat={() => engineRef.current?.seed()}
        open={sheet === "tune"}
      />
      <button type="button" className="chrome-toggle btn" onClick={toggleChrome}>
        {chrome ? "Hide menus" : "Menus"}
      </button>
      <div className="sheet-bar">
        <button
          type="button"
          className="btn grow"
          data-on={sheet === "listen"}
          onClick={() => setSheet((current) => (current === "listen" ? null : "listen"))}
        >
          Listen
        </button>
        <button
          type="button"
          className="btn grow"
          data-on={sheet === "tune"}
          onClick={() => setSheet((current) => (current === "tune" ? null : "tune"))}
        >
          Tune
        </button>
      </div>
    </main>
  );
}
