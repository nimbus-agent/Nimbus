# Plan Review: CI Feedback Loop Implementation

This document contains a plan review of the [2026-08-04-ci-feedback-loop.md](./2026-08-04-ci-feedback-loop.md) implementation plan, detailing open questions, suggestions, and potential improvements.

---

## 1. Open Questions

### 1.1 Running `apt-get` inside the Docker Runner on Every Invocation

In Task 6 (Step 1), the Docker runner executes:

```bash
apt-get update -qq && apt-get install -y -qq git libsecret-tools gnome-keyring dbus >/dev/null
```

* **The Question**: Since this command runs on every invocation of `bun run verify:docker`, how much latency does it add to the feedback loop?
* **Impact**: Running `apt-get update` and package installations on every container spin-up could add 15–30+ seconds depending on network conditions, making the "fast" feedback loop feel slow and discouraging developers from using it locally.
* **Suggestion**: Check if we can build/reuse a local Docker image cached with these packages, or verify if the duration is acceptable (e.g., if it only runs when a dependency is missing/changed, though `docker run --rm` destroys the container filesystem, so it will always run unless cached in a commit/image).

### 1.2 Path Normalization and Absolute Paths in TS Parser

In Task 3 (Step 3), the parser maps error paths:

```ts
const file = (m[1] ?? "").replaceAll("\\", "/").trim();
```

* **The Question**: If a developer or a specific shell executes `tsc` such that it outputs absolute paths (e.g., `C:/gitrep/Nimbus/packages/...`), how will the baseline compare them?
* **Impact**: If absolute paths are output in one environment and relative paths in another, the baseline comparison will fail because the keys will mismatch.
* **Suggestion**: Explicitly resolve and strip the workspace root directory from the file paths in `parse.ts` (e.g., replacing `${REPO_ROOT}/` with a blank string) to guarantee relative-only paths in the baseline.

---

## 2. Improvements & Suggestions

### 2.1 Biome JSONC Compatibility

In Task 1 (Step 2), the plan states:
> *"Add a comment immediately above it in the surrounding JSON is not possible (biome.json is strict JSON, not JSONC)"*

* **Correction/Improvement**: Biome natively parses JSONC (JSON with comments) for `biome.json` configuration files and actually preserves them. If the team prefers maintaining comments to explain glob patterns directly in the config file, we can add a comment above the `"!.claude"` line.

### 2.2 Graceful Error Handling for `gh` Execution in `verify-pr.ts`

In Task 7 (Step 3):

* **Improvement**: When executing `gh pr view` and `gh pr checks` via shell commands, ensure the code wraps the execution in a `try/catch` block and checks if the output is valid JSON before parsing. If the `gh` command outputs error text (e.g., rate limits, network timeouts, or GitHub outages), a generic `JSON.parse` call would throw a confusing stack trace. Wrapping it with a clean error message (e.g., `Failed to query GitHub status: <error>`) will improve usability.
