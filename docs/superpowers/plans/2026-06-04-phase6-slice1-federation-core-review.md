# Review Notes for 2026-06-04-phase6-slice1-federation-core.md

Here are some open questions, suggestions, and improvements for the Phase 6 Slice 1 Federation Core implementation plan:

## 1. Task 10: Missing RPC Handlers in `dispatchFederationRpc`

**Observation:** The CLI (`nimbus team` in Task 13) and the Tauri allowlist (Task 14) are wired to invoke several management methods, including `federation.discover`, `federation.pair`, and `federation.peers`. However, the implementation provided for `dispatchFederationRpc` in Task 10 only handles 5 methods: `namespace.publish`, `namespace.grant`, `namespace.revoke`, `query`, and `expertise`.
**Improvement:** The implementation of `dispatchFederationRpc` needs to be updated to include handlers for `federation.discover`, `federation.pair`, and `federation.peers` (presumably delegating to `DiscoveryProvider` and `PeerPairing`), or else these commands will result in "Method not found" errors when executed.

## 2. Task 5: `SessionConsentCache` Map Keys

**Observation:** The session consent cache uses a space as a delimiter for its map keys: `key = peerId + " " + namespace`. It also uses `.endsWith(" " + namespace)` for invalidation.
**Suggestion:** While `peerId` is typically a hex string (e.g., `peer:abcd`) and unlikely to contain spaces, relying on a space delimiter can technically cause collisions if either value could contain spaces in the future (e.g., `peerA` + `ns` vs `peerA` + `ns`). It is safer to use a delimiter that is invalid in both strings (like `|` or `#`), or to maintain a nested map (`Map<string, Map<string, boolean>>`).

## 3. Task 4: `NamespaceStore.publish` Idempotency

**Observation:** In `NamespaceStore.publish`, the SQL query uses `INSERT ... ON CONFLICT(namespace_id) DO UPDATE SET name = excluded.name`. Since `namespace_id` is derived deterministically from `name` (`ns:${name}`), a conflict on `namespace_id` means the `name` is identical. Therefore, updating `name` with `excluded.name` is effectively a no-op.
**Suggestion:** This pattern correctly suppresses the unique constraint violation while allowing the transaction to continue and update the filters, but it might look like a mistake to future readers. A brief comment explaining that this is an intentional no-op update to achieve an `UPSERT` without ignoring subsequent filter updates would improve clarity.

## 4. Task 9 / Task 10: `consentTimeoutMs` Config Plumbing

**Observation:** In Task 10 Step 7, the dispatcher wires the timeout as `consentTimeoutMs: (ctx.options.federationConsentTimeoutSeconds ?? 30) * 1000`. However, in Task 11, the configuration is parsed into a nested `[federation]` object with `consentTimeoutSeconds`.
**Suggestion:** Ensure that the plumbing from `NimbusFederationToml` to `CreateIpcServerOptions` correctly maps this value. It will likely need to be accessed as `ctx.options.federation?.consentTimeoutSeconds` rather than directly on `ctx.options`.

## 5. Task 6: mDNS Discovery Provider Mock vs Real

**Observation:** The plan wisely suggests putting the actual mDNS provider implementation behind the E2E tests in Task 14/15.
**Suggestion:** To ensure the build and typecheck pass during Task 6, make sure the `MdnsDiscoveryProvider` skeleton returns empty arrays or safely resolves promises until the actual implementation is fleshed out in the later tasks.
