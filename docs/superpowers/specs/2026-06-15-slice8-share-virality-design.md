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
| D-provenance | Forwarding integrity | Inner share body+sig **immutable / origin-verifiable**; the **top-level `forwarding` envelope** (outside the signed body) carries the hop chain (each forwarder appends+signs over `contentHash ++ prior chain`). verify-share validates content against origin; the chain is advisory attribution. |

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

```jsonc
{
  "format": "nimbus-share/v1",
  "contentHash": "<blake3(canonicalize(body)) hex>",
  "body": {
    "kind": "transcript" | "recipe",
    "sessionId": "<string>",
    "createdAt": <ms>,
    "expiresAt": <ms> | null,
    "redactionSet": ["secrets","emails","hostnames","slack-handles","credit-cards","ips", ...caller],
    "origin": { "label": "<string>", "pubkey": "<b64>" },        // immutable; covered by sig
    "turns": [ { "role", "text(redacted)", "timestamp" } ]?,      // kind=transcript
    "toolCalls": [ { "toolId","service","params(redacted)","status" } ]?,
    "recipe": { ...declarative DAG... }?                          // kind=recipe
  },
  "sig": { "alg": "ed25519", "pubkey": "<b64>", "signature": "<b64 over canonicalize(body)>" },
  "forwarding": {                                                 // OUTSIDE the signed body — see §9.2
    "hops": <int>,                                                // 0 at origin; populated only by 8d
    "chain": [ { "gatewayLabel": "<string>", "pubkey": "<b64>",
                 "sig": "<b64 over contentHash ++ prior-chain-entries>" } ]
  }
}
```

- `canonicalize` is reused from `policy/policy-signing.ts` (applied to the JSON-serialized body via a stable key-ordered serializer; see canonical-JSON in `extensions/canonical-json.ts`).
- `contentHash` and `signature` are computed over the **same** canonical bytes — tamper of either fails verification.
- **Forwarding metadata lives OUTSIDE the signed `body`.** Only immutable origin info (`body.origin`) is signed by the origin. The mutable hop chain sits in the top-level `forwarding` envelope so a forwarder can append a hop without invalidating the origin signature (resolves the §5↔§9.2 contradiction the design review flagged). `forwarding` is part of the `nimbus-share/v1` format from 8a (default `{ hops: 0, chain: [] }`) but is only ever *appended to* in 8d.
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

`share/verify-share.ts`: parse (`unknown` → validated `nimbus-share/v1`), recompute `contentHash`, verify signature against the embedded (optionally caller-pinned `--pubkey`) key, evaluate `expiresAt`, report **per-check** results. A documented dependency-light **standalone verify** (the `eaf-verify`-shaped primitive) reuses the same `verifyShareBytes` (bytes-in, no I/O) so a reviewer can drop it into CI.

**Expiry is advisory, not cryptographic** (design-review point 5a): an expired share returns `signatureValid: true` + `expired: true` with a warning — the signature is still genuine, only the share's freshness window has lapsed. Verification *fails* only on a bad signature / content-hash mismatch / malformed envelope, never on expiry alone, so users can still read historical records.

**SSRF guard for the `url` form** (design-review point 4): fetching a share by URL goes through a shared `share/safe-fetch.ts` that rejects URLs resolving to loopback / link-local / RFC-1918 private ranges (`127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`) and non-`http(s)` schemes, so `verify-share <url>` (and the §6.5 HTTP sink) cannot be turned into a probe against the local LAN servers (consistent with the I5/I6 local-bind posture). The check resolves the host and validates the *resolved* address, not just the literal, to **mitigate** DNS-rebind-style bypasses. A residual TOCTOU window remains (Bun's `fetch` re-resolves at connect time; full IP-pinning breaks TLS SNI/cert validation), bounded by the sink host being config-pinned and verify-by-url being a user-initiated read — full IP-pinning is a tracked hardening follow-up, not in 8a.

### 6.5 IPC + CLI

- IPC: `share.create` (long-running — drives HITL), `share.verify`, `share.list`, `share.get`, `share.pubkey`. (`nimbus-ipc` checklist; LAN-forbidden for `create`.)
- Tauri allowlist (I7): read-only `share.verify` / `share.list` / `share.get` / `share.pubkey`; **`share.create` not exposed** (CLI-only).
- CLI: `share` + `verify-share` registered in `COMMAND_HANDLERS`. `nimbus share <session-id> [--redact <patterns>] [--expires <duration>] [--out <path>|--http <url>|--to-peer <peer>]`.
- **HTTP sink (`--http <url>`) config + auth** (design-review point 4): the target endpoint and any auth are configured in `nimbus.toml` `[share.http_sink]` (`url`, optional `auth_header_name`, and a Vault key name for the token value — the token itself is **Vault-only**, never in config). The sink POST runs through the same `share/safe-fetch.ts` SSRF guard. `--http` may only target the configured sink URL (or a prefix-match of it), not an arbitrary caller-supplied host.

### 6.6 Migration V41 — `share_records`

One row per **sent** share: `id`, `content_hash` (unique), `kind`, `session_id`, `created_at`, `expires_at`, `redaction_set_json`, `provenance_json`, `body_json` (redacted body — safe), `sig_json`, `sink`. Append-only; powers `share.list`/`share.get` and replay.

### 6.7 Invariant I27 / static D21

**Wiring** (`share/share-gate.ts`) + **docs** (`docs/SECURITY-INVARIANTS.md` + `CLAUDE.md` + skill) + **test** (`security-invariants.test.ts`) land in the same commit.

> **I27** — an outbound share leaves the machine only through `share/share-gate.ts`: default+caller redaction applied, the local owner approves the exact redacted bytes via the `share.publish` HITL action (I2 frozen set), the body is signed with the Vault-only `share.signing.privkey`, and the applied redaction-set is audit-logged. No other code path emits a share to a file sink, HTTP endpoint, or federation peer. The signing privkey is Vault-only and never leaves the process.

**Static D21** (`scripts/structure-audit/check-nimbus-invariants.ts`): confine share-emit calls + the `share.publish` action type + the `share.signing.privkey` Vault read to the gate site; fail-closed if referenced elsewhere.

## 7. Wave 8b — Recipe (PR2)

### 7.1 `share/recipe.ts`

`buildRecipeFromSession(db, sessionId)` reconstructs a **declarative tool-call DAG** deterministically from `tool_call_log` + `audit_log` — no LLM. Recipe shape:

```jsonc
{ recipeVersion: 1, sourceSessionId, generatedAt,
  steps: [ { stepId, tool, service, params(redacted), thresholds?, dependsOn: [stepId...] } ],
  graphTraversals: [ { fromEntity, relation, ... } ] }
```

Step ordering is the **execution order** (`called_at` ascending) — always present and authoritative. `dependsOn` edges are an *advisory* enrichment derived by a **conservative, documented value-matcher**, because Nimbus does not track parameter lineage today (design-review point 2):

- A `dependsOn` edge from step B → step A is inferred only when a **non-trivial** value appearing in B's redacted params also appears in A's `result_envelope`.
- "Non-trivial" excludes: booleans, numbers, strings shorter than 4 chars, and common low-entropy tokens (`true`/`false`/`null`/`""`) — these never create edges (avoids false dependencies from incidental scalar collisions).
- Only **identifier-shaped** values qualify: entity IDs, file paths, URLs/URNs, or strings ≥ 8 chars with mixed alphanumerics. The matcher walks nested structures but matches on leaf scalars, not whole subtrees.
- These limits are documented in `recipe.ts` and surfaced in the recipe (`dependsOn` is explicitly advisory; the ordered step list is the contract). Replay (§8) does not depend on `dependsOn` correctness — it executes steps in recorded order.

Serialized to deterministic **YAML** (`.nimbus-recipe.yaml`). The serializer uses **`js-yaml`** (already a declared `packages/gateway` dependency — not the root-only `yaml` devDep; no additional `bun add` required). Emit deterministic (stable-key-ordered) output so a recipe is content-addressable. **Migration V42** adds `tool_call_log.params_json` (secret-redacted at write) so recipe steps carry real params — resolving the "input args not stored" limitation from earlier waves.

### 7.2 `nimbus share <session> --as-recipe`

Routes through the **same** `share-gate` (redaction + HITL preview + sign), `body.kind="recipe"`, `body.recipe` populated, `turns` omitted (conversation stripped entirely). Recipe sharing therefore inherits I27 with zero new emit path. Also usable as a pure local artifact (write to file without forwarding).

## 8. Wave 8c — Replay (PR3, depends on 8b)

> Implemented 2026-06-17 via `share/recipe-runner.ts` + `share/read-tool-registry.ts` + `share.replay` IPC.

### 8.1 `share/recipe-runner.ts`

Deterministic, **LLM-free** executor. Read-only is enforced by a **positive allowlist, not a denylist** (design-review point 3 — a write tool absent from the frozen HITL set would otherwise execute). A step runs only when its `toolId` is positively classified read-only via `share/read-tool-registry.ts`, which sources its set from the connector tool declarations (the read tools — `*_list`/`*_get`/`*_query`/`*_search` and the curated read surface), **never** from "absent from `HITL_REQUIRED_BACKING`." For each step:

- `toolId` not positively read-only → **`skipped-non-read`** (fail-safe; never executed during replay);
- connector/tool not installed → `unavailable` (with the connector name — "you don't have connector X");
- otherwise execute read-only and capture the result.

Replay therefore never fires a write/HITL action, and never executes an un-classifiable or unknown tool.

### 8.2 `nimbus share verify --replay`

Load the shared recipe (or a transcript share's `toolCalls`), run the recipe-runner locally, **diff** each step's result against the shared original, and render a divergence report: per-step `match` / `diverged` / `missing-connector` / `skipped-non-read` / `error` + a summary. Read-only and deterministic — the "watch what ran on Asaf's data run on yours" demo, and the catch for "this only works because Asaf has connector X."

## 9. Wave 8d — Sovereign-mesh referral (PR4) · migration V43

### 9.1 Forwarding

`federation.shareForward` RPC sends a signed share to a paired peer over `sendFederatedOverWire` (authenticated, peer-pubkey-pinned). Forwarding **out** is a share-emit and therefore passes through the I27 gate.

### 9.2 Provenance (immutable inner + forwarding envelope)

The inner share `body`+`sig` are **immutable** and verifiable against the **origin** pubkey. The top-level **`forwarding` envelope** (§5, *outside* `canonicalize(body)`) carries `hops` + `chain[]` (`{ gatewayLabel, pubkey, sig }` per hop); each forwarder appends one entry and signs over `contentHash ++ prior-chain-entries` with its own federation key. `verify-share` validates content against the origin signature (always) and may *additionally* validate each hop signature against its claimed pubkey. The chain is advisory attribution and **cannot forge or mutate the content** — tampering with `body` breaks the origin `sig`; tampering with a hop breaks that hop's `sig` but never the content. A forwarder appending a hop does **not** re-sign or alter `body`.

### 9.3 Attribution chip

A received share/brief surfaces "forwarded from `<origin>`, N hops away" — a field on the record, rendered by CLI + Tauri.

### 9.4 Deferred-reveal install prompt

`share_inbox` (V43) holds pending forwarded shares keyed by recipient pubkey. A freshly-initialized Gateway, on first successful pair, **drains** pending shares from that sender and surfaces attribution + content. Inbound shares are stored as **viewable/replayable artifacts — never auto-merged into the index, no auto-execution** — so receiving needs no HITL, and the "no plaintext bootstrap" promise holds (the envelope is meaningless without a paired Gateway).

## 10. Schema summary

| Version | Wave | Table(s) |
|---------|------|----------|
| V41 | 8a | `share_records` (sent shares) |
| V42 | 8b | `tool_call_log.params_json` (recipe step params) |
| V43 | 8d | `share_inbox` (received / pending-forward, keyed by recipient pubkey) |

(8c adds no migration — replay is read-only; 8b adds V42 for recipe params; 8d adds V43.)

**Retention / pruning** (design-review point 5b): both tables are append-only and user-initiated (shares are deliberate, low-volume actions — not a sync firehose), so automatic background pruning is **deferred**. `share.list` filters expired entries by default (`--all` to include them), and a manual `nimbus share prune [--expired] [--before <date>]` is provided in 8a for housekeeping. A background reaper can be added later if real-world volume warrants it; tracked as a follow-up, not built now.

## 11. Testing strategy

- **I27 enforcement** in `security-invariants.test.ts` (gate is sole emit path; `share.publish` in frozen set; signing-key read confined). Static D21 in the structure-audit.
- **Redaction proofs**: each family (email/host/IP/slack-handle/credit-card/secret) verifiably stripped; property-style "no un-redacted value escapes."
- **Sign/verify**: round-trip; tamper-of-body fails; content-hash mismatch fails; wrong-pubkey fails. **Expiry is advisory**: an expired-but-genuine share returns `signatureValid: true` + `expired: true` (not a verification failure).
- **SSRF guard** (`safe-fetch.ts`): rejects loopback / link-local / RFC-1918 / non-http(s); validates the *resolved* address (DNS-rebind defense); `--http` rejects a host other than the configured sink.
- **Recipe**: deterministic reconstruction (same session → identical ordered steps); conversation fully stripped in recipe mode. **`dependsOn` matcher**: trivial scalars (bool/number/<4-char/`true`/`false`/`null`/`""`) create no edge; identifier-shaped values do; nested structures match on leaf scalars.
- **Replay**: divergence classification incl. `missing-connector` and **`skipped-non-read`**; positive-allowlist guarantee — an un-classified or write tool is `skipped-non-read`, never executed (assert with a fixture write tool absent from `HITL_REQUIRED_BACKING`).
- **Forwarding**: outer-`forwarding`-envelope append (body+sig byte-identical across hops); hop-signature verifies over `contentHash ++ prior chain`; provenance chain + hop count; deferred-reveal drain on first pair; tampered hop fails its own sig without affecting content verification.
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
| 8b | `--as-recipe` + declarative DAG | V42 | plan-8b |
| 8c | replay + recipe-runner | — | plan-8c ✅ shipped 2026-06-17 |
| 8d | sovereign-mesh referral | V43 | plan-8d ✅ shipped 2026-06-18 |
