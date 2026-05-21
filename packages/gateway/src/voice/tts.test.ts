import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeTtsProvider, PiperTtsProvider } from "./tts.ts";

type MockSpawnResult = {
  exited: Promise<number>;
  stdout?: unknown;
};

function makeSpawnMock(exitCode = 0): MockSpawnResult {
  return { exited: Promise.resolve(exitCode) };
}

function makePiperSpawnMock(exitCode = 0): MockSpawnResult {
  // PiperTtsProvider pipes `proc.stdout` into the player as stdin.
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
  return { exited: Promise.resolve(exitCode), stdout };
}

async function runLinuxTts(whichFn: (name: string) => string | null): Promise<string[][]> {
  const origWhich = Bun.which;
  Bun.which = whichFn;
  const captured: string[][] = [];
  const origSpawn = Bun.spawn;
  Bun.spawn = mock((cmd: string[], _opts?: unknown) => {
    captured.push(cmd);
    return makeSpawnMock(0);
  }) as unknown as typeof Bun.spawn;
  try {
    const provider = new NativeTtsProvider({ platform: "linux" });
    await provider.speak("Test");
  } finally {
    Bun.which = origWhich;
    Bun.spawn = origSpawn;
  }
  return captured;
}

describe("NativeTtsProvider", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  test("speak resolves when TTS exits with code 0", async () => {
    Bun.spawn = mock((_cmd: string[], _opts?: unknown) =>
      makeSpawnMock(0),
    ) as unknown as typeof Bun.spawn;

    const provider = new NativeTtsProvider({ platform: "darwin" });
    await expect(provider.speak("Hello world")).resolves.toBeUndefined();
  });

  test("speak throws when TTS exits with non-zero code", async () => {
    Bun.spawn = mock((_cmd: string[], _opts?: unknown) =>
      makeSpawnMock(1),
    ) as unknown as typeof Bun.spawn;

    const provider = new NativeTtsProvider({ platform: "darwin" });
    await expect(provider.speak("Hello")).rejects.toThrow("TTS exited");
  });

  test("speak passes text as separate argv element (no shell injection risk)", async () => {
    const captured: string[][] = [];
    Bun.spawn = mock((cmd: string[], _opts?: unknown) => {
      captured.push(cmd);
      return makeSpawnMock(0);
    }) as unknown as typeof Bun.spawn;

    const dangerous = 'Hello"; rm -rf /';
    const provider = new NativeTtsProvider({ platform: "darwin" });
    await provider.speak(dangerous);
    expect(captured[0]).toContain(dangerous);
    expect(captured[0]?.join(" ")).not.toContain("sh -c");
  });

  test("isAvailable returns true on darwin (say is always present)", async () => {
    const provider = new NativeTtsProvider({ platform: "darwin" });
    expect(await provider.isAvailable()).toBe(true);
  });

  test("isAvailable returns true on win32", async () => {
    const provider = new NativeTtsProvider({ platform: "win32" });
    expect(await provider.isAvailable()).toBe(true);
  });

  test("linux: uses espeak-ng when available on PATH", async () => {
    const captured = await runLinuxTts((_name) => "/usr/bin/espeak-ng");
    expect(captured[0]?.[0]).toContain("espeak-ng");
  });

  test("linux: falls back to spd-say when espeak-ng not on PATH", async () => {
    const captured = await runLinuxTts((name) => (name === "spd-say" ? "/usr/bin/spd-say" : null));
    expect(captured[0]?.[0]).toContain("spd-say");
  });

  test("isAvailable returns true on linux when espeak-ng is on PATH", async () => {
    const origWhich = Bun.which;
    Bun.which = (name: string) => (name === "espeak-ng" ? "/usr/bin/espeak-ng" : null);
    try {
      const provider = new NativeTtsProvider({ platform: "linux" });
      expect(await provider.isAvailable()).toBe(true);
    } finally {
      Bun.which = origWhich;
    }
  });

  test("isAvailable returns true on linux when only spd-say is present", async () => {
    const origWhich = Bun.which;
    Bun.which = (name: string) => (name === "spd-say" ? "/usr/bin/spd-say" : null);
    try {
      const provider = new NativeTtsProvider({ platform: "linux" });
      expect(await provider.isAvailable()).toBe(true);
    } finally {
      Bun.which = origWhich;
    }
  });

  test("isAvailable returns false on linux when neither binary is present", async () => {
    const origWhich = Bun.which;
    Bun.which = (_name: string) => null;
    try {
      const provider = new NativeTtsProvider({ platform: "linux" });
      expect(await provider.isAvailable()).toBe(false);
    } finally {
      Bun.which = origWhich;
    }
  });
});

describe("PiperTtsProvider", () => {
  let originalSpawn: typeof Bun.spawn;
  let originalPlatform: PropertyDescriptor | undefined;
  let tmpDir: string;
  let modelPath: string;
  let binPath: string;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-piper-test-"));
    modelPath = join(tmpDir, "voice.onnx");
    binPath = join(tmpDir, "piper");
    writeFileSync(modelPath, Buffer.from([0x00]));
    writeFileSync(binPath, Buffer.from([0x00]));
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("isAvailable returns true when both bin (path form) and model exist", async () => {
    const provider = new PiperTtsProvider({ piperBin: binPath, modelPath });
    expect(await provider.isAvailable()).toBe(true);
  });

  test("isAvailable returns false when model is missing", async () => {
    const provider = new PiperTtsProvider({
      piperBin: binPath,
      modelPath: join(tmpDir, "nonexistent.onnx"),
    });
    expect(await provider.isAvailable()).toBe(false);
  });

  test("isAvailable returns false when modelPath is empty", async () => {
    const provider = new PiperTtsProvider({ piperBin: binPath, modelPath: "" });
    expect(await provider.isAvailable()).toBe(false);
  });

  test("isAvailable resolves bare binary name via Bun.which", async () => {
    const origWhich = Bun.which;
    Bun.which = (name: string) => (name === "piper" ? binPath : null);
    try {
      const provider = new PiperTtsProvider({ piperBin: "piper", modelPath });
      expect(await provider.isAvailable()).toBe(true);
    } finally {
      Bun.which = origWhich;
    }
  });

  test("isAvailable returns false when bare binary name does not resolve", async () => {
    const origWhich = Bun.which;
    Bun.which = (_name: string) => null;
    try {
      const provider = new PiperTtsProvider({ piperBin: "piper", modelPath });
      expect(await provider.isAvailable()).toBe(false);
    } finally {
      Bun.which = origWhich;
    }
  });

  test("speak on darwin pipes piper through afplay", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const captured: string[][] = [];
    Bun.spawn = mock((cmd: string[], _opts?: unknown) => {
      captured.push(cmd);
      return makePiperSpawnMock(0);
    }) as unknown as typeof Bun.spawn;

    const provider = new PiperTtsProvider({ piperBin: binPath, modelPath });
    await expect(provider.speak("hi")).resolves.toBeUndefined();
    expect(captured[0]?.[0]).toBe(binPath);
    expect(captured[1]?.[0]).toBe("afplay");
  });

  test("speak on win32 pipes piper through PowerShell SoundPlayer", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const captured: string[][] = [];
    Bun.spawn = mock((cmd: string[], _opts?: unknown) => {
      captured.push(cmd);
      return makePiperSpawnMock(0);
    }) as unknown as typeof Bun.spawn;

    const provider = new PiperTtsProvider({ piperBin: binPath, modelPath });
    await expect(provider.speak("hi")).resolves.toBeUndefined();
    expect(captured[1]?.[0]).toBe("PowerShell.exe");
  });

  test("speak on linux with aplay available routes audio to aplay", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const origWhich = Bun.which;
    Bun.which = (name: string) => (name === "aplay" ? "/usr/bin/aplay" : null);
    const captured: string[][] = [];
    Bun.spawn = mock((cmd: string[], _opts?: unknown) => {
      captured.push(cmd);
      return makePiperSpawnMock(0);
    }) as unknown as typeof Bun.spawn;

    try {
      const provider = new PiperTtsProvider({ piperBin: binPath, modelPath });
      await expect(provider.speak("hi")).resolves.toBeUndefined();
      expect(captured[1]?.[0]).toBe("aplay");
    } finally {
      Bun.which = origWhich;
    }
  });

  test("speak on linux without aplay throws 'No audio player found'", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const origWhich = Bun.which;
    Bun.which = (_name: string) => null;
    Bun.spawn = mock((_cmd: string[], _opts?: unknown) =>
      makePiperSpawnMock(0),
    ) as unknown as typeof Bun.spawn;

    try {
      const provider = new PiperTtsProvider({ piperBin: binPath, modelPath });
      await expect(provider.speak("hi")).rejects.toThrow("No audio player found");
    } finally {
      Bun.which = origWhich;
    }
  });

  test("speak throws when piper exits non-zero", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    let spawnCalls = 0;
    Bun.spawn = mock((_cmd: string[], _opts?: unknown) => {
      spawnCalls++;
      // First call = piper (non-zero), second = player (zero).
      return makePiperSpawnMock(spawnCalls === 1 ? 7 : 0);
    }) as unknown as typeof Bun.spawn;

    const provider = new PiperTtsProvider({ piperBin: binPath, modelPath });
    await expect(provider.speak("hi")).rejects.toThrow("Piper exited with code 7");
  });

  test("speak throws when audio player exits non-zero", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    let spawnCalls = 0;
    Bun.spawn = mock((_cmd: string[], _opts?: unknown) => {
      spawnCalls++;
      // First call = piper (zero), second = player (non-zero).
      return makePiperSpawnMock(spawnCalls === 1 ? 0 : 9);
    }) as unknown as typeof Bun.spawn;

    const provider = new PiperTtsProvider({ piperBin: binPath, modelPath });
    await expect(provider.speak("hi")).rejects.toThrow("Audio player exited with code 9");
  });
});
