# Nimbus Ecosystem Roadmap

**Status:** landscape, not a commitment · first drafted 2026-08-02

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

Two conventions matter:

- **"Shipped but dark"** means the code exists, passes CI, and is reachable by no user. This is
  the single largest category in the ecosystem today, and it is cheaper to finish than to
  rebuild.
- **Effort** is relative (S/M/L/XL) and deliberately coarse. The useful signal is the *Needs:*
  line, not the size.

## Track 0 — Shipped but dark

The ecosystem's first job is not to add surfaces. It is to connect the ones that already exist.
Every row below was verified against the tree on 2026-08-02.

| Capability | State | Evidence |
|---|---|---|
| Extension system | `install` copies, hashes, Ed25519-verifies (I16), rows and enables — then nothing ever spawns the entry file | `listExtensions` is consumed only by `ipc/automation-rpc.ts` list/info/remove; every `wrapServerSpec()` call site is first-party or user-MCP |
| Desktop app | Code-complete Tauri app — 8 pages, a 103-method Rust allowlist, `tauri build` runs in CI — that has never shipped a binary | no `build-ui` job anywhere in `.github/workflows` |
| Admin console | `nimbus admin console` prints a URL that returns HTTP 503 on every installed binary | `admin-console` appears in no workflow and in no release build step |
| OS notifications | `NotificationService.show()` is an empty async function, and it is the only implementation — so watchers notify nobody and a pending consent prompt reaches you only if you are looking at the right terminal | `createStubNotifications()` at `packages/gateway/src/platform/assemble.ts:225`, wired at `:1703` |
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
consumer can.

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
