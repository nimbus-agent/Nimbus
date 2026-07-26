# Design Review: P2 Phase 2 — dependency-DAG edges Implementation Plan

This document reviews [2026-07-26-p2-phase2-dep-dag.md](./2026-07-26-p2-phase2-dep-dag.md) and notes questions, suggestions, and improvements.

---

## 1. JSONC Parsing / Trailing Commas Regex Limitations

### Observation

- In `resolvedFromBunLock`, the text replacement `text.replace(/,(\s*[}\]])/g, "$1")` is used to clean trailing commas before calling `JSON.parse`.

### Suggestion

- While this regex works for standard `bun.lock` files, a regex replacement of `,(\s*[}\]])` could potentially match and corrupt comma-containing strings that end with a brace or bracket inside a JSON string value (e.g. `"description": "Includes a comma, }"`).
- Since Bun has a built-in JSONC parser or YAML reader, or we are running in Bun, we could evaluate whether using a more robust parser or wrapping the `JSON.parse` in a helper that handles basic JSONC features is safer.
- At a minimum, document this limitation in a comment near the regex to ensure future maintainers understand the edge case.

---

## 2. PR List Limits (`--limit 100`)

### Observation

- `readBumpPrOpen` fetches PRs via `gh pr list --state open --limit 100`.

### Suggestion

- For high-traffic or busy repositories, 100 PRs might occasionally prune out older in-flight bump PRs.
- While the Nimbus satellite repositories are unlikely to have over 100 concurrently open PRs, it is good practice to ensure the query is optimized. Alternatively, adding a search query term like `gh pr list --search "bump"` or matching the package name directly via GitHub API filter can reduce payload size and guarantee the target PR is found without hitting pagination limits.

---

## 3. Grace Period Timezones Consistency

### Observation

- The design matches timestamps but does not explicitly specify timezone alignment.

### Suggestion

- Ensure all comparisons in `ageHours` coerce both local and retrieved times explicitly into UTC epoch milliseconds (using `.getTime()`) to avoid timezone offset discrepancies between the developer machine and CI environments.
