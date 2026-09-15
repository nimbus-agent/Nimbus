# `nimbus tool run` — owner-initiated invocation of a saved generated tool

**Status:** design approved 2026-09-15. Implementation not started.
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

### 3.1 Saved tools only

`nimbus tool run` targets a **saved** tool. It does not invoke a live, create-time-approved tool
still held in the session registry. Three reasons:

1. **I40's guarantee is about saved artifacts.** `readVerifiedSavedTool` re-verifies the on-disk
   signature before every spawn. A live tool has no on-disk artifact and no signature, so the
   property that makes repeated invocation safe does not exist for it.
2. **A live tool's approval was ephemeral.** It was granted at create time, for that session.
   Re-using it for repeated later invocations widens what the owner agreed to without asking.
3. **It closes the documented gap exactly.** `spawnSavedTool` is the implemented, integration-tested
   path with no production caller; using it is precisely what the gap names.

**Cost, stated:** `nimbus tool create` alone still produces something you cannot run — you must
`nimbus tool save` first. That is a real ergonomic edge and it belongs in the docs, not in a
footnote.

## 4. The invocation path

```
toolgen.invoke(toolId, args)
  → capability check          [tool_generation] enabled AND org policy — both fail-closed
  → spawnSavedTool(toolId)    re-verifies the Ed25519 signature (I40)
  → handle.call(args)
  → handle.close()            in a finally
  → audit row                 exactly once, on every outcome
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

### 4.2 No new HITL prompt

A saved tool's standing approval already means, in the save prompt's own words, "run this in every
future session, unattended". Prompting per invocation would make that approval meaningless, and an
approval users learn to click through is worse than no approval, because it reads as a control
while functioning as a speed bump.

The existing withdrawal path is unchanged and is the honest answer to "I no longer want this to be
runnable": `nimbus tool revoke`, which the save prompt promises by name and which drops the live
child, the registry entry, the `generated_tool` row, the `saved/<toolId>` directory and the Vault
credentials together.

## 5. What gets recorded

One `audit_log` row per invocation, `actionType: "tool.invoke"`, written **directly** — the
`code.execute` shape (`exec-gate.ts:100`), not through the executor.

**Not added to the I2 frozen HITL set.** Nothing constructs an executor action of this type, which
is the same reason its three sibling capability gates — `code.execute` (I33), `computer.action`
(I35) and `tool.generate` (I39) — are correctly absent from it.

`hitl_status: "not_required"`, following I39's `recordToolEgress` precedent: the tool's
*registration* was approved, not each request. Note this reads correctly here in a way it
deliberately does not for `code.execute`, where I33 avoids the value because on that action type it
would imply "ran without needing approval".

**This is the honesty fix.** Today a generated tool that makes no network request leaves **no trace
whatsoever** — the I39 broker ledgers egress only, so a purely local model-authored tool running
against the owner's machine is invisible after the fact. One audit row per invocation closes that.

The row records the tool id, the outcome, and the duration. It does **not** record the tool's output.

## 6. What this does not do — stated in the docs

- **The model still cannot call a generated tool.** `deps.toolgen` stays unsupplied (§2).
- **The host allow-list bounds where, never what.** Unchanged from I39: an approved host may
  receive anything the tool can compute.
- **Check-then-connect remains.** Also unchanged from I39: Bun's `fetch` offers no connection
  pinning, so a host whose DNS an attacker controls can answer the validation and connection
  lookups differently.
- **A created-but-unsaved tool is not runnable** (§3.1).
- **No output is retained.** The audit row records that an invocation happened and how it ended,
  not what it returned.

## 7. Cost

- One IPC method + its dispatcher routing entry.
- One new **subcommand**, not a new command. `tool: runTool` is already in `COMMAND_HANDLERS`
  and `registry.ts` enumerates only the top-level `"tool"`, so neither needs touching — `run` is
  a new branch inside `commands/tool.ts` beside `create`/`save`/`list`/`revoke`/`credential`.
  (An earlier draft of this spec claimed both files were test-forced registration sites. That is
  true for a new top-level command, which this is not; verified before writing, not assumed.)
- Two places DO document the subcommand list and must be updated together, or the help output
  advertises a surface that does not match the code: `help.ts:86-89`, which enumerates
  `nimbus tool ...` forms, and `tool.ts:47`'s own usage string.
- One audit action type.
- No migration, no new invariant, no new egress class, no Tauri allowlist entry.

## 8. Testing

- **Unit** — capability refusals, including fail-closed when the org-policy accessor is absent.
- **Unit** — invalid `--input` JSON is refused with a usage error before the gateway is called.
- **Integration, against a real signed artifact** — invocation succeeds; and a *tampered* artifact
  is refused at spawn. The second is the I40 property and is the one worth having.
- **Integration** — exactly one audit row per invocation, on both the success and failure paths.
- **E2E over a real socket** — a handler wired into `toolgen-rpc.ts` without a dispatcher routing
  entry compiles, passes every unit test, and returns `Method not found` live. This repo has
  shipped that defect; only an E2E catches it.
- **Assert `ALLOWED_METHODS` is unchanged**, so the CLI-only claim is enforced rather than stated.
