# P2 — Release Train (Phase 1: channel staleness) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an independent, scheduled `audit:release-staleness` gate that goes red when the latest built Nimbus Release has not reached a distribution channel (brew/scoop/linux/winget) past a grace window, or when a release phantoms (manifest bumped, no built Release).

**Architecture:** A declarative `.github/release-train.json` manifest lists every propagation edge. A read-only Bun audit script (`scripts/structure-audit/check-release-staleness.ts`) reads the live version at each of three "heads" — intended (release-please manifest), published (latest GitHub Release whose `SHA256SUMS` asset exists), distributed (each channel's live file / winget dir-or-PR) — entirely through public `gh` calls (no App token). Pure comparison functions decide `ok | stale | phantom | indeterminate` per edge; a new job in `org-drift-sweep.yml` runs it `--strict` on the existing weekly cron. This is Phase 1 of the spec; Phase 2 (dependency-DAG edges) is out of scope here.

**Tech Stack:** Bun v1.2+, TypeScript 6 strict, `gh` CLI, `Bun.semver.order()` (built-in, no dependency), `Bun.gunzipSync` (built-in). Follows the existing org-drift-sweep gate pattern (`_gh-audit.ts`).

**Spec:** [`docs/superpowers/specs/2026-07-24-p2-release-train-design.md`](../specs/2026-07-24-p2-release-train-design.md) (+ its review doc).

## Global Constraints

- **Runtime:** Bun v1.2+, TypeScript 6.x strict. **No `any`** — use `unknown` for external (gh/JSON) data and narrow it (`isRecord` from `_gh-audit.ts`).
- **Linter:** Biome. Run `bunx biome check packages scripts` (NOT `bun run lint` — it reports 0 files in a `.claude/worktrees/` checkout).
- **Branch:** all work on `dev/asafgolombek/p2-release-train` inside the worktree `.claude/worktrees/p2-release-train`. Never commit on `main`. Verify `git rev-parse --abbrev-ref HEAD` before the first commit.
- **Gate contract:** fail-soft locally (soft green when `gh` is unavailable/unauthenticated), hard red under `--strict` / `GITHUB_ACTIONS`. Reuse `isStrict` / `strictSkip` from `_gh-audit.ts`.
- **Staleness semantics:** `graceHours` default **6**. A channel edge is only evaluated once the published Release is older than `graceHours`; the phantom edge only once the manifest-bump commit is older than `graceHours`. winget "caught up" = version dir merged **or** an open PR for the version exists (never gate on Microsoft's merge).
- **Auth:** all reads are public → no App token. In CI pass `GH_TOKEN: ${{ github.token }}` (authenticated 5000/hr).
- **Time:** UTC epoch-ms only. `Date.now() - new Date(ts).getTime()`; never parse a timestamp lacking an explicit `Z`/offset.
- **Version compare:** `Bun.semver.order(a, b)` → `-1 | 0 | 1`. Strip a leading `v` from every version before comparing.
- **Pre-push:** `bun run preflight:fast` must pass; scoped tests `bun test scripts/structure-audit/` must pass.

---

## File Structure

- **Modify** `scripts/structure-audit/_gh-audit.ts` — add `stderr` + `httpStatus` to `GhResult`; add pure helpers `parseHttpStatus` + `classifyReadFailure`. Shared by both gates (DRY).
- **Modify** `scripts/structure-audit/_gh-audit.test.ts` — tests for the two new pure helpers.
- **Modify** `scripts/structure-audit/check-cla-coverage.ts` — use `classifyReadFailure` so a non-404 per-repo failure is *indeterminate*, not "cla.yml absent" (closes the roadmap's CLA-coverage robustness follow-up).
- **Create** `scripts/structure-audit/check-release-staleness.ts` — the gate: pure parsers + `selectPublished` + `resolveWingetCoverage` + `evaluateTrain` + `decideExit` + `loadTrainManifest` (all exported) behind an `import.meta.main` gh-reading shell.
- **Create** `scripts/structure-audit/check-release-staleness.test.ts` — table-driven unit tests for every pure function.
- **Create** `.github/release-train.json` — the declarative edge manifest.
- **Modify** `package.json` — add the `audit:release-staleness` script.
- **Modify** `scripts/lib/preflight-gates.ts` — register `audit:release-staleness` in `CI_ONLY_GATES`.
- **Modify** `.github/workflows/org-drift-sweep.yml` — add the `release-staleness` job.

---

## Task 1: `_gh-audit.ts` — surface HTTP status + shared read classifier

**Files:**
- Modify: `scripts/structure-audit/_gh-audit.ts`
- Test: `scripts/structure-audit/_gh-audit.test.ts`

**Interfaces:**
- Produces: `GhResult` gains `stderr: string` and `httpStatus?: number` (additive — existing `.ok`/`.stdout` callers unchanged). `parseHttpStatus(stderr: string): number | undefined`. `classifyReadFailure(httpStatus: number | undefined): "absent" | "indeterminate"`.

- [ ] **Step 1: Write the failing tests** — append to `scripts/structure-audit/_gh-audit.test.ts`:

```ts
import { classifyReadFailure, parseHttpStatus } from "./_gh-audit.ts";

describe("parseHttpStatus", () => {
  test("extracts the status from gh's '(HTTP NNN)' stderr", () => {
    expect(parseHttpStatus("gh: Not Found (HTTP 404)")).toBe(404);
    expect(parseHttpStatus("gh: Server Error (HTTP 500)")).toBe(500);
    expect(parseHttpStatus("API rate limit exceeded (HTTP 403)")).toBe(403);
  });
  test("returns undefined when no HTTP status is present", () => {
    expect(parseHttpStatus("some other failure")).toBeUndefined();
    expect(parseHttpStatus("")).toBeUndefined();
  });
});

describe("classifyReadFailure", () => {
  test("404 is a genuine absence", () => {
    expect(classifyReadFailure(404)).toBe("absent");
  });
  test("5xx / 403 / unknown are indeterminate (transient), never absent", () => {
    expect(classifyReadFailure(500)).toBe("indeterminate");
    expect(classifyReadFailure(403)).toBe("indeterminate");
    expect(classifyReadFailure(undefined)).toBe("indeterminate");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/structure-audit/_gh-audit.test.ts`
Expected: FAIL — `classifyReadFailure`/`parseHttpStatus` are not exported.

- [ ] **Step 3: Implement** — edit `scripts/structure-audit/_gh-audit.ts`. Extend `GhResult` and `runGh`, and add the two helpers:

```ts
export interface GhResult {
  ok: boolean;
  stdout: string;
  /** Captured stderr (gh writes "(HTTP NNN)" here on failure). "" on success or spawn error. */
  stderr: string;
  /** Parsed HTTP status when the call failed with one; undefined otherwise. */
  httpStatus?: number;
}

/** Pull the numeric status out of gh's `... (HTTP NNN)` error line. */
export function parseHttpStatus(stderr: string): number | undefined {
  const m = stderr.match(/\(HTTP (\d{3})\)/);
  return m ? Number(m[1]) : undefined;
}

/**
 * A failed public read is either a genuine 404 (the thing is absent — a real
 * finding) or a transient failure (5xx, 403 rate-limit, network) that must NOT
 * be read as a finding. Mirrors the team-reachability "indeterminate" rule.
 */
export function classifyReadFailure(httpStatus: number | undefined): "absent" | "indeterminate" {
  return httpStatus === 404 ? "absent" : "indeterminate";
}
```

And update `runGh` to capture stderr + status (keep `ok`/`stdout` behavior identical):

```ts
export function runGh(args: string[]): GhResult {
  try {
    const proc = Bun.spawnSync(args);
    const stderr = new TextDecoder().decode(proc.stderr);
    if (!proc.success) {
      return { ok: false, stdout: "", stderr, httpStatus: parseHttpStatus(stderr) };
    }
    return { ok: true, stdout: new TextDecoder().decode(proc.stdout), stderr };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/structure-audit/_gh-audit.test.ts`
Expected: PASS (existing `isStrict`/`strictSkip` tests still green — the change is additive).

- [ ] **Step 5: Commit**

```bash
git add scripts/structure-audit/_gh-audit.ts scripts/structure-audit/_gh-audit.test.ts
git commit -m "feat(audit): surface gh HTTP status + shared read classifier in _gh-audit"
```

---

## Task 2: CLA-coverage robustness — non-404 failure is indeterminate

**Files:**
- Modify: `scripts/structure-audit/check-cla-coverage.ts`
- Test: `scripts/structure-audit/check-cla-coverage.test.ts`

**Interfaces:**
- Consumes: `classifyReadFailure` (Task 1).
- Produces: no signature change to `diffClaCoverage`; the `import.meta.main` shell now short-circuits to `strictSkip` with a reason when any per-repo read fails with a non-404 status.

> **Separable:** this task closes a roadmap follow-up but touches a sibling gate. If the reviewer wants P2 fully isolated, skip Task 2 — Tasks 3–6 do not depend on it. (Task 1's helper is still used by the release-staleness gate regardless.)

- [ ] **Step 1: Write the failing test** — add to `scripts/structure-audit/check-cla-coverage.test.ts` a test for a new exported pure helper that the shell will use:

```ts
import { classifyRepoRead } from "./check-cla-coverage.ts";

describe("classifyRepoRead", () => {
  test("ok read yields the parsed value", () => {
    expect(classifyRepoRead({ ok: true, stdout: "x", stderr: "" })).toEqual({ kind: "read" });
  });
  test("404 read is absent (a genuine finding)", () => {
    expect(classifyRepoRead({ ok: false, stdout: "", stderr: "(HTTP 404)", httpStatus: 404 })).toEqual({ kind: "absent" });
  });
  test("500 read is indeterminate, not absent", () => {
    expect(classifyRepoRead({ ok: false, stdout: "", stderr: "(HTTP 500)", httpStatus: 500 })).toEqual({ kind: "indeterminate" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/structure-audit/check-cla-coverage.test.ts`
Expected: FAIL — `classifyRepoRead` not exported.

- [ ] **Step 3: Implement** — in `check-cla-coverage.ts`, add the helper and use it in the shell. Add the import and helper:

```ts
import { classifyReadFailure, type GhResult, isStrict, runGh, strictSkip } from "./_gh-audit.ts";

/** Classify one per-repo contents read into read / absent / indeterminate. */
export function classifyRepoRead(res: GhResult): { kind: "read" | "absent" | "indeterminate" } {
  if (res.ok) return { kind: "read" };
  return { kind: classifyReadFailure(res.httpStatus) };
}
```

Replace the per-repo loop body (currently `if (!res.ok) { live[repo] = null; continue; }`) with:

```ts
    const cls = classifyRepoRead(res);
    if (cls.kind === "indeterminate") {
      const outcome = strictSkip(
        label,
        strict,
        `cla-coverage indeterminate — ${repo} read failed transiently (HTTP ${res.httpStatus ?? "?"})`,
      );
      if (outcome.code === 1) console.error(outcome.message);
      else console.warn(outcome.message);
      process.exit(outcome.code);
    }
    if (cls.kind === "absent") {
      live[repo] = null;
      continue;
    }
```

(Leave the subsequent base64-decode + `parseVersion` for the `read` case unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/structure-audit/check-cla-coverage.test.ts`
Expected: PASS (existing `diffClaCoverage` tests still green).

- [ ] **Step 5: Commit**

```bash
git add scripts/structure-audit/check-cla-coverage.ts scripts/structure-audit/check-cla-coverage.test.ts
git commit -m "fix(audit): cla-coverage treats a non-404 read as indeterminate, not absent"
```

---

## Task 3: Release-staleness pure readers — version parsers, published selector, winget resolver

**Files:**
- Create: `scripts/structure-audit/check-release-staleness.ts`
- Test: `scripts/structure-audit/check-release-staleness.test.ts`

**Interfaces:**
- Produces:
  - `parseBrewVersion(rb: string): string | null`
  - `parseScoopVersion(json: string): string | null`
  - `parseLinuxVersion(packages: string): string | null`
  - `interface ReleaseInfo { tag: string; prerelease: boolean; draft: boolean; assets: string[]; publishedAt: string }`
  - `interface PublishedRelease { version: string; publishedAt: string }`
  - `selectPublished(releases: ReleaseInfo[], asset: string): PublishedRelease | null`
  - `wingetDirPath(packageId: string, version: string): string`
  - `resolveWingetCoverage(dir: boolean | null, pr: boolean | null): { status: "read" | "indeterminate"; covered: boolean }`

- [ ] **Step 1: Write the failing tests** — create `scripts/structure-audit/check-release-staleness.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  parseBrewVersion,
  parseScoopVersion,
  parseLinuxVersion,
  selectPublished,
  wingetDirPath,
  resolveWingetCoverage,
} from "./check-release-staleness.ts";

describe("parseBrewVersion", () => {
  test("reads version from a Formula .rb", () => {
    expect(parseBrewVersion('class Nimbus < Formula\n  version "0.26.0"\n  url "..."')).toBe("0.26.0");
  });
  test("null when absent", () => {
    expect(parseBrewVersion("class Nimbus < Formula\n  url \"...\"")).toBeNull();
  });
});

describe("parseScoopVersion", () => {
  test("reads .version from a scoop manifest", () => {
    expect(parseScoopVersion('{"version":"0.26.0","url":"x"}')).toBe("0.26.0");
  });
  test("null on malformed json or missing key", () => {
    expect(parseScoopVersion("{not json")).toBeNull();
    expect(parseScoopVersion('{"url":"x"}')).toBeNull();
  });
});

describe("parseLinuxVersion", () => {
  test("reads the Version: control field from a Packages file", () => {
    const pkgs = "Package: nimbus-headless\nVersion: 0.26.0\nArchitecture: amd64\n";
    expect(parseLinuxVersion(pkgs)).toBe("0.26.0");
  });
  test("null when no Version field", () => {
    expect(parseLinuxVersion("Package: nimbus-headless\n")).toBeNull();
  });
});

describe("selectPublished", () => {
  const base = { draft: false, prerelease: false, publishedAt: "2026-07-01T00:00:00Z" };
  test("picks the highest stable tag whose SHA256SUMS asset exists", () => {
    const r = selectPublished(
      [
        { ...base, tag: "v0.25.0", assets: ["SHA256SUMS"] },
        { ...base, tag: "v0.26.0", assets: ["SHA256SUMS"], publishedAt: "2026-07-10T00:00:00Z" },
      ],
      "SHA256SUMS",
    );
    expect(r).toEqual({ version: "0.26.0", publishedAt: "2026-07-10T00:00:00Z" });
  });
  test("skips a release missing the asset (asset-less phantom)", () => {
    const r = selectPublished(
      [
        { ...base, tag: "v0.26.0", assets: [] },
        { ...base, tag: "v0.25.0", assets: ["SHA256SUMS"] },
      ],
      "SHA256SUMS",
    );
    expect(r?.version).toBe("0.25.0");
  });
  test("skips prereleases, drafts, and non-vX.Y.Z tags", () => {
    const r = selectPublished(
      [
        { ...base, tag: "v0.27.0-rc.1", prerelease: true, assets: ["SHA256SUMS"] },
        { ...base, tag: "sdk-v1.6.0", assets: ["SHA256SUMS"] },
        { ...base, tag: "v0.26.0", draft: true, assets: ["SHA256SUMS"] },
        { ...base, tag: "v0.25.0", assets: ["SHA256SUMS"] },
      ],
      "SHA256SUMS",
    );
    expect(r?.version).toBe("0.25.0");
  });
  test("null when nothing qualifies", () => {
    expect(selectPublished([{ ...base, tag: "v0.26.0", assets: [] }], "SHA256SUMS")).toBeNull();
  });
});

describe("wingetDirPath", () => {
  test("derives the manifests path from the package id", () => {
    expect(wingetDirPath("NimbusAgent.Nimbus", "0.26.0")).toBe(
      "manifests/n/NimbusAgent/Nimbus/0.26.0",
    );
  });
});

describe("resolveWingetCoverage", () => {
  test("covered when the dir exists", () => {
    expect(resolveWingetCoverage(true, false)).toEqual({ status: "read", covered: true });
  });
  test("covered when an open PR exists", () => {
    expect(resolveWingetCoverage(false, true)).toEqual({ status: "read", covered: true });
  });
  test("genuinely not covered when both are known-false", () => {
    expect(resolveWingetCoverage(false, false)).toEqual({ status: "read", covered: false });
  });
  test("indeterminate when either signal is unknown and neither is true", () => {
    expect(resolveWingetCoverage(null, false)).toEqual({ status: "indeterminate", covered: false });
    expect(resolveWingetCoverage(false, null)).toEqual({ status: "indeterminate", covered: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — create `scripts/structure-audit/check-release-staleness.ts` with the pure readers (shell added in Task 5):

```ts
#!/usr/bin/env bun

/**
 * audit:release-staleness — the P2 Release Train gate. Reads three version
 * "heads" for each train in .github/release-train.json (intended = release-please
 * manifest, published = latest GitHub Release with its SHA256SUMS asset,
 * distributed = each channel's live version) and fails when a channel lags the
 * published release past graceHours, or when a release phantoms. All reads are
 * public gh calls; fail-soft locally, strict in CI. See
 * docs/superpowers/specs/2026-07-24-p2-release-train-design.md.
 */

export function stripV(version: string): string {
  return version.replace(/^v/, "");
}

/** `version "X.Y.Z"` from a Homebrew Formula .rb. */
export function parseBrewVersion(rb: string): string | null {
  return rb.match(/version\s+"([^"]+)"/)?.[1] ?? null;
}

/** `.version` from a Scoop JSON manifest. */
export function parseScoopVersion(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const v = (parsed as { version: unknown }).version;
      return typeof v === "string" ? v : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** First `Version:` control field from an apt Packages list. */
export function parseLinuxVersion(packages: string): string | null {
  return packages.match(/^Version:\s*(.+)$/m)?.[1]?.trim() ?? null;
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

/**
 * Highest stable `vX.Y.Z` release whose `asset` is attached. Skips drafts,
 * prereleases, non-`vX.Y.Z` tags (e.g. component tags), and asset-less phantom
 * releases. Returns null when nothing qualifies.
 */
export function selectPublished(releases: ReleaseInfo[], asset: string): PublishedRelease | null {
  const stable = /^v\d+\.\d+\.\d+$/;
  const eligible = releases.filter(
    (r) => !r.draft && !r.prerelease && stable.test(r.tag) && r.assets.includes(asset),
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => Bun.semver.order(stripV(b.tag), stripV(a.tag)));
  const top = eligible[0];
  return top ? { version: stripV(top.tag), publishedAt: top.publishedAt } : null;
}

/** winget-pkgs manifests path: manifests/<first-letter>/<Publisher>/<Package>/<version>. */
export function wingetDirPath(packageId: string, version: string): string {
  const [publisher, ...rest] = packageId.split(".");
  const pkg = rest.join(".");
  const letter = (publisher ?? "").charAt(0).toLowerCase();
  return `manifests/${letter}/${publisher}/${pkg}/${version}`;
}

/**
 * winget is "caught up" if the version dir is merged OR an open PR exists.
 * `dir`/`pr` are true (known present), false (known absent), or null (the read
 * failed transiently). Covered if either is true; genuinely not covered only
 * when both are known-false; otherwise indeterminate.
 */
export function resolveWingetCoverage(
  dir: boolean | null,
  pr: boolean | null,
): { status: "read" | "indeterminate"; covered: boolean } {
  if (dir === true || pr === true) return { status: "read", covered: true };
  if (dir === false && pr === false) return { status: "read", covered: false };
  return { status: "indeterminate", covered: false };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/structure-audit/check-release-staleness.ts scripts/structure-audit/check-release-staleness.test.ts
git commit -m "feat(audit): release-staleness pure readers (brew/scoop/linux/published/winget)"
```

---

## Task 4: The evaluation engine — `evaluateTrain` + `decideExit`

**Files:**
- Modify: `scripts/structure-audit/check-release-staleness.ts`
- Test: `scripts/structure-audit/check-release-staleness.test.ts`

**Interfaces:**
- Consumes: `PublishedRelease` (Task 3).
- Produces:
  - `type EdgeVerdict = "ok" | "stale" | "phantom" | "indeterminate"`
  - `interface EdgeResult { edge: string; verdict: EdgeVerdict; detail: string }`
  - `interface ChannelReading { kind: string; status: "read" | "absent" | "indeterminate"; version: string | null; covered: boolean | null }`
  - `interface TrainEvalInput { name: string; intended: string; intendedBumpAgeHours: number; published: PublishedRelease | null; publishedAgeHours: number | null; channels: ChannelReading[]; graceHours: number }`
  - `evaluateTrain(input: TrainEvalInput): EdgeResult[]`
  - `decideExit(results: EdgeResult[], strict: boolean): { code: 0 | 1; messages: string[] }`

- [ ] **Step 1: Write the failing tests** — add to `check-release-staleness.test.ts`:

```ts
import { evaluateTrain, decideExit, type ChannelReading } from "./check-release-staleness.ts";

const ch = (over: Partial<ChannelReading>): ChannelReading => ({
  kind: "brew", status: "read", version: null, covered: null, ...over,
});

describe("evaluateTrain", () => {
  const green = {
    name: "t", intended: "0.26.0", intendedBumpAgeHours: 48,
    published: { version: "0.26.0", publishedAt: "x" }, publishedAgeHours: 48, graceHours: 6,
  };

  test("all heads equal + channels current => all ok", () => {
    const r = evaluateTrain({
      ...green,
      channels: [
        ch({ kind: "brew", version: "0.26.0" }),
        ch({ kind: "scoop", version: "0.26.0" }),
        ch({ kind: "linux", version: "0.26.0" }),
        ch({ kind: "winget", version: null, covered: true }),
      ],
    });
    expect(r.every((e) => e.verdict === "ok")).toBe(true);
  });

  test("channel behind published, past grace => stale", () => {
    const r = evaluateTrain({ ...green, channels: [ch({ kind: "brew", version: "0.25.0" })] });
    expect(r.find((e) => e.edge === "t:brew")?.verdict).toBe("stale");
  });

  test("channel behind published but within grace => ok", () => {
    const r = evaluateTrain({
      ...green, publishedAgeHours: 2, channels: [ch({ kind: "brew", version: "0.25.0" })],
    });
    expect(r.find((e) => e.edge === "t:brew")?.verdict).toBe("ok");
  });

  test("manifest ahead of published + aged bump => phantom", () => {
    const r = evaluateTrain({
      ...green, intended: "0.27.0", published: { version: "0.26.0", publishedAt: "x" }, channels: [],
    });
    expect(r.find((e) => e.edge === "t:phantom")?.verdict).toBe("phantom");
  });

  test("manifest ahead but bump within grace => ok (build window)", () => {
    const r = evaluateTrain({
      ...green, intended: "0.27.0", intendedBumpAgeHours: 1,
      published: { version: "0.26.0", publishedAt: "x" }, channels: [],
    });
    expect(r.find((e) => e.edge === "t:phantom")?.verdict).toBe("ok");
  });

  test("winget not covered, past grace => stale", () => {
    const r = evaluateTrain({
      ...green, channels: [ch({ kind: "winget", version: null, covered: false })],
    });
    expect(r.find((e) => e.edge === "t:winget")?.verdict).toBe("stale");
  });

  test("transient channel read => indeterminate, never stale", () => {
    const r = evaluateTrain({
      ...green, channels: [ch({ kind: "brew", status: "indeterminate" })],
    });
    expect(r.find((e) => e.edge === "t:brew")?.verdict).toBe("indeterminate");
  });

  test("absent channel file, past grace => stale", () => {
    const r = evaluateTrain({ ...green, channels: [ch({ kind: "brew", status: "absent" })] });
    expect(r.find((e) => e.edge === "t:brew")?.verdict).toBe("stale");
  });
});

describe("decideExit", () => {
  test("a stale or phantom edge => exit 1 with ::error::", () => {
    const out = decideExit([{ edge: "t:brew", verdict: "stale", detail: "d" }], true);
    expect(out.code).toBe(1);
    expect(out.messages.join("\n")).toContain("::error::");
  });
  test("only ok + indeterminate => exit 0 with a warning", () => {
    const out = decideExit(
      [{ edge: "t:brew", verdict: "ok", detail: "d" }, { edge: "t:scoop", verdict: "indeterminate", detail: "d" }],
      true,
    );
    expect(out.code).toBe(0);
    expect(out.messages.join("\n")).toContain("::warning::");
  });
  test("everything indeterminate under --strict => exit 1 (not 'all clear')", () => {
    const out = decideExit([{ edge: "t:brew", verdict: "indeterminate", detail: "d" }], true);
    expect(out.code).toBe(1);
  });
  test("everything indeterminate when NOT strict => exit 0 (soft)", () => {
    const out = decideExit([{ edge: "t:brew", verdict: "indeterminate", detail: "d" }], false);
    expect(out.code).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts`
Expected: FAIL — `evaluateTrain`/`decideExit` not exported.

- [ ] **Step 3: Implement** — append to `check-release-staleness.ts`:

```ts
export type EdgeVerdict = "ok" | "stale" | "phantom" | "indeterminate";
export interface EdgeResult {
  edge: string;
  verdict: EdgeVerdict;
  detail: string;
}
export interface ChannelReading {
  kind: string;
  status: "read" | "absent" | "indeterminate";
  /** version-file channels (brew/scoop/linux); null for winget or unread. */
  version: string | null;
  /** winget only: is the published version covered; null otherwise. */
  covered: boolean | null;
}
export interface TrainEvalInput {
  name: string;
  intended: string;
  intendedBumpAgeHours: number;
  published: PublishedRelease | null;
  publishedAgeHours: number | null;
  channels: ChannelReading[];
  graceHours: number;
}

export function evaluateTrain(i: TrainEvalInput): EdgeResult[] {
  const results: EdgeResult[] = [];
  const pubVer = i.published ? stripV(i.published.version) : null;

  // --- phantom edge: intended must have a matching built (asset-bearing) release ---
  const intendedAhead = pubVer === null || Bun.semver.order(stripV(i.intended), pubVer) > 0;
  if (intendedAhead) {
    if (i.intendedBumpAgeHours > i.graceHours) {
      results.push({
        edge: `${i.name}:phantom`,
        verdict: "phantom",
        detail: `manifest ${i.intended} has no built Release with assets (latest published: ${i.published?.version ?? "none"}); bump is ${Math.round(i.intendedBumpAgeHours)}h old (> ${i.graceHours}h grace)`,
      });
    } else {
      results.push({
        edge: `${i.name}:phantom`,
        verdict: "ok",
        detail: `manifest ${i.intended} ahead of published ${i.published?.version ?? "none"} but within ${i.graceHours}h grace`,
      });
    }
  } else {
    results.push({
      edge: `${i.name}:phantom`,
      verdict: "ok",
      detail: `manifest ${i.intended} matches published ${i.published?.version}`,
    });
  }

  // --- channel edges: only meaningful once a release is published AND past grace ---
  if (pubVer === null) return results;
  const pastGrace = i.publishedAgeHours !== null && i.publishedAgeHours > i.graceHours;

  for (const ch of i.channels) {
    const edge = `${i.name}:${ch.kind}`;
    if (!pastGrace) {
      results.push({ edge, verdict: "ok", detail: `within ${i.graceHours}h grace` });
      continue;
    }
    if (ch.status === "indeterminate") {
      results.push({ edge, verdict: "indeterminate", detail: "channel read failed transiently" });
      continue;
    }
    if (ch.status === "absent") {
      results.push({ edge, verdict: "stale", detail: "channel file/dir absent" });
      continue;
    }
    if (ch.kind === "winget") {
      results.push(
        ch.covered
          ? { edge, verdict: "ok", detail: `winget covers ${pubVer} (merged dir or open PR)` }
          : { edge, verdict: "stale", detail: `no winget dir and no open PR for ${pubVer}` },
      );
      continue;
    }
    const chVer = ch.version ? stripV(ch.version) : null;
    if (chVer === null) {
      results.push({ edge, verdict: "indeterminate", detail: "channel version unparseable" });
      continue;
    }
    results.push(
      Bun.semver.order(chVer, pubVer) >= 0
        ? { edge, verdict: "ok", detail: `${ch.kind} ${chVer} >= published ${pubVer}` }
        : { edge, verdict: "stale", detail: `${ch.kind} ${chVer} < published ${pubVer}` },
    );
  }
  return results;
}

/**
 * Exit decision. Any stale/phantom edge => red. Otherwise green with a warning
 * per indeterminate edge — EXCEPT a run where nothing was evaluable (no ok, only
 * indeterminate) under --strict is red: "indeterminate" must not read as "all
 * clear" in the scheduled sweep (the team-reachability rule).
 */
export function decideExit(results: EdgeResult[], strict: boolean): { code: 0 | 1; messages: string[] } {
  const messages: string[] = [];
  const hard = results.filter((r) => r.verdict === "phantom" || r.verdict === "stale");
  const indet = results.filter((r) => r.verdict === "indeterminate");
  const ok = results.filter((r) => r.verdict === "ok");
  for (const r of hard) messages.push(`::error::${r.edge}: ${r.detail}`);
  for (const r of indet) messages.push(`::warning::${r.edge}: ${r.detail} (indeterminate)`);
  if (hard.length > 0) return { code: 1, messages };
  if (ok.length === 0 && indet.length > 0 && strict) {
    messages.push("::error::release-staleness: indeterminate — nothing could be evaluated (all reads failed transiently)");
    return { code: 1, messages };
  }
  return { code: 0, messages };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/structure-audit/check-release-staleness.ts scripts/structure-audit/check-release-staleness.test.ts
git commit -m "feat(audit): release-staleness evaluation engine (grace-aware, fail-closed indeterminate)"
```

---

## Task 5: The manifest + `loadTrainManifest` + the gh-reading shell + registration

**Files:**
- Create: `.github/release-train.json`
- Modify: `scripts/structure-audit/check-release-staleness.ts` (add `loadTrainManifest` + `import.meta.main` shell)
- Test: `scripts/structure-audit/check-release-staleness.test.ts` (`loadTrainManifest`)
- Modify: `package.json`
- Modify: `scripts/lib/preflight-gates.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–4, plus `runGh` / `isStrict` / `strictSkip` / `classifyReadFailure` / `isRecord` from `_gh-audit.ts`.
- Produces: `interface TrainManifest { graceHours: number; trains: TrainSpec[] }`; `loadTrainManifest(json: string): TrainManifest`.

- [ ] **Step 1: Create the manifest** — `.github/release-train.json`:

```json
{
  "$comment": "P2 Release Train edges. audit:release-staleness reads each downstream's LIVE version and fails when it lags the published source past graceHours. See docs/infrastructure-roadmap.md P2 + docs/superpowers/specs/2026-07-24-p2-release-train-design.md.",
  "graceHours": 6,
  "trains": [
    {
      "name": "nimbus-gateway",
      "source": {
        "manifestRepo": "nimbus-agent/Nimbus",
        "manifestFile": ".release-please-manifest.json",
        "manifestKey": ".",
        "releaseAsset": "SHA256SUMS"
      },
      "channels": [
        { "kind": "brew", "repo": "nimbus-agent/homebrew-tap", "path": "Formula/nimbus.rb" },
        { "kind": "scoop", "repo": "nimbus-agent/scoop-bucket", "path": "bucket/nimbus.json" },
        { "kind": "linux", "repo": "nimbus-agent/linux-repo", "path": "apt/dists/stable/main/binary-amd64/Packages" },
        { "kind": "winget", "package": "NimbusAgent.Nimbus", "wingetRepo": "microsoft/winget-pkgs" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write the failing test** for the manifest loader — add to `check-release-staleness.test.ts`:

```ts
import { loadTrainManifest } from "./check-release-staleness.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("loadTrainManifest", () => {
  test("parses graceHours + trains", () => {
    const m = loadTrainManifest('{"graceHours":6,"trains":[{"name":"x","source":{"manifestRepo":"a/b","manifestFile":"m.json","manifestKey":".","releaseAsset":"S"},"channels":[]}]}');
    expect(m.graceHours).toBe(6);
    expect(m.trains[0]?.name).toBe("x");
  });
  test("throws on a malformed manifest", () => {
    expect(() => loadTrainManifest("{}")).toThrow();
  });
  test("the committed .github/release-train.json is valid", () => {
    const raw = readFileSync(join(import.meta.dir, "..", "..", ".github", "release-train.json"), "utf8");
    const m = loadTrainManifest(raw);
    expect(m.trains.length).toBeGreaterThan(0);
    expect(m.trains[0]?.channels.some((c) => c.kind === "winget")).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts`
Expected: FAIL — `loadTrainManifest` not exported.

- [ ] **Step 4: Implement `loadTrainManifest` + the types + the shell** — append to `check-release-staleness.ts`. First the manifest types + loader:

```ts
import { classifyReadFailure, isRecord, isStrict, runGh, strictSkip } from "./_gh-audit.ts";

export interface ChannelSpec {
  kind: "brew" | "scoop" | "linux" | "winget";
  repo?: string;
  path?: string;
  package?: string;
  wingetRepo?: string;
}
export interface TrainSpec {
  name: string;
  source: { manifestRepo: string; manifestFile: string; manifestKey: string; releaseAsset: string };
  channels: ChannelSpec[];
}
export interface TrainManifest {
  graceHours: number;
  trains: TrainSpec[];
}

export function loadTrainManifest(json: string): TrainManifest {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || typeof parsed["graceHours"] !== "number" || !Array.isArray(parsed["trains"])) {
    throw new Error("release-train.json: expected { graceHours: number, trains: [...] }");
  }
  return parsed as unknown as TrainManifest;
}
```

Then the age helper + gh readers + `import.meta.main` shell:

```ts
/** Hours between an ISO-8601 (Z-suffixed) timestamp and now, UTC epoch-ms math. */
export function ageHours(isoZ: string): number {
  return (Date.now() - new Date(isoZ).getTime()) / 3_600_000;
}

/** Decode a GitHub contents API base64 `.content` envelope to UTF-8 text. */
function decodeContents(base64Envelope: string): string {
  return Buffer.from(base64Envelope.replace(/\s/g, ""), "base64").toString("utf8");
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const label = "audit:release-staleness";

  // Reachability probe (mirrors cla-coverage): one public read. If gh/network is
  // unavailable at all, soft-skip locally / red in strict.
  const probe = runGh(["gh", "api", "repos/nimbus-agent/Nimbus", "--jq", ".name"]);
  if (!probe.ok) {
    const outcome = strictSkip(label, strict);
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }

  const manifest = loadTrainManifest(
    await Bun.file(new URL("../../.github/release-train.json", import.meta.url)).text(),
  );

  const allResults: EdgeResult[] = [];
  for (const train of manifest.trains) {
    // --- intended (manifest version on main) + bump-commit age ---
    const manRes = runGh([
      "gh", "api",
      `repos/${train.source.manifestRepo}/contents/${train.source.manifestFile}?ref=main`,
      "--jq", ".content",
    ]);
    const intendedJson = manRes.ok ? decodeContents(manRes.stdout) : "{}";
    const intendedParsed: unknown = JSON.parse(intendedJson);
    const intended = isRecord(intendedParsed) && typeof intendedParsed[train.source.manifestKey] === "string"
      ? (intendedParsed[train.source.manifestKey] as string)
      : "";
    const bumpRes = runGh([
      "gh", "api",
      `repos/${train.source.manifestRepo}/commits?path=${train.source.manifestFile}&per_page=1`,
      "--jq", ".[0].commit.committer.date",
    ]);
    const intendedBumpAgeHours = bumpRes.ok && bumpRes.stdout.trim() ? ageHours(bumpRes.stdout.trim()) : Number.POSITIVE_INFINITY;

    // --- published (latest release-with-assets) ---
    const relRes = runGh([
      "gh", "api", `repos/${train.source.manifestRepo}/releases?per_page=100`,
      "--jq", "[.[] | {tag: .tag_name, prerelease: .prerelease, draft: .draft, publishedAt: .published_at, assets: [.assets[].name]}]",
    ]);
    let published: PublishedRelease | null = null;
    if (relRes.ok) {
      const rels: unknown = JSON.parse(relRes.stdout);
      if (Array.isArray(rels)) published = selectPublished(rels as ReleaseInfo[], train.source.releaseAsset);
    }
    const publishedAgeHours = published ? ageHours(published.publishedAt) : null;

    // --- channels ---
    const readings: ChannelReading[] = [];
    for (const ch of train.channels) {
      readings.push(await readChannel(ch, published?.version ?? null));
    }

    allResults.push(...evaluateTrain({
      name: train.name, intended, intendedBumpAgeHours, published, publishedAgeHours,
      channels: readings, graceHours: manifest.graceHours,
    }));
  }

  const out = decideExit(allResults, strict);
  for (const m of out.messages) (m.startsWith("::error::") ? console.error : console.warn)(m);
  if (out.code === 0) console.log(`${label}: OK (${allResults.filter((r) => r.verdict === "ok").length} edges current)`);
  process.exit(out.code);
}

/** Read one channel's live version (or winget coverage). Public reads only. */
async function readChannel(ch: ChannelSpec, publishedVersion: string | null): Promise<ChannelReading> {
  if (ch.kind === "winget") {
    if (!publishedVersion) return { kind: "winget", status: "read", version: null, covered: true };
    const dirRes = runGh(["gh", "api", `repos/${ch.wingetRepo}/contents/${wingetDirPath(ch.package ?? "", publishedVersion)}`, "--jq", "length"]);
    const dir = dirRes.ok ? true : classifyReadFailure(dirRes.httpStatus) === "absent" ? false : null;
    let pr: boolean | null = false;
    if (dir !== true) {
      const prRes = runGh(["gh", "pr", "list", "--repo", ch.wingetRepo ?? "", "--state", "open", "--search", `in:title ${ch.package} ${publishedVersion}`, "--json", "number", "--jq", "length"]);
      pr = prRes.ok ? Number(prRes.stdout.trim()) > 0 : null;
    }
    const { status, covered } = resolveWingetCoverage(dir, pr);
    return { kind: "winget", status, version: null, covered };
  }
  // version-file channels
  const res = runGh(["gh", "api", `repos/${ch.repo}/contents/${ch.path}`, "--jq", ".content"]);
  if (!res.ok) {
    const linuxGz = ch.kind === "linux" ? await tryLinuxGz(ch) : null;
    if (linuxGz !== null) return linuxGz;
    return { kind: ch.kind, status: classifyReadFailure(res.httpStatus), version: null, covered: null };
  }
  const text = decodeContents(res.stdout);
  const version = ch.kind === "brew" ? parseBrewVersion(text) : ch.kind === "scoop" ? parseScoopVersion(text) : parseLinuxVersion(text);
  return { kind: ch.kind, status: "read", version, covered: null };
}

/** Fallback: some apt repos serve only Packages.gz — decode it in-memory. */
async function tryLinuxGz(ch: ChannelSpec): Promise<ChannelReading | null> {
  const gz = runGh(["gh", "api", `repos/${ch.repo}/contents/${ch.path}.gz`, "--jq", ".content"]);
  if (!gz.ok) return null;
  const bytes = Buffer.from(gz.stdout.replace(/\s/g, ""), "base64");
  const text = new TextDecoder().decode(Bun.gunzipSync(bytes));
  return { kind: ch.kind, status: "read", version: parseLinuxVersion(text), covered: null };
}
```

- [ ] **Step 5: Register the gate** — in `package.json`, add to the scripts block (next to the other `audit:*-drift` entries near line 168):

```json
    "audit:release-staleness": "bun scripts/structure-audit/check-release-staleness.ts",
```

In `scripts/lib/preflight-gates.ts`, add to `CI_ONLY_GATES` (after the `audit:cla-coverage` line):

```ts
  "audit:release-staleness", // needs network + gh (public reads across release + channel repos); runs only in org-drift-sweep.yml with --strict, never the local FAST tier
```

- [ ] **Step 6: Run the tests + typecheck + lint**

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts && bun run typecheck && bunx biome check scripts`
Expected: tests PASS; typecheck clean (no `any`); biome clean.

- [ ] **Step 7: Commit**

```bash
git add scripts/structure-audit/check-release-staleness.ts scripts/structure-audit/check-release-staleness.test.ts .github/release-train.json package.json scripts/lib/preflight-gates.ts
git commit -m "feat(audit): release-train manifest + gh-reading shell + gate registration"
```

---

## Task 6: Wire the org-drift-sweep job + preflight + live proof

**Files:**
- Modify: `.github/workflows/org-drift-sweep.yml`

**Interfaces:**
- Consumes: the `audit:release-staleness` gate (Task 5).

- [ ] **Step 1: Add the job** — append to `.github/workflows/org-drift-sweep.yml` (after the `cla-coverage` job). No App-token mint — public reads use the default `github.token`:

```yaml
  release-staleness:
    name: release-staleness
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - name: Checkout Nimbus
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: latest
      # No App token: every read (Nimbus releases + manifest, the channel repos,
      # microsoft/winget-pkgs) is PUBLIC. The default github.token authenticates
      # gh at 5000 req/hr, far above this job's handful of reads + one search.
      - name: Audit release-train staleness
        env:
          GH_TOKEN: ${{ github.token }}
        run: bun scripts/structure-audit/check-release-staleness.ts --strict
```

- [ ] **Step 2: Verify the drift guard passes** (the new gate must be registered):

Run: `bun test scripts/preflight.test.ts`
Expected: PASS — `release-staleness` invokes `bun scripts/...ts` directly (not `bun run <id>`), so the workflow-gate extractor does not require it; the `CI_ONLY_GATES` entry from Task 5 keeps intent documented and future-proofs a `bun run` switch.

- [ ] **Step 3: Run the full scoped test suite + preflight:fast**

Run: `bun test scripts/structure-audit/ && bun run preflight:fast`
Expected: all green. (If `preflight:fast` soft-warns on the network gates locally, that is expected — they are fail-soft off CI.)

- [ ] **Step 4: Live proof — run the gate against the real channels**

Run: `GH_TOKEN=$(gh auth token) bun scripts/structure-audit/check-release-staleness.ts`
Expected: one of two correct outcomes —
  - **GREEN** (`audit:release-staleness: OK`) if `v0.27.0` (or whatever the manifest claims) is published-with-assets and every channel has caught up; **or**
  - **RED** with a specific `::error::nimbus-gateway:phantom` or `:<channel>` line if there is a genuine live gap (the spec's documented 0.27.0-vs-0.26.0 heads-up — a real phantom the gate correctly surfaces).

Record which outcome occurred in the PR description. A RED here is the gate working — do **not** "fix" the gate to make it green; if it is a real phantom, note it for the release playbook. If GREEN, proceed.

- [ ] **Step 5: Red-prove the gate** — confirm it *would* go red on regression, without touching production channels. Add and immediately run a scratch test that feeds `evaluateTrain` a stale channel (this is already covered by Task 4's `"channel behind published, past grace => stale"` test — re-run it as the proof):

Run: `bun test scripts/structure-audit/check-release-staleness.test.ts -t "stale"`
Expected: the stale/phantom cases PASS (they assert the RED verdict). This is the red-before/green-after evidence the program's definition-of-done requires: the engine returns `stale`/`phantom` on a lagging input and `ok` on a current one.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/org-drift-sweep.yml
git commit -m "ci(infra): add release-staleness job to org-drift-sweep (P2 Release Train)"
```

---

## Post-implementation (not a task — for the PR author)

- **Roadmap:** flip the P2 row in `docs/infrastructure-roadmap.md` to reflect the shipped Phase-1 gate + record the run number of the first green `org-drift-sweep` that includes `release-staleness` (the program's *done* bar). Note Phase 2 (dep-DAG edges) as the remaining P2 slice.
- **CHANGELOG:** add a `docs/CHANGELOG.md` line per the connector-docs-changelog convention (infra gate delivery), NOT the CLAUDE.md status line.
- **Memory:** update `[[org-infrastructure-program]]` — P2 Phase 1 shipped; the live-proof outcome (green or a caught phantom); Phase 2 remaining.
- **Live-in-CI proof:** after merge, dispatch `org-drift-sweep.yml` (`gh workflow run org-drift-sweep.yml`) once so the net-new job runs on main; confirm the `release-staleness` job is green (or red on a real gap). Per the branch-only-workflow gotcha, a net-new job's first real run is post-merge.

---

## Self-Review

**Spec coverage:**
- Three heads (intended/published/distributed) → Task 3 (`selectPublished`) + Task 4 (`evaluateTrain`). ✓
- Declarative manifest → Task 5 (`.github/release-train.json` + `loadTrainManifest`). ✓
- Grace window + PR-opened-for-winget → Task 4 (grace gating) + Task 3 (`resolveWingetCoverage`) + Task 5 (`readChannel` winget dir/PR). ✓
- Pure read-only observer, no publish-workflow changes → confirmed: no publish workflow is touched. ✓
- No App token / public reads → Task 6 (`GH_TOKEN: github.token`, no mint step). ✓
- 404-vs-transient + 403 rate-limit → indeterminate → Task 1 (`classifyReadFailure`) + Task 4 (indeterminate verdict) + Task 5 (`readChannel`). ✓
- `_gh-audit.ts` enhancement closes CLA-coverage follow-up → Task 1 + Task 2. ✓
- linux Packages.gz fallback → Task 5 (`tryLinuxGz`). ✓
- UTC epoch-ms time math → Task 5 (`ageHours`). ✓
- Registration + drift guard → Task 5 (package.json + CI_ONLY_GATES) + Task 6 (verify). ✓
- Fail-soft-local / strict-in-CI → Task 4 (`decideExit` strict) + Task 5 (probe → `strictSkip`). ✓
- Scheduled sweep placement → Task 6. ✓
- Definition of done (red-before/green-after) → Task 6 Step 5. ✓
- Phase 2 (dep-DAG) → explicitly out of scope; sketched in spec only. ✓

**Placeholder scan:** no TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `PublishedRelease`, `ReleaseInfo`, `ChannelReading`, `EdgeResult`, `TrainEvalInput`, `TrainManifest`/`TrainSpec`/`ChannelSpec` are defined once (Tasks 3–5) and used consistently. `evaluateTrain`/`decideExit`/`selectPublished`/`resolveWingetCoverage`/`loadTrainManifest`/`classifyReadFailure`/`parseHttpStatus` names match across tasks. ✓
