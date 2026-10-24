# Role packs, Project 3: the pack itself (design)

**Date:** 2026-10-24 · **Status:** draft, for the owner's review ·
**Parent:** `2026-10-21-role-packs-overview-design.md` (approved 2026-10-22), § 5 Project 3.
**Builds on:** Project 1 (`2026-10-22-role-packs-p1-foundations-design.md`), complete 2026-10-24
(#1714, #1718, #1724, #1752, #1757).
**Branch-only:** this file never lands on `main` and is stripped before the implementation PR.

## 1. Intent

Project 1 built the mechanism a pack plugs into: a per-profile pack-layer store
(`packages/gateway/src/packs/pack-layer-store.ts`, `<configDir>/packs/<profile>/<id>.toml` plus
`active.json`), the pack-settable allowlist (`config/pack-settable.ts`), the scalar-conflict rule,
live reload for fleet, `[agents] visible`, and the catalog. Nothing in production writes a pack
layer yet: `setPackLayer`/`removePackLayer` have no production caller.

Project 3 makes packs real: a manifest format, an owner-approved install, a remove, a CLI, the IPC
methods, and the first two first-party packs (PM and DevOps) bundled in the binary. When it is done
an owner can run `nimbus pack install devops`, approve one prompt, and see the pack's defaults take
effect without a restart.

## 2. What the code does today (recon, 2026-10-24)

- **Store:** `PackLayerStore.setPackLayer(profile, packId, fragment)` allowlist-checks
  (`checkPackFragment`), job-checks (`checkPackFleetJobs`) and conflict-checks a TOML fragment
  before writing it atomically, and appends the id to `active.json`. `removePackLayer` delists then
  unlinks. Both throw `PackLayerRefusedError` with named problems. Pack ids match `PACK_ID_RE`
  (lowercase, ≤ 64, Windows device names refused). A fragment is capped at 65,536 bytes.
- **Pack-settable today:** `[fleet] enabled` / `min_idle_seconds` / `require_ac_power` /
  `retention_days` (reactive), `[decisions] min_confidence` (per-call), `[agents] visible` (a list,
  per-call, union across packs), and `[[fleet.job]]` (reactive, merged by name).
- **Reload:** the fleet supervisor polls the layered reader's snapshot version and rebuilds on a
  change. `[oncall.push]` is read once at boot (`oncall-push/push-runtime.ts`,
  `store.reconcileEnabledState(config.enabled, now)`), so it is not live.
- **Fleet jobs** use `interval_seconds`, not a cron expression, gated by idle/power admission.
  `agents.decisions`, `agents.changelog`, `agents.catchup`, `agents.oncall`, `agents.glossary` are
  all `"eligible"` in `FLEET_ELIGIBILITY` (`ipc/agents-rpc.ts`).
- **Gate patterns to copy:** `registry.add` is gated through a gate-only executor with the null
  egress sink, built in `ipc/server/dispatchers.ts` (`buildExtensionGateExecutor`) and handed to
  `ipc/registry-rpc.ts` as `ownerGate`; it is in the I2 frozen set
  (`engine/executor.ts`) and on I20's delegate-fallback list. `registry.*` and `extension.install`
  are refused on a demo-rooted gateway (`ipc/server/demo-gate.ts`). `checkLanMethodAllowed` is a
  DENYLIST (`ipc/lan-rpc.ts`): a new namespace is LAN-reachable until listed.
- **`packages/registry-format/src/pack.ts` already exists** and is the `.tgz` packer for
  extension packages. The role-pack format needs a different file name.
- **Catalog connector ids** used below all exist in `catalog/connector-catalog-meta.ts`:
  `pagerduty`, `github`, `github_actions`, `slack`, `sentry`, `jira`, `notion`, `google_drive`.

## 3. Decided by the owner (2026-10-24)

1. **The DevOps pack is on-call plus delivery** (option C): visible `oncall`, `why`, `impact`,
   `ownership`, `catchup`, `changelog`, `standup`; suggests PagerDuty, GitHub, CI, Slack, Sentry; one
   overnight `changelog` digest; and `[oncall.push] enabled` becomes pack-settable.
2. **An installed pack stays as approved** (option A). A newer bundled version is reported as
   "update available"; re-installing shows only what changed and asks once. Nothing updates on its
   own.
3. **Formats now, unused machinery later** (option B). The manifest carries a `members` field and
   `registry-format` defines a `pack` registry-index entry, both validated and tested; the gateway
   refuses any manifest whose `members` is non-empty, and the registry client ignores `pack`
   entries. The member-extension install chain and registry-delivered packs belong to Phase 9.5
   project 3 (trust layer).

Carried from the overview, unchanged: `pack.install` is its own HITL type; removal needs no
approval; packs are first-party only; a local-file pack is accepted only outside a production
runtime; two packs that disagree on a scalar are refused.

## 4. Goals, non-goals, anti-goals

**Goals**

1. A manifest format, pure and Bun-free, in `packages/registry-format/`.
2. `nimbus pack list | show | install | remove`, over `pack.*` IPC methods.
3. Install is one owner approval that shows everything the pack will change; remove is immediate.
4. The PM and DevOps packs ship bundled and install alongside each other without conflict.
5. Install and remove take effect without a gateway restart, including `[oncall.push] enabled`.

**Non-goals**

- Member-extension installation, registry-delivered packs, pack signing keys (§ 3 item 3).
- Source mapping (Project 2) and desktop layout (Project 4) manifest fields; see § 5.1.
- Desktop pack pages and adding `pack.*` to the Tauri allowlist (Project 4).
- The "what do you do?" onboarding question (Project 5).
- Hiding decisions/glossary rows when a pack is removed — that is Project 2's read-time filter.

**Anti-goals — fails even if it works when:**

- Any path writes a pack layer without the owner's `pack.install` approval of the exact bytes.
- A pack can set a key that is not on the allowlist, by any route (manifest, local file, update).
- Installing, updating or removing a pack touches `nimbus.toml` or a profile file.
- A pack's content changes on disk because the binary was upgraded.
- `[oncall.push] chatops_namespace` (outbound ChatOps posts) becomes reachable from a pack.

## 5. Design

### 5.1 The manifest (`packages/registry-format/src/role-pack.ts`)

A JSON document (the extension manifest in the same package is JSON; one parser style per package).
Schema version 1:

| Field | Type | Rule |
|---|---|---|
| `schema` | `1` | required; any other value is refused |
| `id` | string | required; must match the gateway's `PACK_ID_RE` (restated in registry-format, since it imports nothing from the gateway; a test pins the two equal) |
| `name` | string | required, 1–80 chars, display only |
| `version` | string | required, semver `MAJOR.MINOR.PATCH` |
| `description` | string | required, ≤ 500 chars |
| `roles` | string[] | optional role tags, each `^[a-z][a-z0-9-]{0,31}$`, ≤ 8 (Project 5 matches on these) |
| `suggestedConnectors` | string[] | ordered, ≤ 32, each a connector-id shape; existence is checked by the gateway against the catalog, not by the format |
| `members` | string[] | extension ids; the format validates the shape, the gateway refuses non-empty (`ERR_PACK_MEMBERS_UNSUPPORTED`) |
| `defaults` | string | the pack-layer TOML fragment, ≤ 65,536 bytes; the format checks only type and size, the gateway's `checkPackFragment` is the authority |

**Unknown top-level keys are refused** at schema 1. Project 2 (`sourceMapping`) and Project 4
(`desktop`) add their fields when they ship, with the consumers that read them; accepting them now
with no reader would let a pack carry data nothing validates.

`defaults` is TOML text rather than a structured object so that what the owner approves and what is
written to `<id>.toml` are the same bytes, and no TOML serializer is needed. Visible agents and
fleet jobs live in `defaults` (`[agents] visible`, `[[fleet.job]]`), not in separate manifest
fields, so there is one source for each.

Exports: `parseRolePackManifest(text: string): RolePackManifest` (throws the package's existing
error type with a field path), the `RolePackManifest` type, and `rolePackDigest(m: RolePackManifest)`
— the SHA-256 hex (the package's existing hash) of the package's `canonicalize` output over the
**whole parsed manifest**. Digesting the parsed object, not the text, gives a bundled pack (a static
JSON import, already an object) and a local file (text, parsed first) the same digest for the same
content, and whitespace or key order never counts as a change. A change to `description` alone does
count, and is handled in § 5.4.

### 5.2 The registry index `pack` entry (`index-format.ts`)

The signed index gains an optional top-level `packs` map that **mirrors the extension entry
shape exactly** (`index-format.ts` — read its parser before writing this one): `id → versions →
version → { manifest: { path, sha256, size }, channel, publishedAt }`, with the canonical manifest
path `packs/<id>/<version>/manifest.json` enforced the way `extensions/<id>/<ver>/manifest.json`
is (`index-format.ts:125-130`). Ids use `PACK_ID_RE`. There is **no package/tarball field** (a pack
is its manifest alone) and **no `publisher` key**: who may sign a pack is the trust layer's
decision (Phase 9.5 project 3), which adds that field as a schema change when it does.

It is parsed, validated and covered by the existing index signature. **Blast radius:** a malformed
`packs` map must not break extension installs or updates. The parser validates `packs` separately
and, on failure, drops the whole `packs` map and records why (surfaced by `nimbus registry list`),
rather than failing the index — so a bad pack entry published to a registry can never stop an
extension update. The gateway's registry client otherwise ignores `packs`. Tests: a valid entry
parses; a malformed one is dropped with a reason while the index's extensions still parse; a signed
index with `packs` verifies.

### 5.3 Where packs come from

- **Bundled:** `packages/gateway/src/packs/bundled/pm.json` and `devops.json`, statically imported
  so `bun build --compile` embeds them. A test parses both with `parseRolePackManifest`, runs their
  `defaults` through `checkPackFragment` and `checkPackFleetJobs`, checks every suggested connector
  against the catalog and every visible agent against `CATALOG_AGENT_NAMES`, and installs both into
  one temp profile to prove they do not conflict.
- **Local file:** `nimbus pack install --file <path>`. The CLI reads the file and sends its text;
  the gateway refuses it in a production runtime (the compiled release binary, or
  `NODE_ENV=production` — reuse the predicate I44 uses for `http:` registries) with
  `ERR_PACK_LOCAL_FILE_PRODUCTION`. A local-file pack whose id equals a bundled pack's id is
  refused, so a file cannot impersonate a first-party pack.

### 5.4 Installed record and updates

Next to each layer the store keeps `<id>.pack.json`: `{ id, version, digest, source:
"bundled" | "file", installedAt }`. The record and the layer are written in one store operation;
`active.json` stays the single "is it active" authority, written last (Project 1's order). A
listed pack with a missing or unreadable record is reported in `pack list` as `version unknown`
and treated as "update available" for a bundled id.

`pack list` / `pack show` compare a bundled pack's installed record with the bundled manifest: a
different digest is **update available** (shown with both versions). `nimbus doctor` warns once per
profile with an update available. Re-running `nimbus pack install <id>` on an installed pack is the
update: the prompt shows only the difference — scalars added/removed/changed, visible agents
added/removed, fleet jobs added/removed/changed by name, suggested connectors added/removed — and
an approval replaces the layer and record. An identical digest is a no-op with "already installed",
no prompt. A different digest whose `defaults` text is byte-identical (only display fields such as
`description` or `suggestedConnectors` changed) still prompts, with the config sections reading
`no change`: the record is only ever rewritten after an approval, so there is one write path.

### 5.5 `pack.install` — the gate

New HITL action type `pack.install`:

- in the I2 frozen set (`engine/executor.ts`);
- on I20's delegate-fallback list (a delegate never approves it), next to `registry.add`;
- executed through a gate-only executor with `NULL_EGRESS_SINK` (I29: a local mutation, no
  egress), built where `registry.add`'s is — `ipc/server/dispatchers.ts`
  (`buildExtensionGateExecutor`, around `:2269`) — and handed to `ipc/pack-rpc.ts` as an
  `ownerGate`, exactly as `registry-rpc.ts` receives its own;
- displayed by its own branch in `formatConsentPrompt` (`engine/executor.ts`, as
  `extension.migrate` has at `:281`), **not** the generic `Details: <JSON>` line: the generic path
  runs `redactPayloadForConsentDisplay`, whose substring name matching would blank config-key
  names, and cannot render § 5.6;
- refused on a demo-rooted gateway (`ERR_DEMO_FORBIDDEN`, `ipc/server/demo-gate.ts`), I41.

Fixed order in the handler, each step refusing before the next:

1. Resolve the manifest: bundled by id, or local-file text (production refusal, id-collision
   refusal, § 5.3).
2. `parseRolePackManifest`; refuse non-empty `members`.
3. Validate content against the live gateway: `checkPackFragment` + `checkPackFleetJobs` on
   `defaults`, connector ids against the catalog, conflict check against the profile's other active
   packs, so a conflict is refused **before** the prompt with the conflicting keys named. Unknown
   visible-agent names are refused here too (catalog names: e.g. `ownership`, not `owners`). The
   store's conflict check is private today (`pack-layer-store.ts:253`) and reachable only through
   the writing `setPackLayer`, so the store grows a **non-writing**
   `checkPackLayer(profile, packId, fragment): readonly string[]` (the same allowlist, job and
   conflict checks, returning problems) that `setPackLayer` itself calls — one check, two callers,
   so the dry run and the write cannot disagree. `checkPackLayer` is read-only and unconfined.
4. Build the prompt (§ 5.6) and raise `pack.install` through the gate on the calling session.
5. On approval, call `setPackLayer` (which re-runs the checks, closing the window between prompt
   and write) + write the record. On deny/timeout, write nothing.

The prompt shows the § 5.6 summary **and the full `defaults` text verbatim** (escaped), so the
owner sees the exact bytes that will be written, not only a derived summary. On an update the diff
summary comes first and the full new text follows. The audit row records pack id, version, source
and digest — never the text.

Static rule (proposed **D36**): `setPackLayer(` is named only by `packs/pack-layer-store.ts` and
`packs/pack-install.ts` (the gate module), aliased imports included; stated bound: a dynamically
composed call evades a text scan, so capability confinement — only the install module is handed the
store's write half — is the real defense. A new invariant (proposed **I47**: a pack layer is
written only after the owner approved `pack.install` over a prompt that showed those exact
`defaults` bytes) gets the triple rule (wiring + `docs/SECURITY-INVARIANTS.md` +
`security-invariants.test.ts`).

**The `members` refusal is permanent and caller-independent** until Phase 9.5 project 3 builds the
member chain — not a desktop-only guard. Project 4 inherits it as is; when the chain lands, the
overview's "refuse member packs from the desktop" rule becomes that project's to add.

### 5.6 What the prompt shows

Header: pack name, id, version, source (`bundled` / `local file <path>`). Then, each section printed
even when empty (`none`):

- **Config defaults** — each scalar key with the value the pack sets, the current effective value
  and the layer it comes from (`config explain`'s data), and `(your file overrides this)` where the
  user layer wins so the pack value will have no effect.
- **Visible agents** — the names the pack adds.
- **Overnight jobs** — each job's name, agent, interval, and `(replaced by your own job of this
  name)` where applicable; plus whether `[fleet] enabled` ends up true.
- **Suggested connectors** — in order, marked `connected` / `not connected`. Display only; the pack
  connects nothing.
- A fixed closing line: the pack changes no credentials, no network reach and no approvals, and
  your `nimbus.toml` is not edited; `nimbus pack remove <id>` undoes it.

Any pack-supplied string shown (name, description) is escaped the way the captures prompt escapes
agent strings, since a local-file pack is author-controlled text.

### 5.7 `pack.remove`, `pack.list`, `pack.show`

- `pack.remove { id }` — no approval. Calls `removePackLayer` and deletes the record. Unknown id is
  `removed: false`, not an error. Refused on a demo gateway.
- `pack.list` — per active profile: installed packs (id, name, version, source, update state) and
  the bundled packs not installed. Reports the store's `skippedPacks` / `packListError` so a broken
  layer is visible.
- `pack.show { id }` — the manifest summary plus, when installed, the installed record.

All four are CLI-only in this project: the whole `pack` namespace joins `FORBIDDEN_OVER_LAN`, and
none is on the Tauri allowlist (Project 4 decides that). Each needs both the handler and the outer
routing entry in `ipc/server/dispatchers.ts`, proven by an e2e test over a real socket.

### 5.8 CLI

`nimbus pack list [--json]`, `nimbus pack show <id> [--json]`,
`nimbus pack install <id> | --file <path>`, `nimbus pack remove <id>`. All act on the active profile
(Project 1's rule; no `--profile` flag in this project). `install` is TTY-only with no `--yes`,
matching `extension approve` and `captures accept`; stated as a CLI-side guard, not gateway-enforced.

### 5.9 `[oncall.push] enabled` becomes pack-settable and live

Add it to `PACK_SETTABLE_KEYS` as `reactive`. The push runtime must pick up a change without a
restart, and **two** things read `enabled` today, both from the boot-time config object: the store
state (`reconcileEnabledState` in `push-runtime.ts`) and the runner's own gate
(`push-runner.ts:179`, `if (!deps.config.enabled) return … "disabled"`), with
`OncallPushRuntime.config` exposed as a frozen field (`push-runtime.ts:20`). Flipping only the
store would leave the runner disabled after an install, or still pushing after a remove. So:

- the runner reads `enabled` through a live accessor (`isEnabled(): boolean`) instead of
  `deps.config.enabled`;
- that accessor watches the layered snapshot version (the fleet supervisor's pattern) and, on a
  change, re-reads `[oncall.push]` and calls `reconcileEnabledState(enabled, now)`, preserving the
  existing "enabling never backfills history" rule (a re-enable records a fresh `enabled_at`);
- every reader of `OncallPushRuntime.config.enabled` moves to the accessor (grep them; the frozen
  field may keep the other keys).

Only `enabled` is live in this project; the other `[oncall.push]` keys keep their boot-time read,
and `chatops_namespace` stays off the allowlist. A test installs and removes a pack carrying
`enabled = true` against a running runtime and asserts the runner's verdict flips both ways.

### 5.10 The two packs

**PM** (`pm`, version `1.0.0`, roles `["product"]`):
- suggested: `slack`, `jira`, `notion`, `google_drive`
- `[agents] visible = ["decisions", "glossary", "catchup"]`
- `[fleet] enabled = true`; one job `pm-decisions-nightly`, agent `decisions`,
  `interval_seconds = 86400`
- The Google Drive suggestion is in place for Project 2, which makes Google Docs a decision source.
  Until then the decisions pass does not read Drive; `pack show` does not claim it does.

**DevOps** (`devops`, version `1.0.0`, roles `["devops", "sre"]`):
- suggested: `pagerduty`, `github`, `github_actions`, `slack`, `sentry`
- `[agents] visible = ["oncall", "why", "impact", "ownership", "catchup", "changelog", "standup"]`
- `[fleet] enabled = true`; one job `devops-changelog-nightly`, agent `changelog`,
  `interval_seconds = 86400`
- `[oncall.push] enabled = true`

Both set `[fleet] enabled = true` — the same value, so no conflict under the scalar rule. Job params
are whatever `checkPackFleetJobs` requires for the agent; the builder fills them from the agent's
param kind.

## 6. Security notes

- The pack approval never stands in for any other approval: no member extensions are installable,
  and the allowlist excludes every key that widens egress, execution, network reach, HITL, identity
  or indexing scope (overview § 4).
- `[oncall.push] enabled` widens no egress by itself: the push is local (a stored brief, a gateway
  event, an OS toast). The ChatOps headline post needs `chatops_namespace`, which a pack cannot set.
- Removing a pack is never gated, matching every other revoke.

## 7. Done when

- `nimbus pack install pm` on a fresh profile shows the § 5.6 prompt, one approval writes the layer,
  and `config explain fleet.enabled` names the pm layer — with no restart, and the fleet picks up
  the job.
- `nimbus pack install devops` alongside it succeeds; `[oncall.push] enabled` takes effect live.
- `nimbus pack remove pm` leaves the user's files byte-identical and returns `config explain` and
  the fleet job set to their pre-install values.
- A non-allowlisted key in a local-file pack, a non-empty `members`, a conflicting scalar, a
  local-file pack in a production runtime, and a call from a demo gateway or over LAN are each
  refused, before any prompt.
- A changed bundled manifest shows "update available" and re-install prompts with only the diff.

## 8. Calls made (for the owner to check)

- JSON manifest with `defaults` as a TOML fragment string, so approved bytes = written bytes.
- Unknown manifest fields refused; Projects 2 and 4 add theirs with their readers.
- The installed record is a sidecar file next to the layer, not a DB table (no migration; packs
  are already per-profile files).
- `pack.*` stays off the Tauri allowlist until Project 4.
- A local-file pack may not reuse a bundled pack's id.
- `install` is TTY-only with no `--yes`.
- Only `[oncall.push] enabled` goes live; the other `[oncall.push]` keys stay boot-time.
- "Nightly" is `interval_seconds = 86400` under idle admission; the fleet has no wall-clock
  schedule.
- New invariant I47 and static rule D36 (numbers are the next free ones; the builder confirms).
- The prompt shows the full `defaults` text verbatim after the summary, so I47 is about the exact
  bytes; the audit row carries id/version/source/digest only.
- The digest covers the whole parsed manifest, canonicalised; a display-only change still prompts.
- The `pack` index entry mirrors the extension entry (canonical path, sha256, channel,
  publishedAt), with no publisher key; a malformed `packs` map is dropped, never failing the
  index, so it cannot block extension updates.
- The `members` refusal is permanent and applies to every caller until Phase 9.5 project 3.

**Builder check (2026-10-24)** found four code facts the first draft got wrong, all corrected
above: the agent is `ownership`, not `owners`; `[oncall.push] enabled` is read by the runner
as well as the store; `registry.add`'s gate executor is built in `dispatchers.ts`; the store's
conflict check had no non-writing entry.

## 9. Left to the builder

PR split (a natural one: registry-format format + index entry; gateway install/remove/list + gate +
CLI; bundled packs + `[oncall.push]` live + update/doctor); exact error codes beyond those named;
the record file's write order inside the store; the prompt's exact wording within § 5.6; fleet job
params per agent; test layers.
