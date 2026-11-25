import { describe, expect, test } from "bun:test";
import type * as gitTree from "./git-tree.ts";
import { assertFeedConfig, readFeedSourceAt } from "./trust-state.ts";

type Git = typeof gitTree;

interface FakeFile {
  readonly bytes: Uint8Array;
  readonly mode?: string;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A git stand-in over an in-memory tree: only the three members trust-state reads. */
function fakeGit(files: Readonly<Record<string, FakeFile>>): Git {
  const fake = {
    REGULAR_FILE_MODE: "100644",
    listTreeEntries: (_ref: string, prefix: string): gitTree.TreeEntry[] =>
      Object.entries(files)
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, f]) => ({ path, mode: f.mode ?? "100644", blob: "0".repeat(40) })),
    readBlob: (_ref: string, path: string): Uint8Array => {
      const f = files[path];
      if (f === undefined) throw new Error(`no blob ${path}`);
      return f.bytes;
    },
  };
  return fake as unknown as Git;
}

describe("assertFeedConfig", () => {
  test("accepts exactly { format: 1 }", () => {
    const git = fakeGit({ "nimbus-trust.json": { bytes: enc('{"format":1}') } });
    expect(() => assertFeedConfig(git, "main", ".")).not.toThrow();
  });

  test("refuses a ref with no marker file", () => {
    expect(() => assertFeedConfig(fakeGit({}), "main", ".")).toThrow(
      "main has no nimbus-trust.json: this is not a trust feed repository",
    );
  });

  test("refuses a marker that is not UTF-8 JSON", () => {
    const git = fakeGit({ "nimbus-trust.json": { bytes: enc("{format") } });
    expect(() => assertFeedConfig(git, "main", ".")).toThrow(
      "nimbus-trust.json on main is not valid UTF-8 JSON",
    );
    const bad = fakeGit({ "nimbus-trust.json": { bytes: new Uint8Array([0xff]) } });
    expect(() => assertFeedConfig(bad, "main", ".")).toThrow("is not valid UTF-8 JSON");
  });

  test("refuses a marker with any other shape", () => {
    const git = fakeGit({ "nimbus-trust.json": { bytes: enc('{"format":1,"x":2}') } });
    expect(() => assertFeedConfig(git, "main", ".")).toThrow('must be exactly { "format": 1 }');
  });
});

describe("readFeedSourceAt", () => {
  test("reads each directory, ignoring .gitkeep", () => {
    const git = fakeGit({
      "publishers/.gitkeep": { bytes: enc("") },
      "publishers/p.json": { bytes: enc('{"a":1}') },
      "requests/r.json": { bytes: enc("[1]") },
      "statements/s.json": { bytes: enc('"s"') },
    });
    const { source, skipped } = readFeedSourceAt(git, "main", ".");
    expect(source.publishers).toEqual([{ path: "publishers/p.json", raw: { a: 1 } }]);
    expect(source.requests).toEqual([{ path: "requests/r.json", raw: [1] }]);
    expect(source.statements).toEqual([{ path: "statements/s.json", raw: "s" }]);
    expect(skipped).toEqual([]);
  });

  test("skips a file that is not a regular file, without reading it", () => {
    const git = fakeGit({ "requests/link.json": { bytes: enc("{}"), mode: "120000" } });
    const { source, skipped } = readFeedSourceAt(git, "main", ".");
    expect(source.requests).toEqual([]);
    expect(skipped).toEqual([
      { path: "requests/link.json", reason: "git mode 120000 is not a regular file" },
    ]);
  });

  test("skips a file over the 16 KiB source cap", () => {
    const big = enc(`"${"x".repeat(16 * 1024)}"`);
    const git = fakeGit({ "statements/big.json": { bytes: big } });
    const { source, skipped } = readFeedSourceAt(git, "main", ".");
    expect(source.statements).toEqual([]);
    expect(skipped).toEqual([{ path: "statements/big.json", reason: "exceeds 16384 bytes" }]);
  });

  test("skips a file that is not UTF-8 JSON", () => {
    const git = fakeGit({
      "publishers/bad.json": { bytes: enc("{nope") },
      "publishers/bin.json": { bytes: new Uint8Array([0xc3]) },
    });
    const { skipped } = readFeedSourceAt(git, "main", ".");
    expect(skipped).toEqual([
      { path: "publishers/bad.json", reason: "is not valid UTF-8 JSON" },
      { path: "publishers/bin.json", reason: "is not valid UTF-8 JSON" },
    ]);
  });
});
