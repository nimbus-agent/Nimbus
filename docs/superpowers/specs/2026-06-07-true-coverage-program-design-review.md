# True Coverage Program Design Review

**Date:** 2026-06-07
**Target:** [2026-06-07-true-coverage-program-design.md](./2026-06-07-true-coverage-program-design.md)

## Open Questions & Suggestions

1. **Concurrency and `globalThis.__coverage__` Aggregation**
   * **Problem:** Bun executes test files concurrently, often spawning separate processes or worker threads for each test file. Since `globalThis` is not shared across processes, `globalThis.__coverage__` will be isolated to each subprocess.
   * **Question:** If each test file runs in its own process, the `afterAll` hook in `report-coverage.ts` will fire multiple times (once per test file process). If they all attempt to write to `coverage/lcov.info` concurrently, it will lead to race conditions and overwritten data.
   * **Suggestion:** Instead of writing directly to a single `coverage/lcov.info`, the `afterAll` hook should write to a unique temporary file per process (e.g., using a UUID or process ID, like `coverage/tmp/coverage-[pid].json`). A post-test script (e.g., run via the package `package.json` test scripts) should then collect, merge (using `istanbul-lib-coverage`), and output the final single `lcov.info` file.

2. **Stack Trace and Source Map Fidelity**
   * **Question:** When Babel instruments the code on-the-fly via the onLoad plugin, does it break or distort stack traces for test failures?
   * **Suggestion:** While `retainLines: true` keeps line numbers aligned, columns and expression locations might shift. We should ensure the onLoad plugin returns an inline source map in the transformed output or configure Babel to generate source maps so that Bun can accurately map errors and logs back to the original source.

3. **Babel Dependencies and Setup Cost**
   * **Question:** What is the minimal set of dependencies required for the Babel compiler setup in the preload?
   * **Suggestion:** Ensure the `devDependencies` block in the root or package `package.json` files contains pinned versions of `@babel/core`, `@babel/preset-typescript`, and `babel-plugin-istanbul` to avoid version mismatch issues across environments.

4. **Coverage for Worker Processes**
   * **Question:** The design notes that worker entry-points (`embedding-worker.ts`, `query-guard-worker.ts`) are excluded because they run in a realm the preload cannot reach. Is it possible to instrument them by adding the `--preload` option to the environment variables or command-line arguments when spawning the worker threads/processes?
   * **Suggestion:** If workers are spawned using `new Worker(path, { smap: ... })` or similar, investigate if the worker execution environment supports preloading or if we can pass the loader dynamically. If not, keeping them in exclusions with clear documentation is a solid fallback.

5. **Exclusions Drift and Sanity Checks**
   * **Suggestion:** With two different axes (line and branch), some files might meet the line floor but fail the branch floor. Ensure that the sanity check warning (`LF > 0` but `BRF === 0`) does not produce false positives on very small utility files that legitimately contain zero branches (e.g., type definitions, pure constants, or single-expression modules).

## Alignment with Invariants

* Separating the instrumented coverage run into a separate CI job protects the local dev loop and PR gate latency, matching the local-first and developer-experience principles.
* The use of a v2 baseline schema with a v1->v2 read shim ensures smooth migrations and backward compatibility.
* Exclusions rules are maintained properly.
