# SonarCloud — CI integration, Quality Gate policy, local analysis

SonarCloud (rebranded "SonarQube Cloud") provides static analysis, security hotspot detection, duplication metrics, and a Quality Gate that fails CI on regressions. This document covers:

1. How CI runs the scan today.
2. The Quality Gate policy this repository follows.
3. How to reproduce the analysis locally before opening a PR.

## CI integration

The scan runs inside the reusable [`_test-suite.yml`](../.github/workflows/_test-suite.yml) workflow, which is invoked by both `pr-quality-ts` (PRs) and `ci-ts` (pushes to `main` / `develop`) in [`ci.yml`](../.github/workflows/ci.yml). The relevant step:

```yaml
- name: SonarQube Cloud analysis        # uploads the analysis (advisory)
  if: runner.os == 'Linux' && env.SONAR_TOKEN != ''
  continue-on-error: true               # a scanner infra blip is not a build failure
  uses: SonarSource/sonarqube-scan-action@…  # SHA-pinned
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}

- name: SonarQube quality gate (enforced)   # THIS blocks the merge
  if: runner.os == 'Linux' && env.SONAR_TOKEN != ''
  # reads .scannerwork/report-task.txt → polls the CE task → queries
  # api/qualitygates/project_status, then exits 1 on a gate verdict of ERROR.
```

Coverage is fed in from two sources, both produced earlier in the same job:

- `coverage/lcov.info` — written by `bun test --coverage --coverage-reporter=lcov` for `gateway`, `cli`, `mcp-connectors`, and `scripts`.
- `packages/ui/coverage/lcov.info` — written by `bunx vitest run --coverage`. The job rewrites `SF:src/` → `SF:packages/ui/src/` so SonarCloud resolves paths from the repo root rather than the UI sub-project root.

`sonar.qualitygate.wait=true` in [`sonar-project.properties`](../sonar-project.properties) forces the scanner to wait for the Compute Engine task and gate verdict to be computed before the job moves on. The scan-upload step itself is `continue-on-error: true` (a scanner network/infra failure should be a rerun, not a hard block); the **`SonarQube quality gate (enforced)`** step that follows is what actually fails the build. It reads the analysis the scan produced, queries the `api/qualitygates/project_status` Web API, and:

- **fails the job** (`exit 1`) on a definitive gate verdict of `ERROR` — this is what blocks a PR that introduces a new bug / vulnerability / unreviewed security hotspot / sub-80%-coverage new code;
- **passes** on `OK`;
- **warns and passes** (fail-open) when the scan produced no report, the CE task failed, or the verdict is indeterminate — so genuine scanner infra failures don't block contributors.

Because the step lives inside the `unit` job of `_test-suite.yml`, its failure fails the `pr-quality-ts` check (and `ci-ts` on push) directly — no separate required-check name to wire into branch rulesets.

The scan is Linux-only on purpose; Sonar's analyser is OS-agnostic and running it three times across the OS matrix is wasted CI minutes.

## Quality Gate policy

The project uses SonarCloud's built-in **"Sonar way"** Quality Gate. We do not maintain a custom gate.

### Why "Sonar way" and not a custom gate

SonarSource moved custom Quality Gates behind the paid **Team** and **Enterprise** plans in 2026; the free plan for public OSS projects is locked to the default gate. The project is correctly flagged Public on SonarCloud (`visibility: "public"` confirmed via the components API), so scans run for free with unlimited LOC — but the gate itself is the built-in one.

This is acceptable because:

- **The "Sonar way" *On New Code* conditions match what we'd have written ourselves**: 0 new bugs, 0 new vulnerabilities, all new security hotspots reviewed, ≥80% coverage on new code, ≤3% duplication on new code, and A ratings (security / reliability / maintainability / security review) on new code.
- **Project-level enforcement is covered elsewhere in the repo.** What "Sonar way" does *not* enforce — overall security/reliability ratings staying at A across the whole project, and 100% triage of legacy security hotspots — is covered by:
  - [CodeQL](../.github/workflows/codeql.yml) for security analysis (semantic, not heuristic — generally stronger than Sonar's hotspot detection).
  - [`packages/gateway/src/security-invariants.test.ts`](../packages/gateway/src/security-invariants.test.ts) for runtime enforcement of every `I<N>` invariant in [`docs/SECURITY-INVARIANTS.md`](./SECURITY-INVARIANTS.md).
  - [`scripts/structure-audit/`](../scripts/structure-audit/) for static-time enforcement of I1 (spawn rule) and the vault-key allow-list.
  - The 22 per-subsystem coverage gates in [`package.json`](../package.json) (e.g. `test:coverage:engine` ≥85%, `test:coverage:vault` ≥90%) — stricter than Sonar's 80% default on every security-critical subsystem.

So Sonar's role is: maintainability rating, cognitive-complexity tracking, code-smell detection beyond Biome's rule set, and the unified PR comment. Security and coverage have stronger primary defenses elsewhere.

### Gate conditions (reference)

The "Sonar way" defaults are server-controlled and may be tuned by SonarSource over time. As of writing:

| Scope | Metric | Threshold |
|---|---|---|
| **On New Code** | Coverage | ≥ 80% |
| **On New Code** | Duplicated Lines (%) | ≤ 3% |
| **On New Code** | Maintainability Rating | A |
| **On New Code** | Reliability Rating | A |
| **On New Code** | Security Rating | A |
| **On New Code** | Security Review Rating | A |
| **On New Code** | Security Hotspots Reviewed | 100% |

If you need to upgrade beyond these thresholds (for example, to align Sonar's coverage threshold with the engine's 85% gate), the only path on the free plan is to enforce the stricter threshold elsewhere in CI — typically by tightening the matching `bun test --coverage-threshold-lines=…` invocation in `package.json`. Don't add a custom gate; it will trip the SonarCloud paywall.

### Required repo secrets

| Secret | Purpose |
|---|---|
| `SONAR_TOKEN` | SonarCloud user token on `asafgolombek_Nimbus`. Needs at minimum **Execute Analysis**; needs **Administer Project** to allow CI to keep Automatic Analysis disabled (see below). The scan step is conditional on this being set, so absence silently no-ops rather than failing CI. |

### Automatic Analysis must stay disabled

SonarCloud refuses to accept CI-driven analysis when **Automatic Analysis** is *also* enabled on the project — the scan exits 3 with `You are running CI analysis while Automatic Analysis is enabled. Please consider disabling one or the other.`. This repo's source of truth is the CI scan (it carries the `sonar.qualitygate.wait=true` gate, the rewritten UI LCOV paths, and the per-PR diff context), so autoscan must stay off.

`_test-suite.yml` includes a pre-scan step that calls `POST /api/autoscan/activation?projectKey=asafgolombek_Nimbus&enabled=false` on every run. The call is idempotent (200/204 on first toggle, 400 on every subsequent run) and runs with the existing `SONAR_TOKEN`. The step is **fail-open**:

- If the token has **Administer Project**: autoscan is forced off on every run; you never have to think about this again.
- If the token only has **Execute Analysis**: the API call returns 403 and the step logs a warning. You must then disable autoscan **once, manually** in **SonarCloud → Project → Administration → Analysis Method → "GitHub Actions"**. After that the scan keeps working with the lower-scoped token.

The fail-open shape is deliberate. If we hard-failed on 403, fork PRs and contributors with a read-only token would be blocked by a setup task that has nothing to do with their change. With fail-open, the scan step below surfaces the original "Automatic Analysis enabled" error with a clearer remediation path the first time, and silently succeeds once the operator has flipped the toggle.

## Local analysis — SonarLint (recommended)

1. Install the [SonarLint](https://www.sonarsource.com/products/sonarlint/) extension in VS Code or Cursor.
2. Open **Connected Mode** and bind the workspace to your SonarCloud project (`projectKey=asafgolombek_Nimbus`).
3. Fix issues SonarLint reports on the files you change; this aligns with the *On New Code* conditions of "Sonar way".

## Local analysis — SonarScanner CLI

For reproducing a full scan before pushing (e.g. when CI is unavailable, or to debug a gate failure that's hard to triage from the SonarCloud UI alone):

1. Install a JRE and the [SonarScanner CLI](https://docs.sonarsource.com/sonarqube-cloud/).
2. Generate a token (**My Account** → **Security**) and export it:

   ```bash
   export SONAR_TOKEN=your_token_here
   ```

3. Generate coverage so the scanner finds an `lcov.info`:

   ```bash
   bun test packages/gateway packages/cli packages/mcp-connectors scripts \
     --coverage --coverage-reporter=lcov
   cd packages/ui && bunx vitest run --coverage && cd -
   sed -i 's|^SF:src/|SF:packages/ui/src/|' packages/ui/coverage/lcov.info
   ```

4. Run the scanner from the repo root:

   ```bash
   sonar-scanner
   ```

   For a PR scan (so the gate evaluates against New Code rather than the whole project), pass [PR parameters](https://docs.sonarsource.com/sonarqube-cloud/enriching/branch-analysis/):

   ```bash
   sonar-scanner \
     -Dsonar.pullrequest.key=123 \
     -Dsonar.pullrequest.branch=my-branch \
     -Dsonar.pullrequest.base=main
   ```

## Notes

- Adjust `sonar.sources`, `sonar.tests`, or `sonar.typescript.tsconfigPaths` in [`sonar-project.properties`](../sonar-project.properties) if SonarCloud reports missing files or wrong TypeScript context.
- Do not commit Sonar tokens; use environment variables locally and the `SONAR_TOKEN` repo secret in CI.
- The exclusions block in `sonar-project.properties` deliberately drops `**/dist/**`, `**/src-tauri/**`, generated `nimbus-*.js` bundles, and the Astro docs site. Add new entries there — not in any UI gate definition — when introducing generated or vendored code.
