# Nimbus Ecosystem Roadmap

**Status:** landscape, not a commitment · first drafted 2026-08-02 · extended 2026-08-02 with
verified defects, the eleven clusters, and the sequencing rules

This is the fourth roadmap surface, and the only one that looks *outward*:

- [`roadmap.md`](./roadmap.md) — what the product does, phase by phase.
- [`infrastructure-roadmap.md`](./infrastructure-roadmap.md) — what keeps the repo and org healthy.
- [`architecture.md`](./architecture.md) — how the gateway is built.
- **This document** — what surrounds the gateway: the clients, the author toolchain, the
  operator surfaces, and the distribution and trust machinery that turn one binary into an
  ecosystem.

Nothing here is scheduled. Items are recorded so that when a slot opens, the option is already
understood, its prerequisite is already named, and nobody re-derives it from scratch.

## How to read this

Items are grouped into **Track 0** (things already built that need finishing), **Layer 0**
(gateway primitives that unblock everything else), and five outward tracks **A–E**. Each entry
carries a *Needs:* line naming the primitive it waits on, so the tracks can be read in any
order and sequenced later.

The tracks are how items were **found**. The [eleven clusters](#the-eleven-clusters) are how they
should be **built** — each cluster is a spec-sized unit that could carry one design doc and one
implementation plan. Read the clusters to plan; read the tracks to check nothing was dropped.

Read [Verified defects](#verified-defects) first regardless. Several are repairs to claims the
product already makes in shipped documentation, which makes them more urgent than anything in the
tracks.

Two conventions matter:

- **"Shipped but dark"** means the code exists, passes CI, and is reachable by no user. This is
  the single largest category in the ecosystem today, and it is cheaper to finish than to
  rebuild.
- **Effort** is relative (S/M/L/XL) and deliberately coarse. The useful signal is the *Needs:*
  line, not the size.

## Verified defects

Found while deepening the landscape, and confirmed against the tree on 2026-08-02. These are not
proposals. They are gaps between what shipped code does and what shipped documentation says it
does, which puts them ahead of every item below.

### D22 is not the total chokepoint it documents itself as

`I29`'s static rule is a regex on a string literal —
`D22_DISPATCH_RE = /\bconnectors\.dispatch\b/` — while its own comment insists there is "no escape
hatch, no 'approved wrapper' carve-out … Any future shortcut or custom-wrapper bypass therefore
fails this preflight static check immediately."

That is false. A bypass that never types the string passes trivially, and three already ship. Each
resolves a tool off a lazy-mesh tool map and calls `tool.execute()` directly:

| Path | Site | What leaves the machine |
|---|---|---|
| `share.replay` | `ipc/share-rpc.ts:172` | Recipe steps against the **live** mesh, gated only by `isReadOnlyToolId` — from a file a third party sent you |
| ChatOps replies | `chatops/chatops-bot-spawn-call.ts:40` | Every operational reply, including posting answer text into a channel — the most content-bearing egress in the product |
| Team-vault session | `teamvault/connector-session.ts:127` | A federated **peer's** invoke, under shared org credentials |

None appends a ledger row, so a zero-row `nimbus prove` window is not the false-negative-proof
claim `I29` makes. The remedy is not another append site: it is replacing the string match with a
rule confining `.execute(` on a mesh tool map, which will fail on day one against three production
files.

Note also that scheduled connector syncs call `Syncable.sync()` directly and never reach the
executor, so the ledger covers agent-initiated egress only. That caveat must be carried into every
report built on it.

### The share subsystem is disjoint from the ledger

`grep egress` across `share/*.ts` returns nothing, and `share_records` has no `row_hash` /
`prev_hash` columns. The one subsystem whose entire purpose is emitting data off the machine is
invisible to the ledger whose entire purpose is recording what left — so `nimbus prove` can
honestly report zero egress in a window during which the owner approved, signed and published a
share.

The asymmetry runs both ways: `egress.prune` is HITL-gated and leaves a continuing tombstone, while
`pruneExpiredShares` is a bare `DELETE` with no tombstone and no consent. A `source_type='share'`
row appended from inside `createShare` after approval closes both, and lets `prove` say "one signed
artifact left, here is its hash" — a better answer than silence.

### The egress receipt signs a bare digest

`signWindowDigest` signs `UTF8(digest)` only. The window bounds, machine identity, completeness tier
and row count are all **outside** the signature. Tolerable while the verifier recomputes from its
own ledger; not tolerable the moment a receipt travels — and three proposed items make receipts
travel between machines.

The correction is in-tree and free: `ShareBody` in the same repo, signed with the same key by the
same library, already folds `kind`, `createdAt`, `expiresAt`, `redactionSet` and `origin` inside the
canonicalized signed bytes. The receipt needs a `ReceiptBody` of the same shape. This must land
before machine link, because a receipt format is a wire protocol between machines running different
versions.

### Briefs are broadcast to every connected client

`emitBriefWithSynthesis` publishes through `broadcastNotification`, which writes to every session.
So every connected client receives the full markdown and typed findings of every brief any other
client requested. A confidentiality defect no single-client surface can observe — and a
**client-side** correlation fix does not close it, because the data has already been written to the
other sockets.

### Other confirmed gaps

- **Runtime assets resolve against source layout.** Several modules locate assets by walking up from
  `import.meta.dir`, in a binary that ships alone. The `/admin` 503 is the visible, harmless
  instance; the connector spawn path is the one that matters.
- **The author-facing contract validator always passes.** `runContractTests` is invoked without
  `await`, so `nimbus test` can print success before the failure surfaces.
- **Two first-party generators emit mutually incompatible manifests**, and the gateway's rejection
  path points at a command that does not exist.
- **The migration runner has no newer-than-target guard**, so a database written by a later binary
  opens silently against a schema the running binary does not know.

## Track 0 — Shipped but dark

The ecosystem's first job is not to add surfaces. It is to connect the ones that already exist.
Every row below was verified against the tree on 2026-08-02.

| Capability | State | Evidence |
|---|---|---|
| Extension system | `install` copies, hashes, Ed25519-verifies (I16), rows and enables — then nothing ever spawns the entry file | `listExtensions` is consumed only by `ipc/automation-rpc.ts` list/info/remove; every `wrapServerSpec()` call site is first-party or user-MCP |
| Desktop app | Code-complete Tauri app — 8 pages, a 103-method Rust allowlist, `tauri build` runs in CI — that has never shipped a binary | no `build-ui` job anywhere in `.github/workflows` |
| Admin console | `nimbus admin console` prints a URL that returns HTTP 503 on every installed binary | `admin-console` appears in no workflow and in no release build step |
| OS notifications | `NotificationService.show()` delivers nothing, and it is the only implementation — so watchers notify nobody and a pending consent prompt reaches you only if you are looking at the right terminal. The events themselves are persisted before the notify, so this is a reachability gap, not data loss; the drop is now logged as `notification.dropped` rather than being silent | `createUnimplementedNotifications()` in `packages/gateway/src/platform/assemble.ts`, wired in `assemblePlatformServices` |
| Voice subsystem | Ships with no client surface | no CLI entry point |
| Portability layer | `data export/import/delete`, `db snapshot/restore`, recovery seeds, backup manifests and signed deletion records all ship, with no coherent story on top | `packages/gateway/src/db/`, `ipc/data-rpc.ts` |
| Profile isolation | `profile.list/create/switch/delete` ships and is correctly LAN-forbidden, but nothing proves it is an isolation *boundary* | `ipc/profile-rpc.ts` |

The strategic read: a marketplace is not the missing piece. A *runtime* is. Finishing Track 0
converts sunk cost into surface area, and several rows here are repairs to claims the product
already makes.

## Layer 0 — Enabling primitives

Ranked by how many downstream ecosystem items each one unblocks.

| Primitive | Unblocks | State today |
|---|---|---|
| **Extension execution path** — build a `ServerSpec` from an extension row and spawn it through the existing sandbox | the entire third-party author story | absent; the sandbox, manifest parser, integrity chain and a working template all ship |
| **Cross-client HITL queue** — a listable pending-approval set plus approval routing | every "approve from a second surface" idea | `requestConsent` writes to exactly one session; a foreign responder is rejected; no list exists |
| **HTTP agent invocation + resolve-by-URL** — an agents route, and an index on `canonical_url` | every browser, ambient and machine-facing surface | `HTTP_ROUTES` is 11 entries, none of them agents; `canonical_url` is a plain column with no index |
| **Session-correlated brief notifications** | any concurrent server: MCP, chat bot, HTTP route | the awaited-brief adapter exists in `packages/cli` but resolves on *any* matching notification, so two concurrent callers can cross briefs |
| **Inference in the egress ledger** | the truth of `nimbus prove` | the `source_type` discriminator already exists as a ledger column and is already committed to the row hash; it is hard-coded at the build site |
| **Capability discovery** — `gateway.describe`, `agents.list`, and an IPC drift gate | every client currently hard-codes the agent set | absent; dispatch is a hand-rolled fall-through, which has already produced one renderer-allowlisted method with no handler |

A note on the fourth row: it is the cheapest item in this table and the one most likely to be
skipped, because the one-shot CLI it was written for cannot observe the bug. Every concurrent
consumer can. It is now solved client-side by the agents-as-MCP-tools plan; the **gateway** half —
per-caller notification instead of broadcast — is not, and is the confidentiality defect recorded
above.

**This table is mis-ranked, and the correction matters.** Counting how many items each primitive
transitively unblocks:

- **Extension execution path — real leverage zero.** Its three dependents are all independently
  classified do-not-build. It is listed first above because it *looked* like the biggest unlock;
  building it first would be the single largest wasted slot in the landscape.
- **Approval routing — leverage two**, L-sized, and gated on an unresolved consent contradiction
  (see the cross-cutting decisions below).
- Three items filed **outside** Layer 0 out-leverage most of it: the per-profile data root (seven
  downstream, and it converts three L-sized items into buildable ones), the manifest contract
  reconciliation (six), and console packaging (seven views currently have no surface to render
  into).

The real enabling set is: inference-in-the-ledger, per-profile data root, manifest reconciliation,
per-caller brief notification, resolve-by-URL, `agents.list`, the IPC registry, and console
packaging.

## Track A — Customer surfaces

Where the work actually happens, beyond a developer at a keyboard.

- **Nimbus as a callee (MCP server)** — expose the built-in agents as MCP tools, plus a thin
  MIT launcher package so the server is installable as an artifact rather than a gateway
  subcommand. This inverts the usual model: an external agent gets private cross-service
  context and the index never moves. It is also the cheapest distribution available, because
  directory listings are currently unreachable purely for packaging reasons. *Needs:*
  session-correlated notifications. *Effort:* S–M.
- **OS notification delivery** — three platform implementations of `show()`, plus the consent
  hop. This is a human-reachability argument, not a UX one: a local-first product has no push
  channel, so structural HITL depends on it. *Needs:* nothing. *Effort:* S per platform.
- **ChatOps agent commands** — let a chat mention invoke a read-only agent, not just receive
  dispatched replies. *Needs:* session correlation. *Effort:* M.
- **Git and shell integration** — a pre-push hook running impact and conflicts, with a hard
  latency budget and a silent pass when the gateway is down. *Needs:* nothing. *Effort:* S.
- **Ambient browser panel** — resolve the page you are on to an already-indexed item and run
  agents against it; the recorded evolution of the web clipper. *Needs:* HTTP agent route and
  resolve-by-URL. *Effort:* M.
- **Phone surface** — read plus approve, paired rather than exposed. *Needs:* cross-client HITL
  queue, and a delivery channel, or it is a notification product with no notifications.
  *Effort:* L.
- **Desktop release vehicle** — a build job and the signing decision. *Needs:* code-signing
  procurement. *Effort:* M.
- **Meeting and calendar briefs** — currently blocked less by plumbing than by the absence of
  graph edges for meeting-shaped entities. *Effort:* M–L.

## Track B — Author and contributor toolchain

The connector generator is the first item in this track; these are the rest.

- **Extension runtime** — see Layer 0. Everything else in this track is capped by it.
- **Manifest contract reconciliation** — today no manifest shape passes both halves of the
  contract: the SDK validator and the gateway parser disagree on the permissions form, the
  scaffold emits the form the gateway rejects, and the failure path points at a command that
  does not exist. This should be fixed regardless of sequencing, because it silently
  invalidates the author's first run. *Effort:* S.
- **Conformance CLI** — spawn an extension and assert its declared surface. *Needs:* extension
  runtime. *Effort:* M.
- **Cassette recorder** — credential-free fixtures for connector contract tests, with
  share-gate-grade redaction, since the failure mode is a token committed to a public repo.
  *Effort:* M.
- **SDK testing helpers** — and, first, the removal of two stubs that currently let an author
  follow the docs, compile, run, and register zero tools with zero errors. *Effort:* S.
- **Capability discovery and drift gate** — an extracted IPC registry plus a preflight gate.
  Its first pass will surface real drift that must be reconciled rather than suppressed; that
  reconciliation is the actual work. Typed clients for other languages are explicitly deferred
  until a consumer exists. *Effort:* M.
- **Trace and inspect** — scoped to notifications rather than raw frames, and gated on
  redaction, or it becomes the fastest way for a user to paste secrets into an issue.
  *Effort:* M.
- **Paved path** — a starter template, plus wiring the two already-written, already-tested
  author-facing audit scripts into the preflight gate set, plus correcting the stale clone URL
  and phase claims a first-time contributor hits. *Effort:* S.
- **Agent-authoring kit** — open the closed brief union so third parties can add agents.
  A cross-repo type-level change; the listing half is trivial and should not wait for it.
  *Effort:* S (listing) / L (union).
- **Evaluation harness** — regression scoring for agent output quality. *Effort:* M.

## Track C — Operator, buyer and compliance

Nimbus already has federation, signed org policy, OIDC and SCIM, quorum approvals, and an
always-on hash-chained egress ledger. That is an unusually strong substrate carrying almost no
surface. This track is where the architecture becomes a buying reason.

- **Policy simulation and explanation** — replay a candidate policy against the ledger and
  answer "what would this have blocked last week, against actions you actually took," plus
  "which rule decides this and where did it come from." Differentiated in the strictest sense:
  a hosted product can only simulate against what you uploaded. Must call the production
  resolution path, never a parallel reimplementation. *Effort:* S–M.
- **Evidence export** — a signed, offline-verifiable compliance bundle assembled from reads
  that already ship, built client-side so it adds no gateway surface. The framing discipline is
  load-bearing: it must state which control each artifact *partially evidences*, never that the
  bundle satisfies a control. *Effort:* M.
- **Operator console** — package the existing console so it stops returning 503, then add the
  differentiated view: a paged, chain-verified local egress ledger, which is not something a
  hosted console can show you. *Effort:* S (packaging) / M (views).
- **Connector permission review** — declared versus granted versus actually used. *Effort:* S.
- **HITL decision analytics** — evidence that the consent gate is not rubber-stamped, a claim
  only a product with a structural gate can make. *Effort:* S.
- **Incident forensics timeline** — what the agent touched, over a window. *Effort:* M.
- **Fleet attestation** — configuration and version drift across paired machines. *Needs:* a
  new federation answerer built to the leak-proof standard. *Effort:* L.
- **Managed install** — per-machine packaging, policy templates, and device-management
  profiles. *Needs:* config layering, and it forces the signing decision. *Effort:* L.
- **Scoped observer role** — a time-boxed, revocable, read-only grant for the reviewer,
  auditor, contractor or incident commander who should be neither a stranger nor a full peer.
  Must land inside the existing query gate rather than beside it. *Effort:* M.

**A caveat that applies to this entire track.** The egress ledger is appended from the executor
chokepoint, so it covers agent-initiated egress. Any report built on it must say so explicitly,
or it will read as a clean bill of health for traffic it never observed — and a
least-privilege report that recommends revoking scope from an actively-syncing connector is
worse than no report at all.

## Track D — Ecosystem, distribution and trust

- **Offline verifier** — a static page that verifies a signed share, recipe or receipt with no
  backend, no account and no upload, built on an extracted MIT verify package so the verifier
  can never drift from the signer. A recipient who is not a Nimbus user experiences the
  local-first claim directly instead of reading about it. *Effort:* M.
- **Recipe gallery** — plus the missing local replay subcommand, which today is reachable only
  through a command that reads as signature checking. *Effort:* S (subcommand) / M (gallery).
- **Connector registry and health gate** — a generated feed, and wiring the existing unwired
  verification script so nothing can register a connector that reaches nothing. *Effort:* S–M.
- **Starter packs** — signed bundles of watchers, workflows and policy fragments. *Needs:* a
  consent preview that renders a diff rather than an action name; approving a bundle behind a
  prompt you cannot fully inspect is the anti-pattern the HITL rule exists to prevent.
  *Effort:* L.
- **Adopt an existing MCP stack** — detect configured servers in other clients and bring them
  under sandboxing, consent gating and the ledger. The pitch is strong; the cost is owning
  third-party config formats across three operating systems forever, so detect-and-instruct
  beats detect-and-own. *Effort:* M.

## Track E — Lifecycle

The blind spot. Every other track serves someone who already has Nimbus installed, indexed and
connector-authenticated. This track serves before, around, under and beside that.

- **Demo corpus** — a seeded synthetic org in a throwaway profile, so evaluation does not
  require authenticating dozens of connectors and waiting for a sync. Today the differentiated
  agent surface returns empty on first run. This is the cheapest funnel repair available and it
  composes with the profile primitive that is currently unused. *Effort:* M.
- **Appliance deployment** — the repo contains zero container, systemd or launchd artifacts, so
  an entire deployment shape is unrepresented: an always-on box that indexes continuously and
  answers a team. The interesting blocker is real — the OS credential stores all assume a
  logged-in session keyring, so a headless profile needs a deliberately designed fourth vault
  backend, not a plaintext fallback. *Effort:* L.
- **Offline provisioning** — the local embedder is fetched from a third-party CDN on first use,
  so on a machine with no egress, hybrid search silently degrades and there is no supported way
  to pre-provision. This is the highest-irony gap in the tree: the product whose moat is
  provable locality cannot currently complete a local-first first run offline. Wants a model
  bundle as a signed release asset and a doctor check that distinguishes "no model, no network"
  from "model present, running local." *Effort:* M.
- **Backup, restore and downgrade safety** — the local index *is* the product, so "my laptop
  died" and "the update rolled back" are the two failure modes that destroy the moat. A
  verified hazard exists today: the migration runner returns silently when the database version
  is at or above the target, with no guard for a database *newer* than the running binary — and
  a shipped auto-updater can roll back. Wants a fail-closed newer-than-target guard, a
  scheduled backup with restore verification, and a restore drill that proves a snapshot
  actually restores rather than merely existing. *Effort:* S (guard) / M (rest).
- **Machine link** — one person, laptop and desktop. Federation is priced for mutual distrust;
  the same-owner case is the cheapest one and is entirely unserved, leaving that person with
  two divergent indexes and two ledger chains. The one thing that must be designed rather than
  reused is `prove` semantics across two chains. *Effort:* M–L.
- **Migration in** — import an existing corpus from the tools a prospective user already has.
  Composes with resolve-by-URL. Check the item-body indexing cap first, or a large import
  produces a corpus that looks complete and answers badly. *Effort:* M.
- **Profiles as a provable boundary** — per-profile index and ledger chain, plus an isolation
  proof, for the consultant or agency contractually obliged to defend that boundary. Today
  profile separation is a convenience; asserting it as a compliance boundary without an
  enforcement test would be exactly the kind of unwired defense past audits have caught.
  *Effort:* L.

## The commercial surface

The tier table in [`roadmap.md`](./roadmap.md) is feature-gated, which the license makes
structurally unsellable: with an AGPL core and an MIT SDK and client, any withheld feature can
be rebuilt or forked.

What a fork *cannot* self-issue is a counterparty. The defensible commercial surface is
therefore the set of things that require a legally accountable entity, none of which need
closed source or withheld features:

1. **Code signing and notarization** — currently the single blocking procurement decision.
2. **A verified-publisher trust root and the policy signing anchor** — the value is precisely
   that a third party vouched, so a fork's own anchor is worth nothing to an auditor.
3. **Countersigned evidence bundles** — the artifact is self-verifying; an auditor pays for an
   attestation from a named entity.
4. **Indemnity, support SLA and a CVE-response commitment.**

Worth noting that one purchase — the signing certificate — unblocks the desktop release
vehicle, the updater's installer path on two platforms, and the commercial trust story
simultaneously.

## Deliberate non-goals and known traps

Recorded so they are re-decided rather than re-discovered:

- **Do not build the marketplace before the runtime, and do not build either before an author
  is waiting.** Three independent analyses proposed the same extension registry; all three
  under-weighted that a registry does not create authors. The correct interim move is to
  document the extension system as first-party-only and stop paying its author-facing upkeep.
- **Do not make connector registration data-driven.** It reads as hygiene and is a
  ninety-plus-package refactor that walks into the sandbox trust boundary: the gateway's
  duplicate manifest is deliberate, because it is the gateway's own declaration of what a
  connector may reach, not the author's. Reading permissions from the author's package makes
  the sandbox author-declared; pinning them at build time rebuilds the duplication with a
  generator in front of it.
- **Do not generate clients for languages with no consumers.**
- **Do not put the consent gate behind a browser page.** A bearer-token-authenticated approval
  page turns renderer script injection into approve-anything, which is the exact chain class
  the desktop allowlist was tightened against. Read-only pending counts are fine; approval
  stays where it can be trusted.
- **Do not route a support bundle through the share gate.** It buys an approval prompt nobody
  wants on a support command and implies share-grade redaction guarantees. A plain file with a
  golden test asserting no secret survives is the better shape — and that test is the feature.

## The eleven clusters

The tracks above are a catalogue. These are the buildable units — each one delivers value on its
own, is one design conversation rather than five, and keeps together the items that must ship
together. Ordered by value over cost-plus-risk.

Four of the top five are **repair, not addition**. That inverts the instinct the tracks were
written with, and it is the most useful single output of this exercise.

### 1 — What we ship is what we claim

*A person who installs the released binary gets a gateway that can sync, embed and serve its own
console — and every remaining sentence of user-facing documentation describes something that
exists.*

One decision (how a `--compile` gateway carries non-code assets) applied to four sites, plus a
subtraction pass over documentation that describes unshipped behaviour. Contains: verify-on-a-clean-
machine; the asset-carrying decision; the console build step in the release workflow, the compile
script **and** the preflight manifest; moving install-smoke outside the repo checkout so CI can
observe the class at all; retracting docs for capability that has no production wiring; and adding
the contributor docs to the status-drift scanner so they cannot rot again.

**Size:** S to verify, M–L to fix — the connector-spawn answer determines which. **Depends on:**
nothing; it is upstream of everything.

### 2 — Data durability: the guards, the schedule, the drill

*The local index — which is the product — survives a version downgrade, a bad restore and a disk
event, and the product can prove it did.*

The newer-than-target migration guard at both entry points including the Worker; a restore that
removes `-wal`/`-shm` in the same operation and refuses if it cannot; post-restore verification that
leaves the original intact on failure; wiring the backup scheduler that ships default-on and has
never run; and `nimbus db drill` — snapshot, restore to temp, verify, compare item count and ledger
head against live, never touch the live database.

**Size:** M, of which the guards are about a day. **Depends on:** nothing. Build this in parallel
with anything; it needs no design conversation, and it is the only work here that protects data
already on users' disks.

### 3 — Provenance completeness

*`nimbus prove` stops omitting the largest continuous egress in the product, and every report later
built on the ledger inherits a true scope claim instead of amplifying a false one.*

The three shipped bypasses above, plus remote inference (embeddings and model calls both leave with
no row), plus the vocabulary: a closed `source_type` union and a completeness **vector** replacing
the scalar tier. Local inference must produce **no** rows, or the ledger is worse than silence. The
`sync_telemetry` join that expresses the scheduled-sync caveat belongs here once, not re-derived by
each downstream report.

**Size:** M. **Depends on:** land after the MCP plan's `D22(c)`, so both chokepoints share one
static-rule shape.

### 4 — The agent invocation seam and its first contextual surfaces

*Any surface — browser, editor, chat, CI, a git hook, an external model — can run an agent against
the thing the user is looking at and get findings back, without a notification channel and without
leaking that brief to every other connected client.*

One seam, six consumers. Per-caller notification replacing broadcast; renaming the misnamed
`sessionId` to `runId`; hoisting the brief router into the shared client so no consumer re-derives
the bug; resolve-by-URL — where the **backfill** is the load-bearing part, since roughly half the
mapping files never set `canonical_url` at all; a synchronous findings-returning HTTP route
intercepted ahead of the write dispatcher so the write allowlist does not grow; a no-synthesis path
that the hook, the route and the MCP callee all want; `agents.list`; then the thin consumers.

**Mandatory precondition inside the cluster:** the ChatOps namespace filter. The namespace argument
is currently discarded, so a chat read in a channel bound to one project already answers from the
whole index — and an agent reply that deterministically names files, PRs and people is a materially
worse leak than a free-text answer.

**Size:** L. **Depends on:** the MCP plan's session-correlation and caller-threading tasks.

### 5 — One contract, one gate

*The declared surface and the real surface agree — manifests, connector health, IPC methods, agent
lists — and CI fails when they drift again.*

Pays off entirely with zero third-party authors, because what it repairs is first-party surface that
is silently wrong today. Pick the normative manifest shape and land it across both repos; the
missing `await`; reject legacy manifests at install with a message naming a command that exists;
delete the stubs that let an author follow the docs and register zero tools with zero errors; fold
conformance into the existing test command rather than adding a sibling; turn on the connector
sandbox tests that have never executed; wire the two already-written, already-tested, unwired audit
scripts; the IPC registry and drift gate; and repair user-MCP permissions, which are hardcoded
deny-all today.

**Size:** L. **Depends on:** nothing.

### 6 — Approval you can act on away from the terminal

*A pending consent prompt reaches the human wherever they are, and can be answered from a surface
that is not the terminal that issued the ask — without weakening the gate.*

Real per-platform notifications behind the platform abstraction (argv arrays, never composed shell
strings — the body is index-derived text); the consent hop as a pointer carrying action type and a
client label only, with a golden test that no payload field can reach it; a read-only pending
listing with no answer path; and the desktop app as the first non-CLI approver, including replacing
the renderer-supplied import path with a native dialog.

Explicitly **no** approve-from-toast in v1: actionable toasts need Windows app-identity registration
and a signed macOS bundle, which would make the approval channel Linux-only.

**Size:** L. **Depends on:** nothing structurally; the publish half depends on code-signing
procurement.

### 7 — Profiles as a real data root, and the demo corpus that proves it

*A second, throwaway Nimbus on the same machine — simultaneously the isolation boundary consultants
need, the seeded demo that makes the agents show real output, and the fixture that makes agent
regressions visible in CI.*

These ship together because without the data root, `nimbus demo` seeds synthetic rows into the
user's real index — a data-loss-grade defect, not a rough edge. Contains the per-profile data root
across both path modules, a profile-suffixed socket so two profiles run at once, the isolation
invariant with its enforcement test, and a corpus whose timestamps are **all** generated relative to
seed time — the agents filter to 90d/3d/24h/48h windows, so a baked-date fixture returns empty
within a week.

Ship an honest statement that the federation-dependent agents return gap notes with zero peers.

**Size:** L. **Depends on:** nothing to start. The isolation claim must not appear in any document
before the enforcement test exists.

### 8 — Policy you can explain, simulate and push

*An operator can see what the policy resolves to, dry-run a candidate against real local history,
and have a managed device place a signed policy the gateway verifies or refuses.*

One escalating conversation about the same object: the explanation is the baseline the simulation
diffs against, and the simulation is the dry-run the provisioning path needs. All three surface the
same defect, which the explanation reports first — one of the five policy dimensions is declared and
enforced nowhere.

Signed-policy provisioning fails closed: a bad signature pins nothing and the gateway stays
ungoverned rather than half-governed.

**Size:** M; the per-machine installer half is L and procurement-gated. **Depends on:** nothing —
and the recorded prerequisite "config layering" is the expensive path to a weaker guarantee than the
signed-policy path that already ships.

### 9 — Reports a buyer can check

*Everything the gateway did is a row in a surface the buyer already has open, and the same reads
serialise into a signed, offline-verifiable bundle a third party can check with no network and no
account.*

The evidence bundle is literally the console's views serialised, so building the reads twice is the
waste to avoid. Contains audit windowing and cursor paging (the export currently returns the newest
rows regardless of the window asked for); the paged chain-verified egress view; HITL analytics with
disjoint buckets and a refusal to compute a single headline number, plus the never-exercised list,
which is the real posture; connector permission review at tool granularity; the forensics timeline;
the evidence bundle with a per-artifact assurance field and wording enforced by a golden test rather
than author discipline; and the offline verifier page.

**Size:** L. **Depends on:** clusters 1 and 3. Building it earlier means serialising a false
completeness claim into a signed bundle.

### 10 — Nimbus beyond one laptop

*A Nimbus that boots on a box with no keyring, no browser and no egress; and several Nimbuses that
know about each other well enough that "prove nothing left my machines" has a defined meaning.*

One conversation about what a Nimbus *instance* is. A fourth vault backend selected **only** by
explicit configuration — never auto-selected, because an implicit fallback is the plaintext-fallback
anti-pattern — with a locked-start state machine; the signed model bundle that makes an offline
first run possible; container, service and launch-agent artifacts; machine link as an owner-scoped
preset that explicitly does **not** merge indexes; and the real content, cross-chain `prove`
semantics: enrolment recorded as ledger rows so unlink-act-relink forces indeterminate, verification
staying local with only signed per-machine receipts travelling, never merging on wall clock, and the
merged answer being the minimum of the per-machine answers.

**Size:** XL. **Depends on:** clusters 7, 2 and 9. Write the cross-chain design down long before
building it, or cluster 9's receipt envelope will be shaped wrong.

### 11 — Meetings as first-class

*Fifteen minutes before a meeting, Nimbus tells you what changed since you last met with the people
in the room — and, once meetings are graph nodes, the why and decisions agents gain an evidence
class they cannot currently see.*

Two waves. The brief first, because it writes and proves the attendee-to-person resolver against
real synced data and needs no schema change; the graph edges second, with a regraph path so already
indexed meetings backfill rather than only new syncs benefiting. Unresolved attendees are reported
as gaps, never silently dropped.

The only cluster that is a **new end-user capability** rather than a repair or a substrate — worth
noting, given everything above it.

**Size:** M for the brief, M–L for the edges. **Depends on:** nothing.

## Sequencing rules

Three rules do most of the work. Everything else is parallelisable — about two thirds of the items
are roots with nothing blocking them, and no live dependency chain exceeds four hops. **The
constraint is ordering-induced rework, not blocking.**

1. **Ledger truth before every ledger report.** Eight items are reports over the egress ledger. None
   is *blocked* by cluster 3 — all are buildable without it. All eight would be **wrong**, and all
   eight would need rework when the completeness vocabulary changes. This is the largest rework
   surface in the graph and the only place where deferring a non-blocking item costs more than
   deferring a blocking one.
2. **Receipt-body before receipts travel.** Machine link, fleet attestation, evidence export and the
   offline verifier all move a receipt beyond the machine that can recompute it.
3. **Reserve the paths-module interface now.** The signature of the two mirror path modules decides
   whether the demo corpus, the appliance and machine link are M-sized or L-sized. Fixing that shape
   costs nothing today and cannot be retrofitted cheaply.

## Cross-cutting decisions to make once

Each of these is invisible from inside any single track, and each will otherwise be decided
accidentally by whichever item ships first.

- **Who owns the `source_type` enum. — DECIDED 2026-08-05, by the repo owner, in the
  agents-as-MCP-tools work.** Five items independently planned to add a value; it is committed by
  the row hash, so the taxonomy is permanent, and the standing instruction was to close the union
  before the first new appender. That first appender was the MCP agent-brief ledger append
  (`egress/agent-brief-egress.ts`), and this is the decision it forced, made once and recorded here.

  **What was decided.** `mcp` was added as the ninth member of `EGRESS_SOURCE_TYPES`, overriding
  #1038's prescription that a ninth class reuse `session` with a reserved `method`. That
  prescription weighed only the marker/non-marker exclusion cost and not **coverage**:
  `COVERAGE_CLASSES` is by definition the set of egress-bearing source types, and
  `THIS_BINARY_COVERAGE` may claim a granularity only for a class whose appender exists.
  `session`'s appenders (telemetry, updater, JWKS) do not exist, so `session` must go on claiming
  `none` — filing MCP briefs there would have recorded them and disclaimed them in the same breath.
  Widening the union is not a chain break: `verifyEgressChain` recomputes each row's hash from that
  row's own stored column values, never from the union's current definition.

  **What the other four claimants must now do.** The union is not open. A new member is a reviewed
  taxonomy change, not an append, and it lands as one commit carrying all six of: the
  `EGRESS_SOURCE_TYPES` member **with its reasoning written into that file's header the way `mcp`'s
  is**; the matching `COVERAGE_CLASSES` entry (the two lists are separate declarations and a
  mismatch is silent — `security-invariants.test.ts` asserts they agree); the
  `THIS_BINARY_COVERAGE` granularity; **the appender itself**; the D22 caller pin; and the
  enforcement test. A claimant whose appender is not landing in the same commit does **not** get a
  member — `session` with a reserved `method` remains the right answer for that case, because a
  class that cannot honestly claim coverage should not be in the coverage vector at all. The
  identity assertion in `egress-source-type.test.ts` is the review checkpoint and must never be
  weakened to a length check. Authority: `docs/SECURITY-INVARIANTS.md` § I29.

  **Accepted cost, already paid.** `parseCoverage` rejects a vector missing a known class by
  design, so a `prove` window spanning a pre-`mcp` and a post-`mcp` binary reads `indeterminate` on
  every class. That is the fail-safe direction; it must not be softened by making `parseCoverage`
  lenient. Every further member re-incurs this, which is itself a reason to keep the bar high.
- **The consent model contradiction.** Shipped code answers it two ways: the share and preflight
  gates accept an approval from any local client, while the executor gate rejects a foreign
  responder. Nobody should build a second approver path until that is resolved deliberately. The
  delegation machinery already ships and is scoped and expiring, which is the better starting point
  than blanket authority.
- **One key, three trust roles, no rotation.** The same signing pair covers shares, egress receipts
  and proposed attestations; its public key is distributed for verification in all three and the
  artifacts carry no key id. No rotation path exists for it or for four other key materials. The
  per-profile data root forces a fork nobody will notice: prefix the key and cross-profile evidence
  becomes unlinkable; do not prefix it and one profile can sign over another's window.
- **Bearer-token scopes.** The clip token has no scope field. Four surfaces already share it and
  three more are proposed on it approvingly, because reuse means no new pairing flow. Together, a
  token minted to clip a web page becomes: run any read-only agent over the whole index, resolve any
  URL, and read the pending-approval queue. Add scopes before the second consumer, not the fifth.
- **Redactor classification.** Four redactors with four different contracts and no classification;
  every new outbound surface picks one ad hoc. One classified policy plus a shared golden corpus is
  unjustifiable per-track and obvious across six.
- **What `payload_summary` is for.** It is deliberately unhashed and scrubbed by a function the
  codebase itself calls a debugging aid — and two proposed items put it in front of third parties.
  Either it stays local, or it earns a real contract.

## Cut from the landscape

Recorded with the argument, so they are re-decided rather than re-discovered.

- **Extension runtime and marketplace.** The strongest disagreement in the source material, and the
  cut wins. The spawned server has no consumer, its claimed leverage over the author toolchain is
  false, and — decisively — if extension tools *did* reach the merged mesh, the dispatcher resolves
  by name while the gate tests a frozen action-type set they cannot join, so they would dispatch
  **ungated**. Keep the integrity chain, delete the stub, document first-party-only, and re-decide
  from "we have no authors" rather than "we have no runtime."
- **Voice.** Ships with no client and no production wiring; the honest move is deletion, not a
  surface.
- **Trace and inspect.** Three durable surfaces already answer the question better.
- **Opening the brief union.** Needs a population, and the closed union is already broken for
  first-party agents — that drift is the prerequisite nobody has scheduled.
- **Recipe gallery and starter packs.** Both need a population that does not exist. Starter packs
  additionally depend on a trustworthy consent preview that does not exist.
- **Public connector feed.** A page derived from data the health gate already produces, not a
  project.
- **Migration-in importers.** Each is an S-sized connector authored through the existing connector
  path, not a new project. Only its prerequisite — the body-preview cap — is worth scheduling.
- **Export / import / delete portability.** Struck rather than cut: the Track 0 row is simply wrong.
  It is fully wired end to end.

## The through-line

Read by asset rather than by track, every durable thing Nimbus produces is an attestation: a chained
egress ledger, a chained audit log, signed shares with a forwarding hop chain, signature-verified
monotonic-stricter policy, signed window receipts, an inert signed inbox, and a command literally
named `prove`.

The agents are the part a competitor ships next quarter over the same MCP servers. The chained,
signed, offline-checkable record of what an agent did to your data is not.

> The sentence a user says out loud is not "Nimbus wrote my standup." It is **"run `nimbus prove`
> and send me the receipt."**

That reprices this document. The operator console, evidence export, the offline verifier, observer
expiry, machine link and fleet attestation stop being a compliance track aimed at buyers and become
the differentiated core; the ambient surfaces become distribution for it.

It is also the harshest available reading, because the notary substrate is exactly where every
verified defect above clusters. Today that substrate is the product's most-marketed and least-true
property — which is the strongest argument in this document for why the repair clusters outrank the
additions.

## Provenance

This landscape was produced on 2026-08-02 by a fourteen-agent pass: six parallel readers mapping
surfaces, gateway capability, product capability, author extension points, recorded roadmap
direction and go-to-market; five ideation lenses; and three critics performing feasibility
verification against the tree, strategic critique, and a completeness sweep.

**Verified directly against the tree** before this document was written: the notification stub
and its call site; the absence of a desktop build job and of any admin-console build step; the
absence of container, systemd and launchd artifacts; the extension-row consumers; the HTTP
route list; the `canonical_url` column and its lack of an index; the migration runner's
missing newer-than-target guard; and the embedder's remote model fetch.

**Not independently verified**, and worth confirming before any item plans around them: the
item-body indexing cap, the exact per-connector registration site count, and the precise
location of the awaited-brief adapter, which two auditors cited differently and which exists in
more than one form in the CLI package.

### The 2026-08-02 extension

The clusters, sequencing rules, cross-cutting decisions and cut list were produced by a second
nine-agent pass: six deepening one track each into concrete v1 shapes, then three deriving the
dependency graph, the cluster decomposition and the cross-track compounds.

**Verified directly against the tree** before being written here: the three `tool.execute()` paths
that bypass `D22`'s string-match rule and the text of the rule's own no-escape-hatch claim; the
absence of any egress reference in `share/` and of chain columns on `share_records`; what
`signWindowDigest` actually covers, against `ShareBody` as the in-repo counter-example.

**Agent-reported with file citations**, consistent with the above but not personally re-opened: the
unwired profile, voice and snapshot-scheduler services; the discarded ChatOps namespace argument;
the un-awaited contract-test call; the mapping files that never set `canonical_url`; and the
transitive leverage counts behind the Layer 0 re-ranking. Confirm before planning around any of
them.
