# Plan Review: Nimbus Launch Execution Implementation Plan

This document reviews [2026-07-28-launch-execution.md](./2026-07-28-launch-execution.md) and notes questions, suggestions, and improvements for the execution steps.

---

## 1. Safer Git Diff References in CI (`Decide smoke matrix`)

### Ambiguous reference risk on GHA runner

- **Observation:** Task 1, Step 2 proposes fetching changed files using `git diff --name-only "origin/${{ github.base_ref }}"...HEAD`.
- **Analysis:** Depending on how GitHub Actions configures the git refspec and branches during checkout (even with `fetch-depth: 0`), local tracking references for the remote base branch (like `origin/main` or `origin/develop`) are not always fully mapped or named consistently. This can cause git to fail with an `ambiguous argument` error.
- **Recommendation:** Use explicit SHA references provided directly by the GHA pull request payload, which are guaranteed to be populated and fetched.
  
  Replace:

  ```bash
  CHANGED=$(git diff --name-only "origin/${{ github.base_ref }}"...HEAD)
  ```

  With:

  ```bash
  CHANGED=$(git diff --name-only ${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }})
  ```

---

## 2. Sync Synchronicity Check in Onboarding Smoke Test

### Race condition risk on first index

- **Observation:** In Task 1, Steps 4 and 5, the quickstart smoke test executes `nimbus init`, followed immediately by `nimbus connector sync filesystem`, and then `nimbus why auth.ts:1`.
- **Question:** Does `nimbus connector sync filesystem` block synchronously until the sync has completed writing to the SQLite database?
  - If the sync command returns immediately while the gateway process indexes in the background, the subsequent `nimbus why` command will execute against an empty or incomplete index, causing the authorship grep asserts to fail.
- **Recommendation:**
  - Verify if `nimbus connector sync filesystem` blocks. If it is asynchronous, add a polling loop or wait command in the shell script to check the index status (e.g. via `nimbus status` or checking the SQLite database row count) before invoking `nimbus why`.

---

## 3. Expanding Outbound Call Heuristics for Third-Party SDKs

### False negatives in connector tiering

- **Observation:** Task 2, Step 3 uses a simple regex to classify outbound calls: `OUTBOUND_CALL = /\bfetch\w*\(|Bun\.spawn\(|execFile\(|spawnSync\(/;`.
- **Analysis:** Many database, cloud, and messaging connectors do not invoke raw `fetch` or subprocess commands. Instead, they instantiate client SDKs (e.g. `new Slack(...)`, `new pg.Client(...)`, `new CosmosClient(...)`, or `import` statements from cloud packages). These would be incorrectly flagged as not making outbound calls, placing them in `unknown` tier.
- **Recommendation:** Expand the `OUTBOUND_CALL` regex heuristic to recognize SDK instantiation and clients:
  
  ```ts
  const OUTBOUND_CALL = /\bfetch\w*\(|Bun\.spawn\(|execFile\(|spawnSync\(|new \w*(Client|Sdk|Service|Connection|Cluster|Hub)\(|createClient\(|require\(["'](pg|mysql2|redis|ioredis|amqplib|ssh2)["']\)|import\b.*?\bfrom\b.*?["'](pg|mysql2|redis|ioredis|amqplib|ssh2|@aws-sdk|@google-cloud|@azure|@slack|@microsoft)["']/;
  ```

---

## 4. Absolute Path and Config Directory Isolation for `nimbus doctor` Audit

### Explicit config path isolation

- **Observation:** Task 4, Step 1 sets `APPDATA` and `LOCALAPPDATA` to run `nimbus doctor` in a sandbox.
- **Question:** Does Nimbus configuration loading rely solely on these OS paths, or does it also respect `NIMBUS_CONFIG_DIR`?
- **Recommendation:** To guarantee no pollution from or to the user's real home config directory, explicitly export `NIMBUS_CONFIG_DIR` alongside the OS directories in the audit script sandbox:
  
  ```bash
  export NIMBUS_CONFIG_DIR="$SANDBOX/config"
  ```
