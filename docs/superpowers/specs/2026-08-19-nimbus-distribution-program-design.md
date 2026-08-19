# Nimbus distribution program — users and contributors

> Goal: get Nimbus in front of the engineers it was built for, and turn a
> single-maintainer repository into one other people contribute to.
>
> This spec **extends** [`2026-07-28-launch-plan-design.md`](./2026-07-28-launch-plan-design.md)
> rather than replacing it. That spec covers user acquisition and its three
> blocking gates, which stand unchanged. What it does not cover at all is
> contributors, and that is the larger half of the work here.
>
> It also **finishes** [`2026-07-30-directory-listings-design.md`](./2026-07-30-directory-listings-design.md),
> which is a complete design that was started on 2026-07-30 and stalled part-way
> (see [Section 3](#section-3--durable-surfaces) for its verified status).

## Context — where things actually stand

Nimbus is already published in the literal sense. Verified on 2026-08-19:

| Fact | Value |
|---|---|
| Repository | Public since 2026-04-07, 5 stars, 1 fork |
| Release | `v2.7.0`, published 2026-08-19 13:28 UTC |
| Docs site | Live at [nimbus-agent.dev](https://nimbus-agent.dev) |
| Community | GitHub Discussions enabled, 20 ICP-aligned topics set |
| Contributor infra | `CONTRIBUTING.md`, CLA (ICLA + CCLA), 5 issue templates, 2 discussion templates |
| Issue shelf | 15 open issues, 9 labelled `good first issue` |
| Packaging | `homebrew-tap`, `scoop-bucket`, `linux-repo` — all public, all pushed 13:30 UTC, two minutes after the release |
| Satellites | `nimbus-sdk`, `nimbus-client`, `nimbus-vscode`, `nimbus-web-clipper`, `create-nimbus-connector`, `awesome-nimbus`, `nimbus-raycast` — all public, all at 0 stars |

So this is a **promotion and on-ramp problem, not a publishing problem**. Four
months of building have shipped a large, working product that nobody has been
told about, and whose ecosystem repositories are invisible even to people who
find the main one.

### Findings that changed this design

Three assumptions were checked and did not survive. They are recorded here so
they are not re-litigated:

- **The connector scaffold already exists — twice.** `nimbus scaffold` is a
  registered CLI command (`packages/cli/src/commands/{registry,scaffold}.ts`,
  with tests) and is referenced from `docs/CONTRIBUTING.md`; separately, the
  public `create-nimbus-connector` repository is a standalone generator, pushed
  as recently as 2026-08-19. Building a generator would have been wasted work.
  The real defect is that both are effectively undiscoverable.
- **Fork PRs are already safe.** Every SonarCloud step in `_test-suite.yml` is
  guarded by `env.SONAR_TOKEN != ''`, and `ci.yml` documents the skip on fork
  PRs explicitly. An outside contributor's CI will not go red on a job they
  cannot fix.
- **`@nimbus-dev/mcp` is not published to npm** (404 as of 2026-08-19, while
  `@nimbus-dev/sdk` 1.18.0 and `@nimbus-dev/client` 0.17.3 both are). The
  directory-listings spec calls the official MCP Registry blocked for want of a
  package on a supported registry. That blocker is real, and it is one publish
  away from being gone.

## Goal and non-goals

**Goals.**

1. A stranger can tell what Nimbus is, and see it do something only it does,
   within ten seconds and one command.
2. People who are not the author open, and land, pull requests.
3. Nimbus appears in the places engineers already search for what it is.

**Non-goals.**

- No new product features. As in the launch spec, this is copy, tooling,
  documentation and process only. If a step appears to need a product change,
  stop and escalate rather than expanding scope.
- No telemetry. The opt-in, default-off position is a positioning asset and is
  not revisited here.
- No paid acquisition, no vendor partnership negotiation inside this program
  (see [Vendor asks](#vendor-asks--after-gate-3)).

## The binding decision: two funnels, different tempos

User acquisition and contributor acquisition are different funnels with
different gates, and conflating them is what would make this program stall.

A **user** judges the install one-liner and the first sixty seconds. That path
has failed on all three platforms before (#1167) and is protected by the launch
spec's blocking gates, which stand.

A **contributor** judges the codebase, the development loop, and the issue
shelf. None of that is gated by the install path. Contributor work therefore
**starts immediately**; user channels stay behind Gate 1 (Windows and macOS)
and Gate 2 (private alpha), with Show HN last.

The two interlock in ways worth exploiting: a docs/DX contributor who owns a
Mac can close a Gate 1 leg the author cannot, and early contributors are the
most natural Gate 2 alpha cohort available — already motivated, already
installed, already in conversation.

## Section 1 — The wedge

**The wedge is `nimbus why <file>:<line>`.**

It is the only thing Nimbus does that is simultaneously unique, free of every
prerequisite (no LLM, no API key, no cloud account, no credentials), and
visibly non-obvious within sixty seconds of install. It is also the *proven*
path: the Gate 1 Linux run in a clean container reached real authorship output,
while semantic search stayed unverified because the embedding worker failed to
initialise. Leading with what has actually been proven on a foreign machine is
the honest choice as well as the effective one.

**What it replaces.** The current lead is a category — "On-Call Intelligence
for DevOps, SecDevOps, and Platform Engineering Teams" — followed by
`docs/audiences.md`, which lists six roles. Breadth reassures someone already
convinced and reads as noise to a stranger. The wedge inverts that: one
command, one output, one claim.

**Surfaces that change.**

- `docs/README.md` — the first screen leads with the `why` command and its
  output, ahead of the category sentence, the connector count and the pillars.
  The hero cast already shows exactly this; the copy does not match it yet.
- The `nimbus-agent.dev` landing page — same lead.
- `docs/launch-messaging.md` — gains a "the one thing" section above the three
  pillars, so every channel post derives from one source instead of being
  reinvented per channel.
- `docs/audiences.md` — unchanged in content, moved deeper. Good material in
  the wrong position.

**What does not change.** The ~90 connectors, the fourteen agents, federation,
the egress ledger, the invariants: nothing is removed or hidden, all of it is
resequenced as depth. The wedge is the door; the house stays the same size.

**Recorded trade-off.** Narrowing to `why` under-sells the egress ledger, which
`docs/launch-messaging.md` names as the moat. The position taken here is that a
moat is a *retention* asset, not an *acquisition* one — nobody installs a tool
for a defensibility property they cannot yet evaluate. Egress receipts belong
on the second screen, and they are what makes people stay.

## Section 2 — The contributor ladder

Four audiences, one ladder. Each rung earns the next, and the seeded issues are
what pull people up it.

### Rung 1 — Connector authors (the front door)

Self-contained work, motivated by the contributor's own toolchain, templated by
`runReadOnlyMcpConnector`. Nearly all volume will come from here.

The defect is discoverability, not capability. `nimbus scaffold extension`
requires Nimbus to be installed before it can be found, and
`create-nimbus-connector` sits at 0 stars, unreferenced from the main
repository. Actions:

- Verify the scaffold actually emits every type-coupled registration site a new
  connector must touch. If it does not, closing that gap is the highest-value
  engineering item in this program; if it does, say so loudly in
  `CONTRIBUTING.md` and in every connector issue.
- Reference `create-nimbus-connector` from `docs/README.md` and
  `docs/CONTRIBUTING.md`, and state which of the two generators a contributor
  should reach for.

### Rung 2 — Docs and DX

Cheapest to review, and it buys coverage that cannot otherwise be bought: 65
first-party connectors have no documentation page (already filed as #1002), and
Windows/macOS install verification is precisely the Gate 1 work the author
cannot perform alone.

### Rung 3 — Core gateway

Realistically reached only by someone who has already landed two or three PRs.
Nothing new is built here. `docs/SECURITY-INVARIANTS.md` and the
`nimbus-security-invariants` skill are the on-ramp and they are good. The
framing is "the gates are why this is safe to contribute to", never an apology
for them.

### Rung 4 — Ecosystem and satellites (the side door)

MIT-licensed, smaller surface, no AGPL friction. For people who want to build
*on* Nimbus rather than *in* it. All four satellite repositories are public at
0 stars, which means the door exists and is unmarked.

### The two frictions that will cost contributors

1. **The per-file coverage ratchet** (≥85% line, ≥80% branch, CI-Linux
   authoritative). A newcomer's first connector PR can be rejected by a gate
   they cannot reproduce locally. The floor is not weakened. Instead:
   `CONTRIBUTING.md` names the ratchet explicitly, gives the Docker command
   that reproduces it, and the scaffold's emitted test file clears it out of
   the box.
2. **Response latency.** At a few hours per week, the binding commitment is a
   **published 72-hour first-response target** on new issues and PRs. An
   unanswered first pull request ends a contributor funnel faster than never
   launching at all.

### The top of the ladder is already designed

`.github/rulesets/general-branch.json` carries a `$contributor_two` block: the
exact switches to flip when a second maintainer gains write access (required
approvals 0 → 1, code-owner review, last-push approval, bypass mode, attestation
grace). Publishing what earns commit access is rare and is a genuine recruiting
asset.

## Section 3 — Durable surfaces

Packaging is done and verified; nobody needs to build distribution. The gap is
**listing**, and the design for it already exists in
[`2026-07-30-directory-listings-design.md`](./2026-07-30-directory-listings-design.md)
— complete, honest, with a verified feature matrix, a reusable submission block
and explicit out-of-scope reasoning.

**It was started and stalled.** Its own tracking table, verified on 2026-08-19,
records real progress on 2026-07-30 and nothing since:

| Target | Recorded status |
|---|---|
| README MCP statement | done (#979) |
| Glama | listed and claimed; release pending |
| `punkpeye/awesome-mcp-clients` | PR open (#265) |
| `punkpeye/awesome-mcp-servers` | PR open (#11216), gated on a passing Glama check |
| PulseMCP | email sent |
| `modelcontextprotocol/docs` | dead — list retired |
| Official MCP Registry | blocked — needs a packaging decision |
| mcp.so, wong2/appcypher, Smithery, Tiers 2–4 | not started |

So the work here is **finishing**, not starting: chase the two open PRs to a
verdict, confirm the Glama listing survived the release, and run the untouched
Tiers 2–4. That is the largest block of shovel-ready, engagement-free work
available, and it suits a few-hours-a-week budget better than anything else here.

Three additions to that spec:

1. **Publish `@nimbus-dev/mcp` and take the official MCP Registry off the
   blocked list.** It is the highest-intent discovery surface that exists for
   this product, and the packaging decision it is blocked on is exactly this
   publish. The launcher package exists, is MIT, and has a `bin`.
   **Related documentation defect:** `CLAUDE.md` and `GEMINI.md` both describe
   `packages/mcp-launcher` as "the published `@nimbus-dev/mcp` npm launcher".
   It is not published. Either publish it or correct both files — an
   unpublished package described as published is the same honesty class the
   launch guardrails exist to prevent.
2. **List the first-party GitHub Actions.** `packages/github-actions/`
   (`annotate-action`, `preflight-query`) is built and unlisted on the Actions
   Marketplace.
3. **Wake the satellites.** Cross-link `awesome-nimbus`, `nimbus-raycast` and
   `create-nimbus-connector` from the main README. It costs nothing and makes
   the project read as an ecosystem rather than a single repository.

The directory spec's honesty guardrails carry over unchanged, and the
connector-verification audit (Task 2 of the launch plan) still gates any
connector-count claim that appears in a listing.

## Section 4 — Recruiting and channels

### Contributor funnel — starts now, ungated

**Stock the shelf first.** Fifteen open issues, nine of them `good first
issue`, is not a shelf: a visitor who likes the project finds nothing to do and
leaves. Target 25–30 open, well-specified issues before recruiting begins,
weighted to Rungs 1 and 2. The shape is already known — #1002 and the
connector-index issues (#975, #974, #953, #952, #951) split naturally into a
dozen more. Every one needs an acceptance criterion and a pointer to the
scaffold, or it is a wish rather than a good first issue.

**Then recruit where the contributor's own motivation already lives.** The
connector ask is self-selecting: *"Nimbus doesn't see your Metabase yet — here
is the generator, it takes about an hour."* That works in MCP-ecosystem spaces,
local-first communities, and tool-specific communities, and it works best as
targeted one-to-one outreach to people who have already published an MCP
server — pre-qualified contributors who need no education about the protocol.
Ten to twenty individual approaches beat any broadcast at this stage.

**Hacktoberfest — in scope, ~6 weeks out.** Connector-shaped, scaffold-generated,
self-contained issues are close to the ideal Hacktoberfest work item, and
opting in costs a repository topic. It arrives exactly when the shelf would be
stocked. The cost is spam pull requests; the mitigations are an issue-first
policy stated in `CONTRIBUTING.md`, disciplined labelling, and a willingness to
close low-effort PRs quickly and politely.

**The maintainer-side commitment decides whether any of this works:** the
published 72-hour first response, honoured. At a few hours per week this is the
one thing that cannot slip.

### User funnel — gated, order unchanged

Gate 1 Windows and macOS (human runs still owed) → Gate 2 private alpha (5
testers reach `nimbus why` unaided, 3 still using it at 14 days) → Gate 3
channels in the launch spec's existing sequence: directories → Lobsters →
r/selfhosted → r/devops and r/sre → **Show HN last**.

### Vendor asks — after Gate 3

Ecosystem placement (Section 3) happens now because it is self-serve and needs
no relationship: the MCP Registry and MCP lists (Anthropic ecosystem), VS Code
Marketplace, Open VSX, the GitHub Actions Marketplace and winget (Microsoft
ecosystem), and Gemini CLI extension surfaces (Google ecosystem — `GEMINI.md`
is already maintained).

Direct asks — startup credits, partner programs, developer-relations
amplification — go last, once real usage and third-party listings exist to
point at. A cold approach from a 5-star repository spends a first impression
that cannot be spent twice. Verify each programme's current terms at the time
of asking rather than pre-baking them into this plan; the directory spec
deliberately scoped partnerships out as tracked separately, and that holds.

## Section 5 — Measurement, honesty, and stop conditions

### Signals

The no-telemetry constraint means every signal is external and weak in a known
way. The launch spec's table covers the user side. The contributor side is
better instrumented, because GitHub records it for free:

| Signal | Why it matters | Weakness |
|---|---|---|
| PRs opened by non-maintainers | The only unfakeable proof the on-ramp works | Lags recruiting by weeks |
| Of those, PRs merged | Separates "people try" from "people succeed" | Small numbers stay noisy |
| Median time-to-first-response | Most under the maintainer's control; top cause of funnel death | Tempting to measure only when it flatters |
| Returning contributors (second PR) | The contributor equivalent of retention | Very slow signal |
| Claim rate on `good first issue` | Early read on whether the shelf holds the right things | Claims without follow-through are common |

Stars and traffic are reported and are explicitly **not** targets.

### Honesty guardrails

Carried through every surface this program touches, unchanged:

- The `why` hover UI is never described as shipped.
- The egress ledger records the agent's **dispatched actions** at the `I29`
  executor chokepoint — never raw network traffic, never "every byte". It is
  not a firewall and not host DLP.
- The telemetry position is stated proactively in the words already fixed in
  `docs/launch-messaging.md`, never as the absolute "Nimbus has no telemetry".
- No connector count enters launch copy that the connector-verification audit
  does not support.

The audience being recruited will audit these claims. Being caught once costs
more than the program earns.

### Stop conditions

Decided now, while it is cheap to be honest:

- **Thirty days of contributor recruiting with zero outside PRs** → the on-ramp
  is broken, not the recruiting. Stop recruiting and fix the first hour.
- **Gate 2 fails with hand-picked friendly testers** → a public launch would
  have failed too. Fix the product; do not open Gate 3. This is the gate doing
  its job.
- **Time-to-first-response slips past a week twice** → the program is over
  budget. Cut scope — drop a channel, defer Hacktoberfest — rather than
  accumulate an unanswered queue.

### What success looks like at 90 days

- **Users:** the launch spec's bar, unchanged — a double-digit number of
  engineers who installed Nimbus, reached `nimbus why`, and returned to it in a
  later week.
- **Contributors:** three to five merged pull requests from people who are not
  the author, at least one of whom came back for a second. One repeat outside
  contributor is worth more than fifty stars, and is the only evidence that the
  ladder in Section 2 functions.

## Sequencing summary

| Order | Work | Gated by |
|---|---|---|
| 1 | Wedge copy pass (README, landing, launch-messaging, audiences) | — |
| 2 | Contributor on-ramp: scaffold verification, scaffold discoverability, ratchet documentation, 72-hour response commitment | — |
| 3 | Stock the issue shelf to 25–30 | — |
| 4 | Finish the directory-listings spec (chase 2 open PRs, confirm Glama, run Tiers 2–4); publish `@nimbus-dev/mcp`; list the Actions; cross-link satellites | — |
| 5 | Contributor recruiting: targeted outreach, ecosystem communities | 2, 3 |
| 6 | Hacktoberfest opt-in | 3, 5 |
| 7 | Gate 1 Windows and macOS | — (can run in parallel; contributors may close a leg) |
| 8 | Gate 2 private alpha | 7 |
| 9 | Gate 3 user channels, Show HN last | 8 |
| 10 | Direct vendor asks | 9 |
