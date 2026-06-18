---
name: nimbus-share-virality
description: >
  Phase 6 Slice 8 — Share & Virality. The single outbound-share chokepoint
  (invariant `I27` / static `D21`, `share/share-gate.ts` `createShare()`): default + caller
  redaction, the LOCAL owner approves the exact redacted preview via the `share.publish` HITL
  action, the body is signed with the Vault-only `share.signing.privkey`, persisted to
  `share_records` (V41), and the applied redaction-set is audit-logged; deny/timeout emits
  nothing (fail-closed). Covers the two share kinds (transcript / `--as-recipe` declarative
  tool-call DAG over `tool_call_log.params_json`, V42), the `share.*` IPC namespace, the
  `nimbus share create|list|prune` CLI, and signature verification. Use when adding or modifying
  any share behavior, touching `packages/gateway/src/share/`, wiring a new share sink or redaction
  rule, changing the share gate or keypair, exposing a share method to LAN/Tauri, or asking why a
  share emits nothing / why a recipe step is missing.
---

# Nimbus Phase 6 Slice 8 — Share & Virality

## Why This Skill Exists

Slice 8 lets a user hand a colleague a reproducible artifact of a session — a transcript or a declarative **recipe** — **without leaking secrets and without surrendering local sovereignty**. Sharing is the one place where private indexed content deliberately leaves the machine, so it is governed by a single structural invariant: every outbound share is redacted, owner-approved, signed, and recorded, or it does not leave at all.

The whole subsystem exists to make that one path the *only* path (`I27`/`D21`). A share is never emitted from a connector, an agent, or an ad-hoc RPC handler.

## File Map — `packages/gateway/src/share/`

| File | Role |
|---|---|
| `share-gate.ts` | **I27** — `createShare()`, the ONLY path that produces an outbound share. Redact → owner HITL (`requestApproval`) → sign → persist `share_records` → audit. A denied/timed-out approval returns `{ status: "rejected" }`, persists nothing, and emits a `rejected` audit record (fail-closed). |
| `share-keypair.ts` | `ensureShareKeypair(vault)` — lazily mints/loads the Ed25519 signing keypair. The private key lives at the Vault key `share.signing.privkey` (`SHARE_SIGNING_PRIVKEY`); `share.signing.pubkey` is the published verifier key. `isMatchingKeypair` guards against a mismatched seed/pubkey pair. |
| `share-redaction.ts` | `redactForShare(payload, callerPatterns)` → `{ redacted, applied }`. Applies the default redaction set plus any caller-supplied `RegExp[]`; `applied` is the audited redaction-set. |
| `share-format.ts` | `buildShareFile(body, privkeyB64, pubkeyB64)` (signs + content-hashes), the `ShareBody`/`ShareFile`/`ShareTurn`/`ShareToolCall` types, and the JSON-only `verifyShareBytes` primitive. |
| `share-store.ts` | `insertShareRecord` / list / `pruneExpiredShares` over the `share_records` ledger (V41). |
| `recipe.ts` | `buildRecipeFromSession(db, sessionId, now)` → a `Recipe` (`recipeVersion: 1`, ordered `steps`). Reconstructed LLM-free from `tool_call_log`; `dependsOn` is an ADVISORY conservative inference (Nimbus tracks no param lineage), never authoritative. |
| `recipe-yaml.ts` | Serialize/parse the recipe to/from YAML for the `--as-recipe` artifact. |
| `verify-share.ts` | `verifyShareFromBytes` / `verifyShareFromInput` — UNTRUSTED until `VerifyResult.signatureValid` is true; accepts JSON or YAML, normalizing YAML to JSON bytes before the single verify primitive. |
| `share-consent-broker.ts` | Owner-approval round-trip wiring for the gate's `requestApproval` dependency. |
| `safe-fetch.ts` | Guarded outbound fetch for the HTTP sink. |

**Wiring:** `packages/gateway/src/ipc/share-rpc.ts` (the sole emit site) · `packages/cli/src/commands/share.ts` (CLI).

## Security Invariant — I27 / static D21 (the triple)

An outbound share leaves the machine **only** through `share/share-gate.ts` `createShare()`:

1. **Redact** — default redaction set + caller `RegExp[]` applied; recipe kind omits `turns`/`toolCalls` entirely and shares only the redacted DAG.
2. **Owner HITL** — the LOCAL owner approves the exact redacted preview via the `share.publish` HITL action type (a member of the `I2` frozen set). Caller never approves on the owner's behalf.
3. **Sign** — the body is signed with the Vault-only `share.signing.privkey` (Ed25519); the signed `ShareFile` carries a content hash.
4. **Persist** — a `share_records` row (V41) records hash / kind / redaction-set / provenance / sink.
5. **Audit** — the applied redaction-set is appended to the audit log (`approved` on success, `rejected` on deny/timeout).
6. **Fail-closed** — a denied or timed-out approval emits nothing.

**Static `D21`** (`scripts/structure-audit/check-nimbus-invariants.ts`): the `share.publish` literal may be NAMED only in `engine/executor.ts` (the frozen-set membership) + `share-gate.ts`; the `share.signing.privkey` literal only in `share-keypair.ts`; and `createShare` may be CALLED only from `share-gate.ts` (its home) + `share-rpc.ts` (the single wiring/emit site) + the boot site that builds its `requestApproval` dependency. The runtime counterpart is the I27 describe block in `packages/gateway/src/security-invariants.test.ts`. See the `nimbus-security-invariants` skill for the triple-rule contract.

## Surfaces

- **CLI:** `nimbus share create <session-id> [--out <file> | --http | --to-peer <id>] [--as-recipe] [--redact <pattern>] [--expires <dur>]` · `nimbus share list [--all]` · `nimbus share prune` · `nimbus share pubkey` · `nimbus share approve|reject <request-id>` · `nimbus verify-share <file|url>`. `--as-recipe` produces the declarative recipe artifact instead of a transcript. Full reference: [`docs/cli-reference.md`](../../docs/cli-reference.md).
- **IPC:** `share.create` / `share.list` / `share.get` / `share.pubkey` / `share.verify` / `share.prune` / `share.approvalRespond` — all in `ipc/share-rpc.ts`. `share.create` is the only method that calls `createShare`. See the `nimbus-ipc` skill registry; check `lan-rpc.ts` / the Tauri `ALLOWED_METHODS` (`I7`) before exposing any share method over the wire (credential/emit-class methods stay renderer- and LAN-restricted).
- **Schema:** V41 (`share_records` ledger) · V42 (`tool_call_log.params_json` — the recorded tool-call params the recipe builder reconstructs steps from). See `nimbus-db-migrations`.

## The two share kinds

- **`transcript`** — collects the session's `turns` + `toolCalls`, redacts them, ships the redacted bodies.
- **`recipe`** (`--as-recipe`) — `buildRecipeFromSession` reconstructs an ordered, LLM-free tool-call DAG from `tool_call_log` (params from `params_json`, V42). The redacted recipe is shared; `turns`/`toolCalls` are omitted entirely. Steps are authoritative in recorded order; `dependsOn` edges are advisory only.

## Gotchas

- **The gate is the chokepoint.** Never add a second path that writes a share to a file, POSTs it to HTTP, or forwards it to a peer. Any new emit must route through `createShare` → `share-rpc.ts`, or it violates I27/D21 (the static audit fails before tests run).
- **Redaction-set is the audited boundary.** The owner approves the *exact redacted preview*; the `applied` set is what gets audit-logged. Don't redact after approval or approve a non-redacted payload.
- **`share.signing.privkey` is Vault-only.** Never log it, return it over IPC, or name the literal outside `share-keypair.ts` (D21).
- **Recipe `dependsOn` is advisory.** Nimbus tracks no parameter lineage; edges are inferred by a conservative value-matcher and may be incomplete. Replay executes recorded order and never relies on `dependsOn`.
- **A verified share is UNTRUSTED until `signatureValid`.** `verify-share` returns a result for tampered/forged bodies too — gate any trust on `VerifyResult.signatureValid`.
- **Fail-closed means emit nothing.** A deny/timeout returns `{ status: "rejected" }` and persists no `share_records` row — don't treat a rejection as an empty success.
