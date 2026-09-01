# Nimbus Changelog

Reverse-chronological log of dated deliveries. This file is the **single source** for the running delivery log — `CLAUDE.md`, `GEMINI.md`, and `docs/architecture.md` carry only a one-line status pointer to here, and [`docs/roadmap.md`](./roadmap.md) carries the forward-looking acceptance criteria and per-phase Shipped summaries.

Phase-level history before `v0.1.0` (Phases 1–4) lives in [`docs/roadmap.md` § Shipped](./roadmap.md#shipped); this file tracks the Phase 5 (Extended Surface) delivery cadence and later releases.

---

## Post-Phase-6 deliveries

- **2026-09-01 — `why`, `expert` and `ownership` answer about an indexed item, not just a PR.**
  A third input arm, `itemUrl`, on all three — so the browser client can ask about a Jira or
  Linear issue and a PagerDuty incident, not only a pull request. Requires `@nimbus-dev/sdk`
  **1.31.0**, which publishes `WhyItemSubject`, `WhyBrief.itemSubject` and
  `ExpertBrief.query.itemUrl` (all additive). **Deliberately not a Confluence page:** a page
  indexes as `type: "page"`, which appears in neither `ITEM_LINKED_ENTITY_TYPES` nor
  `GRAPH_SYNC_BY_TYPE`, so it has no `graph_entity` at all — and every lane here answers from
  graph edges. `resolveItemArm` treats "resolved, but no entity" as a miss rather than naming an
  item the lanes then say nothing about, and a test pins that bound. The arm is not a rewiring
  of an existing path: `ticketRowsForPr` joins `pe.type = 'pr'` on `from_id`, so handed an issue
  it returns zero rows, and `why` would otherwise have shipped a well-formed EMPTY brief for
  every issue in the index. `prResolvingItem` walks `resolves` INWARD to the change that closed
  the item and populates the lane input with it, so the four item-applicable lanes answer
  unchanged; `subAuthorship` and `subDownstream` stay silent, as they already do on the `prUrl`
  arm, because neither question ever had a file subject. `expert` gains two edge-backed
  sub-agents (`person --opened--> item`, and the resolving PR's author) and does **not** run its
  five `LIKE` lanes on this arm — mixing an edge-backed answer with a lexical one in one ranked
  list would let a title coincidence outrank someone the graph actually links to the item.
  `ownership` introduces no new target kind: the item is mapped to its service by
  `item --belongs_to--> repo --belongs_to--> service` and answered by the same service lane a
  `{ service }` request takes, so the two cannot disagree. Every guard's mutual exclusion is now
  a **count** rather than a pairwise check — `why`'s `hasRef === hasPrUrl` expressed "exactly
  one" only while there were two arms, and silently means "an odd number" at three.

- **2026-08-31 — The computer-use browser lane can now actually drive a browser, and the `browser` egress class went live with it.** The driver deferred on 2026-08-30 landed as **raw CDP over a WebSocket** (`computer-use/cu-lanes/`), with **no dependency at all** — Bun has a native `WebSocket`, and `playwright-core`, which fails a `bun build --compile` gate, is not reintroduced in any form. `platform/assemble.ts` now supplies the four `CuGateDeps` driver seams instead of `resolveBrowserPath: () => null`, so `ERR_CU_NO_BROWSER` is no longer the terminus of every session on a machine that has Chrome, Chromium or Edge installed. The nine items the plan required to close **in the same commit as the driver** are closed here; each is below with what it actually prevents rather than a checkbox.

  **Two defects the fixtures could never have caught, found the first time the observer ran against a real DOM.** (1) CDP reports `Fetch.requestPaused.resourceType` in **PascalCase** (`"Document"`, `"XHR"`, `"Image"`), while `CuResourceType` was written in `playwright-core`'s lowercase vocabulary — so the unguarded `req.resourceType() as CuResourceType` cast made **every** live type miss both `PASSIVE` and `SCRIPT_INITIATED`. Fail-closed, and a browser lane that could not render the origin its owner had just approved, because the page's own `Document` was gated too. Closed with a real guard (`cu-request-policy.ts`'s `toCuResourceType`, returning `null` — never a guess — for anything unrecognised, with the caller substituting `"other"`, which `decideRequest` places in the GATED branch). `Ping` (`navigator.sendBeacon` / `<a ping>`), `Preflight`, `Prefetch`, `Manifest`, `SignedExchange`, `CSPViolationReport`, `FedCM` and `TextTrack` are DELIBERATELY unmapped so they gate: `Ping` is a fire-and-forget outbound POST, i.e. exactly the channel § 3.5.1 exists to close, and folding it into a `PASSIVE` member "because it is a subresource" would reopen it. The RAW protocol string, not the substituted word, is what reaches `payload_summary`. (2) `new URL("javascript:…").origin` is the **string** `"null"` — the WHATWG opaque-origin serialization — which compares EQUAL to a `data:` page's own `location.origin`, so two opaque origins would have read as same-origin. Collapsed to JS `null` at the producer (`browser-observe.ts`'s `normalizeObservedOrigin`), which makes every downstream `!== null` guard fall to its actuating branch. Both are pinned by tests that run against a REAL Chrome when one is installed (`skipIf` otherwise), alongside the `closest()`-based `isSubmitControl` the contract was rewritten for — a `<span>` inside `<button type=submit>` reports `true`, verified live.

  **The pre-consent sandbox assertion was proving the wrong thing, and is replaced rather than patched.** `cu-gate.ts`'s `browserLanePolicy` was, by its own in-file disclosure, a PLACEHOLDER: a `SandboxPolicy` asserted against `SandboxRunner.canConfine` and then never used to launch anything. It was worse than uninformative — it carried `permissions.network: []`, which `linux.ts`'s `decideNetworkMode` reads as `no-net` → `--unshare-net`, so had it ever reached a real spawn the browser would have had no network **and the gateway no route to its own CDP endpoint**. It is gone. The gate now builds ONE `CuBrowserLaunchPolicy` (`cu-lanes/browser-launch.ts`), asserts it before consent (`assertBrowserLaunchPolicy`), and hands the SAME binding to `openLane`, which spawns its `argv` VERBATIM — an identity a test pins by object reference, not by equality. The assertion is load-bearing rather than decorative: an empty or relative `profileDir` is refused because Chromium with no `--user-data-dir` runs against the **owner's real profile** — their cookies, sessions and history, one missing flag away; a duplicate or disagreeing `--user-data-dir` is refused (Chromium takes the first and ignores the rest); a fixed debugging port is refused (the CDP endpoint has no authentication of its own, so any local process could drive that browser); and any `--no-sandbox`-class flag is refused, matched by PREFIX so `--disable-features=IsolateOrigins,site-per-process` cannot ride in looking like a tuning flag.

  **Deviation from the design spec, stated plainly rather than discovered later: the browser does NOT spawn through `SandboxRunner`.** Spec § 3.5 designed it to, with network granted. That is not achievable with today's PAL, and shipping it would have produced a lane that refuses or fails to launch nearly everywhere: a loopback debugging port needs `network-bind`, which macOS's `(deny default)` SBPL profile denies (it emits only `(remote …)` filters); the fd-pipe transport needs descriptors 3/4 forwarded, which the Windows AppContainer helper does not do; and Linux and Windows both additionally require `nimbus-sandbox-helper` for any network-bearing policy, a binary CI does not install. Making it work would mean widening the PAL profile for EVERY sandboxed connector, or passing Chromium `--no-sandbox` — disabling the renderer sandbox of the one process in this codebase that renders attacker-controlled content. The lane is instead confined by **Chromium's own multi-process sandbox** (kept intact, and the launch assertion is what keeps it intact), a **Nimbus-owned `--user-data-dir`**, the **§ 3.5.1 CDP request policy**, and **headless + `Browser.setDownloadBehavior: deny`** — the last so that "nothing this lane does puts a file on disk" does not rest on the gate refusing a `download` action kind, since a page can start a download on its own. Recorded in `docs/SECURITY-INVARIANTS.md` § I35 and in `cu-types.ts` beside the type itself.

  **The `browser` egress class is LIVE — `THIS_BINARY_COVERAGE.browser` raised `"none"` → `"per-run"` in this commit, per `egress-coverage.ts`'s own rule.** `wrapLedgeredBrowserContext` finally has a production caller: `openBrowserLane` wraps the CDP-backed context it constructs and enables `Fetch` interception THROUGH the wrapper, so every request is decided and ledgered before it proceeds. An append failure fails that request closed **and tears the CDP transport down**, so no later request can proceed unrecorded either — the lane then reports `isAlive() === false` and the gate terminates the session on its next action. `per-run` is the honest granularity: one row per `(destination origin, verdict)` pair, which NAMES every host the browser contacted without measuring how often. `nimbus prove`'s `COVERAGE_CLASS_LABELS.browser` mirror was re-worded for the live appender ("origins contacted by the computer-use browser lane"). **§ 3.5.1's bound survives and is not closed by any of this:** `script` and `image` subresources load from ANY origin, so a `<script src>` or `<img src>` carrying a payload in its URL still exfiltrates — it is rowed by origin, which is the mitigation, not prevented.

  **Six correctness gaps the plan flagged as becoming live the moment a driver existed, all closed.** (1) `CuGateDeps` was handed whole to the model-facing tool layer (`cu-tools.ts`, and through it `engine/agent.ts`), so any future file there could call `deps.openLane(...)` and click with no envelope, classification, consent or audit row — invisible to **both** D26 rules, since there is no `performActuation(` call and no driver import when the capability arrives as a function VALUE. Split into a `CuRunDeps` without any lane-construction seam; removing the capability, not adding a third rule over it. (2) `runAction` never re-checked liveness after an `await`, so a `closeSession` arriving while the owner read an approval prompt — an unbounded window — still actuated against a lane already torn down. Now `session.isOpen() && lane.isAlive()` is re-checked after the observation, after consent, and immediately before the host is touched. (3) There was no per-session serialisation, so two concurrent `computer.act` calls interleaved `dom_before`/actuate/`dom_after` on one lane — the damage is not the budget counter (`consumeAction` was always atomic) but the observation window: an interleaved pair records action A's `dom_after` from a page action B had already changed, making every `cu_action` replay body on that session a description of a state that never existed. A promise-chain `queue` on `LiveSession` serialises actions; `closeSession` deliberately does NOT queue behind one, since an owner closing a session must not wait on an action blocked on a prompt they are no longer going to answer — which is exactly what the re-checks make safe. (4) `terminated_target_lost` was declared and handled but **never assigned by anything**; the liveness re-checks now produce it, with its own termination reason, while an actuation that was ATTEMPTED and then failed still records `failed_after_approval` (the owner did approve, and downgrading it would resolve `hitl_status` to `rejected` and understate what happened) — the outcome recorded and the teardown owed are two different questions. (5) There was no boot-time reconciliation of orphaned `cu_session` rows: the durable table `computer.sessionStatus` reads survives a restart and the gate's in-memory `liveSessions` map does not, so after one they disagreed **permanently** — a session showed open forever, `sessionClose` answered `not_found`, and the CLI's watch loop polled until killed. `cu-boot-reconcile.ts` closes them at boot, before any session of the new process can open, with its own `close_reason` (`orphaned_by_gateway_restart`) rather than borrowing `terminated_target_lost`, which implies the gate observed the loss. (6) The two consent brokers were routed by probing `"seq" in input` — a structural property standing in for a tagged union, sound only because `seq` happened to exist on one shape and not the other. A `seq` added to the envelope input would have silently routed every session-open prompt to the ACTION broker, whose renderer draws a different prompt entirely: the owner would be asked to approve "a browser action" while the origin lists and budgets they were actually granting went unshown, with no compile error and no covering test. Now a `promptKind` literal discriminant with an exhaustive `switch`.

  **Ctrl-C no longer leaves a browser running on the gateway.** `nimbus computer browser` handles SIGINT/SIGTERM: it asks the GATEWAY to close the session (the session belongs to the gateway, not to the CLI process) and exits **130**, the POSIX convention. Before this, an interrupt exited the CLI and left a live headless browser inside an approved envelope with nothing watching it until its wall-clock ceiling expired — five minutes on the shipped defaults — and the owner had no signal it was still there. A second interrupt stops waiting and names the recovery command (`nimbus computer close <id>`) rather than blocking the terminal on a close that is not landing.

  **Static rule D26 grew a third rule and a much wider second one.** D26(b) matched `playwright`/`playwright-core` ONLY — and the driver that shipped is raw CDP with no dependency, so a file opening its own socket and clicking **passed it silently**; that gap was disclosed in `SECURITY-INVARIANTS.md` rather than enforced. It now also rejects any **CDP `Domain.method` string literal** (`"Page.navigate"`, `"Input.dispatchMouseEvent"`, …) outside `computer-use/cu-lanes/`, on the observation that a CDP client cannot do anything without naming a protocol method whatever transport it uses; the pattern has **zero** matches across `packages/gateway/src`, `packages/cli/src` and `scripts/` outside that directory — measured, not assumed. New **D26(c)** confines `openBrowserLane` to its own definition plus `platform/assemble.ts`, the same shape D22(f) uses for `wrapLedgeredEmbedder`: (b) confines the capability to a directory, but a wiring layer must reach into it once, and that one legitimate import is enough for a second to hide beside it.

  **Two things the macOS CI leg found that a green Windows run could not.** (1) `close()` returned as soon as `child.kill()` had been CALLED, which made it mean "a signal was sent" rather than "the browser is gone" — and since Chromium holds a `SingletonLock` on the shared profile directory for the life of the process, closing a session and immediately opening another raced the dying process for that lock. The new session then died at launch with `Failed to create …/SingletonLock: File exists (17)`, surfacing to the owner as `ERR_CU_LAUNCH_FAILED` with nothing connecting it to the session they had just closed. `close()` now AWAITS the process exiting (SIGTERM, 5s, then SIGKILL, 2s, then returns anyway — bounded, because it is called from `bestEffortCloseLane` on paths that are already unwinding), and the same wait guards the failed-launch path. Windows won that race every time locally; the cross-platform leg is the only reason it was found before a user hit it. (2) harden-runner recorded a freshly-launched Chrome connecting to `www.google.com` and `accounts.google.com` **before any page had loaded**, with `--disable-background-networking`, `--disable-component-update`, `--disable-sync` and `--metrics-recording-only` already set. That traffic comes from the browser PROCESS, not the page target where `Fetch.enable` is scoped, so it is neither gated by § 3.5.1 nor ledgered — a real narrowing of the `browser` class that is now stated in `egress-coverage.ts`, in I35, and in `nimbus prove`'s label (which reads "origins the computer-use browser lane's PAGE contacted"). `--no-pings`, `--disable-breakpad` and `--disable-domain-reliability` cut what can be cut without disabling a safety feature; `--disable-client-side-phishing-detection` was deliberately NOT added, and nothing spelled `--disable-features=…` can be, since the launch assertion refuses it as the vehicle for turning off site isolation.

  **Four fixes from review, three of them real defects.** The boot reconciliation closed the `cu_session` row and appended its audit entry as two writes, so a failed append left the row closed and unreturnable by `listOpenSessions` — no later boot could ever write its terminal entry, and the record lost it silently. Both writes are one transaction now; a failure rolls the closure back and the next boot retries. `toCuResourceType` indexed a plain object literal, so `("toString")` returned a function and `("constructor")` returned `Object` — values `?? null` does not catch, bypassing the caller's `?? "other"` fallback; not exploitable (CDP picks the string, and it still failed closed downstream) but a guard contracted to "never guess" must not have keys where that is false, so it is a `ReadonlyMap` now. `nimbus computer browser`'s second interrupt was a boolean read only between polls, so it printed its recovery guidance and then waited for an in-flight request that, on a wedged gateway, never settles — the loop now races both the request and the sleep against a cancellation promise. And the serialisation test named "a FAILING action still releases the lane" never made an action fail; the corrected version drives the one path that actually rejects (a failed audit append) and was red-proved by moving `releaseLane()` off the `finally`, where the broken build HANGS rather than fails.

  **One browser-lane session at a time, disclosed rather than discovered.** `[computer_use] browser_profile_dir` is one directory shared by every session (spec § 9, so a login survives across them), and Chromium holds a singleton lock on it — so a second CONCURRENT session fails at launch (verified against a real Chrome: exit code 21, empty stderr) and is recorded `failed_after_approval` / `ERR_CU_LAUNCH_FAILED`. Fail-closed and honestly recorded, but post-consent: the owner approves an envelope that then cannot start. Left this way deliberately rather than closed with a concurrency check in `openSession`, which would make the colliding-id teardown path (`evictExistingSession`) unreachable and is a product decision about session concurrency, not a driver detail. The driver names the likely cause when stderr is empty, so nobody is left holding a bare exit code.

  **Bound worth recording for whoever writes the next lane:** `type` is focus + select + `Input.insertText`, which synthesises **no key event** and therefore cannot press Enter — that is what keeps the classifier's `submitsForm` rule unreachable in the shipped surface, verified against a live page whose submit handler never fires. A `dispatchKeyEvent`-based implementation would make it live and would need a real producer wired to it. `isSubmitControl` resolves `closest("button, input[type=submit], input[type=image], form")` with a `FORM`-specific guard: the `form` in that selector catches the node BEING a form, and taking it literally would classify a click on any `<div>` or `<label>` inside any form as actuating — fail-closed, but so noisy it trains the owner to approve reflexively, which is the fatigue failure the design exists to avoid. **I11's screenshot bound remains anticipated, not live:** captures are still hashed and discarded, no vision-capable model is wired in, and the taint latch still taints by KIND rather than by content, in advance of a channel that does not exist yet.
- **2026-08-30 — The local computer-use loop's gate shipped; nothing can drive it yet.** New
  invariant **I35** + static rule **D26**, schema **V57** (`cu_session` / `cu_action`), new
  subsystem `packages/gateway/src/computer-use/`, deliberately parallel to `exec/` in shape and
  naming. An actuation reaches the host only through `cu-gate.ts`'s `openSession()`/`runAction()`,
  inside a live session envelope the LOCAL owner approved up front: refuse **before consent** when
  disabled by `[computer_use] enabled`/org policy (I22) or when the lane is not in `allowed_lanes`;
  assert `SandboxRunner.canConfine(policy)` — never `degradedReason()`/`isFullyActive()`, I33's
  identical reasoning; **refuse, never prompt**, an action outside the approved envelope; derive
  the HITL class STRUCTURALLY from the gateway-observed target (`cu-classify.ts`), never the
  model's own `modelDescription` field (I3 transplanted); obtain single-use owner approval for
  every `actuating` verdict; append one `computer.action` audit row before every actuation,
  fail-closed. The envelope's immutability is enforced at construction: `CuSession` deep-freezes
  the approved envelope and both origin arrays when the session opens, so origins can never grow
  and budgets can never rise — that holds from the first action, independent of any latch. The
  taint latch (`tainted_at`) is a durable forensic record of the moment untrusted content first
  enters a session, not an enforcement mechanism: nothing in production reads it today. Screenshot
  bytes are BLAKE3-digested and discarded in the same expression that captures them; no pixel is
  ever written to disk, on any lane, at any point. New IPC namespace `computer.*`
  (`sessionOpen`/`act`/`sessionStatus`/`sessionClose`/`approvalRespond`), whole-namespace
  LAN-forbidden (I5) and absent from the Tauri `ALLOWED_METHODS` (I7), exactly as `exec.*` is and
  for the same reason. New CLI surface `nimbus computer browser|sessions|close`. Static **D26** has
  two rules, because one does not carry the property: `performActuation` confinement to
  `cu-gate.ts`/`cu-actuate.ts` (mirrors I33's D23), and driver-import confinement — no file outside
  `computer-use/cu-lanes/` may import a browser driver, in either import form (mirrors D22(d)).
  Design: [`docs/superpowers/specs/2026-08-30-s2-computer-use-design.md`](./superpowers/specs/2026-08-30-s2-computer-use-design.md).

  **What did NOT ship, so this is not read as a working capability.** The browser **driver does
  not exist**: `playwright-core@1.62.1` fails a `bun build --compile` gate — a statically-resolved,
  unconditional `require("chromium-bidi/lib/cjs/...")` inside a lazy-init block for its unused
  WebDriver-BiDi transport, which bun's bundler resolves eagerly at compile time and fails outright
  — reproduced identically against both `packages/cli`'s and `packages/gateway`'s own
  `bun build --compile` step, and not fixable by installing the published `chromium-bidi` package
  (its public layout does not match the internal path Playwright's build vendors). It is re-planned
  against raw CDP over a WebSocket. Consequently `platform/assemble.ts` wires
  `resolveBrowserPath: () => null`, and `cu-gate.ts` refuses **every** session before consent with
  `ERR_CU_NO_BROWSER` — the furthest a **fully-configured** user can get today, not the only
  refusal a real user can reach: with the shipped defaults (`enabled = false`, `allowed_lanes =
  []`) a real user hits `ERR_CU_DISABLED` first, then `ERR_CU_LANE_NOT_ALLOWED`, then
  `ERR_CU_SANDBOX_DEGRADED`, before `ERR_CU_NO_BROWSER` is even reached — over a gate, classifier,
  request policy, envelope, taint latch, IPC surface, agent-tool wiring, invariant and static rule
  that are all wired and tested. `nimbus computer browser` is consequently a PASSIVE LISTENER, not
  a driver: it opens a session and answers its two consent-prompt kinds, but `computer.act` has no
  production caller anywhere in this build. The **terminal** and **screen** lanes did not ship at
  all — deferred to slices 2 and 3 — nor did the screen lane's `opaque` egress marker or the
  `nimbus prove` indeterminacy verdict it requires. The `browser` egress coverage class ships as
  **`"none"`**, not `per-run`: `egress/browser-egress.ts`'s `wrapLedgeredBrowserContext` is a
  decorator over a driven `BrowserContext` and has no production caller until the driver lands —
  it returns to `per-run` in the same commit that gives it one. Invariant **I11**'s screenshot
  bound is **anticipated, not live**: a capture hashes its bytes and discards them in the same
  expression, the model receives only an outcome and a digest, and no vision-capable model is
  wired into the agent — so there is currently nothing on this path for an envelope to protect;
  the taint latch is nonetheless built to taint by KIND rather than by content, in advance of a
  channel that does not exist yet. **Adding `browser` to `COVERAGE_CLASSES` invalidates every boot
  marker written by a binary built before this landed** — `parseCoverage` requires every known
  class to be present in a marker string, so an older binary's marker is missing the new key and a
  window spanning the upgrade reads `indeterminate` rather than a clean count. Fail-safe, not a
  soundness bug, but user-visible: it is called out here rather than left for a bug report.

- **2026-08-30 — ChatOps agent intent: the deterministic agents were unreachable on the one surface that needs no install.** `@nimbus agent why ref=src/auth.ts line=42` in a bound Slack/Teams channel now runs one of eleven externally-permitted built-in agents and posts its brief — closing a dependency inversion standing since Phase 6 Slice 5: a channel `read` requires a configured LLM, while the built-in agents render deterministically with **no LLM at all**, and until now they were exactly the output a channel could not reach.

  `agent <name> k=v …` is parsed ahead of the free-text `read` fallthrough (`chatops/command-parser.ts`'s `parseAgentCommand`); `agent`/`run` share a leading keyword with free text, so `@nimbus why is checkout slow?` still parses as a question. Params are **coerced, not validated** — `ipc/agent-param-kinds.ts` declares each field's primitive kind and `agent-commands/parse-agent-command.ts` converts a `k=v` token accordingly, but `ipc/agents-rpc.ts` keeps sole ownership of every bound and every `-32602` message; a non-finite number (the live, previously-unguarded `minConfidence` hole) is refused before dispatch. The permitted set is **eleven, not fourteen**: `EXTERNAL_EXCLUDED_AGENT_METHODS` (renamed from `HTTP_EXCLUDED_AGENT_METHODS`, generalized to every external surface) drops `preflight`/`premortem` for their side effects, `negotiate` because `--person` makes it a dossier-builder for anyone who can read the channel, and `whyPeek` as a companion to `why` rather than a fifteenth agent — ChatOps inherits this exclusion set from the already-shipped HTTP/MCP surfaces rather than re-deciding it, since every reason is stronger in a shared room. An agent command requires a **mapped identity**: `binding.unmapped === "public-read"` admits an unmapped user to `read` only, so the same person gets an answer to a plain question and a refusal for an agent command in the same channel — a real, disclosed inconsistency, not an oversight. The brief is truncated to a per-platform byte cap that **always binds**: ordinary body content — at ANY heading level, not only `##` — is dropped from the end first, and a reserved section is touched only once that is exhausted (glossary's synthesis-reserved `## Terms` table is shrunk, with an honest count, before an I31 disclosure section's own bytes are ever cut, which happens only as the absolute last resort, always with an unambiguous notice), reusing `agents/_lib/`'s own section machinery (`sectionBody`/`stripSections`/`joinReserved`/`topLevelSections`) rather than a second markdown parser. The reply goes out through a second `ReplyDispatcher` over `posts.agentBrief`, keeping I23's "sole operational post path" claim intact, and — riding the `chatops` I29 coverage class a preceding PR already shipped — appends exactly one `egress_ledger` row per brief with `method='chatops.agentBrief'`, from the post appender, never the invoker.

  `docs/roadmap.md`'s messaging-surface block is corrected alongside this, not merely moved to shipped: its claim that "the channel↔namespace binding and the `I17` grant/role/consent filter are load-bearing here" was wrong. `I17` governs federated answering only and never sits on this path; `namespaces` selects which peers a federated agent (`ghost`/`conflicts`/`huddle` — three of the eleven) asks, not which local rows are visible — so a brief is not filtered by channel or namespace at all, and there was never a local filter to inherit. A fourth agent, `janitor`, is also a `federatedAgentBase` caller and fans out to peers the same way, but does not itself accept `namespaces`. All four of those agents (`ghost`/`conflicts`/`huddle`/`janitor`) fan out to paired peers carrying the **gateway owner's** federation identity, never the chat user's, and the peer sees no indication the request came from a channel — a mapped chat user borrows the owner's identity for the call, exactly as an `agents`-scoped HTTP bearer token already does.

- **2026-08-29 — A `nimbus prove` zero over a ChatOps window now means the bot said nothing — before this, it meant nothing about ChatOps at all.** Every outbound Slack/Teams post — operational replies (I23), HITL approval cards, tribal repeat-question suggestions, and (once a caller exists) agent briefs posted into chat — now appends one `egress_ledger` row before it leaves the machine. This is a NEW `chatops` egress class, not a widened existing one: until today `COVERAGE_CLASSES` did not contain `chatops` at all, so a chat post left no trace and no disclaimer either — `nimbus prove` could report a clean `0` for a window in which a brief synthesized from the private index had actually been posted to Slack's servers. That is a stronger failure than the `mcp`/`http` classes' documented narrowness: those two always said, in the same commit that added them, exactly what they did not cover; chat egress was simply absent from the record.

  The appender (`egress/chatops-egress.ts`'s `buildLedgeredChatPosts`) is a construction-bound FACTORY — one call returns three functions (`reply` / `approvalCard` / `agentBrief`), each closing over which consumer it serves — rather than a single wrapper, because the shared `ChatPost` signature carries no argument saying which consumer is calling; binding the kind at the one wiring site that already knows keeps the ledgered `method` (`chatops.reply` / `chatops.approvalCard` / `chatops.agentBrief`) server-derived instead of inferred from the text. `source_id` is a per-install-salted BLAKE3 hash of the channel id (the salt lives in the Vault under `chatops.channel.salt`), never the id itself; `payload_summary` records the message's byte length, never its text. Unlike `mcp`/`http`, the `chatops` class is NOT narrower than its name: it covers every outbound post on the one shared closure `chatops-boot.ts` builds, so a zero here means the bot said nothing.

  Static confinement rides the existing `I23` rule rather than a new number: `D17-chatops-unwrapped-post` rejects any `buildConnectorPost(...)` call that is not itself the direct argument to `buildLedgeredChatPosts(...)`, checked PER OCCURRENCE (not per file, not by token count) so it stays alert inside `chatops-boot.ts` itself — the one file that legitimately contains a wrapped call, and so the one place a file-level or counting guard would have gone blind. `COVERAGE_CLASSES` now carries six non-`none` entries (`chatops`, `http`, `mcp`, `model`, `sync`, `task`); `nimbus prove` labels the class "Slack/Teams posts". See `docs/SECURITY-INVARIANTS.md` § I29 for the full scope statement.

- **2026-08-29 — The `model` egress class closes its last named exclusion: remote embeddings.**
  `egress/embedding-egress.ts`'s `wrapLedgeredEmbedder` is a THIRD I29 `model`-class appender,
  the same DECORATOR shape as `wrapLedgeredProvider` and `wrapLedgeredMastraModel` — applied at
  each of the embedding pipeline's three construction sites (`embedding/create-routing-
  runtime.ts`, `embedding/create-embedding-runtime.ts`, `ipc/index-reembed-rpc.ts`, confined
  there by new static rule **D22(f)**) rather than at one call site, so it covers every `embed()`
  caller, including ones written later, without any of them cooperating. It appends ONE row per
  embed BATCH — never per text — before the request leaves the machine (`method='embedding.embed'`,
  `destination` the vendor half of the embedder's model id, e.g. `openai`), and an append failure
  aborts the embed (fail-closed). Locality is DERIVED from `embedder.isLocal`, never a
  caller-computed flag, mirroring `wrapLedgeredProvider`.

  **What a `model: 0` window now means, and what it still does not.** Before this landed,
  `PROSE_HEAVY_TYPES` routed prose straight to OpenAI's 1536-dim embedding table with no appender
  at all, so `nimbus prove` could report `model: 0` over a window in which a real vector had left
  the machine — true about generates, silent about embeddings. That gap is closed: a `model: 0`
  window now means no non-local generate AND no non-local embed left the machine, across every
  reachable caller of either. The bound that SURVIVES, and is correct rather than a residual
  exclusion: a LOCAL embedder (MiniLM) is returned UNCHANGED by its own wrapper and still appends
  nothing, by construction — exactly as a local LLM route or a locally-run Mastra model already
  did. That is the `model` class working as designed, not a gap in it.

- **2026-08-29 — `v7.0.0` is ABANDONED. Do not look for its artifacts; there are none.** The tag
  exists and is immutable (the *Protected release tags* ruleset has no bypass actors), but the
  Release workflow's **Build CLI — macos** job died in `Upload artifact` with
  `Failed to CreateArtifact: Unable to make request: ENOTFOUND`, alongside harden-runner
  reporting "The Internet connection appears to be offline" — a GitHub Actions network/DNS
  outage on the macOS runner, not a defect in the code. No GitHub Release was published, so
  `v6.0.1` remained the latest until **`v7.0.1`** superseded it. Same handling as `v1.11.0`
  (#957 → superseded by 1.12.0): the failed version is left dead and the next one is cut.

  Worth recording alongside it: `v7.0.0` should not have been a MAJOR at all. Its only breaking
  entry was #1372, which made `LlmRegistryOptions.db` required — a `private: true` package with
  no published surface, in a PR that said as much and carried a `!` anyway. The same mistake
  produced `v3.0.0`, `v4.0.0` and `v6.0.0`; of the five majors between `v2.21.0` and `v7.0.0`,
  only `v5.0.0` required a user to do anything. The rule that should have applied is now written
  down in `CLAUDE.md` / `GEMINI.md` under *Development Workflow*.

- **2026-08-28 — The `ask` intent classifier stops being the one path that egressed outside the
  ledger, and `route_priority` learns to name a cloud vendor.** Four defects found on a live
  v5.0.0 install, in severity order.

  **The classifier (#1363).** `engine/router.ts` held its own HTTP client: it read
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` straight from the process environment and POSTed the
  user's question to Anthropic or OpenAI, appending **no `egress_ledger` row**. `nimbus prove`
  reported `0` for a query that had made a real outbound request carrying user text. It also had
  **no opt-in**: a user who had enabled Gemini alone still egressed to Anthropic if a stale key
  sat in their environment — precisely the shape slice 2b's `[llm.remote.*]` design exists to
  prevent, one path over. Observed live, and only a stale key stopped the send. Note that it
  evaded static rule D22 as well: a raw `fetch` is not `connectors.dispatch`, and the file never
  named `appendEgressEntry`. The classifier now asks `LlmRouter` for the `"classification"` task,
  so `wrapLedgeredProvider` covers it like any other route (`method='engine.ask.classify'`) and
  the per-vendor opt-in applies. Three consequences: **the `model` class's "one exclusion" claim
  is now TRUE** where before it under-reported (embeddings remain the only one); classification
  can run on a **local** model for the first time, so `enforce_air_gap = true` with a local route
  now classifies instead of refusing; and an unparseable reply **degrades to `intent: "unknown"`**
  rather than throwing, because small local models return prose often enough that a throw would
  abort the `ask` on a routine event. Transport and auth failures still throw. `[llm]
  classifier_model`, `NIMBUS_CLASSIFIER_MODEL` and `NIMBUS_OPENAI_CLASSIFIER_MODEL` are **removed**
  — nothing reads a classifier model name any more, and a live config key that does nothing is
  worse than no key. A stale entry in an existing `nimbus.toml` is ignored, as any unrecognised
  `[llm]` key is.

  **`[llm] remote_model` and `NIMBUS_AGENT_MODEL` were inert and are removed too.** Found while
  verifying the Gemini adapter against the live API. Slice 2b moved the engine agent onto
  `[llm.remote.<vendor>] model` and left `getEffectiveAgentModel()` **without a production
  caller** — so both keys changed nothing, while `nimbus config list` still listed
  `llm.remote_model` as a live env-overridable key and `cli-reference.md` still documented
  `nimbus config set llm.remote_model claude-sonnet-4-6` as THE way to choose a cloud model. A
  comment in `engine/agent.ts` asserted they "still override the MODEL NAME within the enabled
  vendor"; nothing wired that. With four vendors the key is no longer well defined anyway — a
  bare `claude-sonnet-4-6` says nothing about which vendor is enabled — so it is removed rather
  than rewired, and `[llm.remote.*]` gained the reference documentation it shipped without.

  **A live-API check of the Gemini adapter.** The wire format is correct — URL-path model,
  query-string key, `systemInstruction`, `generationConfig`, multi-part concatenation and
  `usageMetadata` all verified against the real endpoint. What is NOT correct is the model id
  every internal document had been using: `gemini-2.5-pro` and `gemini-2.5-flash` still appear in
  Google's `GET /v1beta/models` listing but return `404 NOT_FOUND … no longer available to new
  users` on `generateContent` for a key issued after their retirement, so anyone following our
  examples got a hard 404 from a model the listing said existed. The new `[llm.remote.*]` docs say
  to check the vendor's current list rather than copy an id, and give this as the worked example.

  **`route_priority` could not name a cloud vendor.** A defect introduced by slice 2b:
  `routeIdsToRegister` was computed from LOCAL routes only, so
  `dropUnresolvableRoutePriorityEntries` dropped every enabled vendor's route id as unresolvable
  before the router was constructed — and under `prefer_local = true` that made the vendor
  effectively unreachable. Local and remote ids are now resolved from one `resolveEnabledVendors`
  call and validated together.

  **`providerLabel` knew only `anthropic` and `openai`.** Gemini and xAI failures rendered as the
  generic "the LLM provider", and on a Gemini-only install a classifier 401 read as an *Anthropic*
  problem. The label map is now TOTAL over `AgentProviderName`, so a vendor added without a label
  is a compile error.

  **`nimbus llm status` ran two columns together (#1362).** `pad()` returned the value unchanged at
  or over the column width, emitting no separator: `ollama/llama3.2:latest` is exactly 22, the
  `routeId` width, and slice 2b's own documented `anthropic/claude-sonnet-4-6` is 27. The gap is
  now unconditional rather than a function of the value's length — widening the column would only
  move the cliff to the first longer model name.

- **2026-08-28 — Four cloud vendors ship behind a default-off, per-vendor opt-in, and the `model`
  egress class becomes live for the first time.** Slice 2b of the LLM model routes work, landing
  directly on 2a's chokepoint (#1357). `[llm.remote.<vendor>]` tables configure **Anthropic,
  OpenAI, Gemini and xAI** — three wire formats, since xAI is OpenAI-compatible. **`enabled`
  defaults to FALSE and is never inferred from the presence of a key**, which is the single
  property the slice exists to preserve: `openai.api_key` is deliberately REUSED from the
  embedding runtime rather than minted fresh, so an existing embeddings user already has that
  credential — and a capability that turned itself on because a credential exists would light up
  for them without their asking. Keys are read from the **Vault and never the environment**, per
  call, so a key added after boot works with no restart and no env var can satisfy a vendor
  nobody opted into. **Cloud adapters hardcode `isLocal = false`** and do NOT derive it from
  `base_url` — the inverse of slice 1's rule for local runtimes, because a LiteLLM-style proxy on
  `127.0.0.1` forwards to the vendor; invariant **I34** now pins both directions. Availability is
  answered **offline** (enabled-and-keyed, no `/models` probe), because probing four vendors on
  every `nimbus llm status` would be real un-ledgered egress before the user ever opted into
  sending a prompt; the accepted cost is a named fail-open, and a new `not_configured` reason
  keeps "add a key" distinguishable from "start the daemon" and "pull the model".
  **`LlmRouter.generate` now walks the priority order**, continuing past a TRANSPORT-class failure
  only — that is what makes the roadmap row's "with local fallback" true rather than claimed. An
  auth- or request-class failure does not retry, because it would fail identically at the next
  vendor and would only send the same prompt to a second destination. A consequence to expect
  rather than discover: **one prompt can now produce N ledger rows across N destinations**, which
  is correct and must not be deduplicated. **The Mastra engine agent** moved onto the same opt-in:
  it no longer reads `getEffectiveAgentModel()`, it is ledgered at the AI-SDK seam by
  `egress/mastra-model-egress.ts` (not over `LlmProvider`, which has no `tools` field and would
  silently kill tool-calling, the three negation tools included), and it is **not constructed at
  all** when no vendor is enabled — because `@mastra/core` resolves a vendor key from the
  environment on its own once an agent exists. **Net effect on I29:** the `model` class was wired
  but appended zero rows in production from 2a; it is now exercised, with **one exclusion left** —
  embeddings, which still append nothing. Two supporting changes worth knowing: vault-key
  construction for vendors lives in the new four-line `llm/vendor-vault-keys.ts` rather than
  allow-listing the 3,000-line `platform/assemble.ts` under D11, and `nimbus llm status`'s CLI-side
  route-status type is now pinned field-for-field to the gateway's by a structural parity test,
  closing a drift that had broken that command once with the whole suite green.

- **2026-08-28 — Every non-local model route now ledgers by construction; the `LlmRouter.generate()`
  hole recorded on 2026-08-27 is closed, and the Mastra air-gap bypass with it.** Slice 2a of the
  LLM model routes work; no cloud vendor is registered by it. Three things shipped.
  **(1) The `model`-class appender moved off the call site and onto the provider.**
  `egress/model-egress.ts`'s `wrapLedgeredProvider` is a decorator applied at
  `LlmRegistry.addRoute`, so a non-local provider appends one `egress_ledger` row BEFORE every
  `generate()` and an append failure aborts the call (`EgressAppendFailedError`, fail-closed). That
  covers `LlmRouter.generate()`, `generateMarkdown()` and every `selectProvider()` caller —
  `briefs/brief-llm-adapter.ts` among them, which resolved a provider and called it directly, so it
  was never covered before — without any of them cooperating. The previous appender
  (`egress/synthesis-egress.ts`'s `recordSynthesisEgress`) saw only the synthesis path and is
  **deleted**, along with the `SynthesisLlmDeps.recordEgress` DI seam and the
  `SynthesisEgressRecorder` type; there is now exactly ONE `model` appender in the tree. Locality is
  still derived INSIDE the appender from `provider.isLocal` — a local provider is returned
  UNCHANGED and appends nothing, not even a blocked row — so no caller can write a false zero into
  the ledger `nimbus prove` reports on. A new `LlmGenerateOptions.egressMethod` names the row (a
  synthesized brief still records `agents.<briefKind>.synthesis`) but cannot suppress one.
  **(2) Static rule D22(e)** confines `LlmRouter.registerRoute` to `llm/registry.ts` plus its own
  definition, so no future code can enter the route table unwrapped. The wrap deliberately sits at
  `addRoute` and NOT at `registerRoute`, because `refreshProviderMeta` re-registers an
  already-wrapped provider to update its meta and wrapping there would append twice per generate —
  a hazard now pinned by its own test rather than by a `__ledgered` marker, which was proposed and
  rejected (it would be read off the very provider whose egress is being recorded, so any provider
  could suppress its own row). **(3) Invariant I34** — locality is declared once per adapter, and a
  cloud adapter can never claim to be local. `isLocal` is the single field read by two independent
  defenses (air-gap refusal and the I29 appender), neither of which can detect the other's failure,
  so a wrong `true` is one word and silent in both directions. The wiring shipped in slice 1
  (`llm/base-url-locality.ts`); this adds the enforcement test and the docs row.
  **Also fixed, a live bug on `main`:** under `enforce_air_gap = true`, a local router that threw
  mid-turn fell through to the Mastra agent — which talks to a cloud vendor — with no air-gap check
  and no ledger row, because `engine/agent.ts` resolves its model through `@mastra/core`, outside
  the route table entirely. `enforce_air_gap` is a REFUSAL setting, so that fallback now rethrows
  instead (`engine/run-conversational-agent.ts`). **What did NOT ship, and remains named:** no cloud
  vendor — `packages/gateway/src/llm/` still registers only `OllamaProvider` and `LlamaCppProvider`,
  so every remote behaviour here is proven against a fake `isLocal: false` provider and the `model`
  class still appends zero rows in production until slice 2b lands one. Two exclusions keep `model`
  narrower than "all inference": **embeddings** append nothing (`PROSE_HEAVY_TYPES` routes to
  OpenAI's 1536-dim table with no appender), and the **Mastra engine agent** appends nothing —
  refused under air-gap as of this slice, but with air-gap off it is an open gap that 2b closes at
  the AI-SDK seam. `nimbus prove`'s `model` scope label widens accordingly, from
  "remotely-synthesized agent briefs" to "prompts sent to a non-local model route".

- **2026-08-27 — The router's unit becomes a `(provider, model)` route, not a provider kind, and
  ships zero cloud vendors.** `LlmRouter` used to key on a closed `LlmProviderKind` union
  (`"ollama" | "llamacpp" | "remote"`), so registering a second provider under an already-used kind
  silently evicted the first — "qwen3 for reasoning, gemma for classification" on one Ollama daemon
  was unrepresentable. It now keys on `routeId` (`"<providerId>/<modelName>"`), an open `ProviderId`
  vendor string, and a live per-route availability probe that checks the daemon **and** that the
  route's specific model is among what it reports — a shared daemon missing one of two configured
  models now fails only that route, not its sibling. `[llm.local.<name>]` config entries register N
  local routes at once; `[llm].route_priority` names an explicit try-first order. The migration
  shims this landed with — the `LlmProviderKind` alias and `LlmRouter.registerProvider` — are now
  deleted; every call site is on `registerRoute`/`addRoute`. **What did not ship:** no cloud vendor
  — `packages/gateway/src/llm/` still registers only `OllamaProvider` and `LlamaCppProvider` in
  production, so the open `ProviderId` string and the route-keyed registry are the precondition for
  a remote provider, not the provider itself, and the `[agents] synthesis = "allow-remote"` path and
  I29's `model` egress class remain reachable by exactly nothing. Two correctness fixes shipped
  alongside the key change, and they are NOT symmetric: the egress destination now names the vendor
  (`providerId`) instead of the literal string `"model"` — that gap is closed outright. The
  context-overflow fallback (`LlmRouter.generate()`, on context overflow, when the preferred route's
  prompt does not fit) was rewritten to walk routes in priority order instead of looking up a
  literal `"remote"` key that nothing ever registered under — but `generate()` still calls the
  resolved route's provider directly, with **no egress append and no `[agents] synthesis` check**.
  That is a narrower key with a **wider reachable blast radius**: before this slice the fallback was
  reachable in code but unreachable in practice (the `"remote"` slot was never filled); after it, any
  registered non-local route satisfies the key, so the day a remote route is registered this path
  goes live with no further code change. It is now a named, hard blocker on the next slice — a
  remote provider may not be registered in production until `LlmRouter.generate()` either gets I29
  `model`-class coverage or `docs/SECURITY-INVARIANTS.md` states precisely which calls it excludes,
  with the standard wiring + docs + test triple either way. Both fixes are **unit-proven only**: no
  remote route exists yet to exercise either one against a real outbound call, so "unit-tested" is
  the honest ceiling on this claim until a vendor lands. **A known bound, left open rather than
  silently closed:** `packages/cli`'s `nimbus llm status` keeps a hand-maintained private copy of
  the route-status type (`RouteStatus` in `packages/cli/src/commands/llm.ts`) — `packages/cli` has
  no source dependency on the gateway (IPC-only, per the dependency rules), so there is no shared
  type to import, and the CLI's own tests mock the IPC client wholesale rather than dispatching
  against a real handler. This already broke once in this branch: a caller kept reading
  `res.decisions.classification` after `llm.status` became a route list, and the whole suite stayed
  green. A gateway-side test now pins the exact `llm.status` payload shape (`llm-rpc.test.ts`), which
  catches a reshape on the gateway half; an end-to-end CLI-against-gateway test that would catch it
  on the CLI half too is out of scope for this slice.

- **2026-08-24 — What a standalone connector actually gives you, measured per client rather than
  assumed.** Off-gateway consent rests entirely on the MCP `elicitation` capability, and whether a
  client implements it had never been checked against a real client. It is now, and the answer is a
  split: **Claude Code** (form + URL mode) and **Cursor** (since v1.5) support it; **Claude Desktop
  does not**, so a connector there serves **reads only** and every write tool is withheld.
  Measured against `github` — 14 tools to a client with elicitation, 9 to Claude Desktop, with
  `github_pr_merge`, `github_branch_delete`, `github_issue_create`, `github_pr_close` and
  `github_tag_create` correctly absent. That is the designed fail-closed behaviour observed in a
  third-party client for the first time, and it is now a support table in the `nimbus-mcp` README
  instead of a surprise: "the write tools are missing" is otherwise a guaranteed bug report.
  **Also corrected a count that went stale the moment Part 2 landed:** the README still claimed
  "58 of 94 eligible … plus `github`", understating the migration by 36 connectors. It is **94 of
  94** (58 declare no mutating tools, 36 had their writes routed through the consent kit), and a
  drift test now derives all three numbers from the manifests, so the sentence cannot rot again.

- **2026-08-23 — Connectors that cannot run ungated, wherever they run.** A connector spawned
  outside the gateway has no executor and therefore no **I2** gate, which made "run a Nimbus
  connector standalone" a quiet downgrade from the project's central guarantee. Two PRs closed it.
  **#1318** added the consent kit (`mcp-connectors/shared/consent-kit.ts`): every mutating tool now
  passes scope → budget → consent → pre-state → mutate → audit, with consent obtained through MCP
  elicitation, a server-enforced write-scope allow-list the model cannot reach, a per-session
  mutation budget, and a SHA-256 hash-chained JSONL audit any client can verify. The process mode
  (`connector-mode.ts`) defaults to **standalone**, so the gated path is what you get unless the
  gateway says otherwise. **#1321** then routed all 94 connectors through it and gave each write a
  **per-connector** action type (`github.pr.merge`, not the generic `repo.pr.merge`), because
  `serviceOf()` takes the prefix before the first dot and that string becomes **I29**'s egress
  `destination` and **I20**'s delegation scope — "email" is not a place data can go, "gmail" is.
  The generic entries stay: removing one would silently ungate anything still emitting it.
  **A write tool registers only if the client advertises `elicitation`** — no consent mechanism, no
  tool, rather than a tool offered ungated. **The security tiering is deliberate and stated in
  `mcp-connectors/NOTICE`:** standalone gives consent, scope, budget and audit; the process
  sandbox (**I15**), OS-keychain credentials, the egress ledger and *owner-controlled* consent
  remain gateway-only, because standalone consent is mediated by a client that may be configured to
  answer automatically.

- **2026-08-23 — The machine becomes somewhere the agent can work, starting with the owner.**
  `nimbus exec` runs code inside the three-OS sandbox that shipped in #1294, behind an approval
  prompt showing the **verbatim body** — never a digest, because the human is the entire security
  boundary here and "run script sha256:a1b2…" is a rubber stamp with extra steps. First delivery in
  Spine S2. Invariant **I33**, static rule **D23**, no schema change.
  **The order inside `exec/exec-gate.ts` is the invariant, not an implementation detail:** every
  refusal decidable *without* the owner — the default-off `[code_execution]` kill-switch, the
  `[policy.capabilities.ai_v2]` org lockoff, runtime resolution from a registry rather than a caller
  argv, absolute-path validation — happens before the prompt, so a disabled capability never
  advertises its own existence by prompting; and the sandbox posture is asserted before consent, so
  the owner is never asked to approve something that could not have been confined. The script is
  read **once**: re-reading at spawn would mean approving body X while body Y runs.
  **"No network" includes loopback, and that is the point.** The interesting target is not the
  internet but the Gateway's own IPC socket and `127.0.0.1` HTTP API. That holds via three unrelated
  mechanisms — Linux `--unshare-net`, macOS `deny default` with no allow block emitted, Windows
  AppContainer without `internetClient` — which is the most fragile way for a security property to
  be true, so it now has a per-platform test asserting a script cannot reach the Gateway's own port.
  The whole `exec` IPC namespace is LAN-forbidden, not merely `exec.run`: admitting
  `exec.approvalRespond` would let a paired peer *approve* code running on the owner's machine.
  **Two defects that only a real Linux sandbox could surface, both fixed here.** The gate first asked
  `isFullyActive()` — a policy-independent question that on Linux reports a helper existing *solely*
  for per-host network filtering. Since this slice grants no network, and `install-sandbox-deps.sh`
  installs bubblewrap but not that helper, the capability was unusable on every Linux machine
  including CI, gated on a dependency it never uses; `SandboxRunner` now answers
  `canConfine(policy)`, keeping the per-platform reasoning in the PAL. And the connector-tuned
  seccomp filter omitted `ftruncate`, so `fs.writeFileSync` and `Bun.write` were SIGSYS-killed with
  no stderr at all — the sandbox permitting a write that then died silently, making
  `--allow-fs-write` nearly useless for idiomatic code.
  **Deliberately not shipped**, so the row is not misread: the agent-callable path (the LLM cannot
  trigger an execution — that bound is what makes one human approval sufficient), `--allow-net`,
  `nimbus exec --interactive`, Deno/Python runtimes, and remote sandbox adapters. `wrapToolOutput`
  (**I11**) is correspondingly not exercised, and `exec` appends no `egress_ledger` row — true by
  construction, since no network is grantable, rather than by an appender someone forgot.

- **2026-08-21 — A web clip can finally say who wrote it.**
  `POST /v1/clips` gains one optional `source` object — `author`, `publishedAt` (epoch ms),
  `siteName`, `lang`, `leadImage` — which lands at `metadata.source`. Until now a clip was the
  one item type in the index that arrived without provenance: `validateClipInput` read exactly
  seven fields and dropped the rest, so the `byline`, `siteName`, `publishedTime` and `lang`
  Mozilla Readability already parses had nowhere on the wire to go. Every field is optional and
  every field is bounded, because all of them are controlled by whatever page the user is looking
  at and `upsertIndexedItem` throws above 64 KB of serialised metadata. **Three choices here are
  deliberate and unlike the rest of this body.** A malformed *member* is **dropped, not rejected**
  — `asString` throws because a clip without a title is not a clip, but a clip with a garbled
  byline is still a perfectly good clip, and failing it would let one bad `<meta>` tag cost the
  user their capture; a `source` that is not a JSON object is still a validation error, because
  that is caller error rather than page noise. Prose **truncates** and structured values **drop**:
  `author` and `siteName` are cut to 200 characters and are still useful, while an over-length
  `lang` (20) or `leadImage` (2048) is discarded, since half a URL is a broken link rather than a
  shorter one and a consumer cannot tell it was cut. And the validator **constructs** a new object
  from the five known fields rather than passing the caller's through — a whitelist, not a
  blocklist, because a single unrecognised sibling key, large enough to cross the store's 64 KB
  ceiling, would let a page deny ingestion of its own clip. `publishedAt` is normalised to
  epoch ms by the client and checked here only for "an integer inside `Date`'s range"; pre-1970
  and far-future values are valid and kept, because archived essays and embargoed posts carry them
  honestly and nothing sorts on this field. Clip identity, `modified_at` and `author_id` are
  unchanged and now pinned by tests: `externalIdFor` still hashes only the canonical URL (and the
  body, for selections), so re-clipping a page whose byline changed is an `updated` on the same
  id; `modified_at` still comes from `capturedAt`; and `author_id` stays null, since a byline
  string is not an identity claim. One inherited behaviour is worth knowing rather than
  discovering: a re-clip that sends no `source` **clears** a stored one, because
  `upsertIndexedItem` replaces metadata wholesale — exactly as `tags` already behave.
  Design: [clip source metadata](./superpowers/specs/2026-08-20-clip-source-metadata-design.md).
- **2026-08-21 — The Windows extension sandbox is real: an unprivileged native helper replaces
  the permanently-throwing stub.** `nimbus-sandbox-helper.exe` — AppContainer profile
  creation/derivation, per-spawn ACL grants (leaf `--cwd` plus explicit policy
  `--grant-read`/`--grant-write` paths only, never any ancestor), the `internetClient` capability
  SID when `permissions.network` is non-empty, a Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so a crashed helper can't orphan the child, and
  `CreateProcessW` — replaces the fail-closed "unavailable" stub `win32.ts` shipped with before
  this branch. The startup probe (`--check-caps`) still refuses to spawn unconfined when the
  helper is missing or fails, so the fail-closed posture carries over unchanged, now conditional
  on a measured fact instead of permanent. An orphan reaper runs at Gateway boot, deleting stale
  `nimbus-ext-*` AppContainer profiles left behind by a prior crash (I15). Windows network policy
  stays all-or-nothing (per-host filtering would need WFP callout drivers — kernel-mode signing,
  Windows hardware program enrollment — tracked as a follow-up, not FFI, which was never built and
  isn't the design); Linux/macOS keep per-host + per-port enforcement. Full contract, the ACL-grant
  rationale, and the exit-code table: `packages/gateway/src-native/sandbox-helper-win32/README.md`
  and [`docs/sandbox.md`](./sandbox.md#windows-platform-status). One measured, load-bearing
  limitation carries into production: a `bun <script>` child cannot start when its working
  directory is nested inside the user profile (`CouldntReadCurrentDirectory` at Bun's own
  startup, not a sandbox failure — a plain Win32 binary at the identical path with identical
  grants runs fine) — moot for a packaged install, which spawns the compiled
  `nimbus-gateway.exe __nimbus-connector <id>` with no script path, but visible to a Windows
  contributor running a dev tree. The zip installer (`install.ps1`) now copies the helper into
  the install directory as a **required** artifact (a missing helper aborts the install rather
  than producing one that silently refuses every connector spawn) — mirroring the MSI installer,
  which already carried it as a required payload.

- **2026-08-21 — Listed in the official MCP Registry, and the listing now maintains itself.**
  `io.github.nimbus-agent/nimbus@0.2.0` is live at
  [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io), pointing at
  `npm:@nimbus-dev/mcp@0.2.0` — the last blocker in
  [the distribution program](./superpowers/specs/2026-08-19-nimbus-distribution-program-design.md),
  which had carried it as "blocked — needs a packaging decision" since 2026-08-19. Any MCP client
  can now discover and run the local index and the fourteen agents via `npx -y @nimbus-dev/mcp`.
  The satellite's `release.yml` gained a third job that republishes the registry entry from CI on
  every release via `mcp-publisher login github-oidc`, with `server.json`'s two version fields
  driven by release-please `extra-files` and **asserted** against the version npm accepted rather
  than rewritten — a rewrite would mask a broken config and ship an entry pointing at a version
  nobody can install. It is a job inside the existing release workflow rather than the
  tag-triggered workflow the registry's own docs suggest, because that shape races: release-please
  pushes the tag BEFORE the npm publish job runs, and the registry entry is metadata pointing at
  the package. **Two things worth knowing before anyone repeats this.** Interactive org-namespace
  publishing requires a `read:org` PAT — the registry's login app is a PRIVATE GitHub App, so it
  cannot be installed on the org and a device-flow token can never read the org role; the CLI's
  error text ("make your organization membership public") points at the wrong requirement
  entirely. And `@nimbus-dev/mcp@0.1.0` carries **no provenance**: npm will not configure a trusted
  publisher until a package has one published version, so the bootstrap had to be hand-published.
  Both are recorded in the satellite's `SECURITY.md` and its `nimbus-mcp-boundaries` skill rather
  than left for rediscovery.

- **2026-08-20 — First-class negation queries (W6-B.2): the three B.1 predicates reachable by a
  model, closing Wave 6.** `findPrsNotTouching(pathGlob, service?, limit?)`,
  `findDeploymentsWithoutIncident(service?, limit?)`, and `findPeopleWithoutReviews(sinceDays?,
  limit?)` — the same three predicates B.1 shipped as CLI flags — now exist as named tools under
  the same names on **two surfaces**: the gateway engine (`engine/agent.ts`, reached by `nimbus
  ask` and, because they share the engine, the desktop app and the VS Code extension), and the MCP
  server (`INDEX_TOOL_SPECS` in `packages/cli/src/mcp/adapter.ts`, reached by any external MCP
  client — `TOOL_SPECS` moves from 18 to 21). One tool per predicate, not a `predicate` enum: each
  carries its own substrate story in its own description, and type scope is now intrinsic
  (`findPrsNotTouching` hardcodes `types: ["pr"]`) rather than a caller-suppliable parameter that
  could be omitted or set wrong. The orchestration sequence B.1 left inside the two IPC handlers —
  probe the substrate, refuse if empty, build the predicate, compose, run, count exclusions — is
  now extracted once into `index/negation-query.ts` and shared by all three consumers (the two RPC
  handlers keep their own wire-contract tests; the extracted module gets its own for the sequence).

  **The guarantee this delivery provides is UNEQUAL across the two surfaces, and stating that
  precisely is the point of shipping both in one delivery rather than describing them as the same
  feature.** Refusals are structural on **both**: a refusing tool returns *only* the refusal — no
  rows sit alongside it — so there is nothing for a model on either surface to present instead.
  But **exclusion counts are guaranteed only on the engine surface.** A new
  `engine/negation-disclosure.ts` owns one definition per disclosure sentence; a negation tool that
  refused or excluded rows pushes its sentence onto a lazily-created array on the per-request
  `AsyncLocalStorage` store (`agentRequestContext`, built at all three
  `ipc/server/inline-handlers.ts` sites that need it: `agent.invoke`, `workflow.run`,
  `engine.askStream`), and `runConversationalAgent` **drains** that array — read-and-clear, so a
  reused store within one dispatch frame cannot re-emit a disclosure already shown — and appends
  the sentences to the reply at the single site both the local-router and Mastra-agent paths
  return through. The streamed answer and the returned answer are byte-identical: the same text is
  also emitted through `sendChunk` before the streaming handler returns, closing the exact
  two-dispatcher trap that made `--devil` inert on the UI path (A1, 2026-08-18) before it was
  caught. A turn where nothing fired is unchanged byte-for-byte. An external MCP client never
  reaches any of this — it calls `tools/call`, gets JSON back, and what its model does with that
  JSON (report the rows, drop "12 excluded") is beyond the gateway's reach: no system prompt, no
  persona, no append hook exists on that path, and `@nimbus-dev/mcp` cannot close the gap either,
  since the launcher execs `nimbus mcp-server --stdio` with `stdio: "inherit"` — a pure exec, not a
  proxy that could inject anything into the wire. So "negation in ask and MCP" is not one
  guarantee: `nimbus ask` (and the desktop/VS Code surfaces sharing its engine) cannot lose an
  exclusion count to a paraphrase; an MCP client can.

  **What the disclosure append proves, and what it deliberately does not.** The design flagged a
  real risk that the per-request `AsyncLocalStorage` store might not survive Mastra's internal
  tool-call scheduling — a failure mode that would look identical to a turn with nothing to
  disclose, since `getStore()` would return `undefined` and nothing would push, drain, or warn.
  What was probed, against a real `@mastra/core` `Agent` (not a hand-built fake): a
  `createTool`-registered probe tool retrieved through the Agent's own `listTools()` accessor, with
  its `execute` then invoked directly inside an `agentRequestContext.run()` scope — proving the
  store survives being *retrieved through* a real Agent. What that does **not** prove is Mastra's
  own scheduling *between* the model's tool-call decision and its `execute` call actually landing
  inside that same async context — the design's own § 5.1.1 names that gap as unprovable in CI,
  because it would require a real model call. That gap is why every negation tool also embeds its
  disclosure sentence in its own returned payload — the MCP-level guarantee — regardless of whether
  the store round-trip holds on a given turn. As a further fail-safe, `recordNegationDisclosure`
  logs a warning on the rare
  path where no store is present, so the guarantee degrades visibly rather than silently.

  **A model can still ignore the tool descriptions, and this delivery does not close that.**
  `searchLocalIndex`'s description now says it ranks and returns matches, cannot answer which items
  do *not* match, and names the three negation tools as the right ones for that question — but
  steering is by description only. There is deliberately no detector: classifying a user's
  free-text question as "a negation" is a guess about natural language, and a false positive would
  attach a scary caveat to a correct answer. A model can call `searchLocalIndex` for a negation
  question anyway and produce a fluent wrong answer with no disclosure attached, because no
  negation tool ran and nothing was recorded. That residual is a known open bound, not something
  this delivery closes.

  **The local-router path has no tools at all, so "negation in `nimbus ask`" does not hold there.**
  When `[llm].prefer_local = true` (the documented Ollama setup), a turn goes through
  `runViaLocalRouter`, which calls the router's `generate()` — and no router under
  `packages/gateway/src/llm/` has tool-calling support of any kind. Not the three new negation
  tools, and not `searchLocalIndex` either. This is pre-existing behaviour B.2 neither causes nor
  fixes, so the claim is bounded precisely: negation in `nimbus ask` holds for turns answered by
  the Mastra agent; a `prefer_local = true` user reaches these predicates only through `nimbus
  query` / `nimbus people list` (B.1) or an MCP client. This project has twice shipped a capability
  that was inert on a real path and believed to work — A0's synthesis seam, which had never once
  run in production, and A1's devil mode, inert on the UI dispatcher — both found by measuring
  rather than reasoning; this bound is recorded before it could join them.

  **Scope boundary.** No schema migration — all three predicates read tables and edges B.1 already
  populates. No new IPC method — the tools reuse `index.queryItems` / `people.list`, exactly as
  B.1's handlers did. No new HTTP route. No new invariant. `ALLOWED_METHODS` stays at **105**
  (unchanged; no Tauri allowlist work needed). No `egress_ledger` row on either surface: engine
  tools read local SQLite and never reach `connectors.dispatch`, and `engine.ask` is not an
  `agents.*` brief method, so the agent-brief append path never considers it; MCP *index* tools
  have never been ledgered — only `AGENT_CLASSIFIED_TOOL_SPECS`, which serve gateway-synthesised
  briefs, are — and the three new tools serve index rows, so they join `INDEX_TOOL_SPECS` and
  append nothing, exactly like the six index tools already there. Closes both W6-B rows (Remaining
  in S1, and the Phase 7 Wave 6 row) — Wave 6 is now complete. Design:
  [`docs/superpowers/specs/2026-08-20-negation-in-ask-design.md`](./superpowers/specs/2026-08-20-negation-in-ask-design.md).

- **2026-08-20 — `@nimbus-dev/mcp` extracted to its own repo and published to npm.**
  `packages/mcp-launcher` moved to
  [nimbus-agent/nimbus-mcp](https://github.com/nimbus-agent/nimbus-mcp) and now publishes via
  release-please + OIDC trusted publishing, matching `@nimbus-dev/sdk` and `@nimbus-dev/client`
  — no `NPM_TOKEN` anywhere, and `0.2.0` carries both the npm publish attestation and a SLSA
  provenance predicate (independently verified with `npm audit signatures`). This unblocks the
  official MCP Registry listing, which was the point: any MCP client can now reach the local index
  and the fourteen agents through `npx -y @nimbus-dev/mcp`. Branch B of
  [`docs/superpowers/specs/2026-08-19-mcp-launcher-publish-route.md`](./superpowers/specs/2026-08-19-mcp-launcher-publish-route.md);
  the executed plan and the verified publish precedent are
  [`docs/superpowers/plans/2026-08-20-mcp-launcher-satellite-extraction.md`](./superpowers/plans/2026-08-20-mcp-launcher-satellite-extraction.md)
  and
  [`docs/superpowers/specs/2026-08-20-satellite-publish-precedent.md`](./superpowers/specs/2026-08-20-satellite-publish-precedent.md).
  **`0.1.0` is the one exception to the provenance claim** and is documented as such in the
  satellite's `SECURITY.md`: npm refuses to configure a trusted publisher until a package has at
  least one published version, so it had to be published by hand and carries no attestation.
  The installer-directory drift guard the launcher used to carry as a text read of
  `scripts/install/lib/paths.ts` is replaced by vendored constants there plus
  `scripts/structure-audit/check-launcher-installer-contract.ts` here, run by
  `install-smoke.yml` at PR time and `org-drift-sweep.yml` on a schedule — the two directions
  catch different changes and neither subsumes the other.

- **2026-08-20 — First-class negation queries (W6-B.1): three named predicates that refuse rather
  than answer from an unpopulated index.** The last open Wave 6 answer-quality row, shipped as
  three flags on the two commands whose row shape each already matches — no predicate language, no
  `--negate`, no composition:

  ```bash
  nimbus query --service github --type pr         --not-touching 'tests/**'
  nimbus query --service github --type deployment --no-downstream-incident
  nimbus people list --not-reviewed --since 7d
  ```

  **Both parts of that syntax that look optional are not.** `--service` is required on the first
  two — existing `runQuery` behaviour, not a choice this delivery makes — and the `list` on the
  third is a subcommand, since `runPeople` dispatches `args[0]`, so `nimbus people --not-reviewed`
  exits with "Unknown people subcommand". Two spec examples shipped in the design doc missing
  exactly those two tokens, which is why the first thing built was a test
  (`packages/cli/src/commands/negation-examples.test.ts`) that drives every documented example through the
  real argument parsers: a doc example that cannot run now fails CI instead of waiting to be
  noticed.

  **Why a negation is not a filter with a NOT in it — the constraint the whole design is shaped
  around.** For a positive query a missing row costs a result. For a negation a missing row
  *produces* one: a PR whose file list was never fetched satisfies "no row matching that path"
  exactly as well as a PR that genuinely never touched it, and the two are indistinguishable at
  the SQL level. An unpopulated substrate therefore does not make a negation incomplete, it makes
  it **wrong**, and wrong in the direction that reads as a finding — the emptier the index, the
  MORE rows come back. Four bounds follow, and all four are enforced rather than documented:

  1. **An empty substrate REFUSES.** Each predicate probes its own substrate before answering —
     any `pr_files_state` row; any `correlates_with` edge; any `reviewed` edge **within the
     query's own `--since` window**, not an all-time count, because edges that are all older than
     the window are the exact state where "nobody reviewed" and "nothing synced" are
     indistinguishable. A failed probe returns a `{ status: "refused", reason:
     "missing_substrate", message, remediation }` document and exit code `1`: the human message
     goes to **stderr** so it cannot be piped in as rows, the `--json` document goes to **stdout**
     so a script can parse it. A caller asking "which deploys were clean?" must be able to tell
     **refused** from **none matched** — those are opposite answers, and a non-zero exit alone
     does not separate a refusal from a crash.
  2. **All three predicates exclude and count unverifiable rows; only the SHAPE differs.**
     `--not-touching` excludes PRs with no coverage row and PRs whose coverage was truncated, and
     reports the two SEPARATELY — never-fetched and fetched-incompletely mean different things to
     a reader deciding whether to trust the answer. The other two reach their edges through an
     inner join to `graph_entity`, so an item or person with no entity of the required type is
     excluded and counted as `excludedNoGraphEntity`. Dropping those rows is the fail-closed
     direction and stays; dropping them *uncounted* was the real defect, and it was reachable —
     `syncGraphFromIndexedItem` returns without writing below `user_version < 7`, which is why
     `regraphAllItems` exists. The gap line prints on **every** negation query, `--explain` or
     not: exclusion accounting is part of the answer, not debug output, because a short result set
     with no explanation is precisely the false finding this feature exists to prevent. (The
     implementation plan predicted per-row partial state for `--not-touching` only; building it
     disproved that, and the correction is recorded in the design doc § 4.4 rather than quietly
     dropped.)
  3. **The correlation window is fixed at two hours and no flag can widen it.**
     `--no-downstream-incident` reads `correlates_with` edges that `graph/graph-populator.ts`
     writes under a fixed `CORRELATION_WINDOW_MS`, applied at WRITE time;
     `graph_relation.created_at` is the write timestamp, not the event time, so a query-time
     window cannot be reconstructed even in principle. A `--within 24h` flag would advertise a
     control that does not exist, so there is none — the output names the window instead, and
     DERIVES the printed number from the constant (pinned by a test that imports the real gateway
     value) rather than restating "2h" in prose that can drift.
  4. **Subject-type scoping is mandatory, and checked before any IPC call.** `--not-touching`
     requires `--type pr`, `--no-downstream-incident` requires `--type deployment`; a conflicting
     or absent `--type` errors rather than silently re-scoping. Unscoped, `--not-touching
     'tests/**'` would return every issue, message and commit — all of which trivially "do not
     touch tests/" because they cannot touch anything — a flood of confident false positives
     emitted by the feature built to prevent them. The guard checks whether the flag was
     SUPPLIED, not what it parsed to, so `--not-touching ''` trips it too.

  **`--explain`** adds the composed SQL, its bound parameters, and the substrate probe with its
  result — the only way to see WHY a query refused, or to confirm a non-empty answer rested on
  real data. It works on ANY `nimbus query` / `nimbus people list` invocation, not only negation
  ones, since the SQL is built on every call anyway. The SQL it prints is the COMPOSED statement
  that actually shaped the result, never the bare predicate subquery, which omits `unlinkedOnly`
  and the `LIMIT` and would answer a wider question if pasted back into sqlite3. Under `--json`
  the explain block is a FIELD in the document and a refusal document is printed ALONE — either
  one printed loose alongside the rows would make the output unparseable. One thing `--json`
  deliberately does not do is claim a match total: `meta.total` is the size of the returned batch,
  bounded by `--limit`, so the human output prints it with that caveat attached rather than as
  "N matched".

  **Delivered as fields on existing methods, not new ones.** `index.queryItems` and `people.list`
  gain optional `notTouching` / `noDownstreamIncident` / `notReviewed` / `sinceMs` / `explain`
  request params and sibling `gaps` / `explain` response keys; `people.list` keeps returning a
  BARE ARRAY on a plain call, byte-for-byte as before, so no existing caller breaks. **A supplied
  flag never degrades into an omitted one**, at either layer: a present-but-unusable param is
  rejected with `-32602` rather than treated as absent; a glob is trimmed before use, since
  `" tests/**"` is a valid GLOB matching no path and would hand back every covered PR as "not
  touching"; the two `query` predicates cannot be supplied together (they do not compose, and
  answering one silently would drop the other); and the CLI rejects `--not-touching` with a
  missing, blank, or option-token value (`--not-touching --json` sends `"--json"` as the glob)
  and `--since` with no duration, none of which the gateway can distinguish from a caller who
  never asked. `people.list` also reports the CLAMPED limit in `meta`, so a caller comparing
  `meta.total` against `meta.limit` to detect truncation cannot read a truncated answer as
  complete. No schema migration
  (V55's PR changed-file index, #1258, is the substrate for the first predicate; the other two
  read graph edges that already exist), no new IPC method, no new HTTP route, no new invariant,
  `ALLOWED_METHODS` stays at **105**, and no `egress_ledger` row is appended — all three
  predicates are local SQLite reads with no connector dispatch and no remote model call.

  **Scope boundary — what this delivery does NOT do.** **B.2, exposing these predicates to
  `nimbus ask`, is not in it.** That is a genuinely different problem (tool specs, which surface,
  prompt wiring, and the failure mode where the model picks the wrong predicate and the answer
  still reads authoritative) and gets its own spec; B.1 is its precondition either way, since
  there was nothing to expose until the predicates and their fail-closed semantics existed. Also
  out: any grammar, `--negate`, or composing two predicates in one query; and cross-service
  negation, which would mean relaxing the existing `--service` requirement for every `query`
  invocation. The aggregation half of W6-B shipped 2026-08-19 as `nimbus stats`, so the negation
  half closes here and the W6-B row stays open on B.2 alone.

- **2026-08-19 — `agents.why` answers a pull-request URL with no local checkout, and
  `agents.impact` moves onto the same resolver — fixing a live GitLab/self-hosted defect.**
  `agents.why` gains a second entry point, `{ prUrl }`, alongside `{ ref }`: `nimbus why
  <pull-request-url>` (and the browser extension) now gets a brief for a PR with no indexed
  filesystem root and no git checkout at all — the browser-viable half of why-lens. Four of the
  six lanes (pull request, ticket, discussion, driver) answer unchanged; authorship and
  downstream stay silent, since both are file/line lanes by nature and a `prUrl` question never
  had one to begin with. The subject line says so in one sentence — *"Asked about a change:
  authorship needs a line (`nimbus why <file>:<line>`), and downstream impact is `nimbus impact
  <url>`"* — because the browser extension renders that text verbatim; it is the whole
  explanation a user gets for why two lanes are missing.

  The resolver behind the new arm, `resolvePrSubject` (`agents/_lib/pr-subject.ts`), is
  DELIBERATELY PARSE-FREE: it asks the index (`resolveItemByUrl`'s canonical-url ladder) instead
  of reconstructing a `pr` entity's identity from a regex over the URL. `agents.impact`'s old
  `PR_URL_RE` / `HOST_TO_SERVICE` did exactly that reconstruction and failed three independent
  ways — GitHub-shaped regex, a hostname-guessed service (so every self-hosted instance missed),
  and GitLab merge requests keyed with a BANG (`gitlabMrExternalId`), not a hash — none of which
  a better pattern could fix, because the pattern was the mistake. `agents.impact`'s
  `resolveStartEntity` now calls the same `resolvePrSubject`, so a self-hosted GitHub/GitLab/
  Bitbucket PR resolves through one shared, forge-agnostic path instead of two divergent
  parsers.

  A second fix closes a gap the new arm itself opened: the change-arm disclosure sentence above
  lives in the brief PREAMBLE, which `brief-contract.ts`'s synthesis guard left unregistered for
  `why` — so with `ctx.runner` set, an LLM rewrite of the brief could silently drop it, leaving a
  brief two lanes shorter with no explanation. That is the exact bug class invariant **I31**
  closed for `negotiate`/`glossary` two commits before this branch's base; the sentence is now a
  `brief-disclosures.ts` `Disclosure` (anchored on "authorship needs a line", not the whole
  sentence) required by `requiredPhrases` whenever `changeSubject` resolves, following the same
  conditional-emit/conditional-require pairing `negotiate` and `glossary` already use. Along the
  way, the miss-path sentence for an unresolvable PR URL was reworded off "is not in your index"
  — false when the URL resolves to an indexed item that just isn't a pull request — to "did not
  resolve to a pull request in your index", honest for every miss reason `WhyBrief` collapses
  into that one `null`.
- **2026-08-19 — PR changed-file indexing (schema V55): the data and the fail-closed primitive for
  negation queries, not the queries themselves.** Adds two tables, both keyed on `item.id` with
  `REFERENCES item(id) ON DELETE CASCADE` and both `WITHOUT ROWID`: `pr_changed_file` stores one
  row per touched path (a rename writes TWO rows — old path and new — a deletion writes ONE;
  `status` is descriptive only, membership decides every predicate) and `local_file_id` (
  `REFERENCES graph_entity(id) ON DELETE SET NULL`) linking to the ownership graph;
  `pr_files_state` records per-PR fetch coverage (`fetched_at_ms`, `api_file_count`,
  `stored_count`, `truncated`). Three forge mappers land the payload shape into that row set —
  `mapGithubPrFiles` (`pulls/{n}/files`), `mapGitlabMrFiles` (MR diffs), `mapBitbucketPrFiles`
  (diffstat) — feeding a shared bounded per-tick driver, `runPrFilePass`
  (`prfiles/pr-file-fetch.ts`), wired into all three syncs (`MAX_PRS_PER_TICK = 10`,
  `MAX_PAGES_PER_PR = 3` at `PR_FILES_PAGE_SIZE = 100`, `MAX_FILES_PER_PR = 300` — a PR beyond the
  cap is stored AND flagged `truncated`). `nimbus status` gains a
  `PR file coverage: <covered> / <totalPrs> (<N> truncated)` line, its truncated suffix present
  only when truncated PRs exist, and the whole line omitted when no PRs are indexed at all. No new
  IPC method — `ALLOWED_METHODS` stays at 105.
  **Three things a reader must not assume:**
  (1) **No predicate language ships here.** There is no `--negate`, `--touches`, or `--explain` —
  those belong to W6-B. This delivery ships `selectPrsNotTouching`
  (`prfiles/pr-changed-file-store.ts`), the canonical fail-closed negation query, as a primitive
  for W6-B to call, not a CLI surface of its own.
  (2) **A PR is excluded from a negation result for TWO independent reasons, not one**: it has no
  `pr_files_state` row at all, OR its row has `truncated = 1`. Knowing only the first risks
  misreading a truncated PR — one that WAS fetched, just not completely — as covered. The query
  enforces both fail-closed, by two independent mechanisms: the `JOIN` to `pr_files_state` (an
  uncovered PR has no row to join), and `s.truncated = 0` in the `WHERE` clause (on an uncovered
  PR that column is `NULL`, and `NULL = 0` evaluates to `NULL`, which `WHERE` treats as not-true —
  so the row is excluded by BOTH mechanisms at once, not just the join). Softening either one
  alone — swapping the `JOIN` for a `LEFT JOIN`, or comparing with `COALESCE(s.truncated, 0) = 0`
  — does not by itself reintroduce the bug; it takes losing both at once, or dropping the coverage
  join entirely and reading `pr_changed_file` alone.
  (3) **`local_file_id` ships unpopulated.** The column, its foreign key, and its
  `ON DELETE SET NULL` behaviour all exist, but nothing writes it yet — the spec assigns that to
  the ownership pass, deliberately deferred because nothing in this delivery reads it (negation
  matches on `path` alone). A `NULL` here means "not yet linked," never "no local file exists."
  **Coverage grows over many sync ticks — it is not complete after one sync.** The pass records at
  most 10 PRs per tick per service, so a freshly-connected large repo will show a low
  `covered / totalPrs` ratio for a while; that is the bounded design working as intended, not a
  fault. It ATTEMPTS up to `MAX_PRS_PER_TICK * PR_ATTEMPT_BUDGET_MULTIPLIER` (30) candidates to
  record those 10: a failed PR is deliberately left with no coverage row, and selection is strictly
  newest-first, so without that gap a handful of permanently-404ing PRs at the head — a repo
  deleted or made private — would refill the whole budget every tick and pin coverage at zero. The
  cost is a bounded number of wasted requests per tick while a head stays broken. — S1 "Local
  Brain", the W6-B negation-query prerequisite.

- **2026-08-19 — Graph-entity metadata namespacing (schema V54): fixes a live bug where
  `nimbus owners` silently alternated between its real output and an "owner breakdown not
  recorded" line.** `graph_entity.metadata` was last-writer-wins — `upsertGraphEntity`'s
  `ON CONFLICT … DO UPDATE SET metadata = excluded.metadata` replaced the whole column with
  whoever wrote last. `ownership/ownership-pass.ts` writes owner counts
  (`ownerCountsMetadata(...)`) as `metadata` on `source_file`, `directory` and `service` —
  those three only; its `person`, `workspace` and `repo` writes carry no counts.
  `graph/graph-populator.ts` writes the **same** `source_file` entity — a byte-identical
  `file:<repoRoot>:<path>` external id, a convergence that is deliberate — with no metadata.
  Every `syncCodeSymbolGraph` run therefore NULLed the counts the ownership pass had just
  written, and every ownership pass restored them, alternating forever depending on which pass
  ran last. `ownership-store.ts`'s `parseCounts` read the absence, and
  `agents/_lib/render.ts`'s `renderOwnershipCounts` hit its own null-guard and emitted
  *"(owner breakdown not recorded for this path — run `nimbus owners --refresh`)"*. So
  `nimbus owners` rendered a real "N of M contributor(s) clear the share floor" line half the
  time and that line the other half — no error, no gap note, nothing that would surface the
  clobber as a defect. (The same "not recorded" wording is reused by a **different** branch, in
  `renderOwnershipTarget`, for rows predating the ownerCount/ownersAboveFloor split; earlier
  drafts of this entry attributed the alternation to that legacy-row branch. It is not the
  branch taken.)

  Fixed by namespacing `graph_entity.metadata` as a map keyed by writer
  (`EntityMetadataWriter = "ownership" | "symbols"`, a closed union) for six entity types:
  `source_file`, `directory`, `person`, `service`, `workspace`, `repo`. The set is **chosen,
  not derived**, with three different justifications, spelled out per type at
  `CO_OWNED_ENTITY_TYPES`: `source_file`, `person`, `workspace` and `repo` are written by both
  files under converging external ids; `directory` has no second writer at all
  (`graph-populator.ts` never writes one) and is namespaced for uniformity; `service` is
  written by both files but under **disjoint** id spaces (`service:<id>` versus
  `<service>:<project>` / `openapi:service:<name>`), so `ON CONFLICT` cannot fire between them
  today — it is namespaced defensively, and nothing here calls it a proven collision. Only
  `source_file` has a proven, user-visible failure; the others carry no metadata from either
  side yet, so the fix is real for them the moment either side starts recording something.
  The new `upsertGraphEntityNamespaced` merges a writer's own namespace via two sequential
  `json_patch` calls — a `null` patch that deletes the writer's existing namespace key, then a
  set patch that inserts the new value fresh — rather than a single recursive `json_patch`,
  which would have let a stale field the writer meant to drop leak forward forever
  (`json_patch` is RFC 7396 merge patch, and merge patch recurses; it does not replace at the
  top level the way an earlier draft of this design assumed). `readEntityMetadata` reads back
  one writer's namespace and does **not** fall back to treating flat metadata as the
  `ownership` namespace — a flat write landing on a co-owned type, or a skipped migration,
  must stay visible as `null` rather than render as valid data. The V54 migration wraps
  existing rows on those six types as `{"ownership": <existing value>}`, idempotently, and
  only where the value is non-null, `json_valid`, `json_type(...) = 'object'` and not already
  namespaced — a malformed or scalar value is left exactly as it is, not wrapped. Both writers
  converted: `ownership-pass.ts` writes `writer: "ownership"` at all eight of its co-owned
  sites, three of which carry owner counts and five of which pass `metadata: {}`;
  `graph-populator.ts` writes `writer: "symbols"` at all thirteen of its co-owned sites
  (`source_file`, `person`, `service`, `workspace`, `repo` — it never writes `directory`),
  every one of them passing `metadata: {}`, including the `source_file` bug site itself, since
  it has no symbol-level facts to record on any of them. `metadata: {}` clears that writer's
  own `"symbols"` namespace to `{}` while leaving `"ownership"`'s counts untouched, which is
  not the same thing as a no-op. A compile-time guard (`NonCoOwnedType<T>`, narrowing
  `upsertGraphEntity`'s `type` parameter for a literal argument) and an independent static
  audit rule in `scripts/structure-audit/check-nimbus-invariants.ts` both reject a flat
  `upsertGraphEntity` call on a co-owned type, so the flat overwrite that caused this bug
  cannot silently return. Both layers have the same two stated bounds: the audit exempts
  `.test.ts` files (fixture-only writes keep the flat call by design) and, like the compiler
  guard, resolves **literals only** — `type: someVariable` evades both, and neither claims
  otherwise.

  **Visible change worth recording:** `person`, `service`, `source_file`, `workspace` and
  `repo` rows whose `metadata` was previously `NULL` now store `{"symbols":{}}` once
  `graph-populator.ts` touches them. That is inert for every reader — `readEntityMetadata`
  returns `{}` rather than `null` for the `symbols` writer and `null` for `ownership` either
  way — but the column is surfaced to the LLM through `traverseGraph`, so the value is
  observable.

  **`service` and `label` clobbering is out of scope, by decision, not oversight.** Both
  columns are written unconditionally by the same `ON CONFLICT` statement — in
  `upsertGraphEntityNamespaced` exactly as in the flat `upsertGraphEntity`; only `metadata` is
  namespaced. `label` is written identically by both writers, so there is nothing to lose.
  `service` genuinely is clobbered, but `ownership-pass.ts` already works around it by deriving
  file scope from its own `contains` edges rather than the `service` column — changing
  `service`'s write semantics would touch every entity type in the repo for no proven defect.
  Only these six entity types are namespaced; **24** flat-metadata call sites remain across the
  codebase — 11 in production (all in `graph-populator.ts`) plus 13 test fixtures — and stay
  flat. The namespaced API is available repo-wide and adopted only where a second writer
  actually exists. `ensureGraphEntity` is untouched: it upserts `ON CONFLICT DO NOTHING`, so it
  can never overwrite a namespace regardless.

- **2026-08-19 — `nimbus stats`: aggregation-over-time queries (W6-B), shipped as disjoint
  buckets rather than the rolling window the roadmap row named.** `nimbus stats <metric>
  --service <id> [--window 90d] [--bucket 1w] [--json]` returns one value per bucket over the
  local index — the time-series counterpart to `nimbus metrics dora`'s single scalar over one
  window. Closes the aggregation half of the last open Wave 6 answer-quality row now that A0
  (2026-08-16), A1 and A2 (both 2026-08-18) have shipped; negation (`--negate`/`--explain`)
  remains open.

  Six metrics. Four wrap the existing DORA calculators unchanged, called once per bucket with
  the bucket's end bound to the calculator's `nowMs` and the bucket's width bound to its
  look-back duration (`deployment-frequency`, `lead-time`, `change-failure-rate`, `mttr`). Two
  are new counters over real event timestamps: `pr-merges` (`metadata.merged_at`) and
  `incidents-opened` (`metadata.opened_at_ms`). No *new* metric buckets on `modified_at` — the
  `item` table carries only `modified_at` (last touch) and `synced_at` (our own indexing time),
  and bucketing on either would measure activity or sync schedule rather than when the thing
  actually happened, the same trap `negotiate` already documented as "active in," not "created
  in." That is why no "count items by type" metric ships alongside the six.

  **The four wrapped metrics do inherit `modified_at`, and that is an accepted cost, not a
  property this feature has.** Calling the tested DORA calculators unchanged also inherits
  their time predicate, which is `item.modified_at`. For the `ci_run` and `deployment` rows
  behind `deployment-frequency` that is effectively event time — `deployment/annotate.ts`
  binds `started_at_ms` into `modified_at`, and `connectors/github-actions-sync.ts` binds the
  run's `created_at` — but for the `pr` rows `lead-time` reads and the `incident` rows
  `change-failure-rate` and `mttr` read, it is genuine last-touch
  (`connectors/github-sync.ts` binds a PR's `updated_at`; `connectors/pagerduty-sync.ts` binds
  an incident's): a PR merged three weeks ago and commented on yesterday lands in yesterday's
  bucket. `mttr` additionally inherits DORA's
  `synced_at` fallback for an incident with no `opened_at_ms`. Both were accepted
  deliberately: a second copy of DORA's arithmetic with a different time predicate would be
  free to drift from the original, and changing `dora.ts` itself moves `nimbus metrics dora`'s
  numbers too — a separately-reviewed change, named as a follow-up rather than smuggled into a
  bucketing layer. So the "real event timestamp" property holds for `pr-merges` and
  `incidents-opened`, and for no others.

  **Built differently from the roadmap row, in two ways, both recorded rather than left to
  surprise a reader.** The row said "rolling 7-day MTTR trend" — this ships **disjoint**
  buckets instead, each computed over its own rows rather than ~90 overlapping evaluations
  sharing data: simpler to reason about and to test, at the cost of a smoother series and
  fewer samples per point. `--window 90d --bucket 1w` is 13 buckets, not 13 uniform weeks —
  buckets are built oldest-first and only the newest 12 are a full seven days wide; the
  **oldest** bucket absorbs the six-day remainder (90 = 12×7 + 6) so the newest bucket still
  ends exactly at the request time. Rolling windows (`--rolling`) are a named follow-up,
  worth building once the sparse-bucket behaviour below has been seen against real data.
  Separately, the row's other headline example, "PR merge throughput by week," implies all
  forges; `pr-merges` is **GitHub-only**, because `connectors/github-sync.ts` is the only
  connector that writes `metadata.merged_at` — `gitlab-sync.ts` and `bitbucket-sync.ts` write
  nothing. A service binding a non-GitHub repo gets a `github_only_merge_data` gap; one
  binding no GitHub repos at all gets `no_repos` rather than a misleading zero.

  **"Disjoint" holds without qualification only for the two new counters.** `pr-merges` and
  `incidents-opened` window half-open (`>= start` and `< end`), so a boundary timestamp lands
  in exactly one bucket. The four wrapped DORA metrics reuse `dora.ts`'s inclusive-both-ends
  window (`>= lower` and `<= upper`) unchanged, so an event landing exactly on a shared
  boundary is counted in *both* adjacent buckets for those four — a known limit, not fixed
  here, because fixing it means changing `dora.ts` itself and therefore `nimbus metrics
  dora`'s numbers too.

  **A null is never a zero, and sparse output is expected, not a malfunction.** An empty bucket
  returns `value: null` with a named gap — never `0` — matching `negotiate`'s "could not be
  computed" discipline: zero incidents and no incident data are different facts. `mttr` is a
  median, so `low_sample` fires often — but it fires in **two different shapes**, and the
  gap name alone does not tell them apart: a one-week bucket holding one or two incidents
  returns a REAL median carrying `low_sample` as a caveat (not empty), while a bucket holding
  zero incidents returns `value: null` with the same `low_sample` gap (empty — DORA's `mttr`
  uses `low_sample` for both the below-threshold case and the zero-incident case). The value
  column is what disambiguates, not the gap name, so the CLI prints the gap on every row that
  has one and its summary line splits by `value`, not by gap: caveated buckets (real value +
  gap) counted separately from empty ones (`null` + gap) — e.g. `4 of 13 buckets had data (3
  caveated: 3 low_sample) · 9 empty (9 low_sample)` means 3 buckets each carry a real median
  with a `low_sample` caveat (one or two incidents), and a *different* 9 buckets carry
  `value: null` with the same gap name for a different reason (zero incidents). A merged
  count read as "9 buckets had no data" and understated how many held a value.
  `incidents-opened` excludes incidents with no `opened_at_ms` and reports the exclusion via
  `incidents_missing_opened_at`, computed once per series and attached only to buckets that
  derived no reason of their own — so one ancient untimed incident no longer displaces every
  bucket's `low_sample`, and if no bucket has data the newest one carries it so the exclusion
  can never vanish. DORA's own code falls back to `synced_at` in this case; this NEW counter
  deliberately does not, since that would place an incident in the week it happened to be
  indexed while presenting it as the week it opened. `mttr`, which wraps DORA unchanged, still
  inherits that fallback — see above.

  **Buckets walk backward from the request time and are not calendar-aligned.** The newest
  bucket always ends exactly at "now," so the freshest point is complete rather than truncated
  at the last calendar boundary. Accepted cost: two runs on different days cover different
  absolute spans and are not comparable point-for-point. A `--align` option for UTC-aligned
  buckets is a named follow-up.

  Scoping reuses the DORA config that already exists — `pr-merges` filters to the service's
  bound repos, `incidents-opened` to its `pagerdutyServices` — no new `nimbus.toml` section. No
  schema migration, no new IPC-visible config, no new HTTP route, no new security invariant, no
  Tauri allowlist change — `ALLOWED_METHODS` stays at 105. `metrics.stats` appends no
  `egress_ledger` row: it reads local SQLite only, dispatches no connector action and makes no
  remote model call, the same posture as `metrics.dora` alongside which it sits.

  **Named follow-ups, not silently deferred:** rolling windows (`--rolling`); `--align` for
  UTC-aligned buckets; a real event timestamp for the four wrapped DORA metrics, which means
  changing `dora.ts`'s own time predicate and therefore `nimbus metrics dora` with it;
  `merged_at` for GitLab/Bitbucket, which would remove the `github_only_merge_data` gap; and
  `pr-opened`, a PR-creation-rate series blocked on connectors capturing a PR creation
  timestamp, not on effort.

- **2026-08-18 — agent personas (A2): `tone` and `voice` ship; `tool_caution` and
  `confidence_threshold` are rejected, not deferred.** A new `[persona]` section in
  `nimbus.toml` — `tone` (`neutral` default / `terse` / `formal` / `casual` / `verbose`) and
  `voice` (`neutral` default / `opinionated` / `collective`) — shapes how `nimbus ask`, every
  built-in agent brief, and the ChatOps replies that share `nimbus ask`'s pipeline are
  phrased. Third and last of the three Wave 6 answer-quality surfaces, after A0 (2026-08-16)
  and A1 (below, 2026-08-18).

  **`tool_caution` and `confidence_threshold` do not ship, and are recorded here so they are
  not relitigated.** `tool_caution` was already prohibited on 2026-08-16: Non-Negotiable #2
  and I2's frozen `HITL_REQUIRED_BACKING` set forbid a config knob that changes what triggers
  a consent prompt. `confidence_threshold` is rejected on the same reasoning one layer up —
  turned down, it is a supported way to make Nimbus sound more certain than it is, against
  every S1 honesty surface built this month: I31's disclosure integrity, the 0.86 confidence
  ceilings on `decisions` and `pre-mortem`, `negotiate`'s "could not be computed" instead of
  `0`. A user-tunable dial that suppresses uncertainty admissions is the same category of
  mistake as a dial that loosens HITL, and neither ships.

  **One definition, two application sites — the same discipline A1 established.**
  `engine/persona.ts`'s `TONE_DIRECTIVES` / `VOICE_DIRECTIVES` are the persona vocabulary's
  only definition. It is applied at `engine/run-ask.ts`'s single site above the
  router-vs-agent fork — the same site A1 uses — composing outward around `--devil`: persona
  outermost, the devil directive innermost, closest to the question, so it is never diluted.
  It is applied a second time at `agents/_lib/synthesize.ts`'s `synthesisInstructionsFor`,
  threaded in from `buildAgentSynthesisRunner` — the one factory both production brief paths
  already share (`ipc/server/dispatchers.ts`'s socket path and
  `agent-runs/agent-http-invoke.ts`'s HTTP path) — so a socket brief and an HTTP brief stay
  byte-identical under every persona, exactly as they already do under every synthesis mode.

  **A third surface follows from the first, and is named here rather than discovered later:
  ChatOps replies.** `gateway-main.ts` routes a `@nimbus <question>` mention through the same
  `runAsk` pipeline as `engine.ask`, so the owner's persona now also speaks in whatever
  Slack/Teams channel the bot answers in. Stated plainly because it is the one surface where
  the audience is not the person who set the config: an `opinionated` or `collective` voice
  will be visible to everyone in that channel. It is documented rather than scoped out — it
  carries no new content and no new egress, only tone, and it is the owner's own configured
  voice on the owner's own ChatOps integration; carving it out would make ChatOps the single
  surface that ignores the persona every other surface honours.

  **D6 — every directive governs *how*, never *whether*.** No `tone` or `voice` string may
  instruct the model to omit, drop, skip, or limit content; `terse` means "say it in fewer
  words," never "leave things out." A test asserts this against an omission-verb pattern over
  the directive constants. D6 is what keeps a persona coherent alongside `--devil` — "argue
  against the plan, in few words" is a coherent instruction, "...and omit some objections" is
  not — and what keeps a terse persona from pushing against I31's disclosure contract.

  **I31 needed no new guard.** Reserved sections (`## Gaps` for all fourteen brief kinds, plus
  `negotiate`'s `## Sources` and `## Evidence not available from the index`) are constructed
  by the renderer and re-attached verbatim after synthesis, never shown to the model — no
  persona can drop one, because no persona can reach one. Interleaved disclosures are
  anchor-checked, and a rewrite that drops one is discarded whole. So the cost a terse persona
  actually introduces is a **higher discard rate** — more briefs falling back to the
  deterministic render, not a lost disclosure — and it is now observable in production rather
  than only inferred: the resolved persona rides the synthesis provenance on the `briefReady`
  notification alongside the existing rejection reason (`timeout` / `contract_violation` /
  `provider_error` / `egress_append_failed` / `empty_result`), so a `contract_violation` under
  `tone = "terse"` is self-describing.

  **Two adjacent bugs fixed in the same branch.** `[agents] synthesis` was profile-blind —
  `loadNimbusAgentsFromConfigDir` hardcoded `nimbus.toml`, so a user with `synthesis` set in a
  profile TOML was silently ignored. `buildAgentSynthesisRunner` now reads it from the
  profile-resolved path, the same path `[persona]` uses; this is a real behaviour change,
  stated here rather than riding along silently under the persona work. **It cuts both ways,
  and the second direction is the one a user can be surprised by:** `[agents]` now follows
  whole-file profile semantics, the same as `[llm]` and `[session]`, so a key set ONLY in the
  base `nimbus.toml` no longer applies while a profile whose file has no `[agents]` section is
  active. Concretely — `synthesis = "off"` in `nimbus.toml` plus an `[agents]`-less
  `nimbus.work.toml` means the `work` profile now gets the `"local"` default, discarding an
  explicit opt-out that used to be honoured. That is the correct semantics for a whole-file
  profile model and it is not being reverted, but it is a behaviour change, so it is recorded
  in both directions here and in [`docs/cli-reference.md`](./cli-reference.md). The
  now-callerless `loadNimbusAgentsFromConfigDir` was deleted rather than left exported beside
  its profile-aware sibling. Separately,
  `ProfileManager` had never been constructed in production: `ipc/server/options.ts` declared
  `profileManager?`, but nothing set it outside tests, so the desktop app's routed Profiles
  settings page (`packages/ui/src/pages/settings/ProfilesPanel.tsx`) and all four
  already-allowlisted `profile.*` IPC methods threw on every call. `platform/assemble.ts` now
  constructs it. **Switching a profile still requires a Gateway restart** — `NIMBUS_PROFILE`
  is read at process spawn — and the panel now says so, matching what the CLI already printed.
  The panel also now refetches after a switch, so the `active` marker moves to the row the
  success notice is talking about instead of staying on the old one — a pre-existing bug that
  only became reachable once the page stopped throwing.

  **Acceptance criterion replaced, not met, the same way A1's was.** The Wave 6 row asked for
  an integration test that "toggles persona mid-session and asserts the response shape
  changes" — asking for something impossible (`NIMBUS_PROFILE` is fixed at spawn, so
  mid-session profile switching cannot happen) and something untestable (grading model prose
  needs a live LLM the suite does not have, and would be flaky where one exists). What is
  asserted instead: editing `[persona]` in the active profile's TOML changes the next response
  with no restart (`engine/run-ask.test.ts`, through `runAsk` itself with a real `[persona]`
  file on disk — not by injecting a persona downstream of the resolution being claimed); the
  persona directive reaches the prompt on both execution paths (`runViaLocalRouter`,
  `runViaAgent`), which both dispatchers (`agent.invoke`, `engine.askStream`) reach through
  the one `setAgentInvokeHandler` → `runAsk` seam; the default persona is byte-identical to
  today; persona composes with `--devil` in the documented order; a brief synthesized under
  `tone = "terse"` still carries every reserved section AND every `requiredPhrases` anchor —
  asserted on a `negotiate` brief with all seven lanes null, the only fixture that HAS anchors,
  in both directions (a compliant rewrite is used; one that drops an anchor is discarded as
  `contract_violation`); `[agents] synthesis` set in a profile TOML is honoured; and, both
  proven against a real in-process assembly in `platform/assemble.test.ts` rather than an
  injected fake, `profile.list` succeeds over the assembled gateway's own IPC socket and an
  unrecognised `[persona]` value warns once through the boot logger's daily log.
  **Recorded gap:** nothing asserts that a terse persona's prose is actually terser — that
  grades model output, the same limitation A1 carries.

  No schema migration, no new IPC method, no new HTTP route, no new security invariant, and no
  Tauri allowlist change — `ALLOWED_METHODS` stays at 105.

- **2026-08-18 — `nimbus ask --devil`: devil's-advocate mode (A1), with the roadmap's stated
  hazard avoided rather than satisfied.** The agent argues AGAINST the plan or assumption in the
  question — the risks it runs, the edge cases it ignores, the alternative reading of the evidence
  — instead of helping to carry it out. Second of the three Wave 6 answer-quality surfaces to
  land after A0 unblocked them (2026-08-16).

  **The two-prompt-site trap this row warned about was designed out.** `docs/roadmap.md` recorded
  (2026-08-16) that `--devil` needed `engine/agent.ts`'s three Mastra `instructions:` literals and
  `run-conversational-agent.ts`'s separate hardcoded `systemPrompt` "updated together", since a
  change at one silently no-ops on the other. Neither was touched. Both execution paths —
  `runViaLocalRouter` and `runViaAgent` — consume a prompt built by a single function,
  `buildPromptText`, and `applyDevilAdvocate` prefixes the directive to what that function
  returns — one site, above the router-vs-agent fork, so both paths carry it by construction
  rather than by anyone remembering to update two prompt strings. The
  sentence itself has exactly one definition, `engine/devil-advocate.ts`'s
  `DEVIL_ADVOCATE_DIRECTIVE`, following the same single-definition discipline as the previous
  day's `brief-disclosures.ts`.

  **The real two-site risk was one layer up, where the roadmap had not looked.** `agent.invoke`
  and `engine.askStream` are separate IPC dispatchers that resolve the same
  `getAgentInvokeHandler()`, each parsing its own params record — and `engine.askStream` is the
  path the desktop UI and the VS Code extension use. Wiring only `agent.invoke` would have
  shipped a flag that worked in the terminal and was inert on every other surface. Both are
  wired (`AgentInvokeContext.devil`, `AskStreamParams.devil`, `AgentInvokeContextLike.devil`) and
  independently tested; breaking either leg fails only its own test, which is how the coverage was
  verified rather than assumed.

  **Routing:** `--devil` skips intent classification and forces the conversational path.
  Plan dispatch executes a plan and has no argument to make, so without this the flag would do
  nothing for every query a probabilistic classifier reads as an action — a subset the user cannot
  predict. Forcing the route does not fabricate one: with no agent and no local router it raises
  the existing `GatewayAgentUnavailableError` rather than proceeding. The classifier is skipped
  outright rather than called and ignored, saving an LLM round-trip per `--devil` turn. The
  conversational block was extracted to one `answerConversationally` helper so the classifier's
  route and the `--devil` route cannot drift apart.

  **The directive carries an honesty clause, and it is load-bearing:** a mode that asks a model to
  argue against the user is a mode that invites invented objections, so it must ground each
  objection in citable indexed evidence and state that an objection is unsupported rather than
  manufacture support for it.

  **Acceptance criterion replaced, not met.** The Wave 6 row asked for an integration test
  asserting the response "contains at least 3 distinct counter-arguments". That grades model prose,
  requires a live model the suite does not have, and would be flaky where one exists. Substituted:
  seam tests proving the directive reaches the prompt on both execution paths, is absent when the
  flag is off, survives the indexed-context and prior-turns transforms, and crosses both
  dispatchers — plus the forced-routing behaviour. **The counter-argument count is verified by no
  automated test**; that is a recorded gap. Stated bound: a prompt-level directive carries less
  weight with most models than a system-level one, and the router path's own `systemPrompt` is
  deliberately left alone so there is a single application site rather than two free to diverge.

  No schema change, no new IPC method, no HITL involvement, no invariant, no Tauri or LAN
  allowlist change — `devil` is a new optional param on methods that already exist.

- **2026-08-18 — the interleaved half of I31: one definition per disclosure, and the window
  clause finally guarded.** PR 1 (below, 2026-08-17) made whole-SECTION disclosures safe by
  construction. The sentences that sit inside prose the model is meant to rewrite could not use
  that mechanism, and the fallback — an anchor-phrase check — covered only `negotiate`'s seven
  null-lane disclaimers, from string literals in `render.ts` with a matching `NOT_COMPUTED` copy
  in `brief-contract.ts`: two sets free to drift, where editing one yields either a guard
  requiring a phrase nothing renders (rejects every synthesis) or a rendered disclosure nothing
  guards.

  A new `agents/_lib/brief-disclosures.ts` is now the single definition of every interleaved
  disclosure — its `line` (what the renderer emits), its `anchor` (the factual fragment that must
  survive a rewrite) and, where it is conditional, its presence PREDICATE. `render.ts` emits
  `.line`; `brief-contract.ts`'s `requiredPhrases` requires `.anchor` under the same predicate,
  by asking the module rather than re-deriving it — so the guard cannot require a phrase the
  brief never rendered, nor miss one it did. Coverage widens from those seven sentences to the
  whole set: `negotiate`'s ownership accountability disclaimer and list-truncation clause, its
  two `unattributable` disambiguation lines, `glossary`'s two definition-provenance lines, and
  the last-modified-not-created window clause.

  The window clause needed a second SCOPE, not just an anchor. It lives in the PREAMBLE, above
  the first `##` — deliberately, since it qualifies every headline count in the brief — where
  `sectionBody` cannot reach, so a required phrase pointed at it had nowhere to be checked.
  `markdown-sections.ts` gains `preambleBody` (everything above the first level-2 heading,
  fence-aware through the same shared scan). It is scoped to the preamble rather than searching
  the whole document: a rewrite that deletes the clause from the header and mentions it under
  some unrelated section has still dropped it from the place the counts are read against. Anchors
  are each sentence's factual clause, never its full text (requiring that verbatim would reject
  legitimate paraphrase and discard the rewrite) and never its variable tail (the decisions line
  ends "not necessarily yours"/"…theirs" depending on `--person`, so a tail-inclusive anchor
  would be inert for half of all briefs).

  **User-visible consequence, stated plainly:** a negotiate brief now ALWAYS has a non-empty
  requirement set. Before this, a fully-populated brief had none — a model could return a single
  line and it was accepted verbatim. Three fixtures across the suite encoded exactly that
  behaviour and were updated to carry the disclosures a real rewrite must keep.

  Two bounds remain and are recorded rather than hidden: a phrase check proves a FRAGMENT
  survived, not that the sentence around it still means what it meant, so a rewrite that keeps
  "no indexed author" inside a sentence reversing its sense would pass; and `glossary` requires
  a phrase only in `term` mode, for `entries[0]`, exactly mirroring `renderGlossaryBody` —
  `list`/`miss` mode render no provenance sentence at all, and requiring one there would reject
  every list-mode synthesis over a disclosure the renderer never wrote. One item from the design
  was dropped on contact with the code: exact-match heading scoping for glossary terms, proposed
  against a prefix-collision between two `## <term>` sections that cannot occur, because term
  mode renders a single entry. Enforcement: a new `security-invariants.test.ts` row asserts every
  disclosure's anchor is a substring of the line the SAME constant produces — the inert-anchor
  failure — plus render-derived tests per disclosure, each red-proved by reverting its mechanism.
  No migration, no IPC change, no Tauri allowlist change; I31's text, the mirrored `CLAUDE.md` /
  `GEMINI.md` bullets and the roadmap row are updated in place.

- **2026-08-17 — disclosure integrity for synthesized briefs recorded as invariant I31.** The
  A0 synthesis feature (below, 2026-08-16) shipped a rewrite path with no structural guarantee
  that a model rewrite couldn't drop a brief's disclosure sections — confidence ceilings,
  truncation counts, "this is authorship-derived ownership, not accountability" — beyond the
  narrow `negotiate`-only `requiredPhrases` check. A follow-up landed the fix: `agents/_lib/
  synthesize.ts`'s `synthesize()` now renders each brief twice — once canonically and once with
  `omitReserved: true` for the model prompt — and builds every disclosure-only section (`##
  Gaps` for all fourteen brief kinds, plus `negotiate`'s `## Sources` and `## Evidence not
  available from the index`) directly from the brief's own data via `agents/_lib/
  reserved-sections.ts`'s `RESERVED_HEADINGS_BY_KIND` registry, never by parsing either render.
  A reserved section the model emits anyway is stripped (`agents/_lib/markdown-sections.ts`'s
  `stripSections`) and the canonical block is re-attached verbatim regardless, so a rewrite
  cannot drop a disclosure by construction rather than by check. If a renderer's `omitReserved`
  render comes back identical to its canonical one — meaning the flag was not honoured — no
  rewrite is attempted at all (fail-closed). That coverage is broader than "Gaps" suggests:
  `decisions`'s and `premortem`'s 0.86 confidence ceiling and every `glossary`/`decisions`/
  `premortem` `body_complete = 0` truncation count are each emitted as a gap note, so they ride
  the same `## Gaps` section as everything else and are fully protected by this fix, not an
  exception to it. What remains genuinely interleaved — inside prose the model is meant to
  rewrite, so it cannot be held back as a whole section — is narrower: `negotiate`'s ownership
  list-truncation clause, its last-modified-not-created window clause, its two `unattributable`
  lines, and `glossary`'s two definition-provenance lines. That set stays on the narrower
  `requiredPhrases` anchor-phrase check in `agents/_lib/brief-contract.ts`, which today covers
  only `negotiate`'s seven null-lane sentinels; widening it to the rest, and deriving its anchors
  from constants shared with the render sites instead of the two independent copies that exist
  today, is a follow-up PR's scope.
  Recorded as **invariant I31** (`docs/SECURITY-INVARIANTS.md`) with no static `D`-rule —
  deliberate, since there is exactly one production path that produces a brief's final markdown
  today, so a source-scanning confinement rule would guard a risk that does not exist. Stated
  bound: the strip step runs on the model's output and cannot distinguish a hallucinated `##
  Gaps` heading from one faithfully echoed out of quoted brief content; fenced code blocks are
  excluded from the scan, narrowing but not eliminating this, so a synthesized brief may drop a
  fragment of quoted body text — it can never drop a disclosure, and the deterministic brief is
  unaffected either way. `CLAUDE.md`/`GEMINI.md` roster line moves to "Invariants through I31";
  the A0 roadmap entry's coverage claim (`docs/roadmap.md`) is updated to match. No migration, no
  Tauri allowlist change, no `connectors.dispatch` involvement.

- **2026-08-17 — the PR-time parse gate was judging a message GitHub never creates, and #1234
  was dropped because of it.** `feat(agents): make built-in brief synthesis executable` (#1234)
  merged with a green `PR quality — Release safety` check, then release-please failed to parse
  its squash commit (`unexpected token '\n' at 105:24`), counted `commits: 0`, and opened no
  release PR — so the drop-guard on `main` went red with one unreleased user-facing commit.

  **Cause: GitHub hard-wraps a squash commit BODY at 72 columns and leaves the SUBJECT alone.**
  `check-pr-message-parses.ts` composed `subject\n\n<PR body verbatim>` and parsed that, so the
  message it judged was not the message that landed. The difference is exactly the kind that
  flips a parse — wrapping inserts a newline mid-line, and this grammar will not accept a newline
  inside a `(`-group. #1234's body carried
  `` `createBriefLlm(router, briefsToml.preferLocal)` ``; wrapped, the `(` ended its line and the
  `)` fell to the next.

  **The gate was mostly inert, not merely wrong at the margin.** Measured over the 120 most
  recently merged PRs against their real squash commits: four genuinely fail to parse (#1218,
  #1219, #1224, #1234) and the un-wrapped composition caught **one** — #1224. It missed #1218,
  the incident the gate was built for.

  **This corrects a claim in the entry below.** "All seven would be blocked today" was verified
  by reconstructing each PR body from its already-wrapped COMMIT, which is a fixed point of the
  wrap and therefore parses the same either way. Fed the un-wrapped PR bodies the workflow
  actually supplies (`github.event.pull_request.body`), the gate as it then stood did not block
  #1218 or #1219. It does now; the seven reported positions in that entry stand, because they
  were computed on wrapped input, which is what the gate finally uses.

  **The fix:** `wrapBody()` reproduces #1234's landed commit body byte-for-byte (222 of 222
  lines — GitHub's appended `Co-authored-by:` trailer is not modelled and need not be, since a
  trailer after the body cannot change a parse failure earlier in it), 72 columns being the only
  width of 70/72/75/76/80 that does so. All three reproducible incidents now land on their exact
  CI-reported positions (103:15, 20:72, 105:24), and across the 120-PR corpus the model agrees
  with the real commit on every one — zero false positives. A checked-in fixture
  (`scripts/release/fixtures/squash-parse-corpus.json`) holds five real bodies, three failing and
  two passing, and one test asserts the OLD path's specific blindness so the corpus cannot rot
  into a set of cases that would pass without the wrap.

  **Not in the release notes:** #1234, for the same immutable-tag reason as #1218 before it. Its
  substance is recorded in the `model`-egress entry immediately below, which was written the same
  day and covers the same work.

- **2026-08-16 — Egress class `model` rises from `none` to `per-call`** (agent-brief-synthesis
  work, landing ahead of the synthesis wiring itself). `egress/synthesis-egress.ts`'s
  `recordSynthesisEgress` is the sole appender: one row for a built-in agent brief synthesized by a
  NON-LOCAL provider. Read it as narrowly as `mcp`/`http` — it is NOT "all inference": embeddings
  still append nothing (`PROSE_HEAVY_TYPES` routes to OpenAI's 1536-dim table with no appender), so
  a zero `model` count in `nimbus prove`'s scope line is not a claim that no vector left the
  machine. The local-vs-remote split is enforced INSIDE the appender via a required `remote`
  argument — a `false` call appends nothing, not even a blocked row — mirroring
  `recordSyncEgress`'s `LOCAL_ONLY_SYNC_SERVICES` check for the same reason: a caller-enforced rule
  is one wiring mistake away from fabricating a `model` row for a local generation. At the moment
  the appender itself landed it had no production caller yet — that arrived the same day, in the
  same effort, when the synthesis wiring (`agents/_lib/synthesis-llm.ts`) was supplied to both
  production dispatchers (`ipc/server/dispatchers.ts`'s socket path and
  `agent-runs/agent-http-invoke.ts`'s HTTP path), under `[agents] synthesis = "local"` (default) or
  `"allow-remote"`. `COVERAGE_CLASS_LABELS` in `cli/src/commands/prove.ts` gains a matching
  `model` label ("remotely-synthesized agent briefs") so the scope line never falls through to a
  bare, over-broad `model` key (`I29`).
  **User-visible: this is a default-on behaviour change.** New `[agents] synthesis` config
  (`"off" | "local" | "allow-remote"`, default `"local"`) — with Ollama (or llama.cpp) running, the
  prose of all fourteen built-in briefs (catchup, conflicts, expert, ghost, huddle, impact,
  janitor, preflight, why, glossary, decisions, ownership, premortem, negotiate) is now
  model-rewritten by default instead of deterministically rendered; set `synthesis = "off"` to
  return to the pre-this-work behaviour. A `requiredPhrases` honesty guard
  (`agents/_lib/brief-contract.ts`) discards a synthesized rewrite that drops a section's
  contractually-required disclaimer text — covering `negotiate`'s seven null-lane disclaimers
  today, with every other brief kind returning an empty `requiredPhrases` set pending a follow-up
  widening. Every brief's `SynthesisProvenance` (`.synthesis.attempted` / `.synthesis.used` /
  `.synthesis.reason`) rides the `briefReady` notification and the HTTP
  `GET /v1/agents/runs/{id}` response, so "why is this brief still deterministic?" is answerable
  without a debug build. A rendered brief also carries a plain-language footer naming its own
  provenance — deterministic-by-design (`"off"`, or no runner wired), deterministic-with-a-
  discarded-attempt (e.g. on a machine where Ollama answers but the configured `[llm] local_model`
  is not pulled), or synthesized — so the same fact is legible in the rendered markdown, not only
  in the machine-readable field.
- **2026-08-16 — seven user-facing commits were missing from the generated changelog, going
  back to April.** Recorded here because tags are immutable and the release notes cannot be
  corrected after the fact.

  Cause, in every case: release-please could not parse the squash commit, so it skipped it. The
  squash body IS the PR body, and an unbalanced `(` in a code span is enough — see
  `pr-body-breaks-release-please` in the release docs and `scripts/release/check-pr-message-parses.ts`.
  The release still shipped each time; only the entry vanished, silently.

  Established by running release-please's own parser (`@conventional-commits/parser`) over all
  2,698 commits on `main`. 594 do not parse, but 587 of those are `chore`/`test`/`ci`/`docs` or
  pre-Conventional subjects that were never changelog-eligible — no harm. **Seven are `feat`/`fix`
  and absent from `CHANGELOG.md`:**

  | commit | release it belonged to | subject |
  | --- | --- | --- |
  | `f409dec1` | 2026-04-19 (direct commit) | `fix(llm): restore globalThis.fetch correctly after each test` |
  | `14c7ae4a` | `v0.5.0` | `feat: nimbus security scan v2` (#515) |
  | `0d2d006f` | `v1.7.0` | `feat(audit): gate the workflow_run pwn-request premise` (#921) |
  | `63c23afc` | `v1.9.0` | `fix(quality): clear all 171 SonarCloud issues from the 2026-07-29 profile bump` (#947) |
  | `dd98484b` | `v1.21.0` | `feat(index): enforce connector depth and index real Gmail and Outlook bodies` (#1047) |
  | `828090ca` | `v2.4.6` | `fix(security): widen D12 past its receiver-name blind spot and D22(d) past its flat-path one` (#1218) |
  | `b59ccacf` | `v2.4.7` | `fix(release): make the drop-guard ask whether the release PR is complete` (#1224) |

  Three of the seven are features, one of them security tooling, and none of the four older ones
  appears in this file either — so until now the only record of them was the git log.

  **All seven would be blocked today.** The PR-time parse gate (#1227) was run against each
  reconstructed PR: every one exits 1, at `3:11`, `13:51`, `142:17`, `33:31`, `155:42`, `103:15`
  and `17:15` respectively. The two 2026-08-16 entries were the ones that prompted the
  investigation; the other five were found by it.

  **Corrected 2026-08-17 — this was true of the input tested, not of the gate as wired.** Each
  PR body was reconstructed from its already-wrapped commit, which the gate parses identically
  either way; fed the un-wrapped bodies the workflow really supplies, the gate then missed #1218
  and #1219. It blocks all seven now — see the 2026-08-17 entry at the top of this file. The
  positions above stand.

- **2026-08-16 — an audit of I1–I30 found two live bugs, two defenses wired to nothing,
  and a class of guard that reports clean without enforcing anything.** Six PRs (#1216,
  #1217, #1218, #1219, #1220, #1221), shipped in `v2.4.6`.

  **Two defects were already in production.** `commands/data-delete.ts` ran two unwrapped
  `DELETE`s through `input.index.rawDb.run(...)` on the live `data.delete` IPC path: D12's
  regex pinned the receiver to the literal name `db`, and `\b` cannot match between the `w`
  and the `D` of `rawDb`, so the rule exited 0 for its entire life. `connectors/reindex.ts`
  wrote `hitlStatus: "approved"` on a path where the gate is structurally never entered
  (`reindex-rpc.ts` gates `depth === "full"` alone, and that branch returns
  `itemsAffected: 0`), putting a consent decision that never happened inside the verified
  hash chain — the S1-F5 / chain C6 shape.

  **Two defenses were resolved and read by nothing.** `EnforcedPolicy.hitlRequired` was
  computed as a monotonic union and `isHitlRequiredByPolicy` existed to read it, with zero
  production callers: an org admin could sign `[policy.hitl] require`, watch it verify, and
  get no gate. And the federation identity guard was wired for local IPC but absent from
  `buildFederationLanServer`'s options, so `ctx.identity` was `undefined` for every
  peer-facing answer and a deprovisioned operator kept answering `federation.query` /
  `auditExport` / `invoke` / `preflight` instead of failing closed.

  **The structural finding: a guard that short-circuits per FILE cannot see a per-SITE
  regression.** I15 and D10 both passed on one `wrapServerSpec(` token anywhere in the
  file, and `connector-spawns.ts` funnels 26 MCPClient spawns through a single `wrap`
  helper — so dropping the sandbox wrapper from one connector left the token in place and
  three gates green while that child ran with a live OAuth token and no landlock/seccomp/
  seatbelt profile. Both are per-site now. The same shape recurred across rules written in
  the same style: the subdirectory blind spot fixed for D17/I23 in #1216 was still live in
  D22(d) one commit later.

  Also: the static auditor gained a non-vacuity floor (#1217) after a broken glob was shown
  to leave 179 files scanned, all fourteen D-rules silently no-op, and `exit 0`; five
  enforcement tests that could not fail were made capable of failing (#1219); and four
  drifted doc claims are now derived by `audit:status-drift` rather than hand-maintained
  (#1221) — the write-route allowlist said twelve against a real fourteen, and I17 named two
  LAN-admitted federation methods against a real thirteen.

  **Not in the `v2.4.6` release notes:** #1218. release-please could not parse its squash
  commit (`unexpected token '(' at 103:15` — the PR body contained `` `.run(` ``/`` `.exec(` ``,
  code spans holding unbalanced parentheses, and the squash body IS the commit message), so
  it was dropped from the generated changelog. Recorded here because the tag is immutable.
  The drop-guard failed the runs on #1218 and #1219 exactly as designed, then went green
  once a partial release PR existed — it asked whether a release PR appeared, not whether
  that PR accounted for every user-facing commit. `scripts/release/release-pr-completeness.ts`
  now asks the second question.

- **2026-08-15 — eleven copies of the gateway-connect lifecycle became one, and a guard
  keeps it that way.** Every `nimbus` command that talks to the Gateway re-derived the
  same five steps: read gateway state, throw the not-running message, construct a client,
  connect, `try/finally` disconnect. Eleven local helpers did it — `withIpc` in `audit`,
  `clip`, `people`, `share`, `vault`, `watch`, `connector`, `workflow` and `prove`, plus
  `withConsentIpc` and `data`'s `withClient` — alongside the shared `withGatewayIpc` that
  already existed. **Six were byte-identical to it.** The rest differed only in which of
  `onConnect` / `requestTimeoutMs` they exposed, so both became options on the shared one.

  The duplication was not cosmetic, and this is the argument for the change rather than
  line count: each copy was its own opportunity to get the lifecycle subtly wrong, and two
  of them did. `connector reindex --depth full` and `nimbus workflow run` both shipped
  with no `consent.request` handler, so a HITL gate hung until the request timeout —
  fixed a day earlier, in two places, because there were two places. There is now one.

  The six identical helpers also threw a bare `Error` where the shared helper throws
  `GatewayNotRunningError`. That is a strict upgrade: the message is unchanged so the
  tests asserting on it still pass, and callers gain an `instanceof` they can branch on
  instead of matching a string.

  `onConnect` is tested for ORDERING, not merely for running: it must fire after
  `connect()` and before `fn`, because a notification can arrive in the same socket chunk
  as the response to `fn`'s first call — which is exactly how those two commands came to
  hang. A third test pins that a throwing `onConnect` does not strand the connection.

  **Two guards keep it consolidated**, both red-proved by reintroducing the duplication
  into `watch.ts` and watching them name the file: a local helper must delegate to
  `withGatewayIpc`, and a file declaring one must not also contain the raw
  `"Gateway is not running"` throw. Thin wrappers are still allowed — `connector.ts` keeps
  one because eleven call sites use its positional shape — what is forbidden is a wrapper
  that does the work itself.

  Net −97 lines of source. `bun test packages/cli/src`: 2291 pass, versus 2286 before, with
  the same 3 pre-existing failures — `nimbus tui fallback behavior`, which fails only in
  the combined run and passes in isolation on clean `main` (the `mock.module` contamination
  CLAUDE.md documents). Verified identical before and after, so the refactor changed no
  test outcome.

- **2026-08-15 — two defects found by actually running Nimbus against a local Ollama,
  neither of which any test could have caught.** The whole point of the exercise: a fake
  gateway agrees with the code, and a real one does not.

  Setup was a fully isolated install — `APPDATA`/`LOCALAPPDATA`/`USERPROFILE`/`HOME` all
  redirected to a temp root, not just `NIMBUS_CONFIG_DIR`, which moves the config dir only
  and would have left a gateway writing to the REAL index. Verified afterwards that the
  real config (untouched since 2026-08-10) and data dir were never written.

  **`nimbus config set` fails on a fresh machine.** `writeUtf8FileAtomicReplace` calls
  `mkdtempSync(join(dir, …))` without ensuring `dir` exists, so the very first command the
  install guide gives — `nimbus config set llm.local_model llama3.2`, documented BEFORE
  "Start the Gateway", which is what would otherwise create the directory — dies with
  `ENOENT: no such file or directory, mkdtemp '<configDir>/.nimbus.toml.swap-XXXXXX'`.
  An error naming a swap file the user never asked for, from step one of setup. One
  `mkdirSync(dir, { recursive: true })`; red-proved (reverting fails the new test, and the
  control confirms an existing directory and its other files are untouched).

  **The deterministic-brief footer gave unactionable advice.** Every built-in brief ended
  with `Rendered deterministically — configure an LLM for prose synthesis.` Configuring
  one changes nothing: both production callers of `dispatchAgentsRpc`
  (`ipc/server/dispatchers.ts`, `agent-runs/agent-http-invoke.ts`) omit `llm` — the latter
  explicitly, in a comment — so `AgentsRpcContext.llm` is ALWAYS undefined in production,
  and `briefs/brief-llm-adapter.ts` says the same from the other side, calling itself "the
  first place an LLM is wired into a built-in gateway agent surface". Confirmed live: with
  `local_model = "llama3.2"` and `prefer_local = true` and Ollama running — a configuration
  `nimbus ask` used successfully in the same session — `nimbus why` still printed it. The
  footer now states the mode instead of prescribing a fix: "built-in briefs do not use an
  LLM, regardless of `[llm]` settings."

  **What the run confirmed working**, worth recording because it is the local-first claim
  end to end: `nimbus init` inside a git repo appended a `[[filesystem.roots]]` block,
  detected the running gateway and told the user to restart (exit 0, no silent no-op),
  indexed on the second run, and suggested a real command derived from the actual code
  (`nimbus why src/resize.ts:1 # resizeToThumbnail`). `nimbus search` returned the indexed
  `code_symbol`. `nimbus ask` routed to Ollama and answered from indexed context, citing
  the repo's own commit message, in 24.7 s on a 3.2B model. `nimbus egress` reported
  **0 outbound events** for the whole session with an honest scope label and its two boot
  markers — the I29 zero-row claim, observed rather than asserted.

- **2026-08-15 — maintenance sweep: the skills the agent loads were drifting, and one
  of them was structurally broken.** Batched deliberately into one PR rather than four,
  since each carries CI cost and none is independently interesting.

  **`nimbus-file-map.md` had no frontmatter at all.** Four markdown table rows had been
  pasted ABOVE the YAML block, and the opening `---` fence was fused onto the end of the
  fourth (`…(D22 rule (d)) |---`), so the file never opened with a fence. The loader was
  reading an orphaned table row AS the skill's description — visible in the live skill
  listing, which read ``nimbus-file-map: | `packages/gateway/src/egress/agent-brief-egress.ts` | …``.
  Introduced by `4b4bedb4` (#1063, 2026-08-07) and unnoticed for a week, because a
  malformed skill still loads — it just loads wrong. Fence restored; three of the four
  orphan rows re-homed into the Phase 6 table (the fourth was a stale duplicate of a row
  that already exists there in updated wording).

  **Counts corrected against the code, each verified by reading the source, not the
  claim:** `WRITE_ROUTE_ALLOWLIST` 12 → **14** (the tests assert 14), Tauri
  `ALLOWED_METHODS` 101 → **106**, `NO_TIMEOUT_METHODS` 5 → **6** (`workflow.run`, added
  this same day), schema V48 → **V53**, `EgressSourceType` 9 → **10** members (the skill
  omitted `http` while contradicting its own coverage-class section two paragraphs
  earlier), `agents.*` twelve → **fifteen** methods, CLI 54 → **62** commands,
  `wrapToolOutput` "two production sites" → **seven files / nine call sites**.

  **Claims that were simply false:** `nimbus-architecture.md` called `packages/admin-console`
  an "Electron admin console" — it has no Electron dependency, and CLAUDE.md says the
  opposite two files away. `nimbus-security-invariants.md` told contributors to never
  expose `updater.*` to the renderer; four `updater.*` methods are deliberately on the
  Tauri allowlist so the desktop app can drive its own update flow, and the allowlist
  skill says so. `nimbus-testing.md` cited an e2e path that does not exist.
  `nimbus-architecture.md` still said Phase 7 is next, where CLAUDE.md has the Spine
  overlay and slot S1.

  **The coverage-gates table is gone rather than corrected.** It listed nine scopes:
  three did not exist, and it omitted nineteen of the twenty-four actually enforced by
  `SCOPE_GATES`. A hand-maintained duplicate of two dozen numbers is a drift generator,
  so the section now points at the live source and states the two real gates (per-scope
  floors; the per-file ≥85% line / ≥80% branch ratchet) and the traps around them.

  **Docs:** CLAUDE.md and GEMINI.md — which are required to mirror — both said
  `bun-version: latest` appears in one workflow; it appears in two
  (`org-drift-sweep.yml`, `release-channel-drift.yml`). Both omitted
  `packages/mcp-launcher`, a real workspace member, from the Subsystems list. Fixed in
  both, and the mirrored lines verified identical.

  **Scripts:** six files deleted with no references from anywhere — five platform
  wrappers (`scripts/windows/{build-debug,build-release,kill-gateway,run-tests}.ps1`,
  `scripts/linux/run-tests.sh`) and `scripts/audit/generate-connector-readme.ts`, which
  hardcoded a 29-connector list against 94 real connectors. Verified by exact-path grep
  AND by a `join()`-built-path search, because the audit's own regex could not see the
  latter and had already missed one reference elsewhere. A comment in
  `package-headless-bundle.ts` pointing at `bun run compile:gateway` — a script in no
  package.json — now names the real one.

  **One performance fix, measured rather than asserted:** `verifyEgressChain` selected
  `payload_summary` and never read it. It is the widest column in the table (256 bytes
  against integers and fixed-width hashes) and is **deliberately excluded from the row
  hash** — `egress-ledger.ts` records that it "is intentionally NOT hashed: it is
  redacted/lossy" — so dropping it from the SELECT cannot change verification. Measured
  in isolated processes over 200k rows: **90.3 MB → 58.0 MB** (36%). It needed its own
  narrow row type: `RawRow` is shared with `listEgress`, whose `toRow` still reads the
  column, so narrowing the shared type would have failed the build.

  **Deliberately NOT taken from the same audit:** a `dbRun` prepared-statement cache
  (its fix wired 1 of ~20 `Database` sites and would have re-created the #969
  finalization hazard elsewhere, for ~0.2 s on a 100k-item sync), and a
  `graph-populator` commit-lookup rewrite (the proposed regex has no capturing group
  while `extractCommitShas` reads `m[1]`, so it would have silently destroyed every
  commit-SHA edge). Both were caught by an adversarial verification pass over the audit,
  not by review after the fact.

- **2026-08-15 — OS notifications are documented as unimplemented instead of
  advertised as working, the drop is logged, and the TUI watcher pane renders again.**
  `NotificationService.show()` has exactly one implementation in the tree — an empty
  async function — and `win32.ts`, `darwin.ts` and `linux.ts` all delegate to the same
  assembler, so it is a no-op on **every** platform with no per-platform variant to
  find. That was a known, sized deferral (`docs/ecosystem-roadmap.md`), but three
  places asserted otherwise, and one real bug sat next to it.

  What was **not** true, and is worth stating precisely because the opposite is easy to
  assume: **no alert is lost.** All three producers — repeated sync failure, connector
  auth loss, and a watcher fire — write durable state *before* they call `show()`. A
  fire is persisted by `insertWatcherEvent` + `updateWatcherLastFired` one statement
  ahead of the notify; auth loss by `transitionHealth` into `sync_state.health_state`,
  `last_error` and a `connector_health_history` row. Both then surface through
  `nimbus connector list`/`status`/`history`, `nimbus doctor`, the TUI, the Tauri tray
  and agent `connectorHealthCaveat` strings. The gap is the unattended **push**
  channel, not the data — a reachability defect, not a data-loss one.

  Corrected: `user-guide/watchers.mdx` claimed "a tray notification pops" as step 2 of
  what happens when a watcher fires — deleted, and replaced with a note stating that a
  fire is recorded rather than announced and naming the surfaces that do show it. Its
  opening paragraph made the same claim independently ("you receive a notification in
  the system tray"), and its filter section called the first matching item "the
  notification summary"; both now describe the `watcher_event` row that is actually
  written. A sweep of the docs tree confirms these were the only false *notification*
  claims — the several "system tray" references elsewhere are about the tray ICON,
  which does exist (`ui/src-tauri/src/tray.rs`), gated only by the separately-recorded
  fact that the desktop app ships no binary. Its
  history-drawer paragraph now says the drawer is code-complete but ships in no
  released binary. `roadmap.md`'s 401/403 row keeps its checkbox (the typed error,
  `transitionHealth` and every read surface genuinely shipped) with "+ notification UX"
  and "one-shot CLI notification" struck, since that half is inert. `roadmap.md`'s
  **"Notification routing"** row is **unchecked**: the `namespaceNotify` `ReplyTarget`
  and its dispatcher branch exist, but `makeChatopsWatcherNotify` — the only producer
  that would drive a watcher alert into them — has **zero production callers**, and its
  docblock claimed it "composes with the existing IPC-notify callback at the wiring
  site (both are called)", describing a wiring site that has never existed. That
  comment now says so. It is deliberately **not** wired here: doing so makes a path
  that emits nothing today start posting outbound, which is I23 (and plausibly I29)
  territory and needs the triple-rule, not an incidental hookup.

  The stub is renamed `createUnimplementedNotifications` and now logs
  `notification.dropped` with the **title only** — never the body, because watcher
  bodies interpolate `fired.summary` (`${service}: ${item title}`) straight from the
  index, and `gateway-log-redact.ts` scrubs secrets rather than arbitrary indexed
  content. A test pins that the body never reaches the log.

  **Bug fixed alongside:** the TUI's `WatcherPane` declared rows as
  `{ id, name, active, firing }` and unwrapped the response with `Array.isArray`.
  Neither matched the Gateway — `watcher.list` returns `{ watchers: [...] }`, and
  `listWatchers` selects the table's own `enabled` / `last_fired_at` columns;
  `active`/`firing` have never existed on the wire. The guard therefore always
  rejected and the pane rendered **"No watchers configured" no matter how many
  watchers were running**. Its test could not catch this: it stubbed a bare array
  carrying the invented fields, so the fake agreed with the component instead of with
  the Gateway. Both are fixed, and "firing" is now an explicit, documented derivation —
  fired within `WATCHER_RECENT_FIRE_WINDOW_MS` (15 min), chosen because
  `last_fired_at` records a *completed* fire and a window equal to the 30 s poll
  interval would surface one for at most a single refresh.
- **2026-08-15 — blocking CLI commands no longer die on the client's 30s request
  timeout, and two HITL-gated commands get the consent handler they never had.**
  `IPCClient` bounds every `call()` with `requestTimeoutMs` (default 30 s), armed at
  send time and cleared only by the matching response — no notification resets it.
  That is the right default for the hundreds of RPCs that answer in milliseconds, and
  the wrong one for two classes of call, **both of which were shipping broken**.

  (1) *The handler awaits the whole operation.* `connector.sync` (the scheduler's
  `forceSync` settles only when the run finishes, queue wait included),
  `connector.reindex`, `index.regraph`, `agent.invoke` (`nimbus ask` / `prove` /
  `repl`), `workflow.run` (both `nimbus run <file>` and `nimbus workflow run`),
  `data.export`, `data.import` and `updater.applyUpdate`. Past 30 s the CLI printed
  `IPC request timed out after 30000ms: <method>` and exited 1 **while the operation
  ran to completion server-side** — so the command reported failure for work that
  succeeded, and a user who re-ran it queued the work twice. Eleven call sites, none
  of which passed an options object; `requestTimeoutMs` is a per-CLIENT constructor
  option, so the budget is opted into per command rather than raised globally, and
  fast RPCs keep the tight default. New `packages/cli/src/lib/rpc-timeouts.ts` owns
  the two budgets and the single constructor that applies them.

  (2) *The call blocks on a HUMAN.* The CLI answers the Gateway's `consent.request`
  from a `@clack` `confirm()` that runs **inside** the still-pending call's window, so
  the bound doubled as the user's think time — answer the y/n prompt slower than 30 s
  and the call it belonged to was already dead. This bit regardless of data volume, a
  one-item index included, and is the failure mode
  `lib/interactive-ipc-handlers.ts` already documented.

  Two hard bugs found alongside, each a total failure rather than a slow one:
  **`nimbus connector reindex <svc> --depth full`** is HITL-gated in
  `ipc/reindex-rpc.ts` but registered no `consent.request` handler at all, so the
  Gateway's gate never received `consent.respond` and the command failed **100 % of
  the time** independent of index size — the same defect, and the same fix, as
  `connector remove` in #1013. **`nimbus workflow run`** registered only the
  agent-chunk handler, so a HITL step hung to the timeout **without ever showing the
  user a prompt**; it now uses the same combined helper as its sibling `nimbus run
  <file>`, which also gives it `NIMBUS_SCRIPT_CONSENT_SOURCE` support. The existing
  `reindex --depth full` test could not have caught this: its mock resolves `call`
  immediately and never raises the notification, so it passed while the command was
  broken.

  A **dead** Gateway never depended on these timers — `IPCClient.failAll` rejects
  every pending `call()` on socket close or error — so a long budget still fails fast
  when the socket dies. The timers backstop only a Gateway that is alive and silent,
  which is why the new budgets are long but **finite**: `requestTimeoutMs: 0` disables
  the timer outright and restores the hang-forever behaviour the transport's own
  docblock records it was added to prevent.

  The Tauri bridge had the same gap from the other side: `workflow.run` was in
  `ALLOWED_METHODS` but not in `NO_TIMEOUT_METHODS`, so the desktop UI aborted the
  identical call at 30 s; it joins the list (now six, with the count-pinned I7 tests
  updated).

  **Not** fixed here, and deliberately: the structurally correct end state is to
  convert these methods to the `LongRunningJobRegistry` `{ jobId }` + notification
  shape the repo already uses for `index.reembed`/`index.rebody` (and which
  `commands/glossary.ts` documents this exact 30 s bound as the reason for). That is
  a larger change with real constraints — `index.regraph` is a clean candidate, but
  `connector.reindex` is in the I2 HITL frozen set and moving its gate inside the job
  would return `{ jobId }` before the owner consents, and migrating `ask` to the
  already-correct `engine.askStream` would drop the `--agent` selector its params do
  not carry. Until then a timed-out command still leaves non-gated server-side work
  running with no way to cancel it; HITL-gated steps do fail closed on client
  disconnect (`ipc/consent.ts`), and that rejection is audit-logged.

- **2026-08-14 — the one-liner install is documented again, and #1167 is closed
  (docs only).** The 2026-08-13 entry below held the `curl | sh` / `irm | iex`
  one-liner back from user-facing docs for two stated reasons; both are now
  discharged. (1) `v2.4.1` is the first published release whose
  `releases/latest/download/install.sh` and `releases/latest/download/install.ps1`
  are the download-capable scripts, so the documented URL now serves a script that
  can do what the docs claim. (2)
  `released-install-smoke.yml` is no longer unproven: its `release:` trigger fired
  on `v2.4.1` and **all six jobs passed** (run `31791116081`) — `documented install`
  and `documented one-liner` on ubuntu-24.04, macos-14 and windows-2022, the last of
  those covering **both** PowerShell 7 and stock Windows PowerShell 5.1, which had
  never once passed before the `EAP=Continue` fix in #1179. That run is also the
  first green exercise anywhere of the GPG **true-positive** path. `README.md` and
  the install guide now document the exact spellings that green run executed —
  `curl … | sh -s -- --yes` and `& ([scriptblock]::Create((irm $url))) -Yes`, the
  latter because `iex` cannot pass `-Yes` through. macOS and Windows **lead** with
  the one-liner; **Linux deliberately still leads with the `.deb`**, the only path
  that resolves `bubblewrap`/`libcap2-bin`, and offers the one-liner beneath it as
  the no-`sudo` alternative. The extract-then-run archive path stays documented on
  every platform, itself covered by the `documented install` jobs. So **every command
  that actually installs Nimbus is now backed by a green post-release job** — which
  is precisely what #1167 lacked. One documented command is still covered by no job:
  the manual `gpg --keyserver … --recv-keys` / `gpg --verify` snippet in the install
  guide's Linux tab, which `documented install` skips (it installs the `.deb`
  directly). That gap is named here rather than rounded away.
  Three honesty corrections ride along, all verified against the installer sources
  rather than restated from the previous docs: the Linux one-liner is **x86-64 only**
  and only *warns* about `bubblewrap` (the `.deb` remains the sole path that resolves
  dependencies); the archive path performs **no download and therefore no
  verification**, making it strictly less checked than the one-liner it was offered
  as the cautious alternative to; and signature verification is skipped — with a
  labelled `SIGNATURE NOT CHECKED` notice, never silently — when **`gpg` is missing
  or unrunnable**, not only when the `.asc` is unavailable. The install guide's
  standing claim that the installer "configures the Gateway to autostart with your
  session" was **false on all three platforms** and is removed; the same file's
  "What the installer does" section already said the opposite.
- **2026-08-14 — Sentry error issues are now attributed to people (no schema change,
  no re-sync).** A new graph edge, `person --assigned--> error_issue`, built from
  Sentry's `assignedTo` actor. Unlike the PagerDuty half of this feature (below), this
  needed **no connector change, no re-sync, and no new Sentry token scope**:
  `sentry-issue-mapping.ts` already stored `assignedTo` raw in `item.metadata` (shipped
  in #1172 for exactly this reason), so `nimbus index regraph` rebuilds attribution for
  every Sentry issue already in the index, from stored rows alone, with no network call.
  Only a `type: "user"` actor with a usable email resolves to a person; Sentry also
  allows assigning an issue to a team, and a team has no canonical email, so a
  team-assigned issue attributes to nobody by design rather than minting a person row
  that would pollute every people-based brief. **Sentry gets no "resolved by" edge** —
  determining who resolved an issue needs a per-issue activity-feed request, a
  request-per-issue cost the design declined to pay rather than guess at. The edge is
  read only by the new `nimbus negotiate` incidents lane, which reports Sentry
  error-issue assignments (`errorIssuesAssigned`) as a count and a rendered line kept
  **separate** from the PagerDuty incident counts, never summed into them: an error
  group that never paged anyone is not an incident. **Open caveat carried forward:**
  whether a real Sentry user actor's payload actually carries an `email` field is still
  unverified against a live API response; the populator fails closed on a shape
  mismatch — a missing or malformed `email` yields no edge rather than a wrong one —
  and that is a deliberate posture, not an assumption that the shape is correct.
- **2026-08-14 — PagerDuty incidents are now attributed to people (no schema change).**
  Two new graph edges: `person --assigned--> incident` (from `assignments[].assignee`)
  and `person --resolves--> incident` (from the actor who moved a resolved incident to
  `resolved`, `last_status_change_by`). `resolves` is read by `nimbus catchup`, `nimbus
  expert` (a wired `subIncidentResolved` lane, mirroring `subPrReviewed`'s
  join-then-gap-note shape) and the new `nimbus negotiate` incidents lane; `assigned` is
  read only by `negotiate`'s incidents lane, which reports both edges as independent
  `resolved` / `assigned` / `unattributable` counts, never summed. Actor identity is harvested from
  the existing `include[]=assignees,acknowledgers,users`-expanded incidents-list call
  first, falling back to a capped, sequential `/users/{id}` lookup
  (`MAX_USER_LOOKUPS_PER_SYNC = 25`) only for ids the page left unexpanded. **Scope
  change: assignee attribution needs no new PagerDuty token scope — it rides the
  existing incidents-list call — but resolver attribution's `/users/{id}` fallback
  needs a token with user-read access; a token scoped before this feature existed gets
  a 403 there, which degrades to an unattributed incident (logged, counted) rather than
  failing the sync.** A service-type actor (auto-ack/auto-resolve) attributes to
  nobody and is never counted as a loss. Recovery for incidents indexed before this
  shipped: they carry `metadata.meta_v` below `PAGERDUTY_INCIDENT_META_VERSION = 1`,
  which makes them eligible for `nimbus index rebody --service pagerduty` to re-fetch
  and backfill attribution; the connector's own re-walk depth is bounded by its
  `initialSyncDepthDays = 30` unless `--since` is supplied, which `rebody` now passes
  through and the connector honours on a cold start via `SyncContext.historyFloorMs`.
  This command was not executed as part of this delivery — no live PagerDuty
  credentials were available in this environment — so no real recovery-window number
  is claimed; the above is the structural behavior, verified by reading the connector
  and `index-rebody-rpc.ts` source, not by running the command. **Open pre-merge
  requirement:** two payload-shape assumptions — whether `include[]` expands
  `last_status_change_by`, and the exact assignee-reference shape — are unverified
  against a real PagerDuty API response and remain so; a human with credentials must
  capture a real payload and add it as a fixture before this ships.
- **2026-08-13 — `install.sh` / `install.ps1` can now install from a published release
  (#1167, partial).** Both installers gain a remote mode: `--from-release [<ver>]` /
  `-FromRelease <ver>` downloads the versioned asset from
  `.../releases/download/<tag>/...`, sha256-verifies it against `SHA256SUMS` (an
  **exactly-one-match**, case-sensitive, `^[0-9a-f]{64}$`-format rule on both scripts —
  a mirror/proxy that prepends a shadow line for the same filename is rejected, not
  first-match-accepted), and best-effort-verifies the GPG signature against the
  embedded, pinned Nimbus release key (degrading to a clearly labelled
  SIGNATURE-NOT-CHECKED notice when `gpg`/the `.asc` is unavailable — never a silent
  downgrade). **The `curl | sh` / `irm | iex` one-liner is deliberately still absent
  from user-facing docs** — issue #1167 is **not** fully closed by this PR; only the
  underlying capability is real. Two reasons it's held back: (1) the capability
  becomes true for real users only starting at the **next** release — until then,
  `releases/latest/download/install.sh` continues to serve the old local-staging-only
  script, so publishing the one-liner today would point at a script that can't yet do
  what it claims; (2) `released-install-smoke.yml`, the new workflow that installs a
  **real published release** end-to-end on all three OSes, ships **unproven** — it has
  no `push` trigger and must be hand-dispatched once a real release exists. It is also
  the **only** place anywhere (in this PR or the existing suite) that exercises the
  GPG **true-positive** signature path — the pinned-fingerprint comparison and the
  `$NF` primary-fingerprint extraction (the real key signs via a dedicated signing
  subkey, so a naive substring match on the subkey fingerprint would silently reject
  every genuine signature) are covered by **nothing else** in-repo, by deliberate
  decision (a test-only fingerprint-override seam was rejected as a bypass footgun
  for a `curl | sh` script — see the PR body). Other user-facing fixes bundled in:
  `install.ps1` wraps its downloads in `$ProgressPreference = "SilentlyContinue"`,
  measured at **22.8s → 0.13s (~182×)** for an 83.7 MB archive on real Windows
  PowerShell 5.1 — a genuine 5.1 console-progress-rendering bottleneck, not a CI
  workaround; the declared PowerShell floor moved **7+ → 5.1**, with the old
  declarative `#Requires` replaced by a runtime version check (`#Requires` is inert
  under `iex`, which is exactly how #1167's bug manifested); `--from-release` /
  `-FromRelease` now **forces** remote mode even when binaries already sit staged
  beside the script — a real behaviour change, since `release.yml` ships both
  installer scripts *inside* every macOS tarball and the Windows zip, right next to
  the binaries they'd otherwise silently prefer; `--local` + `--from-release`
  together is now a hard error on **both** scripts (the Unix script moved off
  last-wins to match); and the Linux/`.deb` install instructions on the two surfaces
  #1169 missed move from `sudo dpkg -i` to `sudo apt install ./...deb` (dependency
  resolution). Red-proven on Linux (Docker `oven/bun:1.3`): RED
  <https://github.com/nimbus-agent/Nimbus/actions/runs/31700876964> and
  <https://github.com/nimbus-agent/Nimbus/actions/runs/31713026480>, GREEN
  <https://github.com/nimbus-agent/Nimbus/actions/runs/31713429813>.
- **2026-08-13 — `nimbus doctor --fix-keyring` (Linux, #1168).** Deterministically
  creates the default Secret Service collection (`login.keyring`) via
  `dbus-run-session` + `secret-tool`, closing a measured **~1-in-40-to-50 D-Bus
  name-ownership race** between the unlock and the next Secret Service client (a
  from-scratch box that only waits on file existence still loses that race ~1/15;
  polling ownership of `org.freedesktop.secrets` does not), and enforces `0700`/`0600`
  permissions that gnome-keyring itself does **not** — a pre-loosened `0755` directory
  or `0666` keyring is silently accepted and served uncorrected today. Refuses outright
  (never overwrites, truncates, or touches) whenever ANY pre-existing `*.keyring`
  material or a `default` pointer is already present. **This is justified by what was
  measured, not by #1168's stated premise**: the issue (and the launch-execution notes
  behind it) claims the printed remedy fails because `--unlock` must create the
  collection, escalates to `gcr-prompter`, and dies with "cannot open display" — **that
  root cause does not reproduce**, independently, on a clean `ubuntu:24.04` container
  or across a 55-trial spike; the issue's text needs correcting when it closes, not
  reused as this command's justification. One thing the fix does **not** change:
  **`dbus-run-session` remains required for every `nimbus start`**, not only the
  first — a fresh session that skips its own `--unlock` still fails on a from-scratch
  box even with `login.keyring` already on disk from a prior `--fix-keyring` run.
- **2026-08-12 — `nimbus negotiate`: the fourteenth built-in agent, a cited contribution brief.**
  `agents.negotiate` / `nimbus negotiate [--since <duration>] [--person <id>] [--json]`. Six
  parallel `AgentCoordinator` lanes assembled entirely from evidence already in the local index —
  no connector is opened and nothing is fetched live, including for `--person`, which briefs a
  different already-indexed person from the same local data, never a live one: PRs authored (with
  size stats where the enrichment pass has reached them), PRs reviewed (approve /
  changes-requested / other), tickets opened and tickets closed by an authored PR, code and
  services owned, decisions authored, and documents/notes/messages written. `--since` defaults to
  90 days and tops out at 365 — negotiate's own bound, wider than the shared 90-day `MAX_SINCE_MS`
  every sibling agent uses, sized for an annual review cycle; a request above it is rejected
  outright (exit code 2), never silently clamped.
  **Every item-backed lane cites its evidence.** A count with no way to check it is an
  assertion, not evidence — "12 PRs" reads exactly like "40 PRs" to someone who cannot open
  either. Each of the five item-backed lanes carries up to `NEGOTIATE_EVIDENCE_LIMIT` (5)
  refs — title plus `COALESCE(item.canonical_url, item.url)` — ordered `modified_at DESC, id
  ASC` so an unchanged index cites the same items on every run. Truncation self-discloses:
  `NegotiateEvidence.total` holds the full population, so a capped list renders "…and N more
  not listed" rather than reading as exhaustive. A ref with no url renders as plain text,
  never as an empty link and never as a fabricated one. Two deliberate omissions: ownership
  carries no refs (it already enumerates the services and directories it counted), and the
  tickets lane cites only the issues the subject OPENED — citing the `closed by an authored
  PR` hop would list issues someone else filed. The writing lane's evidence query reproduces
  the `personal_sources` gate exactly, so a personal note can never appear as a citation
  under a brief whose `sources` block says personal docs are off.
  **Personal sources are off unless configured.** Confluence pages and chat messages are always
  in scope; Obsidian notes and Notion pages are mined only when their service is named in
  `[negotiate] personal_sources` in `nimbus.toml` — configuration IS the consent, following the
  `[glossary.terms]` precedent, resolved per SERVICE (not per item type) because Confluence and
  Notion both emit `type: "page"`. Entries are case-folded at parse time, "configured" means the
  INTERSECTION with the recognised personal-capable services rather than merely a non-empty list,
  and an entry naming nothing is echoed back in the brief as ignored — so a mis-typed or
  mis-capitalised opt-in can never render an undercount as complete coverage.
  **An unresolvable `--person` is disclosed, never briefed as zero.** An explicit `--person` id
  that matches no `person` row raises a `missing_user_identity` gap stating the counts below are
  STRUCTURALLY zero rather than measured. This covers the `git:<email>` blame-alias shape
  specifically — the identity the ownership pass emits for a git email with no `person` row, and
  therefore not a `person.id`: the three lanes keyed on `item.author_id` can never match it, and
  the `authored`/`opened` graph edges are built from `item.author_id` too, so PRs authored and
  tickets cannot either — five of the six lanes are structurally zero. Only the ownership lane can
  still measure it (it is the sole lane reading `owns` edges, the only edges that ever carry a
  `git:` external id), so the two cases state different facts and are not collapsed.
  Without it, an unresolvable id rendered as a person who shipped nothing.
  **Six limits stated on every brief, never decoration.** The window is "ACTIVE in", not
  "created in": `item` carries no creation timestamp, only `modified_at` (GitHub's `updated_at`,
  the last touch), so every item-backed lane windows on last-modified and the brief says so —
  otherwise "40 PR(s)" under a 90-day header reads as 40 authored this quarter when it means 40
  authored at any time and touched this quarter, a systematic overstatement of the headline
  numbers. (Two lanes sit outside the window: decisions windows on `decision_record.decided_at`,
  a real decision date, and ownership is not windowed at all — it is an all-time snapshot.)
  Ownership carries the same **authorship-derived, not accountability** label `nimbus owners`
  states unconditionally — it reads the same git-blame-derived `owns` edges, and under a
  contribution brief an unlabelled "services: checkout" reads as formal accountability. Ownership
  counts only
  `git_blame_line` rows whose git email maps to a known `person` row — work committed under an
  unmapped alias (a second machine, an old address, a GitHub `noreply` address) is attributed
  elsewhere and not counted; the brief flags this for a self subject when it can detect it, and
  never guesses for an explicit `--person` subject, since someone else's alias set is unknowable
  from here. Ownership can also be stale, or never computed at all: the lane reads the
  precomputed `owns` graph, not a live derivation, so every brief states when that background
  pass last ran, or names `nimbus owners --refresh` when it never has. PR size stats exist only
  where the enrichment pass has run, so `authoredPrs.stats` carries its own `statsCoverage`
  (covered of total) rather than implying completeness. `decisions.unattributable` is a fact
  about the INDEX, not the subject — decisions mined from a source (Obsidian, Teams) that
  records no author at all — and the render spells that out, since reading "N authored, M
  unattributable" as "N + M decisions are mine" turns an undercount into an overstatement.
  Incidents resolved, on-call shifts, and deploys triggered are not available in the index at
  all — named unconditionally on every run, so an empty section is never read as a zero.
  **Not reachable over the HTTP API — nor as an MCP tool**, for a different reason than
  `agents.preflight` / `agents.premortem` (excluded for their side effects): `agents.negotiate`
  writes nothing, but
  combined with `--person` an HTTP-exposed version would let any holder of the `agents` bearer
  token — or any model driving the MCP tool server — assemble a contribution dossier on any
  indexed person without the local owner initiating it. The CLI and Tauri renderer are
  same-machine, owner-initiated surfaces (I7's XSS threat model, not "arbitrary network caller");
  the local HTTP API is not. Tauri `ALLOWED_METHODS` 105 → 106 (I7); no new invariant and no
  schema change. Documented in `docs/cli-reference.md`'s `nimbus negotiate` section, the
  built-in-agent table + IPC-method catalogue in `docs/architecture.md`, and `docs/roadmap.md`.

- **2026-08-12 — Sentry issues are now indexed** (`sentry:error_issue`). The connector previously
  indexed only projects. Issues are pulled org-wide, windowed by `lastSeen` with a 30-day cold
  start, and include resolved issues. Requires the Sentry auth token to carry the **`event:read`**
  scope — a `project:read`-only token continues to sync projects but logs a warning and indexes no
  issues. Assignment is captured but not yet attributed to a person.
- **2026-08-11 — `EgressCompleteness.tier` is gone; the coverage vector is the only claim (#1057).**
  The last step of a three-repo sequence. `tier: "authorized-actions"` was a deprecated additive
  wire shim, kept because the published `@nimbus-dev/client@0.15.x`'s `validateEgressCompleteness`
  hard-throws when the field is absent — so a gateway that simply dropped it would have broken
  every published-client consumer, nimbus-vscode included.

  **Why it had to go rather than be corrected.** Its own precondition was that `THIS_BINARY_COVERAGE`
  had exactly ONE non-`none` class (`task` at `per-call`), so that "authorized gated-connector
  actions, one row per call" described the whole of what the binary observed. That stopped being
  true three times over — `mcp`, then `http`, then `sync` — and a single scalar cannot describe four
  classes at two granularities. It misstated coverage in exactly the way the pre-vector scalar
  `tier` had, which is the defect the `coverage`/`indeterminate` shape was introduced to fix.

  **The sequence, in order:** `@nimbus-dev/client` dropped its dependency on the field and published
  (nimbus-client#58 → **0.16.0**, not the 1.0.0 the issue anticipated — the `Release-As` trailer was
  written into the PR description per the Nimbus convention, but the satellite repos squash the
  LOCAL commit message, so it never reached `main` and `bump-minor-pre-major` applied; the effect is
  the same, since `^0.15.x` does not resolve to `0.16.0`). nimbus-vscode then bumped to `^0.16.0`
  and rewrote the half of its proof artifact that READ the field — it had rendered "Completeness
  tier: authorized-actions — every gateway-authorized outbound action in the window", a totality
  claim that was never true for a class at `none`. Only then does the gateway stop emitting it.

  **What is removed here:** the field from `EgressCompleteness` and from `proveWindow`'s literal;
  its assertion in `egress-verify.test.ts`; the tolerant optional `tier?: string` on the CLI's
  `ProveCompleteness` (which was documented never to be read for a decision, and was not); the
  "Outstanding debt this change creates" paragraph in `docs/SECURITY-INVARIANTS.md` § I29; and the
  matching "Related debt" sentence in the `nimbus-egress` skill. Per the repo rule, retiring a
  defence means deleting the row rather than leaving drift behind. No schema change, no invariant
  change — I29 itself is untouched, since `tier` was never part of what it enforces.

- **2026-08-11 — Web clips embed locally, and the index stops advertising text it discarded
  (#1006 + #1005).** Two defects that had to be fixed together, because the obvious fix for
  either one regressed the other.

  **#1006 — clip text was reaching OpenAI.** `nimbus:web_clip` was in `PROSE_HEAVY_TYPES`, which
  `RoutingEmbeddingPipeline` reads to send an item to the 1536-dim OpenAI embedder whenever
  `openai.api_key` is set. Both web-clipper store listings state the opposite — the Chrome listing
  says clips go "into your private, local-first Nimbus index", and both it and the AMO privacy
  policy say there are "no remote servers, no telemetry, and no cloud". The listings describe the
  *extension*, which does only talk to loopback, so each sentence was narrowly true while the
  system as a whole was not. `nimbus:web_clip` is now removed from `PROSE_HEAVY_TYPES`: clips
  always embed on-device via MiniLM-384, whether or not a key is configured. Retrieval quality on
  long articles is the deliberate price. **Note this was live, not theoretical** — the issue was
  filed when clips were never embedded at all, but `scheduleEmbedding` has been wired through
  `assemble.ts` → `clip-ingest.ts` since, so the egress was actually occurring.

  **The coupling that made this a two-part fix.** `bodyCapForItemType` derived the 16 KiB body cap
  *from `PROSE_HEAVY_TYPES`*, so simply removing the clip type — the fix #1006 recommends — would
  have silently cut the clip body cap back to 512 characters and re-opened #1005, with no test
  between the two to notice. Storage shape and embedding destination are now separate questions:
  `body-caps.ts` owns `LONG_BODY_TYPES`, the explicit union of `PROSE_HEAVY_TYPES` (prose-heavy
  for routing) and the new `LOCAL_ONLY_PROSE_TYPES` (prose-shaped but pinned to local embedding).
  Note the relationship precisely, because it is easy to state backwards: the two SOURCE sets —
  `PROSE_HEAVY_TYPES` and `LOCAL_ONLY_PROSE_TYPES` — must stay **disjoint**, and `routing.test.ts`
  pins that; `LONG_BODY_TYPES` is their **union**, so it is a superset of each and disjoint from
  neither. Disjointness of the sources is what carries the privacy property: absence from
  `PROSE_HEAVY_TYPES` is the *whole* of the enforcement, so a key in both would read as "pinned
  local" while routing remotely. `body-caps.test.ts` asserts the cap and the routing
  together in one test, since each passes alone precisely when the coupling breaks.

  **#1005 — `wordCount` described text the index had thrown away.** `POST /v1/clips` accepts 1 MiB;
  the store clamps the body to 16,384. `wordCount` was computed on the submitted text, so a 34,000-
  character article was stored at 16 KiB while its metadata advertised the full length, and no
  field let a caller detect the loss. `wordCount` now measures the **stored** body — what a search
  can actually return — and an over-cap clip additionally carries `sourceWordCount` + `truncated:
  true`. A clip that fits carries neither, so the common shape is unchanged. Both keys surface
  through `clip.list`, and `nimbus clip list` footnotes the count of partial clips rather than
  widening its fixed-width table. A legacy row carrying neither key reads as *not* truncated,
  which is what absence meant when it was written. The counts reuse the store's own
  `bodyCapForItemType` + `clampBody`, so they cannot drift from the storage rule, and the clamp
  runs only on the rare over-cap clip.

  **Migration.** Clips already embedded through OpenAI keep their 1536-dim vectors: `index.reembed`
  is model-targeted and `embedItem` deletes only the chunks for the model it is writing, so
  re-embedding locally would *add* MiniLM vectors beside the existing OpenAI ones rather than
  replace them (and `vectorSearchChunksDual` concatenates both tables without deduping by item).
  To move an existing clip fully local, `nimbus clip delete <id|url>` and re-clip it —
  `embedding_chunk.item_id` is `ON DELETE CASCADE`, so that drops every model's chunks and the
  `AFTER DELETE` triggers clear both vec tables. **Text already sent to OpenAI cannot be recalled**;
  this change stops future egress, it does not undo past egress. No migration, no schema change,
  no new invariant.

- **2026-08-11 — GitHub connector: pull-request review depth (no schema change).** A review you
  leave on a GitHub pull request is now indexed as its own `review` item, and the graph gains a
  `person --reviewed--> pr` edge for it. `nimbus expert` surfaces reviewers as `pr_reviewed`
  evidence and `nimbus why` names them in its pull-request finding; both now emit an explicit gap
  note — instead of going silently empty — when a reviewed edge exists but does not resolve to an
  indexed reviewer. Three limits, documented in
  [`docs/connectors/github.md`](./connectors/github.md#pull-request-reviews): reviewing a pull
  request indexes that pull request, including ones you did not author, since that is what lets a
  review link to a titled PR rather than a bare id; this indexes pull requests you reviewed, never
  who reviewed your pull requests, because the GitHub events feed reports only the authenticated
  user's own activity; and coverage is bounded by the events feed's retained window (GitHub caps
  it at 300 events / 30 days, and Nimbus reads one page of 100 per tick) — a first successful sync
  does index recent events created before installation, since that trailing window is what it
  reads, but reviews older than the retained window, or beyond the per-tick page cap, are not
  recoverable by syncing, and a review deleted upstream leaves its graph link in place. Separately, PR size stats (`additions`,
  `deletions`, `changed_files`, `commits`) are now captured, and the enrichment pass also re-fetches
  PRs that have a real title but no stats. A secondary-rate-limit bug is fixed alongside: a 403
  carrying `retry-after` is now honored even when quota remains.
- **2026-08-11 — `nimbus pre-mortem`: the thirteenth built-in agent (PR B of the S1 pre-mortem
  work).** Reads the schema + background pass PR A shipped 2026-08-09 (V53) and adds the missing
  reader: `agents.premortem`, `nimbus pre-mortem <epic-ref> [--service <name>]… [--json]
  [--refresh] [--repropose]`. Four SEQUENTIAL lanes, not `AgentCoordinator`-parallel, since each
  depends on the previous one's output: resolve the epic to its affected services, build an
  IDF-weighted service-overlap cohort of comparable closed epics, compute five structural risks
  over that cohort, and read recurring blocker themes from the V53 pass.
  **Jira-only, and narrower still: team-managed-Jira-only.** Affected-service derivation walks
  `parent_key`-linked children, and `jira-sync.ts` only populates `parent_key` on team-managed
  projects — a company-managed epic resolves to zero derived services, reported as a named gap.
  No `linear:project` items are indexed at all, so a `linear:` reference is reported as an
  unsupported-tracker gap, never silently ignored.
  **The one built-in agent that is not purely read-only.** `proposeWatchers`
  (`premortem/watcher-proposals.ts`) writes exactly two things per affected service that resolves
  to a configured deployment-service id: a `watcher` row always inserted with `enabled = 0`
  (paused), and its `premortem_watcher_proposal` tombstone — both in one transaction, so a watcher
  row can never exist without its tombstone. A service that resolves to nothing gets neither row. This is
  **not** an I2/HITL matter: I2 governs `HITL_REQUIRED_BACKING` action types that leave the
  machine via `engine/executor.ts`'s `gate()`, and a local SQLite insert never reaches that gate —
  the same shape as `glossary`/`decisions`/`ownership`'s own local writes, and the egress
  ledger's. The safety property is `enabled = 0`: `automation/watcher-store.ts`'s
  `listEnabledWatchers` filters strictly on `enabled === 1`, so a paused row is structurally inert
  until a human arms it through the existing watcher-arming path — `nimbus pre-mortem` never arms
  anything itself. `--repropose` deletes only the target epic's tombstones before proposing, so a
  deliberately-deleted watcher is re-created (paused) rather than staying `suppressed`; never a
  global clear.
  **A proposal is scoped by AFFECTED SERVICE, and the watcher engine learned that axis in this
  same change.** The condition carries `filter.affectedService` — the `[metrics.dora.<id>]` /
  `[ci.service.<id>]` id the repo resolves to — which `automation/watcher-engine.ts` matches
  against the incident's `graph_entity.metadata.affectedService` (written by
  `graph/graph-populator.ts`'s `syncTimelineEventGraph`) through an EXISTS subquery with bound
  parameters. The pre-existing `filter.service` axis matches the `item.service` COLUMN, which for
  an incident is always the connector id `pagerduty`, so it could only ever scope a watcher to a
  whole connector; a proposal written on that axis was inert even once armed. The new filter is
  declared per condition kind (`affectedServiceEntityType`) and FAILS CLOSED: a kind with no
  timeline entity (`alert_fired`) matches nothing rather than silently widening, and
  `watcher.create` rejects it up front. **A repo with no configured deployment-service mapping
  gets no watcher at all**, named in the brief — falling back to the repo path is what produced
  the inert proposal. Proposals also no longer depend on the cohort: they are a function of the
  target's own services, so a first-of-its-kind epic still gets them.
  **No deploy-failure watcher is proposed.** Deploy-failure is a watcher CONDITION KIND, not one
  of the five risks above — the fifth risk is abandonment, and no deploy-failure risk is computed.
  The engine now supports the same scoping for `deploy_failed`,
  so the old `item.service`-is-the-provider-slug reason no longer applies; what still does is that
  `deployment/annotate.ts` — the only writer of the `metadata.conclusion` that condition matches —
  inserts its `item` row directly and creates no `deployment` graph entity, so such a watcher
  matches nothing until `nimbus index regraph` runs.
  **Review drag cannot currently be measured for ANY repo**: no connector indexes a pull
  request's *opened* timestamp (only `merged_at`), so the brief states this and reports a named
  gap rather than a fabricated figure. The measured path is real and activates the moment a
  connector records that field. The cohort/baseline queries match
  `COALESCE(metadata.repo, metadata.project)`, so a GitLab merge request (which carries only
  `project`) is counted in the population the cohort was selected from — previously the brief
  built a GitLab cohort and then reported "no pull requests were found" for it.
  **A missing epic creation date is reported as a missing date**, not as a brand-new epic: the
  cycle-time risk no longer substitutes `now`, so the brief no longer implies youth it never
  measured.
  **Incident coupling** translates a cohort repo to a DORA `[ci.service.<id>]` config id via the
  injected `ServiceIdentityResolver`, denominates its rate on `measured` — cohort members actually
  queried (a resolvable service AND a usable window) — never on the full cohort, and states the
  skipped count when they differ; it reports `null`, never a fabricated `0`, when nothing could be
  checked.
  **Confidence tops out at 0.86**, matching `glossary`/`decisions`: no connector indexes ticket
  comments, so a blocker argued out entirely in a Jira comment thread is invisible to theme
  extraction.
  `agents.premortem` is **excluded from both the HTTP agent surface**
  (`POST /v1/agents/{agent}`) **and the MCP tool surface**, matching `agents.preflight` —
  `HTTP_EXCLUDED_AGENT_METHODS` in `ipc/agents-rpc.ts` — because an external caller reaching a
  write with no HITL gate is the same shape of concern preflight is excluded for. It **is** on
  Tauri's `ALLOWED_METHODS` (I7; count 104 → 105), since the renderer sits behind the I7 XSS
  threat model rather than "arbitrary network caller"; `premortem.refresh` (unchanged from PR A)
  is not Tauri-exposed. The completion notification is `premortem.briefReady` (error:
  `premortem.briefError`), per the standard `<agentName>.briefReady` contract — `agents.premortem`
  is the RPC method, not the notification. No new invariant, no new migration — schema was V53
  already.
- **2026-08-10 — Targeted fetch names the cause of a miss (no schema change).** `FetchOneResult`'s
  `not_found` arm now carries a REQUIRED `reason: "no_credential" | "unauthorized" | "absent" |
  "unreachable" | "upstream_error"`, wired at every miss site across all five `fetchOne`
  connectors (github, gitlab, bitbucket, jenkins, jira). The one `!res.ok` miss site per connector
  delegates to a shared mapper, `connectors/fetch-miss-reason.ts`'s `fetchOneMissForResponse` — a
  status code in, a typed outcome out, never a `Response`/body/URL; every OTHER miss site (a
  malformed body, a missing field, an unsupported URL shape — roughly 25 sites across the five
  connectors) returns a fixed enum literal directly rather than going through that mapper. Either
  way no site can carry provider text or a Vault-stored base URL: the mapper by construction, the
  hand-written sites because a literal has none to leak. `reason` is required by the type, not by
  convention: a `not_found` site that omits one is a compile error. A provider 429 now routes to
  the already-handled `rate_limited` arm rather than arriving as an undifferentiated `not_found` —
  the shared mapper special-cases it before falling through to `upstream_error`.
  `sync/targeted-fetch.ts`'s `TargetedFetchOutcome` (the
  `POST /v1/items/fetch` wire type) surfaces `reason` on its own `not_found` arm, and its
  `not_configured` arm gains an OPTIONAL `service`, populated only where the derived fetch-host
  boundary already resolved one before the miss (a bare host miss still has nothing to name and
  stays `{ status: "not_configured" }`). **Wire change — additive only, no new `status` arm**: old
  clients (including `nimbus-web-clipper`, which maps an unrecognized `status` to `server_error`)
  ignore the new fields and keep working. `no_targeted_fetch` behaviour is unchanged — every
  connector without a `fetchOne` still answers it, unaffected by this PR.
- **2026-08-10 — `nimbus connector auth` validates a credential before storing it (no schema
  change).** A live identity-endpoint probe (`connectors/credential-probe.ts`) now runs against the
  credentials in the request BEFORE any Vault write, for five PAT-based connectors — github,
  gitlab, bitbucket, jira, jenkins — one cheap `GET` against each provider's own identity endpoint
  (`/user`, `/rest/api/3/myself`, `/api/json`, ...), bounded by a 10s timeout so an interactive
  command can never hang indefinitely on a stalled provider. Only an HTTP 401 rejects: the
  credential is never stored, `nimbus connector auth` throws, and the CLI exits `1` — a
  user-actionable precondition (fix the token, retry). A 403 stores as unverified rather than
  rejecting: verifying a CREDENTIAL, a 403 is proof it authenticated (the opposite reading from
  fetching a specific ITEM, where a 403 means the user cannot have it either way — the two modules'
  deliberately divergent 403 handling is documented on both). An unreachable provider (timeout, DNS
  failure, 5xx) also stores as unverified and exits `0`. The ~14 other PAT-based connectors have no
  registered probe and store as before — reported honestly as unprobed, not silently claimed
  verified. A new `reauthenticated` health event (`connectors/health.ts`) clears a stuck
  `unauthenticated` health state on a successful re-verify — `LocalIndex.markConnectorReauthenticated`
  is called only when the probe actually returns `valid`, never on an unverified store, since
  `SKIP_HEALTH_STATES` blocks the scheduled sync path for anything still `unauthenticated` and a
  re-authenticated connector would otherwise stay permanently unsynced. The CLI's unconditional
  `Signed in: <service>` — which claimed a check that never happened for most connectors — is
  retired in favor of three honest outcomes: `Verified: <service>`, `Stored: <service> (NOT
  verified — the provider did not confirm it)` (with a follow-up line suggesting a retry), and
  `Stored: <service> (not verified)`. The middle case deliberately does NOT claim the provider was
  unreachable: that verdict also covers a 403, a 429 and a 5xx, where the provider answered. All
  three still exit `0`: the credential was stored, which is what the command was asked to do.
  Documented in `docs/cli-reference.md`'s `nimbus connector auth` section.
- **2026-08-10 — Gateway lifecycle diagnostics: the silent-exit blind spot.** The gateway could end
  without writing a single line: its only process-level hooks were `SIGTERM`/`SIGINT`, and the only
  code that logged anything about termination was the `shutdown()` path those two signals reach.
  On Windows neither signal is deliverable — `process.kill(pid, "SIGTERM")`, which is exactly what
  `nimbus stop` issues, is `TerminateProcess(handle, 1)`: measured on Windows 11, the `SIGTERM`
  handler does not run, an `exit` handler does not run either, and the process ends with code 1 and
  no output. So a deliberate `nimbus stop` and an unexplained death left byte-identical evidence:
  nothing. `platform/exit-diagnostics.ts` now arms on the first statement of `main()` and writes
  pino-shaped records with `appendFileSync` (the daily logger is `pino.destination({ sync: false })`,
  whose buffered final write is precisely the one an abrupt exit loses): `boot`, a `heartbeat`
  carrying uptime/rss/heap/in-flight-syncs/embedding state, `before_exit` (the event-loop-drain
  discriminator), `process_exit` with the code and a `drained` flag, and `uncaught_exception` /
  `unhandled_rejection` with full stacks — the last two preserving exit code 1 rather than
  swallowing the failure. Because no in-process handler can observe `TerminateProcess`, the
  **absence** of a `process_exit` record is itself the diagnosis: the process was killed from
  outside, and the last heartbeat bounds when. Heartbeat interval via `NIMBUS_HEARTBEAT_MS`
  (default 60 s, `0` disables); it is `unref`'d so it cannot mask the drain it exists to detect.
  Two silent-failure sites found alongside and fixed: the Windows named-pipe server's only `error`
  listener called `reject()` on an already-resolved promise, so every post-listen pipe fault was a
  no-op that still counted as a handler; and the embedding worker had no `onerror`, so a dying
  worker (verified: an uncaught throw in a Bun `Worker` neither crashes the parent nor prints
  anything) left semantic search reading as `warming` for the full 600 s init window instead of
  `unavailable`.
- **2026-08-10 — Watcher conditions: `incident_opened` + `deploy_failed`.** The watcher engine
  previously evaluated one condition type, `alert_fired`, which matches an item type no connector
  indexes; a watcher could be created and armed and still never fire. Both new conditions come from
  one condition-kind table that the engine and `watcher.create` share, so an unsupported
  `conditionType` is now rejected at creation rather than accepted and silently ignored.
  `incident_opened` narrows to `metadata.status = 'triggered'`, since PagerDuty re-indexes an
  incident on acknowledgement and resolution too — the tradeoff, recorded rather than fixed, is
  that an incident indexed with a null status (PagerDuty omitted the field, or returned a
  non-string) never fires this condition at all. `deploy_failed` covers CI-annotated deployments
  only, and its coverage limits are recorded in
  [`docs/architecture.md` § Watchers](./architecture.md#watchers). The desktop Create Watcher
  dialog now offers exactly these three condition types, with the graph predicate as an orthogonal
  option rather than a fourth condition type. Groundwork for `nimbus pre-mortem` PR B.
- **2026-08-09 — Pre-mortem recurring-blocker-theme extraction: schema + background pass (schema
  V53).** PR A of the S1 pre-mortem work — schema and a debounced background pass only.
  **THERE IS NO USER-FACING COMMAND IN THIS PR**: `nimbus pre-mortem`, the `agents.premortem`
  brief, cohort selection, and watcher creation are all a later PR. What ships here is a pass
  (`packages/gateway/src/premortem/`) that mines recurring blocker themes per service from closed
  epics — discover → extract (local LLM) → reconcile — off the same debounced post-connector-sync
  seam as `glossary`/`decisions`/`ownership`, gated on `[premortem].enabled` (default on). Schema
  **V53** adds four tables: `premortem_theme` (content-derived id = hash of service + normalized
  label, so a document edit earlier in the text never re-hashes a later theme and orphans its
  evidence), `premortem_theme_evidence` (composite-key, insert-or-accumulate — a re-supplied row
  is a no-op, not a duplicate), `premortem_pass_state` (a composite `(modified_at, id)` watermark
  checkpointed per batch, same pattern as `decision_pass_state`), and `premortem_watcher_proposal`
  — written by the follow-up PR, not this one; the table lands now because schema precedes its
  reader. A theme's `service` is the **affected** service an epic's work touched (`billing-api`),
  never the connector that owns the row (`jira`) — `epic-services.ts` derives it through the
  relationship graph, since PR B's theme lookup keys on the affected axis. Confidence is derived
  from evidence count with a hard 0.86 ceiling (`THEME_CONFIDENCE_CEILING`), never from the model.
  Reconciliation prunes evidence whose source item has left the index, then demotes (never
  deletes) a theme with no live evidence left — a demoted theme is the durable record of
  extraction budget already spent, so the next pass never re-mines it.
  **No-model behaviour distinguishes "could not run" from "ran and found nothing."** With
  `[premortem].use_llm = false`, no local model configured, or a transient provider failure, the
  pass stops WITHOUT advancing its watermark for the affected batch — the batch was never actually
  examined, so a later pass (once a working local model is available) still mines those same
  epics. Only a model that genuinely responded, with output that was empty or unparseable, burns
  the batch and advances the watermark — otherwise a persistently misconfigured provider would
  loop the same batch forever. `PremortemPassResult.noModel` surfaces the first case to callers.
  **The discover stage is Jira-only today**, and narrower still within Jira: it keys on
  `metadata.issue_type = 'Epic'` (`theme-discover.ts`), which only `jira-sync.ts` writes;
  `linear-sync.ts` never writes `issue_type`, and — the deeper reason — no `linear:project` items
  are indexed at all, so there is no Linear epic-shaped row to mine. Supporting Linear needs a
  connector change and is out of scope for this PR, even though the upstream workstream is named
  "Jira + Linear." Within Jira, `metadata.parent_key` — which the discover→services hop keys on —
  is populated only on **team-managed** projects; a closed epic on a classic company-managed
  project is still discovered but resolves to zero affected services, so the pass yields nothing
  for it.
  One IPC method, `premortem.refresh` — no parameters. The pass RESUMES from a persisted
  `(watermark_ms, watermark_id)` cursor rather than re-deriving its tables wholesale, so `refresh`
  mines only epics newer than the watermark, the same as `glossary`/`decisions`. No
  `premortem.rebuild` counterpart in this PR — not because there is nothing to rebuild FROM, but
  because there is no reader yet (`agents.premortem` does not exist here) and no vetoes to
  recover, so a reset verb would have nothing to visibly fix; it can land with PR B if a need
  shows up. LAN-forbidden (I5), and deliberately **not** in Tauri's `ALLOWED_METHODS` (I7; count
  stays 104, unchanged by this PR) — local/CLI-only, and there is no renderer-exposed read
  counterpart yet since `agents.premortem` does not exist in this PR.
- **2026-08-09 — Ticket depth (Jira + Linear)** — enough indexed depth on `jira:issue` and
  `linear:issue` for a consumer to select epics, tell delivered from in-flight, and measure cycle
  time. **No migration, no new item type, no new relation type**: `item.metadata` is a JSON column,
  so the new keys need no schema change. Both mappers write ONE shared, service-agnostic contract —
  `issue_type`, `status`, `status_category`, `status_category_raw`, `created_at_ms`,
  `resolved_at_ms`, `due_at_ms`, `parent_key`, `meta_v` — plus `project_id` for Linear only (Linear
  has no Epic issue type, so a project is its epic-shaped grouping). Key names are identical across
  the two services on purpose: **no consumer branches on service**. `status_category` is normalized
  at the mapper by `connectors/ticket-depth.ts` from `statusCategory.key` (Jira) / `state.type`
  (Linear) — never from a display name, which is renameable per-instance — into
  `todo | in_progress | done | canceled | unknown`, with the platform's own value preserved
  alongside as `status_category_raw` so normalizing destroys nothing. An unrecognized or absent
  value maps to `unknown`, never `todo`: "not started yet" is a claim, and a wrong one silently
  distorts every cohort built on it. The one genuine asymmetry, pinned by a drift-tripwire test:
  **Jira never yields `canceled`** — it folds "Won't Do" into `done`, and the distinction lives only
  in `fields.resolution`, which this sync does not fetch — so a Jira `done` reads as "closed,
  outcome unknown" and cancel rates are not comparable across the two services. A missing or
  unparseable timestamp **omits its key entirely**, never `0`/`NaN`/`null`, so a consumer can tell
  "no due date" from "due at the epoch". `parent_key` is populated on team-managed Jira projects
  only; classic company-managed projects express epic membership through a per-instance
  `customfield_100xx` this connector deliberately does not chase, and epics stay identifiable there
  via `issue_type`. Metadata is unaffected by index depth — `applyDepth` strips body fields only,
  now locked by a regression test at all three depths, since `metadata_only` withholds item TEXT,
  not the connector facts a consumer selects on.

  Recovering that depth for already-indexed rows needed two more pieces. **`rebody` now recovers
  indexed depth, not just bodies**: a row is eligible when its body is incomplete **OR** its
  service's `metadata.meta_v` is below what `REBODY_REQUIRED_META_VERSION` requires (`jira` and
  `linear` at 1 today; a later depth PR adds a row, not a mechanism). The two reasons are counted
  and reported separately (`pending*` vs `pendingMeta*`) rather than summed — `pending` has meant
  `body_complete = 0` since V48 and still does, and a caller has to be able to tell which kind of
  depth is missing. **`nimbus index rebody --since <days>`** widens the cold-start window via a new
  optional `SyncContext.historyFloorMs` (epoch ms), honored by jira and linear and silently ignored
  by every other connector, which keeps its own `initialSyncDepthDays = 30`. Without it no backfill
  could ever reach the closed historical tickets this work exists to analyze: clearing a watermark
  re-walks 30 days and stops. The floor overrides the **cold start only** — an established cursor is
  more recent by construction and always wins — and the scheduler holds it **in memory only**,
  consuming it when a run completes: a restart drops a pending backfill back to 30 days (the safe
  direction), while a rate-limited run that advanced no watermark keeps it for the retry, and the
  CLI says so on a failed run rather than letting the backfill silently narrow. Malformed `--since`
  values are rejected client-side like `--limit`, a window reaching before 1970 is rejected by the
  gateway (it would render as a negative JQL year and return an opaque 400), and a well-formed but
  implausible one (>3650 days) is honored with a printed typo warning.

- **2026-08-07 — Targeted fetch-on-miss** (`POST /v1/items/fetch`, `fetch` token scope, an explicit
  `I13` write on the 8 KiB control-plane body cap). Built on top of Resolve-by-URL (below): where a
  resolve misses, this route fetches the one named item server-side and indexes it, rather than
  requiring a full connector sync. `Syncable` gains an optional `fetchOne`, implemented for a
  five-connector starter set — github, gitlab, bitbucket, jenkins, jira; the other ~62 connectors
  are untouched and the route answers `no_targeted_fetch` for them. A URL is fetchable only when its
  host maps to a CONFIGURED connector (`sync/fetch-host-boundary.ts`): static SaaS hosts for
  github/gitlab/bitbucket, union the host of each service's Vault-stored origin secret
  (`jenkins.base_url`, `jira.base_url`, `gitlab.api_base` — GitLab's key does not follow the
  Jenkins/Jira `base_url` convention). Matching is EXACT (host + port), with no wildcard, no suffix
  match and deliberately no first-segment guessing fallback — unlike `agents/impact.ts`'s
  `HOST_TO_SERVICE`. Absent credentials a service is not in the map at all, and a host claimed by
  two different services is refused for both rather than resolved to whichever ran last. The
  gateway re-derives `{service}` from the URL's host server-side, never trusts a caller's
  classification, and fetches via that connector's own constructed API URL under its stored
  credential — never by dereferencing the caller's URL. An `http:` URL is accepted only when it is
  exactly a service's own configured `http:` origin (self-hosted Jenkins/GitLab/Jira); every other
  URL must be `https:`. Jira is restricted to `<base>/browse/<KEY>-<N>` plus a board/backlog deep
  link carrying `selectedIssue=<KEY>-<N>` in its query string — every other Jira URL shape answers
  `unsupported_url`. A board-initiated fetch indexes the issue under its canonical `/browse/` key,
  so re-resolving from the same board URL misses `resolve` and re-fetches here again (bounded by the
  rate limiter below, so this is a cost, not a loop). Not HITL-gated: the owner already authorised
  continuous sync of that service with those credentials, so fetching one already-in-scope item is
  strictly less than what runs on a timer; bounded instead by the `fetch` scope, the host boundary,
  and `ProviderRateLimiter.tryAcquire(service)` on the same bucket the scheduler uses (a
  non-blocking poll, so an abandoned targeted-fetch attempt cannot starve the scheduler). Egress
  class `sync` rises from `none` to `per-run`, with two appenders sharing one function
  (`egress/sync-egress.ts`'s `recordSyncEgress`): `sync/scheduler.ts`'s per-run scheduled-sync
  append and `sync/targeted-fetch.ts`'s per-call targeted-fetch append — `per-run` is the honest
  granularity for the class as a whole, since a scheduled sync is a paginated run that can make many
  upstream calls per ledgered row. `LOCAL_ONLY_SYNC_SERVICES` (`filesystem`, `blame`, `openapi`,
  `obsidian`) is excluded from both appenders and records nothing, since those syncables index local
  machine state and never call `fetch` — ledgering their runs as egress would be the same honesty
  failure I29 exists to prevent, pointed the other way (`I29`).
- **2026-08-07 — Resolve-by-URL** (`GET /v1/items/resolve`, `resolve` token scope). Schema **V52** adds
  the derived `item.resolve_key` (`canonicalizeUrl(canonical_url ?? url)`) plus
  `idx_item_resolve_key`, written at the `upsertIndexedItem` SQL chokepoint every connector's item
  write funnels through (`deployment/annotate.ts` is a second, non-connector `item` writer that
  derives the same key the same way) and backfilled row-wise inside the migration. Matching is a
  bounded ladder — exact key, all query params
  dropped, then up to three trimmed trailing path segments — where a non-unique trim answers
  `ambiguous` with at most five candidates (over the cap: `truncated: true` and no list) rather
  than guessing. Returns metadata only, never a body, and appends no egress row.
- **2026-08-07 — The ownership graph is readable: `agents.ownership`, `nimbus owners`, `ownership.refresh` (schema stays V51).**
  PR B (read surface) of the S1 ownership work, completing the graph PR A wrote. A twelfth
  built-in read-only agent (`agents/ownership.ts`) resolves a requested file/directory path
  (via the same containment fence `why` uses, `agents/_lib/why-subject.ts` `matchConfiguredRoot`,
  plus a root-itself case that helper deliberately rejects) or a `[ci.service.<id>]` id against
  the `person --owns--> source_file | directory | service` edges the pass already wrote, falls
  back to the parent directory so a one-committer file still routes somewhere, and reports the
  bound-service list + last-pass coverage with no argument at all. Root resolution consults
  **both** root sources (`[[filesystem.roots]]` and `nimbus index add` registrations,
  `ownershipRoots()` — the same merged set the derivation pass reads), not the narrower
  TOML-only set `why` uses, so a path indexed only via `nimbus index add` is never falsely
  reported as out of scope. `nimbus owners [<path>] [--service <name>] [--json] [--refresh]`
  hard-rejects an unrecognised flag, matching `nimbus glossary`. `ownership.refresh` drives an
  on-demand derivation pass (`nimbus owners --refresh`); it takes **no parameters** — the pass
  clears and re-emits every edge it owns wholesale each run, so a caller-supplied root list
  would silently erase ownership for the omitted roots — and there is deliberately **no**
  `ownership.rebuild`, since a rebuild would be a synonym for refresh. Both the read agent and
  the refresh verb mirror glossary/decisions exactly: `agents.ownership` is renderer-exposed
  (Tauri `ALLOWED_METHODS` **103 → 104**, I7) and answerable over the LAN wire (I5 default-allow);
  `ownership.refresh` is write-class, so the whole `ownership` namespace is LAN-forbidden and
  absent from Tauri's allowlist — local/CLI-only. Also ships `findOwners`, the MCP tool exposing
  `agents.ownership` to external MCP clients (egressed via the existing `source_type='mcp'` I29
  append path — no new invariant, no new egress-ledger code). **Every brief states plainly that
  this is authorship-derived ownership, not accountability** — an unconditional gap note reads:
  *"Blame measures who wrote lines, not who is accountable. There is no CODEOWNERS, no reviewer
  data and no on-call rotation in the index, so this is authorship-derived ownership,"* with the
  remediation *"Treat the ranking as a starting point for who to ask, not as an approval list."*
  No new HTTP route, no migration (schema stays **V51** — this PR adds no table), no new
  invariant: read-only end to end, no `connectors.dispatch`, zero `egress_ledger` rows from the
  read path itself. **Also fixes a stale cross-check**: `security-invariants.test.ts`'s
  `allowlist_exact_size` test scanned `gateway_bridge.rs` for a hardcoded `103`, left behind
  when an earlier commit on this branch bumped the real Rust count to 104 for `agents.ownership`
  — the file-content assertion had drifted from the source it checks. Dated detail for the
  derivation pass this reads: PR A entry immediately below.
- **2026-08-07 — Ownership graph derived from git blame (schema V51).** PR A (derivation) of the
  S1 ownership work. A debounced post-sync pass (`ownership/ownership-pass.ts`, `[ownership]` in
  `nimbus.toml`, default ON) aggregates the already-indexed `git_blame_line` rows into graph edges:
  `person --owns--> source_file | directory | service`, plus `workspace --tracks_remote--> repo` and
  `repo --belongs_to--> service`. Blame lines are weighted by a configurable recency half-life
  (`half_life_days`, default 365) and filtered through an `ignore_globs` default list, because
  `git log --name-only` consults no exclude list and an unfiltered lock file would otherwise hand a
  directory to whoever last ran the installer. Owners below `min_share` are dropped and the emitted
  set is capped at `max_owners_per_path`, with the true count kept on the entity's metadata. The
  pass is read-only against cloud services — it opens nothing, calls no model, and takes no egress
  ledger row. Its root set spans **both** root sources (`[[filesystem.roots]]` and the
  `nimbus index add` registrations in `registered-roots.json`), re-read on every pass, since the
  pass clears and re-emits ownership wholesale and a partial root set would erase what it cannot
  reach. Schema **V51** adds the `owns` / `contains` / `tracks_remote` relation types and the
  `ownership_pass_state` counters; **V50 is permanently consumed as a no-op** and must never be
  backfilled (see `index/ownership-v51-sql.ts`). No new invariant, no HTTP route, no IPC read
  surface yet — the read path lands in PR B.
- **2026-08-06 — the read-only agents are invocable over the local HTTP API, and every such brief is
  in the egress ledger.** Second PR of the HTTP-agents work. Three routes:
  `POST /v1/agents/{agent}` (on the `I13` write allowlist; returns `202` + a `runId`),
  `GET /v1/agents/runs/{id}` (poll: `200` running/done/failed, `404` unknown, `410` expired) and
  `GET /v1/agents` (the invokable set). All three require the `agents` scope minted in the previous
  PR — **a legacy bare-string token, which resolves to exactly `clip,briefs`, is refused with `403`
  on every one of them** and appends nothing. **Ten** agents are exposed: `agents.preflight` stays
  off the surface (`I24` — an external caller must never originate a consent prompt on the owner's
  machine) and `agents.whyPeek` is excluded because it is synchronous, returning its payload inline
  and never notifying, so on a run/poll contract it would create a run that can never complete.
  Delivery is dependency injection, not a notification bridge: the route builds an
  `AgentsRpcContext` whose `notify` writes into an in-memory `AgentRunController` — **no agent code
  changed**, and an HTTP caller's brief is never broadcast to socket clients. Runs are in-memory and
  a restart drops them, deliberately: persisting them would write synthesised brief text derived
  from the private index into a new on-disk table. The contract is stated rather than implied —
  `404` means "unknown **or** lost to a restart", and the client's answer to both is to re-issue.
  **Egress.** The append site did not move: `dispatchAgentsRpc` already appended before dispatch,
  and its condition generalised from `ctx.caller?.kind === "mcp"` to a lookup over a map that is
  **total** over `ClientKind`, so a future transport is a compile error rather than a surface that
  serves briefs and ledgers nothing. `recordMcpBriefEgress` became `recordAgentBriefEgress`
  (parameterised by transport; `destination` is `mcp`/`http`, or `…+federation` for the
  peer-querying agents), and **`D22` gained a fourth rule**: no file outside `ipc/agents-rpc.ts` may
  import an agent emitter, matching both the static and the dynamic `import()` form. The previous
  `SECURITY-INVARIANTS.md` text predicted this exact bypass — a browser-reachable agent route that
  called the emitters directly would have appended nothing and left `audit:invariants` green — so
  rule (d) landed ahead of the surface that would have hit it.
  **One operational consequence, by design:** the coverage vector gained an `http` class, and
  `parseCoverage` rejects a marker with an unknown **or** a missing key. So **every `nimbus prove`
  window spanning this upgrade reports `indeterminate` on every class.** That is the intended
  fail-safe — an old marker must not contribute understated-but-plausible coverage — and it is the
  only such blackout in this sequence, since later work changes coverage *values*, which degrade
  gracefully. Also in this PR: `hasScope` is now module-private, so a handler can no longer name a
  scope inline and bypass the `HTTP_ROUTE_AUTH` table.

- **2026-08-06 — HTTP API bearer tokens are now scoped.** First PR of the HTTP-agents route work.
  A minted token used to be an all-or-nothing bearer secret; it now carries an explicit `scopes[]`
  drawn from a five-name vocabulary (`clip`, `briefs`, `agents`, `resolve`, `fetch` —
  `clips/api-scopes.ts`). Only `clip` and `briefs` are consumed by a route today — `agents`,
  `resolve` and `fetch` exist so a legacy token can be *denied* those scopes before the routes that
  will honour them (PRs 2–4) exist. `nimbus clip pair` gained `--scopes <a,b>` to set the scopes at
  mint time, and a new `nimbus clip scopes <label> --set <a,b>` rewrites an already-paired client's
  scopes in place without a new token or re-pair; `nimbus clip status` now prints each device's
  scopes alongside its label and fingerprint. Scopes are recorded on the owner-opened pairing
  window at `nimbus clip pair` time and read back at confirm — never taken from the confirming
  request — so the granted set stays server-derived (I30). **A legacy bare-string token** (the
  storage shape every already-paired browser's entry is still in) parses as exactly `clip,briefs`
  on load and gains nothing from the new vocabulary automatically; `nimbus clip scopes` is the only
  upgrade path. Enforcement is per-route via a total `HTTP_ROUTE_AUTH` table
  (`ipc/http-route-auth.ts`) with a source-scanned completeness guard: an unrecognised token gets
  401, and a valid token missing the route's required scope gets 403 `insufficient_scope`. Vault key
  is unchanged (`http_api.web_clipper_tokens`) — the name is historical, the map now backs every
  bearer-authed HTTP surface, not only clips. No new invariant number: this is a refinement of I30,
  documented in place.

- **2026-08-06 — The admin console, the OpenAPI document and semantic memory work in a released
  binary.** Second of three PRs in the "what we ship is what we claim" cluster; the first
  (2026-08-05) made connectors spawnable from a compiled binary.

  **Two routes were unreachable in every release to date.** `ipc/http-server.ts` derived the admin
  console's dist directory and the OpenAPI document's path by walking up from `import.meta.dir`.
  Inside a `bun build --compile` executable that directory is the read-only virtual root
  (`/$bunfs/root`; `B:\~BUN\root` on Windows), so both walked to paths that do not exist:
  `nimbus admin console` printed a URL that answered HTTP 503, and `GET /v1/openapi.json` could not
  read its schema. Both now resolve through `ipc/embedded-assets.ts`, four `{ type: "file" }`
  imports that the bundler rewrites to content-hashed paths inside the executable. No codegen is
  involved — the import *is* the path, in both runtime shapes.

  `resolveConsoleDist(baseDir)` became `resolveConsoleAsset(rel)`. Embedded files land in a flat
  bunfs root under content-hashed names, so a compiled binary has no directory to join a request
  path against: it answers from a three-entry map, which makes traversal **structurally
  impossible** rather than rejected. `safeAssetPath` remains load-bearing on the dev path, where
  the lookup is still a join. `NIMBUS_ADMIN_CONSOLE_DIST` is now explicitly a dev-tree affordance —
  a compiled binary ignores it rather than re-opening that surface.

  Embedding the console makes its build a prerequisite of the gateway compile, and of the gateway's
  module graph in a dev tree as well. A root `prepare` script builds it after every `bun install`
  (verified to run even against a warm `node_modules` under `--frozen-lockfile`), and
  `compile-gateway.ts`, `release.yml` and the preflight manifest each build it explicitly.

  **Semantic memory was silently disabled in every release.** The `vec0` sqlite-vec sidecar was
  copied only by `compile-gateway.ts`, which the release pipeline never runs, and it appeared in no
  workflow at all. `tryLoadFromSidecar()` reports its absence at `log.debug` level, so a released
  gateway lost vector search without saying anything. No gateway code changed — the copy moved into
  `scripts/copy-vec0-sidecar.ts`, which each `release.yml` gateway matrix leg now calls, and the
  sidecar ships in the `.msi`, `.pkg`, `.deb`, `.rpm`, AppImage, tarballs and zip, with both install
  scripts placing it beside the gateway binary where `dirname(process.execPath)` will find it.

  **A static audit closes the class.** `audit:import-meta-dir` forbids `import.meta.{dir,dirname,
  path,file}` and `fileURLToPath(import.meta.url)` across `packages/gateway/src`, allowlisting only
  `perf/surfaces/**` (dev-tree-only bench drivers) and test files, with
  `platform/runtime-layout.ts` named as the rule's canonical module. It could not land in the
  previous PR because its only two violations were the two this one removes. `import.meta.url`
  itself is deliberately untouched: `new Worker(new URL("./worker.ts", import.meta.url))` is the
  form Bun's bundler rewrites, and two modules depend on it. That audit, plus the two connector
  audits from the previous PR, now run in CI's Static job — all three had been reachable only from
  a local preflight run.

- **2026-08-04 — Depth enforcement is now real (V49), plus real Gmail and Outlook bodies.**
  Two independent gaps, closed together because the second built on the first: connector index
  depth (`metadata_only` / `summary` / `full`) had never actually been enforced for body content,
  and Gmail/Outlook only ever indexed a metadata snippet, never the message body.

  **Depth enforcement.** `SyncContext.depth` is now a required field, resolved per sync run, and
  every connector's item-writing call now routes through a single chokepoint
  (`upsertIndexedItemForSync` in `index/item-store.ts`) that coerces the row to the configured
  depth before it is written: `metadata_only` suppresses `body` **and** `body_preview` alike (an
  empty string, not an omitted field — omission would fall through to the title); `summary` forces
  the legacy preview arm, clamping to 512 characters and never claiming `body_complete`; `full` is a
  pass-through. Obsidian was the one connector-side bypass — `connectors/obsidian-sync.ts` called
  `upsertIndexedItem` directly, so a `metadata_only`/`summary` vault kept getting full note bodies
  indexed on every sync regardless of the persisted setting. It now goes through the same
  chokepoint. **This is a user-visible behavior change**: an Obsidian connector configured at
  anything other than `full` depth stops leaking full note bodies into the index as of this release.

  **Suppression now covers vectors, not only stored text.** `SqliteEmbeddingPipeline.embedItem`
  (`embedding/pipeline.ts`) previously returned before its `DELETE FROM embedding_chunk` when an
  item chunked to no embeddable text — the reachable state after a depth downgrade to
  `metadata_only` leaves an item with a blank title, since `itemTextForEmbedding` falls back to the
  title once `body_preview` is empty. Old chunks (and, via the V30 dim-aware delete triggers, their
  vectors in `vec_items_384`/`vec_items_1536`) survived that early return, so a suppressed item's
  content stayed searchable as vectors even though its stored text was gone. The early return now
  deletes the item's existing chunks for its model first, so a depth downgrade clears
  previously-computed embeddings along with the text.

  Schema **V49** backfills `sync_state.depth` from `'summary'` to `'full'` for every existing row
  (`metadata_only` rows are untouched). This is not cosmetic: V21 declared
  `depth TEXT NOT NULL DEFAULT 'summary'`, so every row already held `'summary'` materialised rather
  than NULL, and because depth had never been enforced for bodies, a stored `'summary'` expressed no
  intent and had always behaved as `'full'` in practice. Enforcing depth without this backfill would
  have silently truncated every existing index to 512 characters on its next sync. Three code-level
  fallbacks (`local-index.ts` ×2, `sync/scheduler.ts`) that defaulted an absent depth row to
  `"summary"` were flipped to `"full"` for the same reason, as was the `sync_state` insert in
  `connectors/health.ts` — the one insert with production callers, and therefore the only path that
  materialises a depth row for a connector added *after* this migration ran, which the backfill
  cannot reach.

  **If you deliberately chose `summary`, V49 reset it to `full` and you must re-apply it.** The
  backfill cannot distinguish a `'summary'` you asked for from the column default nobody chose, and
  because depth was never enforced for bodies, neither had ever behaved differently. Re-run
  `nimbus connector reindex <name> --depth summary` for any connector you had deliberately set that
  way; from this release it is genuinely enforced on every sync. `metadata_only` connectors are
  untouched and need no action.

  **Gmail** (`connectors/_lib/gmail/api.ts`) now fetches `format=full` instead of
  `format=metadata` — the same Gmail API request at the same 5-quota-unit cost, though *not* the
  same bandwidth: `format=full` returns the inline part bytes, so an initial mailbox sync moves
  substantially more data than it used to — and walks the MIME
  tree to extract text: `text/plain` is preferred by part type (not by document position), a
  `multipart/alternative` picks one representation, and a `multipart/mixed` concatenates its parts.

  **Outlook** (`connectors/outlook-sync.ts`) adds `body` to its Graph `$select`, and its cursor
  prefix moves from `nimbus-outl1:` to `nimbus-outl2:` so every stored `@odata.deltaLink` is
  invalidated once on upgrade — a delta link encodes the projection of the query that minted it, so
  an old link would keep returning body-less responses forever, including for brand-new messages.

  **The quoted-tail trimmer** (`string/email-quoted-text.ts`, new) strips the quoted reply chain
  from an email body before it is indexed: email threads are heavily self-duplicating, and without
  this a twenty-message thread would store the same quoted paragraphs twenty times, spending each
  reply's body cap on text already indexed. It cuts a quoted TAIL (marker to end of message), not at
  the first marker, so an inline quotation followed by more of the author's own prose is left alone.
  Both Gmail and Outlook route HTML bodies through a new **line-preserving HTML-to-text helper**
  (`string/html-plain-text-lines.ts`) rather than the existing `plainTextFromHtml`, which flattens
  every newline to a space — fine for its other four prose-only consumers, but it would have made
  the line-anchored trimmer a no-op, since the trimmer matches quote markers against whole lines.
  Outlook is the first consumer handed a complete HTML *document* rather than a fragment, so that
  helper also drops `<style>` / `<script>` / `<head>` sections (a Word-composed message carries
  kilobytes of `mso-` CSS, which would otherwise land ahead of the prose and eat the body cap),
  decodes character references (`&nbsp;` above all — Graph's `bodyPreview`, which Outlook indexed
  before, is already decoded), and escapes a stray `<` in author prose so `"if a < b"` no longer
  loses the rest of its line. An underscore divider is now treated as end-of-message only when a
  quoted header block or a `>` quote actually follows it; a 10+ underscore rule is also an ordinary
  human section separator, and treating it as unconditionally terminal deleted the rest of the
  message. A Gmail or Outlook message whose body cannot be extracted at all (S/MIME, attachment-only)
  keeps its provider snippet at `body_complete = 0` rather than recording an empty body as a
  complete one, so `nimbus index rebody` can still revisit it.

  `REBODY_IMPROVABLE_SERVICES` (`ipc/index-rebody-rpc.ts`) grows from eleven services to thirteen,
  adding `gmail` and `outlook` in sorted position. The full-body-store connector accounting
  (2026-08-02 entry below, most recently updated 2026-08-03) moves from 12 to **14 full body @
  16 KiB** (the twelve from 2026-08-03 plus Gmail and Outlook, both already in `PROSE_HEAVY_TYPES`);
  the partial (1) and inert (2) counts are unchanged. No new security invariant. Schema **V49**.
  Design + plan archived on delivery — read via
  `git show dd98484b:docs/superpowers/specs/2026-08-04-index-depth-and-email-bodies-design.md`.

  **Outlook resets itself once.** The cursor prefix move means the next scheduled Outlook sync
  performs one full mailbox delta with `body` requested on every page, rather than the usual
  incremental trickle — that is the one-time cost of the feature, and no action is required. A large
  mailbox will notice the sync taking longer than usual just this once.

  **Gmail applies going forward.** `format=full` affects every message fetched from now on,
  including new mail, so nothing further is required for the feature to work — at the cost of more
  bytes over the wire per message, most noticeably on a first sync of a large mailbox. Messages already in
  the index keep their old metadata-only snippet until they're next touched at the source or
  recovered explicitly with `nimbus index rebody --service gmail`.
- **2026-08-04 — Egress ledger (I29) Phase 1: make the completeness claim true, not just stated.**
  D22's own comment claimed "there is no escape hatch, no 'approved wrapper' carve-out … Any future
  shortcut or custom-wrapper bypass therefore fails this preflight static check immediately." That
  was false: D22 is a regex over the literal string `connectors.dispatch`, and a real dispatcher
  decorator (`connectors/connector-write-dispatch.ts`, calling `inner.dispatch(action)`) already
  passes it — as would a session façade or a raw lazy-mesh `tool.execute()`. This phase does not
  close those paths (that's capability removal, Phase 2 of the I29 security spec); it corrects the
  claim and hardens what D22's mechanism actually covers:
  - **Fixed a live miscount:** every `egress.prune` retention tombstone was itself counted as an
    outbound egress event, inflating `nimbus prove`'s reported figure. `EgressSourceType`
    (`egress-source-type.ts`) is now a FROZEN 8-member union (`task`/`prune`/`session`/`sync`/
    `model`/`peer`/`boot`/`degraded`), and `MARKER_SOURCE_TYPES`/`isMarkerSourceType` exclude the
    `prune`/`boot`/`degraded` bookkeeping rows from the outbound count. The union is frozen, but
    **not** because widening it is a chain break — `verifyEgressChain` recomputes each row's hash
    from that row's own stored `source_type` column, never from the union's current definition, so
    a ninth member changes no stored row and no hash input, and every existing row still verifies.
    It's frozen because a `source_type` value written today is permanent in the data, and
    `isMarkerSourceType` depends on the set being known and closed. (An earlier draft of this note
    claimed the chain-break framing; that framing was false and is corrected here per the fix wave
    below.)
  - **A per-process boot marker carries a coverage vector.** `egress-coverage.ts` defines
    `CoverageVector`/`CoverageClass`/`Granularity` and `THIS_BINARY_COVERAGE` (what this binary is
    built to observe); `egress-boot-marker.ts` `appendBootMarker` writes it, serialized, into the
    HASHED `source_id` of a `source_type='boot'` row once per process, so the coverage claim is
    tamper-evident rather than prose. Phase 1 adds **no new coverage** — only `task` is
    `"per-call"`, every other class is `"none"` — and that is itself the honest part: raising an
    entry without landing its appender would be the same overclaim in a new place.
  - **`proveWindow` reports `{ coverage, outboundEgressEvents, indeterminate }`**, replacing the old
    scalar `tier` as the load-bearing shape. `nimbus prove` / `nimbus egress` never print a bare
    `0 ✓`: a provable window prints the count with its observed/unobserved scope, and a window with
    no covering boot marker (or a degraded chain) prints `indeterminate` and exits 1 instead of a
    hopeful zero.
  - **The executor's `egressSink` is now a REQUIRED constructor parameter** (no `?`), with a named
    `NULL_EGRESS_SINK` for the 7 gate-only executors whose actions are local mutations, not egress —
    an unwired sink is now a compile error, not a silent no-op.
  - **Documentation now describes the mechanism, not the intent.** The D22 comment, the I29 section
    of `docs/SECURITY-INVARIANTS.md`, the mirrored `CLAUDE.md`/`GEMINI.md` I29 bullet, and the
    `nimbus-egress` skill all now state that D22 confines the literal string `connectors.dispatch`
    to `executor.ts` and `appendEgressEntry` to `egress/*` — not that no wrapper/façade/raw-execute
    path can exist. No new invariant; I29/D22 unchanged in number and continue to enforce what they
    always enforced. Spec (security spec of record; Phases 2–5 remain unbuilt):
    `git show e4828bcd:docs/superpowers/specs/2026-08-02-i29-d22-egress-completeness-design.md`,
    plus the `fetch`-modality annex
    `git show e4828bcd:docs/superpowers/specs/2026-08-03-i29-ledger-completeness-design.md`.
  - **Fix wave, same day — five residual findings from the final whole-branch review:**
    - **`tier: "authorized-actions"` is back, additively, as a deprecated cross-repo compat shim.**
      Dropping it outright breaks the published `@nimbus-dev/client@0.15.0`'s
      `validateEgressCompleteness`, which hard-throws unless `tier === "authorized-actions"` is
      present — so any published-client consumer (including nimbus-vscode) would hard-fail against
      this gateway. Owner-decided: emit it ALONGSIDE `coverage`/`outboundEgressEvents`/
      `indeterminate` (never in place of them) for one cycle; the CLI's local `ProveCompleteness`
      type tolerates it but reads only `coverage`/`indeterminate` for any decision. It is TRUE TODAY
      only because Phase 1 coverage is task-only — it becomes FALSE and MUST be removed the moment
      any later phase raises another coverage class above `"none"`.
    - **The union-freeze rationale in `egress-source-type.ts` was wrong** — corrected two bullets
      above. Widening `EGRESS_SOURCE_TYPES` is not a chain break (`verifyEgressChain` hashes each
      row from its own stored `source_type`, not from the union), so the real justification is
      permanence-in-the-data plus `isMarkerSourceType`'s closed-set dependency. Same correction
      applied to `docs/SECURITY-INVARIANTS.md` and `.claude/commands/nimbus-egress.md`.
    - **`nimbus egress`'s scope label was wrong.** `formatProveResult` hardcoded "during this query"
      even when rendering the `nimbus egress`/`--since` whole-window report — and inside `nimbus
      prove`, a non-zero delta printed that label twice, once for the true query delta and once for
      the unrelated whole-ledger total. `formatProveResult` now takes a `label`, true per call site
      (`"during this query"` for the `runProve` delta, `"in this window"` for `runEgressReport`).
      Also fixed: the scope line collapsed to just `"gated connector actions"` whenever `task` was
      among several observed classes, silently dropping the others from both the scope line and the
      "not observed" line (unreachable in Phase 1, since every other class is hardcoded `"none"`,
      but wrong on its own terms).
    - **The boot-marker doc overclaimed.** "A build that never wires a sink produces a boot marker
      claiming nothing" is false — `THIS_BINARY_COVERAGE` is a compile-time constant decoupled from
      actual sink wiring, so such a build still claims `task=per-call` via the marker regardless.
      The true statement, now in both `egress-boot-marker.ts` and `docs/SECURITY-INVARIANTS.md`: a
      *window with no covering boot marker* claims nothing.
    - **Recorded, not fixed:** `coverageForWindow` merges the weakest coverage over ALL historical
      boot markers, so the first task-only marker permanently drags every future window's coverage
      down — it can never rise after a gateway upgrade, even for a window entirely after a
      more-capable binary booted. The correct fix is not a plain `since` filter (that drops the
      marker covering the window's start) but "the last marker at or before `since`, plus all
      markers within the window." Left as a documented known limitation (`nimbus-egress` skill +
      a code comment on `coverageForWindow`) for a later phase.
  - **Fix wave 2, same day — four soundness findings from a follow-up code review:**
    - **`coverageForWindow` now reads boot markers via a dedicated SQL query** (`method =
      BOOT_MARKER_METHOD`, no pagination), not `listEgress(db, {})` — the latter defaults `limit`
      to 1000 ordered oldest-first, so on any ledger past 1000 rows a recent boot marker (including
      an unparseable one that must force `indeterminate`) was invisible.
    - **`parseCoverage` now rejects what it claimed to reject.** It previously accepted
      `"task=per-call=extra"` (dropping the extra segment), ignored unknown keys, and let a
      duplicate key silently overwrite — so a marker from a NEWER binary carrying an unknown
      coverage class parsed as valid and contributed real coverage instead of forcing
      `indeterminate`. It now returns `null` for any non-`key=value` segment, any key outside
      `COVERAGE_CLASSES`, or any duplicate key.
    - **`ChatopsBootDeps.egressSink` is now required**, dropping the `?? NULL_EGRESS_SINK` default
      at the construction site — the ChatOps executor is dispatch-capable (real connector actions),
      so a caller that wants no ledger must say so explicitly (`NULL_EGRESS_SINK`) instead of
      getting it by omission. Production (`platform/assemble.ts`) already wired a real sink.
    - **The "recorded, not fixed" limitation two bullets above is now fixed.** `coverageForWindow`
      merges the marker covering the window's `since` (the last one at or before it) with every
      marker booted within the window, instead of every marker in all of history — so a bounded
      window is no longer capped by an old marker from before it starts, and a window whose start
      has no covering marker honestly reports `indeterminate` instead of borrowing a later marker's
      claim for an unobserved slice. An omitted `since` (`nimbus egress`/`nimbus prove` with no
      `--since`) is a deliberate carve-out of that rule: it only withholds the claim when a real
      ledger row precedes the ledger's first-ever boot marker, so a fresh database isn't punished
      into permanent `indeterminate` merely because `since` defaults to 0.
  - **Fix wave 3, same day — two findings from the final pre-push review:**
    - **`coverageForWindow`'s marker queries now require `source_type = 'boot'`, not `method` alone.**
      Both `lastMarkerAtOrBefore` and `markersInRange` (`egress-verify.ts`) previously filtered only
      on `method = BOOT_MARKER_METHOD`, so any ledger row that happened to carry `method='egress.boot'`
      — a bug, or a future row class colliding with the string — would vouch for coverage regardless
      of its actual `source_type`. Only a genuine `appendBootMarker` row (`source_type='boot'`) may
      claim coverage now.
    - **The startup boot-marker append no longer takes the gateway down with it.** `appendBootMarker`
      was called bare from `assemblePlatformServices`; `appendEgressEntry` (via `readHeadHash`)
      deliberately throws on a malformed head `row_hash` (fail-closed against chain corruption) or a
      read-only/locked database, so either condition previously aborted gateway startup entirely —
      worse than the degraded-proof state the design already has an honest answer for
      (`indeterminate`), and self-defeating besides: `egress.verify`/`nimbus egress verify` are only
      reachable through a running gateway, so an unbootable gateway blocks the user from even
      diagnosing the corruption. `platform/assemble.ts` now calls the new `appendBootMarkerOrWarn`
      wrapper instead: it catches the failure, logs a warning naming what failed and stating that
      egress proofs will read `indeterminate` until the next successful boot marker, and lets
      assembly continue. The gated-action append in `executor.ts` `gate()` is unaffected and remains
      hard fail-closed — this change touches only the once-per-process startup marker.
- **2026-08-03 — Notion + Confluence full-body indexing, and a Teams `body_complete` fix.**
  Closes the two full-body-store (V48, 2026-08-02) follow-ups named at the time: `notion:page` and
  `confluence:page` moved from `bodyPreview: ""` (title and URL only, no text at all) to a
  declared-full `body:`, joining the 16 KiB `PROSE_HEAVY_TYPES` cap.

  **Confluence** (`connectors/confluence-sync.ts`) gets the whole page body for free: the CQL
  search's `expand` param grows from `history.lastUpdated,space,version` to
  `history.lastUpdated,space,version,body.storage`, and a new `confluenceBodyText()` helper pulls
  `body.storage.value` (run through `plainTextFromHtml`) off the same response — zero extra API
  requests. The larger per-row payload halved the page-fetch size (50 → 25) to stay within response
  limits.

  **Notion** (`connectors/notion-page-body.ts`) has no equivalent expand — a page's content is a
  separate block tree — so it walks `blocks/children` recursively (depth capped at 3, a cycle
  guard, not a cost bound) under two budgets: `NOTION_BODY_FETCH_BUDGET_PER_SYNC` (200 requests,
  shared across every page in one sync pass) and `NOTION_BODY_REQUESTS_PER_PAGE_MAX` (10 requests,
  per page — without it one list-heavy page could dominate a whole pass). A page that runs out of
  its own per-page budget gets `outcome: "capped"` — permanent, since a re-fetch of unchanged text
  would hit the same cap again, and skip-if-fresh means it is not re-attempted while the page
  itself stays unedited. A page whose fetch fails outright (not the per-page budget — a network
  error, 403/404, bad JSON) gets `outcome: "errored"` instead; a 429 additionally zeroes the
  pass's remaining budget, which discards that whole pass's watermark advance, so a 429-errored
  page is retried on the very next pass, while any other error is only retried when the page is
  edited again at the source or via an explicit `nimbus index rebody`. Either way the page still
  indexes with its title, URL, and whatever text was recovered, rather than failing outright.
  Pages that don't fit in one pass converge over Notion's existing 5-minute sync cadence
  (`defaultIntervalMs: 5 * 60 * 1000`) rather than in a single run. The Notion rate-limit quota
  (`sync/rate-limiter.ts` `DEFAULT_QUOTAS.notion`) was raised from 30 to 120 requests/minute
  (`burstSize` unchanged at 5) to give the block-tree walk headroom.

  A new `bodyTruncated` flag on `IndexedItemBodyInput` (`index/item-store.ts`) lets a connector
  assert "this body is incomplete" even when the raw text happens to fit under the cap — Notion's
  `"capped"`/`"errored"` outcomes set it, so `body_complete` reflects the fetch outcome, not just a
  length check. It is an in-memory input field read at write time, not a new column — no migration,
  schema stays **V48**.

  Fixed a live bug found while wiring the above: Teams (`connectors/_lib/teams/api.ts`) was calling
  `plainTextPreviewFromHtml(content, BODY_MAX_PROSE)` — pre-truncating to the 16 KiB cap before
  handing text to the store — so the store's own `raw.length <= cap` check always passed and every
  over-cap Teams message was wrongly recorded `body_complete = 1`. Teams now calls a new
  `plainTextFromHtml()` (`string/html-plain-text.ts`, no length limit) and lets the store apply the
  cap, so truncated Teams messages are correctly marked incomplete and are eligible for `nimbus
  index rebody`.

  `REBODY_IMPROVABLE_SERVICES` (`ipc/index-rebody-rpc.ts`) grows from nine services to eleven,
  adding `confluence` and `notion` in sorted position: `bitbucket`, `confluence`, `discord`,
  `github`, `jira`, `linear`, `notion`, `obsidian`, `slack`, `snyk`, `teams`.

  The full-body-store connector accounting (2026-08-02 entry below) moves from 10 full / 1 partial
  / 2 inert to **12 full body @ 16 KiB (Slack, Teams, Discord, Linear, Jira, `github:issue`, Snyk,
  Obsidian, Zoom transcripts, `nimbus:web_clip`, Notion pages, Confluence pages) / 1 partial
  (`nimbus:research_brief`) / 2 inert (Bitbucket, `github:pr`)** — the partial and inert counts are
  unchanged; this entry is the current statement of that accounting, superseding the (10) figure in
  the 2026-08-02 entry below. This also makes true, as of 2026-08-03, a previously-false claim in
  [`docs/roadmap.md`](./roadmap.md) Wave 5: `nimbus glossary` mining "Confluence/Notion pages" had
  nothing to mine before this landed. No new security invariant. Design + plan archived on
  delivery — read via
  `git show dd98484b:docs/superpowers/specs/2026-08-03-notion-confluence-full-body-design.md`.
- **2026-08-02 — `nimbus index rebody` — recover full bodies for already-indexed items.**
  A backfill for the full-body store below: re-fetches item bodies for rows the V48 migration (or
  a connector not yet migrated) left with `body_complete = 0`, by clearing a per-connector sync
  watermark (`scheduler_state.cursor`) and letting the existing sync run from scratch — real
  outbound API traffic, not a local recompute. `index.rebody`/`index.rebodyCancel` (long-running job
  pattern, `index.rebodyProgress`/`Done`/`Error` notifications) plus `nimbus index rebody
  [--service <name>] [--type <t>] [--limit N] [--dry-run] [--yes] [--json]`. An inclusion list,
  `REBODY_IMPROVABLE_SERVICES` (nine services: `bitbucket`, `discord`, `github`, `jira`, `linear`,
  `obsidian`, `slack`, `snyk`, `teams`), decides what a dry run reports as improvable — a mixed-migration
  service (`zoom`: `transcript` migrated, `meeting` not; the local `nimbus` bucket: `web_clip` and
  `research_brief` migrated, `glossary_term` not) is deliberately excluded, because the pending count
  is grouped by service only, not by `(service, type)`. Deliberately **no `--only-truncated` flag** —
  a sync fetches by page/time window, not by item id, so such a flag would suppress writes for
  already-complete items while every API request still happened, saving nothing. The dry-run report
  and the CLI both state the load-bearing caveat: cost is not proportional to the pending counts —
  a full-scan connector (Notion, Confluence) re-walks the entire account regardless of how few items
  are pending. No new schema, no new invariant.
- **2026-08-02 — Full-body store: `item.body` (schema V48), lifting the 512-character index cap.**
  `item.body_preview` was the only body text the local index stored, hard-clipped to 512 characters
  for every item from every connector — one clamp bounding keyword search (`item_fts`), `nimbus
  glossary` and `nimbus decisions` simultaneously, and incidentally making `embedding/chunker.ts`'s
  256-token chunking inert (512 chars ≈ 128 tokens always produced exactly one chunk). Adds
  `item.body` (up to 16 KiB for `PROSE_HEAVY_TYPES`, else 512) and `item.body_complete`;
  `item_fts` is repointed from `body_preview` to `body` (migration seeds `body = body_preview`
  before rebuilding, so no existing row's keyword coverage regresses); `body_preview` becomes a
  derived 512-char prefix of `body`, never written independently. Embeddings
  (`embedding/pipeline.ts`), the relationship graph, and the federation query gate (invariant I17)
  are deliberately untouched — all three keep reading `body_preview`, so embedding egress stays
  exactly flat, enforced by source-scanning guards. `body_complete` stays 0 for every row the V48
  migration touches — completeness is a claim a connector makes about its own fetch and cannot be
  inferred from stored text length.

  The implementation plan named "twelve connectors." Verified against the tree, it is not twelve:

  | | Sources |
  | --- | --- |
  | **Full body @ 16 KiB (10)** | Slack, Teams, Discord, Linear, Jira, `github:issue`, Snyk, Obsidian, Zoom transcripts, `nimbus:web_clip` |
  | **Partial — 2,000-char cap, not full-body (1)** | `nimbus:research_brief` — bounded upstream by `MAX_SUMMARY_CHARS` (`briefs/brief-report.ts`) at synthesis, in the only path that builds a `Report`; a real gain (512 → 2,000) but not full-body indexing |
  | **Inert, still 512 (2)** | Bitbucket — emits only `type: "pr"`, while `PROSE_HEAVY_TYPES` lists `bitbucket:issue`, which no connector emits (dead configuration); `github:pr` — never added to `PROSE_HEAVY_TYPES` (only `github:issue` was), though the `body:` swap in `github-sync.ts` touches both `upsertPr` and `upsertFromIssue` |

  Schema **V48**. No new security invariant — this widens a storage field and introduces no new
  chokepoint. Spec + plan archived on delivery — read via
  `git show dd98484b:docs/superpowers/specs/2026-08-02-full-body-store-design.md`. (#1023)

  **Superseded 2026-08-03:** this (10) accounting was correct for what shipped on 2026-08-02; the
  2026-08-03 entry above brought Notion and Confluence into the full-body group, moving the live
  count to 12 full / 1 partial / 2 inert. See that entry for the current accounting.
- **2026-08-02 — `nimbus decisions` — implicit ADR extractor.** The third and final member of the
  implicit-knowledge triad, after `nimbus why` (2026-07-24) and `nimbus glossary` (2026-07-30):
  recovers decisions buried in Slack/Discord/Teams messages, Notion/Confluence/Obsidian pages, and
  Linear/Jira/GitHub/GitLab issues — statements of the form "we decided X because Y, alternatives
  were Z" — corroborates them against downstream PRs, commits and ADRs already in the local
  relationship graph, and returns a chronological list with a deterministic confidence score and
  evidence links. Reuses `glossary`'s architecture exactly: a debounced post-sync pass (discover →
  extract → corroborate), with `--refresh` running one on demand and `--rebuild` clearing the store
  — vetoes included — to re-mine from scratch. Eleventh built-in read-only agent, zero HITL, zero
  `connectors.dispatch`, zero `egress_ledger` rows. Schema **V47** (`decision_record`,
  `decision_evidence`, `decision_pass_state`); Tauri `ALLOWED_METHODS` 102 → 103 (I7) — the added
  method is `agents.decisions`, the read-only brief; `decisions.refresh`/`decisions.rebuild` are
  LAN-forbidden and deliberately NOT renderer-callable, asserted by name rather than by count. No new
  invariant. `parseDurationToMs` (`packages/cli/src/lib/parse-duration.ts`) gained `d`/`w` units to
  express decision horizons in days/weeks, purely additive so existing `connector`/`share` callers
  are unaffected.

  Two honest limits are stated in every brief, not absorbed silently: at ship time item bodies were
  indexed to a blanket 512-character cap, so a decision stated later in a long document or thread
  was structurally invisible to this pass. The full-body store (V48, below — shipped the same day)
  lifted that cap to 16 KiB for the migrated sources this agent mines (Slack, Discord, Teams,
  Obsidian, Linear, Jira, `github:issue`); Notion, Confluence, GitLab and `github:pr` remain on the
  512-character cap. The blanket disclaimer is now a conditional per-brief count instead — "N of M
  source(s) considered ... indexed with a truncated body," keyed on `body_complete = 0` via the same
  source-filter SSoT the mining path uses, and silent when nothing is truncated. And `migration`/`iac`
  evidence is specified in the schema's `decision_evidence.kind` CHECK constraint but never emitted,
  because no connector indexes a corroborating change's file paths — so the confidence ceiling is
  **0.86, not 1.0**, and the brief never presents a full-marks scale a user cannot reach.

  Spec + plan archived on delivery — read via
  `git show dd98484b:docs/superpowers/specs/2026-08-01-nimbus-decisions-design.md`.
- **2026-08-01 — `--json` implemented on the six commands that only documented it.** `nimbus status`,
  `connector list`, `db verify`, `db repair`, `config list` and `audit` parsed no `--json` at all —
  the flag reached only the top-level banner suppressor in `index.ts`, so a documented `| jq`
  pipeline silently received human-rendered text. All six now emit machine-readable JSON, under one
  written contract (documented in `docs/cli-reference.md` § Global Flags → "The `--json` contract"):
  `--json` is **per-command, never global**; stdout carries exactly one pretty-printed JSON value and
  nothing else (no banner, table, or empty-state hint); diagnostics go to stderr; exit codes are
  unchanged by the flag, and a command that *fails* emits no JSON at all, so callers check the exit
  code rather than the presence of output; and the shape is the gateway's own payload unwrapped —
  no `{ ok, data }` envelope, matching the convention `nimbus query`/`extension list`/`egress`
  already ship. Shapes: `status` is one always-fully-populated object (`null` for absent data, with
  `running` meaning "state file exists **and** `gateway.ping` answered"; `error` carries the IPC
  message in the narrow case where the socket **connected** but the ping then failed — a *stale*
  state file whose socket has no listener never reaches that shape at all, because the connect
  rejects first, so stdout stays empty and the process exits `1`, exactly as plain `nimbus status`
  already did with the same file); `connector list` and `audit` are raw row arrays
  (empty registry → `[]`, not the hint line; `actionJson` stays the stored string so a malformed
  payload still appears); `db verify` is `{ clean, findings, exitCode }` and `db repair` the
  `{ outcomes, repairedAt }` report, both dropping the gateway's pre-rendered `formatted` blob rather
  than embedding it; `config list` is `{ path, exists, keys, raw }`. No gateway change was needed —
  every payload was already structured behind the CLI's own formatting. No new IPC method, no new
  invariant.
- **2026-08-01 — `nimbus glossary` — manual term authoring.** Closes the "no manual authoring or
  correction" gap named in the base spec's §12: a `[glossary.terms]` / `[glossary.synonyms]` pair
  of flat TOML blocks in `nimbus.toml`, read by a dedicated parser that reports per-entry skip
  reasons rather than silently dropping a malformed line (including the one valid-TOML shape it
  cannot read — a dotted `terms.CDR = "…"` key under `[glossary]` itself, now reported instead of
  ignored). A pre-pass runs at the head of every glossary pass (config re-read per pass, not
  captured at gateway startup, so `--refresh` picks up an edit without a restart) and upserts
  authored entries straight to `status='consolidated'` with `definition_source='manual'` — no
  model call, no pending queue, no budget slot. Removing a config entry **demotes** the row rather
  than deleting it: a term with real mined evidence falls back to ordinary mined status through the
  existing `doc_freq` floor, and a pure invention sinks below it and disappears; hard deletion would
  have lost the first case, since the incremental scan never re-discovers a term once it is gone.
  On a `term_key` collision, the authored definition wins unconditionally over a mined one, and the
  newest authored form wins over an older one. Two guards keep the two populations from bleeding
  into each other: `upsertCandidate` no longer lets a mined sighting overwrite an authored
  `display_term`, and `reconcilePass` sweeps manual-row statistics (so `top_sources` self-heals) but
  never demotes or vetoes them — full exemption from the sweep was considered and rejected, since it
  would freeze `top_sources` forever. `listConsolidated` now orders authored terms ahead of every
  mined term regardless of score, which fixes three readers at once (list mode, and both near-miss
  pools) and means an authored term can no longer be the dropped tail of the 500-term near-miss
  pool. `countByStatus.manual` is a **subset** of `total`, not a fourth bucket — mined count is
  `total - manual`. The CLI's `--rebuild` preview no longer claims authored terms will be deleted
  (they are truncated and re-read from `nimbus.toml` inside the same transaction as the rest of the
  rebuild), and `--refresh` now names any config entries it rejected in its stderr summary, which
  were otherwise invisible. Schema **V46** (`glossary_term.definition_source` widened from
  `CHECK(... IN ('llm','snippet'))` to `CHECK(... IN ('llm','snippet','manual'))` — a full table
  rebuild, since SQLite cannot alter a CHECK in place and V45 shipped in v1.13.0); both
  `DefinitionSource` unions (`glossary/glossary-types.ts` and the duplicated one in
  `agents/_lib/glossary-types.ts`) widen together so a partial widening fails to compile. No new
  invariant, no new HTTP route, no new connector.
  **Two repairs shipped alongside this, both blocking the slice:** the shared TOML line parser's
  `stripComment` truncated at a `#` inside a quoted value and `parseString` unescaped the wrong
  sequence (TOML writes `\"`, the parser handled `\\"`), so an authored definition containing
  ordinary prose was silently corrupted and then projected as authoritative; `filesystem-toml.ts`
  carried byte-identical private copies of both functions and now imports the shared, repaired
  ones instead of fixing the same bug twice. Separately, `depluralize()` in `term-normalize.ts` was
  truncating dotted identifiers — `normalizeTerm("node.js")` produced `"node.j"` — because a `.js`/
  `.es` suffix reads as an English plural; the fix is a narrow internal-punctuation exemption (a
  word containing an internal `.` is treated as an identifier, never a plural), deliberately **not**
  a general "consonant + s" rule, which was measured to break `"docs" → "doc"` and the function's own
  headline example, `"SLOs" → "slo"`. `depluralize` still strips a trailing plural `s` outside that
  narrow exemption, so `"https"` still normalizes to `"http"` and `"kubernetes"` to `"kubernete"` —
  that needs an acronym allowlist, which is separate work, not attempted here. Spec + plan
  archived on delivery — read via
  `git show dd98484b:docs/superpowers/specs/2026-07-31-nimbus-glossary-manual-authoring-design.md`.

- **2026-07-31 — `nimbus glossary --refresh` no longer hangs when the gateway dies mid-pass.**
  `@nimbus-dev/client` bumped `^0.14.0` → `^0.15.0` for its new `IPCClient.onClose`, and
  `awaitPass` now uses it. The gap this closes is specific to notification-delivered results:
  `call()` is bounded by the client's `requestTimeoutMs`, but the call that *starts* a pass
  resolves immediately with a job id and the result arrives later as a notification — so a gateway
  that died in between left no pending call for the transport to reject and no notification ever
  coming, and the CLI waited forever. There is deliberately still **no timeout** on that wait,
  because a pass legitimately runs minutes at default config; the transport closing is the signal,
  not a clock. A mid-pass death now fails fast with
  `gateway connection closed during the pass: …` and exit code 2.
  The same change pairs every notification handler with its removal on settle — `runAgentBriefCli`
  reuses one client for the brief that runs straight afterwards, so a leaked handler was a live
  cross-phase listener, not merely untidy. Client-side change:
  [nimbus-client#48](https://github.com/nimbus-agent/nimbus-client/pull/48) (released as
  `@nimbus-dev/client` 0.15.0).

- **2026-07-31 — `nimbus glossary` — LLM wiring, snippet upgrades, and `--refresh`/`--rebuild`.**
  Three follow-ups to the 2026-07-30 glossary delivery below. (1) A `ConsolidatorLlm` adapter over
  the existing `LlmRouter` — hard-rejecting any non-local provider before generation, not after —
  is now injected into the scheduler-triggered pass and gated on a new `[glossary].use_llm`
  (default `true`); an unattended pass on a machine with a running local model now consolidates
  through it instead of always falling back to a verbatim snippet. (2) Existing
  `definition_source='snippet'` terms are no longer permanent: `consolidatePhase` runs a second
  batch each pass selecting consolidated-but-snippet-sourced rows, guaranteed a reserved floor of
  slots (`UPGRADE_RESERVE`, clamped to half the per-pass budget) so a large pending backlog can
  slow upgrades but never starve them. (3) `nimbus glossary --refresh` and `--rebuild [--yes]` are
  wired end-to-end through a new `glossary.*` IPC namespace (`glossary.refresh` / `glossary.rebuild`,
  long-running jobs emitting `glossary.passProgress` / `glossary.passDone` / `glossary.passError`),
  replacing the explicit-rejection error the flags returned before; both methods are LAN-forbidden
  (I5) and not Tauri-exposed (I7), so `ALLOWED_METHODS` stays at 102.
  **Surprising consequence, worth reading before enabling:** turning the LLM on can make terms
  *disappear* from the glossary. Snippet mode has no veto path, so a glossary built without a model
  accumulates terms nothing has ever judged; the upgrade path in (2) runs those same terms through a
  real veto check, and a term that fails it is removed from the glossary (row survives as `vetoed`,
  and returns to the searchable index only if a later `--rebuild` re-derives it). `--refresh` names
  up to 10 terms vetoed this way in its stderr summary (plus a count of any remainder), so a
  disappearance is never silent even past that cap. Known limit
  added: the abort signal used at gateway shutdown does not propagate into the LLM provider's
  underlying HTTP request, which keeps running until the provider's own 120s timeout or process
  exit. Spec + plan archived on delivery — read via
  `git show dd98484b:docs/superpowers/specs/2026-07-31-nimbus-glossary-llm-wiring-design.md`.

- **2026-07-30 — `nimbus glossary` — implicit-knowledge glossary.**
  A tenth built-in read-only agent plus a background extraction pass that mines domain
  terminology from the already-indexed graph. Mining is scoped to an explicit **`service:type`**
  allowlist (`GLOSSARY_SOURCE_TYPES`) matched as `(item.service || ':' || item.type)` — the service
  half is enforced, not just the bare type, so a different service reusing a generic type name
  (`message` / `page` / `issue` / `commit`) is never mined by accident; email and calendar are
  deliberately excluded. The delta scan resumes from a composite `(modified_at, id)` cursor so a
  batch truncated inside a group of items sharing one timestamp continues rather than skipping the
  remainder. Deterministic candidate mining (5 families,
  family-5 sentence-initial guard) recomputes every statistic from the existing FTS index rather
  than accumulating counters, so passes are idempotent; per-term consolidation makes a local-LLM
  call to write or veto a definition, capped at 25 calls per pass and running sequentially. A
  pure-SQL reconciliation sweep re-verifies 50 terms per pass so a term whose sources were
  deleted is demoted and unprojected rather than lingering with inflated statistics.
  Consolidated terms are projected into the unified index as `nimbus:glossary_term` (joining
  `PROSE_HEAVY_TYPES`, 22 → 23) with synonyms written into `body_preview` so
  `nimbus ask "what does Change Data Record mean?"` resolves through ordinary search. Schema
  **V45** (`glossary_term`, `glossary_pass_state`); Tauri `ALLOWED_METHODS` 101 → 102 (I7). No
  new invariant, no new HTTP write route, no new connector; zero HITL actions and zero
  `egress_ledger` rows. `[glossary]` defaults ON.
  The extraction pass is triggered only by the debounced post-connector-sync hook — the
  `agents.glossary` IPC handler reads only `term` and `limit`; the CLI's `--refresh` / `--rebuild`
  flags are not implemented and are **rejected with an explicit error** rather than silently
  running an ordinary query (wiring them is a follow-up). The scheduler-triggered pass itself also runs without an LLM available to it, so
  unattended passes produce `definition_source: "snippet"` definitions (the verbatim sentence
  containing the term) rather than LLM-consolidated ones, and there is no automatic upgrade path —
  nothing re-queues an existing snippet-sourced term for re-consolidation once an LLM becomes
  available. Wiring the LLM into the scheduled pass, and adding a snippet→LLM upgrade path, are both
  follow-ups. ADRs are mined only from Obsidian-indexed
  roots (there is no generic markdown item type), and commit messages are mined from the subject
  line only. Spec + plan archived on delivery — read via
  `git show dd98484b:docs/superpowers/specs/2026-07-30-nimbus-glossary-design.md`.

- **2026-07-30 — macOS `nimbus init` can no longer hang on a locked keychain, issue #932.**
  The remaining half of the first-run hang. With #928 fixed the boot log still stopped dead, and a
  sampled stack showed why: on first run the gateway writes new Vault keys (federation identity,
  policy anchor keypair), and `SecKeychainAddGenericPassword` against a **locked** default keychain
  escalates to a GUI authorization prompt —
  `defaultKeychainUI` → `makeLoginAuthUI` → `AuthorizationCopyRights` → a *synchronous* XPC
  round-trip → `mach_msg`. With no GUI session nobody can answer that dialog, so the call never
  returns. Because every `bun:ffi` symbol is a synchronous call on the main thread, the block froze
  the whole event loop: no timer fired, nothing logged, and the IPC socket was never bound.
  `nimbus init` — the first command a new user runs — hung forever with no diagnostic at all, which
  is strictly worse than the Linux behaviour (#925) that at least fails fast.
  That also rules out the obvious fix: a synchronous FFI call **cannot** be bounded by a
  `Promise.race` timeout, because the timer can never run. The block has to be prevented, not
  bounded. `vault/darwin.ts` now calls `SecKeychainSetUserInteractionAllowed(0)` at module load and
  per instance, so a locked keychain returns `errSecInteractionNotAllowed` (-25308) immediately
  instead of waiting on a dialog; a background daemon has no business presenting a modal prompt, and
  this brings macOS into line with Linux, which already fails fast on a locked keyring. The four
  previously generic throws (`"Vault store failed"` and friends) now render through the new pure
  `vault/darwin-keychain-status.ts`, which maps -25308 and `errSecAuthFailed` (-25293) to the raw
  `OSStatus` plus a runnable remedy (`security unlock-keychain`, or a dedicated unlocked keychain for
  SSH/CI) and states plainly that Nimbus never prompts, so a missing dialog does not read as a bug.
  The operation name is threaded through `deleteKeychainOnly`, because `set()` clears any existing
  item first and a refused lookup during `nimbus init` used to be reported as a failed *delete*.
  Verification is layered, since the FFI itself is unreachable off macOS: the message logic is a
  pure module unit-tested on every platform (100% covered — `vault/darwin.ts` is coverage-exempt as
  platform code); four source guards pin that the symbol is declared, actually *called*, called at
  module scope, and never passed `1` — all four red-proved via three independent breakages (drop the
  module-level call, flip `0`→`1`, delete the declaration); and a new macOS
  `install-smoke` step locks the keychain and asserts the gateway fails **fast** with the remedy —
  `timeout` exit 124 is treated as the regression, so a hang can never pass as green. That step's
  five-way decision logic (works / hangs / exits 0 / no remedy / no never-prompts line) was
  red-proved locally against stub gateways before it ever reached CI.

- **2026-07-29 — Gateway binds IPC BEFORE the embedding model loads (bind-first), issue #928.**
  The gateway used to `await` the embedding runtime inside `assemblePlatformServices` before
  `ipc.start()`. With `[embedding] provider = "hybrid"` (or `openai`) that awaited
  `createLocalEmbedder(...)` — a MiniLM fetch from a third-party CDN with no timeout of its own —
  so on a cold machine the IPC socket never appeared, the boot log stopped at
  `starting embedding runtime`, and `nimbus init` (the first command a new user runs) was
  indistinguishable from a hang. `createEmbeddingRuntimeNonBlocking` now returns on the same tick
  behind `createDeferredEmbeddingRuntime`, which runs the real construction in the background;
  a rejected fetch settles to `unavailable` and the gateway keeps serving. A restored-blocking
  e2e (`gateway-bind-first.e2e.test.ts`, a local stalling proxy standing in for a slow CDN — no
  network) red-proves it: pre-fix the gateway never binds inside 60 s, post-fix it binds in ~2 s.
  The second half is the **false green**: a warming runtime used to hand back a `null` query
  vector, hybrid search silently degraded to BM25, and a query with no lexical overlap returned
  `[]` — reading exactly like a legitimate "nothing matched". Warming is now a typed condition,
  never a null: `EmbeddingRuntime` gained `getReadiness()`
  (`warming` | `ready` | `unavailable` | `disabled`, with elapsed time, model/dims, failure reason
  and live model-download progress), and both the deferred wrapper and the worker bridge THROW
  `EmbeddingWarmingError` instead of resolving `null` while warming. `index.searchRanked` returns
  JSON-RPC `-32021` with `data.code = "embedding_warming"` + the readiness rather than a
  lexical-only result; `semantic: false` is served as before, and `disabled`/`unavailable` (which
  are permanent for the process) still return keyword results. `gateway.ping` now carries the same
  readiness block so a client can show real download progress instead of a generic spinner, and
  the boot log gains a `[gateway] embeddings: <state>` line at bind time. Paths that ADD optional
  context and never report a zero to a human — session-memory recall, tribal clustering, and the
  `searchRankedAsync` seam shared by `engine.ask` / agents / briefs — degrade through the
  explicitly named `embedQueryBestEffort` / `embedQueryDualBestEffort` helpers, so every
  silent-degrade site is greppable. Also: the lazy runtime now warms eagerly (nothing has to call
  `embedQuery` to start the load), a terminated worker bridge stops claiming `warming`, and the
  600 s worker init window is unchanged but no longer sits on the bind path.
- **2026-07-29 — CI fan-out cut from ~34 jobs per PR to ~11; the queue was arithmetic, not misconfiguration.**
  PRs were taking hours, all of them queued. Measured rather than guessed: 18-19
  jobs running against GitHub Free's 20-concurrent-job account cap, macOS pinned
  at exactly 5/5 (its own sub-cap) on two consecutive samples, and 85-133 jobs
  waiting — of which 85 were cheap ubuntu ones. One PR push fanned out to ~34
  jobs across 9 workflows, against ~10 branches in flight. The org moved to Team
  (20 -> 60 concurrent, verified live: a later sample showed 36 running), and
  this change removes the fan-out that made the cap bind in the first place.
  **`coverage-gates-linux`: 15 one-gate jobs -> 3 batched jobs (-12).** Each leg
  ran 0.6-1.3 min but queued 11-20 min, and ~0.5 min of every leg was runner
  start + checkout + `bun install` — the matrix spent more wall time on setup and
  queueing than on the thresholds it enforced. The batch step runs every script
  even after one fails, preserving the failure locality `fail-fast: false` gave.
  Five `Vault`/`Sandbox` prep steps were deleted from that job as provably dead:
  its matrix has never held either gate, so every `matrix.gate.name == '…'`
  condition was permanently false. **docs-quality: 8 jobs -> 2 (-6)** — seven
  runners each paying ~30s of identical setup for one near-instant `bun run`;
  `link-check` stays separate because it is the slow, network-touching one.
  **`js-licenses` folded into `Dependency audit` (-1)**, which moves a license
  violation onto a required check — a behaviour change, recorded as such.
  **`cargo-audit`/`cargo-deny` skipped on PRs touching no Rust (-2)** and
  **the cross-platform matrix narrowed to the packages a PR can affect (-2)**.
  Both touch required-check semantics and both were verified against the LIVE
  ruleset rather than the comments describing it: the `ci.yml` comment asserting
  that rulesets require the expanded `Cross-platform (pkg, os)` names is stale —
  the General ruleset requires only `PR quality — required gates`, the six
  Security contexts, two CodeQL contexts and `cla`. The cargo gate is written
  `!= 'false'` and `!cancelled()`, so a failed detector, an unresolvable base
  SHA, or a red gitleaks all run the scans rather than posting a passing
  `skipped`. The `audit:coverage-gate-pal` guard was red-proved against the new
  batch entries before trusting it. Eight dead `ci-latency-baseline.json` rows
  pruned (seven deleted jobs plus a `Bencher Report` entry that named no job).

- **2026-07-29 — The last two `bun audit` advisories closed: one fixed, one written down.**
  `bun audit` reported 2 (1 moderate, 1 low). Neither blocked CI — the gate is
  `--audit-level high` — which is exactly why both had persisted.
  **`@hono/node-server` (GHSA-frvp-7c67-39w9, moderate, path traversal in `serve-static`
  on Windows via `%5C`) is FIXED**: root override `"@hono/node-server": "2.0.12"`. The 1.x
  line tops out at 1.19.17 with no backport, but `@modelcontextprotocol/sdk@1.30.0` already
  declares `"^1.19.9 || ^2.0.5"`, so 2.x needs no upstream change. Verified on a clean
  install that both SDK copies in the graph (1.29.0 via `@mastra/*`, 1.30.0 at root) relink
  to the single 2.0.12 copy, that `getRequestListener` — the only symbol the SDK imports —
  still exists, and that `server/{mcp,stdio,streamableHttp}.js` all load. Worth recording:
  nothing in this repo imports `@hono/node-server` or `serve-static` at all, and every one
  of the ~90 MCP connector entry points imports only `server/mcp.js` + `server/stdio.js`,
  so the vulnerable path was already unreachable — the upgrade was cheap, so it was taken
  rather than argued.
  **`@ai-sdk/provider-utils` (GHSA-866g-f22w-33x8, low, CWE-400) is ACCEPTED, with a
  re-check date.** No fix exists: the range is `<=3.0.97` and the published 3.x line ends at
  3.0.30, so GitHub lists patched = `None`; even `@mastra/core@1.54.0` still pins the alias
  at 3.0.30. No override can reach it either — `@mastra/core` pins it as
  `"@ai-sdk/provider-utils-v5": "npm:@ai-sdk/provider-utils@3.0.25"`, and regenerating
  `bun.lock` from scratch with either a bare key or the alias key still resolves 3.0.25
  (bun 1.3.14 records the override and ignores it). The sharper finding: `@mastra/core`
  **vendors** its own copy of the vulnerable `createJsonResponseHandler` into
  `dist/chunk-RTETZOAY.js` and imports only base64/URL/abort helpers from the flagged
  package — so a version bump would have cleared the audit line without changing a byte of
  executing code. Security theatre, declined.
  Backing this decision: **`bun run audit:advisories`**, a new step in the `Dependency audit`
  job. It reads `bun audit --json` and fails when a live advisory has no row, when a row is
  past its `recheckBy`, when a row's advisory has cleared (delete the row, never leave
  drift), when an advisory is re-scored above the accepted level, or when a row's
  justification is blank / its window exceeds one quarter. Registry:
  `scripts/structure-audit/accepted-advisories.ts` — the JS mirror of the
  `[advisories].ignore` list in `packages/ui/src-tauri/deny.toml`. All six guards
  red-proven against live audit output. `bun audit`: **2 → 1**, and the 1 now has an owner
  and a date.
- **2026-07-29 — Mercury connector indexes transactions (`mercury:transaction`), issue #890.**
  The Mercury connector shipped accounts-only; transactions were a documented deferral. The
  gateway syncable now walks each indexed account's
  `GET /api/v1/account/{accountId}/transactions?limit=500&offset=N&order=desc` (the
  `{ total, transactions: [...] }` envelope, offset pagination, short page ends the walk) and
  maps rows through the new pure `mapMercuryTransactionToItem`. Two caps bound the cycle:
  `MAX_TRANSACTION_PAGES_PER_ACCOUNT=4` (2 000 rows per account, matching Ramp's 20 × 100
  ceiling) and a shared `MAX_TRANSACTION_PAGES=20` budget so an operator with many accounts
  cannot turn one 10-minute cycle into hundreds of requests. A transactions-page failure warns
  and stops **that account's** walk only — the accounts pass has already succeeded by then and
  must not be discarded. **Because this is a finance connector the omissions are the design:**
  `details` never reaches the index, because it carries the COUNTERPARTY's payment credentials
  (the `electronicRoutingInfo` / `domesticWireRoutingInfo` / `internationalWireRoutingInfo`
  account and routing numbers, a postal `address`, and `debitCardInfo` / `creditCardInfo`
  card digits) —
  the same line `account_number_last4` already draws for the owner's own account. `attachments`
  (receipt names + download links), `glAllocations`, `relatedTransactions`, `merchant`,
  `categoryData`, `currencyExchangeInfo`, `checkNumber`, `trackingNumber`, `feeId`,
  `requestId`, `counterpartyId` and `counterpartyNickname` are omitted too. What IS indexed:
  transaction_id / account_id / amount / status / kind / counterparty_name / bank_description /
  mercury_category / note / external_memo / created_at / posted_at / canonical_url, with the
  two memo fields truncated at Ramp's 500-char `MEMO_MAX`. Timestamps are ISO-8601 parsed to
  epoch-ms via `parseIsoMs` (`modifiedAt` = posted ?? created ?? syncedAt). Unlike the account
  row, a transaction has a real permalink: `dashboardLink` becomes `url` + `canonical_url`.
  Title is `<counterparty_name> — <amount> USD` (falling back to `bank_description`, then
  `Mercury transaction — <amount> USD`, then bare `Mercury transaction`); the USD suffix
  mirrors the account mapper, since Mercury accounts are USD-denominated and the transaction
  payload carries no currency field of its own. `mercury:transaction` stays on local MiniLM
  embeddings — NOT added to `PROSE_HEAVY_TYPES`, with a regression test naming the decision,
  because routing to OpenAI would bill the user per bank transaction. Catalog / secrets-manifest
  / rate-limiter / sandbox-host wiring was already in place from the accounts release; no new
  vault key, no new host, no new tool surface, no schema change.
- **2026-07-29 — Raindrop connector: collections indexed as `raindrop:collection` (issue #892).**
  A `raindrop:bookmark` carried a `collection_id` with nothing to resolve it against. The sync
  handler now runs a second, independent walk over Raindrop's **two unpaginated** collection
  endpoints — `GET /rest/v1/collections` (root) and `GET /rest/v1/collections/childrens` (every
  nested one), one request each, both returning the same `{ result, items }` envelope. The
  bookmark walk deliberately reads collection id `0` (the "all raindrops" pseudo-collection),
  which is a query id neither collections endpoint returns, so it is never indexed as an item.
  `ensureRunning` / `loadCreds` are resolved once, so the unconfigured case still returns the
  exact `syncNoopResult` (no MCP spawn, no HTTP) it did before; a failure in one walk degrades
  that walk only. The new pure mapper `mapRaindropCollectionToItem` stores
  collection_id/title/count/public/view/color/sort/parent_id/created_at/updated_at/
  canonical_url; `cover` (matching the bookmark mapper's existing restraint) plus
  `access`/`collaborators`/`user`/`expanded` are deliberately not indexed.
  **`external_id` is `collection/<id>`, not the bare numeric id** — Raindrop numbers
  collections and raindrops in separate id spaces, the item primary key is
  `<service>:<external_id>`, and `upsertIndexedItem` writes `ON CONFLICT(id) DO UPDATE`, so an
  unprefixed collection id would have let collection 9001 and bookmark 9001 silently overwrite
  each other on every sync; an integration test drives a real sync with both and asserts both
  rows survive. Bookmarks keep their existing bare-id `external_id` — re-prefixing them would
  orphan every already-indexed row. `metadata.collection_id` is the raw **number** so it joins
  a bookmark's `metadata.collection_id` (also covered by an integration test that runs the join
  in SQL), and `parent_id` comes from `parent.$id` (null for a root collection). `url` /
  `canonical_url` are **null**: the API returns no URL for a collection, and constructing an
  app deep link would invent data the vendor did not send. `raindrop:collection` stays OFF
  `PROSE_HEAVY_TYPES` (local MiniLM 384-dim), matching `raindrop:bookmark`: the Collection
  object has no description field at all, so there is no prose to embed. Three new read tools
  (`raindrop_collections_list` / `raindrop_collection_get` / `raindrop_collections_search`);
  `hitlRequired` stays empty. Catalog / secrets-manifest / rate-limiter / sync-registration
  wiring already existed and was verified unchanged.
- **2026-07-29 — Google Meet indexes participant detail, issue #893.**
  The Meet connector indexed conference records — a start time, an end time and an id — which
  made a meeting essentially unfindable. Participants now enrich the **existing**
  `google_meet:meeting` item rather than becoming their own item type: a participant has no
  title, no body, no URL and no meaning outside its conference record, so N rows per meeting
  would only dilute search results, and the codebase precedent is already
  `apple:event.attendees` / `imap:email.participants` — there is no attendee item type
  anywhere. The syncable issues one extra
  `GET /v2/conferenceRecords/{id}/participants?pageSize=100` per record, in a SINGLE page,
  using the collection's `totalSize` for the true head-count when the roster is clipped at
  `MAX_INDEXED_PARTICIPANTS=100` (~8 KB, well inside the 64 KB per-item metadata ceiling).
  **No scope change:** `conferenceRecords.participants.list` accepts the
  `meetings.space.readonly` scope this connector already declares, so there is no re-consent
  and no OAuth-registry / config / Tauri-allowlist edit. Each participant is reduced to
  `{ kind: "signed_in" | "anonymous" | "phone", id, displayName }` — `id` is the `users/{id}`
  directory id (People API / Admin SDK interoperable), present only for signed-in users; a
  phone join keeps the partially-redacted number Google itself returns, because it is the only
  thing identifying a dial-in participant. **`earliestStartTime` / `latestEndTime` are
  deliberately not indexed**: they answer "how long did each person stay", which is attendance
  surveillance, not "who was in that meeting" — the conference record's own start/end already
  bound the meeting. The opaque participant resource `name` is dropped for the same reason `id`
  is kept. The synthesized title now leads with who was there
  (`Meeting with Ada Lovelace, Grace Hopper +37 — 2024-01-02`, capped at three names), a
  deliberate change: `Meeting 2024-01-02` was unsearchable, and nobody recalls a meeting by its
  date. The v1 title survives as the fallback whenever no participant carried a name, and
  `body_preview` carries the full stored roster so every attendee is searchable, not just the
  three the title has room for. A per-record participants `403`/`404`/parse failure warns and
  indexes the record with an empty roster rather than aborting the cycle and losing the
  conference records; `UnauthenticatedError` still propagates so a dead token reaches the
  scheduler. A record with no `name` — which the mapper would reject anyway — costs no
  participants request. `google_meet:meeting` stays on local MiniLM embeddings, with a
  regression test naming the decision. **Transcripts remain deferred** — they are the most
  sensitive content a person owns and need their own scope and consent design.
- **2026-07-29 — Readwise connector: books indexed as `readwise:book` (issue #891).**
  A `readwise:highlight` carried a `book_id` with nothing to resolve it against. The sync
  handler now runs a second, independent single-pass walk over `GET /api/v2/books/` — the same
  DRF `{ count, next, previous, results }` envelope, the same `MAX_PAGES=20` cap, the same
  `Authorization: Token <token>` credential, resolved once so the unconfigured case still
  returns the exact `syncNoopResult` (no MCP spawn, no HTTP) it did before. A failure in one
  walk degrades that walk only. The new pure mapper `mapReadwiseBookToItem` stores
  book_id/title/author/category/source/num_highlights/asin/tags/document_note/source_url/
  highlights_url/last_highlight_at/updated_at/canonical_url; `cover_image_url` and the
  resurface-scheduler fields are deliberately not indexed. **`external_id` is `book/<id>`, not
  the bare numeric id** — Readwise numbers books and highlights in separate sequences, the item
  primary key is `<service>:<external_id>`, and `upsertIndexedItem` writes
  `ON CONFLICT(id) DO UPDATE`, so an unprefixed book id would have let book 9001 and highlight
  9001 silently overwrite each other on every sync; an integration test drives a real sync with
  both and asserts both rows survive. Highlights keep their existing bare-id `external_id` —
  re-prefixing them would orphan every already-indexed row. `metadata.book_id` is the raw
  **number** so it joins a highlight's `metadata.book_id` (also covered by an integration test
  that runs the join in SQL). `canonical_url` is `source_url`, falling back to the Readwise
  book-review page for Kindle/ePub books with no public source URL. `readwise:book` stays OFF
  `PROSE_HEAVY_TYPES` (local MiniLM 384-dim), matching `readwise:highlight`: a book record is a
  title, an author and a short note, and adding it would push every hybrid-mode user's whole
  library through OpenAI on the next embed pass. Three new read tools
  (`readwise_books_list` / `readwise_book_get` / `readwise_books_search`); `hitlRequired`
  stays empty. Catalog / secrets-manifest / rate-limiter / sync-registration wiring already
  existed and was verified unchanged.

- **2026-07-28 — `nimbus init` could never actually index; found by running the funnel.**
  The zero-config path shipped (#887) with its sync step covered only by unit tests using an
  injected fake. Run against a real gateway for the first time, it failed:
  `connector.sync { serviceId: "filesystem" }` returned **`Invalid serviceId`**, so `init`
  degraded to the generic next step and never printed the real `file:line` that was the whole
  reason for building the index-driven picker. The same error hit
  **`nimbus connector sync filesystem`** — the command `init` and the README hand a first-time
  user — which exited 1. Cause: `requireRegisteredSchedulerServiceId` admitted only catalog
  connector ids and `mcp_*` user-MCP ids, but the four LOCAL syncables (`filesystem`, `blame`,
  `openapi`, `obsidian`) are registered straight into the scheduler by `assemble.ts` with no
  catalog entry, so **none of them could be synced on demand**. Indexing still happened —
  the scheduler registers with `nextRunAt = now` — so the data landed seconds later; the
  promise was mistimed, not absent. Fixed with an explicit `GATEWAY_SYNCABLE_SERVICE_IDS`
  SSoT admitted alongside the existing branches; membership only widens which NAMES are
  addressable, the `persistedConnectorStatuses` registration check still authorises the sync.
  A drift test reads `assemble.ts` and fails if the two sites disagree in either direction.
  Also fixes an asymmetry surfaced by the same session: **`NIMBUS_GATEWAY_SOCKET` was read
  only by the CLI** (`cli/src/paths.ts`), never by the gateway, so setting it left the CLI
  dialling a socket that would never be bound — `nimbus start` sat in "Waiting for Gateway
  IPC" for its full 60s timeout and failed with a healthy but unreachable gateway. The
  gateway now honours it too, as a separate override from `NIMBUS_CONFIG_DIR` so a
  test-isolation mistake cannot silently reroute live IPC. Verified end-to-end against a real
  gateway in an isolated config+data dir: `init` now prints
  `nimbus why src/auth.ts:1   # verifyToken` and that command returns real authorship.

- **2026-07-28 — Zero-config onboarding: `nimbus init`, and the LLM demoted to optional.**
  The zero-config path already existed and was simply unexposed — `synthesize.ts` returns a
  deterministic render when no LLM is configured, and filesystem indexing needs no
  credentials — while the README asserted the opposite ("Nimbus needs an LLM"). This is
  packaging, not new capability. **`nimbus init`** indexes the git repo in the current
  directory with no PAT, no API key, and no network: it **appends** a `[[filesystem.roots]]`
  block (with `code_index = true`) to `nimbus.toml` rather than rewriting it, so comments and
  key order survive — a `.bak` is kept regardless — then starts the gateway, syncs, and prints
  a real `file:line` from the user's own repo to try with `nimbus why`. A gateway that was
  already running is asked to restart rather than silently syncing a root it cannot see
  (roots are read once at startup); every failure after the config write degrades to the
  generic next step instead of failing the command. The `file:line` comes from the new
  read-only **`index.demoSymbol`** — deliberately NOT renderer-exposed (`I7`: no renderer
  consumer) and `FORBIDDEN_OVER_LAN` (`I5`: a peer has no use for this machine's onboarding
  hint). Picking from the index rather than the filesystem means a lockfile or binary asset
  can never be suggested. The no-LLM render now carries a footer marking it a supported mode,
  and the gateway's `no_api_key` message names **both** routes (local Ollama, hosted key) plus
  the fact that indexing, `nimbus why`, and the briefs need no LLM at all — the guidance lives
  at the source so the CLI, TUI, and VS Code extension all surface it. `NIMBUS_CONFIG_DIR`
  now relocates the config dir in **both** `platform/paths.ts` and the CLI's own `paths.ts`
  (config dir only — never the data dir or socket); a one-sided override would have had the
  CLI writing config the gateway never reads. Design-spec open question 1 is settled
  empirically: config loading survives a `nimbus.toml` with no `[llm]` block.

- **2026-07-27 — Rust toolchain CI hardening, and two notification contracts pinned.**
  The `Cargo deny` job died in `Setup Rust` on run 30232465108 — a TLS reset from
  static.rust-lang.org on an unretried `rustup toolchain install`, of which there were four
  copies. The failing one was **redundant**: `cargo-deny-action` is a Docker action on
  `rust:1.85.0-alpine3.20` carrying its own cargo, so that step is deleted outright. The
  three genuine ones now go through `.github/actions/setup-rust-toolchain`, which retries
  three times with backoff and propagates the last exit code. Pre-warming was ruled out by
  experiment, not assumption: rustup re-syncs the channel manifest on every
  `toolchain install`, even for an already-installed pinned version. The action parses
  `channel` and `components` from `rust-toolchain.toml`, so the 1.95.0 pin is no longer
  copy-pasted into `codeql.yml` and `security.yml`; `setup-rust-tauri` also stops installing
  `stable` and then pulling 1.95.0 down a second time. `dtolnay/rust-toolchain` is now unused
  and its dependabot + pin-freshness entries are retired, with the pin-freshness test replaced
  by one that fails when an override names an action the repo no longer pins.
  **Notification contracts** (nimbus-agent/Nimbus#809, #810) are now recorded in
  [`architecture.md`](./architecture.md) from the emit sites: `connector.configChanged`
  carries the full post-mutation snapshot, and `workflow.run({ stream: true })` reuses the
  **untagged** `agent.chunk` — the same method `engine.askStream` uses, so chunks cannot be
  attributed to a run and a client must keep one streaming workflow per connection.
  `@nimbus-dev/client` consumes both. Also fixes **#812**: the connector-auth OAuth suite
  depended on winning a module-load race for `Config`'s env snapshot, and on a machine with
  Google OAuth configured it fell through the fail-closed guard into a real PKCE round-trip.
  **Tests are now hermetic against real credentials by construction** — a `[test] preload`
  (`scripts/test-preload/hermetic-credentials.ts`) blanks credential-shaped `NIMBUS_*` /
  `OPENAI_*` / `ANTHROPIC_*` env vars before any test module loads, and therefore before
  anything can import `config.ts` and freeze its snapshot. Per-file blanking cannot close that
  class, because "am I the first file to load config.ts?" is not something a test file can
  know; a preload is ordered ahead of all of them by construction. It announces the NAMES it
  blanked (never values), so the next occurrence is visible rather than silent, and a wired-in
  test asserts the preload actually ran. Tests that set a credential themselves are unaffected —
  only inheritance from the developer's shell is removed, which no test may depend on since CI
  has none set.

- **2026-07-26 — P2 Release Train Phase 2: dependency-DAG edges.** `audit:release-staleness`
  now also watches the npm propagation graph. A `<pkg>:publish` edge compares each upstream's
  component-prefixed release tag to npm `@latest`, catching a package that is tagged but never
  published; a `<pkg>:<consumer>` edge compares every consuming repo's **lockfile-resolved**
  version to npm `@latest`, since a semver range misleads in both directions (a caret permits
  newer, but a caret on a `0.x` pins the minor). The lockfile reader counts only the hoisted
  entry plus the consumer's own workspaces, so a copy nested inside a third-party package is
  never mistaken for what local code resolves. Registry reads carry a 5s timeout and degrade to
  indeterminate; bump PRs already open count as caught-up. Ships red on confirmed drift — the
  CLI resolves client 0.5.0 against a published 0.12.1.
- **2026-07-26 — P2 Release Train Phase 1: the `release-staleness` gate.** A declarative
  `.github/release-train.json` lists every propagation edge; `audit:release-staleness` reads three
  version heads — intended (release-please manifest + its bump-commit age), published (the latest
  Release actually carrying its `SHA256SUMS` asset), distributed (each channel's live file, or
  winget dir-or-open-PR) — and goes red when a channel lags past the 6h grace window, or when a
  release *phantoms* (manifest bumped, nothing built). Runs `--strict` as a new job on the weekly
  `org-drift-sweep` cron; all reads are public, so no App token is minted. Unreadable or
  unparseable inputs degrade to `indeterminate`, never `stale`; under `--strict` a run that
  evaluated nothing is red, so indeterminate cannot read as "all clear". Its first live run caught
  a genuine phantom: the manifest claims `0.27.0` with no `v0.27.0` tag or Release built. Also
  closes the CLA-coverage robustness follow-up — `_gh-audit.ts` now surfaces the `gh` HTTP status,
  and a non-404 per-repo read failure is indeterminate rather than "cla.yml absent".

- **2026-07-24 — `nimbus index add <path>` registers a blame root.** New local-only
  `filesystem.ensureRoot` IPC method + `nimbus index add` CLI register a git repo as a
  blame/index root (persisted to `registered-roots.json`, merged with `[[filesystem.roots]]` on
  next start, TOML wins) — no hand-editing `nimbus.toml`. LAN-forbidden (I5); rejects any path
  that is not an existing `.git` directory.

- **2026-07-24 — Whole-file blame indexer.** A new `blame` syncable populates `git_blame_line`
  whole-file (one row per line, all languages) across git-tracked files changed in the last 90
  days, per configured `[[filesystem.roots]]` git repo. Incremental via a per-repo last-blamed
  HEAD cursor, with a full re-blame fallback on rewritten history; sequential and capped at 400
  files/tick. Reuses the V32 table — no migration. Turns line-level blame from a sparse
  security-scan byproduct into a real line-level substrate.

- **2026-07-24 — GitHub connector PR-title enrichment.** GitHub connector now enriches indexed PR
  titles via a pull-detail fetch, replacing id-only `PR #N` fallbacks.

- **2026-07-24 — `nimbus why`: six-lane provenance briefs over the local relationship graph
  (why-lens step 1b, Spine S1).** A ninth built-in agent answers "why is this line/file the way it
  is?" by fanning out six parallel sub-agents over the 1a graph edges: authorship (blamed commit),
  pull request (`merged_as`), ticket (`resolves`), discussion (`mentions`), driver/what-drove-it (a
  temporally correlated incident within a 48h window — never a causal claim), and downstream
  (reverse `depends_on` from the file's indexed symbols). `agents.why` returns a `sessionId`
  immediately and streams the brief via `why.briefReady`/`why.briefError`; `agents.whyPeek` is a
  synchronous sub-300ms companion returning a one-line answer (author · sha · date · subject · PR #
  · ticket) with no notification round-trip. Every lane degrades to a gap note naming the missing
  connector or relation instead of going silent; the downstream lane currently degrades on most real
  indexes, since the graph populator emits `depends_on` at workspace→package granularity today —
  symbol-level edges are a tracked populator follow-up, not a defect in this brief. **One new local
  read, no new connector call and no HITL:** an unblamed line triggers a single, root-fenced,
  cached-forever single-line `git blame` subprocess (`ensureBlameLine` → `git_blame_line`), gated to
  paths inside a configured `[[filesystem.roots]]` repo. New CLI: `nimbus why <ref> [--line <n>]
  [--peek] [--json]`, where `<ref>` is a `path[:line]` or a bare symbol name resolved against
  indexed code symbols. Tauri `ALLOWED_METHODS` count moves 99 → 101 (invariant I7). **No migration,
  no new invariant, no new HTTP write route** — read-only end to end. The same PR lands
  `nimbus index regraph [--json]` (`index.regraph`), which re-runs the graph populator over every
  indexed item so a populator change reaches historical rows without a full re-sync; it threads the
  live service-identity resolver so `correlates_with` edges between resolver-bound
  deployments/incidents survive the backfill, and its `graphed` counter reflects only items that
  actually wrote graph rows (`skipped > 0` warns on stderr, pointing at the gateway log). Two 1a
  backlog fixes ride along: a ticket-key standards stoplist (rejecting standards-body false
  positives like `RFC 2119`/`ISO 8601` as issue-key matches) and `obsidian_note` added to
  `REGRAPH_TYPE_ORDER` (notes are `backlinks` targets and must be graphed before anything that
  references one). Spec + plan pruned in the #831 doc cleanup, no successor.

- **2026-07-23 — Ecosystem Stage 1 complete: the client surface goes 15 → 52 methods.** The gateway
  dispatches ~212 JSON-RPC methods; `@nimbus-dev/client` exposed 15 of them, so entire namespaces
  were built, dispatch-wired and Tauri-allowlisted yet unreachable from any npm client. All eight
  waves of `docs/ecosystem-roadmap.md` (since retired) Stage 1 shipped across client
  `0.7.0` → `0.11.0`: `agents.*` (8), `consent.respond`, the five diagnostics methods, `audit.*`
  (3), `session.*` (4), `metrics.dora` + `deploy.preflight`, `connector.*` (12), `workflow.*` (5).
  **No gateway behaviour changed** — every method was already dispatched; the work was runtime
  validators, `MockClient` parity stubs, and shape archaeology against gateway source. Two contract
  facts the client now encodes rather than smooths over: `agents.*` resolve from an
  `<agent>.briefReady` **notification**, so the client subscribes before calling and correlates by
  session; and HITL-gated connector methods **do not deny uniformly** — `connector.addMcp` and
  `connector.remove` resolve `{ status: "rejected", reason }` while `connector.reindex({ depth:
  "full" })` rejects the promise, a difference the `GatedRejection` type makes callers handle.
  Gateway-side, the same workstream added a **brief-shape drift gate**
  ([#806](https://github.com/nimbus-agent/Nimbus/pull/806)): `scripts/agent-brief-shape.ts` reduces
  every `briefReady` payload — walking *every* array element, not just index 0 — to a `path:type`
  signature snapshot, so changing an agent's brief shape here fails CI on that PR instead of
  silently leaving the client validating a contract the gateway no longer speaks. That PR also put
  `scripts/` (151 files) under `tsc` for the first time, fixing 42 pre-existing errors. Three
  gateway-side gaps were found and deliberately left open, each filed rather than patched inside a
  client PR: `connector.addMcp`'s consent payload reads `command`/`args` that its
  `{ serviceId, commandLine }` params never populate (the security prompt renders blank);
  `connector.configChanged` is emitted but unexposed; `workflow.run({ stream: true })` chunks have
  no public API.

- **2026-07-22 — Research briefs: an owner-triggered multi-source research pass over the local
  index (Spine S1).** The gateway can now assemble a citation-validated report from a handful of
  captured web sources, entirely on the local HTTP write surface. **Four new I13 write routes plus
  a bearer-gated read** (`WRITE_ROUTE_ALLOWLIST` 8 → 12): `POST /v1/briefs` opens a run,
  `POST /v1/briefs/{id}/sources` feeds it a captured article, `POST /v1/briefs/{id}/run` triggers
  synthesis, `POST /v1/briefs/{id}/save` persists the finished report to the local index, and
  `GET /v1/briefs/{id}` (bearer-authed, not open) reads run status. **Run state is in-memory only**
  (`BriefRunController`) — captured source bodies never touch disk, and a gateway restart drops
  every in-flight run; only a saved report survives. **The report is citation-validated**: every
  quote in the synthesized output is checked against the captured source text before the report is
  accepted, and the response carries a typed `synthesis: { model, remote, disclosure? }` field so a
  client can render a "generated by a remote model" banner instead of burying the disclosure in
  prose. Saved reports land as `nimbus:research_brief` items, which now join `PROSE_HEAVY_TYPES`
  for the OpenAI-1536 / MiniLM-384 embedding split. **The concurrency cap is a `503 briefs_busy`,
  deliberately not a `429`**: retry pacing assumes a `Retry-After` the caller can act on, but a slot
  frees only when some other run expires (up to the full TTL), so no honest `Retry-After` value
  exists — omitting it keeps callers out of a retry loop that can't succeed. **`[briefs]` is
  default-off** in `nimbus.toml`, so `nimbus clip status` now also prints a `briefs: enabled` /
  `briefs: disabled (enable [briefs] in nimbus.toml)` line (threaded through the `clip.status` IPC
  as `briefsEnabled`) — otherwise a paired browser's first brief request would silently 404 with no
  hint why. **No new invariant, no migration** (`research_brief` reuses the `item` table). Spec +
  plan pruned in the #831 doc cleanup, no successor.

- **2026-07-20 — `index.queryItems` now returns camelCase `NimbusItem` rows, not raw SQLite columns
  (breaking IPC contract change).** `rpcIndexQueryItems` used to hand back raw `SELECT * FROM item`
  rows, so the unified V3 column names (`title`, `type`, `modified_at`, `body_preview`,
  `external_id`, ...) leaked over IPC while every other read path mapped rows through `rowToItem`.
  New `LocalIndex.listItems()` owns the list SQL and the mapping together and returns
  `IndexedItem = NimbusItem & { indexPrimaryKey }` (the `service:external_id` composite key, which
  bare `NimbusItem.id` doesn't uniquely provide across services); `body_preview`, `author_id`,
  `synced_at`, `canonical_url`, and `pinned` are intentionally dropped from the narrowed wire shape.
  `index.querySql` (the `nimbus query --sql` guarded-SELECT path) is unaffected and still returns raw
  rows by design. The CLI `nimbus query` renderer (`packages/cli/src/commands/query.ts`) now handles
  both shapes: `isItemLikeRow` accepts `name` or `title`, and `printItemCard` / `printKvBlock` read
  `name`/`itemType`/`modifiedAt` with a `title`/`type`/`modified_at` fallback, so TTY card rendering
  and relative-timestamp formatting keep working for `queryItems` results instead of silently
  degrading to raw key/value blocks with a bare epoch integer. A structural test in
  `diagnostics-rpc.test.ts` asserts no top-level response key is snake_case across every returned
  item, so a regression to raw-row passthrough fails regardless of how it's written.

- **2026-07-20 — npm supply-chain assurance: provenance monitoring + `NPM_TOKEN` absence guard.**
  The weekly `secret-health.yml` job now carries three new rows alongside the existing App-health/
  PAT/cert checks: two npm provenance probes (`@nimbus-dev/sdk`, `@nimbus-dev/client`), each resolved
  to its latest published version and checked via the org's `verify-npm-provenance` composite action
  in monitor mode (confirms the publish attestation + SLSA provenance predicate are present and name
  the expected source repo/workflow), and an `NPM_TOKEN` absence guard that hard-fails if the deleted
  secret (revoked 2026-07-19) is ever re-created — publishing is meant to be OIDC-only. New
  `ProvenanceStatus`/`AbsenceStatus` classifiers (`classifyProvenanceOutcome`, fail-closed to
  `indeterminate` on any unset/unrecognised value; `classifySecretAbsence`) feed the existing
  de-duped issue filer. The `source-mismatch`/`missing-provenance` alert rows now carry the action's
  own `detail` output plus the resolved version (`composeProvenanceDetail`), so an alert names what
  actually happened instead of a static placeholder. Each package's version is now resolved and
  written to `$GITHUB_OUTPUT` independently, so one package's registry hiccup no longer blanks the
  other's probe too. `docs/ci-secrets.md` documents the new rows, the branched remediation per row
  kind (rotate vs. unpublish/deprecate vs. delete-the-secret — "rotate" does not apply to a
  provenance or absence row), and corrects two overclaims: the 2FA-required/no-tokens npm setting
  blocks token-based publishing, not human publishing (an interactive maintainer with an OTP can
  still publish by hand). Three accompanying PRs merged the same day in the satellite repos:
  `nimbus-vscode` [#35](https://github.com/nimbus-agent/nimbus-vscode/pull/35) adds that repo's own
  `secret-health.yml` weekly PAT-liveness probe (the secrets stay where they are — copying them here
  to centralise monitoring would spread credentials to save a workflow file) plus a `.vsix` build
  provenance attestation, and `nimbus-sdk` [#12](https://github.com/nimbus-agent/nimbus-sdk/pull/12)
  and `nimbus-client` [#5](https://github.com/nimbus-agent/nimbus-client/pull/5) add the release-time
  gate to their own release workflows: a pre-publish preflight asserting OIDC is available and npm
  meets the 11.5.1 floor, then two post-publish checks — the just-published version is installed from
  the registry into a clean tree so `npm audit signatures` verifies *that* tarball (run in the repo
  root it would audit the project's own dependencies, which never include the package just shipped),
  and the provenance is asserted to name the expected repo, workflow and commit. No migration, no new
  invariant.

- **2026-07-19 — docs: Phase 6 closed out; the Sequencing Spine is now the live build order.** A
  status-drift sweep across the roadmap and its mirror surfaces. `docs/roadmap.md` moves **Phase 6 —
  Team** out of `## Active` into `## Shipped` and gives `## Active` a new **Spine S1 — Local Brain**
  section (delivered: the egress ledger + `nimbus prove`, 2026-06-20; remaining: the
  implicit-knowledge agent triad, answer-quality surfaces, the ownership graph; plus the parked S3
  MCP-server branch). Fourteen Phase-6 checkboxes that shipped but were never ticked are now checked
  with their delivery date + slice ref (the six warehouse/BI connectors, the cloud janitor,
  tribal-knowledge extraction, blast-radius preflight, and the five Share & Virality primitives);
  **team-owned workflow pipelines** is explicitly deferred to spine slot S4, and the stale
  "Slices 6b/6c + 7–9 remain planned" acceptance-criteria banner is replaced with the all-satisfied
  status. The web-clipper rows now record the **browser extension as delivered** (`v0.1.0`,
  satellite repo `nimbus-agent/nimbus-web-clipper`; store listings still pending their one-time
  bootstrap) rather than as a future "Plan B". Mirrored into `CLAUDE.md` / `GEMINI.md` (status line),
  `docs/architecture.md` (Phase 6 complete + Slice 9 + egress ledger; Slice 8 date corrected to
  2026-06-15 → 2026-06-18), `docs/README.md`, the Starlight web-clipper page, and the
  `nimbus-ipc` / `nimbus-commands` skills (which gained the missing `clip.*` IPC + `nimbus clip` CLI
  sections). `docs/SECURITY-INVARIANTS.md`'s worked example stopped claiming `I28` is the next free
  number (ceiling is `I30`; `I28` is reserved), and the four `I28` sites now describe that branch as
  **parked** rather than in-flight. One code change rode along: `packages/cli/src/commands/registry.ts`
  was missing eight registered commands (`admin`, `chatops`, `clip`, `egress`, `mcp-server`,
  `policy`, `prove`, `security`), which `audit:readme-cli` turns into a CI failure the moment a doc
  mentions one — surfaced by this sweep and fixed.
- **2026-07-19 — fix: `POST /v1/clips` accepts real articles (per-route body cap).** The I13 write
  dispatcher enforced a single 8 KiB request-body cap across every write route. That bound was sized
  for the six control-plane routes it was written for (deploy annotations, SCIM, admin policy, Teams
  events); when Slice 9 added the two web-clipper routes to the allowlist, clip ingest silently
  inherited it — so any page whose readable body exceeded 8 KiB (i.e. most real articles) was
  rejected with `413 payload_too_large` and the extension could never complete its primary function.
  The cap is now **per-route** (`ResolvedRoute.maxBodyBytes`), enforced unchanged at both sites (the
  `content-length` pre-check and the post-read `byteLength` check), with the same
  `413 payload_too_large` + audit-rejection shape. `POST /v1/clips` gets **1 MiB**; every other
  route — including `POST /v1/clips/pair/confirm`, whose body is a 6-digit `{code}` — keeps
  **8 KiB**. The raised cap is paid for with a matching **per-route rate limit**
  (`ResolvedRoute.maxRequestsPerWindow`, which may only tighten the server-configured limit, never
  loosen it): `POST /v1/clips` runs at **20/min** while every other write route keeps **60/min**,
  holding the worst-case burst to ~20 MiB/min instead of ~60 MiB/min — the tightening the
  write-surface playbook requires whenever a body cap is loosened. Clipping is a low-frequency human
  action, so 20/min is generous in practice; the `X-RateLimit-*` headers report whichever limit
  applied. Deliberately not user-configurable: both bounds stay code-level invariants. No
  migration, no invariant change, no wire-contract change. Regression guards: per-route cap and
  rate-limit tests in `http-write-routes.test.ts` (including the exact 1 MiB / 1 MiB + 1 boundary
  pair and the 20/min-vs-60/min split) plus a realistically-sized (~40 KiB) article body in the clip
  E2E, which previously round-tripped a 44-byte body and is why this shipped undetected. Fixes
  [#771](https://github.com/nimbus-agent/Nimbus/issues/771).
- **2026-07-16 — `nimbus clip list` + `nimbus clip delete`.** Two new read/manage commands
  for web clips, backed by two new local-index IPC methods (`clip.list`, `clip.delete`).
  `clip list` shows saved clips newest-first with `--tag` (SQL `json_each` filter, so
  `--limit` is honored), `--limit`, and `--json` (incl. `wordCount`). `clip delete` removes a
  clip by ID or by page URL (article + all selections), or `--all --yes` to clear everything;
  deletes go through `deleteItemByPrimaryKey` (graph + FTS + embedding/vec cascade cleanup) and
  are strictly `web_clip`-scoped. No new invariant, no migration (read + local delete is not
  outbound egress).
- **2026-07-16 — `nimbus clip pair` prints the gateway URL.** The pairing command now echoes the gateway's loopback HTTP origin (`http://127.0.0.1:<port>`, from `NIMBUS_HTTP_PORT`) alongside the one-time code, so the owner can copy both into the web-clipper extension's Options page from a single command instead of hunting for the URL in the earlier `nimbus serve` output. When the gateway has no HTTP surface open, the command warns to restart with `nimbus serve --port`. Wiring: `clip.pair` echoes the new optional `gatewayUrl` field (set at boot in `assemble.ts` → `clipHttpBaseUrl` IPC option → `ClipRpcDeps.httpBaseUrl`); no new invariant, no migration, no wire-contract change for the extension (the URL is owner-facing CLI output).
- **2026-06-22 — VS Code extension extracted to its own repo.** The VS Code / Open VSX extension moved out of the monorepo to the standalone repo [nimbus-agent/nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode) (first standalone release `v0.2.0`); it consumes the published `@nimbus-dev/client` and releases independently of the Gateway. To make that possible, `@nimbus-dev/client` gained a publish-time rewrite of internal `workspace:*` deps to concrete versions (`client@0.2.4`) so the tarball installs standalone. Removed the `packages/vscode-extension` workspace and `.github/workflows/publish-vscode.yml`.

## Phase 6 — Team (✅ Complete — Slices 1 + 3 shipped 2026-06-05; Slices 2 + 4 shipped 2026-06-07; Slice 5 shipped 2026-06-09; Slice 6a shipped 2026-06-11; Slices 6b + 6c shipped 2026-06-12; Slice 7 Wave 7a shipped 2026-06-13, Waves 7b + 7c shipped 2026-06-14; Slice 8 shipped 2026-06-18)

Phase 6 ships as 9 sequenced delivery slices (see [`docs/roadmap.md` § Phase 6](./roadmap.md#phase-6--team)). **Slice 1 — Federation Core** is the substrate every other slice depends on.

### 2026-06-22

- **Slice 9 — Web clipper (gateway side):** the gateway surface that lets a browser extension push web pages into the local index — the inbound-push analogue of the SCIM / Teams / deployment routes (no MCP connector). **Two new I13 write routes** (`WRITE_ROUTE_ALLOWLIST` 6 → 8): `POST /v1/clips` ingests a clip as a `nimbus:web_clip` item (`service:"nimbus"`, `type:"web_clip"`) — readable-article or text-selection body, URL canonicalized (tracking params stripped, root slash preserved), article re-clips dedup on the canonical URL while each selection is a distinct id; and `POST /v1/clips/pair/confirm` mints the extension's bearer token. **A bearer-authed READ route** `POST /v1/clips/related` returns related local items via an FTS query (selection-primary, own-host de-prioritized; FTS5 syntax neutralized via `ftsMatchQuery` escaping + bound params). **Auth is a pairing handshake:** the owner runs `nimbus clip pair [--label]` to open an in-memory, single-use, TTL + attempt-capped pairing window (created once as a singleton in `assemble.ts`, shared by the `clip.*` IPC dispatcher and the HTTP confirm route); the extension redeems the one-time code for a token stored in a labeled Vault map (`http_api.web_clipper_tokens`) so Chrome + Firefox can pair concurrently. `nimbus clip status` lists each device's label + token fingerprint (never the raw token) and `nimbus clip revoke [<label>|--all]` is the cut-off for a lost/compromised extension. **Embedding:** `nimbus:web_clip` joins `PROSE_HEAVY_TYPES` (OpenAI-1536, MiniLM-384 fallback). **New invariant I30** (+ `security-invariants.test.ts` enforcement with a no-mint witness): a token is minted ONLY behind a live owner-opened pairing window — no window / expired / wrong code → 403, fail-closed, no mint; the window is strictly in-memory (a restart drops it; minted tokens persist in the Vault map). Clip ingest is *inbound* (it writes the local index, no outbound egress), so it is NOT HITL-gated and NOT egress-ledgered. **No migration** (`web_clip` reuses the `item` table + FTS triggers). An E2E proves the real round-trip: open the pairing window → `POST /v1/clips/pair/confirm` → `POST /v1/clips` (Bearer) → `nimbus search` finds the clip. The Chrome + Firefox MV3 extension itself shipped as the follow-on Plan B (`v0.1.0`, 2026-07-19) from its own repo `nimbus-agent/nimbus-web-clipper` (mirrors the `nimbus-vscode` satellite repo). The implementation plan was pruned in the #766 doc cleanup and the design spec in the #831 doc cleanup, no successor. **Count moves I1–I29 → I1–I30 (I28 reserved).**

### 2026-06-21

- **Slice 9 E — Apple Mail + iCloud Calendar connector (`apple`):** A single first-party MCP connector that indexes **iCloud Mail** (over IMAP, `imap.mail.me.com:993` TLS) and **iCloud Calendar** (over CalDAV, `caldav.icloud.com` → per-account `p##-caldav.icloud.com`) into the local index as `apple:email` and `apple:event` items, and exposes **four HITL-gated write tools** — `apple_mail_send`, `apple_mail_draft_create`, `apple_calendar_event_create`, `apple_calendar_event_delete`. The mail side **reuses** the shared email tool kit (`registerEmailConnectorTools` + the gateway's `fetchImapMessages` / `mapImapLikeMessageToItem`); the calendar side introduces the codebase's **first CalDAV path** — a pure iCalendar build/parse module hoisted into `@nimbus-dev/sdk` (`parseICalendar` / `buildVEvent`, shared by the connector and the gateway sync, no parser dependency) plus an injectable `CalDavClient` whose real (tsdav, two-phase principal-discovery) implementation is confined to the coverage-excluded `server.ts`. Recurrence is expanded **server-side** via CalDAV `<C:expand>` (no client RRULE engine); overridden occurrences key on `<UID>:<RECURRENCE-ID>`. **Privacy bounds:** mail = headers + attachment METADATA + ≤2000-char preview (never bodies/bytes); calendar = summary/start/end/location/organizer/status/recurrence + ≤2000-char notes preview + attendee emails. **Forced sender:** both write-mail tools pin `From` to the authenticated `apple.icloud_email`. **Auth:** two Vault keys `apple.icloud_email` / `apple.icloud_app_password` (a single app-specific password authenticates IMAP+SMTP+CalDAV), injected as `APPLE_ICLOUD_EMAIL` / `APPLE_ICLOUD_APP_PASSWORD` at spawn; sync + spawn both no-op when either is unset. The lazy-mesh manifest declares `caldav.icloud.com` statically and folds the non-443 `imap.mail.me.com:993` / `smtp.mail.me.com:587` host:port endpoints in at spawn (mirroring `phase3AddImapMcp`). New rate-limiter provider `apple` (60 rpm / burst 10); `apple:email` routes to 1536-dim embeddings (prose), `apple:event` stays on local MiniLM 384-dim. **Cross-platform** (the roadmap's "macOS only" label is relaxed — the IMAP/CalDAV transport has no native macOS dependency; available + tested on Windows/macOS/Linux). **Writes ride the generic email/calendar dispatch path** behind the existing executor I2 HITL gate — **no new invariant, no `connector-write-registry`/I26 entry, no migration** (`event` is a new item type but the index is type-agnostic). The four write action types (`email.send` / `email.draft.create` / `calendar.event.create` / `calendar.event.delete`) are already in `HITL_REQUIRED_BACKING`; a connector contract test locks the 8-tool surface + the metadata-only invariant, and an executor-level test proves the gate fires (consent before dispatch; reject ⇒ no dispatch) for all four writes.
- **Slice 9 W1 — HITL-gated GitOps + ML writes (ArgoCD / Flux / MLflow):** Six new write tools, each executing ONLY behind the LOCAL owner's executor HITL gate (I2): `argocd_app_sync` / `argocd_app_rollback` (`POST /api/v1/applications/{name}/sync|rollback`), `flux_kustomization_reconcile` / `flux_helmrelease_reconcile` (PATCH the CR with a `reconcile.fluxcd.io/requestedAt` annotation — the `flux reconcile` mechanism, requiring the SA's `patch` RBAC verb), and `mlflow_model_promote` / `mlflow_model_transition_stage` (`POST /api/2.0/mlflow/model-versions/transition-stage`; promote defaults `archive_existing_versions=true`, transition defaults false). All are async (the action is *requested*; verify via the next metadata sync). Each connector's three read tools were extracted into an exported `register<Svc>Tools(reg)` registrar (the `import.meta.main` guard now runs the stdio server), so the write tools register alongside them and stay unit-testable via `captureTools()`. **Personal + team credentials:** writes route through the credential-aware transport (personal spawn with a service-scoped vault view, or the I19 localOperator team rail); `argocd`/`flux`/`mlflow` are enrolled in `TEAM_CREDENTIAL_CONNECTORS` + `TEAM_SECRET_ANYOF_GROUPS`. **No new invariant, no migration (no schema change):** the Wave 7c warehouse-write machinery was *generalized in place* to all connector writes — `warehouse-write-{transport,dispatch}.ts` → `connector-write-{transport,dispatch}.ts`, a hoisted `ConnectorWrite` descriptor + a per-group SSoT (`gitops-ml-write-tools.ts`) + a union registry (`connector-write-registry.ts`), and **I26/D20 reworded** from "warehouse/BI write tool ids" to "connector write tool ids (warehouse/BI ∪ GitOps/ML)": the federated peer invoke gate now fail-closed rejects ANY connector write id via the union `isConnectorWriteToolId` predicate, so a peer can never trigger a GitOps/ML write over the wire (proven by a functional rejection test in `invoke-gate.test.ts`). A drift test ties the six new action types to `HITL_REQUIRED_BACKING`. **Deferred:** SageMaker + Vertex AI writes (CLI-credential connectors with no discrete token — they don't fit the team-vault/discrete-token write model) and all destructive `delete`/`drop` writes. **Adds no new invariant (the I-count is unchanged by this work).**

- **Workday connector** (read-only) — indexes workers (org chart / employee directory), time-off requests, job postings, and admin-configured RaaS custom reports from a Workday tenant (Phase 6 Slice 9). Tenant-specific OAuth2 (client-credentials); directory-safe PII allowlist (name/title/department/manager/location — no compensation/SSN/home-address/leave-reason). Four item types: `workday:worker`, `workday:time_off`, `workday:job_posting`, `workday:report`. Optional `[[connectors.workday.reports]]` nimbus.toml config for RaaS reports (same-host guard). No migration, no HITL, no new invariant.

### 2026-06-20

- **Egress Ledger & `nimbus prove` (S1 "Local Brain" — provable-locality primitive):** an always-on, append-only, BLAKE3-chained ledger of every authorized outbound action, written from `ToolExecutor.gate()` **before** `connectors.dispatch()` — a denied gate records a `result_status='blocked'` row; an append failure aborts the action (fail-closed, never dispatches). **Schema:** migration **V44** adds `egress_ledger` (`id`, `timestamp`, `source_type`, `source_id`, `destination`, `method`, `payload_summary`, `hitl_status`, `result_status`, `row_hash`, `prev_hash`) + 3 lookup indexes; the chain reuses `db/audit-chain.ts`'s genesis + BLAKE3 primitives. `destination` is the `serviceOf()` action-type prefix (never a raw URL); `payload_summary` is `redactAuditPayload`-scrubbed and capped at 256 bytes (a debugging aid, NOT the security boundary). **Invariant I29 + static complement D22:** the executor chokepoint is made *total* — D22 confines `connectors.dispatch` to `engine/executor.ts` and the ledger append to `egress/*`, so a `0`-row window is a sound negative, not a hopeful one. I28 is reserved (the MCP-server owner-sink on the in-flight `phase7-mcp-gateway-server` branch); reconcile at that merge. **Completeness wiring:** the egress sink is injected into *every* `ToolExecutor` that reaches a real connector dispatch — the agent action path (`run-ask`), chatops-approved writes, and both tribal-capture executors — while gate-only stub executors (vault/teamvault/reindex/data/auto-update/connector.auth) deliberately get no sink (their actions are local mutations, not outbound). **`nimbus prove "<query>"`** snapshots the ledger head before/after a query and prints the diff (`outbound egress events during this query: 0 ✓` for a local-only query). **`nimbus egress [verify|prune|--since|--json|--sign]`** is the report / offline chain-verify (timing-safe via `sha256HexEqualConstantTime`, I10) / HITL-gated retention; a degraded chain prints `indeterminate`, never a false `0`. The 4 read verbs (`egress.head`/`list`/`verify`/`proveWindow`) are renderer-exposed (I7, allowlist 95→99); **`egress.prune`** — the sole mutation (a continuing tombstone, not a silent gap) — is in the I2 HITL frozen set, gated through the calling client's owner-consent channel, and is NOT renderer-exposed. Receipt signing reuses the Vault-only Ed25519 share keypair (no new Vault key; the private seed never leaves the Vault). The auditor-grade portable signed export remains deferred to Phase 12.5. **Count moves I1–I27 → I1–I29 (I28 reserved).**
- **refactor (dedup) — shared REST tool registrar across 10 connectors:** Generalizes Wave A's file-local REST registrars (`registerGitlabTool` / `registerDriveTool`, #696) into one shared helper, `makeRestToolRegistrar` (`packages/mcp-connectors/shared/rest-tool-kit.ts`). It collapses the repeated standard-tool body (`requireProcessEnv(<env>) → <fetch>(token, buildPath[, buildInit]) → mcpJsonResultIfOk(<label>[, snippetMax])`) shared by the hand-rolled REST/Graph connectors: a connector supplies its registrar, token env, service label, and token-bearing fetcher once, then each tool provides only its name/description/schema + a pure `buildPath` (and optional `buildInit` for method/body). Applied to **circleci, discord, github, github-actions, gmail, google-meet, google-photos, onedrive, outlook, pagerduty**; tools with a non-standard tail (custom error text, 204 tolerance, raw-text body, bespoke write shapes) stay hand-written. Pure dedup, zero behavior change — every connector `*-sandbox.test.ts` / `*-search-filter.test.ts` stays green unedited. The Graph fetchers are unchanged, so #694's `resolveUrlWithBase` `nextLink` SSRF origin-pinning and the `snippetMax` body-snippet lengths are preserved byte-for-byte. No migration, no new invariant (the helper lives in `mcp-connectors/shared/`, the established connector-internal-helper precedent, not the SDK). Strict `bunx jscpd packages` 3.95% → 3.93% (CI duplication ratchet stays 4.0). Design spec pruned in the #766 doc cleanup, no successor.
- **security (connectors) — pagination SSRF + email header-injection hardening:** Two input-validation defenses at the MCP connector boundary, each fixed once at a shared chokepoint. **(1) `nextLink` token-exfil / SSRF:** the shared `resolveUrlWithBase` (`packages/mcp-connectors/shared/fetch-bearer-json.ts`) now origin-pins absolute URLs — a caller-supplied pagination link (`@odata.nextLink` etc.) is fetched with the connector's bearer token only when its origin matches the configured API base, else it throws and is never fetched. This protects every consumer in one place: Outlook (4 paginated tools via `makeRestFetcher`), Teams (5 tools via its `graphRequest`), and OneDrive (2 tools — its custom `graphRequest` now routes through `resolveUrlWithBase` too, also deduping its inline resolver). Relative-path callers (Gmail, Google Photos/Meet, Drive, GitHub) are unaffected. **(2) CR/LF header injection:** a shared `headerLine()` Zod helper (`shared/header-safe.ts`) rejects carriage-return/line-feed in user-supplied email-header fields (`to`/`cc`/`bcc`/`subject` and comma-separated recipient/attendee lists — never `body`, which legitimately wraps). Applied at the shared `emailToolSchemas.sendArgs` (covers imap / protonmail / fastmail) plus Gmail (`gmail_draft_create` / `gmail_message_send`) and Outlook (`outlook_mail_send` / `outlook_calendar_create`). Behaviour change: a cross-origin `nextLink` or a CR/LF-bearing header field is now rejected. No migration, no new gateway invariant (connector-boundary validation, guarded by co-located unit tests: `fetch-bearer-json.test.ts`, `header-safe.test.ts`, and the updated `rest-tool-kit.test.ts`). Addresses the pre-existing findings surfaced on PR #692.

### 2026-06-18

- **Share & Virality — Slice 8d (sovereign-mesh referral / forwarding):** Completes Phase 6. A paired gateway owner can now forward a received share to their own peers over the federation wire, with an immutable provenance hop-chain that preserves the origin's byte-identical `body`+`sig` across every hop. **No new invariant** — forwarding reuses **I27** (static **D21** extended); schema moves **V42 → V43**. **Schema:** V43 adds `share_inbox`, a single dual-purpose table keyed by recipient pubkey (columns: `id`, `recipient_pubkey`, `content_hash`, `direction`, `share_json`, `origin_label`, `hops`, `received_at`, `status`). A `direction='pending'` row is a sender-side forward queued for a not-yet-paired recipient; a `direction='received'` row is an inbound inert artifact. **Deferred-reveal:** when a recipient first pairs, the **sender's** `PeerPairing.onPairComplete` hook fires `drainPending` for that peer and delivers the queued forwards over the now-live wire (best-effort, fully guarded so a delivery failure never crashes pairing). The receiver-side `share.inbox` IPC is a plain read (`listReceivedShares`) of the inert `received` rows — it does not drain or mutate. **Forwarding envelope:** the inner `body`+`sig` from the origin share are carried byte-identical through every hop — the original content stays verifiable against the origin gateway's Ed25519 pubkey at any point in the chain. Each forwarder appends a hop to the top-level `forwarding.chain` array (`{ gatewayLabel, pubkey, sig }`) and increments `forwarding.hops`; `sig` is a `nacl.sign.detached` signature over `contentHash ++ the hop's own label+pubkey ++ JSON(prior-chain)` using the forwarder's own Ed25519 share-signing key (the same key `ensureShareKeypair(vault)` manages — no new Vault key). A tampered hop fails its own sig without touching content verification (`verify-share` keeps `signatureValid: true` while reporting `forwarding.chainValid: false`); the hop chain is advisory attribution, not a trust gate. **Attribution chip:** `share/attribution.ts` `formatAttributionChip` renders provenance for display: "forwarded from `<origin>`, N hop(s) away" (or "from `<origin>` (direct)" at hop 0). **IPC surfaces:** `federation.shareForward` (local-only; the owner's asker-side trigger — added to `FORBIDDEN_OVER_LAN`), `federation.shareReceive` (answerable over the LAN wire; the inbound share-arrival path — NOT forbidden; `checkLanMethodAllowed` via I5 is the gate), `share.inbox` (read; renderer-exposed read-only on the Tauri allowlist, like `share.list`/`share.get`). **CLI:** `nimbus share inbox [--all]` lists the received inbox with attribution chips; `nimbus share forward <contentHash> --to-peer <peer-id>` triggers `federation.shareForward`. **D21 extended:** static **D21** in `scripts/structure-audit/check-nimbus-invariants.ts` now also confines `forwardShare` (the second outbound emit path) — the `D21-forwardshare-callsite` rule asserts `forwardShare` is called only from `share/share-forward.ts` and `ipc/federation-rpc.ts`, and `share.publish` may now be named in `share-forward.ts` too — preventing a second unchecked emit path from opening outside the gate. **Receiving is inert:** an inbound forwarded share is sig-verified then stored in `share_inbox` as a viewable/replayable artifact only — never auto-merged into the index, never auto-executed, no embedding write, no HITL. This is a tested property (the `receiveForwardedShare — inert inbound` block in `share-forward.test.ts` + a real-NaCl-wire e2e), not a new invariant. **Count stays I1–I27.**

### 2026-06-17

- **perf (Phase 2 — Bencher):** Advisory Bencher Cloud trend ingest now runs alongside `github-action-benchmark` during a soak window — a pure `HistoryLine` → Bencher Metric Format mapper (`packages/gateway/src/perf/bencher-bmf.ts`) + a thin `scripts/perf/emit-bencher-bmf.ts` CLI, wired into `_perf.yml` (all matrix legs as Bencher testbeds) and a dormant ingest in `_perf-reference.yml`. Adds per-runner testbeds and charts the throughput/tokens trend surfaces for the first time. The in-code `gateClass` comparator remains the **sole** gate (Bencher is advisory; every step is `continue-on-error`). `github-action-benchmark` retires in a follow-up PR after the soak.
- **Share & Virality — Slice 8c (replay):** `nimbus verify-share <file|url> --replay` now re-runs a
  shared recipe's (or a transcript share's) tool calls locally and renders a divergence report
  (`match` / `diverged` / `missing-connector` / `skipped-non-read` / `error`). Replay is
  deterministic and LLM-free; read-only is enforced by a POSITIVE allowlist
  (`share/read-tool-registry.ts`) sourced from connector read-verb naming — a tool absent from the
  HITL set is classified non-read and skipped, never executed. No migration, no new invariant
  (replay reads the user's own connectors and emits nothing). Realizes the spec's
  `nimbus share verify --replay` intent via the existing `verify-share` command.
- **Share & Virality — Slice 8b (recipes):** `nimbus share <session> --as-recipe` now produces a
  deterministic, LLM-free declarative tool-call DAG (`share/recipe.ts`) reconstructed from the
  session's logged tool calls, redacted + signed through the existing I27 share-gate (no new
  invariant). Migration **V42** adds `tool_call_log.params_json` (secret-redacted) so recipe steps
  carry real params; an advisory `dependsOn` value-matcher links steps by identifier-shaped values.
  The recipe variant serializes to deterministic YAML (`.nimbus-recipe.yaml`); `verify-share` accepts
  either YAML or JSON.

### 2026-06-15

- **Phase 6 Slice 8 — Wave 8a: Share foundation (signed, redacted, owner-gated outbound share + verify-share)** ✅ — The foundation of the Share & Virality subsystem: the first deliberate *outbound* data path in Nimbus, behind new structural invariant **I27** (static **D21**). **Schema:** V41 adds `share_records`, the content-addressed share ledger (one row per emitted share — content hash, kind, redaction-set, provenance, signed body, sink). `CURRENT_SCHEMA_VERSION` → **41**. **`share/` subsystem** (`packages/gateway/src/share/`): `share-redaction.ts` composes the existing audit secret patterns with a share PII set (emails / IPs / internal hostnames / Slack handles / credit cards) plus caller-supplied patterns, recursively scrubbing keys + values and recording the applied family names; `safe-fetch.ts` is an SSRF-guarded fetch (rejects non-http(s), loopback / link-local / RFC-1918, and validates the *resolved* address — with a documented DNS-rebind residual, not "SSRF-proof"); `share-keypair.ts` owns the Vault-only `share.signing.{priv,pub}key` Ed25519 seed (mirrors `policy/anchor-keypair.ts`); `share-format.ts` is the `nimbus-share/v1` codec — canonical key-sorted body, BLAKE3 content hash, `tweetnacl` detached sign/verify, **advisory** expiry (an expired-but-genuine share stays `signatureValid`, `expired` is reported separately); `share-store.ts` is the `share_records` CRUD (insert / list / get / prune, expired-filtering); `share-gate.ts` is the **I27 chokepoint** `createShare()` (collect → redact → owner-HITL preview approval → sign → persist → audit; a denied/timed-out approval persists + signs + emits NOTHING); `share-consent-broker.ts` mirrors `PreflightConsentBroker` (fail-closed timeout); `verify-share.ts` re-uses the codec for file / url (SSRF-safe) input. **Surfaces:** `share.create` / `verify` / `list` / `get` / `pubkey` / `prune` / `approvalRespond` IPC (`ipc/share-rpc.ts`; `share.create` + `share.prune` LAN-forbidden), the `nimbus share <create|list|prune|pubkey>` + `nimbus verify-share <file|url>` CLI, the config-pinned `[share.http_sink]` (the only host the `--http` sink may target; bearer token Vault-only), and the four read-only `share.{get,list,pubkey,verify}` methods on the Tauri renderer allowlist (**90 → 94**; the mutating `share.create` / `share.prune` stay CLI-only — I7). **Invariant I27** — `createShare` is the sole path a share takes to leave the machine: default + caller redaction, the local owner approves the exact redacted bytes via the `share.publish` HITL action (I2 frozen set), the body is signed with the Vault-only key, and the applied redaction-set is audit-logged. **Static D21** confines the `share.publish` action-type literal to executor + share-gate, the `share.signing.privkey` Vault key to share-keypair.ts, and the `createShare` call site to share-gate.ts + share-rpc.ts (plus an assemble.ts `shareConsent.request` wiring assertion); the runtime I27 block in `security-invariants.test.ts` proves `share.publish ∈ HITL_REQUIRED` and the LAN-forbid of `share.create` / `share.prune`. Recipe sharing, replay, and peer-forwarding population are out of 8a scope (Waves 8b–8d); the `forwarding` field ships inert.

### 2026-06-14

- **Phase 6 Slice 7 — Wave 7c: HITL-gated WRITE actions for the warehouse/BI connectors** ✅ — The six Wave-7a connectors gain **twelve write tools** (two each), each executing only behind the local owner's **I2** HITL consent gate: Snowflake `tag.set` / `comment.set` (governance annotation, SQL-injection-guarded), Tableau `datasource.refresh` / `workbook.refresh`, Looker `datagroup.trigger` / `schedule.run_once`, Power BI `dataset.refresh` / `dataflow.refresh` (the `groupId` GUID is now indexed in `data_model`/dashboard metadata so the agent can target a workspace; `groupId` optional for My Workspace), Monte Carlo `incident.acknowledge` / `incident.resolve`, Bigeye `issue.acknowledge` / `issue.resolve`. **New invariant I26 (static D20):** warehouse/BI write tool ids are confined to the local executor I2 path — the federated peer invoke gate (`answerFederatedInvoke`) **fail-closed rejects** any write-classified tool id via an injected `isWriteForbiddenToolId` predicate (`isWarehouseWriteToolId`), so a peer can never trigger a warehouse write (count **I25 → I26**; schema stays **V40**, no migration; no new credentials). The twelve `action.type`s are added to the frozen `HITL_REQUIRED_BACKING` set (I2). **Transport:** writes reuse the Wave 7b spawn transport — a new `connectors/warehouse-write-transport.ts` (`invokeConnectorWrite`) routes **personal** (service-scoped Vault view → one-shot `withConnectorSession` call) vs **team** (a new `answerLocalOperatorInvoke`, the I19 local-operator single-tool sibling of `answerLocalOperatorList`), credential selected config-driven from `[connectors.<name>]` (never the payload). A `connectors/warehouse-write-dispatch.ts` decorator wraps the engine dispatcher (`index.ts`) so warehouse-write `action.type`s route to the transport while everything else passes through; `connectors/warehouse-write-tools.ts` is the single source of truth (`action.type ↔ toolId ↔ service`) consumed by the HITL drift test, the dispatch decorator, and D20. Refresh writes return `{ status: "queued", jobId }` (async); errors surface the provider status through the I11 envelope. **Folded-in Wave 7b deferrals:** team-vault audit rows now carry an optional resolved `identitySubject` (JSON field, no migration; omitted when identity is disabled so the tamper-evident trail never implies a verified identity); a cursor-shape contract test (`warehouse-cursor-contract.test.ts`) pins the paged-list envelope. **Known limitation:** the Monte Carlo `setIncidentFeedback` mutation and the Bigeye issue-status enum are implemented against the vendors' *documented* shapes and tested at the HTTP boundary — not verified against live APIs (manual live-verification checklist in the Wave 7c spec §7).
- **Mendeley connector** (read-only) — indexes the user's Mendeley library document metadata as `mendeley:reference` items (Phase 6 Slice 9). Elsevier OAuth2 auth (user-supplied client credentials); document metadata only — no PDF content is fetched.
- **Phase 6 Slice 7 — Wave 7b: team-shared credentials for the warehouse/BI connectors** ✅ — The six Wave-7a connectors (Snowflake, Tableau, Looker, Power BI, Monte Carlo, Bigeye) can now optionally source their credential from **Team Vault** through the existing **I19** secret chokepoint. **No new invariant** (count stays at **I25**) and **no migration** (schema stays **V40**). **Config:** a new `[connectors.<name>]` family (`config/nimbus-toml-connectors.ts`) selects `credential = "personal"` (default) or `"team"` + a `team_entry` per connector; fail-closed validation (unknown connector, bad credential value, missing/malformed `team_entry`). **Unified spawn transport:** both personal and team sync now spawn the connector once per cycle and drain a paginated `<svc>_list` tool rather than calling `connectorFetch` gateway-side — `connectors/warehouse-sync-transport.ts` (`listConnectorItems`) branches on the per-connector credential: **personal** uses a service-scoped read-only Vault view (`connectors/service-scoped-vault-view.ts`) so exactly one server starts; **team** routes through the now **principal-polymorphic** `answerFederatedInvoke` (peer | **localOperator**) into `teamvault/team-tool-invoke.ts` `invokeTeamToolList`, which drains the list over a single `teamvault/connector-session.ts` (`withConnectorSession`, spawn-once / N-calls) ephemeral session. The team secret never enters the gateway heap, the `SyncResult`, logs, or any indexed row (faithful I19); fail-closed on a missing team secret. **Pagination:** every `<svc>_list` gained a real `{ cursor, limit } → { items, nextCursor }` contract — Tableau (1-based page number), Looker/Bigeye (`limit`/`offset`), Monte Carlo (relay `first`/`after` + `pageInfo`), Snowflake (statement cursor), Power BI (single-fetch, `nextCursor: null`). **Same-credential lineage (no personal-credential dependency for team syncs):** Looker's LookML-model fetch runs as a second drained tool (`looker_models_list`) inside the same credentialed session, and Power BI folds its per-report dataset-table fetch into the `powerbi_list` payload — so a team-credentialed sync still produces full `derived_from` / `upstream_refs` lineage. The connector `server.ts` files were refactored to export a `register<Svc>Tools(reg)` function with the stdio entrypoint guarded by `import.meta.main` (so the pagination contract is unit-testable without spawning). The I19 `security-invariants.test.ts` block was extended to cover the localOperator path. **Known limitation:** the six vendor cursor/pagination contracts are implemented against each vendor's *documented* model and tested by faking that shape at the HTTP boundary; they were **not** verified against live APIs in development — the first live-API run may need a cursor-shape correction (tracked follow-up). The cross-gateway audit-identity-subject refinement (review §4) is also deferred.
- **True Coverage program — COMPLETE (Sub-project D3, program close)** ✅ — The multi-sub-project True Coverage initiative (branch + mutation coverage on top of the line floor) is finished: **A** (branch-coverage foundation — Istanbul-under-Bun instrumentation, dual line+branch ratchet), **B** (per-subsystem branch-gap closeout — `coverage-baseline.json` `files` driven to `{}`), **★ Flagship** (`executor.ts` + `tool-output-envelope.ts` pinned at 100% line+branch via the `targets` overlay), **C** (depth — fast-check property suites + a StrykerJS mutation harness; surfaced + fixed a credential-redaction regex escape and a UTF-16 constant-time-compare bug), and **D** (exclusion shrink). D3 closes it out: relocated 4 pure test-helpers under `testing/` dirs so their coverage exemption is self-enforcing (`discoverSourceFiles` auto-skips `/testing/`); deleted the redundant `sandbox-probe.ts` exclusion; corrected the `chatops-tool-runner-e2e-sink.ts` comment (it is production-imported by `assemble.ts`, not test-only); grouped the 11 type-only / zero-`SF:` exclusions under one block with per-file guardian headers; extracted a DI-seamed `EmbeddingWorkerCore` (unit-tested — init/backfill/`embed_texts`/the serialized `embed_item` queue — leaving `embedding-worker.ts` a thin, still-excluded wiring shell, zero behavior change); resolved the deferred §5.3 Bun-Worker-realm instrumentation probe (a worker-side Istanbul `__coverage__` flush is mechanically feasible but not worth threading through the production worker spawn sites — documented, exclusion retained); and ran a full per-category documentation pass over `scripts/coverage-floor/exclusions.ts`. Every non-flagship source file under `packages/{gateway,cli,sdk,client}` now clears the ≥80% line+branch floor or carries a category-justified exclusion; the baseline `files` map stays `{}` and the flagship `targets` hold at 100/100. No schema change, no new invariant.

### 2026-06-13

- **Phase 6 Slice 7 — Data-warehouse/BI connectors (Snowflake, Tableau, Looker, Power BI, Monte Carlo, Bigeye)** ✅ — Six read-only connectors for the data-warehouse/BI surface, plus a cross-connector lineage graph foundation. **Schema:** V40 seeds the three new relation types (`derived_from`, `upstream_refs`, `monitors`) into `graph_relation_type`. `CURRENT_SCHEMA_VERSION` → **40**.
  - **Tier-1 connector — Snowflake** ✅ — database table schema (`snowflake:data_model`) via the Snowflake SQL API (`POST /api/v2/statements`, Bearer PAT auth); walks `INFORMATION_SCHEMA.TABLES` and `INFORMATION_SCHEMA.COLUMNS` per configured database. `snowflake.account`, `snowflake.user`, `snowflake.pat`, and `snowflake.database` required vault keys. Surfaces `database.schema.table` identifier, column names + tags, and row-count estimate. The normalized `database.schema.table` key (`dataModelKey`) is the cross-connector graph anchor: the populator upserts a `data_model` graph entity keyed by this normalized value so downstream BI tools can reference the same node. `snowflake_query` MCP tool (SELECT-only; non-SELECT blocked). `hitlRequired: []` (read-only v1; `snowflake.table.drop` / `snowflake.query.write` HITL deferred).
  - **Tier-1 connector — Tableau** ✅ — published views/dashboards (`tableau:dashboard`) via the Tableau REST API (`GET /api/3.22/sites/{siteId}/views?pageSize=100`, Personal Access Token auth — `X-Tableau-Auth` session token from PAT sign-in); self-hosted or Tableau Cloud host via `tableau.server_url`. Surfaces view name, author, folder, extract-refresh status, and the upstream data-source tables (`dataSourceTables`) that feed it. The `dataSourceTables` array normalizes to `upstreamDataModelKeys` metadata, which the graph populator converts to `data_model --upstream_refs--> dashboard` edges — connecting Tableau dashboards to their Snowflake/dbt source tables. `tableau_list` / `tableau_get` MCP tools. `hitlRequired: []`.
  - **Tier-1 connector — Looker** ✅ — dashboards (`looker:dashboard`) and LookML views (`looker:data_model`) via the Looker REST API (OAuth client-credential auth — `/api/4.0/login`); self-hosted host via `looker.url`. Dashboards surface name and folder. LookML views surface the `sql_table_name` field, normalized to a `dataModelKey`, with a `derived_from` graph edge pointing to the underlying table key — the Looker→dbt lineage seam (a dbt model sharing the same normalized table key participates in the same graph node). `looker_list` / `looker_get` MCP tools. `hitlRequired: []`.
  - **Tier-1 connector — Power BI** ✅ — reports and dashboards (`powerbi:dashboard`) via the Power BI REST API (`GET /v1.0/myorg/reports` + `/dashboards`, Bearer token — Azure AD client-credentials OAuth); `powerbi.tenant_id`, `powerbi.client_id`, `powerbi.client_secret` required vault keys; fixed SaaS host `api.powerbi.com`. Surfaces report/dashboard name, web URL, and the dataset id each report binds to. The dataset id is stored in `upstreamDataModelKeys` after normalization, emitting `data_model --upstream_refs--> dashboard` lineage edges toward the Snowflake/dbt dataset tables. `powerbi_list` / `powerbi_get` MCP tools. `hitlRequired: []`.
  - **Tier-1 connector — Monte Carlo** ✅ — data-quality incidents (`montecarlo:data_quality_test`) via the Monte Carlo GraphQL API (POST `https://api.getmontecarlo.com/graphql`, API-key auth — `x-mcd-id` + `x-mcd-token` headers); `montecarlo.key_id` + `montecarlo.key_secret` required vault keys; fixed SaaS host `api.getmontecarlo.com`. Surfaces incident id, status (`open`/`resolved`), severity, monitored table reference, and first-seen timestamp. The `monitoredTable` field is normalized to a `dataModelKey` stored in `monitoredDataModelKeys` metadata; the graph populator emits a `data_quality_test --monitors--> data_model` edge, linking Monte Carlo incidents back to the Snowflake table they cover. `montecarlo_list` / `montecarlo_get` MCP tools. `hitlRequired: []`.
  - **Tier-1 connector — Bigeye** ✅ — data-quality metric runs (`bigeye:data_quality_test`) via the Bigeye REST API (`GET /api/v1/metrics/results`, Bearer PAT auth); `bigeye.token` required + optional `bigeye.url` (defaults to `https://app.bigeye.com`). Surfaces metric name, table + column reference, status (`healthy`/`unhealthy`), and metric-run timestamp. The monitored table is normalized to a `dataModelKey` stored in `monitoredDataModelKeys`, emitting the same `data_quality_test --monitors--> data_model` graph edge as Monte Carlo — both DQ tools converge on the same Snowflake `data_model` node. `bigeye_list` / `bigeye_get` MCP tools. `hitlRequired: []`.
  - **Cross-connector lineage graph** ✅ — `packages/gateway/src/graph/graph-populator.ts` gains three new item-type handlers (`syncDataModelGraph`, `syncDashboardGraph`, `syncDataQualityTestGraph`) wired by the Slice-7 graph foundation (`graph-lineage-types-v40-sql.ts`). Any connector emitting `data_model` items with `dataModelKey` + `derivedFromKeys` metadata, `dashboard` items with `upstreamDataModelKeys`, or `data_quality_test` items with `monitoredDataModelKeys` participates automatically — dbt, Airflow, and future connectors will extend the same chain without graph-populator changes. The integration acceptance test (`packages/gateway/test/integration/slice7-lineage.test.ts`) proves the Snowflake→Tableau `upstream_refs` + Monte Carlo `monitors` sub-chain resolves in <500 ms with zero live API calls.

### 2026-06-12

- **Phase 6 Slice 6c — Tribal-knowledge extraction (repeated-question detection → owner-approved KB capture)** ✅ — A live Slack/Teams watcher that detects repeated questions in an allowlisted set of channels and, on the local owner's HITL approval, captures a synthesized Q&A into a config-pinned shared knowledge base (Notion/Confluence) — behind new structural invariant **I25** (static **D19**). **Schema:** V39 adds `tribal_clusters`, the asker-side cluster ledger (one row per detected repeated-question cluster; survives restarts, dedups suggestions, tracks capture/dismiss + cooldown). `CURRENT_SCHEMA_VERSION` → **39**. **`tribal/` subsystem** (`packages/gateway/src/tribal/`): a cheap dependency-free question classifier (`is-question.ts`), the `tribal_clusters` store with status + cooldown semantics (`cluster-store.ts`), a repeat detector (`repeat-detector.ts` — embed → recall the nearest existing cluster over the ledger's stored representative vectors → watch-channel allowlist filter → near-dup merge), the I23 suggestion post (`tribal-suggestion.ts`), the pipeline orchestrator (`tribal-watcher.ts`, swallows its own errors — never breaks the chat path), the draft synthesizer (`answer-synthesizer.ts`, allowlist-filtered citations + simple-markdown constraint), the **I25** write-gate (`tribal-write-gate.ts`), and the boot assembler (`tribal-boot.ts`, **fail-closed if `[tribal].enabled` with an empty `watch_channels` allowlist**). **Detection taps the Slice 5 ChatOps inbound stream:** `ChatMessage` gains `addressedToBot`; the Slack normalizer now accepts plain `message` events (ambient, tribal-only) alongside `app_mention` (commands), skipping `bot_id`/`subtype` (feedback-loop guard); `chatops-boot.ts` fans every inbound message out to the watcher first and routes to the IntentRouter only for addressed messages. **Capture is lazy** — a draft + citations are synthesized only when triggered (CLI `nimbus tribal capture <id> [--target notion|confluence]` or an in-chat `@nimbus tribal capture <id>`), routed through the **local owner's executor HITL gate**, then written via the new HITL-gated `notion_kb_append` / `confluence_kb_append` connector tools whose destination (`[tribal.notion].database_id` / `[tribal.confluence].space_key` + `parent_page_id`) is resolved **from local config only** — the caller supplies at most a `--target` selector, never the destination (I25). New HITL action types `notion.knowledge.write` / `confluence.knowledge.write`. **Surfaces:** `tribal.status` / `start` / `stop` / `list` / `dismiss` / `scan` / `capture` IPC (LAN-forbidden), the `nimbus tribal` CLI, and the read-only `tribal.status` / `tribal.list` on the Tauri renderer allowlist (**88 → 90**; the control-plane/mutating methods stay CLI-only — I7). **Invariant I25** — the write-gate is the sole path from a capture to a KB write (config-only destination, owner HITL, leak-proof result); static **D19** confines the `notion_kb_append` / `confluence_kb_append` tool ids to the write-gate + the two connector definition sites; the runtime I25 block in `security-invariants.test.ts` proves config-destination-only, fail-closed-on-unconfigured, and rejected-HITL-leaves-uncaptured. **Real-subprocess e2e** (`test/e2e/tribal-e2e.test.ts`): the IPC surface, the I25 `not_configured` fail-closed, and the empty-`watch_channels` boot abort. **Deployment note:** seeing non-mention Slack messages requires the deployed Slack app manifest to subscribe to the `message.channels` bot event (a deployment step, not code); without it the watcher only sees mentions (degraded, not broken). Synthesis ships as a deterministic v1 draft the owner reviews + edits at the HITL gate (the injected-LLM seam keeps an LLM-authored draft a one-line swap).

### 2026-06-11

- **Phase 6 Slice 6b — Federated action requests (cross-team cloud janitor + blast-radius preflight)** ✅ — The two action-oriented cross-colleague features, behind new structural invariant **I24** (static **D18**). No new migration (schema stays **V38**). **Cloud janitor** — `agents.janitor` (`nimbus janitor <resource-ref> [--idle-days N] [--cleanup <action.type>] [--allow-gaps] [--json]`): a read-only agent that fans a **content-free recency probe** (`federation.probe` → `probeResourceRecency`, mirroring the leak-proof `federation.expertise` shape — no grant gate, returns only `{ touched, lastSeenDaysAgo? }`) across all paired peers via the new `fanOutProbe`. When every *answering* peer reports the resource idle ≥ N days it emits a brief recommending the cleanup action; a peer that doesn't answer is **never** counted as idle (gaps suppress the proposal unless `--allow-gaps`). `resourceRef` is validated (min length, charset) to kill false hits. **Blast-radius preflight** — `agents.preflight` (`nimbus preflight <ref> --namespace <ns> [--strict] [--json]`, plus `nimbus preflight approve <id>`): the upstream owner fans `federation.preflight` to downstream owners via `fanOutPreflight` and aggregates pass/fail; a non-answering downstream is never rendered "safe to merge". **I24** — the downstream `federation/preflight-gate.ts` `answerFederatedPreflight` is the SOLE path from an inbound request to a sandbox spawn: identity (I18) → request validation (git-ref + bounded changed-surface allowlists, *before* HITL) → peer grant → resolve the command from **local `[federation.preflight."<ns>"]` config only** (fail-closed `not_configured`) → the downstream owner's **local HITL approval** (`PreflightConsentBroker`) → run the configured command in the per-OS sandbox (`preflight-runner.ts` over `createSandboxRunner`, I15) with validated params as env vars only + a hard timeout (default 300 s, cap 1800) → leak-proof `{ passed, summary }`. The caller never supplies or selects the command. Static **D18** confines `runPreflightCommand` to `preflight-gate.ts`/`preflight-runner.ts`; the runtime I24 block in `security-invariants.test.ts` proves gate-before-spawn, caller-command-ignored, and fail-closed-on-missing-config. Wired over the wire through `federation-server.ts` + `dispatchers.ts` + `platform/assemble.ts` (`preflightConsent.setBroadcast` + `appendPreflightAudit`). **Tauri:** the two read-only brief methods (`agents.janitor` / `agents.preflight`) are renderer-exposed (**86 → 88**; I7); `federation.preflightRespond` (the approval action) stays CLI-only. `CURRENT_SCHEMA_VERSION` stays **38**.
- **Phase 6 Slice 6a — Cross-colleague read-only agents (ghost reviewers, conflict detection, huddle briefing)** ✅ — Three on-demand, read-only built-in agents that surface cross-colleague context by fanning the shipped federated-query primitives across paired peers. No new structural invariant — the answering side stays fully gated by the existing **I17** query gate. **New schema:** V38 adds `federation_known_namespaces`, an asker-side cache of remote namespaces a successful federated query touched; lets the agents default to an ambient sweep when `--namespace` is omitted; rows are pruned on `no_grant` / unpair. `CURRENT_SCHEMA_VERSION` → **38**. **`agents.ghost`** (`nimbus ghost <file> [--namespace <n>] [--json]`) — ranks teammates by file expertise, fans out `federation.expertise` + `federation.query` across paired peers via `federation/peer-fanout.ts`, and surfaces matching PRs/issues/commits; suggests who to contact (strictly read-only — no message sent). **`agents.conflicts`** (`nimbus conflicts <file> [--namespace <n>] [--json]`) — warns of WIP collisions (open PR, assigned ticket, recent commit, open branch) before you edit, by querying peers for recent activity touching the same file. **`agents.huddle`** (`nimbus huddle [--since <ms>] [--namespace <n>] [--json]`) — team-scoped morning briefing aggregating each teammate's recent PRs, tickets, and incidents across the mesh without manual reporting. All three follow the standard built-in-agent contract: parallel sub-agent decomposition via `AgentCoordinator`, emit `<agentName>.briefReady { sessionId, brief, findings }`, and are E2E-tested (`ghost.e2e.test.ts` / `conflicts.e2e.test.ts` / `huddle.e2e.test.ts`). **Tauri:** the three read-only brief methods are renderer-exposed (**83 → 86**; I7). **`peer-fanout.ts`** (`federation/peer-fanout.ts`) is the shared fan-out helper that iterates `PeerRegistry`, calls `federation.query`/`federation.expertise` per peer (with per-peer timeout + error isolation), and merges results; consumed only by the three new agents.

### 2026-06-10

- **Phase 6 Slice 5 — ChatOps gateway-boot wiring** ✅ — Closes the one deferred loose end of the ChatOps slice: the `chatops/` component graph is now assembled at gateway boot and reachable in a running gateway (previously built + tested in-process but never wired). `platform/assemble.ts` builds the `ChatopsService` graph gated on `[chatops].enabled` — identity mapper (`lookupEmail` via the connector `slack_user_info`/`teams_user_info` bot tools; `findScimByEmail` from the `IdentityStore`; `isOperatorValid` from `identity/verifier.ts`, I18), policy resolvers from `policyGate.enforced().chatops` (I22), reply dispatcher `post()` → the connector `*_chat_post` tools (I23), approval presenter + intent router whose `runGatedWrite` sets the `runWithChatopsApprovalContext` ALS context then calls a ChatOps-configured `ToolExecutor.gate` (I2/I4) with `delegation.requestRemote = approvalPresenter.requestApproval` (reusing I20), and the Slack Socket Mode + Teams webhook transports. **Connector-tool invocation** reuses the Slice-2 ephemeral team-credentialed spawn pattern: `chatops/chatops-tool-runner.ts` resolves a read-only Team-Vault view for `[chatops].bot_vault_entry` (fail-closed on any missing bot secret — the secret never enters gateway scope) and `connectors/lazy-mesh/chatops-bot-spawn.ts` injects the bot tokens as env (`SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`, `TEAMS_BOT_APP_ID`/`TEAMS_BOT_APP_PASSWORD` + per-activity `TEAMS_BOT_SERVICE_URL`) into a sandbox-wrapped (I15) connector spawn. `ipcOpts.chatopsRpcCtx` (status/start/stop/test) + `httpSidecarOpts.resolveTeamsEventsSurface` (Bot Framework JWT validated via the I18 JWKS-cache + RS256 verifier, `aud === [chatops].teams_bot_app_id`, fail-closed — `identity/teams-bot-jwt.ts`) are populated; the engine read path + local-owner consent fallback (via the delegated-approval broker) are late-bound after boot. **Real-subprocess e2e** (`packages/gateway/test/e2e/chatops-e2e.test.ts`): boots a real gateway with chatops enabled + a signed policy + seeded SCIM users + a mock Slack transport, asserting read reply, owner-routed write approve → connector dispatch + `hitlStatus=approved` audit, reject → no dispatch + rejected audit, unmapped refusal, and I23 bounding. **Sandbox correctness fixes uncovered en route** (the prod chatops bot spawns connectors through the sandbox): the Linux seccomp allow-list gained the modern-glibc/Bun runtime syscalls a wrapped connector needs (`rseq`, `newfstatat`, `epoll_pwait2`, `rt_sigsuspend`, `tgkill`, `preadv2`, `eventfd2`, `timerfd_*`, `close_range`, `prctl`, `sysinfo`, `sigaltstack`, `sched_setscheduler`, `membarrier`) — the KILL default was SIGSYS-killing connectors on current distros; and `sandbox/linux.ts` now logs to stderr (a stdout write from inside the MCP-stdio wrapper corrupts the JSON-RPC stream).

### 2026-06-09

- **Phase 6 Slice 5 — ChatOps (Slack/Teams bot, HITL-via-chat)** ✅ — A bidirectional `@nimbus` bot that answers read queries from the shared index and routes write commands through the executor's HITL gate (owner-routed), never bypassing consent — gated by new structural invariant **I23** (static **D17**). **No new migration:** channel↔namespace bindings + resource→owner ownership live in the Slice 4 signed org policy (`[policy.chatops.channel."<id>"]` + `[policy.chatops.ownership]`, parsed in `policy/chatops-policy.ts`, carried through `EnforcedPolicy`); the identity-email cache is in-memory; the Teams JWT path reuses `oidc_jwks_cache`. **`chatops/` subsystem** (`packages/gateway/src/chatops/`): `identity-mapper.ts` (platform-userId → email (TTL-cached) → SCIM identity, with a **live, local** SCIM-active + I18 operator-validity re-check on every message — a deprovision takes effect on the next message with no stale-auth window), `command-parser.ts` (normalize → NL-read vs structured-`run` split → write grammar; unknown actions refused, never guessed), owner-routing via `chatops-request-context.ts` (AsyncLocalStorage) + `approval-presenter.ts` (owner-routed Approve/Reject card resolving the real **I20** `resolveDelegatedApproval` with the clicker identity), `intent-router.ts` (read→engine, write→owner-gated executor, refusal audit), and the **I23** `reply-dispatcher.ts` — the SOLE operational (non-HITL) post path, whose destination is ONLY a server-derived `ReplyTarget` (the originating channel or a policy `notify` channel), never caller-supplied; arbitrary-destination posting remains only via the HITL-gated `*.message.post` action types. **Transports:** Slack Socket Mode (adapter-owned WS; the connector `slack_socket_open` tool returns the short-lived `wss://` URL; envelope-ack + reconnect/backoff + a bounded FIFO dedupe set capped at 1000) + Teams webhook on the **I13** HTTP write surface (`POST /v1/messaging/teams/events`; `WRITE_ROUTE_ALLOWLIST` 5 → 6; auth is a Bot Framework JWT validated in-route via the identity JWKS-cache + RS256 verifier, fail-closed — not a static bearer). **Connectors:** `slack`/`teams` gain operational `*_chat_post` + `*_user_info` tools (+ `slack_socket_open`; Teams send-activity via a new `bot-send.ts`) using bot/app credentials — new Team-Vault keys `slack.bot_token` / `slack.app_token` + `teams.bot_app_id` / `teams.bot_app_password`; static **D17** confines `*_chat_post` references to `reply-dispatcher.ts` / `transport/` + the connector definition sites. **Surfaces:** `chatops.status` / `chatops.start` / `chatops.stop` / `chatops.test` IPC (forbidden over the LAN wire), `nimbus chatops [status|start|stop|test]` CLI, and the read-only `chatops.status` on the Tauri renderer allowlist (**82 → 83**; `start`/`stop`/`test` stay off the renderer surface — I7). Watcher alerts route to a namespace's notify channels via `makeChatopsWatcherNotify`. **Invariant I23** — enforced by a runtime test (`security-invariants.test.ts`) + a static **D17** rule; the triple rule (wiring + docs + test) lands together. The components are unit- + in-process-integration-tested (read / owner-routed approve+reject / unmapped-refusal / I23 bounding). *Gateway-boot wiring delivered 2026-06-10 (see below).*

### 2026-06-07

- **Phase 6 Slice 4 — Org Policy + Admin Console + Observability + Team Audit + GDPR Purge** ✅ — Org-wide governance on the Slice 1 federation substrate, gated by new structural invariant **I22** (signature-verified org policy + monotonic-stricter resolution). **Schema:** V36 adds `org_policy_state` (the last-valid signed `nimbus.policy.toml`) + `policy_anchor_pin` (the pinned publisher pubkey); V37 adds the GDPR-purge ledger `gdpr_purge_job` + `gdpr_purge_request` (orchestration jobs + per-subject delete requests with their signed deletion records). `CURRENT_SCHEMA_VERSION` → **37**. **Policy** (`packages/gateway/src/policy/`): the `nimbus.policy.toml` schema+parser, Ed25519 sign/verify over canonical bytes, a `PolicyStore`, and the **I22 `PolicyGate`** — it resolves a monotonic-stricter `EnforcedPolicy` (tighten-only; fail-closed to the last-valid/baseline) from the profile×policy resolver, and enforcement reads only `EnforcedPolicy`, never the raw policy TOML. Enforcement covers a connector allowlist, a retention floor, and a quorum/HITL resolver. **Distribution:** `federation.policy` serve + peer refresh + publisher pubkey pinning + the `nimbus policy trust` command, plus an audit-log shipper (`federation.auditExport`). **GDPR purge:** orchestration over the V37 ledger, a HITL-gated `federation.purge` serve that emits signed deletion records, with sync-cycle retry. **Observability** (`packages/gateway/src/status/`): a `GatewayStatus` snapshot + Prometheus exposition. **Admin console** (`packages/admin-console`): a dependency-free static console served at `/admin/*`. **IPC:** `policy.show` / `policy.sign` / `policy.trust` / `policy.refetch`, `team.purge`, `team.auditMerged`, `admin.status`; federation wire `federation.policy` / `federation.auditExport` / `federation.purge`. **HTTP:** `GET /v1/admin/status`, `GET /metrics`, `GET /admin/*` (all bearer-gated reads) + `PUT /v1/admin/policy` (the signed-policy install on the **I13** write surface — `WRITE_ROUTE_ALLOWLIST` 4 → 5). **Tauri (I7):** the read-only `admin.status` / `policy.show` / `team.auditMerged` are renderer-exposed; the privileged `policy.sign` / `policy.trust` / `policy.refetch` + `team.purge` stay CLI-only. **Invariant I22** — enforced by a runtime test + a static **D16** rule (the `parsePolicyToml`-confinement check in `scripts/structure-audit/check-nimbus-invariants.ts`); the triple rule (wiring + docs + test) lands together.
- **Phase 6 Slice 2 — Team Vault + Multi-user/Quorum HITL** ✅ — Team-scoped credentials and approvals on the Slice 1 federation substrate, gated by three new structural invariants **I19/I20/I21**. **Schema:** V35 migration adds `team_vault_entries` / `team_vault_grants` (live-checked per-`(entry,peer,tool)` RBAC) + `hitl_delegations` — secret *bytes* never live in these tables (metadata + RBAC only; the bytes live in the OS Vault under the `teamvault.<entry>.<connectorKey>` keyspace). **Team Vault** (`packages/gateway/src/teamvault/`): a `TeamVaultStore`, the **D15 keyspace home** `team-vault-keys.ts` (the ONLY composer of the `teamvault.` prefix), a tamper-evident `team-vault-audit.ts` (folds into the BLAKE3 chain), and the **I19** consumption path — `federation/invoke-gate.ts` `answerFederatedInvoke` (identity → live RBAC → quorum → run), which returns only `{ ok, result }`; the secret is read by a **read-only vault overlay** (`team-vault-view.ts`, never falls through to the operator's own key) and injected into an **ephemeral team-credentialed connector** spawned by reusing the existing first-party spawners (`team-tool-spawn.ts` — inherits `extensionProcessEnv` I1 + `wrapServerSpec` I15), then drained. **Fail-closed:** a missing team secret, an OAuth-only/unknown service, or a missing grant aborts before any spawn — never falling through to the operator's local credential. **Quorum (I21):** a session-only `QuorumCoordinator` counts only DISTINCT authenticated peers (deny aborts, window timeout) behind a `[hitl.quorum."<action-type>"]` config table. **Delegated HITL (I20):** a scoped, time-boxed `DelegationStore` + `resolveDelegatedApproval` wired into the executor gate — an owner's HITL approval routes to a live, in-scope, identity-valid delegate (else falls back to the local owner prompt; the wire is never trusted). **IPC:** three over-the-wire methods `federation.invoke` / `federation.quorumRespond` / `federation.approvalRespond` (answerable; `peerId` forced from the NaCl-authenticated session, I17/R1) + asker-side `federation.askInvoke`; local management dispatchers `teamvault.*` (`put`/`delete` HITL-gated, I2) and `hitl.*`. Over the LAN channel only the three answerable methods are admitted; `teamvault.*` / `hitl.*` management is local-only (I5). **Config:** `[hitl.quorum]` typed loader. **Surfaces:** `nimbus team vault put|grant|revoke|list`, `team invoke`, `team delegate|delegations|approve|deny`; 5 renderer-safe methods added to the Tauri allowlist (74 → 79) — the secret/RCE-class methods (`teamvault.put`/`delete`/`grant`/`revoke`, `hitl.delegate`, `federation.invoke`/`askInvoke`) stay renderer-FORBIDDEN (I7). **Invariants** — **I19** (leak-proof fail-closed team-secret injection; static **D15**), **I20** (delegate authority), **I21** (distinct-peer quorum), each with a runtime test; the triple rule (wiring + docs + test) lands together. **Integration acceptance:** a two-gateway invoke test (pair → grant → ok+leak-proof → RBAC → impersonation → revoke → no_grant → audit) and a quorum test (single approval stays locked; two distinct unlock). **Boot:** the anchor `teamVault` backing (quorum lookup + the credential-injecting `runTool`) is constructed in `assemble.ts` and wired into both the over-the-wire and local federation contexts, gated on `[federation].enabled`.

### 2026-06-05

- **Phase 6 Slice 3 — Identity & Access (SSO/OIDC + SCIM)** ✅ — Enterprise identity on the Slice 1 federation substrate, gated by new structural invariant **I18**. **Schema:** V34 migration adds `identity_session` / `scim_user` / `identity_binding` / `oidc_jwks_cache` (no secret values in any column — tokens live only in the Vault). **Modules** (`packages/gateway/src/identity/`): OIDC discovery + device-code flow (`oidc-discovery.ts` / `oidc-device-flow.ts`), a TTL'd fail-closed `JwksCache`, the **I18 canonical `IdTokenVerifier`** (`verifier.ts` — the ONLY ID-token validation path: RS256 via Bun WebCrypto, `iss`/`aud`/`exp`/`nbf` checks, no new npm dependency) plus the pure synchronous `isOperatorValid()` the federation gate consults, an `IdentityStore` (the four V34 tables via `dbRun` — I14), an `identity-vault.ts` (the sole constructor of the `identity.oidc.*` / `identity.scim.bearer` Vault keys), a trust-anchor SCIM 2.0 Users endpoint on the HTTP write surface (`scim-http-routes.ts` / `scim-service.ts` — every write flows through the I13 `dispatchWriteRoute` pipeline: `identity.scim.bearer` auth + per-token rate-limit + `scim.provision_rejected` audit-on-rejection, with the 3 `/scim/v2/Users` routes in `WRITE_ROUTE_ALLOWLIST`; GET roster reads use the bearer-checked `dispatchScimRead` read path), and a SCIM **deprovision → federation-grant auto-revoke** tie-in. **Federation tie-in:** `answerFederatedQuery` now consults `isOperatorValid()` before answering when identity is enabled, so a deprovisioned/expired operator session fails federation closed (raw `ask`/`search` are never affected — identity gates federation only). **IPC:** an `identity.*` / `scim.*` JSON-RPC dispatcher, forbidden over the LAN wire. **Config:** `[identity]` (OIDC device-code, disabled by default) + `[scim]` sections. **Surfaces:** `nimbus identity` (login / status / logout / bindings) + `nimbus scim` (status / list-users / set-token / deprovision) CLI; the 6 read/login methods (`identity.login`/`status`/`logout`/`listBindings`, `scim.status`/`listUsers`) added to the Tauri renderer allowlist (68 → 74; `identity.login` marked long-running) — the credential-mutating methods (`identity.bind`/`unbind`, `scim.setToken`/`deprovision`) stay CLI-only (I7). **Invariant I18** — ID-token validation is intrinsic to `verifier.ts`; raw tokens are Vault-only; enforced by a runtime test + a static **D14** rule (`identity.oidc.*` / `identity.scim.bearer` string literals may appear only under `identity/`). **SAML deferred.**
- **Phase 6 Slice 1 — Federation Core** ✅ — The federation substrate for Nimbus-to-Nimbus collaboration. **Schema:** V33 migration adds `federation_namespaces` / `federation_namespace_filters` / `federation_grants` + a nullable `audit_log.federation_json` column, folded into the BLAKE3 audit chain only when present (legacy rows hash identically — backward-compatible). **Modules** (`packages/gateway/src/federation/`): a `NamespaceStore` (publish a named, filtered index slice + per-peer `owner`/`editor`/`viewer` RBAC grants, live-checked revocation), a process-lifetime `SessionConsentCache`, a `DiscoveryProvider` (mDNS via `bonjour-service` + a broadcast-free `InMemoryDiscoveryProvider` for tests + a manual-entry fallback), mutual-approval `PeerPairing` (federation peers are read-only — `write_allowed = 0`), content-free expertise ranking (`scoreExpertise` returns ONLY a coarse `high|medium|low|none` rank — never item content; LIKE-wildcard-escaped against probing), and the **I17 query gate** — `answerFederatedQuery`, the ONLY path that answers an inbound `federation.query`: it resolves the peer's grant + role, applies consent (standing grant, session-cached decision, or a timed owner prompt), compiles ONLY the namespace's declared service/type filters into a scoped index read, returns ONLY the leak-proof `FederatedItem` shape (`id`/`service`/`type`/`title`/`snippet`/`modifiedAt` — never `metadata`/`author_id`/`external_id`), and audits every outcome into the chain. An undeclared-type request and a zero-filter namespace both return empty (never a full-index dump). **IPC:** a `federation.*` JSON-RPC dispatcher (8 methods) wired into the dispatch chain; over the LAN channel only `federation.query` / `federation.expertise` are admitted — the 6 management methods are local/Tauri-only (I5). **Config:** a `[federation]` section (enable, consent timeout, mDNS). **Surfaces:** the `nimbus team` CLI (`discover` / `pair` / `namespace publish|grant|revoke` / `query` / `who-knows`); 5 local management methods added to the Tauri renderer allowlist (62 → 67; `federation.pair` stays CLI-only — out-of-band code, same class as `lan.pair`; `federation.query`/`expertise` never renderer-callable). **Invariant I17** — federated answering is intrinsic to `query-gate.ts` (the only federation module importing the item-list read path); enforced by a runtime test + a static **D13** rule. **Boot:** `buildFederationRuntime` constructs the providers from config at gateway boot (inert by default — federation ships disabled). **Tests:** an integration-tested acceptance suite (discover → pair → publish → grant → scoped leak-proof query → undeclared-empty → live revoke → audit-verify → expertise → LAN allowlist → consent seam) + a skippable real-mDNS E2E. **Hardening:** `extension.install`/`enable`/`disable`/`remove` are now forbidden over LAN (I5), making extension management uniformly CLI-only.
- **Phase 6 Slice 1 — over-the-wire federation** (2026-06-05): wired the three deferred Slice-1 seams so two gateways exchange federated queries over the NaCl-box LAN channel — outbound LAN pair/query client (`ipc/lan-client.ts`), `LanServer` constructed and started at boot (`federation/federation-server.ts` `buildFederationLanServer` + `platform/assemble.ts`, gated on `[federation].enabled`), and the owner-consent round-trip (`federation/consent-broker.ts` + the renderer-callable `federation.consentRespond`, I7 67→68). Adds a persistent Vault box identity (`federation/federation-identity.ts`) and a two-gateway over-the-wire acceptance test (pair → grant → leak-proof query → revoke → audit.verify → expertise → consent-timeout → impersonation). Answering `peerId` is forced from the NaCl-authenticated session (I17/R1 — a body-supplied `peerId` cannot impersonate). No migration (session-only consent).
- **(Superseded by the over-the-wire federation entry above, delivered the same day.)** ~~Deferred to a Slice 1 follow-up / Slice 2~~ — so two gateways can exchange queries over the literal NaCl-box wire: the production **outbound LAN client** (the `OutboundPairHandshake` socket body — `initiatePair` is currently a tested DI seam that throws "not wired"), wiring the **`LanServer` into gateway boot**, and the **owner-consent UI round-trip** (the dispatcher's prompter is a `notify` seam defaulting to a timeout-safe deny). Until those land, the gate + primitives are fully functional, integration-tested, and reachable locally (CLI/renderer); a *remote* peer cannot yet connect over the wire.

---

## Phase 5 — The Extended Surface (✅ Complete — 2026-06-04)

Core sequencing: T1 → T3 → Wave A → T4 → T6 → T2 → Wave B. Final status: **T1–T6 ✅ · Wave A ✅ · Wave B ✅ · Tiers 1–5 ✅** (Tier-4 email — gmail/outlook/fastmail/protonmail/imap; Tier-5 local — localdb/storybook/dataprofile). Remaining unchecked connectors are documented non-gating deferrals (Pocket, Loom, Expensify, App Center, Chromatic, RUM, Web-vitals — dead-upstream or no public read API).

### 2026-06-04

- **Phase 5 (The Extended Surface) closed ✅** — All buildable workstreams shipped. The last two items landed today: **`nimbus security scan` v2** (#515) and the **`tool_call_log` retention policy** (#511). Every remaining unchecked Phase 5 connector is a documented non-gating deferral: **Pocket** (Mozilla retired the service 2025-07-08, API disabled 2025-11-12 — dead upstream), **Loom** / **Expensify** (no public token-auth read API), **Microsoft App Center** (retired by Microsoft 2025-03-31), **Chromatic** (no listable builds API), and the **LogRocket / FullStory / Datadog RUM** + **Web-vitals watcher** Wave B stretch items ("does not gate Phase 5 completion"). The community-extension Marketplace acceptance criterion is tracked in **Phase 9.5 (Marketplace Registry)** and does not gate Phase 5. Docs reconciled in `docs/roadmap.md` (Phase 5 header + status row flipped to ✅; Pocket marked cancelled; `.orc` profiling criterion corrected to "deferred — no pure-JS ORC reader"; Marketplace criterion scoped to Phase 9.5).

- **`nimbus security scan` v2** ✅ — All six deferred enhancements, one PR. (1) **`[security.allowlist]` mute-list** — each finding now carries a `fingerprint = sha256(service:external_id:pattern:redacted:sha256(context_snippet))`; the context hash disambiguates fixed-literal matches (PEM/PGP/gcp-sa keys redact identically), and `[[security.allowlist]]` entries with a `fingerprint` are dropped from results and counted in `muted_count`. Fingerprints carry no secret bytes. (2) **`--fail-on-finding`** — CLI exits 1 when any non-muted finding remains (CI gate), exit decided outside the try so it is never swallowed. (3) **Extended pattern tier** — `EXTENDED_SECRET_PATTERNS` (generic high-entropy assignments / bearer-like) behind `[security].extended_patterns` or `--extended`; off by default. (4) **`--service <name>`** — scopes `iterateScannableItems` to one connector. (5) **Long-running + cancellable** — `security.scan` is now a `LongRunningJobRegistry` job returning `{ jobId }` and emitting `security.scanProgress` / `security.scanDone` / `security.scanError`; the streaming item iterator (`db.query().iterate()`) and per-200 progress keep memory flat, and `security.scanCancel` aborts mid-scan. The CLI subscribes and renders progress. (6) **Line-level git-blame** — new **V32 `git_blame_line`** table (`(repo_root, file_path, line_no) → commit/author/time`), populated during git-aware filesystem sync by `git blame --line-porcelain` over the indexed `code_symbol` excerpt ranges only (coalesced via `mergeRanges`; > 64 disjoint ranges → one full-file blame to stay under the Windows `CreateProcess` cmdline limit; per-file `MAX_BLAME_LINES` 5000 cap; 20 s `AbortSignal.timeout`). `code_symbol` items now persist `excerptStartLine`, so a finding's body-preview offset maps to an absolute file line and the scanner attaches `blame: { commit_sha, author_name, author_email, author_time_ms } | null` via a pure indexed lookup — **no `git` subprocess at scan time**. Non-git findings get `blame: null`; existing indexes backfill blame on the next `nimbus connector sync filesystem`. The acceptance-criterion e2e (`security-scan.e2e.test.ts`) now asserts the fingerprint, line-level blame attribution, and allowlist mute. All writes route through `dbRun` (I14); the read-only scan adds no HITL action type.
- **`tool_call_log` retention policy** ✅ — Bounds the previously unbounded `tool_call_log` audit table. New `[audit].tool_call_log_retention_days` config key (default **90**; `0` disables, rows kept forever) parsed in `config/nimbus-toml.ts` (integer, range `[0, 36500]`, mirrors the `[extensions]` bounded-int parser). A daily retention job — `startToolCallLogRetention` in `db/tool-call-log-retention.ts`, registered in `platform/assemble.ts` right after the session-memory store and pushed onto `sidecarStops` — prunes once at startup then every 24h (`setInterval`), each tick isolated so a thrown prune never crashes the scheduler. The pure `pruneToolCallLog(db, { retentionDays, nowMs })` deletes `tool_call_log` rows with `called_at < now − retentionDays·86_400_000` and, **only when ≥1 row was removed**, appends exactly one `tool_call_log.pruned` entry (`hitl_status: "not_required"`, `action_json` `{ deleted_count, retention_days, cutoff_ms }`) to the chained `audit_log` via the existing `appendAuditEntry`. The BLAKE3-chained `audit_log` is **only appended to — never rewritten or pruned**, so the audit chain proper is untouched. **No migration** — `tool_call_log` is the V29 table and `called_at` is already indexed. All writes route through `dbRun` (I14). Unit-tested with an injected clock (window boundary, disabled mode, exactly-one-audit-row, no-op when empty / table missing, scheduler error-isolation).
- **Phase 5 Wave B closed** ✅ — Wave B (mobile + frontend engineering connector breadth) is complete with **four** read-only connectors shipped: **Bitrise**, **Codemagic**, **TestFlight**, and **Firebase App Distribution**. The two remaining candidates are not built, after evaluating each against its live API:
  - **Microsoft App Center — cancelled.** Visual Studio App Center was retired by Microsoft on **2025-03-31**: sign-in and API calls (`api.appcenter.ms`) stopped that day, and the residual Analytics & Diagnostics surface expires **2026-06-30**. A read connector would be dead code; no drop-in successor exposes the same token-auth read API. Revisit only if a successor with a clean token-auth read API emerges. (<https://learn.microsoft.com/en-us/appcenter/retirement>)
  - **Chromatic — deferred (unchanged).** Chromatic's token-auth public GraphQL API (`index.chromatic.com/graphql`, `createAppToken` → bearer) exposes only `Project.lastBuild` (a single build); there is **no paginated builds-list field** reachable from a stable headless token. Enumerating build history needs undocumented internal `app.*` roots or an OAuth-session JWT (not a headless token), so a meaningful build-observability connector is not feasible today. Revisit if Chromatic publishes a listable builds API.

  Neither gates Phase 5. Docs-only change — no connector code, no manifest/secret/rate-limiter entries.

### 2026-06-03

- **Wave B connector — TestFlight (via Apple's App Store Connect API) — read-only** ✅ — Cloned from the Codemagic connector (same shape: mobile build observability, apps → builds walk). Indexes the user's App Store Connect **apps** and recent TestFlight **builds** into the local index as `testflight:app` and `testflight:build` items. The gateway-side syncable (`testflight-sync.ts`, cursor `{ pass }` / `nimbus-testflight1:`) walks `GET /v1/apps` (JSON:API `data[]`) → per-app `GET /v1/builds?filter[app]=<id>&sort=-uploadedDate&limit=50` and upserts each via the pure mappers `mapTestflightAppToItem` / `mapTestflightBuildToItem` (`testflight-build-mapping.ts`). App `external_id` = the app `id`; build `external_id` = the build `id`, title `<app name?> #<version> (<processingState>)`, **canonical URL null** (TestFlight builds have no stable public URL), metadata `{ app_id, version, processing_state (PROCESSING/VALID/INVALID), expired, uploaded_date, min_os_version, uses_non_exempt_encryption }` with `uploadedDate` (ISO-8601) parsed to epoch-ms via a defensive helper; all field access is defensive (`asRecord`/`stringField`, JSON:API `data[].id` + `data[].attributes`). **Auth — App Store Connect uses a short-lived ES256 JWT** (NOT a static token): both the gateway sync and the MCP server sign via the shared `@nimbus-dev/sdk` helper `signAppStoreConnectJwt` (header `{ alg: ES256, kid, typ: JWT }`, claims `{ iss, iat, exp (now+600s, <= 20 min), aud: appstoreconnect-v1 }`, signed with `node:crypto` `crypto.sign("sha256", …, { key, dsaEncoding: "ieee-p1363" })` — raw `r||s` per JWS, not DER), sent as `Authorization: Bearer <jwt>`; no external JWT dep. Hosting the signer in the MIT SDK (which both sides import) keeps one source of truth across the gateway↔connector package boundary. Three vault keys `testflight.issuer_id` / `testflight.key_id` / `testflight.private_key` (the full `.p8` PEM) are injected as `TESTFLIGHT_ISSUER_ID` / `TESTFLIGHT_KEY_ID` / `TESTFLIGHT_PRIVATE_KEY` at spawn (`phase3AddTestflightMcp`, `ServerSpec` routed through `wrapServerSpec` (I15)); sync + spawn both noop when any of the three is unset. Lazy-mesh manifest declares `network: ["api.appstoreconnect.apple.com"]`, empty filesystem. The MCP server (`mcp-connectors/testflight`) exposes read-only `testflight_list` / `testflight_get` / `testflight_search` (substring filter over a build's version/processingState/minOsVersion/id via `filterTestflightBuilds`, reading the JSON:API `attributes`). New rate-limiter provider `testflight` (50 rpm / burst 10 — Apple's limit is modest). `testflight:*` stays on local MiniLM embeddings. `hitlRequired: []`. **v1: read-only apps + builds; write actions (expire build, tester groups, beta feedback) deferred.**
- **Wave B connector — Firebase App Distribution — read-only** ✅ — Cloned from the Codemagic/TestFlight pattern (mobile release observability). Indexes each configured app's recent **releases** into the local index as `firebase:release` items. The gateway-side syncable (`firebase-sync.ts`, cursor `{ pass }` / `nimbus-firebase1:`) walks `GET /v1/projects/<projectNumber>/apps/<appId>/releases?pageSize=50` for each configured app id — the **project number is derived as the 2nd colon-segment of the app id** (`1:<projectNumber>:<platform>:<hash>`), so an app id with no derivable project number is skipped — and upserts each release via the pure mapper `mapFirebaseReleaseToItem` (`firebase-release-mapping.ts`). Release `external_id` = the App Distribution release resource `name` (`projects/N/apps/A/releases/R`), title `<displayVersion> (<buildVersion>)`, body preview = release notes (falling back to title), metadata `{ app_id, display_version, build_version, create_time, release_notes_text, firebase_console_uri, testing_uri, binary_download_uri }` with `createTime` (ISO-8601) parsed to epoch-ms via a defensive helper; the `binary_download_uri` is **stored only and NEVER fetched** (it is a binary download link, not data to index); all field access is defensive (`asRecord`/`stringField`). **Auth — App Distribution's REST API is a Google Cloud API that accepts a short-lived OAuth2 Bearer token** (NOT a static token): both the gateway sync and the MCP server mint via the shared `@nimbus-dev/sdk` helper `mintGoogleAccessToken`, which signs an **RS256 JWT-bearer assertion** (`{ alg: RS256, typ: JWT }` / `{ iss: client_email, scope: cloud-platform, aud: token_uri, iat, exp (now+3600s) }`) with `node:crypto` from the developer's Google **service-account key JSON** and exchanges it at `https://oauth2.googleapis.com/token` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`) for an `access_token` — no `googleapis` dependency. Hosting the signer in the MIT SDK (which both sides import) keeps one source of truth across the gateway↔connector package boundary. Two vault keys `firebase.service_account_json` (the SA key JSON) + `firebase.app_ids` (comma-separated app ids) are injected as `FIREBASE_SERVICE_ACCOUNT_JSON` / `FIREBASE_APP_IDS` at spawn (`phase3AddFirebaseMcp`, `ServerSpec` routed through `wrapServerSpec` (I15)); sync + spawn both noop when either is unset or the SA JSON is malformed, and a failed token mint returns a clean zero-upsert pass-cursor success. Lazy-mesh manifest declares `network: ["firebaseappdistribution.googleapis.com", "oauth2.googleapis.com"]`, empty filesystem. The MCP server (`mcp-connectors/firebase`) exposes read-only `firebase_list` / `firebase_get` / `firebase_search` (substring filter over a release's displayVersion/buildVersion/releaseNotes.text/name via `filterFirebaseReleases`), caching the minted token in-process (~30 min). New rate-limiter provider `firebase` (40 rpm / burst 8). `firebase:release` stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES`). `hitlRequired: []`. **v1: read-only releases; write actions (distribute a build, manage tester groups) deferred.**
- **Wave B connector — Codemagic (mobile CI/CD) — read-only** ✅ — Cloned from the Bitrise connector (same shape: mobile CI, token header, apps + builds). Indexes the user's Codemagic **apps** and recent **builds** into the local index as `codemagic:app` and `codemagic:build` items. The gateway-side syncable (`codemagic-sync.ts`, cursor `{ pass }` / `nimbus-codemagic1:`) walks `GET /apps` (apps under the `applications` key) → per-app `GET /builds?appId=<id>&limit=50` (builds under the `builds` key) and upserts each via the pure mappers `mapCodemagicAppToItem` / `mapCodemagicBuildToItem` (`codemagic-build-mapping.ts`). App `external_id` = the app `_id`, canonical URL `https://codemagic.io/app/<id>`; build `external_id` = `<appId>/<buildId>`, title `#<version|short-id> <workflow> (<branch>)`, canonical URL `https://codemagic.io/app/<appId>/build/<buildId>`, metadata `{ app_id, status, workflow_id, branch, tag, version, started_at, finished_at, duration_ms, commit }` with ISO timestamps parsed to epoch-ms; all field access is defensive (`asRecord`/`stringField`/`numberField`). **Auth** — Codemagic's API uses an `x-auth-token` header (NOT `Authorization`); the single vault key `codemagic.token` is injected as `CODEMAGIC_TOKEN` at spawn (`phase3AddCodemagicMcp`, `ServerSpec` routed through `wrapServerSpec` (I15)). Lazy-mesh manifest declares `network: ["api.codemagic.io"]`, empty filesystem. The MCP server (`mcp-connectors/codemagic`) exposes read-only `codemagic_list` / `codemagic_get` / `codemagic_search` (substring filter over a build's branch/message/workflow/status via `filterCodemagicBuilds`). New rate-limiter provider `codemagic` (60 rpm / burst 10). `codemagic:*` stays on local MiniLM embeddings. `hitlRequired: []`. **v1: read-only apps + builds; write actions (start/cancel build) deferred.**
- **Tier-5 connector — Local data profiling (parquet/csv/jsonl/json schema) — local, no network, no row data** ✅ — Completes the Tier-5 local trio (alongside Local DB Schema Indexing + Storybook). Profiles local data files — `.parquet`, `.csv`, `.jsonl`/`.ndjson`, `.json` — under a configured directory into `dataprofile:data_model` items via `mapDataModelToItem`, carrying the SCHEMA only: column names, column types, column count, a row-count ESTIMATE, and file size. **HARD scope constraint (security): NEVER indexes cell values, row samples, first-N-row previews, or header-row data values.** Parquet schema + row count come from the file FOOTER metadata via `hyparquet` (a pure-JS reader, vetted via `check-package`: Hyperparam, 129 versions — reads only the footer byte-range, so no row data crosses the wire); CSV column names come from the header line (row estimate = line count − 1); JSONL/JSON field names + JS kinds come from the top-level structure (object keys + value *kinds* only, never the values). A `data-profile-sync` test writes files containing PII cell values (`123-45-6789`, `victim@x.com`) and asserts the indexed metadata contains the column NAMES but none of the VALUES. The sync handler (`data-profile-sync.ts`, cursor `{ pass }` / `nimbus-dataprofile1:`) recursively walks the configured dir (`MAX_FILES=2000`, depth cap 12; text files read whole ≤64 MiB for a row count, larger files get a header-only peek with no estimate; parquet footer read regardless of size) via an **injectable Parquet footer reader** (real over hyparquet in prod, a fake in tests so no real parquet bytes are needed); `external_id` = the relative path; reuses the existing `"filesystem"` rate-limiter provider. **Config** — a single non-secret PATH vault key `dataprofile.dir`, so `CONNECTOR_VAULT_SECRET_KEYS.dataprofile` is `["dataprofile.dir"]`; the sync + lazy-mesh spawn both noop when unset. Lazy-mesh spawn `phase3AddDataprofileMcp` rides the phase3 bundle, extends the connector manifest's `filesystem.read` with the configured dir at spawn time (mirroring `phase3AddLocaldbMcp` / `phase3AddGreatExpectationsMcp`), injects `DATAPROFILE_DIR`, `ServerSpec` routed through `wrapServerSpec` (I15); the static manifest declares NO network and empty filesystem. The MCP server (`listDataModels` / `getDataModel` over the env dir with an `assertWithinDataDir` path-traversal guard) exposes `dataprofile_list` / `dataprofile_get` / `dataprofile_search` — pure schema reads. **The no-row-data contract test** (`mcp-connectors/dataprofile/test/no-row-data.test.ts`) calls `assertNoRowDataTools(DATAPROFILE_TOOL_NAMES, "dataprofile")` (the same SDK assertion the Tier-3 warehouse connectors use), so a future `dataprofile_sample` / `dataprofile_get_rows` / `dataprofile_preview` tool fails CI. `dataprofile:data_model` stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — schema metadata is structured). `hitlRequired: []`. **Deviations from the original roadmap spec** (both for consistency with the shipped localdb/storybook per-connector pattern): a dedicated `dataprofile` service id rather than `provider = "filesystem"` (the existing `filesystem` service already emits `git_commit` / `dependency` / `code_symbol` code items), and a dedicated `dataprofile.dir` config key rather than reading `[[filesystem.roots]]`. **ORC is deferred** — no maintained pure-JS ORC schema reader exists on npm (`orc-tools` / `apache-orc` / `node-orc` are all absent); revisit when one ships. **v1: parquet/csv/jsonl/json schema only.**

### 2026-06-02

- **`nimbus mcp-server`** — expose the local index to MCP-compatible editor AIs (Cursor, Claude Code, Copilot) as a read-only MCP stdio server. Six read-only tools (`searchIndex`, `getConnectorStatus`, `getRecentIncidents`, `getRecentPullRequests`, `getRecentDeployments`, `getDoraMetrics`) proxy to existing Gateway read IPC methods. `nimbus mcp-server` prints the editor config block; `nimbus mcp-server --stdio` runs the server. No write surface, no HITL surface.
- **Tier-5 connector — Storybook (local component/story manifest) — local, no network, no code execution** ✅ — The second Tier-5 (local) connector, completing the local tier (Tier-5's filesystem-v2 profiling was already shipped). Indexes the story-level metadata from a local Storybook manifest — the `index.json` (Storybook v7+) or legacy `stories.json` (v6) that `storybook build` (or the dev server) writes to disk — as `storybook:story` items via `mapStorybookStoryToItem`. This gives design-system component coverage and lets the user recall "which stories cover the Button component" from the local index. It is a **pure filesystem read of one JSON manifest** under the configured Storybook output dir: NO browser is launched, NO dev server is contacted, and NO component/story code is executed. The sync handler (`storybook-sync.ts`, cursor `{ pass }` / `nimbus-storybook1:`) reads `<dir>/index.json` (falling back to `<dir>/stories.json`, ≤16 MiB), and the pure `parseStorybookIndex` handles BOTH the v7 `{ v, entries: { <id>: { id, title, name, importPath, tags, type } } }` shape and the legacy v6 `{ v, stories: { <id>: { id, kind, story, importPath } } }` shape (mapping the `kind`/`story` aliases to title/name). One item per story entry with an id: `external_id` = the Storybook story id (e.g. `components-button--primary`, stable, never a UUID), title = `<componentTitle> / <storyName>` (falling back to component title, then story name, then id), body preview = the title + import path + tags (searchable), and metadata = component title, story name, import path, tags, entry type; `modifiedAt` = the manifest file's mtime else syncedAt. **Config** — a single non-secret PATH vault key `storybook.dir` (the dir the manifest lives in, e.g. `storybook-static`), so `CONNECTOR_VAULT_SECRET_KEYS.storybook` is `["storybook.dir"]`; the sync + the lazy-mesh spawn both noop when unset, and a configured-but-not-yet-built Storybook (no readable manifest) is a clean zero-upsert success (cursor preserved). Lazy-mesh spawn `phase3AddStorybookMcp` rides the phase3 bundle, extends the connector manifest's `filesystem.read` with the configured dir at spawn time (mirroring `phase3AddLocaldbMcp` / `phase3AddGreatExpectationsMcp`), injects `STORYBOOK_DIR`, `ServerSpec` routed through `wrapServerSpec` (I15); the static manifest declares NO network and empty filesystem. The MCP server (`loadStories` over the env-configured dir, reading `index.json` then `stories.json`) exposes `storybook_list` / `storybook_get` / `storybook_search` — pure filesystem reads. Reuses the existing `"filesystem"` rate-limiter provider. `storybook:story` stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — story metadata is structured, not prose). `hitlRequired: []`. **v1 indexes story-level metadata only — per-story args/parameters and MDX docs bodies deferred.**
- **Tier-5 connector — Local DB Schema Indexing (saved SQL queries) — local, no network, no DB connection** ✅ — The first Tier-5 (local) connector. Indexes the saved SQL queries / schema scripts that local database tools (DBeaver, DataGrip, pgAdmin) keep on disk as `.sql` files, as `localdb:saved_query` items via `mapLocalDbQueryToItem`. This enables semantic recall of "that one SQL query I wrote last month" — the SQL TEXT (capped 2000 chars) is indexed as the body preview, so it is embedded and searchable. It is a **pure, bounded, path-traversal-guarded filesystem read** in the same shape as the Great Expectations / Obsidian connectors: NO database is ever connected to, NO query is ever executed, and NO binary is spawned. The sync handler (`localdb-sync.ts`, cursor `{ pass }` / `nimbus-localdb1:`) recursively walks the configured scripts dir for `.sql` files (`MAX_FILES=2000`, per-file size cap ~2 MiB, depth cap 12; empty/oversized/unreadable files skipped) and maps each via the pure `mapLocalDbQueryToItem`: `external_id` = the relative path (stable, never a UUID), title = the file basename, body preview = the SQL text, and metadata = relative path + referenced table/view names (a comment-stripping heuristic `extractTableNames` that removes `--`/`/* */` comments and `"`/`` ` ``/`[]` identifier wrappers so a quoted schema-qualified name collapses to its dotted form) + statement count + size; `modifiedAt` = file mtime else syncedAt. **Config** — a single non-secret PATH vault key `localdb.scripts_dir` (the dir the user's DB tool stores scripts/consoles in), so `CONNECTOR_VAULT_SECRET_KEYS.localdb` is `["localdb.scripts_dir"]` (a known/allowed key for D11 + cleared on removal); the sync + the lazy-mesh spawn both noop when unset. Lazy-mesh spawn `phase3AddLocaldbMcp` rides the phase3 bundle, extends the connector manifest's `filesystem.read` with the configured dir at spawn time (mirroring `phase3AddGreatExpectationsMcp` / `ensureObsidianMcp`), injects `LOCALDB_SCRIPTS_DIR`, `ServerSpec` routed through `wrapServerSpec` (I15); the static manifest declares NO network and empty filesystem (the dir is added at spawn). The MCP server (`scanSavedQueries` / `getSavedQuery` over the env-configured dir with an `assertWithinScriptsDir` path-traversal guard) exposes `localdb_list` / `localdb_get` / `localdb_search` — pure filesystem reads. Reuses the existing `"filesystem"` rate-limiter provider (no new provider). `localdb:saved_query` stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — SQL is structured, not prose paragraphs — consistent with the default-omit rule). `hitlRequired: []`. **v1 indexes saved-query files only — live schema introspection and query-history DB files (e.g. pgAdmin's sqlite store) deferred.**
- **Tier-4 connector — ProtonMail (via ProtonMail Bridge) email — headers + capped preview + attachment metadata only; HITL-gated send** ✅ — The third Tier-4 (EMAIL) connector, completing the email tier. ProtonMail is end-to-end encrypted, so its servers cannot be read directly; the **ProtonMail Bridge** desktop app decrypts mail locally and exposes a standard IMAP/SMTP interface on the loopback interface (`127.0.0.1:1143` IMAP / `127.0.0.1:1025` SMTP) with Bridge-generated credentials. This connector indexes the mailbox over that local IMAP listener as `protonmail:email` items via `mapProtonmailEmailToItem`. Because ProtonMail Bridge speaks plain IMAP/SMTP, the connector is the EMAIL-class clone of the Generic IMAP infra-prover: the gateway sync (`protonmail-sync.ts`, cursor `{ pass }` / `nimbus-protonmail1:`, transient-tolerant — a Bridge-not-running connection failure preserves the cursor) **reuses the generalized `_lib/imap-client.ts` `fetchImapMessages`** and the `ImapMessageInput` shape — the shared `ImapConnectionConfig` gained two optional fields (`secure`, `tlsRejectUnauthorized`) so ProtonMail can connect with `secure: false` (Bridge uses STARTTLS on a local port) and accept the Bridge's self-signed certificate (`rejectUnauthorized: false`), which is safe because the connection never leaves `127.0.0.1`. The MCP connector package (`packages/mcp-connectors/protonmail`) mirrors the IMAP read tools (`protonmail_list` / `protonmail_get` / `protonmail_search` — headers + attachment metadata + capped preview, NEVER attachment bytes or a full body) plus a HITL-gated `protonmail_mail_send` over the Bridge SMTP relay. **HEADERS + capped PREVIEW + attachment METADATA only** is preserved by the same `ENVELOPE` + `BODYSTRUCTURE` + truncated-text-part fetch and the pure `bodystructure`/`mail-core` helpers; a mapper test asserts no attachment content/`base64` reaches the index. **Creds** — Bridge username/password (required) + optional `protonmail.imap_host`/`imap_port`/`mailbox` and `smtp_host`/`smtp_port`/`smtp_username`/`smtp_password` overrides (defaults are the Bridge loopback listeners), so `CONNECTOR_VAULT_SECRET_KEYS.protonmail` lists all nine; the connector reads only `PROTONMAIL_*` from scoped env. Lazy-mesh spawn `phase3AddProtonmailMcp` rides the phase3 bundle gated on the Bridge credentials. **Sandbox** — the loopback `127.0.0.1:1143` (and `127.0.0.1:1025` when SMTP send is configured) host:port entries are added at spawn via `manifestWithExtraNetworkHosts` (the Tier-4a `host:port` permission syntax), `ServerSpec` routed through `wrapServerSpec` (I15). **HITL send** — `protonmail_mail_send` is gated by the existing `email.send` `action.type`, like imap/gmail/outlook — no `executor.ts` / invariant change. (Send was included beyond the roadmap's original read-only note — the Bridge SMTP relay does send outbound mail; per the workstream's decision to include HITL-gated send across the email tier.) `protonmail:email` IS prose → `PROSE_HEAVY_TYPES` (the 19th entry). The real imapflow/nodemailer Bridge adapter (`server.ts`) is coverage-exempt; the testable logic (pure mapper, sync cursor/transient handling, BodyStructure walkers, preview capping, the tool-surface no-bytes contract + send delegation) is fully covered with injected fakes. **Known follow-up:** the IMAP and ProtonMail connectors duplicate the pure `bodystructure` + `mail-core` helpers + the tool-registration shape; a shared `mcp-connectors/shared/mail-kit` extraction (parameterized by tool prefix) is a clean dedup deferred so it doesn't churn the just-shipped connectors. **v1: single mailbox, headers + preview + attachment-metadata only.**
- **Tier-4 connector — Fastmail (native JMAP) email — headers + capped preview + attachment metadata only; HITL-gated send** ✅ — The second Tier-4 (EMAIL) connector — Fastmail over its native **JMAP** protocol (pure JSON-over-HTTPS, no IMAP/SMTP sockets, no extra runtime deps). Indexes `fastmail:email` items via `mapFastmailEmailToItem`. The sync handler (`fastmail-sync.ts`, cursor `{ pass }` / `nimbus-fastmail1:`) discovers the JMAP session (`GET {baseUrl}/jmap/session` → `apiUrl` + the `urn:ietf:params:jmap:mail` primary account id), then issues ONE batched `POST {apiUrl}` with two method calls — `Email/query` (most-recent `MAX_EMAILS=200`, sorted `receivedAt` descending) and a back-referenced `Email/get` (`#ids` → the query result) requesting the header properties + `attachments` body-part metadata + `fetchTextBodyValues: true` with **`maxBodyValueBytes: 2048`**. **HARD scope constraint (security): HEADERS + a short capped plain-text PREVIEW + attachment METADATA ONLY.** Because `Email/get` sets `maxBodyValueBytes`, the JMAP server truncates the text body value before it crosses the wire (a full body is never received); the preview is taken from the first `textBody` part's (truncated) body value, falling back to the server-computed `preview` string, capped to 2000 chars. Only the `attachments` `{ name, size, type }` metadata is read — the attachment `blobId` download URL is **NEVER** dereferenced. A `viewEmail`/mapper test asserts the serialized item carries no `blobId`/`content`/`base64` field. `external_id` prefers the RFC `Message-Id`, falling back to the stable JMAP email `id` (unique per account); the row is skipped when neither is present. The connector MCP read tools (`fastmail_list` / `fastmail_get` / `fastmail_search` — `search` is a JMAP `Email/query` `{ text }` full-text filter) return the same header+metadata+preview view; the HITL-gated `fastmail_mail_send` composes the JMAP submission flow (`Identity/get` + `Mailbox/query` for Drafts → `Email/set` create draft + `EmailSubmission/set` submit). **Auth** — a single secret `fastmail.api_token` (a Fastmail API token, required) plus an optional non-secret `fastmail.base_url` override (default `https://api.fastmail.com`), so `CONNECTOR_VAULT_SECRET_KEYS.fastmail` is `["fastmail.api_token", "fastmail.base_url"]`; the connector reads only `FASTMAIL_API_TOKEN` / `FASTMAIL_BASE_URL` from scoped env, never the vault. Lazy-mesh spawn `phase3AddFastmailMcp` rides the phase3 bundle gated on the token. **Sandbox** — JMAP is pure HTTPS/443 to the fixed `api.fastmail.com` host (the session, api, and any blob upload/download endpoints are all under that host), so unlike Generic IMAP this connector needs no per-tenant host and no non-443 port extension — the static `permissions.network` is the single host `api.fastmail.com`, `ServerSpec` routed through `wrapServerSpec` (I15) via the static-manifest `wrap` helper. **HITL send** — `fastmail_mail_send` is gated by the existing `email.send` `action.type` (in `HITL_REQUIRED_BACKING`) via the planner path, like gmail/outlook/imap send — no `executor.ts` / invariant change. `fastmail:email` IS prose → added to `PROSE_HEAVY_TYPES` (the 18th entry; MiniLM-only fallback when `openai.api_key` is absent). The real JMAP fetch adapter (`server.ts`, a cached-session HTTPS client) is coverage-exempt like every connector `server.ts`; all the testable JMAP logic — session parse, address/preview/attachment reduction, the request builders, response extraction, and the `viewEmail` no-bytes view — lives in the pure `jmap-core.ts` (100% covered) and is exercised with fakes so tests run without a socket. **v1: single account, headers + preview + attachment-metadata only — folders / threads / push and reply/forward deferred.** Reuses the EMAIL-class template from the Generic IMAP infra-prover.
- **Tier-4 connector — Generic IMAP / SMTP email (the EMAIL-class infra-prover) — headers + capped preview + attachment metadata only; HITL-gated send** ✅ — The first Tier-4 (EMAIL) connector and the template Fastmail (JMAP) + ProtonMail (Bridge) reuse. Indexes any IMAP server (Fastmail, ProtonMail-via-Bridge, self-hosted, corporate) as `imap:email` items via `mapImapMessageToItem`, reading raw IMAP over `imapflow` (vetted: Postal Systems OÜ / Andris Reinman, 220 versions) and sending mail over `nodemailer` (Andris Reinman, 298 versions) behind the existing HITL `email.send` gate. **HARD scope constraint (security): HEADERS + a short capped plain-text PREVIEW + attachment METADATA ONLY.** The connector fetches the IMAP `ENVELOPE` (subject/from/to/cc/date/message-id), `BODYSTRUCTURE` (attachment filename/size/mimetype), and a single truncated `text/plain` body part for the preview (capped `PREVIEW_FETCH_BYTES=2048` at fetch + `PREVIEW_MAX_CHARS=2000` in the mapper). It **NEVER** requests `BODY[]` or an attachment part — the `ImapClient` interface deliberately exposes no surface to request attachment bytes or a full body, the `BodyStructure` walkers (`extractAttachments` / `findTextPlainPart`) only read structure-tree metadata, and a mapper test asserts the serialized item carries no `content`/`data`/`base64` field. The MCP read tools (`imap_list` / `imap_get` / `imap_search` — `search` is over message HEADERS, never a body/document scan) return the same header+metadata+preview view; the single write tool `imap_mail_send` clones the gmail/outlook send-tool shape. `external_id` prefers the RFC `Message-Id` (stable across mailbox moves), falling back to `<mailbox>:<uidvalidity>:<uid>` (never a UUID); the row is skipped when neither a message-id nor a valid uid is present. Sync is a single most-recent-N forward pass (`MAX_MESSAGES=200`, cursor `{ pass }` / `nimbus-imap1:`); it is tolerant of transient IMAP outages — the injected fetcher returns `{ ok: false }` on a connection failure and a thrown fetcher is caught, both preserving the cursor with zero upserts so the scheduler never crashes. **Per-tenant credentials** — nine vault keys `imap.host` / `imap.port` / `imap.username` / `imap.password` / `imap.mailbox` (defaults 993 / INBOX) + the optional `imap.smtp_host` / `imap.smtp_port` / `imap.smtp_username` / `imap.smtp_password` (SMTP defaults 465; the send tool is gated on them), so `CONNECTOR_VAULT_SECRET_KEYS.imap` lists all nine. The connector reads ONLY `IMAP_*` scoped env injected at spawn (never the vault). Lazy-mesh spawn `phase3AddImapMcp` rides the phase3 bundle gated on the IMAP read creds (host+username+password). **Sandbox (Tier-4a prereq)** — the IMAP/SMTP hosts are user-configured and on non-443 ports (IMAP 993, SMTP 465/587), which the I15 sandbox previously could not express (it hardcoded TCP/443). The Tier-4a prereq (commit `bc50d57a`) extended the `permissions.network` model to accept `host:port` entries (bare host = 443, back-compat); this connector's static `permissions.network` is empty and the concrete `<imap.host>:993` + `<smtp.host>:<port>` entries are added at spawn via `manifestWithExtraNetworkHosts` (the Salesforce/Jenkins per-tenant-host pattern), `ServerSpec` routed through `wrapServerSpec` (I15). **HITL send (no executor / invariant change)** — `email.send` is already in `HITL_REQUIRED_BACKING`; the gate keys on `action.type` only via the planner path (`PlannedAction.type` → gate, `payload.mcpToolId` → dispatch), exactly as gmail/outlook send already work, so the send tool needed no `executor.ts` edit and no new invariant. The manifest `hitlRequired` field is documentary. `imap:email` IS prose (email bodies are paragraphs) → added to `PROSE_HEAVY_TYPES` alongside `gmail:email` / `outlook:email` (MiniLM-only fallback when `openai.api_key` is absent). The real imapflow/nodemailer adapters (`_lib/imap-client.ts` on the gateway side + the connector `server.ts`) are thin socket shells with no injection seam — both coverage-exempt like every connector `server.ts` — while the testable logic (pure mapper, sync cursor/transient-failure handling, BodyStructure walkers, preview capping, the tool-surface no-bytes contract + send delegation) is fully covered with dependency-injected fakes so all tests run without a socket. **v1: single mailbox, headers + preview + attachment-metadata only — folders / flags / threading / IDLE push and reply/forward write tools deferred.** The LAST Tier-3 connector, and the only one that is **filesystem-read with no network and no live credentials**. Great Expectations validation results are CI ARTEFACTS — JSON files written by GX runs. The connector reads those JSON files from a configured local directory and indexes the validation METADATA: one `great_expectations:data_quality_test` item per `results[]` entry (per suite/batch/expectation). Config is a single non-secret PATH vault key `great_expectations.results_dir` (e.g. a CI-published `great_expectations/uncommitted/validations/` tree, or a flat artefacts dir); `CONNECTOR_VAULT_SECRET_KEYS.great_expectations = ["great_expectations.results_dir"]` (a non-secret path, listed so it satisfies the D11 vault-key allowlist + is cleared on removal). Sync/spawn noop when the key is unset. The sync handler (`great-expectations-sync.ts`, cursor `{ pass }` `nimbus-gx1:`) recursively walks `*.json` under the results dir (`MAX_FILES=1000`, per-file size cap ~4 MiB, depth cap), parses the GX validation-result shape — top-level `{ success, statistics: { success_percent }, meta: { expectation_suite_name, run_id, batch_kwargs/active_batch_definition/batch_spec }, results: [{ success, expectation_config: { expectation_type, kwargs: { column } }, result: { observed_value, element_count, unexpected_count, unexpected_percent } }] }` — and upserts via the pure `mapGreatExpectationsResultToItem(resultEntry, { suiteName, batchId, runId, runTime, successPercent, syncedAt, fileModifiedAt })`. `external_id` = stable composite `<suite>::<batch>::<expectationType>::<column ?? "_">` (hash-suffixed when over-long); title = `<suite> · <expectationType>(<column>)`; `modifiedAt` = run time (RFC3339 ISO via local `parseIsoMs`) else file mtime else syncedAt; url/canonical_url null. **The no-row-data line for GX:** the pure mapper is the stripping boundary — it copies ONLY the aggregate scalar metrics (scalar `observed_value`, `element_count`, `unexpected_count`, `unexpected_percent`, `success_percent`) and NEVER reads `unexpected_list` / `partial_unexpected_list` / `partial_unexpected_index_list` / `unexpected_index_list` / `partial_unexpected_counts` — those carry real data cell values (row data). If `observed_value` is itself an array/object of sampled values it is DROPPED (only scalar observed values stored). The `data_quality_test` type stays on local MiniLM embeddings (sparse/structured, NOT in `PROSE_HEAVY_TYPES`). **The no-row-data contract assertion** — the GX MCP package's `test/no-row-data.test.ts` imports `GREAT_EXPECTATIONS_TOOL_NAMES` and calls `assertNoRowDataTools(tools, "great_expectations")` from `@nimbus-dev/sdk`; a negative case asserts a hypothetical `great_expectations_get_unexpected_rows` / `great_expectations_sample` tool throws. A second test feeds the parser a `result` carrying `unexpected_list: ["secret-pii@…", …]` and asserts the produced metadata JSON contains no sample value (and no forbidden key). **Path-traversal guard** — the MCP server reads files only within `GREAT_EXPECTATIONS_RESULTS_DIR`; `assertWithinResultsDir` rejects any `..`-escaping or absolute path that resolves outside the dir (the filesystem analog of the argv flag-smuggling guard). Lazy-mesh spawn (`phase3AddGreatExpectationsMcp`) rides the phase3 bundle, gated on `great_expectations.results_dir`, extending the connector manifest's `filesystem.read` with the configured dir at spawn time (mirroring `ensureObsidianMcp`) and injecting `GREAT_EXPECTATIONS_RESULTS_DIR`; `ServerSpec` routed through `wrapServerSpec` (I15). Static sandbox manifest declares NO network (`network: []`) and empty filesystem (the dir is added at spawn). Three read tools (`great_expectations_list` / `great_expectations_get` / `great_expectations_search` — metadata only; the MCP server applies the SAME no-row-data stripping via a shared `gx-parse.ts`); `hitlRequired: []`.

### 2026-06-01

- **Tier-3 connector — Great Expectations (validation-result metadata, parsed from CI artefacts) — no row data, no network, no live creds** ✅ — The LAST Tier-3 connector, and the only one that is **filesystem-read with no network and no live credentials**. Great Expectations validation results are CI ARTEFACTS — JSON files written by GX runs. The connector reads those JSON files from a configured local directory and indexes the validation METADATA: one `great_expectations:data_quality_test` item per `results[]` entry (per suite/batch/expectation). Config is a single non-secret PATH vault key `great_expectations.results_dir` (e.g. a CI-published `great_expectations/uncommitted/validations/` tree, or a flat artefacts dir); `CONNECTOR_VAULT_SECRET_KEYS.great_expectations = ["great_expectations.results_dir"]` (a non-secret path, listed so it satisfies the D11 vault-key allowlist + is cleared on removal). Sync/spawn noop when the key is unset. The sync handler (`great-expectations-sync.ts`, cursor `{ pass }` `nimbus-gx1:`) recursively walks `*.json` under the results dir (`MAX_FILES=1000`, per-file size cap ~4 MiB, depth cap), parses the GX validation-result shape — top-level `{ success, statistics: { success_percent }, meta: { expectation_suite_name, run_id, batch_kwargs/active_batch_definition/batch_spec }, results: [{ success, expectation_config: { expectation_type, kwargs: { column } }, result: { observed_value, element_count, unexpected_count, unexpected_percent } }] }` — and upserts via the pure `mapGreatExpectationsResultToItem(resultEntry, { suiteName, batchId, runId, runTime, successPercent, syncedAt, fileModifiedAt })`. `external_id` = stable composite `<suite>::<batch>::<expectationType>::<column ?? "_">` (hash-suffixed when over-long); title = `<suite> · <expectationType>(<column>)`; `modifiedAt` = run time (RFC3339 ISO via local `parseIsoMs`) else file mtime else syncedAt; url/canonical_url null. **The no-row-data line for GX:** the pure mapper is the stripping boundary — it copies ONLY the aggregate scalar metrics (scalar `observed_value`, `element_count`, `unexpected_count`, `unexpected_percent`, `success_percent`) and NEVER reads `unexpected_list` / `partial_unexpected_list` / `partial_unexpected_index_list` / `unexpected_index_list` / `partial_unexpected_counts` — those carry real data cell values (row data). If `observed_value` is itself an array/object of sampled values it is DROPPED (only scalar observed values stored). The `data_quality_test` type stays on local MiniLM embeddings (sparse/structured, NOT in `PROSE_HEAVY_TYPES`). **The no-row-data contract assertion** — the GX MCP package's `test/no-row-data.test.ts` imports `GREAT_EXPECTATIONS_TOOL_NAMES` and calls `assertNoRowDataTools(tools, "great_expectations")` from `@nimbus-dev/sdk`; a negative case asserts a hypothetical `great_expectations_get_unexpected_rows` / `great_expectations_sample` tool throws. A second test feeds the parser a `result` carrying `unexpected_list: ["secret-pii@…", …]` and asserts the produced metadata JSON contains no sample value (and no forbidden key). **Path-traversal guard** — the MCP server reads files only within `GREAT_EXPECTATIONS_RESULTS_DIR`; `assertWithinResultsDir` rejects any `..`-escaping or absolute path that resolves outside the dir (the filesystem analog of the argv flag-smuggling guard). Lazy-mesh spawn (`phase3AddGreatExpectationsMcp`) rides the phase3 bundle, gated on `great_expectations.results_dir`, extending the connector manifest's `filesystem.read` with the configured dir at spawn time (mirroring `ensureObsidianMcp`) and injecting `GREAT_EXPECTATIONS_RESULTS_DIR`; `ServerSpec` routed through `wrapServerSpec` (I15). Static sandbox manifest declares NO network (`network: []`) and empty filesystem (the dir is added at spawn). Three read tools (`great_expectations_list` / `great_expectations_get` / `great_expectations_search` — metadata only; the MCP server applies the SAME no-row-data stripping via a shared `gx-parse.ts`); `hitlRequired: []`.
- **Tier-3 connector — GCP Vertex AI (model-registry metadata) — no row data** ✅ — GCP Vertex AI model-REGISTRY metadata (`vertex_ai:model`) via the **gcloud CLI's Vertex AI metadata command**: `gcloud ai models list --region <region> --project <project> --format json` returns a JSON ARRAY (NOT token-paginated) of `[{ name: "projects/<p>/locations/<r>/models/<id>", displayName, versionId, createTime, updateTime }]` — emit all entries in a single forward pass, page-capped `MAX_MODELS=500`, cursor `{ pass }` (`nimbus-vertex1:`). **Reuses the GCP-side Tier-3 cred template proven by BigQuery + Cloud Logging** (the GCP sibling of the AWS SageMaker model registry): NO new required vault key — reuses the EXISTING `gcp.credentials_json_path` + `gcp.project_id`, so `CONNECTOR_VAULT_SECRET_KEYS.vertex_ai` is `[]`. Like Cloud Logging (and unlike BigQuery's REST token-mint) it shells the native `gcloud ai` CLI directly with `env: extensionProcessEnv({ GOOGLE_APPLICATION_CREDENTIALS: credPath })` — no token-mint. **Regional:** Vertex AI is per-region; the connector reads an OPTIONAL non-secret `gcp.region` config key (added to the gcp connector's documented optional config — `CONNECTOR_VAULT_SECRET_KEYS.gcp` gains `gcp.region`, never required), defaulting to `us-central1` when absent. **Security — argv flag-smuggling guard on EVERY tool-input CLI arg:** both the region and the model id are guarded. The MCP tool surface uses the shared `isSafeCliArg` Zod refine (`cliArg`) on the `region` + `modelId` inputs so a `-`-prefixed / control-char value is rejected at the schema boundary, and `gcloudAi` re-checks the region before the spawn; the gateway sync handler validates the resolved region inline (`assertSafeCliArg`-equivalent local guard — the gateway package cannot import `mcp-connectors/shared`, so a tiny local guard mirrors sagemaker-sync's inline pattern), falling back to the default when unsafe and noop-ing the cycle. The gcloud runner is injectable (`runGcloud(credPath, project, region)` option, dependency-injection for tests); a missing/failed gcloud spawn degrades gracefully (empty pass, cursor preserved, no throw past the Syncable boundary); a missing cred/project noops via `syncNoopResult`. **The no-row-data contract assertion** — the Vertex AI MCP package's `test/no-row-data.test.ts` imports `VERTEX_AI_TOOL_NAMES` and calls `assertNoRowDataTools(tools, "vertex_ai")` from `@nimbus-dev/sdk`; the `predict`/`records`/`query`/`scan` etc. segments are denylisted, so any future `vertex_ai_predict` / `vertex_ai_get_records` tool fails CI. **FORBIDDEN commands NEVER called:** `gcloud ai endpoints predict`, `gcloud ai endpoints explain`, `gcloud ai ... raw-predict`, any batch-prediction output read — anything returning inference / model output. The connector indexes the Vertex AI model REGISTRY metadata only — model resource name, display name, version id, region, create/update timestamps; NO predictions. `external_id` = the model resource `name` (`projects/.../models/<id>`; fallback `<region>/<displayName>`); title = `displayName` (fallback the id segment of `name`); gcloud timestamps are RFC3339 ISO strings parsed via a LOCAL `parseIsoMs`; `modifiedAt` = `updateTime ?? createTime ?? syncedAt`; `url`/`canonical_url` null (pure mapper); the row is skipped when both the resource name and display name are missing. The `vertex_ai:model` type stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — sparse structured metadata). Lazy-mesh spawn (`phase3AddVertexAiMcp`) rides the phase3 bundle, gated on `gcp.credentials_json_path` (so Vertex AI appears whenever GCP does, like BigQuery + Cloud Logging), injecting `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` + `VERTEX_AI_REGION`, `ServerSpec` routed through `wrapServerSpec` (I15); static sandbox manifest declares network hosts `aiplatform.googleapis.com` + `oauth2.googleapis.com` + `www.googleapis.com`, with the regional `<region>-aiplatform.googleapis.com` host added per-region at spawn via `manifestWithExtraNetworkHosts` (the RFC-1123 validator rejects the `*-aiplatform.googleapis.com` wildcard, like Athena's regional host). Three read tools (`vertex_ai_list` / `vertex_ai_get` / `vertex_ai_search` — metadata only, shelling `gcloud ai models list/describe`); `hitlRequired: []`. v1 indexes the Vertex AI model registry only — experiments, custom training jobs, pipeline runs, and endpoints deferred; the `ml.endpoint.update` / `ml.pipeline.cancel` HITL writes are Phase-6-deferred and out of scope for the no-row-data tier by design.
- **Tier-3 connector — AWS SageMaker (model-registry metadata) — no row data** ✅ — Amazon SageMaker model-REGISTRY metadata (`sagemaker:model`) via the **AWS CLI's SageMaker metadata commands**: walk `aws sagemaker list-models --max-results 50` (reading `{ Models: [{ ModelName, ModelArn, CreationTime }], NextToken }`, `--next-token` pagination, page-capped `MAX_MODELS=500` / `PAGE_SIZE=50`), and for each model a page-capped (`MAX_DESCRIBE=50`) best-effort `aws sagemaker describe-model --model-name <name>` for richer METADATA — the `PrimaryContainer.Image` container-image reference, `PrimaryContainer.ModelDataUrl` (the model-data S3 URI **pointer**, a string — NOT the model bytes), and `ExecutionRoleArn`; single forward pass per cycle, cursor `{ pass }` (`nimbus-sm1:`). **Reuses the AWS-side Tier-3 cred template proven by Athena + CloudWatch**: NO new vault key — reuses the EXISTING `aws.access_key_id` + `aws.secret_access_key` + `aws.default_region`/`aws.profile` via the shared `_lib/aws-cli.ts` helper (`awsCredentialsExtra` + `awsCliJson`), so `CONNECTOR_VAULT_SECRET_KEYS.sagemaker` is `[]`. The AWS-CLI runner is injectable (`runAwsCli` option, dependency-injection for tests); a missing/failed `list-models` spawn degrades gracefully (empty pass, cursor preserved, no throw past the Syncable boundary); a `describe-model` failure is best-effort (the model is still upserted from its `list-models` metadata). **Security — argv flag-smuggling guard:** every value passed to the `aws` CLI is guarded against argv flag-smuggling. The MCP tool surface uses the shared `isSafeCliArg` Zod refine (`cliArg`) so a `-`-prefixed / control-char model name is rejected at the schema boundary; the gateway sync handler applies the same guard inline before any `describe-model` spawn — a `-`-prefixed `list-models` name (e.g. `--profile=attacker`) is mapped from metadata but **never** passed to `describe-model`. **The no-row-data contract assertion** — the SageMaker MCP package's `test/no-row-data.test.ts` imports `SAGEMAKER_TOOL_NAMES` and calls `assertNoRowDataTools(tools, "sagemaker")` from `@nimbus-dev/sdk`; any future `sagemaker_invoke_endpoint` / `sagemaker_predict` / `sagemaker_get_records` / `sagemaker_query` / `sagemaker_scan` tool fails CI. **Forbidden commands NEVER called:** `aws sagemaker-runtime invoke-endpoint` (inference) and anything that fetches training data / model-artifact bytes. The connector indexes model-REGISTRY metadata only — model name, ARN, container image reference, model-data S3 URL pointer, execution-role ARN, creation time; NO inference / training / artifact bytes (storing the `ModelDataUrl` s3:// URI string is metadata — a pointer, not the bytes). `external_id` = `ModelArn ?? ModelName`; title = `ModelName`; SageMaker `CreationTime` (ISO-8601 or epoch-SECONDS float) is parsed defensively via a LOCAL helper; `modifiedAt` = `creationTime ?? syncedAt`; `url`/`canonical_url` null (pure mapper). The `sagemaker:model` type stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — sparse structured metadata). Lazy-mesh spawn (`phase3AddSagemakerMcp`) rides the phase3 bundle, gated on AWS creds (so SageMaker appears whenever AWS does, like Athena/CloudWatch), `ServerSpec` routed through `wrapServerSpec` (I15); static sandbox manifest mirrors the aws exec/filesystem shape (execs `aws`) + the `sts.amazonaws.com` base host, with the regional `api.sagemaker.<region>.amazonaws.com` host added per-region at spawn via `manifestWithExtraNetworkHosts`. Three read tools (`sagemaker_list` / `sagemaker_get` / `sagemaker_search` — metadata only); `hitlRequired: []`. v1 indexes model-registry metadata only — training jobs, processing jobs, endpoints, experiments, and (Phase-6-deferred) the `ml.endpoint.update` / `ml.endpoint.delete` / `ml.job.stop` HITL writes are out of scope for the no-row-data tier by design.
- **Tier-3 connector — Elasticsearch / Kibana (index schema/metadata) — no row data** ✅ — Elasticsearch index schema/metadata (`elasticsearch:index`) from a self-hosted cluster or Elastic Cloud via the **Elasticsearch REST metadata endpoints** over `connectorFetch`: `GET <url>/_cat/indices?format=json&bytes=b` returns a JSON ARRAY of per-index metadata rows (`{ index, health, status, "docs.count", "store.size", pri, rep, uuid }`), page-capped `MAX_INDICES=500`, skipping ES system/hidden indices (names starting with `.`); then for each index (capped `MAX_INDEX_DETAIL=200`) `GET <url>/<index>/_mapping` returns `{ <index>: { mappings: { properties: { <field>: { type } } } } }`, flattened to a `fields: [{ name, type }]` list (nested `properties` flattened with dotted paths). Single forward pass per cycle, cursor `{ pass }` (`nimbus-es1:`). **Unlike the cloud Tier-3 connectors (BigQuery/Athena/CloudWatch/Cloud Logging) this is NOT cloud-cred-reuse and NOT CLI-shelling — Elasticsearch is a self-hosted / Elastic Cloud service with its OWN credentials + per-tenant host, accessed over REST** (the Dependency-Track per-tenant-host shape). Two **own** vault keys — a **non-secret** `elasticsearch.url` cluster root + a **secret** `elasticsearch.api_key` (sent as `Authorization: ApiKey <key>`) — both required: the sync handler noops (`syncNoopResult`) and the lazy-mesh spawn (`phase3AddElasticsearchMcp`) both no-op unless BOTH are present, so `CONNECTOR_VAULT_SECRET_KEYS.elasticsearch` is `["elasticsearch.url", "elasticsearch.api_key"]`. The static manifest `permissions.network` is empty and the parsed host is added to the sandbox network allow-list at spawn via `hostnameFromUrl` + `manifestWithExtraNetworkHosts("elasticsearch", [host])`, `ServerSpec` routed through `wrapServerSpec` directly (I15), injecting `ELASTICSEARCH_URL` + `ELASTICSEARCH_API_KEY`. **The no-row-data contract assertion** — the Elasticsearch MCP package's `test/no-row-data.test.ts` imports `ELASTICSEARCH_TOOL_NAMES` and calls `assertNoRowDataTools(tools, "elasticsearch")` from `@nimbus-dev/sdk`; `elasticsearch_search` is allowed (it searches index NAMES, a permitted `search` segment), while any future `elasticsearch_scan` / `elasticsearch_get_records` / `elasticsearch_query` / `elasticsearch_export` tool fails CI. **Forbidden endpoints NEVER called:** `_search`, `GET /<index>/_doc/<id>`, `_mget`, `_sql`, `_async_search`, `_pit`, `_scroll`, anything returning document SOURCE / `hits.hits._source` (the row data). The connector indexes INDEX metadata only — index name, health (green/yellow/red), status (open/close), document COUNT (a single integer), store size in bytes, primary-shard + replica counts, UUID, and field names+types from the mapping; NO document contents. `external_id` = the index `index` name (host-scoping intentionally omitted for simplicity — one Nimbus profile points at one cluster); title = index name; `_cat/indices` has no reliable mtime so `modifiedAt` = `syncedAt`; `url`/`canonical_url` null (pure mapper); the `_cat/indices` string-valued numeric columns are parsed defensively to numbers (null when absent). The `elasticsearch:index` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured schema metadata). Index path segments placed in URLs are `encodeURIComponent`-guarded (path-injection guard, the REST analog of the CLI arg guard) in both the MCP `elasticsearch_get` tool and the sync handler's `_mapping` walk. Three read tools (`elasticsearch_list` (indices metadata) / `elasticsearch_get` (one index's mapping/metadata) / `elasticsearch_search` (substring search over index NAMES — metadata, NOT document search)); `hitlRequired: []`. A per-index `_mapping` failure still upserts the index from its `_cat/indices` metadata (empty `fields`); a 401/429/parse error on the `_cat/indices` listing degrades gracefully (no throw past the Syncable boundary, cursor preserved). v1 indexes index metadata only — saved searches, dashboards, Watcher alerts, and document contents deferred (document contents are out of scope for the no-row-data tier by design).

### 2026-05-31

- **Tier-3 connector — GCP Cloud Logging (routing-sink metadata) — no row data** ✅ — GCP Cloud Logging log-routing SINK configuration metadata (`cloud_logging:sink`) via the **gcloud CLI's Cloud Logging metadata commands**: `gcloud logging sinks list --project <project> --format json` returns a JSON ARRAY (NOT token-paginated) of `[{ name, destination, filter, description, disabled, createTime, updateTime }]` — emit all entries in a single forward pass, page-capped `MAX_SINKS=500`, cursor `{ pass }` (`nimbus-gcplog1:`). **Reuses the GCP-side Tier-3 cred template proven by BigQuery** (the GCP sibling of AWS CloudWatch Logs): NO new vault key — reuses the EXISTING `gcp.credentials_json_path` + `gcp.project_id`, so `CONNECTOR_VAULT_SECRET_KEYS.cloud_logging` is `[]`. Unlike BigQuery (which mints a bearer token via `gcloud auth print-access-token` for REST calls), Cloud Logging shells the native `gcloud logging` CLI directly with `env: extensionProcessEnv({ GOOGLE_APPLICATION_CREDENTIALS: credPath })` — no token-mint needed. The gcloud runner is injectable (`runGcloud` option, dependency-injection for tests); a missing/failed gcloud spawn degrades gracefully (empty pass, cursor preserved, no throw past the Syncable boundary); a missing cred/project noops via `syncNoopResult`. **The no-row-data contract assertion** — the Cloud Logging MCP package's `test/no-row-data.test.ts` imports `CLOUD_LOGGING_TOOL_NAMES` and calls `assertNoRowDataTools(tools, "cloud_logging")` from `@nimbus-dev/sdk`; the `event`/`events`/`query`/`records` segments are denylisted, so any future `cloud_logging_get_events` / `cloud_logging_query` tool fails CI. **Forbidden commands NEVER called:** `gcloud logging read`, `gcloud logging entries list` — anything returning log ENTRIES / the actual log-line payloads (the row data). The connector indexes sink CONFIG metadata only — name, destination, filter expression, description, disabled flag, create/update timestamps; NO log entries. `external_id` = `<project>/<sinkName>`; title = sink `name`; gcloud timestamps are RFC3339 ISO strings parsed via a LOCAL `parseIsoMs`; `modifiedAt` = `updateTime ?? createTime ?? syncedAt`; `url`/`canonical_url` null (pure mapper); the row is skipped when the sink name is missing. The `cloud_logging:sink` type stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — sparse structured metadata). Lazy-mesh spawn (`phase3AddCloudLoggingMcp`) rides the phase3 bundle, gated on `gcp.credentials_json_path` (so Cloud Logging appears whenever GCP does, like BigQuery), injecting `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT`, `ServerSpec` routed through `wrapServerSpec` (I15); static sandbox manifest mirrors the bigquery gcp manifest's exec/filesystem shape (execs `gcloud`) plus network hosts `logging.googleapis.com` + `oauth2.googleapis.com` + `www.googleapis.com`. Three read tools (`cloud_logging_list` / `cloud_logging_get` / `cloud_logging_search` — metadata only, shelling `gcloud logging sinks list/describe`); `hitlRequired: []`. v1 indexes routing-sink metadata only — log names, metric definitions, and log entries deferred (log entries are out of scope for the no-row-data tier by design).
- **Tier-3 connector — BigQuery (datasets/tables metadata) — the no-row-data infra-prover** ✅ — Google BigQuery schema/metadata (`bigquery:table`) from a GCP project via the **BigQuery REST metadata API**: walk `GET https://bigquery.googleapis.com/bigquery/v2/projects/<project>/datasets?maxResults=100&pageToken=<token>` (reading `{ datasets: [{ datasetReference: { datasetId } }], nextPageToken }`), then per dataset `GET .../datasets/<datasetId>/tables?maxResults=100&pageToken=<token>` (`{ tables: [{ tableReference: { datasetId, tableId }, type, creationTime, … }], nextPageToken }`), enriching the first `MAX_TABLE_DETAIL=50` tables per dataset with `GET .../tables/<tableId>` for `schema.fields` (name+type only) and otherwise emitting from the list-response metadata. Page-capped (`MAX_DATASETS=100`, `MAX_TABLES_PER_DATASET=500`, `PAGE_SIZE=100`), single forward pass per cycle, cursor `{ pass }` (`nimbus-bq1:`). **This is the first Tier-3 "no-row-data" connector and the template the next six reuse.** Two things make Tier-3 distinct: (1) **cloud-credential REUSE** — BigQuery does NOT introduce a new vault key; it reuses the EXISTING `gcp.credentials_json_path` + `gcp.project_id` and authenticates by shelling `gcloud auth print-access-token` (with `GOOGLE_APPLICATION_CREDENTIALS` pointed at the service-account key) to mint a short-lived bearer token, then calls the REST metadata endpoints with `Authorization: Bearer` — no new `OAuthProvider`, no in-gateway crypto, and its `CONNECTOR_VAULT_SECRET_KEYS.bigquery` entry is `[]` (documented gcp-cred reuse). The gcloud token-mint is injectable (`mintAccessToken` option, dependency-injection over `mock.module` for tests); a missing/failed gcloud spawn degrades gracefully (empty pass, cursor preserved, no throw past the Syncable boundary). (2) **The no-row-data contract assertion** — the BigQuery MCP package's contract test (`test/no-row-data.test.ts`) imports the registered tool names (`BIGQUERY_TOOL_NAMES`) and calls `assertNoRowDataTools(tools, "bigquery")` from `@nimbus-dev/sdk` (added in a5a18267), proving the surface is metadata-only and locking it in — a future edit adding a `bigquery_query`/`bigquery_rows`/`bigquery_sample`/`bigquery_scan`/`bigquery_head`/`bigquery_export` tool fails CI. **Forbidden endpoints NEVER called:** `/queries`, `jobs.query`/`getQueryResults`, `tabledata.list`, anything returning row/cell values. The connector indexes table METADATA only — names, schema field names/types, row COUNTS (`numRows`, a single integer — metadata, not row data), byte sizes (`numBytes`), table type (TABLE/VIEW/EXTERNAL/MATERIALIZED_VIEW), and timestamps. `external_id` = `<project>:<datasetId>.<tableId>`; title = `<datasetId>.<tableId>` (or `<friendlyName> (<qualified>)`); BigQuery timestamps are epoch-MILLIS strings parsed via a LOCAL helper; `modifiedAt` = `lastModifiedTime ?? creationTime ?? syncedAt`; `url`/`canonical_url` null (pure mapper). The `bigquery:table` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured schema metadata). Lazy-mesh spawn (`phase3AddBigqueryMcp`) rides the phase3 bundle, gated on `gcp.credentials_json_path` (so BigQuery appears whenever GCP does), injecting `GOOGLE_APPLICATION_CREDENTIALS` + `BIGQUERY_PROJECT`, `ServerSpec` routed through `wrapServerSpec` (I15); static sandbox manifest mirrors the gcp manifest's exec/filesystem shape (execs `gcloud`) plus network hosts `bigquery.googleapis.com` + `oauth2.googleapis.com` + `www.googleapis.com`. Three read tools (`bigquery_list` / `bigquery_get` / `bigquery_search` — metadata only); `hitlRequired: []`. v1 indexes table metadata only — row data, query results, and routines/models deferred (out of scope for the no-row-data tier by design).
- **Tier-3 connector — AWS Athena (catalog/database/table metadata) — the AWS-side no-row-data infra-prover** ✅ — Amazon Athena schema/metadata (`athena:table`) via the **AWS CLI's Athena metadata commands**: walk `aws athena list-data-catalogs` (reading `{ DataCatalogsSummary: [{ CatalogName, Type }], NextToken }`), then per catalog `aws athena list-databases --catalog-name <c>` (`{ DatabaseList: [{ Name }], NextToken }`), then per database `aws athena list-table-metadata --catalog-name <c> --database-name <db>` (`{ TableMetadataList: [{ Name, TableType, Columns, PartitionKeys, Parameters, CreateTime, LastAccessTime }], NextToken }`). Page-capped (`MAX_CATALOGS=50`, `MAX_DATABASES_PER_CATALOG=200`, `MAX_TABLES_PER_DATABASE=500`, `PAGE_SIZE=50`), single forward pass per cycle, `NextToken` pagination, cursor `{ pass }` (`nimbus-athena1:`). **Athena is the AWS-side proof of the Tier-3 cloud-cred-reuse template** (BigQuery was the GCP side). Two Tier-3 distinctives: (1) **cloud-credential REUSE** — Athena introduces NO new vault key; it reuses the EXISTING `aws.access_key_id` + `aws.secret_access_key` + `aws.default_region`/`aws.profile` via a NEW shared `_lib/aws-cli.ts` helper (`awsCredentialsExtra` + `awsCliJson`, **extracted verbatim** from `aws-sync.ts` in a preceding refactor commit so SageMaker + CloudWatch can reuse it), which spawns `aws <args> --output json` with the scoped credential env (`extensionProcessEnv`, I1). Its `CONNECTOR_VAULT_SECRET_KEYS.athena` entry is `[]` (documented aws-cred reuse). The AWS-CLI runner is injectable (`runAwsCli` option, dependency-injection over `mock.module` for tests); a missing/failed `aws` spawn degrades gracefully (empty pass, cursor preserved, no throw past the Syncable boundary). (2) **The no-row-data contract assertion** — the Athena MCP package's contract test (`test/no-row-data.test.ts`) imports the registered tool names (`ATHENA_TOOL_NAMES`) and calls `assertNoRowDataTools(tools, "athena")` from `@nimbus-dev/sdk`, proving the surface is metadata-only and locking it in — a future edit adding an `athena_run_query`/`athena_get_query_results`/`athena_rows`/`athena_scan`/`athena_sample`/`athena_execution` tool fails CI. **Forbidden commands NEVER called:** `start-query-execution`, `get-query-results`, `get-query-execution`, `list-query-executions`, `get-named-query`, anything returning row/cell/query-result values. The connector indexes catalog/database/TABLE-metadata only — table names, table types, column names+types, partition keys, parameters, and timestamps. `external_id` = `<catalog>/<database>.<tableName>`; title = `<database>.<tableName>`; Athena timestamps (ISO-8601 or epoch-SECONDS) are parsed defensively via a LOCAL helper; `modifiedAt` = `lastAccessTime ?? createTime ?? syncedAt`; `url`/`canonical_url` null (pure mapper). The `athena:table` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured schema metadata). Lazy-mesh spawn (`phase3AddAthenaMcp`) rides the phase3 bundle, gated on AWS creds (so Athena appears whenever AWS does), injecting the `AWS_*` env, `ServerSpec` routed through `wrapServerSpec` (I15); static sandbox manifest mirrors the aws manifest's exec/filesystem shape (execs `aws`) plus the `sts.amazonaws.com` base host, with the regional `athena.<region>.amazonaws.com` host added per-region at spawn via `manifestWithExtraNetworkHosts` (the RFC-1123 host validator rejects the `athena.*.amazonaws.com` wildcard, same posture as Salesforce's per-tenant host). Three read tools (`athena_list` / `athena_get` / `athena_search` — metadata only); `hitlRequired: []`. v1 indexes catalog/database/table metadata only — query execution, query results, and saved-query bodies deferred (out of scope for the no-row-data tier by design).
- **Tier-3 connector — AWS CloudWatch Logs (log-group metadata) — no row data** ✅ — Amazon CloudWatch Logs log-GROUP metadata (`cloudwatch:log_group`) via the **AWS CLI's CloudWatch Logs metadata commands**: walk `aws logs describe-log-groups --limit 50` (reading `{ logGroups: [{ logGroupName, arn, creationTime, retentionInDays, storedBytes, metricFilterCount }], nextToken }`, `--next-token` pagination, page-capped `MAX_LOG_GROUPS=500` / `PAGE_SIZE=50`), and for each group a best-effort `aws logs describe-log-streams --log-group-name <g> --order-by LastEventTime --descending --limit 50` peek for a stream COUNT + the most-recent `lastEventTimestamp` (stream METADATA only — capped `MAX_STREAMS_PER_GROUP=50`); single forward pass per cycle, cursor `{ pass }` (`nimbus-cw1:`). **Reuses the AWS-side Tier-3 cred template proven by Athena**: NO new vault key — reuses the EXISTING `aws.access_key_id` + `aws.secret_access_key` + `aws.default_region`/`aws.profile` via the shared `_lib/aws-cli.ts` helper (`awsCredentialsExtra` + `awsCliJson`), so `CONNECTOR_VAULT_SECRET_KEYS.cloudwatch` is `[]`. The AWS-CLI runner is injectable (`runAwsCli` option, dependency-injection for tests); a missing/failed `aws` spawn degrades gracefully (empty pass, cursor preserved, no throw past the Syncable boundary); a stream-peek failure is best-effort (the group is still upserted with a zero stream count). **The no-row-data contract assertion** — the CloudWatch MCP package's `test/no-row-data.test.ts` imports `CLOUDWATCH_TOOL_NAMES` and calls `assertNoRowDataTools(tools, "cloudwatch")` from `@nimbus-dev/sdk`; the assertion's `ROW_DATA_TOOL_SEGMENTS` now also rejects the `event`/`events` segments, so any future `cloudwatch_get_log_events` / `cloudwatch_filter_log_events` tool fails CI. **Forbidden commands NEVER called:** `get-log-events`, `filter-log-events`, `start-query`, `get-query-results`, `tail`, `start-live-tail` — anything returning log-event MESSAGES (the row data). The connector indexes log-GROUP metadata only — name, ARN, retention, stored bytes, creation time, metric-filter count, and (optionally) a stream COUNT + last-event timestamp; NO event messages. `external_id` = `arn ?? logGroupName`; title = `logGroupName`; CloudWatch timestamps are epoch-MILLIS numbers parsed via a LOCAL helper; `modifiedAt` = `lastEventTimestamp ?? creationTime ?? syncedAt`; `url`/`canonical_url` null (pure mapper). The `cloudwatch:log_group` type stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — sparse structured metadata). Lazy-mesh spawn (`phase3AddCloudwatchMcp`) rides the phase3 bundle, gated on AWS creds (so CloudWatch appears whenever AWS does), `ServerSpec` routed through `wrapServerSpec` (I15); static sandbox manifest mirrors the aws exec/filesystem shape (execs `aws`) + the `sts.amazonaws.com` base host, with the regional `logs.<region>.amazonaws.com` host added per-region at spawn via `manifestWithExtraNetworkHosts`. Three read tools (`cloudwatch_list` / `cloudwatch_get` / `cloudwatch_search` — metadata only); `hitlRequired: []`. v1 indexes log-group metadata only — log-event contents, metric data points, alarms, and dashboards deferred (out of scope for the no-row-data tier; the sibling **GCP Cloud Logging** connector remains a Tier-3 follow-up).
- **Tier-2 connector — Google Meet (conference records)** ✅ — past meeting conference records (`google_meet:meeting`) from [Google Meet](https://meet.google.com/) via the **Google Meet REST API v2** `GET https://meet.googleapis.com/v2/conferenceRecords?pageSize=50&pageToken=<token>` (reading the `{ conferenceRecords: [{ name: "conferenceRecords/<id>", startTime, endTime, expireTime, space: "spaces/<id>" }], nextPageToken }` envelope and following `nextPageToken` until absent — one page per cycle, the google_photos cursor shape `{ v:1, pageToken }`); get-by-id is `GET /v2/conferenceRecords/{id}`. **Unlike every other Tier-2 connector, Google Meet is NOT an OAuth-registry provider — it extends the EXISTING `google` provider as a new google SUB-SERVICE** (alongside google_drive / gmail / google_photos), exactly the way those three coexist. So this delivery **touched ZERO OAuth-registry infrastructure**: no new `OAuthProvider` union member, no `case` added to the exhaustive `never`-switch in `connector-rpc-handlers/auth.ts`, no `oauthGoogleMeet*` in `config.ts`, no help const in `oauth-env-help-messages.ts`, no `google-meet-access-token.ts`. It reuses `getValidGoogleAccessToken(vault, "google_meet")`, the shared `google.oauth` + per-service `google_meet.oauth` vault keys (`google_meet` added to `GoogleConnectorOAuthServiceId`, `GOOGLE_SERVICE_VAULT_KEYS`, `ALL_GOOGLE_OAUTH_VAULT_KEYS`, `GOOGLE_CONNECTOR_SERVICES`), and the generic `connector.auth` OAuth surface (**no new Tauri `ALLOWED_METHODS` entry**). The OAuth **scope** `https://www.googleapis.com/auth/meetings.space.readonly` is declared as google_meet's `defaultScopes` in `connector-catalog.ts` (mirroring how google_photos declares its scopes). Token acquisition uses the shared `fetchGoogleJson(ctx, token, url, "Google Meet", { method: "GET" })` helper. **Lazy-mesh spawn rides in the existing single google bundle slot** (`LAZY_MESH.googleBundle`) — `ensureGoogleDriveMcp` gains `"google_meet"` in its `ids: GoogleConnectorOAuthServiceId[]` array plus a spawn branch (`mcpConnectorServerScript("google-meet")` with `env: extensionProcessEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: token })`, fixed host so no extra-host needed, routed through the local `wrap(...)` helper → `wrapServerSpec` (I15)); **no new keys.ts slot** because google_meet shares the bundle. Static sandbox manifest declares network host `meet.googleapis.com` (mirroring google_photos' `photoslibrary.googleapis.com`). `external_id` = the id segment of `name` (strip the `conferenceRecords/` collection prefix — the row is skipped when `name` is missing/empty). Conference records carry **no human-authored title**, so the pure mapper (`mapGoogleMeetRecordToItem`, a separate file like hubspot-deal-mapping) derives one as `Meeting <startTime ISO date>` (or `Meeting <id>` when startTime is absent); `modifiedAt` = `endTime ?? startTime ?? syncedAt` (ISO-8601 parsed to epoch-ms via a LOCAL `parseIsoMs`); `url`/`canonical_url` are null (conference records carry no productUrl and the pure mapper has no space meetingUri); metadata `{ name, space, startTime, endTime }`. The `google_meet:meeting` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured timestamps + ids, batch default to omit). Three read tools (`google_meet_list` / `google_meet_get` / `google_meet_search` — the last accepts the Meet API `filter` expression); `hitlRequired: []`. v1 indexes past conference records only — auto-generated transcripts, participant detail, and live/space metadata deferred.
- **Tier-2 connector — Salesforce (opportunities)** ✅ — CRM opportunities (`salesforce:opportunity`) from a [Salesforce](https://www.salesforce.com) org via the **SOQL query API**: `GET <instance_url>/services/data/v60.0/query?q=SELECT Id, Name, StageName, Amount, CloseDate, Probability, Type, IsClosed, IsWon, LastModifiedDate, CreatedDate FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 200`, following the `{ records, done, nextRecordsUrl?, totalSize }` envelope's `nextRecordsUrl` cursor (an absolute instance-relative path) until `done` — a single page-capped forward pass per cycle, `MAX_PAGES=20`, `PAGE_LIMIT=200`; cursor is `{ pass }`. `salesforce_get` fetches one opportunity by id (`GET .../sobjects/Opportunity/<id>`). Salesforce is the **10th `OAuthProvider`**; widening the registry union forced the exhaustive 4-file `never`-switch bundle to co-land (`oauth-registry.ts` descriptor + `connector-rpc-handlers/auth.ts` `case "salesforce"` + `config.ts` `oauthSalesforce*` knobs + `oauth-env-help-messages.ts` help text). **Salesforce is "forky": its API host is per-tenant.** The `instance_url` is **discovered at OAuth time** and returned in the token response — so this delivery first **additively extended the shared OAuth token blob** (`StoredOAuthTokens` / `PKCEResult` gain an optional `instanceUrl?: string`; `parseStoredOAuthTokens` captures it only when non-empty; `persistTokens` conditional-spreads it only when present, so the 9 existing providers' payloads stay byte-identical). **OAuth shape (PKCE + body-secret — like Canva's PKCE but with the body-secret placement of Miro/HubSpot/Figma):** authorization-code **WITH PKCE**, client id + secret **form-encoded into the token-exchange BODY** (`usesPkce: true`, `secretPlacement: "body"`, `bodyFormat: "form"`, `clientSecret: "required"`); authorize + token both at `https://login.salesforce.com/services/oauth2/{authorize,token}`; scopes `api` + `refresh_token`. A **custom `parseSalesforceTokenResponse`** (NOT `parseStandardTokenResponse`) **requires `instance_url`** (throws when absent — no silent fallback) and **synthesizes a conservative 30-minute expiry because Salesforce omits `expires_in`**, so the registry's 120 s-margin single-flight refresh renews the access token roughly every cycle via the long-lived refresh token (robust against short org session timeouts). Tokens + `instance_url` stored under `salesforce.oauth`; `getValidSalesforceAuth` returns `{ accessToken, instanceUrl }` (re-reads the freshly-persisted blob, requires the instance host). **No new Tauri `ALLOWED_METHODS` entry** — reuses the generic OAuth IPC surface (`connector.auth`). Lazy-mesh spawn (`ensureSalesforceMcp`) combines HubSpot's OAuth-read guard with **Jenkins's per-tenant extra-host pattern**: the discovered instance host is added to the sandbox manifest at spawn via `manifestWithExtraNetworkHosts("salesforce", [host])`, routed through `wrapServerSpec` **directly** (I15); the static manifest declares only `login.salesforce.com` (RFC-1123 host validation rejects `*.salesforce.com` wildcards, so the real per-tenant host must be added at spawn). `external_id` = the SF `Id` (`salesforce:<Id>`; the row is skipped when `Id` is missing/empty). Surfaces name / stage / amount / closeDate / probability / type / isClosed / isWon / lastModifiedDate / createdDate; SF timestamps parse ISO-8601 via a LOCAL `parseIsoMs`; `modifiedAt` = `LastModifiedDate ?? syncedAt`; title = `Name` (with a `Salesforce opportunity <id>` fallback); `url`/`canonical_url` are null (the pure mapper does not take the per-tenant instance host — same posture as HubSpot/Prefect). The `salesforce:opportunity` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured pipeline metadata, batch default to omit). Three read tools (`salesforce_list` / `salesforce_get` / `salesforce_search` — first-page substring match over name / stage / type); `hitlRequired: []`. A 401 / 429 / parse error on the first SOQL query degrades gracefully (no throw, incoming cursor preserved); a mid-walk error keeps the already-upserted page. v1 indexes Opportunities only — other sObjects (Accounts / Leads / Cases), SOSL full-text, and write tools deferred.
- **Tier-2 connector — Figma (files)** ✅ — design files (`figma:file`) for a single configured team from a [Figma](https://www.figma.com) account via a **two-level fetch**: `GET https://api.figma.com/v1/teams/<figma.team_id>/projects` (reading `{ name, projects: [{ id, name }] }`) then, for each project, `GET https://api.figma.com/v1/projects/<project_id>/files` (reading `{ name, files: [{ key, name, thumbnail_url, last_modified }] }`), flattening every file across every project into one stream (each tagged with its project name). Neither endpoint paginates with a cursor — both return the full list — so the gateway-side syncable walks a single forward pass per cycle bounded by defensive `MAX_PROJECTS=200` / `MAX_FILES=2000` caps; cursor is `{ pass }`. `figma_get` lists one project's files by id (`GET /v1/projects/{projectId}/files`). Figma is the **9th `OAuthProvider`**; widening the registry union forced the exhaustive 4-file `never`-switch bundle to co-land in one commit (`oauth-registry.ts` descriptor + `connector-rpc-handlers/auth.ts` `case "figma"` + `config.ts` `oauthFigma*` knobs + `oauth-env-help-messages.ts` help text). **OAuth shape (mirrors Miro/HubSpot — distinct from Zoom/Canva's PKCE + Basic-header):** the standard authorization-code flow (NOT PKCE) with the client id + client secret **form-encoded into the token-exchange BODY** (`secretPlacement: "body"`, `bodyFormat: "form"`, `clientSecret: "required"`); authorize `https://www.figma.com/oauth`, token `https://api.figma.com/v1/oauth/token`; scope `files:read` (read-only, minimal). Tokens stored under the `figma.oauth` vault key; the short-lived access token is refreshed by the single-flight `getValidVaultAccessToken` registry lock (`getValidFigmaAccessToken` helper). **Second non-secret key (the Stack Overflow `stackoverflow.team` pattern):** Figma needs BOTH `figma.oauth` AND a non-secret `figma.team_id` selecting which team's files to index — both are listed in `CONNECTOR_VAULT_SECRET_KEYS.figma` (`["figma.oauth", "figma.team_id"]`), both must be present for spawn (`ensureFigmaMcp` + `ensureFigmaIfVaultCreds` require ALL keys) and for sync (the syncable noops when either is absent), and both are injected at spawn time (`FIGMA_TOKEN` + `FIGMA_TEAM_ID`). **No new Tauri `ALLOWED_METHODS` entry** — Figma reuses the existing generic OAuth IPC surface (`connector.auth`), exactly as Miro/Canva/HubSpot/Zoom did. Lazy-mesh spawn (`ensureFigmaMcp`, the dedicated-spawn pattern — NOT the phase3 client-cred bundle), `ServerSpec` routed through `wrapServerSpec` (I15); fixed SaaS host `api.figma.com` in the static sandbox manifest. `external_id` = the file `key` (a stable Figma-supplied string — the row is skipped when `key` is missing/empty). Surfaces name / project_name / thumbnail_url / last_modified; `last_modified` parses ISO-8601 via a LOCAL `parseIsoMs`; `modifiedAt` = `last_modified ?? syncedAt`; title = the file `name` (with a `Figma file <key>` fallback); `url`/`canonical_url` = `https://www.figma.com/file/<key>` (constructed from the stable key). The `figma:file` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — short file-name labels, sparse structured metadata, batch default to omit). Three read tools (`figma_list` / `figma_get` / `figma_search` — substring match over file name + project name across the flattened team files); `hitlRequired: []`. A failing per-project files call is skipped (partial coverage beats none); a 429 / 401 / parse error on the team-projects call degrades gracefully (no throw, incoming cursor preserved). v1 indexes a **single configured team's files** — multi-team, file nodes (frames / components), comments, and version history deferred.
- **Tier-2 connector — Miro (boards)** ✅ — whiteboard boards (`miro:board`) from a [Miro](https://miro.com) account via `GET https://api.miro.com/v2/boards?limit=50&cursor=<cursor>` (reading the `{ data: [...], cursor?, total, size }` **envelope** and following the top-level `cursor` opaque **cursor** query param until absent — a single page-capped forward pass per cycle, `MAX_PAGES=20`, `PAGE_SIZE=50`); get-by-id is `GET /v2/boards/{boardId}`. Miro is the **7th `OAuthProvider`**; widening the registry union forced the exhaustive 4-file `never`-switch bundle to co-land in one commit (`oauth-registry.ts` descriptor + `connector-rpc-handlers/auth.ts` `case "miro"` + `config.ts` `oauthMiro*` knobs + `oauth-env-help-messages.ts` help text). **OAuth shape (mirrors HubSpot — distinct from Zoom's PKCE + Basic-header):** the standard authorization-code flow (NOT PKCE) with the client id + client secret **form-encoded into the token-exchange BODY** (`secretPlacement: "body"`, `bodyFormat: "form"`, `clientSecret: "required"`); authorize `https://miro.com/oauth/authorize`, token `https://api.miro.com/v1/oauth/token`; scope `boards:read` (read-only, minimal). Tokens stored under the `miro.oauth` vault key; the short-lived access token is refreshed by the single-flight `getValidVaultAccessToken` registry lock (`getValidMiroAccessToken` helper). **No new Tauri `ALLOWED_METHODS` entry** — Miro reuses the existing generic OAuth IPC surface (`connector.auth`), exactly as HubSpot/Zoom did. Lazy-mesh spawn (`ensureMiroMcp`, HubSpot's dedicated-spawn pattern — NOT the phase3 client-cred bundle) gated on a valid `miro.oauth` access token, `ServerSpec` routed through `wrapServerSpec` (I15); fixed SaaS host `api.miro.com` in the static sandbox manifest. `external_id` = the board `id` (a stable Miro-supplied string — the row is skipped when `id` is missing/empty). Surfaces name / description / owner_name (nested `owner.name`) / createdAt / modifiedAt / viewLink; the date fields parse ISO-8601 via a LOCAL `parseIsoMs`; `modifiedAt` = `modifiedAt ?? createdAt ?? syncedAt`; title = `name` (with a `Miro board <id>` fallback); `url`/`canonical_url` = the board `viewLink` (null when absent). The `miro:board` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured board metadata, batch default to omit). Three read tools (`miro_list` / `miro_get` / `miro_search` — first-page substring match over board name / description / owner name); `hitlRequired: []`. v1 indexes boards only — items (cards / sticky notes / shapes) and comments deferred.
- **Tier-2 connector — Canva (designs)** ✅ — designs (`canva:design`) from a [Canva](https://www.canva.com) account via `GET https://api.canva.com/rest/v1/designs?continuation=<token>` (reading the `{ items: [...], continuation? }` **envelope** and following the top-level `continuation` opaque **cursor** query param until absent — a single page-capped forward pass per cycle, `MAX_PAGES=20`); get-by-id is `GET /rest/v1/designs/{designId}`. Canva is the **8th `OAuthProvider`**; widening the registry union forced the exhaustive 4-file `never`-switch bundle to co-land in one commit (`oauth-registry.ts` descriptor + `connector-rpc-handlers/auth.ts` `case "canva"` + `config.ts` `oauthCanva*` knobs + `oauth-env-help-messages.ts` help text). **OAuth shape (mirrors Zoom — PKCE + Basic-header, distinct from Miro/HubSpot's body-secret):** the authorization-code flow **WITH PKCE**, with the client authenticated at the token endpoint via an HTTP **Basic** header (`base64(client_id:client_secret)`) alongside the PKCE `code_verifier` (`usesPkce: true`, `secretPlacement: "basic_header"`, `bodyFormat: "form"`, `clientSecret: "required"`); authorize `https://www.canva.com/api/oauth/authorize`, token `https://api.canva.com/rest/v1/oauth/token`; scope `design:meta:read` (read-only, minimal). No `postToken` plumbing change was needed — Zoom already exercises the `basic_header` + PKCE path. Tokens stored under the `canva.oauth` vault key; the short-lived access token is refreshed by the single-flight `getValidVaultAccessToken` registry lock (`getValidCanvaAccessToken` helper). **No new Tauri `ALLOWED_METHODS` entry** — Canva reuses the existing generic OAuth IPC surface (`connector.auth`), exactly as Miro/HubSpot/Zoom did. Lazy-mesh spawn (`ensureCanvaMcp`, the dedicated-spawn pattern — NOT the phase3 client-cred bundle) gated on a valid `canva.oauth` access token, `ServerSpec` routed through `wrapServerSpec` (I15); fixed SaaS host `api.canva.com` in the static sandbox manifest. `external_id` = the design `id` (a stable Canva-supplied string — the row is skipped when `id` is missing/empty). Surfaces title / created_at / updated_at / edit_url / view_url / thumbnail_url; the timestamps are Unix epoch **seconds** converted to epoch-ms via a LOCAL `parseCanvaTimestampMs` (tolerates ISO-8601 strings defensively); `modifiedAt` = `updated_at ?? created_at ?? syncedAt`; title = the design `title` (with a `Canva design <id>` fallback); `url`/`canonical_url` = the design `view_url` (falls back to `edit_url`, then null). The `canva:design` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured design metadata, batch default to omit). Three read tools (`canva_list` / `canva_get` / `canva_search` — first-page substring match over the design title); `hitlRequired: []`. v1 indexes designs only — folders and shared projects deferred.
- **Tier-2 connector — HubSpot (CRM deals) — first Tier-2 OAuth infra-prover** ✅ — CRM deals (`hubspot:deal`) from a [HubSpot](https://www.hubspot.com) portal via `GET https://api.hubapi.com/crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage,pipeline,closedate,createdate,hs_lastmodifieddate` (reading the `{ results: [...], paging?: { next?: { after } } }` **envelope** and following the `paging.next.after` opaque **cursor** until absent — a single page-capped forward pass per cycle, `MAX_PAGES=20`, `PAGE_SIZE=100`); get-by-id is `GET /crm/v3/objects/deals/{dealId}?properties=…`. **This is the first Tier-2 connector and the OAuth infra-prover** — it exercises the 3-legged OAuth authorization-code path that the remaining Tier-2 connectors (Salesforce / Google Meet / Loom / Figma / Miro / Canva) will reuse. HubSpot is the **6th `OAuthProvider`**; widening the registry union forced the exhaustive 4-file `never`-switch bundle to co-land in one commit (`oauth-registry.ts` descriptor + `connector-rpc-handlers/auth.ts` `case "hubspot"` + `config.ts` `oauthHubspot*` knobs + `oauth-env-help-messages.ts` help text). **OAuth shape (distinct from Zoom's PKCE + Basic-header):** the standard authorization-code flow (NOT PKCE) with the client id + client secret **form-encoded into the token-exchange BODY** (`secretPlacement: "body"`, `bodyFormat: "form"`, `clientSecret: "required"`); authorize `https://app.hubspot.com/oauth/authorize`, token `https://api.hubapi.com/oauth/v1/token`; scopes `crm.objects.deals.read` + `oauth` (read-only, minimal). Tokens stored under the `hubspot.oauth` vault key; the short-lived access token is refreshed by the single-flight `getValidVaultAccessToken` registry lock (mirrors Zoom's `getValidHubspotAccessToken` helper). **No new Tauri `ALLOWED_METHODS` entry** — HubSpot reuses the existing generic OAuth IPC surface (`connector.auth`), exactly as Zoom did. Lazy-mesh spawn (`ensureHubspotMcp`, Zoom's dedicated-spawn pattern — NOT the phase3 client-cred bundle) gated on a valid `hubspot.oauth` access token, `ServerSpec` routed through `wrapServerSpec` (I15); fixed SaaS host `api.hubapi.com` in the static sandbox manifest. `external_id` = the deal `id` (a stable HubSpot-supplied string — the row is skipped when `id` is missing/empty). Surfaces dealname / amount / dealstage / pipeline / closedate / createdate / hs_lastmodifieddate; the date properties parse BOTH ISO-8601 and epoch-millisecond string encodings via a LOCAL `parseHubspotMs`; `modifiedAt` = `hs_lastmodifieddate ?? envelope updatedAt ?? syncedAt`; title = `dealname` (with a `HubSpot deal <id>` fallback); `url`/`canonical_url` are always null (HubSpot deal permalinks require a portal id the API does not return generically — same posture as Ramp/Prefect). The `hubspot:deal` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured pipeline/spend metadata, batch default to omit). Three read tools (`hubspot_list` / `hubspot_get` / `hubspot_search` — first-page substring match over deal name / stage / pipeline); `hitlRequired: []`. v1 indexes deals only — companies / contacts / tickets / activities deferred.
- **Tier-1 connector — Apache Airflow (data orchestration)** ✅ — orchestration DAGs (`airflow:dag`) from a self-hosted [Apache Airflow](https://airflow.apache.org/) instance via the stable REST API v1 `GET /api/v1/dags?limit=100&offset=<n>` (reading the `{ dags: [...], total_entries: <int> }` **envelope** — the `dags` array of DAG objects with the `total_entries` total in the BODY; advancing `offset` by 100 while `offset + dags.length < total_entries` and the page is full, stopping on a short page / boundary / `MAX_PAGES=20`); get-by-id is `GET /api/v1/dags/{dag_id}`. **Per-tenant-host + HTTP Basic auth (the Dependency-Track host shape + the bitbucket/jenkins inline-Basic shape):** the gateway sync handler builds the `Authorization: Basic base64(username:password)` header INLINE (it cannot import the mcp-shared `encodeBasicAuthHeader` across the package boundary); the MCP server reuses the shared `encodeBasicAuthHeader`. Three vault keys — a **non-secret** `airflow.base_url` host root + two **secret** keys `airflow.username` + `airflow.password` — the sync handler and the lazy-mesh spawn (`phase3AddAirflowMcp`) both no-op unless ALL THREE are present; the static manifest `permissions.network` is empty and the parsed host is added to the sandbox network allow-list at spawn time via `hostnameFromUrl` + `manifestWithExtraNetworkHosts`. `external_id` = the `dag_id` (a stable Airflow-supplied string, NOT a generated UUID — the row is skipped when `dag_id` is missing/empty). Surfaces `is_paused` / `is_active` (true only when literally `true`) / owners (string array) / description / `schedule_interval` (the human-readable `value` field of Airflow's `{ __type, value }` shape, else null) / tags (from each `{name}` entry) / `fileloc` / `next_dagrun` / `last_parsed_time` for orchestration questions ("which DAGs are paused?", "what's the nightly ETL schedule?"); `next_dagrun` and `last_parsed_time` are ISO-8601 strings parsed to epoch-ms via a LOCAL `parseIsoMs` (NOT verbatim); `canonical_url`/`url` = `<base_url>/dags/<dag_id>/grid` via `ctx.baseUrl`; `modifiedAt` = `last_parsed_time ?? syncedAt`; title = `<dag_id> — <description>` (200-char `…` truncation) with a dag_id-only fallback; the `airflow:dag` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured metadata, batch default to omit). Three read tools (`airflow_list` / `airflow_get` / `airflow_search`); `hitlRequired: []`. First of the **Airflow / Prefect / Dagster** orchestrator bundle — Prefect + Dagster pending, so the roadmap bundle row stays unchecked. **Pagination note:** unlike the bare-array siblings, Airflow's list endpoint returns `total_entries` in the response body, so the offset walk uses that count for an exact stop condition (cleaner than the header-based `X-Total-Count` siblings, which `connectorFetch` cannot expose). v1 indexes DAG definitions only — individual DAG runs / task instances / logs deferred.
- **Tier-1 connector — Prefect (data orchestration)** ✅ — orchestration deployments (`prefect:deployment`) from a [Prefect](https://www.prefect.io/) Cloud workspace or a self-hosted Prefect Server via `POST <api_url>/deployments/filter` with a JSON body `{ limit: 100, offset: <n>, sort: "CREATED_DESC" }` (Prefect's list endpoints are **POST-with-body filters**, not GET query-string endpoints — the response is a **bare JSON array** of deployment objects, so the connector walks a single forward offset pass per cycle, advancing `offset` by 100 while a full page comes back, stopping on a short/empty page / `MAX_PAGES=20`); get-by-id is `GET <api_url>/deployments/{id}`. **Per-tenant-host + Bearer auth (the Dependency-Track host shape):** the per-tenant **workspace API root** (`prefect.api_url`) is non-universal — Prefect Cloud is `https://api.prefect.cloud/api/accounts/<account_id>/workspaces/<workspace_id>`, self-hosted Prefect Server is `http://<host>:4200/api` — modeled as a single **non-secret** `prefect.api_url` key + a **secret** `prefect.api_key` (sent as `Authorization: Bearer <key>`); both keys are treated as required for spawn/sync to keep the wiring uniform (a keyless self-hosted Server still gets a placeholder key), and the sync handler + lazy-mesh spawn (`phase3AddPrefectMcp`) both no-op unless BOTH are present. The static manifest `permissions.network` is empty and the parsed host is added to the sandbox network allow-list at spawn time via `hostnameFromUrl` + `manifestWithExtraNetworkHosts`. The gateway syncable builds the Bearer header inline; the MCP server omits the header when the key is empty (keyless self-hosted Server). `external_id` = the deployment `id` (a stable Prefect-supplied UUID string, NOT a freshly generated UUID — the row is skipped when `id` is missing/empty). Surfaces name / flow_id / description / tags (bare string array) / paused (true only when literally `true`) / work_pool_name / work_queue_name / schedule (the `schedules` array or older single `schedule` object, JSON-stringified, else null) / status / created / updated for orchestration questions ("which deployments are paused?", "what's the nightly flow schedule?"); `created` and `updated` are ISO-8601 strings parsed to epoch-ms via a LOCAL `parseIsoMs` (NOT verbatim); `modifiedAt` = `updated ?? created ?? syncedAt`; title = `<name> — <description>` (200-char `…` truncation) with a name-only then id fallback; `canonical_url`/`url` are always null (Prefect exposes no clean deployment permalink derivable from the API root generically — same posture as Ramp); the `prefect:deployment` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured metadata, batch default to omit). Three read tools (`prefect_list` / `prefect_get` / `prefect_search`); `hitlRequired: []`. Second of the **Airflow / Prefect / Dagster** orchestrator bundle — Dagster still pending, so the roadmap bundle row stays unchecked. **POST-filter note:** the POST-body list endpoint is the established `connectorFetch` `init.method/headers/body` shape (the Ramp token-exchange pattern). v1 indexes deployments only — individual flow runs / task runs / logs deferred.
- **Tier-1 connector — Dagster (data orchestration)** ✅ — orchestration jobs (`dagster:job`) from a [Dagster](https://dagster.io/) Cloud deployment or a self-hosted Dagster OSS instance via a single **GraphQL** query (`POST <base_url>/graphql` with a `{ query }` body) walking the repositories→jobs catalog `repositoriesOrError { ... on RepositoryConnection { nodes { name location { name } pipelines { id name description isJob tags { key value } } } } ... on PythonError { message } }`, flattening `data.repositoriesOrError.nodes[].pipelines[]` into jobs and capturing each job's repository + code-location name. **The repositories query returns the full repo+job catalog in one response (NOT cursor-paginated) → a single forward pass per cycle**, with a defensive `MAX_JOBS=2000` cap on the flattened job count (mirroring the sibling page caps). **GraphQL error handling mirrors Wiz precisely:** an HTTP 200 carrying a top-level `errors` array is NOT success — it is downgraded to a `parse_error` (graceful degrade, cursor preserved, no throw); likewise a `repositoriesOrError.__typename === "PythonError"` resolves to an empty job list rather than a throw. **Per-tenant-host + token-header auth (the Dependency-Track host shape):** Dagster has no universal SaaS host — Dagster Cloud is `https://<org>.dagster.cloud/<deployment>`, self-hosted OSS is e.g. `http://localhost:3000` — modeled as a single **non-secret** `dagster.base_url` host root + a **secret** `dagster.api_token` (sent as the `Dagster-Cloud-Api-Token` header); both keys are treated as required for spawn/sync to keep the wiring uniform (unauthenticated self-hosted OSS users set any non-empty placeholder token — documented in the README), and the sync handler + lazy-mesh spawn (`phase3AddDagsterMcp`) both no-op unless BOTH are present. The static manifest `permissions.network` is empty and the parsed host is added to the sandbox network allow-list at spawn time via `hostnameFromUrl` + `manifestWithExtraNetworkHosts`. **`external_id` = the stable, human-readable `<location>:<repository>:<jobName>` triple — NOT the opaque base64 `id`, which can change across redeploys** (a `_` placeholder stands in for a null location; the row is skipped when name or repository is empty). Surfaces name / repository / location / description / `is_job` (true only when literally `true`) / tags (the `{ key, value }` pairs, flattened to `key=value` strings plus a `tag_keys` array) for orchestration questions ("which jobs live in the analytics repository?", "what tags does the nightly job carry?"); `canonical_url`/`url` = `<base_url>/locations/<location>/jobs/<jobName>` via `ctx.baseUrl` (best-effort — null when the location is null or the base URL is unparseable); `modifiedAt` = `syncedAt` (the catalog exposes no per-job timestamp); title = `<name> — <description>` (200-char `…` truncation) with a name-only fallback; the `dagster:job` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured metadata, batch default to omit). Three read tools (`dagster_list` / `dagster_get` (by the `<location>:<repository>:<jobName>` triple or bare `jobName`) / `dagster_search`); `hitlRequired: []`. **GraphQL note:** the `{ query }` POST body + 200-with-`errors` handling is the established Wiz GraphQL shape via `connectorFetch` `init.method/headers/body`. **Last of the Airflow / Prefect / Dagster orchestrator bundle — with Dagster delivered, all three orchestrators are now indexed and the roadmap bundle row is checked.** v1 indexes jobs only — individual runs / assets / logs deferred.
- **Tier-1 connector — Ramp (corporate-card spend)** ✅ — card transactions (`ramp:transaction`) from [Ramp](https://ramp.com) via `GET https://api.ramp.com/developer/v1/transactions?page_size=100` (reading the `.data` array of transaction objects and following the `page.next` **cursor** — a full URL to the next page, or null/absent at the end — for a single forward pass per cycle, `MAX_PAGES=20`); get-by-id is `GET /developer/v1/transactions/{id}`. **OAuth2 client-credentials auth (a token exchange, NOT 3-legged user consent — the Superset login shape):** the connector exchanges its client id + client secret for a bearer token at `POST /developer/v1/token` (HTTP **Basic** auth `client_id:client_secret`, `Content-Type: application/x-www-form-urlencoded` body `grant_type=client_credentials&scope=transactions:read`) and caches the token (per process in the MCP server; per sync cycle in the gateway syncable), then calls the data endpoints with `Authorization: Bearer`. On a mid-cycle `401` the gateway syncable **re-exchanges the token once** and retries the same page. The sync handler and the lazy-mesh spawn (`phase3AddRampMcp`) both no-op unless BOTH credentials are present. Two required **secret** vault keys `ramp.client_id` + `ramp.client_secret`; fixed SaaS host `api.ramp.com` (static sandbox network `permissions.network: ["api.ramp.com"]` — no host override). `external_id` = the transaction `id` (a stable Ramp-supplied string, NOT a generated UUID — the row is skipped when `id` is missing/empty). Surfaces amount + `currency_code`, `merchant_name`, the card holder's display name (`card_holder.first_name`/`last_name`) and `department_name`, `state`, the spend category (`sk_category_name`), `user_transaction_time`, and a truncated memo (500 chars). `user_transaction_time` is an ISO-8601 string parsed to epoch-ms via a LOCAL `parseIsoMs` (NOT verbatim, NOT epoch seconds); `modifiedAt` = `user_transaction_time ?? syncedAt`; title is synthesized as `<merchant_name> — <amount> <currency>` with a `Ramp transaction — <amount>` then bare `Ramp transaction` fallback; `url`/`canonical_url` are always null (the Ramp API surfaces no transaction permalink). **No full card numbers / PANs are surfaced** — Ramp's API does not return them and only the safe fields above are mapped. The `ramp:transaction` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured spend metadata, batch default to omit). Three read tools (`ramp_list` / `ramp_get` / `ramp_search`); `hitlRequired: []`. v1 indexes card transactions only — receipts / budgets / vendor spend rollups deferred.
- **Tier-1 connector — Dependency-Track (SBOM/supply-chain)** ✅ — software-supply-chain projects (`dependencytrack:project`) from a self-hosted [OWASP Dependency-Track](https://dependencytrack.org/) instance via `GET /api/v1/project?pageSize=100&pageNumber=<n>&excludeInactive=false` (reading a **bare JSON array** of project objects, incrementing `pageNumber` 1-based while a full 100-row page comes back, stopping on a short/empty page, `MAX_PAGES=20`); get-by-id is `GET /api/v1/project/{uuid}`. **Per-tenant-host auth (the Metabase/ArgoCD shape):** `X-Api-Key: <key>` header (the secret) + a **non-secret** `dependencytrack.base_url` host root — the sync handler and the lazy-mesh spawn (`phase3AddDependencytrackMcp`) both no-op unless BOTH are present; the static manifest `permissions.network` is empty and the parsed host is added to the sandbox network allow-list at spawn time via `hostnameFromUrl` + `manifestWithExtraNetworkHosts`. Two required vault keys `dependencytrack.base_url` (non-secret) + `dependencytrack.api_key` (secret). `external_id` = the project `uuid` (a stable string supplied by Dependency-Track, NOT a generated UUID — the row is skipped when `uuid` is missing/empty). Surfaces name / version / classifier / active flag / `lastBomImport` (kept verbatim as epoch-ms) / tags (from each `{name}` entry) plus the embedded `metrics` vulnerability counts (critical / high / medium / low / total vulnerabilities / components) for supply-chain questions ("which projects have critical vulnerabilities?"); `canonical_url`/`url` = `<base_url>/projects/<uuid>` via `ctx.baseUrl`; `modifiedAt` = `lastBomImport ?? syncedAt`; title = `<name> <version>` (200-char `…` truncation) with a name-only fallback; the `dependencytrack:project` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured metadata, batch default to omit). Three read tools (`dependencytrack_list` / `dependencytrack_get` / `dependencytrack_search`); `hitlRequired: []`. **Pagination deviation:** Dependency-Track returns an `X-Total-Count` header for exact pagination, but the shared `connectorFetch` helper exposes only the parsed body + byte count (no response headers); the connector uses the established page-number forward walk with short-page / `MAX_PAGES` termination and a `{ pass }` cursor (mirroring Zotero/Metabase) rather than introducing a header-exposing fetch helper. v1 indexes projects only — individual findings / components deferred.
- **Tier-1 connector — Zotero** ✅ — bibliographic references (`zotero:reference`) via the Zotero Web API v3 (`GET /<library>/items?format=json&limit=100&start=N&sort=dateModified&direction=desc`, reading a **bare JSON array** of item objects, incrementing the `start` offset by 100 while a full page comes back, stopping on a short/empty page, `MAX_PAGES=20`); get-by-id is `GET /<library>/items/{key}`. **Two-identifier auth (the Stack Overflow shape):** the `Zotero-API-Key: <key>` header (the secret) + `Zotero-API-Version: 3` header, plus a **non-secret** `zotero.library` spec of the form `users/<id>` or `groups/<id>` URL-encoded into the request PATH — the sync handler and the lazy-mesh spawn both no-op unless BOTH the secret key and the library spec are present. Two required vault keys `zotero.api_key` (secret) + `zotero.library` (non-secret); fixed SaaS host `api.zotero.org` (static sandbox network — no host override). `external_id` = the Zotero item `key` (a stable string, NOT a UUID, NOT numeric — the row is skipped when `key` is missing/empty); items whose `data.itemType` is `attachment` or `note` are skipped (top-level bibliographic references only). Surfaces the title / formatted creator list / publication date / item type / tags / collections / DOI / source URL / truncated abstract (500 chars) / publication title for research questions. `dateModified` / `dateAdded` are ISO-8601 strings parsed to epoch-ms via a LOCAL `parseIsoMs` (NOT verbatim, NOT epoch seconds); `modifiedAt` = dateModified ?? dateAdded ?? syncedAt; title = the trimmed `data.title` (120-char `…` truncation) with a `<itemType> <key>` then `Reference <key>` fallback; `canonical_url`/`url` = the item's `data.url` (null when missing/empty); `creators` tolerate both the `firstName`/`lastName` and single-field `name` (institution) shapes; the `zotero:reference` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — abstracts are short and the batch default is to omit, avoiding surprise OpenAI spend for hybrid-mode users); three read tools (`zotero_list` / `zotero_get` / `zotero_search`); `hitlRequired: []`. **Incremental-cursor deviation:** the Zotero API exposes a `Last-Modified-Version` response header + `?since=<version>` incremental cursor and a `Total-Results` header for exact pagination, but the shared `connectorFetch` helper returns only the parsed JSON body + byte count (no response headers); to stay faithful to the proven simple-REST template the connector uses the established single-forward-pass offset walk with empty-page / `MAX_PAGES` termination and a `{ pass }` cursor (mirroring Lever / Stack Overflow) rather than introducing a header-exposing fetch helper — `since`-based incremental sync is a documented follow-up. v1 top-level bibliographic references only — attachments / notes / per-collection filtering deferred.

### 2026-05-29

- **Tier-1 connector — Zoom (PR-3 cloud recordings + AI transcripts)** ✅ — cloud-recording transcripts (`zoom:transcript`, prose-heavy) via `GET /v2/users/me/recordings` (token-paginated, ≤1-month-windowed walk; `MAX_PAGES=20`, `PAGE_SIZE=100`); cursor widened to `{ pass: 1, lastRecordingsTo: ISO-8601 }` (same `nimbus-zoom1:` prefix, backward-compatible decode — old `{ pass: 1 }` cursors decode `lastRecordingsTo = null` and do a 30-day initial backfill); skip-if-exists check on `<meeting_uuid>:<recording_file_id>` exploits transcript immutability so the 429-graceful-break replay path stays cheap; parent-meeting upsert dedupes past recorded meetings (missed by Walk A's `type=scheduled` filter) under the same `external_id = String(<meeting_id>)`; `download_url` fetches use an `Authorization: Bearer` header ONLY (raw fetch, not `connectorFetch`, because the latter logs the URL on failure) — the token never appears in a logged URL; pure `vttToPlainText` strips the WEBVTT header / `Kind:`/`Language:`/`NOTE`/`STYLE` blocks / cue-index lines / `-->` timestamp lines and inline VTT tags via a **narrowed allowlist** regex (covers `<v Speaker>` voice tags incl. multi-word names, `<b>`/`<i>`/`<u>`/`<c.foo>` styling, `<lang>`/`<ruby>`/`<rt>`, karaoke `<HH:MM:SS.mmm>` timing) so literal angle-bracket speech (e.g. discussing the `<div>` tag on a call) is preserved verbatim, and merges multi-line cues; `bodyPreview` clips at a word boundary + `…` (hard-clip fallback for one-long-word input); `zoom:transcript` joins `PROSE_HEAVY_TYPES` (16 entries total) so hybrid-mode embeds it on OpenAI text-embedding-3-small (1536-dim), with the MiniLM-only fallback when `openai.api_key` is absent; two new MCP tools `zoom_recordings_list` (windowed recordings list; validates `(to - from) <= 31 days` in-handler before the call) + `zoom_transcript_get` (per-meeting recording inventory) on the same fixed `api.zoom.us` sandbox host — the MCP server does NOT refetch + parse VTT (that work lives in the gateway-side syncable, where the rate limiter + skip-if-exists live); same OAuth grant as PR-2 (no re-consent — `cloud_recording:read:list_user_recordings` was requested up-front); no new vault key, migration, env-var knob, D11 entry, sandbox host, or `ConnectorServiceId`; `hitlRequired: []`.

### 2026-05-28

- **Coverage floor Phase 8 — closeout** ✅ (PR #445) — CLI deep cuts; per-file coverage baseline 10 → **0** entries. The coverage-floor multi-phase initiative is complete: every bun-tested workspace file now meets or exceeds the 80% line-coverage floor.
- **VS Code extension typecheck CI fix** ✅ (PR #446) — `packages/vscode-extension/tsconfig.json` pinned to `types: ["node"]` so the root `@types/bun` no longer conflicts with `@types/node` during workspace typecheck.
- **Tier-1 connector — Zoom** ✅ — scheduled meeting metadata (`zoom:meeting`) via `GET /v2/users/me/meetings?type=scheduled` (next-page-token walk, `MAX_PAGES=20`, `PAGE_SIZE=100`); 3-legged OAuth (PKCE + Basic-header secret) on the provider-registry shipped in PR-1; rotating refresh tokens handled by the single-flight `getValidVaultAccessToken` lock (Zoom invalidates the whole chain on refresh-token reuse); fixed SaaS hosts `api.zoom.us` + `zoom.us` in the I15 sandbox manifest; `external_id = String(<meeting_id>)` (numeric, Raindrop pattern); `zoom:meeting` is sparse-structured (topic + start_time + ids), deliberately NOT prose-heavy; `hitlRequired: []` (read-only v1); recordings index + AI-generated transcripts deferred to PR-3 on the same OAuth grant (no re-consent required).

### 2026-05-26

- **Coverage floor Phase 7** ✅ (PR #427) — baseline 51 → 10 entries.
- **Preflight workflow overhaul** ✅ (PR #428) — local CI-parity gate manifest in `scripts/lib/preflight-gates.ts`; drift test at `scripts/preflight.test.ts` fails if a CI gate is missing from the manifest. `bun run preflight` covers the full gate set; `bun run preflight:fast` covers the cheap static gates (~2-3 min).

### 2026-05-25

- **Tier-1 connector — ArgoCD** ✅ — GitOps application sync/health (`argocd:application`); self-hosted Bearer auth, single GET /api/v1/applications walk; sandbox host extended from `argocd.url` (Grafana pattern). Applications-only (AppProjects + sync history deferred).
- **Tier-1 connector — Flux** ✅ — GitOps Toolkit CRs (kustomizations, helm releases, sources, image automations) read from the Kubernetes API (`flux:resource`); self-hosted SA-bearer auth, status.conditions Ready health. Writes (reconcile/suspend) deferred to Phase 6.
- **Tier-1 connector — dbt Cloud** ✅ — Administrative-API jobs + run status (`dbt:job`); `Authorization: Token` auth. Model-lineage (Discovery API) + `dbt.job.trigger` HITL deferred.
- **Tier-1 connector — Metabase** ✅ — dashboards (`metabase:dashboard`) via the Metabase API (`x-api-key`); self-hosted host via `metabase.url`. Saved-questions/cards deferred.
- **Tier-1 connector — Superset** ✅ — dashboards (`superset:dashboard`) via the Superset API (username/password → JWT); self-hosted host via `superset.url`. Charts/datasets/saved-queries deferred.
- **Tier-1 connector — Databricks** ✅ — jobs + latest run status (`data_pipeline`) via the Jobs API 2.1 (Bearer PAT); per-workspace host via `databricks.host`. Clusters/SQL-warehouses/notebooks + write tools deferred.
- **Tier-1 connector — MLflow** ✅ — registered models (`ml_model`) via the Model Registry API (`GET /api/2.0/mlflow/registered-models/search`, Bearer token); tracking-server host via `mlflow.host`. Registered-models-only (experiments/runs/metrics/params/artifacts deferred); `ml.model.promote` / `ml.model.transition-stage` (HITL) writes deferred to Phase 6.
- **Tier-1 connector — Vercel** ✅ — deployments (`vercel:deployment`) via the Vercel REST API (`GET /v6/deployments`, Bearer token, `pagination.next` walk capped at 20 pages); `vercel.token` required + optional `vercel.team_id` (scoped via `&teamId`); fixed SaaS host `api.vercel.com` (static sandbox network — no host override). Surfaces git commit metadata + inspector URL for correlating deploys with PR/Slack history. Deployments-only (projects/domains/env-vars/aliases/logs deferred).
- **Tier-1 connector — Netlify** ✅ — sites + embedded published-deploy status (`netlify:site`) via the Netlify REST API (`GET /api/v1/sites?per_page=100&page=N`, Bearer PAT, page-paginated walk capped at 20 pages); `netlify.token` required; fixed SaaS host `api.netlify.com` (static sandbox network — no host override). Surfaces deploy state / branch / commit ref / preview URL + linked repo for "is the latest deploy live?" and "which site shipped this commit?". ISO-8601 timestamps parsed to epoch-ms. Sites-only (per-deploy history / forms / functions / env-vars / DNS deferred).
- **Tier-1 connector — Stripe** ✅ — invoices (`stripe:invoice`) via the Stripe REST API (`GET /v1/invoices?limit=100`, Bearer secret key, `starting_after` + `has_more` cursor walk capped at 20 pages); `stripe.api_key` required; fixed SaaS host `api.stripe.com` (static sandbox network — no host override). Surfaces number / status / customer / amounts / subscription id + hosted-invoice URL for billing correlation. Stripe epoch-SECONDS timestamps converted to epoch-ms (×1000); amounts are integer minor units (cents). Invoices-only (payments / customers / disputes / subscription events deferred; `stripe.refund` HITL deferred to Phase 6).
- **Tier-1 connector — Mercury** ✅ — bank accounts (`mercury:account`) via the Mercury REST API (a single `GET /api/v1/accounts` reading the `{ accounts: [...] }` envelope — no pagination); `mercury.token` required; fixed SaaS host `api.mercury.com` (static sandbox network — no host override). Surfaces name / status / type / kind / routing number / available + current USD balances / legal business name for banking questions. The full account number is never stored — only the last 4 digits (`account_number_last4`); balances are USD major units (dollars, not cents); `createdAt` is ISO-8601 parsed to epoch-ms; `canonical_url` is null (no per-account public URL). Accounts-only (transactions / bills / statements deferred; wire / ACH HITL writes deferred to Phase 6).
- **Tier-1 connector — Readwise** ✅ — saved highlights (`readwise:highlight`) via the Readwise REST API (`GET /api/v2/highlights/?page_size=1000&page=N`, DRF `Authorization: Token <token>` auth — NOT Bearer, reading the `{ count, next, previous, results }` page envelope, incrementing `page` while `results` is non-empty and `next` is non-null, capped at 20 pages); `readwise.token` required; fixed SaaS host `readwise.io` (static sandbox network — no host override). Surfaces the highlighted excerpt text / the user's note / parent book id / location + location type / color / tags / source article URL for reading questions. The source article `url` is the `canonical_url` for web highlights (null for books); `highlighted_at` / `updated` are ISO-8601 parsed to epoch-ms; the highlight type stays on local MiniLM embeddings (not prose-heavy). Highlights-only (books / documents / daily-review deferred; the Reader v3 API deferred).
- **Tier-1 connector — Raindrop** ✅ — saved bookmarks (`raindrop:bookmark`) via the Raindrop.io REST API (`GET /rest/v1/raindrops/0?perpage=50&page=N` — collection id `0` is the special "all raindrops" collection — Bearer `Authorization: Bearer <token>` auth, reading the `{ result, items, count }` envelope, incrementing the 0-based `page` while `items` is non-empty AND a full page, capped at 20 pages); `raindrop.token` required; fixed SaaS host `api.raindrop.io` (static sandbox network — no host override). Surfaces the bookmark title / excerpt / note / domain / type / tags / collection id + the bookmarked link for bookmarking questions. The bookmarked `link` is the `canonical_url` (null when absent); `created` / `lastUpdate` are ISO-8601 parsed to epoch-ms; the `raindrop:bookmark` type stays on local MiniLM embeddings (not prose-heavy). Bookmarks-only (collections-as-items / highlights / per-collection filtering deferred).
- **Tier-1 connector — Intercom** ✅ — support conversations (`intercom:conversation`) via the Intercom REST API (`GET /conversations?per_page=150`, `Authorization: Bearer <access-token>` auth plus the `Intercom-Version: 2.11` + `Accept: application/json` request headers, reading the `{ type: "conversation.list", conversations, pages, total_count }` envelope, following the cursor at `pages.next.starting_after` while it is a non-empty string, capped at 20 pages); `intercom.token` required; fixed SaaS host `api.intercom.io` (the US host — EU/AU regional hosts deferred; static sandbox network — no host override). Surfaces the subject / state / priority / read flag / the source message author + first message body / linked contact ids / admin + team assignees / tags for support questions. `external_id` = `String(<numeric conversation id>)` (the row is skipped when the id is missing/non-numeric); the get-by-id path is the PLURAL `GET /conversations/{id}`; `created_at` / `updated_at` are epoch SECONDS converted to epoch-ms via the Stripe `secondsToMs` helper (×1000); the HTML `source.body` is stripped to plain text for the body preview; `canonical_url` is null (the inbox deep link needs the workspace app id, absent from the conversation payload — deferred); the `intercom:conversation` type stays on local MiniLM embeddings (NOT prose-heavy — the LIST endpoint only returns the first message and bodies are short, so the batch default to omit avoids surprise OpenAI spend for hybrid-mode users). Conversations-only (contacts / companies / tickets / admins-as-items + reply / close / assign write tools deferred).
- **Tier-1 connector — Zendesk** ✅ — support tickets (`zendesk:ticket`) via the Zendesk Support REST API (`GET /api/v2/tickets.json?page[size]=100`, cursor-based pagination reading the `{ tickets, meta: { has_more, after_cursor }, links }` envelope, following `meta.after_cursor` while `meta.has_more` is true and the cursor is non-empty, capped at 20 pages); get-by-id is `GET /api/v2/tickets/{id}.json`. Unlike the fixed-host SaaS siblings in this batch, Zendesk is **per-tenant**: the user supplies the full base URL `https://<subdomain>.zendesk.com` via `zendesk.url`, and that host is added to the sandbox network list at spawn time by `phase3AddZendeskMcp` (the ArgoCD/Metabase/Grafana runtime-merge pattern — the static manifest network list is empty). HTTP **Basic** email/token auth: the username is `<email>/token` and the password is the API token (`Authorization: Basic base64(<email>/token:<api_token>)`; never logged) from the three required vault keys `zendesk.url` / `zendesk.email` / `zendesk.api_token`. Surfaces the subject / plain-text description (the first comment) / status / priority / type / requester + assignee + group + organization ids / tags / via-channel for correlating customer support history with code/PR changes. `external_id` = `String(<numeric ticket id>)` (the row is skipped when the id is missing/non-numeric — accepted as a numeric string or number); `created_at` / `updated_at` are ISO-8601 strings parsed to epoch-ms via `parseIsoMs` (NOT verbatim, NOT epoch seconds); `canonical_url`/`url` = the agent-UI deep link `<base>/agent/tickets/<id>` built from the configured base; the `zendesk:ticket` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — consistent with the batch default to omit, avoiding surprise OpenAI spend for hybrid-mode users; promotion is a documented follow-up); three read tools (`zendesk_list` / `zendesk_get` / `zendesk_search`); `hitlRequired: []`. Tickets-only (comments / users / organizations / Help Center articles deferred; reply / solve / assign HITL writes deferred).
- **Tier-1 connector — Lever** ✅ — job postings (`lever:posting`) via the Lever Data API (`GET /v1/postings?limit=100`, reading the `{ data, hasNext, next }` envelope, following the `next` offset cursor — passed as `&offset=<next>` — while `hasNext` is true and `next` is a non-empty string, capped at 20 pages); get-by-id is `GET /v1/postings/{id}`. HTTP **Basic** auth where the Lever API key is the USERNAME and the password is EMPTY (`Authorization: Basic base64(<api_key>:)` — the trailing colon is the empty password; never logged) from the required vault key `lever.api_key`; fixed SaaS host `api.lever.co` (static sandbox network — no host override). Surfaces the posting title / state / the team/department/location/commitment/level categories / tags / requisition code + the hosted job-page URL and apply URL for recruiting questions. `external_id` = `String(<posting id>)` (the row is skipped when `id` is missing/empty — Lever ids are UUID strings, so any non-empty string id is accepted, NOT required numeric); `createdAt` / `updatedAt` are epoch MILLISECONDS passed through verbatim (NO parse, NO ×1000 — like Vercel; `0`/missing → null); `canonical_url`/`url` = the posting's `hostedUrl` (else `urls.show`, else `applyUrl`, else null); the `lever:posting` type stays on local MiniLM embeddings (not prose-heavy — postings are short). Job postings only (opportunities / candidates deliberately deferred — candidate PII, out of scope for v1).
- **Tier-1 connector — Greenhouse** ✅ — job openings (`greenhouse:job`) via the Greenhouse Harvest API (`GET /v1/jobs?per_page=100&page=N`, reading a **bare JSON array** `[ ...jobs... ]` — NOT an envelope — incrementing `page` from 1 while the returned array is a full page of 100, stopping on a short/empty page, capped at 20 pages); get-by-id is `GET /v1/jobs/{id}`. Greenhouse also sends an RFC-5988 `Link` header with rel="next", but the walk uses the full-page-length heuristic (like Netlify) and does not parse it. HTTP **Basic** auth where the Harvest API key is the USERNAME and the password is EMPTY (`Authorization: Basic base64(<api_key>:)` — the trailing colon is the empty password; never logged) from the required vault key `greenhouse.api_key`; fixed SaaS host `harvest.greenhouse.io` (static sandbox network — no host override). Surfaces the job name / status / requisition id / confidential flag / the department names + office names/locations + the open/close/created/updated timestamps for recruiting questions. `external_id` = `String(<job id>)` (the row is skipped when `id` is missing/non-numeric — Greenhouse ids are numbers, so a numeric id is required, mirroring Raindrop's `_id`, NOT the Lever UUID-string accept); `created_at` / `updated_at` (and `opened_at` / `closed_at`) are ISO-8601 strings parsed to epoch-ms via a local `parseIsoMs` helper (NOT verbatim, NOT epoch seconds); `canonical_url`/`url` = null (the Harvest API exposes no per-job public URL without a board token — deferred); the `greenhouse:job` type stays on local MiniLM embeddings (not prose-heavy — jobs are short). Job openings only (candidates / applications deliberately deferred — candidate PII, out of scope for v1).
- **Tier-1 connector — Pipedrive** ✅ — CRM deals (`pipedrive:deal`) via the Pipedrive REST API (`GET /v1/deals?api_token=<t>&limit=100&start=N`, reading the `{ success, data, additional_data: { pagination: { more_items_in_collection, next_start } } }` envelope — a null `data` is treated as empty — following the `next_start` offset while `more_items_in_collection` is true, capped at 20 pages); get-by-id is `GET /v1/deals/{id}`. **Auth is via the API token IN THE QUERY STRING (`?api_token=<token>`) — there is NO Authorization header — so the request URL itself carries the secret; the connector and syncable therefore never log a request URL and never put a URL (or anything derived from it) into an Error/audit/log line: error diagnostics are built from the HTTP status code + a token-free response-body slice only, and the failure-path warn logs just the status + the token-free `start` offset.** Required vault key `pipedrive.token`; fixed SaaS host `api.pipedrive.com` (static sandbox network — no host override). Surfaces the deal title / value + currency / status (open/won/lost) / stage + pipeline ids / linked person + organization names / owner / probability / label / expected close date + won/close times for sales questions. `external_id` = `String(<deal id>)` (the row is skipped when `id` is missing/non-numeric — Pipedrive ids are numbers, mirroring Raindrop's `_id`); `add_time` / `update_time` (and `won_time` / `close_time`) are Pipedrive's non-ISO `"YYYY-MM-DD HH:MM:SS"` UTC strings converted to epoch-ms via a local helper (space→`T` + `Z` before `Date.parse`, NOT verbatim, NOT epoch seconds); `canonical_url`/`url` = null (a deal deep link needs the company-specific domain, absent from the token-only base — deferred, the Mercury null-canonical pattern); the `pipedrive:deal` type stays on local MiniLM embeddings (not prose-heavy — deals are short). Deals only (persons / organizations / activities / notes deliberately deferred).
- **Tier-1 connector — Stack Overflow for Teams** ✅ — team Q&A questions (`stackoverflow:question`) via the Stack Overflow for Teams v3 REST API (`GET /v3/teams/<team>/questions?page=N&pagesize=100&sort=creation&order=desc`, reading the `{ items, totalCount, pageSize, page, totalPages, sort, order }` envelope — page number is 1-based, continuing while `page < totalPages` and `items` is non-empty, capped at 20 pages); get-by-id is `GET /v3/teams/<team>/questions/{id}` (a single question, NOT wrapped in `{ items }`). Bearer auth (`Authorization: Bearer <token>` + `Accept: application/json`; never logged) using the TWO required vault keys `stackoverflow.token` (a Stack Overflow for Teams Personal Access Token) + `stackoverflow.team` (the team slug, URL-encoded into the request PATH — the sync handler and the lazy-mesh spawn both no-op unless both keys are present); fixed SaaS host `api.stackoverflowteams.com` (static sandbox network — no host override). Surfaces the title / body / tags / score + view count + answer count / answered flag / the asking user (owner id + name) / creation + last-activity + last-edit timestamps for knowledge questions. `external_id` = `String(<question id>)` (the row is skipped when `id` is missing/non-numeric — SO ids are numbers, mirroring Raindrop's `_id`); the question body is HTML-stripped to plain text for the body preview; `tags` is reduced to the tag-NAME array, tolerating v3 tags as either `{ name }` objects or plain strings; `creationDate` / `lastActivityDate` / `lastEditDate` are ISO-8601 strings parsed to epoch-ms via a local `parseIsoMs` (NOT verbatim, NOT epoch seconds); `canonical_url`/`url` = the per-question `webUrl` (the v3 API provides a real per-question URL); the `stackoverflow:question` type stays on local MiniLM embeddings (NOT added to PROSE_HEAVY_TYPES — promotion is a documented follow-up candidate since Q&A bodies are genuinely prose). Questions only (answers / articles / tags-as-items / users-as-items deliberately deferred).

### 2026-05-24

- **Tier-2 connector — Wiz** ✅ — CSPM findings (Phase 8 security surface, delivered early).
- **Tier-1 connector — LaunchDarkly** ✅ — feature flags / experiments (Phase 7 Wave 3, delivered early).
- **Tier-1 connector — Flagsmith** ✅ — feature-flag definitions (`flagsmith:feature_flag`); `Authorization: Token` auth, walks `/api/v1/projects/ → /api/v1/projects/{id}/features/` (DRF-paged) + per-project tag resolution. Definitions-only (per-environment state + segments deferred).

### 2026-05-22

- **Coverage floor Phase 6** ✅ — CLI long-tail. Shared test harness at `packages/cli/test/helpers/{cli-mocks,mock-ipc-client,cli-output}.ts`; sub-handler refactors across all 38 commands; `gateway-process.ts` impl-file split to resolve harness-shadow on the colocated unit test. `coverage-baseline.json` 91 → 53 entries; `cli/src/index.ts` structurally excluded.
- **Tier-2 connector — Semgrep** ✅ — AppSec Platform SAST findings (`semgrep:finding`).
- **Tier-2 connector — SonarQube / SonarCloud** ✅ — code-quality issues (`sonarqube:code_issue`).
- **Pre-commit hook docs** ✅ — `docs/cli/pre-commit.md` + `docs/templates/nimbus-pre-commit.sh`.
- **Published OpenAPI spec** ✅ — `GET /v1/openapi.json` + `audit:openapi-drift` CI gate.
- **Coverage floor Phase 5** ✅.

### 2026-05-21

- **T2 PR 4 — dependency resolution** ✅ — manifest `dependsOn` + backtracking DFS solver, V31 `extension_dependency` table + reverse-dep index, reverse-dep guard on `nimbus extension remove` (`--force` override), `MissingDependencyRegistry`, local-first `RegistryFetcher`, `extension.info --deps` + `extension.list --tree`. Composes on I9 / I14 / I16.
- **T2 / Wave-A connector — Snyk** ✅ — `snyk:vulnerability` items.
- **Wave-B connector — Bitrise** ✅ — `bitrise:app` + `bitrise:build` items.
- **`nimbus security scan`** ✅ — local credential-hygiene scan over indexed content; CLI-only, `FORBIDDEN_OVER_LAN`, not in Tauri allowlist.
- **Coverage floor Phase 4** ✅.
- **T4 wrap-up — `nimbus query` in CI worked examples** ✅ — `docs/cli/use-in-ci.md`.

### 2026-05-20

- **T2 PR 3 — extension auto-update** ✅ (PR #367) — in-process polling daemon (`ExtensionAutoUpdater`, default 24h), `extension.autoUpdate` / `extension.downgrade` HITL actions, `extension.checkForUpdates` / `extension.update` IPC, `nimbus extension update` / `downgrade` CLI. Composes on I2/I3/I4/I5/I7/I14/I16; bumped Tauri `ALLOWED_METHODS` 60 → 62.
- **Coverage floor Phase 3A + 3B-rest** ✅.

### 2026-05-18

- **T2 PR 2 — verified publisher (I16)** ✅ (PR #343) — Ed25519-signed manifest verification at install and startup, `SignatureDisabledRegistry`, `nimbus extension keygen` / `sign` / `sync` CLI, verified-publisher badges. Composes on I5/I7/I16.
- **Coverage floor Phase 2A** ✅.

### 2026-05-17

- **T2 PR 1 — sandbox (I15)** ✅ — sandbox PAL + 3-OS isolation + `permissions.{network,filesystem}` schema + I15 + static rule `D10` + `@nimbus-dev/sdk` contract tests + pre-T2 extension reinstall flow.
- **Coverage floor Phase 1A** ✅.

### 2026-05-16

- **T6 complete** ✅ — all four PRs landed:
  - PR 1 — I10 timing-safe helper consolidation (`util/timing-safe-compare.ts`).
  - PR 2 — `tool_call_log` V29 audit table (forensic complement to I11).
  - PR 3 — `vec_items_1536` V30 + hybrid embedding routing + `nimbus index reembed` CLI.
  - PR 4 — typed `dbRun` / `dbExec` I14 migration (163 sites) + static rule `D12`.
- **T4 wrap-up — PagerDuty pagination + `severity_p1_aliases`** ✅.

### 2026-05-15

- **T6 PR 2 — `tool_call_log` V29** ✅.
- **T6 PR 3 — `vec_items_1536` V30** ✅.
- **Sub-project A** ✅ (PR #297) — README hero redesign (light/dark asciinema casts), OG social card + deterministic resvg-js renderer + render-and-diff CI gate.
- **Docs site — 29 first-party connector pages** ✅ (PR #243).
- **Roadmap restructured into Shipped / Active / Planned** ✅ (PR #247).

### 2026-05-14

- **T6 sequencing spec** ✅.
- **T4 wrap-up — PagerDuty connector enrichment** ✅ — `pagerduty-sync.ts` writes `opened_at_ms` / `pagerduty_service_id` / `severity`; `initialSyncDepthDays` 14 → 30.

### 2026-05-10

- **Phase 4 complete on `main`; Phase 5 in flight.**
- **T3 (Team Intelligence) epic complete** — `AgentCoordinator.executeAll` parallel sub-agent dispatch + `nimbus expert` (PR 1, 2026-05-09), `nimbus impact` (PR 2, 2026-05-09), `nimbus catchup` (PR 3, 2026-05-10).

### 2026-05-09

- **`v0.1.0` released** — headless Gateway + CLI + VS Code extension. The Tauri desktop UI is code-complete but its release vehicle (signed installers) is deferred to Phase 13 as the separate `desktop-v0.1.0` tag — see [`docs/roadmap.md` § Phase 13](./roadmap.md#desktop-release-vehicle).

---

## Earlier phases

Phases 1 (Foundation), 2 (The Bridge), 3 (Intelligence), 3.5 (Observability & Developer Experience), and 4 (Presence) are summarized with acceptance criteria in [`docs/roadmap.md` § Shipped](./roadmap.md#shipped).
