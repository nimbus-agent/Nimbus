import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import {
  ExecRuntimeError,
  requireInstalled,
  resolveRuntimeById,
  resolveRuntimeForFile,
} from "./exec-runtimes.ts";

describe("ExecRuntime registry", () => {
  test("resolves bun by id and produces an INLINE argv, never a script path", () => {
    const rt = resolveRuntimeById("bun");
    expect(rt.id).toBe("bun");
    const { cmd, args } = rt.argvFor('console.log("hi")');
    expect(cmd).not.toBe("");
    // `-e` and not a file. Naming a file as bun's ENTRY POINT fails under the Windows
    // AppContainer with CouldntReadCurrentDirectory, even though the same sandbox lets bun read,
    // list and dynamically import that very file. Inline also means no scratch file exists to
    // leak, race or swap between approval and execution.
    expect(args).toEqual(["-e", 'console.log("hi")']);
  });

  test("requiredReadPaths includes the interpreter's own directory", () => {
    // Without it the Windows AppContainer cannot read bun.exe and the child dies before running a
    // line. Linux hides this because bwrap binds the system tree by default.
    const paths = resolveRuntimeById("bun").requiredReadPaths();
    expect(paths).toContain(dirname(process.execPath));
  });

  test("requiredReadPaths adds the runtime HOME on macOS only", () => {
    // Windows must NOT get it: `~/.bun` carries thousands of cache entries and the helper writes
    // one ACE per granted path, so granting it hangs every spawn.
    const paths = resolveRuntimeById("bun").requiredReadPaths();
    const home = dirname(dirname(process.execPath));
    expect(paths.includes(home)).toBe(process.platform === "darwin");
  });

  test("an unknown id is a named error, not a fallback", () => {
    expect(() => resolveRuntimeById("cobol")).toThrow(ExecRuntimeError);
    try {
      resolveRuntimeById("cobol");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ExecRuntimeError).code).toBe("ERR_EXEC_UNKNOWN_RUNTIME");
    }
  });

  test("id lookup is case-insensitive", () => {
    // Load-bearing: the gate compares `runtime.id` against the lowercase `allowed_runtimes`
    // config array. Both sides normalise; neither knows the other depends on it.
    expect(resolveRuntimeById("BUN").id).toBe("bun");
    expect(resolveRuntimeById("  bun  ").id).toBe("bun");
  });

  test("maps a .ts/.js/.mjs file to bun", () => {
    for (const p of ["/tmp/a.ts", "/tmp/a.js", "/tmp/a.mjs"]) {
      expect(resolveRuntimeForFile(p).id).toBe("bun");
    }
  });

  test("an unrecognised extension is REJECTED, never defaulted to the sole entry", () => {
    try {
      resolveRuntimeForFile("/tmp/a.py");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExecRuntimeError);
      expect((e as ExecRuntimeError).code).toBe("ERR_EXEC_UNKNOWN_EXTENSION");
    }
  });

  test("a file with NO extension is rejected too", () => {
    expect(() => resolveRuntimeForFile("/tmp/script")).toThrow(ExecRuntimeError);
  });

  test("extension matching is case-insensitive", () => {
    expect(resolveRuntimeForFile("/tmp/A.TS").id).toBe("bun");
  });

  test("detect() returns a path to the running interpreter", () => {
    expect(resolveRuntimeById("bun").detect()).toBe(process.execPath);
  });

  test("requireInstalled returns the binary for an installed runtime", () => {
    expect(requireInstalled(resolveRuntimeById("bun"))).toBe(process.execPath);
  });

  test("requireInstalled throws a NAMED error when detect() finds nothing", () => {
    const absent = {
      id: "ghost",
      detect: () => null,
      argvFor: () => ({ cmd: "", args: [] }),
      requiredReadPaths: () => [],
    };
    try {
      requireInstalled(absent);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ExecRuntimeError).code).toBe("ERR_EXEC_RUNTIME_NOT_INSTALLED");
    }
  });
});
