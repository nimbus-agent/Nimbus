import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Subprocess-level smoke coverage for `nimbus glossary`, matching the sibling
 * `expert` / `impact` / `catchup` smoke tests: a real Bun process, a fresh temp
 * directory per case, and no gateway running.
 *
 * The in-process scenario test (`gateway/test/e2e/scenarios/glossary.e2e.test.ts`)
 * covers the extraction-to-brief path; this covers the CLI boundary that one
 * cannot reach — argument handling, stderr, and the exit code as a user sees them.
 */
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

describe("nimbus glossary e2e (no-Gateway smoke)", () => {
  const cliEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

  test("glossary exits non-zero with 'Gateway is not running' on stderr when no gateway", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "glossary", "CDR"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...emptyEnvOverrides() },
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(stderr).toContain("Gateway is not running");
  });

  test("--rebuild fails with an explicit not-implemented error, not a silent query", async () => {
    // Rejected during argument parsing, so this is deterministic without a
    // gateway — and it is the whole point of the flag change: the user must
    // never be told nothing when their requested operation did not run.
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "glossary", "--rebuild"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...emptyEnvOverrides() },
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(stderr).toContain("--rebuild is not implemented yet");
    expect(stderr).toContain("Nothing was rebuilt");
  });

  test("help text mentions 'glossary' subcommand", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain("glossary");
  });
});
