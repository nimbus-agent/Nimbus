# Release-Health Verification & Secret-Health Monitor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the release pipeline fail loudly when a published release is missing assets, surface any failed release run as a de-duped GitHub issue, and proactively catch dead/expiring release credentials on a weekly schedule.

**Architecture:** Three unit-tested Bun/TS scripts under `scripts/release/` (asset-diff, secret-health, issue helper) sharing a thin injectable GitHub REST seam. A hard asset-check step is added to the existing `publish-release` job; an `alert-on-failure` job files the issue; a new `secret-health.yml` runs the monitor weekly. Pure logic is separated from I/O and dependency-injected so every decision is tested without network, `gpg`, or `openssl`.

**Tech Stack:** Bun v1.2+, TypeScript 6 strict, `bun:test`, GitHub Actions, Bun native `fetch` (no octokit dependency), `gpg` + `openssl` (present on `ubuntu-latest`, injected + mockable).

## Global Constraints

- Runtime: **Bun v1.2+ / TypeScript 6 strict**. **No `any`** — use `unknown` for external data (Non-Negotiable #7).
- **No plaintext credentials in logs or argv** (Non-Negotiable #3): passphrases via `env:` / `--passphrase-fd`; base64 payloads via `0600` temp files under `$RUNNER_TEMP`; never as command-line arguments.
- **No new runtime dependency** — use Bun native `fetch`; do not `bun add` octokit / node-forge / openpgp.js (design-review #3b).
- Third-party GitHub Actions `uses:` refs MUST be pinned to a full 40-hex SHA (`audit:action-sha-pins`). Reuse existing pins: `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0`, `step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411`. Local composite `./.github/actions/setup-nimbus-ci` needs no pin.
- Repo self-reference is read from `process.env.GITHUB_REPOSITORY` — never hardcode `nimbus-agent/Nimbus` (design-review #5b).
- Cross-platform: build paths with `path.join()` (Non-Negotiable #5 / `audit:cross-platform`).
- Scripts live under `scripts/release/` (new dir). `scripts/` is outside the coverage-floor glob, so there is no per-file coverage gate — but every pure function still gets tests (repo testing philosophy).
- Alerts go only to **de-duped GitHub issues** labeled `release-health` (no Slack/email — design decision).
- Cadence: monitor runs weekly (Mondays 09:00 UTC) + `workflow_dispatch`; cert warning threshold default **21 days**, overridable via a `threshold_days` dispatch input.
- Docs under `docs/**` must pass `bun run lint:markdown` (markdownlint), and run `bun run preflight:fast` before pushing — the docs-quality gate covers committed spec/plan `.md` files.

---

### Task 1: GitHub REST seam (`gh-api.ts`)

Thin injectable client — the single I/O boundary every script depends on. Consumers are tested against a fake implementing `GitHubApi`; this file's own test asserts request construction via an injected `fetch`.

**Files:**

- Create: `scripts/release/gh-api.ts`
- Test: `scripts/release/gh-api.test.ts`

**Interfaces:**

- Consumes: nothing (leaf).
- Produces:

  ```ts
  export interface ReleaseAsset { readonly name: string; readonly size: number; }
  export interface Release { readonly tagName: string; readonly assets: readonly ReleaseAsset[]; }
  export interface IssueRef { readonly number: number; readonly body: string; readonly createdAt: string; }
  export interface RepoPerms { readonly push: boolean; }
  export interface ProbeResult { readonly status: number; readonly scopes: string | null; }
  export interface GitHubApi {
    getReleaseByTag(tag: string): Promise<Release | null>;
    getRepoPermissions(ownerRepo: string, token?: string): Promise<RepoPerms | { status: number }>; // token overrides the default → check the PAT under test, not the runner token (plan-review #1)
    probeToken(token: string): Promise<ProbeResult>;      // GET /rate_limit with the given token
    listOpenIssues(label: string): Promise<IssueRef[]>;
    createIssue(title: string, body: string, labels: string[]): Promise<number>;
    updateIssue(num: number, body: string): Promise<void>;
    commentIssue(num: number, body: string): Promise<void>;
    closeIssue(num: number, comment: string): Promise<void>;
    ensureLabel(label: string): Promise<void>;
  }
  export function createGitHubApi(opts: {
    token: string; repo: string; fetchFn?: typeof fetch;
  }): GitHubApi;
  ```

- [ ] **Step 1: Write the failing test** (`scripts/release/gh-api.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { createGitHubApi } from "./gh-api.ts";

function fakeFetch(capture: { url?: string; headers?: Record<string, string> }, body: unknown, status = 200) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("createGitHubApi", () => {
  test("getReleaseByTag builds the tag URL with auth + api-version headers", async () => {
    const cap: { url?: string; headers?: Record<string, string> } = {};
    const api = createGitHubApi({ token: "t0", repo: "o/r", fetchFn: fakeFetch(cap, { tag_name: "v1.2.3", assets: [{ name: "a", size: 3 }] }) });
    const rel = await api.getReleaseByTag("v1.2.3");
    expect(cap.url).toBe("https://api.github.com/repos/o/r/releases/tags/v1.2.3");
    expect(cap.headers?.authorization).toBe("Bearer t0");
    expect(cap.headers?.["x-github-api-version"]).toBe("2022-11-28");
    expect(rel).toEqual({ tagName: "v1.2.3", assets: [{ name: "a", size: 3 }] });
  });

  test("getReleaseByTag returns null on 404", async () => {
    const api = createGitHubApi({ token: "t", repo: "o/r", fetchFn: fakeFetch({}, {}, 404) });
    expect(await api.getReleaseByTag("v9")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/gh-api.test.ts`
Expected: FAIL — `Cannot find module './gh-api.ts'`.

- [ ] **Step 3: Write minimal implementation** (`scripts/release/gh-api.ts`)

```ts
const API = "https://api.github.com";
const COMMON = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } as const;

export interface ReleaseAsset { readonly name: string; readonly size: number; }
export interface Release { readonly tagName: string; readonly assets: readonly ReleaseAsset[]; }
export interface IssueRef { readonly number: number; readonly body: string; readonly createdAt: string; }
export interface RepoPerms { readonly push: boolean; }
export interface ProbeResult { readonly status: number; readonly scopes: string | null; }

export interface GitHubApi {
  getReleaseByTag(tag: string): Promise<Release | null>;
  getRepoPermissions(ownerRepo: string, token?: string): Promise<RepoPerms | { status: number }>;
  probeToken(token: string): Promise<ProbeResult>;
  listOpenIssues(label: string): Promise<IssueRef[]>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  updateIssue(num: number, body: string): Promise<void>;
  commentIssue(num: number, body: string): Promise<void>;
  closeIssue(num: number, comment: string): Promise<void>;
  ensureLabel(label: string): Promise<void>;
}

export function createGitHubApi(opts: { token: string; repo: string; fetchFn?: typeof fetch }): GitHubApi {
  const f = opts.fetchFn ?? fetch;
  const auth = (token = opts.token) => ({ ...COMMON, authorization: `Bearer ${token}` });
  const j = async (res: Response): Promise<unknown> => (await res.json()) as unknown;

  return {
    async getReleaseByTag(tag) {
      const res = await f(`${API}/repos/${opts.repo}/releases/tags/${tag}`, { headers: auth() });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getReleaseByTag ${tag}: HTTP ${res.status}`);
      const data = (await j(res)) as { tag_name: string; assets: { name: string; size: number }[] };
      return { tagName: data.tag_name, assets: data.assets.map((a) => ({ name: a.name, size: a.size })) };
    },
    async getRepoPermissions(ownerRepo, token) {
      const res = await f(`${API}/repos/${ownerRepo}`, { headers: auth(token) }); // token undefined → default; else the PAT under test
      if (!res.ok) return { status: res.status };
      const data = (await j(res)) as { permissions?: { push?: boolean } };
      return { push: data.permissions?.push === true };
    },
    async probeToken(token) {
      const res = await f(`${API}/rate_limit`, { headers: auth(token) });
      return { status: res.status, scopes: res.headers.get("x-oauth-scopes") };
    },
    async listOpenIssues(label) {
      const res = await f(`${API}/repos/${opts.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`, { headers: auth() });
      if (!res.ok) throw new Error(`listOpenIssues: HTTP ${res.status}`);
      const data = (await j(res)) as { number: number; body: string | null; created_at: string }[];
      return data.map((i) => ({ number: i.number, body: i.body ?? "", createdAt: i.created_at }));
    },
    async createIssue(title, body, labels) {
      const res = await f(`${API}/repos/${opts.repo}/issues`, { method: "POST", headers: auth(), body: JSON.stringify({ title, body, labels }) });
      if (!res.ok) throw new Error(`createIssue: HTTP ${res.status}`);
      return ((await j(res)) as { number: number }).number;
    },
    async updateIssue(num, body) {
      const res = await f(`${API}/repos/${opts.repo}/issues/${num}`, { method: "PATCH", headers: auth(), body: JSON.stringify({ body }) });
      if (!res.ok) throw new Error(`updateIssue: HTTP ${res.status}`);
    },
    async commentIssue(num, body) {
      const res = await f(`${API}/repos/${opts.repo}/issues/${num}/comments`, { method: "POST", headers: auth(), body: JSON.stringify({ body }) });
      if (!res.ok) throw new Error(`commentIssue: HTTP ${res.status}`);
    },
    async closeIssue(num, comment) {
      await this.commentIssue(num, comment);
      const res = await f(`${API}/repos/${opts.repo}/issues/${num}`, { method: "PATCH", headers: auth(), body: JSON.stringify({ state: "closed" }) });
      if (!res.ok) throw new Error(`closeIssue: HTTP ${res.status}`);
    },
    async ensureLabel(label) {
      const res = await f(`${API}/repos/${opts.repo}/labels`, { method: "POST", headers: auth(), body: JSON.stringify({ name: label, color: "d93f0b" }) });
      if (!res.ok && res.status !== 422) throw new Error(`ensureLabel: HTTP ${res.status}`); // 422 = already exists
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/release/gh-api.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/release/gh-api.ts scripts/release/gh-api.test.ts
git commit -m "feat(release-health): injectable GitHub REST seam"
```

---

### Task 2: Asset-completeness gate (`verify-release-assets.ts`)

**Files:**

- Create: `scripts/release/verify-release-assets.ts`
- Test: `scripts/release/verify-release-assets.test.ts`

**Interfaces:**

- Consumes: `GitHubApi`, `Release`, `ReleaseAsset` from `gh-api.ts`.
- Produces:

  ```ts
  export interface LocalFile { readonly name: string; readonly size: number; }
  export interface AssetGap { readonly name: string; readonly reason: "missing" | "zero-byte"; }
  export function diffReleaseAssets(local: readonly LocalFile[], remote: readonly ReleaseAsset[]): AssetGap[];
  export function runVerify(deps: { api: GitHubApi; tag: string; local: readonly LocalFile[]; requireSums?: boolean }): Promise<{ ok: boolean; gaps: AssetGap[]; summary: string }>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { diffReleaseAssets, runVerify } from "./verify-release-assets.ts";
import type { GitHubApi, Release } from "./gh-api.ts";

describe("diffReleaseAssets", () => {
  const local = [{ name: "SHA256SUMS", size: 10 }, { name: "nimbus.deb", size: 500 }];
  test("complete set → no gaps", () => {
    expect(diffReleaseAssets(local, [{ name: "SHA256SUMS", size: 10 }, { name: "nimbus.deb", size: 500 }])).toEqual([]);
  });
  test("missing file → gap", () => {
    expect(diffReleaseAssets(local, [{ name: "SHA256SUMS", size: 10 }])).toEqual([{ name: "nimbus.deb", reason: "missing" }]);
  });
  test("zero-byte remote asset → gap", () => {
    expect(diffReleaseAssets(local, [{ name: "SHA256SUMS", size: 10 }, { name: "nimbus.deb", size: 0 }])).toEqual([{ name: "nimbus.deb", reason: "zero-byte" }]);
  });
  test("extra remote asset → ignored", () => {
    expect(diffReleaseAssets(local, [{ name: "SHA256SUMS", size: 10 }, { name: "nimbus.deb", size: 5 }, { name: "extra", size: 9 }])).toEqual([]);
  });
});

function fakeApi(release: Release | null): GitHubApi {
  return { getReleaseByTag: async () => release } as unknown as GitHubApi;
}

describe("runVerify", () => {
  const local = [{ name: "SHA256SUMS", size: 10 }, { name: "SHA256SUMS.asc", size: 5 }, { name: "nimbus.deb", size: 9 }];
  test("all present → ok", async () => {
    const r = await runVerify({ api: fakeApi({ tagName: "v1", assets: local }), tag: "v1", local });
    expect(r.ok).toBe(true);
    expect(r.gaps).toEqual([]);
  });
  test("missing asset → not ok, gap listed", async () => {
    const r = await runVerify({ api: fakeApi({ tagName: "v1", assets: local.slice(0, 2) }), tag: "v1", local });
    expect(r.ok).toBe(false);
    expect(r.gaps).toEqual([{ name: "nimbus.deb", reason: "missing" }]);
    expect(r.summary).toContain("nimbus.deb");
  });
  test("no release at all → not ok", async () => {
    const r = await runVerify({ api: fakeApi(null), tag: "v1", local });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("no release");
  });
  test("SHA256SUMS.asc absent → not ok (sanity assert)", async () => {
    const l = [{ name: "SHA256SUMS", size: 10 }, { name: "nimbus.deb", size: 9 }];
    const r = await runVerify({ api: fakeApi({ tagName: "v1", assets: l }), tag: "v1", local: l, requireSums: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("SHA256SUMS.asc");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/verify-release-assets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createGitHubApi, type GitHubApi, type ReleaseAsset } from "./gh-api.ts";

export interface LocalFile { readonly name: string; readonly size: number; }
export interface AssetGap { readonly name: string; readonly reason: "missing" | "zero-byte"; }

export function diffReleaseAssets(local: readonly LocalFile[], remote: readonly ReleaseAsset[]): AssetGap[] {
  const bySize = new Map(remote.map((a) => [a.name, a.size]));
  const gaps: AssetGap[] = [];
  for (const f of local) {
    if (!bySize.has(f.name)) gaps.push({ name: f.name, reason: "missing" });
    else if (bySize.get(f.name) === 0) gaps.push({ name: f.name, reason: "zero-byte" });
  }
  return gaps;
}

const REQUIRED = ["SHA256SUMS", "SHA256SUMS.asc"] as const;

export async function runVerify(deps: { api: GitHubApi; tag: string; local: readonly LocalFile[]; requireSums?: boolean }): Promise<{ ok: boolean; gaps: AssetGap[]; summary: string }> {
  const release = await deps.api.getReleaseByTag(deps.tag);
  if (release === null) {
    return { ok: false, gaps: [], summary: `❌ ${deps.tag}: no release found for tag — nothing was published.` };
  }
  const gaps = diffReleaseAssets(deps.local, release.assets);
  const names = new Set(release.assets.map((a) => a.name));
  const missingRequired = (deps.requireSums ?? true) ? REQUIRED.filter((r) => !names.has(r)) : [];
  const ok = gaps.length === 0 && missingRequired.length === 0;
  const lines = [`Release ${deps.tag}: ${release.assets.length} asset(s), ${deps.local.length} expected.`];
  for (const g of gaps) lines.push(`- ${g.reason.toUpperCase()}: ${g.name}`);
  for (const r of missingRequired) lines.push(`- REQUIRED MISSING: ${r}`);
  lines.push(ok ? "✅ all expected assets present." : "❌ release is incomplete.");
  return { ok, gaps, summary: lines.join("\n") };
}

function listStage(stageDir: string): LocalFile[] {
  return readdirSync(stageDir).map((name) => ({ name, size: statSync(join(stageDir, name)).size }));
}

if (import.meta.main) {
  const tag = process.env["GITHUB_REF_NAME"];
  const repo = process.env["GITHUB_REPOSITORY"];
  const token = process.env["GITHUB_TOKEN"];
  const stageDir = process.env["STAGE_DIR"] ?? "dist/stage";
  if (!tag || !repo || !token) {
    console.error("verify-release-assets: GITHUB_REF_NAME, GITHUB_REPOSITORY, GITHUB_TOKEN required");
    process.exit(2);
  }
  const api = createGitHubApi({ token, repo });
  const result = await runVerify({ api, tag, local: listStage(stageDir) });
  console.log(result.summary);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) await Bun.write(summaryPath, `## Release asset verification — ${tag}\n\n\`\`\`\n${result.summary}\n\`\`\`\n`);
  process.exit(result.ok ? 0 : 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/release/verify-release-assets.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/release/verify-release-assets.ts scripts/release/verify-release-assets.test.ts
git commit -m "feat(release-health): asset-completeness gate"
```

---

### Task 3: Issue helper (`open-health-issue.ts`)

**Files:**

- Create: `scripts/release/open-health-issue.ts`
- Test: `scripts/release/open-health-issue.test.ts`

**Interfaces:**

- Consumes: `GitHubApi`, `IssueRef` from `gh-api.ts`.
- Produces:

  ```ts
  export function markerFor(key: string): string;                        // `<!-- release-health:${key} -->`
  export function selectExistingIssue(issues: readonly IssueRef[], key: string): IssueRef | null;
  export function computeStateHash(state: string): string;               // stable short hash
  export function readStateHash(body: string): string | null;            // parse the embedded state marker
  export function shouldComment(prevHash: string | null, nextHash: string): boolean;
  export const HEALTH_LABEL = "release-health";
  export function openOrUpdateHealthIssue(api: GitHubApi, args: { key: string; title: string; body: string; state: string }): Promise<void>;
  export function closeHealthIssue(api: GitHubApi, key: string, comment: string): Promise<void>;
  ```

- The issue body embeds two hidden markers: `<!-- release-health:<key> -->` (dedupe) and `<!-- release-health-state:<hash> -->` (last-reported state).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { computeStateHash, markerFor, readStateHash, selectExistingIssue, shouldComment } from "./open-health-issue.ts";
import type { IssueRef } from "./gh-api.ts";

describe("selectExistingIssue", () => {
  const mk = (n: number, key: string, created: string): IssueRef => ({ number: n, body: `x ${markerFor(key)} y`, createdAt: created });
  test("marker match → that issue", () => {
    expect(selectExistingIssue([mk(1, "secret-health", "2026-01-01")], "secret-health")?.number).toBe(1);
  });
  test("no match → null", () => {
    expect(selectExistingIssue([mk(1, "other", "2026-01-01")], "secret-health")).toBeNull();
  });
  test("multiple → oldest-open wins", () => {
    const chosen = selectExistingIssue([mk(2, "secret-health", "2026-02-01"), mk(1, "secret-health", "2026-01-01")], "secret-health");
    expect(chosen?.number).toBe(1);
  });
});

describe("state hashing / comment gating", () => {
  test("computeStateHash is stable + differs on change", () => {
    expect(computeStateHash("A")).toBe(computeStateHash("A"));
    expect(computeStateHash("A")).not.toBe(computeStateHash("B"));
  });
  test("readStateHash parses the embedded marker", () => {
    const h = computeStateHash("A");
    expect(readStateHash(`body <!-- release-health-state:${h} --> end`)).toBe(h);
    expect(readStateHash("no marker")).toBeNull();
  });
  test("shouldComment only on change", () => {
    const h = computeStateHash("A");
    expect(shouldComment(h, h)).toBe(false);
    expect(shouldComment(computeStateHash("A"), computeStateHash("B"))).toBe(true);
    expect(shouldComment(null, h)).toBe(true); // first time
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/open-health-issue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { createGitHubApi, type GitHubApi, type IssueRef } from "./gh-api.ts";

export const HEALTH_LABEL = "release-health";
export function markerFor(key: string): string { return `<!-- release-health:${key} -->`; }
const STATE_RE = /<!-- release-health-state:([a-f0-9]+) -->/;

export function selectExistingIssue(issues: readonly IssueRef[], key: string): IssueRef | null {
  const marker = markerFor(key);
  const matches = issues.filter((i) => i.body.includes(marker));
  if (matches.length === 0) return null;
  return matches.reduce((oldest, i) => (i.createdAt < oldest.createdAt ? i : oldest));
}

export function computeStateHash(state: string): string {
  // Bun exposes a fast non-crypto hasher; stable across runs for identical input.
  return Bun.hash(state).toString(16);
}

export function readStateHash(body: string): string | null {
  return STATE_RE.exec(body)?.[1] ?? null;
}

export function shouldComment(prevHash: string | null, nextHash: string): boolean {
  return prevHash !== nextHash;
}

function composeBody(key: string, body: string, stateHash: string): string {
  return `${markerFor(key)}\n<!-- release-health-state:${stateHash} -->\n\n${body}`;
}

export async function openOrUpdateHealthIssue(api: GitHubApi, args: { key: string; title: string; body: string; state: string }): Promise<void> {
  const stateHash = computeStateHash(args.state);
  const fullBody = composeBody(args.key, args.body, stateHash);
  const existing = selectExistingIssue(await api.listOpenIssues(HEALTH_LABEL), args.key);
  if (existing === null) {
    await api.ensureLabel(HEALTH_LABEL);
    await api.createIssue(args.title, fullBody, [HEALTH_LABEL]);
    return;
  }
  await api.updateIssue(existing.number, fullBody);
  if (shouldComment(readStateHash(existing.body), stateHash)) {
    await api.commentIssue(existing.number, `State changed:\n\n${args.body}`);
  }
}

export async function closeHealthIssue(api: GitHubApi, key: string, comment: string): Promise<void> {
  const existing = selectExistingIssue(await api.listOpenIssues(HEALTH_LABEL), key);
  if (existing !== null) await api.closeIssue(existing.number, comment);
}

if (import.meta.main) {
  const repo = process.env["GITHUB_REPOSITORY"];
  const token = process.env["GITHUB_TOKEN"];
  const key = process.env["HEALTH_KEY"];
  const title = process.env["HEALTH_TITLE"];
  const body = process.env["HEALTH_BODY"];
  if (!repo || !token || !key || !title || !body) {
    console.error("open-health-issue: GITHUB_REPOSITORY, GITHUB_TOKEN, HEALTH_KEY, HEALTH_TITLE, HEALTH_BODY required");
    process.exit(2);
  }
  await openOrUpdateHealthIssue(createGitHubApi({ token, repo }), { key, title, body, state: body });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/release/open-health-issue.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/release/open-health-issue.ts scripts/release/open-health-issue.test.ts
git commit -m "feat(release-health): de-duped, state-transition-aware issue helper"
```

---

### Task 4: Secret-health monitor (`check-secret-health.ts`)

**Files:**

- Create: `scripts/release/check-secret-health.ts`
- Test: `scripts/release/check-secret-health.test.ts`

**Interfaces:**

- Consumes: `GitHubApi`, `ProbeResult` from `gh-api.ts`; `openOrUpdateHealthIssue` / `closeHealthIssue` from `open-health-issue.ts`.
- Produces:

  ```ts
  export type PatStatus = "ok" | "dead" | "insufficient" | "indeterminate" | "not-configured";
  export type CertStatus = "ok" | "expiring" | "expired" | "indeterminate" | "not-configured";
  export function classifyPatProbe(strategy: PatStrategy, probe: { status: number; scopes: string | null; push?: boolean }): PatStatus;
  export function evaluateCertExpiry(notAfter: Date | null, now: Date, thresholdDays: number): CertStatus;
  export interface HealthRow { readonly name: string; readonly kind: "pat" | "cert"; readonly status: PatStatus | CertStatus; readonly detail: string; }
  export function summarize(rows: readonly HealthRow[]): { hasHardFailure: boolean; hasWarning: boolean; table: string; state: string };
  ```

  where `PatStrategy = { kind: "repo-write"; targetRepo: string } | { kind: "scopes"; required: string } | { kind: "alive" }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { classifyPatProbe, evaluateCertExpiry, safeParseDate, summarize } from "./check-secret-health.ts";

describe("classifyPatProbe", () => {
  test("repo-write: push true → ok, false → insufficient, 401 → dead", () => {
    const s = { kind: "repo-write", targetRepo: "o/r" } as const;
    expect(classifyPatProbe(s, { status: 200, scopes: null, push: true })).toBe("ok");
    expect(classifyPatProbe(s, { status: 200, scopes: null, push: false })).toBe("insufficient");
    expect(classifyPatProbe(s, { status: 401, scopes: null })).toBe("dead");
    expect(classifyPatProbe(s, { status: 500, scopes: null })).toBe("indeterminate");
  });
  test("scopes: required present → ok, absent → insufficient", () => {
    const s = { kind: "scopes", required: "public_repo" } as const;
    expect(classifyPatProbe(s, { status: 200, scopes: "public_repo, gist" })).toBe("ok");
    expect(classifyPatProbe(s, { status: 200, scopes: "gist" })).toBe("insufficient");
    expect(classifyPatProbe(s, { status: 401, scopes: null })).toBe("dead");
  });
  test("alive: 200 → ok, 401 → dead, other → indeterminate", () => {
    const s = { kind: "alive" } as const;
    expect(classifyPatProbe(s, { status: 200, scopes: null })).toBe("ok");
    expect(classifyPatProbe(s, { status: 401, scopes: null })).toBe("dead");
    expect(classifyPatProbe(s, { status: 403, scopes: null })).toBe("indeterminate");
  });
});

describe("evaluateCertExpiry", () => {
  const now = new Date("2026-07-18T00:00:00Z");
  test("past → expired", () => { expect(evaluateCertExpiry(new Date("2026-07-17T00:00:00Z"), now, 21)).toBe("expired"); });
  test("within threshold → expiring", () => { expect(evaluateCertExpiry(new Date("2026-08-01T00:00:00Z"), now, 21)).toBe("expiring"); });
  test("beyond threshold → ok", () => { expect(evaluateCertExpiry(new Date("2026-09-01T00:00:00Z"), now, 21)).toBe("ok"); });
  test("null (undecodable) → indeterminate", () => { expect(evaluateCertExpiry(null, now, 21)).toBe("indeterminate"); });
  test("NaN date → indeterminate (never a false ok)", () => { expect(evaluateCertExpiry(new Date("nonsense"), now, 21)).toBe("indeterminate"); });
});

describe("safeParseDate", () => {
  test("valid openssl notAfter string → Date", () => { expect(safeParseDate("Jul 18 12:00:00 2028 GMT")?.getUTCFullYear()).toBe(2028); });
  test("garbage → null", () => { expect(safeParseDate("not a date")).toBeNull(); });
});

describe("summarize", () => {
  test("dead PAT or expired cert → hard failure", () => {
    const r = summarize([{ name: "RELEASE_PAT", kind: "pat", status: "dead", detail: "" }]);
    expect(r.hasHardFailure).toBe(true);
    expect(r.table).toContain("RELEASE_PAT");
  });
  test("expiring cert → warning, not hard failure", () => {
    const r = summarize([{ name: "GPG", kind: "cert", status: "expiring", detail: "12d" }]);
    expect(r.hasHardFailure).toBe(false);
    expect(r.hasWarning).toBe(true);
  });
  test("all ok → neither", () => {
    const r = summarize([{ name: "X", kind: "pat", status: "ok", detail: "" }]);
    expect(r.hasHardFailure).toBe(false);
    expect(r.hasWarning).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/check-secret-health.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { createGitHubApi, type GitHubApi } from "./gh-api.ts";
import { closeHealthIssue, openOrUpdateHealthIssue } from "./open-health-issue.ts";

export type PatStrategy =
  | { readonly kind: "repo-write"; readonly targetRepo: string }
  | { readonly kind: "scopes"; readonly required: string }
  | { readonly kind: "alive" };
export type PatStatus = "ok" | "dead" | "insufficient" | "indeterminate" | "not-configured";
export type CertStatus = "ok" | "expiring" | "expired" | "indeterminate" | "not-configured";

export function classifyPatProbe(strategy: PatStrategy, probe: { status: number; scopes: string | null; push?: boolean }): PatStatus {
  if (probe.status === 401) return "dead";
  if (probe.status !== 200) return "indeterminate";
  if (strategy.kind === "repo-write") return probe.push === true ? "ok" : "insufficient";
  if (strategy.kind === "scopes") {
    const have = (probe.scopes ?? "").split(",").map((s) => s.trim());
    return have.includes(strategy.required) ? "ok" : "insufficient";
  }
  return "ok";
}

/** Guard against malformed/localized binary output — an unparseable date must be indeterminate, never a false "ok" (plan-review #2). */
export function safeParseDate(dateStr: string): Date | null {
  const d = new Date(dateStr.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export function evaluateCertExpiry(notAfter: Date | null, now: Date, thresholdDays: number): CertStatus {
  if (notAfter === null || Number.isNaN(notAfter.getTime())) return "indeterminate";
  const days = (notAfter.getTime() - now.getTime()) / 86_400_000;
  if (days < 0) return "expired";
  if (days <= thresholdDays) return "expiring";
  return "ok";
}

export interface HealthRow { readonly name: string; readonly kind: "pat" | "cert"; readonly status: PatStatus | CertStatus; readonly detail: string; }

export function summarize(rows: readonly HealthRow[]): { hasHardFailure: boolean; hasWarning: boolean; table: string; state: string } {
  const hard = new Set<string>(["dead", "insufficient", "expired"]);
  const warn = new Set<string>(["expiring", "indeterminate"]);
  const hasHardFailure = rows.some((r) => hard.has(r.status));
  const hasWarning = rows.some((r) => warn.has(r.status));
  const table = ["| Credential | Kind | Status | Detail |", "|---|---|---|---|", ...rows.map((r) => `| ${r.name} | ${r.kind} | ${r.status} | ${r.detail} |`)].join("\n");
  const state = rows.map((r) => `${r.name}=${r.status}`).sort().join(";");
  return { hasHardFailure, hasWarning, table, state };
}

// --- I/O orchestration (injected cert decoders so tests never spawn gpg/openssl) ---
export interface CertDecoder { (secretEnvVar: string, passwordEnvVar: string): Promise<Date | null>; }

const PAT_TABLE: readonly { env: string; strategy: PatStrategy }[] = []; // populated in main() using GITHUB_REPOSITORY

export async function runSecretHealth(deps: {
  api: GitHubApi;
  now: Date;
  thresholdDays: number;
  pats: readonly { env: string; token: string | undefined; strategy: PatStrategy }[];
  certs: readonly { name: string; secretEnv: string; passwordEnv: string; present: boolean; decode: CertDecoder }[];
}): Promise<{ hardFailure: boolean }> {
  const rows: HealthRow[] = [];
  for (const p of deps.pats) {
    if (!p.token) { rows.push({ name: p.env, kind: "pat", status: "not-configured", detail: "unset" }); continue; }
    try {
      const probe = await deps.api.probeToken(p.token);
      let push: boolean | undefined;
      if (p.strategy.kind === "repo-write" && probe.status === 200) {
        // Authenticate the repo-permission call with the PAT under test — NOT the runner's
        // github.token (which is contents:read here and would falsely report push:false). (plan-review #1)
        const perms = await deps.api.getRepoPermissions(p.strategy.targetRepo, p.token);
        push = "push" in perms ? perms.push : undefined;
      }
      rows.push({ name: p.env, kind: "pat", status: classifyPatProbe(p.strategy, { ...probe, push }), detail: p.strategy.kind });
    } catch { rows.push({ name: p.env, kind: "pat", status: "indeterminate", detail: "probe error" }); }
  }
  for (const c of deps.certs) {
    if (!c.present) { rows.push({ name: c.name, kind: "cert", status: "not-configured", detail: "unset" }); continue; }
    let notAfter: Date | null = null;
    try { notAfter = await c.decode(c.secretEnv, c.passwordEnv); } catch { notAfter = null; }
    const status = evaluateCertExpiry(notAfter, deps.now, deps.thresholdDays);
    rows.push({ name: c.name, kind: "cert", status, detail: notAfter ? `${Math.round((notAfter.getTime() - deps.now.getTime()) / 86_400_000)}d` : "undecodable" });
  }
  const s = summarize(rows);
  const caveat = "\n\n> Note: PATs are checked dead/alive + authorization only — fine-grained PAT *expiry dates* are not exposed by the API, so a dead PAT is caught within one weekly cycle, not ahead. Certs get true N-days-ahead warning.";
  if (s.hasHardFailure || s.hasWarning) {
    await openOrUpdateHealthIssue(deps.api, { key: "secret-health", title: "🔑 Release secret-health alert", body: s.table + caveat, state: s.state });
  } else {
    await closeHealthIssue(deps.api, "secret-health", "✅ All release credentials healthy — closing.");
  }
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) await Bun.write(summaryPath, `## Secret health\n\n${s.table}${caveat}\n`);
  console.log(s.table);
  return { hardFailure: s.hasHardFailure };
}
```

Note: `PAT_TABLE`, the real `probeToken` argument wiring, and the real `CertDecoder` implementations (spawning `gpg`/`openssl` with `env:`/`--passphrase-fd` per the Global Constraints — never argv) are assembled in the `import.meta.main` block, which reads `GITHUB_REPOSITORY`, the tokens, and `threshold_days`. That block is exercised only by the workflow (Task 5), not by unit tests. Add it now:

```ts
async function decodeGpgExpiry(_secretEnv: string, _pwEnv: string): Promise<Date | null> {
  // Real impl: write $GNUPGHOME to a temp dir; `gpg --batch --import` reading the key from stdin;
  // parse `gpg --with-colons --list-keys` expiry field. Never pass the key/passphrase as argv.
  // Returns null on any failure (→ indeterminate). Assembled here; see Global Constraints.
  return null;
}
async function decodePkcs12Expiry(secretEnv: string, pwEnv: string): Promise<Date | null> {
  // Real impl: base64-decode $[secretEnv] to a 0600 temp .p12 under $RUNNER_TEMP;
  // `openssl pkcs12 -in <tmp> -passin env:<pwEnv> -nokeys -clcerts | openssl x509 -enddate -noout`;
  // parse `notAfter=...`. Never pass the password/base64 as argv. null on failure.
  return null;
}

if (import.meta.main) {
  const repo = process.env["GITHUB_REPOSITORY"];
  const token = process.env["GITHUB_TOKEN"];
  if (!repo || !token) { console.error("check-secret-health: GITHUB_REPOSITORY + GITHUB_TOKEN required"); process.exit(2); }
  const rawThreshold = Number(process.env["THRESHOLD_DAYS"] ?? "21");
  const thresholdDays = Number.isFinite(rawThreshold) && rawThreshold >= 0 ? rawThreshold : 21;
  const pats = [
    { env: "RELEASE_PAT", token: process.env["RELEASE_PAT"], strategy: { kind: "repo-write", targetRepo: repo } as PatStrategy },
    { env: "RELEASE_PLEASE_PAT", token: process.env["RELEASE_PLEASE_PAT"], strategy: { kind: "repo-write", targetRepo: repo } as PatStrategy },
    { env: "PACKAGE_MANAGER_PAT", token: process.env["PACKAGE_MANAGER_PAT"], strategy: { kind: "alive" } as PatStrategy },
    { env: "WINGET_PAT", token: process.env["WINGET_PAT"], strategy: { kind: "scopes", required: "public_repo" } as PatStrategy },
    { env: "NIMBUS_CHECKS_TOKEN", token: process.env["NIMBUS_CHECKS_TOKEN"], strategy: { kind: "alive" } as PatStrategy },
    { env: "SCORECARD_TOKEN", token: process.env["SCORECARD_TOKEN"], strategy: { kind: "alive" } as PatStrategy },
  ];
  const certs = [
    { name: "GPG_SIGNING_SUBKEY", secretEnv: "GPG_SIGNING_SUBKEY", passwordEnv: "GPG_PASSPHRASE", present: Boolean(process.env["GPG_SIGNING_SUBKEY"]), decode: decodeGpgExpiry },
    { name: "WINDOWS_CERT_PFX_BASE64", secretEnv: "WINDOWS_CERT_PFX_BASE64", passwordEnv: "WINDOWS_CERT_PASSWORD", present: Boolean(process.env["WINDOWS_CERT_PFX_BASE64"]), decode: decodePkcs12Expiry },
    { name: "APPLE_CERT_P12_BASE64", secretEnv: "APPLE_CERT_P12_BASE64", passwordEnv: "APPLE_CERT_PASSWORD", present: Boolean(process.env["APPLE_CERT_P12_BASE64"]), decode: decodePkcs12Expiry },
  ];
  const { hardFailure } = await runSecretHealth({ api: createGitHubApi({ token, repo }), now: new Date(), thresholdDays, pats, certs });
  process.exit(hardFailure ? 1 : 0);
}
```

> **Note on `PACKAGE_MANAGER_PAT`:** it targets two *external* channel repos (the Homebrew tap + Scoop bucket), so `repo-write` against a single repo doesn't fit cleanly — it uses `alive`. If a per-channel-repo check is wanted later, extend the strategy to accept multiple `targetRepo`s.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/release/check-secret-health.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Implement the real cert decoders**

Replace the two `decode*` stubs with real implementations that obey the Global Constraints and plan-review #2/#3:

- **PKCS#12 (`decodePkcs12Expiry`)**: base64-decode `process.env[secretEnv]` to a `0600` temp file under `$RUNNER_TEMP` (`await Bun.write(tmp, buf)` then `chmodSync(tmp, 0o600)`); run `openssl pkcs12 -in <tmp> -passin env:<passwordEnv> -nokeys -clcerts -legacy` piped into `openssl x509 -enddate -noout` via `Bun.spawn` (password via `-passin env:` — **never argv**); extract the `notAfter=<date>` value and return `safeParseDate(value)`. Wrap the whole body in `try { … } finally { rmSync(tmp, { force: true }); }` so the temp `.p12`/`.pfx` is deleted even on throw (plan-review #3).
- **GPG (`decodeGpgExpiry`)**: create a temp `GNUPGHOME` dir (`0700`); `Bun.spawn(["gpg","--batch","--pinentry-mode","loopback","--passphrase-fd","0","--import"], { stdin: <armored key piped> })` feeding the key on stdin (passphrase via `--passphrase-fd 0` — never argv); then `gpg --with-colons --list-keys` and read the **expiration field = the 7th colon-delimited field (0-based index 6) of the `sub` record** — a Unix-epoch-seconds value. **Correction to the review:** this is field **7**, *not* "index 9" — the colon format is `type:validity:length:algo:keyid:creation:`**`expiration`**`:…`. Convert via `new Date(Number(field) * 1000)` and validate with `Number.isNaN`. Wrap in `try { … } finally { rmSync(gnupgHome, { recursive: true, force: true }); }`.
- Both return `null` on any non-zero exit, missing binary, or parse miss → surfaces as `indeterminate` (never a false `expired`/`ok`).

- [ ] **Step 6: Commit**

```bash
git add scripts/release/check-secret-health.ts scripts/release/check-secret-health.test.ts
git commit -m "feat(release-health): secret-health monitor (PAT authz probes + cert expiry)"
```

---

### Task 5: `secret-health.yml` workflow

**Files:**

- Create: `.github/workflows/secret-health.yml`

**Interfaces:**

- Consumes: `scripts/release/check-secret-health.ts` (`import.meta.main`).
- Produces: a weekly scheduled + manually-dispatchable check.

- [ ] **Step 1: Write the workflow**

```yaml
name: Secret health

on:
  schedule:
    - cron: "0 9 * * 1" # Mondays 09:00 UTC
  workflow_dispatch:
    inputs:
      threshold_days:
        description: "Cert expiry warning threshold (days)"
        required: false
        default: "21"
        type: string

permissions:
  contents: read

jobs:
  check:
    name: Check release credential health
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    environment: release
    permissions:
      contents: read
      issues: write
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4
        with:
          egress-policy: audit
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false
      - name: Setup Bun
        uses: ./.github/actions/setup-nimbus-ci
        with:
          verify-lock: "false"
      - name: Run secret-health check
        env:
          GITHUB_TOKEN: ${{ github.token }}
          THRESHOLD_DAYS: ${{ github.event.inputs.threshold_days || '21' }}
          RELEASE_PAT: ${{ secrets.RELEASE_PAT }}
          RELEASE_PLEASE_PAT: ${{ secrets.RELEASE_PLEASE_PAT }}
          PACKAGE_MANAGER_PAT: ${{ secrets.PACKAGE_MANAGER_PAT }}
          WINGET_PAT: ${{ secrets.WINGET_PAT }}
          NIMBUS_CHECKS_TOKEN: ${{ secrets.NIMBUS_CHECKS_TOKEN }}
          SCORECARD_TOKEN: ${{ secrets.SCORECARD_TOKEN }}
          GPG_SIGNING_SUBKEY: ${{ secrets.GPG_SIGNING_SUBKEY }}
          GPG_PASSPHRASE: ${{ secrets.GPG_PASSPHRASE }}
          WINDOWS_CERT_PFX_BASE64: ${{ secrets.WINDOWS_CERT_PFX_BASE64 }}
          WINDOWS_CERT_PASSWORD: ${{ secrets.WINDOWS_CERT_PASSWORD }}
          APPLE_CERT_P12_BASE64: ${{ secrets.APPLE_CERT_P12_BASE64 }}
          APPLE_CERT_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD }}
        run: bun scripts/release/check-secret-health.ts
```

- [ ] **Step 2: Verify YAML validity + SHA-pin gate**

Run: `bun -e "import{parse}from'yaml';parse(await Bun.file('.github/workflows/secret-health.yml').text());console.log('valid')"`
Run: `bun run audit:action-sha-pins`
Expected: `valid`; action-sha-pins OK.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/secret-health.yml
git commit -m "ci(release-health): weekly secret-health monitor workflow"
```

---

### Task 6: Wire the asset gate + failure alert into `release.yml`, docs, aliases

**Files:**

- Modify: `.github/workflows/release.yml` (add a step to `publish-release` after "Create GitHub Release"; add an `alert-on-failure` job)
- Modify: `docs/ci-secrets.md` (add "Release-health monitor" section)
- Modify: `package.json` (add local dry-run aliases)

**Interfaces:**

- Consumes: `verify-release-assets.ts`, `open-health-issue.ts`.

- [ ] **Step 1: Add the asset-verification step to `publish-release`**

Insert immediately AFTER the `Create GitHub Release` step (`release.yml`, after the `softprops/action-gh-release` step, before the `update-manifest` job). The job is already `contents: read` — sufficient to read release assets; no new permission needed:

```yaml
      - name: Verify release assets are complete
        env:
          GITHUB_TOKEN: ${{ github.token }}
          GITHUB_REF_NAME: ${{ github.ref_name }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          STAGE_DIR: dist/stage
        run: bun scripts/release/verify-release-assets.ts
```

- [ ] **Step 2: Add the `alert-on-failure` job to `release.yml`**

Append as a new top-level job (sibling of `publish-release` / `update-manifest`). It fires only when a needed job failed, and files the de-duped issue:

```yaml
  alert-on-failure:
    name: Alert on release failure
    needs:
      - build-gateway
      - build-cli
      - build-msi
      - build-pkg
      - publish-release
    # failure() fires when ANY needed job FAILED. A skipped needed job counts as neutral (not a
    # failure), so this never fires spuriously on skips. Do NOT use always() — that would also
    # fire on a fully successful release. (plan-review #4)
    if: ${{ failure() }}
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
      contents: read
      issues: write
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4
        with:
          egress-policy: audit
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false
      - name: Setup Bun
        uses: ./.github/actions/setup-nimbus-ci
        with:
          verify-lock: "false"
      - name: File release-health issue
        env:
          GITHUB_TOKEN: ${{ github.token }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          HEALTH_KEY: run:${{ github.ref_name }}
          HEALTH_TITLE: "🚨 Release ${{ github.ref_name }} failed"
          HEALTH_BODY: "A job in the Release workflow for `${{ github.ref_name }}` failed — the published release may be missing assets. Run: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
        run: bun scripts/release/open-health-issue.ts
```

- [ ] **Step 3: Verify YAML validity + gates**

Run: `bun -e "import{parse}from'yaml';parse(await Bun.file('.github/workflows/release.yml').text());console.log('valid')"`
Run: `bun run audit:action-sha-pins`
Expected: `valid`; action-sha-pins OK.

- [ ] **Step 4: Add the `ci-secrets.md` section**

Append under a new `## Release-health monitor` heading: what `secret-health.yml` checks (the 6 PATs + 3 certs), the weekly cadence + `workflow_dispatch` with `threshold_days`, that alerts arrive as a `release-health` GitHub issue, the PAT dead/alive caveat, and how to respond (rotate per the per-secret runbook above, then close the issue / re-run the monitor). Also note the asset gate + `alert-on-failure` in `release.yml`.

- [ ] **Step 5: Add local dry-run aliases to `package.json`**

```jsonc
// in "scripts":
"release:verify-assets": "bun scripts/release/verify-release-assets.ts",
"release:secret-health": "bun scripts/release/check-secret-health.ts"
```

- [ ] **Step 6: Run the doc + full script test gate**

Run: `bun run audit:doc-refs`
Run: `bun test scripts/release/`
Expected: doc-refs OK; all script tests pass.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/release.yml docs/ci-secrets.md package.json
git commit -m "ci(release-health): wire asset gate + failure alert; document monitor"
```

---

## Self-Review

**Spec coverage:** C1 asset gate → Task 2 + Task 6 step 1. C2 failure alert → Task 6 step 2. C3 monitor (PAT strategies, cert decode, no-argv feeding, missing-tool→indeterminate, caveat) → Task 4 + Task 5. C4 issue helper (dedupe + state-transition) → Task 3. Testing section → tests in Tasks 1–4. Docs → Task 6 step 4. Design-review dispositions #1/#2/#3a/#4/#5b implemented; #3b/#5a deferred per spec (not built — correct).

**Placeholder scan:** the two `decode*` functions ship as documented stubs returning `null` in Task 4 step 3 and are replaced with the real, constraint-compliant implementations in Task 4 step 5 (a distinct step, not a placeholder). No `TBD`/`TODO`. `ci-secrets.md` prose (Task 6 step 4) is described, not code.

**Type consistency:** `GitHubApi` methods (`getReleaseByTag`, `probeToken`, `getRepoPermissions`, `listOpenIssues`, `createIssue`, `updateIssue`, `commentIssue`, `closeIssue`, `ensureLabel`) are defined in Task 1 and consumed unchanged in Tasks 2–4. `PatStrategy` / `PatStatus` / `CertStatus` / `HealthRow` defined and used consistently in Task 4. `openOrUpdateHealthIssue(api, {key,title,body,state})` signature matches its Task 3 definition and Task 4/6 call sites.

## Deviation from spec (noted)

Spec C1 said the asset-check step opens the `assets:<tag>` issue itself. The plan instead has it **fail with a detailed `$GITHUB_STEP_SUMMARY`** and lets the `issues: write`-scoped `alert-on-failure` job (C2) file the issue — so the sensitive `publish-release` job stays `contents: read` (least privilege). The specific missing-asset detail is preserved in the step summary visible on the failed run.

## Plan-review dispositions (2026-07-18)

Review: [2026-07-18-release-health-verification-review.md](./2026-07-18-release-health-verification-review.md).

| # | Point | Disposition | Where |
| --- | --- | --- | --- |
| 1 | `getRepoPermissions` used the runner token, not the PAT under test | **Fixed** — real bug (would report every `repo-write` PAT "insufficient" since the monitor's `github.token` is `contents:read`). Added a `token?` override; the orchestration passes `p.token`. | Task 1 iface+impl, Task 4 orchestration |
| 2 | Invalid-Date + GPG colon field | **Fixed, with correction** — added `safeParseDate` (NaN→null) + a NaN guard in `evaluateCertExpiry` (a malformed cert output would otherwise read false-`ok`). The review's GPG "field index 9" is wrong: the expiration is **field 7** of the `sub` record; the decoder uses field 7. | Task 4 pure cores + Step 5 |
| 3 | Temp-file cleanup on failure | **Fixed (made explicit)** — the constraints already required cleanup; Step 5 now spells out `try { … } finally { rmSync(...) }` for both decoders. | Task 4 Step 5 |
| 4 | Skipped needed jobs vs `if: failure()` | **Fixed (clarified)** — the review confirmed `failure()` is correct; added a comment documenting that skipped needs are neutral and that `always()` is deliberately NOT used. | Task 6 Step 2 |

Invariant-alignment section of the review confirmed the least-privilege deviation (publish-release stays `contents:read`) and the no-argv credential feeding. No action.
