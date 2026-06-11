# Phase 6 Slice 6a — Cross-colleague Intelligence (read-only) — Implementation Plan Review

This document lists open questions, suggestions, and potential improvements identified during the review of the [2026-06-11-phase6-slice6a-cross-colleague-readonly.md](./2026-06-11-phase6-slice6a-cross-colleague-readonly.md) implementation plan.

---

## 1. Open Questions & Plan Discrepancies

### Q1: Discrepancy in Task 4 Test for Null-Host Peers vs. `reachablePeers` Implementation

- **Context:**
  - Task 4 Step 1 defines a test: `"skips peers with a null host and notes a gap"`, which asserts that a peer with `hostIp: null` yields one gap note in `out.gaps`.
  - Task 4 Step 3 defines `reachablePeers` as:

    ```ts
    function reachablePeers(index: LocalIndex): LanPeerRow[] {
      return index.listLanPeers().filter((r) => r.host_ip !== null && r.host_port !== null);
    }
    ```

  - Since Carol has a null host IP/port, she is filtered out of `reachablePeers`, meaning `runPool` never runs a worker for her, and no gap note is ever added to `out.gaps`.
- **Question:** How should null-host peers be handled?
  - If they should produce gap notes, we should modify `fanOutQuery` / `fanOutExpertise` to append a gap note for every peer where `host_ip === null || host_port === null`.
  - If they should be skipped silently (aligning with how `team.auditMerged` behaves in `federation-rpc.ts`), then the test in Step 1 should be adjusted to expect `gaps: []`.

### Q2: Time Mocking in Huddle Agent

- **Context:** Task 8 Step 3 calculates the cutoff time in `runHuddle` using `Date.now() - sinceMs`.
- **Question:** To make the tests robust against temporal drift, should `HuddleContext` gain an optional `now?: () => number` function (like `PeerFanoutDeps` did in Task 4)?
- **Suggestion:** Add `readonly now?: () => number;` to `HuddleContext`, and use `const nowMs = (ctx.now ?? Date.now)();` to compute the huddle window cutoff.

---

## 2. Suggestions & Improvements

### S1: Stable Result Sorting in Peer Fan-out

- **Problem:** Task 4 Step 3 points out that `runPool` does not preserve input order across concurrency lanes for larger peer sets.
- **Suggestion:** To prevent downstream display jitter (e.g. peer orders changing randomly on consecutive runs of `nimbus huddle` or `nimbus ghost` due to network timing), sort the final `perPeer` array in `fanOutQuery` and `fanOutExpertise` by `peerId` before returning them.

### S2: Case Sensitivity and Path Matching in `match-token.ts`

- **Problem:** Task 5 Step 3 uses `LIKE '%' || ? || '%'` to query labels. On Windows, path casing might vary, and sqlite `LIKE` is case-insensitive by default for ASCII but case-sensitive for Unicode (depending on compilation flags).
- **Suggestion:** Use `LOWER(label) LIKE '%' || LOWER(?) || '%'` to ensure case-insensitive matching for filenames across all platforms.
