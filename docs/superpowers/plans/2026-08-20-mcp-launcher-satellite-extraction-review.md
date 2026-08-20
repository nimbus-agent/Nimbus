# Review: MCP Launcher Satellite Extraction Implementation Plan

This document contains feedback, suggestions, improvements, and open questions on the implementation plan detailed in [`2026-08-20-mcp-launcher-satellite-extraction.md`](./2026-08-20-mcp-launcher-satellite-extraction.md).

---

## 1. Suggestions & Improvements

### A. Tighten the Drift Guard Window (CI integration vs. scheduled drift sweep)

* **Problem:** As noted in the plan's self-review, running the installer-contract drift check only on the scheduled sweep leaves a window where a breaking change to the installer paths could be merged on `main` before the check runs.
* **Improvement:** Instead of waiting for a scheduled sweep or cloning the satellite repo on every PR, the monorepo's PR quality workflow (`pr-quality.yml` / unit-tests) can fetch the remote `installer-contract.ts` from `nimbus-agent/nimbus-mcp` using `fetch`/`curl` directly in the test runner, or run the audit script by curling the raw file from GitHub user content:

  ```ts
  const remoteUrl = "https://raw.githubusercontent.com/nimbus-agent/nimbus-mcp/main/src/installer-contract.ts";

  ```

  This is extremely fast, avoids git clone overhead, and allows us to run `audit:launcher-contract` on every monorepo PR (or when installer paths change) rather than asynchronously on a schedule.

### B. First-Publish Scoped Package Access

* **Problem:** `@nimbus-dev/mcp` is a scoped package. By default, npm treats new scoped packages as private (restricted access). Since we want this package to be public for the registry, the initial publish through the CI workflow or manually needs to specify public access.
* **Improvement:** In the publish workflow or initial step, ensure that the npm publish command includes `--access public`, or ensure that the package is configured with `"publishConfig": { "access": "public" }` in its `package.json` to prevent the initial OIDC publish from failing with a payment/private package error.

### C. Commit Author / Co-Author Attribution

* **Problem:** The plan templates commits with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
* **Suggestion:** Since the actual developer or agent executing the tasks might differ, we should ensure the co-author attribution is updated dynamically or omitted if not relevant to the final committer.

---

## 2. Open Questions

1. **Has the npm organization `@nimbus-dev` already configured OIDC access rules?**

   * Before Task 4 runs, the organization owner must ensure that the GitHub Actions OIDC trust relationship is set up for the new repository `nimbus-agent/nimbus-mcp`. If this requires admin permissions on the npm organization, is the current user/operator equipped with the appropriate credentials to do this manually in Step 3?
2. **Will the MCP Registry listing require a specific `server.json` entry?**

   * Task 5 mentions confirming if `server.json` is required. It would be helpful to research standard MCP registry listings beforehand to see if we should prep it during Task 2.
