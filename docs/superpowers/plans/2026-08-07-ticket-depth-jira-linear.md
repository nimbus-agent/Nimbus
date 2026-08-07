# Ticket Depth (Jira + Linear) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Jira and Linear connectors enough indexed depth — issue type, normalized status
category, created/resolved/due timestamps, parent and project — plus a user-initiated history
backfill, so `nimbus pre-mortem` can select epics, tell delivered from in-flight, and measure cycle
time.

**Architecture:** Two sync mappers write a shared, service-agnostic metadata contract built by one
new pure helper module. A new optional `SyncContext.historyFloorMs` lets an explicit
`nimbus index rebody --since <days>` widen each connector's hardcoded 30-day cold-start floor for one
run; the scheduler holds that floor in memory until a run completes. `rebody`'s eligibility widens
from "body incomplete" to "body incomplete OR metadata below the required version".

**Tech Stack:** Bun v1.2+, TypeScript strict, `bun:sqlite`, `bun:test`, Biome.

Design spec: `docs/superpowers/specs/2026-08-07-ticket-depth-jira-linear-design.md`
(+ its `-review` / `-review-response`).

## Global Constraints

- **No `any`** — external API payloads are `unknown`, narrowed with the existing `asRecord` /
  `stringField` helpers from `connectors/atlassian-api-sync-helpers.ts`.
- **No migration, no new item type, no new relation type.** `item.metadata` is a JSON column;
  new keys need no schema change.
- **Timestamps are epoch milliseconds.** A missing or unparseable value omits the key entirely —
  never `0`, never `NaN`, never `null`.
- **Never branch a consumer on service.** `status_category` is normalized at the mapper.
- **Never read Done-ness from a display name.** Only `statusCategory.key` (Jira) / `state.type`
  (Linear).
- **Existing behavior must not change when the new flag is absent** — `historyFloorMs` is optional,
  and both connectors fall back to their own `initialSyncDepthDays = 30`.
- Branch: `dev/asafgolombek/ticket-depth-jira-linear`, worktree `.claude/worktrees/ticket-depth`.
  All file paths below are repo-root-relative; edit them at the **worktree** absolute path.
- Run `bun run preflight:fast` before the final commit of the branch.

---

### Task 1: Shared ticket-depth helpers

The normalization tables and the timestamp parser both mappers depend on. Pure functions, no I/O —
so the tricky semantics (Jira has no `canceled`; an unknown value is not `todo`) get tested once
rather than twice.

**Files:**

- Create: `packages/gateway/src/connectors/ticket-depth.ts`
- Create: `packages/gateway/src/connectors/ticket-depth.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type TicketStatusCategory = "todo" | "in_progress" | "done" | "canceled" | "unknown"`
  - `normalizeJiraStatusCategory(raw: string | undefined): TicketStatusCategory`
  - `normalizeLinearStateType(raw: string | undefined): TicketStatusCategory`
  - `msFromIso(raw: string | undefined): number | undefined`
  - `const TICKET_META_VERSION = 1`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/ticket-depth.test.ts`:

```ts
import { expect, test } from "bun:test";

import {
  msFromIso,
  normalizeJiraStatusCategory,
  normalizeLinearStateType,
  TICKET_META_VERSION,
} from "./ticket-depth.ts";

test("jira status categories normalize to the shared vocabulary", () => {
  expect(normalizeJiraStatusCategory("new")).toBe("todo");
  expect(normalizeJiraStatusCategory("indeterminate")).toBe("in_progress");
  expect(normalizeJiraStatusCategory("done")).toBe("done");
});

test("jira never yields canceled - it folds Won't Do into done", () => {
  // Jira exposes the distinction only via fields.resolution, which this PR
  // does not fetch. A consumer must read a Jira `done` as "closed, outcome
  // unknown"; if this ever returns "canceled" the contract has drifted.
  const all = ["new", "indeterminate", "done"].map(normalizeJiraStatusCategory);
  expect(all).not.toContain("canceled");
});

test("linear state types normalize, keeping canceled distinct from completed", () => {
  expect(normalizeLinearStateType("backlog")).toBe("todo");
  expect(normalizeLinearStateType("unstarted")).toBe("todo");
  expect(normalizeLinearStateType("started")).toBe("in_progress");
  expect(normalizeLinearStateType("completed")).toBe("done");
  expect(normalizeLinearStateType("canceled")).toBe("canceled");
});

test("an unrecognized or absent category is unknown, never todo", () => {
  // "todo" would read as "not started yet" and silently distort every cohort
  // the pre-mortem agent builds. Fail visibly instead.
  expect(normalizeJiraStatusCategory("something-new")).toBe("unknown");
  expect(normalizeLinearStateType("triage")).toBe("unknown");
  expect(normalizeJiraStatusCategory(undefined)).toBe("unknown");
  expect(normalizeLinearStateType("")).toBe("unknown");
});

test("msFromIso returns epoch ms, or undefined for anything unusable", () => {
  expect(msFromIso("2026-01-15T10:30:00.000Z")).toBe(Date.parse("2026-01-15T10:30:00.000Z"));
  expect(msFromIso("2026-01-15")).toBe(Date.parse("2026-01-15"));
  expect(msFromIso(undefined)).toBeUndefined();
  expect(msFromIso("")).toBeUndefined();
  expect(msFromIso("not-a-date")).toBeUndefined();
});

test("the metadata version is 1", () => {
  expect(TICKET_META_VERSION).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/ticket-depth.test.ts`
Expected: FAIL — `Cannot find module './ticket-depth.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/connectors/ticket-depth.ts`:

```ts
/**
 * Shared depth helpers for the ticket connectors (Jira, Linear).
 *
 * `status_category` is normalized HERE rather than passed through, because the
 * two platforms disagree on vocabulary and a raw value would force every
 * consumer to branch on service. The platform's own value is preserved
 * alongside it as `status_category_raw`, so normalizing never destroys
 * information.
 */

export type TicketStatusCategory = "todo" | "in_progress" | "done" | "canceled" | "unknown";

/** Bump when a mapper starts writing a key consumers may rely on. Drives `rebody` eligibility. */
export const TICKET_META_VERSION = 1;

const JIRA_STATUS_CATEGORY: Readonly<Record<string, TicketStatusCategory>> = {
  new: "todo",
  indeterminate: "in_progress",
  // Jira folds "Won't Do" / "Canceled" resolutions into `done`; the
  // distinction lives in `fields.resolution`, which the sync does not fetch.
  // So `canceled` is unreachable on Jira by construction, not by omission.
  done: "done",
};

const LINEAR_STATE_TYPE: Readonly<Record<string, TicketStatusCategory>> = {
  backlog: "todo",
  unstarted: "todo",
  started: "in_progress",
  completed: "done",
  canceled: "canceled",
};

function lookup(
  table: Readonly<Record<string, TicketStatusCategory>>,
  raw: string | undefined,
): TicketStatusCategory {
  if (raw === undefined || raw === "") {
    return "unknown";
  }
  // An unrecognized value must NOT fall back to "todo" — that reads as "not
  // started yet" and would quietly distort every cohort a consumer builds.
  return table[raw] ?? "unknown";
}

export function normalizeJiraStatusCategory(raw: string | undefined): TicketStatusCategory {
  return lookup(JIRA_STATUS_CATEGORY, raw);
}

export function normalizeLinearStateType(raw: string | undefined): TicketStatusCategory {
  return lookup(LINEAR_STATE_TYPE, raw);
}

/**
 * Epoch milliseconds from an ISO-8601 string, or `undefined` when the value is
 * absent or unparseable. Never 0 and never NaN: a consumer must be able to
 * tell "no due date" from "due at the epoch".
 */
export function msFromIso(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/ticket-depth.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/ticket-depth.ts packages/gateway/src/connectors/ticket-depth.test.ts
git commit -m "feat(gateway): shared ticket-depth normalization helpers"
```

---

### Task 2: Jira mapper writes the depth contract

**Files:**

- Modify: `packages/gateway/src/connectors/jira-sync.ts` — the `fields` array at `:148`, and the
  `metadata` object at `:273`
- Modify: `packages/gateway/src/connectors/jira-sync.test.ts` (append tests)

**Interfaces:**

- Consumes: `normalizeJiraStatusCategory`, `msFromIso`, `TICKET_META_VERSION` (Task 1).
- Produces: `jira:issue` rows whose `metadata` carries `jiraId`, `key`, `meta_v`, and — when the API
  supplies them — `issue_type`, `status`, `status_category`, `status_category_raw`,
  `created_at_ms`, `resolved_at_ms`, `due_at_ms`, `parent_key`. Task 3 mirrors these key names
  exactly for Linear.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/connectors/jira-sync.test.ts`. Note the existing `makeIssue` helper
spreads a `fields` object — pass depth fields through it the same way the file's other tests pass
`updated`/`creator`.

```ts
test("jira issue metadata carries the ticket-depth contract", async () => {
  const { db, ctx } = credCtx();
  const issue = {
    id: "10001",
    key: "PROJ-7",
    fields: {
      summary: "Ship the thing",
      updated: "2026-02-01T00:00:00.000Z",
      created: "2026-01-01T00:00:00.000Z",
      resolutiondate: "2026-01-20T00:00:00.000Z",
      duedate: "2026-01-15",
      issuetype: { name: "Epic" },
      status: { name: "Shipped To Prod", statusCategory: { key: "done" } },
      parent: { key: "PROJ-1" },
    },
  };
  await runJiraSyncWithIssues(ctx, [issue]);

  const row = db
    .query("SELECT metadata FROM item WHERE external_id = ?")
    .get("PROJ-7") as { metadata: string };
  const meta = JSON.parse(row.metadata) as Record<string, unknown>;

  expect(meta["issue_type"]).toBe("Epic");
  expect(meta["status"]).toBe("Shipped To Prod");
  // Normalized, NOT the renamed display status.
  expect(meta["status_category"]).toBe("done");
  expect(meta["status_category_raw"]).toBe("done");
  expect(meta["created_at_ms"]).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  expect(meta["resolved_at_ms"]).toBe(Date.parse("2026-01-20T00:00:00.000Z"));
  expect(meta["due_at_ms"]).toBe(Date.parse("2026-01-15"));
  expect(meta["parent_key"]).toBe("PROJ-1");
  expect(meta["meta_v"]).toBe(1);
  // Pre-existing keys survive.
  expect(meta["jiraId"]).toBe("10001");
  expect(meta["key"]).toBe("PROJ-7");
});

test("a renamed jira status does not change the normalized category", async () => {
  const { db, ctx } = credCtx();
  await runJiraSyncWithIssues(ctx, [
    {
      id: "10002",
      key: "PROJ-8",
      fields: {
        summary: "In flight",
        updated: "2026-02-01T00:00:00.000Z",
        status: { name: "Yak Shaving", statusCategory: { key: "indeterminate" } },
      },
    },
  ]);
  const row = db
    .query("SELECT metadata FROM item WHERE external_id = ?")
    .get("PROJ-8") as { metadata: string };
  const meta = JSON.parse(row.metadata) as Record<string, unknown>;
  expect(meta["status_category"]).toBe("in_progress");
  expect(meta["status"]).toBe("Yak Shaving");
});

test("absent jira depth fields omit their keys rather than writing zeros", async () => {
  const { db, ctx } = credCtx();
  await runJiraSyncWithIssues(ctx, [
    { id: "10003", key: "PROJ-9", fields: { summary: "Bare", updated: "2026-02-01T00:00:00.000Z" } },
  ]);
  const row = db
    .query("SELECT metadata FROM item WHERE external_id = ?")
    .get("PROJ-9") as { metadata: string };
  const meta = JSON.parse(row.metadata) as Record<string, unknown>;

  // A consumer must be able to tell "no due date" from "due at the epoch".
  expect("created_at_ms" in meta).toBe(false);
  expect("resolved_at_ms" in meta).toBe(false);
  expect("due_at_ms" in meta).toBe(false);
  expect("parent_key" in meta).toBe(false);
  expect(meta["status_category"]).toBe("unknown");
  expect(meta["meta_v"]).toBe(1);
});

test("jira requests the depth fields from the search API", async () => {
  const { ctx } = credCtx();
  const bodies: string[] = [];
  await runJiraSyncWithIssues(ctx, [], (params: SyncTestFetchParams) => {
    bodies.push(String(params.init?.body ?? ""));
  });
  const requested = JSON.parse(bodies[0] ?? "{}") as { fields?: string[] };
  for (const f of ["created", "resolutiondate", "parent", "duedate", "issuetype", "status"]) {
    expect(requested.fields).toContain(f);
  }
});
```

Add this helper next to the file's existing helpers (it wraps whatever fetch-stub pattern the file
already uses — reuse `describeWithFetchRestore` / `urlFromFetchInput` exactly as the neighbouring
tests do, rather than inventing a second stubbing style):

```ts
async function runJiraSyncWithIssues(
  ctx: Parameters<ReturnType<typeof createJiraSyncable>["sync"]>[0],
  issues: Array<Record<string, unknown>>,
  onFetch?: (params: SyncTestFetchParams) => void,
): Promise<void> {
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    onFetch?.({ input, init } as SyncTestFetchParams);
    const url = urlFromFetchInput(input);
    if (url.includes("/rest/api/3/search")) {
      return new Response(JSON.stringify({ issues, startAt: 0, maxResults: 50, total: issues.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => undefined });
  await syncable.sync(ctx, null);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/jira-sync.test.ts`
Expected: FAIL — `expect(meta["issue_type"]).toBe("Epic")` receives `undefined`, and the requested
`fields` array lacks `created` / `resolutiondate` / `parent` / `duedate`.

- [ ] **Step 3: Write minimal implementation**

In `packages/gateway/src/connectors/jira-sync.ts`, add the import:

```ts
import { msFromIso, normalizeJiraStatusCategory, TICKET_META_VERSION } from "./ticket-depth.ts";
```

Widen the requested field list at `:148`:

```ts
    fields: [
      "summary",
      "description",
      "updated",
      "issuetype",
      "status",
      "creator",
      "created",
      "resolutiondate",
      "parent",
      "duedate",
    ],
```

Add the metadata builder beside `jiraIssueDerivedFromFields`:

```ts
/**
 * The shared ticket-depth metadata contract (see
 * `docs/superpowers/specs/2026-08-07-ticket-depth-jira-linear-design.md`).
 * Linear's mapper writes the SAME key names, so no consumer branches on
 * service. A field the API did not supply omits its key entirely.
 */
function jiraDepthMetadata(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  const meta: Record<string, unknown> = { meta_v: TICKET_META_VERSION };
  if (fields === undefined) {
    meta["status_category"] = normalizeJiraStatusCategory(undefined);
    return meta;
  }

  const issueType = asRecord(fields["issuetype"]);
  const typeName = issueType === undefined ? undefined : stringField(issueType, "name");
  if (typeName !== undefined && typeName !== "") {
    meta["issue_type"] = typeName;
  }

  const status = asRecord(fields["status"]);
  const statusName = status === undefined ? undefined : stringField(status, "name");
  if (statusName !== undefined && statusName !== "") {
    meta["status"] = statusName;
  }
  const category = status === undefined ? undefined : asRecord(status["statusCategory"]);
  const rawKey = category === undefined ? undefined : stringField(category, "key");
  if (rawKey !== undefined && rawKey !== "") {
    meta["status_category_raw"] = rawKey;
  }
  meta["status_category"] = normalizeJiraStatusCategory(rawKey);

  const created = msFromIso(stringField(fields, "created"));
  if (created !== undefined) {
    meta["created_at_ms"] = created;
  }
  const resolved = msFromIso(stringField(fields, "resolutiondate"));
  if (resolved !== undefined) {
    meta["resolved_at_ms"] = resolved;
  }
  const due = msFromIso(stringField(fields, "duedate"));
  if (due !== undefined) {
    meta["due_at_ms"] = due;
  }

  // Populated on team-managed projects only. Classic company-managed projects
  // express epic membership through a per-instance `customfield_100xx`, which
  // this connector deliberately does not chase — `parent_key` is simply absent
  // there, and epics stay identifiable via `issue_type`.
  const parent = asRecord(fields["parent"]);
  const parentKey = parent === undefined ? undefined : stringField(parent, "key");
  if (parentKey !== undefined && parentKey !== "") {
    meta["parent_key"] = parentKey;
  }

  return meta;
}
```

Then in `jiraIndexOneIssue`, replace the `metadata:` line at `:273`:

```ts
    metadata: { jiraId: id ?? key, key, ...jiraDepthMetadata(fields) },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/jira-sync.test.ts`
Expected: PASS — all pre-existing tests in the file still pass too.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/jira-sync.ts packages/gateway/src/connectors/jira-sync.test.ts
git commit -m "feat(gateway): index Jira issue type, status category, and lifecycle dates"
```

---

### Task 3: Linear mapper writes the same contract

**Files:**

- Modify: `packages/gateway/src/connectors/linear-sync.ts` — `SYNC_QUERY` at `:14`, and the
  `metadata` object at `:180`
- Modify: `packages/gateway/src/connectors/linear-sync.test.ts` (append tests)

**Interfaces:**

- Consumes: `normalizeLinearStateType`, `msFromIso`, `TICKET_META_VERSION` (Task 1).
- Produces: `linear:issue` rows with the identical key names from Task 2, plus `project_id`
  (Linear-only; Jira never writes it).

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/connectors/linear-sync.test.ts`, following that file's existing
fetch-stub pattern for the GraphQL endpoint:

```ts
test("linear issue metadata carries the ticket-depth contract", async () => {
  const { db, ctx } = credCtx();
  await runLinearSyncWithNodes(ctx, [
    {
      id: "uuid-1",
      identifier: "ENG-42",
      title: "Ship the thing",
      description: "body",
      updatedAt: "2026-02-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-20T00:00:00.000Z",
      dueDate: "2026-01-15",
      state: { name: "Merged", type: "completed" },
      parent: { identifier: "ENG-1" },
      project: { id: "proj-9", name: "Q1 Platform" },
    },
  ]);

  const row = db
    .query("SELECT metadata FROM item WHERE external_id = ?")
    .get("ENG-42") as { metadata: string };
  const meta = JSON.parse(row.metadata) as Record<string, unknown>;

  expect(meta["status"]).toBe("Merged");
  expect(meta["status_category"]).toBe("done");
  expect(meta["status_category_raw"]).toBe("completed");
  expect(meta["created_at_ms"]).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  expect(meta["resolved_at_ms"]).toBe(Date.parse("2026-01-20T00:00:00.000Z"));
  expect(meta["due_at_ms"]).toBe(Date.parse("2026-01-15"));
  expect(meta["parent_key"]).toBe("ENG-1");
  expect(meta["project_id"]).toBe("proj-9");
  expect(meta["meta_v"]).toBe(1);
  expect(meta["linearId"]).toBe("uuid-1");
});

test("a canceled linear issue is canceled, not done", async () => {
  // The one place the two services genuinely differ: Linear keeps abandoned
  // work distinct, Jira folds it into `done`. Consumers must not compare
  // cancel rates across services.
  const { db, ctx } = credCtx();
  await runLinearSyncWithNodes(ctx, [
    {
      id: "uuid-2",
      identifier: "ENG-43",
      title: "Abandoned",
      updatedAt: "2026-02-01T00:00:00.000Z",
      canceledAt: "2026-01-25T00:00:00.000Z",
      state: { name: "Cancelled", type: "canceled" },
    },
  ]);
  const row = db
    .query("SELECT metadata FROM item WHERE external_id = ?")
    .get("ENG-43") as { metadata: string };
  const meta = JSON.parse(row.metadata) as Record<string, unknown>;
  expect(meta["status_category"]).toBe("canceled");
  // canceledAt fills resolved_at_ms when completedAt is absent.
  expect(meta["resolved_at_ms"]).toBe(Date.parse("2026-01-25T00:00:00.000Z"));
});

test("absent linear depth fields omit their keys", async () => {
  const { db, ctx } = credCtx();
  await runLinearSyncWithNodes(ctx, [
    { id: "uuid-3", identifier: "ENG-44", title: "Bare", updatedAt: "2026-02-01T00:00:00.000Z" },
  ]);
  const row = db
    .query("SELECT metadata FROM item WHERE external_id = ?")
    .get("ENG-44") as { metadata: string };
  const meta = JSON.parse(row.metadata) as Record<string, unknown>;
  expect("created_at_ms" in meta).toBe(false);
  expect("project_id" in meta).toBe(false);
  expect(meta["status_category"]).toBe("unknown");
});

test("the linear sync query selects the depth fields", async () => {
  const { ctx } = credCtx();
  const payloads: string[] = [];
  await runLinearSyncWithNodes(ctx, [], (body) => payloads.push(body));
  const query = (JSON.parse(payloads[0] ?? "{}") as { query?: string }).query ?? "";
  for (const f of ["createdAt", "completedAt", "canceledAt", "dueDate", "state", "parent", "project"]) {
    expect(query).toContain(f);
  }
});
```

Helper, alongside the file's existing ones:

```ts
async function runLinearSyncWithNodes(
  ctx: Parameters<ReturnType<typeof createLinearSyncable>["sync"]>[0],
  nodes: Array<Record<string, unknown>>,
  onBody?: (body: string) => void,
): Promise<void> {
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    onBody?.(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const syncable = createLinearSyncable({ ensureLinearMcpRunning: async () => undefined });
  await syncable.sync(ctx, null);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/linear-sync.test.ts`
Expected: FAIL — `meta["status_category"]` is `undefined`, and the query lacks `state`.

- [ ] **Step 3: Write minimal implementation**

Import in `packages/gateway/src/connectors/linear-sync.ts`:

```ts
import { msFromIso, normalizeLinearStateType, TICKET_META_VERSION } from "./ticket-depth.ts";
```

Extend `SYNC_QUERY`'s selection set (inside `nodes { ... }`, after `creator { ... }`):

```graphql
      createdAt
      completedAt
      canceledAt
      dueDate
      state {
        name
        type
      }
      parent {
        identifier
      }
      project {
        id
        name
      }
```

Add the builder above `linearUpsertSingleIssue`:

```ts
/**
 * Same key names as `jiraDepthMetadata` in `jira-sync.ts` — the contract is
 * shared so no consumer branches on service. `project_id` is Linear-only:
 * Linear has no Epic issue type, so a project is its epic-shaped grouping.
 * `parent_key` is independent of it and both may be present.
 */
function linearDepthMetadata(row: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = { meta_v: TICKET_META_VERSION };

  const state = asRecord(row["state"]);
  const stateName = state === undefined ? undefined : stringField(state, "name");
  if (stateName !== undefined && stateName !== "") {
    meta["status"] = stateName;
  }
  const stateType = state === undefined ? undefined : stringField(state, "type");
  if (stateType !== undefined && stateType !== "") {
    meta["status_category_raw"] = stateType;
  }
  meta["status_category"] = normalizeLinearStateType(stateType);

  const created = msFromIso(stringField(row, "createdAt"));
  if (created !== undefined) {
    meta["created_at_ms"] = created;
  }
  // A canceled issue is resolved too — it left the board. `completedAt` wins
  // when both are set; `status_category` carries which outcome it was.
  const resolved = msFromIso(stringField(row, "completedAt")) ?? msFromIso(stringField(row, "canceledAt"));
  if (resolved !== undefined) {
    meta["resolved_at_ms"] = resolved;
  }
  const due = msFromIso(stringField(row, "dueDate"));
  if (due !== undefined) {
    meta["due_at_ms"] = due;
  }

  const parent = asRecord(row["parent"]);
  const parentKey = parent === undefined ? undefined : stringField(parent, "identifier");
  if (parentKey !== undefined && parentKey !== "") {
    meta["parent_key"] = parentKey;
  }

  const project = asRecord(row["project"]);
  const projectId = project === undefined ? undefined : stringField(project, "id");
  if (projectId !== undefined && projectId !== "") {
    meta["project_id"] = projectId;
  }

  return meta;
}
```

Replace the `metadata:` line at `:180`:

```ts
    metadata: { linearId: id, identifier, ...linearDepthMetadata(row) },
```

Confirm `asRecord` / `stringField` are already imported in this file; add them from
`./atlassian-api-sync-helpers.ts` if not.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/linear-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/linear-sync.ts packages/gateway/src/connectors/linear-sync.test.ts
git commit -m "feat(gateway): index Linear state, project, and lifecycle dates"
```

---

### Task 4: `SyncContext.historyFloorMs`, honored by both connectors

Widens the cold-start floor for one run. Without it, clearing a cursor re-walks only the last 30
days — so no backfill could ever reach the closed historical tickets this whole workstream exists to
analyze.

**Files:**

- Modify: `packages/gateway/src/sync/types.ts:47` (add the field to `SyncContext`)
- Modify: `packages/gateway/src/connectors/jira-sync.ts:122` (`jiraJqlFromCursor`) and `:316`
- Modify: `packages/gateway/src/connectors/linear-sync.ts:227`
- Modify: both connector test files
- Modify: `packages/gateway/src/connectors/connector-sync-test-helpers.ts` only if
  `silentSyncContextExtras()` needs the optional field — it should not, since the field is optional

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `SyncContext.historyFloorMs?: number` — epoch ms. When present, Jira and Linear
  cold-start from it; when absent both use their own `initialSyncDepthDays = 30`. Task 5 sets it.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/connectors/jira-sync.test.ts`:

```ts
test("historyFloorMs widens the jira cold-start JQL floor", async () => {
  const { ctx } = credCtx();
  const bodies: string[] = [];
  const floorMs = Date.parse("2024-03-05T00:00:00.000Z");
  await runJiraSyncWithIssues({ ...ctx, historyFloorMs: floorMs }, [], (p) => {
    bodies.push(String(p.init?.body ?? ""));
  });
  const jql = (JSON.parse(bodies[0] ?? "{}") as { jql?: string }).jql ?? "";
  // An absolute floor, not the relative 30-day window.
  expect(jql).toContain("2024/03/05");
  expect(jql).not.toContain("-30d");
});

test("without historyFloorMs jira still cold-starts at 30 days", async () => {
  const { ctx } = credCtx();
  const bodies: string[] = [];
  await runJiraSyncWithIssues(ctx, [], (p) => bodies.push(String(p.init?.body ?? "")));
  const jql = (JSON.parse(bodies[0] ?? "{}") as { jql?: string }).jql ?? "";
  expect(jql).toContain("updated >= -30d");
});

test("historyFloorMs is ignored once a real cursor exists", async () => {
  // The floor is a COLD-START override. An established incremental cursor is
  // always more recent, and honouring the floor over it would re-walk history
  // on every subsequent tick.
  const { ctx } = credCtx();
  const cursor = encodeNimbusJsonCursor("nimbus-jra1:", { v: 1, floorJql: "2026/01/01 00:00" });
  const bodies: string[] = [];
  globalThis.fetch = (async (_i: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50, total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => undefined });
  await syncable.sync({ ...ctx, historyFloorMs: Date.parse("2020-01-01T00:00:00.000Z") }, cursor);
  const jql = (JSON.parse(bodies[0] ?? "{}") as { jql?: string }).jql ?? "";
  expect(jql).toContain("2026/01/01");
  expect(jql).not.toContain("2020");
});
```

Append to `packages/gateway/src/connectors/linear-sync.test.ts`:

```ts
test("historyFloorMs widens the linear cold-start filter", async () => {
  const { ctx } = credCtx();
  const payloads: string[] = [];
  const floorMs = Date.parse("2024-03-05T00:00:00.000Z");
  await runLinearSyncWithNodes({ ...ctx, historyFloorMs: floorMs }, [], (b) => payloads.push(b));
  const vars = (JSON.parse(payloads[0] ?? "{}") as { variables?: { gt?: string } }).variables;
  expect(vars?.gt).toBe(new Date(floorMs).toISOString());
});

test("without historyFloorMs linear still cold-starts at 30 days", async () => {
  const { ctx } = credCtx();
  const payloads: string[] = [];
  const before = Date.now() - 31 * 86_400_000;
  await runLinearSyncWithNodes(ctx, [], (b) => payloads.push(b));
  const vars = (JSON.parse(payloads[0] ?? "{}") as { variables?: { gt?: string } }).variables;
  const gtMs = Date.parse(vars?.gt ?? "");
  expect(gtMs).toBeGreaterThan(before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/jira-sync.test.ts packages/gateway/src/connectors/linear-sync.test.ts`
Expected: FAIL — the JQL still contains `-30d`, and `variables.gt` is the 30-day floor. TypeScript
also errors on `historyFloorMs` not existing on `SyncContext`.

- [ ] **Step 3: Write minimal implementation**

In `packages/gateway/src/sync/types.ts`, add to `SyncContext` (after `depth`):

```ts
  /**
   * One-shot cold-start floor (epoch ms) for a history backfill, set by the
   * scheduler for a single run when the owner asked for one via
   * `nimbus index rebody --since <days>`.
   *
   * OPT-IN per connector: a connector that does not read it is unaffected, and
   * the two that do (jira, linear) say so in their own doc comments. Absent —
   * the normal case — every connector keeps its own `initialSyncDepthDays`.
   * It overrides only the COLD-START floor; an established cursor always wins,
   * since it is more recent by construction.
   */
  historyFloorMs?: number;
```

In `packages/gateway/src/connectors/jira-sync.ts`, add the absolute-floor formatter and widen
`jiraJqlFromCursor`:

```ts
/** `historyFloorMs` (epoch ms) as a JQL-comparable `yyyy/MM/dd HH:mm` literal. */
function jqlFloorFromMs(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${String(y)}/${mo}/${da} ${h}:${mi}`;
}

/**
 * Honors `SyncContext.historyFloorMs` (opt-in, see `sync/types.ts`) on a COLD
 * START only — an existing cursor is always more recent.
 */
function jiraJqlFromCursor(
  prev: JiraSyncCursorV1 | null,
  initialSyncDepthDays: number,
  historyFloorMs: number | undefined,
): string {
  const hasFloor = prev?.floorJql !== null && prev?.floorJql !== undefined && prev.floorJql !== "";
  let jqlBase: string;
  if (hasFloor) {
    jqlBase = `updated > "${prev.floorJql}"`;
  } else if (historyFloorMs !== undefined && Number.isFinite(historyFloorMs)) {
    jqlBase = `updated >= "${jqlFloorFromMs(historyFloorMs)}"`;
  } else {
    jqlBase = `updated >= -${String(initialSyncDepthDays)}d`;
  }
  return `${jqlBase} ORDER BY updated ASC`;
}
```

And at the call site (`:316`):

```ts
      const jql = jiraJqlFromCursor(prev, initialSyncDepthDays, ctx.historyFloorMs);
```

In `packages/gateway/src/connectors/linear-sync.ts`, replace the floor computation at `:227-228`:

```ts
      // Honors `SyncContext.historyFloorMs` (opt-in, see `sync/types.ts`) on a
      // COLD START only — `prev.since` is always more recent.
      const defaultFloorMs = now - initialSyncDepthDays * 86_400_000;
      const coldFloorMs =
        ctx.historyFloorMs !== undefined && Number.isFinite(ctx.historyFloorMs)
          ? ctx.historyFloorMs
          : defaultFloorMs;
      const sinceGt = prev?.since ?? new Date(coldFloorMs).toISOString();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/jira-sync.test.ts packages/gateway/src/connectors/linear-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/sync/types.ts packages/gateway/src/connectors/jira-sync.ts packages/gateway/src/connectors/linear-sync.ts packages/gateway/src/connectors/jira-sync.test.ts packages/gateway/src/connectors/linear-sync.test.ts
git commit -m "feat(gateway): optional SyncContext.historyFloorMs cold-start override"
```

---

### Task 5: Scheduler carries the history floor for one run

**Files:**

- Modify: `packages/gateway/src/sync/scheduler.ts` — the `runCtx` construction at `:650`, and the
  success path at `:679`
- Modify: `packages/gateway/src/sync/scheduler.test.ts` (append tests)

**Interfaces:**

- Consumes: `SyncContext.historyFloorMs` (Task 4).
- Produces: `SyncScheduler.setHistoryFloor(serviceId: string, floorMs: number): void` — Task 6 calls
  it immediately before `forceSync(serviceId)`.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/sync/scheduler.test.ts`, matching that file's existing scheduler
construction and fake-syncable pattern:

```ts
test("setHistoryFloor reaches the connector on the next run", async () => {
  const seen: Array<number | undefined> = [];
  const { scheduler } = makeSchedulerWithSyncable({
    serviceId: "jira",
    defaultIntervalMs: 60_000,
    initialSyncDepthDays: 30,
    sync: async (ctx) => {
      seen.push(ctx.historyFloorMs);
      return { cursor: "c1", itemsUpserted: 0, itemsDeleted: 0, hasMore: false };
    },
  });
  const floor = Date.parse("2024-01-01T00:00:00.000Z");
  scheduler.setHistoryFloor("jira", floor);
  await scheduler.forceSync("jira");
  expect(seen).toEqual([floor]);
});

test("the floor is consumed by a successful run and not reused", async () => {
  const seen: Array<number | undefined> = [];
  const { scheduler } = makeSchedulerWithSyncable({
    serviceId: "jira",
    defaultIntervalMs: 60_000,
    initialSyncDepthDays: 30,
    sync: async (ctx) => {
      seen.push(ctx.historyFloorMs);
      return { cursor: "c1", itemsUpserted: 0, itemsDeleted: 0, hasMore: false };
    },
  });
  scheduler.setHistoryFloor("jira", 1_700_000_000_000);
  await scheduler.forceSync("jira");
  await scheduler.forceSync("jira");
  expect(seen).toEqual([1_700_000_000_000, undefined]);
});

test("a rate-limited run KEEPS the floor for the retry", async () => {
  // The scheduler returns without persisting a cursor on RateLimitError, so
  // the next attempt is still a cold start. Dropping the floor here would
  // silently narrow the retry back to 30 days and the backfill would never
  // complete.
  const seen: Array<number | undefined> = [];
  let calls = 0;
  const { scheduler } = makeSchedulerWithSyncable({
    serviceId: "jira",
    defaultIntervalMs: 60_000,
    initialSyncDepthDays: 30,
    sync: async (ctx) => {
      seen.push(ctx.historyFloorMs);
      calls += 1;
      if (calls === 1) {
        throw new RateLimitError(new Date(Date.now() + 1000), "rate limited");
      }
      return { cursor: "c1", itemsUpserted: 0, itemsDeleted: 0, hasMore: false };
    },
  });
  scheduler.setHistoryFloor("jira", 1_700_000_000_000);
  await scheduler.forceSync("jira").catch(() => undefined);
  await scheduler.forceSync("jira");
  expect(seen).toEqual([1_700_000_000_000, 1_700_000_000_000]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/sync/scheduler.test.ts`
Expected: FAIL — `scheduler.setHistoryFloor is not a function`

- [ ] **Step 3: Write minimal implementation**

In `packages/gateway/src/sync/scheduler.ts`, add the field beside the other private maps:

```ts
  /**
   * One-shot cold-start floors (epoch ms) per service, set by an owner-initiated
   * `index.rebody --since`. In-memory ONLY: a restart drops a pending backfill
   * back to the connector's own 30-day floor, which is the safe direction —
   * the user can ask again, and nothing silently keeps re-walking history.
   */
  private readonly historyFloors = new Map<string, number>();

  setHistoryFloor(serviceId: string, floorMs: number): void {
    this.historyFloors.set(serviceId, floorMs);
  }
```

At the `runCtx` construction (`:650`):

```ts
      const historyFloorMs = this.historyFloors.get(job.serviceId);
      const runCtx: SyncContext = {
        ...this.ctx,
        depth: this.getDepthForService(job.serviceId),
        ...(historyFloorMs === undefined ? {} : { historyFloorMs }),
      };
```

And at the success path (`:679`), consume it only once the walk actually completed:

```ts
    // Consumed only on success. A rate-limited or failed run returns earlier
    // WITHOUT persisting a cursor, so its retry is still a cold start and must
    // keep the wide floor — otherwise the backfill silently narrows to 30 days
    // and never reaches the history it was asked for.
    this.historyFloors.delete(job.serviceId);
    this.runJobRecordSyncSuccess(job, row, startedAt, result);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/sync/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/sync/scheduler.ts packages/gateway/src/sync/scheduler.test.ts
git commit -m "feat(gateway): scheduler carries a one-shot history floor per service"
```

---

### Task 6: `rebody` eligibility widens to metadata version, and accepts `--since`

**Files:**

- Modify: `packages/gateway/src/ipc/index-rebody-rpc.ts` — `RebodyParams` (`:106`),
  `parseRebodyParams` (`:270`), `buildTargetServicesSql` (`:340`), `resolveTargetServices` (`:374`),
  `runRebody`, and the module doc comment
- Modify: `packages/gateway/src/ipc/index-rebody-rpc.test.ts` (append tests)

**Interfaces:**

- Consumes: `TICKET_META_VERSION` (Task 1), `SyncScheduler.setHistoryFloor` (Task 5).
- Produces: `RebodyParams.sinceDays?: number`; the exported
  `REBODY_REQUIRED_META_VERSION: ReadonlyMap<string, number>`; a per-reason pending breakdown
  (`pending_body` / `pending_meta`) in the progress payload, consumed by Task 7.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/ipc/index-rebody-rpc.test.ts`:

```ts
test("a service with complete bodies but stale metadata is eligible", () => {
  const db = createMemoryIndexDb();
  insertItem(db, {
    id: "jira:PROJ-1",
    service: "jira",
    type: "issue",
    bodyComplete: 1,
    metadata: JSON.stringify({ jiraId: "1", key: "PROJ-1" }),
  });
  expect(resolveTargetServices({ service: "jira" }, db)).toEqual(["jira"]);
});

test("a service current on both counts is still refused", () => {
  const db = createMemoryIndexDb();
  insertItem(db, {
    id: "jira:PROJ-1",
    service: "jira",
    type: "issue",
    bodyComplete: 1,
    metadata: JSON.stringify({ jiraId: "1", key: "PROJ-1", meta_v: 1 }),
  });
  expect(() => resolveTargetServices({ service: "jira" }, db)).toThrow(/nothing to recover/);
});

test("a service with no metadata requirement keeps body-only eligibility", () => {
  const db = createMemoryIndexDb();
  insertItem(db, {
    id: "slack:C1",
    service: "slack",
    type: "message",
    bodyComplete: 1,
    metadata: JSON.stringify({}),
  });
  expect(() => resolveTargetServices({ service: "slack" }, db)).toThrow(/nothing to recover/);
});

test("sinceDays is validated, not silently dropped", () => {
  expect(parseRebodyParams({ sinceDays: 365 }).sinceDays).toBe(365);
  expect(() => parseRebodyParams({ sinceDays: 0 })).toThrow(/positive/);
  expect(() => parseRebodyParams({ sinceDays: -5 })).toThrow(/positive/);
  expect(() => parseRebodyParams({ sinceDays: "365" })).toThrow(/positive/);
});
```

Reuse the file's existing `createMemoryIndexDb` / item-insert helper; if it inserts items through a
different helper name, use that one rather than adding a second.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/index-rebody-rpc.test.ts`
Expected: FAIL — the stale-metadata service is not selected, and `sinceDays` is dropped.

- [ ] **Step 3: Write minimal implementation**

In `packages/gateway/src/ipc/index-rebody-rpc.ts`:

```ts
import { TICKET_META_VERSION } from "../connectors/ticket-depth.ts";

/**
 * Services whose rows must carry at least this `metadata.meta_v` to count as
 * fully recovered. This is the SECOND eligibility reason, alongside
 * `body_complete = 0` — `rebody` recovers indexed DEPTH, of which bodies were
 * the first kind. A later depth PR adds a row here; it does not add a
 * mechanism.
 */
export const REBODY_REQUIRED_META_VERSION: ReadonlyMap<string, number> = new Map([
  ["jira", TICKET_META_VERSION],
  ["linear", TICKET_META_VERSION],
]);
```

Add `sinceDays?: number` to `RebodyParams`, and validate it in `parseRebodyParams` following the
`limit` precedent exactly (a malformed value that bounds real network spend is a hard error):

```ts
  if ("sinceDays" in rec) {
    const raw = rec["sinceDays"];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new IndexRebodyRpcError(
        -32602,
        "params.sinceDays must be a positive finite number when provided",
      );
    }
    out.sinceDays = Math.floor(raw);
  }
```

Widen `buildTargetServicesSql` — bound parameters only, never interpolation (I9):

```ts
export function buildTargetServicesSql(p: RebodyParams): { sql: string; params: Array<string | number> } {
  const params: Array<string | number> = [];
  const metaClauses: string[] = [];
  for (const [service, version] of REBODY_REQUIRED_META_VERSION) {
    metaClauses.push(`(service = ? AND COALESCE(json_extract(metadata, '$.meta_v'), 0) < ?)`);
    params.push(service, version);
  }
  let sql = `SELECT DISTINCT service FROM item WHERE (body_complete = 0 OR ${metaClauses.join(" OR ")})`;
  if (p.type !== undefined) {
    sql += ` AND type = ?`;
    params.push(p.type);
  }
  sql += ` ORDER BY service`;
  return { sql, params };
}
```

`resolveTargetServices` needs no logic change — it already calls `buildTargetServicesSql` — but
update its doc comment so the `-32602` message's rationale still reads true: the guard now means
"nothing to recover, by body OR by metadata version".

In `runRebody`, before `forceSync`, set the floor when `sinceDays` was given:

```ts
    if (p.sinceDays !== undefined) {
      ctx.scheduler?.setHistoryFloor(service, Date.now() - p.sinceDays * 86_400_000);
    }
```

Extend `computePendingByService` (and the progress payload it feeds) to report the two reasons
separately as `pending_body` and `pending_meta` — a single count whose meaning silently widened
would be worse than no count.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/index-rebody-rpc.test.ts`
Expected: PASS — including the pre-existing eligibility tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/index-rebody-rpc.ts packages/gateway/src/ipc/index-rebody-rpc.test.ts
git commit -m "feat(gateway): rebody recovers indexed depth, not just bodies"
```

---

### Task 7: CLI `--since`, and an honest rate-limited report

**Files:**

- Modify: `packages/cli/src/commands/index-cmd.ts` — `RebodyOptions`, `parseRebodyOptions` (`:233`),
  `printPlannedRebody` (`:244`), and the result printer
- Modify: `packages/cli/src/commands/index-cmd.test.ts`
- Modify: `packages/cli/src/commands/help.ts` (rebody usage line)

**Interfaces:**

- Consumes: `RebodyParams.sinceDays` (Task 6).
- Produces: `nimbus index rebody --since <days>`.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/src/commands/index-cmd.test.ts`:

```ts
test("--since parses to sinceDays", () => {
  expect(parseRebodyOptions(["--since", "365"]).sinceDays).toBe(365);
});

test("a malformed --since fails loudly before any IPC round-trip", () => {
  // Same reasoning as --limit: this bounds real outbound API traffic, so a
  // typo must not silently become a 30-day walk the user didn't ask for.
  expect(() => parseRebodyOptions(["--since", "abc"])).toThrow(/--since/);
  expect(() => parseRebodyOptions(["--since", "0"])).toThrow(/--since/);
  expect(() => parseRebodyOptions(["--since", "-5"])).toThrow(/--since/);
});

test("omitting --since sends no sinceDays", () => {
  expect("sinceDays" in parseRebodyOptions([])).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/index-cmd.test.ts`
Expected: FAIL — `sinceDays` is `undefined`; the malformed cases do not throw.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/commands/index-cmd.ts`, add `sinceDays?: number` to `RebodyOptions`, then
mirror `parseRebodyLimit`:

```ts
/**
 * Like `--limit`, `--since` bounds real outbound API traffic — it widens the
 * connector's cold-start window from its built-in 30 days. A malformed value
 * is rejected client-side rather than silently becoming the default walk.
 */
function parseRebodySince(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `--since must be a positive integer number of days (got "${raw}"). It widens how far back ` +
        `a connector re-walks, so a malformed value is rejected, not ignored.`,
    );
  }
  return n;
}
```

Wire it into `parseRebodyOptions`, and extend `printPlannedRebody`:

```ts
  if (p.sinceDays !== undefined) console.log(`  since   = ${String(p.sinceDays)} days`);
```

Replace the trailing caveat sentence in `printPlannedRebody` so it stops implying the window is
fixed:

```ts
  console.log(
    "rebody re-fetches indexed depth (item bodies, and connector metadata such as Jira/Linear " +
      "status and dates) by clearing a connector's sync watermark and letting it re-sync — this " +
      "is real outbound API traffic, potentially tens of thousands of requests for a full-scan " +
      "connector (e.g. Notion). Bounded-window connectors default to roughly the last 30 days; " +
      "pass --since <days> to widen that for connectors that support it (jira, linear).",
  );
```

In the result printer, when the gateway reports a service that ended rate-limited, say so and say
that no cursor progress was made:

```ts
      console.log(
        `  ${service}: ended rate-limited — rows already fetched are saved, but the sync ` +
          `watermark did not advance, so the next run restarts this walk. Re-run with a smaller ` +
          `--since if it does not converge.`,
      );
```

Update the `rebody` usage line in `packages/cli/src/commands/help.ts` to include `[--since <days>]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/commands/index-cmd.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/index-cmd.ts packages/cli/src/commands/index-cmd.test.ts packages/cli/src/commands/help.ts
git commit -m "feat(cli): nimbus index rebody --since <days>"
```

---

### Task 8: Depth-invariance test, docs, and branch pre-flight

The one assertion no single earlier task owns, plus the doc surfaces that go stale on every depth
change.

**Files:**

- Modify: `packages/gateway/src/index/item-store.test.ts` (append)
- Modify: `docs/cli-reference.md` (the `index rebody` entry)
- Modify: `docs/CHANGELOG.md` (an Unreleased entry)
- Modify: `.claude/commands/nimbus-index-body-depth.md` (the skill now covers metadata depth too)

**Interfaces:**

- Consumes: everything above. Produces nothing new.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/index/item-store.test.ts`:

```ts
test("metadata survives every index depth", () => {
  // `applyDepth` strips only body fields. Metadata passing through at
  // `metadata_only` is correct by that depth's own name — and it is the first
  // thing a reviewer will question, so assert it rather than explain it.
  const db = createMemoryIndexDb();
  for (const depth of ["metadata_only", "summary", "full"] as const) {
    upsertIndexedItemForSync(
      { db, depth, ...silentSyncContextExtras() },
      {
        service: "jira",
        type: "issue",
        externalId: `PROJ-${depth}`,
        title: "t",
        body: "some body text",
        modifiedAt: 1,
        metadata: { key: `PROJ-${depth}`, status_category: "done", meta_v: 1 },
        pinned: false,
        syncedAt: 1,
      },
    );
    const row = db
      .query("SELECT metadata FROM item WHERE external_id = ?")
      .get(`PROJ-${depth}`) as { metadata: string };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta["status_category"]).toBe("done");
    expect(meta["meta_v"]).toBe(1);
  }
});
```

- [ ] **Step 2: Run test to verify it fails or passes for the right reason**

Run: `bun test packages/gateway/src/index/item-store.test.ts`
Expected: PASS immediately — `applyDepth` already behaves this way. This test is a **regression
lock**, not a driver: if it fails, `applyDepth` has started touching metadata and the depth contract
is broken. Confirm it is genuinely exercising the path by temporarily making `applyDepth` drop
`metadata` and watching it fail, then revert that edit.

- [ ] **Step 3: Update the docs**

- `docs/cli-reference.md`: add `--since <days>` to the `index rebody` entry; state that it widens the
  cold-start window for connectors that honor it (jira, linear) and that other connectors ignore it.
- `docs/CHANGELOG.md`: an Unreleased entry naming the new metadata contract, `--since`, and the
  widened `rebody` eligibility. Per project convention connector/depth deliveries go in the
  CHANGELOG, **not** the CLAUDE.md status line.
- `.claude/commands/nimbus-index-body-depth.md`: note that `rebody` now recovers metadata depth as
  well as bodies, and point at `REBODY_REQUIRED_META_VERSION` as the place a future depth PR
  registers itself.

- [ ] **Step 4: Run the branch gates**

```bash
bun run preflight:fast
bun test packages/gateway/src/connectors packages/gateway/src/ipc/index-rebody-rpc.test.ts packages/gateway/src/sync
bun test packages/cli/src/commands/index-cmd.test.ts
```

Expected: all green. If `preflight:fast` fails inside the worktree for a reason unrelated to this
diff (a known worktree-path limitation for some gates), re-run the failing gate from a main-repo
branch before concluding.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/index/item-store.test.ts docs/cli-reference.md docs/CHANGELOG.md .claude/commands/nimbus-index-body-depth.md
git commit -m "test(gateway): lock metadata depth-invariance; docs for ticket depth"
```

---

## Self-review notes

**Spec coverage.** Metadata contract → Tasks 2–3. Normalized `status_category` + `unknown` fallback +
Jira's unreachable `canceled` → Task 1, asserted in 2–3. Epic asymmetry (`project_id` /
`parent_key`) → Task 3. Classic-Jira `parent` caveat → Task 2's doc comment. Depth non-interaction →
Task 8. No migration → nothing in any task adds one. 30-day corpus bound → Tasks 4–5. `rebody`
eligibility + `meta_v` → Task 6. Per-reason pending counts → Task 6. `--since` → Tasks 6–7.
Rate-limited-run honesty → Tasks 5 (floor retained) and 7 (reported). Deferred items (resumable
cursors, `fields.resolution`) appear in no task, by intent.

**Naming consistency.** `TICKET_META_VERSION`, `meta_v`, `status_category`, `status_category_raw`,
`historyFloorMs`, `sinceDays`, `setHistoryFloor`, `REBODY_REQUIRED_META_VERSION` are each used with
the same spelling and type in every task that mentions them.

**Verification traps this plan inherits** (from prior workstreams in this repo, worth re-checking
during implementation rather than trusting):

- Before claiming "the mapper is the only writer", grep the SQL:
  `grep -rn "INSERT INTO item\b" --include=*.ts | grep -v test`. `deployment/annotate.ts` is a
  second independent writer — it does not write Jira/Linear rows, so it is out of scope here, but
  the claim needs the grep as its evidence.
- Test fakes echo params back; a passing test does not prove a param contract. The Task 2/3 tests
  assert against the **stored row**, not against what the fake received, for exactly this reason.
