# `nimbus demo` Design Spec Review — Open Questions, Improvements & Suggestions

**Target Document:** [`2026-09-18-nimbus-demo-design.md`](./2026-09-18-nimbus-demo-design.md)  
**Date:** 2026-09-18  
**Scope:** Review of architecture, security invariants (I41), process lifecycle, corpus seeding, CLI UX, and test strategy.

---

## 1. Executive Summary

The design in [`2026-09-18-nimbus-demo-design.md`](./2026-09-18-nimbus-demo-design.md) is well-grounded in Nimbus's actual runtime constraints and architectural principles:
- **Root Cause & Value:** Solves the cold-start evaluator friction (empty index at minute 1) without requiring connector credentials, API keys, or remote models.
- **Sound Isolation Seam:** Isolates state under `<realDataDir>/demo/` (`config` + `data`), preserving profile semantics and avoiding any risk of writing synthetic records into the user's real database.
- **Production Code Path Reuse:** Reuses production ingest APIs (`upsertIndexedItem`, `insertPerson`, `upsertBlameLines`, `annotateDeployment`) and production pass runners (`ownership`, `glossary`, `decisions`), ensuring realistic data graph connectivity and authentic renderer/disclosure output.

Below are key open questions, edge cases, improvements, and actionable recommendations to address before/during implementation planning.

---

## 2. Architecture & Path Isolation (PR 1)

### 2.1 CLI `--demo` Interception & Logger Bootstrap Ordering
- **Problem:** In `packages/cli/src/index.ts`, `getCliPlatformPaths()` and `createCliFileLogger(paths)` run *before* command dispatch:
  ```ts
  const paths = getCliPlatformPaths();
  const { logger } = await createCliFileLogger(paths);
  ```
  If `--demo` is parsed only inside `dispatchCommand()`, the CLI file logger will already have initialized and touched `<realDataDir>/logs/cli-YYYY-MM-DD.log` in the user's *real* data directory on a fresh machine, violating the "zero touch of real Nimbus data" guarantee. Furthermore, naive positional argv parsing (`const [command, ...args] = rawArgv`) would treat `nimbus --demo oncall` as `command = "--demo"`, triggering an `Unknown command: --demo` error.
- **Recommendation:**
  - In `packages/cli/src/index.ts`, perform a pre-pass over `process.argv` before calling `getCliPlatformPaths()`:
    1. Check if `--demo` or the subcommand `demo` is present in `argv`.
    2. If present, set `process.env["NIMBUS_DEMO"] = "1"`.
    3. Strip `--demo` from the tokens passed to command dispatch so `nimbus --demo oncall` dispatches to `oncall`.
  - This ensures `getCliPlatformPaths()` immediately resolves to `<realDataDir>/demo/...` and the CLI log goes to `<realDataDir>/demo/data/logs/`.

### 2.2 `PlatformPaths.tempDir` Isolation
- **Problem:** `PlatformPaths` and `CliPlatformPaths` include `tempDir: join(tmpdir(), "nimbus")`. If left untouched, temporary files generated during demo runs (e.g. diffs, scratchpads, temp assets) could share directories with normal Nimbus operations.
- **Recommendation:**
  - In both `packages/gateway/src/platform/paths.ts` and `packages/cli/src/paths.ts`, when `NIMBUS_DEMO === "1"`, resolve `tempDir` to `join(tmpdir(), "nimbus-demo")` (or `<realDataDir>/demo/temp`).
  - Include `tempDir` in the I41 enforcement test assertions.

### 2.3 Strict Environment Variable Parsing
- **Problem:** In shell environments, variables may be exported as `NIMBUS_DEMO=""` or `NIMBUS_DEMO="0"`.
- **Recommendation:**
  - Require explicit boolean equality: `processEnvGet("NIMBUS_DEMO") === "1"` / `envGet("NIMBUS_DEMO") === "1"`. Values like `"0"`, `"false"`, or empty strings must be treated as disabled.

---

## 3. Lifecycle, Seeding & Reset (PR 2)

### 3.1 Windows Process Exit Synchronization during `nimbus demo reset`
- **Problem:** On Windows, SQLite files (`local-index.db`, `-wal`, `-shm`) and `gateway.json` hold active OS file handles while the gateway process is running. If `nimbus demo reset` signals the demo gateway process and immediately executes `rmSync(demoRoot, { recursive: true, force: true })`, it will throw `EBUSY` / `EPERM` before the process fully exits.
- **Recommendation:**
  - In `runDemoReset`, after sending the termination signal (`SIGTERM` / `process.kill(pid)`), actively wait for the process to exit (poll `process.kill(pid, 0)` up to a 5-second deadline with fallback to `taskkill /F /PID` on Windows) before attempting directory deletion.

### 3.2 Handling Unseeded Demo Gateway Access
- **Question:** What happens if a user runs `nimbus --demo oncall` directly before ever running `nimbus demo`?
  - If `withGatewayIpc` auto-spawns the demo gateway, the gateway will boot with an empty SQLite database (since `demo.seed` has not been invoked).
  - The evaluator will see an empty brief with "no data" disclosures.
- **Recommendation:**
  - Option A (Auto-seed on first boot): When a demo-rooted gateway boots and finds an empty `local-index.db` (or `_schema_migrations` applied but 0 items), auto-trigger `demo.seed` during platform assembly.
  - Option B (CLI check): If `nimbus --demo <command>` queries a demo gateway that has never been seeded, print a friendly notice:  
    `"Demo environment is unseeded. Run 'nimbus demo' to seed synthetic Acme data and tour the agents."`
  - Option A is recommended for maximum "time-to-wow" friction reduction.

### 3.3 `demo.seed` Atomicity and SQLite Table Truncation
- **Question:** How does `demo.seed` reset the database when re-seeding an existing demo database (e.g. to refresh timestamps per § 4.4)?
- **Recommendation:**
  - Execute table reset inside a single SQLite transaction.
  - Delete from data tables in reverse topological order (`graph_edge`, `graph_entity`, `git_blame_line`, `item_fts`, `item_chunk`, `item`, `person`, `deployment`, `ci_run`, `decision_record`, `decision_evidence`, `glossary_term`, `premortem_theme`, `fleet_brief`, `fleet_run`, `fleet_job_state`).
  - Preserve `_schema_migrations` so migrations do not need to re-run.
  - Reset pass state tables (`ownership_pass_state`, `glossary_pass_state`, `decision_pass_state`) to empty.
  - Re-create `<demoRoot>/workspace/acme-payments/` sample files on disk cleanly.

### 3.4 Stale Seed Hint in Banner
- **Observation:** Agent windows (e.g. 24h for `standup`/`oncall`) mean that if an evaluator leaves the demo gateway running for 3 days, subsequent `nimbus --demo oncall` commands will find no incidents in the 24h window.
- **Recommendation:**
  - In the stderr banner (`DEMO — synthetic "Acme" org...`), if `seedAgeMs > 24 * 3600_000`, append a refresh hint:  
    `DEMO — synthetic "Acme" org · seeded 3d ago (stale) · run 'nimbus demo' to re-seed`.

---

## 4. Security & Invariant I41 Enforcement

### 4.1 Dispatcher-Level Choke Point for Connector Mutation Refusal
- **Spec Statement (§ 5):** "a demo gateway refuses `connector.auth`, connector add, and `connector.sync` with an error naming the real profile."
- **Improvement:**
  - Instead of patching each connector RPC handler individually (which risks forgetting future connector endpoints like `connector.addMcp`, `connector.remove`, `connector.setDepth`, `connector.setConfig`), implement this check at the dispatcher entry point in `packages/gateway/src/ipc/server/dispatchers.ts`:
    ```ts
    if (ctx.options.isDemo && isConnectorMutationMethod(method)) {
      throw new RpcMethodError(
        -32603,
        "ERR_DEMO_CONNECTOR_FORBIDDEN: Connectors cannot be configured in demo mode. Switch to a standard profile to connect real accounts.",
      );
    }
    ```
  - This fail-closed choke point guarantees no real connector credentials or sync jobs can ever enter the demo instance.

### 4.2 Structural Isolation of `demo.seed`
- **Spec Statement (§ 4.1):** `demo.seed` is registered only when the gateway is demo-rooted; a normal gateway answers `Method not found` (-32601).
- **Verification Requirement:**
  - Test over a real socket that a non-demo gateway returns standard JSON-RPC `-32601 Method not found` for `demo.seed`.
  - Test that `demo.` is explicitly listed in `FORBIDDEN_OVER_LAN` in `packages/gateway/src/ipc/lan-rpc.ts` and excluded from `ui/src-tauri/src/gateway_bridge.rs` (`ALLOWED_METHODS`, I7).

---

## 5. Tour & Command UX

### 5.1 Working Directory Independence for `why` and `owners`
- **Observation:** When the evaluator runs `nimbus --demo why src/retry/backoff.ts:42` from an arbitrary terminal directory (e.g. `C:\Users\evaluator\my-project` or `~`), `why` must resolve `src/retry/backoff.ts` against the demo root's `[[filesystem.roots]]` (`<demoRoot>/workspace/acme-payments/`), not the current working directory.
- **Verification:**
  - Verify in unit/e2e tests that `runWhyCli` and `runOwnersCommand` with `--demo` succeed even when `process.cwd()` is outside the demo workspace root.

### 5.2 Tour Formatting & Non-TTY / Piped Execution
- **Recommendation:**
  - When `nimbus demo` runs the tour, format each step with clear visual demarcations:
    ```text
    ========================================================================
    [1/3] Step 1: On-Call Triage
    Command: nimbus --demo oncall
    ========================================================================
    (Verbatim agent output)
    ```
  - When `stdout` is not a TTY or `--json` is supplied, ensure the command does not prompt interactively, and cleanly outputs structured results or sequential Markdown without spinner escape codes.

### 5.3 `nimbus --demo ask` Without Configured Models
- **Spec Statement (§ 2.8, § 6):** Model resolution behavior to be captured in PR 2.
- **Recommendation:**
  - Since a fresh install has no model provider configured, running `nimbus --demo ask "..."` should cleanly return a user-friendly refusal explaining that `ask` requires configuring either a local model (via Ollama / `[llm.local]`) or a remote vendor key (via `nimbus vault set`), rather than an unhandled error or hanging on remote calls.

---

## 6. Suggested Additions to Implementation Plan

1. **Task Checklist for PR 1 (Isolation & Plumbing):**
   - [ ] Update `packages/gateway/src/platform/paths.ts` and `packages/cli/src/paths.ts` for `NIMBUS_DEMO=1`.
   - [ ] Update `packages/cli/src/index.ts` to pre-scan and extract `--demo` before logger bootstrap.
   - [ ] Implement `I41` security invariant test across Darwin, Linux, and Windows path generators.
   - [ ] Test fail-closed rejection when `NIMBUS_DEMO=1` is combined with `NIMBUS_CONFIG_DIR` or `NIMBUS_GATEWAY_SOCKET`.
   - [ ] Implement E2E test verifying dual gateway boot (normal + demo) on temp roots with zero mutation of real config/data directories.

2. **Task Checklist for PR 2 (Corpus, Seeding, Tour & CLI Commands):**
   - [ ] Build typed synthetic Acme dataset under the gateway's new `demo/corpus/` directory (relative `offsetMs`, `.example` domains, 8 people, 3 services).
   - [ ] Wire `demo.seed` IPC method (demo gateway only; LAN-denied; not in Tauri allowlist).
   - [ ] Implement demo gateway auto-seed on clean boot and connector mutation refusal.
   - [ ] Implement `nimbus demo`, `nimbus demo --no-tour`, `nimbus demo stop`, and `nimbus demo reset`.
   - [ ] Implement `stderr` banner formatting with seed-age tracking.
   - [ ] Add tour regression integration tests asserting on story facts in `oncall`, `why`, and `owners`.
   - [ ] Update documentation (`docs/cli-reference.md`, `docs/architecture.md`, `docs/SECURITY-INVARIANTS.md`, `docs/roadmap.md`, `README.md`).
