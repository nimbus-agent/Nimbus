# Plan — Agent door AD2: the owner's queue and one-step approval (`nimbus approvals`)

Status: DRAFT — awaiting Antigravity review.
Spec: `docs/superpowers/specs/2026-11-13-agent-door.md` (approved, Antigravity round 2): § 2 (OR-AD-1, OR-AD-6), § 4 (D-AD-3, D-AD-4,
D-AD-8, D-AD-11, D-AD-12, D-AD-16), § 6 (the AD2 row), § 7.2, § 9 (the "agent calls owner-only IPC", "polling another agent's ids" and
"flooding" rows), § 10 (AD2 bullet, acceptance A1-A4), § 11 (non-breaking), § 12 (the IPC `kind` bound).
Roadmap rows: Phase 28 *One approval step*, and the terminal half of *The same prompt* (`docs/roadmap.md` § Phase 28).
Base: AD2 builds on AD1 (PR #1993, branch `dev/asaf/p28-ad1`, head `7494928db`). **Every `file:line` below was read on that branch**
(`git show origin/dev/asaf/p28-ad1:<path>`), not on `main`, wherever AD1 touched or could have touched the file. Numbers re-derived there:
`CURRENT_SCHEMA_VERSION` = 96, static rules D10-D48, invariants I1-I56. **AD2 adds no migration, no HITL type, no invariant, no new static
rule number, no `ALLOWED_METHODS` entry, no HTTP route and no egress class.** It adds five IPC methods (`approvals.list|get|approve|decline`,
`capture.mine`) and amends D32(b), D32(c), the I28 text and the CLI/MCP user-facing texts, under the triple rule (Tasks 1, 5, 8).

After AD2: an MCP client's `propose_action` still returns at once with an id; the owner runs `nimbus approvals` to list what waits (id,
UNVERIFIED label, type, wave, age, expiry, escaped summary), `nimbus approvals show <id>` to read what the agent SENT, and
`nimbus approvals <id>` to approve in ONE owner action: the gateway runs `acceptCapture` on the owner's own connection, so the executor's
prompt (typed preview, before-state, proposer block, AD1) and, for a Wave 4 row, the typed confirmation reach THAT terminal. Only a person
can answer (`answerSource: "human"`); `--yes` and scripted consent are refused on the CLI and again at the gateway. `capture.state` answers only
for ids the asking connection submitted; a connection may hold at most 3 `proposed` actions; the owner gets a count-only toast.

## The behavioural delta, stated precisely

What does NOT change (each pinned by a test, Task 9):

- **Reach.** `ACTION_PROPOSABILITY`, `classifyActionType`, the 47 proposable types, `actionDestinationRefusal` and `acceptAction`'s eight steps
  (`mcp-sink/capture-act.ts:148-281`) are untouched. Eligibility, the per-door list, `agentOffered` and the hash are AD3a. **No Wave 4 type is
  proposable in AD2** (AD1 Task 9 pins it), so a real Wave 4 proposal cannot exist yet: A2 on the terminal is proved with a synthetic Wave 4
  row through the existing test seams (correction 4).
- **`captures.*` and `capture.submit`/`capture.status`.** Same methods, same roles (`CAPTURE_ROLE_BY_KIND`, `capture-client-policy.ts:12-21`,
  `unknown` still maps to owner, D-AD-16), same results. The gateway's `captures.accept` on an action keeps working for every existing
  client (correction 3).
- The tool dispatched, the payload `{ mcpToolId, input }`, no delegation, no standing rule, the executor's own prompt (AD1).

What DOES change, and in which direction (every item narrows or adds an owner surface; none widens an agent's reach):

1. **Four new owner methods** `approvals.list`, `approvals.get`, `approvals.approve`, `approvals.decline` in a new `ipc/approvals-rpc.ts`. All four
   require a connection that DECLARED `cli` or `ui` (an undeclared `unknown` connection is refused here, though `captures.*` still serves it).
   `approve` reaches the act door through `acceptCapture` (the same gate function `captures.accept` uses), so `acceptAction` keeps its one caller.
2. **`approvals.approve` is human-only.** The consent coordinator it passes to `buildActDeps` is wrapped so an approval whose `answerSource` is not
   `human` (`auto` is `--yes`, `script`, `unknown`, `delegate`, `remote`, `none`) is turned into a decline BEFORE the executor records it (the
   `createStandingOwnerAsk` precedent, `ipc/standing-rpc.ts:495-532`); the wrapper covers both `requestConsent` and `requestConfirmedConsent`.
3. **`capture.state` becomes owner-of-id only** (D-AD-11): a row whose `session_id` is not the asking connection answers `ERR_CAPTURE_NOT_FOUND`,
   exactly as an absent id. New `capture.mine` lists the caller's own captures. A capture id grows from 122 to 128 random bits (correction 2).
4. **A per-connection cap** (D-AD-12): at most `min(3, actionMaxPending)` `proposed` actions per `session_id`; the refusal is the existing
   `ERR_CAPTURE_QUEUE_FULL` with its own message.
5. **A count-only toast** when a proposal is queued: "N agent proposals waiting", a number and fixed text, never a request-derived string.
6. **A rejected approval tells the owner why** (the executor's reason travels back on the owner's reply only; it is not stored, correction 1).
7. **Texts**: the MCP tool results and descriptions, `nimbus mcp-server` help, `nimbus help`, the desktop Captures page's command hint and the
   docs name `nimbus approvals <id>`; `nimbus captures accept <actionId>` becomes a CLI alias of it.

## Spec contradictions and corrections (checked against the code)

Where the spec is right the plan follows it; these are the points where the code disagrees. Each is binding for AD2 and is reported.

1. **A refused approval cannot be stored with a fixed `errorCode` without a migration (spec § 7.2 last paragraph of "Owner side").** The spec says
   a refusal at approval "finalizes the row as `rejected` with a fixed `errorCode`". V69's table constraint is
   `CHECK (error_code IS NULL OR (kind = 'action' AND state = 'failed' AND length(error_code) <= 64))`
   (`index/capture-action-v69-sql.ts:40`): a `rejected` row may not carry one, and `finalizeAction` (`capture-store.ts:282`) would throw, leaving
   the row `executing`. Correction: AD2 finalizes `rejected` with NO code (as a decline does today), threads the executor's `reason` to the
   OWNER's reply only (an optional `reason` on `ActExecuteOutcome` and `ActionAcceptResult`, not stored, never in `capture.state`), and the agent
   sees `rejected`. If the owner wants the agent to tell a decline from a guard refusal, the CHECK must be relaxed by a table rebuild: that
   belongs in **AD3a's V97** (which already alters `capture` for `legacy`), not a new migration here, so V97/D49/I58 keep their numbers. Reviewer
   decision.
2. **The id generator (spec D-AD-11, UNVERIFIED there) is `cap_${randomUUID()}`** (`platform/assemble.ts:3939`): UUID v4 carries 122 random bits,
   below the spec's 128. Correction: Task 1 adds `mcp-sink/capture-id.ts` (`newCaptureId()` = `cap_` + 16 CSPRNG bytes as 32 hex digits) and assemble
   calls it. Existing ids stay valid (`requireId` checks only the `cap_` prefix, `capture-gate.ts:187`).
3. **"`captures accept` on an action becomes an alias of `approvals.approve` (one code path)" (D-AD-3) cannot be a gateway alias.** The gateway's
   `captures.accept` serves undeclared clients with answers that report no source: the sandboxed user-MCP e2e answers `consent.respond` with
   `answerSource` unreported, so `unknown` (`test/e2e/user-mcp.e2e.test.ts:404`, `:598-603`), and D-AD-16 forbids tightening `captures.*`. Making it
   human-only and kind-gated would break both. Correction: the alias is **CLI-side** (`nimbus captures accept <id>` on a `kind: action` capture
   calls `approvals.approve`), and both RPCs share `buildActDeps` and `acceptCapture`. The human-only wrapper and the kind check are
   `approvals.approve`'s additions. Stated bound: a raw socket client can still use `captures.accept` on an action with any answer source, as today
   (§ 12 already says so for the kind; this adds the answer source).
4. **Acceptance A2 on the terminal cannot be shown with a real Wave 4 proposal in AD2.** `ACTION_PROPOSABILITY` has no Wave 4 type until AD3a/AD3b.
   Correction: AD2 proves "denied for an empty, a wrong-case, a trimmed and an echo answer, approved only for the exact text" at the
   `approvals.approve` RPC with a synthetic Wave 4 row (`CaptureActWiring.beforeStateRows`, the AD1 seam) and a stubbed `classifyAction`, through the
   real `ConsentCoordinatorImpl` and the real executor; AD3a re-runs the same table with a real Wave 4 type and closes A2.
5. **`approvals.approve` step 4 keeps `classifyAction`, not `agentOffered`.** Spec § 7.2 says step 4 re-runs `agentOffered` and `modelWriteRefusal`; both
   arrive in AD3a. AD2 changes none of `acceptAction`'s steps except the owner-role check being preceded by the declared-kind check in
   `approvals-rpc.ts` (step 2 of the spec, there).
6. **`--decline-all-from <label>` is a CLI loop, not a fifth method** (`approvals.list`, then `approvals.decline` per matching row). The spec lists four
   methods; the loop keeps that. A proposal that arrives between the list and the last decline is not declined (stated).
7. **`capture.mine` is not exposed as an MCP tool in AD2.** The spec lists it among the gateway methods only. The adapter's `capture_status`
   (`packages/cli/src/mcp/capture-tools.ts:245-264`) is the agent's read; a `capture_mine` tool would change the tool list the AD6b adapter rewrite
   re-bases, so it is deferred there (the method is tested over raw IPC). Reviewer decision.
8. **Spec unverified items resolved here.** The payload cap named UNVERIFIED in D-AD-7 is `PAYLOAD_MAX_BYTES = 65_536`
   (`mcp-sink/capture-validate.ts:27`, checked at `:113` and `:171`): AD3's, not AD2's (bound rows are not proposable yet); recorded so AD3a does not
   re-search. `capture.session_id` is deliberately not indexed (`index/capture-v67-sql.ts:5`); the per-connection count therefore scans the
   `proposed` rows by the state index, a few hundred at most.

## Every place that must change (the sweeps, verified by grep on the AD1 head)

### A. IPC routing (a handler alone is not enough)

| Site | Fact | AD2 change |
| --- | --- | --- |
| `ipc/server/dispatchers.ts:1607-1625` `tryDispatchCaptureRpc` | claims only `capture.` and `captures.` prefixes; `dispatchPhase4PlatformGroup` walks `PHASE4_PLATFORM_DISPATCHERS` (`:1980-2013`, `tryDispatchCaptureRpc` at `:2006`) | add `tryDispatchApprovalsRpc` (prefix `approvals.`, reads `ctx.options.captureRpcCtx`, passes `ctx.consentImpl` and `{ clientId, kind: ctx.getClientKind(clientId) }`) directly after it. **No second catalogue exists** (grep for `captures.purge` finds only the handler table, tests, docs and the Rust test), so this table IS the routing |
| `ipc/server/options.ts:246` | `captureRpcCtx?: CaptureRpcCtx` (`{ gate, act? }`) | reused by both namespaces; no new option, no new assemble wiring |
| `ipc/lan-rpc.ts:240-241` | `FORBIDDEN_OVER_LAN` is a **denylist**; `"capture"`, `"captures"` listed, `checkLanMethodAllowed` (`:285`) matches the namespace | add `"approvals"` (a new namespace is LAN-reachable by default) |
| `ipc/lan-rpc.test.ts:156-160`, `ipc/capture-rpc.test.ts` "LAN" block (`it.each` of method names) | list names explicitly | add `approvals.*` rows AND a test that derives the method list from `APPROVALS_METHODS` so a future method is covered |
| `ui/src-tauri/src/gateway_bridge.rs:833-852` `allowlist_captures_reads_only` | one `assert!(!is_method_allowed(..))` per name, no array literal (twin in `security-invariants.test.ts:4017-4022`) | add `allowlist_approvals_never_renderer` asserting `!is_method_allowed` for the four methods and `capture.mine`; I7 unchanged (**approvals.\* are NOT renderer-callable, spec § 7.2**; desktop is a later row) |
| `ipc/server/demo-gate.ts:28-45` | demo refuses a named set | no edit: the demo root's `[mcp_sink]` is default-off, so `acceptCapture` refuses `ERR_CAPTURE_DISABLED`; Task 9 pins it |

### B. Callers and importers of the capture gate (D32(b)/(c))

| Site | Fact | AD2 change |
| --- | --- | --- |
| `scripts/structure-audit/check-nimbus-invariants.ts:4006-4040` `D32_GATE_FN_RE`, `D32_GATE_ALLOWED`, `checkCaptureGateCallers` | names `submitCapture|acceptCapture|rejectCapture|revokeCapture|purgeCapture`; allow-list is `ipc/capture-rpc.ts` + `capture-gate.ts` | allow-list becomes exactly those two plus `"packages/gateway/src/ipc/approvals-rpc.ts"` (entries are FULL repo-relative paths: the check is `D32_GATE_ALLOWED.includes(f.relPath)`, `:4018`) |
| same file `:4042-4072` `D32_GATE_MODULE_RE`, `checkCaptureGateImporters` | exempts one file, `ipc/capture-rpc.ts`, inline (`:4050`) | replace the inline test with `D32_GATE_IMPORTERS_ALLOWED = ["packages/gateway/src/ipc/capture-rpc.ts", "packages/gateway/src/ipc/approvals-rpc.ts"]` and `if (D32_GATE_IMPORTERS_ALLOWED.includes(f.relPath)) continue;` |
| same file `:5456-5466` | error text says "outside ipc/capture-rpc.ts" | reworded to "outside ipc/capture-rpc.ts and ipc/approvals-rpc.ts" |
| `:4134-4136` `D32E_ALLOWED` (`acceptAction`: `capture-act.ts`, `capture-gate.ts`) | D32(e) | **unchanged** (this is why `approve` goes through `acceptCapture`) |
| `check-nimbus-invariants.test.ts:2521-2635` (D32(c) and D32(b) blocks) | fixtures use `capture-rpc.ts` as the one allowed module | extend per Task 5 |
| `docs/SECURITY-INVARIANTS.md:932` ("Static complement") and `docs/architecture.md:3086-3090` ("Static D32 has seven clauses") | state "`ipc/capture-rpc.ts` + `capture-gate.ts`" | reworded in the same commit |
| `security-invariants.test.ts:3971-4260` (the I28 describe) | reads `capture-rpc.ts`/`capture-gate.ts` source; `:4230-4245` asserts `capture-rpc.ts` never contains `delegation` | add the AD2 block (Task 9); the human-only wrapper therefore lives in `approvals-rpc.ts`, never in `capture-rpc.ts` |

### C. Seam types compared (not just names)

| Seam | Today | AD2 |
| --- | --- | --- |
| `CaptureCaller` `{ clientId: string; kind: ClientKind }` (`capture-gate.ts:94-97`) | built in `dispatchers.ts:1617-1623` from the connection | same for approvals; new `APPROVER_BY_KIND: Readonly<Record<ClientKind, boolean>>` in `capture-client-policy.ts`, TOTAL over `ClientKind` like `CAPTURE_ROLE_BY_KIND` (a new kind is a compile error) |
| `buildActDeps(w: CaptureActWiring, coordinator: ConsentCoordinator, clientId: string): ActDeps` (`capture-rpc.ts:126`) | `consent` arrives as `ctx.consentImpl` (a `ConsentCoordinatorImpl`, `server/context.ts:10`) | approvals passes `humanOnlyConsent(coordinator, onNonHuman)`, a `ConsentCoordinator` with the same four members (`requestConsent`, `requestConfirmedConsent`, `rejectAllPending`, `pendingCount`, `ipc/consent.ts:17-45`) |
| `ActExecuteOutcome` rejected arm `{ status: "rejected" }` (`capture-types.ts:157-159`); `ActionAcceptResult` (`capture-act.ts:53-58`) | no reason | `{ status: "rejected"; reason?: string }`; `ActionAcceptResult` gains `reason?: string` on the `rejected` arm only (not stored: `finalizeAction` takes `outcomeRef`/`errorCode` only, `capture-store.ts:282-296`, and `acceptAction` step 8 passes explicit fields) |
| `ConsentChoice` (`cli/src/lib/interactive-ipc-handlers.ts:228-231`): `prompt` honours `NIMBUS_SCRIPT_CONSENT_SOURCE` (`:256-259`) | closed union, "never none" | add `{ kind: "human" }`: `registerConsentPromptHandler` unconditionally, env ignored |
| `CaptureGateDeps` (`capture-gate.ts:66-92`) | no notification hook | add optional `onActionProposed?(pending: number): void` (a number only) |
| `CaptureStore` (`capture-store.ts:96`) | no per-session query | add `countPendingActionsBySession`, `listBySession` (store-only, D32(a)) |
| CLI `COMMAND_NAMES` (`cli/src/commands/registry.ts`, sorted; `help.test.ts` cross-checks) | no `approvals` | insert `"approvals"` BEFORE `"approve"` (`approva` < `approve`) |

## Design decisions

**D-1 `ipc/approvals-rpc.ts`.** Exports `APPROVALS_METHODS` (the four names, `as const`), `dispatchApprovalsRpc(method, params, ctx: CaptureRpcCtx, caller,
consent?)` (same shape as `dispatchCaptureRpc`, `capture-rpc.ts:189-226`; a `CaptureError` becomes `RpcMethodError(-32001, msg, { code })`, factored into
one exported `captureErrorToRpc` in `capture-rpc.ts` so the mapping is not copied) and `humanOnlyConsent`. Every handler first calls
`requireApprover(caller)`: `APPROVER_BY_KIND[caller.kind]` else `CaptureError("ERR_CAPTURE_FORBIDDEN_CLIENT", "approvals need a connection that declared cli or ui")`
(no new error code). It imports nothing from `llm/` (A4, a direct-import pin).

**D-2 Gate functions, all in `capture-gate.ts`** (D32(a) keeps SQL in the store; D32(f) keeps `connectors/` out):
`listActionProposals(deps, caller)` (owner role, expiry sweep, `store.list({ state: "proposed", kind: "action", order: "asc", limit: 200 })`, payload parsed with
the `titleOf` tolerance: a row that does not parse is skipped, not thrown), `captureMine(deps, caller)` (submit role; the caller's rows, newest first,
at most 50, no payload) and the changed `captureStateFor`. `getCapture`, `rejectCapture` and `acceptCapture` are reused as they are.

**D-3 Views are escaped by the gateway, once.** `approvals.list` rows are `{ id, actionType, wave: 2|3|4|null, typedConfirm: boolean, label, labelSource: "declared",
summary, createdAt, expiresAt }`; `label` and `summary` go through `engine/proposer-block.ts` (AD1) via one new export `escapeUnverifiedLine(s)` (the module-private
`visibleLine`, `proposer-block.ts:33-37`), so the CLI and a future desktop render one escaping. `approvals.get` adds `inputLines` (`agentVerbatimInputLines(input)`,
the AD1 helper, first header line dropped) and `note: "the typed preview and the target's current state appear when you approve"`. `wave`/`typedConfirm` come from
`proposableWriteTool(type)` then `rowNamedByToolId(toolId, CONNECTOR_WRITE_ROWS)` (`connectors/connector-writes/preview.ts:174`); a user-MCP type has no row: `null`/`false`.
The CLI still `stripControl`s every field (defence in depth, `captures-format.ts`).

**D-4 `approvals.approve`** in this order, each step its own named function so the order reads top to bottom (the I35 lesson in CLAUDE.md):
(1) `requireApprover`; (2) `requireId`, then `getCapture` (NOT_FOUND, expiry sweep, owner role) and refuse `kind !== "action"` with `ERR_CAPTURE_STATE`
("approvals handle agent-proposed actions; use captures accept for a decision, term or link"); (3) build `buildActDeps(ctx.act, humanOnlyConsent(consent, mark), caller.clientId)`
(absent `act` or `consent` passes `undefined`, and `acceptAction` step 1 refuses `ERR_CAPTURE_DISABLED`, `capture-act.ts:154-158`); (4) `await acceptCapture(gate, caller, id, deps)`;
(5) shape the reply `{ id, state, outcomeRef?, errorCode?, reason? }` where a refused non-human answer sets `reason` to a fixed text. **No other call can run before
`acceptCapture`'s own checks** (capability, owner role, state, expiry, classify, configured, destination, CAS claim).

**D-5 Decline.** `approvals.decline` = step (1), (2) as above, then `rejectCapture`. No capability needed (the owner can always drain the queue, `capture-gate.ts:742`).

**D-6 Per-connection cap.** In `submitCapture` after the global queue check (`:436-440`): `if (v.kind === "action" && countPendingActionsBySession(session, now) >=
Math.min(PER_CONNECTION_ACTIONS, cap.config.actionMaxPending))` then `refuseQueueFull`-style audited `ERR_CAPTURE_QUEUE_FULL` ("this connection already has N
proposed actions waiting for the owner"). `PER_CONNECTION_ACTIONS = 3` is a constant, not a key (spec D-AD-12). It runs before any read and writes only the usual audit row.

**D-7 The toast.** `mcp-sink/capture-toast.ts` `proposalsWaitingToast(pending: number): { title: string; body: string }`: title `Nimbus: agent proposals waiting`, body
`<n> agent proposal(s) waiting. Review with: nimbus approvals`; the parameter is a number, so no request-derived string can reach it by type. `submitCapture` calls
`deps.onActionProposed?.(deps.store.countPendingActions(now))` after the transaction commits, inside a try/catch (a toast failure never fails a submit). `assemble.ts` wires it to
`showIgnoringFailure(notifications, t.title, t.body)` (its signature is `(service, title: string, body: string)`, `platform/notifications/notifications-runtime.ts:276-280`, so the two fields are passed by name, never spread; `notifications` is built at `assemble.ts:3828`, before `captureGate` at `:3933`); the service rate-limits and honours
`[notifications]`/`NIMBUS_NOTIFICATIONS`.

**D-8 The CLI.** `packages/cli/src/commands/approvals.ts`: parse (`approvals` = list, `show <id>`, `<id>`, `<id> --decline`, `--decline-all-from <label>`, `--json` for list/show/decline
only; `--yes`, `-y` and `--script-consent-source` are usage errors, exit 2), `declareCliClientKind(c)` FIRST (`lib/declare-client-kind.ts`), then the work. **Approving requires an
interactive TTY on stdin and stdout and checks it BEFORE any RPC** (fail closed; the gateway cannot see a TTY, so this is a CLI-side guard, as `captures accept`'s is). The connection is
`withGatewayIpc(fn, paths, { consent: { kind: "human" }, requestTimeoutMs: BATCH_RPC_TIMEOUT_MS })`. An approve is `approvals.approve` only: no `captures.get`, no `captures.accept`
(that is what makes it ONE owner action, A3, asserted on the recorded calls). Output: `[ok] executed <type> (<ref>)`, `[rejected] not executed: <escaped reason>`, `[failed] <code>`
(reusing `acceptLine`'s wording and its `NOT_DISPATCHED` set, moved to `captures-format.ts` so both commands share it).

## File map

New: `ipc/approvals-rpc.ts` (+ `approvals-rpc.test.ts`), `mcp-sink/capture-id.ts` (+ test), `mcp-sink/capture-toast.ts` (+ test),
`cli/src/commands/approvals.ts` (+ `approvals.test.ts`), `test/integration/mcp-sink/approvals-flow.test.ts`.
Edited (gateway): `mcp-sink/capture-gate.ts`, `capture-store.ts`, `capture-types.ts`, `capture-act.ts`, `capture-client-policy.ts`, `ipc/capture-rpc.ts`, `ipc/server/dispatchers.ts`,
`ipc/lan-rpc.ts`, `engine/proposer-block.ts` (one export), `platform/assemble.ts` (id, hook), `scripts/structure-audit/check-nimbus-invariants.ts` (+ test), the tests listed in Task 9.
Edited (cli): `lib/interactive-ipc-handlers.ts`, `commands/{captures.ts,captures-format.ts,registry.ts,help.ts,index.ts,mcp-server.ts}`, `src/index.ts`, `mcp/capture-tools.ts` (+ tests).
Edited (ui, strings only): `packages/ui/src/components/captures/format.ts` (it has no test file of its own; `terminalCommands` is covered through `packages/ui/test/pages/Captures.test.tsx`), `packages/ui/src-tauri/src/gateway_bridge.rs` (a negative test only).
Docs: Task 10. `V96` stays the schema; `docs/SECURITY-INVARIANTS.md` gains no new rule number.

## Tasks (test first; red-prove every guard by reverting the production line and watching its test fail)

### Task 0 - Preconditions

1. Branch `dev/asaf/p28-ad2` from `dev/asaf/p28-ad1` (absolute path: `git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p28-ad2 -b dev/asaf/p28-ad2
   dev/asaf/p28-ad1`); verify `git rev-parse --abbrev-ref HEAD` before every commit. **Stacked PRs merge into their BASE**: while #1993 is open this PR's base is
   `dev/asaf/p28-ad1`; after it merges, retarget to `main` and rebase (`git fetch --unshallow` is not needed unless the clone is shallow). `bun install`; on Windows build the sandbox
   helper. The spec and this plan are STRIPPED from the branch before the PR.
2. Re-derive: `CURRENT_SCHEMA_VERSION` (96), `docs/SECURITY-INVARIANTS.md:3` ceilings (D48, I56). If another slice merged a rule touching D32 or a method named `approvals.*`, rebase first.
3. Baseline, scoped (no full suites): `bun test packages/gateway/src/mcp-sink packages/gateway/src/ipc/capture-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts
   packages/cli/src/commands/captures.test.ts packages/cli/src/mcp scripts/structure-audit/check-nimbus-invariants.test.ts`; record counts.
4. Confirm by a one-off script the two facts the plan relies on: (a) V69 rejects `error_code` on a `rejected` action (insert-and-catch against a fresh in-memory db; this becomes
   a regression test in Task 2 so correction 1 stays true); (b) no proposable type is Wave 4 (AD1's Task 0 step 3 test). If (b) is false, STOP: correction 4 changes.

### Task 1 - Ownership, ids and `capture.mine` (gate + store)

Files: `mcp-sink/capture-id.ts` (new), `capture-gate.ts`, `capture-store.ts`, `platform/assemble.ts`, their tests (`capture-gate.test.ts:1230-1240`, `capture-gate.gaps.test.ts:132-150`).

1. Tests first. `capture-id.test.ts`: `newCaptureId()` matches `/^cap_[0-9a-f]{32}$/`, 10,000 draws are distinct, and the source draws 16 bytes from `node:crypto` (a pin, so a later
   "simplification" back to `randomUUID` fails). `captureStateFor`: the submitting connection gets its row; a second `mcp` connection (`{ clientId: "other", kind: "mcp" }`) gets
   `ERR_CAPTURE_NOT_FOUND` with the SAME message as an absent id (no existence oracle: compare the two messages); an `owner` caller is still `ERR_CAPTURE_FORBIDDEN_CLIENT`; an expired row
   still answers its owner. `captureMine`: returns only the caller's rows, newest first, capped at 50, no `payload`/`summary`/`input` keys (assert the exact key set), an owner caller is refused.
   Update the existing gate tests that read another connection's state. RED.
2. `capture-store.ts`: `listBySession(sessionId, limit)` (fixed SQL, bound params, `ORDER BY created_at DESC, id DESC`). `capture-gate.ts`: `captureStateFor` compares `row.sessionId`
   to `caller.clientId` after the role check and throws the not-found error; `captureMine`. `capture-rpc.ts` handler table: `"capture.mine": (_p, c) => captureMine(c.gate, c.caller)`
   (LAN-forbidden by the existing `capture` namespace entry). `assemble.ts:3939`: `newId: newCaptureId`. GREEN.
3. Update the `capture_status` tool description (`cli/src/mcp/capture-tools.ts:248-252`: it says the gateway "does not check who submitted it") to "answers only for captures submitted on
   this connection", and its pin in `capture-tools.test.ts`.

### Task 2 - Rows the connection cap and the reason travel with (gate, act, types)

Files: `capture-gate.ts`, `capture-store.ts`, `capture-act.ts`, `capture-types.ts`, `ipc/capture-rpc.ts`, tests.

1. Tests first (`capture-gate.test.ts`): a fourth `proposed` action from one connection is refused `ERR_CAPTURE_QUEUE_FULL` with the per-connection message while a second connection
   can still propose; with `actionMaxPending: 2` the per-connection cap is 2 (`min`); an expired or decided action frees a slot; a refusal reads no connector (the gate has none) and writes the
   standard audit row; the existing queue-full and expiry tests at `:986`, `:1112`, `:1160`, `:1248` submit more than 3 actions from one caller, so they are re-run with a caller per
   submission (a `mcpN(i)` helper) and the old assertions stay. `capture-store.test.ts`: `countPendingActionsBySession` ignores other sessions, non-action kinds and expired rows. A regression
   test for correction 1: `finalizeAction(id, "rejected", { errorCode: "ERR_X" })` throws against the V69 table (so nobody silently relies on a code). Reason threading
   (`capture-act.test.ts`): an `ActDeps` that returns `{ status: "rejected", reason: "r" }` yields `{ state: "rejected", reason: "r" }` from `acceptAction`, the row finalizes `rejected` with a NULL
   `error_code`, and `captures.get` and `capture.state` never carry `reason`. RED.
2. `submitCapture`: the per-connection check (D-6) right after the global queue check; `CaptureStore.countPendingActionsBySession(sessionId, nowMs)`. `capture-types.ts:157`: the rejected arm
   gains `reason?: string`; `capture-act.ts:232-246` step 7 copies it; `buildActDeps` (`capture-rpc.ts:176`) returns `{ status: "rejected", reason: out.reason }` and the credential pre-check
   (`:147-151`) returns a fixed reason. Fix every `toEqual({ status: "rejected" })` the type change breaks (let `bun run typecheck` and the failing tests name them). GREEN.

### Task 3 - The proposal view and the toast

Files: `capture-gate.ts`, `engine/proposer-block.ts` (export `escapeUnverifiedLine`), `mcp-sink/capture-toast.ts` (new), `platform/assemble.ts`, tests.

1. Tests first. `listActionProposals`: owner only, `proposed` actions only (not an expired one, not a decision), oldest first, a row whose payload does not parse is skipped, returns raw
   `actionType`/`summary`/`clientLabel` (the RPC layer escapes). `proposer-block.test.ts`: `escapeUnverifiedLine` escapes a quote, backslash, LF, bidi, zero-width and an astral character exactly as
   `formatProposerBlock` does for the label (same fixtures as AD1's). `capture-toast.test.ts`: `proposalsWaitingToast(1)` and `(7)` match the exact fixed texts (singular/plural); no other
   parameter exists (a type-level `// @ts-expect-error` for a string argument); `submitCapture` calls the hook once per queued ACTION with the pending count, never for a note, a decision
   or a refused proposal, and a throwing hook still returns the id. RED.
2. Implement; `assemble.ts`: `onActionProposed: (n) => { const t = proposalsWaitingToast(n); void showIgnoringFailure(notifications, t.title, t.body); }` inside `captureGate` (an object cannot be spread into an argument list). GREEN.

### Task 4 - `ipc/approvals-rpc.ts`

Files: `approvals-rpc.ts` (new), `mcp-sink/capture-client-policy.ts`, `ipc/capture-rpc.ts` (`captureErrorToRpc` export), `approvals-rpc.test.ts` (new).

Tests first, real SQLite (`new Database(":memory:")` through the repo's migration helper, as `capture-rpc.test.ts` builds its `ctx`) and a real `ConsentCoordinatorImpl` with a fake writer that
answers each `consent.request` per the test:

- **Kind.** For every `ClientKind`: `APPROVER_BY_KIND` is `true` exactly for `cli` and `ui`; each of the four methods from `mcp`, `unknown`, `http`, `chatops`, `fleet` and `push` is
  `ERR_CAPTURE_FORBIDDEN_CLIENT` (`-32001` with `data.code`), and the gate was not called (a spy on `store.get`).
- **List/get.** `list` returns the escaped view of D-3 (inject a label `a"\nType: x` and a summary with a U+202E: both come back escaped, on one line); `wave`/`typedConfirm` for a real
  proposable type match its `CONNECTOR_WRITE_ROWS` row, `null`/`false` for `mcp_x.y`; `get` returns `inputLines` with the invisible character as `\u202e`; a decision capture id is
  `ERR_CAPTURE_STATE`; an unknown id is `ERR_CAPTURE_NOT_FOUND`.
- **Decline.** `decline` on a `proposed` action is `rejected` and audited `capture.reject`; on an `executed` action `ERR_CAPTURE_STATE`.
- **Approve, human-only.** With an `ActDeps`-level fake dispatcher: an answer `{ approved: true, answerSource: "human" }` dispatches once; the same with `auto`, `script`, `unknown`,
  `delegate`, `remote` and `none` dispatches NOTHING, the row is `rejected`, the executor's audit row says `rejected`, and the reply's `reason` says the answer did not come from a person. The
  typed path: for each of those sources `requestConfirmedConsent` is also turned into a decline with `typed: ""`.
- **Approve, order.** `acceptCapture` is the only gate function `approve` calls (spy), after `getCapture`; `act` or `consent` absent gives `ERR_CAPTURE_DISABLED` and no executor.
- **Reason.** A guard refusal (a Notion page update of a page under the KB parent, via `beforeStateRows`/`getTribalKbConfig` test seams) comes back as `state: "rejected"` with the guard's
  reason and no prompt shown.
- `APPROVALS_METHODS` is exactly the four names, each present in the dispatch table (a miss for `approvals.nonesuch` returns `kind: "miss"`).

Then implement D-1, D-2, D-4, D-5. Do NOT commit this task alone: it names the gate functions D32(b)/(c) allow only in `capture-rpc.ts`; **Tasks 4 and 5 land in ONE commit** (the triple rule;
otherwise `audit:invariants` is red between them).

### Task 5 - Static D32(b)/(c) amendment (check + fixtures + docs, in the SAME commit as Task 4)

Files: `scripts/structure-audit/check-nimbus-invariants.ts`, `.test.ts`, `docs/SECURITY-INVARIANTS.md`, `security-invariants.test.ts`.

1. Fixtures first (each must fail on the unamended checker; red-proved by reverting the allow-list line):
   - D32(b): `submitCapture`, `acceptCapture`, `rejectCapture`, `revokeCapture`, `purgeCapture` named in `ipc/approvals-rpc.ts` are clean; each named in a THIRD module (`platform/assemble.ts`,
     a new `ipc/x-rpc.ts`) is `capture-gate-callers`; an aliased import (`acceptCapture as ac`) in a third module fails; `acceptAction` named in `approvals-rpc.ts` is
     `act-door-accept-action` (D32(e) is unchanged and must stay unreachable from the new module).
   - D32(c): `approvals-rpc.ts` may value-import `capture-gate.ts`; a third module fails for each of the existing forms (barrel `export *`, namespace import, value import, multi-line, dynamic
     `import()`, side-effect import, both semicolon-free orderings) and `import type` stays allowed anywhere; `approvals-rpc.ts` importing `engine/executor.ts` is NOT covered here (it is not under
     `mcp-sink/`, D32(f)), asserted so nobody reads D32(f) as wider than it is.
   RED.
2. Checker: `D32_GATE_ALLOWED` + `"packages/gateway/src/ipc/approvals-rpc.ts"`; `D32_GATE_IMPORTERS_ALLOWED` (the two full `packages/gateway/src/ipc/...` paths, compared with `f.relPath`) replaces the inline exemption at `:4050`; a fixture asserts a bare `ipc/approvals-rpc.ts` entry would NOT exempt the file (the path-format trap); the two error strings at `:5459`, `:5465`.
   GREEN: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts`, `bun run audit:invariants`.
3. `docs/SECURITY-INVARIANTS.md:932`: D32(b) lists the five names as named only in `ipc/capture-rpc.ts`, `ipc/approvals-rpc.ts` and `capture-gate.ts`; D32(c) "no module other than those two RPC modules";
   D32(e) restated "one call, in `acceptCapture`, which exactly those two modules reach"; the stated bound gains "a second caller inside an allow-listed RPC module is exempt whole-file; the
   behavioural test pinning that `approve` calls `acceptCapture` after `getCapture` is authoritative". The I28 section gains the AD2 paragraph: the approvals namespace, the declared-kind and
   human-only rules, ownership of `capture.state`, the 128-bit ids, the per-connection cap, and the stated bounds (below). `docs/architecture.md:3086-3090` ("Static D32 has seven clauses") is
   reworded the same way.
4. `security-invariants.test.ts` I28 block: (a) `lan-rpc.ts` matches `"approvals"` and the Rust file has NO `"approvals.` entry line (the twin of `:4017-4022`); (b) `approvals-rpc.ts` contains
   `requireApprover(` before `acceptCapture(` before the reply, never `acceptAction`, and imports nothing from `llm/`; (c) `capture-rpc.ts` still contains no `delegation` and now no
   `humanOnlyConsent` (it lives in `approvals-rpc.ts`); (d) `buildActDeps` is the only place that builds the act executor (`buildAgentWriteExecutor(` count in `ipc/` is exactly 1).

### Task 6 - IPC routing, LAN and the Tauri negative

Files: `ipc/server/dispatchers.ts`, `ipc/lan-rpc.ts`, `ui/src-tauri/src/gateway_bridge.rs`, tests.

1. Tests first. `ipc/approvals-rpc.test.ts` "routing through `tryDispatchPhase4Rpc` (the entry `server.ts` calls)" (the pattern at `capture-rpc.test.ts` "routing through tryDispatchPhase4Rpc"):
   each of the four methods reaches the handler with the CONNECTION's kind and never a param (`{ ..., clientKind: "cli" }` from an undeclared connection is still refused); skipped when
   `captureRpcCtx` is unset; `approvals.nonesuch` falls through to `phase4RpcSkipped`. LAN: `test.each(APPROVALS_METHODS)` plus `capture.mine` against `checkLanMethodAllowed` throws `LanError`
   even with `writeAllowed: true` (the denylist trap: the test is derived from the exported list). Rust: `allowlist_approvals_never_renderer`. RED.
2. `dispatchers.ts`: `tryDispatchApprovalsRpc`, appended to `PHASE4_PLATFORM_DISPATCHERS` right after `tryDispatchCaptureRpc` (keep the "order is the contract" comment true: disjoint namespace).
   `lan-rpc.ts:241` + `"approvals"` with a comment naming why (a denylist; approving is the local owner's act). GREEN.

### Task 7 - The CLI: `nimbus approvals`, the `human` consent choice, the alias

Files: `lib/interactive-ipc-handlers.ts`, `commands/approvals.ts` (new), `commands/captures.ts`, `commands/captures-format.ts`, `commands/{registry,help,index}.ts`, `src/index.ts`, tests.

1. Tests first (fake `IPCClient` recording calls, as `captures.test.ts` does; no gateway):
   - `registerConsentFor(client, { kind: "human" })` registers the prompt handler even when `NIMBUS_SCRIPT_CONSENT_SOURCE` is set, and answers with `answerSource: "human"`; `prompt` still honours the env.
   - Parse: `approvals`, `approvals show cap_x`, `approvals cap_x`, `approvals cap_x --decline`, `approvals --decline-all-from "a b"`, `--json` on list/show/decline; `--yes`, `-y`,
     `--script-consent-source x`, an id without `cap_`, two ids and an unknown verb are usage errors (exit 2). `approvals cap_x --json` is a usage error (the prompt owns stdout).
   - Approve without a TTY on either end: exit 1, the message, and ZERO RPC calls. With a TTY: the recorded calls are exactly `[session.declareKind, approvals.approve]` (A3 on the
     wire), the declare first; never `captures.get`/`captures.accept`.
   - Output lines for `executed`, `rejected` (with and without `reason`; control characters stripped), `failed` (the `NOT_DISPATCHED` split) and a thrown RPC error (stripped, exit 1).
   - `--decline-all-from`: lists, declines exactly the rows whose escaped label equals the argument's escaped form, prints a count, exit 0 even when none match (and says so).
   - `captures accept <id>` on a `kind: action` capture now calls `approvals.approve` after `declareKind` (the TTY guard `actionAcceptTtyRefusal` is unchanged and still first); on a decision it still calls
     `captures.accept`; `captures accept --all --kind action` still refuses. `runCapturesCmd` builds its connection with `consent: { kind: "human" }` for the `accept` verb.
   RED.
2. Implement D-8; `registry.ts` gains `"approvals"` before `"approve"`; `help.ts` gains the block next to `captures` (`:166`) and the captures line points actions at `approvals`; `mcp-server.ts:79` help names
   `nimbus approvals` for actions; `captures-format.ts` `doctorCapturesLines` (`:269`) action lines end `— nimbus approvals` (pins in `captures-format.test.ts`/`doctor` tests updated).
3. MCP tool texts (`mcp/capture-tools.ts:86`, `:213-217`, `:239`): action wording becomes "the owner runs `nimbus approvals <id>`" (the native proposal wording `captures accept` stays); update
   `capture-tools.test.ts`. The tool schemas, names and annotations are unchanged (no tool list churn).
4. Desktop string: `ui/src/components/captures/format.ts:23-27` returns `nimbus approvals <id>` / `nimbus approvals <id> --decline` for a `proposed` ACTION and the existing pair for other kinds; update
   `packages/ui/test/pages/Captures.test.tsx` (the only test that reaches `terminalCommands`; add the action and non-action cases there). No IPC change, no allowlist change. Run `bun run --cwd packages/ui test -- Captures` where `packages/ui` is installed.

### Task 8 - Static and invariant text (CLAUDE.md, GEMINI.md, SECURITY-INVARIANTS.md, `.claude/commands/nimbus-mcp-sink.md`)

Amended under the triple rule, with wiring and tests already in Tasks 1-7:
- **I28**: add "an action proposal is approved by `approvals.approve` (`ipc/approvals-rpc.ts`), which reaches the act door only through `acceptCapture` on a connection that declared `cli` or `ui`,
  with a human-only consent channel; `capture.state` answers only for ids the asking connection submitted; a connection holds at most 3 proposed actions"; D32(b)/(c) wording in the
  invariant's wiring list (`mcp-sink/*`, `ipc/capture-rpc.ts`, `ipc/approvals-rpc.ts`). I28's line in `CLAUDE.md` and `GEMINI.md` carries identical edits (the two mirror each other).
- **I20 / I2 / I4 / I53 / I54 / I55 / I29**: text unchanged (AD1 did I20). `docs/SECURITY-INVARIANTS.md` I28 stated bounds gain: the TTY check is a CLI-side guard; the IPC `kind` is the connection's own
  claim (D-AD-16, as § 12); the gateway `captures.accept` on an action still serves an undeclared client with any answer source (correction 3); a restarted MCP server or a reconnect loses its own
  ids; `Ctrl-C` at the prompt rejects the proposal for good (the executor records a disconnect as a decline, as `captures accept` does today).
- `.claude/commands/nimbus-mcp-sink.md` (`:183-217`: the IPC list, the TTY bullet, the act-door paragraph) and `nimbus-file-map.md` (a row for `ipc/approvals-rpc.ts`) updated; `audit:doc-refs` resolves their paths.

### Task 9 - The behaviour that proves A1-A4 (integration, then the real-gateway e2e)

Real SQLite, a real `ToolExecutor`, a real `ConsentCoordinatorImpl`, the real dispatch table through `tryDispatchPhase4Rpc`; fake connector dispatcher; **no model, no `llm/`**.
File: `packages/gateway/test/integration/mcp-sink/approvals-flow.test.ts` (the `capture-action-flow.test.ts` harness, extended with a second owner connection and an `mcp` agent connection).

- **A1 (same prompt).** For a templated proposable row (`jira.comment.add`) with a reader, submit as `mcp`, approve as `cli` through `approvals.approve`; the prompt text between the `Type:` line and the
  proposer block, with the `Requested by:` line removed, equals the text `buildModelWriteExecutor` renders for the same input and the same canned reader reply (one `previewRegion(prompt)` helper). The
  proposer block is last and labelled UNVERIFIED. A user-MCP type shows the verbatim input.
- **A2 (typed confirmation, synthetic Wave 4; correction 4).** `beforeStateRows` carries a Wave 4 row with `confirm` and a reader; `classifyAction` is stubbed to propose it. `approvals.approve` is denied for
  an empty answer, a wrong-case answer, a trimmed answer and an echo of the prompt, approved only for the exact text; `requestApproval` is never used for it (D41); `--yes`-shaped `auto` and `script`
  answers are denied; an unreadable before-state is refused before any prompt with `WAVE4_BEFORE_REFUSAL`.
- **A3 (one owner action).** Between the agent's submit and the dispatch the owner connection issues exactly one request (`approvals.approve`) and answers one `consent.request`; the capture goes
  `proposed -> executing -> executed`; no `captures.accept` call exists in the owner connection's request log. `approvals.decline` leaves no dispatch.
- **A4 (no model).** The whole flow runs with no router, no `[llm]` configuration and no embedding runtime; a source pin proves `ipc/approvals-rpc.ts` and `cli/src/commands/approvals.ts` import nothing from
  `llm/` (stated: a DIRECT-import pin; the behavioural proof is this test and the e2e below).
- **Other owner connections.** `unknown`, `mcp`, `http`, `chatops` each refused on all four methods; a second `mcp` connection gets `ERR_CAPTURE_NOT_FOUND` for `capture.state` and an empty `capture.mine`; the
  fourth proposal from one connection is refused; two owners approving the same id: the second gets `ERR_CAPTURE_STATE`.
- **Demo / disabled.** With the default `[mcp_sink]` (off) `approvals.approve` is `ERR_CAPTURE_DISABLED` and `approvals.decline` still works (frozen queue can be drained).
- **Real gateway (E2E tree: a gateway-spawning test belongs there).** Extend `packages/gateway/test/e2e/user-mcp.e2e.test.ts` (it already boots a real gateway, a sandboxed echo user MCP, an owner client
  and an `mcp`-kind agent client, `describe.skipIf(!sandboxAvailable)`): the act-door test now proposes, lists with `approvals.list`, reads with `approvals.get`, and approves with `approvals.approve`
  from a client that sent `session.declareKind { kind: "cli" }` and answers `consent.respond` with `answerSource: "human"`; the same approve with an answer lacking a source is refused (the
  existing owner client reports none, so it doubles as the negative); `capture.state` from a third connection is `ERR_CAPTURE_NOT_FOUND`; `nimbus approvals <id>` run through the real CLI entry with stdin
  ignored exits 1 and sends no approve (`Bun.spawn`, no TTY). That file has no `[llm]` section, so A4 holds end to end. **UNVERIFIED: whether this sandbox-gated suite runs on the Linux CI leg** (memory:
  stock Ubuntu 24.04 starts no sandboxed child); the always-on proof is the integration file above.
- Tests to repair, by name: `capture-rpc.test.ts` (the `rejected` outcome shape, wiring helper), `test/integration/mcp-sink/capture-action-flow.test.ts`, `capture-action-routing.test.ts`,
  `lan-rpc.test.ts`, `packages/cli/src/mcp/capture-tools.test.ts`, `commands/captures.test.ts`, `commands/mcp-server.test.ts`, `commands/help.test.ts`, the captures-format doctor tests.

### Task 10 - Docs (the five core docs every PR, CHANGELOG, SECURITY-INVARIANTS, skills)

- `CLAUDE.md` and `GEMINI.md` (identical): the status paragraph gains one "Phase 28 AD2" sentence (the owner's queue and one-step approval: `nimbus approvals`, human-only, declared `cli`/`ui` only,
  `capture.state` ownership, per-connection cap of 3, count-only toast; D32(b)/(c) amended to two RPC modules; no migration, no new invariant, schema stays V96); the I28 line per Task 8. Run
  `bun run audit:status-drift` (no `schema` or ceiling change expected).
- `docs/roadmap.md`: Phase 28 *One approval step* ticked for the terminal, dated (the desktop surface remains the later row); *The same prompt* gains the AD2 progress note and stays `[ ]`
  (typed confirmation on a REAL Wave 4 proposal waits for AD3a, correction 4); Phase 28 stays Planned.
- `docs/architecture.md`: IPC table (`:3071-3081`) gains `approvals.*` and `capture.mine`; the `capture.state` row says "ONE capture id the asking connection submitted"; "Static D32" paragraph per Task 5;
  the act-door section describes the approval path.
- `docs/README.md`: the status paragraph gets the AD2 sentence.
- `docs/cli-reference.md`: a new `### nimbus approvals` section; the `captures accept` action paragraph (`:1767-1790`) says it is an alias for actions and points to `approvals`; the MCP section's
  `captures accept` mentions (`:1687`, `:1694`, `:1704`) say `nimbus approvals <id>` for actions; `nimbus mcp-server` help block.
- `docs/CHANGELOG.md`: dated entry: what the owner can now do, the human-only rule, the cap, ownership, 128-bit ids, the amended rules, the bounds, and what did not change (reach, the 47 types).
- `docs/SECURITY-INVARIANTS.md`: Tasks 5 and 8.
- Skills: `.claude/commands/nimbus-mcp-sink.md`, `nimbus-file-map.md`, `nimbus-ipc.md` only if it lists the namespaces (grep first; unchanged otherwise, say why).

### Task 11 - Verification (run sequentially, never beside each other; a failing step hides later ones, so run each)

1. `bun run typecheck` and `bun run typecheck:tests` (the baseline must not grow; `test/integration/mcp-sink/approvals-flow.test.ts` is in the covered tree).
2. `bun run preflight:fast` (types, Biome, `audit:invariants`, `audit:status-drift`, `audit:doc-refs`, `audit:cross-platform`).
3. `bun test packages/gateway/src/mcp-sink packages/gateway/src/ipc packages/gateway/src/engine/proposer-block.test.ts`, then `bun test packages/gateway/src`.
4. `bun test packages/gateway/test` (a `src` run does not load `test/`; the integration file and the e2e are here).
5. `bun test packages/cli` and `bun test scripts`; `bun run audit:invariants` once more after any later edit to the checker.
6. UI: `bun run --cwd packages/ui test -- Captures`; Rust: `cargo test -p <ui crate> allowlist_` where Rust is installed (else say so; CI runs it).
7. Coverage: every new file (`approvals-rpc.ts`, `capture-id.ts`, `capture-toast.ts`, `approvals.ts`) and the touched branches of `capture-gate.ts` meet 85% lines / 80% branches
   (`audit:coverage-floor` is CI-Linux-authoritative: `bun run verify:docker --changed`). The branch floor risk is `approvals-rpc.ts`'s refusal arms: Task 4's table covers each.
8. Red-proofs recorded in the PR: revert (a) the `captureStateFor` ownership line, (b) the `humanOnlyConsent` wrapper, (c) the per-connection check, (d) the D32 allow-list lines, (e) `"approvals"` in
   `FORBIDDEN_OVER_LAN`, (f) the TTY check; each named test must go red.
9. Known LOCAL baselines (memory), not this branch: six migration e2e fail beside `packages/cli/src` in one process; five `install.ps1`/gpg tests fail on this machine; build the sandbox helper on Windows; no
   sandbox test beside a background preflight. Anything else red is this branch.
10. Re-check `git rev-parse --abbrev-ref HEAD`, then strip `docs/superpowers/**` from the branch before the PR.

## Spec coverage (spec § 2, § 4, § 6 AD2 row, § 7.2, § 9, § 10 AD2, mapped to a task STEP)

| Requirement | Where implemented |
| --- | --- |
| `approvals.list/get/approve/decline`, `nimbus approvals` list / show / approve / `--decline` / `--decline-all-from` (§ 7.2) | Task 4 (gateway), Task 7 steps 1-2 (CLI); correction 6 |
| ONE owner action, no `captures accept` first (OR-AD-1, A3) | D-4, D-8; Task 7 step 1 (recorded calls), Task 9 A3 |
| Full model-door prompt at approval (OR-AD-1, A1) | AD1's executor prompt via `buildActDeps`; Task 9 A1 (rendered-text equality) |
| Wave 4 typed confirmation, denied for empty/wrong-case/trimmed/echo (A2) | Task 9 A2 on a synthetic row; correction 4 |
| TTY only, no `--yes` (OR-AD-6) | Task 7 (CLI guard, usage errors, `human` choice); Task 4 (gateway human-only wrapper) |
| `unknown` kind refused on the new methods only (D-AD-16) | `APPROVER_BY_KIND`, Task 4; `captures.*` unchanged (Task 9 pins it) |
| D32(b)/(c) amended to two RPC modules, fixtures per form, `security-invariants.test.ts` I28 block (§ 7.2 deliverable) | Task 5 steps 1-4 (same commit as Task 4) |
| `capture.state` ownership, `capture.mine`, unguessable ids (D-AD-11) | Task 1; correction 2 |
| Per-connection cap `min(3, actionMaxPending)`, fixed refusal (D-AD-12) | Task 2, D-6 |
| Count-only notification (D-AD-12) | Task 3, D-7 |
| LAN denylist entry plus a test that enumerates every `approvals.*` (§ 7.2) | Task 6 |
| Not on the Tauri allowlist (I7 unchanged) | Task 6 Rust test; Task 5 step 4(a) |
| No HTTP route (I13 unchanged) | no `WRITE_ROUTE_ALLOWLIST` edit; stated in the PR |
| No model needed (A4) | Task 9 A4 (integration + e2e config) |
| Refusal at approval finalizes the row and tells the owner | Task 2 (reason threading); correction 1 (no stored code) |
| Five core docs, CHANGELOG, SECURITY-INVARIANTS | Task 10 |
| `agentOffered`, V97, D49, I58, the hash, `--door agent` | NOT AD2 (AD3a) |

## Risks / open questions

- **Owner / reviewer decisions:** (1) correction 1: the agent cannot tell a decline from a guard refusal until AD3a's rebuild relaxes the CHECK; (2) correction 3: `captures.accept` on an action stays
  permissive at the gateway; (3) correction 7: no `capture_mine` MCP tool yet; (4) the per-connection refusal reuses `ERR_CAPTURE_QUEUE_FULL`; (5) the desktop string change in `format.ts`.
- **The pinned human-only rule changes what a scripted owner can do.** Anyone running `nimbus captures accept <id>` with `NIMBUS_SCRIPT_CONSENT_SOURCE` for an action gets a decline once the CLI alias
  routes through `approvals.approve` with the `human` choice. Intended (OR-AD-6); the CHANGELOG says so.
- **`Ctrl-C` at the prompt rejects the proposal permanently** (a disconnect is a decline in the executor). A user who wants to defer simply does not approve; the row expires. Stated.
- **A reconnecting MCP adapter loses its ids** (new `session_id`): `capture_status` then reports not found; the owner still sees the row. This is the spec's stated bound, now actually true.
- **The per-connection scan.** Without a `session_id` index the count scans `proposed` rows via the state index; with `actionMaxPending <= 100` this is negligible. If review prefers an index it is a migration
  (not AD2).
- **Test churn.** `ActExecuteOutcome` gaining `reason?` and the per-connection cap touch ~15 existing tests (Task 2 lists the queue-full ones; `typecheck` names the rest). Do them first so a rewritten
  expectation cannot absorb a behavioural change.
- **Sandbox-gated e2e** (UNVERIFIED on the Linux leg, Task 9). The integration file is the always-on proof.
- **The toast depends on the notification service** (`NIMBUS_NOTIFICATIONS=off` in tests; the service drops on rate limit): a missed toast never loses a proposal; `nimbus approvals` and `nimbus doctor`
  show it.
- Live connector reply shapes for before-state readers are read from mappers and tests, not verified against live accounts (as AD1).

## PR

Title (conventional commit, no `!`; nothing requires a user to act, and reach is unchanged):

`feat(gateway): add nimbus approvals, so the owner lists proposals from MCP agents and approves one in a single step at the terminal`

Description: the delta (the seven points), the corrections (short), the amended rules and invariant text, the stated bounds, the red-proofs, the verification output. If #1993 is still open, the PR is stacked and
its base is `dev/asaf/p28-ad1`. End with the attribution lines from the session. No `Release-As:` trailer.

## Review log

- Antigravity round 1 (2026-11-13): CHANGES REQUIRED, 6 findings. Applied: F1 (object spread into `showIgnoringFailure`: pass `t.title, t.body`), F2 (D32 allow-list entries are full `packages/gateway/src/...` paths), F3 in part (`captures/format.ts` exists on the AD1 branch, the review bundle omitted it; it has no test of its own, the test is `test/pages/Captures.test.tsx`). F4, F5: the reviewer agrees with corrections 1 and 5. F6: already the plan's position (the integration file is the always-on proof).
