# Plan — Agent door AD3a-2b: `capture.describe` and the `describe_actions` MCP tool

Status: DRAFT for review. One PR, stacked on AD3a-2a (PR #2001). One read method, one MCP tool, no enforcement claim, no new invariant, no new static rule, no migration.
Spec: `docs/superpowers/specs/2026-11-13-agent-door.md` D-AD-10 (`:164-170`), § 6 order note (`:233-234`), § 7.7 (`:589`), § 9 (I11 sentence `:620-621`, downgrade row `:643`), § 10 AD6b (`:683-687`), § 12. Plan: `docs/superpowers/plans/2026-11-13-ad3a-2-door-enforcement.md`, "AD3a-2b in outline" (`:327-334`) and OD-3, settled as **OR-AD-16**.
Roadmap row: Phase 28 *Write parity with the model door* (`docs/roadmap.md:3077`).
Base: worktree `C:\gitrep\Nimbus\.claude\worktrees\p28-ad3a-2a`, HEAD `d39d55a59`. Paths are relative to `packages/gateway/src/` unless they start with `packages/`, `scripts/`, `docs/` or `.claude/`.

**The base moved while I read it.** Another session has uncommitted edits in that worktree (at my last check: `connectors/connector-writes/agent-door-{definition,runtime}.ts`, `agent-door-runtime.test.ts`, `security-invariants.test.ts`, `scripts/structure-audit/check-nimbus-invariants.{ts,test.ts}`, and three `packages/cli/src/commands/connector-writes-cli*` files). Line numbers in those files are as I read them and may be off by up to about 30 lines; the symbol name is the anchor. Task 0 re-reads them.

After this slice an `mcp`-kind connection can ask which action types the door accepts now and get, for the approved ones it names, the model door's own description and input schema. Nothing else changes: what is accepted, refused, approved or dispatched is exactly AD3a-2a's.

## The behavioural delta

- **New for an agent:** `describe_actions` with no arguments lists the types (state, wave, typed-confirmation flag, bound flag); with `actionTypes` it returns a description and JSON Schema for each approved, verified type. Under OR-AD-16 an approved agent learns the approved Terraform directories and Kubernetes context and namespace names.
- **New side effects:** a detailed call can list, and so start, a connector that has an approved type the call names. A detailed call that is first to see a changed definition marks the suspension and writes its one audit row, as a submit does.
- **Changed text:** `propose_action`'s description stops appending the type list and points to `describe_actions` (the approved outline, item 3).
- **Unchanged:** `capture.status`, `capture.submit`, `capture.state`, `capture.mine`, every `captures.*` and `approvals.*` method, the gate order, I58, D32, D49, the LAN and Tauri lists.

## Spec and brief versus code: corrections

1. **`offeredInputSchema` does not return JSON.** The outline says the schema "is `offeredInputSchema` with the bound fields removed (`:408-411`)". It returns a Mastra `StandardSchemaWithJSON` (`engine/user-mcp-agent-tools.ts:114-122`), which cannot cross IPC, and the call is now at `engine/connector-write-agent-tools.ts:359-362`. Resolution: extract the JSON step as `offeredInputJsonSchema(listed, omit): Record<string, unknown>` in the same file and make `offeredInputSchema` wrap it with `toStandardSchema`. The model door's call stays byte-for-byte, because a source pin matches it (`security-invariants.test.ts`, test "the offered schema drops the bound head", about `:13854-13861`).
2. **`describeFor` is module-private and has no fixed end line `:310`.** It is at `engine/connector-write-agent-tools.ts:237-263`. Resolution: export it (design decision D-4).
3. **`capture.status` has no role check.** The brief says the submit role may call `capture.describe` "as `capture.status` and `capture.mine` do". `captureStatus(deps)` takes no caller (`mcp-sink/capture-gate.ts:1139`), `docs/architecture.md:3074` says "any local client", and `packages/cli/src/commands/doctor-core.ts:809` calls it from the CLI. The submit-role precedents are `capture.state` (`capture-gate.ts:1045-1050`) and `capture.mine` (`:1073-1078`). Resolution: `capture.describe` follows those two.
4. **The model door rebuilds the description; it does not pass it as-is.** A non-bound row gets a fixed lead, then the listed text inside `wrapToolDescription`, capped so the whole is at most 1000 characters (`:244`, `:259-262`, `:103`). A bound row gets the gateway's own text and never the connector's, because the connector's text names the bound field (`:115-123`, `:245-255`). The spec's "the connector's description ... (escaped)" (`:165-166`) is therefore true only for non-bound rows. Resolution: the agent gets exactly the model door's string.
5. **A legacy type has no listing path.** `verifyDefinition` runs for the `approved` basis only (`capture-gate.ts:475`, `if (basis !== "approved") return`). Resolution: OD-2.
6. **The spec names user-MCP in D-AD-10, but its definition hash and `--agent` grant are AD5** (spec `:224`). Resolution: OD-1.
7. **`describe_actions` cannot be "every type the door would accept NOW" in one reply.** One rebuilt schema may be 32,768 characters (`engine/user-mcp-input-schema.ts:52`, `:330`), and 108 rows are reachable. Resolution: two modes with caps (D-1, D-6).
8. **The definition texts are not new to the agent.** Submit already returns `${type}: ${outcome.detail}` (`capture-gate.ts:494-501`) with the fixed texts of `DEFINITION_REFUSALS` (`agent-door-runtime.ts:112-121`). Reusing them leaks nothing new. The hash prefixes and the approval date exist only in `DoorSuspension` (`agent-door-definition.ts:33-40`), which this slice never returns.
9. **The scope-gated gap is real and documented.** `createAgentDoor` is built without `grantedScopes` (`platform/assemble.ts:3944-3952`; the member is optional, `agent-door-runtime.ts:82`), and I58 bound (11) says so. Resolution: the summary may still name `gmail.thread.archive`; a detailed call reports it `unavailable` with the fixed "does not list this write now" text. No wiring change here.

## Owner decisions

- **OD-1 User-MCP (`mcp_*`) types.** (a) Describe them now through `wrapToolDescription` and `sanitiseUserMcpInputSchema`: an agent's read would then spawn owner-registered third-party code under the `--model` grant, with no hash to compare, on a rule AD5 replaces. (b) Not described until AD5: the summary carries the `mcp_<id>.*` patterns exactly as `capture.status` does (`agent-door-runtime.ts:353-355` at HEAD), and a named `mcp_*` type returns `undescribed` with fixed text. (c) Omit them entirely. Recommendation: (b).
- **OD-2 Legacy types.** (a) Type and the fixed deprecation line (`legacyNoticeFor`, `agent-door-legacy.ts:33-40`), no schema. (b) List every configured legacy service to give schemas: an agent's read would start connectors the owner never approved for agents, for types AD3b deletes. Recommendation: (a). Stated limitation: an agent gets no schema for a legacy type, as today; the deprecation line carries the command that fixes it.
- **OD-3 A describe call can start a connector.** (a) Live listing, bounded (D-6), stated as a bound beside I58 bound (5). (b) Store the approved definition at `enable` and describe from the copy: needs schema V98 and can show a definition the live check would refuse. Recommendation: (a); "accept NOW" needs the live check in any case.

## Sweeps: every site that must change

**A. Code.**
| Site | Change |
| --- | --- |
| `engine/user-mcp-agent-tools.ts:114-122` | add `offeredInputJsonSchema`; `offeredInputSchema` wraps it |
| `engine/connector-write-agent-tools.ts:237` | export `describeFor`; no other change |
| `connectors/connector-writes/agent-door-runtime.ts` | `AgentDoor.describe`; factor the post-listing half of `verifyDefinition` into one internal function both use; factor the `acceptedTypes` walk likewise |
| new `connectors/connector-writes/agent-door-describe.ts` | pure: one approved row plus its listing entry and scope to `{ description, inputSchema }` |
| `mcp-sink/capture-types.ts` | `ActionDescription`, `DescribeReply` |
| new `mcp-sink/capture-describe.ts` | `describeActions(deps, caller, params)`: capability, role, limiter, params, injected describer, reply cap |
| `ipc/capture-rpc.ts:61-65`, `:334-337` | `CaptureRpcCtx.describe?`; table entry `"capture.describe"` |
| `platform/assemble.ts:4811-4831` | `describe: { limiter: new CaptureAttemptLimiter(), actions: agentDoor.describe }` |
| `packages/cli/src/mcp/capture-tools.ts:22-39`, `:218-256`, `:318-331` | the new spec; `kind: "describe"`; `propose_action` text; drop the appended list |
| `packages/cli/src/commands/mcp-server.ts:73-80` | help text names `describe_actions` |
| `packages/ui/src-tauri/src/gateway_bridge.rs:866-875` | `assert!(!is_method_allowed("capture.describe"));` |

`ipc/server/dispatchers.ts:1615` already routes every `capture.` method; `ipc/lan-rpc.ts:240` already forbids the namespace. Neither changes.

**B. Static rules and pins.** No checker change. `createAgentDoor` keeps its two sites (`check-nimbus-invariants.ts:2164-2168`). `D32_GATE_FN_RE` names the five mutators only (about `:4370`), and `describeActions` is not one. The new `mcp-sink/` file must satisfy D32(f) (`D32F_FORBIDDEN_SPEC_RE`, about `:4516`): no import from `connectors/` or `engine/executor.ts`, type imports included. D39(a) is not triggered: neither new connectors file calls `createTool`. Pins to extend: `security-invariants.test.ts:4049` (regex gains `capture\.describe`), the I58 wiring test `:4626-4656` (one needle), `ipc/lan-rpc.test.ts:155-165`, `ipc/capture-rpc.test.ts:300-309`.

**C. Counts and texts.** `docs/architecture.md:3065-3066` and the IPC table after `:3083`; `docs/cli-reference.md:1642` and `:1689-1705`; `docs/SECURITY-INVARIANTS.md` I11 (`:264`), I28 AD3a-2a paragraph (`:932`), I58 bounds (`:1953`); `CLAUDE.md:56` and `:342` with identical edits in `GEMINI.md`; `docs/roadmap.md:3077`; `docs/CHANGELOG.md`; `.claude/commands/nimbus-mcp-sink.md:14`, `:158`, `:181-187`, `:246`. The `nimbus-ipc` skill showed no `capture.*` table in my grep (UNVERIFIED beyond that), so nothing to edit there. The I7 count is unchanged.

## Seam types compared

| Seam | Today | AD3a-2b |
| --- | --- | --- |
| `AgentDoor` (`agent-door-runtime.ts:96-109`) | `verdict`, `refusal`, `verifyDefinition`, `acceptedTypes` | plus `describe(actionTypes: readonly string[] \| undefined): Promise<readonly ActionDescription[]>` |
| `ActionDescription` (new, `mcp-sink/capture-types.ts`; connectors already import sink types, `agent-door-runtime.ts:24`) | none | a union on `state`: `approved` `{ wave: 2\|3\|4; typedConfirm: boolean; bound: boolean; description?: string; inputSchema?: Record<string, unknown> }`, `legacy` `{ deprecation: string }`, and `suspended`, `unavailable`, `undescribed`, `not_proposable`, each `{ reason: string }`; all carry `actionType: string` |
| `offeredInputSchema(listed: unknown, omit?: readonly string[]): StandardSchemaWithJSON` | one function | unchanged signature; plus `offeredInputJsonSchema(listed, omit): Record<string, unknown>` |
| `describeFor(row, service, listedDescription: string, workdirs: readonly string[], k8sPairs: readonly K8sPair[]): string` | private | exported, same signature; `K8sGrant` (`k8s-grants.ts:12-15`) is assignable to `K8sPair`, and only `context` and `namespace` are read (`:211-215`) |
| `CaptureRpcCtx` (`ipc/capture-rpc.ts:61-65`) | `gate`, `act?` | plus `describe?: { limiter: CaptureAttemptLimiter; actions: AgentDoor["describe"] }`; absent refuses |
| `CaptureGateDeps` (`capture-gate.ts:74-114`) | unchanged | unchanged, so no test construction site breaks |
| `CaptureToolSpec.kind` (`capture-tools.ts:33`) | `CaptureToolKind \| "status"` | plus `"describe"` |

## Design decisions

**D-1 Method.** `capture.describe { actionTypes?: string[] }` returns `{ actions: ActionDescription[]; truncated: boolean }`. No `actionTypes`: the summary, database and Vault reads only, no listing. With `actionTypes` (1 to 10 strings, each at most 128 characters, duplicates removed, at most 3 distinct services that need a listing): the detail. Anything else is `ERR_CAPTURE_INVALID` before any listing. Reviewer decision R-1: this replaces the outline's `{ service?: string }`, because one service can still exceed a useful reply and a no-argument call would otherwise list every approved service.

**D-2 Order in `describeActions`** (read top to bottom, like `submitCapture`): 1 capability, `actionEnabled` false is `ERR_CAPTURE_DISABLED`; 2 role, `CAPTURE_ROLE_BY_KIND[caller.kind] !== "submit"` is `ERR_CAPTURE_FORBIDDEN_CLIENT`; 3 the describe limiter, `ERR_CAPTURE_RATE_LIMITED`; 4 params; 5 the injected describer (absent is `ERR_CAPTURE_DISABLED`); 6 the reply cap. Refusals at 1 to 3 go to the gate's `CaptureRefusalCounter`; nothing is audited (reads are not, as `capture.state`).

**D-3 Which rows.** Summary: every type whose verdict is `proposable` on a configured service (the `acceptedTypes` set) as `approved` or `legacy`, plus types whose verdict is `suspended`, plus the `mcp_<id>.*` patterns as `undescribed`; at most 200, sorted. Detail, per named type, cheap checks first:
- `mcp_*`: `undescribed` (OD-1).
- verdict `suspended`: `suspended` with `DEFINITION_REFUSALS.suspended`.
- verdict `denied` or `unknown`: `not_proposable` with the class text submit gives (`capture-gate.ts:422`).
- service not configured: `unavailable` with submit's text (`:459`).
- legacy basis: `legacy` with `legacyNoticeFor`.
- `approved` basis: list the service once per call, then run the SAME post-listing function `verifyDefinition` uses, including the re-read of the approval after the await that the uncommitted AD3a-2a edit adds, and the Wave 4 reader and prepare check. `ok` gives `approved` with description and schema. `ERR_AGENT_TOOL_SUSPENDED` gives `suspended`. Every other failure gives `unavailable` with its fixed `detail`. A described type has therefore passed, in the same call, exactly what a submit would check; its input can still be refused (destination refusal, guards, size), and the tool text says so.

**D-4 Text and schema.** `description = describeFor(row, service, listedDescription, workdirs, k8sPairs)`, with `workdirs` from `getIacGrants(db).workdirs` and pairs from `getK8sGrants(db)`, each read at the call and empty on a throw (the shape of `model-write-source.ts:95-113`). `inputSchema = offeredInputJsonSchema(entry.inputSchema, row.bound?.binds.map(b => b.field) ?? [])`, so `expectedHeadSha`, `planFile`, `planSha256`, `changeSetId` and `diffSha256` (`commit-bound.ts:46`, `iac-bound.ts:83-84`, `:118`, `k8s-bound.ts:48-49`) are absent from `properties` and `required`. Reviewer decision R-2: export `describeFor` in place rather than move it to a new module.

**D-5 What never leaves.** No hash, no hash prefix, no approval date, no owner-side reason, no listing key, no credential or server address, no other connection's data. Reasons are the fixed strings already sent at submit.

**D-6 Bounds.** A separate `CaptureAttemptLimiter` instance (the class is keyed on nothing, `capture-rate-limit.ts:5-10`), cap `4 × max_per_hour`, so describes and submits cannot starve each other. Listings from describes: at most `3 × 4 × max_per_hour` an hour, and only for services with an approved type the call names. Reply cap 262,144 bytes of JSON, applied in request order: an entry that would cross it becomes `undescribed` ("ask for it alone") and `truncated` is true. `IPC_MAX_LINE_BYTES` comes from the SDK and I did not find its value (UNVERIFIED; Task 0).

**D-7 MCP tool.** Name `describe_actions`; schema `{ actionTypes: z.array(z.string()).optional() }` (never stricter than the gateway, the rule at `capture-tools.ts:114`); annotations `{ ...WRITE_ANNOTATIONS, readOnlyHint: true }`, as `capture_status` (`:267`), which also has gateway-side effects (`capture-gate.ts:1052`); registered when `actionEnabled`, between `propose_action` and `capture_status`. Result: one text block, `JSON.stringify(reply)`, as `capture_status` (`:273`); no `outputSchema`, no `structuredContent`, so it is identical in both MCP eras (spec `:687`).
I11 proper does NOT apply: no `wrapToolOutput`, no `tool_call_log` row, because this result goes to an outside agent's model, not ours. What applies: connector text is closer-escaped and delimited (`wrapToolDescription`), schema prose is closer-escaped and capped at 200 with unknown keywords dropped (`sanitiseUserMcpInputSchema`), every other string is fixed gateway text, and JSON encoding escapes C0 control characters. Bounds: enum and const values and property names are verbatim (as I42); how the outside agent treats a tool result is its own.
AD6b: nothing in the tree snapshots tool schemas today (no `toMatchSnapshot` in the adapter tests); AD6b's pre-swap snapshot will simply include this tool.

**D-8 Layering.** `mcp-sink/capture-describe.ts` imports only sink modules; the describer arrives as a function through `CaptureRpcCtx`, built in `platform/assemble.ts` from the one `createAgentDoor`.

## File map

New: `connectors/connector-writes/agent-door-describe.ts`, `mcp-sink/capture-describe.ts`, a test each.
Edited (gateway): `connectors/connector-writes/agent-door-runtime.ts`, `engine/{connector-write-agent-tools,user-mcp-agent-tools}.ts`, `mcp-sink/capture-types.ts`, `ipc/capture-rpc.ts`, `platform/assemble.ts`, `security-invariants.test.ts`, `ipc/{capture-rpc,lan-rpc}.test.ts`, `connectors/connector-writes/agent-door-runtime.test.ts`, `packages/gateway/test/integration/mcp-sink/agent-door-flow.test.ts`.
Edited (cli): `mcp/capture-tools.ts`, `mcp/capture-tools.test.ts`, `mcp/adapter.coverage.test.ts`, `commands/mcp-server.ts`.
Edited (ui): `packages/ui/src-tauri/src/gateway_bridge.rs`.
Docs: Task 7.

## Tasks (test first; red-prove each guard by reverting its production line and watching its test fail)

**Task 0 Preconditions.** Rebase on the final AD3a-2a head; re-read the files listed as moving and correct this plan's line numbers; read `IPC_MAX_LINE_BYTES` and lower the reply cap if needed; read `ipc/capture-rpc.contract.test.ts` and `check-nimbus-invariants.test.ts` (not read here); confirm every Wave 4 offerable row has `confirm`.

**Task 1 The shared builders.** Tests: `offeredInputJsonSchema` equals `standardSchemaToJSONSchema(offeredInputSchema(...))` for a plain, a bound and an unreadable listing; a bound field is absent from `properties` and `required` (red-proof: pass `[]` as `omit`). `agent-door-describe.ts`: a non-bound row's text equals `describeFor`'s; a description holding `</tool_description>` and `</tool_output>` has exactly one closer, at the end; a bound row's text does not contain the connector's description; the Terraform row lists the approved directories and a Kubernetes row the pairs (OR-AD-16) and never a server address.

**Task 2 `AgentDoor.describe`.** Extract the post-listing check first, with `verifyDefinition`'s existing tests green and unchanged. Then tests, in the I58 harness shape (`security-invariants.test.ts:4498-4603`): the summary equals `acceptedTypes()` plus suspended types and makes zero listing calls; every `approved` detail entry also passes `verifyDefinition` at that moment; a changed description gives `suspended` with no description, no schema and no hex run of 12 or more characters anywhere in the reply, and one `connector.writes.agent.suspend` audit row (red-proof: build the entry before the check); a missing tool, a drifted schema, an unbound mesh and a missing Wave 4 reader each give `unavailable` and mark nothing; a legacy type gives `legacy` and causes no listing (red-proof: list for legacy); an `mcp_*` type gives `undescribed`; two types of one service cause one listing.

**Task 3 `describeActions`.** Tests: the order of D-2 as a source pin; a `cli`, `ui` and `unknown` caller is `ERR_CAPTURE_FORBIDDEN_CLIENT` and the describer is never called (red-proof: drop the role line); `actionEnabled` false refuses; the limiter refuses call `4 × max_per_hour + 1` while a submit on the gate's own limiter still passes (red-proof: remove `tryAcquire`); 11 types, a 129-character type, a non-array and 4 services each refuse before the describer runs (red-proof per bound); a reply over the cap is cut in request order with `truncated: true` (red-proof: remove the cap).

**Task 4 IPC and wiring.** `ipc/capture-rpc.test.ts`: `capture.describe` routes for `mcp`, refuses for `cli`, and refuses `ERR_CAPTURE_DISABLED` with no `ctx.describe`; add the method to the list at `:300-309` and to `ipc/lan-rpc.test.ts:155-165` (red-proof: remove `"capture"` from `FORBIDDEN_OVER_LAN` locally). `security-invariants.test.ts`: the I58 wiring needle `actions: agentDoor.describe`, and the Tauri regex at `:4049`. `gateway_bridge.rs`: the negative assert (red-proof: add the entry line and watch both the Rust test and the `:4040-4041` pin fail). The Rust test command is UNVERIFIED; take it from the `nimbus-tauri-allowlist` skill.

**Task 5 End to end.** In `agent-door-flow.test.ts`, through the real dispatch entry: approve `github.pr.merge`, describe it, build an input from the returned schema, submit it, and see it queued; then change the listing and see `suspended` from describe and `ERR_AGENT_TOOL_SUSPENDED` from submit.

**Task 6 The MCP tool.** `capture-tools.test.ts`: name lists at `:318` and `:327` (`describe_actions` only with `actionEnabled`); annotations; no arguments sends `{}` and `actionTypes` is passed through; the result is the reply's JSON; a gateway refusal is an `isError` result with the code; `propose_action`'s description names `describe_actions` and no longer ends with a type list (rewrite `:340-350` and `:388-404`). `adapter.coverage.test.ts`: `tools/list` carries the tool with `readOnlyHint: true`.

**Task 7 Docs, one commit with the wiring where the triple rule asks.** I11 gains one sentence in `docs/SECURITY-INVARIANTS.md` and `CLAUDE.md:56` (identical in `GEMINI.md`): the results an outside agent reads are `capture_status`'s fixed fields and `describe_actions`, whose connector text is closer-escaped and whose schemas are rebuilt. I58 gains bounds: a describe can start an approved connector (D-6 numbers); an approved agent learns the approved directory paths and context and namespace names (OR-AD-16); a describe can record a suspension; legacy and user-MCP types carry no schema. Then the `docs/architecture.md` table row (`capture.describe`, `mcp` kind only), `docs/cli-reference.md`, the skill, the CHANGELOG entry (its heading format was not read: UNVERIFIED), and `docs/roadmap.md:3077`. Reviewer decision R-3: the AD3a-2 plan ticks that row after AD3a-2b; the legacy exception still runs until AD3b, so either tick it with that sentence or leave it open.

**Task 8 Verification, sequential, never two runs at once.** `bun test` on each new and edited test file; then the whole `packages/gateway/src/ipc` directory; then the whole `packages/gateway/src/security-invariants.test.ts`; then `packages/gateway/src/mcp-sink`, `packages/gateway/src/connectors/connector-writes`, `packages/gateway/src/engine/connector-write-agent-tools.test.ts`, `packages/gateway/test/integration/mcp-sink`, `packages/cli/src/mcp`, `scripts/structure-audit/check-nimbus-invariants.test.ts`; then `bun run audit:invariants`, `bun run typecheck`, `bun run typecheck:tests`, `bun run lint`, `bun run audit:doc-refs`, the Rust allowlist test, and `bun run preflight:fast`. No whole-repo suite locally.

## Spec coverage

| Spec item | Where |
| --- | --- |
| D-AD-10 type, wave, typed confirmation | D-1, D-3; Task 2 |
| D-AD-10 description and schema, escaped | D-4, D-7; Task 1 |
| D-AD-10 `suspended` with the fixed reason | D-3, D-5; Task 2 |
| D-AD-10 user-MCP | OD-1 (AD5) |
| OR-AD-16 scope lines | D-4; Task 1 |
| § 9 I11 sentence | Task 7 |
| § 9 owner-only IPC, LAN, Tauri | D-2; Tasks 3, 4 |
| § 10 AD6b "identical in both eras" | D-7 |
| § 7.7 "call `describe_actions` before proposing" | Task 6 |
| Legacy types (D-AD-15) | OD-2 |

## Risks

- **Reviewer decisions:** R-1 the params; R-2 exporting `describeFor` in place; R-3 the roadmap tick; R-4 dropping the type list from `propose_action` (an agent that never calls `describe_actions` loses the names; the summary is one call).
- **Version skew.** A newer CLI against an older gateway registers the tool and gets a method-not-found error result. Whether the two always ship together is UNVERIFIED.
- **Listing freshness.** `MCPClient.listTools` caching is still UNVERIFIED (the AD3a-2 plan's open item); describe inherits whatever `verifyDefinition` sees.
- **Connector start cost.** Whether a connector makes network calls when it starts is UNVERIFIED; `openWorldHint` stays `false` like the other capture tools.
- **The moving base.** The post-listing extraction touches the function the other session is editing; do Task 2 only after that edit is committed.
- **File size.** Whether a structure rule caps `agent-door-runtime.ts` is UNVERIFIED; the pure builder is a separate file to keep the growth small.

## PR

`feat(gateway): add describe_actions, the read tool that tells an outside agent which writes it may propose`

Description: the delta; corrections 1 to 9; OD-1 to OD-3 as ruled; OR-AD-16's bound; the new bounds on I58; the red-proofs; the verification output. No `!`, no `Release-As:` trailer. End with the session's attribution lines.

## Review log

(empty)
