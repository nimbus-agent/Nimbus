import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { NimbusCodeExecutionToml } from "../../../../src/config/nimbus-toml.ts";
import { runExecution } from "../../../../src/exec/exec-gate.ts";
import { runIndexedSchemaMigrations } from "../../../../src/index/migrations/runner.ts";
import { createSandboxRunner } from "../../../../src/platform/sandbox/sandbox-runner.ts";

/**
 * The Windows sandbox helper's ACE lifecycle, against the REAL helper and the REAL DACLs.
 *
 * The helper grants an AppContainer SID an ACE on every path a spawn needs and, before this suite
 * existed, never removed one — deleting the profile leaves the ACE behind as an unresolvable
 * `S-1-15-2-*` entry. A per-run policy id (`exec-<id>`) is a new SID every run, so each execution
 * left one more ACE on the runtime bin dir until `SetEntriesInAclW` refused (87) and every confined
 * spawn on the machine failed closed. Measured at 1366 ACEs on a development machine.
 *
 * The unit suites prove the gateway ASKS for a release; only this proves the release REMOVES the
 * ACE, on the directory that actually accumulated them.
 *
 * Same readiness guard as `exec-sandbox.test.ts`: a missing helper skips locally but FAILS on CI.
 */

const IS_WIN = process.platform === "win32";
const IS_CI = process.env["CI"] === "true";

const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");

// Point the runtime at the binary this suite checks for, BEFORE any runner is constructed (the probe
// result is captured at construction). See the matching note in exec-sandbox.test.ts.
if (IS_WIN && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}

const READY = IS_WIN && existsSync(WIN_HELPER);

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-ace-release-")));
const work = join(root, "work");
mkdirSync(work, { recursive: true });

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows handle race; harmless */
  }
});

/**
 * Explicit (non-inherited) app-container ACEs on `path`, read with `icacls`, which prints an
 * unresolvable SID verbatim and marks an inherited entry `(I)`. Inherited copies are excluded: they
 * belong to the parent's explicit ACE and disappear with it.
 */
function explicitAppContainerAces(path: string): string[] {
  const r = spawnSync("icacls", [path], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`icacls ${path} failed: ${r.stderr}`);
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => /S-1-15-2-[\d-]+:/.test(l) && !l.includes("(I)"))
    .map((l) => (/S-1-15-2-[\d-]+/.exec(l) as RegExpExecArray)[0]);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

const CONFIG: NimbusCodeExecutionToml = {
  enabled: true,
  maxWallClockMs: 30_000,
  maxOutputBytes: 64 * 1024,
  allowedRuntimes: ["bun"],
};

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  return db;
}

/** Runs one real execution; resolves with its outcome and the AppContainer profile it ran under. */
async function execReal(
  code: string,
  timeoutMs?: number,
): Promise<{ status: string; profile: string }> {
  const runner = await createSandboxRunner();
  const id = `acerel-${Math.floor(Math.random() * 1e9)}`;
  const out = await runExecution(
    { code, cwd: work, fsRead: [work], fsWrite: [work], ...(timeoutMs ? { timeoutMs } : {}) },
    {
      runner,
      config: CONFIG,
      enforced: { capabilitiesDisabled: new Set<string>() },
      requestApproval: async () => true,
      db: freshDb(),
      readFile: () => "",
      now: () => Date.now(),
      newId: () => id,
    },
  );
  // `exec-policy.ts` names the policy `exec-<executionId>`; `win32-argv.ts` prefixes the profile.
  return { status: out.status, profile: `nimbus-ext-exec-${id}` };
}

function helper(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(WIN_HELPER, args, { encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function profileRegistered(profile: string): boolean {
  return helper(["--list-profiles"]).stdout.split(/\r?\n/).includes(profile);
}

describe.skipIf(!IS_WIN || (!READY && !IS_CI))("Windows sandbox ACE release (real helper)", () => {
  if (IS_CI && !READY) {
    it("fails loudly instead of silently skipping when the helper is missing on CI", () => {
      expect(
        `win32-ace-release: CI precondition unmet — helper not found at ${WIN_HELPER}. A skip ` +
          "and a pass are indistinguishable in a CI summary; build it with " +
          "`bun run build:sandbox-helper:win32`.",
      ).toBeNull();
    });
    return;
  }

  // The runtime bin dir: the one path EVERY execution is granted, and the one that accumulated.
  const binDir = dirname(process.execPath);

  it("an execution's ACE exists while it runs and is gone after it exits", async () => {
    const baseline = explicitAppContainerAces(binDir).length;

    // A script that outlives several polls, so the grant is observable mid-run. Without seeing the
    // count RISE first, "back to baseline" would pass for a helper that never granted anything.
    const running = execReal("await new Promise((r) => setTimeout(r, 4000));");
    const rose = await waitFor(() => explicitAppContainerAces(binDir).length > baseline, 15_000);
    const out = await running;

    expect(out.status).toBe("ran");
    expect(rose).toBe(true);
    // The release is asynchronous (it runs from the child's exit event), so poll for it.
    expect(await waitFor(() => explicitAppContainerAces(binDir).length === baseline, 20_000)).toBe(
      true,
    );
    // ...and the profile itself is deleted, after the revoke. Waited for rather than assumed: the
    // delete is the SECOND async step, and a process that exits the moment the ACE count recovers
    // would otherwise leave it registered.
    expect(await waitFor(() => !profileRegistered(out.profile), 20_000)).toBe(true);
  }, 90_000);

  it("a KILLED execution releases too — the path a helper-side cleanup would have missed", async () => {
    // A wall-clock kill terminates the helper process itself (TerminateProcess), so nothing the
    // helper might run after its own wait ever happens. The gateway-side release must still fire.
    const baseline = explicitAppContainerAces(binDir).length;
    const outs: Array<{ status: string; profile: string }> = [];
    for (let i = 0; i < 3; i++) {
      outs.push(await execReal("for (;;) {}", 1_500));
    }
    expect(outs.map((o) => o.status)).toEqual(["ran", "ran", "ran"]);
    expect(await waitFor(() => explicitAppContainerAces(binDir).length === baseline, 30_000)).toBe(
      true,
    );
    expect(await waitFor(() => outs.every((o) => !profileRegistered(o.profile)), 30_000)).toBe(
      true,
    );
  }, 120_000);

  it("the boot sweep removes an orphaned ACE and keeps a live profile's", () => {
    const dir = join(root, "sweep");
    mkdirSync(dir, { recursive: true });
    const tag = Math.floor(Math.random() * 1e9);
    const orphan = `nimbus-ext-acerel-orphan-${tag}`;
    const live = `nimbus-ext-acerel-live-${tag}`;
    const cmd = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe");

    try {
      for (const profile of [orphan, live]) {
        const r = helper([
          "--profile",
          profile,
          "--cwd",
          work,
          "--grant-read",
          dir,
          "--",
          cmd,
          "/c",
          "exit 0",
        ]);
        expect(r.status).toBe(0);
      }
      // Orphan it the way the boot reap does: delete the profile, which leaves its ACE behind.
      expect(helper(["--delete-profile", orphan]).status).toBe(0);
      expect(explicitAppContainerAces(dir)).toHaveLength(2);

      const swept = helper(["--sweep-orphaned-aces", dir]);
      expect(swept.status).toBe(0);
      expect(swept.stdout).toContain(`removed 1 ${dir}`);
      expect(explicitAppContainerAces(dir)).toHaveLength(1);

      // The survivor is the LIVE profile's: revoking that one profile empties the dir.
      expect(
        helper(["--revoke-grants", "--profile", live, "--path", dir, "--path", work]).status,
      ).toBe(0);
      expect(explicitAppContainerAces(dir)).toHaveLength(0);
    } finally {
      helper(["--revoke-grants", "--profile", orphan, "--path", dir, "--path", work]);
      helper(["--revoke-grants", "--profile", live, "--path", dir, "--path", work]);
      helper(["--delete-profile", live]);
    }
  }, 60_000);
});
