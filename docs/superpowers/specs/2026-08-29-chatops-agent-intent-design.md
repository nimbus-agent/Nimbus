# ChatOps Agent Intent — Agents on the Channel

**Date:** 2026-08-29
**Status:** design — not started
**Slot:** Spine S2 sidecar / Track 2 → Client surfaces, row *"Messaging (ChatOps) — agents on the channel"*
**Roadmap:** [`docs/roadmap.md` § Track 2 → Client surfaces](../../roadmap.md#client-surfaces), the
"Messaging surface — agents on the channel (direction, not yet built)" block
**Delivers as:** two PRs, in order — see §4
**Reviewed:** [design review](./2026-08-29-chatops-agent-intent-design-review.md) (Antigravity, 2026-08-29) — responses in §13

The roadmap block is the origin of this work but is **not** the binding authority for it: §2.1 and
§2.3 record two claims in it that reading the code contradicted. Where this document and the roadmap
disagree, this document is correct and the roadmap row is updated in PR 2.

---

## 1. Problem

The `@nimbus` bot shipped in Phase 6 Slice 5 and answers questions. It cannot run an agent.

`IntentRouter.handle` (`packages/gateway/src/chatops/intent-router.ts:34`) classifies every inbound
message into exactly two intents. `parseCommand` (`chatops/command-parser.ts:27`) returns
`{ kind: "read", query }` for anything that does not begin with `run`, so a read is the fallthrough
and the fallthrough is `askEngine`. There is no `agents.*` call anywhere under `chatops/` —
`grep -rn "agents\." packages/gateway/src/chatops/` returns nothing.

The consequence is a dependency profile that is upside down:

- A channel read calls `askEngine`, which **requires a configured LLM**. On a gateway with no model
  configured, `@nimbus <question>` cannot answer.
- The fourteen built-in agents render **deterministically with no LLM at all** — the property that
  made zero-config onboarding possible — and they are precisely the ones a channel cannot reach.

So the cheapest and most reliable output the product has is unavailable on its most reachable
surface: the only surface that reaches a person who has installed nothing.

Investigating this uncovered a second, unrelated problem that must be fixed first. It is described
in §2.3 and is the whole of PR 1.

---

## 2. What investigation changed

### 2.1 I17 is not on this path — CORRECTION to the roadmap block

The roadmap says:

> A channel is a multi-user space and the index is one person's. The channel↔namespace binding and
> the `I17` grant/role/consent filter are load-bearing here, not incidental.

The first sentence is true and the second is not. **I17 governs federated answering only** — it
lives in `federation/query-gate.ts` and gates queries arriving from paired peers. A brief
synthesized from the *local* index and posted to a channel never passes through it. I17 is not a
control on this path and cannot be made one without moving it.

The namespace half is wrong in a more specific way. `namespaces` in the agents API is **not a
content filter**. Only three of the eleven agents accept it — `ghost` and `conflicts` via
`requireFileParam` (`ipc/agents-rpc.ts:248`), `huddle` via `requireHuddleParams` (`:263`) — and all
three are the `federatedAgentBase` agents. `agents/ghost.ts:60` shows what it does:
`input.namespaces.map((ns) => …)` fans out **to peers**. It selects which peers to ask, not which
local rows are visible.

There is therefore no local namespace filter to inherit, apply, or plumb through. The consequence
is stated as a non-goal in §3 and disclosed in §9.

### 2.2 `binding.namespace` is already discarded on the read path

`createChatOpsAskEngine` (`packages/gateway/src/gateway-main.ts:54`) has the signature
`(query: string, namespace: string) => Promise<string>` and its implementation is
`async (query, _namespace) => …`. The namespace is named with a leading underscore and never read.

This is a **documented** Slice 5 deferral — `gateway-main.ts:164` says "Per-namespace content
filtering of local reads remains the slice's documented deferral" — so it is not a defect. It is
recorded here because it establishes the precedent the agent intent follows: a channel read today
already answers from the whole local index, and the agent intent will not be more permissive than
the surface it joins, only equally so.

### 2.3 ChatOps egress is unledgered AND undisclosed — the reason for PR 1

This is the finding that changed the shape of the work.

**No ChatOps post is ledgered.** The reply path is
`ReplyDispatcher.send` → `post` → `buildConnectorPost` (`chatops/transport/connector-post.ts:13`)
→ `runChatopsTool` → `spawnChatopsBotToolAndCall` — an ephemeral bot-credentialed connector spawn.
It does not go through the executor: `connectors.dispatch` has exactly one caller in the tree
(`engine/executor.ts:401`) and this is not it. So I29's primary chokepoint never sees a chat post,
and no other appender covers one.

**Nor is the gap disclosed.** Grepping I29's section of `docs/SECURITY-INVARIANTS.md` for
`chatops`, `slack` or `reply` returns nothing, and `COVERAGE_CLASSES`
(`egress/egress-coverage.ts:19`) has no member for it.

That distinction is the point. The `mcp` and `http` classes cover less than their names suggest and
`egress-coverage.ts` spends three paragraphs saying exactly which parts they exclude — that is a
*stated* narrowing. ChatOps is not narrowed; it is **absent**. `nimbus prove` therefore reports zero
for a window in which an answer synthesized from the private index was posted to Slack's servers.

This is the same defect shape as the `ask` intent classifier closed on 2026-08-28, which
`CLAUDE.md` records as "an UNDISCLOSED exclusion rather than a stated one, so `nimbus prove`
reported `0` for a query that had made a real outbound request carrying user text".

It is pre-existing, it is not caused by this feature, and building an agent surface on top of it
would deepen it. It is PR 1.

### 2.4 There is exactly one post chokepoint, and it already exists

`chatops-boot.ts:164` builds `post` **once**:

```ts
const post = buildConnectorPost(runTool, (conversationId) =>
  teamsServiceUrlByConversation.get(conversationId),
);
```

`ReplyDispatcher` (`:168`) and `ApprovalPresenter` (`:182`) both close over that same value.
Static rule **D17** already confines the `slack_chat_post` / `teams_chat_post` tool ids to
`chatops/reply-dispatcher.ts` and `chatops/transport/`.

So decorating that one closure covers every outbound chat post — operational replies,
HITL approval cards, tribal-watcher suggestions, and any caller written later — without any of them
cooperating. This is the same shape as `wrapLedgeredProvider` (I29/D22(e)) and
`wrapLedgeredEmbedder` (D22(f)), chosen for the same reason.

### 2.5 Smaller findings, folded in

- **`chatops/` has no truncation of any kind.** `grep` for `truncat|slice(0,|MAX_.*LEN` across
  `chatops/*.ts` returns nothing; replies post raw. An agent brief is markdown of unbounded length,
  so §6.6 must decide a policy rather than inherit one.
- **D17's allowlist names two deleted paths.** `CHATOPS_POST_ALLOWED_PREFIXES`
  (`scripts/structure-audit/check-nimbus-invariants.ts:440`) still lists
  `packages/mcp-connectors/slack/src/server.ts` and `.../teams/src/server.ts`. That workspace was
  removed in `v3.0.0` when the connectors moved to `nimbus-mcp-servers`; `git ls-files
  packages/mcp-connectors` returns **zero** tracked files and neither `server.ts` exists. The
  entries are dead — they match nothing — so this is untidiness, not a hole. Cleaned up in PR 1
  since PR 1 edits this rule anyway; called out so the deletion is not mistaken for a scope change.

  **Trap for whoever implements this:** a stale *untracked* `packages/mcp-connectors/` directory
  survives on machines that predate the extraction (it is untracked, not gitignored, so it is
  invisible to `git status --short` filters that skip untracked paths and it is never cleaned by a
  branch switch). Verify the entries are dead with `git ls-files`, not with `ls` — `ls` answers a
  different question and answers it wrongly here. `audit:doc-refs` gives no signal either way: it
  passed with those paths cited in this document.
- **The permitted-agent exclusions are already computed once.** `AGENTS_RPC_HANDLERS`
  (`ipc/agents-rpc.ts:913`) has FIFTEEN entries, not fourteen — the fourteen agents plus `whyPeek`,
  which shares the map because it is ledgered and dispatched the same way but is a companion to
  `why`, not a fifteenth agent (§3 non-goals). `HTTP_EXCLUDED_AGENT_METHODS` (`:969`) excludes four
  of those fifteen — `preflight`, `premortem`, `negotiate` (three real agents) and `whyPeek` (the
  companion) — leaving eleven, and `HTTP_AGENT_NAMES` (`:983`) is **derived** from
  `AGENTS_RPC_HANDLERS` rather than hand-maintained. The same arithmetic reads either way: **11
  permitted = 14 agents − 3 excluded agents = 15 handlers − 4 excluded methods.** ChatOps needs the
  same eleven for the same reasons, so §6.4 generalizes the name rather than adding a second list.

---

## 3. Goals / Non-goals

**Goals**

1. Every outbound ChatOps post appends one `egress_ledger` row, fail-closed. (PR 1)
2. `@nimbus agent why ref=src/auth.ts line=42` in a bound channel returns the same brief payload as
   `nimbus why`, from the same `agents.*` dispatch. (PR 2)
3. Full `k=v` parity with all eleven permitted agents, with **no second copy** of
   `agents-rpc.ts`'s validators or bounds constants. (PR 2, §6.2)
4. The intent resolves with **no LLM configured** — a deterministic brief posts to a channel where
   `nimbus ask` would refuse. This is the criterion that proves §1's inversion is actually fixed.
5. Drift between the coercion map and the validators is a **build failure**, not a review catch.
   (§7)

**Non-goals**

- **Per-namespace filtering of local content.** Out of scope for the reasons in §2.1 — it does not
  exist to inherit, and building it is a new capability, not a slice of this one. Disclosed, not
  hidden (§9).
- **Widening `public-read`.** An unmapped user cannot invoke an agent (§6.5).
- **The three excluded agents.** Of the fourteen, `preflight` and `premortem` are excluded for their
  side effects, and `negotiate` because `--person` makes it a dossier-builder. Every one of those
  reasons is *stronger* in a shared channel, so the exclusion is inherited, not re-decided. (A
  fourth name, `whyPeek`, is also absent from the permitted set — but it was never one of the
  fourteen agents to begin with, only a companion RPC method to `why` that happens to share
  `AGENTS_RPC_HANDLERS`; see the permitted-agent-exclusions bullet in §2.)
- **New platforms.** `ChatPlatform` stays `"slack" | "teams"`.
- **Changing the agents.** They stay read-only and HITL-free; `approval-presenter.ts` is not on this
  path.
- **Streaming or progress updates.** One post, when the brief is ready.

---

## 4. Delivery order — two PRs, and the order is load-bearing

**PR 1 — `feat(egress): ledger every outbound ChatOps post`.** Closes §2.3. Provable standalone: a
`@nimbus <question>` on today's build produces a row where it produced none, and `nimbus prove`
gains a class that was previously silent.

**PR 2 — `feat(chatops): run agents from a channel`.** Needs **zero** egress work: the seam is
already covered and the new caller inherits it by construction. That is the entire reason for
choosing a decorator over a call-site append.

Landing PR 1 first also satisfies the roadmap's own acceptance criterion — *"the egress question
above is answered in code before merge"* — before the feature it was written about exists.

Neither PR is breaking. Per `CLAUDE.md`'s rule, the test is "what does an existing user have to
change to keep working?" and the answer for both is nothing: PR 1 adds rows to an append-only
ledger, PR 2 adds a message grammar that did not previously resolve.

---

## 5. PR 1 — ledger every outbound ChatOps post

### 5.1 The appender

New file `egress/chatops-egress.ts`. The post kind is bound **at construction**, not passed per
call, so one factory returns one wrapped function per kind:

```ts
export type ChatPostKind = "reply" | "approvalCard" | "agentBrief";
export type ChatPost = (platform: ChatPlatform, channelId: string, text: string) => Promise<void>;

export function buildLedgeredChatPosts(
  db: Database,
  raw: ChatPost,
): Readonly<Record<ChatPostKind, ChatPost>>
```

Applied once at `chatops-boot.ts:164`. `ReplyDispatcher` receives `posts.reply`,
`ApprovalPresenter` receives `posts.approvalCard`, and the agent invoker (PR 2) receives
`posts.agentBrief`. A **decorator, not a call-site append** — §2.4.

**Why a factory rather than one wrapper, and why not an optional parameter.** The wrapped signature
is `(platform, channelId, text)`, which carries no indication of *which* consumer is calling. A
single wrapper therefore cannot derive the `method` in §5.3 — it would have to sniff the text, which
is fragile and wrong. Adding an optional `kind?` argument fixes that but breaks two properties at
once: the value becomes **caller-supplied** (contradicting §5.3's claim outright) and **omittable**,
so a consumer that forgets it is silently mis-attributed rather than rejected.

Binding the kind at the wiring site keeps both properties. The kind is a construction-time constant
chosen at the one place that already knows which consumer it is building, no caller can influence
it, and `Record<ChatPostKind, ChatPost>` is total — a new kind does not compile until it is wired.

**The raw `post` must not survive the factory call.** `buildConnectorPost(...)` is passed directly
into `buildLedgeredChatPosts(...)` and never bound to a name in `chatops-boot.ts`, so there is no
unwrapped function in scope for a future consumer to reach for. D17 is extended to enforce this:
`buildConnectorPost` may be *called* only as an argument to `buildLedgeredChatPosts`. Without that,
"covers any caller written later" would be true of the two consumers that exist and false of the
third someone adds.

It appends **before** delegating, and an append failure propagates: no row, no post. A zero-row
window means no chat message left the machine, never that one left unrecorded. This mirrors
`wrapLedgeredProvider` exactly.

Consequence to state plainly: if the ledger cannot be written, a HITL approval card is not posted,
the approval times out, and the action is **denied**. That is fail-closed in the correct direction —
an action that could not be recorded does not execute.

### 5.2 The new source type and coverage class

`EGRESS_SOURCE_TYPES` (`egress/egress-source-type.ts`) gains a twelfth member, `chatops`. It is an
**egress class, not a marker** — the content genuinely leaves the machine to a third-party server,
which is a stronger claim than `mcp`/`http`, where a brief is handed to a local process.

`COVERAGE_CLASSES` (`egress/egress-coverage.ts:19`) gains `chatops` **at index 0**. The array is
key-sorted and `serializeCoverage` maps over it to build the string stored in a boot marker's hashed
`source_id`, so the order *is* the wire format; `chatops` sorts before `http`. Appending instead of
inserting would typecheck, round-trip within one binary, and produce a canonical string no other
binary agrees with.

`THIS_BINARY_COVERAGE` sets `chatops: "per-call"` — one row per post, which is literally what the
decorator does.

The reuse-an-existing-member option is rejected for the fourth time, on
`egress-source-type.ts`'s own recorded reasoning: `source_type` strings are permanent in the data,
and one string covering two different attribution strengths is unrecoverable afterwards.

### 5.3 What a row records

| Column | Value |
| --- | --- |
| `source_type` | `chatops` |
| `source_id` | the **salted hash** of the channel id — never the channel id itself (see below) |
| `destination` | the platform, `slack` or `teams` |
| `method` | `chatops.reply`, `chatops.approvalCard`, or `chatops.agentBrief` (PR 2) |
| `payload_summary` | `redactEgressSummary` over `{ bytes }` |
| `hitl_status` | `not_required` |
| `result_status` | `authorized` |

**The channel id is hashed with a per-install salt, not stored.** A channel id identifies a group of
people, the ledger is append-only, and its only mutation path is a HITL-gated prune. `nimbus prove`
needs to answer "how many messages left, to which platform", not "which rooms did the owner talk
in". A salted hash keeps per-channel *counting* possible without the ledger becoming a record of the
owner's social graph.

**The salt is required, not belt-and-braces.** A bare hash is reversible here by dictionary, not by
brute force: Slack channel ids come from a small, enumerable set — anyone with workspace access can
list every channel, hash each one, and match against the ledger, recovering exactly which rooms the
gateway posted into. The id's own entropy is irrelevant when the candidate set is known and small.

`BLAKE3(salt ‖ channelId)` with a 32-byte salt generated once per install and stored in the Vault
under a new key. Implementation notes: the key must be added to the **vault-key allow-list** that
`check-nimbus-invariants.ts` enforces statically, or the build fails. Reversal is never required —
nothing reads the hash back to a channel — so a lost or rotated salt costs only the ability to
correlate rows across the rotation, which is a fail-safe direction.

**Rejected salt sources.** The DPAPI entropy file (`vault/win32.ts`, I12) is Windows-only and
reusing it would make the ledger's shape platform-dependent, against non-negotiable #5. A machine
UUID is stable but not secret, so it is not a salt — an attacker who can enumerate channels can
usually read it too.

`method` distinguishes the three post kinds so the class can be read at finer grain than its
coverage claim. It is derived server-side from the call site, never supplied by a caller.

### 5.4 Cost, stated

`parseCoverage` returns `null` — never a partial vector, never a guess — unless the string carries
**exactly** the known class set. So after this lands, an old binary cannot merge a new binary's boot
marker and a new binary cannot merge an old one's. That is inherent to adding any coverage class and
`mcp`, `http` and `model` each paid it. It is named here so it is a known cost rather than a
surprise.

The CLI's `COVERAGE_CLASS_LABELS` (`packages/cli/src/commands/prove.ts`) is a hand-maintained mirror
— the CLI cannot import the gateway — and needs the same edit in the same PR.

### 5.5 Docs

`docs/SECURITY-INVARIANTS.md`'s I29 section gains a `chatops` paragraph stating what the class
covers (every outbound post on the `chatops-boot.ts` `post` closure) and, explicitly, that it was
**absent rather than narrowed** before this change — matching how the `ask`-classifier gap was
recorded rather than quietly closed.

---

## 6. PR 2 — the agent intent

### 6.1 Grammar

`parseCommand` gains a third arm, ahead of the `read` fallthrough:

```text
@nimbus agent <name> [k=v ...]
```

Chosen to mirror the existing `run <action> k=v` write grammar rather than invent a second shape —
`normalizeChatText` already strips mentions, Slack link markup, smart quotes and backticks, and
`KV_RE` already parses `k=v` with quoted-value stripping. Both are reused unchanged, though
`normalizeChatText` moves to a small neutral module (`chatops/normalize-chat-text.ts`) so that the
new agent-command parser and `command-parser.ts` — which comes to import the agent-command parser —
do not import each other (see the implementation plan's Task 2).

`ParsedCommand` (`chatops/types.ts:22`) gains:

```ts
| { readonly kind: "agent"; readonly agent: string; readonly params: Record<string, unknown> }
```

`params`, not `args`, and `Record<string, unknown>`, not a string-only record: Task 2's
`parseAgentCommand` COERCES each `k=v` value to the primitive kind `AGENT_PARAM_KINDS` declares for
that field — a number, a boolean, or a `stringArray` — so the values reaching `dispatchAgentsRpc`
are not all strings, and a string-only type here would either reject that coercion outright or hide
the mismatch until the router boundary. One shared, coerced-parameter type runs through the
specification, the parser, and `ParsedCommand` alike; see §6.2's coercion table.

`RefusalReason` gains `unknown_agent` and `bad_agent_params`.

Deliberately **not** `@nimbus why …` without the `agent` keyword: agent names would collide with the
free-text read fallthrough, so `@nimbus why is checkout slow?` would stop being a question and
become a malformed agent call. The keyword keeps the two grammars disjoint by construction.

### 6.2 Params: coercion, not builders — the no-duplication core

The validators in `ipc/agents-rpc.ts` already take `unknown` and already own **every** semantic
rule: type checks, bounds, required-ness, trimming, aliasing (`namespaces` beats `namespace`),
mutual exclusion (`ownership`'s `path` vs `service`), and the `-32602` messages. A caller may hand
them params directly — which is exactly what `agent-http-invoke.ts` does.

The only mismatch is that `k=v` yields **strings** and some params are not strings. So the work is
type coercion, not validation. Surveying every `typeof` check across all eleven validators, the
whole vocabulary is four kinds:

| Kind | Fields |
| --- | --- |
| `string` | `topicOrFile`, `fileOrPrUrl`, `file`, `path`, `service`, `ref`, `prUrl`, `term`, `namespace`, `resourceRef`, `cleanupAction` |
| `number` | `limit`, `depth`, `sinceMs`, `line`, `idleDays`, `minConfidence` (a **float** in 0..1, not an integer — `Number()` covers both; see the finiteness rule below) |
| `string[]` | `namespaces` — and `parseNamespaces` already accepts a scalar, so `namespace=team-a` needs no coercion |
| `boolean` | `allowGaps` (`janitor`) and `explain` (`decisions`) — both genuinely in scope, in permitted agents. `repropose` (`premortem`) is the only EXCLUDED boolean field. |

`personId` is deliberately absent from this table: it belongs to `requireNegotiateParams`, and
`negotiate` is one of the three excluded agents (§3 non-goals) — it never reaches the coerced-params
path this table describes. Reconciled against `AGENT_PARAM_KINDS` (the plan's Task 1, the actual
map this table must match field-for-field) rather than re-derived by inspection a second time here,
so the table, the map, and the round-trip tests (§10, "per agent per field") stay provably the same
vocabulary.

Nothing nested, nothing per-agent beyond a field's primitive kind. **`expert`'s entire "builder" is
`{ topicOrFile: "string", limit: "number" }`.**

Two modules, split by what resists drift:

- **`ipc/agent-param-kinds.ts`** — the per-agent field→kind map. Lives *beside* `agents-rpc.ts` on
  purpose: a param added to a validator is one line away from the map that must learn about it.
  ~40 lines, no logic.
- **`agent-commands/parse-agent-command.ts`** — the grammar and the coercion. Surface-neutral, pure,
  imports nothing from `chatops/`, so a later CLI or browser text surface reuses it unchanged. This
  is the standalone module.

**A coerced number must be finite, and this is load-bearing, not hygiene.** `Number("three")` is
`NaN`, and `typeof NaN === "number"` — so a `NaN` is not obviously rejected by a validator that
checks the type. Four of the five numeric fields survive it anyway, because `limit`, `depth`,
`sinceMs` and `line` all carry `!Number.isInteger(...)`, which `NaN` fails.

**`minConfidence` does not, and it is the only one.** Its check is, correctly for a float:

```ts
typeof p.minConfidence !== "number" || p.minConfidence < 0 || p.minConfidence > 1
```

`NaN < 0` is `false` and `NaN > 1` is `false`, so the whole condition is `false` and **`NaN` passes
validation into `DecisionsInput`**. Downstream every `confidence >= NaN` comparison is also `false`,
so `@nimbus agent decisions minConfidence=high` would return a brief listing **zero decisions, with
no error** — a silent wrong answer, which is worse than a refusal.

So `parse-agent-command.ts` rejects a non-finite coercion with `bad_agent_params` before dispatch.
The guard is `Number.isFinite`, not `!Number.isNaN`: it rejects `Infinity` too, which `minConfidence`
would otherwise catch by bounds but which no rule guarantees for a field added later.

This is a *defence-in-depth* fix, not a fix to `agents-rpc.ts`, and specific to THIS surface: ChatOps
is the one caller of `requireDecisionsParams` that can hand it a raw, in-process JS value it computed
itself (`Number("high")`) rather than a value that has passed through `JSON.parse`. **Standard JSON
cannot encode `NaN` or `Infinity` at all**, and `null` — the value `JSON.stringify` actually produces
for a non-finite number — fails `typeof p.minConfidence !== "number"` and is correctly rejected with
`-32602`, so there is no live IPC/HTTP path today: both those surfaces round-trip params through
`JSON.parse`/`JSON.stringify`, which structurally blocks it. The validator itself is nonetheless
worth tightening defensively — a future transport or a decoder that preserves non-finite numbers
(neither of which exists in this codebase today) would have no other backstop, and `Number.isFinite`
costs nothing to add now. Noted in §13.3 as that (unproven, no known live path) follow-up.

**Bounds constants are never copied.** `MAX_LIMIT`, `MAX_SINCE_MS`, `MAX_FILE_LEN` and the rest stay
module-private to `agents-rpc.ts`. The MCP surface mirrors them into zod today and carries a comment
admitting it; this surface does not.

**Rejected: heuristic coercion** ("if it parses as a number, make it one"). It silently corrupts a
legitimately numeric-looking string — `expert topicOrFile=2026`, a `ref` that is digits — into a
number, producing a `-32602` "must be a string" for input that was correct. A declared map cannot do
that.

**Rejected: teaching the validators to accept strings.** That widens the IPC contract for the socket
and HTTP surfaces to buy convenience on a third, weakening two callers to serve one.

### 6.3 The invoker

New file `agent-runs/agent-chatops-invoke.ts`, a sibling of `agent-http-invoke.ts` and deliberately
close to it in shape:

- Reaches agents **only** through `dispatchAgentsRpc` — never an `agents/<name>.ts` emitter, which
  static rule **D22(d)** forbids anyway and which is what keeps the egress append total.
- Builds its `runner` with the same `buildAgentSynthesisRunner` factory the socket and HTTP paths
  use, from the same `configDir`, so a channel brief and a CLI brief are the same answer under every
  `[agents].synthesis` mode.
- `notify` resolves a one-shot promise keyed on the returned `sessionId`, rather than writing into an
  `AgentRunController`. A channel has no polling client; it has a reply. Agents emit
  `<agent>.briefReady` with `{ sessionId, brief: markdown, findings, synthesis }`
  (`agents/_lib/emit-brief.ts:64`) and `<agent>.briefError`; the invoker awaits whichever lands.
- Bounded by a wall-clock timeout, default **60 s** — matching the MCP surface's default rather than
  the CLI's 30 s, because three of the eleven wait on paired peers.

**`caller`.** `dispatchAgentsRpc` selects its egress source type from `ctx.caller.kind` through
`EGRESS_BEARING_CLIENT_KINDS`, a `Record<ClientKind, …>` that is **total by construction**. A new
`ClientKind` member is therefore a compile error until its egress status is decided — which is the
mechanism working as designed.

The decision: **add `chatops` to `ClientKind` and map it to `null`.** Not because a channel brief is
not egress — it plainly is — but because **PR 1 already ledgers it**, at the post, where the bytes
actually leave. Appending here as well would write two rows for one outbound event: exactly the
double-count that `outcome` was made a marker to avoid. The `null` entry carries a comment saying
so, since `null` elsewhere in that map means "the owner reading their own index" and this is a
different reason for the same value.

`chatops` is **not** added to `RECOGNISED` in `client-kind.ts` — like `http`, it is constructed
server-side and never declarable by a socket client, so no local process can file its briefs under
it.

### 6.4 The permitted set

The eleven are already derived, once, at `ipc/agents-rpc.ts:983`. Rather than add a second list,
generalize the existing pair:

- `HTTP_EXCLUDED_AGENT_METHODS` → `EXTERNAL_EXCLUDED_AGENT_METHODS`
- `resolveHttpAgentMethod` → `resolveExternalAgentMethod`
- `HTTP_AGENT_NAMES` → `EXTERNAL_AGENT_NAMES` (still derived from `AGENTS_RPC_HANDLERS`)

Pure renames plus call-site updates; the derivation is unchanged. If the two surfaces ever need
different exclusions, that is the moment to split them — and a rename now makes that split a
deliberate act rather than a silent divergence between two hand-maintained lists.

`AGENTS_RPC_HANDLERS` stays unexported. Handing the map out would let another file invoke an agent
directly, a bypass D22(d) cannot see.

### 6.5 Identity and permissions

**An agent intent requires a mapped identity.** `binding.unmapped === "public-read"` admits unmapped
users to the `read` intent only; the agent intent does not inherit it.

1. Fail-closed is the reversible direction — relaxing later is a config change, tightening later
   breaks channels that came to depend on it.
2. Three of the eleven (`ghost`, `conflicts`, `huddle`) fan out to **paired peers**. An unmapped
   stranger in a `public-read` channel triggering federated requests against the owner's peers is a
   materially different act from reading a local answer.
3. `public-read` was scoped to `ask` deliberately. Widening a shipped permission by inheritance
   rather than by decision is how permissions grow without anyone choosing it.

**The cost, disclosed rather than papered over:** in a `public-read` channel an unmapped user gets an
answer to `@nimbus why is checkout slow?` and a refusal for `@nimbus agent why ref=…`. That is a
real inconsistency. It is the correct one — the free-text path's permissiveness is the older
decision, not the better one — but it is documented in the ChatOps docs, not left to be discovered.

An unbound channel stays silent; `IntentRouter.handle`'s existing `binding === undefined` early
return is untouched and no agent intent widens it.

Refusals go through the existing `auditRefusal` path with a named reason, never silently.

### 6.6 Rendering and length

There is no truncation anywhere in `chatops/` today (§2.5), and an agent brief is markdown of
unbounded length. Policy:

- Post the `brief` markdown from `briefReady`. The bot may restyle; it must never re-derive.
- **Cap at a per-platform limit and truncate at a section boundary**, appending an explicit
  ``_(truncated — N sections omitted; run `nimbus <agent>` locally for the full brief)_`` line. A
  truncation that does not announce itself is the `wordCount` defect from the web clipper (#1005)
  in a new place: reporting on content that was discarded.
- **Never truncate away a reserved disclosure section.** `## Gaps` — and `negotiate`'s `## Sources`
  / `## Evidence not available from the index`, though `negotiate` is excluded here — are
  constructed by the renderer and re-attached verbatim under **I31**, precisely so a rewrite cannot
  drop them. Silently truncating one would defeat I31 at the last hop, after the invariant did its
  job. If the brief does not fit, drop **body** sections and keep the disclosures.

That last rule is the one to get right, and it needs its own test: a brief whose `## Gaps` sits past
the byte cap must still post its gaps.

**Use I31's own section machinery — do not write a second markdown parser.** `agents/_lib/` already
exports everything needed: `reservedHeadingsFor(brief)` / `reservedBlocksFor(brief)` and
`RESERVED_HEADINGS_BY_KIND` (`reserved-sections.ts`) name the protected sections per brief kind, and
`stripSections` / `sectionBody` / `joinReserved` (`markdown-sections.ts`) split and reassemble them.

The truncator therefore: takes the reserved blocks via `reservedBlocksFor`, fits the **body** to the
remaining budget by dropping whole `##` sections from the end, and reassembles with `joinReserved`.

A fresh regex matching `^##` followed by a space would work most of the time and fail in exactly the wrong place. I31's
guarantee is expressed in terms of *these* functions — `normalizeSectionText`, the any-heading-level
strip, the non-heading `Gaps:` form — so a truncator with its own notion of "a section" can disagree
with the invariant at the boundary, and the disagreement surfaces as a dropped disclosure on the one
brief whose formatting differs. Reusing the functions makes the two definitionally the same. Note
also that `GAPS_HEADING` is not the whole protected set: `RESERVED_HEADINGS_BY_KIND` is per-kind, so
hard-coding `"## Gaps"` would under-protect any kind carrying more.

---

## 7. Anti-drift: making the no-duplication claim enforceable

A field-kind map can fall behind the validators it describes. Two mechanisms, both required.

**A structure audit** (`scripts/structure-audit/`, the D-rule idiom): parse `ipc/agents-rpc.ts` per
validator function for `typeof p.<field> !== "<kind>"`, map each function to its agent through
`AGENTS_RPC_HANDLERS`, and fail the build when `agent-param-kinds.ts` does not cover exactly that
set. Drift becomes a red gate.

**This is the piece with real implementation risk.** Associating a `typeof` site with its enclosing
function is the fiddly part, and a guard that silently matches nothing is worse than no guard —
`allowlist-guards-fail-silently` is a recorded lesson in this codebase. The audit must therefore be
**red-proved by reverting**: remove one field from the kinds map and confirm the gate fails, rather
than inferring correctness from a green run. If it cannot be made reliable inside PR 2's budget, it
ships as a follow-up and the round-trip tests below carry the load in the interim — but that is a
stated fallback, not a silent one.

**Round-trip tests**, per agent per field: feed a `k=v` line through `parse-agent-command.ts` into
the real `dispatchAgentsRpc` and assert it is not rejected on *type* grounds. This proves the map
against the validators rather than trusting it, and unlike the audit it cannot match nothing.

---

## 8. Surface

**Config.** None. The intent is available wherever ChatOps is already enabled and a channel is
bound. No new key, and specifically no per-agent enable list — that would be a second permitted-set
authority alongside §6.4.

**IPC.** None. No new gateway method; the intent dispatches through the existing `agents.*`
namespace in-process.

**CLI.** `nimbus prove` gains the `chatops` class in its output via `COVERAGE_CLASS_LABELS` (PR 1).
No new subcommand.

**Wiring.** The invoker is late-bound onto `ChatopsBoot` as `bindAgentInvoker`, mirroring the
existing `bindAskEngine` (`chatops/chatops-boot.ts:76`, called from `gateway-main.ts:170`).
`ChatopsBootDeps` carries no `db`/`index`/`configDir` today and this design does not add them —
matching how the ask engine is already supplied.

---

## 9. Disclosures

Stated in `docs/` and `SECURITY-INVARIANTS.md`, not as a per-reply banner. A footer on every brief
saying "this was not filtered by channel" is noise that gets tuned out, and it would be the only
surface disclaiming a property that already holds for every `ask` answer in the same room.

1. **A brief is not filtered by channel or namespace.** It is synthesized from the owner's whole
   local index and posted into a room whose members may include people with no Nimbus identity. §2.1
   explains why no filter exists to apply.
2. **Every post is ledgered** (PR 1) — including the ones that predate this feature.
3. **The permitted set is eleven, not fourteen**, and why.
4. **Unmapped users cannot invoke an agent**, and the resulting inconsistency with `ask` (§6.5).

---

## 10. Testing

**PR 1**

- A `@nimbus <question>` reply appends exactly one `chatops` row; the chain verifies.
- An approval card appends one row with `method='chatops.approvalCard'`.
- **A failed append posts nothing** — assert the post seam's call count is `0`, not merely that an
  error was thrown. (`fixing-one-door-leaves-the-adjacent-one-open`: assert the callee's call count.)
- The channel id does not appear in the ledger in cleartext — assert against the raw row.
- `serializeCoverage` round-trips with `chatops` at index 0; `parseCoverage` rejects a vector
  missing it.
- The CLI label mirror covers every `COVERAGE_CLASS` (a drift test, since it cannot import).

**PR 2**

- **The zero-LLM criterion (goal 4).** On a gateway with no model configured and
  `[agents].synthesis = "off"`, an agent intent posts a deterministic brief while `ask` refuses. A
  slice that only works with a model configured has not delivered this row.
- Payload parity: for one subject, the channel path and `dispatchAgentsRpc` return the same brief —
  asserted on the IPC response, not on two renderings.
- Round-trip coercion, per agent per field (§7).
- An unmapped user in a `public-read` channel is refused with `unmapped_user`, and **no agent runs**
  — assert the dispatch call count is `0`.
- An unknown or excluded agent name refuses via `auditRefusal` with `unknown_agent`; the four
  excluded methods are each named in a test.
- A `-32602` from a real validator reaches the channel as its own message.
- **Truncation keeps `## Gaps`** even when it falls past the byte cap (§6.6).
- Exactly one ledger row per brief — the PR 1 post row, and no second row from the invoker (§6.3).

Cross-platform: `chatops/` tests are pure and OS-independent, but per `CLAUDE.md` the PR legs run
the same whole-repo paths as the push matrix, so `bun run preflight` is the gate, not a scoped run.

---

## 11. Docs

- `docs/SECURITY-INVARIANTS.md` — I29 gains the `chatops` class (PR 1).
- `docs/architecture.md` — the ChatOps subsystem gains the agent intent (PR 2).
- `docs/CHANGELOG.md` — one dated entry per PR.
- `docs/roadmap.md` — the messaging-surface block moves from *direction* to shipped, **and its I17
  claim is corrected** per §2.1 (PR 2).
- `CLAUDE.md` / `GEMINI.md` — I29's summary gains the `chatops` class; both files, per the mirror
  rule.

---

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| The structure audit (§7) matches nothing and passes vacuously | Red-prove by reverting a map entry; round-trip tests carry the load if it slips |
| Adding a coverage class breaks cross-binary marker merges | Inherent and precedented (§5.4); named as a known cost |
| Truncation drops an I31 disclosure section | Dedicated test (§6.6, §10); disclosures are kept and body sections dropped |
| A brief posted to a room leaks more than the asker expected | Not solvable here (§2.1); disclosed (§9). The honest position is that this surface is exactly as permissive as the `ask` path it joins |
| `bindAgentInvoker` late-binding leaves the intent inert if wiring is missed | The `fakes-cant-catch-contract-mismatch` shape. One integration test through the real `chatops-boot` wiring, not two unit tests either side of the seam |

---

## 13. Review responses (Antigravity, 2026-08-29)

Reviewed in [`2026-08-29-chatops-agent-intent-design-review.md`](./2026-08-29-chatops-agent-intent-design-review.md).
All four suggestions accepted; both open questions answered here and folded into the sections above.

| # | Point | Disposition |
| --- | --- | --- |
| 2.1 | The `post` wrapper cannot know its caller | **Fixed**, differently — §5.1 |
| 2.2 | Salt the hashed channel id | **Fixed** — §5.3 |
| 2.3 | `NaN` from `Number()` coercion | **Fixed**, and one live hole found — §6.2 |
| 2.4 | Truncation must splice around `## Gaps` | **Fixed**, strengthened — §6.6 |
| 3.1 | Diagnostics when the ledger append fails | **Answered** — §13.1 |
| 3.2 | Federated identity for a chat-triggered peer query | **Answered** — §13.2 |

2.1 was a genuine self-contradiction: §5.3 claimed `method` was "derived server-side from the call
site" while §5.1 wrapped a closure that has no call-site information. The review's own remedy — an
optional `context?` argument — resolves the contradiction by conceding the claim, since the value
becomes caller-supplied *and* omittable. Binding the kind at construction (§5.1) keeps the original
property instead of trading it away.

2.3 was accepted as written and then found to be live rather than theoretical: `minConfidence` is
the one numeric field with no `Number.isInteger` guard, so `NaN` passes its validator today. §6.2
carries the detail; the follow-up below covers the surfaces this design does not touch.

### 13.1 A failed ledger append is silent in-channel and loud in the log

Nothing is posted, and **no error message is posted either.** That is not a UX shrug, it is forced:
an error reply would itself be an outbound chat post, so posting it would require an append that has
just been proven to fail. Any "sorry, I could not record this" message is either unledgered — the
exact hole PR 1 exists to close — or an infinite regress. Silence is the only fail-closed option.

Nor does it emit a `degraded` marker. That source type exists for lost-append *recovery*, and it is
itself a row: if the ledger is unwritable, writing the marker fails for the same reason.

So the diagnostic goes to the gateway log at `error`, naming the channel (locally, unhashed — the
log is not the ledger and has different retention and different threat model), the post kind, and
the underlying error. The reviewer's concern about debugging confusion is real and was, until three
days ago, worse than they knew: `logger.error({ err }, …)` serialised as `{"err":{}}`, because
`Error`'s `message` and `stack` are non-enumerable. That is fixed on `main` as of #1393
(`fix(logging): stop logging every Error as {}`), so this log line will actually carry its cause.
Without that fix this answer would have been "log it" and the log would have said nothing.

### 13.2 A chat-triggered peer query carries the OWNER's federation identity

Confirmed by reading the path, and it is worth stating because it is not obvious. `ghost`,
`conflicts` and `huddle` route through `federatedAgentBase(ctx, …)`, which uses `ctx.selfIdentity` —
the **gateway's** keypair. On the receiving side, I17's `query-gate.ts` evaluates grant, role and
consent against *that* identity. The chat user's SCIM identity is used to decide whether they may
invoke an agent at all (§6.5); it is not propagated to the peer, and the peer transport carries no
indication that the request originated in a channel.

So a mapped chat user borrows the owner's federation identity for the duration of the call.

**Decision: allow it, disclose it, and pin it with a test.** Three reasons. It is identical to the
shipped HTTP surface, where any `agents`-scoped bearer token already invokes `huddle` under the
owner's identity — excluding it here while leaving that open would be inconsistent without being
safer. It is also what these agents are *for*: `huddle` is a cross-team standup summary, and a
version that could not reach peers would be an empty brief. And §6.5's mapped-identity requirement
already exists partly to keep this reachable only by enrolled users.

What changes: a test asserts the peer-visible identity is the owner's, so the behaviour is pinned
rather than incidental, and §9 gains it as a disclosure. **The cheap fallback, if a deployment finds
this unacceptable:** add the three to `EXTERNAL_EXCLUDED_AGENT_METHODS` — a one-line change that
costs those three agents on both the ChatOps *and* HTTP surfaces, which is the honest price of the
consistency argument above.

### 13.3 Follow-up this design deliberately does not do

**Tighten `requireDecisionsParams` to reject non-finite `minConfidence`.** §6.2 blocks `NaN` at the
ChatOps boundary, which is all this design owes. There is no KNOWN live path to the same value over
IPC or HTTP today — both round-trip through standard `JSON.parse`/`JSON.stringify`, which cannot
carry `NaN`/`Infinity` and turns them into a `null` the validator already rejects — so this is a
defensive tightening against a future transport or decoder, not a fix for a currently reachable
hole. Still worth doing, in its own PR with its own tests, since the validator having no backstop
today is one decoder change away from mattering; recording it here rather than widening this one.

---

## 14. Decomposition

**PR 1** — `egress/chatops-egress.ts`; `EGRESS_SOURCE_TYPES` + `COVERAGE_CLASSES` +
`THIS_BINARY_COVERAGE`; wrap at `chatops-boot.ts:164`; CLI label mirror; D17 dead-path cleanup;
I29 docs; CHANGELOG.

**PR 2** — `ipc/agent-param-kinds.ts`; `agent-commands/parse-agent-command.ts`;
`agent-runs/agent-chatops-invoke.ts`; `ClientKind` + `EGRESS_BEARING_CLIENT_KINDS` gain `chatops`;
`parseCommand` third arm + `ParsedCommand` / `RefusalReason` members; `IntentRouter` agent branch;
`bindAgentInvoker` on `ChatopsBoot` + `gateway-main.ts` wiring; §6.4 renames; the structure audit;
truncation; docs + roadmap correction.
