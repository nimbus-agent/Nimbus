# Agents That Answer About an Item, and About a File You Are Reading

**Date:** 2026-08-31
**Status:** design — not started
**Slot:** Track 2 → Client surfaces, the browser row (`nimbus-web-clipper`)
**Roadmap:** [`docs/roadmap.md` § Track 2 → Client surfaces](../../roadmap.md#client-surfaces)
**Delivers as:** three PRs, in order — see §5
**Consumers:** the browser client's own spec (`nimbus-web-clipper` →
`docs/superpowers/specs/2026-08-31-lanes-for-every-recognised-page-design.md`) and the SDK's
(`nimbus-sdk` → `docs/superpowers/specs/2026-08-31-connections-and-currency-briefs-design.md`).
This document owns the wire; those two consume it.

---

## 1. Problem

The browser client recognises **nine products** across **six surface kinds** — `pr`, `build`,
`issue`, `home`, `doc`, `incident`. It can run an agent against exactly two of them.

That is not a client defect. It is a supply problem on this side, and it is visible by reading the
param guards in `packages/gateway/src/ipc/agents-rpc.ts` against what a browser page can hand over:

| What the caller has | Agents that accept it |
| --- | --- |
| a pull-request URL | `why` (`prUrl` arm), `impact` (PR arm) |
| a **local** file path | `impact` (symbol arm), `expert`, `ownership` (`path` arm), `ghost`, `conflicts` |
| a free term | `glossary`, `expert` |
| a service id | `catchup`, `decisions`, `ownership` (`service` arm) |
| a time window, unscoped | `huddle` |
| a resource ref + cleanup action | `janitor` |

**No agent takes the URL of an indexed item that is not a pull request.** A Jira issue, a Confluence
page and a PagerDuty incident are all first-class indexed items with rows in `item` and entities in
`graph_entity`, and none of the fourteen built-in agents will accept one as its subject. The browser
panel therefore renders a header, a freshness line, Related, and a glossary box — on a page where
this gateway demonstrably knows more than that.

The second half of the problem is the file. A reader on `github.com/acme/web/blob/main/src/foo.ts`
is looking at a subject five agents can already answer about — but only if they are handed a path
inside a configured filesystem root, which a browser cannot produce and must not try to guess.

---

## 2. Findings that shaped it

### F1 — the resolver this needs already ships

`resolveItemByUrl(db, rawUrl)` (`packages/gateway/src/index/resolve-by-url.ts:123`) is the function
behind `GET /v1/items/resolve`: a URL in, an indexed item out, with `canonicalizeUrl` applied and the
three match kinds (`exact`, `query_stripped`, `path_trimmed`) already settled. Every "answer about
this item" arm in §4.1 is that call plus the agent body that already exists. **No new retrieval is
designed here**, which is the single biggest reason PR 1 is small.

### F2 — `why` gets a third subject field, because widening the second one would be a breaking change

`WhyChangeSubject` (SDK `sdks/typescript/src/agents/brief-types.ts:121`) carries `itemId`,
`entityId`, `repo`, `number: number | null`, `url` and `title`. Five of those six are true of any
indexed item; only `repo` is PR-shaped. So the obvious move is to widen `repo` to `string | null` and
reuse the type for an item.

**That move is wrong, and the SDK is where you find out.** `WhyChangeSubject` is published at
**stability: stable** (`docs/api-surface.md:1164`). Widening a field to nullable breaks every
consumer that reads it as a string, and the SDK's deprecation policy makes a break a **major** bump.
One field's optionality is not cheap here; it is the most expensive option on the list.

The right shape is already established by the type itself. `WhyBrief`
(`docs/api-surface.md:1144`) carries **one optional subject field per arm**:

```ts
subject: WhySubject | null;              // the `ref` arm
changeSubject?: WhyChangeSubject | null; // the `prUrl` arm
```

So the `itemUrl` arm gets a third: `itemSubject?: WhyItemSubject | null`. Purely additive, a
**minor** bump, no consumer breaks, and it follows a precedent the brief set two arms ago rather than
inventing one. `WhyItemSubject` carries the five item-generic fields and no `repo`.

**This document therefore makes no breaking wire change.** Everything in PR 1 is additive.

### F3 — `impact`'s non-PR arm resolves a file to the wrong thing

`resolveStartEntity` (`packages/gateway/src/agents/impact.ts:131`) tries `resolvePrSubject`, then:

```sql
SELECT id FROM graph_entity WHERE type = 'symbol' AND label = ? LIMIT 1
-- and, on a miss:
SELECT id FROM graph_entity WHERE type = 'symbol' AND label LIKE '%' || ? || '%'
  ORDER BY length(label) ASC, id ASC LIMIT 1
```

`symbol` entities are labelled `` `${name} — ${file}` `` (`graph/graph-populator.ts:517`). So a
caller passing `src/foo.ts` never matches exactly, falls into the `LIKE`, and receives **the
shortest-named symbol that happens to be defined in that file** — a confident answer about
`x — src/foo.ts` when the question was about the file. The exact arm is effectively dead for file
input, because no symbol's label is ever a bare path.

Meanwhile `source_file` entities exist and are labelled with the path itself
(`graph-populator.ts:535`: `label: file`, `service: "filesystem"`). The right entity is already
there; the query does not look for it. **PR 2 fixes this**, and it is a correctness fix that stands
on its own merit whether or not a browser ever calls it.

### F4 — the forge→checkout bridge exists in the graph, and nothing exposes it

`bindRootRemote` (`packages/gateway/src/ownership/ownership-pass.ts:395`) writes
`workspace --tracks_remote--> repo`, where the workspace is `filesystem:<repoRoot>` and the repo's
external id is `` `${remote.service}:${remote.ownerName}` `` — i.e. `github:acme/web`
(`ownership-pass.ts:422`, `:428`).

That is exactly the mapping a browser needs and cannot have: **`github:acme/web` + `src/foo.ts` →
`filesystem:<root>` → `file:<root>:src/foo.ts`.** The edge is written for every git-aware root with a
remote. No agent input arm walks it, so the information is present and unreachable.

This finding is what moved the browser's file surface from "client-only, ships immediately" to
"blocked on PR 2". It was found by reading `agents/ownership.ts:110`, which refuses a path "outside
every configured root" — the refusal a browser-supplied repo-relative path would always earn.

### F5 — the graph's edges are typed, so "what is connected" need not be a similarity search

`graph_relation` rows carry a `type`, and the populator writes a real vocabulary: `resolves`,
`correlates_with`, `mentions`, `backlinks`, `reviewed`, `authored`, `opened`, `merged_as`, `targets`,
`belongs_to`, `monitors`, `depends_on`, `derived_from`, `defined_in`, `in_repo`, `upstream_refs`,
`posted`, `tracks_remote`.

This matters because the browser panel **already** shows `POST /v1/clips/related` on these pages. A
"related" agent returning similar items would be a second Related with a spinner in front of it. An
agent returning *named edges* — "PR #482 `resolves` this issue" — answers a different question. §4.3
binds the agent to edge types for that reason, and its brief carries the edge type per neighbour so a
consumer renders the relationship rather than a list.

### F6 — there is no `supersedes` edge, so "is this still true" must be derived and must show its work

Nothing in the populator writes supersession. The currency agent in §4.4 therefore cannot look an
answer up; it derives one from evidence that does exist — an issue whose `resolves` PR merged after
the item's `modified_at`, a doc that `mentions` a PR merged since the doc last changed, an incident
whose state is closed while the doc describing it is not.

That makes it the riskiest of the four capabilities, and it constrains the brief: **every claim
carries the evidence it was derived from**, or the agent reports a gap instead. A bare "this page is
stale" verdict about someone's runbook, with no citation, is worse than silence.

### F7 — HTTP exposure is derived, not declared, and three exclusions are load-bearing

`HTTP_AGENT_NAMES` (`agents-rpc.ts:983`) is `Object.keys(AGENTS_RPC_HANDLERS)` minus
`HTTP_EXCLUDED_AGENT_METHODS`, so a new handler is HTTP-reachable **by default**. The current
exclusions are deliberate and separately reasoned: `preflight` and `premortem` write (queued consent
prompts, paused watcher rows), and `negotiate` would let any holder of an `agents`-scoped token
assemble a contribution dossier on any indexed person. Each has its own e2e test asserting a 404 and
an empty `egress_ledger` (`agent-runs/agent-http-e2e.test.ts:152`, `:166`, `:181`).

The two agents added in PR 3 are pure reads with no HITL consequence, so they belong in the exposed
set — but the count assertion (`expect(agents).toHaveLength(11)`, `agent-http-e2e.test.ts:211`) moves
to 13, and that edit must be made deliberately, in the same PR, with the reason in the diff.

---

## 3. What this delivers

- A Jira issue, a Confluence page, a PagerDuty incident, a Linear issue and a CircleCI pipeline
  become subjects the agents accept — "how did we get here", "who should I talk to".
- A source file open in a browser becomes a subject too, bridged to the reader's own checkout by the
  graph rather than by a guess in the client.
- Two questions no agent answers today: what is connected to this item, and is it still true.
- One correctness fix (F3) that improves `nimbus impact <file>` on the terminal surface as well.

---

## 4. The design

### 4.1 · An `itemUrl` arm on `why`, `expert` and `ownership` (PR 1)

Each arm is: validate the URL, call `resolveItemByUrl`, take the item and its `graph_entity`, and run
the agent body that already exists against that entity.

**`why`.** `requireWhyParams` (`agents-rpc.ts:463`) enforces *exactly one of* `ref` / `prUrl` via
`hasRef === hasPrUrl`. That two-value equality does not generalise; it becomes a count of supplied
arms, rejecting zero and rejecting more than one, with the error naming all three. The `prUrl` arm's
existing guards apply unchanged to `itemUrl`: the length bound and `prUrlHasCredentials` (userinfo
rejection) — a URL out of a browser is exactly the input those were written for.

`runWhy` skips the filesystem-roots read on the `prUrl` arm because that arm has no file subject to
resolve against a root (`agents-rpc.ts:496`). `itemUrl` has none either, so it takes the same skip.

**`expert`.** Its input is `topicOrFile`, and the browser currently sends the item **title** — a
lexical guess that answers "who has touched things whose titles look like this". The `itemUrl` arm
resolves the URL to an item and answers from the entity, which is a different and better question.
The free-text path stays for callers who want it.

**`ownership`.** `requireOwnershipParams` (`agents-rpc.ts:699`) already rejects `path` and `service`
together. `itemUrl` joins that mutual exclusion as a third member; the "pass one, or neither for a
coverage summary" contract is otherwise unchanged.

**Subject.** All three answer with their existing brief shapes. `why` adds a third optional subject
field, `itemSubject`, carrying a new `WhyItemSubject` (F2). `subject` and `changeSubject` are null on
this arm, exactly as `subject` is null on the `prUrl` arm today. Nothing existing changes shape.

**Gaps, not empties.** A URL that resolves to nothing returns the agent's existing gap vocabulary
with a note naming the URL. The browser must distinguish "no answer" from "not indexed", and it can
only do that if this side says which.

### 4.2 · `resolveFileByRemote`, and a forge-file arm on five agents (PR 2)

**The resolver.** One shared function, living beside `resolve-by-url.ts` because it is the same kind
of thing: a client coordinate in, a local entity out.

```text
resolveFileByRemote(db, { service, repo, path }) -> { fileEntityId, repoRoot, path } | miss
```

It walks F4's bridge: `graph_entity` where `type = 'repo'` and `external_id = '<service>:<repo>'`, in
over `tracks_remote` to the `workspace`, then `source_file` by the deterministic external id
`file:<repoRoot>:<path>`.

Miss reasons are distinct and returned, never collapsed: **no such remote is tracked** (the reader
has no local checkout of this repo) versus **the repo is tracked but that path is not indexed**
(checkout exists, file not covered). Those two earn different remediations, and the browser renders
them differently.

**The `impact` fix (F3).** `resolveStartEntity` gains a `source_file` exact-match branch **before**
the `symbol` `LIKE`, so a path resolves to the file. The `LIKE` stays for genuine symbol-name input,
which is what it was written for. This is a behaviour change to a shipped agent on the terminal
surface too, and it is a fix: `nimbus impact src/foo.ts` today answers about one arbitrary symbol
inside `src/foo.ts`.

**The arm.** `impact`, `expert`, `ownership`, `ghost` and `conflicts` each accept the forge-file
coordinate. `requireFileParam` (`agents-rpc.ts:248`) is the shared guard `ghost` and `conflicts`
already use and is the natural home for the new shape, with the same `MIN_FILE_LEN` / `MAX_FILE_LEN`
bounds — measured after trim, on the normalised value, never on the caller's raw string.

**Namespaces stay absent.** `ghost` and `conflicts` fan out to federation peers only when
`namespaces` is supplied (`requireFileParam` → `parseNamespaces`). The browser sends none, and this
arm adds none, so both answer local-only. That is a property worth a test, not a comment.

### 4.3 · `connections` (PR 3)

**Input:** `{ itemUrl }`, resolved by F1. **Output:** the item's neighbours in `graph_relation`, each
carrying its edge `type`, its direction, the neighbour's entity type and label, and the indexed item
behind it where one exists.

One hop by default. A second hop only through edges where transitivity is meaningful (`resolves`
then `merged_as`, so an issue reaches the commit that closed it) — enumerated explicitly, never
expressed as "depth 2".

**It must never rank by similarity** (F5). A neighbour is in the answer because an edge says so, or
it is not in the answer. An empty result is a real answer — "nothing in your index links to this" —
and is reported as one rather than padded.

### 4.4 · `currency` (PR 3)

**Input:** `{ itemUrl }`. **Output:** per-claim evidence, per F6. Each finding names the signal it
came from:

- the item is an issue, and a PR that `resolves` it merged after the item's `modified_at`
- the item is a doc, and something it `mentions` changed after the doc last did
- the item is an incident whose state is closed
- the item has not changed in longer than its type's own norm — the weakest signal, reported as an
  observation rather than a claim

**No verdict without evidence.** Where the signals are absent the agent returns a gap, never a
default "looks current". Recency alone is not a currency claim: the browser already renders age from
`modified_at` and does not need an agent to restate it.

### 4.5 · HTTP exposure

Both new agents are pure reads and join `HTTP_AGENT_NAMES` by the derivation in F7 — no allowlist
edit. The count assertion moves 11 → 13 in the same PR, and the three existing exclusion tests are
extended, not touched: a test asserting `preflight` stays 404 must keep passing verbatim.

---

## 5. Slices

Three PRs. PR 1 is the browser's first unblock and depends on neither of the others.

1. **`itemUrl` arms on `why`, `expert`, `ownership`** — §4.1, plus `WhyBrief.itemSubject` and the new
   `WhyItemSubject`. The one PR with an SDK consequence, and an additive one; it ships first so the
   client can start.
2. **`resolveFileByRemote`, the five forge-file arms, and the `impact` `source_file` fix** — §4.2.
   No new agent, no new brief, no SDK change.
3. **`connections` and `currency`** — §4.3, §4.4, their briefs, and the exposure-count move in §4.5.
   Two new brief shapes; the SDK's guards follow this PR.

---

## 6. Testing

- **Per arm, a resolve hit and both miss reasons.** §4.2's two misses are distinct strings on the
  wire; a test that accepts either is not testing the thing the browser branches on.
- **`why`'s arm count.** Zero arms rejected, each single arm accepted, every pair rejected, all three
  rejected. The current `hasRef === hasPrUrl` shape passes a two-arm suite by accident; its
  replacement must be tested as a count.
- **F3 regression.** `impact`, given a path that exists as a `source_file` and as a substring of
  several `symbol` labels, resolves the file. This test fails against today's code, which is the
  point of writing it first.
- **Local-only fan-out.** `ghost` and `conflicts` through the forge-file arm issue no peer request.
- **`connections` returns no un-edged neighbour.** Seed two items with similar titles and no
  relation; the answer is empty.
- **`currency` returns no un-evidenced claim.** Seed an item with no signals; the answer is a gap.
- **Exposure.** `GET /v1/agents` lists 13; `preflight` / `premortem` / `negotiate` still 404 with an
  empty `egress_ledger`.

---

## 7. Risks and limitations

- **The file surface answers only for repos the reader has checked out locally.** F4's bridge is
  written by the ownership pass over git-aware filesystem roots. A reader browsing a repo they have
  never cloned gets the "no such remote is tracked" miss, forever, and correctly. This is a real
  bound on the browser feature, and both consumer specs must state it rather than discover it.
- **`currency` can be confidently wrong** about a document whose subject moved with no indexed
  signal. §4.4's evidence rule bounds the damage; it does not remove it. If that rule proves
  unsatisfiable in review, cutting `currency` from PR 3 and shipping `connections` alone is the
  correct outcome — not a weakened verdict.
- **`WhyBrief` grows a third subject field**, which reaches every SDK consumer, including ones that
  are not this browser. It is additive (F2) and therefore a minor bump — but a consumer switching on
  "which subject is non-null" now has three cases, and one written against two will fall through on
  an item brief. The SDK spec's guard work is where that is caught.
- **PR 2 changes a shipped agent's behaviour on the terminal surface.** It is a fix, and it will
  still surprise someone who had learned the old output.

---

## 8. Out of scope

- **`janitor`** — takes a `cleanupAction` and is write-shaped. Not a browser subject; not touched.
- **`huddle`** — has no `service` param, so it answers across every connector at once and cannot
  honestly sit on a per-product dashboard. It wants its own surface and its own brief.
- **Closing the SDK's `AGENT_NAMES` lag** for `ownership` / `glossary` / `decisions` / `negotiate` /
  `premortem`. Deliberate there, and unrelated to this work.
- **A `supersedes` edge in the populator.** F6 derives instead. Writing supersession at sync time is
  a larger design with a schema consequence.
- **Any new token scope.** All of this is reachable under the existing `agents` scope.
