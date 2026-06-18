# Phase 6 Slice 8d — Sovereign-Mesh Referral — Plan Review

We have reviewed the implementation plan for **Phase 6 Slice 8d — Sovereign-Mesh Referral** (`2026-06-17-slice8d-referral.md`). The plan is highly cohesive and provides a clear description of the cryptographic hop chain, database schema, store methods, and integration/E2E test setup.

Below are suggestions and warnings to ensure robust execution.

---

## 1. Important Recommendations & Robustness Fixes

### A. Task 9: Promise and Synchronous Exception Guarding for Inbound Pairing

In **Task 9**, `onPairComplete` is introduced as a callback on `PeerPairing`. It is invoked during the critical pairing paths.

* In `initiatePair` (async), the callback is correctly wrapped in a `try/catch` block:

  ```typescript
  try { await this.onPairComplete?.(peerId); } catch { /* best-effort drain */ }
  ```

* In `approveInboundPair` (sync), the callback is triggered asynchronously without awaiting:

  ```typescript
  void this.onPairComplete?.(peerId);
  ```

* **Risk**: If the callback returns a promise that rejects, it will trigger an **unhandled promise rejection** in Bun. If it throws synchronously before returning the promise, it will crash the handshake process, which is highly critical.
* **Robustness Suggestion**: Wrap the synchronous invoke in a wrapper that catches synchronous throws and prevents unhandled promise rejections:

  ```typescript
  if (this.onPairComplete) {
    try {
      const res = this.onPairComplete(peerId);
      if (res instanceof Promise) {
        res.catch(() => {}); // prevent unhandled promise rejection
      }
    } catch {
      // ignore sync exceptions to keep pairing best-effort resilient
    }
  }
  ```

### B. Task 12: Tauri Allowlist Rust Count Test

* In `packages/ui/src-tauri/src/gateway_bridge.rs`, adding `"share.inbox"` to the `ALLOWED_METHODS` slice will throw off any hardcoded array length check in the Rust unit tests.
* **Tip**: Be sure to grep for `ALLOWED_METHODS` in Rust test files to bump the array size assertion to match the newly added read-only RPC method.

---

## 2. Clarifications on Schema & Storage

### A. ID Uniqueness in `share_inbox` (Task 3)

* The unique index constraint:

  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_share_inbox_unique ON share_inbox(recipient_pubkey, content_hash, direction);
  ```

* Because received shares are stored under `recipient_pubkey = '@self'` with `direction = 'received'`, this correctly allows multiple distinct shares to reside in the inbox as long as they have different `content_hash`es. This is perfectly correct and supports a clean, deduplicated inbox store.

### B. Migration assertions (Task 2)

* When changing `CURRENT_SCHEMA_VERSION` in `local-index.ts` from `42` to `43`, ensure that you audit tests walking `0 -> CURRENT` migrations. Some tests verify that the migration chain matches the exact count. Ensure those assertions are updated to `43`.

---

## Summary

The plan is approved. Addressing the callback error handling in Task 9 will ensure that the pairing flow remains resilient and fail-safe, even if delivery of queued shares fails during pairing.
