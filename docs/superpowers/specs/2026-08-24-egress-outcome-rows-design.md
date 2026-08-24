# How a targeted fetch ended: outcome rows on the egress ledger (U3)

> **Status:** design, approved 2026-08-24. Closes the last unmet half of the web
> clipper's C4.1 done-when. Supersedes **U2b** (item identity on the authorising
> row), which is dropped — see "What this replaces".
>
> The consumer-side design lives in the `nimbus-web-clipper` repo at
> `docs/superpowers/specs/2026-08-23-gateway-activity-ledger-design.md`. This
> document is the gateway half.

## The gap this closes

The web clipper's **C4.1** brief promised an activity view listing every
gateway-side fetch "with time, target and outcome". Three of those four are
shipped: **U1** (Nimbus#1319) gave the ledger an HTTP read surface, **U2a**
(Nimbus#1322) made a targeted fetch name the client that asked for it, and the
browser's Activity page (nimbus-web-clipper#70) renders them.

**Outcome is the piece that is structurally absent.** `targetedFetch` appends
its egress row BEFORE calling the connector — deliberately, because I29 is
fail-closed: no row, no fetch. So `result_status` records the *authorisation*
decision, not what came back. A fetch that 404s, times out, or is refused by the
provider still reads `authorized`, and nothing in the ledger ever says otherwise.

## What the ledger can and cannot say today

Reading `main` at `8611b5c7`.

### Finding 1 — the outcome vocabulary is small, and already exists

Only three arms can occur AFTER the append, because the others return before it:

| Arm | Reachable after the append? |
| --- | --- |
| `indexed` (carries `itemId`) | yes |
| `not_found` (carries a `FetchMissReason`) | yes |
| `rate_limited` (a provider 429 from `fetchOne`) | yes |
| `unsupported_url` | no — refused by the pre-append `willAttempt` check |
| `no_targeted_fetch` | no — refused before the append |
| `not_configured` | no — refused by the host boundary before the append |

So the outcome vocabulary is three values, and each already exists in
`TargetedFetchOutcome`. Nothing new needs inventing.

### Finding 2 — item identity is free after the fetch

`{ status: "indexed", itemId }` carries the item id directly. Before the fetch it
does not exist, which is why **U2b** proposed deriving it by parsing the URL — and
why that was expensive: each connector's parser is private and connector-shaped
(`parseGithubPrUrl` returns `{ owner, repo, num }`; only a boolean wrapper is
exported), so it meant exporting a normalised parser from five connectors and
renegotiating the no-raw-URL rule for `payload_summary`.

After the fetch, none of that is needed.

### Finding 3 — a second row must not count as egress

`MARKER_SOURCE_TYPES` (`prune`, `boot`, `degraded`) exists precisely so
bookkeeping is not miscounted as outbound: prune tombstones were inflating the
reported figure before that exclusion landed. An outcome row is bookkeeping about
an egress that has ALREADY been counted, so counting it again would double every
targeted fetch — inflating the exact number I29 exists to state honestly.

### Finding 4 — the source-type union is frozen, and prescribes its own ceremony

`egress-source-type.ts` says a further class "needs an explicit decision recorded
here; it is not a casual append", and both `mcp` and `http` carry a paragraph
justifying themselves. Widening the union is not a chain break —
`verifyEgressChain` recomputes each row's hash from that row's OWN stored columns
— but the vocabulary is permanent in the data, so the decision is deliberate.

## Decisions

| Question | Decision |
| --- | --- |
| Row class | A new marker member, `outcome`. |
| Scope | Targeted fetch only. |
| Correlation | The authorising row's `row_hash`, carried in `source_id`. |
| Absent outcome | Means *not recorded*. Never *in flight*. |
| Append failure | Swallow and warn, never propagate. |
| U2b (identity on the authorising row) | Dropped, superseded. |

## The row

```text
sourceType:      "outcome"
sourceId:        <authorising row's row_hash>
destination:     <the same service id the authorising row named>
method:          "items.fetch.outcome"
payloadSummary:  redactEgressSummary({ status, itemId? , reason? })
hitlStatus:      "not_required"
resultStatus:    "authorized"
```

**Why `row_hash` as the correlation key, in `source_id`.** Prune tombstones
already carry an attested boundary hash in `source_id`
(`verifyEgressChain`'s pre-scan reads it), so a marker using that column as a
correlation key is established rather than novel. The hash is the value the chain
already commits to, it is stable in a way a local rowid is not, and every
consumer of `GET /v1/egress` already receives `rowHash` on every row — so the
join needs no new field on the wire.

**Why `resultStatus: "authorized"`.** The column means "was this action allowed",
not "did it succeed". Markers legitimately carry `authorized` — `pruneEgress`
does — and reusing it to mean "the fetch worked" would give one column two
meanings across row classes. The fetch's success lives in `payloadSummary.status`,
which is the field that actually has three values.

## The union decision, recorded

`outcome` is the eleventh member, and it is a MARKER rather than an egress class.
That distinction is the whole argument:

- It records bookkeeping about an outbound call the ledger has already counted.
  Counting it again double-counts every targeted fetch.
- Because it joins `MARKER_SOURCE_TYPES`, `COVERAGE_CLASSES` is untouched — and
  the existing invariant test *"I29: COVERAGE_CLASSES is exactly the non-marker
  source types"* (`security-invariants.test.ts`) proves the two lists stayed in
  step, which is exactly the silent mismatch the union's header warns about.
- It therefore claims no coverage granularity and needs no `THIS_BINARY_COVERAGE`
  raise. There is no appender-without-a-claim and no claim-without-an-appender.

Reusing `sync` with a reserved `method` was rejected: `sync` is not a marker, so
every outcome row would count as outbound unless the counting predicate grew a
method-level special case — reintroducing by hand exactly the miscount
`MARKER_SOURCE_TYPES` exists to make structural.

## Where it is written

In `targetedFetch`, after `fetchOneWithRetry` returns — the only point that holds
both the authorising row's identity and the result.

This needs one seam change: `TargetedFetchDeps.appendEgress` currently returns
`undefined`, and the outcome row must name the row it is about. It becomes
`(row) => { rowHash: string } | undefined`, still synchronous.

`undefined` means **no authorising row was written**, and therefore no outcome row
may be either — there would be nothing for it to name. `recordSyncEgress` already
returns without appending for `LOCAL_ONLY_SYNC_SERVICES`; no fetchable service is
in that set today, so this arm is unreachable through `targetedFetch`, but it is
modelled rather than asserted away so a future local-only fetchable cannot
silently produce an orphan outcome row.

**Its synchronous return type stays load-bearing.** That seam is typed to return
`undefined` rather than `void` specifically so an `async` implementation is a
compile error: an async append's rejection would surface after `targetedFetch`
had already moved past the call, breaking the fail-closed contract. Widening it
to a value type must not weaken that — the new type is a plain object, never a
promise, and the existing doc comment explaining why is kept and extended.

## Failure posture, deliberately asymmetric

The authorising append is **fail-closed**: it throws, the fetch never happens.

The outcome append is **swallow-and-warn**. By the time it runs the request has
already left the machine, so there is nothing to abort; propagating would turn a
fetch that genuinely succeeded into a 500, and the caller would retry — causing
MORE egress than the failure it was reporting. `appendBootMarkerOrWarn` is the
documented precedent for exactly this shape, and its rule applies here too:
swallowing must never be silent. The warning names the failure.

## What a reader may conclude

An authorising row with no outcome beside it means **the outcome was not
recorded**. It does not mean the fetch is still running.

The ledger cannot support the stronger claim: a row written by a gateway that
predates this change is indistinguishable from one whose outcome append was lost.
Rather than infer from age — which would report a slow provider as a lost outcome
— the consumer says only what the record supports. This matches the posture the
whole C4.1 design takes: attribution is exact match and never inference,
verification is claimed only when checked.

## What this replaces

**U2b is dropped.** Its purpose was to let the Activity page name the item a
fetch was for; the outcome row does that with `itemId`, at no parsing cost. The
five connector parsers, and the argument about putting a `{service, type, id}`
triple through a redacted summary field, are no longer needed.

The cost is stated rather than hidden: a fetch whose outcome never lands — a lost
append, or an older gateway — names no item at all. That is the same window in
which the outcome itself is unavailable, so the page is not made inconsistent by
it; there is simply less to show.

## Testing

- `egress-source-type.test.ts`: the union is eleven members; `outcome` is in
  `MARKER_SOURCE_TYPES`; `isMarkerSourceType("outcome")` is true.
- `security-invariants.test.ts`: the existing COVERAGE_CLASSES identity test must
  pass UNCHANGED. If it fails, the member was added to the wrong list.
- `sync-egress.test.ts` / a new `outcome-egress.test.ts`: the row's exact shape;
  `source_id` is the authorising hash; the chain still verifies across the pair.
- `targeted-fetch.test.ts`: one outcome row per completed fetch, carrying the
  right status; `itemId` present on `indexed` and absent otherwise; NO outcome row
  for the three arms that return before the authorising append; a throwing outcome
  append does not fail the fetch, and warns.
- `countOutboundEgress`: a fetch plus its outcome counts as ONE outbound event.
  This is the double-count guard, and it is the test that would catch `outcome`
  being placed outside `MARKER_SOURCE_TYPES`.

## Slices

- **U3a (this repo)** — the union member, the seam returning its row hash, the
  appender, the write site, the I29 note.
- **U3b (`nimbus-web-clipper`)** — the Activity page renders an outcome column,
  joining outcome rows to authorising rows by `rowHash`, and says "not recorded"
  where none exists. Also folds in three code comments that now overstate the
  attribution gap, having been written before U2a landed
  (`src/shared/egress.ts:28` and `:204`, `src/ledger/ledger-view.ts:115`).

## Out of scope

- Outcome rows for any class other than targeted fetch. Agent runs over HTTP have
  their own async run lifecycle with their own terminal states; "outcome" would
  mean two different things in one row class. Scheduled syncs and model calls
  serve nobody's stated need — nobody waits on a background sync the way they wait
  on a fetch they just triggered.
- Any change to `egress.prune`, which keeps its owner-HITL gate and its absence
  from both the LAN allowlist and the HTTP surface.
