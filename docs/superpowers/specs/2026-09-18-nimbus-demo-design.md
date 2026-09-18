# `nimbus demo` — a seeded, isolated synthetic org — design

**Status:** approved in brainstorming 2026-09-18 (four sections, each confirmed). Branch
`dev/asafgolombek/nimbus-demo`. This file lives on the feature branch only and is stripped before
the implementation PR; its durable content moves to `docs/architecture.md`,
`docs/SECURITY-INVARIANTS.md`, `docs/cli-reference.md` and `docs/roadmap.md`.

**Roadmap rows:** `docs/roadmap.md` § First-Run & Time-to-Wow — "`nimbus demo` — seeded sandbox";
`docs/ecosystem-roadmap.md` Track E "Demo corpus" and § 7 "Profiles as a real data root, and the
demo corpus that proves it".

## 1. Problem

A new user's index is empty at minute one, so every differentiated agent brief returns nothing
useful until connectors are authenticated and a sync has run. Measured adoption is the binding
constraint (28 unique repository visitors in the 14 days to 2026-08-27; nothing external links in).
An evaluator who has just installed Nimbus needs to see a real brief, on their own machine, without
connecting anything.

**Success:** a stranger runs `nimbus demo` on a fresh install and, within about a minute, reads three
real agent briefs over a synthetic org — produced by the production renderers, disclosures intact —
without authenticating a connector, configuring a model, or touching their real Nimbus data.

**Audience:** the evaluator on their own machine (chosen over "recording source for the README
cast"). A later cast may be recorded from this command, but that is not a goal here.

## 2. Constraints found during design (verified, not assumed)

1. **The perf-bench corpora are unusable as an org seed.** `perf/perf-fixture.ts`
   `buildSyntheticIndex` writes only `github/pr "Synthetic PR N"` rows into a hand-written
   (non-migrated) `item` table — no people, graph edges, CI, deployments, blame or metadata. Every
   agent would return empty. The roadmap row's "repurpose the perf-bench synthetic corpora" is
   corrected here, not followed. The realistic base is the e2e scenario seeders (notably
   `test/fixtures/dora/payment-service/seed.ts`, already expressed as offsets from one pinned now),
   which write through production APIs.
2. **`dataDir` deliberately has no override** (`platform/paths.ts`: "Only `configDir` moves —
   `dataDir` deliberately does not"). Seeding without a separate data root would write synthetic
   rows into the user's real index — the "data-loss-grade defect" `ecosystem-roadmap.md` § 7 names.
3. **Existing `nimbus profile` profiles share ONE index** — they switch only between
   `nimbus.<name>.toml` files. Turning profiles into data roots would silently present an existing
   multi-profile user with an empty index; that is a user-visible breaking change and is rejected.
4. **The demo needs its own config dir, not only its own data dir.** A demo gateway reading the
   real `nimbus.toml` would run the user's real connectors and sync real data into the demo DB, and
   would open the real Vault.
5. **The local embedder downloads.** `embedding/load-feature-extraction-pipeline.ts` pulls
   `Xenova/all-MiniLM-L6-v2` into `<dataDir>/models`; a fresh demo `dataDir` has an empty cache.
   `[embedding] enabled = false` makes `embeddingRuntimeWanted` return `false` before any fetch
   (`embedding/create-embedding-runtime.ts`), so the demo config disables embeddings and search runs
   keyword-only — which #1535 already discloses per result.
6. **Seeded blame survives a root with no `.git`.** `connectors/blame-index-sync.ts` `blameOneRoot`
   returns `null` (skip, no prune) when `gitHeadSha` is `null`; `connectors/filesystem-v2-sync.ts`
   indexes `git_commit` items only when `.git` exists and reports `itemsDeleted: 0`. Seeded
   `git_blame_line` and `filesystem/git_commit` rows are therefore not purged by a sync tick.
7. **SQLite alone is not enough.** The briefs also read `nimbus.toml`: `[user] mePersonId`
   (`agents/_lib/self-person.ts` — otherwise "me" resolves to the evaluator's real git email and
   `standup`/`oncall` refuse), `[metrics.dora.<id>]` service configs (`oncall`, `stats`,
   `changelog`), and `[[filesystem.roots]]` (`why`, `ownership`). `glossary_term` /
   `decision_record` / ownership `graph_entity` rows exist only after their passes run.
8. **Not resolved statically:** the exact behaviour of `nimbus --demo ask` with no model route
   (`engine/run-ask.ts` route selection spans several modules). Resolved empirically in PR 2 (§ 6).
9. **To verify in the plan:** which read methods (`connector.listStatus`, `nimbus status`, `doctor`)
   read from the `SyncScheduler` rather than the DB, and therefore need a defined empty answer when a
   demo gateway does not construct one (§ 5). A read that throws on a missing scheduler would turn
   `nimbus --demo status` into an error.

## 3. Isolation — PR 1

### 3.1 The seam

One environment variable, `NIMBUS_DEMO=1`, read by **both** mirrored path modules —
`packages/gateway/src/platform/paths.ts` and `packages/cli/src/paths.ts`. The CLI's global `--demo`
flag sets it for its own process; `cli/src/lib/spawn-gateway.ts` already forwards the environment to
the gateway it spawns.

**Parsing is exact.** Unset, `""` and `"0"` mean off; `"1"` means on; **any other value refuses**
with a named error (`NIMBUS_DEMO must be 1 or unset`). Silently treating `"true"` as off would run
against the REAL root a user who typed it believed they had left.

**The CLI sets it before anything resolves a path.** `packages/cli/src/index.ts` resolves
`getCliPlatformPaths()` and opens the CLI file logger (lines 205–206) BEFORE dispatch, and dispatch
takes `rawArgv[0]` as the command (line 213). So a flag parsed inside a command would (a) have
already written `cli-YYYY-MM-DD.log` into the REAL `logDir`, and (b) make `nimbus --demo oncall`
dispatch the command `--demo`. A pre-pass at the top of `index.ts`, before line 205, sets
`NIMBUS_DEMO=1` when argv contains `--demo` or the subcommand is `demo`, and strips every `--demo`
token from the argv handed to dispatch. No existing command defines its own `--demo` flag (checked
2026-09-18), so stripping it globally shadows nothing.

When set, every path moves under one demo root inside the REAL data dir:

| Path | Demo value |
|---|---|
| `configDir` | `<realDataDir>/demo/config` |
| `dataDir` | `<realDataDir>/demo/data` |
| `logDir`, `extensionsDir` | under the demo `dataDir`, same shape as today |
| `tempDir` | `join(tmpdir(), "nimbus-demo")` — not `tmpdir()/nimbus`, which the real processes use |
| socket | the platform default with `-demo` inserted before any extension: `\\.\pipe\nimbus-gateway-demo` (Windows), `<dir>/nimbus-gateway-demo.sock` (macOS/Linux) |
| `gateway.json` | under the demo `dataDir` (follows `dataDir`) |

Inside the real data dir so `nimbus demo reset` has exactly one directory to remove and nothing about
the demo root is read from config.

### 3.2 Fail-closed precedence

`NIMBUS_DEMO=1` together with `NIMBUS_CONFIG_DIR` or `NIMBUS_GATEWAY_SOCKET` **refuses at path
resolution** (gateway startup and every CLI command) with a named error. No precedence is chosen: a
demo process honouring a real `NIMBUS_CONFIG_DIR` would open the real `nimbus.toml` and Vault.
`NIMBUS_PROFILE` needs no rule — the profile marker and `nimbus.<name>.toml` are resolved inside the
demo `configDir`, where none exist, so it falls through to the demo `nimbus.toml`.

### 3.3 Invariant I41 — demo isolation

**I41:** a demo-rooted process never resolves the real `configDir`, the real `dataDir` (other than
the `demo/` subtree it owns), the real `tempDir`, or the real socket; and synthetic seed rows can be written only by a
demo-rooted gateway (§ 4.1). Consequences: the Vault is a fresh, empty store under the demo config
(zero connector credentials), and the demo `nimbus.toml` is written by the seeder, never copied.

Triple rule, in PR 1's single commit: wiring (both path modules), a `docs/SECURITY-INVARIANTS.md`
section, and an enforcement test in `packages/gateway/src/security-invariants.test.ts`. The second
clause (seeding) is added to the same section and test block in PR 2, where its wiring lands.
**No document states the isolation property before its enforcement test exists** (§ 7 of
`ecosystem-roadmap.md`).

### 3.4 What PR 1 delivers alone

`nimbus --demo status` against an empty, isolated gateway running beside the real one. No corpus.

## 4. Corpus and seeding — PR 2

### 4.1 Seeding runs in the gateway, behind a demo-only method

The CLI may not import gateway source, so seeding happens inside the gateway through one IPC method,
`demo.seed`, **registered only when the gateway is demo-rooted**. A normal gateway has no handler and
answers `Method not found` — the second clause of I41 is structural (the code path does not exist
there), not a runtime refusal. The method is:

- CLI-only; absent from the Tauri `ALLOWED_METHODS` (I7).
- **LAN-forbidden explicitly** — `checkLanMethodAllowed` is a denylist, so a new namespace is
  LAN-reachable by default; the `demo` namespace is added to `FORBIDDEN_OVER_LAN`
  (`ipc/lan-rpc.ts`) with a test that CALLS the check, plus a negative control.
- Routed in both the inner dispatcher and the outer method-routing match; proven over a real socket
  by an e2e test (a handler present without routing passes unit tests and fails live).

`demo.seed` **never truncates**. It seeds only a freshly migrated, EMPTY index and refuses
(`ERR_DEMO_ALREADY_SEEDED`) when `item` holds any row. Re-seeding is done by recreating the demo data
root, not by deleting rows (§ 4.4): `packages/gateway/src/index/` holds 83 `CREATE TABLE` statements across 47 files (counted 2026-09-18), so a
hand-maintained truncation list would be wrong on the day it was written and silently incomplete
on the day a migration adds a table. It takes `now` from the gateway clock (a test seam injects
it).

### 4.2 Corpus format

A typed TypeScript module in a new `demo/corpus/` directory under the gateway's `src/` (not JSON,
so the compiler checks it; it does not exist yet, hence no full path here). Every record carries `offsetMs` relative to `seedNow`; **no absolute timestamp appears in
the corpus** (enforced by test). Written through production APIs only — `upsertIndexedItem`,
`insertPerson`, `upsertBlameLines`, `annotateDeployment` — then `runOwnershipPass`,
`runGlossaryPass` and `runDecisionPass` run explicitly (without an LLM they use their deterministic
snippet fallback). Graph edges therefore come from the production populators, not hand-written rows.

Every name, email and URL uses the reserved `.example` domain (`acme.example`,
`https://github.example/acme/payments/pull/412`), so nothing in the corpus resolves to a real person,
repository or service.

The seeder also writes the demo `nimbus.toml`:

- `[user] mePersonId` → the demo persona (never the evaluator's identity).
- `[metrics.dora.<id>]` for the three services.
- `[[filesystem.roots]]` → `<demoRoot>/workspace/acme-payments/`, into which it writes a handful of
  plain source files (no `.git`), so `why`'s relative-ref arm finds them on disk; cached blame rows
  mean `why` never spawns git (§ 2.6).
- `[embedding] enabled = false` (§ 2.5).
- HTTP API, LAN server, ChatOps and `[fleet]` disabled, and no connector configured — so the demo
  gateway cannot collide with the real gateway's ports and has nothing that makes an outbound call.

### 4.3 The storyline

Fictional org "Acme": 8 people, 3 services (`payment-service`, `checkout-web`, `ledger-worker`). One
connected thread every tour brief reaches from a different angle:

- Ticket `PAY-231` → PR #412 by Dana, changing `src/retry/backoff.ts`, merged with a
  `merge_commit_sha`, CI green.
- Deployed to `payment-service` at T−47m.
- P1 PagerDuty incident at T−38m, "payment-service 5xx spike", **assigned to the demo persona**.
- `#payments-incidents` chat naming the service; a same-service incident three weeks earlier.
- All blame on `backoff.ts` is Dana's → bus factor 1.

Around it, a few hundred background items over 90 days (PRs, reviews, tickets, messages, deploys
including one failed one, decision and glossary threads) so `standup`, `expert`, `stats`/DORA,
`changelog`, `glossary` and `decisions` return real content.

### 4.4 Time drift

Agent windows are 24h/48h/3d/90d, so a corpus rebased on Monday is stale by Friday. `nimbus demo`
re-seeds on every run by **recreating** the root: stop the demo gateway, **wait for its process to
exit**, delete `demo/data` and `demo/workspace`, start a fresh demo gateway (which migrates an empty
DB), then call `demo.seed`. `nimbus --demo status` reports the seed age.

**Waiting for exit is required, not polish.** `nimbus stop` today sends SIGTERM and returns
immediately (`cli/src/commands/stop.ts`), and on Windows SIGTERM is `TerminateProcess` — the process
dies, but its handles on `nimbus.db`, `-wal`, `-shm` and the log are released asynchronously, so an
immediate recursive delete fails with `EBUSY`/`EPERM`. A shared `stopAndWaitForExit` helper signals,
polls `process.kill(pid, 0)` to a bounded deadline, and only then returns; `nimbus demo`,
`demo stop` and `demo reset` all use it. Past the deadline it fails loudly (naming the pid) rather
than deleting a directory a live process still holds. Because every `nimbus demo` run recreates the
root, this is on the common path, not only on `reset`.

## 5. Command surface

- `nimbus demo` — start the demo gateway if not running, `demo.seed`, run the tour. `--no-tour`
  seeds and prints the suggested commands only.
- `nimbus demo stop` — stop the demo gateway. `nimbus demo reset` — stop it and delete the demo root.
- `--demo` — global flag on every command.

The demo gateway runs beside the real one until `demo stop`; `nimbus demo`'s last line says so.

**Tour** — three briefs through the existing agent IPC methods, in story order, each preceded by the
exact command that reproduces it and printed **verbatim** (production renderer, `## Gaps` intact,
never reformatted or trimmed):

1. `nimbus --demo oncall` — the paging incident and the deploy nine minutes before it.
2. `nimbus --demo why src/retry/backoff.ts:42` — the line → PR #412 → `PAY-231`.
3. `nimbus --demo owners src/retry` — bus factor 1.

Each tour step is introduced by a fixed two-line header, then the verbatim brief:

```text
── [1/3] On-call triage ─────────────────────────────
$ nimbus --demo oncall
```

When stdout is not a TTY the tour prints the same text with no spinner or cursor-control escapes.
`nimbus demo --json` is not offered (§ 8).

**Labelling** — every command run with `--demo` prints one line to **stderr** (so `--json` output
stays parseable), in one of three states:

- seeded: `DEMO — synthetic "Acme" org, not your data · seeded 2h ago · nimbus demo reset to remove`
- stale (seed older than 24h, the narrowest agent window):
  `DEMO — synthetic "Acme" org · seeded 3d ago (stale — briefs may be empty) · run nimbus demo to re-seed`
- unseeded (a demo gateway reachable but `item` empty):
  `DEMO — not seeded yet · run nimbus demo`

A `--demo` command with no demo gateway running fails with the existing "Gateway is not running"
error, but its hint names `nimbus demo`, not `nimbus start` (which would start the REAL gateway).
`--demo` commands never auto-seed: a gateway that writes synthetic rows as a side effect of booting,
or of an unrelated read, is a harder property to reason about than one explicit `nimbus demo`.

**Keeping "synthetic only" true** — two layers, so neither is load-bearing alone:

1. **Structural:** a demo gateway does not construct or start the `SyncScheduler`
   (`platform/assemble.ts`). No connector can sync into the demo index, whatever credentials or
   config reach it.
2. **Refusal at the one routing choke point** — `dispatchMethod` in `ipc/server/server.ts`, before
   any namespace dispatcher, refuses with `ERR_DEMO_FORBIDDEN` (naming the real profile as the place
   to connect accounts):
   - every `connector.*` method EXCEPT an explicit read allow-list (`connector.listStatus`,
     `connector.status`, `connector.healthHistory`) — an ALLOW-list, so a connector method added
     later is refused in demo until someone decides otherwise;
   - `vault.set` / `vault.delete`, `data.import`, and `extension.install` — each a way to bring real
     credentials or real data into a root labelled "not your data".

Without these, an evaluator could authenticate a real connector into the demo root and the banner's
"not your data" would become false.

**`ask` is not in the tour**, and the tour must not depend on a model. See § 2.8 and § 6.

## 6. Testing

**PR 1**

- I41 enforcement: resolve paths for all three OS branches with `NIMBUS_DEMO=1` (the path functions
  take OS inputs, so this is host-independent) and assert no path equals or lies under the real
  `configDir`, and nothing lies under the real `dataDir` except the `demo/` subtree. **Negative
  control:** the same assertion fails without the flag.
- CLI ↔ gateway path parity: both modules resolve byte-identical demo paths on every OS branch.
- Fail-closed refusal of `NIMBUS_DEMO` combined with `NIMBUS_CONFIG_DIR` / `NIMBUS_GATEWAY_SOCKET`,
  and of any `NIMBUS_DEMO` value other than unset/`""`/`"0"`/`"1"`.
- `tempDir` under the flag differs from the real `tempDir` on every OS branch (part of the I41 test).
- CLI argv pre-pass: `nimbus --demo oncall` dispatches `oncall` with `--demo` stripped, and the CLI
  file logger opens under the DEMO `logDir` — asserted by pointing the real roots at temp dirs and
  checking the real `logDir` is never created.
- E2E (in `packages/gateway/test/e2e/`, where the Linux D-Bus wrapper lives): a demo gateway boots
  beside a "real" one on temp OS roots, both answer `status`, and the real `dataDir` OUTSIDE its `demo/` subtree
  (and the real `configDir` in full) is byte-identical before and after.

**PR 2**

- Corpus hygiene: no absolute timestamps; every domain/URL is `.example`; every referenced person
  exists.
- `demo.seed` is `Method not found` on a non-demo gateway over a real socket, and is LAN-denied
  (called, with a negative control).
- The tour as an agent-regression fixture: seed, run each tour brief, assert on story facts (oncall
  names PR #412's deploy; `why` reaches `PAY-231`; owners reports bus factor 1) and that `## Gaps` is
  present.
- Seeding at an injected `now` seven days later still yields non-empty briefs (windows rebase).
- Demo gateway, over a real socket: every `connector.*` method outside the read allow-list, plus
  `vault.set`/`vault.delete`/`data.import`/`extension.install`, returns `ERR_DEMO_FORBIDDEN`; the
  three allow-listed reads succeed; a normal gateway is unaffected (negative control). The
  `connector.*` method set is DERIVED from the dispatcher's own cases, not hand-listed, so a new
  connector method cannot be missing from the test.
- No `SyncScheduler` is constructed in a demo gateway.
- `demo.seed` refuses a non-empty index (`ERR_DEMO_ALREADY_SEEDED`).
- `stopAndWaitForExit`: returns only after the pid is gone; fails loudly past the deadline without
  deleting anything; `nimbus demo` run twice back-to-back succeeds on Windows (the `EBUSY` case).
- `why` and `owners` tour commands succeed with `process.cwd()` OUTSIDE the demo workspace (this
  already holds — `matchConfiguredRoot` in `agents/_lib/why-subject.ts` joins a relative ref to each
  configured root, never to the cwd — the test pins it).
- Banner: seeded / stale (>24h) / unseeded states, all on stderr, none on stdout under `--json`.
- `nimbus --demo ask` against a demo gateway: capture the actual outcome in an e2e test; docs describe
  the captured behaviour, nothing more (§ 2.8). If the capture shows an unhandled error or a hang
  rather than a clear "no model configured" refusal, that is a defect of `ask` on EVERY fresh
  install, not of the demo — it is fixed in `ask` itself (with its own test), not special-cased
  for demo mode.

## 7. Docs

PR 1: `docs/SECURITY-INVARIANTS.md` I41 (the path clause), `CLAUDE.md`/`GEMINI.md` invariant lists.
PR 2: I41's seeding clause, `docs/cli-reference.md`, `docs/architecture.md`, the roadmap First-Run
row, and a README "try it in 30 seconds" line. Claims of isolation or "no network" land only in the
PR whose tests prove them.

## 8. Out of scope (stated, not dropped)

- Per-profile data roots (`ecosystem-roadmap.md` § 7's generalisation). The `NIMBUS_DEMO` seam is
  shaped so it can generalise to a named root later without changing existing profiles.
- A volume generator / `--size`.
- The Killer Demo's remediation / dry-run flow and `nimbus audit replay`.
- `nimbus wow`.
- Desktop (Tauri) demo mode.
- `nimbus demo --json`. The tour is for a human reading a terminal; a structured tour output has no
  consumer. Every individual `--demo` command already honours `--json`.
- Name clash to avoid: the zero-config onboarding "demo symbol" (`ipc/index-demo-symbol-rpc.ts`,
  `agents/_lib/demo-symbol.ts`) is unrelated; the new code uses the `demo/` directory and `demo.`
  IPC namespace, and must not reuse those identifiers.

## 9. Review disposition (review of 2026-09-18, `2026-09-18-nimbus-demo-design-review.md`)

Every finding was checked against the code before it was accepted or rejected.

| # | Finding | Disposition |
|---|---|---|
| 2.1 | `--demo` parsed after the logger opens; `--demo` would dispatch as a command | **Fixed** (§ 3.1). Verified: `cli/src/index.ts` resolves paths + logger at 205–206, dispatches `rawArgv[0]` at 213. |
| 2.2 | `tempDir` shared with real processes | **Fixed** (§ 3.1 table, I41, § 6). |
| 2.3 | Loose env parsing | **Fixed, stricter than proposed** (§ 3.1): an unrecognised value REFUSES instead of meaning "off", which would silently run against the real root. |
| 3.1 | `reset` deletes while Windows still holds handles | **Fixed, wider** (§ 4.4). Verified `stop.ts` never waits. Since re-seeding now recreates the root, this is on every `nimbus demo` run, not only `reset`. |
| 3.2 | Unseeded demo gateway | **Option B adopted, A rejected** (§ 5): unseeded banner + a `nimbus demo` hint; no auto-seed on boot, which would make booting a writer. |
| 3.3 | Truncate tables in a transaction | **Concern adopted, method rejected** (§ 4.1, § 4.4). Of the named tables, `graph_edge`, `item_chunk`, `deployment` and `ci_run` do not exist (edges are `graph_relation`; deployments and CI runs are `item` rows), and a hand list over 83 tables rots. Re-seed recreates the data root; `demo.seed` refuses a non-empty index. |
| 3.4 | Stale-seed hint | **Fixed** (§ 5), 24h threshold = narrowest agent window. |
| 4.1 | Refuse at the dispatcher, not per handler | **Fixed, stronger** (§ 5): at `dispatchMethod`, an ALLOW-list for `connector.*` reads, plus vault / data-import / extension-install, plus the `SyncScheduler` not constructed at all. The review's version was a mutation DENY-list, which a future connector method would slip past. |
| 4.2 | Test `-32601` + LAN + Tauri | **Already specified**; `FORBIDDEN_OVER_LAN` location added (§ 4.1). |
| 5.1 | `why` must not resolve against cwd | **Already true** — `matchConfiguredRoot` joins to configured roots only. Test added to pin it (§ 6). |
| 5.2 | Tour headers; non-TTY | **Fixed** (§ 5). `nimbus demo --json` **deferred** (§ 8): no consumer. |
| 5.3 | `ask` should give a friendly refusal | **Partly adopted** (§ 6): behaviour is captured, not asserted from reading. If it is an unhandled error or a hang, it is fixed in `ask` for every fresh install, not special-cased for demo. The proposed message text is not adopted — it names setup steps not yet verified. |
| 6 | Task checklists | **Deferred to the implementation plan** (writing-plans). Not copied: it includes the rejected auto-seed item. |
