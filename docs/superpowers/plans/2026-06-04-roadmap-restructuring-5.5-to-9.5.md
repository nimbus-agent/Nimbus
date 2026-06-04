# Roadmap Restructuring (Phase 5.5 → 9.5 + Phase 6 decomposition) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the Phase 5.5 sequencing error by relocating + renumbering it to Phase 9.5 (after its real blocker, Phase 9 Wave 5), move the consumer-oriented personal/family/friend federation out of Phase 6 into a new Phase 20 (Personal & Household Federation), and record the Phase 6 delivery-slice decomposition — all in `docs/roadmap.md` plus one `docs/CHANGELOG.md` note.

**Architecture:** Pure documentation edits. There is no code and there are no unit tests; each task's "verification" is a `grep` (via the Grep tool or `git grep`) with an expected result, plus a Markdown link-integrity check. Edits are grouped into logically-coherent tasks, each ending in a commit, so the history is reviewable.

**Tech Stack:** Markdown; `git`; the repo's `bun run audit:*` doc gates (informational here).

**Source spec:** `docs/superpowers/specs/2026-06-04-phase6-federation-core-design.md` (§2 Roadmap Change-Set). This plan implements **only §2** — the Slice 1 Federation Core *build* is a separate future plan.

**Working file:** `docs/roadmap.md` unless otherwise noted. All line numbers below are as of spec commit `200dc16d`; because edits shift line numbers, every step anchors on **unique text strings**, not line numbers. Use the Edit tool with the exact `old_string`/`new_string` shown.

**Anchor convention reminder:** GitHub/Starlight slugify `### Phase 9.5 — Marketplace Registry` to `phase-95--marketplace-registry` (the `.` is dropped; the em-dash becomes the double hyphen). That is the new anchor every link must point to.

---

### Task 1: Relocate and rename the Phase 5.5 section to Phase 9.5

**Files:**
- Modify: `docs/roadmap.md` (the `### Phase 5.5 — Marketplace Registry` section, currently the first entry under `## Planned`)

This is a cut-and-paste of the whole section from between Phase 5 and Phase 6 to between Phase 9 and Phase 10, plus a heading rename. Do it as three precise edits.

- [ ] **Step 1: Confirm the section's current boundaries**

Run (Grep tool, `output_mode: content`, `-n: true`):
```
pattern: ^### Phase (5\.5|6 —|9 —|10 —)
path: docs/roadmap.md
```
Expected: `### Phase 5.5 — Marketplace Registry` appears once (under `## Planned`, before `### Phase 6 — Team`); `### Phase 9 — AI Engineering Loop` and `### Phase 10 — The Autonomous Agent` each appear once, adjacent. This confirms the cut source and the paste target.

- [ ] **Step 2: Cut the section out of its current location**

In `docs/roadmap.md`, the section is bracketed like this (start, then the separator that follows its last bullet, then Phase 6):

```markdown
## Planned

### Phase 5.5 — Marketplace Registry

**Goal:** Turn the connector + extension ecosystem ...
...
- An extension installed from a configured private registry verifies its signature against that registry's own publisher trust root with no call to `registry.nimbus-agent.dev`.

---

### Phase 6 — Team
```

Use the Edit tool to remove the section **and its trailing `---` separator**, so `## Planned` flows directly into Phase 6. Match this exact `old_string`:

```
## Planned

### Phase 5.5 — Marketplace Registry
```
…through…
```
- An extension installed from a configured private registry verifies its signature against that registry's own publisher trust root with no call to `registry.nimbus-agent.dev`.

---

### Phase 6 — Team
```

Replace with:
```
## Planned

### Phase 6 — Team
```

> **How:** because the section is ~65 lines, do this in your editor by selecting from the `### Phase 5.5 — Marketplace Registry` line through the `---` line immediately above `### Phase 6 — Team` and deleting it, leaving one blank line between `## Planned` and `### Phase 6 — Team`. **Save the cut text to your clipboard / a scratch buffer** — you paste it in Step 3.

- [ ] **Step 3: Paste the section before Phase 10 and rename the heading**

The Phase 9 → Phase 10 boundary currently reads:
```markdown
- Wave 6: `nimbus audit refusals` lists every refusal of the seeded session with reason code and originating query; contesting a refusal (`--contest <refusal-id>`) opens the would-be tool call for the user to inspect

---

### Phase 10 — The Autonomous Agent
```

Insert the cut section (with its heading renamed `5.5` → `9.5`) **between** that `---` and `### Phase 10`, followed by its own `---`. After this edit the region must read:
```markdown
- Wave 6: `nimbus audit refusals` lists every refusal of the seeded session with reason code and originating query; contesting a refusal (`--contest <refusal-id>`) opens the would-be tool call for the user to inspect

---

### Phase 9.5 — Marketplace Registry

**Goal:** Turn the connector + extension ecosystem ...
...
- An extension installed from a configured private registry verifies its signature against that registry's own publisher trust root with no call to `registry.nimbus-agent.dev`.

---

### Phase 10 — The Autonomous Agent
```

Note the **only** change to the pasted body is the heading line: `### Phase 5.5 — Marketplace Registry` → `### Phase 9.5 — Marketplace Registry`. (The in-body "Composes with Phase 9" note is reworded in Task 3 — leave it for now.)

- [ ] **Step 4: Verify the move**

Run (Grep tool, `output_mode: content`, `-n: true`):
```
pattern: ^### Phase (5\.5|9\.5|9 —|10 —)
path: docs/roadmap.md
```
Expected: **no** `### Phase 5.5` line; exactly one `### Phase 9.5 — Marketplace Registry`; and its line number is **greater** than `### Phase 9 — AI Engineering Loop` and **less** than `### Phase 10 — The Autonomous Agent`.

Also run:
```
pattern: ^## Planned$
```
…and read the 6 lines after it to confirm `### Phase 6 — Team` is the first phase under `## Planned` (no orphaned `---`/blank-line damage).

- [ ] **Step 5: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): relocate + rename Phase 5.5 -> 9.5 (after its Phase 9 Wave 5 blocker)"
```

---

### Task 2: Fix the Status Overview table and the Contents list

**Files:**
- Modify: `docs/roadmap.md` (`## Status Overview` table; `## Contents` list)

- [ ] **Step 1: Move the Status table row**

The table currently has the Marketplace row between Phase 5 and Phase 6:
```markdown
| Phase 5 | The Extended Surface | ✅ Complete |
| Phase 5.5 | Marketplace Registry | Planned |
| Phase 6 | Team | Planned |
```
Edit to remove that row from here:
```markdown
| Phase 5 | The Extended Surface | ✅ Complete |
| Phase 6 | Team | Planned |
```
Then add it between the Phase 9 and Phase 10 rows. Change:
```markdown
| Phase 9 | AI Engineering Loop | Planned |
| Phase 10 | The Autonomous Agent | Planned |
```
to:
```markdown
| Phase 9 | AI Engineering Loop | Planned |
| Phase 9.5 | Marketplace Registry | Planned |
| Phase 10 | The Autonomous Agent | Planned |
```

- [ ] **Step 2: Fix the Contents list**

Change (the `## Contents` "Planned" line):
```
- [Planned](#planned) — Phases 5.5 through 19 (including 5.5 Marketplace Registry, 12.5 Compliance Receipts, 13.5 Mobile Companion, 18 Vertical Personas, 19 Ambient Surfaces), plus near-term & cross-phase initiatives (M1–M8 north-stars + S — Standards track)
```
to:
```
- [Planned](#planned) — Phases 6 through 19 (including 9.5 Marketplace Registry, 12.5 Compliance Receipts, 13.5 Mobile Companion, 18 Vertical Personas, 19 Ambient Surfaces), plus near-term & cross-phase initiatives (M1–M8 north-stars + S — Standards track)
```

- [ ] **Step 3: Verify**

Run (Grep tool, `output_mode: content`, `-n: true`):
```
pattern: \| Phase (5|5\.5|6|9|9\.5|10) \|
path: docs/roadmap.md
```
Expected: a `| Phase 9.5 | Marketplace Registry | Planned |` row sits between Phase 9 and Phase 10; **no** `| Phase 5.5 |` row remains; the table is in ascending phase order.

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): move Marketplace row to 9.5 in status table + contents"
```

---

### Task 3: Reword the in-section "Composes with Phase 9" note

**Files:**
- Modify: `docs/roadmap.md` (inside the now-`### Phase 9.5 — Marketplace Registry` section)

The note still claims Phase 9 ships Wave 5 "before Phase 5.5 closes" — stale now that 9.5 follows 9.

- [ ] **Step 1: Replace the note**

Change:
```
> **Composes with Phase 9 (AI Engineering Loop):** quality scores in the marketplace listing are produced by the **`nimbus eval` framework** delivered in Phase 9 — see [§ Phase 9 → Wave 5](#phase-9--ai-engineering-loop). Phase 9 ships Wave 5 *before* Phase 5.5 closes, so the marketplace UI has real quality data from day one.
```
to:
```
> **Composes with Phase 9 (AI Engineering Loop):** quality scores in the marketplace listing are produced by the **`nimbus eval` framework** delivered in Phase 9 Wave 5 — see [§ Phase 9 → Wave 5](#phase-9--ai-engineering-loop). Wave 5 is a hard prerequisite delivered in the immediately preceding phase, so the marketplace UI consumes its quality scores from day one.
```

- [ ] **Step 2: Verify**

Run (Grep tool, `output_mode: content`):
```
pattern: Phase 5\.5 closes
path: docs/roadmap.md
```
Expected: **no matches** (the stale "before Phase 5.5 closes" phrasing is gone).

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): reword 9.5 compose-note now that it follows Phase 9"
```

---

### Task 4: Fix the Phase 5 cross-references (status note + acceptance bullet + anchor)

**Files:**
- Modify: `docs/roadmap.md` (Phase 5 status note; Phase 5 acceptance-criteria bullet)

- [ ] **Step 1: Fix the Phase 5 status note**

Change (within the `### Phase 5 — The Extended Surface ✅` status blockquote):
```
The community-extension Marketplace acceptance criterion is tracked in **Phase 5.5** and does not gate Phase 5.
```
to:
```
The community-extension Marketplace acceptance criterion is tracked in **Phase 9.5** and does not gate Phase 5.
```

- [ ] **Step 2: Fix the Phase 5 acceptance-criteria bullet (text + anchor)**

Change:
```
- **(Tracked in Phase 5.5 — not a Phase 5 gate.)** A community extension published via the **Marketplace Registry** can be installed, enabled, and used without the author having access to Nimbus core source. This depends on the public registry host (`registry.nimbus-agent.dev`) and the seed/publish flow, which are the deliverables of **[Phase 5.5 (Marketplace Registry)](#phase-55--marketplace-registry)** (Planned), so it is tracked there and does not gate Phase 5 completion.
```
to:
```
- **(Tracked in Phase 9.5 — not a Phase 5 gate.)** A community extension published via the **Marketplace Registry** can be installed, enabled, and used without the author having access to Nimbus core source. This depends on the public registry host (`registry.nimbus-agent.dev`) and the seed/publish flow, which are the deliverables of **[Phase 9.5 (Marketplace Registry)](#phase-95--marketplace-registry)** (Planned), so it is tracked there and does not gate Phase 5 completion.
```

- [ ] **Step 3: Verify the anchor target exists**

Run (Grep tool, `output_mode: content`, `-n: true`):
```
pattern: phase-95--marketplace-registry|### Phase 9\.5 — Marketplace Registry
path: docs/roadmap.md
```
Expected: the link `(#phase-95--marketplace-registry)` and the heading `### Phase 9.5 — Marketplace Registry` both appear — confirming the link resolves to the relocated heading.

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): repoint Phase 5 references + anchor to Phase 9.5"
```

---

### Task 5: Fix the Phase 9 Wave 5 cross-references

**Files:**
- Modify: `docs/roadmap.md` (Phase 9 Wave 5 intro, two bullets, one acceptance criterion)

- [ ] **Step 1: Wave 5 intro line**

Change:
```
This wave delivers the **author-facing eval surface** that Phase 5.5 Marketplace consumes as the quality column.
```
to:
```
This wave delivers the **author-facing eval surface** that the Phase 9.5 Marketplace consumes as the quality column.
```

- [ ] **Step 2: "Registry-side reproducibility check" bullet**

Change:
```
- [ ] **Registry-side reproducibility check** — the Phase 5.5 publish hook re-runs `nimbus eval` in a fresh registry-side sandbox
```
to:
```
- [ ] **Registry-side reproducibility check** — the Phase 9.5 publish hook re-runs `nimbus eval` in a fresh registry-side sandbox
```

- [ ] **Step 3: "Local quality regression test" bullet**

Change:
```
integrates with the auto-update HITL prompt (see Phase 5.5 "Quality regression watcher").
```
to:
```
integrates with the auto-update HITL prompt (see Phase 9.5 "Quality regression watcher").
```

- [ ] **Step 4: Wave 5 acceptance criterion**

Change:
```
This is the property Phase 5.5's registry-side reproducibility check depends on.
```
to:
```
This is the property Phase 9.5's registry-side reproducibility check depends on.
```

- [ ] **Step 5: Verify**

Run (Grep tool, `output_mode: content`, `-n: true`):
```
pattern: Phase 5\.5
path: docs/roadmap.md
```
Expected: zero matches **in the Phase 9 region** (lines around the Wave 5 block). Remaining matches elsewhere (Phase 18, S-track) are fixed in Task 6.

- [ ] **Step 6: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): repoint Phase 9 Wave 5 references to Phase 9.5"
```

---

### Task 6: Fix the Phase 18 and S-track cross-references

**Files:**
- Modify: `docs/roadmap.md` (Phase 18 dependency + creator-persona bullet; S — Standards SCM bullet + acceptance criterion)

- [ ] **Step 1: Phase 18 dependency line**

Change:
```
- Phase 5.5 marketplace registry (long-tail personas land as community extensions; first-party set bounded)
```
to:
```
- Phase 9.5 marketplace registry (long-tail personas land as community extensions; first-party set bounded)
```

- [ ] **Step 2: Phase 18 `nimbus creator` bullet**

Change:
```
dedicated YouTube + Patreon + Twitch MCP connectors land as community extensions per the Phase 5.5 marketplace pattern.
```
to:
```
dedicated YouTube + Patreon + Twitch MCP connectors land as community extensions per the Phase 9.5 marketplace pattern.
```

- [ ] **Step 3: S-track SCM bullet**

Change:
```
- [ ] **SCM (Signed Connector Manifest)** — already implemented as the `I16` chain; the Phase 5.5 published manifest schema is its reference implementation. Documented as a section of the Phase 5.5 spec rather than a standalone RFC.
```
to:
```
- [ ] **SCM (Signed Connector Manifest)** — already implemented as the `I16` chain; the Phase 9.5 published manifest schema is its reference implementation. Documented as a section of the Phase 9.5 spec rather than a standalone RFC.
```

- [ ] **Step 4: S-track acceptance criterion**

Change:
```
SCM's reference implementation matches the Phase 5.5 manifest schema 1:1.
```
to:
```
SCM's reference implementation matches the Phase 9.5 manifest schema 1:1.
```

- [ ] **Step 5: Verify (roadmap is now fully renumbered)**

Run (Grep tool, `output_mode: content`, `-n: true`):
```
pattern: Phase 5\.5|phase-55--marketplace
path: docs/roadmap.md
```
Expected: **zero matches** anywhere in `docs/roadmap.md`.

- [ ] **Step 6: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): repoint Phase 18 + Standards-track references to Phase 9.5"
```

---

### Task 7: Defer Phase 6 sub-project #8 to a new Phase 20 — Personal & Household Federation

**Files:**
- Modify: `docs/roadmap.md` (cut the `#### Personal Federation (beyond the engineering team)` subsection out of Phase 6; create a new `### Phase 20 — Personal & Household Federation` section after Phase 19; add the Status-table row + Contents bump)

Per spec §2.2 and review note #2: a **dedicated Phase 20** (not a Phase 19 subsection) — because personal/family/friend federation is *not* ambient computing and would mix Phase 19's wearable/voice/XR theme.

- [ ] **Step 1: Cut the subsection from Phase 6**

In `docs/roadmap.md`, the Phase 6 body contains this subsection bounded by the next subsection heading:
```markdown
#### Personal Federation (beyond the engineering team)

The Phase 6 federation primitive is intentionally general — once two Gateways can share a scoped namespace, ...
- [ ] **Personal CRM** — ...
- [ ] **Family / couples mode** — ...
- [ ] **Friend-group mode** — ...
- [ ] **Group-namespace policy fragments** — ...
- [ ] **Privacy contract — narrowest-export-shape proof** — ...

#### Share & Virality Primitives
```

Use the Edit tool to remove the `#### Personal Federation (beyond the engineering team)` heading, its intro paragraph, and its 5 bullets — i.e. everything from `#### Personal Federation (beyond the engineering team)` up to (but **not** including) `#### Share & Virality Primitives`. After the edit, `#### Share & Virality Primitives` follows the subsection that preceded Personal Federation, with no gap damage. (You do not need to preserve the cut text — Step 2 supplies the rewritten Phase 20 body verbatim.)

- [ ] **Step 2: Create the new Phase 20 section after Phase 19**

Phase 19 is the last numbered phase; the cross-phase tracks (`### North-Star Capabilities (cross-phase)`, etc.) follow it. Insert the new Phase 20 section **immediately before** `### North-Star Capabilities (cross-phase)` so all numbered phases stay grouped. Find:
```
### North-Star Capabilities (cross-phase)
```
and replace it with (the new section, its closing `---`, then the original heading):
```markdown
### Phase 20 — Personal & Household Federation

**Goal:** Extend the Phase 6 federation primitive to consumer/household use cases that have **no cloud-vendor equivalent** — a personal CRM no third party ever sees, family/couples shared agents for joint logistics, and friend-group coordination — without compromising the local-first, no-relay, HITL-gated architecture.

> **Relocated from Phase 6** per guiding-principle #7 (Nimbus is built for professionals; consumer-oriented affordances are out of scope for the professional phases). These modes build **for free** on the Phase 6 Slice 1 federation core — no new infrastructure, only narrower namespace shapes and a different audience. Sequenced this late deliberately: the professional team-federation surface (Phase 6) must prove out first. A *professional* form of the narrowest-export-shape privacy proof stays in Phase 6 Slice 1; the family-namespace variant lives here.

#### Dependencies

- Phase 6 Slice 1 — Federation Core (E2EE peer pairing, scoped namespaces, the consent-scoped federated query primitive, audit integration)
- Phase 6 federation protocol-layer RBAC + the narrowest-export-shape privacy contract (professional form)

#### Personal & Household Federation

The federation primitive is intentionally general — once two Gateways can share a scoped namespace, the same mesh primitive serves use cases that cloud agents cannot legally or commercially handle.

- [ ] **Personal CRM** — a `person` table extension + `interaction` item type that indexes a user's relational history from already-indexed connectors: email threads (Gmail / Outlook), calendar attendees, Slack DMs + tagged channels, LinkedIn export (manual import), GitHub mentions. New built-in agent `nimbus contacts` answers "tell me about the last time I talked to Sara before our call," "who at Acme did I meet at the conference last year," "draft a follow-up to the people I had coffee with this week." Read-only; data never leaves the machine.
- [ ] **Family / couples mode** — a `family` namespace shape with two-to-six paired Gateways; shared item types limited to a conservative set (`event` from Calendar, structured `shopping_list` items, joint `expense` rows, custody/handover scheduling). HITL on every cross-device write. A contract test asserts no `email`, `pull_request`, `incident`, or work-item types are exposable through the family shape.
- [ ] **Friend-group mode** — same federation primitive as family mode, scoped to long-tail use cases with no cohesive home today: D&D campaign trackers, fantasy-league rosters, "who's free this weekend" coordination without surrendering full calendar visibility, group-photo sharing without a cloud upload.
- [ ] **Group-namespace policy fragments** — `[group.<name>].include_types = [...]` + `[group.<name>].exclude_services = [...]` enforced at the federation protocol layer; per-namespace HITL policy fragments live alongside `nimbus.policy.toml` so a family namespace can carry stricter rules than a work namespace on the same Gateway.
- [ ] **Privacy contract — narrowest-export-shape proof (household variant)** — for every group/family namespace shape, the test asserts the federation protocol cannot expose any item type or `raw_meta` field not declared in the namespace shape. Verified by attempting a federated query for a non-included type and asserting empty result + audit log entry recording the rejected query.

#### Acceptance Criteria

- Two paired personal Gateways share a `family` namespace; a contract test asserts no `email`, `pull_request`, `incident`, or work-item type is exposable through the family shape.
- `nimbus contacts` answers a relational-history query entirely from the local index with no outbound call.
- A federated query for a non-included type against a group namespace returns an empty result plus an audit-log entry recording the rejected query.

---

### North-Star Capabilities (cross-phase)
```

- [ ] **Step 3: Add the Status-table row and bump the Contents range**

Add the Phase 20 row after the Phase 19 row in the `## Status Overview` table. Change:
```markdown
| Phase 19 | Ambient Surfaces | Planned |
```
to:
```markdown
| Phase 19 | Ambient Surfaces | Planned |
| Phase 20 | Personal & Household Federation | Planned |
```

Then bump the Contents "Planned" line (which Task 2 left reading "Phases 6 through 19 … 19 Ambient Surfaces)"). Change:
```
- [Planned](#planned) — Phases 6 through 19 (including 9.5 Marketplace Registry, 12.5 Compliance Receipts, 13.5 Mobile Companion, 18 Vertical Personas, 19 Ambient Surfaces), plus near-term & cross-phase initiatives (M1–M8 north-stars + S — Standards track)
```
to:
```
- [Planned](#planned) — Phases 6 through 20 (including 9.5 Marketplace Registry, 12.5 Compliance Receipts, 13.5 Mobile Companion, 18 Vertical Personas, 19 Ambient Surfaces, 20 Personal & Household Federation), plus near-term & cross-phase initiatives (M1–M8 north-stars + S — Standards track)
```

- [ ] **Step 4: Verify the move**

Run (Grep tool, `output_mode: content`, `-n: true`):
```
pattern: ^#### Personal Federation \(beyond the engineering team\)|^### Phase 20 — Personal & Household Federation|^\| Phase 20 \|
path: docs/roadmap.md
```
Expected: the old `#### Personal Federation (beyond the engineering team)` heading is **gone**; exactly one `### Phase 20 — Personal & Household Federation` section heading exists, located **after** `### Phase 19 — Ambient Surfaces` and **before** `### North-Star Capabilities (cross-phase)`; and the `| Phase 20 | Personal & Household Federation | Planned |` status row exists.

Also confirm Phase 6 integrity:
```
pattern: ^#### (Share & Virality Primitives|Deferred from Phase 5)
path: docs/roadmap.md
```
Expected: both still present in the Phase 6 body, in order, undamaged.

- [ ] **Step 5: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): move personal/family/friend federation to a new Phase 20"
```

---

### Task 8: Record the Phase 6 delivery-slice decomposition

**Files:**
- Modify: `docs/roadmap.md` (top of the `### Phase 6 — Team` body)

Per spec §2.3 — give the roadmap the sequenced shape, not an undifferentiated feature list.

- [ ] **Step 1: Insert the decomposition subsection**

In `### Phase 6 — Team`, the body opens with a Goal line, then a `> Composes with Phase 7` blockquote, then `#### Dependencies`. Insert the new subsection **between** the `> Composes with Phase 7 …` blockquote and `#### Dependencies`. Find:
```
> **Composes with Phase 7 (Engineering Excellence):** the federation primitives, Team Vault, ChatOps, admin console, and org-level policy engine in this phase are the multipliers for Phase 7's service catalog, DORA metrics, feature-flag, and shared knowledge graph features. Phase 6 ships independently of Phase 7 — but when both are present, the `@nimbus excellence` ChatOps shortcut, embedded DORA panels in the admin console, and federated synchronisation of the Phase 7 knowledge graph + automation library all light up.

#### Dependencies
```
Replace with (the blockquote unchanged, the new subsection inserted before `#### Dependencies`):
```
> **Composes with Phase 7 (Engineering Excellence):** the federation primitives, Team Vault, ChatOps, admin console, and org-level policy engine in this phase are the multipliers for Phase 7's service catalog, DORA metrics, feature-flag, and shared knowledge graph features. Phase 6 ships independently of Phase 7 — but when both are present, the `@nimbus excellence` ChatOps shortcut, embedded DORA panels in the admin console, and federated synchronisation of the Phase 7 knowledge graph + automation library all light up.

#### Delivery Slices

Phase 6 bundles several independent subsystems; it ships as **9 sequenced delivery slices** (one consumer-oriented slice was moved out to the new Phase 20 — Personal & Household Federation). **Slice 1 — Federation Core** is the substrate every other slice depends on; its full design lives in [`docs/superpowers/specs/2026-06-04-phase6-federation-core-design.md`](superpowers/specs/2026-06-04-phase6-federation-core-design.md). Each slice gets its own spec → plan → implementation cycle.

| # | Slice | Depends on |
|---|-------|-----------|
| 1 | **Federation Core** — E2EE peer pairing, mDNS discovery, consent-scoped federated query primitive, shared scoped namespaces, expertise routing, protocol-layer RBAC, audit integration, invariant I17 | Phase 4 E2EE LAN + audit chain |
| 2 | Team Vault + Multi-user/Quorum HITL | 1 |
| 3 | Identity — SSO/OIDC/SAML + SCIM | 1 |
| 4 | Org Policy Engine + Admin Console + Observability | 1 |
| 5 | ChatOps (Slack/Teams bot, HITL-via-chat) | 1, 2 |
| 6 | Cross-colleague intelligence (ghost reviewers, conflict detection, cloud janitor, huddle, tribal-knowledge, blast-radius preflight) | 1 |
| 7 | Data Warehouse & BI connectors (Snowflake, Tableau, Looker, PowerBI, Monte Carlo, Bigeye) | 2, 3 |
| 8 | Share & Virality primitives (`nimbus share`, verify-share, referral, recipe, replay) | 1, Phase 4 signing |
| 9 | Deferred Phase 5 items (web clipper, Mendeley, Apple Mail/Cal, Workday, GitOps/ML writes) | mostly independent |

Slices 2–8 may proceed in parallel once Slice 1 lands; Slice 7 waits on 2+3; Slice 9 is independent. Each slice maps to the feature subsections below as follows:

- **Slice 1** ↔ "Federated Query Consent (foundational)" + the federation/namespace/discovery/conflict-detection parts of "Shared Infrastructure"
- **Slice 2** ↔ "Shared Infrastructure" (Team Vault, Quorum HITL) + "Identity & Access" (Multi-user HITL)
- **Slice 3** ↔ "Identity & Access" (SSO/OIDC/SAML, SCIM, role-based access control)
- **Slice 4** ↔ "Shared Workflows & Policy" (org-level policy engine + enforcement) + "Admin & Observability"
- **Slice 5** ↔ "ChatOps"
- **Slice 6** ↔ "Shared Infrastructure" (ghost reviewers, cross-user conflict detection, cross-team cloud janitor) + "Shared Workflows & Policy" (huddle briefing, tribal-knowledge extraction, blast-radius preflight)
- **Slice 7** ↔ "Data Warehouses & BI (SSO-gated)"
- **Slice 8** ↔ "Share & Virality Primitives"
- **Slice 9** ↔ "Deferred from Phase 5"

#### Dependencies
```

- [ ] **Step 2: Verify**

Run (Grep tool, `output_mode: content`, `-n: true`):
```
pattern: ^#### Delivery Slices
path: docs/roadmap.md
```
Expected: exactly one match, located between `### Phase 6 — Team` and that section's `#### Dependencies`.

Confirm the spec link is a valid relative path from `docs/roadmap.md`:
```bash
test -f docs/superpowers/specs/2026-06-04-phase6-federation-core-design.md && echo "link target exists"
```
Expected: `link target exists`.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): record Phase 6 delivery-slice decomposition"
```

---

### Task 9: Update the "Last updated" note and the CHANGELOG reference

**Files:**
- Modify: `docs/roadmap.md` (the `> **Last updated:**` line near the top)
- Modify: `docs/CHANGELOG.md` (the 2026-06-04 Phase 5 close-out entry)

- [ ] **Step 1: Prepend a dated note to the roadmap "Last updated" line**

The line begins:
```
> **Last updated:** 2026-05-28 (second pass) — added **Phase 18 (Vertical Personas)** …
```
Insert a new dated clause at the **front** of the change-log sentence (immediately after `> **Last updated:** `), so it reads:
```
> **Last updated:** 2026-06-04 — **renumbered the Marketplace Registry phase to Phase 9.5** and relocated it after Phase 9 (it previously sat as a `.5` between Phases 5 and 6; its hard blocker is Phase 9 Wave 5, the `nimbus eval` framework); **decomposed Phase 6 (Team) into 9 sequenced delivery slices** (Slice 1 = Federation Core; see `docs/superpowers/specs/2026-06-04-phase6-federation-core-design.md`); and **moved personal/family/friend federation out of Phase 6 into a new Phase 20 (Personal & Household Federation)** per guiding-principle #7. 2026-05-28 (second pass) — added **Phase 18 (Vertical Personas)** …
```
(Keep the entire pre-existing sentence intact after the new clause; only the `2026-06-04 — …` text and the trailing ` 2026-05-28 (second pass) —` join are added. **Note:** the new clause is deliberately worded to avoid the literal token "Phase 5.5" so the Task 10 zero-match check holds.)

**Then, in the SAME "Last updated" line, renumber the two *historical* "Phase 5.5" mentions** (in the `2026-05-28 (first pass)` portion) so no dangling reference to the old number survives. Change:
```
added **Phase 5.5 (Marketplace Registry)**, **Phase 12.5 (Compliance Receipts)**
```
to:
```
added **Phase 9.5 (Marketplace Registry)**, **Phase 12.5 (Compliance Receipts)**
```
and change:
```
promoted **`nimbus eval` (author-facing eval framework + quality score)** into Phase 9 as a Phase 5.5 prerequisite
```
to:
```
promoted **`nimbus eval` (author-facing eval framework + quality score)** into Phase 9 as a Phase 9.5 prerequisite
```
(The roadmap's "Last updated" line is an editorial summary, not the immutable delivery log — that's `docs/CHANGELOG.md` — so renumbering its historical mentions to the current number is correct; the new 2026-06-04 clause records that the renumber happened.)

- [ ] **Step 2: Fix the CHANGELOG entry**

In `docs/CHANGELOG.md`, the `### 2026-06-04` Phase-5 close-out bullet contains two "Phase 5.5" references. Change:
```
The community-extension Marketplace acceptance criterion is tracked in **Phase 5.5 (Marketplace Registry)** and does not gate Phase 5.
```
to:
```
The community-extension Marketplace acceptance criterion is tracked in **Phase 9.5 (Marketplace Registry)** and does not gate Phase 5.
```
and change:
```
Marketplace criterion scoped to Phase 5.5).
```
to:
```
Marketplace criterion scoped to Phase 9.5).
```

- [ ] **Step 3: Verify both files**

Run (Grep tool, `output_mode: content`, `-n: true`):
```
pattern: Phase 5\.5
path: docs/CHANGELOG.md
```
Expected: zero matches.

Then run the same over the roadmap — this is the task that clears the last (line-7) mentions, so the roadmap should now be fully clean:
```
pattern: Phase 5\.5|5\.5
path: docs/roadmap.md
```
Expected: zero matches. (If `5\.5` still hits, inspect — the only legitimate near-miss would be an unrelated number like a coverage figure; there are none in `roadmap.md`, so any hit is a missed renumber to fix before committing.)

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md docs/CHANGELOG.md
git commit -m "docs: record 5.5->9.5 renumber + Phase 6 decomposition in roadmap header + CHANGELOG"
```

---

### Task 10: Repo-wide verification and doc-gate check

**Files:**
- Read-only verification across `docs/`

- [ ] **Step 1: Confirm no stray "Phase 5.5" / old anchor remains in the forward-looking docs**

The authoritative check is the two living forward-looking docs only:
```
pattern: Phase 5\.5|phase-55--marketplace
path: docs/roadmap.md
```
and
```
pattern: Phase 5\.5|phase-55--marketplace
path: docs/CHANGELOG.md
```
Expected: **zero matches** in both.

> **Files that legitimately still contain "Phase 5.5" — do NOT edit them:**
> - `docs/superpowers/specs/2026-06-04-phase6-federation-core-design.md`, `docs/superpowers/plans/2026-06-04-roadmap-restructuring-5.5-to-9.5.md` (this plan), and any `*-review*.md` in `docs/superpowers/` — these **describe** the 5.5→9.5 renumber, so naming the old number is correct and required.
> - `docs/superpowers/plans/2026-05-29-deferred-pass-5-lanes.md` — a historical plan; its `5.5` matches are coincidental (e.g. a coverage figure), leave them.
> - `docs/assets/connectors/*.svg`, `docs/structure-audit/jscpd-report.json` — `5.5` is an SVG coordinate / duplication-report number, not a phase reference.
>
> A broad `grep -rn "Phase 5\.5" docs/*.md` is fine as a *sanity scan*, but only matches in `roadmap.md` / `CHANGELOG.md` are defects; matches in the `superpowers/` artifacts above are expected.

- [ ] **Step 2: Confirm the new anchor resolves and ordering is correct**

Run (Grep tool, `output_mode: content`, `-n: true`):
```
pattern: ^### Phase (9 —|9\.5 —|10 —)|^\| Phase 9\.5 \||phase-95--marketplace-registry
path: docs/roadmap.md
```
Expected: the `### Phase 9.5 — Marketplace Registry` heading sits between Phase 9 and Phase 10; the status-table row matches; every `(#phase-95--marketplace-registry)` link has the heading to resolve against.

- [ ] **Step 3: Run the docs link/format gates (informational)**

```bash
bun run audit:package-readmes
```
Expected: passes (this gate does not cover `roadmap.md` link integrity, but confirms no doc gate regressed). If the repo has a Markdown link-check script, run it too; if a lychee/link gate exists in CI it will validate the relative spec link and the in-page anchors.

> If no local Markdown link-checker is available, the Step 2 grep is the authoritative anchor-integrity check.

- [ ] **Step 4: Final review of the diff**

```bash
git log --oneline main..HEAD
git diff main -- docs/roadmap.md docs/CHANGELOG.md | head -200
```
Expected: a clean, reviewable series of doc-only commits; the diff shows the section relocated, all references renumbered, #8 deferred, and the decomposition recorded. No code files touched.

- [ ] **Step 5: (No commit — verification only.)** If Steps 1–2 found stray references, fix them with a follow-up edit + commit `docs(roadmap): mop up stray Phase 5.5 references`, then re-run Step 1.

---

## Notes for the implementer

- **This plan is doc-only.** There are no unit tests; the `grep`-with-expected-output steps *are* the tests. Treat a non-empty result on a "zero matches" verification as a failing test — stop and fix before committing.
- **Branch:** you are already on `worktree-dev+asafgolombek+phase6-planning` (a worktree). Do not switch to `main`.
- **Line numbers drift** as you edit; always re-locate by the unique strings shown, never by the line numbers in this plan.
- **Exact-string matches are brittle if `roadmap.md` drifted before execution.** This plan was authored against spec commit `200dc16d`; if the file has since changed (a typo fix, a whitespace tweak, another roadmap edit), a verbatim `old_string` may not match. **Before each edit, Grep for the shortest unique anchor phrase** in the target (e.g. `tracked in \*\*Phase 5\.5\*\*`, `Phase 5\.5 marketplace registry`, `#### Personal Federation`) to confirm the surrounding text still matches, and **adapt the `old_string` to the file's current wording** — the *intent* of each change (which phrase to renumber, which block to move) is what's authoritative, not the literal bytes. If an `old_string` fails to match, do not force it; re-read the region and re-derive the match. The per-task verification greps catch a missed or mis-applied edit before you commit.
- **The large Task 1 move** is the most drift-sensitive step: rather than matching the whole ~65-line block, anchor on the two unique boundary lines (`### Phase 5.5 — Marketplace Registry` and the `### Phase 6 — Team` that follows the section) to find the cut, and on `### Phase 10 — The Autonomous Agent` to find the paste target.
- **Out of scope (separate future plan):** the Slice 1 Federation Core *code* build (pairing, namespaces, `query-gate.ts`, expertise, discovery, `federation.*` RPC, the migration, CLI, invariant I17, audit integration). See spec §4–§8.
