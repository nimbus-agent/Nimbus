# Branch-Coverage Foundation Plan Review

**Date:** 2026-06-07
**Target:** [2026-06-07-true-coverage-foundation.md](file:///C:/gitrep/Nimbus/.claude/worktrees/dev+asafgolombek+true-coverage-program/docs/superpowers/plans/2026-06-07-true-coverage-foundation.md)

## Open Questions & Suggestions

1. **Stale Shard Accumulation in Local Runs**
   * **Problem:** In local dev cycles (or repeated runs), if `coverage/.nyc-tmp/` is not cleaned up, old JSON shards from previous runs will persist and be merged by `merge-coverage.ts`, leading to incorrect (stale) coverage results. While `build-lcov.sh` runs `rm -rf coverage`, direct test invocations or aborted runs will leave stale `.json` files.
   * **Suggestion:** Have `mergeShardsToLcov` (or the CLI invocation) clean up the temporary directory or delete the JSON shards after successfully merging them. Alternatively, add a pre-test cleanup task in `package.json` to ensure `coverage/.nyc-tmp` is always emptied before starting a test run.

2. **GitHub CLI (`gh`) Fallback**
   * **Question:** Task 10 describes downloading the merged lcov via `gh run download`. If a developer does not have `gh` CLI configured or authenticated locally, this step will fail.
   * **Suggestion:** Add a brief note explaining how the developer can manually download the `coverage-lcov-merged` artifact from the GitHub Actions run page via their browser and place it in the `coverage/` folder.

3. **YAML Parsing Check Dependency**
   * **Question:** Task 8 Step 4 uses `import {parse} from 'yaml'` to check the syntax of the workflow file. Is the `yaml` npm package guaranteed to be installed in the project root's `node_modules`?
   * **Suggestion:** If `yaml` is not in the project's dependency tree, the check will throw a module resolution error. Clarify that the package might need to be installed dev-only (e.g., `bun add -d yaml` or run with `npx yaml ...`) or that it can be verified via a standard YAML validator / during the PR preflight.

4. **Sanity Check on Zero-branch Files**
   * **Question:** For very small source files with 0 branch obligations, they default to `100%` branch coverage in `lcov-parse.ts`. Is there any scenario where a file has lines but no branch coverage and should not be treated as 100%?
   * **Suggestion:** The current logic `branches === 0 ? 100 : ...` is correct and standard for coverage tools, but we should make sure that SonarCloud aligns with this assumption (which it generally does).
