# ChatOps Egress Ledger Implementation Plan (PR 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every outbound ChatOps post appends one `egress_ledger` row before the bytes leave, fail-closed, so `nimbus prove` stops reporting zero for windows in which the gateway posted to Slack or Teams.

**Architecture:** A decorator over the single `post` closure that `ReplyDispatcher` and `ApprovalPresenter` already share (`chatops-boot.ts:164`). The post *kind* is bound at construction — one factory returns one wrapped function per kind — so `method` stays server-derived rather than caller-supplied. Adds a twelfth `egress_ledger.source_type` (`chatops`) and an eighth coverage class, inserted at sort index 0 because `COVERAGE_CLASSES` order is the wire format.

**Tech Stack:** Bun 1.2+, TypeScript strict, `bun:sqlite`, `@noble/hashes/blake3`, Biome.

**Spec:** [`docs/superpowers/specs/2026-08-29-chatops-agent-intent-design.md`](../specs/2026-08-29-chatops-agent-intent-design.md) §5 (this PR), §13 (review responses).

**Reviewed:** [plan review](./2026-08-29-chatops-egress-ledger-review.md) (Antigravity, 2026-08-29) — responses in § Review Responses.

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **No plaintext credentials** anywhere — Vault only, never logs/IPC/config.
- **Cross-platform:** `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Fail-closed:** append BEFORE the side effect; an append failure aborts the side effect.
- **The triple rule:** invariant wiring + `docs/SECURITY-INVARIANTS.md` + an enforcement test land in the **same commit**.
- **`COVERAGE_CLASSES` is key-sorted and the order IS the wire format** — `chatops` inserts at index 0, before `http`. Appending instead of inserting typecheck-passes and produces a canonical string no other binary agrees with.
- **Verify with `bun run preflight:fast`** after every code change; `bun run preflight` before the PR.
- **Never commit on `main`.** Work on `dev/asaf/chatops-egress-ledger`.
- Conventional-commit type goes in the **PR title** (squash builds the commit from title + body).

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/egress/egress-source-type.ts` | **Modify** — add `chatops` to the frozen union + its decision rationale |
| `packages/gateway/src/egress/egress-coverage.ts` | **Modify** — add `chatops` at index 0; `THIS_BINARY_COVERAGE.chatops = "per-call"` |
| `packages/gateway/src/chatops/channel-salt.ts` | **Create** — per-install salt in the Vault; `hashChannelId` |
| `packages/gateway/src/egress/chatops-egress.ts` | **Create** — `buildLedgeredChatPosts` factory (the appender) |
| `packages/gateway/src/chatops/chatops-boot.ts` | **Modify** — wire the factory; raw `post` never bound to a name |
| `scripts/structure-audit/check-nimbus-invariants.ts` | **Modify** — extend D17; register the vault key; delete two dead paths |
| `packages/cli/src/commands/prove.ts` | **Modify** — `COVERAGE_CLASS_LABELS.chatops` (hand-maintained mirror) |
| `docs/SECURITY-INVARIANTS.md` | **Modify** — I29 gains the `chatops` class |
| `docs/CHANGELOG.md` | **Modify** — one dated entry |

---

## Task 1: The `chatops` source type and coverage class

**Files:**
- Modify: `packages/gateway/src/egress/egress-source-type.ts:88-101` (the `EGRESS_SOURCE_TYPES` array)
- Modify: `packages/gateway/src/egress/egress-coverage.ts:19-27` (`COVERAGE_CLASSES`), and `THIS_BINARY_COVERAGE`
- Test: `packages/gateway/src/egress/egress-coverage.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `EgressSourceType` now includes `"chatops"`; `CoverageClass` includes `"chatops"`. Task 4 writes rows with `sourceType: "chatops"`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/egress/egress-coverage.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  COVERAGE_CLASSES,
  parseCoverage,
  serializeCoverage,
  THIS_BINARY_COVERAGE,
} from "./egress-coverage.ts";

describe("chatops coverage class", () => {
  test("chatops is the FIRST class — the array order is the wire format", () => {
    // Not just "is present": appending would typecheck and round-trip within one binary
    // while producing a canonical string no other binary agrees with.
    expect(COVERAGE_CLASSES[0]).toBe("chatops");
    expect([...COVERAGE_CLASSES]).toEqual([...COVERAGE_CLASSES].sort());
  });

  test("this binary observes chatops per-call", () => {
    expect(THIS_BINARY_COVERAGE.chatops).toBe("per-call");
  });

  test("serialize puts chatops first and parse round-trips it", () => {
    const s = serializeCoverage(THIS_BINARY_COVERAGE);
    expect(s.startsWith("chatops=per-call;")).toBe(true);
    expect(parseCoverage(s)).toEqual(THIS_BINARY_COVERAGE);
  });

  test("a vector missing chatops parses as null, never a partial vector", () => {
    const withoutChatops = serializeCoverage(THIS_BINARY_COVERAGE)
      .split(";")
      .filter((seg) => !seg.startsWith("chatops="))
      .join(";");
    expect(parseCoverage(withoutChatops)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/egress/egress-coverage.test.ts`
Expected: FAIL — `COVERAGE_CLASSES[0]` is `"http"`, and `THIS_BINARY_COVERAGE.chatops` is a type error.

- [ ] **Step 3: Add the source type**

In `egress-source-type.ts`, insert into `EGRESS_SOURCE_TYPES` (position in this array does not matter — only `COVERAGE_CLASSES` order is a wire format):

```ts
  "chatops", // an outbound Slack/Teams post
```

Above the array, extend the header comment with the decision (this file records every source-type decision; a casual append is the documented anti-pattern):

```
 * `chatops` is the twelfth member, and an EGRESS class rather than a marker. It records an
 * outbound Slack/Teams post. It is a STRONGER claim than `mcp`/`http`, not a weaker one: those
 * two hand a brief to a LOCAL process, whereas a chat post genuinely leaves the machine to a
 * third-party server.
 *
 * Reusing an existing member was rejected for the fourth time, and this time the candidates are
 * worse than before: `task` would imply the executor gated it (it does not — the post path never
 * reaches `connectors.dispatch`), and `mcp`/`http` would merge a real third-party send with a
 * local hand-off under one permanent string.
 *
 * Unlike `mcp` and `http`, this class is NOT narrower than its name: it covers every outbound
 * post on the `chatops-boot.ts` `post` closure — operational replies, HITL approval cards,
 * tribal suggestions, and agent briefs once those land.
```

- [ ] **Step 4: Add the coverage class at index 0**

In `egress-coverage.ts`:

```ts
export const COVERAGE_CLASSES = [
  "chatops",
  "http",
  "mcp",
  "model",
  "peer",
  "session",
  "sync",
  "task",
] as const;
```

Add to `THIS_BINARY_COVERAGE`:

```ts
  chatops: "per-call",
```

And extend that object's doc comment:

```
 * `chatops` is `per-call` and, unlike `mcp`/`http`, is NOT narrower than its name. Its appender
 * (`egress/chatops-egress.ts`'s `buildLedgeredChatPosts`) decorates the single `post` closure
 * that every chat consumer shares, so one row is appended per outbound post regardless of which
 * consumer sent it. Before it landed the class did not exist at all — chat posts were neither
 * covered nor disclosed, which is why `nimbus prove` could report a zero over a window in which a
 * brief synthesized from the private index was posted to Slack.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gateway/src/egress/`
Expected: PASS. Existing coverage tests that assert class counts may also need updating — if one fails on a hardcoded length, update the number **and** re-derive its enumeration (a total that is still right can hide an enumeration that is wrong).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/egress/egress-source-type.ts packages/gateway/src/egress/egress-coverage.ts packages/gateway/src/egress/egress-coverage.test.ts
git commit -m "feat(egress): add the chatops source type and coverage class"
```

---

## Task 2: Per-install channel-id salt

**Files:**
- Create: `packages/gateway/src/chatops/channel-salt.ts`
- Create: `packages/gateway/src/chatops/channel-salt.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts:31` (`PLATFORM_VAULT_KEYS`)

**Interfaces:**
- Consumes: `NimbusVault` (`get(key): Promise<string|null>`, `set(key, value): Promise<void>`).
- Produces: `ensureChannelSalt(vault: NimbusVault): Promise<string>` (base64, 32 bytes) and `hashChannelId(salt: string, channelId: string): string` (hex). Task 3 consumes both.

**Why:** A bare hash is reversible here by **dictionary**, not brute force — anyone with workspace access can enumerate every channel id, hash each, and match against the ledger. The id's own entropy is irrelevant when the candidate set is small and known.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/chatops/channel-salt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { CHATOPS_CHANNEL_SALT, ensureChannelSalt, hashChannelId } from "./channel-salt.ts";

function fakeVault(): NimbusVault {
  const store = new Map<string, string>();
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
    },
    delete: async (k) => {
      store.delete(k);
    },
  } as NimbusVault;
}

describe("channel salt", () => {
  test("generates a 32-byte salt on first use and persists it", async () => {
    const vault = fakeVault();
    const first = await ensureChannelSalt(vault);
    expect(Buffer.from(first, "base64").length).toBe(32);
    expect(await vault.get(CHATOPS_CHANNEL_SALT)).toBe(first);
  });

  test("reuses the persisted salt on later calls", async () => {
    const vault = fakeVault();
    expect(await ensureChannelSalt(vault)).toBe(await ensureChannelSalt(vault));
  });

  test("regenerates when the stored value is not a 32-byte base64 salt", async () => {
    const vault = fakeVault();
    await vault.set(CHATOPS_CHANNEL_SALT, "truncated");
    const salt = await ensureChannelSalt(vault);
    expect(Buffer.from(salt, "base64").length).toBe(32);
  });

  test("the hash is deterministic per salt and never contains the channel id", () => {
    const h = hashChannelId("c2FsdA==", "C01ABC2DEF3");
    expect(h).toBe(hashChannelId("c2FsdA==", "C01ABC2DEF3"));
    expect(h).not.toContain("C01ABC2DEF3");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a DIFFERENT salt yields a different hash for the same channel — the dictionary defence", () => {
    // This is the whole point: without the salt, an attacker who can enumerate channel ids can
    // hash each candidate and match. With a per-install secret salt they cannot.
    expect(hashChannelId("c2FsdEE=", "C01ABC2DEF3")).not.toBe(
      hashChannelId("c2FsdEI=", "C01ABC2DEF3"),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/chatops/channel-salt.test.ts`
Expected: FAIL — `Cannot find module './channel-salt.ts'`.

- [ ] **Step 3: Implement**

Create `packages/gateway/src/chatops/channel-salt.ts`:

```ts
import { blake3 } from "@noble/hashes/blake3.js";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * Vault key for the per-install channel-id hashing salt (base64, 32 bytes). NEVER leaves the Vault
 * and is never written to the ledger, a log, IPC or config.
 */
export const CHATOPS_CHANNEL_SALT = "chatops.channel.salt";

const SALT_BYTES = 32;

function isValidSalt(b64: string): boolean {
  try {
    return Buffer.from(b64, "base64").length === SALT_BYTES;
  } catch {
    return false;
  }
}

/**
 * Resolve the channel-hash salt from the Vault, generating and storing it on first use. Mirrors
 * `share/share-keypair.ts`'s `ensureShareKeypair`.
 *
 * Nothing ever reverses the hash, so losing or rotating this salt costs only the ability to
 * correlate rows across the rotation — a fail-safe direction, which is why a corrupt stored value
 * is regenerated here rather than raising.
 */
export async function ensureChannelSalt(vault: NimbusVault): Promise<string> {
  const existing = await vault.get(CHATOPS_CHANNEL_SALT);
  if (existing !== null && isValidSalt(existing)) return existing;
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(SALT_BYTES))).toString("base64");
  try {
    await vault.set(CHATOPS_CHANNEL_SALT, salt);
  } catch (err) {
    // This is called on the chatops boot path, so a Vault write failure BLOCKS THE BOT FROM
    // STARTING. That is the correct fail-closed posture -- without a salt the alternative is an
    // unsalted hash, which is reversible by dictionary -- but a bare DPAPI/libsecret error at boot
    // reads as "chatops is broken" with no indication of why. Name the key and the consequence.
    throw new Error(
      `chatops: cannot persist the channel-hash salt ("${CHATOPS_CHANNEL_SALT}") to the Vault, ` +
        `so ChatOps will not start. Every outbound post must be ledgered with a salted channel ` +
        `hash (I29), and an unsalted fallback is not offered because channel ids are enumerable. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return salt;
}

/**
 * `BLAKE3(salt ‖ channelId)` as lowercase hex.
 *
 * The salt is REQUIRED, not defence in depth. Slack and Teams channel ids come from a small,
 * enumerable set: anyone with workspace access can list every channel, hash each one and match
 * against the ledger, recovering exactly which rooms the gateway posted into. That is a dictionary
 * attack, and the id's own entropy does not defend against it.
 */
export function hashChannelId(saltB64: string, channelId: string): string {
  const salt = Buffer.from(saltB64, "base64");
  const id = Buffer.from(channelId, "utf8");
  return Buffer.from(blake3(Buffer.concat([salt, id]))).toString("hex");
}
```

- [ ] **Step 4: Register the vault key**

In `scripts/structure-audit/check-nimbus-invariants.ts`, add to `PLATFORM_VAULT_KEYS`:

```ts
  "chatops.channel.salt",
```

- [ ] **Step 5: Run tests and the static audit**

Run: `bun test packages/gateway/src/chatops/channel-salt.test.ts && bun run audit:invariants`
Expected: both PASS. If the audit flags an unregistered vault key, Step 4 was missed.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/chatops/channel-salt.ts packages/gateway/src/chatops/channel-salt.test.ts scripts/structure-audit/check-nimbus-invariants.ts
git commit -m "feat(chatops): per-install salt for channel-id hashing"
```

---

## Task 3: The appender — `buildLedgeredChatPosts`

**Files:**
- Create: `packages/gateway/src/egress/chatops-egress.ts`
- Create: `packages/gateway/src/egress/chatops-egress.test.ts`

**Interfaces:**
- Consumes: `appendEgressEntry(db, entry)` and `redactEgressSummary(payload)` from `./egress-ledger.ts` / `./egress-record.ts`; `EgressAppendFailedError` from `./model-egress.ts`; `hashChannelId` from Task 2; `ChatPlatform` from `../chatops/types.ts`.
- Produces: `ChatPostKind = "reply" | "approvalCard" | "agentBrief"`, `ChatPost = (platform, channelId, text) => Promise<void>`, and `buildLedgeredChatPosts(db, raw, saltB64, now?) => Readonly<Record<ChatPostKind, ChatPost>>`. Task 4 wires it; PR 2 consumes `posts.agentBrief`.

**Why a factory:** the wrapped signature carries no call-site information, so a single wrapper cannot derive `method`. An optional `kind?` argument would make it caller-supplied *and* omittable. Binding at construction keeps it server-derived.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/egress/chatops-egress.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatPlatform } from "../chatops/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { buildLedgeredChatPosts } from "./chatops-egress.ts";
import { listEgress } from "./egress-verify.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

const SALT = Buffer.alloc(32, 7).toString("base64");

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => {
  db.close();
});

function spy(): { calls: Array<[ChatPlatform, string, string]>; fn: typeof post } {
  const calls: Array<[ChatPlatform, string, string]> = [];
  const post = async (p: ChatPlatform, c: string, t: string): Promise<void> => {
    calls.push([p, c, t]);
  };
  return { calls, fn: post };
}

describe("chatops egress appender", () => {
  test("appends one row per post, with the kind's own method", async () => {
    const s = spy();
    const posts = buildLedgeredChatPosts(db, s.fn, SALT);
    await posts.reply("slack", "C123", "hello");
    await posts.approvalCard("slack", "C123", "approve?");
    await posts.agentBrief("teams", "19:abc", "## Gaps");

    const rows = listEgress(db, { limit: 10 });
    expect(rows.map((r) => r.method)).toEqual([
      "chatops.reply",
      "chatops.approvalCard",
      "chatops.agentBrief",
    ]);
    expect(rows.every((r) => r.source_type === "chatops")).toBe(true);
    expect(rows.map((r) => r.destination)).toEqual(["slack", "slack", "teams"]);
  });

  test("the channel id is never stored in cleartext", async () => {
    const s = spy();
    await buildLedgeredChatPosts(db, s.fn, SALT).reply("slack", "C01ABC2DEF3", "hi");
    const raw = JSON.stringify(listEgress(db, { limit: 10 }));
    expect(raw).not.toContain("C01ABC2DEF3");
    expect(listEgress(db, { limit: 1 })[0]?.source_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the message text is never stored", async () => {
    const s = spy();
    await buildLedgeredChatPosts(db, s.fn, SALT).reply("slack", "C1", "SECRET-BODY-TEXT");
    expect(JSON.stringify(listEgress(db, { limit: 10 }))).not.toContain("SECRET-BODY-TEXT");
  });

  test("a failed append POSTS NOTHING — assert the call count, not just the throw", async () => {
    const s = spy();
    const posts = buildLedgeredChatPosts(db, s.fn, SALT);
    db.close(); // make the append fail
    await expect(posts.reply("slack", "C1", "hi")).rejects.toBeInstanceOf(EgressAppendFailedError);
    // The whole point of fail-closed: proving it threw is not proving nothing left.
    expect(s.calls.length).toBe(0);
    db = new Database(":memory:"); // so afterEach's close() is valid
  });

  test("the row is appended BEFORE the post, not after", async () => {
    const seen: string[] = [];
    const raw = async (): Promise<void> => {
      seen.push(`rows-at-post-time:${listEgress(db, { limit: 10 }).length}`);
    };
    await buildLedgeredChatPosts(db, raw, SALT).reply("slack", "C1", "hi");
    expect(seen).toEqual(["rows-at-post-time:1"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/egress/chatops-egress.test.ts`
Expected: FAIL — `Cannot find module './chatops-egress.ts'`.

- [ ] **Step 3: Implement**

Create `packages/gateway/src/egress/chatops-egress.ts`:

```ts
import type { Database } from "bun:sqlite";

import { hashChannelId } from "../chatops/channel-salt.ts";
import type { ChatPlatform } from "../chatops/types.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

/** Which consumer is posting. Bound at CONSTRUCTION, never passed per call. */
export type ChatPostKind = "reply" | "approvalCard" | "agentBrief";

export type ChatPost = (
  platform: ChatPlatform,
  channelId: string,
  text: string,
) => Promise<void>;

const METHOD_FOR: Readonly<Record<ChatPostKind, string>> = Object.freeze({
  reply: "chatops.reply",
  approvalCard: "chatops.approvalCard",
  agentBrief: "chatops.agentBrief",
});

/**
 * The I29 `chatops`-class appender, and the only one.
 *
 * Before this, NO chat post was ledgered: the reply path is
 * `ReplyDispatcher` -> `buildConnectorPost` -> an ephemeral bot-credentialed connector spawn,
 * which never reaches the executor's `connectors.dispatch` chokepoint. The gap was also
 * UNDISCLOSED — I29 named no chatops class — so `nimbus prove` reported zero over windows in which
 * an answer synthesized from the private index was posted to Slack's servers.
 *
 * A DECORATOR at construction, like `wrapLedgeredProvider` / `wrapLedgeredEmbedder`, so it covers
 * every consumer including ones written later without any of them cooperating.
 *
 * ONE FACTORY, N FUNCTIONS, rather than one wrapper. The wrapped signature carries no indication
 * of WHICH consumer is calling, so a single wrapper could not derive `method` without sniffing the
 * text — fragile and wrong. An optional `kind?` argument would fix that by conceding the property:
 * the value would become caller-supplied AND omittable, so a consumer that forgot it would be
 * silently mis-attributed. Binding the kind at the one wiring site that already knows which
 * consumer it is building keeps `method` server-derived. `Record<ChatPostKind, ChatPost>` is total,
 * so a new kind does not compile until it is wired.
 *
 * The caller must pass `buildConnectorPost(...)` DIRECTLY as `raw` and never bind it to a name —
 * an unwrapped `post` in scope is a bypass waiting for the next consumer. D17 enforces this.
 */
export function buildLedgeredChatPosts(
  db: Database,
  raw: ChatPost,
  saltB64: string,
  now: () => number = Date.now,
): Readonly<Record<ChatPostKind, ChatPost>> {
  const wrap = (kind: ChatPostKind): ChatPost => {
    return async (platform, channelId, text): Promise<void> => {
      try {
        appendEgressEntry(db, {
          timestamp: now(),
          sourceType: "chatops",
          // Salted hash, never the id: a channel id names a group of PEOPLE, and this table is
          // append-only with a HITL-gated prune as its only mutation path.
          sourceId: hashChannelId(saltB64, channelId),
          destination: platform,
          method: METHOD_FOR[kind],
          // Byte length only. Never the text — the ledger proves what left, it does not keep a
          // second copy of it.
          payloadSummary: redactEgressSummary({ bytes: Buffer.byteLength(text, "utf8") }),
          hitlStatus: "not_required",
          resultStatus: "authorized",
        });
      } catch (err) {
        throw new EgressAppendFailedError(err);
      }
      await raw(platform, channelId, text);
    };
  };

  return Object.freeze({
    reply: wrap("reply"),
    approvalCard: wrap("approvalCard"),
    agentBrief: wrap("agentBrief"),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/egress/chatops-egress.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Red-prove the fail-closed test**

Temporarily move `await raw(...)` **above** the `try` block, re-run, and confirm the
"POSTS NOTHING" test FAILS. Then restore. A fail-closed test that passes against a
fail-open implementation is worthless, and a green run alone does not distinguish them.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/egress/chatops-egress.ts packages/gateway/src/egress/chatops-egress.test.ts
git commit -m "feat(egress): ledger every outbound chatops post, fail-closed"
```

---

## Task 4: Wire it into `chatops-boot.ts`

**Files:**
- Modify: `packages/gateway/src/chatops/chatops-boot.ts:164-192`
- Modify: `packages/gateway/src/chatops/chatops-boot.ts` — `ChatopsBootDeps` gains `db` and `vault`
- Modify: `packages/gateway/src/platform/assemble.ts` — `bootChatopsIntoAssembly` passes them
- Test: `packages/gateway/src/chatops/chatops-boot.test.ts`

**Interfaces:**
- Consumes: `buildLedgeredChatPosts` (Task 3), `ensureChannelSalt` (Task 2).
- Produces: `ChatopsBoot` unchanged externally. PR 2 adds `bindAgentInvoker` and reuses `posts.agentBrief`.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/chatops/chatops-boot.test.ts` (reuse the file's existing harness and its `slack_chat_post` fake `runTool`):

```ts
test("a reply through the booted chatops posts AND ledgers exactly one row", async () => {
  // Uses the file's existing boot harness; `db` is the in-memory index the harness builds.
  const boot = await bootForTest({ db });
  await boot.replyTo({ kind: "originating", platform: "slack", channelId: "C1" }, "hi");

  const rows = listEgress(db, { limit: 10 });
  expect(rows.length).toBe(1);
  expect(rows[0]?.source_type).toBe("chatops");
  expect(rows[0]?.method).toBe("chatops.reply");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/chatops/chatops-boot.test.ts -t "ledgers exactly one row"`
Expected: FAIL — zero rows.

- [ ] **Step 3: Add the deps**

In `ChatopsBootDeps`:

```ts
  /** I29 `chatops` class: the ledger every outbound post is appended to. REQUIRED — a chatops
   *  boot that cannot ledger must not be constructible. */
  readonly db: Database;
  /** Holds the per-install channel-hash salt (`chatops.channel.salt`). */
  readonly vault: NimbusVault;
```

- [ ] **Step 4: Replace the raw `post` with the ledgered set**

Replace `chatops-boot.ts:164-166` — note `buildConnectorPost(...)` is passed **inline** and never bound to a name:

```ts
  const channelSalt = await ensureChannelSalt(deps.vault);
  const posts = buildLedgeredChatPosts(
    deps.db,
    buildConnectorPost(runTool, (conversationId) =>
      teamsServiceUrlByConversation.get(conversationId),
    ),
    channelSalt,
  );
```

Then `ReplyDispatcher` takes `post: posts.reply` and `ApprovalPresenter`'s inner call becomes
`await posts.approvalCard(lastPlatformByChannel.get(channelId) ?? "slack", channelId, text);`.

Leave `posts.agentBrief` unused for now — PR 2 consumes it. (Biome will not flag an unused object
property.)

- [ ] **Step 5: Pass the deps from assembly**

In `platform/assemble.ts`'s `bootChatopsIntoAssembly`, add `db` and `vault` to the
`buildChatopsBoot({...})` call from the values already in scope there.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/gateway/src/chatops/ && bun run typecheck`
Expected: PASS. Existing boot tests will need `db` + `vault` added to their fixtures — that is the
type system doing its job, not breakage.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/chatops/chatops-boot.ts packages/gateway/src/chatops/chatops-boot.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(chatops): route every post through the ledgered post set"
```

---

## Task 5: Extend D17 so no unwrapped post can be reached

**Files:**
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts:434-468`
- Test: `scripts/structure-audit/check-nimbus-invariants.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: rule id `D17-chatops-unwrapped-post`.

**Why:** without this, "covers any caller written later" is true of the two consumers that exist and false of the third someone adds by calling `buildConnectorPost` again.

- [ ] **Step 1: Write the failing test**

```ts
test("D17 rejects a buildConnectorPost call that is not an argument to buildLedgeredChatPosts", () => {
  const v = checkChatopsUnwrappedPost([
    {
      relPath: "packages/gateway/src/chatops/chatops-boot.ts",
      contents: "const post = buildConnectorPost(runTool, fn);\n",
    },
  ]);
  expect(v.map((x) => x.rule)).toEqual(["D17-chatops-unwrapped-post"]);
});

test("D17 accepts the inline form", () => {
  const v = checkChatopsUnwrappedPost([
    {
      relPath: "packages/gateway/src/chatops/chatops-boot.ts",
      contents: "const posts = buildLedgeredChatPosts(db, buildConnectorPost(runTool, fn), salt);\n",
    },
  ]);
  expect(v).toEqual([]);
});

// THE TEST THAT MATTERS. A file-level "does this file contain a wrapped call?" early-return
// skips the whole file when BOTH forms are present -- and the one file that legitimately
// contains a wrapped call is `chatops-boot.ts`, i.e. exactly the file where an added unwrapped
// call would be invisible. Counting the two tokens does not fix it either: a wrapped call whose
// argument is something else keeps the counts equal while the bypass survives.
test("D17 catches an unwrapped call in a file that ALSO has a wrapped one", () => {
  const v = checkChatopsUnwrappedPost([
    {
      relPath: "packages/gateway/src/chatops/chatops-boot.ts",
      contents:
        "const posts = buildLedgeredChatPosts(db, buildConnectorPost(runTool, fn), salt);\n" +
        "const sneaky = buildConnectorPost(runTool, fn);\n",
    },
  ]);
  expect(v.length).toBe(1);
  expect(v[0]?.line).toBe(2);
});

test("D17 catches a wrapper call whose argument is NOT buildConnectorPost", () => {
  // Counts are equal (1 and 1); adjacency is what distinguishes them.
  const v = checkChatopsUnwrappedPost([
    {
      relPath: "packages/gateway/src/chatops/chatops-boot.ts",
      contents:
        "const posts = buildLedgeredChatPosts(db, somethingElse, salt);\n" +
        "const post = buildConnectorPost(runTool, fn);\n",
    },
  ]);
  expect(v.length).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts -t "D17 rejects"`
Expected: FAIL — `checkChatopsUnwrappedPost` is not defined.

- [ ] **Step 3: Implement the rule**

```ts
// D17 (I23/I29) — `buildConnectorPost(...)` produces an UNLEDGERED post function. It may be
// CALLED only as an argument to `buildLedgeredChatPosts(...)`, never bound to a name, so no
// consumer can reach an unwrapped post. Without this the ledger covers the consumers that exist
// and silently misses the next one added.
//
// PER OCCURRENCE, never per file. A file-level "does this file contain a wrapped call?"
// early-return skips the whole file once BOTH forms are present — and `chatops-boot.ts` is the one
// file that legitimately contains a wrapped call, so it is exactly the file where an added
// unwrapped call would go unseen. Token COUNTING has the same weakness from the other direction:
// `buildLedgeredChatPosts(db, somethingElse, salt)` keeps the counts equal while wrapping nothing.
// Adjacency is the property, so adjacency is what gets checked.
const UNWRAPPED_POST_RE = /\bbuildConnectorPost\s*\(/g;
const WRAPPER_RE = /\bbuildLedgeredChatPosts\s*\(/g;

/** Byte offset -> 1-based line, so a per-offset finding can name a line. */
function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

export function checkChatopsUnwrappedPost(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (f.relPath.endsWith("chatops/transport/connector-post.ts")) continue; // definition site
    const stripped = stripComments(f.contents);
    const original = f.contents.split("\n");

    // Statement-scoped: a `;` ends the construct we care about, and the legal form is a single
    // statement. Splitting keeps offsets recoverable by accumulating the consumed length.
    let base = 0;
    for (const stmt of stripped.split(";")) {
      const posts = [...stmt.matchAll(UNWRAPPED_POST_RE)].map((m) => m.index ?? 0);
      if (posts.length > 0) {
        const wrappers = [...stmt.matchAll(WRAPPER_RE)].map((m) => m.index ?? 0);
        // Each `buildConnectorPost(` must be preceded, in this same statement, by its own
        // `buildLedgeredChatPosts(`. Pair them off in order: the Nth post call needs an Nth
        // wrapper opening before it.
        for (let n = 0; n < posts.length; n++) {
          const wrapper = wrappers[n];
          const post = posts[n] ?? 0;
          if (wrapper === undefined || wrapper > post) {
            const off = base + post;
            const line = lineOfOffset(stripped, off);
            out.push({
              rule: "D17-chatops-unwrapped-post",
              file: f.relPath,
              line,
              snippet: (original[line - 1] ?? "").trim(),
            });
          }
        }
      }
      base += stmt.length + 1; // + the `;` that split consumed
    }
  }
  return out;
}
```

**Residual bound, stated rather than implied:** this is a lexical guard, not a parser. A single
statement deliberately crafted to interleave a wrapper and an unwrapped call in a passing order
could still slip through. That is acceptable — the guard's job is to catch the realistic accident
(`const post = buildConnectorPost(...)` added as its own statement), not to defeat an author who is
trying to evade it. What it must never do again is miss that accident because a *different* line in
the same file looked correct.

Register it in the runner alongside `checkChatopsReplySurfaceInvariant`.

- [ ] **Step 4: Delete the two dead allowlist paths**

Remove from `CHATOPS_POST_ALLOWED_PREFIXES`:

```ts
  "packages/mcp-connectors/slack/src/server.ts",
  "packages/mcp-connectors/teams/src/server.ts",
```

Verify they are dead with **`git ls-files packages/mcp-connectors`** (expect zero output), not with
`ls` — a stale *untracked* `packages/mcp-connectors/` directory survives on machines that predate the
`v3.0.0` extraction and will make `ls` answer the wrong question.

- [ ] **Step 5: Run the audit and red-prove it**

Run: `bun test scripts/structure-audit/ && bun run audit:invariants`
Expected: PASS.

Then red-prove **twice**, because the two runs prove different things:

1. Replace the wiring in `chatops-boot.ts` with `const post = buildConnectorPost(...)` (no wrapper
   anywhere in the file). `audit:invariants` must FAIL naming `D17-chatops-unwrapped-post`.
2. **Restore the wrapper and ADD `const sneaky = buildConnectorPost(runTool, fn);` beside it**, so
   the file contains both forms. `audit:invariants` must FAIL again, naming line of `sneaky`.

Run 1 proves the guard fires at all. **Only run 2 proves it fires in the file it actually has to
watch** — `chatops-boot.ts` is the one file that legitimately contains a wrapped call, so a
file-level check would pass run 1 and silently fail run 2. Restore after both.

- [ ] **Step 6: Commit**

```bash
git add scripts/structure-audit/
git commit -m "feat(audit): D17 forbids an unwrapped chatops post, and drop two dead paths"
```

---

## Task 6: The CLI coverage-label mirror

**Files:**
- Modify: `packages/cli/src/commands/prove.ts:39-59`
- Test: `packages/cli/src/commands/prove.test.ts`

**Interfaces:**
- Consumes: nothing (the CLI **cannot** import the gateway; this is a hand-maintained mirror).
- Produces: a label for `chatops` in `nimbus prove` output.

- [ ] **Step 1: Write the failing drift test**

```ts
test("every coverage class has a hand-written label", () => {
  // The CLI cannot import the gateway, so this list is mirrored by hand. The drift test is the
  // only thing standing between a new class and `nimbus prove` printing a bare identifier.
  const CLASSES = ["chatops", "http", "mcp", "model", "peer", "session", "sync", "task"];
  for (const c of CLASSES) {
    expect(COVERAGE_CLASS_LABELS[c]).toBeDefined();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/cli/src/commands/prove.test.ts -t "hand-written label"`
Expected: FAIL — `chatops` is undefined.

- [ ] **Step 3: Add the label**

```ts
  // Unlike `mcp` and `http`, this class is NOT narrower than its name: it covers EVERY outbound
  // post the gateway makes to Slack/Teams — operational replies, HITL approval cards, tribal
  // suggestions and agent briefs — because the appender decorates the single post closure they all
  // share. A zero here means the bot said nothing.
  chatops: "Slack/Teams posts",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/commands/prove.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/prove.ts packages/cli/src/commands/prove.test.ts
git commit -m "feat(cli): label the chatops coverage class in nimbus prove"
```

---

## Task 7: Docs — the triple rule's third leg

**Files:**
- Modify: `docs/SECURITY-INVARIANTS.md` (I29 section)
- Modify: `docs/CHANGELOG.md`
- Modify: `CLAUDE.md` and `GEMINI.md` (I29 summary line — both, per the mirror rule)

- [ ] **Step 1: Add the `chatops` paragraph to I29**

State three things explicitly: what the class covers (every outbound post on the `chatops-boot.ts`
post closure); that the appender is a construction-bound factory rather than one wrapper, and why;
and — the part that must not be softened — that before this change chat egress was **absent from
the record rather than narrowed**, unlike `mcp`/`http` whose exclusions were always stated.

- [ ] **Step 2: Add the CHANGELOG entry**

Dated `2026-08-29`. Lead with what a `nimbus prove` zero now means that it did not mean before.

- [ ] **Step 3: Update the I29 summary in `CLAUDE.md` and `GEMINI.md`**

Both files, same edit — `GEMINI.md` mirrors `CLAUDE.md` and drifting them is its own defect.

- [ ] **Step 4: Run the full gate set**

Run: `bun run preflight`
Expected: PASS. Note `audit:doc-refs` does **not** scan `docs/superpowers/`, so it will not validate
the spec/plan cross-links — check those by hand if you touched them.

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md GEMINI.md
git commit -m "docs: record the chatops egress class under I29"
```

---

## Review Responses (Antigravity, 2026-08-29)

Reviewed in [`2026-08-29-chatops-egress-ledger-review.md`](./2026-08-29-chatops-egress-ledger-review.md).

| # | Point | Disposition |
| --- | --- | --- |
| 2.1 | D17's file-level skip is a bypass | **Fixed** — Task 5, per-occurrence; their *counting* remedy declined |
| 2.2 | Vault write failure at boot needs a distinguishable log | **Fixed** — Task 2 |
| 3.1 | Salt differs across gateway instances | **No change**, and the constraint is older than the salt |

**2.1 was the real find, and the diagnosis was exactly right.** `WRAPPED_POST_RE.test(stripped) →
continue` skips the entire file once any wrapped call is present, and `chatops-boot.ts` is the only
file that legitimately contains one — so the guard would have been blind in precisely the file it
exists to watch. Two new tests pin it, and the red-prove step now has a second run that adds an
unwrapped call *beside* the wrapper, because the first run passes even against the broken version.

The suggested remedy — comparing token counts — was **not** taken, because it decouples the two
tokens and leaves the bypass open from the other side:

```ts
const posts = buildLedgeredChatPosts(db, somethingElse, salt);  // wrapped count 1
const post  = buildConnectorPost(runTool, fn);                  // unwrapped count 1  -> passes
```

Counting answers "are there enough wrapper calls?" when the question is "is *this* call wrapped?".
The review's own first suggestion — check each occurrence individually — is what the rule now does,
statement-scoped, pairing each `buildConnectorPost(` with a `buildLedgeredChatPosts(` that opens
before it. A fourth test covers the equal-counts case above.

**2.2 accepted as stated.** The failure posture was already right; what was missing was that the
error said nothing useful. The message now names the vault key, says ChatOps will not start, and
says why no unsalted fallback is offered. Worth noting this only became useful three days ago —
until #1393 (`fix(logging): stop logging every Error as {}`) a logged `Error` serialised to `{}`,
so a carefully written message would have reached the log as an empty object.

**3.1 needs no change, and the reason is stronger than the review's.** The scenario is two gateways
sharing one database with separate Vaults. That is already unsupported, and not because of the
salt: `egress_ledger` is a BLAKE3 **hash chain**, and `appendEgressEntry` reads the head hash and
then inserts. Two concurrent writers race on that read and produce a broken chain, which
`verifyEgressChain` rejects. Single-writer is a pre-existing property of the ledger, so the salt
introduces no constraint that was not already there.

The reviewer's conclusion — hashes do not correlate across machines, and that is fine for a
local-first model — is correct, and the local-first framing is the right one: a hash that *did*
correlate across installs would mean a shared secret, which is a worse property than the lost
correlation. Recorded here so it is not re-raised.

---

## Self-Review Notes

- **Spec coverage:** §5.1 → Tasks 3–4; §5.2 → Task 1; §5.3 → Tasks 2–3; §5.4 → Tasks 1 + 6; §5.5 → Task 7; §2.5's dead-path cleanup → Task 5.
- **Not in this plan, by design:** everything under §6 (the agent intent) is PR 2 and has its own plan. `posts.agentBrief` is built here and consumed there.
- **The two red-prove steps (3.5 and 5.5) are not optional.** A fail-closed test that has never been run against a fail-open implementation, and an allow-list guard that has never been shown to reject anything, are the two failure shapes this codebase has been bitten by most.
