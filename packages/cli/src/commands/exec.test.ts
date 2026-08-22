import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { EXEC_EXIT_CODES, exitCodeFor, formatApprovalPrompt, parseExecArgs } from "./exec.ts";

const ABS = process.platform === "win32" ? "C:\\x" : "/x";

describe("nimbus exec arg parsing", () => {
  test("resolves relative fs grants to ABSOLUTE against the CLI cwd", () => {
    const p = parseExecArgs(["--code", "x", "--allow-fs-read", "./src"]);
    expect(p.fsRead[0]).toBe(resolve(process.cwd(), "./src"));
  });

  test("leaves an already-absolute path alone", () => {
    expect(parseExecArgs(["--code", "y", "--allow-fs-read", ABS]).fsRead[0]).toBe(ABS);
  });

  test("collects repeated grants", () => {
    const p = parseExecArgs([
      "--code",
      "x",
      "--allow-fs-read",
      "./a",
      "--allow-fs-read",
      "./b",
      "--allow-fs-write",
      "./c",
    ]);
    expect(p.fsRead.length).toBe(2);
    expect(p.fsWrite.length).toBe(1);
  });

  test("resolves --file to absolute too", () => {
    expect(parseExecArgs(["--file", "./s.ts"]).filePath).toBe(resolve(process.cwd(), "./s.ts"));
  });

  test("rejects supplying neither --code nor --file", () => {
    expect(() => parseExecArgs([])).toThrow();
  });

  test("rejects a flag whose value is missing", () => {
    expect(() => parseExecArgs(["--code"])).toThrow();
    expect(() => parseExecArgs(["--code", "x", "--allow-fs-read"])).toThrow();
  });

  test("rejects an unknown flag rather than ignoring it", () => {
    // Silently dropping --allow-net would be the worst possible failure here: the user would
    // believe they granted network and the run would look successful without it.
    expect(() => parseExecArgs(["--code", "x", "--allow-net"])).toThrow();
  });

  test("rejects a non-numeric --timeout", () => {
    expect(() => parseExecArgs(["--code", "x", "--timeout", "soon"])).toThrow();
  });

  test("carries --runtime through", () => {
    expect(parseExecArgs(["--code", "x", "--runtime", "bun"]).runtimeId).toBe("bun");
  });
});

describe("exec exit codes", () => {
  test("are the documented, distinct values", () => {
    expect(EXEC_EXIT_CODES).toEqual({
      denied: 10,
      timeout: 11,
      refused: 12,
      wallClock: 13,
      outputCap: 14,
    });
  });

  test("maps every outcome to its documented exit code", () => {
    expect(exitCodeFor({ status: "denied" })).toBe(10);
    expect(exitCodeFor({ status: "refused", code: "ERR_EXEC_DISABLED" })).toBe(12);
    expect(
      exitCodeFor({ status: "ran", result: { exitCode: null, terminationReason: "wall_clock" } }),
    ).toBe(13);
    expect(
      exitCodeFor({ status: "ran", result: { exitCode: null, terminationReason: "output_cap" } }),
    ).toBe(14);
  });

  test("a script's OWN non-zero code passes through unchanged", () => {
    // A wrapper script must be able to tell "your code returned 1" from "you said no".
    expect(
      exitCodeFor({ status: "ran", result: { exitCode: 3, terminationReason: "exited" } }),
    ).toBe(3);
    expect(
      exitCodeFor({ status: "ran", result: { exitCode: 0, terminationReason: "exited" } }),
    ).toBe(0);
  });

  test("an unrecognised outcome is a refusal, not a success", () => {
    // Fail-closed: an unknown shape must never exit 0 and read as "it ran fine".
    expect(exitCodeFor({ status: "ran" })).toBe(12);
    expect(exitCodeFor({ status: "something-new" })).toBe(12);
  });
});

describe("approval prompt", () => {
  test("shows the code body VERBATIM, not a digest", () => {
    const text = formatApprovalPrompt({
      runtime: "bun",
      codeBody: "console.log('hello world')",
      grants: { fsRead: ["/a"], fsWrite: [], network: [] },
      wallClockMs: 30_000,
      cwd: "/tmp",
    });
    expect(text).toContain("console.log('hello world')");
  });

  test("states the network grant explicitly rather than omitting it", () => {
    // An absent line reads as "not mentioned"; the owner should see that it is none.
    const text = formatApprovalPrompt({
      runtime: "bun",
      codeBody: "1",
      grants: { fsRead: [], fsWrite: [], network: [] },
      wallClockMs: 1000,
      cwd: "/tmp",
    });
    expect(text.toLowerCase()).toContain("network");
    expect(text.toLowerCase()).toContain("none");
  });

  test("lists every granted path", () => {
    const text = formatApprovalPrompt({
      runtime: "bun",
      codeBody: "1",
      grants: { fsRead: ["/a", "/b"], fsWrite: ["/c"], network: [] },
      wallClockMs: 1000,
      cwd: "/tmp",
    });
    for (const p of ["/a", "/b", "/c"]) expect(text).toContain(p);
  });
});
