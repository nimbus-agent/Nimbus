# `nimbus tool run` — owner-initiated invocation of a saved generated tool

**Status:** design approved 2026-09-15; revised 2026-09-15 after external review
(`2026-09-15-nimbus-tool-run-review.md`). Implementation not started.
**Closes:** the disclosed S2 gap — "no path invokes a generated tool at all this release".
**Schema:** none. **Invariant:** none new (I40 is exercised, not extended). **Egress class:** none new. **HITL action type:** none new.

---

## 1. Why

S2's runtime-tool-generation row is marked closed at "PR 3 of 3: persistence". A user can
create a tool, have a model draft its body, approve it, save it under an Ed25519 signature, bind
per-host credentials to it, and list it. **They cannot run it.**

CLAUDE.md states this plainly rather than hiding it:

> NO path invokes a generated tool at all this release: there is no `toolgen.invoke` IPC method
> and no CLI subcommand that calls one, so a saved tool is spawnable in-process
> (`spawnSavedTool`, exercised by an integration test) and nothing more.

So this is a disclosed gap, not a silent one — but it is still a capability the roadmap counts as
delivered and a user cannot reach. This slice makes it reachable, on the narrowest honest terms.

**The engineering is small because the primitives exist.** `GeneratedToolHandle.call(args)` is
implemented (`toolgen-client.ts:64`) and `spawnSavedTool(toolId, deps)` returns a handle
(`toolgen-saved-spawn.ts:200`). What is missing is a `(toolId, args) → result` path, a surface to
reach it from, and a record that it happened.

## 2. Scope: CLI/owner-only, exactly as `nimbus exec` was bounded

The model stays unable to call a generated tool. `engine/agent.ts:607`'s `toolsFor()` consumes an
optional `deps.toolgen` and passes it to `buildGeneratedTools`; `gateway-main.ts` does not supply
it, and **this slice does not change that**.

The reason is the one I33 recorded for `nimbus exec`'s first slice, and it transfers exactly:

> CLI/owner-only in this slice — the LLM cannot invoke an execution, so no indexed untrusted text
> reaches the prompt; that is what makes one human approval a sufficient boundary, and it is the
> assumption to re-examine first when an agent-callable path lands.

Model-reachability here is materially larger than it looks. The agent's prompt carries indexed
content the owner did not write — Slack messages, ticket bodies, web clips — and I39's broker
bounds **where** a tool may send, never **what**. An instruction injected into an indexed document
could therefore steer an already-approved tool into sending index content to an already-approved
host, with no new consent event anywhere. That deserves its own consent-UX pass, which is the same
treatment agent-initiated tool *proposal* already has.

## 3. Surface

```
nimbus tool run <tool-id> [--input '<json>'] [--json]
```

New IPC method **`toolgen.invoke`** in `ipc/toolgen-rpc.ts`, alongside the seven already served
(`create`, `save`, `list`, `revoke`, `credentialSet`, `approvalRespond`, `saveApprovalRespond`).

**No new LAN or Tauri entry is required, and that is verified rather than assumed.** The whole
`toolgen` namespace is already in `FORBIDDEN_OVER_LAN`, and `checkLanMethodAllowed` matches on
`method.split(".")[0]` — so a namespace entry genuinely covers methods added later. The namespace
is likewise absent from the Tauri allowlist. The `ALLOWED_METHODS` count is unchanged, and that
should be asserted.

### 3.1 The IPC contract

```ts
export interface ToolgenInvokeParams {
  readonly toolId: string;
  /** Defaults to an empty object — a tool with no required inputs runs as `nimbus tool run <id>`. */
  readonly input?: Record<string, unknown>;
  /** `SavedSpawnDeps.sessionId`. The CLI passes a constant; the gateway defaults it. */
  readonly sessionId?: string;
}

export type ToolgenInvokeOutcome =
  | { status: "executed"; toolId: string; result: unknown; durationMs: number }
  | { status: "failed"; toolId: string; error: string; durationMs: number }
  | { status: "refused"; toolId: string; code: string; reason?: string };
```

**`input`, not `args`.** The CLI flag is `--input`, the artifact field is `inputSchema`, and the
IPC parameter should not be the one place that calls it something else.

**Three outcomes, not two, because "the gateway refused to run it" and "it ran and threw" are
different facts** and a caller — human or script — acts differently on each. Collapsing them into
one error channel makes a capability-disabled message indistinguishable from a tool bug.

### 3.2 Headless by design

`nimbus tool run` **does not require an interactive TTY** and works in CI, shell scripts and
headless automation. `runCreateCmd` and `runSaveCmd` both refuse without one (`tool.ts:609`,
`:905`) because they must obtain human consent and a piped `y` is not consent. `run` obtains no
consent, so that bar does not apply.

Worth stating rather than leaving implicit, because it is the operational meaning of the standing
approval: saving a tool authorises it to run later **with no human present**. Someone deciding
whether to save a tool should see that spelled out, not have to infer it.

### 3.3 Input validation — light, and honestly labelled

Before spawning, the gate rejects an `input` that is not a non-null, non-array object, and rejects
one missing a property named in the artifact's `inputSchema.required`. Both refuse with
`ERR_TOOLGEN_INPUT_INVALID` **before** paying process-spawn cost, so the common typo is a fast,
clear error.

**This is not full JSON Schema validation and the docs must not imply it is.** Types, formats,
nested constraints and additional-property rules are not checked; the tool body sees what it is
given. Promising "validated against the schema" while checking only required-key presence would be
a claim the code does not keep.

### 3.4 Exit codes

| Outcome | Code |
| --- | --- |
| Executed | `0` |
| Tool ran and failed (body threw, protocol timeout) | `1` |
| Gateway refused (capability off, policy off, not saved, bad signature, bad input) | `TOOL_EXIT_CODES.refused` (127) |

`TOOL_EXIT_CODES` already carries `denied: 126` / `refused: 127` (`tool.ts:13`). Invocation adds an
execution phase those two do not cover, and a script must be able to tell "Nimbus would not run
this" from "it ran and broke" — §3.1's distinction, surfaced at the process boundary.

### 3.5 Saved tools only

`nimbus tool run` targets a **saved** tool. It does not invoke a live, create-time-approved tool
still held in the session registry. Three reasons:

1. **I40's guarantee is about saved artifacts.** `readVerifiedSavedTool` re-verifies the on-disk
   signature before every spawn. A live tool has no on-disk artifact and no signature, so the
   property that makes repeated invocation safe does not exist for it.
2. **A live tool's approval was ephemeral.** It was granted at create time, for that session.
   Re-using it for repeated later invocations widens what the owner agreed to without asking.
3. **It closes the documented gap exactly.** `spawnSavedTool` is the implemented,
   integration-tested path with no production caller; using it is precisely what the gap names.

**Cost, stated:** `nimbus tool create` alone still produces something you cannot run — you must
`nimbus tool save` first. That is a real ergonomic edge and it belongs in the docs, not a footnote.

## 4. The invocation path

Encapsulated in a new **`toolgen/toolgen-invoke-gate.ts`**, following `toolgen-gate.ts` (create)
and `toolgen-save-gate.ts` (save). `ipc/toolgen-rpc.ts` stays parameter extraction and dispatch;
the gate owns capability checks, verification, lifecycle and the audit row, and is unit-testable
with an in-memory DB and a fake spawn.

```
invokeSavedTool({ toolId, input, sessionId }, deps)
  -> capability check       [tool_generation] enabled AND org policy, both fail-closed
  -> input shape + required  refuse BEFORE spawning (3.3)
  -> spawnSavedTool(toolId)  re-verifies the Ed25519 signature (I40)
  -> registry assurance      4.3
  -> handle.call(input)      60s protocol bound already exists in toolgen-client.ts
  -> handle.close()          in a finally
  -> audit row               exactly once, on every outcome
```

**The capability check fails closed when the policy accessor is absent**, matching
`toolgen-capability.ts`'s existing boot passes. A capability that is off must never advertise
itself by doing work first.

### 4.1 Spawn per call — no warm pool

Every invocation spawns, calls, and closes. No handle is retained between invocations.

This is a security decision, not a simplicity one. I40 requires the signature to be re-verified
**immediately before the tool actually runs**, never trusting an earlier pass. A pooled child
verifies once at spawn and then serves every later call unverified — which turns I40's third
verification point into decoration and reopens exactly the filesystem-write attack the signature
defends against.

The cost is process-spawn latency per call. Accepted, and stated in the docs.

### 4.2 Concurrent invocations of the same tool must be serialised

`spawnSavedTool` calls `rewriteSavedToolScript`, which re-emits
`<configDir>/toolgen/saved/<id>/index.ts` from the verified body on **every** spawn. That rewrite
is the security property — "never read index.ts back and trust it" — so it cannot be skipped or
made conditional on existing content.

Two concurrent `nimbus tool run <same-id>` calls therefore write the same path while another child
may hold it open. On Windows that is a transient `EBUSY`/file-lock failure, which makes this a
platform-equality problem (non-negotiable #5), not a tidiness one.

**Serialise per `toolId`** with an in-process promise chain — the same shape I35 already uses to
serialise concurrent `computer.act` calls on one lane. Different tool ids stay concurrent.

### 4.3 The registry must hold the verified artifact, or the tool runs crippled and silent

`platform/assemble.ts:3941` resolves the broker's approved hosts as:

```ts
approvedHostsFor: (toolId) => toolgenRegistry.findArtifact(toolId)?.approvedHosts ?? []
```

**That `?? []` is a silent degradation.** A saved tool invoked while its artifact is absent from
the registry gets an empty host allow-list, so every brokered fetch is refused — the tool runs,
does nothing useful, and reports a network failure that looks like the remote host's fault. The
owner has no way to see that the real cause was a registry miss.

So the invoke path must **ensure the registry holds the freshly verified artifact** before calling,
and if it cannot, **refuse loudly** with a named code rather than proceeding into a crippled run.
The boot passes already populate the registry for saved tools; this closes the window where a tool
saved after boot, or repaired later, would otherwise run with no hosts.

### 4.4 No new HITL prompt

A saved tool's standing approval already means, in the save prompt's own words, "run this in every
future session, unattended". Prompting per invocation would make that approval meaningless, and an
approval users learn to click through is worse than no approval, because it reads as a control
while functioning as a speed bump.

The existing withdrawal path is unchanged and is the honest answer to "I no longer want this to be
runnable": `nimbus tool revoke`, which the save prompt promises by name and which drops the live
child, the registry entry, the `generated_tool` row, the `saved/<toolId>` directory and the Vault
credentials together.

### 4.5 Error codes

Added to `toolgen-types.ts` beside the existing `ERR_TOOLGEN_*` set:

| Code | Condition |
| --- | --- |
| `ERR_TOOLGEN_INVOKE_DISABLED` | `[tool_generation] enabled = false` |
| `ERR_TOOLGEN_INVOKE_POLICY_DISABLED` | org policy disables `tool_generation` (I22) |
| `ERR_TOOLGEN_NOT_SAVED` | no `generated_tool` row, or the id names an ephemeral-only tool |
| `ERR_TOOLGEN_PUBKEY_UNAVAILABLE` | the Vault holds no `toolgen.signing.pubkey` to verify against |
| `ERR_TOOLGEN_INPUT_INVALID` | `--input` is not a JSON object, or a `required` key is missing |
| `ERR_TOOLGEN_EXECUTION_FAILED` | the tool body threw |
| `ERR_TOOLGEN_EXECUTION_TIMEOUT` | no reply within the protocol bound (`DEFAULT_PROTOCOL_REQUEST_TIMEOUT_MS`, 60s) |

`ERR_TOOLGEN_SIGNATURE_INVALID` already exists and is reused unchanged — a verification failure at
invoke is the same fact it already names.

## 5. What gets recorded

One `audit_log` row per invocation, `actionType: "tool.invoke"`, written **directly** — the
`code.execute` shape (`exec-gate.ts:100`), not through the executor.

**Not added to the I2 frozen HITL set.** Nothing constructs an executor action of this type, which
is the same reason its three sibling capability gates — `code.execute` (I33), `computer.action`
(I35) and `tool.generate` (I39) — are correctly absent from it.

`hitl_status: "not_required"`, following I39's `recordToolEgress` precedent: the tool's
*registration* was approved, not each request. This reads correctly here in a way it deliberately
does not for `code.execute`, where I33 avoids the value because on that action type it would imply
"ran without needing approval".

The payload carries exactly the outcome, the tool id, the duration, and — on a refusal or failure —
the code and error string.

**Neither the input nor the output is recorded, and the asymmetry with `code.execute` is
deliberate.** I33 records an execution's body in full because the owner approved those exact bytes
and the record is what proves it. Here the body was approved at save time and already sits on disk
under signature; what differs per call is the *input*, which is ordinary runtime data and can carry
anything the owner typed — a search term, an address, an API parameter. Recording it would turn an
audit trail into a second copy of the user's data, in a table with a different retention story.

**This is the honesty fix.** Today a generated tool that makes no network request leaves **no trace
whatsoever** — the I39 broker ledgers egress only, so a purely local model-authored tool running
against the owner's machine is invisible after the fact. One audit row per invocation closes that.

## 6. What this does not do — stated in the docs

- **The model still cannot call a generated tool.** `deps.toolgen` stays unsupplied (§2).
- **The host allow-list bounds where, never what.** Unchanged from I39: an approved host may
  receive anything the tool can compute.
- **Check-then-connect remains.** Also unchanged from I39: Bun's `fetch` offers no connection
  pinning, so a host whose DNS an attacker controls can answer the validation and connection
  lookups differently.
- **A created-but-unsaved tool is not runnable** (§3.5).
- **Input validation is presence-only, not schema conformance** (§3.3).
- **Neither input nor output is retained** (§5).

## 7. Cost

- One new **subcommand**, not a new command. `tool: runTool` is already in `COMMAND_HANDLERS` and
  `registry.ts` enumerates only the top-level `"tool"`, so neither needs touching — `run` is a new
  branch inside `commands/tool.ts` beside `create`/`save`/`list`/`revoke`/`credential`. (An earlier
  draft claimed both files were test-forced registration sites. That is true for a new top-level
  command, which this is not; verified before writing, not assumed.)
- Two places DO document the subcommand list and must be updated together, or the help output
  advertises a surface the code does not have: `help.ts:86-89` and `tool.ts:47`'s usage string.
- One IPC method: an entry in `toolgen-rpc.ts`'s `HANDLERS` map. **No outer dispatcher entry is
  needed** — `dispatchers.ts:1242` routes by PREFIX (`if (!method.startsWith("toolgen."))`), not by
  enumerating methods, so the map entry is the routing. (An earlier draft claimed a separate entry
  was required, generalising from `diagnostics-rpc`, which does enumerate. Verified, not assumed.)
- One new gate module, seven error codes, one audit action type.
- No migration, no new invariant, no new egress class, no Tauri allowlist entry.

## 8. Testing

| Layer | What it pins |
| --- | --- |
| CLI parse | `run <id> [--input <json>] [--json]`; invalid JSON and a missing tool id are usage errors, and the gateway is never called |
| CLI render | string result, object result, no-output, and exit codes 0 / 1 / 127 distinguished |
| IPC dispatch | `toolgen.invoke` resolves through `dispatchToolgenRpc`'s `HANDLERS` map and returns the outcome union |
| LAN guard | `checkLanMethodAllowed("toolgen.invoke", peer)` **throws** — asserted by calling it, not by grepping the source |
| Tauri | `ALLOWED_METHODS` unchanged, asserted by count and by absence |
| Gate | capability off; org policy off; policy accessor absent so fail-closed; unknown tool; **tampered artifact refused at spawn (I40)** |
| Gate | exactly one audit row for executed / failed / refused, and neither input nor output appears in it |
| Gate | `ERR_TOOLGEN_INPUT_INVALID` refuses **before** any spawn — asserted with a spawn fake that records calls |
| Concurrency | two concurrent invocations of the same tool id both succeed (§4.2) — the case that fails on Windows without serialisation |
| Registry | a saved tool whose artifact is absent from the registry refuses loudly rather than running with an empty host list (§4.3) |
| Integration | save then run, end to end against a real signed artifact, with a fake broker |
| E2E over a real socket | the CLI reaches the gateway and gets a result back. NOT for a routing gap — the prefix match makes that unreachable — but because nothing below this layer exercises CLI plus IPC plus gate plus spawn together |
