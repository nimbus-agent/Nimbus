import { afterEach, describe, expect, test } from "bun:test";
import { emitAnnotation, getIntInput, makeSetOutput, safeInt, safeString } from "./gha-io.ts";

describe("emitAnnotation — workflow-command injection hardening", () => {
  let written = "";
  const original = process.stdout.write.bind(process.stdout);
  afterEach(() => {
    process.stdout.write = original;
    written = "";
  });

  function capture(): void {
    written = "";
    // biome-ignore lint/suspicious/noExplicitAny: minimal stdout.write spy for the test
    process.stdout.write = ((chunk: any) => {
      written += String(chunk);
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
});
