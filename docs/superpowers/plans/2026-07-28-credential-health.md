# Credential Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Nimbus notice that a connector credential is dead, dying, or unverifiable — instead of discovering it when something fails.

**Architecture:** One SQLite table (`credential_health`, V45) written by three sources — a free by-product of every connector sync, a user-declared expiry date, and an explicitly-invoked active probe — and read by `nimbus creds` plus one line in `nimbus doctor`. All three writers share a single classifier so 97 connectors agree on what "authentication failed" means. The feature never writes a credential.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:sqlite`, Biome, `bun test`.

**Spec:** [`../specs/2026-07-28-credential-health-design.md`](../specs/2026-07-28-credential-health-design.md) · review applied in [`-review-response.md`](../specs/2026-07-28-credential-health-design-review-response.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **All SQLite writes go through `dbRun` / `dbExec` / `dbStmtRun`** from `packages/gateway/src/db/write.ts`. Raw `db.run()` fails the static check D12 (invariant I14). Identifiers via `escapeIdentifier`; values always bound parameters.
- **This feature never writes a credential.** No call to `vault.set` / `vault.delete` anywhere in it. Those are in the HITL frozen set (`packages/gateway/src/engine/executor.ts:107-108`, I2/I4).
- **No secret value may reach the database, a log, or IPC.** `detail` is redacted via `redactAuditPayload` from `packages/gateway/src/audit/format-audit-payload.ts:68`, always as the **last** transformation before storage.
- **Migrations are forward-only and append-only.** Never edit an existing step.
- Cross-platform: build paths with `path.join()`, never hardcoded separators.
- Every new source file gets a sibling `*.test.ts`, matching `packages/gateway/src/egress/`.
- Run `bun run lint` and `bun run typecheck` before every commit.
- **Work on a `dev/<you>/<topic>` branch — never `main` or `develop`.** Verify with
  `git rev-parse --abbrev-ref HEAD` before the first commit.
- **Run `bun run preflight:fast` before pushing**, and the full `bun run preflight`
  when logic or tests changed. `test:ci` is NOT the full gate set. The per-task
  commit steps below show `lint`/`typecheck` only because those are the fast
  inner loop; they do not replace preflight before a PR.

## File Structure

**New subsystem — `packages/gateway/src/credentials/`** (flat files with sibling tests, mirroring `packages/gateway/src/egress/`):

| File | Responsibility |
| --- | --- |
| `credential-keys.ts` | Split each connector's vault keys into *secret* vs *config*. Needed for failure attribution. |
| `classify-auth-outcome.ts` | The single classifier: outcome → `auth-failure` \| `transient` \| `indeterminate` \| `ok`. |
| `extract-error-detail.ts` | HTML/JSON body → short human string; then redact; then cap. |
| `credential-health-store.ts` | All reads/writes of the `credential_health` table. |
| `credential-status.ts` | Pure derivation of display status from a row + now. |
| `credential-probe.ts` | Writer 3 — the generic active probe. |

**Modified:**

| File | Change |
| --- | --- |
| `packages/gateway/src/index/credential-health-v45-sql.ts` | **new** — the `CREATE TABLE` (mirrors `egress-ledger-v44-sql.ts`) |
| `packages/gateway/src/index/migrations/runner.ts:407` | append `simpleStep(44, 45, …)` |
| `packages/gateway/src/index/local-index.ts:265` | `CURRENT_SCHEMA_VERSION` 44 → 45 |
| `packages/gateway/src/connectors/_lib/fetch-outcome.ts` | `http_error` gains `body: string` |
| `packages/gateway/src/ipc/credentials-rpc.ts` | **new** — `credentials.*` read methods |
| `packages/cli/src/commands/creds.ts` | **new** — the `nimbus creds` command |
| `packages/cli/src/index.ts` | register `creds` handler |
| `packages/cli/src/commands/registry.ts` | add `"creds"` to `COMMAND_NAMES` |

**Milestone:** Tasks 1–9 ship a working feature on their own (passive observation + `nimbus creds`). Tasks 10–14 add declared expiry, the active probe, and polish.

---

### Task 1: Split secret keys from config keys

`CONNECTOR_VAULT_SECRET_KEYS` mixes credentials and configuration — `jira: ["jira.api_token", "jira.email", "jira.base_url"]`. Only the first is a credential. Attribution (Task 6) must not mark `jira.base_url` dead.

**Files:**

- Create: `packages/gateway/src/credentials/credential-keys.ts`
- Test: `packages/gateway/src/credentials/credential-keys.test.ts`

**Interfaces:**

- Consumes: `CONNECTOR_VAULT_SECRET_KEYS` from `packages/gateway/src/connectors/connector-secrets-manifest.ts`
- Produces: `isSecretKey(key: string): boolean`, `secretKeysFor(connectorId: string): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/credentials/credential-keys.test.ts
import { describe, expect, test } from "bun:test";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import { isSecretKey, secretKeysFor } from "./credential-keys.ts";

describe("isSecretKey", () => {
  test("credential suffixes are secrets", () => {
    for (const k of [
      "jira.api_token", "github.pat", "zoom.oauth", "linear.api_key",
      "teams.bot_app_password", "wiz.client_secret", "slack.bot_token",
    ]) {
      expect(isSecretKey(k)).toBe(true);
    }
  });

  test("configuration suffixes are not secrets", () => {
    for (const k of [
      "jira.email", "jira.base_url", "gitlab.api_base", "bitbucket.username",
      "wiz.api_url", "gcp.project_id", "aws.default_region",
    ]) {
      expect(isSecretKey(k)).toBe(false);
    }
  });

  test("secretKeysFor filters a connector's declared keys", () => {
    expect(secretKeysFor("jira")).toEqual(["jira.api_token"]);
  });

  test("unknown connector yields no keys", () => {
    expect(secretKeysFor("does-not-exist")).toEqual([]);
  });

  // Guard: the one-dot invariant that makes suffixOf's indexOf split correct.
  // Verified true for all 174 keys as of 2026-07-28. If this ever fails,
  // decide deliberately — do NOT reach for lastIndexOf, which would return
  // only the final segment and mis-classify a dotted name.
  test("every vault key is exactly <connector_id>.<name>", () => {
    const multiDot: string[] = [];
    for (const keys of Object.values(CONNECTOR_VAULT_SECRET_KEYS)) {
      for (const k of keys as string[]) {
        if (k.split(".").length !== 2) multiDot.push(k);
      }
    }
    expect(multiDot).toEqual([]);
  });

  // Guard: every key in the manifest must be classified deliberately.
  test("every manifest key matches a known secret or config suffix", () => {
    const unclassified: string[] = [];
    for (const keys of Object.values(CONNECTOR_VAULT_SECRET_KEYS)) {
      for (const k of keys as string[]) {
        const suffix = k.slice(k.indexOf(".") + 1);
        if (!SECRET_SUFFIXES.has(suffix) && !CONFIG_SUFFIXES.has(suffix)) {
          unclassified.push(k);
        }
      }
    }
    expect(unclassified).toEqual([]);
  });
});

import { CONFIG_SUFFIXES, SECRET_SUFFIXES } from "./credential-keys.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/credentials/credential-keys.test.ts`
Expected: FAIL — `Cannot find module './credential-keys.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/gateway/src/credentials/credential-keys.ts
import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";

/**
 * Vault keys whose value is a credential. A failure to authenticate is
 * attributable to these and never to configuration.
 */
export const SECRET_SUFFIXES: ReadonlySet<string> = new Set([
  "api_key", "api_token", "token", "pat", "oauth", "secret", "client_secret",
  "password", "bot_token", "app_token", "bot_app_password", "access_token",
  "app_password", "private_key", "jwt_secret", "refresh_token", "signing_key",
]);

/** Vault keys that are configuration, not credentials. */
export const CONFIG_SUFFIXES: ReadonlySet<string> = new Set([
  "email", "base_url", "api_base", "api_url", "auth_url", "url", "host",
  "port", "username", "user", "project_id", "default_region", "region",
  "profile", "mailbox", "credentials_json_path", "bot_app_id", "client_id",
  "publisher_id", "workspace", "org", "account", "instance", "tenant",
]);

/**
 * Vault keys are `<connector_id>.<name>`. Split on the FIRST dot, not the last:
 * if a name ever contained a dot (`a.b.c` = connector `a`, name `b.c`),
 * `lastIndexOf` would return `c` and silently mis-classify part of a name as
 * the whole name. A guard test below pins the one-dot invariant, so a
 * multi-dot key forces a deliberate decision rather than a silent misread.
 */
function suffixOf(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(dot + 1);
}

/** True when the vault key holds a credential rather than configuration. */
export function isSecretKey(key: string): boolean {
  return SECRET_SUFFIXES.has(suffixOf(key));
}

/** The credential (non-config) vault keys a connector declares. */
export function secretKeysFor(connectorId: string): string[] {
  const declared = (CONNECTOR_VAULT_SECRET_KEYS as Record<string, readonly string[] | undefined>)[
    connectorId
  ];
  if (declared === undefined) return [];
  return declared.filter(isSecretKey);
}
```

- [ ] **Step 4: Run the test — expect the classification guard to fail**

Run: `bun test packages/gateway/src/credentials/credential-keys.test.ts`

The last test will list any manifest key matching neither set. **Add each to whichever set is correct** — a `*_id` that identifies rather than authenticates is config; anything that grants access is a secret. Re-run until it passes. Do not delete the guard: it is what forces a deliberate decision when a connector adds a key.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add packages/gateway/src/credentials/
git commit -m "feat(credentials): classify vault keys as secret or config"
```

---

### Task 2: Carry the error body on `FetchOutcome`

The classifier must match provider bodies like `invalid_grant`, but `connectorFetch` currently discards the body on `http_error`, returning only `status` and `bytes`.

**Files:**

- Modify: `packages/gateway/src/connectors/_lib/fetch-outcome.ts`
- Test: `packages/gateway/src/connectors/_lib/fetch-outcome.test.ts`

**Interfaces:**

- Produces: `FetchOutcome` with `{ kind: "http_error"; bytes: number; status: number; body: string }`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/gateway/src/connectors/_lib/fetch-outcome.test.ts
test("http_error carries the response body for classification", async () => {
  const ctx = makeTestSyncContext(); // existing helper in this file
  const fetchFn = async () =>
    new Response('{"error":"invalid_grant"}', { status: 400 });
  const out = await connectorFetch(ctx, "github", "https://x.test", {}, fetchFn);
  expect(out.kind).toBe("http_error");
  if (out.kind !== "http_error") throw new Error("unreachable");
  expect(out.status).toBe(400);
  expect(out.body).toContain("invalid_grant");
});

test("http_error body is capped so a large HTML page cannot bloat memory", async () => {
  const ctx = makeTestSyncContext();
  const huge = `<html><body>${"x".repeat(50_000)}</body></html>`;
  const fetchFn = async () => new Response(huge, { status: 502 });
  const out = await connectorFetch(ctx, "github", "https://x.test", {}, fetchFn);
  if (out.kind !== "http_error") throw new Error("unreachable");
  expect(out.body.length).toBeLessThanOrEqual(4096);
});
```

If `makeTestSyncContext` does not exist in that file, read the file's existing tests and reuse whatever context helper they use.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/_lib/fetch-outcome.test.ts`
Expected: FAIL — `body` is not a property of the outcome.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/connectors/_lib/fetch-outcome.ts
/** Upper bound on the retained error body. Enough for any JSON error envelope
 *  or an HTML <title>; small enough that a 50 MB proxy page cannot bloat us. */
const MAX_ERROR_BODY = 4096;

export type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number; status: number; body: string }
  | { kind: "parse_error"; bytes: number; body: string };
```

`parse_error` carries a body too. It means "HTTP 2xx but not JSON", which is
*usually* a healthy credential and a schema surprise — but a well-known
anti-pattern is answering an expired session with **200 plus an HTML login
page** instead of 401. Without the body there is no way to tell those apart,
and defaulting to `ok` would manufacture a false green. Task 8 uses the body to
distinguish them.

and in `connectorFetch`, replace the `if (!res.ok)` return with:

```ts
  if (!res.ok) {
    ctx.logger.warn({ serviceId, status: res.status, url }, "connector fetch failed");
    return { kind: "http_error", bytes, status: res.status, body: text.slice(0, MAX_ERROR_BODY) };
  }
```

and change the `parse_error` return in the same function's `catch` to carry the
body as well:

```ts
    return { kind: "parse_error", bytes, body: text.slice(0, MAX_ERROR_BODY) };
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/connectors/_lib/fetch-outcome.test.ts`
Expected: PASS

Then run every consumer, because the type widened:
Run: `bun run typecheck`
Expected: exit 0. Widening a union member with a new required field only breaks *constructors* of that member — fix any other site that builds an `http_error` literal by adding `body`.

- [ ] **Step 5: Commit**

```bash
bun run lint
git add packages/gateway/src/connectors/_lib/
git commit -m "feat(connectors): retain a capped error body on FetchOutcome"
```

---

### Task 3: Extract a human-readable detail from an error body

**Files:**

- Create: `packages/gateway/src/credentials/extract-error-detail.ts`
- Test: `packages/gateway/src/credentials/extract-error-detail.test.ts`

**Interfaces:**

- Consumes: `redactAuditPayload` from `packages/gateway/src/audit/format-audit-payload.ts`
- Produces: `extractErrorDetail(body: string, status: number): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/credentials/extract-error-detail.test.ts
import { describe, expect, test } from "bun:test";
import { extractErrorDetail } from "./extract-error-detail.ts";

describe("extractErrorDetail", () => {
  test("keeps a JSON error envelope", () => {
    const d = extractErrorDetail('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', 400);
    expect(d).toContain("invalid_grant");
  });

  test("uses the <title> of an HTML error page", () => {
    const html = "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>nginx</h1></body></html>";
    expect(extractErrorDetail(html, 502)).toContain("502 Bad Gateway");
  });

  test("falls back when markup has no title", () => {
    expect(extractErrorDetail("<html><body>   </body></html>", 403))
      .toBe("markup error page (HTTP 403)");
  });

  test("extracts a SOAP faultstring", () => {
    const soap = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
      <soap:Body><soap:Fault><faultstring>Invalid credentials supplied</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
    expect(extractErrorDetail(soap, 500)).toContain("Invalid credentials supplied");
  });

  test("strips XML tags rather than storing them raw", () => {
    const xml = '<?xml version="1.0"?><error><code>401</code></error>';
    const d = extractErrorDetail(xml, 401);
    expect(d).not.toContain("<code>");
  });

  // ORDERING: extract -> strip -> redact -> cap. Redaction must run LAST, so a
  // secret hidden in markup cannot be re-introduced by extraction.
  test("a token hidden in an HTML comment never survives", () => {
    const html = `<html><head><title>403 Forbidden</title></head>
      <!-- token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -->
      <body>denied</body></html>`;
    const d = extractErrorDetail(html, 403);
    expect(d).toContain("403 Forbidden");
    expect(d).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });

  test("output is capped at 256 bytes", () => {
    expect(extractErrorDetail("z".repeat(5000), 500).length).toBeLessThanOrEqual(256);
  });

  test("empty body yields a status-only detail", () => {
    expect(extractErrorDetail("", 404)).toBe("HTTP 404");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/credentials/extract-error-detail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/credentials/extract-error-detail.ts
import { redactAuditPayload } from "../audit/format-audit-payload.ts";

const MAX_DETAIL_BYTES = 256;

/**
 * HTML *and* XML/SOAP. On-premise systems (Jenkins plugins, Exchange, older
 * enterprise APIs) answer with `<?xml …>` or a SOAP envelope, which would
 * otherwise be stored raw, tags and all.
 */
function looksLikeMarkup(body: string): boolean {
  const head = body.trimStart().slice(0, 20).toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<?xml") ||
    /^<[a-z]+:[a-z]+/.test(head) || // namespaced root: <soap:Envelope, <ns:Error
    head.startsWith("<error") ||
    head.startsWith("<response")
  );
}

function fromMarkup(body: string, status: number): string {
  // HTML <title>, else a SOAP/XML fault string, else all remaining text.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim();
  if (title !== undefined && title.length > 0) return title;
  const fault = /<(?:\w+:)?(?:faultstring|message|Message|error)[^>]*>([\s\S]*?)<\//.exec(body)?.[1]?.trim();
  if (fault !== undefined && fault.length > 0) return fault;
  const text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : `markup error page (HTTP ${status})`;
}

/**
 * Turn a provider error body into a short, safe, human-readable detail.
 *
 * Order is load-bearing: extract -> strip -> redact -> cap. Redaction runs LAST
 * so that extracting text out of markup cannot surface a secret that redaction
 * had already neutralised.
 */
export function extractErrorDetail(body: string, status: number): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return `HTTP ${status}`;
  const extracted = looksLikeMarkup(trimmed) ? fromMarkup(trimmed, status) : trimmed;
  const redacted = redactAuditPayload(extracted, MAX_DETAIL_BYTES);
  return redacted.slice(0, MAX_DETAIL_BYTES);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/credentials/extract-error-detail.test.ts`
Expected: PASS.

If the HTML-comment test fails, `redactAuditPayload` does not recognise that token shape. Do **not** weaken the test — instead strip comments before redaction (already done above) and confirm; if it still leaks, the redactor needs the pattern and that belongs in `format-audit-payload.ts` with its own test.

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/gateway/src/credentials/
git commit -m "feat(credentials): extract a safe detail from provider error bodies"
```

---

### Task 4: The classifier

The single most important unit. Every writer routes through it so all connectors agree on what "authentication failed" means.

**Files:**

- Create: `packages/gateway/src/credentials/classify-auth-outcome.ts`
- Test: `packages/gateway/src/credentials/classify-auth-outcome.test.ts`

**Interfaces:**

- Consumes: `FetchOutcome` (Task 2)
- Produces: `type AuthClass = "auth-failure" | "transient" | "indeterminate" | "ok"`, `classifyAuthOutcome(outcome: ClassifiableOutcome): AuthClass`, `type ClassifiableOutcome`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/credentials/classify-auth-outcome.test.ts
import { describe, expect, test } from "bun:test";
import { type AuthClass, classifyAuthOutcome } from "./classify-auth-outcome.ts";

const http = (status: number, body = "") => ({ kind: "http" as const, status, body });

describe("classifyAuthOutcome", () => {
  // Real bodies from the 2026-07-28 incident. Not invented fixtures.
  const cases: Array<[string, ReturnType<typeof http> | { kind: "network" } | { kind: "timeout" } | { kind: "ok" }, AuthClass]> = [
    ["google invalid_grant", http(400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}'), "auth-failure"],
    ["google invalid_client", http(401, '{"error":"invalid_client","error_description":"The provided client secret is invalid."}'), "auth-failure"],
    ["amo unknown issuer", http(401, '{"detail":"Unknown JWT iss (issuer)."}'), "auth-failure"],
    ["amo bad signature", http(401, '{"detail":"Error decoding signature."}'), "auth-failure"],
    ["bare 403", http(403), "auth-failure"],
    ["rate limited", http(429), "transient"],
    ["bad gateway", http(502), "transient"],
    ["network error", { kind: "network" }, "transient"],
    ["timeout", { kind: "timeout" }, "transient"],
    ["request timeout status", http(408), "transient"],
    // These four are the regression tests for a false green in the first draft.
    ["schema change", http(400, '{"message":"unknown field \\'limit\\'"}'), "indeterminate"],
    ["not found", http(404), "indeterminate"],
    ["conflict", http(409), "indeterminate"],
    ["unprocessable", http(422), "indeterminate"],
    ["success", { kind: "ok" }, "ok"],
  ];

  for (const [name, outcome, expected] of cases) {
    test(`${name} -> ${expected}`, () => {
      expect(classifyAuthOutcome(outcome)).toBe(expected);
    });
  }

  test("a 400 without a known auth marker is NEVER ok", () => {
    // The first draft of the spec classified this 'ok', which would have
    // reported a structurally broken probe as a healthy credential.
    expect(classifyAuthOutcome(http(400, "totally unrelated"))).not.toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/credentials/classify-auth-outcome.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/credentials/classify-auth-outcome.ts

/** How an attempt to use a credential turned out. */
export type AuthClass = "auth-failure" | "transient" | "indeterminate" | "ok";

/** Transport-agnostic view of an attempt, so sync and probe share one classifier. */
export type ClassifiableOutcome =
  | { kind: "ok" }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "http"; status: number; body: string };

/**
 * Provider bodies that mean "your credential was rejected" even when the status
 * code alone would not say so (Google answers invalid_grant with HTTP 400).
 */
const AUTH_REJECTION_MARKERS: readonly string[] = [
  "invalid_grant",
  "invalid_client",
  "invalid_token",
  "unknown jwt iss",
  "error decoding signature",
  "expired or revoked",
  "unauthorized",
  "authentication failed",
];

function bodyIndicatesAuthRejection(body: string): boolean {
  const hay = body.toLowerCase();
  return AUTH_REJECTION_MARKERS.some((m) => hay.includes(m));
}

/**
 * Classify one attempt.
 *
 * `ok` means HTTP 2xx — never "anything left over". An earlier design defined
 * it as "anything that returned data", which classified a 400 from a changed
 * request schema as a healthy credential: a false green.
 */
export function classifyAuthOutcome(outcome: ClassifiableOutcome): AuthClass {
  switch (outcome.kind) {
    case "ok":
      return "ok";
    case "network":
    case "timeout":
      return "transient";
    case "http": {
      const { status, body } = outcome;
      if (status >= 200 && status < 300) return "ok";
      if (status === 401 || status === 403) return "auth-failure";
      if (status === 408 || status === 429 || status >= 500) return "transient";
      if (bodyIndicatesAuthRejection(body)) return "auth-failure";
      return "indeterminate";
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/credentials/classify-auth-outcome.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Red-prove the four load-bearing guards**

This repo's convention is that a guard which has never failed is a guard nobody has verified. One at a time:

1. Change `if (status === 408 || status === 429 || status >= 500) return "transient";` to `return "auth-failure";`. Run the tests. The `rate limited`, `bad gateway` and `request timeout status` cases **must** fail. Revert.
2. Change the final `return "indeterminate";` to `return "ok";`. Run the tests. The four indeterminate cases **and** the explicit "never ok" test **must** fail. Revert.

Run after each: `bun test packages/gateway/src/credentials/classify-auth-outcome.test.ts`

- [ ] **Step 6: Commit**

```bash
bun run lint && bun run typecheck
git add packages/gateway/src/credentials/
git commit -m "feat(credentials): single auth-outcome classifier shared by all connectors"
```

---

### Task 5: The V45 migration

**Files:**

- Create: `packages/gateway/src/index/credential-health-v45-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import + one `simpleStep`)
- Modify: `packages/gateway/src/index/local-index.ts:265` (44 → 45)
- Test: `packages/gateway/src/index/migrations/runner-v45.test.ts`

**Interfaces:**

- Produces: table `credential_health`; `CURRENT_SCHEMA_VERSION === 45`

- [ ] **Step 1: Write the failing test**

Read `packages/gateway/src/index/migrations/runner-v44.test.ts` first and mirror its structure exactly — it is the closest precedent (a new table at the head of the chain).

```ts
// packages/gateway/src/index/migrations/runner-v45.test.ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { dbRun } from "../../db/write.ts";

// Use whatever helper runner-v44.test.ts uses to build a migrated DB.
import { migrateToCurrent } from "./runner.ts"; // adjust to the real export name

describe("v45 — credential_health", () => {
  test("CURRENT_SCHEMA_VERSION is 45", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(45);
  });

  test("the table exists with the expected columns", () => {
    const db = new Database(":memory:");
    migrateToCurrent(db);
    const cols = db
      .query("PRAGMA table_info(credential_health)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "connector_id", "detail", "expires_at", "expiry_source",
      "last_attempt_at", "last_checked_at", "last_ok_at",
      "observed_status", "observed_via", "vault_key",
    ]);
  });

  test("vault_key is the primary key", () => {
    const db = new Database(":memory:");
    migrateToCurrent(db);
    // dbRun, not raw db.run() — the D12 static check forbids raw writes, and
    // this plan's own Global Constraints say so. Tests are not exempt.
    dbRun(db, "INSERT INTO credential_health (vault_key, connector_id, observed_status, observed_via) VALUES (?,?,?,?)",
      ["a.token", "a", "ok", "sync"]);
    expect(() =>
      dbRun(db, "INSERT INTO credential_health (vault_key, connector_id, observed_status, observed_via) VALUES (?,?,?,?)",
        ["a.token", "a", "dead", "sync"]),
    ).toThrow();
  });

  test("connector_id is indexed for the roll-up read", () => {
    const db = new Database(":memory:");
    migrateToCurrent(db);
    const idx = db.query("PRAGMA index_list(credential_health)").all() as Array<{ name: string }>;
    expect(idx.some((i) => i.name.includes("connector"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner-v45.test.ts`
Expected: FAIL — `CURRENT_SCHEMA_VERSION` is 44 and the table does not exist.

- [ ] **Step 3: Write the SQL**

```ts
// packages/gateway/src/index/credential-health-v45-sql.ts
/**
 * V45 — credential_health.
 *
 * One row per vault key that holds a credential. Stores health metadata only:
 * the key NAME, never its value. `detail` is redacted before insert.
 */
export const CREDENTIAL_HEALTH_V45_SQL = `
CREATE TABLE IF NOT EXISTS credential_health (
  vault_key       TEXT PRIMARY KEY,
  connector_id    TEXT NOT NULL,
  observed_status TEXT NOT NULL CHECK (observed_status IN ('ok','dead','unknown')),
  observed_via    TEXT NOT NULL CHECK (observed_via IN ('sync','probe')),
  last_checked_at INTEGER,
  last_attempt_at INTEGER,
  last_ok_at      INTEGER,
  detail          TEXT,
  expires_at      INTEGER,
  expiry_source   TEXT CHECK (expiry_source IN ('provider','declared'))
);
CREATE INDEX IF NOT EXISTS idx_credential_health_connector
  ON credential_health (connector_id);
`;
```

- [ ] **Step 4: Register the step and bump the version**

In `packages/gateway/src/index/migrations/runner.ts`, add next to the other imports:

```ts
import { CREDENTIAL_HEALTH_V45_SQL } from "../credential-health-v45-sql.ts";
```

and append **after** the existing V44 line (never edit it):

```ts
  simpleStep(44, 45, "credential_health (credential liveness v45)", CREDENTIAL_HEALTH_V45_SQL),
```

In `packages/gateway/src/index/local-index.ts:265`:

```ts
export const CURRENT_SCHEMA_VERSION = 45;
```

- [ ] **Step 5: Run the tests**

```bash
bun test packages/gateway/src/index/migrations/
```

Expected: PASS, including the pre-existing v44 and runner tests.

- [ ] **Step 6: Commit**

```bash
bun run lint && bun run typecheck
git add packages/gateway/src/index/
git commit -m "feat(db): V45 credential_health table"
```

---

### Task 6: The store

**Files:**

- Create: `packages/gateway/src/credentials/credential-health-store.ts`
- Test: `packages/gateway/src/credentials/credential-health-store.test.ts`

**Interfaces:**

- Consumes: `dbRun` from `packages/gateway/src/db/write.ts`; `secretKeysFor` (Task 1)
- Produces:
  - `type CredentialHealthRow = { vaultKey: string; connectorId: string; observedStatus: "ok" | "dead" | "unknown"; observedVia: "sync" | "probe"; lastCheckedAt: number | null; lastOkAt: number | null; detail: string | null; expiresAt: number | null; expirySource: "provider" | "declared" | null }`
  - `recordObservation(db, o: { connectorId: string; vaultKeys: string[]; status: "ok" | "dead" | "unknown"; via: "sync" | "probe"; now: number; detail?: string; expiresAt?: number }): void`
  - `recordTransient(db, connectorId: string, vaultKeys: string[], now: number): void`
  - `setDeclaredExpiry(db, vaultKey: string, connectorId: string, expiresAt: number): void`
  - `listHealth(db): CredentialHealthRow[]`
  - `deleteHealthForConnector(db, connectorId: string): void`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/credentials/credential-health-store.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CREDENTIAL_HEALTH_V45_SQL } from "../index/credential-health-v45-sql.ts";
import {
  deleteHealthForConnector, listHealth, recordObservation,
  recordTransient, setDeclaredExpiry,
} from "./credential-health-store.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(CREDENTIAL_HEALTH_V45_SQL);
});

describe("credential health store", () => {
  test("records a successful observation", () => {
    recordObservation(db, {
      connectorId: "zoom", vaultKeys: ["zoom.oauth"], status: "ok", via: "sync", now: 1000,
    });
    const [row] = listHealth(db);
    expect(row.vaultKey).toBe("zoom.oauth");
    expect(row.observedStatus).toBe("ok");
    expect(row.lastOkAt).toBe(1000);
  });

  test("a failure marks every supplied key and shares one detail", () => {
    recordObservation(db, {
      connectorId: "jira", vaultKeys: ["jira.api_token", "jira.other_secret"],
      status: "dead", via: "sync", now: 2000, detail: "HTTP 401",
    });
    const rows = listHealth(db).sort((a, b) => a.vaultKey.localeCompare(b.vaultKey));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.observedStatus === "dead")).toBe(true);
    expect(rows.every((r) => r.detail === "HTTP 401")).toBe(true);
  });

  test("last_ok_at survives a later failure", () => {
    recordObservation(db, { connectorId: "z", vaultKeys: ["z.token"], status: "ok", via: "sync", now: 100 });
    recordObservation(db, { connectorId: "z", vaultKeys: ["z.token"], status: "dead", via: "sync", now: 200, detail: "nope" });
    const [row] = listHealth(db);
    expect(row.observedStatus).toBe("dead");
    expect(row.lastOkAt).toBe(100); // preserved — "dead since" needs it
    expect(row.lastCheckedAt).toBe(200);
  });

  test("a transient failure moves last_checked_at but NOT status", () => {
    recordObservation(db, { connectorId: "z", vaultKeys: ["z.token"], status: "ok", via: "sync", now: 100 });
    recordTransient(db, "z", ["z.token"], 300);
    const [row] = listHealth(db);
    expect(row.observedStatus).toBe("ok"); // a network blip is not death
    expect(row.lastCheckedAt).toBe(300);
  });

  test("declared expiry can be set before any observation exists", () => {
    setDeclaredExpiry(db, "github.pat", "github", 999);
    const [row] = listHealth(db);
    expect(row.expiresAt).toBe(999);
    expect(row.expirySource).toBe("declared");
    expect(row.observedStatus).toBe("unknown");
  });

  test("declared expiry survives a later observation", () => {
    setDeclaredExpiry(db, "github.pat", "github", 999);
    recordObservation(db, { connectorId: "github", vaultKeys: ["github.pat"], status: "ok", via: "sync", now: 100 });
    const [row] = listHealth(db);
    expect(row.expiresAt).toBe(999);
    expect(row.expirySource).toBe("declared");
  });

  test("removing a connector removes its health rows", () => {
    recordObservation(db, { connectorId: "a", vaultKeys: ["a.token"], status: "ok", via: "sync", now: 1 });
    recordObservation(db, { connectorId: "b", vaultKeys: ["b.token"], status: "ok", via: "sync", now: 1 });
    deleteHealthForConnector(db, "a");
    expect(listHealth(db).map((r) => r.connectorId)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/credentials/credential-health-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/credentials/credential-health-store.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export type ObservedStatus = "ok" | "dead" | "unknown";
export type ObservedVia = "sync" | "probe";

export interface CredentialHealthRow {
  vaultKey: string;
  connectorId: string;
  observedStatus: ObservedStatus;
  observedVia: ObservedVia;
  lastCheckedAt: number | null;
  lastOkAt: number | null;
  detail: string | null;
  expiresAt: number | null;
  expirySource: "provider" | "declared" | null;
}

interface DbRow {
  vault_key: string;
  connector_id: string;
  observed_status: ObservedStatus;
  observed_via: ObservedVia;
  last_checked_at: number | null;
  last_ok_at: number | null;
  detail: string | null;
  expires_at: number | null;
  expiry_source: "provider" | "declared" | null;
}

export interface Observation {
  connectorId: string;
  vaultKeys: string[];
  status: ObservedStatus;
  via: ObservedVia;
  now: number;
  detail?: string;
  expiresAt?: number;
}

/**
 * Upsert one observation across every supplied key.
 *
 * `last_ok_at` is only advanced on success and is never cleared, so a later
 * failure can still render "dead since <when>". A provider-supplied expiry
 * never overwrites a user-declared one.
 */
export function recordObservation(db: Database, o: Observation): void {
  for (const key of o.vaultKeys) {
    dbRun(
      db,
      `INSERT INTO credential_health
         (vault_key, connector_id, observed_status, observed_via,
          last_checked_at, last_attempt_at, last_ok_at, detail, expires_at, expiry_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vault_key) DO UPDATE SET
         connector_id    = excluded.connector_id,
         observed_status = excluded.observed_status,
         observed_via    = excluded.observed_via,
         last_checked_at = excluded.last_checked_at,
         last_attempt_at = excluded.last_attempt_at,
         last_ok_at      = MAX(COALESCE(excluded.last_ok_at, 0),
                               COALESCE(credential_health.last_ok_at, 0)),
         detail          = excluded.detail,
         expires_at      = CASE WHEN credential_health.expiry_source = 'declared'
                                THEN credential_health.expires_at
                                ELSE COALESCE(excluded.expires_at, credential_health.expires_at) END,
         expiry_source   = CASE WHEN credential_health.expiry_source = 'declared'
                                THEN 'declared'
                                ELSE COALESCE(excluded.expiry_source, credential_health.expiry_source) END`,
      [
        key,
        o.connectorId,
        o.status,
        o.via,
        o.now,
        o.now,
        o.status === "ok" ? o.now : null,
        o.detail ?? null,
        o.expiresAt ?? null,
        o.expiresAt === undefined ? null : "provider",
      ],
    );
  }
}

/**
 * A transient failure proves nothing about the credential.
 *
 * It therefore advances `last_attempt_at` and NOT `last_checked_at`. Advancing
 * the latter would make a credential that has been unreachable for weeks keep
 * reporting a fresh OK, because the reader's staleness degradation keys off
 * `last_checked_at`. Separate columns are what keep that guard armed.
 */
export function recordTransient(
  db: Database,
  connectorId: string,
  vaultKeys: string[],
  now: number,
  via: ObservedVia,
): void {
  for (const key of vaultKeys) {
    dbRun(
      db,
      `INSERT INTO credential_health
         (vault_key, connector_id, observed_status, observed_via, last_attempt_at)
       VALUES (?, ?, 'unknown', ?, ?)
       ON CONFLICT(vault_key) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`,
      [key, connectorId, via, now],
    );
  }
}

/** Record a deadline the user knows about. Pure metadata; touches no secret. */
export function setDeclaredExpiry(
  db: Database,
  vaultKey: string,
  connectorId: string,
  expiresAt: number,
): void {
  dbRun(
    db,
    `INSERT INTO credential_health
       (vault_key, connector_id, observed_status, observed_via, expires_at, expiry_source)
     VALUES (?, ?, 'unknown', 'sync', ?, 'declared')
     ON CONFLICT(vault_key) DO UPDATE SET
       expires_at = excluded.expires_at,
       expiry_source = 'declared'`,
    [vaultKey, connectorId, expiresAt],
  );
}

export function listHealth(db: Database): CredentialHealthRow[] {
  const rows = db
    .query(
      `SELECT vault_key, connector_id, observed_status, observed_via,
              last_checked_at, last_ok_at, detail, expires_at, expiry_source
         FROM credential_health
        ORDER BY connector_id, vault_key`,
    )
    .all() as DbRow[];
  return rows.map((r) => ({
    vaultKey: r.vault_key,
    connectorId: r.connector_id,
    observedStatus: r.observed_status,
    observedVia: r.observed_via,
    lastCheckedAt: r.last_checked_at,
    lastOkAt: r.last_ok_at,
    detail: r.detail,
    expiresAt: r.expires_at,
    expirySource: r.expiry_source,
  }));
}

/** Called from connector removal so no orphaned rows survive. */
export function deleteHealthForConnector(db: Database, connectorId: string): void {
  dbRun(db, "DELETE FROM credential_health WHERE connector_id = ?", [connectorId]);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/credentials/credential-health-store.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/gateway/src/credentials/
git commit -m "feat(credentials): credential_health store"
```

---

### Task 7: Status derivation

**Files:**

- Create: `packages/gateway/src/credentials/credential-status.ts`
- Test: `packages/gateway/src/credentials/credential-status.test.ts`

**Interfaces:**

- Consumes: `CredentialHealthRow` (Task 6)
- Produces: `type DisplayStatus = "OK" | "DEAD" | "EXPIRED" | "EXPIRING" | "UNKNOWN"`, `deriveStatus(row, now, opts?: { warnBeforeExpiryMs?: number; staleAfterMs?: number }): { status: DisplayStatus; note: string }`, `DEFAULT_WARN_BEFORE_EXPIRY_MS`, `DEFAULT_STALE_AFTER_MS`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/credentials/credential-status.test.ts
import { describe, expect, test } from "bun:test";
import type { CredentialHealthRow } from "./credential-health-store.ts";
import { deriveStatus } from "./credential-status.ts";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

const row = (o: Partial<CredentialHealthRow> = {}): CredentialHealthRow => ({
  vaultKey: "x.token", connectorId: "x", observedStatus: "ok", observedVia: "sync",
  lastCheckedAt: NOW, lastOkAt: NOW, detail: null, expiresAt: null, expirySource: null, ...o,
});

describe("deriveStatus", () => {
  test("fresh success is OK", () => {
    expect(deriveStatus(row(), NOW).status).toBe("OK");
  });

  test("dead is DEAD and reports since when", () => {
    const r = deriveStatus(row({ observedStatus: "dead", lastOkAt: NOW - 3 * DAY }), NOW);
    expect(r.status).toBe("DEAD");
    expect(r.note).toContain("3");
  });

  test("never observed is UNKNOWN", () => {
    expect(deriveStatus(row({ observedStatus: "unknown", lastCheckedAt: null, lastOkAt: null }), NOW).status)
      .toBe("UNKNOWN");
  });

  test("a stale ok degrades to UNKNOWN — absence of evidence is not evidence", () => {
    const r = deriveStatus(row({ lastCheckedAt: NOW - 12 * DAY, lastOkAt: NOW - 12 * DAY }), NOW);
    expect(r.status).toBe("UNKNOWN");
    expect(r.note).toContain("stale");
  });

  test("expiry inside the warn window is EXPIRING", () => {
    const r = deriveStatus(row({ expiresAt: NOW + 6 * DAY, expirySource: "declared" }), NOW);
    expect(r.status).toBe("EXPIRING");
    expect(r.note).toContain("6");
  });

  test("expiry in the past is EXPIRED", () => {
    expect(deriveStatus(row({ expiresAt: NOW - DAY, lastOkAt: NOW - 5 * DAY }), NOW).status)
      .toBe("EXPIRED");
  });

  // Salesforce synthesises a 30-minute expiry because the API omits expires_in.
  // A working credential must not be reported EXPIRED because metadata lied.
  test("a more recent success beats a stale expires_at", () => {
    const r = deriveStatus(row({ expiresAt: NOW - DAY, lastOkAt: NOW - 60_000 }), NOW);
    expect(r.status).toBe("OK");
  });

  test("dead outranks expiring", () => {
    expect(deriveStatus(row({ observedStatus: "dead", expiresAt: NOW + DAY }), NOW).status)
      .toBe("DEAD");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/credentials/credential-status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/credentials/credential-status.ts
import type { CredentialHealthRow } from "./credential-health-store.ts";

const DAY_MS = 86_400_000;

/** Console-trip credentials need more than a week's notice to be actionable. */
export const DEFAULT_WARN_BEFORE_EXPIRY_MS = 30 * DAY_MS;
/** Longer than this without an observation and there is no current evidence. */
export const DEFAULT_STALE_AFTER_MS = 7 * DAY_MS;

export type DisplayStatus = "OK" | "DEAD" | "EXPIRED" | "EXPIRING" | "UNKNOWN";

export interface DerivedStatus {
  status: DisplayStatus;
  note: string;
}

const days = (ms: number): number => Math.max(0, Math.round(ms / DAY_MS));

/**
 * Derive display status fresh on every read. Nothing here is stored: "expiring
 * in 6 days" is a function of now, and persisting it would go stale the moment
 * nothing runs — the failure this feature exists to prevent.
 */
export function deriveStatus(
  row: CredentialHealthRow,
  now: number,
  opts: { warnBeforeExpiryMs?: number; staleAfterMs?: number } = {},
): DerivedStatus {
  const warnMs = opts.warnBeforeExpiryMs ?? DEFAULT_WARN_BEFORE_EXPIRY_MS;
  const staleMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  if (row.observedStatus === "dead") {
    const note =
      row.lastOkAt === null
        ? (row.detail ?? "never worked")
        : `dead — last worked ${days(now - row.lastOkAt)}d ago`;
    return { status: "DEAD", note };
  }

  if (row.expiresAt !== null) {
    // Observation beats metadata: providers synthesise expiries that are wrong.
    const observedAfterExpiry = row.lastOkAt !== null && row.lastOkAt > row.expiresAt;
    if (!observedAfterExpiry) {
      if (row.expiresAt <= now) return { status: "EXPIRED", note: "expired" };
      if (row.expiresAt - now <= warnMs) {
        return { status: "EXPIRING", note: `expires in ${days(row.expiresAt - now)}d` };
      }
    }
  }

  if (row.lastCheckedAt === null) return { status: "UNKNOWN", note: "not checked yet" };

  if (now - row.lastCheckedAt > staleMs) {
    return { status: "UNKNOWN", note: `stale — last checked ${days(now - row.lastCheckedAt)}d ago` };
  }

  if (row.observedStatus === "ok") return { status: "OK", note: "" };
  return { status: "UNKNOWN", note: row.detail ?? "unverified" };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/credentials/credential-status.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Red-prove the staleness guard**

Delete the `now - row.lastCheckedAt > staleMs` block. Run the tests — the "stale ok degrades" test **must** fail. Restore it.

- [ ] **Step 6: Commit**

```bash
bun run lint && bun run typecheck
git add packages/gateway/src/credentials/
git commit -m "feat(credentials): derive display status from a health row"
```

---

### Task 8: Writer 1 — record health from every sync

**Files:**

- Modify: the connector sync driver that calls each connector's `sync()` and handles its errors. Find it with:
  `rg -n "itemsUpserted" packages/gateway/src/sync --glob '!*.test.ts'`
  The driver is the file that consumes `SyncResult` (`packages/gateway/src/sync/types.ts:50`) in a `try`/`catch`.
- Test: a sibling `*.test.ts` of that driver.

**Interfaces:**

- Consumes: `classifyAuthOutcome`, `extractErrorDetail`, `recordObservation`, `recordTransient`, `secretKeysFor`
- Produces: no new exports — a side effect on every sync

- [ ] **Step 1: Write the failing test**

```ts
// in the sync driver's sibling test file
import { CREDENTIAL_HEALTH_V45_SQL } from "../index/credential-health-v45-sql.ts";
import { listHealth } from "../credentials/credential-health-store.ts";

test("a successful sync records ok for the connector's secret keys", async () => {
  const db = makeTestDb(); // reuse the driver test's existing DB helper
  db.exec(CREDENTIAL_HEALTH_V45_SQL);
  await runSyncForTest(db, "jira", { ok: true });
  const rows = listHealth(db);
  expect(rows.map((r) => r.vaultKey)).toEqual(["jira.api_token"]); // NOT .email / .base_url
  expect(rows[0].observedStatus).toBe("ok");
});

test("a 401 marks the connector's secret keys dead, config keys untouched", async () => {
  const db = makeTestDb();
  db.exec(CREDENTIAL_HEALTH_V45_SQL);
  await runSyncForTest(db, "jira", { httpStatus: 401, body: "" });
  const rows = listHealth(db);
  expect(rows.every((r) => r.observedStatus === "dead")).toBe(true);
  expect(rows.map((r) => r.vaultKey)).not.toContain("jira.base_url");
});

test("a 502 does NOT mark the credential dead", async () => {
  const db = makeTestDb();
  db.exec(CREDENTIAL_HEALTH_V45_SQL);
  await runSyncForTest(db, "jira", { ok: true });
  await runSyncForTest(db, "jira", { httpStatus: 502, body: "" });
  expect(listHealth(db)[0].observedStatus).toBe("ok");
});
```

Adapt `makeTestDb` / `runSyncForTest` to whatever the driver's existing tests use. Do not invent a parallel harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test <the driver's test file>`
Expected: FAIL — no rows recorded.

- [ ] **Step 3: Implement**

In the sync driver, after a sync attempt resolves or throws:

```ts
import { classifyAuthOutcome, type ClassifiableOutcome } from "../credentials/classify-auth-outcome.ts";
import { extractErrorDetail } from "../credentials/extract-error-detail.ts";
import { recordObservation, recordTransient } from "../credentials/credential-health-store.ts";
import { secretKeysFor } from "../credentials/credential-keys.ts";

function recordCredentialHealth(
  db: Database,
  connectorId: string,
  outcome: ClassifiableOutcome,
  now: number,
): void {
  const keys = secretKeysFor(connectorId);
  if (keys.length === 0) return; // nothing to attribute (e.g. cloud-cred reuse)

  const cls = classifyAuthOutcome(outcome);
  if (cls === "transient") {
    recordTransient(db, connectorId, keys, now, "sync");
    return;
  }
  if (cls === "ok") {
    recordObservation(db, { connectorId, vaultKeys: keys, status: "ok", via: "sync", now });
    return;
  }
  const detail =
    outcome.kind === "http" ? extractErrorDetail(outcome.body, outcome.status) : "unavailable";
  recordObservation(db, {
    connectorId,
    vaultKeys: keys,
    status: cls === "auth-failure" ? "dead" : "unknown",
    via: "sync",
    now,
    detail,
  });
}
```

Call it in both the success and failure paths. Map the `FetchOutcome` variants
to a `ClassifiableOutcome` like this — all four cases, none defaulted:

```ts
function toClassifiable(outcome: FetchOutcome): ClassifiableOutcome {
  switch (outcome.kind) {
    case "ok":
      return { kind: "ok" };
    case "http_error":
      return { kind: "http", status: outcome.status, body: outcome.body };
    case "parse_error":
      // HTTP was 2xx, so the credential authenticated — UNLESS the server
      // answered an expired session with 200 + a login page instead of 401.
      // Reuse the auth-marker check rather than assuming health.
      return { kind: "http", status: 200, body: outcome.body };
  }
}
```

Passing `status: 200` is deliberate: `classifyAuthOutcome` returns `ok` for 2xx
*before* consulting the body, so a genuine schema surprise stays `ok`. To catch
the login-page case, move the marker check ahead of the 2xx short-circuit in
`classify-auth-outcome.ts`:

```ts
    case "http": {
      const { status, body } = outcome;
      if (bodyIndicatesAuthRejection(body)) return "auth-failure"; // even on 2xx
      if (status >= 200 && status < 300) return "ok";
      // …unchanged from here
```

and add the covering test to Task 4's table:

```ts
    ["200 with a login page", http(200, "<html><title>Sign in</title>Unauthorized</html>"), "auth-failure"],
    ["200 with unparseable but benign body", http(200, "not json at all"), "ok"],
```

A thrown network error maps to `{ kind: "network" }`.

**This must never throw.** Wrap the call in `try { … } catch { /* health is best-effort */ }` — a health-recording bug must not break a sync.

- [ ] **Step 4: Run the tests**

Run: `bun test <the driver's test file>`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/gateway/src/
git commit -m "feat(credentials): record credential health from every sync"
```

---

### Task 9: IPC + `nimbus creds` + the doctor line

Ships the milestone: passive observation is now visible.

**Files:**

- Create: `packages/gateway/src/ipc/credentials-rpc.ts` (+ test)
- Create: `packages/cli/src/commands/creds.ts` (+ test)
- Modify: `packages/cli/src/index.ts` — add `creds: runCreds` to `COMMAND_HANDLERS`
- Modify: `packages/cli/src/commands/registry.ts` — add `"creds"` to `COMMAND_NAMES`
- Modify: `packages/cli/src/commands/doctor-core.ts` — one summary line

**Interfaces:**

- Consumes: `listHealth`, `deriveStatus`
- Produces: IPC `credentials.list` → `{ credentials: Array<{ vaultKey; connectorId; status; note; detail }> }`; CLI `runCreds(argv: string[]): Promise<void>`

- [ ] **Step 1: Write the failing IPC test**

Read an existing small RPC module first — `packages/gateway/src/ipc/audit-rpc.ts` — and mirror its registration shape and `dispatchByMethod` usage.

```ts
// packages/gateway/src/ipc/credentials-rpc.test.ts
test("credentials.list returns derived statuses, never a secret value", async () => {
  const db = new Database(":memory:");
  db.exec(CREDENTIAL_HEALTH_V45_SQL);
  recordObservation(db, {
    connectorId: "zoom", vaultKeys: ["zoom.oauth"], status: "dead",
    via: "sync", now: Date.now(), detail: "HTTP 401",
  });
  const res = await handleCredentialsRpc({ method: "credentials.list", params: {} }, { db, now: Date.now() });
  expect(res.credentials[0].status).toBe("DEAD");
  expect(JSON.stringify(res)).not.toContain("secret");
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `bun test packages/gateway/src/ipc/credentials-rpc.test.ts`

- [ ] **Step 3: Implement the RPC module**

Follow `audit-rpc.ts` exactly: one exported handler using `dispatchByMethod` from `packages/gateway/src/ipc/_lib/dispatch-by-method.ts`, mapping `credentials.list` to `listHealth(db).map(r => ({ ...deriveStatus(r, now), vaultKey: r.vaultKey, connectorId: r.connectorId, detail: r.detail }))`. Register it wherever the other `*-rpc` modules are registered (grep for `auditRpc` to find the site).

**Do not add these methods to the Tauri `ALLOWED_METHODS`** in this task — see Task 14.

- [ ] **Step 4: Write the failing CLI test, then the command**

```ts
// packages/cli/src/commands/creds.test.ts
test("prints a line per credential with its status", async () => {
  const out = await runCredsWithFakeClient([
    { vaultKey: "zoom.oauth", connectorId: "zoom", status: "DEAD", note: "dead — last worked 2d ago", detail: "HTTP 401" },
    { vaultKey: "github.pat", connectorId: "github", status: "OK", note: "", detail: null },
  ]);
  expect(out).toContain("zoom.oauth");
  expect(out).toContain("DEAD");
  expect(out).toContain("1 need attention");
});

test("--json emits machine-readable output", async () => {
  const out = await runCredsWithFakeClient([...], ["--json"]);
  expect(() => JSON.parse(out)).not.toThrow();
});
```

Model `creds.ts` on `packages/cli/src/commands/security.ts` — same `--json` convention, same table style. Inject the client rather than using `mock.module` (this repo has had Linux-only CI failures from `mock.module` contamination).

- [ ] **Step 5: Add `nimbus creds fix <connector>`**

The spec's fix path. It builds nothing new — it makes the *existing* remedy
discoverable at the moment the user learns they need it, and deliberately
delegates so the credential write still passes through the HITL gate.

```ts
// packages/cli/src/commands/creds.test.ts
test("fix delegates to connector auth rather than writing a credential", async () => {
  const calls: string[] = [];
  await runCredsFix("zoom", { runConnectorAuth: async (id) => { calls.push(id); } });
  expect(calls).toEqual(["zoom"]);
});

test("fix on an unknown connector errors instead of silently doing nothing", async () => {
  await expect(runCredsFix("nope", { runConnectorAuth: async () => {} }))
    .rejects.toThrow(/unknown connector/i);
});
```

```ts
// packages/cli/src/commands/creds.ts
export interface CredsFixDeps {
  runConnectorAuth: (connectorId: string) => Promise<void>;
}

/**
 * Re-authenticate a connector. This does NOT write a credential itself — it
 * invokes the existing `nimbus connector auth` flow, whose vault.set passes
 * through the HITL gate (I2). Keeping the delegation explicit is what stops
 * this feature from ever acquiring credential-write capability.
 */
export async function runCredsFix(connectorId: string, deps: CredsFixDeps): Promise<void> {
  if (secretKeysFor(connectorId).length === 0) {
    throw new Error(`unknown connector or no credentials to fix: ${connectorId}`);
  }
  await deps.runConnectorAuth(connectorId);
}
```

Render the hint in the `nimbus creds` output for every `DEAD`/`EXPIRED` row:
`-> nimbus creds fix <connectorId>`.

- [ ] **Step 6: Add the doctor line**

In `doctor-core.ts`, add one check that calls `credentials.list` and reports `N need attention` (count of `DEAD`/`EXPIRED`/`EXPIRING`), with its own test.

- [ ] **Step 7: Register the command**

```ts
// packages/cli/src/index.ts — inside COMMAND_HANDLERS
  creds: runCreds,
```

```ts
// packages/cli/src/commands/registry.ts — inside COMMAND_NAMES, alphabetical
  "creds",
```

- [ ] **Step 8: Run the gates**

```bash
bun test packages/gateway/src/ipc/credentials-rpc.test.ts packages/cli/src/commands/creds.test.ts
bun run audit:readme-cli    # COMMAND_NAMES must stay in sync with the docs
bun run lint && bun run typecheck
```

`audit:readme-cli` will fail until `nimbus creds` is documented — add a `### \`nimbus creds\`` section to `docs/cli-reference.md` covering `creds`,`creds fix <connector>`, and (after Tasks 10–11)`creds expires` and `creds check`.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/ipc/ packages/cli/src/ docs/cli-reference.md
git commit -m "feat(credentials): credentials.list IPC, nimbus creds, doctor line"
```

**Milestone reached.** `nimbus creds` now reports real health gathered passively. Tasks 10–14 extend it.

---

### Task 10: Writer 2 — `nimbus creds expires`

**Files:**

- Modify: `packages/gateway/src/ipc/credentials-rpc.ts` (+ test) — add `credentials.setExpiry`
- Modify: `packages/cli/src/commands/creds.ts` (+ test) — add the `expires` subcommand

- [ ] **Step 1: Write the failing test**

```ts
test("credentials.setExpiry stores a declared expiry", async () => {
  const db = new Database(":memory:");
  db.exec(CREDENTIAL_HEALTH_V45_SQL);
  await handleCredentialsRpc(
    { method: "credentials.setExpiry", params: { vaultKey: "github.pat", connectorId: "github", expiresAt: "2026-09-20" } },
    { db, now: Date.now() },
  );
  const [row] = listHealth(db);
  expect(row.expirySource).toBe("declared");
});

test("an unparseable date is rejected, not silently stored", async () => {
  await expect(handleCredentialsRpc(
    { method: "credentials.setExpiry", params: { vaultKey: "a.token", connectorId: "a", expiresAt: "not-a-date" } },
    { db, now: Date.now() },
  )).rejects.toThrow(/date/i);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `bun test packages/gateway/src/ipc/credentials-rpc.test.ts`

- [ ] **Step 3: Implement**

Validate BOTH the date and the key before writing:

```ts
// in the credentials.setExpiry handler
const allowed = secretKeysFor(connectorId);
if (!allowed.includes(vaultKey)) {
  // Without this a caller can create health rows for configuration keys
  // (jira.base_url) or invent connector/key pairs that never existed.
  throw new Error(`${vaultKey} is not a credential of ${connectorId}`);
}
const ms = Date.parse(expiresAt);
if (Number.isNaN(ms)) throw new Error(`unparseable date: ${expiresAt}`);
setDeclaredExpiry(db, vaultKey, connectorId, ms);
```

Note `Date.parse` accepts some surprising inputs (`"2026-02-30"` rolls over to
March 2). Add a test asserting a strict `^\d{4}-\d{2}-\d{2}$` shape check runs
BEFORE `Date.parse`, and reject anything else.

Wire the CLI subcommand `nimbus creds expires <vault_key> <YYYY-MM-DD>`.

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test packages/gateway/src/ipc/credentials-rpc.test.ts packages/cli/src/commands/creds.test.ts`

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/gateway/src/ipc/ packages/cli/src/
git commit -m "feat(credentials): declared expiry for opaque tokens"
```

---

### Task 11: Writer 3 — the active probe

**Files:**

- Create: `packages/gateway/src/credentials/credential-probe.ts` (+ test)
- Modify: `packages/gateway/src/ipc/credentials-rpc.ts` — add `credentials.check`
- Modify: `packages/cli/src/commands/creds.ts` — add the `check` subcommand

**Interfaces:**

- Produces: `probeConnector(deps, connectorId, opts?: { timeoutMs?: number }): Promise<AuthClass>`, `DEFAULT_PROBE_TIMEOUT_MS = 10_000`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/credentials/credential-probe.test.ts
test("a hung host times out and yields unknown, never dead", async () => {
  const never = () => new Promise<never>(() => {});
  const cls = await probeConnector({ callListTool: never }, "jenkins", { timeoutMs: 20 });
  expect(cls).toBe("transient"); // -> unknown, NOT dead
});

test("a 401 from the list tool yields auth-failure", async () => {
  const cls = await probeConnector(
    { callListTool: async () => ({ kind: "http" as const, status: 401, body: "" }) },
    "jira",
  );
  expect(cls).toBe("auth-failure");
});

test("a connector whose server will not spawn yields transient, not dead", async () => {
  const cls = await probeConnector(
    { callListTool: async () => { throw new Error("spawn ENOENT"); } },
    "argocd",
  );
  expect(cls).toBe("transient");
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `bun test packages/gateway/src/credentials/credential-probe.test.ts`

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/credentials/credential-probe.ts
import { type AuthClass, type ClassifiableOutcome, classifyAuthOutcome } from "./classify-auth-outcome.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface ProbeDeps {
  /** Calls `<connectorId>_list` with the smallest possible limit. */
  callListTool: (connectorId: string) => Promise<ClassifiableOutcome>;
}

/**
 * Exercise one connector's credential via its mandatory `list` tool.
 *
 * A timeout is transient, never dead: a host that did not answer has told us
 * nothing about the credential. Self-hosted instances (Jenkins, ArgoCD, GitLab)
 * routinely hang rather than refuse.
 */
export async function probeConnector(
  deps: ProbeDeps,
  connectorId: string,
  opts: { timeoutMs?: number } = {},
): Promise<AuthClass> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race<ClassifiableOutcome>([
      deps.callListTool(connectorId),
      new Promise<ClassifiableOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    return classifyAuthOutcome(outcome);
  } catch {
    return "transient"; // could not ask != the answer was no
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test packages/gateway/src/credentials/credential-probe.test.ts`

- [ ] **Step 5: Wire `credentials.check`**

```ts
// packages/gateway/src/credentials/credential-probe.ts — append
// These imports are required by checkAllCredentials and are NOT in the
// classifier-only import block at the top of this file — add them.
import type { Database } from "bun:sqlite";
import { recordObservation, recordTransient } from "./credential-health-store.ts";
import { secretKeysFor } from "./credential-keys.ts";

const MAX_CONCURRENT_PROBES = 5;

export interface CheckDeps extends ProbeDeps {
  configuredConnectors: () => string[];
  now: () => number;
}

/**
 * Probe every configured connector. Explicitly invoked only — never on a timer
 * and never during sync, because this makes real API calls against up to 97
 * live services.
 */
export async function checkAllCredentials(db: Database, deps: CheckDeps): Promise<void> {
  const queue = deps.configuredConnectors().filter((c) => secretKeysFor(c).length > 0);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      // ATOMIC CLAIM: read-and-increment happens synchronously, before the
      // first await below. JS is single-threaded, so no two workers can claim
      // the same index. If you refactor this, the increment must STAY ahead of
      // every await — moving it after one introduces a duplicate-probe bug
      // that only shows up under concurrency.
      const connectorId = queue[cursor++];
      if (connectorId === undefined) return;
      const cls = await probeConnector(deps, connectorId);
      const keys = secretKeysFor(connectorId);
      const now = deps.now();
      if (cls === "transient") {
        recordTransient(db, connectorId, keys, now, "probe");
      } else {
        recordObservation(db, {
          connectorId,
          vaultKeys: keys,
          status: cls === "auth-failure" ? "dead" : cls === "ok" ? "ok" : "unknown",
          via: "probe",
          now,
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_PROBES, queue.length) }, worker),
  );
}
```

Add these tests — the first proves the cap holds, the second proves the atomic
claim (no connector probed twice, none skipped):

```ts
// packages/gateway/src/credentials/credential-probe.test.ts — append
test("never exceeds MAX_CONCURRENT_PROBES in flight", async () => {
  const db = new Database(":memory:");
  db.exec(CREDENTIAL_HEALTH_V45_SQL);
  let active = 0;
  let maxActive = 0;
  const callListTool = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return { kind: "ok" as const };
  };
  await checkAllCredentials(db, {
    callListTool,
    configuredConnectors: () => ["jira", "github", "linear", "notion", "zoom", "slack", "gitlab"],
    now: () => 1,
  });
  expect(maxActive).toBeLessThanOrEqual(5);
  expect(maxActive).toBeGreaterThan(1); // proves it is actually concurrent
});

test("probes every connector exactly once", async () => {
  const db = new Database(":memory:");
  db.exec(CREDENTIAL_HEALTH_V45_SQL);
  const seen: string[] = [];
  const callListTool = async (id: string) => {
    seen.push(id);
    await new Promise((r) => setTimeout(r, 1));
    return { kind: "ok" as const };
  };
  const connectors = ["jira", "github", "linear", "notion", "zoom", "slack", "gitlab"];
  await checkAllCredentials(db, { callListTool, configuredConnectors: () => connectors, now: () => 1 });
  expect(seen.sort()).toEqual([...connectors].sort()); // none skipped, none doubled
});
```

The `toBeGreaterThan(1)` assertion matters: without it the test would still
pass if the worker pool collapsed to serial execution, which is a performance
regression the cap alone cannot detect.

Then add the CLI subcommand `nimbus creds check [connector]`.

- [ ] **Step 6: Commit**

```bash
bun run lint && bun run typecheck
git add packages/gateway/src/ packages/cli/src/
git commit -m "feat(credentials): generic active probe over the mandatory list tool"
```

---

### Task 12: Clean up health rows on connector removal

**Files:**

- Modify: the `connector.remove` handler — find it with `rg -n "connector.remove" packages/gateway/src/ipc --glob '!*.test.ts'`
- Test: its sibling test

- [ ] **Step 1: Write the failing test**

```ts
test("removing a connector leaves no orphaned credential_health rows", async () => {
  const db = makeTestDb();
  db.exec(CREDENTIAL_HEALTH_V45_SQL);
  recordObservation(db, { connectorId: "zoom", vaultKeys: ["zoom.oauth"], status: "ok", via: "sync", now: 1 });
  recordObservation(db, { connectorId: "jira", vaultKeys: ["jira.api_token"], status: "ok", via: "sync", now: 1 });
  expect(listHealth(db)).toHaveLength(2);          // PRE-CONDITION: rows exist

  await removeConnector(db, "zoom");                // the path under test

  expect(listHealth(db).map((r) => r.connectorId)).toEqual(["jira"]);
});
```

The pre-condition assertion is the point: without it the test passes on an empty
database even when cleanup is entirely absent, so it would never have gone red.

- [ ] **Step 2: Run it — expect FAIL (rows survive)**

- [ ] **Step 3: Implement** — call `deleteHealthForConnector(db, connectorId)` inside the same transaction that deletes the connector's vault entries and index rows.

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/
git commit -m "fix(credentials): drop health rows when a connector is removed"
```

---

### Task 13: Config keys in `nimbus.toml`

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts` (+ test) — add optional `[credentials]` with `warn_before_expiry_days` (default 30) and `stale_after_days` (default 7)

**Interfaces:**

- Produces: `CredentialsConfig = { warnBeforeExpiryDays: number; staleAfterDays: number }` on the parsed config object

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/config/nimbus-toml.test.ts — append
test("[credentials] defaults apply when the section is absent", () => {
  const cfg = parseNimbusToml("");            // use this file's existing parse entry point
  expect(cfg.credentials.warnBeforeExpiryDays).toBe(30);
  expect(cfg.credentials.staleAfterDays).toBe(7);
});

test("[credentials] values override the defaults", () => {
  const cfg = parseNimbusToml(`
[credentials]
warn_before_expiry_days = 14
stale_after_days = 3
`);
  expect(cfg.credentials.warnBeforeExpiryDays).toBe(14);
  expect(cfg.credentials.staleAfterDays).toBe(3);
});

test("a non-numeric value is rejected rather than coerced", () => {
  expect(() => parseNimbusToml(`
[credentials]
warn_before_expiry_days = "soon"
`)).toThrow(/warn_before_expiry_days/);
});
```

Read the existing tests in that file first and reuse their parse entry point —
do not introduce a second parser.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml.test.ts`
Expected: FAIL — `cfg.credentials` is undefined.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/config/nimbus-toml.ts
export interface CredentialsConfig {
  /** Days of notice before a known expiry. Console-trip credentials need >1 week. */
  warnBeforeExpiryDays: number;
  /** Days without an observation after which health is treated as absent, not ok. */
  staleAfterDays: number;
}

const DEFAULT_CREDENTIALS_CONFIG: CredentialsConfig = {
  warnBeforeExpiryDays: 30,
  staleAfterDays: 7,
};

function parseCredentialsSection(raw: unknown): CredentialsConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CREDENTIALS_CONFIG };
  const section = raw as Record<string, unknown>;
  const num = (key: string, fallback: number): number => {
    const v = section[key];
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`[credentials] ${key} must be a positive number`);
    }
    return v;
  };
  return {
    warnBeforeExpiryDays: num("warn_before_expiry_days", DEFAULT_CREDENTIALS_CONFIG.warnBeforeExpiryDays),
    staleAfterDays: num("stale_after_days", DEFAULT_CREDENTIALS_CONFIG.staleAfterDays),
  };
}
```

Add `credentials: CredentialsConfig` to the exported config interface and
`credentials: parseCredentialsSection(parsed.credentials)` where the other
sections are assembled.

- [ ] **Step 4: Run tests, then thread the values through**

Run: `bun test packages/gateway/src/config/nimbus-toml.test.ts`
Expected: PASS

In `credentials-rpc.ts`, convert days to milliseconds and pass them to
`deriveStatus`:

```ts
const DAY_MS = 86_400_000;
deriveStatus(row, now, {
  warnBeforeExpiryMs: cfg.credentials.warnBeforeExpiryDays * DAY_MS,
  staleAfterMs: cfg.credentials.staleAfterDays * DAY_MS,
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/ packages/gateway/src/ipc/
git commit -m "feat(credentials): configurable warn and stale thresholds"
```

---

### Task 14: Prompt for expiry at auth time, and expose to the desktop UI

Sequenced last on purpose: the feature is complete without it, and it must never block the core.

**Files:**

- Modify: `packages/cli/src/commands/connector.ts` — after an opaque credential is stored
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` — add the read-only methods to `ALLOWED_METHODS`

- [ ] **Step 1: Write the failing CLI test**

```ts
test("prompts for expiry after storing an opaque credential", async () => { /* … */ });

test("does NOT prompt when stdin is not a TTY", async () => {
  // connector auth is scripted in CI; an unconditional prompt would hang it.
});

test("does NOT prompt when --json is passed", async () => { /* … */ });
```

- [ ] **Step 2: Run it — expect FAIL**
- [ ] **Step 3: Implement** — prompt only when `process.stdin.isTTY === true` and `--json` is absent; an empty answer skips and leaves `expires_at` NULL.
- [ ] **Step 4: Add `"credentials.list"` and `"credentials.check"` to `ALLOWED_METHODS`**

Read the `nimbus-tauri-allowlist` skill first. Both are read-only and safe to expose. **Bump the `assert_eq!(ALLOWED_METHODS.len(), N)` count** at `gateway_bridge.rs:518` — it is currently 101, so it becomes 103. Do **not** expose `credentials.setExpiry` (a write).

- [ ] **Step 5: Run the gates**

```bash
bun test packages/cli/src/commands/connector.test.ts
cd packages/ui/src-tauri && cargo test allowlist && cd ../../..
bun run preflight:fast
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/ packages/ui/src-tauri/
git commit -m "feat(credentials): capture expiry at auth time; expose reads to the renderer"
```

---

## Final verification

- [ ] `bun run preflight:fast` — all 21 gates green
- [ ] `bun test packages/gateway/src/credentials/` — every unit passes
- [ ] `bun run audit:invariants` — D10–D22 static checks pass
- [ ] Confirm no `vault.set` / `vault.delete` was added by this feature. Scoping
      the search to `credentials/` alone would miss a call added in the sync
      driver, the RPC module or the CLI — check every file the feature touched:
      `git diff --name-only origin/main...HEAD | xargs rg -n "vault\.(set|delete)"`
      → **must return nothing** (the existing `connector auth` path is untouched
      by this feature and should not appear in the diff at all)
- [ ] Confirm no secret can reach the table: `bun test packages/gateway/src/credentials/extract-error-detail.test.ts`
- [ ] Update `docs/CHANGELOG.md` with a dated entry
- [ ] Update `CLAUDE.md` **and** `GEMINI.md`: schema `V44` → `V45` (they are mirrors — edit both)
