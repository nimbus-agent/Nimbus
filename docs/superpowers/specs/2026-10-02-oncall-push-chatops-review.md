# On-Call Pushed Brief, PR 2: ChatOps Sink — Design Review & Suggestions

**Date:** 2026-10-03  
**Target Spec:** `2026-10-02-oncall-push-chatops-design.md`  
**Branch:** `dev/asaf/oncall-push-chatops`  
**Status:** Review Complete  

---

## 1. Executive Summary

The design for PR 2 (ChatOps sink for on-call pushed briefs) is clean, tightly scoped, and adheres to core architectural invariants:
- **I23 (Destination derivation):** Destinations are server-derived from policy `notify` channels; no caller-supplied destinations.
- **I29 / D17 (Egress ledgering & post unwrapping):** Posts use `posts.pushedBrief` (`METHOD_FOR.pushedBrief = "chatops.pushedBrief"`) wrapped at construction by `buildLedgeredChatPosts`.
- **I41 (Demo gateway isolation):** ChatOps does not boot in demo mode, ensuring zero outbound network calls and honest `skipped` delivery tracking.
- **Failure isolation:** Errors in the ChatOps sink never throw out of `deliver` and never block the event or toast sinks.

This review identifies **one critical architectural race condition** regarding boot ordering, several **formatting/security edge cases**, and concrete suggestions for error handling and testing.

---

## 2. Critical Architectural Finding: Boot Race Condition (§ 4 & § 2.1)

### The Issue
Section 4 flags the boot race:
> *"If a PagerDuty-driven run could reach `deliver` before `bindChatopsPoster` runs, its rows would record `ChatOps not running` and never post: dedup keeps them from being reselected. The plan must establish the real order between `bindChatopsPoster` and the first scheduled sync, and pin it with a test."*

Inspection of `packages/gateway/src/platform/assemble.ts` reveals that **the race is guaranteed under current lifecycle ordering**:
1. `createSchedulerWithMesh(...)` (lines 634–918) creates `oncallPush` and `syncScheduler = new SyncScheduler(...)`, registering connectors and `onConnectorSyncSuccess: (serviceId) => oncallPush.trigger(serviceId)`.
2. At line 906, `createSchedulerWithMesh` calls `syncScheduler.start()`.
3. `SyncScheduler.start()` immediately sets `this.started = true`, starts a 25ms timer, and calls `this.tick()` immediately (lines 290–293 of `sync/scheduler.ts`).
4. `createSchedulerWithMesh` then returns to `assemblePlatformServices`.
5. `assemblePlatformServices` performs several asynchronous operations (e.g., `bootFederationIntoIpcOpts`, clipper setup) before reaching `bootChatopsIntoAssembly(...)` (line 3603) and `oncallPush.bindChatopsPoster(...)`.
6. If PagerDuty runs and syncs before step 5 completes, `oncallPush.trigger("pagerduty")` executes with `chatopsPoster === undefined`.
7. The sink records `{ outcome: "skipped", reason: "ChatOps not running" }` in `delivery_json.chatops` and inserts the row into `pushed_brief`.
8. Because `PushStore.has(id)` now returns `true`, those incidents are **permanently deduplicated and will never be posted to ChatOps**, even after ChatOps finishes booting.

### Recommendation
1. **Defer `syncScheduler.start()`**: Move the call to `syncScheduler.start()` out of `createSchedulerWithMesh` to the very end of `assemblePlatformServices` (around line 4310+ in `assemble.ts`), after all subsystems (ChatOps, federation, IPC options, and oncall-push poster binding) are fully initialized and bound.
2. **Pin with an Assembly Test**: In `platform/assemble.test.ts`, assert that `oncallPush` has its ChatOps poster bound before the sync scheduler begins ticking or executing sync callbacks.

---

## 3. Formatting, Security, & Rendering Refinements (§ 3)

### 3.1 Newline & Control Character Sanitization (Spoofing Defense)
- **Observation:** `escapeSlackText` escapes `&`, `<`, and `>` (`&amp;`, `&lt;`, `&gt;`). However, incident titles and deployment titles originate from external integrations (PagerDuty webhooks, GitHub/GitLab commit messages).
- **Risk:** If an incident or deployment title contains literal newline characters (`\r`, `\n`), an adversary or malformed payload could forge lines 2 and 3 of the Slack message (e.g. spoofing an `@nimbus agent ...` command or fake deployment status).
- **Suggestion:** In `renderPushHeadline`, normalize/sanitize single-line string fields (`incident.title`, `deployment.title`, service names) by replacing `[\r\n]+` with a single space and trimming before inserting into the 3-line template.

### 3.2 Redundant Call-to-Action on Failed Brief Rows
- **Observation:** Under § 3, when a row has `status === "failed"` or unusable `briefJson`:
  - Line 2: `Brief could not be assembled — @nimbus agent oncall incident=<id> to retry.`
  - Line 3: `@nimbus agent oncall incident=<incidentId> · locally: nimbus oncall pushed <incidentId>`
- **Suggestion:** Line 2 and Line 3 repeat `@nimbus agent oncall incident=<id>`. Simplify Line 2 to:
  `Brief could not be assembled.` (or `Brief assembly failed.`), letting Line 3 remain the single, canonical call-to-action line.

### 3.3 Elapsed Time Calculation & Null Safety
- **Formula:** `n = Math.max(0, Math.round((incident.openedAtMs - (deployment.finishedAtMs ?? deployment.startedAtMs)) / 60_000))`
- **Edge cases to verify:**
  - If `incident.openedAtMs === null`: omit the `(<n> min before)` clause entirely (as specified).
  - If `openedAtMs < deployTime` (clock skew or deploy completed after alert triggered): `Math.max(0, ...)` correctly floors to `0 min before`.
  - `deployment.startedAtMs` is required on `OncallDeployment` (non-null `number`), so fallback is always numeric.

### 3.4 Service Fallback Chain
- In `OncallServiceBinding`, `nimbusServiceId` is `string | null`.
- Ensure the narrowing handles:
  `brief?.binding?.nimbusServiceId || incident.pagerdutyServiceId || "unknown service"`
  (safely handling both `undefined` brief on failed rows and `null`/empty strings in `nimbusServiceId` / `pagerdutyServiceId`).

---

## 4. Summary Message Past the Cap (`renderPushSummary`)

### Clarification on Counts & ID Formatting
Spec § 3 states:
> `<N> P1 incidents paged (<M> briefs ready) — @nimbus agent oncall incident=<id> for any of them: <id>, <id>, …`
> *Here M counts status === "ok" and the id list is the coalesced rows, newest first.*

**Open Questions & Suggestions:**
1. **Definition of `<N>` and `<M>`:**
   - `<N>` should represent the total incidents in the run (`items.length`), and `<M>` the total ready briefs (`items.filter(d => d.row.status === "ok").length`), matching the toast sink's summary semantics.
   - For singular/plural grammar: `${M} brief${M === 1 ? "" : "s"} ready`.
2. **Syntax clarity:**
   - Template: `${N} P1 incidents paged (${M} brief${M === 1 ? "" : "s"} ready) — @nimbus agent oncall incident=<id> for any of them: ${coalescedIds.join(", ")}`
3. **Flood Protection on Incident Storms:**
   - If 50 incidents arrive at once, listing 47 incident IDs in a single message may exceed Slack formatting limits or clutter the channel.
   - Suggestion: Cap the displayed ID list to the first 10 coalesced IDs, with `… and ${rest.length - 10} more` if `rest.length > 10`.

---

## 5. Sink Delivery Outcomes & Return Value Contract (§ 2.1 & § 4)

### 5.1 `ReplyDispatcher.send` Return Contract
- `send(target, text): Promise<number>` returns:
  - `1` for `target.kind === "originating"`
  - `N` (count of channels) for `target.kind === "namespaceNotify"`
  - `0` when `notifyChannelsFor(namespace)` is empty.

### 5.2 Distinguishing `skipped` (0 channels) vs `delivered` (N >= 1) in `push-sinks.ts`
- In `push-sinks.ts`, `attempt(fn)` returns `{ outcome: "delivered" }` when `fn` does not throw.
- For ChatOps, `push-sinks.ts` must explicitly inspect the returned channel count:
  ```ts
  const sentCount = await poster(headline);
  if (sentCount === 0) {
    record(d.row.incidentId, "chatops", {
      outcome: "skipped",
      reason: `namespace ${deps.chatops.namespace} has no notify channels`,
    });
  } else {
    record(d.row.incidentId, "chatops", { outcome: "delivered" });
  }
  ```
- If `poster` throws:
  ```ts
  record(d.row.incidentId, "chatops", {
    outcome: "failed",
    reason: `${errText(err)} (delivery may be partial)`,
  });
  ```

### 5.3 Behavior for Coalesced Rows when 0 Channels Configured
- If the first 3 rows record `skipped` because `sentCount === 0` (no notify channels), the coalesced rows beyond `PUSH_NOTIFY_CAP` should also record `skipped` (reason: `namespace <ns> has no notify channels`) rather than attempting a summary post that also resolves 0.

### 5.4 Egress Append Failure Logging
- `egress/chatops-egress.ts` throws `EgressAppendFailedError` if SQLite insertion fails before sending the post.
- In `chatops-boot.ts`, `handleMessage` catches this and logs via `logError` (per ChatOps design § 13.1).
- In `push-sinks.ts`, ensure any caught error is recorded in `delivery_json` and logged via `deps.logger` if available, ensuring visibility into database ledger errors.

---

## 6. Documentation & Invariant Checklist (§ 6)

When implementing PR 2, ensure all occurrences of the "three functions" description of `buildLedgeredChatPosts` are updated to four:
- [ ] `GEMINI.md` (under Invariant I29)
- [ ] `CLAUDE.md` (under Invariant I29)
- [ ] `docs/SECURITY-INVARIANTS.md` (under Invariant I29)
- [ ] `docs/architecture.md` (oncall-push subsystem documentation)
- [ ] `docs/cli-reference.md` (`[oncall.push] chatops_namespace`)
- [ ] `packages/gateway/src/config/oncall-push-toml.ts` (header comment removal of "no consumer")

---

## 7. Test Plan Matrix Checklist (§ 5)

| Test File | Test Case | Target Assertion |
|---|---|---|
| `chatops/escape-outbound.test.ts` | `&`, `<`, `>` escaping | `&` escaped first; `<` and `>` inert; `<!channel>`, `<!here>`, `<@U123>`, `<url\|label>` neutralized |
| `chatops/escape-outbound.test.ts` | Newline normalization | Newlines replaced/collapsed in single-line title fields |
| `oncall-push/push-headline.test.ts` | Ok with deployment | Correct elapsed minutes, 0-floor, missing `openedAtMs` handling |
| `oncall-push/push-headline.test.ts` | Ok without deployment | `No deployment found before the alert.` |
| `oncall-push/push-headline.test.ts` | Failed row / null briefJson | Fallback deployment line, non-redundant CTA |
| `oncall-push/push-headline.test.ts` | Service / severity fallbacks | `nimbusServiceId` -> `pagerdutyServiceId` -> `unknown service`; `P1` fallback |
| `oncall-push/push-headline.test.ts` | Summary text formatting | Correct `N` total, `M` ready, coalesced ID listing |
| `oncall-push/push-sinks.test.ts` | No namespace configured | `outcome: "skipped", reason: "no [oncall.push] chatops_namespace"` |
| `oncall-push/push-sinks.test.ts` | Poster unbound | `outcome: "skipped", reason: "ChatOps not running"` |
| `oncall-push/push-sinks.test.ts` | 0 notify channels | `outcome: "skipped", reason: "namespace <ns> has no notify channels"` |
| `oncall-push/push-sinks.test.ts` | Successful post | `outcome: "delivered"` |
| `oncall-push/push-sinks.test.ts` | Throwing post | `outcome: "failed", reason: "... (delivery may be partial)"` |
| `oncall-push/push-sinks.test.ts` | Cap at 3 + summary | First 3 individual headlines, remainder `outcome: "coalesced"` |
| `oncall-push/push-sinks.test.ts` | `notifyDelivers === false` | Toast is skipped, but ChatOps sink **still posts** |
| `oncall-push/push-sinks.test.ts` | Lazy poster resolution | Poster bound after deliverer creation is correctly invoked |
| `chatops/reply-dispatcher.test.ts` | Return counts | Returns 1 for originating, N for multi-channel, 0 for empty list |
| `egress/chatops-egress.test.ts` | 4 post kinds | `pushedBrief` writes `method = 'chatops.pushedBrief'`, summary is byte count only |
| `platform/assemble.test.ts` | Boot order integration | Scheduler does not sync before ChatOps poster is bound |
| Demo e2e | Zero outbound calls | `delivery_json.chatops.outcome === "skipped"`, network calls = 0 |
