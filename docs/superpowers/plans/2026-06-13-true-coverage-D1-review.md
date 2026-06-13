# Review: True Coverage D1 — Gateway I/O-shell un-excludes — Implementation Plan

**Date:** 2026-06-13  
**Reviewer:** AI Assistant (Antigravity)  
**Status:** Review Completed  
**Target Plan:** [`2026-06-13-true-coverage-D1.md`](./2026-06-13-true-coverage-D1.md)

---

## 1. Executive Summary

The D1 implementation plan is highly detailed, leveraging clean structural seams and TDD fakes to drive coverage above the 80% threshold without introducing real I/O operations. We have identified one critical reliability improvement regarding client resource cleanup in the event of spawner failures.

---

## 2. Detailed Feedback & Suggestions

### 2.1. Safe Client Disconnect on Spawner Failures (Task 2 Step 3)

- **Observation:** In the proposed `runSpawnedToolCall` function:

  ```typescript
  await spawner(ctx);
  try {
    for (const client of clients.values()) {
      ...
  } finally {
    for (const client of clients.values()) {
      await client.disconnect().catch(() => {});
    }
  }
  ```

  If `spawner(ctx)` throws an error midway through execution, some clients may have already been registered in the `clients` map via `setLazyClient`. Since `await spawner(ctx)` sits outside the `try` block, those registered clients will not be cleaned up, leading to resource leaks (orphaned sockets or processes).
- **Recommendation:** Wrap the `await spawner(ctx)` call inside the `try` block to guarantee cleanup of any partially-spawned clients:

  ```typescript
  export async function runSpawnedToolCall(
    spawner: Spawner,
    req: TeamToolSpawnRequest,
  ): Promise<unknown> {
    const clients = new Map<string, MCPClient>();
    const ctx: MeshSpawnContext = {
      vault: req.vaultView,
      sandboxCwd: req.sandboxCwd,
      clearLazyIdle: () => {},
      getLazyClient: (key) => clients.get(key),
      setLazyClient: (key, client) => {
        clients.set(key, client);
      },
      bumpToolsEpoch: () => {},
      scheduleLazyDisconnect: () => {},
    };

    try {
      await spawner(ctx);
      for (const client of clients.values()) {
        const tools = await listLazyMeshClientTools(client);
        const tool = tools[req.toolId];
        if (tool?.execute !== undefined) {
          return await tool.execute(req.args);
        }
      }
      throw new Error(`team-vault: tool "${req.toolId}" not found for service "${req.service}"`);
    } finally {
      for (const client of clients.values()) {
        await client.disconnect().catch(() => {});
      }
    }
  }
  ```

---

### 2.2. Bonjour Service Host Fallback Robustness (Task 1 Step 3)

- **Observation:** In the `MdnsDiscoveryProvider` `start()` callback:

  ```typescript
  const host = service.addresses?.[0] ?? service.host;
  ```

- **Validation:** This is highly robust. If `addresses` is undefined or empty, `addresses?.[0]` evaluates to `undefined`, and it correctly falls back to `service.host`. The subsequent check `typeof host === "string"` guards against missing or malformed values.

---

### 2.3. Correctness of Sonar Exclusion Truncation (Task 2 Step 5)

- **Observation:** The plan updates `sonar-project.properties` by removing `packages/gateway/src/teamvault/team-tool-spawn.ts`.
- **Validation:** Grep results confirm that `team-tool-spawn.ts` is indeed the last entry on line 74 of `sonar-project.properties`. Removing the leading comma and the path keeps the list formatted correctly with no trailing comma.

---

## 3. Conclusion

The D1 implementation plan is approved. Implementing the spawner-level `try`/`finally` block ensures that ephemeral clients are reliably disconnected, preserving system resource invariants even on initialization failures.

---

## 4. Dispositions (applied 2026-06-13)

- **2.1 Safe client disconnect on spawner failure → FIX (Task 2).** Moved `await spawner(ctx)`
  **inside** the `try` so a partially-registered client is disconnected in `finally` if the spawner
  throws mid-registration; the spawner error still propagates unchanged. Added a dedicated test
  ("disconnects partially-registered clients if the spawner throws mid-registration") → 8 tests for
  the file. **EXPLAIN (I19 framing):** this is the one intentional behavior delta in D1; it is
  strictly-safer error-path hardening that does **not** touch the I19 secret path — the seam selects
  *which* spawner, and secrets still flow only through the real spawner's subprocess env
  (I1 `extensionProcessEnv` + I15 `wrapServerSpec`). The public `spawnTeamToolAndCall` signature is
  unchanged; the I19 runtime test (injecting at the `invoke-gate`/`team-tool-invoke` layer) is
  unaffected. Task 4 re-verifies `security-invariants` 69/69 + `audit:invariants`.

- **2.2 Bonjour host-fallback robustness → EXPLAIN (no change).** Reviewer validated
  `service.addresses?.[0] ?? service.host` + the `typeof host === "string"` guard as correct; the
  plan's Task 1 tests already cover all four arms (addresses-hit, host-fallback, no-host-skip,
  non-numeric-port-skip).

- **2.3 Sonar exclusion truncation correctness → EXPLAIN (no change).** Reviewer confirmed
  `team-tool-spawn.ts` is the last token on `sonar-project.properties` line 74; Task 2 Step 5's
  "remove the leading comma + the path" keeps the list well-formed (no trailing comma).
