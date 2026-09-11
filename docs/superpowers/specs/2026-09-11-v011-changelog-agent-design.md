# `nimbus changelog` — the fifteenth built-in agent

> **Status: PROPOSED.** No code in the branch yet. This is the argument before
> the build, per the convention #1464 established.
>
> **Slot:** the v0.1.1 CLI batch, second row (after `nimbus index health`,
> 2026-09-10). First of a three-row group — `changelog`, `standup`, `oncall` —
> that share one substrate; see § 9.
>
> **Costs nothing new at the invariant level:** no migration, no new security
> invariant, no new egress coverage class, no new HITL action type. It is a
> fifteenth instance of a shape that already ships fourteen times.

## 1. What this is

A Markdown changelog assembled from the local index over a time window: what
merged, what deployed, what broke. Scoped to one service or across all of them.

```text
nimbus changelog --service payment-service --since 7d
nimbus changelog --since 30d --format slack
```

The roadmap row for this command has existed since `v0.1.0` scope-cutting. Its
trigger column reads "engineering work only — uses existing indexed data". That
is **half true**, in the same way `index health`'s was, and § 3 is the honest
accounting.

## 2. Why an agent and not a command

`nimbus index health` and `nimbus stats` are plain CLI-plus-IPC commands. This
one is a built-in agent — `agents/changelog.ts`, `agents.changelog`,
`changelog.briefReady` — for three reasons:

1. **It is a brief.** The output is a structured Markdown document with sections
   and disclosures, which is what the fourteen existing agents produce and what
   `emitBriefWithSynthesis` exists to emit.
2. **It wants synthesis.** A deterministic list of merged PRs is a table; release
   notes are prose over that table. The `[agents] synthesis` machinery
   (`"off"` / `"local"` / `"allow-remote"`) already gates exactly this, with I31
   guaranteeing a rewrite cannot drop a disclosure.
3. **It wants to run overnight.** "The weekly changelog already exists at 09:00"
   is close to the stated purpose of the fleet feature, and fleet jobs invoke
   `agents.*` methods. A non-agent command is not reachable from a fleet job.

**Rejected:** the deterministic-only shape `nimbus fleet digest` uses. It is
cheaper and stays outside I38 by construction, but it forecloses (2) and (3),
and the two rows riding this substrate next want both.

## 3. What the index actually holds — the honest accounting

The roadmap row promises five categories. **The index holds three of them.**

| Row promises | Item type | Event time | Verdict |
| --- | --- | --- | --- |
| PRs merged | `pull_request` | `metadata.merged_at` | ✅ real event time |
| Deployments ran | `ci_run` (`conclusion === "success"`) | `modified_at` | ⚠️ approximation |
| Incidents opened | `incident` | `metadata.opened_at_ms` | ✅ real event time |
| Incidents resolved | `incident` (`metadata.status === "resolved"`) | `modified_at` | ⚠️ approximation |
| Dependency updates | — | — | ❌ **no substrate** |
| Config changes | — | — | ❌ **no substrate** |

`dependencytrack` is a *connector name* and `dependency_missing` is an *error
code*; neither is an indexed item type. No connector indexes changed-file paths,
which is the same reason `decisions` caps its confidence at 0.86.

**Both missing categories are disclosed in the brief and the roadmap row is
corrected in the same PR.** That is the `index health` precedent: the row said
metrics were already collected and named `raw_meta`, a column of the legacy
table that has never existed on the live one. A spec written from the roadmap
would have thrown at runtime.

### 3.1 `item.modified_at` is "last touched", not "when it happened"

This is the load-bearing fact of the whole design. `github-sync.ts:235` says it
outright, in a comment about stats going stale because "an event bumps
`modified_at`". A PR merged in June that received a comment yesterday has
`modified_at` = yesterday.

A changelog windowed on `modified_at` therefore reports **what moved in the
index**, not **what happened** — a materially weaker and quietly misleading
feature. Every category below is windowed on its own event time instead.

## 4. The time model

### 4.1 An open registry, totality-enforced

```ts
type EventTime = { readonly atMs: number; readonly source: "event" | "index" };
type EventTimeExtractor = (meta: unknown, row: ItemRow) => EventTime | null;

const EVENT_TIME = {
  merged_pr:         …,
  deployment:        …,
  incident_opened:   …,
  incident_resolved: …,
} satisfies Readonly<Record<ChangelogCategory, EventTimeExtractor>>;
```

The `satisfies Readonly<Record<…>>` shape is copied deliberately from
`FLEET_DIGEST_EXTRACTORS` and `FLEET_ELIGIBILITY`: adding `commit`, `ticket` or
`release` later becomes **one entry plus its test**, and forgetting the entry is
a compile error rather than a silently absent category.

### 4.2 Filter on the event field directly — no `modified_at` pre-filter

The obvious optimisation is to pre-filter on the indexed `modified_at` column
and refine in TypeScript, justified by "a later event only bumps `modified_at`
forward".

**That justification does not hold here.** `item-store.ts:128` writes
`modified_at = excluded.modified_at` — a wholesale replacement, **not**
`MAX(modified_at, excluded.modified_at)`. Monotonicity is therefore a property of
each upstream API's `updated_at` semantics, not a local guarantee, and the
failure mode if it breaks is the worst kind: a merged PR silently missing from
the changelog, with nothing stating it was dropped.

So each lane filters on its event field directly, exactly as DORA's
`selectAttributionIncidents` does:

```sql
WHERE i.type = 'pull_request'
  AND json_valid(i.metadata)
  AND json_extract(i.metadata, '$.merged_at') >= ?
  AND json_extract(i.metadata, '$.merged_at') <= ?
```

Cost is a scan bounded by `idx_item_type`. On a personal-scale index that is
acceptable, and it is the same trade DORA already made and shipped.

### 4.3 Guard discipline, inherited not invented

`json_extract` **raises** on malformed JSON in this position, so `json_valid`
guards every use. The extracted value is then re-checked in TypeScript with
`typeof === "number"`, because connector-written metadata could hold a string
there and SQLite would compare it by type ordering rather than numerically.
Both rules are lifted verbatim from `dora.ts` (`:353`, `:388`).

### 4.4 A missing `merged_at` is a filter, not a fallback

`github-sync.ts:86` writes `merged_at` **only on a merged PR**, and writes
nothing rather than `NaN` when the parse fails. So its absence means "not
merged" and the row is excluded from the category outright. There is no
approximation case for merged PRs — a cleaner outcome than the general
fallback rule.

### 4.5 The two approximations, and why they are a standing note

Deployment time and incident-resolution time are both `modified_at`. Neither is
a degradation this design chose: `dora.ts:317` uses exactly the same basis, with
`:331` noting that for a resolved incident `modified_at` is "effectively
RESOLUTION time".

They are therefore disclosed as a **standing note stating the basis** — that
deploy and resolution times match the basis `nimbus metrics dora` uses — rather
than a per-entry "approximate" marker. A per-entry marker on every row of two of
the four categories is noise that readers learn to skip, and it would imply the
number is unreliable when it is in fact the project's established definition.

**One inherited caveat is disclosed with it:** a resolved incident whose row has
not been re-synced still reads `triggered` (`dora.ts:361`), so "incidents
resolved in this window" under-reports by sync lag.

## 5. Brief shape and disclosure (I31)

`ChangelogBrief` (`agents/_lib/changelog-types.ts`, `kind: "changelog"`) carries
the window, the service filter, the per-category entry arrays, per-category
counts, and the gap set.

`## Gaps` is renderer-constructed and re-attached verbatim, never passed to the
model — so a rewrite cannot drop it by construction rather than by check.
Registered in `RESERVED_HEADINGS_BY_KIND`, which is
`Readonly<Record<SynthInput["kind"], readonly string[]>>` and therefore total.

Interleaved disclosures, each needing an anchor in `brief-disclosures.ts` —
`disclosure-anchor-coverage.test.ts` fails the build if a sentence is added
without one:

1. **Preamble window clause.** Qualifies every count below it, so it sits in the
   preamble rather than a section (`markdown-sections.ts`'s `preambleBody`).
2. **The time-basis note** (§ 4.5), covering deploys and incident resolutions.
3. **The sync-lag caveat** on resolved incidents.
4. **The missing-categories note** (§ 3).
5. **A truncation count**, if entries are capped.

Per the `brief-disclosures.ts` rule, each sentence's anchor is a factual
fragment and never its variable tail, and `anchors` is a **list** — a `line`
carrying two independent disclosures needs an anchor for each, which is the
defect observed on `negotiate` where a rewrite kept sentence 1 and dropped
sentence 2.

**Disclosure 4 is unconditional**, following `ownership`'s precedent. A
conditional note would be absent exactly when the reader most needs it, and
mistaking "no dependency updates listed" for "no dependency updates happened" is
the specific failure this brief invites.

## 6. Registration surface

### 6.1 Compiler-forced — the build fails until each is done

| Site | What it forces |
| --- | --- |
| `SynthInput` (`brief-kinds.ts`) | in turn forces both `synthesize.ts` dispatch arms, via `assertNeverBrief` |
| `RESERVED_HEADINGS_BY_KIND` | total over `SynthInput["kind"]` |
| `AGENTS_RPC_HANDLERS` | the served method |
| `FLEET_ELIGIBILITY` | total over `AgentMethod` → set `"eligible"` |
| `FLEET_DIGEST_EXTRACTORS` | total over `EligibleAgentMethod`, unlocked by the line above |

`reserved-sections.ts:77` already anticipates this work by name — "a fifteenth
brief kind".

### 6.2 Hand-maintained — the ones that can be silently missed

- `ipc/agent-param-kinds.ts` — the param kind.
- `packages/cli/src/commands/changelog.ts` + registration in
  `packages/cli/src/index.ts`. The `USAGE` constant is canonical and is copied,
  never reassembled from the flag parser.
- **External exclusion set.** `changelog` stays off HTTP, MCP and ChatOps in
  this PR, with the reason recorded inline the way every other exclusion in
  `agents-rpc.ts` is. Not a subject-matter objection like `negotiate`'s — simply
  that the brief's shape should settle against one consumer before it is
  committed across five surfaces, each with its own count assertion.
- **Tauri allowlist: not added.** No desktop consumer, matching `index.health`.
  The allowlist is the audited surface; adding an unused method widens it for
  nothing.
- **Docs.** `CLAUDE.md` and `docs/SECURITY-INVARIANTS.md` both state I31 covers
  "all **fourteen** brief kinds" and become wrong on merge. Also
  `docs/cli-reference.md`, `docs/CHANGELOG.md`, and the roadmap row correction
  from § 3.

## 7. `--format` and the `briefReady` contract

`brief` is **always** a Markdown string by contract, and synthesis may have
rewritten it.

`--format slack` and `--format plain` are therefore **text transforms over that
Markdown**, not re-renders from `findings`. A re-render would silently discard
the synthesized prose the user asked for — the output would be correct and
quietly not what was requested. `--json` prints `findings`.

**No existing renderer is reused.** `chatops/brief-truncate.ts` exports only
`truncateBrief(markdown, kind, maxBytes)`, a truncator; there is no
Markdown→Slack mrkdwn transform anywhere in the tree today. This is new code,
and it lives CLI-side where `standup` and `oncall` will reuse it (§ 9).

## 8. Testing

- **Unit, per extractor:** malformed JSON, a string where a number belongs, an
  absent field, and the § 4.4 not-merged case.
- **Unit, renderer:** Gaps construction; each of the five disclosures present;
  the unconditional one present even when nothing is missing.
- **Contract:** disclosure anchors, automatically via the existing coverage test.
- **E2E** at `packages/gateway/test/e2e/scenarios/changelog.e2e.test.ts`:
  sections present, `briefReady` emitted with non-empty `brief` and `findings`,
  and zero HITL — the structural check that the source imports neither
  `ToolExecutor` nor `HITL_REQUIRED`.
- **One integration test against the real migrated schema**, not a hand-written
  one. This is the `index health` lesson stated as a requirement: a query
  written from the roadmap's description of the schema would have thrown.
- **Coverage:** `packages/gateway/src/agents/` stays ≥ 80%.
- **Latency:** under 15 s on a mid-range laptop with local routing. Four lanes
  via `AgentCoordinator`; if the budget is missed, the fix is fewer lanes, never
  a longer timeout.

## 9. What this sets up

`standup` and `oncall` are the same feature with a different anchor —
person and incident respectively, against the same window, the same event-time
registry, and the same `--format` renderer. Two things are deliberately built
here for them rather than in them:

- the **event-time registry** as an open, totality-enforced map (§ 4.1);
- the **Slack/plain transforms** CLI-side (§ 7).

Both remain blocked on a separate missing primitive — the gateway has no concept
of which indexed person is its owner. `packages/gateway/src/people/` has no
self, owner, or current-user notion of any kind. That is its own design and its
own PR, and this row does not touch it.

## 10. Explicitly not in scope

- Dependency-update and config-change categories (§ 3) — no substrate; disclosed.
- HTTP, MCP and ChatOps exposure (§ 6.2) — deferred, reason recorded.
- Owner identity, `standup`, `oncall` (§ 9) — separate PRs.
- Posting the changelog anywhere. It is read-only and prints to stdout; sending
  it to Slack is an I23/I27 matter and is not proposed here.
