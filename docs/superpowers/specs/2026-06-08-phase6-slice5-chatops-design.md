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
excellence` shortcut; SAML-mapped identities (Slice 3 deferred SAML); arbitrary outbound DMs;
**group / distribution-list / multi-owner resource ownership** (an owner is a single SCIM email this
slice — review Q3, deferred to whenever a service-catalog owner source lands).

### 3.2 Review resolutions (2026-06-08)

Dispositions of the design-review items in
[`2026-06-08-phase6-slice5-chatops-review.md`](./2026-06-08-phase6-slice5-chatops-review.md):

| Item | Disposition | Where |
|------|-------------|-------|
| **Q1** identity-mapping cache / freshness | **Fixed** | §4.4 — TTL+LRU cache of `userId→email`; authorization re-checked **live** locally each message; deprovision evicts + flips local state (no stale-auth window). |
| **Q2** Teams webhook auth vs local-first | **Fixed (corrected an error)** | §7 — Bot Framework **Microsoft-signed JWT** validated via the existing `identity/jwks-cache.ts` RS256 pattern; "bearer-or-HMAC" was wrong; Slack Socket Mode needs no inbound signature. |
| **Q3a** owner glob collisions | **Fixed** | §5 — deterministic precedence (exact → longest literal prefix → `*`); equal-specificity collision ⇒ **refuse + audit**. |
| **Q3b** multi-owner / group owner × quorum | **Deferred** | §3.1 — owner = single SCIM email this slice; quorum (I21) composes orthogonally on top. |
| **Q3c** owner == requester (self-approval) | **Fixed** | §5 — self-approval allowed only when no quorum applies; under quorum the requester is at most one distinct peer (cannot satisfy alone). |
| **S1** Slack/Teams text normalization | **Fixed** | §4.5 — normalization pass (mentions, link syntax, smart quotes, backticks) before the `run` grammar. |
| **S2** Socket Mode reconnect/backoff | **Fixed** | §4.5 — fresh-before-close, ping/pong health, exponential backoff + jitter, at-least-once + `(channel,ts)` idempotency. |
| **S3** audit/warn on ownership refusal | **Fixed** | §5 — every policy refusal emits an audit entry (reason code) + a one-line in-channel "why". |

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
  command-parser.ts              # normalize → NL-vs-`run` split; structured write grammar → ParsedCommand
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

**Caching + freshness (review Q1).** The `userId → email` resolution (step 1, a cloud round-trip) is
**cached** with a bounded TTL (default 15 min, `[chatops].identity_cache_ttl_seconds`) and an LRU cap,
keyed by `(platform, userId)`. This is safe to cache because it is *stable* identity data, not
authorization. **Authorization is re-evaluated live on every message** against the **local** identity
store: step 2's `isOperatorValid` (I18) + SCIM `active` flag are local reads, so a deprovision —
which flips `setScimActive(externalId, false)` in `identity/deprovision.ts` — takes effect on the
very next message with **no stale-auth window**, regardless of the email cache. An email change in the
IdP is bounded by the TTL (worst case: one TTL window resolving to a since-changed email, which still
gates on the *local* identity validity). Deprovision also proactively evicts the user's cache entry
via the existing deprovision cascade hook. Net: the cache removes the per-message cloud round-trip and
rate-limit pressure without ever caching an authorization decision.

### 4.5 Input normalization & transport resilience

**Command normalization (review S1).** Chat platforms mangle raw text, and the structured `run`
grammar must parse against the *user's intent*, not the platform's rendering. `command-parser.ts`
runs a **normalization pass before tokenizing**: strip the leading `@nimbus` mention
(`<@Ubotid>` / `<at>Nimbus</at>`), unwrap Slack link syntax `<http://x|x>` / `<http://x>` → `x` and
`<@U123>` / `<#C123|name>` → their plain form, convert smart quotes `“ ” ‘ ’` → ASCII `" '`, strip
surrounding backticks / code fences, and collapse non-breaking spaces. Only after normalization is the
`run <action> k=v…` grammar applied. Normalization is **read-only and total** (never invents tokens);
an input that doesn't parse cleanly after normalization is **refused** (D5: never guessed). Unit tests
cover each decorator class for both Slack and Teams renderings.

**Socket Mode resilience (review S2).** `slack-socket-adapter.ts` treats the WebSocket as
**disposable** — the local-first reality is laptops sleeping, Wi-Fi roaming, VPN flaps. It: (1) honors
Slack's `disconnect` (warning / refresh) frames by opening a fresh socket *before* closing the old one
where possible; (2) runs a **ping/pong health check**; (3) on drop, **reconnects with exponential
backoff + jitter** (base 1s → cap 60s) so an outage never hammers `apps.connections.open`; (4) surfaces
state via `chatops.status` (`connected` / `reconnecting` / `down` + `lastEventAt`). Inbound events are
processed **at-least-once**; the parser/router are **idempotent on `(channel, ts)`** so a redelivered
event after reconnect cannot double-execute a write (the executor's pending-approval keying also
dedupes). Teams (request/response webhook) needs no socket lifecycle — Microsoft retries failed
deliveries, and the same `(channel, ts)` idempotency guards double-processing.

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
- **Resource → owner:** ownership resolves to **exactly one** owner identity. Match precedence is
  deterministic: (1) exact literal match; (2) otherwise the glob with the longest literal prefix
  before its first wildcard; (3) the `*` fallback. The `*` fallback is required for any unmatched
  write to be approvable (no fallback + no specific match → **refuse**, fail-closed). **Collision
  tie-break (review Q3):** if two patterns are *equally* specific (same literal-prefix length) and
  both match, resolution is **ambiguous → refuse + audit** (fail-closed; never silently pick one) —
  the operator must disambiguate in policy. Group/distribution-list owners and multiple owners per
  resource are **out of scope** for this slice (see §3.1); an owner value is a single SCIM email.
- **Self-approval × quorum (review Q3):** when the resolved owner *is* the requester and **no quorum
  rule applies** to the action type, self-approval is allowed (this is exactly today's single-approver
  HITL — the actor confirming their own action). When a quorum rule **does** apply (I21), the
  requester's own approval counts as **at most one** of the N *distinct authenticated peers*, so a
  requester can never satisfy a quorum alone — quorum and owner-routing compose orthogonally
  (owner-routing decides *who the primary card goes to*; quorum decides *how many distinct peers must
  approve*). A `deny` from any peer still aborts (I21, fail-closed).
- **Refusal observability (review S3):** every write refused for a policy reason — unbound channel,
  unmapped user under `refuse`, missing fallback owner, ambiguous-owner collision, or unknown action —
  emits an **audit-log entry** (reason code + channel + namespace, no secrets) and a one-line
  in-channel reply stating *why*, so operators can diagnose "the bot is ignoring me" immediately.
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
(5→6 after Slice 4's policy route). **Authentication (review Q2):** Teams Bot Framework activities
carry a **Microsoft-signed JWT** (`Authorization: Bearer`) issued by `login.botframework.com`. The
route validates that JWT — signature against the Bot Framework OpenID metadata/JWKS, plus issuer +
the `aud` claim equal to the bot's own app id — by **reusing the existing `identity/jwks-cache.ts` +
RS256 verifier pattern** from Slice 3 (I18). This is *not* a new local-first violation: fetching an
IdP/Bot-Framework JWKS for token validation is the same outbound-for-verification the OIDC verifier
already does (local-first = the index is the source of truth, not "the gateway never reaches an IdP");
the JWKS is cached, and the route fails closed (401) if validation can't complete. The earlier
"bearer-or-HMAC" phrasing was wrong — there is **no** shared-secret/proxy mode; validation is
in-gateway. Body-size capped, rejections audited.

**Slack inbound:** **no inbound route and no inbound signature check** — Socket Mode events arrive on
the *outbound* WebSocket the gateway opened, authenticated by the Slack **app-level token** presented
at connect time. (Slack's HMAC signing-secret model applies only to the Events-API HTTP webhook,
which this design deliberately does not use.)

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
- **Command parser:** normalization (mentions, `<url|text>`, smart quotes, backticks — Slack & Teams
  renderings) precedes parsing; read vs `run` split; unknown/ambiguous write → refused; grammar edges.
- **Owner routing:** correct owner resolved by glob precedence; equal-specificity collision → refuse +
  audit; non-owner Approve click rejected; self-approval allowed only sans quorum; quorum stacks (a
  requester counts as ≤1 distinct peer); audit records approver identity; fallback-owner-absent →
  refuse; every refusal path emits its audit entry (S3).
- **Identity cache (Q1):** TTL eviction; deprovision mid-session → next message authorization fails
  live despite a warm email cache.
- **Transport (Q2/S2):** Teams Bot Framework JWT validated via the jwks-cache pattern (bad/expired
  token → 401); Socket Mode reconnect with backoff; redelivered `(channel, ts)` does not double-execute.
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
3. **Identity mapper + owner resolver** — Slice 3 / policy lookups; userId→email cache (Q1); glob
   precedence + collision-refuse (Q3a); self-approval×quorum (Q3c); fail-closed + refusal-audit tests.
4. **Command parser** — normalization pass (S1) + NL/`run` split + write grammar + refusal tests.
5. **Reply dispatcher + I23/D17** — bounded post + invariant test + static check + docs row.
6. **Intent router + approval presenter** — read→engine, write→gate (I20 owner-routing), card lifecycle.
7. **Connector tools** — slack/teams additions + vault keys + contract tests.
8. **Transports** — Slack Socket Mode adapter (reconnect/backoff + idempotency, S2); Teams webhook
   route (I13 allowlist 5→6) with Bot Framework JWT validation via the jwks-cache pattern (Q2).
9. **IPC + CLI + Tauri/LAN allowlists** — `chatops.*` + `nimbus chatops`.
10. **Watcher notification routing** — extend `notify` callback → dispatcher.
11. **E2E + docs** — mock-cloud E2E; roadmap row check; SECURITY-INVARIANTS I23; CHANGELOG; cli-reference.

Each lane is implemented and reviewed task-by-task (two-stage review) per
`superpowers:subagent-driven-development`.
