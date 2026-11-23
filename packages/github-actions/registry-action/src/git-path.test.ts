import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { findGit, GIT_PATHS, gitExecutable, resolveGit } from "./git-path.ts";

describe("git-path", () => {
  test("every fixed location is absolute, so git is never looked up on PATH", () => {
    for (const paths of Object.values(GIT_PATHS)) {
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) expect(posix.isAbsolute(p) || win32.isAbsolute(p)).toBe(true);
    }
  });

  test("the first existing fixed location wins, in table order", () => {
    expect(findGit("linux", () => true)).toBe("/usr/bin/git");
    expect(findGit("linux", (p) => p === "/usr/local/bin/git")).toBe("/usr/local/bin/git");
    expect(findGit("darwin", (p) => p === "/usr/bin/git")).toBe("/usr/bin/git");
    expect(findGit("win32", () => true)).toBe(String.raw`C:\Program Files\Git\cmd\git.exe`);
  });

  test("no fixed location is undefined from findGit and an error naming the paths from resolveGit", () => {
    expect(findGit("linux", () => false)).toBeUndefined();
    expect(() => resolveGit("linux", () => false)).toThrow(
      "git: not found at any fixed location (/usr/bin/git, /usr/local/bin/git); it is never looked up on PATH",
    );
    expect(() => resolveGit("aix", () => true)).toThrow(
      "git: no fixed git location is known for platform aix",
    );
  });

  test("the process git is one of this platform's fixed locations and exists", () => {
    const git = gitExecutable();
    expect(GIT_PATHS[process.platform]).toContain(git);
    expect(existsSync(git)).toBe(true);
    expect(gitExecutable()).toBe(git);
  });
});
