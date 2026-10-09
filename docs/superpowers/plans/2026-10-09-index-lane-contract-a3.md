# Index Lane Contract A3 — the census becomes a gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `bun run audit:lane-census` from an always-exit-0 report into an enforced `--check`
gate, after teaching it the writer shapes it is blind to, and fix every user-facing gap the
pre-gate classification found (user ruling 2026-10-09: "Fix all in A3").

**Architecture:** The census (`scripts/structure-audit/check-index-lane-coverage.ts` +
`lane-census/*.ts`) gains: read-side noise fixes (assignment targets, test helpers, non-item
`meta`), writer-side resolution (spreads, call-initialised identifiers, same-file mutators,
literal-array loops, `clips/`), the A1 contract tables as writer emissions, a verified
`// lane-census: scope=…` annotation, and an exemptions file. A pure `evaluateLaneGate` turns a
census plus exemptions into violations; `--check` exits 1 on any. Five reader/writer fixes land
before the read sites are annotated, so exemptions describe the fixed code.

**Tech Stack:** Bun + TypeScript strict, `bun:test`, Biome, SQLite (`bun:sqlite`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-08-index-lane-contract-design.md` §5 (A3), amended by the
rulings below. The spec travels on this branch only and is stripped before the PR.

## Global Constraints

- Never commit on `main`; branch is `dev/asaf/index-lane-contract-a3`. Verify with
  `git rev-parse --abbrev-ref HEAD` before every commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use
  `git commit -F <file>` (backticks in `-m` are eaten by the shell).
- Never stage `docs/superpowers/**/*-review.md` (untracked user review files).
- No `any` (use `unknown`); TypeScript strict; Biome clean.
- `docs/structure-audit/index-lane-census.json` is a committed artifact that every census run
  rewrites. Only Task 13 commits it; every other task runs
  `git checkout -- docs/structure-audit/index-lane-census.json` before committing.
- Regexes in `lane-census/` are built fresh per call, never module-level `g`-flagged (a shared
  `g` RegExp across nested scans hangs `bun test` — this directory's documented hazard).
- Each `lane-census/` file carries its own low-level scanning helpers (directory convention); do not
  introduce a shared helper module.
- CI test paths: `bun test packages/gateway packages/cli scripts` — run them, not a narrower set,
  before declaring a task done that touches gateway code.
- A fix that changes what a user sees must update `docs/cli-reference.md` in the same task.
- Build every `ci_run` / `pr` fixture through the exported mappers (`githubActionsRunMetadata`,
  `circleciPipelineMetadata`, `gitlabPipelineMetadata`, `jenkinsBuildMetadata`,
  `extractPrMetadataForIndex`, `bitbucketPrMetadata`, `gitlabMrMetadata`), never hand-written
  metadata, except a deliberate legacy shape that says so in a comment.

## Rulings (amending spec §5)

- **R1 — fix all gaps (user, 2026-10-09).** Every PARTIAL/DEAD read with no user-facing disclosure is
  fixed or disclosed in this PR (Tasks 6–10). An exemption reason may never be "undisclosed".
- **R2 — `index/item-store.ts` is NOT added to `WRITER_INCLUDE`** (spec §5.1 said add it). Its
  metadata writes (`mime_type`, `size_bytes`, `parent_id`, `created_at`) are reached only through
  `LocalIndex.upsert`, which has no production caller; crediting them would manufacture coverage.
  Its `bodyFetch` read stays a read. `packages/gateway/src/clips/` IS added (the real `web_clip`
  writer, `clips/clip-ingest.ts`).
- **R3 — annotation span.** A `// lane-census: scope=…` comment cannot sit "on the line above the
  read" when the read is inside a multi-line SQL template (spec §5.3 wording) — a `//` there is SQL
  text. The annotation instead covers the whole STATEMENT that begins on the next non-blank,
  non-comment line: through its first top-level `;`, or, for a `function` declaration, through its
  closing `}`.
- **R4 — annotation may narrow services:** `service=<id>[,<id>]` restricts the writer set the read
  is matched against; a listed service that writes none of the scoped types is an annotation
  error. An annotation also overrides a SQL-derived type scope.
- **R5 — non-item `meta` (spec §5.1 last bullet) is decided by the variable's declaration,
  fail-safe.** A JS read `X["k"]` (X = `meta`/`metadata`) is NOT an item read only when the nearest
  preceding `const|let|var X … = <init>` has an initializer that neither dereferences `.metadata` /
  `.rawMeta` nor calls a `…Metadata(`/`metadata(` function. A dotted receiver (`row.metadata["k"]`)
  is always an item read. No declaration found (a function parameter, an uninitialised `let`) =
  item read (it must then be annotated or exempted). A silent drop of a real read is the failure
  mode to avoid; an extra annotation is cheap.
- **R6 — exemptions match on `(file, key)`**, `file` the repo-relative path, no line number (lines
  churn). Categories: `disclosed` | `legacy` | `not-item` | `by-design`. An exemption that
  suppresses no current violation is itself a violation (stale).
- **R7 — PR `number` becomes a canonical PR contract key** (fix for `why`/`pr-subject` "#?"), and
  `PR_META_VERSION` goes 1 → 2 so `nimbus index rebody` converges stored rows. GitLab derives it from
  `iid` (always present on an event), Bitbucket from `id`, so every rebody target converges.
- **R8 — standup's chat lane is Slack-scoped.** The heading, docs and thread key are all Slack;
  the query now says so too (`service = 'slack'`) instead of mixing Discord rows into a "Slack"
  count.
- **R9 — red-proof (spec §5.5)** is a recorded manual step in Task 12, not a committed test: on the
  working tree, change preflight's `'$.workflow_name'` read back to the pre-A1 key
  `'$.workflowName'`, confirm `--check` exits 1 naming it, restore.

## Review Focus

1. A JS read whose `meta` is a function parameter must stay counted as an item read — the R5
   heuristic must never silently drop it as non-item. (Test: Task 1, "parameter meta stays an item
   read".)
2. An annotation above a statement containing a multi-line SQL template must cover reads on lines
   INSIDE the template and must not bleed into the next statement. (Test: Task 4, "covers the whole
   template, stops at the statement's `;`".)
3. An exemption whose read was fixed by Tasks 6–10 must go red as stale, not linger. (Test: Task 5,
   "stale exemption".)
4. The PR version bump must leave GitLab rows convergible: a GitLab MR row rebuilt from any event
   carries `number` and `meta_v: 2`, so rebody stops counting it pending. (Test: Task 6.)
5. DORA lead-time gap precedence: a GitHub-only service with the default `excludePrLabels` must
   gain NO new gap (GitHub always writes a `labels` array); a merged Bitbucket PR alone must report
   `incomplete_merge_data`, never `no_deployment_data`. (Test: Task 7.)

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/structure-audit/lane-census/read-sites.ts` | read extraction: assignment targets, non-item origin | 1 |
| `scripts/structure-audit/lane-census/writer-emissions.ts` | writer extraction: spreads, call-init identifiers, mutators, for-of literals, `clips/` | 2 |
| `scripts/structure-audit/lane-census/contract-emissions.ts` (new) | A1 contract tables → `WriterEmission[]` | 3 |
| `scripts/structure-audit/lane-census/annotations.ts` (new) | parse + span `// lane-census:` annotations | 4 |
| `scripts/structure-audit/lane-census/exemptions.ts` (new) | the exemption DATA (populated in Tasks 11–12) | 5 |
| `scripts/structure-audit/lane-census/gate.ts` (new) | `evaluateLaneGate(census, exemptions)` | 5 |
| `scripts/structure-audit/check-index-lane-coverage.ts` | assembly; `--check` CLI | 1,3,4,5 |
| `packages/gateway/src/connectors/{pr-meta,github-sync,bitbucket-sync}.ts`, `_lib/gitlab/events.ts` | canonical `number` | 6 |
| `packages/gateway/src/metrics/dora.ts`, `openapi/v1.yaml` | lead-time disclosures | 7 |
| `packages/gateway/src/metrics/service-identity.ts` | dead arms | 8 |
| `packages/gateway/src/agents/premortem.ts`, `premortem/risks.ts` | partial-timing disclosure | 9 |
| `packages/gateway/src/agents/standup-queries.ts` | Slack scope | 10 |
| many reader files (annotations only) | scope annotations | 11, 12 |
| `scripts/lib/preflight-gates.ts`, `.github/workflows/_structure.yml` | wire the gate | 12 |
| docs | CHANGELOG, roadmap B4, cli-reference, nimbus-commands skill | 13 |

---

### Task 1: Read-side noise fixes

**Files:**
- Modify: `scripts/structure-audit/lane-census/read-sites.ts`
- Modify: `scripts/structure-audit/check-index-lane-coverage.ts` (test-helper exclusion, `nonItemReads`)
- Test: `scripts/structure-audit/lane-census/read-sites.test.ts`, `scripts/structure-audit/check-index-lane-coverage.test.ts`

**Interfaces:**
- Produces: `export type NonItemRead = { readonly file: string; readonly line: number; readonly value: string }`;
  `export function extractNonItemJsReads(file: string, contents: string): readonly NonItemRead[]`;
  `extractReadTriples` no longer returns assignment targets or non-item JS reads;
  `LaneCensus` gains `readonly nonItemReads: readonly NonItemRead[]`;
  `export function isProductionReadFile(relPath: string): boolean` in `check-index-lane-coverage.ts`.

- [ ] **Step 1: Write the failing tests** (append to `read-sites.test.ts`)

```ts
describe("JS metadata reads — A3 noise fixes", () => {
  const keys = (src: string) => extractReadTriples("x.ts", src).map((t) => t.value);

  test("an assignment target is a write, not a read", () => {
    const src = [
      "const meta: Record<string, unknown> = {};",
      'meta["status_category"] = "done";',
      "meta.other = 1;",
      'if (meta["kept"] === 1) {}',
    ].join("\n");
    expect(keys(src)).toEqual(["kept"]);
  });

  test("== / === / => after the bracket are reads, not assignments", () => {
    const src = 'function f(meta: R) { return meta["a"] == 1 || meta["b"] === 2; }';
    expect(keys(src).sort()).toEqual(["a", "b"]);
  });

  test("meta built from a vendor object is not an item read", () => {
    const src = [
      'const meta = asRecord(row["metadata"]) ?? {};',
      'const created = meta["creationTimestamp"];',
    ].join("\n");
    expect(keys(src)).toEqual([]);
    expect(extractNonItemJsReads("x.ts", src).map((r) => r.value)).toEqual(["creationTimestamp"]);
  });

  test("meta parsed from an item row's metadata column stays an item read", () => {
    for (const init of [
      "JSON.parse(row.metadata) as Record<string, unknown>",
      "parseMetadata(row[\"metadata\"])",
      "parsePrMetadata(row.metadata)",
      "(item.rawMeta ?? {}) as Record<string, unknown>",
      "readStoredMetadata(ctx, id)",
    ]) {
      expect(keys(`const meta = ${init};\nconst v = meta["k"];`)).toEqual(["k"]);
    }
  });

  test("parameter meta stays an item read (fail-safe, Review Focus 1)", () => {
    expect(keys('function f(meta: Record<string, unknown>) { return meta["k"]; }')).toEqual(["k"]);
  });

  test("an uninitialised let stays an item read", () => {
    expect(keys('let meta: R;\nmeta = load();\nconst v = meta["k"];')).toEqual(["k"]);
  });

  test("a dotted receiver is always an item read", () => {
    const src = 'const meta = asRecord(x["meta"]);\nconst m = row.metadata["merged"];';
    expect(keys(src)).toEqual(["merged"]);
  });
});
```

And in `check-index-lane-coverage.test.ts`:

```ts
test("reads in a test-helpers file are not production reads", () => {
  const census = collectLaneCensus([
    {
      relPath: "packages/gateway/src/premortem/cohort.test-helpers.ts",
      contents: 'function f(metadata: R) { metadata["created_at_ms"] === 1; }',
    },
  ]);
  expect(census.reads).toHaveLength(0);
  expect(isProductionReadFile("packages/gateway/src/x/test-helpers/a.ts")).toBe(false);
  expect(isProductionReadFile("packages/gateway/src/agents/expert.ts")).toBe(true);
});

test("non-item JS reads are reported separately, never gated", () => {
  const census = collectLaneCensus([
    {
      relPath: "packages/gateway/src/connectors/slack-sync.ts",
      contents: 'const meta = asRecord(res.json["response_metadata"]);\nmeta["next_cursor"];',
    },
  ]);
  expect(census.reads).toHaveLength(0);
  expect(census.nonItemReads.map((r) => r.value)).toEqual(["next_cursor"]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test scripts/structure-audit/lane-census/read-sites.test.ts scripts/structure-audit/check-index-lane-coverage.test.ts`
Expected: FAIL (`extractNonItemJsReads` / `isProductionReadFile` not exported; assignment keys present).

- [ ] **Step 3: Implement in `read-sites.ts`**

Replace `scanJsMetadataReads`'s body so each match is classified before it is pushed. Add:

```ts
/** `X["k"]` followed by a plain `=` (not `==`, `===`, `=>`) is an assignment TARGET — a write. */
function isAssignmentTarget(text: string, endIndex: number): boolean {
  return /^\s*=(?![=>])/.test(text.slice(endIndex, endIndex + 4));
}

export type MetaOrigin = "item" | "not-item";

/** Initializer text that marks an `item` row's metadata: a `.metadata`/`.rawMeta` dereference or a `…Metadata(` parser call. */
function itemOriginRegex(): RegExp {
  return /\.(?:metadata|rawMeta)\b|(?:^|[^A-Za-z0-9_$])metadata\s*\(|[A-Za-z0-9_$]Metadata\s*\(/;
}

/**
 * R5: decides whether the `meta`/`metadata` identifier read at `index` holds an `item` row's
 * metadata. Dotted receivers (`row.metadata[...]`) always do. Otherwise the NEAREST preceding
 * `const|let|var <name> … = <init>` decides: an initializer showing item origin → item; any other
 * initializer → not-item; no declaration or no initializer (a parameter, `let x;`) → item, so a
 * real read is never dropped silently.
 */
function metaOrigin(src: string, index: number, name: string, dotted: boolean): MetaOrigin {
  if (dotted) return "item";
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b\\s*(?::[^=;]*)?(=)?`, "g");
  let last: RegExpExecArray | null = null;
  let m = declRe.exec(src);
  while (m !== null && m.index < index) {
    last = m;
    m = declRe.exec(src);
  }
  if (last === null || last[1] === undefined) return "item";
  const initStart = last.index + last[0].length;
  const semi = src.indexOf(";", initStart);
  const init = src.slice(initStart, semi === -1 ? Math.min(src.length, initStart + 300) : semi);
  return itemOriginRegex().test(init) ? "item" : "not-item";
}
```

Change `jsMetadataReadRegex` to capture the receiver and whether it is dotted:

```ts
function jsMetadataReadRegex(): RegExp {
  return /(\.)?\b(meta(?:data)?)(?:\?\.)?\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/g;
}
```

In `scanJsMetadataReads`, for each match `m` (value = `m[3]`, receiver = `m[2]`, dotted =
`m[1] === "."`): skip when `isAssignmentTarget(text, m.index + m[0].length)`; compute
`metaOrigin(fullStripped, baseIndex + m.index, receiver, dotted)`; push to `out` when `"item"`,
else push `{ file, line, value }` to a `nonItem` array. Export
`extractNonItemJsReads(file, contents)` which runs the same scan over `stripComments(contents)` and
returns only the `nonItem` list (one private scanner feeding both exports; do not duplicate the
regex loop).

- [ ] **Step 4: Implement in `check-index-lane-coverage.ts`**

```ts
/** Spec §5.1: test helpers are not production reads, even though `iterateSourceFiles` yields them. */
export function isProductionReadFile(relPath: string): boolean {
  return !/(?:^|[/.])test-helpers?(?:[/.]|$)/.test(relPath);
}
```

In `collectLaneCensus`, skip `extractReadTriples` (and `findParameterizedTypeReads`) for files where
`!isProductionReadFile(f.relPath)`; collect `extractNonItemJsReads` for production files into
`nonItemReads`; add `nonItemReads` to the returned object, the artifact (`nonItemReads` +
`counts.nonItemReads`) and the console summary.

- [ ] **Step 5: Run the tests, then the real tree**

Run: `bun test scripts/structure-audit/lane-census scripts/structure-audit/check-index-lane-coverage.test.ts`
Expected: PASS.
Run: `bun scripts/structure-audit/check-index-lane-coverage.ts` and inspect
`nonItemReads` in the artifact: it MUST contain exactly the argocd/flux `creationTimestamp`, slack
`next_cursor` ×2, zendesk `has_more`, scim `lastModified` ×2 reads (the Great Expectations reads take
a parameter and stay item reads by R5 — Task 12 exempts them). If any other site appears there,
open it: if it is really an item read, tighten `itemOriginRegex`; never accept an item read in
`nonItemReads`. Then `git checkout -- docs/structure-audit/index-lane-census.json`.

- [ ] **Step 6: Commit**

```bash
git add scripts/structure-audit/lane-census/read-sites.ts scripts/structure-audit/lane-census/read-sites.test.ts scripts/structure-audit/check-index-lane-coverage.ts scripts/structure-audit/check-index-lane-coverage.test.ts
git commit -F <msg>   # "feat(census): assignment targets, test helpers and non-item meta are not item reads"
```

---

### Task 2: Writer-side resolution

**Files:**
- Modify: `scripts/structure-audit/lane-census/writer-emissions.ts`
- Test: `scripts/structure-audit/lane-census/writer-emissions.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `WRITER_INCLUDE` gains `"packages/gateway/src/clips/"`; `extractWriterEmissions`
  resolves four more shapes (below). Signature unchanged.

- [ ] **Step 1: Write the failing tests** (append to `writer-emissions.test.ts`)

```ts
describe("A3 writer shapes", () => {
  const keysOf = (src: string) =>
    extractWriterEmissions("packages/gateway/src/connectors/x.ts", src).flatMap((e) => e.metadataKeys);

  test("a spread of a same-file builder contributes the builder's keys", () => {
    const src = `
      function depth(f: R): Record<string, unknown> {
        const meta: Record<string, unknown> = { meta_v: 1 };
        meta["status_category"] = "x";
        return meta;
      }
      ctx.upsertItem({ service: "jira", type: "issue", metadata: { key, ...depth(fields) } });`;
    expect(keysOf(src).sort()).toEqual(["key", "meta_v", "status_category"]);
  });

  test("metadata: ident whose const is initialised by a same-file call resolves through the callee", () => {
    const src = `
      function build(): Record<string, unknown> { return { number: 1, labels: [] }; }
      const meta = build();
      ctx.upsertItem({ service: "github", type: "pr", metadata: meta });`;
    expect(keysOf(src).sort()).toEqual(["labels", "number"]);
  });

  test("a same-file mutator called on the metadata var credits its literal keys and key-argument keys", () => {
    const src = `
      function putIfNonEmpty(meta: R, key: string, v: string | undefined): void { if (v) meta[key] = v; }
      function applySha(out: R, pr: R): void { out["merge_commit_sha"] = "s"; }
      function build(): Record<string, unknown> {
        const meta: Record<string, unknown> = {};
        putIfNonEmpty(meta, "issue_type", t);
        applySha(meta, pr);
        return meta;
      }
      ctx.upsertItem({ service: "jira", type: "issue", metadata: build() });`;
    expect(keysOf(src).sort()).toEqual(["issue_type", "merge_commit_sha"]);
  });

  test("a for-of over a literal array assigning X[k] credits every element", () => {
    const src = `
      function build(): Record<string, unknown> {
        const out: Record<string, unknown> = { number: 1 };
        for (const key of ["additions", "deletions"] as const) { out[key] = 1; }
        return out;
      }
      ctx.upsertItem({ service: "github", type: "pr", metadata: build() });`;
    expect(keysOf(src).sort()).toEqual(["additions", "deletions", "number"]);
  });

  test("return wrapper(X, …) passes X's keys through (the raw map a contract builder keeps)", () => {
    const src = `
      function build(): Record<string, unknown> {
        const out: Record<string, unknown> = { number: 1 };
        return buildPrMetadata(out, { state: "open" });
      }
      ctx.upsertItem({ service: "github", type: "pr", metadata: build() });`;
    expect(keysOf(src)).toEqual(["number"]);
  });

  test("clips/ is a writer directory", () => {
    expect(WRITER_INCLUDE).toContain("packages/gateway/src/clips/");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test scripts/structure-audit/lane-census/writer-emissions.test.ts`
Expected: FAIL on all six.

- [ ] **Step 3: Implement**

1. `WRITER_INCLUDE`: add `"packages/gateway/src/clips/"` with a one-line comment
   (`clip-ingest.ts` writes `nimbus:web_clip` through `upsertIndexedItem`). Do NOT add
   `index/item-store.ts` (Ruling R2 — say so in the comment).
2. Spreads: in `tryObjectLiteralTopLevelKeys`'s caller path, collect top-level `...callee(args)`
   parts of a metadata object literal (`splitTopLevelCommas` already yields them; `parseTopLevelProps`
   skips them). Add
   `function spreadCallees(body: string): readonly string[]` returning callee names of parts matching
   `/^\.\.\.\s*([A-Za-z_$][\w$]*)\s*\(/`, and in `resolveMetadataKeys`' direct-literal branch merge
   `resolveMetadataKeysFromCall(name, src)` for each (one hop; no recursion beyond what
   `resolveMetadataKeysFromCall` already does).
3. Call-initialised identifier: in `resolveTopLevelIdentifierMetadataKeys` and
   `resolveInBodyIdentifierMetadataKeys`, when `tryObjectLiteralTopLevelKeys(decl.exprText)` is
   `undefined` and `matchCallExpression(decl.exprText)` names a callee, use
   `resolveMetadataKeysFromCall(callee, src)` as the literal keys, then extend with assignments in
   the enclosing scope exactly as today.
4. Mutators + for-of: replace `findExtraAssignedKeys(varName, scopeText)` calls with
   `findAssignedKeys(varName, scopeText, src)`, which returns the union of:
   - today's direct `X["k"] =` / `X.k =` keys;
   - for each call `/\b([A-Za-z_$][\w$]*)\s*\(\s*X\s*(?:,\s*(['"])([A-Za-z0-9_]+)\2)?/g` in
     `scopeText` whose callee has a same-file `function` declaration (find with the existing
     `findFunctionBodyOrExpr` plus a param-list read): with first param `P0` and second `P1`,
     credit (a) every literal key the callee body assigns on `P0` (`P0["k"] =`, `P0.k =`), and (b)
     the call's string-literal second argument when the body assigns `P0[P1] =`;
   - for each `for (const K of [ <string literals> ] …) { … }` in `scopeText` whose block assigns
     `X[K] =`, every string literal in the array.
   Every new regex built per call; `=(?!=)` guards stay.
5. Pass-through return: in `resolveMetadataKeysFromCall`, when the first `return` expression is a
   call whose first argument is a bare identifier (`/^[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/`),
   resolve that identifier with `resolveInBodyIdentifierMetadataKeys(ident, body, src)`.

Keep each helper's doc comment in this file's style (what it resolves, what it deliberately does
not chase, why).

- [ ] **Step 4: Run tests, then verify against the real tree**

Run: `bun test scripts/structure-audit/lane-census`
Expected: PASS (all, including pre-existing writer tests).
Run: `bun scripts/structure-audit/check-index-lane-coverage.ts`, then from the artifact's `writes`
confirm by `service:itemType`:
- `jira:issue` includes `issue_type`, `status_category`, `created_at_ms`, `resolved_at_ms`, `parent_key`;
- `linear:issue` includes `status_category`, `created_at_ms`, `resolved_at_ms`, `due_at_ms`, `parent_key`, `project_id`;
- `github:pr` includes `number`, `labels`, `mergeable_state`, `additions`, `deletions`, `changed_files`, `merge_commit_sha`;
- `nimbus:web_clip` exists with `tags`, `mode`, `wordCount`.
A missing key means a resolution rule did not fire on real code: fix the rule (add a unit test
mirroring the real shape), never hand-list the key. Then
`git checkout -- docs/structure-audit/index-lane-census.json`.

- [ ] **Step 5: Commit** — `feat(census): resolve spreads, call-built metadata, mutators and clips/ writers`

---

### Task 3: Contract tables as writer emissions; acceptance flips

**Files:**
- Create: `scripts/structure-audit/lane-census/contract-emissions.ts`
- Test: `scripts/structure-audit/lane-census/contract-emissions.test.ts`
- Modify: `scripts/structure-audit/check-index-lane-coverage.ts`, `scripts/structure-audit/check-index-lane-coverage.acceptance.test.ts`

**Interfaces:**
- Produces: `export function contractEmissions(): readonly WriterEmission[]`;
  `export type CensusOptions = { readonly contractEmissions?: readonly WriterEmission[] }`;
  `collectLaneCensus(files, opts: CensusOptions = {})` adds
  `opts.contractEmissions ?? []` to `writes` before building the writer index.

- [ ] **Step 1: Failing test** (`contract-emissions.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { CI_RUN_EMITTED_KEYS } from "../../../packages/gateway/src/connectors/ci-run-meta.ts";
import { PR_EMITTED_KEYS } from "../../../packages/gateway/src/connectors/pr-meta.ts";
import { collectLaneCensus } from "../check-index-lane-coverage.ts";
import { contractEmissions } from "./contract-emissions.ts";

describe("contractEmissions", () => {
  test("one row per (service, type), keys exactly the table's", () => {
    const rows = contractEmissions();
    for (const [service, keys] of Object.entries(CI_RUN_EMITTED_KEYS)) {
      const row = rows.find((r) => r.service === service && r.itemType === "ci_run");
      expect(row?.metadataKeys).toEqual([...keys].sort());
    }
    for (const [service, keys] of Object.entries(PR_EMITTED_KEYS)) {
      const row = rows.find((r) => r.service === service && r.itemType === "pr");
      expect(row?.metadataKeys).toEqual([...keys].sort());
    }
  });

  test("a contract key one provider omits is a precise partial naming the emitters", () => {
    const census = collectLaneCensus(
      [{ relPath: "packages/gateway/src/p.ts", contents: "db.query(`SELECT 1 FROM item WHERE type = 'ci_run' AND json_extract(metadata, '$.branch') = ?`);" }],
      { contractEmissions: contractEmissions() },
    );
    const hit = census.unmatchedItemReads.find((r) => r.value === "branch");
    expect(hit?.matchState).toBe("partial");
    expect(hit?.partialCoverage).toEqual(["circleci", "github_actions", "gitlab"]);
  });
});
```

- [ ] **Step 2: Run — FAIL** (`bun test scripts/structure-audit/lane-census/contract-emissions.test.ts`).

- [ ] **Step 3: Implement `contract-emissions.ts`**

```ts
import { CI_RUN_EMITTED_KEYS } from "../../../packages/gateway/src/connectors/ci-run-meta.ts";
import { PR_EMITTED_KEYS } from "../../../packages/gateway/src/connectors/pr-meta.ts";
import type { WriterEmission } from "./writer-emissions.ts";

/**
 * Spec §5.2: the A1 emitted-keys tables are DATA the census trusts as writer emissions for their
 * `(service, type)` — `lane-contract-drift.test.ts` drives every real mapper and fails when a table
 * and the code disagree, which is what makes trusting them sound. Without this the census cannot
 * see a key written through `buildCiRunMetadata`/`buildPrMetadata` and reports every contract read
 * as dead. `line: 0` marks a table row, not a call site.
 */
const SOURCES = [
  { file: "packages/gateway/src/connectors/ci-run-meta.ts", itemType: "ci_run", table: CI_RUN_EMITTED_KEYS },
  { file: "packages/gateway/src/connectors/pr-meta.ts", itemType: "pr", table: PR_EMITTED_KEYS },
] as const;

export function contractEmissions(): readonly WriterEmission[] {
  const out: WriterEmission[] = [];
  for (const src of SOURCES) {
    for (const [service, keys] of Object.entries(src.table) as [string, ReadonlySet<string>][]) {
      out.push({ service, itemType: src.itemType, metadataKeys: [...keys].sort(), file: src.file, line: 0 });
    }
  }
  return out;
}
```

Wire `collectLaneCensus(files, opts)` and pass `{ contractEmissions: contractEmissions() }` in
`run()`. Run `bun run audit:boundaries` — scripts importing gateway source has precedent
(`scripts/perf/drift-check.ts`); if dependency-cruiser objects, stop and report (do not add an
exclusion without a ruling).

- [ ] **Step 4: Flip the acceptance tests** (`check-index-lane-coverage.acceptance.test.ts`)

Build the census with `collectLaneCensus(files, { contractEmissions: contractEmissions() })`. Then:
- Replace the two "still flagged until … (A3)" tests with:
  - `workflow_name`: `matchState === "partial"`, `partialCoverage` equals `["github_actions", "jenkins"]`.
  - `branch`: `matchState === "partial"`, `partialCoverage` equals `["circleci", "github_actions", "gitlab"]`.
  Keep locating lines by SQL text. Update the header comment: A3 taught the census the contract;
  both reads are honest partials disclosed by `ci_not_evaluable` / by design (Task 12 exempts them).
- Premortem `opened_at_ms`: every `pr` writer now emits it through the contract, so assert those
  read lines are NOT in `unmatchedItemReads`. Keep the per-literal type-scoping guard as a fixture
  test in `check-index-lane-coverage.test.ts`: a `pr`-scoped read of a key only an `incident` writer
  emits is `unmatched`.
- Magnitude test: keep `reads > 50` and `writes > 20`; replace `unmatchedItemReads > 50` with
  `writes.some((w) => w.line === 0)` (contract rows present — a broken import would drop them).

- [ ] **Step 5: Run** `bun test scripts/structure-audit` — PASS. Restore the artifact.

- [ ] **Step 6: Commit** — `feat(census): treat the A1 contract tables as writer emissions (spec §5.2)`

---

### Task 4: Scope annotations

**Files:**
- Create: `scripts/structure-audit/lane-census/annotations.ts`, `annotations.test.ts`
- Modify: `scripts/structure-audit/check-index-lane-coverage.ts`

**Interfaces:**
- Produces:

```ts
export type LaneAnnotation = {
  readonly file: string;
  readonly line: number; // the comment's own line
  readonly types: readonly string[];
  readonly services: readonly string[] | null;
  readonly startLine: number; // first covered line
  readonly endLine: number; // last covered line, inclusive
};
export type AnnotationError = { readonly file: string; readonly line: number; readonly message: string };
export function extractAnnotations(file: string, contents: string): {
  readonly annotations: readonly LaneAnnotation[];
  readonly errors: readonly AnnotationError[];
};
```

  `LaneCensus` gains `readonly unscopedReads: readonly ReadTriple[]` (item metadata-key reads with
  no SQL type scope and no annotation) and `readonly annotationErrors: readonly AnnotationError[]`.

- [ ] **Step 1: Failing tests** (`annotations.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { collectLaneCensus } from "../check-index-lane-coverage.ts";
import { extractAnnotations } from "./annotations.ts";

const one = (contents: string) => extractAnnotations("f.ts", contents);

describe("extractAnnotations", () => {
  test("covers the whole template, stops at the statement's ; (Review Focus 2)", () => {
    const src = [
      "// lane-census: scope=incident service=pagerduty", // 1
      "const rows = db", // 2
      "  .query(`", // 3
      "    SELECT json_extract(metadata, '$.status') FROM item", // 4
      "    WHERE service = ?`)", // 5
      "  .all(x);", // 6
      "const after = 1;", // 7
    ].join("\n");
    const { annotations, errors } = one(src);
    expect(errors).toEqual([]);
    expect(annotations[0]).toMatchObject({ types: ["incident"], services: ["pagerduty"], startLine: 2, endLine: 6 });
  });

  test("a function declaration is covered through its closing brace", () => {
    const src = ["// lane-census: scope=ci_run,pr", "function f(m: R) {", '  return m["repo"];', "}", "const x = 1;"].join("\n");
    expect(one(src).annotations[0]).toMatchObject({ types: ["ci_run", "pr"], services: null, startLine: 2, endLine: 4 });
  });

  test("a malformed annotation is an error", () => {
    expect(one("// lane-census: scope pr\nconst x = 1;").errors[0]?.message).toContain("malformed");
  });

  test("two annotations on one statement is an error", () => {
    expect(one("// lane-census: scope=pr\n// lane-census: scope=issue\nconst x = 1;").errors).toHaveLength(1);
  });

  test("an annotation followed by nothing is an error", () => {
    expect(one("const x = 1;\n// lane-census: scope=pr\n").errors[0]?.message).toContain("covers nothing");
  });
});

describe("annotations in the census", () => {
  const writer = {
    relPath: "packages/gateway/src/connectors/pd.ts",
    contents: 'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { status: 1 } });',
  };
  const reader = (body: string) => ({ relPath: "packages/gateway/src/agents/r.ts", contents: body });

  test("an annotated read is scoped and matched strictly", () => {
    const c = collectLaneCensus([writer, reader('// lane-census: scope=incident\nfunction f(meta: R) { return meta["status"]; }')]);
    expect(c.unscopedReads).toHaveLength(0);
    expect(c.unmatchedItemReads).toHaveLength(0);
  });

  test("an unannotated parameter read is unscoped", () => {
    const c = collectLaneCensus([writer, reader('function f(meta: R) { return meta["status"]; }')]);
    expect(c.unscopedReads.map((r) => r.value)).toEqual(["status"]);
  });

  test("an annotation naming a type no writer emits is an error", () => {
    const c = collectLaneCensus([writer, reader('// lane-census: scope=nosuch\nfunction f(meta: R) { return meta["status"]; }')]);
    expect(c.annotationErrors[0]?.message).toContain("nosuch");
  });

  test("a listed service that writes none of the scoped types is an error", () => {
    const c = collectLaneCensus([writer, reader('// lane-census: scope=incident service=opsgenie\nfunction f(meta: R) { return meta["status"]; }')]);
    expect(c.annotationErrors[0]?.message).toContain("opsgenie");
  });

  test("an annotation covering no metadata read is stale", () => {
    const c = collectLaneCensus([writer, reader("// lane-census: scope=incident\nconst x = 1;")]);
    expect(c.annotationErrors[0]?.message).toContain("covers no metadata read");
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `annotations.ts`**

```ts
function markerRegex(): RegExp {
  return /\/\/\s*lane-census:/;
}
function annotationRegex(): RegExp {
  return /^\s*\/\/\s*lane-census:\s*scope=([a-z0-9_]+(?:,[a-z0-9_]+)*)(?:\s+service=([a-z0-9_]+(?:,[a-z0-9_]+)*))?\s*$/;
}
const FORM = "`// lane-census: scope=<type>[,<type>] [service=<id>[,<id>]]`";
```

Algorithm over `lines = contents.split(/\r?\n/)`:
1. For each line `i` matching `markerRegex()`: if `annotationRegex()` fails → error
   `malformed lane-census annotation; expected ${FORM}`; continue.
2. Find the next line `j > i` that is non-blank and does not start (trimmed) with `//`. If any line
   strictly between `i` and `j` matches `markerRegex()` → error `two lane-census annotations on one
   statement`. No such `j` → error `annotation covers nothing`.
3. `endLine = statementEndLine(contents, offsetOfLine(j))`: scan `stripStringLiterals(stripComments(contents))`
   (both from `../lib.ts`; verify in a test that both preserve newlines so line numbers survive — the
   template test above does). If the statement text matches
   `/^\s*(?:export\s+)?(?:async\s+)?function\b/`, end at the `}` matching the first `{` after the
   parameter list's closing `)`. Otherwise end at the first `;` at bracket depth 0 (track `(){}[]`),
   or end of file. Return its 1-based line.
4. Record `{ file, line: i + 1, types, services, startLine: j + 1, endLine }`.

In `collectLaneCensus`: per production file, call `extractAnnotations`. For each item
metadata-key read, find an annotation whose `[startLine, endLine]` contains `read.line`. If found,
its `types` become the read's scope (overriding the SQL-derived scope, R4) and its `services` (if
any) filter each type's writing services. Annotation errors to add while matching: a type in
`types` with no writer → `annotation names type '<t>', which no writer emits`; a listed service
writing none of `types` → `annotation lists service '<s>', which writes none of <types>`; after all
reads are processed, an annotation that scoped zero reads → `annotation covers no metadata read`.
An item metadata-key read with an empty SQL scope and no annotation goes to `unscopedReads` AND
keeps today's `ambiguousReadCount`/`__ANY__` handling for the report. Thread a `services` filter
through `coverageForType` (intersect `writingServices` and `emittingServices` with it when non-null).

- [ ] **Step 4: Run** `bun test scripts/structure-audit` — PASS. Restore the artifact.

- [ ] **Step 5: Commit** — `feat(census): verified lane-census scope annotations (spec §5.3)`

---

### Task 5: Exemptions, the gate, and `--check`

**Files:**
- Create: `scripts/structure-audit/lane-census/exemptions.ts`, `gate.ts`, `gate.test.ts`
- Modify: `scripts/structure-audit/check-index-lane-coverage.ts` (`run()`)

**Interfaces:**
- Produces:

```ts
// exemptions.ts
export type LaneExemptionCategory = "disclosed" | "legacy" | "not-item" | "by-design";
export type LaneExemption = {
  readonly file: string; // repo-relative, e.g. "packages/gateway/src/metrics/dora.ts"
  readonly key: string; // metadata key (or item type, for a kind:"type" read)
  readonly category: LaneExemptionCategory;
  readonly reason: string;
};
export const LANE_EXEMPTIONS: readonly LaneExemption[] = [];

// gate.ts
export type GateViolationKind = "unmatched" | "partial" | "unscoped" | "annotation" | "stale-exemption" | "invalid-exemption";
export type GateViolation = {
  readonly kind: GateViolationKind;
  readonly file: string;
  readonly line: number;
  readonly key: string;
  readonly message: string;
};
export function evaluateLaneGate(census: LaneCensus, exemptions: readonly LaneExemption[]): readonly GateViolation[];
```

- [ ] **Step 1: Failing tests** (`gate.test.ts`) — fixture census objects built with `collectLaneCensus`:

```ts
import { describe, expect, test } from "bun:test";
import { collectLaneCensus } from "../check-index-lane-coverage.ts";
import { evaluateLaneGate } from "./gate.ts";
import type { LaneExemption } from "./exemptions.ts";

const W = { relPath: "packages/gateway/src/connectors/pd.ts", contents: 'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { status: 1 } });' };
const R = (body: string) => ({ relPath: "packages/gateway/src/agents/r.ts", contents: body });
const dead = R("db.query(`SELECT 1 FROM item WHERE type = 'incident' AND json_extract(metadata, '$.ghost') = 1`);");
const ex = (key: string, extra: Partial<LaneExemption> = {}): LaneExemption => ({
  file: "packages/gateway/src/agents/r.ts", key, category: "disclosed", reason: "disclosed as `x_gap` by the agent", ...extra,
});

describe("evaluateLaneGate", () => {
  test("a dead read fails", () => {
    expect(evaluateLaneGate(collectLaneCensus([W, dead]), []).map((v) => v.kind)).toEqual(["unmatched"]);
  });
  test("an exempted dead read passes", () => {
    expect(evaluateLaneGate(collectLaneCensus([W, dead]), [ex("ghost")])).toEqual([]);
  });
  test("an annotated read passes", () => {
    const c = collectLaneCensus([W, R('// lane-census: scope=incident\nfunction f(meta: R) { return meta["status"]; }')]);
    expect(evaluateLaneGate(c, [])).toEqual([]);
  });
  test("an unannotated unscoped read fails", () => {
    const c = collectLaneCensus([W, R('function f(meta: R) { return meta["status"]; }')]);
    expect(evaluateLaneGate(c, []).map((v) => v.kind)).toEqual(["unscoped"]);
  });
  test("an annotation error fails", () => {
    const c = collectLaneCensus([W, R('// lane-census: scope=nosuch\nfunction f(meta: R) { return meta["status"]; }')]);
    expect(evaluateLaneGate(c, []).some((v) => v.kind === "annotation")).toBe(true);
  });
  test("a stale exemption fails (Review Focus 3)", () => {
    expect(evaluateLaneGate(collectLaneCensus([W]), [ex("ghost")]).map((v) => v.kind)).toEqual(["stale-exemption"]);
  });
  test("an exemption with an empty reason is invalid", () => {
    expect(evaluateLaneGate(collectLaneCensus([W, dead]), [ex("ghost", { reason: " " })]).some((v) => v.kind === "invalid-exemption")).toBe(true);
  });
  test("a contract partial fails unless exempted", () => {
    // partial: two incident writers, only one emits `sev`
    const W2 = { relPath: "packages/gateway/src/connectors/og.ts", contents: 'ctx.upsertItem({ service: "opsgenie", type: "incident", metadata: {} });' };
    const W1 = { relPath: W.relPath, contents: 'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { sev: 1 } });' };
    const read = R("db.query(`SELECT 1 FROM item WHERE type = 'incident' AND json_extract(metadata, '$.sev') = 1`);");
    expect(evaluateLaneGate(collectLaneCensus([W1, W2, read]), []).map((v) => v.kind)).toEqual(["partial"]);
    expect(evaluateLaneGate(collectLaneCensus([W1, W2, read]), [ex("sev")])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `gate.ts`**

```ts
export function evaluateLaneGate(census: LaneCensus, exemptions: readonly LaneExemption[]): readonly GateViolation[] {
  const out: GateViolation[] = [];
  const used = new Set<LaneExemption>();
  const exemptFor = (file: string, key: string): LaneExemption | undefined => {
    const e = exemptions.find((x) => x.file === file && x.key === key);
    if (e !== undefined) used.add(e);
    return e;
  };
  for (const e of exemptions) {
    if (e.reason.trim() === "") {
      out.push({ kind: "invalid-exemption", file: e.file, line: 0, key: e.key, message: "exemption has no reason" });
    }
  }
  for (const r of census.unmatchedItemReads) {
    if (exemptFor(r.file, r.value) !== undefined) continue;
    out.push({
      kind: r.matchState === "partial" ? "partial" : "unmatched",
      file: r.file,
      line: r.line,
      key: r.value,
      message:
        r.matchState === "partial"
          ? `'${r.value}' is emitted only by ${(r.partialCoverage ?? []).join(", ")} for this scope`
          : `no writer emits '${r.value}' for this scope`,
    });
  }
  for (const r of census.unscopedReads) {
    if (exemptFor(r.file, r.value) !== undefined) continue;
    out.push({ kind: "unscoped", file: r.file, line: r.line, key: r.value, message: `'${r.value}' has no type scope: add // lane-census: scope=<type> above the statement` });
  }
  for (const a of census.annotationErrors) {
    out.push({ kind: "annotation", file: a.file, line: a.line, key: "", message: a.message });
  }
  for (const e of exemptions) {
    if (!used.has(e)) {
      out.push({ kind: "stale-exemption", file: e.file, line: 0, key: e.key, message: `exemption (${e.category}) suppresses nothing — delete it` });
    }
  }
  return out;
}
```

Note: an unscoped read that is ALSO in `unmatchedItemReads` (the `__ANY__` union check) must be
reported once — skip `unmatchedItemReads` entries whose `(file, line, value)` is in
`unscopedReads` (add a test: an unscoped read of a key nobody emits yields exactly one `unscoped`
violation).

- [ ] **Step 4: `--check` in `run()`**

Replace the "always exits 0" tail: parse `process.argv.includes("--check")`. Always write the
artifact and print the summary. With `--check`, compute
`evaluateLaneGate(census, LANE_EXEMPTIONS)`; print each violation as
`<file>:<line> [<kind>] <message>` and a final `index-lane census gate: N violation(s)`, and
`process.exit(1)` when N > 0; print `index-lane census gate: ok (<E> exemptions)` otherwise. Update
the module doc comment (it is a gate under `--check` now; without it, still a report). Do NOT add
it to `PREFLIGHT_GATES` yet (Task 12 does, once the tree is clean).

- [ ] **Step 5: Run** `bun test scripts/structure-audit` — PASS. Run
  `bun scripts/structure-audit/check-index-lane-coverage.ts --check; echo $?` — expect exit 1 with a
  violation list (the tree is not annotated yet); save the list to the task report. Restore the
  artifact.

- [ ] **Step 6: Commit** — `feat(census): exemptions file and --check gate (spec §5.4)`

---

### Task 6: PR `number` becomes canonical (R7); GitLab issues carry `number`/`repo`

**Files:**
- Modify: `packages/gateway/src/connectors/pr-meta.ts`, `github-sync.ts`, `bitbucket-sync.ts`, `_lib/gitlab/events.ts`
- Test: `pr-meta.test.ts`, `lane-contract-drift.test.ts`, `_lib/gitlab/events.test.ts`, `bitbucket-sync` and `github-sync` tests that assert metadata, `ipc/index-rebody-rpc.test.ts`

**Interfaces:**
- Produces: `CanonicalPrKey` gains `"number"`; `PrFields.number?: number | undefined`;
  `PR_META_VERSION = 2`; every `PR_EMITTED_KEYS` row includes `"number"`.

- [ ] **Step 1: Failing tests**

`pr-meta.test.ts`:
```ts
test("number is canonical: a positive integer is written, anything else omitted", () => {
  expect(buildPrMetadata({}, { number: 42 })["number"]).toBe(42);
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    expect(buildPrMetadata({}, { number: bad })).not.toHaveProperty("number");
  }
  // a raw `number` is dropped like every canonical key, so the builder alone decides it
  expect(buildPrMetadata({ number: 7 }, {})).not.toHaveProperty("number");
});
test("PR_META_VERSION is 2 (canonical number)", () => {
  expect(PR_META_VERSION).toBe(2);
});
```
`_lib/gitlab/events.test.ts` (Review Focus 4):
```ts
test("every MR event writes number from iid and meta_v 2, so rebody converges", () => {
  for (const actionName of ["opened", "approved", "commented on", "accepted", "closed"]) {
    const m = gitlabMrMetadata({ pathWithNamespace: "g/p", iid: 9, actionName, eventCreatedAt: "2026-01-01T00:00:00Z" }, null);
    expect(m["number"]).toBe(9);
    expect(m["meta_v"]).toBe(PR_META_VERSION);
  }
});
```
Plus a test (same file) that an `issue` row's upserted metadata has `number: iid` and
`repo: pathWithNamespace` (drive `upsertFromIssueEvent`'s exported caller the way existing issue
tests do). `bitbucketPrMetadata("a/b", { id: 5, state: "OPEN" }, undefined)["number"]` is `5`;
`extractPrMetadataForIndex("a/b", { number: 3, state: "open" })["number"]` is `3`.
`lane-contract-drift.test.ts` needs no new assertion — it fails until the table gains `number`.

- [ ] **Step 2: Run** `bun test packages/gateway/src/connectors` — FAIL.

- [ ] **Step 3: Implement**
- `pr-meta.ts`: add `"number"` to `CanonicalPrKey`, `CANONICAL_PR_KEYS`, and Bitbucket's
  `PR_EMITTED_KEYS` row (github/gitlab use the full list). `PrFields.number`. In
  `buildPrMetadata`: `if (typeof fields.number === "number" && Number.isInteger(fields.number) && fields.number > 0) out["number"] = fields.number;`
  `PR_META_VERSION = 2` with its comment extended: `2 (A3): canonical \`number\` (GitHub number, GitLab iid, Bitbucket id).`
- `github-sync.ts` `extractPrMetadataForIndex`: drop `number` from the raw `out` literal; pass
  `number: numberField(pr, "number")` in the fields.
- `bitbucket-sync.ts` `bitbucketPrMetadata`: pass `number: numberField(pr, "id")` (keep raw `id`).
- `_lib/gitlab/events.ts` `gitlabMrMetadata`: pass `number: f.iid` in all three `buildPrMetadata`
  calls. Issue metadata: `{ iid, number: iid, project: pathWithNamespace, repo: pathWithNamespace, action: actionName }`.
- Grep `packages/gateway` for literal `meta_v: 1` on `pr` fixtures and for tests asserting the PR
  `number` raw position; update to the builder output. Check `demo/corpus/` PR rows build through
  `buildPrMetadata` (if they hand-write `meta_v: 1` for `pr`, route them through the builder).

- [ ] **Step 4: Run** `bun test packages/gateway packages/cli scripts` — PASS (the census acceptance
  test should still pass; contract rows now include `number`).

- [ ] **Step 5: Commit** — `feat(index): canonical PR number across forges (PR_META_VERSION 2)`

---

### Task 7: DORA lead time discloses missing merge times and unavailable labels

**Files:**
- Modify: `packages/gateway/src/metrics/dora.ts`, `packages/gateway/openapi/v1.yaml`, `packages/cli/src/commands/stats.ts` (gap list comment, if it enumerates), `docs/cli-reference.md` (DORA section)
- Test: `packages/gateway/src/metrics/dora.test.ts`

**Interfaces:**
- Produces: `DoraGap` gains `"incomplete_merge_data"` and `"pr_labels_unavailable"` (both also in
  `StatsGap` through its `DoraGap` union, and in both OpenAPI enums).

- [ ] **Step 1: Failing tests** (`dora.test.ts`; seed rows with the real mappers)

```ts
test("a merged Bitbucket PR with no merge time reports incomplete_merge_data, not no_deployment_data", () => {
  // seed one successful deploy ci_run for the service (githubActionsRunMetadata) and one merged
  // Bitbucket pr (bitbucketPrMetadata(... state: "MERGED")) in the window
  expect(leadTimeForChanges(db, cfg, now, since).gap).toBe("incomplete_merge_data");
});
test("a GitHub-only service with default excludePrLabels gains no new gap (Review Focus 5)", () => {
  // github pr via extractPrMetadataForIndex with labels: [] and merge_commit_sha matching a deploy head_sha
  const r = leadTimeForChanges(db, cfg, now, since);
  expect(r.gap === null || r.gap === "low_sample").toBe(true);
});
test("a measured lead time with a GitLab PR that carries no labels reports pr_labels_unavailable", () => {
  // github PR measured + gitlab merged MR (gitlabMrMetadata, no labels) with excludePrLabels ["revert"]
  expect(leadTimeForChanges(db, cfg, now, since).gap).toBe("pr_labels_unavailable");
});
test("approximate_lead_time outranks incomplete_merge_data", () => {
  // one github PR with no matching deploy (approximate) + one merged bitbucket PR
  expect(leadTimeForChanges(db, cfg, now, since).gap).toBe("approximate_lead_time");
});
test("an empty excludePrLabels never reports pr_labels_unavailable", () => {
  // same seed as the pr_labels_unavailable test with excludePrLabels: []
  expect(leadTimeForChanges(db, cfgNoLabels, now, since).gap).not.toBe("pr_labels_unavailable");
});
```
Write the seeding with the same helpers `dora.test.ts` already uses (read its existing lead-time
tests first and reuse their setup).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

```ts
type PrLeadTime = {
  leadTime: number | null;
  approximate: boolean;
  /** Merged, but the forge recorded no merge time (Bitbucket never does): unmeasurable, not absent. */
  mergeTimeUnknown: boolean;
  /** `excludePrLabels` is set but this PR carries no labels array, so the filter could not apply. */
  labelsUnknown: boolean;
};
```
In `prLeadTime`: compute `labelsUnknown = excludePrLabels.length > 0 && !Array.isArray(meta["labels"])`
right after the merged check; the `mergedAt === null` return becomes
`{ leadTime: null, approximate: false, mergeTimeUnknown: true, labelsUnknown }`; every other return
carries `mergeTimeUnknown: false, labelsUnknown`. Aggregate `anyMergeTimeUnknown`/`anyLabelsUnknown`
in `leadTimeForChanges`, and replace both gap expressions with one helper:

```ts
/** One gap slot, most consequential first: an approximation, then unmeasurable merges, then an unapplied label filter. */
function leadTimeGap(f: { approximate: boolean; mergeTimeUnknown: boolean; labelsUnknown: boolean }, measured: boolean): DoraGap {
  if (f.approximate) return "approximate_lead_time";
  if (f.mergeTimeUnknown) return "incomplete_merge_data";
  if (!measured) return "no_deployment_data";
  return f.labelsUnknown ? "pr_labels_unavailable" : null;
}
```
Add both members to `DoraGap` with a comment each. OpenAPI: add `incomplete_merge_data` and
`pr_labels_unavailable` to the DORA gap enum (~line 385) and `pr_labels_unavailable` to the stats
enum (~line 429; it already has `incomplete_merge_data`). Run `bun run audit:openapi-drift`. Update
`docs/cli-reference.md`'s `nimbus metrics dora` paragraph: one sentence per new gap (Bitbucket never
records a merge time; GitLab/Bitbucket PRs carry no labels, so `excludePrLabels` cannot exclude
them). If `packages/cli/src/commands/stats.ts` enumerates gap names in prose, add them.

- [ ] **Step 4: Run** `bun test packages/gateway/src/metrics packages/cli` — PASS; `bun run typecheck`.

- [ ] **Step 5: Commit** — `fix(dora): disclose merged PRs with no merge time and unappliable label filters`

---

### Task 8: Service identity — remove the dead GitLab `project` and Jenkins `jobName` arms

**Files:**
- Modify: `packages/gateway/src/metrics/service-identity.ts`
- Test: `packages/gateway/src/metrics/service-identity.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("a jenkins URN never binds through metadata (no deployment writer records a job name)", () => {
  // resolver built from a ServiceConfig whose repos = [jenkins URN for job "deploy-api"]
  expect(resolve({ service: "vercel", type: "deployment", metadata: { jobName: "deploy-api", environment: "prod" } }).kind).not.toBe("bound");
});
test("a gitlab URN binds through repo, as Vercel and premortem's synthetic row carry it", () => {
  expect(resolve({ service: "unknown", type: "pr", metadata: { repo: "g/p" } })).toEqual({ kind: "bound", serviceId: "svc" });
});
```
First grep `service-identity.test.ts` and `graph/` tests for an existing assertion that a `jobName`
or `project` binds; if one exists it asserts the dead behaviour — rewrite it to the new one and say
so in the commit body.

- [ ] **Step 2: Run — the jenkins test FAILS.**

- [ ] **Step 3: Implement** — in `repoMetadataMatchesUrn`:

```ts
    case "gitlab":
      // No deployment writer records a GitLab project id: annotated deployments bind through
      // `nimbus_service_id`; Vercel and premortem's synthetic row carry `repo`.
      return metadata["repo"] === urn.providerId;
    case "jenkins":
    // No deployment writer records a Jenkins job name (annotated deployments bind through
    // `nimbus_service_id`), so a job-name match could never fire.
    case "circleci":
      return false;
```
(Keep `dora.ts`'s `repoLikeMatchesUrn` unchanged: its `project`/`jobName` arms read `ci_run` rows,
which GitLab and Jenkins do write.) Update the function's doc comment.

- [ ] **Step 4: Run** `bun test packages/gateway/src/metrics packages/gateway/src/graph` — PASS.

- [ ] **Step 5: Commit** — `fix(metrics): drop service-identity match arms no writer can satisfy`

---

### Task 9: Pre-mortem discloses forges left out of a MEASURED review drag

**Files:**
- Modify: `packages/gateway/src/agents/premortem.ts` (`reviewDragMedians`), `packages/gateway/src/premortem/risks.ts` (`computeReviewDrag`)
- Test: `packages/gateway/src/premortem/risks.test.ts`, `packages/gateway/src/agents/premortem.test.ts`

- [ ] **Step 1: Failing tests**

`risks.test.ts`:
```ts
test("a measured review drag names forges whose PRs were left out", () => {
  const r = computeReviewDrag({ reviewDragMedianMs: 7_200_000, repoReviewMedianMs: 3_600_000, forgesMissingTiming: ["bitbucket"] });
  expect(r.value).toBe(3_600_000);
  expect(r.summary).toContain("Bitbucket never records a merge time.");
  expect(r.summary).toContain("left out");
});
test("a measured review drag with nothing left out is unchanged", () => {
  const r = computeReviewDrag({ reviewDragMedianMs: 7_200_000, repoReviewMedianMs: 3_600_000, forgesMissingTiming: [] });
  expect(r.summary).not.toContain("left out");
});
```
`premortem.test.ts`: a cohort with one timed GitHub PR and one Bitbucket PR (seeded via
`extractPrMetadataForIndex` / `bitbucketPrMetadata`) yields a measured review-drag risk whose summary
names Bitbucket.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**
- `reviewDragMedians`: compute
  `const untimedForges = [...new Set(timings.filter((t) => t.opened_at_ms === null || t.merged_at === null).map((t) => t.service))].sort((a, b) => a.localeCompare(b));`
  and return it as `forgesMissingTiming` in BOTH branches (the unmeasured branch keeps its current
  value, which equals this list there).
- `computeReviewDrag` measured branch: when `forgesMissingTiming.length > 0`, append
  `` ` ${leftOutSentence(input.forgesMissingTiming)}` `` where

```ts
function leftOutSentence(forges: readonly string[]): string {
  const reasons = forges.map((f) => FORGE_TIMING_REASON[f] ?? `${f} pull requests carry no opened or merged time.`);
  return `Pull requests without both timestamps are left out of both medians. ${reasons.join(" ")}`;
}
```
  and refactor `missingTimingSummary` to reuse the same `reasons` mapping (one helper, not two
  copies). Update `forgesMissingTiming`'s doc comment (now non-empty in the measured case too).
- Check `agents/_lib/brief-disclosures.ts` for a premortem review-drag anchor; if the
  missing-timing sentence is anchored there (I31), add an anchor for the new sentence in the same
  structure and run `disclosure-anchor-coverage.test.ts`.

- [ ] **Step 4: Run** `bun test packages/gateway/src/premortem packages/gateway/src/agents` — PASS.

- [ ] **Step 5: Commit** — `fix(premortem): name forges left out of a measured review drag`

---

### Task 10: Standup's chat lane counts Slack only (R8)

**Files:**
- Modify: `packages/gateway/src/agents/standup-queries.ts` (`selectMessages`, `countMessageThreads`), `docs/cli-reference.md` (standup section)
- Test: `packages/gateway/src/agents/standup-queries.test.ts`

- [ ] **Step 1: Failing test** — seed one Slack `message` (thread) and one Discord `message` by the
  owner in the window; assert `selectMessages` returns only the Slack row and `countMessageThreads`
  is `1`.

- [ ] **Step 2: Run — FAIL** (Discord row counted).

- [ ] **Step 3: Implement** — add `AND i.service = 'slack'` to both queries; amend both doc comments
  ("the lane is Slack's: its heading, thread key and `ts`-based time basis are all Slack-shaped;
  Discord messages are not counted"). In `docs/cli-reference.md`'s standup section add one
  sentence: only Slack messages are counted; Discord messages are not.

- [ ] **Step 4: Run** `bun test packages/gateway/src/agents packages/gateway/test/e2e/scenarios/standup.e2e.test.ts` — PASS.

- [ ] **Step 5: Commit** — `fix(standup): count Slack messages only in the Slack activity lane`

---

### Task 11: Annotate and exempt — `agents/`, `metrics/`, `preflight/`, `premortem/`

**Files:**
- Modify (annotation comments only, no logic): reader files under those four directories
- Modify: `scripts/structure-audit/lane-census/exemptions.ts`

Procedure:
1. Run `bun scripts/structure-audit/check-index-lane-coverage.ts --check` and take every violation
   whose file is under `packages/gateway/src/{agents,metrics,preflight,premortem}/`.
2. For each, find its row in **Appendix A** (sites are at `35157297`; lines moved — match on file +
   key + the quoted code). Apply:
   - **OK** and the read is `unscoped` → add `// lane-census: scope=<type> [service=<ids>]` above the
     statement (R3), using the Appendix's Scope column. One annotation per statement; a function
     whose body holds several reads takes one annotation above the `function`.
   - **PARTIAL with a disclosure** → annotate if unscoped, then add an exemption, category
     `disclosed`, reason naming the disclosure (gap code or rendered sentence, plus the function
     that emits it — not a line number).
   - **PARTIAL by design** (preflight `repo`/`workflow_name` partition keys COALESCE to `''`; media
     `path` null routes to cloud fetch; service-identity `repo` — Prefect deployment definitions
     never bind) → exemption `by-design`, reason states the design.
   - **LEGACY** (`dora.ts` `headSha`) → exemption `legacy`: "raw pre-A1 key, read only when `meta_v`
     is absent (`ciRunHeadSha`)".
   - **TEST_HELPER / WRITE / NOT_ITEM** rows must already be gone after Task 1. If one is still a
     violation, Task 1's rule is wrong: fix the rule with a test, never exempt it.
   - Rows **fixed by Tasks 6–10** (`why.ts`/`pr-subject.ts` `number`, `dora.ts` `merged_at`/`labels`,
     `service-identity.ts` `project`/`jobName`, `premortem.ts` `merged_at`, `standup-queries.ts`
     `thread_ts`/`channel`) must now resolve: `number` via the canonical key; `merged_at`/`labels`
     as `disclosed` (the new DORA gaps / premortem sentence); `thread_ts`/`channel` via an
     annotation `scope=message service=slack`; `project`/`jobName` reads no longer exist.
3. Any read that is genuinely dead or partial with NO disclosure after Tasks 6–10: STOP and report
   BLOCKED with the site — never write an exemption saying "undisclosed" (R1).
4. Re-run `--check`; this task is done when no violation remains under these four directories.
   Run `bun run lint` (Biome must accept the comments) and `bun test scripts/structure-audit`.
5. Restore the artifact; commit — `chore(census): scope annotations and exemptions for agents/metrics/preflight/premortem`.

---

### Task 12: Annotate and exempt the rest; wire the gate; red-proof

**Files:**
- Modify: reader files under `connectors/`, `graph/`, `ipc/`, `index/`, `toolgen/`, `security/`, `multimodal/` (annotations only)
- Modify: `scripts/structure-audit/lane-census/exemptions.ts`, `scripts/lib/preflight-gates.ts`, `.github/workflows/_structure.yml`
- Test: `scripts/lib/preflight-gates.test.ts` (existing drift tests must pass)

- [ ] **Step 1: Annotate/exempt** with the Task 11 procedure for every remaining violation. Known
  dispositions from Appendix A:
  - Great Expectations `run_id`/`active_batch_definition`/`batch_spec` (parameter `meta` holding a GE
    validation-result file) → exemption `not-item`, one per key.
  - `connectors/_lib/gitlab/events.ts` `author_login`/`author_name` (reads the metadata
    `gitlabMrMetadata` just built for the same upsert, keys added by `withAuthor`) → exemption
    `by-design`.
  - `graph/graph-populator.ts` `number`/`repo` on `issue` (fallback after
    `findIssueByIndexedExternalId`; GitLab issue rows now also carry both keys, but their writer's
    `type` comes from `GitlabItemShape` and is invisible to the census) → exemption `by-design`.
  - `agents/why.ts` generic URL-resolved `number` (any item type; `number` is optional display) →
    after Task 6 it is `partial` only for item types with no forge number; exemption `by-design`.
  - Everything else in Appendix A marked OK → annotation.
- [ ] **Step 2: Gate is green.** `bun scripts/structure-audit/check-index-lane-coverage.ts --check`
  exits 0. Paste its final line into the task report.
- [ ] **Step 3: Red-proof (R9).** Change `'$.workflow_name'` in `preflight/preflight.ts`'s
  failing-runs CTE to `'$.workflowName'`; run `--check`; expect exit 1 with an `unmatched`
  violation at that line (and the `workflow_name` exemption reported stale). Restore the file
  (`git diff` empty for it). Record both outputs in the task report.
- [ ] **Step 4: Wire it.** `package.json` keeps `"audit:lane-census"` (report). In
  `scripts/lib/preflight-gates.ts` FAST tier, after `audit:invariants`:

```ts
  {
    // Index lane contract (A3): every production read of an `item` metadata key or type must match
    // a writer, carry a verified `// lane-census: scope=` annotation, or be exempted with a reason in
    // `lane-census/exemptions.ts`. Exemptions that suppress nothing fail too.
    name: "audit:lane-census",
    cmd: ["bun", "run", "audit:lane-census", "--check"],
    tier: "fast",
  },
```
  In `.github/workflows/_structure.yml`, after the invariants step:

```yaml
      - name: Index lane census — reads match writers (A3 gate)
        run: bun run audit:lane-census --check
```
  Update `_structure.yml`'s header comment list to name it.
- [ ] **Step 5: Run** `bun test scripts` and `bun run preflight:fast` (temporarily move
  `docs/superpowers/` out of the tree for `lint:markdown`, restore after) — PASS. Restore the
  artifact.
- [ ] **Step 6: Commit** — `feat(census): enforce the index lane gate in preflight and CI`

---

### Task 13: Docs, artifact, memory

**Files:**
- Modify: `docs/CHANGELOG.md`, `docs/roadmap.md` (B4 row), `docs/cli-reference.md` (only if Tasks 6–10 left a user-visible change undocumented), `.claude/commands/nimbus-commands.md` (the `audit:lane-census` line), `docs/structure-audit/index-lane-census.json`

- [ ] **Step 1:** CHANGELOG — new top entry `2026-10-09 — Index lane contract (PR A3): the lane census
  is a gate`: what the gate enforces (match / annotate / exempt, stale exemptions fail), the census
  fixes, and the user-visible fixes (canonical PR `number` + `PR_META_VERSION` 2 — run `nimbus index
  rebody --service github|gitlab|bitbucket` to backfill; DORA `incomplete_merge_data` /
  `pr_labels_unavailable`; pre-mortem left-out forges; standup Slack-only; service-identity dead
  arms removed, no behaviour change). One paragraph, past tense, no line numbers.
- [ ] **Step 2:** roadmap B4 row: `[ ]` → `[x]`, append the 2026-10-09 sentence that the gate half
  shipped (`audit:lane-census --check` in `preflight:fast` and `_structure.yml`). Keep the 2026-09-20
  history.
- [ ] **Step 3:** `nimbus-commands.md`: note `audit:lane-census --check` is the gate form.
- [ ] **Step 4:** regenerate and commit the artifact: `bun run audit:lane-census`.
- [ ] **Step 5:** Run `bun run preflight:fast` (superpowers dir moved aside), and the full
  `bun test packages/gateway packages/cli scripts`. Record pass/skip/fail counts.
- [ ] **Step 6: Commit** — `docs: index lane gate (A3) in CHANGELOG, roadmap and command skill`

---

## Appendix A — read-site classification at `35157297`

Produced by two read-only research passes on 2026-10-09 over every read the census could not
verify (the 90 `unmatchedItemReads` ∪ the 124 `__ANY__`-scoped reads, deduped). Verdicts:
OK (every writer of the scope emits it), PARTIAL, DEAD, LEGACY, WRITE (assignment, not a read),
NOT_ITEM, TEST_HELPER. Lines are at `35157297` and will have moved.

| Site (at 35157297) | Key | Verdict | Scope | Disclosure |
|---|---|---|---|---|
| agents/_lib/changelog-event-time.ts:50 | status | OK | type=incident service=pagerduty (only incident writer) | n/a |
| agents/_lib/demo-symbol.ts:14 | excerptStartLine | OK | type=code_symbol service=filesystem | n/a |
| agents/_lib/demo-symbol.ts:20 | excerptStartLine | OK | type=code_symbol service=filesystem | n/a |
| agents/_lib/oncall-queries.ts:330 | merge_commit_sha | PARTIAL | type=pr service=github,gitlab,bitbucket | oncall `missing_connector` gap: only the GitHub connector records the merge commit |
| agents/_lib/pr-subject.ts:47 | repo | OK | type=pr service=github,gitlab,bitbucket | n/a |
| agents/_lib/pr-subject.ts:48 | number | PARTIAL → fixed by Task 6 | type=pr service=github,gitlab,bitbucket | was undisclosed (render omits #N) |
| agents/_lib/why-subject.ts:74 | excerptStartLine | OK | type=code_symbol service=filesystem | n/a |
| agents/_lib/why-subject.ts:86 | excerptStartLine | OK | type=code_symbol service=filesystem | n/a |
| agents/changelog-queries.ts:325 | state | OK | type=pr service=gitlab,bitbucket (service <> 'github') | n/a |
| agents/changelog-queries.ts:326 | merged_at | PARTIAL | type=pr service=gitlab,bitbucket | the query IS the disclosure: counts merged rows lacking merged_at |
| agents/negotiate.ts:378 | merged | OK | type=pr service=github,gitlab,bitbucket | mergedCoverage |
| agents/negotiate.ts:381 | additions | PARTIAL | type=pr service=github,gitlab,bitbucket | stats coverage covered/total (render) |
| agents/negotiate.ts:387 | deletions | PARTIAL | type=pr service=github,gitlab,bitbucket | stats coverage covered/total |
| agents/negotiate.ts:389 | changed_files | PARTIAL | type=pr service=github,gitlab,bitbucket | stats coverage covered/total |
| agents/premortem.ts:78 | issue_type | OK | type=issue service=jira | n/a |
| agents/premortem.ts:79 | created_at_ms | OK | type=issue service=jira | n/a |
| agents/premortem.ts:98 | parent_key | OK | type=issue service=jira | absence on classic projects documented in jira-sync |
| agents/premortem.ts:205 | opened_at_ms | OK | type=pr service=github,gitlab,bitbucket | n/a |
| agents/premortem.ts:206 | merged_at | PARTIAL → disclosed by Task 9 | type=pr service=github,gitlab,bitbucket | was cohort-only |
| agents/premortem.ts:211 | opened_at_ms | OK | type=pr service=github,gitlab,bitbucket | n/a |
| agents/premortem.ts:212 | merged_at | PARTIAL → disclosed by Task 9 | type=pr | was cohort-only |
| agents/premortem.ts:213 | merged_at | PARTIAL → disclosed by Task 9 | type=pr | was cohort-only |
| agents/standup-queries.ts:272 | thread_ts | PARTIAL → fixed by Task 10 | type=message service=slack | n/a after Slack scope |
| agents/standup-queries.ts:273 | channel | PARTIAL → fixed by Task 10 | type=message service=slack | n/a |
| agents/standup-queries.ts:274 | thread_ts | PARTIAL → fixed by Task 10 | type=message service=slack | n/a |
| agents/standup-queries.ts:363 | state | OK | type=pr service=gitlab,bitbucket | n/a |
| agents/standup-queries.ts:364 | merged | OK | type=pr service=gitlab,bitbucket | n/a |
| agents/standup-queries.ts:365 | merged_at | PARTIAL | type=pr service=gitlab,bitbucket | the query IS the disclosure (counts merged rows without merged_at) |
| agents/why-peek.ts:39 | number | OK | type=pr via merged_as edge (github) | n/a |
| agents/why.ts:142 | number | PARTIAL → fixed by Task 6 | type=pr service=github,gitlab,bitbucket | was "#?" |
| agents/why.ts:193 | number | PARTIAL (by design after Task 6) | any URL-resolved item type | optional display field |
| agents/why.ts:436 | number | OK | type=pr via merged_as (github) | n/a |
| connectors/_lib/gitlab/events.ts:224 | author_login | OK (by design) | gitlab:pr | reads metadata built for the same upsert |
| connectors/_lib/gitlab/events.ts:225 | author_name | OK (by design) | gitlab:pr | same |
| connectors/argocd-application-mapping.ts:39 | creationTimestamp | NOT_ITEM | k8s ObjectMeta | - |
| connectors/filesystem-v2-sync.ts:372 | excerptStartLine | WRITE | filesystem:code_symbol | - |
| connectors/flux-resource-mapping.ts:60 | creationTimestamp | NOT_ITEM | k8s ObjectMeta | - |
| connectors/github-index-repos.ts:6,9,10 | repo | OK | github:pr, github:review, github:issue | - |
| connectors/github-sync.ts:642 | additions | OK | github:pr (IS NULL picks PRs to enrich) | - |
| connectors/great-expectations-sync.ts:42,54 | run_id | NOT_ITEM (parameter) | GE validation result | - |
| connectors/great-expectations-sync.ts:69 | active_batch_definition | NOT_ITEM (parameter) | GE validation result | - |
| connectors/great-expectations-sync.ts:79 | batch_spec | NOT_ITEM (parameter) | GE validation result | - |
| connectors/jira-sync.ts:390,404 | status_category | WRITE | jira:issue | - |
| connectors/linear-sync.ts:164–197 | status, status_category_raw, status_category, created_at_ms, resolved_at_ms, due_at_ms, parent_key, project_id | WRITE | linear:issue | - |
| connectors/mlflow-model-mapping.ts:126 | summary | WRITE | mlflow:ml_model | - |
| connectors/pagerduty-sync.ts:82–85 | opened_at_ms, pagerduty_service_id, severity, urgency | WRITE | pagerduty:incident | - |
| connectors/slack-sync.ts:190,341 | next_cursor | NOT_ITEM | pagination envelope | - |
| connectors/zendesk-sync.ts:72 | has_more | NOT_ITEM | pagination envelope | - |
| graph/graph-populator.ts:279 | number | PARTIAL (by design) | github:issue, gitlab:issue | fallback after exact external_id lookup |
| graph/graph-populator.ts:280 | repo | PARTIAL (by design) | github:issue, gitlab:issue | same |
| graph/graph-populator.ts:337 | merged | OK | github/bitbucket/gitlab pr | - |
| graph/graph-populator.ts:374 | pr_number | OK | github:review | - |
| graph/graph-populator.ts:490 | resolved_wikilink_ids | OK | obsidian:obsidian_note | - |
| graph/graph-populator.ts:823 | resolved_by_email | OK | pagerduty:incident | - |
| graph/graph-populator.ts:919 | assignedTo | OK | sentry:error_issue | - |
| graph/graph-populator.ts:937 | project | OK | sentry:error_issue | - |
| identity/scim-service.ts:28,29 | lastModified | NOT_ITEM | SCIM resource meta | - |
| index/item-store.ts:235–244 | mime_type, size_bytes, parent_id, created_at | WRITE (test-only path, R2) | - | - |
| index/item-store.ts:310 | bodyFetch | OK | notion:page | - |
| ipc/clip-rpc.ts:78–94 | tags, mode, wordCount, sourceWordCount | OK | nimbus:web_clip | sourceWordCount absent = not truncated |
| ipc/clip-rpc.ts:122,128,135 | web_clip (type) | OK | nimbus:web_clip | - |
| ipc/security-rpc.ts:124 | repoRoot | OK | filesystem:code_symbol | - |
| ipc/security-rpc.ts:125 | file | OK | filesystem:code_symbol | - |
| metrics/dora.ts:73 | repo | OK | ci_run + pr (github/bitbucket URN) | bitbucket ci_run: ci_not_evaluable |
| metrics/dora.ts:75 | project, repo | OK | ci_run + pr (gitlab URN) | n/a |
| metrics/dora.ts:77 | jobName | OK | ci_run service=jenkins | n/a |
| metrics/dora.ts:114 | conclusion | OK | ci_run | circleci/bitbucket: ci_not_evaluable |
| metrics/dora.ts:224 | head_sha | PARTIAL | ci_run (jenkins lacks it) | approximate_lead_time |
| metrics/dora.ts:226 | headSha | LEGACY | ci_run | n/a |
| metrics/dora.ts:227 | meta_v | OK | ci_run | n/a |
| metrics/dora.ts:245 | merged | OK | type=pr | n/a |
| metrics/dora.ts:246 | merged_at | PARTIAL → disclosed by Task 7 | type=pr | incomplete_merge_data |
| metrics/dora.ts:249 | labels | PARTIAL → disclosed by Task 7 | type=pr | pr_labels_unavailable |
| metrics/dora.ts:254 | merge_commit_sha | PARTIAL | type=pr | approximate_lead_time |
| metrics/dora.ts:351,352,354 | status, opened_at_ms, pagerduty_service_id | OK | incident service=pagerduty | n/a |
| metrics/service-identity.ts:68,70 | repo | PARTIAL (by design) | deployment (vercel; prefect never binds) + incident + synthetic pr | Prefect deployment definitions carry no repo |
| metrics/service-identity.ts:70 | project | DEAD → removed by Task 8 | - | - |
| metrics/service-identity.ts:72 | jobName | DEAD → removed by Task 8 | - | - |
| metrics/stats.ts:171–173 | merged_at | OK | type=pr service=github,gitlab | Bitbucket excluded, incomplete_merge_data |
| multimodal/media-discovery.ts:200 | mimeType | OK | filesystem media + photos/drive/onedrive | - |
| multimodal/media-discovery.ts:213 | path | PARTIAL (by design) | same | null sourcePath routes to cloud byte-fetch |
| preflight/preflight.ts:112,126,127,128,130 | opened_at_ms, status, severity, pagerduty_service_id | OK | incident service=pagerduty | n/a |
| preflight/preflight.ts:171 | repo | PARTIAL (by design) | ci_run | partition key COALESCEs to '' |
| preflight/preflight.ts:172 | workflow_name | PARTIAL (by design) | ci_run | partition key COALESCEs to '' |
| preflight/preflight.ts:179 | branch | PARTIAL | ci_run (jenkins lacks it) | ci_not_evaluable |
| preflight/preflight.ts:183,210 | conclusion | OK | ci_run | circleci: ci_not_evaluable |
| preflight/preflight.ts:212 | branch | OK | ci_run rows already matching branch | n/a |
| preflight/preflight.ts:247,254,262 | mergeable_state | PARTIAL | type=pr | unknown_mergeable_state gap |
| preflight/preflight.ts:278,280 | number, mergeable_state | OK | type=pr, effectively github | n/a |
| premortem/cohort.test-helpers.ts:48 | created_at_ms | TEST_HELPER | - | - |
| premortem/cohort.ts:59–127 | parent_key, created_at_ms, resolved_at_ms, status_category, issue_type | OK | type=issue service=jira | n/a |
| premortem/epic-services.ts:61,112 | parent_key | OK | type=issue service=jira | n/a |
| premortem/theme-discover.ts:40,41,58 | status_category, issue_type, resolved_at_ms | OK | type=issue service=jira | n/a |
| security/scan.ts:78 | excerptStartLine | OK | filesystem:code_symbol | - |
| toolgen/toolgen-grounding.ts:34–41 | tags, service_name, operation_id | OK | openapi:api_endpoint | - |
