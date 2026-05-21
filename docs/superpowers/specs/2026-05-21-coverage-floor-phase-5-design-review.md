# Review: Coverage Floor Phase 5 Design

## Overall Impressions
The design is highly structured, comprehensive, and well-reasoned. The proposed commit sequence (low-risk to high-risk) is excellent for minimizing disruption and ensuring that progress on simpler coverage tasks isn't blocked by complex mocking scenarios. The explicit inclusion of "Risks" and "Mitigations" shows great foresight.

## Open Questions & Suggestions

### 1. Integration Test Coverage for `embedding/model.ts` (Commit 12)
**Question:** Does the `bun run audit:coverage-floor:build-lcov` command aggregate coverage from both unit and integration tests?
**Suggestion:** The plan suggests placing `model-isolated.test.ts` under `packages/gateway/test/integration/`. If the standard coverage scripts are configured to only run `test/unit/` (or if they run integration tests without coverage enabled to save CI time), the lines hit in `model.ts` will not be reflected in the final `lcov.info`. 
*Action:* Verify that the coverage merge step includes the integration test suite. If it doesn't, you may need to either update the coverage script or fall back to the "extract-and-exclude" refactor method.

### 2. TUI State Machine Tests in CI (Commit 10)
**Question:** Will `ink-testing-library` introduce flakiness in CI due to missing TTY environments?
**Suggestion:** TUI components and `ink` often rely on `process.stdout.isTTY` and terminal dimensions (e.g., `process.stdout.columns`). In headless CI environments, these are often undefined or false, leading to alternative render paths or crashes.
*Action:* Ensure the test setup explicitly mocks TTY properties and provides a fixed virtual terminal size to guarantee deterministic state transitions across local and CI runs.

### 3. Complexity of `install-from-local.ts` (Commit 11)
**Comment:** At 808 lines, `install-from-local.ts` is massive, and raising coverage by ~13% will require executing complex logic regarding `completeExtensionInstallAfterCopy` and signature validation.
**Suggestion:** If mocking the Vault, filesystem, and cryptography proves too unwieldy for a single commit, consider splitting Commit 11 into two smaller commits:
1. Error handling and early rejection paths.
2. The complex signature verification/mismatch paths.
This would make code reviews easier and limit the blast radius if one test approach needs to be rewritten.

### 4. Windows Named Pipes in `socket-listeners.ts` (Commit 9)
**Comment:** The mitigation section already correctly addresses the risk of Windows-specific named pipe behaviors.
**Suggestion:** If you end up having to split the file (extracting `win32-listener.ts` as a shim), don't forget to explicitly add the new shim to **both** `exclusions.ts` and `sonar-project.properties` so that the `audit:exclusion-parity` script doesn't fail.

### 5. Out-of-band Cleanup on Windows
**Comment:** The design mentions using `rm -rf` to clear stale Phase 4 worktrees due to the Windows "Filename too long" error.
**Suggestion:** Git Bash's `rm -rf` can sometimes still fail on deep node_modules hierarchies on Windows. 
*Action:* If `rm -rf` fails, you can recommend using Node's `rimraf` (if installed globally) or PowerShell's `Remove-Item -LiteralPath <path> -Recurse -Force` which handles the `\\?\` prefix for long paths much better.
