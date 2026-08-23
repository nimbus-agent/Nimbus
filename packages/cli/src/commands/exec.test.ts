import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  EXEC_EXIT_CODES,
  exitCodeFor,
  formatApprovalPrompt,
  parseExecArgs,
  renderOutcome,
} from "./exec.ts";

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
  test("live in the shell-reserved 124-127 band, not where scripts put their own codes", () => {
    // 10-14 was the obvious first choice and the wrong one: that is exactly where ordinary scripts
    // put their own error codes, so `exit 10` would be indistinguishable from a denial. 124-127 is
    // the band the shell already reserves for "the command did not run".
    expect(EXEC_EXIT_CODES).toEqual({
      wallClock: 124,
      outputCap: 125,
      denied: 126,
      refused: 127,
    });
    for (const c of Object.values(EXEC_EXIT_CODES)) {
      expect(c).toBeGreaterThanOrEqual(124);
      expect(c).toBeLessThanOrEqual(127);
    }
  });

  test("has NO timeout code, because no outcome can produce one", () => {
    // The consent broker resolves false on TTL, so a timed-out approval IS a denial. A documented
    // code for it would be unreachable -- the shape this repo has been bitten by before.
    expect("timeout" in EXEC_EXIT_CODES).toBe(false);
    expect(exitCodeFor({ status: "timeout" })).toBe(EXEC_EXIT_CODES.refused);
  });

  test("maps every outcome to its documented exit code", () => {
    expect(exitCodeFor({ status: "denied" })).toBe(126);
    expect(exitCodeFor({ status: "refused", code: "ERR_EXEC_DISABLED" })).toBe(127);
    expect(
      exitCodeFor({ status: "ran", result: { exitCode: null, terminationReason: "wall_clock" } }),
    ).toBe(124);
    expect(
      exitCodeFor({ status: "ran", result: { exitCode: null, terminationReason: "output_cap" } }),
    ).toBe(125);
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
    expect(exitCodeFor({ status: "ran" })).toBe(127);
    expect(exitCodeFor({ status: "something-new" })).toBe(127);
  });
});

describe("renderOutcome", () => {
  function sink() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, s: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
  }

  test("writes stdout and stderr through, and stays silent when both are empty", () => {
    const a = sink();
    renderOutcome(
      {
        status: "ran",
        result: { exitCode: 0, terminationReason: "exited", stdout: "hi", stderr: "warn" },
      },
      a.s,
    );
    expect(a.out.join("")).toBe("hi");
    expect(a.err.join("")).toContain("warn");

    const b = sink();
    renderOutcome(
      {
        status: "ran",
        result: { exitCode: 0, terminationReason: "exited", stdout: "", stderr: "" },
      },
      b.s,
    );
    expect(b.out.join("")).toBe("");
    expect(b.err.join("")).toBe("");
  });

  test("DISCLOSES truncation rather than handing back a short buffer that looks complete", () => {
    const a = sink();
    renderOutcome(
      {
        status: "ran",
        result: { exitCode: 0, terminationReason: "output_cap", stdout: "part", truncated: true },
      },
      a.s,
    );
    expect(a.err.join("")).toContain("truncated");
  });

  test("names the refusal code on stderr — the unambiguous signal the exit code cannot carry", () => {
    const a = sink();
    renderOutcome({ status: "refused", code: "ERR_EXEC_DISABLED" }, a.s);
    expect(a.err.join("")).toContain("ERR_EXEC_DISABLED");
  });

  test("falls back to 'unknown' for a refusal with no code", () => {
    const a = sink();
    renderOutcome({ status: "refused" }, a.s);
    expect(a.err.join("")).toContain("unknown");
  });

  test("says so on a denial, and writes nothing to stdout", () => {
    const a = sink();
    renderOutcome({ status: "denied" }, a.s);
    expect(a.err.join("")).toContain("denied");
    expect(a.out.join("")).toBe("");
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
