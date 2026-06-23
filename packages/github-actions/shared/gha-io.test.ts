import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitAnnotation,
  getBooleanInput,
  getInput,
  getIntInput,
  makeSetOutput,
  safeInt,
  safeString,
  writeJobSummary,
} from "./gha-io.ts";

describe("emitAnnotation — workflow-command injection hardening", () => {
  let written = "";
  const original = process.stdout.write.bind(process.stdout);
  afterEach(() => {
    process.stdout.write = original;
    written = "";
  });

  function capture(): void {
    written = "";
    process.stdout.write = ((chunk: Parameters<typeof process.stdout.write>[0]): boolean => {
      written += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
  }

  test("escapes newlines so a message cannot inject a second workflow command", () => {
    capture();
    emitAnnotation("error", "boom\n::add-mask::secret");
    process.stdout.write = original;
    // The injected newline is encoded; no raw second `::command` line is emitted.
    expect(written).toBe("::error::boom%0A::add-mask::secret\n");
    expect(written.split("\n")).toHaveLength(2); // only the trailing terminator newline
  });

  test("escapes carriage returns and percent signs (GitHub data encoding)", () => {
    capture();
    emitAnnotation("warning", "100% done\rX");
    process.stdout.write = original;
    expect(written).toBe("::warning::100%25 done%0DX\n");
  });

  test("leaves an ordinary message untouched apart from the terminator", () => {
    capture();
    emitAnnotation("warning", "missing required input: service");
    process.stdout.write = original;
    expect(written).toBe("::warning::missing required input: service\n");
  });
});

describe("makeSetOutput", () => {
  test("rejects an output name outside the allow-list", () => {
    const setOutput = makeSetOutput(new Set(["verdict"]));
    expect(() => setOutput("not-allowed", "x")).toThrow(/refusing to set unknown output/);
  });

  test("is a no-op when GITHUB_OUTPUT is unset", () => {
    const saved = process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_OUTPUT;
    try {
      const setOutput = makeSetOutput(new Set(["verdict"]));
      expect(() => setOutput("verdict", "ok")).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.GITHUB_OUTPUT = saved;
    }
  });
});

describe("scalar input helpers", () => {
  test("safeString strips control chars and clamps length", () => {
    expect(safeString("ab", 10)).toBe("ab");
    expect(safeString("abcdef", 3)).toBe("abc");
    expect(safeString(42, 10)).toBe("");
  });

  test("safeInt coerces and truncates; non-finite → 0", () => {
    expect(safeInt("12.9")).toBe(12);
    expect(safeInt("nope")).toBe(0);
    expect(safeInt(7)).toBe(7);
  });

  test("getIntInput falls back when empty or non-integer", () => {
    const saved = process.env.INPUT_TIMEOUT_MS;
    try {
      delete process.env.INPUT_TIMEOUT_MS;
      expect(getIntInput("timeout-ms", 5)).toBe(5);
      process.env.INPUT_TIMEOUT_MS = "abc";
      expect(getIntInput("timeout-ms", 5)).toBe(5);
      process.env.INPUT_TIMEOUT_MS = "8";
      expect(getIntInput("timeout-ms", 5)).toBe(8);
    } finally {
      if (saved === undefined) delete process.env.INPUT_TIMEOUT_MS;
      else process.env.INPUT_TIMEOUT_MS = saved;
    }
  });

  test("getInput and getBooleanInput read INPUT_* env vars", () => {
    const savedString = process.env.INPUT_SOME_STRING;
    const savedBool = process.env.INPUT_SOME_BOOL;
    try {
      process.env.INPUT_SOME_STRING = " hello ";
      expect(getInput("some-string")).toBe(" hello ");

      process.env.INPUT_SOME_BOOL = "true";
      expect(getBooleanInput("some-bool")).toBe(true);

      process.env.INPUT_SOME_BOOL = "YES";
      expect(getBooleanInput("some-bool")).toBe(true);

      process.env.INPUT_SOME_BOOL = "1";
      expect(getBooleanInput("some-bool")).toBe(true);

      process.env.INPUT_SOME_BOOL = "false";
      expect(getBooleanInput("some-bool")).toBe(false);

      delete process.env.INPUT_SOME_BOOL;
      expect(getBooleanInput("some-bool")).toBe(false);
    } finally {
      if (savedString !== undefined) process.env.INPUT_SOME_STRING = savedString;
      else delete process.env.INPUT_SOME_STRING;
      if (savedBool !== undefined) process.env.INPUT_SOME_BOOL = savedBool;
      else delete process.env.INPUT_SOME_BOOL;
    }
  });
});

describe("writeJobSummary", () => {
  test("writeJobSummary writes to process.env.GITHUB_STEP_SUMMARY", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gha-summary-"));
    const summaryFile = join(tmpDir, "summary.md");
    const saved = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    try {
      writeJobSummary("hello world");
      expect(readFileSync(summaryFile, "utf8")).toBe("hello world\n");
      const huge = "A".repeat(70000);
      writeJobSummary(huge);
      const content = readFileSync(summaryFile, "utf8");
      expect(content).toHaveLength(12 + 65536 + 1); // "hello world\n" + 64kb + "\n"
    } finally {
      if (saved === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = saved;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("writeJobSummary does nothing when GITHUB_STEP_SUMMARY is unset", () => {
    const saved = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    try {
      expect(() => writeJobSummary("hello")).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
    }
  });
});

describe("makeSetOutput file writing", () => {
  test("makeSetOutput writes correct heredoc format to GITHUB_OUTPUT", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gha-output-"));
    const outFile = join(tmpDir, "output.txt");
    const saved = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outFile;
    try {
      const setOutput = makeSetOutput(new Set(["my-out"]));
      setOutput("my-out", "hello\nworld");
      const content = readFileSync(outFile, "utf8");
      expect(content).toContain("my-out<<EOF_");
      expect(content).toContain("\nhello\nworld\nEOF_");
    } finally {
      if (saved === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = saved;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
