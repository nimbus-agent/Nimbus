# Docs & Roadmap Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply four documentation enhancements (Provable Locality / M7, a concurrency + scaling model, a local-model supply-chain gap, and the proposed I17 standing-approval taint barrier) across `docs/roadmap.md`, `docs/architecture.md`, and `docs/SECURITY.md`.

**Architecture:** Documentation-only. Edits are grouped into four conceptual tasks (one per spec item ①–④) plus a finalization task, so each commit is a coherent, reviewable change. Items ③ and ④ are written strictly as *acknowledged gaps / proposed invariants* — never as active defenses — to respect the project's invariant **triple rule** (a defense is real only when it has production wiring + an invariants-file row + an enforcement test). No production code changes; the WAL fix the concurrency pass surfaces is filed as a roadmap follow-up (B5), not implemented here.

**Tech Stack:** Markdown. Quality gates: `bun run lint:markdown` (markdownlint-cli2, ruleset in `.markdownlint-cli2.jsonc`; MD022 = blank lines around headings, MD032 = blank lines around lists, MD034 = no bare URLs are the live ones to respect) and `bun scripts/structure-audit/check-doc-references.ts --check` (broken-link / backtick-path drift).

**Spec:** [`docs/superpowers/specs/2026-05-25-docs-roadmap-enhancements-design.md`](../specs/2026-05-25-docs-roadmap-enhancements-design.md)

> **TDD note for docs:** there is no unit test for prose. The adapted rhythm is: apply the exact edit → run `bun run lint:markdown` (expect clean) → run the doc-ref check (expect clean) → commit.
>
> **Editing discipline (read before applying any edit):** Every inserted **heading**, **list**, and **table** MUST be preceded *and* followed by a blank line (`\n\n` boundaries), or markdownlint MD022 (headings) / MD032 (lists) fails. When an agent applies these edits with a string-replace tool, it must preserve the surrounding blank lines exactly — do not collapse the blank line between a list bullet and a following heading, and put a blank line both before and after every table block. No bare URLs (MD034) — every link must be `[text](target)` form.
>
> **Doc-ref checker scope (important):** `check-doc-references.ts` validates **file existence + `:NN` line bounds only — it strips `#anchor` fragments and does NOT validate them**, and it **excludes `docs/roadmap.md` entirely** (roadmap intentionally references not-yet-existing phase files). Consequences: (a) the checker will *not* catch a wrong cross-doc anchor — anchors are verified manually in the step below; (b) running the checker after a roadmap-only edit is a no-op for that file; it is meaningful for `architecture.md` and `SECURITY.md`, which *are* scanned.
>
> **Verified anchors (hand-checked against GitHub slug rules — use these exact fragments):**
> - `roadmap.md#north-star-capabilities-cross-phase` → heading "### North-Star Capabilities (cross-phase)"
> - `roadmap.md#maintenance-initiative-follow-ups-b-series` → heading "#### Maintenance-initiative follow-ups (B-series)"
> - `roadmap.md#phase-9--ai-engineering-loop` → heading "### Phase 9 — AI Engineering Loop" (note the **double** hyphen `--` where the em-dash was)
>
> If you change any target heading text, recompute its slug and update every link to it — the checker will not flag a stale anchor.

---

## File map

| File | What changes |
|---|---|
| `docs/roadmap.md` | North-Star M7 pillar + connective-tissue ref (Task 1); Phase 8 Wave 4 egress-ledger item (Task 1); Phase 12 provable-locality export (Task 1); B5 WAL follow-up (Task 2); Phase 9 Wave 1 model-integrity item (Task 3); Phase 10 I17 note (Task 4); "Last updated" bump (Task 5) |
| `docs/architecture.md` | New "Concurrency & Consistency Model" + "Scaling Limits" subsections (Task 2) |
| `docs/SECURITY.md` | Audit-Log tamper-evident caveat (Task 1); "Local Model Supply Chain" subsection (Task 3); Standing-Approvals I17 bullet + Prompt-Injection forward-link (Task 4) |

---

## Task 1: Item ① — Provable Locality / M7

**Files:**
- Modify: `docs/roadmap.md` (North-Star section, connective-tissue paragraph, Phase 8 Wave 4, Phase 12 Compliance)
- Modify: `docs/SECURITY.md` (§ Audit Log)

- [ ] **Step 1: Add the M7 North-Star pillar (roadmap.md)**

In `docs/roadmap.md`, find the M6 bullet in § *North-Star Capabilities (cross-phase)* (it ends `… Extends Phase 14 + Phase 16.`). Insert a new bullet immediately after it (blank line not needed between list items, but keep the surrounding list intact):

```markdown
- [ ] **M7 — Provable Locality** — a continuous, cryptographically-attestable **egress ledger**: every network host the gateway and each sandboxed connector contacted, exportable as an auditor-grade artifact (*"proof this agent touched only these hosts this quarter"*). Uncopyable **because** of local-first + no-relay + `I15` — the sandbox already enforces a per-host network allowlist per connector, so the ledger is a faithful record, not a self-report; a cloud competitor (which *is* the egress) structurally cannot produce one. Promotes the killer demo's "0 outbound network calls" from a demo flourish to a product. Extends Phase 8 (the ledger + `nimbus egress` + signed report) and Phase 12 (auditor-grade compliance export); built on `I15` + the BLAKE3 audit chain. The chain is tamper-*evident*, not tamper-*proof* (a same-UID attacker could truncate + regenerate it); the Phase 12 export is **scheduled and pushed to an external append-only sink**, and that cadence — not the local store — is what bounds the rewrite window.
```

- [ ] **Step 2: Forward-reference M7 from the connective-tissue paragraph (roadmap.md)**

In the "Connective tissue" paragraph (same section), find this exact substring:

```text
a first-class **transparency surface** (always-visible "Local Only" egress indicator + inspect/delete-everything + decision replay)
```

Replace it with:

```text
a first-class **transparency surface** (always-visible "Local Only" egress indicator — M7 is its signed, exportable form — plus inspect/delete-everything + decision replay)
```

- [ ] **Step 3: Add the egress-ledger item to Phase 8 Wave 4 (roadmap.md)**

In § *Phase 8 — Security Engineering* → *Wave 4 — Supply Chain & Identity*, find the `nimbus supply-chain` bullet (ends `… emits `agents.supply_chain.briefReady``). Insert immediately after it:

```markdown
- [ ] **Egress ledger (`nimbus egress`)** — the local, signed record of every outbound host contacted by the gateway and each sandboxed connector, built on the `I15` per-host network allowlist + the BLAKE3 audit chain; `nimbus egress [--since <dur>] [--json] [--sign]` emits a verifiable report ("this agent contacted only these hosts"). The North-Star **M7 (Provable Locality)** capability; the auditor-grade, externally-anchored export lands in Phase 12.
```

- [ ] **Step 4: Add the provable-locality export to Phase 12 (roadmap.md)**

In § *Phase 12 — Enterprise* → *Centralized Policy & Compliance*, find the "Compliance posture tooling" bullet (ends `… structured JSON output suitable for auditors`). Insert immediately after it:

```markdown
- [ ] **Provable-locality export (M7)** — auditor-grade, Ed25519-signed export of the Phase 8 egress ledger + audit-chain head, scheduled and pushed to an external append-only sink (the same SIEM targets as audit log shipping) so the local chain is externally anchored; bounds the same-UID local-rewrite window. Completes the North-Star **M7 (Provable Locality)** capability.
```

- [ ] **Step 5: Add the tamper-evident caveat to SECURITY.md § Audit Log**

In `docs/SECURITY.md` § *Audit Log*, find the line ending `Verify with `nimbus audit verify` (see `packages/cli/src/commands/audit.ts`).` Insert a new paragraph immediately after it (blank line before and after):

```markdown
The chain is tamper-**evident**, not tamper-**proof**: a process running at the user's own UID can truncate the SQLite file and regenerate the chain, since the chain has no external anchor. Closing that window is the job of **scheduled, externally-anchored export** — periodically signing the chain head and the egress ledger to an external append-only sink (Phase 12 audit-log shipping / SIEM). See the North-Star **M7 (Provable Locality)** capability in [`roadmap.md`](./roadmap.md#north-star-capabilities-cross-phase).
```

- [ ] **Step 6: Run the doc gates**

Run: `bun run lint:markdown`
Expected: PASS (no MD022/MD032/MD034 errors on `roadmap.md` or `SECURITY.md`).

Run: `bun scripts/structure-audit/check-doc-references.ts --check`
Expected: PASS (no broken links / backtick paths).

If markdownlint flags a heading/list spacing error, add the missing blank line and re-run.

- [ ] **Step 7: Commit**

```bash
git add docs/roadmap.md docs/SECURITY.md
git commit -m "$(cat <<'EOF'
docs: add North-Star M7 (Provable Locality) egress ledger + audit-anchoring honesty

- roadmap: new M7 pillar; Phase 8 `nimbus egress` ledger; Phase 12 signed export
- SECURITY: audit chain is tamper-evident not tamper-proof; external-anchor path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Item ② — Concurrency & Consistency Model + Scaling Limits

**Files:**
- Modify: `docs/architecture.md` (§ Local Database Schema — append two subsections)
- Modify: `docs/roadmap.md` (B-series follow-ups — add B5)

- [ ] **Step 1: Add the Concurrency & Scaling subsections (architecture.md)**

In `docs/architecture.md`, find the end of § *Local Database Schema*: the bullet line

```text
Planned Phase 6+ tables (`service` / `scorecard` / `security_finding` / `llm_trace` / …) are tracked in [`roadmap.md` § Planned](./roadmap.md#planned).
```

It is followed by a blank line and a `---` horizontal rule. Insert the following content **between** that bullet line and the `---` (i.e. after the bullet, before the rule), preserving a blank line on each side:

```markdown
### Concurrency & Consistency Model

The Gateway is a single OS process, but several SQLite handles are open against the one `nimbus.db` file at once:

| Handle | Opened at | Mode |
|---|---|---|
| Main writer | `platform/assemble.ts` | read-write; `PRAGMA busy_timeout = 8000` |
| Embedding worker | `embedding/embedding-worker.ts` | its **own** connection; `busy_timeout = 8000`; `foreign_keys = ON` |
| Read-only HTTP API | `ipc/http-server.ts` | `SQLITE_OPEN_READONLY` + `PRAGMA query_only = ON` |
| HTTP write surface (`I13`) | `ipc/http-write-routes.ts` | dedicated read-write handle; the single allowlisted `POST /v1/deployments` route only |
| Raw-SQL guard | `db/query-guard.ts` | separate handle (Layer-2 isolation for `nimbus query --sql`) |

The intended model is **WAL journaling** (so readers never block the writer and vice versa), with `busy_timeout = 8000` as the contention backstop when two write paths (delta sync, embedding backfill, the `I13` deploy-annotation route) briefly compete. Every write goes through `dbRun` / `dbExec` / `dbStmtRun` (invariant `I14`), which translates `SQLITE_FULL` into a typed `DiskFullError` rather than a silently swallowed write. On clean shutdown the index issues `PRAGMA wal_checkpoint(TRUNCATE)` to fold the WAL back into the main file.

> **Status note (2026-05-25):** `PRAGMA journal_mode = WAL` is not currently set explicitly at any production open site. Until it is, the handles fall back to SQLite's default rollback journal — where readers and the writer block each other and the shutdown `wal_checkpoint(TRUNCATE)` is a no-op — and the 8 s busy-timeout is the only thing preventing immediate `SQLITE_BUSY` under contention. Enabling WAL explicitly, plus a regression guard that asserts it across every write handle, is tracked as **B5** in [`roadmap.md`](./roadmap.md#maintenance-initiative-follow-ups-b-series). This note documents the gap honestly rather than asserting a concurrency property the code does not yet guarantee.

### Scaling Limits

The index is designed for a single engineer's working set, not a data warehouse. Honest ceilings and what degrades first:

| Index size | Expected behaviour |
|---|---|
| ≤ 50k items | Comfortable; structured `nimbus query` p95 well under the 500 ms gate (measured: p95 < 500 ms at 8k rows). |
| 50k–250k items | Hybrid search (FTS5 BM25 + dual-vec KNN over `vec_items_384` + `vec_items_1536`) stays interactive; embedding backfill is the slow path on first sync. *(target)* |
| 250k–1M items | KNN latency and FTS5 index size become the first constraints; prune via `retentionDays` / `nimbus connector reindex --depth` to stay responsive. *(target)* |
| > 1M items | Beyond the single-Gateway design point; partition by profile or shorten retention. *(design ceiling, not benchmarked)* |

Embedding storage is the dominant on-disk cost at scale: each item contributes one or more chunk vectors to a `vec_items_*` table (384 floats local MiniLM, 1536 floats for prose-heavy types routed to OpenAI). Rows marked *(target)* / *(design ceiling)* are estimates pending a dedicated scaling benchmark; only the 8k-row figure is measured (the `nimbus query` latency harness, `NIMBUS_RUN_QUERY_BENCH=1`).
```

- [ ] **Step 2: Add the B5 WAL follow-up (roadmap.md)**

In `docs/roadmap.md` § *Maintenance-initiative follow-ups (B-series)*, find the bullet `- [ ] **B4 — Bug-hunt audit** …`. Insert immediately after it:

```markdown
- [ ] **B5 (high-priority) — WAL concurrency hardening** — **first confirm the finding** (`PRAGMA journal_mode` on a live gateway DB returns `delete` / `truncate`, not `wal`). If confirmed this is high-priority, not a routine bug-hunt item: with WAL off, `busy_timeout = 8000` is the *only* thing preventing immediate `SQLITE_BUSY` under contention, so concurrent delta sync + query + the `I13` write path serialize and stall up to 8 s before they can even error — a real under-load UX problem. Then explicitly set `PRAGMA journal_mode = WAL` at every production SQLite open site (main writer, embedding worker, the `I13` HTTP write handle) so readers never block the writer and the shutdown `wal_checkpoint(TRUNCATE)` is not a no-op; ship a regression guard (a static rule in `check-nimbus-invariants.ts` or a runtime test asserting `PRAGMA journal_mode` returns `wal` on each write handle). Surfaced by the architecture.md concurrency-model documentation pass (2026-05-25).
```

- [ ] **Step 3: Run the doc gates**

Run: `bun run lint:markdown`
Expected: PASS. Tables need a blank line before the heading above them and after the table; verify MD022/MD032 are clean.

Run: `bun scripts/structure-audit/check-doc-references.ts --check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture.md docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs: document SQLite concurrency model + scaling limits; file B5 WAL follow-up

- architecture: handle topology, WAL/busy-timeout model, honest WAL-not-set status note, scaling-limits table (measured vs target marked)
- roadmap: B5 — WAL concurrency hardening + regression guard

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Item ③ — Local-model supply chain

**Files:**
- Modify: `docs/SECURITY.md` (new subsection between § Prompt Injection and § Audit Log)
- Modify: `docs/roadmap.md` (Phase 9 Wave 1)

- [ ] **Step 1: Add the "Local Model Supply Chain" subsection (SECURITY.md)**

In `docs/SECURITY.md`, find the `### Audit Log` heading. Immediately before the `---` rule that precedes it, the document reads `…\n\n---\n\n### Audit Log`. Insert a new section so the order becomes Prompt Injection → **Local Model Supply Chain** → Audit Log. Concretely, find:

```text
### Audit Log
```

and insert the following block **before** it (ensure a blank line, a `---` rule, and a blank line separate it from the preceding Prompt Injection section, and a blank line + `---` + blank line separate it from `### Audit Log`):

```markdown
### Local Model Supply Chain

Nimbus verifies its own binaries (Ed25519 updater), extensions (`I16`), and extension manifests (SHA-256) — but **local model weights (GGUF files) pulled via Ollama or llama.cpp are not integrity-verified today.** A poisoned or substituted local model is an attack on the agent's *reasoning* — it can bias plans, fabricate tool arguments, or steer a user toward approving a harmful action — and it is not covered by the credential boundary above. This is an acknowledged residual risk pending the hardening item on the [Phase 9 roadmap](./roadmap.md#phase-9--ai-engineering-loop): optional digest pinning / signature verification reusing the existing SHA-256 + Ed25519 machinery (`nimbus llm verify`), with a fail-closed **`strict`** mode that refuses inference on a verification mismatch. It becomes a structural invariant — production wiring + a `SECURITY-INVARIANTS.md` row + an enforcement test — only once that work is wired, never before.

---
```

> Placement check: after this edit the sequence must be `### Prompt Injection` … `---` … `### Local Model Supply Chain` … `---` … `### Audit Log`, each heading and rule surrounded by blank lines.

- [ ] **Step 2: Add the model-integrity item to Phase 9 Wave 1 (roadmap.md)**

In `docs/roadmap.md` § *Phase 9 — AI Engineering Loop* → *Wave 1 — LLM Observability & Evaluation*, find the "AI context minimizer" bullet (the last bullet before `#### Wave 2`). Insert immediately after it:

```markdown
- [ ] **Model-weight integrity** — optional digest pinning / signature verification of local GGUF weights, reusing the existing SHA-256 / Ed25519 machinery; `nimbus llm verify`; pin known-good digests in config. Two modes: **`warn`** (default — log drift, continue) and **`strict`** (fail-closed — refuse to load the model / run inference on a verification mismatch). Because a substituted model is a total compromise of the agent's reasoning, `strict` is the recommended posture for security-sensitive deployments and can be pinned fleet-wide via the Phase 16 team baseline / Phase 12 org policy. Closes the "Local model supply chain" residual risk in [`SECURITY.md`](./SECURITY.md); becomes a structural invariant (wiring + invariants-file row + enforcement test) only once wired.
```

- [ ] **Step 3: Run the doc gates**

Run: `bun run lint:markdown`
Expected: PASS.

Run: `bun scripts/structure-audit/check-doc-references.ts --check`
Expected: PASS. The new links live in `SECURITY.md` (which *is* scanned); the checker confirms the **file** targets `./roadmap.md` and `./SECURITY.md` exist but does **not** validate the `#phase-9--ai-engineering-loop` fragment — that slug was verified by hand in the plan header.

- [ ] **Step 4: Commit**

```bash
git add docs/SECURITY.md docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs: surface local-model supply-chain gap + Phase 9 model-weight integrity item

- SECURITY: GGUF weights are not integrity-verified today (acknowledged residual risk; no invariant claim)
- roadmap: Phase 9 model-weight integrity with warn/strict (fail-closed) modes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Item ④ — Proposed invariant I17 (standing-approval taint barrier)

**Files:**
- Modify: `docs/SECURITY.md` (§ Standing Approvals design constraints; § Prompt Injection forward-link)
- Modify: `docs/roadmap.md` (Phase 10 Core — Standing Approvals & Scheduling)

- [ ] **Step 1: Add the I17 taint bullet to SECURITY.md § Standing Approvals**

In `docs/SECURITY.md` § *Standing Approvals (design for a future phase)* → "Design constraints (enforced at implementation time):", find the last bullet:

```text
- The rule editor in the UI must show a diff preview of the scope before saving.
```

Insert immediately after it:

```markdown
- **Taint barrier (proposed invariant I17).** Attacker-influenceable tool output — any MCP/connector result, any indexed content, any federated-peer response — may **never** satisfy a standing-approval match, a skill-pack auto-approve, or a template auto-adopt. The mechanism is a **metadata-driven provenance tag**, not dynamic runtime taint tracking: every indexed row already carries its origin (`<service>:<native_id>`) and every LLM-facing tool result already rides the `<tool_output service tool>` envelope (`I11`), so a two-class origin label is computed at that boundary and checked by the standing-approval matcher, which falls back to interactive HITL when the trigger is `untrusted`. The classes are drawn **conservatively**: `trusted` is *only* the user's direct, interactive CLI/UI input and the signed `nimbus.toml` / team baseline; `untrusted` is everything else — **including the output of executed scripts, `nimbus run` workflows, and any local process**, since a local script can fetch attacker-controlled content and local execution must not be a path to launder it into a trusted tag. I17 lands as a full invariant triple (production wiring + a `SECURITY-INVARIANTS.md` row + an enforcement test) when standing approvals are built; it unifies this section with Phase 16's "team skill packs cannot loosen HITL" guardrail and the Phase 16 federated-Q&A (M4) injection risk.
```

- [ ] **Step 2: Add the I17 forward-link to SECURITY.md § Prompt Injection**

In § *Prompt Injection*, find the final sentence ending `… the primary soft barrier against prompt injection.` Insert immediately after it (same paragraph or a new sentence on the same line):

```markdown
For the autonomous and standing-approval flows arriving in later phases, this soft read-surface barrier is backed by a second structural defense — the proposed taint barrier (**I17**, see § Standing Approvals) — so attacker-influenceable content can never satisfy an auto-approve path; until then, the HITL gate fires on every destructive action regardless of provenance.
```

- [ ] **Step 3: Add the I17 note to roadmap.md Phase 10**

In `docs/roadmap.md` § *Phase 10 — The Autonomous Agent* → *Core — Standing Approvals & Scheduling*, find the "Confidence Score for standing approvals" bullet. Insert immediately after it:

```markdown
- [ ] **🔒 Standing-approval taint barrier (proposed invariant I17)** — attacker-influenceable tool output (any connector / indexed / federated content) can never satisfy a standing rule, skill-pack auto-approve, or template auto-adopt; matched via a `trusted` / `untrusted` provenance tag riding the existing `I11` envelope, falling back to HITL on `untrusted` triggers. Ships *with* standing approvals as a full invariant triple. Canonical statement in [`SECURITY.md`](./SECURITY.md); shared with Phase 16 (skill packs / federated Q&A) and Phase 17.
```

- [ ] **Step 4: Run the doc gates**

Run: `bun run lint:markdown`
Expected: PASS.

Run: `bun scripts/structure-audit/check-doc-references.ts --check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/SECURITY.md docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs: foreshadow proposed invariant I17 (standing-approval taint barrier)

- SECURITY: provenance-tag taint barrier in Standing Approvals; Prompt-Injection forward-link
- roadmap: Phase 10 I17 note; unifies Phase 10/16/17 + M4. Proposal only — no active-defense claim.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Finalization

**Files:**
- Modify: `docs/roadmap.md` ("Last updated" note)

- [ ] **Step 1: Bump the "Last updated" note (roadmap.md)**

In `docs/roadmap.md`, find the line beginning `> **Last updated:** 2026-05-24 — added **Phase 16 (The Platform Layer)**`. Replace only the leading portion so the prior history is preserved — change it to:

```markdown
> **Last updated:** 2026-05-25 — added North-Star **M7 (Provable Locality)** (egress ledger threaded through Phase 8 + Phase 12), a **Concurrency & Scaling** documentation pass with a **B5 — WAL concurrency hardening** follow-up, a Phase 9 **model-weight integrity** item, and the proposed **I17** standing-approval taint barrier. 2026-05-24 — added **Phase 16 (The Platform Layer)**
```

(Everything from `2026-05-24 — added **Phase 16 (The Platform Layer)**` onward is the original text, kept verbatim.)

- [ ] **Step 2: Confirm CLAUDE.md / GEMINI.md need no change**

The roadmap's own update rule says status/convention changes mirror into `CLAUDE.md` + `GEMINI.md`. Verify these edits introduce **no** new active invariant, command, or convention: M7 and I17 are vision/proposals, model-integrity is a future item, and the concurrency note documents existing behavior. Therefore the `CLAUDE.md` invariant table (I1–I16) and command catalogue are unchanged.

Run: `git grep -n "I1–I16\|I1-I16" CLAUDE.md GEMINI.md`
Expected: the invariant-count phrasing still reads I1–I16; do **not** edit it (I17 is proposed, not active). If you find a place that would imply I17 is active, leave it — the proposal lives only in roadmap.md + SECURITY.md.

- [ ] **Step 3: Full doc-gate sweep + manual anchor verification**

Run: `bun run lint:markdown`
Expected: PASS across the whole docs tree.

Run: `bun scripts/structure-audit/check-doc-references.ts --check`
Expected: PASS (file targets resolve; remember the checker does not validate `#anchors` and excludes `roadmap.md`).

Manually verify the three cross-doc anchor targets still exist (the checker will NOT catch a broken `#fragment`):

Run: `git grep -nF -e "North-Star Capabilities (cross-phase)" -e "Maintenance-initiative follow-ups (B-series)" -e "Phase 9 — AI Engineering Loop" -- docs/roadmap.md`
Expected: three matching heading lines. If any heading is missing or was renamed, recompute its GitHub slug and fix every link to it in `SECURITY.md` / `architecture.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs: bump roadmap Last-updated note for M7 / concurrency / model-integrity / I17

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review (completed by plan author)

**Spec coverage:**
- Item ① M7 → Task 1 (pillar, connective tissue, Phase 8, Phase 12, audit-anchoring in M7 + SECURITY.md, export cadence). ✓
- Item ② Concurrency + Scaling → Task 2 (architecture.md subsections + honest WAL note + B5 roadmap follow-up). ✓
- Item ③ Model supply chain → Task 3 (SECURITY.md subsection + Phase 9 item with warn/strict). ✓
- Item ④ I17 → Task 4 (SECURITY.md constraint + provenance mechanism + Prompt-Injection link + Phase 10 note). ✓
- Review Open Q1 (provenance tag, not dynamic taint) → Task 4 Step 1. ✓
- Review S1 (WAL regression guard) → Task 2 Step 2 (B5) + architecture status note. ✓
- Review S2 (strict mode) → Task 3 Steps 1–2. ✓
- Review S3 (scheduled external push) → Task 1 Step 1 (M7 tail) + Step 5 (SECURITY) + Task 1 Step 4 (Phase 12). ✓
- DoD: "Last updated" bump → Task 5 Step 1; CLAUDE/GEMINI confirmation → Task 5 Step 2; lint + doc-ref → every task + Task 5 Step 3; WAL filed separately → B5. ✓

**Placeholder scan:** No TBD/TODO; every edit shows exact insertion text and an exact anchor string.

**Type/term consistency:** `nimbus egress`, `nimbus llm verify`, `warn`/`strict`, `trusted`/`untrusted`, I17, B5, M7 used identically across tasks. Register held: ③ and ④ never claim an active defense; both say "becomes an invariant only once wired."

**Out of scope (unchanged):** the WAL code fix itself (B5 tracks it), new connectors/phases, the non-selected secondary brainstorm ideas.
