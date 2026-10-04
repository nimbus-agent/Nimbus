# SonarQube rule tuning — B3 audit

This file is empty by design. It is populated **only if** Phase 2's first
SonarQube analysis run produces unacceptable signal-to-noise on the default
Sonar Way profile, requiring explicit rule disables.

## Phase 2 verification

**Date:** 2026-05-01
**SonarCloud project:** `asafgolombek_Nimbus`
**Profile in use:** Sonar Way (default)

Reviewed the SonarCloud findings produced against PR #135 (Phase 1 close).
Findings were Issues, not rule-disable candidates — the rule profile is
producing actionable signal at acceptable noise levels for this codebase.

**Outcome:** No rules disabled. Sonar Way profile retained as-is for B3.

Re-evaluate at B3 close (Phase 3) — if the top-5 fix work surfaces
new noise patterns, populate the disable table below.

## 2026-06-05 — Cleanup 6

Project key migrated `asafgolombek_Nimbus` → `nimbus-agent_Nimbus` (org
`asafgolombek` → `nimbus-agent`); the old key 404s. The CI step that disables
SonarCloud Automatic Analysis was pointed at the dead key, so the live project
had been running autoscan (no `lcov` coverage, `cpd.exclusions` ignored) — fixed
in `sonar-project.properties` + `.github/workflows/_test-suite.yml`.

**Policy for Cleanup 6: fix in code, do not disable rules.** No rule is added to
the disable table. The only inline suppression introduced is `typescript:S6324`
on the ANSI-escape regex in `scripts/cast-driver/normalize.ts` (literal ESC/BEL
bytes are intrinsic to OSC parsing; mirrors the existing `biome-ignore`). If the
S1313 IP-literal sweep cannot convert a site to `localhost`, a single
`typescript:S1313` suppression on one shared loopback constant may be added and
will be recorded here.

| Rule | Reason | Date | Where |
|---|---|---|---|
| _none_ | Sonar Way verified clean for B3 scope | 2026-05-01 | `sonar-project.properties` |

### PR 6 — S4325 inline `// NOSONAR` (Sonar-vs-`tsc` divergence)

S4325 ("unnecessary cast — does not change the type") had 622 sites. The vast
majority were genuinely redundant and were **removed in code** (no suppression).
A small set were Sonar **false positives**: removing the cast makes `tsc` fail,
because Sonar's type model lacks the strict-mode features our `tsconfig` enables
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), full third-party lib
types, or Bun's mock types. For these — and only these — the cast is restored
with an inline `// NOSONAR S4325: <reason>`. `tsc` is the oracle: each NOSONAR
marks a line that does **not** compile without the cast.

| Site | Cast | Why `tsc` needs it |
|---|---|---|
| `gateway/src/connectors/_lib/imap-client.test.ts` | `partial as MessageStructureObject` | `Partial<T>`→`T` under `exactOptionalPropertyTypes` |
| `gateway/src/connectors/pagerduty-sync.test.ts` (×4) | `x as string` | `string \| undefined` (captured var / `noUncheckedIndexedAccess` index) |
| `gateway/src/ipc/agents-rpc.test.ts` (×4) | `ctx.notify as ReturnType<typeof mock>` | exposes the Bun mock's `.mock.calls` |
| `gateway/src/ipc/server/vault-dispatch.test.ts` (×2) | `db as never` | minimal `{close}` stub widened to `Database` |
| `gateway/src/people/linker.test.ts` | `idA as string` | `idA` is `string \| null`; `toBe` expects `string` |
| `gateway/src/embedding/load-feature-extraction-pipeline.ts` | `as unknown as FeatureExtractionPipe` | bridges `@xenova` `FeatureExtractionPipeline` to the local interface |
| `gateway/src/perf/process-spawn-bench.ts` | `as unknown as ProcSubset` | bridges Bun `Subprocess` (`stdout?`) to `ProcSubset` |

### PR 7 — `shelldre:S7682` inline `# NOSONAR` (never-returning fatal handler)

The `shelldre:*` shell-analyzer sweep (14 issues across 5 scripts) was fixed in
code: `[` → `[[` for the bash files (`S7688`), nested-`if` merges (`S1066`), and
a positional-param-to-local assignment (`S7679`). One issue is a genuine false
positive and is suppressed inline.

| Site | Rule | Why it's suppressed |
|---|---|---|
| `.claude/hooks/bash-safety.sh` `block()` | `shelldre:S7682` | The function is a fatal handler that always terminates the hook via `exit 2`; an explicit `return` at the end would be unreachable, and rewriting it as return-then-exit at the four call sites would risk the hook's blocking guarantee. |

### PR 7 — `typescript` S77xx tail inline `// NOSONAR` (semantics-preserving exceptions)

The S77xx modernization tail was fixed in code (`String.fromCodePoint`,
`replaceAll`, `.at(-1)`, `Number.parseInt`, `globalThis`, `TypeError`, etc.).
Two sites cannot adopt the suggested rewrite without changing behavior or
breaking compilation, so the original is kept with an inline `// NOSONAR`.

| Site | Rule | Why it's suppressed |
|---|---|---|
| `great-expectations/src/gx-parse.ts` `clampId()` (now in nimbus-mcp-servers) | `typescript:S7767` | `(… ) \| 0` is a deliberate 32-bit wraparound (Java-style `hashCode`), not a truncation; `Math.trunc` would let the accumulator exceed 2^53 and corrupt the hash. |
| `sdk/src/testing/sandbox-probe.ts` | `typescript:S7787` | The specifier-less `export {}` is the module marker required by the top-level `await main()` below it; removing it makes the top-level await a compile error (TS1375). |

## 2026-09-11 — the SDK signing-surface deprecation, and one native-helper vulnerability

### `typescript:S1874` — three seam files, ~12 markers

`@nimbus-dev/sdk` 1.32.0 deprecated its whole flat manifest-signature surface in favour of a
detached-JWS envelope under `@nimbus-dev/sdk/signing`. **That envelope has not shipped** — the
subpath exports canonicalization and nothing else — so the warnings are real (removal is slated for
SDK 2.0.0) and there is nothing to migrate to, while the gateway must keep verifying the flat shape
every already-installed extension carries.

**Most of the cluster was FIXED rather than suppressed**, by splitting on what each symbol actually
is. The base64 codec, Ed25519 keygen and the `SignatureDisableReason` union are not part of the
envelope being replaced, so the gateway and CLI own them outright now
(`gateway/src/util/{base64,ed25519}.ts`, `cli/src/lib/extension-signing.ts`) — 80 of the 98
findings. What remains is only the contract itself, confined to one seam file per package:

| Site | Rule | Why it's suppressed |
|---|---|---|
| `gateway/src/extensions/verify-signature.ts` | `typescript:S1874` | `signManifest` / `verifyManifestSignature` / `errorToHardDisableReason` ARE the contract: a connector author signs with the SDK and the gateway must verify what they produced, so a local reimplementation would be a second, drifting copy on a signature-critical path. Wrapped rather than re-exported, so the deprecation stops at this file — a consumer importing a RE-EXPORTED deprecated symbol is still flagged, which is why the pre-existing re-export shed nothing. |
| `gateway/src/extensions/canonical-json.ts` | `typescript:S1874` | Here the replacement EXISTS and produces **different bytes**: the deprecated rules NFC-normalize string VALUES, the spec binding deliberately does not (Go publishes no importable normalization). Those bytes are load-bearing for every installed extension signature (`I16`) and every saved-tool signature (`I40`) already on disk, so migrating is a re-signing exercise, not an import swap. |
| `cli/src/lib/extension-signing.ts` | `typescript:S1874` | The CLI's own copy of the seam — `packages/cli` may not import gateway source. Keygen and base64 are owned here; only `signManifest` is the SDK's, for the reason above. |

Each marker is a **trailing** comment on the reported line (a marker in a block above the statement
is silently ignored). **Retire all three when the JWS envelope ships**: the migration is then a
three-file change plus a re-sign, and these rows should be deleted, not amended.

### `typescript:S7780` — `fleet-digest.ts`'s `mdSafe`, where two rules contradict each other

`mdSafe` neutralises a pipe and a backslash so an indexed PR title cannot break out of a Markdown
table cell. Two Sonar rules disagree about how to write that, and **there is no form that
satisfies both**:

| Written as | Cleared | Tripped |
|---|---|---|
| `.replaceAll("\\", "\\\\")` — an escaped string | S7781 | **S7780** ("use `String.raw`") |
| `.replaceAll(/\\/g, String.raw`\\`)` — a regex needle | S7780 | **S7781** ("this pattern can be replaced with a string") |
| `String.raw` for the needle itself | — | **does not compile** |

The third is the interesting one: a `String.raw` template holding a single backslash is a syntax
error, because that backslash escapes the closing backtick. A template literal can never end in a
lone backslash, so S7780's advice is simply not expressible for this value. Both forms were tried
on PR #1497 and each produced the other rule's finding.

Kept as the escaped-string form — the readable one, and the one that shipped — with a trailing
`// NOSONAR S7780` on each affected line. Behaviour is not taken on trust: the
`a BACKSLASH before a pipe does not smuggle a live delimiter through the escape` test pins it, and
the rendered row was additionally checked end-to-end (`a\|b` → `a\\\|b`, still four data
columns).

**Retire when** either rule stops firing on the other's remedy, or the function gains the wider
escape set its own docstring anticipates for a Markdown-rendering sink.

### `c:S5849` — `sandbox-helper/main.c` `drop_all_caps()`

Marked **Accepted** on the SonarCloud board rather than suppressed in code (it is C, and the rule is
reported as a VULNERABILITY). The flagged `cap_set_proc()` installs an EMPTY capability set
immediately before `execv`, so it _drops_ every capability rather than acquiring one — the rule
fires on any `cap_set_proc` regardless of direction. There is no code change that clears it without
removing the hardening. Issue key `AaCHEeXpGOMqvmq55deI`.

## 2026-10-03 — SonarCloud rules S9382 / S7503 / S9383 / S9381 added to the analyzer

SonarCloud's TypeScript analyzer gained four rules on 2026-09-29 (the `createdAt` its rules API
reports): `typescript:S9382` (promises awaited sequentially in a loop), `typescript:S7503` (async
functions that use no async feature), `typescript:S9383` (promises left unhandled, a BUG-type rule)
and `typescript:S9381` (nested promises). Together with the older backlog they left **448 open
findings** on `main` at `71a06515`: 439 code smells and 9 bugs. One sweep addressed all of them.

| Rule | Findings | Fixed in code | Suppressed |
|---|---|---|---|
| `typescript:S7503` | 180 | 180 | 0 |
| `typescript:S9382` | 177 | 35 | 142 |
| `typescript:S3776` | 23 | 23 | 0 |
| `typescript:S3358` | 17 | 17 | 0 |
| `typescript:S9383` (BUG) | 9 | 9 | 0 |
| `typescript:S4624` | 6 | 6 | 0 |
| `typescript:S7778` | 5 | 5 | 0 |
| `typescript:S5906` | 4 | 4 | 0 |
| `typescript:S7763`, `typescript:S7781` | 3 each | 6 | 0 |
| `typescript:S6582`, `typescript:S8786`, `typescript:S8968` | 2 each | 6 | 0 |
| one each: `typescript:` S2301, S2699, S3735, S4043, S4144, S5843, S5976, S6353, S6551, S7718, S7744, S7746, S7780, S9381, and `c:S886` | 15 | 15 | 0 |
| **Total** | **448** | **306** | **142** |

**The policy is unchanged from Cleanup 6: fix in code, do not disable rules.** No rule was disabled
and no Sonar, coverage or duplication exclusion was added. A finding was suppressed only when the
rule's suggested rewrite would change behaviour. The suppression is a TRAILING
`// NOSONAR <rule>: <specific reason>` on the exact reported line, because a marker on the line
above is silently ignored. Every suppression in this sweep is `typescript:S9382`.

### How each rule was decided

- **`typescript:S9382`, await inside a loop (177).** A loop was converted to `Promise.all`, with
  results kept in input order, only when ALL of these held:
  - the iterations are independent: no data dependency, and no `break` or early return that stops
    later work;
  - there is no ordering-observable side effect: stdout or prompt order, log order a test asserts,
    DB insert order or timestamps, egress-ledger or audit-chain appends, HITL/consent prompts,
    notifications or broadcasts;
  - nothing must fail fast, because a sequential loop never STARTS later items after a failure
    while `Promise.all` starts all of them;
  - the fan-out is bounded: no unbounded burst at a remote API, a rate limiter, process spawns or
    file handles;
  - the loop is not inside a transaction, lock or serialized resource. `bun:sqlite` is synchronous,
    so parallelising it gains nothing;
  - in a test, order does not affect determinism.

  Otherwise the loop is sequential by design. It kept its `await`, and the marker names the specific
  reason. 35 findings were fixed in code and 142 were marked. Most of the marked ones fall into a few
  recurring reasons: a paginated walk where each request needs the previous page's cursor; a shared
  per-provider rate limiter that an uncapped list would burst; fail-fast or fail-closed ordering
  (I16, I19, I23/I29, the toolgen pre-consent gate); and process spawns (`git blame`, `aws`, the
  sandbox helper). One more recurs often enough to name: Vault writes and deletes stay serial,
  because the macOS Keychain backend maintains `.keyindex.json` with an unlocked read-modify-write,
  so concurrent `set()`/`delete()` calls lose index entries.
- **`typescript:S7503`, async function with no `await` (180).** There were three cases:
  - (a) No caller or interface needs a Promise. The function was made synchronous and EVERY call
    site updated, including dropping the now-pointless `await`, which S4123 would otherwise flag.
  - (b) A Promise is required and the body cannot throw synchronously. `async` was dropped and the
    value returned through `Promise.resolve`.
  - (c) A Promise is required and the body CAN throw. The rejection was preserved with
    `Promise.try(() => …)` or a restructure, because dropping `async` would turn a rejection into a
    synchronous throw at every caller.

  Where a signature change would have reached code another part of the sweep was editing, the
  signature was kept (b or c). All 180 were fixed in code and none was suppressed.
- **`typescript:S9383`, unhandled promise (9, the only BUG-type findings).** No promise is left
  floating without a stated reason. One was a real defect: `nimbus test` did not await
  `runContractTests`, so a manifest that violated the extension contract printed
  `Extension contract OK.` and leaked an unhandled rejection. It now awaits, and fails with the
  contract error. The other eight are in the desktop UI:
  - two `navigate()` calls inside handlers that were already async are now awaited;
  - four `navigate()` calls to internal routes are marked `void`, each with a comment saying why
    they are deliberately not awaited (the router's error boundary owns route errors, and in two of
    them an `await` would feed a navigation failure into a poll or retry path);
  - one IIFE that already handles every failure in its own `try`/`catch`/`finally` is marked
    `void`;
  - `HotkeyFailedBanner` moved onto the shared `useIpcSubscription` hook, whose `.catch` owns the
    rejection as it does for every other Tauri subscription. The move also fixed a listener that
    leaked when the banner unmounted before `listen()` resolved.

  Both uses of `void` fall under `typescript:S3735`'s own stated exceptions: a promise marked as
  intentionally not awaited, and an IIFE.
- **`typescript:S3776`, cognitive complexity (23).** Each function was split along its natural
  phases into named steps, invoked in order at the call site so the sequence still reads as a list.
  This is the rule CLAUDE.md sets for gate functions: no security check moves into a helper a
  reviewer would have to hunt for, and every early return, `finally` and audit write stays where it
  was. Where the function wires an invariant, the review re-checked it against `main`. For
  `toolgen-gate.ts` (I39) that meant the check order, every fail-closed exit and the audit
  payloads, and three tests were added for an audit field no test had asserted.
- **`typescript:S2301`, selector parameter (1).** `briefTextFor(brief, demo: boolean)` now takes
  `install: { readonly demo?: boolean }`, the compliant form the rule text gives. Callers pass their
  `CliPlatformPaths` directly, or `{ demo }`.
- **Every other rule (58).** Each got the compliant fix from the rule's own text. The fix was
  checked to compile; S7780's `String.raw` advice, for example, cannot end a template in a lone
  backslash (see the 2026-09-11 section above). The diff was then re-read for findings a fix can
  itself introduce: S7778 when an extraction splits one `push` into two consecutive calls, S6582
  for a null check that wants optional chaining, and S4123 for an `await` left on a now-synchronous
  function.

### The 139 markers in the tree

142 markers were placed, one per suppressed finding. The duplication pass that followed folded six
marked loops into two shared helpers: the depth-first file walk of the data-profile,
great-expectations and localdb syncs into `_lib/collect-files.ts`, and the spawn-timing loop of
three perf surfaces (`bench-cli-overhead-cold`, `bench-cli-overhead-warm`, `bench-tui-first-paint`)
into `bench-cli-spawn-shared.ts`. It also folded the six warehouse/BI syncables' straight-line
`_list` drains into the one loop in `createWarehouseListSyncable`, which needed one new marker,
because each drain spawns the connector or opens a team session through the I19 gate. That gives
142 − 6 + 2 + 1 = **139**, all `typescript:S9382`. That is what
`git diff origin/main...HEAD -- '*.ts' '*.tsx' | grep -c '^+.*NOSONAR'` counts. The pathspec
matters: this page and the changelog entry mention the token in prose, so an unfiltered diff counts
3 more.

Sites are named by file and enclosing function rather than by line, so a row survives unrelated
edits. **Retire a row when its reason stops being true.** One example: the rows that cite the macOS
key index become plain `Promise.all` candidates if that backend ever serializes its
`.keyindex.json` updates. Another: a rate-limited loop becomes a candidate if its connector gains a
concurrency cap of its own. Then delete the marker and its row together.

### Sites (139 markers)

#### Connector syncs, connector libraries and the lazy mesh (49)

| Site | Rule | Why it stays sequential |
|---|---|---|
| `gateway/src/connectors/_lib/aws-cli.ts` `runAwsCliPaginatedWalk` | `typescript:S9382` | processEntry may spawn an `aws` CLI child per entry and reads/mutates the shared walk state; sequential keeps at most one child in flight, not a page-sized burst |
| `gateway/src/connectors/_lib/collect-files.ts` `walk` | `typescript:S9382` | depth-first walk sharing the maxFiles cap - each entry's early exit reads `found` as the previous subtree left it |
| `gateway/src/connectors/_lib/gitlab/pipelines.ts` `syncGitlabPipelinesForIndexedProjects` | `typescript:S9382` | every project request acquires the shared gitlab rate limiter, and a 429 penalises it before the next project's request |
| `gateway/src/connectors/_lib/gmail/history.ts` `applyGmailHistoryRecords` | `typescript:S9382` | history records apply in order — a message added in one record and deleted in a later one must be upserted before it is deleted |
| `gateway/src/connectors/_lib/per-app-poll-sync.ts` `runPerAppPollSync` | `typescript:S9382` | one rate-limited request per app, and the app count is unbounded; sequential keeps one request in flight and each app's builds upserted right after the app |
| `gateway/src/connectors/athena-sync.ts` `sync` | `typescript:S9382` | one `aws` CLI child process at a time (the only throttle on these AWS calls) - Promise.all would spawn one per catalog, up to MAX_CATALOGS at once |
| `gateway/src/connectors/athena-sync.ts` `sync` | `typescript:S9382` | one `aws` CLI child process at a time - each walk paginates on the previous page's NextToken, and Promise.all would spawn up to MAX_DATABASES_PER_CATALOG walks at once |
| `gateway/src/connectors/bigquery-sync.ts` `upsertTablesPage` | `typescript:S9382` | entries share `state` - the MAX_TABLES_PER_DATASET count (with its break) and the MAX_TABLE_DETAIL describe budget are spent in table order |
| `gateway/src/connectors/bigquery-sync.ts` `sync` | `typescript:S9382` | one dataset at a time - each walk paginates on the previous page token and spends up to MAX_TABLE_DETAIL describes; Promise.all would start up to MAX_DATASETS walks against the shared BigQuery rate limiter |
| `gateway/src/connectors/bitbucket-sync.ts` `resumeActiveRepoPagination` | `typescript:S9382` | paginated - each request needs the previous page's `next` URL |
| `gateway/src/connectors/blame-index-sync.ts` `blameRootFull` | `typescript:S9382` | one `git blame` subprocess at a time by design (see MAX_BLAME_FILES) - Promise.all would spawn up to MAX_BLAME_FILES at once |
| `gateway/src/connectors/blame-index-sync.ts` `blameRootIncremental` | `typescript:S9382` | one `git blame` subprocess at a time by design (see MAX_BLAME_FILES), and each change's prune/re-blame lands in `git diff` order |
| `gateway/src/connectors/blame-index-sync.ts` `sync` | `typescript:S9382` | one git subprocess at a time across ALL roots (see MAX_BLAME_FILES) - concurrent roots would multiply the spawns |
| `gateway/src/connectors/circleci-sync.ts` `sync` | `typescript:S9382` | one project at a time through the shared CircleCI rate limiter - the list is every indexed GitHub repo (uncapped), so Promise.all would be an unbounded burst |
| `gateway/src/connectors/connector-vault.ts` `migrateToPerServiceOAuthKeys` | `typescript:S9382` | each key's read decides its own write, and the writes must stay sequential (see the set below) - reading every key up front would also change what a mid-loop failure leaves migrated |
| `gateway/src/connectors/connector-vault.ts` `migrateToPerServiceOAuthKeys` | `typescript:S9382` | vault writes stay sequential - the macOS Keychain backend updates `.keyindex.json` with an unlocked read-modify-write, so concurrent set() calls lose index entries |
| `gateway/src/connectors/connector-vault.ts` `clearOAuthVaultIfProviderUnused` | `typescript:S9382` | fail-fast - on the first failure handleConnectorRemove restores every Google OAuth key, and a still-in-flight sibling delete would race that restore (as would macOS's unlocked `.keyindex.json` read-modify-write) |
| `gateway/src/connectors/connector-vault.ts` `clearOAuthVaultIfProviderUnused` | `typescript:S9382` | fail-fast - on the first failure handleConnectorRemove restores `microsoft.oauth`, and a still-in-flight sibling delete would race that write through macOS's unlocked `.keyindex.json` read-modify-write |
| `gateway/src/connectors/data-profile-sync.ts` `sync` | `typescript:S9382` | one file in memory at a time - a text file is read whole up to MAX_TEXT_BYTES, and Promise.all would hold up to MAX_FILES of them |
| `gateway/src/connectors/dbt-sync.ts` `sync` | `typescript:S9382` | one account at a time through the shared dbt Cloud rate limiter - each account paginates its own job list (up to MAX_PAGES_PER_ACCOUNT) and the account list is uncapped |
| `gateway/src/connectors/figma-sync.ts` `sync` | `typescript:S9382` | projects share one MAX_FILES budget - a project is fetched only while the earlier ones left budget (the break above), and up to MAX_PROJECTS would otherwise burst at once |
| `gateway/src/connectors/filesystem-v2-sync.ts` `syncFilesystemCodeSymbolsForRoot` | `typescript:S9382` | one `git blame` subprocess at a time (one per indexed file of the root), and this file's mtime is recorded below only once its blame has landed |
| `gateway/src/connectors/filesystem-v2-sync.ts` `sync` | `typescript:S9382` | one root at a time - each root's pass spawns git subprocesses (`git log`, a `git blame` per changed file), so concurrent roots would multiply the spawns and interleave the index writes |
| `gateway/src/connectors/firebase-sync.ts` `sync` | `typescript:S9382` | one app at a time through the shared Firebase rate limiter - `app_ids` is an uncapped owner-supplied list, so Promise.all would be an unbounded burst |
| `gateway/src/connectors/flagsmith-sync.ts` `sync` | `typescript:S9382` | one project at a time through the shared Flagsmith rate limiter - each project paginates its features (page by page, until a short page) and the project list is uncapped |
| `gateway/src/connectors/github-actions-sync.ts` `sync` | `typescript:S9382` | one repo at a time through the shared GitHub rate limiter - the list is every indexed repo (uncapped), and a rate-limit 403's penalty from one response must throttle the next request |
| `gateway/src/connectors/github-sync.ts` `enrichPrDetail` | `typescript:S9382` | fail-fast by design - a 401 or a rate limit (both throw below) must stop the pass before the next request is sent |
| `gateway/src/connectors/github-sync.ts` `enrichPrDetail` | `typescript:S9382` | fail-fast by design - this response's 401/rate-limit check decides whether the next request is sent at all |
| `gateway/src/connectors/github-sync.ts` `enrichPrDetail` | `typescript:S9382` | reads this iteration's own response body, inside the deliberately sequential pass above |
| `gateway/src/connectors/google-meet-sync.ts` `sync` | `typescript:S9382` | fail-fast by design - a dead token (UnauthenticatedError, rethrown) must stop the page before the next of up to PAGE_SIZE roster requests is sent |
| `gateway/src/connectors/great-expectations-sync.ts` `sync` | `typescript:S9382` | one artefact in memory at a time - readFile loads each file whole before the MAX_FILE_BYTES check, and Promise.all would hold up to MAX_FILES of them |
| `gateway/src/connectors/jenkins-sync.ts` `runJenkinsSyncAfterAuth` | `typescript:S9382` | bounded concurrency by design - each chunk's jobs run concurrently and chunks run one after another, so the Jenkins server never sees more than CHUNK_SIZE requests at once |
| `gateway/src/connectors/launchdarkly-sync.ts` `sync` | `typescript:S9382` | one project at a time through the shared LaunchDarkly rate limiter - each project paginates its flags (until a short page) and the project list is uncapped |
| `gateway/src/connectors/lazy-mesh/connector-spawns.ts` `ensureGoogleDriveMcp` | `typescript:S9382` | a throwing Vault read aborts the bundle before any later service's token refresh starts |
| `gateway/src/connectors/lazy-mesh/connector-spawns.ts` `ensureGoogleDriveMcp` | `typescript:S9382` | a failed refresh records this service's warning and health transition (history row + connector.healthChanged) in bundle order, not completion order |
| `gateway/src/connectors/lazy-mesh/mesh.ts` `LazyConnectorMesh.collectUserMcpToolMap` | `typescript:S9382` | a user slot's first listing spawns its user-configured server; the user-MCP count is uncapped, so they start one at a time, not as a burst of sandboxed spawns |
| `gateway/src/connectors/localdb-sync.ts` `sync` | `typescript:S9382` | one file in memory at a time - readFile loads each file whole before the MAX_FILE_BYTES check, and Promise.all would hold up to MAX_FILES of them |
| `gateway/src/connectors/mercury-sync.ts` `syncTransactions` | `typescript:S9382` | accounts share one MAX_TRANSACTION_PAGES budget in `state` - each account may only use the pages the earlier ones left (the break above) |
| `gateway/src/connectors/notion-page-body.ts` `collectChildren` | `typescript:S9382` | depth-first walk in document order - each block's text (and its children's) must land in `out` before the next block's, and all blocks share one request budget |
| `gateway/src/connectors/pagerduty-sync.ts` `resolveMissingActorEmails` | `typescript:S9382` | sequential on purpose (see the docstring) - fanning up to MAX_USER_LOOKUPS_PER_SYNC lookups at the shared limiter at once is the spike it exists to smooth |
| `gateway/src/connectors/pagerduty-sync.ts` `resolveMissingActorEmails` | `typescript:S9382` | sequential on purpose (see the docstring) - one user lookup in flight at a time |
| `gateway/src/connectors/pagerduty-sync.ts` `resolveMissingActorEmails` | `typescript:S9382` | reads this lookup's own response body, inside the deliberately sequential loop |
| `gateway/src/connectors/snyk-sync.ts` `ingestOrgProjects` | `typescript:S9382` | one project at a time through the shared Snyk rate limiter - an org's project list is uncapped, so Promise.all would be an unbounded burst |
| `gateway/src/connectors/snyk-sync.ts` `sync` | `typescript:S9382` | one org at a time through the shared Snyk rate limiter - each org fans out to one request per project, so concurrent orgs would multiply an already uncapped burst |
| `gateway/src/connectors/sonarqube-sync.ts` `sync` | `typescript:S9382` | each batch pages through its issues and upserts as it goes - concurrent batches would interleave those index writes nondeterministically through the shared SonarQube rate limiter |
| `gateway/src/connectors/warehouse-sync-transport.ts` `sync` | `typescript:S9382` | one connector session at a time - each drain spawns the connector (or opens a team session through the gate), so Promise.all would run every list's connector process at once |
| `gateway/src/connectors/workday-sync.ts` `syncRaasReports` | `typescript:S9382` | one report at a time through the shared Workday rate limiter - the configured report list is uncapped, and each report's warnings and index writes land in config order |
| `gateway/src/connectors/workday-sync.ts` `syncRaasReports` | `typescript:S9382` | one report request in flight at a time (see the acquire above) |
| `gateway/src/connectors/workday-sync.ts` `syncRaasReports` | `typescript:S9382` | reads this report's own response body, inside the deliberately sequential loop |

#### IPC handlers (11)

| Site | Rule | Why it stays sequential |
|---|---|---|
| `gateway/src/ipc/connector-rpc-handlers/removal.ts` `restoreGoogleAndMicrosoftOAuthBackups` | `typescript:S9382` | sequential by design - the macOS vault's set() read-modify-writes one shared key index, so concurrent restores would drop entries |
| `gateway/src/ipc/connector-rpc-handlers/removal.ts` `resumePendingRemovals` | `typescript:S9382` | sequential by design - the provider-unused check counts index rows that the previous pending removal just deleted |
| `gateway/src/ipc/connector-rpc-handlers/removal.ts` `resumePendingRemovals` | `typescript:S9382` | sequential by design - each pending removal completes (index, OAuth, secrets, intent) before the next one's provider-unused check |
| `gateway/src/ipc/federation-rpc.ts` `"team.auditMerged"` | `typescript:S9382` | one peer at a time on purpose - the paired-peer count is unbounded, and federation fan-out is otherwise capped (FANOUT_CONCURRENCY, federation/peer-fanout.ts) |
| `gateway/src/ipc/index-rebody-rpc.ts` `runRebody` | `typescript:S9382` | sequential by design - each forceSync is a full connector sync (API quota, an I29 sync egress row); the loop honours cancellation between services and reports in-order progress |
| `gateway/src/ipc/index-reembed-rpc.ts` `embedSlice` | `typescript:S9382` | sequential by design - a 429/5xx must stop the slice so the caller's retry-after backoff applies; parallel calls would burst the rate-limited remote embedder |
| `gateway/src/ipc/index-reembed-rpc.ts` `runReembed` | `typescript:S9382` | sequential by design - batches pace the rate-limited embedder (retry-after sleeps), and the loop checks cancellation and reports progress per batch |
| `gateway/src/ipc/lan-server.ts` `LanServer.handleChunk` | `typescript:S9382` | sequential by design - frames are a stream: the handshake sets the session state the next frame is read with, and a peer's RPCs (which can raise consent prompts) are answered one at a time, in order |
| `gateway/src/ipc/session.ts` `ClientSession.dispatchLines` | `typescript:S9382` | sequential by design - a client's pipelined messages are handled in arrival order, so each sees the effects (vault/DB writes) of the ones before it |
| `gateway/src/ipc/teamvault-rpc.ts` `"teamvault.put"` | `typescript:S9382` | sequential by design - the macOS vault's set() read-modify-writes one shared key index (concurrent sets drop entries), and a non-string secret must stop the loop before later secrets are written |
| `gateway/src/ipc/teamvault-rpc.ts` `"teamvault.delete"` | `typescript:S9382` | sequential by design - the macOS vault's delete() read-modify-writes one shared key index, so concurrent deletes would lose index updates |

#### Extensions (install, update, I16 verification) (12)

| Site | Rule | Why it stays sequential |
|---|---|---|
| `gateway/src/extensions/auto-update.ts` `ExtensionAutoUpdater.pollOnce` | `typescript:S9382` | one registry round-trip per extension, kept serial (no burst at the remote registry) and each new detection appends to the audit chain in a deterministic order |
| `gateway/src/extensions/dependency-graph.ts` `visit` | `typescript:S9382` | the candidate is chosen against the ranges and pins earlier siblings' subtrees left in ctx |
| `gateway/src/extensions/dependency-graph.ts` `visit` | `typescript:S9382` | needs this iteration's candidate, and shares ctx.manifestCache with the rest of the solve |
| `gateway/src/extensions/dependency-graph.ts` `visit` | `typescript:S9382` | depth-first recursion - cycle detection relies on ctx.ancestors holding exactly the current path, one subtree at a time |
| `gateway/src/extensions/install-from-local.ts` `installPlanNodes` (×2) | `typescript:S9382` | topological, fail-fast install order: `plan.nodes` is dependencies-first, nothing further may start after the first failure, and the catch rolls back exactly the directories created so far |
| `gateway/src/extensions/registry-client.ts` `fetch` | `typescript:S9382` | retry loop - each attempt runs only after the previous one failed transiently |
| `gateway/src/extensions/sync.ts` `run` | `typescript:S9382` | one registry fetch, Vault write and audit append per publisher, serial so the shared result lists and the audit chain keep a deterministic order |
| `gateway/src/extensions/verify-extensions.ts` `runSignatureVerificationPass` | `typescript:S9382` | I16 startup pass, one row at a time in registry order: each row reads its publisher key from the OS Vault, a failed row is disabled, logged and its client stopped before the next is checked, and the failures feed the audit row in registry order |
| `gateway/src/extensions/verify-extensions.ts` `runSignatureVerificationPass` | `typescript:S9382` | I16 fail-closed - the disabled extension's client is stopped before the next row is verified |
| `gateway/src/extensions/verify-extensions.ts` `verifyExtensionsBestEffort` | `typescript:S9382` | fail-closed - stopped one at a time in registry order; a failed stop rejects the pass before any later stop or verification starts |
| `gateway/src/extensions/verify-extensions.ts` `verifyExtensionsBestEffort` | `typescript:S9382` | I16 startup verify - each row may rename dirs, write the DB and audit chain, and stop its client; rows go one at a time in registry order |

#### Toolgen (I39/I40) and Vault-touching commands (11)

| Site | Rule | Why it stays sequential |
|---|---|---|
| `gateway/src/commands/data-delete.ts` `runDataDelete` | `typescript:S9382` | the macOS vault's delete rewrites one shared key-index file (read-modify-write); concurrent deletes would lose index updates |
| `gateway/src/commands/data-export.ts` `collectVaultManifestPlaintext` | `typescript:S9382` | one read per stored key - on Linux each spawns a secret-tool process, so Promise.all would be an unbounded process burst |
| `gateway/src/commands/data-import.ts` `runDataImport` | `typescript:S9382` | fail-fast restore - writtenKeys must hold exactly the keys written before a failure, for the rollback below |
| `gateway/src/commands/data-import.ts` `runDataImport` | `typescript:S9382` | the macOS vault's delete rewrites one shared key-index file (read-modify-write); concurrent deletes would lose index updates |
| `gateway/src/teamvault/team-tool-invoke.ts` `assertTeamSecretsPresentAndView` | `typescript:S9382` | I19 fail-closed guard - stops at the first missing team secret, so later secrets are never read; Promise.all would read every one first |
| `gateway/src/toolgen/toolgen-boot-reconcile.ts` `verifySavedToolRows` | `typescript:S9382` | one saved tool at a time - each row's I40 re-verify feeds that row's own isolated DB write, and the saved-tool count is unbounded at boot |
| `gateway/src/toolgen/toolgen-boot-reconcile.ts` `sweepOrphanSavedToolDirs` | `typescript:S9382` | destructive sweep, one directory at a time - each removal's failure is isolated and logged before the next starts, and the orphan count on disk is unbounded |
| `gateway/src/toolgen/toolgen-confinement.ts` `assertToolConfinement` | `typescript:S9382` | pre-consent and fail-fast - the gate refuses at the first grant directory it cannot create, before creating any later one |
| `gateway/src/toolgen/toolgen-credential-sweep.ts` `sweepToolgenCredentials` | `typescript:S9382` | Vault deletes stay serial - the macOS backend's key index is a read-modify-write JSON file, so concurrent deletes would lose index updates |
| `gateway/src/toolgen/toolgen-credentials.ts` `deleteCredentialsForTool` | `typescript:S9382` | Vault deletes stay serial - the macOS backend's key index is a read-modify-write JSON file, so concurrent deletes would lose index updates |
| `gateway/src/toolgen/toolgen-saved-spawn.ts` `loadSavedToolsIntoRegistry` | `typescript:S9382` | verify-then-register one row at a time - the saved-tool count is unbounded, and a throwing verify must stop the load at that row with earlier rows already registered |

#### Perf tooling (11)

| Site | Rule | Why it stays sequential |
|---|---|---|
| `gateway/src/perf/bench-ci-gh.ts` `GhCli.#run` | `typescript:S9382` | retry loop - the next attempt runs only after this one failed and its backoff elapsed |
| `gateway/src/perf/bench-ci.ts` `resolveBaseline` | `typescript:S9382` | `_perf.yml`'s scheduled runs can share a headSha, and every download writes `prevDir/<headSha>` - concurrent downloads would race on one directory |
| `gateway/src/perf/bench-harness.ts` `runBench` | `typescript:S9382` | benchmark runs must not overlap - concurrent runs contend for CPU and IO and skew every sample |
| `gateway/src/perf/rss-sampler.ts` `sampleRss` | `typescript:S9382` | time-series sampler - each RSS reading belongs to its own interval tick, taken after the previous one |
| `gateway/src/perf/rss-sampler.ts` `sampleRss` | `typescript:S9382` | the wait until the next interval tick is what spaces the samples |
| `gateway/src/perf/surfaces/bench-cli-spawn-shared.ts` `sampleCliSpawns` | `typescript:S9382` | timing samples must not overlap - concurrent CLI spawns contend for CPU and skew each measured time, and a warm-up only warms what runs after it |
| `gateway/src/perf/surfaces/bench-cold-start.ts` `runColdStartOnce` | `typescript:S9382` | cold starts must not overlap - concurrent gateways contend for CPU and skew each measured boot |
| `gateway/src/perf/surfaces/bench-embedding-throughput.ts` `runEmbeddingThroughputOnce` | `typescript:S9382` | S8 measures throughput AT this batch size - overlapping batches would measure concurrency on one inference session instead |
| `gateway/src/perf/surfaces/bench-sync-throughput-shared.ts` `runSyncThroughputOnce` | `typescript:S9382` | throughput samples must not overlap - each boots its own gateway and times a full sync, and an injected mswServer is shared across samples |
| `gateway/src/perf/surfaces/spawn-test-helpers.ts` `start` | `typescript:S9382` | simulated stream pacing - each chunk is enqueued only after the previous chunk's delay |
| `gateway/src/perf/surfaces/sqlite-worker-shared.ts` `runWorkerLoop` | `typescript:S9382` | SQLITE_BUSY backoff - the next write is attempted only after this wait |

#### Other gateway modules (37)

| Site | Rule | Why it stays sequential |
|---|---|---|
| `gateway/src/agents/_lib/tour-plan.ts` `buildTourPlan` | `typescript:S9382` | only standup awaits (resolveSelf); the other 5 selectors are synchronous bun:sqlite reads on one connection, so Promise.all would gain nothing measurable |
| `gateway/src/auth/pkce.ts` `runOnLocalPort` | `typescript:S9382` | poll loop - each 50 ms wait must elapse before re-checking whether the callback or the timeout settled `completion` |
| `gateway/src/auth/pkce.ts` `runPKCEFlow` | `typescript:S9382` | port fallback - the next port is tried only after this one failed to bind; each attempt binds a callback server and opens the browser |
| `gateway/src/briefs/poll-until-terminal.ts` `pollBriefUntilTerminal` | `typescript:S9382` | polling — the next GET may only follow a non-terminal answer to this one |
| `gateway/src/chatops/chatops-service.ts` `ChatopsService.start` | `typescript:S9382` | fail-fast — a transport that fails to start aborts start() before any later transport goes live |
| `gateway/src/chatops/chatops-tool-runner.ts` `buildChatopsToolRunner` (a callback inside it) | `typescript:S9382` | fail-closed (I19 pattern) — the first missing bot secret aborts before any later secret is read |
| `gateway/src/chatops/reply-dispatcher.ts` `ReplyDispatcher.send` | `typescript:S9382` | I23/I29 — each post appends its own egress row first; posts go out in order and a failure stops later channels |
| `gateway/src/decisions/decision-extract.ts` `runModelQueue` | `typescript:S9382` | one LOCAL-model call per row - a local runtime queues concurrent requests while each provider fetch's fixed 120 s timeout keeps running, so a burst turns into timed-out attempts |
| `gateway/src/embedding/backfill-gate.ts` `gate` | `typescript:S9382` | power poll - each pass re-probes only after the previous wait, and the waiting IS the pause |
| `gateway/src/embedding/pipeline.ts` `runWorker` | `typescript:S9382` | bounded pool - a worker takes its next item only after the last settles, which is what caps in-flight embeds at `limit` |
| `gateway/src/embedding/pipeline.ts` `SqliteEmbeddingPipeline.backfillAll` | `typescript:S9382` | drain loop - each page is the items still un-embedded, so it exists only after the previous batch is written |
| `gateway/src/embedding/pipeline.ts` `SqliteEmbeddingPipeline.backfillForRoutingKeys` | `typescript:S9382` | drain loop - each page is the items still un-embedded, so it exists only after the previous batch is written |
| `gateway/src/federation/peer-fanout.ts` `pump` | `typescript:S9382` | pool lane - one peer at a time per lane is what caps in-flight peers at FANOUT_CONCURRENCY |
| `gateway/src/fleet/fleet-scheduler.ts` `FleetScheduler.runSweepJob` | `typescript:S9382` | one agent run at a time on idle local hardware (the sequential-invoker contract), with admission re-probed between subjects and the rotation cursor advanced after each |
| `gateway/src/glossary/glossary-extract.ts` `consolidatePhase` | `typescript:S9382` | deliberately sequential (see the doc above) - concurrent calls multiply resident model memory on a local Ollama, and each term re-checks the abort signal and reports ordered progress |
| `gateway/src/identity/oidc-device-flow.ts` `pollDeviceToken` | `typescript:S9382` | RFC 8628 device-code polling — the next token request must wait the IdP-mandated interval after this response |
| `gateway/src/llm/router.ts` `LlmRouter.eligibleRoutes` | `typescript:S9382` | lazy priority walk - a route is probed only when the consumer pulls past the previous one |
| `gateway/src/multimodal/cloud-bytes.ts` `fetchWithRetry` | `typescript:S9382` | retry backoff - the next attempt may only start once this 429/503 wait has elapsed |
| `gateway/src/multimodal/cloud-bytes.ts` `readBodyBounded` | `typescript:S9382` | ordered sink - each chunk must land after the previous one, and for the scratch-file sink this await is the backpressure |
| `gateway/src/multimodal/frames/av-understander.ts` `sampleFrameCaptions` | `typescript:S9382` | one frame at a time - every frame shares this artifact's single GPU lease and one local ffmpeg/VLM, so concurrent frames would only contend for the same device |
| `gateway/src/multimodal/media-pass.ts` `runMediaPass` | `typescript:S9382` | cursor-ordered pass - each item spends the budget the previous ones left and advances the resume cursor, and a stop must not start later items |
| `gateway/src/oncall-push/push-runner.ts` `once` | `typescript:S9382` | one agents.oncall session at a time - the has() re-check above must see every row stored before it, and a failed insert must stop the later briefs (the finally delivers the rows already stored) |
| `gateway/src/oncall-push/push-runner.ts` `loop` | `typescript:S9382` | single-flight rerun - the loop condition is set by run() calls landing while the previous once() ran, and runs never overlap (each dedups against the rows the last one stored) |
| `gateway/src/oncall-push/push-sinks.ts` `createPushDeliverer` (a callback inside it) | `typescript:S9382` | human-facing toasts are shown one at a time, newest first (the sort above) - concurrent notify calls would let a slow notifier reorder or stack the capped toasts |
| `gateway/src/platform/assemble.ts` `drainOnPair` | `typescript:S9382` | FIFO drain - the peer receives its queued forwards one at a time in received_at order, over an unbounded queue |
| `gateway/src/platform/assemble.ts` `bindCredentials` | `typescript:S9382` | Vault WRITES - macOS set() updates `.keyindex.json` by an unlocked read-modify-write, so concurrent sets lose index entries; one at a time also stops at the first failure rather than writing more secrets for a tool that may never register |
| `gateway/src/platform/assemble.ts` `revokeCredentials` | `typescript:S9382` | macOS Vault deletes update `.keyindex.json` by unlocked read-modify-write, so concurrent deletes lose index entries; the per-host catch already attempts every host |
| `gateway/src/platform/dirs.ts` `ensurePlatformDirectories` | `typescript:S9382` | fail-fast boot - the first directory that cannot be made stops the run before any later one is created, and its error is the one reported |
| `gateway/src/platform/sandbox/orphan-reap.ts` `reapOrphanedAppContainers` | `typescript:S9382` | one sandbox-helper spawn per profile against the machine-wide AppContainer registry, over an unbounded orphan count |
| `gateway/src/policy/gdpr-purge-retry.ts` `retryPendingPurges` | `typescript:S9382` | each request is bracketed by its own incrementAttempt/markDone writes, stamped in order; concurrent requests would reorder those rows and fan out to every peer at once |
| `gateway/src/share/recipe-runner.ts` `replayRecipe` | `typescript:S9382` | replay runs the steps in recorded order (see the doc above); concurrent replay would fire up to MAX_REPLAY_STEPS (256) live, credentialed connector calls at once |
| `gateway/src/sync/rate-limiter.ts` `ProviderRateLimiter.acquireUnderLock` | `typescript:S9382` | token-bucket wait - each pass re-reads the clock after the previous sleep to see whether enough tokens have refilled |
| `gateway/src/sync/scheduler.ts` `SyncScheduler.stop` | `typescript:S9382` | drain poll - re-checks runningGlobal every 10 ms until in-flight jobs finish; there is no independent work to overlap |
| `gateway/src/sync/targeted-fetch.ts` `acquireWithinTimeout` | `typescript:S9382` | bounded poll - each attempt retries one token acquire only after the previous one failed and the interval elapsed |
| `gateway/src/tribal/tribal-boot.ts` `scan` | `typescript:S9382` | each suggestion is an outbound ChatOps post (a ledgered I29 chatops row when ChatOps is live) under the chat platform's rate limit, sent one at a time in cluster order |
| `gateway/src/voice/wake-word.ts` `WakeWordDetectorImpl.pollLoop` | `typescript:S9382` | one capture cycle at a time — the microphone is a single device, and a detection's cooldown must elapse before the next recording starts |
| `gateway/src/voice/wake-word.ts` `WakeWordDetectorImpl.pollLoop` | `typescript:S9382` | the poll interval is a deliberate pause between capture cycles |

#### CLI (6)

| Site | Rule | Why it stays sequential |
|---|---|---|
| `cli/src/commands/connector-detect.ts` `runConnectorDetect` | `typescript:S9382` | each finding prompts the owner (the pick, then the gateway's HITL consent) — prompts on one terminal must not interleave |
| `cli/src/commands/init.ts` `awaitGatewayState` | `typescript:S9382` | bounded poll — each sleep paces the next state read, and the loop ends on the first read that finds the state |
| `cli/src/commands/repl-core.ts` `runRepl` | `typescript:S9382` | interactive REPL — the next line is read only after this turn's reply has printed |
| `cli/src/commands/start.ts` `waitForGatewayReady` | `typescript:S9382` | readiness poll — each probe must wait out the interval after the previous one, and the early returns end it |
| `cli/src/lib/run-tour.ts` `runTour` | `typescript:S9382` | steps print to stdout in order, and each one's process.exitCode save/restore needs it finished before the next starts |
| `cli/src/lib/stop-and-wait.ts` `stopAndWaitForExit` | `typescript:S9382` | exit poll — each liveness check must wait pollMs after the previous one, and the deadline throw ends it |

#### Desktop UI (2)

| Site | Rule | Why it stays sequential |
|---|---|---|
| `ui/src/pages/onboarding/Connect.tsx` `onAuth` | `typescript:S9382` | each connector.auth runs an interactive sign-in (OAuth opens a browser consent page + loopback callback) - one provider prompt at a time |
| `ui/src/providers/GatewayConnectionProvider.tsx` `runFirstConnect` | `typescript:S9382` | retry loop - the backoff must elapse before the next first-connect attempt |

If you disable a rule, record:

- Rule key (e.g., `typescript:S1135`)
- Reason (one sentence; tie to a non-negotiable, an existing test, or a stylistic
  decision documented in `CLAUDE.md` / `docs/architecture.md`)
- Date
- Disabled in: `.sonarcloud.properties` / SonarQube web UI / etc.

Format:

| Rule | Reason | Date | Where |
|---|---|---|---|
| `typescript:Sxxxx` | … | YYYY-MM-DD | … |

If Phase 2 does not need to disable any rule, this file remains empty and is
removed at B3 close.

Source spec: B3 structure audit design § 4.1.
