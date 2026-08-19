# Contributing to Nimbus

Thank you for your interest in contributing. Nimbus is in active development (Phase 5 — The Extended Surface; Phase 4 Presence is complete). Architecture is stabilising but not all interfaces are frozen.

Before writing any code, read the documents that define what Nimbus is and what we are building this quarter:

- [`architecture.md`](./architecture.md) — subsystem contracts, package dependency rules, and the data flow
- [`roadmap.md`](./roadmap.md) — phase themes, acceptance criteria, and inter-phase dependencies
- The **Non-Negotiables** section below — the principles behind every design decision

---

## Non-Negotiables

These are architectural constraints, not preferences. Contributions that violate them will not be merged, regardless of quality:

| # | Constraint | What it means in practice |
|---|---|---|
| 1 | **Local-first** | No user data or credentials leave the machine without an explicit user action |
| 2 | **HITL is structural** | The consent gate lives in the executor (`executor.ts`), not in a prompt or config. It cannot be bypassed or made optional |
| 3 | **No plaintext credentials** | Vault only — never in logs, IPC responses, config files, or environment variables |
| 4 | **MCP as connector standard** | The Engine never calls cloud APIs directly; all external I/O goes through MCP connectors |
| 5 | **Platform equality** | Windows, macOS, and Linux must work identically. All three CI runners must pass |
| 6 | **No `any`** | Use `unknown` for external data; TypeScript strict mode is non-negotiable |
| 7 | **License integrity** | Core package contributions must be AGPL-3.0-compatible; SDK contributions must be MIT-compatible |

---

## Getting Started

### 1. Set Up

```bash
# Requires Bun v1.2+
git clone https://github.com/your-org/nimbus.git
cd nimbus
bun install
```

### 2. Verify Your Environment

```bash
bun run typecheck     # Must pass with zero errors
bun run lint          # Biome — format + lint
bun test              # All unit tests
```

### 3. Find Something to Work On

- Issues tagged [`good first issue`](https://github.com/nimbus-agent/Nimbus/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are the best starting point
- Issues tagged [`help-wanted`](https://github.com/nimbus-agent/Nimbus/issues?q=is%3Aissue+is%3Aopen+label%3Ahelp-wanted) are open for contributors
- **Open a discussion before starting any large PR.** Architecture decisions belong in a discussion, not in a surprise diff

---

## Development Workflow

### Branch Naming

```text
feat/short-description       # new capability
fix/short-description        # bug fix
refactor/short-description   # internal restructure, no behaviour change
test/short-description       # test-only changes
docs/short-description       # documentation only
```

### Commit message format

Nimbus uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) so that `release-please` can derive the next version and generate the `CHANGELOG.md` automatically when a release PR merges.

The format is `<type>(<scope>): <subject>`. Types we use:

| Type | Effect on release-please |
|---|---|
| `feat` | minor bump |
| `fix` | patch bump |
| `perf`, `refactor`, `docs`, `chore`, `test`, `ci`, `build`, `style` | no bump (still appears in the changelog where relevant) |

Append `!` after the type (e.g. `feat!:`) or include a `BREAKING CHANGE:` footer to force a major bump. Use this sparingly — production binaries on the auto-updater channel rely on monotonic semver.

Scope is the package or area touched, e.g. `feat(gateway):`, `fix(cli):`, `docs(roadmap):`. The scope is optional but recommended; release-please groups changelog entries by scope.

We do **not** enforce this with commitlint today. The cost of getting it wrong is a malformed changelog entry, not a failed build — but please follow the format anyway.

### Running Tests

```bash
bun test                          # all unit tests
bun run test:integration          # integration tests (real SQLite, real subprocesses)
bun run test:e2e:cli              # E2E CLI tests (real Gateway + mock MCP servers)
cd packages/ui && bunx vitest run # UI component tests

# Coverage gates (enforced in CI — must pass before merge)
bun run test:coverage:engine      # Engine ≥85%
bun run test:coverage:agents      # Agents ≥80%
bun run test:coverage:vault       # Vault ≥90%
bun run test:coverage:sandbox     # Sandbox PAL ≥80%  (T2 PR 1)
bun run test:coverage:embedding   # Embedding ≥80%
bun run test:coverage:metrics     # DORA calculators + IPC ≥80%  (T4 PR 2)
bun run test:coverage:preflight   # Preflight calculator + IPC ≥80%  (T4 PR 3a)
bun run test:coverage:deployment  # Deployment annotation + HTTP write ≥80%  (T4 PR 3b)
```

The full coverage-gate catalogue (including sync, rate-limiter, people, workflow, watcher, DB, health, config, telemetry, doctor, TUI, MCP, SDK, updater, LAN, perf, UI Vitest) plus environment-variable overrides lives in the [`nimbus-commands`](../.claude/commands/nimbus-commands.md) skill / reference file.

### Cross-platform test conventions

Nimbus runs unit tests on Linux, macOS, and Windows. A test that asserts on a path string can pass on the host where it was written and fail on a different host because Node's default `path` module switches between POSIX and Windows semantics based on `process.platform`. **Never rely on host-default `dirname` / `join` when the test passes a fixed-shape path** — the assertion silently shifts under you on a different runner.

```ts
// ❌ Wrong — host-default `join` produces "C:\\Program Files\\Nimbus\\vec0.dll" on Windows
//    and "C:\\Program Files\\Nimbus/vec0.dll" on Linux. The test passes locally on the
//    author's machine and fails on CI's other-OS runner. (BUG-009 burned us with this.)
import { join } from "node:path";
expect(sidecarPath("C:\\…\\nimbus-gateway.exe", "win32"))
  .toBe(join("C:\\…\\Nimbus", "vec0.dll"));

// ✅ Right — pick the path module explicitly based on the platform the test is asserting against.
import { posix as posixPath, win32 as winPath } from "node:path";
expect(sidecarPath("C:\\…\\nimbus-gateway.exe", "win32"))
  .toBe(winPath.join("C:\\…\\Nimbus", "vec0.dll"));
expect(sidecarPath("/opt/nimbus/bin/nimbus-gateway", "linux"))
  .toBe(posixPath.join("/opt/nimbus/bin", "vec0.so"));
```

The same rule applies to production helpers that accept a `platform` argument and run on a host where `process.platform` differs — branch on the argument, not on `process.platform`.

The `pr-quality-cross-platform` job (`.github/workflows/ci.yml`) runs gateway/CLI unit tests on macOS and Windows at PR time so this class of regression is caught before merge.

### Using the `nimbus-*` skill set (Claude Code / compatible AI assistants)

The repository ships fourteen `nimbus-*` skills under `.claude/commands/` that codify how to do common contributor tasks correctly:

- **Architecture & navigation:** `nimbus-architecture` (subsystem overview), `nimbus-file-map` (where things live), `nimbus-commands` (the full `bun run` + CLI catalogue with coverage gates and env-var overrides).
- **Security invariants:** `nimbus-security-invariants` (the triple rule — wiring + docs + test), `nimbus-tool-output-envelope` (I11), `nimbus-tauri-allowlist` (I7), `nimbus-http-write-surface` (I13 — Phase 5 T4 PR 3b).
- **Subsystem authoring:** `nimbus-ipc` (JSON-RPC method conventions), `nimbus-connector-authoring` (first-party MCP connectors), `nimbus-agent-patterns` (built-in agents), `nimbus-db-migrations` (SQLite schema), `nimbus-embedding-routing` (T6 PR 3 hybrid embedding).
- **Cross-cutting:** `nimbus-cicd-data-layer` (T4 DORA + preflight + annotation), `nimbus-testing` (which test layer for which subsystem).

When working in Claude Code (or a compatible AI assistant that respects skills), they load automatically and prevent the most common cross-cutting mistakes — orphan security defenses, broken HITL invariants, dead-code allowlist entries, and the like.

Direct browsing: see `.claude/commands/` and the index in `CLAUDE.md`. The skills are equally useful as plain reading material if you are not using an AI assistant.

### Shell scripts and audit gates

The `scripts/` directory holds repository tooling — release packaging (`scripts/release/`, `scripts/install/`, `scripts/linux/`, `scripts/windows/`), structural audits (`scripts/structure-audit/` — invariant checks, OpenAPI drift, doc-ref drift, license check), CI helpers (`scripts/ci/`), per-package coverage-floor (`scripts/coverage-floor/`), README generators (`scripts/audit/`), and the asciinema hero-cast harness (`scripts/cast-driver/`). Every `.ts` script has a sibling `.test.ts`; the suite is wired as `bun run test:scripts` and runs in CI. The full list of contributor-facing `bun run` scripts (and the env-var overrides that gate them) lives in the [`nimbus-commands`](../.claude/commands/nimbus-commands.md) skill / reference file.

### Before Opening a PR

- [ ] `bun run typecheck` passes with zero errors
- [ ] `bun run lint` passes (or `bun run lint:fix` was run)
- [ ] All existing tests pass
- [ ] New behaviour is covered by tests
- [ ] Coverage gates still pass if you touched `engine/` or `vault/`
- [ ] You have not introduced any `any` types
- [ ] Platform-specific code is behind the `PlatformServices` abstraction
- [ ] No credentials, tokens, or secret values appear in any log, IPC message, or config

---

## Adding a New MCP Connector

Connectors live in `packages/mcp-connectors/`. They depend only on `@nimbus-dev/sdk`.

Two generators exist. Use the one that matches how you are working:

- **Inside this repo** (you have Nimbus checked out and built): `nimbus scaffold extension packages/mcp-connectors/your-service` — the id is a positional argument, not `--name`/`--output` flags, and it doubles as both the output directory (relative to your current working directory) and the `id` field written into the generated manifest, so pass the full repo-relative path you want.
- **Standalone** (you want a connector outside the monorepo): [`create-nimbus-connector`](https://github.com/nimbus-agent/create-nimbus-connector)

`nimbus scaffold extension` emits a generic extension shell, not a connector-shaped one: `nimbus.extension.json`, `package.json`, `dist/index.js`, and `smoke.test.ts` — no `src/server.ts`, no per-package TypeScript config, no README, and no `@nimbus-dev/sdk` dependency. Because every connector-specific gate (`audit:connector-registry-drift`, `audit:connector-entrypoints`, `audit:connector-deps`) keys off the presence of `src/server.ts`, a freshly scaffolded directory is invisible to all three of them — they report clean, which is not the same as done, and `bun run typecheck` silently skips it too (see step 5). None of this is automatic; do this by hand after scaffolding:

1. Write `src/server.ts` implementing the MCP server against the service's API — copy the shape of an existing connector (e.g. `packages/mcp-connectors/github/src/server.ts`) rather than the scaffold's `dist/index.js` placeholder.
2. Rewrite `package.json` to the real connector convention: `name: "nimbus-mcp-<service>"`, a `bin` entry, `dependencies` limited to the connector allow-list (`@modelcontextprotocol/sdk`, `@nimbus-dev/sdk`, `zod`, and a short list of others — see `ALLOWED_CONNECTOR_DEPS` in `scripts/structure-audit/check-connector-deps.ts`), and `build`/`typecheck`/`lint` scripts — the scaffold's `package.json` has only `test`.
3. Add a per-package tsconfig.json next to your connector's `package.json` — every real connector has one; the scaffold does not generate one.
4. Rewrite `nimbus.extension.json` to the real shape used by connectors: `id: "com.nimbus.<service>"`, `entrypoint: "dist/server.js"`, `permissions: { network: [...] }`, and declare write/delete tools with `hitlRequired: true` — the Gateway enforces HITL automatically. (The scaffold writes `id`/`entrypoint`/`permissions` in a generic-extension shape connectors don't use.)
5. Add the new package path to the root `package.json`'s `workspaces` array. It is an explicit list, not a glob — `bun install` and `bun run typecheck` (which runs `--filter '*'` over workspace members) silently skip a connector directory that isn't listed there. Run `bun install` after adding it.
6. Run the SDK contract tests against your manifest with `runContractTests(manifest)` from `@nimbus-dev/sdk` (validates mandatory tool surface, HITL declaration, item-ID format, `SyncResult` shape). If your connector declares `permissions.{network,filesystem}` for the T2 PR 1 sandbox, also run `runSandboxContractTests()`. Use `MockGateway` from `@nimbus-dev/sdk/testing` for in-process IPC stubbing in unit tests.
7. Run `bun run gen:connector-registry` to register the connector in the generated `packages/gateway/src/connectors/bundled-connector-registry.ts`, and commit the result — `bun run audit:connector-registry-drift` fails until you do, and the shipped binary cannot start an unregistered connector.

See the [architecture](./architecture.md) for connector mesh details.

---

## Adding a New Dependency

Before adding any package with `bun add`, run:

```bash
bun run check-package <name>
```

Verify the printed author, maintainer, created date, and version count look reasonable. The script warns on packages less than 7 days old — these are a common slopsquatting / typosquatting vector and should not be added without an explicit reason.

---

## Package Dependency Rules

```text
gateway    ← must not import from cli or ui
cli        ← IPC-only communication with gateway (no source imports)
ui         ← IPC-only communication with gateway (no source imports)
sdk        ← must not import from gateway, cli, or ui
mcp-connectors/*  ← depend on @nimbus-dev/sdk only
```

Circular dependencies are forbidden. The linter will catch cross-package source imports.

---

## Pull Request Process

1. Open an issue or discussion first for anything non-trivial
2. Fill in the pull request template completely — incomplete PRs will be returned
3. All CI checks must be green: `pr-quality` (Ubuntu) must pass before review begins. To run optional desktop E2E (Tauri + Playwright) on a PR, add the `ci:e2e-desktop` label (that retriggers CI so the E2E job can run).
4. At least one maintainer approval is required before merge
5. Squash-merge is preferred for feature branches; merge commits for release branches

---

## Reporting Bugs

Use the **Bug Report** issue template. Include:

- OS and version
- Bun version (`bun --version`)
- Exact command run and full output
- Whether it is platform-specific (does it reproduce on another OS?)

For security vulnerabilities, **do not open a public issue** — see [`SECURITY.md`](./SECURITY.md).

---

## Contributor License Agreement (CLA)

Before your first pull request to a Nimbus public repo can merge, you must sign
the CLA — a one-time, sign-by-comment step enforced by a required `CLA Assistant`
check. The bot will prompt you; reply with exactly:

```text
I have read the CLA Document and I hereby sign the CLA
```

One signature covers all Nimbus public repos. See the
[Individual CLA](https://github.com/nimbus-agent/.github/blob/main/CLA/ICLA.md);
contributing for an employer uses the
[Corporate CLA](https://github.com/nimbus-agent/.github/blob/main/CLA/CCLA.md).

**Why a CLA.** It grants a broad, relicensable license so the AGPL-3.0 core can
be offered under more than one license in future — something a DCO cannot do.

**MIT → AGPL is one-way.** The gateway/CLI/connectors are AGPL-3.0; `@nimbus-dev/sdk`
and `@nimbus-dev/client` are MIT. Code may flow **MIT → AGPL** but never the
reverse: a patch to the MIT packages must not be derived from AGPL-licensed parts
of this repository. If unsure which side your change sits on, ask in the PR.

---

## Questions

Open a [GitHub Discussion](https://github.com/nimbus-agent/Nimbus/discussions) rather than an issue. Issues are for confirmed bugs and accepted feature requests.
