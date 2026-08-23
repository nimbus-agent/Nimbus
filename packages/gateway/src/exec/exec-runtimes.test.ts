import { describe, expect, test } from "bun:test";
import {
  ExecRuntimeError,
  requireInstalled,
  resolveRuntimeById,
  resolveRuntimeForFile,
} from "./exec-runtimes.ts";

describe("ExecRuntime registry", () => {
  test("resolves bun by id and produces a runnable argv", () => {
    const rt = resolveRuntimeById("bun");
    expect(rt.id).toBe("bun");
    const { cmd, args } = rt.argvFor("/tmp/s.ts");
    expect(cmd).not.toBe("");
    expect(args).toEqual(["run", "/tmp/s.ts"]);
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
