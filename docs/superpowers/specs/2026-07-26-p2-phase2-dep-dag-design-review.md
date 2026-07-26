# Design Review: P2 Phase 2 — dependency-DAG edges

This document reviews [2026-07-26-p2-phase2-dep-dag-design.md](./2026-07-26-p2-phase2-dep-dag-design.md) and notes questions, suggestions, and improvements.

---

## 1. Structure of `bun.lock` (JSON) and Resolution Parsing

### Observation
- The design proposes: `"resolvedFromBunLock(text, pkg)` collects every resolved version for the package and returns the lowest."
- In Bun v1.2+, `bun.lock` is a JSON file. However, it contains two distinct sections:
  1. The top section lists workspaces and their `dependencies` / `devDependencies` (which still contain semver ranges, e.g. `"@nimbus-dev/sdk": "^1.5.0"`).
  2. The bottom section contains flat dependency resolutions mapping package/dependency paths to arrays, where the first element is the exact pinned/resolved version (e.g., `"@nimbus/cli/@nimbus-dev/sdk": ["@nimbus-dev/sdk@1.5.0", ...]`).

### Suggestion
- The parsing logic for `resolvedFromBunLock` must explicitly target the **resolution keys** (the bottom section) rather than the `dependencies` keys of individual workspaces/packages in the top section.
- Parsing should scan keys or values matching the format `"<package-name>@<version>"` inside the array values at index 0 of the lockfile's resolution dictionary to extract the actual resolved semver version.

---

## 2. Robust PR Search Strategy for `hasOpenBumpPr`

### Observation
- The design checks: `hasOpenBumpPr(repo, pkg) -> gh pr list --state open --search`.

### Questions & Suggestions
- **Search Query Precision:** We need to define what the query looks for. If Dependabot or a developer opens a PR, the title/branch might not explicitly name the package in a uniform way (e.g., `Bump @nimbus-dev/sdk` vs `upgrade sdk to 1.6.0`).
- **Recommendation:** Define a clear, standard search pattern. For example:
  - Match PRs where the branch name or PR title contains the short name or full name of the package (e.g., `sdk` or `@nimbus-dev/sdk`).
  - Search both title and branch name: `gh pr list --repo <repo> --state open --json title,headRefName`. Then, do a case-insensitive match on both fields in memory to avoid query limitations.

---

## 3. Network Resilience and Timeout for npm Registry Queries

### Observation
- The reader `npmLatest(pkg)` makes an unauthenticated HTTPS request to `https://registry.npmjs.org/<pkg>`.

### Suggestion
- Registry requests can easily hang or slow down CI and local preflight runs if the registry is experiencing latency.
- We should enforce a strict timeout (e.g., 3–5 seconds) on the HTTP request. If the request times out or returns a non-200 status, it should fail-gracefully to `indeterminate` with a clear warning, rather than blocking the preflight command or throwing an unhandled exception.

---

## 4. Distinction Between Missing Dependencies and Manifest Errors

### Observation
- "Package present in the manifest but absent from a consumer's lockfile → `indeterminate`, not `ok`."

### Suggestion
- While returning `indeterminate` is safe, we should distinguish between "the lockfile couldn't be parsed/fetched" and "the lockfile parsed successfully but the package is not a dependency at all."
- If the lockfile is successfully parsed and does not contain the package, we should log a specific diagnostic: `"Manifest configuration error: <consumer-repo> does not depend on upstream package <pkg>"` so that the maintainer knows to update `release-train.json` rather than debugging lockfile/network issues.
