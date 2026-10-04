import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectFiles } from "./collect-files.ts";

const isSql = (name: string): boolean => name.toLowerCase().endsWith(".sql");

/**
 * A FILE symlink needs privilege on a Windows host without Developer Mode, so the linked-file case
 * runs only where a real probe can create one — a platform guess would also skip hosts that can. A
 * directory junction needs no privilege, so the linked-directory case always runs.
 */
function canSymlinkFiles(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-collect-files-probe-"));
  try {
    writeFileSync(join(dir, "target.sql"), "");
    symlinkSync(join(dir, "target.sql"), join(dir, "link.sql"), "file");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
    throw err; // anything but a privilege refusal is a broken probe, not an unsupported host
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CAN_SYMLINK_FILES = canSymlinkFiles();
if (!CAN_SYMLINK_FILES) {
  console.warn(
    "collect-files.test.ts: skipping the linked-file case — symlinkSync raised EPERM (this host " +
      "cannot create file symlinks); the linked-directory case still runs",
  );
}

describe("collectFiles", () => {
  let root: string;

  /** Write an empty file at `rel` (a path under `root`), creating its directories. */
  function touch(...rel: string[]): string {
    const full = join(root, ...rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "");
    return full;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nimbus-collect-files-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("collects the accepted regular files at every level, as full paths", async () => {
    const expected = [touch("a.sql"), touch("sub", "b.SQL"), touch("sub", "deeper", "c.sql")];
    touch("notes.txt");
    touch("sub", "readme.md");

    const found = await collectFiles(root, { maxDepth: 12, maxFiles: 100, accept: isSql });

    expect(found.toSorted()).toEqual(expected.toSorted());
  });

  test("never collects a directory, even one whose name is accepted", async () => {
    mkdirSync(join(root, "looks-like.sql"));
    const file = touch("looks-like.sql", "inner.sql");

    expect(await collectFiles(root, { maxDepth: 12, maxFiles: 100, accept: isSql })).toEqual([
      file,
    ]);
  });

  test("reads no directory deeper than maxDepth (the root is depth 0)", async () => {
    const top = touch("top.sql");
    const level1 = touch("one", "level1.sql");
    touch("one", "two", "level2.sql");

    const depth0 = await collectFiles(root, { maxDepth: 0, maxFiles: 100, accept: isSql });
    expect(depth0).toEqual([top]);

    const depth1 = await collectFiles(root, { maxDepth: 1, maxFiles: 100, accept: isSql });
    expect(depth1.toSorted()).toEqual([level1, top].toSorted());
  });

  test("stops at maxFiles, across directories", async () => {
    for (const name of ["a.sql", "b.sql", "c.sql"]) touch(name);
    for (const name of ["d.sql", "e.sql", "f.sql"]) touch("sub", name);

    const found = await collectFiles(root, { maxDepth: 12, maxFiles: 4, accept: isSql });

    expect(found).toHaveLength(4);
    expect(new Set(found).size).toBe(4);
    for (const path of found) expect(isSql(path)).toBe(true);
  });

  test("a maxFiles of 0 reads nothing", async () => {
    touch("a.sql");

    expect(await collectFiles(root, { maxDepth: 12, maxFiles: 0, accept: isSql })).toEqual([]);
  });

  test("an unreadable root yields nothing rather than throwing", async () => {
    const missing = join(root, "does-not-exist");

    expect(await collectFiles(missing, { maxDepth: 12, maxFiles: 100, accept: isSql })).toEqual([]);
  });

  test("judges each regular file by its base name alone — never its path, never a directory", async () => {
    const picked = touch("chosen", "pick.sql");
    touch("chosen", "skip.sql");
    const judged: string[] = [];

    const found = await collectFiles(root, {
      maxDepth: 12,
      maxFiles: 100,
      accept: (name) => {
        judged.push(name);
        return name === "pick.sql";
      },
    });

    expect(found).toEqual([picked]);
    expect(judged.toSorted()).toEqual(["pick.sql", "skip.sql"]);
  });

  describe("links — the walk must not leave the root through one", () => {
    let outside: string;

    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), "nimbus-collect-files-outside-"));
      writeFileSync(join(outside, "outside.sql"), "");
    });

    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    test("does not enter a linked directory", async () => {
      const own = touch("own.sql");
      const link = join(root, "linked-dir");
      // A junction needs no privilege on Windows; elsewhere the type is ignored (a directory symlink).
      symlinkSync(outside, link, "junction");
      // Premise: the link resolves to a directory holding an accepted file, so following it WOULD
      // add a result. Without this, an unchanged result would prove nothing.
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readdirSync(link)).toEqual(["outside.sql"]);

      expect(await collectFiles(root, { maxDepth: 12, maxFiles: 100, accept: isSql })).toEqual([
        own,
      ]);
    });

    test.skipIf(!CAN_SYMLINK_FILES)(
      "does not collect a linked file, even one whose name is accepted",
      async () => {
        const own = touch("own.sql");
        const link = join(root, "linked.sql");
        symlinkSync(join(outside, "outside.sql"), link, "file");
        // Premise: the link resolves to a regular file with an accepted name.
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(statSync(link).isFile()).toBe(true);

        expect(await collectFiles(root, { maxDepth: 12, maxFiles: 100, accept: isSql })).toEqual([
          own,
        ]);
      },
    );
  });
});
