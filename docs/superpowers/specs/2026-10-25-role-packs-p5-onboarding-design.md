# Role packs — Project 5: role-aware onboarding

**Date:** 2026-10-25 · **Status:** shipped — PR 1 #1781 (0c00274b), PR 2 #1782. Brainstormed with the owner 2026-10-25;
Antigravity review stood in for owner approval (owner's instruction) · **Parent:** `2026-10-21-role-packs-overview-design.md`
§ 5 Project 5 and § 6 (programme proof).

> Per the repo convention this spec lives on `dev/asaf/role-packs` only. Durable content moves to
> `docs/architecture.md` / `docs/roadmap.md` / `docs/cli-reference.md` in the implementation PRs.

---

## 1. Intent

The owner's picture of the first minutes, in their words: a non-developer — a product manager on a
laptop — **picks Product, connects Slack and Jira, and sees decisions.** Onboarding today cannot do
that: the desktop hardcodes six connectors (by display name, which `connector.auth` does not even
accept), `nimbus init` refuses to run outside a git repository, there is no role question
anywhere, and nothing tells a new user what the decisions pass is doing or why it found nothing.

This project makes the first run role-aware on both surfaces, on top of the pack mechanism
Projects 1–4 built, without any pack-specific code (overview § 3 anti-goal: no `if (pack ===
"pm")`).

## 2. Decided by the owner (2026-10-25)

1. **Desktop first.** The desktop app is the PM's surface; `nimbus init` asks the same "What do you
   do?" question for people who start in a terminal, and works outside a git repository.
2. **Product flow:** pick Product → the matching pack is offered with its one `pack.install`
   approval → the pack's connectors are suggested, Slack and Jira first → the user lands on
   Decisions.
3. **While data arrives (A1):** the Decisions step shows live, plain-language progress
   ("Syncing Slack… 1,240 messages", "Looking for decisions… 3 found so far") and decisions appear
   as they are found.
4. **If none are found (B1):** say what was read and why nothing qualified, and offer next steps —
   add a channel, connect Notion or Google Drive, widen the time window.
5. **Other roles:** Engineering, or running `nimbus init` inside a git repository, gets today's
   developer flow (repository + blame setup, CLI login adoption, then `nimbus wow`). Design and
   "Something else" get a neutral start: connector suggestions, no pack.
6. **Existing users who upgrade** get a quiet, once-dismissible "Try a role pack" prompt — never
   the full question.
7. `nimbus demo` stays pinned to its fixed steps (overview § 5).

## 3. Goals, non-goals, anti-goals

**Goals**
1. The programme proof's step 1–2 (overview § 6) works on a fresh install, desktop and terminal.
2. Every role answer changes something real; no answer advertises a pack that does not exist.
3. A new user is never left staring at a blank Decisions page without knowing whether Nimbus is
   still working, finished and found nothing, or cannot work (pass disabled).
4. Connector suggestions and the `nimbus wow` tour follow the active packs.

**Non-goals**
- New packs (Engineering, Design). The role list grows when packs do.
- A generic in-app credential form for every token connector (§ 6.3 states the bound).
- Making the decisions pass report mid-pass progress events (it has no progress hook; § 7 polls a
  status read instead).
- Removing a pack from the desktop (`pack.remove` stays CLI-only; P4's ruling stands).
- Changing what `nimbus demo` runs.

**Anti-goals — it fails even if it works when:**
- Any code branches on a pack id. Role→pack matching uses the manifest's `roles` tags; "lands on
  Decisions" keys on the pack's visible agents, not its id.
- The desktop can install anything but a bundled, first-party pack, or install one without the
  owner seeing the exact `defaults` text (I47).
- An existing user's install is reshaped without them choosing it.
- A non-interactive `nimbus init` inside a git repository (CI, the install smoke tests) behaves
  differently from today.

## 4. The role question

### 4.1 Choices (both surfaces, one rule)

The choices are built from data, never a hardcoded role list:

- **one choice per bundled pack**, labelled with the pack's `name` (`Product`, `DevOps`), in
  `pack.list` order — a pack contributes its choice whether installed or available;
- then three fixed choices: **Engineering**, **Design**, **Something else**.

A pack-backed choice offers that pack. Engineering → today's developer flow. Design / Something
else → neutral start. *(My call: DevOps appears as its own choice because its pack exists and the
owner's rule is "each answer changes something real"; the owner discussed Product, Engineering,
Design and Other only.)*

`pack.list` rows (both `available` and `installed`) gain two additive fields so clients can build
this without a second call: `roles: string[]` and `suggestedConnectors: string[]` (from the
manifest; `[]` for an unreadable installed record). The desktop's `PackListResult` type and the
CLI's structural copy gain the same optional fields.

### 4.2 CLI flag

`nimbus init --role <value>`: `<value>` is a pack role tag (`product`, `devops`, `sre`, matched
against bundled manifests' `roles`), a pack id, or `engineering` | `design` | `other`. Unknown →
usage error (exit 1) listing the accepted values, on any terminal, before the gateway is touched.
Order in `runInit`: `--help`, then the demo-root refusal (unchanged, exit 1), then `--role`
validation, then the question. The flag skips the question; it never skips the
`pack.install` approval.

## 5. `nimbus init`

### 5.1 When the question is asked

| Situation | Behaviour |
|---|---|
| TTY, not `CI=true`, no `--role` | Ask the role question first (a `@clack/prompts` `select`). Cancel = Something else. |
| `--role` given | Use it. |
| Non-interactive, no `--role`, inside a git repo | **Exactly today's flow** (no question, no pack). Protects install-smoke and every scripted use. |
| Non-interactive, no `--role`, outside a git repo | Neutral start (§ 5.3). |

### 5.2 Flow per answer

- **Inside a git repository, any role:** today's root-add + index steps run first, unchanged
  (including `restart-required` / `gateway-unavailable` / `index-failed` outcomes and their exit
  codes). Then:
  - Engineering: today's adoption offer + tour offer. (Today's flow verbatim.)
  - A pack role: the pack step (§ 5.4), then the connector step (§ 5.5). The developer adoption
    offer is skipped (owner decision 5: offered only when relevant to the role); the tour offer
    stays (it now follows the pack, § 8).
  - Design / Something else: the connector step with neutral suggestions; no adoption offer; tour
    offer stays.
- **Outside a git repository:** no root is written and nothing is indexed from the filesystem. The
  gateway is started if it is not running (same `startGateway` path), unless `--no-sync`. Then:
  - Engineering: one line — "No git repository here; run `nimbus init` inside one to index code" —
    then the adoption offer.
  - A pack role: pack step, then connector step.
  - Design / Something else: connector step, neutral.
  No tour offer outside a repository unless the plan has steps (the existing `demo === null` guard
  generalises to "the tour plan would be empty").

### 5.3 Outcomes and exit codes

`InitPlan`'s `not-a-repo` becomes `no-repo` (the plan step still decides it), and `InitOutcome`
gains `{ kind: "no-repo" }` (outside a repository; the gateway part succeeded or was
skipped by `--no-sync`). It exits **0**. The old `not-a-repo` (exit 1) outcome is removed: running
outside a repository is no longer a usage error. Exit 1 now means a usage error (`--role` invalid).
`gateway-unavailable` keeps exit 2 outside a repository too. HELP_LINES, the `Exit codes:` block and
`docs/cli-reference.md` change together. This is not a breaking change (a command that refused now
works; no user action is needed), so no `!`.

### 5.4 Pack step

Interactive only. If the pack is not installed: print one line ("The Product pack sets Nimbus up for
product work — you'll be asked to approve exactly what it changes"), then run the **existing**
`nimbus pack install <id>` path in-process (`runPackWith` with a client that registers the direct
consent prompt handler, exactly as `runPack` does — never an env-selected script handler). Already
installed → one line saying so. A refusal or denial is reported and init continues to the connector
step (the index already succeeded; a declined pack is not a failed init). Non-interactive with a
pack `--role`: print `nimbus pack install <id>` as the next step (the TTY rule in `doInstall`
stands; no `--yes`).

### 5.5 Connector step

Suggestions come from the gateway (§ 6.1). For each suggested connector, one line: display name,
`connected` / `not connected`, and for a not-connected one the command to connect it. On a TTY, for
each not-connected **browser** sign-in connector (§ 6.2), offer "Connect <name> now? (opens your
browser)" → `connector.auth { service }`; a failure prints the gateway's message and moves on.
Others print their terminal command. Ends with next steps: when the pack's visible agents include
`decisions`, "Nimbus looks for decisions after your connectors sync: `nimbus decisions`"; always
`nimbus wow` when the gateway is up.

## 6. Connector suggestions and sign-in

### 6.1 One source of suggestions

`catalog.list` gains `suggestedConnectors: string[]`: the union of the active packs'
`suggestedConnectors` in pack order then manifest order, first occurrence wins; with no active pack,
a neutral default — `google_drive`, `slack`, `notion`, `gmail`, `github`, `linear` (today's six,
as ids; *my call to keep them*). Ids not in the catalog (an unbundled connector, a typo) are
dropped. Both surfaces read this one field, so they cannot disagree. Presentation only, like the
rest of the catalog. The desktop's and CLI's structural `CatalogListResult` types declare
`suggestedConnectors` and `signIn` optional (an older gateway omits them), so existing fixtures
compile unchanged.

### 6.2 How each connector signs in

Built-in catalog connectors gain `signIn: "browser" | "atlassian" | "terminal"`, derived from the
gateway's own auth table, never hand-written per connector:

- `browser` — no PAT handler (`PAT_CONNECTOR_AUTH_HANDLERS`, `ipc/connector-rpc-handlers/auth.ts`)
  and `connectorAuthUnavailableMessage(id) === null`, i.e. exactly the ids `handleConnectorAuth`
  sends down its OAuth PKCE arm: `connector.auth { service }` opens the provider's consent page.
- `atlassian` — `jira`, `confluence` (the `parseAtlassianSiteCredentials` arm): email, API token,
  site URL.
- `terminal` — everything else; the client shows `nimbus connector auth <id>` (or, where
  `connectorAuthUnavailableMessage` answers, that message's command).

`auth.ts` exports one pure `connectorSignInKind(id)` built from that same table, so the derivation
cannot drift from the handler. `catalog/` must not import `ipc/` (boundaries), so `buildCatalogList`
takes `signInFor` and `suggestedConnectors` as injected deps and `ipc/catalog-rpc.ts` supplies them.

### 6.3 Desktop Connect step

The current poll auto-navigates to Syncing the moment ANY selected connector is connected
(`Connect.tsx`), which would eject a user mid-way through a second sign-in; that auto-navigation is
removed. Rewritten to read `catalog.list` (`suggestedConnectors` + per-id `displayName`, `description`,
`signIn`) instead of the hardcoded six, and to call `connector.auth` with the **id** (fixes the
display-name bug). Per tile: `browser` → today's sign-in; `atlassian` → an inline form (email,
API token as a password field, site URL) sent once to `connector.auth` and cleared from component
state after the call returns; `terminal` → a copyable command and "we'll notice when it's
connected" (the status poll picks it up). Connected state comes from `connector.listStatus` as
today. *(My call, the bound this states: the only in-app credential entry is the Atlassian arm,
because the owner named Jira; every other token connector stays a terminal command. A generic form
is a later project. `connector.auth` is already renderer-callable, so the form adds no reach.)*

## 7. The Decisions step (A1 + B1)

### 7.1 `decisions.status` (new, read-only)

A new method in the `decisions.*` namespace (LAN-forbidden by the existing prefix rule; added to
the Tauri allowlist, § 9). Answered even when the decisions pass is disabled (`enabled: false`), so
the dispatcher handles it before its "no refresher → skip" check. Result:

```ts
{
  enabled: boolean;                 // a refresher exists ([decisions] enabled at boot)
  state: "idle" | "running" | "stopped" | "disabled"; // the pass scheduler's status()
  lastPassAt: number | null;        // decision_pass_state
  minConfidence: number;            // the read floor the brief uses
  windowDays: number;               // the brief's default window (90)
  sources: { service: string; type: string; kind: string; items: number }[];
                                    // the EFFECTIVE decision source types (live mapping,
                                    // `typesFor("decisions")`, kind from `kindOf`) that have at
                                    // least one indexed item modified inside the window; zero rows
                                    // are omitted, ordered by items desc then type
  candidates: { pending: number; extracted: number; vetoed: number };
                                    // decision_record rows with decided_at inside the window,
                                    // under `decisionVisibilityFilter` (the brief's read rule;
                                    // `countByStatus` is unwindowed, so this is a windowed sibling)
  shown: number;                    // extracted rows at/above minConfidence in the window
  recent: { statement: string; service: string; at: number }[];
                                    // up to 5 newest shown decisions, statement capped at 280
}
```

Every number uses the **same** mapping, window and visibility filter as `agents.decisions`, so the
step and the brief cannot disagree (the 2b lesson: filter numerator and denominator alike). The
refresher grows `status()` (pass-through of the scheduler's). No schema change.

### 7.2 The step

Desktop, shown at the end of onboarding when the chosen pack's visible agents include `decisions`
(keyed on the agent, never the pack id). It polls `connector.listStatus` and `decisions.status`
every 3 s while the window is visible and renders, in plain words:

- per suggested connector that is connected: "Syncing Slack… 1,240 items" while `status ===
  "syncing"`, "Slack: 1,240 items" after (item noun from the source kind: messages / tickets /
  docs, falling back to "items");
- "Looking for decisions… N found so far" while `state === "running"` or any source is still on
  its first sync; the `recent` list underneath, growing as `shown` grows;
- **done with results** (pass idle, every connected source synced at least once, `shown > 0`):
  the list plus "Open Decisions" → `/briefs/decisions`;
- **done, none found (B1)** (same condition, `shown === 0`): "We read 40 Slack messages and 120
  Jira tickets and found no clear decisions." from `sources`, then the one reason that applies,
  first match wins:
  1. `candidates.pending > 0` → still working, not done (stay in the running state);
  2. `candidates.extracted > 0` but `shown === 0` → "N possible decisions were too uncertain to
     show (below your confidence floor)";
  3. `candidates` all zero → "None of it used decision language like 'we decided' or 'Decision:'";
  then next steps: **Add a channel** (opens Settings → Connectors), **Connect Notion or Google
  Drive** (offers whichever of the pack's suggestions are not connected; sign-in as § 6.3),
  **Widen the window** (opens `/briefs/decisions?sinceMs=<365 days in ms>`; `BriefRun.tsx` reads
  only `useParams` today, so it gains `useSearchParams` to prefill a known param's field from the
  query string — prefill only, the brief still runs only on Run);
- **cannot work** (`enabled: false`): "The decisions pass is turned off in your config
  (`[decisions] enabled`)" — never a spinner.

"Open dashboard" is always available; leaving marks onboarding complete exactly as the Syncing
step does today. Roles whose pack does not show `decisions`, and Design / Something else, keep
today's Syncing step.

## 8. `nimbus wow` follows the active packs

`tour.plan` reads agent visibility (`resolveAgentVisibility` over the live layered snapshot, the
same call `catalog.list` makes). A tour kind whose agent is not in the resulting `visible` set is
skipped with reason `hidden` (`hidden by your role packs` when the basis is `packs`, `hidden in
your config` otherwise — an owner `[agents] hide` hides it too) and never offered; order stays
`TOUR_PRIORITY`. With no packs and no `[agents]` section every agent is visible, so the plan is
unchanged. `buildTourPlan` gains an optional `visible?: ReadonlySet<string>` (omitted = everything visible,
so existing callers and tests are unchanged); `tour-rpc.ts` passes it. The kind→agent map (`owners` →
`ownership`, the rest by name) is a total `Record<TourStepKind, string>` checked against
`CATALOG_AGENT_NAMES` by a test. Demo is untouched: a demo-rooted gateway cannot install packs
(I41), and `nimbus demo` builds its steps in `demo/seed.ts`, not through `tour.plan`.

## 9. Desktop install of a bundled pack (the security change)

`pack.install` joins the Tauri allowlist so the role step and the "Try a role pack" card can
install. `decisions.status` joins it too. Bounds, all gateway-enforced:

- **Renderer = bundled id only.** `pack-rpc.ts` refuses the `fileText`/`filePath` form when the
  connection's declared kind is `ui` (`ERR_PACK_RENDERER_FILE`), before any read. `dispatchPackRpc`
  gains a `fromRenderer: boolean` argument that `tryDispatchPackRpc` fills from
  `ctx.getClientKind(clientId) === "ui"`, exactly as `tryDispatchMigrationRpc` fills I46's
  `fromRenderer` — never a request field. Member packs are already
  refused for every caller.
- The approval is the same `pack.install` HITL action (I2, I20, I41, LAN-forbidden, gate-only with
  `NULL_EGRESS_SINK`), unicast to the calling session; the desktop's HITL popup gains a
  `pack.install` branch that renders the prompt text verbatim as preformatted, scrollable text
  (today it would land in an `<h2>`), with Approve not auto-focused.
- `pack.remove` and `pack.show` stay off the allowlist.
- `pack.install` joins `NO_TIMEOUT_METHODS` (7 → 8) beside `migration.accept`: it resolves only once
  the owner answers, and the bridge's 30 s default would otherwise abandon a call whose prompt is
  still open. The Rust tests that name the pack and decisions allowlist entries
  (`allowlist_pack_list_only`, `allowlist_decisions_brief_only`, `allowlist_exact_size`, the
  no-timeout count) change with it, still asserting `pack.remove`, `pack.show`,
  `decisions.refresh` and `decisions.rebuild` stay out.
- The HITL popup window is 480×360 and not resizable (`src-tauri/src/hitl_popup.rs`); the
  `pack.install` branch puts the prompt text in a scroll container with a bounded height so the
  Approve/Reject footer is always visible; the window stays 480×360 and not resizable, with the
  box capped at 200 px (my call, revised at review: a resizable borderless window misbehaves).
- **Stated bound (I46's shape):** a compromised renderer can answer the prompt it raised. The worst
  it can do is install a first-party bundled pack, which can only set allowlisted, local-only keys
  (overview § 4); removal is ungated and in the terminal.

Invariant **I47** is widened in place (wiring + `docs/SECURITY-INVARIANTS.md` + the invariant test
in the same commit): "…the renderer may call it with a bundled id only…". The Tauri allowlist count
is re-derived (expected 116 → 118; the list, not just the number, is checked) in CLAUDE.md,
GEMINI.md and the `nimbus-tauri-allowlist` skill.

## 10. Desktop onboarding flow

Steps: **Welcome → Role → (Pack) → Connect → Decisions | Syncing**.

- **Role** — the § 4.1 choices as cards (pack choices show the pack's description). Skip setup
  stays on Welcome.
- **Pack** — only for a pack choice not yet installed: "Set up Nimbus for Product", the pack's
  suggestions and visible agents as a readable summary, and **Continue** → `pack.install { id }`.
  The approval popup shows the exact text. Approved → Connect; denied or refused → the error in
  plain words, with "Continue without the pack" (neutral Connect). Already installed → skipped.
- **Connect** — § 6.3, suggestions from `catalog.list` after the install (so they are the pack's).
  "Continue" is enabled once one is connected, or via "Skip for now".
- **Decisions** (§ 7.2) or **Syncing** (today's).

The step header becomes data-driven (Pack shown only when it applies). The onboarding zustand slice
stores connector **ids**.

## 11. Existing users: "Try a role pack"

Desktop: a card at the top of the Dashboard when **all** hold: onboarding already completed or the
index non-empty (not a fresh install), `pack.list` answered without `listError`, no pack installed
in the profile, at least one bundled pack available, and meta key `role_pack_card_dismissed` unset.
Body: "Nimbus can set itself up for your role" + one button per available pack (name +
description) → the Pack step for that pack, then Connect; **Not now** → `db.setMeta
role_pack_card_dismissed` (added to `ALLOWED_META_KEYS`, local-index.ts) and the card never returns.
*(My call: the card, not a modal; dismissal is per install, not per profile.)*

CLI: `nimbus pack list`, when nothing is installed and something is available, ends with one line:
`Tip: nimbus pack install <id> sets Nimbus up for a role (<name>, <name>).` — data-driven from the
available rows.

## 12. Delivery

Two PRs, sequential (PR 2 builds on PR 1's gateway fields):

1. **Gateway + CLI.** (Includes `role_pack_card_dismissed` in `ALLOWED_META_KEYS`, so the desktop
   PR never depends on a gateway change it does not carry.) `pack.list` `roles`/`suggestedConnectors`; `catalog.list`
   `suggestedConnectors` + `signIn`; `decisions.status` + refresher `status()`; `tour.plan`
   visibility; `nimbus init` role question, `--role`, outside-repo outcome; `nimbus pack list` tip;
   docs (`cli-reference`, `architecture`, roadmap P5 row half-done).
2. **Desktop.** Allowlist (`pack.install`, `decisions.status`) + the renderer-bundled-only refusal
   + I47 widening + counts; Role / Pack / Connect / Decisions steps; HITL popup `pack.install`
   branch; the Dashboard card + meta key; docs (desktop onboarding page, roadmap P5 done).

Done when: on a fresh profile, `nimbus init` outside a repo with Product installs the PM pack after
one approval and lists Slack and Jira first; inside a repo non-interactively it behaves exactly as
today (install-smoke unchanged); the desktop runs Welcome → Role (Product) → Pack (one approval) →
Connect (Slack browser, Jira form) → Decisions showing progress, then decisions or the B1
explanation; an upgraded user sees the card once; `nimbus wow` with the PM pack offers only visible
kinds; demo output is byte-identical (`assert-demo-tour.ts` passes).

## 12a. Refinements made while planning PR 1

Recorded here so the spec and plan agree (detail in the PR 1 plan): the question is asked once the
gateway is up — after a successful index inside a repository, after the gateway start outside one —
because starting the gateway before the root is appended would make every first run
`restart-required`; `--role` syntax is checked first and its value resolved against `pack.list`
afterwards (unknown → exit 1, the index already done); outside a repository the tour is not offered;
`decisions.status` has no `extraction` field.

## 13. Constraints inherited

Non-negotiables (platform equality: the CLI select and the desktop on all three OSes; no `any`);
I7/I8 (no remote code, CSP unchanged); I41 (demo refuses `pack.install`; the role question is
never asked in a demo root — `runInit` already refuses there); I47 as widened; presentation-only
visibility (§ 8 hides tour kinds, never refuses an agent); no `readwise` in production examples.

## 14. Left to the builder

File/module names; the exact wording of every line; the poll interval within 2–5 s; how the CLI
`select` renders pack descriptions; the item noun table per kind; test layers (unit for the pure
role/suggestion/status functions, a gateway integration test for `decisions.status` against a real
migrated DB, UI vitest for the steps, an init test for each row of § 5.1).
