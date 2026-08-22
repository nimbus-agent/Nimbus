#!/usr/bin/env bun
// scripts/ci/changed-files.ts — what this branch touched, as seen from `origin/main`.
//
// Shared by `platform-test-gaps.ts` and `changed-test-targets.ts`. Extracted rather than copied:
// the two had identical git plumbing, and `duplication (jscpd)` is a preflight gate.

function git(args: readonly string[]): string {
  const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : "";
}

function lines(raw: string): string[] {
  return raw.split("\n").filter((f) => f.trim().length > 0);
}

/**
 * Files added or modified on this branch, including uncommitted and untracked ones.
 *
 * `--diff-filter=d` drops deletions: a deleted file cannot be scanned or tested, and passing one
 * to `bun test` is an error rather than a no-op.
 *
 * Falls back to the working-tree diff when no merge base resolves (detached HEAD, a fresh clone
 * with no `origin`), and to an EMPTY list rather than the whole repo. Returning everything would
 * turn a targeted tool into a full-suite run at exactly the moment the caller wanted the narrow
 * one — silently, and only in the degraded case.
 */
export function changedFiles(): string[] {
  const base = git(["merge-base", "HEAD", "origin/main"]) || git(["merge-base", "HEAD", "main"]);
  const tracked = lines(
    base
      ? git(["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`])
      : git(["diff", "--name-only", "--diff-filter=d", "HEAD"]),
  );
  const uncommitted = lines(git(["diff", "--name-only", "--diff-filter=d", "HEAD"]));
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]));
  return [...new Set([...tracked, ...uncommitted, ...untracked])];
}
