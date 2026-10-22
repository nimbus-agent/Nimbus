# Role packs — programme overview

**Date:** 2026-10-21 (revised 2026-10-22 after review) · **Status:** draft for owner review ·
**Scope:** the overview the five project designs point back to. Each project gets its own brainstorm
and design document; this one fixes the shape they share.

> Per the repo convention, this spec lives on a feature branch only. Before any implementation PR,
> its durable content moves to `docs/architecture.md` / `docs/roadmap.md` and this file is deleted.

---

## 1. Intent

The owner wants to build several products for different roles — developers, DevOps/SRE, product
managers, and more later — on top of Nimbus, rather than as separate apps. The insight that started
it: a PM product would need connectors, a cross-tool index, a people graph, and decision reasoning,
and Nimbus already has all of them.

The decided direction:

- **One engine, thin apps.** Nearly all value lives in the shared engine, so an engine improvement
  reaches every app the same day. Each app is thin.
- **Inside: one Nimbus with packs. Outside: separate-feeling products.** An "app" is a **role pack**
  — a signed, declarative bundle that reshapes one Nimbus install for a role. "Nimbus for PMs" can
  have its own name, page and price, but it is the same installer opening with the PM pack chosen.
  A person can hold more than one pack.
- **Enable the mechanism before choosing the first app.** This programme builds the pack
  capability; which pack ships first commercially is decided later.

**A gap this programme does not close:** Nimbus has no detector for *contradictions between
decisions or documents*. The `conflicts` agent is something else — a file-level collision check
across federated peers (open PRs, tickets and commits touching the same file). A PM-grade
contradiction brief would be a new built-in agent, built in the engine like any other, and is
outside these five projects.

## 2. What a role pack is

A signed, **declarative** manifest. It contains no code of its own. It may declare:

| Part | Meaning |
|---|---|
| **Member extensions** | Registry extensions the pack installs (the only path by which code arrives — the existing sandboxed extension runtime, I43). |
| **Suggested connectors** | Which connectors to offer during onboarding and in the connector screens, in order. |
| **Visible agents and briefs** | Which built-in agents the role sees by default. |
| **Scheduled briefs** | `[[fleet.job]]`-shaped jobs (overnight digests). |
| **Config defaults** | Default values for pack-settable config keys, applied in a layer *under* the user's own file (§ 4). |
| **Desktop layout** | Which first-party pages and brief panels appear, and in what order. |
| **Source mapping** | Which `service:type` item types count as which *kind* of thing for the shared agents (for the PM pack, Google Docs are decision sources). v1 maps whole item types only; matching on item metadata ("pages tagged PRD") is out of scope, since most connectors do not index the properties it would need. |

**Later, not in this programme:** field vocabulary and patterns (glossary seeds, decision-signal
phrases, severity naming) as *structured, engine-validated data*. The likely home is roadmap Phase 16
"Team skill packs" (§ 7), so one knowledge-pack mechanism serves both vendor role packs and
team-authored packs.

## 3. Goals, non-goals, anti-goals

**Goals**

1. A pack can reshape Nimbus for a role without any change to engine code.
2. Installing a pack is one reviewed owner decision, showing everything it will change.
3. Removing a pack restores what Nimbus **shows and does** to its prior state, and the user's own
   config is never edited by a pack. Work already done while the pack was active (decisions and
   glossary terms extracted from its mapped sources) is **kept but hidden**, so re-adding the pack
   neither re-spends model calls nor loses the owner's vetoes. Data synced by a connector the pack
   suggested stays, because the owner connected that connector, not the pack.
4. Two packs can be active at once with a defined, explainable precedence (§ 4).
5. Shared agents get better for a role through source mapping, not through per-role agent code.

**Non-goals (this programme)**

- Choosing, branding, pricing or selling the first commercial app.
- Packs contributing new agents or briefs as code. Agents stay compile-time registered — the
  8–10 forced registration sites and the I31 disclosure guarantees depend on that.
- Packs shipping UI code. The renderer is untrusted (I7) and the CSP forbids remote or eval'd code
  (I8); packs pick and order first-party screens only.
- A contradiction-detection agent (§ 1).
- A hosted Nimbus service or a vendor-held LLM key. (Raised in an earlier brief; out of scope here
  and in tension with local-first — see § 8.)
- The knowledge layer (vocabulary/patterns) beyond source mapping.
- Source mappings declared by arbitrary extensions (§ 5, Project 2).
- The IT-fleet endpoint agent and the enterprise AI gateway apps.

**Anti-goals — it fails even if it "works" when:**

- A pack can loosen any security property: approve, skip or widen HITL; add an egress class; reach a
  LAN-forbidden or renderer-forbidden method; grant an extension more than its own run approval shows.
- A pack carries free-form prompt text into any model. (Unreviewable drift in every brief, an
  injection channel into the model that reads private data, and no sane merge between two packs.)
- Installing or removing a pack silently rewrites `nimbus.toml`.
- The mechanism is PM-shaped in disguise — the second pack needs engine changes the first didn't.
- Per-role forks of engine behaviour appear (`if (pack === "pm")` anywhere in the engine).

## 4. Constraints every project inherits

- **Non-negotiables** in `CLAUDE.md`: local-first, structural HITL, Vault-only credentials, MCP as
  the connector standard, platform equality (Windows/macOS/Linux, all three in CI), no `any`.
- **Security invariants I1–I45** (plus I46, pending on the unmerged desktop-migration branch) stay
  intact. A pack is *data the engine reads*, never a new code path past a gate.
- **Pack install is its own HITL action type.** A new `pack.install` action type joins the I2 frozen
  set, is never delegable (I20), is LAN-forbidden, is refused on a demo-rooted gateway (I41), and is
  wired gate-only with the null egress sink (I29) since it performs local mutations. The prompt
  lists everything the pack changes. A pack with member extensions additionally goes through the
  existing `extension.install` / `extension.run` approvals for each member — the pack approval never
  stands in for them. **Removing a pack needs no approval**, matching `extension.remove` and every
  other revoke in Nimbus: removal only restores state.
- **The desktop allowlist (I7) never gains a method that can install or run code.** The desktop gets
  `pack.list`, `pack.install` and `pack.remove`; the gateway's `pack.install` handler structurally
  refuses any pack with member extensions when the caller is the desktop, so such packs install from
  the CLI only, exactly as an extension does today.
- **Packs cannot loosen anything, including through config defaults.** The pack layer accepts only
  keys on an explicit **allowlist of pack-settable keys**. Anything that widens egress, execution,
  network reach, HITL, identity or indexing scope is excluded — including at least:
  `[llm.remote.*] enabled`, `[fleet] allow_remote`, `[agents] synthesis = "allow-remote"`,
  `[code_execution]`, `[mcp_sink]`, `[extensions] runtime`, the LAN bind, `[computer_use]`,
  `[tool_generation]`, `[oncall.push] chatops_namespace` (unattended outbound posts, I23/I29),
  `[tribal.notion]` / `[tribal.confluence]` (outbound write destinations, I25), `[user]` identity
  keys such as `mePersonId`, `[[filesystem.roots]]`, and `[llm] local_base_url` /
  `[multimodal] vlm_base_url` (model endpoint resolution, I34). Keys whose only effect is local work
  are allowed — e.g. `[fleet] enabled` with fleet jobs (I38 keeps an unattended run local unless
  `allow_remote`, which a pack cannot set). The allowlist is an allowlist, not a denylist, so a new
  config key is not pack-settable until someone decides it should be.
- **Packs shape; they do not restrict.** Hiding an agent is presentation (menus, sidebar, tour,
  onboarding), never a refusal: every agent stays callable from the CLI, HTTP, MCP, fleet and ChatOps
  exactly as today. Restriction remains org policy's job (I22). With no pack, everything is visible;
  with several, visibility is the union.
- **Two packs never silently override each other.** If two active packs set the same scalar key to
  different values, installing the second is **refused** with the conflicting keys named; the owner
  resolves it by setting the key in their own file (the user layer wins) or by not installing.
  List-like contributions (visible agents, suggested connectors, source-mapping entries) are unions;
  fleet jobs and desktop layout entries merge by name/id, where a duplicate across two packs is the
  same refusal. The first two packs (PM, DevOps) must not conflict.
- **Pack changes take effect without a gateway restart.** Today `platform/assemble.ts` reads
  `[decisions]`, `[fleet]`/`[[fleet.job]]`, `[oncall.push]` and others once at boot and constructs
  subsystems only if enabled then. Every subsystem a pack can affect must either read the layered
  config live or receive a reload signal on pack install/remove. Which, per subsystem, is Project 1's
  and Project 3's call.

## 5. The five projects

Order: **1 → 3**, then **2, 4, 5** can proceed in parallel once 3 has pinned the manifest format.

### Project 1 — Foundations

What exists today: config is code defaults + one TOML file; a profile *replaces* the file; many
loaders hardcode `nimbus.toml` and ignore the profile; config is captured at boot; no per-agent
on/off; connectors and agents carry no category or description metadata.

Scope:
- **A layered config.** `code defaults → pack layer(s) → team baseline → user file (active
  profile)`, org policy as the ceiling, with `nimbus config explain <key>` naming the layer a value
  came from. This is the *same* layering roadmap Phase 16 W1 plans — build it once. **Project 1
  builds the engine and the pack layer only**; the team-baseline layer is a defined, empty slot and
  W1's team-repo distribution is not pulled in. A team baseline outranks a pack because it is the
  team's own choice and a pack is a vendor default. Every loader that hardcodes `nimbus.toml` today
  moves onto the layered reader as part of this.
- **The pack-settable allowlist** and the scalar-conflict rule (§ 4).
- **Live config for pack-affected subsystems** (§ 4), including fleet.
- **Fleet job merging.** `[[fleet.job]]` entries from all layers merge by `name`; a user-file job
  with the same name replaces a pack's job; a new optional `enabled = false` on a job lets the owner
  silence one pack-supplied job without removing the pack. A pack that ships jobs may set
  `[fleet] enabled = true`, and since that value lives in the pack layer, removing the pack returns
  it to whatever the user or the default says.
- **Agent visibility.** A per-agent visible setting read by presentation surfaces only (§ 4).
- **Catalog metadata.** Category, short description, role tags and parameter shape for connectors
  and agents (agents' parameter shapes already live in `AGENT_PARAM_KINDS`), and a read method to
  list them.
- **Where active packs live.** Per profile: switching profile switches the active pack set, so a
  `work-pm` and a `personal-dev` profile each carry their own. Installs with no named profile use the
  default profile, so most users never see the distinction.

Done when: a pack layer can set any pack-settable key without the user's file changing, and is
refused for any other key; `config explain` names the layer each value came from; a pack-layer
change reaches fleet and the extraction passes without a restart; agents can be hidden; the catalog
is listable.

### Project 2 — Source mapping

What exists today: the decisions and glossary passes filter on hardcoded `service:type` lists, so
items written by an extension (`ext_*`) are invisible to them. Inside `decisions/`, three more
places hardcode services: source authority (`decision-confidence.ts`, docs score 1.0 only for
Notion/Confluence/Obsidian), ADR corroboration (`decision-corroborate.ts`), and ticket-key matching
(`decision-service-scope.ts`, Jira/Linear only). This also blocks the separate decision to unbundle
the 94 connectors — each connector moved to an extension would blind these passes to it.

Scope:
- **Item kinds.** `decisions` and `glossary` find their inputs by **item kind** (doc, ticket,
  message, commit, …) resolved from a mapping table. The built-in table reproduces today's lists
  exactly, so default behaviour does not change. Authority, ADR corroboration and ticket matching
  key on the kind, not the service.
- **Who may add mapping entries in v1:** the built-in table, role packs, and the first-party
  connector-migration path (so an unbundled connector keeps its mapping). **Not** arbitrary
  extensions — a mapping entry feeds a service's text into model-driven extraction and multiplies its
  glossary score, so an extension-declared mapping must first be shown and approved in its run grant
  (I43). That belongs to the registry trust work.
- **Backfill on expansion.** When the active mapping gains an item type, its already-indexed items
  are scanned — today's single per-pass watermark would otherwise skip everything synced before the
  pack was installed — without wiping existing records or the owner's vetoes. The mechanism
  (per-entry watermarks or a targeted backfill) is this project's call.
- **Read-time filtering.** `nimbus decisions` and `nimbus glossary` show only rows whose source item
  type is currently mapped; rows from a no-longer-mapped type stay in the database, hidden (§ 3
  goal 3). Brief statistics and gap counts use the same filter so they agree with the entries. The
  stale-score check in `agents/decisions.ts` must not misreport a mapping-driven authority change as a
  legacy-scale row.
- **Google Docs text.** Drive sync today indexes metadata only (`google_drive:file` has no body), so
  mapping it would give the decisions pass nothing but file names to read, and would mark every
  Drive file as a truncated source. This project adds text export for Google Docs (Docs only, not
  every Drive file) to `connectors/google-drive-sync.ts`, under the existing index-depth rules
  (V48/V49) and the existing `sync` egress class.
- **Out of this project:** moving the other agents and subsystems (`standup`, `oncall`, `changelog`,
  DORA metrics, the graph populators) onto item kinds. They are the unbundling programme's work and
  are listed there.

Done when: the decisions and glossary passes pick up a newly mapped item type — including an
`ext_*` one — purely through a mapping entry, with no agent code change; existing items of that type
are backfilled; removing the entry hides those rows without deleting them; built-in behaviour is
unchanged; and Google Docs carry their text into the index.

### Project 3 — The pack itself

Scope: the manifest format (in `packages/registry-format/`), validation, install and remove (§ 4),
a `pack` entry type in the registry index (older clients already tolerate unknown index keys, and the
signature covers them), CLI commands, `pack.*` IPC methods (§ 4), and the first two first-party
packs (PM and DevOps).

The first packs must work without a remote registry — the official registry is not live yet
(`BUILTIN_REGISTRY` is `null`). **In this programme packs are first-party only:** the PM and DevOps
packs ship bundled in the binary, trusted because the release build is. A local-file pack is
accepted only outside a production runtime (the same rule I44 applies to `http:` registries), for
developing packs. Third-party and registry-delivered packs, and the signing key they need, belong to
the registry trust work (Phase 9.5 project 3). The first two packs carry **no member extensions**,
so the member-extension install path is built and tested but not exercised by them.

This project **absorbs the roadmap's "Starter packs" row** (Phase 9.5 project 4), which described a
pack as a meta-manifest of member extensions only. Transitive dependency fetching from that row stays
its own work; a pack lists its members explicitly.

Done when: the PM pack installs with one approval, its defaults take effect through the Project 1
layer without a restart, removing it restores the prior state as § 3 goal 3 defines it, and the
DevOps pack installs alongside it.

### Project 4 — Desktop

Starts after `dev/asaf/desktop-migration` merges: that branch rewrites parts of the same layout and
allowlist (and adds I46), and building on top of it is cheaper than merging around it.

What exists today: routes, sidebar, settings and dashboard are static code; briefs render as raw
`<pre>` text with no markdown renderer; 15 `agents.*` methods are on the desktop allowlist and
nothing calls them — but `agents.oncall`, `agents.standup` and `agents.changelog` are **not** among
them, and 8 of the 17 briefs require parameters.

Scope:
- Navigation and dashboard composition derived from the active packs, choosing among first-party
  pages only.
- A generic brief page over the `agents.*` methods. It adds `agents.oncall`, `agents.standup` and
  `agents.changelog` to the allowlist (read-only briefs, so § 4's rule holds). It builds parameter
  forms from the catalog's parameter shapes (Project 1), runs a brief only when the user asks rather
  than on page load, and **excludes** the two briefs with side effects — `preflight` (owner HITL,
  I24) and `premortem` (writes watcher rows) — which stay in the CLI.
- A safe markdown renderer compatible with the CSP.

Done when: switching the active pack changes the sidebar and dashboard with no rebuild, and every
read-only built-in brief can be run from the brief page and renders as formatted markdown.

### Project 5 — Role-aware onboarding

What exists today: no role question anywhere; desktop onboarding hardcodes six connectors;
`nimbus init` requires a git repo and offers four developer CLI login adoptions; `nimbus wow` tours
six fixed agents; `nimbus demo` shares the tour code and the release smoke test asserts its fixed
steps.

Scope:
- One "what do you do?" question in desktop onboarding and `nimbus init`, which offers the matching
  pack.
- `nimbus init` works **outside a git repository**: it skips the repository and blame setup when
  there is no repo, and offers developer CLI adoptions only when relevant to the chosen role.
- Connector suggestions and the `nimbus wow` tour follow the active packs. `nimbus demo` stays pinned
  to its fixed steps.

Done when: the programme proof (§ 6) passes on all three OSes.

## 6. Programme proof

1. A fresh install asks "What do you do?" — in the desktop and in `nimbus init`, which works outside
   a git repository. The user picks **Product**.
2. Nimbus shows the PM pack: what it suggests (Slack, Jira, Notion, **Google Drive**), turns on
   (decisions, glossary, catchup, a nightly decisions digest) and changes. One approval.
3. After first sync, the sidebar leads with **Decisions and Glossary**; the brief page renders them
   properly; the decisions pass picks up **Google Docs** (`google_drive:file`, now carrying text)
   because the pack's source mapping says they count. They are not a decision source today, so this
   step fails without the pack — which is what makes it a proof.
4. Removing the pack returns what Nimbus shows and does to its prior state (§ 3 goal 3): the sidebar,
   visible agents, nightly job and Google-Docs-sourced decisions disappear; re-adding the pack brings
   the decisions back without new model calls. The user's `nimbus.toml` is untouched throughout.
5. A DevOps pack can be added alongside it, with no engine change beyond what the PM pack needed.

## 7. Relationship to existing roadmap rows

| Row | Relationship |
|---|---|
| Phase 9.5 project 4 — "Starter packs" | **Absorbed** by Project 3, widened from extension-only bundles to role packs. |
| Phase 9.5 project 4 — "Extension dependencies" | Unchanged and separate. Packs list members explicitly and do not need transitive fetching. |
| Phase 9.5 project 3 — trust layer | Owns third-party/registry packs and extension-declared source mappings. |
| Phase 16 W1 — "Layered precedence", `nimbus config explain` | **Same mechanism** as Project 1's layered config; build once. |
| Phase 16 W2 — "Team skill packs" + skill-pack HITL invariant | The likely home of the later knowledge layer. Naming must keep the two kinds of pack distinct. |
| Connector unbundling (Readwise pilot, migration engine) | Project 2 removes the blocker for `decisions`/`glossary`; the other agents' item-kind migration stays with unbundling. |

## 8. Decided, and calls made for the owner to check

**Decided by the owner:** one engine with thin apps; packs inside, separate-feeling products
outside; declarative packs with source mapping; the knowledge layer later as structured data, never
free-form prompts; enabling the mechanism before choosing the first app; the five-project split and
order; the programme proof in § 6.

**Calls made in writing this (owner to check):**
- The name **"role pack"**, to keep it distinct from Phase 16 "skill packs".
- The first two packs are **PM and DevOps**.
- Pack defaults go through an **allowlist of pack-settable keys** (§ 4).
- Hiding an agent is **presentation, never refusal** (§ 4).
- Config layer order **defaults → packs → team baseline → user**; Project 1 builds the pack layer
  and leaves team baseline an empty slot (§ 5).
- **A dedicated `pack.install` HITL type**; removal needs no approval; the desktop installs data-only
  packs only (§ 4).
- **Two packs that disagree on a key are refused**, not resolved by install order (§ 4).
- **Active packs are per profile** (§ 5, Project 1).
- **Removal hides mined rows rather than deleting them** (§ 3 goal 3).
- Source mappings in v1 come from **the built-in table, role packs and connector migration only**
  (§ 5, Project 2).
- Project 2 **adds Google Docs text export** so the PM proof has real text to read (§ 5).
- The PM pack leads with **Decisions and Glossary**, not Conflicts (§ 1, § 6).
- Packs are **first-party only** in this programme; the first two have no member extensions (§ 5).
- Project 4 **waits for `dev/asaf/desktop-migration`** to merge (§ 5).

**Positioning flag (not a decision):** `docs/audiences.md` says Nimbus is "built for engineers and
operators who run systems in production" and "not a tool for everyone". A PM product is a change of
audience, and an earlier brief also floated a vendor-held LLM key. Both are product decisions outside
this programme, but the PM pack will collide with that page when it ships.

## 9. Left to each project's design

Manifest field names and file format; the exact pack-settable key list; the item-kind vocabulary;
the backfill mechanism; live-read vs reload per subsystem; how the desktop learns of pack changes;
test layers and invariant/static-rule additions, if any (a pack-install invariant is likely, since
`pack.install` is a new gate).
