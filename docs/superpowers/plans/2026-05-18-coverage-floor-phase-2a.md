# Coverage Floor Phase 2A — Connector-Sync Harness + slack-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable `connector-sync-harness.ts` test helper and apply it to `slack-sync.ts` so its per-file line coverage climbs from 4.35 % to ≥ 80 % on CI Linux lcov, removing the slack-sync entry from `docs/structure-audit/coverage-baseline.json`.

**Architecture:** Single shared harness in `packages/gateway/test/helpers/` provides a fresh in-memory SQLite DB with the LocalIndex schema, a `MockVault`, a `MockFetch` (URL+method+body keyed responses with a call log), a `MockNotificationLog`, a silent pino logger, and a real `ProviderRateLimiter`. The harness exposes `createSyncContext()` to build the exact `SyncContext` shape that `Syncable.sync()` requires. The same harness will be applied to ~22 more `*-sync.ts` files in subsequent phases (2B + 2C). For Phase 2A we ship the harness and one fully-tested consumer (slack).

**Tech Stack:** Bun (test runner, sqlite, fetch shim), TypeScript strict, pino logger, the project's MockVault.

**Spec:** [`docs/superpowers/specs/2026-05-17-coverage-floor-design.md`](../specs/2026-05-17-coverage-floor-design.md) §"Test Harnesses (Phase 2 + 3 backbone)" and §"Phasing — Phase 2".

**Scope decision (confirmed):** The spec's `MockMcpClient` is **dropped** for Phase 2A. All 17 `*-sync.ts` files use raw `fetch()` to talk to cloud APIs; none call `mcp.callTool`. A `MockFetch` keyed by URL+method+body is the correct shape and will be reused in 2B/2C. If a future MCP-backed sync handler appears, a `MockMcpClient` can be re-added to the harness then.

**Branch:** `dev/asafgolombek/coverage-floor-phase-2a-2026-05-18` (branched from `main` — PR #338 is merged).

**Worktree:** `.worktrees/coverage-floor-phase-2a-2026-05-18/`

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `packages/gateway/test/helpers/connector-sync-harness.ts` | Create (replaces WIP) | Factory returning `{ db, vault, fetchMock, notifications, logger, rateLimiter, createSyncContext, cleanup }`. Fresh in-memory SQLite with full `LocalIndex` schema. Logger silent. No `seedVault` field — tests do explicit `await fixture.vault.set(...)`. |
| `packages/gateway/test/helpers/mock-fetch.ts` | Create (replaces `mock-mcp-client.ts`) | `MockFetch` class. Stages canned `Response`s keyed by `(method, url-pattern, body-matcher)`. Records every call. Exposes `install()` / `restore()` that swap `globalThis.fetch`. |
| `packages/gateway/test/helpers/mock-notification-log.ts` | Keep (WIP file already matches) | `MockNotificationLog` — `emit(topic, payload)` + `emitted[]` array + `clear()`. |
| `packages/gateway/test/helpers/mock-mcp-client.ts` | Delete (untracked WIP) | Replaced by `mock-fetch.ts`. |
| `packages/gateway/test/unit/connectors/slack-sync.test.ts` | Rewrite (replaces 207-line draft) | ~30 test cases using the harness. No `globalThis.testInject*` hacks; no `as any` casts. Covers cursor decode, `slackWebApi`, `slackTryFillTeamSubdomain`, `slackCollectMemberChannelIds`, `slackAdvanceListPhase`, `slackHistoryRequestBody`, `slackTryUpsertIndexedHistoryMessage`, `slackUpsertHistoryBatch`, `slackRunHistoryPhase`, `createSlackSyncable.sync` end-to-end. |
| `docs/structure-audit/coverage-baseline.json` | Modify | Remove the `slack-sync.ts` entry once CI Linux confirms ≥ 80 %. Bump or remove any side-effect entries CI flags. |
| `CLAUDE.md` | Modify (1 line) | Append `Phase 2A connector-sync harness + slack-sync ✅ (2026-05-18)` to the Phase 5 status row. |
| `GEMINI.md` | Modify (1 line) | Mirror CLAUDE.md change. |
| `docs/superpowers/plans/2026-05-18-coverage-floor-phase-2a.md` | This file — committed in the FINAL commit | The plan itself, matching the PR #334 / #338 pattern. |

---

## Carry-forwards from Phase 1A (load-bearing — read before each task)

- **TS lint will reject `as any` and DOM globals.** Narrow `fetch` stub params to `input: string, init?: RequestInit` — do **not** reference `RequestInfo` (no DOM lib in Bun's TS config).
- **`process.env["FOO"]` bracket notation** — the project uses `noPropertyAccessFromIndexSignature`. Not strictly needed for these tests, but if any code reads env vars, use brackets.
- **Anchor URL regexes** with `^https:\/\/...$` if any `toMatch(/.../)` is used. CodeQL `js/incomplete-url-substring-sanitization` will flag unanchored URL patterns.
- **Gitleaks fixture-name rule** — avoid all-caps `KEY`/`PAT`/`TOKEN`/`SECRET`/`PWD`/`API_KEY`/`AK`/`SK` as JS variable identifiers. `slack-stub`, `fixture-token`, lower-case names are fine. Values like `"slack-stub-oauth-blob"` are fine; keep them short (entropy below ~3.0).
- **Run `bun run lint:fix` BEFORE every commit.** Biome formatting failures abort the CI lcov build under `set -eo pipefail`, silently making `coverage/lcov.info` missing — then the coverage-floor gate sees slack-sync.ts as "0 %" and screams.
- **Don't run `audit:coverage-floor:update-baseline` locally on Windows** for files with `process.platform` branches. slack-sync has none, but the *other* baseline files might shift in Windows lcov. Trust **CI Linux lcov** to compute the final numbers. The local update step is for verifying which files dropped off, not for committing.
- **IDE tsserver false positives:** `bun:test`/`bun:sqlite` import errors and `TS80007` ("await has no effect") on `expect(...).rejects.toThrow(...)` are spurious. Ignore unless `bun run typecheck` from the project root actually fails.
- **Bash cwd does NOT persist between Bash tool calls.** Always pass absolute paths and `git -C <abs-path>`. Never chain `cd <worktree> && git push`.
- **Don't commit a WIP plan file early.** The plan goes in the final commit so the PR diff tells the story chronologically (PR #334 / #338 pattern).

---

## Task 1: Set up isolated worktree on a fresh branch

**Files:** none yet (creates the worktree directory).

- [ ] **Step 1: Create the worktree**

```bash
git -C "c:/gitrep/Nimbus" fetch origin
git -C "c:/gitrep/Nimbus" worktree add -b dev/asafgolombek/coverage-floor-phase-2a-2026-05-18 ".worktrees/coverage-floor-phase-2a-2026-05-18" origin/main
```

Expected: `Preparing worktree (new branch 'dev/asafgolombek/coverage-floor-phase-2a-2026-05-18')`.

- [ ] **Step 2: Verify worktree branch and base**

```bash
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" status
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" log --oneline -1
```

Expected: `On branch dev/asafgolombek/coverage-floor-phase-2a-2026-05-18`, HEAD points at the latest commit on `origin/main` (currently `ff144988 test(coverage-floor): Phase 1A …`).

- [ ] **Step 3: Confirm the WIP harness files are NOT present in the new worktree**

```bash
ls "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/packages/gateway/test/helpers/" 2>&1 || true
```

Expected: `No such file or directory` (or empty). The WIP files in `c:/gitrep/Nimbus/packages/gateway/test/helpers/` are untracked in the main worktree only.

(No commit at this task — the worktree is the starting point.)

---

## Task 2: Build `mock-fetch.ts`

**Files:**
- Create: `packages/gateway/test/helpers/mock-fetch.ts`

This is the load-bearing piece — every sync-handler test (slack today, github/gitlab/discord/teams/gmail/outlook/onedrive/google-drive/google-photos in 2B, then CI/observability in 2C) installs this on `globalThis.fetch` to stage canned cloud responses.

- [ ] **Step 1: Create the file with the full implementation**

```typescript
/**
 * Test-only `fetch` shim that stages canned Responses keyed by
 * (method, URL-pattern, optional body-matcher) and records every call.
 *
 * Lives under test/helpers/ so it is NOT subject to the per-file
 * coverage floor — it is the testing tool, not production code.
 */

export type FetchCall = {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
};

type BodyMatcher = (parsedBody: unknown, rawBody: string) => boolean;

type Stub = {
  readonly method: string;
  readonly url: string | RegExp;
  readonly bodyMatch?: BodyMatcher;
  readonly response: () => Response;
};

export class MockFetch {
  readonly calls: FetchCall[] = [];
  private readonly stubs: Stub[] = [];
  private original: typeof globalThis.fetch | null = null;

  /**
   * Stage a response. URL may be a literal string (exact match) or a RegExp.
   * The first stub that matches in registration order wins.
   *
   * @example
   * mock.respond("POST", "https://slack.com/api/auth.test", {
   *   ok: true, url: "https://acme.slack.com/",
   * });
   */
  respond(
    method: string,
    url: string | RegExp,
    bodyOrJson: unknown,
    opts?: { status?: number; headers?: Record<string, string>; bodyMatch?: BodyMatcher },
  ): void {
    const status = opts?.status ?? 200;
    const headers = opts?.headers ?? { "content-type": "application/json" };
    const body =
      typeof bodyOrJson === "string" ? bodyOrJson : JSON.stringify(bodyOrJson);
    this.stubs.push({
      method: method.toUpperCase(),
      url,
      bodyMatch: opts?.bodyMatch,
      response: () => new Response(body, { status, headers }),
    });
  }

  /** Stage a non-JSON text response (used to test the JSON-parse-failure branch). */
  respondWithText(
    method: string,
    url: string | RegExp,
    text: string,
    opts?: { status?: number; bodyMatch?: BodyMatcher },
  ): void {
    this.stubs.push({
      method: method.toUpperCase(),
      url,
      bodyMatch: opts?.bodyMatch,
      response: () =>
        new Response(text, {
          status: opts?.status ?? 200,
          headers: { "content-type": "text/plain" },
        }),
    });
  }

  install(): void {
    if (this.original !== null) {
      throw new Error("MockFetch.install() called twice without restore()");
    }
    this.original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      this.handle(input, init)) as typeof globalThis.fetch;
  }

  restore(): void {
    if (this.original !== null) {
      globalThis.fetch = this.original;
      this.original = null;
    }
  }

  /**
   * Helper for assertions: every call body that matches `urlPattern`,
   * parsed as JSON. Throws on bodies that aren't valid JSON.
   */
  bodiesFor(method: string, urlPattern: string | RegExp): unknown[] {
    return this.calls
      .filter(
        (c) =>
          c.method === method.toUpperCase() && this.matchesUrl(urlPattern, c.url),
      )
      .map((c) => (c.body === null ? null : JSON.parse(c.body) as unknown));
  }

  private async handle(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    // string -> as-is; URL -> href via toString(); Request -> input.url
    // (Request.toString() returns "[object Request]", which silently
    // breaks every URL matcher — explicit narrowing prevents that.)
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = init?.body === undefined || init.body === null ? null : String(init.body);
    this.calls.push({ url, method, body: rawBody });

    for (const stub of this.stubs) {
      if (stub.method !== method) {
        continue;
      }
      if (!this.matchesUrl(stub.url, url)) {
        continue;
      }
      if (stub.bodyMatch !== undefined) {
        let parsed: unknown = null;
        if (rawBody !== null && rawBody !== "") {
          try {
            parsed = JSON.parse(rawBody) as unknown;
          } catch {
            parsed = null;
          }
        }
        if (!stub.bodyMatch(parsed, rawBody ?? "")) {
          continue;
        }
      }
      return stub.response();
    }
    throw new Error(`MockFetch: no stub matched ${method} ${url}`);
  }

  private matchesUrl(pattern: string | RegExp, url: string): boolean {
    return typeof pattern === "string" ? pattern === url : pattern.test(url);
  }
}
```

- [ ] **Step 2: Lint the new file**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" lint:fix
```

Expected: clean exit (Biome rewrites if needed; no errors).

- [ ] **Step 3: Stage and commit**

```bash
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add packages/gateway/test/helpers/mock-fetch.ts
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "test(coverage-floor): scaffold MockFetch helper

Stages canned Responses keyed by (method, URL pattern, optional body
matcher) and records every fetch call. Foundation for Phase 2 + 3
connector-sync tests (slack today, ~22 more across 2B/2C)."
```

---

## Task 3: Build `mock-notification-log.ts`

**Files:**
- Create: `packages/gateway/test/helpers/mock-notification-log.ts`

The WIP draft is already correct; restate it here so the implementer doesn't have to fish it out of the untracked tree.

- [ ] **Step 1: Create the file**

```typescript
/**
 * Test-only notification recorder. Connector-sync code does not emit
 * notifications directly (the scheduler does), so for Phase 2A this is
 * unused by slack-sync — but it is part of the harness contract so
 * future tests that exercise scheduler-level paths can assert on the
 * `connector.healthChanged` payloads emitted in response to RateLimitError /
 * UnauthenticatedError thrown by `sync()`.
 */
export class MockNotificationLog {
  readonly emitted: Array<{ topic: string; payload: unknown }> = [];

  emit(topic: string, payload: unknown): void {
    this.emitted.push({ topic, payload });
  }

  clear(): void {
    this.emitted.length = 0;
  }

  /** Every emitted payload for a given topic (filter helper). */
  payloadsFor(topic: string): unknown[] {
    return this.emitted.filter((e) => e.topic === topic).map((e) => e.payload);
  }
}
```

- [ ] **Step 2: Lint + commit**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" lint:fix
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add packages/gateway/test/helpers/mock-notification-log.ts
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "test(coverage-floor): scaffold MockNotificationLog helper

Simple recorder of (topic, payload) emissions. Unused by slack-sync
itself but part of the harness contract for future scheduler-level
tests in phases 2B/2C/3."
```

---

## Task 4: Build `connector-sync-harness.ts`

**Files:**
- Create: `packages/gateway/test/helpers/connector-sync-harness.ts`

- [ ] **Step 1: Create the file**

```typescript
import { Database } from "bun:sqlite";
import pino, { type Logger } from "pino";

import { LocalIndex } from "../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../src/sync/rate-limiter.ts";
import type { SyncContext } from "../../src/sync/types.ts";
import { createMockVault } from "../../src/vault/mock.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";
import { MockFetch } from "./mock-fetch.ts";
import { MockNotificationLog } from "./mock-notification-log.ts";

export interface ConnectorSyncFixture {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly fetchMock: MockFetch;
  readonly notifications: MockNotificationLog;
  readonly logger: Logger;
  readonly rateLimiter: ProviderRateLimiter;

  /** Build the SyncContext shape consumed by `Syncable.sync(ctx, cursor)`. */
  createSyncContext(): SyncContext;

  /** Close the in-memory DB and restore the original `globalThis.fetch`. */
  cleanup(): void;
}

/**
 * Returns a fully-wired fixture for a single connector-sync test.
 *
 * Usage:
 *
 *   const fixture = createConnectorSyncFixture();
 *   fixture.fetchMock.install();
 *   try {
 *     await fixture.vault.set("slack.oauth", JSON.stringify({ access_token: "..." }));
 *     fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: true });
 *     // ...stage more responses, then:
 *     const result = await syncable.sync(fixture.createSyncContext(), null);
 *   } finally {
 *     fixture.cleanup();
 *   }
 *
 * Notes:
 * - No `seedVault` option: MockVault.set is async, so tests do explicit
 *   `await fixture.vault.set(...)`. Keeping the factory synchronous keeps
 *   teardown simple and avoids the fire-and-forget bug in the original WIP.
 * - `fetchMock.install()` is opt-in: tests that don't make HTTP calls can skip it.
 *   `cleanup()` always calls `restore()` — safe even if `install()` was never called.
 */
export function createConnectorSyncFixture(): ConnectorSyncFixture {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);

  const vault = createMockVault();
  const fetchMock = new MockFetch();
  const notifications = new MockNotificationLog();
  const logger = pino({ level: "silent" });
  const rateLimiter = new ProviderRateLimiter();

  return {
    db,
    vault,
    fetchMock,
    notifications,
    logger,
    rateLimiter,
    createSyncContext(): SyncContext {
      return {
        vault,
        db,
        logger,
        rateLimiter,
      };
    },
    cleanup(): void {
      fetchMock.restore();
      db.close();
    },
  };
}
```

- [ ] **Step 2: Verify the LocalIndex import path resolves**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" typecheck 2>&1 | head -40
```

Expected: clean exit, no errors mentioning `connector-sync-harness.ts`. If TS shows complaints about `bun:sqlite` types only inside this file, that's the carry-forward IDE false positive — proceed.

- [ ] **Step 3: Lint + commit**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" lint:fix
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add packages/gateway/test/helpers/connector-sync-harness.ts
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "test(coverage-floor): scaffold connector-sync harness

Fresh in-memory SQLite (full LocalIndex schema), MockVault, MockFetch,
MockNotificationLog, silent pino logger, real ProviderRateLimiter.
Single createSyncContext() builds the SyncContext consumed by every
Syncable.sync(). Foundation for Phase 2A slack-sync coverage and the
~22 *-sync.ts files in 2B/2C."
```

---

## Task 5: slack-sync test scaffolding + cursor decode coverage (Group 1)

**Files:**
- Create: `packages/gateway/test/unit/connectors/slack-sync.test.ts`

This is the first cut of the test file: imports, fixture setup/teardown, a token-getter mock, and tests for cursor decode paths in `decodeCursor`, `slackDecodeHighWater`, and `slackStringIdArrayOk`. These are entirely exercised through `createSlackSyncable().sync(ctx, cursor)` by passing crafted cursors.

The cursor field path `state.phase === "history" && state.ids.length === 0` returns the no-op `hasMore: false` result before any cursor-decode-failure path runs in `createSlackSyncable.sync`. To force `decodeCursor` to return `null` and exercise the default-state path, we pass a cursor that does NOT start with the `nimbus-slk1:` prefix.

- [ ] **Step 1: Create the file with imports, fixture, token-getter mock, and Group 1 tests**

```typescript
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Token-getter must be mocked BEFORE importing slack-sync so the
// `getValidSlackAccessToken` reference is replaced at module-load time.
const tokenState: { throwNext: boolean; value: string } = {
  throwNext: false,
  value: "slack-stub-token",
};
mock.module("../../../src/auth/slack-access-token.ts", () => ({
  getValidSlackAccessToken: async (): Promise<string> => {
    if (tokenState.throwNext) {
      throw new Error("refresh failed");
    }
    return tokenState.value;
  },
}));

import { createSlackSyncable } from "../../../src/connectors/slack-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureSlackMcpRunning: async (): Promise<void> => {} };

const CURSOR_PREFIX = "nimbus-slk1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

let fixture: ConnectorSyncFixture;

beforeEach(async () => {
  fixture = createConnectorSyncFixture();
  fixture.fetchMock.install();
  tokenState.throwNext = false;
  tokenState.value = "slack-stub-token";
  // Seed the vault so the rawVault-null short-circuit doesn't fire in
  // tests that DO want to reach the rate-limiter / fetch path.
  await fixture.vault.set("slack.oauth", "slack-stub-oauth-blob");
});

afterEach(() => {
  fixture.cleanup();
});

describe("slack-sync — credential short-circuits", () => {
  test("returns noop when vault credential is absent", async () => {
    const empty = createConnectorSyncFixture();
    empty.fetchMock.install();
    try {
      const syncable = createSlackSyncable(ENSURE_MCP);
      const res = await syncable.sync(empty.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(res.itemsUpserted).toBe(0);
      expect(res.itemsDeleted).toBe(0);
      expect(empty.fetchMock.calls).toHaveLength(0);
    } finally {
      empty.cleanup();
    }
  });

  test("returns noop when vault stores empty string", async () => {
    const empty = createConnectorSyncFixture();
    empty.fetchMock.install();
    try {
      await empty.vault.set("slack.oauth", "");
      const syncable = createSlackSyncable(ENSURE_MCP);
      const res = await syncable.sync(empty.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(empty.fetchMock.calls).toHaveLength(0);
    } finally {
      empty.cleanup();
    }
  });

  test("returns noop when token getter throws", async () => {
    tokenState.throwNext = true;
    const syncable = createSlackSyncable(ENSURE_MCP);
    const res = await syncable.sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    expect(res.itemsUpserted).toBe(0);
    expect(fixture.fetchMock.calls).toHaveLength(0);
  });
});

describe("slack-sync — cursor decode", () => {
  // Each malformed cursor below produces `decodeCursor() === null`, which
  // falls back to the default `phase: "list"` state. We then stage an
  // empty channel list so the run ends without hitting any other path,
  // confirming the cursor was silently discarded.
  function stageListEmpty(): void {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
  }

  test("null cursor falls back to default list-phase state", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(2);
  });

  test("empty string cursor falls back to default", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), "");
    expect(res.hasMore).toBe(false);
  });

  test("wrong-prefix cursor falls back to default", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      "nimbus-other:abc",
    );
    expect(res.hasMore).toBe(false);
  });

  test("non-base64 cursor body falls back to default", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      `${CURSOR_PREFIX}!!!not-base64!!!`,
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor decoding to non-object falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor("string-not-object"),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor decoding to array falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor([1, 2, 3]),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with bad phase falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "bogus", floorTs: "0", ids: [], nextIdx: 0, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-string floorTs falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "list", floorTs: 42, ids: [], nextIdx: 0, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with empty floorTs falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "list", floorTs: "", ids: [], nextIdx: 0, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-string-array ids falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "list", floorTs: "1.0", ids: [1, 2], nextIdx: 0, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with negative nextIdx falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "list", floorTs: "1.0", ids: [], nextIdx: -1, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-integer nextIdx falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "list", floorTs: "1.0", ids: [], nextIdx: 1.5, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-object hw still decodes (hw defaults to empty)", async () => {
    // This branch covers slackDecodeHighWater's non-object input path.
    // The cursor decodes successfully with hw = {}.
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "history",
        floorTs: "1.0",
        ids: ["C1"],
        nextIdx: 0,
        hw: 42, // non-object -> {} via slackDecodeHighWater
        listCursor: null,
        histCursor: null,
        teamSubdomain: null,
      }),
    );
    expect(res.hasMore).toBe(false);
    expect(res.itemsUpserted).toBe(0);
  });

  test("cursor with hw containing mixed-type values keeps strings, nulls others", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "history",
        floorTs: "1.0",
        ids: ["C1"],
        nextIdx: 0,
        hw: { C1: "100.0", C2: 5, C3: null },
        listCursor: null,
        histCursor: null,
        teamSubdomain: null,
      }),
    );
    expect(res.hasMore).toBe(false);
    // The conversations.history body should include oldest=100.0 (hwVal for C1).
    const bodies = fixture.fetchMock.bodiesFor("POST", "https://slack.com/api/conversations.history");
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as Record<string, unknown>)["oldest"]).toBe("100.0");
  });

  test("floorTs is NaN-string -> reset to current depth window", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    // floorTs is a non-empty string but Number(floorTs) is NaN -> reset path.
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "history",
        floorTs: "not-a-number",
        ids: ["C1"],
        nextIdx: 0,
        hw: {},
        listCursor: null,
        histCursor: null,
        teamSubdomain: null,
      }),
    );
    expect(res.hasMore).toBe(false);
    const bodies = fixture.fetchMock.bodiesFor("POST", "https://slack.com/api/conversations.history");
    // hw was empty and histCursor null -> body should carry oldest = fresh floorTs.
    const body = bodies[0] as Record<string, unknown>;
    expect(typeof body["oldest"]).toBe("string");
    expect(Number(body["oldest"])).not.toBeNaN();
    expect(body["inclusive"]).toBe(true);
  });
});
```

- [ ] **Step 2: Run only this file**

```bash
bun test "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/packages/gateway/test/unit/connectors/slack-sync.test.ts"
```

Expected: 18 tests, all green (3 credential short-circuits + 15 cursor-decode).

- [ ] **Step 3: Lint + commit**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" lint:fix
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add packages/gateway/test/unit/connectors/slack-sync.test.ts
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "test(slack-sync): cover credential short-circuits + cursor decode

18 cases through the harness:
- vault credential missing / empty / token getter throws
- decodeCursor: null, '', wrong prefix, bad base64, non-object,
  array, bad phase, non-string floorTs, empty floorTs, non-string-array
  ids, negative/non-integer nextIdx, non-object hw, mixed-type hw values,
  NaN-floorTs reset path"
```

---

## Task 6: slack-sync — `slackWebApi` + `permalink` + `slackTryFillTeamSubdomain` (Group 2)

**Files:**
- Modify: `packages/gateway/test/unit/connectors/slack-sync.test.ts`

These three helpers are exercised on every sync that reaches the rate-limiter step. Branches to cover:

- `slackWebApi`: response body not parseable as JSON, JSON parses but isn't an object, `ok` field missing, HTTP res.ok false.
- `permalink`: teamSub null, teamSub "", teamSub valid.
- `slackTryFillTeamSubdomain`: already-set teamSubdomain, `auth.test` returns ok:false, url field missing/non-string/empty, URL parse throws (malformed URL string), URL host has no `.slack.com` suffix (sub === host), happy-path subdomain extraction.

The teamSubdomain path is reached by every sync; we observe its effect via the `slack-stub-token`-bearing auth.test response.

- [ ] **Step 1: Append the describe block to the test file**

```typescript
describe("slack-sync — slackWebApi error shapes", () => {
  test("non-JSON response body parses to ok:false (JSON.parse catch path)", async () => {
    fixture.fetchMock.respondWithText(
      "POST",
      "https://slack.com/api/auth.test",
      "not valid json",
    );
    fixture.fetchMock.respondWithText(
      "POST",
      "https://slack.com/api/conversations.list",
      "<html>500</html>",
    );
    // The conversations.list non-JSON triggers the !res.ok throw inside
    // slackAdvanceListPhase because okField is undefined and res.ok matters.
    await expect(
      createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/conversations\.list/);
  });

  test("JSON parses to an array (not an object) treated as ok:false", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", [1, 2, 3]);
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    // auth.test returns an array -> slackTryFillTeamSubdomain bails to !ok branch
    // -> teamSubdomain stays null -> sync still completes through empty list.
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });

  test("HTTP 500 with ok:true in body still treated as ok:false (res.ok gate)", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: true }, { status: 500 });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    // auth.test 500 -> !res.ok -> bail; sync completes through empty list.
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });
});

describe("slack-sync — slackTryFillTeamSubdomain", () => {
  test("auth.test ok with valid Slack URL extracts subdomain into permalinks", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", {
      ok: true,
      url: "https://acme.slack.com/",
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [{ id: "C1", is_member: true }],
      response_metadata: { next_cursor: "" },
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [{ ts: "1700000000.000100", text: "hi", user: "U1" }],
      response_metadata: { next_cursor: "" },
    });

    // First sync -> list phase ends, transitions to history with C1.
    let res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(true);
    // Second sync -> history phase; C1 has 1 message; teamSubdomain=acme.
    res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), res.cursor);
    expect(res.itemsUpserted).toBe(1);

    const row = fixture.db
      .query<{ url: string | null }, []>("SELECT url FROM item WHERE service = 'slack' LIMIT 1")
      .get();
    expect(row?.url).toBe("https://acme.slack.com/archives/C1/p1700000000000100");
  });

  test("auth.test missing url field -> teamSubdomain stays null -> permalink null", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: true });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [{ id: "C1", is_member: true }],
      response_metadata: { next_cursor: "" },
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [{ ts: "1700000000.000200", text: "hi", user: "U1" }],
      response_metadata: { next_cursor: "" },
    });
    let res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), res.cursor);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ url: string | null }, []>("SELECT url FROM item WHERE service = 'slack' LIMIT 1")
      .get();
    expect(row?.url).toBeNull();
  });

  test("auth.test url has no .slack.com suffix -> teamSub null branch", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", {
      ok: true,
      url: "https://example.com/",
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });

  test("auth.test url is malformed (URL constructor throws) -> teamSubdomain stays null", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", {
      ok: true,
      url: "::::not-a-url::::",
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });

  test("auth.test url is empty string -> early return", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: true, url: "" });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });

  test("auth.test url is non-string -> early return", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: true, url: 42 });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });

  test("cursor carries teamSubdomain -> auth.test is not called", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    // No auth.test stub: if it gets called, MockFetch throws "no stub matched".
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "list",
        floorTs: "1.0",
        ids: [],
        nextIdx: 0,
        hw: {},
        listCursor: null,
        histCursor: null,
        teamSubdomain: "acme",
      }),
    );
    expect(res.hasMore).toBe(false);
    const authCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.includes("auth.test"),
    );
    expect(authCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run only this file**

```bash
bun test "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/packages/gateway/test/unit/connectors/slack-sync.test.ts"
```

Expected: 28 tests, all green (18 prior + 10 new).

- [ ] **Step 3: Lint + commit**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" lint:fix
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add packages/gateway/test/unit/connectors/slack-sync.test.ts
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "test(slack-sync): cover slackWebApi + permalink + slackTryFillTeamSubdomain

10 cases:
- slackWebApi: non-JSON body, array body, HTTP 500-with-ok branch
- slackTryFillTeamSubdomain: happy path (subdomain extracted, permalink
  correct), missing url, non-.slack.com host, malformed URL, empty url,
  non-string url, cursor pre-set teamSubdomain skips auth.test"
```

---

## Task 7: slack-sync — list-phase paths + ratelimit (Group 3)

**Files:**
- Modify: `packages/gateway/test/unit/connectors/slack-sync.test.ts`

Coverage targets:

- `slackCollectMemberChannelIds`: chans not array (covered by ratelimit error already), entry not record, entry without id, entry with id but `is_member: false`, entry with empty id, happy path.
- `slackAdvanceListPhase`: `ratelimited` error -> penalise + throw, non-ratelimited error -> throw, next_cursor non-empty -> "return" branch, next_cursor empty -> "done_list" + ids uniquification/sort, empty channels -> done_list with hasMore:false.

- [ ] **Step 1: Append the describe block**

```typescript
describe("slack-sync — list phase", () => {
  test("happy path: non-empty next_cursor returns 'return' with hasMore=true", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [
        { id: "C1", is_member: true },
        { id: "C2", is_member: false }, // filtered out
        { id: "", is_member: true }, // empty id filtered out
        "not-a-record", // not a record - skipped
        { foo: "no-id" }, // record without id - skipped
      ],
      response_metadata: { next_cursor: "page2" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(true);
    expect(res.itemsUpserted).toBe(0);
    // Cursor carries forward listCursor=page2 and ids=[C1]
    expect(res.cursor).toStartWith("nimbus-slk1:");
  });

  test("ratelimited list error -> throws (covers penalise-branch)", async () => {
    // The `if (error === "ratelimited") { rateLimiter.penalise(...) }` line
    // executes here; line-coverage records it without needing to inspect
    // the limiter's internal bucket state. ProviderRateLimiter has no read
    // accessor and adding one would scope-creep into the 85% sync gate.
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: false,
      error: "ratelimited",
    });
    await expect(
      createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/conversations\.list.*ratelimited/);
  });

  test("non-ratelimited list error -> throws (covers no-penalty branch)", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: false,
      error: "internal_error",
    });
    await expect(
      createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/conversations\.list/);
  });

  test("done_list with non-empty unique sort - transitions to history with hasMore=true", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [
        { id: "C2", is_member: true },
        { id: "C1", is_member: true },
        { id: "C1", is_member: true }, // duplicate -> uniqued
      ],
      response_metadata: { next_cursor: "" },
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });

    let res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(true);
    // Subsequent sync runs history. C1 then C2 in alpha order.
    res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), res.cursor);
    const histCalls = fixture.fetchMock.bodiesFor(
      "POST",
      "https://slack.com/api/conversations.history",
    );
    expect(histCalls).toHaveLength(1);
    expect((histCalls[0] as Record<string, unknown>)["channel"]).toBe("C1");
  });

  test("empty channels -> done_list with hasMore=false", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    expect(res.itemsUpserted).toBe(0);
  });

  test("missing response_metadata -> defaults to empty next_cursor -> done_list", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [{ id: "C1", is_member: true }],
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(true);
  });

  test("listCursor non-empty in cursor is forwarded as cursor param", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "list",
        floorTs: "1.0",
        ids: ["existing"],
        nextIdx: 0,
        hw: {},
        listCursor: "page-N",
        histCursor: null,
        teamSubdomain: null,
      }),
    );
    const bodies = fixture.fetchMock.bodiesFor(
      "POST",
      "https://slack.com/api/conversations.list",
    );
    expect((bodies[0] as Record<string, unknown>)["cursor"]).toBe("page-N");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
bun test "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/packages/gateway/test/unit/connectors/slack-sync.test.ts"
```

Expected: 35 tests, all green (28 prior + 7 new).

- [ ] **Step 3: Lint + commit**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" lint:fix
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add packages/gateway/test/unit/connectors/slack-sync.test.ts
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "test(slack-sync): cover list phase + slackCollectMemberChannelIds

7 cases: happy path with mixed valid/invalid channel entries,
ratelimit penalises + throws, non-ratelimit throws without penalty,
done_list uniquifies + sorts, empty channels, missing response_metadata,
forwarded listCursor on follow-up call."
```

---

## Task 8: slack-sync — history phase + message indexing (Group 4)

**Files:**
- Modify: `packages/gateway/test/unit/connectors/slack-sync.test.ts`

Coverage targets:

- `slackHistoryRequestBody`: histCursor non-empty path, hwVal non-empty path (oldest=hwVal), hwVal null and floorTs path (inclusive:true).
- `slackTryUpsertIndexedHistoryMessage`: missing/empty ts skip, subtype defined non-thread_broadcast skip, subtype=thread_broadcast accepted, non-string text -> preview "", non-string user -> authorId null, empty user -> authorId null, modifiedAt from valid ts vs fallback to now (non-finite ts).
- `slackUpsertHistoryBatch`: messages not array, non-record entries skipped, maxTs update logic (hwVal null vs set).
- `slackRunHistoryPhase`: ratelimited and non-ratelimited error throws, next_cursor non-empty pagination, next_cursor empty advances nextIdx, hasMore true when more channels, hasMore false when exhausted, `state.ids[nextIdx % length] === ""` early return (cursor sets ids=[""] explicitly).

- [ ] **Step 1: Append the describe block**

```typescript
describe("slack-sync — history phase", () => {
  function historyCursor(overrides: Partial<{
    floorTs: string;
    ids: string[];
    nextIdx: number;
    hw: Record<string, string | null>;
    histCursor: string | null;
    teamSubdomain: string | null;
  }>): string {
    return encodeCursor({
      phase: "history",
      floorTs: "1.0",
      ids: ["C1"],
      nextIdx: 0,
      hw: {},
      listCursor: null,
      histCursor: null,
      teamSubdomain: null,
      ...overrides,
    });
  }

  test("ids=[''] (empty channel slot) -> early return with hasMore=false", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({ ids: [""] }),
    );
    expect(res.hasMore).toBe(false);
    // conversations.history NOT called
    const histCalls = fixture.fetchMock.calls.filter((c) => c.url.includes("conversations.history"));
    expect(histCalls).toHaveLength(0);
  });

  test("history ratelimited error -> throws (covers penalise-branch)", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: false,
      error: "ratelimited",
    });
    await expect(
      createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor({})),
    ).rejects.toThrow(/conversations\.history.*ratelimited/);
  });

  test("history non-ratelimited error -> throws (covers no-penalty branch)", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: false,
      error: "boom",
    });
    await expect(
      createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor({})),
    ).rejects.toThrow(/conversations\.history/);
  });

  test("hwVal set -> request body carries oldest=hwVal, no inclusive flag", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({ hw: { C1: "999.0" } }),
    );
    const body = fixture.fetchMock.bodiesFor(
      "POST",
      "https://slack.com/api/conversations.history",
    )[0] as Record<string, unknown>;
    expect(body["oldest"]).toBe("999.0");
    expect(body["inclusive"]).toBeUndefined();
  });

  test("histCursor non-empty -> request body carries cursor, omits oldest", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({ histCursor: "next-hist-page" }),
    );
    const body = fixture.fetchMock.bodiesFor(
      "POST",
      "https://slack.com/api/conversations.history",
    )[0] as Record<string, unknown>;
    expect(body["cursor"]).toBe("next-hist-page");
    expect(body["oldest"]).toBeUndefined();
  });

  test("paginated history -> next_cursor non-empty returns hasMore=true with same channel", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [{ ts: "100.000010", text: "m1", user: "U1" }],
      response_metadata: { next_cursor: "hist-page-2" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({}),
    );
    expect(res.hasMore).toBe(true);
    expect(res.itemsUpserted).toBe(1);
  });

  test("end of history -> advances nextIdx, hasMore depends on remaining channels", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [{ ts: "200.000020", text: "m2", user: "U2" }],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({ ids: ["C1", "C2"], nextIdx: 0 }),
    );
    expect(res.hasMore).toBe(true); // C2 still pending
    expect(res.itemsUpserted).toBe(1);
  });

  test("last channel exhausted -> hasMore=false", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({ ids: ["C1"], nextIdx: 0 }),
    );
    expect(res.hasMore).toBe(false);
  });
});

describe("slack-sync — message indexing skip paths", () => {
  function stageHistory(messages: unknown[]): void {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages,
      response_metadata: { next_cursor: "" },
    });
  }
  function historyCursor(): string {
    return encodeCursor({
      phase: "history",
      floorTs: "1.0",
      ids: ["C1"],
      nextIdx: 0,
      hw: {},
      listCursor: null,
      histCursor: null,
      teamSubdomain: null,
    });
  }

  test("messages not an array -> 0 upserts", async () => {
    stageHistory("not-array" as unknown as unknown[]);
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor(),
    );
    expect(res.itemsUpserted).toBe(0);
  });

  test("non-record array entries skipped", async () => {
    stageHistory(["string-entry", 42, null]);
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor(),
    );
    expect(res.itemsUpserted).toBe(0);
  });

  test("ts missing or empty skipped", async () => {
    stageHistory([
      { text: "no ts", user: "U1" },
      { ts: "", text: "empty ts", user: "U1" },
    ]);
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor(),
    );
    expect(res.itemsUpserted).toBe(0);
  });

  test("subtype other than thread_broadcast skipped", async () => {
    stageHistory([
      { ts: "100.0", text: "join", user: "U1", subtype: "channel_join" },
    ]);
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor(),
    );
    expect(res.itemsUpserted).toBe(0);
  });

  test("subtype=thread_broadcast indexed", async () => {
    stageHistory([
      { ts: "100.0", text: "broadcast", user: "U1", subtype: "thread_broadcast" },
    ]);
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor(),
    );
    expect(res.itemsUpserted).toBe(1);
  });

  test("non-string text -> preview empty, title is '(no text)'", async () => {
    stageHistory([{ ts: "100.0", text: 42, user: "U1" }]);
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const row = fixture.db
      .query<{ title: string; body_preview: string | null }, []>(
        "SELECT title, body_preview FROM item WHERE service = 'slack' LIMIT 1",
      )
      .get();
    expect(row?.body_preview).toBe("");
    expect(row?.title).toBe("(no text)");
  });

  test("non-string user -> authorId null", async () => {
    stageHistory([{ ts: "100.0", text: "hi", user: 42 }]);
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const row = fixture.db
      .query<{ author_id: string | null }, []>(
        "SELECT author_id FROM item WHERE service = 'slack' LIMIT 1",
      )
      .get();
    expect(row?.author_id).toBeNull();
  });

  test("empty user string -> authorId null", async () => {
    stageHistory([{ ts: "100.0", text: "hi", user: "" }]);
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const row = fixture.db
      .query<{ author_id: string | null }, []>(
        "SELECT author_id FROM item WHERE service = 'slack' LIMIT 1",
      )
      .get();
    expect(row?.author_id).toBeNull();
  });

  test("non-finite ts number -> modifiedAt falls back to now", async () => {
    // ts="abc" -> parseFloat -> NaN -> non-finite -> modifiedAt=now
    stageHistory([{ ts: "abc", text: "hi", user: "U1" }]);
    const beforeMs = Date.now();
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const afterMs = Date.now();
    const row = fixture.db
      .query<{ modified_at: number }, []>(
        "SELECT modified_at FROM item WHERE service = 'slack' LIMIT 1",
      )
      .get();
    expect(row?.modified_at).toBeGreaterThanOrEqual(beforeMs);
    expect(row?.modified_at).toBeLessThanOrEqual(afterMs);
  });

  test("thread_ts string preserved in metadata; non-string -> null", async () => {
    stageHistory([
      { ts: "100.0", text: "in-thread", user: "U1", thread_ts: "99.0" },
      { ts: "101.0", text: "no-thread", user: "U1", thread_ts: 42 },
    ]);
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const rows = fixture.db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM item WHERE service = 'slack' ORDER BY external_id",
      )
      .all();
    expect(rows).toHaveLength(2);
    const meta0 = JSON.parse(rows[0].metadata) as Record<string, unknown>;
    const meta1 = JSON.parse(rows[1].metadata) as Record<string, unknown>;
    expect(meta0["thread_ts"]).toBe("99.0");
    expect(meta1["thread_ts"]).toBeNull();
  });

  test("title sliced to 512 chars on very long messages", async () => {
    const long = "x".repeat(1024);
    stageHistory([{ ts: "100.0", text: long, user: "U1" }]);
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const row = fixture.db
      .query<{ title: string; body_preview: string | null }, []>(
        "SELECT title, body_preview FROM item WHERE service = 'slack' LIMIT 1",
      )
      .get();
    expect(row?.title.length).toBeLessThanOrEqual(512);
    expect(row?.body_preview?.length).toBe(512); // preview clipped at 512 too
  });

  test("maxTs updated across batch -> stored as hwVal in next cursor", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [
        { ts: "100.0", text: "earlier", user: "U1" },
        { ts: "200.0", text: "later", user: "U1" },
        { ts: "150.0", text: "middle", user: "U1" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "history",
        floorTs: "1.0",
        ids: ["C1"],
        nextIdx: 0,
        hw: {},
        listCursor: null,
        histCursor: null,
        teamSubdomain: null,
      }),
    );
    expect(res.itemsUpserted).toBe(3);
    // Decode the returned cursor and verify hw.C1 == "200.0"
    const raw = res.cursor!.slice("nimbus-slk1:".length);
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      hw: Record<string, string | null>;
    };
    expect(decoded.hw["C1"]).toBe("200.0");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
bun test "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/packages/gateway/test/unit/connectors/slack-sync.test.ts"
```

Expected: 55 tests, all green (35 prior + 20 new).

- [ ] **Step 3: Lint + commit**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" lint:fix
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add packages/gateway/test/unit/connectors/slack-sync.test.ts
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "test(slack-sync): cover history phase + message indexing

20 cases: empty channel slot early return, history ratelimit + non-rl
errors, hwVal vs histCursor vs floorTs body shapes, paginated history,
end-of-channel advancement, skip paths (non-array messages, non-record
entries, missing/empty ts, non-thread-broadcast subtypes), thread_broadcast
accepted, non-string text/user, non-finite ts -> now, thread_ts metadata,
title truncation at 512, maxTs updated across batch."
```

---

## Task 9: Run the local pre-flight, fix any TS/lint surprises

**Files:** none (verification step).

- [ ] **Step 1: Typecheck the whole workspace**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" typecheck
```

Expected: clean. If errors mention the new helpers or test file, fix them in a fresh commit before continuing (`fix(coverage-floor): TS strict on slack-sync test`).

- [ ] **Step 2: Lint**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" lint
```

Expected: clean.

- [ ] **Step 3: Full gateway unit suite**

```bash
bun test --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" packages/gateway/test/unit/
```

Expected: green. Watch for any test that imported the old `mock-mcp-client.ts` path — none should exist in `origin/main`, but a stale import would surface here.

- [ ] **Step 4: Slack-sync targeted coverage check (Windows local; treat as informational)**

```bash
bun test --coverage --coverage-reporter=lcov --coverage-dir="c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/coverage-local" "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/packages/gateway/test/unit/connectors/slack-sync.test.ts"
grep -A2 "connectors/slack-sync.ts" "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/coverage-local/lcov.info" | head -10
```

Expected: lcov reports slack-sync.ts at well above 80 %. Local Windows lcov is not authoritative — the CI Linux artifact is. But if local is below 80 %, more tests are needed before pushing.

If local coverage is low, inspect the `LF`/`LH` (lines-found / lines-hit) and the `BRDA` entries to identify missed lines, then add a follow-up commit covering them.

- [ ] **Step 5: No commit at this step** (verification only). If fixes were needed, they went into named follow-up commits above.

---

## Task 10: Remove slack-sync from the coverage baseline

**Files:**
- Modify: `docs/structure-audit/coverage-baseline.json`

The baseline currently records `slack-sync.ts` at `min_coverage_pct: 4.35`. Per spec rule 4 — "when a baseline file's actual coverage reaches ≥80%, it must be *removed* from the baseline in the same PR" — we drop the entry.

Side-effect removals (other files that crossed 80 % because the harness exercised them via `LocalIndex.ensureSchema` + `upsertIndexedItemForSync` + `resolvePersonForSync`) are NOT predictable from Windows lcov; we set them up to be discovered from CI Linux.

- [ ] **Step 1: Remove the slack-sync entry**

```bash
grep -n "slack-sync" "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/docs/structure-audit/coverage-baseline.json"
```

Expected: one line with the path key. Delete the 3-line object (the key line, the `min_coverage_pct` line, the closing `}` line, plus the trailing comma on the preceding `}` if this entry is not the last).

Open the file in the editor and remove:

```json
    "packages/gateway/src/connectors/slack-sync.ts": {
      "min_coverage_pct": 4.35
    },
```

- [ ] **Step 2: Verify the JSON parses**

```bash
bun -e "JSON.parse(require('fs').readFileSync('c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/docs/structure-audit/coverage-baseline.json','utf8')); console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add docs/structure-audit/coverage-baseline.json
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "chore(coverage-floor): drop slack-sync from baseline (≥80% per Phase 2A)"
```

---

## Task 11: Update CLAUDE.md and GEMINI.md status lines

**Files:**
- Modify: `CLAUDE.md` (one phase-status row)
- Modify: `GEMINI.md` (mirror)

- [ ] **Step 1: Inspect the current Phase 5 status line**

```bash
grep -n "Coverage floor Phase 1A" "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/CLAUDE.md"
```

Expected: one line on the Phase 5 status row, e.g. `· Coverage floor Phase 1A ✅ (2026-05-17) ·`.

- [ ] **Step 2: Append Phase 2A status to the same row**

Edit `CLAUDE.md`: find the line containing `Coverage floor Phase 1A ✅ (2026-05-17)` and append immediately after it:

```text
· Coverage floor Phase 2A ✅ (2026-05-18)
```

Make the SAME change in `GEMINI.md`.

- [ ] **Step 3: Verify both files now contain the new marker**

```bash
grep "Coverage floor Phase 2A" "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/CLAUDE.md" "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/GEMINI.md"
```

Expected: two lines, one from each file.

- [ ] **Step 4: Commit**

```bash
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add CLAUDE.md GEMINI.md
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "docs(coverage-floor): mark Phase 2A delivered in Phase 5 status"
```

---

## Task 12: Push, open PR, commit plan in the final commit, watch CI

**Files:**
- Add: `docs/superpowers/plans/2026-05-18-coverage-floor-phase-2a.md` (this plan)

- [ ] **Step 1: Final lint pass**

```bash
bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" lint:fix
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" diff --stat
```

Expected: no diff if everything is already clean. If lint:fix made changes, commit them:

```bash
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add -u
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "chore: Biome formatting"
```

- [ ] **Step 2: Copy the plan file into the worktree and commit**

```bash
mkdir -p "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/docs/superpowers/plans"
cp "c:/gitrep/Nimbus/docs/superpowers/plans/2026-05-18-coverage-floor-phase-2a.md" \
   "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/docs/superpowers/plans/"
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add docs/superpowers/plans/2026-05-18-coverage-floor-phase-2a.md
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "docs(coverage-floor): commit Phase 2A implementation plan"
```

- [ ] **Step 3: Push**

```bash
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" push -u origin dev/asafgolombek/coverage-floor-phase-2a-2026-05-18
```

- [ ] **Step 4: Open the PR**

The PR body is written to a temp file and passed via `--body-file`. This avoids shell-specific heredoc syntax — works in both PowerShell and Bash, agnostic to which tool the executing agent uses.

Write the body file using the **Write** tool (not a shell command):

- **Target path:** `c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/.pr-body.tmp`
- **Content:**

```markdown
## Summary

- New shared test harness `packages/gateway/test/helpers/connector-sync-harness.ts` providing `{ db, vault, fetchMock, notifications, logger, rateLimiter, createSyncContext, cleanup }`. Reusable across all 17 `*-sync.ts` files (slack today, ~22 more in 2B/2C).
- Drop the spec's `MockMcpClient` for now: every sync handler uses raw `fetch()`, none calls `mcp.callTool`. Replaced with `MockFetch` keyed by `(method, URL pattern, body matcher)` with a call log and `install()` / `restore()` lifecycle on `globalThis.fetch`.
- Apply the harness to `slack-sync.ts`: 55 test cases covering cursor decode failures, `slackWebApi` error shapes, `slackTryFillTeamSubdomain`, list and history phase paths, ratelimit-error throw paths, message-index skip paths, and end-to-end DB assertions on indexed rows.
- Remove `slack-sync.ts` from `docs/structure-audit/coverage-baseline.json` (was 4.35 %; now ≥80 % on CI Linux lcov).

## Coverage move

`slack-sync.ts` — 4.35 % → ≥ 80 % (entry removed from baseline; PR-blocking gate enforces ≥ 80 % going forward).

Any side-effect file that also crossed 80 % from harness usage will be removed in a follow-up commit after CI Linux lcov publishes the numbers.

## Test plan

- [x] `bun run typecheck` clean
- [x] `bun run lint` clean
- [x] `bun test packages/gateway/test/unit/connectors/slack-sync.test.ts` — 55 tests green locally (Windows)
- [ ] CI Linux per-file coverage gate (`coverage-floor` job) passes
- [ ] CI 3-OS matrix passes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Then create and delete the PR using shell commands that work cross-shell:

```bash
gh pr create --repo nimbus-agent/nimbus --base main --head dev/asafgolombek/coverage-floor-phase-2a-2026-05-18 \
  --title "test(coverage-floor): Phase 2A — connector-sync harness + slack-sync" \
  --body-file "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/.pr-body.tmp"
```

Then remove the temp file using the appropriate tool for the active shell (PowerShell: `Remove-Item`; Bash: `rm`). The file MUST be removed before the next commit because it is not gitignored:

```bash
# Bash:
rm "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/.pr-body.tmp"
```

```powershell
# PowerShell:
Remove-Item "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/.pr-body.tmp"
```

Expected: the PR URL is printed by `gh pr create`; the temp file is gone.

- [ ] **Step 5: Watch the first CI run**

```bash
gh pr checks --watch
```

Watch for failures of these specific gates:

| Failure | Cause | Fix |
|---|---|---|
| `coverage-floor` red with "slack-sync.ts must be ≥80%" | Local lcov over-reported; some branches uncovered on Linux | Read the CI lcov artifact, add tests for the missed lines, rerun |
| `coverage-floor` red with "X.ts is not in baseline but is at Y%" | A side-effect file that we didn't write tests for fell below 80 % in lcov (the harness's `LocalIndex.ensureSchema` may have pulled an untested helper into the lcov report at sub-80 %) | Either add the file to the baseline at its current value, or delete the unused import that pulled it in |
| `coverage-floor` red with "X.ts is in baseline but actually at Y%" (Y > stored) | Side-effect win — a baseline file crossed its watermark. Per rule 3, bump it. Per rule 4, remove if ≥80 % | Run `bun run audit:coverage-floor:update-baseline` on the CI artifact (or edit by hand) and commit |
| Biome lint failure | Local `lint:fix` missed a file (rare with `bun run lint:fix`) | Re-run `bun run lint:fix`, commit |
| `audit:openapi-drift` red | Should not fire — no OpenAPI changes here | Investigate; PR shouldn't touch this |
| gitleaks red | A fixture identifier resembles a credential token | Rename the identifier per the carry-forward rule |

- [ ] **Step 6: If side-effect baseline edits are needed**

Pull the CI lcov artifact:

```bash
gh run download <run-id> --name lcov-linux --dir "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/ci-lcov"
```

Then run the update step against the Linux lcov:

```bash
COVERAGE_LCOV_PATH="c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18/ci-lcov/lcov.info" \
  bun run --cwd "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" audit:coverage-floor:update-baseline
```

(If the update script doesn't accept an env override, edit `coverage-baseline.json` by hand from the CI failure output.)

Commit the baseline correction:

```bash
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" add docs/structure-audit/coverage-baseline.json
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" commit -m "chore(coverage-floor): align baseline with CI Linux lcov (Phase 2A side-effects)"
git -C "c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-2a-2026-05-18" push
```

- [ ] **Step 7: Loop until CI green** (typical Phase 1A pattern: one or two baseline correction commits, then green).

---

## Spec Coverage Self-Review

Mapping spec sections to tasks:

| Spec section | Where in plan |
|---|---|
| "Test Harnesses (Phase 2 + 3 backbone)" — `connector-sync-harness.ts` shape | Task 4 (with the documented option-1 deviation: `fetchMock` in place of `mcp`) |
| "Phase 2A: Build connector-sync-harness.ts. Apply it to slack-sync.ts end-to-end" | Tasks 2–8 |
| "Both harnesses live in test/helpers/ (not in src/)" | Task 4 location |
| Ratchet rule 4 — "When a baseline file's actual coverage reaches ≥80%, it must be removed from the baseline in the same PR" | Task 10 |
| Ratchet rule 3 — partial improvements update baseline upward | Task 12 step 6 (CI feedback loop for side-effect files) |
| Pre-flight `bun run lint:fix` carry-forward | Tasks 2, 3, 4, 5, 6, 7, 8, 12 step 1 |
| Plan committed in final commit | Task 12 step 2 |
| CLAUDE.md + GEMINI.md status line | Task 11 |
| Branch from main AFTER PR #338 merges | Task 1 (verified merged before drafting) |
| `git -C <abs-path>`, absolute paths | every Bash step |

## Placeholder Scan

- All test code is shown in full. No "TBD" / "similar to above" / "implement the rest".
- Side-effect baseline rule has a concrete procedure (Task 12 step 6), not "deal with it later".
- Type names and harness field names match across Tasks 4, 5, 6, 7, 8 (`fixture.fetchMock`, `fixture.createSyncContext()`, `fixture.rateLimiter.snapshot("slack")`, `fixture.db.query(...)`).

## Type Consistency

- `MockFetch.respond(method, url, jsonOrString, opts?)` — used identically in Tasks 5, 6, 7, 8.
- `MockFetch.respondWithText` — only Task 6 uses it; signature documented.
- `MockFetch.bodiesFor(method, urlPattern)` — used in Tasks 5, 6, 7, 8.
- `ConnectorSyncFixture.createSyncContext()` — used everywhere as `fixture.createSyncContext()`.
- Ratelimit-branch tests in Tasks 7 and 8 assert on the thrown error message only — they do NOT inspect `ProviderRateLimiter` state. `ProviderRateLimiter` exposes no read accessor for `penaltyUntilMs` (private on `BucketState`); adding one would scope-creep into the 85 % rate-limiter coverage gate. Line coverage records the `if (error === "ratelimited") { rateLimiter.penalise(...) }` branch from the executing test alone — no internal-state assertion needed.

## Review Resolutions (2026-05-18 review pass)

1. **PowerShell heredoc:** Fixed in Task 12 step 4. PR body now goes through a temp file + `--body-file`; cross-shell.
2. **`MockFetch` `Request` handling:** Fixed in Task 2. URL extraction explicitly handles `string | URL | Request` (Request's `toString()` returns `"[object Request]"` which silently broke matchers).
3. **Global Harness vs Local Stubbing:** Confirmed intentional. Standardising `MockFetch` on the fixture is the right shape for the ~22 sync handlers in Phase 2B/2C.
4. **`ProviderRateLimiter.snapshot`:** Removed the dependency. Tests now assert on thrown error messages only; coverage of the `penalise` line comes from line execution, not from observed state changes.
5. **Synchronous fixture cleanup:** Kept as designed — `await fixture.vault.set(...)` in test setup, sync factory, sync cleanup.
