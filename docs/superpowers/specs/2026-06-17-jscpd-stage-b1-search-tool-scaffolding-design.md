# Design — jscpd Stage B1: MCP search-tool scaffolding → `mcp-connectors/shared/`

**Date:** 2026-06-17
**Branch:** `worktree-jscpd-dedup-a2` (worktree off `origin/main` @ `8f346bac`)
**Status:** approved design → ready for implementation plan
**Parent program:** [`2026-06-17-jscpd-duplication-reduction-design.md`](./2026-06-17-jscpd-duplication-reduction-design.md)

## Context

The jscpd duplication-reduction program drives the **strict** duplication
(`bunx jscpd packages`, reading `.jscpd.json`: `min-lines 5 / min-tokens 50 /
threshold 3`) under 3% by extracting shared scaffolding into helpers — never by
adding jscpd ignores to handwritten source. Stage A (PR #673, merged `8c3bbb35`)
extracted the gateway single-pass paginated-sync helper and migrated 20
connectors; strict dropped 5.51% → 5.09%.

**Re-measurement on current main (`8f346bac`, this worktree):** strict is
**4.98%** (637 clones). This re-measurement changed the program's leverage map:

- The originally-named "Stage A2" nine multi-resource HTTP syncs
  (databricks/dbt/flagsmith/launchdarkly/mendeley/ramp/semgrep/sonarqube/wiz) are
  now **low-leverage** — 2–6 scattered clones each, no longer a tight clique
  (they clone against the new sync centroids, not each other). Deferred.
- The single highest-leverage cluster is the **MCP `server.ts` family**: 313
  clone-involvements (~25% of all 1274 side-involvements), led by outlook (27),
  zotero (21), gmail (18), gitlab (17), github (15). This is Stage B of the
  program.

Stage B is multi-pattern. Full Stage B moves strict only ~1–1.3pt (still > 3%),
so the program continues after it regardless of how B is sliced. This spec scopes
the **first, lowest-risk, Stage-A-shaped** slice: **B1 — the search-tool
scaffolding sweep**.

## Two corrections to the parent design (Stage B section)

Verified against the code in this worktree:

1. **Target `mcp-connectors/shared/`, NOT `@nimbus-dev/sdk`.** The parent design
   proposed hoisting MCP scaffolding to a new `@nimbus-dev/sdk/mcp` subpath. But
   the established precedent for code shared *among mcp-connectors* is the
   relative-imported `packages/mcp-connectors/shared/` directory — it already
   holds 19 helper files (`mcp-tool-kit.ts`, `fetch-bearer-json.ts`,
   `search-filter.ts`, `run-read-only-mcp-connector.ts`, `safe-cli-arg.ts`,
   `imap-mail-core.ts`, …), each with a co-located `*.test.ts`. The SDK precedent
   (channel-resolver, cross-boundary signer) was for code shared between
   *different packages* (installer/gateway); that does not apply here. Using
   `shared/` avoids a new SDK export, a dependency-cruiser change, and the
   coverage-floor ratchet (which covers gateway/cli/sdk/client, not
   mcp-connectors).

2. **MCP stdio bootstrap is already deduped.** The parent design listed
   "tool-registration scaffolding (`new McpServer` → register → connect)" as a
   target. That bootstrap already lives in
   `shared/run-read-only-mcp-connector.ts` (`runReadOnlyMcpConnector(name, reg =>
   …)`). The residual `server.ts` clones are *per-tool handler bodies*, not
   bootstrap. B1 targets the most uniform of those: the **search tool**.

## Problem (B1-specific)

Across ~48 read-only connectors, the search tool repeats two near-identical
fragments that jscpd flags as a large clone clique (zotero `server.ts` is its
centroid with 21 clones, every one the search-tool fragment cloned against a
different partner):

1. **The input schema** (universal `query`, per-connector `limit` cap):

   ```ts
   z.object({
     query: z.string().min(1),
     limit: z.number().int().min(1).max(100).optional(),
   })
   ```

2. **The result envelope tail**:

   ```ts
   const matches = Array.isArray(X)
     ? filterX(X, { query: p.query, limit: p.limit })
     : [];
   return jsonResult({ matches });
   ```

   where `X` is either `root` directly (zotero-style) or a keyed sub-array
   (`(root as { tickets?: unknown[] } | null)?.tickets`, zendesk-style).

**Measured uniformity (this worktree):**

- `query: z.string().min(1)` — 52 occurrences, **invariant**.
- `limit: …max(N).optional()` caps **vary**: max 100 (×36), 200 (×28), 500
  (×18), 50 (×6), 2000 (×4), 1000 (×1). The helper MUST parameterize the cap to
  preserve each connector's exact behavior.
- `jsonResult({ matches })` — 48 connector `server.ts` files.
- The `Array.isArray(X) ? filter : []` guard appears in the majority; a few
  connectors (e.g. hubspot) skip the guard (`filterX(dealsFrom(root), …)`) — those
  are outliers, not swept.

## Goal

Collapse the two shared fragments into small pure helpers in
`mcp-connectors/shared/`, then mechanically migrate every connector whose search
tool matches the canonical shape — so the per-connector search tool drops below
the 5-line / 50-token clone threshold and the zotero-centroid clique collapses.

**Non-goals / constraints:**

- **Pure dedup — zero behavior change.** Every connector's
  `*-fake-server.test.ts` (and any other per-connector test) stays green
  **unedited**. Each connector's exact `limit` cap and `query.min(1)` are
  preserved.
- **No force-fit.** Connectors whose search tool has extra schema fields, no
  `Array.isArray` guard, a non-`{matches}` envelope, or a non-`{query, limit}`
  shape are left untouched. Migrate only exact matches.
- **Do not touch** other tool handlers (list/get), other stages' targets, the CI
  lenient duplication gate (tightening is the program's final stage), or
  perf surfaces.
- **Scope to B1.** The email-family twin (imap/protonmail `server.ts` +
  `tools.ts`) and the github/gitlab/Graph per-tool REST blocks are deferred to
  later Stage-B slices.

## Design

### New file: `packages/mcp-connectors/shared/mcp-search-tool.ts`

Two pure, tree-shakeable helpers. Imports `z` (zod), `mcpJsonResult` /
`McpListResult` / `ZodObjectSchema` from `./mcp-tool-kit.ts`, and the existing
`SearchMatchOptions` type from `./search-filter.ts` (no circular dependency —
neither imported file imports this one).

The connector filters are all `makeQueryFilter(...)` results from
`shared/search-filter.ts`, with the exact type
`(items: readonly unknown[], options: SearchMatchOptions) => unknown[]` and
`SearchMatchOptions = { readonly query: string; readonly limit?: number | undefined }`.
The helper reuses that type so every connector's filter assigns without a cast
and the `readonly`-array variance trap is avoided.

```ts
import { z } from "zod";
import { mcpJsonResult, type McpListResult, type ZodObjectSchema } from "./mcp-tool-kit.ts";
import type { SearchMatchOptions } from "./search-filter.ts";

/** A `makeQueryFilter(...)` result: the shape every connector search filter has. */
export type SearchFilter = (
  rows: readonly unknown[],
  opts: SearchMatchOptions,
) => readonly unknown[];

/**
 * Build the shared search input schema. `query` is always a non-empty string;
 * `maxLimit` is the per-connector cap (varies: 100/200/500/50/1000/2000) and is
 * preserved verbatim per call site so behavior is unchanged.
 */
export function searchToolInputSchema(maxLimit = 100): ZodObjectSchema<SearchMatchOptions> {
  return z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(maxLimit).optional(),
  }) as ZodObjectSchema<SearchMatchOptions>;
}

/**
 * Build the `{ matches }` envelope: filter the rows when they are an array, else
 * return an empty match set. Mirrors the per-connector tail
 * `const matches = Array.isArray(X) ? filter(X, { query, limit }) : []; return jsonResult({ matches })`
 * verbatim. `rows` is the already-extracted candidate array (`root`, or a keyed
 * sub-array the caller pulled out) — kept as `unknown` because external payloads
 * are untyped at the boundary (Non-Negotiable #7: no `any`).
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

(`ZodObjectSchema<T>` is the structural schema type already exported by
`mcp-tool-kit.ts` and consumed by `ZodToolRegistrar`. The `as` cast bridges
zod's inferred type to that structural type, matching how the existing tool-kit
already types schemas. The exact cast/return-type wiring is a plan detail —
verified against `mcp-tool-kit.ts` and `run-read-only-mcp-connector.ts` during
planning; if zod's inferred type assigns directly, the cast is dropped. The
handler arg `p` is `SearchMatchOptions`, passed straight into `matchesResult`.)

### Per-connector migration (mechanical)

Root-is-array case (zotero-style):

```ts
// before
reg(
  "zotero_search",
  "…description…",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const root = await zoteroGet(`…`);
    const matches = Array.isArray(root)
      ? filterZoteroItems(root, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

// after
reg(
  "zotero_search",
  "…description…",
  searchToolInputSchema(100),
  async (p) => matchesResult(await zoteroGet(`…`), filterZoteroItems, p),
);
```

Keyed-sub-array case (zendesk-style): the unique extraction line stays inline (it
is per-connector and below the clone threshold), only the tail collapses:

```ts
async (p) => {
  const root = await zendeskGet(`/api/v2/tickets.json?page[size]=100`);
  return matchesResult((root as { tickets?: unknown[] } | null)?.tickets, filterZendeskTickets, p);
}
```

`z` import is dropped from a connector's `server.ts` only if no other tool in
that file still uses it (most files keep `z` for other tools). The
`mcpJsonResult`/`jsonResult` import is dropped only if no other tool uses it.

### Why this kills the clone

The cloned fragment is the contiguous schema (3 lines) + handler tail (3 lines).
Replacing the schema with `searchToolInputSchema(N)` (1 line) and the tail with
`matchesResult(...)` (1 line) shrinks each connector's search tool to 2–4 unique
lines (name, description, fetch URL, optional keyed-extract) — below the 5-line /
50-token threshold. The `searchToolInputSchema(N)` and `matchesResult(...)` call
sites differ per connector (cap, fetch fn, filter fn, key) and are single lines,
so they do not form a new clone clique.

### Testing

- **New helper unit test** `mcp-connectors/shared/mcp-search-tool.test.ts`
  (the `shared/` convention; feeds the "Coverage — MCP" CI gate):
  - `searchToolInputSchema()`: parses `{ query }`, `{ query, limit }`; rejects
    empty query; rejects `limit` over the cap / below 1 / non-integer; honors a
    custom `maxLimit`.
  - `matchesResult()`: array rows → filter applied + `{ matches }` envelope;
    non-array rows (null/undefined/object) → empty `matches`; passes
    `{ query, limit }` through to the filter unchanged; returns a valid
    `McpListResult` (single text part containing the JSON).
- **Per-connector guardrails:** every migrated connector's existing
  `*-fake-server.test.ts` MUST pass unedited — this is the behavior-fidelity
  proof. Run the full `mcp-connectors` test suite after each batch.

### Measurement protocol

- Re-run `bunx jscpd packages`; record `Total:` strict % before (4.98%) → after
  in the PR description.
- Regenerate the report and confirm the zotero-centroid search clique collapsed
  (zotero `server.ts` clone count drops from 21).
- Note the CI lenient gate stays untightened (final program stage).

## Risks & mitigations

- **`limit`-cap fidelity.** The #1 behavior-change risk. Each call site must pass
  the connector's *current* cap. Mitigation: per-connector audit reads the exact
  `max(N)` before editing; the fake-server tests catch a wrong cap if a test
  exercises the boundary.
- **Coverage — MCP gate.** New `shared/` file needs ≥ the MCP coverage threshold.
  The unit test plus all migrating connectors exercising the helper cover it.
  (Coverage-floor ratchet does not apply — it skips mcp-connectors.)
- **Typing (no `any`).** Helper is generic/structural; external payloads stay
  `unknown` at the boundary, exactly as the connectors already do.
- **Outlier misclassification.** A connector that *looks* like the canonical
  shape but differs (extra field, different guard) must be skipped, not
  force-fit. Mitigation: the migration is gated on an exact-shape match and the
  unedited fake-server test.
- **Import cleanup.** Removing a now-unused `z` / `jsonResult` import while
  another tool still uses it would break typecheck/lint. Mitigation: drop an
  import only after confirming no other use in the file (Biome `noUnusedImports`
  and tsc catch mistakes in preflight).

## Success criteria

1. `mcp-search-tool.ts` + test added under `mcp-connectors/shared/`; helper
   covered to the MCP gate.
2. Every canonical-shape connector search tool migrated; the zotero search clique
   collapsed (zotero `server.ts` clone count drops materially).
3. `bunx jscpd packages` strict % strictly below 4.98% (record exact delta).
4. All `mcp-connectors` tests green with **no** `*-fake-server.test.ts` edited.
5. Full `bun run preflight` + (docs gates if any `.md` changed) green before the
   first push. No behavior change; no new jscpd ignores; CI lenient gate
   untightened.
