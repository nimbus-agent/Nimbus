# Nimbus Ecosystem Roadmap

The delivery spine for everything **outside** the gateway: `@nimbus-dev/sdk`,
`@nimbus-dev/client`, and the client surfaces built on them (VS Code, Raycast,
web clipper, statuspage, and whatever comes next).

> **This is not a second product roadmap.** [`roadmap.md`](./roadmap.md) is
> authoritative for what the gateway *does* — phases, acceptance criteria,
> north-stars. This document is authoritative for how that capability *reaches a
> human*. The distinction is load-bearing:
>
> **The gateway roadmap is 27 phases deep. The client surface was 15 methods
> wide; Stage 1 took it to 52. This document owns the width.**
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

> **Superseded by Stage 1, 2026-07-23.** The client now exposes **52** methods,
> not 15. The diagnosis below is kept as written — it is the argument that
> justified the sequencing, and rewriting it after the fact would erase the
> evidence for why the work was ordered this way. Read it as of 2026-07-22.
> Current numbers: [Stage 1 — shipped](#shipped).

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

### 2. The narrow waist had no enforced contract — the gateway half is now fixed

Four layers disagreed about the same object, and nothing caught it. Two of the
four are now aligned; the client half remains:

| Layer | What it says about an indexed item | Status |
| --- | --- | --- |
| Gateway `index.queryItems` | Maps rows through `rowToItem` → camelCase `NimbusItem & { indexPrimaryKey }` | ✅ fixed |
| `@nimbus-dev/sdk` `NimbusItem` | `itemType: ItemType` — an **open** enum (`KnownItemType \| (string & {})`) over the 68 types connectors actually emit | ✅ fixed in 1.4.0 |
| `@nimbus-dev/client` | `queryItems(): Promise<{ items: Record<string, unknown>[] }>` — still the **only** method with no per-field validator | ⬜ outstanding |
| `nimbus-vscode` | Keeps a private six-value `itemType` mirror | ⬜ outstanding |

**What was wrong in the gateway.** The SDK union listed six values, so
`index/local-index.ts` coerced anything outside it to `"file"`. Against a live
546-row index that mislabelled **300 rows — 55%**: `ci_run` (214), `pr` (79),
`issue` (5) and `web_clip` (2). Corruption, not merely missing typing — the true
value was discarded. Separately, `index.queryItems` returned raw
`SELECT * FROM item` rows, leaking V3 column names (`type`, `title`,
`external_id`) over IPC while every other read path already mapped through
`rowToItem`.

Both are fixed: the coercion is deleted and the RPC now goes through
`LocalIndex.listItems()`.

**What is still wrong in the client.** The VS Code Index view reads
`rec["itemType"]` and `rec["modifiedAt"]`. Those reads become correct once it
consumes the fixed gateway, but the extension still filters types through a
private six-value set, so `ci_run`, `pr` and `issue` are dropped on the floor —
and `@nimbus-dev/client` still passes rows through unvalidated, so nothing
catches the next shape change.

One deeper problem sits behind all of it:

- **There is no machine-readable source of truth for the item-type vocabulary.**
  The 68 values are bare string literals across ~70 connector mapping modules,
  all funnelling through one writer (`index/item-store.ts` `upsertIndexedItem`).
  `docs/schema-reference.md` still documents a legacy `items` table that no
  longer exists, and its type list is wrong in both directions — it omits real
  types (`ci_run`, `web_clip`) and lists four (`pipeline_run`, `alert`,
  `infra_resource`, `log_alarm`) that no writer emits. `KNOWN_ITEM_TYPES` in the
  SDK is now testable against reality, but still hand-maintained.
- **The SDK's canonical taxonomy was a knowledge-worker document model**
  (`folder`, `photo`, `task` — the last of which no writer emits) for a product
  whose index is mostly CI runs, PRs and issues. 1.4.0 replaced it with the real
  vocabulary, but the positioning gap it encoded is worth remembering: the core
  data contract described a product Nimbus is not.

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

> **Implementation plan:** [`superpowers/plans/2026-07-20-stage-0-real-schema.md`](./superpowers/plans/2026-07-20-stage-0-real-schema.md)
> — five tasks across four repos, with the two npm release hops sequenced. Tasks 1–2 (gateway)
> shipped in [#780](https://github.com/nimbus-agent/Nimbus/pull/780); Tasks 3–5 (client, VS Code)
> remain. Design: [`superpowers/specs/2026-07-20-stage-0-real-schema-design.md`](./superpowers/specs/2026-07-20-stage-0-real-schema-design.md).

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

**Status: complete, 2026-07-23.** All eight waves shipped across
`@nimbus-dev/client` 0.7.0 → 0.11.0 in eight days. The client surface went
**15 → 52 methods**; `agents.*`, `connector.*` and `workflow.*` — three
namespaces named in the diagnosis as built-but-unreachable — are now reachable
from npm.

**Batch, don't drip** held up. Cost is dominated by upstream shape archaeology,
not typing: the egress batch did 4 methods in 275 lines (~69/method) versus 106
lines for `searchRanked` alone. Every wave surfaced a whole namespace per PR,
and the two largest (1g, 1h) shipped in one.

### Shipped

Priority was (value ÷ effort), not roadmap order. Client version is the release
that carries the method.

| Wave | Namespace | Client | PR |
| --- | --- | --- | --- |
| 1a | `agents.*` (8) — expert, impact, catchup, ghost, conflicts, huddle, janitor, preflight | `0.7.0` (bundle fix in `0.7.1`) | [#14](https://github.com/nimbus-agent/nimbus-client/pull/14) |
| 1b | `consent.respond` | `0.8.0` | [#19](https://github.com/nimbus-agent/nimbus-client/pull/19) |
| 1c | `gateway.ping`, `diag.getVersion`, `admin.status`, `index.metrics`, `diag.snapshot` | `0.8.0` | [#19](https://github.com/nimbus-agent/nimbus-client/pull/19) |
| 1e | `audit.verify`, `audit.getSummary`, `audit.toolCalls` | `0.9.0` | [#23](https://github.com/nimbus-agent/nimbus-client/pull/23) |
| 1d | `session.*` (append/recall/list/clear) | `0.10.0` | [#26](https://github.com/nimbus-agent/nimbus-client/pull/26) |
| 1f | `metrics.dora`, `deploy.preflight` | `0.10.0` | [#26](https://github.com/nimbus-agent/nimbus-client/pull/26) |
| 1g | `connector.*` (12) | `0.11.0` | [#28](https://github.com/nimbus-agent/nimbus-client/pull/28) |
| 1h | `workflow.*` (5) | `0.11.0` | [#28](https://github.com/nimbus-agent/nimbus-client/pull/28) |

Two shape decisions worth carrying forward, because both were discovered by
reading gateway source rather than by reading its docs:

- **`agents.*` resolve from a notification.** Each agent returns via
  `<agent>.briefReady`, so the client subscribes *before* calling and correlates
  by session, rather than awaiting the RPC result. `subscribeAgentBrief` exposes
  the raw stream for callers that want it.
- **HITL-gated methods do not reject uniformly.** `connector.addMcp` and
  `connector.remove` *resolve* with `{ status: "rejected", reason }` on denial;
  `connector.reindex({ depth: "full" })` *rejects* the promise. The client types
  the difference (`GatedRejection`) instead of smoothing it over — a client that
  smoothed it would silently swallow one of the two denials.

**Later, demand-driven:** `watcher.*`, `people.*`, `tribal.*`, `share.*`,
`policy.*`, `llm.*`, `profile.*`, `updater.*`, `federation.*`. None is blocking
a known consumer; surface one when a client asks for it.

**Known gaps left open deliberately** — each is a gateway-side change, not a
client one, so none blocked the stage:

- `connector.addMcp`'s consent payload reads `command`/`args`, which the
  `{ serviceId, commandLine }` params never populate — so the security prompt
  renders blank. Filed against the gateway.
- `connector.configChanged` is emitted but not exposed; clients poll instead.
- `workflow.run({ stream: true })` emits chunks that no public API surfaces.

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
4. ~~**Staffing the client.** Every stage here is gated on `nimbus-client`
   throughput, which has averaged ~1.25 methods/month.~~ **Answered by Stage 1
   (2026-07-23):** 37 methods in 8 days, ~4.6/day. The ~1.25/month figure
   measured *attention*, not difficulty — the work was never throughput-bound.
   Stage 2 and 3 should not be sequenced as though it were.

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
