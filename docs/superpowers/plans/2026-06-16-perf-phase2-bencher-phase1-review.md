# Review & Suggestions — Perf Phase 2 (Bencher) Implementation Plan

**Reviewer:** AI Coding Assistant (Antigravity)  
**Date:** 2026-06-16  
**Target Plan:** `2026-06-16-perf-phase2-bencher-phase1.md`

This document details feedback, verification points, and small improvements for the Perf Phase 2 (Bencher) Implementation Plan.

---

## 1. Plan Verification & Detail Check

### A. Idempotency of Output Empty-Check

* **Observation**: In Task 3 (Step 3) and Task 4 (Step 2), the plan uses `jq 'length'` to parse the output JSON from `scripts/perf/emit-bencher-bmf.ts` and set a steps-output parameter:

  ```bash
  surfaces="$(jq 'length' "${RUNNER_TEMP}/bencher.json")"
  echo "surfaces=${surfaces}" >> "$GITHUB_OUTPUT"
  ```

  The publish steps check `steps.bencher-emit.outputs.surfaces != '0'`.
* **Impact**: This is a robust check. In the case where `toBencherBmf` generates an empty report `{}` due to no surfaces matching the `trend` criteria with valid values, `jq 'length'` correctly returns `0`, preventing empty payloads from being submitted to Bencher Cloud and avoiding potential API errors.

### B. Shell Portability (`shell: bash`)

* **Observation**: The `Publish to Bencher` steps in Task 3 and Task 4 utilize Bash array syntax:

  ```bash
  common=(
    --project nimbus
    --key "${BENCHER_API_KEY}"
    ...
  )
  ```

* **Impact**: GHA Windows runners default to PowerShell/Cmd unless `shell: bash` is explicitly defined. Specifying `shell: bash` ensures Git Bash is used on Windows runners, guaranteeing that the Bash array declaration and expansion syntax `"${common[@]}"` works seamlessly across Ubuntu, macOS, and Windows legs of the matrix.

---

## 2. Gaps & Minor Suggestions

### A. Action SHA Pinned tag placeholder

* **Detail**: The plan lists:
  `uses: bencherdev/bencher@<sha> # <tag>`
* **Suggestion**: At execution time, the worker should make sure to follow the tag resolution instruction (`gh api ...`) to resolve the latest stable release SHA and tag, ensuring compliance with the repository's Scorecard pin policy.
