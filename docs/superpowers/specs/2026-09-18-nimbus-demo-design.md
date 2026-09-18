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

## 3. Isolation — PR 1

### 3.1 The seam

One environment variable, `NIMBUS_DEMO=1`, read by **both** mirrored path modules —
`packages/gateway/src/platform/paths.ts` and `packages/cli/src/paths.ts`. The CLI's global `--demo`
flag sets it for its own process; `cli/src/lib/spawn-gateway.ts` already forwards the environment to
the gateway it spawns.

When set, every path moves under one demo root inside the REAL data dir:

| Path | Demo value |
|---|---|
| `configDir` | `<realDataDir>/demo/config` |
| `dataDir` | `<realDataDir>/demo/data` |
| `logDir`, `extensionsDir` | under the demo `dataDir`, same shape as today |
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
the `demo/` subtree it owns), or the real socket; and synthetic seed rows can be written only by a
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
  LAN-reachable by default; `demo.` is added to it with a test that CALLS the check, plus a negative
  control.
- Routed in both the inner dispatcher and the outer method-routing match; proven over a real socket
  by an e2e test (a handler present without routing passes unit tests and fails live).

`demo.seed` is reset-then-seed in one call: it truncates the demo index, then writes the corpus. It
takes `now` from the gateway clock (a test seam injects it).

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
re-seeds on every run; `nimbus --demo status` reports the seed age.

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

**Labelling** — every command run with `--demo` prints one line to **stderr** (so `--json` output
stays parseable):
`DEMO — synthetic "Acme" org, not your data · seeded 2h ago · nimbus demo reset to remove`.

**Keeping "synthetic only" true** — a demo gateway refuses `connector.auth`, connector add, and
`connector.sync` with an error naming the real profile. Otherwise an evaluator could authenticate a
real connector into the demo root and the banner's "not your data" would become false.

**`ask` is not in the tour**, and the tour must not depend on a model. See § 2.8 and § 6.

## 6. Testing

**PR 1**

- I41 enforcement: resolve paths for all three OS branches with `NIMBUS_DEMO=1` (the path functions
  take OS inputs, so this is host-independent) and assert no path equals or lies under the real
  `configDir`, and nothing lies under the real `dataDir` except the `demo/` subtree. **Negative
  control:** the same assertion fails without the flag.
- CLI ↔ gateway path parity: both modules resolve byte-identical demo paths on every OS branch.
- Fail-closed refusal of `NIMBUS_DEMO` combined with `NIMBUS_CONFIG_DIR` / `NIMBUS_GATEWAY_SOCKET`.
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
- Demo gateway refuses `connector.auth` / connector add / `connector.sync`.
- `nimbus --demo ask` against a demo gateway: capture the actual outcome in an e2e test; docs describe
  the captured behaviour, nothing more (§ 2.8).

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
- Name clash to avoid: the zero-config onboarding "demo symbol" (`ipc/index-demo-symbol-rpc.ts`,
  `agents/_lib/demo-symbol.ts`) is unrelated; the new code uses the `demo/` directory and `demo.`
  IPC namespace, and must not reuse those identifiers.
