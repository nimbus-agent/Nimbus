# Review & Feedback: I29 Ledger Completeness Design

This document contains a structured review, suggestions, improvements, and open questions regarding the design of the I29 ledger completeness specified in [2026-08-03-i29-ledger-completeness-design.md](./2026-08-03-i29-ledger-completeness-design.md).

---

## 1. Loopback vs. Non-Local Hostnames (Pre-DNS Classification Risk)

### Issue
The design specifies classifying traffic pre-DNS using URL host:
> **loopback** -> `local:` — `127.0.0.0/8`, `::1`, `::`, and the bare hostname `localhost`.

If a user runs a local LLM or provider (e.g., Ollama or llama.cpp) on their local machine, but configures it using their machine's local hostname (e.g., `http://my-macbook.local:11434` or `http://workstation:11434`), the pre-DNS classifier will fail to recognize it as loopback. It will classify it as `net:llm` (off-machine egress) rather than `local:llm`. This will cause `nimbus prove` to report a non-zero egress count for a fully-local query.

### Recommendation
* ** mDNS and Local Domains:** Add `.local` (mDNS) and workstation hostnames (if they resolve to local/loopback interfaces) to the classification exception list, or explicitly document this behavior so developers configuring local LLMs know to use `127.0.0.1` or `localhost` to maintain a clean `0` egress proof.
* **Link-Local IP Classification:** Explicitly define the classification of IPv4 Link-Local addresses (`169.254.0.0/16`). These are commonly used for local service discovery or cloud IMDS (e.g. AWS `169.254.169.254`). They should be categorized as `local:` if they represent link-scoped loopback-like traffic, or explicitly defined as `net:` if they are treated as external.

---

## 2. Low-Level Socket Audits (`net.Socket`, `tls.connect`)

### Issue
The static analysis rule `D22-egress-fetch` is designed to flag:
> bare `fetch(`, `Bun.connect(`, `new WebSocket(` in `packages/gateway/src`, non-test, outside `egress/`.

While Bun-native APIs are covered, Node compatibility APIs like `net.connect`, `net.createConnection`, `tls.connect`, `http.request`, and `https.request` could bypass this static check if a developer imports and uses them directly. A third-party dependency inside the gateway process might also use these Node core APIs under the hood.

### Recommendation
* **Node API Confinement:** Extend the static audit regex in `checkEgressChokepointConfinement` to also flag imports/calls of node networking primitives (`node:net`, `node:tls`, `node:http`, `node:https`) outside of `egress/` and allowlisted directories.
* **PR-3 Backstop Verification:** Ensure that the `globalThis.fetch` override planned for PR-3 also intercepts or monitors the underlying socket creation if possible, or clearly state the boundary of what PR-3 is capable of catching (e.g., only global fetch calls vs. raw socket creations).

---

## 3. Global Sink Contamination in Multi-Gateway / Testing Contexts

### Issue
The design utilizes a module-global sink (`setEgressSink`) to avoid threading `EgressSink` through 11 leaf signatures. While `resetEgressSink()` is provided in `afterEach` to mitigate test contamination, a process running multiple concurrent gateway instances (e.g., in a federated testing setup or a multi-profile local server) will suffer from race conditions where the global sink is overwritten.

### Recommendation
Instead of a simple mutable module-global variable, use Node's/Bun's `AsyncLocalStorage` to store the active context's `EgressSink`. 
```ts
import { AsyncLocalStorage } from "node:async_hooks";
export const egressLocalStorage = new AsyncLocalStorage<EgressSink>();
```
Leaf functions can read `egressLocalStorage.getStore()` to retrieve the sink bound to the current execution thread/context, falling back to a global default. This preserves the signature signatures while remaining safe for concurrent/multi-instance environments.

---

## 4. Degraded Mode Database Failures

### Issue
If the SQLite database becomes read-only or locked, `EgressSink.append` will throw continuously. While the in-memory lost-append counter will increment, we will never be able to write the `net:degraded` marker to the database because all writes are failing. If the gateway process is killed or restarted, this state is lost, and the ledger might look clean (or indeterminate only due to the missing boot marker) without showing the actual volume of lost actions.

### Recommendation
Consider writing a fallback transient state file (e.g., a simple `.degraded` lock/sentinel file in the gateway's run directory) when appends fail, which is read at startup to initialize/maintain the degradation status across restarts.
