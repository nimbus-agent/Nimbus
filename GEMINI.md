# Nimbus — Gemini CLI Context

## Project Overview

Nimbus is a **local-first AI agent framework**: a headless Bun Gateway that maintains a private SQLite index of the user's data across ~90 cloud services (Google / Microsoft / GitHub / GitLab / Slack / Jira / Notion + observability, CI-CD, security-quality, feature-flags, GitOps, data-BI, deploy, finance, and support tools — full roster: `CONNECTOR_VAULT_SECRET_KEYS` in `packages/gateway/src/connectors/connector-secrets-manifest.ts`), optional `[[filesystem.roots]]` indexing, and the local filesystem via first-party MCP (Model Context Protocol) connectors, and executes multi-step agentic workflows on the user's behalf. Clients (CLI, Tauri 2.0 desktop) talk to the Gateway only over JSON-RPC 2.0 IPC.

**Runtime:** Bun v1.2+ / TypeScript 7.x strict (two pins stay on TypeScript 6: `packages/docs`, because `astro check` refuses TypeScript 7.0, and the root `typescript-compiler-api` alias, which `scripts/cleanup/` imports because 7 ships its compiler API only under unstable subpaths, and which `audit:boundaries` hands to dependency-cruiser because that accepts only `typescript` below 7) · **Linter:** Biome · **License:** AGPL-3.0 (GNU Affero GPL; gateway/cli) + MIT (sdk)
**Status:** Phases 1–6 ✅ (Phase 6, Team, closed 2026-07-19). From Phase 6 onward the build order is the Phase 7+ Sequencing Spine overlay (S1 → S5), not the phase numbers. **Spine S1 (Local Brain) ✅** 2026-08-20; **Spine S2 (Local Compute Fleet) ✅** 2026-10-10, then the pre-S3 close-out. **S3 (Open Surface) is the active slot:** the MCP capture sink (I28, 3 of 3) ✅ 2026-10-15; the extension runtime (I43, 4 of 4) ✅ 2026-10-17; role packs (I47) ✅ 2026-10-26; and Phase 9.5, the marketplace registry, in seven projects — registry protocol and client (I44) ✅ 2026-10-18, publishing ✅ 2026-10-23, the Readwise unbundling pilot (I46, the baked `nimbus-official` registry) ✅, and the trust layer (project 3) under way — PRs 1, 2a and 2b of 5 ✅ 2026-10-26 (trust statements are stored, the feed is fetched, and revoked or taken-down code is refused at install, update and spawn until the owner re-approves, I48; no feed is baked yet). S3 closes when all seven Phase 9.5 projects have shipped (`docs/roadmap.md` § Phase 9.5). **Several shipped capabilities are deliberately narrower than their names — read the claim in code and `docs/roadmap.md` before relying on it:** the MODEL still cannot invoke a generated tool or a computer-use session (`deps.toolgen` / `deps.computerUse` are unsupplied in `gateway-main.ts`; both are CLI/owner-only); remote vision is images-only and audio/video never leave the machine (I37); Linux fleet idle detection reads power only; `nimbus standup`/`oncall` disclose categories with no substrate in `## Gaps`. Invariants I1–I48; schema V76. Dated log (canonical): [`docs/CHANGELOG.md`](./docs/CHANGELOG.md). Status + acceptance criteria: [`docs/roadmap.md`](./docs/roadmap.md).

**Latest release:** `v10.5.0` <!-- x-release-please-version -->

The version above is rewritten by release-please on every release (it is an
`extra-files` entry in `.release-please-config.json`, the same mechanism that
drives `GATEWAY_VERSION`), and `audit:release-please` fails if it ever disagrees
with the manifest. It is on its own line for that reason: the paragraph above
mentions several versions, and an annotation there could rewrite the wrong one.
Hand-maintaining it did not work — it sat at `v1.20.0` for ten releases, through
a major-version boundary.

Release lineage: `v1.0.0` came from the react-router v8 advisory sweep in #835,
not a product break; `v0.1.0` was the first headless GA (2026-05-09 — Gateway +
CLI + VS Code extension; Tauri desktop deferred to Phase 13).

Companion file: [`CLAUDE.md`](./CLAUDE.md) is the canonical source; both must stay aligned when changing commands, roadmap rows, or non-negotiables.

---

## Non-Negotiables

Architectural constraints, not preferences. Do not suggest changes that violate them:

1. **Local-first** — machine is the source of truth; cloud is a connector.
2. **HITL (human-in-the-loop) is structural** — consent gate lives in the executor, not the prompt; cannot be bypassed or configured away.
3. **No plaintext credentials** — Vault only (Windows DPAPI / macOS Keychain / Linux libsecret); never in logs/IPC/config.
4. **MCP as connector standard** — the engine never calls cloud APIs directly.
5. **Platform equality** — Windows/macOS/Linux equally supported. PRs gate on Ubuntu **plus** a macOS and a Windows leg (`pr-quality-cross-platform`) running the SAME whole-repo `bun test` command as the push matrix; pushes run the full 3-OS matrix. See _CI gating_ below for the one thing the PR legs still do not cover.
6. **AGPL-3.0 core / MIT SDK** — dual license is intentional; do not change license fields.
7. **No `any`** — use `unknown` for external data; TypeScript strict mode is non-negotiable.

---

## Security Invariants

Each live invariant (I1–I48) has a production wiring site + an enforcement test in `packages/gateway/src/security-invariants.test.ts`. **Full rationale, anti-patterns, and the triple rule (wiring + docs + test land in the same commit; retire = delete the row, never leave drift):** [`docs/SECURITY-INVARIANTS.md`](./docs/SECURITY-INVARIANTS.md) + the `nimbus-security-invariants` skill — read before adding/auditing any defense.

- **I1** — child-process env scoping via `extensionProcessEnv()` · `connectors/lazy-mesh/*` spawns
- **I2** — HITL frozen-set membership (`HITL_REQUIRED_BACKING` module-private) · `engine/executor.ts` `gate()`
- **I3** — HITL gate consults `action.type` only, never `payload.mcpToolId` · same
- **I4** — `hitlStatus` set only by the consent gate · same
- **I5** — `checkLanMethodAllowed` intrinsic to `LanServer` · `ipc/lan-server.ts`
- **I6** — LAN (local-network) bind defaults to `127.0.0.1` · `config/nimbus-toml.ts`
- **I7** — Tauri `ALLOWED_METHODS` excludes RCE-class (remote-code-execution) methods · `ui/src-tauri/src/gateway_bridge.rs`
- **I8** — restrictive renderer CSP (no `unsafe-inline`/`unsafe-eval`) · `ui/src-tauri/tauri.conf.json`
- **I9** — bound-param SQL; identifiers via `escapeIdentifier` · `db/write.ts`, `db/repair.ts`, `people/person-store.ts`
- **I10** — constant-time compare for hashes/MACs/pairing-codes/tokens · `util/timing-safe-compare.ts` (canonical)
- **I11** — LLM-facing results via `wrapToolOutput`; a user-MCP tool's server-supplied description is closer-escaped (`wrapToolDescription`) and its input schema rebuilt from a structural allowlist (`sanitiseUserMcpInputSchema`) · `engine/agent.ts`, `engine/tool-output-envelope.ts`, `engine/user-mcp-agent-tools.ts`, `engine/user-mcp-input-schema.ts`
- **I12** — DPAPI passes `pOptionalEntropy` from `<configDir>/vault/.entropy` · `vault/win32.ts`
- **I13** — HTTP writes via `WRITE_ROUTE_ALLOWLIST` + bearer auth · `ipc/http-server.ts`, `ipc/http-write-routes.ts`
- **I14** — SQLite writes via `dbRun`/`dbExec`/`dbStmtRun` (static D12) · `db/write.ts`
- **I15** — every lazy-mesh `ServerSpec` via `wrapServerSpec()` → sandbox (static D10) · `connectors/lazy-mesh/*`
- **I16** — Ed25519 signature verify at install + every startup for `publisher` extensions · `extensions/{install-from-local,verify-extensions}.ts`
- **I17** — federated answering only in `query-gate.ts` (grant+role+consent+namespace filter, leak-proof shape; static D13) · `federation/query-gate.ts`
- **I18** — IdP token validation only in `identity/verifier.ts`; raw tokens Vault-only; federation consults `isOperatorValid()` (static D14) · `identity/verifier.ts`
- **I19** — team-vault secrets consumed only via `invoke-gate.ts` (`answerFederatedInvoke`, principal-polymorphic: peer **or** local operator) → ephemeral team-credentialed connector; leak-proof result, fail-closed on missing secret (static D15) · `federation/invoke-gate.ts`, `teamvault/team-tool-invoke.ts`
- **I20** — a delegated HITL approval is honored only from a live, in-scope, identity-valid delegate; else fall back to the local owner; `registry.add`, every `extension.*` type and `pack.install` always fall back, whatever delegate is active · `engine/delegated-approval.ts`
- **I21** — quorum counts only DISTINCT authenticated peers (deny aborts, fail-closed) · `engine/quorum/quorum-coordinator.ts`
- **I22** — signature-verified org policy + monotonic-stricter resolution (tighten-only; fail-closed to last-valid/baseline); enforcement reads `EnforcedPolicy`, never raw policy TOML (static D16) · `policy/policy-gate.ts`
- **I23** — ChatOps operational (non-HITL) posts go only through `chatops/reply-dispatcher.ts` to a server-derived `ReplyTarget`, never a caller-supplied destination; arbitrary-destination posting stays behind the HITL-gated `*.message.post` types (static D17) · `chatops/reply-dispatcher.ts`
- **I24** — a federated preflight (action) request executes only behind the LOCAL owner's HITL gate, never on the caller's say-so; the command is resolved from local config only (fail-closed if missing) and runs sandboxed with validated params as env (static D18) · `federation/preflight-gate.ts`
- **I25** — a tribal-knowledge KB capture writes only to the config-pinned destination, behind the LOCAL owner's HITL gate; the caller picks at most a `--target` (static D19) · `tribal/tribal-write-gate.ts`
- **I26** — connector write actions execute only behind the LOCAL owner's HITL gate (I2); the federated invoke gate refuses every write-classified tool id, so a peer never triggers a connector write (static D20) · `federation/invoke-gate.ts`, `connectors/connector-write-registry.ts`
- **I27** — an outbound share leaves the machine only through `share/share-gate.ts` `createShare()` or `share/share-forward.ts` `forwardShare()`: redaction, the LOCAL owner approves the exact preview (`share.publish`), Vault-key signature, `share_records`, audit; a denial emits nothing; received shares are inert (static D21) · `share/*`
- **I28** — content from an MCP client enters only through `mcp-sink/capture-gate.ts` `submitCapture()`, in a fixed order; a proposed decision/term/link writes nothing until the owner's `acceptCapture()`; a proposed connector action leaves only through `mcp-sink/capture-act.ts` `acceptAction()` and then the executor's own HITL prompt (static D32(a)–(g)) · `mcp-sink/*`, `ipc/capture-rpc.ts`
- **I29** — egress-ledger completeness: every outbound path appends one BLAKE3-chained `egress_ledger` row BEFORE the request, and a failed append aborts it — connector dispatch at the executor chokepoint, externally-originated agent briefs (`mcp`/`http`), scheduled sync runs and targeted fetches (`sync`), non-local model calls via decorators on the route table, the Mastra agent, embedders and VLMs (`model`, locality derived from `isLocal`, I34), outbound ChatOps posts, the browser lane, generated tools and remote registry requests. Each class's exact coverage and stated bounds: `docs/SECURITY-INVARIANTS.md` (static D22(a)–(h)) · `engine/executor.ts`, `egress/*`
- **I30** — web-clipper tokens mint only inside a live, single-use, in-memory pairing window the owner opened (`nimbus clip pair`); otherwise `POST /v1/clips/pair/confirm` is 403 · `clips/pairing-window.ts`, `clips/clip-token-store.ts`
- **I31** — disclosure integrity: a synthesized brief never says less than the deterministic render — disclosure-only sections are rebuilt and re-attached (never shown to the model), reserved sections the model invents are stripped, interleaved disclosures are anchor-checked from one definition · `agents/_lib/{synthesize,reserved-sections,brief-contract,brief-disclosures}.ts`
- **I32** — clip `source` metadata is rebuilt by `validateClipInput` from five whitelisted fields, never spread from the caller's object · `clips/clip-ingest.ts`
- **I33** — user-supplied code executes only through `exec/exec-gate.ts` `runExecution()`: refuse on config/policy before consent, assert `canConfine(policy)`, read the script once, network empty by construction (loopback included), the LOCAL owner approves the verbatim body, one audit row per outcome (static D23) · `exec/*`
- **I34** — every `LlmProvider` declares `isLocal` from exactly one source — derived from its base URL for a local runtime, hardcoded `false` for a cloud adapter, never from a vendor id · `llm/base-url-locality.ts`
- **I35** — a computer-use actuation reaches the host only via `computer-use/cu-gate.ts` inside a session envelope the LOCAL owner approved: HITL class derived structurally from the observed target, liveness re-checked after every await before host contact, the terminal lane approves complete lines only (static D26) · `computer-use/*`, `egress/browser-egress.ts`
- **I36** — a browser-reachable file question (a forge coordinate) never reaches the federation: `requireFileParam` refuses `namespace`/`namespaces` alongside it · `ipc/agents-rpc.ts`
- **I37** — a media body reaches a non-local model only through `multimodal/media-gate.ts` with a durable per-artifact grant for that vendor; audio and video have no remote tier by two independent mechanisms (static D27) · `multimodal/*`, `egress/vlm-egress.ts`

- **I38** — an unattended fleet run uses a non-local model only when `[fleet] allow_remote` AND the run's remaining budget cover it, enforced by `wrapFleetSynthesisRouter` on both doors (static D28) · `fleet/*`, `platform/assemble.ts`
- **I39** — a runtime-generated tool reaches the network only through `toolgen/toolgen-broker.ts`'s `handleFetch`, to an owner-approved host with that host's credential; the tool process itself has no network (static D29(a)–(c)) · `toolgen/*`, `egress/tool-egress.ts`
- **I40** — a saved generated tool runs only under a LIVE Ed25519 signature, re-verified by `readVerifiedSavedTool` at boot, at registry load and before every spawn (static D29(d)) · `toolgen/toolgen-saved-store.ts`
- **I41** — a demo-rooted process (`NIMBUS_DEMO=1`, the CLI's `--demo`) never reaches the real install, and the demo gateway is inert (ephemeral vault, no sync/updater/telemetry, connector methods refused) · `platform/{paths,demo-root,demo-boot}.ts`, `ipc/server/demo-gate.ts`
- **I42** — every `mcp_*` (user MCP) or `ext_*` (approved extension) action requires HITL at the executor gate and is never delegable; `--model` tools are offered to the local owner only, under the `user_mcp_model_access` lockoff · `engine/executor.ts`, `connectors/owner-code-server.ts`, `engine/user-mcp-agent-tools.ts`
- **I43** — an installed extension's code runs only through `extensions/extension-runtime.ts` `prepareSpawn`: a live `extension.run` grant, pre-spawn re-verification that trusts no earlier pass, a verified per-spawn copy as its cwd, credentials only via `extensionProcessEnv` (static D33(a)) · `extensions/*`, `connectors/lazy-mesh/*`
- **I44** — registry-sourced extension code is installed or updated only through `extensions/registry/registry-fetch.ts`'s verified chain — pinned root key, non-decreasing sequence (refusing different content at an equal one), index hashes, the index-named publisher key and its I16 signature — and only from the extension's recorded source registry · `extensions/registry/*`
- **I45** — every gateway `Bun.serve` listener answers 403 unless the `Host` header names loopback (`rejectNonLoopbackHost`) · `locality/loopback-host-guard.ts`
- **I46** — the only renderer-callable method that can create an extension run grant is `migration.accept`, valid only for a gateway-created migration row verified against the baked official registry · `ipc/migration-rpc.ts`, `extensions/migration/migration-engine.ts`
- **I47** — a role-pack layer is written only by `packs/pack-install.ts`, after the LOCAL owner approved `pack.install` over the pack's exact defaults text (static D36) · `packs/pack-install.ts`
- **I48** — extension code whose publisher key is revoked, or which is taken down, by an authority whose scope covers it (Nimbus or the publisher everywhere; a registry root only for code from that registry) is never installed, updated or spawned unless the owner's `extension.run` approval acknowledged every current block by statement id; stored blocks are a monotonic union (static D37) · `extensions/trust/trust-blocks.ts`, `extensions/{verified-extension,approve-run}.ts`

**Static complement:** `scripts/structure-audit/check-nimbus-invariants.ts` runs before the test suite (fails first; runtime tests stay authoritative). It enforces the static rules D10–D37: the ones named above, plus rules tied to no invariant: D24 (the SyncContext capability boundary), D25 (connector children spawn hidden), D30 (`ensureFullSqlite`), D31 (`registerListener`), D33(b)/(c) (run-grant table and writers), D34 (connector migration), D35 (the layered config reader) and D37 (the V76 trust tables only in `extensions/trust/trust-store.ts`). Each rule's exact scope and stated bounds: `docs/SECURITY-INVARIANTS.md`.

---

## Subsystems

**This repository is the Gateway, not the whole of Nimbus.** It holds six workspaces; the six
surfaces listed below live in their own repos and release independently. That balance moved decisively on
2026-08-27, when the 94 first-party connectors left for
[nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers) — before
that, `packages/` carried 100 workspaces and the word "monorepo" described something real. Read a
statement about "the repo" with that in mind: for connectors, the SDK, the IPC client, the MCP
launcher, the editor extension and the browser client, the source of truth is elsewhere.

In this repository:

- `packages/gateway` — Engine, MCP mesh, Vault, local index, IPC
- `packages/cli` — Terminal client (CLI + Ink TUI)
- `packages/ui` — Tauri 2.0 + React (desktop)
- `packages/docs` — Astro Starlight documentation site
- `packages/admin-console` — dependency-free static admin console served at `/admin/*` (Phase 6 Slice 4)
- `packages/registry-format` — pure, Bun-free extension-registry rules (manifest, signing, tarball, index) shared by the gateway, the CLI and the registry CI action; imports nothing from gateway/cli/ui (`registry-format-is-pure`)
- `packages/github-actions/*` — first-party GitHub Actions (annotate-action, preflight-query); tracked but intentionally NOT workspace members

Everything else releases on its own cadence, and a change to one of these is a PR in that repo —
not here. Where the Gateway also carries per-connector sync/indexing logic, a feature touches both:

- The **`@nimbus-dev/sdk`** extension-authoring contract — [nimbus-agent/nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) (MIT); the connectors consume the published package.
- The **`@nimbus-dev/connectors`** first-party MCP connectors — [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers) (AGPL-3.0-only); all 94 ship as ONE package that the gateway depends on and bundles into its compiled binary via `BUNDLED_CONNECTORS`. The gateway's per-connector **sync and indexing** logic stays here, so adding a connector touches both repos. `audit:connector-version-skew` fails the build when this repo's pin falls a MINOR version behind what is published.
- The **`@nimbus-dev/client`** typed IPC wrapper — [nimbus-agent/nimbus-client](https://github.com/nimbus-agent/nimbus-client) (MIT); `packages/cli` and the VS Code extension consume the published package.
- The **`@nimbus-dev/mcp`** MCP-server launcher (`nimbus-mcp` bin) — [nimbus-agent/nimbus-mcp](https://github.com/nimbus-agent/nimbus-mcp) (MIT); resolves the installed `nimbus` binary and execs `nimbus mcp-server --stdio`, so any MCP client reaches the local index and agents. The MCP server itself stays here (`packages/cli/src/commands/mcp-server.ts` + `packages/cli/src/mcp/`). Listed in the official MCP Registry as `io.github.nimbus-agent/nimbus`, republished from that repo's CI on every release.
- The VS Code / Open VSX extension — [nimbus-agent/nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode); consumes the published `@nimbus-dev/client`.
- The browser client (Chrome + Firefox MV3) — [nimbus-agent/nimbus-web-clipper](https://github.com/nimbus-agent/nimbus-web-clipper); today a **web clipper** talking to the gateway's web-clip HTTP surface (`POST /v1/clips`, invariant I30). The gateway-side surface itself stays here (`packages/gateway/src/clips/`). **Recorded direction (not built):** it becomes a **browser-side gateway client** — an ambient panel that resolves a Bitbucket PR / Jenkins build page to an already-indexed item and runs the existing `agents.*` briefs against it; the editor extension gets the same treatment. Agents are shared, surfaces are contextual. The browser-reachable agent-invocation route now EXISTS — `POST /v1/agents/{agent}` plus `GET /v1/agents/runs/{id}` and `GET /v1/agents`, all behind the `agents` token scope. A resolve-by-URL read now EXISTS too — `GET /v1/items/resolve` behind the `resolve` token scope, keyed on the derived, indexed `item.resolve_key` (added at V52). See [`docs/roadmap.md` § Track 2 → Client surfaces](./docs/roadmap.md#client-surfaces).

**PAL:** OS-specific logic lives under `packages/gateway/src/platform/`, accessed via `PlatformServices` — never import `win32`/`darwin`/`linux` from business logic.

**Dependency rules:** `gateway` imports nothing from cli/ui. `cli` and `ui` reach the gateway IPC-only (no source imports). `sdk` imports nothing from gateway/cli/ui. The gateway's ONLY static import from the connectors package is `setConnectorMode` from `@nimbus-dev/connectors/shared/connector-mode.ts`, in `run-bundled-connector.ts`; beyond it, the generated `connectors/bundled-connector-registry.ts` `import()`s each of the 94 connector entrypoints (`@nimbus-dev/connectors/<id>`), which is how `BUNDLED_CONNECTORS` gets them into the compiled binary. Circular dependencies are forbidden.

**Prerequisites:** Bun v1.2+; Rust for the Tauri UI. Local `nimbus ask` can run through Ollama on `http://127.0.0.1:11434` with `[llm].prefer_local = true` + `[llm].local_model`.

---

## Testing Philosophy

- **HITL tests** prove the gate fires for every whitelisted action type before the connector is called.
- **Vault tests** prove no secret value escapes through any interface.
- **Integration tests** use real SQLite + real Bun subprocesses + fresh temp dirs — no mocks at the DB layer.
- **E2E CLI tests** use a real Gateway subprocess + mock MCP servers — no real cloud calls.
- **Coverage gates** in CI: Engine ≥85%, Vault ≥90%, Embedding ≥80%, plus scheduler/rate-limiter/people and seventeen more (23 scopes, each with its own floor) — enforced by `audit:coverage-scopes` over the merged lcov, NOT by the `test:coverage:*` scripts (their `--coverage-threshold-lines` flag does not exist in Bun and is silently ignored; `bunfig.toml`'s `[test] coverage = false` suppresses collection anyway). Denominator is non-exempt files, matching `audit:coverage-floor`. See `scripts/coverage-floor/check-scopes.ts`.
- Focus on the current phase; do not add Phase N+1 features in Phase N code.

### CI gating

PRs run the Ubuntu `pr-quality` set **and** `pr-quality-cross-platform` — one macOS leg and one
Windows leg, the Windows one split into two `--shard` jobs. Pushes run the full 3-OS matrix. On
macOS and Windows its integration and e2e trees run inside the whole-repo unit job only, not again
as jobs of their own (`scripts/ci/cross-platform-parity.test.ts` holds the unit command to
covering them), and its desktop E2E legs run only when the push changed `packages/ui/`, and
nightly (`schedule` in `ci.yml`). Two exceptions skip the test jobs, both reported as passing: a
docs-only PR, and
release-please's own PR when its diff is a version bump and nothing else
(`scripts/ci/release-only-diff.ts`, run as it is on the base commit) — the tag's Release
workflow runs the full Ubuntu suite again before it builds anything.

**TEN status checks gate the merge, not one.** The _General_ ruleset (14784377) requires all of:
`PR quality — required gates`, `Dependency audit`, `Trivy vulnerability scan`, `Gitleaks secret
scan`, `Gateway audit JSON + connector.remove vault restore`, `Cargo audit (Tauri)`, `Cargo deny
(licenses + advisories + bans)`, `Analyze (javascript-typescript)`, `Analyze (rust)`, and `cla`.
Only the FIRST is an aggregator: `PR quality — required gates` is an `if: always()` job that
`needs:` every other job in the PR-quality workflow, so adding or renaming a gate **inside that
workflow** never needs a ruleset edit, and a red leg there reds the aggregator. The other nine come
from separate workflows (Security, CodeQL, CLA) and are named in the ruleset individually — adding
one there IS a ruleset edit. Two merge rules in the same ruleset are not status checks: every review
thread must be resolved (`required_review_thread_resolution`), and a `code_quality` rule is set at
severity `all`.

This sentence read "exactly one status check gates the merge" until 2026-09-09, and the error is
the kind that costs a merge: on #1475 the Dependency audit and Trivy checks were red, this file
said they could not be blocking, and the ruleset disagreed. Both are required, both were genuinely
blocking, and neither was the PR's fault — they had gone red repo-wide overnight on newly published
advisories, the same sha having passed hours earlier. **When a check is red and this file says it
should not matter, re-derive the list from the ruleset** (`gh api
repos/nimbus-agent/Nimbus/rulesets/14784377`) rather than trusting the prose.

**`main` has no merge queue, and branches need not be up to date: a PR can merge as soon as its
ten required checks are green.** A merge queue ran from 2026-09-30 to 2026-10-02 and was retired
as not worth its cost: every entry re-ran the whole PR gate on the merged result, so each of its
seven merges waited another 21–52 minutes after its PR was already green. No workflow listens for
`merge_group` any more. What that gives up: a PR's checks test it merged into `main` as `main` stood
when they ran, so two PRs that are each green can still break `main` together, and that shows up on
`main`'s push run rather than before the merge. Dependabot is retired too (no Dependabot
configuration, no update PRs; its security alerts stay on): dependencies move in periodic manual
bulk updates that follow
[`docs/CONTRIBUTING.md` § Updating Dependencies](./docs/CONTRIBUTING.md#updating-dependencies),
which also records the packages that must move together and the majors that were previously held
back (re-test each blocker before assuming it still holds). A red Security run on `main` (a push
or the nightly schedule) opens, and on its next green run closes, a "Security gate is red on main"
issue; that job watches only the six Security contexts, so a red CI or CodeQL run on `main` opens
no issue.

**A failing step HIDES every later step in the same job.** Both of these jobs are step sequences,
and a red one reports only its first failure — so "one gate is red" routinely means several are,
serialised one CI round-trip apart. `Dependency audit` runs `bun audit` → `audit:advisories` →
`audit:js-licenses`, and on #1475 each fix revealed the next, three pushes for what looked like one
problem. `Unit + Coverage` runs `audit:coverage-floor` → `audit:coverage-scopes` → the SonarQube
gate, and a floor failure means the scopes gate **never executed at all** — it is not passing, it
is unmeasured. Before pushing a fix for any red job, read its whole step list
(`gh api repos/nimbus-agent/Nimbus/actions/jobs/<id> --jq '.steps[] | "\(.conclusion) \(.name)"'`)
and run the later steps locally too.

**The PR cross-platform legs run the same test PATHS as the push matrix** —
`bun test packages/gateway packages/cli scripts --parallel`, whole-repo, so unit + integration +
e2e alike (a directory argument recurses, and `bunfig.toml` excludes nothing). Both legs pass
`--parallel` (Bun 1.4), which runs files across worker processes and implies `--isolate`: every
file gets a fresh global and module registry, so a `mock.module` in one file can no longer leak
into another on these legs. The Linux `Unit + Coverage` leg runs each package with `--parallel
--no-isolate` (Istanbul instruments each module once per worker, not once per file: 4.7 min
against 14.8 isolated and ~9 serial), and a worker keeps one global for every file it runs, so
cross-file mock leakage remains possible there. Only the remaining flags differ:
the push leg records per-file timings (`--update-timings`) and the PR legs read them, which is why
the parity test compares positional paths only. Both run uninstrumented (macOS/Windows coverage
was never read, and instrumenting the push leg skewed the timings) and through
`scripts/ci/test-with-retry.ts`, whose ONE retry re-runs only the files that failed when the JUnit
accounts for every failure, and the whole command otherwise. An attempt that prints nothing for 5
minutes counts as hung and is killed (`--silence-seconds`); before that, a hung macOS worker idled
to the 25-minute cap. The Windows PR leg runs those paths as
`--shard=1/2` and `--shard=2/2`, split by those timings; parity holds over the UNION of the shards,
and the parity test checks that every OS's shard set is exactly `1/N … N/N`. **`--parallel` is part of the shape: drop it from one
leg and not the other and the two stop running the same thing.**
That equality is load-bearing and was only established on 2026-08-23. Before it, the PR
leg ran `bun test packages/<pkg>/src` per package while the push leg ran everything in one process,
and the difference was where the red lived: of the 200 CI runs on `main` between 2026-08-02 and
2026-08-22, 50 failed and 35 had a failing macOS job — **33 of the 35 were in files the PR gate
never loaded** (`scripts/`, `test/integration/`, `test/e2e/`), so they could only ever be found
after merge. The process shape matters as much as the file set: `mock.module` is process-global, so
a per-package run and a whole-repo run do not have the same mocks in play. #1307 shipped a test that
was green on the PR leg on all three OSes and red on the macOS push leg minutes later, purely
because `packages/gateway/src` never loads the two files under `packages/gateway/test/` that mock
its dependency. **If you change one command, change the other.**

**What the PR cross-platform legs still do NOT cover:** coverage and packaging. Both are Ubuntu-only
by design (the coverage floor is CI-Linux-authoritative; packaging is a separate job).

**A green local run does not predict these legs.** The runner is ~13–18× slower than a dev machine
at temp-dir SQLite work, so every wall-clock assumption in a test is a different number there.

---

## Development Workflow

- **Worktrees:** `.claude/worktrees/<branch-name>` (project-local, git-ignored).
- **Pre-flight before a PR:** `bun run preflight` (full CI parity) or `bun run preflight:fast` (~2-3 min, cheap static gates). **`test:ci` is only the test suite, NOT the full gate set — `preflight` is.** Gate manifest: `scripts/lib/preflight-gates.ts` (drift test fails if a CI gate is missing). Four companions when local green still isn't CI green: `bun run verify:docker` runs the manifest's fast tier inside the CI bun image at a normal path (catches gates that pass only because of a path exclusion or an OS difference; `--full` adds build + `test:ci` + coverage floor; **`--changed` runs only the tests your branch touched** — the fast way to reproduce a Linux-only test failure, which was the largest real PR-failure category and does not reproduce on Windows/macOS at all. A narrow run cannot reproduce cross-file `mock.module` contamination, so a green `--changed` is evidence about your files, not about the suite); `bun run verify:pr` refuses to call a conflicted or still-pending PR green; `bun run typecheck:tests` covers `packages/{gateway,ui}/test/**`, which no tsconfig `include` covers and plain `typecheck` cannot see (`bun run typecheck:tests:update-baseline` re-banks the baseline — required when paying debt down, not only when adding it); and `bun run audit:platform-test-gaps` (advisory, in `preflight:fast`) names the tests in your diff that **cannot run on your OS** — a `skipIf(process.platform === "win32")` test never executes on a Windows box, so local green is silent about it and CI is its first execution. See the `nimbus-preflight` skill.
- **AI Agent PR Quality & Verification (CRITICAL):** To prevent failing PRs and minimize ping-pong cycles, the AI assistant **MUST** run verification locally before finishing any work or proposing changes:
  1. After making any code changes, **always** run `bun run preflight:fast` to check types, linting, and static rules.
  2. If logic or tests were touched, run the specific test suite (e.g., `bun test packages/gateway/src/...`) or the full `bun run preflight` if needed.
  3. If any check/test fails, fix the issue locally before presenting the solution to the user. Do not declare success or stop if there are failing checks.
  4. Ensure any newly added/modified code adheres to all Non-Negotiables and Security Invariants.
- **Branch hygiene:** never commit on `main`/`develop` — `git switch -c dev/<you>/<topic>` and verify `git rev-parse --abbrev-ref HEAD` first. `bun run hooks:install` adds a pre-commit guard + pre-push `preflight:fast`.
- **Never merge with checks still running — that is the main cause of red `main`.** The _General_ ruleset (14784377) requires `PR quality — required gates`, but its only bypass actor is `OrganizationAdmin` with `bypass_mode: "always"` — so for a repo admin the merge button stays live while checks are pending and **GitHub reports nothing when it is used**. Precedent: #1298 merged 2026-08-21 at 17:47:15Z; its required gate did not even _start_ until 17:57:44Z and then failed, putting two broken tests on `main` and reding the release PR (#1301) minutes later. Wait for `PR quality — required gates` to report green, or use **auto-merge** (`gh pr merge --squash --auto`), which merges the PR the moment its required checks are green, so GitHub does the waiting. When triaging a red `main`, **compare the merge timestamp against the required check's `started_at` before assuming a flake** — `gh api repos/nimbus-agent/Nimbus/commits/<sha>/check-runs` — because a merge-before-green looks exactly like a post-merge regression.
- **Commit messages are discarded on merge — the PR title and description ARE the commit.** Squash is the only merge method enabled (`allow_merge_commit` and `allow_rebase_merge` are both off), and the squash commit is built from `PR_TITLE` + `PR_BODY`. Whatever you write in a local commit message never reaches `main`, so: put the conventional-commit type in the **PR title**, because that subject line is what release-please parses for the version bump; put reasoning, and any git trailer you need to survive, in the **PR description**, because that becomes the permanent commit body. A corollary worth remembering in reverse: a bare `Release-As:` line left in a PR description forces a release nobody asked for, so keep it inline or quoted unless a version bump is the intent.
- **A `!` means a USER must act — not that the change felt significant.** `main` went from
  `v2.21.0` to `v7.0.0` in two days across five majors, and exactly ONE of them
  (`v5.0.0`, #1359, which removed the `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env fallback) was
  a change a user had to do anything about. The other four were not: deleting the internal
  `mcp-connectors` workspace, which ships from npm now (`v3.0.0`), an internal router retype whose own plan
  promised "total config back-compat" (`v4.0.0`), removing `[llm] classifier_model` and
  `remote_model` after they had become **inert** (`v6.0.0`), and tightening
  `LlmRegistryOptions.db` to required in a `private: true` package (`v7.0.0`) — a PR whose own
  body said "no published surface changes" and still carried a `!`.

  Before writing `!` or `BREAKING CHANGE:`, answer one question: **what does an existing user
  have to change to keep working?** If the honest answer is "nothing", it is not breaking.
  Specifically NOT breaking: removing a key nothing reads (behaviour is identical either way);
  any type/signature change confined to a `private: true` package, which has no published
  surface; deleting an internal workspace whose consumers already resolve it from npm; a
  stricter internal invariant. Majors are permanent — the tag ruleset has no bypass actors — so
  a burned major cannot be reclaimed, and spending them on internal tidiness destroys the one
  signal that tells a user to read the release notes before upgrading.
- **Release tags are immutable — a failed release is abandoned, never retagged.** The _Protected release tags_ ruleset enforces `deletion`, `non_fast_forward` and `update` on `refs/tags/v*` and `refs/tags/client-v*`, with **no bypass actors** (admins included), so `git push origin :refs/tags/vX.Y.Z` is rejected with `GH013`. When a release build fails after its tag exists (the gate fails, every build/publish job skips, and no GitHub Release is produced), do **not** try to move the tag onto the fix: land the fix on `main`, mark the dead version in `CHANGELOG.md`, and cut the next version. Force that version with a `Release-As: X.Y.Z` trailer — release-please cuts nothing on its own when every commit since the last tag is `docs`/`chore`/`test`. **Squash-merging replaces the commit message with the PR title and description, so the trailer must be the last line of the PR description or it is silently dropped and no release PR appears.** Precedent: `v1.11.0` (#957 → superseded by 1.12.0).
- **Cross-platform:** build paths with `path.join()` / `os.tmpdir()`, never hardcoded separators; `bun run audit:cross-platform` flags Windows-separator path assertions (escape hatch: `// cross-platform-ok`).
- **CI-Linux-only failures — reproduce, don't guess:** CI is Ubuntu + Bun `1.4` (the `bun-version` default in `.github/actions/setup-nimbus-ci/action.yml`, which also builds the release binary; no test/quality workflow overrides it — `bun-version: latest` appears only in the two scheduled drift sweeps, `org-drift-sweep.yml` and `release-channel-drift.yml`). Some failures never reproduce on Windows/macOS and aren't version-related — chiefly `mock.module` contamination in the combined `bun test packages/cli/src` run (prefer **dependency injection (DI) over `mock.module`** for dispatcher-driven code) and `@types/*` hoisting conflicts. Reproduce on Linux (Docker `oven/bun:1.4`, matching CI — or WSL on a Linux-native copy, not `/mnt/c`) **before** pushing a fix. Do not substitute `oven/bun:latest`: it moves on to the next minor without CI. `audit:coverage-floor` is **CI-Linux-authoritative**. Details: `nimbus-preflight` skill.
- **The skills under `.claude/commands/` are gated, not scratch notes.** `audit:doc-refs` resolves every path they cite (and now every path in `docs/` too), and `audit:status-drift` derives the I13 write-route count _and_ full enumeration from code across `nimbus-http-write-surface.md` + `nimbus-federation-identity.md` — both had gone stale while the `docs/` copies of the same claim stayed correct, because only `docs/` was read. `audit:workflow-lint` likewise now requires `timeout-minutes` on every workflow job with `steps:`.
- **A total that is still right can hide an enumeration that is wrong.** `ALLOWED_METHODS` stayed at 105 across one addition (`agents.negotiate`) and one removal (`connector.list`), so the prose ledger's arithmetic worked while its list named neither. When a count changes, re-derive the _list_, not just the number.
- **A branch-count metric over a GATE measures the security surface and reads it as debt.** The three
  worst Sonar `S3776` (cognitive-complexity) findings in this repo have been, repeatedly, the three
  functions implementing I35 — `cu-gate.ts`'s `runAction`/`openSession` and `cu-classify.ts`'s
  `classifyBrowserAction` — because I35 IS an ordered sequence of checks and each check is a branch.
  **Check what a complex function IS before simplifying it.** When one of these must be brought under
  the gate, the constraint is that the ORDER stays readable as an ordered list at the call site: split
  by PHASE into named steps invoked in sequence (`assertOpenAllowedBeforeConsent`, then
  `resolveSessionBounds`, then `buildEnvelope`), never by extracting a check into a helper a reader has
  to go and find. Two further rules learned the same way: state that a single `finally` must write
  exactly once belongs in ONE mutable record passed to the arms, not in each arm's own closure; and a
  check both arms need (approve, then re-check liveness) belongs in ONE function, because two copies is
  two places for it to go missing.

Full command catalogue + coverage thresholds + env overrides: `nimbus-commands` skill. File-location pointers: `nimbus-file-map` skill.

---

## See Also

- [`docs/architecture.md`](./docs/architecture.md) — subsystem design, IPC method catalogue, schema reference. Read before modifying any subsystem. **It is now the design record too**: with the delivered specs pruned, [§ Spine S2 Subsystems](./docs/architecture.md#spine-s2-subsystems) carries the shared-gate shape and the per-capability decisions (and the rejected alternatives) for exec / computer-use / multimodal / toolgen / fleet.
- [`docs/roadmap.md`](./docs/roadmap.md) — phases, acceptance criteria, delivered summaries.
- [`docs/SECURITY-INVARIANTS.md`](./docs/SECURITY-INVARIANTS.md) — I1–I48 rationale + anti-patterns.
- [`docs/cli-reference.md`](./docs/cli-reference.md) — full CLI subcommand reference.

---

## Skill References

Domain skills live in `.claude/commands/nimbus-*.md`, **loaded on demand** via the Skill tool (or `/<name>`) — each carries a `description` that drives when it triggers.

| Skill | Use when… |
| --- | --- |
| `nimbus-architecture` | Placing/naming new code, package ownership, IPC design — read first for any Gateway-touching task |
| `nimbus-file-map` | "Where does X live?" — pointer index to high-traffic files |
| `nimbus-commands` | bun scripts, CLI subcommands, coverage-gate names, env overrides, `bun add` safety |
| `nimbus-ipc` | Adding/designing an IPC method, notification, or streaming contract; Tauri-exposure check |
| `nimbus-testing` | Choosing a test layer, file location, coverage gate, or mocking the Gateway |
| `nimbus-preflight` | What to run before pushing; why `test:ci` ≠ full gate set; cross-platform/CI gates |
| `nimbus-security-invariants` | Adding/auditing a structural defense (the wiring + docs + test triple rule) |
| `nimbus-tauri-allowlist` | Exposing a method to the renderer (`ALLOWED_METHODS`, I7) |
| `nimbus-http-write-surface` | Adding an HTTP `POST`/`PUT`/`DELETE` route (`WRITE_ROUTE_ALLOWLIST`, I13) |
| `nimbus-tool-output-envelope` | Feeding tool results to the LLM (`wrapToolOutput`, I11) |
| `nimbus-connector-authoring` | Building/modifying a first-party MCP connector |
| `nimbus-db-migrations` | Authoring a SQLite migration or new table |
| `nimbus-embedding-routing` | Embedding-table routing for a new item type; `nimbus index reembed` |
| `nimbus-index-body-depth` | Indexing an item body or changing connector index depth (V48/V49 `item.body`, the `upsertIndexedItemForSync` chokepoint, `nimbus index rebody`) |
| `nimbus-cicd-data-layer` | DORA metrics, preflight checks, deployment annotation (Phase 5 T4) |
| `nimbus-data-warehouse-lineage` | Authoring/extending a data-warehouse or BI connector + the cross-warehouse lineage graph (Phase 6 Slice 7); no-row-data contract, V40 lineage edges, `normalizeDataModelKey` |
| `nimbus-federation-identity` | Phase 6 Team federation (I17 query gate, namespaces/RBAC, pairing/discovery) + identity/SSO/SCIM (I18, OIDC device-code, SCIM-on-I13); touching `gateway/src/{federation,identity}/` |
| `nimbus-share-virality` | Authoring/auditing the Share & Virality subsystem (outbound share-gate I27/D21, redaction, V41 share_records, V42 recipes, `share.*` IPC + `nimbus share` CLI) |
| `nimbus-egress` | Auditing/authoring the Egress Ledger & `nimbus prove` (I29/D22 executor dispatch chokepoint, V44 `egress_ledger`, BLAKE3 chain, `egress.*` IPC + `nimbus prove`/`nimbus egress` CLI) |
| `nimbus-agent-patterns` | Authoring a built-in read-only agent |
| `nimbus-implicit-knowledge-extraction` | Authoring/auditing the glossary + decisions extraction pipelines (`gateway/src/{glossary,decisions}/`, V45/V46/V47 tables, the debounced post-sync pass, `glossary.*`/`decisions.*` IPC) |
| `nimbus-sandbox-and-extensions` | Third-party code end to end: the per-OS `SandboxRunner` (I15/D10), user MCP servers (`connector add --mcp`, I42) and the S3 extension runtime (install gate, V70 run grants, I43/D33, `approve --model`); per-OS sandbox traps; touching `gateway/src/{extensions,platform/sandbox,connectors/lazy-mesh}/` |
| `nimbus-mcp-sink` | The MCP server's write doors (I28/D32(a)–(g), V67–V69): `capture_note`, `propose_*`, `propose_action`, `nimbus captures *`, `[mcp_sink]`, making an action type proposable; touching `gateway/src/mcp-sink/` or `ipc/capture-rpc.ts` |
