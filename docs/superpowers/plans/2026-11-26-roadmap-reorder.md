# Roadmap Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phase number the build order in `docs/roadmap.md` (open phases renumbered from 7, done phases fixed, slot S5 removed) and keep every reference in the repo consistent.

**Architecture:** Docs-only. A throwaway Python helper (kept OUTSIDE the repo, in `C:\gitrep\Nimbus\.claude\worktrees\roadmap-reorder-tools\`) does the mechanical parts (row counts, section moves, the two-pass number rewrite, anchor aliases); prose sections are hand-written. Verification is by counts and the repo's own gates.

**Tech Stack:** Markdown, Python 3.14 (helper only), `bun run preflight:fast` (includes `audit:doc-refs`, `audit:status-drift`).

**Spec:** `docs/superpowers/specs/2026-11-26-roadmap-reorder-design.md` (Antigravity-approved 2026-11-26).

## Global Constraints

- Mapping (old → new): 30→7, 7→8, 8→9, 9→11, 12.5→12, 14→13, 18→14, 11→15, 13.5→16, 13→18, 16+29→19, 12→20, 15→21, 19→22, 20→23, 21→24, 22→25, 23→26, 24→27, 25→29, 26→30, 27→31.
- Done phases keep numbers: 1, 2, 3, 3.5, 4, 5, 6, 9.5, 9.7, 10, 17, 28. Spine records S1–S4 unchanged.
- Placeholder tokens `@@P<old>@@`; longest token first (`12.5`, `13.5` before `12`, `13`); whole numbers matched with `(?<![\d.])Phase (\d+)(?![\d.]*\d)` style lookarounds so `Phase 12.5` never yields `@@P12@@.5`.
- Historical text (shipped sections, S1–S4 records, dated progress notes, ruling lists, `CHANGELOG.md` old entries) keeps its numbers; the first mention of an OPEN phase per paragraph gains ` (now Phase N)`.
- Renumbered headings: the note `*(formerly Phase N)*` goes on the line under the heading; `<a id>` aliases for both slug variants (`phase-13--desktop-distribution` and `phase-13-desktop-distribution`) go above it.
- Row-count rule: after = before − merged − deduplicated − ticked + new, every term listed in the PR body.
- Nothing outward-facing: the launch row is the owner's; this change publishes nothing.
- The spec and this plan are deleted before the PR (`git diff origin/main...HEAD --stat` shows neither).

## Review Focus

1. A bare "Phase 12" in live prose that meant Enterprise is left as 12 (it must become 20) — Task 3's residual scan lists every remaining `Phase <open-old-number>` mention for a hand check.
2. An inbound link to a renumbered heading breaks — `audit:doc-refs` in Task 6 resolves every `roadmap.md#…` anchor.
3. A row is silently lost in a move — Task 1 baseline + Task 6 formula check.
4. A historical ruling is rewritten to a number it never had — Task 3 diff review of the S1–S4 records, Rulings lists and shipped phases shows only ` (now Phase N)` insertions there.
5. Code comments in `packages/**` citing an open phase keep the old number — Task 5 scan.

---

### Task 1: Baseline and inventory

**Files:** Create (outside repo): `roadmap-reorder-tools/baseline.json`, `roadmap-reorder-tools/refs-before.txt`

- [ ] **Step 1:** Count in `docs/roadmap.md`: lines matching `^\s*- \[ \]` (open) and `^\s*- \[x\]` (done); per phase section too. Save to `baseline.json`.
- [ ] **Step 2:** List every `Phase <n>` occurrence for an OPEN old number (7, 8, 9, 11, 12, 12.5, 13, 13.5, 14, 15, 16, 18–27, 29, 30) across `docs/**/*.md`, `packages/docs/**`, `.claude/commands/**`, `CLAUDE.md`, `GEMINI.md`, `packages/**/*.{ts,tsx,rs,md}`, `scripts/**` (excluding `node_modules`, `docs/CHANGELOG.md`) with file:line into `refs-before.txt`. Expected: roughly 600–900 lines.
- [ ] **Step 3:** List every `roadmap.md#phase-…`, `#spine-…`, `#carried-into-…`, `#track-…` anchor used anywhere (in-file and inbound).

### Task 2: Move and sweep rows (before any renumbering)

**Files:** Modify `docs/roadmap.md`

- [ ] **Step 1: Stale sweep, old 7/8/9.** For each open row, check whether it shipped (grep CHANGELOG/code; e.g. `nimbus why` ✅ 2026-07-24 S1; `nimbus principles`; LaunchDarkly/Flagsmith reads and writes; Semgrep/Sonar reads). Tick shipped ones `[x]` with `*(shipped <date>, <where>)*`. Record each in `roadmap-reorder-tools/moves.md` (row, action).
- [ ] **Step 2: Dedupe.** Every open row in a done phase (4, 5, 6) that already exists in an open phase or in `Carried into S4/S7` (e.g. Phase 4's S4-F6 native file picker and S4-F8 profile-switch broadcast, Phase 4's installer/signing rows that match Phase 13, Phase 5's RUM/web-vitals rows that match `Carried into S7`) becomes a pointer line, each counted as −1 under "deduplicated". Format, e.g. for the two Phase 4 rows: one pointer line `→ moved to Phase 13 (Desktop Distribution), 2026-11-26` (old number at this stage; Task 3 renumbers). Record each.
- [ ] **Step 3: Leftover open rows** in Phases 4, 5, 6, `Carried into S7`: move each to the phase where it now ships, appended to that phase's most fitting wave, with `*(moved from Phase N, 2026-11-26)*`; parked rows with an owner reason stay. Leave `<a id="carried-into-s7"></a>` at the destination of its first row with a one-line redirect note. Record each move.
- [ ] **Step 4: Fold Phase 29 into Phase 16.** Exactly 7 of its 8 rows go to Phase 16 Wave 1 (a move: net 0) beside *Team-server tier* (that row rewritten to say it is the team server, absorbing Phase 29's goal); the 8th, "Service artifacts", merges into Phase 12's *Docker image* + *Helm chart* rows (compose file and service unit added there; record −1); guardrails, "What its spec must decide" and acceptance criteria move as a `#### Team server` subsection of Phase 16. Phase 29's section is removed; `<a id="phase-29--the-team-server"></a>` and `phase-29-the-team-server` aliases go above the new subsection.
- [ ] **Step 5: Dependency fix.** Phase 14's dependency on "Phase 12 Enterprise policy-as-code" moves from the phase Dependencies list to the one row that needs the org-level disable, as a row note.
- [ ] **Step 6: New rows.** Phase 30 (to be new 7) gets as its first row: `- [ ] **Launch the agent-door copy** [NEW] — the owner releases the held copy in launch-messaging.md § Direction copy (README headline, docs site, repository description, listings); an outward-facing act, the owner's.`. Phase 7 (to be new 8) gets: `- [ ] **Pre-review over HTTP** [NEW] — a read-only external agent route POST /v1/agents/prereview under the agents token scope, for the browser extension's pull-request pages; no write, nothing posted.` and `- [ ] **Incident records over HTTP** [NEW] — design-first: an HTTP read route for incident records (scope to be decided) for the browser extension's alert pages.` Record +3.
- [ ] **Step 7: Verify:** open count = baseline − merged − deduped − ticked − (moved rows counted in both places? no: a move is −1 +1 = 0) + 3. Commit `docs(roadmap): move, sweep and fold rows before renumbering`.

### Task 3: Renumber the roadmap

**Files:** Modify `docs/roadmap.md`

- [ ] **Step 1: Physical order.** Reorder the Planned phase sections to: 30, 7, 8, 9, 12.5, 14, 18, 11, 13.5, 13, 16, 12, 15, 19, 20, 21, 22, 23, 24, 25, 26, 27 (by OLD number), i.e. new 7 … 31. Phases 9.5, 9.7, 10, 17 and 28 stay under `## Planned` (as today), each in its numeric slot between the renumbered phases (… 9, 9.5, 9.7, 10, 11 … 16, 17, 18 … 27, 28, 29 …); their text is unchanged.
- [ ] **Step 2: Two-pass rewrite** with the helper over the whole file, honouring the history rule (Global Constraints): live prose → new numbers; historical blocks → keep old + first ` (now Phase N)` per paragraph. Headings rewritten, each with the `*(formerly Phase N)*` line and both alias anchors. In-file anchor links rewritten to the new slugs.
- [ ] **Step 3: (moved to Task 4 Step 7.)** The residual scan runs only after the framing rewrite. ~~List every remaining `Phase <n>` where n is an open old number, and every new number in live prose; hand-check each (expected remaining: only inside historical blocks with ` (now Phase N)`). Diff-check that the S1–S4 records, ruling lists and shipped phases changed only by ` (now Phase N)` insertions.~~
- [ ] **Step 4:** Commit `docs(roadmap): phase numbers follow the build order`.

### Task 4: Rewrite the framing sections

**Files:** Modify `docs/roadmap.md`

- [ ] **Step 1: Build order** — new top-level section after Status Overview: the mapping table from the spec (new number, phase, formerly, why here) plus the dependency notes (new 9, 11 need new 8's service catalog; new 12 needs 9 and 11; new 16 needs 15; the team band needs new 8's catalog and automation library; Apple Developer enrollment needed before new 16).
- [ ] **Step 2: Client surfaces** moves intact (with its anchor) to a top-level section right after Build order; add the two decisions: the editor shows agent proposals read-only and approval stays at the terminal (owner 2026-11-26, may be reconsidered with collaboration); the browser extension gains deploy risk, the on-call brief, and (blocked on new 8's routes) pre-review and incident records.
- [ ] **Step 3: Spine section** → a short historical note ("the Phase 7+ Sequencing Spine ordered the build from 2026-06-17 to 2026-11-26; S1–S4 shipped; from 2026-11-26 the phase number is the build order") keeping anchors `phase-7-sequencing-spine` and the Track anchors as aliases; Track 1/2/3 tables removed (their content now lives in Build order and the phases); `Carried into S4` and `Owner's open items` lists stay (moved under Build order).
- [ ] **Step 4:** Contents, Direction (audience table → new 19 / new 7; Order list → "Now: Phase 7, Cost Pack; then 8 … 18; then the team band 19–21"; Shapes line: team server planned in Phase 19), Status Overview (all phases in number order, new numbers, done ones ✅), Active ("No phase is open. The next is Phase 7, the Cost Pack."), How to Update This Document (phase number = build order; a new phase gets the number of its place; done phases keep theirs; no slots), Last updated.
- [ ] **Step 5: Ruling block** in Direction: "The owner's rulings of 2026-11-26" — S5 removed and the team server folded into Phase 19; phase number = build order (done phases keep theirs); the mapping; business is support and hosting, everything open (OR-ECO-7 stands); desktop distribution is the last step before the team band; the editor approves nothing for now.
- [ ] **Step 6: Anchors.** Every moved section keeps its anchor: `client-surfaces`, `carried-into-s4`, `owners-open-items`, `carried-into-s7`, `phase-7-sequencing-spine`, the Track anchors, as `<a id>` lines (both slug variants where the heading had an em dash).
- [ ] **Step 7: Residual scan (final).** List every remaining `Phase <n>` where n is an open old number, and every new number in live prose; hand-check each (expected remaining: only inside historical blocks with ` (now Phase N)`). Diff-check that the S1–S4 records, ruling lists and shipped phases changed only by ` (now Phase N)` insertions.
- [ ] **Step 8:** Commit `docs(roadmap): build order, client surfaces and framing`.

### Task 5: Repo-wide references

**Files:** every file in `refs-before.txt` except `docs/roadmap.md` and `docs/CHANGELOG.md`

- [ ] **Step 1:** Apply the same two-pass rewrite to `docs/*.md` (not CHANGELOG), `packages/docs/**`, `.claude/commands/**`, `CLAUDE.md`, `GEMINI.md`, comments and strings in `packages/**` and `scripts/**`; inbound anchors rewritten to new slugs. A `Phase N` inside a dated historical note in those files follows the history rule.
- [ ] **Step 2:** Update status lines: `CLAUDE.md`/`GEMINI.md` Status ("No phase is open; next is Phase 7, the Cost Pack; the team server is planned in Phase 19"), `docs/README.md` status table (S5–S7 rows replaced by the phase order), `.claude/commands/nimbus-architecture.md` line 23.
- [ ] **Step 3: Residual scan** over the same globs: no live mention of an open phase by its old number. Test-name strings in `*.test.ts` that cite a phase: rewrite only if they are comments/descriptions, never an asserted value (grep the assertion first).
- [ ] **Step 4:** `bun run typecheck` (comment-only code edits must not break anything). Commit `docs: follow the roadmap renumbering everywhere`.

### Task 6: Verify, changelog, PR

- [ ] **Step 1:** `docs/CHANGELOG.md`: one new top entry (2026-11-26: the roadmap's phase numbers now follow the build order; slot S5 removed; mapping one line; no code change).
- [ ] **Step 2:** Row-count formula check against `baseline.json` and `moves.md`; print both sides.
- [ ] **Step 3:** `bun run preflight:fast` → `preflight PASSED`.
- [ ] **Step 4:** `git rm` the spec and this plan; `git diff origin/main...HEAD --stat` shows neither.
- [ ] **Step 5:** PR titled `docs(roadmap): phase numbers follow the build order`, body: the mapping, the moves list, the count formula, the rulings; `gh pr merge --squash --auto`; resolve review threads; wait for merge.
