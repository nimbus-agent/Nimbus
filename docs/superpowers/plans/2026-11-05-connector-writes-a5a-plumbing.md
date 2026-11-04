# Connector Writes A5a: Model-Door Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the model door (A5b) needs, with no model exposure: actions can carry `origin: "model"`, and the executor never lets a delegate approve one; the consent prompt says when the model asked; the typed preview names the credential kind; the mesh can list one first-party server's tools with their schemas; share replay refuses connector write ids; and the opt-in's `status` and prompt say which covered writes are offerable now.

**Architecture:** Additive changes at existing seams. No tool is offered to the model in this PR, and no production path sets `origin: "model"` yet.

**Tech Stack:** Bun, TypeScript strict, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-04-connector-writes-design.md` (branch `dev/asaf/connector-writes-spec`), § 5.2, § 5.3 and § 13 (the A5 addendum).

**Research:** `C:\Users\asafg\AppData\Local\Temp\claude\C--gitrep-Nimbus\9856f2b4-5546-4961-922c-776c9bd8fb9f\scratchpad\a5-research.md` (file:line references for every seam named here).

## Global Constraints

- Branch from `origin/main` (after A4 #1887 merges). Plans and the spec never land on `main`.
- `origin` only ever REMOVES delegation; whether HITL is required stays decided by `action.type` alone (I3). No production code path sets `origin` in this PR.
- The credential kind is config-derived (`credentialFor(service)`), never read from the payload.
- No comparator-less `.sort()`; no `any`; no literal invisible characters; I14 writes via `db/write.ts`.
- Before every push: `bun run preflight:fast`, `bun run typecheck:tests`; once `bun test packages/cli --parallel` if the CLI is touched (11 pre-existing TUI Yoga failures).
- Do not compile the gateway; never a broad `docker kill`.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JmSjrEwpdoFU8rCxeon9x9`.

## Rulings

- **M1: "Offerable now"** = the row has a preview template AND (`wave < 4` OR the row has a `before` reader). No row has a `before` reader yet, so today the offerable set is empty; this is stated, not hidden. Export it from `connectors/connector-writes/` as `isModelOfferableRow(row): boolean` (the door, `status` and the enable prompt all use this one function).
- **M2: The credential resolver is an optional constructor dependency of `ToolExecutor`** (a 7th, optional `previewCredentialFor?: (service: string) => "personal" | "team"`), passed through to `consentDisplayPayload(action, credentialFor?)` / `formatConsentPrompt(action, credentialFor?)` / `buildConnectorWritePreview(action, credentialFor?)`. Absent, `destination.credential` stays unset (today's behaviour). Production wires it only where A5b's door executor and `buildAskExecutor` are built (A5a wires `buildAskExecutor`; A5b the door) from `platform.connectorWriteDeps.credentialFor(service).credential`.
- **M3: The consent line** for an `origin: "model"` action is `Requested by: the model` (one fixed line after the `Type:` line), on every prompt shape.

## Review Focus

1. An active in-scope delegate and an `origin: "model"` action → the local owner is prompted, on an executor WITH delegation (the ask executor's shape) — pinned.
2. A forged `origin` inside `payload` (not top level) has no effect.
3. A preview whose `credentialFor` throws → the preview shows no credential and the prompt still renders (fail to "unknown", never crash the gate).
4. Listing a server that is not running / not configured / policy-blocked → `undefined`, never a spawn of an unrelated slot.
5. `status` for a service with covered-but-not-offerable writes says so (`offerable: 0`).

---

### Task 1: `origin: "model"` and the delegation refusal

**Files:** `packages/gateway/src/engine/types.ts` (`PlannedAction` gains `origin?: "model"`), `packages/gateway/src/engine/executor.ts` (`tryDelegatedApproval`: `|| action.origin === "model"` in the explicit fallback condition; `formatConsentPrompt`: the M3 line), tests in `engine/executor-delegation.test.ts`, `engine/executor.test.ts` (prompt line), `security-invariants.test.ts` I20 block.

- [ ] Steps: failing tests (Review Focus 1–2; the prompt line on a generic, a typed-preview and a pack-install-shaped action; audit JSON keeps `origin`) → implement → `bun test packages/gateway/src/engine packages/gateway/src/security-invariants.test.ts` → red-prove by removing the condition → commit `feat(engine): an origin "model" action is never approved by a delegate`.

### Task 2: The preview's credential kind

**Files:** `connectors/connector-writes/preview.ts` (`buildConnectorWritePreview(action, credentialFor?)` fills `destination.credential`; a throw → unset), `engine/executor.ts` (M2 constructor param, threaded to both display functions), `engine/run-ask.ts` (`buildAskExecutor` passes `p.previewCredentialFor`; add it to `RunAskParams` as optional), `gateway-main.ts` (wire `(s) => platform.connectorWriteDeps.credentialFor(s).credential`), `renderConnectorWritePreviewLines` (adds `Credential: personal|team` after `Service:` when set), the desktop `ConnectorWritePreview.tsx` (shows it when present), tests beside each.

- [ ] Steps: failing tests (credential shown; absent resolver unchanged byte for byte; throwing resolver → no credential line, prompt renders) → implement → `bun test packages/gateway/src/connectors packages/gateway/src/engine` + `cd packages/ui && bunx vitest run test/components/hitl` → commit `feat(gateway): the write preview names the credential the write will use`.

### Task 3: A raw per-server mesh listing

**Files:** `connectors/lazy-mesh/mesh.ts` (new `listFirstPartyServerTools(service: string): Promise<Readonly<Record<string, unknown>> | undefined>`), its interface type, tests in the mesh test file that covers `listToolsForDispatcher`.

**Behaviour:** find the slot that hosts `service` (a first-party, non-`mcp_`/`ext_` service); if that slot is not running AND its credentials are absent, return `undefined` without spawning; otherwise ensure it is running (the same ensure function `listToolsForDispatcher` uses for that slot), list its MCPClient tools raw (keeping `description` and `inputSchema`), keep only keys with `meshServerForToolKey(key) === service`, drop keys the I22 connector allowlist blocks, and return them. Never spawn any other slot.

- [ ] Steps: failing tests (Review Focus 4; raw entries keep `inputSchema`; foreign-service keys filtered) → implement → `bun test packages/gateway/src/connectors/lazy-mesh` → commit `feat(connectors): list one first-party server's tools with their schemas`.

### Task 4: Share-replay refusal and offerable counts

**Files:** `share/read-tool-registry.ts` (`isReadOnlyToolId` returns false for `isConnectorWriteToolId(id)` as well, defence in depth; import from `connectors/connector-write-registry.ts`, check for an import cycle first), `connectors/connector-writes/` (export `isModelOfferableRow`, M1), `connectors/connector-writes/enablement-store.ts` (`writesEnabledBy` unchanged; add `offerableWritesEnabledBy(service, maxWave)`), `ipc/connector-rpc-handlers/model-writes.ts` (`status` rows gain `offerable: number`; the enable prompt payload's writes gain `offerable: boolean`), `connectors/connector-writes/enable-prompt.ts` (each line ends `  (offered to the model)` or `  (not offered yet)`), the CLI `connector-writes-cli.ts` status line shows `<k> writes, <m> offerable`, tests beside each.

- [ ] Steps: failing tests (Review Focus 5; a write id is not read-only for share replay — use one row id and one `<service>__<tool>` model-tool-shaped name) → implement → focused tests + `bun test packages/cli/src/commands` → commit `feat(gateway): opt-in status and prompt say which writes are offerable now`.

### Task 5: Docs

The five core docs (owner rule; say why any is unchanged), `docs/SECURITY-INVARIANTS.md` (I20: `origin: "model"` is never delegable; I27/share replay note), `docs/cli-reference.md` (status output change), `docs/CHANGELOG.md`. Then `audit:doc-refs`, `audit:status-drift`, `preflight:fast`, `typecheck:tests`; commit `docs: model-door plumbing`.

## PR

- Title: `feat(gateway): plumbing for the model's connector-write door`. Not breaking.
- Body: each seam, M1–M3, the "nothing is offered yet" statement, tests, attribution; auto-merge; resolve every thread.
