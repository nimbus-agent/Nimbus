# Agents That Answer About an Item, and About a File You Are Reading

**Date:** 2026-08-31
**Status:** PR 1 implemented (Nimbus#1421, `itemUrl` on `why`/`expert`/`ownership`); PRs 2 and 3 not started
**Slot:** Track 2 → Client surfaces, the browser row (`nimbus-web-clipper`)
**Roadmap:** [`docs/roadmap.md` § Track 2 → Client surfaces](../../roadmap.md#client-surfaces)
**Delivers as:** three PRs, in order — see §5
**Reviewed:** [design review](./2026-08-31-agents-for-items-and-files-design-review.md) (Antigravity, 2026-08-31) — responses in §9
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

**No agent takes the URL of an indexed item that is not a pull request.** A Jira issue and a
PagerDuty incident are first-class indexed items with rows in `item` **and** entities in
`graph_entity`, and none of the fourteen built-in agents will accept one as its subject. The browser
panel therefore renders a header, a freshness line, Related, and a glossary box — on a page where
this gateway demonstrably knows more than that.

(A Confluence page is an indexed item too, but it has **no** `graph_entity` — see F8. That is why it
is not in scope here, and it is the one place where the panel's current emptiness is honest.)

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

### F8 — a Confluence page has no graph entity, so `doc` cannot have these lanes

Found while planning Task 2, by following the type error in `resolveItemArm` back to what
`resolveItemByUrl` actually returns.

Every lane in §4.1 and both agents in §4.3–§4.4 answer from `graph_relation` edges, which hang off
a `graph_entity`. Graph entities are written by `syncGraphFromIndexedItem`
(`graph/graph-populator.ts:1062`), which returns early twice: once if the item's type is not in
`ITEM_LINKED_ENTITY_TYPES` (`graph/relationship-graph.ts:6`), and again if it has no entry in
`GRAPH_SYNC_BY_TYPE` (`:1018`).

**Confluence pages index as `type: "page"`** (`connectors/confluence-sync.ts:164`), and `"page"`
appears in **neither** list. So a Confluence page is a fully indexed item — it has an `item` row, it
resolves by URL, the browser's header and Related work on it today — and it has **no graph entity at
all**. There is nothing for a lane to walk.

Shipped as originally drafted, every item lane on a `doc` page would have returned an empty answer
or a gap, permanently, for a structural reason no user could act on. That is precisely the failure
this whole arc exists to avoid.

**So `doc` is out of scope for the item lanes**, and the surfaces are `pr`, `issue` and `incident`:

| Surface | Item type | Graph entity? |
| --- | --- | --- |
| `issue` (Jira, Linear) | `issue` | ✅ `syncIssueGraph` |
| `incident` (PagerDuty) | `incident` | ✅ `syncIncidentGraph` |
| `doc` (Confluence) | `page` | ❌ no populator |
| `build` (Jenkins, CircleCI) | `ci_run` | ❌ no populator — not an item-lane surface anyway |

A Confluence page keeps exactly what it has today: header, freshness, Related and the `glossary`
term box. **The condition that reopens this** is a `page` entry in both lists upstream — a graph
populator for wiki pages, which is its own design with its own edge vocabulary (who authored it,
what it mentions, which service it documents). It is not a rider on this work.

`ci_run` has the same gap and is recorded here so the next person does not rediscover it; `build`
was never an item-lane surface, so nothing changes for it.

---

## 3. What this delivers

- A Jira issue, a Linear issue and a PagerDuty incident become subjects the agents accept — "how did
  we get here", "who should I talk to". **Not a Confluence page**: it has no graph entity for a lane
  to walk, and F8 records why and what would change that.
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

**`why`'s six sub-agents do not generalise for free, and this is the largest correction in this
document.** An earlier draft of §4.1 said each arm "runs the agent body that already exists against
that entity". That is false for `why`. `why.ts` fans out to `subAuthorship` (`:352`),
`subPullRequest` (`:457`), `subTicket` (`:533`), `subDiscussion` (`:564`), `subDriver` (`:629`) and
`subDownstream` (`:698`), and their queries are pinned to the arm they were written for.
`ticketRowsForPr` (`why.ts:320`) is the clearest case:

```sql
JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'pr'
WHERE r.from_id = ? AND r.type = 'resolves'
```

Handed an **issue** entity id, that returns zero rows — not because the issue has no context, but
because the query asks the edge in the wrong direction from the wrong entity type. Shipped as
drafted, the item arm would return a well-formed, empty `why` brief on every issue in the index.

So the item arm declares each sub-lane's behaviour explicitly:

| Sub-lane | On `itemUrl` |
| --- | --- |
| `subPullRequest` | PRs pointing **at** the item — `graph_relation` where `to_id = entityId` and `type = 'resolves'`. The inverse of the PR arm's traversal, which is exactly what makes it non-automatic. |
| `subTicket` | Neighbouring issues over `depends_on` / `mentions`. On an item that **is** an issue this is its siblings, never itself. |
| `subDiscussion` | `message` entities related to the item (`mentions`, `posted`). Closest to arm-independent of the six. |
| `subAuthorship` | Skipped. It resolves a file line against a filesystem root; an item has none, exactly as on the `prUrl` arm. |
| `subDriver` | Skipped unless the item reaches a PR through `subPullRequest`, in which case it runs from that PR. |
| `subDownstream` | Skipped. Its subject is changed code. |

**Two kinds of skip, and the existing code already distinguishes them.** `subAuthorship`
(`why.ts:356`) and `subDownstream` (`:702`) open with `if (lane.arm === "change") return {}` — silent,
no gap — and the comment on `LaneInput.arm` says why: they are file/line lanes by nature and
"stay silent on `change` rather than reporting a gap for the file subject a `prUrl` question never
had". The item arm joins that condition unchanged: an item has no file subject either, so a gap there
would report something missing that was never asked for.

The other lanes do apply to an item, so when they find nothing they emit their existing gap notes.
"This lane cannot apply here" (silence) and "this lane applies and found nothing" (a gap) are
different answers, and the arm — not `subject === null` — is what separates them. That distinction is
already load-bearing: the same comment records that inferring it would wrongly silence a genuine
ref-arm resolution failure.

**`arm` is the seam this design extends, not one it adds.** `LaneInput.arm` is already
`"ref" | "change"` and is already passed explicitly rather than inferred. The item arm is a third
member of that union, which is why this is a smaller change to `why.ts` than the sub-lane table
above suggests.

**`expert` has no entity path at all today.** `runExpert` takes `input.topicOrFile: string` and its
five sub-agents — `subBlame`, `subPrAuthored`, `subPrReviewed`, `subIncidentResolved`,
`subChatMentions` (`expert.ts:175`, `:225`, `:253`, `:424`) — run five
`LIKE '%' || ? || '%'` scans over titles and previews. So "answers from the entity" in the earlier
draft named a code path that does not exist.

The item arm therefore adds one: from the item's entity, walk edges into `person` entities
(`authored`, `reviewed`, `opened`, `posted`, and `resolves` back through a PR). The free-text path
stays untouched for callers who want it. This is genuinely new query code, not a rewiring of an
input, and PR 1's estimate must carry it.

**And it is a second SDK dependency, which an earlier draft of this document missed.** `ExpertBrief`
is SDK-owned (`brief-composites.ts:61`) and its query is `{ topicOrFile: string }` — a brief answered
about an item has nothing honest to put there unless the shape grows. The additive fix, matching F2's
reasoning: `query` gains an optional `itemUrl?: string | null`, and `topicOrFile` carries the item
URL on that arm so a consumer reading only the old field still gets the thing that was asked about,
not a fabricated topic. `ownership` needs no such change — its brief is gateway-local (below).

So PR 1's SDK release carries **two** additions, not one: `WhyItemSubject` + `WhyBrief.itemSubject`,
and `ExpertBrief.query.itemUrl`.

**`ownership` cannot answer with its existing brief shape.** `OwnershipTargetView.kind` is
`"source_file" | "directory" | "service"` and `OwnershipBrief.query` is
`{ path: string | null; service: string | null }`
(`agents/_lib/ownership-types.ts:7`, `:27`) — there is no representable target for an item and no
field to record the request in.

The item arm maps the item to its owning service through `belongs_to` and answers with
`kind: "service"`, so no new target kind is introduced. `OwnershipBrief.query` gains
`itemUrl: string | null`, because a brief that cannot say what it was asked is not auditable.
`requireOwnershipParams` (`agents-rpc.ts:699`) already rejects `path` and `service` together;
`itemUrl` joins that mutual exclusion as a third member.

**This costs no SDK release.** `OwnershipTargetView` and `OwnershipBrief` are defined in the
gateway's own `_lib/ownership-types.ts` — only `GapNote` is imported from `@nimbus-dev/sdk` — and
`ownership` is one of the five agents the SDK's `AGENT_NAMES` deliberately omits. The ownership brief
is gateway-owned and changing it is a single-repo edit.

**Subject.** `why` adds a third optional subject field, `itemSubject`, carrying a new
`WhyItemSubject` (F2). On this arm `subject` is **null** and `changeSubject` is **omitted** — not
null. The two are different on the wire and the brief spreads them conditionally
(`...(changeSubject === undefined ? {} : { changeSubject })`) precisely to keep them so under
`exactOptionalPropertyTypes`: a consumer must be able to tell "asked, and unresolvable" from
"never asked". No existing field changes shape.

**Gaps, not empties.** A URL that resolves to nothing returns the agent's existing gap vocabulary
with a note naming the URL. The browser must distinguish "no answer" from "not indexed", and it can
only do that if this side says which.

### 4.2 · `resolveFileByRemote`, and a forge-file arm on five agents (PR 2)

**The resolver.** One shared function, living beside `resolve-by-url.ts` because it is the same kind
of thing: a client coordinate in, a local entity out.

```ts
type ResolveFileResult =
  | { ok: true; fileEntityId: string; repoRoot: string; path: string }
  | { ok: false; reason: "remote_not_tracked" | "file_not_indexed"; repo: string };

resolveFileByRemote(db, { service, repo, refAndPath }): ResolveFileResult
```

It walks F4's bridge: `graph_entity` where `type = 'repo'` and `external_id = '<service>:<repo>'`, in
over `tracks_remote` to the `workspace`, then `source_file` by its external id.

The miss is a **typed discriminant**, not a sentence. Both reasons reach a browser, which branches on
them to say either "Nimbus has no local checkout of this repo" or "that repo is indexed, that file is
not" — and a client that had to match on human-readable prose would break the first time the prose
was improved.

**Why the input is `refAndPath` and not `path`.** A forge file URL is
`…/blob/<ref>/<path>`, and **branch names contain slashes**: `github.com/acme/web/blob/feat/auth-v2/src/index.ts`
splits as ref `feat/auth-v2` + path `src/index.ts`, or ref `feat` + path `auth-v2/src/index.ts`, and
nothing in the URL says which. The browser cannot resolve that ambiguity — it would need the repo's
branch list, which is a forge API call this client will never make.

The gateway can, because it holds the file list. `refAndPath` is the opaque remainder after `/blob/`
(or Bitbucket's `/src/`), and the resolver tries successive split points — shortest ref first —
against the `source_file` entities indexed for the resolved workspace, taking the first suffix that
matches an indexed path. A ref containing a slash costs one extra probe per segment against an
already-scoped set. If no split matches, the reason is `file_not_indexed`, which is the honest answer
for both "wrong split" and "file genuinely not indexed" — the reader's remediation is the same.

**The external id is built by the writer's own function, never re-formatted here.**
`fileExternalId(root, path)` (`ownership/ownership-pass.ts:118`) is `file:${root}:${path}`, and
`syncCodeSymbolGraph` builds the byte-identical string (`graph-populator.ts:535`) — the convergence
is deliberate and commented as such. A third formatter in this resolver would be a third thing to
keep in step. It imports and calls the existing one.

That matters most on Windows, where nothing in the codebase normalises separators: `repoRoot` is a
native path (`C:\gitrep\acme-web`) and the browser's `refAndPath` is always POSIX. The resolver
normalises the incoming path to the separator convention the indexer actually writes — determined by
reading the indexer, not assumed — and a Windows test pins it.

**Remote identity is compared case-insensitively.** `parseRemoteUrl` (`ownership/repo-remote.ts:40`)
already handles both URL forms, strips `.git`, and lower-cases the **host** for its service lookup —
but it returns `ownerName` verbatim from the remote (`repo-remote.ts:70`). So a checkout cloned from
`github.com/ACME/Web` stores `github:ACME/Web` while the browser's address bar yields
`github:acme/web`, and an exact-match lookup misses. The resolver compares case-insensitively rather
than rewriting stored ids, because lower-casing them would change existing `graph_entity` external
ids and need a migration for a problem a comparison solves.

A remote on an unrecognised host — an SSH alias like `github.com-work` — already fails closed:
`HOST_TO_SERVICE.get` returns undefined, `parseRemoteUrl` returns null, and no `tracks_remote` edge
is written at all. That surfaces as `remote_not_tracked`, which is correct.

**More than one workspace can track one remote, and here that is the common case, not the edge
case.** `tracks_remote` runs workspace → repo, so every git worktree and every second clone of the
same repository registered as a filesystem root adds another workspace pointing at the same `repo`
entity. Walking the edge backwards returns a set.

The resolver picks deterministically: **first the workspaces that actually index the requested
path** — a worktree on a branch where the file does not exist is not a candidate — and among those,
the most recently indexed, with the entity id as a final tie-break so the answer is stable across
runs. Picking arbitrarily would make the same URL answer differently on consecutive calls.

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

**Wire.** Method `agents.connections`, notification `connections.briefReady` (the convention every
agent follows — `impact.ts:123`, `conflicts.ts:94`), brief discriminant `kind: "connections"`.

```ts
type ConnectionNeighbour = {
  edgeType: GraphEdgeType;          // closed union — see below
  direction: "inbound" | "outbound";
  entityId: string;
  entityType: string;
  label: string;
  item: { id: string; service: string; type: string; title: string; url: string | null } | null;
};

type ConnectionsBrief = AgentBriefBase & {
  kind: "connections";
  query: { itemUrl: string };
  neighbours: ConnectionNeighbour[];
};
```

`edgeType` is a **closed union**, not `GraphEdgeType | string`. That widened form was proposed in
review and it collapses to `string` — TypeScript absorbs the union member — which removes the
exhaustiveness the field exists to give a consumer. A gateway that grows an edge type this union does
not name drops those neighbours from the brief rather than emitting an unrenderable discriminant;
the vocabulary is this repo's own and grows by an explicit edit here.

The union is the **item-linked** subset of the populator's edges — `resolves`, `correlates_with`,
`mentions`, `backlinks`, `reviewed`, `authored`, `opened`, `merged_as`, `targets`, `belongs_to`,
`monitors`, `depends_on`, `derived_from`, `upstream_refs`, `posted`. It excludes `defined_in`,
`in_repo` and `tracks_remote`, which are filesystem/infrastructure edges that never touch an indexed
item and would only ever appear as noise.

### 4.4 · `currency` (PR 3)

**Input:** `{ itemUrl }`. **Output:** per-claim evidence, per F6. Each finding names the signal it
came from:

- the item is an issue, and a PR that `resolves` it merged after the item's `modified_at`
- the item is an incident whose state is closed
- an item that `mentions` something which changed after the item last did — **note this signal is
  unreachable for a Confluence page**, which was its most obvious use and which has no graph entity
  to hang a `mentions` edge on (F8). It stays in the design because an issue can `mention` too, and
  because a `page` populator would light it up unchanged
- the item has not changed in longer than its type's own norm — the weakest signal, reported as an
  observation rather than a claim

**No verdict without evidence.** Where the signals are absent the agent returns a gap, never a
default "looks current". Recency alone is not a currency claim: the browser already renders age from
`modified_at` and does not need an agent to restate it.

**Wire.** Method `agents.currency`, notification `currency.briefReady`, discriminant
`kind: "currency"`.

```ts
type CurrencyEvidence = {
  detail: string;
  sourceItemId: string | null;
  sourceUrl: string | null;
  modifiedAt: number | null;
};

type CurrencyClaim = {
  claim: string;
  verdict: "stale" | "current";
  signal:
    | "resolved_issue_pr_merged"
    | "mentioned_item_updated"
    | "incident_closed"
    | "inactivity_threshold";
  /** Non-empty by construction: a claim with no evidence is not a claim. */
  evidence: [CurrencyEvidence, ...CurrencyEvidence[]];
};

type CurrencyBrief = AgentBriefBase & {
  kind: "currency";
  query: { itemUrl: string };
  claims: CurrencyClaim[];
};
```

Two deliberate departures from the shape proposed in review, both enforcing §4.4's own rule rather
than restating it:

- **`evidence` is a non-empty tuple.** `CurrencyEvidence[]` admits `[]`, which is precisely the bare
  verdict this agent exists not to emit. Making emptiness unrepresentable puts the rule in the type,
  where a later contributor cannot quietly opt out of it.
- **`verdict` has no `"unverified"` member.** An item the signals cannot speak to produces a **gap**,
  not a claim with a shrug in it. A third verdict would let the agent fill `claims` with
  non-answers and still look like it had worked.

`claims: []` remains valid and means the signals were checked and none fired.

### 4.5 · HTTP exposure

Both new agents are pure reads and join `HTTP_AGENT_NAMES` by the derivation in F7 — no allowlist
edit. The count assertion moves 11 → 13 in the same PR, and the three existing exclusion tests are
extended, not touched: a test asserting `preflight` stays 404 must keep passing verbatim.

---

## 5. Slices

Three PRs. PR 1 is the browser's first unblock and depends on neither of the others.

1. **`itemUrl` arms on `why`, `expert`, `ownership`** — §4.1, on `pr`, `issue` and `incident` (not
   `doc` — see F8). Carries two additive SDK changes: `WhyItemSubject` + `WhyBrief.itemSubject`, and
   `ExpertBrief.query.itemUrl`. Ships first so the client can start.
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
- **Per entity type, per sub-lane.** `why` and `expert` on an `issue`, a `doc` and an `incident`
  each produce findings **or** a gap per sub-lane — never a well-formed empty brief. This is the
  test that would have caught the §4.1 defect the review found, so it is written first.
- **Ref-with-slashes.** `refAndPath` fixtures for a branch (`feat/auth-v2/src/index.ts`), a tag
  (`v1.0.0-rc.1/src/index.ts`), a commit sha, and a path that matches no split at all.
- **Windows separators.** `resolveFileByRemote` against a root stored with backslashes and a
  browser path with forward slashes, including a mixed-separator input.
- **Remote casing.** A checkout whose remote is `github.com/ACME/Web` resolves for a browser
  coordinate of `github:acme/web`.
- **Multiple workspaces on one remote.** Two worktrees tracking the same repo, one of which does not
  index the requested path: the one that does wins, and the answer is stable across repeated calls.
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

---

## 9. Review responses

Against [`2026-08-31-agents-for-items-and-files-design-review.md`](./2026-08-31-agents-for-items-and-files-design-review.md)
(Antigravity, 2026-08-31), and the ref-ambiguity finding raised in the browser client's review. Every
finding was checked against the code before being accepted.

| Finding | Disposition |
| --- | --- |
| Q2.1 `why` sub-agents on a non-PR item | **Accepted — the largest correction here.** Verified: `ticketRowsForPr` (`why.ts:320`) joins `pe.type = 'pr'` on `from_id`, so an issue entity returns zero rows. §4.1 now declares all six sub-lanes' item-arm behaviour, and a skipped lane emits a gap rather than an empty finding list. |
| Q2.2 `expert` has no entity path | **Accepted.** Verified: five `LIKE` scans over `input.topicOrFile: string` (`expert.ts:175`). §4.1 now specifies the person-edge walk and states plainly that it is new query code, not a rewiring. |
| Q2.3 `OwnershipBrief` has no item target | **Accepted.** Verified `ownership-types.ts:7`, `:27`. §4.1 maps the item to its service via `belongs_to` (no new target kind) and adds `query.itemUrl`. **Added beyond the review:** these types are gateway-local, so this costs no SDK release. |
| Q2.4 exact wire schemas | **Accepted, with two changes.** §4.3 and §4.4 now carry method names, notification names, discriminants and full payloads. `edgeType` stays a **closed** union — the proposed `GraphEdgeType \| string` collapses to `string` and destroys the exhaustiveness the field is for. `currency` gets a non-empty evidence tuple and **no `"unverified"` verdict**, so §4.4's own rule lives in the type. |
| I3.1 Windows path separators | **Accepted, strengthened.** Verified: no separator normalisation exists anywhere. §4.2 requires calling the writer's own `fileExternalId` rather than formatting a third copy of the string. |
| I3.2 remote URL canonicalisation | **Accepted, corrected.** `parseRemoteUrl` already handles both URL forms and strips `.git`; the real gap is that it lower-cases the host but **not** `ownerName` (`repo-remote.ts:70`). Fixed by case-insensitive comparison, not by rewriting stored ids. SSH aliases need no handling — an unknown host already fails closed. |
| I3.3 multiple workspaces per remote | **Accepted.** Structurally possible and, with git worktrees, common. §4.2 specifies path-containment first, then most-recently-indexed, then entity id. |
| I3.4 typed miss discriminant | **Accepted.** `ResolveFileResult` in §4.2, with the reason as a discriminant rather than prose a client would have to scrape. |
| Ref/path ambiguity (from the client review) | **Accepted — a design change.** A branch name with a slash makes `/blob/<ref>/<path>` unsplittable by the client. The input is now the opaque `refAndPath` remainder, disambiguated here against the indexed file list. |
