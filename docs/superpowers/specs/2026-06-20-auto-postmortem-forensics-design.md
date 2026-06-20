# Auto-Postmortem / Incident Forensics — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Near-Term Spine **S4 Autonomous Agent** (SRE core; the post-incident synthesis half of `incident-brief`). Lands as a Phase 10 ("The Autonomous Agent") deliverable; composes with the shipped DORA MTTR layer (Phase 5 T4) and the shipped Share signing chokepoint (Phase 6 Slice 8).
**Scope:**

- New built-in agent: `packages/gateway/src/agents/postmortem.ts` (+ sub-agent helpers under `packages/gateway/src/agents/_lib/`).
- Brief type added to `packages/gateway/src/agents/_lib/findings.ts` + the `AnyBrief` union in `emit-brief.ts`.
- New IPC handler in the agents RPC surface (`packages/gateway/src/ipc/agents-rpc.ts`) — method `agents.postmortem`.
- New CLI command `packages/cli/src/commands/incident.ts` (`nimbus incident show <incident-id>`), mirroring `packages/cli/src/commands/impact.ts`.
- One V44 migration: `packages/gateway/src/index/incident-postmortem-v44-sql.ts` + a `simpleStep(43, 44, …)` row in `packages/gateway/src/index/migrations/runner.ts` + `runner-v44.test.ts`.
- **Reuses unchanged:** the I27 share chokepoint (`share/share-gate.ts`), the Vault share keypair (`share/share-keypair.ts`), the BLAKE3 canonical signing (`share/share-format.ts`), the DORA MTTR engine (`metrics/dora.ts`), the PagerDuty `incident` index rows (`connectors/pagerduty-sync.ts`), and the agent fan-out coordinator (`engine/coordinator.ts`).

---

## Motivation / Goal

When an incident resolves, the on-call engineer has to hand-assemble a timeline from PagerDuty, the deploy log, the PR/commit that shipped, the CI run, and the Slack war-room thread — then write a postmortem from memory. Nimbus already indexes all of those sources locally, and DORA already computes MTTR from the same PagerDuty `incident` rows. The goal is a single command — `nimbus incident show <incident-id>` — that:

1. Assembles a deterministic, source-cited **timeline** (alert → deploy → PR → commit → CI run → Slack thread) from the local index.
2. Drafts a **postmortem** (timeline table + root-cause section + action items + MTTR/pattern footnote), with an optional LLM narrative polish.
3. Produces a **tamper-evident, signed artifact** so the timeline can be trusted and forwarded — reusing the exact Ed25519/BLAKE3 signing the Share gate already uses.

The output is always a **local draft**. Nothing leaves the machine until the owner reviews the redacted preview and approves it through the existing I27 share gate. This is explicitly the *post-incident synthesis* half of S4 — distinct from Idea #1 (watch/detect/alert, which is the *pre*-incident loop).

---

## Where this fits (roadmap home + not-already-shipped evidence)

**Roadmap home:** `docs/roadmap.md` Phase 10 ("The Autonomous Agent") lists `nimbus incident-brief` and "Post-mortem generation" as deliverables; `docs/superpowers/specs/2026-06-17-roadmap-phase7-plus-resequence-design.md` folds these into spine **S4** ("Watch → learn → act loop, proactive SRE automation, `incident-brief`; fold in the On-Call Copilot").

**Not already shipped (verified in-tree):**

- The agents directory `packages/gateway/src/agents/` holds 8 agents (catchup, conflicts, expert, ghost, huddle, impact, janitor, preflight) — **no `postmortem.ts` and no incident-brief agent.** Confirmed by globbing `packages/gateway/src/agents/_lib/*.ts` and reading `impact.ts`.
- `packages/gateway/test/e2e/scenarios/incident-correlation-indexed.e2e.test.ts` exists but only proves PagerDuty incidents are *indexed* as `item.type='incident'` — there is **no timeline assembly, no signing, no postmortem synthesis**.
- The PagerDuty `incident` item shape is live (`connectors/pagerduty-sync.ts` `buildPagerdutyMetadata()` line 59: `status`, `opened_at_ms`, `pagerduty_service_id`, `severity`, `urgency`).
- MTTR is live (`metrics/dora.ts` `mttr()` line 352 + `selectResolvedIncidents()` line 286), reading the same `incident` rows — reusable for the impact footnote.
- The Share signing chokepoint is live (`share/share-gate.ts` `createShare()` lines 60–145: redact → `requestApproval` HITL → `ensureShareKeypair` → `buildShareFile` → `insertShareRecord` → audit), with canonical BLAKE3 signing in `share/share-format.ts` (`canonicalizeBody`/`contentHash`/`buildShareFile`) and the Vault keypair in `share/share-keypair.ts`.

So: **the inputs and the signing/HITL machinery all exist; the synthesis agent does not.** This is a net-new agent over shipped substrates — reuse > rebuild.

---

## Approaches considered

### Approach A — Pure agent, **no migration**: assemble + sign on-demand, persist nothing new

The postmortem agent reads the index, fans out sub-agents, builds the timeline + draft, and returns it as a `briefReady` notification. If the owner wants it durable/shareable, they pipe the draft through the **existing** `share.create` path (kind `transcript`) — which already signs, persists to `share_records` (V41), and audits. No V44, no new tables.

- **Pro:** Zero schema change; smallest possible surface; the signed artifact lives in the already-audited `share_records` ledger; the agent stays a pure read-only view (matches every other agent, which persist nothing).
- **Con:** The *unsigned* draft is ephemeral — re-running re-assembles from scratch. A "point-in-time" historical re-open (`--at`) re-derives rather than reads a snapshot. The signed artifact is a generic share row, not queryable as "the postmortem for incident X".

### Approach B — Dedicated `incident_postmortem_v44` table: persist the signed draft + approval trail

A V44 migration adds `incident_postmortem` (incident_id, content_json, signed_at, signer_pubkey, signature_b64, approval audit link, optional pushed_to_url). The agent writes the signed draft here; the share-gate push links back via `contentHash`.

- **Pro:** `nimbus incident show X` is idempotent + fast on re-open; the postmortem is a first-class, queryable, append-only record keyed by incident; the approval trail is co-located.
- **Con:** A second persistence path for signed content that *duplicates* what `share_records` already does; risks two sources of truth for "the signed postmortem"; more code (migration + store + tests) for a v1 nobody has asked to query yet.

### Approach C — Reuse DORA's correlation engine wholesale; postmortem is a thin formatter

Lean entirely on `metrics/dora.ts` — call `selectResolvedIncidents` + the deploy/PR correlation that `changeFailureRate` already does, and just render it as Markdown.

- **Pro:** Maximum reuse; almost no new logic.
- **Con:** DORA's correlation is *aggregate-statistical* (a time-window attribution for a ratio), not *per-incident forensic* (one incident's exact deploy→PR→commit→CI→Slack chain). The window heuristic that's fine for a CFR ratio is too coarse for a single postmortem's "which deploy caused this". Forcing the forensic view through the stats engine couples two different altitudes and would distort DORA. **Rejected** as primary; we *call* `mttr()` for a footnote only.

### Recommendation — **Approach A (no migration) for the v1 core, with Approach B reserved as a Phase 10 stretch.**

Lead reasoning: every shipped agent in `packages/gateway/src/agents/` is a **pure read-only view that persists nothing** (confirmed in `impact.ts` — it returns a brief, the IPC layer emits it, done). The signed, durable, shareable artifact already has exactly one home in this codebase: `share_records` (V41), reached through the I27 chokepoint. Adding a parallel `incident_postmortem_v44` table to store signed content would create a **second signed-content store** competing with `share_records` — precisely the kind of "parallel emit path" that invariant I27 exists to forbid. YAGNI says: don't build a query surface ("the postmortem for incident X") nobody has asked for yet. The grounding's V44 proposal is the right *eventual* shape if/when point-in-time re-open and incident-keyed querying become real requirements — so it is documented here as the named stretch, not built now.

**Net effect of the recommendation: NO V44 migration in the v1. NO new invariant.** The agent assembles + drafts (read-only); durability + signing + sharing reuse the existing `share.create` chokepoint verbatim.

---

## Design (recommended)

### Architecture & components

**1. The agent — `packages/gateway/src/agents/postmortem.ts`** (new, AGPL, mirrors `impact.ts`)

- `PostmortemInput = { incidentId: string; atMs?: number; commitRange?: { from: string; to: string } }` — `incidentId` is the PagerDuty external id (the `externalId` upserted in `pagerduty-sync.ts`); `atMs` is an optional point-in-time clamp (sub-agents ignore items modified after `atMs`); `commitRange` is an optional manual anchor that scopes `subChangeChain` to an explicit commit/PR range when automatic deploy→PR correlation fails (degrade-to-manual; never guesses causality). `atMs` and `commitRange` are the only optional knobs in v1; full historical reconstruction is a non-goal (see below).
- `runPostmortem(input, ctx): Promise<PostmortemBrief>` — three phases, copied structurally from `runImpact`:
  1. **Resolve incident.** `index.getItem`-style lookup of the `item(service='pagerduty', type='incident', externalId=incidentId)` row; read `metadata.opened_at_ms`, `status`, `pagerduty_service_id`, `severity`. If absent → emit a `GapNote` (`missing_connector`) and a gap-only brief (fail-soft, never throw — matches `detectEmptyIndex` in `impact.ts`).
  2. **Fan out 4 read-only sub-agents in parallel** via `AgentCoordinator` (the exact pattern at `impact.ts` lines 62–94 — `makeSubAgent` wrapping each in a `SubTask` whose `execute` returns `JSON.stringify(SubAgentResult)`). Each is independent; a failure in one becomes a `GapNote`, never blocks the others:
     - `subDeploys` — deployment/`ci_run` items with `modified_at <= opened_at_ms` within the configured incident window (reuse the window from `metrics/dora.ts` config `incidentWindowMinutes`).
     - `subChangeChain` — the PR(s) + commit(s) tied to that deploy (via existing item metadata links the impact agent already traverses). When `commitRange` is supplied, this sub-agent is scoped to exactly that explicit range (manual anchor) instead of inferring the shipping change from deploy links.
     - `subCiRuns` — CI runs around the deploy.
     - `subWarRoom` — Slack/Teams threads mentioning the affected service in the incident window (`index.search` over the service name, read-only).
  3. **Aggregate** into a `PostmortemBrief` with an ordered `timeline: TimelineEvent[]` (sorted by `eventTimestamp`), a `rootCauseCandidates` list (the deploy + change chain), `actionItems` (deterministic stubs derived from gaps + the change chain), and an `mttrContext` footnote computed by **calling the shipped `mttr(db, cfg, …)`** for the incident's service (informational only; never a confident prediction — see I11 note).

- `emitPostmortemBrief(input, ctx)` — uses the shared `emitBriefWithSynthesis` (`agents/_lib/emit-brief.ts`) unchanged: builds the brief, runs `synthesize` (deterministic Markdown ground truth + optional LLM narrative polish, same as every agent), emits `agents.postmortem.briefReady` / `.briefError`. **The deterministic Markdown is the ground truth; the LLM rewrite is decorative** (matches the `synthesize.ts` contract).

**2. Brief type — `packages/gateway/src/agents/_lib/findings.ts`** (extend)

```ts
export type TimelineEvent = {
  eventType: "alert" | "deploy" | "pr_merge" | "commit" | "ci_run" | "war_room";
  itemId: string;            // FK into item.id — every event is source-cited
  eventTimestamp: number;
  summary: string;
};
export type PostmortemBrief = AgentBriefBase & {
  kind: "postmortem";
  query: { incidentId: string; atMs: number | null; commitRange: { from: string; to: string } | null };
  incidentItemId: string | null;
  timeline: TimelineEvent[];
  rootCauseCandidates: TimelineEvent[];
  actionItems: string[];
  mttrContext: { medianSeconds: number | null; sample: number } | null;
};
```text

Add `PostmortemBrief` to the `AnyBrief` union in `emit-brief.ts` and to `synthesize.ts`/`render.ts` (one Markdown renderer arm). No `any` anywhere; LLM-returned narrative is typed `unknown` and validated before use.

**3. IPC — `packages/gateway/src/ipc/agents-rpc.ts`** (extend; follow `nimbus-ipc` + `nimbus-agent-patterns`)

- New method `agents.postmortem` — params `{ incidentId: string; atMs?: number; commitRange?: { from: string; to: string } }`, returns `{ sessionId }` immediately; the brief arrives via the `agents.postmortem.briefReady` notification (the fire-and-forget shape every agent uses). Method is **read-only**, so it is Tauri-allowlist-eligible alongside the other `agents.*` read methods (per `nimbus-tauri-allowlist`); it never reaches an RCE-class surface.

**4. CLI — `packages/cli/src/commands/incident.ts`** (new; mirror `commands/impact.ts`)

- `nimbus incident show <incident-id> [--at <iso8601>] [--commit-range <from>..<to>] [--json]` → calls `agents.postmortem`, waits for `briefReady`, prints the Markdown (or the JSON brief with `--json`).
- **`--commit-range <from>..<to>` (manual timeline anchor):** when automatic deploy→PR/merge-commit correlation in `subChangeChain` fails (sparse or missing deploy↔change-chain links), the user can manually anchor the timeline to an explicit commit range. The agent then scopes `subChangeChain` to exactly those commits/PRs instead of inferring the shipping change — a **degrade-to-manual** path. The override only *constrains* which change-chain items are considered; it never *fabricates* a causal link. Absent the flag and absent automatic correlation, the postmortem still degrades to a gap note (never guesses causality).
- **Sharing is a separate, explicit step** (no auto-egress): the printed draft tells the user to run `nimbus share create --session <id>` to sign + publish through the I27 gate. We do NOT add an outbound flag to `incident show` — keeping assembly (read-only) and emit (HITL-gated) cleanly separated.

### Data flow

```text
nimbus incident show INC-123
        │ JSON-RPC agents.postmortem { incidentId:"INC-123" }
        ▼
agents-rpc.ts → emitPostmortemBrief → runPostmortem
        │  (1) resolve item(pagerduty,incident,externalId=INC-123)  ← LOCAL index
        │  (2) AgentCoordinator.run([subDeploys, subChangeChain, subCiRuns, subWarRoom])  ← LOCAL index, parallel
        │  (3) aggregate → timeline + rootCause + actions + mttr(db,cfg)  ← LOCAL DORA
        ▼
PostmortemBrief → synthesize() → deterministic Markdown (+ optional local/cloud LLM polish via the existing agent LLM-routing gate)
        ▼
notify agents.postmortem.briefReady { sessionId, brief:<md>, findings:<typed> }   ← stays on the machine

[ owner reviews the draft locally ]
        ▼  optional, explicit:
nimbus share create --session <id>   → share-gate.createShare()  ← I27: redact → HITL share.publish → sign → share_records → audit
```text

Every byte of input is local. The only egress path is the *unchanged* I27 share gate, behind owner HITL.

### Security — explicit check against the 7 Non-Negotiables

1. **Local-first** ✅ — Timeline + draft are built entirely from the local SQLite index (`item`/`tool_call_log`), the local audit chain, and the local DORA engine. No connector is *called* during assembly; we read already-indexed rows. **Egress risk = the LLM polish step.** Mitigation: the agent uses the *same* LLM-routing the other agents use (`emitBriefWithSynthesis` → `synthesize` with an optional injected `SynthesizerLlm`); when `[llm].prefer_local` is set it runs through Ollama, and if no LLM is configured the deterministic Markdown is returned as-is. The signed ground truth is the deterministic draft, never the LLM rewrite. No new egress path is introduced.
2. **HITL is structural** ✅ — Assembly performs **no destructive action and no egress**, so it correctly needs no gate (read-only, like all 8 agents). The *only* way the postmortem leaves the machine is `share create`, which is the I27 chokepoint: the owner approves the exact redacted preview via the frozen-set `share.publish` action in `engine/executor.ts` `gate()`. There is no second emit path and no bypass.
3. **No plaintext credentials** ✅ — The brief is built from `item` rows (titles, URLs, statuses, service ids — credential-free) + DORA aggregates. No Vault read occurs in the agent. The share keypair seed is read only inside `ensureShareKeypair` (existing code) and never returned/logged/persisted to a column. Notion/Confluence push (if ever) goes through MCP write tools whose creds are Vault-only.
4. **MCP as connector standard** ✅ — The agent never calls a cloud API. Assembly reads the index; any future push to Notion/Confluence reuses the existing `notion`/`confluence` MCP write tools through the executor.
5. **Platform equality** ✅ — Pure SQL + Bun TypeScript; signing reuses the cross-platform Ed25519/BLAKE3 path already shipped in `share-format.ts` (works on all three OSes). No OS-specific code.
6. **AGPL-3.0 core / MIT sdk** ✅ — All new code is under `packages/gateway` and `packages/cli` (AGPL). No license fields touched. Reused signing primitives (`generateEd25519Keypair`) already live in the MIT SDK and are imported, not copied.
7. **No `any`** ✅ — `PostmortemBrief`, `TimelineEvent`, and sub-agent results are fully typed; LLM-generated narrative is typed `unknown` and validated before rendering.

**Invariant impact (reuse-only, NO new invariant):**

- **I2 / I4** (HITL frozen set; `hitlStatus` set only by the gate) — reused unchanged via the `share.publish` action when the draft is shared. Assembly itself adds no new HITL action.
- **I11** (tool-output envelope) — if a sub-agent's `index.search` result reaches the LLM during `synthesize`, it flows through the agents' existing `wrapToolOutput` wrapping (per `nimbus-tool-output-envelope`). The MTTR footnote is rendered as an informational "pattern match", never a confident LLM prediction, honoring the "no over-confident claims" posture (cf. I11/I23 anti-pattern).
- **I27 / D21** (single outbound-share chokepoint) — the signed/shareable postmortem is emitted **only** via the unchanged `share/share-gate.ts` `createShare()`. The design deliberately does **not** add a parallel signing-and-emit path; that is the whole point of choosing Approach A.
- **Schema:** **No V44 in v1** (Approach A). If the Phase 10 stretch (point-in-time re-open + incident-keyed query) is later approved, it adds `incident_postmortem_v44` via `simpleStep(43, 44, …)` in `migrations/runner.ts` (next free version is 44; head is V43 = `share_inbox`, confirmed at `runner.ts:405`). **I28 is reserved** for the unmerged MCP-server owner-sink; a future invariant here (none needed) would be I29+.

**Numbering note:** I28 is reserved for the MCP-server owner-sink (branch dev/asafgolombek/phase7-mcp-gateway-server). The I29/D22/V44-style numbers here follow the *proposed* global sequence in 2026-06-20-superpowers-specs-consolidated-review.md §1 — these family ideas are mutually exclusive, so the actual number is the next-free at this spec's own merge time, reconciled by build order.

- **Fail-closed behavior:** a missing incident, a failed sub-agent, or an absent connector yields a **gap-annotated brief**, never a partial/false timeline and never an exception (matches `impact.ts` gap handling). The share path is independently fail-closed (deny/timeout emits nothing — existing `createShare` behavior at lines 90–105).

### Testing

- **Layer 1 — unit (agent logic), ≥80% line+branch/file:** `postmortem.test.ts` — deterministic timeline ordering, gap-on-missing-incident, sub-agent-failure-becomes-gap, MTTR footnote wiring (inject a stub `mttr`). Real `bun:sqlite` in-memory index, no mocks at the DB layer (per `nimbus-testing`). The deterministic Markdown is asserted byte-stable.
- **Layer 2 — e2e CLI:** extend the scenario family next to `incident-correlation-indexed.e2e.test.ts` — seed PagerDuty incident + deploy + PR + CI + Slack rows, run a real Gateway subprocess, call `nimbus incident show <id>`, assert the timeline contains all five event types in order. No real cloud calls.
- **HITL/Share reuse test:** no *new* HITL test is needed for assembly (read-only). The share path is already covered by the I27 enforcement test in `security-invariants.test.ts`; we add one e2e assertion that `nimbus share create` over a postmortem session produces a signed `share_records` row and an `approved` audit entry — exercising the reused chokepoint end-to-end.
- **No Vault test needed** (the agent reads no secrets); the existing share-keypair Vault tests already cover the signing seed never escaping.
- Coverage-floor (`audit:coverage-floor`, Linux-authoritative) applies to every new file: `postmortem.ts`, the CLI command, and any new `_lib` helper must each clear ≥80% line+branch.

---

## Non-goals (YAGNI — cut from v1)

- **No V44 table / no `incident_postmortem` store** — durability + signing reuse `share_records` via `share create`. (Reserved as the named Phase 10 stretch.)
- **No auto-offer / standing workflow** — `nimbus incident show` is on-demand only. Proactively drafting a postmortem when PagerDuty flips an incident to `resolved` is a Phase 10 stretch (needs the watch loop from Idea #1).
- **No incident clustering/grouping** — one `incident-id` → one postmortem. Cascades are N separate runs.
- **No data-platform / lineage variant** — no warehouse-schema-delta or dbt/Dagster traversal in the timeline. (The "Data Incident Brief" variant is a later extension over the shipped Slice-7 lineage graph.)
- **No full point-in-time historical reconstruction** — `--at` only clamps the upper bound of considered items; it does not replay item versions (the index is current-state, not versioned). True `--at` historical replay is out of scope.
- **No on-call auto-tagging beyond display** — surfacing the on-call owner name/handle in the template is fine; auto-notifying or acting on their behalf is Phase 17 (On-Call Copilot), not here.
- **No Notion/Confluence auto-push** — pushing the signed postmortem to a KB is reachable today via the existing MCP write tools through `share create`/the executor; no dedicated push command in v1.

## Open questions

1. **Change-chain linkage fidelity.** ✅ **Resolved.** How reliably can `subChangeChain` map a deploy item → the PR/commit that shipped it from current index metadata? `impact.ts` already traverses some of these links; we reuse its resolver. When automatic correlation succeeds, it is used. When links are sparse and correlation fails, the user can manually anchor the timeline via the `--commit-range <from>..<to>` CLI override (degrade-to-manual), which scopes `subChangeChain` to exactly that range. Absent both automatic correlation and the manual override, the postmortem degrades to a gap note ("could not correlate the shipping PR") rather than guessing causality — acceptable for v1.
2. **War-room thread matching.** Matching Slack/Teams threads by service name within the window will have false positives/negatives. v1 uses a conservative `index.search` over the affected-service token and labels results "possibly related" — never asserts causality. Is that precision acceptable, or do we want an explicit `--war-room-thread <url>` override?
3. **MTTR footnote framing.** Confirm the footnote stays strictly informational ("similar incidents on this service resolved in a median of Xs over N samples") and never reads as a prediction for the current incident.
4. **Stretch trigger.** When (if ever) do we promote Approach B? Concretely: the first time a user asks "re-open the postmortem for INC-123" and expects the *same* signed artifact back rather than a re-derivation.

## Acceptance criteria

1. `packages/gateway/src/agents/postmortem.ts` exists; `runPostmortem` fans out ≥3 read-only sub-agents in parallel via `AgentCoordinator` and returns a typed `PostmortemBrief` with no `any`.
2. `nimbus incident show <incident-id>` prints a deterministic Markdown postmortem containing an ordered timeline (alert/deploy/pr_merge/commit/ci_run/war_room events, each source-cited by `itemId`), a root-cause-candidates section, action items, and an MTTR footnote computed from the shipped `metrics/dora.ts` `mttr()`.
3. A missing incident id, a missing connector, or a failed sub-agent yields a **gap-annotated brief** (never an exception, never a false/partial timeline). When automatic deploy→PR/commit correlation fails, `nimbus incident show --commit-range <from>..<to>` lets the user manually anchor the change chain (degrade-to-manual); absent both automatic correlation and the override, the change-chain section degrades to a gap note rather than guessing causality.
4. Assembly performs **zero egress and zero writes**; the *only* way a postmortem leaves the machine is `nimbus share create`, which routes through the unchanged I27 `createShare()` (owner-approved redacted `share.publish`, Vault-signed, `share_records` row, audit entry).
5. All 7 Non-Negotiables hold (checked above); **no new invariant** and **no V44 migration** are introduced in v1 (the V44 `incident_postmortem` table is documented only as a deferred Phase 10 stretch).
6. New files (`postmortem.ts`, the CLI command, any `_lib` helper) each clear the ≥80% line+branch coverage floor; unit tests use real `bun:sqlite`; an e2e CLI test (alongside `incident-correlation-indexed.e2e.test.ts`) proves the five-event ordered timeline; `bun run preflight:fast` is green before review.
