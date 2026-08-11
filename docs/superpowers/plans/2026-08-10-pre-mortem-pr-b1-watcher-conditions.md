# pre-mortem PR B1 — Watcher Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the watcher engine two condition types that can actually fire — `incident_opened` and `deploy_failed` — and stop `watcher.create` from accepting a condition type the engine will silently ignore.

**Architecture:** Today `evaluateOneWatcher` hardcodes `condition_type !== "alert_fired"` and then queries `item WHERE type = 'alert'`, an item type nothing in this repository indexes. Replace that hardcode with one exported condition-kind table that maps a condition type to its item type plus an optional SQL predicate; the engine reads the table to build its query, and `watcher.create` reads the same table to reject unknown kinds. Everything downstream of the query — the service filter, the `since` window, the `LIMIT 5`, the graph predicate, the summary/snapshot shape — is untouched.

**Tech Stack:** Bun v1.2+, TypeScript strict (no `any`), `bun:sqlite`, `bun:test`, Biome.

## Global Constraints

- **No `any`** — use `unknown` for external data. TypeScript strict is non-negotiable.
- **I9 — bound-param SQL.** Every value goes through a bound parameter. The one interpolated SQL fragment in this plan (`kind.extraSql`) is a module-private compile-time constant, never derived from a row, a user, or an IPC parameter. It must stay that way.
- **I14 — SQLite writes in PRODUCTION code go through `dbRun`/`dbExec`/`dbStmtRun`.** This PR adds no production writes; do not introduce one. Test files are a different matter and are deliberately outside this rule: the D12 static audit does not scan `*.test.ts`, and many existing suites (e.g. `packages/gateway/src/agents/*.test.ts`) call `db.run` directly. Task 1's corrupt-row regression test does the same, intentionally.
- **Local error convention** — no repo-wide JSON-RPC error enum exists. Each IPC namespace has its own class over a raw integer. In `ipc/automation-rpc.ts` that is `AutomationRpcError(-32602, message)`. Do not invent an enum.
- **Coverage floor** — every source file must hold ≥85% line and ≥80% branch. The new file in Task 1 is small; its dedicated test file must cover every branch.
- **Branch** — work happens on `dev/asafgolombek/pre-mortem-pr-b` in the worktree at `.claude/worktrees/pre-mortem-pr-b`. Never commit to `main`.
- **Commit messages avoid backticks** — `git commit -m` command-substitutes backticked text out of the message.
- **Spec** — `docs/superpowers/specs/2026-08-10-pre-mortem-pr-b-design.md` (§ PR B1) is authoritative; `docs/superpowers/specs/2026-08-10-pre-mortem-pr-b-design-review-response.md` records what was deliberately excluded.

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/automation/watcher-condition-kinds.ts` **(new)** | The SSoT: which condition types exist, what item type each matches, and any extra SQL predicate. Nothing else. |
| `packages/gateway/src/automation/watcher-condition-kinds.test.ts` **(new)** | Table membership and lookup, including every branch of the lookup helper. |
| `packages/gateway/src/automation/watcher-engine.ts` **(modify, lines 86-120)** | Reads the table instead of hardcoding `alert_fired` / `type = 'alert'`. |
| `packages/gateway/src/automation/watcher-engine.test.ts` **(modify, append)** | Firing behaviour per condition, and the negative cases that pin the stated coverage limits. |
| `packages/gateway/src/ipc/automation-rpc.ts` **(modify, `watcher.create` at line 114)** | Rejects an unknown `conditionType` with `-32602`. |
| `packages/gateway/src/ipc/automation-rpc.test.ts` **(modify, lines ~240-320)** | Existing tests pass `conditionType: "schedule"`, a placeholder that is not a real condition type anywhere in production code. They must move to a real one, plus a new rejection test. |
| `docs/architecture.md` **(modify, ~line 1016-1030)** | The watcher-engine section documents `alert_fired` as the condition type. Record all three. |

---

### Task 1: The condition-kind table, and an engine that reads it

**Files:**

- Create: `packages/gateway/src/automation/watcher-condition-kinds.ts`
- Create: `packages/gateway/src/automation/watcher-condition-kinds.test.ts`
- Modify: `packages/gateway/src/automation/watcher-engine.ts` (lines 86-120)
- Test: `packages/gateway/src/automation/watcher-engine.test.ts` (append cases)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces, for Task 2 and for PR B2:
  - `type WatcherConditionKind = { readonly conditionType: string; readonly itemType: string; readonly extraSql: string }`
  - `const WATCHER_CONDITION_KINDS: readonly WatcherConditionKind[]`
  - `function watcherConditionKind(conditionType: string): WatcherConditionKind | undefined`
  - `function isKnownWatcherConditionType(conditionType: string): boolean`

**Context the implementer needs.** `evaluateOneWatcher` is module-private and called from two exported entry points, `evaluateWatchersAfterSync` and `evaluateWatchersStartupCatchUp`. Both already pass through it, so changing it once covers both. The existing test at `watcher-engine.test.ts:71` (`"non-alert_fired condition does not notify"`) uses `condition_type: "custom"`; `"custom"` is absent from the new table, so that test must stay green unchanged — treat it as a regression check, not something to edit.

**Why the extra predicate lives in SQL and not in a TypeScript filter after the query:** the query ends in `LIMIT 5`. Filtering afterwards would let five successful deployments hide a failed sixth, so a `deploy_failed` watcher would miss real failures whenever a service deploys often. The predicate must narrow the rows the database returns.

> **CORRECTION (applied after the whole-branch review, 2026-08-10).** This task's code and test blocks
> originally gave `incident_opened` an empty predicate and seeded a status-less incident. That was
> wrong: `connectors/pagerduty-sync.ts` fetches **all** statuses and stamps `modified_at` from
> `updated_at`, so an acknowledge or a resolve would fire a condition named "opened". The blocks below
> carry the shipped predicate — `AND json_valid(metadata) AND json_extract(metadata, '$.status') =
> 'triggered'` — and the fixtures set `metadata: { status: "triggered" }`. Following this task as
> written now reproduces what merged. The trade-off it buys is recorded in `docs/architecture.md`: an
> incident indexed with a null or absent status never fires the condition at all.

- [ ] **Step 1: Write the failing test for the table module**

Create `packages/gateway/src/automation/watcher-condition-kinds.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  isKnownWatcherConditionType,
  WATCHER_CONDITION_KINDS,
  watcherConditionKind,
} from "./watcher-condition-kinds.ts";

describe("watcher-condition-kinds", () => {
  test("the table holds exactly the three supported condition types", () => {
    expect(WATCHER_CONDITION_KINDS.map((k) => k.conditionType).sort()).toEqual([
      "alert_fired",
      "deploy_failed",
      "incident_opened",
    ]);
  });

  test("each kind names the item type it matches", () => {
    expect(watcherConditionKind("alert_fired")?.itemType).toBe("alert");
    expect(watcherConditionKind("incident_opened")?.itemType).toBe("incident");
    expect(watcherConditionKind("deploy_failed")?.itemType).toBe("deployment");
  });

  test("only deploy_failed carries an extra predicate, and it is json_valid-guarded", () => {
    expect(watcherConditionKind("alert_fired")?.extraSql).toBe("");
    expect(watcherConditionKind("incident_opened")?.extraSql).toContain("'triggered'");
    expect(watcherConditionKind("deploy_failed")?.extraSql).toContain("conclusion");
    // Pinned deliberately: without json_valid, a single non-JSON metadata row makes json_extract
    // raise and takes down evaluation for every watcher.
    expect(watcherConditionKind("deploy_failed")?.extraSql).toContain("json_valid(metadata)");
  });

  test("an unknown condition type resolves to undefined and is not known", () => {
    expect(watcherConditionKind("schedule")).toBeUndefined();
    expect(isKnownWatcherConditionType("schedule")).toBe(false);
    expect(isKnownWatcherConditionType("incident_opened")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/automation/watcher-condition-kinds.test.ts`
Expected: FAIL — the module does not exist ("Cannot find module ./watcher-condition-kinds.ts").

- [ ] **Step 3: Write the table module**

Create `packages/gateway/src/automation/watcher-condition-kinds.ts`:

```ts
/**
 * The single source of truth for which watcher conditions the engine can evaluate.
 *
 * `watcher-engine.ts` builds its item query from this table, and `ipc/automation-rpc.ts`
 * rejects a `watcher.create` whose condition type is absent from it. Keeping both readers on
 * one table is the point: a creation path that accepted a condition the engine cannot evaluate
 * would produce a watcher that is silently inert forever.
 *
 * `extraSql` is a COMPILE-TIME CONSTANT fragment ANDed into that query. It is never derived from
 * a row, a user, or an IPC parameter, and must never become so — every value in the query is a
 * bound parameter (I9).
 */
export type WatcherConditionKind = {
  /** The value stored in `watcher.condition_type`. */
  readonly conditionType: string;
  /** The `item.type` this condition observes. */
  readonly itemType: string;
  /** Constant SQL ANDed into the item query, or "" for none. */
  readonly extraSql: string;
};

export const WATCHER_CONDITION_KINDS: readonly WatcherConditionKind[] = [
  // Preserved as-is. NOTE: no connector indexes `item.type = 'alert'` today, so this condition
  // cannot currently fire. That is the pre-existing state, recorded rather than silently fixed.
  { conditionType: "alert_fired", itemType: "alert", extraSql: "" },
  // PagerDuty indexes `type: "incident"` (connectors/pagerduty-sync.ts).
  // Narrowed to triggered-only: pagerduty-sync.ts fetches ALL statuses and stamps modified_at
  // from updated_at, so without this an acknowledge or resolve fires a condition named "opened".
  // Trade-off recorded in docs/architecture.md: an incident indexed with a null/absent status
  // (the sync writes status ?? null) never fires this condition at all.
  {
    conditionType: "incident_opened",
    itemType: "incident",
    extraSql: "AND json_valid(metadata) AND json_extract(metadata, '$.status') = 'triggered'",
  },
  // CI-annotated deployments only: `deployment/annotate.ts` writes metadata.conclusion. Vercel
  // records its outcome under metadata.state, and Prefect indexes deployment DEFINITIONS with no
  // outcome at all, so neither matches. Keyed on the presence of the conclusion value rather than
  // on a producer name, so a new producer that adopts the same shape works without a code change.
  //
  // `json_valid(metadata)` is LOAD-BEARING, not defensive noise: SQLite's json_extract RAISES
  // "malformed JSON" on a non-JSON TEXT value, and that exception would propagate out of
  // evaluateOneWatcher through the whole evaluateWatchersAfterSync loop — killing evaluation for
  // EVERY watcher, not just this one. (A NULL metadata is safe on its own; an empty string or
  // plain text is not.) Every production writer stringifies today, so this guards a migration or a
  // future writer, at the cost of one cheap call.
  //
  // Extending to Vercel later means matching a DIFFERENT key with a different vocabulary
  // (metadata.state = 'ERROR'). A single extraSql string can express that as an OR, but the moment
  // a second shape lands, prefer widening this type to hold several predicates per kind over
  // growing one unreadable SQL string.
  {
    conditionType: "deploy_failed",
    itemType: "deployment",
    extraSql: "AND json_valid(metadata) AND json_extract(metadata, '$.conclusion') = 'failure'",
  },
];

export function watcherConditionKind(conditionType: string): WatcherConditionKind | undefined {
  return WATCHER_CONDITION_KINDS.find((k) => k.conditionType === conditionType);
}

export function isKnownWatcherConditionType(conditionType: string): boolean {
  return watcherConditionKind(conditionType) !== undefined;
}
```

- [ ] **Step 4: Run the table test to confirm it passes**

Run: `bun test packages/gateway/src/automation/watcher-condition-kinds.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing engine tests**

Append inside the existing `describe("watcher-engine", ...)` block in `packages/gateway/src/automation/watcher-engine.test.ts`. `upsertIndexedItem` is already imported at the top of that file; `insertWatcher` likewise.

```ts
  test("incident_opened fires on an indexed incident", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertWatcher(db, {
      name: "incidents",
      enabled: 1,
      condition_type: "incident_opened",
      condition_json: JSON.stringify({ filter: { service: "pagerduty" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "INC-1",
      title: "api-gateway 500s",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
      metadata: { status: "triggered" },
    });

    const bodies: string[] = [];
    evaluateWatchersAfterSync(db, "pagerduty", t0 + 2000, (_title, body) => {
      bodies.push(body);
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("api-gateway 500s");
  });

  test("incident_opened respects the service filter", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertWatcher(db, {
      name: "incidents",
      enabled: 1,
      condition_type: "incident_opened",
      condition_json: JSON.stringify({ filter: { service: "pagerduty" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "opsgenie",
      type: "incident",
      externalId: "OG-1",
      title: "other tracker",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
      metadata: { status: "triggered" },
    });

    let calls = 0;
    evaluateWatchersStartupCatchUp(db, t0 + 2000, () => {
      calls += 1;
    });

    expect(calls).toBe(0);
  });

  test("deploy_failed fires only on a failed deployment, not a successful one", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertWatcher(db, {
      name: "deploys",
      enabled: 1,
      condition_type: "deploy_failed",
      condition_json: JSON.stringify({ filter: { service: "github_actions" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "github_actions",
      type: "deployment",
      externalId: "deploy-ok",
      title: "checkout v2.1.0",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
      metadata: { conclusion: "success" },
    });
    upsertIndexedItem(db, {
      service: "github_actions",
      type: "deployment",
      externalId: "deploy-bad",
      title: "checkout v2.1.1",
      modifiedAt: t0 + 2000,
      syncedAt: t0 + 2000,
      metadata: { conclusion: "failure" },
    });

    const bodies: string[] = [];
    evaluateWatchersAfterSync(db, "github_actions", t0 + 3000, (_title, body) => {
      bodies.push(body);
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("checkout v2.1.1");
    expect(bodies[0]).not.toContain("v2.1.0");
  });

  test("deploy_failed does not match a Vercel-shaped deployment, whose outcome is in metadata.state", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertWatcher(db, {
      name: "deploys",
      enabled: 1,
      condition_type: "deploy_failed",
      condition_json: JSON.stringify({ filter: { service: "vercel" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "vercel",
      type: "deployment",
      externalId: "dpl_1",
      title: "marketing-site",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
      metadata: { state: "ERROR", target: "production" },
    });

    let calls = 0;
    evaluateWatchersAfterSync(db, "vercel", t0 + 2000, () => {
      calls += 1;
    });

    expect(calls).toBe(0);
  });

  test("a row with non-JSON metadata does not break deploy_failed evaluation", () => {
    const db = makeDb();
    const t0 = 5_400_000_000_000;
    insertWatcher(db, {
      name: "deploys",
      enabled: 1,
      condition_type: "deploy_failed",
      condition_json: JSON.stringify({ filter: { service: "github_actions" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "github_actions",
      type: "deployment",
      externalId: "deploy-legacy",
      title: "legacy row",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
    });
    upsertIndexedItem(db, {
      service: "github_actions",
      type: "deployment",
      externalId: "deploy-bad",
      title: "checkout v3.0.0",
      modifiedAt: t0 + 2000,
      syncedAt: t0 + 2000,
      metadata: { conclusion: "failure" },
    });
    // No production writer can produce this today — both item.metadata writers stringify — so it
    // is forced directly. Without json_valid() in the predicate, json_extract raises
    // "malformed JSON" here and the exception escapes the whole evaluation loop.
    db.run("UPDATE item SET metadata = 'not json' WHERE external_id = ?", ["deploy-legacy"]);

    const bodies: string[] = [];
    evaluateWatchersAfterSync(db, "github_actions", t0 + 3000, (_title, body) => {
      bodies.push(body);
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("checkout v3.0.0");
  });

  test("a graph predicate still narrows a new condition kind", () => {
    const db = makeDb();
    const t0 = 5_200_000_000_000;
    insertWatcher(db, {
      name: "incidents-owned",
      enabled: 1,
      condition_type: "incident_opened",
      condition_json: JSON.stringify({ filter: { service: "pagerduty" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
      graph_predicate_json: JSON.stringify({
        relation: "owned_by",
        target: { type: "person", externalId: "gh:absent" },
      }),
    });
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "INC-9",
      title: "unowned incident",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
      metadata: { status: "triggered" },
    });

    let calls = 0;
    evaluateWatchersAfterSync(
      db,
      "pagerduty",
      t0 + 2000,
      () => {
        calls += 1;
      },
      { graphConditionsEnabled: true },
    );

    expect(calls).toBe(0);
  });
```

`incident` and `deployment` are both valid graph entity types (`graph/relationship-graph.ts:6-22`),
so the predicate path applies to the new kinds exactly as it does to `alert_fired`. The predicate is
evaluated against `r.type` / `r.external_id` after the query, so this test guards against the
predicate being skipped for a new kind. On its own it cannot prove the predicate ran — it passes
identically if the row fetch returns nothing — so it is the sibling firing tests, which assert the
same fixture shape *does* notify without a predicate, that establish rows are actually fetched.

- [ ] **Step 6: Run the engine tests to confirm they fail**

Run: `bun test packages/gateway/src/automation/watcher-engine.test.ts`
Expected: the two firing tests FAIL (0 notifications, because `evaluateOneWatcher` still returns `null` for any condition other than `alert_fired`). The two negative tests PASS already, for the wrong reason — that is expected and is exactly why the firing tests exist alongside them.

- [ ] **Step 7: Make the engine read the table**

In `packages/gateway/src/automation/watcher-engine.ts`, add to the imports:

```ts
import { watcherConditionKind } from "./watcher-condition-kinds.ts";
```

Replace the guard at lines 86-88:

```ts
  if (w.condition_type !== "alert_fired") {
    return null;
  }
```

with:

```ts
  const kind = watcherConditionKind(w.condition_type);
  if (kind === undefined) {
    return null;
  }
```

Then replace the query at lines 104-113 — note `type = ?` is now bound, and `kind.extraSql` is the only interpolation:

```ts
  const since = w.last_checked_at ?? w.created_at;
  const rows = db
    .query(
      `SELECT id, title, service, type, external_id, modified_at FROM item
       WHERE type = ?
         AND modified_at > ?
         AND (? IS NULL OR service = ?)
         ${kind.extraSql}
       ORDER BY modified_at DESC
       LIMIT 5`,
    )
    .all(kind.itemType, since, service ?? null, service ?? null) as Array<{
    id: string;
    title: string;
    service: string;
    type: string;
    external_id: string;
    modified_at: number;
  }>;
```

Everything below line 120 — the graph predicate block, the filter, the summary and snapshot — stays exactly as it is.

- [ ] **Step 8: Run the whole automation suite to confirm green**

Run: `bun test packages/gateway/src/automation/`
Expected: PASS. Specifically confirm `"non-alert_fired condition does not notify"` is still green — it uses `condition_type: "custom"`, which is absent from the table, so the unknown-kind path is still covered.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/automation/watcher-condition-kinds.ts \
        packages/gateway/src/automation/watcher-condition-kinds.test.ts \
        packages/gateway/src/automation/watcher-engine.ts \
        packages/gateway/src/automation/watcher-engine.test.ts
git commit -m "feat(automation): add incident_opened and deploy_failed watcher conditions"
```

---

### Task 2: Reject an unknown condition type at creation

**Files:**

- Modify: `packages/gateway/src/ipc/automation-rpc.ts` (the `watcher.create` handler, line 114)
- Test: `packages/gateway/src/ipc/automation-rpc.test.ts` (lines ~240-320)

**Interfaces:**

- Consumes: `isKnownWatcherConditionType` from Task 1.
- Produces: nothing new for later tasks.

**Context the implementer needs.** `watcher.create` currently passes `conditionType` straight into `insertWatcher` as an unvalidated string (`automation-rpc.ts:122`), so a watcher with a nonsense condition is accepted and then never fires. Three existing tests in `automation-rpc.test.ts` pass `conditionType: "schedule"` as a throwaway placeholder — `"schedule"` is not a watcher condition type anywhere in production code (the only repo matches are unrelated connector fields in `databricks-job-mapping.ts`, `dbt-job-mapping.ts` and `prefect-deployment-mapping.ts`). Those tests must move to a real condition type. **This validation applies to creation only.** Existing rows with unknown condition types are untouched and keep their current behaviour of never firing, so no migration or backfill is needed.

Scope discipline: this is a membership check and nothing more. Do **not** add validation of `condition_json`, of whether the filtered service exists, or of whether any item currently matches — a watcher is a forward-looking subscription, and a service with no incidents yet is the normal case for one worth arming.

- [ ] **Step 1: Write the failing test**

In `packages/gateway/src/ipc/automation-rpc.test.ts`, inside `describe("watcher.create / pause / resume / delete", ...)`, add:

```ts
  test("create rejects a condition type the engine cannot evaluate", async () => {
    const db = seededDb();
    await expect(
      dispatchAutomationRpc({
        method: "watcher.create",
        params: {
          name: "bogus",
          conditionType: "schedule",
          conditionJson: "{}",
          actionType: "notify",
          actionJson: "{}",
        },
        db,
      }),
    ).rejects.toThrow(AutomationRpcError);

    expect((db.query("SELECT COUNT(*) AS n FROM watcher").get() as { n: number }).n).toBe(0);
  });

  test("create accepts every supported condition type", async () => {
    const db = seededDb();
    for (const conditionType of ["alert_fired", "incident_opened", "deploy_failed"]) {
      const out = await dispatchAutomationRpc({
        method: "watcher.create",
        params: {
          name: `w-${conditionType}`,
          conditionType,
          conditionJson: "{}",
          actionType: "notify",
          actionJson: "{}",
        },
        db,
      });
      expect(out.kind).toBe("hit");
    }
    expect((db.query("SELECT COUNT(*) AS n FROM watcher").get() as { n: number }).n).toBe(3);
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/ipc/automation-rpc.test.ts`
Expected: `"create rejects a condition type the engine cannot evaluate"` FAILS — the call succeeds and one row is written instead of zero.

- [ ] **Step 3: Add the membership check**

In `packages/gateway/src/ipc/automation-rpc.ts`, add to the imports (alongside the existing `../automation/...` imports):

```ts
import { isKnownWatcherConditionType } from "../automation/watcher-condition-kinds.ts";
```

Then in the `watcher.create` handler at line 114, insert the check before the `insertWatcher` call:

```ts
  "watcher.create": (rec, ctx) => {
    const graphPredicateJson =
      rec !== undefined && typeof rec["graphPredicateJson"] === "string"
        ? rec["graphPredicateJson"]
        : null;
    const name = requireString(rec, "name");
    const conditionType = requireString(rec, "conditionType");
    if (!isKnownWatcherConditionType(conditionType)) {
      throw new AutomationRpcError(
        -32602,
        `Unsupported conditionType "${conditionType}" — the watcher engine cannot evaluate it`,
      );
    }
    const id = insertWatcher(ctx.db, {
      name,
      enabled: 1,
      condition_type: conditionType,
      condition_json: requireString(rec, "conditionJson"),
      action_type: requireString(rec, "actionType"),
      action_json: requireString(rec, "actionJson"),
      created_at: Date.now(),
      graph_predicate_json: graphPredicateJson,
    });
    return { kind: "hit", value: { id } };
  },
```

- [ ] **Step 4: Update the three placeholder tests**

There are **exactly five** pre-existing occurrences of `conditionType: "schedule"` in this file, at lines **247, 270, 293, 309 and 337**. Every one is a throwaway placeholder in a test about something else (graph-predicate storage, pause/resume, delete), so change each value to `"alert_fired"` and change nothing else about those tests.

Verify before moving on:

```bash
grep -c 'conditionType: "schedule"' packages/gateway/src/ipc/automation-rpc.test.ts
```

Expected: `1` — only the deliberate rejection test added in Step 1. If the count is higher, a placeholder was missed and its test will fail in Step 5.

`AutomationRpcError` is already imported at line 17 of this test file, so the rejection test needs no new import.

- [ ] **Step 5: Run the IPC tests to confirm they pass**

Run: `bun test packages/gateway/src/ipc/automation-rpc.test.ts`
Expected: PASS, including both new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/automation-rpc.ts packages/gateway/src/ipc/automation-rpc.test.ts
git commit -m "feat(ipc): reject a watcher conditionType the engine cannot evaluate"
```

---

### Task 3: Documentation and ship-readiness

**Files:**

- Modify: `docs/architecture.md` (watcher-engine section, ~lines 1016-1030)
- Modify: `docs/CHANGELOG.md` (add a dated entry)

**Interfaces:**

- Consumes: the finished behaviour from Tasks 1 and 2.
- Produces: nothing consumed by later tasks.

**Context the implementer needs.** `docs/architecture.md:1016` describes the watcher engine and its example JSON at line ~1025 shows `"condition_type": "alert_fired"` as though it were the only one. The repository's triple rule is that wiring, docs and tests land together, so this is part of the work rather than a follow-up. `docs/CHANGELOG.md` is the canonical dated delivery log — connector and feature deliveries go there, **not** in the CLAUDE.md status line.

- [ ] **Step 1: Document the three condition types**

In `docs/architecture.md`, in the watcher-engine section, add a table immediately after the paragraph at line 1016 that introduces `condition_type`:

```markdown
| `condition_type` | Fires on | Coverage |
| --- | --- | --- |
| `alert_fired` | an indexed item of type `alert` | no connector currently indexes `alert`, so this condition cannot fire today |
| `incident_opened` | an indexed item of type `incident` | PagerDuty |
| `deploy_failed` | an indexed item of type `deployment` whose `metadata.conclusion` is `failure` | CI-annotated deployments (`POST /v1/deployments`) only — Vercel records its outcome under `metadata.state`, and Prefect indexes deployment definitions with no outcome |

`watcher.create` rejects any other `condition_type` with `-32602`, so a watcher that the engine
could never evaluate cannot be created.
```

- [ ] **Step 2: Add the CHANGELOG entry**

In `docs/CHANGELOG.md`, add an entry under the current unreleased/dated heading, matching the file's existing style:

```markdown
- **Watcher conditions — `incident_opened` + `deploy_failed`** (2026-08-10) — the watcher engine
  previously evaluated one condition type, `alert_fired`, which matches an item type no connector
  indexes; a watcher could be created and armed and still never fire. Both new conditions come from
  one condition-kind table that the engine and `watcher.create` share, so an unsupported
  `conditionType` is now rejected at creation rather than accepted and silently ignored.
  `deploy_failed` covers CI-annotated deployments only. Groundwork for `nimbus pre-mortem` PR B.
```

- [ ] **Step 3: Run the full fast pre-flight**

Run: `bun run preflight:fast`
Expected: PASS. If it fails, fix it here — do not push red. Note that pre-flight fail-fasts, so an early lint failure hides every later gate; re-run to green after each fix rather than assuming the rest passed.

- [ ] **Step 4: Run the gateway suites that this PR touches**

Run: `bun test packages/gateway/src/automation/ packages/gateway/src/ipc/automation-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Check the coverage floor for the new file**

Run: `bun run audit:coverage-floor`
Expected: no violation for `watcher-condition-kinds.ts` or `watcher-engine.ts`. This gate is **CI-Linux-authoritative** — a Windows run reports false violations, so confirm what `git diff --name-only` actually contains before believing a failure, and reproduce through Docker if it disagrees with CI.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md docs/CHANGELOG.md
git commit -m "docs: record the three watcher condition types and their coverage limits"
```

---

## Out of scope for B1

Named so an implementer does not helpfully add them:

- Any change to `watcher.validateCondition` — it validates the graph predicate and never receives a `conditionType`.
- Validating `condition_json`, service existence, or whether any item matches today.
- A new condition type for anything else (cycle time, review drag) — the spec deliberately proposes no watcher for risks with no watchable condition.
- Indexing `item.type = 'alert'` so `alert_fired` can fire, or teaching `deploy_failed` about Vercel's `metadata.state`. Both are real gaps; both are separate changes.
- Anything from PR B2: the agent, the CLI command, watcher creation from pre-mortem, `premortem_watcher_proposal` writes, and the Tauri `ALLOWED_METHODS` bump.
