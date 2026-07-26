# Design Review: P2 — Release Train Design

This document reviews [2026-07-24-p2-release-train-design.md](./2026-07-24-p2-release-train-design.md) and notes questions, suggestions, and improvements.

---

## 1. Rate Limiting on Public GitHub API Calls

### Observation

- The design notes that "Every source read is public... So this gate needs no App token: `github.token` in CI, the developer's `gh` locally."

### Suggestion

- Even though the channels and repositories are public, GitHub enforces strict rate limits for unauthenticated requests, and even for default authenticated tokens when executing multiple sequential calls (e.g., fetching contents across several repos, searching PRs in high-traffic repos like `microsoft/winget-pkgs`).
- The script should explicitly support reading `process.env.GITHUB_TOKEN` or `process.env.GH_TOKEN` when run locally, and handle `403 Rate Limit Exceeded` exit statuses as `indeterminate` (with warning) rather than letting the command crash or report `stale`.

---

## 2. High-Traffic Search Reliability for Winget PRs

### Observation

- The winget channel is marked as "caught-up" if the version directory exists in `microsoft/winget-pkgs` OR an open PR exists.
- This is checked via: `gh pr list --repo microsoft/winget-pkgs --search "…NimbusAgent.Nimbus …<published>"`.

### Questions & Suggestions

- **API Search Index Latency:** Newly opened PRs on GitHub are not immediately indexed by the search backend. There can be a delay of several minutes.
- **Search Query Precision:** `microsoft/winget-pkgs` is one of the highest-traffic repositories on GitHub. A loose search query can easily hit limitations or match unrelated PRs if not carefully scoped. We should explicitly specify the exact search query format in the script (e.g., `is:pr is:open repo:microsoft/winget-pkgs head:NimbusAgent.Nimbus` or matching the exact title format).
- **Closed/Failed PRs:** If a winget PR is opened but fails validation and is closed/declined by the Microsoft validation system (or a maintainer), it will no longer match the "open PR" filter and the version directory won't exist. In this case, the gate will correctly transition to **RED** (stale). This is a strong benefit of this design and should be highlighted.

---

## 3. Apt Packages File Compression (`Packages.gz` / `Packages.xz`)

### Observation

- The linux channel reads from `apt/dists/stable/main/binary-amd64/Packages` via a regex pattern.

### Suggestion

- Many debian/apt repositories optimize bandwidth by only serving compressed Package lists (e.g., `Packages.gz` or `Packages.xz`), sometimes leaving the uncompressed `Packages` file absent or outdated.
- We should verify whether `nimbus-agent/linux-repo` guarantees the presence of the uncompressed `Packages` file. If not, the reader should support requesting `Packages.gz` and decompressing it in-memory using Bun's native decompression utilities (e.g., `Bun.gunzip`).

---

## 4. Phase 2 Semver Range Compatibility in `package.json`

### Observation

- Phase 2 proposes downstream dependency edges: "reader parses `dependencies['@nimbus-dev/...']`, strips the range, and compares to the published version."

### Questions & Suggestions

- **Stale vs Compatible Ranges:** If a downstream repo specifies a dependency version range (e.g., `^1.2.0`), and the upstream package publishes version `1.3.0`, stripping the range results in comparing `1.2.0` to `1.3.0` which flags it as stale. However, standard package managers (`npm`/`bun`) might resolve it to `1.3.0` upon lockfile generation.
- **Lockfile-based Verification:** Rather than checking `package.json` and stripping the semver prefix, the dependency check should inspect the lockfile (e.g., `bun.lock` or `package-lock.json`) where the *actual* resolved version is locked down. This guarantees we check the real code running in production.

---

## 5. Grace Period Timezone Robustness

### Observation

- A release/bump-commit is checked only once its age exceeds `graceHours` (default 6h).

### Suggestion

- Ensure all timestamp comparisons convert GitHub's ISO-8601 datetime values (e.g. `2026-07-24T18:53:46Z`) and local system times to UTC epoch milliseconds before calculating differences. Relying on local system timezone parsing can cause false-positives when developer machines have offset clocks.
