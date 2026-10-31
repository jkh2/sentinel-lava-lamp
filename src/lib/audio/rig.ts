export function parseYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      const v = url.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const parts = url.pathname.split("/").filter(Boolean);
      const key = parts[0];
      const id = parts[1] ?? "";
      if (
        (key === "embed" || key === "shorts" || key === "live") &&
        /^[\w-]{11}$/.test(id)
      ) {
        return id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

interface YTPlayer {
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setVolume: (volume: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  getVideoData: () => { title?: string };
  destroy: () => void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    options: {
      videoId: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: (event: { target: YTPlayer }) => void;
        onStateChange?: (event: { data: number; target: YTPlayer }) => void;
        onError?: () => void;
      };
    },
  ) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number; CUED: number };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApi: Promise<void> | null = null;

function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.appendChild(script);
  });
  return ytApi;
}

export class ListeningRig {
  readonly audio: HTMLAudioElement;
  fileName = "";
  videoTitle = "";
  mode: "idle" | "file" | "youtube" = "idle";
  error = "";
  bass = 0;
  mid = 0;
  treble = 0;
  level = 0;
  /** Dominant note as a MIDI number (from a chromagram), or -1 when none is clear. */
  noteMidi = -1;
  /** How clearly one pitch class dominates, 0–1. */
  noteStrength = 0;
  /** Increments on every detected note onset (spectral flux peak). */
  onsets = 0;
  /** Strength of the most recent onset, 0–1. */
  onsetStrength = 0;
  volume = 0.85;
  /**
   * What the lamp listens to. "player" analyses its own uploaded file.
   * "tab" hears a shared browser tab (including this one, so a YouTube video
   * playing in the lamp can drive the show). "room" hears the microphone.
   */
  ear: "player" | "tab" | "room" = "player";
  /** 0–1: how readily a jump in the spectrum counts as a beat. */
  sensitivity = 0.5;
  onChange: () => void = () => {};
  private stream: MediaStream | null = null;
  private streamSource: MediaStreamAudioSourceNode | null = null;
  /**
   * Slow peak and valley followers per band. Each band is shown between its
   * own recent quiet and loud points, so a quiet song, a loud mastered one, or
   * a microphone across the room all swing the show through its full range.
   */
  private bands = {
    bass: { peak: 0.3, valley: 0 },
    mid: { peak: 0.3, valley: 0 },
    treble: { peak: 0.25, valley: 0 },
  };
  private lastSample = 0;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freq = new Uint8Array(0);
  /** A finer, parallel analyser for pitch: 8192-point FFT ≈ 5 Hz bins. */
  private pitchAnalyser: AnalyserNode | null = null;
  private spec = new Float32Array(0);
  private prevMag = new Float32Array(0);
  private binPc = new Int8Array(0);
  private binMidi = new Float32Array(0);
  private binLo = 0;
  private binHi = 0;
  private chroma = new Float32Array(12);
  private fluxMean = 0;
  private fluxVar = 0;
  private lastOnset = 0;
  private source: MediaElementAudioSourceNode | null = null;
  private yt: YTPlayer | null = null;
  private objectUrl = "";

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.volume = this.volume;
    const ping = () => this.onChange();
    this.audio.addEventListener("play", ping);
    this.audio.addEventListener("pause", ping);
    this.audio.addEventListener("ended", ping);
    this.audio.addEventListener("timeupdate", ping);
    this.audio.addEventListener("loadedmetadata", ping);
  }

  private async ensureGraph() {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error("This browser has no Web Audio.");
      this.ctx = new Ctor();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.78;
      // headroom: the default -30 dB ceiling pins loud, mastered bass at full
      // scale, which leaves the show nothing to move with
      this.analyser.minDecibels = -95;
      this.analyser.maxDecibels = -12;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.source = this.ctx.createMediaElementSource(this.audio);
      // the player goes straight to the speakers; the analysers only listen,
      // so a microphone or shared tab can feed them without echoing
      this.source.connect(this.ctx.destination);
      this.source.connect(this.analyser);
      // pitch analyser: listens only, not connected to the output
      const pa = this.ctx.createAnalyser();
      pa.fftSize = 8192;
      pa.smoothingTimeConstant = 0.45;
      this.source.connect(pa);
      this.pitchAnalyser = pa;
      const bins = pa.frequencyBinCount;
      const hz = this.ctx.sampleRate / pa.fftSize;
      this.spec = new Float32Array(bins);
      this.prevMag = new Float32Array(bins);
      this.binPc = new Int8Array(bins);
      this.binMidi = new Float32Array(bins);
      this.binLo = Math.max(1, Math.floor(65 / hz));
      this.binHi = Math.min(bins - 1, Math.ceil(4200 / hz));
      for (let i = 0; i < bins; i++) {
        const f = i * hz;
        const midi = f > 0 ? 69 + 12 * Math.log2(f / 440) : 0;
        this.binMidi[i] = midi;
        this.binPc[i] = ((Math.round(midi) % 12) + 12) % 12;
      }
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  async playFile(file: File) {
    this.error = "";
    this.stopYouTube();
    await this.ensureGraph();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.audio.src = this.objectUrl;
    this.fileName = file.name.replace(/\.[^.]+$/, "");
    this.videoTitle = "";
    this.mode = "file";
    await this.audio.play();
    this.onChange();
  }

  async loadYouTube(host: HTMLElement, videoId: string) {
    this.error = "";
    this.audio.pause();
    this.stopYouTube();
    await loadYouTubeApi();
    const YT = window.YT;
    if (!YT) throw new Error("YouTube player failed to load.");
    host.replaceChildren();
    const mount = document.createElement("div");
    host.appendChild(mount);
    this.mode = "youtube";
    this.fileName = "";
    await new Promise<void>((resolve) => {
      this.yt = new YT.Player(mount, {
        videoId,
        width: "320",
        height: "180",
        playerVars: {
          autoplay: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            event.target.setVolume(Math.round(this.volume * 100));
            event.target.playVideo();
            this.videoTitle = event.target.getVideoData().title || "YouTube";
            this.onChange();
            resolve();
          },
          onStateChange: (event) => {
            const title = event.target.getVideoData().title;
            if (title) this.videoTitle = title;
            this.onChange();
          },
          onError: () => {
            this.error = "YouTube could not play that video.";
            this.onChange();
            resolve();
          },
        },
      });
    });
  }

  private stopYouTube() {
    if (!this.yt) return;
    try {
      this.yt.stopVideo();
      this.yt.destroy();
    } catch {
      /* player may already be gone */
    }
    this.yt = null;
    if (this.mode === "youtube") this.mode = "idle";
  }

  /** True when there is real sound to analyse (not the idle breathing). */
  get live() {
    if (this.ear !== "player") return this.streamSource !== null;
    return this.mode === "file" && !this.audio.paused && !this.audio.ended;
  }

  /**
   * Listen to a shared tab or the room instead of the lamp's own player.
   * Browsers cannot read a YouTube iframe's audio directly, but they can share
   * a tab's sound with the user's permission, and that tab can be this one.
   */
  async listen(kind: "tab" | "room") {
    this.error = "";
    await this.ensureGraph();
    this.stopListening(false);
    const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const devices = navigator.mediaDevices;
    let stream: MediaStream;
    if (kind === "tab") {
      if (!devices?.getDisplayMedia) throw new Error("This browser cannot share a tab's sound.");
      stream = await devices.getDisplayMedia({ video: true, audio: raw });
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('No sound came with that share. Pick a tab and turn on "Share tab audio".');
      }
    } else {
      if (!devices?.getUserMedia) throw new Error("This browser cannot use a microphone.");
      stream = await devices.getUserMedia({ audio: raw });
    }
    const ctx = this.ctx;
    if (!ctx || !this.analyser || !this.pitchAnalyser) throw new Error("Audio did not start.");
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    src.connect(this.analyser);
    src.connect(this.pitchAnalyser);
    // while listening outward, the player stops feeding the analysers so a
    // shared tab that already contains it is not counted twice
    try {
      this.source?.disconnect(this.analyser);
      this.source?.disconnect(this.pitchAnalyser);
    } catch {
      /* already disconnected */
    }
    this.stream = stream;
    this.streamSource = src;
    this.ear = kind;
    this.bands = {
      bass: { peak: 0.15, valley: 0 },
      mid: { peak: 0.15, valley: 0 },
      treble: { peak: 0.12, valley: 0 },
    };
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (this.stream === stream) this.stopListening();
      });
    }
    this.onChange();
  }

  stopListening(notify = true) {
    if (this.streamSource) {
      try {
        this.streamSource.disconnect();
      } catch {
        /* already gone */
      }
      if (this.source && this.analyser && this.pitchAnalyser) {
        this.source.connect(this.analyser);
        this.source.connect(this.pitchAnalyser);
      }
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.streamSource = null;
    this.ear = "player";
    if (notify) this.onChange();
  }

  setVolume(volume: number) {
    this.volume = volume;
    this.audio.volume = volume;
    this.yt?.setVolume(Math.round(volume * 100));
  }

  get playing() {
    if (this.mode === "file") return !this.audio.paused && !this.audio.ended;
    if (this.mode === "youtube" && this.yt && window.YT) {
      return this.yt.getPlayerState() === window.YT.PlayerState.PLAYING;
    }
    return false;
  }

  async toggle() {
    if (this.mode === "file") {
      if (this.audio.paused) {
        await this.ensureGraph();
        await this.audio.play();
      } else {
        this.audio.pause();
      }
      this.onChange();
      return;
    }
    if (this.mode === "youtube" && this.yt && window.YT) {
      if (this.yt.getPlayerState() === window.YT.PlayerState.PLAYING) this.yt.pauseVideo();
      else this.yt.playVideo();
      this.onChange();
    }
  }

  progress() {
    if (this.mode === "file") {
      const d = this.audio.duration;
      if (!d || !Number.isFinite(d)) return 0;
      return this.audio.currentTime / d;
    }
    if (this.mode === "youtube" && this.yt) {
      const d = this.yt.getDuration();
      if (!d) return 0;
      return this.yt.getCurrentTime() / d;
    }
    return 0;
  }

  duration() {
    if (this.mode === "file") return this.audio.duration || 0;
    if (this.mode === "youtube" && this.yt) return this.yt.getDuration() || 0;
    return 0;
  }

  currentTime() {
    if (this.mode === "file") return this.audio.currentTime || 0;
    if (this.mode === "youtube" && this.yt) return this.yt.getCurrentTime() || 0;
    return 0;
  }

  seekRatio(ratio: number) {
    const clamped = Math.min(1, Math.max(0, ratio));
    if (this.mode === "file" && Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = clamped * this.audio.duration;
    } else if (this.mode === "youtube" && this.yt) {
      this.yt.seekTo(clamped * (this.yt.getDuration() || 0), true);
    }
    this.onChange();
  }

  title() {
    if (this.ear === "tab") return "Listening to a shared tab";
    if (this.ear === "room") return "Listening to the room";
    if (this.mode === "youtube") return this.videoTitle || "YouTube";
    if (this.mode === "file") return this.fileName || "Uploaded track";
    return "Nothing playing";
  }

  sample() {
    const idle = this.mode === "youtube" ? 0.2 : 0.1;
    if (!this.analyser || !this.live) {
      this.bass += (idle + Math.sin(performance.now() / 900) * 0.06 - this.bass) * 0.08;
      this.mid += (idle * 0.4 - this.mid) * 0.08;
      this.treble += (0 - this.treble) * 0.08;
      this.level = this.bass;
      this.noteStrength += (0 - this.noteStrength) * 0.1;
      if (this.noteStrength < 0.05) this.noteMidi = -1;
      return;
    }
    this.samplePitch();
    this.analyser.getByteFrequencyData(this.freq);
    const n = this.freq.length;
    const avg = (a: number, b: number) => {
      let sum = 0;
      const i0 = Math.max(0, a);
      const i1 = Math.min(n - 1, b);
      for (let i = i0; i <= i1; i++) sum += this.freq[i] ?? 0;
      return sum / Math.max(1, i1 - i0 + 1) / 255;
    };
    // auto-level by time, not frames (screens run 60 to 144+ fps): peaks and
    // valleys relax toward the signal over a few seconds, and each band is
    // shown between them
    const nowMs = performance.now();
    const dt = this.lastSample ? Math.min(0.25, (nowMs - this.lastSample) / 1000) : 1 / 60;
    this.lastSample = nowMs;
    const relax = 1 - Math.exp(-dt / 3);
    const level = (raw: number, key: "bass" | "mid" | "treble", floor: number) => {
      const b = this.bands[key];
      b.peak = raw > b.peak ? raw : b.peak + (raw - b.peak) * relax;
      b.valley = raw < b.valley ? raw : b.valley + (raw - b.valley) * relax;
      const base = b.valley * 0.8;
      return Math.min(1, Math.max(0, (raw - base) / Math.max(floor, b.peak - base)));
    };
    const bass = level(avg(2, 10), "bass", 0.12);
    const mid = level(Math.min(1, avg(12, 48)), "mid", 0.1);
    const treble = level(Math.min(1, avg(70, 180)), "treble", 0.08);
    this.bass += (bass - this.bass) * 0.38;
    this.mid += (mid - this.mid) * 0.28;
    this.treble += (treble - this.treble) * 0.22;
    this.level = Math.min(1, this.bass * 0.72 + this.mid * 0.28);
  }

  /**
   * Chromagram + spectral-flux onsets. Polyphonic music has no single pitch,
   * so instead of chasing one frequency we fold the spectrum into the 12
   * pitch classes and take the one that dominates, plus an onset whenever the
   * spectrum suddenly gains energy (a note or chord is struck).
   */
  private samplePitch() {
    const pa = this.pitchAnalyser;
    if (!pa) return;
    pa.getFloatFrequencyData(this.spec);
    const chroma = this.chroma;
    chroma.fill(0);
    let flux = 0;
    let total = 0;
    for (let i = this.binLo; i <= this.binHi; i++) {
      const db = this.spec[i] ?? -200;
      const mag = db > -110 ? Math.pow(10, db / 20) : 0;
      const prev = this.prevMag[i] ?? 0;
      if (mag > prev) flux += mag - prev;
      this.prevMag[i] = mag;
      const e = mag * mag;
      total += e;
      const pc = this.binPc[i] ?? 0;
      chroma[pc] = (chroma[pc] ?? 0) + e;
    }
    let best = 0;
    for (let k = 1; k < 12; k++) if ((chroma[k] ?? 0) > (chroma[best] ?? 0)) best = k;
    const share = total > 1e-9 ? (chroma[best] ?? 0) / total : 0;
    // 1/12 ≈ 0.083 is noise; a clean note or simple chord sits well above
    const strength = total > 1e-7 ? Math.min(1, Math.max(0, (share - 0.14) / 0.32)) : 0;
    this.noteStrength += (strength - this.noteStrength) * 0.35;
    if (strength > 0.08) {
      // octave: energy-weighted pitch of the bins in the winning class
      let wsum = 0;
      let msum = 0;
      for (let i = this.binLo; i <= this.binHi; i++) {
        if (this.binPc[i] !== best) continue;
        const m = this.prevMag[i] ?? 0;
        const w = m * m;
        wsum += w;
        msum += w * (this.binMidi[i] ?? 0);
      }
      const centre = wsum > 0 ? msum / wsum : 60;
      const octave = Math.round((centre - best) / 12);
      this.noteMidi = best + octave * 12;
    } else if (this.noteStrength < 0.05) {
      this.noteMidi = -1;
    }
    // adaptive onset threshold on the flux
    const now = performance.now() / 1000;
    const std = Math.sqrt(Math.max(0, this.fluxVar));
    const k = 3.1 - this.sensitivity * 2.0; // 0.5 ≈ the original 2.2σ
    const hit = flux > this.fluxMean + std * k + 0.002 && now - this.lastOnset > 0.11;
    if (hit) {
      this.onsets += 1;
      this.lastOnset = now;
      this.onsetStrength = Math.min(1, (flux - this.fluxMean) / (std * 6 + 0.01));
    }
    const d = flux - this.fluxMean;
    this.fluxMean += d * 0.05;
    this.fluxVar += (d * d - this.fluxVar) * 0.05;
  }

  bars(): number[] {
    if (!this.analyser || !this.live) {
      return Array.from({ length: 12 }, () => 0.08);
    }
    const out: number[] = [];
    const n = this.freq.length;
    for (let i = 0; i < 12; i++) {
      const a = Math.floor((i / 12) * 48) + 1;
      const b = Math.floor(((i + 1) / 12) * 48) + 1;
      let sum = 0;
      for (let k = a; k < b && k < n; k++) sum += this.freq[k] ?? 0;
      out.push(Math.min(1, sum / Math.max(1, b - a) / 220));
    }
    return out;
  }

  destroy() {
    this.stopListening(false);
    this.audio.pause();
    this.stopYouTube();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    void this.ctx?.close();
  }
}
