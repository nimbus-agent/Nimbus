import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The Windows sandbox helper serialises every DACL read-modify-write behind ONE per-session named
 * mutex (`Local\nimbus-sandbox-helper-dacl`, `src-native/sandbox-helper-win32/main.c`), so a grant
 * cannot write back a DACL it read before a concurrent revoke (B4b review finding 3).
 *
 * The test holds that mutex itself (kernel32 through `bun:ffi`), starts a REAL helper revoke on a
 * temp path, proves the helper is still waiting while the mutex is held, then releases it and
 * proves the revoke completes. A control run with the mutex free completes at once, so the wait was
 * the lock and not a slow helper.
 *
 * Windows only by nature: the mutex and the helper exist only there. Same readiness guard as
 * `exec-sandbox.test.ts`: a missing helper skips locally but FAILS on CI.
 */

const IS_WIN = process.platform === "win32";
const IS_CI = process.env["CI"] === "true";

const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
const READY = IS_WIN && existsSync(WIN_HELPER);

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-dacl-lock-")));
const target = join(root, "target");
mkdirSync(target, { recursive: true });

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows handle race; harmless */
  }
});

const REVOKE = ["--revoke-grants", "--profile", "nimbus-ext-test.dacl-lock", "--path", target];

function startRevoke(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([WIN_HELPER, ...REVOKE], {
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  });
}

async function exitWithin(
  p: ReturnType<typeof Bun.spawn>,
  ms: number,
): Promise<number | "running"> {
  const timer = new Promise<"running">((r) => setTimeout(() => r("running"), ms));
  return Promise.race([p.exited, timer]);
}

describe.skipIf(!IS_WIN)("the helper's DACL lock (Windows)", () => {
  it("the helper is present on CI (a missing helper must not read as a pass)", () => {
    if (IS_CI) expect(existsSync(WIN_HELPER)).toBe(true);
  });

  it.skipIf(!READY)(
    "a revoke waits while another holder has the DACL lock, and completes once it is released",
    async () => {
      // Control: with the lock free, the same revoke finishes promptly and succeeds.
      expect(await exitWithin(startRevoke(), 15_000)).toBe(0);

      const { dlopen, FFIType, ptr } = await import("bun:ffi");
      const k32 = dlopen("kernel32.dll", {
        CreateMutexW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
        ReleaseMutex: { args: [FFIType.ptr], returns: FFIType.i32 },
        CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      });
      const name = Buffer.from("Local\\nimbus-sandbox-helper-dacl\0", "utf16le");
      // Initial owner: this thread holds the lock from the moment the mutex exists.
      const h = k32.symbols.CreateMutexW(null, 1, ptr(name));
      expect(h).not.toBeNull();
      try {
        const p = startRevoke();
        // A spawn's GRANT waits on the same lock (it rewrites the cwd's DACL before any child runs).
        const g = Bun.spawn(
          [
            WIN_HELPER,
            "--profile",
            "nimbus-ext-test.dacl-lock",
            "--cwd",
            target,
            "--grant-write",
            target,
            "--",
            "cmd.exe",
            "/c",
            "exit 0",
          ],
          { stdout: "ignore", stderr: "ignore", windowsHide: true },
        );
        expect(await exitWithin(p, 2_000)).toBe("running");
        expect(await exitWithin(g, 10)).toBe("running");
        expect(k32.symbols.ReleaseMutex(h)).not.toBe(0);
        expect(await exitWithin(p, 15_000)).toBe(0);
        // Once released the grant proceeds (its child's own exit code is not the point here).
        expect(await exitWithin(g, 15_000)).not.toBe("running");
        await Bun.spawn([WIN_HELPER, ...REVOKE], { stdout: "ignore", windowsHide: true }).exited;
        await Bun.spawn([WIN_HELPER, "--delete-profile", "nimbus-ext-test.dacl-lock"], {
          stdout: "ignore",
          windowsHide: true,
        }).exited;
      } finally {
        k32.symbols.CloseHandle(h);
        k32.close();
      }
    },
  );
});
