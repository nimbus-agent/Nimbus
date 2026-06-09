# Phase 6 Slice 5 — ChatOps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bidirectional Slack/Teams `@nimbus` bot that answers read queries from the shared index and routes write commands through the executor's HITL gate (owner-routed), never bypassing consent.

**Architecture:** A new Gateway subsystem `packages/gateway/src/chatops/` orchestrates transport-agnostic bot logic (identity mapping, policy-scoped channel binding, NL-read vs structured-write parsing, owner-routed HITL, bounded reply dispatch). Two transport adapters — Slack Socket Mode (outbound WS) and Teams webhook (on the I13 HTTP write surface) — delegate every cloud call to the existing first-party `slack`/`teams` MCP connectors (MCP-only). Write approvals reuse the Slice 2 I20 delegated-approval path; channel↔namespace and resource→owner mappings live in the Slice 4 signed org policy (I22). A new structural invariant **I23** (static **D17**) bounds the operational-post path so it cannot launder the HITL-gated `*.message.post` action.

**Tech Stack:** Bun 1.2+, TypeScript 6 strict, Biome, `bun:sqlite`, `bun:test`, `@modelcontextprotocol/sdk` (connectors), Zod (connector tool schemas), hand-rolled TOML primitives (`config/toml-primitives.ts`).

**Spec:** [`docs/superpowers/specs/2026-06-08-phase6-slice5-chatops-design.md`](../specs/2026-06-08-phase6-slice5-chatops-design.md) (+ review resolutions §3.2).

---

## Conventions for every task

- Branch is already `dev/asafgolombek/phase6-slice5-chatops` in worktree `.worktrees/phase6-slice5-chatops`. **Run all commands from the worktree root.**
- Run a single test file with: `bun test <path>` (scoped — **never** `bun run test` / full suite / `--coverage`; coverage is verified via the Docker recipe in Task 14).
- Strict mode: **no `any`** — use `unknown` + explicit narrowing for all inbound wire payloads.
- After each task: `bunx biome check packages/gateway/src/chatops` (lint), then commit.
- Commit trailer (every commit): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Plan review resolutions (2026-06-08)

Dispositions of [`2026-06-08-phase6-slice5-chatops-review.md`](./2026-06-08-phase6-slice5-chatops-review.md):

| Item | Disposition |
|------|-------------|
| **Q1** add per-method `@nimbus-dev/client` wrappers | **Declined (clarified)** — verified the client uses a generic `ipc.call(method, params)`; no per-method wrappers exist for `policy.*`/`identity.*`, so none are needed for `chatops.*`. Task 10 Step 6 now says so explicitly. |
| **Q2** Teams JWKS offline / HMAC fallback | **Declined HMAC (conflicts with approved spec §7) + documented mitigation** — Teams bots are architecturally online; keys are disk-cached in `oidc_jwks_cache` with a long TTL and survive transient outages; cold-start-during-outage fails closed (correct). Task 9 Step 6. |
| **S1** bound the Slack dedupe set | **Fixed** — Task 9 Step 3: `Set` + insertion-order queue capped at 1000, FIFO eviction, with a test. |
| **S2** consolidate `slack_socket_open` | **Fixed** — Task 8 Step 4 now defines the full `slack_socket_open` tool contract (`{} → { url }`); Task 9 only consumes it. |

## File structure (created/modified)

**New — `packages/gateway/src/chatops/`:**

- `types.ts` — `ChatMessage`, `ParsedCommand`, `ChatIdentity`, `ReplyTarget`, `ChatPlatform`, `RefusalReason`.
- `chatops-request-context.ts` — AsyncLocalStorage carrying the per-write owner-routing context.
- `identity-mapper.ts` — platform userId → email (cached) → SCIM identity; live local authz recheck.
- `owner-resolver.ts` — resource → single owner identity via `EnforcedPolicy` ownership globs.
- `command-parser.ts` — normalize → NL-vs-`run` split → structured write grammar.
- `reply-dispatcher.ts` — **I23**: bounded operational post (originating / policy-`notify` only).
- `approval-presenter.ts` — render Approve/Reject card; map a click → resolved `RemoteApprovalOutcome`.
- `intent-router.ts` — read→engine, write→executor gate (owner-routed); emit refusal audit + reply.
- `chatops-service.ts` — lifecycle: build adapters, hold router, start/stop, status snapshot.
- `transport/transport.ts` — `ChatTransport` DI interface.
- `transport/slack-socket-adapter.ts` — Socket Mode lifecycle (reconnect/backoff/idempotency).
- `transport/teams-webhook-adapter.ts` — normalize Teams activity → `ChatMessage` (route handler in Task 10).
- (tests co-located as `*.test.ts`.)

**Modified:**

- `packages/gateway/src/policy/types.ts`, `policy/policy-toml.ts`, `policy/policy-gate.ts` — `chatops` policy fields.
- `packages/gateway/src/config/nimbus-toml.ts` — `[chatops]` config section.
- `packages/gateway/src/ipc/http-write-routes.ts` — Teams events route (I13 allowlist 5→6).
- `packages/gateway/src/ipc/lan-rpc.ts` — `chatops` added to `FORBIDDEN_OVER_LAN`.
- `packages/gateway/src/ipc/chatops-rpc.ts` (new) + central dispatcher registration.
- `packages/gateway/src/automation/watcher-engine.ts` — notify→dispatcher option (Task 12).
- `packages/mcp-connectors/{slack,teams}/src/server.ts` — operational + user-lookup tools.
- `packages/gateway/src/connectors/connector-secrets-manifest.ts` — bot-token keys.
- `packages/ui/src-tauri/src/gateway_bridge.rs` — `chatops.status` in `ALLOWED_METHODS`.
- `scripts/structure-audit/check-nimbus-invariants.ts` — D17.
- `packages/gateway/src/security-invariants.test.ts` — I23.
- `docs/SECURITY-INVARIANTS.md`, `docs/CHANGELOG.md`, `docs/cli-reference.md`, `docs/roadmap.md`, `CLAUDE.md`, `GEMINI.md`.
- `packages/cli/src/...` — `nimbus chatops` subcommand.

> **No new DB migration.** Channel/ownership live in signed policy; the identity-email cache is in-memory; the Teams JWT path reuses the existing `oidc_jwks_cache` table.

---

## Task 1: ChatOps types + `[chatops]` config section

**Files:**

- Create: `packages/gateway/src/chatops/types.ts`
- Create: `packages/gateway/src/chatops/types.test.ts`
- Modify: `packages/gateway/src/config/nimbus-toml.ts` (add `NimbusChatopsToml` + parser, mirroring `[identity]`)
- Create: `packages/gateway/src/config/nimbus-chatops-toml.test.ts`

- [ ] **Step 1: Write the failing test for types + config defaults**

`packages/gateway/src/config/nimbus-chatops-toml.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NIMBUS_CHATOPS_TOML,
  parseNimbusChatopsToml,
} from "./nimbus-toml.ts";

describe("[chatops] config", () => {
  test("defaults: disabled, no platforms", () => {
    expect(DEFAULT_NIMBUS_CHATOPS_TOML.enabled).toBe(false);
    expect(DEFAULT_NIMBUS_CHATOPS_TOML.slackEnabled).toBe(false);
    expect(DEFAULT_NIMBUS_CHATOPS_TOML.teamsEnabled).toBe(false);
    expect(DEFAULT_NIMBUS_CHATOPS_TOML.identityCacheTtlSeconds).toBe(900);
  });

  test("parses enabled platforms + ttl override", () => {
    const cfg = parseNimbusChatopsToml(
      `[chatops]\nenabled=true\nslack_enabled=true\nteams_enabled=false\nidentity_cache_ttl_seconds=300\n`,
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.slackEnabled).toBe(true);
    expect(cfg.teamsEnabled).toBe(false);
    expect(cfg.identityCacheTtlSeconds).toBe(300);
  });

  test("ignores unknown keys; keeps defaults", () => {
    const cfg = parseNimbusChatopsToml(`[chatops]\nbogus=123\n`);
    expect(cfg.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-chatops-toml.test.ts`
Expected: FAIL — `parseNimbusChatopsToml`/`DEFAULT_NIMBUS_CHATOPS_TOML` not exported.

- [ ] **Step 3: Add the config section (mirror the `[identity]` idiom)**

In `packages/gateway/src/config/nimbus-toml.ts`, add near the other section types (uses the existing `parseBool`, `parseString`, `parseIntDec`, `forEachSectionEntry`, `loadTomlSection` helpers already in that file):

```typescript
export type NimbusChatopsToml = {
  enabled: boolean;
  slackEnabled: boolean;
  teamsEnabled: boolean;
  /** Team Vault entry name holding the bot tokens (Slice 2). */
  botVaultEntry: string;
  /** TTL for the platform-userId → email mapping cache (authz is always re-checked live). */
  identityCacheTtlSeconds: number;
  /** Teams bot app id; the `aud` claim the Bot Framework JWT must carry. */
  teamsBotAppId: string;
};

export const DEFAULT_NIMBUS_CHATOPS_TOML: NimbusChatopsToml = {
  enabled: false,
  slackEnabled: false,
  teamsEnabled: false,
  botVaultEntry: "chatops-bot",
  identityCacheTtlSeconds: 900,
  teamsBotAppId: "",
};

function applyNimbusChatopsKey(
  out: Partial<NimbusChatopsToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "slack_enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.slackEnabled = b;
      break;
    }
    case "teams_enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.teamsEnabled = b;
      break;
    }
    case "bot_vault_entry":
      out.botVaultEntry = parseString(valRaw);
      break;
    case "teams_bot_app_id":
      out.teamsBotAppId = parseString(valRaw);
      break;
    case "identity_cache_ttl_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 0) out.identityCacheTtlSeconds = n;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusChatopsToml(
  raw: string,
  defaults: NimbusChatopsToml = DEFAULT_NIMBUS_CHATOPS_TOML,
): NimbusChatopsToml {
  const out: Partial<NimbusChatopsToml> = {};
  forEachSectionEntry(raw, "[chatops]", (key, valRaw) => applyNimbusChatopsKey(out, key, valRaw));
  return { ...defaults, ...out };
}

export function loadNimbusChatopsFromConfigDir(configDir: string): NimbusChatopsToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_CHATOPS_TOML,
    parseNimbusChatopsToml,
  );
}
```

> Note: confirm `parseIntDec` is exported in `nimbus-toml.ts`'s import list from `./toml-primitives.ts`; it is used by `[identity]`'s numeric keys. If named differently there, use the same helper the `[identity]` numeric keys use.

- [ ] **Step 4: Write `chatops/types.ts`**

```typescript
// packages/gateway/src/chatops/types.ts

/** Which chat platform a message arrived on. */
export type ChatPlatform = "slack" | "teams";

/** A normalized inbound message (after the transport adapter strips platform envelope). */
export interface ChatMessage {
  readonly platform: ChatPlatform;
  /** Platform channel id (Slack channel id / Teams conversation id). */
  readonly channelId: string;
  /** Platform-asserted (signature/connection-authenticated) user id — NEVER from message text. */
  readonly userId: string;
  /** Raw message text including the `@nimbus` mention. */
  readonly text: string;
  /** Platform message timestamp/id — used as the idempotency key with channelId. */
  readonly ts: string;
}

/** Result of parsing a message: either a free-form read or a structured write. */
export type ParsedCommand =
  | { readonly kind: "read"; readonly query: string }
  | {
      readonly kind: "write";
      /** The HITL action type, e.g. "deployment.rollback". */
      readonly actionType: string;
      /** Parsed `k=v` args. */
      readonly args: Readonly<Record<string, string>>;
      /** The resource the write targets (for owner resolution), e.g. "payment-service". */
      readonly resource: string;
    }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: string };

/** A resolved Nimbus identity for a chat user. */
export interface ChatIdentity {
  readonly externalId: string;
  readonly email: string;
  /** Issuer for the operator-validity check (I18). */
  readonly issuer: string;
}

/** Stable, server-derived reply destination (never a caller-supplied raw channel). */
export type ReplyTarget =
  | { readonly kind: "originating"; readonly platform: ChatPlatform; readonly channelId: string }
  | { readonly kind: "namespaceNotify"; readonly namespace: string };

export type RefusalReason =
  | "unbound_channel"
  | "unmapped_user"
  | "unknown_action"
  | "ambiguous_command"
  | "no_owner"
  | "ambiguous_owner"
  | "not_authorized";
```

`packages/gateway/src/chatops/types.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { ChatMessage, ParsedCommand } from "./types.ts";

describe("chatops types", () => {
  test("ChatMessage + ParsedCommand are structurally usable", () => {
    const m: ChatMessage = {
      platform: "slack",
      channelId: "C1",
      userId: "U1",
      text: "@nimbus ping",
      ts: "1.2",
    };
    const c: ParsedCommand = { kind: "read", query: "ping" };
    expect(m.platform).toBe("slack");
    expect(c.kind).toBe("read");
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gateway/src/config/nimbus-chatops-toml.test.ts packages/gateway/src/chatops/types.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

```bash
bunx biome check packages/gateway/src/chatops packages/gateway/src/config/nimbus-toml.ts
git add packages/gateway/src/chatops/types.ts packages/gateway/src/chatops/types.test.ts packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-chatops-toml.test.ts
git commit -m "feat(chatops): types + [chatops] config section"
```

---

## Task 2: Policy schema extension — channel binding + ownership

**Files:**

- Modify: `packages/gateway/src/policy/types.ts` (add `chatops` to `OrgPolicy` + `EnforcedPolicy`)
- Modify: `packages/gateway/src/policy/policy-toml.ts` (parse `[policy.chatops.channel."<id>"]` + `[policy.chatops.ownership]`)
- Modify: `packages/gateway/src/policy/policy-gate.ts` (`computeEnforced` carries chatops through; add resolver helpers)
- Create: `packages/gateway/src/policy/chatops-policy.ts` (pure resolution: channel→binding, resource→owner)
- Create: `packages/gateway/src/policy/chatops-policy.test.ts`

- [ ] **Step 1: Write the failing test for parsing + resolution**

`packages/gateway/src/policy/chatops-policy.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parsePolicyToml } from "./policy-toml.ts";
import { resolveChannelBinding, resolveOwner } from "./chatops-policy.ts";

const TOML = `
[policy]
version=1
org="acme"
[policy.retention]
min_days=7
[policy.chatops.channel."C0SLACK1"]
namespace="project:payments"
unmapped="public-read"
notify=["C0SLACK1","C0ALERTS"]
[policy.chatops.channel."C0OPS"]
namespace="project:payments"
unmapped="refuse"
[policy.chatops.ownership]
"payment-service"="alice@acme.com"
"payment-*"="pay-lead@acme.com"
"*"="oncall@acme.com"
`;

describe("chatops policy parse + resolve", () => {
  const p = parsePolicyToml(TOML);

  test("channel binding: bound channel resolves namespace + unmapped mode", () => {
    const b = resolveChannelBinding(p.chatops, "C0SLACK1");
    expect(b?.namespace).toBe("project:payments");
    expect(b?.unmapped).toBe("public-read");
    expect(b?.notify).toEqual(["C0SLACK1", "C0ALERTS"]);
  });

  test("channel binding: unbound channel → undefined (fail-closed)", () => {
    expect(resolveChannelBinding(p.chatops, "C0UNKNOWN")).toBeUndefined();
  });

  test("unmapped defaults to refuse when omitted", () => {
    expect(resolveChannelBinding(p.chatops, "C0OPS")?.unmapped).toBe("refuse");
  });

  test("owner: exact match wins over glob", () => {
    expect(resolveOwner(p.chatops, "payment-service")).toEqual({ kind: "owner", email: "alice@acme.com" });
  });

  test("owner: longest-literal-prefix glob beats fallback", () => {
    expect(resolveOwner(p.chatops, "payment-api")).toEqual({ kind: "owner", email: "pay-lead@acme.com" });
  });

  test("owner: fallback star", () => {
    expect(resolveOwner(p.chatops, "billing-x")).toEqual({ kind: "owner", email: "oncall@acme.com" });
  });

  test("owner: equal-specificity collision → ambiguous", () => {
    const collide = parsePolicyToml(
      `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=7\n[policy.chatops.ownership]\n"pay-*"="a@acme.com"\n"pay-?"="b@acme.com"\n`,
    );
    // both have literal prefix "pay-" (len 4) → ambiguous, refuse
    expect(resolveOwner(collide.chatops, "pay-1")).toEqual({ kind: "ambiguous" });
  });

  test("owner: no match + no fallback → none", () => {
    const noFallback = parsePolicyToml(
      `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=7\n[policy.chatops.ownership]\n"x-*"="a@acme.com"\n`,
    );
    expect(resolveOwner(noFallback.chatops, "y-1")).toEqual({ kind: "none" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/policy/chatops-policy.test.ts`
Expected: FAIL — `chatops` not on `OrgPolicy`; `resolveChannelBinding`/`resolveOwner` missing.

- [ ] **Step 3: Extend the policy types**

In `packages/gateway/src/policy/types.ts`, add the shared shapes and extend `OrgPolicy` + `EnforcedPolicy`:

```typescript
export type UnmappedMode = "refuse" | "public-read";

export interface ChatopsChannelBinding {
  readonly namespace: string;
  readonly unmapped: UnmappedMode;
  readonly notify: readonly string[];
}

export interface ChatopsPolicy {
  /** channelId → binding. */
  readonly channels: ReadonlyMap<string, ChatopsChannelBinding>;
  /** ownership glob pattern → owner email (insertion order preserved). */
  readonly ownership: ReadonlyMap<string, string>;
}
```

Add `readonly chatops: ChatopsPolicy;` to `OrgPolicy` and `readonly chatops: ChatopsPolicy;` to `EnforcedPolicy`.

> Because `OrgPolicy.chatops` is now required, update the `enforced()` baseline-only branch in `policy-gate.ts` (Step 5) and the empty-policy construction in `policy-toml.ts` (Step 4) to always produce an empty `ChatopsPolicy` (`{ channels: new Map(), ownership: new Map() }`).

- [ ] **Step 4: Parse the new sections in `policy-toml.ts`**

Add to the `PolicyAccum` interface:

```typescript
  /** chatops channel bindings keyed by channelId; finalized after the scan. */
  chatopsChannels: Map<string, Record<string, string>>;
  /** chatops ownership glob → email, in insertion order. */
  chatopsOwnership: Map<string, string>;
  /** the channelId currently being filled (active [policy.chatops.channel."<id>"]). */
```

Initialize them in `parsePolicyToml`'s `acc` literal:

```typescript
    chatopsChannels: new Map<string, Record<string, string>>(),
    chatopsOwnership: new Map<string, string>(),
```

Extend `readHeader` to recognize the two new table forms (mirror the `QUORUM_PREFIX` idiom):

```typescript
const CHATOPS_CHANNEL_PREFIX = '[policy.chatops.channel."';
const CHATOPS_OWNERSHIP_HEADER = "[policy.chatops.ownership]";
```

In `readHeader`, before the final `return { section: trimmed }`:

```typescript
  if (trimmed.startsWith(CHATOPS_CHANNEL_PREFIX) && trimmed.endsWith('"]')) {
    const id = trimmed.slice(CHATOPS_CHANNEL_PREFIX.length, -2);
    if (id.length === 0) return { section: "chatopsChannel" };
    if (!acc.chatopsChannels.has(id)) acc.chatopsChannels.set(id, {});
    return { section: "chatopsChannel", chatopsChannelId: id };
  }
  if (trimmed === CHATOPS_OWNERSHIP_HEADER) return { section: "chatopsOwnership" };
```

Thread a `chatopsChannelId` field alongside `quorumId` through `readHeader`'s return type, the main-loop locals, and `dispatchKey`. Add the dispatch arms:

```typescript
    case "chatopsChannel": {
      if (chatopsChannelId !== undefined) {
        const bucket = acc.chatopsChannels.get(chatopsChannelId);
        if (bucket !== undefined) bucket[key] = valRaw;
      }
      break;
    }
    case "chatopsOwnership":
      // key is the quoted glob; parseString strips quotes, valRaw is the quoted email.
      acc.chatopsOwnership.set(stripQuotes(key), parseString(valRaw));
      break;
```

> `splitKeyValue` yields the raw key token; for the ownership table the key is a quoted glob like `"payment-*"`. Add a tiny local `stripQuotes(s)` (`s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s`) — or reuse `parseString` if it accepts a bare quoted token in this codebase; verify against `toml-primitives.ts`.

Add a finalizer and include `chatops` in the returned `OrgPolicy`:

```typescript
function finalizeChatops(
  channels: Map<string, Record<string, string>>,
  ownership: Map<string, string>,
): ChatopsPolicy {
  const out = new Map<string, ChatopsChannelBinding>();
  for (const [id, kv] of channels) {
    const ns = kv["namespace"] === undefined ? "" : parseString(kv["namespace"]);
    if (ns === "") continue; // a binding with no namespace is inert (fail-closed)
    const unmappedRaw = kv["unmapped"] === undefined ? "refuse" : parseString(kv["unmapped"]);
    const unmapped: UnmappedMode = unmappedRaw === "public-read" ? "public-read" : "refuse";
    const notify = kv["notify"] === undefined ? [] : [...parseStringArray(kv["notify"])];
    out.set(id, { namespace: ns, unmapped, notify });
  }
  return { channels: out, ownership: new Map(ownership) };
}
```

In the return literal: `chatops: finalizeChatops(acc.chatopsChannels, acc.chatopsOwnership),`.

- [ ] **Step 5: Carry `chatops` through `computeEnforced`; write `chatops-policy.ts`**

In `policy-gate.ts` `computeEnforced`, add to the returned object: `chatops: policy.chatops,` (chatops bindings are pass-through — not monotonic-merged; they are additive governance, and a binding can only *restrict* who may use a channel). In the `enforced()` ungoverned branch, add `chatops: { channels: new Map(), ownership: new Map() }`.

`packages/gateway/src/policy/chatops-policy.ts`:

```typescript
import type { ChatopsChannelBinding, ChatopsPolicy } from "./types.ts";

export type OwnerResolution =
  | { readonly kind: "owner"; readonly email: string }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "none" };

export function resolveChannelBinding(
  chatops: ChatopsPolicy,
  channelId: string,
): ChatopsChannelBinding | undefined {
  return chatops.channels.get(channelId);
}

/** Literal prefix of a glob = everything before the first wildcard char (`*` or `?`). */
function literalPrefixLen(pattern: string): number {
  const i = pattern.search(/[*?]/);
  return i === -1 ? pattern.length : i;
}

function globMatches(pattern: string, value: string): boolean {
  // Anchored full-string match; `*` → any run, `?` → one char. Escape regex metachars first.
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
  );
  return re.test(value);
}

/**
 * Resolve a resource to exactly one owner email. Precedence: (1) exact literal match;
 * (2) the matching glob with the longest literal prefix; (3) the `*` fallback. Two equally-specific
 * matching globs → ambiguous (refuse, fail-closed; review Q3a). No match + no `*` → none.
 */
export function resolveOwner(chatops: ChatopsPolicy, resource: string): OwnerResolution {
  const exact = chatops.ownership.get(resource);
  if (exact !== undefined) return { kind: "owner", email: exact };

  let best: { len: number; email: string } | undefined;
  let bestCount = 0;
  for (const [pattern, email] of chatops.ownership) {
    if (pattern === "*") continue; // fallback handled below
    if (!globMatches(pattern, resource)) continue;
    const len = literalPrefixLen(pattern);
    if (best === undefined || len > best.len) {
      best = { len, email };
      bestCount = 1;
    } else if (len === best.len) {
      bestCount++;
    }
  }
  if (best !== undefined) {
    return bestCount > 1 ? { kind: "ambiguous" } : { kind: "owner", email: best.email };
  }
  const fallback = chatops.ownership.get("*");
  return fallback === undefined ? { kind: "none" } : { kind: "owner", email: fallback };
}
```

- [ ] **Step 6: Run tests; lint; commit**

Run: `bun test packages/gateway/src/policy/chatops-policy.test.ts packages/gateway/src/policy`
Expected: PASS (and existing policy tests stay green).

```bash
bunx biome check packages/gateway/src/policy
git add packages/gateway/src/policy
git commit -m "feat(chatops): signed-policy channel binding + owner resolution (Q3a precedence)"
```

---

## Task 3: Identity mapper (cache + live-local authz recheck)

**Files:**

- Create: `packages/gateway/src/chatops/identity-mapper.ts`
- Create: `packages/gateway/src/chatops/identity-mapper.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/gateway/src/chatops/identity-mapper.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ChatopsIdentityMapper } from "./identity-mapper.ts";

function makeDeps(over: Partial<{
  email: string | undefined;
  scimActive: boolean;
  operatorValid: boolean;
  lookups: { n: number };
}> = {}) {
  const lookups = over.lookups ?? { n: 0 };
  return {
    lookups,
    deps: {
      lookupEmail: async (_platform: "slack" | "teams", _userId: string) => {
        lookups.n++;
        return over.email === undefined ? undefined : over.email;
      },
      findScimByEmail: (_email: string) =>
        over.scimActive === undefined
          ? undefined
          : { externalId: "ext-1", email: over.email ?? "a@acme.com", active: over.scimActive, issuer: "https://idp" },
      isOperatorValid: (_issuer: string) => over.operatorValid ?? true,
      nowMs: () => 1_000_000,
      ttlSeconds: 900,
    },
  };
}

describe("ChatopsIdentityMapper", () => {
  test("maps a known active user", async () => {
    const { deps } = makeDeps({ email: "a@acme.com", scimActive: true, operatorValid: true });
    const m = new ChatopsIdentityMapper(deps);
    const r = await m.resolve("slack", "U1");
    expect(r.kind).toBe("mapped");
    if (r.kind === "mapped") expect(r.identity.externalId).toBe("ext-1");
  });

  test("email lookup is cached (second call does not re-hit the connector)", async () => {
    const lookups = { n: 0 };
    const { deps } = makeDeps({ email: "a@acme.com", scimActive: true, lookups });
    const m = new ChatopsIdentityMapper(deps);
    await m.resolve("slack", "U1");
    await m.resolve("slack", "U1");
    expect(lookups.n).toBe(1);
  });

  test("deprovision (scim inactive) → unmapped even with a warm email cache", async () => {
    let active = true;
    const lookups = { n: 0 };
    const m = new ChatopsIdentityMapper({
      lookupEmail: async () => { lookups.n++; return "a@acme.com"; },
      findScimByEmail: () => ({ externalId: "ext-1", email: "a@acme.com", active, issuer: "https://idp" }),
      isOperatorValid: () => true,
      nowMs: () => 1_000_000,
      ttlSeconds: 900,
    });
    expect((await m.resolve("slack", "U1")).kind).toBe("mapped");
    active = false; // deprovisioned mid-session
    expect((await m.resolve("slack", "U1")).kind).toBe("unmapped");
    expect(lookups.n).toBe(1); // email still cached; authz re-checked live
  });

  test("no email / no scim / invalid operator → unmapped", async () => {
    const noEmail = new ChatopsIdentityMapper(makeDeps({ email: undefined }).deps);
    expect((await noEmail.resolve("slack", "U1")).kind).toBe("unmapped");
    const invalidOp = new ChatopsIdentityMapper(
      makeDeps({ email: "a@acme.com", scimActive: true, operatorValid: false }).deps,
    );
    expect((await invalidOp.resolve("slack", "U1")).kind).toBe("unmapped");
  });

  test("evict() drops a cached email", async () => {
    const lookups = { n: 0 };
    const m = new ChatopsIdentityMapper(makeDeps({ email: "a@acme.com", scimActive: true, lookups }).deps);
    await m.resolve("slack", "U1");
    m.evict("a@acme.com");
    await m.resolve("slack", "U1");
    expect(lookups.n).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/chatops/identity-mapper.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the mapper**

`packages/gateway/src/chatops/identity-mapper.ts`:

```typescript
import type { ChatIdentity, ChatPlatform } from "./types.ts";

/** A SCIM-backed identity row, as the mapper needs it. */
export interface ScimMatch {
  readonly externalId: string;
  readonly email: string;
  readonly active: boolean;
  readonly issuer: string;
}

export interface IdentityMapperDeps {
  /** Cloud round-trip: platform userId → email (read-only connector tool). */
  readonly lookupEmail: (platform: ChatPlatform, userId: string) => Promise<string | undefined>;
  /** Local lookup: email → SCIM identity (Slice 3). */
  readonly findScimByEmail: (email: string) => ScimMatch | undefined;
  /** I18 operator validity for the identity's issuer (live, local, synchronous). */
  readonly isOperatorValid: (issuer: string) => boolean;
  readonly nowMs: () => number;
  readonly ttlSeconds: number;
}

export type ResolveResult =
  | { readonly kind: "mapped"; readonly identity: ChatIdentity }
  | { readonly kind: "unmapped" };

interface CacheEntry {
  readonly email: string;
  readonly expiresMs: number;
}

/**
 * Resolves a chat user to a Nimbus identity. The userId→email mapping (a cloud round-trip) is cached
 * with a TTL; authorization (SCIM active + I18 operator validity) is re-evaluated LIVE and LOCALLY on
 * every call, so a deprovision takes effect on the next message with no stale-auth window (review Q1).
 */
export class ChatopsIdentityMapper {
  private readonly cache = new Map<string, CacheEntry>();
  constructor(private readonly deps: IdentityMapperDeps) {}

  private cacheKey(platform: ChatPlatform, userId: string): string {
    return `${platform}:${userId}`;
  }

  /** Drop a cached email (called from the deprovision hook, keyed by email). */
  evict(email: string): void {
    for (const [k, v] of this.cache) if (v.email === email) this.cache.delete(k);
  }

  async resolve(platform: ChatPlatform, userId: string): Promise<ResolveResult> {
    const key = this.cacheKey(platform, userId);
    const now = this.deps.nowMs();
    let email: string | undefined;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresMs > now) {
      email = cached.email;
    } else {
      email = await this.deps.lookupEmail(platform, userId);
      if (email === undefined) {
        this.cache.delete(key);
        return { kind: "unmapped" };
      }
      this.cache.set(key, { email, expiresMs: now + this.deps.ttlSeconds * 1000 });
    }

    // Authorization is ALWAYS live + local — never cached.
    const scim = this.deps.findScimByEmail(email);
    if (scim === undefined || !scim.active) return { kind: "unmapped" };
    if (!this.deps.isOperatorValid(scim.issuer)) return { kind: "unmapped" };
    return {
      kind: "mapped",
      identity: { externalId: scim.externalId, email: scim.email, issuer: scim.issuer },
    };
  }
}
```

- [ ] **Step 4: Run test; lint; commit**

Run: `bun test packages/gateway/src/chatops/identity-mapper.test.ts`
Expected: PASS.

```bash
bunx biome check packages/gateway/src/chatops/identity-mapper.ts
git add packages/gateway/src/chatops/identity-mapper.ts packages/gateway/src/chatops/identity-mapper.test.ts
git commit -m "feat(chatops): identity mapper with TTL email cache + live-local authz (Q1)"
```

---

## Task 4: Command parser (normalization + NL/`run` split + write grammar)

**Files:**

- Create: `packages/gateway/src/chatops/command-parser.ts`
- Create: `packages/gateway/src/chatops/command-parser.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/gateway/src/chatops/command-parser.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { normalizeChatText, parseCommand } from "./command-parser.ts";

const KNOWN = new Set(["deployment.rollback", "deployment.apply"]);

describe("normalizeChatText", () => {
  test("strips leading mention, unwraps slack links, normalizes smart quotes + backticks", () => {
    expect(normalizeChatText("<@U123> run deployment.rollback service=`pay`")).toBe(
      "run deployment.rollback service=pay",
    );
    expect(normalizeChatText("@nimbus who owns <http://x.com|x.com>?")).toBe("who owns x.com?");
    expect(normalizeChatText("run x svc=“pay”")).toBe("run x svc=\"pay\"");
  });
});

describe("parseCommand", () => {
  test("free NL → read", () => {
    expect(parseCommand("<@U1> who's on call for payment-service?", KNOWN)).toEqual({
      kind: "read",
      query: "who's on call for payment-service?",
    });
  });

  test("structured write → known action with args + resource", () => {
    const c = parseCommand("@nimbus run deployment.rollback service=payment-service version=v1.4", KNOWN);
    expect(c).toEqual({
      kind: "write",
      actionType: "deployment.rollback",
      args: { service: "payment-service", version: "v1.4" },
      resource: "payment-service",
    });
  });

  test("unknown action → refused (never guessed)", () => {
    const c = parseCommand("run deployment.nuke service=x", KNOWN);
    expect(c.kind).toBe("refused");
    if (c.kind === "refused") expect(c.reason).toBe("unknown_action");
  });

  test("run with no action token → ambiguous refusal", () => {
    expect(parseCommand("run", KNOWN).kind).toBe("refused");
  });

  test("write missing a resource arg → ambiguous refusal", () => {
    const c = parseCommand("run deployment.rollback version=v1.4", KNOWN);
    expect(c.kind).toBe("refused");
    if (c.kind === "refused") expect(c.reason).toBe("ambiguous_command");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/chatops/command-parser.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the parser**

`packages/gateway/src/chatops/command-parser.ts`:

```typescript
import type { ParsedCommand } from "./types.ts";

/**
 * Strip chat-platform decorators before any tokenizing (review S1). Read-only + total: never invents
 * tokens. Handles: leading `@nimbus`/`<@U…>`/`<at>…</at>` mention, Slack link `<url|text>`/`<url>` →
 * text, `<@U…>`/`<#C…|name>` user/channel refs → bare form, smart quotes → ASCII, surrounding
 * backticks, non-breaking spaces, collapsed whitespace.
 */
export function normalizeChatText(raw: string): string {
  let s = raw.replace(/ /g, " ");
  // smart quotes → ASCII
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // slack link <url|label> → label ; <url> → url
  s = s.replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/<(https?:[^>]+)>/g, "$1");
  // user/channel mention tokens → drop the wrapping; <#C123|name> → name, <@U123> → ""
  s = s.replace(/<#[^|>]+\|([^>]+)>/g, "$1").replace(/<@[^>]+>/g, "");
  // leading bot mention
  s = s.replace(/^\s*(?:@nimbus|<at>\s*nimbus\s*<\/at>)\s*/i, "");
  // strip backticks (inline code / fences)
  s = s.replace(/```/g, "").replace(/`/g, "");
  return s.replace(/\s+/g, " ").trim();
}

const KV_RE = /^([A-Za-z][\w.-]*)=(.+)$/;

export function parseCommand(rawText: string, knownActions: ReadonlySet<string>): ParsedCommand {
  const text = normalizeChatText(rawText);
  if (!/^run(\s|$)/i.test(text)) {
    return { kind: "read", query: text };
  }
  const tokens = text.split(" ").slice(1).filter((t) => t.length > 0);
  const actionType = tokens.shift();
  if (actionType === undefined) {
    return { kind: "refused", reason: "ambiguous_command", detail: "`run` needs an action." };
  }
  if (!knownActions.has(actionType)) {
    return { kind: "refused", reason: "unknown_action", detail: `Unknown action '${actionType}'.` };
  }
  const args: Record<string, string> = {};
  for (const t of tokens) {
    const m = KV_RE.exec(t);
    if (m === null) {
      return { kind: "refused", reason: "ambiguous_command", detail: `Bad argument '${t}' (use k=v).` };
    }
    args[m[1] as string] = (m[2] as string).replace(/^"(.*)"$/, "$1");
  }
  const resource = args["service"] ?? args["resource"] ?? args["app"];
  if (resource === undefined) {
    return {
      kind: "refused",
      reason: "ambiguous_command",
      detail: "Write needs a resource (service=… / resource=… / app=…).",
    };
  }
  return { kind: "write", actionType, args, resource };
}
```

- [ ] **Step 4: Run test; lint; commit**

Run: `bun test packages/gateway/src/chatops/command-parser.test.ts`
Expected: PASS.

```bash
bunx biome check packages/gateway/src/chatops/command-parser.ts
git add packages/gateway/src/chatops/command-parser.ts packages/gateway/src/chatops/command-parser.test.ts
git commit -m "feat(chatops): command parser — normalization + NL/run split + write grammar (S1, D5)"
```

---

## Task 5: Reply dispatcher + invariant I23 + static D17

**Files:**

- Create: `packages/gateway/src/chatops/reply-dispatcher.ts`
- Create: `packages/gateway/src/chatops/reply-dispatcher.test.ts`
- Modify: `packages/gateway/src/security-invariants.test.ts` (add I23 block)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (add D17)
- Modify: `docs/SECURITY-INVARIANTS.md` (add I23 row)

- [ ] **Step 1: Write the failing test for the dispatcher**

`packages/gateway/src/chatops/reply-dispatcher.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ReplyDispatcher } from "./reply-dispatcher.ts";
import type { ReplyTarget } from "./types.ts";

function makeDispatcher() {
  const posted: { channelId: string; text: string }[] = [];
  const d = new ReplyDispatcher({
    post: async (platform, channelId, text) => {
      posted.push({ channelId, text });
      void platform;
    },
    notifyChannelsFor: (ns) => (ns === "project:pay" ? ["C_ALERT"] : []),
  });
  return { d, posted };
}

describe("ReplyDispatcher (I23)", () => {
  test("posts to the originating channel", async () => {
    const { d, posted } = makeDispatcher();
    const target: ReplyTarget = { kind: "originating", platform: "slack", channelId: "C_ORIG" };
    await d.send(target, "hello");
    expect(posted).toEqual([{ channelId: "C_ORIG", text: "hello" }]);
  });

  test("posts to a policy-declared notify channel for a namespace", async () => {
    const { d, posted } = makeDispatcher();
    await d.send({ kind: "namespaceNotify", namespace: "project:pay" }, "alert");
    expect(posted).toEqual([{ channelId: "C_ALERT", text: "alert" }]);
  });

  test("namespace with no notify channels → posts nothing (no throw)", async () => {
    const { d, posted } = makeDispatcher();
    await d.send({ kind: "namespaceNotify", namespace: "project:none" }, "x");
    expect(posted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/chatops/reply-dispatcher.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the dispatcher (bounded destination)**

`packages/gateway/src/chatops/reply-dispatcher.ts`:

```typescript
import type { ChatPlatform, ReplyTarget } from "./types.ts";

export interface ReplyDispatcherDeps {
  /**
   * The ONLY function that actually posts to a connector. Imported/wired ONLY here (D17). For a
   * namespaceNotify target the platform is resolved from the channel binding upstream; this slice
   * posts notify channels on whichever platform the connector tool maps them to (Slack first).
   */
  readonly post: (platform: ChatPlatform, channelId: string, text: string) => Promise<void>;
  /** Policy-declared notify channels for a namespace (from EnforcedPolicy.chatops). */
  readonly notifyChannelsFor: (namespace: string) => readonly string[];
}

/**
 * I23 — the sole operational (non-HITL) post path. Destination comes ONLY from a server-derived
 * `ReplyTarget` (the originating message's channel, or a policy `notify` channel for a namespace) —
 * never a caller-supplied raw channel. Arbitrary-destination posting is reachable only via the
 * HITL-gated `*.message.post` action types (I2). No other chatops module may import the connector
 * post tool (enforced statically by D17).
 */
export class ReplyDispatcher {
  constructor(private readonly deps: ReplyDispatcherDeps) {}

  async send(target: ReplyTarget, text: string): Promise<void> {
    if (target.kind === "originating") {
      await this.deps.post(target.platform, target.channelId, text);
      return;
    }
    for (const channelId of this.deps.notifyChannelsFor(target.namespace)) {
      await this.deps.post("slack", channelId, text);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/chatops/reply-dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the D17 static check**

In `scripts/structure-audit/check-nimbus-invariants.ts`, add (mirroring the D16 `checkPolicyTomlImportInvariant` structure):

```typescript
// D17 (I23) — the connector operational-post tools (`slack_chat_post` / `teams_chat_post`) and the
// Socket-Mode post primitive may be referenced ONLY from `packages/gateway/src/chatops/reply-dispatcher.ts`
// and `packages/gateway/src/chatops/transport/`. Any other module posting directly would bypass the
// bounded-destination reply surface (I23) and could launder the HITL-gated `*.message.post` action.
const CHATOPS_POST_ALLOWED_PREFIXES = [
  "packages/gateway/src/chatops/reply-dispatcher.ts",
  "packages/gateway/src/chatops/transport/",
];
const CHATOPS_POST_RE = /\b(?:slack_chat_post|teams_chat_post)\b/;

export function checkChatopsReplySurfaceInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (CHATOPS_POST_ALLOWED_PREFIXES.some((p) => f.relPath === p || f.relPath.startsWith(p))) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (CHATOPS_POST_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D17-chatops-reply-surface",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}
```

Register it in the main run loop next to the D16 block:

```typescript
  if (mode === "binary-only" || mode === "all") {
    const v = checkChatopsReplySurfaceInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D17 chatops post tool referenced outside reply-dispatcher/transport — bypasses I23: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
```

- [ ] **Step 6: Add the I23 runtime invariant test**

In `packages/gateway/src/security-invariants.test.ts`, add (mirroring the existing source-scan invariant blocks; use `readFile`/`readdir` already imported there):

```typescript
describe("I23 — ChatOps operational posts are bounded to originating / policy-notify channels", () => {
  test("(a) ReplyDispatcher derives the destination from a server-side ReplyTarget, not caller input", async () => {
    const src = await readFile(resolve(import.meta.dir, "chatops/reply-dispatcher.ts"), "utf8");
    // The public method takes a ReplyTarget (a reference), never a raw channel string argument.
    expect(src).toMatch(/send\(target: ReplyTarget, text: string\)/);
    // The only post call sites are the originating channel and the policy notify channels.
    expect(src).toMatch(/target\.kind === "originating"/);
    expect(src).toMatch(/notifyChannelsFor\(target\.namespace\)/);
  });

  test("(b) no chatops module outside reply-dispatcher/transport references the connector post tools (D17)", async () => {
    const dir = resolve(import.meta.dir, "chatops");
    const offenders: string[] = [];
    async function walk(d: string, rel: string): Promise<void> {
      for (const ent of await readdir(d, { withFileTypes: true })) {
        const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
        if (ent.isDirectory()) {
          await walk(resolve(d, ent.name), childRel);
          continue;
        }
        if (!ent.name.endsWith(".ts") || ent.name.endsWith(".test.ts")) continue;
        if (childRel === "reply-dispatcher.ts" || childRel.startsWith("transport/")) continue;
        const c = await readFile(resolve(d, ent.name), "utf8");
        if (/\b(?:slack_chat_post|teams_chat_post)\b/.test(c)) offenders.push(childRel);
      }
    }
    await walk(dir, "");
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 7: Add the I23 docs row**

In `docs/SECURITY-INVARIANTS.md`, add an I23 row in the invariants table and a full rationale section, matching the I22 entry's format. Text:
> **I23** — ChatOps operational (non-HITL) posts go only through `chatops/reply-dispatcher.ts` to a server-derived `ReplyTarget` (originating channel or a policy `notify` channel); destination is never caller-supplied. Arbitrary-destination posting remains only via the HITL-gated `*.message.post` action types. Static **D17**. Wiring: `chatops/reply-dispatcher.ts`. **Anti-pattern:** accepting a destination channel as a command/tool argument on the operational path.

Also update the "Static complement" sentence in `docs/SECURITY-INVARIANTS.md` and `CLAUDE.md`/`GEMINI.md` invariant lists to mention I23/D17 (do this here so the triple lands together; the doc-status-drift surfaces are finalized in Task 14).

- [ ] **Step 8: Run the invariant test + static check; commit**

Run: `bun test packages/gateway/src/chatops/reply-dispatcher.test.ts && bun test packages/gateway/src/security-invariants.test.ts -t I23`
Run: `bun scripts/structure-audit/check-nimbus-invariants.ts` (expect exit 0; D17 finds no offenders yet)
Expected: PASS / exit 0.

```bash
git add packages/gateway/src/chatops/reply-dispatcher.ts packages/gateway/src/chatops/reply-dispatcher.test.ts packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-nimbus-invariants.ts docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md
git commit -m "feat(chatops): bounded reply dispatcher + invariant I23 + static D17 (triple)"
```

---

## Task 6: Owner-routing context + approval presenter

**Files:**

- Create: `packages/gateway/src/chatops/chatops-request-context.ts`
- Create: `packages/gateway/src/chatops/approval-presenter.ts`
- Create: `packages/gateway/src/chatops/approval-presenter.test.ts`

**Design:** A ChatOps write calls `executor.gate(action)`. The executor (for the ChatOps-configured instance) gets an `ExecutorDelegationDep` whose `requestRemote(actionType)` reads an AsyncLocalStorage context (mirroring the existing `agent-request-context.ts` / `getAgentRequestSessionId()` pattern) holding `{ ownerIdentity, originatingTarget, requesterExternalId }`. `requestRemote` asks the `ApprovalPresenter` to post a card to the owner and await the click; the click's `RemoteApprovalOutcome.peerId` carries the approver's externalId. I20's `isActiveDelegate`/`isOperatorValid` gate it; quorum (I21) stacks unchanged upstream.

- [ ] **Step 1: Write the failing test for the presenter + context**

`packages/gateway/src/chatops/approval-presenter.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { runWithChatopsApprovalContext } from "./chatops-request-context.ts";
import { ApprovalPresenter } from "./approval-presenter.ts";

describe("ApprovalPresenter + request context", () => {
  test("posts a card to the owner and resolves with the clicker identity", async () => {
    const posts: { channelId: string; text: string }[] = [];
    const presenter = new ApprovalPresenter({
      post: async (channelId, text) => { posts.push({ channelId, text }); },
      ownerChannelFor: (email) => (email === "alice@acme.com" ? "C_ALICE" : undefined),
    });
    const ctx = {
      ownerEmail: "alice@acme.com",
      ownerExternalId: "ext-alice",
      originatingChannelId: "C_ORIG",
      requesterExternalId: "ext-bob",
      actionLabel: "deployment.rollback service=payment-service",
    };
    const p = runWithChatopsApprovalContext(ctx, () => presenter.requestApproval());
    // Simulate Alice clicking Approve.
    presenter.resolveClick({ requestId: presenter.lastRequestId(), approverExternalId: "ext-alice", approved: true });
    const outcome = await p;
    expect(outcome).toEqual({ kind: "answered", peerId: "ext-alice", approved: true });
    expect(posts[0]?.channelId).toBe("C_ALICE");
  });

  test("no owner channel → resolves as timeout (executor falls back to local owner)", async () => {
    const presenter = new ApprovalPresenter({
      post: async () => {},
      ownerChannelFor: () => undefined,
    });
    const ctx = {
      ownerEmail: "nobody@acme.com",
      ownerExternalId: "ext-x",
      originatingChannelId: "C_ORIG",
      requesterExternalId: "ext-bob",
      actionLabel: "x",
    };
    const outcome = await runWithChatopsApprovalContext(ctx, () => presenter.requestApproval());
    expect(outcome.kind).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/chatops/approval-presenter.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the request context**

`packages/gateway/src/chatops/chatops-request-context.ts`:

```typescript
import { AsyncLocalStorage } from "node:async_hooks";

/** Per-write owner-routing context, set before `executor.gate()` and read by `requestRemote`. */
export interface ChatopsApprovalContext {
  readonly ownerEmail: string;
  readonly ownerExternalId: string;
  readonly originatingChannelId: string;
  readonly requesterExternalId: string;
  /** Human-readable action summary for the card. */
  readonly actionLabel: string;
}

const storage = new AsyncLocalStorage<ChatopsApprovalContext>();

export function runWithChatopsApprovalContext<T>(
  ctx: ChatopsApprovalContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function getChatopsApprovalContext(): ChatopsApprovalContext | undefined {
  return storage.getStore();
}
```

- [ ] **Step 4: Implement the presenter**

`packages/gateway/src/chatops/approval-presenter.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { RemoteApprovalOutcome } from "../engine/delegated-approval.ts";
import { getChatopsApprovalContext } from "./chatops-request-context.ts";

export interface ApprovalPresenterDeps {
  /** Post the approval card to a channel (the owner's DM/channel). */
  readonly post: (channelId: string, text: string) => Promise<void>;
  /** Resolve an owner email → the channel where their approvals are surfaced. */
  readonly ownerChannelFor: (email: string) => string | undefined;
}

interface PendingApproval {
  readonly ownerExternalId: string;
  readonly resolve: (o: RemoteApprovalOutcome) => void;
}

export interface ApprovalClick {
  readonly requestId: string;
  readonly approverExternalId: string;
  readonly approved: boolean;
}

/**
 * Renders an owner-routed Approve/Reject card and resolves the executor's `requestRemote` with the
 * clicker identity. The executor's I20 path then verifies the clicker is a live, in-scope,
 * identity-valid delegate (here: the resolved resource owner) before honoring the decision.
 */
export class ApprovalPresenter {
  private readonly pending = new Map<string, PendingApproval>();
  private last = "";
  constructor(private readonly deps: ApprovalPresenterDeps) {}

  lastRequestId(): string {
    return this.last;
  }

  /** Wired as the executor's `requestRemote`. Reads the owner context from AsyncLocalStorage. */
  async requestApproval(): Promise<RemoteApprovalOutcome> {
    const ctx = getChatopsApprovalContext();
    if (ctx === undefined) return { kind: "timeout" };
    const channel = this.deps.ownerChannelFor(ctx.ownerEmail);
    if (channel === undefined) return { kind: "timeout" }; // → executor falls back to local owner
    const requestId = randomUUID();
    this.last = requestId;
    await this.deps.post(
      channel,
      `Approval needed from ${ctx.ownerEmail}: ${ctx.actionLabel} (requested by ${ctx.requesterExternalId}). Reply Approve/Reject.`,
    );
    return await new Promise<RemoteApprovalOutcome>((resolve) => {
      this.pending.set(requestId, { ownerExternalId: ctx.ownerExternalId, resolve });
    });
  }

  /** Called by the transport adapter when the owner clicks. */
  resolveClick(click: ApprovalClick): boolean {
    const entry = this.pending.get(click.requestId);
    if (entry === undefined) return false;
    this.pending.delete(click.requestId);
    entry.resolve({ kind: "answered", peerId: click.approverExternalId, approved: click.approved });
    return true;
  }
}
```

- [ ] **Step 5: Run test; lint; commit**

Run: `bun test packages/gateway/src/chatops/approval-presenter.test.ts`
Expected: PASS.

```bash
bunx biome check packages/gateway/src/chatops
git add packages/gateway/src/chatops/chatops-request-context.ts packages/gateway/src/chatops/approval-presenter.ts packages/gateway/src/chatops/approval-presenter.test.ts
git commit -m "feat(chatops): owner-routing request context + approval presenter (I20 reuse)"
```

---

## Task 7: Intent router (read→engine, write→gate, refusal audit)

**Files:**

- Create: `packages/gateway/src/chatops/intent-router.ts`
- Create: `packages/gateway/src/chatops/intent-router.test.ts`

**Read-path scope note (deferred refinement):** ChatOps reads invoke the engine `ask` over the **local** shared index. The gate on reads is *who may ask* (channel must be bound; user mapped, or `public-read` allowed). Fine-grained per-namespace content filtering of the **local** index via `engine.ask` is **deferred** (federated cross-peer reads are already scoped by I17). The router passes the bound namespace to the engine as context, but does not hard-filter local results in this slice. This is recorded as a known limitation in the spec acceptance notes.

- [ ] **Step 1: Write the failing test**

`packages/gateway/src/chatops/intent-router.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { IntentRouter } from "./intent-router.ts";
import type { ChatMessage } from "./types.ts";

function baseDeps() {
  const audits: { reason: string }[] = [];
  const replies: { text: string }[] = [];
  const gated: { actionType: string }[] = [];
  return {
    audits,
    replies,
    gated,
    deps: {
      knownActions: new Set(["deployment.rollback"]),
      resolveBinding: (_ch: string) => ({ namespace: "project:pay", unmapped: "refuse" as const, notify: [] }),
      resolveIdentity: async (_p: "slack" | "teams", _u: string) =>
        ({ kind: "mapped" as const, identity: { externalId: "ext-bob", email: "bob@acme.com", issuer: "https://idp" } }),
      resolveOwner: (_resource: string) => ({ kind: "owner" as const, email: "alice@acme.com" }),
      ownerExternalIdFor: (_email: string) => "ext-alice",
      askEngine: async (_query: string, _ns: string) => "answer: pagerduty oncall = alice",
      runGatedWrite: async (actionType: string) => { gated.push({ actionType }); return { approved: true }; },
      reply: async (text: string) => { replies.push({ text }); },
      auditRefusal: (reason: string) => { audits.push({ reason }); },
    },
  };
}

const msg = (text: string): ChatMessage => ({ platform: "slack", channelId: "C0", userId: "U_BOB", text, ts: "1.1" });

describe("IntentRouter", () => {
  test("unbound channel → ignored (no reply, no audit)", async () => {
    const { deps, replies } = baseDeps();
    const r = new IntentRouter({ ...deps, resolveBinding: () => undefined });
    await r.handle(msg("@nimbus hi"));
    expect(replies).toEqual([]);
  });

  test("read → engine answer replied", async () => {
    const { deps, replies } = baseDeps();
    await new IntentRouter(deps).handle(msg("@nimbus who's on call?"));
    expect(replies[0]?.text).toContain("oncall = alice");
  });

  test("write → owner-gated, executed on approval", async () => {
    const { deps, gated } = baseDeps();
    await new IntentRouter(deps).handle(msg("@nimbus run deployment.rollback service=payment-service version=v1.4"));
    expect(gated).toEqual([{ actionType: "deployment.rollback" }]);
  });

  test("unmapped user in refuse channel → refusal audited + replied", async () => {
    const { deps, audits, replies } = baseDeps();
    const r = new IntentRouter({ ...deps, resolveIdentity: async () => ({ kind: "unmapped" }) });
    await r.handle(msg("@nimbus who's on call?"));
    expect(audits.map((a) => a.reason)).toContain("unmapped_user");
    expect(replies.length).toBe(1);
  });

  test("write with no resolvable owner → refusal audited (no_owner)", async () => {
    const { deps, audits } = baseDeps();
    const r = new IntentRouter({ ...deps, resolveOwner: () => ({ kind: "none" }) });
    await r.handle(msg("@nimbus run deployment.rollback service=payment-service version=v1.4"));
    expect(audits.map((a) => a.reason)).toContain("no_owner");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/chatops/intent-router.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the router**

`packages/gateway/src/chatops/intent-router.ts`:

```typescript
import type { OwnerResolution } from "../policy/chatops-policy.ts";
import type { ChatopsChannelBinding } from "../policy/types.ts";
import { parseCommand } from "./command-parser.ts";
import type { ResolveResult } from "./identity-mapper.ts";
import type { ChatMessage, RefusalReason } from "./types.ts";

export interface IntentRouterDeps {
  readonly knownActions: ReadonlySet<string>;
  readonly resolveBinding: (channelId: string) => ChatopsChannelBinding | undefined;
  readonly resolveIdentity: (platform: "slack" | "teams", userId: string) => Promise<ResolveResult>;
  readonly resolveOwner: (resource: string) => OwnerResolution;
  readonly ownerExternalIdFor: (email: string) => string | undefined;
  readonly askEngine: (query: string, namespace: string) => Promise<string>;
  /** Runs the write through the executor HITL gate with owner-routing context already set up. */
  readonly runGatedWrite: (
    actionType: string,
    args: Readonly<Record<string, string>>,
    owner: { email: string; externalId: string },
    requesterExternalId: string,
    originatingChannelId: string,
  ) => Promise<{ approved: boolean }>;
  readonly reply: (text: string) => Promise<void>;
  readonly auditRefusal: (reason: RefusalReason, detail: string, channelId: string) => void;
}

export class IntentRouter {
  constructor(private readonly deps: IntentRouterDeps) {}

  private async refuse(reason: RefusalReason, detail: string, channelId: string): Promise<void> {
    this.deps.auditRefusal(reason, detail, channelId);
    await this.deps.reply(detail);
  }

  async handle(msg: ChatMessage): Promise<void> {
    const binding = this.deps.resolveBinding(msg.channelId);
    if (binding === undefined) return; // unbound channel: bot stays silent (fail-closed)

    const idr = await this.deps.resolveIdentity(msg.platform, msg.userId);
    const cmd = parseCommand(msg.text, this.deps.knownActions);

    if (idr.kind === "unmapped") {
      if (cmd.kind === "read" && binding.unmapped === "public-read") {
        await this.deps.reply(await this.deps.askEngine(cmd.query, binding.namespace));
        return;
      }
      await this.refuse("unmapped_user", "You are not enrolled for this channel.", msg.channelId);
      return;
    }

    if (cmd.kind === "refused") {
      await this.refuse(cmd.reason, cmd.detail, msg.channelId);
      return;
    }
    if (cmd.kind === "read") {
      await this.deps.reply(await this.deps.askEngine(cmd.query, binding.namespace));
      return;
    }

    // write
    const owner = this.deps.resolveOwner(cmd.resource);
    if (owner.kind === "none") {
      await this.refuse("no_owner", `No owner configured for '${cmd.resource}'.`, msg.channelId);
      return;
    }
    if (owner.kind === "ambiguous") {
      await this.refuse("ambiguous_owner", `Ambiguous ownership for '${cmd.resource}'.`, msg.channelId);
      return;
    }
    const ownerExternalId = this.deps.ownerExternalIdFor(owner.email);
    if (ownerExternalId === undefined) {
      await this.refuse("no_owner", `Owner '${owner.email}' has no Nimbus identity.`, msg.channelId);
      return;
    }
    const result = await this.deps.runGatedWrite(
      cmd.actionType,
      cmd.args,
      { email: owner.email, externalId: ownerExternalId },
      idr.identity.externalId,
      msg.channelId,
    );
    await this.deps.reply(
      result.approved ? `✅ ${cmd.actionType} approved & executed.` : `❌ ${cmd.actionType} rejected.`,
    );
  }
}
```

- [ ] **Step 4: Run test; lint; commit**

Run: `bun test packages/gateway/src/chatops/intent-router.test.ts`
Expected: PASS.

```bash
bunx biome check packages/gateway/src/chatops/intent-router.ts
git add packages/gateway/src/chatops/intent-router.ts packages/gateway/src/chatops/intent-router.test.ts
git commit -m "feat(chatops): intent router (read→engine, write→owner-gated, refusal audit)"
```

---

## Task 8: Connector tools (operational post + user lookup + socket open)

**Files:**

- Modify: `packages/mcp-connectors/slack/src/server.ts` (`slack_user_info`, `slack_chat_post`, `slack_socket_open`)
- Modify: `packages/mcp-connectors/teams/src/server.ts` (`teams_user_info`, `teams_chat_post`)
- Modify: `packages/gateway/src/connectors/connector-secrets-manifest.ts` (bot-token keys)
- Modify: existing connector contract test files (assert new tools exist)

> The HITL-gated `slack.message.post` / `teams.message.post` tools (if present) are **unchanged**. The new `*_chat_post` tools are the **operational** variant the dispatcher uses; D17 ensures only `reply-dispatcher.ts` / `transport/` reference them.

- [ ] **Step 1: Add the manifest keys (failing typecheck/test first)**

Add a test `packages/gateway/src/connectors/connector-secrets-manifest.chatops.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { CONNECTOR_VAULT_SECRET_KEYS } from "./connector-secrets-manifest.ts";

describe("chatops bot token keys", () => {
  test("slack carries a bot token key", () => {
    expect(CONNECTOR_VAULT_SECRET_KEYS.slack).toContain("slack.bot_token");
  });
  test("teams carries bot app credentials", () => {
    expect(CONNECTOR_VAULT_SECRET_KEYS.teams).toContain("teams.bot_app_id");
    expect(CONNECTOR_VAULT_SECRET_KEYS.teams).toContain("teams.bot_app_password");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/connectors/connector-secrets-manifest.chatops.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update the manifest**

In `connector-secrets-manifest.ts`:

```typescript
  teams: ["teams.bot_app_id", "teams.bot_app_password"],
  slack: ["slack.oauth", "slack.bot_token", "slack.app_token"],
```

> `slack.app_token` (xapp-…) is the Socket Mode app-level token; `slack.bot_token` (xoxb-…) is the bot user token used by `slack_chat_post`. Keep `slack.oauth` (existing user token).

- [ ] **Step 4: Add the Slack tools**

In `packages/mcp-connectors/slack/src/server.ts`, register (mirror the existing `reg(...)` idiom; read the bot token via `requireProcessEnv("SLACK_BOT_TOKEN")` and the app token via `requireProcessEnv("SLACK_APP_TOKEN")`):

```typescript
const slackUserInfoSchema = z.object({ user: z.string() });
reg(
  "slack_user_info",
  "Fetch a Slack user's profile (incl. email) by user id.",
  slackUserInfoSchema,
  async (parsed) => slackInvokeJson("users.info", { user: parsed.user }, "Slack users.info"),
);

const slackChatPostSchema = z.object({ channel: z.string(), text: z.string() });
reg(
  "slack_chat_post",
  "Post an operational bot message to a channel (ChatOps reply surface; bot token).",
  slackChatPostSchema,
  async (parsed) => {
    const token = requireProcessEnv("SLACK_BOT_TOKEN");
    return slackInvokeJsonWithToken(token, "chat.postMessage", { channel: parsed.channel, text: parsed.text }, "Slack chat.postMessage");
  },
);
```

> If `slackInvokeJson` hardcodes the user token, extract a `slackInvokeJsonWithToken(token, method, body, label)` helper and have `slackInvokeJson` delegate with `requireProcessEnv("SLACK_USER_ACCESS_TOKEN")`.

**`slack_socket_open` — interface contract (review S2).** Define the tool here so the connector edits are self-contained; the adapter's *use* of it lands in Task 9. The tool keeps the cloud call inside the connector (MCP-only) and returns a short-lived Socket Mode URL the adapter then holds:

```typescript
// schema: no inputs; output: { url: string } (a wss:// URL valid for ~30s)
const slackSocketOpenSchema = z.object({});
reg(
  "slack_socket_open",
  "Open a Slack Socket Mode connection and return the short-lived wss:// URL (app-level token).",
  slackSocketOpenSchema,
  async () => {
    const appToken = requireProcessEnv("SLACK_APP_TOKEN"); // xapp-… (Socket Mode)
    return slackInvokeJsonWithToken(appToken, "apps.connections.open", {}, "Slack apps.connections.open");
  },
);
```

The adapter (Task 9) calls this tool, reads `result.url`, and opens `new WebSocket(url)`. The MCP call (`apps.connections.open`) stays in the connector; only the socket lifecycle is the adapter's. This contract is fixed regardless of the Task 9 Step-0 spike (the spike only chooses adapter-owned-WS vs streaming-notifications for *consuming* events — the open-URL tool is needed either way).

- [ ] **Step 5: Add the Teams tools**

In `packages/mcp-connectors/teams/src/server.ts`:

```typescript
const teamsUserInfoSchema = z.object({ userId: z.string() });
reg(
  "teams_user_info",
  "Fetch a Teams/AAD user (incl. mail/userPrincipalName) by id.",
  teamsUserInfoSchema,
  async (parsed) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const r = await teamsPagedGraph(token, undefined, `/users/${encodeURIComponent(parsed.userId)}`);
    return graphListResult(r);
  },
);

const teamsChatPostSchema = z.object({ conversationId: z.string(), text: z.string() });
reg(
  "teams_chat_post",
  "Post an operational bot message to a Teams conversation (ChatOps reply surface; bot app creds).",
  teamsChatPostSchema,
  async (parsed) => {
    // Bot Framework send-activity via the bot app credentials (token acquisition helper in the connector).
    const r = await teamsBotSendActivity(parsed.conversationId, parsed.text);
    return graphListResult(r);
  },
);
```

> `teamsBotSendActivity` uses `TEAMS_BOT_APP_ID` / `TEAMS_BOT_APP_PASSWORD` (injected from the bot-token vault keys) to acquire an app token and POST to the Bot Framework service URL. Implement it in a small `teams/src/bot-send.ts` helper.

- [ ] **Step 6: Update contract tests**

In the existing slack/teams connector contract test(s), assert the new tool names appear in the registered tool list (follow the existing "lists tools" assertion pattern in those test files).

- [ ] **Step 7: Run tests; lint; commit**

Run: `bun test packages/gateway/src/connectors/connector-secrets-manifest.chatops.test.ts` and the connector contract tests (`bun test packages/mcp-connectors/slack packages/mcp-connectors/teams`).
Expected: PASS.

```bash
bunx biome check packages/mcp-connectors/slack packages/mcp-connectors/teams packages/gateway/src/connectors/connector-secrets-manifest.ts
git add packages/mcp-connectors/slack packages/mcp-connectors/teams packages/gateway/src/connectors/connector-secrets-manifest.ts packages/gateway/src/connectors/connector-secrets-manifest.chatops.test.ts
git commit -m "feat(chatops): connector operational-post + user-lookup tools + bot vault keys"
```

---

## Task 9: Transport adapters (Slack Socket Mode + Teams webhook)

**Files:**

- Create: `packages/gateway/src/chatops/transport/transport.ts`
- Create: `packages/gateway/src/chatops/transport/slack-socket-adapter.ts`
- Create: `packages/gateway/src/chatops/transport/slack-socket-adapter.test.ts`
- Create: `packages/gateway/src/chatops/transport/teams-webhook-adapter.ts`
- Create: `packages/gateway/src/chatops/transport/teams-webhook-adapter.test.ts`
- Modify: `packages/gateway/src/ipc/http-write-routes.ts` (add Teams events route to I13 allowlist)

- [ ] **Step 0: Socket-Mode-shape spike (record the decision)**

Before code, decide and record in the plan file (append a one-paragraph "Socket Mode decision" note): model the Slack Socket Mode stream as **(b)** an adapter-owned WebSocket where the connector provides a short-lived `apps.connections.open` URL via a `slack_socket_open` tool returning `{ url }`; the adapter holds the `ws` (Bun's `WebSocket`). This keeps the cloud *call* in the connector (MCP-only) while the adapter owns socket lifecycle. (Fallback (a) — streaming MCP notifications — only if Bun WS proves unusable here.)

- [ ] **Step 1: Write the failing test for the transport interface + Slack reconnect/idempotency**

`packages/gateway/src/chatops/transport/slack-socket-adapter.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { dedupeKey, SlackEventNormalizer } from "./slack-socket-adapter.ts";

describe("Slack adapter helpers", () => {
  test("normalizes a message event to a ChatMessage", () => {
    const n = new SlackEventNormalizer();
    const m = n.normalize({
      type: "events_api",
      payload: { event: { type: "app_mention", channel: "C1", user: "U1", text: "<@U0> hi", ts: "1.2" } },
    });
    expect(m).toEqual({ platform: "slack", channelId: "C1", userId: "U1", text: "<@U0> hi", ts: "1.2" });
  });

  test("non-mention events normalize to undefined", () => {
    const n = new SlackEventNormalizer();
    expect(n.normalize({ type: "hello" })).toBeUndefined();
  });

  test("dedupeKey is stable for (channel, ts)", () => {
    expect(dedupeKey("C1", "1.2")).toBe(dedupeKey("C1", "1.2"));
    expect(dedupeKey("C1", "1.2")).not.toBe(dedupeKey("C1", "1.3"));
  });

  test("backoff grows then caps", async () => {
    const { computeBackoffMs } = await import("./slack-socket-adapter.ts");
    expect(computeBackoffMs(0)).toBeLessThan(computeBackoffMs(3));
    expect(computeBackoffMs(100)).toBeLessThanOrEqual(60_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/chatops/transport/slack-socket-adapter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement transport interface + Slack adapter helpers**

`packages/gateway/src/chatops/transport/transport.ts`:

```typescript
import type { ChatMessage, ChatPlatform } from "../types.ts";

export interface ChatTransport {
  readonly platform: ChatPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  connected(): boolean;
  /** Wire the inbound handler before start(). */
  onMessage(handler: (m: ChatMessage) => Promise<void>): void;
}
```

`packages/gateway/src/chatops/transport/slack-socket-adapter.ts` (helpers shown; the full adapter wires Bun `WebSocket` + reconnect + dedupe set, using these pure helpers):

```typescript
import type { ChatMessage } from "../types.ts";

export function dedupeKey(channelId: string, ts: string): string {
  return `${channelId} ${ts}`;
}

/** Exponential backoff with jitter, capped at 60s. */
export function computeBackoffMs(attempt: number): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  // deterministic jitter by attempt index (no Math.random — see harness constraints)
  const jitter = (attempt % 5) * 100;
  return base + jitter;
}

export class SlackEventNormalizer {
  normalize(frame: unknown): ChatMessage | undefined {
    if (frame === null || typeof frame !== "object") return undefined;
    const f = frame as Record<string, unknown>;
    if (f["type"] !== "events_api") return undefined;
    const payload = f["payload"] as Record<string, unknown> | undefined;
    const event = payload?.["event"] as Record<string, unknown> | undefined;
    if (event === undefined || event["type"] !== "app_mention") return undefined;
    const channel = event["channel"];
    const user = event["user"];
    const text = event["text"];
    const ts = event["ts"];
    if (typeof channel !== "string" || typeof user !== "string" || typeof text !== "string" || typeof ts !== "string") {
      return undefined;
    }
    return { platform: "slack", channelId: channel, userId: user, text, ts };
  }
}
```

> The class body of `SlackSocketAdapter implements ChatTransport` holds: a **bounded FIFO dedupe set** (review S1), the `ws` handle, `start()` that calls the connector `slack_socket_open` to get `{ url }` then opens `new WebSocket(url)`, `onmessage` → normalize → dedupe → `handler(m)`, `onclose` → `setTimeout(reconnect, computeBackoffMs(attempt++))`, and a ping/pong keepalive. Implement it with these helpers; keep cloud calls in the connector.
>
> **Dedupe set eviction (review S1) — concrete strategy:** use a `Set<string>` plus an insertion-order queue capped at `MAX_DEDUPE = 1000`. On each new key: `if (seen.has(key)) return; // already processed` else `seen.add(key); queue.push(key); if (queue.length > MAX_DEDUPE) seen.delete(queue.shift()!);`. This bounds memory to ~1000 keys regardless of uptime. (Slack redelivers only recent events on reconnect, so a 1000-key window comfortably covers the retry horizon; no time-based expiry needed.) Add a unit test: inserting 1001 distinct keys evicts the oldest (key #1 is re-processable, key #1001 is deduped).

- [ ] **Step 4: Write the failing test for Teams webhook normalization + JWT auth seam**

`packages/gateway/src/chatops/transport/teams-webhook-adapter.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { normalizeTeamsActivity } from "./teams-webhook-adapter.ts";

describe("Teams activity normalization", () => {
  test("message activity → ChatMessage", () => {
    const m = normalizeTeamsActivity({
      type: "message",
      text: "<at>Nimbus</at> who's on call?",
      id: "act-1",
      from: { id: "29:user" },
      conversation: { id: "19:conv" },
    });
    expect(m).toEqual({
      platform: "teams",
      channelId: "19:conv",
      userId: "29:user",
      text: "<at>Nimbus</at> who's on call?",
      ts: "act-1",
    });
  });

  test("non-message activity → undefined", () => {
    expect(normalizeTeamsActivity({ type: "conversationUpdate" })).toBeUndefined();
  });
});
```

- [ ] **Step 5: Implement the Teams normalizer**

`packages/gateway/src/chatops/transport/teams-webhook-adapter.ts`:

```typescript
import type { ChatMessage } from "../types.ts";

export function normalizeTeamsActivity(activity: unknown): ChatMessage | undefined {
  if (activity === null || typeof activity !== "object") return undefined;
  const a = activity as Record<string, unknown>;
  if (a["type"] !== "message") return undefined;
  const from = a["from"] as Record<string, unknown> | undefined;
  const conv = a["conversation"] as Record<string, unknown> | undefined;
  const userId = from?.["id"];
  const channelId = conv?.["id"];
  const text = a["text"];
  const id = a["id"];
  if (typeof userId !== "string" || typeof channelId !== "string" || typeof text !== "string" || typeof id !== "string") {
    return undefined;
  }
  return { platform: "teams", channelId, userId, text, ts: id };
}
```

- [ ] **Step 6: Add the Teams events route to the I13 allowlist**

In `packages/gateway/src/ipc/http-write-routes.ts`:

```typescript
const ROUTE_TEAMS_EVENTS = "POST /v1/messaging/teams/events";
```

Add `ROUTE_TEAMS_EVENTS` to `WRITE_ROUTE_ALLOWLIST` (now 6 entries). Add a `messaging?` surface to `WriteRouteContext`:

```typescript
  readonly messaging?: TeamsEventsSurface;
```

Resolve the route in `resolveRoute` with `kind: "teamsEvents"`, `hasBody: true`, `expectedToken` unused (auth is the Bot Framework JWT — see below), `rejectAction: "messaging.teams.inbound"`. In `dispatchWriteRoute`, before the SCIM fallthrough:

```typescript
  if (route.kind === "teamsEvents") {
    return runTeamsEventsRoute(ctx, auth.fingerprint, limit, req, parsed);
  }
```

`runTeamsEventsRoute` validates the **Bot Framework JWT** from the `Authorization: Bearer` header by reusing the JWKS-cache + RS256 verifier pattern (`identity/jwks-cache.ts` against `https://login.botframework.com/v1/.well-known/openidconfiguration` → JWKS uri; `aud` must equal `ctx.messaging.teamsBotAppId`), then calls `ctx.messaging.onActivity(parsed)`. On invalid token → 401 + `recordRejection`. Define:

```typescript
export interface TeamsEventsSurface {
  readonly teamsBotAppId: string;
  readonly validateBotJwt: (authorizationHeader: string | null, nowMs: number) => Promise<boolean>;
  readonly onActivity: (activity: unknown) => Promise<void>;
}
```

> The `checkAuth` step currently always runs `requireBearer`; for `teamsEvents` skip the static-bearer check (return `{ fingerprint: "teams-bot" }`) and do the JWT validation inside `runTeamsEventsRoute`, mirroring how SCIM uses its own token. Keep body-cap + rate-limit + audit-on-reject.
>
> **Offline / restricted-network behavior (review Q2).** No separate offline mode and **no HMAC/static-secret fallback** — the latter was explicitly rejected in the spec design-review (spec §7: "there is no shared-secret/proxy mode; validation is in-gateway"), and a Teams Bot Framework bot is architecturally online by definition: it receives activities *from* Microsoft's cloud and must POST replies *back* to a Microsoft service URL with a Microsoft-issued app token, so it cannot operate without reaching Microsoft at all. The real resilience is already built in: `identity/jwks-cache.ts` persists fetched keys to the **on-disk `oidc_jwks_cache` SQLite table** with a TTL (`jwksMaxAgeSeconds`), and Microsoft's Bot Framework signing keys rotate slowly — so a cached key survives gateway restarts and transient outages; only a cold start during a full outage fails closed (401), which is the correct fail-closed posture. Set the Teams JWKS TTL generously (reuse the identity `jwksMaxAgeSeconds`, default 86400s). This is documented, not a code change.

- [ ] **Step 7: Run tests; lint; commit**

Run: `bun test packages/gateway/src/chatops/transport packages/gateway/src/ipc/http-write-routes.test.ts`
Expected: PASS (update the http-write-routes allowlist-count assertion to 6).

```bash
bunx biome check packages/gateway/src/chatops/transport packages/gateway/src/ipc/http-write-routes.ts
git add packages/gateway/src/chatops/transport packages/gateway/src/ipc/http-write-routes.ts
git commit -m "feat(chatops): Slack Socket Mode + Teams webhook (I13 5→6, Bot Framework JWT via jwks-cache)"
```

---

## Task 10: ChatOps service + IPC + LAN/Tauri allowlists + CLI

**Files:**

- Create: `packages/gateway/src/chatops/chatops-service.ts`
- Create: `packages/gateway/src/chatops/chatops-service.test.ts`
- Create: `packages/gateway/src/ipc/chatops-rpc.ts`
- Create: `packages/gateway/src/ipc/chatops-rpc.test.ts`
- Modify: central IPC dispatcher (register `dispatchChatopsRpc`) — `packages/gateway/src/ipc/server/dispatchers.ts` (same site as `dispatchPolicyRpc`)
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (`"chatops"` in `FORBIDDEN_OVER_LAN`)
- Modify: `packages/gateway/src/ipc/lan-rpc.test.ts` (assert chatops forbidden)
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (`"chatops.status"` in `ALLOWED_METHODS`)
- Modify: the Rust allowlist test (count/contains)
- Modify: `packages/cli/src/...` (add `nimbus chatops` subcommand)

- [ ] **Step 1: Write the failing test for `chatops-rpc.ts`**

`packages/gateway/src/ipc/chatops-rpc.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { dispatchChatopsRpc } from "./chatops-rpc.ts";

const ctx = {
  status: () => ({ enabled: true, platforms: [{ name: "slack" as const, connected: true, channels: 2 }], lastEventAt: 123 }),
  start: async () => {},
  stop: async () => {},
  testParse: (text: string) => ({ kind: "read" as const, query: text }),
};

describe("chatops-rpc", () => {
  test("chatops.status returns a snapshot", async () => {
    const r = await dispatchChatopsRpc("chatops.status", {}, ctx);
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") expect((r.value as { enabled: boolean }).enabled).toBe(true);
  });
  test("unknown method → miss", async () => {
    expect((await dispatchChatopsRpc("chatops.nope", {}, ctx)).kind).toBe("miss");
  });
  test("chatops.test parses a message", async () => {
    const r = await dispatchChatopsRpc("chatops.test", { text: "hi" }, ctx);
    if (r.kind === "hit") expect(r.value).toEqual({ kind: "read", query: "hi" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/ipc/chatops-rpc.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `chatops-rpc.ts`** (mirror `policy-rpc.ts`)

```typescript
import { dispatchByMethod, type RpcMethodHandlerMap, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export interface ChatopsStatus {
  readonly enabled: boolean;
  readonly platforms: readonly { name: "slack" | "teams"; connected: boolean; channels: number }[];
  readonly lastEventAt?: number;
}

export interface ChatopsRpcCtx {
  readonly status: () => ChatopsStatus;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly testParse: (text: string) => unknown;
}

function requireString(params: unknown, key: string): string {
  const rec = params as Record<string, unknown> | null;
  const v = rec === null || typeof rec !== "object" ? undefined : rec[key];
  if (typeof v !== "string") throw new Error(`ERR_INVALID_PARAMS: ${key} (string) required`);
  return v;
}

const HANDLERS: RpcMethodHandlerMap<ChatopsRpcCtx> = {
  "chatops.status": (_p, ctx) => ctx.status(),
  "chatops.start": async (_p, ctx) => { await ctx.start(); return { ok: true } as const; },
  "chatops.stop": async (_p, ctx) => { await ctx.stop(); return { ok: true } as const; },
  "chatops.test": (p, ctx) => ctx.testParse(requireString(p, "text")),
} as const;

export function dispatchChatopsRpc(method: string, params: unknown, ctx: ChatopsRpcCtx): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, HANDLERS);
}
```

- [ ] **Step 4: Implement `chatops-service.ts`** (lifecycle wiring; ties Tasks 3–9 together)

`chatops-service.ts` builds: the identity mapper (Task 3), policy resolvers (Task 2 via `policyGate.enforced().chatops`), command parser known-actions = `HITL_REQUIRED` ∩ a chatops-exposed set, reply dispatcher (Task 5) wired to the connector `slack_chat_post`/`teams_chat_post`, approval presenter (Task 6), intent router (Task 7), and the two transports (Task 9). It exposes `status()/start()/stop()/testParse()` for the RPC. `runGatedWrite` sets the AsyncLocalStorage context (Task 6) then calls `executor.gate(action)` with the ChatOps-configured executor whose `delegation.requestRemote` = `approvalPresenter.requestApproval`. Write the unit test `chatops-service.test.ts` with all collaborators injected as fakes asserting: `status()` reflects transport `connected()`, and `start()`/`stop()` call each transport once.

- [ ] **Step 5: Register the RPC + lock down LAN + Tauri**

- In the central dispatcher (`ipc/server/dispatchers.ts`, where `dispatchPolicyRpc` is invoked), add a `dispatchChatopsRpc` branch returning its hit/miss.
- In `lan-rpc.ts`, add `"chatops"` to `FORBIDDEN_OVER_LAN` (with a comment: local/Tauri-read-only; never answerable over LAN). Add a test in `lan-rpc.test.ts`: `expect(() => checkLanMethodAllowed("chatops.start", peer)).toThrow()`.
- In `gateway_bridge.rs`, insert `"chatops.status",` into `ALLOWED_METHODS` (keep alphabetical: after `"audit.verify"` / before `"connector.list"` — place per the existing ordering). Update the Rust allowlist count test.

- [ ] **Step 6: Add the `nimbus chatops` CLI subcommand**

In the CLI command tree, add `chatops` with `status` (calls `chatops.status`, prints platforms + connected), `start`, `stop`, and `test "<message>"` (calls `chatops.test`). Follow the existing `nimbus policy` / `nimbus team` subcommand structure. Add a CLI unit test mirroring an existing subcommand test (e.g. `commands/policy.test.ts`, which asserts `{ method: "policy.show", params: {} }`).

> **No `packages/client` change needed (review Q1 — verified).** The typed `@nimbus-dev/client` exposes a **generic** `ipc.call<T>(method, params)` (see `nimbus-client.ts`); it does **not** carry per-method wrappers. Every Slice 3/4 method (`identity.bind`, `policy.show`, `connector.sync`, …) is invoked via `client.call("<method>", params)` — there is no `policy`/`identity` method on the client, and `grep` over `packages/client/src` finds none. So `chatops.*` is reached the same way (`c.call("chatops.status", {})`) and the CLI compiler will **not** fail on missing types. (Re-running `cd packages/client && bun run build` is only needed because of the worktree dist gotcha, not because of new methods.)

- [ ] **Step 7: Run tests; lint; commit**

Run: `bun test packages/gateway/src/ipc/chatops-rpc.test.ts packages/gateway/src/chatops/chatops-service.test.ts packages/gateway/src/ipc/lan-rpc.test.ts`
Run (Rust): `cargo test --manifest-path packages/ui/src-tauri/Cargo.toml allowed_methods` (or the repo's documented Rust test command).
Expected: PASS.

```bash
bunx biome check packages/gateway/src/chatops packages/gateway/src/ipc/chatops-rpc.ts
git add packages/gateway/src/chatops/chatops-service.ts packages/gateway/src/chatops/chatops-service.test.ts packages/gateway/src/ipc/chatops-rpc.ts packages/gateway/src/ipc/chatops-rpc.test.ts packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/ipc/lan-rpc.test.ts packages/gateway/src/ipc/server/dispatchers.ts packages/ui/src-tauri/src/gateway_bridge.rs packages/cli/src
git commit -m "feat(chatops): service lifecycle + chatops.* IPC + LAN-forbidden + Tauri status + CLI"
```

---

## Task 11: Watcher notification routing → ChatOps channel

**Files:**

- Modify: `packages/gateway/src/automation/watcher-engine.ts` (allow a notify target that posts to a namespace's ChatOps notify channels)
- Create/Modify: the watcher wiring site that constructs the `notify` callback (search for the caller of `evaluateWatchersAfterSync`)
- Create: `packages/gateway/src/automation/watcher-chatops-notify.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/gateway/src/automation/watcher-chatops-notify.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { makeChatopsWatcherNotify } from "./watcher-engine.ts";

describe("makeChatopsWatcherNotify", () => {
  test("routes a watcher alert to the namespace's notify channels via the reply dispatcher", async () => {
    const sent: { ns: string; text: string }[] = [];
    const notify = makeChatopsWatcherNotify({
      namespaceForWatcher: () => "project:pay",
      sendToNamespace: async (ns, text) => { sent.push({ ns, text }); },
    });
    await notify("Nimbus watcher", "deploy-watch: prod deploy detected");
    expect(sent).toEqual([{ ns: "project:pay", text: "deploy-watch: prod deploy detected" }]);
  });

  test("no namespace mapping → no send (local-only watcher)", async () => {
    const sent: unknown[] = [];
    const notify = makeChatopsWatcherNotify({
      namespaceForWatcher: () => undefined,
      sendToNamespace: async () => { sent.push(1); },
    });
    await notify("t", "b");
    expect(sent).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/automation/watcher-chatops-notify.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the helper**

Add to `watcher-engine.ts`:

```typescript
export interface ChatopsWatcherNotifyDeps {
  /** Map the current watcher context to a namespace (or undefined for local-only). */
  readonly namespaceForWatcher: () => string | undefined;
  /** Post to a namespace's ChatOps notify channels (ReplyDispatcher.send with a namespaceNotify target). */
  readonly sendToNamespace: (namespace: string, text: string) => Promise<void>;
}

/** Build a watcher `notify(title, body)` callback that also routes to a ChatOps channel (S/Slice-5). */
export function makeChatopsWatcherNotify(
  deps: ChatopsWatcherNotifyDeps,
): (title: string, body: string) => Promise<void> {
  return async (_title, body) => {
    const ns = deps.namespaceForWatcher();
    if (ns === undefined) return;
    await deps.sendToNamespace(ns, body);
  };
}
```

At the wiring site that calls `evaluateWatchersAfterSync`, compose the existing IPC-notify callback with this one (call both) when ChatOps is enabled and a notify channel exists for the namespace.

- [ ] **Step 4: Run test; lint; commit**

Run: `bun test packages/gateway/src/automation/watcher-chatops-notify.test.ts`
Expected: PASS.

```bash
bunx biome check packages/gateway/src/automation/watcher-engine.ts
git add packages/gateway/src/automation/watcher-engine.ts packages/gateway/src/automation/watcher-chatops-notify.test.ts
git commit -m "feat(chatops): route watcher alerts to a namespace's ChatOps notify channel"
```

---

## Task 12: End-to-end (mock Slack socket + mock Teams webhook)

**Files:**

- Create: `packages/gateway/test/e2e/chatops-e2e.test.ts` (follow the existing e2e harness location/pattern — search `packages/gateway/test/e2e` or the repo's e2e dir)
- Create: `packages/gateway/test/e2e/_mocks/mock-slack-socket.ts`, `_mocks/mock-teams-webhook.ts` (or reuse existing mock-MCP harness)

- [ ] **Step 1: Write the e2e test**

The test boots a real Gateway subprocess with: ChatOps enabled, a signed test policy binding channel `C0` → namespace `project:pay` (`unmapped="refuse"`) + ownership `payment-service=alice@acme.com` + `*=oncall@acme.com`, a SCIM user bob (requester) + alice (owner) active, and mock Slack/Teams transports. Assert:

```typescript
// 1. Read: bob asks "@nimbus who's on call for payment-service?" → a reply containing oncall info, no real cloud call.
// 2. Write: bob "@nimbus run deployment.rollback service=payment-service version=v1.4"
//    → an Approve/Reject card posted to alice's channel (mock captures it).
// 3. Alice approves → the deployment.rollback connector tool is invoked AND an audit row exists
//    with actionType=deployment.rollback, hitlStatus=approved.
// 4. Alice rejects (separate run) → no connector invocation, audit hitlStatus=rejected.
// 5. An unmapped user in C0 → refusal reply + a refusal audit row.
// 6. ReplyDispatcher never posts to a channel outside {originating, policy-notify} (I23 sanity).
```

Use the existing e2e helpers for: spawning the gateway, seeding SCIM users, signing a policy (`signPolicy` + pin pubkey), and reading the audit chain. Mirror an existing federation/identity e2e test for the harness shape.

- [ ] **Step 2: Run the e2e test**

Run: `bun test packages/gateway/test/e2e/chatops-e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/e2e/chatops-e2e.test.ts packages/gateway/test/e2e/_mocks
git commit -m "test(chatops): e2e — read, owner-routed write approve/reject, unmapped refusal, I23"
```

---

## Task 13: Docs + CHANGELOG + roadmap + coverage verification

**Files:**

- Modify: `docs/roadmap.md` (mark the four ChatOps bullets `[x]` with a delivered summary, mirroring the Slice 4 summary paragraph)
- Modify: `docs/CHANGELOG.md` (Slice 5 entry)
- Modify: `docs/cli-reference.md` (`nimbus chatops`)
- Modify: `docs/architecture.md` (chatops subsystem + I23 in the invariant prose/count)
- Modify: `CLAUDE.md` + `GEMINI.md` (I23 row already added in Task 5; confirm invariant count prose + add `nimbus-chatops`-relevant skill row if applicable)
- Verify: doc-ref + readme-cli audits

- [ ] **Step 1: Update the docs**

Add the I23 entry everywhere the I-list/count appears (use the doc-status-drift surface list: `architecture.md`, `SECURITY-INVARIANTS.md` (done), `hardening`, schema-ref, `tauri-allowlist` skill if it lists counts). Mark roadmap ChatOps bullets delivered with a one-paragraph summary referencing I23/D17, the `[policy.chatops.*]` schema, `chatops.*` IPC, and `nimbus chatops`.

- [ ] **Step 2: Run the doc + structure audits**

Run: `bun run audit:doc-refs`
Run: `bun run audit:readme-cli`
Run: `bun scripts/structure-audit/check-nimbus-invariants.ts`
Expected: all green / exit 0.

- [ ] **Step 3: Verify coverage floor via Docker (CI-Linux-authoritative)**

Use the `nimbus-coverage-floor` agent / the documented Docker recipe (`oven/bun:latest`, bun 1.3.14) to run `audit:coverage-floor` on a Linux-native checkout — **not** local `bun test --coverage`. Add targeted tests for any `chatops/` file below the ≥80% line+branch floor; update the baseline only if a file is legitimately glue. Re-run until green.

- [ ] **Step 4: Commit**

```bash
git add docs CLAUDE.md GEMINI.md
git commit -m "docs(chatops): roadmap delivered summary + CHANGELOG + cli-reference + I23 prose"
```

---

## Task 14: Preflight + push

- [ ] **Step 1: Scoped preflight (memory-safe)**

Run: `bun run preflight:fast`
Then the scoped suites touched this slice:
Run: `bun test packages/gateway/src/chatops packages/gateway/src/policy packages/gateway/src/ipc/chatops-rpc.test.ts packages/gateway/src/ipc/http-write-routes.test.ts packages/gateway/src/security-invariants.test.ts`
Expected: green.

- [ ] **Step 2: Preflight guard before pushing**

Use the `nimbus-preflight-guard` agent for the go/no-go (it runs the memory-safe static gates + scoped tests + Docker dry-run for coverage/connectors/migrations touched). Fix any no-go before pushing.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin dev/asafgolombek/phase6-slice5-chatops
gh pr create --title "Phase 6 Slice 5 — ChatOps (Slack/Teams bot, HITL-via-chat)" --body "<summary + spec link + I23 note>"
```

If CI goes red, use the `nimbus-ci-doctor` agent; for the SonarCloud gate use `nimbus-sonar-gate`. The Windows cross-platform job is known-flaky (separate investigation) — don't block Slice 5 on it; confirm the Ubuntu `pr-quality` gate is green.

---

## Self-review (against the spec)

**Spec coverage:**

- Bidirectional bot / `@nimbus` reads + writes → Tasks 4, 7, 9, 10, 12. ✓
- Write→HITL, never bypass → Task 7 (`runGatedWrite` → `executor.gate`) + Task 6 (I20 reuse). ✓
- HITL via chat (interactive approve/reject, approver identity in audit) → Task 6 + Task 12. ✓
- Notification routing per watcher rule + namespace → Task 11. ✓
- Bot security model: token in Team Vault → Task 8 (vault keys) + Task 10 (service reads via teamvault); channel↔namespace in policy → Task 2; never exceed requester scope → Task 3 (mapping) + Task 7. ✓
- Decisions D1 (transport-abstracted) → Tasks 9/10; D2 (per-channel unmapped) → Tasks 2/7; D3 (owner-routed) → Tasks 6/7; D4 (ownership in signed policy) → Task 2; D5 (hybrid parse) → Task 4; D6 (extend connectors) → Task 8; D7 (I23) → Task 5; D8 (watcher notify) → Task 11. ✓
- Review resolutions: Q1 → Task 3; Q2 → Task 9 (Step 6); Q3a → Task 2; Q3c → Tasks 6/7 (self-approval handled by I20 fallback + quorum upstream — note: when owner==requester and no quorum, the executor's local-owner fallback path applies; ensure the service treats owner==requester by routing to the requester's own channel); S1 → Task 4; S2 → Task 9; S3 → Task 7 (`auditRefusal`). ✓

**Placeholder scan:** no "TBD"/"handle appropriately"; every code step has real code. Two intentional deferrals are explicitly flagged, not placeholders: (a) per-namespace content filtering of local reads (Task 7 note); (b) the Socket Mode adapter's full WS body is described via concrete helpers + a recorded Step-0 decision (Task 9).

**Type consistency:** `ChatMessage`/`ParsedCommand`/`ReplyTarget`/`ChatIdentity` (Task 1) are used unchanged in Tasks 4–10; `RemoteApprovalOutcome` (verbatim from `delegated-approval.ts`) is produced by the presenter (Task 6) exactly as the executor expects; `OwnerResolution` (Task 2) is consumed by the router (Task 7); `ChatopsChannelBinding`/`ChatopsPolicy` (Task 2) flow through `EnforcedPolicy` to the service (Task 10).

**Gaps fixed inline:** owner==requester self-approval interaction noted in Task 7/self-review (the I20 fallback + upstream quorum already cover it; the service routes a self-owned write to the requester's own channel so they confirm their own action — matching spec §5).
