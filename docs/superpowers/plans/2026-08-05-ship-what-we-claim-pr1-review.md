# Plan Review: Compiled-Runtime Connector Spawn (PR 1)

**Review Date:** 2026-08-05  
**Reviewed Plan:** [2026-08-05-ship-what-we-claim-pr1.md](./2026-08-05-ship-what-we-claim-pr1.md)
**Response:** [2026-08-05-ship-what-we-claim-pr1-review-response.md](./2026-08-05-ship-what-we-claim-pr1-review-response.md)  
**Status:** Review Feedback / Suggestions

---

## 1. High-Value Suggestions & Improvements

### A. Dynamic Import Tracing Gap in `entry-graph.test.ts`

* **Problem:** The `transitiveStaticGraph` implementation in `entry-graph.test.ts` only resolves static imports (`import ... from` and bare imports). Because `bundled-connector-registry.ts` registers connectors via dynamic imports (`() => import(...)`), the test's dependency tracing stops at the registry. If a connector's `server.ts` statically imports `db`, `vault`, or `ipc` gateway modules, the current test will pass vacuously and fail to detect the violation.
* **Suggestion:** Add an explicit static import verification rule or test to ensure that no file in `packages/mcp-connectors/**` imports modules from `packages/gateway/**`. This prevents stateful gateway modules from leaking into connectors.

### B. Windows Executable Extension handling in `package.json` and scripts

* **Problem:** The script `"test:connector-boot": "bun scripts/connector-boot-smoke.ts dist/nimbus-gateway"` hardcodes `dist/nimbus-gateway`. On Windows, the binary is compiled as `dist/nimbus-gateway.exe`. Passing `dist/nimbus-gateway` to `Bun.spawn` without the `.exe` extension may cause spawn errors on Windows.
* **Suggestion:** Update `connector-boot-smoke.ts` to automatically detect if it is running on Windows (e.g. `process.platform === "win32"`) and append `.exe` to the target binary path if the file exists or if it is missing from the passed argument.

### C. Configurable Timeout and Concurrency for CI Runners

* **Problem:** Under heavy load in CI runners (especially Windows virtual environments), concurrent execution of 8 Bun child processes might trigger timeouts at the 15-second limit.
* **Suggestion:** Make the `TIMEOUT_MS` and `CONCURRENCY` configurable via environment variables in `connector-boot-smoke.ts` (e.g. `const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 15000`), allowing CI workflows to scale down concurrency or increase timeout if flaky.

---

## 2. Open Questions

1. **How is the generator `gen-bundled-connector-registry.ts` integrated into workflow triggers?**
   * While there is a drift test to catch outdated registries, is there a plan to automatically run `bun run gen:connector-registry` as part of a pre-commit hook or automatic task so developers don't have to manually execute it every time a new connector is added?

2. **Does the dynamic import schema bypass linter rules?**
   * Biome is used for linting. We should ensure the dynamically imported paths (which traverse relative paths up to `packages/mcp-connectors/`) do not trigger import-sorting or path-resolution lint errors under Biome's default rules.
