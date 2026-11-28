import { afterAll, describe, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { dirent, fakeFs } from "../../../test/helpers/iac-module-git-fake-fs.ts";
import { removeInitModuleGits } from "./iac-runner/iac-module-git.ts";

// Review follow-up (2026-11-27): the module `.git` removal never changes or enters anything a link
// leads to. The chmod walk runs on Windows only (git marks its object files read-only there; on
// POSIX unlinking needs write on the parent folder, which git's folders already have), and on
// Windows each path is lstat'd again right before it is changed or listed.

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-iac-module-git-links-")));
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("a link inside the new .git, on the real disk", () => {
  test("the link's target keeps its contents and its modes; the .git itself is removed", () => {
    const target = join(root, "target");
    mkdirSync(join(target, "sub"), { recursive: true });
    const secret = join(target, "secret.txt");
    const nested = join(target, "sub", "nested.txt");
    writeFileSync(secret, "keep me");
    writeFileSync(nested, "me too");
    // Modes the walk would change if it followed the link: read-only (the read-only attribute on
    // Windows), and a folder mode other than 0700.
    chmodSync(secret, 0o444);
    chmodSync(nested, 0o444);
    if (process.platform !== "win32") chmodSync(join(target, "sub"), 0o755);
    const modes = (): number[] =>
      [secret, nested, join(target, "sub"), target].map((p) => statSync(p).mode);
    const before = modes();

    const work = join(root, "work");
    const git = join(work, ".terraform", "modules", "m", ".git");
    mkdirSync(join(git, "objects"), { recursive: true });
    writeFileSync(join(git, "objects", "pack.pack"), "x");
    chmodSync(join(git, "objects", "pack.pack"), 0o444);
    symlinkSync(
      target,
      join(git, "objects", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(removeInitModuleGits(work, new Set(), process.platform)).toEqual({
      removed: ["m"],
      kept: [],
    });
    expect(existsSync(git)).toBe(false);
    expect(readFileSync(secret, "utf8")).toBe("keep me");
    expect(readFileSync(nested, "utf8")).toBe("me too");
    expect(modes()).toEqual(before);
  });
});

describe("the Windows chmod walk, on an injected filesystem", () => {
  const W = join(sep, "w");
  const G = join(W, ".terraform", "modules", "a", ".git");
  const listing = (): Record<string, Dirent[]> => ({
    [join(W, ".terraform", "modules")]: [dirent("a", "dir")],
    [join(W, ".terraform", "modules", "a")]: [dirent(".git", "dir")],
    [G]: [dirent("objects", "dir"), dirent("HEAD", "file")],
    [join(G, "objects")]: [dirent("pack", "file")],
  });

  test("a folder listed as a folder but a link when the walk reaches it is neither changed nor entered", () => {
    const tree = listing();
    const fs = fakeFs(tree);
    const lstat = fs.lstatKind;
    const swapped = {
      ...fs,
      lstatKind: (p: string) => (p === join(G, "objects") ? ("link" as const) : lstat(p)),
    };
    expect(removeInitModuleGits(W, new Set(), "win32", swapped).removed).toEqual(["a"]);
    expect(fs.touched).toEqual([G, join(G, "HEAD")]);
    expect(fs.listed).not.toContain(join(G, "objects"));
  });

  test("a file listed as a file but a link (or gone) when the walk reaches it is not changed", () => {
    const tree = listing();
    const fs = fakeFs(tree);
    const lstat = fs.lstatKind;
    const swapped = {
      ...fs,
      lstatKind: (p: string) => {
        if (p === join(G, "HEAD")) return "link" as const;
        if (p === join(G, "objects", "pack")) return undefined;
        return lstat(p);
      },
    };
    expect(removeInitModuleGits(W, new Set(), "win32", swapped).removed).toEqual(["a"]);
    expect(fs.touched).toEqual([G, join(G, "objects")]);
  });

  test("the .git itself turning into a link before the walk: nothing changed, nothing removed", () => {
    const fs = fakeFs(listing());
    let calls = 0;
    const lstat = fs.lstatKind;
    // The candidate listing sees a folder; the walk's own lstat, the second look, sees a link.
    const swapped = {
      ...fs,
      lstatKind: (p: string) => {
        if (p !== G) return lstat(p);
        calls += 1;
        return calls === 1 ? ("dir" as const) : ("link" as const);
      },
    };
    expect(removeInitModuleGits(W, new Set(), "win32", swapped)).toEqual({
      removed: [],
      kept: ["a"],
    });
    expect(fs.touched).toEqual([]);
    expect(fs.removed).toEqual([]);
  });

  test("on POSIX the walk does not run: nothing is changed, the tree is still removed", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const fs = fakeFs(listing());
      expect(removeInitModuleGits(W, new Set(), platform, fs).removed).toEqual(["a"]);
      expect(fs.touched).toEqual([]);
      expect(fs.listed).not.toContain(G);
      expect(fs.removed).toEqual([G]);
    }
  });
});
