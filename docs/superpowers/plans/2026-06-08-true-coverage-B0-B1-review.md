# True Coverage Sub-project B0 & B1 Plan Review

**Date:** 2026-06-08
**Target:** [2026-06-08-true-coverage-B0-B1.md](./2026-06-08-true-coverage-B0-B1.md)

## Open Questions & Suggestions

1. **Exclusions Parity-Count Test (Task B0.1 Step 2)**
   * **Problem:** The plan states in Task B0.1 Step 2 and Step 4 that we must find and bump the parity-count test (`expect(EXCLUSIONS.length).toBe(...)`). However, a codebase search reveals **no such assertion** exists for `EXCLUSIONS.length`. There is a `check-exclusion-parity.ts` script checking Sonar/local parity, but no literal length check.
   * **Suggestion:** Remove Step 2 and Step 4 of Task B0.1 entirely from the implementation plan, as there is no static length expectation test that needs to be updated.

2. **Named Volume Lifecycle in `reseed-docker.sh`**
   * **Problem:** The `reseed-docker.sh` script relies on a persistent named Docker volume `nimbus-bun-cache` to avoid repeated package installations. If dependencies change or the cache gets corrupted, there's no easy way to clear it.
   * **Suggestion:** Add support for a `--clean` or `-c` flag in `reseed-docker.sh` to remove the named volume and recreate it for a completely fresh run.

     ```bash
     if [[ "${1:-}" == "--clean" || "${1:-}" == "-c" ]]; then
       echo "Cleaning named Docker volume ${CACHE_VOL}..."
       docker volume rm "${CACHE_VOL}" || true
     fi
     ```

3. **Windows Docker Path Mapping (MSYS/Git Bash Context)**
   * **Problem:** Running the streaming `tar` Docker command in `reseed-docker.sh` from Windows using Git Bash/MSYS can fail due to MSYS automatic path conversion trying to convert container-internal paths (like `/out` or `/src`).
   * **Suggestion:** Prepend the docker command or script execution instructions with `export MSYS_NO_PATHCONV=1` (or set it in the script) to ensure robust cross-platform execution on Windows developer setups.

4. **Co-Authorship Git Commit Hooks/Templates**
   * **Problem:** The commit messages specified in the plan include a hardcoded `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` tag.
   * **Suggestion:** Since the workspace is being operated on by different models (e.g. Gemini 3.5 Flash) or humans, change these hardcoded co-authorship tags to placeholders or remove them, allowing git config or the developer to handle attribution naturally.

## Alignment with Invariants

* **Platform Equality & PAL Exclusions:** Task B0.1 safely avoids excluding production platform/PAL files (e.g., `ipc-context.ts`), preserving the platform integrity constraints.
* **No `any` in tests:** The plan explicitly reinforces the strict TypeScript strict-mode rule (#7), ensuring type safety when writing the test cases.
