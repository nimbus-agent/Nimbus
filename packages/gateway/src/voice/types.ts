export type SttResult = {
  text: string;
  durationMs: number;
  language?: string;
};

export interface SttProvider {
  isAvailable(): Promise<boolean>;
  transcribe(audioPath: string): Promise<SttResult>;
}

export interface TtsProvider {
  isAvailable(): Promise<boolean>;
  speak(text: string): Promise<void>;
}

export type WakeWordEvent = {
  transcript: string;
  detectedAt: number;
};

export type MicrophoneStateEvent = {
  active: boolean;
  source: "wake-word" | "transcribe";
  changedAt: number;
};

export interface WakeWordDetector {
  start(): void;
  stop(): void;
  onDetected: ((event: WakeWordEvent) => void) | undefined;
  onMicrophoneStateChange: ((event: MicrophoneStateEvent) => void) | undefined;
  readonly isRunning: boolean;
}
