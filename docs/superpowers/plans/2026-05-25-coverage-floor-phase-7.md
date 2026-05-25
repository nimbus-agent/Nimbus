# Coverage Floor Phase 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the per-file coverage-floor baseline from 51 → 10 entries by closing every non-CLI bucket (client, SDK, the one gateway leftover, and all MCP connectors), leaving only the 10 CLI deep cuts for Phase 8.

**Architecture:** Single PR, 7 commits, low-risk → high-risk. 34 already-exempt entries are pruned from the baseline in commit 1 (31 connector `server.ts` + 3 barrel/type files newly excluded). 7 files are raised to ≥80% with real tests (2 SDK, 1 connector, 3 client, 1 gateway) and dropped from the baseline only in the final commit (CI-Linux-authoritative discipline). The one novel refactor is a sibling-shim DI for `embedding/model.ts`. No shared harness — each package reuses its own existing test patterns.

**Tech Stack:** Bun v1.2+ test runner (`bun:test`), WebCrypto Ed25519 (SDK), `globalThis.fetch` stubs (jenkins), real `Bun.listen({ unix })` socket (client transport), `mock.module` of a sibling shim (gateway model only), Biome lint.

**Spec:** [`docs/superpowers/specs/2026-05-25-coverage-floor-phase-7-design.md`](../specs/2026-05-25-coverage-floor-phase-7-design.md)
**Review:** [`docs/superpowers/plans/2026-05-25-coverage-floor-phase-7-review.md`](./2026-05-25-coverage-floor-phase-7-review.md)
**Branch:** `dev/asafgolombek/coverage-floor-phase-7-2026-05-25`
**Worktree:** `.worktrees/coverage-floor-phase-7-2026-05-25/`
**Base commit:** `f196b03f` (PR #422, Phase 6 merge; includes ArgoCD PR #424)

---

## File Map

**Modified (registry / config):**

- `scripts/coverage-floor/exclusions.ts` — Task 1 adds 3 entries (`client/index.ts`, `client/stream-events.ts`, `sdk/ipc/index.ts`); Task 6 adds 1 (`embedding/load-feature-extraction-pipeline.ts`).
- `sonar-project.properties` — same 4 entries mirrored into `sonar.coverage.exclusions` (line 65).
- `docs/structure-audit/coverage-baseline.json` — Task 1 removes 34 entries; Task 7 removes the final 7.
- `CLAUDE.md` + `GEMINI.md` — Task 7 adds the Phase 7 status row.

**Created (source):**

- `packages/gateway/src/embedding/load-feature-extraction-pipeline.ts` (Task 6 — the excluded `@xenova` shim).

**Modified (source):**

- `packages/gateway/src/embedding/model.ts` (Task 6 — `createLocalEmbedder` calls the shim; signature unchanged).
- `packages/mcp-connectors/jenkins/src/jenkins-api.ts` (Task 3 — add a test-only `__resetJenkinsCrumbCacheForTests()` export).

**Created (tests):**

- `packages/sdk/src/crypto/verify-signature.test.ts` (Task 2).
- `packages/client/test/nimbus-client.test.ts` (Task 4).
- `packages/client/test/ipc-transport.test.ts` (Task 5).

**Modified / extended (tests):**

- `packages/sdk/src/ipc/ndjson-line-reader.test.ts` (Task 2).
- `packages/mcp-connectors/jenkins/src/jenkins-api.test.ts` (Task 3).
- `packages/client/test/mock-client.test.ts` (Task 4).
- `packages/gateway/src/embedding/model.test.ts` (Task 6 — rewrite).

---

## Pre-implementation guardrails

Non-negotiable. Treat any conflict between an instinct and a guardrail as the guardrail winning.

1. **CI Linux is authoritative.** Local Windows lcov diverges on pinned files. Never lower a baseline watermark to match local Windows — only match CI Linux.
2. **Never run `bun run audit:coverage-floor:update-baseline` mid-task.** Baseline edits are hand-made: the exempt prune in Task 1 (lcov-independent) and the 7-entry raised drop in Task 7 only. Phase 5 Task 9 was reverted for running `update-baseline` against local lcov (fixup `06628373`).
3. **`mock.module(...)` is process-global** under `bun test --coverage` (one process per package) and only affects FUTURE imports; `afterAll` restore does not undo it for already-loaded files. The ONLY `mock.module` in this phase is `model.test.ts` → the shim path, restored in `afterAll`, and it mocks the **shim** (not `model.ts`) to avoid colliding with `create-routing-runtime.test.ts`. Everywhere else use hand-rolled `FakeIpc` injection.
4. **Module-singleton reset.** `jenkins-api.ts`'s `crumbCache` must be resettable between tests (Task 3 adds an exported reset). Reset it in `beforeEach`.
5. **`node:path.join` is platform-dependent.** Use `join(...)` against the same operands the source uses; never hardcode separators.
6. **Don't commit auto-modified files** (e.g. `.claude/settings.local.json`). Stage explicit paths; never `git add -A` / `git add .`.
7. **The per-file case lists below are grounded in the current source but may drift.** Read the source file FIRST, run coverage, and target the ACTUAL uncovered lines. Document any divergence in the implementer report.
8. **TS strictness:** `noUncheckedIndexedAccess` (`arr[i]?.x`), `noPropertyAccessFromIndexSignature` (`obj["key"]`), `exactOptionalPropertyTypes` (omit a prop, don't pass `undefined`). `test.each` needs a mutable array. Run `bun run lint:fix` before every commit.
9. **Stage only the files named in the task.** Each commit body includes the line `baseline raised-entries dropped only in Task 7`.

---

## Test hygiene (cross-cutting)

### Per-package verification

There is no fast single-file coverage gate. For each task, the subagent:

1. Runs the new/changed test file directly to confirm green:
   `cd packages/<pkg> && bun test <relative-test-path>`
2. Confirms the target source file's coverage with a package-level coverage run and reads the table row:
   `cd packages/<pkg> && bun test --coverage 2>&1 | grep <source-file-basename>`
   Target: the file's line % is ≥ 80 (or, for `ipc-transport.ts` / `model.ts`, document the residual if just under and flag for a watermark hold).

The merged-lcov floor gate (`bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor`) is run once, in Task 7, before the final baseline edit.

### `fetch` stub + env restore (Task 3)

```typescript
const ORIG_FETCH = globalThis.fetch;
const SAVED_ENV: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in SAVED_ENV)) SAVED_ENV[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
```

A throwing `fetch` stub infers `Promise<never>` and needs `as unknown as typeof fetch`; a `Response`-returning stub uses `as typeof fetch`.

### Real unix socket (Task 5)

Use `Bun.listen({ unix: <tmp path> })` with an ephemeral socket path; close the listener in `afterEach`. Guard the socket-dependent cases with `test.skipIf(process.platform === "win32")` (Windows uses named pipes; CI Linux is authoritative and covers the Bun unix path).

---

## Task 1: Prune exempt entries + add barrel/type exclusions

**Files:**
- Modify: `scripts/coverage-floor/exclusions.ts`
- Modify: `sonar-project.properties:65`
- Modify: `docs/structure-audit/coverage-baseline.json`

- [ ] **Step 1: Add the 3 barrel/type exclusions to `exclusions.ts`**

In the `EXCLUSIONS` array, after the existing `connectors/index.ts` barrel entry (the "Pure re-export barrel" block), add:

```typescript
  // Client package re-export barrel + the askStream type union — pure
  // `export … from` / `export type` with zero runtime emit after TS erasure.
  // Same rationale as connectors/index.ts. `stream-events.ts` does not match
  // the types.ts/-types.ts basename regexes, so it needs an exact entry.
  { kind: "exact", path: "packages/client/src/index.ts" },
  { kind: "exact", path: "packages/client/src/stream-events.ts" },
  // SDK ipc barrel — re-exports ndjson-line-reader.js only; zero runtime emit.
  { kind: "exact", path: "packages/sdk/src/ipc/index.ts" },
```

- [ ] **Step 2: Mirror the 3 entries into `sonar-project.properties`**

Append `,packages/client/src/index.ts,packages/client/src/stream-events.ts,packages/sdk/src/ipc/index.ts` to the end of the `sonar.coverage.exclusions=` value on line 65 (single comma-joined line — do not add newlines).

- [ ] **Step 3: Verify exclusion parity**

Run: `bun run audit:exclusion-parity`
Expected: exit 0 (no drift between `exclusions.ts` and `sonar-project.properties`).

- [ ] **Step 4: Remove the 34 exempt entries from the baseline**

Edit `docs/structure-audit/coverage-baseline.json` by hand — delete these keys (keep the file sorted; `serializeBaseline` order is alphabetical):

```
packages/client/src/index.ts
packages/client/src/stream-events.ts
packages/sdk/src/ipc/index.ts
packages/mcp-connectors/aws/src/server.ts
packages/mcp-connectors/azure/src/server.ts
packages/mcp-connectors/bitbucket/src/server.ts
packages/mcp-connectors/bitrise/src/server.ts
packages/mcp-connectors/circleci/src/server.ts
packages/mcp-connectors/confluence/src/server.ts
packages/mcp-connectors/datadog/src/server.ts
packages/mcp-connectors/discord/src/server.ts
packages/mcp-connectors/gcp/src/server.ts
packages/mcp-connectors/github-actions/src/server.ts
packages/mcp-connectors/github/src/server.ts
packages/mcp-connectors/gitlab/src/server.ts
packages/mcp-connectors/gmail/src/server.ts
packages/mcp-connectors/google-drive/src/server.ts
packages/mcp-connectors/google-photos/src/server.ts
packages/mcp-connectors/grafana/src/server.ts
packages/mcp-connectors/iac/src/server.ts
packages/mcp-connectors/jenkins/src/server.ts
packages/mcp-connectors/jira/src/server.ts
packages/mcp-connectors/kubernetes/src/server.ts
packages/mcp-connectors/linear/src/server.ts
packages/mcp-connectors/newrelic/src/server.ts
packages/mcp-connectors/notion/src/server.ts
packages/mcp-connectors/obsidian/src/server.ts
packages/mcp-connectors/onedrive/src/server.ts
packages/mcp-connectors/outlook/src/server.ts
packages/mcp-connectors/pagerduty/src/server.ts
packages/mcp-connectors/sentry/src/server.ts
packages/mcp-connectors/slack/src/server.ts
packages/mcp-connectors/snyk/src/server.ts
packages/mcp-connectors/teams/src/server.ts
```

The baseline should now have **17 entries** (51 − 34): the 7 to-be-raised files + the 10 CLI deep cuts.

- [ ] **Step 5: Verify the baseline parses + the gate logic is consistent**

Run: `bun test scripts/coverage-floor/` (the floor gate's own unit tests; they exercise `parseBaseline` + `evaluateCheck` + `isExempt`).
Expected: PASS. (This does not need merged lcov — it tests the pure functions.)

- [ ] **Step 6: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts sonar-project.properties docs/structure-audit/coverage-baseline.json
git commit -m "chore(coverage-floor): prune exempt connector + barrel/type entries

Removes 31 already-exempt mcp-connectors/*/src/server.ts baseline entries
(matched by the existing server.ts pathRegex) and excludes 3 zero-emit
barrel/type files (client/index.ts, client/stream-events.ts,
sdk/ipc/index.ts). Baseline 51 -> 17. No tests; lcov-independent.
baseline raised-entries dropped only in Task 7."
```

---

## Task 2: SDK — verify-signature + ndjson-line-reader

**Files:**
- Create: `packages/sdk/src/crypto/verify-signature.test.ts`
- Modify: `packages/sdk/src/ipc/ndjson-line-reader.test.ts`

- [ ] **Step 1: Read the source first**

Read `packages/sdk/src/crypto/verify-signature.ts` and `packages/sdk/src/ipc/ndjson-line-reader.ts`. Confirm the exported names used below still match (`generateEd25519Keypair`, `signManifest`, `verifyManifestSignature`, `encodeBase64`, `decodeBase64`, `errorToHardDisableReason`, `PublisherKeyMismatch`, `SignatureInvalidFormat`, `SignatureInvalid`; `NdjsonLineReader`, `IPC_MAX_LINE_BYTES`).

- [ ] **Step 2: Write `verify-signature.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";

import {
  decodeBase64,
  encodeBase64,
  errorToHardDisableReason,
  generateEd25519Keypair,
  PublisherKeyMismatch,
  signManifest,
  SignatureInvalid,
  SignatureInvalidFormat,
  verifyManifestSignature,
} from "./verify-signature.ts";

type Manifest = {
  publisher?: { id: string; key: string };
  signature?: string;
  [k: string]: unknown;
};

async function signedManifest(): Promise<{
  manifest: Manifest;
  pubkey: Uint8Array;
  privkey: Uint8Array;
}> {
  const { privkey, pubkey } = generateEd25519Keypair();
  const manifest: Manifest = {
    id: "com.example.demo",
    version: "1.0.0",
    publisher: { id: "demo", key: encodeBase64(pubkey) },
  };
  manifest.signature = await signManifest(manifest, privkey);
  return { manifest, pubkey, privkey };
}

describe("base64 round-trip", () => {
  test("encode then decode is identity", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(decodeBase64(encodeBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("verifyManifestSignature", () => {
  test("accepts a correctly signed manifest", async () => {
    const { manifest, pubkey } = await signedManifest();
    await expect(verifyManifestSignature(manifest, pubkey)).resolves.toBeUndefined();
  });

  test("throws SignatureInvalid when a field is tampered after signing", async () => {
    const { manifest, pubkey } = await signedManifest();
    manifest["version"] = "9.9.9"; // change canonical bytes; signature now stale
    await expect(verifyManifestSignature(manifest, pubkey)).rejects.toBeInstanceOf(SignatureInvalid);
  });

  test("throws PublisherKeyMismatch when resolved key differs from declared", async () => {
    const { manifest } = await signedManifest();
    const other = generateEd25519Keypair().pubkey;
    await expect(verifyManifestSignature(manifest, other)).rejects.toBeInstanceOf(
      PublisherKeyMismatch,
    );
  });

  test("throws SignatureInvalidFormat for a wrong-length resolved pubkey", async () => {
    const { manifest } = await signedManifest();
    await expect(
      verifyManifestSignature(manifest, new Uint8Array(31)),
    ).rejects.toBeInstanceOf(SignatureInvalidFormat);
  });

  test("throws SignatureInvalidFormat for a wrong-length declared pubkey", async () => {
    const { manifest, pubkey } = await signedManifest();
    manifest.publisher = { id: "demo", key: encodeBase64(new Uint8Array(31)) };
    await expect(verifyManifestSignature(manifest, pubkey)).rejects.toBeInstanceOf(
      SignatureInvalidFormat,
    );
  });

  test("throws SignatureInvalidFormat for a wrong-length signature", async () => {
    const { manifest, pubkey } = await signedManifest();
    manifest.signature = encodeBase64(new Uint8Array(63));
    await expect(verifyManifestSignature(manifest, pubkey)).rejects.toBeInstanceOf(
      SignatureInvalidFormat,
    );
  });

  test("throws when manifest is unsigned (no publisher / no signature)", async () => {
    const { pubkey } = await signedManifest();
    await expect(verifyManifestSignature({ id: "x" }, pubkey)).rejects.toThrow(/unsigned manifest/);
  });
});

describe("signManifest", () => {
  test("throws SignatureInvalidFormat for a non-32-byte private key", async () => {
    await expect(signManifest({ id: "x" }, new Uint8Array(16))).rejects.toBeInstanceOf(
      SignatureInvalidFormat,
    );
  });
});

describe("errorToHardDisableReason", () => {
  test("maps each error class to its reason", () => {
    expect(errorToHardDisableReason(new PublisherKeyMismatch())).toBe("publisher_key_mismatch");
    expect(errorToHardDisableReason(new SignatureInvalidFormat())).toBe("signature_malformed");
    expect(errorToHardDisableReason(new SignatureInvalid())).toBe("signature_failed");
    expect(errorToHardDisableReason(new Error("unknown"))).toBe("signature_failed");
  });
});
```

- [ ] **Step 3: Run verify-signature test**

Run: `cd packages/sdk && bun test src/crypto/verify-signature.test.ts`
Expected: PASS. If WebCrypto Ed25519 is unavailable on the runner, the round-trip throws at `crypto.subtle.importKey`/`sign` — document and consult before proceeding (the production code uses the same path, so a green gateway suite means it works).

- [ ] **Step 4: Extend `ndjson-line-reader.test.ts`**

Append these cases inside the existing `describe("NdjsonLineReader", ...)`:

```typescript
  test("buffers a partial line across push() calls", () => {
    const r = new NdjsonLineReader();
    const enc = new TextEncoder();
    expect(r.push(enc.encode('{"a"'))).toEqual([]);
    expect(r.push(enc.encode(":1}\n"))).toEqual(['{"a":1}']);
  });

  test("strips a trailing carriage return", () => {
    const r = new NdjsonLineReader();
    expect(r.push(new TextEncoder().encode('{"a":1}\r\n'))).toEqual(['{"a":1}']);
  });

  test("decodes multi-byte UTF-8 split across chunk boundaries", () => {
    const r = new NdjsonLineReader();
    const full = new TextEncoder().encode('"é"\n'); // é = 0xC3 0xA9
    const cut = 2; // split inside the 2-byte é
    expect(r.push(full.slice(0, cut))).toEqual([]);
    expect(r.push(full.slice(cut))).toEqual(['"é"']);
  });

  test("flush() returns a pending line with no trailing newline", () => {
    const r = new NdjsonLineReader();
    r.push(new TextEncoder().encode("partial"));
    expect(r.flush()).toEqual(["partial"]);
  });

  test("flush() strips a trailing carriage return", () => {
    const r = new NdjsonLineReader();
    r.push(new TextEncoder().encode("partial\r"));
    expect(r.flush()).toEqual(["partial"]);
  });

  test("flush() returns [] when nothing is pending", () => {
    expect(new NdjsonLineReader().flush()).toEqual([]);
  });

  test("throws when the pending buffer (no newline yet) exceeds the limit", () => {
    const r = new NdjsonLineReader();
    const huge = "x".repeat(IPC_MAX_LINE_BYTES + 1); // no newline
    expect(() => r.push(new TextEncoder().encode(huge))).toThrow("Message exceeds 1MB line limit");
  });

  test("flush() throws when the pending buffer exceeds the limit", () => {
    const r = new NdjsonLineReader();
    // push just under the limit with no newline, then flush
    const big = "x".repeat(IPC_MAX_LINE_BYTES + 1);
    expect(() => {
      r.push(new TextEncoder().encode(big));
    }).toThrow(); // push already trips; covered above — keep flush-specific below
  });

  test("uses the custom lineLimitError constructor", () => {
    class TooBig extends Error {}
    const r = new NdjsonLineReader({ lineLimitError: TooBig });
    const huge = `${"x".repeat(IPC_MAX_LINE_BYTES + 1)}\n`;
    expect(() => r.push(new TextEncoder().encode(huge))).toThrow(TooBig);
  });
```

Note: the `flush() throws` case above duplicates the pending-buffer trip — if coverage shows `flush()`'s limit branch is still uncovered, construct a reader whose pending is grown via a custom-limit reader and assert on `flush()` directly; document the exact case used.

- [ ] **Step 5: Run ndjson test + package coverage**

Run: `cd packages/sdk && bun test src/ipc/ndjson-line-reader.test.ts`
Expected: PASS.
Run: `cd packages/sdk && bun test --coverage 2>&1 | grep -E "verify-signature|ndjson-line-reader"`
Expected: both files ≥ 80%.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/crypto/verify-signature.test.ts packages/sdk/src/ipc/ndjson-line-reader.test.ts
git commit -m "test(sdk): cover verify-signature + ndjson-line-reader

Ed25519 sign/verify round-trip + error branches; NDJSON partial-line,
CR-strip, multi-byte split, flush, oversize, and custom-error cases.
baseline raised-entries dropped only in Task 7."
```

---

## Task 3: MCP connector — jenkins-api

**Files:**
- Modify: `packages/mcp-connectors/jenkins/src/jenkins-api.ts` (add test-only cache reset)
- Modify: `packages/mcp-connectors/jenkins/src/jenkins-api.test.ts`

- [ ] **Step 1: Read the source first**

Read `packages/mcp-connectors/jenkins/src/jenkins-api.ts`. Confirm `crumbCache` is module-private with no reset, and the exported function names below match.

- [ ] **Step 2: Add a test-only cache reset to `jenkins-api.ts`**

After the `let crumbCache: JenkinsCrumb | null | undefined;` declaration, add:

```typescript
/** Test-only: reset the module-level crumb cache so each test starts clean. */
export function __resetJenkinsCrumbCacheForTests(): void {
  crumbCache = undefined;
}
```

- [ ] **Step 3: Extend `jenkins-api.test.ts`**

Replace the file with (keeps the two existing pure-function cases, adds the fetch/env cases):

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __resetJenkinsCrumbCacheForTests,
  getJenkinsCrumb,
  jenkinsAuthHeader,
  jenkinsBaseUrl,
  jenkinsFetchJson,
  jenkinsPost,
  jobApiRoot,
  jobPathFromFullName,
} from "./jenkins-api.ts";

const ORIG_FETCH = globalThis.fetch;
const SAVED_ENV: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in SAVED_ENV)) SAVED_ENV[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => {
  __resetJenkinsCrumbCacheForTests();
});
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("jenkins-api pure helpers", () => {
  test("jobPathFromFullName encodes each path segment", () => {
    expect(jobPathFromFullName("my-job")).toBe("my-job");
    expect(jobPathFromFullName("folder/sub")).toBe("folder/job/sub");
  });
  test("jobPathFromFullName throws on empty / whitespace", () => {
    expect(() => jobPathFromFullName("")).toThrow(/empty/);
    expect(() => jobPathFromFullName("  /  ")).toThrow(/empty/);
  });
  test("jobApiRoot builds classic path", () => {
    expect(jobApiRoot("https://ci.example", "a/b")).toBe("https://ci.example/job/a/job/b");
  });
});

describe("env-derived config", () => {
  test("jenkinsBaseUrl trims and strips trailing slashes", () => {
    setEnv("JENKINS_BASE_URL", "  https://ci.example/  ");
    expect(jenkinsBaseUrl()).toBe("https://ci.example");
  });
  test("jenkinsBaseUrl throws when unset", () => {
    setEnv("JENKINS_BASE_URL", "");
    expect(() => jenkinsBaseUrl()).toThrow(/not set/);
  });
  test("jenkinsAuthHeader throws when user or token missing", () => {
    setEnv("JENKINS_USERNAME", "");
    setEnv("JENKINS_API_TOKEN", "tok");
    expect(() => jenkinsAuthHeader()).toThrow(/must be set/);
    setEnv("JENKINS_USERNAME", "user");
    setEnv("JENKINS_API_TOKEN", "");
    expect(() => jenkinsAuthHeader()).toThrow(/must be set/);
  });
  test("jenkinsAuthHeader encodes basic auth when both present", () => {
    setEnv("JENKINS_USERNAME", "user");
    setEnv("JENKINS_API_TOKEN", "tok");
    expect(jenkinsAuthHeader()).toMatch(/^Basic /);
  });
});

describe("getJenkinsCrumb", () => {
  test("returns crumb on ok + valid JSON, then serves from cache", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ crumb: "abc", crumbRequestField: "Jenkins-Crumb" });
    }) as typeof fetch;
    const first = await getJenkinsCrumb("https://ci", "Basic x");
    expect(first).toEqual({ field: "Jenkins-Crumb", value: "abc" });
    const second = await getJenkinsCrumb("https://ci", "Basic x");
    expect(second).toEqual(first);
    expect(calls).toBe(1); // second call hit the cache
  });
  test("caches null on non-ok response", async () => {
    globalThis.fetch = (async () => jsonResponse({}, false, 403)) as typeof fetch;
    expect(await getJenkinsCrumb("https://ci", "Basic x")).toBeNull();
  });
  test("caches null when JSON is not an object", async () => {
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => [1, 2, 3], text: async () => "[1,2,3]" }) as Response) as typeof fetch;
    expect(await getJenkinsCrumb("https://ci", "Basic x")).toBeNull();
  });
  test("caches null when crumb fields are missing", async () => {
    globalThis.fetch = (async () => jsonResponse({ crumb: "" })) as typeof fetch;
    expect(await getJenkinsCrumb("https://ci", "Basic x")).toBeNull();
  });
  test("caches null when json() throws", async () => {
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => {
        throw new Error("bad json");
      }, text: async () => "x" }) as Response) as typeof fetch;
    expect(await getJenkinsCrumb("https://ci", "Basic x")).toBeNull();
  });
});

describe("jenkinsFetchJson", () => {
  test("returns parsed JSON on 200", async () => {
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => '{"k":1}' }) as Response) as typeof fetch;
    const r = await jenkinsFetchJson("https://ci/api", { authHeader: "Basic x" });
    expect(r).toEqual({ ok: true, status: 200, text: '{"k":1}', json: { k: 1 } });
  });
  test("returns json:null on an unparseable body", async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 500, text: async () => "<html>" }) as Response) as typeof fetch;
    const r = await jenkinsFetchJson("https://ci/api", { authHeader: "Basic x" });
    expect(r.ok).toBe(false);
    expect(r.json).toBeNull();
  });
});

describe("jenkinsPost", () => {
  test("adds the crumb header when a crumb is provided", async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    await jenkinsPost("https://ci/do", "Basic x", { field: "Jenkins-Crumb", value: "abc" });
    expect(seen["Jenkins-Crumb"]).toBe("abc");
  });
  test("omits the crumb header when crumb is null", async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    await jenkinsPost("https://ci/do", "Basic x", null);
    expect(Object.keys(seen)).toEqual(["Authorization"]);
  });
});
```

- [ ] **Step 4: Run jenkins test + coverage**

Run: `cd packages/mcp-connectors/jenkins && bun test src/jenkins-api.test.ts`
Expected: PASS.
Run: `cd packages/mcp-connectors/jenkins && bun test --coverage 2>&1 | grep jenkins-api`
Expected: `jenkins-api.ts` ≥ 80%.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/jenkins/src/jenkins-api.ts packages/mcp-connectors/jenkins/src/jenkins-api.test.ts
git commit -m "test(mcp): cover jenkins-api (fetch stub + env)

Covers base-url/auth env validation, getJenkinsCrumb branches (with a
test-only cache reset), jenkinsFetchJson parse paths, and jenkinsPost
crumb-header handling.
baseline raised-entries dropped only in Task 7."
```

---

## Task 4: Client — mock-client + nimbus-client (FakeIpc)

**Files:**
- Modify: `packages/client/test/mock-client.test.ts`
- Create: `packages/client/test/nimbus-client.test.ts`

- [ ] **Step 1: Read the source first**

Read `packages/client/src/mock-client.ts` and `packages/client/src/nimbus-client.ts`. Note `NimbusClient`'s constructor is `private` (TS-only — runtime-callable via cast). The `FakeIpc` template lives in `packages/client/test/ask-stream.test.ts:8-31`.

- [ ] **Step 2: Extend `mock-client.test.ts`**

Append to the existing `describe("MockClient", ...)`:

```typescript
  test("agentInvoke returns default then fixture reply", async () => {
    expect((await new MockClient().agentInvoke("hi")).reply).toBe("[MockClient] agent.invoke");
    expect((await new MockClient({ reply: "R" }).agentInvoke("hi")).reply).toBe("R");
  });

  test("askStream yields default tokens then a done event", async () => {
    const evs = [];
    for await (const e of new MockClient().askStream("hi")) evs.push(e);
    expect(evs.map((e) => e.type)).toEqual(["token", "token", "done"]);
  });

  test("askStream honours custom streamTokens", async () => {
    const evs = [];
    for await (const e of new MockClient({ streamTokens: ["a"] }).askStream("hi")) evs.push(e);
    expect(evs.filter((e) => e.type === "token").length).toBe(1);
  });

  test("askStream stops after cancel()", async () => {
    const h = new MockClient().askStream("hi");
    await h.cancel();
    const evs = [];
    for await (const e of h) evs.push(e);
    expect(evs).toEqual([]);
  });

  test("subscribeHitl returns a disposer", () => {
    const sub = new MockClient().subscribeHitl(() => undefined);
    expect(typeof sub.dispose).toBe("function");
    sub.dispose();
  });

  test("getSessionTranscript / cancelStream / querySql / auditList / close", async () => {
    const c = new MockClient();
    expect((await c.getSessionTranscript()).sessionId).toBe("mock-session");
    expect(await c.cancelStream()).toEqual({ ok: true });
    expect(await c.querySql("SELECT 1")).toEqual({ rows: [] });
    expect(await c.auditList()).toEqual([]);
    await c.close();
  });

  test("queryItems returns empty meta without fixtures", async () => {
    const r = await new MockClient().queryItems({});
    expect(r).toEqual({ items: [], meta: { limit: 0, total: 0 } });
  });
```

- [ ] **Step 3: Write `nimbus-client.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";

import { NimbusClient } from "../src/nimbus-client.ts";
import type { HitlRequest } from "../src/stream-events.ts";

type CallSpy = { method: string; params: unknown };

class FakeIpc {
  public calls: CallSpy[] = [];
  public notifHandlers = new Map<string, ((p: unknown) => void)[]>();
  private readonly responses: unknown[];
  constructor(responses: unknown[] = []) {
    this.responses = responses;
  }
  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return this.responses.shift() ?? { ok: true };
  }
  onNotification(method: string, handler: (p: unknown) => void): void {
    const arr = this.notifHandlers.get(method) ?? [];
    arr.push(handler);
    this.notifHandlers.set(method, arr);
  }
  emit(method: string, params: unknown): void {
    for (const h of this.notifHandlers.get(method) ?? []) h(params);
  }
  async disconnect(): Promise<void> {}
}

// The constructor is private at the type level only; construct via cast.
function makeClient(ipc: FakeIpc): NimbusClient {
  return new (NimbusClient as unknown as { new (ipc: unknown): NimbusClient })(ipc);
}

describe("NimbusClient method dispatch", () => {
  test("agentInvoke sends defaults and omits undefined optionals", async () => {
    const ipc = new FakeIpc([{ reply: "ok" }]);
    await makeClient(ipc).agentInvoke("hello");
    expect(ipc.calls[0]).toEqual({
      method: "agent.invoke",
      params: { input: "hello", stream: false },
    });
  });

  test("agentInvoke includes sessionId + agent when provided", async () => {
    const ipc = new FakeIpc([{}]);
    await makeClient(ipc).agentInvoke("hi", { stream: true, sessionId: "s1", agent: "a1" });
    expect(ipc.calls[0]?.params).toEqual({
      input: "hi",
      stream: true,
      sessionId: "s1",
      agent: "a1",
    });
  });

  test("getSessionTranscript / cancelStream / querySql / auditList route correctly", async () => {
    const ipc = new FakeIpc([{ sessionId: "s", turns: [], hasMore: false }, { ok: true }, { rows: [] }, []]);
    const c = makeClient(ipc);
    await c.getSessionTranscript({ sessionId: "s" });
    await c.cancelStream("stream-9");
    await c.querySql("SELECT 1");
    await c.auditList();
    expect(ipc.calls.map((x) => x.method)).toEqual([
      "engine.getSessionTranscript",
      "engine.cancelStream",
      "index.querySql",
      "audit.list",
    ]);
    expect(ipc.calls[1]?.params).toEqual({ streamId: "stream-9" });
    expect(ipc.calls[3]?.params).toEqual({ limit: 50 }); // default
  });

  test("auditList passes a custom limit", async () => {
    const ipc = new FakeIpc([[]]);
    await makeClient(ipc).auditList(7);
    expect(ipc.calls[0]?.params).toEqual({ limit: 7 });
  });

  test("queryItems forwards all filter params", async () => {
    const ipc = new FakeIpc([{ items: [], meta: { limit: 0, total: 0 } }]);
    await makeClient(ipc).queryItems({ services: ["github"], types: ["pr"], limit: 5 });
    expect(ipc.calls[0]).toMatchObject({ method: "index.queryItems" });
    expect((ipc.calls[0]?.params as Record<string, unknown>)["services"]).toEqual(["github"]);
  });

  test("subscribeHitl forwards valid batches and filters malformed ones", () => {
    const ipc = new FakeIpc();
    const got: HitlRequest[] = [];
    makeClient(ipc).subscribeHitl((r) => got.push(r));
    ipc.emit("agent.hitlBatch", { requestId: "r1", prompt: "Approve?", streamId: "s1" });
    ipc.emit("agent.hitlBatch", { prompt: "no requestId" }); // filtered
    ipc.emit("agent.hitlBatch", null); // filtered
    expect(got.length).toBe(1);
    expect(got[0]).toMatchObject({ requestId: "r1", prompt: "Approve?", streamId: "s1" });
  });

  test("close disconnects the transport", async () => {
    const ipc = new FakeIpc();
    let disconnected = false;
    ipc.disconnect = async () => {
      disconnected = true;
    };
    await makeClient(ipc).close();
    expect(disconnected).toBe(true);
  });
});
```

- [ ] **Step 4: Run client tests + coverage**

Run: `cd packages/client && bun test test/mock-client.test.ts test/nimbus-client.test.ts`
Expected: PASS.
Run: `cd packages/client && bun test --coverage 2>&1 | grep -E "mock-client|nimbus-client"`
Expected: both ≥ 80%. (`askStream` delegation to `createAskStream` is exercised via the existing `ask-stream.test.ts`; if `nimbus-client.ts`'s `askStream` line is uncovered, add a one-line `makeClient(ipc).askStream("hi")` call and assert it returns a handle with a `streamId`.)

- [ ] **Step 5: Commit**

```bash
git add packages/client/test/mock-client.test.ts packages/client/test/nimbus-client.test.ts
git commit -m "test(client): cover mock-client + nimbus-client via FakeIpc

Exercises every MockClient method (incl. askStream cancel) and asserts
NimbusClient's RPC method names + param construction + HITL filtering.
baseline raised-entries dropped only in Task 7."
```

---

## Task 5: Client — ipc-transport (real unix socket)

**Files:**
- Create: `packages/client/test/ipc-transport.test.ts`

No source change. The dispatch core is reachable over a real `Bun.listen({ unix })` socket; the Windows named-pipe and Node (non-Bun) unix paths stay uncovered on Linux CI (authoritative).

- [ ] **Step 1: Read the source first**

Read `packages/client/src/ipc-transport.ts`. Confirm: `new IPCClient(socketPath)`, `connect()`, `call(method, params)`, `onNotification(method, handler)`, `disconnect()`; inbound frames are NDJSON; responses match by `id`; `error` field rejects; notifications have no `id`.

- [ ] **Step 2: Write `ipc-transport.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IPCClient } from "../src/ipc-transport.ts";

const isWin = process.platform === "win32";

let tmp: string;
let socketPath: string;
let server: ReturnType<typeof Bun.listen> | undefined;
const sockets = new Set<{ write: (s: string) => void; end: () => void }>();

beforeEach(() => {
  // Canonical mkdtempSync sanitizer (CodeQL js/file-system-race).
  tmp = mkdtempSync(join(tmpdir(), "nimbus-ipc-"));
  socketPath = join(tmp, "gw.sock");
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  sockets.clear();
  rmSync(tmp, { recursive: true, force: true });
});

/** Start a unix-socket echo server that replies to each line via `respond`. */
function startServer(respond: (line: string, write: (s: string) => void) => void): void {
  server = Bun.listen({
    unix: socketPath,
    socket: {
      open(sock) {
        sockets.add(sock as unknown as { write: (s: string) => void; end: () => void });
      },
      data(sock, chunk) {
        const write = (s: string): void => {
          (sock as unknown as { write: (s: string) => void }).write(s);
        };
        for (const line of new TextDecoder().decode(chunk).split("\n")) {
          if (line.trim().length > 0) respond(line, write);
        }
      },
    },
  });
}

describe("IPCClient", () => {
  test("call() throws when not connected", async () => {
    const c = new IPCClient(socketPath);
    await expect(c.call("x", {})).rejects.toThrow(/not connected/);
  });

  test.skipIf(isWin)("resolves a matching JSON-RPC response", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string; method: string };
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { echoed: req.method } })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    expect(await c.call("ping", { a: 1 })).toEqual({ echoed: "ping" });
    await c.disconnect();
  });

  test.skipIf(isWin)("rejects on a JSON-RPC error response", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { message: "boom" } })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    await expect(c.call("x", {})).rejects.toThrow("boom");
    await c.disconnect();
  });

  test.skipIf(isWin)("dispatches notifications to onNotification handlers", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      // emit a notification, then answer the request
      write(`${JSON.stringify({ jsonrpc: "2.0", method: "evt.ping", params: { n: 1 } })}\n`);
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const seen: unknown[] = [];
    c.onNotification("evt.ping", (p) => seen.push(p));
    await c.call("trigger", {});
    expect(seen).toEqual([{ n: 1 }]);
    await c.disconnect();
  });

  test.skipIf(isWin)("disconnect() rejects in-flight calls", async () => {
    startServer(() => {
      /* never responds */
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const pending = c.call("hang", {});
    await c.disconnect();
    await expect(pending).rejects.toThrow(/disconnected/);
  });
});
```

- [ ] **Step 3: Run + coverage**

Run: `cd packages/client && bun test test/ipc-transport.test.ts`
Expected: PASS (socket cases run on Linux/macOS; the not-connected case runs everywhere).
Run: `cd packages/client && bun test --coverage 2>&1 | grep ipc-transport`
Expected: `ipc-transport.ts` ≥ 80% on Linux. If just under because `connectWindows`/`connectUnixNode` are unreachable on the Bun-Linux runner, **document the residual uncovered lines in the implementer report** — Task 7 decides drop-vs-watermark-hold based on CI Linux measurement (the file may need to stay at a raised watermark rather than be dropped; that is acceptable per spec acceptance 9).

- [ ] **Step 4: Commit**

```bash
git add packages/client/test/ipc-transport.test.ts
git commit -m "test(client): cover ipc-transport via a real unix socket

Drives connect/call/notification/error/disconnect over Bun.listen({unix})
end-to-end; no source change, public API untouched (node-compat unaffected).
baseline raised-entries dropped only in Task 7."
```

---

## Task 6: Gateway — model.ts sibling-shim DI

**Files:**
- Create: `packages/gateway/src/embedding/load-feature-extraction-pipeline.ts`
- Modify: `packages/gateway/src/embedding/model.ts`
- Modify: `scripts/coverage-floor/exclusions.ts` (+1) and `sonar-project.properties` (+1)
- Modify (rewrite): `packages/gateway/src/embedding/model.test.ts`

- [ ] **Step 1: Read the source first**

Read `packages/gateway/src/embedding/model.ts`, `model.test.ts`, and skim `create-routing-runtime.test.ts` to confirm it `mock.module`s `model.ts` (the collision the shim sidesteps). Confirm `createLocalEmbedder`'s five call sites do not pass extra args (so the signature stays `(options: CreateLocalEmbedderOptions)`).

- [ ] **Step 2: Create the shim**

`packages/gateway/src/embedding/load-feature-extraction-pipeline.ts`:

```typescript
/**
 * Thin boundary around `@xenova/transformers`. This is the ONLY module that
 * touches the dynamic import + onnxruntime-node native addon, so it is
 * structurally excluded from the coverage floor (same rationale as
 * embedding-worker.ts). Keeping the import here lets `model.ts` be unit-tested
 * by mocking this module's path — and crucially a DIFFERENT path from
 * `model.ts` itself, which `create-routing-runtime.test.ts` mocks
 * process-globally.
 */

/** Callable returned by a "feature-extraction" pipeline. */
export type FeatureExtractionPipe = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: readonly number[] }>;

const XENOVA_MODEL_REPO = "Xenova/all-MiniLM-L6-v2";

/** Load the MiniLM feature-extraction pipeline, caching weights under `cacheDir`. */
export async function loadFeatureExtractionPipeline(cacheDir: string): Promise<FeatureExtractionPipe> {
  const { env, pipeline } = await import("@xenova/transformers");
  env.cacheDir = cacheDir;
  return (await pipeline("feature-extraction", XENOVA_MODEL_REPO)) as unknown as FeatureExtractionPipe;
}
```

- [ ] **Step 3: Refactor `model.ts` to call the shim**

Replace the body of `createLocalEmbedder` (the `import("@xenova/transformers")` + `env.cacheDir` + `pipeline(...)` lines) so the file no longer imports `@xenova` directly. Keep `MINIMUM_MODEL_VERSION`, `LOCAL_EMBEDDING_MODEL_ID`, `CreateLocalEmbedderOptions`, and `tensorToRowVectors` unchanged. The `XENOVA_MODEL_REPO` constant moves to the shim. Result:

```typescript
import { processEnvGet } from "../platform/env-access.ts";
import { loadFeatureExtractionPipeline } from "./load-feature-extraction-pipeline.ts";
import type { Embedder } from "./types.ts";

export const MINIMUM_MODEL_VERSION = "1.0.0" as const;
export const LOCAL_EMBEDDING_MODEL_ID = "all-MiniLM-L6-v2" as const;

export type CreateLocalEmbedderOptions = { cacheDir: string };

function tensorToRowVectors(tensor: {
  data: Float32Array;
  dims: readonly number[];
}): Float32Array[] {
  const dims = tensor.dims;
  if (dims.length < 2) {
    throw new Error("Unexpected embedding tensor rank");
  }
  const batch = dims[0] ?? 0;
  const width = dims[1] ?? 0;
  const out: Float32Array[] = [];
  for (let i = 0; i < batch; i++) {
    const start = i * width;
    out.push(tensor.data.slice(start, start + width));
  }
  return out;
}

export async function createLocalEmbedder(options: CreateLocalEmbedderOptions): Promise<Embedder> {
  const override = processEnvGet("NIMBUS_EMBEDDING_MODEL_DIR");
  const cacheDir = override !== undefined && override !== "" ? override : options.cacheDir;
  const pipe = await loadFeatureExtractionPipeline(cacheDir);

  return {
    model: LOCAL_EMBEDDING_MODEL_ID,
    dims: 384,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) {
        return [];
      }
      const output = await pipe(texts, { pooling: "mean", normalize: true });
      return tensorToRowVectors(output);
    },
  };
}
```

- [ ] **Step 4: Exclude the shim**

Add to `scripts/coverage-floor/exclusions.ts` (near `embedding-worker.ts`):

```typescript
  // The @xenova/transformers dynamic-import boundary — onnxruntime-node cannot
  // load under `bun test`. model.ts is unit-tested by mocking this shim's path.
  { kind: "exact", path: "packages/gateway/src/embedding/load-feature-extraction-pipeline.ts" },
```

Append `,packages/gateway/src/embedding/load-feature-extraction-pipeline.ts` to `sonar.coverage.exclusions` (line 65). Run `bun run audit:exclusion-parity` → exit 0.

- [ ] **Step 5: Rewrite `model.test.ts` to mock the shim path**

```typescript
/**
 * model.ts coverage via the load-feature-extraction-pipeline shim mock.
 * We mock the SHIM path (not model.ts), so we don't collide with
 * create-routing-runtime.test.ts's process-global mock.module of model.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

import { LOCAL_EMBEDDING_MODEL_ID, MINIMUM_MODEL_VERSION } from "./model.ts";

const SHIM = resolve(import.meta.dir, "load-feature-extraction-pipeline.ts");
const realShim = await import(SHIM);

type FakeTensor = { data: Float32Array; dims: readonly number[] };
let fakeTensor: FakeTensor;
let pipeCalls: Array<{ texts: string[]; options: unknown }>;
let lastCacheDir: string | undefined;

beforeEach(() => {
  pipeCalls = [];
  lastCacheDir = undefined;
  fakeTensor = { data: new Float32Array([0.5, 0.25]), dims: [1, 2] };
  mock.module(SHIM, () => ({
    loadFeatureExtractionPipeline: async (cacheDir: string) => {
      lastCacheDir = cacheDir;
      return async (texts: string[], options: unknown) => {
        pipeCalls.push({ texts, options });
        return fakeTensor;
      };
    },
  }));
});
afterEach(() => {
  delete process.env["NIMBUS_EMBEDDING_MODEL_DIR"];
});
afterAll(() => {
  mock.module(SHIM, () => realShim); // restore for sibling files in this process
});

describe("model.ts constants", () => {
  test("LOCAL_EMBEDDING_MODEL_ID and MINIMUM_MODEL_VERSION", () => {
    expect(LOCAL_EMBEDDING_MODEL_ID).toBe("all-MiniLM-L6-v2");
    expect(MINIMUM_MODEL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("createLocalEmbedder", () => {
  test("uses options.cacheDir and embeds rows", async () => {
    const { createLocalEmbedder } = await import("./model.ts");
    const e = await createLocalEmbedder({ cacheDir: "/tmp/cache" });
    expect(e.model).toBe("all-MiniLM-L6-v2");
    expect(e.dims).toBe(384);
    expect(lastCacheDir).toBe("/tmp/cache");

    expect(await e.embed([])).toEqual([]);
    expect(pipeCalls.length).toBe(0);

    const out = await e.embed(["hi"]);
    expect(out.length).toBe(1);
    expect(Array.from(out[0] ?? [])).toEqual([0.5, 0.25]);
    expect(pipeCalls.at(-1)?.options).toEqual({ pooling: "mean", normalize: true });
  });

  test("NIMBUS_EMBEDDING_MODEL_DIR overrides the cache dir", async () => {
    process.env["NIMBUS_EMBEDDING_MODEL_DIR"] = "/override/dir";
    const { createLocalEmbedder } = await import("./model.ts");
    await createLocalEmbedder({ cacheDir: "/tmp/cache" });
    expect(lastCacheDir).toBe("/override/dir");
  });

  test("tensorToRowVectors throws on a rank-1 tensor", async () => {
    fakeTensor = { data: new Float32Array([1, 2]), dims: [2] }; // rank 1
    const { createLocalEmbedder } = await import("./model.ts");
    const e = await createLocalEmbedder({ cacheDir: "/tmp/cache" });
    await expect(e.embed(["x"])).rejects.toThrow(/Unexpected embedding tensor rank/);
  });
});
```

- [ ] **Step 6: Run model test in isolation AND with the embedding suite**

Run: `cd packages/gateway && bun test src/embedding/model.test.ts`
Expected: PASS.
Run: `cd packages/gateway && bun test src/embedding/` (the whole embedding dir, to confirm no `mock.module` collision regression with `create-routing-runtime.test.ts`).
Expected: PASS.
Run: `cd packages/gateway && bun test --coverage 2>&1 | grep "embedding/model.ts"`
Expected: `model.ts` ≥ 80% (projected ≥90%).

- [ ] **Step 7: Typecheck (signature unchanged at call sites)**

Run: `bun run typecheck`
Expected: exit 0 (the five `createLocalEmbedder` call sites compile unchanged).

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/embedding/load-feature-extraction-pipeline.ts packages/gateway/src/embedding/model.ts packages/gateway/src/embedding/model.test.ts scripts/coverage-floor/exclusions.ts sonar-project.properties
git commit -m "test(embedding): sibling-shim DI for model.ts coverage

Extracts the @xenova/transformers boundary into an excluded shim and mocks
its path (not model.ts), sidestepping the process-global mock.module
collision. createLocalEmbedder signature unchanged.
baseline raised-entries dropped only in Task 7."
```

---

## Task 7: Closeout — drop raised entries + docs + status row

**Files:**
- Modify: `docs/structure-audit/coverage-baseline.json`
- Modify: `CLAUDE.md`, `GEMINI.md`
- Add: this spec + plan + review docs (if not already committed on the branch)

- [ ] **Step 1: Build merged lcov + run the floor gate (current state)**

Run: `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor`
Expected: the gate reports the 17-entry baseline; the 7 raised files should now show `must_remove` violations (coverage ≥ 80% but still baselined). If any of the 7 is **below** 80% on this (local) run, note it — but **CI Linux is authoritative**: do not drop a file the local run shows <80% unless you have confirmed it is ≥80% on a Linux runner. For `ipc-transport.ts` specifically, if it is <80% even on Linux, leave its baseline entry at a **raised watermark** (update its `min_coverage_pct` to the measured value) instead of removing it.

- [ ] **Step 2: Remove the 7 raised entries from the baseline (hand-edited)**

Delete these keys from `docs/structure-audit/coverage-baseline.json` (only those confirmed ≥80% on CI Linux):

```
packages/client/src/ipc-transport.ts
packages/client/src/mock-client.ts
packages/client/src/nimbus-client.ts
packages/sdk/src/crypto/verify-signature.ts
packages/sdk/src/ipc/ndjson-line-reader.ts
packages/mcp-connectors/jenkins/src/jenkins-api.ts
packages/gateway/src/embedding/model.ts
```

The baseline should now contain exactly **10 entries** — the CLI deep cuts:
`commands/{connector,doctor,extension,repl,serve,start,test,tui,update}` + `lib/gateway-process.ts`.

Do **not** run `update-baseline` — hand-edit only (guardrail 2).

- [ ] **Step 3: Re-run the floor gate to confirm green**

Run: `bun run audit:coverage-floor` (lcov already built in Step 1)
Expected: `coverage-floor: ok (10 baselined files; … source files scanned)`, exit 0.

- [ ] **Step 4: Add the Phase 7 status row to CLAUDE.md + GEMINI.md**

In the coverage-floor program status line/row in both files, record: `Phase 7 ✅ — packages + closeout (baseline 51 → 10; only CLI deep cuts remain, Phase 8)`. Match the exact format of the existing Phase 6 row; if a merge from `origin/main` later conflicts here, keep both the Phase 7 row and any new rows.

- [ ] **Step 5: Run the full local gate suite**

Run: `bun run lint && bun run typecheck && bun run audit:exclusion-parity && bun run audit:invariants`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add docs/structure-audit/coverage-baseline.json CLAUDE.md GEMINI.md docs/superpowers/specs/2026-05-25-coverage-floor-phase-7-design.md docs/superpowers/plans/2026-05-25-coverage-floor-phase-7.md docs/superpowers/plans/2026-05-25-coverage-floor-phase-7-review.md
git commit -m "chore(coverage-floor): drop raised entries + Phase 7 plan + status row

Baseline 17 -> 10. Closes client, SDK, jenkins-api, and embedding/model.ts;
only the 10 CLI deep cuts remain (Phase 8).
baseline edits hand-curated against CI Linux; update-baseline never run."
```

---

## Self-Review

**1. Spec coverage:**
- Tier X exclusions → Task 1 (3 barrels/types) + Task 6 (shim). ✓
- Tier P 31-prune → Task 1. ✓
- Tier S (verify-signature, ndjson) → Task 2. ✓
- Tier C (jenkins-api) → Task 3. ✓
- Tier L (mock-client, nimbus-client, ipc-transport) → Tasks 4–5. ✓
- Tier G (model.ts + shim) → Task 6. ✓
- Baseline 51 → 17 → 10, raised drop in final commit → Tasks 1 + 7. ✓
- Acceptance 1–9 → Task 7 steps 1/3/5 (gates), Task 5/6 watermark-hold note (acc. 9), Task 6 step 7 (acc. 8), Task 5 no-source-change (acc. 7). ✓

**2. Placeholder scan:** No TBD/TODO. Every test step has complete code. The one soft spot — the `flush()` oversize case in Task 2 step 4 — is flagged with an explicit "if still uncovered, do X" instruction rather than left blank.

**3. Type consistency:** `loadFeatureExtractionPipeline(cacheDir: string)` is defined in Task 6 step 2 and consumed in step 3 + mocked in step 5 with the matching signature. `FakeIpc.call(method, params)` matches the `IPCClient.call` shape used by `NimbusClient`. `__resetJenkinsCrumbCacheForTests` is defined in Task 3 step 2 and imported in step 3. `createLocalEmbedder(options: CreateLocalEmbedderOptions)` signature is preserved (Task 6 step 3) and asserted by typecheck (step 7).

**4. Divergence from spec:** Task 5 covers `ipc-transport.ts` with a real unix socket and **no source change** (the spec allowed an "additive seam" but the real-socket approach is strictly safer for the published API). Documented in the spec's Review §2 and here.
