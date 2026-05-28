import { describe, expect, test } from "bun:test";
import { VoiceService } from "./service.ts";
import type { MicrophoneStateEvent, SttProvider, TtsProvider, WakeWordDetector } from "./types.ts";

function makeFakeStt(): SttProvider {
  return {
    isAvailable: async () => true,
    transcribe: async (_p) => ({ text: "hello", durationMs: 1 }),
  };
}

function makeFakeTts(): TtsProvider {
  return { isAvailable: async () => true, speak: async (_t) => undefined };
}

function makeFakeDetector(): WakeWordDetector & {
  startCalls: number;
  stopCalls: number;
} {
  let running = false;
  const det = {
    startCalls: 0,
    stopCalls: 0,
    onDetected: undefined,
    onMicrophoneStateChange: undefined,
    get isRunning() {
      return running;
    },
    start() {
      running = true;
      this.startCalls++;
    },
    stop() {
      running = false;
      this.stopCalls++;
    },
  } as WakeWordDetector & { startCalls: number; stopCalls: number };
  return det;
}

describe("VoiceService microphone arbiter", () => {
  test("transcribe pauses wake word when running and resumes after", async () => {
    const det = makeFakeDetector();
    det.start();
    expect(det.isRunning).toBe(true);

    const svc = new VoiceService({
      enabled: true,
      stt: makeFakeStt(),
      tts: makeFakeTts(),
      wakeWord: det,
    });

    await svc.transcribe(import.meta.path);
    expect(det.stopCalls).toBe(1);
    expect(det.startCalls).toBe(2);
    expect(det.isRunning).toBe(true);
  });

  test("transcribe does NOT start wake word if it was not running before", async () => {
    const det = makeFakeDetector();
    const svc = new VoiceService({
      enabled: true,
      stt: makeFakeStt(),
      tts: makeFakeTts(),
      wakeWord: det,
    });

    await svc.transcribe(import.meta.path);
    expect(det.startCalls).toBe(0);
    expect(det.stopCalls).toBe(0);
  });

  test("onMicrophoneStateChange fires active=true/false around transcribe", async () => {
    const states: MicrophoneStateEvent[] = [];
    const svc = new VoiceService({
      enabled: true,
      stt: makeFakeStt(),
      tts: makeFakeTts(),
      onMicrophoneStateChange: (e) => states.push(e),
    });
    await svc.transcribe(import.meta.path);
    expect(states.map((s) => ({ active: s.active, source: s.source }))).toEqual([
      { active: true, source: "transcribe" },
      { active: false, source: "transcribe" },
    ]);
  });

  test("forwards wake-word mic state events through the service callback", () => {
    const states: MicrophoneStateEvent[] = [];
    const det = makeFakeDetector();
    const svc = new VoiceService({
      enabled: true,
      stt: makeFakeStt(),
      tts: makeFakeTts(),
      wakeWord: det,
      onMicrophoneStateChange: (e) => states.push(e),
    });
    expect(svc.enabled).toBe(true);
    det.onMicrophoneStateChange?.({ active: true, source: "wake-word", changedAt: 1 });
    expect(states).toHaveLength(1);
    expect(states[0]?.source).toBe("wake-word");
  });

  test("transcribe/speak throw when voice is disabled", async () => {
    const svc = new VoiceService({
      enabled: false,
      stt: makeFakeStt(),
      tts: makeFakeTts(),
    });
    await expect(svc.transcribe("/x")).rejects.toThrow("not enabled");
    await expect(svc.speak("hi")).rejects.toThrow("not enabled");
  });
});
