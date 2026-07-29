import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolveWhisperBin, WhisperSttProvider } from "./stt.ts";

const WHISPER_STDOUT = `[00:00:00.000 --> 00:00:03.000]  Hello, this is a test.\n`;

type MockSpawnResult = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
};

function makeSpawnMock(stdout: string, exitCode = 0): MockSpawnResult {
  const encoder = new TextEncoder();
  return {
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(stdout));
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    exited: Promise.resolve(exitCode),
  };
}

describe("resolveWhisperBin", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env["NIMBUS_WHISPER_PATH"];
    delete process.env["NIMBUS_WHISPER_PATH"];
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env["NIMBUS_WHISPER_PATH"] = savedEnv;
    } else {
      delete process.env["NIMBUS_WHISPER_PATH"];
    }
  });

  test("returns configuredPath when provided and non-empty", () => {
    const result = resolveWhisperBin("/custom/whisper");
    expect(result).toBe("/custom/whisper");
  });

  test("skips empty string configuredPath and falls through", () => {
    // env not set, which finds whisper-cli
    const result = resolveWhisperBin("", (_name) => "/usr/bin/whisper-cli");
    expect(result).toBe("whisper-cli");
  });

  test("returns env path when NIMBUS_WHISPER_PATH is set", () => {
    process.env["NIMBUS_WHISPER_PATH"] = "/env/path/whisper";
    // which should not be consulted because env path is found first
    const result = resolveWhisperBin(undefined, (_name) => null);
    expect(result).toBe("/env/path/whisper");
  });

  test("falls through env empty string to which", () => {
    process.env["NIMBUS_WHISPER_PATH"] = "";
    const result = resolveWhisperBin(undefined, (_name) => "/found/whisper-cli");
    expect(result).toBe("whisper-cli");
  });

  test("returns 'whisper-cli' when which finds it and no configured/env path", () => {
    // env not set
    const result = resolveWhisperBin(undefined, (_name) => "/usr/local/bin/whisper-cli");
    expect(result).toBe("whisper-cli");
  });

  test("returns 'main' when which returns null and no configured/env path", () => {
    // env not set, which finds nothing
    const result = resolveWhisperBin(undefined, (_name) => null);
    expect(result).toBe("main");
  });
});

describe("WhisperSttProvider", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  test("isAvailable returns true when binary resolves", async () => {
    const provider = new WhisperSttProvider({
      whisperBin: "whisper-cli",
      which: (_name) => "/usr/local/bin/whisper-cli",
    });
    expect(await provider.isAvailable()).toBe(true);
  });

  test("isAvailable with absolute forward-slash path checks file existence (file exists)", async () => {
    // import.meta.path is an absolute path that exists
    const provider = new WhisperSttProvider({
      whisperBin: import.meta.path,
      which: (_name) => null,
    });
    expect(await provider.isAvailable()).toBe(true);
  });

  // With `which` stubbed to null, availability rests entirely on the path itself: a bare name has
  // nowhere left to resolve, and an absolute path (either separator) must exist on disk.
  test.each([
    ["a bare binary name not found on PATH", "whisper-cli"],
    ["an absolute forward-slash path that does not exist", "/absolutely/nonexistent/whisper"],
    ["a backslash path that does not exist", "C:\\nonexistent\\whisper.exe"], // cross-platform-ok: intentional Windows backslash to exercise the `includes("\\")` branch
  ])("isAvailable returns false for %s", async (_label, whisperBin) => {
    const provider = new WhisperSttProvider({ whisperBin, which: (_name) => null });
    expect(await provider.isAvailable()).toBe(false);
  });

  test("isAvailable returns false when Bun.file().exists() throws", async () => {
    // We patch Bun.file to throw so the catch arm executes
    const origFile = Bun.file;
    Bun.file = ((_path: unknown) => {
      throw new Error("simulated file access error");
    }) as unknown as typeof Bun.file;
    const provider = new WhisperSttProvider({
      whisperBin: "/some/path/whisper",
      which: (_name) => null,
    });
    try {
      expect(await provider.isAvailable()).toBe(false);
    } finally {
      Bun.file = origFile;
    }
  });

  test("transcribe returns parsed text from Whisper stdout", async () => {
    const spawnFake = mock((_cmd: string[], _opts?: unknown) =>
      makeSpawnMock(WHISPER_STDOUT),
    ) as unknown as typeof Bun.spawn;

    const provider = new WhisperSttProvider({
      whisperBin: "/usr/local/bin/whisper-cli",
      spawn: spawnFake,
    });
    const result = await provider.transcribe(import.meta.path);
    expect(result.text).toBe("Hello, this is a test.");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("transcribe strips leading/trailing whitespace from transcript", async () => {
    const spawnFake = mock((_cmd: string[], _opts?: unknown) =>
      makeSpawnMock("[00:00:00.000 --> 00:00:01.000]   Trimmed output.   \n"),
    ) as unknown as typeof Bun.spawn;

    const provider = new WhisperSttProvider({
      whisperBin: "/usr/local/bin/whisper-cli",
      spawn: spawnFake,
    });
    const result = await provider.transcribe(import.meta.path);
    expect(result.text).toBe("Trimmed output.");
  });

  test("transcribe returns empty string when output has no non-empty lines", async () => {
    // Only blank lines and whitespace-only lines after stripping timestamps → empty text
    const spawnFake = mock((_cmd: string[], _opts?: unknown) =>
      makeSpawnMock("\n\n   \n"),
    ) as unknown as typeof Bun.spawn;

    const provider = new WhisperSttProvider({
      whisperBin: "/usr/local/bin/whisper-cli",
      spawn: spawnFake,
    });
    const result = await provider.transcribe(import.meta.path);
    expect(result.text).toBe("");
  });

  test("transcribe throws when Whisper exits with non-zero code", async () => {
    const spawnFake = mock((_cmd: string[], _opts?: unknown) =>
      makeSpawnMock("", 1),
    ) as unknown as typeof Bun.spawn;

    const provider = new WhisperSttProvider({
      whisperBin: "/usr/local/bin/whisper-cli",
      spawn: spawnFake,
    });
    await expect(provider.transcribe(import.meta.path)).rejects.toThrow("Whisper exited");
  });

  test("transcribe throws when audio file does not exist", async () => {
    const provider = new WhisperSttProvider({ whisperBin: "/usr/local/bin/whisper-cli" });
    await expect(provider.transcribe("/nonexistent/audio.wav")).rejects.toThrow("not found");
  });

  test("transcribe passes model flag when modelName is configured", async () => {
    const captured: string[][] = [];
    const spawnFake = mock((cmd: string[], _opts?: unknown) => {
      captured.push(cmd);
      return makeSpawnMock(WHISPER_STDOUT);
    }) as unknown as typeof Bun.spawn;

    const provider = new WhisperSttProvider({
      whisperBin: "/usr/local/bin/whisper-cli",
      modelName: "small",
      spawn: spawnFake,
    });
    await provider.transcribe(import.meta.path);
    expect(captured[0]).toContain("-m");
    expect(captured[0]).toContain("small");
  });

  test("transcribe does not pass model flag when modelName is empty string", async () => {
    const captured: string[][] = [];
    const spawnFake = mock((cmd: string[], _opts?: unknown) => {
      captured.push(cmd);
      return makeSpawnMock(WHISPER_STDOUT);
    }) as unknown as typeof Bun.spawn;

    const provider = new WhisperSttProvider({
      whisperBin: "/usr/local/bin/whisper-cli",
      modelName: "",
      spawn: spawnFake,
    });
    await provider.transcribe(import.meta.path);
    expect(captured[0]).not.toContain("-m");
  });

  test("constructor uses resolveWhisperBin fallback when no whisperBin provided", () => {
    // which returns null → resolveWhisperBin returns "main"
    const provider = new WhisperSttProvider({ which: (_name) => null });
    // isAvailable with name "main" (no slash) calls _which("main")
    // We just check the provider is constructed without error
    expect(provider).toBeInstanceOf(WhisperSttProvider);
  });

  test("constructor uses which result for default whisperBin", () => {
    // which finds whisper-cli → resolveWhisperBin returns "whisper-cli"
    const provider = new WhisperSttProvider({ which: (_name) => "/bin/whisper-cli" });
    expect(provider).toBeInstanceOf(WhisperSttProvider);
  });

  test("transcribe error message includes exit code", async () => {
    const spawnFake = mock((_cmd: string[], _opts?: unknown) =>
      makeSpawnMock("", 127),
    ) as unknown as typeof Bun.spawn;

    const provider = new WhisperSttProvider({
      whisperBin: "/usr/local/bin/whisper-cli",
      spawn: spawnFake,
    });
    await expect(provider.transcribe(import.meta.path)).rejects.toThrow("127");
  });

  test("transcribe joins multiple output lines with space", async () => {
    const multiLine =
      "[00:00:00.000 --> 00:00:01.000]  First line.\n[00:00:01.000 --> 00:00:02.000]  Second line.\n";
    const spawnFake = mock((_cmd: string[], _opts?: unknown) =>
      makeSpawnMock(multiLine),
    ) as unknown as typeof Bun.spawn;

    const provider = new WhisperSttProvider({
      whisperBin: "/usr/local/bin/whisper-cli",
      spawn: spawnFake,
    });
    const result = await provider.transcribe(import.meta.path);
    expect(result.text).toBe("First line. Second line.");
  });
});
