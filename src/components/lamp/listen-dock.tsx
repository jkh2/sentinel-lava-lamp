import { memo, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { ListeningRig, parseYouTubeId } from "@/lib/audio/rig";
import { Ear, Mic, MonitorUp, Pause, Play, Upload } from "lucide-react";

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const YtSlot = memo(function YtSlot({
  hostRef,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
}) {
  return <div className="yt-frame" ref={hostRef} />;
});

export function ListenDock({
  rigRef,
  volume,
  onVolume,
  open,
}: {
  rigRef: RefObject<ListeningRig | null>;
  volume: number;
  onVolume: (volume: number) => void;
  open: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const ytHost = useRef<HTMLDivElement>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState("");
  const [snap, setSnap] = useState({
    mode: "idle" as ListeningRig["mode"],
    playing: false,
    title: "Nothing playing",
    error: "",
    youtube: false,
    ear: "player" as ListeningRig["ear"],
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let frame = 0;
    let lastKey = "";
    const tick = () => {
      const rig = rigRef.current;
      if (rig) {
        const key = `${rig.mode}|${rig.playing}|${rig.title()}|${rig.error}|${rig.ear}`;
        if (key !== lastKey) {
          lastKey = key;
          setSnap({
            mode: rig.mode,
            playing: rig.playing,
            title: rig.title(),
            error: rig.error,
            youtube: rig.mode === "youtube",
            ear: rig.ear,
          });
        }
        const bars = barsRef.current;
        if (bars) {
          const levels = rig.bars();
          const nodes = bars.children;
          for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i] as HTMLElement;
            el.style.transform = `scaleY(${0.08 + (levels[i] ?? 0) * 0.92})`;
          }
        }
        if (timeRef.current) {
          timeRef.current.textContent = `${formatTime(rig.currentTime())} / ${formatTime(rig.duration())}`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [rigRef]);

  async function takeFile(file: File | undefined) {
    if (!file || !rigRef.current) return;
    setBusy(true);
    try {
      await rigRef.current.playFile(file);
    } catch (err) {
      rigRef.current.error = err instanceof Error ? err.message : "Could not play that file.";
      rigRef.current.onChange();
    } finally {
      setBusy(false);
    }
  }

  async function hear(kind: "tab" | "room") {
    const rig = rigRef.current;
    if (!rig) return;
    if (rig.ear === kind) {
      rig.stopListening();
      return;
    }
    setBusy(true);
    try {
      await rig.listen(kind);
    } catch (err) {
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      rig.error = denied
        ? "Sharing was cancelled or blocked."
        : err instanceof Error
          ? err.message
          : "The lamp could not listen.";
      rig.onChange();
    } finally {
      setBusy(false);
    }
  }

  async function takeYouTube(event: FormEvent) {
    event.preventDefault();
    const rig = rigRef.current;
    const host = ytHost.current;
    if (!rig || !host) return;
    const id = parseYouTubeId(url);
    if (!id) {
      rig.error = "Paste a YouTube link or an 11-character video id.";
      rig.onChange();
      setSnap((s) => ({ ...s, error: rig.error }));
      return;
    }
    setBusy(true);
    try {
      await rig.loadYouTube(host, id);
    } catch (err) {
      rig.error = err instanceof Error ? err.message : "YouTube did not start.";
      rig.onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="panel listen-panel"
      data-open={open}
      aria-label="Music"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void takeFile(event.dataTransfer.files[0]);
      }}
    >
      <div className="panel-head">
        <h2>Listen</h2>
      </div>
      <p className="note">
        Drop an mp3, wav, or m4a and the whole lamp plays along. Browsers cannot read a
        YouTube video's sound directly, so play it here, press <b>Hear this tab</b>, pick
        this tab and turn on <b>Share tab audio</b>. <b>Hear the room</b> listens through
        your microphone to anything playing nearby.
      </p>
      <input
        ref={fileRef}
        className="hidden-input"
        type="file"
        accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac"
        onChange={(event) => {
          void takeFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <div className="row">
        <button type="button" className="btn btn-primary grow" onClick={() => fileRef.current?.click()}>
          <Upload size={16} aria-hidden />
          Upload audio
        </button>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn grow"
          data-on={snap.ear === "tab"}
          disabled={busy}
          onClick={() => void hear("tab")}
        >
          {snap.ear === "tab" ? <Ear size={16} aria-hidden /> : <MonitorUp size={16} aria-hidden />}
          {snap.ear === "tab" ? "Stop hearing tab" : "Hear this tab"}
        </button>
        <button
          type="button"
          className="btn grow"
          data-on={snap.ear === "room"}
          disabled={busy}
          onClick={() => void hear("room")}
        >
          {snap.ear === "room" ? <Ear size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
          {snap.ear === "room" ? "Stop hearing room" : "Hear the room"}
        </button>
      </div>
      <form className="field" onSubmit={(event) => void takeYouTube(event)}>
        <input
          type="url"
          inputMode="url"
          placeholder="YouTube link"
          aria-label="YouTube link"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button type="submit" className="btn" disabled={busy}>
          Play
        </button>
      </form>
      <p className="track-title">{snap.title}</p>
      <div className="transport">
        <button
          type="button"
          className="btn icon-btn"
          aria-label={snap.playing ? "Pause" : "Play"}
          disabled={snap.mode === "idle" || busy}
          onClick={() => void rigRef.current?.toggle()}
        >
          {snap.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <label className="scrub">
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            defaultValue={0}
            aria-label="Seek"
            disabled={snap.mode === "idle"}
            onChange={(event) => rigRef.current?.seekRatio(Number(event.target.value))}
          />
        </label>
        <span className="time" ref={timeRef}>
          0:00 / 0:00
        </span>
      </div>
      <div className="bars" ref={barsRef} aria-hidden>
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
      <label className="slider volume">
        <span className="slider-label">
          <b>Volume</b>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          aria-label="Volume"
          onChange={(event) => onVolume(Number(event.target.value))}
        />
      </label>
      {snap.error ? <p className="error">{snap.error}</p> : null}
      <div className="yt-wrap" data-on={snap.youtube}>
        <YtSlot hostRef={ytHost} />
      </div>
    </section>
  );
}
