# Review of 2026-08-29-embedding-egress-and-task-routing.md

Review completed on: **2026-08-29**

## 1. Critical Gap: DB-Persisted Defaults are Never Loaded at Boot

### Problem

The plan specifies that `nimbus llm use` will write pins (default models per task) to the database using `LlmRegistry.setDefault(...)`. However, during Gateway boot in `buildLlmRegistryFromToml` (`packages/gateway/src/platform/assemble.ts`), the `LlmRouter` is constructed using only the `taskPins` parsed from `nimbus.toml` (`llmToml.taskPins`).

Since `LlmRouter` does not have access to the database or the `LlmRegistry` directly, **the database-persisted task defaults in `llm_task_defaults` are never read or applied to routing decisions at startup.**

### Suggestion

Modify `buildLlmRegistryFromToml` in [assemble.ts](../../../packages/gateway/src/platform/assemble.ts) to query the database `llm_task_defaults` table at startup, reconstruct the route IDs, and merge them with the TOML-configured `taskPins`.

```ts
// Proposed loading logic in buildLlmRegistryFromToml:
const dbPins = new Map<LlmTaskType, string>();
const rows = db.query("SELECT task_type, provider, model_name FROM llm_task_defaults").all() as Array<{
  task_type: string;
  provider: string;
  model_name: string;
}>;
for (const row of rows) {
  dbPins.set(row.task_type as LlmTaskType, makeRouteId(row.provider, row.model_name));
}

// Merge them (e.g., TOML pins override DB pins, or vice versa)
const taskPins = new Map([...dbPins, ...(llmToml.taskPins ?? [])]);
```

### Open Question

**Which has precedence?** If a task has a pin configured in `nimbus.toml` *and* a default set in the database via `nimbus llm use`, which one should take precedence?

* **Option A (Recommended):** TOML overrides DB. Local configuration files are typically treated as the developer/system administrator source of truth.
* **Option B:** DB overrides TOML. Since `nimbus llm use` is an interactive CLI command, the last command run by the user should win.

---

## 2. Bug in Existing `LlmRegistry.getDefault()` Implementation

### Problem

In [registry.ts](../../../packages/gateway/src/llm/registry.ts), `getDefault` is implemented as:

```ts
getDefault(taskType: string): { provider: string; modelName: string } | undefined {
  const row = this.db
    .query("SELECT provider, model_name FROM llm_task_defaults WHERE task_type = ?")
    .get(taskType) as { provider: string; model_name: string } | undefined;
  return row === undefined ? undefined : { provider: row.provider, modelName: row.model_name };
}
```

In `bun:sqlite`, when a query returns no matching row, `.get()` returns `null` (not `undefined`). Because `null !== undefined`, the ternary check evaluates to the truthy branch and tries to access `row.provider`, throwing a `TypeError: Cannot read properties of null (reading 'provider')` error.

The test in `registry.test.ts` asserts this throwing behavior, but this makes the function unsafe to use as a fallback check.

### Suggestion

Fix the null check in `LlmRegistry.getDefault` and update the test to expect `undefined` instead of throwing.

```ts
// Fix in registry.ts:
return (row === null || row === undefined) ? undefined : { provider: row.provider, modelName: row.model_name };
```

---

## 3. Improvements for Part A (Embedding Egress)

### Construction Site Verification

In **Task 3 / Step 4**, the plan says:
> "Wrap at the three sites... Each needs a `Database` in scope; if one is not available, thread it from the caller rather than making the parameter optional"

* **`tryCreateRoutingEmbeddingRuntime`** already has a `Database` in scope.
* **`createEmbeddingRuntime`** already has a `Database` in scope and passes it to `tryCreateOpenAIEmbeddingRuntime`.
* **`resolveEmbedder`** in `index-reembed-rpc.ts` has `ctx.db` in scope.

This verification confirms that the database is readily available at all three proposed wrapping sites, so threading is not required.
