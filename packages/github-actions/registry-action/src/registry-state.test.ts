/** `readStatementFiles` / `readRequestFiles` against a fake git tree: every skip reason, no repository. */
import { describe, expect, test } from "bun:test";
import type * as gitTree from "./git-tree.ts";
import { readRequestFiles, readStatementFiles, statementPath } from "./registry-state.ts";

type Git = typeof gitTree;

const REGULAR = "100644";
const HEX = "a".repeat(64);

function fakeGit(files: Record<string, { mode?: string; body: string | Uint8Array }>): Git {
  const fake = {
    REGULAR_FILE_MODE: REGULAR,
    listTreeEntries: (_ref: string, dir: string) =>
      Object.entries(files)
        .filter(([p]) => p.startsWith(dir))
        .map(([path, f]) => ({ mode: f.mode ?? REGULAR, path, blob: "x" })),
    readBlob: (_ref: string, path: string) => {
      const b = files[path]?.body ?? "";
      return typeof b === "string" ? new TextEncoder().encode(b) : b;
    },
  };
  return fake as unknown as Git;
}

describe("readStatementFiles", () => {
  test("ignores .gitkeep and every path outside `only`", () => {
    const git = fakeGit({
      "statements/.gitkeep": { body: "" },
      [`statements/${HEX}.json`]: { body: "{}" },
    });
    expect(readStatementFiles(git, "ref", ".", new Set(["statements/other.json"]))).toEqual({
      values: [],
      skipped: [],
    });
    expect(readStatementFiles(git, "ref", ".").skipped.map((s) => s.path)).toEqual([
      `statements/${HEX}.json`,
    ]);
  });

  test("names the reason for every file that cannot be a statement", () => {
    const git = fakeGit({
      "statements/bad-name.json": { body: "{}" },
      [`statements/${"b".repeat(64)}.json`]: { mode: "100755", body: "{}" },
      [`statements/${"c".repeat(64)}.json`]: { body: "x".repeat(70_000) },
      [`statements/${"d".repeat(64)}.json`]: { body: new Uint8Array([0xff, 0xfe]) },
      [`statements/${"e".repeat(64)}.json`]: { body: "{not json" },
      [`statements/${"f".repeat(64)}.json`]: { body: '{"kind":"nope"}' },
    });
    const reasons = readStatementFiles(git, "ref", ".").skipped.map((s) => s.reason);
    expect(reasons[0]).toContain("must be statements/<64 lowercase hex statement id>.json");
    expect(reasons[1]).toBe("git mode 100755 is not a regular file");
    expect(reasons[2]).toMatch(/^exceeds \d+ bytes$/);
    expect(reasons[3]).toBe("is not valid UTF-8 JSON");
    expect(reasons[4]).toBe("is not valid UTF-8 JSON");
    expect(reasons[5]).toStartWith("is not a valid trust statement:");
  });
});

describe("readRequestFiles", () => {
  test("skips a badly named, non-regular, oversized, non-UTF-8 or invalid request", () => {
    const git = fakeGit({
      "trust-requests/.gitkeep": { body: "" },
      "trust-requests/Bad Name.json": { body: "{}" },
      "trust-requests/exec.json": { mode: "100755", body: "{}" },
      "trust-requests/big.json": { body: "x".repeat(70_000) },
      "trust-requests/utf.json": { body: new Uint8Array([0xff]) },
      "trust-requests/bad.json": { body: '{"kind":"x"}' },
    });
    const { requests, skipped } = readRequestFiles(git, "ref", ".");
    expect(requests).toEqual([]);
    expect(skipped.map((s) => s.path)).toEqual([
      "trust-requests/Bad Name.json",
      "trust-requests/exec.json",
      "trust-requests/big.json",
      "trust-requests/utf.json",
      "trust-requests/bad.json",
    ]);
    expect(skipped[0]?.reason).toContain("must be trust-requests/<name>.json");
    expect(skipped[1]?.reason).toBe("git mode 100755 is not a regular file");
    for (const s of skipped.slice(2)) expect(s.reason).toStartWith("is not a valid request:");
    expect(skipped[2]?.reason).toContain("too large");
  });

  test("`only` limits which files are read", () => {
    const git = fakeGit({ "trust-requests/a.json": { body: "{}" } });
    expect(readRequestFiles(git, "ref", ".", new Set(["x"]))).toEqual({
      requests: [],
      skipped: [],
    });
  });
});

describe("statementPath", () => {
  test("names the directory without an id and the file with one", () => {
    expect(statementPath(undefined)).toBe("statements/");
    expect(statementPath(HEX)).toBe(`statements/${HEX}.json`);
  });
});
