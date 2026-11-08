// packages/gateway/src/connectors/connector-writes/commit-paths.ts
// The MODEL door's refusals for a multi-file commit (Phase 9.7 D1c, owner ruling 1 of 2026-11-08):
// a commit that touches a file which runs code with the repository's secrets, or decides who reviews
// a change, or whose content looks like a credential, is refused before any read or prompt. The
// owner's own doors are not restricted. Pure and fixed-text: nothing of the input is echoed.
//
// STATED BOUND: the path table is a LIST, not a proof. A build file the list omits (`Makefile`,
// `package.json` scripts, `Dockerfile`, a CI product the list does not name) also runs code; the
// owner can still commit those, and the model door's diff is shown in full either way.
import { SECRET_PATTERNS } from "../../security/secret-patterns.ts";
import {
  COMMIT_INPUT_REFUSALS,
  commitSizeRefusal,
  isSafeCommitPathGateway,
} from "./commit-limits.ts";

export const COMMIT_PATH_REFUSAL =
  "the model cannot commit a CI, workflow, hook or review-rule file; ask the owner to commit it";
export const COMMIT_CREDENTIAL_REFUSAL =
  "the model cannot commit text that looks like a credential; remove it and use the platform's secret store";

export const COMMIT_BIDI_REFUSAL =
  "the model cannot commit text with a bidirectional control character (it can make code read differently from what it does)";

/** Trojan Source: U+061C, U+200E, U+200F, U+202A-202E, U+2066-2069. The owner's own doors show it escaped. */
const BIDI_CONTROL = /\p{Bidi_Control}/u;

/** The two multi-file commit writes (the only rows these refusals apply to). */
export const COMMIT_WRITE_TOOL_IDS: ReadonlySet<string> = new Set([
  "github_file_commit",
  "gitlab_commit_create",
]);

/** `a.yml` and `a.yaml`: both spellings of one CI file. */
function bothYaml(base: string): readonly string[] {
  return [`${base}.yml`, `${base}.yaml`];
}

/**
 * Paths (lower-case, no trailing slash) the model may not commit, with the reason each is here. A
 * path matches an entry when, compared case-insensitively, it equals the entry or starts with
 * `entry + "/"`, so `.github/workflowsx/a.yml` is NOT matched by `.github/workflows`.
 */
export const COMMIT_REFUSED_PATHS: ReadonlyArray<{ readonly entry: string; readonly why: string }> =
  Object.freeze(
    [
      {
        entry: ".github/workflows",
        why: "GitHub Actions workflows run with the repository's secrets",
      },
      { entry: ".github/actions", why: "local GitHub composite actions run inside workflows" },
      ...bothYaml(".gitlab-ci").map((entry) => ({ entry, why: "GitLab CI pipeline" })),
      { entry: ".gitlab/ci", why: "GitLab CI includes" },
      { entry: ".circleci", why: "CircleCI pipeline" },
      { entry: "jenkinsfile", why: "Jenkins pipeline" },
      ...bothYaml("azure-pipelines").map((entry) => ({ entry, why: "Azure Pipelines" })),
      { entry: ".azure-pipelines", why: "Azure Pipelines templates" },
      ...bothYaml("bitbucket-pipelines").map((entry) => ({ entry, why: "Bitbucket Pipelines" })),
      { entry: ".buildkite", why: "Buildkite pipeline" },
      ...bothYaml(".travis").map((entry) => ({ entry, why: "Travis CI" })),
      ...bothYaml(".drone").map((entry) => ({ entry, why: "Drone CI" })),
      { entry: ".husky", why: "git hooks run on a developer's machine" },
      { entry: ".githooks", why: "git hooks run on a developer's machine" },
      { entry: ".devcontainer", why: "dev containers run commands on open" },
      ...bothYaml(".pre-commit-config").map((entry) => ({
        entry,
        why: "pre-commit hooks run on a developer's machine",
      })),
      ...["lefthook", ".lefthook", "lefthook-local", ".lefthook-local"].flatMap((base) =>
        ["yml", "yaml", "json", "toml"].map((ext) => ({
          entry: `${base}.${ext}`,
          why: "lefthook git hooks run on a developer's machine",
        })),
      ),
      ...bothYaml(".cirrus").map((entry) => ({ entry, why: "Cirrus CI" })),
      ...bothYaml("appveyor").map((entry) => ({ entry, why: "AppVeyor" })),
      ...bothYaml(".appveyor").map((entry) => ({ entry, why: "AppVeyor" })),
      ...bothYaml(".woodpecker").map((entry) => ({ entry, why: "Woodpecker CI" })),
      { entry: ".woodpecker", why: "Woodpecker CI pipelines" },
      { entry: ".semaphore", why: "Semaphore CI" },
      ...bothYaml("cloudbuild").map((entry) => ({ entry, why: "Google Cloud Build" })),
      ...bothYaml("buildspec").map((entry) => ({ entry, why: "AWS CodeBuild" })),
      ...bothYaml("bitrise").map((entry) => ({ entry, why: "Bitrise" })),
      ...bothYaml("codemagic").map((entry) => ({ entry, why: "Codemagic" })),
      {
        entry: ".gitea/workflows",
        why: "Gitea Actions workflows run with the repository's secrets",
      },
      {
        entry: ".forgejo/workflows",
        why: "Forgejo Actions workflows run with the repository's secrets",
      },
    ].map((e) => Object.freeze(e)),
  );

/** Final path segments refused in ANY directory (lower-case): review rules and repository integrity. */
export const COMMIT_REFUSED_BASENAMES: ReadonlySet<string> = new Set([
  "codeowners",
  ".gitattributes",
  ".gitmodules",
]);

/** Whether the model may not commit `path` (a SAFE path: run {@link isSafeCommitPathGateway} first). */
export function isRefusedCommitPath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (COMMIT_REFUSED_BASENAMES.has(base)) return true;
  // Jenkins reads a `Jenkinsfile` (and `Jenkinsfile.release`, `Jenkinsfile-deploy`) in ANY directory.
  if (
    base === "jenkinsfile" ||
    base.startsWith("jenkinsfile.") ||
    base.startsWith("jenkinsfile-")
  ) {
    return true;
  }
  return COMMIT_REFUSED_PATHS.some((e) => lower === e.entry || lower.startsWith(`${e.entry}/`));
}

/** The longest run a credential pattern may match in one token class (see {@link boundedSource}). */
const TOKEN_RUN_MAX = 4096;

/**
 * A LINEAR-TIME copy of a shared pattern's source. The shared patterns have unbounded runs (`+`,
 * `{n,}`), so text like `eyJ-eyJ-eyJ-...` made each start rescan the whole rest (quadratic). Here
 * every unbounded run is capped at {@link TOKEN_RUN_MAX}, which bounds the work per start, and a
 * word boundary (`\b`) after an unbounded run is dropped (a prefix of a longer token is still a
 * credential-looking token, so nothing is lost by matching it). Fixed-length patterns are as is.
 */
function boundedSource(source: string): string {
  const unboundedEnd = /(?:\+|\{\d+,\})\\b$/u;
  const noTail = unboundedEnd.test(source) ? source.slice(0, -2) : source;
  return noTail
    .replaceAll(/\{(\d+),\}/gu, `{$1,${String(TOKEN_RUN_MAX)}}`)
    .replaceAll(/(\])\+/gu, `$1{1,${String(TOKEN_RUN_MAX)}}`);
}

/**
 * NON-GLOBAL, bounded clones of the high-confidence secret patterns, compiled once at load. The
 * shared `SECRET_PATTERNS` regexes are global (`lastIndex` state), so calling `.test()` on them
 * would make a second check of the same text depend on the first.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze(
  SECRET_PATTERNS.map(
    (p) => new RegExp(boundedSource(p.regex.source), p.regex.flags.replaceAll("g", "")),
  ),
);

/** Whether `text` looks like a credential by any high-confidence pattern. */
export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(text));
}

/** The number of compiled credential patterns (a test pins it to the shared table's length). */
export const CREDENTIAL_PATTERN_COUNT = CREDENTIAL_PATTERNS.length;

/**
 * The model-door refusal for a commit write, or `undefined`. Order: an unsafe path (the same
 * check as the input hook, run first so `./.github/workflows/x.yml` cannot slip past a prefix
 * check), a refused path, then credential-looking content. A malformed `files` returns
 * `undefined` here: the prepare step's input hook refuses it, fixed-text, before any read.
 */
export function commitModelRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!COMMIT_WRITE_TOOL_IDS.has(toolId)) return undefined;
  // The size caps FIRST: nothing below (path checks, the bidi and credential scans) runs on a
  // model input larger than the prepare step would ever accept.
  const tooLarge = commitSizeRefusal(input);
  if (tooLarge !== undefined) return tooLarge;
  const files: unknown = Object.hasOwn(input, "files") ? input["files"] : undefined;
  if (!Array.isArray(files)) return undefined;
  const entries = files as unknown[];
  const pairs: Array<{ path?: unknown; content?: unknown }> = entries.map((f) =>
    typeof f === "object" && f !== null ? (f as { path?: unknown; content?: unknown }) : {},
  );
  const paths = pairs.map((f) => f.path).filter((p): p is string => typeof p === "string");
  if (!paths.every(isSafeCommitPathGateway)) return COMMIT_INPUT_REFUSALS.pathUnsafe;
  if (paths.some(isRefusedCommitPath)) return COMMIT_PATH_REFUSAL;
  const contents = pairs.map((f) => f.content).filter((c): c is string => typeof c === "string");
  if (contents.some((c) => BIDI_CONTROL.test(c))) return COMMIT_BIDI_REFUSAL;
  const credential = pairs.some(
    (f) => typeof f.content === "string" && looksLikeCredential(f.content),
  );
  return credential ? COMMIT_CREDENTIAL_REFUSAL : undefined;
}
