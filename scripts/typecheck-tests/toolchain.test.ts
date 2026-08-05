// scripts/typecheck-tests/toolchain.test.ts
import { describe, expect, test } from "bun:test";
import { ranSuccessfully, unrunnableReport } from "./toolchain.ts";

describe("ranSuccessfully", () => {
  test("exit 0 with no diagnostics is the only clean pass", () => {
    expect(ranSuccessfully({ exitCode: 0, errorCount: 0 })).toBe(true);
  });

  test("non-zero exit WITH diagnostics is a normal typecheck failure", () => {
    expect(ranSuccessfully({ exitCode: 2, errorCount: 471 })).toBe(true);
  });

  // The three measured shapes this gate was blind to: TS18003 (`include` matched nothing),
  // TS5058 (`-p` path does not exist), and an unresolvable `typescript`. All exit non-zero and
  // emit a bare, file-less diagnostic that parses to zero errors.
  test("non-zero exit with NO diagnostics means tsc never ran", () => {
    expect(ranSuccessfully({ exitCode: 2, errorCount: 0 })).toBe(false);
    expect(ranSuccessfully({ exitCode: 1, errorCount: 0 })).toBe(false);
  });

  test("exit 0 WITH diagnostics is equally impossible and equally a failure", () => {
    expect(ranSuccessfully({ exitCode: 0, errorCount: 3 })).toBe(false);
  });
});

describe("unrunnableReport", () => {
  test("prints the project, the exit code and the captured tsc output", () => {
    const report = unrunnableReport({
      project: "packages/gateway/tsconfig.tests.json",
      exitCode: 2,
      errorCount: 0,
      output: "error TS18003: No inputs were found in config file.",
    });
    expect(report).toContain("packages/gateway/tsconfig.tests.json");
    expect(report).toContain("tsc exit code: 2");
    expect(report).toContain("TS18003");
  });

  test("says so explicitly when tsc printed nothing at all", () => {
    const report = unrunnableReport({
      project: "p.json",
      exitCode: 1,
      errorCount: 0,
      output: "  ",
    });
    expect(report).toContain("(no output)");
  });
});
