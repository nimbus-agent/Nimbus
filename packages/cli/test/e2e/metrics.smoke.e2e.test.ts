import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function emptyEnvOverrides(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "nimbus-no-gateway-metrics-"));
  return {
    LOCALAPPDATA: root,
    APPDATA: root,
    XDG_DATA_HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_RUNTIME_DIR: root,
    HOME: root,
  };
}

describe("nimbus metrics e2e (no-Gateway smoke)", () => {
  const cliEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

  test("metrics dora exits non-zero with 'Gateway is not running' when no gateway", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "metrics", "dora", "--service", "x"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...emptyEnvOverrides() },
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(stderr).toContain("Gateway is not running");
  });

  test("metrics with unknown subcommand exits non-zero with usage hint", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "metrics", "bogus"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...emptyEnvOverrides() },
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("usage: nimbus metrics dora");
  });

  test("metrics dora with no --service exits non-zero with usage hint", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "metrics", "dora"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...emptyEnvOverrides() },
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("usage: nimbus metrics dora");
  });

  test("help text mentions 'metrics' subcommand", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain("metrics");
  });
});
