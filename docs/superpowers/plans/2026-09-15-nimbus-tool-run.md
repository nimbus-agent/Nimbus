# `nimbus tool run` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner run a saved generated tool — `nimbus tool run <tool-id>` — closing the disclosed S2 gap that no path invokes a generated tool at all.

**Architecture:** A new gate module (`toolgen-invoke-gate.ts`) owns capability checks, input validation, signature-verified spawn, per-tool serialisation and the audit row, following the `toolgen-gate.ts` / `toolgen-save-gate.ts` precedent. `ipc/toolgen-rpc.ts` gains one `HANDLERS` entry; `commands/tool.ts` gains one subcommand branch. The model remains unable to call generated tools.

**Tech Stack:** Bun 1.2+, TypeScript strict with `exactOptionalPropertyTypes`, `bun:test`, Biome, JSON-RPC 2.0 over a unix socket / named pipe.

**Spec:** [`docs/superpowers/specs/2026-09-15-nimbus-tool-run-design.md`](../specs/2026-09-15-nimbus-tool-run-design.md) — read it first; this plan cites its section numbers.

## Global Constraints

- **No `any`.** `unknown` for external data. TypeScript strict; this package runs `exactOptionalPropertyTypes`, so an optional field is omitted via conditional spread, never assigned `undefined`.
- **No schema migration, no new invariant, no new egress class, no new HITL action type, no new Tauri allowlist entry.** If a task seems to need one, stop and re-read the spec.
- **`deps.toolgen` stays unsupplied in `gateway-main.ts`.** The model must not become able to call a generated tool. Do not touch that wiring.
- **Saved tools only.** A live, create-time-approved tool is not invocable (spec §3.5).
- **Cross-platform paths:** `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Prefer dependency injection over `mock.module`** — it is process-global and leaks across the combined CLI test run on CI Linux.
- **Run `bun run typecheck` as well as `bun test`.** They are separate gates; a prior plan in this repo shipped a red typecheck because only the tests were run.
- Existing error codes reused, not renamed: `ERR_TOOLGEN_SIGNATURE_INVALID` already exists.
- Capability refusal is **fail-closed on an absent policy accessor** — `isToolgenCapabilityEnabled` returns `false` when `enforced === undefined`.

---

### Task 1: The invoke gate — capability, validation, refusal outcomes

Spec §4, §4.5, §3.3. No spawning yet: this task establishes the gate, its outcome union, and every path that refuses *before* a process is created.

**Files:**
- Create: `packages/gateway/src/toolgen/toolgen-invoke-gate.ts`
- Modify: `packages/gateway/src/toolgen/toolgen-types.ts` (error codes)
- Test: `packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts`

**Interfaces:**
- Consumes: `isToolgenCapabilityEnabled({config, enforced})` from `toolgen-capability.ts`; `ToolgenRegistry.savedTools(): SavedToolEnvelope[]` (`registry.ts:112`) — NOT `findArtifact`, which reads ephemeral entries first; `ToolInputSchema` (`{type:"object"; properties; required?: readonly string[]}`) from `toolgen-types.ts`.
- Produces: `invokeSavedTool(req, deps): Promise<ToolgenInvokeOutcome>`, `ToolgenInvokeDeps`, `ToolgenInvokeOutcome`, and seven `ERR_TOOLGEN_*` constants.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { invokeSavedTool, type ToolgenInvokeDeps } from "./toolgen-invoke-gate.ts";

const ARTIFACT = {
  toolId: "t1",
  inputSchema: { type: "object" as const, properties: { q: { type: "string" as const } }, required: ["q"] },
  approvedHosts: ["api.example.com"],
};

function deps(over: Partial<ToolgenInvokeDeps> = {}): ToolgenInvokeDeps {
  return {
    config: { enabled: true },
    enforced: { capabilitiesDisabled: new Set<string>() },
    registry: { savedTools: () => [{ toolId: "t1", artifact: ARTIFACT }] } as unknown as ToolgenInvokeDeps["registry"],
    spawn: async () => {
      throw new Error("spawn must not be reached in this test");
    },
    audit: () => {},
    now: () => 1_000,
    ...over,
  } as ToolgenInvokeDeps;
}

describe("invokeSavedTool refusals happen before any spawn", () => {
  test("capability disabled by config", async () => {
    const out = await invokeSavedTool({ toolId: "t1", input: { q: "x" } }, deps({ config: { enabled: false } }));
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INVOKE_DISABLED");
  });

  test("capability disabled by org policy", async () => {
    const out = await invokeSavedTool(
      { toolId: "t1", input: { q: "x" } },
      deps({ enforced: { capabilitiesDisabled: new Set(["tool_generation"]) } }),
    );
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INVOKE_POLICY_DISABLED");
  });

  test("FAIL-CLOSED when the policy accessor is absent", async () => {
    // `isToolgenCapabilityEnabled` returns false on `enforced === undefined`: "cannot tell"
    // must never resolve to "allowed" for a standing, unattended execution capability.
    const d = deps();
    const out = await invokeSavedTool({ toolId: "t1", input: { q: "x" } }, { ...d, enforced: undefined });
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INVOKE_POLICY_DISABLED");
  });

  test("unknown tool id", async () => {
    const out = await invokeSavedTool({ toolId: "nope" }, deps({
      registry: { savedTools: () => [] } as unknown as ToolgenInvokeDeps["registry"],
    }));
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_NOT_SAVED");
  });

  test("an EPHEMERAL (created-but-unsaved) tool is refused, not run", async () => {
    // The trap this guards: `registry.findArtifact(id)` reads the ephemeral collection FIRST, so
    // using it here would let a `nimbus tool create` tool through the saved-only gate and fail
    // obscurely inside spawnSavedTool instead. The saved list is empty; an ephemeral entry exists.
    const out = await invokeSavedTool({ toolId: "ephemeral-1" }, deps({
      registry: {
        savedTools: () => [],
        findArtifact: () => ARTIFACT, // present ephemerally — must NOT satisfy the check
      } as unknown as ToolgenInvokeDeps["registry"],
      spawn: async () => {
        throw new Error("must not spawn an unsaved tool");
      },
    }));
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_NOT_SAVED");
  });

  test("input that is not an object is refused", async () => {
    const out = await invokeSavedTool(
      { toolId: "t1", input: [] as unknown as Record<string, unknown> },
      deps(),
    );
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INPUT_INVALID");
  });

  test("a missing REQUIRED key is refused without spawning", async () => {
    // `deps().spawn` throws if reached — so this assertion also proves no process was created.
    const out = await invokeSavedTool({ toolId: "t1", input: {} }, deps());
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INPUT_INVALID");
  });

  test("omitted input defaults to an empty object and still fails the required check", async () => {
    const out = await invokeSavedTool({ toolId: "t1" }, deps());
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INPUT_INVALID");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts`
Expected: FAIL — `Cannot find module './toolgen-invoke-gate.ts'`.

- [ ] **Step 3: Add the error codes**

In `packages/gateway/src/toolgen/toolgen-types.ts`, beside the existing `ERR_TOOLGEN_*` constants:

```ts
export const ERR_TOOLGEN_INVOKE_DISABLED = "ERR_TOOLGEN_INVOKE_DISABLED";
export const ERR_TOOLGEN_INVOKE_POLICY_DISABLED = "ERR_TOOLGEN_INVOKE_POLICY_DISABLED";
export const ERR_TOOLGEN_NOT_SAVED = "ERR_TOOLGEN_NOT_SAVED";
export const ERR_TOOLGEN_PUBKEY_UNAVAILABLE = "ERR_TOOLGEN_PUBKEY_UNAVAILABLE";
export const ERR_TOOLGEN_INPUT_INVALID = "ERR_TOOLGEN_INPUT_INVALID";
export const ERR_TOOLGEN_EXECUTION_FAILED = "ERR_TOOLGEN_EXECUTION_FAILED";
export const ERR_TOOLGEN_EXECUTION_TIMEOUT = "ERR_TOOLGEN_EXECUTION_TIMEOUT";
```

- [ ] **Step 4: Write the gate's refusal half**

Create `packages/gateway/src/toolgen/toolgen-invoke-gate.ts`. Note `isToolgenCapabilityEnabled`
collapses config-off and policy-off into one boolean, so check `config.enabled` first to keep the
two codes distinguishable — a user who turned the feature off locally should not be told their org
policy forbids it.

```ts
export type ToolgenInvokeOutcome =
  | { readonly status: "executed"; readonly toolId: string; readonly result: unknown; readonly durationMs: number }
  | { readonly status: "failed"; readonly toolId: string; readonly error: string; readonly durationMs: number }
  | { readonly status: "refused"; readonly toolId: string; readonly code: string; readonly reason?: string };

export async function invokeSavedTool(
  req: { readonly toolId: string; readonly input?: Record<string, unknown>; readonly sessionId?: string },
  deps: ToolgenInvokeDeps,
): Promise<ToolgenInvokeOutcome> {
  const { toolId } = req;
  if (!deps.config.enabled) return refuse(deps, toolId, ERR_TOOLGEN_INVOKE_DISABLED);
  if (!isToolgenCapabilityEnabled({ config: deps.config, enforced: deps.enforced })) {
    return refuse(deps, toolId, ERR_TOOLGEN_INVOKE_POLICY_DISABLED);
  }
  // `savedTools()`, NOT `findArtifact()`. `findArtifact` reads the EPHEMERAL collection first
  // (`registry.ts:78`: `#byId.get(id)?.envelope.artifact ?? #saved.get(id)?.artifact`), so a
  // created-but-unsaved tool would pass this check and then fail obscurely inside
  // `spawnSavedTool` — defeating spec §3.5's saved-only bound at the very line meant to enforce it.
  const saved = deps.registry.savedTools().find((s) => s.toolId === toolId);
  if (saved === undefined) return refuse(deps, toolId, ERR_TOOLGEN_NOT_SAVED);
  const artifact = saved.artifact;

  const input = req.input ?? {};
  const bad = validateInput(input, artifact.inputSchema);
  if (bad !== undefined) return refuse(deps, toolId, ERR_TOOLGEN_INPUT_INVALID, bad);
  // Spawn + call land in Task 2.
  throw new Error("not implemented");
}

/** Presence-only: shape plus `required` keys. NOT schema conformance — spec §3.3. */
function validateInput(input: unknown, schema: ToolInputSchema): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "input must be a JSON object";
  }
  const seen = input as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in seen)) return `missing required input "${key}"`;
  }
  return undefined;
}
```

`refuse()` builds the outcome and writes the audit row; Task 3 fills in the audit side, so for now
have it call `deps.audit(...)` with the outcome fields.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts && bun run typecheck`
Expected: 7 pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/toolgen/toolgen-invoke-gate.ts packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts packages/gateway/src/toolgen/toolgen-types.ts
git commit -m "feat(toolgen): add the invoke gate's capability and input refusals"
```

---

### Task 2: Spawn, call, serialise per tool id

Spec §4.1, §4.2, §4.3. This task makes the gate actually run a tool.

**Files:**
- Modify: `packages/gateway/src/toolgen/toolgen-invoke-gate.ts`
- Test: `packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts` (extend)

**Interfaces:**
- Consumes: `spawnSavedTool(toolId, deps: SavedSpawnDeps): Promise<GeneratedToolHandle>`; `GeneratedToolHandle` = `{ describe(); call(args: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }` (`toolgen-client.ts:62-66`).
- Consumes: `ToolgenError` (carries `.code`) — `spawnSavedTool` throws it on a failed signature check (`toolgen-saved-spawn.ts:206`).
- Produces: the `executed` / `failed` arms of `ToolgenInvokeOutcome`, plus a `refused` arm for a `ToolgenError` raised during spawn.

- [ ] **Step 1: Write the failing tests**

Append to `toolgen-invoke-gate.test.ts`:

```ts
describe("invokeSavedTool execution", () => {
  test("a successful call returns the result", async () => {
    const out = await invokeSavedTool({ toolId: "t1", input: { q: "x" } }, deps({
      spawn: async () => ({ call: async () => ({ ok: 1 }), close: async () => {}, describe: async () => ({ name: "", description: "", inputSchema: {} }) }),
    }));
    expect(out.status).toBe("executed");
    expect(out.status === "executed" && out.result).toEqual({ ok: 1 });
  });

  test("a throwing tool body is `failed`, not `refused`", async () => {
    // The distinction is the point: "the gateway would not run it" and "it ran and broke" are
    // different facts and a script acts differently on each (spec §3.1).
    const out = await invokeSavedTool({ toolId: "t1", input: { q: "x" } }, deps({
      spawn: async () => ({ call: async () => { throw new Error("boom"); }, close: async () => {}, describe: async () => ({ name: "", description: "", inputSchema: {} }) }),
    }));
    expect(out.status).toBe("failed");
    expect(out.status === "failed" && out.error).toContain("boom");
  });

  test("the handle is closed even when the call throws", async () => {
    let closed = 0;
    await invokeSavedTool({ toolId: "t1", input: { q: "x" } }, deps({
      spawn: async () => ({ call: async () => { throw new Error("boom"); }, close: async () => { closed += 1; }, describe: async () => ({ name: "", description: "", inputSchema: {} }) }),
    }));
    expect(closed).toBe(1);
  });

  test("concurrent invocations of the SAME tool id are serialised", async () => {
    // Guards spec §4.2: spawnSavedTool re-emits saved/<id>/index.ts on every spawn, so two
    // overlapping spawns write the same path and transiently EBUSY on Windows.
    let active = 0;
    let maxActive = 0;
    const d = deps({
      spawn: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        return { call: async () => { active -= 1; return "ok"; }, close: async () => {}, describe: async () => ({ name: "", description: "", inputSchema: {} }) };
      },
    });
    await Promise.all([
      invokeSavedTool({ toolId: "t1", input: { q: "a" } }, d),
      invokeSavedTool({ toolId: "t1", input: { q: "b" } }, d),
    ]);
    expect(maxActive).toBe(1);
  });

  test("different tool ids are NOT serialised against each other", async () => {
    let active = 0;
    let maxActive = 0;
    const registry = { findArtifact: (id: string) => ({ ...ARTIFACT, toolId: id }) };
    const d = deps({
      registry: registry as unknown as ToolgenInvokeDeps["registry"],
      spawn: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        return { call: async () => { active -= 1; return "ok"; }, close: async () => {}, describe: async () => ({ name: "", description: "", inputSchema: {} }) };
      },
    });
    await Promise.all([
      invokeSavedTool({ toolId: "t1", input: { q: "a" } }, d),
      invokeSavedTool({ toolId: "t2", input: { q: "b" } }, d),
    ]);
    expect(maxActive).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts`
Expected: FAIL — `not implemented`.

- [ ] **Step 3: Implement spawn, call and per-tool serialisation**

Replace the `throw new Error("not implemented")` with the run half. The serialisation is an
in-process promise chain keyed by tool id — the same shape I35 uses for concurrent `computer.act`
on one lane:

```ts
const chains = new Map<string, Promise<unknown>>();

function serialise<T>(toolId: string, run: () => Promise<T>): Promise<T> {
  const prev = chains.get(toolId) ?? Promise.resolve();
  const next = prev.then(run, run);
  // Keep the chain from growing unbounded, and drop the entry once it is the tail.
  chains.set(toolId, next.catch(() => undefined));
  void next.catch(() => undefined).finally(() => {
    if (chains.get(toolId) === undefined) chains.delete(toolId);
  });
  return next;
}
```

Then, inside `invokeSavedTool` after validation:

```ts
return await serialise(toolId, async () => {
  const startedAt = deps.now();
  let handle: GeneratedToolHandle | undefined;
  try {
    handle = await deps.spawn(toolId);
    const result = await handle.call(input);
    return succeed(deps, toolId, result, deps.now() - startedAt);
  } catch (e) {
    // A ToolgenError from spawnSavedTool is a pre-execution REFUSAL, not a tool failure. The
    // signature-invalid path (`toolgen-saved-spawn.ts:206`) is the one that matters: reporting a
    // tampered artifact as `failed` would give exit 1 and an audit `outcome: "failed"`, making an
    // I40 refusal read as a bug in the tool.
    if (e instanceof ToolgenError) {
      return refuse(deps, toolId, e.code, e.message);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return fail(deps, toolId, msg, deps.now() - startedAt);
  } finally {
    // Close must not mask the outcome: a close failure is not the caller's problem.
    try { await handle?.close(); } catch { /* best-effort */ }
  }
});
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/toolgen/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify the serialisation test can actually fail**

Temporarily replace `serialise(toolId, run)` with `run()`. Re-run the concurrency test: it MUST
fail with `maxActive` of 2. Revert, confirm `git diff` on the file is empty, re-run green.

Record the observed failure output in your report. A concurrency test that passes with the
mechanism removed is not a test.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/toolgen/toolgen-invoke-gate.ts packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts
git commit -m "feat(toolgen): spawn, call and serialise invocations per tool id"
```

---

### Task 3: The audit row

Spec §5. Exactly one row per invocation, carrying neither input nor output.

**Files:**
- Modify: `packages/gateway/src/toolgen/toolgen-invoke-gate.ts`
- Test: `packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts` (extend)

**Interfaces:**
- Consumes: `appendAuditEntry(db, {actionType, hitlStatus, actionJson, timestamp})` from `db/audit-chain.ts:56`.
- Produces: one `audit_log` row per invocation with `actionType: "tool.invoke"`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("invokeSavedTool audit", () => {
  test("exactly one row per outcome, and neither input nor output appears in it", async () => {
    const rows: Array<{ actionType: string; hitlStatus: string; actionJson: string }> = [];
    const d = deps({
      audit: (row) => { rows.push(row); },
      spawn: async () => ({ call: async () => "SECRET-OUTPUT", close: async () => {}, describe: async () => ({ name: "", description: "", inputSchema: {} }) }),
    });
    await invokeSavedTool({ toolId: "t1", input: { q: "SECRET-INPUT" } }, d);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionType).toBe("tool.invoke");
    expect(rows[0]?.hitlStatus).toBe("not_required");
    // Spec §5: the audit trail must not become a second copy of the user's data.
    expect(rows[0]?.actionJson).not.toContain("SECRET-INPUT");
    expect(rows[0]?.actionJson).not.toContain("SECRET-OUTPUT");
  });

  test("a refusal writes exactly one row too", async () => {
    const rows: unknown[] = [];
    await invokeSavedTool({ toolId: "t1", input: {} }, deps({ audit: (r) => { rows.push(r); } }));
    expect(rows).toHaveLength(1);
  });

  test("a failed execution writes exactly one row", async () => {
    const rows: unknown[] = [];
    await invokeSavedTool({ toolId: "t1", input: { q: "x" } }, deps({
      audit: (r) => { rows.push(r); },
      spawn: async () => ({ call: async () => { throw new Error("boom"); }, close: async () => {}, describe: async () => ({ name: "", description: "", inputSchema: {} }) }),
    }));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts`
Expected: FAIL — rows empty or the payload contains the input.

- [ ] **Step 3: Write the audit call**

One helper, called from `refuse` / `succeed` / `fail` so no arm can forget it:

```ts
function writeInvokeAudit(deps: ToolgenInvokeDeps, fields: {
  outcome: "executed" | "failed" | "refused";
  toolId: string;
  durationMs?: number;
  code?: string;
  error?: string;
}): void {
  deps.audit({
    actionType: "tool.invoke",
    // I39's `recordToolEgress` precedent: the tool's REGISTRATION was approved, not each request.
    hitlStatus: "not_required",
    actionJson: JSON.stringify(fields),
    timestamp: deps.now(),
  });
}
```

`fields` deliberately has no `input` or `result` member — the omission is structural, not a
discipline the caller has to remember.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/toolgen/ && bun run typecheck && bunx biome check packages/gateway/src/toolgen/`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/toolgen/toolgen-invoke-gate.ts packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts
git commit -m "feat(toolgen): write one tool.invoke audit row per invocation"
```

---

### Task 4: Wire the IPC method

Spec §3, §3.1, §4.3.

**Files:**
- Modify: `packages/gateway/src/ipc/toolgen-rpc.ts` (`HANDLERS` map ~:359, `ToolgenRpcCtx` ~:47)
- Modify: `packages/gateway/src/platform/assemble.ts` (build the invoke deps)
- Test: `packages/gateway/src/ipc/toolgen-rpc.test.ts`, `packages/gateway/src/security-invariants.test.ts`

**Interfaces:**
- Consumes: `invokeSavedTool` from Task 1–3; `dispatchByMethod(method, params, ctx, HANDLERS)`.
- Produces: IPC method `toolgen.invoke`.

**Note the routing:** `dispatchers.ts:1242` routes with `method.startsWith("toolgen.")`, so adding
the `HANDLERS` entry **is** the routing — there is no separate outer dispatcher entry to add. This
differs from `diagnostics-rpc`, which enumerates methods.

- [ ] **Step 1: Write the failing tests**

In `toolgen-rpc.test.ts`:

```ts
test("toolgen.invoke resolves through the HANDLERS map", async () => {
  const out = await dispatchToolgenRpc("toolgen.invoke", { toolId: "t1", input: { q: "x" } }, ctxWithFakeInvoke());
  expect(out).toMatchObject({ status: "executed" });
});

test("toolgen.invoke requires a string toolId", async () => {
  await expect(dispatchToolgenRpc("toolgen.invoke", { toolId: 42 }, ctxWithFakeInvoke())).rejects.toThrow();
});
```

In `security-invariants.test.ts`, inside the existing I5 describe block:

```ts
test("FORBIDDEN_OVER_LAN covers toolgen.invoke via the namespace entry", async () => {
  const { checkLanMethodAllowed } = await import("./ipc/lan-rpc.ts");
  const peer = { peerId: "peer:x", writeAllowed: true };
  // The namespace entry already exists; this asserts it REACHES a method added later,
  // by calling the function rather than grepping the source for "toolgen".
  expect(() => checkLanMethodAllowed("toolgen.invoke", peer)).toThrow(/ERR_METHOD_NOT_ALLOWED/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/ipc/toolgen-rpc.test.ts`
Expected: FAIL — the method misses.

(The LAN test may already pass, since the namespace entry predates this work. That is the correct
result and worth stating in your report — it proves the namespace forbid genuinely covers new
methods rather than needing one entry per method.)

- [ ] **Step 3: Add the handler**

In `toolgen-rpc.ts`'s `HANDLERS` map, following the `toolgen.create` shape — everything crossing
the boundary is `unknown` until validated, no casts on `params`:

```ts
"toolgen.invoke": async (params, ctx) => {
  const rec = asRecord(params) ?? {};
  const toolId = requireString(params, "toolId");
  // Same guard `toolgen.revoke` and `toolgen.credentialSet` already apply (`toolgen-rpc.ts:430`,
  // `:511`): it refuses the reserved id `signing`, whose Vault prefix IS the signing keypair's,
  // and rejects path-traversal shapes. A caller-supplied tool id must never skip it.
  assertCallerToolId(toolId);
  const rawInput = rec["input"];
  const input = rawInput === undefined ? {} : (asRecord(rawInput) ?? undefined);
  if (input === undefined) {
    throw new ToolgenRpcError(-32602, "input must be a JSON object");
  }
  return invokeSavedTool({ toolId, input }, ctx.invokeDeps);
},
```

Add `readonly invokeDeps: ToolgenInvokeDeps;` to `ToolgenRpcCtx`, then build it in
`platform/assemble.ts` beside the existing toolgen wiring. Every identifier below was verified to
exist before this plan was written:

```ts
// `CLI_TOOLGEN_SESSION_ID` does NOT exist yet — DEFINE it in toolgen-types.ts as part of this task.
// `SavedSpawnDeps.sessionId` is documented as "the SPAWNING CALLER's session — never a 'saved'
// sentinel", and a CLI invocation has no real session, so it needs a named constant of its own.
export const CLI_TOOLGEN_SESSION_ID = "cli";

const toolgenInvokeDeps: ToolgenInvokeDeps = {
  config: toolGenerationCfg,
  // A GETTER, not a snapshot: org policy is re-resolved per call, so a policy tightened after
  // boot takes effect on the next invocation rather than at the next restart.
  get enforced() {
    return policyGate.enforced();
  },
  registry: toolgenRegistry,
  spawn: async (toolId) => {
    const pubkeyB64 = await vault.get(TOOLGEN_SIGNING_PUBKEY);      // toolgen-keypair.ts
    if (pubkeyB64 === null) {
      throw new ToolgenError(ERR_TOOLGEN_PUBKEY_UNAVAILABLE, "toolgen signing pubkey unavailable");
    }
    const row = getSavedTool(db, toolId);                           // toolgen-saved-repo.ts:172
    if (row === null) {
      throw new ToolgenError(ERR_TOOLGEN_NOT_SAVED, `tool "${toolId}" is not saved`);
    }
    return spawnSavedTool(toolId, {
      configDir: paths.configDir,
      pubkeyB64,
      sessionId: CLI_TOOLGEN_SESSION_ID,
      row: { approvedAt: row.approvedAt },
      runtime: { requiredReadPaths: () => runtimeReadPaths },
      readVerifiedSavedTool,
      savedToolDir,                                                 // toolgen-saved-store.ts
      rewriteSavedToolScript,                                       // toolgen-saved-store.ts
      spawn: (envelope) => spawnGeneratedTool(envelope, toolgenBroker, dirname(envelope.scriptPath)),
    });
  },
  audit: (entry) => appendAuditEntry(db, entry),                    // db/audit-chain.ts:56
  now: () => Date.now(),
};
```

**Read `SavedSpawnDeps`'s own docstrings before filling `sessionId` and `row.approvedAt`** — both
carry explicit warnings. `approvedAt` must come from the `generated_tool` ROW, never `now()` and
never the artifact (which does not carry it); a `?? now()` fallback would stamp every spawn with
the current time and destroy the record of when the tool was approved.

- [ ] **Step 4: Satisfy spec §4.3 — the registry must hold the verified artifact**

`assemble.ts:3941` resolves broker hosts as `toolgenRegistry.findArtifact(toolId)?.approvedHosts ?? []`.
That `?? []` means a tool whose artifact is missing from the registry runs with NO approved hosts
and every brokered fetch is refused, presenting as the remote host's fault.

The gate already refuses with `ERR_TOOLGEN_NOT_SAVED` when `findArtifact` misses (Task 1), which
closes this by construction: the same lookup that would have yielded an empty host list now refuses
the run outright. Add a test asserting that a registry miss refuses rather than proceeding:

```ts
test("a registry miss refuses loudly rather than running with no approved hosts", async () => {
  const out = await invokeSavedTool({ toolId: "gone" }, deps({
    registry: { findArtifact: () => undefined } as unknown as ToolgenInvokeDeps["registry"],
    spawn: async () => { throw new Error("must not spawn"); },
  }));
  expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_NOT_SAVED");
});
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/ipc/ packages/gateway/src/toolgen/ packages/gateway/src/security-invariants.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Assert the Tauri allowlist is unchanged**

Confirm `ALLOWED_METHODS` in `packages/ui/src-tauri/src/gateway_bridge.rs` contains no `toolgen.`
entry and its count assertion is untouched:

```bash
grep -c "toolgen" packages/ui/src-tauri/src/gateway_bridge.rs   # expect 0 matches for a method entry
```

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/ipc/toolgen-rpc.ts packages/gateway/src/ipc/toolgen-rpc.test.ts packages/gateway/src/platform/assemble.ts packages/gateway/src/security-invariants.test.ts packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts
git commit -m "feat(ipc): serve toolgen.invoke, CLI-only and LAN-forbidden"
```

---

### Task 5: The CLI subcommand

Spec §3, §3.2, §3.4.

**Files:**
- Modify: `packages/cli/src/commands/tool.ts` (parse switch ~:264, run switch ~:976, `USAGE` ~:47)
- Modify: `packages/cli/src/commands/help.ts` (~:86-89)
- Test: `packages/cli/src/commands/tool.test.ts`

**Interfaces:**
- Consumes: the `toolgen.invoke` IPC method from Task 4; `TOOL_EXIT_CODES` (`tool.ts:13`, `denied: 126`, `refused: 127`).
- Produces: `nimbus tool run <id> [--input <json>] [--json]`.

**`run` is a SUBcommand.** `tool: runTool` is already in `COMMAND_HANDLERS` and `registry.ts`
enumerates only the top-level `"tool"` — neither needs touching. `help.ts` and `tool.ts`'s `USAGE`
both enumerate the subcommand list and must be updated together, or help advertises a surface the
code does not have.

- [ ] **Step 1: Write the failing tests**

```ts
test("parses run with input and json", () => {
  expect(parseToolArgs(["run", "t1", "--input", '{"q":"x"}', "--json"]))
    .toEqual({ sub: "run", toolId: "t1", input: { q: "x" }, json: true });
});

test("run without --input defaults to an empty object", () => {
  expect(parseToolArgs(["run", "t1"])).toMatchObject({ sub: "run", input: {} });
});

test("invalid --input JSON is a usage error and never reaches the gateway", () => {
  expect(() => parseToolArgs(["run", "t1", "--input", "{nope"])).toThrow(/must be valid JSON/);
});

test("--input that is not an object is a usage error", () => {
  expect(() => parseToolArgs(["run", "t1", "--input", "[1,2]"])).toThrow(/must be a JSON object/);
});

test("run with no tool id is a usage error", () => {
  expect(() => parseToolArgs(["run"])).toThrow(/Usage/);
});

test("exit code 0 on executed, 1 on failed, 127 on refused", async () => {
  expect(await runToolWithOutcome({ status: "executed", toolId: "t1", result: "ok", durationMs: 1 })).toBe(0);
  expect(await runToolWithOutcome({ status: "failed", toolId: "t1", error: "boom", durationMs: 1 })).toBe(1);
  expect(await runToolWithOutcome({ status: "refused", toolId: "t1", code: "ERR_TOOLGEN_NOT_SAVED" })).toBe(TOOL_EXIT_CODES.refused);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/src/commands/tool.test.ts`
Expected: FAIL — `Unknown "nimbus tool" subcommand: "run"`.

- [ ] **Step 3: Add the parse branch**

In the `switch (sub)` at ~:264, beside `case "save"`:

```ts
case "run":
  return parseRunArgs(rest);
```

`parseRunArgs` takes the tool id positionally, parses `--input` with `JSON.parse` inside a
try/catch that rethrows as a usage error naming the problem, rejects a non-object or array result,
defaults to `{}` when the flag is absent, and reads `--json`.

- [ ] **Step 4: Add the run branch and rendering**

In the `switch` at ~:976, beside `case "save"`:

```ts
case "run":
  await runRunCmd(parsed, deps);
  return;
```

`runRunCmd` calls `toolgen.invoke`, then renders by outcome:
- `executed` + `--json`: `JSON.stringify(result, null, 2)`.
- `executed` without `--json`: a string result prints as-is; an object pretty-prints; `undefined`
  or `null` prints `(no output)`.
- `failed`: the error to stderr with the `nimbus:` prefix, exit `1`.
- `refused`: the code and reason to stderr, exit `TOOL_EXIT_CODES.refused`.

Do NOT add an `isInteractiveTty()` guard. Spec §3.2: `run` obtains no consent, so it is
headless-capable by design, and that is the operational meaning of the standing approval.

- [ ] **Step 5: Update both places that document the subcommand list**

`tool.ts`'s `USAGE` (~:47) and `help.ts` (~:86-89). If only one is updated, help advertises a
surface that does not match the code — `help.test.ts` scans the live command surface.

- [ ] **Step 6: Run the tests**

Run: `bun test packages/cli/src/ && bun run typecheck && bunx biome check packages/cli/src/commands/tool.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/tool.ts packages/cli/src/commands/tool.test.ts packages/cli/src/commands/help.ts
git commit -m "feat(cli): add nimbus tool run"
```

---

### Task 6: Integration, E2E and docs

Spec §6, §8.

**Files:**
- Create: `packages/gateway/test/integration/toolgen/toolgen-run.test.ts`
- Create: `packages/gateway/test/e2e/tool-run.e2e.test.ts`
- Modify: `docs/cli-reference.md`, `docs/roadmap.md`, `docs/CHANGELOG.md`, `CLAUDE.md` + `GEMINI.md`

- [ ] **Step 1: Write the integration test**

Against a real signed artifact: save a tool, then invoke it, and assert the result plus exactly one
audit row. Then **tamper with the saved artifact on disk and assert the invocation refuses** — that
is I40's property and the one worth having.

- [ ] **Step 2: Write the E2E**

Use the existing fixture `join(import.meta.dir, "_fixtures", "gateway-runner.ts")` — it handles the
temp dir, Windows named pipes vs unix sockets, and cleanup. Place the file under
`packages/gateway/test/e2e/`, NOT `test/integration/`: only the E2E job wraps the Linux run in
D-Bus, and without it the Vault fails and the gateway never binds.

This E2E does **not** exist to catch a routing gap — `dispatchers.ts` prefix-matches `toolgen.`, so
that gap cannot occur. It earns its place by exercising CLI → IPC → gate → spawn together, which
nothing below it does.

- [ ] **Step 3: Update the docs**

`docs/cli-reference.md` gains the `nimbus tool run` entry, and must state: saved tools only, so
`create` alone is not runnable; headless-capable; input validation is presence-only, not schema
conformance; neither input nor output is recorded; and the model still cannot call a generated tool.

`docs/roadmap.md` records the gap as closed. `CLAUDE.md` and `GEMINI.md` mirror each other — update
both or the drift gate fires.

- [ ] **Step 4: Run the full gate set**

Run: `bun run preflight`
Expected: green. `lint:markdown` and `audit:doc-refs` will fail on `docs/superpowers/**` — those
are planning artifacts stripped before the PR and are NOT yours to fix. Report any other failure.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/test docs CLAUDE.md GEMINI.md
git commit -m "test(toolgen): integration + e2e for tool run; document the command"
```

---

## Self-review notes

**Spec coverage.** §3→T4,T5 · §3.1→T4 · §3.2→T5 · §3.3→T1 · §3.4→T5 · §3.5→T1 (registry lookup is
the saved-only check) · §4→T1,T2 · §4.1→T2 · §4.2→T2 · §4.3→T4 · §4.4→ no code (absence of a
prompt) · §4.5→T1 · §5→T3 · §6→T6 docs · §7→all · §8→T1–T6.

**Deliberately NOT implemented:** supplying `deps.toolgen` in `gateway-main.ts` (§2 — the model must
stay unable to call a generated tool), and full JSON Schema validation (§3.3).

**The two steps a reviewer should gate hardest:**

1. **Task 2 Step 5** — the serialisation mutation check. A concurrency test that passes with the
   mechanism removed is not a test, and this one guards a Windows-only failure that a green
   Linux/macOS run says nothing about.
2. **Task 3** — that the audit payload cannot carry input or output. The test asserts on sentinel
   strings rather than shape, so a future field that widens the payload trips it.
