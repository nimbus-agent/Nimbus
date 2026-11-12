# ED1 — Roadmap direction (main repository) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the owner's 2026-11-12 direction in `docs/roadmap.md` and the documents that restate it, in the `Nimbus` repository, without removing a planned row or changing what Nimbus publicly claims to be.

**Architecture:** One documentation pull request. Edits are additive (a Direction section, three appended phases, a Reach section, pointers on existing rows) plus a small set of corrections (spine renumbering, the commercial section, stale client-surface facts). A before-and-after row counter is the regression test; the existing doc gates are the rest.

**Tech Stack:** Markdown; `bun run preflight:fast`, `audit:doc-refs`, `audit:status-drift`, `audit:links`; `gh`.

**Spec:** `docs/superpowers/specs/2026-11-12-ecosystem-direction.md` (sections cited as § n). Slice ED1 of § 5.13. The other slices have their own plan (`2026-11-12-ed2-ed11-satellites.md`).

## Global Constraints

- No row in `docs/roadmap.md` is removed, ticked or split (OR-ECO-5, ED-b). Source rows keep their text and gain a pointer (D-ECO-4).
- Every new row is `- [ ]`, and a net-new idea carries `[NEW]`.
- Anything unbuilt is written in the future tense or with the word "planned" (§ 5.1, § 6).
- No count is copied from the spec or this plan. Each count that appears in a document is derived from code when the sentence is written.
- No market fact, competitor name or incident appears in any shipped document (§ 8).
- Everything in `docs/README.md` above its `## Where the Project Is` heading stays byte-identical (ED-g).
- `GEMINI.md` receives exactly the edits `CLAUDE.md` receives.
- New phases are 28 (agent door), 29 (team server), 30 (Cost pack), appended after Phase 27 (D-ECO-2). Spine: S5 Team Server, S6 Cost Pack, S7 Engineering Excellence breadth (D-ECO-3).
- The scaffold repositories are called **retired** in documents (true from the owner's ruling), never "archived", because the archive calls run later (ED11).
- The pull request title's type is `docs`, with no `!` and no `BREAKING CHANGE:` (nothing changes for a user).
- The spec and this plan are deleted from the branch before the pull request opens.

## Review Focus

1. **A renamed anchor breaks a link from a dated record.** `docs/CHANGELOG.md` links to `#carried-into-s5`. Expected: the old anchor still resolves. Pinned in Task 1 Step 6.
2. **A restatement of the spine is missed.** "S1 → S5" is written in six files. Expected: none is left outside dated records. Pinned in Task 6 Step 8.
3. **A row is lost in an 837 KB file.** Expected: every section's unticked count is greater than or equal to before. Pinned in Task 0 and Task 7 Step 1.
4. **A new sentence reads as shipped.** Expected: every new row is unticked and the new sections contain no present-tense claim about the agent door, the team server or the Cost pack. Pinned in Task 3 Step 7.
5. **`main` moved under the branch.** Other sessions merge roadmap edits several times a day. Expected: the branch is rebased immediately before the pull request and the counter is re-run after the rebase. Pinned in Task 7 Step 3.

---

### Task 0: Baseline

**Files:**
- Create (scratch, not committed): `<scratchpad>/ed1/count-rows.sh`, `<scratchpad>/ed1/before.txt`, `<scratchpad>/ed1/readme-head.before`

**Interfaces:**
- Produces: `count-rows.sh <path-to-roadmap.md>` printing one line per section (`<heading>\topen=<n>`) and a last line `client-surfaces-rows=<n>`; `before.txt`; `readme-head.before`.

- [ ] **Step 1: Rebase onto `origin/main`**

Run: `git fetch origin main && git rebase origin/main`
Expected: clean rebase (the branch holds only `docs/superpowers/**`).

- [ ] **Step 2: Write the counter**

```bash
#!/usr/bin/env bash
# count-rows.sh <roadmap.md> : unticked rows per '##'/'###' section, and Client-surfaces table rows.
awk '
/^## |^### / { if (name != "") printf "%s\topen=%d\n", name, open; name=$0; open=0 }
/^[[:space:]]*- \[ \]/ { open++ }
END { printf "%s\topen=%d\n", name, open }' "$1"
awk '
/^\| Surface \| State \| Next \|/ { intable=1; next }
intable && /^\| ---/ { next }
intable && /^\|/ { rows++ ; next }
intable && !/^\|/ { intable=0 }
END { printf "client-surfaces-rows=%d\n", rows }' "$1"
```

- [ ] **Step 3: Record the baseline**

Run: `bash count-rows.sh docs/roadmap.md > before.txt` and
`awk '/^## Where the Project Is/{exit} {print}' docs/README.md > readme-head.before`
Expected: `before.txt` ends with `client-surfaces-rows=6`; `readme-head.before` is non-empty.

---

### Task 1: The spine and the status tables (`docs/roadmap.md`)

**Files:**
- Modify: `docs/roadmap.md` — § Contents, § Status Overview, § Active, § Phase 7+ Sequencing Spine (through § Track 2)

- [ ] **Step 1: § Phase 7+ Sequencing Spine, Track 1 table**

S4 row: append to Contents "then **[NEW] the Agent Door [P28]**, built next (owner ruling OR-ECO-8, 2026-11-12)". Replace the S5 row with three rows, in this order, using the table's existing four columns:

| Spine | Theme | Contents | Why here |
|---|---|---|---|
| **S5** | **Team Server** | `[NEW]` Phase 29, plus the always-on half of the Ops pack | the shape teams adopt in; makes the on-call work always-on; a credential an agent never holds |
| **S6** | **Cost Pack** | `[NEW]` Phase 30 | a third audience on the same core; builds on the FinOps connectors shipped under S4 |
| **S7** | **Engineering Excellence breadth** | the present S5 row's Contents and Why-here cells, unchanged | renumbered from S5 on 2026-11-12 |

Heading `#### Track 1 — The Near-Term Spine (build order S1 → S5)` becomes `(build order S1 → S7)`. The status blockquote above the table gains one sentence naming the 2026-11-12 re-cut.

- [ ] **Step 2: "Carried into S5" becomes "Carried into S7"**

Rename the heading and add the new anchor while keeping the old one, so dated links survive:

```markdown
<a id="carried-into-s5"></a>
<a id="carried-into-s7"></a>

#### Carried into S7
```

Change every in-file link `#carried-into-s5` to `#carried-into-s7` and every prose "S5" that means this slot to "S7" (the **Shape** paragraph; the *Phase 7 Wave 4 splits across slots* paragraph; Phase 8's and Phase 9's sequencing notes; the *Already covered* table). Do not touch `S5-F…`, perf surface ids or `docs/CHANGELOG.md`.

Add one row at the end of the "Carried into S7" list (D-ECO-7):
`- [ ] **Reconcile or retire the ecosystem landscape** [NEW] — `docs/ecosystem-roadmap.md` (drafted 2026-08-02) still holds live design constraints (its non-goals and cross-cutting decisions) beside clusters that have since shipped. Check each cluster against the tree, move what is still true to its owning document, then retire the file.`

- [ ] **Step 3: § Active**

Append to the exit-condition blockquote: "**Added 2026-11-12 (owner ruling OR-ECO-8):** Phase 28 (the agent door), built before the remaining S4 rows. Work already in flight under S4 is not interrupted."

- [ ] **Step 4: § Track 2 — Scale & Surface**

In the "Commercial/scale band" bullet, drop "Commercial/" from the label and add that Phase 12's deployment rows and Phase 16 Wave 1's team-server rows are pulled into S5 (Phase 29). Leave the other bullets as they are.

- [ ] **Step 5: § Contents and § Status Overview**

§ Contents: add the Direction and Reach sections; rename the Commercial Roadmap entry to Open Source; the Planned entry says "Phases 7 through 30" and names 28, 29 and 30. § Status Overview: three rows (`Phase 28 | The Agent Door | Planned — next item inside S4`, `Phase 29 | The Team Server | Planned — S5`, `Phase 30 | The Cost Pack | Planned — S6`). "Current build slot" paragraph: `(S1 → S5)` becomes `(S1 → S7)` and one sentence names the agent door as S4's next project.

- [ ] **Step 6: Verify**

Run: `grep -n -c 'S1 → S5' docs/roadmap.md` → Expected: `0`.
Run: `grep -c 'id="carried-into-s5"' docs/roadmap.md` → Expected: `1`.
Run: `bun run audit:links` → Expected: exit 0.

- [ ] **Step 7: Commit** (`docs(roadmap): re-cut the spine — agent door in S4, team server S5, cost pack S6, breadth S7`)

---

### Task 2: Direction, principle 7 and the Open Source section (`docs/roadmap.md`)

**Files:**
- Modify: `docs/roadmap.md` — § Guiding Principles, new § Direction, § Commercial Roadmap, Phase 12 goal sentence

- [ ] **Step 1: § Direction**

Insert a new `## Direction` section immediately after § Guiding Principles, about sixty lines, with the six parts of spec § 5.1 in that order and under those names. Each door and pack carries its state beside it exactly as § 5.1 item 4 lists them. The two counts (read tools; action types an outside agent can propose) are derived from `packages/cli/src/mcp/` and `packages/gateway/src/connectors/proposable-actions.ts` at the moment of writing. The "Order" part is three lines (now: the agent door and § Reach; next: the team server; later: the Cost pack, then S7) with links to the spine table and § Reach.

- [ ] **Step 2: Principle 7**

Replace only the lens clause: "every feature is evaluated through the lens of an engineer who builds or runs production systems: a developer, a DevOps, SRE or platform engineer, a FinOps practitioner, or a security practitioner". The sentence "consumer-oriented affordances are out of scope" stays word for word.

- [ ] **Step 3: § Commercial Roadmap becomes § Open Source**

Replace the section (heading, tier table, the commercial-licence sentence, the "New buying centers" paragraph) with a section of at most ten lines saying: everything Nimbus does is in the open core (AGPL-3.0 gateway, MIT SDK and client); the maintainers may offer paid support and an SLA as a service; a commercial licence is available to organisations that cannot use the AGPL; the auditor and insurer audiences are described in Phases 21 to 26. Keep the old anchor so existing links resolve:

```markdown
<a id="commercial-roadmap"></a>

## Open Source
```

The three in-file links to `#commercial-roadmap` are left pointing at it; their link text changes from "§ Commercial Roadmap" to "§ Open Source". The sentence in § Rejected Directions that cites "the Auditor-in-a-Box and insurer buying centers" is reworded to "audiences" and keeps its meaning.

- [ ] **Step 4: Phase 12 goal sentence**

Becomes: "**Goal:** Make Nimbus deployable and auditable at institutional scale. Everything here ships in the open core (owner ruling OR-ECO-7, 2026-11-12); paid support and an SLA are a service, not a feature." Rows unchanged.

- [ ] **Step 5: Verify**

Run: `grep -n -i -E 'commercial tier|Tied to the commercial|\| \*\*Enterprise\*\* \| Phase 12' docs/roadmap.md` → Expected: no output.
Run: `grep -c 'Verified Publisher tier' docs/roadmap.md` → Expected: the same number as on `origin/main` (the rows are untouched, D-ECO-6).

- [ ] **Step 6: Commit** (`docs(roadmap): the direction section, principle 7's lens, and everything open`)

---

### Task 3: Phases 28, 29 and 30, and the pointers that feed them (`docs/roadmap.md`)

**Files:**
- Modify: `docs/roadmap.md` — append three sections after Phase 27 and before `### North-Star Capabilities`; pointers on source rows; one new row in Phase 17 Wave 4

- [ ] **Step 1: `### Phase 28 — The Agent Door`**

Structure as the neighbouring phases: a Sequencing blockquote (Track 1, S4, next item, OR-ECO-8), **Goal**, **Composes with**, the rows, **What its spec must decide**, **Acceptance Criteria**. Rows are the nine of spec § 5.3 (the ninth is the *Developer role pack*, § 5.6), each `- [ ] **<name>** [NEW] — <one or two sentences from § 5.3>`. Acceptance criteria are the seven of § 5.3, verbatim in meaning. "What its spec must decide" and the invariants in play are copied from § 5.3's last paragraph.

- [ ] **Step 2: `### Phase 29 — The Team Server`**

Same structure. A "Builds on (rows stay where they are)" list naming Phase 12's *Docker image*, *Helm chart*, *Air-gapped bundle*, Phase 16 Wave 1's *Team-server tier*, *Signed team baseline*, *`nimbus team join <repo>`*, and `docs/ecosystem-roadmap.md` cluster 10. Then the eight `[NEW]` rows of § 5.4, the three acceptance criteria, the "must decide" paragraph, and the standing constraint (no approval behind a browser page).

- [ ] **Step 3: `### Phase 30 — The Cost Pack`**

Same structure. "Builds on" names Phase 10 Stretch's *FinOps connectors*, *Cost anomaly detection*, *Cloud cost "garbage collection"*, *Data FinOps attribution* and Phase 9 Wave 4's rows. Then the six `[NEW]` rows of § 5.5 and its three acceptance criteria. One sentence says the binding convention between a cost series and a service is an owner decision the Phase 30 spec will ask.

- [ ] **Step 4: Pointers on the source rows**

Append to each source row, without changing its existing text, ` *(Built on by [Phase 29](#phase-29--the-team-server).)*` or the Phase 30 equivalent: the three Phase 12 rows, the three Phase 16 Wave 1 rows, the four Phase 10 Stretch rows, each Phase 9 Wave 4 row. Append ` *(Its model-door half; the outside-agent half is [Phase 28](#phase-28--the-agent-door).)*` as one line under Phase 9.7's Status paragraph, and ` *(Also in [Phase 28](#phase-28--the-agent-door).)*` to the carried-in *User-MCP write grants* row and to Phase 10's *Automated PR pre-review* row.

- [ ] **Step 5: Phase 17 Wave 4, one new row**

`- [ ] **Status page draft** [NEW] — a static page of current incidents, who is on call and the DORA scorecard, generated from the index; publishing it is the owner's act. From the retired `nimbus-statuspage` scaffold (OR-ECO-6, 2026-11-12).`

- [ ] **Step 6: Reword five rows in place (spec § 5.8)**

Phase 7's *LaunchDarkly* and *Flagsmith*, Phase 8's *Semgrep*, *SonarQube* and *Wiz*: prefix each row's description with "Read side shipped in Phase 5 (<the date on that row's Phase 5 entry>); what remains here: <the row's write tool or scope beyond Phase 5>." The row stays one unticked row.

- [ ] **Step 7: Verify**

Run: `awk '/^### Phase 28 /,/^### North-Star/' docs/roadmap.md | grep -c -E '^\- \[x\]'` → Expected: `0`.
Run: `awk '/^### Phase 28 /,/^### North-Star/' docs/roadmap.md | grep -n -i -E '\b(ships|shipped|is available|now supports)\b'` → Expected: only lines that describe something already shipped elsewhere (each such hit is read and justified in the commit message; any hit about the door, the server or the pack is rewritten).
Run: `bun run audit:links` → Expected: exit 0 (the new anchors resolve).

- [ ] **Step 8: Commit** (`docs(roadmap): phases 28 to 30 — the agent door, the team server, the cost pack`)

---

### Task 4: § Reach and two rejected directions (`docs/roadmap.md`)

**Files:**
- Modify: `docs/roadmap.md` — new `### Reach (the owner's track)` after § First-Run & Time-to-Wow; two entries in § Rejected Directions before `### Already covered — do not re-file`

- [ ] **Step 1: § Reach**

Eight rows from spec § 5.6, all `- [ ]`. Rows that restate an existing item point at it instead of repeating it (the Phase 13 rows; the owner item for `registry.nimbus-agent.dev`). The targets of D-ECO-9 are one paragraph under the rows, introduced as aspirations.

- [ ] **Step 2: Two rejected directions**

`### A quick-ask launcher surface (the Raycast shape) — not taken 2026-11-12` and `### A public recipe gallery — not taken 2026-11-12`. Each: what was proposed (one sentence), why not (two or three sentences: a launcher differentiates least and is one-platform; a gallery needs recipes written by people other than the owner), and **Reopens if** with the conditions in spec § 5.6.

- [ ] **Step 3: Verify**

Run: `grep -n -c '^\*\*Reopens if' docs/roadmap.md` → Expected: two more than on `origin/main`.

- [ ] **Step 4: Commit** (`docs(roadmap): the reach track and two directions not taken`)

---

### Task 5: Client surfaces, told as they are (`docs/roadmap.md`)

**Files:**
- Modify: `docs/roadmap.md` — § Client surfaces

- [ ] **Step 1: Derive the facts**

Run: `for r in nimbus-vscode nimbus-web-clipper; do gh release list -R nimbus-agent/$r --limit 1; done`
Read the phase headings of the browser client's own roadmap (`gh api repos/nimbus-agent/nimbus-web-clipper/contents/ROADMAP.md -H "Accept: application/vnd.github.raw" | grep -E '^#{2,3} .*C[0-9]'`) to state which of its phases shipped.

- [ ] **Step 2: The table**

Editor and browser rows: the released version from Step 1. Browser row's Next cell: the gateway-client direction is shipped in that repository (name the phases), and what is next is in its own roadmap. The three scaffold rows stay; State becomes `retired (OR-ECO-6, 2026-11-12)`; Next says where the work went (*Status page draft*, Phase 17; the two post-mortem rows; "not planned — see § Rejected Directions"). The paragraph under the table that explains 🧱 is reworded to past tense.

- [ ] **Step 3: The "Browser gateway client (direction, not yet built)" block**

Retitle it "Browser gateway client (shipped in `nimbus-web-clipper`)". Keep the decisions list and the honest-state list (they are still true and still useful); change the opening paragraph and the acceptance-criteria heading to say the first slice and what followed shipped, with the satellite roadmap as the authority. Delete nothing.

- [ ] **Step 4: The retired-file sentence**

"That sequencing used to live in `docs/ecosystem-roadmap.md`, which closed 2026-07-24 and is now retired" becomes: the sequencing document of that name closed 2026-07-24; the file now at that path is a landscape record drafted 2026-08-02, with no authority over sequencing (D-ECO-7).

- [ ] **Step 5: Verify**

Run: `bash count-rows.sh docs/roadmap.md | tail -1` → Expected: `client-surfaces-rows=6`.

- [ ] **Step 6: Commit** (`docs(roadmap): client surfaces as released; the three scaffolds retired`)

---

### Task 6: Every other document that restates it

**Files:**
- Modify: `CLAUDE.md`, `GEMINI.md`, `docs/README.md`, `docs/architecture.md`, `.claude/commands/nimbus-architecture.md`, `docs/launch-messaging.md`, `docs/infrastructure-roadmap.md`, `docs/ecosystem-roadmap.md`, `docs/CHANGELOG.md`, `docs/roadmap.md` (the "Last updated" note)
- Unchanged, stated in the pull request: `docs/cli-reference.md` (no command changed), `docs/audiences.md` (it describes who Nimbus serves today), `packages/docs/src/content/**` (a search found no tier, pricing or spine text there)

- [ ] **Step 1: `CLAUDE.md` and `GEMINI.md`, identically**

In the Status paragraph: "(S1 → S5)" becomes "(S1 → S7)"; the sentence listing what S4 closes on gains "and Phase 28 (the agent door), built next (owner ruling OR-ECO-8, 2026-11-12)"; one sentence is added after it: the lead is the trust layer for agents; after S4 the spine is S5 Team Server (Phase 29), S6 Cost Pack (Phase 30), S7 Engineering Excellence breadth; the public headline changes when the agent door ships. The release-please version line is not touched.

- [ ] **Step 2: `docs/README.md`, two sections only**

§ Where the Project Is: "(S1 → S5)" becomes "(S1 → S7)"; the S5 table row is replaced by `S5 | Team Server — see the roadmap | Planned`, `S6 | Cost Pack — see the roadmap | Planned`, `S7 | Engineering Excellence breadth — see the roadmap | Planned`; the "Recorded direction — not built" paragraph is corrected (the browser client's gateway-client direction shipped in its own repository) and gains one sentence on the recorded direction with a link to `roadmap.md#direction`. § Pricing: the tier table is replaced by the Open Source statement of Task 2 Step 3; the SDK sentence stays; the commercial-licence sentence loses its clause about Team and Enterprise features.

- [ ] **Step 3: `docs/architecture.md` and `.claude/commands/nimbus-architecture.md`**

One phrase each: "(S1 → S5)" becomes "(S1 → S7)". Nothing else (no behaviour changed).

- [ ] **Step 4: `docs/launch-messaging.md`**

Append the section of spec § 5.11 with its exact copy, and add the two lines to § Honesty guardrails.

- [ ] **Step 5: `docs/infrastructure-roadmap.md` and `docs/ecosystem-roadmap.md`**

Infrastructure roadmap: the parenthesis about three roadmaps gains "the file now at `docs/ecosystem-roadmap.md` is a later landscape record (2026-08-02), not that document". Ecosystem roadmap: one line under its Status line saying it has no authority over sequencing and that `roadmap.md` § Direction records the direction taken on 2026-11-12; a pointer at the end of cluster 6 to Phase 28 and at the end of cluster 10 to Phase 29.

- [ ] **Step 6: `docs/CHANGELOG.md`**

A new top entry in the file's existing style: `- **2026-11-12 — Direction recorded: Nimbus as the trust layer for agents.** Docs only — no code, no migration, no new invariant, no new egress class.` followed by what changed (spine re-cut, phases 28 to 30, everything open, the Reach track, five scaffold repositories retired) and what did not (the public headline; no planned row removed).

- [ ] **Step 7: The "Last updated" note in `docs/roadmap.md`**

Prepend one dated entry in that paragraph's style, two to three sentences, linking § Direction and the spine.

- [ ] **Step 8: Verify**

Run: `git grep -n 'S1 → S5' -- '*.md' '*.mdx' ':!docs/CHANGELOG.md' ':!docs/superpowers'` → Expected: no output.
Run: `diff <(sed -n '8p' CLAUDE.md) <(sed -n '8p' GEMINI.md)` → Expected: no output (or only the differences that exist on `origin/main`).
Run: `awk '/^## Where the Project Is/{exit} {print}' docs/README.md | diff - readme-head.before` → Expected: no output.
Run: `git diff origin/main -- docs/README.md | grep '^@@'` → Expected: every hunk header's section context is `Where the Project Is` or `Pricing`.
Run: `git grep -n -i -E 'commercial tier|enterprise tier|team tier' -- CLAUDE.md GEMINI.md docs/README.md` → Expected: no output (spec § 5.7).

- [ ] **Step 9: Commit** (`docs: carry the direction into the status surfaces`)

---

### Task 7: Prove it, strip the working documents, open the pull request

**Files:**
- Delete: `docs/superpowers/**` (this plan and the spec)

- [ ] **Step 1: The row counter**

Run: `bash count-rows.sh docs/roadmap.md > after.txt; join -t$'\t' <(sort before.txt) <(sort after.txt)` and compare per section.
Expected: every section present before is present after with `open` greater than or equal to before; new sections (Direction, Open Source, Reach, Phase 28, 29, 30, the two rejected directions) appear only in `after.txt`; `client-surfaces-rows=6` in both. A section whose heading text changed (Commercial Roadmap, the spine sub-headings) is matched by hand and named in the pull request.

- [ ] **Step 2: Gates**

Run: `bun install && bun run preflight:fast` → Expected: all gates green.
Run: `bun run audit:doc-refs && bun run audit:status-drift && bun run audit:links` → Expected: exit 0 each.

- [ ] **Step 3: Rebase, re-count, strip**

Run: `git fetch origin main && git rebase origin/main`, resolve conflicts by keeping `main`'s text and re-applying this plan's edit to it, then repeat Step 1 and Step 2.
Run: `git rm -r -q docs/superpowers && git commit -m "chore: remove the working spec and plan before the pull request"`
Run: `git diff origin/main...HEAD --stat | grep -c superpowers` → Expected: `0`.

- [ ] **Step 4: Push and open the pull request**

Title: `docs: record the trust-layer direction — agent door next in S4, team server and cost pack on the spine`
Body: what changed; the eight owner rulings by id; what did not change (the public headline, every planned row); the five core documents and why `docs/cli-reference.md` is untouched; the before and after counter output; the list of sections matched by hand. Last lines: the attribution footer.

- [ ] **Step 5: See it through**

Wait for the required checks; answer and resolve every review thread; merge when all ten required checks are green (`gh pr merge --squash --auto`).
