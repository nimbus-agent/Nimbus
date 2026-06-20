# Standup / Weekly-Review Generator — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Phase 4 `v0.1.1` deferred batch (`docs/roadmap.md` line 460, `nimbus standup`) — surfaced as a daily-habit micro-product on the Near-Term Spine S1 (Local Brain) / S4 (Autonomous Agent surface). `nimbus weekly-review` is explicitly **deferred** (see Non-goals + Open questions).
**Scope:** New built-in agent + CLI command composing the **already-shipped** `catchup` involvement-detection machinery. Files touched:
- `packages/gateway/src/agents/standup.ts` (new)
- `packages/gateway/src/agents/_lib/findings.ts` (extend: `StandupBrief` type + `isStandupBrief` guard)
- `packages/gateway/src/agents/_lib/render.ts` (extend: `renderStandup`)
- `packages/gateway/src/agents/_lib/synthesize.ts` (extend: `standup` arm)
- `packages/gateway/src/agents/_lib/emit-brief.ts` (extend `AnyBrief` union)
- `packages/gateway/src/ipc/agents-rpc.ts` (new `agents.standup` handler + `requireStandupParams` + `newSessionId("standup")`)
- `packages/sdk/src/types/agents.ts` (if a new shared type is exported — see Recommendation; the SDK is the SSoT for `CatchupSection` et al.)
- `packages/cli/src/types/agents.ts` (CLI-side mirror `StandupBrief` + `isStandupBrief`)
- `packages/cli/src/commands/standup.ts` (new)
- `packages/cli/src/index.ts` (register `standup: runStandupCli`)
- `packages/gateway/test/e2e/scenarios/standup.e2e.test.ts` (new)
- `docs/CHANGELOG.md`, `docs/cli-reference.md`, `docs/roadmap.md` (mark line 460 delivered)

---

## Motivation / Goal

A thin, high-frequency micro-product: "what did I do" assembled from the local index, ready to paste into a standup or async update. Daily use drives daily Gateway engagement — the cheapest virality lever in the roadmap. The expensive part (resolve *who the user is*, then detect *what they were involved in* across ~80 connectors) is **already shipped** in `catchup` (`packages/gateway/src/agents/catchup.ts` lines 105–171). Standup is the same data, re-windowed to ~24h and re-ordered for recency, with a paste-friendly text formatter. No new connectors, no new index data, no LLM dependency for correctness.

This is the **smallest** idea in the family set: one agent file + one CLI file + one new brief type, all cloned from the catchup substrate.

## Where this fits (roadmap home + not-already-shipped evidence)

**Roadmap home.** `docs/roadmap.md` line 460 specifies `nimbus standup` verbatim: "assembles everything the authenticated user did across all connected services in the last 24 hours (configurable via `--since`)… Output is copy-pasteable Markdown. Scoped to the current user's identity as resolved by the people graph. `--format <markdown|slack|plain>` flag. Read-only, no HITL. Entirely local — nothing is posted anywhere without a separate explicit command." This sits in the v0.1.1 deferred batch ("engineering work only — uses existing people graph"). The `nimbus-agent-patterns` skill confirms standup is a deferred planning agent: *"Planning agents (`meeting-prep`, `oncall-brief`, `standup`) are deferred to a future phase per the roadmap."*

**Not already shipped — confirmed by reading source:**
- `catchup` **is** shipped: agent (`packages/gateway/src/agents/catchup.ts`), IPC handler `agents.catchup` (`packages/gateway/src/ipc/agents-rpc.ts` line 285, registered in the `dispatchByMethod` map line 385), CLI (`packages/cli/src/commands/catchup.ts`, registered `catchup: runCatchupCli` in `packages/cli/src/index.ts` line 89).
- `standup` is **not** shipped: `Glob packages/cli/src/commands/{changelog,standup}.ts` → **No files found**; no `agents.standup` key in the `agents-rpc.ts` dispatch map; no `standup` arm in `synthesize.ts` / `render.ts`; no `StandupBrief` in `findings.ts`. The sibling `nimbus changelog` (line 459) is likewise unbuilt — out of scope here.
- **Weekly-review** appears nowhere in the codebase, roadmap, or any spec — it is net-new scope and is **deferred** (Non-goals).

**What catchup returns** (the reuse substrate): `runCatchup` (line 105) resolves the self-person via `resolveSelfPerson` (`_lib/self-person.ts`), runs five parallel sub-agents through `AgentCoordinator` — `subOwnedServices`, `subActiveRepos`, `subRespondedIncidents`, `subCollaborators`, `subWindowItems` (lines 273–405) — then `scoreAndGroup` (line 234) buckets `WindowItem`s by service and orders by `relevanceScore` then `modifiedAt`. `subWindowItems` (line 364) is the per-window query and already takes `sinceMs`; it is the *only* sub-agent that varies with the window (the involvement detectors use a fixed 90-day lookback, line 271 `NINETY_DAYS_MS`).

## Approaches considered

### Approach A — `--mode=standup` flag on the existing catchup agent (no new agent/type)
Add a `mode` discriminator to `CatchupInput`; when `standup`, default `sinceMs` to 24h and sort by `modifiedAt DESC`. One handler, one brief type, zero new registration sites.
- **Pros:** absolute minimum code; no new `StandupBrief`/SDK export/CLI mirror/type-guard fan-out (the `findings.ts` + `cli/src/types/agents.ts` + `synthesize.ts` + `render.ts` + `emit-brief.ts` octopus stays untouched).
- **Cons:** No distinct `nimbus standup` verb (the roadmap names the command explicitly and daily-habit virality *needs* a memorable verb). Conflates two products in one brief `kind`; the `briefReady` notification name (`catchup.briefReady`) wouldn't match a `nimbus standup` CLI subscriber. Recency-first ordering is a behavioral fork inside catchup that risks regressing catchup's relevance-first ordering. Fails the "dedicated CLI command per agent" convention the other seven agents follow.

### Approach B — New thin `standup` agent that **calls `runCatchup` internally** and re-projects
`runStandup` invokes the exported `runCatchup({ sinceMs: 24h })`, then transforms the returned `CatchupBrief.sections` into a flat recency-ordered `StandupBrief`. New `kind: "standup"`, new `agents.standup` handler, new CLI command + notification name, but the heavy SQL/involvement logic is reused by *call*, not by copy.
- **Pros:** Distinct verb + notification + brief type (clean virality + clean CLI). Zero duplication of the five sub-agent SQL queries — it literally calls the shipped function. New `kind` keeps catchup's ordering invariant intact. Honors the per-agent-command convention.
- **Cons:** Re-sorting catchup's already-grouped/scored sections into recency order is a lossy second pass (catchup pre-buckets per service); to truly sort the whole 24h window by `modifiedAt DESC` we'd want the raw `WindowItem[]` before grouping, which `runCatchup` does not currently return. Either accept service-grouped output (fine, arguably better for standup) or export the pre-group window items (small refactor to catchup).

### Approach C — New `standup` agent that **reuses the sub-agent functions + `scoreAndGroup` directly** (composition at the function level)
`runStandup` imports the exported helpers — `scoreAndGroup`, and (newly exported) `subWindowItems`/involvement sub-agents — runs the same `AgentCoordinator` fan-out with `sinceMs = 24h`, but produces a `StandupBrief` whose sections are ordered by recency (primary) with involvement score as tie-breaker, per the grounding's scoring recommendation. New `kind`, handler, CLI, notification.
- **Pros:** Full control over standup's ordering (recency-first, the roadmap's "what did I do today" framing) without forking catchup's behavior. Reuses the exact same SQL (the sub-agent functions) and `scoreAndGroup` for the tie-break score, so no SQL duplication. Distinct verb/type/notification for virality + convention.
- **Cons:** Requires exporting `subWindowItems` (and optionally the involvement sub-agents) from `catchup.ts` — a one-line `export` each. Slightly more surface than B.

**Recommendation: Approach C.** It is the smallest design that still ships a real `nimbus standup` verb (which the roadmap mandates and which daily-habit virality requires), while reusing the load-bearing logic by *function composition* rather than copy-paste — satisfying the "reuse > rebuild" rule and the agent-patterns invariant "reuse catchup involvement-detection sub-agents; do not reimplement." Versus B, C gives standup honest recency-first ordering (the product's whole point — "what did I do *today*") instead of re-sorting catchup's service buckets after the fact. Versus A, C keeps catchup's relevance-first ordering invariant untouched and gives standup its own `kind`/notification/CLI, matching the seven-agent convention. The only extra cost over A/B is exporting `subWindowItems` from `catchup.ts` (trivial). The new `StandupBrief` type fans out to ~5 sites, all mechanical clones of the existing `Catchup*` rows — acceptable for a first-class product surface.

## Design (recommended)

### Architecture & components

**Agent — `packages/gateway/src/agents/standup.ts` (new).**
```
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;   // standup default = today
const MAX_SINCE_MS     = 90 * 24 * 60 * 60 * 1000; // same ceiling as catchup
```
`runStandup(input, ctx)` mirrors `runCatchup` exactly:
1. `detectEmptyIndex(ctx.db)` → preflight gap (reuse `_lib/gap-notes.ts`).
2. `resolveSelfPerson(ctx.db, …)` (reuse `_lib/self-person.ts`); on `unresolved`, push the identity gap (clone `unresolvedIdentityGap`, line 70 — remediation already names `[user] me_person_id`).
3. `AgentCoordinator` fan-out of the **same** five sub-agents, calling `subWindowItems`/involvement detectors **exported from `catchup.ts`** with `sinceMs = 24h`. (Latency: identical shape to catchup, well under the 15 s budget — the involvement detectors are unchanged 90-day aggregates; `subWindowItems` over a 24h window is *cheaper* than catchup's 3d.)
4. Produce `StandupSection[]` via a recency-first variant: reuse `scoreItem` (exported from `catchup.ts`) for the involvement tie-break score, but **sort primarily by `modifiedAt DESC`**, score DESC as tie-break (per grounding's "standup should prefer newer items within 24h"). Group by service like catchup, but order *items within and sections across* by most-recent activity.
5. Return `StandupBrief { kind: "standup", agentVersion: 1, generatedAt, latencyMs, gaps, query: { sinceMs }, selfPersonId, involvement, sections }`.

`emitStandupBrief(input, ctx)` calls the shared `emitBriefWithSynthesis` (`_lib/emit-brief.ts`) with `briefReadyMethod: "standup.briefReady"`, `briefErrorMethod: "standup.briefError"` — the exact fire-and-forget shape catchup uses (line 173).

**Brief type — `packages/gateway/src/agents/_lib/findings.ts` (extend).** Add `StandupBrief` (structurally a `CatchupBrief` with `kind: "standup"`; reuse `CatchupSection`/`CatchupItem` from the SDK so no new SDK item types are needed) + `isStandupBrief` guard (clone `isCatchupBrief`, line 178, checking `kind === "standup"`). Add `StandupBrief` to the `AgentBrief` union (line 132).

**Render — `_lib/render.ts` (extend).** Add `renderStandup(brief)`: header `# Standup` (or `# Standup — last 24h`), reuse `renderCatchupItem` (line 95) for the bullet shape; sections ordered by recency. The `--format` text transform lives in the **CLI** (see below), not here — `render.ts` always emits canonical Markdown that the `synthesize` LLM-refine path can polish.

**Synthesize — `_lib/synthesize.ts` (extend).** Add a `standup` arm to `deterministicRender` (line 52) → `renderStandup`, and to `toolNameFor` (line 63) → `"agents.standup"`. Add `StandupBrief` to the `SynthInput` union (line 42) and `AnyBrief` in `emit-brief.ts` (line 13).

**IPC handler — `packages/gateway/src/ipc/agents-rpc.ts` (extend).** Add `requireStandupParams` (clone `requireCatchupParams`, line 128 — same `sinceMs` non-negative-integer-≤-MAX validation; standup has **no** `service` filter in v1, keep it lean), add `"standup"` to the `newSessionId` kind union (line 175), add `handleStandup` (clone `handleCatchup`, line 285 — including the `[user] me_person_id` override read via `loadNimbusUserFromConfigDir`), and register `"agents.standup": handleStandup` in the `dispatchByMethod` map (line 382). This handler is mounted wherever `dispatchAgentsRpc` is wired (`packages/gateway/src/ipc/server/dispatchers.ts`) — no extra boot wiring beyond the map entry.

**CLI — `packages/cli/src/commands/standup.ts` (new).** Clone `catchup.ts`:
- `parseStandupArgs(args)` → `{ sinceMs (default 24h), json, format }`. Reuse `parseSinceDurationToMs` (`packages/cli/src/lib/parse-since.ts`) and the `MAX_SINCE_MS` guard. New `--format <markdown|slack|plain>` (default `markdown`).
- `awaitAgentBrief(client, "standup", isStandupBrief, …)` + `client.call("agents.standup", { sinceMs })` (reuse `agent-brief-render.ts`).
- Output: `--json` → findings JSON (reuse `renderAgentBrief`); otherwise apply the **pure text transform** for `--format`:
  - `markdown` → the brief Markdown as-is (the gateway-rendered `brief` string).
  - `slack` → Slack-flavored mrkdwn (e.g. `*bold*`, `_italic_`, `•` bullets) produced by a **pure string function** `toSlackMrkdwn(brief: string): string`. **No Slack API call and no Block Kit payload assembly** — full Slack Block Kit integration is an explicit Non-goal for v1 (see Non-goals). The transform is a pure Markdown→mrkdwn STRING rewrite.
  - `plain` → strip Markdown markers to plain text via a pure `toPlainText(brief: string): string`.
  Respect `NO_COLOR` (reuse the catchup CLI's render path).
- CLI-side mirror type `StandupBrief` + `isStandupBrief` in `packages/cli/src/types/agents.ts` (clone the `CatchupBrief` mirror, line 71 — the CLI cannot import gateway types).

**Registry — `packages/cli/src/index.ts` (extend).** Add `standup: runStandupCli` next to `catchup` (line 89).

### Data flow

```
nimbus standup [--since 24h] [--format markdown|slack|plain] [--json]
   │  CLI parses args; default sinceMs = 86_400_000
   ▼
IPCClient.call("agents.standup", { sinceMs })           (JSON-RPC over local socket)
   ▼
agents-rpc handleStandup → emitStandupBrief → runStandup
   │  resolveSelfPerson(db)  ── people graph (local SQLite)
   │  AgentCoordinator.run([5 catchup sub-agents @ sinceMs=24h])  ── local index only
   │  scoreItem (tie-break) + recency-first group → StandupSection[]
   ▼
emitBriefWithSynthesis → synthesize(brief)              (deterministic Markdown; optional local-LLM polish)
   ▼
notify("standup.briefReady", { sessionId, brief, findings })
   ▼
CLI awaitAgentBrief → apply --format pure transform → stdout   (NO network egress)
```

Every DB read is against the local SQLite index. No connector/MCP/cloud call occurs at standup time (the index was populated by prior `connector sync`).

### IPC / CLI surface

- **IPC method:** `agents.standup` — params `{ sinceMs?: number }` (non-negative integer ≤ 90 days). Returns `{ sessionId }` (fire-and-forget; brief arrives via notification).
- **Notification:** `standup.briefReady { sessionId, brief: string, findings: StandupBrief }` and `standup.briefError { sessionId, error }` — exact catchup shape.
- **CLI:** `nimbus standup [--since <dur>] [--format <markdown|slack|plain>] [--json]`. Default window 24h. `--since` accepts the standard duration grammar (`7d`, `12h`, `1w`), capped at 90d.
- **Tauri allowlist (I7):** `agents.standup` is read-only and parallels `agents.catchup`; if catchup is renderer-exposed, standup may be added to `ALLOWED_METHODS` the same way (consult `nimbus-tauri-allowlist`). It is **not** RCE-class. **Out of scope for v1** unless catchup is already allowlisted — CLI-only ships first.

### Security: the 7 Non-Negotiables + invariant/schema impact

1. **Local-first** — ✅ standup reads only the local SQLite index and people graph; the machine is the source of truth. No cloud read at standup time.
2. **HITL is structural** — ✅ standup is a **read-only** built-in agent (agent-patterns shape invariant): no write tools in scope, no `HITL_REQUIRED` action, never awaits consent. It does not import `ToolExecutor`. The e2e test asserts zero HITL fires (the structural source check). `engine/executor.ts` `gate()` is untouched.
3. **No plaintext credentials** — ✅ standup never reads Vault and emits no secrets. Output is item titles + service ids + relevance reasons (public labels, same as catchup `scoreItem` reasons, line 205). The e2e test asserts no `external_id`/token/secret-shaped string leaks into the rendered brief.
4. **MCP as connector standard** — ✅ no API calls at all; standup never touches a connector. N/A by construction.
5. **Platform equality** — ✅ pure TS over `bun:sqlite`; `--format` transforms are pure string functions; no OS-specific code. Paths via existing CLI helpers.
6. **AGPL-3.0 core / MIT sdk** — ✅ agent/CLI land in AGPL packages; the only SDK touch (if any) is reusing existing `CatchupSection`/`CatchupItem` exports — no license-field change.
7. **No `any`** — ✅ all params typed; external IPC params handled as `unknown` then narrowed by `requireStandupParams` / `isStandupBrief`, matching catchup.

**Invariant impact — NO new invariant.** Standup is a pure read-only agent like `catchup`/`expert`/`impact`; the agent-patterns shape invariant (read-only, HITL-free, notifying) is the only structural rule and it is satisfied by construction. No structural defense is required, so **no I29** (and the I28 reservation for the unmerged MCP-server owner-sink is untouched). Existing invariants:
- **I2/I3/I4** (HITL frozen set / `action.type` consult) — no impact; standup adds no HITL action type.
- **I7** (Tauri allowlist) — read-only method; CLI-only in v1, optional later parallel to catchup.
- **I11** (`wrapToolOutput`) — the `synthesize` LLM-refine path already wraps the brief via `wrapToolOutput` (synthesize.ts line 78); standup inherits it for free when an LLM is configured.
- **I13** (HTTP write surface) — standup is not on the HTTP write API; no write route.
- **I27** (outbound share-gate) — standup **emits nothing to any sink**. Output is stdout only. Posting to Slack/email/ChatOps remains exclusively via the separate HITL-gated `nimbus share create` / ChatOps (I23) commands. **Fail-closed enforcement:** `--format slack` is a *text rendering choice*, not a POST trigger — the e2e/unit test asserts `toSlackMrkdwn` makes no network call and the standup path imports no share/ChatOps module.

**Static-rule guard (cheap, recommended):** extend `scripts/structure-audit/check-nimbus-invariants.ts` to assert `agents.standup` is NOT present in any `WRITE_METHODS`/write-route allowlist and that `standup.ts` imports neither `share/` nor `chatops/` — pinning the "read-only, no auto-egress" property statically (mirrors the existing read-only-agent posture). This is a guard, not a new numbered invariant.

**Schema impact — NO migration.** Standup reuses the existing `item` / `graph_relation` / `graph_entity` tables that catchup queries and the existing `CatchupSection`/`CatchupItem` SDK shapes. **V44 is not consumed by this work** (a future scheduled `weekly-review` digest with `scheduleId`/`lastRun`/`recipients` would justify V44, but that is deferred).

**Fail-closed behavior:** unresolved identity → a `missing_user_identity` gap with the `[user] me_person_id` remediation (no crash, no guess). Empty index → `empty_index` gap → CLI prints "No data indexed yet — run `nimbus connector sync`" and exits non-zero (reuse `renderAgentBrief`, line 49). A sub-agent failure → a `missing_connector` gap, brief still renders with whatever resolved (clone `failedSubAgentGap`, line 80).

### Testing

- **E2E (primary):** `packages/gateway/test/e2e/scenarios/standup.e2e.test.ts`, using `expert.e2e.test.ts`/`catchup.e2e.test.ts` as reference (per agent-patterns). Seed an in-memory `Database` (`new Database(":memory:")` / `createMemoryIndexDb()`) with `item` rows in/out of the 24h window + a resolvable self-person. Assert: (a) brief contains the expected service sections, recency-ordered; (b) items outside 24h are excluded; (c) **zero HITL** — source does not import `ToolExecutor`/reference `HITL_REQUIRED`; (d) `standup.briefReady` emits a non-empty `brief` + valid `findings` (via `emitStandupBrief`); (e) **no secret/`external_id` leak** in the rendered brief.
- **Unit:** `parseStandupArgs` (default 24h, `--since` cap, `--format` enum, unknown-positional rejection); `toSlackMrkdwn`/`toPlainText` are **pure** and **make no network call** (assert via a fetch-spy that records zero calls); `requireStandupParams` validation arms; `isStandupBrief` guard. Identity-unresolved → graceful gap (not a throw).
- **No new test layer.** No Vault test (no Vault touch); no integration-with-real-subprocess beyond the e2e scenario.
- **Coverage:** `packages/gateway/src/agents/` ≥ 80% line; baseline coverage-floor is `{}` so every new file (`standup.ts`, CLI `standup.ts`, the new render/findings arms) must clear ≥80% line+branch per-file. Because standup is a near-clone of catchup's tested shape, branch coverage is straightforward — keep `requireStandupParams` arms and the `--format` switch fully exercised.

## Non-goals (YAGNI)

- **Weekly-review generation** — net-new scope (aggregate 7d, filter to high-impact, optional DORA roll-up). **Deferred** to a separate spec (`nimbus weekly-review`, Phase 7 Wave 5), which can reuse standup as a building block. Not in v1.
- **Scheduled/unattended standup posting** (cron → ChatOps daily) — would re-introduce HITL/egress concerns and needs a scheduler + the share/ChatOps gate. Deferred (Phase 7 Wave 5 / autonomous-agent track). v1 is a one-shot CLI command only.
- **DORA metrics in the brief** (`--include-metrics`) — roadmap does not require it for standup; adds a `metrics/dora.ts` dependency + a sub-agent. Deferred; can be an opt-in flag later.
- **`--service` filter** — catchup has it; standup's "everything I did today" framing wants the full picture. Omit in v1; add later if requested.
- **Slack Block Kit JSON / full Block Kit payload integration** — **explicit Non-goal for v1.** `--format slack` is copy-pasteable Slack **mrkdwn** produced by a pure string transform (the roadmap says "copy-pasteable Markdown"); users paste it themselves. No Slack API call and no Block Kit payload assembly here. v1 output = plain Markdown + the pure mrkdwn STRING transform only.
- **Streaming sections incrementally** — the brief is small (24h window); a single `briefReady` notification is sufficient. (Catchup's `emit*Brief` is already fire-and-forget; we inherit it.)

## Open questions

1. **Reuse `CatchupBrief` vs new `StandupBrief`?** Recommendation: new `kind: "standup"` (Approach C) for a clean verb/notification/CLI, structurally reusing `CatchupSection`/`CatchupItem` SDK shapes (no new SDK item types). Cost is ~5 mechanical clone sites. If the user prefers absolute minimum surface, fall back to Approach A (`--mode` on catchup) — but that loses the dedicated `nimbus standup` verb the roadmap names.
2. **Recency-first vs catchup's relevance-first ordering** — design assumes recency-primary, involvement-score tie-break (grounding's recommendation). Confirm this is the desired "what did I do today" ordering, or whether owned-service items should still float to the top.
3. **`--format slack` fidelity** — ✅ **Resolved.** v1 output is plain Markdown (copy-paste) plus a **pure Slack-mrkdwn STRING transform** (`*bold*`, `_italic_`, `•` bullets) — no Slack API call. Full Slack **Block Kit** payload integration is an explicit **Non-goal for v1** (see Non-goals).
4. **Tauri exposure** — ship CLI-only in v1, or add `agents.standup` to the renderer allowlist immediately if catchup is already there? (Pure read-only, safe either way.)
5. **Export footprint from `catchup.ts`** — Approach C exports `subWindowItems` (and possibly the involvement sub-agents) + reuses the already-exported `scoreItem`/`scoreAndGroup`. Confirm these become module exports vs. extracting them to a shared `_lib/involvement.ts` (cleaner, slightly larger diff). Recommendation: minimal `export` first; extract only if a third consumer appears (YAGNI).

## Acceptance criteria

1. `nimbus standup` with a populated index prints a copy-pasteable Markdown brief of the user's last-24h activity, grouped by service, recency-ordered, in < 15 s on a mid-range laptop.
2. `--since 7d` widens the window (capped 90d); `--since` over 90d errors clearly.
3. `--format markdown|slack|plain` produces the three text renderings via **pure string functions** — `markdown` is plain copy-paste Markdown, `slack` is a pure Markdown→mrkdwn STRING transform (no Slack Block Kit payload, no Slack API), `plain` strips markers; a fetch-spy proves **zero network calls** during `nimbus standup` (the no-egress guarantee).
4. `--json` emits the typed `StandupBrief`.
5. Unresolved identity → a clear `[user] me_person_id` remediation gap, not a crash; empty index → "run `nimbus connector sync`" + non-zero exit.
6. E2E test asserts: correct sections, 24h boundary respected, **zero HITL fires** (no `ToolExecutor` import), `standup.briefReady` emitted with non-empty brief + valid findings, and **no `external_id`/secret leak** in output.
7. No new invariant, no schema migration; `agents.standup` absent from any write/HTTP-write allowlist (optional static guard in `check-nimbus-invariants.ts`); standup imports no `share/`/`chatops/` module.
8. All preflight gates pass (`bun run preflight`), `packages/gateway/src/agents/` line coverage ≥ 80%, every new file clears the ≥80% line+branch coverage floor.
9. `docs/roadmap.md` line 460 marked delivered; `docs/CHANGELOG.md` + `docs/cli-reference.md` updated.
