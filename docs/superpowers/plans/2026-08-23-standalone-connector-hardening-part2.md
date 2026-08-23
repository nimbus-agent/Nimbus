# Standalone Connector Hardening — Part 2: rollout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every remaining connector mutation through the consent kit, so all 94 connectors are standalone-eligible and every write tool is declared rather than inferred.

**Architecture:** Part 1 built the mechanism and proved it on `github`. This is the rollout: 36 connectors, ~58 write tools, each declaring a per-connector action type that also exists in the I2 frozen set, plus the I26 registry extension that makes those tool ids visible to the federated-peer write predicate.

**Tech Stack:** Bun 1.2+, TypeScript 7 strict, `@modelcontextprotocol/sdk` 1.30.0, `bun:test`, Biome.

**Spec:** [`../specs/2026-08-23-standalone-connector-hardening-design.md`](../specs/2026-08-23-standalone-connector-hardening-design.md) — Part 1's design; the mechanism is unchanged here.

**Predecessor:** Part 1, `e4d948aa` / #1318 (v2.15.0).

---

## What this is actually for

Part 1's framing said the rollout closes a gateway HITL gap. **It does not, and the plan should not
claim it does.** Measured on `e4d948aa`:

- `jira_issue_create`, and every other non-warehouse write tool id, appears **nowhere** in
  `packages/gateway/src`.
- Of **110** frozen action types, only **18** map to a dispatchable connector tool through
  `connector-write-dispatch.ts`.

So for most of these 36 connectors the gateway declares a gated action type with no path that
reaches the tool. The value here is **standalone eligibility** — 36 connectors becoming usable
outside the gateway with consent, scope and audit — plus defence in depth for a future in which
those tools do become dispatchable.

Where the other 92 action types are dispatched, if at all, is NOT established. Some route through
other paths (I23's ChatOps reply dispatcher, for one). Tracing them is discovery work inside Task 8,
not an assumption this plan rests on.

## Global Constraints

- **No `any`.** `unknown` for external data; TypeScript strict is non-negotiable.
- **No new dependencies.** `ALLOWED_CONNECTOR_DEPS` is unchanged.
- **Additive only on the frozen set.** New per-connector action types are ADDED to
  `HITL_REQUIRED_BACKING`; the existing generic types (`email.send`, `file.create`,
  `calendar.event.create`, `repo.pr.merge`, …) STAY. Removing one silently ungates anything still
  emitting it — the one failure a consent gate must never have.
- **I2 is a live invariant.** Any commit touching `HITL_REQUIRED_BACKING` carries the triple:
  wiring + `docs/SECURITY-INVARIANTS.md` + an enforcement test. Adding entries does not change the
  mechanism, so the docs burden is a sentence, not a section.
- **Tests colocated** as `<name>.test.ts`, using `bun:test`.
- **Coverage floor: ≥85% line AND ≥80% branch per file**, CI-Linux-authoritative.
- **Branch:** `dev/asafgolombek/connector-hardening-part2`. Never commit on `main`.
- **Red-prove every test by reverting the fix.** A test that has never failed proves nothing.
- Run `bun run preflight:fast` before the final commit of each task.

## The action-type naming rule

Every migrated write tool declares `mutates: "<service>.<object>.<verb>"`, where `<service>` is the
connector's service id — `gmail`, `outlook`, `bitbucket` — **never** a generic bucket.

This is the whole point of the per-connector scheme, and it is not cosmetic. `serviceOf()` takes the
prefix before the first dot and feeds two invariants:

- **I29** — it is the egress ledger's `destination`. Under `email.send` the ledger records
  `"email"`, which is not a service; `nimbus prove` would tell a user their data went to "email".
  Under `gmail.message.send` it records `gmail`.
- **I20** — it is the service scope for a delegated HITL approval. You cannot delegate "gmail but
  not outlook" when both are `email.send`.

**Do not derive the string mechanically.** A naive transform was tried and mangled several:
`gdrive_file_create` became `file.file.create`; `azure_app_service_restart` already exists as
`azure.app_service.restart`; `confluence_kb_append` already exists as `confluence.knowledge.write`.
Each tool needs a human decision. The measured split on `e4d948aa`: **32** of the ~58 tools already
have a matching frozen action type; ~26 need a new one, and several of those 26 are mis-derivations
that resolve to an existing entry on inspection.

### github is revised too

Part 1 shipped `github` declaring `repo.pr.merge`, `repo.pr.close`, `repo.issue.create`,
`repo.branch.delete`, `repo.tag.create` — generic types shared with gitlab and bitbucket. Under this
scheme they become `github.*`. Task 2 does that, and it is the smallest possible exercise of the
whole change: one already-migrated connector, five tools, a mechanism already proven.

---

### Task 1: Extend the frozen set and the write registry

The two structural changes, landed before any connector depends on them.

**Files:**

- Modify: `packages/gateway/src/engine/executor.ts` (`HITL_REQUIRED_BACKING`)
- Create: `packages/gateway/src/connectors/connector-write-tool-ids.ts`
- Modify: `packages/gateway/src/connectors/connector-write-registry.ts`
- Modify: `docs/SECURITY-INVARIANTS.md` (I2 and I26 entries)
- Test: `packages/gateway/src/connectors/connector-write-registry.test.ts`
- Test: `packages/gateway/src/security-invariants.test.ts`

**Interfaces:**

- Produces: `MIGRATED_WRITE_TOOL_IDS: ReadonlySet<string>`, and `isConnectorWriteToolId` widened to
  consult it in addition to the two existing 1:1 SSoTs.

**Why a separate set rather than more `ConnectorWrite` rows.** `CONNECTOR_WRITES` asserts BOTH
`toolId` and `actionType` are unique, and it drives `connectorWriteByActionType`, which is real
dispatch routing. The migrated tools have no dispatch mapping, and several share an action type
until their per-connector type lands. A set expresses exactly what I26 needs — *is this tool id a
write?* — without inventing dispatch rows for tools nothing dispatches.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";

import { HITL_REQUIRED } from "../engine/executor.ts";
import {
  CONNECTOR_WRITES,
  isConnectorWriteToolId,
  MIGRATED_WRITE_TOOL_IDS,
} from "./connector-write-registry.ts";

describe("migrated write tool ids", () => {
  test("the I26 predicate covers migrated tools, not just the dispatchable 18", () => {
    expect(isConnectorWriteToolId("github_branch_delete")).toBe(true);
    // Still true for the original dispatchable rows.
    expect(isConnectorWriteToolId("argocd_app_sync")).toBe(true);
    // Still false for reads.
    expect(isConnectorWriteToolId("github_repo_list")).toBe(false);
  });

  test("every migrated tool id is distinct from the dispatchable rows", () => {
    for (const id of MIGRATED_WRITE_TOOL_IDS) {
      expect(CONNECTOR_WRITES.some((w) => w.toolId === id)).toBe(false);
    }
  });

  test("ADDITIVE: the generic action types survive alongside the per-connector ones", () => {
    // Removing a generic type silently ungates anything still emitting it.
    for (const generic of ["email.send", "file.create", "calendar.event.create", "repo.pr.merge"]) {
      expect(HITL_REQUIRED.has(generic)).toBe(true);
    }
  });

  test("each per-connector type's serviceOf prefix is a real service, not a bucket", () => {
    // This is why the scheme exists: the prefix is I29's egress destination and I20's
    // delegation scope. "email" is not somewhere data can go; "gmail" is.
    expect(HITL_REQUIRED.has("github.pr.merge")).toBe(true);
    expect(HITL_REQUIRED.has("github.branch.delete")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/connector-write-registry.test.ts`
Expected: FAIL — `MIGRATED_WRITE_TOOL_IDS` is not exported.

- [ ] **Step 3: Write minimal implementation**

Create `connector-write-tool-ids.ts` holding the growing set, seeded with github's five:

```ts
/**
 * Write tool ids routed through the consent kit but NOT dispatchable from the gateway.
 *
 * Separate from `CONNECTOR_WRITES` on purpose. That registry is a 1:1 actionType↔toolId map
 * driving `connector-write-dispatch.ts`; these tools have no dispatch path, and inventing rows for
 * them would put fictional routing in a real routing table. I26's predicate asks only "is this a
 * write tool id?", which a set answers exactly.
 *
 * Grows one wave at a time as connectors migrate. When a tool gains a dispatch path it graduates
 * to a `ConnectorWrite` row and leaves this set.
 */
export const MIGRATED_WRITE_TOOL_IDS: ReadonlySet<string> = new Set([
  "github_pr_merge",
  "github_pr_close",
  "github_issue_create",
  "github_branch_delete",
  "github_tag_create",
]);
```

Widen the predicate in `connector-write-registry.ts`:

```ts
export function isConnectorWriteToolId(toolId: string): boolean {
  return (
    isWarehouseWriteToolId(toolId) ||
    isGitopsMlWriteToolId(toolId) ||
    MIGRATED_WRITE_TOOL_IDS.has(toolId)
  );
}
```

Add github's five per-connector action types to `HITL_REQUIRED_BACKING`, leaving `repo.*` in place.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors packages/gateway/src/security-invariants.test.ts`
Expected: PASS.

- [ ] **Step 5: Red-prove the predicate**

Remove `MIGRATED_WRITE_TOOL_IDS.has(toolId)` from the predicate, confirm the first test FAILS, restore it.

- [ ] **Step 6: Update `docs/SECURITY-INVARIANTS.md`**

I2: note that per-connector action types are added additively and the generics remain.
I26: note the predicate now also consults `MIGRATED_WRITE_TOOL_IDS`, and why a set rather than rows.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/engine/executor.ts packages/gateway/src/connectors docs/SECURITY-INVARIANTS.md
git commit -m "feat(gateway): per-connector write action types and the migrated-tool predicate"
```

---

### Task 2: Re-declare `github` on per-connector action types

The smallest exercise of the scheme: one already-migrated connector, five tools.

**Files:**

- Modify: `packages/mcp-connectors/github/src/server.ts`
- Modify: `packages/mcp-connectors/github/test/write-tools.test.ts`

- [ ] **Step 1: Update the test's expected action types**

```ts
test("every mutating tool declares a per-connector action type", () => {
  for (const mutates of [
    "github.pr.merge",
    "github.pr.close",
    "github.issue.create",
    "github.branch.delete",
    "github.tag.create",
  ]) {
    expect(src).toContain(`mutates: "${mutates}"`);
  }
});

test("no migrated tool declares a generic cross-service type", () => {
  // repo.pr.merge is shared by github, gitlab and bitbucket, so it cannot tell I29's egress
  // ledger which service was written to.
  expect(src).not.toContain('mutates: "repo.');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/mcp-connectors/github`
Expected: FAIL — the source still declares `repo.*`.

- [ ] **Step 3: Change the five `mutates` values in `server.ts`**

- [ ] **Step 4: Run to verify it passes, and that the e2e surface is unchanged**

Run: `bun test packages/mcp-connectors/github`
Expected: PASS, including both existing e2e cases — the tool SURFACE must not change, only the
declared action type.

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor(github): declare per-connector action types"
```

---

### Tasks 3–8: connector waves

Six waves of ~6 connectors. Each wave is one PR-sized unit and repeats the SAME shape, so the steps
are given once here rather than copied six times.

| Wave | Task | Connectors |
|---|---|---|
| Repos + CI | 3 | bitbucket, gitlab, github-actions, circleci, jenkins, iac |
| Comms | 4 | slack, teams, discord, notion, confluence, obsidian |
| Tickets | 5 | jira, linear, pagerduty |
| Mail + calendar | 6 | gmail, outlook, apple, fastmail, imap, protonmail |
| Files + cloud | 7 | google-drive, onedrive, aws, azure, gcp, kubernetes |
| Warehouse remainder | 8 | snowflake, tableau, looker, powerbi, monte-carlo, bigeye, argocd, flux, mlflow |

**Wave 8 is different** and should be done LAST: those nine already have `ConnectorWrite` rows with
dispatch mappings. Their tools graduate the other way — they stay in `CONNECTOR_WRITES` and must NOT
be added to `MIGRATED_WRITE_TOOL_IDS`, or the "distinct from the dispatchable rows" test fails.

**Per-wave steps, for each connector in the wave:**

- [ ] **Step 1: Inventory its real write tools by reading the source**

Do NOT trust a name heuristic. Part 1 proved the trap in both directions: seven read-only connectors
POST for GraphQL, filter endpoints and OAuth, and `obsidian`'s only write tool is
`obsidian_append_to_daily_note`, which no `_(create|update|delete)` pattern matches. Read each
tool's handler and decide whether it mutates.

- [ ] **Step 2: Choose each tool's action type**

`<service>.<object>.<verb>`. If a matching type already exists in `HITL_REQUIRED_BACKING` **and its
prefix is the connector's own service**, reuse it — `jira.issue.create`, `slack.message.post` and
`pagerduty.incident.acknowledge` all already qualify. If the existing type is generic
(`repo.pr.merge`, `email.send`, `file.create`), add a per-connector one and leave the generic alone.

- [ ] **Step 3: Write the connector's failing test**

Mirror `github/test/write-tools.test.ts`: an out-of-process e2e that boots the real connector with a
client that does and does not advertise `elicitation`, asserting the write tools appear only in the
first. That test is what caught Part 1's registration-timing bug; a source-text assertion would not
have.

- [ ] **Step 4: Run it and watch it fail**

- [ ] **Step 5: Migrate the tools to `registerWriteTool`**

Per tool decide `recoverable`, and supply `capturePreState` when it is `false`. Where the pre-state
is genuinely unqueryable — the resource may already be gone, or reading it costs a chain of API
calls — capture the identifying parameters instead of nothing. A record saying WHICH thing was
destroyed still beats silence, and a throw is safe: the kit catches it and records
`{ captureFailed }` rather than blocking a mutation the owner already approved. Give the connector a
`registerWriteTool` built from `createWriteToolRegistrar` with its `scopeEnv` and `scopeKinds`.
Remove any `(requires HITL ...)` prose from migrated descriptions — the requirement lives in
`mutates` now, and keeping both invites drift.

- [ ] **Step 6: Add the tool ids to `MIGRATED_WRITE_TOOL_IDS` and any new action types to the frozen set**

- [ ] **Step 7: Fix that connector's in-process test files**

If the connector has a test importing `src/server.ts` directly — 18 files do, all in waves 8 and 5 —
add `setConnectorMode("gateway")` in a `beforeAll`, and reset in BOTH `beforeEach` and `afterEach`.
`bun test` runs many files in ONE process, verified, so an unreset lock changes every later file.

- [ ] **Step 8: Verify the connector is now standalone-eligible**

```bash
bun -e 'import {standaloneEligibility} from "./packages/mcp-connectors/standalone/src/launcher.ts"; console.log(standaloneEligibility("<id>"))'
```

Expected: `{ eligible: true, reason: "hardened" }`.

- [ ] **Step 9: Run the gates and commit the wave**

```bash
bun test packages/mcp-connectors packages/gateway/src/connectors
bun run preflight:fast
```

---

### Task 9: Correct `discord`'s manifest

`discord` declares `["write", "delete"]` and exposes only `discord_channel_list`,
`discord_channel_messages`, `discord_guild_list`, `discord_thread_list` — all reads. It
OVER-declares, so the eligibility gate refuses a read-only connector. Fail-safe direction, still
wrong.

**Files:** `packages/mcp-connectors/discord/nimbus.extension.json`

- [ ] **Step 1: Confirm by reading every tool handler** that none mutates. Do not trust the tool names.
- [ ] **Step 2: Set `hitlRequired` to `[]`.**
- [ ] **Step 3: Assert eligibility flips**

```ts
expect(standaloneEligibility("discord")).toEqual({ eligible: true, reason: "no-writes" });
```

---

### Task 10: Make the mutation rule blocking

Only after every wave has landed.

**Files:** `scripts/structure-audit/check-connector-consent.ts`, its test

- [ ] **Step 1: Flip `MUTATION_RULE_BLOCKING` to `true`.**
- [ ] **Step 2: Run `bun run audit:connector-consent` and expect exit 0 with zero advisories.**
- [ ] **Step 3: Red-prove** — revert one connector's `registerWriteTool` call and confirm the gate now exits 1 rather than warning.
- [ ] **Step 4:** Note in the source that the rule's HTTP-verb signal still has documented false positives, so a future failure may need confirming against the connector's real tool surface.

---

## Final verification

- [ ] `bun run preflight` — full CI parity.
- [ ] `bun run verify:docker --full` — Linux coverage floor. **Capture the exit code without a pipe**; `| tail` reports `tail`'s status and has masked a real failure three times.
- [ ] `bun run build` + `bun run test:connector-boot` — all 94 boot from the compiled binary.
- [ ] **Gateway regression:** boot a migrated connector from the compiled binary with a client advertising NO elicitation; every write tool must still be present. This is the check that proves the standalone gate has not leaked into the gateway.
- [ ] Standalone eligibility is **94 of 94**.
- [ ] The 3 exec-sandbox `test:ci` failures under `verify:docker` are EXPECTED — it sets `CI=true` without installing sandbox prerequisites. They pass in real CI.

## Spec coverage

| Item | Task |
|---|---|
| Per-connector action types, additive | 1, 2, and each wave's step 6 |
| I26 predicate covers migrated tools | 1 |
| 36 connectors migrated | 3–8 |
| 18 in-process test files | each wave's step 7 |
| discord manifest | 9 |
| `MUTATION_RULE_BLOCKING` | 10 |

---

## Plan review disposition (2026-08-23)

Four items raised in `…-part2-review.md`. Two were verified and rejected on evidence; one was
already implemented but untested; one found a real defect shipped in Part 1.

| Item | Verdict | Basis |
|---|---|---|
| 1 — concurrent test files race on the process-global mode | **Rejected, measured** | `bun test` runs files SEQUENTIALLY — probed: `A start → A end (300ms later) → B start`. No `--parallel`, `--concurrent` or `--isolate` appears in any test script, workflow or `bunfig.toml`. The repo already depends on this: `embedding-worker-core.test.ts` carries "do NOT mark these `it.concurrent` — this shared tracker assumes Bun's default sequential execution." And `--parallel` **implies `--isolate`**, i.e. separate worker processes, so adopting it would make the module global per-process and remove the race AND the cross-file leak. The leak the plan already handles is the real hazard; the race is not. |
| 1b — thread the mode through a context object instead of a global | **Rejected** | The mode must be readable at module scope, during registration, before any server object exists — connectors register tools at import time. Threading a context would mean restructuring all 94 connectors, and would make the mode caller-supplied, which is exactly what Non-Negotiable #2 forbids. A per-process property is correctly modelled by a per-process global. |
| 2 — downstream consumers hardcoding generic prefixes | **Accepted as a check; came back clean** | Nothing compares a destination or service to `"email"` / `"file"` / `"calendar"` / `"repo"`. `destination` is an opaque `string` on the ledger row and `prove.ts` treats it as text. Historical rows keep their old prefixes, which is correct for an append-only record of what was true at the time. |
| 3 — `capturePreState` failure must not crash or block | **Already implemented, was UNTESTED** | Part 1's `guarded` handler catches the throw and records `{ captureFailed }`. Nothing proved it. A test now does, red-proved by making the throw fatal. Wave step 5 gains the fallback guidance. |
| 4 — ensure the blocking rule actually runs in CI | **Accepted — found a real defect** | `audit:connector-consent` was **not run by any workflow**. #1318 added it to `preflight-gates.ts` and nowhere else, so it gated local runs and no PR — and CI went green on #1318 precisely because it never ran. Now wired into `_test-suite.yml` beside its three siblings. The second half of the suggestion was already satisfied: the verb rule's false positives are documented in the source. |

**A guard was added for item 4's class, narrowly.** `preflight-gates.test.ts` now asserts every
`audit:connector-*` manifest gate appears in a workflow. Scoped deliberately: a blanket check over
all 39 manifest gates was measured first and reports 7, most of them false — `audit:any` runs in CI
as `count-any-usage.ts --check`, `test:ci` as the suite itself, `lint` under its own step name. This
family is always invoked as `bun run <name>`, so a name match is exact. `_test-suite.yml` already
carried a comment about this same class of bug from an earlier occurrence; it is now a mechanism.

**One incidental finding, recorded not fixed.** The new test initially failed because it set
`NIMBUS_MCP_AUDIT_LOG` *after* `createWriteToolRegistrar`, which reads its env once at construction.
It nonetheless got as far as the mutation, because a previous test's scope env was still set — so
test env leaks between cases in this file. Harmless today; if a case ever depends on an env var
being UNSET it will mislead. Any wave adding cases here should set env before constructing the
registrar, as `registerAndGet` already does.
