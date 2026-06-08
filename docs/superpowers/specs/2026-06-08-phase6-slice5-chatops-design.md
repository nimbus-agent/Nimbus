# Phase 6 Slice 5 — ChatOps (Slack/Teams bot, HITL-via-chat) — Design

- **Status:** Draft for review
- **Date:** 2026-06-08
- **Branch:** `dev/asafgolombek/phase6-slice5-chatops`
- **Builds on:** Slice 1 Federation Core (PR #519/#521 — I17 query gate, namespaces/RBAC) + Slice 2 Team Vault / Quorum HITL (I19/I20/I21) + Slice 3 Identity (PR #523 — I18, SCIM/OIDC) + Slice 4 Org Policy (PR #538 — I22 signed policy, `PolicyGate`/`EnforcedPolicy`)
- **Roadmap:** [`docs/roadmap.md`](../../roadmap.md) → Phase 6 → "ChatOps" (Slice 5; depends on Slices 1 + 2)

## 1. Summary

Slice 5 turns Nimbus into a **bidirectional ChatOps surface**: team members talk to the shared
Gateway with `@nimbus` in a Slack or Teams channel. Read queries are answered from the shared index;
write commands route through the **executor's HITL gate** before executing — the bot is *just another
client of the consent gate*, never a bypass.

The load-bearing idea: **the bot is an edge transport, not a privilege.** A chat message carries no
authority of its own. Every inbound message is (1) mapped to a real Nimbus identity (Slice 3
SCIM/OIDC), (2) scoped to a namespace by signed org policy (Slice 4), and (3) for writes, gated by the
*resource owner's* HITL approval (reusing the Slice 2 I20 delegated-approval path) plus any
policy-mandated quorum (I21). The bot can never exceed the requesting user's authorised scope, and it
can never post to a destination it wasn't invoked from or explicitly configured for — a new structural
invariant **I23** (static **D17**) codifies that last property so the operational-post path cannot be
used to launder the HITL-gated `*.message.post` action.

Slice 5 ships as **one combined PR** spanning the build lanes in §13.

## 2. Non-negotiables honored

- **Local-first** — Slack arrives over an **outbound** Socket Mode WebSocket (no inbound port, no
  public URL); Teams arrives on the existing I13 HTTP write surface (operator-provided ingress, a
  documented deployment choice, off by default). A Gateway with ChatOps disabled runs fully.
- **HITL is structural** — write commands reach `executor.gate()` exactly like any other action; the
  bot supplies an `action.type`, never a bypass. Owner-routing is layered *on top of* the gate via the
  I20 delegated-approval path; quorum (I21) stacks unchanged. The bot cannot weaken or skip the gate.
- **No plaintext credentials** — the bot token (Slack app-level + bot token; Teams app id/password) is
  **Team-Vault-only** (Slice 2), injected into the connector subprocess at spawn; never in IPC, logs,
  or config. Added to the vault-key allow-list.
- **MCP as connector standard** — every Slack/Teams cloud call (open socket, post message, look up a
  user's email) is performed by the first-party `slack`/`teams` MCP connectors. The Gateway
  `chatops/` subsystem orchestrates but never calls a cloud API directly.
- **Platform equality** — no OS-specific committed code; paths via `path.join`; the subsystem is pure
  TS with DI seams for the transports.
- **No `any`** — `unknown` for all inbound wire payloads (Slack/Teams event envelopes), parsed through
  explicit validators; strict mode throughout.

## 3. Decisions (resolved during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Inbound transport | **Both, transport-abstracted.** A transport-agnostic bot core with two adapters: Slack via **Socket Mode** (outbound WS, local-first-friendly); Teams via **webhook** on the I13 HTTP write surface. |
| D2 | Unmapped-user policy | **Configurable per channel** via signed org policy: `refuse` (default) or `public-read` (reads limited to a designated public namespace; writes always refused). |
| D3 | Write HITL routing | **Route to resource owner.** A write's HITL approval is posted to the resolved *owner* of the targeted resource, reusing the I20 delegated-approval path; quorum (I21) stacks if policy mandates. |
| D4 | Owner registry | **In signed org policy TOML** (`[policy.chatops.ownership]`, resource glob → owner email). Inherits I22 signed + monotonic-stricter + fail-closed machinery. |
| D5 | Command parsing | **Hybrid.** Reads = free-form NL → engine (`ask`) scoped to the mapped user (I17/I11 leak-proof). Writes = explicit structured grammar (`@nimbus run <action> k=v…`) resolving to a known HITL-declared tool; ambiguous/unknown → **refused, never guessed**. |
| D6 | Connector strategy | **Extend** the existing `slack` + `teams` MCP connectors (add Socket-Mode-open / post / user-lookup tools); do **not** create new bot connectors. |
| D7 | Outbound-post defense | New structural invariant **I23** + static **D17**: the ChatOps reply dispatcher may post only to the originating channel or a policy-designated notification channel; destination is never caller-free-form; channel↔namespace resolved from signed policy; structurally separate from the HITL-gated `*.message.post` tools. |
| D8 | Notification routing | Extend the watcher `notify(title, body)` callback so a watcher rule can target a ChatOps channel, resolved per-rule and per-namespace through the reply dispatcher (I23). |

### 3.1 Explicit non-goals (deferred)

Threaded multi-turn conversations / conversational memory across messages; Slack slash-command or
shortcut auto-registration UIs; rich Block Kit / Adaptive Cards beyond a plain answer + a single
Approve/Reject card; editing resource ownership *via chat* (ownership is edited only via signed
policy on the anchor); resolving owner from anything other than the policy glob (no
git-CODEOWNERS / service-catalog lookup — that is Slice 6/7 territory); the Phase 7 `@nimbus
excellence` shortcut; SAML-mapped identities (Slice 3 deferred SAML); arbitrary outbound DMs.

## 4. Architecture

### 4.1 Subsystem placement

A new top-level `packages/gateway/src/chatops/` (parallel to `federation/`, `identity/`, `policy/`),
plus tool additions inside the existing `packages/mcp-connectors/{slack,teams}` packages, plus a
`[policy.chatops.*]` extension to `packages/gateway/src/policy/`.

```text
packages/gateway/src/chatops/
  types.ts                       # ChatMessage, ChatCommand, ChatIdentity, ReplyTarget, wire shapes
  chatops-config.ts              # [chatops] nimbus.toml: enabled, platforms, channel bindings
  chatops-service.ts             # lifecycle: start/stop adapters, hold the router; built at boot
  command-parser.ts              # NL-vs-`run` split; structured write grammar → ParsedCommand
  intent-router.ts               # route read→engine / write→executor.gate; assemble reply
  identity-mapper.ts             # Slack/Teams user → email → SCIM/OIDC Nimbus identity (Slice 3)
  owner-resolver.ts              # resource → owner identity via EnforcedPolicy ownership globs
  reply-dispatcher.ts            # I23: bounded outbound post (originating / notification channel only)
  approval-presenter.ts          # render + track Approve/Reject cards; map click → consent.respond
  transport/
    transport.ts                 # ChatTransport interface (DI seam; onMessage, postReply, openCard)
    slack-socket-adapter.ts      # outbound Socket Mode lifecycle via slack connector tools
    teams-webhook-adapter.ts     # inbound webhook (I13) + outbound via teams connector tools
```

### 4.2 The two kinds of outbound post (the heart of the security model)

| Kind | Example | Path | HITL? |
|------|---------|------|-------|
| **Operational post** | bot answers a query; posts an approval card; posts a watcher alert | `reply-dispatcher.ts` (I23) | **No** — ChatOps transport, bounded destination |
| **User-initiated send** | `@nimbus run slack.message.post channel=#general text=…` | `executor.gate()` → `slack`/`teams` connector write tool | **Yes** — unchanged `*.message.post` HITL |

I23 ensures the operational path cannot post to an arbitrary destination, so it can never be used to
emit a `slack.message.post`-equivalent without the gate. Destination is resolved by the dispatcher
from `{ originating channel of the triggering message }` ∪ `{ notification channels declared for the
namespace in signed policy }` — never from caller-supplied text.

### 4.3 Inbound flow

```text
Slack Socket Mode WS  ─┐
                       ├─► transport adapter ─► ChatMessage
Teams webhook (I13)   ─┘     {platform, channelId, userId, text, ts, raw(verified)}
                                   │  (HMAC / signing-secret verified at the adapter edge)
                                   ▼
                 identity-mapper:  userId ─►(connector user-lookup)─► email ─► SCIM/OIDC identity
                                   │           unmapped ─► channel policy (refuse | public-read)
                                   ▼
                 channel policy:   channelId ─► namespace + unmapped mode  (EnforcedPolicy, I22)
                                   │
                 command-parser:   text starts with `run ` ?  ─► WRITE grammar : READ (free NL)
                   ┌───────────────┴────────────────────────────┐
                 READ                                          WRITE
                 engine.ask(query, scope=identity's namespaces) parse `run <action> k=v…`
                 (I17 federated reads / I11 envelope; leak-proof) → known HITL tool? else REFUSE
                 reply-dispatcher.post(answer)  (I23)            → owner-resolver(resource) → owner id
                                                                 → executor.gate(action, requester=identity)
                                                                    via I20 delegated-approval:
                                                                    approver := resolved owner
                                                                 → approval-presenter posts card to owner
                                                                    (reply-dispatcher, I23)
                                                                 → owner clicks Approve/Reject
                                                                    must be identity-valid (I18) AND
                                                                    clicker == resolved owner
                                                                 → quorum? I21 adds N distinct peers
                                                                 → consent.respond → execute as
                                                                    requester's scope
                                                                 → decision audited w/ approver identity
                                                                 → reply-dispatcher posts outcome (I23)
```

Two independent controls protect a write: **authorisation** (the requester must be in scope for the
action; the bot never exceeds it) and **HITL consent** (the resource owner must approve). They are
separable: the owner ≠ requester is the normal case.

### 4.4 Identity mapping

`identity-mapper.ts` resolves a platform user id to a Nimbus identity:

1. Look up the platform user's **email** via a read-only connector tool (`slack_user_info` /
   `teams_user_info` — added if absent).
2. Match the email against the Slice 3 SCIM user store (`getScimUser` keyed by email) / active OIDC
   session; the identity must be **identity-valid** (`isOperatorValid`, I18) to authorise any write.
3. No match → apply the channel's `unmapped` policy mode (refuse | public-read).

The mapping is **never** trusted from message text; only the platform-asserted (signature-verified)
user id is used as the lookup key.

## 5. Policy schema extension (Slice 4)

Added to `policy-toml.ts` + `EnforcedPolicy` (still signed + monotonic-stricter + fail-closed, I22):

```toml
[policy.chatops.channel."C0SLACK1"]      # Slack channel id or Teams channel id
namespace = "project:payments"
unmapped  = "refuse"                       # "refuse" (default) | "public-read"
notify    = ["C0SLACK1"]                   # channels the dispatcher may push notifications to

[policy.chatops.ownership]
"payment-service" = "alice@acme.com"
"payment-*"       = "pay-lead@acme.com"
"*"               = "oncall@acme.com"      # fallback owner
```

Resolution rules:
- **Channel → namespace:** exact channel-id match; no match → channel is not ChatOps-enabled →
  message ignored (fail-closed; the bot only acts in explicitly-bound channels).
- **Resource → owner:** longest/most-specific glob wins; the `*` fallback is required for any write
  to be approvable (no fallback + no specific match → **refuse**, fail-closed).
- Monotonic-stricter still holds: ChatOps policy can only *add* constraints; it never loosens an
  existing HITL/quorum requirement. A missing `[policy.chatops]` block means ChatOps is ungoverned
  → **all channels closed** (fail-closed: ChatOps does nothing until policy binds a channel).

## 6. Invariant I23 (new) — bounded ChatOps reply surface

> **The ChatOps reply dispatcher (`chatops/reply-dispatcher.ts`) is the only path that emits an
> operational (non-HITL) Slack/Teams post. It posts only to (a) the channel of the triggering inbound
> message, or (b) a `notify` channel declared for the message's namespace in the signed org policy.
> The destination is derived from server-side state (the inbound `ChatMessage` / `EnforcedPolicy`),
> never from caller-supplied free-form input. Arbitrary-destination posting is only possible via the
> HITL-gated `*.message.post` action types (I2).**

- **Wiring:** `chatops/reply-dispatcher.ts` — the dispatcher takes a `ReplyTarget` that is a
  *reference* (originating-message handle or namespace id), not a raw channel string from the caller.
- **Docs:** `docs/SECURITY-INVARIANTS.md` I23 row (rationale + anti-pattern: "do not let the bot
  accept a destination channel as a command argument").
- **Test:** `security-invariants.test.ts` — proves the dispatcher rejects a destination not in
  `{originating, policy-notify}` and that no non-dispatcher module imports the connector post tool.
- **Static D17:** `scripts/structure-audit/check-nimbus-invariants.ts` — the connector `*_message_post`
  / Socket-Mode-post tool is referenced only from `chatops/transport/*` and the executor's HITL path;
  no other `chatops/*` module may post directly (must go through the dispatcher).

Triple rule: wiring + docs + test land in the **same commit**; the static D17 lands with them.

## 7. IPC surface

New `chatops.*` namespace (`ipc/chatops-rpc.ts`, `dispatchByMethod`), **local/Tauri-read-only**, never
LAN-admitted:

- `chatops.status` → `{ enabled, platforms: [{name, connected, channels}], lastEventAt }`
- `chatops.start` / `chatops.stop` → toggle adapters at runtime (local-only; not Tauri)
- `chatops.test` → dry-run parse a message string (no send), for operator debugging

Tauri allowlist (I7): only `chatops.status` is renderer-callable (read-only); start/stop/test stay
CLI-only. LAN forbidden-set (I5): the whole `chatops.*` namespace is added to `FORBIDDEN_OVER_LAN`.

**Teams inbound route (I13):** `POST /v1/messaging/teams/events` added to `WRITE_ROUTE_ALLOWLIST`
(5→6 after Slice 4's policy route), bearer-or-HMAC authenticated at the route, body-size capped,
rejections audited.
Slack needs no inbound route (Socket Mode is outbound).

## 8. Connector additions (Slice-6 MCP, AGPL)

`slack` connector — add: `slack_socket_open` (long-lived; streams events as MCP notifications back to
the adapter), `slack_chat_post` (operational post; bot-token), `slack_user_info` (email lookup).
`teams` connector — add: `teams_chat_post`, `teams_user_info`. The operational post tools
(`slack_chat_post` / `teams_chat_post`) are **distinct tools** from the existing HITL-gated
`slack.message.post` / `teams.message.post` action types — they are **not** in `HITL_REQUIRED_BACKING`
and are reachable **only** from the reply dispatcher (enforced by D17), so they never enter
`executor.gate()`. The HITL-gated `*.message.post` tools are unchanged and remain the only
arbitrary-destination send path. Bot tokens added to `CONNECTOR_VAULT_SECRET_KEYS`
(Team-Vault-stored). Contract tests assert the new tools exist and that read-only connectors expose no
unexpected write surface.

> **Open implementation question for the plan:** MCP is request/response; a Socket Mode *stream* is
> the one unusual shape. The plan's first task spikes whether to model it as (a) a streaming MCP tool
> with server-initiated notifications consumed by the adapter, or (b) the adapter holding the WS
> directly using a connector-provided short-lived `apps.connections.open` URL (still "connector does
> the cloud call" for the open; adapter only owns the socket). Decision recorded before lane wiring.

## 9. Testing strategy

- **I23** runtime test + static D17 (bounded destination; dispatcher is sole operational-post path).
- **Identity mapping** fail-closed: unmapped → refuse / public-read per channel; non-identity-valid →
  no write authorised.
- **Command parser:** read vs `run` split; unknown/ambiguous write → refused; grammar edge cases.
- **Owner routing:** correct owner resolved by glob; non-owner Approve click rejected; quorum stacks;
  audit records approver identity; fallback-owner-absent → refuse.
- **Policy:** channel→namespace binding; unbound channel ignored; monotonic-stricter preserved.
- **E2E:** real Gateway subprocess + **mock Slack Socket Mode server + mock Teams webhook**; no real
  cloud. Asserts: read answered & scoped; write produces a card to the owner; approve → executes;
  reject → blocked; both audited.
- **Coverage:** `chatops/` held to the engine-tier floor; verified via the **CI-Linux-authoritative**
  Docker coverage-floor recipe, not local `--coverage`. Prefer **DI over `mock.module`** for the
  transport seam (avoids the combined-CLI-run contamination trap).

## 10. CLI surface

`nimbus chatops status` / `start` / `stop` / `test "<message>"` (maps to the `chatops.*` IPC).
Documented in `docs/cli-reference.md`.

## 11. Acceptance criteria

1. `@nimbus who's on call for payment-service?` in a bound channel returns an index-scoped answer for
   a mapped user, with no live cloud call beyond the connector read.
2. `@nimbus run deploy.rollback service=payment-service version=v1.4` posts an Approve/Reject card to
   the resolved owner; only the owner's identity-valid click approves; approval executes as the
   *requester's* scope and is recorded in the audit chain with the approver's identity.
3. An unmapped user in a `refuse` channel gets a refusal for both reads and writes; in a
   `public-read` channel gets a read limited to the public namespace and a refusal for writes.
4. The reply dispatcher refuses to post to a destination outside `{originating, policy-notify}`
   (I23 test green; D17 static green).
5. A watcher rule configured to notify a ChatOps channel posts its alert through the dispatcher to the
   correct channel for the namespace.
6. `bun run preflight:fast` green; scoped `bun test` for `chatops/` green; coverage-floor green via
   Docker.

## 12. Risks & mitigations

- **Socket Mode in an MCP request/response world** — spiked in the plan's first task (§8 open
  question); fallback is adapter-owned WS with connector-provided open URL.
- **Prompt injection from channel text** — reads go through the I11 envelope; writes never inferred
  from NL (structured grammar only, D5), so injection cannot synthesise a destructive action.
- **Reply-path laundering of `*.message.post`** — closed by I23 + D17 (bounded destination, separate
  path).
- **Identity spoofing** — only the platform-asserted, signature-verified user id is used as the
  mapping key; message text is never trusted for identity.
- **Teams ingress bends local-first** — off by default; documented as an explicit operator opt-in;
  Slack (the local-first-clean path) is fully functional without it.

## 13. Build lanes (one combined PR)

1. **Spike + types** — `chatops/types.ts`, `transport/transport.ts`, Socket-Mode-shape decision (§8).
2. **Policy extension** — `[policy.chatops.*]` parse + `EnforcedPolicy` fields + resolution + tests.
3. **Identity mapper + owner resolver** — Slice 3 / policy lookups + fail-closed tests.
4. **Command parser** — NL/`run` split + write grammar + refusal tests.
5. **Reply dispatcher + I23/D17** — bounded post + invariant test + static check + docs row.
6. **Intent router + approval presenter** — read→engine, write→gate (I20 owner-routing), card lifecycle.
7. **Connector tools** — slack/teams additions + vault keys + contract tests.
8. **Transports** — Slack Socket Mode adapter; Teams webhook route (I13 allowlist 5→6).
9. **IPC + CLI + Tauri/LAN allowlists** — `chatops.*` + `nimbus chatops`.
10. **Watcher notification routing** — extend `notify` callback → dispatcher.
11. **E2E + docs** — mock-cloud E2E; roadmap row check; SECURITY-INVARIANTS I23; CHANGELOG; cli-reference.

Each lane is implemented and reviewed task-by-task (two-stage review) per
`superpowers:subagent-driven-development`.
