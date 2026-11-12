# Ecosystem direction — Nimbus as the trust layer for agents (roadmap, positioning and org changes)

Status: DRAFT, awaiting the builder check and Antigravity review. Owner rulings (§ 2) are binding; do not reopen them.

This is a documentation and organisation project. It builds no product capability. It records the
owner's direction decisions of 2026-11-12 in the documents that own them, across every repository in
the `nimbus-agent` organisation, and it adds the roadmap rows that three later projects (the agent
door, the team server, the Cost pack) will each design in their own spec.

## 1. Goal

After a sweep of every roadmap in the organisation (21 repositories) and a market scan, the owner
decided what Nimbus leads with, what order the next work takes, and what the organisation looks like.
Today those decisions exist only in a conversation. This project writes them down where each one is
authoritative, fixes the facts that had drifted while nobody was reading across repositories, and
leaves every planned phase in place.

What the sweep found, in the numbers that motivated the decisions (verified 2026-11-12; they decay):

- The main repository took 257 commits in the previous 30 days and has cut 269 releases. The
  organisation has 8 stars in total and three outside pull requests, all in November 2026.
- The client surfaces had not released for five to eight weeks (`nimbus-vscode` v0.23.0 on
  2026-10-04, `nimbus-web-clipper` v0.11.0 on 2026-10-08, `nimbus-client` v0.18.0 on 2026-09-18)
  while the gateway shipped all of S3 and most of S4. `docs/roadmap.md` § Client surfaces still
  lists the browser client as "not yet built" at v0.2.0 and the editor extension at v0.12.0.
- The model door offers 108 connector writes behind a typed preview. An outside MCP client can
  propose 47 action types, through `nimbus captures accept` and then the executor's prompt, and is
  shown no before-state (`connectors/proposable-actions.ts`, `mcp-sink/capture-act.ts`).
- No container, Helm chart or service unit exists in the repository, and the Vault has no backend
  that works without a logged-in session keyring (`packages/gateway/src/vault/`).
- The owner uses Nimbus occasionally. Nobody else relies on it.

Acceptance criteria for this project (all are checks on documents and repository state):

- **(ED-a)** `docs/roadmap.md` carries a Direction section; the spine table shows S4 with the agent
  door, then S5 Team Server, S6 Cost Pack and S7 Engineering Excellence breadth; three new phase
  sections exist (9.8, 28, 29), each with rows and acceptance criteria; the commercial tier table is
  gone and no sentence says a capability is commercial-only; § Client surfaces matches the
  satellites' released state.
- **(ED-b)** No planned row disappears. A script counts unticked rows per phase section before and
  after; every section from Phase 7 to Phase 27 has a count greater than or equal to its count
  before, except where a row was re-homed, and each re-homed row keeps its text and points at its
  new home (the roadmap's existing convention).
- **(ED-c)** `CLAUDE.md` and `GEMINI.md` agree with the roadmap on the S4 exit condition and the
  spine. `bun run preflight:fast`, `audit:doc-refs`, `audit:status-drift` and `audit:links` are green.
- **(ED-d)** `ECOSYSTEM.md`, the organisation profile, `awesome-nimbus` and `nimbus-security` state
  facts derived from code at merge time (invariant range, schema version, connector count, the
  repository list) and link to no path that does not exist.
- **(ED-e)** Each satellite roadmap states its part of the direction, and `nimbus-mcp-servers` has a
  `ROADMAP.md`.
- **(ED-f)** The five scaffold repositories are archived, each with a README note naming the
  roadmap row that replaced it, and no live document links to one as a live project.
- **(ED-g)** `docs/README.md`'s headline, the docs-site hero, the GitHub repository description and
  the store listings are unchanged by this project (see D-ECO-1).

## 2. Owner rulings

All eight were given by the owner on 2026-11-12, as picks in three question forms.

- **OR-ECO-1 Goal: widely used open source.** Adoption is the goal; money is secondary. Not "a
  funded business" and not "adoption first, then business".
- **OR-ECO-2 The owner does the non-code work.** Within three months the owner will post and reply
  in public, talk to five to ten early users, and pay for code-signing certificates and registry
  hosting. Those items are no longer parked.
- **OR-ECO-3 A team server: yes.** An always-on, self-hosted server a whole team shares. There is
  still no Nimbus-operated cloud.
- **OR-ECO-4 Lead: the trust layer for agents.** Private context in, approved actions out, proof of
  everything, for any agent (Claude Code, Codex, Cursor, a chat bot). On-call, cost and developer
  work become packs on top. This replaces "on-call intelligence" as what Nimbus leads with.
- **OR-ECO-5 No cuts.** Shown four bundles of proposed cuts (the consumer and ambient phases 18 to
  20, the research arc 21 to 27 with 15 and 25, the Phase 11 extras and the iOS app, the commodity
  connector rows and the S4 stretch rows), the owner approved none. Every planned phase and row
  stays. The work is to add and to re-order.
- **OR-ECO-6 Archive the five scaffold repositories:** `nimbus-connector-registry`,
  `nimbus-recipes`, `nimbus-raycast`, `nimbus-statuspage`, `nimbus-postmortem`. Status-page and
  post-mortem drafts become gateway commands in the Ops pack.
- **OR-ECO-7 Everything open.** The commercial tier table is removed. The team server, SSO, policy
  and audit export ship in the open core. One line offers sponsorship and paid support.
- **OR-ECO-8 The agent door is the next item inside S4.** S4's exit condition of 2026-11-04 grows
  by one. The agent door is built next; the remaining S4 rows follow it.

Shown to the owner in the proposal and not contested, but not separately ruled: after S4, the team
server with the Ops pack comes next, then the Cost pack. Recorded as D-ECO-3.

## 3. Decided by me (recorded so review and the owner can challenge them)

- **D-ECO-1 The public headline changes with the capability, not before it.** `docs/README.md`'s
  headline, the docs-site hero, the repository description, the store listings and the MCP Registry
  description keep describing what ships today. They change in the release that ships agent door
  v1. `docs/launch-messaging.md` gains the new copy now, under a heading that says it is not yet to
  be advertised. This follows the file's own guardrail ("never describe an unbuilt surface as
  shipped").
- **D-ECO-2 Numbering.** The agent door is **Phase 9.8**, directly after Phase 9.7, because it
  completes what 9.7 started; fractional phases have precedent (9.5, 9.7, 12.5, 13.5). The team
  server is **Phase 28** and the Cost pack is **Phase 29**, appended after Phase 27 as § How to
  Update This Document requires.
- **D-ECO-3 Spine.** S4 keeps its theme and gains the agent door. **S5 becomes the Team Server**
  (with the Ops pack riding on it), **S6 the Cost Pack**, and the present S5, Engineering Excellence
  breadth, becomes **S7** with its contents unchanged. "Carried into S5" is renamed "Carried into
  S7" and every pointer to it follows.
- **D-ECO-4 Rows are pulled by reference, never moved.** Phase 28 and Phase 29 name the existing
  rows they build on (Phase 12 deployment rows, Phase 16 Wave 1, Phase 10 Stretch FinOps rows,
  Phase 9 Wave 4). Each source row keeps its text and gains a pointer. New rows are marked `[NEW]`.
- **D-ECO-5 Principle 7 names all three audiences.** "Built for professionals" stays. Its lens
  widens from "an on-call engineer, platform engineer, or security practitioner" to engineers who
  build and run production systems: developers, DevOps, SRE and platform engineers, FinOps
  practitioners and security practitioners. The sentence that consumer-oriented affordances are out
  of scope is unchanged; Phases 18 to 20 keep their present late position.
- **D-ECO-6 What "everything open" touches, exactly.** The § Commercial Roadmap table and its
  pricing paragraph are replaced by a short § Open Source section. Phase 12's goal sentence stops
  saying deployment and compliance tooling are commercial. Paid support and an SLA remain as a
  service the maintainers may offer, and the sentence that a commercial licence is available to
  organisations that cannot use the AGPL stays, because that is a licence fact and not a feature
  tier. The **Verified Publisher tier** row and the owner's open item about its pricing are left
  untouched: they describe a fee for a verification service, the owner did not rule on it, and
  changing it is the owner's call.
- **D-ECO-7 `docs/ecosystem-roadmap.md` is retired for real.** `docs/roadmap.md` and
  `docs/infrastructure-roadmap.md` both say it closed on 2026-07-24, yet a file of that name, dated
  2026-08-02, is on `main`. Each of its eleven clusters is checked against the tree; a cluster that
  is still open becomes a roadmap row or a pointer on an existing row (cluster 10, "Nimbus beyond
  one laptop", goes to Phase 28); then the file is deleted so one document owns sequencing.
- **D-ECO-8 `nimbus-security` stops copying the catalogue.** It keeps the disclosure policy and a
  short description of the model, and links to the gateway's `docs/SECURITY-INVARIANTS.md` for the
  list. A hand-copied catalogue is what went stale (it says I1 to I30 and schema V44).
- **D-ECO-9 Reach targets are aspirations, written down so they can be missed.** 90 days after the
  public launch: ten alpha users of whom five still use it after two weeks, 500 stars, 25 issues or
  discussions opened by people other than the owner, five merged outside pull requests, three
  third-party packages in the registry.
- **D-ECO-10 Packs are role packs.** "Pack" means the shipped role-pack mechanism (I47,
  `nimbus pack`) plus starter packs in the registry. The DevOps and PM packs exist. Ops is the
  DevOps pack extended; Cost and Developer are new packs. No new mechanism.
- **D-ECO-11 The two editor and browser clients keep their direction.** Their roadmaps get fact
  corrections and the rows the agent door needs from them. Nothing is parked or removed there.
- **D-ECO-12 Three scaffolders stay three for now.** `create-nimbus-connector`,
  `@nimbus-dev/create-connector` and `nimbus scaffold` overlap. This project records the overlap as
  one open row and decides nothing.

## 4. Non-goals

- **No product capability.** The agent door, the team server and the Cost pack are each designed in
  their own spec when their slot opens. This project writes their roadmap rows and acceptance
  criteria only, and § 5.3 to § 5.5 list what each later spec must decide.
- **No phase or row is removed** (OR-ECO-5).
- **No public headline change** (D-ECO-1).
- **No change to a non-negotiable or an invariant.** The later specs name the invariants they touch.
- **No change to the in-flight Phase 10 specs** (`2026-11-12-incident-engine.md`,
  `2026-11-12-finops-connectors.md`, `2026-11-12-lan-forward-secrecy.md`). This project points at
  them and does not restate or alter their rulings.
- **No telemetry change**, no new metric collection.
- **No decision on the Verified Publisher fee, the scaffolder overlap, or `nimbus-benchmarks`.**

## 5. Design

### 5.1 The Direction section (new, at the top of `docs/roadmap.md` after § Guiding Principles)

About sixty lines. It says, in this order:

1. **What Nimbus is for.** Nimbus is the trust layer between AI agents and engineering systems. An
   agent, Nimbus's own or any other, gets private context from the local index and acts only
   through a gate where the owner sees a typed preview and approves it; every action it dispatches
   is recorded in a hash-chained ledger the owner can check. It runs on one engineer's machine or
   on a server a team owns.
2. **Why this lead.** Nimbus does not control model quality and should not compete on it. What it
   has that others do not is the index, the gate, the ledger and the sandbox. The agents people
   use every day are coding agents and chat bots; making those safer and better informed is worth
   more than a better built-in agent.
3. **Who it serves.** Developers (their coding agent gets context and a safe way to act), DevOps,
   SRE and platform teams (a team server that holds the production credentials, answers in chat and
   takes approvals there), FinOps practitioners (cost joined to the deploy, the pull request and
   the owner).
4. **The shape.** Five named parts, each mapped to what exists:
   - *Core*: index, consent gate, egress ledger, sandbox. Shipped.
   - *Doors*: terminal, the agent door (MCP), chat, editor, browser, desktop. The agent door is
     partly shipped (21 read tools; a write door for 47 action types).
   - *Packs*: Ops, Cost, Developer. The role-pack mechanism is shipped; Ops is in flight.
   - *Shapes*: a personal gateway (shipped) and a team server (planned).
   - *Ecosystem*: registry, SDKs, connectors. Mechanisms shipped; the public registry is not live.
5. **Order.** A three-line now / next / later that points at the spine table and § Reach.
6. **Honest bounds.** The gate guards what passes through it. An agent that holds its own
   credentials can act outside it. The ledger records dispatched actions, not raw traffic.

Every statement about something unbuilt uses the future tense or the word "planned". `audit:status-drift`
gets no new derived claim from this section.

### 5.2 The spine after this project

| Spine | Theme | Contents | Change |
|---|---|---|---|
| S4 (active) | Autonomous Agent | As ruled 2026-11-04, plus Phase 9.8 (agent door), built next | exit condition gains one item (OR-ECO-8) |
| S5 | Team Server | Phase 28; the Ops pack's always-on half | new (OR-ECO-3, D-ECO-3) |
| S6 | Cost Pack | Phase 29 | new (D-ECO-3) |
| S7 | Engineering Excellence breadth | exactly the present S5 | renumbered |

The S4 exit-condition paragraph under § Active gains: "Phase 9.8 (the agent door), built before the
remaining S4 rows (owner ruling OR-ECO-8, 2026-11-12)". Work already in flight under S4 (the
incident engine, the FinOps connectors, LAN forward secrecy) is not interrupted; the agent door is
the next project to *start*.

§ Reach (5.6) runs beside the spine. It is the owner's track and is not a spine slot.

### 5.3 Phase 9.8 — The Agent Door (rows this project adds)

**Goal.** Any MCP client reaches the same guarded writes as Nimbus's own model, under the same
rules, with one approval step.

Rows (all `[ ]`, all `[NEW]` unless noted):

- **Write parity with the model door.** Every connector write the model door offers is proposable
  by an MCP client, under the same eligibility (the service enabled to that wave, the row approved
  by name, policy allowing it), the same refusals, and the same never-offered list. A row the door
  cannot present in full is refused with a named reason, never shown in part.
- **The same prompt.** The approval shows the typed preview, the before-state, the bound diff or
  plan, and takes the typed confirmation for a Wave 4 row, exactly as the model door does, with the
  proposer in an unverified block.
- **One approval step.** A proposal is approved or denied in one owner action on a trusted local
  surface, without a separate accept command first. The queue of waiting proposals is listable.
- **Agent kits.** One command installs the Nimbus MCP server into a named agent (Claude Code,
  Codex, Cursor and VS Code first), writes that agent's own rules steering destructive commands to
  the door where the agent supports such rules, and a status command verifies the install. Each kit
  states what the agent can still do outside the door.
- **MCP revision 2026-07-28.** The server adapter serves the stateless revision and keeps serving
  older clients. The standalone connectors' consent path, which uses elicitation, gets its
  successor in `nimbus-mcp-servers`.
- **User MCP servers through the door.** An owner-registered MCP server's tools reach outside
  agents through Nimbus, sandboxed and approved per call (I42). Includes the carried-in *User-MCP
  write grants* row (re-homed by pointer).
- **Proof for agent actions.** `nimbus prove` and the audit views report agent-door actions by
  proposer and outcome.
- **Bounds stated in the product.** The README, the security page and each kit say what the door
  does not guard.

Acceptance criteria (for Phase 9.8, to be met by its own spec):

- With a write enabled and approved, an MCP client proposes it and the owner is shown the same
  preview the model door renders for the same input, asserted on the rendered text.
- A Wave 4 proposal is denied without the exact confirm text, on every approval surface.
- From proposal to dispatch takes one owner action.
- The whole path works with no model configured in Nimbus.
- Every dispatch has one egress row and one audit row that name the door and the proposer.
- At least two kits are verified against the real agent, and the result is published as a matrix.
- The invariants it touches are amended under the triple rule (wiring, docs, test in one commit).

What the Phase 9.8 spec must decide (not decided here): how the act door's executor gains the
before-state, guard and bound-prepare steps it lacks today; which surface answers first (terminal,
desktop, chat) and what the desktop app needs on the Tauri allowlist (I7); whether the door stays
default-off and what the opt-in is; where the kits live; what re-approval a changed tool definition
needs. Invariants in play: I2, I3, I20, I28, I29, I42, I53, I54.

### 5.4 Phase 28 — The Team Server (rows this project adds)

**Goal.** A Nimbus that a team runs on its own server: always on, no desktop session, production
credentials held in one place, questions and approvals in the team's chat.

Pulled by reference (rows keep their text where they are, D-ECO-4): Phase 12's *Docker image*,
*Helm chart* and *Air-gapped bundle*; Phase 16 Wave 1's `nimbus serve --team`, signed team baseline
and `team join`; ecosystem-roadmap cluster 10.

New rows (`[NEW]`):

- **A sealed Vault backend.** Works with no session keyring. Selected only by explicit
  configuration, never as a fallback. The key comes from the platform's secret store; the server
  starts locked until it has it. Nothing is stored in plaintext.
- **Team credentials and a team profile.** Service accounts and bot tokens; personal connectors
  (mail, calendar, personal drives) are off on a server unless the operator turns one on.
- **Always-on intake.** Alert and deploy webhooks arrive at the server and produce pushed briefs in
  chat (builds on the incident engine's alert sources).
- **Approvals in chat under policy.** The shipped typed-confirmation cards, plus a rule for who may
  approve what.
- **A remote agent door.** Team members' agents reach the server's door over the network, each as
  an identified user; the credential never leaves the server.
- **A pull-request check.** The shipped GitHub Actions against the team server.
- **Laptop and server together.** A personal gateway treats the team server as a federation peer;
  personal data stays on the laptop.
- **Service artifacts.** Container image, Helm chart, compose file and service unit, published with
  each release and exercised by an install smoke test.

Acceptance criteria (for Phase 28):

- On a fresh Linux host with no keyring and no display, the documented container start reaches a
  first answered chat question within 15 minutes, and CI exercises that path on each release.
- No credential is readable at rest without the unseal key, proven by a test; a restart without
  the key leaves the server locked.
- An agent on a laptop that holds no production credential completes a guarded write through the
  server after an approval in chat, and the server's ledger records it.

What the Phase 28 spec must decide: the network posture (I5, I6, I13 and I45 all assume loopback
today), identity for remote callers, the sealed backend's key handling, and what the server refuses
to index. Standing constraint carried from the ecosystem roadmap: no approval behind a browser page.

### 5.5 Phase 29 — The Cost Pack (rows this project adds)

**Goal.** A FinOps practitioner or a platform engineer can ask why spend moved and get the deploy,
the pull request and the owner, from data that stays on their machine or their team's server.

Pulled by reference: Phase 10 Stretch's *FinOps connectors* (in flight, `2026-11-12-finops-connectors.md`,
FO1 to FO6), *Cost anomaly detection*, *Cloud cost "garbage collection"* and *Data FinOps
attribution*; Phase 9 Wave 4's usage and spend rows and its *AI cost watcher*.

New rows (`[NEW]`):

- **Raw cloud billing intake.** FOCUS-format exports and the three clouds' billing data. (The
  FinOps connectors spec names this a non-goal and assigns it to the detector row.)
- **The cost-to-change join.** A cost series bound to a service, so a spike can be set beside the
  deploys, pull requests, flag changes and owners around it. The binding convention is an owner
  decision that the FinOps connectors spec left open; the Phase 29 spec asks it.
- **`nimbus cost` briefs.** Summary, why, owners and waste, deterministic, with no model required.
- **Cost in the approval.** The infrastructure apply preview shows the plan's cost change.
- **A FinOps role pack** in the official registry.
- **Cost in the demo.** The seeded demo organisation gains cost data, so the join can be shown with
  no credentials.

Acceptance criteria (for Phase 29):

- On the demo corpus, the why brief names the deploy, the pull request and the owning service for
  a seeded spike, with no network call.
- On a real billing export and a synced code host, the same.
- The cost briefs add no egress row.

### 5.6 The Ops and Developer packs, and § Reach

**Ops pack.** Phase 17 and Phase 10's incident rows, already being built under
`2026-11-12-incident-engine.md` (IC1 to IC10). This project adds one row to Phase 17 Wave 4,
*Status page draft* (`[NEW]`, from the archived `nimbus-statuspage`): a static page of current
incidents, who is on call and the DORA scorecard, generated from the index. The archived
`nimbus-postmortem` maps to the existing *Post-mortem generation* and *Auto post-mortem* rows; no
row is added. § Client surfaces drops the three scaffold rows and says where each went.

**Developer pack.** The existing brief agents reached through the agent door, Phase 10's
*Automated PR pre-review* row, and the editor extension's `why` lens. One `[NEW]` row under Phase
9.8: a Developer role pack.

**§ Reach (new section, beside § First-Run & Time-to-Wow).** The owner's track (OR-ECO-2). Rows:

- Signing certificates bought (Apple Developer Program; Windows code signing).
- The signed desktop release and a working auto-update (Phase 13's rows, pulled by reference).
- `registry.nimbus-agent.dev` live with the official packs (the existing owner item, by pointer).
- A private alpha: five to ten engineers, each watched through a first run, findings filed as
  issues, a follow-up after two weeks.
- The positioning switch, in the release that ships agent door v1 (D-ECO-1).
- The public launch: the owner's post and replies, with the agent-door demo on the demo data.
- Listings: each agent's plugin directory, the MCP Registry entry, the curated lists.
- The targets of D-ECO-9.

### 5.7 Everything open (OR-ECO-7, D-ECO-6)

- § Commercial Roadmap (the tier table, the commercial-licence sentence and the "New buying
  centers" paragraph) becomes § Open Source: everything Nimbus does is in the open core; the
  maintainers may offer paid support; a commercial licence is available to organisations that
  cannot use the AGPL. The auditor and insurer audiences stay described where Phases 21 to 26
  describe them; the sentences about tiers and pricing go.
- Phase 12's goal sentence loses "Tied to the commercial license tier" and the clause that
  enterprise deployment and compliance tooling are commercial. Its rows are unchanged.
- § Contents and § Status Overview follow.
- `docs/README.md`, `CLAUDE.md` and `GEMINI.md` are searched for tier language and corrected.
- Licence fields are not touched (non-negotiable 6).

### 5.8 Truth pass (facts to correct, each derived at merge time, never copied from this file)

| Where | Says | Source of truth |
|---|---|---|
| `docs/roadmap.md` § Client surfaces | editor v0.12.0; browser v0.2.0 and "not yet built" | each satellite's latest release and its own `ROADMAP.md` |
| `docs/roadmap.md` Phase 7 and 8 | LaunchDarkly, Flagsmith, Semgrep, SonarQube, Wiz unticked | Phase 5 ticks the read side; each row is reworded to say what remains (the write tool) |
| `docs/roadmap.md`, `docs/infrastructure-roadmap.md` | `ecosystem-roadmap.md` retired 2026-07-24 | D-ECO-7 |
| `nimbus-security` | I1 to I30, schema V44 | D-ECO-8 |
| `awesome-nimbus` | monorepo paths for the SDK, client, extension and connectors; I1 to I27; Raycast as a working tool | the repositories that hold them |
| `ECOSYSTEM.md`, profile README | "~80 services"; omit `nimbus-mcp`, `nimbus-trust`; SDK as "TypeScript types" | `bundled-connector-registry.ts`; the repository list; the SDK's three bindings |
| `nimbus-sdk` roadmap | registry design and end-to-end manifest signature unticked | the gateway's Phase 9.5 record; ticked only where the gateway text proves it |

### 5.9 Satellite roadmaps (one pull request each)

- **`nimbus-client`**: rows for the agent methods the client does not type yet, resolve and
  per-item fetch, and whatever the agent door's approval surfaces need.
- **`nimbus-vscode`**: the editor as an approval surface for agent-door proposals; version text
  corrected.
- **`nimbus-web-clipper`**: fact corrections only (D-ECO-11).
- **`nimbus-sdk`**: the truth-pass ticks above.
- **`create-nimbus-connector`**: a row for re-targeting to the `nimbus-mcp-servers` layout, and the
  scaffolder-overlap row (D-ECO-12).
- **`nimbus-mcp-servers`**: a new `ROADMAP.md` with MCP revision 2026-07-28, the cost connectors
  (pointing at the FinOps connectors spec's slices), per-connector READMEs, and a re-measured
  client-support matrix.
- **`.github`**: `ECOSYSTEM.md` and the profile README, including the planning table (no separate
  ecosystem roadmap) and the archived repositories.
- **`awesome-nimbus`**, **`nimbus-security`**: as in § 5.8.

### 5.10 Archiving the five scaffolds (OR-ECO-6)

For each of `nimbus-connector-registry`, `nimbus-recipes`, `nimbus-raycast`, `nimbus-statuspage`,
`nimbus-postmortem`: add a README note (what it was meant to be, the roadmap row that replaced it or
that it is not planned, the date), then archive it through the GitHub API. Archiving is reversible
and deletes nothing. It runs last, after the documents that mention the repositories have merged,
and the owner is asked once more immediately before it runs, because it changes what the
organisation shows publicly.

- `nimbus-connector-registry`: superseded by the registry protocol that shipped in the gateway
  (Phase 9.5) and the publishing workflow in `nimbus-mcp-servers`.
- `nimbus-recipes`: no gallery is planned; recipes stay a share kind in the gateway.
- `nimbus-raycast`: not planned.
- `nimbus-statuspage`, `nimbus-postmortem`: § 5.6.

### 5.11 Slices (one pull request each, in order)

| Slice | Repository | Contents |
|---|---|---|
| ED1 | `Nimbus` | § 5.1 to § 5.8 in `docs/roadmap.md`; `CLAUDE.md` and `GEMINI.md`; `docs/README.md`'s roadmap summary only; `docs/launch-messaging.md` (held copy); `docs/infrastructure-roadmap.md` (the ecosystem-roadmap sentence); delete `docs/ecosystem-roadmap.md`. `docs/architecture.md` and `docs/cli-reference.md` are unchanged, and the pull request says why (no behaviour or command changed). This spec is deleted from the branch before the pull request opens. |
| ED2 | `.github` | `ECOSYSTEM.md`, profile README |
| ED3 | `awesome-nimbus` | § 5.8 |
| ED4 | `nimbus-security` | D-ECO-8 |
| ED5 to ED10 | `nimbus-client`, `nimbus-vscode`, `nimbus-web-clipper`, `nimbus-sdk`, `create-nimbus-connector`, `nimbus-mcp-servers` | § 5.9 |
| ED11 | organisation | § 5.10 |

ED1 merges first because the others cite it. ED2 to ED10 are independent. ED11 is last.

## 6. Security analysis

- **No code path changes.** No invariant gains or loses a wiring site, and
  `security-invariants.test.ts` is untouched.
- **Claims are the risk.** The failure this project can cause is a document that says something
  ships when it does not. Guard: every new row is unticked; the Direction section marks each part
  as shipped, partly shipped or planned; the public headline does not move (D-ECO-1); and
  `audit:status-drift` and `audit:doc-refs` run on every slice.
- **The Direction section repeats the two existing honesty bounds**: the ledger records dispatched
  actions and not raw traffic, and the gate guards only what passes through it.
- **Archiving** removes nothing and exposes nothing; two of the five repositories are private and
  stay private.
- **Later specs carry the real analysis.** § 5.3 and § 5.4 name the invariants the agent door and
  the team server will have to amend. The team server is the first design that puts a Nimbus
  listener beyond loopback on purpose; that is stated here so no reader takes Phase 28's rows as
  approval of a network posture.

## 7. Testing and acceptance

- A before-and-after count of unticked rows per phase section (ED-b), committed as a script under
  `scripts/` only if an existing audit cannot express it; otherwise run once and its output quoted
  in the pull request.
- `bun run preflight:fast`, `audit:doc-refs`, `audit:status-drift`, `audit:links` on ED1.
- Each satellite's own CI on its slice.
- After ED11, a search of every live document in the organisation for the five repository names
  finds only the notes that say they are archived.
- ED-g is checked by diff: `docs/README.md`'s first screen is byte-identical before and after.

## 8. Stated bounds

- This project changes what the documents say, not what Nimbus does. The agent door, the team
  server and the Cost pack do not exist when it merges.
- The market facts behind the lead came from a search-based scan, mostly secondary sources, with
  thin practitioner evidence. They motivated the decision; they are not restated in any shipped
  document as fact.
- Version numbers, counts and the invariant range decay. Each is derived at merge time.
- The Reach targets are aspirations, not commitments.
- The owner's "none" on cuts was given against four specific bundles. It is read here as "keep
  every planned phase and row" (OR-ECO-5); a different reading is the owner's to state.

## 9. Review log

(empty)
