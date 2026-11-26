# Roadmap reorder: phase numbers become the build order (design)

Branch-only working document; it is deleted before the PR (specs never land on `main`).

## Intent

The owner's goal after S4 is **more users** (adoption first, OR-ECO-1). Grow what ONE engineer can do
alone, so Nimbus spreads person by person; team features come later as the business offer. The Team
Server (spine slot S5) felt too big for now. The business is **support and hosting**; everything stays
open (OR-ECO-7 stands, no feature tiers).

The roadmap today has two vocabularies for order (phase numbers and spine slots S1–S7), which the
owner finds confusing. Decision: **the phase number is the build order.** No new slot is ever opened.

## Goals

1. Remove spine slot S5; re-home Phase 29's rows to the phases they came from.
2. Renumber the OPEN phases so their numbers follow the build order, starting at 7.
3. Re-home every leftover open row (open rows in done phases 4–6, `Carried into S7`, Phase 29, the
   Phase 10 stretch rows already moved) to the phase where it now ships.
4. Sweep stale rows in old Phases 7–9 (rows that already shipped under another phase are ticked with
   a pointer, never silently deleted).
5. Make the order explicit and single-sourced: one build-order list near the top of the roadmap.
6. Keep every reference consistent across the repo (docs, skills, code comments, scripts) so no live
   text names an open phase by its old number.

## Non-goals

- No product code changes. Comments and docs only.
- No change to any shipped phase's number or text beyond status pointers.
- No change to the changelog's existing entries (dated history keeps the numbers of its day).
- No new features designed here; "extend where needed" is limited to the rows listed under Extensions.

## Anti-goals

- A reader cannot tell which number a reference means. Every renumbered heading carries
  `(formerly Phase N)`, and the build-order list states the mapping in one table.
- Lost rows. Every open row before the change exists after it (moved, ticked with a pointer, or
  merged with a recorded reason); the plan includes a count check.
- History rewritten. Shipped phases, spine records S1–S4, rulings and the changelog keep their numbers.

## Approaches considered

- **Keep the spine, re-cut new slots** (S5 single-engineer … S8 team): least churn, but keeps two
  vocabularies. Rejected by the owner.
- **Phases only, numbers kept, one ordered list**: one vocabulary, numbers out of order. Rejected by
  the owner: "if we change the order we build, we need to change the phase number".
- **Renumber everything after Phase 6 by ship order** (done phases become 7–11): strict, but rewrites
  ~2,300 references including invariant docs, rulings and code comments. Rejected (owner picked 2).
- **Chosen: done phases keep their numbers; open phases are renumbered in build order from 7, skipping
  the taken numbers 9.5, 9.7, 10, 17, 28.** Only references to open phases move.

## The mapping (owner-approved 2026-11-26)

| New | Phase (old number) | Why here |
|---|---|---|
| 7 | Cost Pack (30) | Smallest; builds on shipped Vantage/Kubecost/OpenCost; a new audience with no new mechanism |
| 8 | Engineering Excellence (7) | Single-engineer parts; the service catalog new 9 and 11 depend on |
| 9 | Security Engineering (8) | New audience; depends on new 8's catalog |
| 11 | AI Engineering Loop (9) | Depends on new 8's catalog |
| 12 | Compliance Receipts (12.5) | Unblocks a work install; depends on new 9 and new 11 |
| 13 | Agent Evolution / AI v2, open rows (14) | More a single user can do |
| 14 | Vertical Personas (18) | Audiences beyond developers |
| 15 | Sovereign Mesh (11) | One person across devices |
| 16 | Mobile Companion (13.5) | Depends on new 15 |
| 18 | Desktop Distribution (13) | Owner: the last step before the team band |
| 19 | The Platform Layer (16), with the Team Server (29) folded in | Team and business band starts |
| 20 | Enterprise (12) | |
| 21 | Cross-Organizational Federation (15) | |
| 22 | Ambient Surfaces (19) | Consumer-leaning |
| 23 | Personal & Household Federation (20) | Consumer-leaning |
| 24, 25, 26, 27, 29, 30, 31 | Research phases 21, 22, 23, 24, 25, 26, 27 in that order | 28 is taken (done) |

Done phases keep their numbers: 1–6, 9.5, 9.7, 10, 17, 28. Old Phase 29 ceases to exist as a phase;
its heading stays as a short pointer section (`Phase 29 — The Team Server → folded into Phase 19`)
only if an anchor is linked from outside the roadmap; otherwise it is removed. Note the collisions:
new 12, 13, 14, 15, 16, 19, 20, 21, 22, 23 reuse numbers that meant other phases before; this is
why every renumbered heading carries `(formerly Phase N)`.

## Structural changes to `docs/roadmap.md`

1. **Build order** — a new section near the top (replacing the forward-looking parts of the Phase 7+
   Sequencing Spine, Track 1/2/3 and the Direction "Order" list): the table above, with the
   dependencies that fix the order (new 9 and 11 need new 8's service catalog; new 12 needs 9 and 11;
   new 16 needs 15; the team band needs new 8's catalog and automation library).
2. **Spine records stay as history.** S1–S4 records under Shipped are unchanged; the Sequencing Spine
   section becomes a short historical note (what the overlay was, 2026-06-17 → 2026-11-26, and that
   the build order now lives in phase numbers). Its Track tables and the S5–S7 rows are removed;
   their content lands in the build order or in the phases.
3. **Phase sections are physically reordered** in the Planned part to follow the new numbers, so the
   document reads in build order.
4. **Status Overview table** lists phases in number order with new numbers.
5. **Phase 29 rows** go to new 19 (Platform Layer) Wave 1 beside the team-server tier, and the
   deployment-artifact row merges with new 20 (Enterprise) Docker image / Helm chart. Phase 29's
   guardrails, "what its spec must decide" and acceptance criteria move with them into new 19.
6. **Leftover open rows** in done Phases 4, 5, 6 and in `Carried into S7` move to the phase where they
   now ship, each with `(moved from Phase N, 2026-11-26)`. Rows owner rulings parked (community
   ratings, install counts, Vantage per-tag) stay where they are with their reasons.
7. **Dependency fixes:** Agent Evolution's dependency on Enterprise policy-as-code moves to the one
   row that needs it (the org-level disable). Mobile's Apple Developer enrollment is noted in the
   owner's open items as needed before new 16, earlier than new 18.
8. **Stale-row sweep in new 8, 9, 11:** rows that shipped elsewhere get `[x]` and a pointer.
9. **Direction section:** the Order list and the audience table point at the new numbers; the team
   server is described as part of the team band (new 19), not a slot.
10. **Rulings recorded:** a dated owner ruling block (2026-11-26): S5 removed; phase number = build
    order; option 2 numbering; the mapping; business is support and hosting; desktop last before the
    team band.

## Extensions (the only new content)

- **The launch opens new Phase 7.** A row: switch the README headline, docs site, repository
  description and listings to the agent-door copy held in `docs/launch-messaging.md` (the Direction
  section says this happens in the release that ships the agent door; that release has shipped).
- **A sweep row in new 8** for anything left of old Phase 7 Waves 5–6 that S1 already shipped.

## Repo-wide references

- Live docs (`docs/*.md` except `CHANGELOG.md`, `packages/docs/**`), skills (`.claude/commands/`),
  `CLAUDE.md`, `GEMINI.md`, code comments and test names (`packages/**`, `scripts/**`): every mention
  of an OPEN phase by its old number is rewritten to the new number. Mentions of done phases are left.
- Ambiguous mentions (e.g. "Phase 12" meaning Enterprise) are resolved by context, one at a time; a
  scripted blind replace is not safe because new numbers collide with old ones. The plan does it in
  two passes: old → placeholder token, then placeholder → new.
- `docs/CHANGELOG.md` gets one new entry for this change; old entries are untouched.
- Gates to pass: `bun run preflight:fast` (doc-refs, status-drift, the roadmap-related audits).

## What is left to the builder

- Exact placement of each leftover open row (follow "where it now ships").
- Wording of the historical note for the spine.
- Whether old Phase 29's anchor needs a pointer stub (check inbound links first).

## Resolved after the builder check (the builder's calls, recorded)

1. **"Open row" for the count check** = a line matching `^\s*- \[ \]`. The plan counts them before and
   after (in the whole file), and counts `- [x]` too; both totals must match, except for rows the
   stale sweep ticks (each ticked one is listed in the PR body).
2. **Gates that read the roadmap:** no structure audit parses phase headings or the Status Overview
   (checked: `scripts/structure-audit/check-doc-references.ts` resolves links and paths only;
   `audit:status-drift` reads invariant/schema ceilings and method lists). `audit:doc-refs` resolves
   `roadmap.md#…` anchors, so it is the gate for broken anchors.
3. **Anchors.** A heading's slug includes its name, so the "(formerly Phase N)" note goes on the line
   BELOW the heading, not in it. Each renumbered heading gets an `<a id="<old-slug>"></a>` alias line
   above it, so old links keep resolving; the few inbound links outside the roadmap
   (`#phase-9--ai-engineering-loop`, `#phase-13--desktop-distribution`, `#phase-29--the-team-server`,
   `#phase-7-sequencing-spine`) are rewritten to the new slugs, and in-roadmap links too. The old
   Phase 29 anchor becomes an alias on new Phase 19 (Platform Layer); no stub section.
4. **Historical text.** Shipped-phase sections, the S1–S4 records, dated progress notes, owner-ruling
   lists and `CHANGELOG.md` keep the number they were written with; where such text names an OPEN
   phase, the first mention in that paragraph gains `(now Phase N)`. Live prose (goals, dependencies,
   rows, Status Overview, Direction, build order, other docs, skills, code comments) uses new numbers.
   Placeholder tokens for the two-pass rewrite are of the form `@@P<old>@@`, so a bare "Phase 7"
   meaning old 7 never collides with new 7.
5. **Leftover rows:** the builder decides each placement by "where it now ships" and lists every move
   (row, from, to) in the PR body for review; no owner pre-approval.
6. **Launch row in new 7:** the held copy exists (`docs/launch-messaging.md` § Direction copy, HELD until
   agent door v1 ships). The row: the owner releases that copy (README headline, docs site, repo
   description, listings); it is an outward-facing act, so the row is the owner's, and the roadmap
   change itself publishes nothing.
7. **Phase 29's guardrails and acceptance criteria** move into new 19 as a "Team server" subsection
   verbatim; where one duplicates a Platform Layer criterion, both stay and the builder notes the
   overlap. No criterion is dropped.

## Fixes from the Antigravity review (2026-11-26)

1. **Placeholder order (binding).** Pass 1 replaces the longest phase tokens first: `12.5` and `13.5`
   (and `9.5`, `9.7`, which stay as they are) before `12` and `13`; a regex with a lookahead
   `Phase 12(?!\.\d)` is used for whole numbers so `Phase 12.5` can never become `@@P12@@.5`.
2. **Client surfaces (binding).** The `Client surfaces` subsection (today under Track 2) moves intact,
   with its anchor, to a top-level section right after **Build order**. Nothing in it is dropped. It
   also gains the two editor/browser rows below (Extensions).
3. **Duplicate rows (binding).** Phase 4's two open rows (`data.import` native picker S4-F6, profile
   switch broadcast S4-F8) already exist verbatim in old Phase 13. They are de-duplicated: the Phase 4
   copies become a pointer line `→ Phase 18 (Desktop Distribution)`, so the count check expects -2.
4. **Row-count rule (binding).** Expected after = before − (rows merged) − (rows deduplicated) − (rows
   ticked by the stale sweep) + (new rows). Every term is listed in the PR body; the check uses that
   formula, not equality.
5. **How to Update This Document (advisory, taken).** Rewritten: the phase number is the build order;
   a new phase is numbered by where it ships; done phases keep their numbers; no spine slots.
6. **Contents, Direction, Status Overview, Active (advisory, taken).** All four are rewritten for the new
   numbers; the Active section says no phase is open and Phase 7 (Cost Pack) is next.
7. **`carried-into-s7` and other moved anchors (advisory, taken).** Every anchor whose section goes away
   (`carried-into-s7`, the spine's Track anchors, `phase-29--the-team-server`) is kept as an `<a id>`
   alias at the new home of its content.
8. **Stale sweep (advisory, taken).** Done systematically for old 7, 8, 9 (e.g. `nimbus why` shipped
   2026-07-24 in S1, `nimbus principles` and siblings checked against the code).
9. **Slug variants (advisory, taken).** Alias anchors are added for both the double- and single-hyphen
   slug of each renumbered heading.

## Extensions decided 2026-11-26 (owner)

- The editor shows agent proposals read-only; approval stays at the terminal (owner: for the near
  future; editor approval may be reconsidered with collaboration features). Recorded in Client surfaces.
- A new row in new Phase 8 (Engineering Excellence): a read-only external agent route for the PR
  pre-review brief, `POST /v1/agents/prereview` under the `agents` token scope, so the browser extension
  can show it on pull-request pages (no write, nothing posted).
- A design-first row in new Phase 8: an HTTP read route for incident records (scope to be decided),
  for the browser extension's alert pages.
