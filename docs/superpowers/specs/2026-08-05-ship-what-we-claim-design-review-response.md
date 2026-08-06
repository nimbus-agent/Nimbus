# Design Review Response: What We Ship Is What We Claim

**Date:** 2026-08-05
**Reviewed spec:** `docs/superpowers/specs/2026-08-05-ship-what-we-claim-design.md`
**Review:** `docs/superpowers/specs/2026-08-05-ship-what-we-claim-design-review.md`

Every verdict below is backed by a measurement taken against this tree, not by argument. Two review
items changed the design materially; one is answered with data that removes it; two are deferred
with the number that justifies deferring.

## Verdicts

| Item | Verdict | Basis |
|---|---|---|
| A — connector boot smoke | **Fix** | Run on the spot; found a 10-connector silent-failure class |
| A(ii) — connector entry contract | **Fix** (consequence of A) | `import.meta.main` guard is false under a registry import |
| B — dependency audit | **Fix**, cheaper form | Risk verified absent today; the guard is ~15 lines |
| C — sentinel execution boundary | **Fix**, modified | The concern is real; the proposed mechanism is not the right one |
| Q1 — how the asset map is built | **Answered** | Measured; no codegen needed |
| Q2 — `.exe` resolution in `selfSpawn` | **Answered** | Measured; no action |
| Q3 — binary size budget gate | **Defer** | Measured at +4.0% |
| Q4 — non-administrator smoke user | **Defer** | Cost is a new flake class; signal is near zero |

## A — Connector boot smoke: accepted, and it has already paid for itself

Implemented as a probe before answering, over a binary bundling **all 94** connector `server.ts`
modules. Each connector was spawned with no credentials, fed one `initialize` request, and
classified.

- **79 answered** `initialize` with a valid `serverInfo`, with no environment at all.
- **5 threw** `Error: <VAR> is not set` from `requireProcessEnv` (`apple`, `fastmail`, `imap`,
  `obsidian`, `protonmail`). Behaviour is **byte-identical in dev mode** — correct, not a defect.
- **0 crashed.**
- **10 exited 0 in silence**: `argocd`, `bigeye`, `flux`, `looker`, `mlflow`, `monte-carlo`,
  `powerbi`, `snowflake`, `tableau`, `workday`. In dev mode all ten answer normally.

The ten are exactly the ten whose `server.ts` ends with:

```ts
if (import.meta.main) {
  await runReadOnlyMcpConnector("nimbus-snowflake", registerSnowflakeTools);
}
```

`import.meta.main` is true when the file is spawned as `bun server.ts` and **false when the module
is imported by a registry**. Under the design as written, those ten connectors would have loaded,
started nothing, and exited zero — no error, no log, no sync. That is precisely the failure mode
this cluster exists to eliminate, and it would have shipped.

The suggestion is therefore accepted as a **required gate**, not an optional test: a CI job that
boots every registry entry and asserts each one either answers `initialize` or exits non-zero
naming a missing environment variable. Silence and hangs both fail.

## A(ii) — The connector entry contract must become explicit

Consequence of the finding above, and not in the original spec.

**Correction to an earlier draft of this response.** It claimed the guard could simply be deleted
because "no test imports those ten `server.ts` files". That was wrong — the grep behind it matched
only absolute-style paths and missed relative ones. All ten connectors' tests **do** import their
`server.ts` for the register function (for example `snowflake/test/server-list-pagination.test.ts:3`,
`argocd/test/server-writes.test.ts:3`). The guard is load-bearing: deleting it would connect a real
`StdioServerTransport` to the test runner's own stdin/stdout.

Measured shapes across all 94 entrypoints:

| Shape | Count | Tail |
|---|---|---|
| guarded, helper bootstrap | 10 | `if (import.meta.main) { await runReadOnlyMcpConnector(...) }` |
| unguarded, helper bootstrap | 50 | top-level `await runReadOnlyMcpConnector(...)` |
| unguarded, explicit connect | 34 | top-level `await server.connect(transport)` |

**Adopted:** the ten guarded connectors gain `export async function startConnector(): Promise<void>`
wrapping their existing bootstrap, and keep the guard as `if (import.meta.main) await
startConnector();`. The registry awaits the import and then calls `startConnector` when the module
exports it; the 84 unguarded connectors start on import as they do today. A static audit enforces
the one rule that closes the drift: **a `server.ts` containing `import.meta.main` must export
`startConnector`.** The boot smoke covers every other way a connector can fail to start.

**Rejected:** normalising all 94 onto an exported entry. It is a 94-file change across two distinct
tail shapes for a guarantee the boot smoke already provides, and it would improve testability in 84
packages that this cluster was not asked to touch. Worth doing on its own merits, not here.

## B — Dependency audit: accepted in a cheaper form

The stated risk is native modules failing to bundle or losing their shared library. Measured:

- 94 connector packages. The **union** of all runtime dependencies is `@modelcontextprotocol/sdk`,
  `@nimbus-dev/sdk` and `zod` (all 94), plus `hyparquet` (1), `imapflow` (3), `nodemailer` (3) and
  `tsdav` (1). All pure JavaScript.
- The all-94 binary compiles in 0.44 s (676 modules) and 79 of its connectors answer MCP over stdio.

So the risk is **not present today**. The guard is still worth having, because a future connector
adding a native dependency would break the compiled gateway silently — visible only when a user's
sync fails. Implemented as a ~15-line audit asserting connector `dependencies` stay within an
allowlist, rather than a heuristic scan for native modules.

## C — Sentinel execution boundary: concern accepted, mechanism rejected

**Rejected:** checking `process.argv` inside the database and vault initializers. That couples hot
modules to global process state, and it only fires when a code path is *called* — it cannot see
import-time work, which is where the actual exposure is.

**The concern is real and sharper than stated.** `gateway/src/index.ts` statically imports the whole
gateway graph (`workflow-runner`, `connector-write-dispatch`, `connectors/index`, `egress-ledger`,
`engine/agent`, `run-ask`, `platform/index`). Dispatching on `argv` *inside* that file prevents the
`createPlatformServices()` **call** but not module **evaluation**: `connectors/registry.ts:8`,
`engine/run-ask.ts:21` and `index/sqlite-vec-load.ts:7` all construct pino loggers at module scope,
and `Config` freezes every `NIMBUS_*` variable at first import.

**Adopted instead:** `index.ts` becomes a thin argv shim that **dynamically** imports exactly one of
three role modules (`gateway-main.ts`, the sandbox wrapper, the connector registry). A connector
role then never evaluates the gateway graph at all. A module-graph test asserts the connector role's
transitive imports exclude `db/`, `vault/` and `ipc/` — a structural claim, checked structurally,
rather than a runtime tripwire.

## Q1 — How the embedded asset map is built

No build-time codegen. An `import assetPath from "./x.txt" with { type: "file" }` **evaluates to the
content-hashed bunfs path at runtime**; the bundler substitutes the value. Measured: the import
yielded `B:/~BUN/root/asset-yq4ycqmf.txt`, and both `existsSync` and `readFileSync` succeeded on it.
Four literal import statements, no generator, no hashes written by hand.

## Q2 — `.exe` resolution in `selfSpawn`

Measured on Windows: `process.execPath` is already the full path **including `.exe`**
(`…\probe-bin.exe`), and `Bun.spawn([process.execPath, "__child", "alpha", "beta"])` delivered
`argv.slice(2) === ["__child","alpha","beta"]` to the child. No extension handling is required. No
action.

## Q3 — Binary size budget gate: deferred, with the number

Measured on Windows:

| Binary | Size |
|---|---|
| Bun runtime baseline (trivial entry) | 93.9 MB |
| All 94 connectors bundled | 97.7 MB |

**+3.8 MB, or +4.0%.** The connector TypeScript is negligible against the embedded runtime.

A CI size gate would therefore guard a 4% delta while adding a per-platform baseline to maintain.
This repository's history with ratcheted baselines is poor — the coverage-floor baseline has
produced false greens, and the perf suite's wall-clock gates flake. The measurement is recorded in
the spec; the gate is not built. Revisit if a future change moves the number by a material fraction.

## Q4 — Non-administrator smoke user: deferred

GitHub-hosted Windows and macOS runners execute jobs as an administrator by default. Running the
smoke as a freshly created standard user means creating the account, initialising its profile, and
getting DPAPI (Windows) or the login keychain (macOS) to work under it — a new and expensive flake
class, in a workflow whose keychain setup is already its most delicate part.

Against that, the incremental signal is close to zero: the Windows installer is already **per-user**,
and the smoke already sandboxes `HOME` and `LOCALAPPDATA` to `$RUNNER_TEMP`. Recorded as a known
limitation rather than built.

## Corrections to the spec found while answering

Neither came from the review; both are errors in the original document.

1. **Connector count.** The spec said "~40 connectors". The real number is **94** packages with a
   `src/server.ts`. Every size and risk statement is restated against 94.
2. **The install-smoke premise was wrong.** The spec inherited "move install-smoke outside the repo
   checkout" from `docs/ecosystem-roadmap.md`. Both legs of `install-smoke.yml` **already** stage the
   binaries into `$RUNNER_TEMP/stage` (lines 147 and 454) and run against a sandboxed
   `HOME`/`LOCALAPPDATA`. The real gap is **assertion coverage**: nothing in the smoke exercises a
   connector spawn, the admin console, the OpenAPI route, or sqlite-vec. The work is adding
   assertions, not relocating the job.

## Net effect on delivery

PR 1 grows: it now carries the thin-shim entry rewrite, the ten connector conversions, the
`import.meta.main` audit, the dependency allowlist audit, the module-graph test and the all-94 boot
smoke. That is a real increase over the original plan, and it is the increase that keeps ten
connectors from shipping silently dead.
