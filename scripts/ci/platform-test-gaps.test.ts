import { describe, expect, it } from "bun:test";

import { insideStringLiteral, matchSkipSite, scanSource } from "./platform-test-gaps.ts";

const at = (text: string, onPlatform: string) => matchSkipSite("f.ts", 1, text, onPlatform);

describe("matchSkipSite — skipIf skips when the condition is TRUE", () => {
  it('=== "win32" is skipped ON win32 and runs elsewhere', () => {
    expect(at('it.skipIf(process.platform === "win32")("x", () => {});', "win32")?.skipped).toBe(
      true,
    );
    expect(at('it.skipIf(process.platform === "win32")("x", () => {});', "darwin")?.skipped).toBe(
      false,
    );
  });

  it('!== "win32" is the inverse: runs ON win32, skipped everywhere else', () => {
    expect(at('it.skipIf(process.platform !== "win32")("x", () => {});', "win32")?.skipped).toBe(
      false,
    );
    expect(at('it.skipIf(process.platform !== "win32")("x", () => {});', "darwin")?.skipped).toBe(
      true,
    );
    expect(at('it.skipIf(process.platform !== "win32")("x", () => {});', "linux")?.skipped).toBe(
      true,
    );
  });

  it("accepts the bare platform() form and reports the named platform", () => {
    const site = at('describe.skipIf(platform() === "darwin")("x", () => {});', "darwin");
    expect(site?.skipped).toBe(true);
    expect(site?.namedPlatform).toBe("darwin");
  });

  it("recognises it/test/describe alike", () => {
    for (const kind of ["it", "test", "describe"]) {
      expect(at(`${kind}.skipIf(process.platform === "linux")("x", () => {});`, "linux")).not.toBe(
        null,
      );
    }
  });
});

describe("matchSkipSite — what it deliberately does not decide", () => {
  it("returns null for a non-platform skip rather than guessing", () => {
    expect(at('it.skipIf(!VEC_AVAILABLE)("x", () => {});', "win32")).toBe(null);
  });

  it("returns null for a line with no skipIf at all", () => {
    expect(at('it("plain test", () => {});', "win32")).toBe(null);
  });

  it("returns null for an imported/composite condition — under-reports, never over-reports", () => {
    expect(at('it.skipIf(isWindowsLike)("x", () => {});', "win32")).toBe(null);
  });
});

describe("scanSource", () => {
  const source = [
    'it.skipIf(process.platform === "win32")("posix only", () => {});', // line 1
    'it("always runs", () => {});', // line 2
    'it.skipIf(process.platform !== "win32")("windows only", () => {});', // line 3
    'it.skipIf(!VEC_AVAILABLE)("vec", () => {});', // line 4
  ].join("\n");

  it("on win32 reports only the POSIX-only site, with its line number", () => {
    const sites = scanSource("a.test.ts", source, "win32");
    expect(sites).toHaveLength(1);
    expect(sites[0]?.line).toBe(1);
    expect(sites[0]?.namedPlatform).toBe("win32");
  });

  it("on darwin reports only the Windows-only site", () => {
    const sites = scanSource("a.test.ts", source, "darwin");
    expect(sites).toHaveLength(1);
    expect(sites[0]?.line).toBe(3);
  });

  it("never reports a site that does run on the given platform", () => {
    for (const p of ["win32", "darwin", "linux"]) {
      for (const s of scanSource("a.test.ts", source, p)) expect(s.skipped).toBe(true);
    }
  });
});

describe("insideStringLiteral — the false-positive guard", () => {
  it("suppresses a skipIf that only appears inside a quoted string", () => {
    const line = 'expect(at(\'it.skipIf(process.platform === "win32")()\', "win32")).toBe(null);';
    expect(matchSkipSite("f.ts", 1, line, "win32")).toBe(null);
  });

  it("still reports a real call site on the same shape of line", () => {
    const line = 'it.skipIf(process.platform === "win32")("x", () => {});';
    expect(matchSkipSite("f.ts", 1, line, "win32")?.skipped).toBe(true);
  });

  it("treats an escaped quote as content, not as a delimiter", () => {
    expect(insideStringLiteral('const s = "a\\"b"; more', 20)).toBe(false);
  });

  it("reports a position inside an unterminated quote as in-string", () => {
    expect(insideStringLiteral('const s = "open', 13)).toBe(true);
  });
});
