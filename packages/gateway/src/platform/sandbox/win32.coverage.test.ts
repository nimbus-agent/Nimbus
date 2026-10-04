/**
 * The grant-RELEASE wiring of `createWin32SandboxRunner().spawn` — the one arm `win32.test.ts`
 * leaves open: with `releaseGrantsOnExit`, the runner must run the helper twice more after the
 * child exits — revoke the ACEs it granted, then delete the AppContainer profile — against the
 * SAME canonicalised paths the grant used.
 *
 * Same reasoning as `win32.test.ts`: nothing here needs Windows, only an executable stand-in at
 * `NIMBUS_SANDBOX_HELPER_PATH`, so the case is skipped on WINDOWS (where a POSIX shell script is
 * not executable) and runs on the Linux and macOS legs. The real helper is never involved. The
 * stand-in logs each invocation to a file whose path is baked into the script, because the release
 * runs inherit the GATEWAY's environment, not the child's.
 *
 * The paths handed to the runner are SYMLINKS, so canonicalisation changes their spelling on every
 * POSIX host. With plain temp paths the raw and canonical spellings are identical on Linux (only
 * macOS's `/var` -> `/private/var` differs), and a runner that revoked the raw spelling instead of
 * the canonical one the grant used would pass there unnoticed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalPath } from "./canonical-path.ts";
import { createWin32SandboxRunner } from "./win32.ts";

const HELPER_ENV = "NIMBUS_SANDBOX_HELPER_PATH";

let tmp: string;
let priorHelper: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-sandbox-win32-release-"));
  priorHelper = process.env[HELPER_ENV];
});

afterEach(() => {
  if (priorHelper === undefined) delete process.env[HELPER_ENV];
  else process.env[HELPER_ENV] = priorHelper;
  rmSync(tmp, { recursive: true, force: true });
});

/** Reads the call log, waiting (bounded) until it holds `count` lines. */
async function logLines(log: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    if (lines.length >= count || Date.now() > deadline) return lines;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Installs the logging stand-in. Every non-probe invocation appends its argv to `log`; an
 * invocation whose first argument is `failOn` is logged and then exits 3, like a real helper
 * whose ACL edit failed.
 */
function installLoggingHelper(log: string, failOn?: string): void {
  const helper = join(tmp, "fake-sandbox-helper");
  writeFileSync(
    helper,
    [
      "#!/bin/sh",
      'if [ "$1" = "--check-caps" ]; then echo OK; exit 0; fi',
      `printf '%s\\n' "$*" >> '${log}'`,
      failOn === undefined ? "" : `if [ "$1" = "${failOn}" ]; then exit 3; fi`,
      "exit 0",
    ].join("\n"),
  );
  chmodSync(helper, 0o755);
  process.env[HELPER_ENV] = helper;
}

/** Spawns one released child through the runner and waits for the CHILD (not the release). */
async function spawnReleasedChild(read: readonly string[], cwd: string): Promise<void> {
  const runner = createWin32SandboxRunner();
  expect(runner.isFullyActive()).toBe(true);
  const child = runner.spawn("child-cmd", ["--flag"], {
    policy: {
      id: "release-probe",
      permissions: { network: [], filesystem: { read: [...read], write: [] } },
    },
    env: { PATH: process.env["PATH"] ?? "" },
    cwd,
    releaseGrantsOnExit: true,
  });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

/** Creates the directory `target` and returns a symlink to it named `name`, beside it in `tmp`. */
function dirBehindLink(target: string, name: string): string {
  mkdirSync(target);
  const link = join(tmp, name);
  symlinkSync(target, link);
  return link;
}

describe("createWin32SandboxRunner — grants are released when the child exits", () => {
  it.skipIf(process.platform === "win32")(
    "grants and then revokes the SAME canonical spellings, cwd first and once each, then deletes the profile",
    async () => {
      const log = join(tmp, "calls.log");
      installLoggingHelper(log);
      const cwdLink = dirBehindLink(join(tmp, "ext-cwd"), "ext-cwd-link");
      const readLink = dirBehindLink(join(tmp, "shared-read"), "shared-read-link");
      const cwd = canonicalPath(cwdLink);
      const readDir = canonicalPath(readLink);
      // Premise, checked rather than assumed: canonicalisation really changes both spellings, so
      // the assertions below can tell the canonical form from the one the caller passed.
      expect(cwd).not.toBe(cwdLink);
      expect(readDir).not.toBe(readLink);

      // The read list names the cwd AGAIN (through its link), so the revoke has a duplicate to drop.
      await spawnReleasedChild([readLink, cwdLink], cwdLink);

      expect(await logLines(log, 3)).toEqual([
        // 1. The spawn: the grant, over the canonical spellings, then the child after `--`.
        [
          "--profile",
          "nimbus-ext-release-probe",
          "--cwd",
          cwd,
          "--grant-read",
          readDir,
          "--grant-read",
          cwd,
          "--",
          "child-cmd",
          "--flag",
        ].join(" "),
        // 2. The revoke, over the SAME spellings the grant used: cwd first, each path once.
        [
          "--revoke-grants",
          "--profile",
          "nimbus-ext-release-probe",
          "--path",
          cwd,
          "--path",
          readDir,
        ].join(" "),
        // 3. Then the per-run profile is deleted.
        "--delete-profile nimbus-ext-release-probe",
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "a revoke the helper FAILS still goes on to delete the profile, and nothing escapes as a rejection",
    async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const log = join(tmp, "calls.log");
        installLoggingHelper(log, "--revoke-grants");
        const cwd = join(tmp, "ext-cwd");
        const readDir = join(tmp, "shared-read");
        mkdirSync(cwd);
        mkdirSync(readDir);

        await spawnReleasedChild([readDir], cwd);

        // The release runs from an exit listener nobody awaits: a non-zero helper exit must be
        // absorbed there (best-effort), and must not stop the profile deletion that follows it.
        const lines = await logLines(log, 3);
        expect(lines.map((l) => l.split(" ")[0])).toEqual([
          "--profile",
          "--revoke-grants",
          "--delete-profile",
        ]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        // Filtered to the helper's own failure, so unrelated work in a shared test process
        // cannot flake this.
        const ours = unhandled.filter((r) => String(r).includes("fake-sandbox-helper"));
        expect(ours).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );
});
