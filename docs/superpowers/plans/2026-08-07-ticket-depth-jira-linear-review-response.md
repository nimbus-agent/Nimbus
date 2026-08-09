# Plan review response — Ticket depth (Jira + Linear), D1

Response to `2026-08-07-ticket-depth-jira-linear-review.md`. Each item was checked against the tree
at `0a32751f` rather than reasoned about from the plan text.

**Outcome: 1 fixed (the review understated it — it is a plan gap, not a typing caution), 1 fixed,
2 confirmations that needed verifying rather than accepting.**

---

## 1. Concurrency and transient scheduler state — CONFIRMED, with the reasoning verified. **No change.**

The review endorses the in-memory map and asserts that deleting the floor on success is safe
"because the sync did complete successfully on the backend, meaning the watermark was updated".
That is the load-bearing claim, so it was checked rather than accepted:
`runJobRecordSyncSuccess` calls `this.sched.updateState({ ..., cursor: result.cursor, ... })`
(`sync/scheduler.ts:575`). Success does persist the cursor. The reasoning holds.

**One case the review did not consider, now documented in the plan:** a success carrying
`hasMore: true`. The same method re-queues a `continuation` job (`:589`), and my rule deletes the
floor on that success too. That is still correct — the continuation resumes from the persisted
cursor, which bypasses the cold-start override entirely, so the floor has already done its work. It
looked like a leak worth re-checking, which is exactly why it is now a comment in the plan instead
of a question for the implementer.

The restart-drops-the-backfill tradeoff is accepted as the review describes: a dropped floor fails
toward the narrow 30-day default, the user can ask again, and nothing silently keeps re-walking
history.

## 2. Parameter strictness in `buildTargetServicesSql` — VALID, and worse than described. **Fixed.**

The review frames this as a typing caution — check that callers do not assume `string[]`. The actual
problem is not types at all: **two existing tests assert the returned `params` by exact value and
will fail**, and my plan did not mention updating them.

```text
packages/gateway/src/ipc/index-rebody-rpc.test.ts:527   expect(params).toEqual([]);
packages/gateway/src/ipc/index-rebody-rpc.test.ts:535   expect(params).toEqual(["issue"]);
```

After Task 6 those become `["jira", 1, "linear", 1]` and `["jira", 1, "linear", 1, "issue"]`. A red
suite mid-task is the cheap outcome; the expensive one is an implementer "fixing" it by dropping the
metadata clause.

Fixed in Task 6 with the rewritten assertions inline. They now assert *shape* — one `(service,
version)` pair per registered service, with the type filter last — derived from
`REBODY_REQUIRED_META_VERSION` itself, so registering a third service in D2/D3 does not break them a
second time. Positional order is called out as load-bearing, since these are `?` bindings.

The typing point itself is fine: `params` is spread into `db.query(sql).all(...params)`, which
accepts `string | number` bindings, and no other caller destructures it.

## 3. Jira `canceled` drift — CONFIRMED. **Strengthened, no design change.**

Agreed, and the review is right that the regression test is the thing that catches it. Made that
explicit rather than implicit: the test now carries a DRIFT TRIPWIRE comment saying that if a later
PR fetches `fields.resolution`, this test should be the first thing to fail, and that the correct
response is to update it *and* every consumer that was told a Jira `done` means "closed, outcome
unknown" — not to delete it so the change goes green.

`fields.resolution` remains explicitly out of scope for D1, recorded in the design's Scope section.

## 4. Upper bound for `--since` — VALID. **Fixed, in two parts rather than one.**

Accepted, but split by whether the input is *wrong* or merely *large*, because those deserve
different treatment:

**A hard bound where the value is actually invalid.** `--since 100000` is ~273 years, which puts the
floor before the epoch; `jqlFloorFromMs` would then emit a negative year and Jira would reject the
query with an opaque 400. `parseRebodyParams` now rejects any `sinceDays` whose floor lands before
1970, with a legible message. That is a correctness bound, not a taste threshold — it is the point
where the generated query stops being well-formed.

**A printed caution where the value is merely big.** The review's suggested ~10-year threshold is
adopted as a note in the existing `printPlannedRebody` block, not as a rejection: a genuine 15-year
Jira history is a legitimate thing to ask for, and refusing it would be the tool overriding the
user. It prints alongside the rest of the plan, before any traffic, and says to Ctrl-C if it was a
typo.

Deliberately **not** a `logger.warn`: this is a CLI path where the user is watching stdout, and the
existing command already prints a plan block for exactly this purpose. A warning routed to the
gateway log would be invisible at the moment it matters.

---

## Net effect on the plan

No task added or removed; no change to the design. Task 5 gains a comment, Task 6 gains the two
rewritten assertions and the epoch bound, Task 7 gains the caution print, Task 2 gains a tripwire
note. The one finding that would have cost real time — the frozen `params` assertions — was the one
the review labelled a suggestion.
