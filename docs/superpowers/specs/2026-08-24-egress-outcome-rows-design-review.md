# Design Review: Outcome Rows on the Egress Ledger (U3)

**Date:** 2026-08-24
**Status:** Design Review / Feedback
**Target Spec:** [2026-08-24-egress-outcome-rows-design.md](./2026-08-24-egress-outcome-rows-design.md)

---

## 1. Summary of Feedback

The proposed design for recording targeted fetch outcomes on the egress ledger is well-reasoned and solves the gap of unrecorded outcomes (C4.1) cleanly. Reusing the existing `TargetedFetchOutcome` vocabulary, defining `outcome` as a member of `MARKER_SOURCE_TYPES` to avoid double-counting, and correlating outcomes using the authorising row's `row_hash` in `source_id` are excellent architectural choices.

This review presents specific suggestions and points to verify during implementation.

---

## 2. Detailed Feedback & Open Questions

### Q1. API/Client Join Efficiency

Under the proposed design, the Activity page on the client side (`nimbus-web-clipper`) needs to join authorising rows with their corresponding `outcome` rows.

* **Concerns:**
  * If a client fetches a page of egress logs (via `GET /v1/egress`), it will receive both the authorizing rows and the outcome rows as separate items in the array. The client will need to perform a client-side O(N) association by building a map of `rowHash` to `outcome`.
* **Suggestions:**
  * Consider adding an optional query parameter to the egress listing endpoint (or modifying the default JSON-RPC representation) that returns the outcome inline/nested inside the authorizing row if it exists (e.g. `{ ..., outcome: { status, itemId, reason } }`).
  * If this is out of scope for U3a, document the client-side O(N) Map-matching requirement in the companion spec in the `nimbus-web-clipper` repository.

### Q2. Redaction Safety of `itemId` in `payloadSummary`

The design suggests writing `payloadSummary: redactEgressSummary({ status, itemId?, reason? })`.

* **Concerns:**
  * `itemId` contains external identifiers (e.g., `github:owner/repo/pull/123` or `jira:issue-key`). While these are not secret credentials, we must ensure they are permitted under the egress ledger's redaction policy.
* **Suggestions:**
  * Verify that the existing `redactEgressSummary` helper (or equivalent) in `egress/` is equipped to handle the `{ status, itemId, reason }` object structure and does not strip necessary fields or leak sensitive URL parameters.

### Q3. Seam Change and `EgressSink` Alignment

To propagate the authorizing `rowHash` to `targetedFetch`, the spec states:
> `TargetedFetchDeps.appendEgress` becomes `(row) => { rowHash: string } | undefined`

* **Suggestions:**
  * Update the parent `appendEgressEntry` function in `packages/gateway/src/egress/egress-ledger.ts` to return `{ rowHash: string }` instead of `void`.
  * Ensure the change is also propagated through `EgressSink` interfaces and mock sinks in unit tests to keep Typescript signatures green.

---

## 3. Checklist for Implementation

* [ ] Update `appendEgressEntry` in `egress-ledger.ts` to return the computed `rowHash`.
* [ ] ~~Update `EgressSink` interface and mocks to support returning the row hash.~~ **Not doing this** — `EgressSink` is the executor's seam and targeted fetch does not go through it (`assemble.ts` wires `recordSyncEgress` as a direct closure). See the design's "Where it is written".
* [ ] Add `outcome` to the `MARKER_SOURCE_TYPES` union in `egress-source-type.ts`.
* [ ] Implement the `items.fetch.outcome` write site in `targetedFetch` (swallow-and-warn try/catch around a SYNCHRONOUS append — the seam's `undefined` return type exists to make an `async` implementation a compile error, and that must survive the widening).
* [ ] Add `egress-source-type.test.ts` asserts for `outcome`.
* [ ] Verify `security-invariants.test.ts` (I29) passes without modifying `COVERAGE_CLASSES`.
* [ ] Implement unit tests in `outcome-egress.test.ts` or `targeted-fetch.test.ts` to verify:
  * Exact row shape of the outcome marker.
  * Correlation via `source_id = authorizing row_hash`.
  * Swallow-and-warn behavior if writing the outcome row fails.
  * Absence of outcome rows for early-exit arms (unsupported URLs, not configured, etc.).
