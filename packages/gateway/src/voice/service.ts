import type { MicrophoneStateEvent, SttProvider, TtsProvider, WakeWordDetector } from "./types.ts";

export type VoiceServiceConfig = {
  enabled: boolean;
  stt: SttProvider;
  tts: TtsProvider;
  wakeWord?: WakeWordDetector;
  onMicrophoneStateChange?: (event: MicrophoneStateEvent) => void;
};

export type VoiceStatus = {
  enabled: boolean;
  sttAvailable: boolean;
  ttsAvailable: boolean;
  wakeWordActive: boolean;
};

export class VoiceService {
  private readonly stt: SttProvider;
  private readonly tts: TtsProvider;
  private readonly wakeWordDet: WakeWordDetector | undefined;
  onMicrophoneStateChange: ((event: MicrophoneStateEvent) => void) | undefined;
  readonly enabled: boolean;

  constructor(cfg: VoiceServiceConfig) {
    this.enabled = cfg.enabled;
    this.stt = cfg.stt;
    this.tts = cfg.tts;
    this.wakeWordDet = cfg.wakeWord;
    this.onMicrophoneStateChange = cfg.onMicrophoneStateChange;
    if (this.wakeWordDet !== undefined) {
      this.wakeWordDet.onMicrophoneStateChange = (e) => this.onMicrophoneStateChange?.(e);
    }
  }

  private emitMicState(active: boolean): void {
    this.onMicrophoneStateChange?.({ active, source: "transcribe", changedAt: Date.now() });
  }

  async transcribe(audioPath: string): Promise<{ text: string; durationMs: number }> {
    if (!this.enabled) throw new Error("Voice is not enabled in configuration");

    const resumeWakeWord = this.wakeWordDet?.isRunning === true;
    if (resumeWakeWord) {
      this.wakeWordDet?.stop();
    }

    this.emitMicState(true);
    try {
      return await this.stt.transcribe(audioPath);
    } finally {
      this.emitMicState(false);
      if (resumeWakeWord) {
        this.wakeWordDet?.start();
      }
    }
  }

  async speak(text: string): Promise<void> {
    if (!this.enabled) throw new Error("Voice is not enabled in configuration");
    return this.tts.speak(text);
  }

  async getStatus(): Promise<VoiceStatus> {
    const [sttAvailable, ttsAvailable] = await Promise.all([
      this.stt.isAvailable().catch(() => false),
      this.tts.isAvailable().catch(() => false),
    ]);
    return {
      enabled: this.enabled,
      sttAvailable,
      ttsAvailable,
      wakeWordActive: this.wakeWordDet?.isRunning ?? false,
    };
  }

  startWakeWord(): void {
    if (this.wakeWordDet === undefined) return;
    this.wakeWordDet.start();
  }

  stopWakeWord(): void {
    this.wakeWordDet?.stop();
  }
}
