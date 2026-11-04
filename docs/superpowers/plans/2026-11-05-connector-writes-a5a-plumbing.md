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
- **M2: The credential resolver is an optional constructor dependency of `ToolExecutor`** (a 7th, optional `previewCredentialFor?: PreviewCredentialResolver`, where `type PreviewCredentialResolver = (service: string) => "personal" | "team"` is declared in `connectors/connector-writes/types.ts` — never in `executor.ts`, so `preview.ts` never imports the executor). Because parameter 6 (`policy`) has a default, a caller passing parameter 7 must pass parameter 6 explicitly (`p.policyHitl ?? NO_POLICY_OVERLAY`). It is passed through to `consentDisplayPayload(action, credentialFor?)` / `formatConsentPrompt(action, credentialFor?)` / `buildConnectorWritePreview(action, credentialFor?)`. Absent, `destination.credential` stays unset (today's behaviour). Production wires it only where A5b's door executor and `buildAskExecutor` are built (A5a wires `buildAskExecutor`; A5b the door) from `platform.connectorWriteDeps.credentialFor(service).credential`. Both `runAsk` construction sites in `gateway-main.ts` pass it: `setAgentInvokeHandler` and `createChatOpsAskEngine`. Gate-only executors (`ipc/server/dispatchers.ts`) do not.
- **M4: The resolver can never break the gate.** `buildConnectorWritePreview` calls it inside its own `try/catch` and accepts only the exact strings `"personal"` or `"team"` (anything else, or a throw, leaves `credential` unset). `consentDisplayPayload` and `formatConsentPrompt` therefore never throw because of it — otherwise `gate()` would rethrow before writing its audit and egress rows.
- **M3: The consent line** for an `origin: "model"` action is `Requested by: the model` (one fixed line after the `Type:` line), on every prompt shape.

## Review Focus

1. An active in-scope delegate and an `origin: "model"` action → the local owner is prompted, on an executor WITH delegation (the ask executor's shape) — pinned.
2. A forged `origin` inside `payload` (not top level) has no effect.
3. A preview whose `credentialFor` throws → the preview shows no credential and the prompt still renders (fail to "unknown", never crash the gate).
4. Listing a server that is not running / not configured / policy-blocked → `undefined`, never a spawn of an unrelated slot.
5. `status` for a service with covered-but-not-offerable writes says so (`offerable: 0`).

---

### Task 1: `origin: "model"` and the delegation refusal

**Files:** `packages/gateway/src/engine/types.ts` (`PlannedAction` gains `origin?: "model"`), `packages/gateway/src/engine/executor.ts` (`tryDelegatedApproval`: `|| action.origin === "model"` in the explicit fallback condition; `formatConsentPrompt`: the M3 line), tests in `engine/executor-delegation.test.ts`, a NEW `engine/executor-origin.test.ts` (the prompt line; there is no `engine/executor.test.ts`), `security-invariants.test.ts` I20 block.

- [ ] Steps: failing tests (Review Focus 1–2; the prompt line on a generic, a typed-preview and a pack-install-shaped action; audit JSON keeps `origin`) → implement → `bun test packages/gateway/src/engine packages/gateway/src/security-invariants.test.ts` → red-prove by removing the condition → commit `feat(engine): an origin "model" action is never approved by a delegate`.

### Task 2: The preview's credential kind

**Files:** `connectors/connector-writes/types.ts` (`PreviewCredentialResolver`), `connectors/connector-writes/preview.ts` (`buildConnectorWritePreview(action, credentialFor?)` fills `destination.credential` per M4), `engine/executor.ts` (M2 constructor param, threaded to both display functions), `engine/run-ask.ts` (`buildAskExecutor` passes `p.previewCredentialFor` as argument 7 with `p.policyHitl ?? NO_POLICY_OVERLAY` as argument 6; add the field to `RunAskParams` as optional), `gateway-main.ts` (both `runAsk` sites: `(s) => platform.connectorWriteDeps.credentialFor(s).credential`), `renderConnectorWritePreviewLines` (adds `Credential: personal|team` after `Service:` when set), tests beside each. The desktop `ConnectorWritePreview.tsx` already renders `destination.credential` (its `headerRows`); only re-run its tests.

- [ ] Steps: failing tests (credential shown; absent resolver unchanged byte for byte; a throwing resolver and one returning `"x"` → no credential line, the prompt renders, and `gate()` still writes its audit and egress rows) → implement → `bun test packages/gateway/src/connectors packages/gateway/src/engine` + `cd packages/ui && bunx vitest run test/components/hitl` → commit `feat(gateway): the write preview names the credential the write will use`.

### Task 3: A raw per-server mesh listing

**Files:** `connectors/lazy-mesh/mesh.ts` (new `listFirstPartyServerTools(service: string): Promise<Readonly<Record<string, unknown>> | undefined>`), its interface type, tests in the mesh test file that covers `listToolsForDispatcher`.

**Behaviour, in this order (every check before any slot is touched):**
1. `service` must be a first-party service that has rows in the write table (not `mcp_*` / `ext_*`); otherwise `undefined`.
2. `if (!this.isConnectorAllowed(service)) return undefined` (I22) — before anything else can spawn.
3. The SERVICE itself must be configured (its own vault credential, the check the spawner uses for that service, not merely "the slot is running"); otherwise `undefined`.
4. Only then ensure that service's slot is running, through an explicit map from service to the slot's ensure method on `LazyConnectorMesh` (e.g. the nine Phase-3 data/BI and GitOps/ML services → `ensurePhase3BundleRunning()`; write the map from the slot definitions, and fail closed with `undefined` for a service the map does not name). `listToolsForDispatcher` does NOT use per-slot ensure functions (it batch-spawns via `ensureCredentialConnectorsRunning`), so do not copy it.
5. List that slot's MCPClient tools raw (keeping `description` and `inputSchema`), keep only keys with `meshServerForToolKey(key) === service`, and return them. Never spawn any other slot.

- [ ] Steps: failing tests (Review Focus 4, one per guard: a policy-blocked service with credentials present spawns nothing; an unconfigured service in an already-running bundle returns `undefined`; an unmapped service returns `undefined`; raw entries keep `inputSchema`; foreign-service keys filtered) → implement → `bun test packages/gateway/src/connectors/lazy-mesh` → commit `feat(connectors): list one first-party server's tools with their schemas`.

### Task 4: Share-replay refusal and offerable counts

**Files:** `share/read-tool-registry.ts` (`isReadOnlyToolId(toolId, writeIds = CONNECTOR_WRITE_TOOL_IDS)` returns false for a write id, bare or namespaced, before the read-verb check; `CONNECTOR_WRITE_TOOL_IDS` is built from `CONNECTOR_WRITE_ROWS` imported from `connectors/connector-writes/index.ts` — never `connector-write-registry.ts`, which pulls in the ChatOps and tribal gates — and matched with `connectors/namespaced-tool-id.ts`'s `matchesBareOrNamespacedToolId`), `connectors/connector-writes/types.ts` (`ConnectorWriteRow` gains `readonly before?: unknown`, unused until Waves 2–4, so M1 type-checks), `connectors/connector-writes/` (export `isModelOfferableRow`, M1), `connectors/connector-writes/enablement-store.ts` (`writesEnabledBy` unchanged; add `offerableWritesEnabledBy(service, maxWave)`), `ipc/connector-rpc-handlers/model-writes.ts` (`status` rows gain `offerable: number`; the enable prompt payload's writes gain `offerable: boolean`), `connectors/connector-writes/enable-prompt.ts` (each line ends `  (offered to the model)` or `  (not offered yet)`), the CLI `connector-writes-cli.ts` status line becomes `<service>  enabled  wave <n>  <k> writes, <m> offerable now` when enabled and stays `<service>  off` when not; `--json` carries `offerable` on every row, tests beside each.

- [ ] Steps: failing tests (Review Focus 5; share replay: no real write id ends in a read verb today, so the "every row id is refused" assertion is a regression guard, labelled so; the test that can fail injects a synthetic write id ending in a read verb, e.g. `fx_report_export`, through the `writeIds` parameter, and its `<service>__fx_report_export` form) → implement → focused tests + `bun test packages/cli/src/commands` → commit `feat(gateway): opt-in status and prompt say which writes are offerable now`.

### Task 5: Docs

The five core docs (owner rule; say why any is unchanged), `docs/SECURITY-INVARIANTS.md` (I20: `origin: "model"` is never delegable; I27/share replay note), `docs/cli-reference.md` (status output change), `docs/CHANGELOG.md`. Then `audit:doc-refs`, `audit:status-drift`, `preflight:fast`, `typecheck:tests`; commit `docs: model-door plumbing`.

## PR

- Title: `feat(gateway): plumbing for the model's connector-write door`. Not breaking.
- Body: each seam, M1–M3, the "nothing is offered yet" statement, tests, attribution; auto-merge; resolve every thread.
