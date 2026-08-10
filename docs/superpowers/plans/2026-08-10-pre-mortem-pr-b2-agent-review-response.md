# pre-mortem PR B2 — Response to Plan Review

Responds to [`2026-08-10-pre-mortem-pr-b2-agent-review.md`](./2026-08-10-pre-mortem-pr-b2-agent-review.md).

**Three accepted** (one of them a real defect in my plan), **one accepted with a different fix than
proposed**, **one already covered**. Every answer checked against the tree.

---

## Q1 — What is the un-suppress command? · **ACCEPTED — my plan promised a command that does not exist**

The reviewer is right, and the reasoning is exactly right: the watcher row is gone, so
`nimbus watch resume <id>` cannot work — there is nothing to resume. My plan said the brief lists a
suppressed proposal "with the command to un-suppress" without ever defining one. Printing an
instruction that does not work is the precise failure class this branch's predecessor existed to fix.

**Fix: `nimbus pre-mortem <epic-ref> --repropose`.** It deletes this epic's rows from
`premortem_watcher_proposal` and then runs the normal proposal path, so previously-deleted watchers
are created fresh (paused, as always). Scoped to the epic being examined — never a global tombstone
wipe. The brief prints that exact command beside each suppressed entry.

Why a flag rather than making suppression expire or adding a new IPC method: the tombstone exists to
honour an explicit user "no", so reversing it should require an explicit user "yes". A flag on the
command that reports the suppression is the shortest path from seeing it to undoing it, and it adds
no new IPC surface.

## Q2 — IDF degenerates to zero on small or homogeneous histories · **ACCEPTED, with a different fix**

The observation is correct: `log(N/df)` is 0 when `df == N`, so on a single-candidate history, or one
where every candidate touches the same service, every score is 0.

**Rejected: adding a smoothing constant.** It would make the numbers non-zero without fixing what is
actually wrong, and would hide it.

**What is actually wrong is worse than flat scores.** With unsmoothed IDF, a candidate that shares
only a ubiquitous service scores 0 — and a candidate that shares **nothing at all** also scores 0.
The two are indistinguishable by score, so once ties fall back to `resolvedAtMs DESC`, a completely
unrelated epic can enter the cohort purely by being recent. That is a silent correctness bug: the
brief would present non-comparable work as comparable, which is the one thing the design's
unconditional honesty note exists to prevent. Smoothing every weight to a positive number would have
made those two cases *look* different while leaving zero-overlap candidates eligible.

**Fix: gate on overlap before scoring.** A candidate enters the cohort only if it shares **at least
one** service with the target. IDF then ranks *among genuinely overlapping candidates*, where a
`log(N/df) == 0` tie is harmless and honest — it means "these epics are equally comparable on this
evidence", and recency is a reasonable tiebreak among equals.

The plan gains an explicit rule, plus a test asserting a zero-overlap epic never appears in the
cohort even when it is the most recent closed epic in the index.

## S1 — Wrap the two writes in a transaction · **ACCEPTED**

Correct, and it protects a specific rule rather than being general hygiene. `proposeWatchers` writes
a `watcher` row and a `premortem_watcher_proposal` row. If the second write failed, the watcher would
exist with no tombstone record — and rule 3 ("a deleted watcher stays deleted") depends entirely on
that record, since without it "never proposed" and "deleted" are indistinguishable. A half-write
would therefore resurrect a watcher the user had deliberately deleted on the next run.

Verified idiomatic and invariant-safe: `db.transaction(() => { … })` is already used in
`connectors/health.ts:232`, `db/repair.ts:38`, `db/latency-ring-buffer.ts:136` and two connector
syncs. D12's detector matches `db.run(` / `db.exec(` only (`check-nimbus-invariants.ts:141`), so a
transaction wrapper whose inner writes go through `dbRun` stays I14-compliant.

## S2 — Clock skew in the cycle-time boundary · **NO CODE CHANGE — the check is already correct; test added**

Worth checking, and the existing form already behaves correctly. With
`nowMs - targetCreatedAtMs < 86_400_000`, a future-dated `targetCreatedAtMs` yields a **negative**
difference, which is less than a day, so the epic is treated as **young** and the risk is phrased as
an expectation. That is the right outcome: an epic whose creation timestamp is in the future has no
meaningful elapsed time to compare against, and the expectation phrasing is exactly what should be
shown. Changing `<` to `<=` alters only the exact-boundary case and nothing about skew.

Accepted as a **test**, not a code change: the plan now pins the future-dated case so a later
"cleanup" cannot turn it into a comparison against negative elapsed time.

## S3 — `json_valid(metadata)` guarding the extracts in `cohort.ts` · **ALREADY IN THE PLAN**

Task 1 Step 3 already requires it: *"Guard every `json_extract` with `json_valid(metadata)` —
`json_extract` RAISES `malformed JSON` on non-JSON TEXT, and an uncaught raise here kills the whole
brief."* The reviewer's suggested `WHERE` shape is the one intended. Restated in the plan as explicit
SQL so it cannot be read as advisory.

---

## Net effect on the plan

Task 1 gains the overlap gate and one test. Task 2 gains one clock-skew test. Task 3 gains the
transaction and the `--repropose` tombstone-clearing path. Task 5 gains the `--repropose` flag on the
CLI. No new task, no new file, no change to the six-task structure.
