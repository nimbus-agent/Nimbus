# Review & Suggestions — Perf Strategy Phase 2: Bencher Design Spec

**Reviewer:** AI Coding Assistant (Antigravity)  
**Date:** 2026-06-16  
**Target Spec:** `2026-06-16-perf-phase2-bencher-design.md`

This document outlines feedback, architectural recommendations, and answers to open questions for the Perf Strategy Phase 2 Bencher Design Spec.

---

## 1. Feedback on Open Questions (§11)

### Q1. Check-only vs. Trend PR Comments on Pull Requests

* **Recommendation**: **Keep it check-only (`--ci-only-thresholds`) as currently designed.**
* **Rationale**:
  * Having a single, authoritative performance comment from `bench-ci.ts` is cleaner and prevents PR timeline pollution.
  * Adding a second comment from Bencher on every commit build is redundant and increases friction.
  * The Bencher report check (which links directly to the run dashboard) already provides clear, actionable visibility into trends directly from the GitHub Checks tab for developers who want to inspect regression history.

---

## 2. Gaps & Suggestions

### A. Fork PR Double-Guard Security

* **Issue**: In §8, the spec proposes skipping fork PRs using `if: github.event.pull_request.head.repo.full_name == github.repository` because fork runners cannot access the `BENCHER_API_KEY` secret.
* **Suggestion**:
  * Keep this guard explicitly. Additionally, ensure that the publish step has `continue-on-error: true`.
  * Double-check that `bencher run` handles missing/empty `--key` parameters gracefully when `continue-on-error: true` is enabled, ensuring it doesn't fail local developer testing environments where `BENCHER_API_KEY` is empty.

### B. Validation of Testbed Names across OS Matrices

* **Issue**: Bencher testbeds will be created dynamically as runs ingest.
* **Suggestion**: Establish a strict name mapping for the `--testbed` parameter in the CI workflow. The proposed naming `gha-ubuntu` / `gha-macos` / `gha-windows` must match the outputs from the custom runner ID resolution step in `_perf.yml` exactly (lines 142-148 in `_perf.yml` resolves to `gha-ubuntu`, `gha-macos`, `gha-windows`). The plan should confirm that the resolved runner ID is passed directly.

### C. Graceful Handling of Empty Ingests

* **Issue**: In §5.1, the spec defines `toBencherBmf` to skip any surface where `samples_count === 0` or metrics are missing. If an entire run fails to execute some benchmarks, the BMF could be empty or have fewer surfaces.
* **Verification**: In Bencher, submitting a BMF payload containing only a subset of benchmarks is fully supported and does not erase or fail the historical data for other benchmarks. This makes the advisory integration highly resilient.
