# Docs & Roadmap Enhancements — Design Spec

**Date:** 2026-05-25
**Branch:** `docs/roadmap-phase-16-17-demo`
**Scope:** Documentation-only edits to `docs/roadmap.md`, `docs/architecture.md`, and `docs/SECURITY.md`. No production code changes. One code follow-up (WAL) is *surfaced* here but tracked separately.

---

## Goal

Close the few gaps a skeptical senior engineer, a security auditor, and a competitor would each catch, and add the one bet that is structurally uncopyable. The three docs are already mature; this is precision work, not bulk.

## Non-negotiable register rule

The project's own discipline (the B1 "orphaned defense" lesson, the invariant **triple rule**) forbids documentation claiming a defense that is not wired in production + covered by an enforcement test. Therefore:

- Items ① and ② document **vision** (①) and **current state + one flagged gap** (②).
- Items ③ and ④ are written strictly as **acknowledged gaps / proposed invariants** — never as active defenses. They become invariants only when wired + tested.

---

## Item ① — M7: Provable Locality / Egress Ledger (roadmap.md)

**Register:** forward-looking North-Star vision.

**Edit A — new North-Star pillar.** In `docs/roadmap.md` § *North-Star Capabilities (cross-phase)*, add:

> **M7 — Provable Locality** — a continuous, cryptographically-attestable **egress ledger**: every network host the gateway and each sandboxed connector contacted, exportable as an auditor-grade artifact ("proof this agent touched only these hosts this quarter"). Uncopyable *because* of local-first + no-relay + I15: the sandbox already enforces a per-host network allowlist per connector, so the ledger is a faithful record, not a self-report. A cloud competitor — which *is* the egress — structurally cannot produce it. Promotes the killer demo's "0 outbound network calls" from a demo flourish to a product. Extends **Phase 8** (the ledger + `nimbus egress` command + signed report) and **Phase 12** (auditor-grade compliance export). Built on `I15` (per-host network gating) + the BLAKE3 audit chain.

**Edit B — connective tissue.** In the "Connective tissue" paragraph, extend the existing "always-visible 'Local Only' egress indicator" mention to forward-reference M7 as the first-class, signed, exportable form of that indicator.

**Edit C — phase threading.** Add a concrete `[ ]` item to **Phase 8** (Security Engineering, likely Wave 4 — Supply Chain & Identity) for the egress ledger + `nimbus egress` CLI, and a `[ ]` item to **Phase 12** (Centralized Policy & Compliance) for the auditor-grade signed export. Both reference M7.

**Edit D — audit-anchoring honesty (free fallout).** Three coordinated edits:
- *roadmap.md (M7 context):* one sentence noting the local audit chain is tamper-**evident**, not tamper-**proof** (a same-UID attacker can truncate + regenerate the chain absent an external anchor), and that periodically signing the chain head to an external append-only notary is the hardening path — partially addressed by Phase 12 SIEM shipping.
- *SECURITY.md § Audit Log:* add one line stating the same tamper-evident-not-tamper-proof caveat + the external-anchor hardening path, so the security doc is honest about the limit rather than implying the chain is unforgeable. Cross-link to M7.
- *Export cadence (review Suggestion 3):* state explicitly that the M7 signed egress export + chain-head anchoring are designed to run on a **schedule** (Phase 10 scheduled workflows) and push to an **external append-only sink** (Phase 12 SIEM target / notary) — *not* only on-demand. The push cadence is what bounds the local-rewrite window: the tighter the schedule, the smaller the window in which a same-UID attacker could rewrite the chain before it is externally anchored. On-demand `nimbus egress` export remains available for ad-hoc audits, but the scheduled push is the security posture. This is the honest reconciliation of "local-first" with "tamper-resistant" — local is the default, external anchoring is the opt-in that closes the same-UID gap.

**Acceptance:** M7 reads as a peer to M1–M6; the egress-ledger capability is threaded into Phase 8 + Phase 12 with `[ ]` items; the audit-anchoring caveat is stated once and cross-linked, not duplicated.

---

## Item ② — Concurrency & Consistency Model + Scaling Limits (architecture.md)

**Register:** current state, grounded in code, with one finding flagged.

**Grounding (verified in code):**

| Handle | Where | Mode |
|---|---|---|
| Main writer | `platform/assemble.ts:104,108` | read-write; `PRAGMA busy_timeout = 8000` |
| Embedding worker | `embedding/embedding-worker.ts:40,47` | **own** connection; `busy_timeout = 8000`; `foreign_keys = ON` |
| HTTP read | `ipc/http-server.ts:317` | `SQLITE_OPEN_READONLY` + `PRAGMA query_only = ON` |
| HTTP write (I13) | `ipc/http-write-routes.ts` / `http-server.ts` | dedicated read-write handle, allowlisted route only |
| Raw-SQL guard | `db/query-guard.ts` | separate handle (Layer 2 isolation) |
| Shutdown | `index/local-index.ts:946` | `PRAGMA wal_checkpoint(TRUNCATE)` |

**Finding (to surface, not silently fix):** No `PRAGMA journal_mode = WAL` is set in production code. If WAL is not actually enabled, readers block writers (rollback-journal default), the three writers serialize behind the 8 s busy-timeout, and the shutdown `wal_checkpoint(TRUNCATE)` is a no-op. The docs work surfaces this; the **fix (explicitly enable + verify WAL, or document why not) is a code follow-up tracked outside this spec.**

**WAL regression guard (recommendation for the separate fix — review Suggestion 1).** When the WAL fix lands, it should ship with a regression guard so concurrency cannot silently regress: either a static rule in `scripts/structure-audit/check-nimbus-invariants.ts` (every production `new Database(...)` write handle sets `journal_mode = WAL`) or a runtime test asserting `PRAGMA journal_mode` returns `wal` on the main + embedding-worker + I13 write handles after open. This recommendation is **captured here but executed in the WAL code follow-up**, not in this docs-only spec. The architecture.md status note (Edit A) will mention the intended guard so the doc and the eventual fix stay coherent.

**Priority (review Suggestion 2).** The follow-up is filed as **B5 (high-priority)**, not a routine bug-hunt item: with WAL off, `busy_timeout = 8000` is the *only* guard against immediate `SQLITE_BUSY` under contention, so concurrent sync + query + the I13 write path serialize and stall up to 8 s. The roadmap B5 entry leads with a **confirm-the-finding** step (`PRAGMA journal_mode` on a live DB) since WAL-unset is a code-read finding, not yet a runtime-confirmed fact.

**Edit A — new subsection** under `## Local Database Schema` (or `## Nimbus Gateway: Process Lifecycle`), titled **"Concurrency & Consistency Model"**:
- The handle-topology table above (prose form).
- The intended model: single logical writer discipline + WAL for reader/writer concurrency; `busy_timeout = 8000` as the contention backstop across handles; all writes through `dbRun`/`dbExec`/`dbStmtRun` (I14) so `SQLITE_FULL → DiskFullError` is never swallowed; shutdown checkpoint.
- An explicit **status note** stating the WAL finding as an open item (linked to the tracking issue/PR once filed), written honestly rather than asserting WAL is on if it is not.

**Edit B — new "Scaling Limits" table** in the same section: honest ceilings and what degrades first —
- item-count tiers vs. expected query latency (FTS5 + dual-vec `vec_items_384`/`vec_items_1536` KNN),
- embedding-storage growth per 100k items,
- prune/retention thresholds (`retentionDays`),
- recommended practical maximum for a single Gateway.
- Numbers not yet benchmarked are marked **(target/estimate)**; the existing measured figures (`p95 < 500 ms` on 8k rows; `< 200 ms` merged-index query) are cited as measured.

**Acceptance:** a reader can answer "how do concurrent sync + query + HITL + HTTP writes coexist on one SQLite file?" and "what breaks first at scale?" from architecture.md alone; the WAL finding is stated honestly; no number is presented as measured unless it is.

---

## Item ③ — Local-model supply chain (SECURITY.md gap + roadmap hardening)

**Register:** acknowledged residual risk + future hardening. **No invariant claim.**

**Edit A — SECURITY.md.** Under § *Credentials* → "Acknowledged residual risks", or as a short new subsection "Local model supply chain":

> Local model weights (GGUF files) pulled via Ollama or llama.cpp are **not integrity-verified** today. Nimbus verifies its own binaries (Ed25519 updater), extensions (`I16`), and manifests (SHA-256), but a poisoned or substituted local model is an attack on the agent's *reasoning* — not currently mitigated. Treated as an acknowledged residual risk pending the Phase 9 hardening item below. Out of scope for the OS-keystore boundary; in scope for the agent's integrity story.

**Edit B — roadmap.md.** Add a `[ ]` item to **Phase 9 (AI Engineering Loop)** (Wave 1 — LLM Observability & Evaluation, or a new line):

> **Model-weight integrity** — optional digest pinning / signature verification of local GGUF weights, reusing the existing SHA-256 / Ed25519 machinery; `nimbus llm verify`; pin known-good digests in config. Two enforcement modes (review Suggestion 2): **`warn`** (default — log drift, continue, for usability while a user is still curating pins) and **`strict`** (fail-closed — the gateway refuses to load the model / run inference when digest or signature verification fails). Because a substituted model is a total compromise of the agent's reasoning, `strict` is the recommended posture for any security-sensitive or team-managed deployment, and the Phase 16 team baseline / Phase 12 org policy can pin `strict` fleet-wide. Becomes a structural invariant (triple: wiring + `SECURITY-INVARIANTS.md` row + enforcement test) only once wired.

**Acceptance:** SECURITY.md names the gap honestly without claiming a defense; the roadmap has a concrete hardening item with the correct "becomes an invariant only when wired" phrasing.

---

## Item ④ — Proposed invariant I17: standing-approval taint (forward-looking)

**Register:** proposed invariant, foreshadowed only. **No active claim.**

**Edit A — SECURITY.md.** In § *Standing Approvals (design for a future phase)* → "Design constraints", add:

> - **Taint barrier (proposed invariant I17).** Attacker-influenceable tool output — any MCP/connector result, any indexed content — may **never** satisfy a standing-approval match, a skill-pack auto-approve, or a template auto-adopt. Matching is against the tool's declared manifest name + connector id (already a constraint above) **and** a provenance/taint check on the triggering content. Lands as a full invariant triple (production wiring + `SECURITY-INVARIANTS.md` row + enforcement test) when standing approvals are built. Unifies this section with Phase 16's "team skill packs cannot loosen HITL" guardrail and the Phase 16 W2 federated-Q&A (M4) injection risk.

Also add a forward-link from § *Audit Log* / § *Prompt Injection* noting that the soft read-surface barrier is compensated structurally by the HITL gate today, and by proposed I17 once autonomous/standing flows exist.

**Edit B — roadmap.md.** In **Phase 10** (Standing Approvals & Scheduling) and cross-referenced from **Phase 16** (Wave 2) and **Phase 17**, note proposed **I17** as the structural defense those scoped-bypass features must ship with — mirroring the existing Phase 16 "🔒 Skill-pack HITL invariant" phrasing.

**Mechanism (design note — answers review Open Question 1).** I17 is a **metadata-driven provenance tag**, *not* dynamic taint tracking in the TypeScript runtime. Dynamic taint propagation across a JS heap is fragile, expensive, and easy to bypass; Nimbus already has the cheaper substrate:
- Every indexed row carries its origin (`<service>:<native_id>`), and every LLM-facing tool result is already wrapped in the `<tool_output service="…" tool="…">` envelope (`I11`).
- Provenance is therefore a **two-class origin label** computed at the envelope/row boundary, drawn **conservatively**: `trusted` is *only* the user's **direct, interactive** CLI/UI input + the signed `nimbus.toml`/team baseline; `untrusted` is everything else — any MCP/connector result, any indexed content, any federated-peer response, **and the output of executed scripts / `nimbus run` workflows / any local process** (a local script can fetch attacker content, so local execution must not launder it into a trusted tag — answers review Open Question 2).
- The standing-approval / skill-pack / template matcher consults this label on the **triggering content** and refuses the auto-approve path when the trigger is `untrusted` — falling back to interactive HITL. No per-byte taint, no runtime instrumentation; just an origin tag the existing boundaries already know.
- This keeps I17 implementable as a real invariant triple (a tag check at the matcher, a `SECURITY-INVARIANTS.md` row, an enforcement test) rather than an unfalsifiable "we track taint" claim.

**Acceptance:** I17 is described once canonically (SECURITY.md), referenced (not duplicated) from the relevant phases, and explicitly framed as "lands as a triple when built." No text implies it is active today.

---

## Cross-cutting coherence (free fallout, include if low-cost)

- The concurrency story (②) is made consistent between architecture.md (currently silent) and SECURITY.md I13 ("a second, dedicated handle").
- SECURITY.md's standing-approval section gains a forward-link to the I17 family (④) so the load-bearing-across-three-phases reality is visible.

## Out of scope

- Any production code change (including the WAL fix — surfaced, tracked separately).
- New connectors, new phases, or reorganizing existing phases.
- The secondary brainstorm ideas not selected (model-portability pillar as its own M, runtime failure-mode catalogue, `item_type` namespacing, HITL-fatigue framing, single capability map). May be revisited later.

## Definition of done

1. Edits ①–④ applied to the three docs in the registers above.
2. `docs/roadmap.md` "Last updated" note bumped; per the doc's own update rules, mirror any roadmap status/convention change into `CLAUDE.md` + `GEMINI.md` if applicable (M7 + I17 are vision/proposal, so likely no CLAUDE.md row — confirm).
3. Markdown lint clean (the repo gates MD022/MD032 — see recent CHANGELOG commit).
4. Internal doc links validated. Note the doc-ref drift check (`check-doc-references.ts`) validates **file existence + `:NN` bounds only** — it strips `#anchor` fragments (no anchor validation) and **excludes `docs/roadmap.md` entirely** (review Open Question 1). Cross-doc anchors are therefore verified **manually**; the three slugs used here (`#north-star-capabilities-cross-phase`, `#maintenance-initiative-follow-ups-b-series`, `#phase-9--ai-engineering-loop`) were hand-checked against GitHub slug rules.
5. WAL finding filed as a separate tracked follow-up (issue or roadmap line), referenced from the architecture.md status note.
