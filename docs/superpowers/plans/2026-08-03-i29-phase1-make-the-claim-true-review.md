# Design Review: I29 Phase 1 — Make the Claim True Implementation Plan

This document contains a design review of the [2026-08-03-i29-phase1-make-the-claim-true.md](./2026-08-03-i29-phase1-make-the-claim-true.md) implementation plan, detailing open questions, suggestions, and potential improvements.

---

## 1. Open Questions & Critical Gaps

### 1.1. Missing Startup Wiring in `assemble.ts`

* **The Gap**: The plan's "File Structure" table states that `packages/gateway/src/platform/assemble.ts` will "Append the boot marker at startup." However, **there is no step in Task 3 (or any other task) that instructs the agent to modify `assemble.ts`** to append this boot marker when the gateway starts. Without this, the boot marker will never be recorded in production, causing all verification windows to report as `indeterminate`.
* **Suggestion**: Add a new step to Task 3 to import `appendBootMarker` and `THIS_BINARY_COVERAGE` into `packages/gateway/src/platform/assemble.ts`, and call `appendBootMarker(db, THIS_BINARY_COVERAGE, Date.now())` immediately after the gateway SQLite database `db` is opened (near line 1702).

### 1.2. File Modification Header Inconsistency in Task 1

* **The Issue**: Task 1 lists `packages/gateway/src/egress/egress-ledger.ts` as a modified file under its **Files** header for narrowing `EgressEntry.sourceType`. However, the `EgressEntry` interface is defined in `packages/gateway/src/egress/egress-record.ts` (as correctly stated in Step 5 and the Git commit commands).
* **Suggestion**: Correct the **Files** list at the beginning of Task 1 to replace `packages/gateway/src/egress/egress-ledger.ts` with `packages/gateway/src/egress/egress-record.ts` to keep the plan's header aligned with the actual steps.

---

## 2. Improvements & Suggestions

### 2.1. Narrowing `EgressRowHashInput` Typings

* **Improvement**: In `packages/gateway/src/egress/egress-ledger.ts`, the interface `EgressRowHashInput` currently defines `sourceType` as a raw `string`:

  ```ts
  export interface EgressRowHashInput {
    readonly prevHash: string;
    readonly timestamp: number;
    readonly sourceType: string; // <-- Currently string
    // ...
  }
  ```

  To enforce full static type safety at the hash computation boundary, narrow this to `EgressSourceType`.

### 2.2. Handling Malformed Boot Markers in `coverageForWindow`

* **Improvement**: In Task 3, `coverageForWindow` skips rows with unparseable/corrupted coverage strings (treating them as if no boot marker was present). However, a boot marker with a corrupted or unrecognized coverage vector suggests database tampering or a version mismatch.
* **Suggestion**: If `parseCoverage` fails on a `boot` marker's `sourceId`, it should either throw an integrity exception (fail-closed) or force the entire window to be flagged as `indeterminate: true` rather than silently ignoring the marker.
