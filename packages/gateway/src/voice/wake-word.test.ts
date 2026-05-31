import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SttProvider, SttResult } from "./types.ts";
import { WakeWordDetectorImpl } from "./wake-word.ts";

type MockSpawnResult = {
  stdout?: unknown;
  stderr?: unknown;
  exited: Promise<number>;
};

function makeStreamFromString(s: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(s));
      c.close();
    },
  });
}

function makeEmptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
}

function makeFakeStt(transcripts: string[]): SttProvider {
  let callCount = 0;
  return {
    isAvailable: async () => true,
    transcribe: async (_path: string): Promise<SttResult> => {
      const text = transcripts[callCount % transcripts.length] ?? "";
      callCount++;
      return { text, durationMs: 10 };
    },
  };
}

describe("WakeWordDetectorImpl", () => {
  test("isRunning is false initially", () => {
    const det = new WakeWordDetectorImpl({
      stt: makeFakeStt([]),
      wakeWord: "hey nimbus",
      recordAudio: async () => import.meta.path,
    });
    expect(det.isRunning).toBe(false);
  });

  test("start sets isRunning to true, stop sets it to false", () => {
    const det = new WakeWordDetectorImpl({
      stt: makeFakeStt([]),
      wakeWord: "hey nimbus",
      recordAudio: async () => import.meta.path,
    });
    det.start();
    expect(det.isRunning).toBe(true);
    det.stop();
    expect(det.isRunning).toBe(false);
  });

  test("start is idempotent", () => {
    const det = new WakeWordDetectorImpl({
      stt: makeFakeStt([]),
      wakeWord: "hey nimbus",
      recordAudio: async () => import.meta.path,
    });
    det.start();
    det.start();
    expect(det.isRunning).toBe(true);
    det.stop();
  });

  test("fires onDetected when transcript contains wake word (case-insensitive)", async () => {
    const events: string[] = [];
    const det = new WakeWordDetectorImpl({
      stt: makeFakeStt(["Hey Nimbus, what time is it?"]),
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      recordAudio: async () => import.meta.path,
      isChunkSilent: async () => false,
    });
    det.onDetected = (evt) => {
      events.push(evt.transcript);
      det.stop();
    };
    det.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toContain("Hey Nimbus");
  });

  test("does not fire onDetected when transcript does not contain wake word", async () => {
    const events: string[] = [];
    const det = new WakeWordDetectorImpl({
      stt: makeFakeStt(["The weather is nice today."]),
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      maxPolls: 3,
      recordAudio: async () => import.meta.path,
      isChunkSilent: async () => false,
    });
    det.onDetected = (evt) => events.push(evt.transcript);
    det.start();
    await new Promise((r) => setTimeout(r, 100));
    det.stop();
    expect(events).toHaveLength(0);
  });

  test("onMicrophoneStateChange fires active=true before recording and active=false after", async () => {
    const states: Array<{ active: boolean; source: string }> = [];
    const det = new WakeWordDetectorImpl({
      stt: makeFakeStt([""]),
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      maxPolls: 1,
      recordAudio: async () => import.meta.path,
      isChunkSilent: async () => true,
    });
    det.onMicrophoneStateChange = (evt) => states.push({ active: evt.active, source: evt.source });
    det.start();
    await new Promise((r) => setTimeout(r, 100));
    det.stop();
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[0]).toEqual({ active: true, source: "wake-word" });
    expect(states.at(-1)).toEqual({ active: false, source: "wake-word" });
  });

  test("recording error is swallowed (poll continues without firing onDetected)", async () => {
    const events: string[] = [];
    const det = new WakeWordDetectorImpl({
      stt: makeFakeStt(["any text"]),
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      maxPolls: 2,
      recordAudio: async () => {
        throw new Error("audio device not available");
      },
      isChunkSilent: async () => false,
    });
    det.onDetected = (evt) => events.push(evt.transcript);
    det.start();
    await new Promise((r) => setTimeout(r, 100));
    det.stop();
    expect(events).toHaveLength(0);
    expect(det.isRunning).toBe(false);
  });

  test("silent chunks skip the transcribe call entirely", async () => {
    let transcribeCalls = 0;
    const stt: SttProvider = {
      isAvailable: async () => true,
      transcribe: async (_p): Promise<SttResult> => {
        transcribeCalls++;
        return { text: "should not happen", durationMs: 0 };
      },
    };
    const det = new WakeWordDetectorImpl({
      stt,
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      maxPolls: 2,
      recordAudio: async () => import.meta.path,
      isChunkSilent: async () => true,
    });
    det.start();
    await new Promise((r) => setTimeout(r, 100));
    det.stop();
    expect(transcribeCalls).toBe(0);
  });
});

describe("WakeWordDetectorImpl default audio path (Bun.spawn dispatch)", () => {
  let originalSpawn: typeof Bun.spawn;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  test("defaultRecordAudio dispatches avfoundation cmd on darwin", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const captured: string[][] = [];
    Bun.spawn = mock((cmd: string[], _opts?: unknown): MockSpawnResult => {
      captured.push(cmd);
      return { exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;

    const det = new WakeWordDetectorImpl({
      stt: { isAvailable: async () => true, transcribe: async () => ({ text: "", durationMs: 0 }) },
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      chunkDurationMs: 2000,
      maxPolls: 1,
      isChunkSilent: async () => true,
    });
    det.start();
    await new Promise((r) => setTimeout(r, 80));
    det.stop();
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const first = captured[0];
    expect(first).toBeDefined();
    expect(first?.[0]).toBe("ffmpeg");
    expect(first?.join(" ")).toContain("avfoundation");
  });

  test("defaultRecordAudio dispatches dshow cmd on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const captured: string[][] = [];
    Bun.spawn = mock((cmd: string[], _opts?: unknown): MockSpawnResult => {
      captured.push(cmd);
      return { exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;

    const det = new WakeWordDetectorImpl({
      stt: { isAvailable: async () => true, transcribe: async () => ({ text: "", durationMs: 0 }) },
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      chunkDurationMs: 2000,
      maxPolls: 1,
      isChunkSilent: async () => true,
    });
    det.start();
    await new Promise((r) => setTimeout(r, 80));
    det.stop();
    expect(captured[0]?.join(" ")).toContain("dshow");
  });

  test("defaultRecordAudio dispatches alsa cmd on linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const captured: string[][] = [];
    Bun.spawn = mock((cmd: string[], _opts?: unknown): MockSpawnResult => {
      captured.push(cmd);
      return { exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;

    const det = new WakeWordDetectorImpl({
      stt: { isAvailable: async () => true, transcribe: async () => ({ text: "", durationMs: 0 }) },
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      chunkDurationMs: 2000,
      maxPolls: 1,
      isChunkSilent: async () => true,
    });
    det.start();
    await new Promise((r) => setTimeout(r, 80));
    det.stop();
    expect(captured[0]?.join(" ")).toContain("alsa");
  });

  test("defaultRecordAudio rejects when ffmpeg exits non-zero (handled by poll-loop catch)", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    Bun.spawn = mock(
      (_cmd: string[], _opts?: unknown): MockSpawnResult => ({ exited: Promise.resolve(1) }),
    ) as unknown as typeof Bun.spawn;

    let transcribeCalled = false;
    const det = new WakeWordDetectorImpl({
      stt: {
        isAvailable: async () => true,
        transcribe: async () => {
          transcribeCalled = true;
          return { text: "", durationMs: 0 };
        },
      },
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      chunkDurationMs: 1000,
      maxPolls: 1,
      isChunkSilent: async () => false,
    });
    det.start();
    await new Promise((r) => setTimeout(r, 100));
    det.stop();
    expect(transcribeCalled).toBe(false);
  });

  test("defaultIsChunkSilent treats stderr WITH silence_end as non-silent (runs transcribe)", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    let spawnCalls = 0;
    Bun.spawn = mock((_cmd: string[], _opts?: unknown): MockSpawnResult => {
      spawnCalls++;
      if (spawnCalls === 1) {
        return { exited: Promise.resolve(0) };
      }
      return {
        stdout: makeEmptyStream(),
        stderr: makeStreamFromString("[silencedetect] silence_end: 1.5\n"),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    let transcribeCalled = false;
    const det = new WakeWordDetectorImpl({
      stt: {
        isAvailable: async () => true,
        transcribe: async () => {
          transcribeCalled = true;
          return { text: "no match", durationMs: 0 };
        },
      },
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      chunkDurationMs: 1000,
      maxPolls: 1,
    });
    det.start();
    await new Promise((r) => setTimeout(r, 120));
    det.stop();
    expect(transcribeCalled).toBe(true);
  });

  test("defaultIsChunkSilent treats stderr WITHOUT silence_end as silent (skips transcribe)", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    let spawnCalls = 0;
    Bun.spawn = mock((_cmd: string[], _opts?: unknown): MockSpawnResult => {
      spawnCalls++;
      if (spawnCalls === 1) {
        return { exited: Promise.resolve(0) };
      }
      return {
        stdout: makeEmptyStream(),
        stderr: makeStreamFromString("nothing of interest\n"),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    let transcribeCalled = false;
    const det = new WakeWordDetectorImpl({
      stt: {
        isAvailable: async () => true,
        transcribe: async () => {
          transcribeCalled = true;
          return { text: "", durationMs: 0 };
        },
      },
      wakeWord: "hey nimbus",
      pollIntervalMs: 10,
      chunkDurationMs: 1000,
      maxPolls: 1,
    });
    det.start();
    await new Promise((r) => setTimeout(r, 120));
    det.stop();
    expect(transcribeCalled).toBe(false);
  });
});
