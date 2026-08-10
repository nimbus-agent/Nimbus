# Actionable Targeted-Fetch and Connector-Auth Failures — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an expired or missing credential distinguishable from a genuinely absent item on the targeted-fetch wire, and make `nimbus connector auth` refuse to report success for a credential that cannot authenticate.

**Architecture:** Two stacked PRs on one branch. PR 1 adds a probe-before-write step to five PAT auth handlers plus a health-state clear, so `connector auth` stops lying. PR 2 adds a required `FetchMissReason` discriminator to `FetchOneResult`, wires it through five connectors via one shared status mapper, and surfaces it on `TargetedFetchOutcome` — adding fields only, never a new `status` arm.

**Tech Stack:** Bun 1.2+ test runner, TypeScript 7.x strict (`exactOptionalPropertyTypes` is on), Biome, SQLite via `bun:sqlite`.

**Spec:** [`../specs/2026-08-10-fetch-miss-reason-and-credential-validation-design.md`](../specs/2026-08-10-fetch-miss-reason-and-credential-validation-design.md)

## Global Constraints

- **Branch:** `dev/asaf/fetch-miss-reason`. Worktree: `.claude/worktrees/dev/asaf/fetch-miss-reason`. Never commit on `main`. Read/Edit must use the **worktree absolute path**, not `C:\gitrep\Nimbus\...`.
- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **No new `status` arm may reach the wire.** The `nimbus-web-clipper` parser validates `status` against a closed set and maps anything unknown to `server_error`. Adding fields is safe; adding arms is not.
- **No credential, provider text, base URL, or exception message may appear in any new value.** Every new value is a fixed enum derived from an HTTP status code. The deliberate catch-swallowing at `github-sync.ts:641-644` stays.
- **Do not weaken the fetch-host boundary.** `deriveFetchHostMap` stays the only source of "is this host fetchable"; a miss stays `not_configured`.
- **Prefer dependency injection over `mock.module`.** `mock.module` is process-global and contaminates the combined Linux CI run. Follow the existing test-seam precedent in `ipc/connector-rpc-handlers/context.ts:42-46`.
- **`exactOptionalPropertyTypes`:** omit an optional key entirely; never pass `key: undefined`.
- Run `bun run preflight:fast` after any code change. Full `bun run preflight` before each PR.
- Commit messages are discarded on squash-merge — the PR title and description are the permanent commit. Put the conventional-commit type in the PR title.

---

## File Structure

**PR 1 — credential validation**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/connectors/health.ts` (modify) | Add `reauthenticated` to `HealthEvent`, `nextState`, and the history-reason switch |
| `packages/gateway/src/index/local-index.ts` (modify) | Add `markConnectorReauthenticated(serviceId)` — the only route to the private `db` from an RPC handler |
| `packages/gateway/src/connectors/credential-probe.ts` (create) | `ProbeVerdict`, `verdictForProbeResponse`, `runCredentialProbe`, `CREDENTIAL_PROBES` |
| `packages/gateway/src/ipc/connector-rpc-handlers/context.ts` (modify) | Add the `runCredentialProbe?` test seam |
| `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` (modify) | Call the probe before the first `writeConnectorSecret` in five handlers; return `verified` |
| `packages/cli/src/commands/connector.ts` (modify) | Replace `Signed in:` with output that reports only what was checked |

**PR 2 — fetch miss reasons**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/sync/types.ts` (modify) | `FetchMissReason`; `reason` on `FetchOneResult`; `rate_limited` arm |
| `packages/gateway/src/connectors/fetch-miss-reason.ts` (create) | `fetchOneMissForResponse` — the single status→outcome mapper |
| `packages/gateway/src/connectors/{github,gitlab,bitbucket,jenkins,jira}-sync.ts` (modify) | Supply a cause at every `not_found` site |
| `packages/gateway/src/sync/targeted-fetch.ts` (modify) | `reason` on the outcome; `service` on `not_configured`; correct the `rate_limited` doc comment |

---

## PR 1 — `nimbus connector auth` validates before storing

### Task 1: `reauthenticated` health event

Clears a stuck `unauthenticated` state. Without this the rest of PR 1 prints "Verified" while the scheduler keeps skipping the connector forever (`scheduler.ts:400` returns an unconditional `true` for `unauthenticated`).

**Files:**
- Modify: `packages/gateway/src/connectors/health.ts:31-39` (union), `:49-66` (`nextState`), `:215-227` (reason switch)
- Modify: `packages/gateway/src/index/local-index.ts` (add method near `ensureConnectorSchedulerRegistration`)
- Test: `packages/gateway/test/unit/connectors/health.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HealthEvent` variant `{ type: "reauthenticated" }`; `LocalIndex.markConnectorReauthenticated(serviceId: string): void`.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/test/unit/connectors/health.test.ts`. That file has a module-level `db` built in `beforeEach` (`new Database(":memory:")` + `LocalIndex.ensureSchema(db)` + a seeded `sync_state` row for `github`) — use it directly; do **not** construct a database inside the test.

`getConnectorHealthHistory(db, connectorId, limit?)` returns `HealthHistoryRow[]` already ordered `occurred_at DESC, id DESC`, so read history through it rather than with raw SQL.

```ts
test("reauthenticated clears unauthenticated and the stale auth error", () => {
  transitionHealth(db, "github", { type: "unauthenticated" });
  expect(getConnectorHealth(db, "github").state).toBe("unauthenticated");

  const snap = transitionHealth(db, "github", { type: "reauthenticated" });

  expect(snap.state).toBe("healthy");
  // The unauthenticated transition writes a hardcoded lastError (health.ts:196);
  // leaving it behind would show a stale "token expired" next to a healthy state.
  expect(getConnectorHealth(db, "github").lastError).toBeUndefined();
});

test("reauthenticated records its own history reason, not 'connector resumed'", () => {
  transitionHealth(db, "github", { type: "unauthenticated" });
  transitionHealth(db, "github", { type: "reauthenticated" });

  const [latest] = getConnectorHealthHistory(db, "github", 1);
  expect(latest?.toState).toBe("healthy");
  expect(latest?.reason).toBe("credential re-verified");
});
```

`getConnectorHealthHistory` is already imported by this file; `getConnectorHealth` and `transitionHealth` are too.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/test/unit/connectors/health.test.ts`
Expected: FAIL — TypeScript rejects `{ type: "reauthenticated" }` as not assignable to `HealthEvent`.

- [ ] **Step 3: Implement**

In `health.ts`, add to the `HealthEvent` union (after the `resumed` member at :38):

```ts
  | { type: "reauthenticated" }
```

Add to `nextState`'s switch (after the `resumed` case at :63-64):

```ts
    case "reauthenticated":
      return "healthy";
```

Add to the reason switch (after the `resumed` case ending at :226):

```ts
    case "reauthenticated":
      // Same clearing as `resumed` — a stale `unauthenticated` lastError beside a
      // healthy state is exactly the mixed signal this change exists to remove —
      // but its OWN reason: nothing was paused, so "connector resumed" would be false.
      backoffUntilMs = null;
      backoffAttempt = 0;
      lastError = null;
      reason = "credential re-verified";
      break;
```

`nextState`'s switch is exhaustive over `HealthEventWithStateChange`, so omitting either case is a compile error — that is the intended forcing function.

In `local-index.ts`, add beside `ensureConnectorSchedulerRegistration`:

```ts
  /**
   * Clear a connector's `unauthenticated` health after its credential was
   * re-verified against the provider.
   *
   * Exists because `db` is private and `connector.auth`'s handler has no other
   * route to it — the same reason `ensureConnectorSchedulerRegistration` lives
   * here. Call ONLY on a probe that actually returned `valid`: clearing on an
   * unverified store would reinstate the over-claim this change removes.
   */
  markConnectorReauthenticated(serviceId: string): void {
    transitionHealth(this.db, serviceId, { type: "reauthenticated" });
  }
```

Add the `transitionHealth` import if `local-index.ts` lacks one.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/test/unit/connectors/health.test.ts packages/gateway/src/index/local-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify no other exhaustive switch broke**

Run: `bun run typecheck`
Expected: clean. If another switch over `HealthEvent` fails to compile, add the case there — do not widen a type to silence it.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/connectors/health.ts packages/gateway/src/index/local-index.ts packages/gateway/test/unit/connectors/health.test.ts
git commit -m "feat(health): add reauthenticated event to clear a stuck unauthenticated state"
```

---

### Task 2: The probe module

**Files:**
- Create: `packages/gateway/src/connectors/credential-probe.ts`
- Test: `packages/gateway/src/connectors/credential-probe.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ProbeVerdict = { kind: "valid" } | { kind: "rejected"; httpStatus: number } | { kind: "unreachable" }`
  - `function verdictForProbeResponse(httpStatus: number): ProbeVerdict`
  - `interface ProbeRequest { url: string; headers: Record<string, string> }`
  - `type CredentialProbe = (creds: Record<string, string>) => ProbeRequest`
  - `const CREDENTIAL_PROBES: Partial<Record<ConnectorServiceId, CredentialProbe>>`
  - `async function runCredentialProbe(serviceId, creds, fetchFn?): Promise<ProbeVerdict | null>` — `null` means no probe is registered.
  - `const PROBE_TIMEOUT_MS: number`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/credential-probe.test.ts`:

```ts
import { expect, test } from "bun:test";

import {
  CREDENTIAL_PROBES,
  runCredentialProbe,
  verdictForProbeResponse,
} from "./credential-probe.ts";

test("200 is valid", () => {
  expect(verdictForProbeResponse(200)).toEqual({ kind: "valid" });
});

test("401 is the ONLY rejecting status", () => {
  expect(verdictForProbeResponse(401)).toEqual({ kind: "rejected", httpStatus: 401 });
});

// A 403 means the provider knows who you are and declined THIS endpoint — the
// credential authenticated. A GitHub fine-grained PAT scoped to repositories but
// not account metadata 403s on /user while working for everything Nimbus needs.
// Rejecting it would be the same over-claim, pointed the other way.
test("403 is unverified, never rejected", () => {
  expect(verdictForProbeResponse(403)).toEqual({ kind: "unreachable" });
});

test("429 and 5xx are unverified, never rejected", () => {
  expect(verdictForProbeResponse(429)).toEqual({ kind: "unreachable" });
  expect(verdictForProbeResponse(500)).toEqual({ kind: "unreachable" });
  expect(verdictForProbeResponse(503)).toEqual({ kind: "unreachable" });
});

test("a transport failure is unreachable, and the exception never escapes", async () => {
  const verdict = await runCredentialProbe(
    "github",
    { pat: "t" },
    () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.github.com");
    },
  );
  expect(verdict).toEqual({ kind: "unreachable" });
});

test("a service with no registered probe returns null", async () => {
  expect(CREDENTIAL_PROBES["datadog"]).toBeUndefined();
  expect(await runCredentialProbe("datadog", { api_key: "k" })).toBeNull();
});

test("github probes /user with a bearer header and an abort signal", async () => {
  let seenUrl = "";
  let seenAuth = "";
  let hadSignal = false;
  await runCredentialProbe("github", { pat: "pat-value" }, (url, init) => {
    seenUrl = String(url);
    seenAuth = String((init?.headers as Record<string, string>)["Authorization"]);
    hadSignal = init?.signal !== undefined;
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  expect(seenUrl).toBe("https://api.github.com/user");
  expect(seenAuth).toBe("Bearer pat-value");
  // Without a bound signal, `nimbus connector auth` hangs on a stalled provider.
  expect(hadSignal).toBe(true);
});

test("every registered probe builds an absolute https url", () => {
  const creds = {
    pat: "t",
    username: "u",
    app_password: "p",
    api_token: "t",
    email: "e@example.com",
    base_url: "https://ci.example.com",
    api_base: "https://gitlab.example.com/api/v4",
  };
  for (const [service, probe] of Object.entries(CREDENTIAL_PROBES)) {
    const req = (probe as (c: Record<string, string>) => { url: string })(creds);
    expect(new URL(req.url).protocol, `${service} probe scheme`).toBe("https:");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/credential-probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/gateway/src/connectors/credential-probe.ts`:

```ts
// packages/gateway/src/connectors/credential-probe.ts

import type { ConnectorServiceId } from "./connector-catalog.ts";

/**
 * Bounds the single probe request. Without it `nimbus connector auth` — an
 * INTERACTIVE command — can hang indefinitely on a stalled provider. Mirrors
 * `FETCH_ONE_TIMEOUT_MS` (`sync/types.ts`); a timeout is a transport failure and
 * resolves to `unreachable`, so the credential is still stored.
 */
export const PROBE_TIMEOUT_MS = 10_000;

export type ProbeVerdict =
  | { readonly kind: "valid" }
  | { readonly kind: "rejected"; readonly httpStatus: number }
  | { readonly kind: "unreachable" };

export interface ProbeRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export type CredentialProbe = (creds: Record<string, string>) => ProbeRequest;

function basicAuth(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, "utf8").toString("base64")}`;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Identity endpoints, one per service that has a cheap one.
 *
 * A `Partial<Record<...>>`, not a total map: the ~14 other PAT connectors are
 * EXPLICITLY absent rather than silently unchecked, and `runCredentialProbe`
 * answers `null` for them so the caller reports "stored, not verified" instead
 * of inventing a verdict.
 */
export const CREDENTIAL_PROBES: Partial<Record<ConnectorServiceId, CredentialProbe>> = {
  github: (c) => ({
    url: "https://api.github.com/user",
    headers: {
      Authorization: `Bearer ${c["pat"] ?? ""}`,
      Accept: "application/vnd.github+json",
    },
  }),
  gitlab: (c) => ({
    url: `${stripTrailingSlash(c["api_base"] ?? "https://gitlab.com/api/v4")}/user`,
    headers: { "PRIVATE-TOKEN": c["pat"] ?? "" },
  }),
  bitbucket: (c) => ({
    url: "https://api.bitbucket.org/2.0/user",
    headers: {
      Authorization: basicAuth(c["username"] ?? "", c["app_password"] ?? ""),
      Accept: "application/json",
    },
  }),
  jira: (c) => ({
    url: `${stripTrailingSlash(c["base_url"] ?? "")}/rest/api/3/myself`,
    headers: {
      Authorization: basicAuth(c["email"] ?? "", c["api_token"] ?? ""),
      Accept: "application/json",
    },
  }),
  jenkins: (c) => ({
    url: `${stripTrailingSlash(c["base_url"] ?? "")}/api/json`,
    headers: {
      Authorization: basicAuth(c["username"] ?? "", c["api_token"] ?? ""),
      Accept: "application/json",
    },
  }),
};

/**
 * Maps a probe response status to a verdict.
 *
 * ONLY 401 rejects. A 401 is "we do not know who you are" — the credential did
 * not authenticate. Everything else that is not 2xx (403, 429, 5xx, a
 * misconfigured base URL's 404) leaves the question open, so the credential is
 * stored and honestly reported as unverified.
 *
 * NOTE the deliberate divergence from `connectors/fetch-miss-reason.ts`, where
 * 403 maps to `unauthorized`. Fetching a SPECIFIC ITEM, a 403 means the user
 * cannot have it either way, so `unauthorized` is the actionable answer.
 * Verifying a CREDENTIAL, a 403 is proof it authenticated. Different questions.
 */
export function verdictForProbeResponse(httpStatus: number): ProbeVerdict {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { kind: "valid" };
  }
  if (httpStatus === 401) {
    return { kind: "rejected", httpStatus };
  }
  return { kind: "unreachable" };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Runs `serviceId`'s probe. Returns `null` when no probe is registered.
 *
 * Deliberately does NOT acquire from the connector rate limiter, unlike
 * `sync/targeted-fetch.ts`. A targeted fetch is machine-driven and sweepable, so
 * it must share the scheduler's bucket. A probe is ONE request because a human
 * typed a command: routing it through that bucket would let a saturated
 * background sync block interactive setup for the full acquire timeout and would
 * consume a token the scheduler needs.
 *
 * Never throws and never returns provider text — a transport error's message can
 * carry the request URL, which for jenkins/jira embeds the Vault-stored
 * `base_url`.
 */
export async function runCredentialProbe(
  serviceId: ConnectorServiceId,
  creds: Record<string, string>,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Promise<ProbeVerdict | null> {
  const probe = CREDENTIAL_PROBES[serviceId];
  if (probe === undefined) {
    return null;
  }
  const req = probe(creds);
  try {
    const res = await fetchFn(req.url, {
      method: "GET",
      headers: req.headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return verdictForProbeResponse(res.status);
  } catch {
    return { kind: "unreachable" };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/credential-probe.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run preflight:fast`
Expected: PASS. Do not pipe this through `tail` — a pipe hides the exit code.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/connectors/credential-probe.ts packages/gateway/src/connectors/credential-probe.test.ts
git commit -m "feat(connectors): add credential probe with 401-only rejection"
```

---

### Task 3: Wire the probe into the five auth handlers

**Files:**
- Modify: `packages/gateway/src/ipc/connector-rpc-handlers/context.ts:34-47`
- Modify: `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` — `authSuccess` (:90), `connectorAuthGithub` (:101), `connectorAuthGitlab` (:120), `connectorAuthBitbucket` (:527), `connectorAuthJenkins` (:493), and the `jira` entry (:733)
- Test: `packages/gateway/src/ipc/connector-rpc.test.ts`

**Interfaces:**
- Consumes: `runCredentialProbe`, `ProbeVerdict` (Task 2); `LocalIndex.markConnectorReauthenticated` (Task 1).
- Produces: `connector.auth` result gains `verified: "verified" | "unverified" | null`; `ConnectorRpcHandlerContext.runCredentialProbe?` test seam.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/ipc/connector-rpc.test.ts`, following that file's existing context-construction helper.

```ts
test("a rejected credential writes NOTHING to the vault and throws", async () => {
  const writes: string[] = [];
  const vault = recordingVault(writes);
  await expect(
    handleConnectorAuth({
      ...baseCtx({ vault }),
      rec: { service: "github", token: "dead-pat" },
      runCredentialProbe: async () => ({ kind: "rejected", httpStatus: 401 }),
    }),
  ).rejects.toThrow(/github/);
  // The point of probing BEFORE writing: a typo'd token must not clobber a
  // working stored credential on the way to being rejected.
  expect(writes).toEqual([]);
});

test("a valid credential stores and clears a stuck unauthenticated state", async () => {
  const writes: string[] = [];
  const reauthed: string[] = [];
  const hit = await handleConnectorAuth({
    ...baseCtx({
      vault: recordingVault(writes),
      localIndex: fakeLocalIndex({ onReauth: (id) => reauthed.push(id) }),
    }),
    rec: { service: "github", token: "good-pat" },
    runCredentialProbe: async () => ({ kind: "valid" }),
  });
  expect(writes).toContain("github.pat");
  expect(reauthed).toEqual(["github"]);
  expect((hit.value as { verified: string }).verified).toBe("verified");
});

test("an unreachable provider stores but does NOT clear health", async () => {
  const writes: string[] = [];
  const reauthed: string[] = [];
  const hit = await handleConnectorAuth({
    ...baseCtx({
      vault: recordingVault(writes),
      localIndex: fakeLocalIndex({ onReauth: (id) => reauthed.push(id) }),
    }),
    rec: { service: "github", token: "maybe-good" },
    runCredentialProbe: async () => ({ kind: "unreachable" }),
  });
  expect(writes).toContain("github.pat");
  // No evidence the credential works — inventing some is the defect being fixed.
  expect(reauthed).toEqual([]);
  expect((hit.value as { verified: string }).verified).toBe("unverified");
});

test("a service with no probe stores and reports verified: null", async () => {
  const writes: string[] = [];
  const hit = await handleConnectorAuth({
    ...baseCtx({ vault: recordingVault(writes) }),
    rec: { service: "pagerduty", token: "tok" },
  });
  expect(writes).toContain("pagerduty.api_token");
  expect((hit.value as { verified: string | null }).verified).toBeNull();
});
```

Add the two helpers near the top of the file if absent:

```ts
function recordingVault(writes: string[]): NimbusVault {
  return {
    set: async (k: string) => {
      writes.push(k);
    },
    get: async () => null,
    delete: async () => {},
  } as unknown as NimbusVault;
}

function fakeLocalIndex(opts: { onReauth?: (id: string) => void } = {}): LocalIndex {
  return {
    ensureConnectorSchedulerRegistration: () => {},
    markConnectorReauthenticated: (id: string) => opts.onReauth?.(id),
  } as unknown as LocalIndex;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/connector-rpc.test.ts`
Expected: FAIL — `runCredentialProbe` is not a property of the context type, and `verified` is absent from the result.

- [ ] **Step 3: Implement the seam and the shared step**

In `context.ts`, add to `ConnectorRpcHandlerContext` (mirroring the documented `resolveOAuthClientConfig` seam at :42-46):

```ts
  /**
   * Test seam. Omitted in production, where `auth.ts` falls back to the real
   * `runCredentialProbe`. Injected rather than `mock.module`-ed: `mock.module`
   * is process-global and contaminates the combined Linux CI run.
   */
  runCredentialProbe?: (
    serviceId: ConnectorServiceId,
    creds: Record<string, string>,
  ) => Promise<ProbeVerdict | null>;
```

Add the type-only imports for `ConnectorServiceId` and `ProbeVerdict`. `context.ts` is type-only and coverage-excluded — add no runtime logic there.

In `auth.ts`, change `authSuccess` and add the shared step:

```ts
type VerifiedState = "verified" | "unverified" | null;

function authSuccess(id: ConnectorServiceId, verified: VerifiedState = null): ConnectorRpcHit {
  return { kind: "hit", value: { ok: true, serviceId: id, scopesGranted: [] as string[], verified } };
}

/**
 * Probe `creds` BEFORE anything is written, and clear a stuck `unauthenticated`
 * health state when — and only when — the provider confirms the credential.
 *
 * Ordering is the contract: probing in-hand credentials before the first
 * `writeConnectorSecret` is what makes "nothing was stored" true, and is what
 * stops a typo'd token clobbering a working stored one. Throwing here aborts the
 * handler before any write.
 */
async function verifyBeforeStore(
  ctx: ConnectorRpcHandlerContext,
  serviceId: ConnectorServiceId,
  creds: Record<string, string>,
): Promise<VerifiedState> {
  const probe = ctx.runCredentialProbe ?? runCredentialProbe;
  const verdict = await probe(serviceId, creds);
  if (verdict === null) {
    return null;
  }
  if (verdict.kind === "rejected") {
    // Names the service and the status ONLY. A provider body or request URL can
    // carry the credential or the Vault-stored base_url.
    throw new ConnectorRpcError(
      -32602,
      `${serviceId} rejected the credential (HTTP ${String(verdict.httpStatus)}). Nothing was stored.`,
    );
  }
  if (verdict.kind === "valid") {
    ctx.localIndex.markConnectorReauthenticated(serviceId);
    return "verified";
  }
  return "unverified";
}
```

Then in each of the five handlers, insert the call between parsing and the first write, and thread the result into `authSuccess`. Each handler needs its context — change the five entries in `PAT_CONNECTOR_AUTH_HANDLERS` to pass `c` through. `connectorAuthGithub` becomes:

```ts
async function connectorAuthGithub(ctx: ConnectorRpcHandlerContext): Promise<ConnectorRpcHit> {
  const tokenRaw = ctx.rec?.["personalAccessToken"] ?? ctx.rec?.["token"];
  const token = extractStringField(tokenRaw);
  if (token === "") {
    throw new ConnectorRpcError(-32602, "Missing personalAccessToken for github");
  }
  const verified = await verifyBeforeStore(ctx, "github", { pat: token });
  await writeConnectorSecret(ctx.vault, "github", "pat", token);
  const now = Date.now();
  ctx.localIndex.ensureConnectorSchedulerRegistration("github", defaultSyncIntervalMsForService("github"), now);
  ctx.localIndex.ensureConnectorSchedulerRegistration("github_actions", defaultSyncIntervalMsForService("github_actions"), now);
  return authSuccess("github", verified);
}
```

Apply the same shape to the other four. The creds each passes:

- `gitlab`: `{ pat: token, api_base: <normalized base or "https://gitlab.com/api/v4"> }` — compute the base **before** the probe; the existing `deleteConnectorSecret(api_base)` at :135 must still run only after a non-rejecting verdict.
- `bitbucket`: `{ username: user, app_password: token }`
- `jenkins`: `{ base_url: base, username: user, api_token: token }`
- `jira`: `{ base_url: creds.baseUrl, email: creds.email, api_token: creds.token }` — probe after `parseAtlassianSiteCredentials`, before `registerAtlassianApiConnectorAuth`.

Leave the other 14 handlers untouched; they return `authSuccess(id)` and get `verified: null` from the default parameter.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/ipc/connector-rpc.test.ts packages/gateway/src/ipc/connector-rpc-routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Red-prove the ordering guarantee**

Temporarily move the `verifyBeforeStore` call in `connectorAuthGithub` to **after** `writeConnectorSecret`. Re-run the suite.
Expected: the "writes NOTHING to the vault" test FAILS. Restore the correct order and confirm it passes again. A guard that never goes red proves nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/connector-rpc-handlers/ packages/gateway/src/ipc/connector-rpc.test.ts
git commit -m "feat(connector-auth): probe credentials before storing them"
```

---

### Task 4: The stuck-connector regression test

The individual pieces passing while the user stays stuck is the exact failure being fixed, so it gets its own test.

**Files:**
- Test: `packages/gateway/test/integration/connector-auth-unsticks-scheduler.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Open `packages/gateway/test/integration/` and copy the DB + scheduler construction from the nearest existing scheduler integration test. Then:

```ts
test("re-auth after an expired token lets the scheduler dispatch again", async () => {
  const { db, localIndex, scheduler } = await makeSchedulerHarness(["github"]);

  // 1. The token expires: a sync throws UnauthenticatedError and health latches.
  transitionHealth(db, "github", { type: "unauthenticated" });
  expect(getConnectorHealth(db, "github").state).toBe("unauthenticated");
  expect(scheduler.wouldDispatch("github")).toBe(false);

  // 2. The user runs `nimbus connector auth github` with a good token.
  await handleConnectorAuth({
    ...baseCtx({ localIndex }),
    rec: { service: "github", token: "fresh-pat" },
    runCredentialProbe: async () => ({ kind: "valid" }),
  });

  // 3. Without the reauthenticated event this stays false forever:
  //    SKIP_HEALTH_STATES contains "unauthenticated" and the gate returns an
  //    unconditional true for it (scheduler.ts:400). Only a FORCED sync bypasses
  //    it (scheduler.ts:482-487); the scheduled path never does.
  expect(getConnectorHealth(db, "github").state).toBe("healthy");
  expect(scheduler.wouldDispatch("github")).toBe(true);
});
```

`wouldDispatch` is not public. Use whichever seam that harness already exposes for asserting skip behaviour — likely driving `scheduler.tick()` and asserting a sync fn was or was not invoked. Do **not** add a production accessor purely for the test; assert on observable behaviour.

- [ ] **Step 2: Run test to verify it fails**

First comment out the `markConnectorReauthenticated` call in `verifyBeforeStore`.
Run: `bun test packages/gateway/test/integration/connector-auth-unsticks-scheduler.test.ts`
Expected: FAIL at the `"healthy"` assertion — the connector stays skipped.

- [ ] **Step 3: Restore the call**

Uncomment it. No new production code.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/test/integration/connector-auth-unsticks-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/test/integration/connector-auth-unsticks-scheduler.test.ts
git commit -m "test(connector-auth): prove re-auth unsticks a skipped connector"
```

---

### Task 5: CLI output and exit codes

**Files:**
- Modify: `packages/cli/src/commands/connector.ts:912-942`
- Test: `packages/cli/src/commands/connector.test.ts`

**Interfaces:**
- Consumes: the `verified` field (Task 3).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Use the existing dispatcher-injection pattern in `connector.test.ts` — **not** `mock.module`.

```ts
test("prints Verified only when the provider confirmed the credential", async () => {
  const out = await captureStdout(() =>
    runConnectorAuth(["github"], fakeIpc({ ok: true, serviceId: "github", scopesGranted: [], verified: "verified" })),
  );
  expect(out).toContain("Verified: github");
  expect(out).not.toContain("Signed in");
});

test("says plainly when the credential was stored but not verified", async () => {
  const out = await captureStdout(() =>
    runConnectorAuth(["github"], fakeIpc({ ok: true, serviceId: "github", scopesGranted: [], verified: "unverified" })),
  );
  expect(out).toContain("Stored: github");
  expect(out).toContain("NOT verified");
});

test("an unprobed connector never claims verification", async () => {
  const out = await captureStdout(() =>
    runConnectorAuth(["datadog"], fakeIpc({ ok: true, serviceId: "datadog", scopesGranted: [], verified: null })),
  );
  expect(out).toContain("Stored: datadog");
  expect(out).not.toContain("Verified:");
  expect(out).not.toContain("Signed in");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/connector.test.ts`
Expected: FAIL — output still reads `Signed in: github`.

- [ ] **Step 3: Implement**

Replace the `console.log(\`Signed in: ${res.serviceId}\`)` at :915 and keep the existing `vaultPatServices` block below it:

```ts
  const res = await withIpc((c) =>
    c.call<{ ok: boolean; serviceId: string; scopesGranted: string[]; verified?: "verified" | "unverified" | null }>(
      "connector.auth",
      params,
    ),
  );
  // Report only what was actually checked. "Signed in" claimed more than the
  // command ever verified — for the connectors with no probe it would keep
  // claiming it.
  if (res.verified === "verified") {
    console.log(`Verified: ${res.serviceId}`);
  } else if (res.verified === "unverified") {
    console.log(`Stored: ${res.serviceId} (NOT verified — could not reach the provider)`);
    console.log(`Run \`nimbus connector auth ${res.serviceId}\` again when online to verify.`);
  } else {
    console.log(`Stored: ${res.serviceId} (not verified)`);
  }
```

No exit-code code is needed. A rejected credential throws `ConnectorRpcError`, and the CLI catch-all already sets `process.exitCode = 1` (`packages/cli/src/index.ts:197`), matching the established convention: **1 = user-actionable precondition** (`agent-cli-dispatcher.ts:29`), **2 = operational failure** (`:48`). Unreachable and unprobed both exit 0 — the store succeeded.

- [ ] **Step 4: Run tests**

Run: `bun test packages/cli/src/commands/connector.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the CLI reference**

Grep for the old wording and update it: `grep -rn "Signed in" docs/ packages/docs/ 2>/dev/null`. Update `docs/cli-reference.md`'s `connector auth` section to document the three outcomes and the exit codes.

- [ ] **Step 6: Full preflight, then commit**

Run: `bun run preflight`
Expected: PASS. If `audit:coverage-floor` flags `credential-probe.ts`, build lcov via `scripts/coverage-floor/build-lcov.sh` (it needs git + `install-vault-deps.sh` + a D-Bus wrap; a bare Docker run gives false violations) and add tests until it clears ≥85% line / ≥80% branch. Do not add a coverage exclusion for a new file with real logic.

```bash
git add -A
git commit -m "feat(cli): report what connector auth actually verified"
```

- [ ] **Step 7: Open PR 1**

Title: `fix(connector-auth): validate a credential before storing it`
Body must state: the `verified` field is new on `connector.auth`; a rejected credential now throws and exits 1; a new `reauthenticated` health event clears a stuck `unauthenticated` state that otherwise made the connector permanently unsyncable.

---

## PR 2 — targeted fetch names the cause

### Task 6: The reason enum and the shared mapper

Adds the type and the mapper without touching any connector, so the tree stays green. `reason` is optional at this stage and becomes required in Task 10 — that flip is what proves all five connectors were wired.

**Files:**
- Modify: `packages/gateway/src/sync/types.ts:83-91`
- Create: `packages/gateway/src/connectors/fetch-miss-reason.ts`
- Test: `packages/gateway/src/connectors/fetch-miss-reason.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FetchMissReason`; `FetchOneResult` with optional `reason` and a new `rate_limited` arm; `fetchOneMissForResponse(httpStatus: number): FetchOneResult`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/fetch-miss-reason.test.ts`:

```ts
import { expect, test } from "bun:test";

import { fetchOneMissForResponse } from "./fetch-miss-reason.ts";

test("401 and 403 are unauthorized", () => {
  expect(fetchOneMissForResponse(401)).toEqual({ status: "not_found", reason: "unauthorized" });
  expect(fetchOneMissForResponse(403)).toEqual({ status: "not_found", reason: "unauthorized" });
});

test("404 is absent", () => {
  expect(fetchOneMissForResponse(404)).toEqual({ status: "not_found", reason: "absent" });
});

// Routed to the EXISTING rate_limited arm, not a reason: the clipper already
// handles that arm, so provider throttling becomes actionable with no client change.
test("429 is rate_limited, not a not_found reason", () => {
  expect(fetchOneMissForResponse(429)).toEqual({ status: "rate_limited" });
});

test("5xx and anything else are upstream_error", () => {
  expect(fetchOneMissForResponse(500)).toEqual({ status: "not_found", reason: "upstream_error" });
  expect(fetchOneMissForResponse(418)).toEqual({ status: "not_found", reason: "upstream_error" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/fetch-miss-reason.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

In `sync/types.ts`, replace the `FetchOneResult` block at :83-90:

```ts
/**
 * Why a targeted single-item fetch missed.
 *
 * A fixed enum derived from an HTTP status code and nothing else — never
 * provider text, a URL, or an exception message, any of which can carry a
 * credential or a Vault-stored base URL.
 */
export type FetchMissReason =
  | "no_credential"
  | "unauthorized"
  | "absent"
  | "unreachable"
  | "upstream_error";

/**
 * The outcome of a TARGETED single-item fetch. Distinct arms because collapsing
 * them is how a panel ends up telling a user to check credentials that are fine
 * — and `reason` is why that promise is now actually kept: a bare `not_found`
 * used to cover a dead credential, an offline machine, and an absent item alike.
 */
export type FetchOneResult =
  | { readonly status: "indexed"; readonly itemId: string }
  | { readonly status: "not_found"; readonly reason?: FetchMissReason }
  | { readonly status: "rate_limited" }
  | { readonly status: "unsupported_url" };
```

Create `packages/gateway/src/connectors/fetch-miss-reason.ts`:

```ts
// packages/gateway/src/connectors/fetch-miss-reason.ts

import type { FetchOneResult } from "../sync/types.ts";

/**
 * The single status→outcome mapper every connector's `fetchOne` uses for a
 * non-2xx response. One mapper, five callers, so the connectors cannot drift.
 *
 * Takes a status code and nothing else — no `Response`, no body, no URL — so no
 * provider text can leak through it.
 *
 * KNOWN BOUND: GitHub also returns 403 for secondary rate limits, so
 * `unauthorized` will occasionally mean "throttled". Disambiguating needs
 * `x-ratelimit-remaining` inspection; left unsolved rather than half-solved.
 *
 * NOTE the deliberate divergence from `connectors/credential-probe.ts`, where
 * 403 does NOT reject. Fetching a specific item, a 403 means the user cannot
 * have it either way. Verifying a credential, a 403 proves it authenticated.
 */
export function fetchOneMissForResponse(httpStatus: number): FetchOneResult {
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: "not_found", reason: "unauthorized" };
  }
  if (httpStatus === 404) {
    return { status: "not_found", reason: "absent" };
  }
  if (httpStatus === 429) {
    return { status: "rate_limited" };
  }
  return { status: "not_found", reason: "upstream_error" };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/fetch-miss-reason.test.ts && bun run typecheck`
Expected: PASS, and typecheck clean — `reason` is optional so no connector breaks yet.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/sync/types.ts packages/gateway/src/connectors/fetch-miss-reason.ts packages/gateway/src/connectors/fetch-miss-reason.test.ts
git commit -m "feat(sync): add FetchMissReason and the shared status mapper"
```

---

### Task 7: Wire github

**Files:**
- Modify: `packages/gateway/src/connectors/github-sync.ts:619-671`
- Test: `packages/gateway/src/connectors/github-sync.test.ts`

**Interfaces:**
- Consumes: `fetchOneMissForResponse`, `FetchMissReason` (Task 6).
- Produces: the per-connector pattern Tasks 8-9 repeat.

- [ ] **Step 1: Write the failing tests**

Update the existing `toEqual({ status: "not_found" })` assertions in `github-sync.test.ts` (lines 71, 87, 97, 117, 179, 191, 258) to assert the specific cause, and add the missing causes. `toEqual` ignores `undefined` keys, so these fail loudly only once `reason` is actually supplied — which is the point.

```ts
test("a 404 reports absent", async () => {
  const db = createMemoryIndexDb();
  const ctx = ctxWithPat(db, "pat-value");
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;
  const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
  const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/999");
  expect(out).toEqual({ status: "not_found", reason: "absent" });
});

test("a 401 reports unauthorized — the expired-PAT case", async () => {
  const db = createMemoryIndexDb();
  const ctx = ctxWithPat(db, "expired-pat");
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response("Bad credentials", { status: 401 }))) as unknown as typeof fetch;
  const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
  const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");
  expect(out).toEqual({ status: "not_found", reason: "unauthorized" });
});

test("a 403 reports unauthorized", async () => {
  const db = createMemoryIndexDb();
  const ctx = ctxWithPat(db, "pat-value");
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response("forbidden", { status: 403 }))) as unknown as typeof fetch;
  const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
  const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");
  expect(out).toEqual({ status: "not_found", reason: "unauthorized" });
});

test("a provider 429 surfaces as rate_limited, not a miss", async () => {
  const db = createMemoryIndexDb();
  const ctx = ctxWithPat(db, "pat-value");
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response("slow down", { status: 429 }))) as unknown as typeof fetch;
  const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
  const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");
  expect(out).toEqual({ status: "rate_limited" });
});

test("a 500 reports upstream_error", async () => {
  const db = createMemoryIndexDb();
  const ctx = ctxWithPat(db, "pat-value");
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch;
  const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
  const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");
  expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
});

test("a missing PAT reports no_credential", async () => {
  const db = createMemoryIndexDb();
  const ctx = ctxWithPat(db, null);
  const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
  const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");
  expect(out).toEqual({ status: "not_found", reason: "no_credential" });
});

test("a transport failure reports unreachable and leaks nothing", async () => {
  const db = createMemoryIndexDb();
  const ctx = ctxWithPat(db, "pat-value");
  globalThis.fetch = ((): Promise<Response> => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.github.com");
  }) as unknown as typeof fetch;
  const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
  const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");
  expect(out).toEqual({ status: "not_found", reason: "unreachable" });
  expect(JSON.stringify(out)).not.toContain("api.github.com");
});

test("an unparseable body reports upstream_error", async () => {
  const db = createMemoryIndexDb();
  const ctx = ctxWithPat(db, "pat-value");
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response("<html>not json</html>", { status: 200 }))) as unknown as typeof fetch;
  const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
  const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");
  expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
});

test("a body missing its identity field reports upstream_error", async () => {
  const db = createMemoryIndexDb();
  const ctx = ctxWithPat(db, "pat-value");
  const noNumber = prPayload();
  delete noNumber["number"];
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(noNumber), { status: 200 }))) as unknown as typeof fetch;
  const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
  const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");
  expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts`
Expected: FAIL — every new assertion sees a bare `{ status: "not_found" }`.

- [ ] **Step 3: Implement**

In `github-sync.ts`, import the mapper and replace each site in `fetchOnePullRequest`:

```ts
import { fetchOneMissForResponse } from "./fetch-miss-reason.ts";
```

- `:626-628` (no PAT) → `return { status: "not_found", reason: "no_credential" };`
- `:640-645` (catch) → keep the comment, change the return to `{ status: "not_found", reason: "unreachable" }`
- `:646-648` (`!res.ok`) → `return fetchOneMissForResponse(res.status);`
- `:650-654` (JSON parse catch) → `{ status: "not_found", reason: "upstream_error" }`
- `:655-658` (`pr === undefined`) → `{ status: "not_found", reason: "upstream_error" }`
- `:662-665` (`num === undefined`) → `{ status: "not_found", reason: "upstream_error" }`

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/github-sync.ts packages/gateway/src/connectors/github-sync.test.ts
git commit -m "feat(github): name the cause of a targeted-fetch miss"
```

---

### Task 8: Wire gitlab and bitbucket

**Files:**
- Modify: `packages/gateway/src/connectors/gitlab-sync.ts:88-135`, `packages/gateway/src/connectors/bitbucket-sync.ts:293-341`
- Test: `packages/gateway/src/connectors/gitlab-sync.test.ts`, `packages/gateway/src/connectors/bitbucket-sync.test.ts`

**Interfaces:**
- Consumes: `fetchOneMissForResponse` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Mirror Task 7's nine cases in each file, using that file's own context helper and payload builder. Update the existing bare assertions: gitlab lines 137, 150, 160, 182, 226, 238, 252; bitbucket lines 74, 84, 98, 118, 236, 248, 262. Identity fields differ — gitlab's is `iid`, bitbucket's is `id` — so the "missing identity field" test deletes the right key in each.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/connectors/gitlab-sync.test.ts packages/gateway/src/connectors/bitbucket-sync.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`gitlab-sync.ts` — import the mapper, then: `:95-97` (no PAT) → `no_credential`; `:111-115` (catch) → `unreachable`; `:116-118` (`!res.ok`) → `fetchOneMissForResponse(res.status)`; `:120-124` (JSON catch) → `upstream_error`; `:126-128` (`mr === undefined`) → `upstream_error`; `:133-135` (`iid === undefined`) → `upstream_error`.

`bitbucket-sync.ts` — same shape: `:301-303` → `no_credential`; `:316-321` → `unreachable`; `:322-324` → `fetchOneMissForResponse(res.status)`; `:326-330` → `upstream_error`; `:331-334` → `upstream_error`; `:339-341` → `upstream_error`.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/gitlab-sync.test.ts packages/gateway/src/connectors/bitbucket-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/gitlab-sync.* packages/gateway/src/connectors/bitbucket-sync.*
git commit -m "feat(gitlab,bitbucket): name the cause of a targeted-fetch miss"
```

---

### Task 9: Wire jenkins and jira

Jenkins needs a genuine split, not a substitution: `:456` fuses `!bRes.ok` with the JSON-shape check in one condition, and those are two different causes.

**Files:**
- Modify: `packages/gateway/src/connectors/jenkins-sync.ts:420-489`, `packages/gateway/src/connectors/jira-sync.ts:549-617`
- Test: `packages/gateway/src/connectors/jenkins-sync.test.ts`, `packages/gateway/src/connectors/jira-sync.test.ts`

**Interfaces:**
- Consumes: `fetchOneMissForResponse` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Mirror Task 7's cases in each file. Update the existing bare assertions: jenkins lines 163, 176, 185, 209, 251, 322, 334, 348; jira lines 884, 894, 906, 926, 1018, 1029, 1040. Two extra cases:

```ts
// jenkins: the build genuinely was not written — an absent row, not an upstream fault.
test("a null upsert reports absent", async () => {
  // Arrange a response that upsertJenkinsBuildRowIfNew returns null for,
  // following the existing null-upsert test in this file.
  expect(out).toEqual({ status: "not_found", reason: "absent" });
});

// jenkins: !ok and a bad body are separate causes and must not share an arm.
test("a 500 reports upstream_error while a 401 reports unauthorized", async () => {
  // two arrangements, two assertions
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/connectors/jenkins-sync.test.ts packages/gateway/src/connectors/jira-sync.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`jenkins-sync.ts` — `:428-437` (any missing vault field) → `no_credential`; `:451-455` (catch) → `unreachable`; `:456-458` splits into:

```ts
  if (!bRes.ok) {
    return fetchOneMissForResponse(bRes.status);
  }
  if (bRes.json === null || typeof bRes.json !== "object") {
    return { status: "not_found", reason: "upstream_error" };
  }
```

`:482-484` (`upserted === null`) → `{ status: "not_found", reason: "absent" }`.

`jira-sync.ts` — `:554-557` (no creds) → `no_credential`; `:581-585` (catch) → `unreachable`; `:586-588` (`!res.ok`) → `fetchOneMissForResponse(res.status)`; `:589-594` (JSON catch) → `upstream_error`; `:595-598` (`issue === undefined`) → `upstream_error`; `:614-617` (missing `key`) → `upstream_error`. Leave the two `unsupported_url` returns at `:552` and `:565` untouched.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/connectors/jenkins-sync.test.ts packages/gateway/src/connectors/jira-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/jenkins-sync.* packages/gateway/src/connectors/jira-sync.*
git commit -m "feat(jenkins,jira): name the cause of a targeted-fetch miss"
```

---

### Task 10: Make `reason` required and surface it on the wire

The flip that proves Tasks 7-9 are complete: with `reason` required, any missed site is a compile error.

**Files:**
- Modify: `packages/gateway/src/sync/types.ts` (drop the `?`)
- Modify: `packages/gateway/src/sync/targeted-fetch.ts:17-23`, `:176-182`, `:208-213`, `:226-229`
- Test: `packages/gateway/src/sync/targeted-fetch.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6-9.
- Produces: `TargetedFetchOutcome` with required `reason` on `not_found` and optional `service` on `not_configured`.

- [ ] **Step 1: Write the failing tests**

Append to `targeted-fetch.test.ts`, following its existing `deps` builder:

```ts
test("the connector's reason reaches the outcome unchanged", async () => {
  const out = await targetedFetch(
    depsWithFetchOne(async () => ({ status: "not_found", reason: "unauthorized" })),
    "https://github.com/o/r/pull/1",
  );
  expect(out).toEqual({ status: "not_found", reason: "unauthorized" });
});

// The two provenances of rate_limited must stay distinguishable in the ledger.
test("a provider 429 answers rate_limited WITH an egress row appended", async () => {
  const rows: unknown[] = [];
  const out = await targetedFetch(
    depsWithFetchOne(async () => ({ status: "rate_limited" }), { onAppend: (r) => rows.push(r) }),
    "https://github.com/o/r/pull/1",
  );
  expect(out).toEqual({ status: "rate_limited" });
  // The request DID leave the machine, so exactly one row is correct.
  expect(rows).toHaveLength(1);
});

test("an acquire timeout answers rate_limited with NO egress row", async () => {
  const rows: unknown[] = [];
  const out = await targetedFetch(
    depsThatNeverAcquire({ onAppend: (r) => rows.push(r) }),
    "https://github.com/o/r/pull/1",
  );
  expect(out).toEqual({ status: "rate_limited" });
  // fetchOne deterministically never ran — claiming egress here would over-claim.
  expect(rows).toEqual([]);
});

test("not_configured names the service when the boundary resolved one", async () => {
  const out = await targetedFetch(
    depsWithNoSyncable("github"),
    "https://github.com/o/r/pull/1",
  );
  expect(out).toEqual({ status: "not_configured", service: "github" });
});

test("not_configured stays bare on a host miss — there is nothing to name", async () => {
  const out = await targetedFetch(depsWithEmptyHostMap(), "https://example.com/x");
  expect(out).toEqual({ status: "not_configured" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/sync/targeted-fetch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `sync/types.ts`, drop the `?`: `{ readonly status: "not_found"; readonly reason: FetchMissReason }`.

Run `bun run typecheck`. Every connector site that still returns a bare `not_found` is now a compile error — fix each by supplying the cause its neighbours use. **Zero errors means Tasks 7-9 covered every site**; a non-zero count is the list of what was missed.

In `targeted-fetch.ts`, update the outcome type at :17-23:

```ts
export type TargetedFetchOutcome =
  | { readonly status: "indexed"; readonly itemId: string }
  | { readonly status: "not_found"; readonly reason: FetchMissReason }
  | { readonly status: "unsupported_url" }
  | { readonly status: "no_targeted_fetch"; readonly service: string }
  | { readonly status: "not_configured"; readonly service?: string }
  | { readonly status: "rate_limited" };
```

At `:226-229`, name the service the boundary already resolved:

```ts
  const syncable = deps.syncableFor(service);
  if (syncable === undefined) {
    // The boundary already resolved a service here, so naming it is a fact, not a
    // guess. The host-miss return above stays bare: there is genuinely nothing to
    // name, and guessing is what the boundary exists to refuse.
    return { status: "not_configured", service };
  }
```

Leave `:208-213` (host miss) returning a bare `{ status: "not_configured" }`.

Correct the doc comment at `:176-182` — it currently implies `rate_limited` ⇒ no egress row, which is no longer true:

```
 *   4. Acquire a rate-limit token from the SAME bucket the scheduler uses, polling the
 *      non-blocking `tryAcquire` (bounded by a timeout) rather than the blocking `acquire`. A
 *      timeout returns `rate_limited` and appends NOTHING — `fetchOne` deterministically never
 *      runs past this point, so there is nothing to record. NOTE `rate_limited` has a SECOND
 *      provenance: a connector's `fetchOne` returns it for a provider 429, and that one DOES
 *      carry an appended row, because the request genuinely left the machine. Both are correct
 *      for I29 — the ledger records real egress in both cases — so do not read this arm as
 *      "no egress row".
```

- [ ] **Step 4: Run the full sync and connector suites**

Run: `bun test packages/gateway/src/sync/ packages/gateway/src/connectors/`
Expected: PASS.

- [ ] **Step 5: Verify the invariant and route tests still hold**

Run: `bun test packages/gateway/src/security-invariants.test.ts packages/gateway/src/ipc/http-route-auth.test.ts packages/gateway/src/ipc/http-write-routes.test.ts`
Expected: PASS. Route auth keys on the route string (`http-route-auth.ts:96`) and I29 constrains only that a row is appended before dispatch, so an added response field touches neither — confirm rather than assume.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/sync/ packages/gateway/src/connectors/
git commit -m "feat(sync): require a miss reason and surface it on the fetch wire"
```

---

### Task 11: Docs, changelog, and the green bar

**Files:**
- Modify: `docs/CHANGELOG.md`, `docs/architecture.md` (targeted-fetch response shape, if documented)

- [ ] **Step 1: Find every place the old shape is documented**

Run: `grep -rn "not_targeted_fetch\|no_targeted_fetch\|not_configured\|items/fetch" docs/ packages/docs/src/ | grep -v CHANGELOG`
Update each hit that shows the response shape.

- [ ] **Step 2: Add the CHANGELOG entry**

Per the project convention, connector/behaviour deliveries go in `docs/CHANGELOG.md`, not the CLAUDE.md status line. Record both PRs under today's date.

- [ ] **Step 3: Run the full gate set**

Run: `bun run preflight`
Expected: PASS. Not `test:ci` — that is only the test suite, not the gate set.

- [ ] **Step 4: Check the coverage floor properly**

Run the Docker-Linux lcov build (`audit:coverage-floor` is CI-Linux-authoritative; on Windows it reports false violations). Tar into the container rather than bind-mounting the repo — a `-v repo:/w` mount yields garbage.
Expected: `fetch-miss-reason.ts` and `credential-probe.ts` both ≥85% line / ≥80% branch.

- [ ] **Step 5: Commit and open PR 2**

```bash
git add -A
git commit -m "docs: record the targeted-fetch miss-reason wire change"
```

Title: `fix(sync): distinguish a dead credential from an absent item on targeted fetch`

The body **must** carry the client-coordination note, because `nimbus-web-clipper`'s parser is fail-closed on unknown `status`:

> **Wire change — additive only, no new `status` arm.** `not_found` now carries `reason: "no_credential" | "unauthorized" | "absent" | "unreachable" | "upstream_error"`. `not_configured` may carry `service`. A provider 429 now arrives as the already-handled `rate_limited` arm rather than as `not_found`. Old clients ignore the new fields and keep working; `nimbus-web-clipper` can follow up to render them.

---

## Self-Review

**Spec coverage:** `FetchMissReason` → Task 6. Shared mapper → Task 6. Five connectors → Tasks 7-9. Required flip + `TargetedFetchOutcome` + `not_configured.service` + the `rate_limited` doc-comment correction → Task 10. Probe module + timeout + no-rate-limiter → Task 2. Probe-before-write ordering → Task 3 (red-proven at Step 5). Health clearing → Tasks 1 and 4. `verified` on the response → Task 3. CLI output + exit codes → Task 5. Docs/CHANGELOG → Task 11.

**Deliberately not in any task** (deferred in the spec, with reasons): `X-OAuth-Scopes` reporting; E2E mock servers; Vault write atomicity; the GitLab/Jenkins/Bitbucket `UnauthenticatedError` gap; a never-synced connector reporting `healthy`.

**Ordering note:** `reason` is optional from Task 6 through Task 9 so every task ends green, then becomes required in Task 10. That flip is the completeness check — the typecheck error list at Task 10 Step 3 is the authoritative answer to "did I wire every site", not anyone's reading of the diff.
