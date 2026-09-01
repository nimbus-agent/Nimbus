import { describe, expect, test } from "bun:test";
import { CuShellError, DEFAULT_SHELL_ID, resolveShellById } from "./terminal-shells.ts";

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
