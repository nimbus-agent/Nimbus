# Plan Review Response: negation queries (W6-B.1)

Response to [`2026-08-20-negation-queries-review.md`](./2026-08-20-negation-queries-review.md).
Every item checked against the tree on 2026-08-20 before being accepted or declined.

**Outcome:** 3 accepted, 1 accepted-with-a-different-mechanism. Two of the three supplied SQL joins
were correct and I verified both rather than trusting them — my plan had deliberately refused to
write those joins, and a wrong one supplied confidently is worse than an instruction to go read.

| # | Item | Outcome | Plan change |
| --- | --- | --- | --- |
| 1A | `graph_entity` bridge for deployments | **Accepted — verified correct** | Task 2 Step 3 |
| 1B | `graph_entity` bridge for people | **Accepted — verified correct** | Task 2 Step 3 |
| 2A | Assert a connection marker in Task 1 | **Concern accepted, mechanism replaced** | Task 1 Step 2 |
| 2B | `people.list` returns a bare array | **Accepted — my snippet was wrong** | Task 4 Step 2 |

---

## 1A / 1B — the graph-entity bridges: verified, and now in the plan

My plan said "read `relationship-graph.ts` for how an item maps to its graph entity id — do not
guess the join". That was the right instinct and the wrong deliverable: it left the single most
error-prone SQL in the task unwritten, so an implementer would have guessed anyway.

Both supplied joins are correct, verified at the emit sites rather than inferred:

- **Deployments** — `syncTimelineEventGraph` (`graph/graph-populator.ts:854`) upserts
  `{ type: "deployment", externalId: row.id }`. So the item's id is the entity's EXTERNAL id, and
  `graph_relation.from_id` holds the entity's PRIMARY key. Joining `from_id = item.id` directly
  matches nothing — and this predicate's failure mode for "matches nothing" is returning EVERY
  deployment as clean, which is precisely the false positive the feature exists to prevent. That
  makes this the highest-consequence line in the plan.
- **People** — `graph-populator.ts:341-349` upserts `{ type: "person", externalId: row.authorId }`
  and emits `reviewed` FROM it, with `row.authorId` being the `person.id`.

Both joins are now written out in Task 2 Step 3 with the emit sites cited, so the implementer
copies verified SQL instead of reconstructing it.

**One caveat I added that the review did not raise.** `graph_relation.created_at` is a WRITE
timestamp, so `--since 7d` on `--not-reviewed` means "no reviewed edge WRITTEN in 7 days", not "no
review performed in 7 days" — and a re-graph would move every edge's `created_at`. The plan now
tells the implementer to check whether `regraph.ts` rewrites `reviewed` edges and, if so, to record
it as a stated bound rather than let the flag imply event-time semantics it does not have. This is
the same class as the correlation-window finding in the spec: a timestamp that means something
narrower than the flag name suggests.

## 2A — the vacuous-test concern is right; the proposed mechanism is not

The concern is correct and worth stating precisely: Task 1's two `not.toMatch` assertions are BOTH
satisfied by an empty string, so if a command ever swallowed a bad flag and returned early, the
test would pass while proving nothing. That is the "test that cannot fail" shape this repo keeps
producing, and it would have shipped in the one task whose whole purpose is catching a defect
class.

**But asserting `connect ENOENT` / `fetch failed` would trade one problem for another.** Those are
OS-level strings; Unix domain sockets and Windows named pipes fail differently, and this repo gates
on Ubuntu, macOS and Windows. A test pinned to platform error text is a cross-platform flake
waiting for the next CI matrix run.

Replaced with a code-owned signal: `withGatewayIpc`
(`packages/cli/src/lib/with-gateway-ipc.ts:64-66`) throws `GatewayNotRunningError` when no gateway
state file exists. Asserting that proves the command reached the IPC layer — a positive assertion,
stable on every platform.

And made it deterministic, which the review did not cover: the test points `NIMBUS_CONFIG_DIR`
(`packages/cli/src/paths.ts:51`) at an empty temp dir, so `readGatewayState` returns `undefined`
whether or not the developer has a gateway running. Without that the test passes in CI and fails
on a live machine — the worst kind of flake, because it looks like a real regression.

## 2B — `people.list` returns a bare array: accepted, and it forced a design decision

Verified: `rpcPeopleList` (`people-rpc.ts:87-90`) returns `value: rows.map(...)`. My Task 4 snippet
destructured `{ people: Array<...> }` and would not have compiled.

Fixing the snippet is trivial; the finding underneath is not. `index.queryItems` returns
`{ items, meta }`, so Task 3 attaches `gaps` and `explain` as siblings. `people.list` has no
wrapper to attach anything to, which the plan had not noticed.

Resolved in the plan rather than left for the implementer to improvise:

- the refusal document replaces the whole payload, so it needs no wrapper;
- `explain` returns a wrapper ONLY when `explain === true` was requested. Wrapping unconditionally
  would be a breaking change to `people.list` for every existing caller in order to serve an
  optional debug flag; gating it means the only caller who sees a different shape is the one who
  asked for it.

The plan now also tells the implementer to state in its report that `people.list` has two response
shapes gated on a request flag — an asymmetry a reviewer should see deliberately rather than
discover.
