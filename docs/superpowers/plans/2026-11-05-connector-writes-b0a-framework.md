# Connector Writes B0a: Wave-2 Framework (Listing, Re-Consent, Door Refusals, Act-Door Preview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything Wave 2 needs before any wave-2 row gets a template, except the before-state reader (B0b): each wave-2 service is listable on its own mesh slot with its own generation; the opt-in records exactly which writes the owner approved and the door offers only those (owner re-consent ruling); the door refuses Slack/Teams posts to ChatOps channels and Notion/Confluence writes aimed at the configured tribal KB (owner rulings); and the MCP sink's act door shows the typed preview, so proposable rows may get templates. No row is turned on.

**Architecture:** Additive changes at A5's seams: `connectors/lazy-mesh/mesh.ts` (listing map), `connectors/connector-writes/enablement-store.ts` + schema V84 (approved set), `engine/connector-write-agent-tools.ts` and its production source (refusals, approved-set filter), `ipc/capture-rpc.ts` + `mcp-sink/capture-act.ts` (typed preview), the desktop component (proposer banner).

**Tech Stack:** Bun, TypeScript strict, bun:sqlite, `bun:test`, vitest for the desktop.

**Spec:** `docs/superpowers/specs/2026-11-04-connector-writes-design.md` § 13 and § 14 (Project B addendum, owner rulings 2026-11-05). **Research:** `C:\Users\asafg\AppData\Local\Temp\claude\C--gitrep-Nimbus\9856f2b4-5546-4961-922c-776c9bd8fb9f\scratchpad\b-research.md`.

## Global Constraints

- Branch from `origin/main` after A5b (#1889) merges. Plans and the spec never land on `main`.
- No wave-2 row gets a template in this PR; production still offers nothing (state it in docs).
- Listing order stays the security property: write-row service → I22 `isConnectorAllowed` → the SERVICE's own credential configured (no network) → only then ensure that service's slot → list that slot filtered by `meshServerForToolKey === service`. Never spawn another slot. Unmapped service → `undefined`, generation `-1`.
- One credential predicate per service, extracted from `lazy-mesh/credential-orchestration.ts` and used by both the orchestration and the listing (no third copy).
- Re-consent: a row is offered only if its tool id is in the enablement's approved set. An opt-in row from before V84 has an empty approved set ⇒ nothing offered until the owner re-enables (fail closed; `status` says so).
- Door refusals happen in the door's per-call checks AFTER the executor check and recheck, BEFORE `ex.execute`: fixed refusal texts, nothing dispatched, no target value echoed.
- Writes to SQLite only via `db/write.ts` (I14); type-only `bun:sqlite` imports (D30); no comparator-less `.sort()`; no `any`; no literal invisible characters.
- Before every push: `bun run preflight:fast`, `bun run typecheck:tests`, once `bun test packages/cli --parallel` (11 pre-existing TUI Yoga failures).
- Do not compile the gateway; never a broad `docker kill`.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JmSjrEwpdoFU8rCxeon9x9`.

## Rulings

- **F1: The listing map** becomes `FIRST_PARTY_LISTING: Record<service, { slot: string; configured(): Promise<boolean>; ensure(): Promise<void> }>` covering the 9 phase-3 services (slot `phase3Bundle`, today's probe) and every wave-2 service in b-research.md's table (gmail, google_drive, outlook, teams, github, gitlab, slack, linear, jira, notion, confluence, discord, apple, obsidian). `toolsGenerationFor(service)` = that slot's generation.
- **F2: The approved set** is a new column `approved_tool_ids TEXT NOT NULL DEFAULT '[]'` (JSON array of row tool ids, sorted) on `connector_write_enablement`, schema V84. `connector.writesEnable` stores the offerable-now tool ids its prompt listed. `status` rows gain `awaitingApproval: number` (offerable now but not approved) and the CLI line appends `, <n> awaiting approval` when non-zero; the enable prompt marks each line `(offered to the model)`, `(new: offered after you approve)` or `(not offered yet)`.
- **F3: ChatOps-channel refusal**: a door call to a Slack or Teams post row whose channel argument (`channel` for `slack_message_post`; `teamId`+`channelId` for `teams_message_post`) is a channel ChatOps listens on (derive from the ChatOps config the gateway already loads; find its source) ⇒ `{ refused: "the model cannot post to a channel Nimbus ChatOps listens on" }`. DMs/chats are not ChatOps channels unless the config says so.
- **F4: KB refusal**: a door call to a Notion or Confluence row whose target id equals the configured `[tribal.notion] database_id` or `[tribal.confluence]` `parent_page_id` (or, for `confluence_page_create`, `spaceKey` + `parentPageId` equal to the KB's) ⇒ `{ refused: "the model cannot write to the Nimbus knowledge base; use the capture flow" }`. Read the config values; never spell the gate-confined tool ids (D19).
- **F5: The act-door preview**: as b-research.md "capture-rpc typed preview design"; the A2 tripwire in `rows.test.ts` is replaced by a positive test (every proposable templated row shows `details.kind === "connector-write"` with a `proposedBy` banner and the provenance header in the prompt).

## Review Focus

1. A bundle slot already running for a sibling must not make an unconfigured service listable.
2. A pre-V84 enablement offers nothing until re-enabled; `status` names the awaiting writes.
3. A post to a ChatOps channel spelled differently (case, `#` prefix, channel id vs name) — decide and test the normalisation the ChatOps config uses.
4. A Confluence page create under the KB parent in the KB space ⇒ refused; elsewhere ⇒ allowed.
5. An MCP-proposed action for a templated row shows the typed preview with the proposer, and its approval still runs through the executor gate once.

---

### Task 1: Per-service listing and generation
Files: `connectors/lazy-mesh/mesh.ts`, `connectors/lazy-mesh/credential-orchestration.ts` (extract the predicate), the mesh listing test file. Tests per Review Focus 1, per-service slot isolation of generations (e.g. github vs google bundle), unmapped → `undefined`/`-1`, the 9 phase-3 services unchanged. Red-prove: list without the credential check → the sibling-bundle test fails. Commit `feat(connectors): list each wave-2 service on its own slot`.

### Task 2: The approved set (V84) and re-consent
Files: `index/connector-write-approved-v84-sql.ts` (+ `simpleStep(83, 84, …)` in `index/migrations/runner.ts`, `CURRENT_SCHEMA_VERSION = 84`, runner tests), `connectors/connector-writes/enablement-store.ts`, `connectors/connector-writes/model-write-source.ts` (offer only approved ids), `ipc/connector-rpc-handlers/model-writes.ts`, `connectors/connector-writes/enable-prompt.ts`, `packages/cli/src/commands/connector-writes-cli.ts`, tests beside each. Red-prove: drop the approved-set filter → the not-approved test fails. Commit `feat(gateway): model writes are offered only as approved`.

### Task 3: The ChatOps-channel and KB refusals
Files: `engine/connector-write-agent-tools.ts` (a `refusal(row, input)` hook on the source, F3/F4), `connectors/connector-writes/model-write-source.ts` (production implementation reading the ChatOps and tribal config), tests (Review Focus 3–4, each with a positive control). Commit `feat(engine): the model door refuses ChatOps channels and the knowledge base`.

### Task 4: The act door shows the typed preview
Files: `ipc/capture-rpc.ts`, `mcp-sink/capture-act.ts` (`formatActionProvenanceLines`), `platform/assemble.ts` (wire `previewCredentialFor`), `connectors/connector-writes/rows.test.ts` (flip the tripwire to the positive test), `packages/ui/src/components/hitl/ConnectorWritePreview.tsx` (proposer banner), tests (Review Focus 5). Commit `feat(gateway): the MCP act door shows the typed write preview`.

### Task 5: Docs
The five core docs (owner rule), `docs/SECURITY-INVARIANTS.md` (I53 bounds: approved set, refusals; I28: the act-door preview; schema V84), `docs/cli-reference.md` (status line, prompt markers), `docs/CHANGELOG.md`, the schema reference, any skill that names the schema version. Gates: `audit:invariants`, `audit:doc-refs`, `audit:status-drift`, `preflight:fast`, `typecheck:tests`. Commit `docs: the Wave-2 framework`.

## PR
- Title: `feat(gateway): Wave-2 framework for model connector writes`. Not breaking (an existing opt-in offers nothing until re-enabled, and nothing was offerable before).
- Body: each change, rulings F1–F5, the owner rulings it implements, tests and red-proofs, attribution. Auto-merge; resolve every thread.
