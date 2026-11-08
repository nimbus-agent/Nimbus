import { afterAll, describe, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IAC_GIT_SCAN_LIMITS, type ReadDirEntries, scanForGitEntry } from "./iac-git-scan.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-git-scan-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function dir(name: string): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("scanForGitEntry on a real tree", () => {
  test("a tree without a repository is clean", () => {
    const d = dir("clean");
    mkdirSync(join(d, "envs", "prod"), { recursive: true });
    writeFileSync(join(d, "main.tf"), "");
    writeFileSync(join(d, ".gitignore"), "x"); // a .gitignore is not a repository
    expect(scanForGitEntry(d)).toBe("clean");
  });

  test("a .git folder, at the top and deep below, is found", () => {
    const top = dir("top");
    mkdirSync(join(top, ".git"));
    expect(scanForGitEntry(top)).toBe("found");
    const deep = dir("deep");
    mkdirSync(join(deep, "a", "b", "c", ".git"), { recursive: true });
    expect(scanForGitEntry(deep)).toBe("found");
  });

  test("a .git FILE (a submodule or worktree) is found, whatever its letter case", () => {
    const sub = dir("sub");
    mkdirSync(join(sub, "module"), { recursive: true });
    writeFileSync(join(sub, "module", ".git"), "gitdir: ../../elsewhere");
    expect(scanForGitEntry(sub)).toBe("found");
    const upper = dir("upper");
    writeFileSync(join(upper, ".GIT"), "x");
    expect(scanForGitEntry(upper)).toBe("found");
  });

  test("a link is never followed: a repository behind one is not seen, a link NAMED .git is a hit", () => {
    const target = dir("target-with-repo");
    mkdirSync(join(target, ".git"));
    const d = dir("links");
    symlinkSync(target, join(d, "linked"), "junction");
    expect(scanForGitEntry(d)).toBe("clean");
    const named = dir("named-link");
    symlinkSync(target, join(named, ".git"), "junction");
    expect(scanForGitEntry(named)).toBe("found");
  });

  test("a directory that cannot be read is not clean", () => {
    expect(scanForGitEntry(join(root, "does-not-exist"))).toBe("unreadable");
  });
});

describe("scanForGitEntry caps (a fake reader)", () => {
  const entry = (name: string, directory: boolean): Dirent =>
    ({ name, isDirectory: () => directory }) as unknown as Dirent;

  test("more entries than the cap is over-cap, not clean", () => {
    const wide: ReadDirEntries = () => Array.from({ length: 11 }, (_, i) => entry(`f${i}`, false));
    expect(scanForGitEntry("/r", { maxDepth: 4, maxEntries: 10 }, wide)).toBe("over-cap");
    expect(scanForGitEntry("/r", { maxDepth: 4, maxEntries: 11 }, wide)).toBe("clean");
  });

  test("a tree deeper than the cap is over-cap, not clean", () => {
    const endless: ReadDirEntries = () => [entry("d", true)];
    expect(scanForGitEntry("/r", { maxDepth: 3, maxEntries: 1000 }, endless)).toBe("over-cap");
    const bounded: ReadDirEntries = (d) => (d.split(/[\\/]/).length > 4 ? [] : [entry("d", true)]);
    expect(scanForGitEntry("/r", { maxDepth: 3, maxEntries: 1000 }, bounded)).toBe("clean");
  });

  test("the production caps are the documented ones", () => {
    expect(IAC_GIT_SCAN_LIMITS).toEqual({ maxDepth: 16, maxEntries: 50_000 });
  });
});
