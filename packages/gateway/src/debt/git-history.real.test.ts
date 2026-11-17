import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import { readGitHistory } from "./git-history.ts";

/** The real `git` against a repository built in a temp directory with fixed commit dates. */

const OLD = "2020-01-02T03:04:05Z";
const NEW = "2026-02-03T04:05:06Z";

function git(cwd: string, date: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-C", cwd, "-c", "commit.gpgsign=false", ...args], {
    env: extensionProcessEnv({
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@x.dev",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@x.dev",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    }),
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

let base = "";
let repo = "";
let shallow = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "nimbus-debt-git-"));
  repo = join(base, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  git(repo, OLD, "init", "-q");
  writeFileSync(join(repo, "old.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "sub", "inner.ts"), "export const b = 1;\n");
  writeFileSync(join(repo, "sp ace é.ts"), "export const c = 1;\n");
  git(repo, OLD, "add", "-A");
  git(repo, OLD, "commit", "-q", "-m", "first");
  writeFileSync(join(repo, "sub", "inner.ts"), "export const b = 2;\n");
  writeFileSync(join(repo, "new.ts"), "export const d = 1;\n");
  git(repo, NEW, "add", "-A");
  git(repo, NEW, "commit", "-q", "-m", "second");
  writeFileSync(join(repo, "untracked.ts"), "x\n");

  shallow = join(base, "shallow");
  git(base, NEW, "clone", "-q", "--depth", "1", pathToFileURL(repo).href, shallow);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("readGitHistory against a real repository", () => {
  test("tracked files and their newest commit time; an untracked file is never listed", async () => {
    const r = await readGitHistory(repo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const h = r.history;
    expect(h.prefix).toBe("");
    expect(h.complete).toBe(true);
    expect(h.oldestCommitMs).toBe(Date.parse(OLD));
    expect(h.lastTouchMs.get("old.ts")).toBe(Date.parse(OLD));
    expect(h.lastTouchMs.get("new.ts")).toBe(Date.parse(NEW));
    expect(h.lastTouchMs.get("sub/inner.ts")).toBe(Date.parse(NEW));
    expect(h.tracked.has("untracked.ts")).toBe(false);
  });

  test("a non-ASCII, spaced name round-trips unquoted in both lists", async () => {
    const r = await readGitHistory(repo);
    if (!r.ok) throw new Error("expected ok");
    const name = "sp ace é.ts";
    expect(r.history.tracked.has(name)).toBe(true);
    expect(r.history.lastTouchMs.get(name)).toBe(Date.parse(OLD));
  });

  test("a root inside the repository reports its prefix and root-relative paths", async () => {
    const r = await readGitHistory(join(repo, "sub"));
    if (!r.ok) throw new Error("expected ok");
    expect(r.history.prefix).toBe("sub/");
    expect([...r.history.tracked]).toEqual(["inner.ts"]);
    expect(r.history.lastTouchMs.get("inner.ts")).toBe(Date.parse(NEW));
    expect(r.history.lastTouchMs.has("old.ts")).toBe(false);
  });

  test("a shallow clone is refused, and a plain directory is not a repository", async () => {
    expect(await readGitHistory(shallow)).toEqual({ ok: false, reason: "shallow" });
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(await readGitHistory(plain)).toMatchObject({ ok: false });
  });
});
