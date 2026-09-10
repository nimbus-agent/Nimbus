# S2 — Runtime Tool Generation

> **Status: PR 1 of 3 SHIPPED 2026-09-09 — the SUBSTRATE. Drafting is NOT implemented.**
> Invariant **I39**, static rule **D29**, the `tool` egress coverage class at `per-call`, the
> default-off `[tool_generation]` config section, the LAN-forbidden `toolgen.*` IPC namespace and
> `nimbus tool create|list|revoke|credential set` are all **live** — cite them as shipped.
>
> What is NOT shipped, and must not be cited as such: **drafting** (§ 10) — `ToolgenGateDeps.draftBody`
> refuses with `ERR_TOOLGEN_DRAFT_NOT_IMPLEMENTED`, so `nimbus tool create` runs the entire gate and
> then declines to author a body — plus agent-initiated generation behind `allow_agent_initiated`
> (PR 2) and persistence via `nimbus tool save` (PR 3). Sections describing those remain
> forward-looking design, not a record of the tree. Matches `docs/roadmap.md`'s row for this slice;
> if the two ever disagree, the roadmap is canonical.
>
> The one exception is `tool_generation`, which has been a member of `AI_V2_CAPABILITIES`
> (`packages/gateway/src/policy/types.ts:52`) since the exec slice and is referenced **nowhere
> else in the tree, not even in a test**. It is a declared-but-unenforced capability name, exactly
> the state `multimodal_input` was in before multimodal PR 2. PR 1 below is what makes it real.
>
> **Slot:** [Spine S2 — Local Compute Fleet](../../roadmap.md#active), the row *"Runtime tool
> generation"* — after multimodal I/O closed (2026-09-05) and the overnight fleet's PR 2a landed
> (2026-09-08), **this is the last unstarted spine row in S2**. Closing it closes the slot and
> opens S3. Detail source: [Phase 14 § Stretch — Tool
> Generation](../../roadmap.md#phase-14--agent-evolution--ai-v2).
>
> Read [§ Active](../../roadmap.md#active) for delivery status, never this header.

---

## 1. Goal

Let the agent extend its own tool surface at runtime: draft an MCP tool for a service Nimbus has
no connector for, prove the sandbox confines it, obtain the local owner's approval, and register
it **for the session only**. Persistence is a separate, manually-reviewed act (§ 10, PR 3).

This is the highest-blast-radius row in the repository, and the reason is worth stating plainly
rather than discovering during review: **the model that authors the code has indexed connector
text in its context.** That text is untrusted by construction — it is why `wrapToolOutput` (I11)
and the `<tool_output>` envelope exist. A prompt injection carried in an indexed Jira comment can
therefore influence, and in the limit fully author, the body of a tool that is about to be given
network access and credentials.

Every defense below is placed so that **the model's cooperation is not required for it to hold.**
That is the single design rule this spec is organised around. A defense the generated body could
decline to invoke is not a defense.

## 2. Non-goals, stated so they are not re-litigated

- **Not a connector-authoring replacement.** `nimbus scaffold` and `create-nimbus-connector`
  already exist for a human writing a real connector against the published SDK. This is for a
  tool that lives and dies inside one session.
- **Not a credential broker.** A generated tool never inherits an existing connector's secret
  (§ 6.3). If it has no credential of its own it makes unauthenticated requests or it makes none.
- **Not agent-initiated in PR 1.** The two paths ship behind two switches (§ 9); PR 1 is
  owner-initiated only.
- **Not persistent in PR 1.** Ephemeral means in-memory; a gateway restart drops every generated
  tool. There is no schema migration in PR 1 (§ 8).
- **No local fine-tuning, no tool-use trace dataset.** Those remain Phase 14 stretch rows and the
  spine table does not name them in S2.

## 3. The constraint that shaped everything: per-host network filtering is not enforceable on Windows

The obvious design — the generated tool declares its hosts in its manifest, and the existing
sandbox enforces that list — **does not work**, and the reason is a platform fact rather than a
missing feature.

| Platform | A declared `permissions.network` allow-list is… | Site |
|---|---|---|
| macOS | **Enforced exactly.** `generateSbplProfile` emits `(remote tcp "*:<port>" (host "<h>"))` per entry under `(deny default)`. No helper needed. | `platform/sandbox/darwin.ts:163-171` |
| Linux | **Enforced exactly, or refused.** `canConfine` returns the helper's reason for any non-empty network set when `nimbus-sandbox-helper` is absent. | `platform/sandbox/linux.ts:230-239` |
| Windows | **Not enforced at all.** AppContainer's `internetClient` is all-or-nothing; per-host "would need a WFP callout driver with kernel-mode signing". | `platform/sandbox/win32.ts:73-88` |

Two details make the Windows row worse than it first reads:

1. **`canConfine` deliberately returns `null`** — *yes, I can confine this* — for a multi-host
   policy on Windows. The asymmetry is reported only through `degradedReason()`. So the guard that
   I33 and the terminal lane rely on to refuse before consent **would not refuse here**, by
   design: for a hand-written first-party connector the all-or-nothing grant is an accepted
   defense-in-depth degradation, and `canConfine` is answering the question those callers ask.
2. On Linux, `decideNetworkMode` maps a non-empty host set with no helper to `"fallback"`, and
   `buildBwrapArgv` maps anything that is not `"no-net"` to `--share-net`
   (`linux.ts:37-54`). A caller that spawns *without* asserting `canConfine` first — which the
   lazy-mesh connector path does — therefore gets full unfiltered network from a policy that
   named two hosts.

For a trusted connector, both behaviours are defensible. For LLM-authored code they are not: the
owner would be approving *"this tool may reach api.example.com"* while actually being handed
*"this tool may reach anything"*. That is the same shape as the two failures already on record in
this project — an air-gap switch that was inert while the docs promised it, and a hero demo whose
output was fabricated. **An approval prompt that overstates the bound is worse than no prompt.**

**Resolution: the generated tool gets no network at all, on every platform, and the gateway makes
its requests for it.** § 4.

## 4. Architecture — brokered egress

### 4.1 The shape

```text
  owner ──"nimbus tool create"──▶ toolgen-gate.ts
                                       │
                          (refusals BEFORE consent: § 5)
                                       │
                                       ▼
                    model drafts BODY ──▶ toolgen-stub.ts
                                          (Nimbus authors skeleton +
                                           manifest with network: [])
                                       │
                    confinement probe under real runner   § 7.3
                                       │
                          owner approves VERBATIM artifact    § 5 step 7
                                       │
                                       ▼
                              toolgen-registry.ts  (in-memory, session-keyed)
                                       │
                            wrapServerSpec (I15/D10) ──▶ sandboxed tool process
                                       │                        │
                                       │      nimbusFetch(url)  │  raw fetch() ──▶ ✗ BLOCKED
                                       │◀───────────────────────┘     (no network, all 3 OSes)
                                       ▼
                              toolgen-broker.ts
                                 ├─ host on approved envelope?      else refuse
                                 ├─ attach credential bound to THAT host  § 6.3
                                 ├─ append `tool`-class egress row   § 6 (fail-closed)
                                 └─ perform request, return response

```

### 4.2 Files

| File | Role |
|---|---|
| `toolgen/toolgen-gate.ts` | The chokepoint. `createGeneratedTool()`, ordered like `exec-gate.ts` / `cu-gate.ts`. |
| `toolgen/toolgen-stub.ts` | Nimbus-authored skeleton, `nimbusFetch` helper, and the manifest constructor. |
| `toolgen/toolgen-broker.ts` | Serves the brokered-fetch request. The ONLY site that performs a generated tool's outbound request. |
| `toolgen/toolgen-registry.ts` | Ephemeral session-keyed registry. In-memory only. |
| `toolgen/toolgen-consent-broker.ts` | Owner approval, reusing the `ConsentBroker` shape `exec-gate.ts` already has. |
| `toolgen/toolgen-credentials.ts` | The sole site composing `toolgen.<toolId>.<hostSlug>` Vault keys. |
| `toolgen/toolgen-artifact.ts` | `GeneratedToolArtifact` + its canonical serialization (§ 4.5). |
| `toolgen/toolgen-client.ts` | Spawns the tool over the OFFICIAL `@modelcontextprotocol/sdk` `Client`, not `@mastra/mcp` (§ 4.4). Registers the `nimbus/fetch` handler. |
| `toolgen/toolgen-confinement.ts` | Runs the SDK probe under the real PAL runner before consent (§ 7.3). |
| `toolgen/toolgen-types.ts` | Envelope, approved host list, credential bindings, outcome union. |
| `egress/tool-egress.ts` | `recordToolEgress` — the new `tool` coverage class appender. |

### 4.3 Why the model's cooperation is not required

1. The manifest is **Nimbus-constructed** with `permissions.network: []` **by construction**,
   rejecting a requested net grant rather than dropping it — I33's exact wording for the exact
   same reason.
2. A body that ignores `nimbusFetch` and calls raw `fetch()` therefore **simply fails**:
   `--unshare-net` on Linux (its own netns, loopback included), `(deny default)` with no
   `(allow network*)` block emitted on macOS, no `internetClient` on Windows. All three, no
   helper required, no asymmetry — the Windows gap of § 3 does not exist when the set is empty.
3. `nimbusFetch` is consequently the only door, and it opens onto the gateway, not the network.
4. Generated tools inherit I15/D10 free: every `ServerSpec` already routes through
   `wrapServerSpec`, so the sandbox is not optional for this path any more than for a connector.

**The transport, the request-issuing helper and the manifest are all Nimbus-authored.** The model
fills a hole in a template it does not control. That is what makes one human approval a sufficient
boundary here, and it is the direct answer to the question I33 left open — *"the LLM cannot invoke
an execution… that is the assumption to re-examine first when an agent-callable path lands"*.

### 4.4 The callback channel

MCP over stdio is bidirectional, and **stdio is the one channel every sandbox forwards on all
three platforms.** This matters because the alternatives are all closed: fd 3/4 is not forwarded
by the Windows AppContainer helper (I35 records this), and a loopback socket cannot reach the
gateway anyway — `--unshare-net` gives the Linux child a fresh netns whose loopback is **its own,
not the host's**, so `127.0.0.1` there is a different machine as far as the gateway is concerned,
and AppContainer blocks loopback on Windows without an explicit `CheckNetIsolation` exemption.
That property is not incidental: it is the same one I33 relies on to keep a sandboxed execution
away from the Gateway's own IPC socket and `127.0.0.1` HTTP API.

`nimbusFetch` does **not** reuse `elicitation/create` or `sampling/createMessage` — both mean
something else (ask the human; ask the client's model), and overloading them would put a
generated tool's egress on a method some other component may one day handle. It uses a custom
method, `nimbus/fetch`, whose literal is defined once in `toolgen-types.ts` and confined there by
**D29(a)**.

**Generated tools do NOT use `@mastra/mcp` — and, since the plan review, do not use the official
MCP SDK on the child side either.** The first draft named "does a custom MCP method survive the
`@mastra/mcp` transport" as PR 1's largest risk. That is answered, and the answer is no:
`InternalMastraMCPClient` holds the underlying SDK client as a **private** field
(`packages/gateway/node_modules/@mastra/mcp/dist/client/client.d.ts:60`) and exposes exactly one
server→client hook, `setElicitationRequestHandler` (`:272`). There is no public API for registering
a custom JSON-RPC request handler, and monkey-patching a private field is not a foundation for an
egress chokepoint.

The obvious replacement — the official `@modelcontextprotocol/sdk` `Client` on the gateway side and
its `Server` inside the generated tool — is **unrunnable on the child side**, and reproducibly so. A
script under `<configDir>/toolgen/ephemeral/<toolId>/` cannot resolve a bare specifier, because Bun
resolves from the importing file's directory and there is no `node_modules` on that path:

```text

error: Cannot find module '@modelcontextprotocol/sdk/server/index.js'
       from '…/tg_probe/index.ts'

```

That fails **before any sandbox is involved**; inside the sandbox, granted read to `scriptDir` only,
it fails twice over. The two repairs — resolving the SDK to absolute `file://` URLs, or setting
`NODE_PATH` — both work and both mean granting read access to the gateway's whole `node_modules`
tree to a process running LLM-authored code, which is a large mutable surface handed to precisely
the thing this manifest exists to contain. Neither survives `bun build --compile`, where
`node_modules` is not on disk at all.

**So both ends speak one dependency-free, line-delimited JSON protocol over stdio.** `{id, method,
params}` in, `{id, result}` or `{id, error}` out; a message carrying `method: "nimbus/fetch"` is the
tool asking the gateway to make a request for it, and is the only route out of that process. It is
about forty lines Nimbus emits, it imports nothing, and only Nimbus ever talks to it — MCP
compliance buys a session-scoped tool nothing, and dropping it also removes the open question about
custom-method schemas on `setRequestHandler`.

Two consequences worth stating rather than discovering. The generated manifest must additionally
grant read to the **interpreter's own paths** (`ExecRuntime.requiredReadPaths()`, as
`exec-gate.ts` does): on Windows the AppContainer helper writes one ACE per granted path, so an
ungranted interpreter is unreadable and the child dies before running a line — exit 68, no stdout,
no stderr. And the read grant contains **no `node_modules` entry at all**, which is the property
that keeps it small; a future change that reintroduces an import into the emitted script would have
to widen it, and should be read as a design regression rather than a build fix.

### 4.5 One canonical artifact

`GeneratedToolArtifact` — manifest, body, host list, credential bindings — is canonically
serialized from the start, via the `canonicalizeManifest` that `extensions/canonical-json.ts`
already re-exports from the SDK and that extension signature verification runs on.

The same bytes serve all three consumers: **what the owner approves, what is hashed into the
`tool.generate` audit row, and what PR 3 signs.** Defining this in PR 1 costs almost nothing and
removes a whole class of PR 3 defect — if PR 1 kept loose in-memory fields, PR 3 would have to
invent a canonicalization after the fact, and the failure mode is the nasty one: the approved
bytes and the signed bytes differ, so a signature attests to something the owner never read.

That is I33's rule extended one hop. *Read the script once, so the bytes the owner approved are
the bytes that execute* — **and later the bytes that get signed.**

### 4.6 Where the approved body lives, and how it is invoked

The approved body is written to `<configDir>/toolgen/ephemeral/<toolId>/index.ts`, owner-only
(`0o600` on POSIX, owner-only ACL on Windows), and the sandbox policy grants read to that
directory and the Bun runtime paths only. The directory is removed on revoke and on shutdown.

**It is not passed inline, and it is not named as the entry point.** Both of those are measured
dead ends, recorded in `exec/exec-runtimes.ts`:

- Inline is bounded by the Windows helper's `wchar_t cmdline[32768]`, which has to hold the
  interpreter path, every flag, and the body plus quoting expansion. I33 caps an inline body at
  `MAX_INLINE_CODE_UNITS` (16,384) for exactly this reason. A generated MCP server is a whole
  module, not a five-line script, so it will not reliably fit.
- Naming the file as the entry point (`bun run index.ts`) **fails under the Windows AppContainer**
  with `CouldntReadCurrentDirectory` — bun's startup path for a file entry point touches something
  the sandbox denies. This is measured, not theorised, and it is why a plain `bun run <path>`
  invocation would pass CI on two platforms and fail on the third.

The entry point is therefore a short `-e` stub that **imports** the file:
`bun -e "await import('<abs path>')"`. The same comment in `exec-runtimes.ts` records that
`import()` of a granted file works fine under AppContainer where naming it as the entry point does
not. That satisfies both constraints at once — the command line stays tiny, and the startup path
that Windows denies is never taken.

## 5. The gate — ordered, refusals before consent

`createGeneratedTool()` runs in a fixed order. As with I33 and I35, every refusal that can be
decided without the owner is decided **before** the owner is prompted, so a disabled capability
never advertises itself by asking.

1. **Config off** — `[tool_generation] enabled` is `false` (default). Refuse.
2. **Org policy off** — `EnforcedPolicy.capabilitiesDisabled` (I22) contains `tool_generation`.
   Refuse fail-closed, **and refuse fail-closed when the accessor is absent** rather than
   defaulting to enabled. This is the gap multimodal PR 1 left open and PR 2 closed; it is
   written into the order here rather than deferred to a follow-up.
3. **Initiator not allowed** — an agent-initiated request while `allow_agent_initiated` is
   `false`. Refuse. (PR 2; in PR 1 no agent-initiated path exists to refuse.)
4. **Session budget** — `max_tools_per_session` already spent. Refuse.
5. **Sandbox cannot confine** — `runner.canConfine(policy)` non-null for the **empty-network**
   policy this tool will actually spawn with. Not `degradedReason()` (non-null on Windows even
   when the runner is fully active) and not `isFullyActive()` (reports the Linux per-host helper a
   no-network policy never touches, and CI does not install it). I33 records both traps; this
   asserts the policy that spawns.
6. **Draft, wrap, contract-test** — the model produces the body; `toolgen-stub.ts` wraps it;
   the § 7.3 confinement probe runs under the real PAL runner. A failed probe refuses **before**
   consent.
7. **Owner approves the VERBATIM artifact** — never a digest, which is a rubber stamp with extra
   steps (I33). The prompt shows the full body, the host list, the credential binding per host,
   the initiator, and the § 11 residual.
8. **Register** ephemerally. Spawn lazily on first call through `wrapServerSpec`.

A denied or timed-out approval registers nothing. Every outcome appends one `tool.generate` audit
row: the artifact in full where one exists (a refusal decided before consent records only the
tool id and a reason code — nothing was approved, often nothing was drafted), with
`hitl_status` CHECK-constrained to approved/rejected/not_required. A refusal-before-consent and an
owner denial both record `rejected`, distinguished by `outcome`; **`not_required` is never used on
this action type**, since it would read as "generated a tool without needing approval".

## 6. Egress

### 6.1 A new coverage class

`COVERAGE_CLASSES` (`egress/egress-coverage.ts:29`) gains a tenth member, `tool`, and
`THIS_BINARY_COVERAGE.tool` is raised from `none` to `per-call` **in the same commit that gives
`recordToolEgress` its production caller** — the rule that file states about itself, and that the
`browser` class followed.

No existing appender covers this. `task` fires at `connectors.dispatch` inside `engine/executor.ts`
(I29/D22(a)); a generated tool's outbound request never passes through there. `sync`, `model`,
`chatops` and `browser` are each bound to their own subsystem. Without a new class, a generated
tool's requests would leave the machine with no row and no stated exclusion — the precise defect
the `chatops` class was added to fix.

### 6.2 The appender

One row per brokered request, appended **before** the request is made, `destination` the resolved
host, `payload_summary` the request method and byte length — never the body, never the credential.
An append failure aborts that request (fail-closed), so a zero-row window means no generated tool
reached the network, never that one did so unrecorded.

A refused host appends a `result_status='blocked'` row, mirroring the executor's denied-gate row.

**`hitl_status` on these rows is `not_required`, not `approved`** — corrected during implementation,
and the correction matters. The first draft reasoned "the owner approved this tool and its hosts at
registration, so each request inherits that approval". That conflates two different questions. An
egress row's `hitl_status` records whether **this outbound request** passed a consent gate, and a
brokered fetch does not — the *registration* did, and that is recorded on the `tool.generate` audit
row where it belongs. Every sibling appender (`sync`, `model`, `embedding`, `browser`, `chatops`,
`vlm`) writes `not_required` for exactly this reason; the only egress appender that writes
`approved` is `egress-prune.ts`, whose action really is HITL-gated per request. **I4's enforcement
test would have rejected the original wording**: it fails any production file outside a named
"earned set" that hardcodes `hitlStatus: "approved"`, and it separately fails a file listed in that
set that does not — so adding this appender to the earned set would have been wrong too. Writing
`approved` here would have been an approval that never happened.

### 6.2.1 The broker is the SSRF boundary, and the approved list is not enough

The tool has no network; **the broker has all of it**, because it runs in the gateway process. So
an approved host list is a necessary check and not a sufficient one, and the broker refuses on its
own account before consulting the envelope:

1. **Scheme** — `https:` only, or `http:` only where explicitly opted in. `file:`, `data:`,
   `blob:`, `gopher:` and everything else are refused.
2. **Destination address, fail-closed** — loopback, link-local, RFC 1918 and the cloud metadata
   address `169.254.169.254` are refused **even if the owner approved that host**. This is the one
   place the design overrides an owner approval, and deliberately: § 4.4's whole argument is that
   the sandboxed tool cannot reach the Gateway's own IPC socket or `127.0.0.1` HTTP API (the I13
   write surface, the `agents` and `resolve` scopes) — a broker that would proxy it there hands
   back exactly what the empty network set took away. I33 names the same target for the same
   reason.
3. **Checked on the RESOLVED address, not the hostname.** A hostname check alone is defeated by a
   name that resolves to `127.0.0.1`. The broker resolves the host and refuses if **any** returned
   A/AAAA record is forbidden — all of them, not just the first, so a name answering with one
   private record among several public ones is refused outright.

   **Stated residual — check-then-connect is NOT closed in PR 1.** An earlier draft of this section
   claimed the broker "connects to the address it validated". It does not, and could not: Bun's
   `fetch` exposes no connection-pinning or custom-resolver hook (probed on 1.3.14), so the request
   is issued against the hostname and the runtime resolves DNS again independently. A caller who
   controls the DNS for a host the owner **already approved** can therefore answer the validation
   lookup with a public address and the connection lookup with `127.0.0.1`, reaching the Gateway's
   own loopback API. Validating every record narrows this but does not close it. Closing it needs a
   custom HTTP client that connects to a pinned address — tracked, not shipped here. The claim is
   corrected rather than quietly kept, because an invariant that overstates its bound is the exact
   failure this project already has twice on record.
4. **Host match** — `url.hostname` lowercased, compared exactly against the envelope. No suffix
   matching, no wildcards: `evil-api.example.com` must not satisfy `api.example.com`.
5. **Header stripping** — `Authorization`, `Proxy-Authorization` and `Cookie` supplied by the tool
   are dropped. The broker attaches credentials (§ 6.3); the tool never sets its own auth header, or
   it could attach a secret it obtained some other way to a host of its choosing.
6. **A resolution FAILURE is a refusal, not an escape.** If the destination will not resolve, the
   broker appends a `blocked` row and refuses, rather than letting the rejection propagate out
   unledgered — a resolver lookup is itself traffic the tool caused.
7. **Redirects are refused, not followed.** `handleFetch` issues the fetch with `redirect: "error"`
   — set unconditionally inside the broker, not in the `doFetch` closure a caller supplies, so the
   guarantee travels with checks 1–6 rather than living in one wiring site a second caller could
   build without it. Every check above runs against the INITIAL url only; a plain `fetch` with its
   spec default (`redirect: "follow"`, up to 20 hops) would let an approved host redirect the
   request to any other host, scheme or resolved address — including the cloud metadata address or
   the Gateway's own loopback API check 2 exists specifically to keep out — with none of checks
   1–6 re-run and no second ledger row, silently re-entering the network outside every guarantee
   this section makes. Refusing the hop is therefore not a narrower version of following it; it is
   the only shape that keeps this section's claims true. A refused redirect appends its own
   `blocked` row (`ERR_TOOLGEN_REDIRECT_REFUSED`) on top of the `authorized` row already appended
   for the attempt itself — two rows for one call, deliberately, matching the resolution-failure
   case in (6): the first records that a real request to the approved host was authorized and
   attempted, the second that it was then cut short before any response body reached the tool.

### 6.2.2 Bounds on the response

Three limits, because the broker is inside the gateway and a generated tool is not trusted to be
well-behaved about what it asks for:

- `max_requests_per_tool` — counted per `toolId` in the broker; exhaustion appends a `blocked` row
  and returns an error.
- `request_timeout_ms` — an `AbortController` linked to the fetch.
- `MAX_BROKERED_RESPONSE_BYTES` (5 MiB) — the response is read with a running byte count and
  aborted past the cap. Without it a tool can point the broker at a 1 GiB file and take the
  gateway down with it. This is the same class as I32 (a bounds invariant whose loss is confined
  to the attempted operation), and it is the reason that class exists.

### 6.3 Credentials

**Per-host, not per-tool.** The binding is `{host → vault key}` and the broker attaches by
resolved destination host. Bound per-tool instead, a tool approved for hosts A and B could ask the
broker to hit B carrying A's credential — the tool chooses the URL, so the tool would choose the
recipient of the secret.

**Never inherited.** A generated tool gets its own Vault key or none. An existing connector's
secret confers nothing, the same rule I37 applies to `[llm.remote.<vendor>]` keys not conferring
vision rights: a credential that merely exists must never enable a capability nobody opted into.

**Never in the tool process.** The broker attaches the credential; the tool never receives it. It
cannot be read, so it cannot be exfiltrated — this holds even if the body is fully
attacker-authored.

Keys live under `toolgen.<toolId>.<hostSlug>`, composed in exactly one place
(`toolgen/toolgen-credentials.ts`), which joins `VAULT_KEY_ALLOW_LIST` in
`scripts/structure-audit/check-nimbus-invariants.ts`. **Stated bound:** the keys are composed
dynamically, so the audit's literal scan cannot see them; capability confinement — only this file
is handed the Vault for that prefix — is the real defense, and the allow-list entry documents the
keyspace rather than enforcing it. This mirrors D27(b)'s own stated bound on the `media_grant`
table.

**Supplied at CREATE time, never added later.** The toolId does not exist until `nimbus tool create`
runs, so a credential cannot be in the Vault when the owner is prompted — which would make the
prompt's "what will be sent, and where" permanently empty and the disclosure vacuous. Credentials
are therefore passed to `create` and bound before the prompt. `nimbus tool credential set` refuses a
LIVE tool and says to revoke and recreate: adding one to an approved tool changes the artifact the
owner approved (§ 4.5 puts `credentialHosts` inside the hashed object exactly so a change
invalidates it), and silently widening what an approved tool may send is the failure this gate
exists to prevent. Never written by the model.

The stored value is a tagged envelope rather than a bare string, so the broker knows how to attach
it without the tool describing its own auth:

```ts

export type ToolCredentialBinding =
  | { readonly type: "bearer"; readonly token: string }
  | { readonly type: "header"; readonly headerName: string; readonly value: string }
  | { readonly type: "basic"; readonly username: string; readonly password: string };

```

A bare string would force either a convention (`"assume Bearer"`) or a tool-supplied hint, and the
second is the tool telling the broker how to spend a secret it cannot see.

## 7. Confinement verification — and why it is NOT a bare `runSandboxContractTests` call

The roadmap row says the agent "runs the `@nimbus-dev/sdk` contract test, and on green registers
it", which reads as a claim about the tool's *behaviour*. The test cannot support that claim — the
only other `testing` export is `MockGateway`, which returns `{}`. It can support a **confinement**
claim, and confinement is the claim that matters here: *this machine's sandbox really does confine
this manifest*, checked on the box the tool will run on rather than assumed from § 3's table.

### 7.1 The trap: the SDK's default probe runner is UNSANDBOXED

`runSandboxContractTests(manifestPath)` has **zero callers anywhere in this repository**, and
reading why is what turned this section from three lines into a design decision.

With `permissions.network` empty, the function's body
(`node_modules/@nimbus-dev/sdk/src/testing/sandbox-contract.ts:164-198`) skips both network probes
— `firstHost` is `undefined`, and the `network-unlisted` branch is guarded on `hosts.length > 0` —
and runs `fs-denied` **unconditionally**. That probe reads `/etc/passwd` on POSIX and expects
`EACCES`.

But the default runner, `__defaultRunProbe`, spawns `process.execPath` through a bare
`spawnSync` with **no sandbox wrapping at all**. An unconfined child reads a world-readable
`/etc/passwd` successfully, so the probe exits `unexpected` rather than `fsDenied`, and the
function throws:

```text

fs-denied probe should have returned EACCES (exit 10); got exit 2.

```

**A bare `runSandboxContractTests(manifestPath)` therefore fails 100% of the time on Linux and
macOS**, and would have blocked every tool-generation request before consent. The SDK's own
docstring on the option says *"Tests inject a stub here; production callers leave this
undefined"* — which is wrong for any real caller, and is only survivable because there has never
been one. **This should be reported upstream to `nimbus-agent/nimbus-sdk` as a doc-and-default
bug**; it is not fixed here, because this repo consumes the published package.

### 7.2 The obvious fix does not compile either

Injecting `opts.runProbe` so the probe runs under the real PAL runner is the right instinct, but
it does not type-check: `ProbeRunner` is **synchronous** — `(probe, arg) => ProbeResult`
(`sandbox-contract.ts:110`) — while `SandboxRunner` exposes only `spawn(...)` returning a
`ChildProcess` (`platform/sandbox/sandbox-runner.ts:14`). There is no `spawnSync` on the PAL
interface, on any of the three platforms.

Closing that gap means adding `spawnSync` to `SandboxRunner` and implementing it three times —
a PAL widening that this row does not need and should not carry.

### 7.3 Resolution for PR 1

**PR 1 verifies confinement in the gateway, with its own probe, over the existing async `spawn`.**
`toolgen/toolgen-confinement.ts` spawns the SDK's probe script — `probePath()` is exported, so the
probe itself is reused even though its runner is not — through `deps.runner.spawn(...)` under the
exact empty-network policy the tool will spawn with, awaits exit, and asserts `fs-denied` returns
`fsDenied` and that a raw connect attempt fails. Same claim, same probe, no PAL widening, and it
runs before consent.

Adding `SandboxRunner.spawnSync` so the SDK's own function can be used is a reasonable follow-up
and is **explicitly not PR 1's job**. Recorded here so the choice is visible rather than looking
like the SDK export was overlooked — § 13 lists it as the deferred item it is.

## 8. Data model

**PR 1 adds no migration.** Ephemeral means in-memory: `toolgen-registry.ts` holds a
session-keyed map and a gateway restart drops it, the same shape as I30's in-memory pairing
window. This is worth stating explicitly because V57, V58, V59 and V60 each carried one and the
reflex is to assume V61 belongs here. It does not — it belongs to PR 3 (§ 10).

Audit rows go to the existing `audit_log`; egress rows to the existing `egress_ledger` (V44).

## 9. Config, IPC, CLI

```toml

[tool_generation]
enabled = false               # lock 1 — default off, like every ai_v2 capability
allow_agent_initiated = false # lock 2 — PR 2; the dangerous half is opt-in ON TOP of lock 1
allowed_hosts = []            # lock 3 — PR 2, and it constrains the AGENT-initiated path only (§ 9.1)
max_tools_per_session = 3
max_requests_per_tool = 50
request_timeout_ms = 10000

```

### 9.1 Why `allowed_hosts` binds only the agent-initiated path

The tempting design is a global outer boundary that per-tool approval can narrow but never widen —
the monotonic-stricter shape I22 uses, and the `[computer_use] allowed_lanes` precedent where
`enabled = true` on its own actuates nothing.

It was rejected for the owner-initiated path, on this argument: **a lock whose error message tells
you how to open it is not a second judgment, it is a second step.** If `nimbus tool create` fails
with *"host not in allowed_hosts — add it"* and the owner edits config in the same minute, the
ceiling bought nothing. Its value depends entirely on the config edit being genuinely out of band
from the approval.

That condition holds in exactly one of the two paths:

- **Owner-initiated** — the human typed the intent. The approval is not a reflex; it is them
  finishing an act they started, reading a short host list against a request they made seconds
  ago. `max_tools_per_session` bounds the fatigue. A config ceiling here is friction without a
  threat.
- **Agent-initiated** — a prompt injection in indexed text can manufacture an approval prompt out
  of nothing. The owner never asked for a tool. Here the config edit really is a separate judgment
  made at a different time, because there was no act in progress to complete.

So the third lock ships with the switch it defends, and PR 1 is simpler for it.

### 9.2 Surface

`toolgen.*` joins the **whole-namespace** LAN-forbidden list in `ipc/lan-rpc.ts` alongside `exec`,
`computer`, `media` and `fleet` — `toolgen.create` is RCE-class by definition and
`toolgen.approvalRespond` is the local owner answering a prompt no peer may answer for them. It
stays absent from the Tauri allowlist (I7).

CLI: `nimbus tool create | list | revoke | credential set`, and `nimbus tool save` in PR 3.

`nimbus prove` gains a `COVERAGE_CLASS_LABELS` entry for `tool` (`packages/cli/src/commands/prove.ts:39`).
The label must say what the class covers and what it does not, the way the `browser` entry does:
outbound requests a runtime-generated tool made **through the broker** — which is all of them,
since no other route exists.

### 9.3 Error codes

One named code per refusal, so a caller can distinguish reasons without matching message text
(the `ExecRuntimeError` convention):

| Code | Trigger |
|---|---|
| `ERR_TOOLGEN_DISABLED` | `[tool_generation] enabled = false` |
| `ERR_TOOLGEN_POLICY_DISABLED` | `EnforcedPolicy.capabilitiesDisabled` contains `tool_generation`, **or the accessor is absent** |
| `ERR_TOOLGEN_AGENT_INITIATED_REFUSED` | agent-initiated while `allow_agent_initiated = false` (PR 2) |
| `ERR_TOOLGEN_SESSION_BUDGET_EXCEEDED` | `max_tools_per_session` spent |
| `ERR_TOOLGEN_SANDBOX_DEGRADED` | `canConfine(emptyPolicy)` non-null |
| `ERR_TOOLGEN_CONFINEMENT_FAILED` | the § 7.3 probe did not confirm confinement |
| `ERR_TOOLGEN_HOST_NOT_ALLOWED` | host outside the envelope, or refused by § 6.2.1 |
| `ERR_TOOLGEN_BUDGET_EXHAUSTED` | `max_requests_per_tool` spent |
| `ERR_TOOLGEN_RESPONSE_TOO_LARGE` | response exceeded `MAX_BROKERED_RESPONSE_BYTES` |
| `ERR_TOOLGEN_REDIRECT_REFUSED` | upstream answered with a redirect, which is refused rather than followed (§ 6.2.1) |
| `ERR_TOOLGEN_CREDENTIAL_UNAVAILABLE` | the Vault read for the host's bound credential FAILED (locked keychain, libsecret error). Distinct from "no credential bound", which is not an error and sends the request uncredentialed |

Registration into the agent follows the `buildComputerUseTools` pattern (`engine/agent.ts:536`): a
conditional spread contributing `{}` — *no tool at all*, not a disabled tool that errors when
called — when no live session holds a generated tool.

**With one correction that pattern alone does not supply.** `createNimbusEngineAgent` is called
**once, at boot** (`gateway-main.ts:111`), so a static `tools:` map is fixed for the process
lifetime and a tool registered mid-session would never become visible. Computer-use does not hit
this because its tools exist for the whole process when the lane is configured and check session
liveness at call time; a generated tool does not exist at boot at all.

The fix is already available: Mastra's `tools` accepts a `DynamicArgument`
(`@mastra/core/dist/agent/agent.d.ts:876`), i.e. a function resolved per request rather than a
static object. `tools` becomes `(ctx) => ({ ...baseTools, ...buildGeneratedTools(sessionId, registry) })`,
with `sessionId` read from the existing `agentRequestContext` `AsyncLocalStorage`. Newly approved
tools are visible on the next turn with no agent mutation and no rebuild.

This does change a load-bearing constructor for all three agents, so it is called out rather than
buried: the change is `tools:` static → `tools:` function, and `baseTools` is otherwise untouched.

**A dead tool stays dead.** If the child process exits, the registry marks the tool `terminated`
and subsequent calls return an explanatory error. It is **not** silently restarted: a restart
re-runs approved code the owner may reasonably believe stopped, and "it came back on its own" is
not a property anyone approved.

## 10. Delivery split

**PR 1 — the owner-initiated, ephemeral, brokered SUBSTRATE. Drafting is stubbed.**

**Stated during implementation, not discovered later:** PR 1 ships every safety mechanism and the
seam a model would draft through, but **not the drafting itself**. `ToolgenGateDeps.draftBody` — the
step where the model actually authors the tool body — has no implementation in this PR; the wiring
supplies a refusal (`ERR_TOOLGEN_DRAFT_NOT_IMPLEMENTED`). `nimbus tool create` therefore exercises
the whole gate and refuses at the last step rather than producing a tool.

That is deliberate. Drafting means designing an LLM prompt for the highest-blast-radius capability
in the repository, whose output is code that then runs with the owner's credentials. That prompt
deserves its own design pass and its own review, not an improvisation added late inside a large PR
to make a command look finished. Everything here is default-off (`[tool_generation] enabled =
false`), so the stub changes no shipped behaviour. The credential-binding deps are honest no-ops
for the same reason: `toolgen.create`'s wire contract carries no credential material yet, and
widening it belongs with the CLI flag that needs it.

What PR 1 does deliver, fully tested: the `toolgen/` chokepoint, `egress/tool-egress.ts`,
the `tool` coverage class, I39, D29(a)+(b), `[tool_generation]` (`enabled` +
`max_tools_per_session` + `max_requests_per_tool` + `request_timeout_ms`), the `toolgen.*` IPC
namespace, `nimbus tool create|list|revoke|credential set`, the LAN-forbid, and `tool_generation`
enforced at last rather than merely declared. No migration.

**PR 2 — drafting, not agent-initiated as this paragraph originally said.** **Corrected 2026-09-10,
by PR 3's own closing task, once both PRs had actually shipped:** PR 2 shipped 2026-09-10 as the
drafting capability § 6 had assigned to PR 1 as a stub (`ERR_TOOLGEN_DRAFT_NOT_IMPLEMENTED`) —
`nimbus tool create` actually drafts a tool body and input schema via a model
(`[tool_generation] drafting`, `"off"`/`"local"`/`"allow-remote"`, DEFAULT `"local"`) — rather than
the agent-facing proposal flow this paragraph originally described under that number. Detail:
[`2026-09-09-s2-toolgen-drafting-design.md`](./2026-09-09-s2-toolgen-drafting-design.md).

**Agent-initiated proposal** — `allow_agent_initiated` plus `allowed_hosts`, the agent-facing
proposal tool, the mid-turn consent pause, and an approval prompt that states the agent rather than
the owner initiated it — **did not ship as a numbered PR in this slice and is a named,
reason-recorded deferral**, the same treatment fleet's subject-enumeration PR 2b and the
computer-use screen lane received rather than a PR that quietly evaporated: every capability
through PR 3 is OWNER-initiated (`nimbus tool create`, `nimbus tool save`), and a model proposing a
network-reaching tool mid-conversation is a materially larger trust boundary than drafting one the
owner explicitly asked for — it deserves its own consent-UX design pass, not a rider on whichever
PR happened to ship next. See `docs/roadmap.md`'s toolgen row for the live deferral record.

**PR 3 — persistence**, `nimbus tool save`, schema V61, shipped 2026-09-10. It carries an
unresolved question named here rather than discovered there: **I16 verifies `publisher` extensions
by Ed25519 at install and at every startup, and a self-authored tool has no publisher.** Either it
installs unsigned like a local dev extension — meaning nothing detects on-disk tampering between
sessions — or the owner gets a signing key and saved tools are signed locally. The second is right,
and it is a real chunk of work, which is why it is its own PR rather than smuggled into PR 1. § 4.5
is what makes it cheap when it arrives.

**Recorded direction for PR 3, not designed here — and not what shipped; see invariant I40 for the
as-built shape:** a local signing keypair (`toolgen.signing.privkey` / `.pubkey`, Vault-only,
joining `PLATFORM_VAULT_KEYS`); `nimbus tool save` signs the § 4.5 canonical artifact and writes it
under `<configDir>/extensions/local.<toolId>/`; `verify-extensions.ts` verifies `local.*` against
the local pubkey at every startup and refuses fail-closed on mismatch, so on-disk tampering between
sessions is detected. That gives I16's property without third-party publisher infrastructure.
**As shipped, this premise did not hold, and the design changed accordingly:** PR 3 built a
dedicated `saved/<toolId>/` store with its own boot/load/spawn re-verification path
(`toolgen-saved-store.ts`, `toolgen-boot-reconcile.ts`, `toolgen-saved-spawn.ts`) entirely separate
from `extensions/verify-extensions.ts` and the `local.*` extension shape, rather than reusing
either — see invariant **I40** in `docs/SECURITY-INVARIANTS.md` for why and for the as-built
wiring.

## 11. Invariant I39 and static rule D29

**I39 (draft).** *A generated tool reaches the network only through `toolgen/toolgen-broker.ts`'s
brokered fetch, to a host on the envelope the LOCAL owner approved, carrying only the credential
bound to THAT host. The tool process's own `permissions.network` is empty by construction on every
platform — a requested grant is rejected, never dropped — so no other route exists; a raw `fetch()`
in the generated body fails at the OS. One `tool`-class egress row is appended before every
brokered request and an append failure aborts it (fail-closed); a refused host appends a `blocked`
row. Credentials are never inherited from a connector, never enter the tool process, and are bound
per-host rather than per-tool. Registration happens only after a green sandbox contract test and
the owner's approval of the VERBATIM canonical artifact, never a digest.*

***Residuals, stated here rather than discovered later. (1) The allow-list bounds WHERE a tool may
send, never WHAT.*** *A tool approved for `api.gitea.example` may send that host anything it can
compute, including data it legitimately received. The gate proves the owner saw the body and the
destinations; it does not prove the body is honest about what it does with what it reads. This
sentence belongs in the approval prompt as well as in this invariant. **(2) The destination check
is check-then-connect, not connect-to-checked** — see § 6.2.1's stated residual. The broker
validates every address a host resolves to, then issues the request against the hostname, because
the runtime offers no connection pinning; an attacker controlling an APPROVED host's DNS can still
rebind between the two lookups.*

**D29(a)** — the `nimbus/fetch` method literal is **defined once**, in `toolgen/toolgen-types.ts`,
and confined there; the stub emitter and the broker import the constant rather than repeating the
string. Confining a single definition site is a stronger rule than allow-listing the three files
that would otherwise each carry a copy, and it removes the drift the `SANDBOX_POLICY_ENV` comment
warns about for exactly this shape — a producer and a consumer that separately hardcode the same
literal are two copies that can diverge invisibly.

**D29(b)** — the generated-manifest constructor is confined to `toolgen/toolgen-stub.ts`, and
`permissions.network` may not be assigned a non-empty literal there.

**D29(c)** — the `toolgen.` Vault-key prefix is composed only in `toolgen/toolgen-credentials.ts`.
This was a *stated bound* in § 6.3's first draft — "capability confinement is the real defense,
the allow-list entry only documents the keyspace". A static rule is cheap and strictly better than
a paragraph, so it is one. The bound narrows rather than disappears: a dynamically assembled
prefix still evades a text scan, and capability confinement remains the primary defense, exactly
as D27(b) says of the `media_grant` table.

Per the triple rule, wiring + this document's promotion into `docs/SECURITY-INVARIANTS.md` + the
enforcement test in `packages/gateway/src/security-invariants.test.ts` land in the same commit.

## 12. Testing

**The load-bearing test is per-platform, and it needs a positive control.** A generated tool whose
body attempts a **raw `fetch()`** to a host that IS on its approved list must fail on Windows,
macOS and Linux — with the same request run through an **unconfined** process first, exactly as
`test/integration/computer-use/terminal-loopback.test.ts` does. Without the control, "the raw
fetch was blocked" passes for any reason at all, including the test never having reached the
network. That test is what makes § 4.3's claim true rather than lucky.

Then:

- A brokered fetch to a host **not** on the envelope is refused and appends a `blocked` row.
- An egress append failure **aborts** the brokered request (fail-closed).
- A red sandbox contract test refuses **before** consent — the owner is never prompted.
- Each § 5 refusal is decided before consent: assert the consent broker was **not** called, not
  merely that the outcome was a refusal. (Asserting the outcome alone passes for a gate that
  prompts and then refuses, which is the failure this ordering exists to prevent.)
- A credential bound to host A is **not** attached to a request to host B by the same tool.
- The registry is empty after a simulated restart, and a tool whose child process exits is marked
  `terminated` rather than restarted.
- **§ 6.2.1, the SSRF set**: a request to an approved hostname that RESOLVES to loopback, to a
  link-local or RFC 1918 address, or to `169.254.169.254` is refused — the check runs on the
  resolved address, so a hostname-only test would pass while the defect stood.
- A tool-supplied `Authorization` header is stripped and does not reach the wire.
- A response past `MAX_BROKERED_RESPONSE_BYTES` is aborted rather than buffered.
- **§ 7.3 red-proves by reverting**: a deliberately unconfined runner must make the confinement
  probe FAIL. Without this the probe passes for any reason at all, including never having run —
  which is precisely how the SDK's own default runner shipped broken (§ 7.1).
- **I11**: every generated tool reaches the model through the `<tool_output>` envelope. This is the
  most injection-prone tool surface in the tree — it returns a remote API's response verbatim into
  a prompt — so the envelope wrapper is a REQUIRED constructor parameter rather than something a
  caller remembers, making an unwrapped generated tool a compile error.
- Shutdown drains BOTH the registry and the script store. A drain that clears memory and leaves
  approved bodies on disk looks identical to success from memory.
- I39 enforcement in `security-invariants.test.ts`; D29(a)/(b) in
  `scripts/structure-audit/check-nimbus-invariants.ts`.
- `toolgen/*` needs an `audit:coverage-scopes` entry; without one it is covered only by the
  repo-wide floor.

## 13. What this spec asserts vs. what it assumes

**Verified against the tree on 2026-09-09:**

- `tool_generation` is in `AI_V2_CAPABILITIES` and referenced nowhere else, tests included.
- The § 3 platform table, at the cited line numbers.
- `runSandboxContractTests` is exported by `@nimbus-dev/sdk/testing` and has zero callers here —
  **and its default probe runner is unsandboxed, so a bare call fails 100% on Linux/macOS for an
  empty-network manifest** (§ 7.1). `ProbeRunner` is synchronous and `SandboxRunner` has no
  `spawnSync`, so the obvious injection fix does not type-check either (§ 7.2).
- `@mastra/mcp` holds its SDK client PRIVATE (`client.d.ts:60`) and exposes only
  `setElicitationRequestHandler` (`:272`) — no custom request handler. The official SDK's
  `Protocol.setRequestHandler` IS public (`protocol.d.ts:389`).
- `createNimbusEngineAgent` is called ONCE at boot (`gateway-main.ts:111`), so a static `tools:`
  map cannot see a mid-session registration; Mastra's `tools` accepts a `DynamicArgument`
  (`@mastra/core/dist/agent/agent.d.ts:876`), which is the fix.
- `exec/exec-runtimes.ts` records, as MEASURED Windows behaviour, that a file named as bun's entry
  point fails under AppContainer while `import()` of the same file succeeds — which is why § 6.4
  invokes via an `-e` import stub rather than `bun run <path>`.
- `packages/cli/src/commands/prove.ts:39` holds `COVERAGE_CLASS_LABELS`.
- `@mastra/mcp` registers a server→client handler for `elicitation/create` at
  `dist/index.js:22037`; `@modelcontextprotocol/sdk` 1.30.0 carries elicitation and sampling.
- `COVERAGE_CLASSES` has nine members; seven are non-`none`.
- `connectors/lazy-mesh/user-mcp.ts` already spawns an arbitrary user-declared MCP server through
  `wrapServerSpec` with a zero-permission default manifest — the closest existing precedent.
- `ipc/lan-rpc.ts` forbids `exec`, `computer`, `media` and `fleet` at namespace granularity.
- `extensions/canonical-json.ts` re-exports `canonicalizeManifest` from the SDK.

**Assumed, and to be proven during implementation:**

- That a custom MCP method survives the `@mastra/mcp` client transport in both directions without
  patching the library. If it does not, the fallback is the raw `@modelcontextprotocol/sdk`
  `Client` for this path only — the gateway already resolves it transitively — and generated tools
  do not use `MCPClient`. **This is the single largest implementation risk in PR 1** and should be
  spiked before the rest of the gate is built.
- That the sandbox forwards stdio for a network-empty policy identically on all three platforms
  for a long-lived MCP server, not merely for the short-lived exec child measured by I33.
- That the § 7.3 probe runs green on a CI runner for an empty-permission manifest. CI installs
  bubblewrap but not `nimbus-sandbox-helper`; an empty network set should not need it
  (`linux.ts:233-238` says so explicitly), but this has never been exercised from the gateway.

**Deferred deliberately, recorded so it does not read as an oversight:**

- **Adding `SandboxRunner.spawnSync`** so the SDK's own `runSandboxContractTests` becomes usable
  (§ 7.2). Three platform implementations and a PAL widening this row does not need.
- **Reporting the SDK default-probe bug upstream** to `nimbus-agent/nimbus-sdk`: the docstring
  says production callers should leave `runProbe` undefined, and doing so cannot work. Separate
  repo, separate PR.
- **`http:` and RFC 1918 for local development.** § 6.2.1 denies both. A `[tool_generation]`
  local-dev escape hatch is plausible and is NOT in PR 1 — the default must be deny, and an
  opt-out wants its own thought about what it re-exposes.
