# Plan Review: Standalone Connector Hardening — Implementation Plan

**Date:** 2026-08-23  
**Status:** Plan Review / Feedback  
**Target Plan:** [2026-08-23-standalone-connector-hardening.md](./2026-08-23-standalone-connector-hardening.md)

---

## 1. Critical Technical Risk: Initialization Timing (Task 5 & 6)

### The Issue

Task 5 defines `createWriteToolRegistrar` which checks client capabilities at **registration time**:

```ts
if (getConnectorMode() === "standalone") {
  const caps = server.server.getClientCapabilities();
  if (caps?.elicitation === undefined) {
    return;
  }
}
```

However, connectors call `registerWriteTool` at **module scope** (when the server script is first loaded/imported):

* At module scope / import time, the MCP connection has not yet been established.
* The client's `initialize` request containing capabilities has not been received.
* Therefore, `server.server.getClientCapabilities()` is guaranteed to return `undefined` on startup, causing **zero write tools to register**, even if the client supports elicitation.

### The Suggestion

Defer the registration of write tools until the connection is initialized:

1. In `createWriteToolRegistrar`, store the write tools (and their configurations/handlers) in an internal list instead of calling `server.registerTool` immediately.
2. Register an initialization hook/callback on the MCP server (e.g. `oninitialized` or custom connection callback).
3. Once initialized, check client capabilities. If `elicitation` is supported, register all deferred write tools to the server, and then call `server.sendToolListChanged()`.

---

## 2. Improvements & Suggestions

### Q1. Buffering Stdout in `nimbusSpawn` (Task 9)

* **The Issue:**
  Task 9 accumulates stdout using string concatenation:

  ```ts
  let stdout = "";
  child.stdout.on("data", (c: Buffer) => {
    stdout += c.toString("utf8");
  });
  ```

  If a multi-byte UTF-8 character is split across a stream chunk boundary, `c.toString("utf8")` will produce a corrupt character sequence at the boundary.

* **Suggestion:**
  Accumulate chunks as raw `Buffer` instances and concat them at the end:

  ```ts
  const stdoutChunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => {
    stdoutChunks.push(c);
  });
  // ...
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  ```

### Q2. Concurrent Test Run Interference (Task 1)

* **The Issue:**
  `resetConnectorModeForTests()` resets a global process variable `current`. If Bun runs different test files concurrently in the same process/runtime (which can happen depending on Bun configuration or test environment reuse), tests might interfere with each other's locked modes.

* **Suggestion:**
  Annotate `resetConnectorModeForTests` clearly as a test-only utility, and double check that Bun test runner runs test suites in separate worker threads/processes to avoid global scope contamination.

### Q3. User Feedback on Empty/Unset Write Scope (Task 3 & 7)

* **The Issue:**
  If `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` is unset, the scope parses to empty and silently denies all mutations. This is correct for safety, but can be confusing for a user setting up the connector.

* **Suggestion:**
  When in `"standalone"` mode and the scope parses to empty, print a warning to `stderr` or send a logging message to the client on startup indicating that the server is running in write-disabled/read-only mode due to an empty write scope.

### Q4. Robustness of Mutation Regex in Static Audit (Task 11)

* **The Issue:**
  `MUTATING_RE = /"(POST|PUT|PATCH|DELETE)"/` only matches double quotes.

* **Suggestion:**
  Widen the regex to support single quotes and backticks:

  ```ts
  const MUTATING_RE = /(["'`])(POST|PUT|PATCH|DELETE)\1/;
  ```
