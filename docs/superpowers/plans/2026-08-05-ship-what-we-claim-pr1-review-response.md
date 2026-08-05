# Plan Review Response: Compiled-Runtime Connector Spawn (PR 1)

**Date:** 2026-08-05
**Reviewed plan:** `docs/superpowers/plans/2026-08-05-ship-what-we-claim-pr1.md`
**Review:** `docs/superpowers/plans/2026-08-05-ship-what-we-claim-pr1-review.md`

Each verdict below is backed by a measurement against this tree. One item is rejected on evidence;
one exposed a defect materially worse than the review described; one was already solved by an
existing gate.

## Verdicts

| Item | Verdict | Basis |
|---|---|---|
| A — dynamic-import tracing gap | **Fix** (comment only) | The gap is real; the property is already enforced elsewhere |
| B — Windows `.exe` handling | **Reject** | Measured: Bun resolves it on Windows without the extension |
| C — configurable timeout / concurrency | **Fix the cause, defer the knobs** | Found a 47× latency defect in the script itself |
| Q1 — generator in a pre-commit hook | **Defer**, improve the failure message | A hook that mutates the tree mid-commit is worse than a named command |
| Q2 — Biome and the generated file | **Fix** | Measured: the generated file fails `biome check` today |

## A — The tracing gap is real; the guarantee is not missing

Correct on the mechanism: `transitiveStaticGraph` follows static imports only, so it stops at the
registry's `() => import(...)` thunks and never enters a connector's own graph.

Not correct that this leaves the property unprotected. `.dependency-cruiser.cjs` already carries:

```javascript
{
  name: "mcp-connectors-only-import-sdk",
  from: { path: "^packages/mcp-connectors/[^/]+/src" },
  to:   { path: "^packages/(gateway|cli|ui)/" },
}
```

run by `bun run audit:boundaries`, which is in the **fast** preflight tier. A connector statically
importing a gateway `db`/`vault`/`ipc` module fails that gate before the walker ever matters.

I also do not accept "will pass vacuously": the test asserts two substantive things about the
gateway-side graph, and its third case is a red-prove that fails if the walker resolves nothing.
What it does not do is cover the connector side.

**Adopted:** no new rule. A scope comment above the `describe` names
`mcp-connectors-only-import-sdk` as the other half of the guarantee, so nobody reads the walker as
covering connector sources and nobody adds a redundant second rule later.

## B — Rejected: Bun resolves the extension on Windows

The claim is that passing `dist/nimbus-gateway` to `Bun.spawn` on Windows "may cause spawn errors"
because the file on disk is `nimbus-gateway.exe`. Measured, on Windows, against a real compiled
binary:

```text
…/all-bin      -> spawned, exitCode=0
…/all-bin.exe  -> spawned, exitCode=0
```

Both resolve. `Bun.spawnSync` throws on an unresolvable executable; neither threw. Adding
`process.platform === "win32"` extension-patching would be defending against a failure mode that
does not exist, in the one place the plan can least afford incidental complexity — and it would need
its own test to stay honest.

No change.

## C — The knobs would have masked a defect in my own script

The review flags CI load as the risk. The real problem is worse and is in the plan's script:

```typescript
const [stdout, stderr, code] = await Promise.all([
  new Response(proc.stdout).text(),   // ← waits for stdout to CLOSE
  ...
]);
```

A healthy MCP server never closes stdout, so **every successful connector burns the entire timeout**
before the kill. Measured per connector:

| Connector | drain to EOF | stream and stop |
|---|---|---|
| github | 5023 ms | 107 ms |
| slack | 5022 ms | 105 ms |
| jira | 5015 ms | 106 ms |

At a 15 s timeout that is roughly three minutes of pure waiting for a passing run — and raising the
timeout for safety would have made it linearly slower, which is exactly the wrong incentive.

**Adopted:** read stdout incrementally and resolve at the first `"serverInfo"`. Validated against a
binary bundling all 94 connectors:

```text
95 connectors — 79 answered, 5 refused, 11 failed in 1.8s
```

Same classification as the slow version, 100× faster. (The 95th id and the 11th failure are `shared`,
an artifact of the hand-made id list used for the probe; the real script iterates
`Object.keys(BUNDLED_CONNECTORS)`, which excludes it.)

**Deferred:** environment-variable knobs for `TIMEOUT_MS` and `CONCURRENCY`. With the streaming read
the timeout is reached only by a genuine hang, and the whole run is under two seconds. A knob there
would mostly offer a way to raise the timeout instead of diagnosing the hang. The reasoning is
recorded as a comment on the constant, so the option is one line away if CI ever proves otherwise.

## Q1 — Generator in a hook: deferred

A pre-commit hook that runs `gen:connector-registry` would rewrite a tracked file **during** the
commit, silently changing what gets committed relative to what was reviewed — the same class of
surprise as an auto-fixing formatter hook, on a file whose contents are a build input.

The drift test is the right enforcement; its weakness was diagnosability, not coverage. **Adopted:**
the test now diffs the two sets and fails with the remedy in the message —
`registry is stale — run \`bun run gen:connector-registry\`` — plus the exact missing and extra ids.
Someone adding a connector meets a failure that names its own fix.

## Q2 — Biome does reject the generated file

Well-aimed: the generator as planned would have failed `bun run lint`. It is the **formatter**, not a
lint rule — Biome strips unnecessary quotes from object keys, and `JSON.stringify(id)` quotes all of
them:

```text
- ··"airflow":·()·=>·import(...)
+ ··airflow:·()·=>·import(...)
```

Hand-rolling the quoting policy is the wrong fix: `monte-carlo`, `github-actions` and `google-drive`
must stay quoted while `airflow` must not, and that policy belongs to the formatter, not to a
`render()` function that would rot the next time it changes.

**Adopted:** the generator runs `bunx biome check --write` on its own output and fails if the
formatter fails. Verified end to end — after the change `biome check` exits 0, `airflow:` is
unquoted and `"monte-carlo":` keeps its quotes. `bun run typecheck` was already clean: the
`../../../mcp-connectors/*/src/server.ts` specifiers resolve fine.

## Net effect

No task added or removed. Task 4's generator gained a formatting step and its drift test gained an
actionable failure message; Task 5's test gained a scope comment; Task 7's `boot()` was rewritten to
stream, taking the gate from roughly three minutes to under two seconds.
