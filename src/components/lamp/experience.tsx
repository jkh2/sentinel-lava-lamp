import { useEffect, useRef, useState } from "react";
import { ListeningRig } from "@/lib/audio/rig";
import { LampEngine } from "@/lib/fluid/engine";
import { paletteById } from "@/lib/lamp/palettes";
import { clientToLampUv } from "@/lib/lamp/geometry";
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
  const smokeRef = useRef<HTMLVideoElement>(null);
  const smokeCanvasRef = useRef<HTMLCanvasElement>(null);
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

    const PLATES = 6;
    const FW = 1280;
    const FH = 720;
    const plates = Array.from({ length: PLATES }, () => {
      const c = document.createElement("canvas");
      c.width = FW;
      c.height = FH;
      return c;
    });
    const grabAt = [0.35, 1.1, 2.0, 3.1, 4.4, 5.8];
    let grabbed = 0;
    let smokeTime = 0;

    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
      last = now;
      smokeTime += dt;
      const current = settingsRef.current;
      rig.sample();
      engine.params = { ...current, palette: paletteById(current.palette) };
      engine.bass = rig.bass;
      const smoke = smokeRef.current;
      const smokeCanvas = smokeCanvasRef.current;
      if (smoke && smoke.playbackRate !== 1) smoke.playbackRate = 1;
      if (smoke && grabbed < PLATES && smoke.readyState >= 2 && smoke.currentTime >= (grabAt[grabbed] ?? 99)) {
        const slot = plates[grabbed]?.getContext("2d");
        if (slot) slot.drawImage(smoke, 0, 0, FW, FH);
        grabbed += 1;
        if (grabbed >= PLATES) smoke.pause();
      }
      if (smokeCanvas && grabbed > 0) {
        const w = Math.max(2, smokeCanvas.clientWidth);
        const h = Math.max(2, smokeCanvas.clientHeight);
        if (smokeCanvas.width !== w || smokeCanvas.height !== h) {
          smokeCanvas.width = w;
          smokeCanvas.height = h;
        }
        const ctx = smokeCanvas.getContext("2d");
        if (ctx) {
          ctx.filter = "none";
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#070605";
          ctx.fillRect(0, 0, w, h);
          const bright = 0.7 + rig.bass * current.drive * 0.25;
          ctx.filter = `brightness(${bright.toFixed(3)})`;
          const base = Math.max(w / FW, h / FH) * 1.25;
          for (let i = 0; i < grabbed; i++) {
            const plate = plates[i];
            if (!plate) continue;
            const sway = Math.sin(smokeTime * 0.045 + i * 1.4) * w * 0.05;
            const rise = ((smokeTime * (6 + i * 2.2) + i * 90) % (h * 0.55)) - h * 0.2;
            const dw = FW * base;
            const dh = FH * base;
            ctx.save();
            ctx.translate(w * 0.5 + sway, h * 0.48 + rise);
            ctx.rotate(Math.sin(smokeTime * 0.03 + i * 0.8) * 0.05);
            ctx.globalAlpha = 0.34;
            ctx.drawImage(plate, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();
          }
          ctx.globalAlpha = 1;
          ctx.filter = "none";
        }
      }
      engine.step(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onDown = (event: PointerEvent) => {
      const uv = clientToLampUv(canvas, event.clientX, event.clientY);
      if (!uv) return;
      pointers.current.set(event.pointerId, uv);
      canvas.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      const prev = pointers.current.get(event.pointerId);
      if (!prev) return;
      const uv = clientToLampUv(canvas, event.clientX, event.clientY);
      if (!uv) {
        pointers.current.delete(event.pointerId);
        return;
      }
      engine.stir(uv.x, uv.y, uv.x - prev.x, uv.y - prev.y, dripRef.current);
      pointers.current.set(event.pointerId, uv);
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
      <video
        ref={smokeRef}
        className="smoke-src"
        src="/smoke.mp4"
        autoPlay
        muted
        loop
        playsInline
        aria-hidden
      />
      <canvas ref={smokeCanvasRef} className="smoke-bg" aria-hidden />
      <canvas
        ref={canvasRef}
        className="lamp-canvas"
        aria-label="Virtual lava lamp. Drag inside the glass to stir the wax."
      />
      <header className="brand">
        <p className="eyebrow">Sentinel</p>
        <h1>Lava Lamp</h1>
        <p className="tag">Navier–Stokes wax. Drag the glass to stir.</p>
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
