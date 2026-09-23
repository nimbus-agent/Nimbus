import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gatewayStatePath } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "src", "index.ts");

const BUN_EXECUTABLE = process.execPath;

// `nimbus tui` (`commands/tui.tsx` `runTui`) reads the gateway state file
// (`<dataDir>/gateway.json`, via `getCliPlatformPaths()` + `readGatewayState()`)
// BEFORE it ever inspects the terminal: no state file means "Gateway is not
// running", exit 1, and `detectFallbackReason` is never called. `dataDir` has no
// env-var override — unlike `configDir`/`socketPath`, it is deliberately fixed in
// `paths.ts` ("this cannot silently repoint a live gateway's database or socket")
// — so a spawned CLI left pointed at the developer's real profile finds whatever
// real gateway they happen to have running and hangs against it (issue #1389).
//
// Two things follow, and this file does both. Every env var `getCliPlatformPaths()`
// derives a profile root from is isolated, so the real profile is structurally
// unreachable. And the ISOLATED profile is given a `gateway.json` of its own,
// pointing at a socket nothing listens on: that is what lets `runTui` get PAST the
// state check to the terminal check under test, after which the REPL it falls back
// to fails fast on the dead socket (`connect ENOENT`) instead of hanging. Without
// the seeded file every test here passed without exercising the fallback at all.
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "nimbus-tui-fallback-test-"));
const UNREACHABLE_SOCKET = join(ISOLATED_HOME, "unreachable-nimbus-gateway.sock");

afterAll(() => {
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

function isolationEnv(): Record<string, string> {
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
    NIMBUS_GATEWAY_SOCKET: UNREACHABLE_SOCKET,
  };
}

/**
 * Resolve the isolated profile's paths THE WAY THE CHILD WILL — through the same
 * `getCliPlatformPaths()` under the same env — rather than re-deriving `dataDir`
 * by hand, which would drift from `paths.ts` the day its layout changed.
 */
function isolatedPaths(): ReturnType<typeof getCliPlatformPaths> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(isolationEnv())) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    return getCliPlatformPaths();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const paths = isolatedPaths();
mkdirSync(paths.dataDir, { recursive: true });
writeFileSync(
  gatewayStatePath(paths),
  JSON.stringify({ pid: 2_147_483_647, socketPath: UNREACHABLE_SOCKET }),
);

// A cold `bun run` of the CLI entry (transpile + module graph load) can take several
// seconds on a loaded CI runner — notably Windows, where this file's first spawn is
// the cold one. Generous headroom, and each test declares a timeout ABOVE it so the
// deadline can fire and be reported by name before bun:test gives up on the test.
const SPAWN_DEADLINE_MS = 30_000;
const TEST_TIMEOUT_MS = 45_000;

/** `printFallback` in `commands/tui.tsx`, verbatim. */
function fallbackNotice(reason: string): string {
  return `Unsuitable terminal detected (${reason}) — falling back to REPL.`;
}

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
async function run(overrides: Record<string, string> = {}): Promise<RunResult> {
  const env: Record<string, string | undefined> = { ...process.env, ...isolationEnv() };
  // The three inputs `detectFallbackReason` reads from the env are pinned, never
  // inherited: a developer's `NO_COLOR`, a runner's `CI=true` or an odd `TERM` would
  // otherwise change WHICH reason fires and make the assertions below host-dependent.
  delete env["NO_COLOR"];
  delete env["CI"];
  env["TERM"] = "xterm-256color";
  Object.assign(env, overrides);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([BUN_EXECUTABLE, "run", CLI_ENTRY, "tui"], {
      env,
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
    "TERM=dumb prints the fallback notice naming TERM=dumb and does not attempt Ink render",
    async () => {
      const { stdout, stderr, error } = await run({ TERM: "dumb" });
      // Surface a spawn failure or deadline explicitly rather than as an opaque empty-output assertion.
      expect(error).toBeUndefined();
      expect(stderr).toContain(fallbackNotice("TERM=dumb"));
      expect(stdout + stderr).not.toContain("Sub-Tasks");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "non-TTY stdout prints the fallback notice naming non-TTY",
    async () => {
      const { stdout, stderr, error } = await run();
      expect(error).toBeUndefined();
      expect(stderr).toContain(fallbackNotice("non-TTY"));
      expect(stdout + stderr).not.toContain("Sub-Tasks");
    },
    TEST_TIMEOUT_MS,
  );

  // `detectFallbackReason` checks `isTTY` BEFORE `CI`, and a spawned child's stdout is a
  // pipe, so from here the reason a `CI=true` run reports is always `non-TTY` — the
  // `CI=true` reason itself is reachable only on a real TTY, which this file cannot
  // provide, and is pinned by the unit test in `detect-fallback.test.ts`. What THIS test
  // proves is that `CI=true` still falls back rather than rendering Ink.
  test(
    "CI=true still falls back (reported as non-TTY, which precedes it through a pipe)",
    async () => {
      const { stdout, stderr, error } = await run({ CI: "true" });
      expect(error).toBeUndefined();
      expect(stderr).toContain(fallbackNotice("non-TTY"));
      expect(stdout + stderr).not.toContain("Sub-Tasks");
    },
    TEST_TIMEOUT_MS,
  );
});
