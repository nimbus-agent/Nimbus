import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertSafeTreePath,
  diffTree,
  fetchRefs,
  findMergeBase,
  listTreeEntries,
  REGISTRY_NOT_INITIALISED,
  readBlob,
} from "./git-tree.ts";

const GIT_CONFIG = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
];

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-action-git-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_CONFIG, ...args], {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

function write(repo: string, rel: string, content: string | Uint8Array): void {
  const p = join(repo, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function commitAll(repo: string, message: string): string {
  git(repo, "add", "-A");
  return commitIndex(repo, message);
}

/** Commit the index as staged (an `add -A` would drop entries that have no file on disk). */
function commitIndex(repo: string, message: string): string {
  git(repo, "commit", "-q", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
}

function newRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  return repo;
}

/** Stage an index entry of `mode` at `path` with no file on disk (works without symlink rights). */
function stageEntry(repo: string, mode: string, sha: string, path: string): void {
  git(repo, "update-index", "--add", "--cacheinfo", `${mode},${sha},${path}`);
}

function hashBlob(repo: string, content: string): string {
  const p = join(tmp, "blob-input");
  writeFileSync(p, content);
  return git(repo, "hash-object", "-w", p).trim();
}

describe("listTreeEntries / readBlob", () => {
  test("lists regular files with their mode and blob, and reads committed bytes exactly", () => {
    const repo = newRepo("r");
    const bytes = new Uint8Array([0, 1, 13, 10, 255]);
    write(repo, "extensions/acme/1.0.0/package.tgz", bytes);
    write(repo, "extensions/acme/1.0.0/manifest.json", "{}\r\n");
    write(repo, "README.md", "hi");
    commitAll(repo, "c1");

    const entries = listTreeEntries("HEAD", "extensions/", { cwd: repo });
    expect(entries.map((e) => e.path)).toEqual([
      "extensions/acme/1.0.0/manifest.json",
      "extensions/acme/1.0.0/package.tgz",
    ]);
    for (const e of entries) {
      expect(e.mode).toBe("100644");
      expect(e.blob).toMatch(/^[0-9a-f]{40,64}$/);
    }
    expect(listTreeEntries("HEAD", "", { cwd: repo }).map((e) => e.path)).toContain("README.md");
    expect(readBlob("HEAD", "extensions/acme/1.0.0/package.tgz", { cwd: repo })).toEqual(bytes);
    expect(
      new TextDecoder().decode(
        readBlob("HEAD", "extensions/acme/1.0.0/manifest.json", { cwd: repo }),
      ),
    ).toBe("{}\r\n");
  });

  test("git-tree refuses a symlink and a submodule entry", () => {
    const repo = newRepo("r");
    write(repo, "extensions/acme/1.0.0/manifest.json", "{}");
    const head = commitAll(repo, "c1");
    const target = hashBlob(repo, "../../../../etc/passwd");

    stageEntry(repo, "120000", target, "extensions/acme/1.0.0/package.tgz");
    const withLink = commitIndex(repo, "symlink");
    expect(() => listTreeEntries(withLink, "extensions/", { cwd: repo })).toThrow(
      /extensions\/acme\/1\.0\.0\/package\.tgz: git mode 120000 is not a regular file/,
    );

    git(repo, "rm", "-q", "--cached", "extensions/acme/1.0.0/package.tgz");
    stageEntry(repo, "160000", head, "extensions/acme/1.0.0/vendor");
    const withSubmodule = commitIndex(repo, "submodule");
    expect(() => listTreeEntries(withSubmodule, "extensions/", { cwd: repo })).toThrow(
      /git mode 160000 is not a regular file/,
    );
  });

  test("refuses an executable file under extensions/", () => {
    const repo = newRepo("r");
    stageEntry(repo, "100755", hashBlob(repo, "#!/bin/sh"), "extensions/acme/1.0.0/manifest.json");
    const c = commitIndex(repo, "exec");
    expect(() => listTreeEntries(c, "", { cwd: repo })).toThrow(/git mode 100755/);
  });

  test("a symlink outside extensions/ is listed, not refused", () => {
    const repo = newRepo("r");
    stageEntry(repo, "120000", hashBlob(repo, "README.md"), "docs/link");
    const c = commitIndex(repo, "link");
    expect(listTreeEntries(c, "", { cwd: repo })).toEqual([
      expect.objectContaining({ mode: "120000", path: "docs/link" }),
    ]);
  });

  test("refuses an unsafe revision or path before running git", () => {
    const repo = newRepo("r");
    expect(() => readBlob("--output=x", "a", { cwd: repo })).toThrow(/unsafe revision/);
    expect(() => readBlob("HEAD", "../a", { cwd: repo })).toThrow(/unsafe path/);
    expect(() => listTreeEntries("HEAD", "../", { cwd: repo })).toThrow(/unsafe path/);
  });
});

describe("assertSafeTreePath", () => {
  test.each([
    ["", "empty"],
    ["/abs", "absolute"],
    ["C:x", "drive letter"],
    ["a\\b", "backslash"],
    ["a//b", "empty segment"],
    ["a/./b", "dot segment"],
    ["a/../b", "dot-dot segment"],
    ["a/b/", "trailing slash"],
    ["a/\u0001b", "control character"],
  ])("refuses %p (%s)", (p) => {
    expect(() => assertSafeTreePath(p)).toThrow(/unsafe path/);
  });

  test("accepts a plain relative path", () => {
    expect(() => assertSafeTreePath("extensions/acme/1.0.0/manifest.json")).not.toThrow();
  });
});

/** A bare `origin` with `main`, and a working clone of it. */
function originAndClone(): { origin: string; clone: string } {
  const src = newRepo("src");
  write(src, "nimbus-registry.json", "{}");
  commitAll(src, "init");
  const origin = join(tmp, "origin.git");
  git(tmp, "clone", "-q", "--bare", src, origin);
  const clone = join(tmp, "clone");
  git(tmp, "clone", "-q", pathToFileURL(origin).href, clone);
  return { origin, clone };
}

describe("fetchRefs", () => {
  test("a missing gh-pages says the registry is not initialised", () => {
    const { clone } = originAndClone();
    expect(() => fetchRefs(["main", "gh-pages"], { cwd: clone })).toThrow(REGISTRY_NOT_INITIALISED);
  });

  test("fetches origin/<ref> for every ref once gh-pages exists", () => {
    const { origin, clone } = originAndClone();
    const pages = newRepo("pages");
    git(pages, "checkout", "-q", "-b", "gh-pages");
    write(pages, "index.json", "{}");
    const pagesHead = commitAll(pages, "site");
    git(pages, "push", "-q", pathToFileURL(origin).href, "gh-pages");

    fetchRefs(["main", "gh-pages"], { cwd: clone });
    expect(git(clone, "rev-parse", "origin/gh-pages").trim()).toBe(pagesHead);
    expect(
      new TextDecoder().decode(readBlob("origin/gh-pages", "index.json", { cwd: clone })),
    ).toBe("{}");
  });

  test("any other failure names the refs and git's error", () => {
    const { clone } = originAndClone();
    expect(() => fetchRefs(["no-such-branch"], { cwd: clone })).toThrow(
      /git fetch no-such-branch failed: .*no-such-branch/,
    );
  });

  test("refuses a branch name git could read as an option or a refspec", () => {
    const { clone } = originAndClone();
    for (const bad of ["-x", "a:b", "a..b", "", "/a", "a/"]) {
      expect(() => fetchRefs([bad], { cwd: clone })).toThrow(/unsafe branch name/);
    }
  });
});

describe("findMergeBase", () => {
  /** origin: main = c1..c5; feature branches from c2 with f1, f2. Cloned with depth 1. */
  function divergedShallowClone(): { clone: string; c2: string } {
    const src = newRepo("src");
    write(src, "f", "1");
    commitAll(src, "c1");
    write(src, "f", "2");
    const c2 = commitAll(src, "c2");
    git(src, "checkout", "-q", "-b", "feature");
    write(src, "g", "1");
    commitAll(src, "f1");
    write(src, "g", "2");
    commitAll(src, "f2");
    git(src, "checkout", "-q", "main");
    for (const n of ["3", "4", "5"]) {
      write(src, "f", n);
      commitAll(src, `c${n}`);
    }
    const clone = join(tmp, "clone");
    git(
      tmp,
      "clone",
      "-q",
      "--depth=1",
      "--no-single-branch",
      "--branch",
      "feature",
      pathToFileURL(src).href,
      clone,
    );
    return { clone, c2 };
  }

  test("deepens a shallow clone until the merge base is present", () => {
    const { clone, c2 } = divergedShallowClone();
    const base = findMergeBase("origin/main", "HEAD", {
      cwd: clone,
      deepen: ["main", "feature"],
      step: 1,
      maxRounds: 10,
    });
    expect(base).toBe(c2);
  });

  test("gives up after the bounded number of rounds", () => {
    const { clone } = divergedShallowClone();
    expect(() =>
      findMergeBase("origin/main", "HEAD", {
        cwd: clone,
        deepen: ["main", "feature"],
        step: 1,
        maxRounds: 1,
      }),
    ).toThrow(/no merge base of origin\/main and HEAD within 1 rounds/);
  });

  test("a complete history without a common commit fails at once", () => {
    const repo = newRepo("r");
    commitAll(repo, "a");
    git(repo, "checkout", "-q", "--orphan", "other");
    commitAll(repo, "b");
    expect(() => findMergeBase("main", "other", { cwd: repo, deepen: [] })).toThrow(
      /main and other have no common history/,
    );
  });
});

describe("diffTree", () => {
  test("reports added, modified and deleted files with the to-side mode", () => {
    const repo = newRepo("r");
    write(repo, "keep", "1");
    write(repo, "gone", "1");
    const from = commitAll(repo, "c1");
    write(repo, "keep", "2");
    rmSync(join(repo, "gone"));
    write(repo, "extensions/acme/1.0.0/manifest.json", "{}");
    const to = commitAll(repo, "c2");

    const changes = diffTree(from, to, { cwd: repo });
    expect(changes).toEqual([
      { status: "A", path: "extensions/acme/1.0.0/manifest.json", mode: "100644" },
      { status: "D", path: "gone", mode: "000000" },
      { status: "M", path: "keep", mode: "100644" },
    ]);
    expect(diffTree(to, to, { cwd: repo })).toEqual([]);
  });
});
