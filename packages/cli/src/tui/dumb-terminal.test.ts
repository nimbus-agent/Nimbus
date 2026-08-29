import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "src", "index.ts");

const BUN_EXECUTABLE = process.execPath;

// `nimbus tui` (`commands/tui.tsx` `runTui`) reads the REAL gateway state file
// (`<dataDir>/gateway.json`, via `getCliPlatformPaths()` + `readGatewayState()`)
// BEFORE it ever inspects the terminal. `dataDir` has no env-var override —
// unlike `configDir`/`socketPath`, it is deliberately fixed in `paths.ts` ("this
// cannot silently repoint a live gateway's database or socket") — so a spawned
// CLI here, left pointed at the developer's real profile, finds whatever real
// gateway the developer happens to have running, takes the real-gateway branch
// instead of the terminal-fallback branch under test, and hangs against it
// (issue #1389: passes with no gateway running, fails/times out with one).
//
// Isolating every env var `getCliPlatformPaths()` derives a profile root from
// makes a real `gateway.json` structurally unreachable — never merely absent by
// chance — regardless of what is running on the host.
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "nimbus-tui-fallback-test-"));

afterAll(() => {
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

function isolationEnv(): NodeJS.ProcessEnv {
  return {
    // win32: getCliPlatformPaths() reads these two directly (and throws if unset).
    APPDATA: join(ISOLATED_HOME, "AppData", "Roaming"),
    LOCALAPPDATA: join(ISOLATED_HOME, "AppData", "Local"),
    // darwin/linux: getCliPlatformPaths() derives dataDir from homedir()/XDG_*.
    HOME: ISOLATED_HOME,
    XDG_CONFIG_HOME: join(ISOLATED_HOME, "config"),
    XDG_DATA_HOME: join(ISOLATED_HOME, "data"),
    // Belt-and-braces: even a code path that fell back to the default socket
    // must not find anything listening there either.
    NIMBUS_GATEWAY_SOCKET: join(ISOLATED_HOME, "unreachable-nimbus-gateway.sock"),
  };
}

function run(env: NodeJS.ProcessEnv = {}): {
  code: number;
  stdout: string;
  stderr: string;
  error: Error | undefined;
} {
  const result = spawnSync(BUN_EXECUTABLE, ["run", CLI_ENTRY, "tui"], {
    env: { ...process.env, ...isolationEnv(), ...env },
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    // A cold `bun run` of the CLI entry (transpile + module graph load) can exceed
    // a few seconds on a loaded CI runner — notably Windows, where this was the
    // first (cold) spawn in the file. A tight timeout killed the process before any
    // output, surfacing as a confusing `combined.length === 0` failure. Give it
    // generous headroom; each test runs a single spawn well within the suite timeout.
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

describe("nimbus tui fallback behavior", () => {
  test("TERM=dumb prints fallback notice and does not attempt Ink render", () => {
    const { stdout, stderr, error } = run({ TERM: "dumb" });
    // Surface a spawn timeout/error explicitly rather than as an opaque empty-output assertion.
    expect(error).toBeUndefined();
    const combined = stdout + stderr;
    expect(combined.length).toBeGreaterThan(0);
    expect(combined).not.toContain("Sub-Tasks");
  });

  test("non-TTY stdout falls back gracefully", () => {
    const { stdout, stderr } = run();
    const combined = stdout + stderr;
    expect(combined).not.toContain("Sub-Tasks");
  });

  test("CI=true prints fallback notice", () => {
    const { stdout, stderr } = run({ CI: "true" });
    const combined = stdout + stderr;
    expect(combined).not.toContain("Sub-Tasks");
  });
});
