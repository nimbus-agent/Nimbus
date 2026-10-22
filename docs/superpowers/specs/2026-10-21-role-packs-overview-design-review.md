# Review: Role Packs — Programme Overview (`2026-10-21-role-packs-overview-design.md`)

**Reviewed:** 2026-10-22 · **Target spec:** [`2026-10-21-role-packs-overview-design.md`](./2026-10-21-role-packs-overview-design.md)

Overall, the architecture and security posture of the spec are very strong: keeping packs strictly declarative, forbidding free-form prompt text, enforcing an explicit allowlist of pack-settable config keys under org policy (I22), and aligning Project 1 with Phase 16 W1's layered config and Project 2 with connector unbundling are all the right calls.

However, cross-checking the overview against the live Gateway, CLI, and Tauri codebase surfaces **three concrete blockers in the § 6 Programme Proof**, plus several architectural gaps and open questions across Projects 1–5 that should be resolved before locking the overview and branching into the five project specs.

---

## 1. Critical Blockers in the Programme Proof (§ 6)

As written, Steps 2–4 of § 6 will fail against the current codebase even if Projects 1–5 are implemented verbatim:

### 1.1 `google_drive:file` does not index document bodies, so `decisions` will extract nothing (§ 6 Step 3, § 8)
- **What the spec assumes:** Mapping `google_drive:file` as a decision source in the PM pack causes the decision extraction pass to pick up decisions from Google Drive documents after first sync.
- **What the code actually does:**
  1. [`google-drive-sync.ts`](../../../packages/gateway/src/connectors/google-drive-sync.ts#L164-L185) (`upsertDriveFile`) only calls `/drive/v3/files` (file metadata), sets `title: name` and `bodyPreview` (from `f.description ?? name`), and **never populates `item.body`** (nor exports Google Docs content via Drive's `files.export` API). Every `google_drive:file` row in SQLite has `body = NULL` and `body_complete = 0`.
  2. [`decision-extract.ts`](../../../packages/gateway/src/decisions/decision-extract.ts#L118-L132) (`scanDelta` / `scanText`) reads `SELECT i.id, i.service, i.type, i.title, i.body, i.body_complete ...` and scans `${r.title}. ${r.body ?? ""}` — it ignores `body_preview` entirely.
- **Consequence:** Unless a Google Drive file has a decision cue phrase literally inside its **filename** (e.g. `We decided to drop XML.docx`), `mineCues` will find **zero** decisions from `google_drive:file`. Worse, because `body_complete = 0` on every `google_drive:file` row, mapping `google_drive:file` will cause `loadDecisionCandidates` ([`decision-extract.ts`](../../../packages/gateway/src/decisions/decision-extract.ts#L152-L166)) to flag every synced Drive file as a truncated source in `## Gaps`.
- **Minor inconsistency in § 6 Step 2 vs. Step 3:** Step 2 says the PM pack suggests `(Slack, Jira, Notion)` — it does not list `Google Drive`, even though Step 3's proof depends on `google_drive:file` having synced.
- **Suggestion:**
  - Either add Google Docs text export (`application/vnd.google-apps.document` → `text/plain` full-body indexing) to `google-drive-sync.ts` as a prerequisite/part of Project 2 (and include `google_drive` in the PM pack's suggested connectors in § 6 Step 2), **or**
  - Choose a connector for the § 6 proof that already writes `item.body` today but is not in `DECISION_SOURCE_TYPES` (or explicitly scope `google-drive-sync` full-body export into Project 2).

### 1.2 `agents.conflicts` is a federated LAN code-collision detector, not a PM contradiction brief (§ 1, § 6 Steps 2–3)
- **What the spec assumes:** § 1 mentions *"decision/contradiction reasoning"*, and § 6 Steps 2–3 say the PM pack *"turns on (decisions, conflicts, why, a nightly decisions digest)"* and *"After first sync, the sidebar leads with Decisions and Conflicts; a brief page renders them properly."*
- **What the code actually does:** [`agents/conflicts.ts`](../../../packages/gateway/src/agents/conflicts.ts#L13-L86) (`runConflicts`) is **not** a document/decision contradiction detector. It takes `{ file: string, namespaces: string[] }`, resolves `file` against code/file entities, and fans out over LAN federation peers (`fanOutQuery`) to check for `pr`, `issue`, or `commit` collisions on that file.
  - Calling `agents.conflicts` without `{ file, namespaces }` throws `-32602` in [`ipc/agents-rpc.ts`](../../../packages/gateway/src/ipc/agents-rpc.ts).
  - On a single-player fresh install (or for a PM without a file path and federated LAN peers), it cannot produce findings.
- **Suggestion:** Replace `conflicts` in the PM pack and § 6 proof with a brief that actually operates on PM substrates out of the box — e.g. **`glossary`**, **`catchup`**, **`huddle`**, or **`expert`**.

### 1.3 Desktop allowlist (`ALLOWED_METHODS`) is missing 3 of the 17 built-in briefs, and most briefs require input parameters (§ 5 Project 4)
- **What the spec states:** *"15 `agents.*` methods are already on the desktop allowlist and nothing calls them... Scope: ... a generic brief page over the already-allowlisted `agents.*` methods... Done when: ... any built-in brief renders as formatted markdown."*
- **What the code actually has:**
  1. **Missing methods on `ALLOWED_METHODS`:** Nimbus has **17** built-in brief agents (plus synchronous `agents.whyPeek`). [`gateway_bridge.rs`](../../../packages/ui/src-tauri/src/gateway_bridge.rs#L59-L73) allowlists 14 brief methods + `agents.whyPeek` (15 total), and is **missing `agents.oncall`, `agents.standup`, and `agents.changelog`**. Those three are core to the **DevOps** and developer packs (`oncall.pushedList`/`pushedGet` only read pushed P1 alerts, not interactive `agents.oncall`).
  2. **Required parameters:** Only 9 of the 17 brief methods can be invoked with `{}` (`decisions`, `glossary`, `catchup`, `standup`, `oncall`, `changelog`, `janitor`, `ownership`, `premortem` — and `standup`/`oncall` refuse with `ERR_*_IDENTITY_UNRESOLVED` or `ERR_ONCALL_NO_ACTIVE_INCIDENT` when preconditions aren't met). The other 8 **require** parameters in [`ipc/agents-rpc.ts`](../../../packages/gateway/src/ipc/agents-rpc.ts):
     - `why`: `{ ref } | { prUrl } | { itemUrl }`
     - `expert`: `{ topicOrFile } | { itemUrl }`
     - `impact`: `{ fileOrPrUrl, depth?, service? }`
     - `ghost`: `{ file, namespaces? }`
     - `conflicts`: `{ file, namespaces }`
     - `huddle`: `{ topic }`
     - `preflight`: `{ service }`
     - `negotiate`: `{ personId } | { service }`
  3. **Side-effecting briefs:** `agents.preflight` triggers HITL consent prompts (I24) and `agents.premortem` mutates SQLite (`watcher` rows and proposal tombstones, see [`ipc/agents-rpc.ts`](../../../packages/gateway/src/ipc/agents-rpc.ts#L1451-L1454)). A generic brief page must not auto-run side-effecting briefs merely because the user clicked a sidebar item.
- **Suggestion:**
  - Note in Project 4 that `agents.oncall`, `agents.standup`, and `agents.changelog` need to be added to `ALLOWED_METHODS` in `gateway_bridge.rs` (they are read-only brief methods, so § 4's rule that I7 never gains code-install/run methods holds).
  - Clarify in Project 4 that the generic brief page needs parameter input forms (driven by catalog/parameter metadata from Project 1, e.g. `AGENT_PARAM_KINDS`) for parameterized briefs, and a "Run" trigger rather than auto-running on mount for side-effecting briefs.

---

## 2. Project 2 (Source Mapping) — Architectural & Removal Guarantees

### 2.1 Hardcoded `service:type` and `service` checks inside `decisions` beyond `DECISION_SOURCE_TYPES`
Project 2 states: *"Done when: the decisions and glossary passes pick up an `ext_*` item type purely through a mapping entry, with no agent code change"*.
Inside `packages/gateway/src/decisions/`, three other places hardcode `service:type` or `service` and will misbehave unless they also read from the item-kind mapping table:
1. **Authority scoring ([`decision-confidence.ts:15-25`](../../../packages/gateway/src/decisions/decision-confidence.ts#L15-L25)):**
   ```ts
   export function sourceAuthority(serviceType: string): number {
     if (
       serviceType === "notion:page" ||
       serviceType === "confluence:page" ||
       serviceType === "obsidian:obsidian_note"
     ) {
       return 1;
     }
     if (serviceType.endsWith(":issue")) return 0.6;
     return 0.3;
   }
   ```
   If `google_drive:file` (or `ext_notion:page`) is mapped as a `doc` / decision source, `sourceAuthority` today falls through to `0.3` (chat-level authority) instead of `1.0` (long-form doc authority), lowering both its extraction priority (`computePriority`) and its final confidence score (`computeConfidence`). `sourceAuthority` should be keyed on the mapped **item kind** (`doc` → `1.0`, `ticket` → `0.6`, `message` → `0.3`).
2. **ADR corroboration ([`decision-corroborate.ts:186`](../../../packages/gateway/src/decisions/decision-corroborate.ts#L186)):**
   Hardcodes `WHERE (service || ':' || type) IN ('notion:page','confluence:page','obsidian:obsidian_note')`.
3. **Service-scope ticket matching ([`decision-service-scope.ts:111`](../../../packages/gateway/src/decisions/decision-service-scope.ts#L111)):**
   Hardcodes `if (row.service !== "jira" && row.service !== "linear") return false;`, which will reject an unbundled `ext_jira` or `ext_linear` connector.

### 2.2 Watermark cursor problem when installing a pack on an already-synced index
- Both `decision-extract.ts` (`decision_pass_state`) and `glossary-extract.ts` (`glossary_pass_state`) use a **single monotonic cursor** `(watermark_ms, watermark_id)` over `item.modified_at`.
- If a user syncs connectors first and installs a pack later (or installs the DevOps pack later alongside the PM pack, § 6 Step 5), `watermark_ms` has already advanced past existing items of the newly mapped `service:type`.
- Without intervention, `scanDelta` will **never scan existing items** of the newly mapped `service:type`. And running `rebuildDecisions` / `clearGlossary` is too destructive because it wipes durable LLM vetoes and re-runs every LLM call from scratch.
- **Suggestion:** Either track discovery watermarks per `service:type` (or per mapping entry) or run a targeted backfill scan for newly added `service:type`s when the active source-mapping set expands.

### 2.3 What "Removing the pack returns Nimbus exactly to its prior state" (§ 3 Goal 3, § 6 Step 4, § 9) means for `decision_record` and `glossary_term`
- `decision_record` and `glossary_term` are durable SQLite tables populated during background extraction passes.
- On the **read path**, `listDecisions` ([`decision-store.ts`](../../../packages/gateway/src/decisions/decision-store.ts), called by [`agents/decisions.ts:213`](../../../packages/gateway/src/agents/decisions.ts#L213)) selects from `decision_record` **without** filtering by `decisionSourceFilter()`.
- Meanwhile, `loadDecisionCandidates` ([`agents/decisions.ts:220`](../../../packages/gateway/src/agents/decisions.ts#L220)) **does** filter by `decisionSourceFilter()`, and `staleScoreCount` ([`agents/decisions.ts:264`](../../../packages/gateway/src/agents/decisions.ts#L264)) recomputes `computeConfidence` live and warns if `Math.abs(fresh - r.confidence) > 0.005`!
- **Consequences if pack removal only removes the config/mapping layer:**
  1. `nimbus decisions` continues returning decisions extracted from `google_drive:file` after the PM pack is removed — breaking the reversibility claim in § 6 Step 4.
  2. `entries` can contain decisions from `google_drive:file` while `totalSources` (`loadDecisionCandidates`) excludes `google_drive:file`, making the brief's stats/gap counts inconsistent.
  3. If a pack changes the mapped kind (and thus `sourceAuthority`) of a `service:type`, `staleScoreCount` will falsely emit the legacy `"scored on the previous scale, which capped at 0.86"` gap note!
- **Suggestion:**
  - Filter the read path (`listDecisions`, `countByStatus`, and glossary reads) by joining `item` and checking the currently active source mapping (while keeping the extracted rows in `decision_record` so re-enabling the pack doesn't re-spend LLM calls).
  - Fix `staleScoreCount` in `agents/decisions.ts` (or recompute confidence on mapping change) so authority changes from source mapping are not misdiagnosed as pre-F25 `0.86`-scale rows.

### 2.4 Scope alignment between "serves the unbundling programme" and "Done when" in Project 2
- Project 2's **Scope** says: *"agents find their inputs by **item kind** (decision source, ticket, doc, message, incident…) resolved from a mapping table... it serves the unbundling programme too."*
- Project 2's **Done when** only requires: *"the decisions and glossary passes pick up an `ext_*` item type purely through a mapping entry"*.
- Other agents and subsystems still hardcode `service` or bare `type` (e.g. `standup-queries.ts:249` `AND i.service = 'slack'`, `oncall-queries.ts` / `dora.ts` PagerDuty checks, `graph-populator.ts`).
- **Question:** Is Project 2 migrating *all* agent queries (`standup`, `oncall`, `changelog`, `dora`, `graph-populator`) to item kinds, or only `decisions` and `glossary` first? Whichever is intended, align Project 2's "Scope" and "Done when" so scope expectations don't diverge.

### 2.5 Trust boundary of extension-contributed source mappings
- Project 2 states: *"packs **and extensions** can add entries."*
- As noted in [`glossary-source-types.ts:43-51`](../../../packages/gateway/src/glossary/glossary-source-types.ts#L43-L51), admitting a new service into glossary/decision mining:
  1. Feeds its item text into the LLM extraction queue (and later into synthesized briefs that can reach remote models when `[agents] synthesis = "allow-remote"`), and
  2. Multiplies glossary term scores geometrically via `service_spread` (`1.6 ** (spread - 1)` in [`term-scoring.ts`](../../../packages/gateway/src/glossary/term-scoring.ts#L27-L36)).
- **Question / Suggestion:** If an extension (`ext_*`) can declare source mappings in `extension.json`, must those mappings be part of the signed `packages/registry-format` manifest and explicitly shown + approved in the `extension.run` (`nimbus extension approve`, I43) grant? Or should source mappings in this programme come **only** from role packs and the first-party connector migration engine (D34), leaving extension-authored mappings to the registry trust work?

---

## 3. Project 1 & Project 3 — Layered Config, Runtime Reloading & Fleet Merging

### 3.1 Boot-time config capture in `platform/assemble.ts` vs. runtime pack install/remove
- Today, [`platform/assemble.ts`](../../../packages/gateway/src/platform/assemble.ts#L791-L860) reads `[decisions]`, `[premortem]`, `[ownership]`, `[fleet]` / `[[fleet.job]]`, and `[oncall.push]` **once at gateway startup**, and only constructs `decisionsRefresher`, `FleetScheduler`, etc. if `enabled` was `true` at boot.
- However, the spec requires pack install, removal, and switching (via CLI or Desktop IPC) to take effect immediately without a gateway restart (§ 5 Project 3, Project 4, § 6 Steps 2–4).
- **Suggestion:** Specify in Project 1 / Project 3 how runtime pack changes propagate to long-lived gateway services: either `FleetScheduler` and the pass refreshers are always constructed and read the layered config live on each tick/trigger, or pack install/remove invokes a config-reload hook on those subsystems.

### 3.2 Merging `[[fleet.job]]` across packs and `nimbus.toml`
- § 2 lists **Scheduled briefs** (`[[fleet.job]]`-shaped jobs) as a first-class part of a pack.
- Three concrete details in [`config/fleet-toml.ts`](../../../packages/gateway/src/config/fleet-toml.ts) affect this:
  1. `[[fleet.job]]` is inert unless `[fleet] enabled = true` (`DEFAULT_FLEET_CONFIG.enabled` is `false`). Does a pack with scheduled briefs also set `[fleet] enabled = true` in its config defaults, and does removing the pack turn `[fleet] enabled` back off if the user never set it?
  2. `parseNimbusTomlFleetJobs` ([`fleet-toml.ts:285`](../../../packages/gateway/src/config/fleet-toml.ts#L285)) throws `FleetConfigError("[[fleet.job]] duplicate name: ...")` if two jobs share a `name`. When two packs are active, or when a user overrides a pack's job in `nimbus.toml`, how do `[[fleet.job]]` arrays merge? Keying merge/override by `name` (higher layer replaces lower layer's job of the same `name`) and adding an optional `enabled = false` field on `[[fleet.job]]` (not supported today) would let users tune or silence a single pack-supplied job from `nimbus.toml` without removing the pack.

### 3.3 Explicit additions to the pack-settable config allowlist exclusions (§ 4)
- § 4's rule (*"The allowlist is an allowlist, not a denylist"*) and its exclusion examples are great. To prevent accidental inclusion during Project 1, consider explicitly naming these additional security/egress/identity-sensitive keys as **excluded** from the pack allowlist:
  - `[oncall.push] chatops_namespace` — causes unattended outbound posts to Slack/Teams (`chatops` egress class, I23/I29).
  - `[tribal.notion]` / `[tribal.confluence]` — pins outbound KB write destinations (I25).
  - `[user] mePersonId` — alters owner identity resolution for `standup`, `oncall`, and `catchup`.
  - `[[filesystem.roots]]` — alters local filesystem indexing scope.
  - `[llm] local_base_url` / `[multimodal] vlm_base_url` — alters local model endpoint resolution (I34).

### 3.4 Active packs vs. Profiles (`ProfileManager`)
- Project 1 defines the layer order as `code defaults → pack layer(s) → team baseline → user file (active profile)`.
- **Open question:** Is the set of active packs stored **globally** for the `<configDir>` or **per-profile**? If a user has a `work-pm` profile and a `personal-dev` profile, per-profile active pack sets (or a global default with per-profile override) may be much more natural for the "one person holding more than one pack" use case in § 1.

---

## 4. Security Invariants, Desktop IPC & Onboarding (Projects 3, 4, 5)

### 4.1 Reconciling the two statements in § 4 about pack install approval on Desktop vs. CLI
In § 4, bullet 2 says:
> *"Pack install reuses the extension install/run approval path (`extension.install`, `extension.run`, both in the I2 frozen set, never delegable per I20, LAN-forbidden)."*

And bullet 4 says:
> *"The desktop allowlist (I7) never gains a method that can install or run code. A pack with member extensions installs from the CLI only, exactly as an extension does today. The desktop may install and remove **data-only** packs (no member extensions) — it is the one pack mutation it gets, and its approval goes through the existing HITL popup."*

- **Why this needs clarification:**
  1. `extension.install` is **not** on the Tauri `ALLOWED_METHODS` list (by I7), so the desktop cannot call `extension.install`. It will need a dedicated IPC method (e.g. `pack.install` / `pack.remove`, plus `pack.list`) on `ALLOWED_METHODS` where the gateway handler **structurally refuses** any pack with `memberExtensions.length > 0` (at least when `caller.kind === "ui"`, or in general while all first-party packs are data-only).
  2. When `pack.install` prompts via the HITL gate, does it use a new `pack.install` action type in the I2 frozen set (added to I20's non-delegable set and wired to `NULL_EGRESS_SINK` in I29), or does it reuse `extension.install` as its `action.type`? Using a dedicated `pack.install` HITL action type is cleaner and avoids telling a desktop user in the HITL popup (`c42034fc`) that they are approving `extension.install` when no extension is being installed.
  3. **Pack removal should not require HITL:** Bullet 4 can be read as saying both install *and* remove go through the HITL popup. In Nimbus, withdrawing a grant or removing an extension (`extension.remove`, `extension.disable`, `media.revoke`, `toolgen.revoke`) never requires HITL consent because removal only tightens/restores state. Clarify that `pack.install` is HITL-gated while `pack.remove` is immediate.

### 4.2 Demo gateway isolation (I41) and `nimbus demo` vs. `nimbus wow` (Project 5)
- **I41 (`demo-gate.ts`):** `dispatchMethod` refuses state-mutating methods on a demo-rooted gateway with `ERR_DEMO_FORBIDDEN`. Project 3 should state whether `pack.install` / `pack.remove` are refused in `--demo` mode (matching `extension.*` and `registry.*`).
- **`nimbus demo` vs. `nimbus wow`:** Project 5 says *"the `wow` tour follow the active packs"*. Note that `nimbus demo` shares `runTour` with `nimbus wow` and asserts a fixed 4-step tour in the release smoke test (`GEMINI.md` / `tour.plan`). Make sure `nimbus demo` stays pinned to its fixed demo steps even when `nimbus wow` becomes pack-driven.

### 4.3 `nimbus init` git-repository requirement for non-developer roles (Project 5)
- Project 5 notes under "What exists today": *"`nimbus init` requires a git repo and offers four local-login adoptions"*.
- However, Project 5's "Scope" only adds the *"what do you do?"* question, pack offer, connector suggestions, and `wow` tour changes — it does not mention removing or relaxing the git-repo precondition in `nimbus init`.
- A PM running `nimbus init` will typically not be inside a git repository (and the 4 local-login adoptions — `gh`, `glab`, `gcloud`, `aws` — are developer/DevOps CLIs).
- **Suggestion:** Add to Project 5's scope that `nimbus init` works outside a git repository (skipping git-root/blame setup and developer CLI adoptions when not applicable or when a non-code role pack is selected).

---

## 5. Summary of Open Questions for the Owner

1. **Google Drive proof substrate (§ 6 Step 3):** Should Project 2 add Google Docs text export (`files.export` → `item.body`) to `google-drive-sync.ts` so `google_drive:file` actually contains text for `decisions` to mine, or should the § 6 proof use a different connector/item type?
2. **Second sidebar brief in the PM pack (§ 6 Steps 2–3):** Since `agents.conflicts` is a LAN peer file-collision detector requiring `{ file, namespaces }`, should the PM pack lead with **Decisions and Glossary** (or **Decisions and Catchup**) instead of **Decisions and Conflicts**?
3. **Pack removal semantics for mined rows (§ 3 Goal 3, § 6 Step 4):** When a pack is removed, should `decisions` and `glossary` hide rows whose source `service:type` is no longer mapped (by filtering on the active mapping at read time while preserving the SQLite rows), or delete them from `decision_record` / `glossary_term`? (Filtering at read time is strongly recommended so toggling a pack off and on doesn't re-spend LLM extraction budget or lose vetoes.)
4. **Extension-declared source mappings (Project 2):** In v1, should source mappings only be declared by **role packs** (and the built-in default table / first-party connector migration engine), deferring arbitrary extension-declared mappings until `extension.run` (I43) consent prompts disclose them?
5. **Per-profile vs. global active packs (Project 1 / Project 3):** Does switching profiles (`nimbus profile switch`) switch the active role packs, or are active packs global to the install?
6. **Multi-pack precedence rule (§ 3 Goal 4, § 9):** When two active packs both set a scalar config default or dashboard layout order, is precedence determined by **install order** (most recently installed pack wins) or an explicit **pack priority list**?
