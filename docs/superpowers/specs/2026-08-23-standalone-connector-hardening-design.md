# Standalone Connector Hardening (Project B)

**Date:** 2026-08-23
**Branch:** `dev/asafgolombek/connector-extraction`
**Status:** design — approved in brainstorm, not yet planned or implemented
**Successor:** Project A — connector extraction to a separate repo (§12). Deliberately sequenced *after* this.
**Related:** `nimbus-agent/nimbus-mcp-servers` — the scaffold repo this design unblocks. Deliberately
not hyperlinked: the repo is private, so the lychee gate (which scans `**/*.md`) would 404 it.

---

## 1. Goal

Make `packages/mcp-connectors/*` safe to run **outside the Nimbus gateway**, so a curated set can be
published as standalone MCP servers for Claude Desktop / Cursor / any MCP client — without shipping
ungated destructive tools under the Nimbus name.

The work is entirely inside the monorepo. It moves no files and creates no repos. Every gate still
sees both sides of every change atomically, which is the property Project A gives up.

### The problem, stated precisely

A Nimbus connector today is a thin stdio MCP server whose write tools **really mutate**. Enforcement
of consent lives entirely in `packages/gateway/src/engine/executor.ts` (`I2`/`I3`), one process away.
Run the same connector under Claude Desktop and `github_branch_delete` becomes a directly
model-callable, ungated `DELETE` carrying the user's PAT.

This is not a documentation gap. It is Non-Negotiable #2 (*HITL is structural — the consent gate
lives in the executor, not the prompt*) ceasing to hold the moment the executor is not in the picture.

### Non-goals

| Deferred | Why |
|---|---|
| Moving connectors to their own repo | That is Project A (§12). This design is a prerequisite for it, not a part of it. |
| Recreating the I15 sandbox off-gateway | I15 is a property of *how the gateway spawns* a connector (network allow-list, cwd confinement). A published package cannot recover it, and should not pretend to. It is a reason to use the full ecosystem. |
| Vault access from a connector | Forbidden by design and staying that way. Credentials are env-injected, already, in both modes. |
| Replacing the gateway's own HITL | `executor.ts` is untouched. Gateway behaviour changes by exactly one line (§4). |
| **Publishing** to npm | B *builds and tests* the standalone launcher (§9) and proves it in a real MCP client. Actually publishing it — registry names, release choreography, version pinning — is Project A. B makes the code worth publishing; A ships it. |

---

## 2. Verified facts this design rests on

Each was checked against the code or executed on 2026-08-23. Re-verify anything you are about to
depend on; several corrected an assumption held at the start of the brainstorm.

| # | Fact | Evidence |
|---|---|---|
| F1 | Connectors are the MCP **tool surface only**. `ConnectorSyncHandler` occurs **zero times** under `packages/mcp-connectors/`. Every sync handler is gateway-side (`connectors/github-sync.ts`, `github-index-repos.ts`, …). | `grep -rn "ConnectorSyncHandler\|nextSyncToken\|SyncResult" packages/mcp-connectors` → empty |
| F2 | `assertHitlRequired()` **does not exist** — zero occurrences in connectors, absent from the SDK. The `nimbus-connector-authoring` skill documents it as mandatory. There is no in-connector consent enforcement of any kind. | `grep -rn "assertHitlRequired" packages/mcp-connectors` → `0` |
| F3 | Write tools genuinely mutate. `github_branch_delete` issues a real `DELETE`; `github_pr_merge` a real `PUT`. `"(requires HITL repo.pr.merge)"` is prose inside a description string. | `packages/mcp-connectors/github/src/server.ts` |
| F4 | **37** connectors declare `write`/`delete` in `hitlRequired`; **57** are already read-only; **34** contain a mutating HTTP call; **73** mutating call sites; **23** distinct `"requires HITL …"` prose strings. Four counts of one thing, none authoritative. | manifest + source greps |
| F5 | Write status **cannot be inferred from HTTP method**. Linear sends every GraphQL call, read and write alike, as `POST` to one endpoint. A "non-GET means write" rule misclassifies in both directions. | `packages/mcp-connectors/linear/src/server.ts` |
| F6 | `@modelcontextprotocol/sdk` **1.30.0 — already pinned by all 94 connectors** — has `server.elicitInput()` → `ElicitResult` (`accept`/`decline`/`cancel`), `server.getClientCapabilities()`, `oninitialized`, `registerTool` + `sendToolListChanged()`, and `sendLoggingMessage()`. | `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts:121,158,190`, `mcp.d.ts:150,206` |
| F7 | Protocol version is a **non-issue**. `LATEST_PROTOCOL_VERSION = '2025-11-25'`; supported includes `2025-06-18` (the elicitation revision). The `"2024-11-05"` string is hardcoded in the boot-smoke *test client*, not in the servers. | `types.js:2-4`; `scripts/connector-boot-smoke.ts` |
| F8 | `@mastra/mcp` 1.16.0 supports elicitation via `client.elicitation.onRequest(handler)`, and **the gateway never wires one** (zero hits in `packages/gateway/src`). Gating write-tool registration on client capability would therefore have silently stripped write tools from 37 connectors *inside Nimbus*. | `packages/gateway/node_modules/@mastra/mcp/dist/client/actions/elicitation.d.ts`; `grep -rn "elicitation" packages/gateway/src` → empty |
| F9 | Credentials already arrive as **env vars** (`requireProcessEnv("GITHUB_PAT")`); the gateway reads the Vault and injects at spawn. The connector needs **no change** to work standalone. The thing that breaks off-gateway is the consent gate, not the credential model. | `shared/mcp-tool-kit.ts` → `@nimbus-dev/sdk/connector-kit`; `lazy-mesh/connector-spawns.ts:274` |
| F10 | `Bun.spawn` is used by `shared/run-cli-json.ts` and 6 connectors (athena, bigquery, cloud-logging, cloudwatch, sagemaker, vertex-ai). All 94 manifests declare `"runtime": "bun"`. `npx` runs Node. | `grep -rn "Bun\." packages/mcp-connectors/*/src` |
| F11 | `@noble/hashes` is **not** in `ALLOWED_CONNECTOR_DEPS`, so the gateway's BLAKE3 chain construction is unreachable from a connector. `node:crypto` is already used in connectors. | `scripts/structure-audit/check-connector-deps.ts` |
| F12 | Every connector's `bin` and manifest `entrypoint` points at `dist/server.js`, which **no build script produces** — every build emits `--compile --outfile dist/nimbus-mcp-<id>`, a binary. All 94 bins are dead today. | `packages/mcp-connectors/*/package.json` |
| F13 | I26's `isConnectorWriteToolId` covers only the warehouse + GitOps/ML groups (~20 tool ids). `github_pr_merge` is classified **nowhere**. The HITL gate keys on `action.type`, never on `payload.mcpToolId` (I3), so no per-tool write classification exists for connector tools. | `connectors/connector-write-registry.ts`; `grep -rn "github_pr_merge" packages/gateway/src` → empty |
| F14 | `run-bundled-connector.ts` is the **single chokepoint** for gateway-side connector startup. Every spawn routes through `selfSpawn("connector", [id])` → the `__nimbus-connector` sentinel → `runBundledConnector`. | `lazy-mesh/keys.ts:9`, `connectors/run-bundled-connector.ts` |

**F2, F12 and F13 are pre-existing defects surfaced by this design, not consequences of it.** F2 in
particular means the authoring skill instructs contributors to call a function that does not exist.

---

## 3. Threat model

The actor is **the model**, not the human. A user who deliberately wires a raw connector into a
client is exercising judgment; an LLM that decides to tidy up some branches is not.

| Property | On-gateway | Standalone, after this design |
|---|---|---|
| Consent before mutation | `executor.ts` gate, Nimbus's own code, prompting the owner (I2) | MCP elicitation, **rendered by the client** — real consent, weaker trust base |
| Model can call an unseen write tool | No | No — not registered at all unless the client advertises `elicitation` (§5) |
| Blast radius | Vault-scoped credential | **Server-enforced** scope allow-list + budget (§6) — holds against a hostile client |
| Process confinement | I15 sandbox | **None.** Not recoverable. Documented, not mitigated |
| Audit | `audit_log`, BLAKE3-chained | SHA-256-chained JSONL + MCP log notifications (§7) |
| Egress ledger | I29 | None — the gateway is not in the path |

**Explicitly rejected as security theatre:** two-phase confirmation tokens, and "dry-run unless
`confirm=true`". Both read as consent but the *model* makes the second call, so they defend against
nothing in this threat model. They are named here because they are the obvious-looking answers.

---

## 4. B1 — Mode is derived from the entrypoint, not from configuration

Two consumers, two entrypoints, **no runtime detection and no configuration switch**:

```text
gateway     nimbus-gateway __nimbus-connector github
            → run-bundled-connector.ts   setConnectorMode("gateway")   ← the one new line
            → import(".../github/src/server.ts")
              full tool surface; executor.ts gates it (I2, untouched)

standalone  npx nimbus-mcp github
            → standalone launcher        mode stays "standalone" (the default)
            → import(".../github/src/server.ts")
              hardened surface (§5, §6, §7)
```

The registrar in `shared/` reads the mode at tool-registration time. Ordering is sound because the
launcher sets the mode *before* dynamically importing the connector, and connectors register tools at
module scope.

Three properties, in priority order:

1. **Fail-closed by default.** `"standalone"` is the default; the **gateway** is what must opt out.
   If the chokepoint line is ever deleted, the gateway degrades to read-only — loud and safe — rather
   than the standalone build silently ungating. The failure mode points the right way.
2. **Not configurable away.** Mode comes from *which entrypoint ran*, not an env var. Non-Negotiable
   #2 survives literally: a standalone user cannot set a variable to disable consent. This is the
   "by construction rather than by check" shape I31 already uses for reserved sections.
3. **Zero risk to the gateway path.** F14 gives a single chokepoint; F8 shows why deriving mode from
   *client capabilities* instead would have been a production regression.

**Known bound, accepted:** someone holding the gateway binary can run
`nimbus-gateway __nimbus-connector github` directly and get the ungated surface. That is a human
deliberately choosing it, and they already have the gateway. Documented, not defended against.

---

## 5. B2 — Per-tool write declaration

Write status becomes **declared**, because F5 proves it cannot be inferred:

```ts
registerWriteTool(
  "github_pr_merge",
  { mutates: "repo.pr.merge", reversible: false },
  schema,
  handler,
);
```

Three things follow, in ascending order of value:

1. The standalone gate gets something machine-readable to key on.
2. A **static audit** in the D10–D23 family: *no connector handler may issue a mutating request
   except through `registerWriteTool`*. It keys on the registrar rather than the HTTP verb, which is
   the only way to catch the GraphQL case (F5).
3. It closes a **gateway-side** gap that exists today: I26's predicate covers ~20 of ~73 mutating
   call sites (F13). A declared per-tool write set can feed `isConnectorWriteToolId`.

Item 3 means B repairs something real in the gateway whether or not Project A ever happens.

**Wiring the declaration into I26's predicate is in scope** but must land last, after everything else
in B, because it touches a live invariant and must carry the triple in one commit: production
wiring, a `docs/SECURITY-INVARIANTS.md` entry, and an enforcement test in
`security-invariants.test.ts`.

---

## 6. B3 — The consent gate

On `oninitialized`, read `getClientCapabilities()`:

+ Read tools **always** register.
+ Write tools register **only** when `elicitation` is advertised, followed by `sendToolListChanged()`.
+ On invocation: present the **verbatim** operation and resolved parameters — never a digest, for the
  same reason I33 refuses one — and mutate only on `action === "accept"`. Decline, cancel, timeout, or
  transport error all mutate nothing.

Default-deny *registration* is the load-bearing half. The model cannot call a tool it never saw, so on
a non-supporting client the server is genuinely read-only and announces why. The same published
artifact becomes write-capable the moment that client ships elicitation — no republish, and no
hand-maintained compatibility matrix. Any published matrix must be **generated by a probe script**;
this repo's history with hand-maintained tables is poor (the CLAUDE.md version line sat wrong through
ten releases and a major-version boundary).

---

## 7. B4 — Client-independent controls

Everything in §6 depends on the client behaving. These do not, which is why they are worth more:

| Control | Mechanism | Defeats |
|---|---|---|
| **Scope allow-list** | `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE=owner/repo,…`, read **once at startup**; mutations outside refuse | A model widening its own blast radius — it cannot reach the value |
| **Mutation budget** | max N mutations per process lifetime | Runaway agent loops |
| **Reversibility capture** | record pre-state (e.g. the ref SHA) into the audit receipt *before* a destructive call | Makes the worst irreversible operation recoverable |

The scope allow-list is the single strongest control in this design, because it is the only one whose
enforcement point is entirely ours and whose input the model cannot influence.

---

## 8. B5 — Audit, two channels

They fail differently, so both exist:

+ **Client-visible** — `sendLoggingMessage()` on `requested` / `accepted` / `declined` / `executed`,
  so *any* MCP client can display or persist it, plus a receipt in the tool result so the record lands
  in the conversation transcript.
+ **Durable and tamper-evident** — append-only JSONL at `NIMBUS_MCP_AUDIT_LOG` (default: OS data
  dir), hash-chained with the same construction as `db/audit-chain.ts`, verified timing-safe per I10,
  with a `verify` subcommand.

**Hash differs deliberately:** SHA-256 via `node:crypto`, not BLAKE3, because `@noble/hashes` is not
reachable from a connector (F11) and the artifact must run under Node (F10). Same construction,
different primitive, stated rather than silently divergent.

The log is designed to be importable into Nimbus later, which makes standalone use a funnel rather
than a dead end.

---

## 9. B6 — Packaging and runtime target

**One `nimbus-mcp` bin taking a connector id** (`npx nimbus-mcp github`), not 94 bins. One file
serves all 94 and sidesteps repairing 94 dead `bin` entries (F12).

**Runtime target: Node** for the standalone artifact — built JS, because `npx` is what essentially
every Claude Desktop and Cursor config uses. The gateway continues to consume **TS source under Bun**
and is unaffected.

This costs the single-binary product property nothing. Verified by experiment on 2026-08-23: a package
with subpath `exports`, imported via bare-specifier dynamic imports, compiled with
`bun build --target bun --compile`, then run with `node_modules` deleted from a clean directory:

```text
bundle 3 modules → expbin.exe
ALPHA-FROM-TS-SOURCE     ← exports map → .ts source
BETA-FROM-BUILT-JS       ← exports map → built .js
```

Both embed; `bun run` also executes `.ts` from `node_modules` uncompiled, so the dev loop survives.
This is the evidence Project A's "publish `src/` or `dist/`" decision needs, and the answer is **both**.

**The 6 `Bun.spawn` connectors** (F10) get a `node:child_process` shim. `shared/run-cli-json.ts`
centralises most of it; the six `tools.ts` files call `Bun.spawn` directly and need porting too.

---

## 10. B7 — Licence and positioning

Keep `AGPL-3.0-only` **unchanged**. AGPL §7 forbids adding restrictions, so *"use Nimbus if you want
real HITL"* cannot be a licence term without forking the licence. What is legitimate:

+ A **`NOTICE`** file stating the security tiering, whose preservation is required under **§7(b)**
  ("requiring preservation of specified reasonable legal notices or author attributions") — the one
  lever AGPL actually grants.
+ The same tiering in the MCP **`instructions`** field of the initialize response, making it
  machine-readable to every client rather than prose in a README nobody opens.
+ **Trademark** policy — not copyright — for "a stripped fork may not call itself Nimbus-grade".

The tiering to state plainly: standalone gives client-mediated consent, server-enforced blast-radius
limits, and a local audit chain. It does **not** give the I15 sandbox, the Vault, the I29 egress
ledger, or owner-controlled consent. Those require the gateway.

---

## 11. Testing and gates

| Layer | What it proves |
|---|---|
| Unit — consent kit | Decline / cancel / timeout / transport-error each mutate **nothing**; `accept` mutates once |
| Unit — mode | Default is `"standalone"`; only the gateway chokepoint sets `"gateway"` |
| Unit — scope + budget | Out-of-scope refuses; budget exhaustion refuses; neither consults the client |
| Unit — audit chain | Chain verifies; a tampered row fails; comparison is timing-safe (I10) |
| Static audit (new) | No mutating handler outside `registerWriteTool` — catches the GraphQL case (F5) |
| Integration | A fake MCP client **without** `elicitation` sees zero write tools registered |
| Integration | A fake client **with** `elicitation` that declines produces no HTTP call |
| Regression (**required**) | Gateway mode still registers **every** write tool of every write-declaring connector — the F8 regression, red-proved by reverting the chokepoint line, not by observing green |
| `test:connector-boot` | All 94 still boot from the compiled binary — the only gate that proves the registry works end to end |

Coverage: connectors carry ≥85% line / ≥80% branch per the per-file floor, which is CI-Linux-authoritative.

Every new test must be **red-proved by reverting the fix**, not by observing green — a repeatedly
recorded failure mode in this repo.

---

## 12. Project A — recorded, deferred, and costed

Project A is the extraction of `packages/mcp-connectors/` into its own repo, published to npm and
consumed back. It is **not** designed here. This section records what the brainstorm established so
the sequencing call against Spine S2 can be made on evidence, and so the analysis is not re-derived.

### What A would cost

+ **84 files** reference the `mcp-connectors` path — 31 `scripts/`, 29 `docs/`, 10
  `packages/gateway/`, plus `biome.json`, `knip.json`, `.github/labeler.yml`, and two workflows.
  Not "four gates".
+ **Five** path-resolving gates, not four: `gen:connector-registry`, `audit:connector-entrypoints`,
  `audit:connector-deps`, `audit:connector-registry-drift`, and **`test:connector-boot`** — the last
  being the only one that proves the compiled binary can actually start a connector.
+ `audit:connector-deps` would have to check the gateway's **resolved dependency tree** rather than
  source manifests, because a native transitive dependency silently breaks the compiled binary.
+ **201 test files** leave the monorepo suite. `scripts/ci/cross-platform-parity.test.ts:103` asserts
  `packages/mcp-connectors` appears in the `bun test` path list of *both* `ci.yml` and
  `_test-suite.yml` — landed in #1315, one commit before this branch.
+ `shared/` is **not a package**: 166 files import `../../shared/*.ts` by relative path from outside
  their own package directory. Per-connector npm packages cannot work without making it a real
  dependency or bundling it.

### What A would buy — less than it appears

F1 is the reframing. The connectors are the thin MCP tool surface (~6 files and ~300 LOC each); the
per-connector *intelligence* — 176 sync-related files, plus catalog, secrets manifest, credential
probe, spawner and first-party manifest entries — stays in the gateway. Extraction does not produce a
self-contained connector ecosystem, and "add a connector" remains majority-gateway work afterwards.

Version skew is already the norm and would get worse: `@nimbus-dev/sdk` is pinned at four different
floors in one repo today — gateway `^1.18.0`, root `^1.16.0`, cli `^1.11.1`, connectors `^1.8.1` —
against a registry at 1.20.0.

### Why B first

B needs no repo move, keeps every gate atomic, and delivers standalone-ready connectors in place. If
A is deferred behind S2 or dropped, B has still shipped the thing that made publication possible.
A's design should be written only once B has landed, so it moves already-correct code.

---

## 13. Open questions

1. **Which connectors ship standalone first?** All 94 become *capable*; the curated first wave is a
   product call. The 57 already-read-only ones (F4) are the natural start — no consent surface at all.
2. **Does `nimbus-mcp-servers` become the publishing home, or does this repo publish directly?** A
   Project A question; B is indifferent.
3. **Should the gateway wire `client.elicitation.onRequest` (F8)?** Not needed by this design, but it
   would let the gateway reuse one consent path for both modes. Out of scope, worth recording.
