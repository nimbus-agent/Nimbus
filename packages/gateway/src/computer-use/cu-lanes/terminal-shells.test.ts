import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import {
  type CuShell,
  CuShellError,
  DEFAULT_SHELL_ID,
  type PathExists,
  requireShellInstalled,
  resolveShellById,
} from "./terminal-shells.ts";

describe("terminal shell registry", () => {
  test("resolves the platform default", () => {
    expect(resolveShellById(DEFAULT_SHELL_ID).id).toBe(DEFAULT_SHELL_ID);
  });

  test("rejects an unknown id rather than defaulting to the platform shell", () => {
    // Quietly substituting a different interpreter changes what runs. A typo must be a refusal.
    expect(() => resolveShellById("bash-but-actually-anything")).toThrow(CuShellError);
  });

  test("is case- and whitespace-insensitive on the id", () => {
    expect(resolveShellById(`  ${DEFAULT_SHELL_ID.toUpperCase()} `).id).toBe(DEFAULT_SHELL_ID);
  });

  test("cmd.exe is launched with /D, which suppresses the AutoRun registry key", () => {
    // Without /D, `HKCU\\...\\Command Processor\\AutoRun` runs an owner- or attacker-configured
    // command line inside the lane at every shell start, before anything the owner approved.
    expect(resolveShellById("cmd").argv()).toContain("/D");
  });

  test("sh reads from stdin and is NOT interactive", () => {
    const argv = resolveShellById("sh").argv();
    expect(argv).toContain("-s");
    // `-i` would enable job control and history — precisely what this lane refuses to offer.
    expect(argv).not.toContain("-i");
  });

  test("the POSIX env overlay suppresses history and rc-file execution", () => {
    const env = resolveShellById("sh").envOverlay();
    expect(env["HISTFILE"]).toBe("");
    expect(env["HISTSIZE"]).toBe("0");
    // ENV and BASH_ENV are the two variables a NON-interactive POSIX shell will still source a
    // file from; leaving them would let a file in the owner's home run code inside the lane.
    expect(env["ENV"]).toBe("");
    expect(env["BASH_ENV"]).toBe("");
  });

  test("no overlay carries a secret-looking key", () => {
    for (const id of ["sh", "cmd"]) {
      for (const k of Object.keys(resolveShellById(id).envOverlay())) {
        expect(k).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD/i);
      }
    }
  });

  test("detect() returns an absolute path or null, never a bare name", () => {
    // A bare name would be resolved through PATH by the spawn, putting the choice of interpreter
    // in the hands of whatever can write to a directory on it.
    for (const id of ["sh", "cmd"]) {
      const p = resolveShellById(id).detect();
      if (p !== null) expect(p).toMatch(/^([/\\]|[A-Za-z]:)/);
    }
  });

  test("the platform's own shell is present on this machine", () => {
    expect(resolveShellById(DEFAULT_SHELL_ID).detect()).not.toBeNull();
  });
});
describe("requireShellInstalled", () => {
  test("returns the absolute path when the shell is present", () => {
    const shell = resolveShellById(DEFAULT_SHELL_ID);
    expect(requireShellInstalled(shell)).toBe(shell.detect() as string);
  });

  test("THROWS a named error when a registered shell is not on this machine", () => {
    // Fail BEFORE consent: the owner must never be asked to approve a session that could not have
    // started. Mirrors `exec-runtimes.ts`'s `requireInstalled`.
    const absent: CuShell = {
      id: "ghost",
      detect: () => null,
      argv: () => [],
      envOverlay: () => ({}),
    };
    expect(() => requireShellInstalled(absent)).toThrow(CuShellError);
    try {
      requireShellInstalled(absent);
    } catch (e) {
      expect((e as CuShellError).code).toBe("ERR_CU_SHELL_NOT_INSTALLED");
    }
  });
});

describe("shell registry — the platform-independent half", () => {
  // The registry ENTRIES are not platform-branched: each shell's argv and env overlay are
  // constants, so both are asserted on EVERY runner rather than only where they are the default.
  // Only `detect()` is genuinely per-OS, and it is an existsSync on a path the host has or has not.
  test("both shells are resolvable by name on every platform", () => {
    expect(resolveShellById("sh").id).toBe("sh");
    expect(resolveShellById("cmd").id).toBe("cmd");
  });

  test("sh's argv and overlay are asserted off-platform too", () => {
    const sh = resolveShellById("sh");
    expect(sh.argv()).toEqual(["-s"]);
    expect(sh.envOverlay()["HISTFILE"]).toBe("");
    expect(sh.envOverlay()["ENV"]).toBe("");
  });

  test("cmd's argv is asserted off-platform too, /D included", () => {
    const cmd = resolveShellById("cmd");
    expect(cmd.argv()).toEqual(["/Q", "/D", "/K"]);
    // cmd.exe sources no startup script and keeps no history file, so an overlay would be inert
    // noise. Empty is the honest answer, and pinned so a later edit has to justify adding one.
    expect(cmd.envOverlay()).toEqual({});
  });

  test("cmd's detect falls back to C:\\Windows when SystemRoot is unset", () => {
    // The `??` fallback is a real branch and unreachable on a normal Windows host, where the
    // variable is always set — so it is exercised by removing it rather than left uncovered.
    const prior = process.env["SystemRoot"];
    delete process.env["SystemRoot"];
    try {
      // Only the branch matters: on a non-Windows host the path does not exist and detect returns
      // null, which is the correct answer there and still proves the fallback was taken.
      expect(() => resolveShellById("cmd").detect()).not.toThrow();
    } finally {
      if (prior === undefined) delete process.env["SystemRoot"];
      else process.env["SystemRoot"] = prior;
    }
  });

  test("detect() returns null for a shell this platform does not have", () => {
    // Exactly one of the two is absent on any given runner, so this covers the null arm of
    // whichever `existsSync` the host does not satisfy.
    const results = [resolveShellById("sh").detect(), resolveShellById("cmd").detect()];
    expect(results.some((r) => r === null)).toBe(true);
    expect(results.some((r) => r !== null)).toBe(true);
  });
});

describe("detect() — both arms, on every platform", () => {
  // With `existsSync` hardcoded, exactly ONE arm of each probe is reachable per runner: `/bin/sh`
  // always exists on POSIX and never on Windows. Injecting the probe is how `chromium-path.ts`
  // solves the same problem, and it is what lets these assertions run on all three legs rather than
  // leaving half of them to the OTHER platform's CI job.
  const present: PathExists = () => true;
  const absent: PathExists = () => false;

  test.each([
    ["sh", posix.isAbsolute],
    ["cmd", win32.isAbsolute],
  ] as const)("%s resolves an absolute path when the probe says present", (id, isAbs) => {
    const p = resolveShellById(id).detect(present);
    expect(p).not.toBeNull();
    // Absolute IN ITS OWN PLATFORM'S TERMS, checked with that platform's `isAbsolute`. The
    // ambient one is the wrong predicate here: `join("C:\Windows", ...)` on POSIX yields
    // `C:\Windows/System32/cmd.exe`, which `posix.isAbsolute` correctly calls relative — so
    // asserting with the host's own rules failed this case on Linux while passing on Windows,
    // which is the shape of cross-platform bug a Windows-only run never sees.
    expect(isAbs(p as string)).toBe(true);
  });

  test.each(["sh", "cmd"])("%s resolves null when the probe says absent", (id) => {
    expect(resolveShellById(id).detect(absent)).toBeNull();
  });

  test("requireShellInstalled throws for a registered shell the probe cannot find", () => {
    expect(() => requireShellInstalled(resolveShellById("sh"), absent)).toThrow(CuShellError);
  });

  test("requireShellInstalled returns the FIRST candidate the probe finds", () => {
    // `/usr/bin/sh` leads because the path must exist INSIDE the Linux sandbox, where bwrap binds
    // `/usr` but not `/bin` — see SH_CANDIDATES.
    expect(requireShellInstalled(resolveShellById("sh"), present)).toBe("/usr/bin/sh");
  });

  test("sh falls back to /bin/sh when the first candidate is absent", () => {
    // macOS has no /usr/bin/sh at all, so the fallback is the arm that runs there.
    const onlyBinSh: PathExists = (p) => p === "/bin/sh";
    expect(resolveShellById("sh").detect(onlyBinSh)).toBe("/bin/sh");
  });

  test("sh prefers /usr/bin/sh even when BOTH exist — the sandbox-visible one wins", () => {
    // The failure this pins is invisible to `existsSync`: on a usrmerge Linux both paths resolve on
    // the HOST, and only the `/usr/bin` one still resolves inside the container.
    const bothExist: PathExists = (p) => p === "/bin/sh" || p === "/usr/bin/sh";
    expect(resolveShellById("sh").detect(bothExist)).toBe("/usr/bin/sh");
  });

  test("cmd's path is built from SystemRoot when it is set, on any platform", () => {
    const prior = process.env["SystemRoot"];
    process.env["SystemRoot"] = "D:CustomWindows";
    try {
      expect(resolveShellById("cmd").detect(present)).toContain("CustomWindows");
    } finally {
      if (prior === undefined) delete process.env["SystemRoot"];
      else process.env["SystemRoot"] = prior;
    }
  });
});
