// Real CLI subprocess, temp OS roots only (never the developer's real install). Proves what a
// unit test cannot: the file logger opens under the DEMO root, the flag is stripped before
// dispatch, refusals surface as messages, and the not-running hint names the demo gateway.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "nd-cli-"));
const dirs = {
  roaming: join(root, "r"),
  local: join(root, "l"),
  home: join(root, "h"),
  xdgConfig: join(root, "c"),
  xdgData: join(root, "d"),
  run: join(root, "u"),
  tmp: join(root, "t"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of ["NIMBUS_DEMO", "NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET", "NIMBUS_PROFILE"]) {
    delete env[k];
  }
  return {
    ...env,
    APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_RUNTIME_DIR: dirs.run,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    ...extra,
  };
}

/** The REAL data dir each OS would use under these temp roots (mirrors platform/paths). */
function realDataDir(): string {
  if (process.platform === "win32") return join(dirs.local, "Nimbus", "data");
  if (process.platform === "darwin") {
    return join(dirs.home, "Library", "Application Support", "Nimbus");
  }
  return join(dirs.xdgData, "nimbus");
}

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", cliEntry, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

afterAll(() => {
  try {
    // Retries are for the LEAK (issue #972), not for flakiness: a failure is already swallowed.
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* best effort — a Windows handle release can lag */
  }
});

describe("nimbus --demo (real CLI subprocess, temp roots)", () => {
  test("premise: the child resolves homedir() to the temp HOME (else every other assertion is about the REAL home)", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", "process.stdout.write(require('node:os').homedir())"],
      stdout: "pipe",
      env: baseEnv(),
    });
    const home = await new Response(proc.stdout).text();
    await proc.exited;
    expect(home).toBe(dirs.home);
  });

  test("--demo --version: version printed, CLI log under the DEMO logDir, real logDir never created", async () => {
    const r = await runCli(["--demo", "--version"], baseEnv());
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const demoLogs = join(realDataDir(), "demo", "data", "logs");
    expect(existsSync(demoLogs)).toBe(true);
    expect(readdirSync(demoLogs).some((f) => f.startsWith("cli-"))).toBe(true);
    expect(existsSync(join(realDataDir(), "logs"))).toBe(false);
  });

  test("--demo is stripped before dispatch: an unknown command is named, not '--demo'", async () => {
    const r = await runCli(["--demo", "no-such-command"], baseEnv());
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Unknown command: no-such-command");
    expect(r.stderr).not.toContain("Unknown command: --demo");
  });

  test("an ambiguous NIMBUS_DEMO value refuses with a message, exit 1", async () => {
    const r = await runCli(["--version"], baseEnv({ NIMBUS_DEMO: "true" }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("NIMBUS_DEMO must be 1 or unset");
  });

  test("--demo with NIMBUS_CONFIG_DIR refuses, naming the variable", async () => {
    const r = await runCli(["--demo", "--version"], baseEnv({ NIMBUS_CONFIG_DIR: dirs.tmp }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("NIMBUS_CONFIG_DIR");
  });

  test("with no demo gateway running, the hint names the DEMO gateway", async () => {
    const r = await runCli(["--demo", "catchup"], baseEnv());
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("nimbus --demo start");
  });
});
