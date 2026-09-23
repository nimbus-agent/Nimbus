import { afterAll, describe, expect, test } from "bun:test";
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

// A cold `bun run` of the CLI entry (transpile + module graph load) can take several
// seconds on a loaded CI runner — notably Windows, where this file's first spawn is
// the cold one. Generous headroom, and each test declares a timeout ABOVE it so the
// deadline can fire and be reported by name before bun:test gives up on the test.
const SPAWN_DEADLINE_MS = 30_000;
const TEST_TIMEOUT_MS = 45_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

// Spawned asynchronously with an explicit deadline, NOT `spawnSync({ timeout })`.
//
// On the Windows push leg the FIRST spawn in this file intermittently failed with
// `spawnSync <bun.exe> ETIMEDOUT` about 10 ms in — on both attempts of `main` runs
// 35623124409, 35880499482 and 35883179641, while the two later spawns in the same
// file passed every time, on the same Bun 1.3.14 the green runs around them used.
// Two mechanisms produce that exact error object and nothing on it tells them apart:
// Bun's own spawnSync deadline, and libuv translating a Windows `ERROR_SEM_TIMEOUT`
// from stdio pipe setup into `UV_ETIMEDOUT`. An async spawn takes the sync-deadline
// path out of the picture entirely, and leaves a pipe-setup failure as a THROWN spawn
// error that the first assertion below reports by name — so the next occurrence, if
// there is one, is attributable rather than a coin toss between the two. stdin is
// ignored rather than piped: nothing writes to it, and that is one fewer pipe to set up.
async function run(env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([BUN_EXECUTABLE, "run", CLI_ENTRY, "tui"], {
      env: { ...process.env, ...isolationEnv(), ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (e) {
    return {
      code: -1,
      stdout: "",
      stderr: "",
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, SPAWN_DEADLINE_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    return {
      code,
      stdout,
      stderr,
      error: timedOut
        ? new Error(`nimbus tui did not exit within ${SPAWN_DEADLINE_MS} ms and was killed`)
        : undefined,
    };
  } finally {
    clearTimeout(deadline);
  }
}

describe("nimbus tui fallback behavior", () => {
  test(
    "TERM=dumb prints fallback notice and does not attempt Ink render",
    async () => {
      const { stdout, stderr, error } = await run({ TERM: "dumb" });
      // Surface a spawn failure or deadline explicitly rather than as an opaque empty-output assertion.
      expect(error).toBeUndefined();
      const combined = stdout + stderr;
      expect(combined.length).toBeGreaterThan(0);
      expect(combined).not.toContain("Sub-Tasks");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "non-TTY stdout falls back gracefully",
    async () => {
      const { stdout, stderr, error } = await run();
      expect(error).toBeUndefined();
      const combined = stdout + stderr;
      expect(combined).not.toContain("Sub-Tasks");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "CI=true prints fallback notice",
    async () => {
      const { stdout, stderr, error } = await run({ CI: "true" });
      expect(error).toBeUndefined();
      const combined = stdout + stderr;
      expect(combined).not.toContain("Sub-Tasks");
    },
    TEST_TIMEOUT_MS,
  );
});
