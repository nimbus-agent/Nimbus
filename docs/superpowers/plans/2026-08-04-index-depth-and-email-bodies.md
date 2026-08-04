# Enforced Index Depth + Gmail/Outlook Full Bodies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `metadata_only` depth setting genuinely suppress body content on every sync for every connector, and give `gmail:email` / `outlook:email` real message bodies instead of ~200-character provider snippets.

**Architecture:** Depth is enforced at a single chokepoint — `upsertIndexedItemForSync` — rather than in ninety connectors, so a connector cannot forget it and a new connector inherits it. A V49 migration lands *first* so enforcement never truncates an existing index. Gmail and Outlook then get bodies from requests they already make, filtered through a shared quoted-tail trimmer because email is heavily self-duplicating.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:sqlite`, `bun:test`, Biome.

**Design spec:** [`../specs/2026-08-04-index-depth-and-email-bodies-design.md`](../specs/2026-08-04-index-depth-and-email-bodies-design.md)
**Review folded in:** [`../specs/2026-08-04-index-depth-and-email-bodies-design-review.md`](../specs/2026-08-04-index-depth-and-email-bodies-design-review.md)

## Global Constraints

- **No `any`.** External JSON is `unknown`, narrowed with the connector `asRecord`/`stringField` helpers. TypeScript strict.
- **New files under `packages/gateway/src/` need ≥80% line AND branch coverage.** Two new source files here: the V49 SQL module and the trimmer, plus the Gmail MIME walker.
- **`bun test --coverage` produces NO OUTPUT in this repo** — `bunfig.toml` sets `[test] coverage = false`, which suppresses even the explicit flag. Measure via the istanbul preload: `bun test --preload ./scripts/coverage/istanbul-register.ts --preload ./scripts/coverage/report-coverage.ts <file>`, then read `coverage/.nyc-tmp/<pid>.json` (`.s` / `.b`). Delete `coverage/` afterwards.
- **Tests under `packages/gateway/src/` must NEVER import from `../../test/helpers/`** — `tsconfig.json` includes `src/**/*` only, and such an import reds the typecheck.
- **`db.query()`, never `db.prepare()`** — an unfinalized prepare makes `db.close()` a silent no-op and pins the file on Windows.
- **Gates are run individually in this worktree.** `bun run lint`, `test:ci` and `preflight` are all broken inside `.claude/worktrees/`. Lint with exactly `bunx biome check --error-on-warnings <dirs>`; CI uses `--error-on-warnings` and omitting it is weaker than CI. For markdown use `bunx markdownlint-cli2 "<glob>"` — `bun run lint:markdown` matches nothing here and **exits 0 silently**.
- **Never `git add -A`** — `.claude/settings.local.json` is git-tracked. Explicit paths only.
- Commit on `dev/asaf/index-depth-and-email-bodies` only.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/gateway/src/index/depth-default-v49-sql.ts` | **New.** V49 backfill SQL | 1 |
| `packages/gateway/src/index/migrations/runner.ts` | Register the V49 step | 1 |
| `packages/gateway/src/index/local-index.ts` | `CURRENT_SCHEMA_VERSION` 48→49; the depth-less INSERT writes `'full'` | 1 |
| `packages/gateway/src/sync/scheduler.ts` | `getDepthForService` fallback → `'full'`; per-run ctx carries depth | 1, 2 |
| `packages/gateway/src/sync/types.ts` | `SyncContext.depth` | 2 |
| `packages/gateway/src/platform/assemble.ts` | Production `SyncContext` construction | 2 |
| `packages/gateway/src/connectors/connector-sync-test-helpers.ts`, `src/testing/bun-test-support.ts` | Test `SyncContext` construction | 2 |
| `packages/gateway/src/index/item-store.ts` | The depth coercion chokepoint | 2 |
| `packages/gateway/src/string/email-quoted-text.ts` | **New.** Quoted-tail trimmer | 3 |
| `packages/gateway/src/connectors/_lib/gmail/message-body.ts` | **New.** MIME walk | 4 |
| `packages/gateway/src/connectors/_lib/gmail/api.ts` | `format=full`; pass a real body | 4 |
| `packages/gateway/src/connectors/outlook-sync.ts` | `body` field, `$select`, pass a real body | 5 |
| `packages/gateway/src/ipc/index-rebody-rpc.ts` | Two new services + membership rows | 6 |
| `docs/*` | Accounting 12 → 14; depth semantics; the Outlook rebody note | 6 |

**Task 1 must land before Task 2.** Enforcement without the backfill truncates every existing index — that ordering is the whole reason the migration is its own task.

---

### Task 1: V49 — make the default real before anything enforces it

**Files:**

- Create: `packages/gateway/src/index/depth-default-v49-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`
- Modify: `packages/gateway/src/index/local-index.ts` (`CURRENT_SCHEMA_VERSION` at :265; the INSERT at :736)
- Modify: `packages/gateway/src/sync/scheduler.ts` (`getDepthForService`, :290-297)
- Test: `packages/gateway/src/index/local-index.test.ts` (migration), `packages/gateway/src/sync/scheduler.test.ts` (fallback)

**Interfaces:**

- Consumes: nothing.
- Produces: `DEPTH_DEFAULT_V49_SQL`. After this task every connector resolves to depth `'full'` unless a human explicitly chose otherwise.

**Why the backfill is safe.** `connector-depth-v21-sql.ts` declares `depth TEXT NOT NULL DEFAULT 'summary'`, so rows hold `'summary'` **materialised** — not NULL falling through to a code default. Depth has never been enforced for body content, so a stored `'summary'` carries no expressed intent about bodies and has always behaved as `'full'`. Backfilling preserves observed behaviour. `metadata_only` is different — its reindex genuinely stripped bodies — so those rows are left alone and become enforced in Task 2.

- [ ] **Step 1: Write the failing tests**

In `packages/gateway/src/sync/scheduler.test.ts`:

```ts
test("a connector with no depth row resolves to full", () => {
  // build a scheduler over a fresh in-memory index, register a connector,
  // then read getStatus(<id>).depth — mirror the existing
  // "returns depth='summary' and enabled=true for a fresh connector" test in
  // scheduler-status-shape.test.ts for harness shape; the expectation flips.
  expect(status.depth).toBe("full");
});
```

In `packages/gateway/src/index/local-index.test.ts` (follow the file's existing migration-test idiom):

```ts
test("V49 backfills summary to full and leaves metadata_only alone", () => {
  // open an index at V48, insert three sync_state rows with depths
  // 'summary' | 'metadata_only' | 'full', migrate to CURRENT_SCHEMA_VERSION,
  // then assert:
  expect(depthOf("svc-summary")).toBe("full");
  expect(depthOf("svc-metadata")).toBe("metadata_only");
  expect(depthOf("svc-full")).toBe("full");
});

test("V49 is idempotent", () => {
  // running the migration twice leaves the same values
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun test packages/gateway/src/sync/scheduler-status-shape.test.ts packages/gateway/src/index/local-index.test.ts`
Expected: FAIL — depth resolves to `summary`, and V49 does not exist.

- [ ] **Step 3: Create the migration SQL**

`packages/gateway/src/index/depth-default-v49-sql.ts`:

```ts
/**
 * V49 — make the per-connector `depth` setting real.
 *
 * V21 added `depth TEXT NOT NULL DEFAULT 'summary'`, so every existing row
 * holds `'summary'` MATERIALISED rather than NULL. Depth was never enforced
 * for body content, so that stored `'summary'` expresses no intent about
 * bodies — it is indistinguishable from the column default and has always
 * behaved as `'full'`. Backfilling it preserves exactly the behaviour those
 * installs have observed; without it, the enforcement added alongside this
 * migration would silently truncate every existing index to 512 characters.
 *
 * `metadata_only` is deliberately NOT touched: its reindex really did strip
 * bodies, so it IS expressed intent, and it is the setting that finally
 * starts being honoured on every sync.
 *
 * The column's `DEFAULT 'summary'` is left in place — SQLite cannot alter a
 * column default in place, and rebuilding `sync_state` is disproportionate
 * when the two code sites that insert rows fully determine the value.
 */
export const DEPTH_DEFAULT_V49_SQL: readonly string[] = [
  "UPDATE sync_state SET depth = 'full' WHERE depth = 'summary'",
];
```

- [ ] **Step 4: Register the step in the runner**

Open `packages/gateway/src/index/migrations/runner.ts`, find the V48 entry in `INDEXED_SCHEMA_STEPS`, and add a V49 entry immediately after it following the identical shape (this repo uses `simpleStep`/`applySchemaStep` helpers — copy the V48 row's form exactly rather than inventing one). Description: `"connector depth default summary->full (enforced depth v49)"`.

- [ ] **Step 5: Bump the schema version and the insert default**

`local-index.ts:265`:

```ts
export const CURRENT_SCHEMA_VERSION = 49;
```

`local-index.ts:736` — this INSERT omits `depth` and therefore inherits the column's stale `'summary'` default. Make it explicit:

```ts
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth)
       VALUES (?, NULL, NULL, 'full')`,
```

(Check the existing parameter list before editing — add the column and its literal without disturbing the bound parameters.)

`scheduler.ts:290-297` — both fallbacks:

```ts
  private getDepthForService(serviceId: string): "metadata_only" | "summary" | "full" {
    const row = this.db
      .query(`SELECT depth FROM sync_state WHERE connector_id = ?`)
      .get(serviceId) as { depth: string | null } | null | undefined;
    if (row == null) {
      return "full";
    }
    return (row.depth ?? "full") as "metadata_only" | "summary" | "full";
  }
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/gateway/src/sync/ packages/gateway/src/index/`
Expected: PASS. Other tests asserting `depth === "summary"` for a fresh connector are now wrong by design — update their expectation to `"full"` and say so in the report.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json
bunx biome check --error-on-warnings packages/gateway/src/index packages/gateway/src/sync
git add packages/gateway/src/index/depth-default-v49-sql.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/local-index.ts packages/gateway/src/sync/scheduler.ts packages/gateway/src/index/local-index.test.ts packages/gateway/src/sync/scheduler-status-shape.test.ts
git commit -m "feat(index): V49 makes the connector depth default real"
```

---

### Task 2: Enforce depth at the store chokepoint

**Files:**

- Modify: `packages/gateway/src/sync/types.ts` (`SyncContext`)
- Modify: `packages/gateway/src/sync/scheduler.ts` (:650, the `connector.sync` call)
- Modify: `packages/gateway/src/platform/assemble.ts` (:~1507)
- Modify: `packages/gateway/src/connectors/connector-sync-test-helpers.ts` (:~43), `packages/gateway/src/testing/bun-test-support.ts` (:~51)
- Modify: `packages/gateway/src/index/item-store.ts`
- Test: `packages/gateway/src/index/item-store-body.test.ts`

**Interfaces:**

- Consumes: Task 1's `'full'` default.
- Produces: `SyncContext.depth: "metadata_only" | "summary" | "full"` (required). Tasks 4 and 5 rely on `full` being a pass-through.

**`SyncContext` is shared, so depth must be per-run.** `scheduler.ts:650` calls `connector.sync(this.ctx, row.cursor)` with a single context built once at `assemble.ts`. Depth is per-service, so the call site spreads a per-run context. One object allocation per sync run, not per item.

**Inline the union rather than importing `ReindexDepth`.** `SyncStatus` in the same file already inlines `"metadata_only" | "summary" | "full"` (types.ts:124). Follow that — importing from `connectors/reindex.ts` into `sync/types.ts` adds coupling for no benefit.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/index/item-store-body.test.ts`, using that file's existing local `db()` and `read()` helpers and its `base` fixture:

```ts
import { upsertIndexedItemForSync } from "./item-store.ts";

function ctxAt(d: Database, depth: "metadata_only" | "summary" | "full") {
  // Minimal SyncContext for the store call — mirror the shape the file's
  // neighbours use; only db + depth are read by upsertIndexedItemForSync.
  return { db: d, depth } as unknown as SyncContext;
}

test("metadata_only writes no body even when the connector passes body:", () => {
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "metadata_only"), {
    ...base, externalId: "m1", title: "Subject line", body: "secret contents",
  });
  const row = read(d, "slack:m1");
  expect(row.body ?? "").toBe("");
  expect(row.body_complete).toBe(0);
  d.close();
});

test("metadata_only leaves body_preview empty too", () => {
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "metadata_only"), {
    ...base, externalId: "m2", title: "Subject line", body: "secret contents",
  });
  expect(read(d, "slack:m2").body_preview ?? "").toBe("");
  d.close();
});

test("metadata_only does NOT store the title as the body", () => {
  // Regression guard: upsertIndexedItem computes
  //   raw = row.body ?? row.bodyPreview ?? row.title
  // so merely OMITTING the body input falls through to the title.
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "metadata_only"), {
    ...base, externalId: "m3", title: "Quarterly numbers", body: "secret",
  });
  const row = read(d, "slack:m3");
  expect(row.body ?? "").not.toBe("Quarterly numbers");
  expect(row.body_preview ?? "").not.toBe("Quarterly numbers");
  d.close();
});

test("summary downgrades a body: caller to 512 and never claims completeness", () => {
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "summary"), {
    ...base, externalId: "s1", body: "x".repeat(20_000),
  });
  const row = read(d, "slack:s1");
  expect((row.body ?? "").length).toBe(512);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("full passes a body through at the per-type cap", () => {
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "full"), {
    ...base, externalId: "f1", body: "y".repeat(20_000),
  });
  const row = read(d, "slack:f1");
  expect((row.body ?? "").length).toBe(16_384);
  expect(row.body_complete).toBe(0); // over cap
  d.close();
});

test("a bodyPreview: caller is unaffected at full depth", () => {
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "full"), {
    ...base, externalId: "p1", bodyPreview: "short",
  });
  const row = read(d, "slack:p1");
  expect(row.body).toBe("short");
  expect(row.body_complete).toBe(0);
  d.close();
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun test packages/gateway/src/index/item-store-body.test.ts`
Expected: FAIL — `metadata_only` currently stores the body verbatim.

- [ ] **Step 3: Add `depth` to `SyncContext`**

`sync/types.ts`, inside `export interface SyncContext`:

```ts
  /**
   * The connector's persisted index depth, resolved per sync run by the
   * scheduler. Enforced centrally in `upsertIndexedItemForSync` — connectors
   * do not read this and must not be trusted to honour it individually.
   */
  depth: "metadata_only" | "summary" | "full";
```

Required, not optional: every construction site should have to state it.

- [ ] **Step 4: Supply it at all three construction sites**

`platform/assemble.ts` (~:1507) — the shared context is a template; give it the safe pass-through:

```ts
    depth: "full",
```

`connectors/connector-sync-test-helpers.ts` (~:43) and `testing/bun-test-support.ts` (~:51) — same, so existing connector tests keep exercising the full-body path:

```ts
    depth: "full",
```

`sync/scheduler.ts` (~:650) — the real per-service resolution:

```ts
      const runCtx: SyncContext = {
        ...this.ctx,
        depth: this.getDepthForService(job.serviceId),
      };
      result = await connector.sync(runCtx, row.cursor);
```

- [ ] **Step 5: Coerce at the chokepoint**

In `item-store.ts`, above `upsertIndexedItemForSync`:

```ts
type BodyRow = Parameters<typeof upsertIndexedItem>[1];

/**
 * Coerce a connector's body input to the connector's configured depth.
 *
 * `metadata_only` passes `body: ""` rather than omitting the input, because
 * `upsertIndexedItem` computes `raw = row.body ?? row.bodyPreview ?? row.title`
 * — omission would fall through to the TITLE and store it as the body. The
 * empty string is not nullish, so it wins that chain and both `body` and
 * `body_preview` land empty. `bodyTruncated` keeps `body_complete` at 0 so a
 * suppressed body is never reported as a complete one.
 */
function applyDepth(depth: SyncContext["depth"], row: BodyRow): BodyRow {
  if (depth === "full") {
    return row;
  }
  const { body, bodyPreview, bodyTruncated, ...rest } = row as BodyRow & {
    body?: string;
    bodyPreview?: string;
    bodyTruncated?: boolean;
  };
  if (depth === "metadata_only") {
    return { ...rest, body: "", bodyTruncated: true } as BodyRow;
  }
  // summary: force the legacy preview arm, which clamps to 512 and never
  // claims completeness.
  const text = body ?? bodyPreview ?? "";
  return { ...rest, bodyPreview: text } as BodyRow;
}
```

and in `upsertIndexedItemForSync`:

```ts
export function upsertIndexedItemForSync(ctx: SyncContext, row: BodyRow): void {
  upsertIndexedItem(ctx.db, applyDepth(ctx.depth, row), ctx.resolveServiceId);
  const id = itemPrimaryKey(row.service, row.externalId);
  ctx.scheduleItemEmbedding?.(id);
}
```

**Deviation to report:** the spec says `metadata_only` writes NULL. This writes the empty string, because the store derives `body_preview` from `body` and has no null-body path. Every consumer predicate already treats them alike — `reindex.ts:53` tests `body IS NOT NULL AND body <> ''`. Call this out in your report so the reviewer rules on it rather than discovering it.

`upsertIndexedItem` (the non-sync entry point) is deliberately unchanged — it has non-connector callers and depth is a connector-sync concept.

- [ ] **Step 6: Run the tests**

Run: `bun test packages/gateway/src/index/ packages/gateway/src/connectors/`
Expected: PASS. The connector suites should be unaffected because the test helpers pin `depth: "full"`.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json
bunx biome check --error-on-warnings packages/gateway/src
git add packages/gateway/src/sync/types.ts packages/gateway/src/sync/scheduler.ts packages/gateway/src/platform/assemble.ts packages/gateway/src/connectors/connector-sync-test-helpers.ts packages/gateway/src/testing/bun-test-support.ts packages/gateway/src/index/item-store.ts packages/gateway/src/index/item-store-body.test.ts
git commit -m "feat(index): enforce connector depth at the sync upsert chokepoint"
```

---

### Task 3: The quoted-tail trimmer

**Files:**

- Create: `packages/gateway/src/string/email-quoted-text.ts`
- Test: `packages/gateway/src/string/email-quoted-text.test.ts` (new; the `string/` directory already holds `html-plain-text.test.ts`)

**Interfaces:**

- Consumes: nothing. Pure string→string.
- Produces: `stripQuotedTail(body: string): string`. Tasks 4 and 5 both call it.

**The rule is a TAIL, not the first marker.** A real reply chain runs from its marker to the end of the message; an inline quotation is followed by more of the author's own prose. Cutting at the first marker destroys the second case, and a never-return-empty fallback does not save it because the text above the marker is non-empty.

**This file needs ≥80% line AND branch coverage.**

- [ ] **Step 1: Write the failing tests**

`packages/gateway/src/string/email-quoted-text.test.ts`:

```ts
import { expect, test } from "bun:test";

import { stripQuotedTail } from "./email-quoted-text.ts";

test("cuts a trailing > quote block", () => {
  expect(stripQuotedTail("Yes, agreed.\n\n> the original\n> more original")).toBe("Yes, agreed.");
});

test("does NOT cut an inline quote followed by more prose", () => {
  const body = "Here's my take.\n\n> quoting the spec\n> more spec\n\nActually I disagree because Z.";
  expect(stripQuotedTail(body)).toBe(body);
});

test("cuts at an attribution line", () => {
  expect(stripQuotedTail("Sure.\n\nOn Mon, 4 Aug 2026, Ana wrote:\n> hi")).toBe("Sure.");
});

test("cuts at -----Original Message-----", () => {
  expect(stripQuotedTail("Done.\n\n-----Original Message-----\nFrom: x")).toBe("Done.");
});

test("cuts at the Outlook underscore divider", () => {
  expect(stripQuotedTail(`Ack.\n\n${"_".repeat(32)}\nFrom: x\nSent: y`)).toBe("Ack.");
});

test("cuts a trailing Outlook header block with no divider", () => {
  expect(
    stripQuotedTail("Looks good.\n\nFrom: Ana <a@x.com>\nSent: Tuesday\nTo: Bo\nSubject: Re: spec"),
  ).toBe("Looks good.");
});

test("a lone From: line in a pasted log does not trigger the header marker", () => {
  const body = "Log follows:\n\nFrom: cache\nstatus=200\ndone";
  expect(stripQuotedTail(body)).toBe(body);
});

test("a header block mid-message with prose below is not cut", () => {
  const body = "See below.\n\nFrom: Ana\nSent: Tue\n\nMy actual point is Z.";
  expect(stripQuotedTail(body)).toBe(body);
});

test("cuts a trailing signature delimiter", () => {
  expect(stripQuotedTail("Thanks!\n\n-- \nAna\nCTO")).toBe("Thanks!");
});

test("returns the body unchanged when no marker matches", () => {
  expect(stripQuotedTail("Just a plain message.")).toBe("Just a plain message.");
});

test("a wholly-quoted body falls back to the untrimmed text", () => {
  const body = "> everything\n> is quoted";
  expect(stripQuotedTail(body)).toBe(body);
});

test("handles CRLF line endings", () => {
  expect(stripQuotedTail("Yes.\r\n\r\n> quoted")).toBe("Yes.");
});

test("empty input is returned as-is", () => {
  expect(stripQuotedTail("")).toBe("");
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `bun test packages/gateway/src/string/email-quoted-text.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/gateway/src/string/email-quoted-text.ts`:

```ts
/**
 * Strip the quoted reply chain from an email body.
 *
 * Email is heavily self-duplicating: a twenty-message thread quoted in every
 * reply stores the same paragraphs twenty times, spends each reply's body cap
 * on text already indexed, and skews term frequency for the glossary agent.
 *
 * This removes a quoted TAIL, and that distinction is the correctness
 * argument. A real reply chain runs from its marker to the END of the message.
 * An inline quotation does not — it is followed by more of the author's own
 * prose. Cutting at the first marker would destroy exactly the messages worth
 * reading, and a never-return-empty fallback does not catch it because the
 * text above the marker is non-empty.
 */

const ATTRIBUTION_RE =
  /^\s*(on\s+.+\bwrote:\s*$|am\s+.+\bschrieb\s+.+:\s*$|le\s+.+\ba\s+écrit\s*:\s*$)/i;
const ORIGINAL_MESSAGE_RE = /^\s*-{2,}\s*original message\s*-{2,}\s*$/i;
const DIVIDER_RE = /^\s*_{10,}\s*$/;
/** A signature delimiter is exactly two hyphens and a single trailing space. */
const SIGNATURE_RE = /^--\s?$/;
const QUOTE_RE = /^\s*>/;
const HEADER_FIELD_RE = /^\s*(from|sent|to|cc|subject|date)\s*:\s*\S/i;

function isMarker(line: string, headerish: boolean): boolean {
  return (
    QUOTE_RE.test(line) ||
    ATTRIBUTION_RE.test(line) ||
    ORIGINAL_MESSAGE_RE.test(line) ||
    DIVIDER_RE.test(line) ||
    SIGNATURE_RE.test(line) ||
    headerish
  );
}

/**
 * A `From:`-style line counts only when an ADJACENT line is also one. A single
 * `From: cache` inside a pasted log must not look like a quoted header block.
 */
function headerBlockFlags(lines: readonly string[]): boolean[] {
  const isField = lines.map((l) => HEADER_FIELD_RE.test(l));
  return isField.map((f, i) => f && (isField[i - 1] === true || isField[i + 1] === true));
}

export function stripQuotedTail(body: string): string {
  if (body === "") {
    return body;
  }
  const lines = body.split(/\r?\n/);
  const headerish = headerBlockFlags(lines);

  // Walk backwards over everything that could belong to a quoted tail.
  let start = lines.length;
  while (start > 0) {
    const line = lines[start - 1] ?? "";
    if (line.trim() === "" || isMarker(line, headerish[start - 1] === true)) {
      start -= 1;
      continue;
    }
    break;
  }

  if (start === lines.length || start === 0) {
    // No trailing block at all, or the whole body is quoted — never return empty.
    return body;
  }

  // The tail must BEGIN with a real marker, not merely blank lines.
  let firstIdx = start;
  while (firstIdx < lines.length && (lines[firstIdx] ?? "").trim() === "") {
    firstIdx += 1;
  }
  if (
    firstIdx >= lines.length ||
    !isMarker(lines[firstIdx] ?? "", headerish[firstIdx] === true)
  ) {
    return body;
  }

  const kept = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  return kept === "" ? body : kept;
}
```

- [ ] **Step 4: Run and confirm they pass**

Run: `bun test packages/gateway/src/string/email-quoted-text.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Check coverage on the new file**

Run:

```bash
bun test --preload ./scripts/coverage/istanbul-register.ts --preload ./scripts/coverage/report-coverage.ts packages/gateway/src/string/email-quoted-text.test.ts
```

Then read `coverage/.nyc-tmp/<pid>.json` and report the line and branch percentages for `email-quoted-text.ts`. Both must be ≥80%; add cases rather than lowering the bar. `rm -rf coverage` afterwards.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json
bunx biome check --error-on-warnings packages/gateway/src/string
git add packages/gateway/src/string/email-quoted-text.ts packages/gateway/src/string/email-quoted-text.test.ts
git commit -m "feat(string): quoted-tail trimmer for email bodies"
```

---

### Task 4: Gmail — `format=full` and a MIME walk

**Files:**

- Create: `packages/gateway/src/connectors/_lib/gmail/message-body.ts`
- Modify: `packages/gateway/src/connectors/_lib/gmail/api.ts` (types at :20-32, the request at :67-80, the upsert at :~174)
- Test: `packages/gateway/src/connectors/gmail-sync.test.ts`, plus a new `packages/gateway/src/connectors/_lib/gmail/message-body.test.ts`

**Interfaces:**

- Consumes: `stripQuotedTail` (Task 3); `plainTextFromHtml` from `../../../string/html-plain-text.ts`.
- Produces: `gmailMessageBodyText(payload: MessagePayload): string`.

**Zero extra requests.** `fetchMessageMetadata` already issues a per-message `GET`; it asks for `format=metadata`, which omits the payload body. `format=full` returns it in the same call, at the same 5 quota units.

- [ ] **Step 1: Write the failing tests**

`packages/gateway/src/connectors/_lib/gmail/message-body.test.ts`:

```ts
import { expect, test } from "bun:test";

import { gmailMessageBodyText } from "./message-body.ts";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

test("prefers text/plain over a sibling text/html", () => {
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("plain wins") } },
        { mimeType: "text/html", body: { data: b64url("<p>html loses</p>") } },
      ],
    }),
  ).toBe("plain wins");
});

test("falls back to text/html and strips it", () => {
  expect(
    gmailMessageBodyText({
      mimeType: "text/html",
      body: { data: b64url("<p>hello <b>there</b></p>") },
    }),
  ).toBe("hello there");
});

test("resolves nested multipart/alternative inside multipart/mixed", () => {
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: b64url("nested") } }],
        },
      ],
    }),
  ).toBe("nested");
});

test("decodes base64url, not plain base64", () => {
  // Chosen so the encoding contains - and _ , which plain base64 would reject
  // or mis-decode.
  const text = "a??b>>c~~d";
  const encoded = Buffer.from(text, "utf8").toString("base64url");
  expect(encoded).toMatch(/[-_]/);
  expect(
    gmailMessageBodyText({ mimeType: "text/plain", body: { data: encoded } }),
  ).toBe(text);
});

test("skips a part carrying an attachmentId", () => {
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { attachmentId: "att-1" } },
        { mimeType: "text/plain", body: { data: b64url("real body") } },
      ],
    }),
  ).toBe("real body");
});

test("returns empty for a payload with no usable part", () => {
  expect(gmailMessageBodyText({ mimeType: "image/png" })).toBe("");
});

test("bounded: a pathological deep tree does not hang", () => {
  let node: Record<string, unknown> = { mimeType: "text/plain", body: { data: b64url("deep") } };
  for (let i = 0; i < 200; i++) {
    node = { mimeType: "multipart/mixed", parts: [node] };
  }
  expect(() => gmailMessageBodyText(node as never)).not.toThrow();
});
```

And in `gmail-sync.test.ts`, one end-to-end case — mirror the file's existing harness:

```ts
test("indexes a real Gmail body with the quoted tail stripped", async () => {
  // drive the sync with a messages.get response whose payload is a text/plain
  // part containing "Agreed, ship Tuesday.\n\n> On Mon, Ana wrote:\n> the whole thread"
  const row = db
    .query<{ body: string; body_complete: number }, []>(
      "SELECT body, body_complete FROM item WHERE service = 'gmail'",
    )
    .get();
  expect(row?.body).toBe("Agreed, ship Tuesday.");
  expect(row?.body_complete).toBe(1);
});

test("requests format=full, not format=metadata", async () => {
  // capture the fetched URL and assert it
  expect(seenUrl).toContain("format=full");
  expect(seenUrl).not.toContain("format=metadata");
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `bun test packages/gateway/src/connectors/_lib/gmail/ packages/gateway/src/connectors/gmail-sync.test.ts`
Expected: FAIL — module not found; the sync still requests `format=metadata`.

- [ ] **Step 3: Widen the payload types**

`_lib/gmail/api.ts`, replacing the current `MessagePayload`:

```ts
export type MessagePartBody = {
  data?: string;
  /** Present when the bytes live in a separate attachment fetch — skip these. */
  attachmentId?: string;
};

export type MessagePayload = {
  mimeType?: string;
  headers?: MessageHeader[];
  body?: MessagePartBody;
  parts?: MessagePayload[];
};
```

- [ ] **Step 4: Write the MIME walker**

`packages/gateway/src/connectors/_lib/gmail/message-body.ts`:

```ts
import { plainTextFromHtml } from "../../../string/html-plain-text.ts";
import type { MessagePayload } from "./api.ts";

/** Depth bound — a malformed or hostile tree must not be able to spin. */
const MAX_DEPTH = 12;
/** Total parts visited across the whole walk. */
const MAX_PARTS = 500;

function decodeBase64Url(data: string): string {
  // Gmail encodes part bodies base64url (`-`/`_`), NOT standard base64.
  return Buffer.from(data, "base64url").toString("utf8");
}

type Found = { plain: string; html: string };

function walk(node: MessagePayload, depth: number, state: { visited: number }, out: Found): void {
  if (depth > MAX_DEPTH || state.visited >= MAX_PARTS) {
    return;
  }
  state.visited += 1;
  const mime = node.mimeType ?? "";
  const data = node.body?.data;
  const isAttachment = node.body?.attachmentId !== undefined;
  if (!isAttachment && data !== undefined && data !== "") {
    if (mime.startsWith("text/plain") && out.plain === "") {
      out.plain = decodeBase64Url(data);
    } else if (mime.startsWith("text/html") && out.html === "") {
      out.html = decodeBase64Url(data);
    }
  }
  for (const part of node.parts ?? []) {
    walk(part, depth + 1, state, out);
  }
}

/**
 * Plain text for a Gmail message payload: the first `text/plain` part if there
 * is one, otherwise the first `text/html` part stripped to text. Attachment
 * parts are skipped — Gmail does not inline their bytes, and filenames are not
 * what we index.
 */
export function gmailMessageBodyText(payload: MessagePayload): string {
  const out: Found = { plain: "", html: "" };
  walk(payload, 0, { visited: 0 }, out);
  if (out.plain !== "") {
    return out.plain.trim();
  }
  return out.html === "" ? "" : plainTextFromHtml(out.html);
}
```

- [ ] **Step 5: Request the full message and pass a real body**

`_lib/gmail/api.ts`, in `fetchMessageMetadata` — swap the format and drop the now-redundant `metadataHeaders` (they are included in `format=full`):

```ts
  u.searchParams.set("format", "full");
```

At the upsert (~:174), replace `bodyPreview: preview` with the trimmed real body. Keep `preview` if it still feeds a title deriver — check before deleting it:

```ts
  const rawBody = gmailMessageBodyText(m.payload ?? {});
  const body = stripQuotedTail(rawBody);
  // ...
    body,
```

Import `stripQuotedTail` from `../../../string/email-quoted-text.ts` and `gmailMessageBodyText` from `./message-body.ts`.

- [ ] **Step 6: Run the tests**

Run: `bun test packages/gateway/src/connectors/_lib/gmail/ packages/gateway/src/connectors/gmail-sync.test.ts`
Expected: PASS.

- [ ] **Step 7: Coverage on the new file, then typecheck/lint/commit**

Measure `message-body.ts` with the istanbul preload as in Task 3 Step 5; both figures ≥80%.

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json
bunx biome check --error-on-warnings packages/gateway/src/connectors
git add packages/gateway/src/connectors/_lib/gmail/ packages/gateway/src/connectors/gmail-sync.test.ts
git commit -m "feat(connectors): index real Gmail message bodies"
```

---

### Task 5: Outlook — declare `body`, select it explicitly

**Files:**

- Modify: `packages/gateway/src/connectors/outlook-sync.ts` (`GraphMessage` at :20-30, the upsert at :~47-65, the delta URL at :~102)
- Test: `packages/gateway/src/connectors/outlook-sync.test.ts`

**Interfaces:**

- Consumes: `stripQuotedTail` (Task 3), `plainTextFromHtml`.
- Produces: nothing downstream.

**`$select` goes on the INITIAL delta request only.** Graph carries the projection forward in `@odata.nextLink` / `@odata.deltaLink`; re-appending it to a followed link is wrong. The existing code already branches on whether a stored cursor is present (`outlook-sync.ts:93`) — put `$select` on the no-cursor branch.

- [ ] **Step 1: Write the failing tests**

```ts
test("indexes the Graph body with the quoted tail stripped", async () => {
  // delta response with one message whose body is
  //   { contentType: "html", content: "<p>Ship it.</p><p>On Mon, Ana wrote:</p>" }
  const row = db
    .query<{ body: string }, []>("SELECT body FROM item WHERE service = 'outlook'")
    .get();
  expect(row?.body).toBe("Ship it.");
});

test("contentType text passes through without HTML stripping", async () => {
  // body: { contentType: "text", content: "plain & simple" }
  expect(row?.body).toBe("plain & simple");
});

test("$select including body is on the initial delta request", async () => {
  // sync with cursor === null
  expect(seenUrl).toContain("%24select=");
  expect(decodeURIComponent(seenUrl)).toContain("body");
});

test("$select is NOT re-appended to a followed nextLink", async () => {
  // sync with a stored cursor holding an @odata.nextLink; assert the request
  // URL is exactly that link
  expect(seenUrl).toBe(storedNextLink);
});

test("a message with no body still indexes title-only", async () => {
  // delta response with a message omitting `body` entirely — the pre-upgrade
  // delta-link case: degrade, do not throw
  expect(row?.body_complete).toBe(0);
  expect(itemsUpserted).toBe(1);
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `bun test packages/gateway/src/connectors/outlook-sync.test.ts`
Expected: FAIL — `body` is the ~255-char `bodyPreview`, and no `$select` is sent.

- [ ] **Step 3: Declare the field**

```ts
type GraphMessage = {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
  lastModifiedDateTime?: string;
  webLink?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  "@removed"?: { reason?: string };
};
```

- [ ] **Step 4: Use it at the upsert**

```ts
  const raw = typeof m.body?.content === "string" ? m.body.content : "";
  const text =
    m.body?.contentType?.toLowerCase() === "text" ? raw : plainTextFromHtml(raw);
  const body = stripQuotedTail(text);
```

Then pass the discriminated arm, so a body-less message does not claim completeness:

```ts
  const bodyInput: IndexedItemBodyInput = body === "" ? { bodyPreview: "" } : { body };
```

and spread `...bodyInput` into the `upsertIndexedItemForSync` call in place of `bodyPreview: preview`. Keep `preview` only if it still feeds something else.

- [ ] **Step 5: Add `$select` to the initial request**

At the delta URL construction (~:102), on the branch taken when there is no stored cursor:

```ts
        `${GRAPH}/me/messages/delta?$top=${String(PAGE_SIZE)}` +
          `&$select=id,subject,bodyPreview,body,receivedDateTime,lastModifiedDateTime,webLink,from`,
```

Leave the followed-link branch untouched.

- [ ] **Step 6: Run, typecheck, lint, commit**

```bash
bun test packages/gateway/src/connectors/outlook-sync.test.ts
bunx tsc --noEmit -p packages/gateway/tsconfig.json
bunx biome check --error-on-warnings packages/gateway/src/connectors
git add packages/gateway/src/connectors/outlook-sync.ts packages/gateway/src/connectors/outlook-sync.test.ts
git commit -m "feat(connectors): index real Outlook message bodies"
```

---

### Task 6: `rebody` membership and the documentation

**Files:**

- Modify: `packages/gateway/src/ipc/index-rebody-rpc.ts`
- Modify: `docs/cli-reference.md`, `docs/roadmap.md`, `docs/CHANGELOG.md`
- Test: `packages/gateway/src/ipc/index-rebody-rpc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("gmail and outlook can now be improved by rebody", () => {
  expect(REBODY_IMPROVABLE_SERVICES.has("gmail")).toBe(true);
  expect(REBODY_IMPROVABLE_SERVICES.has("outlook")).toBe(true);
  expect(cannotImproveAmong({ gmail: 2, outlook: 1, zoom: 1 })).toEqual(["zoom"]);
});
```

Update any test asserting the membership count — it goes 11 → 13.

- [ ] **Step 2: Add both services and refresh the membership table**

Add `"gmail"` and `"outlook"` to `REBODY_IMPROVABLE_SERVICES`, keeping it alphabetically sorted.

The comment block above it carries a **"Membership verified"** table of `file:line` plus the actual expression per service, and explicitly excludes Gmail today ("Gmail is bounded-window (cheap) but its connector still never declares a full `body:`…"). That exclusion is now false and must be rewritten. **Re-open every referenced file and re-verify every row** — on the previous branch this table had drifted in two rows nobody had flagged. Add verified rows for gmail and outlook and bump the "Membership verified" date to 2026-08-04.

- [ ] **Step 3: Correct the depth documentation**

`docs/cli-reference.md`'s depth table currently says `summary` is a "first-N-tokens summary" and that depth applies at reindex time. Correct both: `summary` stores a 512-character prefix (there is no summariser), and depth is now enforced on **every sync** for every connector. State that `metadata_only` suppresses `body` and `body_preview` alike.

- [ ] **Step 4: The accounting and the Outlook upgrade note**

Run the authoritative grep first and treat it as the worklist:

```bash
grep -rn "12 full\|eleven services\|(12)" docs/*.md
```

Accounting goes **12 → 14 full**, 1 partial, 2 inert. Dated CHANGELOG entries are historical and are **never** retroactively edited — corrections go in the new dated entry.

Add a 2026-08-04 CHANGELOG entry covering: enforced depth + V49, Gmail and Outlook bodies, the trimmer, and — prominently — that **existing Outlook installs need one `nimbus index rebody --service outlook`**, because a stored `@odata.deltaLink` encodes the pre-`$select` projection and will keep returning body-less responses until the cursor is cleared. Without that note the feature reads as broken. Same for Gmail: already-indexed messages keep their snippets until a rebody.

Do **not** cite a PR number you have not verified; this branch has none until it is pushed.

- [ ] **Step 5: Verify and commit**

```bash
grep -rn "12 full\|eleven services" docs/    # expect no stale hits
bunx markdownlint-cli2 "docs/**/*.md"
git add packages/gateway/src/ipc/index-rebody-rpc.ts packages/gateway/src/ipc/index-rebody-rpc.test.ts docs/
git commit -m "feat(index): gmail and outlook are rebody-improvable; correct depth docs"
```

---

### Task 7: Full verification before the PR

**Files:** none modified unless a gate fails.

- [ ] **Step 1: Scoped suites**

Run: `bun test packages/gateway/src packages/cli/src`
Expected: PASS. Anything red is in scope — prove a failure pre-existing by checking out the merge-base (`git merge-base main HEAD`) and reproducing it there. Do **not** assume.

- [ ] **Step 2: Static gates**

```bash
bun run audit:invariants
bun run audit:any --check        # --check is load-bearing; without it this always exits 0
bunx tsc --noEmit -p packages/gateway/tsconfig.json
bunx biome check --error-on-warnings packages/gateway/src packages/cli/src
```

- [ ] **Step 3: Coverage floor — Docker/Linux authoritative**

```bash
bash scripts/coverage-floor/reseed-docker.sh
bun run audit:coverage-floor
git diff docs/structure-audit/coverage-baseline.json
```

**The reseed prints `ok` while ratcheting failing files into the baseline as permanent exceptions.** Its exit code is not the check — the check is that `"files"` is still `{}`. If any new file appears there, report FAILURE, name it, and `git checkout` the baseline. The reseed's `--update-baseline` may bump `generated_at`; discard that too so the final diff is empty.

- [ ] **Step 4: Documentation gates**

```bash
bun run audit:links          # NOT lint:links, which does not exist
bun run audit:doc-refs
bun run audit:status-drift
bunx markdownlint-cli2 "docs/**/*.md"
```

`audit:links` scopes to the whole branch, so a pre-existing broken link elsewhere still fails the PR.

- [ ] **Step 5: Dependency gate — it is time-dependent**

```bash
bun audit --audit-level high
bun run audit:advisories
```

Both run in the **same** required "Dependency audit" CI job, so a moderate finding fails it too. `bun audit` queries the live npm registry, so identical code can go red overnight on newly published advisories. If it fails, first prove it is not this branch (`git diff <merge-base>..HEAD -- '*package.json' 'bun.lock'`), then fix by pinning in the root `package.json` `overrides` block, staying within the current major.

- [ ] **Step 6: Hand back for the PR decision**

Do **not** push and do **not** open a PR. Report the per-gate results and stop; opening a PR is the human's call.

---

## Self-Review

**Spec coverage.** Depth enforcement → Tasks 1–2; three-level semantics → Task 2; V49 backfill → Task 1; trimmer with the tail rule → Task 3; Gmail `format=full` + MIME walk → Task 4; Outlook `body` + `$select` → Task 5; rebody membership, depth docs, accounting, the Outlook upgrade note → Task 6.

**Known deviation from the spec, flagged for the reviewer.** The spec says `metadata_only` writes NULL; Task 2 writes the empty string, because `upsertIndexedItem` derives `body_preview` from `body` and has no null-body path, and omitting the input would fall through to `?? row.title`. Every consumer predicate already treats `''` and NULL alike (`reindex.ts:53`). The implementer is instructed to surface this rather than let the reviewer find it.

**Ordering hazard.** Task 1 must precede Task 2. Enforcement before the backfill would truncate every existing index to 512 characters, because rows hold `'summary'` materialised rather than NULL.

**Type consistency.** `SyncContext.depth` is the inlined union `"metadata_only" | "summary" | "full"` in Tasks 2, 4 and 5 — matching how `SyncStatus` already inlines it in the same file, rather than importing `ReindexDepth`. `stripQuotedTail(body: string): string` is defined in Task 3 and called identically in Tasks 4 and 5. `gmailMessageBodyText(payload: MessagePayload): string` is defined and consumed within Task 4.
