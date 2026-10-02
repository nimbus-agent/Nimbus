# On-call Pushed Brief — PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a PagerDuty sync shows a new P1 assigned to the local owner, the gateway runs `agents.oncall` for it unattended (deterministic, no model), stores the brief once per incident, and pushes it to an OS toast and a `gateway.event`. `nimbus demo` drives the same code path through a simulated page.

**Architecture:** A new `packages/gateway/src/oncall-push/` subsystem hangs off the post-sync hook in `platform/assemble.ts`. A pure selector picks candidates through `oncall-queries.ts`'s `selectActiveAssignedIncidents`. A single-flight runner dispatches `agents.oncall` through `dispatchAgentsRpc` (the `fleet-invoker.ts` seam) under a new derived `ClientKind` `"push"` with no synthesis runner, waits for the async `oncall.briefReady`, stores the result in a V64 `pushed_brief` table, and hands it to the sinks. A CLI-only, LAN-forbidden `oncall.*` IPC namespace reads the briefs back.

**Tech Stack:** Bun 1.3, TypeScript strict, `bun:sqlite`, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-10-02-oncall-pushed-brief-design.md`. Read it before starting any task.

**Scope:** PR 1 only (spec § 6). PR 2 (ChatOps sink) and PR 3 (desktop panel) get their own plans after this merges. **Do not** add the `push_full_brief` policy field, a ChatOps post kind, or any `ALLOWED_METHODS` entry here.

## Global Constraints

- Branch `dev/asaf/oncall-pushed-brief`, worktree `C:\gitrep\Nimbus\.claude\worktrees\oncall-pushed-brief`. Run `git rev-parse --abbrev-ref HEAD` before **every** commit.
- No `any`; use `unknown` for external data. TypeScript strict.
- SQLite writes only via `dbRun`/`dbExec`/`dbStmtRun` (`packages/gateway/src/db/write.ts`; I14/D12). Bound parameters only (I9).
- `[oncall.push] enabled` defaults to **`false`**.
- A push run never constructs or passes a synthesis `runner`. The brief is the deterministic render.
- `PUSH_BRIEF_TIMEOUT_MS = 30_000`, `ENABLE_GRACE_MS = 5 * 60_000`, `PUSH_NOTIFY_CAP = 3`, default `retention_days = 90`.
- The `gateway.event` payload for `oncall.briefPushed` carries `{ incidentId, status }` only, never brief text.
- Paths are built with `path.join` / `os.tmpdir()`; never hard-code separators.
- Commit messages are written to a file and passed with `git commit -F <file>` (backticks in `-m` are eaten by the shell). End every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test data lives only in `os.tmpdir()` temp dirs or `:memory:` databases. **Never** touch the real Nimbus data or config dir.
- Close every `Database` before asserting on cleanup; an EBUSY error during cleanup replaces the real failure.
- After each task: `bun run typecheck` and `bunx biome check <touched files>`. Before the PR: `bun run preflight:fast`.

## Review Focus

These inputs are implied by the spec but are easy to leave untested. Each one has a test in the owning task.

1. **The first sync after enabling contains a P1 opened seconds earlier.** The owner expects a brief. Pinned in Task 2 (the boot reconcile writes `enabled_at` before any sync) and Task 4 (the grace window).
2. **An incident whose severity matches only case-insensitively (`"P1"` vs alias `p1`).** It must be selected. Pinned in Task 4.
3. **`agents.oncall` refuses synchronously** (it throws `AgentsRpcError(-32000)` before its detached promise starts), as opposed to emitting `briefError`. Both must land as a `failed` row, never an unhandled rejection. Pinned in Task 5.
4. **Two syncs complete back-to-back while a run is active.** The second incident must be briefed by the trailing run, not wait for the next poll. Pinned in Task 5.
5. **The weekly released-install smoke runs `main`'s judge against the previous release's tour.** The judge must accept the old and new first-step command. Pinned in Task 10.

---

## File Structure

**Create (gateway):**
- `packages/gateway/src/config/oncall-push-toml.ts`: parses `[oncall.push]`.
- `packages/gateway/src/index/oncall-push-v64-sql.ts`: V64 DDL.
- `packages/gateway/src/oncall-push/push-store.ts`: the only file naming `pushed_brief` / `oncall_push_state`.
- `packages/gateway/src/oncall-push/push-selector.ts`: a pure candidate query.
- `packages/gateway/src/oncall-push/push-runner.ts`: dispatch, wait, store, deliver; single-flight; retry.
- `packages/gateway/src/oncall-push/push-sinks.ts`: toast + gateway event, with the cap.
- `packages/gateway/src/oncall-push/push-runtime.ts`: wires config, store, selector, runner and sinks for `assemble.ts`.
- `packages/gateway/src/ipc/oncall-push-rpc.ts`: `oncall.pushedList` / `pushedGet` / `pushedRetry`.
- Tests next to each file, plus `packages/gateway/test/e2e/oncall-push-routing.e2e.test.ts`.

**Create (CLI):**
- `packages/cli/src/commands/oncall-pushed.ts`: `nimbus oncall pushed …`.

**Modify:** `ipc/server/client-kind.ts`, `egress/egress-bearing-kinds.ts`, `ipc/agents-rpc.ts` (one map entry), `scripts/structure-audit/check-nimbus-invariants.ts` (+ test), `security-invariants.test.ts`, `index/migrations/runner.ts`, `index/local-index.ts`, `index/migrations/runner.test.ts`, `ipc/gateway-events.ts`, `ipc/lan-rpc.ts` (+ test), `ipc/server/options.ts`, `ipc/server/dispatchers.ts`, `ipc/demo-rpc.ts`, `platform/assemble.ts`, `demo/seed.ts`, `demo/corpus/acme.ts`, `packages/cli/src/commands/{oncall,tail,doctor-core,demo}.ts`, `scripts/release/assert-demo-tour.ts` (+ test), `packages/gateway/test/e2e/demo-tour.e2e.test.ts`, and docs.

---

### Task 1: `[oncall.push]` config parser

**Files:**
- Create: `packages/gateway/src/config/oncall-push-toml.ts`
- Test: `packages/gateway/src/config/oncall-push-toml.test.ts`

**Interfaces:**
- Consumes: `isTableHeader`, `parseBool`, `parseIntDec`, `parseString`, `parseStringArray`, `splitKeyValue`, `stripComment` from `./toml-primitives.ts`.
- Produces:
  ```ts
  export type NimbusOncallPushToml = {
    readonly enabled: boolean;
    readonly severities: readonly string[]; // lowercased, deduped; [] = use {"p1"} ∪ aliases
    readonly chatopsNamespace: string;      // parsed now, consumed in PR 2
    readonly retentionDays: number;
  };
  export const DEFAULT_ONCALL_PUSH_CONFIG: NimbusOncallPushToml;
  export function parseNimbusTomlOncallPush(source: string): NimbusOncallPushToml;
  export function loadNimbusOncallPushFromPath(tomlPath: string): NimbusOncallPushToml;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ONCALL_PUSH_CONFIG,
  loadNimbusOncallPushFromPath,
  parseNimbusTomlOncallPush,
} from "./oncall-push-toml.ts";

describe("[oncall.push] config", () => {
  test("absent section → defaults, disabled", () => {
    expect(parseNimbusTomlOncallPush("[fleet]\nenabled = true\n")).toEqual(DEFAULT_ONCALL_PUSH_CONFIG);
    expect(DEFAULT_ONCALL_PUSH_CONFIG.enabled).toBe(false);
    expect(DEFAULT_ONCALL_PUSH_CONFIG.retentionDays).toBe(90);
  });

  test("parses every key; severities lowercased and deduped", () => {
    const c = parseNimbusTomlOncallPush(
      [
        "[oncall.push]",
        "enabled = true",
        'severities = ["P1", "sev-1", "p1"]',
        'chatops_namespace = "payments"',
        "retention_days = 30",
      ].join("\n"),
    );
    expect(c).toEqual({
      enabled: true,
      severities: ["p1", "sev-1"],
      chatopsNamespace: "payments",
      retentionDays: 30,
    });
  });

  test("only the exact header counts — [oncall] and [oncall.push.x] are ignored", () => {
    expect(parseNimbusTomlOncallPush("[oncall]\nenabled = true\n").enabled).toBe(false);
    expect(parseNimbusTomlOncallPush("[oncall.push.x]\nenabled = true\n").enabled).toBe(false);
  });

  test("retention_days below 1 is ignored, not clamped", () => {
    expect(parseNimbusTomlOncallPush("[oncall.push]\nretention_days = 0\n").retentionDays).toBe(90);
  });

  test("load from a missing path → defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "oncall-push-toml-"));
    try {
      expect(loadNimbusOncallPushFromPath(join(dir, "nope.toml"))).toEqual(DEFAULT_ONCALL_PUSH_CONFIG);
      const p = join(dir, "nimbus.toml");
      writeFileSync(p, "[oncall.push]\nenabled = true\n");
      expect(loadNimbusOncallPushFromPath(p).enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/config/oncall-push-toml.test.ts`
Expected: FAIL, `Cannot find module './oncall-push-toml.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * `[oncall.push]` — the on-call pushed brief (spec 2026-10-02-oncall-pushed-brief-design.md § 2.8).
 * DEFAULT OFF. `chatops_namespace` is parsed here so PR 1's config surface is complete, but it has
 * no consumer until the ChatOps sink lands (PR 2).
 */
import { existsSync, readFileSync } from "node:fs";
import {
  isTableHeader,
  parseBool,
  parseIntDec,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

export type NimbusOncallPushToml = {
  readonly enabled: boolean;
  readonly severities: readonly string[];
  readonly chatopsNamespace: string;
  readonly retentionDays: number;
};

export const DEFAULT_ONCALL_PUSH_CONFIG: NimbusOncallPushToml = Object.freeze({
  enabled: false,
  severities: Object.freeze([]) as readonly string[],
  chatopsNamespace: "",
  retentionDays: 90,
});

function lowerDeduped(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const lower = v.trim().toLowerCase();
    if (lower === "" || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

export function parseNimbusTomlOncallPush(source: string): NimbusOncallPushToml {
  let enabled = DEFAULT_ONCALL_PUSH_CONFIG.enabled;
  let severities: readonly string[] = DEFAULT_ONCALL_PUSH_CONFIG.severities;
  let chatopsNamespace = DEFAULT_ONCALL_PUSH_CONFIG.chatopsNamespace;
  let retentionDays = DEFAULT_ONCALL_PUSH_CONFIG.retentionDays;
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[oncall.push]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    switch (kv.key) {
      case "enabled": {
        const b = parseBool(kv.valRaw);
        if (b !== undefined) enabled = b;
        break;
      }
      case "severities":
        severities = lowerDeduped(parseStringArray(kv.valRaw));
        break;
      case "chatops_namespace":
        chatopsNamespace = parseString(kv.valRaw).trim();
        break;
      case "retention_days": {
        const n = parseIntDec(kv.valRaw);
        if (n !== undefined && n >= 1) retentionDays = n;
        break;
      }
      default:
        break;
    }
  }
  return { enabled, severities, chatopsNamespace, retentionDays };
}

export function loadNimbusOncallPushFromPath(tomlPath: string): NimbusOncallPushToml {
  if (!existsSync(tomlPath)) return DEFAULT_ONCALL_PUSH_CONFIG;
  return parseNimbusTomlOncallPush(readFileSync(tomlPath, "utf8"));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/config/oncall-push-toml.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print dev/asaf/oncall-pushed-brief
git add packages/gateway/src/config/oncall-push-toml.ts packages/gateway/src/config/oncall-push-toml.test.ts
git commit -F <msgfile>   # "feat(oncall-push): parse the [oncall.push] config section"
```

---

### Task 2: Schema V64 and the push store (including the boot reconcile)

**Files:**
- Create: `packages/gateway/src/index/oncall-push-v64-sql.ts`
- Create: `packages/gateway/src/oncall-push/push-store.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import near `:33`; step after the V63 `simpleStep` at `:573-578`)
- Modify: `packages/gateway/src/index/local-index.ts:284` (`CURRENT_SCHEMA_VERSION = 63` → `64`)
- Modify: `packages/gateway/src/index/migrations/runner.test.ts:785-788` (63 → 64 in the test name and the expectation)
- Test: `packages/gateway/src/oncall-push/push-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PushedBriefStatus = "ok" | "failed";
  export type SinkOutcomeKind = "delivered" | "skipped" | "coalesced" | "failed";
  export type SinkOutcome = { readonly outcome: SinkOutcomeKind; readonly reason?: string; readonly at: number };
  export type PushedBriefRow = {
    readonly incidentId: string;
    readonly sessionId: string | null;
    readonly status: PushedBriefStatus;
    readonly failureCode: string | null;
    readonly briefMarkdown: string | null;
    readonly briefJson: string | null;
    readonly createdAt: number;
    readonly retriedAt: number | null;
    readonly delivery: Readonly<Record<string, SinkOutcome>>;
  };
  export type BriefOutcome =
    | { readonly status: "ok"; readonly sessionId: string; readonly briefMarkdown: string; readonly briefJson: string }
    | { readonly status: "failed"; readonly sessionId: string | null; readonly failureCode: string };
  export class PushStore {
    constructor(db: Database);
    has(incidentId: string): boolean;
    insert(incidentId: string, outcome: BriefOutcome, nowMs: number): PushedBriefRow;
    applyRetry(incidentId: string, outcome: BriefOutcome, nowMs: number): PushedBriefRow;
    recordDelivery(incidentId: string, sink: string, outcome: SinkOutcome): void;
    get(incidentId: string): PushedBriefRow | null;
    newest(): PushedBriefRow | null;
    list(limit: number): PushedBriefRow[];
    pruneOlderThan(cutoffMs: number): number;
    enabledAt(): number | null;
    reconcileEnabledState(enabled: boolean, nowMs: number): void;
    /** Display-only read of the incident's indexed title (Task 8's summaries). */
    incidentTitle(incidentId: string): string | null;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { PushStore } from "./push-store.ts";

let db: Database;
let store: PushStore;
beforeEach(() => {
  db = createMemoryIndexDb(); // migrates to CURRENT_SCHEMA_VERSION, so V64 must exist
  store = new PushStore(db);
});
afterEach(() => db.close());

const OK = { status: "ok", sessionId: "s1", briefMarkdown: "# brief", briefJson: "{}" } as const;
const FAILED = { status: "failed", sessionId: null, failureCode: "timeout: no brief in 30000ms" } as const;

describe("PushStore", () => {
  test("schema is V64", () => {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(64);
  });

  test("insert ok, then has/get/newest", () => {
    expect(store.has("pagerduty:P1")).toBe(false);
    const row = store.insert("pagerduty:P1", OK, 1000);
    expect(row).toMatchObject({ incidentId: "pagerduty:P1", status: "ok", briefMarkdown: "# brief", createdAt: 1000, retriedAt: null, delivery: {} });
    expect(store.has("pagerduty:P1")).toBe(true);
    expect(store.newest()?.incidentId).toBe("pagerduty:P1");
  });

  test("insert twice for one incident throws — the table IS the dedup", () => {
    store.insert("pagerduty:P1", OK, 1000);
    expect(() => store.insert("pagerduty:P1", OK, 2000)).toThrow();
  });

  test("failed row keeps the code and no brief", () => {
    expect(store.insert("pagerduty:P2", FAILED, 1000)).toMatchObject({ status: "failed", failureCode: FAILED.failureCode, briefMarkdown: null });
  });

  test("applyRetry keeps created_at and sets retried_at", () => {
    store.insert("pagerduty:P2", FAILED, 1000);
    const row = store.applyRetry("pagerduty:P2", OK, 5000);
    expect(row).toMatchObject({ status: "ok", createdAt: 1000, retriedAt: 5000, failureCode: null, briefMarkdown: "# brief" });
  });

  test("a FAILED retry records the new session id and code, stays failed", () => {
    store.insert("pagerduty:P3", FAILED, 1000);
    const row = store.applyRetry("pagerduty:P3", { status: "failed", sessionId: "s-retry", failureCode: "brief_error: boom" }, 6000);
    expect(row).toMatchObject({ status: "failed", sessionId: "s-retry", failureCode: "brief_error: boom", createdAt: 1000, retriedAt: 6000 });
  });

  test("recordDelivery merges per sink", () => {
    store.insert("pagerduty:P1", OK, 1000);
    store.recordDelivery("pagerduty:P1", "toast", { outcome: "delivered", at: 1 });
    store.recordDelivery("pagerduty:P1", "event", { outcome: "failed", reason: "x", at: 2 });
    expect(store.get("pagerduty:P1")?.delivery).toEqual({
      toast: { outcome: "delivered", at: 1 },
      event: { outcome: "failed", reason: "x", at: 2 },
    });
  });

  test("incidentTitle reads the indexed incident title, null when absent", () => {
    // The real writer (the same call shape demo/seed.ts's writeItems uses), never a raw INSERT.
    upsertIndexedItem(db, {
      service: "pagerduty", type: "incident", externalId: "T1", title: "checkout: 5xx", body: "",
      modifiedAt: 1, syncedAt: 1, authorId: null, url: null, metadata: {},
    });
    expect(store.incidentTitle("pagerduty:T1")).toBe("checkout: 5xx");
    expect(store.incidentTitle("pagerduty:NOPE")).toBeNull();
  });

  test("list is newest first, bounded; prune drops old rows", () => {
    store.insert("a", OK, 1000);
    store.insert("b", OK, 3000);
    store.insert("c", OK, 2000);
    expect(store.list(2).map((r) => r.incidentId)).toEqual(["b", "c"]);
    expect(store.pruneOlderThan(2500)).toBe(2);
    expect(store.list(10).map((r) => r.incidentId)).toEqual(["b"]);
  });

  describe("reconcileEnabledState (spec § 4.1)", () => {
    test("enabled + no row → stamps now", () => {
      store.reconcileEnabledState(true, 7000);
      expect(store.enabledAt()).toBe(7000);
    });
    test("enabled + existing row → keeps the original", () => {
      store.reconcileEnabledState(true, 7000);
      store.reconcileEnabledState(true, 9000);
      expect(store.enabledAt()).toBe(7000);
    });
    test("disabled → clears, so the next enable never backfills the gap", () => {
      store.reconcileEnabledState(true, 7000);
      store.reconcileEnabledState(false, 8000);
      expect(store.enabledAt()).toBeNull();
      store.reconcileEnabledState(true, 9000);
      expect(store.enabledAt()).toBe(9000);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/oncall-push/push-store.test.ts`
Expected: FAIL, missing module `./push-store.ts`.

- [ ] **Step 3: Write the V64 SQL and register it**

`packages/gateway/src/index/oncall-push-v64-sql.ts`:

```ts
/**
 * V64 — on-call pushed briefs (spec 2026-10-02-oncall-pushed-brief-design.md § 2.4).
 * `pushed_brief.incident_id` is the PRIMARY KEY on purpose: one brief per incident, so the table
 * itself is the dedup and no time cursor exists to drift. `oncall_push_state` is a singleton
 * holding the boot-reconciled `enabled_at` (§ 4.1). Only `oncall-push/push-store.ts` names either.
 */
export const ONCALL_PUSH_V64_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS pushed_brief (
     incident_id    TEXT PRIMARY KEY,
     session_id     TEXT,
     status         TEXT NOT NULL CHECK (status IN ('ok','failed')),
     failure_code   TEXT,
     brief_markdown TEXT,
     brief_json     TEXT,
     created_at     INTEGER NOT NULL,
     delivery_json  TEXT NOT NULL DEFAULT '{}',
     retried_at     INTEGER
   ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS idx_pushed_brief_created_at ON pushed_brief (created_at)",
  `CREATE TABLE IF NOT EXISTS oncall_push_state (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     enabled_at INTEGER NOT NULL
   )`,
];
```

In `runner.ts`, add `import { ONCALL_PUSH_V64_SQL } from "../oncall-push-v64-sql.ts";` beside the V63 import, and append after the V63 step:

```ts
  simpleStep(63, 64, "on-call pushed briefs (pushed_brief + oncall_push_state)", ONCALL_PUSH_V64_SQL),
```

Set `CURRENT_SCHEMA_VERSION = 64` in `local-index.ts`. In `runner.test.ts:785-788`, rename the test to `"CURRENT_SCHEMA_VERSION is 64, so the newest step runs in production"` and change the expectation to `toBe(64)`.

- [ ] **Step 4: Write `push-store.ts`**

```ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export type PushedBriefStatus = "ok" | "failed";
export type SinkOutcomeKind = "delivered" | "skipped" | "coalesced" | "failed";
export type SinkOutcome = {
  readonly outcome: SinkOutcomeKind;
  readonly reason?: string;
  readonly at: number;
};
export type PushedBriefRow = {
  readonly incidentId: string;
  readonly sessionId: string | null;
  readonly status: PushedBriefStatus;
  readonly failureCode: string | null;
  readonly briefMarkdown: string | null;
  readonly briefJson: string | null;
  readonly createdAt: number;
  readonly retriedAt: number | null;
  readonly delivery: Readonly<Record<string, SinkOutcome>>;
};
export type BriefOutcome =
  | {
      readonly status: "ok";
      readonly sessionId: string;
      readonly briefMarkdown: string;
      readonly briefJson: string;
    }
  | { readonly status: "failed"; readonly sessionId: string | null; readonly failureCode: string };

type Raw = {
  incident_id: string;
  session_id: string | null;
  status: string;
  failure_code: string | null;
  brief_markdown: string | null;
  brief_json: string | null;
  created_at: number;
  delivery_json: string;
  retried_at: number | null;
};

const COLS =
  "incident_id, session_id, status, failure_code, brief_markdown, brief_json, created_at, delivery_json, retried_at";

function parseDelivery(json: string): Record<string, SinkOutcome> {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, SinkOutcome>)
      : {};
  } catch {
    return {};
  }
}

function toRow(r: Raw): PushedBriefRow {
  return {
    incidentId: r.incident_id,
    sessionId: r.session_id,
    status: r.status === "ok" ? "ok" : "failed",
    failureCode: r.failure_code,
    briefMarkdown: r.brief_markdown,
    briefJson: r.brief_json,
    createdAt: r.created_at,
    retriedAt: r.retried_at,
    delivery: parseDelivery(r.delivery_json),
  };
}

function outcomeColumns(o: BriefOutcome): [string | null, string, string | null, string | null, string | null] {
  return o.status === "ok"
    ? [o.sessionId, "ok", null, o.briefMarkdown, o.briefJson]
    : [o.sessionId, "failed", o.failureCode, null, null];
}

/** The ONLY reader/writer of `pushed_brief` and `oncall_push_state` (spec § 2.4). */
export class PushStore {
  constructor(private readonly db: Database) {}

  has(incidentId: string): boolean {
    return this.db.query("SELECT 1 FROM pushed_brief WHERE incident_id = ?").get(incidentId) !== null;
  }

  insert(incidentId: string, outcome: BriefOutcome, nowMs: number): PushedBriefRow {
    dbRun(
      this.db,
      `INSERT INTO pushed_brief (incident_id, session_id, status, failure_code, brief_markdown, brief_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [incidentId, ...outcomeColumns(outcome), nowMs],
    );
    return this.mustGet(incidentId);
  }

  applyRetry(incidentId: string, outcome: BriefOutcome, nowMs: number): PushedBriefRow {
    const [sessionId, status, failureCode, md, json] = outcomeColumns(outcome);
    if (status === "ok") {
      dbRun(
        this.db,
        `UPDATE pushed_brief SET session_id = ?, status = 'ok', failure_code = NULL,
           brief_markdown = ?, brief_json = ?, retried_at = ? WHERE incident_id = ?`,
        [sessionId, md, json, nowMs, incidentId],
      );
    } else {
      // A failed retry may still have opened a session before timing out; record the LATEST one so
      // the row points at the attempt that actually ran. Status is restated, not assumed.
      dbRun(
        this.db,
        "UPDATE pushed_brief SET session_id = ?, status = 'failed', failure_code = ?, retried_at = ? WHERE incident_id = ?",
        [sessionId, failureCode, nowMs, incidentId],
      );
    }
    return this.mustGet(incidentId);
  }

  recordDelivery(incidentId: string, sink: string, outcome: SinkOutcome): void {
    const row = this.get(incidentId);
    if (row === null) return;
    const next = { ...row.delivery, [sink]: outcome };
    dbRun(this.db, "UPDATE pushed_brief SET delivery_json = ? WHERE incident_id = ?", [
      JSON.stringify(next),
      incidentId,
    ]);
  }

  get(incidentId: string): PushedBriefRow | null {
    const r = this.db.query(`SELECT ${COLS} FROM pushed_brief WHERE incident_id = ?`).get(incidentId) as Raw | null;
    return r === null ? null : toRow(r);
  }

  newest(): PushedBriefRow | null {
    return this.list(1)[0] ?? null;
  }

  list(limit: number): PushedBriefRow[] {
    const rows = this.db
      .query(`SELECT ${COLS} FROM pushed_brief ORDER BY created_at DESC, incident_id ASC LIMIT ?`)
      .all(limit) as Raw[];
    return rows.map(toRow);
  }

  pruneOlderThan(cutoffMs: number): number {
    return dbRun(this.db, "DELETE FROM pushed_brief WHERE created_at < ?", [cutoffMs]).changes;
  }

  enabledAt(): number | null {
    const r = this.db.query("SELECT enabled_at FROM oncall_push_state WHERE id = 1").get() as
      | { enabled_at: number }
      | null;
    return r === null ? null : r.enabled_at;
  }

  /** Spec § 4.1: run once at boot. Enabled + no row → stamp; disabled → clear. */
  reconcileEnabledState(enabled: boolean, nowMs: number): void {
    if (!enabled) {
      dbRun(this.db, "DELETE FROM oncall_push_state WHERE id = 1", []);
      return;
    }
    dbRun(this.db, "INSERT OR IGNORE INTO oncall_push_state (id, enabled_at) VALUES (1, ?)", [nowMs]);
  }

  incidentTitle(incidentId: string): string | null {
    const r = this.db
      .query("SELECT title FROM item WHERE id = ? AND type = 'incident'")
      .get(incidentId) as { title: string } | null;
    return r === null ? null : r.title;
  }

  private mustGet(incidentId: string): PushedBriefRow {
    const row = this.get(incidentId);
    if (row === null) throw new Error(`pushed_brief row vanished: ${incidentId}`);
    return row;
  }
}
```

- [ ] **Step 5: Run the store and migration tests**

Run: `bun test packages/gateway/src/oncall-push/push-store.test.ts packages/gateway/src/index/migrations/runner.test.ts`
Expected: PASS. If another test pins the schema version (`grep -rn "toBe(63)" packages/gateway/src packages/gateway/test`), update it to 64 in this task.

- [ ] **Step 6: Commit** with `"feat(oncall-push): schema V64 pushed_brief + oncall_push_state and the push store"`.

---

### Task 3: Derived `ClientKind` `"push"` and the D28 extension

**Files:**
- Modify: `packages/gateway/src/ipc/server/client-kind.ts:13`
- Modify: `packages/gateway/src/egress/egress-bearing-kinds.ts:26-37`
- Modify: `packages/gateway/src/ipc/agents-rpc.ts:647-655`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (beside D28 at `:990-1034`, its anchor list at `~:2359`, and its CI message at `~:2581`)
- Test: `scripts/structure-audit/check-nimbus-invariants.test.ts` (beside the D28 describe at `:2206`), `packages/gateway/src/security-invariants.test.ts` (inside the I38 describe, or a new sibling describe)

**Interfaces:**
- Produces: `ClientKind` includes `"push"`; `EGRESS_BEARING_CLIENT_KINDS.push === null`; `OWNER_SCOPED_ONCALL_ALLOWED.push === false`; `checkPushClientKindConfinement(files)` returns violations with `rule: "D28-push-client-kind"`. The **only** file allowed to assign `kind: "push"` in production is `packages/gateway/src/oncall-push/push-runner.ts` (Task 5).

- [ ] **Step 1: Write the failing tests**

In `check-nimbus-invariants.test.ts`, after the D28 fleet describe:

```ts
describe("D28 — push ClientKind confinement (oncall push)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const ROGUE = "packages/gateway/src/agents/rogue.ts";
  const RUNNER = "packages/gateway/src/oncall-push/push-runner.ts";
  const EGRESS = "packages/gateway/src/egress/egress-bearing-kinds.ts";
  const flagged = (files: FileEntry[]): boolean =>
    checkPushClientKindConfinement(files).some((v) => v.rule === "D28-push-client-kind");

  test("flags an object-literal kind outside the runner", () => {
    expect(flagged([file(ROGUE, `const caller = { clientId: id, kind: "push" };`)])).toBe(true);
  });
  test("allows it in the runner", () => {
    expect(flagged([file(RUNNER, `caller: { clientId: "oncall-push", kind: "push" },`)])).toBe(false);
  });
  test("the unquoted `push: null` egress entry is allow-listed in EGRESS, flagged elsewhere", () => {
    const entry = `  fleet: null,\n  push: null,\n});`;
    expect(flagged([file(EGRESS, entry)])).toBe(false);
    expect(flagged([file(ROGUE, entry)])).toBe(true);
  });
  test("does not flag the owner-scoped map entry `push: false` or array push()", () => {
    expect(flagged([file("packages/gateway/src/ipc/agents-rpc.ts", "  push: false,")])).toBe(false);
    expect(flagged([file(ROGUE, "out.push(row);")])).toBe(false);
  });
  test("ignores test files", () => {
    expect(flagged([file("packages/gateway/src/x.test.ts", `kind: "push"`)])).toBe(false);
  });
});
```

Add `checkPushClientKindConfinement` to that file's import from `./check-nimbus-invariants.ts`.

In `security-invariants.test.ts`, next to the fleet-kind tests at `:4060-4074`:

```ts
  test("a pushed brief appends no egress row — the push kind is non-bearing", () => {
    expect(egressSourceTypeForClientKind("push")).toBeNull();
    expect(egressSourceTypeForClientKind("mcp")).toBe("mcp"); // not vacuous
  });

  test("push is NOT declarable by a socket client — attribution stays a fact", () => {
    expect(new ClientKindStore().declare("c1", "push")).toBe("unknown");
    expect(new ClientKindStore().declare("c2", "mcp")).toBe("mcp"); // not vacuous
  });

  test("a push caller can never take oncall's owner-scoped (parameterless) shape", async () => {
    const db = createMemoryIndexDb();
    try {
      await expect(
        dispatchAgentsRpc("agents.oncall", {}, { db, notify: () => {}, caller: { clientId: "x", kind: "push" } }),
      ).rejects.toThrow(/requires incidentId or service/);
    } finally {
      db.close();
    }
  });
```

Import `dispatchAgentsRpc` from `./ipc/agents-rpc.ts` and `createMemoryIndexDb` from `./connectors/connector-sync-test-helpers.ts` if they aren't imported already.

In `packages/gateway/src/ipc/agents-rpc.test.ts`, the `describe("agents.oncall — the external shape bound")` block at `:1480` runs both `test.each` cases (zero-param REFUSED, explicit `--service` SERVED) over a hand-listed `EXTERNAL` array. `push` must get the same two assertions. It is **not** an external caller, though, so don't add it to `EXTERNAL`: that would mislabel it for any future test reusing the list. Add beside the two constants:

```ts
  // Kinds refused the owner-scoped shape. `push` is LOCAL (the gateway's own post-sync hook) but
  // always names its incident, so it is refused the shape that would let it lose one.
  const OWNER_SCOPED_REFUSED: readonly ClientKind[] = [...EXTERNAL, "push"];
```

and switch both `test.each(EXTERNAL.map(...))` calls to `test.each(OWNER_SCOPED_REFUSED.map(...))`. **Make the list impossible to leave incomplete:** add one test asserting that `[...OWNER_SCOPED_REFUSED, ...LOCAL]`, sorted, equals every `ClientKind`. Do that with a local exhaustive `const ALL: Record<ClientKind, true> = { cli: true, ui: true, unknown: true, fleet: true, push: true, mcp: true, http: true, chatops: true }` and `Object.keys(ALL)`, so a ninth kind is a compile error here rather than a silently untested one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts packages/gateway/src/security-invariants.test.ts`
Expected: FAIL. `checkPushClientKindConfinement` doesn't exist, and `"push"` isn't a `ClientKind` (a typecheck error surfaces as test failures).

- [ ] **Step 3: Implement the kind and the maps**

`client-kind.ts:13`:
```ts
export type ClientKind = "cli" | "mcp" | "ui" | "http" | "chatops" | "fleet" | "push" | "unknown";
```
Extend the doc comment above `RECOGNISED` with one sentence: `push` is likewise DERIVED (set only by `oncall-push/push-runner.ts`) and absent from `RECOGNISED`. **Do not** add it to `RECOGNISED`.

`egress-bearing-kinds.ts`, after `fleet: null,`:
```ts
  // A pushed brief is written to local SQLite and shown in a local toast; nothing crosses the
  // machine boundary on this path (the PR 2 ChatOps post is ledgered by the `chatops` class).
  push: null,
```

`agents-rpc.ts`, in `OWNER_SCOPED_ONCALL_ALLOWED`, after `fleet: true,`:
```ts
  // false, not true: the push runner ALWAYS names `incidentId`, so this entry is never consulted on
  // the happy path — it exists so a push call that ever lost its incidentId is REFUSED rather than
  // quietly briefing whatever the owner-scoped resolution picks.
  push: false,
```

- [ ] **Step 4: Implement the D28 push rule**

In `check-nimbus-invariants.ts`, directly after `checkFleetClientKindConfinement`:

```ts
const D28_PUSH_KIND_ALLOWED = [
  "packages/gateway/src/ipc/server/client-kind.ts",
  "packages/gateway/src/egress/egress-bearing-kinds.ts",
  "packages/gateway/src/oncall-push/push-runner.ts",
];
/**
 * Same shapes as D28_FLEET_KIND_RE with "push" substituted. The bare unquoted key matches only a
 * `null` VALUE, so `OWNER_SCOPED_ONCALL_ALLOWED`'s `push: false` and every `arr.push(x)` stay clear.
 */
const D28_PUSH_KIND_RE =
  /\w*[Kk]ind\s*[:=]\s*"push"|:\s*ClientKind\s*=\s*"push"|"push"\s+as\s+ClientKind|\bdeclare\s*\([^)]*,\s*"push"|"push"\s*:\s*(?:null|")|\bpush\s*:\s*null\b/;

export function checkPushClientKindConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (D28_PUSH_KIND_ALLOWED.includes(f.relPath)) continue;
    const stripped = stripComments(f.contents).split("\n");
    const original = f.contents.split("\n");
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i] ?? "";
      const next = stripped[i + 1] ?? "";
      let matched = D28_PUSH_KIND_RE.test(line);
      if (!matched && !D28_PUSH_KIND_RE.test(next)) matched = D28_PUSH_KIND_RE.test(`${line} ${next}`);
      if (matched) {
        out.push({ rule: "D28-push-client-kind", file: f.relPath, line: i + 1, snippet: (original[i] ?? "").trim() });
      }
    }
  }
  return out;
}
```

Then wire it everywhere `checkFleetClientKindConfinement` is wired. Run `grep -n "checkFleetClientKindConfinement\|D28-fleet-client-kind" scripts/structure-audit/check-nimbus-invariants.ts`. Every call site, aggregator entry and CI message branch it prints gets a push twin. Add `"packages/gateway/src/oncall-push/push-runner.ts"` to the anchor-file list beside the fleet-invoker entry at `~:2359`. **Before that file exists (Task 5), the anchor check will fail if it requires existence.** If it does, add the anchor entry in Task 5 instead and note it there.

- [ ] **Step 5: Run the tests, then the static audit**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts packages/gateway/src/security-invariants.test.ts`
Expected: PASS.
Run: `bun run typecheck`
Expected: PASS. If anything else enumerates `ClientKind` exhaustively (a `switch` with `never`), the compiler names it now. Add `push` there with the most restrictive reading (treat it like `fleet`).
Run: `bun scripts/structure-audit/check-nimbus-invariants.ts`
Expected: no violations.

- [ ] **Step 6: Commit** with `"feat(oncall-push): derived push ClientKind, non-bearing, D28 confinement"`.

---

### Task 4: The candidate selector

**Files:**
- Create: `packages/gateway/src/oncall-push/push-selector.ts`
- Test: `packages/gateway/src/oncall-push/push-selector.test.ts`

**Interfaces:**
- Consumes: `selectActiveAssignedIncidents(db, personId): OncallIncident[]` from `../agents/oncall-queries.ts` (exported, newest first); `OncallIncident` from `../agents/_lib/oncall-types.ts`; `NimbusOncallPushToml` (Task 1).
- Produces:
  ```ts
  export const ENABLE_GRACE_MS: number; // 5 * 60_000
  export function resolveSeveritySet(cfg: NimbusOncallPushToml, pagerdutyAliases: readonly string[]): ReadonlySet<string>;
  export type SelectInput = {
    readonly personId: string;
    readonly severities: ReadonlySet<string>;
    readonly enabledAtMs: number;
    readonly alreadyPushed: (incidentId: string) => boolean;
  };
  export function selectPushCandidates(db: Database, input: SelectInput): OncallIncident[];
  ```

**Fixtures come from the real PagerDuty writer** (`syncPagerdutyIncidentItems`), which also builds the `graph_relation` `assigned` edge the selector reads. Never hand-write incident metadata.

- [ ] **Step 1: Write the failing test**

```ts
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { selectActiveAssignedIncidents } from "../agents/oncall-queries.ts";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../config/oncall-push-toml.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import { ENABLE_GRACE_MS, resolveSeveritySet, selectPushCandidates } from "./push-selector.ts";

const ME = "me@acme.example";
const OTHER = "other@acme.example";
const T0 = Date.parse("2026-10-02T12:00:00.000Z");

type Inc = { id: string; status?: string; priority?: string; createdAt?: string | null; assignee?: string };
function pdRow(i: Inc): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: i.id,
    status: i.status ?? "triggered",
    title: `incident ${i.id}`,
    urgency: "high",
    updated_at: new Date(T0).toISOString(),
    service: { id: "PSVC" },
    assignments: [{ assignee: { id: `U-${i.assignee ?? ME}`, type: "user", email: i.assignee ?? ME } }],
  };
  if (i.priority !== undefined) row["priority"] = { name: i.priority };
  if (i.createdAt !== null) row["created_at"] = i.createdAt ?? new Date(T0).toISOString();
  return row;
}

let db: Database;
function seed(incidents: Inc[]): string {
  const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }), "pagerduty");
  syncPagerdutyIncidentItems(ctx, incidents.map(pdRow), new Date(T0 - 86_400_000).toISOString(), T0, new Map());
  const me = findPersonByCanonicalEmail(db, ME);
  if (me === null) throw new Error("fixture: the writer did not create the assignee person");
  return me.id;
}
beforeEach(() => {
  db = createMemoryIndexDb();
});
afterEach(() => db.close());

const P1 = resolveSeveritySet(DEFAULT_ONCALL_PUSH_CONFIG, []);
const base = (personId: string) => ({
  personId,
  severities: P1,
  enabledAtMs: T0 - 60_000,
  alreadyPushed: () => false,
});

describe("resolveSeveritySet", () => {
  test("default is {p1} ∪ aliases", () => {
    expect([...resolveSeveritySet(DEFAULT_ONCALL_PUSH_CONFIG, ["sev-1"])].sort()).toEqual(["p1", "sev-1"]);
  });
  test("configured severities REPLACE the default", () => {
    expect([...resolveSeveritySet({ ...DEFAULT_ONCALL_PUSH_CONFIG, severities: ["p2"] }, ["sev-1"])]).toEqual(["p2"]);
  });
});

describe("selectPushCandidates", () => {
  test("selects a triggered P1 assigned to me — and matches case-insensitively (P1 vs p1)", () => {
    const me = seed([{ id: "PA", priority: "P1" }]);
    expect(selectPushCandidates(db, base(me)).map((i) => i.id)).toEqual(["pagerduty:PA"]);
  });

  test("acknowledged counts as active", () => {
    const me = seed([{ id: "PA", priority: "P1", status: "acknowledged" }]);
    expect(selectPushCandidates(db, base(me))).toHaveLength(1);
  });

  test("negative controls: resolved / wrong severity / someone else's / already pushed", () => {
    const me = seed([
      { id: "PR", priority: "P1", status: "resolved" },
      { id: "P2", priority: "P2" },
      { id: "PO", priority: "P1", assignee: OTHER },
      { id: "PD", priority: "P1" },
      { id: "OK", priority: "P1" },
    ]);
    const ids = selectPushCandidates(db, { ...base(me), alreadyPushed: (id) => id === "pagerduty:PD" }).map((i) => i.id);
    expect(ids).toEqual(["pagerduty:OK"]);
  });

  test("enable boundary: inside the grace window is selected, before it is not", () => {
    const me = seed([
      { id: "IN", priority: "P1", createdAt: new Date(T0 - ENABLE_GRACE_MS + 1000).toISOString() },
      { id: "OUT", priority: "P1", createdAt: new Date(T0 - ENABLE_GRACE_MS - 1000).toISOString() },
    ]);
    const ids = selectPushCandidates(db, { ...base(me), enabledAtMs: T0 }).map((i) => i.id);
    expect(ids).toEqual(["pagerduty:IN"]);
  });

  test("no opened_at_ms → never selected (cannot be placed in time)", () => {
    const me = seed([{ id: "NT", priority: "P1", createdAt: null }]);
    expect(selectPushCandidates(db, base(me))).toEqual([]);
  });

  test("parity: candidates are a subset of what `nimbus oncall` calls mine", () => {
    const me = seed([{ id: "A", priority: "P1" }, { id: "B", priority: "P2" }]);
    const mine = new Set(selectActiveAssignedIncidents(db, me).map((i) => i.id));
    for (const c of selectPushCandidates(db, base(me))) expect(mine.has(c.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/oncall-push/push-selector.test.ts`
Expected: FAIL, missing module. If the fixture's own guard throws ("the writer did not create the assignee person"), stop. That would mean `resolvePersonForSync` doesn't create a person from an email alone, and the selector's identity premise has to be re-examined before going on. Report it rather than working around it.

- [ ] **Step 3: Write the implementation**

```ts
import type { Database } from "bun:sqlite";
import type { OncallIncident } from "../agents/_lib/oncall-types.ts";
import { selectActiveAssignedIncidents } from "../agents/oncall-queries.ts";
import type { NimbusOncallPushToml } from "../config/oncall-push-toml.ts";

/** Absorbs PagerDuty↔host clock skew at the enable boundary (spec § 2.2, predicate 5). */
export const ENABLE_GRACE_MS = 5 * 60_000;

/**
 * `{"p1"} ∪ [pagerduty] severity_p1_aliases`, the same baseline `preflight/preflight.ts` uses — or
 * `[oncall.push] severities` when non-empty, which REPLACES it. No extra baseline is invented
 * (`sev1`, `critical`): PagerDuty priority names are org-defined, and an alias the owner did not
 * configure would make push disagree with preflight and DORA about what a P1 is.
 */
export function resolveSeveritySet(
  cfg: NimbusOncallPushToml,
  pagerdutyAliases: readonly string[],
): ReadonlySet<string> {
  if (cfg.severities.length > 0) return new Set(cfg.severities.map((s) => s.toLowerCase()));
  return new Set(["p1", ...pagerdutyAliases.map((s) => s.toLowerCase())]);
}

export type SelectInput = {
  readonly personId: string;
  readonly severities: ReadonlySet<string>;
  readonly enabledAtMs: number;
  readonly alreadyPushed: (incidentId: string) => boolean;
};

/**
 * Spec § 2.2. "Assigned to me, active" is `selectActiveAssignedIncidents` UNCHANGED, so what push
 * selects is by construction what `nimbus oncall` shows for "my incidents". Order is that query's
 * (newest first).
 */
export function selectPushCandidates(db: Database, input: SelectInput): OncallIncident[] {
  const floor = input.enabledAtMs - ENABLE_GRACE_MS;
  return selectActiveAssignedIncidents(db, input.personId).filter(
    (i) =>
      i.severity !== null &&
      input.severities.has(i.severity.toLowerCase()) &&
      i.openedAtMs !== null &&
      i.openedAtMs >= floor &&
      !input.alreadyPushed(i.id),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/oncall-push/push-selector.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit** with `"feat(oncall-push): candidate selector over the oncall assignment query"`.

---

### Task 5: The runner (async dispatch, single-flight with a trailing run, failure, retry)

**Files:**
- Create: `packages/gateway/src/oncall-push/push-runner.ts`
- Test: `packages/gateway/src/oncall-push/push-runner.test.ts`
- Modify (only if Task 3 deferred it): the D28 anchor-file list in `check-nimbus-invariants.ts`

**Interfaces:**
- Consumes: `PushStore`, `BriefOutcome`, `PushedBriefRow` (Task 2); `selectPushCandidates`, `resolveSeveritySet` (Task 4); `NimbusOncallPushToml` (Task 1); `AgentsRpcContext`, `AgentsRpcError`, `dispatchAgentsRpc` from `../ipc/agents-rpc.ts`; `selectIncidentById` from `../agents/oncall-queries.ts`; `LocalIndex` (type) from `../index/local-index.ts`.
- Produces:
  ```ts
  export const PUSH_BRIEF_TIMEOUT_MS = 30_000;
  export type PushDispatchContext = Omit<AgentsRpcContext, "caller" | "runner"> & {
    readonly caller: { readonly clientId: string; readonly kind: "push" };
  };
  export type PushDispatch = (method: string, params: unknown, ctx: PushDispatchContext) => Promise<unknown>;
  export type PushDelivery = { readonly row: PushedBriefRow; readonly incident: OncallIncident };
  export type PushRunSkip = "disabled" | "not_pagerduty" | "identity_unresolved" | "not_reconciled";
  export type PushRunSummary = {
    readonly selected: number; readonly ok: number; readonly failed: number; readonly skipped?: PushRunSkip;
  };
  export class PushRetryRefusedError extends Error {
    readonly code: "ERR_ONCALL_PUSH_NOT_FOUND" | "ERR_ONCALL_PUSH_NOT_FAILED";
  }
  export interface OncallPushRunnerDeps {
    readonly db: Database;
    readonly store: PushStore;
    readonly config: NimbusOncallPushToml;
    readonly pagerdutyAliases: readonly string[];
    readonly configDir: string;
    readonly index?: LocalIndex;
    readonly resolveSelf: () => Promise<string | null>;
    readonly deliver: (items: readonly PushDelivery[]) => Promise<void>;
    readonly dispatch?: PushDispatch;
    readonly timeoutMs?: number;
    readonly now?: () => number;
  }
  export interface OncallPushRunner {
    run(serviceId: string): Promise<PushRunSummary>;
    retry(incidentId: string): Promise<PushedBriefRow>;
  }
  export function createOncallPushRunner(deps: OncallPushRunnerDeps): OncallPushRunner;
  ```

`PushDispatchContext` **omits `runner` by type**, so a push dispatch cannot carry a synthesis runner (spec § 2.3). Leaving `runner` unset is how synthesis is turned off: `synthesize()` returns the deterministic render with `{ attempted: false, reason: "disabled" }`.

- [ ] **Step 1: Write the failing unit tests**

```ts
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../config/oncall-push-toml.ts";
import { createMemoryIndexDb, createStubVault, syncTestContext } from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { AgentsRpcError } from "../ipc/agents-rpc.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import { createOncallPushRunner, type PushDelivery, type PushDispatch, PushRetryRefusedError } from "./push-runner.ts";
import { PushStore } from "./push-store.ts";

const ME = "me@acme.example";
const T0 = Date.parse("2026-10-02T12:00:00.000Z");
let db: Database;
let store: PushStore;
let personId: string;

function seedIncident(id: string): void {
  const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }), "pagerduty");
  syncPagerdutyIncidentItems(
    ctx,
    [{ id, status: "triggered", title: `inc ${id}`, priority: { name: "P1" }, created_at: new Date(T0).toISOString(),
       updated_at: new Date(T0).toISOString(), service: { id: "PSVC" },
       assignments: [{ assignee: { id: "U1", type: "user", email: ME } }] }],
    new Date(T0 - 86_400_000).toISOString(), T0, new Map(),
  );
}

beforeEach(() => {
  db = createMemoryIndexDb();
  store = new PushStore(db);
  store.reconcileEnabledState(true, T0 - 60_000);
  seedIncident("PA");
  const me = findPersonByCanonicalEmail(db, ME);
  if (me === null) throw new Error("fixture: no person");
  personId = me.id;
});
afterEach(() => db.close());

/** A dispatch that answers like emitBriefWithSynthesis: sessionId now, briefReady later. */
const readyDispatch = (calls: unknown[]): PushDispatch => async (method, params, ctx) => {
  calls.push({ method, params, kind: ctx.caller.kind, hasRunner: "runner" in ctx });
  queueMicrotask(() => ctx.notify("oncall.briefReady", { sessionId: "s1", brief: "# brief\n## Gaps\n", findings: { ok: true } }));
  return { sessionId: "s1" };
};

function makeRunner(over: Partial<Parameters<typeof createOncallPushRunner>[0]> = {}) {
  const delivered: PushDelivery[] = [];
  const runner = createOncallPushRunner({
    db, store, config: { ...DEFAULT_ONCALL_PUSH_CONFIG, enabled: true }, pagerdutyAliases: [],
    configDir: "unused-in-unit-tests", resolveSelf: async () => personId,
    deliver: async (items) => { delivered.push(...items); },
    now: () => T0, timeoutMs: 200, ...over,
  });
  return { runner, delivered };
}

describe("push runner", () => {
  test("dispatches agents.oncall {incidentId} as kind push, with NO runner, stores ok, delivers", async () => {
    const calls: unknown[] = [];
    const { runner, delivered } = makeRunner({ dispatch: readyDispatch(calls) });
    expect(await runner.run("pagerduty")).toEqual({ selected: 1, ok: 1, failed: 0 });
    expect(calls).toEqual([{ method: "agents.oncall", params: { incidentId: "pagerduty:PA" }, kind: "push", hasRunner: false }]);
    expect(store.get("pagerduty:PA")).toMatchObject({ status: "ok", briefMarkdown: "# brief\n## Gaps\n", briefJson: '{"ok":true}' });
    expect(delivered.map((d) => d.row.incidentId)).toEqual(["pagerduty:PA"]);
  });

  test("a second run pushes nothing — dedup", async () => {
    const { runner } = makeRunner({ dispatch: readyDispatch([]) });
    await runner.run("pagerduty");
    expect(await runner.run("pagerduty")).toEqual({ selected: 0, ok: 0, failed: 0 });
  });

  test("non-pagerduty / disabled / unresolved identity / not reconciled → skipped, nothing dispatched", async () => {
    const calls: unknown[] = [];
    expect((await makeRunner({ dispatch: readyDispatch(calls) }).runner.run("github")).skipped).toBe("not_pagerduty");
    expect((await makeRunner({ dispatch: readyDispatch(calls), config: DEFAULT_ONCALL_PUSH_CONFIG }).runner.run("pagerduty")).skipped).toBe("disabled");
    expect((await makeRunner({ dispatch: readyDispatch(calls), resolveSelf: async () => null }).runner.run("pagerduty")).skipped).toBe("identity_unresolved");
    store.reconcileEnabledState(false, T0);
    expect((await makeRunner({ dispatch: readyDispatch(calls) }).runner.run("pagerduty")).skipped).toBe("not_reconciled");
    expect(calls).toEqual([]);
  });

  test("a SYNCHRONOUS refusal (thrown AgentsRpcError) is a failed row, not a rejection", async () => {
    const dispatch: PushDispatch = async () => { throw new AgentsRpcError(-32000, "incident not found"); };
    const { runner, delivered } = makeRunner({ dispatch });
    expect(await runner.run("pagerduty")).toEqual({ selected: 1, ok: 0, failed: 1 });
    expect(store.get("pagerduty:PA")?.failureCode).toBe("refused: incident not found");
    expect(delivered[0]?.row.status).toBe("failed");
  });

  test("briefError is a failed row", async () => {
    const dispatch: PushDispatch = async (_m, _p, ctx) => {
      queueMicrotask(() => ctx.notify("oncall.briefError", { sessionId: "s1", error: "boom" }));
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.failureCode).toBe("brief_error: boom");
  });

  test("no notification within the timeout is a failed 'timeout' row", async () => {
    const dispatch: PushDispatch = async () => ({ sessionId: "s1" });
    await makeRunner({ dispatch, timeoutMs: 20 }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.failureCode).toBe("timeout: no brief in 20ms");
  });

  test("a notification for ANOTHER session is ignored", async () => {
    const dispatch: PushDispatch = async (_m, _p, ctx) => {
      queueMicrotask(() => ctx.notify("oncall.briefReady", { sessionId: "other", brief: "x", findings: {} }));
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch, timeoutMs: 20 }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.status).toBe("failed");
  });

  test("a notification that arrives BEFORE dispatch returns is still matched", async () => {
    const dispatch: PushDispatch = async (_m, _p, ctx) => {
      ctx.notify("oncall.briefReady", { sessionId: "s1", brief: "early", findings: {} });
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.briefMarkdown).toBe("early");
  });

  test("single-flight: overlapping calls collapse into ONE trailing run that sees the new incident", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const seen: unknown[] = [];
    const dispatch: PushDispatch = async (_m, params, ctx) => {
      seen.push(params);
      if (seen.length === 1) await gate;
      queueMicrotask(() => ctx.notify("oncall.briefReady", { sessionId: `s${seen.length}`, brief: "b", findings: {} }));
      return { sessionId: `s${seen.length}` };
    };
    const { runner } = makeRunner({ dispatch });
    const first = runner.run("pagerduty");
    seedIncident("PB"); // arrives while the first run is in flight
    const second = runner.run("pagerduty");
    const third = runner.run("pagerduty");
    release();
    await Promise.all([first, second, third]);
    expect(seen).toEqual([{ incidentId: "pagerduty:PA" }, { incidentId: "pagerduty:PB" }]);
  });

  test("retry: refused on ok and on missing; a failed row becomes ok in place", async () => {
    const failing: PushDispatch = async () => { throw new AgentsRpcError(-32000, "x"); };
    await makeRunner({ dispatch: failing }).runner.run("pagerduty");
    const { runner, delivered } = makeRunner({ dispatch: readyDispatch([]), now: () => T0 + 5000 });
    await expect(runner.retry("pagerduty:NOPE")).rejects.toBeInstanceOf(PushRetryRefusedError);
    const row = await runner.retry("pagerduty:PA");
    expect(row).toMatchObject({ status: "ok", createdAt: T0, retriedAt: T0 + 5000 });
    expect(delivered).toHaveLength(1);
    await expect(runner.retry("pagerduty:PA")).rejects.toMatchObject({ code: "ERR_ONCALL_PUSH_NOT_FAILED" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/oncall-push/push-runner.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 3: Write the implementation**

```ts
import type { Database } from "bun:sqlite";
import type { OncallIncident } from "../agents/_lib/oncall-types.ts";
import { selectIncidentById } from "../agents/oncall-queries.ts";
import type { NimbusOncallPushToml } from "../config/oncall-push-toml.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { type AgentsRpcContext, AgentsRpcError, dispatchAgentsRpc } from "../ipc/agents-rpc.ts";
import { resolveSeveritySet, selectPushCandidates } from "./push-selector.ts";
import type { BriefOutcome, PushedBriefRow, PushStore } from "./push-store.ts";

export const PUSH_BRIEF_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
const MAX_DETAIL = 500;

/**
 * `runner` is OMITTED by type: a push dispatch can never carry a synthesis runner, so the brief is
 * always the deterministic render and no unattended push reaches a model (spec § 2.3).
 */
export type PushDispatchContext = Omit<AgentsRpcContext, "caller" | "runner"> & {
  readonly caller: { readonly clientId: string; readonly kind: "push" };
};
export type PushDispatch = (method: string, params: unknown, ctx: PushDispatchContext) => Promise<unknown>;
export type PushDelivery = { readonly row: PushedBriefRow; readonly incident: OncallIncident };
export type PushRunSkip = "disabled" | "not_pagerduty" | "identity_unresolved" | "not_reconciled";
export type PushRunSummary = {
  readonly selected: number;
  readonly ok: number;
  readonly failed: number;
  readonly skipped?: PushRunSkip;
};

export class PushRetryRefusedError extends Error {
  constructor(
    readonly code: "ERR_ONCALL_PUSH_NOT_FOUND" | "ERR_ONCALL_PUSH_NOT_FAILED",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface OncallPushRunnerDeps {
  readonly db: Database;
  readonly store: PushStore;
  readonly config: NimbusOncallPushToml;
  readonly pagerdutyAliases: readonly string[];
  readonly configDir: string;
  readonly index?: LocalIndex;
  readonly resolveSelf: () => Promise<string | null>;
  readonly deliver: (items: readonly PushDelivery[]) => Promise<void>;
  readonly dispatch?: PushDispatch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface OncallPushRunner {
  run(serviceId: string): Promise<PushRunSummary>;
  retry(incidentId: string): Promise<PushedBriefRow>;
}

const defaultDispatch: PushDispatch = async (method, params, ctx) => {
  const out = await dispatchAgentsRpc(method, params, ctx);
  if (out.kind === "miss") throw new AgentsRpcError(-32601, `agent method not served: ${method}`);
  return out.value;
};

function clip(s: string): string {
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s;
}
function sessionIdOf(v: unknown): string | undefined {
  if (v === null || typeof v !== "object" || !("sessionId" in v)) return undefined;
  const id: unknown = v.sessionId;
  return typeof id === "string" && id !== "" ? id : undefined;
}
function field(p: unknown, key: string): unknown {
  return p !== null && typeof p === "object" && key in p ? (p as Record<string, unknown>)[key] : undefined;
}

/** One `agents.oncall` dispatch, awaited through the runner's OWN listener (fleet-invoker's shape). */
function briefIncident(deps: OncallPushRunnerDeps, incidentId: string): Promise<BriefOutcome> {
  const dispatch = deps.dispatch ?? defaultDispatch;
  const timeoutMs = deps.timeoutMs ?? PUSH_BRIEF_TIMEOUT_MS;
  return new Promise<BriefOutcome>((resolve) => {
    let settled = false;
    let expected: string | undefined;
    const pending: Array<{ m: string; p: unknown }> = [];
    const settle = (o: BriefOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    const timer = setTimeout(
      () => settle({ status: "failed", sessionId: expected ?? null, failureCode: `timeout: no brief in ${timeoutMs}ms` }),
      timeoutMs,
    );
    const consider = (m: string, p: unknown): void => {
      if (settled) return;
      if (expected === undefined) {
        pending.push({ m, p });
        return;
      }
      if (sessionIdOf(p) !== expected) return;
      if (m === "oncall.briefReady") {
        const brief = field(p, "brief");
        settle({
          status: "ok",
          sessionId: expected,
          briefMarkdown: typeof brief === "string" ? brief : "",
          briefJson: JSON.stringify(field(p, "findings") ?? {}),
        });
      } else if (m === "oncall.briefError") {
        settle({ status: "failed", sessionId: expected, failureCode: `brief_error: ${clip(String(field(p, "error") ?? "unknown"))}` });
      }
    };
    void (async () => {
      try {
        const out = await dispatch(
          "agents.oncall",
          { incidentId },
          {
            db: deps.db,
            notify: consider,
            configDir: deps.configDir,
            ...(deps.index === undefined ? {} : { index: deps.index }),
            // Server-derived: the gateway's own post-sync hook is calling (D28 confines this literal).
            caller: { clientId: "oncall-push", kind: "push" },
          },
        );
        expected = sessionIdOf(out);
        if (expected === undefined) {
          settle({ status: "failed", sessionId: null, failureCode: "no_session: agents.oncall returned no sessionId" });
          return;
        }
        for (const q of pending.splice(0)) consider(q.m, q.p);
      } catch (e) {
        settle({ status: "failed", sessionId: null, failureCode: `refused: ${clip(e instanceof Error ? e.message : String(e))}` });
      }
    })();
  });
}

export function createOncallPushRunner(deps: OncallPushRunnerDeps): OncallPushRunner {
  const now = deps.now ?? Date.now;
  let inFlight: Promise<PushRunSummary> | undefined;
  let rerunRequested = false;

  async function once(): Promise<PushRunSummary> {
    if (!deps.config.enabled) return { selected: 0, ok: 0, failed: 0, skipped: "disabled" };
    const enabledAt = deps.store.enabledAt();
    if (enabledAt === null) return { selected: 0, ok: 0, failed: 0, skipped: "not_reconciled" };
    const personId = await deps.resolveSelf();
    if (personId === null) return { selected: 0, ok: 0, failed: 0, skipped: "identity_unresolved" };
    deps.store.pruneOlderThan(now() - deps.config.retentionDays * DAY_MS);
    const candidates = selectPushCandidates(deps.db, {
      personId,
      severities: resolveSeveritySet(deps.config, deps.pagerdutyAliases),
      enabledAtMs: enabledAt,
      alreadyPushed: (id) => deps.store.has(id),
    });
    const items: PushDelivery[] = [];
    let ok = 0;
    for (const incident of candidates) {
      if (deps.store.has(incident.id)) continue; // a concurrent retry may have written it
      const outcome = await briefIncident(deps, incident.id);
      const row = deps.store.insert(incident.id, outcome, now());
      if (row.status === "ok") ok += 1;
      items.push({ row, incident });
    }
    if (items.length > 0) await deps.deliver(items);
    return { selected: candidates.length, ok, failed: items.length - ok };
  }

  async function loop(): Promise<PushRunSummary> {
    let last = await once();
    while (rerunRequested) {
      rerunRequested = false;
      last = await once();
    }
    return last;
  }

  return {
    async run(serviceId) {
      if (serviceId !== "pagerduty") return { selected: 0, ok: 0, failed: 0, skipped: "not_pagerduty" };
      if (inFlight !== undefined) {
        rerunRequested = true;
        return inFlight;
      }
      inFlight = loop().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },

    async retry(incidentId) {
      const existing = deps.store.get(incidentId);
      if (existing === null) throw new PushRetryRefusedError("ERR_ONCALL_PUSH_NOT_FOUND", `no pushed brief for ${incidentId}`);
      if (existing.status !== "failed") {
        throw new PushRetryRefusedError("ERR_ONCALL_PUSH_NOT_FAILED", `${incidentId} already has a brief; use nimbus oncall --incident ${incidentId}`);
      }
      const outcome = await briefIncident(deps, incidentId);
      const row = deps.store.applyRetry(incidentId, outcome, now());
      const incident = selectIncidentById(deps.db, incidentId);
      if (row.status === "ok" && incident !== null) await deps.deliver([{ row, incident }]);
      return row;
    },
  };
}
```

The second and third concurrent `run()` calls return the in-flight promise. Their summary is the last loop iteration's, which is what a caller who said "run after this sync" wants.

- [ ] **Step 4: Run the unit tests**

Run: `bun test packages/gateway/src/oncall-push/push-runner.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Write the integration test against the REAL agents dispatcher**

Create `packages/gateway/src/oncall-push/push-runner.integration.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../config/oncall-push-toml.ts";
import { createMemoryIndexDb, createStubVault, syncTestContext } from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAgentsRpc } from "../ipc/agents-rpc.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import { createOncallPushRunner, type PushDispatch } from "./push-runner.ts";
import { PushStore } from "./push-store.ts";

let db: Database;
let configDir: string;
beforeEach(() => {
  db = createMemoryIndexDb();
  configDir = mkdtempSync(join(tmpdir(), "oncall-push-int-"));
});
afterEach(() => {
  db.close();
  rmSync(configDir, { recursive: true, force: true });
});

test("a real agents.oncall brief is stored, synthesis is NOT attempted even under allow-remote", async () => {
  const now = Date.now();
  const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }), "pagerduty");
  syncPagerdutyIncidentItems(ctx, [{
    id: "PINT", status: "triggered", title: "checkout: 5xx", priority: { name: "P1" },
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
    service: { id: "PSVC" }, assignments: [{ assignee: { id: "U1", type: "user", email: "me@acme.example" } }],
  }], new Date(now - 86_400_000).toISOString(), now, new Map());
  const me = findPersonByCanonicalEmail(db, "me@acme.example");
  if (me === null) throw new Error("fixture: no person");
  // allow-remote is configured on purpose: the runner must still never build a synthesis runner.
  writeFileSync(join(configDir, "nimbus.toml"), `[user]\nme_person_id = "${me.id}"\n\n[agents]\nsynthesis = "allow-remote"\n`);

  const synthesisSeen: unknown[] = [];
  const spyDispatch: PushDispatch = async (m, p, c) => {
    const out = await dispatchAgentsRpc(m, p, {
      ...c,
      notify: (method, params) => {
        if (method === "oncall.briefReady") synthesisSeen.push((params as { synthesis?: unknown }).synthesis);
        c.notify(method, params);
      },
    });
    if (out.kind === "miss") throw new Error("miss");
    return out.value;
  };
  const store = new PushStore(db);
  store.reconcileEnabledState(true, now - 1000);
  const runner = createOncallPushRunner({
    db, store, config: { ...DEFAULT_ONCALL_PUSH_CONFIG, enabled: true }, pagerdutyAliases: [],
    configDir, index: new LocalIndex(db), resolveSelf: async () => me.id, deliver: async () => {},
    dispatch: spyDispatch,
  });

  expect(await runner.run("pagerduty")).toMatchObject({ selected: 1, ok: 1, failed: 0 });
  const row = store.get("pagerduty:PINT");
  expect(row?.briefMarkdown).toContain("## Gaps");
  expect(synthesisSeen).toEqual([{ attempted: false, reason: "disabled" }]);
});
```

Run: `bun test packages/gateway/src/oncall-push/push-runner.integration.test.ts`
Expected: PASS. If `new LocalIndex(db)` needs different constructor arguments, use whatever `security-invariants.test.ts:3875-3912` passes as `index:` for the fleet invoker. Copy that exact expression.

- [ ] **Step 6: Run the static audit** (`bun scripts/structure-audit/check-nimbus-invariants.ts`). Expected: clean; `kind: "push"` in `push-runner.ts` is allow-listed. If Task 3 deferred the anchor entry, add it now and re-run.

- [ ] **Step 7: Commit** with `"feat(oncall-push): runner — async oncall dispatch, single-flight with trailing run, retry"`.

---

### Task 6: Sinks (toast + gateway event, capped) and the `nimbus tail` category

**Files:**
- Create: `packages/gateway/src/oncall-push/push-sinks.ts`
- Test: `packages/gateway/src/oncall-push/push-sinks.test.ts`
- Modify: `packages/gateway/src/ipc/gateway-events.ts:14-19` (+ a payload interface beside `:74`)
- Modify: `packages/cli/src/commands/tail.ts:7-15`, `:118-129`, and `renderEvent` (`:131-184`)
- Test: `packages/cli/src/commands/tail.test.ts` (add cases)

**Interfaces:**
- Consumes: `PushStore`, `SinkOutcome` (Task 2); `PushDelivery` (Task 5); `emitGatewayEvent`.
- Produces:
  ```ts
  export const PUSH_NOTIFY_CAP = 3;
  export interface PushSinkDeps {
    readonly store: PushStore;
    readonly notify: (title: string, body: string) => void | Promise<void>;
    readonly emit: (payload: { incidentId: string; status: "ok" | "failed" }) => void;
    readonly now: () => number;
  }
  export function createPushDeliverer(deps: PushSinkDeps): (items: readonly PushDelivery[]) => Promise<void>;
  ```
  `GatewayEventKind` gains `"oncall.briefPushed"`. `TailCategory` gains `"oncall"`.

- [ ] **Step 1: Write the failing sink test**

```ts
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import type { PushDelivery } from "./push-runner.ts";
import { createPushDeliverer, PUSH_NOTIFY_CAP } from "./push-sinks.ts";
import { PushStore } from "./push-store.ts";

let db: Database;
let store: PushStore;
beforeEach(() => { db = createMemoryIndexDb(); store = new PushStore(db); });
afterEach(() => db.close());

function item(id: string, status: "ok" | "failed", openedAtMs: number): PushDelivery {
  const row = store.insert(
    id,
    status === "ok" ? { status, sessionId: "s", briefMarkdown: "m", briefJson: "{}" } : { status, sessionId: null, failureCode: "timeout: x" },
    1,
  );
  return { row, incident: { id, title: `P1 ${id}`, url: null, status: "triggered", severity: "P1", urgency: "high", openedAtMs, pagerdutyServiceId: "S", assigneeEmails: [] } };
}

test("one ok brief → one pointer toast, one id-only event, both recorded", async () => {
  const toasts: [string, string][] = [];
  const events: unknown[] = [];
  const deliver = createPushDeliverer({ store, notify: (t, b) => { toasts.push([t, b]); }, emit: (p) => events.push(p), now: () => 9 });
  await deliver([item("pagerduty:A", "ok", 100)]);
  expect(toasts).toEqual([["Nimbus on-call", "P1 pagerduty:A — brief ready: nimbus oncall pushed pagerduty:A"]]);
  expect(events).toEqual([{ incidentId: "pagerduty:A", status: "ok" }]);
  expect(store.get("pagerduty:A")?.delivery).toEqual({ toast: { outcome: "delivered", at: 9 }, event: { outcome: "delivered", at: 9 } });
});

test("a failed brief still notifies, saying so", async () => {
  const toasts: string[] = [];
  await createPushDeliverer({ store, notify: (_t, b) => { toasts.push(b); }, emit: () => {}, now: () => 1 })([item("pagerduty:F", "failed", 1)]);
  expect(toasts[0]).toBe("P1 pagerduty:F — brief could not be assembled: nimbus oncall pushed pagerduty:F");
});

test(`more than ${PUSH_NOTIFY_CAP}: newest ${PUSH_NOTIFY_CAP} toasted + one summary; rest coalesced; events for ALL`, async () => {
  const toasts: string[] = [];
  const events: unknown[] = [];
  const items = [1, 5, 3, 4, 2].map((n) => item(`pagerduty:${n}`, "ok", n));
  await createPushDeliverer({ store, notify: (_t, b) => { toasts.push(b); }, emit: (p) => events.push(p), now: () => 1 })(items);
  expect(toasts.slice(0, 3).map((b) => b.split(" ")[1])).toEqual(["pagerduty:5", "pagerduty:4", "pagerduty:3"]);
  expect(toasts[3]).toBe("Briefs ready for 5 P1 incidents (3 shown) — nimbus oncall pushed list");
  expect(toasts).toHaveLength(4);
  expect(events).toHaveLength(5);
  expect(store.get("pagerduty:1")?.delivery["toast"]?.outcome).toBe("coalesced");
});

test("a throwing toast does not block the event, and is recorded as failed", async () => {
  const events: unknown[] = [];
  await createPushDeliverer({ store, notify: () => { throw new Error("no display"); }, emit: (p) => events.push(p), now: () => 1 })([item("pagerduty:A", "ok", 1)]);
  expect(events).toHaveLength(1);
  expect(store.get("pagerduty:A")?.delivery["toast"]).toEqual({ outcome: "failed", reason: "no display", at: 1 });
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `bun test packages/gateway/src/oncall-push/push-sinks.test.ts`. Expected: FAIL, missing module.

- [ ] **Step 3: Write `push-sinks.ts`**

```ts
import type { PushDelivery } from "./push-runner.ts";
import type { PushStore, SinkOutcome } from "./push-store.ts";

/** Spec § 2.5: briefs are ALL stored; only human interruptions are capped. */
export const PUSH_NOTIFY_CAP = 3;
const TITLE = "Nimbus on-call";

export interface PushSinkDeps {
  readonly store: PushStore;
  readonly notify: (title: string, body: string) => void | Promise<void>;
  readonly emit: (payload: { incidentId: string; status: "ok" | "failed" }) => void;
  readonly now: () => number;
}

function bodyFor(d: PushDelivery): string {
  return d.row.status === "ok"
    ? `${d.incident.title} — brief ready: nimbus oncall pushed ${d.row.incidentId}`
    : `${d.incident.title} — brief could not be assembled: nimbus oncall pushed ${d.row.incidentId}`;
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createPushDeliverer(deps: PushSinkDeps): (items: readonly PushDelivery[]) => Promise<void> {
  const record = (id: string, sink: string, o: Omit<SinkOutcome, "at">): void =>
    deps.store.recordDelivery(id, sink, { ...o, at: deps.now() });

  return async (items) => {
    // The event is a machine signal (the desktop panel needs every id) — never capped.
    for (const d of items) {
      try {
        deps.emit({ incidentId: d.row.incidentId, status: d.row.status });
        record(d.row.incidentId, "event", { outcome: "delivered" });
      } catch (e) {
        record(d.row.incidentId, "event", { outcome: "failed", reason: errText(e) });
      }
    }
    const newestFirst = [...items].sort((a, b) => (b.incident.openedAtMs ?? 0) - (a.incident.openedAtMs ?? 0));
    const shown = newestFirst.slice(0, PUSH_NOTIFY_CAP);
    for (const d of shown) {
      try {
        await deps.notify(TITLE, bodyFor(d));
        record(d.row.incidentId, "toast", { outcome: "delivered" });
      } catch (e) {
        record(d.row.incidentId, "toast", { outcome: "failed", reason: errText(e) });
      }
    }
    const rest = newestFirst.slice(PUSH_NOTIFY_CAP);
    if (rest.length === 0) return;
    try {
      await deps.notify(
        TITLE,
        `Briefs ready for ${items.length} P1 incidents (${PUSH_NOTIFY_CAP} shown) — nimbus oncall pushed list`,
      );
    } catch {
      // The summary has no row of its own; each coalesced row below still records its outcome.
    }
    for (const d of rest) record(d.row.incidentId, "toast", { outcome: "coalesced" });
  };
}
```

- [ ] **Step 4: Add the event kind.** In `gateway-events.ts`, add `| "oncall.briefPushed"` to `GatewayEventKind` and, beside `HitlRequestedPayload`:

```ts
/** `oncall.briefPushed` — id + status ONLY, never brief text (spec § 2.5). */
export interface OncallBriefPushedPayload {
  readonly incidentId: string;
  readonly status: "ok" | "failed";
}
```

Add a test to `gateway-events.test.ts` mirroring its existing kinds: bind a broadcast with `setGatewayEventBroadcast`, call `emitGatewayEvent("oncall.briefPushed", { incidentId: "pagerduty:A", status: "ok" })`, and assert the method is `"gateway.event"` and the payload keys are exactly `["incidentId", "status"]`.

- [ ] **Step 5: Add the tail category.** In `tail.ts`:

```ts
export type TailCategory = "connector" | "watcher" | "sync" | "extension" | "hitl" | "oncall";
const ALL_CATEGORIES: readonly TailCategory[] = ["connector", "watcher", "sync", "extension", "hitl", "oncall"];
```
In `categoryOf`, before `return null;`: `if (kind.startsWith("oncall.")) return "oncall";`.
In `renderEvent`, immediately before the `[unknown: …]` fallback line (which already has `at`, `kind` and `payload` in scope):

```ts
  if (kind === "oncall.briefPushed") {
    const p = rec(payload);
    const id = p === null ? null : str(p, "incidentId");
    const status = p === null ? null : str(p, "status");
    if (id !== null) {
      return `${at} [oncall] brief ${status === "ok" ? "ready" : "FAILED"} for ${id} — nimbus oncall pushed ${id}`;
    }
  }
```

If `renderEvent`'s variables are named differently, use its actual names. The fallback line at `:183` shows them. Add `tail.test.ts` cases: `--filter oncall` is accepted; a `gateway.event` with `kind: "oncall.briefPushed"` renders the line above; under `--filter sync` it is suppressed.

- [ ] **Step 6: Run the tests.** Run: `bun test packages/gateway/src/oncall-push/push-sinks.test.ts packages/gateway/src/ipc/gateway-events.test.ts packages/cli/src/commands/tail.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit** with `"feat(oncall-push): toast + gateway.event sinks with a per-run cap; tail --filter oncall"`.

---

### Task 7: The runtime and its `assemble.ts` wiring

**Files:**
- Create: `packages/gateway/src/oncall-push/push-runtime.ts`
- Test: `packages/gateway/src/oncall-push/push-runtime.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (construct before the `SyncScheduler` at `~:813`; trigger inside `onConnectorSyncSuccess` after `evaluateWatchersAfterSync` at `~:837`)

**Interfaces:**
- Consumes: Tasks 1, 2, 5 and 6; `resolveNimbusTomlForProfile` and `loadNimbusPagerdutyFromConfigDir`, `loadNimbusUserFromConfigDir` from `../config/nimbus-toml.ts`; `resolveSelfPerson` from `../agents/_lib/self-person.ts`; `emitGatewayEvent`.
- Produces:
  ```ts
  export interface OncallPushRuntime {
    readonly config: NimbusOncallPushToml;
    readonly store: PushStore;
    run(serviceId: string): Promise<PushRunSummary>;
    /** Fire-and-forget for the sync hook; never throws. */
    trigger(serviceId: string): void;
    retry(incidentId: string): Promise<PushedBriefRow>;
    identityResolved(): Promise<boolean>;
  }
  export interface OncallPushBootDeps {
    readonly db: Database;
    readonly configDir: string;
    readonly localIndex?: LocalIndex;
    readonly notify: (title: string, body: string) => void | Promise<void>;
    readonly logger: { error(obj: Record<string, unknown>, msg: string): void };
    readonly now?: () => number;
  }
  export function assembleOncallPushRuntime(deps: OncallPushBootDeps): OncallPushRuntime;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { assembleOncallPushRuntime } from "./push-runtime.ts";

let db: Database;
let configDir: string;
const logs: string[] = [];
const boot = (now = 1000) =>
  assembleOncallPushRuntime({ db, configDir, notify: () => {}, logger: { error: (_o, m) => { logs.push(m); } }, now: () => now });

beforeEach(() => { db = createMemoryIndexDb(); configDir = mkdtempSync(join(tmpdir(), "oncall-push-rt-")); logs.length = 0; });
afterEach(() => { db.close(); rmSync(configDir, { recursive: true, force: true }); });

test("no config → disabled, and the boot reconcile leaves no enabled_at", () => {
  const rt = boot();
  expect(rt.config.enabled).toBe(false);
  expect(rt.store.enabledAt()).toBeNull();
});

test("enabled → boot stamps enabled_at = boot time (spec § 4.1)", () => {
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = true\n");
  expect(boot(4242).store.enabledAt()).toBe(4242);
});

test("a disabled boot clears a prior enabled_at", () => {
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = true\n");
  boot(1);
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = false\n");
  expect(boot(2).store.enabledAt()).toBeNull();
});

test("trigger never throws, even if the run rejects", async () => {
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = true\n");
  const rt = boot();
  expect(() => rt.trigger("pagerduty")).not.toThrow();
});

test("identityResolved reads [user] me_person_id like agents.oncall does", async () => {
  writeFileSync(join(configDir, "nimbus.toml"), '[user]\nme_person_id = "person-1"\n');
  expect(await boot().identityResolved()).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `bun test packages/gateway/src/oncall-push/push-runtime.test.ts`. Expected: FAIL, missing module.

- [ ] **Step 3: Write `push-runtime.ts`**

```ts
import type { Database } from "bun:sqlite";
import { resolveSelfPerson } from "../agents/_lib/self-person.ts";
import { loadNimbusOncallPushFromPath, type NimbusOncallPushToml } from "../config/oncall-push-toml.ts";
import {
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusUserFromConfigDir,
  resolveNimbusTomlForProfile,
} from "../config/nimbus-toml.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { emitGatewayEvent } from "../ipc/gateway-events.ts";
import { createOncallPushRunner, type PushRunSummary } from "./push-runner.ts";
import { createPushDeliverer } from "./push-sinks.ts";
import { type PushedBriefRow, PushStore } from "./push-store.ts";

export interface OncallPushRuntime {
  readonly config: NimbusOncallPushToml;
  readonly store: PushStore;
  run(serviceId: string): Promise<PushRunSummary>;
  trigger(serviceId: string): void;
  retry(incidentId: string): Promise<PushedBriefRow>;
  identityResolved(): Promise<boolean>;
}

export interface OncallPushBootDeps {
  readonly db: Database;
  readonly configDir: string;
  readonly localIndex?: LocalIndex;
  readonly notify: (title: string, body: string) => void | Promise<void>;
  readonly logger: { error(obj: Record<string, unknown>, msg: string): void };
  readonly now?: () => number;
}

export function assembleOncallPushRuntime(deps: OncallPushBootDeps): OncallPushRuntime {
  const now = deps.now ?? Date.now;
  const config = loadNimbusOncallPushFromPath(resolveNimbusTomlForProfile(deps.configDir));
  const store = new PushStore(deps.db);
  // Spec § 4.1: reconciled at BOOT, never on the first run, so the first sync's incidents are
  // never older than enabled_at and a disable→enable cycle never backfills the gap.
  store.reconcileEnabledState(config.enabled, now());

  // The SAME identity source `agents.oncall` uses (agents-rpc.ts handleOncall: the configDir
  // `[user]` override, then resolveSelfPerson's git fallback), so push and oncall agree on "me".
  const resolveSelf = async (): Promise<string | null> => {
    const user = loadNimbusUserFromConfigDir(deps.configDir);
    const r = await resolveSelfPerson(deps.db, user.mePersonId === undefined ? {} : { override: user.mePersonId });
    return r.personId;
  };

  const runner = createOncallPushRunner({
    db: deps.db,
    store,
    config,
    pagerdutyAliases: loadNimbusPagerdutyFromConfigDir(deps.configDir).severityP1Aliases,
    configDir: deps.configDir,
    ...(deps.localIndex === undefined ? {} : { index: deps.localIndex }),
    resolveSelf,
    deliver: createPushDeliverer({
      store,
      notify: deps.notify,
      emit: (p) => emitGatewayEvent("oncall.briefPushed", { incidentId: p.incidentId, status: p.status }),
      now,
    }),
    now,
  });

  return {
    config,
    store,
    run: (serviceId) => runner.run(serviceId),
    trigger(serviceId) {
      runner.run(serviceId).catch((err: unknown) => {
        deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, "[oncall.push] run failed");
      });
    },
    retry: (incidentId) => runner.retry(incidentId),
    identityResolved: async () => (await resolveSelf()) !== null,
  };
}
```

- [ ] **Step 4: Wire it into `assemble.ts`.** Directly **before** `const syncScheduler = new SyncScheduler(` (`~:813`):

```ts
  const oncallPush = assembleOncallPushRuntime({
    db,
    configDir: paths.configDir,
    localIndex,
    notify: (title, body) => notifications.show(title, body),
    logger: syncLogger,
  });
```

Inside `onConnectorSyncSuccess`, right after the `evaluateWatchersAfterSync(...)` line:

```ts
        oncallPush.trigger(serviceId); // returns at once for anything but pagerduty
```

**They are in different functions, and this is how to thread it.** The `SyncScheduler` and `onConnectorSyncSuccess` live inside `async function createSchedulerWithMesh(opts: SchedulerWithMeshOpts): Promise<{ … }>` (`assemble.ts:632`). `ipcOpts` is built in `assemblePlatformServices`, which destructures that function's result at `~:3370` (`} = await createSchedulerWithMesh({`). So:
1. Construct `oncallPush` inside `createSchedulerWithMesh` as shown above.
2. Add `oncallPush: OncallPushRuntime` to that function's declared return type (`:632`) and to its `return { … }` object.
3. Add `oncallPush` to the destructuring at `~:3370`.
4. Task 8 then assigns `ipcOpts.oncallPushRpcCtx = { runtime: oncallPush };` from that destructured binding. Task 10's demo context reaches it through `ipcOpts.oncallPushRpcCtx`, so no further threading is needed.

`createSchedulerWithMesh` has its own `opts` (`paths`, `db`, `localIndex`, `notifications`, `syncLogger` are destructured at `:640-651`), so every dependency above is already in scope there. If `syncLogger`'s type does not match `{ error(obj, msg) }`, pass `{ error: (o, m) => syncLogger.error(o, m) }`.

- [ ] **Step 5: Run tests and typecheck.** Run: `bun test packages/gateway/src/oncall-push/ && bun run typecheck`. Expected: PASS.

- [ ] **Step 6: Commit** with `"feat(oncall-push): runtime + boot reconcile, triggered from the post-sync hook"`.

---

### Task 8: The `oncall.*` IPC namespace (routing, LAN, real-socket E2E)

**Files:**
- Create: `packages/gateway/src/ipc/oncall-push-rpc.ts`
- Test: `packages/gateway/src/ipc/oncall-push-rpc.test.ts`
- Modify: `packages/gateway/src/ipc/server/options.ts` (beside `fleetRpcCtx` at `:181`)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (a new `tryDispatchOncallPushRpc` beside `tryDispatchFleetRpc` at `:1398`; add it to `PHASE4_PLATFORM_DISPATCHERS` right after `tryDispatchFleetRpc`)
- Modify: `packages/gateway/src/platform/assemble.ts` (`ipcOpts.oncallPushRpcCtx = { runtime: oncallPush };` beside `ipcOpts.fleetRpcCtx` at `~:3888`)
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (+ `lan-rpc.test.ts`)
- Create: `packages/gateway/test/e2e/oncall-push-routing.e2e.test.ts`

**Interfaces:**
- Consumes: `OncallPushRuntime` (Task 7); `PushStore.incidentTitle` (Task 2); `dispatchByMethod`, `RpcMissOrHit` from `./_lib/dispatch-by-method.ts`.
- Produces:
  ```ts
  export class OncallPushRpcError extends Error { readonly rpcCode: number }
  export interface OncallPushRpcCtx { readonly runtime: OncallPushRuntime }
  export type PushedBriefSummary = { incidentId: string; status: "ok" | "failed"; createdAt: number; retriedAt: number | null; title: string | null };
  export type PushedBriefDetail = PushedBriefSummary & { briefMarkdown: string | null; failureCode: string | null; delivery: Record<string, { outcome: string; reason?: string; at: number }> };
  // oncall.pushedList  { limit?: 1..200 = 20 } → { enabled: boolean; identity: "resolved" | "unresolved"; briefs: PushedBriefSummary[] }
  // oncall.pushedGet   { incidentId?: string }  → { brief: PushedBriefDetail | null }   (newest when omitted)
  // oncall.pushedRetry { incidentId: string }   → { brief: PushedBriefDetail }
  //   errors: -32602 bad params; -32001 ERR_ONCALL_PUSH_NOT_FOUND; -32002 ERR_ONCALL_PUSH_NOT_FAILED
  export function dispatchOncallPushRpc(method: string, params: unknown, ctx: OncallPushRpcCtx): Promise<RpcMissOrHit>;
  ```

- [ ] **Step 1: Write the failing handler test**

```ts
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../config/oncall-push-toml.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { PushRetryRefusedError } from "../oncall-push/push-runner.ts";
import type { OncallPushRuntime } from "../oncall-push/push-runtime.ts";
import { PushStore } from "../oncall-push/push-store.ts";
import { dispatchOncallPushRpc, OncallPushRpcError } from "./oncall-push-rpc.ts";

let db: Database;
let store: PushStore;
const runtime = (over: Partial<OncallPushRuntime> = {}): OncallPushRuntime => ({
  config: { ...DEFAULT_ONCALL_PUSH_CONFIG, enabled: true }, store,
  run: async () => ({ selected: 0, ok: 0, failed: 0 }), trigger: () => {},
  retry: async () => { throw new PushRetryRefusedError("ERR_ONCALL_PUSH_NOT_FAILED", "x"); },
  identityResolved: async () => true, ...over,
});
beforeEach(() => { db = createMemoryIndexDb(); store = new PushStore(db); });
afterEach(() => db.close());

const hit = async (m: string, p: unknown, rt = runtime()) => {
  const out = await dispatchOncallPushRpc(m, p, { runtime: rt });
  if (out.kind !== "hit") throw new Error(`miss: ${m}`);
  return out.value as Record<string, unknown>;
};

test("pushedList: empty, with status", async () => {
  expect(await hit("oncall.pushedList", {})).toEqual({ enabled: true, identity: "resolved", briefs: [] });
});

test("pushedList / pushedGet return rows, newest when no id", async () => {
  store.insert("pagerduty:A", { status: "ok", sessionId: "s", briefMarkdown: "# A", briefJson: "{}" }, 1);
  store.insert("pagerduty:B", { status: "failed", sessionId: null, failureCode: "timeout: x" }, 2);
  const list = await hit("oncall.pushedList", { limit: 10 });
  expect((list["briefs"] as { incidentId: string }[]).map((b) => b.incidentId)).toEqual(["pagerduty:B", "pagerduty:A"]);
  expect((await hit("oncall.pushedGet", {}))["brief"]).toMatchObject({ incidentId: "pagerduty:B", failureCode: "timeout: x" });
  expect((await hit("oncall.pushedGet", { incidentId: "pagerduty:A" }))["brief"]).toMatchObject({ briefMarkdown: "# A" });
  expect((await hit("oncall.pushedGet", { incidentId: "pagerduty:NOPE" }))["brief"]).toBeNull();
});

test("bad params are -32602", async () => {
  for (const [m, p] of [["oncall.pushedList", { limit: 0 }], ["oncall.pushedList", { limit: 201 }], ["oncall.pushedGet", { incidentId: 5 }], ["oncall.pushedRetry", {}], ["oncall.pushedList", []]] as const) {
    await expect(dispatchOncallPushRpc(m, p, { runtime: runtime() })).rejects.toMatchObject({ rpcCode: -32602 });
  }
});

test("retry maps refusals to named codes", async () => {
  await expect(dispatchOncallPushRpc("oncall.pushedRetry", { incidentId: "pagerduty:A" }, { runtime: runtime() }))
    .rejects.toMatchObject({ rpcCode: -32002 });
  const notFound = runtime({ retry: async () => { throw new PushRetryRefusedError("ERR_ONCALL_PUSH_NOT_FOUND", "x"); } });
  await expect(dispatchOncallPushRpc("oncall.pushedRetry", { incidentId: "pagerduty:A" }, { runtime: notFound }))
    .rejects.toBeInstanceOf(OncallPushRpcError);
});

test("an unknown oncall.* method misses (falls through to Method not found)", async () => {
  expect((await dispatchOncallPushRpc("oncall.nope", {}, { runtime: runtime() })).kind).toBe("miss");
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `bun test packages/gateway/src/ipc/oncall-push-rpc.test.ts`. Expected: FAIL, missing module.

- [ ] **Step 3: Write `oncall-push-rpc.ts`**

```ts
import { PushRetryRefusedError } from "../oncall-push/push-runner.ts";
import type { OncallPushRuntime } from "../oncall-push/push-runtime.ts";
import type { PushedBriefRow } from "../oncall-push/push-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class OncallPushRpcError extends Error {
  constructor(readonly rpcCode: number, message: string) {
    super(message);
  }
}
export interface OncallPushRpcCtx {
  readonly runtime: OncallPushRuntime;
}
export type PushedBriefSummary = {
  incidentId: string;
  status: "ok" | "failed";
  createdAt: number;
  retriedAt: number | null;
  title: string | null;
};
export type PushedBriefDetail = PushedBriefSummary & {
  briefMarkdown: string | null;
  failureCode: string | null;
  delivery: Record<string, { outcome: string; reason?: string; at: number }>;
};

const MAX_ID = 512;

function obj(params: unknown, method: string): Record<string, unknown> {
  if (params === undefined) return {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new OncallPushRpcError(-32602, `${method} requires an object payload`);
  }
  return params as Record<string, unknown>;
}
function incidentIdParam(p: Record<string, unknown>, method: string, required: boolean): string | undefined {
  const v = p["incidentId"];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || v.trim() === "" || v.length > MAX_ID) {
    throw new OncallPushRpcError(-32602, `${method}: incidentId must be a non-empty string up to ${MAX_ID} characters`);
  }
  return v.trim();
}

function summarize(ctx: OncallPushRpcCtx, r: PushedBriefRow): PushedBriefSummary {
  return {
    incidentId: r.incidentId,
    status: r.status,
    createdAt: r.createdAt,
    retriedAt: r.retriedAt,
    title: ctx.runtime.store.incidentTitle(r.incidentId),
  };
}
function detail(ctx: OncallPushRpcCtx, r: PushedBriefRow): PushedBriefDetail {
  return { ...summarize(ctx, r), briefMarkdown: r.briefMarkdown, failureCode: r.failureCode, delivery: { ...r.delivery } };
}

async function handleList(params: unknown, ctx: OncallPushRpcCtx) {
  const p = obj(params, "oncall.pushedList");
  const raw = p["limit"];
  let limit = 20;
  if (raw !== undefined) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 200) {
      throw new OncallPushRpcError(-32602, "oncall.pushedList: limit must be an integer 1..200");
    }
    limit = raw;
  }
  return {
    enabled: ctx.runtime.config.enabled,
    identity: (await ctx.runtime.identityResolved()) ? "resolved" : "unresolved",
    briefs: ctx.runtime.store.list(limit).map((r) => summarize(ctx, r)),
  };
}

async function handleGet(params: unknown, ctx: OncallPushRpcCtx) {
  const id = incidentIdParam(obj(params, "oncall.pushedGet"), "oncall.pushedGet", false);
  const row = id === undefined ? ctx.runtime.store.newest() : ctx.runtime.store.get(id);
  return { brief: row === null ? null : detail(ctx, row) };
}

async function handleRetry(params: unknown, ctx: OncallPushRpcCtx) {
  const id = incidentIdParam(obj(params, "oncall.pushedRetry"), "oncall.pushedRetry", true);
  if (id === undefined) throw new OncallPushRpcError(-32602, "oncall.pushedRetry: incidentId is required");
  try {
    return { brief: detail(ctx, await ctx.runtime.retry(id)) };
  } catch (e) {
    if (e instanceof PushRetryRefusedError) {
      throw new OncallPushRpcError(e.code === "ERR_ONCALL_PUSH_NOT_FOUND" ? -32001 : -32002, e.message);
    }
    throw e;
  }
}

export async function dispatchOncallPushRpc(
  method: string,
  params: unknown,
  ctx: OncallPushRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<OncallPushRpcCtx>(method, params, ctx, {
    "oncall.pushedList": handleList,
    "oncall.pushedGet": handleGet,
    "oncall.pushedRetry": handleRetry,
  });
}
```

Check `dispatchByMethod`'s handler signature (`./_lib/dispatch-by-method.ts`, `RpcMethodHandler<Ctx, V>`) and adapt the three handlers' parameter order to it. `fleet-rpc.ts`'s handlers are the reference.

- [ ] **Step 4: Route it.** In `options.ts`, add `import type { OncallPushRpcCtx } from "../oncall-push-rpc.ts";` and `oncallPushRpcCtx?: OncallPushRpcCtx;` beside `fleetRpcCtx`. In `dispatchers.ts`:

```ts
import { dispatchOncallPushRpc, OncallPushRpcError } from "../oncall-push-rpc.ts";

export async function tryDispatchOncallPushRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("oncall.")) return phase4RpcSkipped;
  const rpc = ctx.options.oncallPushRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchOncallPushRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof OncallPushRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}
```

Add `tryDispatchOncallPushRpc` to `PHASE4_PLATFORM_DISPATCHERS` immediately after `tryDispatchFleetRpc`. In `assemble.ts`, beside `ipcOpts.fleetRpcCtx = {…}`: `ipcOpts.oncallPushRpcCtx = { runtime: oncallPush };`.

- [ ] **Step 5: LAN-forbid the namespace.** In `lan-rpc.ts`, after the `"fleet",` entry:

```ts
  // `oncall.pushed*` — the on-call pushed brief (2026-10-02). The WHOLE namespace: briefs carry the
  // owner's incident, assignees and deploy history, and `pushedRetry` runs an agent. `agents.oncall`
  // is a different namespace and is unaffected.
  "oncall",
```

In `lan-rpc.test.ts`, mirroring the fleet `test.each` at `:111-120`:

```ts
  test.each(["oncall.pushedList", "oncall.pushedGet", "oncall.pushedRetry"])(
    "%s is not callable over LAN regardless of grant-write",
    (method) => {
      for (const writeAllowed of [true, false]) {
        expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed })).toThrow(/not callable over LAN/);
      }
    },
  );

  test("negative control: the match is the exact namespace, not a prefix", () => {
    expect(() => checkLanMethodAllowed("oncallish.read", { peerId: "p", writeAllowed: false })).not.toThrow();
  });
```

- [ ] **Step 6: Write the real-socket routing E2E.** Create `packages/gateway/test/e2e/oncall-push-routing.e2e.test.ts`. Copy **verbatim** the harness from `packages/gateway/test/e2e/explain-last.e2e.test.ts` lines 15-187: imports, `RUNNER`, timeouts, `pipeOrSocket` (change the pipe tag prefix from `nimbus-explainlast-` to `nimbus-oncallpush-`), `until`, `TinyIpcClient`, `startTestGateway`. Then:

```ts
describe("oncall.* routing over a real socket", () => {
  test(
    "oncall.pushedList is ROUTED (not Method not found) on a default gateway",
    async () => {
      const gw = await startTestGateway("route");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);
        const r = await client.call<{ enabled: boolean; briefs: unknown[] }>("oncall.pushedList", {});
        expect(r.enabled).toBe(false); // default off
        expect(r.briefs).toEqual([]);
        // demo.firePage is claimed only by a demo-rooted gateway (Task 10)
        const miss = await client.raw("demo.firePage", {});
        expect(JSON.stringify(miss.error)).toContain("Method not found");
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
```

A handler wired into `dispatchOncallPushRpc` but missing from `PHASE4_PLATFORM_DISPATCHERS` passes every unit test and returns `Method not found` here. That gap is what this test is for. Red-prove it: temporarily remove the dispatcher entry, see the test fail, restore it.

- [ ] **Step 7: Run the tests.** Run: `bun test packages/gateway/src/ipc/oncall-push-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts packages/gateway/test/e2e/oncall-push-routing.e2e.test.ts`. Expected: PASS. The e2e boots a real gateway: on Windows make sure no `dist/nimbus-gateway.exe` shadows the source, and on Linux the e2e job provides D-Bus.

- [ ] **Step 8: Commit** with `"feat(oncall-push): oncall.pushedList/Get/Retry IPC — routed, LAN-forbidden, e2e-proven"`.

---

### Task 9: CLI `nimbus oncall pushed` and the doctor check

**Files:**
- Create: `packages/cli/src/commands/oncall-pushed.ts`
- Test: `packages/cli/src/commands/oncall-pushed.test.ts`
- Modify: `packages/cli/src/commands/oncall.ts` (top of `runOncallCommand` at `:209`; `USAGE` at `:78-93`)
- Modify: `packages/cli/src/commands/doctor-core.ts` (a new check beside `doctorPrintIndexConfidence` at `:481-517`, wired after `:700-703`)
- Test: `packages/cli/src/commands/doctor-core.test.ts` (add cases)

**Interfaces:**
- Consumes: IPC `oncall.pushedList` / `pushedGet` / `pushedRetry` (Task 8); `withGatewayIpc`; `briefTextFor` from `../lib/agent-brief-render.ts`; `CliExit` from `../lib/cli-exit.ts`; `getCliPlatformPaths` from `../paths.ts`.
- Produces:
  ```ts
  export type OncallPushedArgs =
    | { readonly mode: "newest"; readonly json: boolean }
    | { readonly mode: "list"; readonly json: boolean }
    | { readonly mode: "one"; readonly incidentId: string; readonly retry: boolean; readonly json: boolean };
  export interface OncallPushedIpc { call(method: string, params?: unknown): Promise<unknown> }
  export interface OncallPushedSink { out(s: string): void; err(s: string): void }
  export function parseOncallPushedArgs(argv: readonly string[]): OncallPushedArgs | undefined;
  export async function runOncallPushedWith(c: OncallPushedIpc, a: OncallPushedArgs, sink: OncallPushedSink, demo: boolean): Promise<number>;
  export async function runOncallPushed(argv: string[]): Promise<void>; // throws CliExit(code) when code !== 0
  export function doctorPrintOncallPush(r: { enabled?: unknown; identity?: unknown }): number;
  ```

- [ ] **Step 1: Write the failing CLI test**

```ts
import { describe, expect, test } from "bun:test";
import { type OncallPushedIpc, parseOncallPushedArgs, runOncallPushedWith } from "./oncall-pushed.ts";

function fake(responses: Record<string, unknown | Error>): OncallPushedIpc & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      const r = responses[method];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
function sink() {
  const s = { out: "", err: "" };
  return { s, sink: { out: (x: string) => { s.out += x; }, err: (x: string) => { s.err += x; } } };
}
const OK = { incidentId: "pagerduty:A", status: "ok", createdAt: 1, retriedAt: null, title: "P1 A", briefMarkdown: "# brief A", failureCode: null, delivery: {} };
const FAILED = { ...OK, status: "failed", briefMarkdown: null, failureCode: "timeout: no brief in 30000ms" };

describe("parseOncallPushedArgs", () => {
  test("shapes", () => {
    expect(parseOncallPushedArgs([])).toEqual({ mode: "newest", json: false });
    expect(parseOncallPushedArgs(["list", "--json"])).toEqual({ mode: "list", json: true });
    expect(parseOncallPushedArgs(["pagerduty:A", "--retry"])).toEqual({ mode: "one", incidentId: "pagerduty:A", retry: true, json: false });
    expect(parseOncallPushedArgs(["--retry"])).toBeUndefined();
    expect(parseOncallPushedArgs(["a", "b"])).toBeUndefined();
    expect(parseOncallPushedArgs(["--bogus"])).toBeUndefined();
  });
});

describe("runOncallPushedWith (spec § 2.7 exit table)", () => {
  test("empty → message, exit 0; hint when disabled", async () => {
    const { s, sink: k } = sink();
    const c = fake({ "oncall.pushedGet": { brief: null }, "oncall.pushedList": { enabled: false, identity: "resolved", briefs: [] } });
    expect(await runOncallPushedWith(c, { mode: "newest", json: false }, k, false)).toBe(0);
    expect(s.out).toContain("No pushed briefs yet.");
    expect(s.out).toContain("[oncall.push] enabled = true");
  });

  test("ok brief → markdown, exit 0", async () => {
    const { s, sink: k } = sink();
    expect(await runOncallPushedWith(fake({ "oncall.pushedGet": { brief: OK } }), { mode: "newest", json: false }, k, false)).toBe(0);
    expect(s.out).toBe("# brief A\n");
  });

  test("failed brief → code + retry hint, exit 1", async () => {
    const { s, sink: k } = sink();
    expect(await runOncallPushedWith(fake({ "oncall.pushedGet": { brief: FAILED } }), { mode: "one", incidentId: "pagerduty:A", retry: false, json: false }, k, false)).toBe(1);
    expect(s.err).toContain("timeout: no brief in 30000ms");
    expect(s.err).toContain("nimbus oncall pushed pagerduty:A --retry");
  });

  test("unknown id → exit 1", async () => {
    const { s, sink: k } = sink();
    expect(await runOncallPushedWith(fake({ "oncall.pushedGet": { brief: null } }), { mode: "one", incidentId: "pagerduty:X", retry: false, json: false }, k, false)).toBe(1);
    expect(s.err).toContain("No pushed brief for pagerduty:X.");
  });

  test("retry refused → exit 1 with the message", async () => {
    const { s, sink: k } = sink();
    const c = fake({ "oncall.pushedRetry": Object.assign(new Error("ERR_ONCALL_PUSH_NOT_FAILED: already has a brief"), { code: -32002 }) });
    expect(await runOncallPushedWith(c, { mode: "one", incidentId: "pagerduty:A", retry: true, json: false }, k, false)).toBe(1);
    expect(s.err).toContain("ERR_ONCALL_PUSH_NOT_FAILED");
  });

  test("--json is ALWAYS valid JSON, with the same exit codes", async () => {
    const { s, sink: k } = sink();
    const c = fake({ "oncall.pushedList": { enabled: true, identity: "resolved", briefs: [] } });
    expect(await runOncallPushedWith(c, { mode: "list", json: true }, k, false)).toBe(0);
    expect(JSON.parse(s.out)).toEqual({ enabled: true, identity: "resolved", briefs: [] });
    const f = sink();
    expect(await runOncallPushedWith(fake({ "oncall.pushedGet": { brief: FAILED } }), { mode: "newest", json: true }, f.sink, false)).toBe(1);
    expect(JSON.parse(f.s.out).brief.status).toBe("failed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `bun test packages/cli/src/commands/oncall-pushed.test.ts`. Expected: FAIL, missing module.

- [ ] **Step 3: Write `oncall-pushed.ts`**

```ts
import { briefTextFor } from "../lib/agent-brief-render.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type OncallPushedArgs =
  | { readonly mode: "newest"; readonly json: boolean }
  | { readonly mode: "list"; readonly json: boolean }
  | { readonly mode: "one"; readonly incidentId: string; readonly retry: boolean; readonly json: boolean };
export interface OncallPushedIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface OncallPushedSink {
  out(s: string): void;
  err(s: string): void;
}

export const ONCALL_PUSHED_USAGE =
  "Usage: nimbus oncall pushed [--json] | nimbus oncall pushed list [--json] | nimbus oncall pushed <incident-id> [--retry] [--json]";

type Brief = {
  incidentId: string;
  status: "ok" | "failed";
  title: string | null;
  createdAt: number;
  briefMarkdown: string | null;
  failureCode: string | null;
};
type ListResult = { enabled: boolean; identity: string; briefs: Brief[] };

export function parseOncallPushedArgs(argv: readonly string[]): OncallPushedArgs | undefined {
  let json = false;
  let retry = false;
  const pos: string[] = [];
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--retry") retry = true;
    else if (a.startsWith("-")) return undefined;
    else pos.push(a);
  }
  if (pos.length > 1) return undefined;
  if (pos.length === 0) return retry ? undefined : { mode: "newest", json };
  if (pos[0] === "list") return retry ? undefined : { mode: "list", json };
  return { mode: "one", incidentId: pos[0] as string, retry, json };
}

function renderBrief(b: Brief, sink: OncallPushedSink, demo: boolean): number {
  if (b.status === "failed") {
    sink.err(`The brief for ${b.incidentId} could not be assembled: ${b.failureCode ?? "unknown"}\n`);
    sink.err(`Retry: nimbus oncall pushed ${b.incidentId} --retry\n`);
    return 1;
  }
  sink.out(`${briefTextFor(b.briefMarkdown ?? "", demo)}\n`);
  return 0;
}

export async function runOncallPushedWith(
  c: OncallPushedIpc,
  a: OncallPushedArgs,
  sink: OncallPushedSink,
  demo: boolean,
): Promise<number> {
  try {
    if (a.mode === "list") {
      const r = (await c.call("oncall.pushedList", { limit: 50 })) as ListResult;
      if (a.json) {
        sink.out(`${JSON.stringify(r)}\n`);
        return 0;
      }
      if (r.briefs.length === 0) {
        sink.out("No pushed briefs yet.\n");
        if (!r.enabled) sink.out("On-call push is off. Set [oncall.push] enabled = true in nimbus.toml.\n");
        return 0;
      }
      for (const b of r.briefs) {
        sink.out(`${new Date(b.createdAt).toISOString()}  ${b.status === "ok" ? "ok    " : "FAILED"}  ${b.incidentId}  ${b.title ?? ""}\n`);
      }
      return 0;
    }
    const raw =
      a.mode === "one" && a.retry
        ? await c.call("oncall.pushedRetry", { incidentId: a.incidentId })
        : await c.call("oncall.pushedGet", a.mode === "one" ? { incidentId: a.incidentId } : {});
    const brief = (raw as { brief: Brief | null }).brief;
    if (a.json) {
      sink.out(`${JSON.stringify({ brief })}\n`);
      // Spec § 2.7: newest+none → 0 (an empty list is an answer); a named id with none → 1;
      // a failed brief → 1; an ok brief → 0.
      if (brief === null) return a.mode === "one" ? 1 : 0;
      if (brief.status === "failed") return 1;
      return 0;
    }
    if (brief === null) {
      if (a.mode === "one") {
        sink.err(`No pushed brief for ${a.incidentId}.\n`);
        return 1;
      }
      sink.out("No pushed briefs yet.\n");
      const list = (await c.call("oncall.pushedList", { limit: 1 })) as ListResult;
      if (!list.enabled) sink.out("On-call push is off. Set [oncall.push] enabled = true in nimbus.toml.\n");
      return 0;
    }
    return renderBrief(brief, sink, demo);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${msg}\n`);
    return 1;
  }
}

export async function runOncallPushed(argv: string[]): Promise<void> {
  const a = parseOncallPushedArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${ONCALL_PUSHED_USAGE}\n`);
    throw new CliExit(1);
  }
  const paths = getCliPlatformPaths();
  const code = await withGatewayIpc(
    (c) =>
      runOncallPushedWith(
        c,
        a,
        { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
        paths.demo === true,
      ),
    paths,
  );
  if (code !== 0) throw new CliExit(code);
}
```

If `withGatewayIpc` throws `GatewayNotRunningError`, let it propagate; the CLI's top level already prints it for every command.

- [ ] **Step 4: Dispatch from `nimbus oncall`.** At the top of `runOncallCommand` in `oncall.ts`:

```ts
  if (args[0] === "pushed") {
    await runOncallPushed(args.slice(1));
    return;
  }
```

Import `runOncallPushed` and `ONCALL_PUSHED_USAGE`, and append `ONCALL_PUSHED_USAGE` as a line in `USAGE`. While here, fix the usage text's `` `[user] mePersonId` `` to `` `[user] me_person_id` `` (the real TOML key, `nimbus-toml.ts:1432`). Add a test in `oncall.test.ts` showing that `["pushed", "--bogus"]` does **not** reach the incident flag parser: it fails with `ONCALL_PUSHED_USAGE`, not `Unknown flag`.

- [ ] **Step 5: The doctor check.** In `doctor-core.ts`, beside `doctorPrintIndexConfidence`:

```ts
/** Spec § 4: push enabled but no identity selects nothing — say so rather than stay silent. */
export function doctorPrintOncallPush(r: { enabled?: unknown; identity?: unknown }): number {
  if (r.enabled !== true) return 0;
  if (r.identity === "unresolved") {
    console.log(
      "[warn] On-call push is enabled but your identity is unresolved, so no incident can be selected. " +
        "Set [user] me_person_id in nimbus.toml or `git config user.email`.",
    );
    return 1;
  }
  console.log("[ok] On-call push: enabled.");
  return 0;
}
```

Wire it after the `index.health` block (`:700-703`):

```ts
  const push = await client
    .call<{ enabled?: unknown; identity?: unknown }>("oncall.pushedList", { limit: 1 })
    .catch(() => ({}) as { enabled?: unknown; identity?: unknown });
  exit = Math.max(exit, doctorPrintOncallPush(push));
```

Add `doctor-core.test.ts` cases: disabled → 0 and prints nothing; enabled + unresolved → 1 with `[warn]`; enabled + resolved → 0 with `[ok]`; `{}` (an older gateway) → 0.

- [ ] **Step 6: Run the tests.** Run: `bun test packages/cli/src/commands/oncall-pushed.test.ts packages/cli/src/commands/oncall.test.ts packages/cli/src/commands/doctor-core.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit** with `"feat(oncall-push): nimbus oncall pushed + doctor warning when identity is unresolved"`.

---

### Task 10: The demo — page firing, re-timed story, tour step, transitional judge

**Files:**
- Modify: `packages/gateway/src/demo/corpus/acme.ts` (`STORY_DEPLOY` `:301-307`; `STORY_INCIDENTS` `:344-352`; `STORY_MESSAGES` `:380-402`; `ACME_TOUR_STEPS` `:83-109`; the corpus type and `buildAcmeCorpus` `~:631`)
- Modify: `packages/gateway/src/demo/seed.ts` (`writeDemoConfig` `:120-146`; export `writeItems`/`personIdFor` or add `fireDemoPage` in this file)
- Modify: `packages/gateway/src/ipc/demo-rpc.ts` (+ test)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts:971-998` (`tryDispatchDemoRpc` passes the runtime)
- Modify: `packages/cli/src/commands/demo.ts` (`DemoDeps` `:22-34`, defaults `:38-66`, flow after the restart `:146-148`)
- Modify: `scripts/release/assert-demo-tour.ts` (`COMMANDS` `:24-28`, the check `:98-100`) + its test
- Modify: `packages/gateway/test/e2e/demo-tour.e2e.test.ts` (the oncall command anchor)
- Test: `packages/gateway/src/demo/seed.test.ts` (or the seed test that exists), `packages/cli/src/commands/demo.test.ts`, `packages/gateway/src/ipc/demo-rpc.test.ts`

**Interfaces:**
- Consumes: `OncallPushRuntime` (Task 7).
- Produces:
  ```ts
  // seed.ts
  export type FireDemoPageResult = { readonly incidentId: string; readonly push: PushRunSummary };
  export async function fireDemoPage(db: Database, runtime: OncallPushRuntime, nowMs: number): Promise<FireDemoPageResult>;
  // demo-rpc.ts: DemoRpcContext gains `readonly oncallPush?: OncallPushRuntime`; method "demo.firePage" takes {} only.
  // demo.ts: DemoDeps gains `readonly firePage: (paths: CliPlatformPaths) => Promise<FireDemoPageSummary>`
  //   where FireDemoPageSummary = { incidentId: string; push: { selected: number; ok: number; failed: number } }
  ```

**The story in demo time:**
- The paging incident `PDEMO412` is **no longer seeded**. `demo.firePage` writes it with `opened_at_ms = now`.
- `STORY_DEPLOY` moves from `-47 * MINUTE` to `-11 * MINUTE`. The seed adds 3 minutes to finish a deploy, so it finishes about 8 minutes before the page (the roadmap's "the deploy 8 min ago"). The seed→restart→fire gap is seconds.
- `STORY_MESSAGES` (m1–m3) **move into `fireDemoPage`** and are written *after* the push run completes, anchored at the time they're written. The team's chatter follows the page, so the pushed brief is honestly assembled before anyone typed. They're still there for any later `nimbus oncall --incident` in the closing "Try:" block.
- m2's text changes from "about ten minutes before the alert" to "about eight minutes before the alert", matching the re-timed deploy.
- `writeDemoConfig` adds `[oncall.push]\nenabled = true\n`. `[user] me_person_id` is already Sam, the incident assignee.
- `enabled_at` comes from the boot reconcile (Task 7): `nimbus demo` restarts the gateway after seeding (`demo.ts:146`), so boot time precedes the page.
- The tour's first step stays `kind: "oncall"` and `title: "On-call triage"` (the judge's `HEADERS` are unchanged), with `args: ["pushed"]` and `reason: "the page that just fired"`. Its printed command becomes `$ nimbus --demo oncall pushed`.

- [ ] **Step 1: Write the failing tests**

In `packages/gateway/src/demo/seed.test.ts`, which already has `fresh()` (`:26-37`, a migrated `:memory:` DB plus temp config/data dirs, cleaned up by the file's own hooks) and `count()` (`:39-42`), add:

```ts
const MINUTE = 60_000;

test("the paging incident is NOT seeded; firePage writes it, pushes ONE brief, then the chatter", async () => {
  const { db, configDir, dataDir } = fresh();
  const nowMs = Date.now();
  await seedDemoCorpus(db, { configDir, dataDir, nowMs });
  expect(count(db, "SELECT COUNT(*) AS n FROM item WHERE id = 'pagerduty:PDEMO412'")).toBe(0);

  // The runtime boots AFTER the seed, as the real gateway does after `nimbus demo`'s restart.
  const rt = assembleOncallPushRuntime({ db, configDir, notify: () => {}, logger: { error: () => {} }, now: () => nowMs + 5_000 });
  expect(rt.config.enabled).toBe(true); // writeDemoConfig enabled it
  expect(rt.store.enabledAt()).toBe(nowMs + 5_000); // boot reconcile, before the page

  const r = await fireDemoPage(db, rt, nowMs + 10_000);
  expect(r.incidentId).toBe("pagerduty:PDEMO412");
  expect(r.push).toMatchObject({ selected: 1, ok: 1, failed: 0 });
  const brief = rt.store.get("pagerduty:PDEMO412");
  expect(brief?.briefMarkdown).toContain("payment-service");
  expect(brief?.briefMarkdown).toContain("412");
  // The chatter is written AFTER the brief was assembled, so the pushed brief cannot quote it…
  expect(brief?.briefMarkdown).not.toContain("Looking now");
  // …but it is in the index for any later `nimbus oncall --incident`.
  expect(count(db, "SELECT COUNT(*) AS n FROM item WHERE body_preview LIKE '%Looking now%'")).toBe(1);
  // Idempotent: firing again pushes nothing new.
  expect((await fireDemoPage(db, rt, nowMs + 20_000)).push.selected).toBe(0);
});

test("the story deploy finishes ~8 minutes before the page", async () => {
  const { db, configDir, dataDir } = fresh();
  const nowMs = Date.now();
  await seedDemoCorpus(db, { configDir, dataDir, nowMs });
  // annotateDeployment (deployment/annotate.ts) stores finished_at_ms in item.metadata.
  const row = db
    .query(
      "SELECT json_extract(metadata, '$.finished_at_ms') AS f FROM item WHERE type = 'deployment' AND json_extract(metadata, '$.run_id') = '7412'",
    )
    .get() as { f: number } | null;
  expect(row).not.toBeNull();
  expect(row?.f).toBeGreaterThanOrEqual(nowMs - 9 * MINUTE);
  expect(row?.f).toBeLessThanOrEqual(nowMs - 7 * MINUTE);
});
```

Import `assembleOncallPushRuntime` from `../oncall-push/push-runtime.ts` and `fireDemoPage` from `./seed.ts`. If `annotateDeployment` writes a `type` other than `'deployment'`, read the literal from its `INSERT INTO item` statement (`deployment/annotate.ts:~199`) and use it. If the slack message body column differs from `body_preview`, read `upsertIndexedItem`'s column list. Also update every existing seed test that asserts `counts.items` / incident / message totals: the seed now writes 1 incident and 3 messages fewer.

In `demo-rpc.test.ts`: `demo.firePage` with an absent `oncallPush` → `-32010` `ERR_DEMO_PUSH_UNAVAILABLE`; with params `{ x: 1 }` → `-32602`; with a runtime → a `{ incidentId, push }` hit.

In `demo.test.ts`: `firePage` is called exactly once, **after** the second `start()` and **before** the first tour runner, for both `run` and `run-no-tour`; a `firePage` rejection is reported and exits 1 without running the tour.

In the judge test (`ls scripts/release/*.test.ts`): a capture containing `$ nimbus --demo oncall --incident pagerduty:PDEMO412` passes (the previous release) **and** a capture with `$ nimbus --demo oncall pushed` passes (this release); a capture with neither fails naming both.

- [ ] **Step 2: Run them to verify they fail.** Run: `bun test packages/gateway/src/demo packages/gateway/src/ipc/demo-rpc.test.ts packages/cli/src/commands/demo.test.ts scripts/release`. Expected: FAIL.

- [ ] **Step 3: Re-time the corpus.** In `acme.ts`:
  - `STORY_DEPLOY.offsetMs: -11 * MINUTE` (comment: "finishes ~8 min before the page that `demo.firePage` fires").
  - Remove the `PAGING_INCIDENT_ID` entry from `STORY_INCIDENTS` and export it as `export const PAGING_INCIDENT: DemoItem = incident(PAGING_INCIDENT_ID, "payment-service: 5xx rate above 5% on /v1/charges", 0, "triggered", "sam", "PPAYDEMO");`.
  - Remove `STORY_MESSAGES` from whatever corpus array includes it, and export it as `PAGE_FOLLOW_UPS`, with offsets `0`, `1`, `2` (ms after the moment they are written) and m2's text set to `"PR #412 (PAY-231) went out to payment-service about eight minutes before the alert. Checking whether the 8s cap is involved."`.
  - `ACME_TOUR_STEPS[0]`: `{ kind: "oncall", title: "On-call triage", args: ["pushed"], reason: "the page that just fired" }`. Update the comment above it: the index id is no longer needed here.
  - Run `grep -rn "PAGING_INCIDENT_ID\|STORY_MESSAGES\|PDEMO412" packages/gateway/src packages/cli/src` and fix every consumer (e.g. a "Try:" hint naming `pagerduty:PDEMO412` stays valid, since the incident exists after the page).

- [ ] **Step 4: `fireDemoPage` and the config.** In `seed.ts`, `writeDemoConfig` appends after the service blocks:

```ts
      "\n[oncall.push]\n" +
      "enabled = true\n"
```

and add:

```ts
export type FireDemoPageResult = { readonly incidentId: string; readonly push: PushRunSummary };

/**
 * The page (spec § 3): write the paging incident "now", mark PagerDuty as just synced, run the SAME
 * `runtime.run("pagerduty")` a real sync triggers, and only THEN write the team's chatter — so the
 * pushed brief is honestly assembled before anyone typed.
 */
export async function fireDemoPage(
  db: Database,
  runtime: OncallPushRuntime,
  nowMs: number,
): Promise<FireDemoPageResult> {
  const corpus = buildAcmeCorpus();
  const at: At = (offsetMs) => nowMs + offsetMs;
  writeItems(db, corpus.people, [PAGING_INCIDENT], at, nowMs);
  dbRun(
    db,
    "INSERT INTO sync_state (connector_id, last_sync_at) VALUES (?, ?) ON CONFLICT(connector_id) DO UPDATE SET last_sync_at = excluded.last_sync_at",
    ["pagerduty", nowMs],
  );
  const push = await runtime.run("pagerduty");
  const after = Date.now();
  writeItems(db, corpus.people, PAGE_FOLLOW_UPS, (o) => after + o, after);
  return { incidentId: itemPrimaryKey("pagerduty", "PDEMO412"), push };
}
```

Copy the `sync_state` upsert's exact conflict clause from `seed.ts:376-380` rather than trusting the one above, and import `itemPrimaryKey` from wherever `acme.ts` imports it.

- [ ] **Step 5: `demo.firePage`.** In `demo-rpc.ts`, add `readonly oncallPush?: OncallPushRuntime;` to `DemoRpcContext`, and:

```ts
async function handleFirePage(params: unknown, ctx: DemoRpcContext) {
  if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length > 0)) {
    throw new DemoRpcError(-32602, "ERR_INVALID_PARAMS: demo.firePage takes {}");
  }
  if (ctx.oncallPush === undefined) {
    throw new DemoRpcError(-32010, "ERR_DEMO_PUSH_UNAVAILABLE: the on-call push runtime is not wired");
  }
  return fireDemoPage(ctx.db, ctx.oncallPush, (ctx.now ?? Date.now)());
}
```

Register `"demo.firePage": handleFirePage` beside `"demo.seed"`. Match the handler parameter order to `handleDemoSeed`'s. In `tryDispatchDemoRpc` (`dispatchers.ts:971-998`), add `oncallPush: ctx.options.oncallPushRpcCtx?.runtime` to the context it builds (spread it conditionally so it stays absent when undefined). `demo` stays LAN-forbidden as a whole namespace (already true) and is not on the Tauri allowlist (unchanged).

- [ ] **Step 6: The CLI flow.** In `demo.ts`:

```ts
export type FireDemoPageSummary = { incidentId: string; push: { selected: number; ok: number; failed: number } };
// DemoDeps:
  readonly firePage: (paths: CliPlatformPaths) => Promise<FireDemoPageSummary>;
// defaultDemoDeps:
  firePage: (p) =>
    withGatewayIpc((c) => c.call<FireDemoPageSummary>("demo.firePage", {}), p, { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS }),
```

After the restart (`if (!(await deps.start())) return;` at `:148`), before `let failed = false;`:

```ts
  const page = await deps.firePage(paths);
  deps.out(
    page.push.ok > 0
      ? `A page just fired: P1 on payment-service. Its brief was assembled before anyone asked.\n`
      : `A page just fired, but no brief was pushed (${JSON.stringify(page.push)}).\n`,
  );
```

The second branch must not contain `ERR_`, `Gateway is not running` or `No LLM provider available` (the judge's `FORBIDDEN` list) unless it truly is a failure. If the push didn't produce a brief, set `failed = true` after `let failed = false;`, because the tour's first step will fail too.

- [ ] **Step 7: The transitional judge.** In `assert-demo-tour.ts`:

```ts
/**
 * A step's command line, or a set of accepted alternatives. The first step has TWO during the
 * transition: the weekly run judges the LATEST RELEASE with `main`'s script, so until a release
 * carrying the pushed brief ships, `main` must still accept the old `--incident` form. Drop the
 * old alternative once the release after 2026-10 carries `oncall pushed`.
 */
const COMMANDS: readonly (string | readonly string[])[] = [
  ["$ nimbus --demo oncall pushed", "$ nimbus --demo oncall --incident pagerduty:PDEMO412"],
  "$ nimbus --demo why src/retry/backoff.ts:42",
  "$ nimbus --demo owners src/retry",
];
```

and the check at `:98-100`:

```ts
  for (const c of COMMANDS) {
    const options = typeof c === "string" ? [c] : c;
    if (!options.some((o) => out.includes(o))) {
      failures.push(`the tour did not print its command line: ${options.join(" OR ")}`);
    }
  }
```

The oncall `SECTION_ANCHORS` (`["payment-service", "412", "## Gaps"]`) hold for the pushed brief unchanged. In `demo-tour.e2e.test.ts`, change the oncall command anchor to `$ nimbus --demo oncall pushed`; that test runs against source and only needs the new form.

- [ ] **Step 8: Run the tests.** Run: `bun test packages/gateway/src/demo packages/gateway/src/ipc/demo-rpc.test.ts packages/cli/src/commands/demo.test.ts scripts/release packages/gateway/test/e2e/demo-tour.e2e.test.ts`. Expected: PASS. The demo-tour E2E asserts the locality panel's zero-egress line and so proves "0 outbound network calls" with the push path in place.

- [ ] **Step 9: Commit** with `"feat(oncall-push): nimbus demo fires a page and shows the pushed brief; judge accepts both tour forms"`.

---

### Task 11: Documentation

**Files:**
- Modify: `docs/architecture.md` (a new subsection after `### Overnight sub-agent fleets` (`~:1511`) or beside the Built-in Agents section `~:1206`; also add the missing `oncall` row to the Built-in Agents Catalogue table `:1229-1253`)
- Modify: `docs/cli-reference.md` (`### nimbus oncall` `:1020-1062` gains `nimbus oncall pushed`; `### nimbus tail` `:1065` gains `oncall`; `### nimbus doctor` `:3752` gains the push check; demo prose `:105/:124/:192`)
- Modify: `docs/roadmap.md` (Phase 17 W2 "pushed incident brief" row → partially shipped, PR 1; Killer Demo beat 1)
- Modify: `docs/CHANGELOG.md` (a dated 2026-10 entry)
- Modify: `docs/SECURITY-INVARIANTS.md` (D28's paragraph: the push twin rule, its allow-list, and why `push: false` in `OWNER_SCOPED_ONCALL_ALLOWED` is not matched)
- Modify: `CLAUDE.md` **and** `GEMINI.md` (`schema V63` → `V64`; the static-complement line "I38 (D28 — the `fleet` ClientKind attribution)" → "…the `fleet` and `push` ClientKind attribution"; one sentence in the status paragraph naming the pushed brief)

- [ ] **Step 1: Write the docs.** Each must state, in these words or tighter:
  - **What ships:** default off; P1 (`{"p1"} ∪ [pagerduty] severity_p1_aliases`, or `[oncall.push] severities`) active incidents assigned to you; one brief per incident; toast + `gateway.event` + `nimbus oncall pushed`; `nimbus demo` fires a page.
  - **What doesn't:** ChatOps (PR 2), the desktop panel (PR 3), approve-from-push, cascade ranking.
  - **Bounds:** synthesis never runs on a push; an incident without `opened_at_ms` is never pushed; a GDPR purge does not sweep `pushed_brief` (retention, 90 days by default, is the bound, the same as `fleet_brief`); enabling never backfills history.
  - **Config:** the `[oncall.push]` table from spec § 2.8 (without `chatops_namespace`'s PR 2 effect claimed).

- [ ] **Step 2: Run the doc gates.** Run: `bun run audit:doc-refs && bun run audit:status-drift`. Expected: PASS. Fix whatever they name; a status-drift failure means a count or enumeration elsewhere disagrees with code. Re-derive the list, not only the number.

- [ ] **Step 3: Commit** with `"docs(oncall-push): architecture, cli-reference, roadmap, changelog, invariants, CLAUDE/GEMINI"`.

---

### Task 12: Whole-branch verification and the PR

- [ ] **Step 1:** `bun run preflight:fast`. Expected: PASS.
- [ ] **Step 2:** `bun test packages/gateway packages/cli scripts` (the CI command). Expected: PASS. If a sandbox-helper test fails on a fresh worktree, build the helper first (it's a git-ignored artifact) rather than skipping.
- [ ] **Step 3:** `bun run verify:docker --changed` to reproduce Linux behaviour for the touched tests.
- [ ] **Step 4:** `bun run audit:platform-test-gaps` and read what it names.
- [ ] **Step 5:** Strip both design docs from the branch before opening the PR (they never land on `main`):
  `git rm docs/superpowers/specs/2026-10-02-oncall-pushed-brief-design.md docs/superpowers/plans/2026-10-02-oncall-pushed-brief-pr1.md` and commit `"chore: drop the design docs before merge"`. The review file under `specs/` is the user's; ask before removing it.
- [ ] **Step 6:** Open the PR. The title is `feat(oncall): push the on-call brief when a P1 is assigned to you` (no `!`: nothing an existing user must change). The body covers the reasoning, the stated bounds from Task 11, and the transitional judge alternative with its removal condition, and ends with the Claude Code attribution line. Do not merge; merging is the user's call.
