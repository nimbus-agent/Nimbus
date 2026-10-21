# Role packs — programme overview

**Date:** 2026-10-21 · **Status:** draft for owner review · **Scope:** the overview the five
project designs point back to. Each project gets its own brainstorm and design document; this one
fixes the shape they share.

> Per the repo convention, this spec lives on a feature branch only. Before any implementation PR,
> its durable content moves to `docs/architecture.md` / `docs/roadmap.md` and this file is deleted.

---

## 1. Intent

The owner wants to build several products for different roles — developers, DevOps/SRE, product
managers, and more later — on top of Nimbus, rather than as separate apps. The insight that started
it: a PM product would need connectors, a cross-tool index, a people graph, and decision/contradiction
reasoning, and Nimbus already has all of them.

The decided direction:

- **One engine, thin apps.** Nearly all value lives in the shared engine, so an engine improvement
  reaches every app the same day. Each app is thin.
- **Inside: one Nimbus with packs. Outside: separate-feeling products.** An "app" is a **role pack**
  — a signed, declarative bundle that reshapes one Nimbus install for a role. "Nimbus for PMs" can
  have its own name, page and price, but it is the same installer opening with the PM pack chosen.
  A person can hold more than one pack.
- **Enable the mechanism before choosing the first app.** This programme builds the pack
  capability; which pack ships first commercially is decided later.

## 2. What a role pack is

A signed, **declarative** manifest. It contains no code of its own. It may declare:

| Part | Meaning |
|---|---|
| **Member extensions** | Registry extensions the pack installs (the only path by which code arrives — the existing sandboxed extension runtime, I43). |
| **Suggested connectors** | Which connectors to offer during onboarding and in the connector screens, in order. |
| **Visible agents and briefs** | Which built-in agents the role sees by default. |
| **Scheduled briefs** | `[[fleet.job]]`-shaped jobs (overnight digests). |
| **Config defaults** | Default values for existing config keys, applied in a layer *under* the user's own file. |
| **Desktop layout** | Which first-party pages and brief panels appear, and in what order. |
| **Source mapping** | Which `service:type` item types count as which *kind* of thing for the shared agents (for the PM pack, Google Drive documents are decision sources). v1 maps whole item types only; matching on item metadata ("pages tagged PRD") is out of scope, since most connectors do not index the properties it would need. |

**Later, not in this programme:** field vocabulary and patterns (glossary seeds, decision-signal
phrases, severity naming) as *structured, engine-validated data*. The likely home is roadmap Phase 16
"Team skill packs" (§ 7), so one knowledge-pack mechanism serves both vendor role packs and
team-authored packs.

## 3. Goals, non-goals, anti-goals

**Goals**

1. A pack can reshape Nimbus for a role without any change to engine code.
2. Installing a pack is one reviewed owner decision, showing everything it will change.
3. Removing a pack restores Nimbus exactly; the user's own config is never edited by a pack.
4. Two packs can be active at once with a defined, explainable precedence.
5. Shared agents get better for a role through source mapping, not through per-role agent code.

**Non-goals (this programme)**

- Choosing, branding, pricing or selling the first commercial app.
- Packs contributing new agents or briefs as code. Agents stay compile-time registered — the
  8–10 forced registration sites and the I31 disclosure guarantees depend on that.
- Packs shipping UI code. The renderer is untrusted (I7) and the CSP forbids remote or eval'd code
  (I8); packs pick and order first-party screens only.
- A hosted Nimbus service or a vendor-held LLM key. (Raised in an earlier brief; out of scope here
  and in tension with local-first — see § 8.)
- The knowledge layer (vocabulary/patterns) beyond source mapping.
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
- **Security invariants I1–I45** (plus I46, pending on the unmerged desktop-migration branch) stay intact. A pack is *data the engine reads*, never a new code
  path past a gate. Pack install reuses the extension install/run approval path (`extension.install`,
  `extension.run`, both in the I2 frozen set, never delegable per I20, LAN-forbidden).
- **Tighten-only next to org policy (I22).** Org policy remains the ceiling; a pack default can never
  re-enable something policy disabled.
- **The desktop allowlist (I7) never gains a method that can install or run code.** A pack with
  member extensions installs from the CLI only, exactly as an extension does today. The desktop may
  install and remove **data-only** packs (no member extensions) — it is the one pack mutation it
  gets, and its approval goes through the existing HITL popup.
- **Packs cannot loosen anything, including through config defaults.** The pack layer accepts only
  keys on an explicit **allowlist of pack-settable keys**. Anything that widens egress, execution,
  network reach or HITL is excluded — e.g. `[llm.remote.*] enabled`, `[fleet] allow_remote`,
  `[agents] synthesis = "allow-remote"`, `[code_execution]`, `[mcp_sink]`, `[extensions] runtime`,
  the LAN bind, `[computer_use]`, `[tool_generation]`. Keys whose only effect is local work are
  allowed — e.g. `[fleet] enabled` with fleet jobs (I38 keeps an unattended run local unless
  `allow_remote`, which a pack cannot set). The allowlist is an allowlist, not a denylist, so a new
  config key is not pack-settable until someone decides it should be.
- **Packs shape; they do not restrict.** Hiding an agent is presentation (menus, sidebar, tour,
  onboarding), never a refusal: every agent stays callable from the CLI, HTTP, MCP, fleet and ChatOps
  exactly as today. Restriction remains org policy's job (I22). With no pack, everything is visible;
  with several, visibility is the union.

## 5. The five projects

Order: **1 → 3**, then **2, 4, 5** can proceed in parallel once 3 has pinned the manifest format.

### Project 1 — Foundations

What exists today: config is code defaults + one TOML file; a profile *replaces* the file; many
loaders hardcode `nimbus.toml` and ignore the profile; no per-agent on/off; connectors and agents
carry no category or description metadata.

Scope:
- **A layered config.** `code defaults → pack layer(s) → team baseline → user file (active
  profile)`, org policy as the ceiling, with `nimbus config explain <key>` naming the layer a value
  came from. This is the *same* layering roadmap Phase 16 W1 plans — build it once. **Project 1
  builds the engine and the pack layer only**; the team-baseline layer is a defined, empty slot and
  W1's team-repo distribution is not pulled in. A team baseline outranks a pack because it is the
  team's own choice and a pack is a vendor default. Every loader that hardcodes `nimbus.toml` today
  moves onto the layered reader as part of this.
- **Agent visibility.** A per-agent visible setting read by presentation surfaces only (see § 4,
  "Packs shape; they do not restrict").
- **Catalog metadata.** Category, short description and role tags for connectors and agents, and
  a read method to list them.

Done when: a pack layer can set any pack-settable key without the user's file changing, and is
refused for any other key; `config
explain` names the layer each value came from; agents can be hidden; the catalog is listable.

### Project 2 — Source mapping

What exists today: the decisions and glossary passes filter on hardcoded `service:type` lists, so
items written by an extension (`ext_*`) are invisible to them. This also blocks the separate decision
to unbundle the 94 connectors — each connector moved to an extension would blind the agents to it.

Scope: agents find their inputs by **item kind** (decision source, ticket, doc, message, incident…)
resolved from a mapping table; built-in connectors keep their current mapping as the default; packs
and extensions can add entries. The largest project; it serves the unbundling programme too.

Done when: the decisions and glossary passes pick up an `ext_*` item type purely through a mapping
entry, with no agent code change, and built-in behaviour is unchanged.

### Project 3 — The pack itself

Scope: the manifest format (in `packages/registry-format/`), validation, install and remove as one
owner decision listing everything the pack changes, a `pack` entry type in the registry index (older
clients already tolerate unknown index keys, and the signature covers them), CLI commands, and the
first two first-party packs (PM and DevOps).

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
layer, removing it restores the prior state exactly, and the DevOps pack installs alongside it.

### Project 4 — Desktop

What exists today: routes, sidebar, settings and dashboard are static code; briefs render as raw
`<pre>` text with no markdown renderer; 15 `agents.*` methods are already on the desktop allowlist
and nothing calls them.

Starts after `dev/asaf/desktop-migration` merges: that branch rewrites parts of the same layout and
allowlist (and adds I46), and building on top of it is cheaper than merging around it.

Scope: navigation and dashboard composition derived from the active packs (choosing among
first-party pages only), a generic brief page over the already-allowlisted `agents.*` methods, and a
safe markdown renderer compatible with the CSP.

Done when: switching the active pack changes the sidebar and dashboard with no rebuild, and any
built-in brief renders as formatted markdown.

### Project 5 — Role-aware onboarding

What exists today: no role question anywhere; desktop onboarding hardcodes six connectors;
`nimbus init` requires a git repo and offers four local-login adoptions; `nimbus wow` tours six fixed
agents.

Scope: one "what do you do?" question in desktop onboarding and `nimbus init`, which offers the
matching pack; connector suggestions and the `wow` tour follow the active packs.

Done when: the programme proof (§ 6) passes on all three OSes.

## 6. Programme proof

1. A fresh install asks "What do you do?" — in the desktop and in `nimbus init`. The user picks
   **Product**.
2. Nimbus shows the PM pack: what it suggests (Slack, Jira, Notion), turns on (decisions, conflicts,
   why, a nightly decisions digest) and changes. One approval.
3. After first sync, the sidebar leads with Decisions and Conflicts; a brief page renders them
   properly; the decisions pass picks up **Google Drive documents** (`google_drive:file`) because the
   pack's source mapping says they count. They are not a decision source today, so this step fails
   without the pack — which is what makes it a proof. (Notion pages were the first example and were
   dropped: `notion:page` is already a hardcoded decision source, and Notion sync indexes no
   properties, so "tagged PRD" had nothing to match.)
4. Removing the pack returns Nimbus exactly to its prior state; the user's `nimbus.toml` is
   untouched throughout.
5. A DevOps pack can be added alongside it, with no engine change beyond what the PM pack needed.

## 7. Relationship to existing roadmap rows

| Row | Relationship |
|---|---|
| Phase 9.5 project 4 — "Starter packs" | **Absorbed** by Project 3, widened from extension-only bundles to role packs. |
| Phase 9.5 project 4 — "Extension dependencies" | Unchanged and separate. Packs list members explicitly and do not need transitive fetching. |
| Phase 16 W1 — "Layered precedence", `nimbus config explain` | **Same mechanism** as Project 1's layered config; build once. |
| Phase 16 W2 — "Team skill packs" + skill-pack HITL invariant | The likely home of the later knowledge layer. Naming must keep the two kinds of pack distinct. |
| Connector unbundling (Readwise pilot, migration engine) | Project 2 removes a blocker it has today. |

## 8. Decided, and calls made for the owner to check

**Decided by the owner:** one engine with thin apps; packs inside, separate-feeling products
outside; declarative packs with source mapping; the knowledge layer later as structured data, never
free-form prompts; enabling the mechanism before choosing the first app; the five-project split and
order; the programme proof in § 6.

**Calls made in writing this (owner to check):**
- The name **"role pack"**, to keep it distinct from Phase 16 "skill packs".
- The first two packs are **PM and DevOps** (the second is the test that the mechanism is not
  PM-shaped).
- Project 1's layered config **is** Phase 16's layered precedence, not a parallel mechanism.
- The desktop installs and removes **data-only packs only**; packs with member extensions are
  CLI-only (§ 4).
- Pack config defaults go through an **allowlist of pack-settable keys** that excludes everything
  widening egress, execution, network or HITL (§ 4).
- Hiding an agent is **presentation, never refusal**; no pack means everything visible, several
  packs mean the union (§ 4).
- Config layer order **defaults → packs → team baseline → user**; Project 1 builds the pack layer
  and leaves team baseline an empty slot (§ 5).
- Packs are **first-party only** in this programme; local-file packs only outside production;
  the first two packs have no member extensions (§ 5, Project 3).
- The proof's source-mapping example is **Google Drive documents**, mapped by whole item type;
  metadata matching is out of scope (§ 2, § 6).
- Project 4 **waits for `dev/asaf/desktop-migration`** to merge (§ 5).

**Positioning flag (not a decision):** `docs/audiences.md` says Nimbus is "built for engineers and
operators who run systems in production" and "not a tool for everyone". A PM product is a change of
audience, and an earlier brief also floated a vendor-held LLM key. Both are product decisions outside
this programme, but the PM pack will collide with that page when it ships.

## 9. Left to each project's design

Manifest field names and file format; how two packs' defaults merge when they disagree (precedence
rule) and how a pack and a user value interact for list-valued keys; the item-kind vocabulary for
source mapping; where the active-pack set is stored; how the desktop learns of pack changes; the
removal guarantee's exact definition (what "restores exactly" means for indexed data synced while a
pack was active); test layers and invariant/static-rule additions, if any.
