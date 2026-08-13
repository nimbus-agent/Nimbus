import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
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
import type { FixKeyringDeps } from "./doctor-fix-keyring.ts";

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
};

function makeFixKeyringDeps(overrides: Partial<FixKeyringDeps> = {}): FixKeyringDeps {
  return {
    exec: {
      findSecretTool: () => "/usr/bin/secret-tool",
      lookupStderr: () => "",
      hasBinary: () => true,
      runQuery: () => ({ code: 0, stdout: "", stderr: "" }),
    },
    homeDir: () => "/home/tester",
    statMode: () => null,
    mkdirMode: () => {},
    writeFileMode: () => {},
    listDir: () => [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DoctorCoreDeps> = {}): DoctorCoreDeps {
  return {
    getCliPlatformPaths: (): CliPlatformPaths => FAKE_PATHS,
    readGatewayState: async (): Promise<DoctorGatewayState | undefined> => undefined,
    isProcessAlive: (): boolean => true,
    gatewayStatePath: (): string => join(FAKE_ROOT, "gateway.json"),
    makeClient: (): IPCClient => createMockIpcClient([]).client,
    fixKeyringDeps: makeFixKeyringDeps(),
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

describe("runDoctor --fix-keyring wiring", () => {
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

  it("plain `nimbus doctor` (no flags) never touches fixKeyringDeps", async () => {
    let statCalls = 0;
    let mkdirCalls = 0;
    let queryCalls = 0;
    await runDoctor(
      [],
      makeDeps({
        readGatewayState: async () => undefined,
        fixKeyringDeps: makeFixKeyringDeps({
          statMode: () => {
            statCalls += 1;
            return null;
          },
          mkdirMode: () => {
            mkdirCalls += 1;
          },
          exec: {
            findSecretTool: () => "/usr/bin/secret-tool",
            lookupStderr: () => "",
            hasBinary: () => true,
            runQuery: () => {
              queryCalls += 1;
              return { code: 0, stdout: "", stderr: "" };
            },
          },
        }),
      }),
    );
    // The plain diagnostic sweep ran (proves the flag branch was skipped, not
    // that runDoctor no-op'd for some other reason).
    expect(out.stdout).toContain("[fail] Gateway: not running");
    expect(statCalls).toBe(0);
    expect(mkdirCalls).toBe(0);
    expect(queryCalls).toBe(0);
  });

  // Real behaviour is Linux-only (`runFixKeyringCommand` short-circuits to
  // not-applicable elsewhere), so these assert on the host's real platform()
  // rather than hardcoding one OS — this suite runs on all three in CI.
  it("--fix-keyring replaces the diagnostic sweep and returns the fixer's exit code", async () => {
    await runDoctor(
      ["--fix-keyring"],
      makeDeps({
        fixKeyringDeps: makeFixKeyringDeps({
          statMode: (p) => (p.endsWith("login.keyring") ? 0o600 : null),
        }),
      }),
    );
    expect(out.stdout).not.toContain("Gateway:");
    if (platform() === "linux") {
      expect(out.stdout).toMatch(/already exists/i);
      expect(process.exitCode).not.toBe(0);
    } else {
      expect(out.stdout).toMatch(/not applicable/i);
      expect(process.exitCode).toBe(0);
    }
  });

  it("--fix-keyring --dry-run reports the plan without exit-2 refusal noise", async () => {
    await runDoctor(
      ["--fix-keyring", "--dry-run"],
      makeDeps({ fixKeyringDeps: makeFixKeyringDeps() }),
    );
    if (platform() === "linux") {
      expect(out.stdout).toMatch(/0700/);
    } else {
      expect(out.stdout).toMatch(/not applicable/i);
    }
    expect(process.exitCode).toBe(0);
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

// ---------------------------------------------------------------------------
// Additional branch coverage
// ---------------------------------------------------------------------------

describe("worstHealthSeverity — additional branches", () => {
  it("does not escalate from fail to warn when a degraded entry follows an error", () => {
    // After seeing "unauthenticated" worst="fail"; the "degraded" branch checks
    // `if (worst === "ok")` which is false, so worst stays "fail".
    const result = worstHealthSeverity([{ state: "unauthenticated" }, { state: "degraded" }]);
    expect(result).toBe("fail");
  });

  it("treats a non-string state as empty string (falls through to ok)", () => {
    // typeof r.state === "string" is false → st="" → no escalation
    const result = worstHealthSeverity([{ state: 42 }, { connectorId: "x" }]);
    expect(result).toBe("ok");
  });
});

describe("doctorPrintConfigValidation — additional branches", () => {
  beforeEach(() => {
    out.reset();
  });

  it("returns 2 and prints both warnings and errors when ok=false with warnings", () => {
    const code = doctorPrintConfigValidation({
      ok: false,
      errors: ["missing required field"],
      warnings: ["deprecated key used"],
    });
    expect(code).toBe(2);
    expect(out.stdout).toContain("[warn] Config: deprecated key used");
    expect(out.stdout).toContain("[fail] Config: missing required field");
  });
});

describe("doctorPrintIndexFromSnapshot — additional branches", () => {
  beforeEach(() => {
    out.reset();
  });

  it("returns 1 when snap has no index key at all", () => {
    expect(doctorPrintIndexFromSnapshot({})).toBe(1);
    expect(out.stdout).toContain("[warn] Index: zero items");
  });

  it("returns 1 when totalItems is a non-number string", () => {
    expect(doctorPrintIndexFromSnapshot({ index: { totalItems: "many" } })).toBe(1);
    expect(out.stdout).toContain("[warn] Index: zero items");
  });

  it("returns 1 when totalItems is Infinity (not finite)", () => {
    expect(doctorPrintIndexFromSnapshot({ index: { totalItems: Infinity } })).toBe(1);
    expect(out.stdout).toContain("[warn] Index: zero items");
  });

  it("returns 1 when totalItems is negative (Math.max floors to 0)", () => {
    expect(doctorPrintIndexFromSnapshot({ index: { totalItems: -5 } })).toBe(1);
    expect(out.stdout).toContain("[warn] Index: zero items");
  });
});

describe("doctorPrintHealthFromSnapshot — additional branches", () => {
  beforeEach(() => {
    out.reset();
  });

  it("treats undefined connectorHealth as empty (warns: none registered)", () => {
    expect(doctorPrintHealthFromSnapshot({})).toBe(1);
    expect(out.stdout).toContain("[warn] Connectors: none registered.");
  });

  it("treats a non-array connectorHealth value as empty", () => {
    expect(doctorPrintHealthFromSnapshot({ connectorHealth: "not-an-array" })).toBe(1);
    expect(out.stdout).toContain("[warn] Connectors: none registered.");
  });

  it("falls back to '?' for non-string connectorId and state", () => {
    const code = doctorPrintHealthFromSnapshot({
      connectorHealth: [{ connectorId: 99, state: null }],
    });
    // worst severity: state="" (non-string) → ok → return 0
    expect(code).toBe(0);
    expect(out.stdout).toContain("?: ?");
  });
});

describe("runDoctor — voice-line exit-code escalation (lines 184-186)", () => {
  // Create a temp dir with a nimbus.toml that enables voice but has no
  // binaries available, so doctorVoiceLines returns [warn] lines that
  // escalate the exit code.
  let voiceRoot: string;
  let voiceConfigDir: string;
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    out.reset();
    origExitCode = process.exitCode;
    process.exitCode = 0;
    voiceRoot = mkdtempSync(join(tmpdir(), "nimbus-doctor-voice-"));
    voiceConfigDir = join(voiceRoot, "config");
    mkdirSync(voiceConfigDir, { recursive: true });
  });

  afterEach(() => {
    process.exitCode = 0;
    if (origExitCode !== undefined) process.exitCode = origExitCode;
  });

  it("escalates exit to 1 via voice [warn] lines when toml enables voice with no binaries", async () => {
    // Write a nimbus.toml with [voice] enabled=true so loadVoiceConfigFromDir
    // reads it and produces warn lines (no whisper/ffmpeg/espeak in the env).
    writeFileSync(
      join(voiceConfigDir, "nimbus.toml"),
      [
        "[voice]",
        "enabled = true",
        'whisper_path = ""',
        'piper_path = ""',
        'piper_model = ""',
      ].join("\n"),
      "utf8",
    );

    const voicePaths: CliPlatformPaths = {
      configDir: voiceConfigDir,
      dataDir: join(voiceRoot, "data"),
      logDir: join(voiceRoot, "data", "logs"),
      socketPath: join(voiceRoot, "gateway.sock"),
      extensionsDir: join(voiceRoot, "data", "extensions"),
      tempDir: join(voiceRoot, "temp"),
    };

    await runDoctor(
      [],
      makeDeps({
        getCliPlatformPaths: () => voicePaths,
        gatewayStatePath: () => join(voiceRoot, "gateway.json"),
        readGatewayState: async () => undefined,
      }),
    );

    // Voice lines with no binaries produce [warn] messages that escalate exit.
    // The gateway is also absent (exit=2 from "[fail] Gateway: not running").
    expect(out.stdout).toContain("[fail] Gateway: not running");
    // Prove the voice branch actually ran (the absent gateway alone would escalate the
    // exit code, so assert a concrete [warn] Voice: line rather than just exitCode >= 1).
    expect(out.stdout).toMatch(/\[warn\] Voice:/);
    expect(process.exitCode).toBeGreaterThanOrEqual(1);
  });

  it("covers loadVoiceConfigFromDir: reads all voice keys from toml", async () => {
    // Write a nimbus.toml with all voice keys set; this exercises applyVoiceKey
    // for every branch (enabled, whisper_path, piper_path, piper_model) and
    // all parseVoiceTomlLines branches (comment stripping, section detection,
    // quoted values, unquoted values, skip non-voice sections).
    writeFileSync(
      join(voiceConfigDir, "nimbus.toml"),
      [
        "# top-level comment",
        "[llm]",
        'remote_model = "gpt-4"',
        "",
        "[voice]",
        "enabled = true",
        'whisper_path = "/usr/bin/whisper-cli"',
        'piper_path = "/usr/bin/piper"',
        'piper_model = "/models/en.onnx"',
        "",
        "[other]",
        "key = value",
      ].join("\n"),
      "utf8",
    );

    const voicePaths: CliPlatformPaths = {
      configDir: voiceConfigDir,
      dataDir: join(voiceRoot, "data"),
      logDir: join(voiceRoot, "data", "logs"),
      socketPath: join(voiceRoot, "gateway.sock"),
      extensionsDir: join(voiceRoot, "data", "extensions"),
      tempDir: join(voiceRoot, "temp"),
    };

    await runDoctor(
      [],
      makeDeps({
        getCliPlatformPaths: () => voicePaths,
        gatewayStatePath: () => join(voiceRoot, "gateway.json"),
        readGatewayState: async () => undefined,
      }),
    );

    // whisper_path is set so "[ok] Voice: whisper-cli is available." is printed.
    // piper has an absolute path so no piper-binary warning.
    // The exact TTS line depends on the test platform; we just verify it ran.
    expect(out.stdout).toContain("[ok] Voice: whisper-cli is available.");
    // ffmpeg may or may not be on PATH; just check the gateway line is present.
    expect(out.stdout).toContain("[fail] Gateway: not running");
  });

  it("covers parseVoiceTomlLines: inline comments, empty key (eq<=0), unquoted values", async () => {
    // Write a TOML variant with inline comments and an unquoted boolean,
    // plus a malformed line (no '=') that should be skipped.
    writeFileSync(
      join(voiceConfigDir, "nimbus.toml"),
      [
        "[voice]",
        "enabled = true # inline comment",
        "whisper_path = /absolute/path  # another comment",
        "bad-line-no-equals",
        'piper_path = ""',
        'piper_model = ""',
      ].join("\n"),
      "utf8",
    );

    const voicePaths: CliPlatformPaths = {
      configDir: voiceConfigDir,
      dataDir: join(voiceRoot, "data"),
      logDir: join(voiceRoot, "data", "logs"),
      socketPath: join(voiceRoot, "gateway.sock"),
      extensionsDir: join(voiceRoot, "data", "extensions"),
      tempDir: join(voiceRoot, "temp"),
    };

    await runDoctor(
      [],
      makeDeps({
        getCliPlatformPaths: () => voicePaths,
        gatewayStatePath: () => join(voiceRoot, "gateway.json"),
        readGatewayState: async () => undefined,
      }),
    );

    // whisper_path is set (unquoted absolute path parsed correctly) so whisper ok.
    expect(out.stdout).toContain("[ok] Voice: whisper-cli is available.");
  });
});
