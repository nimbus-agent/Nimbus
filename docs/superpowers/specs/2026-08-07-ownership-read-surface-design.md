# Ownership read surface — `agents.ownership` — design

**Date:** 2026-08-07
**Spine slot:** S1 (Local Brain) — PR B of the ownership-graph item
**Branch:** `dev/asafgolombek/ownership-agent`
**Predecessor:** PR A — `82c03d27` (#1064), schema **V51**
**Schema:** **none.** This PR adds no migration.
**Supersedes:** [`2026-08-06-ownership-graph-design.md`](./2026-08-06-ownership-graph-design.md) **§9 only**
(the PR A/PR B delivery split). That spec's data model, scoring, clearing discipline and honesty
limits remain authoritative and are cited throughout.

---

## 1. Summary

PR A derives an ownership graph on every connector sync and writes it to SQLite. **Nothing reads
it.** This PR makes it observable, as a built-in read-only agent:

```text
agents.ownership  { path? , service? }   → { sessionId } → ownership.briefReady
ownership.refresh { }                    → { jobId }     → ownership.passDone
```

Three request modes, one brief shape: **by path** (file or directory), **by service**, or **neither**
(a coverage summary). Plus `nimbus owners`, and — because the agent is a member of
`AGENTS_RPC_HANDLERS` — `POST /v1/agents/ownership` with no new HTTP route.

No new connectors, no LLM in the read path, no network, no migration, no new security invariant.

---

## 2. Why an agent, not an `ownership.*` IPC namespace

The predecessor spec's §9 scoped PR B as `ownership.forPath` / `ownership.forService` /
`ownership.status` plus a `nimbus owners` CLI, and deferred an agent to a follow-up. Its stated
reason (§3, "Explicitly out of scope") was concrete and, at the time, correct:

> Registering in `AGENTS_RPC_HANDLERS` would collide directly with the in-flight HTTP-agents PR 2,
> which restructures that map and derives its `GET /v1/agents` route from it.

**That constraint is gone.** HTTP-agents PR 2 merged as `4b4bedb4` (#1063). Verified at
`origin/main` = `82c03d27`:

- `AGENTS_RPC_HANDLERS` (`ipc/agents-rpc.ts:561`) is a stable 12-entry `as const satisfies
  RpcMethodHandlerMap<AgentsRpcContext>`.
- `HTTP_AGENT_NAMES` (`:605`) is **derived** from it by `Object.keys` minus
  `HTTP_EXCLUDED_AGENT_METHODS`, so an agent added to the map reaches `POST /v1/agents/{agent}` and
  `GET /v1/agents` with **zero** route work and no second list to keep in sync.
- No PR is open against `agents-rpc.ts`. `gh pr list` at spec time returns only
  `release-please--branches--main`. HTTP-agents PR 3 (resolve-by-URL) has not started.

Delivering as an agent therefore reaches **CLI + HTTP + MCP** where the `ownership.*` split reached
**CLI + Tauri**, for less code: `emitBriefWithSynthesis`, the `briefReady` contract, the CLI entry
pattern and the I29 egress append are all inherited rather than rebuilt.

### 2.1 One premise correction: MCP exposure is not free

The owner decision that prompted this spec said the agent "gets HTTP invocation plus MCP exposure
for free". HTTP is genuinely free — `HTTP_AGENT_NAMES` is derived. **MCP is not.** The MCP tool
surface is a hand-maintained `DEFS` array in `packages/cli/src/mcp/agent-tools.ts:140` — ten entries
today, each with its own tool name, description and zod schema. Those ten, plus `peekWhy` (registered
separately, outside `DEFS`) and the six index tools, make `TOOL_SPECS` 17 (`mcp/adapter.test.ts:905`);
of the twelve served agent methods, MCP exposes eleven — all but `agents.preflight`. Exposing
`agents.ownership` is one new `AgentToolDef` plus two count assertions
(`mcp/adapter.test.ts:905`, `:588`). Small, but real, and in scope here.

---

## 3. Scope

**In scope**

- `agents.ownership` — the read agent, its brief type, and its deterministic renderer.
- `ownership/ownership-store.ts` — read queries over the PR A graph.
- `ownership/ownership-target.ts` — caller path → `{repoRoot, relPath}` resolution.
- `ipc/ownership-rpc.ts` — `ownership.refresh`, mirroring `ipc/decisions-rpc.ts`.
- `nimbus owners` CLI + registry entry.
- The MCP `AgentToolDef`.
- Tauri `ALLOWED_METHODS` 103 → 104.
- The three deferred minors from PR A (§6), plus the `service`-entity metadata gap (§6.4).

**Explicitly out of scope**

- No migration. The graph tables, relation types and `ownership_pass_state` all exist at V51.
  (If a later PR does need one it must take **V52+** — V50 and V51 are both permanently consumed;
  see the predecessor spec §4.)
- No `--rebuild`. §6.3 explains why it would be a synonym.
- No change to `agents/_lib/why-subject.ts`. §5.2 explains how the one case it rejects is handled
  without touching it.
- No CODEOWNERS / reviewer / changed-file ingestion; no teaching `nimbus expert` to consume these
  edges. Both stay where the predecessor spec §11 left them.
- No new security invariant, no new HTTP route, no `WRITE_ROUTE_ALLOWLIST` change (§7).

---

## 4. The read contract

### 4.1 Request

| Mode | Params | Meaning |
| --- | --- | --- |
| Path | `{ path: string }` | A file **or** a directory. Absolute, or relative to a configured root. |
| Service | `{ service: string }` | A `[ci.service.<id>]` / `[metrics.dora.<id>]` id. |
| Summary | `{}` | Coverage: `ownership_pass_state` counters plus the bound services. |

`path` and `service` together → `-32602`. Two ways to name a subject in one call is a request the
gateway cannot satisfy without silently preferring one, and a silent preference is the failure mode
this spec is most concerned with everywhere else.

Bounds mirror the siblings in `ipc/agents-rpc.ts`: `path` is `MIN_FILE_LEN..MAX_FILE_LEN`
(1..2048, `:61-62`), `service` is non-empty up to `MAX_SERVICE_LEN` (64, `:65`). These exact
constants are reused, not re-declared, and are mirrored into the MCP zod schema so the calling model
reads the bound off the tool definition rather than discovering it through a `-32602` — the rule
`agent-tools.ts:14-21` already states.

### 4.2 Response

`{ sessionId }`, then an `ownership.briefReady { sessionId, brief, findings }` notification, per the
`nimbus-agent-patterns` contract. `findings` is `OwnershipBrief`:

```ts
export type OwnershipOwner = {
  externalId: string;   // person id, or `git:<normalized-email>`
  label: string;
  share: number;        // 0..1, the graph_relation.weight
  resolved: boolean;    // false when the id is the `git:` fallback
};

export type OwnershipTargetView = {
  kind: "source_file" | "directory" | "service";
  displayPath: string;
  owners: OwnershipOwner[];
  ownerCount: number | null;        // pre-threshold total; null = not recorded
  ownersAboveFloor: number | null;  // survived min_share; null = not recorded
  truncated: boolean | null;        // the CAP bit; null = not determinable
};

export type OwnershipBrief = {
  kind: "ownership";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { path: string | null; service: string | null };
  target: OwnershipTargetView | null;   // null in summary mode / unresolvable path
  parentDirectory: OwnershipTargetView | null;
  service: { id: string } | null;
  coverage: {                            // ownership_pass_state, verbatim
    lastPassAt: number | null;
    lastDurationMs: number;
    rootsTotal: number; rootsCovered: number; rootsWithRemote: number;
    filesCovered: number; filesExcluded: number;
    servicesBound: number; ownersEmitted: number; entitiesReaped: number;
  };
};
```

`ownerCount` / `ownersAboveFloor` / `truncated` are **nullable on purpose**. See §6.1.

---

## 5. Design

### 5.1 Placement

| File | Responsibility |
| --- | --- |
| `ownership/ownership-store.ts` | **new** — read queries over `graph_entity` / `graph_relation` / `ownership_pass_state`. No writes. |
| `ownership/ownership-target.ts` | **new** — caller path → `{repoRoot, relPath}` + entity-kind probe. |
| `agents/ownership.ts` | **new** — the agent: coordinator lanes, gap notes, `emitBriefWithSynthesis`. |
| `agents/_lib/ownership-types.ts` | **new** — `OwnershipBrief` and friends. |
| `agents/_lib/render.ts` | **edit** — `renderOwnership`. |
| `agents/_lib/synthesize.ts` | **edit** — `SynthInput` + two dispatches (§5.4). |
| `agents/_lib/emit-brief.ts` | **edit** — `AnyBrief`, a **third** copy of the same union (§5.4). |
| `ipc/agents-rpc.ts` | **edit** — handler + map entry + `newSessionId` kind. |
| `ipc/ownership-rpc.ts` | **new** — `ownership.refresh`. |
| `ipc/server/{dispatchers,options}.ts` | **edit** — `tryDispatchOwnershipRpc`, `ownershipRefresher`. |
| `ipc/lan-rpc.ts` | **edit** — `"ownership"` into `FORBIDDEN_OVER_LAN`. |
| `platform/assemble.ts` | **edit** — `ipcOpts.ownershipRefresher` (§6.3). |
| `ownership/ownership-pass.ts` | **edit** — §6.1 + §6.4 metadata only. |
| `ownership/ownership-refresh.ts` | **edit** — §6.2 error class only. |

The read module is separate from `ownership-pass.ts` because that file is already 26 KB of write
path; a reader living inside it would inherit its imports (`dbRun`, `upsertGraphEntity`) and make
"this module never writes" an unverifiable claim rather than a structural one.

### 5.2 Target resolution — and the root-set trap

**The root set must span BOTH sources.** `ownership-target.ts` enumerates roots with:

```ts
gitAwareRootPaths(
  loadNimbusFilesystemRootsFromConfigDir(configDir),
  loadRegisteredRoots(configDir),
)
```

— `index/registered-roots-store.ts:111`, the exact call `platform/assemble.ts:555` hands the pass.

This is load-bearing, and it is the single most likely defect in this PR, because the obvious thing
to copy is wrong. `agents/why.ts` resolves its roots through `whyRoots(ctx)`
(`ipc/agents-rpc.ts:424`) = `loadNimbusFilesystemRootsFromConfigDir(ctx.configDir)` — **TOML roots
only**. `why` can afford that: it spawns `git blame` against a live file, and a root the user never
put in `nimbus.toml` is legitimately outside its fence. The ownership pass cannot: it aggregates
`git_blame_line`, which `registerFilesystemRootSyncables` populates over the **merged** set, so a
TOML-only reader would report "no ownership data" for every path under a `nimbus index add` root
while the pass had indexed it, ranked it and written its edges.

`gitAwareRootPaths` is the SSoT for that merged set and carries the doc comment saying so
(`registered-roots-store.ts:96-110`). It delegates to `mergeRoots`, so TOML wins on a same-path
collision and a root whose folder has been deleted is dropped with a stderr warning — a deleted
root's edges therefore become unreachable by path lookup, which §8 records as a limit rather than
leaving it to be discovered.

**Path → `{repoRoot, relPath}`.** Delegates to `matchConfiguredRoot`
(`agents/_lib/why-subject.ts:40`), which is the reviewed containment fence: it rejects a `../`
escape in both the absolute and the relative branch *before* touching the filesystem. Two
adaptations, both local to `ownership-target.ts`:

1. **The root itself.** `matchConfiguredRoot` returns `null` when `rel === ""` (`:49`, `:57`) —
   correct for `why`, where the subject must be a file. But the ownership graph *has* a root
   directory node: `directoryAncestors` terminates with `""` (`ownership-pass.ts:36-44`) and the
   rollup writes `dir:<root>:` with `label = root` (`:505`). So `nimbus owners .` from a repo root
   must resolve. `ownership-target.ts` checks the is-a-root case itself, against the same merged
   root list, **after** `matchConfiguredRoot` returns null — the fence still runs first on every
   input, and `why-subject.ts` is not modified. Extending that shared helper with an `allowRoot`
   flag was considered and rejected: one caller's needs should not reshape a security primitive
   another agent depends on.
2. **Shape adaptation.** `gitAwareRootPaths` returns `string[]`; `matchConfiguredRoot` takes
   `readonly NimbusFilesystemRootToml[]`. The wrapper maps each path to the minimal record the
   helper reads (it uses only `.path`, `:48`/`:55`).

**Entity-kind probe.** With `{repoRoot, relPath}` in hand, look up `file:<root>:<rel>` then
`dir:<root>:<rel>` in `graph_entity.external_id`. Exactly one can exist for a given path. Neither →
a gap note (§8), never an error and never a guess.

Note the resolver reads the filesystem only through `matchConfiguredRoot`'s injectable `exists`
parameter, so tests supply a fake and no test depends on a real tree.

### 5.3 Lanes

Path mode runs four `AgentCoordinator` sub-agents in parallel, following the `subAgent(fn)` helper at
`agents/decisions.ts:31` (a synchronous DB read wrapped as a `SubTask`, fanned out at `:208`):

1. Owners of the resolved target + its entity metadata.
2. Owners of the **parent directory** — the answer to "who do I ask" when the file itself has one
   committer, which is the common case for new or small files.
3. The service this path rolls up to, by walking
   `workspace(filesystem:<root>) --tracks_remote--> repo --belongs_to--> service`.
   Both hops are type-scoped on **both** endpoints: `belongs_to` is polysemous — `graph-populator.ts`
   also emits `issue --belongs_to--> repo` and `message --belongs_to--> channel` — and the
   predecessor spec §6 pins both endpoint types for exactly this reason on the write side.
4. `ownership_pass_state`, for coverage and the gap notes.

Service mode runs lanes 1 and 4 against the `service:<id>` entity. Summary mode runs lane 4 alone
plus an enumeration of `service` entities.

Every lane is a local SQLite read — no LLM, no `Bun.spawn`, no network — so the 15 s interactive
budget is not in question; the LLM appears only in the optional `emitBriefWithSynthesis` prose pass,
identically to every other brief.

### 5.4 The brief union is declared THREE times, and its dispatch falls through

`OwnershipBrief` must be added to three separate hand-maintained unions, none of which references the
others:

1. `agents/_lib/synthesize.ts:48` — `SynthInput`.
2. `agents/_lib/emit-brief.ts:16` — `AnyBrief`, the constraint on
   `emitBriefWithSynthesis<B extends AnyBrief>`. **Miss this one and `agents/ownership.ts` does not
   compile** — which is the benign failure of the three, because the compiler says so.
3. `agents/_lib/synthesize.ts`'s two dispatches, `deterministicRender` (`:61`) and `toolNameFor`
   (`:75`).

The third is the dangerous one. Both dispatches end in a **bare fall-through** —
`return renderHuddle(brief)` and `return "agents.huddle"` — not an exhaustiveness check. Extending
the union without extending both dispatches therefore **compiles, runs, and renders an ownership
brief as a huddle**, reporting itself to the LLM as `agents.huddle` into the bargain. Nothing fails.

**This PR closes the trap class rather than stepping around it.** Both dispatches get an explicit
`huddle` arm followed by an exhaustiveness guard:

```ts
if (brief.kind === "huddle") return renderHuddle(brief);
return assertNeverBrief(brief);   // (x: never) => never
```

Every member of the union carries a distinct `kind` string literal (verified across `findings.ts`,
`why-types.ts`, `glossary-types.ts`, `decisions-types.ts`), so `SynthInput` is a proper discriminated
union and the guard is a genuine compile-time check — the **twelfth** agent then cannot repeat this
mistake at all, because omitting an arm becomes a type error instead of a wrong brief.

The runtime behaviour change is safe and is an improvement: `synthesize` is awaited inside
`emitBriefWithSynthesis`'s `void (async () => …)()`, whose `.catch` (`emit-brief.ts:59`) emits
`<agent>.briefError` with the message. An unreachable-in-practice throw therefore degrades to a
named error notification, where today the same condition degrades to a *plausible wrong answer*.

This is a small edit to a file every agent shares, so it is called out explicitly rather than folded
in silently. §9 keeps the behavioural test regardless — the guard proves no arm is *missing*, the
test proves the arm that exists is the *right* one, and neither substitutes for the other.

### 5.5 `ownership.refresh`

`ipc/ownership-rpc.ts` mirrors `ipc/decisions-rpc.ts` (which is 70 lines): an
`OwnershipRpcError` carrying `rpcCode`, a module-level `LongRunningJobRegistry`, and a `startPass`
returning `{ jobId }` with `ownership.passProgress` / `passDone` / `passError` notification methods.

Like decisions and unlike glossary, there is no "disabled" precondition to check: `ownershipRefresher`
is constructed at all only when `[ownership].enabled` (`assemble.ts:551`), so an absent refresher
surfaces as "Method not found" one level up in `tryDispatchOwnershipRpc` — the same structure
`decisions-rpc.ts:27-31` documents.

`OwnershipPassSummary` has no `discoveryComplete` analogue — the pass processes the whole root set
each run — so `passDone` carries the summary verbatim.

**`ownership.refresh` takes no parameters, and this is a safety property rather than tidiness.**
Every input the pass needs is re-read from `nimbus.toml` and `registered-roots.json` inside `runPass`
(`assemble.ts:554-570`), exactly as `decisions.refresh` ignores its `_p` (`decisions-rpc.ts:67`).
The reason to keep it that way is specific: `runOwnershipPass` clears `person --owns--> service` and
`repo --belongs_to--> service` **wholesale** on every pass and re-emits only what is reachable from
`opts.roots`, so its documented caller contract is that `opts.roots` must be the COMPLETE root set
(predecessor spec §6). A caller-supplied `roots` — or any narrowing filter — would therefore not
merely scope the run: it would **erase** the ownership of every service the omitted roots bind, and
report success. A tuning knob (`halfLifeDays`, `minShare`) is a milder version of the same problem,
producing a graph that disagrees with the configured policy until the next sync silently overwrites
it. Params are rejected outright rather than validated, so there is no shape to get wrong later.

---

## 6. The four writer-side corrections

Three were logged as deferred minors during PR A. The fourth is the same defect class, found while
designing the read that surfaces it.

### 6.1 `truncated` conflates the floor with the cap

`rankOwners` (`ownership-pass.ts:60`) filters by `minShare` and *then* slices to `maxOwners`:

```ts
.filter((e) => e.share >= minShare)
.sort(...)
.slice(0, Math.max(0, maxOwners));
```

Both call sites then record `truncated: ranked.emitted.length < ranked.totalOwners`
(`:478`, `:509`), where `totalOwners = weights.size` — the count **before either step**. So
`truncated` is true whenever *any* owner fell below the 5 % floor, even when the 10-owner cap never
came near binding. A file with 23 contributors of whom 3 clear 5 % reports `truncated: true` with
`ownerCount: 23` while emitting 3 edges — and a read surface rendering that faithfully says
"showing top 3 of 23", which is false twice over: nothing was capped, and the 20 missing owners were
excluded by a share floor the sentence never mentions.

This was tolerable while nothing read it. PR B is what reads it.

**Fix.** `rankOwners` returns a third count:

```ts
{ emitted, totalOwners, aboveFloor, totalWeight }
//   aboveFloor = count surviving the minShare filter, BEFORE the slice
```

and both call sites — plus §6.4's new one — write:

```ts
metadata: {
  ownerCount: ranked.totalOwners,
  ownersAboveFloor: ranked.aboveFloor,
  truncated: ranked.emitted.length < ranked.aboveFloor,   // the CAP bit, alone
  totalWeightedLines: ranked.totalWeight,
}
```

The brief can then state two distinct facts: *"3 of 23 contributors hold at least 5 %"* and, only
when the cap actually bound, *"showing the top 10 of 14 above the floor"*.

**Reading rows PR A already wrote.** `ownersAboveFloor` is absent from every row on disk until the
next pass runs. `OwnershipTargetView.truncated` is therefore `boolean | null`, and the store returns
`null` — not `false`, and not the stale boolean — when `ownersAboveFloor` is missing. A stale-shaped
row yields "the pre-truncation breakdown is not recorded for this path; re-run `nimbus owners
--refresh`" rather than a confident wrong sentence. `null` here means exactly one thing, *not
recorded*; it is never also used for "no truncation".

### 6.2 Refresher errors are plain `Error`s

`ownership-refresh.ts:85` and `:88` throw bare `Error("ERR_OWNERSHIP_STOPPED: …")` /
`Error("ERR_OWNERSHIP_PASS_RUNNING: …")`. An IPC caller can only string-match, and a message edit
silently becomes a wire-contract break.

**Fix.** Mirror `decisions/decision-refresh.ts:4` exactly:

```ts
export class OwnershipRefresherError extends Error {
  readonly rpcCode: number;
  constructor(message: string) {
    super(message);
    this.name = "OwnershipRefresherError";
    this.rpcCode = -32000;
  }
}
```

Both throw sites converted; `ipc/ownership-rpc.ts` maps it to `RpcMethodError` the way
`dispatchers.ts:1012` does for `DecisionsRpcError`.

### 6.3 `run()` has never had a production caller

`platform/assemble.ts` constructs `ownershipRefresher` (`:551`), triggers it post-sync (`:596`) and
registers `stop()` (`:2085`) — but, unlike `decisionsRefresher` (`:2369`), **never assigns it into
`ipcOpts`**. `run()` is unreachable in production today.

**Fix.** Add `ownershipRefresher?: OwnershipRefresher` to `ipc/server/options.ts`, assign it in
`assemble.ts`, and add `tryDispatchOwnershipRpc` beside `tryDispatchDecisionsRpc`
(`dispatchers.ts:997`).

**And verify the guards under a real caller**, which is the point of the minor. `run()`
(`ownership-refresh.ts:78-100`) shares `running`/`dirty` with the debounced `fire()`. Three
behaviours are asserted in §9, not assumed: a second `run()` during a pass rejects with
`ERR_OWNERSHIP_PASS_RUNNING` rather than starting a concurrent pass (two passes both clear and
re-emit `owns` edges and would race); `run()` after `stop()` rejects with `ERR_OWNERSHIP_STOPPED`;
and a `trigger()` arriving mid-`run()` still fires exactly one follow-up via the `dirty` re-fire in
the `finally` block.

**No `--rebuild`.** Glossary and decisions need one because their stores accumulate across passes
and hold vetoes. The ownership pass clears and re-emits wholesale every run (predecessor spec §6,
"Clearing discipline"), so a rebuild verb would be a synonym for refresh. Shipping both would imply
a difference that does not exist.

### 6.4 `service` entities carry no metadata at all

`ownership-pass.ts:552` upserts the `service` entity with `type` / `externalId` / `label` / `service`
and **no `metadata`** — unlike `source_file` (`:471`) and `directory` (`:502`). Its owners are ranked
by the same `rankOwners` call (`:558`) under the same floor and cap, so a service's owner list is
truncated identically and has no recorded counts to say so.

That makes `{ service }` — the one lookup the whole `workspace → repo → service` bridge exists to
serve — structurally unable to state its own truncation, which is §6.1's defect in the mode that
matters most.

**Fix.** Write the same metadata object at `:552`, computed from the `rankOwners` call already made
five lines below; hoist that call above the upsert. Six lines, one integration assertion.

The read-time alternative — re-walking `repo → workspace → root-directory` metadata and summing —
was rejected: it re-derives a number the pass already holds, can disagree with it, and creates a
second ranking implementation to keep in sync with the first.

---

## 7. Security posture

**No new invariant.** Read-only derivation over already-indexed local data.

- **I13 — `WRITE_ROUTE_ALLOWLIST` stays at 13.** `POST /v1/agents/{agent}` already exists (PR 2,
  `4b4bedb4`) and `HTTP_AGENT_NAMES` is derived from `AGENTS_RPC_HANDLERS`, so an agent reaches HTTP
  with no route change. Verified: the allowlist's count assertions are
  `security-invariants.test.ts:425`, `:1542` and `ipc/http-write-routes.test.ts:124`, all 13, and
  **none of the three is edited by this PR**. If an implementer finds themselves changing one, the
  design has been misread — stop and re-read this paragraph.
- **I29/D22 — inherited, not extended.** `agents.ownership` becomes a member of
  `AGENTS_RPC_HANDLERS`, and the egress append at `agents-rpc.ts:651` is gated on
  `Object.hasOwn(AGENTS_RPC_HANDLERS, method)`, so an MCP- or HTTP-originated ownership brief
  appends its row automatically. D22(d) — no file outside `ipc/agents-rpc.ts` may import an
  `agents/<name>.ts` emitter — is satisfied because `agents/ownership.ts` is imported there and
  nowhere else. The CLI reaches it over IPC, never by import.
- **I7 — Tauri 103 → 104.** `agents.ownership` only. `ownership.refresh` is a maintenance verb that
  re-derives the graph, and the renderer must not reach it — exactly the split
  `gateway_bridge.rs:519` (`allowlist_decisions_brief_only`) already enforces for
  `agents.decisions` vs `decisions.refresh`/`rebuild`. That test's own comment explains why the
  count assertion alone is insufficient (a one-for-one substitution leaves it green), so this PR
  adds the parallel named test rather than relying on `allowlist_exact_size`.
- **I5 — LAN.** `"ownership"` joins `FORBIDDEN_OVER_LAN` (`lan-rpc.ts:10`). `checkLanMethodAllowed`
  (`:144`) tests `FORBIDDEN_OVER_LAN.has(namespace) || FORBIDDEN_OVER_LAN.has(method)`, so that one
  string forbids `ownership.refresh` over the wire while `agents.ownership` — namespace `agents` —
  stays admitted by default-allow, matching `glossary` and `decisions` (`:50-62`).
- **I9 / I14** — all reads are bound-param; the store performs no writes at all. The §6 writer edits
  keep using `dbRun` / `upsertGraphEntity`.
- **I1** — no new child process. The read path never spawns; `git remote` stays in the pass.

---

## 8. Honesty and failure posture

Every degradation is partial and named. The brief never returns an error for a legitimately empty
answer.

| Condition | Behaviour |
| --- | --- |
| Path outside every configured root | Gap note listing the configured roots. No lookup, no guess. |
| Path resolves but has no `source_file`/`directory` entity | Gap: not indexed, or excluded by `ignore_globs`, or reaped after deletion. `filesExcluded` is quoted as the concrete number. |
| Path under a root whose folder was deleted | `mergeRoots` drops it (`registered-roots-store.ts:87`), so it is unresolvable. Gap says the root is missing, not that the path is unowned. |
| `ownersAboveFloor` absent (row written by PR A) | `truncated: null`; the brief says the breakdown is not recorded and suggests `--refresh`. Never a stale boolean. |
| `rootsTotal = 0` | Coverage summary states no git-aware roots are configured — the predecessor spec's single most common cause of an empty graph. |
| `lastPassAt = null` | Gap: the pass has not run; remediation `nimbus owners --refresh`. |
| Service id not in the graph | Gap distinguishing "no such service configured" from "configured but no repo binding" (`servicesBound` disambiguates). |
| No `tracks_remote` edge for the root | Path and directory ownership still returned; the service lane reports no binding and why. |
| `[ownership].enabled = false` | `ownership.refresh` → Method not found; `agents.ownership` still serves whatever the graph last held, with a gap saying the pass is disabled. |

**The five standing limits** from the predecessor spec §7 are stated *in the brief*, following the
`decisions` precedent of stating limits per-read rather than absorbing them silently — and each is
backed by a counter so it is a fact, not a disclaimer:

1. Coverage is limited to git-aware roots (`rootsTotal` / `rootsCovered`).
2. `MAX_BLAME_FILES = 400` per root per tick, so early runs are genuinely partial
   (`filesCovered`).
3. **Blame measures who wrote lines, not who is accountable.** No CODEOWNERS, no reviewers, no
   PagerDuty rotation is indexed. Unconditional — this is the one every reader must see.
4. Service rollup requires both a `[ci.service.<id>]` declaration and a matching origin remote
   (`servicesBound`, `rootsWithRemote`).
5. Vendored/generated/lock paths inflate one author's share; the default `ignore_globs` covers the
   common cases but not project-specific generated paths (`filesExcluded`).

Limits 1, 2, 4 and 5 are emitted **only when their counter shows they bit** — a brief over a fully
covered, fully bound root says nothing about coverage. Limit 3 is unconditional. A standing
disclaimer readers learn to skip is worse than none, which is the rule
`nimbus-agent-patterns` records from the decisions work.

---

## 9. Testing

Per `nimbus-testing`: real SQLite, fresh temp dirs, no DB-layer mocks.

**Unit — target resolution** (`ownership-target.test.ts`)

- Absolute path inside a root; relative path resolved against a root; the **root itself** (`.` and
  the absolute root path) resolving to `dir:<root>:`.
- `../`-escape rejected in both branches, with and without the joined path existing on disk.
- **A path under a registered-only root (in `registered-roots.json`, absent from `nimbus.toml`)
  resolves.** Red-prove it: substitute `loadNimbusFilesystemRootsFromConfigDir` for
  `gitAwareRootPaths`, watch this test fail, revert exactly. This is the §5.2 trap and it is the
  reason this test exists.
- A root whose folder is missing is skipped, and its paths report the missing-root gap.

**Unit — `rankOwners`** (`ownership-pass.test.ts`, extended)

- 23 owners, 14 above a 0.05 floor, cap 10 → `emitted = 10`, `aboveFloor = 14`, `totalOwners = 23`,
  `truncated = true`.
- 23 owners, 3 above the floor, cap 10 → `emitted = 3`, `aboveFloor = 3`, **`truncated = false`**.
  This is the assertion the current code fails; write it first and watch it fail.
- Cap exactly equal to `aboveFloor` → `truncated = false` (the off-by-one boundary).
- Existing decay, rollup and tie-break tests unchanged.

**Unit — params** (`agents-rpc.ownership.test.ts`)

- `{}`, `{path}`, `{service}` accepted; `{path, service}` → `-32602`; over-length and non-string
  values → `-32602`.

**Unit — synthesize** (`_lib/synthesize.test.ts`)

- An `OwnershipBrief` renders through `renderOwnership`, **not** `renderHuddle`, and
  `toolNameFor` returns `agents.ownership`, **not** `agents.huddle`. Red-prove by deleting one arm
  and watching each assertion fail independently (§5.4).
- Every one of the eleven pre-existing kinds still routes to its own renderer and tool name — the
  regression net for rewriting both dispatches. Cheap: one table-driven test over the union.
- The exhaustiveness guard is proven at **compile** time, not runtime: deleting an arm must make
  `bun run typecheck` fail. Verify it once by hand during implementation and record the result in
  the PR description; a runtime test cannot observe a type error, and asserting on the thrown
  message instead would test the unreachable branch rather than the guard.

**Unit — refresher guards** (`ownership-refresh.test.ts`, extended)

- Concurrent `run()` rejects with an `OwnershipRefresherError` whose `rpcCode` is `-32000` and whose
  message carries `ERR_OWNERSHIP_PASS_RUNNING` — asserted on the **class**, not on the string alone,
  so §6.2 is what the test proves.
- `run()` after `stop()` → `ERR_OWNERSHIP_STOPPED`.
- `trigger()` during `run()` fires exactly one follow-up pass, not zero and not two.

**Integration** (`ownership-store.test.ts`) — seed `git_blame_line` + config, run the real pass, then:

- Path mode over a file: owners ranked by share, parent-directory lane populated, service lane
  resolved through both hops.
- Path mode over a directory, and over the repo root.
- Service mode: owners plus the §6.4 metadata counts.
- Summary mode with `rootsTotal = 0`, and with a populated graph.
- A path whose entity exists but has zero `owns` edges (all lines excluded by `ignore_globs`).
- A `source_file` row written **without** `ownersAboveFloor` → `truncated` is `null` and the brief
  says so (the §6.1 back-compat case).
- The `belongs_to` type-scoping: seed an `issue --belongs_to--> repo` edge and assert the service
  lane does not follow it.

**E2E** (`test/e2e/scenarios/ownership.e2e.test.ts`)

- Brief contains the expected sections; zero HITL (the agent source imports neither `ToolExecutor`
  nor `HITL_REQUIRED`); `ownership.briefReady` fires with non-empty `brief` and `findings`.
- An `agents.ownership` call from a `kind: "mcp"` client appends exactly one `egress_ledger` row
  with `source_type = 'mcp'`; from the HTTP surface, exactly one with `'http'`; from CLI, zero.

**Cross-cutting**

- `GET /v1/agents` returns 11 names including `ownership`.
- Rust: `ALLOWED_METHODS.len() == 104`; `is_method_allowed("agents.ownership")` true;
  `is_method_allowed("ownership.refresh")` false.
- `checkLanMethodAllowed("agents.ownership", peer)` does not throw;
  `checkLanMethodAllowed("ownership.refresh", peer)` throws.

**Test hygiene.** Any test reading a source file resolves paths from `import.meta.dir`, never the
process CWD. Every guard in this list is red-proven — break the thing it protects, watch it fail,
revert exactly — because four tests shipped in PR A that passed whether the feature worked or not.
After any patch-based edit, grep the mutated file to confirm the mutation applied before trusting a
green run.

**Coverage.** `packages/gateway/src/agents/` has an ≥80 % line gate and the repo-wide per-file floor
is ≥85 % line / ≥80 % branch. PR A failed CI at 75 % branch on `ownership-refresh.ts` because the
gate was treated as unverifiable locally. It is not: `scripts/coverage-floor/build-lcov.sh` builds
lcov via istanbul preloads. Run it for every new and edited file **before** the first push.

---

## 10. Count deltas

| Site | Now | After |
| --- | --- | --- |
| `AGENTS_RPC_HANDLERS` (`ipc/agents-rpc.ts:561`) | 12 | 13 |
| `HTTP_AGENT_NAMES` — derived (`:605`) | 10 | 11 |
| `ipc/agents-rpc.test.ts:638` exact-list assertion | 10 | 11 (`ownership` sorts between `janitor` and `why`) |
| `agent-runs/agent-http-e2e.test.ts:154` | 10 | 11 |
| `newSessionId` kind union (`:195`) | 11 | 12 |
| `gateway_bridge.rs:535` `ALLOWED_METHODS.len()` | 103 | **104** |
| `mcp/agent-tools.ts:140` `DEFS` | 10 | 11 |
| `mcp/adapter.test.ts:905` `TOOL_SPECS` | 17 | 18 |
| `mcp/adapter.test.ts:588` withheld | 11 | 12 |
| `WRITE_ROUTE_ALLOWLIST` (3 assertion sites) | 13 | **13 — unchanged** |
| `CURRENT_SCHEMA_VERSION` | 51 | **51 — unchanged** |

**Two of these counts are spelled out in prose inside test *names*, where no assertion catches them
and no compiler sees them.** Both must be edited alongside the assertion, or the suite ships a green
test whose name states a falsehood:

- `ipc/agents-rpc.test.ts:637` — `"is exactly the ten asynchronous, non-preflight agents"` → eleven.
- `cli/src/mcp/adapter.test.ts:904` — `"the six index tools plus peekWhy plus ten agents"` → eleven.

**Docs:** `docs/architecture.md` (IPC catalogue), `docs/cli-reference.md`, `docs/CHANGELOG.md`,
`docs/roadmap.md` (S1 row), `packages/docs/src/content/docs/user-guide/agents.mdx`,
`.claude/commands/nimbus-{agent-patterns,file-map,commands}.md`, and `packages/cli/src/commands/registry.ts`.

---

## 11. Deliberately deferred

- **Reverse lookup** (`--person <email>` → everything they own). No PR A machinery needs it and it
  overlaps `nimbus expert`; it is a clean follow-up once the forward reads have shipped.
- **Teaching `nimbus expert` to consume these edges.** Its `subBlame` lane queries `item`/`person`
  for `service = 'github'` and does not read `git_blame_line` at all. Rewiring it couples a PR to
  another agent's brief shape and e2e tests — it belongs on its own, as the predecessor spec §11
  already recorded.
- **Per-`(person, path)` raw line counts.** Not stored by design (predecessor spec §5.5); a consumer
  needing them recomputes from `git_blame_line`.
- **Resolve-by-URL (`canonical_url`).** HTTP-agents PR 3's territory, and it must take **V52+**.
