# Phase 6 Slice 2 — Team Vault + Multi-user/Quorum HITL — Design

- **Status:** Draft for review
- **Date:** 2026-06-06
- **Branch:** `dev/asafgolombek/phase6-slice2-team-vault-quorum-hitl`
- **Builds on:** Slice 1 Federation Core (PR #519) + over-the-wire federation (PR #521) + Slice 3 Identity (PR #523)
- **Roadmap:** `docs/roadmap.md` → Phase 6 → Delivery Slice 2 (`Team Vault + Multi-user/Quorum HITL`)

## 1. Summary

Slice 2 makes credentials and approvals *team-scoped* without surrendering the local-first,
HITL-structural, no-plaintext-credential invariants. It ships **as one combined PR** covering three
interdependent subsystems unified by a single new primitive — **anchor-proxied federated tool
execution**:

1. **Team Vault** — one gateway is the *trust anchor* that holds shared secrets in its own OS Vault.
   Teammates never receive the secret; instead they ask the anchor to *run a named connector tool*
   using a team credential, and receive only the result. The secret never leaves the anchor.
2. **Multi-user / delegated HITL** — the workspace owner delegates HITL approval rights, scoped and
   time-boxed, to a named teammate. The delegate answers routed approval requests from a pending
   queue; every delegation is audited; both parties' local audit logs record each decision.
3. **Quorum HITL ("two-man rule")** — the most destructive actions require *N distinct federated
   peers* to approve within a bounded window before the anchor unlocks the credential and runs the
   tool. Enforced in the executor gate, not the prompt.

## 2. Non-negotiables honored

- **Local-first** — no relay; everything rides the existing Slice 1 NaCl-box LAN channel.
- **HITL is structural** — quorum and delegation extend the executor `gate()` (I2/I3/I4); they cannot
  be bypassed from the prompt or the wire.
- **No plaintext credentials** — team secrets live only in the anchor's OS Vault; they are injected
  in-process inside one gate and never placed in any outbound payload (new invariant **I19**).
- **MCP as connector standard** — the anchor runs the call through its own executor + connector mesh;
  no direct cloud calls are introduced.

## 3. Decisions (resolved during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Slice scope | **One combined Slice 2 spec + PR** (all three subsystems) |
| D2 | Team Vault consumption model | **Anchor-proxies the call** — peer never receives the secret |
| D3 | Quorum config home (policy engine deferred to Slice 4) | **`[hitl.quorum]` in `nimbus.toml`**, shaped for Slice 4 absorption |
| D4 | Delegation granularity | **Scoped (action-type / service) + time-boxed** |
| D5 | Federated-invoke placement | **New sibling gate `answerFederatedInvoke`** (do NOT overload the I17 read gate) |
| D6 | Quorum / approval in-flight state | **Session-only** (in-memory coordinator); the durable record is the audit row |
| D7 | Team Vault grant granularity | **Per `(entry, peer, tool)`** |
| D8 | Team secret → connector env mapping | **Reuse the connector's existing vault-key → env mapping**; team entries mirror `CONNECTOR_VAULT_SECRET_KEYS` under `teamvault.<entry>.<key>` (no new per-connector hardcoding) |
| D9 | Quorum denial semantics | **Fail-closed: a single explicit denial aborts the quorum immediately** (`quorum_denied`), distinct from timeout/partial (`quorum_failed`) |
| D10 | Delegated-approval timeout | **Timeout / offline → fall back to local owner prompt**; an explicit delegate denial is a rejection (no fallback) |
| D11 | Grant revocation latency | **DB live-check on every `federation.invoke`** (no in-memory permission cache) — matches I17 |
| D12 | Anchor restart mid-vote | **Fail-safe**: session-only state discarded, peer gets a clean transport error + may retry, no partial unlock ever persists |

### Deferred (out of scope for Slice 2)

- Admin console / web UI (Slice 4 — Admin & Observability).
- Multi-anchor / anchor failover / credential replication (exactly one anchor per team).
- Team Vault key rotation / versioning (put-overwrite, get-via-invoke, grant, revoke, delete only).
- Anchor-proxy of *arbitrary* tools — the invoke primitive is restricted to tools explicitly bound
  to a team-vault entry **and** allowlisted per grant.

## 4. Architecture

```text
                    TRUST-ANCHOR GATEWAY (holds team secrets in its own OS Vault)
                    ┌──────────────────────────────────────────────────────────────┐
 PEER B             │  federation.invoke  →  answerFederatedInvoke  (NEW gate)       │
 connector needs    │     ├─ I18 operator valid? ──────────────── no → opaque no_grant
 a team credential  │     ├─ TeamVaultStore.checkGrant(entry,peer,tool)  (RBAC)      │
   │ federation.    │     ├─ [hitl.quorum] requires N for action.type?               │
   │   invoke       │     │      → QuorumCoordinator.collect()  (I21: N distinct     │
   ├───────────────►│     │         authenticated peerIds within window)             │
   │ (NaCl box)     │     ├─ executor.gate()   (I2/I3/I4 — anchor-local HITL)        │
   │                │     ├─ inject teamvault.<entry> secret from OS Vault (in-proc) │
   │  results only ◄┤     └─ wrapToolOutput (I11) → return result, NEVER the secret  │
   │                └──────────────────────────────────────────────────────────────┘
```

New code lives in:

- `packages/gateway/src/teamvault/` — `TeamVaultStore` (metadata + RBAC), `team-vault-keys.ts`
  (reserved `teamvault.<entry>` vault keyspace + D15 anchor).
- `packages/gateway/src/federation/invoke-gate.ts` — `answerFederatedInvoke` (the I19 gate).
- `packages/gateway/src/engine/quorum/` — `QuorumCoordinator` (I21).
- `packages/gateway/src/engine/` — `DelegationStore` + the executor gate's remote-approval path (I20).

Everything else — the Slice 1 read path (I17), identity (I18), local vault (I5/I12), LAN bind (I6) —
is untouched.

### Component 1 — Team Vault

- **`TeamVaultStore`** persists *only* metadata + grants (V35). Secret bytes live in the anchor's OS
  Vault under a reserved team keyspace that **mirrors the connector's own vault keys** —
  `teamvault.<entry>.<connectorKey>` (e.g. `teamvault.prod-aws.aws.access_key_id`,
  `teamvault.prod-aws.aws.secret_access_key`). The store never holds plaintext. **Injection reuses the
  connector's existing vault-key → env-var mapping** — a team entry is simply a team-scoped copy of the
  keys the connector already expects (those declared in `CONNECTOR_VAULT_SECRET_KEYS` for
  `team_vault_entries.service`), so no new per-connector mapping logic is added (D8). The anchor's
  cred-injection, at invoke time, reads `teamvault.<entry>.<key>` instead of the local `<key>` for the
  bound service.
- **`answerFederatedInvoke`** is the sole consumption path. It performs identity → RBAC → quorum →
  `executor.gate()` → in-process secret injection → `wrapToolOutput`. The secret is read from the OS
  Vault only at injection time and is dropped after the connector call. **RBAC is a direct SQLite read
  on every request** (`TeamVaultStore.checkGrant`) — no in-memory permission cache — so a revoked grant
  stops the next invoke within one cycle (D11, mirroring I17 revocation).
- **Invariant I19** — a team secret is injected only inside `answerFederatedInvoke`, only after RBAC
  and quorum pass, and is never placed in any outbound payload. Runtime test asserts (a) the injection
  site is intrinsic to the gate and (b) the invoke result shape carries no secret-shaped fields.
  Static **D15** asserts the `teamvault.` vault-key prefix appears only under `teamvault/`
  (the D11 mechanism is connector-scoped and will not catch this — a purpose-built check is required,
  exactly as I18/D14 needed one).

### Component 2 — Multi-user / delegated HITL

- **`DelegationStore`** (V35): `delegate_peer`, `scope_kind ∈ {action_type, service}`, `scope_value`,
  `expires_at`, `revoked_at`.
- The executor `gate()` gains a remote-approval branch: when an action needs HITL and an active,
  in-scope delegation matches, the consent request is routed over the federation consent-broker
  round-trip to the delegate. The delegate sees it via `hitl.pendingQueue` and answers
  `federation.approvalRespond`.
- **Invariant I20** — a remote approval is honored only when the answering peer holds a *live,
  in-scope* delegation **and** is I18-valid. This is verified in the gate; the wire is never trusted.
- **Timeout / offline fallback (D10):** if the delegate is offline or does not answer within the
  delegated-approval timeout, the gate falls back to a local owner prompt — the owner always retains
  authority and workflows never hang indefinitely. An explicit delegate *denial* is honored as a
  rejection and does **not** fall back (a denial is a decision, not an absence of one).
- Both the delegator's and the delegate's local audit logs record the decision (acceptance criterion).

### Component 3 — Quorum HITL

- **`[hitl.quorum]`** maps `action.type → { approvers, windowSeconds }`. Default empty (quorum off
  unless configured). Typed loader in `config/nimbus-toml.ts`; shaped so a Slice 4
  `nimbus.policy.toml` can override/absorb it.
- **`QuorumCoordinator`** fans the approval request to eligible peers, collects votes via
  `federation.quorumRespond`, and succeeds only on **N distinct authenticated peerIds within the
  window**. A single approval leaves the credential locked and audits the partial approver set.
  **Fail-closed denial (D9):** a single explicit *denial* aborts the quorum immediately (audited
  `quorum_denied`), distinct from a timeout / never-reaching-N within the window (audited
  `quorum_failed`). This prevents approval-spamming a denied request until someone approves.
- **Invariant I21** — distinct-peer counting is intrinsic to the coordinator (no self-approval, no
  double-count); the executor cannot run a quorum-classified action without it.

## 5. Data flow

**Flow A — Team Vault invoke (no quorum).**

1. Peer B's cred-injection resolves to a team-vault binding → B calls
   `federation.invoke{ entry, toolId, args, purpose }` over the NaCl channel.
2. Anchor A's `onMessage` forces `peerId = peerIdFor(authPubkey)` (I17/R1 — body peerId cannot
   impersonate).
3. `answerFederatedInvoke`: I18 operator-valid → `TeamVaultStore.checkGrant(entry, peerId, toolId)`.
   Either failure → audit + opaque `no_grant` (entry existence not leaked).
4. No quorum configured for the action-type → skip.
5. Anchor runs the tool through its own `executor.gate()` (anchor-local HITL applies if the
   action-type is HITL-gated), injecting `teamvault.<entry>` from the OS Vault in-process only.
6. `wrapToolOutput` (I11) → result returned. Audit row on A with
   `{peerId, entry, toolId, decision, hitlStatus}` in `audit_log.federation_json`.

**Flow B — Quorum invoke.** Identical to A, except step 4 finds `[hitl.quorum]` requires
`N`/`windowSeconds` → `QuorumCoordinator.collect()` broadcasts approval requests; approving peers
answer `federation.quorumRespond`; the coordinator counts distinct authenticated peerIds (I21). On
`N`-in-window → unlock + run (step 5). On timeout/partial → credential stays locked; audit
`quorum_failed` with the partial approver set. **Any single explicit denial aborts immediately** →
credential stays locked; audit `quorum_denied` (D9).

**Flow C — Delegated approval.** An action needing HITL fires on B. `gate()` finds an active,
in-scope delegation → routes the consent request to the delegate over the consent-broker round-trip.
Delegate answers `federation.approvalRespond` from `hitl.pendingQueue`. Gate verifies the answerer's
live in-scope delegation + I18 validity (I20) before honoring. If the delegate is offline/unresponsive
past the timeout, the gate falls back to the owner prompt (D10). Both audit logs record it.

## 6. Schema — V35 (additive, forward-only; `simpleStep` pattern)

> Latest shipped migration is **V34** (Slice 3 Identity). Slice 2 takes **V35**. Confirm
> `origin/main` is still V34 before trusting this (recalled-version-is-verify-before-act).

```sql
-- Team Vault: metadata + RBAC only; secret bytes stay in the OS Vault under teamvault.<entry>.<connectorKey>
CREATE TABLE team_vault_entries (
  entry        TEXT PRIMARY KEY,        -- e.g. "prod-aws"
  service      TEXT NOT NULL,           -- connector service id this entry credentials
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL            -- operator externalId / "owner"
);
CREATE TABLE team_vault_grants (
  entry        TEXT NOT NULL,
  peer_id      TEXT NOT NULL,
  tool_id      TEXT NOT NULL,           -- allowlisted tool per grant (deferral #4)
  mode         TEXT CHECK(mode IN ('use')) NOT NULL,
  granted_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  PRIMARY KEY (entry, peer_id, tool_id)
);

-- Multi-user HITL: scoped + time-boxed delegations
CREATE TABLE hitl_delegations (
  delegation_id TEXT PRIMARY KEY,
  delegate_peer TEXT NOT NULL,
  scope_kind    TEXT CHECK(scope_kind IN ('action_type','service')) NOT NULL,
  scope_value   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,       -- time-box
  revoked_at    INTEGER
);
```

**No quorum table.** Quorum in-flight state and the delegated-approval pending queue are
session-only (in-memory coordinator), mirroring the over-the-wire consent that ceded V34. The durable
record in both cases is the audit row.

## 7. Surfaces

### IPC / federation methods

**New LAN-admitted (over-the-wire, RBAC-gated) — added to the LAN-admitted set:**

- `federation.invoke` — anchor-proxy execution gate (Flows A/B).
- `federation.quorumRespond` — an approving peer's quorum vote (Flow B).
- `federation.approvalRespond` — a delegate's answer to a routed HITL request (Flow C).

**New local/Tauri-only (management) — FORBIDDEN_OVER_LAN (I5), like `federation.pair`/`vault.*`:**

- `teamvault.put` / `teamvault.delete` — anchor owner writes/removes a secret (writes OS Vault +
  store metadata). **HITL-gated** — added to `HITL_REQUIRED` alongside `vault.set`/`vault.delete`.
- `teamvault.grant` / `teamvault.revoke` / `teamvault.list` — RBAC management.
- `hitl.delegate` / `hitl.revokeDelegation` / `hitl.listDelegations` — delegation management.
- `hitl.pendingQueue` — the delegate's inbound approval queue.

### Tauri allowlist (I7)

Current `ALLOWED_METHODS` = **74**. Add the read/queue/vote methods
(`teamvault.list`, `hitl.listDelegations`, `hitl.pendingQueue`, `federation.quorumRespond`,
`federation.approvalRespond`). **Renderer-forbidden** (RCE-class, like `vault.set`): `teamvault.put`,
`teamvault.delete`, `hitl.delegate`, `hitl.revokeDelegation`. Final count pinned during
implementation and mirrored in the `security-invariants.test.ts` `assert_eq!`-mirror assertion.

### CLI — `nimbus team` (`packages/cli/src/commands/team.ts`)

Add subcommands to **both** `COMMAND_HANDLERS` and the registry `COMMAND_NAMES` (audit:readme-cli
validates the registry):

- `nimbus team vault put|grant|revoke|list <entry> …`
- `nimbus team invoke <peer> <entry> <tool> …` (asker side)
- `nimbus team delegate <peer> --scope … --expires …` / `team delegations`
- `nimbus team approve|deny <reqId>` (serves both quorum votes and delegated approvals; the
  coordinator dedupes by peer)

### Config — `[hitl.quorum]` in `nimbus.toml`

```toml
[hitl.quorum]
"terraform.destroy" = { approvers = 2, windowSeconds = 300 }
"db.drop"           = { approvers = 2, windowSeconds = 300 }
```

Typed loader in `config/nimbus-toml.ts`; default empty map.

## 8. Security invariants (triple rule: wiring + docs + test land together)

| ID | Statement | Wiring site | Enforcement |
|----|-----------|-------------|-------------|
| **I19** | Team secrets injected only inside `answerFederatedInvoke`, after RBAC+quorum, never in an outbound payload | `federation/invoke-gate.ts`, `teamvault/team-vault-keys.ts` | runtime test (injection site + leak-proof result shape) + static **D15** (`teamvault.` prefix only under `teamvault/`) |
| **I20** | Delegated approval honored only when answerer holds a live in-scope delegation + is I18-valid | `engine/executor.ts` gate remote-approval branch | runtime test (forged/expired delegation rejected) |
| **I21** | Distinct-peer quorum counting intrinsic to `QuorumCoordinator`; executor cannot run a quorum-classified action without it | `engine/quorum/quorum-coordinator.ts` | runtime test (self-approval + double-count rejected; single approval leaves credential locked) |

All three add rows to `docs/SECURITY-INVARIANTS.md`, cases to
`packages/gateway/src/security-invariants.test.ts`, and a line to the CLAUDE.md / GEMINI.md I-list —
in the same commit as the wiring. D15 is added to `scripts/structure-audit/check-nimbus-invariants.ts`.

## 9. Error handling

- RBAC / identity failure → opaque `no_grant` (no entry-existence leak); the real reason is audited
  locally. Same shape as I17/I18.
- Quorum timeout / partial → credential stays locked; `quorum_failed` audit with the partial approver
  set. Business errors travel as a resolved `{ kind: "error", error }` over the wire (not a throw),
  per the Slice 1 wire-error convention.
- Delegation expired mid-flight → treated as no delegation; falls back to the owner prompt.
- Delegate offline / no response past the timeout → fall back to the owner prompt (D10); an explicit
  delegate denial is honored as a rejection (no fallback).
- **Anchor restart mid-vote (D12)** — in-flight quorum / delegation state is session-only, so a
  restart discards it. The requesting peer receives a clean transport error (connection reset / RPC
  timeout) and may safely retry. A credential is unlocked only when full quorum is met within a single
  live session, so a restart can **never** leave a partial unlock or a half-applied action.

## 10. Testing

- **HITL gate tests** prove quorum + delegation fire for every gated action-type *before* any
  credential unlocks.
- **Team Vault test** proves no secret escapes `federation.invoke` (the I19 leak test).
- **Integration** extends the in-process two-gateway NaCl harness
  (`test/integration/federation/two-gateway-wire.integration.test.ts`) and adds a **three-gateway**
  case (anchor + two approvers) for quorum.
- **Acceptance criteria** covered: a quorum-gated credential stays locked on a single approval; a
  delegated approval is recorded in both the approver's and the owner's local audit log.
- **Coverage** — new glue/boot/CLI files are added to **both** `scripts/coverage-floor/exclusions.ts`
  and `sonar-project.properties` `sonar.coverage.exclusions` (the parity trap from Slice 1).
- Run `cd packages/gateway && bunx tsc --noEmit` per task (`bun test` transpiles but does not
  full-typecheck). Docker-verify `audit:coverage-floor` (Linux-authoritative).

## 11. Acceptance criteria (from roadmap)

- A team member's HITL approval on a shared workflow is recorded in both the approver's and the
  workspace owner's local audit log.
- A quorum-gated action (e.g. `terraform destroy`) does not unlock its Team Vault credential until two
  distinct federated peers approve within the configured window; a single approval leaves the
  credential locked and logs the partial approval.
- Revoking a peer's team-vault grant stops further `federation.invoke` success for that
  `(entry, tool)` within one cycle (live-checked, like I17 revocation).

## 12. Open coordination notes

- Verify `origin/main` is still at **V34** before claiming V35 (migration contiguity — a prior slice
  ceded a version once; recalled state must be re-verified).
- New shared hot files churned by every Phase 6 slice (expect additive "keep both" rebase conflicts):
  `lan-rpc` FORBIDDEN list, `federation-rpc` ctx, `dispatchers.ts` ctx construction,
  `assemble.ts` boot binds, `security-invariants.test.ts` count, Tauri allowlist.

## 13. Design-review resolutions (2026-06-06)

Resolutions of the points raised in
`2026-06-06-phase6-slice2-team-vault-quorum-hitl-design-review.md`:

1. **Secret → connector env mapping** → **fixed (D8).** Team entries mirror the connector's existing
   vault keys under `teamvault.<entry>.<key>`; injection reuses the connector's existing
   vault-key → env-var mapping. See §4 Component 1 + §6.
2. **Quorum denial semantics** → **fixed (D9).** A single explicit denial aborts immediately
   (`quorum_denied`), fail-closed. See §4 Component 3 + §5 Flow B + §9.
3. **Offline delegate / timeout fallback** → **fixed (D10).** Timeout/offline falls back to the owner
   prompt; an explicit denial is a rejection. See §4 Component 2 + §5 Flow C + §9.
4. **Zero-latency grant revocation** → **fixed (D11).** `checkGrant` is a direct SQLite read per
   `federation.invoke`, no permission cache. See §4 Component 1 + §11.
5. **Session-only state resiliency on restart** → **fixed (D12).** Restart discards in-flight state;
   peer gets a clean transport error and may retry; no partial unlock can persist. See §9.

Reviewer note on invariant alignment: the Tauri allowlist count lives in
`packages/ui/src-tauri/src/gateway_bridge.rs` (`ALLOWED_METHODS`) with a TS mirror assertion in
`security-invariants.test.ts` — **not** `tauri.conf.json` (that file carries the CSP, invariant I8).
§7 already reflects the correct sites; no spec change needed.
