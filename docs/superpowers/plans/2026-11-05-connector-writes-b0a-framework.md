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
- One credential predicate per SERVICE in a new `connectors/lazy-mesh/service-credential.ts` (`isServiceCredentialConfigured(vault, service, ctx): Promise<boolean>`), reading stored vault keys and context only — NEVER a token refresh or any network call. Today's orchestration has bundle-level checks (e.g. `anyGoogleOAuthVaultPresent`) and none for obsidian, so write per-service ones (gmail and google_drive via `resolveGoogleOAuthVaultKey(vault, id) !== null`; obsidian via `ctx.obsidianVaultPaths.length > 0`; discord via `enabled === "1"` and the bot token), and have the orchestration reuse them where it already checks the same thing.
- A configured sibling never stands in for an unconfigured service: `toolsGenerationFor(service)` returns `-1` unless the service is mapped AND configured, and `listFirstPartyServerTools(service)` returns `undefined` (not `{}`) when the service is unconfigured or its server is absent from the running slot's listing.
- Re-consent: a row is offered only if its tool id is in the enablement's approved set, checked BOTH when listing (`offerableEnabledRows`) AND in the per-call `recheck(row)`. An opt-in row from before V84 has an empty approved set ⇒ nothing offered until the owner re-enables (fail closed). `status` reports `offerable` as approved-and-offerable only, plus `awaitingApproval` (offerable but not approved), so a pre-V84 opt-in reads `0 offerable now, N awaiting approval`.
- Door refusals happen in the door's per-call checks AFTER the executor check and recheck, BEFORE `ex.execute`: fixed refusal texts, nothing dispatched, no target value echoed.
- Writes to SQLite only via `db/write.ts` (I14); type-only `bun:sqlite` imports (D30); no comparator-less `.sort()`; no `any`; no literal invisible characters.
- Before every push: `bun run preflight:fast`, `bun run typecheck:tests`, once `bun test packages/cli --parallel` (11 pre-existing TUI Yoga failures).
- Do not compile the gateway; never a broad `docker kill`.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JmSjrEwpdoFU8rCxeon9x9`.

## Rulings

- **F1: The listing map** becomes `FIRST_PARTY_LISTING: Record<service, { slot: string; configured(): Promise<boolean>; ensure(): Promise<void> }>` covering the 9 phase-3 services (slot `phase3Bundle`, today's probe) and every wave-2 service in b-research.md's table (gmail, google_drive, outlook, teams, github, gitlab, slack, linear, jira, notion, confluence, discord, apple, obsidian). `toolsGenerationFor(service)` = that slot's generation.
- **F2: The approved set** is a new column `approved_tool_ids TEXT NOT NULL DEFAULT '[]'` (JSON array of row tool ids, sorted) on `connector_write_enablement`, schema V84. `connector.writesEnable` stores the offerable-now tool ids its prompt listed. `status` rows gain `awaitingApproval: number` (offerable now but not approved) and the CLI line appends `, <n> awaiting approval` when non-zero; the enable prompt marks each line `(offered to the model)`, `(new: offered after you approve)` or `(not offered yet)`.
- **F3: ChatOps-channel refusal**: a door call to `slack_message_post` (`channel`), `teams_message_post` (`teamId` + `channelId`) or `teams_message_post_chat` (`chatId`) whose destination matches a channel or chat ChatOps listens on ⇒ `{ refused: "the model cannot post to a channel Nimbus ChatOps listens on" }`. The ChatOps bindings come from `EnforcedPolicy["chatops"]` (the live `enforcedPolicy()` the source already receives; confirm the exact field in `chatops/chatops-boot.ts`). Normalise both sides before comparing: trim, strip a leading `#`, lowercase, percent-decode (Teams ids), and match a configured name OR id (if the config stores names and the model sends an id, or vice versa, and the gateway cannot map one to the other without a network call, REFUSE — fail closed for any destination that cannot be proven not to be a ChatOps channel when ChatOps is configured for that platform).
- **F4: KB refusal**: from the `[tribal]` config (`tribal/tribal-write-gate.ts` `cfg.notion.databaseId`, `cfg.confluence.spaceKey` / `parentPageId`), refuse with `{ refused: "the model cannot write to the Nimbus knowledge base; use the capture flow" }` when: a Notion row's `parentPageId`, `pageId` or `parentBlockId` equals the KB database id (canonicalise Notion ids: lowercase, strip hyphens); a Confluence row's `pageId` or `parentPageId` equals the KB parent page (compare as strings), including `confluence_page_update` (a full-body overwrite of the KB root) and `confluence_comment_add`; or `confluence_page_create` targets the KB space (case-insensitive `spaceKey`) with the KB `parentPageId`. Never spell the gate-confined tool ids (D19).
- **F6: Wiring**: `ModelWriteSourceDeps` gains `getTribalKbConfig?: () => { notion?: { databaseId: string }; confluence?: { spaceKey: string; parentPageId: string } } | undefined` and the ChatOps bindings read from `enforcedPolicy()`; both wired in `gateway-main.ts` / `platform/assemble.ts` from the loaded config. The source hook is `refusal?(row: ConnectorWriteRow, input: Record<string, unknown>): string | undefined` (synchronous); the door calls it after the plain-object input check and before `ex.execute`, returning `{ refused: <text> }`; a throw counts as a refusal.
- **F7: Enable-prompt states**: each `writes` item carries `state: "already_approved" | "newly_offerable" | "not_offerable"`; `handleConnectorWritesEnable` reads the existing enablement before gating to compute it; lines render `(offered to the model)`, `(new: offered after you approve)`, `(not offered yet)`.
- **F5: The act-door preview**: as b-research.md "capture-rpc typed preview design", with two corrections: the proposer data lives ONLY under `details.proposedBy` and its summary field is named `unverifiedSummary` (it never overwrites the template's `summary`); the desktop renders it in a visually distinct "Unverified agent proposal" block below the gateway-built preview. With no preview (no template, or non-object input), keep today's `formatActionConsent` prompt and `{ actionType, input }` details exactly. The A2 tripwire in `rows.test.ts` is removed, and the positive test uses a SYNTHETIC templated proposable row passed through `buildActDeps` (no real row has a template in B0a, so a loop over real rows would assert nothing).

## Review Focus

1. A bundle slot already running for a sibling must not make an unconfigured service listable.
2. A pre-V84 enablement offers nothing until re-enabled; `status` names the awaiting writes.
3. A post to a ChatOps channel spelled differently (case, `#` prefix, channel id vs name) — decide and test the normalisation the ChatOps config uses.
4. A Confluence page create under the KB parent in the KB space ⇒ refused; elsewhere ⇒ allowed.
5. An MCP-proposed action for a templated row shows the typed preview with the proposer, and its approval still runs through the executor gate once.

---

### Task 1: Per-service listing and generation
Files: `connectors/lazy-mesh/mesh.ts`, new `connectors/lazy-mesh/service-credential.ts`, `connectors/lazy-mesh/credential-orchestration.ts` (reuse the predicates), the mesh listing test file. Tests per Review Focus 1 (including: google_drive configured and its bundle running, gmail unconfigured ⇒ gmail listing `undefined` and generation `-1`), no token refresh during the check (a vault stub whose refresh function throws if called), per-service slot isolation of generations (e.g. github vs google bundle), unmapped → `undefined`/`-1`, the 9 phase-3 services unchanged. Red-prove: list without the credential check → the sibling-bundle test fails. Commit `feat(connectors): list each wave-2 service on its own slot`.

### Task 2: The approved set (V84) and re-consent
Files: `index/connector-write-approved-v84-sql.ts` (+ `simpleStep(83, 84, …)` appended to `INDEXED_SCHEMA_STEPS` in `index/migrations/runner.ts`; `CURRENT_SCHEMA_VERSION = 84` in `index/local-index.ts`; runner tests), `connectors/connector-writes/enablement-store.ts`, `connectors/connector-writes/model-write-source.ts` (offer only approved ids), `ipc/connector-rpc-handlers/model-writes.ts`, `connectors/connector-writes/enable-prompt.ts`, `packages/cli/src/commands/connector-writes-cli.ts`, tests beside each. Tests use SYNTHETIC templated rows through the source's `rows` seam (real wave-2 rows have no template yet, so a real-row test could not fail). Red-prove: drop the approved-set filter from the listing → the not-approved test fails; drop it from `recheck` → the call-time test fails. Commit `feat(gateway): model writes are offered only as approved`.

### Task 3: The ChatOps-channel and KB refusals
Files: `engine/connector-write-agent-tools.ts` (a `refusal(row, input)` hook on the source, F3/F4), `connectors/connector-writes/model-write-source.ts` (production implementation reading the ChatOps and tribal config), tests (Review Focus 3–4, each with a positive control). Commit `feat(engine): the model door refuses ChatOps channels and the knowledge base`.

### Task 4: The act door shows the typed preview
Files: `ipc/capture-rpc.ts`, `mcp-sink/capture-act.ts` (`formatActionProvenanceLines`), `platform/assemble.ts` (wire `previewCredentialFor`), `connectors/connector-writes/rows.test.ts` (flip the tripwire to the positive test), `packages/ui/src/components/hitl/ConnectorWritePreview.tsx` (proposer banner), tests (Review Focus 5). Commit `feat(gateway): the MCP act door shows the typed write preview`.

### Task 5: Docs
The five core docs (owner rule), `docs/SECURITY-INVARIANTS.md` (I53 bounds: approved set, refusals; I28: the act-door preview; schema V84), `docs/cli-reference.md` (status line, prompt markers), `docs/CHANGELOG.md`, the schema reference, any skill that names the schema version. Gates: `audit:invariants`, `audit:doc-refs`, `audit:status-drift`, `preflight:fast`, `typecheck:tests`. Commit `docs: the Wave-2 framework`.

## PR
- Title: `feat(gateway): Wave-2 framework for model connector writes`. Not breaking (an existing opt-in offers nothing until re-enabled, and nothing was offerable before).
- Body: each change, rulings F1–F5, the owner rulings it implements, tests and red-proofs, attribution. Auto-merge; resolve every thread.
