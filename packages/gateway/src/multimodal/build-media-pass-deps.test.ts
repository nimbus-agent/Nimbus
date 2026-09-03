// packages/gateway/src/multimodal/build-media-pass-deps.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { GpuArbiter } from "../llm/gpu-arbiter.ts";
import {
  buildMediaPassDeps,
  resolveMediaRoots,
  resolveMultimodalEnabled,
  withTranscribeTimeout,
} from "./build-media-pass-deps.ts";

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

describe("buildMediaPassDeps", () => {
  test("passes the configured roots through", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: ["/a", "/b"],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.roots).toEqual(["/a", "/b"]);
  });

  test("supplies an AV understander and none for image — PR 1 has no VLM", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.gate.sttFor("av")).toBeDefined();
    expect(deps.gate.sttFor("image")).toBeUndefined();
  });

  test("the AV understander declares itself LOCAL", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.gate.sttFor("av")?.isLocal).toBe(true);
  });

  test("propagates the disabled flags into the gate, so the gate refuses", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: false,
      capabilityDisabled: true,
      scratchDir: "/scratch",
    });
    expect(deps.gate.enabled).toBe(false);
    expect(deps.gate.capabilityDisabled).toBe(true);
  });

  test("wires a REAL touch() — without it a long transcription is evicted mid-run", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(typeof deps.gate.gpu.touch).toBe("function");
  });

  test("passes the scratch directory through, so the start-of-pass sweep runs", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.scratchDir).toBe("/scratch");
  });
});

describe("buildMediaPassDeps — optional overrides", () => {
  test("defaults maxBytes to 250 MB when not supplied", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.maxBytes).toBe(250 * 1024 * 1024);
  });

  test("honors an explicit maxBytes override", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
      maxBytes: 1024,
    });
    expect(deps.maxBytes).toBe(1024);
  });

  test("uses an injected GpuArbiter rather than constructing its own", async () => {
    const shared = new GpuArbiter();
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
      gpu: shared,
    });
    expect(deps.gate.gpu).toBeDefined();
    // Acquiring through the deps-exposed handle reaches the SAME arbiter instance we injected —
    // proven by observing the grant on `shared` directly rather than merely on the deps object.
    const release = await deps.gate.gpu.acquire("probe");
    expect(shared.currentProvider).toBe("probe");
    release();
    expect(shared.currentProvider).toBeNull();
  });

  test("passes an explicit whisperBin through to the STT provider construction", () => {
    // No assertion on internal wiring is possible without a real whisper binary; this exercises
    // the `input.whisperBin === undefined ? {} : {...}` branch so the defined-value arm is covered
    // and confirms construction does not throw when a custom binary path is supplied.
    expect(() =>
      buildMediaPassDeps({
        db: db(),
        roots: [],
        enabled: true,
        capabilityDisabled: false,
        scratchDir: "/scratch",
        whisperBin: "/usr/local/bin/whisper-cli",
      }),
    ).not.toThrow();
  });
});

describe("withTranscribeTimeout", () => {
  test("forwards the result when transcribe settles before the bound", async () => {
    const bounded = withTranscribeTimeout(async (wavPath) => ({ text: `heard:${wavPath}` }), 5000);
    await expect(bounded("/scratch/a.wav")).resolves.toEqual({ text: "heard:/scratch/a.wav" });
  });

  test("rejects with a clear error when transcribe never settles — bounded in MS, not minutes", async () => {
    const neverSettles = () => new Promise<{ text: string }>(() => undefined);
    const bounded = withTranscribeTimeout(neverSettles, 20);
    await expect(bounded("/scratch/wedged.wav")).rejects.toThrow(/timed out.*20ms/);
  });

  test("propagates a real transcribe rejection unchanged, not a timeout error", async () => {
    const bounded = withTranscribeTimeout(async () => {
      throw new Error("whisper-cli exited 1");
    }, 5000);
    await expect(bounded("/scratch/bad.wav")).rejects.toThrow("whisper-cli exited 1");
  });

  test("a late resolution after expiry does not throw an unhandled rejection", async () => {
    let releaseLate: (() => void) | undefined;
    const late = () =>
      new Promise<{ text: string }>((resolve) => {
        releaseLate = () => resolve({ text: "too late" });
      });
    const bounded = withTranscribeTimeout(late, 10);
    await expect(bounded("/scratch/late.wav")).rejects.toThrow(/timed out/);
    // Settling the underlying promise after the caller already saw the timeout must be inert.
    expect(() => releaseLate?.()).not.toThrow();
  });
});

describe("buildMediaPassDeps — transcribeTimeoutMs", () => {
  test("accepts an explicit transcribeTimeoutMs override without throwing", () => {
    expect(() =>
      buildMediaPassDeps({
        db: db(),
        roots: [],
        enabled: true,
        capabilityDisabled: false,
        scratchDir: "/scratch",
        transcribeTimeoutMs: 30_000,
      }),
    ).not.toThrow();
  });
});

describe("resolveMediaRoots", () => {
  test("returns an empty array with no configDir — the test/embedded shape", () => {
    expect(resolveMediaRoots(undefined)).toEqual([]);
  });

  test("returns an empty array when nimbus.toml is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-media-roots-"));
    try {
      expect(resolveMediaRoots(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps only roots with media_index = true, mapped to their path", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-media-roots-"));
    try {
      writeFileSync(
        join(dir, "nimbus.toml"),
        [
          "[[filesystem.roots]]",
          'path = "/media-yes"',
          "media_index = true",
          "",
          "[[filesystem.roots]]",
          'path = "/media-no"',
          "media_index = false",
        ].join("\n"),
      );
      const roots = resolveMediaRoots(dir);
      expect(roots).toEqual([resolve("/media-yes")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveMultimodalEnabled", () => {
  test("reads false with no configDir — the test/embedded shape", () => {
    expect(resolveMultimodalEnabled(undefined)).toBe(false);
  });

  test("reads false when nimbus.toml is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-enabled-"));
    try {
      expect(resolveMultimodalEnabled(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads false when [multimodal] section is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-enabled-"));
    try {
      writeFileSync(join(dir, "nimbus.toml"), '[other]\nfoo = "bar"\n');
      expect(resolveMultimodalEnabled(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads false when [multimodal] is present but 'enabled' key is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-enabled-"));
    try {
      writeFileSync(join(dir, "nimbus.toml"), "[multimodal]\nother_key = true\n");
      expect(resolveMultimodalEnabled(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads true for a literal 'true'", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-enabled-"));
    try {
      writeFileSync(join(dir, "nimbus.toml"), "[multimodal]\nenabled = true\n");
      expect(resolveMultimodalEnabled(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads false for an explicit 'false'", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-enabled-"));
    try {
      writeFileSync(join(dir, "nimbus.toml"), "[multimodal]\nenabled = false\n");
      expect(resolveMultimodalEnabled(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("honors an inline comment after the value", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-enabled-"));
    try {
      writeFileSync(join(dir, "nimbus.toml"), "[multimodal]\nenabled = true # turn on locally\n");
      expect(resolveMultimodalEnabled(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads false for a garbage (non-boolean) value", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-enabled-"));
    try {
      writeFileSync(join(dir, "nimbus.toml"), "[multimodal]\nenabled = maybe\n");
      expect(resolveMultimodalEnabled(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores an 'enabled' key found OUTSIDE the [multimodal] section", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-enabled-"));
    try {
      writeFileSync(join(dir, "nimbus.toml"), "[other]\nenabled = true\n\n[multimodal]\n");
      expect(resolveMultimodalEnabled(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads false when the file cannot be parsed as expected (readFileSync throws)", () => {
    // Point configDir at a location where nimbus.toml is actually a directory, so
    // existsSync() is true but readFileSync() throws — the catch-arm around parseMultimodalEnabled.
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-enabled-"));
    try {
      mkdirSync(join(dir, "nimbus.toml"));
      expect(resolveMultimodalEnabled(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
