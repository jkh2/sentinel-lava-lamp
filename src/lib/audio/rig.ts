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
  volume = 0.85;
  onChange: () => void = () => {};
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freq = new Uint8Array(0);
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
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.source = this.ctx.createMediaElementSource(this.audio);
      this.source.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
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
    if (this.mode === "youtube") return this.videoTitle || "YouTube";
    if (this.mode === "file") return this.fileName || "Uploaded track";
    return "Nothing playing";
  }

  sample() {
    const idle = this.mode === "youtube" ? 0.2 : 0.1;
    if (this.mode !== "file" || !this.analyser || this.audio.paused) {
      this.bass += (idle + Math.sin(performance.now() / 900) * 0.06 - this.bass) * 0.08;
      this.mid += (idle * 0.4 - this.mid) * 0.08;
      this.treble += (0 - this.treble) * 0.08;
      this.level = this.bass;
      return;
    }
    this.analyser.getByteFrequencyData(this.freq);
    const n = this.freq.length;
    const avg = (a: number, b: number) => {
      let sum = 0;
      const i0 = Math.max(0, a);
      const i1 = Math.min(n - 1, b);
      for (let i = i0; i <= i1; i++) sum += this.freq[i] ?? 0;
      return sum / Math.max(1, i1 - i0 + 1) / 255;
    };
    const bass = Math.min(1, avg(2, 10) * 1.45);
    const mid = Math.min(1, avg(12, 48));
    const treble = Math.min(1, avg(70, 180));
    this.bass += (bass - this.bass) * 0.38;
    this.mid += (mid - this.mid) * 0.28;
    this.treble += (treble - this.treble) * 0.22;
    this.level = Math.min(1, this.bass * 0.72 + this.mid * 0.28);
  }

  bars(): number[] {
    if (!this.analyser || this.mode !== "file" || this.audio.paused) {
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
    this.audio.pause();
    this.stopYouTube();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    void this.ctx?.close();
  }
}
