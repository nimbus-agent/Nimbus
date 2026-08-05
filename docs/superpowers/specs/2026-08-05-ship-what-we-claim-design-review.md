# Design Review: What We Ship Is What We Claim

**Review Date:** 2026-08-05
**Reviewed Spec:** [2026-08-05-ship-what-we-claim-design.md](./2026-08-05-ship-what-we-claim-design.md)
**Status:** Review Feedback / Suggestions
**Response:** [2026-08-05-ship-what-we-claim-design-review-response.md](./2026-08-05-ship-what-we-claim-design-review-response.md)

---

## 1. High-Value Suggestions & Improvements

### A. Automatic Connector Boot-Smoke Test (Mitigating Risk #3)

* **Problem:** Risk #3 notes that any connector reading files relative to its source at import/boot time will fail.
* **Suggestion:** Add a test in `packages/gateway/src/connectors/bundled-connectors.test.ts` (or equivalent) that iterates through every registered connector ID in `BUNDLED_CONNECTORS` and attempts to boot them (running a mock/noop `initialize` request or checking if they load without throwing) in a separate mock process. This prevents introducing a connector that compiles but crashes immediately upon being spawned.

### B. Bundled Dependencies & Binary Tree-Shaking Audit

* **Problem:** Dynamic imports in `bundled-connector-registry.ts` will force the bundler to include all connectors and their third-party dependencies. If any connector relies on native C/C++ bindings (e.g., `sqlite3`, keytar, node-gyp builds), Bun compilation might fail or produce a binary that lacks the shared library at runtime.
* **Suggestion:** Perform a static check or scan of all connector `package.json` dependencies to identify non-pure JS/TS packages (e.g., native modules). Native modules cannot be easily bundled inside a Bun single-binary and may need to be compiled as external sidecars, or avoided in connectors.

### C. Hardening the Sentinel Execution Boundary

* **Problem:** When spawned with `__nimbus-connector <id>`, the process must not access the gateway database, vault, or local configuration. While it runs in a separate process, importing gateway modules could trigger side effects (e.g., global DB pool initialization).
* **Suggestion:**
  1. Add an explicit check in gateway bootstrap or DB/vault modules: if `process.argv` contains connector sentinels, throw/abort if database or vault initializers are called.
  2. Ensure connector entrypoints (`server.ts`) have zero import overlap with gateway stateful modules.

---

## 2. Open Questions for Implementation

1. **How is the `embeddedAsset` name-to-path map built?**
   * Since embedded files inside `bunfs` are content-hashed and stored in a flat root, does the mapping have to be hardcoded, or is there a build-time script that generates `embedded-assets.ts` with the exact hashed file paths?

2. **Does `wrap-server-spec.ts` sandboxing work with `selfSpawn` across all platforms?**
   * On Windows, executing `process.execPath` might require appending `.exe` depending on how Bun resolves it. We must ensure `selfSpawn` correctly handles extension resolution for executable paths across all 3 OS platforms.

3. **What is the expected binary size ceiling?**
   * If all ~40 connectors are bundled, the final single-binary size might increase significantly. Should we establish a CI budget check for the compiled binary size to prevent unexpected bloat?

4. **Will `install-smoke.yml` run in a non-administrator / restricted environment?**
   * Running outside the checkout is excellent. To ensure the smoke test simulates actual user environments, it should run under a standard user account to ensure file writes to local directories (like `LOCALAPPDATA`) behave correctly.
