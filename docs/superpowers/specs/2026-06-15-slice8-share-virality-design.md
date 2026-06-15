# Phase 6 Slice 8 — Share & Virality Primitives — Design

**Date:** 2026-06-15
**Status:** Approved design — pending implementation plans
**Roadmap:** `docs/roadmap.md` §"Share & Virality Primitives" (Phase 6, Slice 8)
**Closes:** Phase 6 acceptance item "Share & Virality Primitives"; the `nimbus recipes` near-term initiative gets its natural origin point.

---

## 1. Goal

Give Nimbus its first **viral / sharing primitives** without surrendering local sovereignty. A user can produce a **signed, redacted, content-addressed** artifact of a session — a transcript or a declarative recipe — verify it, replay it against their own data, and forward it peer-to-peer with attribution.

This is the **one** subsystem in Nimbus that deliberately emits indexed data *outward*. Every other invariant keeps data local. The keystone of the design is therefore a **share-gate**: the single chokepoint through which any share leaves the machine, backed by a new structural invariant **I27 / static D21**.

## 2. Non-negotiables this design must honor

- **Local-first / HITL is structural** — an outbound share requires the local owner's explicit approval of the exact redacted bytes. No bypass, no configure-away.
- **No plaintext credentials** — the share-signing private key is Vault-only; never in logs / IPC / config / the share file.
- **Re-redaction trust** — redaction is applied at the gate and the *applied set* is audit-logged, so the user can later prove what was and wasn't shared.
- **Federation is metadata-shaped / leak-proof** — forwarding reuses the existing authenticated, peer-pinned NaCl-box channel; the gate still governs the emit.
- **No `any`** — `unknown` for external (share-file / wire) input; strict mode.

## 3. Decisions locked during brainstorming

| # | Decision | Choice |
|---|----------|--------|
| D-share-trust | How data is allowed to leave | **HITL gate + mandatory redacted-bytes preview**; new invariant I27. No `--yes` skip. |
| D-recipe-model | How `--as-recipe` / replay model the workflow | **New declarative tool-call DAG**, reconstructed deterministically; LLM-free recipe-runner powers replay. |
| D-referral-scope | How much of sovereign-mesh referral | **All three**: federation forwarding + attribution chip + deferred-reveal install prompt. |
| D-staging | Delivery shape | **Four waves, four PRs**, one umbrella spec (this doc) + four implementation plans. |
| D-signing-key | Which key signs a share | **New dedicated Vault-only `share.signing.{priv,pub}key`** (mirrors `policy/anchor-keypair.ts`), not the policy anchor key. |
| D-tauri | Renderer exposure | Read-only `share.verify/list/get` on the Tauri allowlist; **`share.create` stays CLI-only** (keep outbound/RCE-class surface off the renderer). |
| D-provenance | Forwarding integrity | Inner share body+sig **immutable / origin-verifiable**; a **separate forwarding layer** carries the hop chain (each forwarder appends+signs). verify-share validates content against origin; the chain is advisory attribution. |

## 4. Substrate (what already exists — reuse, don't rebuild)

- **Sessions are reconstructable**: `audit_log.session_id` (V24, `index/audit-session-v24-sql.ts`), `tool_call_log` (V29, `db/tool-call-log.ts` — `sessionId`, `toolId`, `service`, `resultEnvelope`, `status`), and the transcript handler `ipc/engine-get-session-transcript.ts`.
- **Ed25519 sign/verify + canonicalization**: `policy/policy-signing.ts` (`canonicalize`, `signPolicy`/`verifyPolicy` via nacl detached) and the keypair-in-Vault pattern `policy/anchor-keypair.ts` (`ensureAnchorKeypair`).
- **Blake3 content hashing**: `db/audit-chain.ts` (`computeAuditRowHash`, `GENESIS_HASH`, `@noble/hashes/blake3`) and `db/backup-manifest.ts` (`blake3HashFile`).
- **Redaction (secret-only today)**: `audit/format-audit-payload.ts` — `SENSITIVE_VALUE_PATTERNS` (GitHub/OpenAI/Anthropic/Slack/Bearer/JWT/AWS) + `SENSITIVE_KEY`. Does **not** yet cover emails / hostnames / IPs / Slack-handle prefixes / credit-cards (the share default set adds these).
- **Federation channel**: `ipc/lan-client.ts` `sendFederatedOverWire` (hello → NaCl-box sealed JSON-RPC, peer-pubkey-pinned), `federation/federation-server.ts`, `ipc/federation-rpc.ts`.
- **CLI dispatch**: `packages/cli/src/index.ts` `COMMAND_HANDLERS`; subcommand pattern per `commands/audit.ts` (`withIpc` → gateway RPC).
- **Net-new** (no precedent): the recipe declarative format, the recipe-runner, replay/divergence.

## 5. The share artifact — `nimbus-share/v1`

A content-addressed, signed JSON envelope written as `.nimbus-share.json` (recipe variant: `.nimbus-recipe.yaml`, see §7).

```
{
  "format": "nimbus-share/v1",
  "contentHash": "<blake3(canonicalize(body)) hex>",
  "body": {
    "kind": "transcript" | "recipe",
    "sessionId": "<string>",
    "createdAt": <ms>,
    "expiresAt": <ms> | null,
    "redactionSet": ["secrets","emails","hostnames","slack-handles","credit-cards","ips", ...caller],
    "provenance": { "originLabel": "<string>", "originPubkey": "<b64>", "hops": 0, "chain": [] },
    "turns": [ { "role", "text(redacted)", "timestamp" } ]?,      // kind=transcript
    "toolCalls": [ { "toolId","service","params(redacted)","status" } ]?,
    "recipe": { ...declarative DAG... }?                          // kind=recipe
  },
  "sig": { "alg": "ed25519", "pubkey": "<b64>", "signature": "<b64 over canonicalize(body)>" }
}
```

- `canonicalize` is reused from `policy/policy-signing.ts` (applied to the JSON-serialized body via a stable key-ordered serializer; see canonical-JSON in `extensions/canonical-json.ts`).
- `contentHash` and `signature` are computed over the **same** canonical bytes — tamper of either fails verification.
- The body is **already redacted** before hashing/signing, so it is safe to persist in `share_records`.

## 6. Wave 8a — Foundation (PR1) · invariant I27 / static D21 · migration V41

### 6.1 `share/share-redaction.ts`
Composes the existing `SENSITIVE_VALUE_PATTERNS` (imported, not duplicated) **plus** the share default PII set: email addresses, internal hostnames, Slack-handle prefixes, credit-card patterns, IPv4/IPv6, plus caller-supplied `--redact <patterns>`. Returns both the redacted payload and the **set of family names actually applied** (for the audit record + `body.redactionSet`). Pure + unit-tested for "no un-redacted value of each family escapes."

### 6.2 `share/share-gate.ts` — the I27 chokepoint
The single function any emit path must call. Pipeline:
1. **Collect** session data (transcript turns and/or tool calls) for `sessionId`.
2. **Redact** via `share-redaction.ts` (default set + caller `--redact`).
3. **Preview**: return the exact redacted body for owner inspection.
4. **HITL approval**: gate on the new frozen action type **`share.publish`** (added to `HITL_REQUIRED_BACKING`, I2). Mandatory — no `--yes`/non-interactive skip; without approval the share never materializes.
5. **Sign**: `share.signing.privkey` (Vault-only) over `canonicalize(body)`; attach pubkey + signature; compute `contentHash`.
6. **Emit** to the requested sink: local file (default), a user-configured HTTP endpoint (off unless explicitly configured — **no Nimbus-hosted relay**), or a federation peer (8d).
7. **Audit-log** the publish with the **redaction set actually applied** + sink + contentHash.

### 6.3 Share-signing keypair
`share/share-keypair.ts`: `ensureShareKeypair(vault)` mirroring `policy/anchor-keypair.ts`. Vault keys `share.signing.privkey` / `share.signing.pubkey`. Privkey never leaves the process; pubkey is the verification anchor (exposed via `share.pubkey` read method + printed by the CLI).

### 6.4 `nimbus verify-share <file|url>` + standalone primitive
`share/verify-share.ts`: parse (`unknown` → validated `nimbus-share/v1`), recompute `contentHash`, verify signature against the embedded (optionally caller-pinned `--pubkey`) key, check `expiresAt`, report pass/fail per check. A documented dependency-light **standalone verify** (the `eaf-verify`-shaped primitive) reuses the same `verifyShareBytes` function so a reviewer can drop it into CI.

### 6.5 IPC + CLI
- IPC: `share.create` (long-running — drives HITL), `share.verify`, `share.list`, `share.get`, `share.pubkey`. (`nimbus-ipc` checklist; LAN-forbidden for `create`.)
- Tauri allowlist (I7): read-only `share.verify` / `share.list` / `share.get` / `share.pubkey`; **`share.create` not exposed** (CLI-only).
- CLI: `share` + `verify-share` registered in `COMMAND_HANDLERS`. `nimbus share <session-id> [--redact <patterns>] [--expires <duration>] [--out <path>|--http <url>|--to-peer <peer>]`.

### 6.6 Migration V41 — `share_records`
One row per **sent** share: `id`, `content_hash` (unique), `kind`, `session_id`, `created_at`, `expires_at`, `redaction_set_json`, `provenance_json`, `body_json` (redacted body — safe), `sig_json`, `sink`. Append-only; powers `share.list`/`share.get` and replay.

### 6.7 Invariant I27 / static D21
**Wiring** (`share/share-gate.ts`) + **docs** (`docs/SECURITY-INVARIANTS.md` + `CLAUDE.md` + skill) + **test** (`security-invariants.test.ts`) land in the same commit.

> **I27** — an outbound share leaves the machine only through `share/share-gate.ts`: default+caller redaction applied, the local owner approves the exact redacted bytes via the `share.publish` HITL action (I2 frozen set), the body is signed with the Vault-only `share.signing.privkey`, and the applied redaction-set is audit-logged. No other code path emits a share to a file sink, HTTP endpoint, or federation peer. The signing privkey is Vault-only and never leaves the process.

**Static D21** (`scripts/structure-audit/check-nimbus-invariants.ts`): confine share-emit calls + the `share.publish` action type + the `share.signing.privkey` Vault read to the gate site; fail-closed if referenced elsewhere.

## 7. Wave 8b — Recipe (PR2)

### 7.1 `share/recipe.ts`
`buildRecipeFromSession(db, sessionId)` reconstructs a **declarative tool-call DAG** deterministically from `tool_call_log` + `audit_log` — no LLM. Recipe shape:
```
{ recipeVersion: 1, sourceSessionId, generatedAt,
  steps: [ { stepId, tool, service, params(redacted), thresholds?, dependsOn: [stepId...] } ],
  graphTraversals: [ { fromEntity, relation, ... } ] }
```
Step ordering + `dependsOn` derived from `called_at` order and param-provenance (a step consuming a prior step's output). Serialized to deterministic **YAML** (`.nimbus-recipe.yaml`). *(Implementation note for the plan: confirm an available YAML serializer in deps; otherwise emit canonical hand-rolled YAML or fall back to JSON with a `.json` extension — decided at plan time.)*

### 7.2 `nimbus share <session> --as-recipe`
Routes through the **same** `share-gate` (redaction + HITL preview + sign), `body.kind="recipe"`, `body.recipe` populated, `turns` omitted (conversation stripped entirely). Recipe sharing therefore inherits I27 with zero new emit path. Also usable as a pure local artifact (write to file without forwarding).

## 8. Wave 8c — Replay (PR3, depends on 8b)

### 8.1 `share/recipe-runner.ts`
Deterministic, **LLM-free** executor. For each declarative step against the receiver's local index/connectors:
- connector/tool not installed → `unavailable` (with the connector name — "you don't have connector X");
- otherwise execute **read-only** (replay never fires write/HITL actions) and capture the result.

### 8.2 `nimbus share verify --replay`
Load the shared recipe (or a transcript share's `toolCalls`), run the recipe-runner locally, **diff** each step's result against the shared original, and render a divergence report: per-step `match` / `diverged` / `missing-connector` / `error` + a summary. Read-only and deterministic — the "watch what ran on Asaf's data run on yours" demo, and the catch for "this only works because Asaf has connector X."

## 9. Wave 8d — Sovereign-mesh referral (PR4) · migration V42

### 9.1 Forwarding
`federation.shareForward` RPC sends a signed share to a paired peer over `sendFederatedOverWire` (authenticated, peer-pubkey-pinned). Forwarding **out** is a share-emit and therefore passes through the I27 gate.

### 9.2 Provenance (immutable inner + forwarding layer)
The inner share `body`+`sig` are **immutable** and verifiable against the **origin** pubkey. A **separate forwarding layer** carries `chain[]` (`{ gatewayLabel, pubkey }` per hop) + `hops`; each forwarder appends itself and signs the layer. `verify-share` validates content against origin; the chain is advisory attribution that cannot forge the content.

### 9.3 Attribution chip
A received share/brief surfaces "forwarded from `<origin>`, N hops away" — a field on the record, rendered by CLI + Tauri.

### 9.4 Deferred-reveal install prompt
`share_inbox` (V42) holds pending forwarded shares keyed by recipient pubkey. A freshly-initialized Gateway, on first successful pair, **drains** pending shares from that sender and surfaces attribution + content. Inbound shares are stored as **viewable/replayable artifacts — never auto-merged into the index, no auto-execution** — so receiving needs no HITL, and the "no plaintext bootstrap" promise holds (the envelope is meaningless without a paired Gateway).

## 10. Schema summary

| Version | Wave | Table(s) |
|---------|------|----------|
| V41 | 8a | `share_records` (sent shares) |
| V42 | 8d | `share_inbox` (received / pending-forward, keyed by recipient pubkey) |

(8b and 8c add no migrations — recipe lives inside the existing share body; replay is read-only.)

## 11. Testing strategy

- **I27 enforcement** in `security-invariants.test.ts` (gate is sole emit path; `share.publish` in frozen set; signing-key read confined). Static D21 in the structure-audit.
- **Redaction proofs**: each family (email/host/IP/slack-handle/credit-card/secret) verifiably stripped; property-style "no un-redacted value escapes."
- **Sign/verify**: round-trip; tamper-of-body fails; content-hash mismatch fails; expiry honored; wrong-pubkey fails.
- **Recipe**: deterministic reconstruction (same session → identical DAG); conversation fully stripped in recipe mode.
- **Replay**: divergence classification incl. missing-connector; read-only guarantee (no write action fires).
- **Forwarding**: provenance chain append + hop count; deferred-reveal drain on first pair; inner-sig immutability across hops.
- **E2E CLI**: two real Gateway subprocesses + mock peers — forward a share, verify attribution end-to-end.
- **Coverage**: new files clear the ≥80% line+branch true-coverage floor (Docker-Linux-authoritative).

## 12. Out of scope (explicit deferrals)

- No Nimbus-hosted relay or upload service — the HTTP sink is user-configured only.
- Replay does not re-invoke the LLM and does not execute write actions.
- `--as-recipe` extraction is deterministic from logged tool calls; it does not LLM-summarize intent.

## 13. Wave → PR → plan map

| Wave | PR scope | New invariant / schema | Plan |
|------|----------|------------------------|------|
| 8a | share + verify-share + redaction + gate | I27 / D21, V41 | plan-8a |
| 8b | `--as-recipe` + declarative DAG | — | plan-8b |
| 8c | replay + recipe-runner | — | plan-8c |
| 8d | sovereign-mesh referral | V42 | plan-8d |
