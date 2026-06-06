import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import type { IPCClient } from "../ipc-client/index.ts";
import type { CliPlatformPaths } from "../paths.ts";
import {
  type DoctorCoreDeps,
  type DoctorEnv,
  type DoctorGatewayState,
  type DoctorVoiceConfig,
  doctorPrintConfigValidation,
  doctorPrintHealthFromSnapshot,
  doctorPrintIndexFromSnapshot,
  doctorVoiceLines,
  healthStateMark,
  runDoctor,
  worstHealthSeverity,
} from "./doctor-core.ts";

type WhichMap = Record<string, string | null>;

function makeEnv(
  whichMap: WhichMap,
  envPlatform: "win32" | "darwin" | "linux" = "linux",
): DoctorEnv {
  return {
    which: (name: string) => whichMap[name] ?? null,
    platform: envPlatform,
  };
}

function makeVoiceCfg(overrides: Partial<DoctorVoiceConfig> = {}): DoctorVoiceConfig {
  return {
    enabled: true,
    whisperPath: "",
    piperPath: "",
    piperModel: "",
    ...overrides,
  };
}

// Single real mkdtemp root; all paths are stubbed (deps never touch disk), so
// these only need to be unique, non-publicly-writable strings (S5443).
const FAKE_ROOT = mkdtempSync(join(tmpdir(), "nimbus-doctor-test-"));
const FAKE_PATHS = {
  configDir: join(FAKE_ROOT, "config"),
  dataDir: join(FAKE_ROOT, "data"),
  logDir: join(FAKE_ROOT, "data", "logs"),
  socketPath: join(FAKE_ROOT, "gateway.sock"),
  extensionsDir: join(FAKE_ROOT, "data", "extensions"),
  tempDir: join(FAKE_ROOT, "temp"),
} as unknown as CliPlatformPaths;

function makeDeps(overrides: Partial<DoctorCoreDeps> = {}): DoctorCoreDeps {
  return {
    getCliPlatformPaths: (): CliPlatformPaths => FAKE_PATHS,
    readGatewayState: async (): Promise<DoctorGatewayState | undefined> => undefined,
    isProcessAlive: (): boolean => true,
    gatewayStatePath: (): string => join(FAKE_ROOT, "gateway.json"),
    makeClient: (): IPCClient => createMockIpcClient([]).client,
    ...overrides,
  };
}

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("worstHealthSeverity", () => {
  it("returns 'ok' for an empty list", () => {
    expect(worstHealthSeverity([])).toBe("ok");
  });

  it("returns 'ok' when every state is healthy", () => {
    expect(
      worstHealthSeverity([
        { connectorId: "a", state: "healthy" },
        { connectorId: "b", state: "paused" },
      ]),
    ).toBe("ok");
  });

  it("returns 'warn' for degraded or rate_limited", () => {
    expect(worstHealthSeverity([{ state: "degraded" }])).toBe("warn");
    expect(worstHealthSeverity([{ state: "rate_limited" }])).toBe("warn");
  });

  it("escalates to 'fail' when error or unauthenticated is present", () => {
    expect(worstHealthSeverity([{ state: "degraded" }, { state: "error" }])).toBe("fail");
    expect(worstHealthSeverity([{ state: "unauthenticated" }])).toBe("fail");
  });
});

describe("healthStateMark", () => {
  it.each([
    ["healthy", "[ok]"],
    ["paused", "[ok]"],
    ["error", "[fail]"],
    ["unauthenticated", "[fail]"],
    ["degraded", "[warn]"],
    ["rate_limited", "[warn]"],
    ["unknown", "[warn]"],
  ])("maps state '%s' to '%s'", (state, expected) => {
    expect(healthStateMark(state)).toBe(expected);
  });
});

describe("doctorPrintConfigValidation", () => {
  beforeEach(() => {
    out.reset();
  });

  it("returns 0 and prints '[ok]' when no errors and no warnings", () => {
    const code = doctorPrintConfigValidation({ ok: true, errors: [], warnings: [] });
    expect(code).toBe(0);
    expect(out.stdout).toContain("[ok] Config: valid.");
  });

  it("returns 1 and prints warnings when ok is true with warnings", () => {
    const code = doctorPrintConfigValidation({
      ok: true,
      errors: [],
      warnings: ["llm.remote_model is unset"],
    });
    expect(code).toBe(1);
    expect(out.stdout).toContain("[warn] Config: llm.remote_model is unset");
  });

  it("returns 2 and prints errors when ok is false", () => {
    const code = doctorPrintConfigValidation({
      ok: false,
      errors: ["bad section"],
      warnings: [],
    });
    expect(code).toBe(2);
    expect(out.stdout).toContain("[fail] Config: bad section");
  });
});

describe("doctorPrintIndexFromSnapshot", () => {
  beforeEach(() => {
    out.reset();
  });

  it("returns 1 and warns when totalItems is 0 or missing", () => {
    expect(doctorPrintIndexFromSnapshot({ index: { totalItems: 0 } })).toBe(1);
    expect(out.stdout).toContain("[warn] Index: zero items");
  });

  it("returns 0 and prints the count when totalItems is positive", () => {
    expect(doctorPrintIndexFromSnapshot({ index: { totalItems: 1234 } })).toBe(0);
    expect(out.stdout).toContain("[ok] Index: 1234 items.");
  });
});

describe("doctorPrintHealthFromSnapshot", () => {
  beforeEach(() => {
    out.reset();
  });

  it("returns 1 and warns when no connectors are present", () => {
    expect(doctorPrintHealthFromSnapshot({ connectorHealth: [] })).toBe(1);
    expect(out.stdout).toContain("[warn] Connectors: none registered.");
  });

  it("returns 0 when all connectors are healthy", () => {
    const code = doctorPrintHealthFromSnapshot({
      connectorHealth: [
        { connectorId: "github", state: "healthy" },
        { connectorId: "linear", state: "paused" },
      ],
    });
    expect(code).toBe(0);
    expect(out.stdout).toContain("Connector health:");
    expect(out.stdout).toContain("github");
  });

  it("returns 1 when any connector is in a warn/fail state", () => {
    const code = doctorPrintHealthFromSnapshot({
      connectorHealth: [{ connectorId: "github", state: "error" }],
    });
    expect(code).toBe(1);
    expect(out.stdout).toContain("[fail]");
  });
});

describe("runDoctor dispatcher (4 fixture permutations)", () => {
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    out.reset();
    origExitCode = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
    if (origExitCode !== undefined) process.exitCode = origExitCode;
  });

  it("no gateway state -> prints not-running and exits 2", async () => {
    await runDoctor([], makeDeps({ readGatewayState: async () => undefined }));
    expect(out.stdout).toContain("[fail] Gateway: not running");
    expect(process.exitCode).toBe(2);
  });

  it("stale pid -> prints stale-state and exits 2", async () => {
    await runDoctor(
      [],
      makeDeps({
        readGatewayState: async () => ({ socketPath: join(FAKE_ROOT, "fake.sock"), pid: 999999 }),
        isProcessAlive: () => false,
      }),
    );
    expect(out.stdout).toContain("[fail] Gateway: stale state");
    expect(process.exitCode).toBe(2);
  });

  it("live gateway + IPC ok -> prints gateway/config/index/health lines", async () => {
    const mock = createMockIpcClient([
      { uptime: 5000 },
      { ok: true, errors: [], warnings: [] },
      { index: { totalItems: 10 }, connectorHealth: [{ connectorId: "github", state: "healthy" }] },
    ]);
    await runDoctor(
      [],
      makeDeps({
        readGatewayState: async () => ({ socketPath: join(FAKE_ROOT, "fake.sock"), pid: 1 }),
        isProcessAlive: () => true,
        makeClient: () => mock.client,
      }),
    );
    expect(out.stdout).toContain("[ok] Gateway: IPC OK");
    expect(out.stdout).toContain("[ok] Config: valid.");
    expect(out.stdout).toContain("[ok] Index: 10 items.");
    expect(out.stdout).toContain("github: healthy");
    // exitCode is not asserted here: the Linux secret-tool vault branch can
    // legitimately set it to 2 on CI, which is orthogonal to this path.
  });

  it("live gateway + IPC throws -> prints IPC-failed and exits 2", async () => {
    const mock = createMockIpcClient([new Error("connection refused")]);
    await runDoctor(
      [],
      makeDeps({
        readGatewayState: async () => ({ socketPath: join(FAKE_ROOT, "fake.sock"), pid: 1 }),
        isProcessAlive: () => true,
        makeClient: () => mock.client,
      }),
    );
    expect(out.stdout).toContain("[fail] Gateway: IPC failed");
    expect(process.exitCode).toBe(2);
  });
});

describe("doctorVoiceLines", () => {
  it("returns [] when voice is disabled", () => {
    const lines = doctorVoiceLines(makeVoiceCfg({ enabled: false }), makeEnv({}));
    expect(lines).toHaveLength(0);
  });

  it("reports whisper ok when whisperPath is explicitly set", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({ whisperPath: "/usr/local/bin/whisper-cli" }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg", "espeak-ng": "/usr/bin/espeak-ng" }),
    );
    expect(lines.some((l) => l.includes("[ok] Voice: whisper-cli is available."))).toBe(true);
  });

  it("reports whisper ok when whisper-cli is on PATH", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg(),
      makeEnv({
        "whisper-cli": "/usr/bin/whisper-cli",
        ffmpeg: "/usr/bin/ffmpeg",
        "espeak-ng": "/usr/bin/espeak-ng",
      }),
    );
    expect(lines.some((l) => l.includes("[ok] Voice: whisper-cli is available."))).toBe(true);
  });

  it("reports whisper ok when 'main' binary is on PATH (llama.cpp fallback)", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg(),
      makeEnv({
        main: "/usr/local/bin/main",
        ffmpeg: "/usr/bin/ffmpeg",
        "espeak-ng": "/usr/bin/espeak-ng",
      }),
    );
    expect(lines.some((l) => l.includes("[ok] Voice: whisper-cli is available."))).toBe(true);
  });

  it("warns when whisper not found anywhere", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg(),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg", "espeak-ng": "/usr/bin/espeak-ng" }),
    );
    expect(
      lines.some((l) =>
        l.includes(
          "[warn] Voice: whisper-cli not found on PATH and voice.whisper_path is unset — STT will not work.",
        ),
      ),
    ).toBe(true);
  });

  it("reports ffmpeg ok when it is on PATH", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({ whisperPath: "/bin/whisper-cli" }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg", "espeak-ng": "/usr/bin/espeak-ng" }),
    );
    expect(lines.some((l) => l.includes("[ok] Voice: ffmpeg is on PATH."))).toBe(true);
  });

  it("warns when ffmpeg is absent", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({ whisperPath: "/bin/whisper-cli" }),
      makeEnv({ "espeak-ng": "/usr/bin/espeak-ng" }),
    );
    expect(
      lines.some((l) =>
        l.includes(
          "[warn] Voice: ffmpeg not found on PATH — wake word detection requires ffmpeg for audio capture.",
        ),
      ),
    ).toBe(true);
  });

  it("reports macOS say always available on darwin", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({ whisperPath: "/bin/whisper-cli" }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg" }, "darwin"),
    );
    expect(lines.some((l) => l.includes("[ok] Voice: macOS `say` is always available."))).toBe(
      true,
    );
  });

  it("reports Windows SAPI always available on win32", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({ whisperPath: "/bin/whisper-cli" }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg" }, "win32"),
    );
    expect(
      lines.some((l) => l.includes("[ok] Voice: Windows SAPI via PowerShell is always available.")),
    ).toBe(true);
  });

  it("reports espeak-ng on Linux when present", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({ whisperPath: "/bin/whisper-cli" }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg", "espeak-ng": "/usr/bin/espeak-ng" }, "linux"),
    );
    expect(lines.some((l) => l.includes("[ok] Voice: Linux TTS via espeak-ng."))).toBe(true);
  });

  it("falls back to spd-say on Linux when espeak-ng absent", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({ whisperPath: "/bin/whisper-cli" }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg", "spd-say": "/usr/bin/spd-say" }, "linux"),
    );
    expect(
      lines.some((l) => l.includes("[ok] Voice: Linux TTS via spd-say (espeak-ng preferred).")),
    ).toBe(true);
  });

  it("warns when neither espeak-ng nor spd-say found on Linux", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({ whisperPath: "/bin/whisper-cli" }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg" }, "linux"),
    );
    expect(
      lines.some((l) =>
        l.includes(
          "[warn] Voice: neither espeak-ng nor spd-say found on PATH — install one to enable TTS on Linux.",
        ),
      ),
    ).toBe(true);
  });

  it("emits no piper lines when piperPath and piperModel are both empty", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({ whisperPath: "/bin/whisper-cli" }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg", "espeak-ng": "/usr/bin/espeak-ng" }),
    );
    expect(lines.some((l) => l.includes("piper"))).toBe(false);
  });

  it("warns when piperPath is set but binary is not found (relative, not on PATH)", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({
        whisperPath: "/bin/whisper-cli",
        piperPath: "piper",
        piperModel: "/m.onnx",
      }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg", "espeak-ng": "/usr/bin/espeak-ng" }),
    );
    expect(
      lines.some((l) =>
        l.includes("[warn] Voice: piper_path is set but the binary was not found:"),
      ),
    ).toBe(true);
  });

  it("does not warn about binary when piperPath contains a slash (absolute path)", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({
        whisperPath: "/bin/whisper-cli",
        piperPath: "/usr/local/bin/piper",
        piperModel: "/m.onnx",
      }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg", "espeak-ng": "/usr/bin/espeak-ng" }),
    );
    expect(
      lines.some((l) => l.includes("[warn] Voice: piper_path is set but the binary was not found")),
    ).toBe(false);
  });

  it("warns when piperPath is set but piperModel is empty", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({
        whisperPath: "/bin/whisper-cli",
        piperPath: "/usr/local/bin/piper",
        piperModel: "",
      }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg", "espeak-ng": "/usr/bin/espeak-ng" }),
    );
    expect(
      lines.some((l) =>
        l.includes(
          "[warn] Voice: piper_path is set but piper_model is empty — Piper TTS will not run.",
        ),
      ),
    ).toBe(true);
  });

  it("emits no warnings when piperPath is absolute and piperModel is set", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({
        whisperPath: "/bin/whisper-cli",
        piperPath: "/usr/local/bin/piper",
        piperModel: "/m.onnx",
      }),
      makeEnv({ ffmpeg: "/usr/bin/ffmpeg", "espeak-ng": "/usr/bin/espeak-ng" }),
    );
    expect(lines.some((l) => l.includes("piper"))).toBe(false);
  });

  it("finds piper via which() when piperPath is a bare binary name on PATH", () => {
    const lines = doctorVoiceLines(
      makeVoiceCfg({
        whisperPath: "/bin/whisper-cli",
        piperPath: "piper",
        piperModel: "/m.onnx",
      }),
      makeEnv({
        ffmpeg: "/usr/bin/ffmpeg",
        "espeak-ng": "/usr/bin/espeak-ng",
        piper: "/usr/local/bin/piper",
      }),
    );
    expect(lines.some((l) => l.includes("[warn] Voice: piper_path is set but the binary"))).toBe(
      false,
    );
  });
});
