# Nimbus Ecosystem Roadmap

The delivery spine for everything **outside** the gateway: `@nimbus-dev/sdk`,
`@nimbus-dev/client`, and the client surfaces built on them (VS Code, Raycast,
web clipper, statuspage, and whatever comes next).

> **This is not a second product roadmap.** [`roadmap.md`](./roadmap.md) is
> authoritative for what the gateway *does* — phases, acceptance criteria,
> north-stars. This document is authoritative for how that capability *reaches a
> human*. The distinction is load-bearing:
>
> **The gateway roadmap is 27 phases deep. The client surface is 15 methods wide.
> This document owns the width.**
>
> Where the two touch, `roadmap.md` wins on *what* and this file wins on *when it
> becomes reachable*.

---

## Contents

- [The diagnosis](#the-diagnosis)
- [Thesis and operating principle](#thesis-and-operating-principle)
- [Repo map](#repo-map)
- [Stage 0 — Seal the waist](#stage-0--seal-the-waist)
- [Stage 1 — Open the waist](#stage-1--open-the-waist)
- [Stage 2 — Re-cut the surfaces for the ICP](#stage-2--re-cut-the-surfaces-for-the-icp)
- [Stage 3 — Distribution](#stage-3--distribution)
- [The headline](#the-headline)
- [Explicit non-goals](#explicit-non-goals)
- [Open decisions](#open-decisions)
- [How to update this document](#how-to-update-this-document)

---

## The diagnosis

Three measured facts, each verified against source rather than inferred. They are
stated bluntly because the sequencing below only makes sense if they are true.

### 1. The capability is built — it is not reachable

The gateway dispatches **212 JSON-RPC methods**.[^count] `@nimbus-dev/client`
exposes **15**. The VS Code extension — the most developed client — consumes
**13**.

[^count]: Enumerated from the dispatch tables under `packages/gateway/src/ipc/`.
    A raw grep for method-shaped string literals in the same directory returns
    243, the difference being notification names (`engine.streamToken`,
    `<agent>.briefReady`, …) rather than callable methods. Treat 212 as accurate
    to within a handful; the argument does not turn on the exact figure.

Entire namespaces are built, dispatch-wired, and in most cases already vetted on
the Tauri renderer allowlist, yet unreachable from any npm-based client:
`agents.*` (expert, impact, catchup, ghost, conflicts, huddle, janitor,
preflight), `workflow.*`, `watcher.*`, `share.*`, `federation.*` (~24),
`connector.*`, `people.*`, `tribal.*`, `policy.*`, `metrics.dora`,
`deploy.preflight`.

The client has shipped **5 new methods in 4 months** (`searchRanked` in 0.3.0,
four `egress.*` in 0.4.0, none in 0.5.0) against ~198 unexposed. Adding one is
~100 lines across 5–6 files and requires **zero gateway changes**; a whole
namespace is roughly a day plus an hour of release latency.

> This is not a hard problem. It is an unstaffed one — and it is the single
> largest gap between what Nimbus is and what anyone can experience.

### 2. The narrow waist has no enforced contract, and it is broken today

Four layers disagree about the same object, and nothing catches it:

| Layer | What it says about an indexed item |
| --- | --- |
| Gateway `index/item-list-query.ts:37` | `SELECT * FROM item` — raw **snake_case** rows (`item_type`, `modified_at`) |
| `@nimbus-dev/client` | `queryItems(): Promise<{ items: Record<string, unknown>[] }>` — the **only** method with no validator; passes through whatever the gateway sends (as of the gateway fix, already camelCase `NimbusItem`, but still unchecked) |
| `@nimbus-dev/sdk` `NimbusItem` | **camelCase**, `itemType: "file" \| "folder" \| "email" \| "event" \| "photo" \| "task"` — 6 values |
| `docs/schema-reference.md` | **19** emitted types, including `pr`, `issue`, `pipeline_run`, `deployment`, `alert`, `incident`, `infra_resource`, `dashboard`, `log_alarm` — and `task` is explicitly *not* emitted |

Two live consequences.

**In the gateway.** Because the SDK union is too narrow, `index/local-index.ts:94`
coerces anything outside it to `"file"`:

```ts
function itemTypeFromRowType(raw: string): NimbusItem["itemType"] {
  if (raw === "file" || raw === "folder" || raw === "email" ||
      raw === "event" || raw === "photo" || raw === "task") return raw;
  return "file";
}
```

Every `deployment`, `alert`, `incident`, `pr`, `issue`, `pipeline_run`,
`dashboard`, `infra_resource` and `log_alarm` read through `rowToItem` is
**relabelled `"file"`** — mislabelled, not merely untyped. It accepts two values
the gateway never emits and corrupts thirteen it does.

**In the client.** The VS Code Index view reads `rec["itemType"]` and
`rec["modifiedAt"]` and gets `undefined` every time. It has **never** displayed an
item type or sorted by time. It looks correct only because `id`, `name`,
`service` and `url` are single words that collide across both casings.

Two deeper problems sit behind that bug:

- **There is no machine-readable source of truth for `item_type` anywhere.** The
  enum lives in a SQL comment in a docs file. Connectors emit bare string
  literals. `roadmap.md` plans to add `service`, `team`, `scorecard`,
  `dora_metric`, `security_finding`, `llm_trace` and more — so a hand-maintained
  enum in three places will keep breaking.
- **The SDK's canonical taxonomy is a knowledge-worker document model**
  (`folder`, `photo`, `task`) for a product whose index is full of deployments,
  alerts, incidents and pipeline runs. The positioning gap is not just marketing
  copy; it is encoded in the ecosystem's core data contract.

### 3. Nobody is using it

The VS Code extension: **3 installs**, 157 downloads (Marketplace API, 2026-07-19).

Relatedly — the words `incident`, `on-call`, `deploy`, `alert`, `SRE` and
`DevOps` appear **zero** times in the extension's `src/`, `README.md` or
`package.json`, against a product whose own README opens with *"Cross-service
incident context in under 100 ms"* and whose [`audiences.md`](./audiences.md)
ranks On-call/SRE first. The listing is unfindable by the ICP's own search terms.

---

## Thesis and operating principle

> Capability cannot flow out and errors flow in silently, because the narrow
> waist is unsealed. Seal it, open it, surface it, then tell people.

**Operating principle — every stage ends in a gate a machine can check.**

Delivery here is largely agent-driven, and agents write confident code against
wrong contracts. Fact 2 is what that failure mode looks like when nothing is
watching. So each stage below is defined by its *gate*, not its intent — the same
way `check-bundle` and `check-vsix-contents` already guard the VS Code
extension's invariants. A stage is done when its gate is green in CI and would go
red if the property regressed.

This is why Stage 0 exists at all, and why it comes first.

---

## Repo map

| Repo | Role | License |
| --- | --- | --- |
| `Nimbus` | Gateway daemon, connectors, index, agents, the 212 RPCs | AGPL-3.0 |
| `nimbus-sdk` (`@nimbus-dev/sdk`) | **The contract.** Shared data types, framing primitives | MIT |
| `nimbus-client` (`@nimbus-dev/client`) | Typed JSON-RPC IPC client — the sole path from any npm client to the gateway | MIT |
| `nimbus-vscode` | VS Code / Open VSX extension | MIT |
| `nimbus-web-clipper` | Chrome + Firefox MV3, over the paired HTTP surface | — |
| `nimbus-raycast` | Raycast quick-ask | — |
| `nimbus-statuspage` | On-call/status pages from indexed incidents + DORA | — |

**The contract flows one way, and licensing fixes the direction.** The SDK and
client are MIT; the gateway is AGPL-3.0. MIT into AGPL is fine; the reverse would
infect. So shared types **must** live in `nimbus-sdk` and be imported by the
gateway — never the other way around.

Conveniently, that edge already exists: `packages/gateway/package.json` depends
on `@nimbus-dev/sdk` `^1.3.0` and gateway connector mappers already import its
types. Stage 0 uses the dependency that is already there.

---

## Stage 0 — Seal the waist

**Goal:** one source of truth for the ecosystem's core data contract, enforced by
a test that fails when the layers drift.

> **Implementation plan:** [`superpowers/plans/2026-07-19-stage-0-seal-the-narrow-waist.md`](./superpowers/plans/2026-07-19-stage-0-seal-the-narrow-waist.md)
> — five tasks across four repos, with the two npm release hops sequenced.

**Why first:** it fixes a live user-visible bug, it is days rather than weeks, and
it installs the safety net *before* Stage 1 starts writing against ~200 RPCs.

| # | Change | Repo | Gate |
| --- | --- | --- | --- |
| 0.1 | `ItemType` becomes the canonical contract in the SDK, as an **open** enum: `KnownItemType` lists the 19 emitted types, and `ItemType = KnownItemType \| (string & {})` accepts what a newer gateway emits. Ships as a non-breaking `1.4.0`. | `nimbus-sdk` | typecheck + unit |
| 0.2 | Gateway deletes `itemTypeFromRowType` and passes the raw column through. **No code path may rewrite one item type into another.** | `Nimbus` | round-trip test per ops type + existing invariant suite |
| 0.3 | `queryItems` returns validated `NimbusItem[]`, not `Record<string, unknown>[]` — the gateway now emits already-camelCase rows, so the client validator checks shape rather than normalising casing, and the last unvalidated method joins the other 14. | `nimbus-client` | validator unit tests |
| 0.4 | **Conformance test**: assert the client's types against a real gateway (or a checked-in golden fixture DB) in CI. | `nimbus-client` | **the new gate** |
| 0.5 | Consume the fixed client; delete the local `ITEM_TYPES` mirror. | `nimbus-vscode` | Index view shows types and sorts by time — the shipped bug, fixed |

**Exit criteria**

- A field-name or enum drift between gateway, SDK and client fails CI in at least
  one repo.
- `queryItems` is validated like every other client method.
- The VS Code Index view renders item types and orders by recency.

**Deliberately not in Stage 0:** full codegen from the schema. The migration
runner is authoritative for *tables*, but `item_type` is a free `TEXT` column
whose enum lives in prose. Promoting it to a typed SDK export is the 90% win;
generating the whole schema is a Stage 1+ question, and only if 0.4 proves
insufficient.

---

## Stage 1 — Open the waist

**Goal:** make the built capability reachable, in batches.

**Batch, don't drip.** Cost is dominated by upstream shape archaeology, not
typing: the egress batch did 4 methods in 275 lines (~69/method) versus 106 lines
for `searchRanked` alone. Surface a whole namespace per PR.

Priority is (value ÷ effort), not roadmap order:

| Wave | Namespace | Why it is first | Notes |
| --- | --- | --- | --- |
| 1a | `agents.*` (8) | **Highest value per line in the ecosystem.** All read-only, never HITL, all Tauri-allowlisted — and the SDK already ships both the result types (`agents/brief-types.ts`) *and* runtime type guards (`agents/guard-factory.ts`), both in the published `dist/`. So the two costliest parts of exposing a method — shape archaeology and writing a validator — are already done. Unlocks expert / impact / catchup, the substance of Stage 2's headline. | Returns via `<agent>.briefReady` notification → needs a subscription wrapper like `subscribeHitl`. M, not S. |
| 1b | `consent.respond` | Closes the half-wired HITL loop. One param, trivial result. | Under an hour |
| 1c | Diagnostics: `gateway.ping`, `diag.getVersion`, `admin.status`, `index.metrics`, `diag.snapshot` | Clients currently *infer* connectivity and have no version at all. This kills the largest support loop for every thin client and enables real version negotiation. | S |
| 1d | `session.*` (list/clear/recall/append) | Deletes the raw-SQL schema-coupling hack in the VS Code Sessions view. | S |
| 1e | `audit.verify`, `audit.getSummary`, `audit.toolCalls` | Same BLAKE3-chain design as egress, for which a UI already exists — near-zero design work. `audit.toolCalls` is a genuinely differentiated forensic surface. | S |
| 1f | `metrics.dora`, `deploy.preflight` | The ops payload. Directly serves the ICP and `nimbus-statuspage`. | S |
| 1g | `connector.*` | Largest coherent management surface; unblocks the connector-management gap in every client. | M |
| 1h | `workflow.*` (5) | The long-tracked flagship gap. `workflow.run` streams → wrapper needed. | M |

Later, demand-driven: `watcher.*`, `people.*`, `tribal.*`, `share.*`,
`policy.*`, `llm.*`, `profile.*`, `updater.*`, `federation.*`.

**Permanently out of bounds:** `vault.*` and `db.*` are gateway-internal and must
never be surfaced to a client. Anything the gateway marks CLI-only stays CLI-only
unless that classification is deliberately revisited.

**Gate:** every new method ships with a runtime validator, a `MockClient` parity
stub (the compiler enforces this through the shared interface), and a conformance
assertion from 0.4.

---

## Stage 2 — Re-cut the surfaces for the ICP

**Goal:** stop competing on Copilot's turf with Copilot's vocabulary; build the
things a local-first agent can do that a cloud assistant structurally cannot.

The VS Code extension currently ships Copilot's exact three slash commands
(`/explain`, `/fix`, `/test`) with generic prompts — adjudicated on model quality,
which is the one axis a local-first client cannot win.

**2a — The `why` lens (the headline; see below).** Hover a line: author, PR,
linked ticket, the Slack thread, the incident that drove the change, and
downstream dependents. Already specified in [`roadmap.md`](./roadmap.md) as part
of Phase 7's implicit-knowledge triad. Degrades gracefully — with only git +
GitHub it still yields blame → PR → author → issue (`git_blame_line`, V32), and
each connector adds a lane.

**2b — Ops vocabulary.** `/incident`, `/deploys`, `/owns`, `/blast` replacing the
Copilot three. Quick-ask presets keyed to file type (`*.tf`, k8s/helm YAML,
`Dockerfile`, `.github/workflows/*`): *"What breaks if I apply this?"*,
*"Who owns this service?"*

**2c — Egress receipts.** Per-answer ledger-delta footer; "Prove window" exported
as a self-contained offline verifier; "Prove this PR" attaching a signed
`Nimbus-Egress-Proof` trailer; blocked/denied actions surfaced as first-class
*proof of denial*. Buildable today on the four already-exposed `egress.*` methods.
Aligns with M7 (Provable Locality), Phase 12.5 and the EAF standards track.

**2d — Language Model Tool registration.** `vscode.lm.registerTool` +
`contributes.languageModelTools` — present in stable `@types/vscode` at the
extension's existing `^1.95.0` floor, so no engines bump and no proposed-API
flag. Copilot calls Nimbus for private context. Zero new RPCs. Multiplies the
value of every install — note it does *not* create installs; that is Stage 3's
job.

**2e — Native-feel and correctness bundle.** `capabilities.untrustedWorkspaces`
and `extensionKind` are undeclared, so VS Code **disables the extension entirely**
in a Restricted-Mode workspace with no explanation — a silent bug, not a feature
gap. Plus `viewsWelcome` (the five sidebar views currently render as blank boxes
when the gateway is down), `TreeView.badge`, `FileDecorationProvider`, chat
participant `followupProvider` / `onDidReceiveFeedback` / `disambiguation`.

**Cross-client:** `metrics.dora` and `deploy.preflight` land in
`nimbus-statuspage`; `agents.*` in `nimbus-raycast`.

---

## Stage 3 — Distribution

Capability without discovery is what the 3-install number measures.

- **Marketplace re-cut**: description, keywords and categories in the ICP's
  vocabulary — incident response, on-call, SRE, platform engineering,
  observability, deploy. Today those words appear nowhere.
- **One demo GIF per headline claim.** The `why` lens is a single hover.
- **Cross-link the clients.** Each client repo's `ROADMAP.md` is reduced to a
  pointer to this file plus its own local slice.
- **Launch on the trust story where it is honest** — scoped to
  `authorized-actions`, never overclaimed as raw-syscall capture.

---

## The headline

**`nimbus why` is the banner. Egress receipts are the moat. LM tools are the
multiplier.** They are not exclusive; they differ in what they earn.

| | Earns | Buildable | Risk |
| --- | --- | --- | --- |
| **`why` lens** | *Habit* — the 10×/day reach that converts an install into a user | After Stage 1 | Correlation quality is data-dependent |
| **Egress receipts** | *Defensibility* — a claim no competitor can make | **Today** | Sells to the buyer, not the user; creates no daily pull |
| **LM tools** | *Value per install* | **Days** | Hands the relationship to Microsoft; does not create installs |

Ship them in cost order — receipts, then LM tools, then the lens as Stage 1
lands — but organise the story around the lens.

**Why the lens and not the moat.** Verifiable egress is the stronger asset: a
survey of nine major competitors plus the AI-DLP category found **none** offering
verifiable egress at any granularity, and the asymmetry is structural rather than
competitive — completeness of an egress record can only be established by an
observer at the point of departure, under the user's control, so a cloud vendor
cannot build it at any budget.

But it answers a question the market has not yet asked *of Nimbus*, because only
three people have Nimbus. Put an SRE in front of a marketplace listing:

- *"Verifiable proof of what left your machine"* — intriguing to a security-minded few.
- *"Give Copilot your private incident context"* — positions Nimbus as an accessory.
- *"Hover any line: who wrote it, what ticket, what incident, and what breaks if you change it"* — every engineer wants that.

A moat around an empty castle is still empty. The lens fills the castle; the
receipts are why they stay and why procurement signs.

---

## Explicit non-goals

- **Reaching past the typed client.** `IPCClient.call` is exported and would let a
  client invoke any of the 212 methods untyped. It stays out of bounds: the
  validated surface is the whole point, and Fact 2 is what the alternative costs.
  Exposing an RPC means adding it to the client properly.
- **Competing on model quality or code completion.** Inline completions / ghost
  text remain parked. That axis is unwinnable for a local-first client and is not
  what the index is good at.
- **A second gateway roadmap.** Gateway capability sequencing lives in
  [`roadmap.md`](./roadmap.md). If a stage here needs gateway work, it links there
  rather than restating it.
- **Surfacing `vault.*` / `db.*` to clients.** Ever.

---

## Open decisions

1. **Where does the `item_type` enum ultimately live?** Stage 0 puts it in the
   SDK as a hand-maintained union. If `roadmap.md`'s Phase 7–9 type additions
   arrive faster than that can absorb, generation from a single machine-readable
   manifest becomes worth its cost. Revisit after 0.4 has caught its first drift.
2. **What does the conformance test run against?** A live gateway in CI (accurate,
   slower, needs orchestration) versus a checked-in golden fixture DB (fast,
   hermetic, can itself go stale). Recommendation: fixture in the client's CI,
   plus a scheduled live run in the gateway's.
3. **Is `nimbus-vscode` the right first client for the `why` lens**, or does the
   CLI/desktop own it? During a live page engineers are usually in Slack,
   PagerDuty and a terminal — not the editor. The editor's strongest jobs may be
   the *before* (blast radius pre-push) and the *after* (postmortem), with the
   incident itself owned elsewhere.
4. **Staffing the client.** Every stage here is gated on `nimbus-client`
   throughput, which has averaged ~1.25 methods/month. Nothing below Stage 0
   changes until that does.

---

## How to update this document

- A stage is **done** when its gate is green in CI, not when its code is merged.
- When a client method ships, move it from Stage 1's table to a shipped list and
  note the client version that carries it.
- When this file and [`roadmap.md`](./roadmap.md) disagree about gateway
  capability, `roadmap.md` wins — fix this one.
- Each client repo keeps a short `ROADMAP.md` containing only its local slice and
  a pointer here. Do not restate stages in a client repo; that is the drift this
  document exists to prevent.
