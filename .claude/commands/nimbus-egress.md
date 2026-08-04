---
name: nimbus-egress
description: >
  S1 "Local Brain" — the Egress Ledger & `nimbus prove`. The always-on, append-only,
  BLAKE3-chained ledger of every authorized outbound action (invariant `I29` / static `D22`):
  one `egress_ledger` row is appended from `engine/executor.ts` `ToolExecutor.gate()` BEFORE
  `connectors.dispatch` — a denied gate writes a `result_status='blocked'` row, and an append
  failure ABORTS the action (fail-closed, never dispatches), so a 0-row window is structurally
  sound. `destination` is the `serviceOf()` action-type prefix (never a raw URL); `payload_summary`
  is `redactAuditPayload`-scrubbed at 256 bytes (a debugging aid, NOT the security boundary); the
  chain reuses `db/audit-chain.ts` genesis + BLAKE3 and verifies timing-safe (I10). The sole
  mutation is the HITL-gated `egress.prune` continuing tombstone (I2 frozen set). Covers the V44
  `egress_ledger` schema, the `egress.*` IPC (4 renderer-exposed reads + the non-exposed prune),
  the `nimbus prove` / `nimbus egress [verify|prune]` CLI, and Vault-reused receipt signing. Use
  when adding or auditing egress-ledger behavior, touching `packages/gateway/src/egress/`, the
  executor dispatch chokepoint, the `egress.*` IPC, the `nimbus prove`/`nimbus egress` CLI, wiring
  the `EgressSink` into a new `ToolExecutor`, or asking why `prove` reports a non-zero or
  `indeterminate` count.
---

# Nimbus S1 "Local Brain" — Egress Ledger & `nimbus prove`

## Why This Skill Exists

Nimbus's central promise is local sovereignty — the machine is the source of truth, the cloud is a connector. The Egress Ledger makes that **provable**: every action the executor authorizes to leave the machine is recorded in a tamper-evident chain *before* it dispatches. `nimbus prove "<query>"` can then answer "did this query send anything outbound?" with a sound `0`, not a hopeful one.

The completeness claim rests on a single structural invariant (`I29`/`D22`): the ledger append is wired into the executor gate that guards `connectors.dispatch`, append-before-dispatch, fail-closed. `D22` confines the literal string `connectors.dispatch` to `executor.ts` — that is a confinement on that literal, not a proof that no other path reaches the network (see the "Static `D22`" section below for what it cannot see). A 0-row window is meaningful only for a binary whose coverage vector says it was watching; Phase 1 adds no new coverage.

## File Map — `packages/gateway/src/egress/`

| File | Role |
|---|---|
| `egress-ledger.ts` | The append-only writer: `appendEgressEntry(db, entry)` reads the head hash (`GENESIS_HASH` if empty; throws on a malformed head — fail-closed), computes the BLAKE3 `row_hash`, and inserts via `dbRun` (I14/D12). `computeEgressRowHash` hashes `prev_hash \| timestamp \| source_type \| source_id \| destination \| method \| hitl_status \| result_status` (mirrors `db/audit-chain.ts`). `EgressSink` + `makeEgressSink(db)` — the DI seam wired into `ToolExecutor`. NO update/delete path lives here. |
| `egress-record.ts` | `buildEgressEntry({ action, hitlStatus, resultStatus, sessionId, now })` → the `EgressEntry` struct. `summarizeDestination` = `serviceOf(action.type)` (the segment before the first dot, never a raw URL). `redactEgressSummary` = `redactAuditPayload` capped at 256 bytes. Result statuses: `"authorized" \| "blocked"`; HITL statuses: `"approved" \| "not_required" \| "rejected"`. |
| `egress-verify.ts` | Read + verify: `verifyEgressChain(db, fromId=0)` walks the chain, recomputes each row hash, and compares with `sha256HexEqualConstantTime` (I10 — never `===`); a `prev_hash`/`row_hash` mismatch fails closed with `brokenAt`. `egressHead` (head + count), `listEgress` (clamped to `MAX_EGRESS_LIST_LIMIT` 5000), and `proveWindow` (the rows + a `{ coverage, outboundEgressEvents, indeterminate }` completeness report + WHOLE-ledger verify — the old scalar `tier` is gone). |
| `egress-source-type.ts` | The FROZEN 8-member `EgressSourceType` union (`task`/`prune`/`session`/`sync`/`model`/`peer`/`boot`/`degraded`). Widening it is **not** a chain break — `verifyEgressChain` recomputes each row's hash from that row's own stored `source_type` column, never from the union's current definition, so a ninth member changes no stored row and no hash input. It's frozen because a `source_type` value written today is permanent in the data, and `isMarkerSourceType`/`MARKER_SOURCE_TYPES` (which exclude `prune`/`boot`/`degraded` from the outbound count — fixed a live miscount: every `egress.prune` tombstone was inflating the reported figure before this landed) depend on the set being known and closed. |
| `egress-coverage.ts` / `egress-boot-marker.ts` | The per-process coverage claim: `CoverageVector`/`CoverageClass`/`Granularity`, `THIS_BINARY_COVERAGE` (what this binary observes — Phase 1 lands `task: "per-call"`, everything else `"none"`), and `appendBootMarker` (writes the serialized vector into the HASHED `source_id` of a `source_type='boot'` row once per process, so the claim is tamper-evident). `THIS_BINARY_COVERAGE` is a compile-time constant decoupled from actual sink wiring — a build that drops the sink but still runs the marker append still claims `task=per-call`. The honest claim is narrower: a *window with no covering boot marker* reports `indeterminate` rather than a false `0`. |
| `egress-sign.ts` | `digestEgressWindow(rows)` (BLAKE3 over ordered row hashes) + `signWindowDigest(vault, digest)` — signs with the Vault-only Ed25519 **share** keypair via `ensureShareKeypair` (no new Vault key; the seed never leaves Vault). Returns only `{ sigB64, pubkeyB64 }`. A LOCAL receipt, not the portable EAF artifact (deferred). |
| `egress-prune.ts` | `pruneEgress(db, beforeTs, now)` — the SOLE mutation. Deletes `timestamp < beforeTs` in one atomic transaction; survivors keep their ORIGINAL `prev_hash`/`row_hash`; appends one `source_type='prune'` tombstone whose `source_id` carries the boundary hash (which IS hashed, so the attestation is tamper-evident). `prunedCount === 0` → no-op, no tombstone. |

**Wiring:** `engine/executor.ts` `ToolExecutor.gate()` (the append site) · `ipc/egress-rpc.ts` (the `egress.*` registry) · `platform/assemble.ts` + `engine/run-ask.ts` + `chatops/chatops-boot.ts` (sink injection) · `cli/src/commands/prove.ts` (CLI).

## Security Invariant — I29 / static D22 (the triple)

**Statement:** every gated action appends exactly **one** `egress_ledger` row from `ToolExecutor.gate()` BEFORE `connectors.dispatch` is called — so a 0-row window is structurally impossible to fake.

1. **Append-before-dispatch** — in `executor.ts`, after the audit record and before the rejected-return, `gate()` calls `egressSink.append(buildEgressEntry(...))`. `execute()` only reaches `connectors.dispatch(action)` when the gate returns `"proceed"`.
2. **Blocked row on deny** — a denied gate appends a `result_status='blocked'` row (`hitl_status='rejected'`) and never dispatches. Both approved and denied decisions are ledgered.
3. **Fail-closed on append failure** — if `EgressSink.append` throws, `gate()` throws, `execute()` propagates, and dispatch never runs. NEVER wrap the append in a swallowing `try/catch` that lets dispatch proceed.
4. **Tamper-evident** — BLAKE3 chain, timing-safe verify (`sha256HexEqualConstantTime`, I10).
5. **Sole mutation** — `egress.prune` is the only sanctioned edit, a continuing tombstone (not a silent gap), and is a member of the `I2` HITL frozen set.

**Static `D22`** (`scripts/structure-audit/check-nimbus-invariants.ts` `checkEgressChokepointConfinement`, runs in `audit:invariants` before tests): (a) a non-test file that spells the literal string `connectors.dispatch` anywhere but `engine/executor.ts` fails the check. (b) `appendEgressEntry` is confined to `packages/gateway/src/egress/`. Test files are exempt.

**What D22 cannot see — read before treating it as total coverage.** D22 is a regex over source text matching one literal string. It does not see a dispatcher decorator that calls `inner.dispatch(action)` under another name (`connectors/connector-write-dispatch.ts` is exactly this shape — benign today because it wraps *around* the executor, but the regex can't distinguish that from a future decorator installed *instead of* it), a façade re-exposing execution under another method name (e.g. a `session.call`-shaped wrapper), or a raw `tool.execute()` on a lazy-mesh tool record. None of these are exploited today; closing them is capability removal (Phase 2 of the I29 security spec), not a stronger regex. The runtime counterpart is the `I29` describe block in `packages/gateway/src/security-invariants.test.ts`, including an assertion that this file's D22 comment states the mechanism (matches the literal string) rather than claiming totality ("no escape hatch"). See `nimbus-security-invariants` for the triple-rule contract.

## The ledger shape — V44 `egress_ledger`

Columns: `id`, `timestamp`, `source_type`, `source_id`, `destination`, `method`, `payload_summary`, `hitl_status` (CHECK `approved`/`not_required`/`rejected`), `result_status` (CHECK `authorized`/`blocked`), `row_hash`, `prev_hash` + 3 lookup indexes (ts / source / dest). Migration `egress-ledger-v44-sql.ts`; see `nimbus-db-migrations`.

- **Append-only, BLAKE3-chained** — reuses `db/audit-chain.ts`'s `GENESIS_HASH` + BLAKE3 primitives. `hitl_status` IS hashed (a post-write consent flip must break verify); `payload_summary` is deliberately NOT hashed (it is lossy/redacted, a debugging aid).
- **`destination` = `serviceOf()` prefix** — the service/host segment of `action.type`, never a raw URL, so no secret-bearing query string is ever stored.
- **`payload_summary` = `redactAuditPayload`-scrubbed, ≤256 bytes** — best-effort credential scrubbing for debugging, NOT the security boundary. The security claim is the append-before-dispatch chokepoint, not the redactor.

## Which `ToolExecutor`s get the sink (completeness wiring)

The egress sink is injected into **every** `ToolExecutor` that reaches a real connector dispatch:

- the agent action path — `run-ask.ts` (`nimbus ask` / `agent.invoke`),
- chatops-approved writes — `chatops/chatops-boot.ts`,
- **both** tribal-capture executors (in-chat KB write + the tribal write path).

Gate-only **stub** executors (7 total, including `vault`, `teamvault`, `reindex`, `data`, `auto-update`, `connector.auth`) deliberately get the **named `NULL_EGRESS_SINK`** — because their actions are LOCAL mutations, not outbound; wiring a real sink there would record non-egress events as egress. `egressSink` is a **REQUIRED** constructor parameter (`private readonly egressSink: EgressSink`, no `?`) — an unwired sink is a compile error, not a silent no-op, and passing `NULL_EGRESS_SINK` explicitly keeps "this executor performs no egress" on the record rather than implicit. Production executors that do dispatch inject `makeEgressSink(db)`.

## Surfaces

- **IPC (`ipc/egress-rpc.ts`):** `egress.head` / `egress.list` / `egress.verify` / `egress.proveWindow` are **read** verbs and ARE renderer-exposed (Tauri `ALLOWED_METHODS`, I7). `egress.proveWindow` takes `since`/`until`/`sign`; `sign === true` attaches a `receipt` (`digestEgressWindow` → `signWindowDigest`). **`egress.prune` is the SOLE mutation** — it routes through `requestPruneApproval` (production: the fail-closed executor consent gate, I2), is NOT renderer-exposed, and returns `{ approved: false, prunedCount: 0 }` on deny. Before exposing any new egress method over LAN/Tauri, consult `nimbus-ipc` + `nimbus-tauri-allowlist`.
- **CLI (`cli/src/commands/prove.ts`):**
  - `nimbus prove "<query>"` — snapshots `egress.head` before, runs the query via `agent.invoke` (blocking), snapshots after, and prints the count diff via `formatProveResult({ label: "during this query", ... })`. It never prints a bare `0 ✓`: a provable window prints `outbound egress events during this query: <N> (scope: …)` with the observed/unobserved coverage classes named, and an unprovable window (no covering boot marker, or a degraded chain) prints `indeterminate — cannot prove zero egress: …` and exits 1 instead of a hopeful `0`. When the delta is non-zero it ALSO prints a second, separately-labeled report via `runEgressReport` (below) — a different number over a different scope, so it gets a different label. `--receipt`/`--sign` attaches a signed receipt.
  - `nimbus egress [verify] [--since <dur>] [--json] [--sign]` — the report (default) or offline chain-verify (`verify`). This is the whole-ledger (or `--since`-windowed) total, NOT a query delta — there is no query on this path — so it renders via `formatProveResult({ label: "in this window", ... })`. A degraded chain prints `indeterminate`, never a false `0`, and exits 1.
  - `nimbus egress prune (--before <ISO|epoch> | --older-than <duration>)` — HITL-gated retention; the two cutoff forms are **mutually exclusive** (supplying both errors). `--older-than` reuses `parseSinceDurationToMs`. The consent prompt is registered inline (`registerConsentPromptHandler`); deny → nothing removed.
- **Receipt signing** reuses the Vault-only Ed25519 **share** keypair (`share.signing.privkey` via `ensureShareKeypair`) — no new Vault key; the private seed never leaves the Vault.

## Why `prove` reports what it reports

`nimbus prove` never prints a bare `0 ✓` — every count is printed with its scope (which coverage classes were actually observed) AND a label true for what the number scopes over (a query delta vs. a whole-window total — see `formatProveResult`'s `label` parameter), because a scopeless-or-mislabeled zero invites the reader to believe more was watched than was, or that two different numbers are the same claim.

- **`outbound egress events during this query: 0 (scope: gated connector actions)`** — head count unchanged across the query, chain intact, and a boot marker covers the window: no gated action dispatched. Sound only for the classes named in `scope`; unobserved classes are listed separately (`not observed: …`) so the zero cannot be misread as "nothing left the machine at all" when only `task` is watched.
- **A non-zero count** — the query dispatched real outbound actions; each is a row. Denied actions still show as `blocked` rows in the report (they were stopped, not silent).
- **`indeterminate — cannot prove zero egress: …`** — either `verifyEgressChain` (run over the WHOLE ledger, `fromId=0`, not just the window) found a break, or no boot marker covers the window so nothing recorded what was being observed. Either way the "zero egress in window W" inference is unsound, so it is reported as unprovable, never as proof of zero, and the CLI exits 1. This is the EAF "indeterminate, never a false zero" rule.

## Gotchas

- **The append site is `gate()`, the dispatch site is `execute()`.** Never add a second literal `connectors.dispatch` call anywhere but `executor.ts` — D22 fails the static audit before tests run. But D22 is a string match, not a capability check: it cannot see a dispatcher decorator, a re-exposing façade, or a raw `tool.execute()`, so a new such path is a code-review judgment call, not something a green `audit:invariants` rules out.
- **Never swallow an append failure.** A `try/catch` around `egressSink.append` that lets dispatch proceed defeats I29. Append failure must abort the action.
- **`appendEgressEntry` lives only in `egress/`.** Naming it outside `egress/*` (non-test) fails D22.
- **Stub executors get `NULL_EGRESS_SINK` on purpose, not "no sink."** `egressSink` is a required constructor param — there is no way to omit it. Don't reflexively pass `makeEgressSink(db)` into vault/teamvault/reindex/data/auto-update/connector.auth — they perform local mutations, not egress.
- **Widening `EGRESS_SOURCE_TYPES` is frozen by policy, not because it's a chain break.** `verifyEgressChain` hashes each row from its OWN stored `source_type`, not from the union, so a ninth member wouldn't break verification of existing rows — but a `source_type` written today is permanent in the data, and `isMarkerSourceType` needs the set closed. A ninth class reuses `session` with a reserved `method` value instead.
- **`coverageForWindow` coverage can never rise after an upgrade (known limitation, not yet fixed).** It merges the weakest coverage over ALL historical boot markers, so the first task-only marker permanently drags every future window down — even a window entirely after a more-capable binary booted. The correct fix is not a plain `since` filter (that would drop the marker covering the window's start) but "the last marker at or before `since`, plus all markers within the window." Don't rediscover this as a bug; it's a documented gap for a later phase — see the comment on `coverageForWindow` in `egress-verify.ts`.
- **This phase adds no new coverage.** Only `THIS_BINARY_COVERAGE.task` is `"per-call"`; don't raise `session`/`sync`/`model`/`peer` without landing the appender that backs the claim.
- **`payload_summary` is not a security control.** It is redacted/capped for debugging; the boundary is the chokepoint. Don't rely on it to keep secrets out, and don't hash it (it's intentionally excluded from `computeEgressRowHash`).
- **`egress.prune` is the only mutation, and it's HITL-gated.** It writes a continuing tombstone (survivors keep their original hashes), so a prune is cryptographically distinguishable from a history rewrite. Don't expose it to the renderer.
- **Verify is whole-ledger, by design.** `proveWindow` verifies `fromId=0`, not just the window — a row deleted/relinked outside the window corrupts a later `prev_hash` without touching window rows, so a window-scoped verify would miss it.
- **No new Vault key for receipts.** Signing reuses the share keypair; don't mint a separate egress signing key.
