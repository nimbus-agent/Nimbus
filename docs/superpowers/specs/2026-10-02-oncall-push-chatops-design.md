# On-call pushed brief, PR 2: ChatOps sink — design

**Date:** 2026-10-02 · **Status:** draft for review · **Roadmap:** Phase 17 W2 (first half), Killer Demo beat 1
**Branch:** `dev/asaf/oncall-push-chatops` (cut from `main` at `7a4feb5e`, after #1592 merged). This spec never
lands on `main`; it is stripped before the implementation PR.
**Builds on:** PR 1 (#1592): the `oncall-push/` subsystem, `pushed_brief` (V64), toast and `oncall.briefPushed` sinks.

## 1. Purpose

PR 1 stores a brief for every new P1 assigned to the local owner and pushes a pointer to the owner's own machine.
PR 2 adds the team's channel. When a brief is pushed, a short headline goes to the ChatOps notify channel(s) of a
configured namespace, so the people working the incident see "what changed before this fired" without
anyone asking.

### Agreed understanding

| | |
|---|---|
| Who it is for | The on-call owner's team, in the namespace's notify channel |
| Success | A pushed brief posts one escaped headline per channel, ledgered as `chatops.pushedBrief`. Nothing posts unless a namespace is configured AND policy names notify channels for it. Every outcome is recorded in `delivery_json.chatops`. |
| Content | **Headline only.** No full-brief option, and no policy flag (decided 2026-10-02; see § 7). The full brief is already one intent away: `@nimbus agent oncall incidentId=<id>`. |
| Volume | Mirrors the toast sink. Up to 3 headline posts per run, newest first, then one summary post. Failed rows post too. A retry that becomes `ok` posts once more. |
| Out of scope | Full-brief posting; a Teams-specific notify path; escaping in the existing `@nimbus agent …` replies (§ 7); desktop panel (PR 3) |

### Corrections to the PR 1 spec's § 2.6

These come from reading the code (2026-10-02) and replace what that section assumed:

1. **`push_full_brief` dropped.** ChatOps policy is carried through as written, with no tighten-only merge.
   `computeEnforced` does `chatops: policy.chatops` (`policy/policy-gate.ts`). No boolean in `EnforcedPolicy`
   resolves tighten-only, and `policy/types.ts` warns against boolean grants. A "tighten-only widening flag" was
   never implementable as described.
2. **ChatOps boots after oncall-push.** `assembleOncallPushRuntime` runs inside `createSchedulerWithMesh`, and
   `bootChatopsIntoAssembly` needs that call's `connectorMesh`. The sink therefore needs a poster bound later.
3. **`ReplyDispatcher.send` returns `void`.** A namespace with no notify channels is a silent no-op, so a sink
   cannot tell `delivered` from "nobody to tell" without a return value.
4. **`CHATOPS_AGENT_BRIEF_MAX_BYTES` lives in `chatops/chatops-boot.ts`**, not in `brief-truncate.ts`. It is moot
   now, since a headline is never truncated.

## 2. Architecture

### 2.1 Components

| Unit | Change |
|---|---|
| `egress/chatops-egress.ts` | `ChatPostKind` gains `"pushedBrief"`. `METHOD_FOR.pushedBrief = "chatops.pushedBrief"`. The map is a total `Record`, so a missing entry does not compile. The row shape is unchanged: `source_id` is the salted channel hash, `payload_summary` is the byte count only, the append happens before the post, and an append failure throws `EgressAppendFailedError` and posts nothing. |
| `chatops/reply-dispatcher.ts` | `send(target, text): Promise<number>`. The result is the count of channels posted to: 1 for `originating`, N for `namespaceNotify`, 0 when the namespace has no notify channels. Existing callers ignore it. |
| `chatops/chatops-boot.ts` | Builds a third dispatcher, `pushedBriefDispatcher = new ReplyDispatcher({ post: posts.pushedBrief, notifyChannelsFor })`. `ChatopsBoot` gains `postPushedBrief(namespace: string, text: string): Promise<number>`, which sends to `{ kind: "namespaceNotify", namespace }`. |
| `chatops/escape-outbound.ts` (new) | `escapeSlackText(s: string): string`. It applies Slack's control-character escape: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, in that order. |
| `oncall-push/push-headline.ts` (new) | Pure functions: `renderPushHeadline(d: PushDelivery): string` and `renderPushSummary(all: readonly PushDelivery[], rest: readonly PushDelivery[]): string`, plus `oneLine(s)` (§ 3). |
| `oncall-push/push-sinks.ts` | `PushSinkDeps` gains `chatops?: ChatopsSinkDeps`, where `ChatopsSinkDeps = { readonly namespace: string; readonly post: () => ((text: string) => Promise<number>) \| undefined }`, and `warn?: (msg: string, fields: Record<string, string>) => void` for the § 4 failure log. A new `chatops` sink is added. |
| `oncall-push/push-runtime.ts` | Holds `let chatopsPoster: ((text: string) => Promise<number>) \| undefined` and a one-shot **sinks-settled gate** (§ 4, boot race). Exposes `settleChatopsPoster(fn \| undefined)` on `OncallPushRuntime`: it binds the poster (or records that there is none) and opens the gate; a second call throws. `chatopsSinkState(): "pending" | "bound" | "none"` reports which. `trigger` and `run` await the gate before the runner starts, so a PagerDuty sync that finishes during boot queues its run instead of delivering early. `retry` awaits it too. Passes `{ namespace: config.chatopsNamespace, post: () => chatopsPoster }` to the deliverer. `OncallPushBootDeps` gains `settleImmediately?: boolean` (default `false`) for tests and any caller with no ChatOps phase. `config.chatopsNamespace` gets its first consumer, and the "no consumer" header comment in `config/oncall-push-toml.ts` is updated. |
| `platform/assemble.ts` | Immediately after `bootChatopsIntoAssembly` returns, calls `oncallPush.settleChatopsPoster(...)` **on both branches**: with `(text) => chatopsBoot.postPushedBrief(ns, text)` when a boot was returned, and with `undefined` when ChatOps is disabled. `ns` is the namespace the runtime already holds. The call is an exported helper, `settleOncallPushChatops`, so it can be unit-tested. `PlatformServices` gains `oncallPush: OncallPushRuntime`, which lets the assembly test read `chatopsSinkState()`. |
| `platform/demo-boot.ts` | `BootPolicy` gains `chatops: boolean`, false in demo. `bootChatopsIntoAssembly` returns `undefined` when it is false (§ 2.3, I41). |

### 2.2 Data flow

```text
deliver(items)                                   // a run's new rows, or one retried row now ok
  ├─ event sink        (PR 1, every row)
  ├─ chatops sink      (NEW: runs before the toast sink's "no notifier" early return)
  │    namespace empty?          → every row skipped
  │    poster unbound?           → every row skipped  (runs wait for settleChatopsPoster, § 4)
  │    sort newest openedAtMs first
  │    first PUSH_NOTIFY_CAP (3): post(renderPushHeadline(d)) → delivered / skipped(0 channels) / failed
  │    the rest: post(renderPushSummary(items, rest)) once → each row coalesced (or skipped on 0)
  └─ toast sink        (PR 1, unchanged)
       │
       └─ every post goes through posts.pushedBrief → one chatops egress row per channel, appended BEFORE the post
```

### 2.3 Invariants

No new invariant, static rule or egress class.

- **I23.** The destination is resolved on the server from the policy `notify` list for the namespace. The only
  input from config is the namespace, which comes from the owner's own `nimbus.toml`. Nothing supplied by an
  inbound caller reaches this path.
- **D17.** The post is `posts.pushedBrief`, built inside `chatops-boot.ts` from the single
  `buildLedgeredChatPosts(db, buildConnectorPost(...), salt)` call that `D17-chatops-unwrapped-post` already
  checks. No new `buildConnectorPost` call is introduced.
- **I29 (`chatops` class).** One row per channel per post, under a new method name. Doc wording changes from
  "three functions (`reply`/`approvalCard`/`agentBrief`)" to four, in `CLAUDE.md`, `GEMINI.md`,
  `docs/SECURITY-INVARIANTS.md`, the `nimbus-egress` skill if it restates the list, and any `docs/` page that
  repeats it. The plan greps for every restatement.
- **I41 (demo).** Corrected 2026-10-03 during planning: ChatOps did NOT stay off in a demo gateway by
  construction. It stayed off only because the demo's generated `nimbus.toml` has no `[chatops]` section.
  `bootChatopsIntoAssembly` checked `chatopsCfg.enabled` and nothing else. This PR makes a demo page reach a
  chat sink, so the guard becomes structural. `BootPolicy` gains `chatops` (false in demo), and
  `bootChatopsIntoAssembly` returns `undefined` when it is false, the same way the env sidecars and the
  updater are gated. That is an I41 wiring change, so the docs and `security-invariants.test.ts` change in
  the same commit (triple rule). In a demo gateway the sink then records `skipped`, either for no
  `chatops_namespace` (the demo config sets none) or for `ChatOps not running`.

## 3. Headline content

`renderPushHeadline(d)` reads `d.incident` (`OncallIncident`) and parses `d.row.briefJson` with a narrowing step
of its own. There is no decoder for the stored `OncallBrief`; `null`, malformed JSON or the wrong shape all mean
"no brief". A MISSING key for one of the two nullable fields (`binding.nimbusServiceId`,
`deployment.finishedAtMs`) reads as `null` and falls back as above, rather than rejecting a brief that
exists. A wrong type still rejects. (Plan review, 2026-10-03.) Output is at most three lines:

```text
P1 · <service> — <incident title>
<deployment line>
@nimbus agent oncall incidentId=<incidentId>  ·  locally: nimbus oncall pushed <incidentId>
```

- **Severity label:** `incident.severity`, falling back to `P1`.
- **Service:** `brief.binding.nimbusServiceId`, then `incident.pagerdutyServiceId`, then `unknown service`.
  A `null`, missing or empty (after trimming) value falls through to the next. `OncallIncident` has no service
  name of its own.
- **Single-line fields.** Every inserted value (severity, service, both titles, ids) first has each run of line
  breaks and other control or separator characters (`\r`, `\n`, `\t`, U+0085, U+2028, U+2029, and the rest of
  `\p{Cc}`) collapsed to one space, then is trimmed. Without this a PagerDuty title or a commit-message
  deployment title containing a newline could forge the headline's second or third line, for example a fake
  deployment line that drops the "timing only" disclosure. This is `oneLine(s)` in `push-headline.ts`, applied
  before `escapeSlackText`. Added during planning: `oneLine` also removes format characters (`\p{Cf}`: bidi
  overrides and isolates, zero-width characters, the BOM), so a right-to-left override cannot make the
  rendered line read differently from its bytes (the Trojan Source class I35's terminal buffer refuses). It
  caps each field at 200 code points, with `…` marking the cut. A title that is empty after this renders as
  `(untitled)`.
- **Deployment line**, in this order:
  - No brief (failed row, or unusable JSON): `Brief could not be assembled; rerun the agent below to retry`.
    Line 3 already carries the `@nimbus agent oncall incidentId=<id>` call, so line 2 does not repeat it.
  - `brief.deployment === null`: `No deployment found before the alert`.
  - Otherwise: `Last deployment before the alert: <deployment.title> (<n> min before) — timing only, not a proven cause`,
    where `n = round((incident.openedAtMs − (deployment.finishedAtMs ?? deployment.startedAtMs)) / 60_000)`, with
    a floor of 0. If `openedAtMs` is null, the `(<n> min before)` clause is omitted.
    "Timing only" carries the brief's own preamble disclosure: nothing links a deployment to an incident
    except timing.
- **No PR number.** `OncallChange` has no number field, and parsing one out of a URL would invent data.
- **Summary** (`renderPushSummary(all, rest)`, for rows past the cap):
  `<N> P1 incidents paged (<M> brief[s] ready). Not posted individually: <id>, <id>, … — @nimbus agent oncall incidentId=<id> for any of them`.
  `N` and `M` match the toast sink's summary exactly: `N = all.length`, `M` counts `status === "ok"` over `all`,
  and `brief`/`briefs` follows `M`. The id list is `rest` (the coalesced rows), newest first, capped at 10;
  past that it ends `… and <K> more (locally: nimbus oncall pushed list)`. The cap keeps an incident storm to a
  readable message, and every id stays reachable locally.

**Escaping.** Every inserted value goes through `escapeSlackText`: severity, service, both titles and the
incident ids. The template's own literal text contains no `<`, `>` or `&`. Example: the title
`DB down <!channel> <https://evil|Rollback docs> & more` renders inert, with no mention and no disguised link.

## 4. Error handling

Every outcome is recorded in `delivery_json.chatops`. Nothing throws out of `deliver`, and one sink failing never
blocks another.

| Situation | Recorded |
|---|---|
| `chatops_namespace` is `""` | `skipped`, reason `no [oncall.push] chatops_namespace` |
| Poster unbound (ChatOps disabled, or not booted) | `skipped`, reason `ChatOps not running` |
| `post` resolves `0` (no notify channels for the namespace, including an ungoverned gateway with an empty policy map) | `skipped`, reason `namespace <ns> has no notify channels` |
| `post` resolves `N ≥ 1` | `delivered` |
| `post` throws | `failed`, reason `<error message> (delivery may be partial)` |
| Row past the cap | `coalesced`; if the summary post resolved `0`: `skipped`, reason `namespace <ns> has no notify channels`; if it threw: `coalesced`, reason `summary post failed: <msg>` |

Every `failed` outcome, and a coalesced row whose summary threw, is also logged at `warn` through the runtime's
`logger`, with the incident id and error message. An `EgressAppendFailedError` is a ledger fault, and recording it
only in `delivery_json` would leave it visible only to someone who runs `nimbus oncall pushed`. The log line never
carries the headline text.

- **Partial delivery.** `send` posts to each channel in turn, and the first throw stops the rest. The ledger
  holds exact per-channel rows, so `delivery_json` does not duplicate per-channel bookkeeping. The reason text
  says the delivery may be partial.
- **Boot race (resolved 2026-10-03).** The race is real. `createSchedulerWithMesh` calls `syncScheduler.start()`
  (`platform/assemble.ts`, inside `if (syncEnabled)`), and `start()` ticks at once. `assemblePlatformServices`
  then awaits `verifyExtensionsBestEffort`, `bootFederationIntoIpcOpts` and `bootTribalKnowledge` before it reaches
  `bootChatopsIntoAssembly`. A PagerDuty sync that is due at boot and finishes inside that window would call
  `oncallPush.trigger`, record `ChatOps not running`, and dedup would keep those incidents from ever posting.
  It is a window, not a certainty, but losing a page silently is the failure this feature exists to prevent.

  **Fix:** the sinks-settled gate (§ 2.1). The runtime does not start a run until `assemble.ts` has called
  `settleChatopsPoster` exactly once, on both the enabled and the disabled branch. Runs that arrive earlier wait;
  none is dropped. The gate does not block the sync itself, because `trigger` is fire-and-forget.
  If assembly throws before settling, the gateway does not come up, so a run that waits forever is never observable.

  **Rejected: moving `syncScheduler.start()` to the end of assembly.** That would also close the window, but it
  changes when every connector first syncs to protect one consumer, and it holds only while no future code adds an
  await-bearing step after the move. The gate puts the order in the runtime that depends on it, and any caller
  that forgets to settle fails a test instead of losing pages.
- **Retry.** `nimbus oncall pushed <id> --retry` accepts only a `failed` row (`ERR_ONCALL_PUSH_NOT_FAILED`
  otherwise). When the retry turns it `ok`, the row is re-delivered to every sink, so the channel gets a second,
  complete headline after the first "could not be assembled" one. This is intended.
- **No notifier.** The sink sits before the toast sink's `notifyDelivers === false` early return, so chat posting
  does not depend on the notification backend (which today delivers nothing).

## 5. Testing

The fixture rule: brief and incident fixtures come from the real writers (`syncPagerdutyIncidentItems` and the
oncall agent's real `briefReady` output, or `buildOncallBrief` over a seeded DB), never hand-written JSON.
`buildOncallBrief` lives in `agents/oncall.ts`. D22(d) exempts `*.test.ts` files from its import confinement but not
a shared fixture helper, so the import must sit in the test file itself. Every new
test is red-proved by reverting its fix before it counts.

- **Unit, `chatops/escape-outbound.test.ts`:** each control character; `&` escaped first, so `&lt;` input is not
  double-decoded; `<!channel>`, `<!here>`, `<@U123>` and `<url|label>` all inert.
- **Unit, `oncall-push/push-headline.test.ts`:**
  - ok with a deployment (minutes arithmetic, `finishedAtMs` falling back to `startedAtMs`, floor at 0, `openedAtMs` null)
  - ok with no deployment
  - failed row
  - `briefJson` that is `null`, malformed, or the wrong shape
  - each service fallback (`null` and empty string both fall through), and the severity fallback
  - the summary line: `N`/`M` over all rows matching the toast, singular `brief`, ids from `rest` only, the
    10-id cap with `… and <K> more`
  - a hostile title rendered inert
  - a title or deployment title with `\n`, `\r\n`, U+2028 and a tab renders on one line, so the headline is
    still exactly three lines
  - a failed row's line 2 does not contain `@nimbus`
- **Unit, `oncall-push/push-sinks.test.ts`:**
  - every row of the § 4 table
  - the cap at 3, newest first, one summary post, rows marked `coalesced`
  - a summary post failure
  - a throwing chat post that does not stop the toast, and the reverse
  - chat posting with `notifyDelivers: false`
  - the poster read lazily, so a binding made after the deliverer was built is seen
  - a summary post resolving `0` marks the coalesced rows `skipped`, not `coalesced`
  - a `failed` outcome calls `warn` once per row, with no headline text in the fields
- **Unit, `oncall-push/push-runtime.test.ts`:**
  - a `trigger` before `settleChatopsPoster` does not run until settle, then runs once and posts through the
    poster bound at settle (red-proved by removing the gate: the row records `ChatOps not running`)
  - settling with `undefined` releases a waiting run, which records `ChatOps not running`
  - a second settle throws
  - `settleImmediately: true` runs at once
- **Unit, `chatops/reply-dispatcher.test.ts`:** `send` returns 1, N and 0.
- **Unit, `egress/chatops-egress.test.ts`:** four kinds; `pushedBrief` writes `method = 'chatops.pushedBrief'` and
  `payload_summary` is the byte count with no text.
- **Integration:** a real migrated DB, plus real `buildLedgeredChatPosts` over a fake connector post that records
  calls. A pushed headline to a namespace with two notify channels appends exactly two `chatops` rows, each before
  its post. An append failure means no post call.
- **Wiring:** assembly booted with ChatOps enabled over a fake transport proves that `settleChatopsPoster` is
  reached and that a delivered row posts through `chatops.pushedBrief`. A negative control with ChatOps disabled
  records `skipped`. Both branches must settle the gate. The assertion is that a run triggered before ChatOps
  boots completes after boot, not that it hangs.
- **Demo:** the existing demo e2e "0 outbound" assertion stays green, plus `delivery_json.chatops.outcome === "skipped"`.

## 6. Documentation

- `docs/architecture.md`: the oncall-push section gains the ChatOps sink.
- `docs/cli-reference.md`: `[oncall.push] chatops_namespace` is no longer "parsed, no consumer".
- `docs/CHANGELOG.md` and the roadmap Phase 17 W2 row.
- `CLAUDE.md` / `GEMINI.md`: the I29 "three functions" wording, plus the Status line.
- The I29 restatements listed in § 2.3.

## 7. Decisions and follow-ups

- **No full-brief option (decided 2026-10-02).** The full brief is reachable on demand through the existing
  agent intent in the same channel, behind the binding and identity mapping. An unattended post of
  private-index content would need a widening policy field with no tighten-only precedent (§ 1, correction 1).
- **Slack-only notify posting is an existing limit, recorded here and not fixed.** `ReplyDispatcher` posts every
  `namespaceNotify` message as `"slack"`, because a policy `notify` entry is a bare channel id with no platform.
  That already applies to every notify post today; this sink inherits it.
- **Follow-up, not in this PR:** the existing `@nimbus agent …` brief replies do not escape outbound text either.
  A human triggers those, which makes the gap lower-risk than an unattended push. It should get the same
  `escapeSlackText` treatment in its own change.

## 8. Review dispositions (2026-10-03)

From `2026-10-02-oncall-push-chatops-review.md`. Each claim was checked against the code at `7a4feb5e`.

| Review item | Disposition |
|---|---|
| § 2 boot race | **Fixed, with a different mechanism.** The race is real, though the review's "guaranteed" overstates it; it is a window. The fix is the sinks-settled gate, not moving `syncScheduler.start()` (§ 4 gives the reasons). |
| § 3.1 newlines and control characters | **Fixed.** `oneLine` runs before escaping (§ 3). Extended past `\r\n` to U+2028/9, U+0085 and `\p{Cc}`, the same class the terminal buffer refuses for I35. |
| § 3.2 repeated call to action | **Fixed.** Line 2 of a failed row no longer repeats the agent command. |
| § 3.3 elapsed time | **No change.** The spec already covered all three cases. `OncallDeployment.startedAtMs` is a non-null `number` (`agents/_lib/oncall-types.ts`), so the fallback is always numeric. |
| § 3.4 service fallback | **Clarified.** Empty strings fall through as well as `null`. |
| § 4.1–4.2 summary counts | **Fixed.** `N` and `M` now match the toast summary (`push-sinks.ts`), which counts over all items. The old wording said "for any of them" next to a list that held only the coalesced ids. The new wording labels that list. |
| § 4.3 incident storm | **Fixed.** The id list caps at 10 and names the local command for the rest. |
| § 5.1–5.2 return contract | **No change.** It restates § 2.1 and § 4. |
| § 5.3 0 channels and coalesced rows | **Fixed, partly.** Coalesced rows record `skipped` when the summary resolves `0`. The summary is still attempted rather than inferred from the headlines. A 0-channel attempt sends nothing and appends no egress row, and recording the actual result is more honest than predicting it. |
| § 5.4 append-failure visibility | **Fixed.** `failed` outcomes are also logged at `warn` (§ 4). |
| § 6 docs checklist | **No change.** § 2.3 and § 6 already list these, plus the CHANGELOG, roadmap and `nimbus-egress` skill, which the review omits. |
| § 7 test matrix | **Merged** into § 5, with the gate tests replacing "scheduler does not sync before bind". |

### Found while planning (2026-10-03), not in the review

- **The call to action named a parameter that does not exist.** The `oncall` agent's ChatOps parameter is
  `incidentId` (`ipc/agent-param-kinds.ts`), so `@nimbus agent oncall incident=<id>` would have been refused with
  `'oncall' has no parameter 'incident'` in every headline. Every occurrence now reads `incidentId=`. The
  headline test round-trips the rendered command through the real `parseAgentCommand`, so a later rename
  breaks a test, not a channel.
- **I41's demo claim was true by config, not by construction.** The fix is in § 2.3.
- **§ 4's retry bullet** said retry re-delivers an `ok` row. Retry refuses an `ok` row. It re-delivers a
  `failed` row that becomes `ok`. Reworded.
