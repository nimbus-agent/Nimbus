# Nimbus Ecosystem Roadmap

> **✅ COMPLETE — 2026-07-24.** This document's job is done: it sealed the narrow
> waist (Stage 0), opened it (Stage 1: client 15 → 52 methods), re-cut the VS Code
> surface for the ICP (Stage 2), and distributed it (Stage 3). The remaining
> surface work — the `why`-lens hover UI, `nimbus-raycast`, `nimbus-statuspage`,
> `nimbus-postmortem` — is no longer sequenced here; each is owned by its own
> repo's `ROADMAP.md`. This file is kept as the historical record of *why the
> ecosystem work was ordered the way it was*, not as a live plan.

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
| `nimbus-mcp-servers` | *Proposed* — home for the 95 connectors if they leave the monorepo ([Open decision 5](#open-decisions)) | AGPL-3.0 |

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

**Status: VS Code slice complete, 2026-07-23** — one day, six PRs (a
consumption PR plus 2e-core/2d/2b/2c in full), shipped in `nimbus-vscode`
0.7.0 → 0.9.0. 2a was deliberately **not** built: a data spike against a live
index said no (below). Scope was chosen against this section's own framing —
2e first because it was a silent bug, 2d for the multiplier, 2a de-risked
before any UI work — not in roadmap order.

The diagnosis that opened the stage is kept as written: the extension shipped
Copilot's exact three slash commands (`/explain`, `/fix`, `/test`) with generic
prompts — adjudicated on model quality, the one axis a local-first client
cannot win. It also pinned `@nimbus-dev/client` at `^0.6.0`, which on 0.x does
not cross minors — so none of Stage 1's 15 → 52 methods was reachable until the
consumption PR bumped it.

### Shipped

Spec + per-PR plans: [#814](https://github.com/nimbus-agent/Nimbus/pull/814).
Extension version is the release that carries the item.

| Item | What shipped | Ext. version | PR |
| --- | --- | --- | --- |
| Consumption | Client `^0.11.0`; sessions via `session.list` (the `querySql` hack deleted + a guard test); live degraded-connector status bar via `connector.listStatus`; `gateway.ping` in Troubleshoot | `0.7.0` | [#45](https://github.com/nimbus-agent/nimbus-vscode/pull/45) |
| 2e-core | `untrustedWorkspaces: limited` (restricting `socketPath` + `autoStartGateway`) + `extensionKind: ["ui"]` — the Restricted-Mode silent disablement fixed; `viewsWelcome` across all five sidebar views | `0.7.0` | [#46](https://github.com/nimbus-agent/nimbus-vscode/pull/46) |
| 2d | `nimbus_search` + `nimbus_ask` registered via `contributes.languageModelTools` / `vscode.lm.registerTool`; zero new RPCs, no engines bump | `0.8.0` | [#47](https://github.com/nimbus-agent/nimbus-vscode/pull/47) |
| 2b | `/incident` → `agents.catchup`, `/deploys` → `metrics.dora`, `/owns` → `agents.expert`, `/blast` → `agents.impact` — structured brief calls, not prompt rewrites, degrading honestly (empty briefs surface the gateway's own gap notes). The Copilot three live on as quick-ask presets; infra-file presets for `*.tf` / k8s-helm YAML / `Dockerfile` / workflow YAML | `0.8.0` | [#49](https://github.com/nimbus-agent/nimbus-vscode/pull/49) |
| 2c | Per-answer egress delta footer (zero renders as *"nothing left this machine"*); Prove-Window as a self-contained HTML proof artifact (embedded byte-equivalent JSON; the CLI is the verifier); opt-in signed `Nimbus-Egress-Proof` commit trailer; ⛔ proof-of-denial rows in the Egress view | `0.9.0` | [#50](https://github.com/nimbus-agent/nimbus-vscode/pull/50) |

### 2a — the `why` lens: spiked, then built (2026-07-24)

> **Update, 2026-07-24 — the lens is built; step 2 wires it to the client.**
> The prerequisites the spike named have landed: PR-title enrichment
> ([#817](https://github.com/nimbus-agent/Nimbus/pull/817)) and the on-demand
> blame indexer ([#819](https://github.com/nimbus-agent/Nimbus/pull/819)) are
> merged, with root registration in review
> ([#822](https://github.com/nimbus-agent/Nimbus/pull/822)). On that basis the
> lens itself shipped on the gateway + CLI — the `why` agent, `whyPeek`, and
> `nimbus why` ([#820](https://github.com/nimbus-agent/Nimbus/pull/820)) — and
> **step 2** routes it through the narrow waist: `agents.why` / `agents.whyPeek`
> flow through `@nimbus-dev/sdk` 1.6.0 (published) → `@nimbus-dev/client` 0.12.0
> (in review), after which the VS Code hover UI can consume it. What remains is
> the editor UI itself (a `nimbus-vscode` slice) and the demo, not the
> capability. The correlation-quality
> caveat still holds — it is a data-density question the roadmap tracks, not a
> reason the lens is unreachable. The spike record below is kept as written.

The hover lens (author, PR, ticket, thread, incident, dependents per line) was
the stage's headline, but its quality is data-dependent, so a read-only spike
ran against a live index before any UI work —
[findings](./superpowers/specs/2026-07-23-stage-2a-data-spike-findings.md),
merged as [#815](https://github.com/nimbus-agent/Nimbus/pull/815). Verdict:
**don't build yet.** The precomputed `git_blame_line` lane had zero rows on an
actively-used machine, PR titles were id-only (`"PR #220"`), PR→issue graph
joins covered five issues, and no conversation/incident lane had data. The
report records the prerequisites (blame-pipeline investigation gateway-side,
PR-title enrichment in the GitHub connector, one conversation or
incident-driver lane live) and a reproducible re-run bar (≥60% of sampled
recent blame rows resolving to a PR). Until then the lens stays parked — and
the spike feeds [Open decision 3](#open-decisions) rather than closing it.

### Left open from Stage 2

- **2e tail** (deliberately deferred from 2e-core): `TreeView.badge`,
  `FileDecorationProvider`, chat participant `followupProvider` /
  `onDidReceiveFeedback` / `disambiguation`.
- **Cross-client:** `metrics.dora` and `deploy.preflight` in
  `nimbus-statuspage`; `agents.*` in `nimbus-raycast`. Neither repo was touched
  in the VS Code slice. **Now owned by each client repo's own `ROADMAP.md`.**
- **Gateway-side follow-ups surfaced by the spike:** id-only PR titles are
  enriched ([#817](https://github.com/nimbus-agent/Nimbus/pull/817), merged) and
  the blame lane populates on demand ([#819](https://github.com/nimbus-agent/Nimbus/pull/819),
  merged); root registration is merged ([#822](https://github.com/nimbus-agent/Nimbus/pull/822)).
- **`why` lens reachability:** the lens ships on gateway + CLI
  ([#820](https://github.com/nimbus-agent/Nimbus/pull/820), merged); step 2
  promotes its types to `@nimbus-dev/sdk` 1.6.0 (published) and exposes it
  through `@nimbus-dev/client` 0.12.0 (`agentsWhy` / `agentsWhyPeek`, published).
  Remaining after that — the `nimbus-vscode` hover UI — is owned by
  `nimbus-vscode`'s own `ROADMAP.md`.

---

## Stage 3 — Distribution

Capability without discovery is what the 3-install number measures.

> **Status 2026-07-24 — three of four done; the GIF deferred.** The copy/metadata
> work landed as PRs; nothing was published or posted.

- **Marketplace re-cut** ✅ — the `nimbus-vscode` listing (displayName /
  description / categories / keywords + README lead) re-cut for the on-call /
  incident ICP, leading with the ops slash-commands + the egress ledger, `why`
  lens teased as upcoming. Was: those words appeared nowhere.
- **One demo GIF per headline claim** ⏳ **deferred** — the `why` lens is a single
  hover, but the hover UI is unbuilt (now owned by `nimbus-vscode`'s `ROADMAP.md`).
  Gated on that slice; no GIF yet.
- **Cross-link the clients** ✅ — a `ROADMAP.md` pointing to this file + a local
  slice now lives in `nimbus-{vscode,client,sdk,web-clipper}`.
- **Launch on the trust story where it is honest** ✅ — a "Why Nimbus" section in
  the `nimbus-vscode` README + a reusable `docs/launch-messaging.md`, scoped to
  the agent's *authorized/dispatched actions* (the egress ledger records what the
  agent did off-device, not raw network traffic), never overclaimed as
  raw-syscall / whole-machine capture.

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

> **Status 2026-07-23:** the moat and the multiplier shipped (2c, 2d above);
> the banner did not — the 2a spike found the data can't carry it yet. The
> "Correlation quality is data-dependent" risk in the table was the one that
> fired. Stage 3's story therefore leads with what exists — receipts, LM
> tools, and the ops vocabulary — with the lens as the roadmap tease, not the
> claim.
>
> **Update 2026-07-24:** the banner now exists as a capability. The spike's
> prerequisites landed (#817/#819/#822 merged), the `why` lens shipped
> on gateway + CLI (#820), and step 2 routes it through the waist —
> `@nimbus-dev/sdk` 1.6.0 (published) → `@nimbus-dev/client` 0.12.0 (published). The
> "Buildable → After Stage 1" cell is now *built*; what's left for the banner is
> the `nimbus-vscode` hover UI and one demo GIF, now owned by `nimbus-vscode`'s
> own `ROADMAP.md`, not the capability.
> The data-density caveat stays a live quality question, not a reachability one.

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
   incident itself owned elsewhere. **Sharpened, not closed, by the Stage 2a
   spike (2026-07-23):** the data cannot support the lens on *any* surface yet
   ([findings](./superpowers/specs/2026-07-23-stage-2a-data-spike-findings.md)),
   and the *before* job is already served by `/blast` (Stage 2b). Decide the
   surface only after the spike's prerequisites are met and its re-run bar
   clears.
4. ~~**Staffing the client.** Every stage here is gated on `nimbus-client`
   throughput, which has averaged ~1.25 methods/month.~~ **Answered by Stage 1
   (2026-07-23):** 37 methods in 8 days, ~4.6/day. The ~1.25/month figure
   measured *attention*, not difficulty — the work was never throughput-bound.
   Stage 2 and 3 should not be sequenced as though it were.
5. **Do the 95 connectors leave the monorepo?** Motive: decouple connector
   release cadence from the gateway, isolate third-party dependency conflicts,
   lower the bar for community contribution. Cost: the gateway imports
   connectors as workspace members (`packages/mcp-connectors/*`); a split means
   cross-repo typecheck, published `@nimbus-mcp/*` scoped packages, Changesets
   release automation, and a version-compatibility contract between gateway and
   connector packages. **This is spec-sized, not a roadmap bullet** —
   recommendation: hold until a connector's cadence or a dependency conflict
   actually forces it (neither has yet). **Gate if pursued:** gateway CI green
   consuming published `@nimbus-mcp/*` packages, with the connector
   contract-test suite running in the new `nimbus-mcp-servers` repo.

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
