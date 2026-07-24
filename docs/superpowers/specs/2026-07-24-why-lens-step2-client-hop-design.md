# Why-lens step 2 — expose `why` / `whyPeek` through the narrow waist

> Design spec. Roadmap: [`docs/ecosystem-roadmap.md`](../../ecosystem-roadmap.md) § Stage 2 → 2a.
> Predecessor: [`2026-07-23-nimbus-why-lens-design.md`](./2026-07-23-nimbus-why-lens-design.md)
> (step 1a graph edges, step 1b the agent). This is **step 2**: the SDK → client hop.

## Problem

Step 1b (PR #820) shipped the `why` lens on two surfaces: the gateway
(`agents.why` / `agents.whyPeek`) and the CLI (`nimbus why`). It is **not
reachable through `@nimbus-dev/client`**, because the two methods landed after
the client's last publish (0.11.0). Until the client exposes them, the VS Code
extension — where the roadmap's Stage 2a hover lens and Stage 3 demo live —
cannot consume the lens. The narrow-waist thesis of the whole ecosystem
roadmap is that a built capability must be *reachable*; today `why` is built
but stranded one hop short.

The gateway's own `why-types.ts` header already designs the fix: the Why types
"deliberately do NOT live in `@nimbus-dev/sdk` yet … promoting the ninth agent
is the step-2 sdk → client hop. When that lands, these move to the SDK and
`findings.ts` re-exports them like the other eight."

## Goal

Expose the `why` lens through the client with the same one-source-of-truth
typing every other agent already has, and publish the releases so the VS Code
extension can depend on them.

Non-goal: the VS Code hover UI itself (a separate `nimbus-vscode` slice) and
any change to the lens's behavior. This is a pure reachability + type-promotion
hop — no new gateway logic.

## Approach (chosen: A — full SDK promotion)

Three repos, released in dependency order:

1. **`@nimbus-dev/sdk` 1.5.2 → 1.6.0** — promote the Why types (single
   definition shared by gateway, CLI, client).
2. **`@nimbus-dev/client` 0.11.0 → 0.12.0** — depend on sdk `^1.6.0`; add
   `agentsWhy` + `agentsWhyPeek` + Mock + validator + surface-parity coverage.
3. **Gateway (Nimbus)** — depend on sdk `^1.6.0`; re-export the promoted types
   from `agents/_lib/findings.ts`; delete the local definitions in
   `agents/_lib/why-types.ts`.

Rejected alternatives: **B (client-local types)** duplicates the type across
the waist and re-creates the drift Stage 0 sealed — the gateway comment
explicitly rejects it. **C (SDK + client, defer the gateway re-export)** leaves
twin definitions in gateway and SDK; the gateway cleanup is cheap enough to do
now and avoids a stranded follow-up.

## Release order and verification

Publish is dependency-gated:

1. Merge + publish **SDK 1.6.0**; verify `npm view @nimbus-dev/sdk@1.6.0` is
   live before touching the client.
2. Merge + publish **client 0.12.0** (dep `^1.6.0`); verify
   `npm view @nimbus-dev/client@0.12.0` is live.
3. Merge the **gateway PR** (dep `^1.6.0` + re-export). The gateway only needs
   1.6.0 to exist on npm; it does not need the client.

Both SDK and client release via their own `release-please` pipelines. Per the
repo's release history, a manual tag push is sometimes required for the tag to
cut — treat "PR merged" as *not yet released* and verify the npm version
explicitly (this spec's definition of done includes both packages resolvable on
npm at the new versions).

## Component design

### SDK 1.6.0 — the promoted types

Copied **verbatim** from the gateway's current `why-types.ts` (today's source
of truth) so the shapes are byte-identical and the gateway re-export
typechecks.

- `src/agents/brief-types.ts` — add the leaf types: `WhyLane` (the 6-lane
  union), `WhyFinding`, `WhySubject`.
- `src/agents/brief-composites.ts` — add:
  - `WhyBrief = AgentBriefBase & { kind: "why"; query: { ref: string; line: number | null }; subject: WhySubject | null; findings: WhyFinding[] }`, added **into the `AgentBrief` discriminated union**.
  - `WhyPeek` as a **standalone** export (author/PR/ticket/hasMore synchronous
    peek result). It is **not** a brief and is **not** in the `AgentBrief`
    union — it carries no `AgentBriefBase` fields and no gap notes.
- `src/agents/brief-guards.ts` — add `isWhyBrief` via the existing
  `createBriefGuard<WhyBrief>("why")`. **No `isWhyPeek`** — `WhyPeek` is not a
  union member, so a discriminated guard would be dead code (YAGNI).
- `src/index.ts` — export `WhyLane`, `WhyFinding`, `WhySubject`, `WhyBrief`,
  `WhyPeek`, `isWhyBrief`.

`WhyInput` (`{ ref: string; line?: number }`) is a *request-params* type, not a
result type; the client owns its own `WhyParams` (below), so `WhyInput` need
not be promoted.

### Gateway — consume + re-export

- `package.json` — bump `@nimbus-dev/sdk` to `^1.6.0`.
- `agents/_lib/findings.ts` — add `WhyBrief`, `WhyFinding`, `WhyLane`,
  `WhySubject`, `WhyPeek` to the `export type { … } from "@nimbus-dev/sdk"`
  block and `isWhyBrief` to the guard re-export block (mirrors the other 8).
- `agents/_lib/why-types.ts` — delete the local type definitions; re-export the
  five promoted types **from `./findings.ts`** (which is the gateway's SDK
  re-export shim — `why-types.ts` already imports `AgentBriefBase` from it, so
  the dependency direction is unchanged). Keep `WhyInput` defined locally (it
  stays the gateway/CLI request-shape). Update the header comment (the "do NOT
  live in the SDK yet" note is now obsolete).
- No change to `why.ts` / `why-peek.ts` / `agents-rpc.ts` runtime — they import
  the same names, now sourced from the SDK. `bunx tsc` is the proof the shapes
  still line up.

### Client 0.12.0 — the two methods

- `package.json` — bump `@nimbus-dev/sdk` to `^1.6.0`.
- `src/agents.ts` — add `"why"` to `AgentName`; add `why: WhyParams` to the
  params map and `why: WhyBrief` to the brief map (so `AgentParamsFor<"why">`
  and `BriefFor<"why">` resolve). `WhyParams = { ref: string; line?: number }`.
- `src/nimbus-client.ts`:
  - `agentsWhy(p: WhyParams, o?: { timeoutMs?: number }): Promise<WhyBrief>` →
    `this.runAgent("why", p, o)` (unchanged machinery: calls `agents.why`,
    validates the `sessionId`, awaits `why.briefReady`).
  - `agentsWhyPeek(p: WhyParams): Promise<WhyPeek>` — a **new synchronous
    method** mirroring `searchRanked`: `const raw = await this.ipc.call("agents.whyPeek", { ref, line }); return validateWhyPeek("agents.whyPeek", raw);`.
- `src/validate.ts` — add `validateWhyPeek` (shape-check the `WhyPeek` fields:
  nullable `subject`/`author`/`pr`/`ticket`, boolean `hasMore`), mirroring the
  existing validators (e.g. `validateSessionRecall`).
- `src/mock-client.ts` — add a `why: WhyBrief` entry to the mock brief map and
  an `agentsWhyPeek` returning a deterministic `WhyPeek` fixture; the mock must
  expose both new methods so the surface-parity guard stays balanced.
- `src/index.ts` — re-export `WhyParams`/`WhyBrief`/`WhyPeek` types if the
  client barrels its public types (follow the existing convention).

## Testing

- **SDK:** unit test for `isWhyBrief` (positive + negative), mirroring
  `isExpertBrief`; the type additions are compile-checked by the existing build.
- **Client:** a unit test per method against the Mock (`agentsWhy` resolves a
  `WhyBrief`; `agentsWhyPeek` resolves a `WhyPeek`); the standing **surface-
  parity guard** asserting the real client and the Mock expose the same method
  set (now +2); `verify:sdk` against the locally-built SDK 1.6.0.
- **Gateway:** the existing `why` / `why-peek` / `agents-rpc.why` suites must
  stay **green unchanged** after the re-export swap (behavior is identical);
  `bunx tsc -p packages/gateway/tsconfig.json` is the load-bearing check that
  the promoted SDK shapes match the gateway's runtime producers.

## Risks

- **Shape drift between the gateway producers and the promoted SDK types** —
  mitigated by copying the gateway's exact definitions and letting the gateway
  `tsc` re-export fail loudly if they diverge.
- **Release sequencing** — a dependent repo built against an unpublished
  version fails `bun install`. Mitigated by the explicit
  publish-then-verify-then-proceed order above.
- **`release-please` not auto-cutting the tag** — a known repo trap; verified
  by checking npm, not by trusting the merge.

## Definition of done

- `@nimbus-dev/sdk@1.6.0` and `@nimbus-dev/client@0.12.0` both resolvable on
  npm.
- `client.agentsWhy(...)` and `client.agentsWhyPeek(...)` callable and typed
  against the SDK.
- Gateway builds against sdk `^1.6.0` with `why-types.ts` re-exporting; all why
  suites green.
- `ecosystem-roadmap.md` Stage 2a updated to record the lens is now reachable
  through the client (the "spiked, not built / banner didn't ship" framing
  retired for the reachability claim).
