# Role packs, Project 1: Foundations (design)

**Date:** 2026-10-22 · **Status:** draft for owner review ·
**Parent:** `2026-10-21-role-packs-overview-design.md` (approved 2026-10-22), § 5 Project 1.
**Branch-only:** this file never lands on `main` and is stripped before the implementation PR.

## 1. Intent

Role packs reshape Nimbus for a role by contributing data: config defaults, fleet jobs, which agents
to show, and a catalog to describe it all. None of that works until Nimbus has **one config
model** that can stack a pack's values under the user's own file, report where each value came from,
and pass a change to the running gateway. Project 1 builds that model. It ships no pack, no
`pack.install` approval and no manifest; those belong to Project 3. When Project 1 is done, Project 3
only has to write a pack layer and call one reload.

## 2. What the code does today (recon, 2026-10-22)

- **There is no config model.** About 47 production functions each open the TOML file and scan their
  own section with the hand-rolled line scanner in `config/toml-primitives.ts` /
  `nimbus-toml.ts` `forEachSectionEntry`. No full-file parse exists, and no TOML library is used.
- **Profiles are half-applied, and nobody designed that.** The active profile reaches the gateway
  as `NIMBUS_PROFILE`, set by the CLI from `<configDir>/.nimbus-profile`. It is resolved by
  `resolveNimbusTomlForProfile`, which picks `nimbus.<name>.toml` and otherwise falls back to
  `nimbus.toml`. 11 loaders take that resolved path. **33 hardcode `nimbus.toml`**, including
  `[decisions]`, `[glossary]`, `[chatops]`, `[user]`, `[[filesystem.roots]]`, `[connectors.*]`,
  service configs and the per-call `[llm]` remote check. A user on a profile therefore runs on a
  mix of two files. The `[agents]` loader was already fixed once for this exact defect
  (`nimbus-toml.ts:2783`).
- **Defaults** are per-section constants (`DEFAULT_NIMBUS_<SECTION>_TOML`) merged as
  `{...DEFAULT, ...parsed}`. Unknown keys are mostly ignored. Many parse errors are swallowed into
  the section's defaults (`loadTomlSection`'s catch). A few sections throw instead (`[fleet]`,
  `[connectors]`, `[notifications]`, service configs).
- **Read timing varies.** Some config is read once at boot in `platform/assemble.ts`: fleet, the
  extraction refreshers, LAN and most capabilities. Some is re-read from disk on every call:
  `[user]`, `[decisions] min_confidence`, `[negotiate]`, service configs, filesystem roots,
  multimodal, persona, `[agents]`. Telemetry is re-read every tick. **Nothing reloads:** no watcher,
  no SIGHUP, no `config.reload`. The only live config writes are `llm.use` / `llm.setDefault`.
- **Fleet** is built once (`assembleFleetRuntime`) with a static `jobs` array. A duplicate job
  `name` is a hard error. `job.name` is the persisted key for backoff, last success and the sweep
  cursor (`fleet_job_state`), so renaming a job orphans its state. If any job fails to parse, the
  whole fleet is disabled for that process.
- **Org policy** overlays only a narrow `LocalBaseline` (retention, quorum, HITL union, capability
  lockoffs, connector allowlist). It does not clamp general config keys.
  `policy/profile-resolver.ts` `resolveEffectiveConfig` has no production caller.
- **Config writers** (`nimbus config set|edit`, `nimbus init`'s filesystem-root append, the demo
  seed) all target the base `nimbus.toml`, even when a profile is active. `llm.use` writes the
  profile-resolved file. There are two near-duplicate atomic writers, one in the CLI and one in the
  gateway.
- **Catalogs.** Agents: `AGENTS_RPC_HANDLERS` is the source of truth (18 methods). There is no
  socket `agents.list`; the only list is `GET /v1/agents`, which returns the external subset. The
  only per-agent descriptions are the CLI MCP tool `DEFS`, which cover the external subset only.
  Connectors: `CONNECTOR_SERVICE_IDS` is ids only. The desktop's `DISPLAY_NAMES` keys drift from
  the real ids, and onboarding hardcodes six connectors with their own descriptions.
- **Nothing can hide or show an agent per owner.**

## 3. Decided by the owner

- **A profile inherits from `nimbus.toml`** and overrides only what it sets. It no longer
  *replaces* the file. Existing profiles are copies of the base file (`nimbus profile create`
  copies it), so they behave the same. The one behaviour change: a section that a profile file
  leaves out now comes from `nimbus.toml` rather than from code defaults. That change is listed in
  the release notes, and `nimbus config explain` makes it visible.
- **Layer order** (from the approved overview), low to high:
  `code defaults → pack layers → team baseline (empty slot) → nimbus.toml → nimbus.<profile>.toml`.
  Org policy stays a ceiling, enforced where it is today.
- **Active packs are per profile.**
- **Two packs never silently override each other:** a conflicting scalar is refused (overview § 4).
- **Five PRs, in this order:** (1) the layered reader, (2) the pack layer, (3) live reload, (4) fleet
  job merging, (5) agent visibility and the catalog.

## 4. Goals, non-goals, anti-goals

**Goals**
1. Every gateway config read goes through one layered reader. All 47 loaders read the same
   effective config, so the profile mix is gone.
2. `nimbus config explain <section.key>` names the layer a value came from, and what it overrides.
3. A pack layer can be added or removed at runtime by an internal API. It is refused for any key
   off the pack-settable allowlist.
4. Every subsystem a v1 pack can affect sees a pack change without a gateway restart.
5. Fleet jobs merge by name across layers, and one job can be switched off.
6. Agents can be hidden from presentation surfaces, and agents and connectors are listable with
   descriptive metadata.

**Non-goals**
- `pack.install` / `pack.remove`, the manifest, signing, the registry entry type: Project 3.
- Source mapping: Project 2.
- The desktop actually using visibility and the catalog: Project 4. Onboarding and `wow`: Project 5.
- Team-baseline distribution (`nimbus.team.toml`, signing, `nimbus apply`): roadmap Phase 16 W1.
  Project 1 only defines the empty slot in the layer order.
- Live reload for config that packs cannot touch, and profile switching without a restart.
- Tightening unknown-key / bad-value handling. Each section keeps its current behaviour; making them
  loud is a separate change.
- Replacing the hand-rolled TOML scanner with a library.

**Anti-goals: it fails, even if it works, when**
- Any loader still opens `nimbus.toml` directly after PR 1.
- A pack layer can set a key that is not on the allowlist, or can set one by any path other than the
  pack-layer API: a hand-dropped file, a profile copy, a fleet-job param.
- Adding or removing a pack edits `nimbus.toml` or a profile file.
- Explain gives an answer that differs from what the loader actually used.
- Hiding an agent refuses a call anywhere: CLI, HTTP, MCP, fleet or ChatOps.

## 5. Design

### 5.1 PR 1: the layered reader

- **One reader, one snapshot.** A new `config/layered-config.ts` reads every layer and produces an
  immutable **snapshot**: for each section, its effective `key → raw value` entries, each tagged
  with its source layer (and any shadowed values from lower layers, for explain). It also holds the
  merged array-of-tables lists. Raw values stay strings in the scanner's existing form, so every
  section parser keeps its own typing, defaults and validation unchanged.
- **Loaders keep their parsing and change their source.** Each `load*FromConfigDir` /
  `load*FromPath` becomes a parse over the snapshot's section instead of over a file. The `FromPath`
  / `FromConfigDir` split disappears, because the snapshot already knows the profile. `assemble.ts`
  builds the snapshot once at boot. Per-call readers ask the reader for the **current** snapshot.
  Which loaders stay per-call and which stay boot-time is unchanged in PR 1.
- **Freshness: today's live edits stay live.** Today a per-call reader re-reads the file, so an
  owner's edit (or `nimbus config set`, or `llm.use`) reaches `[user]`, filesystem roots, persona,
  `[agents]`, multimodal, service configs and the `[llm]` remote check on the next call, and
  telemetry on the next tick, with no restart. PR 1 must not lose that. The reader keeps a cheap
  fingerprint of every layer file (path, size and mtime, plus the pack `active.json`). Getting the
  current snapshot re-stats those files and rebuilds only if one changed. Each snapshot carries a
  monotonically increasing **version**. Boot-time consumers keep their boot values exactly as
  today, except the ones PR 3 makes reactive. A regression test pins this: it edits the user file
  mid-run and asserts that a per-call reader sees the new value without a restart.
- **Merge rules.**
  - Scalars: the higher layer wins per key.
  - Plain tables (`[section]`, `[connectors.github]`): merged key by key.
  - Arrays of tables (`[[filesystem.roots]]`, `[[glossary.terms]]`, `[[fleet.job]]`): **the
    highest layer that defines the array supplies all of it** (whole-array replacement). This
    matters for inheritance: a profile that is a copy of the base file must not double every root.
    `[[fleet.job]]` is the one exception and **merges by `name` from PR 1 on**: a higher layer's job
    replaces a lower one with the same name, whole. Otherwise a user who already has a job would
    erase every pack job in the gap before PR 4. PR 4 adds the `enabled = false` stub and per-job
    error isolation on top.
  - `[agents] show` / `hide` (PR 5) are per-agent, not per-key: see § 5.5.
  - A key a layer does not mention never removes a lower layer's value. There is no "unset" syntax
    in v1. To restore a code default, the owner sets it explicitly.
- **Duplicate detection** stays per file, as today (duplicate fleet job names in one file are still
  an error).
- **Explain.** `nimbus config explain <section.key>` (CLI) over a new CLI-only, LAN-forbidden
  `config.explain` IPC method. It prints the effective raw value, its layer and file path, every
  lower layer's shadowed value, and, for keys that org policy also constrains (retention, quorum,
  capability enables), a line saying the policy may further restrict it. It explains raw values, not
  parsed ones. Where a section's parser rejected the value, `config.explain` says the section fell
  back to defaults, using the same parser the loader used, so explain cannot disagree with the
  loader.
- **Writers follow the profile.** `nimbus config set|get|list|edit` target the active profile's
  file, or `nimbus.toml` with no profile. If the profile is active but has no file yet, `set`
  creates it. `get`/`list` gain an `--effective` view that is the snapshot. `--effective` and
  `config explain` need a running gateway, since the CLI cannot import the reader. Without one they
  fail with a clear message; plain `get`/`list` keep working offline as today. `init`'s filesystem-root append and the demo seed keep writing `nimbus.toml`: init runs
  before profiles matter, and demo is its own root. The CLI and gateway atomic writers stay separate
  (the dependency rules forbid sharing), and PR 1 adds a parity test like `profiles-cli-parity`.
- **Guard.** A static rule (a new `D3x` in `check-nimbus-invariants.ts`, tied to no invariant, like
  D24/D30) forbids the literal `"nimbus.toml"` and `resolveNimbusTomlForProfile` outside
  `config/layered-config.ts` and the writers, so a new loader cannot quietly bypass the reader.
- **Release notes** state the profile inheritance change.

### 5.2 PR 2: the pack layer

- **Storage.** Pack layers are TOML fragments the gateway writes under
  `<configDir>/packs/<profile>/<pack-id>.toml` (`default` when no profile is active), plus a small
  `active.json` per profile that lists the order. Only the gateway writes them.
- **Internal API.** `setPackLayer(profile, packId, fragment)` and `removePackLayer(profile, packId)`
  validate, write atomically, rebuild the snapshot and emit the change (PR 3). Project 1 exposes
  **no IPC or CLI method** that writes a pack layer. Project 3's `pack.install` is the only intended
  caller, behind its HITL gate. Tests drive the API directly.
- **The allowlist** lives in one module (`config/pack-settable.ts`) as an explicit list of
  `section.key` entries plus the fleet-job shape. v1 contains only what the PM and DevOps packs
  need, and everything on it does local work only:
  - `[fleet] enabled`, `min_idle_seconds`, `require_ac_power`, `retention_days`
  - `[[fleet.job]]`: allowed, with three limits. Its `agent` must be fleet-`eligible`. Its params
    may not include federation keys (`namespace`, `namespaces`). Its sweep fields obey today's
    validation.
  - `[decisions] min_confidence`
  - `[agents] visible` (PR 5)

  Everything in the overview's exclusion list is off it, and so is every key not named. Adding a key
  is a reviewed change to that module, which has a test listing each entry with its one-line
  justification.
- **Refusal is whole-layer and loud, on write AND on read.** `setPackLayer` refuses a fragment with
  any non-allowlisted key, naming the keys. On read, a pack file containing a non-allowlisted key
  (hand-edited or tampered with) is **skipped entirely**, logged at error, and reported by
  `nimbus doctor` and `config explain`. It is never partly applied.
- **Conflict rule.** `setPackLayer` refuses when another active pack in the same profile sets the
  same scalar key to a different value, or contributes a fleet job with the same name. It names the
  conflicts. List keys (`[agents] visible`) are unions. Because the user layers sit above packs, the
  owner can always resolve a conflict in their own file. The refusal still stands, though: a
  conflict is about the two packs, and is reported whether or not the user has overridden the key.
- **Order between packs** therefore never matters to the result. `active.json` keeps install order
  only for display.

### 5.3 PR 3: live reload

- **One change signal: the snapshot version.** `setPackLayer` / `removePackLayer` rebuild the
  snapshot immediately. Any user-file edit is picked up at the next read (§ 5.1). A reactive
  consumer compares the version and its own section's effective values on its own schedule. No
  IPC event, file watcher or `config.reload` method is added in v1.
- **Consequence, stated:** a reactive consumer reacts to the *effective* section, whatever layer
  changed it. So once fleet is reactive, an owner's own edit to `[fleet]` or a user `[[fleet.job]]`
  also takes effect without a restart, including owner-only keys like `allow_remote`. That is the
  owner's own choice, so it is not a pack loosening anything. Boot-time consumers that are not
  reactive still need a restart for any change, as today.
- **Which subsystems react.** Only what a v1 pack can affect:
  - **Fleet:** a small supervisor that outlives any scheduler checks the snapshot on a short
    interval. When the effective `[fleet]` / `[[fleet.job]]` changed, it waits for any in-flight
    run (`runOnce`'s `inFlight` guard), stops the scheduler, and rebuilds it from the new snapshot. Enabling the fleet starts a
    scheduler that boot did not build; disabling it stops the one that exists. Job state survives
    because it is keyed by job name in the database. `fleet.list` serves the current job list, not
    the boot-time one.
  - **`[decisions] min_confidence`** is already read per call, so it needs nothing beyond PR 1.
  - **Agent visibility and the catalog** (PR 5) are read per call.
- **Rule for later projects:** adding a key to the allowlist requires saying how its consumer sees a
  change: per-call read, or a reaction to `configChanged`. The allowlist test enforces that each
  entry declares one of those two modes.

### 5.4 PR 4: fleet job merging

- Merge by `name` already exists from PR 1 (§ 5.1). A higher layer's job with the same name
  replaces the lower one **whole**, not field by field.
- A new optional `enabled = false` on a job keeps it in the list but never schedules it.
  `fleet list` shows it as disabled, with its layer. To silence a pack job, the owner writes
  `[[fleet.job]] name = "<same>"` with `enabled = false` in their own file. The rules that a job
  needs `agent` and `interval_seconds` are relaxed only for such a disabling stub.
- **A bad job no longer kills the fleet.** Today one bad job disables the whole fleet. After this,
  every **job-level** error, in any layer, drops only that job, and the rest run. Job-level errors
  are:
  - a missing `agent` or `interval_seconds`
  - an ineligible agent
  - an unknown sweep kind, or `max_subjects` out of range or without `sweep`
  - `digest_min_delta` below 1
  - sweep combined with federation params
  - a duplicate name within one file (the later entry is dropped)

  Each dropped job is reported at error in the boot/reload log, in `fleet status` and in
  `nimbus doctor`, with its layer and file. **Table-level `[fleet]` errors** (for example
  `allow_remote` without a budget, or a bad `retention_days`) keep today's fail-whole behaviour,
  since they change what every job may do. Such a table can only come from a user layer, because
  a pack can set only allowlisted, validated `[fleet]` keys.
- `fleet list` and `config explain fleet.job.<name>` name the layer each job came from.

### 5.5 PR 5: agent visibility and the catalog

- **Visibility setting.**
  - `[agents] visible = [...]` is a pack-settable list, unioned across packs.
  - The user layers add `[agents] show = [...]` and `[agents] hide = [...]`.
  - Start from all agents if no active pack sets `visible`; otherwise from the union of the packs'
    lists.
  - Then apply the user layers **per agent**: the highest user layer that names an agent in `show`
    or `hide` decides it (so a profile can un-hide an agent the base file hides). Within one layer,
    `hide` beats `show`.
  - `visible` is read from pack layers only. A `visible` key in a user file is ignored and
    `config explain` says so.
  - Unknown agent names are reported by `config explain`, not fatal.
- **It is presentation only.** No gate, dispatcher, HTTP route, MCP tool, fleet or ChatOps path
  reads it. A test asserts that the setting has no reader outside the catalog module.
- **Catalog metadata** lives gateway-side in `catalog/agent-catalog.ts` and
  `catalog/connector-catalog-meta.ts`:
  - **Agents:** a `Record` total over the agent methods (so a new agent gets a compile error until
    it has an entry, the next of the forced registration sites) with display name, one-line
    description, category, role tags, parameter shape (derived from `AGENT_PARAM_KINDS`) and
    surface eligibility (external, fleet).
  - **Connectors:** a `Record` total over `CONNECTOR_SERVICE_IDS` plus the gateway-local
    syncables, with display name, category and one-line description.
  - **Extensions** (`ext_*`) appear with the name and description from their manifest, category
    `extension`, and are marked as such.
- **Read method.** A new `catalog.list` IPC method returns agents (with `visible`) and connectors
  (catalog data only, no connection state). It is CLI/desktop-callable and LAN-forbidden. It joins
  the Tauri allowlist in Project 4, when the desktop first uses it, not here. The CLI gets
  `nimbus catalog [agents|connectors] [--json]`. `nimbus help` is **not** filtered by visibility:
  the CLI is the complete surface.
- Unifying the desktop's `DISPLAY_NAMES` and onboarding lists, and the CLI MCP `DEFS` descriptions,
  onto the catalog is Project 4/5 work. PR 5 only makes the catalog the thing they can switch to.

## 6. Security notes

- No new HITL action type, invariant, egress class or migration in Project 1. Pack layers are local
  files, and the methods that write them are internal until Project 3 puts `pack.install` (I2, I20,
  I41) in front of them.
- New IPC methods (`config.explain`, `catalog.list`) are read-only and LAN-forbidden. Remember that
  `checkLanMethodAllowed` is a denylist, so each must be added to it explicitly.
- The allowlist and read-side refusal are what keep a hand-placed pack file from becoming a
  config-injection channel. A user who can write `<configDir>` can already edit `nimbus.toml`, so
  the read-side check is about tampered or stale pack files, not a new trust boundary.
- I41: a demo-rooted gateway reads its own demo `<configDir>`, so pack layers there are demo-local.
  Project 3 refuses `pack.install` in demo.

## 7. Done when

- No production code outside the reader and writers names `nimbus.toml` (static rule green). A
  gateway on a profile reads every section with inheritance. An integration test boots a real
  gateway with a base file and a profile that sets one key, and proves that all sections resolve,
  including the ones that used to be profile-blind.
- `nimbus config explain` names the layer for scalar, table and array keys, including a pack layer
  and a shadowed value.
- `setPackLayer` accepts allowlisted keys and refuses everything else and any conflict, naming each.
  A tampered pack file is skipped and reported. A pack layer never changes the user's files (a test
  hashes them before and after).
- A pack layer that enables the fleet and adds a job causes that job to run without a restart.
  Removing it stops the fleet again. A user stub with `enabled = false` silences a pack job.
- `catalog.list` returns every agent and connector with metadata, and `visible` follows packs plus
  show/hide. Every agent stays callable everywhere when hidden.
- `bun run preflight` green on all three OS legs.

## 8. Calls made (for the owner to check)

1. **Arrays of tables replace whole across layers** (except fleet jobs, which merge by name). This is
   what makes "profile inherits" safe for today's copied profiles.
2. **v1 allowlist is minimal:** fleet enable/idle/power/retention, fleet jobs, decisions
   `min_confidence`, `[agents] visible`. Glossary and decision pass tuning (`use_llm`, call budgets,
   debounce) is not pack-settable in v1. Both passes already default to on, and those keys are read
   at boot, so allowing them would mean more live-reload work for no pack that needs it.
3. **Pack layers are files under `<configDir>/packs/<profile>/`**, not database rows, so
   `config explain` can point at a path and backups pick them up. They are written only through the
   gateway API, and the allowlist is re-checked on read.
4. **Freshness.** Per-call readers stay live to file edits, as today, via a stat fingerprint. Fleet
   becomes reactive to its effective section, so owner fleet edits also go live. Every other
   boot-time consumer still needs a restart.
5. **`nimbus config set|edit` now write the active profile's file**, not always `nimbus.toml`.
6. **CLI help is never filtered by visibility.**
7. **A bad fleet job from any layer drops only that job** (a pack must not take the user's whole
   fleet down). A bad `[fleet]` table keeps today's fail-whole behaviour.
10. **Fleet merge-by-name moves into PR 1**, so pack jobs are never erased by a user's own jobs in
    the gap before PR 4.
11. **`show`/`hide` resolve per agent**, with the highest user layer winning.
8. **`catalog.list` joins the Tauri allowlist only in Project 4.**
9. **A new static rule** confines naming `nimbus.toml` to the reader and writers.

## 9. Left to the builder

- The snapshot's exact shape, and whether per-call readers get the snapshot or a getter.
- How loader signatures change (one `loadXFromSnapshot` per section, or a generic section accessor),
  and how to stage the 47 conversions inside PR 1.
- Fleet rebuild mechanics, as long as an in-flight run finishes before the swap and no run starts
  twice.
- The metadata wording, categories and role-tag vocabulary for agents and connectors. Keep it
  short and factual; descriptions must not overclaim, per the honesty conventions in the agent docs.
- The static rule's id and exact patterns.
