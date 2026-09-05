import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MicrophoneStateEvent,
  SttProvider,
  WakeWordDetector,
  WakeWordEvent,
} from "./types.ts";

type WakeWordDetectorOptions = {
  stt: SttProvider;
  wakeWord: string;
  chunkDurationMs?: number;
  pollIntervalMs?: number;
  cooldownMs?: number;
  maxPolls?: number;
  recordAudio?: (durationMs: number) => Promise<string>;
  isChunkSilent?: (audioPath: string) => Promise<boolean>;
};

async function defaultIsChunkSilent(audioPath: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["ffmpeg", "-i", audioPath, "-af", "silencedetect=noise=-50dB:d=0.5", "-f", "null", "-"],
    { stdout: "ignore", stderr: "pipe", windowsHide: true },
  );
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return !stderr.includes("silence_end");
}

function defaultRecordAudio(durationMs: number): Promise<string> {
  const outPath = join(tmpdir(), `nimbus-wake-${randomUUID()}.wav`);
  const durationSec = Math.ceil(durationMs / 1000).toString();

  const platform = process.platform;
  let cmd: string[];
  if (platform === "darwin") {
    cmd = [
      "ffmpeg",
      "-y",
      "-f",
      "avfoundation",
      "-i",
      ":0",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-t",
      durationSec,
      outPath,
    ];
  } else if (platform === "win32") {
    cmd = [
      "ffmpeg",
      "-y",
      "-f",
      "dshow",
      "-i",
      "audio=default",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-t",
      durationSec,
      outPath,
    ];
  } else {
    cmd = [
      "ffmpeg",
      "-y",
      "-f",
      "alsa",
      "-i",
      "default",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-t",
      durationSec,
      outPath,
    ];
  }

  return new Promise<string>((resolve, reject) => {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited.then(
      (code) => {
        if (code === 0) resolve(outPath);
        else reject(new Error(`ffmpeg exited with ${code}`));
      },
    );
  });
}

export class WakeWordDetectorImpl implements WakeWordDetector {
  onDetected: ((event: WakeWordEvent) => void) | undefined;
  onMicrophoneStateChange: ((event: MicrophoneStateEvent) => void) | undefined;

  private readonly stt: SttProvider;
  private readonly wakeWordLower: string;
  private readonly chunkDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly cooldownMs: number;
  private readonly maxPolls: number | undefined;
  private readonly recordAudioFn: (durationMs: number) => Promise<string>;
  private readonly isChunkSilentFn: (audioPath: string) => Promise<boolean>;
  private running = false;
  private pollCount = 0;

  constructor(opts: WakeWordDetectorOptions) {
    this.stt = opts.stt;
    this.wakeWordLower = opts.wakeWord.toLowerCase();
    this.chunkDurationMs = opts.chunkDurationMs ?? 2000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.cooldownMs = opts.cooldownMs ?? 3000;
    this.maxPolls = opts.maxPolls;
    this.recordAudioFn = opts.recordAudio ?? defaultRecordAudio;
    this.isChunkSilentFn = opts.isChunkSilent ?? defaultIsChunkSilent;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollCount = 0;
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
  }

  private emitMicState(active: boolean): void {
    this.onMicrophoneStateChange?.({
      active,
      source: "wake-word",
      changedAt: Date.now(),
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      if (this.maxPolls !== undefined && this.pollCount >= this.maxPolls) {
        this.running = false;
        break;
      }
      this.pollCount++;

      try {
        this.emitMicState(true);
        let audioPath: string;
        try {
          audioPath = await this.recordAudioFn(this.chunkDurationMs);
        } finally {
          this.emitMicState(false);
        }
        const silent = await this.isChunkSilentFn(audioPath);
        if (!silent) {
          const result = await this.stt.transcribe(audioPath);
          if (result.text.toLowerCase().includes(this.wakeWordLower)) {
            this.onDetected?.({ transcript: result.text, detectedAt: Date.now() });
            await new Promise((r) => setTimeout(r, this.cooldownMs));
          }
        }
      } catch {
        /* audio or transcription error — skip this chunk */
      }

      if (this.running) {
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
    }
  }
}
