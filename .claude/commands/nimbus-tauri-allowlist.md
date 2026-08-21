---
name: nimbus-tauri-allowlist
description: >
  The Tauri renderer-callable IPC method allowlist (invariant `I7`). Use when exposing
  a new Gateway IPC method to the desktop UI, removing/renaming a renderer-callable
  method, marking a method long-running (no-timeout), classifying a notification for
  cross-window rebroadcast, auditing whether the renderer can reach an RCE-class surface
  (`vault.*`, `extension.install`), or fixing a Rust allowlist test / count assertion.
  Consult before any change to `packages/ui/src-tauri/src/gateway_bridge.rs` — B1 chain
  C1 (renderer XSS → `extension.install` → credential exfiltration) was a single
  allowlist mistake.
---

# Nimbus Tauri Allowlist (I7)

## Why This Skill Exists

The Tauri renderer is a WebView with the same trust level as any browser frame. Anything in the `ALLOWED_METHODS` array is reachable from JavaScript — including JavaScript injected via prompt-injected indexed content if any soft barrier ever fails. The B1 audit's chain C1 was triggered by `extension.install` being on the allowlist with no compensating HITL, turning a renderer XSS into full credential exfiltration. The fix removed `extension.install`; the allowlist is now treated as **the single source of truth for the renderer-callable surface**, protected by a suite of Rust allowlist tests (size, alphabetization, no-duplicates, forbidden-namespace, plus per-surface read-only guards — e.g. `allowlist_egress_read_only` proves only the `egress.*` read verbs are renderer-callable and the HITL-gated `egress.prune` is blocked).

This skill is the rule a contributor consults **before** editing the allowlist.

## Where It Lives

| File | Role |
|---|---|
| [`packages/ui/src-tauri/src/gateway_bridge.rs:57`](../../packages/ui/src-tauri/src/gateway_bridge.rs) | `ALLOWED_METHODS: &[&str]` — the single sorted, asserted-size array |
| [`packages/ui/src-tauri/src/gateway_bridge.rs:178`](../../packages/ui/src-tauri/src/gateway_bridge.rs) | `NO_TIMEOUT_METHODS` — subset that bypasses the 30 s default RPC timeout |
| [`packages/ui/src-tauri/src/gateway_bridge.rs:192`](../../packages/ui/src-tauri/src/gateway_bridge.rs) | `GLOBAL_BROADCAST_METHODS` — notifications that fan out across all Tauri windows |
| [`packages/ui/src-tauri/src/gateway_bridge.rs`](../../packages/ui/src-tauri/src/gateway_bridge.rs) `mod tests` | Allowlist enforcement tests: `allowlist_exact_size`, `allowlist_is_alphabetized`, `allowlist_has_no_duplicates`, `allowlist_rejects_vault_and_raw_db_writes`, plus per-surface read-only guards (e.g. `allowlist_egress_read_only` — egress reads exposed, `egress.prune` blocked) |

## The Three Lists

### `ALLOWED_METHODS`

Every JSON-RPC method the renderer is permitted to call via `rpc_call`. Currently 105 entries (the count grows with each renderer-exposed surface — verify the live `ALLOWED_METHODS.len()` constant in `gateway_bridge.rs` rather than trusting this number). The list is:

- **Alphabetized** — enforced by `allowlist_is_alphabetized`. Insert in order; do not append at the end.
- **Size-asserted** — `allowlist_exact_size` checks `ALLOWED_METHODS.len() == 105`. **Adding a method requires updating this constant.** Removing a method also requires updating it.
- **Deduplicated** — `allowlist_has_no_duplicates` covers copy-paste mistakes.
- **Free of forbidden namespaces** — `allowlist_rejects_vault_and_raw_db_writes` asserts that `vault.*`, `db.put` / `db.delete`, `config.set`, `index.rebuild`, and `index.querySql` are absent. Add to this test if you introduce a new forbidden namespace.

### `NO_TIMEOUT_METHODS`

Methods that legitimately take many minutes and are tracked for liveness via streamed progress notifications instead of the default 30 s RPC timeout. Currently 6: `data.export`, `data.import`, `identity.login`, `llm.pullModel`, `updater.applyUpdate`, `workflow.run`. `workflow.run` earns its place for two reasons, not one: the handler resolves only when the run ends, AND a step can trip a HITL gate whose approval the user supplies mid-call, so the bound would double as the user's think time. The list is:

- **A subset of `ALLOWED_METHODS`** — enforced by `no_timeout_methods_are_subset_of_allowlist`.
- **Size-asserted** — `no_timeout_methods_exact_size` checks `NO_TIMEOUT_METHODS.len() == 6`.

A new no-timeout method must (a) emit periodic progress notifications the UI polls for liveness, (b) support cancellation via a partner method (e.g. `llm.cancelPull`), and (c) appear in both lists with both size constants updated.

### `GLOBAL_BROADCAST_METHODS`

Notifications that are intentionally fanned out to every Tauri window — not just the one that subscribed. Currently 1: `profile.switched`. Adding to this list means accepting that the notification may interrupt unrelated UI flows in non-focused windows; only do it for events that materially change app-wide state (active profile, gateway disconnection, …). Size-asserted at 1.

## Forbidden Categories

These namespaces must **never** be reachable from the renderer:

| Namespace | Reason |
|---|---|
| `vault.*` (any method) | Credentials are owner-only; renderer XSS must never reach the keystore. Vault access is gateway-internal only. |
| `db.put`, `db.delete`, raw DB writes | Renderer-controlled DB writes bypass the index integrity contracts in `db/write.ts` (SQLite full handling, audit). Domain operations like `data.delete` go through the Gateway and are gated separately. |
| `index.querySql` | The raw-SQL escape hatch behind `nimbus query --sql`; arbitrary SELECT from the renderer is an exfiltration channel. |
| `config.set` | Profile-scoped config changes go through `profile.*` methods, which are HITL-gated and broadcast. |
| `index.rebuild` | High-cost destructive op; CLI-only. |
| `extension.install` | **Removed for security** — the renderer must never install extensions; that path is now Rust-native via a Tauri file picker (S4-F6). Do not re-add. |
| `lan.pair` and friends | LAN pairing requires out-of-band code transmission (see `docs/SECURITY.md` §"LAN remote access"); CLI-only. |
| `updater.*` write-side | Auto-update is initiated from the gateway side or via CLI; renderer-driven updates would let an XSS install attacker-controlled binaries. The currently-allowed `updater.*` methods are read-only status / explicit user actions like `rollback` initiated from a settings panel — re-evaluate before adding any others. |

When you add a new namespace, add a new line in `allowlist_rejects_vault_and_raw_db_writes` to lock the absence in.

## Adding a Renderer-Callable Method — Checklist

When the desktop UI needs a new IPC method:

- [ ] Confirm a Gateway handler already exists for the method id. The Rust bridge does not synthesize handlers; if `connector.startAuth` is in the allowlist but unhandled at the Gateway, every renderer call fails (S4-F2 was exactly this).
- [ ] Confirm the method is **not** in any forbidden category above. If it is destructive, route through a HITL-gated wrapper at the Gateway, not directly.
- [ ] Insert the method id in `ALLOWED_METHODS` **alphabetically**.
- [ ] Bump the constant in `allowlist_exact_size` to the new total.
- [ ] If the method can take longer than 30 s and emits progress notifications, also add it to `NO_TIMEOUT_METHODS` and bump `no_timeout_methods_exact_size`. Confirm a partner cancellation method exists.
- [ ] Run `cargo test` from `packages/ui/src-tauri/`. All four allowlist tests must be green.
- [ ] Add the method to the [`docs/cli-reference.md`](../../docs/cli-reference.md) IPC section if it is also CLI-callable.
- [ ] Update [`docs/SECURITY-INVARIANTS.md`](../../docs/SECURITY-INVARIANTS.md) §I7 if the wiring shape changed (it usually does not for a routine add).
- [ ] Update the "Currently N entries" line in this skill so that AI assistants do not propose stale numbers.

## Removing or Renaming a Method

- [ ] Delete the entry from `ALLOWED_METHODS`.
- [ ] Decrement `allowlist_exact_size`.
- [ ] If it was in `NO_TIMEOUT_METHODS` or `GLOBAL_BROADCAST_METHODS`, remove from there too and update those size assertions.
- [ ] Remove all renderer call sites in `packages/ui/src/` — the bridge will reject the call but the UI call site is dead code that confuses future readers.
- [ ] Add a test line in `allowlist_rejects_vault_and_raw_db_writes` (or the relevant guard test) if the removal was security-driven, so the absence is locked in. The pattern is the comment + assert pair used for `extension.install` and `index.querySql`.

## Adding a Long-Running Method (`NO_TIMEOUT_METHODS`)

- [ ] Method already in `ALLOWED_METHODS` (subset rule).
- [ ] Method emits a progress notification at least every few seconds (`*.progress` style) so the UI has a liveness signal.
- [ ] A partner cancellation method exists (`llm.cancelPull` for `llm.pullModel`, etc.).
- [ ] Insert in `NO_TIMEOUT_METHODS` and bump `no_timeout_methods_exact_size`.
- [ ] Run `cargo test no_timeout_methods` from `packages/ui/src-tauri/`. Both subset and size assertions must pass.

## Anti-Patterns

| Anti-pattern | Why it's bad | What to do instead |
|---|---|---|
| Adding a method without updating the count assertion | The Rust test fails CI immediately, but if you `--no-verify` the commit, you have shipped an allowlist whose CI guarantees no longer hold | Always update both. The count is the integrity check. |
| Appending to the end of the array instead of inserting alphabetically | `allowlist_is_alphabetized` fails, but the diff also becomes unreviewable for security purposes — the order is the audit trail | Insert alphabetically; review tools then highlight only the new line |
| Adding `extension.install` "for the marketplace flow" | This was the chain-C1 vector; the marketplace UI now goes through a Rust-native file picker with explicit user gesture. There is no renderer-controlled install path by design | Use the `@tauri-apps/plugin-dialog` file picker pattern; HITL-gate the install at the Gateway |
| Synthesizing a "convenience" method that wraps a forbidden namespace (e.g. `vault.read_credentials_for_ui_display`) | Trivially defeats the whole point. The renderer never sees credential bytes. | If the UI needs to know whether a credential exists, expose a presence check (returns boolean) at the Gateway and add only that. |
| Marking a method `NO_TIMEOUT_METHODS` because it "sometimes" takes 35 seconds | The 30 s timeout is the renderer's protection against gateway hangs. Adding to no-timeout removes that protection in exchange for a slow-progress signal. | Fix the gateway-side latency, or split the method into a fast initiator + a follow-up status method |
| Adding a notification to `GLOBAL_BROADCAST_METHODS` because it "should also reach the popup window" | Most notifications target a specific window registry; global broadcast is a cross-cutting hammer that creates UI race conditions in unrelated panes | Use the per-window emission API and explicitly emit to each relevant window |

## How to Comply (Short Form)

1. Confirm the Gateway handler exists.
2. Confirm the method id is **not** in any forbidden category.
3. Insert alphabetically into `ALLOWED_METHODS` and bump the size assertion.
4. (If long-running) also update `NO_TIMEOUT_METHODS` and its size assertion.
5. `cargo test` from `packages/ui/src-tauri/` — four allowlist tests pass.
6. Update this skill's "Currently N entries" count.
7. All in the same commit.

## See Also

- [`docs/SECURITY-INVARIANTS.md`](../../docs/SECURITY-INVARIANTS.md) §I7 — full invariant statement and audit cross-references
- [`docs/SECURITY.md`](../../docs/SECURITY.md) §"IPC Surface" — Gateway IPC trust model
- [`packages/ui/src-tauri/src/gateway_bridge.rs`](../../packages/ui/src-tauri/src/gateway_bridge.rs) — production source of truth
- `nimbus-ipc` skill — Gateway-side IPC method conventions; pair with this skill when adding a method that is *both* CLI-callable and renderer-callable
- `nimbus-security-invariants` skill — the invariant triple rule (wiring + docs + test) that all sixteen invariants follow
