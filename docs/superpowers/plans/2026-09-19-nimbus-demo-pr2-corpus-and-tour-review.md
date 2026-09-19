# Review of `nimbus demo` PR 2 Implementation Plan

**Plan Reviewed:** `2026-09-19-nimbus-demo-pr2-corpus-and-tour.md`  
**Spec Reference:** `docs/superpowers/specs/2026-09-18-nimbus-demo-design.md`  
**Review Date:** 2026-09-19  

---

## 1. Executive Summary

The PR 2 implementation plan is exceptionally thorough, tightly constrained, and directly implements the architecture and security requirements established in PR 1 (#1545) and the demo design specification.

The plan correctly addresses the subtle systemic complexities uncovered during earlier spikes:
1. **SyncScheduler inertness:** Choking the scheduler from within via `syncDisabled` rather than relying on `!started`, because `forceSync` and job `.finally -> tick()` bypass `start()`.
2. **Boot-time outbound work:** Blocking the updater check, telemetry flush, embedding download, and extensions auto-update via `BootPolicy` before any seeded `nimbus.toml` is written.
3. **Corpus integrity & freshness:** All timestamps are strictly relative offsets from `seedNowMs`; all identities/domains use `.example`; and re-seeding recreates the data directory rather than attempting to hand-truncate 83+ tables.
4. **Platform-safe process lifecycle:** Using `stopAndWaitForExit` to eliminate asynchronous file-handle locking issues on Windows SQLite/log files during recreate/reset.

This review identifies a few concrete bugs/typos in the plan's code snippets, raises open architectural questions, and suggests minor ergonomics and testing enhancements.

---

## 2. Concrete Bugs & Discrepancies in the Plan

### 2.1. Broken Suggested Command in `demo.ts` (`nimbus --demo stats`)
* **Location:** Task 7, Step 4 (`commands/demo.ts`)
* **Issue:** The closing suggestion in `runDemo` prints:
  ```text
  The demo gateway is still running on the synthetic org. Try:
    nimbus --demo standup
    nimbus --demo expert payments
    nimbus --demo stats
  ```
  However, `packages/cli/src/commands/stats.ts` hard-requires both a metric positional argument and `--service <id>`:
  ```ts
  if (metric === undefined || metric.startsWith("--")) {
    throw new Error(`Usage: nimbus stats <${METRICS.join("|")}> --service <id>`);
  }
  if (service === undefined || service.trim() === "") {
    throw new Error("Missing --service <id>");
  }
  ```
  Running `nimbus --demo stats` as suggested will immediately fail with `Usage: nimbus stats ...`.
* **Fix:** Replace `nimbus --demo stats` with either a valid stats invocation or another built-in agent that works out-of-the-box without required flags:
  - Option A (Specific stats metric): `nimbus --demo stats deployment-frequency --service payment-service`
  - Option B (Agent brief): `nimbus --demo changelog` or `nimbus --demo decisions`

---

### 2.2. Incorrect SQL Column in `seed.test.ts` Integration Test
* **Location:** Task 5, Step 1 (`seed.test.ts`)
* **Issue:** The test query uses `r.relation_type = 'assigned'`:
  ```sql
  SELECT COUNT(*) AS n FROM graph_relation r
    JOIN graph_entity pe ON pe.id = r.from_id
    JOIN graph_entity ie ON ie.id = r.to_id
   WHERE r.relation_type = 'assigned' AND pe.type = 'person' AND ie.external_id LIKE '%PDEMO412%'
  ```
  In the schema (`packages/gateway/src/index/graph-v7-sql.ts`), the column name in `graph_relation` is `type`, not `relation_type`.
* **Fix:** Change `r.relation_type = 'assigned'` to `r.type = 'assigned'`. (The plan noted this might differ from memory, so confirm `type` during implementation).

---

### 2.3. Handling `sidecarStops` when Telemetry Flush is Skipped in `assemble.ts`
* **Location:** Task 2, Step 2 (`packages/gateway/src/platform/assemble.ts`)
* **Issue:** In `assemble.ts` (~line 4282–4290):
  ```ts
  const telemetryStop = startTelemetryFlushScheduler({ ... });
  sidecarStops.push(telemetryStop.stop);
  ```
  If `startTelemetryFlushScheduler` is wrapped in `if (bootPolicy.telemetryFlush)`, `telemetryStop` is not declared or in scope when pushing to `sidecarStops`.
* **Fix:** Ensure both the initialization and `sidecarStops.push` are inside the `if (bootPolicy.telemetryFlush)` block:
  ```ts
  if (bootPolicy.telemetryFlush) {
    const telemetryStop = startTelemetryFlushScheduler({ ... });
    sidecarStops.push(telemetryStop.stop);
  }
  ```

---

### 2.4. Explicit Decision on `wireUpdaterIntoIpc` in `assemble.ts`
* **Location:** Task 2, Step 2 (`packages/gateway/src/platform/assemble.ts`)
* **Issue:** Step 2 asks the implementer to "first read `wireUpdaterIntoIpc`: if it also registers the `updater.*` IPC methods... pass a flag".
* **Code Survey Result:** `wireUpdaterIntoIpc` calls `ipc.setUpdater(updater)`. If `wireUpdaterIntoIpc` is not called, `ipc` has no updater, so `tryDispatchUpdaterRpc` returns the standard error `-32602 "Updater is not configured"`. Furthermore, on a fresh demo boot before `demo.seed`, `loadNimbusUpdaterFromConfigDir` reads default config (`enabled: true`, `checkOnStartup: true`).
* **Recommendation:**
  In `assemble.ts`:
  ```ts
  if (bootPolicy.updaterStartupCheck) {
    wireUpdaterIntoIpc(paths.configDir, ipc, syncLogger);
  }
  ```
  Skipping `wireUpdaterIntoIpc` entirely on a demo gateway is completely safe and cleanly prevents both startup checks and any ambient background activity.

---

## 3. Open Questions & Design Clarifications

### 3.1. Behavior of `nimbus --demo init`
* **Question:** What should happen if a user runs `nimbus --demo init`?
* **Context:** `init` runs the interactive onboarding wizard that prompts to connect GitHub, Slack, etc., and invokes `connector auth`. In demo mode, all `connector.*` mutations are refused with `ERR_DEMO_FORBIDDEN`.
* **Suggestion:** In `packages/cli/src/commands/init.ts`, if `paths.demo === true`, either:
  1. Print: `"You are in demo mode. The synthetic Acme org is already configured. Run 'nimbus demo' to seed and explore, or omit '--demo' to initialize your real Nimbus workspace."` and exit cleanly, or
  2. Let it fail at the first refused RPC with the clear `ERR_DEMO_FORBIDDEN` error.

---

### 3.2. Scope of the Refusal Gate vs. `toolgen.*` & `media.allowRemote`
* **Question:** Should `toolgen.create` / `toolgen.save` and `media.allowRemote` be in the demo refusal gate?
* **Analysis:**
  - `media.allowRemote`: Writes a `media_grant` row. Modality is pinned to image-only and remote calls require existing LLM keys in Vault.
  - `toolgen.create` / `save`: Writes ephemeral/saved tools into the demo root, and credentials into the demo `EphemeralVault`.
  - Because `EphemeralVault` never touches the OS keyring and demo directories are isolated, these do not violate data isolation. However, since the demo org is synthetic and evaluated in ~1 minute, runtime tool creation is out of scope for the demo evaluator flow.
* **Suggestion:** Keep the current explicit refusal list (`connector.*` writes, `vault.set/delete`, `data.import`, `extension.install`). No additional refusals are strictly required, but document why `EphemeralVault` protects `toolgen` from polluting the real keyring.

---

### 3.3. Windows UNC / Path Separator Consistency in Blame & Roots
* **Question:** How are relative vs. absolute paths handled on Windows when seeding files and roots?
* **Analysis:**
  In Task 5 Step 2:
  - `writeDemoConfig` replaces backslashes with forward slashes in `[[filesystem.roots]]` TOML string.
  - It reads the root back via `loadNimbusFilesystemRootsFromConfigDir` and uses `repoRoot = root.path`.
  - `upsertBlameLines` and `git_commit` items must match `repoRoot` byte-for-byte.
  - `matchConfiguredRoot` in `why-subject.ts` normalizes file paths with `.replaceAll("\\", "/")`.
* **Confirmation:** The plan's discipline of "read the root back through the real loader and use that exact string as `repoRoot`" ensures 100% path equality between SQLite blame rows and runtime root resolution on Windows.

---

## 4. Improvements & Suggestions

### 4.1. Stale Seed Marker Boundary Handling
* In `demo-banner.ts`, `readDemoSeedMarker` parses `seededAtMs`.
* If there is slight system clock skew (where `Date.now() < marker.seededAtMs`), `nowMs - marker.seededAtMs` can be negative.
* `age(elapsed)` uses `Math.max(0, Math.floor(ms / 60_000))`, which cleanly yields `0m ago`.
* **Suggestion:** Add a test case in `demo-banner.test.ts` for negative elapsed time (`nowMs < seededAtMs`) verifying it returns `"seeded 0m ago"` without error.

---

### 4.2. Tour Presentation & Visual Framing
* The tour headers use:
  ```text
  ── [1/3] On-call triage ─────────────────────────────
  $ nimbus --demo oncall
  ```
  padded with `─` to 56 chars.
* **Suggestion:** Ensure the tour output uses standard newlines between briefs so that when piped to a file or viewed in a pager, each brief starts with clear visual separation.

---

### 4.3. Preflight & Local Test Suite Hygiene
* The plan lists known environment reds (e.g. `nimbus-verify-ps1.test.ts` under WSL bash, `runTui` when a gateway is running, Windows sandbox helper build requirement).
* **Reminder:** Explicitly run `bun run build:sandbox-helper:win32` on Windows before executing Task 10 e2e tests to ensure the sandbox helper binary is current.

---

## 5. Review Conclusion

The plan is well-structured, comprehensive, and ready for execution once the minor items in Section 2 are addressed:
1. Fix the `nimbus --demo stats` suggestion in `commands/demo.ts`.
2. Fix `r.type = 'assigned'` in `seed.test.ts`.
3. Ensure `sidecarStops.push` is conditionally scoped in `assemble.ts`.

All 11 tasks follow strict TDD (test-first), enforce security invariants (I41), maintain the strict separation between CLI and Gateway packages, and preserve production telemetry/isolation boundaries.
