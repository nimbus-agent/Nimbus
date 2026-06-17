# jscpd Dedup — Stage A: Gateway Paginated-Sync Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated single-pass paginated connector-sync scaffolding into a shared `_lib/paginated-sync.ts` helper (`upsertMapped` + `runSinglePassPaginatedSync` + `bareArrayPage`) and migrate the 21 Tier-1 paginated-family connectors to delegate to it — pure dedup, zero behavior change — driving strict jscpd down.

**Architecture:** A new gateway-internal helper owns the parts of every single-pass paginated `sync()` that are byte-identical across connectors: the `performance.now()` timing, the noop-on-unconfigured-creds, the `for`-page loop with first-page `http_error`/`parse_error` degradation, the per-item map+upsert loop, and the pass-1-cursor success return. Each connector keeps only what genuinely varies (constants, creds, per-page path/auth, response parsing, mapping fn) and calls the helper from a thin `createXSyncable`. Behavior is preserved exactly; each connector's existing `*-sync-fake-server.test.ts` integration test is the guardrail.

**Tech Stack:** Bun v1.2+, TypeScript 6 strict, `bun test`, jscpd, the existing `_lib/fetch-outcome.ts` / `sync/pass-cursor-sync-result.ts` / `sync/types.ts` / `index/item-store.ts`.

## Global Constraints

- **No behavior change.** Pure dedup/extraction. Every connector's `*-sync-fake-server.test.ts` must stay green with **no edits to the test**. (A test edit is a signal the refactor changed behavior — stop and reconsider.)
- **No `any`** (Non-Negotiable #7). External API payloads stay `unknown` at the boundary, exactly as the current `extract*(parsed: unknown)` / `mapXToItem(raw: unknown)` do. Generics only where there is real type info (the creds type `C`).
- **Coverage floor ≥80% line+branch per file** (`audit:coverage-floor`, CI-Linux-authoritative). The new `paginated-sync.ts` starts at baseline `{}` and must hit ≥80% immediately — its own unit tests (Tasks 1–2) guarantee this independent of connector tests.
- **Do NOT touch `packages/gateway/src/perf/**`** (PR #666) or anything perf-related.
- **Dependency rules:** this helper is gateway-internal (`packages/gateway/src/connectors/_lib/`). Do not move it to sdk/client. It imports only from within gateway.
- **Measure with the failing gate:** strict = `bunx jscpd packages` → read the `Total:` row %. Anchored baseline @ `origin/main` `5993765b`: strict **5.51%** (711 clones).
- **Commit frequently** — one commit per task (helper, each exemplar, the batch, the measurement). Branch: `worktree-jscpd-dedup`.
- **Ship-readiness:** full `bun run preflight` + Docker-Linux `audit:coverage-floor` + whole-branch `/code-review` BEFORE the first push (Task 7).

## File Structure

- **Create** `packages/gateway/src/connectors/_lib/paginated-sync.ts` — the shared helper: `upsertMapped`, `runSinglePassPaginatedSync`, `bareArrayPage`, and the `PaginatedSyncSpec<C>` interface. One responsibility: run a single-pass paginated sync and upsert mapped items.
- **Create** `packages/gateway/src/connectors/_lib/paginated-sync.test.ts` — co-located unit tests for the helper (real in-memory `bun:sqlite` DB, fake `FetchOutcome` sequences).
- **Modify** 21 connector files under `packages/gateway/src/connectors/*-sync.ts` (Tier-1 list in Task 6) — replace the duplicated `sync()` body + `upsert*`/`extract*` helpers with a `runSinglePassPaginatedSync(...)` call.
- **Do NOT modify** any `*-sync-fake-server.test.ts` (guardrails) or any `*-mapping.ts` (mapping logic unchanged).

The 9 larger Tier-2 paginated connectors (databricks, dbt, flagsmith, launchdarkly, mendeley, ramp, semgrep, sonarqube, wiz) are **deferred to a separate Stage A2 plan** — they have extra per-file structure (multiple resource types) that needs individual judgment. This plan = PR1.

---

### Task 1: `upsertMapped` helper + tests

**Files:**

- Create: `packages/gateway/src/connectors/_lib/paginated-sync.ts`
- Test: `packages/gateway/src/connectors/_lib/paginated-sync.test.ts`

**Interfaces:**

- Consumes: `upsertIndexedItemForSync(ctx, row)` from `../../index/item-store.ts`; `SyncContext` from `../../sync/types.ts`.
- Produces: `upsertMapped(ctx: SyncContext, items: readonly unknown[], map: (raw: unknown) => SyncUpsertRow | null): number` where `SyncUpsertRow = Parameters<typeof upsertIndexedItemForSync>[1]`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/_lib/paginated-sync.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { LocalIndex } from "../../index/local-index.ts";
import { ProviderRateLimiter } from "../../sync/rate-limiter.ts";
import type { SyncContext } from "../../sync/types.ts";
import { createMockVault } from "../../vault/mock.ts";
import { upsertMapped } from "./paginated-sync.ts";

function makeCtx(): { ctx: SyncContext; db: Database; cleanup: () => void } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const ctx = {
    vault: createMockVault(),
    db,
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter({}),
  } as unknown as SyncContext;
  return { ctx, db, cleanup: () => db.close() };
}

function row(externalId: string) {
  return {
    service: "demo",
    type: "reference" as const,
    externalId,
    title: `Item ${externalId}`,
  };
}

describe("upsertMapped", () => {
  let h: ReturnType<typeof makeCtx> | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("maps + upserts non-null rows and counts them; skips nulls", () => {
    h = makeCtx();
    const raw = [{ id: "1" }, { id: "skip" }, { id: "2" }];
    const count = upsertMapped(h.ctx, raw, (r) => {
      const id = (r as { id: string }).id;
      return id === "skip" ? null : row(id);
    });
    expect(count).toBe(2);
    const ids = h.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'demo' ORDER BY external_id",
      )
      .all()
      .map((x) => x.external_id);
    expect(ids).toEqual(["1", "2"]);
  });

  test("empty input → 0, no rows", () => {
    h = makeCtx();
    expect(upsertMapped(h.ctx, [], () => row("x"))).toBe(0);
    const n = h.db.query<{ c: number }, []>("SELECT COUNT(*) c FROM item").get();
    expect(n?.c).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/_lib/paginated-sync.test.ts`
Expected: FAIL — `Cannot find module './paginated-sync.ts'` / `upsertMapped is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/connectors/_lib/paginated-sync.ts`:

```ts
import { upsertIndexedItemForSync } from "../../index/item-store.ts";
import type { SyncContext } from "../../sync/types.ts";

/** The row shape accepted by {@link upsertIndexedItemForSync}. */
export type SyncUpsertRow = Parameters<typeof upsertIndexedItemForSync>[1];

/**
 * Map each raw item and upsert the non-null results, returning the count
 * upserted. Mirrors the per-connector `upsert*` loop verbatim.
 */
export function upsertMapped(
  ctx: SyncContext,
  items: readonly unknown[],
  map: (raw: unknown) => SyncUpsertRow | null,
): number {
  let upserted = 0;
  for (const raw of items) {
    const mapped = map(raw);
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/_lib/paginated-sync.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/_lib/paginated-sync.ts packages/gateway/src/connectors/_lib/paginated-sync.test.ts
git commit -m "feat(dedup): add upsertMapped sync helper (Stage A)"
```

---

### Task 2: `runSinglePassPaginatedSync` + `bareArrayPage` + tests

**Files:**

- Modify: `packages/gateway/src/connectors/_lib/paginated-sync.ts`
- Test: `packages/gateway/src/connectors/_lib/paginated-sync.test.ts`

**Interfaces:**

- Consumes: `FetchOutcome` from `./fetch-outcome.ts`; `syncPassCursorHttpEmpty`, `syncPassCursorParseEmpty`, `syncPassCursorSuccess` from `../../sync/pass-cursor-sync-result.ts`; `SyncResult`, `syncNoopResult` from `../../sync/types.ts`; `upsertMapped` (Task 1).
- Produces:
  - `interface PaginatedSyncSpec<C>` with fields: `ensureRunning: () => Promise<void>`, `loadCreds: () => Promise<C | null>`, `pass1Cursor: () => string`, `maxPages: number`, `startPage?: number` (default 1), `fetchPage: (creds: C, page: number) => Promise<FetchOutcome>`, `parsePage: (parsed: unknown, page: number) => { items: readonly unknown[]; hasMore: boolean }`, `map: (raw: unknown, now: number) => SyncUpsertRow | null`.
  - `runSinglePassPaginatedSync<C>(ctx: SyncContext, cursor: string | null, spec: PaginatedSyncSpec<C>): Promise<SyncResult>`.
  - `bareArrayPage(parsed: unknown, pageSize: number): { items: unknown[]; hasMore: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/connectors/_lib/paginated-sync.test.ts`:

```ts
import type { FetchOutcome } from "./fetch-outcome.ts";
import {
  bareArrayPage,
  type PaginatedSyncSpec,
  runSinglePassPaginatedSync,
} from "./paginated-sync.ts";

const ok = (parsed: unknown, bytes = 10): FetchOutcome => ({ kind: "ok", parsed, bytes });
const httpErr = (bytes = 3): FetchOutcome => ({ kind: "http_error", bytes, status: 503 });
const parseErr = (bytes = 3): FetchOutcome => ({ kind: "parse_error", bytes });

function baseSpec(over: Partial<PaginatedSyncSpec<{ ok: true }>>): PaginatedSyncSpec<{ ok: true }> {
  return {
    ensureRunning: async () => {},
    loadCreds: async () => ({ ok: true }),
    pass1Cursor: () => "nimbus-demo1:abc",
    maxPages: 20,
    startPage: 1,
    fetchPage: async () => ok([]),
    parsePage: (parsed) => bareArrayPage(parsed, 2),
    map: (raw) => row((raw as { id: string }).id),
    ...over,
  };
}

describe("bareArrayPage", () => {
  test("non-array → empty, no more", () => {
    expect(bareArrayPage({ not: "array" }, 2)).toEqual({ items: [], hasMore: false });
  });
  test("full page (length >= pageSize) → hasMore true", () => {
    expect(bareArrayPage([{ id: "1" }, { id: "2" }], 2)).toEqual({
      items: [{ id: "1" }, { id: "2" }],
      hasMore: true,
    });
  });
  test("short page → hasMore false", () => {
    expect(bareArrayPage([{ id: "1" }], 2).hasMore).toBe(false);
  });
});

describe("runSinglePassPaginatedSync", () => {
  let h: ReturnType<typeof makeCtx> | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("unconfigured creds → noop, incoming cursor preserved, no fetch", async () => {
    h = makeCtx();
    let fetched = 0;
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      "incoming-cursor",
      baseSpec({
        loadCreds: async () => null,
        fetchPage: async () => {
          fetched += 1;
          return ok([]);
        },
      }),
    );
    expect(fetched).toBe(0);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("incoming-cursor");
  });

  test("happy multi-page walk: stops on short page, accumulates bytes + upserts", async () => {
    h = makeCtx();
    const pages: FetchOutcome[] = [
      ok([{ id: "a" }, { id: "b" }], 100),
      ok([{ id: "c" }], 40),
    ];
    let i = 0;
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      null,
      baseSpec({ fetchPage: async () => pages[i++] ?? ok([]) }),
    );
    expect(res.itemsUpserted).toBe(3);
    expect(res.bytesTransferred).toBe(140);
    expect(res.cursor).toBe("nimbus-demo1:abc");
    expect(res.hasMore).toBe(false);
  });

  test("first-page http_error → http-empty result with incoming cursor", async () => {
    h = makeCtx();
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      "keep-me",
      baseSpec({ fetchPage: async () => httpErr(7) }),
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("keep-me");
    expect(res.bytesTransferred).toBe(7);
  });

  test("first-page parse_error → parse-empty result with default cursor", async () => {
    h = makeCtx();
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      "ignored",
      baseSpec({ fetchPage: async () => parseErr(5) }),
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("nimbus-demo1:abc");
  });

  test("error on a non-first page → break, success with items so far", async () => {
    h = makeCtx();
    const pages: FetchOutcome[] = [ok([{ id: "a" }, { id: "b" }], 50), httpErr(4)];
    let i = 0;
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      null,
      baseSpec({ fetchPage: async () => pages[i++] ?? ok([]) }),
    );
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe("nimbus-demo1:abc");
    expect(res.bytesTransferred).toBe(54);
  });

  test("maxPages caps the walk", async () => {
    h = makeCtx();
    let fetched = 0;
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      null,
      baseSpec({
        maxPages: 3,
        // always a full page → would loop forever without the cap
        fetchPage: async () => {
          fetched += 1;
          return ok([{ id: `x${fetched}` }, { id: `y${fetched}` }], 10);
        },
      }),
    );
    expect(fetched).toBe(3);
    expect(res.itemsUpserted).toBe(6);
  });

  test("startPage 0 passes 0-based page numbers to fetchPage", async () => {
    h = makeCtx();
    const seen: number[] = [];
    await runSinglePassPaginatedSync(
      h.ctx,
      null,
      baseSpec({
        startPage: 0,
        maxPages: 2,
        fetchPage: async (_creds, page) => {
          seen.push(page);
          return ok([]); // empty → stop after first
        },
      }),
    );
    expect(seen).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/connectors/_lib/paginated-sync.test.ts`
Expected: FAIL — `runSinglePassPaginatedSync`/`bareArrayPage` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/gateway/src/connectors/_lib/paginated-sync.ts`:

```ts
import type { FetchOutcome } from "./fetch-outcome.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../../sync/pass-cursor-sync-result.ts";
import { type SyncResult, syncNoopResult } from "../../sync/types.ts";
```

(Merge the `../../sync/types.ts` import with the existing `SyncContext` import line so there is one import per module — final form: `import { type SyncContext, type SyncResult, syncNoopResult } from "../../sync/types.ts";`.)

```ts
/** A page's parsed items plus whether to fetch the next page. */
export interface ParsedPage {
  readonly items: readonly unknown[];
  readonly hasMore: boolean;
}

/** Bare-array page parser: items are the JSON array; another page exists iff the page was full. */
export function bareArrayPage(parsed: unknown, pageSize: number): { items: unknown[]; hasMore: boolean } {
  const items = Array.isArray(parsed) ? parsed : [];
  return { items, hasMore: items.length >= pageSize };
}

export interface PaginatedSyncSpec<C> {
  /** Start the connector's MCP process if needed (called before credential load). */
  readonly ensureRunning: () => Promise<void>;
  /** Load credentials, or null when unconfigured (→ noop). */
  readonly loadCreds: () => Promise<C | null>;
  /** The pass-1 cursor string persisted on every terminal result. */
  readonly pass1Cursor: () => string;
  /** Maximum number of page fetches. */
  readonly maxPages: number;
  /** First page number (default 1). */
  readonly startPage?: number;
  /** Fetch one page. */
  readonly fetchPage: (creds: C, page: number) => Promise<FetchOutcome>;
  /** Parse a successful page into items + whether more pages follow. */
  readonly parsePage: (parsed: unknown, page: number) => ParsedPage;
  /** Map one raw item to an upsert row, or null to skip. */
  readonly map: (raw: unknown, now: number) => SyncUpsertRow | null;
}

/**
 * Run a single-pass paginated sync: ensure-running → load creds (noop if
 * unconfigured) → walk pages (first-page error degrades to an empty pass-cursor
 * result; later-page error breaks) → upsert mapped items → pass-1 success.
 * Behaviour-identical to the hand-written single-pass connector `sync()` bodies.
 */
export async function runSinglePassPaginatedSync<C>(
  ctx: SyncContext,
  cursor: string | null,
  spec: PaginatedSyncSpec<C>,
): Promise<SyncResult> {
  const t0 = performance.now();
  await spec.ensureRunning();
  const creds = await spec.loadCreds();
  if (creds === null) {
    return syncNoopResult(cursor, t0);
  }

  const now = Date.now();
  const startPage = spec.startPage ?? 1;
  let totalBytes = 0;
  let totalUpserted = 0;

  for (let i = 0; i < spec.maxPages; i += 1) {
    const page = startPage + i;
    const outcome = await spec.fetchPage(creds, page);
    totalBytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      if (i === 0) {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, spec.pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, spec.pass1Cursor());
      }
      break;
    }

    const { items, hasMore } = spec.parsePage(outcome.parsed, page);
    totalUpserted += upsertMapped(ctx, items, (raw) => spec.map(raw, now));
    if (!hasMore) {
      break;
    }
  }

  return syncPassCursorSuccess(t0, totalBytes, spec.pass1Cursor(), totalUpserted);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/connectors/_lib/paginated-sync.test.ts`
Expected: PASS (all `upsertMapped` + `bareArrayPage` + `runSinglePassPaginatedSync` tests).

- [ ] **Step 5: Typecheck the helper**

Run: `cd packages/gateway && bunx tsc --noEmit` (from repo root: `bun run --filter @nimbus-dev/gateway typecheck` if defined; otherwise the per-package tsc).
Expected: no errors in `paginated-sync.ts`. (No `any`; `SyncUpsertRow` resolves via `Parameters<>`.)

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/connectors/_lib/paginated-sync.ts packages/gateway/src/connectors/_lib/paginated-sync.test.ts
git commit -m "feat(dedup): add runSinglePassPaginatedSync + bareArrayPage (Stage A)"
```

---

### Task 3: Migrate `greenhouse-sync.ts` — bare-array exemplar

**Files:**

- Modify: `packages/gateway/src/connectors/greenhouse-sync.ts`
- Guardrail (do NOT edit): `packages/gateway/test/integration/connectors/greenhouse-sync-fake-server.test.ts`

**Interfaces:**

- Consumes: `runSinglePassPaginatedSync`, `bareArrayPage` (Task 2).
- Produces: `createGreenhouseSyncable` (unchanged public signature).

- [ ] **Step 1: Run the guardrail test first (baseline green)**

Run: `bun test packages/gateway/test/integration/connectors/greenhouse-sync-fake-server.test.ts`
Expected: PASS (9 tests). This is the behavior you must preserve.

- [ ] **Step 2: Replace the body with the helper**

Edit `packages/gateway/src/connectors/greenhouse-sync.ts`. Remove the `upsertIndexedItemForSync`, `syncPassCursor*`, and `syncNoopResult` imports; remove `extractJobs` and `upsertJobs`; add the helper import. Final file:

```ts
import { runSinglePassPaginatedSync, bareArrayPage } from "./_lib/paginated-sync.ts";
import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapGreenhouseJobToItem } from "./greenhouse-job-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "greenhouse";
const CURSOR_PREFIX = "nimbus-greenhouse1:";
const BASE = "https://harvest.greenhouse.io";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type GreenhouseCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies GreenhouseCursorV1);
}

export type GreenhouseSyncableOptions = {
  ensureGreenhouseMcpRunning: () => Promise<void>;
};

interface GreenhouseCreds {
  readonly apiKey: string;
}

async function loadCreds(ctx: SyncContext): Promise<GreenhouseCreds | null> {
  const apiKey = (await readConnectorSecret(ctx.vault, "greenhouse", "api_key"))?.trim() ?? "";
  if (apiKey === "") {
    return null;
  }
  return { apiKey };
}

function basicAuthHeader(apiKey: string): string {
  const b64 = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function jobsPath(page: number): string {
  const params = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page) });
  return `/v1/jobs?${params.toString()}`;
}

function greenhouseGet(ctx: SyncContext, creds: GreenhouseCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: basicAuthHeader(creds.apiKey), Accept: "application/json" },
  });
}

export function createGreenhouseSyncable(options: GreenhouseSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureGreenhouseMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, page) => greenhouseGet(ctx, creds, jobsPath(page)),
        parsePage: (parsed) => bareArrayPage(parsed, PAGE_SIZE),
        map: (raw, now) => mapGreenhouseJobToItem(raw, { syncedAt: now }),
      }),
  };
}
```

- [ ] **Step 3: Run the guardrail test — must stay green with no edits**

Run: `bun test packages/gateway/test/integration/connectors/greenhouse-sync-fake-server.test.ts`
Expected: PASS (9 tests, unchanged).

- [ ] **Step 4: Typecheck**

Run: the gateway typecheck (as in Task 2 Step 5).
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/greenhouse-sync.ts
git commit -m "refactor(dedup): greenhouse-sync via runSinglePassPaginatedSync (Stage A)"
```

---

### Task 4: Migrate `readwise-sync.ts` — envelope + next-cursor exemplar

**Files:**

- Modify: `packages/gateway/src/connectors/readwise-sync.ts`
- Guardrail (do NOT edit): `packages/gateway/test/integration/connectors/readwise-sync-fake-server.test.ts`

This connector's response is an envelope `{ results, next }`, and its stop condition is `highlights.length === 0 || next === null` — so it uses a **custom `parsePage`** (not `bareArrayPage`).

- [ ] **Step 1: Run the guardrail test first**

Run: `bun test packages/gateway/test/integration/connectors/readwise-sync-fake-server.test.ts`
Expected: PASS (baseline).

- [ ] **Step 2: Replace the body**

Edit `packages/gateway/src/connectors/readwise-sync.ts`. Keep `asRecord`. Remove `upsertIndexedItemForSync` / `syncPassCursor*` / `syncNoopResult` imports and the `extractHighlights` / `upsertHighlights` functions; fold the extraction+stop logic into `parsePage`. Final `sync` wrapper + parsePage:

```ts
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
// keep: connectorFetch, readConnectorSecret, encodeNimbusJsonCursor,
//       mapReadwiseHighlightToItem, asRecord, type Syncable/SyncContext

function parseReadwisePage(parsed: unknown): { items: unknown[]; hasMore: boolean } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], hasMore: false };
  }
  const results = root["results"];
  const items = Array.isArray(results) ? results : [];
  const nextRaw = root["next"];
  const next = typeof nextRaw === "string" && nextRaw !== "" ? nextRaw : null;
  return { items, hasMore: items.length > 0 && next !== null };
}

export function createReadwiseSyncable(options: ReadwiseSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureReadwiseMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, page) => readwiseGet(ctx, creds, highlightsPath(page)),
        parsePage: (parsed) => parseReadwisePage(parsed),
        map: (raw, now) => mapReadwiseHighlightToItem(raw, { syncedAt: now }),
      }),
  };
}
```

Keep `SERVICE_ID`, `CURSOR_PREFIX`, `BASE`, `PAGE_SIZE`, `MAX_PAGES`, `pass1Cursor`, `loadCreds`, `highlightsPath`, `readwiseGet` exactly as they are.

- [ ] **Step 3: Run the guardrail test**

Run: `bun test packages/gateway/test/integration/connectors/readwise-sync-fake-server.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 4: Typecheck + commit**

```bash
git add packages/gateway/src/connectors/readwise-sync.ts
git commit -m "refactor(dedup): readwise-sync via runSinglePassPaginatedSync (Stage A)"
```

---

### Task 5: Migrate `stackoverflow-sync.ts` — envelope + totalPages exemplar

**Files:**

- Modify: `packages/gateway/src/connectors/stackoverflow-sync.ts`
- Guardrail (do NOT edit): `packages/gateway/test/integration/connectors/stackoverflow-sync-fake-server.test.ts`

Response envelope `{ items, totalPages }`; stop on `items.length === 0 || page >= totalPages` — the `hasMore` decision needs the **page number**, demonstrating `parsePage(parsed, page)`.

- [ ] **Step 1: Run the guardrail test first**

Run: `bun test packages/gateway/test/integration/connectors/stackoverflow-sync-fake-server.test.ts`
Expected: PASS (baseline).

- [ ] **Step 2: Replace the body**

Edit `packages/gateway/src/connectors/stackoverflow-sync.ts`. Remove the `upsertIndexedItemForSync` / `syncPassCursor*` / `syncNoopResult` imports and `extractPage` / `upsertQuestions`; fold into `parsePage`:

```ts
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
// keep: connectorFetch, readConnectorSecret, encodeNimbusJsonCursor,
//       mapStackOverflowQuestionToItem, asRecord, type Syncable/SyncContext

function parseStackOverflowPage(parsed: unknown, page: number): { items: unknown[]; hasMore: boolean } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], hasMore: false };
  }
  const rawItems = root["items"];
  const items = Array.isArray(rawItems) ? rawItems : [];
  const totalPagesRaw = root["totalPages"];
  const totalPages =
    typeof totalPagesRaw === "number" && Number.isFinite(totalPagesRaw) ? totalPagesRaw : 0;
  return { items, hasMore: items.length > 0 && page < totalPages };
}

export function createStackOverflowSyncable(options: StackOverflowSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureStackOverflowMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, page) => stackOverflowGet(ctx, creds, questionsPath(creds.team, page)),
        parsePage: (parsed, page) => parseStackOverflowPage(parsed, page),
        map: (raw, now) => mapStackOverflowQuestionToItem(raw, { syncedAt: now }),
      }),
  };
}
```

Keep all constants, `pass1Cursor`, `loadCreds`, `questionsPath`, `stackOverflowGet` unchanged.

- [ ] **Step 3: Run the guardrail test**

Run: `bun test packages/gateway/test/integration/connectors/stackoverflow-sync-fake-server.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 4: Typecheck + commit**

```bash
git add packages/gateway/src/connectors/stackoverflow-sync.ts
git commit -m "refactor(dedup): stackoverflow-sync via runSinglePassPaginatedSync (Stage A)"
```

---

### Task 6: Migrate the remaining Tier-1 paginated connectors (batched)

**Files (Modify — 18 connectors):**
`airflow-sync.ts`, `canva-sync.ts`, `dependencytrack-sync.ts`, `hubspot-sync.ts`, `intercom-sync.ts`, `lever-sync.ts`, `miro-sync.ts`, `mlflow-sync.ts`, `netlify-sync.ts`, `pipedrive-sync.ts`, `prefect-sync.ts`, `raindrop-sync.ts`, `salesforce-sync.ts`, `stripe-sync.ts`, `superset-sync.ts`, `vercel-sync.ts`, `zendesk-sync.ts`, `zotero-sync.ts`.

Each has a `*-sync-fake-server.test.ts` guardrail (do NOT edit any of them).

**The migration recipe (apply per file):**

1. Run the connector's guardrail test first — confirm green baseline:
   `bun test packages/gateway/test/integration/connectors/<name>-sync-fake-server.test.ts`
2. Read the file. Confirm it matches the single-pass scaffold (one `for (let page …)` loop; a terminal `return syncPassCursorSuccess(...)`; the first-page `http_error`/`parse_error` degradation; an `upsert*` loop). **If it deviates** (extra resource types, a second loop, multi-pass cursor) → **skip it, leave a note in the PR description, and do NOT force it.**
3. Identify the per-connector variations:
   - **startPage:** `0` if the loop is `for (let page = 0; page < MAX_PAGES; …)` with an offset path; else `1`.
   - **loadCreds:** classify how the existing `sync()` loads credentials → the `loadCreds: () => Promise<C | null>` callback must reproduce it **exactly** (returning `null` wherever the original returns `syncNoopResult`):
     - **separate `loadCreds(ctx)` returning creds-or-null** (e.g. greenhouse, readwise) → `loadCreds: () => loadCreds(ctx)`, function unchanged.
     - **inline OAuth load with try/catch → noop** (canva, hubspot, miro, salesforce — they call `getValidXAccessToken(ctx.vault)` / `getValidSalesforceAuth(ctx.vault)` inside `sync()`, `catch { return syncNoopResult(...) }`, and also noop on empty token). Fold that block into the callback verbatim:

       ```ts
       loadCreds: async () => {
         let token: string;
         try {
           token = await getValidCanvaAccessToken(ctx.vault);
         } catch {
           return null; // helper turns null into syncNoopResult(cursor, t0)
         }
         return token === "" ? null : { token };
       },
       ```

       (Salesforce returns `{ accessToken, instanceUrl }`; preserve every field its `fetchPage`/path builder needs.)
   - **parsePage:** classify the existing `extract*` + the `break` condition into one of:
     - **bare-array + `length < PAGE_SIZE` break** → `parsePage: (parsed) => bareArrayPage(parsed, PAGE_SIZE)`.
     - **envelope + `next`/`nextCursor`** → a local `parseXPage(parsed)` like Task 4.
     - **envelope + `totalPages`/`page < N`** → a local `parseXPage(parsed, page)` like Task 5.
     - **other envelope (e.g. `{ data: [...] }`)** → a local `parseXPage` returning `{ items, hasMore }` that reproduces the existing extraction + break **exactly**.
   - **fetchPage:** usually `(creds, page) => xGet(ctx, creds, xPath(...))`, the `xGet` wrapper unchanged. **Note:** some connectors (e.g. pipedrive) build the `FetchOutcome` in their own local fetch wrapper with a `JSON.parse` try/catch → that wrapper stays as-is; `fetchPage` just calls it. The helper never parses — it only consumes the `FetchOutcome`.
   - **map:** `(raw, now) => mapXToItem(raw, { syncedAt: now })` using the file's existing mapping import. The map runs inside `upsertMapped`, which (like the current `upsert*` loops) does **not** catch per-item errors — a throwing map propagates and fails the sync, exactly as today.
4. Rewrite `createXSyncable` to call `runSinglePassPaginatedSync(ctx, cursor, { ensureRunning: options.ensureXMcpRunning, loadCreds, pass1Cursor, maxPages: MAX_PAGES, startPage, fetchPage, parsePage, map })`. Keep constants, `pass1Cursor`, the path builder, and the `xGet` fetch wrapper unchanged. Delete the now-unused `extract*`/`upsert*` functions and their now-unused imports (`upsertIndexedItemForSync`, `syncPassCursor*`, and — only when no longer referenced — `syncNoopResult`).
5. Re-run the guardrail test — must pass unchanged. If it fails, the `parsePage`/`startPage` classification was wrong: diff the old vs new break condition and fix `parsePage` (do not edit the test).
6. Move to the next file.

- [ ] **Step 1: Migrate the bare-array group**

Apply the recipe to the connectors whose `extract*` returns a bare array and whose break is `length < PAGE_SIZE`. Likely members (verify per file): `canva`, `dependencytrack`, `hubspot`, `lever`, `miro`, `netlify`, `prefect`, `raindrop`, `stripe`, `vercel`, `zendesk`, `zotero` (zotero uses `startPage: 0` with an offset path). Run each guardrail test green as you go.

- [ ] **Step 2: Migrate the envelope group**

Apply the recipe to the connectors with an envelope response (`next` / `totalPages` / `{ data }`): likely `airflow`, `intercom`, `mlflow`, `pipedrive`, `salesforce`, `superset`. Write a local `parseXPage` per file that reproduces the existing extraction + break exactly. Run each guardrail test green.

- [ ] **Step 3: Run the full connector integration suite**

Run: `bun test packages/gateway/test/integration/connectors/`
Expected: PASS (all connector fake-server tests, including the 3 exemplars and 18 batch files).

- [ ] **Step 4: Typecheck the gateway package**

Run: the gateway typecheck (as Task 2 Step 5).
Expected: no errors; no unused imports (Biome `noUnusedImports` will also catch these in preflight).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/*-sync.ts
git commit -m "refactor(dedup): migrate Tier-1 paginated connectors to runSinglePassPaginatedSync (Stage A)"
```

---

### Task 7: Measure, verify, and push

**Files:** none (verification + measurement only).

- [ ] **Step 1: Measure strict jscpd delta**

Run: `bunx jscpd packages 2>&1 | grep -E "Total:|too many"`
Record the new strict `Total:` % vs the 5.51% baseline in the PR description. (Expectation: a substantial drop as the zotero-partner clique + the per-connector `upsert*` loops collapse. The gate may still be >3% after Stage A alone — that is expected; later stages continue. Do NOT tighten the gate in this PR.)

- [ ] **Step 2: Regenerate + diff the per-file report**

Run: `bunx jscpd packages` (writes `docs/structure-audit/jscpd-report.json`). Confirm `zotero-sync.ts` clone-involvement has dropped sharply from 85. Note the new top hotspots for the next stage.

- [ ] **Step 3: Coverage floor (Docker-Linux authoritative)**

Run the Linux lcov build + check per the `nimbus-preflight` skill (`audit:coverage-floor`). Confirm `packages/gateway/src/connectors/_lib/paginated-sync.ts` is ≥80% line+branch and no migrated connector dropped below the floor. If `paginated-sync.ts` is short any branch, add the missing case to `paginated-sync.test.ts` (do not exclude).

- [ ] **Step 4: Full preflight**

Run: `bun run preflight`
Expected: all gates green (types, Biome incl. `noUnusedImports`, structure audit, tests). Fix anything red locally before pushing.

- [ ] **Step 5: Whole-branch self-review**

Run `/code-review` over the branch diff. Confirm: no behavior change, no `any`, no edited guardrail test, perf surfaces untouched.

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin worktree-jscpd-dedup
```

Open the PR titled `refactor(dedup): Stage A — gateway paginated-sync helper`. Body: before/after strict %, the helper design, the 21 migrated connectors, the deferred Tier-2 list, and a note that gate-tightening lands in the final stage. Watch CI (coverage-floor + jscpd job stay green — the CI jscpd gate is still the lenient one, so it must not regress).

---

## Self-Review

**Spec coverage:** This plan implements Stage A of the design spec (the highest-leverage cluster). Stages B–E and the final gate-tightening are explicitly out of scope here (each gets its own plan as we measure). The "stop at safe margin" and "measure after each" decisions are honored by Task 7 Steps 1–2. ✓

**Placeholder scan:** Helper code, all three exemplar migrations, and the helper tests are fully written. Task 6 is a mechanical fan-out over a verified file list with a complete recipe and a per-file guardrail; the per-connector `parsePage` is classified by an explicit decision list, not left vague. The one deliberate deferral (Tier-2's 9 larger files) is named and scoped out, not a placeholder. ✓

**Type consistency:** `SyncUpsertRow` defined in Task 1, reused in Task 2's `PaginatedSyncSpec.map`. `runSinglePassPaginatedSync` / `bareArrayPage` / `ParsedPage` / `PaginatedSyncSpec` names are consistent across Tasks 2–6. `parsePage(parsed, page)` signature is consistent (Task 2 defines it; Task 5 uses the `page` arg). ✓

**Behavioral fidelity:** every migration is gated by re-running the connector's existing `*-sync-fake-server.test.ts` with no edits; `startPage`/`maxPages` loop math is proven equivalent in Task 2's tests (`startPage 0` case, `maxPages` cap). ✓

## Review resolutions (2026-06-17)

Dispositions of `…-stage-a-paginated-sync-review.md`, each verified against the connector code:

- **Q1.1 (per-item map error handling) — declined the optional `onError` handler.** Verified no Tier-1 connector wraps per-item mapping in try/catch; mapping fns return `null` for bad input. `upsertMapped` preserves propagate-on-throw exactly (Task 6 recipe step 3, `map` bullet).
- **Q2.1 (optional `ensureRunning`) — declined.** Verified all 21 connectors pass `options.ensureXMcpRunning` (no empty-fn boilerplate exists); required also guards wiring.
- **Q2.2 (`Date.now()` once before the loop) — confirmed correct.** Verified all 21 compute `now` once before the loop; the helper matches.
- **New finding while verifying Q1.1 — recipe gap fixed.** 4 OAuth connectors (canva/hubspot/miro/salesforce) load credentials **inline in `sync()` with a try/catch → noop**, not via a separate `loadCreds(ctx)`. Added a `loadCreds` classification to the Task 6 recipe (fold the try/catch into the callback, return `null` where the original returns `syncNoopResult`). Also noted pipedrive's own `JSON.parse` try/catch lives in its fetch wrapper, untouched by the helper.
