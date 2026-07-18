---
name: nimbus-tool-output-envelope
description: >
  The `<tool_output>` envelope that wraps every LLM-facing tool result in Nimbus (invariant
  `I11`). Use when adding an agent surface, registering a Mastra tool, exposing an MCP-backed
  tool to the LLM, building a sub-agent worker, deciding whether to `wrapToolOutput`, or
  auditing a path where tool output reaches the conversational model (incl. prompt-injection
  test failures). Consult before any code that hands a tool result to the LLM — the B1 audit
  found the envelope orphan-defined, and a similar gap is the easiest prompt-injection regress.
---

# Nimbus Tool-Output Envelope (I11)

## Why This Skill Exists

The B1 internal security audit (Phase 4, 2026-04-25) found that `wrapToolOutput` had been **defined in code but had zero production callers** for a meaningful window. Documentation continued to claim prompt-injection defense was active. The defense is now wired at two production sites and protected by an enforcement test in [`packages/gateway/src/security-invariants.test.ts`](../../packages/gateway/src/security-invariants.test.ts), but the gap can be reintroduced silently every time a new agent surface is added.

This skill is the rule a contributor consults **before** adding such a surface.

## The Rule

Every tool result that flows into an LLM context is wrapped at the LLM-facing boundary in a textual envelope:

```
<tool_output service="…" tool="…">…JSON-stringified body…</tool_output>
```

The envelope is applied **at the LLM-facing path only** — not on the planner-side `ConnectorDispatcher → ToolExecutor` path, where the structural HITL gate (invariants `I2`/`I3`/`I4`) is the defense.

If your new code hands a tool result to the LLM and does not call `wrapToolOutput`, **the defense is regressed for that surface** regardless of what other surfaces do.

## Where It Lives

| File | Role |
|---|---|
| [`packages/gateway/src/engine/tool-output-envelope.ts`](../../packages/gateway/src/engine/tool-output-envelope.ts) | `wrapToolOutput(ctx, result)` — the only correct way to produce the envelope |
| [`packages/gateway/src/engine/agent.ts`](../../packages/gateway/src/engine/agent.ts) `wrapToolForLlm` (lines 25–76) | Tool-definition decorator applied to each Mastra-registered tool when the agent is built. Replaces the tool's `execute` so its return value flows through `wrapToolOutput` before reaching the LLM. Every `searchLocalIndex` / `fetchMoreIndexResults` / etc. result is wrapped here. |
| [`packages/gateway/src/connectors/lazy-mesh/mesh.ts:459`](../../packages/gateway/src/connectors/lazy-mesh/mesh.ts) | Lazy-mesh dispatcher `listTools()` (lines 440–492) — wraps every MCP tool result that is exposed via Mastra to the LLM |
| [`packages/gateway/src/security-invariants.test.ts`](../../packages/gateway/src/security-invariants.test.ts) | Enforcement test — fails if a known wiring site stops calling `wrapToolOutput` |

If you add a third LLM-facing path, **you also add a wiring assertion in `security-invariants.test.ts`** so the next regression fails CI immediately.

## Anatomy of the Envelope

```typescript
export function wrapToolOutput(ctx: ToolOutputContext, result: unknown): string {
  const body = JSON.stringify(result ?? null);
  const safeBody = body.replaceAll("</tool_output>", String.raw`<\/tool_output>`);
  return `<tool_output service="${escapeAttr(ctx.service)}" tool="${escapeAttr(ctx.tool)}">${safeBody}</tool_output>`;
}
```

Three load-bearing details:

1. **`escapeAttr` on `service` and `tool`** — defends against attribute injection if either string is ever attacker-influenced. Don't pass in unescaped user input as `service`.
2. **Body is JSON-stringified** — the LLM is instructed to treat the inner content as JSON data. A bare string body would let an attacker drift the boundary.
3. **Literal `</tool_output>` in the body is escaped to `<\/tool_output>`** — without this, any tool that ever returned the literal close tag could terminate the envelope and re-enter "instruction mode".

If you change any of these, the I11 enforcement test must be updated in the **same commit**, and the design rationale belongs in [`docs/SECURITY-INVARIANTS.md`](../../docs/SECURITY-INVARIANTS.md) under I11.

## What "LLM-facing" Means

A surface is LLM-facing if the result string ends up in a model context window — typically as the response to a tool call the model just emitted. Concretely:

- ✅ **LLM-facing — wrap:** Mastra `Agent.tools.<name>` handlers; sub-agent worker `runSubAgent` results that are returned to the coordinator as tool output; any new MCP-tool registration that is bridged into Mastra's tool registry; agent surfaces like `runAsk`, `runConversationalAgent` when they synthesize tool output back to the model.
- ❌ **Not LLM-facing — do not wrap:** the planner's `ConnectorDispatcher → ToolExecutor` path (HITL is the defense there); IPC-direct results returned to a CLI/UI client (`engine.askStream` token notifications carry already-composed text); audit log payloads (use `redactPayloadForConsentDisplay` instead); tool results consumed by other Gateway code that does not feed an LLM.

If you are unsure, the test is "would a user-controlled byte sequence in this result *change the model's behavior*?". If yes, wrap.

## Adding a New LLM-facing Tool — Checklist

When registering a new agent tool or extending a sub-agent worker:

- [ ] Tool handler returns its raw object/string result; **the wrapping happens in the agent surface, not the handler**. Do not double-wrap.
- [ ] The agent surface that exposes this tool to the LLM calls `wrapToolOutput({ service, tool }, raw)` immediately before returning to the model — same shape as `engine/agent.ts:38`.
- [ ] `service` and `tool` are well-known identifiers (matching connector ids and MCP tool ids), not free-form strings derived from user input.
- [ ] If the result type is `Promise<string>` already (rare — you are bypassing JSON), audit whether you are losing the body-escape protection. The default path (`Promise<unknown>` → `wrapToolOutput`) is preferred.
- [ ] An enforcement assertion exists in [`packages/gateway/src/security-invariants.test.ts`](../../packages/gateway/src/security-invariants.test.ts) for the new wiring site (typically a grep against the source file).
- [ ] [`docs/SECURITY-INVARIANTS.md`](../../docs/SECURITY-INVARIANTS.md) §I11 names the new wiring site (file:line).

## Anti-Patterns

| Anti-pattern | Why it's bad | What to do instead |
|---|---|---|
| Building a new agent surface that calls a tool and feeds the raw result to the LLM | This is the exact gap S8-F3 / chain C4 documented; the prompt-injection defense becomes "the model probably won't follow attacker instructions" | Always go through `wrapToolOutput` at the LLM-facing boundary |
| Adding the wrap call inside the tool handler ("wrap once, both paths benefit") | Two harms: the planner path also routes through this handler and now sees an envelope-wrapped string instead of a structured result, breaking HITL preview rendering and `redactPayloadForConsentDisplay`; and on the LLM-facing path the outer `wrapToolForLlm` then JSON-stringifies an already-wrapped string, so the inner `<tool_output>` tag appears verbatim inside the outer body and the LLM's structural boundary is destroyed | Wrap at the agent surface (`wrapToolForLlm`), not in the tool handler |
| Using a different envelope shape ("`<<TOOL_RESULT>>…<<END>>`") because the existing one is "verbose" | Token cost is negligible; consistency is the defense — every model fine-tune that handles `<tool_output>` correctly is now wrong on your variant | Use the existing `wrapToolOutput`. If you genuinely need a new shape, change `tool-output-envelope.ts` and update the enforcement test |
| Letting `service` or `tool` be derived from extension-controlled strings without `escapeAttr` | Attribute injection — an extension can break the envelope by including `"` in its declared service id | Read connector id from the registry, not from inbound payloads |
| Storing the *unwrapped* result in `audit_log` and reconstructing the envelope at view time | Audit and LLM contexts have different requirements; mixing them creates a second class of bug | Audit stores its own redacted view; the envelope is applied separately at the LLM boundary |

## How to Comply (Short Form)

1. Find the LLM-facing site in your new code.
2. Call `wrapToolOutput({ service, tool }, raw)` there.
3. Add a wiring grep to `security-invariants.test.ts`.
4. Update [`docs/SECURITY-INVARIANTS.md`](../../docs/SECURITY-INVARIANTS.md) §I11 with the new file:line.
5. All four happen in the **same commit**.

## See Also

- [`docs/SECURITY-INVARIANTS.md`](../../docs/SECURITY-INVARIANTS.md) — full I-numbered list with anti-patterns
- [`docs/SECURITY.md`](../../docs/SECURITY.md) §"Prompt Injection" — the hard structural barrier (HITL gate) vs the soft barrier (envelope) split
- [`docs/architecture.md`](../../docs/architecture.md) §"Security Model" — threat-to-mitigation table
- `nimbus-security-invariants` skill — the invariant triple rule (production wiring + docs entry + enforcement test) that every invariant (I1–I30; I28 reserved) follows
