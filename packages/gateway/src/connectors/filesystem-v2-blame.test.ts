import { describe, expect, test } from "bun:test";
import { excerptWithStartLine, gitBlameLinePorcelain, mergeRanges } from "./filesystem-v2-sync.ts";

describe("mergeRanges", () => {
  test("coalesces overlapping and adjacent ranges, sorted", () => {
    const merged = mergeRanges([
      { from: 10, to: 12 },
      { from: 1, to: 3 },
      { from: 13, to: 15 }, // adjacent to 10-12 → merges
      { from: 11, to: 11 }, // inside
    ]);
    expect(merged).toEqual([
      { from: 1, to: 3 },
      { from: 10, to: 15 },
    ]);
  });
});

describe("excerptWithStartLine", () => {
  test("startLine is the 1-based line of the first content line of the excerpt", () => {
    // export is on line 9 (1-based). from = max(0, hit-6) = line 3 (0-based 2).
    const src = ["a", "b", "c", "d", "e", "f", "g", "h", "export const foo = 1", "i"].join("\n");
    const r = excerptWithStartLine(src, "foo", 380);
    expect(r.text).toContain("export const foo");
    // lines 3..8 are "c".."h" (non-blank) so the excerpt's first content line is line 3.
    expect(r.startLine).toBe(3);
  });

  test("skips leading blank lines that trim() removes", () => {
    const src = ["", "", "", "", "", "", "", "", "export const bar = 2"].join("\n");
    const r = excerptWithStartLine(src, "bar", 380);
    // hit at 0-based 8 → from = 2; lines 2..7 blank → first content is the export at line 9.
    expect(r.startLine).toBe(9);
  });

  test("no export hit → startLine null", () => {
    const r = excerptWithStartLine("const x = 1", "nope", 380);
    expect(r.startLine).toBeNull();
  });
});

function fakeSpawnReturning(out: string, code: number): typeof Bun.spawn {
  return (() =>
    ({
      exited: Promise.resolve(code),
      stdout: new Response(out).body,
    }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn;
}

describe("gitBlameLinePorcelain", () => {
  test("returns parsed rows from an injected spawn", async () => {
    const out =
      "1111111111111111111111111111111111111111 3 3 1\nauthor Ada\nauthor-mail <ada@x.dev>\nauthor-time 1700000000\n\tconst k = 1\n";
    const rows = await gitBlameLinePorcelain(
      "/repo",
      "src/x.ts",
      [{ from: 3, to: 3 }],
      fakeSpawnReturning(out, 0),
    );
    expect(rows[0]?.commitSha).toBe("1111111111111111111111111111111111111111");
    expect(rows[0]?.authorEmail).toBe("ada@x.dev");
  });

  test("non-zero exit yields no rows (fallback)", async () => {
    const rows = await gitBlameLinePorcelain(
      "/repo",
      "src/x.ts",
      [{ from: 1, to: 1 }],
      fakeSpawnReturning("fatal", 128),
    );
    expect(rows).toEqual([]);
  });

  test("empty ranges → no spawn, no rows", async () => {
    let called = false;
    const spy = (() => {
      called = true;
      return { exited: Promise.resolve(0), stdout: new Response("").body } as unknown as ReturnType<
        typeof Bun.spawn
      >;
    }) as unknown as typeof Bun.spawn;
    const rows = await gitBlameLinePorcelain("/repo", "src/x.ts", [], spy);
    expect(rows).toEqual([]);
    expect(called).toBe(false);
  });
});
