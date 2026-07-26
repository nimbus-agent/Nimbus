# P2 Phase 2 — dependency-DAG edges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `audit:release-staleness` so it also fails when an npm package is tagged but never published, or when a consuming repo's lockfile-resolved dependency lags npm `@latest` past the grace window.

**Architecture:** The Phase 1 evaluation engine does not change. Shared primitives move to a new `_release-train-core.ts`; Phase 2's pure readers + evaluator live in `_release-train-dep.ts`; `check-release-staleness.ts` keeps the Phase 1 readers and the single `import.meta.main` shell, which now feeds both evaluators into the same `decideExit`.

**Tech Stack:** Bun v1.2+, TypeScript 6 strict, `gh` CLI, `fetch` against `registry.npmjs.org`, Biome. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-07-26-p2-phase2-dep-dag-design.md`](../specs/2026-07-26-p2-phase2-dep-dag-design.md) (+ its review doc).

## Global Constraints

- **Runtime:** Bun v1.2+, TypeScript 6.x strict. **No `any`** — narrow external JSON with `isRecord` from `_gh-audit.ts`.
- **`exactOptionalPropertyTypes: true`** is on. An optional field needs an explicit `?: T | undefined`; a bare `?: T` will not compile when assigned `undefined`.
- **Linter:** run `bunx biome check scripts .github docs` — **NOT** `bun run lint`, which reports "Checked 0 files" inside a `.claude/worktrees/` checkout and exits 1.
- **Branch:** all work on `dev/asafgolombek/p2-phase2-dep-dag` in the worktree `.claude/worktrees/p2-phase2-dep-dag`. Never commit on `main`. Verify with `git rev-parse --abbrev-ref HEAD` before the first commit.
- **Gate contract:** fail-soft locally, hard red under `--strict` / `GITHUB_ACTIONS`. Reuse `isStrict` / `strictSkip` from `_gh-audit.ts`.
- **`graceHours` default 6**, read from the manifest — never hard-code it.
- **Time:** UTC epoch-ms only, via the existing `ageHours()`. Never parse a timestamp lacking an explicit `Z`/offset.
- **Version compare:** `compareSemver()` only. `Bun.semver.order` throws on non-semver; `compareSemver` returns `null` instead and every caller must handle `null` as *indeterminate*.
- **Pre-push:** `bun test scripts/structure-audit/` and `bunx tsc -p scripts/tsconfig.json --noEmit` must pass.

---

## File Structure

- **Create** `scripts/structure-audit/_release-train-core.ts` — shared primitives moved verbatim out of `check-release-staleness.ts`: `stripV`, `compareSemver`, `ageHours`, and the types `EdgeVerdict` / `EdgeResult` / `ReleaseInfo` / `PublishedRelease`, plus `decideExit`. Exists to break the import cycle that would otherwise form between the Phase 1 file and the Phase 2 file.
- **Create** `scripts/structure-audit/_release-train-dep.ts` — Phase 2 pure readers + `evaluatePackage`. Imports only from `_release-train-core.ts` and `_gh-audit.ts`.
- **Create** `scripts/structure-audit/_release-train-dep.test.ts` — table-driven tests for every function in the above.
- **Modify** `scripts/structure-audit/check-release-staleness.ts` — re-export the moved primitives for compatibility, add `PackageSpec` to the manifest types, add the impure Phase 2 readers, wire the shell.
- **Modify** `scripts/structure-audit/check-release-staleness.test.ts` — manifest assertions for `packages[]`.
- **Modify** `.github/release-train.json` — add the `packages[]` array.
- **Modify** `docs/infrastructure-roadmap.md`, `docs/CHANGELOG.md` — record the delivery.

---

## Task 1: Extract shared primitives into `_release-train-core.ts`

Pure mechanical move. Phase 2 needs `compareSemver`/`ageHours`/`EdgeResult`; if it imported them from `check-release-staleness.ts` while that file imported Phase 2's evaluator, the two modules would form a cycle. Moving the primitives to a leaf module both files import makes the cycle impossible.

**Files:**

- Create: `scripts/structure-audit/_release-train-core.ts`
- Modify: `scripts/structure-audit/check-release-staleness.ts`
- Test: `scripts/structure-audit/check-release-staleness.test.ts` (unchanged — it is the safety net)

**Interfaces:**

- Produces: `stripV`, `compareSemver`, `ageHours`, `decideExit`, and types `EdgeVerdict`, `EdgeResult`, `ReleaseInfo`, `PublishedRelease` — all from `_release-train-core.ts`, signatures **identical** to their current form in `check-release-staleness.ts`.

- [ ] **Step 1: Record the green baseline**

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts`
Expected: PASS, 39 tests. Write the number down — Step 5 must match it exactly.

- [ ] **Step 2: Create the core module**

Create `scripts/structure-audit/_release-train-core.ts`. Move these **unchanged** out of `check-release-staleness.ts`: `stripV`, `compareSemver`, `ageHours`, `decideExit`, and the types `EdgeVerdict`, `EdgeResult`, `ReleaseInfo`, `PublishedRelease`. Do not alter a single line of their bodies — this task is a move, not a rewrite.

```ts
/**
 * Primitives shared by every release-train edge kind. This module is a LEAF:
 * it imports nothing from its siblings, which is what lets both the Phase 1
 * channel readers and the Phase 2 dependency readers depend on it without
 * forming an import cycle.
 */

export function stripV(version: string): string {
  return version.replace(/^v/, "");
}

/**
 * Semver ordering that never throws. `Bun.semver.order` throws on an unparseable
 * version ("Invalid SemVer: ..."), and channel files are external — a format
 * quirk must degrade to "indeterminate", not crash the whole audit. Returns
 * -1 | 0 | 1, or null when either side is not valid semver.
 */
export function compareSemver(a: string, b: string): number | null {
  try {
    return Bun.semver.order(stripV(a), stripV(b));
  } catch {
    return null;
  }
}

/**
 * Hours between an ISO-8601 (Z-suffixed) timestamp and now, UTC epoch-ms math.
 * An unparseable date yields `+Infinity` (fail-CLOSED): a NaN age would satisfy
 * `NaN > graceHours === false` and silently mask a phantom/stale state as "ok",
 * so an unreadable timestamp instead forces the aged-check to fire.
 */
export function ageHours(isoZ: string): number {
  const t = new Date(isoZ).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 3_600_000;
}

export interface ReleaseInfo {
  tag: string;
  prerelease: boolean;
  draft: boolean;
  assets: string[];
  publishedAt: string;
}
export interface PublishedRelease {
  version: string;
  publishedAt: string;
}

export type EdgeVerdict = "ok" | "stale" | "phantom" | "indeterminate";
export interface EdgeResult {
  edge: string;
  verdict: EdgeVerdict;
  detail: string;
}

/**
 * Exit decision. Any stale/phantom edge => red. Otherwise green with a warning
 * per indeterminate edge — EXCEPT a run where nothing was evaluable (no ok, only
 * indeterminate) under --strict is red: "indeterminate" must not read as "all
 * clear" in the scheduled sweep (the team-reachability rule).
 */
export function decideExit(
  results: EdgeResult[],
  strict: boolean,
): { code: 0 | 1; messages: string[] } {
  const messages: string[] = [];
  const hard = results.filter((r) => r.verdict === "phantom" || r.verdict === "stale");
  const indet = results.filter((r) => r.verdict === "indeterminate");
  const ok = results.filter((r) => r.verdict === "ok");
  for (const r of hard) messages.push(`::error::${r.edge}: ${r.detail}`);
  for (const r of indet) messages.push(`::warning::${r.edge}: ${r.detail} (indeterminate)`);
  if (hard.length > 0) return { code: 1, messages };
  if (ok.length === 0 && indet.length > 0 && strict) {
    messages.push(
      "::error::release-staleness: indeterminate — nothing could be evaluated (all reads failed transiently)",
    );
    return { code: 1, messages };
  }
  return { code: 0, messages };
}
```

- [ ] **Step 3: Re-export from `check-release-staleness.ts`**

Delete the moved definitions from `check-release-staleness.ts` and add this immediately below the existing `_gh-audit.ts` import. The re-export keeps the existing test file and any future importer working against the original module path — no test edits in this task.

```ts
export {
  ageHours,
  compareSemver,
  decideExit,
  type EdgeResult,
  type EdgeVerdict,
  type PublishedRelease,
  type ReleaseInfo,
  stripV,
} from "./_release-train-core.ts";
```

Then add a matching **import** line, because the file's own code still calls them:

```ts
import {
  ageHours,
  compareSemver,
  decideExit,
  type EdgeResult,
  type PublishedRelease,
  type ReleaseInfo,
  stripV,
} from "./_release-train-core.ts";
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc -p scripts/tsconfig.json --noEmit`
Expected: exit 0. A "declared but never read" error means a symbol was re-exported but is no longer used locally — drop it from the `import` line, keep it in the `export` line.

- [ ] **Step 5: Run the baseline tests — the count must be identical**

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts`
Expected: PASS with the **same 39 tests** as Step 1. A behaviour change here means the move was not verbatim.

- [ ] **Step 6: Commit**

```bash
bunx biome check scripts
git add scripts/structure-audit/_release-train-core.ts scripts/structure-audit/check-release-staleness.ts
git commit -m "refactor(audit): extract release-train primitives into a leaf core module"
```

---

## Task 2: Phase 2 pure readers

**Files:**

- Create: `scripts/structure-audit/_release-train-dep.ts`
- Test: `scripts/structure-audit/_release-train-dep.test.ts`

**Interfaces:**

- Consumes: `compareSemver`, `type ReleaseInfo`, `type PublishedRelease` from `_release-train-core.ts`; `isRecord` from `_gh-audit.ts`.
- Produces:
  - `interface NpmLatest { version: string; publishedAt: string }`
  - `parseNpmLatest(doc: string): NpmLatest | null`
  - `selectTaggedRelease(releases: readonly ReleaseInfo[], pattern: string): PublishedRelease | null`
  - `resolvedFromBunLock(text: string, pkg: string): string | null`
  - `interface PrRef { title: string; headRefName: string }`
  - `matchesBumpPr(prs: readonly PrRef[], pkg: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `scripts/structure-audit/_release-train-dep.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
  matchesBumpPr,
  parseNpmLatest,
  resolvedFromBunLock,
  selectTaggedRelease,
} from "./_release-train-dep.ts";

describe("parseNpmLatest", () => {
  const doc = JSON.stringify({
    "dist-tags": { latest: "0.12.1" },
    time: { "0.12.0": "2026-07-20T00:00:00Z", "0.12.1": "2026-07-24T12:36:40.942Z" },
  });
  test("reads dist-tags.latest and its publish time", () => {
    expect(parseNpmLatest(doc)).toEqual({
      version: "0.12.1",
      publishedAt: "2026-07-24T12:36:40.942Z",
    });
  });
  test("null when dist-tags is absent", () => {
    expect(parseNpmLatest(JSON.stringify({ time: {} }))).toBeNull();
  });
  test("null when the latest version has no time entry", () => {
    expect(
      parseNpmLatest(JSON.stringify({ "dist-tags": { latest: "1.0.0" }, time: {} })),
    ).toBeNull();
  });
  test("null on malformed JSON", () => {
    expect(parseNpmLatest("{not json")).toBeNull();
  });
});

describe("selectTaggedRelease", () => {
  const base = { draft: false, prerelease: false, assets: [] as string[] };
  const P = "^sdk-v(\\d+\\.\\d+\\.\\d+)$";
  test("picks the highest component-prefixed tag and returns its publish time", () => {
    const r = selectTaggedRelease(
      [
        { ...base, tag: "sdk-v1.5.2", publishedAt: "2026-07-01T00:00:00Z" },
        { ...base, tag: "sdk-v1.6.0", publishedAt: "2026-07-10T00:00:00Z" },
      ],
      P,
    );
    expect(r).toEqual({ version: "1.6.0", publishedAt: "2026-07-10T00:00:00Z" });
  });
  test("ignores tags that do not match the pattern", () => {
    const r = selectTaggedRelease(
      [
        { ...base, tag: "v9.9.9", publishedAt: "2026-07-10T00:00:00Z" },
        { ...base, tag: "client-v0.1.0", publishedAt: "2026-07-10T00:00:00Z" },
        { ...base, tag: "sdk-v1.0.0", publishedAt: "2026-07-01T00:00:00Z" },
      ],
      P,
    );
    expect(r?.version).toBe("1.0.0");
  });
  test("skips drafts and prereleases", () => {
    const r = selectTaggedRelease(
      [
        { ...base, tag: "sdk-v2.0.0", draft: true, publishedAt: "2026-07-10T00:00:00Z" },
        { ...base, tag: "sdk-v1.9.0", prerelease: true, publishedAt: "2026-07-10T00:00:00Z" },
        { ...base, tag: "sdk-v1.6.0", publishedAt: "2026-07-01T00:00:00Z" },
      ],
      P,
    );
    expect(r?.version).toBe("1.6.0");
  });
  test("null when nothing matches", () => {
    expect(selectTaggedRelease([{ ...base, tag: "v1.0.0", publishedAt: "x" }], P)).toBeNull();
  });
});

describe("resolvedFromBunLock", () => {
  // Mirrors the real bun.lock shape: workspaces carry RANGES, packages carry
  // resolutions whose element [0] is "<name>@<version>". Trailing commas are
  // legal in a real bun.lock, so one is included deliberately.
  const lock = `{
    "lockfileVersion": 1,
    "workspaces": {
      "": { "name": "nimbus" },
      "packages/cli": { "name": "@nimbus/cli", "dependencies": { "@nimbus-dev/sdk": "^1.5.0" } },
      "packages/mcp-connectors/github": { "name": "nimbus-mcp-github" },
    },
    "packages": {
      "@nimbus-dev/sdk": ["@nimbus-dev/sdk@1.6.0", "", {}, "sha512-aaa"],
      "nimbus-mcp-github/@nimbus-dev/sdk": ["@nimbus-dev/sdk@1.4.0", "", {}, "sha512-bbb"],
      "@nimbus-dev/client/@nimbus-dev/sdk": ["@nimbus-dev/sdk@1.3.0", "", {}, "sha512-ccc"],
    },
  }`;

  test("takes the minimum across our OWN workspaces, ignoring third-party nesting", () => {
    // 1.4.0 (our workspace) wins over 1.6.0 (hoisted); 1.3.0 is nested under the
    // external @nimbus-dev/client and must NOT count.
    expect(resolvedFromBunLock(lock, "@nimbus-dev/sdk")).toBe("1.4.0");
  });

  test("hoisted-only lockfile returns the hoisted version", () => {
    const simple = `{
      "workspaces": { "": { "name": "x" } },
      "packages": { "@nimbus-dev/sdk": ["@nimbus-dev/sdk@1.6.0", "", {}, "sha512-a"] }
    }`;
    expect(resolvedFromBunLock(simple, "@nimbus-dev/sdk")).toBe("1.6.0");
  });

  test("a range in the workspaces section is never read as a resolution", () => {
    // The only mention of the package is a "^1.5.0" range — no resolution entry.
    const rangeOnly = `{
      "workspaces": { "p": { "name": "p", "dependencies": { "@nimbus-dev/sdk": "^1.5.0" } } },
      "packages": {}
    }`;
    expect(resolvedFromBunLock(rangeOnly, "@nimbus-dev/sdk")).toBeNull();
  });

  test("null when the package is absent entirely", () => {
    expect(resolvedFromBunLock(lock, "@nimbus-dev/nope")).toBeNull();
  });

  test("null on unparseable lockfile", () => {
    expect(resolvedFromBunLock("{not json", "@nimbus-dev/sdk")).toBeNull();
  });
});

describe("matchesBumpPr", () => {
  const pkg = "@nimbus-dev/sdk";
  test("matches the full package name in a title", () => {
    expect(matchesBumpPr([{ title: "Bump @nimbus-dev/sdk from 1.5.0 to 1.6.0", headRefName: "x" }], pkg)).toBe(true);
  });
  test("matches the short name in a title, case-insensitively", () => {
    expect(matchesBumpPr([{ title: "chore(deps): upgrade SDK to 1.6.0", headRefName: "x" }], pkg)).toBe(true);
  });
  test("matches the branch name when the title does not mention it", () => {
    expect(matchesBumpPr([{ title: "chore: deps", headRefName: "dependabot/npm_and_yarn/nimbus-dev/sdk-1.6.0" }], pkg)).toBe(true);
  });
  test("an unrelated open PR does not count as an in-flight bump", () => {
    expect(matchesBumpPr([{ title: "fix: typo in README", headRefName: "fix/readme" }], pkg)).toBe(false);
  });
  test("no open PRs => false", () => {
    expect(matchesBumpPr([], pkg)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/structure-audit/_release-train-dep.test.ts`
Expected: FAIL — module `./_release-train-dep.ts` does not exist.

- [ ] **Step 3: Implement**

Create `scripts/structure-audit/_release-train-dep.ts`:

```ts
/**
 * P2 Phase 2 — dependency-DAG readers. Pure functions only: every one takes
 * already-fetched text and returns a value, so the whole edge model is testable
 * without network. The impure fetch/gh callers live in check-release-staleness.ts.
 * See docs/superpowers/specs/2026-07-26-p2-phase2-dep-dag-design.md.
 */

import { isRecord } from "./_gh-audit.ts";
import { compareSemver, type PublishedRelease, type ReleaseInfo } from "./_release-train-core.ts";

export interface NpmLatest {
  version: string;
  publishedAt: string;
}

/**
 * `dist-tags.latest` + its publish timestamp from a FULL npm registry document.
 * The `/<pkg>/latest` endpoint is not usable here: it omits `time`, and the
 * grace rule is measured from the version's own publish time.
 */
export function parseNpmLatest(doc: string): NpmLatest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const tags = parsed["dist-tags"];
  if (!isRecord(tags)) return null;
  const version = tags["latest"];
  if (typeof version !== "string") return null;
  const time = parsed["time"];
  if (!isRecord(time)) return null;
  const publishedAt = time[version];
  if (typeof publishedAt !== "string") return null;
  return { version, publishedAt };
}

/**
 * Highest stable release whose tag matches `pattern`, which MUST carry one
 * capture group holding the bare version. Upstream tags are component-prefixed
 * (`sdk-v1.6.0`), which Phase 1's `selectPublished` deliberately rejects — so
 * dep edges need their own selector rather than reusing it.
 */
export function selectTaggedRelease(
  releases: readonly ReleaseInfo[],
  pattern: string,
): PublishedRelease | null {
  const re = new RegExp(pattern);
  const eligible: PublishedRelease[] = [];
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    const version = re.exec(r.tag)?.[1];
    if (version) eligible.push({ version, publishedAt: r.publishedAt });
  }
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => compareSemver(b.version, a.version) ?? 0);
  return eligible[0] ?? null;
}

/** Workspace package names declared by a parsed bun.lock (`workspaces[].name`). */
function workspaceNames(lock: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const ws = lock["workspaces"];
  if (!isRecord(ws)) return names;
  for (const entry of Object.values(ws)) {
    if (isRecord(entry) && typeof entry["name"] === "string") names.add(entry["name"]);
  }
  return names;
}

/**
 * The version of `pkg` a bun.lock actually resolves for the repo's OWN code.
 *
 * A bun.lock mentions a package in two places and only one is a version:
 *   workspaces[].dependencies["<pkg>"] = "^1.5.0"     <- a RANGE, never parse it
 *   packages["<path>"] = ["<pkg>@1.6.0", ...]         <- the resolution
 *
 * A resolution key is a dependency PATH: bare `<pkg>` is the hoisted copy, and
 * `<prefix>/<pkg>` is the copy `<prefix>` resolved. Only prefixes that are the
 * repo's own workspaces are this edge's business — a lower version nested under
 * a THIRD-PARTY package (e.g. `@nimbus-dev/client/@nimbus-dev/sdk`) is that
 * package's business, not ours, and counting it would report a version no local
 * code resolves. Returns the minimum of the qualifying entries, because the
 * oldest version our own code ships is the honest "caught up" signal.
 */
export function resolvedFromBunLock(text: string, pkg: string): string | null {
  let parsed: unknown;
  try {
    // A real bun.lock is JSONC-ish and DOES contain trailing commas, so plain
    // JSON.parse throws on it. Strip `,` before a closing brace/bracket first.
    parsed = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const packages = parsed["packages"];
  if (!isRecord(packages)) return null;

  const ours = workspaceNames(parsed);
  const found: string[] = [];
  const suffix = `/${pkg}`;

  for (const [key, value] of Object.entries(packages)) {
    if (key !== pkg && !key.endsWith(suffix)) continue;
    if (key !== pkg && !ours.has(key.slice(0, key.length - suffix.length))) continue;
    if (!Array.isArray(value)) continue;
    const spec = value[0];
    if (typeof spec !== "string") continue;
    const at = spec.lastIndexOf("@");
    if (at <= 0 || spec.slice(0, at) !== pkg) continue;
    found.push(spec.slice(at + 1));
  }
  if (found.length === 0) return null;
  found.sort((a, b) => compareSemver(a, b) ?? 0);
  return found[0] ?? null;
}

export interface PrRef {
  title: string;
  headRefName: string;
}

/**
 * Is one of these open PRs an in-flight bump of `pkg`? Matched in memory over
 * title + branch rather than through `gh --search`, so the gate does not depend
 * on an opaque relevance ranker and every naming variant is testable offline.
 * Both the full name (`@nimbus-dev/sdk`) and the short name (`sdk`) count —
 * Dependabot, Renovate and humans all title these differently.
 */
export function matchesBumpPr(prs: readonly PrRef[], pkg: string): boolean {
  const full = pkg.toLowerCase();
  const short = (pkg.split("/").pop() ?? pkg).toLowerCase();
  return prs.some((pr) => {
    const hay = `${pr.title} ${pr.headRefName}`.toLowerCase();
    return hay.includes(full) || hay.includes(short);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/structure-audit/_release-train-dep.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check scripts
git add scripts/structure-audit/_release-train-dep.ts scripts/structure-audit/_release-train-dep.test.ts
git commit -m "feat(audit): Phase 2 pure readers (npm latest, tagged release, bun.lock, bump PR)"
```

---

## Task 3: `evaluatePackage` — the Phase 2 edge evaluator

**Files:**

- Modify: `scripts/structure-audit/_release-train-dep.ts`
- Test: `scripts/structure-audit/_release-train-dep.test.ts`

**Interfaces:**

- Consumes: `compareSemver`, `type EdgeResult`, `type PublishedRelease` from `_release-train-core.ts`; `NpmLatest` from Task 2.
- Produces:
  - `interface ConsumerReading { repo: string; status: "read" | "absent" | "indeterminate" | "not-a-dependency"; resolved: string | null; bumpPrOpen: boolean }`
  - `interface PackageEvalInput { name: string; npm: string; taggedRelease: PublishedRelease | null; taggedReleaseAgeHours: number | null; latest: NpmLatest | null; latestAgeHours: number | null; consumers: ConsumerReading[]; graceHours: number }`
  - `evaluatePackage(i: PackageEvalInput): EdgeResult[]`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/structure-audit/_release-train-dep.test.ts`:

```ts
import { type ConsumerReading, evaluatePackage } from "./_release-train-dep.ts";

const consumer = (over: Partial<ConsumerReading>): ConsumerReading => ({
  repo: "nimbus-agent/nimbus-vscode",
  status: "read",
  resolved: null,
  bumpPrOpen: false,
  ...over,
});

describe("evaluatePackage", () => {
  const green = {
    name: "sdk",
    npm: "@nimbus-dev/sdk",
    taggedRelease: { version: "1.6.0", publishedAt: "x" },
    taggedReleaseAgeHours: 48,
    latest: { version: "1.6.0", publishedAt: "x" },
    latestAgeHours: 48,
    graceHours: 6,
  };

  test("tag and npm equal + consumer current => all ok", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ resolved: "1.6.0" })],
    });
    expect(r.every((e) => e.verdict === "ok")).toBe(true);
  });

  test("tag ahead of npm past grace => publish phantom", () => {
    const r = evaluatePackage({
      ...green,
      taggedRelease: { version: "1.7.0", publishedAt: "x" },
      consumers: [],
    });
    expect(r.find((e) => e.edge === "sdk:publish")?.verdict).toBe("phantom");
  });

  test("tag ahead of npm within grace => ok (publish window)", () => {
    const r = evaluatePackage({
      ...green,
      taggedRelease: { version: "1.7.0", publishedAt: "x" },
      taggedReleaseAgeHours: 1,
      consumers: [],
    });
    expect(r.find((e) => e.edge === "sdk:publish")?.verdict).toBe("ok");
  });

  test("consumer behind past grace => stale", () => {
    const r = evaluatePackage({ ...green, consumers: [consumer({ resolved: "1.5.2" })] });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("stale");
  });

  test("consumer behind but the npm version is within grace => ok", () => {
    const r = evaluatePackage({
      ...green,
      latestAgeHours: 2,
      consumers: [consumer({ resolved: "1.5.2" })],
    });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("ok");
  });

  test("consumer behind but a bump PR is open => ok", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ resolved: "1.5.2", bumpPrOpen: true })],
    });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("ok");
  });

  test("consumer ahead of npm => ok, never stale", () => {
    const r = evaluatePackage({ ...green, consumers: [consumer({ resolved: "1.7.0" })] });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("ok");
  });

  test("npm unreadable => every edge indeterminate, never stale", () => {
    const r = evaluatePackage({
      ...green,
      latest: null,
      latestAgeHours: null,
      consumers: [consumer({ resolved: "1.0.0" })],
    });
    expect(r.every((e) => e.verdict === "indeterminate")).toBe(true);
  });

  test("transient consumer read => indeterminate", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ status: "indeterminate" })],
    });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("indeterminate");
  });

  test("absent lockfile => stale", () => {
    const r = evaluatePackage({ ...green, consumers: [consumer({ status: "absent" })] });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("stale");
  });

  test("lockfile parsed but package is not a dependency => indeterminate naming the manifest", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ status: "not-a-dependency" })],
    });
    const e = r.find((x) => x.edge === "sdk:nimbus-vscode");
    expect(e?.verdict).toBe("indeterminate");
    expect(e?.detail).toContain("manifest error");
    expect(e?.detail).toContain("release-train.json");
  });

  test("unparseable resolved version => indeterminate, never a crash", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ resolved: "not-a-version" })],
    });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("indeterminate");
  });

  test("no tagged release => publish edge indeterminate, not phantom", () => {
    const r = evaluatePackage({
      ...green,
      taggedRelease: null,
      taggedReleaseAgeHours: null,
      consumers: [],
    });
    expect(r.find((e) => e.edge === "sdk:publish")?.verdict).toBe("indeterminate");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/structure-audit/_release-train-dep.test.ts`
Expected: FAIL — `evaluatePackage` is not exported.

- [ ] **Step 3: Implement**

Append to `scripts/structure-audit/_release-train-dep.ts`:

```ts
import type { EdgeResult } from "./_release-train-core.ts";

export interface ConsumerReading {
  repo: string;
  /**
   * `read` — lockfile fetched and parsed, `resolved` is set.
   * `absent` — the lockfile itself is missing (404): a real finding.
   * `not-a-dependency` — lockfile parsed fine but has no entry: a MANIFEST bug.
   * `indeterminate` — the read failed transiently.
   */
  status: "read" | "absent" | "indeterminate" | "not-a-dependency";
  resolved: string | null;
  bumpPrOpen: boolean;
}

export interface PackageEvalInput {
  name: string;
  npm: string;
  taggedRelease: PublishedRelease | null;
  taggedReleaseAgeHours: number | null;
  latest: NpmLatest | null;
  latestAgeHours: number | null;
  consumers: ConsumerReading[];
  graceHours: number;
}

/** Short repo name for edge labels: `nimbus-agent/nimbus-vscode` -> `nimbus-vscode`. */
function shortRepo(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

/** The publish edge: a tagged release must reach npm. */
function evaluatePublishEdge(i: PackageEvalInput): EdgeResult {
  const edge = `${i.name}:publish`;
  if (i.taggedRelease === null) {
    return {
      edge,
      verdict: "indeterminate",
      detail: `no release tag matched for ${i.npm} — releases unreadable or none published`,
    };
  }
  if (i.latest === null) {
    return { edge, verdict: "indeterminate", detail: `npm registry unreadable for ${i.npm}` };
  }
  const order = compareSemver(i.taggedRelease.version, i.latest.version);
  if (order === null) {
    return {
      edge,
      verdict: "indeterminate",
      detail: `cannot compare tag ${i.taggedRelease.version} to npm ${i.latest.version}`,
    };
  }
  if (order <= 0) {
    return {
      edge,
      verdict: "ok",
      detail: `${i.npm} tag ${i.taggedRelease.version} published as ${i.latest.version}`,
    };
  }
  const age = i.taggedReleaseAgeHours ?? Number.POSITIVE_INFINITY;
  if (age > i.graceHours) {
    return {
      edge,
      verdict: "phantom",
      detail: `${i.npm} ${i.taggedRelease.version} is tagged but npm still serves ${i.latest.version}; release is ${Math.round(age)}h old (> ${i.graceHours}h grace)`,
    };
  }
  return {
    edge,
    verdict: "ok",
    detail: `${i.npm} ${i.taggedRelease.version} tagged within ${i.graceHours}h grace (npm: ${i.latest.version})`,
  };
}

/** One consumer edge: has this repo's lockfile caught up to npm @latest? */
function evaluateConsumerEdge(
  c: ConsumerReading,
  edge: string,
  npm: string,
  latest: NpmLatest,
  pastGrace: boolean,
  graceHours: number,
): EdgeResult {
  if (c.status === "indeterminate") {
    return { edge, verdict: "indeterminate", detail: `lockfile read failed transiently` };
  }
  if (c.status === "not-a-dependency") {
    return {
      edge,
      verdict: "indeterminate",
      detail: `manifest error: ${c.repo} does not depend on ${npm} — remove this consumer from release-train.json`,
    };
  }
  if (c.status === "absent") {
    return { edge, verdict: "stale", detail: `lockfile absent in ${c.repo}` };
  }
  if (c.resolved === null) {
    return { edge, verdict: "indeterminate", detail: `no resolved version for ${npm}` };
  }
  const order = compareSemver(c.resolved, latest.version);
  if (order === null) {
    return {
      edge,
      verdict: "indeterminate",
      detail: `resolved ${c.resolved} not comparable to npm ${latest.version}`,
    };
  }
  if (order >= 0) {
    return { edge, verdict: "ok", detail: `${c.resolved} >= npm ${latest.version}` };
  }
  if (!pastGrace) {
    return { edge, verdict: "ok", detail: `npm ${latest.version} within ${graceHours}h grace` };
  }
  if (c.bumpPrOpen) {
    return { edge, verdict: "ok", detail: `${c.resolved} < ${latest.version} but a bump PR is open` };
  }
  return {
    edge,
    verdict: "stale",
    detail: `${c.resolved} < npm ${latest.version} and no bump PR open`,
  };
}

export function evaluatePackage(i: PackageEvalInput): EdgeResult[] {
  const results: EdgeResult[] = [evaluatePublishEdge(i)];
  const pastGrace = (i.latestAgeHours ?? Number.POSITIVE_INFINITY) > i.graceHours;
  for (const c of i.consumers) {
    const edge = `${i.name}:${shortRepo(c.repo)}`;
    results.push(
      i.latest === null
        ? { edge, verdict: "indeterminate", detail: `npm registry unreadable for ${i.npm}` }
        : evaluateConsumerEdge(c, edge, i.npm, i.latest, pastGrace, i.graceHours),
    );
  }
  return results;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/structure-audit/_release-train-dep.test.ts`
Expected: PASS, 31 tests.

- [ ] **Step 5: Commit**

```bash
bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check scripts
git add scripts/structure-audit/_release-train-dep.ts scripts/structure-audit/_release-train-dep.test.ts
git commit -m "feat(audit): evaluatePackage — publish-phantom + consumer-staleness edges"
```

---

## Task 4: Manifest — `packages[]` + loader validation

**Files:**

- Modify: `.github/release-train.json`
- Modify: `scripts/structure-audit/check-release-staleness.ts`
- Test: `scripts/structure-audit/check-release-staleness.test.ts`

**Interfaces:**

- Produces: `interface ConsumerSpec { repo: string; lockfile: string }`; `interface PackageSpec { name: string; npm: string; repo: string; tagPattern: string; consumers: ConsumerSpec[] }`; `TrainManifest` gains `packages: PackageSpec[]`.

- [ ] **Step 1: Add `packages[]` to the manifest**

Edit `.github/release-train.json` — insert `packages` after the existing `trains` array, leaving `graceHours` and `trains` untouched:

```json
  "packages": [
    {
      "name": "sdk",
      "npm": "@nimbus-dev/sdk",
      "repo": "nimbus-agent/nimbus-sdk",
      "tagPattern": "^sdk-v(\\d+\\.\\d+\\.\\d+)$",
      "consumers": [
        { "repo": "nimbus-agent/nimbus-client", "lockfile": "bun.lock" },
        { "repo": "nimbus-agent/nimbus-vscode", "lockfile": "bun.lock" },
        { "repo": "nimbus-agent/Nimbus", "lockfile": "bun.lock" }
      ]
    },
    {
      "name": "client",
      "npm": "@nimbus-dev/client",
      "repo": "nimbus-agent/nimbus-client",
      "tagPattern": "^client-v(\\d+\\.\\d+\\.\\d+)$",
      "consumers": [
        { "repo": "nimbus-agent/nimbus-vscode", "lockfile": "bun.lock" },
        { "repo": "nimbus-agent/Nimbus", "lockfile": "bun.lock" }
      ]
    }
  ]
```

- [ ] **Step 2: Write the failing test**

Append to `scripts/structure-audit/check-release-staleness.test.ts` (inside the existing `loadTrainManifest` describe block):

```ts
  test("parses packages[] with consumers", () => {
    const m = loadTrainManifest(
      '{"graceHours":6,"trains":[],"packages":[{"name":"sdk","npm":"@x/sdk","repo":"o/r","tagPattern":"^sdk-v(\\\\d+\\\\.\\\\d+\\\\.\\\\d+)$","consumers":[{"repo":"o/c","lockfile":"bun.lock"}]}]}',
    );
    expect(m.packages[0]?.name).toBe("sdk");
    expect(m.packages[0]?.consumers[0]?.lockfile).toBe("bun.lock");
  });
  test("throws when packages is present but not an array", () => {
    expect(() => loadTrainManifest('{"graceHours":6,"trains":[],"packages":{}}')).toThrow();
  });
  test("the committed manifest declares both packages with a capture-group tagPattern", () => {
    const raw = readFileSync(
      join(import.meta.dir, "..", "..", ".github", "release-train.json"),
      "utf8",
    );
    const m = loadTrainManifest(raw);
    expect(m.packages.map((p) => p.name).sort()).toEqual(["client", "sdk"]);
    for (const p of m.packages) {
      expect(p.tagPattern).toContain("(");
      expect(p.consumers.length).toBeGreaterThan(0);
    }
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts`
Expected: FAIL — `m.packages` is undefined / not validated.

- [ ] **Step 4: Implement**

In `scripts/structure-audit/check-release-staleness.ts`, add the specs next to `TrainSpec` and extend both `TrainManifest` and `loadTrainManifest`:

```ts
export interface ConsumerSpec {
  repo: string;
  lockfile: string;
}
export interface PackageSpec {
  name: string;
  npm: string;
  repo: string;
  /** Anchored regex with ONE capture group holding the bare version. */
  tagPattern: string;
  consumers: ConsumerSpec[];
}
```

```ts
export interface TrainManifest {
  graceHours: number;
  trains: TrainSpec[];
  packages: PackageSpec[];
}

export function loadTrainManifest(json: string): TrainManifest {
  const parsed: unknown = JSON.parse(json);
  if (
    !isRecord(parsed) ||
    typeof parsed["graceHours"] !== "number" ||
    !Array.isArray(parsed["trains"])
  ) {
    throw new Error("release-train.json: expected { graceHours: number, trains: [...] }");
  }
  // `packages` is optional on disk but always an array in memory, so callers
  // never branch on undefined. A present-but-wrong-shaped value is a hard error
  // rather than a silent empty list, which would make the Phase 2 edges vanish.
  const pkgs = parsed["packages"];
  if (pkgs !== undefined && !Array.isArray(pkgs)) {
    throw new Error("release-train.json: `packages` must be an array when present");
  }
  return { ...(parsed as unknown as TrainManifest), packages: (pkgs ?? []) as PackageSpec[] };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts`
Expected: PASS, 42 tests.

- [ ] **Step 6: Commit**

```bash
bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check scripts .github
git add .github/release-train.json scripts/structure-audit/check-release-staleness.ts scripts/structure-audit/check-release-staleness.test.ts
git commit -m "feat(audit): declare the dependency DAG in release-train.json"
```

---

## Task 5: Wire the readers into the shell + live proof

**Files:**

- Modify: `scripts/structure-audit/check-release-staleness.ts`

**Interfaces:**

- Consumes: everything from Tasks 2–4.
- Produces: no new exports — impure readers stay module-private; the shell emits Phase 2 `EdgeResult`s into the existing `decideExit`.

- [ ] **Step 1: Add the impure readers**

Add to `scripts/structure-audit/check-release-staleness.ts`, above the `import.meta.main` block. Extend the existing `_release-train-dep.ts` import rather than adding a second one.

```ts
import {
  type ConsumerReading,
  evaluatePackage,
  matchesBumpPr,
  type NpmLatest,
  parseNpmLatest,
  type PrRef,
  resolvedFromBunLock,
  selectTaggedRelease,
} from "./_release-train-dep.ts";
```

```ts
/**
 * npm `@latest` + its publish time. Bounded by an explicit 5s timeout: the
 * registry is the only dependency here that is neither GitHub nor local, and an
 * unbounded fetch would hang the sweep job (and a local run, which is worse).
 * Any timeout, non-200, or malformed body degrades to null -> indeterminate.
 */
async function readNpmLatest(pkg: string): Promise<NpmLatest | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}`, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return parseNpmLatest(await res.text());
  } catch {
    return null;
  }
}

/** The upstream repo's highest release whose tag matches the package pattern. */
function readTaggedRelease(pkg: PackageSpec): PublishedRelease | null {
  const res = runGh([
    "gh",
    "api",
    `repos/${pkg.repo}/releases?per_page=100`,
    "--jq",
    "[.[] | {tag: .tag_name, prerelease: .prerelease, draft: .draft, publishedAt: .published_at, assets: [.assets[].name]}]",
  ]);
  if (!res.ok) return null;
  try {
    const rels: unknown = JSON.parse(res.stdout);
    if (!Array.isArray(rels)) return null;
    return selectTaggedRelease(rels as ReleaseInfo[], pkg.tagPattern);
  } catch {
    return null;
  }
}

/** Is there an open PR in `repo` that looks like a bump of `npm`? */
function readBumpPrOpen(repo: string, npm: string): boolean {
  const res = runGh([
    "gh",
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "title,headRefName",
  ]);
  if (!res.ok) return false;
  try {
    const prs: unknown = JSON.parse(res.stdout);
    return Array.isArray(prs) ? matchesBumpPr(prs as PrRef[], npm) : false;
  } catch {
    return false;
  }
}

/** One consumer's lockfile-resolved version of `npm`. */
function readConsumer(c: ConsumerSpec, npm: string): ConsumerReading {
  const res = runGh([
    "gh",
    "api",
    `repos/${c.repo}/contents/${c.lockfile}`,
    "--jq",
    ".content",
  ]);
  if (!res.ok) {
    // 404 => the lockfile itself is missing (a real finding). Anything else is
    // transient and must not be reported as staleness.
    const kind = classifyReadFailure(res.httpStatus);
    return { repo: c.repo, status: kind, resolved: null, bumpPrOpen: false };
  }
  const resolved = resolvedFromBunLock(decodeContents(res.stdout), npm);
  if (resolved === null) {
    // Parsed fine, no entry for the package => the manifest is wrong, not the repo.
    return { repo: c.repo, status: "not-a-dependency", resolved: null, bumpPrOpen: false };
  }
  return { repo: c.repo, status: "read", resolved, bumpPrOpen: readBumpPrOpen(c.repo, npm) };
}
```

> **Note on `classifyReadFailure`:** it returns `"absent" | "indeterminate"`, both of which are members of `ConsumerReading["status"]`, so the value assigns directly.

- [ ] **Step 2: Wire the shell**

In the `import.meta.main` block of `check-release-staleness.ts`, insert this loop immediately after the existing `for (const train of manifest.trains) { ... }` loop and before `const out = decideExit(...)`:

```ts
  for (const pkg of manifest.packages) {
    const latest = await readNpmLatest(pkg.npm);
    const taggedRelease = readTaggedRelease(pkg);
    const consumers = pkg.consumers.map((c) => readConsumer(c, pkg.npm));

    allResults.push(
      ...evaluatePackage({
        name: pkg.name,
        npm: pkg.npm,
        taggedRelease,
        taggedReleaseAgeHours: taggedRelease ? ageHours(taggedRelease.publishedAt) : null,
        latest,
        latestAgeHours: latest ? ageHours(latest.publishedAt) : null,
        consumers,
        graceHours: manifest.graceHours,
      }),
    );
  }
```

- [ ] **Step 3: Typecheck, lint, and run the whole audit suite**

Run: `bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check scripts .github && bun test scripts/structure-audit/`
Expected: typecheck exit 0, biome clean, all tests PASS (Phase 1's 42 + Phase 2's 31).

- [ ] **Step 4: Live proof — run the gate against the real graph**

Run: `GH_TOKEN=$(gh auth token) bun scripts/structure-audit/check-release-staleness.ts`

Expected: **RED (exit 1)**, and specifically these three `::error::` lines, because the drift is real and confirmed:

- `client:Nimbus` — resolved `0.5.0` < npm `0.12.1`
- `client:nimbus-vscode` — resolved `0.11.0` < npm `0.12.1`
- `sdk:nimbus-vscode` — resolved `1.5.2` < npm `1.6.0`

and these green: `sdk:publish`, `client:publish`, `sdk:nimbus-client`, plus all five Phase 1 edges.

**Do not "fix" the gate to make it green.** A red here is the gate working; the remediation is a separate dependency-bump PR. If an edge is red for a *different* reason than the three above, that is a real bug in this task — debug it.

Capture the exact output for the PR description.

- [ ] **Step 5: Verify the failure paths degrade rather than crash**

Run: `bun scripts/structure-audit/check-release-staleness.ts` with no `GH_TOKEN` and network disabled (or simply unset `GH_TOKEN` and disconnect).
Expected: a soft `::warning::` skip and **exit 0** — never a stack trace. The reachability probe short-circuits before any Phase 2 read.

- [ ] **Step 6: Commit**

```bash
git add scripts/structure-audit/check-release-staleness.ts
git commit -m "feat(audit): read the dependency DAG (npm latest, tags, lockfiles, bump PRs)"
```

---

## Task 6: Documentation

**Files:**

- Modify: `docs/infrastructure-roadmap.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Update the P2 roadmap row**

In `docs/infrastructure-roadmap.md`, change the P2 row's status to `✅ done` and replace its trailing `Remaining: Phase 2 (dependency-DAG edges)` with `Phase 2 adds npm publish-phantom + consumer-lag edges.` Keep the rest of the row's wording.

- [ ] **Step 2: Add a Phase 2 entry to the P2 progress log**

Append to the `### P2 progress log` section, before its `- **Remaining:**` bullet (and delete that bullet's Phase-2 clause):

```markdown
- **Delivered (Phase 2 — dependency DAG, 2026-07-26):** `.github/release-train.json`
  gains `packages[]`; two new edge kinds run in the same gate. `<pkg>:publish`
  compares the upstream component-prefixed release tag to npm `@latest`,
  catching "tagged but never published" — the npm analogue of the release
  phantom. `<pkg>:<consumer>` compares each consumer's **lockfile-resolved**
  version to npm `@latest`, because a range misleads in both directions:
  `^1.2.0` permits a newer `1.3.0`, while a caret on a `0.x` pins the minor, so
  `^0.5.0` cannot reach `0.12.1` at all.
- **The lockfile reader is workspace-scoped, not global.** A bun.lock resolution
  key is a dependency *path*, so a lower version nested under a third-party
  package is that package's business, not ours. The reader takes the minimum
  over the hoisted entry plus entries whose prefix is one of the consumer's own
  workspace names. Getting this wrong reports a version no local code resolves —
  Nimbus's hoisted sdk is `1.6.0` while the copy inside `@nimbus-dev/client` is
  `1.3.0`.
- **Shipped RED on real drift (2026-07-26):** `client:Nimbus` (0.5.0 vs 0.12.1),
  `client:nimbus-vscode` (0.11.0), `sdk:nimbus-vscode` (1.5.2). Confirmed drift,
  not deliberate pins. Both `:publish` edges green. Bumping those three
  consumers is separate remediation work.
```

- [ ] **Step 3: Add the CHANGELOG entry**

Add to the top of the `## Post-Phase-6 deliveries` list in `docs/CHANGELOG.md`:

```markdown
- **2026-07-26 — P2 Release Train Phase 2: dependency-DAG edges.** `audit:release-staleness`
  now also watches the npm propagation graph. A `<pkg>:publish` edge compares each upstream's
  component-prefixed release tag to npm `@latest`, catching a package that is tagged but never
  published; a `<pkg>:<consumer>` edge compares every consuming repo's **lockfile-resolved**
  version to npm `@latest`, since a semver range misleads in both directions (a caret permits
  newer, but a caret on a `0.x` pins the minor). The lockfile reader counts only the hoisted
  entry plus the consumer's own workspaces, so a copy nested inside a third-party package is
  never mistaken for what local code resolves. Registry reads carry a 5s timeout and degrade to
  indeterminate; bump PRs already open count as caught-up. Ships red on confirmed drift — the
  CLI resolves client 0.5.0 against a published 0.12.1.
```

- [ ] **Step 4: Validate the docs**

Run: `bun run lint:markdown && bun run audit:doc-refs && "$HOME/.cargo/bin/lychee" --offline --no-progress docs/infrastructure-roadmap.md docs/CHANGELOG.md`
Expected: 0 markdown errors, all doc refs resolve, 0 link errors.

- [ ] **Step 5: Commit**

```bash
git add docs/infrastructure-roadmap.md docs/CHANGELOG.md
git commit -m "docs(infra): record P2 Phase 2 — dependency-DAG edges"
```

---

## Post-implementation (not a task — for the PR author)

- **PR description:** paste the Task 5 Step 4 output verbatim. Say explicitly that red is expected and why, or a reviewer will read the gate as broken.
- **Remediation follow-up:** bumping `@nimbus-dev/client` in `packages/cli` (0.5.0 → 0.12.1) and in `nimbus-vscode`, plus `@nimbus-dev/sdk` in `nimbus-vscode`, is separate work. The client jump crosses seven minors and may touch call sites.
- **Sweep proof:** after merge, dispatch `org-drift-sweep.yml` and record the run number in the P2 progress log, same as Phase 1.
- **Parked, unrelated:** `docs/infrastructure-roadmap.md` currently says `VSCE_PAT` expires 2026-12-01. The SSoT (`scripts/release/credential-registry.ts`) says **2026-09-20** — the token's own expiry; the December date is the global-PAT decommission, which does not apply because the token is org-scoped. Fix that line in any docs-touching PR.

---

## Self-Review

**Spec coverage:**

- Two edge kinds (`:publish`, `:<consumer>`) → Task 3 `evaluatePackage`. ✓
- New top-level `packages[]`, not `trains[]` → Task 4. ✓
- Per-package `tagPattern` with capture group; Phase 1's selector unusable → Task 2 `selectTaggedRelease` + Task 4 test asserting `(` present. ✓
- Lockfile over range, both directions → Task 2 `resolvedFromBunLock` + tests. ✓
- Minimum over hoisted + own workspaces, third-party nesting excluded → Task 2 (impl + the three-entry test). ✓
- Ranges never parsed as resolutions → Task 2 (`range in the workspaces section` test). ✓
- Grace from the npm version's publish time → Task 3 (`latestAgeHours`) + Task 5 wiring. ✓
- Full registry doc, not `/latest` → Task 5 `readNpmLatest` + Task 2 `parseNpmLatest` requiring `time`. ✓
- 5s timeout, non-200 → indeterminate → Task 5 Step 1. ✓
- In-memory PR matching, not `--search` → Task 2 `matchesBumpPr` + Task 5 `readBumpPrOpen`. ✓
- Manifest-error diagnostic distinct from a read failure → Task 3 (`not-a-dependency` status + test asserting the wording). ✓
- Engine unchanged; same `decideExit` → Tasks 1 + 5. ✓
- Ships red on the three known-stale edges → Task 5 Step 4. ✓
- Fail-soft local / strict CI unchanged → Task 5 Step 5. ✓

**Placeholder scan:** no TBD/TODO; every code step carries complete code. ✓

**Type consistency:** `NpmLatest`, `PrRef`, `ConsumerReading`, `PackageEvalInput`, `EdgeResult`, `PublishedRelease`, `ReleaseInfo`, `ConsumerSpec`, `PackageSpec` are each defined once and referenced with identical names and shapes across tasks. `evaluatePackage` / `parseNpmLatest` / `selectTaggedRelease` / `resolvedFromBunLock` / `matchesBumpPr` keep one signature throughout. `ConsumerReading["status"]` is a superset of `classifyReadFailure`'s return type, which Task 5 Step 1 calls out explicitly. ✓
