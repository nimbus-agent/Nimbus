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

  async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...emptyEnvOverrides() },
    });
    const code = await proc.exited;
    return {
      code,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  }

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

  test("--rebuild without --yes fails only for want of a gateway, not for being unwired", async () => {
    // No gateway in the smoke env: --rebuild without --yes takes the preview
    // path (`withGatewayIpc` -> `readRebuildPreview`), which throws "Gateway
    // is not running" and the command's catch does `process.exit(2)` — the
    // same exit code `runAgentBriefCli`'s catch uses, per the comment in
    // `runGlossaryCommand`. The negative assertion is the point: it is what
    // the old, unwired CLI could never satisfy (it printed "not implemented").
    const out = await runCli(["glossary", "--rebuild"]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("Gateway is not running");
    expect(out.stderr).not.toContain("not implemented");
  });

  test("--refresh and --rebuild appear in the usage line", async () => {
    const out = await runCli(["glossary", "--help"]);
    const text = out.stdout + out.stderr;
    expect(text).toContain("--refresh");
    expect(text).toContain("--rebuild");
  });

  test("rejects --refresh combined with --rebuild before reaching the gateway", async () => {
    const out = await runCli(["glossary", "--refresh", "--rebuild"]);
    expect(out.stderr).toContain("cannot be combined");
    expect(out.stderr).not.toContain("Gateway is not running");
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
