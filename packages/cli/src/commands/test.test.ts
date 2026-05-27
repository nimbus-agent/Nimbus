// packages/cli/src/commands/test.test.ts
//
// Unit tests for the `nimbus test` connector-contract runner. We test the
// pure parser + manifest loader + package.json script discovery layers;
// the actual `bun test` subprocess spawn is NOT exercised (that path is
// covered structurally — when `getTestScript` returns `undefined`, the
// dispatcher skips it altogether, which the dispatcher test relies on by
// omitting a `scripts.test` entry).

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";

const mod = await import("./test.ts");
const { MANIFEST, getTestScript, loadAndValidateManifest, parseTestArgs, runTest } = mod;

// Capture individual exports before any mock.module call so the afterEach
// restore can re-install the original functions even after mock.module mutates
// the namespace object's live bindings in place (Bun behaviour).
const realChildProcessMod = await import("node:child_process");
const realSpawn = realChildProcessMod.spawn;
const realExecFile = realChildProcessMod.execFile;
const realExec = realChildProcessMod.exec;
const realFork = realChildProcessMod.fork;
const realSpawnSync = realChildProcessMod.spawnSync;
const realExecFileSync = realChildProcessMod.execFileSync;
const realExecSync = realChildProcessMod.execSync;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("parseTestArgs", () => {
  it("uses cwd when no root arg supplied", () => {
    expect(parseTestArgs([], "/some/cwd")).toEqual({ root: "/some/cwd" });
  });
  it("uses the explicit root arg when given", () => {
    expect(parseTestArgs(["/path/to/ext"], "/cwd")).toEqual({ root: "/path/to/ext" });
  });
  it("trims whitespace around root arg", () => {
    expect(parseTestArgs(["  /trimmed  "], "/cwd")).toEqual({ root: "/trimmed" });
  });
  it("falls back to cwd when root arg is empty", () => {
    expect(parseTestArgs([""], "/cwd")).toEqual({ root: "/cwd" });
  });
});

describe("loadAndValidateManifest + getTestScript (filesystem)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-test-runner-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadAndValidateManifest throws when manifest is missing", () => {
    expect(() => loadAndValidateManifest(tmpDir)).toThrow(/No nimbus\.extension\.json in/);
  });

  it("loadAndValidateManifest throws on invalid JSON", () => {
    writeFileSync(join(tmpDir, MANIFEST), "{ not valid", "utf8");
    expect(() => loadAndValidateManifest(tmpDir)).toThrow(/Invalid JSON/);
  });

  it("loadAndValidateManifest throws when manifest root is an array", () => {
    writeFileSync(join(tmpDir, MANIFEST), JSON.stringify([]), "utf8");
    expect(() => loadAndValidateManifest(tmpDir)).toThrow(/Invalid manifest root/);
  });

  it("loadAndValidateManifest throws when manifest root is null", () => {
    writeFileSync(join(tmpDir, MANIFEST), "null", "utf8");
    expect(() => loadAndValidateManifest(tmpDir)).toThrow(/Invalid manifest root/);
  });

  it("loadAndValidateManifest returns the parsed object when valid", () => {
    const manifest = { id: "x", version: "0.0.1" };
    writeFileSync(join(tmpDir, MANIFEST), JSON.stringify(manifest), "utf8");
    const parsed = loadAndValidateManifest(tmpDir) as unknown as Record<string, unknown>;
    expect(parsed["id"]).toBe("x");
    expect(parsed["version"]).toBe("0.0.1");
  });

  it("getTestScript returns undefined when package.json is missing", () => {
    expect(getTestScript(join(tmpDir, "package.json"))).toBeUndefined();
  });

  it("getTestScript returns undefined for malformed JSON", () => {
    writeFileSync(join(tmpDir, "package.json"), "not json", "utf8");
    expect(getTestScript(join(tmpDir, "package.json"))).toBeUndefined();
  });

  it("getTestScript returns undefined when scripts is missing", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "x" }), "utf8");
    expect(getTestScript(join(tmpDir, "package.json"))).toBeUndefined();
  });

  it("getTestScript returns undefined when scripts.test is missing", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } }),
      "utf8",
    );
    expect(getTestScript(join(tmpDir, "package.json"))).toBeUndefined();
  });

  it("getTestScript returns undefined when scripts.test is empty string", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "  " } }),
      "utf8",
    );
    expect(getTestScript(join(tmpDir, "package.json"))).toBeUndefined();
  });

  it("getTestScript returns the script when defined + non-empty", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
      "utf8",
    );
    expect(getTestScript(join(tmpDir, "package.json"))).toBe("bun test");
  });

  it("getTestScript returns undefined when scripts is an array (not object)", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ scripts: ["test"] }), "utf8");
    expect(getTestScript(join(tmpDir, "package.json"))).toBeUndefined();
  });
});

describe("runTest dispatcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    out.reset();
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-test-dispatch-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when manifest is missing", async () => {
    await expect(runTest([tmpDir])).rejects.toThrow(/No nimbus\.extension\.json/);
  });

  it("runs contract checks + prints OK when manifest valid and no package.json present", async () => {
    // A full-shape manifest the SDK contract test will accept (all
    // `isNonEmptyString` fields populated + valid runtime + permissions
    // array + semver minNimbusVersion).
    const manifest = {
      id: "com.test.extension",
      displayName: "test ext",
      version: "0.1.0",
      description: "Test extension for runTest dispatcher unit test",
      author: "tester",
      entrypoint: "dist/index.js",
      runtime: "bun" as const,
      permissions: ["read" as const],
      hitlRequired: [],
      minNimbusVersion: "0.1.0",
    };
    writeFileSync(join(tmpDir, MANIFEST), JSON.stringify(manifest), "utf8");
    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    await runTest([tmpDir]);
    expect(out.stdout).toContain("Extension contract OK");
  });
});

describe("runTest spawn path (mocked node:child_process)", () => {
  let tmpDir: string;

  const FULL_MANIFEST = {
    id: "com.test.extension",
    displayName: "test ext",
    version: "0.1.0",
    description: "Test extension for runTest spawn path",
    author: "tester",
    entrypoint: "dist/index.js",
    runtime: "bun" as const,
    permissions: ["read" as const],
    hitlRequired: [],
    minNimbusVersion: "0.1.0",
  };

  beforeEach(() => {
    out.reset();
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-test-spawn-"));
    writeFileSync(join(tmpDir, MANIFEST), JSON.stringify(FULL_MANIFEST), "utf8");
    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
      "utf8",
    );
  });
  afterEach(() => {
    // Restore using captured function refs — not the namespace object — because
    // mock.module mutates the namespace's live bindings in place (Bun behaviour).
    mock.module("node:child_process", () => ({
      spawn: realSpawn,
      execFile: realExecFile,
      exec: realExec,
      fork: realFork,
      spawnSync: realSpawnSync,
      execFileSync: realExecFileSync,
      execSync: realExecSync,
    }));
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function mockSpawnEmitting(event: "close" | "error", arg: number | Error): void {
    mock.module("node:child_process", () => ({
      spawn: (): EventEmitter => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit(event, arg));
        return child;
      },
      execFile: realExecFile,
      exec: realExec,
      fork: realFork,
      spawnSync: realSpawnSync,
      execFileSync: realExecFileSync,
      execSync: realExecSync,
    }));
  }

  it("resolves + prints OK when the test subprocess exits 0", async () => {
    mockSpawnEmitting("close", 0);
    await runTest([tmpDir]);
    expect(out.stdout).toContain("Extension contract OK");
  });

  it("rejects when the test subprocess exits non-zero", async () => {
    mockSpawnEmitting("close", 1);
    await expect(runTest([tmpDir])).rejects.toThrow(/exited with code 1/);
  });

  it("rejects when the test subprocess errors", async () => {
    mockSpawnEmitting("error", new Error("spawn failed"));
    await expect(runTest([tmpDir])).rejects.toThrow(/spawn failed/);
  });
});
