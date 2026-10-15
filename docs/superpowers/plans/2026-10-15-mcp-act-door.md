# MCP act door (S3 capture sink PR 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MCP agent PROPOSE a connector action (post a Slack message, open a Jira issue, send an email…) that runs only after the owner accepts it with `nimbus captures accept` and answers the ordinary executor HITL prompt.

**Architecture:** `action` becomes a fifth kind in the existing `capture` table and I28 gate (schema V69). Proposability and tool routing live in a new gateway-owned table, `connectors/proposable-actions.ts`, and reach `mcp-sink/` only as injected functions. Accept runs `mcp-sink/capture-act.ts`'s `acceptAction()`: an atomic claim, then a per-call `ToolExecutor` built in `ipc/capture-rpc.ts` with the accepting session's consent channel, no delegate, the real egress sink and the policy overlay. Each action ends in exactly one terminal state and is never retried.

**Tech Stack:** Bun 1.4, TypeScript 7 strict, `bun:sqlite`, `bun:test`, zod (CLI MCP tools), Biome.

**Spec:** `docs/superpowers/specs/2026-10-15-mcp-act-door-design.md` (rev 2, owner-approved 2026-10-15). Read it beside this plan; section numbers below (§ n) are the spec's.

## Global Constraints

- Branch `dev/asaf/s3-act-door`, worktree `C:/gitrep/Nimbus/.claude/worktrees/s3-act-door`. Run `git rev-parse --abbrev-ref HEAD` before EVERY commit; never commit on `main`.
- No `any`; external data is `unknown`. TypeScript strict.
- Commit hooks run — never `--no-verify`. Use `git commit -F <file>` for multi-line messages.
- SQLite writes only through `dbRun`/`dbExec`/`dbStmtRun` (I14/D12). The `capture` table is named at runtime only by `mcp-sink/capture-store.ts` (D32(a)); the new DDL file joins the allow-list.
- `mcp-sink/` non-test files import neither `engine/executor.ts` nor anything under `connectors/`, not even type-only imports (D32(f), new in Task 12). `engine/service-of.ts` is allowed.
- `[mcp_sink]` defaults: `kinds = ["note","decision","term","link"]` (no `action`); `action_ttl_hours = 24` (1..168); `action_max_pending = 10` (1..100). Out of range REFUSES loudly, never clamps.
- New AI_V2 policy name `mcp_action` (the NINTH). `actionEnabled = sink enabled ∧ "action" ∈ kinds ∧ ¬locked(mcp_capture) ∧ ¬locked(mcp_action)`, fail-closed on an absent policy accessor.
- `CURRENT_SCHEMA_VERSION` 68 → 69.
- New refusal codes: `ERR_CAPTURE_ACTION_NOT_PROPOSABLE`, `ERR_CAPTURE_CONNECTOR_UNCONFIGURED`, `ERR_CAPTURE_EXPIRED`. Stored codes (never thrown): `ERR_ACTION_TIMEOUT`, `ERR_ACTION_TOOL_NOT_FOUND`, `ERR_ACTION_DISPATCH`, `ERR_ACTION_INTERRUPTED`.
- Audit rows `capture.action.accept` / `capture.action.outcome` / `capture.action.expire` are always `hitlStatus: "not_required"`. `approved` is written only by `ToolExecutor.gate()`.
- No change to `engine/executor.ts`, `connectors/registry.ts` or `connectors/lazy-mesh/tool-map.ts`.
- PR title: `feat(mcp): act door — agent-proposed connector actions, owner-accepted (S3, I28)`. No `!` (default off twice).
- Specs and plans never land on `main`: Task 15 deletes both files from the branch before the PR is opened.
- After code changes run `bun run preflight:fast` from the worktree root; run the touched test files directly (`bun test <path>`).

## Review Focus

These five inputs follow from the spec but no spec test names them. Each has its pinning test in the owning task.

1. **The agent puts terminal-control or Trojan-Source characters inside an `input` value** (ESC sequences, U+202E, zero-width spaces, U+2028). The input is sent verbatim and cannot be stripped, so the prompt must render those characters VISIBLY (`\u202e`) rather than letting them rewrite what the owner reads. → Task 7 (`formatActionConsent` escapes invisibles), test "an RLO inside an input value is shown escaped".
2. **The clock lands exactly on `expires_at`.** `now === expires_at` counts as expired at accept, in the claim CAS, and in `countPendingActions`. → Task 2 (store boundary test) and Task 7 (accept boundary test).
3. **Org policy flips to lock `mcp_action` after a proposal was queued.** Accept refuses `ERR_CAPTURE_DISABLED`, the row stays `proposed` and later expires, and `reject` still works. → Task 7, test "a mcp_action lock after submit freezes accept; reject still works".
4. **The owner pipes input into accept** (`yes | nimbus captures accept cap_…`) or runs it from a script. Only stdin is not a TTY there. The CLI must refuse before connecting for the accept, and must not auto-approve. → Task 13, test "stdin piped, stdout a TTY: refuses".
5. **The gateway restarts while the consent prompt is open.** The row is `executing` on disk and must become `failed`/`ERR_ACTION_INTERRUPTED` at boot, never `proposed` again. → Task 7 (`reconcileActionsAtBoot` unit) and Task 11 (flow integration).

## File map

| file | change | responsibility |
|---|---|---|
| `packages/gateway/src/mcp-sink/capture-types.ts` | modify | kinds, states, codes, `ActionPayload`, `ActionVerdict`, `ActDeps`, `ActionProvenance`, row fields |
| `packages/gateway/src/config/mcp-sink-toml.ts` | modify | `action_ttl_hours`, `action_max_pending`, default kinds exclude `action` |
| `packages/gateway/src/policy/types.ts` | modify | `mcp_action` |
| `packages/gateway/src/mcp-sink/capture-capability.ts` | modify | `actionEnabled` |
| `packages/gateway/src/index/capture-action-v69-sql.ts` | create | V69 rebuild |
| `packages/gateway/src/index/migrations/runner.ts`, `index/local-index.ts` | modify | V69 step, version 69 |
| `packages/gateway/src/mcp-sink/capture-store.ts` | modify | new columns + action queries |
| `packages/gateway/src/connectors/proposable-actions.ts` | create | classification table, routing table, `classifyActionType`, `proposableWriteTool`, `listProposableActionTypes` |
| `packages/gateway/src/connectors/testing/connector-write-registrations.ts` | modify | record each registration's call span |
| `packages/gateway/src/connectors/testing/registration-mutates.ts` | create | resolve a registration's `mutates` value |
| `packages/gateway/src/mcp-sink/capture-validate.ts` | modify | `validateActionPayload` |
| `packages/gateway/src/mcp-sink/capture-native.ts` | modify | narrow to `NativeValidatedCapture`; `action` arms |
| `packages/gateway/src/mcp-sink/capture-gate.ts` | modify | async submit, action steps 5a/5b/8, lazy expiry, `captureStateFor`, status fields, accept branch, revoke refusal |
| `packages/gateway/src/mcp-sink/capture-act.ts` | create | `acceptAction`, `formatActionConsent`, `outcomeRefOf`, `classifyActionError`, `expireDueActionsAudited`, `reconcileActionsAtBoot` |
| `packages/gateway/src/ipc/capture-rpc.ts` | modify | `CaptureActWiring`, `buildActDeps`, `capture.state`, consent param |
| `packages/gateway/src/ipc/server/dispatchers.ts` | modify | pass `ctx.consentImpl` |
| `packages/gateway/src/platform/assemble.ts` | modify | wire classify/configured/list/act + boot reconcile |
| `scripts/structure-audit/check-nimbus-invariants.ts` (+ test) | modify | D32(a) allow-list, D32(e)(f)(g) |
| `packages/gateway/src/security-invariants.test.ts` | modify | I28 row |
| `packages/cli/src/mcp/capture-tools.ts` (+ test) | modify | `propose_action`, `capture_status` |
| `packages/cli/src/commands/captures.ts`, `captures-format.ts` (+ tests) | modify | TTY guard, result branches, action list/show, doctor line |
| `packages/gateway/test/integration/mcp-sink/capture-action-routing.test.ts` | create | real dispatcher routing |
| `packages/gateway/test/integration/mcp-sink/capture-action-flow.test.ts` | create | real executor + egress flow |
| `packages/gateway/test/e2e/user-mcp.e2e.test.ts` | modify | act-door E2E over a real gateway + real user MCP |
| docs (7 files) | modify | Task 15 |

**Stated deviations from the spec, decided here:**
- **V69 migration test location.** The spec puts it under `test/integration/mcp-sink/`. This plan puts it in `index/migrations/runner-v69.test.ts`, following the repo's `runner-vNN.test.ts` convention. It is still real SQLite.
- **`expireDueActions` runs as a `SELECT` of ids, then one guarded `UPDATE` with the same predicate.** The spec says one `UPDATE … RETURNING`. Both statements run inside the caller's transaction. The change is needed because `RETURNING` would require `db.query(...).all()` on a write, which D12 (writes only through `dbRun`) does not allow.
- **`proposableActionTypes` lists each `--model` server as `mcp_<id>.*`, not one entry per tool.** Enumerating tools would spawn every `--model` server on each `capture.status` call. Classification is still exact per type at submit.
- **The E2E extends `test/e2e/user-mcp.e2e.test.ts`** rather than adding a new file. That harness already builds and sandboxes a real user MCP binary and answers `consent.request`. The agent side is a second raw IPC client that declares `kind: "mcp"`. The stdio `nimbus mcp-server` transport is already proven by `mcp-capture.e2e.test.ts`; the new MCP tools are unit-tested in Task 13.
- **`CaptureStatus` gains one field the spec did not list: `actionExpiringWithinHour`.** The doctor line in spec § 11 needs that number.
- **Correction to spec § 6 and § 8 found while planning: a user-MCP action DOES carry an `mcpToolId`.** The spec says the act door sets none and the dispatcher "derives the key from the type". The dispatcher does not do that. With no `mcpToolId` it resolves `action.type` itself (`mcp_x.tool`), and its I42 pairing check refuses that with `ERR_USER_MCP_ACTION_MISMATCH`. `connector.userMcpCall` passes `mcpToolId = "<serviceId>_<tool>"`, and so does the act door: `userMcpToolKeyForActionType(type)`. That key is still gateway-derived from the type and never agent-supplied. `proposableWriteTool` keeps returning `undefined` for user-MCP types, and `buildActDeps` falls back to the derived key. Tasks 8 and 10 test this.

## † routing rows (spec § 6.1 rule) — resolved against `@nimbus-dev/connectors@0.2.4`

All four † types are routable, so the proposable count stays at 30:

| type | tool id | how 0.2.4 registers it |
|---|---|---|
| `teams.message.postChat` | `teams_message_post_chat` | literal `mutates: "teams.message.postChat"` (`connectors/teams/src/tools.ts`) |
| `imap.mail.send` | `imap_mail_send` | kit `shared/imap-tool-kit.ts`: id `` `${toolPrefix}_mail_send` ``, `mutates: `` `${toolPrefix}.mail.send` `` |
| `protonmail.mail.send` | `protonmail_mail_send` | same kit |
| `apple.mail.send` | `apple_mail_send` | same kit |

Task 4's sync test enforces this. If it cannot resolve one of these rows, the type moves to `unroutable` in Task 3's table, both tests are updated, and the change is recorded in the PR body.

---

### Task 1: Vocabulary, config and capability

**Files:**
- Modify: `packages/gateway/src/mcp-sink/capture-types.ts`
- Modify: `packages/gateway/src/config/mcp-sink-toml.ts`
- Modify: `packages/gateway/src/policy/types.ts`
- Modify: `packages/gateway/src/mcp-sink/capture-capability.ts`
- Test: `packages/gateway/src/config/mcp-sink-toml.test.ts`, `packages/gateway/src/mcp-sink/capture-capability.test.ts`, `packages/gateway/src/policy/types.test.ts`

**Interfaces:**
- Produces (capture-types.ts):
  - `CAPTURE_KINDS = ["note","decision","term","link","action"] as const`
  - `DEFAULT_CAPTURE_KINDS = ["note","decision","term","link"] as const`
  - `type NativeCaptureKind = Exclude<CaptureKind, "action">`
  - `CAPTURE_STATES` += `"executing","executed","failed","expired"`
  - `ACTION_ERROR_CODES` / `type ActionErrorCode`
  - `interface ActionPayload { actionType: string; input: Readonly<Record<string, unknown>>; summary: string }`
  - `ValidatedCapture` += `{ kind: "action"; payload: ActionPayload }`
  - `type NativeValidatedCapture = Exclude<ValidatedCapture, { kind: "action" }>`
  - `CaptureRow` += `expiresAt: number | null; outcomeRef: string | null; errorCode: string | null`
  - `type ActionVerdict`
  - `interface ActionProvenance`
  - `interface ActDeps`
  - `type ActExecuteOutcome`
- Produces (config): `NimbusMcpSinkToml` += `actionTtlHours: number; actionMaxPending: number`
- Produces (capability): `MCP_ACTION_CAPABILITY`; `CaptureCapability` += `readonly actionEnabled: boolean` on both arms.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/config/mcp-sink-toml.test.ts`. Write the branch tests up front; the per-file floor is 80% of branches.

```ts
describe("[mcp_sink] act door keys (PR 3)", () => {
  test("default kinds do NOT include action; TTL 24, max pending 10", () => {
    const c = parseNimbusTomlMcpSink("[mcp_sink]\nenabled = true\n");
    expect(c.kinds).toEqual(["note", "decision", "term", "link"]);
    expect(c.actionTtlHours).toBe(24);
    expect(c.actionMaxPending).toBe(10);
  });
  test("action is accepted when listed explicitly", () => {
    const c = parseNimbusTomlMcpSink('[mcp_sink]\nkinds = ["note", "action"]\n');
    expect(c.kinds).toEqual(["note", "action"]);
  });
  test.each([
    ["action_ttl_hours", "0"],
    ["action_ttl_hours", "169"],
    ["action_ttl_hours", "x"],
    ["action_max_pending", "0"],
    ["action_max_pending", "101"],
  ])("%s = %s refuses loudly", (key, val) => {
    expect(() => parseNimbusTomlMcpSink(`[mcp_sink]\n${key} = ${val}\n`)).toThrow(
      McpSinkConfigError,
    );
  });
  test("in-range values are read", () => {
    const c = parseNimbusTomlMcpSink("[mcp_sink]\naction_ttl_hours = 168\naction_max_pending = 1\n");
    expect(c.actionTtlHours).toBe(168);
    expect(c.actionMaxPending).toBe(1);
  });
});
```

Append to `packages/gateway/src/mcp-sink/capture-capability.test.ts`:

```ts
describe("actionEnabled (PR 3)", () => {
  const base = { ...DEFAULT_MCP_SINK_CONFIG, enabled: true };
  const open = { capabilitiesDisabled: new Set<string>() };
  test("off when action is not in kinds", () => {
    expect(resolveCaptureCapability({ ok: true, config: base }, open).actionEnabled).toBe(false);
  });
  test("on when the sink is on and action is listed", () => {
    const c = resolveCaptureCapability(
      { ok: true, config: { ...base, kinds: ["note", "action"] } },
      open,
    );
    expect(c.enabled).toBe(true);
    expect(c.actionEnabled).toBe(true);
  });
  test("mcp_action lock-off disables actions only", () => {
    const c = resolveCaptureCapability(
      { ok: true, config: { ...base, kinds: ["note", "action"] } },
      { capabilitiesDisabled: new Set(["mcp_action"]) },
    );
    expect(c.enabled).toBe(true);
    expect(c.actionEnabled).toBe(false);
  });
  test("mcp_capture lock-off disables both", () => {
    const c = resolveCaptureCapability(
      { ok: true, config: { ...base, kinds: ["action"] } },
      { capabilitiesDisabled: new Set(["mcp_capture"]) },
    );
    expect(c.enabled).toBe(false);
    expect(c.actionEnabled).toBe(false);
  });
  test("absent policy accessor: actionEnabled false (fail-closed)", () => {
    expect(
      resolveCaptureCapability({ ok: true, config: { ...base, kinds: ["action"] } }, undefined)
        .actionEnabled,
    ).toBe(false);
  });
  test("sink off by config: actionEnabled false", () => {
    expect(
      resolveCaptureCapability(
        { ok: true, config: { ...base, enabled: false, kinds: ["action"] } },
        open,
      ).actionEnabled,
    ).toBe(false);
  });
});
```

Append to `packages/gateway/src/policy/types.test.ts`:

```ts
test("mcp_action is the ninth lockoff-able ai_v2 capability", () => {
  expect([...AI_V2_CAPABILITIES]).toContain("mcp_action");
  expect(AI_V2_CAPABILITIES).toHaveLength(9);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/config/mcp-sink-toml.test.ts packages/gateway/src/mcp-sink/capture-capability.test.ts packages/gateway/src/policy/types.test.ts`
Expected: FAIL (`actionTtlHours` undefined, `actionEnabled` undefined, `mcp_action` missing).

- [ ] **Step 3: Implement**

`capture-types.ts`: replace the kinds/states block and add the new types. Keep `SUBMITTABLE_KINDS` as all five.

```ts
export const CAPTURE_KINDS = ["note", "decision", "term", "link", "action"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
export type NativeCaptureKind = Exclude<CaptureKind, "action">;

/** What `[mcp_sink] kinds` defaults to: enabling the sink never enables the act door (spec § 5). */
export const DEFAULT_CAPTURE_KINDS = ["note", "decision", "term", "link"] as const;

export const SUBMITTABLE_KINDS: ReadonlySet<CaptureKind> = new Set<CaptureKind>(CAPTURE_KINDS);

export const CAPTURE_STATES = [
  "live", "proposed", "accepted", "rejected", "revoked",
  "executing", "executed", "failed", "expired",
] as const;
```

Add to `CaptureErrorCode`: `| "ERR_CAPTURE_ACTION_NOT_PROPOSABLE" | "ERR_CAPTURE_CONNECTOR_UNCONFIGURED" | "ERR_CAPTURE_EXPIRED"`.

Add the row fields to `CaptureRow` (after `decidedAt`):

```ts
  readonly expiresAt: number | null;
  readonly outcomeRef: string | null;
  readonly errorCode: string | null;
```

Append:

```ts
/** Stored on a `failed` action row — a classified code, never an error message (spec § 8). */
export const ACTION_ERROR_CODES = [
  "ERR_ACTION_TIMEOUT",
  "ERR_ACTION_TOOL_NOT_FOUND",
  "ERR_ACTION_DISPATCH",
  "ERR_ACTION_INTERRUPTED",
] as const;
export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

export interface ActionPayload {
  readonly actionType: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly summary: string;
}

/**
 * The sink's view of a proposability verdict. Structural on purpose: `mcp-sink/` may not import
 * `connectors/` (D32(f)), so `connectors/proposable-actions.ts`'s richer type is assigned to this.
 */
export type ActionVerdict =
  | { readonly kind: "proposable" }
  | { readonly kind: "denied"; readonly class: string }
  | { readonly kind: "unknown" };

export interface ActionProvenance {
  readonly captureId: string;
  readonly clientLabel: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly summary: string;
}

export type ActExecuteOutcome =
  | { readonly status: "ok"; readonly result: unknown }
  | { readonly status: "rejected" };

/** Built per accept by `ipc/capture-rpc.ts` (spec § 8): the only path from the sink to a connector. */
export interface ActDeps {
  execute(
    actionType: string,
    input: Readonly<Record<string, unknown>>,
    provenance: ActionProvenance,
  ): Promise<ActExecuteOutcome>;
}
```

Extend `ValidatedCapture` with `| { readonly kind: "action"; readonly payload: ActionPayload }` and add:

```ts
export type NativeValidatedCapture = Exclude<ValidatedCapture, { readonly kind: "action" }>;
```

`config/mcp-sink-toml.ts`: import `DEFAULT_CAPTURE_KINDS`; extend the type and the defaults; add two `applyKey` arms.

```ts
export type NimbusMcpSinkToml = {
  readonly enabled: boolean;
  readonly kinds: readonly CaptureKind[];
  readonly maxPerHour: number;
  readonly maxPending: number;
  /** How long a proposed action may wait for the owner (spec § 5). */
  readonly actionTtlHours: number;
  /** Unexpired proposed actions allowed at once; separate from `maxPending`. */
  readonly actionMaxPending: number;
};

export const DEFAULT_MCP_SINK_CONFIG: NimbusMcpSinkToml = Object.freeze({
  enabled: false,
  kinds: Object.freeze([...DEFAULT_CAPTURE_KINDS]),
  maxPerHour: 30,
  maxPending: 100,
  actionTtlHours: 24,
  actionMaxPending: 10,
});
```

```ts
    case "action_ttl_hours":
      out.actionTtlHours = boundedInt("action_ttl_hours", valRaw, 1, 168);
      return;
    case "action_max_pending":
      out.actionMaxPending = boundedInt("action_max_pending", valRaw, 1, 100);
      return;
```

`policy/types.ts`: after `"mcp_capture",` add:

```ts
  /**
   * The MCP act door (I28, S3 PR 3): an agent PROPOSING a connector action for the owner to accept.
   * Locked off, `propose_action` is not offered, submit refuses and accept refuses.
   */
  "mcp_action",
```

`capture-capability.ts`:

```ts
export const MCP_ACTION_CAPABILITY =
  "mcp_action" as const satisfies (typeof AI_V2_CAPABILITIES)[number];
```

Add `readonly actionEnabled: boolean;` to both arms of `CaptureCapability`. Set `actionEnabled: false` in the four disabled returns. The enabled return becomes:

```ts
  const actionEnabled =
    kinds.includes("action") && !enforced.capabilitiesDisabled.has(MCP_ACTION_CAPABILITY);
  return { enabled: true, config, kinds, actionEnabled };
```

- [ ] **Step 4: Fix compile fallout and run the tests**

Run: `bun run typecheck`. Expected errors, and how to fix each:
- `capture-store.ts` `toRow`: add the three new fields with `null` for now. Task 2 replaces this with real columns.
- `capture-native.ts`: in `revokeCaptureNative` add `case "action": return;`. In `captureNativeStatus` add `case "action": return "absent";`. Change the `ValidatedCapture` parameters of `assertAcceptable`, `renderAcceptedItem` and `writeCaptureNative` to `NativeValidatedCapture`.
- `capture-validate.ts` `validateCapturePayload` / `referencedItemIds` switches: add `case "action": return invalid("action payloads are validated by validateActionPayload");` and `case "action": return [];` respectively. Task 5 replaces the first.
- `capture-gate.ts` `storedPayload` now returns `ValidatedCapture` while `assertAcceptable` needs native. Change `storedPayload` to return `NativeValidatedCapture`, and throw `ERR_CAPTURE_STATE` if `v.kind === "action"`. Task 7 routes actions away before this point.

Run: `bun test packages/gateway/src/config/mcp-sink-toml.test.ts packages/gateway/src/mcp-sink packages/gateway/src/policy`
Expected: PASS. An existing `capture-capability.test.ts` `toEqual` on the whole object now also needs `actionEnabled: false`; update those literals.

- [ ] **Step 5: Commit**

```bash
git add -A packages/gateway/src
git commit -m "feat(mcp): act door vocabulary — action kind, states, [mcp_sink] TTL/pending keys, mcp_action policy name"
```

---

### Task 2: Schema V69 and the store

**Files:**
- Create: `packages/gateway/src/index/capture-action-v69-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (step list near line 629; new hand-written step)
- Modify: `packages/gateway/src/index/local-index.ts:282` (`CURRENT_SCHEMA_VERSION = 69`)
- Modify: `packages/gateway/src/mcp-sink/capture-store.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (`D32_CAPTURE_TABLE_ALLOWED`)
- Test: `packages/gateway/src/index/migrations/runner-v69.test.ts` (create), `packages/gateway/src/mcp-sink/capture-store.test.ts`, `packages/gateway/src/index/migrations/runner.test.ts` (version pin)

**Interfaces:**
- Produces (CaptureStore):
  - `insert(row: NewCaptureRow)`, where `NewCaptureRow = Omit<CaptureRow, "nativeRef"|"decidedAt"|"outcomeRef"|"errorCode">` and so now carries `expiresAt`
  - `countPendingActions(nowMs): number`
  - `countPendingActionsExpiringBy(nowMs, byMs): number`
  - `countPendingNative(): number`
  - `dueActionIds(nowMs): string[]`
  - `expireDueActions(nowMs): string[]`
  - `claimAction(id, nowMs): boolean`
  - `finalizeAction(id, state: "executed"|"failed"|"rejected", f: {outcomeRef?: string; errorCode?: string}, nowMs): boolean`
  - `interruptedActionIds(): string[]`
  - `failInterruptedActions(nowMs): string[]`
  - `pruneRejected(cutoffMs)`, now also pruning `expired`

- [ ] **Step 1: Write the failing migration test**

Create `packages/gateway/src/index/migrations/runner-v69.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "./runner.ts";

/** Seed V68 rows directly: a migration test writes what the OLD schema allowed. */
function seedV68(db: Database): void {
  db.run(
    `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, native_ref, created_at, decided_at)
     VALUES ('cap_1','note','live','nimbus:cap_1','{"title":"t"}',13,'cl','s1',NULL,10,NULL),
            ('cap_2','decision','accepted','nimbus:cap_2','{"statement":"s"}',17,NULL,'s2','capture:cap_2',20,21),
            ('cap_3','term','revoked',NULL,NULL,0,NULL,'s3','wal',30,31),
            ('cap_4','link','rejected',NULL,'{"relation":"fixes"}',20,NULL,'s4',NULL,40,41)`,
  );
}

function fresh(db: Database, sql: string): Array<Record<string, unknown>> {
  const stmt = db.prepare(sql);
  try {
    return stmt.all() as Array<Record<string, unknown>>;
  } finally {
    stmt.finalize();
  }
}

function insertAction(db: Database, over: Record<string, unknown>): void {
  const row = {
    id: "cap_a", kind: "action", state: "proposed", item_id: null, payload_json: "{}",
    payload_bytes: 2, session_id: "s", native_ref: null, created_at: 1, expires_at: 100,
    outcome_ref: null, error_code: null, ...over,
  };
  db.run(
    `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, session_id, native_ref, created_at, expires_at, outcome_ref, error_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.kind, row.state, row.item_id, row.payload_json, row.payload_bytes, row.session_id,
     row.native_ref, row.created_at, row.expires_at, row.outcome_ref, row.error_code] as never,
  );
}

describe("V69 — the act door's capture columns", () => {
  test("every V68 row survives byte-identical, new columns NULL, count asserted", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 68);
    seedV68(db);
    const before = fresh(db, "SELECT * FROM capture ORDER BY id");
    runIndexedSchemaMigrations(db, 69);
    const after = fresh(db, "SELECT * FROM capture ORDER BY id");
    expect(after).toHaveLength(before.length);
    expect(
      after.map(({ expires_at: _e, outcome_ref: _o, error_code: _c, ...rest }) => rest),
    ).toEqual(before);
    expect(after.every((r) => r["expires_at"] === null && r["outcome_ref"] === null)).toBe(true);
    db.close();
  });

  test("the three indexes are recreated", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 69);
    const names = fresh(db, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='capture'")
      .map((r) => r["name"]);
    expect(names).toEqual(
      expect.arrayContaining(["idx_capture_state_created", "idx_capture_created", "idx_capture_item_id"]),
    );
    db.close();
  });

  test("a valid proposed action inserts", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 69);
    expect(() => insertAction(db, {})).not.toThrow();
    db.close();
  });

  test.each([
    ["an action without expires_at", { expires_at: null }],
    ["a note with expires_at", { kind: "note", state: "live", expires_at: 5 }],
    ["an action with an item", { item_id: "nimbus:x" }],
    ["an action with a native_ref", { native_ref: "x" }],
    ["an action in state accepted", { state: "accepted" }],
    ["a decision in state executed", { kind: "decision", state: "executed", expires_at: null }],
    ["outcome_ref on a non-executed action", { outcome_ref: "https://x" }],
    ["outcome_ref over 512", { state: "executed", outcome_ref: `https://${"a".repeat(510)}` }],
    ["error_code on a non-failed action", { error_code: "ERR_ACTION_DISPATCH" }],
    ["error_code over 64", { state: "failed", error_code: "E".repeat(65) }],
  ])("CHECK rejects %s", (_name, over) => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 69);
    expect(() => insertAction(db, over)).toThrow();
    db.close();
  });
});
```

Append to `capture-store.test.ts`. It uses `openMigratedMemoryDb`, so the table is V69 once the step lands.

```ts
describe("action queries (PR 3)", () => {
  function action(id: string, expiresAt: number, state = "proposed"): void {
    new CaptureStore(db).insert({
      id, kind: "action", state: state as never, itemId: null, payloadJson: "{}",
      payloadBytes: 2, clientLabel: null, sessionId: "s", createdAt: 1, expiresAt,
    });
  }
  test("countPendingActions excludes expired-by-clock rows; the boundary counts as expired", () => {
    action("cap_a", 100);
    action("cap_b", 200);
    const s = new CaptureStore(db);
    expect(s.countPendingActions(99)).toBe(2);
    expect(s.countPendingActions(100)).toBe(1);
  });
  test("countPendingNative excludes actions; countPendingActionsExpiringBy windows", () => {
    action("cap_a", 100);
    const s = new CaptureStore(db);
    s.insert({ id: "cap_d", kind: "decision", state: "proposed", itemId: null, payloadJson: "{}",
      payloadBytes: 2, clientLabel: null, sessionId: "s", createdAt: 1, expiresAt: null });
    expect(s.countPendingNative()).toBe(1);
    expect(s.countPendingActionsExpiringBy(50, 100)).toBe(1);
    expect(s.countPendingActionsExpiringBy(50, 99)).toBe(0);
  });
  test("expireDueActions returns exactly the due ids and transitions them", () => {
    action("cap_a", 100);
    action("cap_b", 200);
    const s = new CaptureStore(db);
    expect(s.expireDueActions(150)).toEqual(["cap_a"]);
    expect(s.get("cap_a")?.state).toBe("expired");
    expect(s.get("cap_a")?.decidedAt).toBe(150);
    expect(s.get("cap_b")?.state).toBe("proposed");
    expect(s.expireDueActions(150)).toEqual([]);
  });
  test("claimAction wins once, loses on a moved or expired row", () => {
    action("cap_a", 100);
    const s = new CaptureStore(db);
    expect(s.claimAction("cap_a", 100)).toBe(false); // at the boundary: expired
    expect(s.claimAction("cap_a", 50)).toBe(true);
    expect(s.get("cap_a")?.state).toBe("executing");
    expect(s.claimAction("cap_a", 50)).toBe(false);
  });
  test("finalizeAction only moves an executing row", () => {
    action("cap_a", 100);
    const s = new CaptureStore(db);
    expect(s.finalizeAction("cap_a", "executed", { outcomeRef: "https://x" }, 60)).toBe(false);
    s.claimAction("cap_a", 50);
    expect(s.finalizeAction("cap_a", "executed", { outcomeRef: "https://x" }, 60)).toBe(true);
    expect(s.get("cap_a")).toMatchObject({ state: "executed", outcomeRef: "https://x", decidedAt: 60 });
  });
  test("failInterruptedActions turns executing into failed/ERR_ACTION_INTERRUPTED", () => {
    action("cap_a", 100);
    const s = new CaptureStore(db);
    s.claimAction("cap_a", 50);
    expect(s.failInterruptedActions(70)).toEqual(["cap_a"]);
    expect(s.get("cap_a")).toMatchObject({ state: "failed", errorCode: "ERR_ACTION_INTERRUPTED" });
  });
  test("pruneRejected also prunes expired actions, never executed or failed ones", () => {
    action("cap_e", 100);
    action("cap_x", 100);
    action("cap_f", 100);
    const s = new CaptureStore(db);
    s.expireDueActions(150); // all three expire
    db.run("UPDATE capture SET state='executed', outcome_ref=NULL WHERE id='cap_x'");
    db.run("UPDATE capture SET state='failed', error_code='ERR_ACTION_DISPATCH' WHERE id='cap_f'");
    expect(s.pruneRejected(1_000)).toBe(1);
    expect(s.get("cap_e")).toBeUndefined();
    expect(s.get("cap_x")?.state).toBe("executed");
    expect(s.get("cap_f")?.state).toBe("failed");
  });
});
```

Every existing `insert({...})` in `capture-store.test.ts` and in other tests must pass `expiresAt: null`. Find them with `grep -rn "store.insert\|\.insert({" packages/gateway/src/mcp-sink`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/index/migrations/runner-v69.test.ts packages/gateway/src/mcp-sink/capture-store.test.ts`
Expected: FAIL. `runIndexedSchemaMigrations(db, 69)` has no step, and the store methods are missing.

- [ ] **Step 3: Implement**

Create `packages/gateway/src/index/capture-action-v69-sql.ts`:

```ts
/**
 * V69 — the MCP act door (spec 2026-10-15 § 4, invariant I28, S3 PR 3).
 *
 * `capture` admits a fifth kind, `action`, four action states, and three nullable columns. SQLite
 * cannot alter a CHECK, so the table is REBUILT with every column named on both sides of the copy
 * (the V68 precedent). `capture` is no FK parent, so no cascade can fire on the drop. Only this file
 * and `mcp-sink/capture-store.ts` name the table (static rule D32(a)).
 */
const V68_COLS = `id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id,
  native_ref, created_at, decided_at`;

export const CAPTURE_ACTION_V69_COUNT_SQL = "SELECT COUNT(*) AS n FROM capture";

export const CAPTURE_ACTION_V69_SQL: readonly string[] = [
  `CREATE TABLE capture_v69 (
     id            TEXT PRIMARY KEY,
     kind          TEXT NOT NULL CHECK(kind IN ('note','decision','term','link','action')),
     state         TEXT NOT NULL CHECK(state IN ('live','proposed','accepted','rejected','revoked',
                                                 'executing','executed','failed','expired')),
     item_id       TEXT,
     payload_json  TEXT,
     payload_bytes INTEGER NOT NULL,
     client_label  TEXT,
     session_id    TEXT NOT NULL,
     native_ref    TEXT,
     created_at    INTEGER NOT NULL,
     decided_at    INTEGER,
     expires_at    INTEGER,
     outcome_ref   TEXT,
     error_code    TEXT,
     CHECK (
       (kind = 'note' AND state IN ('live','revoked'))
       OR (kind IN ('decision','term','link') AND state IN ('proposed','accepted','rejected','revoked'))
       OR (kind = 'action' AND state IN ('proposed','executing','executed','failed','rejected','expired'))
     ),
     CHECK ((state = 'revoked') = (payload_json IS NULL)),
     CHECK ((kind = 'action') = (expires_at IS NOT NULL)),
     CHECK (kind <> 'action' OR (item_id IS NULL AND native_ref IS NULL)),
     CHECK (outcome_ref IS NULL OR (kind = 'action' AND state = 'executed' AND length(outcome_ref) <= 512)),
     CHECK (error_code IS NULL OR (kind = 'action' AND state = 'failed' AND length(error_code) <= 64))
   )`,
  `INSERT INTO capture_v69 (${V68_COLS}) SELECT ${V68_COLS} FROM capture`,
  "DROP TABLE capture",
  "ALTER TABLE capture_v69 RENAME TO capture",
  "CREATE INDEX IF NOT EXISTS idx_capture_state_created ON capture(state, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_capture_created ON capture(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_capture_item_id ON capture(item_id) WHERE item_id IS NOT NULL",
];
```

In `runner.ts`, import it and add a hand-written step beside `migrateIndexedV67ToV68`:

```ts
/** V68→V69 counts the rows across the rebuild, so a lossy copy aborts rather than ships (spec § 4). */
function migrateIndexedV68ToV69(db: Database, now: number): void {
  db.transaction(() => {
    const before = (db.query(CAPTURE_ACTION_V69_COUNT_SQL).get() as { n: number }).n;
    for (const sql of CAPTURE_ACTION_V69_SQL) dbExec(db, sql);
    const after = (db.query(CAPTURE_ACTION_V69_COUNT_SQL).get() as { n: number }).n;
    if (after !== before) {
      throw new Error(`V69: capture rebuild copied ${String(after)} rows, expected ${String(before)}`);
    }
    dbExec(db, "PRAGMA user_version = 69");
    recordMigration(db, 69, "MCP act door: capture action kind/states, expires_at/outcome_ref/error_code (v69)", now);
  })();
}
```

Register it with `{ fromVersion: 68, toVersion: 69, apply: migrateIndexedV68ToV69 },` after the V68 entry. Set `CURRENT_SCHEMA_VERSION = 69` in `local-index.ts`. Update the `68` pin in `runner.test.ts` to `69`; `grep -n "68" packages/gateway/src/index/migrations/runner.test.ts` finds it. The migrated-db template is rebuilt from the runner, so nothing else needs regenerating; confirm by running `bun test packages/gateway/src/index`.

Add `"packages/gateway/src/index/capture-action-v69-sql.ts"` to `D32_CAPTURE_TABLE_ALLOWED` in `scripts/structure-audit/check-nimbus-invariants.ts`.

`capture-store.ts`: extend `RawRow` with `expires_at: number | null; outcome_ref: string | null; error_code: string | null;`, map them in `toRow`, and change `NewCaptureRow` and `insert`:

```ts
export type NewCaptureRow = Omit<CaptureRow, "nativeRef" | "decidedAt" | "outcomeRef" | "errorCode">;
```

```ts
  insert(row: NewCaptureRow): void {
    dbRun(
      this.db,
      `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.kind, row.state, row.itemId, row.payloadJson, row.payloadBytes,
       row.clientLabel, row.sessionId, row.createdAt, row.expiresAt],
    );
  }
```

Add these methods. Every write goes through `dbRun`, and each "returns ids" method SELECTs the ids and then runs one UPDATE with the same predicate. The caller opens the transaction.

```ts
  /** Unexpired proposed actions. `expires_at = now` is EXPIRED (Review Focus 2). */
  countPendingActions(nowMs: number): number {
    return (this.db
      .query("SELECT COUNT(*) AS n FROM capture WHERE kind = 'action' AND state = 'proposed' AND expires_at > ?")
      .get(nowMs) as { n: number }).n;
  }

  countPendingActionsExpiringBy(nowMs: number, byMs: number): number {
    return (this.db
      .query(
        "SELECT COUNT(*) AS n FROM capture WHERE kind = 'action' AND state = 'proposed' AND expires_at > ? AND expires_at <= ?",
      )
      .get(nowMs, byMs) as { n: number }).n;
  }

  /** Proposed decision/term/link rows — the queue `max_pending` bounds (spec § 7 step 8). */
  countPendingNative(): number {
    return (this.db
      .query("SELECT COUNT(*) AS n FROM capture WHERE kind <> 'action' AND state = 'proposed'")
      .get() as { n: number }).n;
  }

  dueActionIds(nowMs: number): string[] {
    return (this.db
      .query("SELECT id FROM capture WHERE kind = 'action' AND state = 'proposed' AND expires_at <= ? ORDER BY id")
      .all(nowMs) as Array<{ id: string }>).map((r) => r.id);
  }

  /** Expire every due proposed action. Run INSIDE the caller's transaction (it audits per id). */
  expireDueActions(nowMs: number): string[] {
    const ids = this.dueActionIds(nowMs);
    if (ids.length === 0) return ids;
    const changed = dbRun(
      this.db,
      `UPDATE capture SET state = 'expired', decided_at = ?
       WHERE kind = 'action' AND state = 'proposed' AND expires_at <= ?`,
      [nowMs, nowMs],
    ).changes;
    if (changed !== ids.length) {
      throw new Error(`expireDueActions: expired ${String(changed)} rows, expected ${String(ids.length)}`);
    }
    return ids;
  }

  /** The CAS of spec § 8 step 5: the expiry predicate closes the window across the re-check await. */
  claimAction(id: string, nowMs: number): boolean {
    return dbRun(
      this.db,
      `UPDATE capture SET state = 'executing', decided_at = ?
       WHERE id = ? AND kind = 'action' AND state = 'proposed' AND expires_at > ?`,
      [nowMs, id, nowMs],
    ).changes === 1;
  }

  finalizeAction(
    id: string,
    state: "executed" | "failed" | "rejected",
    f: { readonly outcomeRef?: string; readonly errorCode?: string },
    nowMs: number,
  ): boolean {
    return dbRun(
      this.db,
      `UPDATE capture SET state = ?, outcome_ref = ?, error_code = ?, decided_at = ?
       WHERE id = ? AND kind = 'action' AND state = 'executing'`,
      [state, f.outcomeRef ?? null, f.errorCode ?? null, nowMs, id],
    ).changes === 1;
  }

  interruptedActionIds(): string[] {
    return (this.db
      .query("SELECT id FROM capture WHERE kind = 'action' AND state = 'executing' ORDER BY id")
      .all() as Array<{ id: string }>).map((r) => r.id);
  }

  /** Boot reconcile: `executing` survived a restart → `failed`, never back to `proposed`. */
  failInterruptedActions(nowMs: number): string[] {
    const ids = this.interruptedActionIds();
    if (ids.length === 0) return ids;
    dbRun(
      this.db,
      `UPDATE capture SET state = 'failed', error_code = 'ERR_ACTION_INTERRUPTED', decided_at = ?
       WHERE kind = 'action' AND state = 'executing'`,
      [nowMs],
    );
    return ids;
  }
```

Change `pruneRejected`'s predicate to `state IN ('rejected','expired')`.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/index packages/gateway/src/mcp-sink && bun run typecheck`
Expected: PASS. Typecheck flags every `insert` without `expiresAt`, including `capture-gate.ts`'s submit; add `expiresAt: null` there for now.

- [ ] **Step 5: Commit**

```bash
git add -A packages/gateway/src scripts/structure-audit/check-nimbus-invariants.ts
git commit -m "feat(index): V69 — capture action kind, states and expiry/outcome columns"
```

---

### Task 3: The proposability and routing table

**Files:**
- Create: `packages/gateway/src/connectors/proposable-actions.ts`
- Test: `packages/gateway/src/connectors/proposable-actions.test.ts`

**Interfaces:**
- Consumes: `serviceOf` (`engine/service-of.ts`), `USER_MCP_SERVICE_ID_PATTERN` and `userMcpToolKeyForActionType` (`connectors/user-mcp-store.ts`).
- Produces:
  - `type DeniedClass`
  - `ACTION_PROPOSABILITY: Readonly<Record<string, Proposability>>`
  - `PROPOSABLE_WRITE_TOOLS: Readonly<Record<string, string>>`
  - `type ActionClassification`
  - `interface ClassifyContext { modelAccessServices(): ReadonlySet<string>; userMcpModelAccessAllowed(): boolean }`
  - `classifyActionType(actionType, ctx): ActionClassification`
  - `proposableWriteTool(actionType): string | undefined`
  - `listProposableActionTypes(ctx: ClassifyContext & { isServiceConfigured(s: string): Promise<boolean> }): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";

import { HITL_REQUIRED } from "../engine/executor.ts";
import { serviceOf } from "../engine/service-of.ts";
import { serviceIdForToolKey } from "./lazy-mesh/tool-map.ts";
import {
  ACTION_PROPOSABILITY,
  classifyActionType,
  listProposableActionTypes,
  PROPOSABLE_WRITE_TOOLS,
  proposableWriteTool,
} from "./proposable-actions.ts";

const OPEN = { modelAccessServices: () => new Set(["mcp_echo"]), userMcpModelAccessAllowed: () => true };

const PROPOSABLE = [
  "apple.calendar.event.create", "apple.mail.draft.create", "apple.mail.send",
  "confluence.comment.add", "confluence.page.create", "confluence.page.update",
  "fastmail.mail.send", "github.issue.create", "gmail.draft.create", "gmail.draft.send",
  "gmail.message.send", "google_drive.file.create", "imap.mail.send", "jira.comment.add",
  "jira.issue.create", "jira.issue.update", "linear.comment.create", "linear.issue.create",
  "linear.issue.update", "notion.block.append", "notion.comment.create", "notion.page.create",
  "notion.page.update", "obsidian.note.append", "outlook.calendar.create", "outlook.mail.send",
  "protonmail.mail.send", "slack.message.post", "teams.message.post", "teams.message.postChat",
];

describe("ACTION_PROPOSABILITY", () => {
  test("is total over HITL_REQUIRED and names nothing else", () => {
    expect(Object.keys(ACTION_PROPOSABILITY).sort()).toEqual([...HITL_REQUIRED].sort());
  });
  test("the proposable set is exactly the reviewed 30", () => {
    const got = Object.entries(ACTION_PROPOSABILITY)
      .filter(([, p]) => p.kind === "proposable")
      .map(([t]) => t)
      .sort();
    expect(got).toEqual(PROPOSABLE);
  });
  test("§ 6.2 borderline types stay denied", () => {
    for (const t of ["pagerduty.incident.acknowledge", "alert.acknowledge", "github.pr.close",
      "repo.pr.close", "tableau.datasource.refresh", "powerbi.dataset.refresh"]) {
      expect(ACTION_PROPOSABILITY[t]?.kind, t).toBe("denied");
    }
  });
});

describe("PROPOSABLE_WRITE_TOOLS", () => {
  test("keys are exactly the proposable first-party types", () => {
    expect(Object.keys(PROPOSABLE_WRITE_TOOLS).sort()).toEqual(PROPOSABLE);
  });
  test("each row resolves on its OWN server in the mesh key form", () => {
    // resolveServerTool(map, serviceOf(type), toolId) looks up `${server}_${toolId}` and requires
    // serviceIdForToolKey to give that key back to the same server.
    for (const [type, tool] of Object.entries(PROPOSABLE_WRITE_TOOLS)) {
      const server = serviceOf(type);
      expect(serviceIdForToolKey(`${server}_${tool}`), type).toBe(server);
    }
  });
  test("proposableWriteTool: routing value for proposables, undefined otherwise", () => {
    expect(proposableWriteTool("slack.message.post")).toBe("slack_message_post");
    expect(proposableWriteTool("obsidian.note.append")).toBe("obsidian_append_to_daily_note");
    expect(proposableWriteTool("github.pr.merge")).toBeUndefined();
    expect(proposableWriteTool("mcp_echo.echo")).toBeUndefined();
    expect(proposableWriteTool("toString")).toBeUndefined();
  });
});

describe("classifyActionType", () => {
  test("first-party proposable / denied / unknown", () => {
    expect(classifyActionType("slack.message.post", OPEN)).toEqual({ kind: "proposable" });
    expect(classifyActionType("github.pr.merge", OPEN)).toEqual({ kind: "denied", class: "vcs" });
    expect(classifyActionType("Slack.Message.Post", OPEN)).toEqual({ kind: "unknown" });
    expect(classifyActionType("constructor", OPEN)).toEqual({ kind: "unknown" });
  });
  test("user-MCP: proposable only for a --model server while policy allows", () => {
    expect(classifyActionType("mcp_echo.echo", OPEN)).toEqual({ kind: "proposable" });
    expect(classifyActionType("mcp_other.echo", OPEN)).toEqual({
      kind: "denied", class: "user_mcp_no_model_access",
    });
    expect(
      classifyActionType("mcp_echo.echo", { ...OPEN, userMcpModelAccessAllowed: () => false }),
    ).toEqual({ kind: "denied", class: "user_mcp_policy" });
    expect(classifyActionType("mcp_echo.", OPEN)).toEqual({ kind: "unknown" });
  });
});

describe("listProposableActionTypes", () => {
  test("configured first-party types plus one pattern per --model server, sorted", async () => {
    const out = await listProposableActionTypes({
      ...OPEN,
      isServiceConfigured: (s) => Promise.resolve(s === "slack" || s === "jira"),
    });
    expect(out).toEqual([
      "jira.comment.add", "jira.issue.create", "jira.issue.update", "mcp_echo.*", "slack.message.post",
    ]);
  });
  test("policy off: no user-MCP pattern", async () => {
    const out = await listProposableActionTypes({
      ...OPEN, userMcpModelAccessAllowed: () => false, isServiceConfigured: () => Promise.resolve(false),
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/connectors/proposable-actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { serviceOf } from "../engine/service-of.ts";
import { USER_MCP_SERVICE_ID_PATTERN, userMcpToolKeyForActionType } from "./user-mcp-store.ts";

/**
 * The act door's gateway-owned tables (spec 2026-10-15 § 6, invariant I28).
 *
 * `ACTION_PROPOSABILITY` classifies EVERY HITL frozen-set type (a test makes it total), so a type
 * added to the set later is UNKNOWN — refused — until someone classifies it: broad minus a
 * denylist, implemented fail-closed. `PROPOSABLE_WRITE_TOOLS` is the routing table: the mesh lists a
 * first-party write as `<server>_<underscored tool>`, which no action type spells, so the act door
 * dispatches the tool named HERE as the payload `mcpToolId` — never one an agent supplied.
 * `proposable-actions.sync.test.ts` proves every row against the installed connectors package.
 */
export type DeniedClass =
  | "file" | "calendar_delete" | "vcs" | "pipeline" | "cloud" | "iac" | "k8s" | "deployment"
  | "incident" | "data_platform" | "tribal_kb" | "chatops_confined" | "unroutable"
  | "gateway_internal";

export type Proposability =
  | { readonly kind: "proposable" }
  | { readonly kind: "denied"; readonly class: DeniedClass };

export type ActionClassification =
  | { readonly kind: "proposable" }
  | { readonly kind: "denied"; readonly class: DeniedClass | "user_mcp_no_model_access" | "user_mcp_policy" }
  | { readonly kind: "unknown" };

export interface ClassifyContext {
  /** Service ids registered with `--model` (`model_access = 1`), unfiltered by policy. */
  modelAccessServices(): ReadonlySet<string>;
  /** `user_mcp_model_access` per the LIVE resolved policy; false when the accessor is absent. */
  userMcpModelAccessAllowed(): boolean;
}

const P: Proposability = Object.freeze({ kind: "proposable" });
function denied(cls: DeniedClass, types: readonly string[]): Array<[string, Proposability]> {
  const v: Proposability = Object.freeze({ kind: "denied", class: cls });
  return types.map((t) => [t, v]);
}

/** actionType → bare tool id, as registered by `@nimbus-dev/connectors` (spec § 6.3). */
export const PROPOSABLE_WRITE_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  "slack.message.post": "slack_message_post",
  "teams.message.post": "teams_message_post",
  "teams.message.postChat": "teams_message_post_chat",
  "gmail.draft.create": "gmail_draft_create",
  "gmail.draft.send": "gmail_draft_send",
  "gmail.message.send": "gmail_message_send",
  "outlook.mail.send": "outlook_mail_send",
  "fastmail.mail.send": "fastmail_mail_send",
  "imap.mail.send": "imap_mail_send",
  "protonmail.mail.send": "protonmail_mail_send",
  "apple.mail.send": "apple_mail_send",
  "apple.mail.draft.create": "apple_mail_draft_create",
  "outlook.calendar.create": "outlook_calendar_create",
  "apple.calendar.event.create": "apple_calendar_event_create",
  "linear.issue.create": "linear_issue_create",
  "linear.issue.update": "linear_issue_update",
  "linear.comment.create": "linear_comment_create",
  "jira.issue.create": "jira_issue_create",
  "jira.issue.update": "jira_issue_update",
  "jira.comment.add": "jira_comment_add",
  "github.issue.create": "github_issue_create",
  "notion.page.create": "notion_page_create",
  "notion.page.update": "notion_page_update",
  "notion.block.append": "notion_block_append",
  "notion.comment.create": "notion_comment_create",
  "confluence.page.create": "confluence_page_create",
  "confluence.page.update": "confluence_page_update",
  "confluence.comment.add": "confluence_comment_add",
  "obsidian.note.append": "obsidian_append_to_daily_note",
  "google_drive.file.create": "gdrive_file_create",
});

export const ACTION_PROPOSABILITY: Readonly<Record<string, Proposability>> = Object.freeze(
  Object.fromEntries([
    ...Object.keys(PROPOSABLE_WRITE_TOOLS).map((t): [string, Proposability] => [t, P]),
    ...denied("file", ["file.delete", "file.move", "file.rename", "file.create", "photo.delete",
      "onedrive.delete", "onedrive.move", "onedrive.item.delete", "onedrive.item.move",
      "google_drive.file.move", "google_drive.file.rename"]),
    ...denied("calendar_delete", ["calendar.event.delete", "outlook.calendar.delete",
      "apple.calendar.event.delete"]),
    ...denied("vcs", ["repo.pr.merge", "repo.pr.close", "repo.branch.delete", "repo.tag.create",
      "repo.commit.push", "github.pr.merge", "github.pr.close", "github.branch.delete",
      "github.tag.create", "bitbucket.pr.merge", "gitlab.mr.merge"]),
    ...denied("pipeline", ["pipeline.trigger", "pipeline.cancel", "pipeline.rerun",
      "jenkins.build.trigger", "jenkins.build.abort", "github_actions.run.trigger",
      "github_actions.run.cancel", "circleci.pipeline.trigger", "circleci.job.cancel",
      "gitlab.pipeline.retry", "gitlab.pipeline.cancel"]),
    ...denied("cloud", ["aws.ecs.service.update", "aws.lambda.invoke", "aws.ec2.instance.stop",
      "aws.ec2.instance.start", "azure.app_service.restart", "azure.aks.node_pool.scale",
      "gcp.cloud_run.deploy", "gcp.gke.workload.restart", "cloud.resource.scale",
      "cloud.resource.stop"]),
    ...denied("iac", ["iac.terraform.apply", "iac.terraform.destroy", "iac.cloudformation.deploy",
      "iac.pulumi.up", "infra.apply", "infra.destroy"]),
    ...denied("k8s", ["kubernetes.rollout.restart", "kubernetes.pod.delete",
      "kubernetes.deployment.scale", "k8s.apply", "k8s.delete", "k8s.rollout.restart"]),
    ...denied("deployment", ["deployment.apply", "deployment.rollback", "argocd.app.sync",
      "argocd.app.rollback", "flux.kustomization.reconcile", "flux.helmrelease.reconcile",
      "mlflow.model.promote", "mlflow.model.transition_stage"]),
    ...denied("incident", ["pagerduty.incident.acknowledge", "pagerduty.incident.resolve",
      "pagerduty.incident.escalate", "alert.acknowledge", "alert.silence", "incident.escalate",
      "incident.resolve", "montecarlo.incident.acknowledge", "montecarlo.incident.resolve",
      "bigeye.issue.acknowledge", "bigeye.issue.resolve"]),
    ...denied("data_platform", ["snowflake.tag.set", "snowflake.comment.set",
      "tableau.datasource.refresh", "tableau.workbook.refresh", "looker.datagroup.trigger",
      "looker.schedule.run_once", "powerbi.dataset.refresh", "powerbi.dataflow.refresh"]),
    // I25/D19: destination config-pinned; tool ids confined to the tribal write gate.
    ...denied("tribal_kb", ["notion.knowledge.write", "confluence.knowledge.write"]),
    // I23/D17: these tool literals are confined to the ChatOps reply surface.
    ...denied("chatops_confined", ["slack.chat.post", "teams.chat.post"]),
    // No connector server is named `email`/`calendar`: no tool can resolve, and
    // `isConnectorConfigured` would answer true vacuously for an unknown service.
    ...denied("unroutable", ["email.send", "email.draft.send", "email.draft.create",
      "calendar.event.create"]),
    ...denied("gateway_internal", ["data.delete", "data.export", "connector.remove",
      "connector.adoptLocalAuth", "connector.addMcp", "connector.reindex", "extension.autoUpdate",
      "extension.downgrade", "extension.install", "vault.set", "vault.delete", "teamvault.put",
      "teamvault.delete", "share.publish", "egress.prune", "tool.save"]),
  ]),
);

function isUserMcpType(actionType: string): boolean {
  return USER_MCP_SERVICE_ID_PATTERN.test(serviceOf(actionType));
}

export function classifyActionType(actionType: string, ctx: ClassifyContext): ActionClassification {
  if (isUserMcpType(actionType)) {
    if (userMcpToolKeyForActionType(actionType) === undefined) return { kind: "unknown" };
    if (!ctx.userMcpModelAccessAllowed()) return { kind: "denied", class: "user_mcp_policy" };
    if (!ctx.modelAccessServices().has(serviceOf(actionType))) {
      return { kind: "denied", class: "user_mcp_no_model_access" };
    }
    return { kind: "proposable" };
  }
  return Object.hasOwn(ACTION_PROPOSABILITY, actionType)
    ? (ACTION_PROPOSABILITY[actionType] as Proposability)
    : { kind: "unknown" };
}

/** The ONE tool id the act door dispatches for a first-party proposable type (spec § 6.3). */
export function proposableWriteTool(actionType: string): string | undefined {
  return Object.hasOwn(PROPOSABLE_WRITE_TOOLS, actionType)
    ? PROPOSABLE_WRITE_TOOLS[actionType]
    : undefined;
}

/**
 * What `capture.status` advertises (spec § 10): first-party proposables whose service is
 * configured, plus one `mcp_<id>.*` pattern per `--model` server while policy allows. A pattern,
 * not a tool list: listing tools would spawn every `--model` server on each status call.
 */
export async function listProposableActionTypes(
  ctx: ClassifyContext & { isServiceConfigured(service: string): Promise<boolean> },
): Promise<string[]> {
  const out: string[] = [];
  const configured = new Map<string, boolean>();
  for (const type of Object.keys(PROPOSABLE_WRITE_TOOLS)) {
    const svc = serviceOf(type);
    if (!configured.has(svc)) configured.set(svc, await ctx.isServiceConfigured(svc));
    if (configured.get(svc) === true) out.push(type);
  }
  if (ctx.userMcpModelAccessAllowed()) {
    for (const id of ctx.modelAccessServices()) out.push(`${id}.*`);
  }
  return out.sort((a, b) => a.localeCompare(b)).slice(0, 200);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/connectors/proposable-actions.test.ts`
Expected: PASS. If the "own server" test fails for a row, `serviceIdForToolKey` attributes that key to a different (longer) service id. Do NOT edit `tool-map.ts`. Move the type to `unroutable` instead and record it in the PR body.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/proposable-actions.ts packages/gateway/src/connectors/proposable-actions.test.ts
git commit -m "feat(connectors): act-door proposability + routing table, total over HITL_REQUIRED"
```

---

### Task 4: Routing sync test against the installed connectors package

**Files:**
- Modify: `packages/gateway/src/connectors/testing/connector-write-registrations.ts` (`WriteToolRegistration` + `scanCalls` push, ~line 1515)
- Create: `packages/gateway/src/connectors/testing/registration-mutates.ts`
- Test: `packages/gateway/src/connectors/testing/registration-mutates.test.ts` (create), `packages/gateway/src/connectors/proposable-actions.sync.test.ts` (create)

**Interfaces:**
- Consumes: `scanWriteToolRegistrations`, `readConnectorPackageSources`, `installedConnectorsPackageRoot`, `PROPOSABLE_WRITE_TOOLS`.
- Produces:
  - `WriteToolRegistration` += `readonly span: readonly [number, number]`: offsets of the registering call's `(`…`)` in `file`'s text
  - `resolveRegistrationMutates(sources: readonly PackageSource[], r: WriteToolRegistration): { value: string } | { reason: string }`

- [ ] **Step 1: Write the failing helper test**

Create `registration-mutates.test.ts`. The fixtures reproduce the three shapes that 0.2.4 uses.

```ts
import { describe, expect, test } from "bun:test";

import { resolveRegistrationMutates } from "./registration-mutates.ts";
import type { PackageSource, WriteToolRegistration } from "./connector-write-registrations.ts";

function reg(file: string, text: string, id: string): [PackageSource[], WriteToolRegistration] {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  return [
    [{ rel: file, text }],
    { id, file, line: 1, origin: file, tags: ["literal"], span: [open, close] },
  ];
}

describe("resolveRegistrationMutates", () => {
  test("a literal mutates", () => {
    const [s, r] = reg("connectors/slack/src/tools.ts",
      'registerWriteTool("slack_message_post", { mutates: "slack.message.post" }, h)', "slack_message_post");
    expect(resolveRegistrationMutates(s, r)).toEqual({ value: "slack.message.post" });
  });
  test("a helper whose first parameter is `mutates: string`", () => {
    const helper: PackageSource = {
      rel: "shared/imap-tool-kit.ts",
      text: "export function mailSendConsent<T extends { readonly to: string }>(\n  mutates: string,\n): X { return { mutates }; }",
    };
    const [s, r] = reg("connectors/gmail/src/tools.ts",
      'registerWriteTool("gmail_message_send", mailSendConsent("gmail.message.send"), "d")', "gmail_message_send");
    expect(resolveRegistrationMutates([...s, helper], r)).toEqual({ value: "gmail.message.send" });
  });
  test("a kit template sharing the id's prefix variable", () => {
    const [s, r] = reg("shared/imap-tool-kit.ts",
      "registerWriteTool(`${toolPrefix}_mail_send`, { mutates: `${toolPrefix}.mail.send` }, h)", "imap_mail_send");
    expect(resolveRegistrationMutates(s, r)).toEqual({ value: "imap.mail.send" });
  });
  test("anything else is a reason, never a guess", () => {
    const [s, r] = reg("connectors/x/src/tools.ts", "registerWriteTool(\"x_y\", cfg, h)", "x_y");
    expect(resolveRegistrationMutates(s, r)).toHaveProperty("reason");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/connectors/testing/registration-mutates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

In `connector-write-registrations.ts`, add to `WriteToolRegistration`:

```ts
  /** `[open, close]` offsets of the registering call's parentheses in `file`'s text. */
  readonly span: readonly [number, number];
```

In `scanCalls`'s `visit`, compute `const span = [call.open, matchForward(s, call.open)] as const;`, push it to `spans`, and include `span` in each `this.registrations.push({...})`. `f.p.blank` blanks string contents without changing their length, so these offsets index the original `text` too. The sync test in Step 4 confirms this by reading the literal back.

Create `registration-mutates.ts`:

```ts
import type { PackageSource, WriteToolRegistration } from "./connector-write-registrations.ts";

/**
 * The action type a write registration declares as `mutates`, read from its call's own text
 * (spec § 6.3). Three shapes, each from `@nimbus-dev/connectors@0.2.4`; anything else is a REASON
 * the sync test reports as a violation — never a skip, the I26 guard's fail-closed rule.
 */
export function resolveRegistrationMutates(
  sources: readonly PackageSource[],
  r: WriteToolRegistration,
): { value: string } | { reason: string } {
  const src = sources.find((s) => s.rel === r.file);
  if (src === undefined) return { reason: `no source for ${r.file}` };
  const call = src.text.slice(r.span[0], r.span[1] + 1);

  const literal = /\bmutates\s*:\s*(["'])([^"'\n]+)\1/.exec(call);
  if (literal?.[2] !== undefined) return { value: literal[2] };

  const tpl = /\bmutates\s*:\s*`([^`]*)`/.exec(call);
  if (tpl?.[1] !== undefined) return fromKitTemplate(call, tpl[1], r.id);

  for (const m of call.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*(["'])([^"'\n]+)\2\s*\)/g)) {
    const [, fn, , arg] = m;
    if (fn !== undefined && arg !== undefined && takesMutatesFirst(sources, fn)) return { value: arg };
  }
  return { reason: `cannot resolve mutates for ${r.id} in ${r.file}:${String(r.line)}` };
}

/** `${p}_mail_send` id + `${p}.mail.send` mutates: recover p from the resolved id, substitute it. */
function fromKitTemplate(call: string, mutatesTpl: string, id: string): { value: string } | { reason: string } {
  const m = /^\$\{([A-Za-z_$][\w$]*)\}(.*)$/.exec(mutatesTpl);
  if (m === null) return { reason: `unsupported mutates template \`${mutatesTpl}\`` };
  const [, ident, mutSuffix] = m;
  const idTpl = new RegExp(String.raw`\(\s*\`\$\{${ident}\}([^\`]*)\``).exec(call);
  const idSuffix = idTpl?.[1];
  if (idSuffix === undefined || !id.endsWith(idSuffix) || id.length === idSuffix.length) {
    return { reason: `id ${id} does not share the template variable ${String(ident)}` };
  }
  return { value: `${id.slice(0, id.length - idSuffix.length)}${mutSuffix ?? ""}` };
}

function takesMutatesFirst(sources: readonly PackageSource[], fn: string): boolean {
  const re = new RegExp(String.raw`function\s+${fn}\s*(?:<[^>]*>)?\s*\(\s*mutates\s*:\s*string`);
  return sources.some((s) => re.test(s.text));
}
```

Create `proposable-actions.sync.test.ts`:

```ts
/**
 * Act-door routing sync (spec § 6.3): every PROPOSABLE_WRITE_TOOLS row is a write the INSTALLED
 * `@nimbus-dev/connectors` registers under that exact tool id, declaring `mutates` equal to the
 * action type, in the connector whose mesh server is `serviceOf(actionType)`. A connectors bump that
 * renames or re-scopes a proposable tool fails here, not at an owner's accept.
 */
import { describe, expect, test } from "bun:test";

import { serviceOf } from "../engine/service-of.ts";
import { PROPOSABLE_WRITE_TOOLS } from "./proposable-actions.ts";
import { resolveRegistrationMutates } from "./testing/registration-mutates.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "./testing/connector-write-registrations.ts";

const SOURCES = readConnectorPackageSources(installedConnectorsPackageRoot());
const SCAN = scanWriteToolRegistrations(SOURCES);

/** The mesh server a registration belongs to: its origin connector directory, `-` → `_`. */
function serverOf(origin: string): string {
  return (origin.split("/")[1] ?? "").replaceAll("-", "_");
}

describe("act-door routing table vs the installed connectors package", () => {
  for (const [type, tool] of Object.entries(PROPOSABLE_WRITE_TOOLS)) {
    test(`${type} → ${tool}`, () => {
      const hits = SCAN.registrations.filter(
        (r) => r.id === tool && serverOf(r.origin) === serviceOf(type),
      );
      expect(hits, `no write registered as ${tool} on server ${serviceOf(type)}`).toHaveLength(1);
      expect(resolveRegistrationMutates(SOURCES, hits[0] as (typeof hits)[number])).toEqual({ value: type });
    });
  }

  test("guard: the span offsets index the ORIGINAL text (a literal reads back)", () => {
    const r = SCAN.registrations.find((x) => x.id === "slack_message_post");
    const src = SOURCES.find((s) => s.rel === r?.file);
    expect(src?.text.slice(r?.span[0] ?? 0, (r?.span[1] ?? 0) + 1)).toContain('"slack_message_post"');
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/connectors/testing packages/gateway/src/connectors/proposable-actions.sync.test.ts packages/gateway/src/connectors/connector-write-sync.test.ts`
Expected: PASS for all 30 rows, and the existing I26 sync guard still passes. If a † row fails, move it to `unroutable` in Task 3's table, update both tests' expected lists, and note the change for the PR body (see "† routing rows").

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors
git commit -m "test(connectors): act-door routing table proven against the installed connectors package"
```

---

### Task 5: Validate the action payload

**Files:**
- Modify: `packages/gateway/src/mcp-sink/capture-validate.ts`
- Test: `packages/gateway/src/mcp-sink/capture-validate.test.ts`

**Interfaces:**
- Produces:
  - `validateActionPayload(raw: unknown): ActionPayload`
  - `validateCapturePayload("action", raw, now)` → `{ kind: "action", payload }`
  - constants `ACTION_TYPE_MAX = 128`, `ACTION_SUMMARY_MAX = 300`

- [ ] **Step 1: Write the failing test**

```ts
describe("action payload (PR 3)", () => {
  const ok = { actionType: "slack.message.post", input: { channel: "C1", text: "hi" }, summary: "why" };
  test("rebuilds exactly {actionType, input, summary}; siblings dropped; input verbatim", () => {
    const v = validateCapturePayload("action", { ...ok, extra: 1 }, 0);
    expect(v).toEqual({ kind: "action", payload: ok });
  });
  test("an mcpToolId key in input REFUSES (never dropped)", () => {
    expect(() =>
      validateCapturePayload("action", { ...ok, input: { mcpToolId: "x", text: "hi" } }, 0),
    ).toThrow(/mcpToolId/);
  });
  test("an mcpToolId key beside actionType REFUSES too (not silently dropped by the rebuild)", () => {
    expect(() => validateCapturePayload("action", { ...ok, mcpToolId: "slack_admin_delete" }, 0)).toThrow(/mcpToolId/);
  });
  test.each([[0x200e], [0x200f], [0x2060], [0x2063], [0x00ad], [0x061c]])(
    "code point %d is stripped from stored prose (widened Trojan-Source set)",
    (cp) => {
      const v = validateCapturePayload("action", { ...ok, summary: `a${String.fromCodePoint(cp)}b` }, 0);
      expect(v.kind === "action" && v.payload.summary).toBe("ab");
    },
  );
  test.each([[null], [[]], ["s"], [3]])("input %p refuses", (input) => {
    expect(() => validateCapturePayload("action", { ...ok, input }, 0)).toThrow(CaptureError);
  });
  test("actionType must be a non-empty string ≤ 128 with no whitespace", () => {
    for (const t of ["", " ", "a".repeat(129), 7, "slack. message"]) {
      expect(() => validateCapturePayload("action", { ...ok, actionType: t }, 0)).toThrow(CaptureError);
    }
  });
  test("summary truncates at 300 and is control-stripped; missing summary refuses", () => {
    const v = validateCapturePayload("action", { ...ok, summary: `a\u001b[2J${"x".repeat(400)}` }, 0);
    expect(v.kind === "action" && v.payload.summary.length).toBeLessThanOrEqual(300);
    expect(v.kind === "action" && v.payload.summary.includes("\u001b")).toBe(false);
    expect(() => validateCapturePayload("action", { actionType: ok.actionType, input: {} }, 0)).toThrow();
  });
  test("the 64 KiB total cap refuses", () => {
    expect(() =>
      validateCapturePayload("action", { ...ok, input: { text: "x".repeat(70_000) } }, 0),
    ).toThrow(/exceeds/);
  });
  test("input values are NOT stripped — what is approved is what is sent", () => {
    const v = validateCapturePayload("action", { ...ok, input: { text: "a\u202Eb" } }, 0);
    expect(v.kind === "action" && v.payload.input["text"]).toBe("a\u202Eb");
  });
  test("referencedItemIds is empty for an action", () => {
    expect(referencedItemIds(validateCapturePayload("action", ok, 0))).toEqual([]);
  });
});
```

The escapes above sit inside TS string literals. If the format hook rewrites them, build them with `String.fromCodePoint` the way the file's existing `ZWSP` constant does.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/mcp-sink/capture-validate.test.ts`
Expected: FAIL — `action payloads are validated by validateActionPayload` (Task 1 placeholder arm).

- [ ] **Step 3: Implement**

```ts
export const ACTION_TYPE_MAX = 128;
export const ACTION_SUMMARY_MAX = 300;

/**
 * Whitelist-rebuild an action proposal (spec § 7 step 5). `input` is kept VERBATIM — the owner
 * approves the exact bytes that will be sent, so stripping a value would make the approved call
 * differ from the dispatched one; the consent prompt renders invisibles visibly instead (Review
 * Focus 1). An `mcpToolId` key REFUSES wherever the agent puts it — beside `actionType` or inside
 * `input`: the dispatcher treats that key as a tool selector, and a refusal (unlike the rebuild's
 * silent drop of an unknown sibling) is visible to the agent and lands in the refusal counter.
 */
export function validateActionPayload(raw: unknown): ActionPayload {
  const o = asObject(raw);
  const t = o["actionType"];
  if (typeof t !== "string" || t === "" || t.length > ACTION_TYPE_MAX || /\s/.test(t)) {
    invalid(`actionType must be a non-empty string of at most ${String(ACTION_TYPE_MAX)} characters with no whitespace`);
  }
  const input = o["input"];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalid("input must be a JSON object");
  }
  if (Object.hasOwn(o, "mcpToolId") || Object.hasOwn(input, "mcpToolId")) {
    invalid("an action proposal may not carry mcpToolId: the gateway chooses the tool");
  }
  return capped<ActionPayload>({
    actionType: t,
    input: input as Record<string, unknown>,
    summary: line(o["summary"], "summary", ACTION_SUMMARY_MAX, true) ?? "",
  });
}
```

Replace the Task 1 placeholder arm in `validateCapturePayload` with `case "action": return { kind, payload: validateActionPayload(raw) };`, and import `ActionPayload`. D32(g), added in Task 12, will confine the `mcpToolId` literal under `mcp-sink/` to this file.

Widen PR 2's two strip sets, `CONTROL_RE` and `BODY_CONTROL_RE`, by the same characters Task 7's `INVISIBLE_RE` escapes: they stop at U+200D, so LRM/RLM (U+200E/F), U+2060–2065 and U+206A–206F (word joiner, invisible operators, deprecated format chars), the soft hyphen U+00AD, the Arabic letter mark U+061C and the Mongolian vowel separator U+180E all pass into stored text today. An action's `summary` is stored through `line()`, so it inherits the gap. Replace the tail `​-‍  ‪-‮⁦-⁩﻿` in BOTH with `­؜᠎​-‏ -‮⁠-⁯﻿`, keep each regex's own C0 head unchanged, and add those characters to the header comment. Stripping more only shrinks what is stored; existing rows are untouched. The comment says to keep these in step with the CLI's `UNSAFE_TEXT_RE`; Task 13 does that half.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/mcp-sink/capture-validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/mcp-sink/capture-validate.ts packages/gateway/src/mcp-sink/capture-validate.test.ts
git commit -m "feat(mcp): validate action proposals — verbatim input, mcpToolId refused"
```

---

### Task 6: `submitCapture` becomes async (refactor only)

**Files:**
- Modify: `packages/gateway/src/mcp-sink/capture-gate.ts`
- Modify: `packages/gateway/src/mcp-sink/capture-gate.test.ts`, `packages/gateway/src/ipc/capture-rpc.test.ts`, `packages/gateway/src/security-invariants.test.ts` (I28 order-pin anchor ~line 2620, and the sync `const { id } = submitCapture(` call ~line 2724), and any other caller (`grep -rn "submitCapture(" packages/gateway --include=*.ts`)

**Interfaces:**
- Produces: `submitCapture(deps, caller, input): Promise<{ id: string; state: CaptureState; expiresAt?: number }>`. Behaviour is unchanged in this task.

- [ ] **Step 1: Change the signature**

Make `submitCapture` `async` and its return type `Promise<{ id: string; state: CaptureState; expiresAt?: number }>`. Do not change the body. A throw inside an async function becomes a rejected promise, so callers must await it.

- [ ] **Step 2: Convert the tests**

In `capture-gate.test.ts`, add an async twin of `codeOf`:

```ts
async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  throw new Error("expected CaptureError");
}
```

Then make every test that calls `submitCapture` `async`, `await` each call, and replace `codeOf(() => submitCapture(...))` with `await codeOfAsync(() => submitCapture(...))`. `expect(() => submitCapture(...)).toThrow(...)` becomes `await expect(submitCapture(...)).rejects.toThrow(...)`. Run `bun run typecheck`: a sync use of a Promise result (for example `.id` on it) is a type error, which is how stragglers are found.

In `security-invariants.test.ts`, two edits keep this commit green:
- The I28 order test slices from `src.indexOf("export function submitCapture")`. Against `export async function submitCapture` that returns `-1`, `slice(-1)` keeps one character, every `indexOf` in the order array misses, and the test goes red. Change the anchor to `src.indexOf("export async function submitCapture")`. Keep the exact declaration text rather than a looser `"submitCapture("`, which could match an earlier call site and pin the order against the wrong body.
- The capture round-trip test (~line 2724) destructures `const { id } = submitCapture(`. Make it `await submitCapture(`; the enclosing test is already `async`.

- [ ] **Step 3: Run the tests**

Run: `bun test packages/gateway/src/mcp-sink packages/gateway/src/ipc/capture-rpc.test.ts packages/gateway/src/security-invariants.test.ts -t "I28" && bun run typecheck`
Expected: PASS, with the same test count as before the change.

- [ ] **Step 4: Commit**

```bash
git add -A packages/gateway/src
git commit -m "refactor(mcp): submitCapture is async (the act door's configured check reads the Vault)"
```

---

### Task 7: The act door in the gate — submit, expiry, accept, status, state

**Files:**
- Create: `packages/gateway/src/mcp-sink/capture-act.ts`
- Modify: `packages/gateway/src/mcp-sink/capture-gate.ts`
- Modify: `packages/gateway/src/security-invariants.test.ts` (I28 order test, ~line 2618)
- Test: `packages/gateway/src/mcp-sink/capture-act.test.ts` (create), `packages/gateway/src/mcp-sink/capture-gate.test.ts`

**Interfaces:**
- Consumes:
  - Task 1 types
  - Task 2 store methods
  - Task 5 `validateCapturePayload("action", …)`
  - `serviceOf` (`engine/service-of.ts`)
- Produces (capture-gate.ts):
  - `CaptureGateDeps` += optional `classifyAction?(actionType: string): ActionVerdict`, `isServiceConfigured?(service: string): Promise<boolean>`, `listProposableActionTypes?(): Promise<readonly string[]>`
  - `acceptCapture(deps, caller, idRaw, act?: ActDeps)`: returns the native result synchronously, or `Promise<ActionAcceptResult>` for an action
  - `captureStateFor(deps, caller, idRaw): CaptureStateView`
  - `captureStatus(deps): Promise<CaptureStatus>`
  - `CaptureStatus` += `actionEnabled`, `proposableActionTypes`, `actionPending`, `actionMaxPending`, `actionTtlHours`, `actionExpiringWithinHour`
  - `CaptureDetail` / `CaptureSummary` += `expiresAt: number | null`; `CaptureDetail` += `outcomeRef`, `errorCode`
- Produces (capture-act.ts):
  - `type ActGateDeps = Pick<CaptureGateDeps, "db"|"store"|"capability"|"classifyAction"|"isServiceConfigured"|"now">`
  - `type ActionAcceptResult = { id; state: "executed"|"rejected"|"failed"; outcomeRef?: string; errorCode?: ActionErrorCode }`
  - `acceptAction(deps: ActGateDeps, caller: CaptureCaller, row: CaptureRow, act: ActDeps | undefined): Promise<ActionAcceptResult>`
  - `formatActionConsent(provenance: ActionProvenance, actionType: string, input: Readonly<Record<string, unknown>>): string`
  - `outcomeRefOf(result: unknown): string | undefined`
  - `classifyActionError(e: unknown): ActionErrorCode`
  - `expireDueActionsAudited(deps: Pick<ActGateDeps,"db"|"store">, nowMs: number, sessionId: string): string[]`
  - `reconcileActionsAtBoot(deps: Pick<ActGateDeps,"db"|"store">, nowMs: number): { expired: number; interrupted: number }`

- [ ] **Step 1: Write the failing `capture-act.test.ts`**

```ts
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import {
  acceptAction,
  type ActGateDeps,
  classifyActionError,
  formatActionConsent,
  outcomeRefOf,
  reconcileActionsAtBoot,
} from "./capture-act.ts";
import { type CaptureCapability, resolveCaptureCapability } from "./capture-capability.ts";
import { CaptureStore } from "./capture-store.ts";
import { type ActDeps, CaptureError, type CaptureRow } from "./capture-types.ts";

const OWNER = { clientId: "c-cli", kind: "unknown" as const };
const MCP = { clientId: "c-mcp", kind: "mcp" as const };
const RLO = String.fromCodePoint(0x202e);
let db: Database;
let clock: number;
let cap: CaptureCapability;
let verdict: "proposable" | "denied";
let configured: boolean;
let deps: ActGateDeps;

function capWith(disabled: string[] = []): CaptureCapability {
  return resolveCaptureCapability(
    { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] } },
    { capabilitiesDisabled: new Set(disabled) },
  );
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  clock = 1_000;
  cap = capWith();
  verdict = "proposable";
  configured = true;
  deps = {
    db,
    store: new CaptureStore(db),
    capability: () => cap,
    classifyAction: () => (verdict === "proposable" ? { kind: "proposable" } : { kind: "denied", class: "vcs" }),
    isServiceConfigured: () => Promise.resolve(configured),
    now: () => clock,
  };
  deps.store.insert({
    id: "cap_a", kind: "action", state: "proposed", itemId: null,
    payloadJson: JSON.stringify({ actionType: "slack.message.post", input: { text: "hi" }, summary: "why" }),
    payloadBytes: 10, clientLabel: "agent", sessionId: "s", createdAt: 500, expiresAt: 2_000,
  });
});
afterEach(() => db.close());

function row(): CaptureRow {
  return deps.store.get("cap_a") as CaptureRow;
}
function act(out: Awaited<ReturnType<ActDeps["execute"]>> | Error): ActDeps & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    execute: (...a) => {
      calls.push(a);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    },
  };
}
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof CaptureError) return e.code; throw e; }
  throw new Error("expected CaptureError");
}
function audits(): Array<{ action_type: string; hitl_status: string; action_json: string }> {
  return db.query("SELECT action_type, hitl_status, action_json FROM audit_log WHERE action_type LIKE 'capture.action.%' ORDER BY id").all() as never;
}

describe("acceptAction — ordered refusals", () => {
  test("1 capability: mcp_action locked → DISABLED, row stays proposed, nothing executed", async () => {
    cap = capWith(["mcp_action"]);
    const a = act({ status: "ok", result: {} });
    expect(await code(acceptAction(deps, OWNER, row(), a))).toBe("ERR_CAPTURE_DISABLED");
    expect(row().state).toBe("proposed");
    expect(a.calls).toHaveLength(0);
  });
  test("act absent → DISABLED (no fallback)", async () => {
    expect(await code(acceptAction(deps, OWNER, row(), undefined))).toBe("ERR_CAPTURE_DISABLED");
  });
  test("2 an mcp client is refused", async () => {
    expect(await code(acceptAction(deps, MCP, row(), act({ status: "rejected" })))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
  });
  test("3 at expires_at exactly: expired + audited + refused EXPIRED (Review Focus 2)", async () => {
    clock = 2_000;
    expect(await code(acceptAction(deps, OWNER, row(), act({ status: "ok", result: {} })))).toBe("ERR_CAPTURE_EXPIRED");
    expect(row().state).toBe("expired");
    expect(audits().map((r) => r.action_type)).toEqual(["capture.action.expire"]);
  });
  test("4 re-classify: denied now → NOT_PROPOSABLE, stays proposed", async () => {
    verdict = "denied";
    expect(await code(acceptAction(deps, OWNER, row(), act({ status: "ok", result: {} })))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
    expect(row().state).toBe("proposed");
  });
  test("4 re-check configured: removed connector → UNCONFIGURED, stays proposed", async () => {
    configured = false;
    expect(await code(acceptAction(deps, OWNER, row(), act({ status: "ok", result: {} })))).toBe("ERR_CAPTURE_CONNECTOR_UNCONFIGURED");
    expect(row().state).toBe("proposed");
  });
  test("5 claim lost (expired during the configured await) → STATE, no execute", async () => {
    deps = { ...deps, isServiceConfigured: () => { clock = 2_000; return Promise.resolve(true); } };
    const a = act({ status: "ok", result: {} });
    expect(await code(acceptAction(deps, OWNER, row(), a))).toBe("ERR_CAPTURE_STATE");
    expect(a.calls).toHaveLength(0);
  });
});

describe("acceptAction — outcomes", () => {
  test("ok → executed with outcome_ref; accept + outcome audits, both not_required", async () => {
    const a = act({ status: "ok", result: { url: "https://slack.example/p/1", body: "secret" } });
    const out = await acceptAction(deps, OWNER, row(), a);
    expect(out).toEqual({ id: "cap_a", state: "executed", outcomeRef: "https://slack.example/p/1" });
    expect(row()).toMatchObject({ state: "executed", outcomeRef: "https://slack.example/p/1" });
    expect(a.calls[0]?.[0]).toBe("slack.message.post");
    expect(a.calls[0]?.[1]).toEqual({ text: "hi" });
    expect(a.calls[0]?.[2]).toMatchObject({ captureId: "cap_a", clientLabel: "agent", createdAt: 500, expiresAt: 2_000, summary: "why" });
    expect(audits().map((r) => [r.action_type, r.hitl_status])).toEqual([
      ["capture.action.accept", "not_required"],
      ["capture.action.outcome", "not_required"],
    ]);
    expect(audits()[1]?.action_json).not.toContain("secret");
  });
  test("execute sees the row as executing (claim happened first)", async () => {
    let seen = "";
    await acceptAction(deps, OWNER, row(), { execute: () => { seen = row().state; return Promise.resolve({ status: "rejected" }); } });
    expect(seen).toBe("executing");
  });
  test("rejected → rejected", async () => {
    expect((await acceptAction(deps, OWNER, row(), act({ status: "rejected" }))).state).toBe("rejected");
    expect(row().state).toBe("rejected");
  });
  test("throw → failed with a classified code, never the message", async () => {
    const out = await acceptAction(deps, OWNER, row(), act(new Error("Tool slack_message_post exceeded 60000ms timeout")));
    expect(out).toEqual({ id: "cap_a", state: "failed", errorCode: "ERR_ACTION_TIMEOUT" });
    expect(row().errorCode).toBe("ERR_ACTION_TIMEOUT");
  });
  test("a second accept refuses STATE", async () => {
    await acceptAction(deps, OWNER, row(), act({ status: "rejected" }));
    expect(await code(acceptAction(deps, OWNER, row(), act({ status: "rejected" })))).toBe("ERR_CAPTURE_STATE");
  });
});

describe("pure helpers", () => {
  test("classifyActionError", () => {
    expect(classifyActionError(new Error("Tool x exceeded 5ms timeout"))).toBe("ERR_ACTION_TIMEOUT");
    expect(classifyActionError(new Error("Tool not found"))).toBe("ERR_ACTION_TOOL_NOT_FOUND");
    expect(classifyActionError(new Error('MCP tool "x" has no execute implementation'))).toBe("ERR_ACTION_TOOL_NOT_FOUND");
    expect(classifyActionError("weird")).toBe("ERR_ACTION_DISPATCH");
  });
  test("outcomeRefOf: https only, ≤ 512, field order url > html_url > webUrl > permalink", () => {
    expect(outcomeRefOf({ permalink: "https://b", url: "https://a" })).toBe("https://a");
    expect(outcomeRefOf({ url: "http://a", html_url: "https://h" })).toBe("https://h");
    expect(outcomeRefOf({ url: `https://${"a".repeat(600)}` })).toBeUndefined();
    expect(outcomeRefOf({ url: "javascript:alert(1)" })).toBeUndefined();
    expect(outcomeRefOf([{ url: "https://a" }])).toBeUndefined();
    expect(outcomeRefOf(null)).toBeUndefined();
  });
  test("formatActionConsent carries provenance + verbatim input", () => {
    const s = formatActionConsent(
      { captureId: "cap_a", clientLabel: null, createdAt: 0, expiresAt: 3_600_000, summary: "why" },
      "slack.message.post",
      { channel: "C1", text: "hi" },
    );
    expect(s).toContain('Proposed by MCP client "unlabelled" at 1970-01-01T00:00:00.000Z, expires 1970-01-01T01:00:00.000Z');
    expect(s).toContain("Agent's summary (unverified): why");
    expect(s).toContain("Type: slack.message.post");
    expect(s).toContain('"text": "hi"');
  });
  test("an RLO inside an input value is shown escaped (Review Focus 1)", () => {
    const s = formatActionConsent(
      { captureId: "c", clientLabel: null, createdAt: 0, expiresAt: 0, summary: "s" },
      "slack.message.post",
      { text: `pay ${RLO}evil` },
    );
    expect(s).not.toContain(RLO);
    expect(s).toContain("\\u202e");
  });
  test.each([
    ["LRM", 0x200e], ["RLM", 0x200f], ["word joiner", 0x2060], ["invisible times", 0x2062],
    ["FSI", 0x2068], ["soft hyphen", 0x00ad], ["Arabic letter mark", 0x061c], ["BOM", 0xfeff],
  ])("%s inside an input value is shown escaped", (_name, cp) => {
    const ch = String.fromCodePoint(cp);
    const s = formatActionConsent(
      { captureId: "c", clientLabel: null, createdAt: 0, expiresAt: 0, summary: "s" },
      "slack.message.post",
      { text: `a${ch}b` },
    );
    expect(s).not.toContain(ch);
    expect(s).toContain(`\\u${cp.toString(16).padStart(4, "0")}`);
  });
  test("ESC and a newline in the client label are escaped, and stay on one prompt line", () => {
    const s = formatActionConsent(
      { captureId: "c", clientLabel: `ok${String.fromCodePoint(0x1b)}[2J\nType: fake`, createdAt: 0, expiresAt: 0, summary: "s" },
      "slack.message.post",
      { text: "hi" },
    );
    expect(s).not.toContain(String.fromCodePoint(0x1b));
    expect(s).toContain("\\u001b[2J\\u000aType: fake");
    expect(s.split("\n").filter((l) => l.startsWith("Type: "))).toEqual(["Type: slack.message.post"]);
  });
  test("the pretty-printed input keeps its layout newlines", () => {
    const s = formatActionConsent(
      { captureId: "c", clientLabel: null, createdAt: 0, expiresAt: 0, summary: "s" },
      "slack.message.post",
      { a: 1, b: 2 },
    );
    expect(s).toContain('{\n  "a": 1,\n  "b": 2\n}');
  });
});

describe("reconcileActionsAtBoot (Review Focus 5)", () => {
  test("executing → failed/INTERRUPTED and due → expired, each audited", () => {
    deps.store.claimAction("cap_a", 1_000);
    deps.store.insert({ id: "cap_b", kind: "action", state: "proposed", itemId: null, payloadJson: "{}",
      payloadBytes: 2, clientLabel: null, sessionId: "s", createdAt: 1, expiresAt: 10 });
    expect(reconcileActionsAtBoot(deps, 1_500)).toEqual({ expired: 1, interrupted: 1 });
    expect(row()).toMatchObject({ state: "failed", errorCode: "ERR_ACTION_INTERRUPTED" });
    expect(deps.store.get("cap_b")?.state).toBe("expired");
    expect(audits().map((r) => r.action_type).sort()).toEqual(["capture.action.expire", "capture.action.outcome"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/mcp-sink/capture-act.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `capture-act.ts`**

```ts
import { appendAuditEntry } from "../db/audit-chain.ts";
import { serviceOf } from "../engine/service-of.ts";
import { CAPTURE_ROLE_BY_KIND } from "./capture-client-policy.ts";
import type { CaptureCaller, CaptureGateDeps } from "./capture-gate.ts";
import {
  type ActDeps,
  type ActionErrorCode,
  type ActionPayload,
  type ActionProvenance,
  CaptureError,
  type CaptureRow,
} from "./capture-types.ts";

/**
 * Invariant I28's act door (spec 2026-10-15 § 8). The ONE place a proposed connector action leaves
 * the machine: `acceptAction`, defined only here and called only from `capture-gate.ts`'s
 * `acceptCapture` (static D32(e)). Read the fixed order top to bottom. This module never imports
 * the executor or `connectors/` (D32(f)): execution arrives as `ActDeps`, built per call by
 * `ipc/capture-rpc.ts`.
 */
export type ActGateDeps = Pick<
  CaptureGateDeps,
  "db" | "store" | "capability" | "classifyAction" | "isServiceConfigured" | "now"
>;

export type ActionAcceptResult = {
  readonly id: string;
  readonly state: "executed" | "rejected" | "failed";
  readonly outcomeRef?: string;
  readonly errorCode?: ActionErrorCode;
};

const OUTCOME_FIELDS = ["url", "html_url", "webUrl", "permalink"] as const;
const OUTCOME_MAX = 512;
// Shown VISIBLY in the prompt, never rendered: the input is sent verbatim and cannot be stripped
// (Review Focus 1). Covers C0 controls except LF (the provenance lines never pass through
// JSON.stringify, and the pretty-printed JSON's own layout newlines must survive), DEL + C1, soft
// hyphen, the Arabic letter mark, the Mongolian vowel separator, ZWSP..RLM (incl. LRM/RLM),
// U+2028..U+202E (line/para separators + bidi embeddings/overrides), U+2060..U+206F (word joiner,
// invisible operators, bidi isolates, deprecated format chars), the BOM and the interlinear
// annotation characters. NOT U+202F (narrow no-break space): it renders as a space.
const INVISIBLE_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters is the purpose
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;

function audit(deps: Pick<ActGateDeps, "db">, actionType: string, body: Record<string, unknown>, now: number, sessionId: string): void {
  appendAuditEntry(deps.db, {
    actionType,
    // I4: no consent gate ran HERE — the approval is the executor's own `approved` row.
    hitlStatus: "not_required",
    actionJson: JSON.stringify(body),
    timestamp: now,
    sessionId,
  });
}

export function expireDueActionsAudited(
  deps: Pick<ActGateDeps, "db" | "store">,
  nowMs: number,
  sessionId: string,
): string[] {
  let ids: string[] = [];
  deps.db.transaction(() => {
    ids = deps.store.expireDueActions(nowMs);
    for (const id of ids) {
      audit(deps, "capture.action.expire", { captureId: id, expiredAt: nowMs, outcome: "expired" }, nowMs, sessionId);
    }
  })();
  return ids;
}

export function reconcileActionsAtBoot(
  deps: Pick<ActGateDeps, "db" | "store">,
  nowMs: number,
): { expired: number; interrupted: number } {
  const expired = expireDueActionsAudited(deps, nowMs, "gateway-boot");
  let interrupted: string[] = [];
  deps.db.transaction(() => {
    interrupted = deps.store.failInterruptedActions(nowMs);
    for (const id of interrupted) {
      audit(deps, "capture.action.outcome", { captureId: id, outcome: "failed", errorCode: "ERR_ACTION_INTERRUPTED" }, nowMs, "gateway-boot");
    }
  })();
  return { expired: expired.length, interrupted: interrupted.length };
}

export function classifyActionError(e: unknown): ActionErrorCode {
  const msg = e instanceof Error ? e.message : "";
  if (/ exceeded \d+ms timeout$/.test(msg)) return "ERR_ACTION_TIMEOUT";
  if (msg === "Tool not found" || / has no execute implementation$/.test(msg)) return "ERR_ACTION_TOOL_NOT_FOUND";
  return "ERR_ACTION_DISPATCH";
}

export function outcomeRefOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const r = result as Record<string, unknown>;
  for (const k of OUTCOME_FIELDS) {
    const v = r[k];
    if (typeof v === "string" && v.length <= OUTCOME_MAX && v.startsWith("https:")) return v;
  }
  return undefined;
}

export function formatActionConsent(
  p: ActionProvenance,
  actionType: string,
  input: Readonly<Record<string, unknown>>,
): string {
  const visible = (s: string): string =>
    s.replace(INVISIBLE_RE, (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
  // A one-line field must not start a new prompt line either: LF is escaped here too.
  const visibleLine = (s: string): string => visible(s).replaceAll("\n", "\\u000a");
  return [
    "Agent-proposed action — requires your approval",
    `Proposed by MCP client "${visibleLine(p.clientLabel ?? "unlabelled")}" at ${new Date(p.createdAt).toISOString()}, expires ${new Date(p.expiresAt).toISOString()}`,
    `Agent's summary (unverified): ${visibleLine(p.summary)}`,
    `Type: ${actionType}`,
    "Input (verbatim, exactly what will be sent):",
    visible(JSON.stringify(input, null, 2)),
  ].join("\n");
}

function parseStored(row: CaptureRow): ActionPayload {
  if (row.payloadJson === null || row.expiresAt === null) {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${row.id} has no action payload`);
  }
  return JSON.parse(row.payloadJson) as ActionPayload;
}

export async function acceptAction(
  deps: ActGateDeps,
  caller: CaptureCaller,
  row: CaptureRow,
  act: ActDeps | undefined,
): Promise<ActionAcceptResult> {
  // 1. Capability incl. mcp_action (live, fail-closed). No ActDeps means no way to execute: refuse.
  const cap = deps.capability();
  if (!cap.actionEnabled || act === undefined) {
    throw new CaptureError("ERR_CAPTURE_DISABLED", "the act door is off; rejecting still works");
  }
  // 2. Owner only.
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "owner") {
    throw new CaptureError("ERR_CAPTURE_FORBIDDEN_CLIENT", `a ${caller.kind} client cannot review captures`);
  }
  // 3. State + expiry. The row is read ONCE (by the caller) and never re-read after the claim.
  if (row.state !== "proposed") {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${row.id} is ${row.state}; only a proposed action can be accepted`);
  }
  const stored = parseStored(row);
  const expiresAt = row.expiresAt as number;
  if (deps.now() >= expiresAt) {
    expireDueActionsAudited(deps, deps.now(), caller.clientId);
    throw new CaptureError("ERR_CAPTURE_EXPIRED", `capture ${row.id} expired; ask the agent to propose it again`);
  }
  // 4. Re-classify and re-check configured-ness (a --model revoke, a policy tightening, a removed
  //    connector). A refusal leaves the row proposed.
  const verdict = deps.classifyAction?.(stored.actionType) ?? { kind: "unknown" as const };
  if (verdict.kind !== "proposable") {
    throw new CaptureError("ERR_CAPTURE_ACTION_NOT_PROPOSABLE", `${stored.actionType} is not proposable now; the capture stays proposed`);
  }
  const configured = (await deps.isServiceConfigured?.(serviceOf(stored.actionType))) === true;
  if (!configured) {
    throw new CaptureError("ERR_CAPTURE_CONNECTOR_UNCONFIGURED", `${serviceOf(stored.actionType)} is not configured; the capture stays proposed`);
  }
  // 5. Claim: ONE transaction, CAS incl. the expiry predicate (closes the window across step 4's await).
  const claimAt = deps.now();
  let won = false;
  deps.db.transaction(() => {
    won = deps.store.claimAction(row.id, claimAt);
    if (won) audit(deps, "capture.action.accept", { captureId: row.id, actionType: stored.actionType }, claimAt, caller.clientId);
  })();
  if (!won) throw new CaptureError("ERR_CAPTURE_STATE", `capture ${row.id} changed state or expired concurrently`);
  // 6. Build from the row read in step 3.
  const provenance: ActionProvenance = {
    captureId: row.id,
    clientLabel: row.clientLabel,
    createdAt: row.createdAt,
    expiresAt,
    summary: stored.summary,
  };
  // 7. Execute through the executor the RPC layer built (I2, I29, I22, I42 apply unchanged).
  let result: ActionAcceptResult;
  try {
    const out = await act.execute(stored.actionType, stored.input, provenance);
    if (out.status === "ok") {
      const outcomeRef = outcomeRefOf(out.result);
      result = outcomeRef === undefined
        ? { id: row.id, state: "executed" }
        : { id: row.id, state: "executed", outcomeRef };
    } else {
      result = { id: row.id, state: "rejected" };
    }
  } catch (e) {
    result = { id: row.id, state: "failed", errorCode: classifyActionError(e) };
  }
  // 8. Finalize: ONE transaction. A failure here leaves `executing` for the boot reconcile.
  const doneAt = deps.now();
  try {
    deps.db.transaction(() => {
      const ok = deps.store.finalizeAction(row.id, result.state, {
        ...(result.outcomeRef === undefined ? {} : { outcomeRef: result.outcomeRef }),
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      }, doneAt);
      if (!ok) throw new Error(`capture ${row.id} was not executing at finalize`);
      audit(deps, "capture.action.outcome", {
        captureId: row.id,
        actionType: stored.actionType,
        outcome: result.state,
        ...(result.outcomeRef === undefined ? {} : { outcomeRef: result.outcomeRef }),
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      }, doneAt, caller.clientId);
    })();
  } catch (e) {
    console.error(`[capture-act] finalize failed for ${row.id} after dispatch (state stays executing; boot marks it failed):`, e);
  }
  return result;
}
```

Every audit `actionJson` here is built from fixed fields: a capture id, an action type, a code and an https ref. None of them carries input, so `redactAuditPayload` is not needed. Spec § 8.2 asks for `redactAuditPayload`; if a reviewer requires it, wrap `JSON.stringify(body)` in it. Read its signature in `db/audit-redact.ts` first: `grep -rn "export function redactAuditPayload" packages/gateway/src`.

- [ ] **Step 4: Wire the gate (`capture-gate.ts`)**

1. Deps: add the three optional members to `CaptureGateDeps` (see Interfaces). Import `ActDeps` and `ActionVerdict` as types from `./capture-types.ts`.
2. Submit step 1: right after the `cap.enabled` refusal, add:
   ```ts
   const rawKind = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["kind"] : undefined;
   if (rawKind === "action" && !cap.actionEnabled) {
     refuseUnaudited(deps, "ERR_CAPTURE_DISABLED", "the act door is off (mcp_action or kinds)");
   }
   ```
3. Steps 5a/5b: after step 5's `validateCapturePayload` succeeds, add:
   ```ts
   if (v.kind === "action") {
     const verdict = deps.classifyAction?.(v.payload.actionType) ?? { kind: "unknown" as const };
     if (verdict.kind !== "proposable") {
       refuseAudited(deps, caller, "action", clientLabel, "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
         `${v.payload.actionType} cannot be proposed (${verdict.kind === "denied" ? verdict.class : "unknown action type"})`);
     }
     if ((await deps.isServiceConfigured?.(serviceOf(v.payload.actionType))) !== true) {
       refuseAudited(deps, caller, "action", clientLabel, "ERR_CAPTURE_CONNECTOR_UNCONFIGURED",
         `${serviceOf(v.payload.actionType)} is not configured on this machine`);
     }
   }
   ```
   Everything after this point stays synchronous through the write, so a concurrent submit cannot slip past the caps (spec § 7).
4. Step 8: replace the `countByState("proposed")` check with:
   ```ts
   const proposal = v.kind !== "note";
   if (v.kind === "action") {
     if (deps.store.countPendingActions(now) >= cap.config.actionMaxPending) {
       refuseAudited(deps, caller, kindRaw, clientLabel, "ERR_CAPTURE_QUEUE_FULL",
         `${String(cap.config.actionMaxPending)} proposed actions already await the owner`);
     }
   } else if (proposal && deps.store.countPendingNative() >= cap.config.maxPending) {
     /* existing refusal text unchanged */
   }
   ```
5. Write: compute `const expiresAt = v.kind === "action" ? now + cap.config.actionTtlHours * HOUR_MS : null;` and pass `expiresAt` to `insert`. Add `actionType` to the `capture.submit` audit body when `v.kind === "action"`. Return `expiresAt === null ? { id, state } : { id, state, expiresAt }`.
6. Lazy expiry: at the top of `listCaptures` and `getCapture` (after `requireOwner`), of the new `captureStateFor`, and of `captureStatus`, call `expireDueActionsAudited(deps, deps.now(), "<sessionId>")`. Use `caller.clientId` where a caller exists and `"capture-status"` in `captureStatus`.
7. `acceptCapture`: add a 4th parameter `act?: ActDeps` and widen the return type to `{ id: string; state: "accepted"; nativeRef: string } | Promise<ActionAcceptResult>`. Keep step 1 (`cap.enabled`) and step 2 (owner). After reading the row, before the `state !== "proposed"` check, add `if (row.kind === "action") return acceptAction(deps, caller, row, act);`. The native path is otherwise unchanged.
8. `revokeCapture`: after the `NOT_FOUND` check, add:
   ```ts
   if (row.kind === "action") {
     throw new CaptureError("ERR_CAPTURE_STATE",
       "an executed action cannot be undone; reject a proposed one with `nimbus captures reject`");
   }
   ```
9. `rejectCapture`: no change. It is kind-agnostic, and `markRejected` matches the action's `proposed` state.
10. `titleOf`: for `kind === "action"`, return `${p.actionType}: ${p.summary}`.slice(0, 120). Add `expiresAt: row.expiresAt` to `summarize`, and `outcomeRef`/`errorCode` to `getCapture`'s detail.
11. Add `captureStateFor`:
    ```ts
    export interface CaptureStateView {
      readonly kind: CaptureKind;
      readonly state: CaptureState;
      readonly expiresAt?: number;
      readonly outcomeRef?: string;
      readonly errorCode?: string;
    }
    /** `capture.state` (spec § 10): the agent polls a capture whose id it holds — never its payload. */
    export function captureStateFor(deps: CaptureGateDeps, caller: CaptureCaller, idRaw: unknown): CaptureStateView {
      if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "submit") {
        throw new CaptureError("ERR_CAPTURE_FORBIDDEN_CLIENT", "capture.state is for MCP clients; the owner uses captures.get");
      }
      const id = requireId(idRaw);
      expireDueActionsAudited(deps, deps.now(), caller.clientId);
      const row = deps.store.get(id);
      if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
      return {
        kind: row.kind, state: row.state,
        ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
        ...(row.outcomeRef === null ? {} : { outcomeRef: row.outcomeRef }),
        ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
      };
    }
    ```
12. `captureStatus` becomes `async`:
    ```ts
    export async function captureStatus(deps: CaptureGateDeps): Promise<CaptureStatus> {
      const now = deps.now();
      expireDueActionsAudited(deps, now, "capture-status");
      const cap = deps.capability();
      const types = cap.actionEnabled ? ((await deps.listProposableActionTypes?.()) ?? []) : [];
      const base = {
        enabled: cap.enabled,
        kinds: cap.enabled ? cap.kinds : [],
        pending: deps.store.countPendingNative(),
        maxPending: cap.config.maxPending,
        maxPerHour: cap.config.maxPerHour,
        refusedSinceStart: deps.refusals.snapshot(),
        actionEnabled: cap.actionEnabled,
        proposableActionTypes: types.slice(0, 200),
        actionPending: deps.store.countPendingActions(now),
        actionExpiringWithinHour: deps.store.countPendingActionsExpiringBy(now, now + HOUR_MS),
        actionMaxPending: cap.config.actionMaxPending,
        actionTtlHours: cap.config.actionTtlHours,
      };
      return cap.enabled ? base : { ...base, disabledReason: cap.reason };
    }
    ```

- [ ] **Step 5: Add the gate tests**

Append to `capture-gate.test.ts`. The `deps` built in `beforeEach` gets three extra members inside this describe.

```ts
describe("act door — submit (PR 3)", () => {
  const ACT = { kind: "action", payload: { actionType: "slack.message.post", input: { text: "hi" }, summary: "why" } };
  let verdict: "proposable" | "denied" | "unknown";
  let configured: boolean;
  beforeEach(() => {
    cap = onConfig({ kinds: ["note", "decision", "action"], actionMaxPending: 2 });
    verdict = "proposable";
    configured = true;
    deps = {
      ...deps,
      classifyAction: () => (verdict === "proposable" ? { kind: "proposable" } : verdict === "denied" ? { kind: "denied", class: "vcs" } : { kind: "unknown" }),
      isServiceConfigured: () => Promise.resolve(configured),
      listProposableActionTypes: () => Promise.resolve(["slack.message.post"]),
    };
  });
  test("stores proposed with expires_at = now + ttl; audited with actionType; no item", async () => {
    const out = await submitCapture(deps, MCP, ACT);
    expect(out).toEqual({ id: "cap_1", state: "proposed", expiresAt: clock + 24 * 3_600_000 });
    expect(deps.store.get("cap_1")?.itemId).toBeNull();
    expect(JSON.parse(auditRows().at(-1)?.action_json ?? "{}")).toMatchObject({ kind: "action", actionType: "slack.message.post" });
  });
  test("mcp_action locked: refused DISABLED, unaudited (step 1)", async () => {
    cap = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["action"] } },
      { capabilitiesDisabled: new Set(["mcp_action"]) },
    );
    expect(await codeOfAsync(() => submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_DISABLED");
    expect(auditRows()).toEqual([]);
  });
  test("5a not proposable / unknown: refused and audited", async () => {
    verdict = "denied";
    expect(await codeOfAsync(() => submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
    verdict = "unknown";
    expect(await codeOfAsync(() => submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
    expect(auditRows().filter((r) => r.hitl_status === "rejected")).toHaveLength(2);
  });
  test("deps absent: refused NOT_PROPOSABLE (fail-closed)", async () => {
    const { classifyAction: _c, ...rest } = deps;
    expect(await codeOfAsync(() => submitCapture(rest, MCP, ACT))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
  });
  test("5b unconfigured connector: refused and audited", async () => {
    configured = false;
    expect(await codeOfAsync(() => submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_CONNECTOR_UNCONFIGURED");
  });
  test("action and native pending caps are separate", async () => {
    await submitCapture(deps, MCP, ACT);
    await submitCapture(deps, MCP, ACT);
    expect(await codeOfAsync(() => submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_QUEUE_FULL");
    const d = await submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    expect(d.state).toBe("proposed");
  });
  test("lazy expiry: listing after the TTL shows expired, with one expire audit row", async () => {
    await submitCapture(deps, MCP, ACT);
    clock += 24 * 3_600_000;
    expect(listCaptures(deps, OWNER, {}).captures[0]?.state).toBe("expired");
    expect(auditRows().filter((r) => r.action_type === "capture.action.expire")).toHaveLength(1);
  });
  test("reject works on a proposed action; revoke refuses on any action", async () => {
    await submitCapture(deps, MCP, ACT);
    expect(codeOf(() => revokeCapture(deps, OWNER, "cap_1"))).toBe("ERR_CAPTURE_STATE");
    expect(rejectCapture(deps, OWNER, "cap_1").state).toBe("rejected");
  });
  test("a mcp_action lock after submit freezes accept; reject still works (Review Focus 3)", async () => {
    await submitCapture(deps, MCP, ACT);
    cap = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] } },
      { capabilitiesDisabled: new Set(["mcp_action"]) },
    );
    const exec = { execute: () => Promise.resolve({ status: "ok" as const, result: {} }) };
    expect(await codeOfAsync(() => Promise.resolve(acceptCapture(deps, OWNER, "cap_1", exec)))).toBe("ERR_CAPTURE_DISABLED");
    expect(deps.store.get("cap_1")?.state).toBe("proposed");
    expect(rejectCapture(deps, OWNER, "cap_1").state).toBe("rejected");
  });
  test("captureStateFor: mcp only, no payload, NOT_FOUND for unknown", async () => {
    await submitCapture(deps, MCP, ACT);
    expect(captureStateFor(deps, MCP, "cap_1")).toEqual({ kind: "action", state: "proposed", expiresAt: clock + 24 * 3_600_000 });
    expect(codeOf(() => captureStateFor(deps, OWNER, "cap_1"))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    expect(codeOf(() => captureStateFor(deps, MCP, "cap_9"))).toBe("ERR_CAPTURE_NOT_FOUND");
  });
  test("captureStatus reports the act-door fields", async () => {
    await submitCapture(deps, MCP, ACT);
    expect(await captureStatus(deps)).toMatchObject({
      actionEnabled: true, proposableActionTypes: ["slack.message.post"], actionPending: 1,
      actionMaxPending: 2, actionTtlHours: 24, actionExpiringWithinHour: 0, pending: 0,
    });
  });
});
```

Convert the existing `captureStatus` tests to `await captureStatus(deps)`. Import `captureStateFor`.

- [ ] **Step 6: Update the I28 order pin**

In `security-invariants.test.ts`, line ~2618, the `order` array:
- replace `'deps.store.countByState("proposed")'` with `"deps.store.countPendingActions("`;
- insert `"deps.classifyAction?.("` and `"deps.isServiceConfigured?.("` after `"validateCapturePayload(kindRaw"`.

(The `export async function submitCapture` anchor was already changed in Task 6.)

- [ ] **Step 7: Run the tests**

Run: `bun test packages/gateway/src/mcp-sink packages/gateway/src/security-invariants.test.ts -t "I28" && bun run typecheck`
Expected: PASS. `capture-rpc.ts` will not compile yet if `captureStatus`'s result is used synchronously; it is not (the handler returns it), so it compiles. If typecheck complains, fix it in Task 8.

- [ ] **Step 8: Commit**

```bash
git add -A packages/gateway/src
git commit -m "feat(mcp): act door in the I28 gate — action submit, expiry, acceptAction, capture.state"
```

---

### Task 8: RPC wiring — per-call executor, consent wrapper, `capture.state`

**Files:**
- Modify: `packages/gateway/src/ipc/capture-rpc.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (`tryDispatchCaptureRpc`, ~line 1477)
- Test: `packages/gateway/src/ipc/capture-rpc.test.ts`

**Interfaces:**
- Consumes:
  - `ToolExecutor`, `bindConsentChannel` (`engine/executor.ts`)
  - `ConsentCoordinator` (`ipc/consent.ts`)
  - `AuditSink`, `ConnectorDispatcher`, `ConsentChannel` (`engine/types.ts`)
  - `EgressSink` (`egress/egress-ledger.ts`)
  - `ExecutorPolicyDep`
  - `proposableWriteTool` (Task 3)
  - `formatActionConsent` (Task 7)
- Produces:
  - `interface CaptureActWiring { dispatcher: ConnectorDispatcher; egressSink: EgressSink; audit: AuditSink; policyHitl: ExecutorPolicyDep }`
  - `CaptureRpcCtx` += `act?: CaptureActWiring`
  - `buildActDeps(w: CaptureActWiring, coordinator: ConsentCoordinator, clientId: string): ActDeps`
  - `dispatchCaptureRpc(method, params, ctx, caller, consent?: ConsentCoordinator)`

- [ ] **Step 1: Write the failing tests**

Append to `capture-rpc.test.ts`:

```ts
describe("buildActDeps (act door)", () => {
  function wiring(dispatched: PlannedAction[], approve: boolean) {
    const prompts: Array<{ prompt: string; details: unknown }> = [];
    // A coordinator stub that answers every request; `requestConsent` is the only member bindConsentChannel calls.
    const coord = {
      requestConsent: (_c: string, req: { prompt: string; details?: unknown }) => {
        prompts.push({ prompt: req.prompt, details: req.details });
        return Promise.resolve(approve);
      },
    } as unknown as ConsentCoordinator;
    const w: CaptureActWiring = {
      dispatcher: { dispatch: (a) => { dispatched.push(a); return Promise.resolve({ url: "https://x" }); } },
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
    };
    return { act: buildActDeps(w, coord, "c-cli"), prompts };
  }
  const PROV = { captureId: "cap_1", clientLabel: "agent", createdAt: 0, expiresAt: 1, summary: "why" };

  test("first-party: payload carries the ROUTING table's mcpToolId and the input, nothing else", async () => {
    const d: PlannedAction[] = [];
    const { act } = wiring(d, true);
    expect(await act.execute("slack.message.post", { text: "hi" }, PROV)).toEqual({ status: "ok", result: { url: "https://x" } });
    expect(d).toEqual([{ type: "slack.message.post", payload: { mcpToolId: "slack_message_post", input: { text: "hi" } } }]);
  });
  test("user-MCP: mcpToolId is the canonical <serviceId>_<tool> key derived from the type (I42 pairing)", async () => {
    const d: PlannedAction[] = [];
    const { act } = wiring(d, true);
    await act.execute("mcp_echo.echo", { text: "hi" }, PROV);
    expect(d[0]?.payload).toEqual({ mcpToolId: "mcp_echo_echo", input: { text: "hi" } });
  });
  test("the consent prompt is the provenance prompt, with UNREDACTED details", async () => {
    const d: PlannedAction[] = [];
    const { act, prompts } = wiring(d, true);
    await act.execute("slack.message.post", { token_hint: "visible", text: "hi" }, PROV);
    expect(prompts[0]?.prompt).toContain("Agent-proposed action");
    expect(prompts[0]?.details).toEqual({ actionType: "slack.message.post", input: { token_hint: "visible", text: "hi" } });
  });
  test("declined → rejected, nothing dispatched", async () => {
    const d: PlannedAction[] = [];
    const { act } = wiring(d, false);
    expect(await act.execute("slack.message.post", { text: "hi" }, PROV)).toEqual({ status: "rejected" });
    expect(d).toEqual([]);
  });
  test("a first-party type with no routing row throws Tool not found (never dispatches by type)", async () => {
    const d: PlannedAction[] = [];
    const { act } = wiring(d, true);
    await expect(act.execute("github.pr.merge", {}, PROV)).rejects.toThrow("Tool not found");
    expect(d).toEqual([]);
  });
});

test("capture.state routes; captures.accept passes ActDeps when wiring + consent are present", async () => {
  // Submit an mcp note, then poll it as mcp.
  const sub = await dispatchCaptureRpc("capture.submit", NOTE, ctx, { clientId: "a", kind: "mcp" });
  const id = (sub as { kind: "hit"; value: { id: string } }).value.id;
  const st = await dispatchCaptureRpc("capture.state", { id }, ctx, { clientId: "a", kind: "mcp" });
  expect(st).toEqual({ kind: "hit", value: { kind: "note", state: "live" } });
});
```

Add the imports: `PlannedAction`/`ConsentCoordinator` types, `makeEgressSink`, `appendAuditEntry`, `NO_POLICY_OVERLAY`, `buildActDeps`, `CaptureActWiring`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/ipc/capture-rpc.test.ts`
Expected: FAIL — `buildActDeps` is not exported, and `capture.state` misses.

- [ ] **Step 3: Implement**

```ts
import { proposableWriteTool } from "../connectors/proposable-actions.ts";
import { userMcpToolKeyForActionType } from "../connectors/user-mcp-store.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { bindConsentChannel, type ExecutorPolicyDep, ToolExecutor } from "../engine/executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel } from "../engine/types.ts";
import { formatActionConsent } from "../mcp-sink/capture-act.ts";
import type { ActDeps } from "../mcp-sink/capture-types.ts";
import type { ConsentCoordinator } from "./consent.ts";
// …existing imports, plus captureStateFor from capture-gate.ts

/**
 * What the act door executes WITH (spec § 3): the dispatcher runAsk and ChatOps use, the real egress
 * sink (I29) and the policy overlay (I22). Built once in platform/assemble.ts; the executor itself
 * is built per accept, around the ACCEPTING session's consent channel.
 */
export interface CaptureActWiring {
  readonly dispatcher: ConnectorDispatcher;
  readonly egressSink: EgressSink;
  readonly audit: AuditSink;
  readonly policyHitl: ExecutorPolicyDep;
}

export interface CaptureRpcCtx {
  readonly gate: CaptureGateDeps;
  readonly act?: CaptureActWiring;
}

/** Replace the executor's generic prompt with the provenance prompt; details UNREDACTED (spec § 8 step 7). */
function provenanceConsent(
  inner: ConsentChannel,
  prompt: string,
  details: Record<string, unknown>,
): ConsentChannel {
  return {
    requestApproval: (_prompt, _details, actionType) => inner.requestApproval(prompt, details, actionType),
  };
}

export function buildActDeps(
  w: CaptureActWiring,
  coordinator: ConsentCoordinator,
  clientId: string,
): ActDeps {
  return {
    async execute(actionType, input, provenance) {
      // The tool is ALWAYS gateway-chosen: the routing table for a first-party type, the canonical
      // `<serviceId>_<tool>` key for a user-MCP type (the exact pair `connector.userMcpCall` builds,
      // and the only key the dispatcher's I42 pairing accepts for that type).
      const toolId = proposableWriteTool(actionType) ?? userMcpToolKeyForActionType(actionType);
      if (toolId === undefined) {
        // Never dispatch a first-party write by its type (spec § 6.3): no routing row, no call.
        throw new Error("Tool not found");
      }
      const consent = provenanceConsent(
        bindConsentChannel(coordinator, clientId),
        formatActionConsent(provenance, actionType, input),
        { actionType, input },
      );
      // I20/I42: no delegate — the LOCAL owner who ran `captures accept` answers.
      const executor = new ToolExecutor(consent, w.audit, w.dispatcher, undefined, w.egressSink, w.policyHitl);
      const out = await executor.execute({ type: actionType, payload: { mcpToolId: toolId, input } });
      return out.status === "ok" ? { status: "ok", result: out.result } : { status: "rejected" };
    },
  };
}
```

Change `dispatchCaptureRpc` to take a 5th parameter `consent?: ConsentCoordinator`, and update the handler map:

```ts
        "capture.status": (_p, c) => captureStatus(c.gate),
        "capture.state": (p, c) => captureStateFor(c.gate, c.caller, idParam(p)),
        "captures.accept": (p, c) =>
          acceptCapture(
            c.gate,
            c.caller,
            idParam(p),
            ctx.act !== undefined && consent !== undefined
              ? buildActDeps(ctx.act, consent, c.caller.clientId)
              : undefined,
          ),
```

`ConsentCoordinatorImpl` implements `ConsentCoordinator`, so `ctx.consentImpl` satisfies the parameter. In `dispatchers.ts` `tryDispatchCaptureRpc`, pass `ctx.consentImpl` as the 5th argument.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/ipc/capture-rpc.test.ts packages/gateway/src/security-invariants.test.ts && bun run typecheck`
Expected: PASS. The `(c)` test ("every production ToolExecutor is handed a policy overlay") finds the new site through `w.policyHitl`. If an I29 test enumerates executor sites by egress argument, `w.egressSink` is a real sink; add the file to that test's expectations as a real-sink site, with a one-line reason.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc
git commit -m "feat(ipc): act door wiring — per-accept ToolExecutor with provenance consent, capture.state"
```

---

### Task 9: Assemble wiring and boot reconcile

**Files:**
- Modify: `packages/gateway/src/platform/assemble.ts` (capture block ~line 3433–3456; `ipcOpts.captureRpcCtx` ~line 4099)
- Test: covered by Task 11's integration tests and Task 14's E2E. Prove the boot call with the assemble-level grep in Step 2.

**Interfaces:**
- Consumes:
  - `classifyActionType`, `listProposableActionTypes` (Task 3)
  - `isConnectorConfigured` (`sync/connector-configured.ts`)
  - `getUserMcpConnector`, `listModelAccessibleUserMcpIds` (`connectors/user-mcp-store.ts`)
  - `isUserMcpModelAccessEnabled` (`connectors/user-mcp-model-capability.ts`)
  - `reconcileActionsAtBoot` (Task 7)
  - `CaptureActWiring` (Task 8)
  - `createConnectorWriteDispatcher`, `createConnectorDispatcher`, `meshDispatcherClient`, `makeEgressSink`, `appendAuditEntry`
  - `policyHitl` (in scope at ~line 3502; move the capture block below it if TS complains about use before declaration)

- [ ] **Step 1: Implement**

Replace the capture block's deps construction with:

```ts
  const captureStore = new CaptureStore(db);
  // I28 act door: expire due proposals and fail any action a restart interrupted mid-consent,
  // BEFORE the IPC server accepts a connection (spec § 9). Then retention, as before.
  const actBoot = reconcileActionsAtBoot({ db, store: captureStore }, Date.now());
  if (actBoot.expired + actBoot.interrupted > 0) {
    syncLogger.info({ event: "mcp_sink.act_reconcile", ...actBoot }, "act door boot reconcile");
  }
  captureStore.pruneRejected(Date.now() - REJECTED_RETENTION_MS);
  const actClassifyCtx = {
    modelAccessServices: () => new Set(listModelAccessibleUserMcpIds(db)),
    userMcpModelAccessAllowed: () => isUserMcpModelAccessEnabled(policyGate.enforced()),
  };
  const isServiceConfigured = async (service: string): Promise<boolean> =>
    USER_MCP_SERVICE_ID_PATTERN.test(service)
      ? getUserMcpConnector(db, service) !== null
      : isConnectorConfigured(vault, service);
  const captureGate: CaptureGateDeps = {
    db,
    store: captureStore,
    capability: () => resolveCaptureCapability(mcpSinkLoad, policyGate.enforced()),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${randomUUID()}`,
    now: () => Date.now(),
    classifyAction: (t) => classifyActionType(t, actClassifyCtx),
    isServiceConfigured,
    listProposableActionTypes: () =>
      listProposableActionTypes({ ...actClassifyCtx, isServiceConfigured }),
    ...(scheduleItemEmbedding === undefined
      ? {}
      : { scheduleEmbedding: (id: string) => scheduleItemEmbedding(id) }),
  };
```

At the `ipcOpts.captureRpcCtx` line:

```ts
  // I28 act door: the SAME dispatcher composition runAsk (gateway-main.ts) and ChatOps use, the real
  // egress sink (I29) and the process's policy overlay (I22). Default off twice ([mcp_sink] kinds +
  // mcp_action); wiring it unconditionally enables nothing.
  ipcOpts.captureRpcCtx = {
    gate: captureGate,
    act: {
      dispatcher: createConnectorWriteDispatcher(
        createConnectorDispatcher(meshDispatcherClient(connectorMesh)),
        connectorWriteDeps,
      ),
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl,
    },
  };
```

Add the imports. Some of them already exist in `assemble.ts`, so grep each name first. D32(c) is unaffected: `assemble.ts` imports `capture-act.ts`, never `capture-gate.ts` as a value.

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bun test packages/gateway/src/platform && bun run audit:invariants`. If the script name differs, use `bun run preflight:fast`, which runs `check-nimbus-invariants.ts`.
Expected: PASS. Then `grep -n "reconcileActionsAtBoot" packages/gateway/src/platform/assemble.ts` should show exactly one call, placed before `ipcOpts.captureRpcCtx`.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts
git commit -m "feat(gateway): wire the act door — classification, configured check, executor deps, boot reconcile"
```

---

### Task 10: Routing integration test through the REAL dispatcher

**Files:**
- Create: `packages/gateway/test/integration/mcp-sink/capture-action-routing.test.ts`

**Interfaces:**
- Consumes: `createConnectorDispatcher` (`src/connectors/registry.ts`), `buildActDeps`, `CaptureActWiring` (Task 8), `NO_POLICY_OVERLAY`, `makeEgressSink`, `openMigratedMemoryDb`.

- [ ] **Step 1: Write the test**

```ts
/**
 * The test the act door's first draft lacked (spec § 6.3): the action `buildActDeps` constructs,
 * dispatched through the REAL `createConnectorDispatcher` over a tool map keyed EXACTLY as the mesh
 * lists tools (`<server>_<tool>`), reaches the right tool for a first-party and a user-MCP type.
 */
import { describe, expect, test } from "bun:test";

import { appendAuditEntry } from "../../../src/db/audit-chain.ts";
import { makeEgressSink } from "../../../src/egress/egress-ledger.ts";
import { NO_POLICY_OVERLAY } from "../../../src/engine/executor.ts";
import { createConnectorDispatcher } from "../../../src/connectors/registry.ts";
import { openMigratedMemoryDb } from "../../../src/index/migrated-db-template.ts";
import { buildActDeps } from "../../../src/ipc/capture-rpc.ts";
import type { ConsentCoordinator } from "../../../src/ipc/consent.ts";

const PROV = { captureId: "cap_1", clientLabel: null, createdAt: 0, expiresAt: 1, summary: "s" };
const approve = { requestConsent: () => Promise.resolve(true) } as unknown as ConsentCoordinator;

function meshTools(calls: Array<[string, unknown]>) {
  const tool = (key: string) => ({ execute: (input: unknown) => { calls.push([key, input]); return Promise.resolve({ ok: key }); } });
  return {
    slack_slack_message_post: tool("slack_slack_message_post"),
    slack_slack_chat_post: tool("slack_slack_chat_post"),
    obsidian_obsidian_append_to_daily_note: tool("obsidian_obsidian_append_to_daily_note"),
    google_drive_gdrive_file_create: tool("google_drive_gdrive_file_create"),
    apple_apple_mail_send: tool("apple_apple_mail_send"),
  };
}

describe("act door routing through the real dispatcher", () => {
  test.each([
    ["slack.message.post", "slack_slack_message_post"],
    ["obsidian.note.append", "obsidian_obsidian_append_to_daily_note"],
    ["google_drive.file.create", "google_drive_gdrive_file_create"],
    ["apple.mail.send", "apple_apple_mail_send"],
  ])("%s resolves to %s with the stored input", async (type, key) => {
    const db = openMigratedMemoryDb();
    const calls: Array<[string, unknown]> = [];
    const dispatcher = createConnectorDispatcher({ listTools: () => Promise.resolve(meshTools(calls)) });
    const act = buildActDeps(
      { dispatcher, egressSink: makeEgressSink(db), audit: { recordAudit: (e) => appendAuditEntry(db, e) }, policyHitl: NO_POLICY_OVERLAY },
      approve,
      "c-cli",
    );
    expect(await act.execute(type, { text: "hi" }, PROV)).toMatchObject({ status: "ok" });
    expect(calls).toEqual([[key, { text: "hi" }]]);
    db.close();
  });

  test("a user-MCP type resolves only its own server's key", async () => {
    const db = openMigratedMemoryDb();
    const calls: Array<[string, unknown]> = [];
    const userTools = { mcp_echo_echo: { execute: (i: unknown) => { calls.push(["mcp_echo_echo", i]); return Promise.resolve("ok"); } } };
    const dispatcher = createConnectorDispatcher({
      listTools: () => Promise.resolve({}),
      listUserMcpTools: (s) => Promise.resolve(s === "mcp_echo" ? userTools : undefined),
    });
    const act = buildActDeps(
      { dispatcher, egressSink: makeEgressSink(db), audit: { recordAudit: (e) => appendAuditEntry(db, e) }, policyHitl: NO_POLICY_OVERLAY },
      approve,
      "c-cli",
    );
    await act.execute("mcp_echo.echo", { text: "hi" }, PROV);
    expect(calls).toEqual([["mcp_echo_echo", { text: "hi" }]]);
    db.close();
  });

  test("RED-PROOF premise: dispatching by type alone (the first draft) finds no tool", async () => {
    const calls: Array<[string, unknown]> = [];
    const dispatcher = createConnectorDispatcher({ listTools: () => Promise.resolve(meshTools(calls)) });
    await expect(dispatcher.dispatch({ type: "slack.message.post", payload: { input: {} } })).rejects.toThrow("Tool not found");
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/test/integration/mcp-sink/capture-action-routing.test.ts`
Expected: PASS. The red-proof case shows the routing table is load-bearing.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/integration/mcp-sink/capture-action-routing.test.ts
git commit -m "test(mcp): act-door routing through the real connector dispatcher"
```

---

### Task 11: Flow integration test — real executor, real egress ledger

**Files:**
- Create: `packages/gateway/test/integration/mcp-sink/capture-action-flow.test.ts`

**Interfaces:**
- Consumes:
  - `submitCapture`/`acceptCapture`/`listCaptures` through `dispatchCaptureRpc` (`src/ipc/capture-rpc.ts`). Tests may call the gate directly; D32(b) skips test files.
  - `reconcileActionsAtBoot`
  - `CaptureStore`
  - `ConsentCoordinatorImpl`
- Real: SQLite (`openMigratedMemoryDb`), `ToolExecutor` (via `buildActDeps`), `makeEgressSink`.
- Fake: the dispatcher (records calls, optionally throws).

- [ ] **Step 1: Write the test**

The harness drives everything through `dispatchCaptureRpc` with `ctx = { gate, act }` and a `ConsentCoordinator` stub that approves or declines, or that throws `ConsentDisconnectedError` (imported from `src/ipc/consent.ts`; check its constructor arguments with `sed -n 1,15p packages/gateway/src/ipc/consent.ts`). The `gate` deps are the Task 7 shape, with `classifyAction` → proposable, `isServiceConfigured` → true, and `capability` returning `actionEnabled`.

Cases, each a `test`:
1. **approve:** `capture.submit` (mcp) → `captures.accept` (owner) → result `executed`. Then:
   - the dispatcher got exactly one call;
   - `egress_ledger` has exactly one row with `hitl_status = 'approved'`;
   - its `id` is lower than or equal to the dispatcher-call marker. Have the fake dispatcher read `SELECT COUNT(*) FROM egress_ledger` at call time and assert it was `1` — that proves append-before-dispatch.
2. **decline:** result `rejected`; one ledger row with `result_status = 'blocked'`; dispatcher not called; capture state `rejected`.
3. **disconnect:** the coordinator rejects with `ConsentDisconnectedError` → result `rejected`.
4. **delegation not consulted:** construct the wiring with `policyHitl: NO_POLICY_OVERLAY`. Assert by source scan that `buildActDeps`'s `new ToolExecutor(` passes `undefined` as its 4th argument: read `src/ipc/capture-rpc.ts`, strip comments, and regex `/new ToolExecutor\(\s*consent,\s*w\.audit,\s*w\.dispatcher,\s*undefined,/`. The behavioural half is I42/I20's existing tests.
5. **dispatcher throws a timeout:** result `failed` with `ERR_ACTION_TIMEOUT`; the row keeps no message text.
6. **lazy expiry:** advance the clock past the TTL → `captures.list` shows `expired` and there is one `capture.action.expire` audit row; then accept → `ERR_CAPTURE_EXPIRED` (via `RpcMethodError` data `.code`).
7. **boot reconcile:** claim a row with `store.claimAction`, then call `reconcileActionsAtBoot` → `failed`/`ERR_ACTION_INTERRUPTED`, never `proposed`.
8. **retention:** expired and rejected actions older than `REJECTED_RETENTION_MS` are pruned by `store.pruneRejected`; executed and failed ones are kept.

Write them in the style of `capture-rpc.test.ts`, which already builds `gate` + `dispatchCaptureRpc`; copy its `beforeEach` and extend the deps. Every assertion reads the DB after `db.close()` is NOT yet called. Close the DB in `afterEach`, never before an assertion (memory: close-the-db-before-asserting — here the DB is `:memory:` so no file lock exists, but keep the order).

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/test/integration/mcp-sink/capture-action-flow.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/integration/mcp-sink/capture-action-flow.test.ts
git commit -m "test(mcp): act-door flow — egress before dispatch, decline/disconnect, expiry, reconcile, retention"
```

---

### Task 12: Static rules D32(e)(f)(g) and the I28 invariant row

**Files:**
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (after `checkAgentProvenanceWriters`, ~line 1936; reporting block ~line 2915)
- Modify: `scripts/structure-audit/check-nimbus-invariants.test.ts`
- Modify: `packages/gateway/src/security-invariants.test.ts` (I28 describe, ~line 2617)

**Interfaces:**
- Produces: `checkActDoorConfinement(files: readonly FileEntry[]): Violation[]` with rules `act-door-accept-action` (e), `mcp-sink-no-executor-or-connectors` (f) and `mcp-sink-mcptoolid-literal` (g).

- [ ] **Step 1: Write the failing fixtures**

```ts
describe("D32(e)(f)(g) — the act door", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const ACT = "packages/gateway/src/mcp-sink/capture-act.ts";
  const GATE = "packages/gateway/src/mcp-sink/capture-gate.ts";

  test("allows the definition and the gate's call", () => {
    expect(checkActDoorConfinement([
      file(ACT, "export async function acceptAction(d) {}"),
      file(GATE, "return acceptAction(deps, caller, row, act);"),
    ])).toEqual([]);
  });
  test("(e) FAILS when acceptAction is named anywhere else", () => {
    expect(checkActDoorConfinement([
      file("packages/gateway/src/ipc/capture-rpc.ts", "acceptAction(d, c, r, a)"),
    ])).toHaveLength(1);
  });
  test.each([
    'import { ToolExecutor } from "../engine/executor.ts";',
    'import type { HITL_REQUIRED } from "../engine/executor.ts";',
    'import { proposableWriteTool } from "../connectors/proposable-actions.ts";',
    'import type { X } from "../connectors/registry.ts";',
    'export * from "../connectors/x.ts";',
    'const m = await import("../engine/executor.ts");',
  ])("(f) FAILS: an mcp-sink file %s", (line) => {
    expect(checkActDoorConfinement([file("packages/gateway/src/mcp-sink/capture-x.ts", line)])).toHaveLength(1);
  });
  test("(f) allows engine/service-of.ts and a test file", () => {
    expect(checkActDoorConfinement([
      file("packages/gateway/src/mcp-sink/capture-act.ts", 'import { serviceOf } from "../engine/service-of.ts";'),
      file("packages/gateway/src/mcp-sink/capture-act.test.ts", 'import { HITL_REQUIRED } from "../engine/executor.ts";'),
    ])).toEqual([]);
  });
  test("(g) the mcpToolId literal is confined to capture-validate.ts under mcp-sink/", () => {
    expect(checkActDoorConfinement([
      file("packages/gateway/src/mcp-sink/capture-validate.ts", 'if (Object.hasOwn(input, "mcpToolId")) {}'),
    ])).toEqual([]);
    expect(checkActDoorConfinement([
      file(GATE, 'payload["mcpToolId"] = x;'),
    ])).toHaveLength(1);
  });
  test("(g) a comment mentioning mcpToolId does not trip it", () => {
    expect(checkActDoorConfinement([file(GATE, "// never set mcpToolId here")])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts -t "D32\\(e\\)"`
Expected: FAIL — `checkActDoorConfinement` is not exported.

- [ ] **Step 3: Implement**

```ts
// (e)(f)(g) The act door (spec 2026-10-15 § 12.2). (e) `acceptAction` is named only by its definition
//     and its one caller. (f) No non-test `mcp-sink/` file imports `engine/executor.ts` or anything
//     under `connectors/` — TYPE imports included: execution, classification and configured-ness
//     reach the sink only as injected functions, built in ipc/capture-rpc.ts and platform/assemble.ts.
//     (g) The `mcpToolId` literal appears under mcp-sink/ only in capture-validate.ts, where a key of
//     that name is REFUSED. Stated bound, as D32(a): a dynamically composed specifier or key evades
//     a text scan; capability confinement (the sink is never handed a dispatcher) is the real defence.
const D32E_ACCEPT_ACTION_RE = /\bacceptAction\b/g;
const D32E_ALLOWED: readonly string[] = [
  "packages/gateway/src/mcp-sink/capture-act.ts",
  "packages/gateway/src/mcp-sink/capture-gate.ts",
];
const D32F_FORBIDDEN_IMPORT_RE =
  /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g;
const D32G_LITERAL_RE = /mcpToolId/g;
const D32G_ALLOWED = "packages/gateway/src/mcp-sink/capture-validate.ts";

export function checkActDoorConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const push = (rule: string, f: FileEntry, code: string, index: number): void => {
    const line = code.slice(0, index).split("\n").length;
    out.push({ rule, file: f.relPath, line, snippet: (f.contents.split("\n")[line - 1] ?? "").trim() });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || !f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripComments(f.contents);
    if (!D32E_ALLOWED.includes(f.relPath)) {
      for (const m of stripStringLiterals(code).matchAll(D32E_ACCEPT_ACTION_RE)) push("act-door-accept-action", f, code, m.index);
    }
    if (!f.relPath.startsWith("packages/gateway/src/mcp-sink/")) continue;
    for (const m of code.matchAll(D32F_FORBIDDEN_IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? "";
      if (/(?:^|\/)engine\/executor(?:\.ts)?$/.test(spec) || /(?:^|\/)connectors\//.test(spec)) {
        push("mcp-sink-no-executor-or-connectors", f, code, m.index);
      }
    }
    if (f.relPath !== D32G_ALLOWED) {
      for (const m of code.matchAll(D32G_LITERAL_RE)) push("mcp-sink-mcptoolid-literal", f, code, m.index);
    }
  }
  return out;
}
```

`stripStringLiterals` keeps offsets stable: it blanks content without removing it. Check its definition in `scripts/structure-audit/lib.ts` before relying on that. If it does not preserve offsets, compute `line` from the stripped text the way `checkCaptureGateCallers` does.

Register the check in the reporting block beside D32(a)–(d):

```ts
    const e = checkActDoorConfinement(files);
    for (const v of e) {
      console.error(`::error file=${v.file},line=${v.line}::D32(${v.rule === "act-door-accept-action" ? "e" : v.rule === "mcp-sink-no-executor-or-connectors" ? "f" : "g"}) act door confinement — I28 regression: ${v.snippet}`);
    }
```

Add `e.length > 0` to that block's exit condition.

Extend the I28 describe in `security-invariants.test.ts`:

```ts
  test("act door: acceptAction claims BEFORE execute, and execute is the last step before finalize", async () => {
    const src = stripComments(await read("packages/gateway/src/mcp-sink/capture-act.ts"));
    const body = src.slice(src.indexOf("export async function acceptAction"));
    const order = [
      "cap.actionEnabled",
      "CAPTURE_ROLE_BY_KIND[caller.kind]",
      'row.state !== "proposed"',
      "deps.now() >= expiresAt",
      "deps.classifyAction?.(",
      "deps.isServiceConfigured?.(",
      "deps.store.claimAction(",
      "act.execute(",
      "deps.store.finalizeAction(",
    ];
    const idx = order.map((s) => body.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test("act door: the dispatched payload's mcpToolId is the routing table's value; no delegate; policy overlay passed", async () => {
    const src = stripComments(await read("packages/gateway/src/ipc/capture-rpc.ts"));
    expect(src).toMatch(/const toolId = proposableWriteTool\(actionType\) \?\? userMcpToolKeyForActionType\(actionType\)/);
    expect(src).toMatch(/payload: \{ mcpToolId: toolId, input \}/);
    expect(src).toMatch(/new ToolExecutor\(\s*consent,\s*w\.audit,\s*w\.dispatcher,\s*undefined,\s*w\.egressSink,\s*w\.policyHitl\s*\)/);
  });

  test("act door: an absent policy accessor disables actions (fail-closed)", async () => {
    const { resolveCaptureCapability } = await import("./mcp-sink/capture-capability.ts");
    const { DEFAULT_MCP_SINK_CONFIG } = await import("./config/mcp-sink-toml.ts");
    const c = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["action"] } },
      undefined,
    );
    expect(c.actionEnabled).toBe(false);
  });
```

- [ ] **Step 4: Run**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts && bun test packages/gateway/src/security-invariants.test.ts -t I28 && bun run preflight:fast`
Expected: PASS. Then red-prove each rule: temporarily add `import type { ToolExecutor } from "../engine/executor.ts";` to `capture-act.ts`, run `bun scripts/structure-audit/check-nimbus-invariants.ts`, confirm `D32(f)` fires, and revert.

- [ ] **Step 5: Commit**

```bash
git add scripts/structure-audit packages/gateway/src/security-invariants.test.ts
git commit -m "feat(audit): D32(e)(f)(g) — act-door confinement; I28 invariant row extended"
```

---

### Task 13: CLI — `propose_action`, `capture_status`, `captures accept` for actions, doctor

**Files:**
- Modify: `packages/cli/src/mcp/capture-tools.ts` (+ `capture-tools.test.ts`)
- Modify: `packages/cli/src/commands/captures.ts`, `packages/cli/src/commands/captures-format.ts` (+ `captures.test.ts`, `captures-cmd.test.ts`)

**Interfaces:**
- Consumes (IPC):
  - `capture.status` → now carries `actionEnabled`, `proposableActionTypes`, `actionPending`, `actionMaxPending`, `actionTtlHours`, `actionExpiringWithinHour`
  - `capture.submit` → `{id, state, expiresAt?}`
  - `capture.state` → `{kind, state, expiresAt?, outcomeRef?, errorCode?}`
  - `captures.accept` → native `{id, state:"accepted", nativeRef}`, or `{id, state:"executed"|"rejected"|"failed", outcomeRef?, errorCode?}`
- Produces:
  - `CaptureToolSpec.kind: CaptureToolKind | "status"`, where `CaptureToolKind` gains `"action"`
  - `actionAcceptTtyRefusal(kind: string | undefined, tty: { stdin: boolean; stdout: boolean }): string | undefined`
  - `runCapturesWith(c, a, sink, tty?: { stdin: boolean; stdout: boolean })` — `tty` defaults to `{ stdin: false, stdout: false }` (fail-closed: an action accept with no TTY info refuses)
  - `parseAcceptResult(raw: unknown): AcceptView`
  - `CaptureStatusView` += `actionEnabled`, `actionPending`, `actionMaxPending`, `actionExpiringWithinHour`

- [ ] **Step 1: Write the failing tests**

`capture-tools.test.ts`: there is an existing fake `deps` whose `client.call` answers `capture.status`; reuse it.

```ts
describe("act door tools", () => {
  test("propose_action is absent unless actionEnabled; capture_status present with any kind", async () => {
    const off = await captureToolsFor(depsWithStatus({ enabled: true, kinds: ["note"], actionEnabled: false }));
    expect(off.map((t) => t.name)).toEqual(["capture_note", "capture_status"]);
    const on = await captureToolsFor(depsWithStatus({
      enabled: true, kinds: ["note", "action"], actionEnabled: true,
      proposableActionTypes: ["jira.issue.create", "slack.message.post"],
    }));
    expect(on.map((t) => t.name)).toEqual(["capture_note", "propose_action", "capture_status"]);
    expect(on.find((t) => t.name === "propose_action")?.description).toContain("jira.issue.create, slack.message.post");
  });
  test("sink off: no tools at all", async () => {
    expect(await captureToolsFor(depsWithStatus({ enabled: false, kinds: [] }))).toEqual([]);
  });
  test("propose_action submits {actionType, input, summary} and says it has NOT run", async () => {
    const calls: Array<[string, unknown]> = [];
    const deps = depsRecording(calls, { "capture.submit": { id: "cap_1", state: "proposed", expiresAt: 0 } });
    const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "propose_action");
    const out = await spec?.run(deps, { actionType: "slack.message.post", input: { text: "hi" }, summary: "why" }, () => "agent");
    expect(calls[0]).toEqual(["capture.submit", { kind: "action", payload: { actionType: "slack.message.post", input: { text: "hi" }, summary: "why" }, clientLabel: "agent" }]);
    expect(out?.content[0]?.text).toContain("has NOT run");
    expect(out?.content[0]?.text).toContain("1970-01-01T00:00:00.000Z");
  });
  test("capture_status returns the state JSON", async () => {
    const deps = depsRecording([], { "capture.state": { kind: "action", state: "executed", outcomeRef: "https://x" } });
    const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "capture_status");
    const out = await spec?.run(deps, { id: "cap_1" }, () => undefined);
    expect(JSON.parse(out?.content[0]?.text ?? "{}")).toEqual({ kind: "action", state: "executed", outcomeRef: "https://x" });
  });
});
```

If the test file lacks `depsWithStatus`/`depsRecording`, write them next to the existing fake: each returns an `AdapterDeps` whose `getClient` resolves to `{ call: (m, p) => { calls.push([m, p]); return Promise.resolve(answers[m]); } }`. Check `AdapterDeps`'s other required fields in `tool-runtime.ts` and fill them the same way the existing tests do.

`captures.test.ts`:

```ts
describe("captures accept — act door", () => {
  const TTY = { stdin: true, stdout: true };
  test("TTY guard: only for actions; both streams required (Review Focus 4)", () => {
    expect(actionAcceptTtyRefusal("decision", { stdin: false, stdout: false })).toBeUndefined();
    expect(actionAcceptTtyRefusal("action", { stdin: true, stdout: true })).toBeUndefined();
    expect(actionAcceptTtyRefusal("action", { stdin: false, stdout: true })).toBe(
      "nimbus captures accept requires an interactive terminal (TTY) to approve an agent-proposed action.",
    );
    expect(actionAcceptTtyRefusal("action", { stdin: true, stdout: false })).toBeDefined();
  });
  test.each([
    [{ id: "cap_1", state: "executed", outcomeRef: "https://x/1" }, 0, "[ok] executed"],
    [{ id: "cap_1", state: "executed" }, 0, "no outcome reference"],
    [{ id: "cap_1", state: "rejected" }, 1, "[rejected] not executed — you declined the approval"],
    [{ id: "cap_1", state: "failed", errorCode: "ERR_ACTION_TIMEOUT" }, 1, "may or may not have reached"],
    [{ id: "cap_1", state: "failed", errorCode: "ERR_ACTION_TOOL_NOT_FOUND" }, 1, "[failed] ERR_ACTION_TOOL_NOT_FOUND"],
  ])("result %p → exit %d, says %p", async (raw, exit, text) => {
    const out: string[] = [];
    const c = { call: (m: string) => Promise.resolve(m === "captures.accept" ? raw : { kind: "action", payload: { actionType: "slack.message.post" } }) };
    const code = await runCapturesWith(c as never, { verb: "accept", id: "cap_1", json: false }, { out: (s) => out.push(s), err: (s) => out.push(s) }, TTY);
    expect(code).toBe(exit);
    expect(out.join("")).toContain(text);
  });
  test("failed ERR_ACTION_TOOL_NOT_FOUND does NOT claim it may have reached the service", async () => {
    const out: string[] = [];
    const c = { call: (m: string) => Promise.resolve(m === "captures.accept" ? { id: "cap_1", state: "failed", errorCode: "ERR_ACTION_TOOL_NOT_FOUND" } : { kind: "action", payload: { actionType: "slack.message.post" } }) };
    await runCapturesWith(c as never, { verb: "accept", id: "cap_1", json: false }, { out: (s) => out.push(s), err: (s) => out.push(s) }, TTY);
    expect(out.join("")).not.toContain("may or may not");
  });
  test.each([
    ["piped stdin", { stdin: false, stdout: true }],
    ["redirected stdout", { stdin: true, stdout: false }],
    ["no tty info (default)", undefined],
  ])("action accept with %s refuses BEFORE captures.accept is called (Review Focus 4)", async (_n, tty) => {
    const calls: string[] = [];
    const err: string[] = [];
    const c = { call: (m: string) => { calls.push(m); return Promise.resolve({ kind: "action", payload: { actionType: "slack.message.post" } }); } };
    const code = await runCapturesWith(c as never, { verb: "accept", id: "cap_1", json: false }, { out: () => {}, err: (s) => err.push(s) }, tty);
    expect(code).toBe(1);
    expect(calls).toEqual(["captures.get"]);
    expect(err.join("")).toContain("requires an interactive terminal");
  });
  test("a failed captures.get fails the accept closed: no captures.accept call", async () => {
    const calls: string[] = [];
    const c = { call: (m: string) => { calls.push(m); return Promise.reject(new Error("Capture not found")); } };
    expect(await runCapturesWith(c as never, { verb: "accept", id: "cap_1", json: false }, { out: () => {}, err: () => {} }, TTY)).toBe(1);
    expect(calls).toEqual(["captures.get"]);
  });
  test("a native accept with piped stdin still works (the guard is action-only)", async () => {
    const c = { call: (m: string) => Promise.resolve(m === "captures.accept" ? { id: "cap_1", state: "accepted", nativeRef: "capture:cap_1" } : { kind: "decision", payload: {} }) };
    expect(await runCapturesWith(c as never, { verb: "accept", id: "cap_1", json: false }, { out: () => {}, err: () => {} })).toBe(0);
  });
  test("native accept is unchanged", async () => {
    const out: string[] = [];
    const c = { call: () => Promise.resolve({ id: "cap_1", state: "accepted", nativeRef: "capture:cap_1" }) };
    expect(await runCapturesWith(c as never, { verb: "accept", id: "cap_1", json: false }, { out: (s) => out.push(s), err: () => {} })).toBe(0);
    expect(out.join("")).toContain("now counts as a decision");
  });
  test("a malformed result still errors", async () => {
    const c = { call: () => Promise.resolve({ state: "weird" }) };
    expect(await runCapturesWith(c as never, { verb: "accept", id: "cap_1", json: false }, { out: () => {}, err: () => {} })).toBe(1);
  });
  test("doctor: action pending line", () => {
    const { lines } = doctorCapturesLines({
      enabled: true, kinds: ["action"], pending: 0, maxPending: 100, maxPerHour: 30, refusedSinceStart: {},
      actionEnabled: true, actionPending: 3, actionMaxPending: 10, actionExpiringWithinHour: 1,
    });
    expect(lines).toContain("[info] MCP capture sink: 3 agent-proposed actions awaiting review (1 expire within 1h) — nimbus captures");
  });
  test("doctor: action queue full → warning, exit 1 (mirrors the native queue-full line)", () => {
    const { lines, exit } = doctorCapturesLines({
      enabled: true, kinds: ["action"], pending: 0, maxPending: 100, maxPerHour: 30, refusedSinceStart: {},
      actionEnabled: true, actionPending: 10, actionMaxPending: 10, actionExpiringWithinHour: 0,
    });
    expect(exit).toBe(1);
    expect(lines).toContain(
      "[warn] MCP capture sink: action queue full (10/10): new action proposals are being refused — nimbus captures",
    );
    expect(lines.some((l) => l.includes("awaiting review"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/src/mcp/capture-tools.test.ts packages/cli/src/commands/captures.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`capture-tools.ts`:
- `type CaptureToolKind = "note" | "decision" | "term" | "link" | "action";`
- `CaptureToolSpec.kind: CaptureToolKind | "status"`.
- Add a `submitRaw` that returns the whole result; `submit` keeps calling `idOf(await submitRaw(...))`.
- Append the two specs:

```ts
  {
    name: "propose_action",
    kind: "action",
    description:
      "Propose a connector action (post a message, create or update a ticket, send an email, …) for the " +
      "user to approve. NOTHING is sent when you call this: the proposal waits on the user's machine " +
      "until the owner runs `nimbus captures accept <id>` and approves the exact input shown. It expires " +
      "if not accepted in time. Poll its outcome with capture_status. input is the tool's arguments as " +
      "a JSON object. Proposable action types on this machine: ",
    schema: {
      actionType: z.string(),
      input: z.record(z.string(), z.unknown()),
      summary: z.string(),
    },
    annotations: WRITE_ANNOTATIONS,
    run: (deps, args, clientLabel) =>
      runTool(deps, async (c: IpcCallable) => {
        const raw = await submitRaw(c, "action", pick(args, ["actionType", "input", "summary"]), clientLabel);
        const id = idOf(raw);
        const exp = (raw as Record<string, unknown>)["expiresAt"];
        const when = typeof exp === "number" ? new Date(exp).toISOString() : "its TTL";
        return {
          content: [{
            type: "text",
            text: `Proposed action ${id} — expires ${when}. It has NOT run: the owner must accept it with \`nimbus captures accept ${id}\` and approve the prompt. Poll capture_status with this id. Do not tell the user it was sent.`,
          }],
        };
      }),
  },
  {
    name: "capture_status",
    kind: "status",
    description:
      "Read the state of a capture YOU submitted, by its id (proposed, executed, failed, rejected, " +
      "expired, accepted, live, revoked). Returns the state and, for an executed action, a short link " +
      "when the service returned one — never the payload.",
    schema: { id: z.string() },
    annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: true } as never,
    run: (deps, args) =>
      runTool(deps, async (c: IpcCallable) => ({
        content: [{ type: "text", text: JSON.stringify(await c.call<unknown>("capture.state", { id: args["id"] })) }],
      })),
  },
```

`annotations` is typed `readOnlyHint: false`. Widen the interface's `annotations` to `{ readonly readOnlyHint: boolean; … }` rather than casting, and drop the `as never`.

Replace `captureToolsFor`'s final filter:

```ts
  let status: Record<string, unknown>;
  try {
    const raw = await client.call<unknown>("capture.status", {});
    status = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  } catch {
    return [];
  }
  const kinds = enabledKinds(status);
  if (kinds.length === 0) return [];
  const actionOn = status["actionEnabled"] === true;
  const types = Array.isArray(status["proposableActionTypes"])
    ? status["proposableActionTypes"].filter((t): t is string => typeof t === "string")
    : [];
  return CAPTURE_TOOL_SPECS.flatMap((s): CaptureToolSpec[] => {
    if (s.kind === "status") return [s];
    if (s.kind === "action") {
      return actionOn ? [{ ...s, description: `${s.description}${types.length === 0 ? "(none configured)" : types.join(", ")}.` }] : [];
    }
    return kinds.includes(s.kind) ? [s] : [];
  });
```

`captures.ts`:
- `CAPTURES_USAGE`: add `action` to `--kind` and `executing|executed|failed|expired` to `--state`.
- Add:
  ```ts
  export function actionAcceptTtyRefusal(
    kind: string | undefined,
    tty: { readonly stdin: boolean; readonly stdout: boolean },
  ): string | undefined {
    if (kind !== "action" || (tty.stdin && tty.stdout)) return undefined;
    return "nimbus captures accept requires an interactive terminal (TTY) to approve an agent-proposed action.";
  }
  ```
- Replace `assertAcceptResult` + the accept arm of `confirmation` with `parseAcceptResult` + `acceptLine`:
  ```ts
  type AcceptView =
    | { state: "accepted"; nativeRef: string }
    | { state: "executed"; outcomeRef?: string }
    | { state: "rejected" }
    | { state: "failed"; errorCode: string };
  const AMBIGUOUS = new Set(["ERR_ACTION_TIMEOUT", "ERR_ACTION_DISPATCH", "ERR_ACTION_INTERRUPTED"]);
  function parseAcceptResult(raw: unknown): AcceptView {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (r["state"] === "accepted" && typeof r["nativeRef"] === "string" && r["nativeRef"] !== "") {
      return { state: "accepted", nativeRef: r["nativeRef"] };
    }
    if (r["state"] === "executed") {
      return typeof r["outcomeRef"] === "string" ? { state: "executed", outcomeRef: r["outcomeRef"] } : { state: "executed" };
    }
    if (r["state"] === "rejected") return { state: "rejected" };
    if (r["state"] === "failed" && typeof r["errorCode"] === "string") return { state: "failed", errorCode: r["errorCode"] };
    throw new Error("captures.accept returned a malformed result; the capture was not confirmed accepted");
  }
  ```
  Give `runCapturesWith` a fourth parameter, `tty: { readonly stdin: boolean; readonly stdout: boolean } = { stdin: false, stdout: false }`. In its non-list/show path, for `accept`, call `captures.get` ONCE, before the accept: `const detail = await c.call<unknown>("captures.get", { id: a.id })`. Do NOT catch a failure of this call: the TTY guard depends on the `kind` it returns, so a failure propagates to the function's existing `catch`, which prints it and returns 1, and `captures.accept` is never called. Read `kind` (a string, else `undefined`) and, when `kind === "action"`, `payload.actionType` for the wording. Then `const refusal = actionAcceptTtyRefusal(kind, tty)`; if it is defined, write it plus `\n` to `sink.err` and return 1 before any accept call. Otherwise call `captures.accept`, parse it, and write:
  - `accepted` → today's line, exit 0;
  - `executed` → `[ok] executed ${type} (${stripControl(outcomeRef) || "no outcome reference"})\n`, exit 0;
  - `rejected` → `[rejected] not executed — you declined the approval\n`, exit 1;
  - `failed` → `AMBIGUOUS.has(code) ? `[failed] ${code} — the action may or may not have reached ${service}\n` : `[failed] ${code}\n``, exit 1, where `service = type?.split(".")[0] ?? "the service"`.
  
  With `--json`, print the raw result and return the same exit code.
- `runCapturesCmd`:
  ```ts
  const code = await withGatewayIpc(
    (c) =>
      runCapturesWith(
        c,
        a,
        { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
        { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
      ),
    paths,
    a.verb === "accept" ? { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS } : {},
  );
  ```
  One connection, one `captures.get`: the TTY guard lives inside `runCapturesWith`, where it is unit-tested through the injected `tty` rather than through `process.stdin`. `withGatewayIpc` already registers the interactive `{ kind: "prompt" }` consent handler by default; never pass another choice here. Import `BATCH_RPC_TIMEOUT_MS` from `../lib/rpc-timeouts.ts`.

`captures-format.ts`:
- `CaptureSummaryView` / `CaptureDetailView` += `expiresAt: number | null`; `CaptureDetailView` += `outcomeRef: string | null`, `errorCode: string | null`. Parse them leniently: non-number or non-string → `null`.
- `formatCaptureTable`: for `kind === "action" && state === "proposed" && expiresAt !== null`, render the STATE cell as `exp ${in(expiresAt, now)}`, where `in` mirrors `ago`. Otherwise show the state as today. PREVIEW is already the gateway's `title` (`actionType: summary`).
- `formatCaptureDetail`: for an action, print `Expires: <ISO>` (and `Outcome: <ref>` / `Error: <code>` when present). The payload loop already prints `actionType`, `input` (JSON) and `summary`. Change the `summary` key's label to `summary (agent-written, unverified)`. For `input`, print `JSON.stringify(v, null, 2)` line by line through `stripControl`, so the owner sees the full verbatim structure.
- `CaptureStatusView` += `actionEnabled`, `actionPending`, `actionMaxPending`, `actionExpiringWithinHour`. Parse them as `=== true` / numbers, defaulting to `false`/`0` so an older gateway still parses.
- `doctorCapturesLines`: after the native-pending lines, mirror the native queue-full shape. The gateway's minimum `action_max_pending` is 1, so the `> 0` guard only stops an older gateway's defaulted `0` from reading as "full":
  ```ts
  if (s.actionEnabled) {
    if (s.actionMaxPending > 0 && s.actionPending >= s.actionMaxPending) {
      lines.push(
        `[warn] MCP capture sink: action queue full (${String(s.actionPending)}/${String(s.actionMaxPending)}): new action proposals are being refused — nimbus captures`,
      );
      exit = 1;
    } else if (s.actionPending > 0) {
      lines.push(
        `[info] MCP capture sink: ${String(s.actionPending)} agent-proposed actions awaiting review (${String(s.actionExpiringWithinHour)} expire within 1h) — nimbus captures`,
      );
    }
  }
  ```
  It sits before the `lines.length === 0` `[ok]` fallback.
- `UNSAFE_TEXT_RE`: widen it the same way Task 5 widened the gateway's `CONTROL_RE`. Replace its tail `​-‍  ‪-‮⁦-⁩﻿` with `­؜᠎​-‏ -‮⁠-⁯﻿` and add the new characters to its comment. Widen `captures.test.ts`'s `HIDDEN_RE` (line 22) to the same set, so its "nothing hidden survives display" assertions cover them, and add an LRM and a word joiner to that test's fixture.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/src/mcp packages/cli/src/commands/captures.test.ts packages/cli/src/commands/captures-cmd.test.ts packages/cli/src/commands/doctor-core.test.ts && bun run typecheck`
Expected: PASS. Existing tests asserting the exact tool list (`["capture_note", …]`) now include `capture_status`; update them.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src
git commit -m "feat(cli): propose_action + capture_status MCP tools; captures accept for actions (TTY-only)"
```

---

### Task 14: E2E — the act door over a real gateway and a real user MCP

**Files:**
- Modify: `packages/gateway/test/e2e/user-mcp.e2e.test.ts` (inside `describe.skipIf(!sandboxAvailable)("a scaffolded user MCP over a real gateway", …)`)

**Interfaces:**
- Consumes: the file's `TestIpcClient`, `paths`, the `prompts`/`approve` consent handler, and `ledgerRowsFor`.

- [ ] **Step 1: Write the tests**

1. In `beforeAll`, before the gateway spawns (step 5), write the config:
   ```ts
   writeFileSync(join(paths.configDir, "nimbus.toml"),
     '[mcp_sink]\nenabled = true\nkinds = ["note", "action"]\naction_ttl_hours = 1\n', "utf8");
   ```
   It comes after `mkdirSync(paths.configDir)`. Confirm from `mcp-capture.e2e.test.ts:90` that the gateway reads `<configDir>/nimbus.toml`.
2. Change the existing `connector.addMcp` call to pass `modelAccess: true`. The existing tests are unaffected: `--model` only widens who may be offered the tools.
3. Add a second client: `const agent = new TestIpcClient();`. Connect it in a new test right after `addMcp`, then `await agent.call("session.declareKind", { kind: "mcp" })`. In `afterAll`, call `agent.close()` beside the existing `client.close()`, before `proc?.kill()`: an open named-pipe handle on Windows can hold the event loop and race the `rmSync(tmp)` cleanup. `TestIpcClient.close()` is `this.sock?.destroy()`, so it is already safe on a client whose connect test never ran.
4. Add these tests after the existing ones and before `connector.remove`:

```ts
  test("act door: propose → capture.state proposed → owner accept → the user MCP got the exact input → executed", async () => {
    const sub = await agent.call<{ id: string; state: string; expiresAt: number }>("capture.submit", {
      kind: "action",
      payload: { actionType: "mcp_echo_srv.echo", input: { text: "from-the-agent" }, summary: "say hi" },
      clientLabel: "e2e-agent",
    });
    expect(sub.state).toBe("proposed");
    expect(await agent.call("capture.state", { id: sub.id })).toMatchObject({ kind: "action", state: "proposed" });

    const before = prompts.length;
    const ledgerBefore = await ledgerRowsFor("mcp_echo_srv");
    approve = true;
    const out = await client.call<{ state: string }>("captures.accept", { id: sub.id });
    expect(out.state).toBe("executed");
    const shown = prompts.slice(before).join("\n");
    expect(shown).toContain("Agent-proposed action");
    expect(shown).toContain('"text": "from-the-agent"');
    expect(shown).toContain('Proposed by MCP client "e2e-agent"');
    const added = (await ledgerRowsFor("mcp_echo_srv")).filter(
      (r) => r.method === "mcp_echo_srv.echo" && !ledgerBefore.some((b) => b.id === r.id),
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ hitlStatus: "approved" });
    expect(await agent.call("capture.state", { id: sub.id })).toMatchObject({ state: "executed" });
  }, 60_000);

  test("act door: the agent cannot accept its own proposal", async () => {
    const sub = await agent.call<{ id: string }>("capture.submit", {
      kind: "action",
      payload: { actionType: "mcp_echo_srv.echo", input: { text: "x" }, summary: "s" },
    });
    await expect(agent.call("captures.accept", { id: sub.id })).rejects.toThrow(/ERR_CAPTURE_FORBIDDEN_CLIENT/);
    await client.call("captures.reject", { id: sub.id });
  }, 30_000);

  test("act door: a first-party write whose connector is not configured is refused at submit", async () => {
    await expect(
      agent.call("capture.submit", {
        kind: "action",
        payload: { actionType: "slack.message.post", input: { channel: "C1", text: "x" }, summary: "s" },
      }),
    ).rejects.toThrow(/ERR_CAPTURE_CONNECTOR_UNCONFIGURED/);
  }, 30_000);

  test("act door: a denied type is refused at submit", async () => {
    await expect(
      agent.call("capture.submit", {
        kind: "action",
        payload: { actionType: "github.pr.merge", input: {}, summary: "s" },
      }),
    ).rejects.toThrow(/ERR_CAPTURE_ACTION_NOT_PROPOSABLE/);
  }, 30_000);
```

`TestIpcClient.call` may reject with the RPC error's message, or put the code under `data.code`. Read the class at the top of the file (`sed -n 41,110p`) and match on whichever it surfaces.

The spec also lists "a non-`--model` server refused" and "an expired action refused at accept". Neither needs a second sandboxed server or a clock: the first is covered by Task 3's `user_mcp_no_model_access` unit test and Task 7's submit tests, and the second by Task 11. The E2E proves the parts only a real gateway can: outer IPC routing for `capture.state` (memory: an IPC method needs ROUTING, not just a handler), the real mesh dispatch, and the real consent round-trip.

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/test/e2e/user-mcp.e2e.test.ts`
Expected: PASS where the sandbox helper is available. On Windows, build it first per memory "fresh-worktree-needs-sandbox-helper-build". Do not run this beside a background preflight; the sandbox ACL concurrency issue is in memory too.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/e2e/user-mcp.e2e.test.ts
git commit -m "test(e2e): act door over a real gateway — propose, owner accept, real user-MCP dispatch"
```

---

### Task 15: Docs, full preflight, strip spec/plan, open the PR

**Files:**
- Modify: `docs/SECURITY-INVARIANTS.md` (§ I28), `docs/architecture.md` (§ Spine S3 / capture sink), `docs/cli-reference.md` (`captures`, MCP tools), `docs/CHANGELOG.md`, `docs/roadmap.md` (S3 capture sink row → 3/3 ✅), `CLAUDE.md`, `GEMINI.md`
- Delete: `docs/superpowers/specs/2026-10-15-mcp-act-door-design.md`, `docs/superpowers/specs/2026-10-15-mcp-act-door-review.md`, `docs/superpowers/plans/2026-10-15-mcp-act-door.md`

- [ ] **Step 1: Write the docs**

- `SECURITY-INVARIANTS.md` § I28: append spec § 12.1's text verbatim. Add D32(e)(f)(g) to the static-rule list, with the stated bound.
- `CLAUDE.md` and `GEMINI.md` (the same edits in both):
  - I28 bullet: append the act-door clause (a shortened § 12.1), and "(static D32(a)–(g))".
  - "Invariants I1–I42; schema V68." → V69.
  - The S3 status paragraph: "PR 3 of 3 shipped <date>: the act door (`propose_action`/`capture_status`, `[mcp_sink] kinds` must list `action`, org-policy `mcp_action`, the NINTH `ai_v2` lockoff; schema V69; D32(e)–(g))"; delete the "**not shipped:** the act door (PR 3, own spec)" clause.
  - The fleet paragraph's lockoff count ("eight since `mcp_capture`…") gains "; nine since `mcp_action`, <date>".
  - The Static complement list: `I28 (D32 — seven rules: …, the act door's accept confinement, the sink's executor/connector import ban, and the mcpToolId literal)`.
- `cli-reference.md`:
  - `nimbus captures accept` on an action: TTY required, the result lines, exit codes.
  - `--kind action` and the new states.
  - The two MCP tools.
  - `[mcp_sink] action_ttl_hours` / `action_max_pending`.
- `architecture.md`: a short act-door subsection covering the flow diagram from spec § 3 and the routing-table rationale from § 6.3.
- `CHANGELOG.md`: one dated entry naming the bounds from § 12.1 and the stated deviations listed at the top of this plan.
- `roadmap.md`: the S3 capture-sink row reads 3/3 ✅ with today's date.

Use today's date, written out absolutely, in every place that names one.

- [ ] **Step 2: Full verification**

Run, from the worktree root:
```bash
bun run preflight:fast
bun run typecheck:tests
bun test packages/gateway/src/mcp-sink packages/gateway/src/connectors packages/gateway/src/ipc/capture-rpc.test.ts packages/gateway/src/security-invariants.test.ts packages/gateway/test/integration/mcp-sink packages/cli/src/mcp packages/cli/src/commands/captures.test.ts scripts/structure-audit
bun run preflight
```
Expected: all green. Fix anything red before continuing; never declare success over a failing check. Also run `bun run audit:platform-test-gaps` and read what it says about the E2E's `skipIf`.

- [ ] **Step 3: Strip the spec, review and plan (never land on main)**

```bash
git rev-parse --abbrev-ref HEAD   # must print dev/asaf/s3-act-door
git rm docs/superpowers/specs/2026-10-15-mcp-act-door-design.md docs/superpowers/specs/2026-10-15-mcp-act-door-review.md docs/superpowers/plans/2026-10-15-mcp-act-door.md docs/superpowers/plans/2026-10-15-mcp-act-door-review.md
git ls-files docs/superpowers   # must print nothing new from this branch: compare with `git ls-tree -r --name-only main docs/superpowers`
git add -A docs CLAUDE.md GEMINI.md
git commit -m "docs: act door — I28, V69, D32(e)-(g), CLI reference; strip spec and plan"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin dev/asaf/s3-act-door
gh pr create --title "feat(mcp): act door — agent-proposed connector actions, owner-accepted (S3, I28)" --body-file <scratchpad>/pr-body.md
```

The PR body is the permanent commit, so write it to the scratchpad first. It covers:
- what shipped;
- the stated deviations (top of this plan);
- the † routing outcome;
- the § 6.2 borderline types left denied;
- the owed follow-up (`nimbus negotiate`'s unattributable lane);
- the test layers;
- the Claude Code attribution line.

Keep `(` and `)` balanced in the body (memory: an unbalanced paren drops the commit from the release). Do not merge. Report the PR URL; merging is the owner's call, after the ten required checks are green.
