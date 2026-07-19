# Review: npm Supply-Chain Assurance Implementation Plan

This review evaluates the implementation plan defined in [2026-07-19-npm-supply-chain-assurance.md](./2026-07-19-npm-supply-chain-assurance.md) against the design goals, safety constraints, and potential edge cases.

---

## Open Questions & Suggestions

### 1. Handling Transient JSON Parsing Errors in Fetcher (Task A2)

* **Observation:** In `fetch-attestations.js`, if `res.status === 200` but `await res.json()` throws a parsing error (e.g., due to a truncated response body, CDN packet loss, or an HTML proxy error page returning 200), the function immediately returns `{ outcome: "error", ... }` without retrying.
* **Risk:** A transient error mid-stream on a large response could cause a release gate to fail immediately instead of retrying.
* **Suggestion:** Catch the JSON parsing error *inside* the retry loop and treat it as a transient error (updating `lastDetail = "JSON parsing error"` and letting the loop continue) rather than returning immediately.

  ```js
  // Current:
  try {
    return { outcome: "body", body: await res.json(), detail: "200" };
  } catch {
    return { outcome: "error", detail: "200 with unparseable JSON body" };
  }

  // Suggested:
  try {
    const body = await res.json();
    return { outcome: "body", body, detail: "200" };
  } catch {
    lastDetail = "200 with unparseable JSON body";
    continue;
  }
  ```

### 2. Version Pinning for CLI Tools in `probe-publish-token` (Task A4)

* **Observation:** The `probe-publish-token` action uses `npx --yes @vscode/vsce` and `npx --yes ovsx`. By default, omitting a version specifier pulls the `@latest` tag from npm.
* **Risk:**
  1. A malicious package release or supply-chain compromise of `@vscode/vsce` or `ovsx` on the public registry could lead to code execution in our runners.
  2. Unannounced breaking changes in the CLI tools' command flags (specifically `verify-pat`) could cause the health check to break.
* **Suggestion:** Pin these tools to a specific major version (e.g., `npx --yes @vscode/vsce@^3.0.0` or `npx --yes ovsx@^0.9.0`) to ensure reliability and minimize supply-chain risk.

### 3. Registry/Network Failures During Token Probing (Task A4)

* **Observation:** The `probe-publish-token` script uses `set +e` and evaluates the exit code of the `vsce`/`ovsx` verify command. If the command fails for *any* reason (including npm registry downtime, a network timeout, or an API rate limit from the marketplace), `code` will be non-zero, resulting in `status=dead`.
* **Risk:** The weekly monitor workflow will interpret a transient network/registry failure as a revoked/expired token and file a false-alarm critical issue.
* **Suggestion:** Consider whether the script can parse the error or check if it's a CLI execution error versus a 401/Unauthorized token error. Alternatively, document in the runbook that a `dead` alert should first be cross-checked against registry/marketplace status pages.

### 4. Portability of `sort -V` in Preflight Check (Task C1)

* **Observation:** The preflight check uses `sort -V` to perform a semantic version comparison:

  ```bash
  if [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -n1)" != "$need" ]; then
  ```

* **Verification:** `sort -V` is a GNU coreutils extension. It is guaranteed to be available on Ubuntu/Debian runners (e.g., `ubuntu-24.04`).
* **Caution:** If the satellite workflows are ever run on macOS runners (which use BSD `sort` by default, where `-V` is not supported unless `gsort` is installed), this step will fail.
* **Suggestion:** Since the satellites (`nimbus-sdk`, `nimbus-client`) currently build on Ubuntu runners, `sort -V` is safe. However, adding a comment indicating this Ubuntu dependency is recommended to prevent future migration issues to macOS runners.

### 5. `GITHUB_OUTPUT` Deprecation and Node APIs

* **Observation:** In `main.js` (Task A3), output variables are written using `appendFileSync(process.env["GITHUB_OUTPUT"], ...)`.
* **Safety:** Ensure `process.env["GITHUB_OUTPUT"]` is defined before appending, which the current implementation handles via `if (out)`. This is robust and prevents failures when running the script locally or in tests where the variable is not set.

---

## Resolutions

Recorded 2026-07-19 against plan revision 2. Four findings accepted (two of them hardened beyond the suggestion); one required no change.

### 1. Retry on unparseable JSON — **ACCEPTED**

Correct: a 200 carrying an HTML proxy error page or a truncated body is transient, and returning immediately would fail a release on one bad CDN edge response. The parse failure now sets `lastDetail` and continues the loop, exactly as suggested.

Two tests were added rather than one, because the fix has two observable behaviours worth pinning: that a persistently-bad body **retries the full schedule** before reporting `error` (asserting the call count, not just the outcome), and that a single bad response **followed by a good one succeeds**. The existing "never a false absent" assertion is preserved — `lastDetail` is not the 404 sentinel, so the outcome stays `error` rather than degrading to `absent`.

### 2. Version pinning for the vendor CLIs — **ACCEPTED, and tightened**

The right call, and it matters more than the review states: this action passes a **live publish credential** into whatever `npx` resolves. Unpinned third-party code inside a credential's trust boundary would undercut the premise of a supply-chain program.

For that reason the suggested `^` ranges were **not** used — a caret range still floats to the newest match and provides no protection against a malicious release. Pins are **exact**: `@vscode/vsce@3.9.2` and `ovsx@1.0.2` (current versions, checked against the registry today). The verification step in Task A4 now checks the pinned versions rather than `@latest`, and explicitly instructs the implementer not to float the pin if a newer version has shipped — bumping is a deliberate, reviewed change.

Accepted trade-off, recorded so it is not a surprise later: these pins live in a shell command, not a manifest, so Dependabot will not bump them. They will go stale. That is preferable to a floating dependency holding a publish token, and PAT-adjacent maintenance belongs on sub-project 4's rotation calendar.

### 3. Network failure misreported as a dead token — **ACCEPTED; this was a real defect I introduced**

Not merely a refinement. The design specified a three-way classification (`ok` / `dead` / `indeterminate`), and `indeterminate` was silently lost when the probe switched from hand-rolled HTTP to the vendor `verify-pat` CLIs — exit codes flattened three states into two. The review caught a genuine regression against the spec.

The consequence was worse than a missed signal: a weekly job filing a **critical revocation alert** every time the marketplace had a blip would train the operator to ignore the alarm, defeating the monitor's entire purpose.

Fixed on both sides, since fixing only the action would have achieved nothing:

* **Action:** on a non-zero exit, probe a public unauthenticated endpoint (`marketplace.visualstudio.com` / `open-vsx.org/api/-/search`). Reachable → `dead` (the service genuinely rejected the token). Unreachable → `indeterminate`.
* **Consumer:** `nimbus-vscode`'s workflow now mirrors the monorepo's warn/hard split — only `dead` files an issue and fails; `indeterminate` emits a `::warning::` and exits 0.

The runbook cross-check the review suggested is also included, in the issue body and in Task D1's interpretation table.

### 4. `sort -V` portability — **ACCEPTED as documentation**

The review's own verification is right: `sort -V` is a GNU coreutils extension, guaranteed on `ubuntu-24.04`, which is where both satellites run. No functional change was warranted. A comment now records the Ubuntu dependency and names the remedy (`gsort` or a Node one-liner) should the job ever move to a macOS runner — the failure would otherwise be baffling at migration time.

### 5. `GITHUB_OUTPUT` guard — **NO CHANGE REQUIRED**

Not a finding; the review confirms the existing `if (out)` guard is correct. It is what lets `main.js` run in the Task A3 Step 6 local smoke test, where `GITHUB_OUTPUT` is unset. Left as is.

### Scope note

Findings 1 and 3 both moved a failure mode from *false-negative* to *inconclusive*. That is the correct direction for this system: a monitor that cries wolf is worse than one that occasionally says "I don't know", because only the second preserves the operator's trust in the alert.

## Conclusion

The plan is extremely thorough, aligns perfectly with the security invariants (especially **Non-Negotiable 3** regarding credentials isolation and non-disclosure), and leverages the proven monitoring patterns already established in the codebase. Implementing the above refinements will further harden the assurance mechanism against transient network/registry noise.
