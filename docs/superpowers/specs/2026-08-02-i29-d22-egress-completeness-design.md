# I29 / D22 egress-ledger completeness — security spec

> **Status:** security spec of record, 2026-08-02. Documents a verified gap between what `I29`
> claims and what `D22` enforces, enumerates every bypass, and proposes phased remediation. One
> finding exceeds record-honesty and has its own immediate-mitigation section.

> ## ⚠️ STALE IN PART — re-verified against `8d663237` on 2026-08-03
>
> **The `share.replay` execution risk described below is no longer live.** Four of the five
> immediate mitigations shipped after this document was written. Read that section as history, not
> as a current finding:
>
> | Mitigation (§ *Immediate mitigations*) | Status at `8d663237` |
> |---|---|
> | 1. Enforce the signature | ✅ `ipc/share-rpc.ts:298` — throws `ERR_UNVERIFIED_SHARE` unless `allowUnsigned` is passed |
> | 2. Remove `"preview"` from `READ_VERBS` | ✅ `share/read-tool-registry.ts:24-31` — removed, with the `iac_pulumi_preview` chain documented in-code |
> | 3. Validate step parameters | ⚠️ **partially closed 2026-08-03** — a shape guard (`hasSafeParamsShape`) now rejects non-object roots and prototype-pollution keys before `execute`. Per-tool `inputSchema` validation remains open: `LazyMeshToolMap` (`connectors/lazy-mesh/tool-map.ts:22-24`) exposes no schema. |
> | 4. Cap step count | ✅ `MAX_REPLAY_STEPS = 256`, excess reported as `summary.capped` |
> | 5. Don't spawn the mesh to enumerate tools | ✅ `ipc/share-rpc.ts:305-312` — resolved lazily, with the force-spawn bug cited in the comment |
>
> Note also that §*What is not wrong* is corrected by the code: `dataprofile_preview`, cited there
> as a real read tool, is a name the dataprofile no-row-data contract test asserts must **throw** —
> so removing the `preview` verb cost zero replay coverage.
>
> **Not re-verified:** the eleven-class bypass enumeration and the `ToolExecutor` sink-omission
> count. Those remain as written and still need confirmation before becoming commits, per this
> document's own *Verification status* section.
>
> Companion: [`2026-08-03-i29-ledger-completeness-design.md`](./2026-08-03-i29-ledger-completeness-design.md)
> covers the `fetch` modality and defers to this document on taxonomy, sink requirement and tier shape.

## Summary

`I29` states that the egress ledger is complete over the executor chokepoint, and `D22`'s own source
comment asserts totality: *"there is no escape hatch, no 'approved wrapper' carve-out … Any future
shortcut or custom-wrapper bypass therefore fails this preflight static check immediately."*

That assertion describes an intent, not a mechanism. `D22` is a **regex over source text** matching
the literal string `connectors.dispatch`. Any path that reaches the network without typing that
string passes, and eleven classes already do. For nine of them the harm is a **false completeness
claim** — `nimbus prove` printing a clean window that was not clean — rather than an attacker
gaining a capability. Two cross real trust boundaries, and one is a genuine pre-authentication
execution risk.

The remediation is ordered **truth before coverage**: the first phase makes the claim honest without
extending coverage at all, because a label that leads its mechanism is precisely the defect being
fixed.

## The claim, and why it is false

`D22` has two parts: `connectors.dispatch` may appear only in `engine/executor.ts`, and
`appendEgressEntry` is confined to `egress/`. Three independent falsifications:

1. **A wrapper already exists and passes.** `connectors/connector-write-dispatch.ts:21` is a literal
   `ConnectorDispatcher` decorator calling `inner.dispatch(action)`. It is benign today only by
   wiring accident. It is the "approved wrapper carve-out" the comment says cannot exist.
2. **A helper re-exposes execution under a new name and passes.**
   `teamvault/connector-session.ts:119-129` hands out a `session.call` façade.
3. **Three raw `tool.execute()` calls pass**, because a lazy-mesh tool is a bare
   `{ execute?(input, ctx) }` record (`connectors/lazy-mesh/tool-map.ts:22-25`) and calling it
   spells nothing the regex matches.

Two structural aggravators found alongside:

- **The sink is optional.** `engine/executor.ts:224` declares `egressSink?: EgressSink`. Eleven
  `new ToolExecutor(` sites exist; eight omit it, safe today only because they pair with a rejecting
  stub dispatcher. Nothing structural stops a ninth.
- **The enforcement test is non-behavioural.** It asserts only that the audit source *contains the
  string* `D22-connectors-dispatch`, so it passes with both regexes gutted.

## Enumerated bypasses

Eleven classes reach the network with no `egress_ledger` row. Ranked by severity, which is **not**
the same as volume.

| # | Class | Site | Reachable by | Harm |
|---|---|---|---|---|
| 1 | Share replay | `ipc/share-rpc.ts:172` | Third party who sent a file | **Exceeds record-honesty — see below** |
| 2 | Remote embeddings | `embedding/openai-embedder.ts:23` | Scheduled / unattended | Indexed corpus text leaves; largest content volume |
| 3 | ChatOps | `chatops/chatops-bot-spawn-call.ts:40` | Any member of a bound channel | Third-party-triggered outbound on bot credentials; pre-auth identity lookup |
| 4 | Team-vault invoke | `teamvault/team-tool-spawn.ts:12` | Paired federated peer | Org-shared credential spent with no chained record |
| 5 | Warehouse list paging | `connectors/connector-list-page.ts:47` | Scheduled / unattended | Up to 1000 calls per sync on a team credential |
| 6 | Connector sync | `sync/scheduler.ts:650` | Scheduled / unattended | Largest class by request count; makes `prove` unsound in the ordinary case |
| 7 | Conversational agent | `engine/run-conversational-agent.ts:147` | Local owner | Richest single request body |
| 8 | OAuth refresh | `auth/oauth-registry.ts:486` | Scheduled / unattended | Credential material leaves, unattended, with no record at all |
| 9 | Federated wire | `ipc/lan-client.ts:155` | Local owner (implicit) | Not HTTP, so fetch-shaped instrumentation misses it |
| 10 | Telemetry / audit shipper / registry poll | `telemetry/flush-scheduler.ts:129` and siblings | Scheduled / unattended | Metadata only; defensible **if the tier says so** |
| 11 | The rule itself | `scripts/structure-audit/check-nimbus-invariants.ts:590` | — | Certifies a completeness it cannot observe |

The sharpest artifact in the set: `nimbus prove "<query>"` triggers intent classification
(`engine/router.ts:129`), so **the command that prints `0 ✓` is itself a cause of unledgered
egress** of the query text.

## The one class that exceeds record-honesty

`share.replay` executes tool calls chosen by a file the owner was sent. Four properties, each
verified directly:

1. **The signature is computed and then ignored.** `share-rpc.ts:289` calls `verifyShareFromBytes`;
   `replayShare` runs unconditionally at `:294-298`; the result is returned as `{ verify, report }`
   for display. The CLI prints `signature: INVALID` *after* the outbound calls have happened. No
   valid signature is required to replay anything.
2. **Parameters are attacker-controlled verbatim.** `share/recipe-runner.ts:66` returns
   `params: v["params"]` — an unvalidated `unknown` — inside a function whose own doc comment states
   "every field is validated."
3. **The only control is a verb heuristic.** `isReadOnlyToolId` classifies by the trailing
   `_`-segment against a 16-verb set. It is a positive allowlist, which is the right shape, but it
   classifies by **name**, not by behaviour.
4. **One allowlisted id is not a read.** `READ_VERBS` contains `"preview"`, so `iac_pulumi_preview`
   passes. That tool runs
   `["pulumi", "preview", "--cwd", p.workingDirectory, "--non-interactive"]`
   (`packages/mcp-connectors/iac/src/server.ts:81-91`) with `workingDirectory` supplied by the file.
   **`pulumi preview` evaluates the stack program in that directory.**

**Stated honestly, because a spec that overstates gets dismissed.** The unconditional impact is
arbitrary *parameterised reads* against the owner's live, personally-credentialed mesh — uncapped
step count, no HITL, no ledger row, no `tool_call_log` entry — reachable by getting the owner to run
`nimbus verify-share <url> --replay` on an attacker-hosted URL. Real allowlist hits today include
`gdrive_file_download`, `gmail_message_read`, `outlook_mail_read` and `notion_database_query`.

The execution path additionally requires: the `iac` connector present in the mesh, the `pulumi`
binary on `PATH`, and a directory containing a Pulumi program that the attacker can name. Those are
real preconditions and should not be elided — but neither should the fact that a "read-only"
allowlist admits a program evaluator.

Second-order, and independent of any tool id: merely calling `listReplayTools()` runs
`ensureCredentialConnectorsRunning` + `ensureUserMcpConnectorsRunning` (`mesh.ts:429-431`), so a
share file with **zero** steps force-spawns every credential connector and every user-registered
third-party MCP server.

### Immediate mitigations, independent of the phased plan

These are small, and none waits on the remediation architecture:

1. **Enforce the signature.** Refuse to replay unless verification succeeds and the share has not
   expired, or require an explicit `--allow-unsigned` that names the risk.
2. **Remove `"preview"` from `READ_VERBS`**, and re-derive the set from observed connector tool
   behaviour rather than verb spelling. Audit the other fifteen the same way.
3. **Validate step parameters** against the target tool's declared input schema before execution.
4. **Cap step count** per replay.
5. **Do not spawn the mesh to enumerate tools** until at least one step has been classified as
   replayable.

Longer term, replay belongs behind the executor like every other outbound path — which is Phase 2.

## What is *not* wrong

Recorded because an over-broad spec is a dismissed spec, and two of these were claimed and then
disproved during this audit:

- **`I11` is intact.** The bypasses do not defeat the tool-output envelope. `mesh.listTools()` — the
  binding that wraps — has zero production callers, but `I11` is carried on the LLM path by
  `wrapToolForLlm` (`engine/agent.ts:25-77`). What the bypasses actually skip is `tool_call_log`.
- **No arbitrary-SQL warehouse tool is exposed.** `snowflake_table_query` exists only in a test
  fixture.
- **Team-vault invoke is not privilege escalation.** `invoke-gate.ts:82-107` enforces the write-
  forbidden predicate, identity validity, and a per-peer per-tool RBAC grant. A peer can invoke only
  what the owner already granted. The gap is that the record lives in a different, unchained table.
- **`share.replay` is not LAN-reachable.** Its absence from `FORBIDDEN_OVER_LAN` is **latent**, not
  live: LAN dispatch routes solely through `dispatchFederationRpc` and throws on a miss. It becomes
  live the instant LAN dispatch broadens past the federation namespace — so add it to the denylist
  now, as a cheap guard against a future change.

## Remediation

Five phases. The ordering principle is that each phase ships an honest label **before** the
mechanism that earns it.

### Phase 1 — Make the claim true (no new coverage)

The smallest change that removes the falsehood. One commit, full triple rule.

- **Freeze the taxonomy first.** `sourceType` is an open `string` and is BLAKE3-committed, so a
  later rename is a chain break rather than a refactor. Land the closed union now, complete,
  including members whose appenders do not exist yet: `task`, `prune`, `session`, `sync`, `model`,
  `peer`. Enforce in TypeScript with an identity test (`toEqual` against the literal list, never a
  length check) so widening it is a visible diff. No DB `CHECK` — the table is live, chained and
  append-only, and a constraint would require a rebuild.
- **Make the sink required.** Export a named `NULL_EGRESS_SINK` for the gate-only construction
  sites. A named null is a decision on the record; an omitted optional is an accident waiting.
- **Replace the scalar tier.** `completeness: { tier: "authorized-actions" }` becomes a per-source
  coverage vector, so a report can state exactly what the ledger did and did not see.
- **Correct the documentation**, including `D22`'s own comment and the `I29` section. The false
  no-escape-hatch claim is part of the defect.
- **Kill the false `0 ✓`** in `prove`.

### Phase 2 — Remove the capability rather than confining it

The decisive architectural choice: **strip `execute` from what the mesh hands out**, so there is
nothing left to confine. Route the three bypasses through a session-scoped dispatcher, executor and
sink. Only then land the new static rules — green, with no exemptions.

This is preferred to a better regex. These checks are regex-over-source, not AST; a rule that must
enumerate every way to call a function is a rule that will be outrun again.

### Phase 3 — The sync chokepoint

One row per sync run at `sync/scheduler.ts:650`, the single verified chokepoint. Note that
`sync_telemetry` cannot carry a completeness claim: no destination, no method, no HITL status, not
chained, and `bytes_transferred` is NULL for roughly two-thirds of connectors.

### Phase 4 — Model and peer tiers

Remote inference, embeddings, and outbound federated sends. **Local inference must produce no rows**
— enforced by a structural local/remote predicate, not by convention — or the ledger becomes noise
and the completeness claim fails in the other direction.

### Phase 5 — Document the permanently excluded set by name

JWKS fetches, OIDC discovery, updater manifests, the model download, mDNS advertisement. Zero user
data leaves these, and excluding them is defensible **provided the tier string enumerates them**
rather than hand-waving.

## What not to do

- **Do not add an allowlist entry so the audit passes.** That satisfies the checker while dissolving
  the property, and it is how the current gap will recur. `D22`'s value is not that a known set of
  files may reach the network; it is that no path can reach it unrecorded.
- **Do not widen `source_type` incrementally.** The row hash makes each value permanent, and five
  items independently plan to add one.
- **Do not ship a coverage tier the mechanism does not yet earn.** That is the original defect.
- **Do not treat `sync_telemetry` as ledger coverage.**

## Verification status

**Verified directly against the tree** while writing this spec: the `D22` rule text and its totality
comment; all three raw `tool.execute()` sites; `READ_VERBS` containing `preview`; the
`iac_pulumi_preview` argv and its attacker-supplied `workingDirectory`; `share.replay` computing
verification and then replaying unconditionally; `parseStep` passing `params` through unvalidated;
the absence of any egress reference in `share/`.

**Agent-reported with file citations**, consistent with the above but not personally re-opened: the
eleven-class enumeration beyond the sites named above, the eight-of-eleven `ToolExecutor`
construction sites omitting the sink, `mesh.listTools()` having no production callers, and the
`sync_telemetry` fidelity claims. Confirm each before it becomes a commit.

**Method:** a six-agent audit — four sweeping distinct egress modalities, then a threat model and a
remediation design over the combined enumeration. The threat pass corrected two claims from the
sweep pass (the `I11` breach and an arbitrary-SQL warehouse tool), both of which are recorded above
under "What is not wrong."
