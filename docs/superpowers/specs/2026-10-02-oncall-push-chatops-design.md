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
| Content | **Headline only.** No full-brief option, and no policy flag (decided 2026-10-02; see § 7). The full brief is already one intent away: `@nimbus agent oncall incident=<id>`. |
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
| `oncall-push/push-headline.ts` (new) | Pure functions: `renderPushHeadline(d: PushDelivery): string` and `renderPushSummary(ds: readonly PushDelivery[]): string`. |
| `oncall-push/push-sinks.ts` | `PushSinkDeps` gains `chatops?: ChatopsSinkDeps`, where `ChatopsSinkDeps = { readonly namespace: string; readonly post: () => ((text: string) => Promise<number>) \| undefined }`. A new `chatops` sink is added. |
| `oncall-push/push-runtime.ts` | Holds `let chatopsPoster: ((text: string) => Promise<number>) \| undefined`. Exposes `bindChatopsPoster(fn)` on `OncallPushRuntime` and passes `{ namespace: config.chatopsNamespace, post: () => chatopsPoster }` to the deliverer. `config.chatopsNamespace` gets its first consumer, and the "no consumer" header comment in `config/oncall-push-toml.ts` is updated. |
| `platform/assemble.ts` | After `bootChatopsIntoAssembly` returns a boot, calls `oncallPush.bindChatopsPoster((text) => chatopsBoot.postPushedBrief(ns, text))`, where `ns` is the namespace the runtime already holds. Nothing is bound when ChatOps is disabled. |

### 2.2 Data flow

```text
deliver(items)                                   // a run's new rows, or one retried row now ok
  ├─ event sink        (PR 1, every row)
  ├─ chatops sink      (NEW: runs before the toast sink's "no notifier" early return)
  │    namespace empty?          → every row skipped
  │    poster unbound?           → every row skipped
  │    sort newest openedAtMs first
  │    first PUSH_NOTIFY_CAP (3): post(renderPushHeadline(d)) → delivered / skipped(0 channels) / failed
  │    the rest: post(renderPushSummary(rest)) once → each row coalesced
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
- **I41 (demo).** ChatOps never boots in a demo gateway, so the sink records `skipped` and the demo's
  "0 outbound network calls" stays true by construction.

## 3. Headline content

`renderPushHeadline(d)` reads `d.incident` (`OncallIncident`) and parses `d.row.briefJson` with a narrowing step
of its own. There is no decoder for the stored `OncallBrief`; `null`, malformed JSON or the wrong shape all mean
"no brief". Output is at most three lines:

```text
P1 · <service> — <incident title>
<deployment line>
@nimbus agent oncall incident=<incidentId>  ·  locally: nimbus oncall pushed <incidentId>
```

- **Severity label:** `incident.severity`, falling back to `P1`.
- **Service:** `brief.binding.nimbusServiceId`, then `incident.pagerdutyServiceId`, then `unknown service`.
  `OncallIncident` has no service name of its own.
- **Deployment line**, in this order:
  - No brief (failed row, or unusable JSON): `Brief could not be assembled — @nimbus agent oncall incident=<id> to retry`.
  - `brief.deployment === null`: `No deployment found before the alert`.
  - Otherwise: `Last deployment before the alert: <deployment.title> (<n> min before) — timing only, not a proven cause`,
    where `n = round((incident.openedAtMs − (deployment.finishedAtMs ?? deployment.startedAtMs)) / 60_000)`, with
    a floor of 0. If `openedAtMs` is null, the `(<n> min before)` clause is omitted.
    "Timing only" carries the brief's own preamble disclosure: nothing links a deployment to an incident
    except timing.
- **No PR number.** `OncallChange` has no number field, and parsing one out of a URL would invent data.
- **Summary** (`renderPushSummary`, for rows past the cap):
  `<N> P1 incidents paged (<M> briefs ready) — @nimbus agent oncall incident=<id> for any of them: <id>, <id>, …`.
  Here `M` counts `status === "ok"` and the id list is the coalesced rows, newest first.

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
| Row past the cap | `coalesced`; if the summary post failed: `coalesced`, reason `summary post failed: <msg>` |

- **Partial delivery.** `send` posts to each channel in turn, and the first throw stops the rest. The ledger
  holds exact per-channel rows, so `delivery_json` does not duplicate per-channel bookkeeping. The reason text
  says the delivery may be partial.
- **Boot race.** If a PagerDuty-driven run could reach `deliver` before `bindChatopsPoster` runs, its rows would
  record `ChatOps not running` and never post: dedup keeps them from being reselected. The plan must establish
  the real order between `bindChatopsPoster` and the first scheduled sync, and pin it with a test. If binding
  cannot be guaranteed first, the plan raises it here before implementing anything.
- **Retry.** `nimbus oncall pushed <id> --retry` re-delivers an `ok` row to every sink, so the channel gets a
  second, complete headline. This is intended.
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
  - each service fallback, and the severity fallback
  - the summary line
  - a hostile title rendered inert
- **Unit, `oncall-push/push-sinks.test.ts`:**
  - every row of the § 4 table
  - the cap at 3, newest first, one summary post, rows marked `coalesced`
  - a summary post failure
  - a throwing chat post that does not stop the toast, and the reverse
  - chat posting with `notifyDelivers: false`
  - the poster read lazily, so a binding made after the deliverer was built is seen
- **Unit, `chatops/reply-dispatcher.test.ts`:** `send` returns 1, N and 0.
- **Unit, `egress/chatops-egress.test.ts`:** four kinds; `pushedBrief` writes `method = 'chatops.pushedBrief'` and
  `payload_summary` is the byte count with no text.
- **Integration:** a real migrated DB, plus real `buildLedgeredChatPosts` over a fake connector post that records
  calls. A pushed headline to a namespace with two notify channels appends exactly two `chatops` rows, each before
  its post. An append failure means no post call.
- **Wiring:** assembly booted with ChatOps enabled over a fake transport proves that `bindChatopsPoster` is
  reached and that a delivered row posts through `chatops.pushedBrief`. A negative control with ChatOps disabled
  records `skipped`. The § 4 boot-race order is asserted here.
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
