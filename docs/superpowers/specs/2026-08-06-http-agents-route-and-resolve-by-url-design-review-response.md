# HTTP agent invocation + resolve-by-URL — review response

**Date:** 2026-08-06
**Reviews:** `2026-08-06-http-agents-route-and-resolve-by-url-design-review.md`
**Subject:** `2026-08-06-http-agents-route-and-resolve-by-url-design.md`

Six points raised. **Four accepted, one accepted in part, one rejected on a
verified factual error** — and that last one produced the most valuable change in
this pass, so it is written up rather than merely dismissed.

---

## Q1.1 — `AgentRunController` state across a gateway restart

**Accepted in part.** The observation is correct; the recommendation splits into
two halves that deserve opposite answers.

**Rejected: persist runs to an `agent_runs` table.** A stored run must store the
brief, and a brief is synthesised **from the private index**. Persisting it writes
index-derived prose to a new on-disk table — a privacy expansion — to buy
resumption of something that is cheap to reproduce by re-issuing the call. That
trade is the wrong way round. `BriefRunController` makes the same call and states
the principle: keeping runs in memory "makes 'source text is ephemeral' a
structural property rather than a promise." The argument is *stronger* for agents,
because a research brief holds captured source bodies that cannot be regenerated,
whereas an agent brief can always be rebuilt from the index.

**Accepted: document the client contract.** The spec did not say what a client
should do with a `404`, which was a real gap — a client could plausibly read it as
"not started yet" and poll forever. §1 now states the three codes explicitly, that
a restart yields `404` rather than `410` because the tombstone set dies with the
process, and that a client cannot distinguish "never existed" from "lost to a
restart" and does not need to: the response to both is to re-issue.

## Q1.2 — Updating scopes without a full re-pair

**Accepted.** Added `nimbus clip scopes <label> --set …`, which narrows as well as
widens, changes only the Vault entry, and leaves the token value untouched so a
paired client keeps working.

Worth recording *why* this is more than ergonomics, because that is the part the
review did not argue and it is the part that decides it: if the only way to add a
scope is delete-and-re-pair, the rational behaviour at mint time becomes "grant
everything so I never have to do this again." That reproduces precisely the
over-granting the scope work exists to end. There is no security difference to
trade against — both paths require local CLI access and are equally owner-controlled.

## Q1.3 — JS execution in migration V50

**Rejected: the premise is false, verified in `index/migrations/runner.ts`.**

The review's conditional was "if the migration runner does not support executing
arbitrary JS logic natively." It does, and JS is the *native* shape rather than an
escape hatch:

- A step is `apply: (db: Database, now: number) => void` (`runner.ts:109`).
- `simpleStep` is a declarative convenience wrapper built **on top of** that
  (`runner.ts:151`).
- The runner's own docstring names the reason to write a bespoke `migrateIndexedV*`
  function: "a conditional probe, a runtime branch on `tryLoadSqliteVec`, or **a
  custom data backfill alongside the schema change**."
- `backfillAuditChain` (`runner.ts:237`) and `backfillMigrationsLedger`
  (`runner.ts:496`) are existing precedents doing exactly this.

So the proposed fallback — SQL migration followed by a startup backfill — is not
needed, and would be worse: it would make the column's population a second,
skippable phase, which is the "silently misses the pre-existing index" failure the
design already rejected.

**But checking it found two constraints the spec had not stated, and one of them
was a live defect risk.** The spec said the backfill runs "in batches," which is
ambiguous in a way that matters:

- **`apply` is synchronous.** An `async` backfill cannot be awaited by the runner.
  This costs nothing — `canonicalizeUrl` and `bun:sqlite` are both sync — but it
  forecloses any batching design built on promises, which is the shape a reader
  would reach for first.
- **The whole step runs inside one `db.transaction`** (`applySchemaStep`,
  `runner.ts:122`). So "batched" must mean *chunked reads to bound memory*, and
  **never a commit per batch**. An implementer reading "batched backfill" loosely
  could reasonably have committed per chunk — which breaks atomicity and can leave
  `resolve_key` half-populated with `PRAGMA user_version` already advanced. That is
  a silently partial index that resolves some URLs and not others: worse than not
  shipping the column, and invisible until a user asks why one PR resolves and
  another does not.

Both are now stated in §4, and a migration-atomicity test was added: a backfill
that throws mid-way must leave `user_version` unadvanced.

This is the review's most useful contribution, arriving by way of a wrong premise.

## Suggestion 2.1 — Return candidates on `ambiguous`

**Accepted, with a bound the suggestion did not include.**

The reasoning holds: declining to guess is right, but declining to say what the
choices *were* dead-ends the client, and the panel is the one place a human can
settle it in a click. There is no new disclosure — candidates are the same shape
and the same privacy class as a successful resolve, to the same bearer-scoped
caller.

The addition is a **cap of five**. Rung 3 trims path segments and can match
broadly, so an uncapped candidate list turns a mis-trimmed URL into a bulk index
read over a `resolve`-scoped token. Over the cap the answer stays `ambiguous` with
`truncated: true` and **no** candidates, because a truncated choice menu is a
misleading one — it implies the right answer is among the five shown when it may
not be.

## Suggestion 2.2 — Public-route exclusion in the completeness test

**Accepted.** The route→scope table is now total over the whole surface, with the
unauthenticated GETs (`/v1/health`, `/v1/items`, `/v1/connectors`, `/v1/people`,
`/v1/audit`, `/v1/metrics/dora`, `/v1/openapi.json`) listed explicitly as `public`.

The value is sharper than "so they don't break": it makes a route that is public
**by decision** distinguishable from one that is public **by omission**. That is
the actual failure mode on this surface — today's GET table is ungated by
convention, and a convention is exactly what a new route joins silently.

## Suggestion 2.3 — Enforce `D22(d)` in `check-nimbus-invariants.ts`

**Accepted, with two sharpenings.**

Location and timing are now explicit: beside `D22(a)`–`(c)`, running in
`audit:invariants` before the test suite so it fails first.

First sharpening: the rule must match **both** `import … from ".../agents/<name>.ts"`
and dynamic `import("…")`. `D22`'s siblings are per-line regexes, and a
static-import-only regex is sidestepped by a one-character change. The red-prove
test plants a violation twice, once in each form.

Second sharpening — and this is the honest limit rather than a feature: a regex
over import specifiers **does not follow re-export chains**. If an emitter were
re-exported through `agents/_lib/`, a file could import it from the excluded path
and the rule would miss. That is the same shape as `D22`'s already-recorded
weakness ("wrapper/façade/raw-execute paths are out of its reach"). Rather than
claim coverage the mechanism does not have, a separate assertion states the
requirement directly: `agents/_lib/` re-exports no emitter.

---

## Not changed, and why

- **The `http` coverage class name.** §4 already records it as a named risk: like
  `mcp`, it covers less than its name suggests, because resolve appends nothing
  while fetch appends under `sync`. Renaming now, before a second non-appending
  HTTP capability exists, would be speculative; it stays an open question to
  re-decide with data.
- **The one-time `prove` blackout in PR 2.** An intended fail-safe, not a defect.
