# Roadmap Phase 7+ Re-sequence & Idea Injection — Design

**Date:** 2026-06-17
**Status:** Design — pending user review
**Scope:** `docs/roadmap.md`, the `## Planned` section (Phase 7 onward). No code, no schema, no invariants.

## Motivation

`docs/roadmap.md` is exceptionally mature — 27 phases, each with waves, acceptance
criteria, invariants, and "composes-with" cross-links. The problem is **sequencing,
not content**. Read against the two lenses the user chose for this pass —
**time-to-value** and **differentiation/moat** — three structural issues surface:

1. **The deepest-moat work is last (Phases 21–27).** Verifiable Negatives (22), the
   Unexfiltratable Agent (23), Provable Governance (26) are the things a cloud agent
   *structurally cannot do* (a relay vendor *is* the egress, so it can only assert
   non-egress in a PDF). That is the strongest differentiation, parked behind ~14
   phases of connector work — even though several of their *primitives* are cheap (the
   doc itself tags the egress-ledger `nimbus prove` surface as near-trivial and
   duplicates it in Phase 7 Wave 6 **and** Phase 22).
2. **The biggest 2026-model lever is mid-list.** Phase 14 (computer-use, code
   execution, runtime tool-gen, multimodal) is now table-stakes-feasible and is both
   high-time-to-value *and* moat (local computer-use with no screenshots leaving the
   machine). It is mis-placed by ~10 phases.
3. **One linear list conflates two different things** — near-term shippable product
   *and* a long-range research manifesto (the "North-Star M-number" Phases 21–27).
   Mixing them makes the moat look a decade away when its primitives are cheap and near.

This pass **re-sequences Phase 7+ and injects new ideas**; it does not trim the vision
or deep-spec a single phase.

## Lenses (decision criteria)

- **Time-to-value** — soonest visible payoff for a solo engineer using Nimbus today.
- **Differentiation / moat** — what a cloud agent *structurally* cannot do
  (local-first, no-egress, private-context, zero-marginal local compute).

The sweet spot is work that scores on **both**: quick payoff *and* unfakeable.

## Structural decision: overlay, not hard renumber

The doc cross-links phase numbers everywhere ("Phase 14", "Phase 8 security") and the
composes-with notes depend on them. So Track 1 is delivered as a **new Sequencing Spine
overlay section** plus **targeted edits** (pull primitives forward, demote connector
breadth, tag the Research Horizon). Phase *numbers* stay stable. A hard renumber was
considered and rejected as Approach-C-level churn for a doc that is clearly valued and
heavily cross-referenced.

## Design: three tiers

The natural taxonomy is three tiers, not two — there is a middle band that is neither
near-term spine nor pure research.

### Track 1 — The Near-Term Spine (S1–S5)

Ordered for time-to-value × moat. Each increment cuts across today's phase numbers.
`[↑from Phase N]` = pulled forward; `[↓demote]` = pushed back; `[NEW]` = net-new idea.

**S1 — "Local Brain"** (cheap, highest stickiness, pure private-context moat; no new
connectors)

- `nimbus why` / `glossary` / `decisions` / `pre-mortem` / `negotiate` [↑from Phase 7 Wave 5]
- devil's-advocate, agent personas, first-class negation + aggregation queries [↑from Phase 7 Wave 6]
- Ownership graph only, built from already-indexed GitHub/PagerDuty; **defer** the
  Backstage/Cortex/OpsLevel/Port IDP connectors to S5 [↓demote]
- **[NEW] Egress ledger as an always-on primitive + `nimbus prove`** — pulled up from
  Phase 22. The cheap seed of the deepest moat; anchors the "provable boundary" story
  early instead of at phase 22.

**S2 — "Local Compute Fleet"** (the 2026-model lever)

- Isolated/sandboxed code execution; local computer-use loop (HITL-gated, screenshots
  never leave the machine); runtime tool generation; multimodal I/O [↑from Phase 14]
- **[NEW] Overnight sub-agent fleets on zero-marginal local compute** — the safe,
  scoped primitive extracted forward from Phase 27 (standing tier-0 agents under the
  irreversible-boundary + do-no-harm scheduler). Metered clouds cannot match free local
  compute.
- **[NEW] Bring-your-own-frontier-model routing** — model-agnostic dispatch with local
  fallback, so Nimbus rides every model improvement instead of being pinned to one.

**S3 — "Open Surface"** (ecosystem whitespace)

- **[NEW] Nimbus as a local MCP *server*** — expose the private index as an MCP endpoint
  that Claude Code / Cursor / other agents connect *to*. Today Nimbus only consumes MCP;
  flipping it makes Nimbus the private-context backend for the user's whole agent stack.
  Pure moat, pure 2026-ecosystem fit.
- Marketplace registry [↑from Phase 9.5] + extension/plugin maturity.

**S4 — "Autonomous Agent"** (capstone)

- Watch → learn → act loop, proactive SRE automation, `incident-brief` [≈Phase 10 as-is]
- Fold in the **On-Call Copilot** (predict/mitigate/coordinate) [↑from Phase 17] — the
  interactive half of the same loop.

**S5 — "Engineering Excellence breadth"** (demoted commodity; community/marketplace-leaning)

- DORA/metrics connectors, feature-flag connectors [↓from Phase 7 Waves 2–3]
- Security tooling + agents [↓from Phase 8]; ML/AI tooling [↓from Phase 9]
- The deferred IDP/ownership connectors from S1.

Shape: **S1–S3 are moat + 2026 levers (mostly cheap or model-driven); S4 is the
capstone; S5 is fakeable commodity breadth that can lean on the community.**

### Track 2 — Scale & Surface

Productization/distribution; after the spine, much of it parallelizable, none of it
research.

- Desktop Distribution [13], Mobile Companion [13.5] — **independent-slot**: land when
  adoption needs them, not gated behind the spine.
- Enterprise [12] + Compliance Receipts [12.5], Platform Layer / Team-OS [16],
  Cross-Org Federation [15] — commercial/scale band; depends on Phase 6 federation.
- Sovereign Mesh / multi-device + physical [11], Vertical Personas [18], Ambient
  Surfaces [19], Personal & Household Federation [20] — opportunistic expansion
  surfaces; the doc already marks 19 as highest-risk.

### Track 3 — Research Horizon

The North-Star M-number manifesto. Keep the full vision; harvest cheap primitives early.
Each entry keeps its full form **and** gains a one-line "primitive to extract when
ready" pointer.

- Proof Layer / Verifiable Negatives [22] — primitive (egress ledger + `nimbus prove`)
  **already harvested into S1**; full portable per-answer EAF receipt stays here.
- Agent Society [27] — primitive (overnight local sub-agent fleet) **already harvested
  into S2**; full standing agent-org stays here.
- Inert-to-Injection / Unexfiltratable Agent [23], Sovereign Trust Substrate [21],
  Agent Archaeology / Causal Twin [24], Confidential Mesh Compute [25], Provable
  Governance [26] — research frontier; each tagged with a primitive-extraction
  candidate.

**Principle:** Track 3 stops being "phases you reach in a decade" and becomes "a
research frontier whose cheap primitives we harvest early." Extraction is the bridge;
S1 and S2 already demonstrate it.

## New ideas injected (the four [NEW] items, kept in full)

1. **Egress ledger + `nimbus prove` as an early always-on primitive** (→ S1) — harvested
   from Phase 22.
2. **Overnight local sub-agent fleets on zero-marginal compute** (→ S2) — harvested from
   Phase 27.
3. **Bring-your-own-frontier-model routing with local fallback** (→ S2) — net-new;
   rides 2026 model advances.
4. **Nimbus as a local MCP server** (→ S3) — net-new; competitive whitespace, makes
   Nimbus the private-context backend for other agents.

## Implementation: edits to `roadmap.md`

No hard renumber. Overlay + targeted moves:

1. Add a new **"## Phase 7+ Sequencing Spine"** section at the top of `## Planned`
   defining the three tracks and the S1–S5 build order, with `[↑/↓]` provenance pointers
   into the existing phases.
2. Add the four **[NEW]** items as waves in their spine home: egress-primitive → Phase 7;
   fleet + BYO-model → Phase 14; local-MCP-server → a new sub-section near Phase 9.5.
3. Tag the connector-breadth waves (Phase 7 W1–3, Phase 8, Phase 9) as
   **community/marketplace-leaning, demoted to S5** (a short note per wave, not a move of
   the prose).
4. Mark Phases 21–27 as **Research Horizon** with a one-line "primitive to extract"
   pointer each; note the two already harvested (egress → S1, fleet → S2).
5. Flag Phases 13/13.5 as **independent-slot** (not spine-gated).

## Non-goals

- No hard phase renumber; all existing phase numbers and cross-links stay valid.
- No trimming/deletion of the vision (the user explicitly did not choose "trim").
- No deep single-phase spec (the user did not choose "deepen Phase 7").
- No code, schema, invariant, or connector work — documentation only.

## Acceptance

- `## Planned` opens with a Sequencing Spine section defining Tracks 1–3 and the S1–S5
  order.
- All four [NEW] items appear in the doc in their spine home, tagged `[NEW]`.
- Connector-breadth waves carry the demotion/community note; Phases 21–27 carry the
  Research-Horizon label + extraction pointer.
- Every existing phase number still resolves (no dangling cross-links).
- The doc still reads as one coherent roadmap, not two stapled-together documents.

## Post-review revisions (2026-06-17)

Incorporating the Antigravity review (`...-design-review.md`):

- **A — MCP server vs security invariants (fixed).** The S3 local-MCP-server item now
  **defaults to stdio transport (no network port)**; any HTTP/SSE variant must honor I6
  loopback bind + I5 `LanServer` method checks + I10 constant-time pairing-token auth,
  with the write surface staying I13-gated. Captured in the roadmap S3 cell.
- **B — composes-with audit (fixed; surfaced two real issues).**
  1. **Egress-ledger attribution correction.** The spec/overlay originally credited the
     egress ledger to `[↑P22]`. The roadmap actually delivers the egress ledger in
     **Phase 8** (the M7 substrate), with `nimbus prove` (P7 W6) as its read surface;
     P22 only promotes it to portable *per-answer* receipts. Corrected to `[↑P8 / P7 W6]`
     everywhere. Pulling the ledger + `prove` together to S1 also resolves a pre-existing
     P7-reads-P8 ordering oddity.
  2. **Phase 7 Wave 4 was unplaced.** Now explicitly split: knowledge graph /
     automation library / pattern recognition / ADR drafter / living-architecture → S1/S4;
     `nimbus excellence` + dashboard → S5 (they render S5 data); team-policy library →
     Track 2 (Phase 6 policy engine). A "composes-with integrity" note records that the
     overlay breaks no cross-reference (demotions move dependencies later; the one earlier
     promotion — the ledger — only helps downstream phases).
- **C — Research-Horizon scannability (fixed).** Per-phase "primitive harvested" tags
  added at the Phase 22 and Phase 27 headers (the two harvested phases) so a reader
  landing directly there sees what moved, complementing the Track 3 overview table.
