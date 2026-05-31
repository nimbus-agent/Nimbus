import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

describe("nimbus deploy preflight e2e (no-Gateway smoke)", () => {
  const cliEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

  function emptyEnvOverrides(): Record<string, string> {
    const root = mkdtempSync(join(tmpdir(), "nimbus-no-gateway-"));
    return {
      LOCALAPPDATA: root,
      APPDATA: root,
      XDG_DATA_HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_RUNTIME_DIR: root,
      HOME: root,
    };
  }

  test("exits 2 with 'Gateway is not running' on stderr when no gateway", async () => {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        cliEntry,
        "deploy",
        "preflight",
        "--service",
        "payment-service",
        "--target-ref",
        "main",
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...emptyEnvOverrides() },
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).toBe(2);
    expect(stderr).toContain("Gateway is not running");
  });

  test("exits 1 on missing --service", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "deploy", "preflight", "--target-ref", "main"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...emptyEnvOverrides() },
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).toBe(1);
    expect(stderr).toMatch(/--service/);
  });

  test("exits 1 on unknown --mode value", async () => {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        cliEntry,
        "deploy",
        "preflight",
        "--service",
        "x",
        "--target-ref",
        "main",
        "--mode",
        "explode",
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...emptyEnvOverrides() },
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).toBe(1);
    expect(stderr).toMatch(/--mode/);
  });

  test("help text mentions 'deploy preflight'", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toContain("deploy preflight");
  });
});
