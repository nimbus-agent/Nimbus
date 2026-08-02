# Review & Feedback: Agents as MCP Tools Design

This document contains a structured review, suggestions, improvements, and open questions regarding the design for exposing Nimbus agents as MCP tools, as specified in [2026-08-02-agents-as-mcp-tools-design.md](./2026-08-02-agents-as-mcp-tools-design.md).

---

## 1. Binary Discovery in the MIT NPX Launcher

### Issue: Path Resolution of the Nimbus Binary

The design specifies:
> A separate MIT package whose `bin` shells to `nimbus mcp-server --stdio`.

Since the CLI is AGPL and installed separately from the MIT launcher, `nimbus` might not always be present on the global `PATH`. This is especially common on Windows or when Nimbus is installed via local user-space managers or custom directory paths. A naive `exec("nimbus ...")` will fail with command-not-found, leading to a poor user experience for editor integrations using `npx`.

### Recommendation

The MIT launcher should implement a robust binary discovery sequence:

1. Check if `nimbus` is available directly on the `PATH`.
2. If not found, check platform-specific default installation paths (e.g., `%APPDATA%\nimbus\bin` or local Bun global bins on Windows, `~/.nimbus/bin` or `/usr/local/bin` on macOS/Linux).
3. If still not found, print a helpful, platform-specific error message pointing to the installation documentation (instead of a raw shell exit code).

---

## 2. Leak-Free Session Deregistration

### Issue: Listener Leakage on Hard Timeouts or Transport Drop

The design highlights that notification handlers are currently registered per call and never removed. It recommends:
> Deregister both handlers when the promise settles, by any path including timeout.

If a calling client abruptly terminates or the stdio transport breaks during an active async invocation:

- The promise might remain pending indefinitely or reject via transport death.
- Stale event listeners could accumulate on the main gateway session emitter.

### Recommendation

Use an explicit try-finally block or an `AbortController`/`AbortSignal` linked to both the transport lifecycle and the execution timeout:

```typescript
const abortController = new AbortController();
// Bind IPC socket close to abortController.abort()
// Ensure the listener deregistration callback is unconditionally invoked in the `finally` block of the promise.
```

---

## 3. Static Confinement Audit Updates (D22 / Invariant I29)

### Issue: Static Confinement Boundaries

The design states:
> This is a *second* append path. It must extend `D22`'s static confinement rather than be exempted from it...

The static code checker `scripts/structure-audit/check-nimbus-invariants.ts` strictly enforces that `connectors.dispatch` (or SQLite writes) are confined. Adding a second append path for MCP reads in the gateway requires modifying the static checker rules.

### Recommendation

Explicitly outline in the implementation details:

- Where the new append logic will reside in the gateway (e.g., `packages/gateway/src/egress/egress-ledger.ts` or `packages/gateway/src/ipc/handlers/agents.ts`).
- Update `check-nimbus-invariants.ts` to allow this specific file/function as a valid writer/ledger-appender, ensuring the static audit does not fail during CI preflight gates.

---

## 4. Agent Schema and Parameter Adaptation

### Issue: Human-Interactive Parameters

Some built-in agents might expect options that make sense only in interactive TUI/CLI contexts (e.g., interactive paging, terminal width, verbose output modes, or confirm-prompts).

### Q4.1: How are parameter defaults handled?

When mapping schemas to MCP tool parameters, do we strip or hide UI-specific parameters from the LLM-facing tool schemas, or do we expose them with defaults?

### Recommendation

Define a clean schema translation filter when wrapping IPC parameter Zod schemas to MCP tool schemas. Automatically omit formatting parameters (like `--color` or `--interactive`) to prevent the calling LLM from hallucinating values or trying to invoke interactive flags.

---

## 5. Tool Naming Consistency

### Issue: Mapping 11 Agents to Verb-Shaped Tool Names

The design notes:
> Names stay verb-shaped to match the existing six — `explainWhy`, `getCatchup`, `findExpert`, `assessImpact`, `findConflicts` — rather than mirroring internal agent names.

To avoid ambiguity during implementation, a complete map of internal agent names to their respective verb-shaped MCP tool names should be established.

### Recommendation

Verify and document the mapping of all 11 agents. For example:

- `why` -> `explainWhy`
- `catchup` -> `getCatchup`
- `expert` -> `findExpert`
- `impact` -> `assessImpact`
- `conflicts` -> `findConflicts`
- `status` -> `checkStatus` (or similar)
- ... (and so on for all 11 agents).
