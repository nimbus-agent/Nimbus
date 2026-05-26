# Pre-flight Workflow Overhaul Design Review

**Date:** 2026-05-25

This document captures open questions, suggestions, and potential improvements based on a review of the `2026-05-25-preflight-workflow-design.md` specification.

## Open Questions

1. **Drift Test Robustness (Component 1):**
   * *Question:* The `scripts/preflight.test.ts` drift test explicitly greps for `bun run audit:*`, `lint:markdown`, and `jscpd` in the YAML files. If a new CI gate is added in the future that doesn't follow this exact naming convention (e.g., `bun run check:types`), the drift test will silently miss it. Should the test enforce a strict naming convention for all CI jobs, or perhaps parse the YAML structure to extract all `run:` commands for analysis?

2. **Pre-push Hook Friction (Component 4):**
   * *Question:* The `pre-push` hook runs `preflight:fast`, which is estimated to take 2-3 minutes. While much faster than full CI, a 3-minute block on `git push` can still create significant friction for developers accustomed to instant pushes. Is `NIMBUS_SKIP_PREPUSH=1` documented prominently enough for emergency or trivial pushes? 

## Suggestions & Improvements

1. **AST vs. Regex for Cross-Platform Audit (Component 2):**
   * *Suggestion:* The cross-platform static audit currently relies on heuristics (likely Regex) to catch path-separator literals in assertions (e.g., `.toBe("foo/bar")`). Regex-based parsing of JavaScript/TypeScript files is famously brittle and can easily yield false positives/negatives (e.g., inside template literals or complex objects). If v1 proves too noisy, consider migrating this check to an AST-based approach (like a custom Biome rule or an ESLint plugin), which has deep contextual understanding of assertions.

2. **Git Hooks Override Warning (Component 4):**
   * *Suggestion:* The `hooks:install` script changes `core.hooksPath` to `.githooks`. It is worth noting in the CLI output or the documentation that this will override any existing hooks a developer might have manually placed in `.git/hooks`. It should ideally check if `core.hooksPath` is already set to something else and warn the user before overwriting.

3. **SonarQube Soft-Fail (Component 3):**
   * *Suggestion:* While changing SonarQube to `continue-on-error: true` solves the immediate infra-flake problem, it might result in the team ignoring SonarQube results entirely if the CI always shows a green checkmark. Consider adding a weekly Slack/huddle summary of SonarQube metrics so that code quality degradation isn't entirely ignored after the soft-fail is implemented.
