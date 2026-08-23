# Plan Review: Standalone Connector Hardening — Part 2: rollout

**Date:** 2026-08-23
**Status:** Plan Review / Feedback
**Target Plan:** [2026-08-23-standalone-connector-hardening-part2.md](./2026-08-23-standalone-connector-hardening-part2.md)

---

## 1. Concurrency and Shared State in Bun Tests (Tasks 3–8)

### The Issue

In Tasks 3–8 (specifically Step 7), the plan states:
> If the connector has a test importing `src/server.ts` directly — 18 files do, all in waves 8 and 5 — add `setConnectorMode("gateway")` in a `beforeAll`, and reset in BOTH `beforeEach` and `afterEach`. `bun test` runs many files in ONE process, verified, so an unreset lock changes every later file.

Since `bun test` by default executes tests concurrently (or with microtask-level concurrency in the same thread/process), mutating a process-global variable like `current` in `connector-mode.ts` poses a race condition hazard. If Test File A runs in `"gateway"` mode and Test File B runs in `"standalone"` mode concurrently, they can clobber each other's configuration, leading to flaky test failures.

### Suggestions

1. **Verify Test Suite Concurrency:** Confirm whether the Bun test runner in Nimbus is configured with `--concurrency=1` or runs test files in isolated processes/worker threads. If it does not, a process-global setting is unsafe for parallel tests.
2. **Context-Based Config Option:** For a longer-term improvement, consider passing the connector mode down via an options/context object during initialization or server creation rather than relying on a process-global singleton state.

---

## 2. Action Type Prefix & Egress Ledger Destinations (Action-type naming rule)

### The Issue

The plan states:
> Every migrated write tool declares `mutates: "<service>.<object>.<verb>"`, where `<service>` is the connector's service id — `gmail`, `outlook`, `bitbucket` — **never** a generic bucket.
> This is the whole point of the per-connector scheme... I29 uses it for the egress ledger's `destination`.

While this is excellent for tracking and auditing, double-check that all downstream consumer engines of the egress ledger (such as `nimbus prove` or UI dashboards) do not hardcode checks or filters against the old generic buckets (`email`, `file`, etc.). If they do, migrating to `<service>` prefixes could break queries or filtering logic on those surfaces.

### Suggestions

1. Run a grep search on `packages/gateway` for any references to the generic prefixes (e.g. `"repo."`, `"email."`, `"file."`, `"calendar."`) to ensure they are parsed dynamically or fallback gracefully to matching the prefix.

---

## 3. Unrecoverable Mutations & Pre-State Capture (Tasks 3-8, Step 5)

### The Issue

The plan requires `capturePreState` whenever `recoverable: false`. For some connectors (e.g., deleting a VM, terminating a container, deleting a slack channel/message), the resource might be unrecoverable, but capturing the pre-state may require a complex sequence of API calls or might fail if the resource was already deleted.

### Suggestions

1. Ensure the plan explicitly notes that if `capturePreState` fails or throws, the consent kit's `guarded` method handles the failure gracefully (returning a fallback error object to the audit log) and does not crash the server or block the operation.
2. For tools where pre-state is minimal or impossible to query, define a simple fallback pre-state capturing just the ID or parameters of the deleted target.

---

## 4. Verification & Audit Tools (Task 10)

### The Issue

Flipping `MUTATION_RULE_BLOCKING = true` will cause any non-compliant connector to block the build/PR check.

### Suggestions

1. Ensure that `MUTATION_RULE_BLOCKING` is correctly configured so that it runs in CI and does not get bypassed.
2. Ensure that any false positives in the static analysis regex `MUTATING_RE` are clearly documented as exemptions in `check-connector-consent.ts` so developers do not get blocked by advisory rule matches that are actually read-only tools.
