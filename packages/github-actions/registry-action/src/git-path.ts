/**
 * Where `git` is run from: one of a few fixed, root-owned install locations, never looked up on
 * `PATH`. An earlier step in the job (or a `GITHUB_PATH` write) can prepend any directory to
 * `PATH`, and the `sign` mode runs git against the registry's content boundary with the job's push
 * credential in the checkout's config, so a `git` resolved from `PATH` would be whatever that step
 * put first. This is the same rule `provenance.ts` applies to `gh` (`resolveGh`).
 *
 * Unlike `gh`, git is not optional: every mode reads the registry from its git tree, so a runner
 * with git nowhere in this table fails with a message naming the paths tried. The generated
 * registry workflows run on `ubuntu-24.04`, whose image installs git at `/usr/bin/git`; the macOS
 * and Windows entries are the standard installer locations, for the action's tests on a developer
 * machine.
 */
import { existsSync } from "node:fs";

/** The fixed git locations per `process.platform`, tried in order. */
export const GIT_PATHS: Readonly<Record<string, readonly string[]>> = {
  linux: ["/usr/bin/git", "/usr/local/bin/git"],
  darwin: ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"],
  win32: [
    String.raw`C:\Program Files\Git\cmd\git.exe`,
    String.raw`C:\Program Files\Git\bin\git.exe`,
  ],
};

/** The first fixed git location that exists on `platform`, or `undefined`. */
export function findGit(
  platform: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return (GIT_PATHS[platform] ?? []).find((p) => exists(p));
}

/** The git to run on `platform`; throws, naming every path tried, when none exists. */
export function resolveGit(
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const found = findGit(platform, exists);
  if (found !== undefined) return found;
  const tried = GIT_PATHS[platform] ?? [];
  throw new Error(
    tried.length === 0
      ? `git: no fixed git location is known for platform ${platform}`
      : `git: not found at any fixed location (${tried.join(", ")}); it is never looked up on PATH`,
  );
}

let cached: string | undefined;

/** `resolveGit()` for this process, resolved once on first use. */
export function gitExecutable(): string {
  cached ??= resolveGit();
  return cached;
}
