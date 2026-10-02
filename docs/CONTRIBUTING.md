# Contributing to Nimbus

Thank you for your interest in contributing. Nimbus is in active development — [`roadmap.md`](./roadmap.md) records what is shipping now. Architecture is stabilising but not all interfaces are frozen.

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
# Requires Bun v1.2+ (CI uses 1.3). Building the docs site also needs Node >= 22.12.
git clone https://github.com/nimbus-agent/Nimbus.git
cd Nimbus
bun install
```

### 2. Verify Your Environment

```bash
bun run typecheck                    # Must pass with zero errors
bun run lint                         # Biome — format + lint
bun test packages/gateway/src/db     # a quick, scoped test run to prove the toolchain works
```

The whole suite is large and slow; while you work, run the tests for the area you touched. Before pushing, run `bun run preflight:fast` (about 2–3 minutes of static gates).

### 3. Find Something to Work On

- Issues tagged [`good first issue`](https://github.com/nimbus-agent/Nimbus/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are the best starting point
- Issues tagged [`help wanted`](https://github.com/nimbus-agent/Nimbus/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) are open for contributors
- Connector code lives in [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers), which has its own issues; the per-connector **sync and indexing** logic stays here
- **Open a discussion before starting any large PR.** Architecture decisions belong in a discussion, not in a surprise diff
- **Ask to be assigned before you start.** Comment on the issue and let a maintainer assign it to you first — it keeps two people from building the same thing. During October and other high-traffic periods, an outside pull request is reviewed only for an issue the author was assigned first, to keep the review queue honest; outside those periods it's the courteous default, not a hard gate — if in doubt, comment on the issue and open the PR anyway.

### October 2026

Nimbus carries the `hacktoberfest` topic and treats October as its main contributor month: the `good first issue` shelf is stocked and every issue on it has an acceptance criterion. Note that **Hacktoberfest 2026 no longer counts pull requests** — the organisers moved to in-person and online events — so there is no PR tally to chase and no `hacktoberfest-accepted` label here. Contribute because the work is useful to you; we will review it on the same terms as any other month.

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

Because pull requests are squash-merged, what actually lands on `main` is the **PR title**, not your individual commit messages — so that is where the format matters. The `Validate PR title` check enforces it (scope must be lowercase); you can fix a failing title by editing it on the PR, no new push needed. Individual commit messages inside your branch are not checked.

### Running Tests

```bash
bun test packages/gateway/src/<area>  # the tests for what you changed — the everyday loop
bun run test:integration              # integration tests (real SQLite, real subprocesses)
bun run test:e2e:cli                  # E2E CLI tests (real Gateway + mock MCP servers)
cd packages/ui && bunx vitest run     # UI component tests
bun run preflight:fast                # static gates CI runs — run before every push
bun run preflight                     # the full CI-parity gate set, including the whole test suite
```

Coverage is enforced by two CI gates that read the Linux coverage report: `audit:coverage-floor` (per file, below) and `audit:coverage-scopes` (per directory — for example `engine/` ≥85%, `vault/` ≥90%, most others ≥80%; the list is in `scripts/coverage-floor/check-scopes.ts`). The `test:coverage:*` scripts in `package.json` do **not** enforce anything — Bun ignores their threshold flag — so a green run of one tells you nothing about CI. The full command catalogue and environment-variable overrides live in the [`nimbus-commands`](../.claude/commands/nimbus-commands.md) skill / reference file.

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

The `pr-quality-cross-platform` job (`.github/workflows/ci.yml`) runs the same whole-repo test paths on macOS and Windows at PR time as the push matrix — `packages/gateway packages/cli scripts`, so unit, integration and e2e in one process — and this class of regression is therefore caught before merge rather than on `main`. Only the flags differ (the push leg adds coverage instrumentation and a JUnit reporter that this job has no use for); coverage and packaging stay Ubuntu-only.

### Using the `nimbus-*` skill set (Claude Code / compatible AI assistants)

The repository ships a set of `nimbus-*` skills under `.claude/commands/` that codify how to do common contributor tasks correctly. The ones most contributors reach for:

- **Architecture & navigation:** `nimbus-architecture` (subsystem overview), `nimbus-file-map` (where things live), `nimbus-commands` (the full `bun run` + CLI catalogue with coverage gates and env-var overrides).
- **Before you push:** `nimbus-preflight` (which gates to run and why local green is not CI green), `nimbus-testing` (which test layer for which subsystem).
- **Security invariants:** `nimbus-security-invariants` (the triple rule — wiring + docs + test), `nimbus-tool-output-envelope` (I11), `nimbus-tauri-allowlist` (I7), `nimbus-http-write-surface` (I13).
- **Subsystem authoring:** `nimbus-ipc` (JSON-RPC method conventions), `nimbus-connector-authoring` (first-party MCP connectors), `nimbus-agent-patterns` (built-in agents), `nimbus-db-migrations` (SQLite schema), `nimbus-embedding-routing` and `nimbus-index-body-depth` (how an indexed item type is embedded and how much of its body is stored).

The full list, with a one-line "use when" for each, is the Skill References table in `CLAUDE.md`.

When working in Claude Code (or a compatible AI assistant that respects skills), they load automatically and prevent the most common cross-cutting mistakes — orphan security defenses, broken HITL invariants, dead-code allowlist entries, and the like.

Direct browsing: see `.claude/commands/` and the index in `CLAUDE.md`. The skills are equally useful as plain reading material if you are not using an AI assistant.

### Shell scripts and audit gates

The `scripts/` directory holds repository tooling — release packaging (`scripts/release/`, `scripts/install/`, `scripts/linux/`, `scripts/windows/`), structural audits (`scripts/structure-audit/` — invariant checks, OpenAPI drift, doc-ref drift, license check), CI helpers (`scripts/ci/`), per-package coverage-floor (`scripts/coverage-floor/`), README generators (`scripts/audit/`), and the asciinema hero-cast harness (`scripts/cast-driver/`). Every `.ts` script has a sibling `.test.ts`; the suite is wired as `bun run test:scripts` and runs in CI. The full list of contributor-facing `bun run` scripts (and the env-var overrides that gate them) lives in the [`nimbus-commands`](../.claude/commands/nimbus-commands.md) skill / reference file.

### Before Opening a PR

- [ ] `bun run typecheck` passes with zero errors
- [ ] `bun run lint` passes (or `bun run lint:fix` was run)
- [ ] All existing tests pass
- [ ] New behaviour is covered by tests
- [ ] New or changed source files clear the per-file coverage floor (below)
- [ ] You have not introduced any `any` types
- [ ] Platform-specific code is behind the `PlatformServices` abstraction
- [ ] No credentials, tokens, or secret values appear in any log, IPC message, or config

### The per-file coverage floor

`audit:coverage-floor` enforces **≥85% line and ≥80% branch coverage on every non-exempt file**, including new ones. A new connector or script will be rejected by it unless its tests carry it over both floors.

It is **CI-Linux-authoritative** — running it on Windows or macOS produces false violations, so do not trust a local pass or panic at a local failure. Reproduce what CI sees with:

```bash
bun run verify:docker --full
```

If a file is genuinely untestable glue rather than logic, it can be excluded — but excluding is a reviewed decision, not a default. Say why in the PR description.

---

## Adding a New MCP Connector

Connectors live in their own repository, [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers), and ship as
the `@nimbus-dev/connectors` npm package that this gateway consumes. Add or change one there.

Use [`create-nimbus-connector`](https://github.com/nimbus-agent/create-nimbus-connector). It is
published on npm and emits the whole connector package from a JSON spec — `src/server.ts`, the
`nimbus.extension.json` manifest, a per-package TypeScript config, a `package.json` matching the
connector convention, a `README.md`, and `test/sandbox.test.ts`, plus `src/search-filter.ts` when
the spec declares a search tool.

```bash
bunx create-nimbus-connector --spec ./your-service.spec.json
```

**Run it from the connectors repository's root**, where it writes to `connectors/<name>` relative
to your current directory. Running it from inside `connectors/` nests the output one level too deep.

A connector that the gateway should also INDEX needs its sync handler and registry entry here, in
this repository — adding one touches both repos. See [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers).

Model your spec on one of the generator's own fixtures — `fixtures/netlify.spec.json` is a good
read-only example. Add `--standalone` if you want the connector outside this repo; that variant
resolves its helpers from the published `@nimbus-dev/sdk` instead of relative `../../shared/*`
paths.

**`nimbus scaffold extension` is not the tool for this.** It emits a four-file generic extension
shell with no `src/server.ts`, and every connector gate — `audit:connector-registry-drift`,
`audit:connector-entrypoints`, `audit:connector-deps` — keys off that file, so its output is
invisible to all three. They report clean, which is not the same as done.

### After generating

Everything else about the connector package happens in the connectors repository and is described
there — its [guide to adding a connector](https://github.com/nimbus-agent/nimbus-mcp-servers/blob/main/docs/adding-a-connector.md)
and its contributing guide. Its single pre-push command is `bun run check` (lint, typecheck, the
connector audits and the full suite).

This repository picks the connector up only after it is **published** in a new
`@nimbus-dev/connectors` release: the maintainer bumps the pin here and regenerates the bundled
registry (`bun run gen:connector-registry`, checked by `audit:connector-registry-drift`). You do not
need to do that in your connector PR. Gateway-side indexing for the new connector — a sync handler —
is a separate PR here, and can follow once the connector is published.

Run the SDK contract tests against your manifest with `runContractTests(manifest)` from
`@nimbus-dev/sdk` — it validates the mandatory tool surface, the HITL declaration, the item-ID
format and the `SyncResult` shape. If your connector declares `permissions.{network,filesystem}`
for the sandbox, also run `runSandboxContractTests()`. `MockGateway` from `@nimbus-dev/sdk/testing`
stubs IPC in unit tests.

See the [architecture](./architecture.md) for connector mesh details.

---

## Contributing a Docs Page

The documentation site ([nimbus-agent.dev](https://nimbus-agent.dev)) is an Astro Starlight project in
`packages/docs`, and a missing connector page is one of the best first contributions: it needs no
credentials and no gateway code.

- **Where:** `packages/docs/src/content/docs/connectors/<service>.mdx`, with underscores in the
  service id written as hyphens (`google_drive` → `google-drive.mdx`). The sidebar picks the file up
  automatically — no config edit.
- **Shape:** copy the section structure of an existing page such as `linear.mdx` or `aws.mdx`.
- **Source of truth:** the connector's own directory in
  [nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers/tree/main/connectors) —
  its `README.md`, `nimbus.extension.json`, and the tool registrations in `src/tools.ts` (or
  `src/server.ts` where there is no `tools.ts`).
- **Authentication:** do not copy the command from another page, and check the connector's README
  rather than trusting it — several still show a command that fails. There are three cases:
  - **OAuth connectors** (Zoom, Figma, Salesforce, …) use `nimbus connector auth <service>`.
  - **Token connectors with a dedicated flow** also use `nimbus connector auth <service>`, with the
    flags that service takes (for example `--token`). The services with such a flow are the keys of
    `PAT_CONNECTOR_AUTH_HANDLERS` in `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts`
    (GitHub, GitLab, Linear, Jira, Confluence, AWS, Datadog, Sentry and others).
  - **Every other connector** is configured with `nimbus vault set <service>.<key> <value>`;
    `connector auth` fails for these. The keys are listed per service in `CONNECTOR_VAULT_SECRET_KEYS`
    (`packages/gateway/src/connectors/connector-secrets-manifest.ts`).

  The `good first issue` for each page says which case applies and names the keys.

Build and check it locally — this is the same command the `Docs checks` CI job runs, and it type-checks
the site and validates every internal link:

```bash
bun run docs:build                   # astro check + astro build (needs Node >= 22.12 on PATH)
bun run --filter @nimbus/docs dev    # live preview while you write
```

---

## Adding a New Dependency

Before adding any package with `bun add`, run:

```bash
bun run check-package <name>
```

Verify the printed author, maintainer, created date, and version count look reasonable. The script warns on packages less than 7 days old — these are a common slopsquatting / typosquatting vector and should not be added without an explicit reason.

---

## Updating Dependencies

Nothing updates dependencies automatically. Dependabot version updates were retired on 2026-10-02. Each of its grouped PRs needed a full CI cycle, and clearing its last weekly batch (#1573–#1576) took two days and a dozen hand-pushed fixes, none of them for a real incompatibility. Dependencies now move in a **periodic manual bulk update**: one PR that takes every workspace and every ecosystem forward at once.

Dependabot **alerts** stay on, so a vulnerable dependency still appears under the repository's **Security** tab, and the required `Dependency audit` check still fails a pull request on a live npm advisory. `Cargo audit (Tauri)` and `Cargo deny` do the same for Rust, on every pull request that touches it and on every push and nightly run. When a newly published advisory turns `main` red, a `Security gate is red on main` issue opens on its own. The fix is usually a root `overrides` bump; `scripts/structure-audit/accepted-advisories.ts` records the order of preference.

### The procedure

1. **Find what is behind.** `bun outdated --filter="*"` reports the direct dependencies of every workspace against their `latest` release. It says nothing about a transitive package that only a root `overrides` pin holds, which is most of them, so check each entry in the `overrides` block of `package.json` against its latest release separately.
2. **Read before you take a major.** That includes a 0.x minor (`0.9` → `0.10`), which semver treats as breaking and which a `^0.9` range will not pick up anyway. Land each major as its own commit within the pass, so it can be reverted alone.
3. **Edit the range by hand in every workspace manifest that declares the package**, then run `bun install`. `git grep -n '"<pkg>"' -- '*package.json'` finds every declaration. Never run `bun update <pkg>` at the repository root: in a workspace repo it adds `<pkg>` to the **root** `package.json` as a new direct dependency instead of bumping the workspace that declares it. Bumping one workspace and not another leaves two copies installed. Two copies of a peer dependency surface as a type error at your own call site that names neither copy; `find node_modules -maxdepth 4 -name <pkg> -type d` shows the split.
4. **Keep root `overrides` consistent with the ranges.** An override outranks every declared range, so moving a declaration past its pin changes nothing that is installed: move the pin in the same change. `audit:override-drift` fails on a pin that contradicts a declared range, and on a pin for a directly declared package that nothing in `bun.lock` depends on transitively, since such a pin lifts nothing. After any change to `overrides`, run `bun install --force`. That includes a rebase onto a `main` whose overrides moved. A plain `bun install` against a lockfile that already satisfies every range does not apply a changed override, and still reports "no changes".
5. **Rust:** run `cargo update` in `packages/ui/src-tauri` to refresh `Cargo.lock` within the ranges `packages/ui/src-tauri/Cargo.toml` allows; edit `Cargo.toml` itself for a deliberate minor or major move. The `cargo audit --ignore` list in `.github/workflows/security.yml` mirrors the ignores in `packages/ui/src-tauri/deny.toml`. Re-check both whenever Tauri moves.
6. **GitHub Actions:** every third-party `uses:` is pinned to a full 40-character commit SHA, which `audit:action-sha-pins` enforces, with the tag kept as a trailing comment (`uses: <owner>/<action>@<sha> # vX.Y.Z`). To move a pin, resolve the release **tag** to its **commit**: `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` peels an annotated tag, where reading the tag ref returns the SHA of the tag object instead. Replace the pin in every workflow under `.github/workflows` and every composite action under `.github/actions` that uses that action.
7. **First-party packages** follow the same steps. `audit:connector-version-skew` already fails `preflight:fast` when the `@nimbus-dev/connectors` pin falls a minor version behind the published release, and moving that pin means regenerating the bundled registry (`bun run gen:connector-registry`, checked by `audit:connector-registry-drift`).
8. **Verify the whole pass.** Run `bun run preflight`, which is the full CI-parity set. Then run `bun audit` and `bun run audit:advisories`, which only CI runs (they need the npm registry). Add `cd packages/ui && bunx vitest run` when a UI dependency moved, and `bun run docs:build` when anything in `packages/docs` moved (it needs Node >= 22.12). CI runs `cargo audit` and `cargo deny` on every PR that touches `packages/ui/src-tauri`.

Title the PR `chore(deps): …`, or `fix(deps): …` when the pass clears an advisory that users should receive in the next release.

### Packages that move together

- **`react`, `react-dom`, `@types/react` and `@types/react-dom`**, in every workspace that declares them (`packages/ui`; `react` and `@types/react` in `packages/cli` too). React refuses to boot when `react` and `react-dom` differ; a `react-dom`-only bump once failed 47 of 74 UI test files.
- **`@tauri-apps/*` and the Rust `tauri` crates.** Move `packages/ui/package.json`'s `@tauri-apps/*` in the same pass as `tauri`, `tauri-build` and `tauri-plugin-*` in `packages/ui/src-tauri/Cargo.toml`. The Tauri CLI compares `@tauri-apps/api` with the `tauri` crate, and each `@tauri-apps/plugin-<name>` with its `tauri-plugin-<name>` crate, and stops with "Found version mismatched Tauri packages" when a pair's major.minor differ.
- **`vitest` and every `@vitest/*` package.** `@vitest/coverage-v8` declares the exact `vitest` version as its peer.
- **The `github/codeql-action` sub-actions.** `init`, `autobuild` and `analyze` (`.github/workflows/codeql.yml`) and `upload-sarif` (`.github/workflows/security.yml`, `.github/workflows/scorecard.yml`) are one action at one version, so pin all of them to the same SHA.
- **`@biomejs/biome` and the `$schema` URL in `biome.json`.** Set the URL to the version that actually installed (`node_modules/@biomejs/biome/package.json`), not the range you typed. A mismatch is reported only as an info diagnostic, so `bun run lint` stays green while editors validate the config against a stale schema.
- **`sharp` and its libvips license pins.** A `sharp` bump usually moves its prebuilt `@img/sharp-libvips-*` binaries, whose LGPL exception in `scripts/structure-audit/check-js-licenses.ts` is pinned to exact versions on purpose. Move those pins and the matching line in `docs/license-policy.md` together. The pinned packages are Linux-only, so `audit:js-licenses` passes no matter what on Windows and macOS: confirm it with `bun run verify:docker`, or on CI.

### Majors that are held back

Each of these was blocked when it was recorded. Re-verify every blocker on each pass, because they clear without notice, and delete an entry once it no longer holds.

- **`vite` 8 with `@vitejs/plugin-react` 6.** `@vitejs/plugin-react` 6 peers `vite` ^8, so the two majors must land in the same pass. They were held back while an automated updater would have split them across PRs. To re-check: `@vitejs/plugin-react`'s `peerDependencies.vite`, then the UI suite on the new pair.
- **TypeScript 7 in `packages/docs`.** The rest of the repository is on TypeScript 7; `packages/docs` declares TypeScript 6. `astro check` runs `@astrojs/language-server`, which calls `ts.sys`, and TypeScript 7's native port does not expose it: under 7.0.2 the docs typecheck crashed with `undefined is not an object (evaluating 'this.ts.sys.fileExists')`. `@astrojs/check` also declares `typescript: ^5.0.0 || ^6.0.0`. To re-check: that peer range, then `bun run typecheck` with the docs workspace on 7. Separately, the root `typescript-compiler-api` alias stays on TypeScript 6 for a different reason: TypeScript 7 exports its compiler API only under explicitly unstable subpaths, and `scripts/cleanup/strip-comments.ts` and `scripts/cleanup/survey-oc.ts` drive that API directly.
- **js-yaml 5.** It was attempted in #1049 and reverted. v5's ESM build dropped the default export. TypeScript does not catch that, only running the tests does, and both this repository (two gateway source files, three CI gate scripts and a test) and the Astro/Starlight chain import it that way. The chain also declares js-yaml `^4` (`astro`, `@astrojs/starlight`, `@astrojs/internal-helpers`). Because the root `overrides` pin is global, the gateway cannot get 5 while Astro keeps 4. The pin cannot simply be dropped either: it also lifts `gray-matter` and `@istanbuljs/load-nyc-config` off js-yaml 3. To re-check: the `js-yaml` range in the `dependencies` of `astro` and `@astrojs/starlight`. When it clears, move the override and every declaration in the same PR.

---

## Package Dependency Rules

```text
gateway    ← must not import from cli or ui
cli        ← IPC-only communication with gateway (no source imports)
ui         ← IPC-only communication with gateway (no source imports)
sdk        ← must not import from gateway, cli, or ui
@nimbus-dev/connectors  ← the connectors, consumed from npm (own repo)
```

Circular dependencies are forbidden. The linter will catch cross-package source imports.

---

## Pull Request Process

1. Open an issue or discussion first for anything non-trivial
2. Fill in the pull request template completely — incomplete PRs will be returned
3. Sign the CLA if this is your first PR (see [below](#contributor-license-agreement-cla)); the `cla` check stays red until you do
4. All required CI checks must be green before merge. To run optional desktop E2E (Tauri + Playwright) on a PR, add the `ci:e2e-desktop` label (that retriggers CI so the E2E job can run).
5. The maintainer reviews and merges. Pull requests are **squash-merged** — the only merge method enabled — so the PR title becomes the commit subject on `main`: write it in the Conventional Commits format above.

**CI on your first pull request waits for a maintainer.** GitHub does not run workflows on a pull request from a first-time contributor's fork until a maintainer approves the run, and that approval is needed again for each push until your first PR merges. If your PR shows checks as "waiting for approval", that is on us, not you — it counts toward the 72-hour first response below, and a nudge is welcome.

### What to expect from the maintainer

**First response within 72 hours** on any new issue or pull request — a review, a question, or at minimum an acknowledgement that it is queued. Nimbus is maintained by one person, so a full review may take longer than the first response; if 72 hours pass with silence, a nudge on the thread is welcome and appropriate.

### Becoming a maintainer

**Write access is offered after three merged, non-trivial pull requests** — a change that needed review, not a typo fix or a one-line bump. The switches that move this repository from single-maintainer to two-maintainer mode (required approvals, code-owner review, last-push approval, bypass mode) are already written down in `.github/rulesets/general-branch.json` under `$contributor_two`, so granting it is one reviewed diff rather than a negotiation.

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
