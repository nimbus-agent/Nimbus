# Review & Suggestions — Hybrid Perf Strategy Design Spec

**Reviewer:** AI Coding Assistant (Antigravity)  
**Date:** 2026-06-14  
**Target Spec:** `2026-06-14-hybrid-perf-strategy-design.md`

This document details feedback, open questions, and recommended improvements for the Hybrid Perf Strategy Design Spec.

---

## 1. Feedback on Open Questions (§10)

### Q1. Drop `gha-ubuntu` gating of spawn-latency?

* **Recommendation**: **Yes, drop it.**
* **Rationale**: Shared VM runners (like GHA Ubuntu) have unpredictable CPU scaling, neighborhood noise, and IO throttle limits. Gating on them results in false alerts. Restricting gating to the nightly consistent hardware (M1 Air reference run) ensures that failing checks are actionable, while GHA runs serve purely for trending.

### Q2. `perf-data` orphan branch vs. Astro docs site?

* **Recommendation**: **Use the `perf-data` orphan branch.**
* **Rationale**: Separating the data branch from the main branch prevents commit history bloat on `main` and keeps Astro documentation build cycles fast and decoupled from performance trend updates.

### Q3. Keep the existing in-PR perf comment?

* **Recommendation**: **Yes, keep a highly condensed version.**
* **Rationale**: Developers rarely click external dashboard links unless they see a quick PR summary indicator (e.g., a simple status table showing `gate`-class surfaces). The comment should summarize `gate`-class items and link to the `/dev/bench` chart for the detailed `trend`-class view.

### Q4. Field name `gateClass` acceptable?

* **Recommendation**: **Acceptable, but `gatingStrategy` or `evalMode` is more descriptive.**
* **Rationale**: `gateClass` could be confused with a class constructor in TypeScript. A name like `gatingStrategy: "gate" | "trend" | "reference"` or `evalMode` makes the intent clearer.

---

## 2. Gaps & Suggestions

### A. Mitigating Outlier Runs in Flattened p95

* **Issue**: In §4.2, it is proposed to flatten all raw samples across runs and compute a single p95. If a single run experiences catastrophic runner contention (e.g., disk thrashing or network hang), all samples in that run will spike, skewing the overall p95 even if the other 4 runs were clean.
* **Suggestion**: Introduce an outlier run exclusion strategy. For instance, run 5 iterations, discard the single run with the worst median/average latency, and flatten the remaining 4 runs to compute the p95. This prevents single-run catastrophic contention from failing the gate.

### B. Defining the "Noise Floor" for the Drift Detector

* **Issue**: In §4.4, the drift check uses `> the surface's own noise floor`.
* **Question**: How is this noise floor defined and stored? Is it a static config map in `slo-thresholds.ts` or calculated dynamically?
* **Suggestion**: If static, specify it as a property next to `gateClass` (e.g., `noiseFloorPercentage: number` or `noiseFloorMs: number`). If dynamic, define the window statistics (e.g., standard deviation over the last 15 runs).

### C. `perf-data` Size Bloat

* **Issue**: `github-action-benchmark` appends data to a JSON history file. Over months of high-velocity commits, the history file will grow to megabytes, slowing down Git checkouts of that orphan branch.
* **Suggestion**: Implement history truncation or specify a retention window (e.g., keep the last 30 days of high-resolution runs, archiving older ones or down-sampling them).
