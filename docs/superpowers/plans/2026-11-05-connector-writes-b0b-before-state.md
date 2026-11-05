# Connector Writes B0b: The Before-State Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec § 5.4, door-only: a write row may declare a `before` reader (one of its connector's READ tools). When the model door's executor is about to prompt the owner for that write, it first runs the read — ledgered like any connector read — and shows the current state beside the new values in the typed preview. The read never reaches the model, never blocks the prompt (5 s cap), and can never dispatch a write. No row gets a `before` in this PR (B1–B4 add them).

**Architecture:** `BeforeStateReader` on the row type; an optional `beforeState` runner on `ToolExecutor`, passed only by the door's executor (`buildModelWriteExecutor`); a `<service>.before.read` action through `gate()` + dispatch; a dispatcher guard that lets such an action resolve only to a read tool; static rule D40 confining the literal; `before` in the preview, the CLI lines and the desktop.

**Spec:** § 5.4, § 13, § 14 (B0). **Research:** `C:\Users\asafg\AppData\Local\Temp\claude\C--gitrep-Nimbus\9856f2b4-5546-4961-922c-776c9bd8fb9f\scratchpad\b-research.md` ("Before-state machinery design").

## Global Constraints
- Branch from `origin/main` after B-X merges. Plans/spec never on `main`.
- Door-only: only the executor `buildModelWriteExecutor` builds carries the runner; every other door runs no read and its prompt is unchanged byte for byte.
- The read runs AFTER `tryDelegatedApproval` returns `"fallback"` (an owner prompt is about to be shown) and BEFORE the preview is built; on any failure or after 5,000 ms the preview shows `before: unavailable (<fixed reason class>)` — `timeout`, `failed`, `not configured`, `policy requires approval` — never error text, and the prompt proceeds.
- The read is a `PlannedAction` `{ type: "<service>.before.read", payload: { mcpToolId: mcpClientToolKey(service, reader.tool), input: reader.args(input) } }` through the SAME executor's `gate()` then dispatch, so its audit and egress rows land (I29). If that type would require HITL (`HITL_REQUIRED`, user-MCP, or policy), do not run it — show `unavailable (policy requires approval)`; a read never raises a second prompt.
- Dispatcher guard (`connectors/registry.ts` dispatch): an action whose type ends `.before.read` may resolve only to a tool key that `isReadOnlyToolId` accepts AND `isConnectorWriteToolId` rejects; otherwise throw before calling the tool. Test it red.
- Static rule D40 (`check-nimbus-invariants.ts`, D36 shape): the `.before.read` literal appears only in the executor's before-state module and the registry guard; a test that no `*.before.read` type is in `HITL_REQUIRED`.
- The reply: `reader.select(reply)` → `{ label, value }[]`, each value through `sanitisePreviewText`, total capped (e.g. 20 fields, each value shown in full — no truncation rule changes); never returned to the model, never written to the write's audit row (assert both).
- `BeforeStateReader` validation tests: `argKeys` ⊆ the row template's target/field keys; `args` reads only `argKeys`; `tool` is read-only and not a write id; the drift check also requires `tool` in the server's listing (a missing read tool ⇒ the row is still offerable but `before` shows `unavailable (failed)` — decide and test; prefer: not offerable if the row is Wave 4, since § 5.4 makes `before` mandatory there).
- A `before` on a Wave-4 row makes it offerable (`isModelOfferableRow`); B0b adds none.
- No comparator-less sort; no `any`; no literal invisible characters; I14; coverage floor for new src.
- Gates before push as before. Commit trailers as before.

## Tasks
1. **Types and validation:** `connectors/connector-writes/types.ts` `BeforeStateReader { tool: string; argKeys: readonly string[]; args(input: Record<string, unknown>): Record<string, unknown> | undefined; select(reply: unknown): readonly { label: string; value: string }[] }` replacing `before?: unknown`; validation helpers + tests with synthetic rows.
2. **The runner and the executor hook:** `engine/before-state.ts` (`BeforeStateRunner`, the race, the reason classes); `ToolExecutor` optional dep (constructor arg after `previewCredentialFor`, args 6–7 explicit at the one call site); `resolveHitlApproval` calls it at the specified point; `buildModelWriteExecutor` passes it. Tests: runs only on the door executor; ledgered (audit + egress rows for the read); timeout ⇒ unavailable; HITL-required read type ⇒ not run; the read reply never reaches the tool result returned to the model nor the write's audit row.
3. **Dispatcher guard + D40:** the registry guard, its tests (a write key under a `.before.read` type throws, nothing dispatched); D40 with red-proof tests; the `HITL_REQUIRED` test.
4. **The preview:** `ConnectorWritePreview.before?: { status: "ok"; fields } | { status: "unavailable"; reason }`; `renderConnectorWritePreviewLines` prints a `Before:` block; the desktop `ConnectorWritePreview.tsx` renders it (text only); tests both sides.
5. **Docs:** five core docs, SECURITY-INVARIANTS (I53 mechanism + bounds; I29 note that before-reads are ledgered as connector reads; D40), CHANGELOG, architecture.

## PR
Title: `feat(gateway): the model door shows a write's current state before you approve it`. Not breaking (no row has a reader yet). Auto-merge; resolve threads.
