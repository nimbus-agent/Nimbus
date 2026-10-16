#!/usr/bin/env bun
// scripts/ci/release-only-diff.ts — is a release-please PR a version bump and nothing else?
//
// Every merge to `main` makes release-please rewrite its release PR, and every rewrite ran the
// whole PR gate: 137 of the 446 PR runs in the 30 days to 2026-10-16 (31%) were the release PR,
// re-testing code `main`'s own push run had just tested on three OSes. In those 137 runs not one
// red was caused by the release diff — all 8 were flaky tests (6 on the macOS/Windows legs). The
// tag's own Release workflow runs the full Ubuntu suite again before it builds anything.
//
// So `ci.yml` lets a release PR skip the test jobs when, and only when, this says its diff touches
// nothing but release-please's own files, and in those files changes nothing but version strings
// (plus whatever it writes into the changelog). Everything else — any other file, a new, deleted,
// renamed or binary file, any line whose change is more than a version string, an empty diff, an
// unreadable config — is a full run. Fail-safe, not fail-open: an error prints `false`.
//
// The workflow runs THIS FILE AS IT IS ON THE PR's BASE, and reads the config from the base too,
// so the PR being judged cannot edit the judge or widen what counts as release-managed. That is
// why this file imports nothing relative: it is executed from a temporary copy.
//
// Usage: bun release-only-diff.ts <base-sha> <head-sha>
//   prints `release-only=true|false` (a `$GITHUB_OUTPUT` line); the reason goes to stderr.

export interface ManagedFiles {
  /** Files whose changes must be version strings only. */
  readonly versionFiles: ReadonlySet<string>;
  /** Files release-please writes prose into; any change is accepted. */
  readonly changelogs: ReadonlySet<string>;
}

export interface Classification {
  readonly releaseOnly: boolean;
  readonly reason: string;
}

const MANIFEST = ".release-please-manifest.json";
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The files release-please manages, from its config (`.release-please-config.json`). */
export function releaseManagedFiles(config: unknown): ManagedFiles {
  const versionFiles = new Set<string>([MANIFEST]);
  const changelogs = new Set<string>();
  const packages = isRecord(config) && isRecord(config["packages"]) ? config["packages"] : {};
  for (const [path, raw] of Object.entries(packages)) {
    const pkg = isRecord(raw) ? raw : {};
    const prefix = path === "." ? "" : `${path.replace(/\/+$/, "")}/`;
    versionFiles.add(`${prefix}package.json`);
    const changelog = pkg["changelog-path"];
    changelogs.add(`${prefix}${typeof changelog === "string" ? changelog : "CHANGELOG.md"}`);
    const extras = Array.isArray(pkg["extra-files"]) ? pkg["extra-files"] : [];
    for (const extra of extras) {
      const file = typeof extra === "string" ? extra : isRecord(extra) ? extra["path"] : undefined;
      if (typeof file === "string") versionFiles.add(`${prefix}${file}`);
    }
  }
  return { versionFiles, changelogs };
}

/** True when the removed and added lines are the same lines once every version string is masked. */
export function isVersionOnlyChange(removed: readonly string[], added: readonly string[]): boolean {
  if (removed.length !== added.length) return false;
  const mask = (lines: readonly string[]) => lines.map((l) => l.replaceAll(VERSION, "<v>")).sort();
  const a = mask(removed);
  const b = mask(added);
  return a.every((line, i) => line === b[i]);
}

interface FileChange {
  path: string | undefined;
  unsafe: string | undefined;
  removed: string[];
  added: string[];
}

const UNSAFE_MARKERS = [
  "new file mode",
  "deleted file mode",
  "rename from",
  "rename to",
  "copy from",
  "copy to",
  "old mode",
  "new mode",
  "Binary files",
  "GIT binary patch",
];

function parseDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let current: FileChange | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      current = {
        path: m !== null && m[1] === m[2] ? m[1] : undefined,
        unsafe: m === null ? "a path git had to quote" : m[1] !== m[2] ? "a rename" : undefined,
        removed: [],
        added: [],
      };
      files.push(current);
    } else if (current === undefined) {
    } else if (UNSAFE_MARKERS.some((marker) => line.startsWith(marker))) {
      current.unsafe ??= line;
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    } else if (line.startsWith("-")) {
      current.removed.push(line.slice(1));
    } else if (line.startsWith("+")) {
      current.added.push(line.slice(1));
    }
  }
  return files;
}

/** Whether a `git diff --unified=0` touches only release-managed files, and only their versions. */
export function classifyDiff(diff: string, managed: ManagedFiles): Classification {
  const files = parseDiff(diff);
  if (files.length === 0) return { releaseOnly: false, reason: "the diff is empty" };
  for (const f of files) {
    const name = f.path ?? "(unparseable path)";
    if (f.unsafe !== undefined) return { releaseOnly: false, reason: `${name}: ${f.unsafe}` };
    if (f.path === undefined) return { releaseOnly: false, reason: "an unparseable diff header" };
    if (managed.changelogs.has(f.path)) continue;
    if (!managed.versionFiles.has(f.path)) {
      return { releaseOnly: false, reason: `${f.path} is not a release-managed file` };
    }
    if (!isVersionOnlyChange(f.removed, f.added)) {
      return { releaseOnly: false, reason: `${f.path} changes more than a version string` };
    }
  }
  return {
    releaseOnly: true,
    reason: `${String(files.length)} file(s), every change a version bump or a changelog entry`,
  };
}

function git(args: readonly string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${String(r.exitCode)}: ${r.stderr.toString()}`);
  }
  return r.stdout.toString();
}

function main(argv: readonly string[]): void {
  const [base, head] = argv;
  let result: Classification;
  try {
    if (base === undefined || head === undefined) throw new Error("usage: <base-sha> <head-sha>");
    const config: unknown = JSON.parse(git(["show", `${base}:.release-please-config.json`]));
    const diff = git([
      "diff",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      base,
      head,
    ]);
    result = classifyDiff(diff, releaseManagedFiles(config));
  } catch (err) {
    result = {
      releaseOnly: false,
      reason: `error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  console.log(`release-only=${String(result.releaseOnly)}`);
  console.error(`release-only-diff: ${String(result.releaseOnly)} — ${result.reason}`);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
