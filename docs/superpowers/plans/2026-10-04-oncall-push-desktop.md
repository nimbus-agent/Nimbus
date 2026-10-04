# On-call Pushed Brief PR 3 (Desktop Panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `/oncall` page to the desktop app that lists pushed on-call briefs live, shows the selected brief verbatim with its delivery outcomes, and lights a sidebar dot for unseen briefs. Add `service` to `oncall.pushedList` and expose the two read methods to the renderer (`ALLOWED_METHODS` 105 → 107).

**Architecture:** On the gateway side:
- `pushedList`/`pushedGet` rows gain `service`, resolved by one helper shared with the PR 2 ChatOps headline.
- The list reads the incident title and PagerDuty service id in one guarded LEFT JOIN.

On the desktop side:
- One `OncallBriefsProvider` in `RootLayout` owns the list query and the single `gateway://notification` subscription.
- The sidebar and the page read the provider's context.
- A committed JSON fixture, validated by a gateway test against the real RPC output, binds the two packages.

**Tech Stack:** Bun 1.3 + `bun:sqlite` + `bun:test` (gateway, CLI). React 19 + react-router + zustand + vitest + Testing Library (`packages/ui`). Rust (`gateway_bridge.rs`, Tauri 2). Biome.

**Spec:** `docs/superpowers/specs/2026-10-04-oncall-push-desktop-design.md`. Read it with this plan, including § 7, "Review dispositions". The review it answers is `docs/superpowers/specs/2026-10-04-oncall-push-desktop-design-review.md`.

## Global Constraints

- Branch: `dev/asaf/oncall-push-desktop`. Worktree: `C:/gitrep/Nimbus/.claude/worktrees/oncall-push-desktop`. Run `git rev-parse --abbrev-ref HEAD` before EVERY commit.
- Run every command from the worktree root unless a step says otherwise. Gateway and CLI tests use `bun test <path>`. UI tests run from `packages/ui` with `bunx vitest run <path>`, NEVER `bun test`, which does not run vitest there.
- No `any` anywhere, including tests. Narrow `unknown`.
- `packages/ui` imports nothing from `packages/gateway` (the IPC-only rule). The ONLY cross-package binding is the JSON fixture `packages/ui/test/fixtures/oncall-pushed.json`, read as a file.
- Allowlist: exactly `"oncall.pushedGet"` and `"oncall.pushedList"` are added, between `"llm.unloadModel"` and `"policy.show"`. `"oncall.pushedRetry"` is NEVER added. Neither new method goes in `NO_TIMEOUT_METHODS`. New total: **107**.
- I7 triple rule: the Rust list, the Rust tests, the `security-invariants.test.ts` pin and the `docs/SECURITY-INVARIANTS.md` I7 ledger change in ONE commit (Task 5).
- The brief markdown renders ONLY as a React text child inside `<pre className="whitespace-pre-wrap break-words …">`. No `dangerouslySetInnerHTML`, no markdown or HTML parsing, no link detection.
- Empty-state strings, verbatim:
  - Push off: `On-call push is off. Set [oncall.push] enabled = true in nimbus.toml.`
  - Identity unresolved: ``On-call push is enabled but your identity is unresolved, so no incident can be selected. Set [user] me_person_id in nimbus.toml or `git config user.email`.``
  - No rows: `No pushed briefs yet.`
  - Pruned: `<incidentId> was pruned (older than retention_days).`
  - RPC error: `Could not load pushed briefs: <message>. From a terminal: nimbus oncall pushed`
- The retry command shown for a failed row: `nimbus oncall pushed <incidentId> --retry`. There is no retry button.
- The sidebar entry is `{ to: "/oncall", icon: "☎", label: "On-call" }`, placed directly after Dashboard. The dot's hidden label is `new pushed brief`.
- The persisted key is `lastSeenPushedAt` (number, initial `0`). It only ever moves forward.
- The CLI list line is `<ISO time>  <status>  <incident id>  [<service>]  <title>`. The `[<service>]  ` segment is omitted entirely when the service is null.
- `json_extract` over `item.metadata` is ALWAYS guarded: `CASE WHEN json_valid(i.metadata) THEN json_extract(i.metadata, '$.pagerduty_service_id') END`.
- Commit messages go in a file under `$TEMP`, used with `git commit -F`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Every new test is red-proved: revert its fix, watch it fail, restore. Report which line you reverted.
- Test data lives only in `mkdtemp` dirs under `os.tmpdir()` or `:memory:` DBs. Never touch `%LOCALAPPDATA%\Nimbus` or `%APPDATA%\Nimbus`.

## Review Focus

Inputs the spec implies but does not spell out, most likely to bite first. Each one has a test in the task that owns the code.

1. **A new brief arrives while you are reading an OLDER one.** The selection must stay put: auto-select happens only when the URL has no `id`. Task 9.
2. **An incident id with URL-special characters** (`pagerduty:A/B#c?d`): selecting it round-trips through `?id=` and opens that brief. Task 9.
3. **A row with BOTH `title` and `service` null:** the list shows the incident id, and no `null`/`undefined` text appears anywhere. Task 9.
4. **A gateway clock ahead of the desktop clock** (`createdAt` in the future): the age reads `just now`, never a negative number. Task 9.
5. **Two `oncall.briefPushed` events for the same id in quick succession:** each one causes a refetch, so the second update (e.g. a retry turning `ok`) is not swallowed by deduplication. Task 8.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/oncall-push/push-headline.ts` | + `resolvePushService` (the shared service resolver). The headline uses it. |
| `packages/gateway/src/oncall-push/push-store.ts` | + `listWithIncident` (guarded LEFT JOIN) and `incidentPagerdutyServiceId`. |
| `packages/gateway/src/ipc/oncall-push-rpc.ts` | `service` on summary/detail; the list uses `listWithIncident`. |
| `packages/gateway/src/ipc/oncall-push-rpc.contract.test.ts` (new) | Validates (and regenerates) the UI fixture against the real RPC output. |
| `packages/ui/test/fixtures/oncall-pushed.json` (new) | The cross-package contract fixture. |
| `packages/cli/src/commands/oncall-pushed.ts` | `[service]` in `list` lines. |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | Two allowlist entries plus Rust tests. |
| `packages/gateway/src/security-invariants.test.ts` | The size pin moves to 107, plus the by-name oncall pins. |
| `packages/ui/src/ipc/types.ts` | `PushedBriefSummary` / `PushedBriefDetail` / `PushedBriefList` / `PushedBriefGet` / `PushSinkOutcome`. |
| `packages/ui/src/store/slices/oncall.ts` (new), `store/index.ts`, `store/partialize.ts` | `lastSeenPushedAt` plus `markPushedSeen`, persisted. |
| `packages/ui/src/components/chrome/NavItem.tsx` | `dot` / `dotLabel`. |
| `packages/ui/src/hooks/useOncallBriefs.ts` (new) | The context type, the context, `useOncallBriefs`, and the pure narrowers `parseBriefPushed` / `asPushedBriefList` / `asPushedBriefGet`. |
| `packages/ui/src/providers/OncallBriefsProvider.tsx` (new) | The list query plus the single subscription. Provides the context. |
| `packages/ui/src/layouts/RootLayout.tsx` | Mounts the provider around the sidebar and outlet. |
| `packages/ui/src/components/chrome/Sidebar.tsx` | The On-call entry plus the dot. |
| `packages/ui/src/pages/Oncall.tsx` (new), `components/oncall/{BriefList,BriefDetail,DeliveryStrip,format}.tsx/ts` (new), `App.tsx` | The page. |
| Docs | `docs/SECURITY-INVARIANTS.md` (Task 5); `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`, `docs/roadmap.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/commands/nimbus-tauri-allowlist.md` (Tasks 5 and 10). |

---

### Task 1: `resolvePushService`, the shared service resolver

**Files:**
- Modify: `packages/gateway/src/oncall-push/push-headline.ts`
- Test: `packages/gateway/src/oncall-push/push-headline.test.ts`

**Interfaces:**
- Consumes: `HeadlineBrief` and the private `nonEmpty` (both already in `push-headline.ts`).
- Produces: `export function resolvePushService(brief: HeadlineBrief | null, pagerdutyServiceId: string | null): string | null`. It returns the RAW value: never single-lined, never escaped.

- [ ] **Step 1: Write the failing tests** (append to `push-headline.test.ts`; add `resolvePushService` to the existing `./push-headline.ts` import)

```ts
describe("resolvePushService", () => {
  const brief = (nimbusServiceId: string | null) => ({ nimbusServiceId, deployment: null });
  test("the mapped Nimbus service wins", () => {
    expect(resolvePushService(brief("payment-service"), "PSVC")).toBe("payment-service");
  });
  test("falls back to the PagerDuty service id when unmapped, blank, or no brief", () => {
    expect(resolvePushService(brief(null), "PSVC")).toBe("PSVC");
    expect(resolvePushService(brief("  "), "PSVC")).toBe("PSVC");
    expect(resolvePushService(null, "PSVC")).toBe("PSVC");
  });
  test("null when neither is usable", () => {
    expect(resolvePushService(null, null)).toBeNull();
    expect(resolvePushService(brief(""), " ")).toBeNull();
  });
  test("returns the raw value, never escaped", () => {
    expect(resolvePushService(brief("a&b"), null)).toBe("a&b");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test packages/gateway/src/oncall-push/push-headline.test.ts`. Expected: FAIL, `resolvePushService` is not exported.

- [ ] **Step 3: Implement.** In `push-headline.ts`, after `parseHeadlineBrief`:

```ts
/**
 * The service a pushed brief is about, shared by the ChatOps headline and `oncall.pushedList` so
 * Slack and the desktop name it identically: the brief's mapped Nimbus service, then the incident's
 * PagerDuty service id, then null. Blank values fall through. RAW: each surface formats it itself.
 */
export function resolvePushService(
  brief: HeadlineBrief | null,
  pagerdutyServiceId: string | null,
): string | null {
  return nonEmpty(brief?.nimbusServiceId) ?? nonEmpty(pagerdutyServiceId) ?? null;
}
```

In `renderPushHeadline`, replace the three-line `const service = …` expression with:

```ts
  const service = resolvePushService(brief, d.incident.pagerdutyServiceId) ?? "unknown service";
```

- [ ] **Step 4: Run them and confirm they pass.** `bun test packages/gateway/src/oncall-push`. Expected: all pass, including PR 2's unchanged headline tests (service fallbacks).
- [ ] **Step 5: Red-prove.** Swap the two `nonEmpty(...)` operands. The "mapped wins" test fails. Restore.
- [ ] **Step 6: Commit** (`refactor(oncall): one service resolver for the headline and the read surface`).

---

### Task 2: `service` on `oncall.pushedList` / `pushedGet`, with no per-row query

**Files:**
- Modify: `packages/gateway/src/oncall-push/push-store.ts`, `packages/gateway/src/ipc/oncall-push-rpc.ts`
- Test: `packages/gateway/src/oncall-push/push-store.test.ts`, `packages/gateway/src/ipc/oncall-push-rpc.test.ts`

**Interfaces:**
- Consumes: `resolvePushService` and `parseHeadlineBrief` (`push-headline.ts`).
- Produces:
  - `PushStore.listWithIncident(limit: number): PushedBriefListing[]`, where `export type PushedBriefListing = { readonly row: PushedBriefRow; readonly title: string | null; readonly pagerdutyServiceId: string | null }`.
  - `PushStore.incidentPagerdutyServiceId(incidentId: string): string | null`.
  - `PushedBriefSummary` gains `service: string | null`, and so `PushedBriefDetail` gains it too.

- [ ] **Step 1: Write the failing tests.** In `push-store.test.ts`, inside `describe("PushStore", …)`, add the following. `dbRun` comes from `../db/write.ts`. Make sure `upsertIndexedItem` is imported (it already is):

```ts
  const incident = (externalId: string, title: string, metadata: Record<string, unknown>) =>
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId,
      title,
      body: "",
      modifiedAt: 1,
      syncedAt: 1,
      authorId: null,
      url: null,
      metadata,
    });

  test("listWithIncident joins title + PagerDuty service id, newest first, in one query", () => {
    incident("A", "checkout: 5xx", { pagerduty_service_id: "PSVC" });
    store.insert("pagerduty:A", OK, 1000);
    store.insert("pagerduty:GONE", FAILED, 2000); // its incident is not (or no longer) indexed
    expect(store.listWithIncident(10)).toEqual([
      { row: store.get("pagerduty:GONE"), title: null, pagerdutyServiceId: null },
      { row: store.get("pagerduty:A"), title: "checkout: 5xx", pagerdutyServiceId: "PSVC" },
    ]);
  });

  test("one malformed item.metadata does not fail the list (json_extract RAISES unguarded)", () => {
    incident("A", "a", { pagerduty_service_id: "PSVC" });
    incident("B", "b", { pagerduty_service_id: "PB" });
    store.insert("pagerduty:A", OK, 1);
    store.insert("pagerduty:B", OK, 2);
    // Simulated corruption: no writer produces this, which is exactly why the guard exists.
    dbRun(db, "UPDATE item SET metadata = 'not json' WHERE id = ?", ["pagerduty:B"]);
    const out = store.listWithIncident(10);
    expect(out.map((l) => [l.row.incidentId, l.title, l.pagerdutyServiceId])).toEqual([
      ["pagerduty:B", "b", null],
      ["pagerduty:A", "a", "PSVC"],
    ]);
    expect(store.incidentPagerdutyServiceId("pagerduty:B")).toBeNull();
  });

  test("incidentPagerdutyServiceId: value, absent field, absent incident", () => {
    incident("A", "a", { pagerduty_service_id: "PSVC" });
    incident("N", "n", {});
    expect(store.incidentPagerdutyServiceId("pagerduty:A")).toBe("PSVC");
    expect(store.incidentPagerdutyServiceId("pagerduty:N")).toBeNull();
    expect(store.incidentPagerdutyServiceId("pagerduty:NOPE")).toBeNull();
  });
```

In `oncall-push-rpc.test.ts`, add the following. Import `upsertIndexedItem` from `../index/item-store.ts`:

```ts
test("service: PagerDuty fallback for an unmapped or failed row; null without an incident", async () => {
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "S",
    title: "svc",
    body: "",
    modifiedAt: 1,
    syncedAt: 1,
    authorId: null,
    url: null,
    metadata: { pagerduty_service_id: "PSVC" },
  });
  store.insert("pagerduty:S", { status: "failed", sessionId: null, failureCode: "timeout: x" }, 1);
  store.insert("pagerduty:NOINC", { status: "failed", sessionId: null, failureCode: "x" }, 2);
  const list = (await hit("oncall.pushedList", {}))["briefs"] as Record<string, unknown>[];
  expect(list.map((b) => [b["incidentId"], b["title"], b["service"]])).toEqual([
    ["pagerduty:NOINC", null, null],
    ["pagerduty:S", "svc", "PSVC"],
  ]);
  expect((await hit("oncall.pushedGet", { incidentId: "pagerduty:S" }))["brief"]).toMatchObject({
    title: "svc",
    service: "PSVC",
  });
});
```

The MAPPED case (`payment-service` from a real brief) is proved by Task 3's contract test over the real demo writer. No hand-written brief JSON is added here.

- [ ] **Step 2: Run them and confirm they fail.** `bun test packages/gateway/src/oncall-push/push-store.test.ts packages/gateway/src/ipc/oncall-push-rpc.test.ts`. Expected: FAIL (missing methods; no `service` key).

- [ ] **Step 3: Implement `push-store.ts`.** After `const COLS = …`:

```ts
const PB_COLS = COLS.split(", ")
  .map((c) => `pb.${c}`)
  .join(", ");

// json_extract RAISES on malformed JSON. In a projection over a LEFT JOIN, one corrupt item.metadata
// would fail the whole list, so it is guarded (memory: sqlite-json-extract-raises-on-bad-json).
const PD_SERVICE_SQL =
  "CASE WHEN json_valid(i.metadata) THEN json_extract(i.metadata, '$.pagerduty_service_id') END";

export type PushedBriefListing = {
  readonly row: PushedBriefRow;
  readonly title: string | null;
  readonly pagerdutyServiceId: string | null;
};

type ListingRaw = Raw & { incident_title: string | null; incident_pd_service_id: unknown };
```

Inside `class PushStore`, after `list`:

```ts
  /** `list` plus the incident's title and PagerDuty service id, in ONE query (no per-row lookup). */
  listWithIncident(limit: number): PushedBriefListing[] {
    const rows = this.db
      .query(
        `SELECT ${PB_COLS}, i.title AS incident_title, ${PD_SERVICE_SQL} AS incident_pd_service_id
           FROM pushed_brief pb
           LEFT JOIN item i ON i.id = pb.incident_id AND i.type = 'incident'
          ORDER BY pb.created_at DESC, pb.incident_id ASC
          LIMIT ?`,
      )
      .all(limit) as ListingRaw[];
    return rows.map((r) => ({
      row: toRow(r),
      title: r.incident_title,
      pagerdutyServiceId: typeof r.incident_pd_service_id === "string" ? r.incident_pd_service_id : null,
    }));
  }
```

After `incidentTitle`:

```ts
  incidentPagerdutyServiceId(incidentId: string): string | null {
    const r = this.db
      .query(`SELECT ${PD_SERVICE_SQL} AS v FROM item i WHERE i.id = ? AND i.type = 'incident'`)
      .get(incidentId) as { v: unknown } | null;
    return r !== null && typeof r.v === "string" ? r.v : null;
  }
```

- [ ] **Step 4: Implement `oncall-push-rpc.ts`.** Add `import { parseHeadlineBrief, resolvePushService } from "../oncall-push/push-headline.ts";`, add `service: string | null;` to `PushedBriefSummary`, and replace `summarize` / `detail` and the `briefs:` line in `handleList`:

```ts
function summarize(
  r: PushedBriefRow,
  title: string | null,
  pagerdutyServiceId: string | null,
): PushedBriefSummary {
  // Same rule as the ChatOps headline: a failed row has no usable brief.
  const brief = r.status === "ok" ? parseHeadlineBrief(r.briefJson) : null;
  return {
    incidentId: r.incidentId,
    status: r.status,
    createdAt: r.createdAt,
    retriedAt: r.retriedAt,
    title,
    service: resolvePushService(brief, pagerdutyServiceId),
  };
}
function detail(ctx: OncallPushRpcCtx, r: PushedBriefRow): PushedBriefDetail {
  const store = ctx.runtime.store;
  return {
    ...summarize(r, store.incidentTitle(r.incidentId), store.incidentPagerdutyServiceId(r.incidentId)),
    briefMarkdown: r.briefMarkdown,
    failureCode: r.failureCode,
    delivery: { ...r.delivery },
  };
}
```

In `handleList`:

```ts
    briefs: ctx.runtime.store
      .listWithIncident(limit)
      .map((l) => summarize(l.row, l.title, l.pagerdutyServiceId)),
```

`dispatchers-oncall-push.test.ts`'s `fakeRuntime` casts a store without `listWithIncident`. If a test there calls `oncall.pushedList` and now throws, add `listWithIncident: () => []` and `incidentPagerdutyServiceId: () => null` to that fake's `store` object.

- [ ] **Step 5: Run them and confirm they pass.** Run `bun test packages/gateway/src/oncall-push packages/gateway/src/ipc/oncall-push-rpc.test.ts packages/gateway/src/ipc/server/dispatchers-oncall-push.test.ts`, then `bun run typecheck`.
- [ ] **Step 6: Red-prove.** (a) Replace `PD_SERVICE_SQL` with the bare `json_extract(...)`: the malformed-metadata test fails with a SQLite error. (b) Drop `AND i.type = 'incident'`: nothing visible should change. That check is not a red-proof; skip it. Restore (a).
- [ ] **Step 7: Commit** (`feat(oncall): service on the pushed-brief read surface, one guarded query`).

---

### Task 3: The cross-package contract fixture

**Files:**
- Create: `packages/gateway/src/ipc/oncall-push-rpc.contract.test.ts`
- Create: `packages/ui/test/fixtures/oncall-pushed.json` (generated by the test, then committed)

**Interfaces:**
- Produces the fixture shape `{ list: PushedBriefList; getOk: { brief: PushedBriefDetail }; getFailed: { brief: PushedBriefDetail }; getMissing: { brief: null } }`. Tasks 6 and 9 consume it.

- [ ] **Step 1: Write the test.**

```ts
// The ONE binding between packages/gateway and packages/ui (which may not import gateway source).
// It drives the REAL rpc over REAL rows (the demo seed and page, plus a failed row from the store's
// own writer), then requires the committed UI fixture to have the SAME SHAPE. Regenerate with
// UPDATE_ONCALL_FIXTURE=1 after an intended shape change; the desktop tests then run on the new
// shape. Values are compared only for shape, since the brief text carries real dates.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fireDemoPage, seedDemoCorpus } from "../demo/seed.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { assembleOncallPushRuntime } from "../oncall-push/push-runtime.ts";
import { dispatchOncallPushRpc } from "./oncall-push-rpc.ts";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "ui", "test", "fixtures", "oncall-pushed.json");
const FIXED_EPOCH = 1_790_000_000_000;

let dbs: Database[] = [];
let roots: string[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

/** A value's type tree: what the desktop depends on, without the volatile values. */
function shape(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, shape(x)]),
    );
  }
  return typeof v;
}

/** Times re-based onto FIXED_EPOCH, so a regenerated fixture differs only where the shape did. */
function normalize(v: unknown, nowMs: number): unknown {
  if (Array.isArray(v)) return v.map((x) => normalize(x, nowMs));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        (k === "createdAt" || k === "retriedAt" || k === "at") && typeof x === "number"
          ? FIXED_EPOCH + (x - nowMs)
          : normalize(x, nowMs),
      ]),
    );
  }
  return v;
}

async function call(method: string, params: unknown, ctx: Parameters<typeof dispatchOncallPushRpc>[2]) {
  const out = await dispatchOncallPushRpc(method, params, ctx);
  if (out.kind !== "hit") throw new Error(`miss: ${method}`);
  return out.value;
}

test("the UI fixture has the shape the real oncall.pushedList / pushedGet return", async () => {
  const root = mkdtempSync(join(tmpdir(), "nimbus-oncall-contract-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  const nowMs = Date.now();
  await seedDemoCorpus(db, { configDir, dataDir, nowMs });
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => nowMs,
    settleImmediately: true,
  });
  const fired = await fireDemoPage(db, rt, nowMs);
  // The pushed_brief row's real writer. No incident is indexed for it, so title and service are
  // null: the desktop's null-handling is exercised from the fixture too.
  rt.store.insert(
    "pagerduty:PCONTRACTFAIL",
    { status: "failed", sessionId: null, failureCode: "timeout: no brief in 30000ms" },
    nowMs + 60_000,
  );
  const ctx = { runtime: rt };
  const live = normalize(
    {
      list: await call("oncall.pushedList", { limit: 50 }, ctx),
      getOk: await call("oncall.pushedGet", { incidentId: fired.incidentId }, ctx),
      getFailed: await call("oncall.pushedGet", { incidentId: "pagerduty:PCONTRACTFAIL" }, ctx),
      getMissing: await call("oncall.pushedGet", { incidentId: "pagerduty:NOPE" }, ctx),
    },
    nowMs,
  );
  if (process.env["UPDATE_ONCALL_FIXTURE"] === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(live, null, 2)}\n`);
  }
  const committed: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
  expect(shape(live)).toEqual(shape(committed));
  // The values the desktop tests rely on, pinned so a regenerated fixture cannot quietly lose them.
  const list = (live as { list: { briefs: { incidentId: string; service: unknown }[] } }).list;
  expect(list.briefs.map((b) => b.incidentId)).toEqual(["pagerduty:PCONTRACTFAIL", fired.incidentId]);
  expect(list.briefs[1]?.service).toBe("payment-service"); // the MAPPED case, from the real brief
}, 60_000);
```

- [ ] **Step 2: Generate the fixture.** `mkdir -p packages/ui/test/fixtures`, then run `UPDATE_ONCALL_FIXTURE=1 bun test packages/gateway/src/ipc/oncall-push-rpc.contract.test.ts`. Expected: PASS, and the file is written.
  - Open it and check it: two briefs, the failed one first with `title: null` and `service: null`, the ok one with `service: "payment-service"`, `getOk.brief.briefMarkdown` a real brief, and `getMissing` equal to `{ "brief": null }`.
  - Run `bunx biome format --write packages/ui/test/fixtures/oncall-pushed.json`, so `bun run lint` stays green. The comparison is shape-only, so formatting cannot break it.
- [ ] **Step 3: Run without the flag.** `bun test packages/gateway/src/ipc/oncall-push-rpc.contract.test.ts`. Expected: PASS.
- [ ] **Step 4: Red-prove.** Temporarily rename `service` to `svc` in `summarize`. The test fails on shape. Restore.
- [ ] **Step 5: Commit** both files (`test(oncall): gateway-validated contract fixture for the desktop panel`).

---

### Task 4: `[service]` in `nimbus oncall pushed list`

**Files:**
- Modify: `packages/cli/src/commands/oncall-pushed.ts`
- Test: `packages/cli/src/commands/oncall-pushed.test.ts`

- [ ] **Step 1: Write the failing test** (next to "list renders one line per brief…")

```ts
  test("list shows [service] before the title when known; unchanged when null", async () => {
    const { s, sink: k } = sink();
    const c = fake({
      "oncall.pushedList": {
        enabled: true,
        identity: "resolved",
        briefs: [{ ...OK, service: "checkout" }, { ...OK, incidentId: "pagerduty:N", service: null }],
      },
    });
    expect(await runOncallPushedWith(c, { mode: "list", json: false }, k, false)).toBe(0);
    const lines = s.out.trimEnd().split("\n");
    expect(lines[0]).toContain("pagerduty:A  [checkout]  P1 A");
    expect(lines[1]).toContain("pagerduty:N  P1 A");
    expect(lines[1]).not.toContain("[");
  });
```

- [ ] **Step 2: Run it and confirm it fails.** `bun test packages/cli/src/commands/oncall-pushed.test.ts`.
- [ ] **Step 3: Implement.** Add `service?: string | null;` to `type Brief`. In `runList`'s loop:

```ts
    const svc = b.service !== undefined && b.service !== null && b.service !== "" ? `[${b.service}]  ` : "";
    sink.out(
      `${new Date(b.createdAt).toISOString()}  ${status}  ${b.incidentId}  ${svc}${b.title ?? ""}\n`,
    );
```

- [ ] **Step 4: Run it and confirm it passes.** The whole file passes, including the existing null-title test.
- [ ] **Step 5: Red-prove.** Make `svc` always `""`. The new test fails. Restore.
- [ ] **Step 6: Commit** (`feat(cli): show the service in nimbus oncall pushed list`).

---

### Task 5: Allowlist 105 → 107 (I7, triple rule, ONE commit)

**Files:**
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs`, `packages/gateway/src/security-invariants.test.ts`, `docs/SECURITY-INVARIANTS.md`, `.claude/commands/nimbus-tauri-allowlist.md`

- [ ] **Step 1: Failing tests first.** In `security-invariants.test.ts`, change the test `"allowlist_exact_size assertion is 105"` to:

```ts
  test("allowlist_exact_size assertion is 107", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/assert_eq!\s*\(\s*ALLOWED_METHODS\.len\(\),\s*107\s*\)/);
  });

  // By NAME, as for every brief/verb pair: a one-for-one swap of pushedGet for pushedRetry keeps
  // the count at 107. pushedRetry starts an agent run on the owner's behalf; it stays CLI-only.
  test("oncall: the two reads are renderer-callable, pushedRetry never is", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/^\s*"oncall\.pushedGet",\s*$/m);
    expect(rust).toMatch(/^\s*"oncall\.pushedList",\s*$/m);
    expect(rust).not.toContain('"oncall.pushedRetry"');
  });
```

In `gateway_bridge.rs` `mod tests`, change `allowlist_exact_size` to `107` and add:

```rust
    #[test]
    fn allowlist_oncall_reads_only() {
        // Phase 17 W2 PR 3: the desktop panel reads pushed briefs. pushedRetry spawns an agent run
        // on the owner's behalf and stays CLI-only (I7); named on both sides because a one-for-one
        // swap would keep allowlist_exact_size unchanged.
        assert!(is_method_allowed("oncall.pushedList"));
        assert!(is_method_allowed("oncall.pushedGet"));
        assert!(!is_method_allowed("oncall.pushedRetry"));
        assert!(!is_no_timeout_method("oncall.pushedList"));
        assert!(!is_no_timeout_method("oncall.pushedGet"));
    }
```

- [ ] **Step 2: Run and confirm it fails.** `bun test packages/gateway/src/security-invariants.test.ts -t "allowlist|oncall"`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `ALLOWED_METHODS`, insert after `"llm.unloadModel",`:

```rust
    "oncall.pushedGet",
    "oncall.pushedList",
```

- [ ] **Step 4: Docs, in the same commit.**
  - `docs/SECURITY-INVARIANTS.md` I7: in the paragraph headed "Post-Phase-6 / Spine S1 additions (94 → 105, the current `allowlist_exact_size`)", remove the words ", the current `allowlist_exact_size`".
  - After the "S2 (2026-09-10): a one-for-one substitution, 105 → 105." paragraph, add:

    > **Phase 17 W2 (2026-10-04): 105 → 107, the current `allowlist_exact_size`.** `oncall.pushedList` and `oncall.pushedGet` joined, both read-only: the desktop's On-call page lists pushed briefs and shows one, with its delivery outcomes. `oncall.pushedRetry` stays CLI-only, because it starts an agent run on the owner's behalf. All three are named on both sides — `allowlist_oncall_reads_only` in `gateway_bridge.rs` and "oncall: the two reads are renderer-callable, pushedRetry never is" in `security-invariants.test.ts` — since a one-for-one swap would leave the count at 107. The `oncall` namespace stays LAN-forbidden; renderer exposure does not change that.

  - Re-read the "A count alone is not the enforcement" paragraph. If it enumerates the named pairs, add the oncall pair there too, so the enumeration matches.
  - `.claude/commands/nimbus-tauri-allowlist.md`: change "Currently 105 entries" to 107 and `ALLOWED_METHODS.len() == 105` to 107. In the line listing the test names, add `allowlist_oncall_reads_only`.
- [ ] **Step 5: Run and confirm it passes.**
  - Run `bun test packages/gateway/src/security-invariants.test.ts` (all I7 tests), `bun run audit:doc-refs` and `bun run audit:status-drift`.
  - Run `cargo test --manifest-path packages/ui/src-tauri/Cargo.toml allowlist` with a 15-minute timeout.
    - If the Rust toolchain cannot build Tauri on this machine, record that in the report. The "PR quality — Rust/Tauri" CI job runs it, and `allowlist_is_alphabetized` confirms the insertion point there.
- [ ] **Step 6: Red-prove.** Add `"oncall.pushedRetry",` to the list. The TS test fails, and so does the Rust test if it ran. Restore.
- [ ] **Step 7: Commit** all four files in ONE commit (`feat(ui): expose the two oncall read methods to the renderer (I7, 105 → 107)`).

---

### Task 6: UI types, the `oncall` store slice, and persistence

**Files:**
- Modify: `packages/ui/src/ipc/types.ts`, `packages/ui/src/store/index.ts`, `packages/ui/src/store/partialize.ts`
- Create: `packages/ui/src/store/slices/oncall.ts`
- Test: `packages/ui/test/store/oncall.test.ts` (new), `packages/ui/test/store/partialize.test.ts`

**Interfaces:**
- Produces, in `ipc/types.ts`:

```ts
export interface PushedBriefSummary {
  readonly incidentId: string;
  readonly status: "ok" | "failed";
  readonly createdAt: number;
  readonly retriedAt: number | null;
  readonly title: string | null;
  readonly service: string | null;
}
export interface PushSinkOutcome {
  readonly outcome: string;
  readonly reason?: string;
  readonly at: number;
}
export interface PushedBriefDetail extends PushedBriefSummary {
  readonly briefMarkdown: string | null;
  readonly failureCode: string | null;
  readonly delivery: Readonly<Record<string, PushSinkOutcome>>;
}
export interface PushedBriefList {
  readonly enabled: boolean;
  readonly identity: "resolved" | "unresolved";
  readonly briefs: readonly PushedBriefSummary[];
}
export interface PushedBriefGet {
  readonly brief: PushedBriefDetail | null;
}
```

- Produces the store: `lastSeenPushedAt: number` and `markPushedSeen(createdAt: number): void`.

- [ ] **Step 1: Write the failing tests.** `test/store/oncall.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useNimbusStore } from "../../src/store";

describe("oncall slice", () => {
  beforeEach(() => useNimbusStore.setState({ lastSeenPushedAt: 0 }));
  it("starts at 0 and only ever moves forward", () => {
    const { markPushedSeen } = useNimbusStore.getState();
    markPushedSeen(100);
    expect(useNimbusStore.getState().lastSeenPushedAt).toBe(100);
    markPushedSeen(50);
    expect(useNimbusStore.getState().lastSeenPushedAt).toBe(100);
    markPushedSeen(Number.NaN);
    expect(useNimbusStore.getState().lastSeenPushedAt).toBe(100);
  });
  it("survives a rehydrate from storage", async () => {
    localStorage.setItem(
      "nimbus-ui-store",
      JSON.stringify({ state: { lastSeenPushedAt: 42 }, version: 1 }),
    );
    await useNimbusStore.persist.rehydrate();
    expect(useNimbusStore.getState().lastSeenPushedAt).toBe(42);
  });
});
```

In `partialize.test.ts`:
- In the first test, add `lastSeenPushedAt: 7,` to `full` and `"lastSeenPushedAt"` to the expected key list.
- Rename the count test to "still has WHITELISTED_PERSIST_KEYS at exactly 6 entries", with `toHaveLength(6)`.

- [ ] **Step 2: Run them and confirm they fail.** `cd packages/ui && bunx vitest run test/store/oncall.test.ts test/store/partialize.test.ts`.
- [ ] **Step 3: Implement.** Add the types above to the end of `ipc/types.ts`. Create `store/slices/oncall.ts`:

```ts
import type { StateCreator } from "zustand";

export interface OncallSlice {
  /** The newest pushed brief's `createdAt` the owner has seen on /oncall. Drives the sidebar dot. */
  readonly lastSeenPushedAt: number;
  markPushedSeen: (createdAt: number) => void;
}

export const createOncallSlice: StateCreator<OncallSlice, [], [], OncallSlice> = (set) => ({
  lastSeenPushedAt: 0,
  // Forward-only: a stale list (or a bad value) can never re-light the dot for something seen.
  markPushedSeen: (createdAt) =>
    set((s) =>
      Number.isFinite(createdAt) && createdAt > s.lastSeenPushedAt
        ? { lastSeenPushedAt: createdAt }
        : {},
    ),
});
```

In `store/index.ts`:
- Import `createOncallSlice, type OncallSlice`.
- Add `& OncallSlice` to `NimbusStore`.
- Add `...createOncallSlice(...a),` to the creator.

In `partialize.ts`, append `"lastSeenPushedAt",` to `WHITELISTED_PERSIST_KEYS`.

- [ ] **Step 4: Run them and confirm they pass.** Run the same command plus `bunx vitest run test/store` (the whole store suite), then `bun run typecheck && bun run typecheck:tests` from the worktree root.
- [ ] **Step 5: Red-prove.** Drop the `createdAt > s.lastSeenPushedAt` condition. The forward-only test fails. Restore.
- [ ] **Step 6: Commit** (`feat(ui): types and persisted last-seen state for pushed briefs`).

---

### Task 7: `NavItem` dot

**Files:**
- Modify: `packages/ui/src/components/chrome/NavItem.tsx`
- Test: the existing NavItem test file if one exists under `packages/ui/test/components/chrome/`, else `NavItem.test.tsx` (new)

- [ ] **Step 1: Write the failing tests.**

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { NavItem } from "../../../src/components/chrome/NavItem";

const at = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("NavItem indicator", () => {
  it("renders a dot with its hidden label", () => {
    at(<NavItem to="/oncall" icon="☎" label="On-call" dot dotLabel="new pushed brief" />);
    expect(screen.getByTestId("nav-dot")).toBeInTheDocument();
    expect(screen.getByText("new pushed brief")).toHaveClass("sr-only");
  });
  it("a positive badge wins over the dot", () => {
    at(<NavItem to="/x" icon="x" label="X" badge={2} dot dotLabel="d" />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-dot")).toBeNull();
  });
  it("no dot when dot is false or absent", () => {
    at(<NavItem to="/x" icon="x" label="X" dot={false} />);
    expect(screen.queryByTestId("nav-dot")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** `cd packages/ui && bunx vitest run test/components/chrome`.
- [ ] **Step 3: Implement.** In `NavItemProps`, add `readonly dot?: boolean | undefined;` and `readonly dotLabel?: string | undefined;`. Add:

```tsx
function Indicator({ badge, dot, dotLabel }: Pick<NavItemProps, "badge" | "dot" | "dotLabel">): ReactNode {
  if (badge !== undefined && badge > 0) {
    return (
      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-[var(--color-accent)] text-white text-[10px]">
        {formatBadge(badge)}
      </span>
    );
  }
  if (dot === true) {
    return (
      <span data-testid="nav-dot" className="inline-block w-2 h-2 rounded-full bg-[var(--color-accent)]">
        <span className="sr-only">{dotLabel ?? "new"}</span>
      </span>
    );
  }
  return null;
}
```

Destructure `dot` and `dotLabel` in `NavItem`, and replace the existing `{badge !== undefined && badge > 0 && (…)}` block with `<Indicator badge={badge} dot={dot} dotLabel={dotLabel} />`.

- [ ] **Step 4: Run them and confirm they pass,** including the existing Sidebar badge test.
- [ ] **Step 5: Red-prove.** Swap the two `if` blocks in `Indicator`. "a positive badge wins" fails. Restore.
- [ ] **Step 6: Commit** (`feat(ui): NavItem can show an unread dot`).

---

### Task 8: `OncallBriefsProvider`, `useOncallBriefs`, the layout mount and the sidebar entry

**Files:**
- Create: `packages/ui/src/hooks/useOncallBriefs.ts`, `packages/ui/src/providers/OncallBriefsProvider.tsx`
- Modify: `packages/ui/src/layouts/RootLayout.tsx`, `packages/ui/src/components/chrome/Sidebar.tsx`
- Test: `packages/ui/test/hooks/useOncallBriefs.test.ts` (new), `packages/ui/test/providers/OncallBriefsProvider.test.tsx` (new), `packages/ui/test/components/chrome/Sidebar.test.tsx`

**Interfaces:**
- Produces, in `hooks/useOncallBriefs.ts`:
  - `export interface OncallBriefsState { readonly list: PushedBriefList | null; readonly error: string | null; readonly isLoading: boolean; readonly lastPushed: { readonly incidentId: string; readonly seq: number } | null; refetch: () => void }`
  - `export const OncallBriefsContext`
  - `export function useOncallBriefs(): OncallBriefsState`, which throws outside the provider
  - `export function parseBriefPushed(n: JsonRpcNotification): { readonly incidentId: string | null } | null`
  - `export function asPushedBriefList(v: unknown): PushedBriefList | null`
  - `export function asPushedBriefGet(v: unknown): PushedBriefGet | undefined`
- Produces: `export function OncallBriefsProvider({ children }: { children: ReactNode }): ReactNode`.

- [ ] **Step 1: Write the failing tests.**

`test/hooks/useOncallBriefs.test.ts`. These are pure narrowers, built from the fixture plus explicit malformed inputs:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { asPushedBriefGet, asPushedBriefList, parseBriefPushed } from "../../src/hooks/useOncallBriefs";

const fixture: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/oncall-pushed.json", import.meta.url)), "utf8"),
);
const part = (k: string): unknown => (fixture as Record<string, unknown>)[k];

describe("parseBriefPushed", () => {
  it("matches oncall.briefPushed and carries its id", () => {
    expect(
      parseBriefPushed({
        method: "gateway.event",
        params: { kind: "oncall.briefPushed", ts: 1, payload: { incidentId: "pagerduty:A", status: "ok" } },
      }),
    ).toEqual({ incidentId: "pagerduty:A" });
  });
  it("a matching kind with an unusable payload still matches, with a null id", () => {
    expect(parseBriefPushed({ method: "gateway.event", params: { kind: "oncall.briefPushed", payload: 5 } })).toEqual({
      incidentId: null,
    });
  });
  it("ignores every other notification, including malformed ones", () => {
    for (const n of [
      { method: "gateway.event", params: { kind: "sync.completed", payload: {} } },
      { method: "connector.healthChanged", params: { kind: "oncall.briefPushed" } },
      { method: "gateway.event", params: null },
      { method: "gateway.event", params: {} },
      { method: "gateway.event", params: "oncall.briefPushed" },
    ]) {
      expect(parseBriefPushed(n)).toBeNull();
    }
  });
});

describe("asPushedBriefList / asPushedBriefGet", () => {
  it("accept the gateway-validated fixture", () => {
    expect(asPushedBriefList(part("list"))?.briefs.length).toBe(2);
    expect(asPushedBriefGet(part("getOk"))?.brief?.briefMarkdown).toEqual(expect.any(String));
    expect(asPushedBriefGet(part("getMissing"))).toEqual({ brief: null });
  });
  it("reject what is not that shape", () => {
    for (const v of [null, undefined, 3, {}, { enabled: true }, { enabled: true, briefs: "x" }]) {
      expect(asPushedBriefList(v)).toBeNull();
    }
    for (const v of [null, undefined, {}, { brief: 3 }]) expect(asPushedBriefGet(v)).toBeUndefined();
  });
});
```

`test/providers/OncallBriefsProvider.test.tsx`:

```tsx
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcNotification } from "../../src/ipc/types";

const query = { data: null as unknown, error: null as string | null, isLoading: false, refetch: vi.fn() };
vi.mock("../../src/hooks/useIpcQuery", () => ({ useIpcQuery: () => query }));
let handler: ((n: JsonRpcNotification) => void) | undefined;
vi.mock("../../src/ipc/client", () => ({
  createIpcClient: () => ({
    subscribe: async (h: (n: JsonRpcNotification) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
  }),
}));

import { useOncallBriefs } from "../../src/hooks/useOncallBriefs";
import { OncallBriefsProvider } from "../../src/providers/OncallBriefsProvider";

function Probe() {
  const s = useOncallBriefs();
  return <span data-testid="seq">{s.lastPushed === null ? "none" : `${s.lastPushed.incidentId}#${s.lastPushed.seq}`}</span>;
}
const pushed = (id: string): JsonRpcNotification => ({
  method: "gateway.event",
  params: { kind: "oncall.briefPushed", ts: 1, payload: { incidentId: id, status: "ok" } },
});

describe("OncallBriefsProvider", () => {
  beforeEach(() => {
    query.refetch.mockReset();
    handler = undefined;
  });
  it("one matching event → exactly one refetch, and lastPushed names it", async () => {
    render(<OncallBriefsProvider><Probe /></OncallBriefsProvider>);
    await vi.waitFor(() => expect(handler).toBeDefined());
    act(() => handler?.(pushed("pagerduty:A")));
    expect(query.refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("seq").textContent).toBe("pagerduty:A#1");
  });
  it("two events for the same id → two refetches, seq advances (Review Focus 5)", async () => {
    render(<OncallBriefsProvider><Probe /></OncallBriefsProvider>);
    await vi.waitFor(() => expect(handler).toBeDefined());
    act(() => handler?.(pushed("pagerduty:A")));
    act(() => handler?.(pushed("pagerduty:A")));
    expect(query.refetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("seq").textContent).toBe("pagerduty:A#2");
  });
  it("other notifications cause no refetch", async () => {
    render(<OncallBriefsProvider><Probe /></OncallBriefsProvider>);
    await vi.waitFor(() => expect(handler).toBeDefined());
    act(() => handler?.({ method: "gateway.event", params: { kind: "sync.completed", payload: {} } }));
    act(() => handler?.({ method: "connector.healthChanged", params: {} }));
    expect(query.refetch).not.toHaveBeenCalled();
  });
  it("useOncallBriefs outside the provider throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/OncallBriefsProvider/);
    spy.mockRestore();
  });
});
```

In `Sidebar.test.tsx`:
- Extend the store mock's state to `{ pendingHitl: 3, lastSeenPushedAt: 100 }`.
- Wrap every render in `<OncallBriefsContext.Provider value={stub(newestCreatedAt)}>`, where `stub` builds an `OncallBriefsState` whose `list.briefs[0].createdAt` is the argument.
- Update "renders all six" to seven, adding the `On-call` link.
- Add: the dot is shown when the newest `createdAt` is 200 (> 100), and absent when it is 100 or there are no briefs.

- [ ] **Step 2: Run them and confirm they fail.** `cd packages/ui && bunx vitest run test/hooks/useOncallBriefs.test.ts test/providers/OncallBriefsProvider.test.tsx test/components/chrome/Sidebar.test.tsx`.

- [ ] **Step 3: Implement `hooks/useOncallBriefs.ts`.**

```ts
import { createContext, useContext } from "react";
import type { JsonRpcNotification, PushedBriefGet, PushedBriefList } from "../ipc/types";

export interface OncallBriefsState {
  readonly list: PushedBriefList | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  /** The last `oncall.briefPushed` with a usable id; `seq` advances on EVERY such event. */
  readonly lastPushed: { readonly incidentId: string; readonly seq: number } | null;
  refetch: () => void;
}

export const OncallBriefsContext = createContext<OncallBriefsState | null>(null);

export function useOncallBriefs(): OncallBriefsState {
  const v = useContext(OncallBriefsContext);
  if (v === null) throw new Error("useOncallBriefs must be used inside <OncallBriefsProvider>");
  return v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `null` = not a pushed-brief event. A match with an unusable payload carries a null id. */
export function parseBriefPushed(n: JsonRpcNotification): { readonly incidentId: string | null } | null {
  if (n.method !== "gateway.event" || !isRecord(n.params)) return null;
  if (n.params["kind"] !== "oncall.briefPushed") return null;
  const payload = n.params["payload"];
  const id = isRecord(payload) ? payload["incidentId"] : undefined;
  return { incidentId: typeof id === "string" && id !== "" ? id : null };
}

/** Shallow: the fixture-backed contract test pins the full shape on the gateway side. */
export function asPushedBriefList(v: unknown): PushedBriefList | null {
  if (!isRecord(v) || typeof v["enabled"] !== "boolean" || !Array.isArray(v["briefs"])) return null;
  return v as unknown as PushedBriefList;
}

/**
 * THREE states, deliberately: `undefined` = nothing usable yet (loading, or not this shape);
 * `{ brief: null }` = the gateway answered and the brief is gone (pruned): BriefDetail reports it;
 * `{ brief: … }` = a brief. Collapsing the first two would announce "pruned" while still loading.
 */
export function asPushedBriefGet(v: unknown): PushedBriefGet | undefined {
  if (!isRecord(v) || !("brief" in v)) return undefined;
  const b = v["brief"];
  if (b === null) return { brief: null };
  return isRecord(b) && typeof b["incidentId"] === "string" ? (v as unknown as PushedBriefGet) : undefined;
}
```

- [ ] **Step 4: Implement `providers/OncallBriefsProvider.tsx`.**

```tsx
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { asPushedBriefList, OncallBriefsContext, type OncallBriefsState, parseBriefPushed } from "../hooks/useOncallBriefs";
import { useIpcQuery } from "../hooks/useIpcQuery";
import { createIpcClient } from "../ipc/client";
import type { JsonRpcNotification } from "../ipc/types";

/**
 * Owns the ONE pushed-brief list query and the ONE gateway-notification subscription for the app
 * (spec § 2.2), so the sidebar dot and the On-call page never double-fetch on an event. The 60 s
 * poll is the backstop for events missed while the bridge reconnects; `useIpcQuery` also re-runs
 * when the connection returns to `connected`.
 */
export function OncallBriefsProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const { data, error, isLoading, refetch } = useIpcQuery<unknown>("oncall.pushedList", 60_000, { limit: 50 });
  const [lastPushed, setLastPushed] = useState<OncallBriefsState["lastPushed"]>(null);

  const onNotification = useCallback(
    (n: JsonRpcNotification) => {
      const ev = parseBriefPushed(n);
      if (ev === null) return;
      refetch();
      const id = ev.incidentId;
      if (id !== null) setLastPushed((prev) => ({ incidentId: id, seq: (prev?.seq ?? 0) + 1 }));
    },
    [refetch],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void createIpcClient()
      .subscribe(onNotification)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [onNotification]);

  const value = useMemo<OncallBriefsState>(
    () => ({ list: asPushedBriefList(data), error, isLoading, lastPushed, refetch }),
    [data, error, isLoading, lastPushed, refetch],
  );
  return <OncallBriefsContext.Provider value={value}>{children}</OncallBriefsContext.Provider>;
}
```

- [ ] **Step 5: Mount it and add the sidebar entry.** In `RootLayout.tsx`, import `OncallBriefsProvider` and wrap the `<Sidebar />` and `<main>…</main>` pair (inside the `flex flex-1 min-h-0` div) with `<OncallBriefsProvider>…</OncallBriefsProvider>`. In `Sidebar.tsx`:

```tsx
const ENTRIES: ReadonlyArray<{ to: string; icon: string; label: string }> = [
  { to: "/", icon: "▦", label: "Dashboard" },
  { to: "/oncall", icon: "☎", label: "On-call" },
  { to: "/hitl", icon: "⚠", label: "HITL" },
  { to: "/marketplace", icon: "⚙", label: "Marketplace" },
  { to: "/watchers", icon: "👁", label: "Watchers" },
  { to: "/workflows", icon: "▶", label: "Workflows" },
  { to: "/settings", icon: "⚙", label: "Settings" },
];
```

Inside `Sidebar`:

```tsx
  const lastSeenPushedAt = useNimbusStore((s) => s.lastSeenPushedAt);
  const newest = useOncallBriefs().list?.briefs[0];
  const oncallDot = newest !== undefined && newest.createdAt > lastSeenPushedAt;
```

Pass the new props to each `NavItem`:

```tsx
          dot={e.to === "/oncall" ? oncallDot : undefined}
          dotLabel={e.to === "/oncall" ? "new pushed brief" : undefined}
```

- [ ] **Step 6: Run them and confirm they pass.** `cd packages/ui && bunx vitest run test/hooks test/providers test/components/chrome test/layouts`. The RootLayout tests must stay green: the provider only queries when the connection is `connected`, and they mock `listen`. Then run `bun run typecheck && bun run typecheck:tests`.
- [ ] **Step 7: Red-prove.** (a) Remove the `kind !== "oncall.briefPushed"` check: "other notifications cause no refetch" fails. (b) Change `seq: (prev?.seq ?? 0) + 1` to `seq: 1`: the two-events test fails. Restore.
- [ ] **Step 8: Commit** (`feat(ui): pushed-brief provider, live on oncall.briefPushed, plus the sidebar entry`).

---

### Task 9: The On-call page

**Files:**
- Create: `packages/ui/src/pages/Oncall.tsx`, `packages/ui/src/components/oncall/BriefList.tsx`, `BriefDetail.tsx`, `DeliveryStrip.tsx`, `format.ts`
- Modify: `packages/ui/src/App.tsx`
- Test: `packages/ui/test/pages/Oncall.test.tsx` (new), `packages/ui/test/components/oncall/format.test.ts` (new), `packages/ui/test/components/oncall/DeliveryStrip.test.tsx` (new)

**Interfaces:**
- Consumes: `useOncallBriefs` / `asPushedBriefGet` (Task 8), `useIpcQuery`, `useNimbusStore` (`markPushedSeen`), and the types (Task 6).
- Produces:
  - `format.ts`: `export function formatAge(createdAt: number, nowMs: number): string` and `export function orderedSinks(delivery: Readonly<Record<string, PushSinkOutcome>>): [string, PushSinkOutcome][]`
  - `export function Oncall(): ReactNode`

- [ ] **Step 1: Write the failing tests.**

`test/components/oncall/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatAge, orderedSinks } from "../../../src/components/oncall/format";

describe("formatAge", () => {
  const now = 1_790_000_000_000;
  it("buckets", () => {
    expect(formatAge(now - 20_000, now)).toBe("just now");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatAge(now - 2 * 86_400_000, now)).toBe("2 d ago");
  });
  it("a gateway clock ahead of ours reads 'just now', never negative (Review Focus 4)", () => {
    expect(formatAge(now + 90_000, now)).toBe("just now");
  });
});

describe("orderedSinks", () => {
  it("event, toast, chatops first, then the rest alphabetically; absent ones omitted", () => {
    const o = { outcome: "delivered", at: 1 };
    expect(orderedSinks({ zed: o, chatops: o, event: o, alpha: o }).map(([k]) => k)).toEqual([
      "event",
      "chatops",
      "alpha",
      "zed",
    ]);
  });
});
```

`test/components/oncall/DeliveryStrip.test.tsx` must cover:
- An outcome with a reason renders both: `chatops: skipped` and `no [oncall.push] chatops_namespace`.
- An outcome with no reason renders no stray separator.
- `queryByText(/undefined|null/)` is `null`.

`test/pages/Oncall.test.tsx` loads the fixture the same way as Task 8. It mocks:
- `../../src/hooks/useOncallBriefs` as `{ ...actual, useOncallBriefs: () => briefs }`, where `briefs` is a mutable `OncallBriefsState`.
- `../../src/hooks/useIpcQuery` as a per-method function returning a mutable `{ data, error, isLoading, refetch }` keyed by `params.incidentId`.

It renders `<MemoryRouter initialEntries={[path]}><Routes><Route path="/oncall" element={<Oncall />} /></Routes></MemoryRouter>`. The `markPushedSeen` spy comes from `useNimbusStore.setState({ markPushedSeen: spy })`. Cases:
1. The list from the fixture renders both rows. The failed row (title null, service null) shows its incident id and no `null`/`undefined` text (Review Focus 3).
2. `/oncall` with no `id`: the location becomes `/oncall?id=pagerduty%3APCONTRACTFAIL` (the newest). Read it through a probe that renders `useLocation().search` and `useNavigationType()`. The navigation type is `"REPLACE"`, so no history entry was added.
3. `?id=<ok id>`: the detail `<pre>` text equals `getOk.brief.briefMarkdown` exactly. The delivery strip shows `chatops`.
4. A detail whose `briefMarkdown` is `<img src=x onerror=alert(1)>` renders that literal string, and `container.querySelector("img")` is `null`.
5. A failed row shows `timeout: no brief in 30000ms` and `nimbus oncall pushed pagerduty:PCONTRACTFAIL --retry`, and `queryByRole("button", { name: /retry/i })` is `null`.
6. Start at `/oncall?id=pagerduty:NOPE` with that id's detail query returning `getMissing`. `pagerduty:NOPE was pruned (older than retention_days).` shows, the URL no longer names `pagerduty:NOPE`, and the page falls back to the newest brief (auto-select runs once `id` is cleared). The notice clears when the user selects another row.
7. Push off (`enabled: false`), identity unresolved, and zero briefs: each shows its verbatim Global-Constraints string.
8. `error: "Method not found"`: `Could not load pushed briefs: Method not found. From a terminal: nimbus oncall pushed`.
9. Review Focus 1: render with `?id=<older ok id>`, then replace `briefs.list` with a list that has a NEW newest row and re-render. The URL still names the older id, and its brief is still shown.
10. Review Focus 2: a list containing `pagerduty:A/B#c?d`. Clicking its row puts `?id=pagerduty%3AA%2FB%23c%3Fd` in the URL, and the detail query is called with `{ incidentId: "pagerduty:A/B#c?d" }`.
11. Live arrival: with `/oncall` mounted, a list update whose newest `createdAt` is larger calls `markPushedSeen` with the new value (dot stays off).
13. No prune loop (plan review § 2.1). The cached list's NEWEST row is the pruned id `pagerduty:PGONE`, with one older ok row behind it. Start at `/oncall` and let the detail query for `pagerduty:PGONE` return `{ brief: null }`.
    - The pruned notice shows.
    - The URL ends on the OLDER row's id.
    - The detail query for `pagerduty:PGONE` was requested exactly once.
    - The list's `refetch` was called once.
    - Red-proved by reverting `autoId` to `newest?.incidentId`: the `pagerduty:PGONE` query count climbs, so assert it stays at 1 after `waitFor` settles.
12. `BriefDetail` refetch: setting `briefs.lastPushed = { incidentId: <selected>, seq: 1 }` and re-rendering calls that detail query's `refetch`. A `lastPushed` for another id does not.

- [ ] **Step 2: Run them and confirm they fail.** `cd packages/ui && bunx vitest run test/pages/Oncall.test.tsx test/components/oncall`.

- [ ] **Step 3: Implement `components/oncall/format.ts`.**

```ts
import type { PushSinkOutcome } from "../../ipc/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Coarse and never negative: a gateway clock ahead of ours reads "just now". */
export function formatAge(createdAt: number, nowMs: number): string {
  const d = nowMs - createdAt;
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  return `${Math.floor(d / DAY)} d ago`;
}

const SINK_ORDER = ["event", "toast", "chatops"];

export function orderedSinks(
  delivery: Readonly<Record<string, PushSinkOutcome>>,
): [string, PushSinkOutcome][] {
  const known = SINK_ORDER.filter((k) => k in delivery);
  const rest = Object.keys(delivery)
    .filter((k) => !SINK_ORDER.includes(k))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...rest].map((k) => [k, delivery[k] as PushSinkOutcome]);
}
```

- [ ] **Step 4: Implement `DeliveryStrip.tsx`.**

```tsx
import type { ReactNode } from "react";
import type { PushSinkOutcome } from "../../ipc/types";
import { orderedSinks } from "./format";

export function DeliveryStrip({ delivery }: { readonly delivery: Readonly<Record<string, PushSinkOutcome>> }): ReactNode {
  const sinks = orderedSinks(delivery);
  if (sinks.length === 0) return null;
  return (
    <ul aria-label="Delivery" className="flex flex-wrap gap-2 text-xs">
      {sinks.map(([sink, o]) => (
        <li key={sink} className="px-2 py-1 rounded border border-[var(--color-border)]">
          <span className="text-[var(--color-fg)]">{`${sink}: ${o.outcome}`}</span>
          {o.reason !== undefined && o.reason !== "" && (
            <span className="ml-1 text-[var(--color-fg-muted)]">{o.reason}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Implement `BriefList.tsx`.**

```tsx
import type { ReactNode } from "react";
import type { PushedBriefSummary } from "../../ipc/types";
import { formatAge } from "./format";

export function BriefList(props: {
  readonly briefs: readonly PushedBriefSummary[];
  readonly selectedId: string | null;
  readonly onSelect: (incidentId: string) => void;
  readonly nowMs: number;
}): ReactNode {
  return (
    <ul aria-label="Pushed briefs" className="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-md">
      {props.briefs.map((b) => (
        <li key={b.incidentId}>
          <button
            type="button"
            aria-current={b.incidentId === props.selectedId ? "true" : undefined}
            onClick={() => props.onSelect(b.incidentId)}
            className={`w-full text-left px-3 py-2 text-xs ${b.incidentId === props.selectedId ? "bg-[rgba(120,144,255,0.15)]" : ""}`}
          >
            <div className="text-[var(--color-fg)] truncate">{b.title ?? b.incidentId}</div>
            <div className="flex gap-2 text-[var(--color-fg-muted)]">
              {b.service !== null && <span>{b.service}</span>}
              <span className={b.status === "ok" ? "text-[var(--color-ok)]" : "text-[var(--color-error)]"}>
                {b.status === "ok" ? "ready" : "failed"}
              </span>
              <span className="ml-auto">{formatAge(b.createdAt, props.nowMs)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: Implement `BriefDetail.tsx`.** It is keyed by id in the page, so a selection change REMOUNTS it. That gives a fresh query and discards any in-flight response from the previous selection.

```tsx
import { type ReactNode, useEffect } from "react";
import { asPushedBriefGet, useOncallBriefs } from "../../hooks/useOncallBriefs";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { DeliveryStrip } from "./DeliveryStrip";

export function BriefDetail({
  incidentId,
  onPruned,
}: {
  readonly incidentId: string;
  readonly onPruned: (incidentId: string) => void;
}): ReactNode {
  const { data, error, refetch } = useIpcQuery<unknown>("oncall.pushedGet", 60_000, { incidentId });
  const { lastPushed } = useOncallBriefs();
  useEffect(() => {
    if (lastPushed !== null && lastPushed.incidentId === incidentId) refetch();
  }, [lastPushed, incidentId, refetch]);
  const got = asPushedBriefGet(data);
  useEffect(() => {
    if (got !== undefined && got.brief === null) onPruned(incidentId);
  }, [got, incidentId, onPruned]);

  if (error !== null) {
    return <p role="alert" className="text-sm">{`Could not load pushed briefs: ${error}. From a terminal: nimbus oncall pushed`}</p>;
  }
  if (got === undefined || got.brief === null || got.brief.incidentId !== incidentId) {
    return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  }
  const b = got.brief;
  return (
    <article aria-label="Pushed brief" className="space-y-3">
      <DeliveryStrip delivery={b.delivery} />
      {b.status === "failed" ? (
        <div className="text-sm space-y-1">
          <p>{`The brief for ${b.incidentId} could not be assembled: ${b.failureCode ?? "unknown"}`}</p>
          <pre className="font-mono text-xs">{`nimbus oncall pushed ${b.incidentId} --retry`}</pre>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs border border-[var(--color-border)] rounded-md p-3">
          {b.briefMarkdown ?? ""}
        </pre>
      )}
    </article>
  );
}
```

- [ ] **Step 7: Implement `pages/Oncall.tsx`.**

```tsx
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { PageHeader } from "../components/chrome/PageHeader";
import { BriefDetail } from "../components/oncall/BriefDetail";
import { BriefList } from "../components/oncall/BriefList";
import { useOncallBriefs } from "../hooks/useOncallBriefs";
import { useNimbusStore } from "../store";

const PUSH_OFF = "On-call push is off. Set [oncall.push] enabled = true in nimbus.toml.";
const IDENTITY_UNRESOLVED =
  "On-call push is enabled but your identity is unresolved, so no incident can be selected. Set [user] me_person_id in nimbus.toml or `git config user.email`.";

export function Oncall(): ReactNode {
  const { list, error, refetch } = useOncallBriefs();
  const [params, setParams] = useSearchParams();
  const markPushedSeen = useNimbusStore((s) => s.markPushedSeen);
  const [pruned, setPruned] = useState<string | null>(null);
  const briefs = list?.briefs ?? [];
  const newest = briefs[0];
  const selectedId = params.get("id");

  // Live arrival while the page is open must not light the dot: mark EVERY new newest as seen.
  const newestCreatedAt = newest?.createdAt;
  useEffect(() => {
    if (newestCreatedAt !== undefined) markPushedSeen(newestCreatedAt);
  }, [newestCreatedAt, markPushedSeen]);

  // Auto-select ONLY when nothing is selected, so an arrival never yanks the reader away. The target
  // skips a just-pruned id: the cached list can still name it until the list refetch below lands,
  // and re-selecting it would remount BriefDetail, fetch `{ brief: null }` again, clear `id` again,
  // and loop (plan review § 2.1).
  const autoId = briefs.find((b) => b.incidentId !== pruned)?.incidentId;
  useEffect(() => {
    if (selectedId === null && autoId !== undefined) setParams({ id: autoId }, { replace: true });
  }, [selectedId, autoId, setParams]);

  const onSelect = useCallback(
    (id: string) => {
      setPruned(null);
      setParams({ id });
    },
    [setParams],
  );
  const onPruned = useCallback(
    (id: string) => {
      setPruned(id);
      setParams({}, { replace: true });
      refetch(); // the list may still carry the pruned row; refresh it rather than wait 60 s
    },
    [setParams, refetch],
  );

  return (
    <>
      <PageHeader title="On-call" />
      <div className="p-6 space-y-4">
        {pruned !== null && <p className="text-sm">{`${pruned} was pruned (older than retention_days).`}</p>}
        <Body
          list={list}
          error={error}
          selectedId={selectedId}
          onSelect={onSelect}
          onPruned={onPruned}
          enabledHint={PUSH_OFF}
          identityHint={IDENTITY_UNRESOLVED}
        />
      </div>
    </>
  );
}

function Body(props: {
  readonly list: ReturnType<typeof useOncallBriefs>["list"];
  readonly error: string | null;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onPruned: (id: string) => void;
  readonly enabledHint: string;
  readonly identityHint: string;
}): ReactNode {
  if (props.error !== null) {
    return <p role="alert" className="text-sm">{`Could not load pushed briefs: ${props.error}. From a terminal: nimbus oncall pushed`}</p>;
  }
  if (props.list === null) return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  if (props.list.briefs.length === 0) {
    if (!props.list.enabled) return <p className="text-sm">{props.enabledHint}</p>;
    if (props.list.identity === "unresolved") return <p className="text-sm">{props.identityHint}</p>;
    return <p className="text-sm">No pushed briefs yet.</p>;
  }
  return (
    <div className="grid grid-cols-[minmax(220px,1fr)_2fr] gap-4">
      <BriefList briefs={props.list.briefs} selectedId={props.selectedId} onSelect={props.onSelect} nowMs={Date.now()} />
      {props.selectedId !== null && (
        <BriefDetail key={props.selectedId} incidentId={props.selectedId} onPruned={props.onPruned} />
      )}
    </div>
  );
}
```

`Body` takes the two hint strings as props only to keep `Oncall` short. If Biome or Sonar flags it, inline the constants instead; behaviour is identical.

- [ ] **Step 8: Add the route.** In `App.tsx`, add `import { Oncall } from "./pages/Oncall";` and `<Route path="oncall" element={<Oncall />} />` after `<Route index element={<Dashboard />} />`.
- [ ] **Step 9: Run them and confirm they pass.** `cd packages/ui && bunx vitest run` (the whole UI suite), then `bun run typecheck && bun run typecheck:tests && bun run lint` from the worktree root.
- [ ] **Step 10: Red-prove.**
  - (a) Render `{b.briefMarkdown}` through `dangerouslySetInnerHTML`: case 4 fails.
  - (b) Drop the `selectedId === null &&` guard: Review Focus 1 fails.
  - (c) Remove `key={props.selectedId}` and `got.brief.incidentId !== incidentId`: case 12 or 10 fails.
  - (d) Make `formatAge` return negative minutes: the clock-skew test fails.
  - Restore each.
- [ ] **Step 11: Commit** (`feat(ui): On-call page for pushed briefs`).

---

### Task 10: Documentation

**Files:**
- Modify: `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`, `docs/roadmap.md`, `CLAUDE.md`, `GEMINI.md`

- [ ] **Step 1: Find every restatement.**

```bash
grep -rn "desktop panel (PR 3)\|PR 1 and 2 of 3\|PR 3)\|Not shipped:.*desktop" CLAUDE.md GEMINI.md docs --include=*.md | grep -v "docs/superpowers/"
```

- [ ] **Step 2: Edit.**
  - `architecture.md`, oncall-push section: add a desktop-panel paragraph covering:
    - the `/oncall` page and sidebar dot;
    - the provider with its single subscription and 60 s backstop;
    - verbatim preformatted markdown, which is safe because it is a text child;
    - the delivery strip;
    - no retry button.
    Drop the desktop panel from its Not-shipped list.
  - `cli-reference.md`, `nimbus oncall pushed`: one sentence that the desktop app's On-call page shows the same briefs, and that `list` prints `[service]` when known.
  - `CHANGELOG.md`: a new top entry under "Post-Phase-6 deliveries", `2026-10-04 — The on-call pushed brief, PR 3 of 3 (desktop panel)`, in PR 1/2's style. Mention:
    - `ALLOWED_METHODS` 105 → 107, and `pushedRetry` staying CLI-only;
    - `service` on `pushedList`, including the guarded JOIN;
    - the contract fixture;
    - no new invariant, egress class, IPC method or migration.
    Do not edit historical entries.
  - `roadmap.md` "Pushed incident brief" row: PR 3 of 3 shipped. Remove "the desktop panel (PR 3)" from Not shipped.
  - `CLAUDE.md` / `GEMINI.md` Status: one short sentence that PR 3 shipped the desktop panel, keeping the edited spans byte-identical. Verify with `diff <(grep -n "oncall" CLAUDE.md) <(grep -n "oncall" GEMINI.md)`.
- [ ] **Step 3: Verify.** `bun run audit:doc-refs && bun run audit:status-drift && bun run lint:markdown`, then re-run the Step 1 grep.
- [ ] **Step 4: Commit** (`docs(oncall): document the desktop panel`).

---

### Task 11: Whole-branch verification and PR

- [ ] **Step 1: Gates.**
  - Run from the worktree root:
    - `bun run preflight:fast`
    - `bun test packages/gateway/src/oncall-push packages/gateway/src/ipc packages/gateway/src/security-invariants.test.ts packages/cli/src/commands/oncall-pushed.test.ts`
  - Run from `packages/ui`: `bunx vitest run --coverage`. The UI package floor is 80% lines and 75% branches, and CI enforces the same thresholds.
  - Run `bun run verify:docker -- --changed` if Docker is up. If it isn't, say so; CI's Ubuntu leg is then the first Linux run.
- [ ] **Step 2: Final whole-branch review** (dispatched by the controller).
- [ ] **Step 3: Strip the planning docs.**
  - Remove `docs/superpowers/specs/2026-10-04-oncall-push-desktop-design.md`, `…-design-review.md`, `docs/superpowers/plans/2026-10-04-oncall-push-desktop.md` and any plan review.
  - Commit, then re-run `bun run preflight:fast`.
- [ ] **Step 4: Merge `origin/main` if it has moved** (CHANGELOG / CLAUDE / GEMINI conflicts: keep both sides), re-run the gates, then push.
- [ ] **Step 5: Open the PR.**
  - Title: `feat(ui): On-call page for pushed briefs (PR 3 of 3)`. No `!`.
  - The body becomes the squash commit. Keep parentheses balanced and end it with the attribution line.
  - Do NOT merge.
