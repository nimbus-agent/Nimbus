# jscpd Stage B1 — MCP search-tool scaffolding sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut strict jscpd duplication by collapsing the cloned MCP connector search-tool schema + result-envelope into two small shared helpers and sweeping the ~45 connectors that match the canonical shape.

**Architecture:** Add `packages/mcp-connectors/shared/mcp-search-tool.ts` with two pure helpers — `searchToolInputSchema(maxLimit)` (collapses the `{query, limit}` zod schema, cap parameterized to preserve each connector's exact limit) and `matchesResult(rows, filter, opts)` (collapses the `Array.isArray(X) ? filter(X, …) : [] → jsonResult({matches})` tail). Then mechanically apply them to each connector's search tool. Pure dedup, zero behavior change — every edit is a verbatim-equivalent transformation; each connector's `sandbox.test.ts` + `search-filter.test.ts` stay green unedited.

**Tech Stack:** Bun v1.2+, TypeScript 6 strict, zod, Biome. MCP connectors (AGPL) under `packages/mcp-connectors/*`, sharing relative-imported helpers from `packages/mcp-connectors/shared/`.

**Spec:** [`docs/superpowers/specs/2026-06-17-jscpd-stage-b1-search-tool-scaffolding-design.md`](../specs/2026-06-17-jscpd-stage-b1-search-tool-scaffolding-design.md)

## Global Constraints

- **No `any`** (Non-Negotiable #7) — external payloads stay `unknown` at the boundary; helpers are generic/structural.
- **Pure dedup — zero behavior change.** Preserve each connector's exact `limit` cap, `query.min(1)`, fetch URL, keyed-extract expression, and filter function. No connector test (`sandbox.test.ts`, `search-filter.test.ts`, etc.) may be edited.
- **No force-fit.** Migrate only connectors matching the exact shapes below. Skip `dbt`, `flagsmith`, `flux` (extra schema field AND no `Array.isArray` guard — neither helper applies).
- **Target `mcp-connectors/shared/`**, relative-imported (`../../shared/…`). NOT the SDK.
- **Do not** touch other tool handlers (list/get/etc.), the CI lenient duplication gate (`pr-quality-duplication` — tightening is the program's final stage), perf surfaces, or `.jscpd.json`.
- **Prereq (already done in this worktree; redo if the worktree is recreated):** `cd packages/sdk && bun run build` and `cd packages/client && bun run build` — otherwise `sandbox.test.ts` fails with `Cannot find module '@nimbus-dev/sdk/testing'`.
- **Strict jscpd baseline (clean main `8f346bac`):** 4.98% (637 clones). Re-measure after the sweep.

---

## Transformation Reference (applies to every sweep task: Tasks 2–7)

Each connector's search tool is in `packages/mcp-connectors/<conn>/src/server.ts`. Apply whichever of the two transforms the connector's row in the task table calls for (`schema`, `tail`, or `both`). **Leave everything else byte-identical** — name string, description string, fetch URL, the keyed `const X = (root as {…})?.key;` line, and the filter function.

### Transform 1 — schema collapse (`searchToolInputSchema(<cap>)`)

Replace the inline 3-line zod object with one call, passing the connector's **exact** existing cap:

```ts
// before
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
// after
    searchToolInputSchema(100),
```

### Transform 2 — tail collapse (`matchesResult(X, filterFn, p)`)

Replace the guarded `Array.isArray(X) ? filter : [] → jsonResult({matches})` tail with one return. `X` is whatever the existing code guards (`root` for the root category, or the already-extracted keyed variable). `p` is the handler arg.

Root category (X = `root`):

```ts
// before
    async (p) => {
      const root = await zoteroGet(`…`);
      const matches = Array.isArray(root)
        ? filterZoteroItems(root, { query: p.query, limit: p.limit })
        : [];
      return jsonResult({ matches });
    },
// after
    async (p) => {
      const root = await zoteroGet(`…`);
      return matchesResult(root, filterZoteroItems, p);
    },
```

**Pass `p` directly — do not destructure or rebuild it.** For the extra-field connectors (Task 7, e.g. `p` also carries `appId`/`orgId`/`projectKey`), write `matchesResult(X, filterFn, p)`. Passing the `p` *variable* is correct and typechecks: TS excess-property checks fire only on fresh object literals, not on a variable with extra fields (verified 2026-06-17). Do **not** "helpfully" rewrite it to `matchesResult(X, filterFn, { query: p.query, limit: p.limit })` — that adds noise and is unnecessary.

Keyed category (X = the extracted variable; **keep that extract line unchanged**):

```ts
// before
    async (p) => {
      const root = await zendeskGet(`…`);
      const tickets = (root as { tickets?: unknown[] } | null)?.tickets;
      const matches = Array.isArray(tickets)
        ? filterZendeskTickets(tickets, { query: p.query, limit: p.limit })
        : [];
      return jsonResult({ matches });
    },
// after
    async (p) => {
      const root = await zendeskGet(`…`);
      const tickets = (root as { tickets?: unknown[] } | null)?.tickets;
      return matchesResult(tickets, filterZendeskTickets, p);
    },
```

### Import rule

- Add to the top imports: `import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";` — include only the name(s) actually used by that file's transforms.
- **Do NOT remove `import { z }` or the `mcpJsonResult as jsonResult` import by hand.** After the code edits, let Biome do it deterministically: `bunx biome check --write <edited server.ts files>`. Biome's `noUnusedImports` removes a now-unused import (and leaves `z`/`jsonResult` in place when another tool in the file still uses them) — far safer than manual grep-and-delete. `--write` also normalizes formatting on the touched lines, which is expected.
- The per-task verify step then re-runs `bunx biome check` (read-only) + tsc to confirm nothing is unused or broken.

### Verify (each sweep task)

Run the edited connectors' tests (replace the names):

```bash
bun test packages/mcp-connectors/<conn1>/ packages/mcp-connectors/<conn2>/ …
```

Expected: all pass (skips OK), **0 fail**, with no test file modified. Then typecheck each edited connector. Each connector has its own `tsconfig.json` (`include: ["src/**/*"]`) and tsc follows the `../../shared/mcp-search-tool.ts` import, so the shared helper is checked transitively here:

```bash
for c in <this batch's connectors, space-separated>; do bunx tsc --noEmit -p packages/mcp-connectors/$c/tsconfig.json || break; done
```

Expected: no errors. (The authoritative full check is `bun run typecheck`, run in Task 8's preflight; the per-connector loop is the fast inner-loop equivalent.)

---

## Task 1: Create the `mcp-search-tool` shared helpers

**Files:**

- Create: `packages/mcp-connectors/shared/mcp-search-tool.ts`
- Test: `packages/mcp-connectors/shared/mcp-search-tool.test.ts`

**Interfaces:**

- Consumes: `mcpJsonResult`, `McpListResult`, `ZodObjectSchema<T>` from `./mcp-tool-kit.ts`; `SearchMatchOptions` from `./search-filter.ts`; `z` from `zod`.
- Produces:
  - `searchToolInputSchema(maxLimit = 100): ZodObjectSchema<SearchMatchOptions>`
  - `matchesResult(rows: unknown, filter: SearchFilter, opts: SearchMatchOptions): McpListResult`
  - `type SearchFilter = (rows: readonly unknown[], opts: SearchMatchOptions) => readonly unknown[]`

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-connectors/shared/mcp-search-tool.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { matchesResult, searchToolInputSchema } from "./mcp-search-tool.ts";

describe("searchToolInputSchema", () => {
  test("accepts query alone and query+limit", () => {
    const s = searchToolInputSchema();
    const a = s.safeParse({ query: "x" });
    expect(a.success).toBe(true);
    if (a.success) {
      expect(a.data).toEqual({ query: "x" });
    }
    const b = s.safeParse({ query: "x", limit: 5 });
    expect(b.success).toBe(true);
    if (b.success) {
      expect(b.data).toEqual({ query: "x", limit: 5 });
    }
  });

  test("rejects empty query", () => {
    expect(searchToolInputSchema().safeParse({ query: "" }).success).toBe(false);
  });

  test("rejects limit over the default cap of 100, below 1, or non-integer", () => {
    const s = searchToolInputSchema();
    expect(s.safeParse({ query: "x", limit: 101 }).success).toBe(false);
    expect(s.safeParse({ query: "x", limit: 0 }).success).toBe(false);
    expect(s.safeParse({ query: "x", limit: 1.5 }).success).toBe(false);
  });

  test("honors a custom cap", () => {
    const s = searchToolInputSchema(200);
    expect(s.safeParse({ query: "x", limit: 200 }).success).toBe(true);
    expect(s.safeParse({ query: "x", limit: 201 }).success).toBe(false);
  });

  test("exposes a .shape for tool registration", () => {
    expect(typeof searchToolInputSchema().shape).toBe("object");
  });
});

describe("matchesResult", () => {
  const filter = (rows: readonly unknown[], opts: { query: string; limit?: number }) =>
    rows.filter((r) => String(r).includes(opts.query)).slice(0, opts.limit ?? rows.length);

  test("filters array rows into a { matches } envelope", () => {
    const res = matchesResult(["apple", "banana", "grape"], filter, { query: "a" });
    expect(JSON.parse(res.content[0].text)).toEqual({ matches: ["apple", "banana", "grape"] });
  });

  test("non-array rows yield empty matches", () => {
    for (const bad of [null, undefined, {}, "str", 42] as unknown[]) {
      const res = matchesResult(bad, filter, { query: "a" });
      expect(JSON.parse(res.content[0].text)).toEqual({ matches: [] });
    }
  });

  test("passes query+limit through to the filter unchanged", () => {
    const seen: unknown[] = [];
    const spy = (rows: readonly unknown[], opts: { query: string; limit?: number }) => {
      seen.push(opts);
      return rows;
    };
    matchesResult([1, 2], spy, { query: "q", limit: 7 });
    expect(seen[0]).toEqual({ query: "q", limit: 7 });
  });

  test("returns a single text-part McpListResult", () => {
    const res = matchesResult([], filter, { query: "x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/mcp-connectors/shared/mcp-search-tool.test.ts`
Expected: FAIL — `Cannot find module './mcp-search-tool.ts'`.

- [ ] **Step 3: Write the helper**

Create `packages/mcp-connectors/shared/mcp-search-tool.ts`:

```ts
import { z } from "zod";
import { mcpJsonResult, type McpListResult, type ZodObjectSchema } from "./mcp-tool-kit.ts";
import type { SearchMatchOptions } from "./search-filter.ts";

/** A `makeQueryFilter(...)` result — the shape every connector search filter has. */
export type SearchFilter = (
  rows: readonly unknown[],
  opts: SearchMatchOptions,
) => readonly unknown[];

/**
 * Build the shared connector search input schema. `query` is always a non-empty
 * string; `maxLimit` is the per-connector cap (varies: 100/200/500/50/1000/2000)
 * and MUST be passed verbatim from each call site so behavior is unchanged.
 */
export function searchToolInputSchema(maxLimit = 100): ZodObjectSchema<SearchMatchOptions> {
  return z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(maxLimit).optional(),
  });
}

/**
 * Build the `{ matches }` envelope: filter the rows when they are an array, else
 * return an empty match set. Verbatim equivalent of the per-connector tail
 * `const matches = Array.isArray(X) ? filter(X, { query, limit }) : []; return jsonResult({ matches })`.
 * `rows` stays `unknown` because external payloads are untyped at the boundary
 * (Non-Negotiable #7).
 */
export function matchesResult(
  rows: unknown,
  filter: SearchFilter,
  opts: SearchMatchOptions,
): McpListResult {
  const matches = Array.isArray(rows) ? filter(rows, opts) : [];
  return mcpJsonResult({ matches });
}
```

> Note on the cast (empirically verified 2026-06-17 via a scoped tsc probe in this worktree): **no cast is needed.** `return z.object({...})` assigns directly to the declared `ZodObjectSchema<SearchMatchOptions>` return type. This is consistent with the existing connectors, which pass `z.object(...)` straight into `reg` (a `ZodObjectSchema<T>` parameter) with no cast — proving zod's `ZodError` is already assignable to the structural `{ error: { message: string } }`. Do NOT add `as unknown as ...` (it would erase type checking for no benefit, against Non-Negotiable #7). If a future zod bump ever breaks the direct assignment, escalate minimally: try a single `as ZodObjectSchema<SearchMatchOptions>` first, and only then `as unknown as`. Step 5's typecheck is the gate.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/mcp-connectors/shared/mcp-search-tool.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Typecheck + lint the new files**

Run: `bunx biome check packages/mcp-connectors/shared/mcp-search-tool.ts packages/mcp-connectors/shared/mcp-search-tool.test.ts`
Then typecheck. The `shared/` directory has **no tsconfig of its own** and is not under any connector's `include`, so at this point the helper is only type-checked transitively once a connector imports it (Task 2). For a fast standalone check now, run the scoped form (matches `tsconfig.base.json`'s settings, with node globals for the transitive `mcp-tool-kit.ts`):

```bash
bunx tsc --noEmit --strict --skipLibCheck --module preserve --moduleResolution bundler --allowImportingTsExtensions --types node packages/mcp-connectors/shared/mcp-search-tool.ts
```

Expected: no errors (no cast on the schema — see the note above). The authoritative full check is `bun run typecheck` in Task 8's preflight; Task 2's per-connector typecheck is the first place the helper is checked in-project.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-connectors/shared/mcp-search-tool.ts packages/mcp-connectors/shared/mcp-search-tool.test.ts
git commit -m "feat(dedup): add shared MCP search-tool scaffolding helpers

searchToolInputSchema(cap) + matchesResult(rows, filter, opts) collapse the
cloned connector search-tool schema and result envelope. Stage B1 of the jscpd
program."
```

---

## Task 2: Sweep core clique — batch A1 (schema + tail)

These have `extra=none` (schema collapse) AND the guarded tail (tail collapse) → apply **both** transforms.

**Files (each `packages/mcp-connectors/<conn>/src/server.ts`):**

| conn | cap | category | filter fn | apply |
| --- | --- | --- | --- | --- |
| zotero | 100 | root | filterZoteroItems | both |
| greenhouse | 100 | root | filterGreenhouseJobs | both |
| netlify | 100 | root | filterNetlifySites | both |
| intercom | 100 | keyed | filterIntercomConversations | both |
| lever | 100 | keyed | filterLeverPostings | both |
| mercury | 100 | keyed | filterMercuryAccounts | both |
| pipedrive | 100 | keyed | filterPipedriveDeals | both |
| raindrop | 100 | keyed | filterRaindropBookmarks | both |

- [ ] **Step 1: Apply both transforms** to each file above, per the Transformation Reference (schema collapse with the listed cap; tail collapse — `root` or `keyed` variant per the category). Update imports per the import rule.

- [ ] **Step 2: Verify tests stay green (unedited)**

Run: `bun test packages/mcp-connectors/zotero/ packages/mcp-connectors/greenhouse/ packages/mcp-connectors/netlify/ packages/mcp-connectors/intercom/ packages/mcp-connectors/lever/ packages/mcp-connectors/mercury/ packages/mcp-connectors/pipedrive/ packages/mcp-connectors/raindrop/`
Expected: all pass (skips OK), 0 fail. Confirm `git status` shows no `*.test.ts` modified.

- [ ] **Step 3: Typecheck + lint**

Run: `for c in <this batch's connectors, space-separated>; do bunx tsc --noEmit -p packages/mcp-connectors/$c/tsconfig.json || break; done` and `bunx biome check packages/mcp-connectors/{zotero,greenhouse,netlify,intercom,lever,mercury,pipedrive,raindrop}/src/server.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-connectors/{zotero,greenhouse,netlify,intercom,lever,mercury,pipedrive,raindrop}/src/server.ts
git commit -m "refactor(dedup): search-tool helpers — batch A1 (8 connectors)"
```

---

## Task 3: Sweep core clique — batch A2 (schema + tail)

Same as Task 2 — `extra=none` + guarded tail → apply **both**.

**Files:**

| conn | cap | category | filter fn | apply |
| --- | --- | --- | --- | --- |
| readwise | 100 | keyed | filterReadwiseHighlights | both |
| stackoverflow | 100 | keyed | filterStackOverflowQuestions | both |
| stripe | 100 | keyed | filterStripeInvoices | both |
| vercel | 100 | keyed | filterVercelDeployments | both |
| zendesk | 100 | keyed | filterZendeskTickets | both |
| ~~zoom~~ | — | — | — | **SKIPPED at execution** — `filterZoomMeetings` uses a custom `ZoomSearchOptions` type incompatible with the generic helper under `exactOptionalPropertyTypes` (no force-fit) |
| semgrep | 200 | keyed | filterSemgrepFindings | both |

- [ ] **Step 1: Apply both transforms** to each file per the Transformation Reference. Note `semgrep` cap is **200**. Update imports per the import rule.

- [ ] **Step 2: Verify tests stay green**

Run: `bun test packages/mcp-connectors/readwise/ packages/mcp-connectors/stackoverflow/ packages/mcp-connectors/stripe/ packages/mcp-connectors/vercel/ packages/mcp-connectors/zendesk/ packages/mcp-connectors/zoom/ packages/mcp-connectors/semgrep/`
Expected: all pass, 0 fail; no `*.test.ts` modified.

- [ ] **Step 3: Typecheck + lint**

Run: `for c in <this batch's connectors, space-separated>; do bunx tsc --noEmit -p packages/mcp-connectors/$c/tsconfig.json || break; done` and `bunx biome check packages/mcp-connectors/{readwise,stackoverflow,stripe,vercel,zendesk,zoom,semgrep}/src/server.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-connectors/{readwise,stackoverflow,stripe,vercel,zendesk,zoom,semgrep}/src/server.ts
git commit -m "refactor(dedup): search-tool helpers — batch A2 (7 connectors)"
```

---

## Task 4: Sweep fromHelper — batch B1 (schema only)

These are `extra=none` but use a `<x>From(root)` extractor with **no** `Array.isArray` guard (e.g. `filterAirflowDags(dagsFrom(root), {query, limit})`). Apply **schema collapse only** — do NOT touch the tail (no `matchesResult`; the tail is sub-threshold and changing it risks behavior).

**Files:**

| conn | cap | apply |
| --- | --- | --- |
| airflow | 100 | schema |
| argocd | 200 | schema |
| bigeye | 200 | schema |
| canva | 100 | schema |
| dagster | 2000 | schema |
| databricks | 100 | schema |
| dependencytrack | 100 | schema |
| figma | 200 | schema |

- [ ] **Step 1: Apply Transform 1 (schema collapse)** to each file with the listed cap. Do not modify the handler body. Update imports (add `searchToolInputSchema`; drop `z` only if unused elsewhere).

- [ ] **Step 2: Verify tests stay green**

Run: `bun test packages/mcp-connectors/airflow/ packages/mcp-connectors/argocd/ packages/mcp-connectors/bigeye/ packages/mcp-connectors/canva/ packages/mcp-connectors/dagster/ packages/mcp-connectors/databricks/ packages/mcp-connectors/dependencytrack/ packages/mcp-connectors/figma/`
Expected: all pass, 0 fail; no `*.test.ts` modified.

- [ ] **Step 3: Typecheck + lint**

Run: `for c in <this batch's connectors, space-separated>; do bunx tsc --noEmit -p packages/mcp-connectors/$c/tsconfig.json || break; done` and `bunx biome check packages/mcp-connectors/{airflow,argocd,bigeye,canva,dagster,databricks,dependencytrack,figma}/src/server.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-connectors/{airflow,argocd,bigeye,canva,dagster,databricks,dependencytrack,figma}/src/server.ts
git commit -m "refactor(dedup): search-tool schema helper — batch B1 (8 connectors)"
```

---

## Task 5: Sweep fromHelper — batch B2 (schema only)

Same as Task 4 — schema collapse only.

**Files:**

| conn | cap | apply |
| --- | --- | --- |
| hubspot | 100 | schema |
| looker | 200 | schema |
| metabase | 200 | schema |
| miro | 50 | schema |
| mlflow | 100 | schema |
| monte-carlo | 200 | schema |
| powerbi | 200 | schema |

- [ ] **Step 1: Apply Transform 1 (schema collapse)** to each. Note `miro` cap is **50**. Update imports.

- [ ] **Step 2: Verify tests stay green**

Run: `bun test packages/mcp-connectors/hubspot/ packages/mcp-connectors/looker/ packages/mcp-connectors/metabase/ packages/mcp-connectors/miro/ packages/mcp-connectors/mlflow/ packages/mcp-connectors/monte-carlo/ packages/mcp-connectors/powerbi/`
Expected: all pass, 0 fail; no `*.test.ts` modified.

- [ ] **Step 3: Typecheck + lint**

Run: `for c in <this batch's connectors, space-separated>; do bunx tsc --noEmit -p packages/mcp-connectors/$c/tsconfig.json || break; done` and `bunx biome check packages/mcp-connectors/{hubspot,looker,metabase,miro,mlflow,monte-carlo,powerbi}/src/server.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-connectors/{hubspot,looker,metabase,miro,mlflow,monte-carlo,powerbi}/src/server.ts
git commit -m "refactor(dedup): search-tool schema helper — batch B2 (7 connectors)"
```

---

## Task 6: Sweep fromHelper — batch B3 (schema only)

Same as Task 4 — schema collapse only.

**Files:**

| conn | cap | apply |
| --- | --- | --- |
| prefect | 100 | schema |
| ramp | 100 | schema |
| salesforce | 2000 | schema |
| snowflake | 200 | schema |
| superset | 200 | schema |
| tableau | 200 | schema |
| wiz | 200 | schema |

- [ ] **Step 1: Apply Transform 1 (schema collapse)** to each. Note `salesforce` cap is **2000**. Update imports.

- [ ] **Step 2: Verify tests stay green**

Run: `bun test packages/mcp-connectors/prefect/ packages/mcp-connectors/ramp/ packages/mcp-connectors/salesforce/ packages/mcp-connectors/snowflake/ packages/mcp-connectors/superset/ packages/mcp-connectors/tableau/ packages/mcp-connectors/wiz/`
Expected: all pass, 0 fail; no `*.test.ts` modified.

- [ ] **Step 3: Typecheck + lint**

Run: `for c in <this batch's connectors, space-separated>; do bunx tsc --noEmit -p packages/mcp-connectors/$c/tsconfig.json || break; done` and `bunx biome check packages/mcp-connectors/{prefect,ramp,salesforce,snowflake,superset,tableau,wiz}/src/server.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-connectors/{prefect,ramp,salesforce,snowflake,superset,tableau,wiz}/src/server.ts
git commit -m "refactor(dedup): search-tool schema helper — batch B3 (7 connectors)"
```

---

## Task 7: Sweep extra-field connectors — batch C (tail only)

These have an EXTRA required schema field (e.g. `appId`, `projectKey`, `orgId`) so the schema stays untouched, but the tail is the canonical guarded shape → apply **tail collapse only** (`matchesResult`). Category gives the `X`.

**Files:**

| conn | category | X (keep its extract line) | filter fn | apply |
| --- | --- | --- | --- | --- |
| mendeley | root | root | filterMendeleyDocuments | tail |
| bitrise | keyed | data | filterBitriseBuilds | tail |
| codemagic | keyed | builds | filterCodemagicBuilds | tail |
| firebase | keyed | releases | filterFirebaseReleases | tail |
| launchdarkly | keyed | flags (from `items`) | filterLaunchDarklyFlags | tail |
| testflight | keyed | data | filterTestflightBuilds | tail |
| snyk | keyed | issues | filterSnykAggregatedIssues | tail |
| sonarqube | keyed | issues | filterSonarIssues | tail |

- [ ] **Step 1: Apply Transform 2 (tail collapse) only** to each. Keep the full `z.object({ …extra…, query, limit })` schema unchanged. Keep the keyed extract line (`const <X> = (root as {…})?.<key>;`) unchanged; replace only the `const matches = Array.isArray(<X>) ? … : []; return jsonResult({ matches });` with `return matchesResult(<X>, <filterFn>, p);`. For `mendeley` (root), `X = root`. Add only the `matchesResult` import; drop `jsonResult`/`z` only if unused elsewhere in the file.

- [ ] **Step 2: Verify tests stay green**

Run: `bun test packages/mcp-connectors/mendeley/ packages/mcp-connectors/bitrise/ packages/mcp-connectors/codemagic/ packages/mcp-connectors/firebase/ packages/mcp-connectors/launchdarkly/ packages/mcp-connectors/testflight/ packages/mcp-connectors/snyk/ packages/mcp-connectors/sonarqube/`
Expected: all pass, 0 fail; no `*.test.ts` modified.

- [ ] **Step 3: Typecheck + lint**

Run: `for c in <this batch's connectors, space-separated>; do bunx tsc --noEmit -p packages/mcp-connectors/$c/tsconfig.json || break; done` and `bunx biome check packages/mcp-connectors/{mendeley,bitrise,codemagic,firebase,launchdarkly,testflight,snyk,sonarqube}/src/server.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-connectors/{mendeley,bitrise,codemagic,firebase,launchdarkly,testflight,snyk,sonarqube}/src/server.ts
git commit -m "refactor(dedup): search-tool tail helper — batch C (8 extra-field connectors)"
```

---

## Task 8: Measure, full verification, finalize

**Files:** none (verification + measurement only).

- [ ] **Step 1: Re-measure strict jscpd**

Run: `bunx jscpd packages 2>&1 | tail -6`
Record the `Total:` strict % (baseline 4.98%). Expect a strict drop. (Non-zero exit while still > 3% is expected — the program isn't done; this PR does not tighten the gate.)

- [ ] **Step 2: Confirm the search clique collapsed**

Run: `bunx jscpd packages --reporters json --output /tmp/jscpd-b1 2>&1 | tail -1` then inspect `zotero/src/server.ts` clone count (was 21). Confirm it dropped materially (search-tool fragment gone). Quick check:

```bash
bun -e 'const r=require("fs").readFileSync("/tmp/jscpd-b1/jscpd-report.json","utf8");const j=JSON.parse(r);let n=0;for(const d of j.duplicates){if(JSON.stringify(d).includes("zotero/src/server.ts"))n++;}console.log("zotero/server.ts clones:",n)'
```

- [ ] **Step 3: Full mcp-connectors test suite**

Run: `bun test packages/mcp-connectors/ 2>&1 | tail -8`
Expected: all pass (skips OK), 0 fail. Confirm `git status` shows no `*.test.ts` modified across the whole sweep.

- [ ] **Step 4: Full preflight (CI parity — required before first push)**

Run: `bun run preflight`
Expected: green (tsc all packages, lint, lint:markdown, structure audits, tests). Fix any failure locally before pushing. (Note: the strict `audit:duplication` gate inside structure audits may still be red while > 3% — that gate is the program's target, not tightened here; confirm the run's other gates pass and the duplication % improved vs. baseline.)

- [ ] **Step 5: Docs gates (a `.md` — the spec + plan — is in this branch)**

Run: `bunx markdownlint-cli2 "docs/superpowers/specs/2026-06-17-jscpd-stage-b1-search-tool-scaffolding-design.md" "docs/superpowers/plans/2026-06-17-jscpd-stage-b1-search-tool-scaffolding.md"`
Then: `~/.cargo/bin/lychee --config lychee.toml --no-progress "docs/superpowers/specs/2026-06-17-jscpd-stage-b1-search-tool-scaffolding-design.md" "docs/superpowers/plans/2026-06-17-jscpd-stage-b1-search-tool-scaffolding.md"`
Expected: 0 errors each. **Do NOT commit any `*-review.md` scratch file** (untracked review companions break lychee/markdownlint).

- [ ] **Step 6: Whole-branch review + push**

Run a `/code-review` (or code-reviewer subagent) over `git diff main...HEAD`; fold in findings. Then push the branch and open the PR. PR description records: strict 4.98% → <after>%; helpers added to `mcp-connectors/shared/`; N connectors swept; 3 skipped (dbt/flagsmith/flux); CI lenient gate untightened.

- [ ] **Step 7: Update memory**

Append the Stage B1 outcome to `jscpd-dedup-stage-a.md` (or a new `jscpd-dedup-stage-b1.md`) and the `MEMORY.md` index line: PR #, strict delta, helper names, the shared/-not-SDK decision, and that the named-A2 nine were deprioritized after re-measurement.

---

## Self-Review (completed by plan author)

- **Spec coverage:** helper file + both helpers (Task 1) ✓; schema-collapse sweep across all `extra=none` connectors (Tasks 2–6) ✓; tail-collapse across guarded connectors incl. extra-field (Tasks 2,3,7) ✓; outliers skipped (dbt/flagsmith/flux, stated in Global Constraints + by omission) ✓; `shared/` not SDK ✓; unit test for the helper (Task 1) ✓; measurement + preflight + docs gates (Task 8) ✓; CI lenient gate untightened ✓.
- **Placeholder scan:** no TBD/TODO; all transforms shown as concrete before/after code; all test code complete; every connector has cap + category + filter listed.
- **Type consistency:** `searchToolInputSchema`/`matchesResult`/`SearchFilter`/`SearchMatchOptions`/`McpListResult`/`ZodObjectSchema` names consistent across Task 1 and the reference; `safeParse` (not `.parse`) used in tests to match `ZodObjectSchema`'s structural type.
- **Coverage note:** 45 connectors swept (15 both, 22 schema-only, 8 tail-only); 3 skipped; 48 total search tools accounted for.
