# Lower-Leverage Adoption Surfaces (Menu) — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Track 2 — Scale & Surface. Primary anchors: Enterprise [12] / Compliance Receipts [12.5]; secondary anchors: Marketplace Registry [9.5] (IDE plugin + recipe gallery), Desktop Distribution [13] (Tauri vehicle).
**Scope:** This is a **survey/menu spec**, not a single implementation plan. It sketches four adoption wedges at one paragraph each, ranks them, and **pulls exactly ONE forward to a shippable first-slice**: the **Compliance view** — a thin *extension* of the **already-shipped** read-only audit surface (`audit.list`/`audit.verify`/`audit.getSummary`, already Tauri-allowlisted; `nimbus audit list|verify|export`; `AuditPanel.tsx`) that adds the one missing thing: a single read fusing the audit summary with the resolved `EnforcedPolicy` ceiling and the chain-verify result. The other three stay as a ranked backlog menu. Files named below are confirmed in-tree (`packages/gateway/src/{chatops,share,audit,policy,ipc}/`, `packages/cli/src/commands/audit.ts`, `packages/ui/src/pages/settings/AuditPanel.tsx`, `packages/ui/src-tauri/src/gateway_bridge.rs`, `packages/vscode-extension/src/`) unless flagged as "to add".

---

## Motivation / Goal

Track 1 (Local Brain → Autonomous Agent) builds the moat. Track 2 needs **distribution wedges** — smaller surfaces that convert an already-built capability into an adoptable, discoverable product without rebuilding core. Four candidates already have ~80% of their substrate shipped; this spec surveys all four, then commits the one with the best (value ÷ effort × dependency-readiness) ratio so we ship a wedge instead of deep-speccing all four.

The wedges, and what is **already shipped** under each (verified in-tree):

1. **ChatOps Slack/Teams app** — the bot itself shipped (Phase 6 Slice 5, `packages/gateway/src/chatops/` — 12 modules incl. `reply-dispatcher.ts` (I23), `identity-mapper.ts`, `command-parser.ts`, `intent-router.ts`, `approval-presenter.ts`). Gap = **distribution/packaging** (an installable marketplace app manifest), not features.
2. **JetBrains plugin** — VSCode extension shipped (`packages/vscode-extension/src/`, incl. a clean DI'd `connection/connection-manager.ts` over JSON-RPC-2.0 IPC, `hitl/hitl-router.ts`, `chat/chat-controller.ts`). Gap = a **second IDE host** on the same Gateway-over-IPC contract.
3. **Hosted share/recipe gallery** — recipe origin + local execution shipped (Phase 6 Slice 8: `packages/gateway/src/share/{recipe.ts,recipe-runner.ts,recipe-yaml.ts,share-gate.ts}`, `nimbus share` CLI). Gap = **discovery/distribution** of recipes beyond peer forwarding.
4. **Compliance & audit panel** — substrate **and a basic read-only surface** already shipped: the BLAKE3 audit chain, the metadata-only shipper + policy enforcement (`packages/gateway/src/audit/{audit-shipper.ts,format-audit-payload.ts}`, `packages/gateway/src/policy/policy-gate.ts` (I22)), **plus** the `audit.list`/`audit.verify`/`audit.getSummary` IPC methods (already Tauri-allowlisted), the `nimbus audit list|verify|export` CLI, and a Tauri `AuditPanel.tsx`. Gap = **not** "build a read-only surface" (that exists) but **fuse the three shipped reads into one compliance view**: join the audit summary to the resolved `EnforcedPolicy` ceiling and a chain-verify result, so an owner/admin can answer "what did the agent do, *under what policy ceiling*, and is the chain intact?" in a single read instead of three uncorrelated ones.

---

## Where this fits (roadmap home + not-already-shipped evidence)

Per `docs/roadmap.md`: Phase 12 (Enterprise — "audit log shipping (SIEM), compliance tooling") is Planned; Phase 12.5 (Compliance Receipts — `nimbus compliance bundle`) is Planned and its line note says its prerequisites are **Phase 8 (egress ledger) + Phase 9 + the EAF Standards track, NOT Phase 6 federation**. Phase 9.5 (Marketplace Registry) is the distribution substrate. None of the four *wedges* (as adoptable surfaces) is shipped; only their substrates are.

**IMPORTANT — a large part of the compliance wedge is already shipped (verified in-tree); this slice is an *extension*, not a green-field build.** Confirmed in-tree today:

- A complete **read-only audit RPC surface**: `audit.list` (`packages/gateway/src/ipc/server/inline-handlers.ts` `rpcAuditList`, switch-wired in `ipc/server/server.ts`), and `audit.verify` / `audit.getSummary` / `audit.exportAll` / `audit.toolCalls` (`packages/gateway/src/ipc/audit-rpc.ts` `dispatchAuditRpc`). `getAuditSummary()` already returns `{ byOutcome, byService, total }` (`index/local-index.ts`).
- These methods are **already in the Tauri allowlist**: `audit.getSummary`, `audit.list`, `audit.verify` appear in `ALLOWED_METHODS` in `packages/ui/src-tauri/src/gateway_bridge.rs` (lines ~68–70, with `is_method_allowed` tests). **No new allowlist entries and no I7 count bump are needed for these.**
- A **CLI already exists**: `nimbus audit list|verify|export` (`packages/cli/src/commands/audit.ts` — `runAuditList` / `runAuditVerify` / `runAuditExport`). It is NOT zero — `audit list` and `audit verify` ship today.
- A **Tauri audit panel already exists**: `packages/ui/src/pages/settings/AuditPanel.tsx` (polls `audit.list`) and `packages/ui/src/components/dashboard/AuditFeed.tsx`.

Confirmed **not** in-tree (the genuine, narrow gaps this slice fills):

- **No policy-ceiling fusion.** The shipped `audit.getSummary` returns counts only; **nothing joins the audit summary to the resolved `EnforcedPolicy`** (retention, connector allowlist, HITL thresholds) from `policy/policy-gate.ts`, nor attaches a **chain-verify boolean** to the summary. Answering "what did the agent do, *under what policy ceiling*, and is the chain intact?" in one read currently requires three separate calls and a manual join. **This is the wedge.**
- No `compliance` CLI verb (`packages/cli/src/commands/` has `audit.ts`, `chatops.ts`, `share.ts` but no `compliance.ts`) — though `nimbus audit` already covers list/verify/export.
- No `nimbus egress` / `nimbus prove` CLI and no `gateway/src/egress` dir (S1 spine unshipped — grep of `packages/gateway/src/` and `packages/cli/src/commands/` for `egress|prove` returns nothing). **This bounds the wedge:** the surface can show the *audit chain* + *policy ceiling* (both shipped) but must not claim an *egress ledger* (unshipped) — see Non-goals.
- No JetBrains plugin package.
- No recipe registry/ingest code (`share/recipe-runner.ts` executes local YAML only).

---

## Approaches considered

**Approach A — Ship the highest-differentiation wedge (Compliance view) first, as an *extension* of the shipped audit surface.**
The read-only audit reads (`audit.list`/`audit.verify`/`audit.getSummary`), their Tauri allowlist entries, the `nimbus audit` CLI, and `AuditPanel.tsx` already ship. The only new work is one **derived read** — `audit.complianceSummary` — that fuses the existing `getAuditSummary()` counts with the resolved `EnforcedPolicy` ceiling (`policy-gate.ts`) and a chain-verify boolean (reusing `audit.verify`'s `verifyAuditChain`), plus a `nimbus audit policy` CLI verb and a small panel addition. Trade-offs: (+) Reuses the most-shipped substrate *and the shipped surface* — tiny delta; (+) directly unlocks enterprise procurement ("show me what the agent did, under what policy ceiling, and that nothing was tampered"); (+) strictly read-only and lands in the **existing `audit.*` namespace** ⇒ no new invariant, no new allowlist entry, smallest blast radius; (−) full value compounds once S1 egress ledger lands (the view should *render* egress when it exists, not block on it); (−) it's a Phase-12-adjacent surface, slightly ahead of the Phase 12 enterprise ground.

**Approach B — Ship the lowest-effort wedge (ChatOps marketplace app) first.**
Repackage the shipped bot as an installable Slack/Teams marketplace app (manifest + per-workspace bot-token routing in Vault). Trade-offs: (+) Smallest *code* delta — the bot already works; (+) viral install path. (−) Bottleneck is **external** (Slack/Teams marketplace ToS review, brand/privacy review, a public privacy policy) not engineering — slow, partner-gated, and the local-first relay question (do their ToS permit a bot that never relays data to their servers beyond the inbound webhook?) is unresolved; (−) low differentiation (it's "our bot, now easier to install").

**Approach C — Ship the network-effects wedge (recipe gallery) first.**
A discovery layer over `nimbus share --as-recipe` YAML. Trade-offs: (+) Compounding network effects on `nimbus-recipes`. (−) Forces an early architecture decision (peer-mesh vs Phase-9.5-marketplace vs hosted registry) that, if "hosted," risks Non-Negotiable #1 and likely needs a new outbound-emit invariant at the next free number (I28 is reserved for the MCP-server owner-sink, so a hosted-gallery invariant would take the next-free at its own merge time per `2026-06-20-superpowers-specs-consolidated-review.md` §1); (−) gated on Phase 9.5 marketplace plumbing not yet wired; (−) value depends on a recipe *population* that doesn't exist yet (cold-start).

**Recommendation: Approach A — pull the Compliance view forward as the first slice, scoped as an *extension* of the already-shipped audit surface.** It has the best value-per-effort *with* dependency-readiness: most of the surface (audit reads + Tauri allowlist + `nimbus audit` CLI + `AuditPanel.tsx`) is already shipped, so the delta is one derived read (`audit.complianceSummary`) that fuses audit counts × `EnforcedPolicy` × chain-verify. It is strictly **read-only**, lands in the **existing `audit.*` namespace**, and needs **no new invariant in this slice, no new Tauri allowlist entry beyond the one read-only method, and no migration**. (A future hosted recipe-gallery variant — wedge 3 — would take the next free invariant number then; I28 is reserved for the MCP-server owner-sink, family sequence in `2026-06-20-superpowers-specs-consolidated-review.md` §1.) It unlocks the highest-value adoption motion (enterprise/security buyers who must answer "what did the autonomous agent do, under what policy, and is the chain intact"). B is externally bottlenecked (marketplace review, not code) and low-differentiation; C forces a premature distribution-model decision that risks local-first and a new invariant, and suffers cold-start. The other three remain a ranked backlog (B → C → JetBrains) — see Non-goals.

---

## Design (recommended) — Compliance View (extension of the shipped audit surface)

A **read-only** view that fuses the **already-shipped** audit reads with the effective policy ceiling. The slice is deliberately tiny: it adds **one derived read** (`audit.complianceSummary`) and a CLI/panel rendering of it. The existing `audit.list`/`audit.verify`/`audit.getSummary`, their Tauri allowlist entries, the `nimbus audit list|verify|export` CLI, and `AuditPanel.tsx` are reused **as-is**. **No data leaves the machine** in this slice (a "ship to SIEM" toggle reuses the existing `audit-shipper.ts` sidecar and stays HITL-/policy-gated; it is **out of scope** here — see Non-goals).

### Architecture & components

- **Reuse (already shipped — NO change, NOT novel work):**
  - `packages/gateway/src/ipc/server/inline-handlers.ts` `rpcAuditList` (`audit.list`, switch-wired in `ipc/server/server.ts`) and `packages/gateway/src/ipc/audit-rpc.ts` `dispatchAuditRpc` (`audit.verify`, `audit.getSummary`, `audit.exportAll`, `audit.toolCalls`) — the read surface already exists.
  - `packages/gateway/src/index/local-index.ts` `getAuditSummary()` → `{ byOutcome, byService, total }` — the count aggregation is shipped; the new summary *embeds* it rather than re-deriving it.
  - `packages/gateway/src/db/audit-verify.ts` `verifyAuditChain` — the BLAKE3 verify (already behind `audit.verify`); the new summary calls it to attach `chainIntact`. **Stateful contract — the summary is a PURE READ:** it runs the chain verification **without advancing the `auditVerifiedThroughId` cursor/cache** that `audit.verify` updates on success. The summary has no side effects, so it can never drift the `audit.verify` cursor; only `audit.verify` itself advances `auditVerifiedThroughId`. (Concretely, the handler runs the verification in a cursor-free mode — e.g. `verifyAuditChain(..., { advanceCursor: false })` — never the cursor-advancing variant `audit.verify` uses.)
  - `packages/ui/src-tauri/src/gateway_bridge.rs` — `audit.getSummary`/`audit.list`/`audit.verify` are **already in `ALLOWED_METHODS`** (lines ~68–70). The one new method below is added alongside them; the existing three are untouched.
  - `packages/cli/src/commands/audit.ts` — `runAuditList`/`runAuditVerify`/`runAuditExport` already implement `nimbus audit list|verify|export`; the new `policy` verb is added here, not in a new file.
  - `packages/ui/src/pages/settings/AuditPanel.tsx` — the existing panel is extended with a policy-ceiling header; no new panel file.
  - `packages/gateway/src/policy/policy-gate.ts` — read the resolved `EnforcedPolicy` (retentionDays, connector allowlist, HITL thresholds, role assignments) to display the *ceiling under which* the agent operated. I22 unchanged (read-only consumer).
- **To add (gateway) — the ONLY new IPC surface:** `audit.complianceSummary`, added to `dispatchAuditRpc` in the **existing** `packages/gateway/src/ipc/audit-rpc.ts` (NOT a new parallel `compliance-rpc.ts`, NOT a parallel `compliance.*` namespace — that would duplicate the shipped audit reads). A thin **read-only** handler that joins `getAuditSummary()` × `EnforcedPolicy` snapshot × `verifyAuditChain()` result and returns a leak-proof summary. No writes, no new tables.
- **To add (CLI) — ships FIRST:** one verb `nimbus audit policy` in the **existing** `packages/cli/src/commands/audit.ts` (a `runAuditPolicy` calling `audit.complianceSummary`). `nimbus audit list|verify|export` already ship. The CLI compliance view is the **first deliverable** of this slice — it ships immediately on every platform and gates nothing on the desktop vehicle.
- **To add (UI) — FOLLOW-UP after the CLI:** a policy-ceiling header in the **existing** `AuditPanel.tsx` consuming `audit.complianceSummary`; no new RCE-class exposure. This is a **fast-follow** to the CLI verb (Phase 13 desktop is the broader distribution gate), not a co-requisite of the first deliverable.

### Data flow

Gateway (SQLite `audit_log` table + policy store) → `audit.complianceSummary` handler in `audit-rpc.ts` calls the shipped `getAuditSummary()` (metadata-only counts), reads the resolved `EnforcedPolicy` snapshot, and runs `verifyAuditChain()` for the `chainIntact` boolean → JSON-RPC response → CLI renders a table (`nimbus audit policy`) / `AuditPanel.tsx` renders the header. **Read path only.** No outbound network in this slice. (Per-row listing continues to use the shipped `audit.list`, which already drops payload on the panel side; this slice adds no new per-row method.)

### IPC / CLI surface

- IPC — **one** new read-only method in the existing `audit.*` namespace (added to Tauri allowlist alongside the three already-present `audit.*` reads; existing three unchanged):
  - `audit.complianceSummary` → `{ total, byOutcome, byService, chainIntact, firstBrokenId?, policy: { retentionDays, connectorAllowlistCount, hitlThresholds } }` (embeds the shipped `getAuditSummary()` shape + the policy ceiling + chain-verify).
- CLI — **one** new verb on the existing command; the rest already ship:
  - new: `nimbus audit policy [--json]` (compliance summary fused with the policy ceiling).
  - already shipped (reused, not re-implemented): `nimbus audit list [--limit N]`, `nimbus audit verify [--full]`, `nimbus audit export --output <path>`.

### Security: explicit check against the 7 Non-Negotiables + invariant/schema impact

1. **Local-first** — ✓ Read-only over local SQLite; nothing leaves the machine. The SIEM-ship toggle is explicitly out of scope and, when added, reuses `audit-shipper.ts` (already metadata-only) behind policy + HITL.
2. **HITL is structural** — ✓ This is a read surface; it does not execute actions, so it sits *below* the executor gate. It *displays* HITL outcomes (`hitlStatus`) but cannot bypass `engine/executor.ts` `gate()`. No standing approvals introduced.
3. **No plaintext credentials** — ✓ The new `audit.complianceSummary` is a *counts + policy ceiling* projection — it never emits `action_json` and never reads Vault. (Note: the shipped `audit.list` returns the raw `actionJson` field; `AuditPanel.tsx` already does not render it as a credential surface, and this slice adds no new per-row payload exposure — the new summary method carries no row bodies at all.) The view shows action *types*, counts, and the policy ceiling, never credential bodies or vault key names.
4. **MCP as connector standard** — ✓ Reads the local index/audit tables only; calls no cloud APIs.
5. **Platform equality** — ✓ Pure Gateway IPC + CLI + Tauri; identical on all three OSes.
6. **AGPL-3.0 core / MIT sdk** — ✓ New code lands in gateway + cli (AGPL); no license fields touched.
7. **No `any`** — ✓ `getAuditSummary()`'s return shape and `EnforcedPolicy` are already typed; the new `audit.complianceSummary` return type is strict; external rows typed via existing `bun:sqlite` row interfaces (`unknown` for any raw row).

- **Invariant impact:** **Reuses I22** (read `EnforcedPolicy`, never raw policy TOML), **respects I2/I4** (renders `hitlStatus` set only by the consent gate; never sets it). **No new invariant in this slice** — it is read-only and adds no defense to the I1–I27 set (the current ceiling per `docs/SECURITY-INVARIANTS.md`, whose I27 row states "count stays I1–I27"). If a *future* (out-of-scope) export path or a hosted recipe-gallery variant ever needed a new structural defense, it would take the next free number at *that* spec's merge time. **Numbering note:** I28 is reserved for the MCP-server owner-sink (branch `dev/asafgolombek/phase7-mcp-gateway-server`). Any I29/D22/V44-style numbers in family ideas follow the *proposed* global sequence in `2026-06-20-superpowers-specs-consolidated-review.md` §1 — these family ideas are mutually exclusive, so the actual number is the next-free at the spec's own merge time, reconciled by build order. This slice needs no such number.
- **Tauri allowlist / I7:** the three reused methods (`audit.getSummary`/`audit.list`/`audit.verify`) are **already in `ALLOWED_METHODS`** — no change there. The **one** new method `audit.complianceSummary` is added to the allowlist (read-only, no RCE-class surface), so the I7 count assertion increments by exactly **one**, not three.
- **Schema:** **No migration.** No new tables — the slice is a read-only projection over existing audit + policy state. (The full Phase 12.5 `nimbus compliance bundle` may later add a `compliance_export_log` at **V44**, the next free number after the in-tree V43 `share-inbox-v43-sql.ts`; **out of scope here**.)
- **Fail-closed behavior:** If chain verification fails, `audit.complianceSummary` reports `chainIntact:false` + `firstBrokenId` and **does not** synthesize a clean summary. If the policy store is unreadable, the summary fails closed (returns an error, not a permissive default). No path lets the summary emit `action_json`.

### Testing (coverage-floor ≥80% line+branch per file)

- **Integration (real SQLite + fresh temp dir):** seed audit rows + a signed policy → assert the **new** `audit.complianceSummary` returns the correct HITL counts (embedding `getAuditSummary()`'s `{ byOutcome, byService, total }`), the `EnforcedPolicy` ceiling, and `chainIntact:true`; assert the summary response contains **no** `action_json` field (the no-leak test for the new method). The shipped `audit.list`/`audit.verify`/`audit.getSummary` already have tests (`packages/cli/src/commands/audit.test.ts`, `inline-handlers.test.ts`, `audit-rpc` callers) — this slice does not re-test them, only the new fusion method.
- **Chain-tamper test:** corrupt one row's hash → assert `audit.complianceSummary` returns `chainIntact:false` + `firstBrokenId` and fails closed (no clean summary synthesized).
- **E2E-CLI:** real Gateway subprocess → the new `nimbus audit policy --json` returns a stable shape including the policy ceiling + `chainIntact`. (`nimbus audit verify` already has e2e coverage and is reused unchanged.)
- **Tauri allowlist test:** the **one** new `audit.complianceSummary` method is read-only and added to `ALLOWED_METHODS`; assert no RCE-class method is reachable. The I7 count assertion in `gateway_bridge.rs` increments by exactly **one** (the three existing `audit.*` reads are already counted).

---

## Backlog menu (the three deferred wedges — ranked)

Pull-forward order after the Compliance panel: **2) ChatOps marketplace app → 3) Recipe gallery → 4) JetBrains plugin.** One-paragraph sketch each:

**2. ChatOps marketplace app (effort: S) — roadmap home Enterprise [12] distribution.** Reuse: the entire shipped `packages/gateway/src/chatops/` subsystem + the Slack/Teams MCP connectors + Vault bot-token storage. Work = a pre-packaged Slack/Teams **app manifest** so users install from their workspace app store instead of hand-wiring a bot, plus per-workspace bot-token routing in Vault. Key invariant: **I23** (reply destination is server-derived — the marketplace app must not let install flows introduce caller-supplied channel IDs) + **I3** (bot tokens stay Vault-only). *Why deferred despite low code effort:* the bottleneck is **external** (Slack/Teams marketplace ToS + privacy review + the unresolved local-first relay question), not engineering — so it can't be reliably scheduled.

**3. Recipe gallery (effort: M) — roadmap home Marketplace Registry [9.5] + Share/Virality [Phase 6 Slice 8].** Reuse: `share/recipe-yaml.ts` (schema), `share/recipe-runner.ts` (local execution), `share-gate.ts` (I27 outbound chokepoint), `attribution.ts` (signed provenance). Work = a discovery/index layer + a `nimbus recipe publish` flow. Key invariant: **I27** (any publish is an outbound share — HITL-approved, signed) **plus a likely new invariant at the next free number** *only if* the gallery becomes a centralized hosted registry (I28 is reserved for the MCP-server owner-sink; a hosted-gallery invariant would take the next-free at its own merge time per `2026-06-20-superpowers-specs-consolidated-review.md` §1) rather than peer-mesh/Phase-9.5 distribution. *Why deferred:* forces a premature distribution-model decision (peer-mesh vs marketplace vs hosted), is gated on Phase 9.5 wiring, and has a cold-start (no recipe population yet).

**4. JetBrains plugin (effort: L) — roadmap home Marketplace Registry [9.5] / Desktop Distribution [13].** Reuse: the VSCode extension is the proven template — its `connection/connection-manager.ts` is a clean DI'd JSON-RPC-2.0-over-socket client, and `hitl/hitl-router.ts` + `chat/chat-controller.ts` are host-agnostic in shape. Work = a second IDE host (`packages/jetbrains-plugin/`, JetBrains plugin SDK `plugin.xml` + LightServices) speaking the same IPC contract; the Gateway needs **zero** changes (clients are IPC-only). Key invariant: none new — HITL still renders via the Gateway; the plugin must not cache auth tokens outside the platform keychain (**Non-Negotiable #3**). *Why deferred:* highest effort (a whole new IDE SDK + per-IDE compatibility matrix), and IDE reach is already partly covered by the shipped VSCode extension.

---

## Non-goals (YAGNI)

- **No deep-spec of wedges 2–4** — they are a ranked backlog menu, not designed here.
- **No SIEM/audit-log *shipping* in the first slice** — the view is read-only-on-machine; the outbound ship path (reusing `audit-shipper.ts`) is a separate, policy-+-HITL-gated Phase 12 item.
- **No parallel `compliance.*` IPC namespace or `compliance-rpc.ts` file** — that would duplicate the already-shipped `audit.list`/`audit.verify`/`audit.getSummary`. The slice adds exactly one method (`audit.complianceSummary`) to the existing `audit-rpc.ts`, and one CLI verb (`nimbus audit policy`) to the existing `audit.ts`.
- **No egress ledger** — `nimbus egress`/`prove` is the S1 spine and is **unshipped**; the view renders the *audit chain* + *policy ceiling* only and must not claim "everything that left the machine" until the egress ledger exists (then the view renders it additively).
- **No `compliance_export_log` / V44 migration** in this slice — read-only, zero new tables. V44 belongs to the later Phase 12.5 bundle.
- **No payload detail view** in v1 (avoids the known `redactAuditPayload` gh-token escape bug) — metadata projection only.
- **No new HTTP write routes** — read-only IPC; I13 surface untouched.

## Open questions

1. **Surface home — RESOLVED:** Both surfaces already exist (the `AuditPanel.tsx` Tauri panel and the `nimbus audit` CLI). **Decision: CLI-first.** The `nimbus audit policy` verb is the **first deliverable** (ships immediately on every platform); the `AuditPanel.tsx` policy-ceiling header is a **fast-follow** gated behind the Phase 13 desktop vehicle, not a co-requisite. Reflected in the Design section ("To add (CLI) — ships FIRST" / "To add (UI) — FOLLOW-UP") and the Acceptance criteria.
2. **Policy snapshot granularity:** show the *single current* `EnforcedPolicy` ceiling, or the policy **version in effect at each action's timestamp** (needs a policy-version history join)? v1 = current ceiling only (simpler, no history table).
3. **Federation scope:** include audit lines from leased/federated namespaces, or local only? v1 = **local only** (avoids any cross-namespace privacy contract; Non-Negotiable #1).
4. **Confirm the `format-audit-payload.ts` redaction bug status** before any future detail view uses it.

## Acceptance criteria

- [ ] The **new** `audit.complianceSummary` IPC returns `{ total, byOutcome, byService, chainIntact, firstBrokenId?, policy: {…} }` with **no** `action_json` field; an automated test asserts the summary never carries a row payload (the no-leak guarantee). The shipped `audit.list`/`audit.verify`/`audit.getSummary` are reused unchanged and already tested — they are NOT re-implemented or re-tested by this slice.
- [ ] Tampering with one audit row makes `audit.complianceSummary` report `chainIntact:false` + `firstBrokenId` and fails closed (no clean summary synthesized).
- [ ] The displayed policy ceiling matches `policy-gate.ts`'s `EnforcedPolicy` (retentionDays, connector-allowlist count, HITL thresholds); I22 enforcement reads `EnforcedPolicy`, never raw TOML.
- [ ] The **one** new method `audit.complianceSummary` is read-only and added to the Tauri `ALLOWED_METHODS` **alongside the already-present** `audit.getSummary`/`audit.list`/`audit.verify`; the I7 count assertion in `gateway_bridge.rs` increments by exactly one; no RCE-class surface is newly reachable.
- [ ] New `nimbus audit policy` CLI verb lands in the existing `packages/cli/src/commands/audit.ts` and is the **first deliverable** (ships ahead of any UI change); `nimbus audit list|verify|export` continue to work unchanged. The `AuditPanel.tsx` policy-ceiling header is a **fast-follow**, not required for the first slice to land.
- [ ] No new invariant in this slice (the set stays I1–I27; I28 is reserved for the MCP-server owner-sink, so any family-idea invariant takes the next-free at its own merge time per `2026-06-20-superpowers-specs-consolidated-review.md` §1); no migration. All 7 Non-Negotiables verified in the PR description against the wiring sites named above.
- [ ] Any new/changed file clears the ≥80% line+branch coverage floor; `bun run preflight` (full CI parity) is green before first push.
- [ ] The backlog menu (ChatOps app → recipe gallery → JetBrains plugin) is recorded with its ranking + key invariant per wedge for the next planning cycle.
