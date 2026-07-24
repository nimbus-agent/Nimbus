import { describe, expect, test } from "bun:test";

import {
  gitBlameWholeFile,
  gitBlameWindowFiles,
  gitChangedSince,
  gitHeadSha,
  isAncestor,
} from "./blame-index-sync.ts";

/** A Bun.spawn stand-in returning a fixed exit code + stdout. */
function fakeSpawn(out: string, code: number): typeof Bun.spawn {
  return (() =>
    ({
      exited: Promise.resolve(code),
      stdout: new Response(out).body,
    }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn;
}

/** A Bun.spawn stand-in that throws (ENOENT / abort). */
const throwingSpawn = (() => {
  throw new Error("spawn failed");
}) as unknown as typeof Bun.spawn;

const SHA_A = "a".repeat(40);
const SHA_F = "f".repeat(40);

describe("gitHeadSha", () => {
  test("returns a 40-hex sha on exit 0", async () => {
    expect(await gitHeadSha("/r", fakeSpawn(`${SHA_A}\n`, 0))).toBe(SHA_A);
  });

  test("returns null on a non-zero exit", async () => {
    expect(await gitHeadSha("/r", fakeSpawn("", 128))).toBeNull();
  });

  test("returns null when the output is not a 40-hex sha", async () => {
    expect(await gitHeadSha("/r", fakeSpawn("not-a-sha\n", 0))).toBeNull();
  });

  test("returns null when the spawn throws (git missing / timeout)", async () => {
    expect(await gitHeadSha("/r", throwingSpawn)).toBeNull();
  });
});

describe("isAncestor", () => {
  test("true on exit 0", async () => {
    expect(await isAncestor("/r", SHA_A, fakeSpawn("", 0))).toBe(true);
  });

  test("false on a non-zero exit (rewritten history)", async () => {
    expect(await isAncestor("/r", SHA_A, fakeSpawn("", 1))).toBe(false);
  });
});

describe("gitBlameWindowFiles", () => {
  test("dedupes NUL-separated names", async () => {
    const files = await gitBlameWindowFiles("/r", 90, fakeSpawn("a.ts\0b.ts\0a.ts\0", 0));
    expect(new Set(files)).toEqual(new Set(["a.ts", "b.ts"]));
  });

  test("returns [] on a non-zero exit", async () => {
    expect(await gitBlameWindowFiles("/r", 90, fakeSpawn("a.ts\0", 1))).toEqual([]);
  });
});

describe("gitChangedSince", () => {
  test("parses A/M/D and expands renames to D + A", async () => {
    const changes = await gitChangedSince(
      "/r",
      SHA_F,
      fakeSpawn("M\0a.ts\0D\0b.ts\0R100\0old.ts\0new.ts\0", 0),
    );
    expect(changes).toContainEqual({ status: "M", path: "a.ts" });
    expect(changes).toContainEqual({ status: "D", path: "b.ts" });
    expect(changes).toContainEqual({ status: "D", path: "old.ts" });
    expect(changes).toContainEqual({ status: "A", path: "new.ts", oldPath: "old.ts" });
  });

  test("returns [] on a non-zero exit", async () => {
    expect(await gitChangedSince("/r", SHA_F, fakeSpawn("M\0a.ts\0", 1))).toEqual([]);
  });
});

describe("gitBlameWholeFile", () => {
  test("parses porcelain rows", async () => {
    const out = [
      `${"1".repeat(40)} 1 1 1`,
      "author Ada",
      "author-mail <ada@x>",
      "author-time 1700000000",
      "\tconst k = 1",
      "",
    ].join("\n");
    const rows = await gitBlameWholeFile("/r", "x.ts", fakeSpawn(out, 0));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commitSha).toBe("1".repeat(40));
    expect(rows[0]?.lineNo).toBe(1);
  });

  test("returns [] on a non-zero exit", async () => {
    expect(await gitBlameWholeFile("/r", "x.ts", fakeSpawn("", 128))).toEqual([]);
  });
});
