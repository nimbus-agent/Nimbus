# OAuth Provider Registry (PR-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the four existing 3-legged OAuth providers (google, microsoft, slack, notion) behind one data-driven registry, with **zero behavior change** — proven by keeping every existing `auth/*.test.ts` green — so that PR-2 can add Zoom as a fifth registry entry.

**Architecture:** A new `auth/oauth-registry.ts` holds an `OAuthProviderDescriptor` per provider plus the generic engine functions (`buildAuthorizeUrl`, `exchangeAuthorizationCode`, `refreshViaRegistry`, `getValidVaultAccessToken` with a single-flight refresh lock). `auth/pkce.ts` becomes a thin public facade that delegates to the registry, keeping its existing exported signatures (`runPKCEFlow`, `refreshAccessToken`, `pkceCodeChallengeS256`) so no import site changes. The four resolver modules (`oauth-vault-tokens.ts`, `notion-access-token.ts`, `slack-access-token.ts`, `google-access-token.ts`) keep their public signatures and delegate token-validity to `getValidVaultAccessToken`.

**Tech Stack:** Bun + TypeScript 6 strict, `bun test`, Biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-27-zoom-connector-oauth-registry-design.md` §1.

**Branch:** `dev/asafgolombek/connector-buildout-rest` (existing worktree). This PR adds **no Zoom code** — Zoom is PR-2.

---

## Pre-flight conventions (read once)

- All commands run from the worktree root `C:\gitrep\Nimbus\.worktrees\connector-buildout-rest` using **PowerShell** (the Bash tool mangles `C:\` paths). Do **not** prefix with `cd`.
- `bun run typecheck` always shows a **pre-existing** `nimbus-vscode` `Cannot find module '@nimbus-dev/client'` failure — **ignore it**; only `gateway` matters for this PR.
- `bun test` does **not** typecheck — run `bun run typecheck` separately.
- The behavior-preservation contract is: **these six files stay green unchanged** — `packages/gateway/src/auth/pkce.test.ts`, `google-access-token.test.ts`, `notion-access-token.test.ts`, `slack-access-token.test.ts`, `oauth-vault-tokens.test.ts`, `oauth-vault-scopes.test.ts`. If a refactor step needs to edit any of those six, **stop** — that means the refactor changed behavior.
- Commit after each task. End every commit message with:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

## File structure

- **Create** `packages/gateway/src/auth/oauth-registry.ts` — descriptor type, `OAUTH_PROVIDERS` table, generic engine functions, single-flight lock. Also holds the pure parse helpers moved out of `pkce.ts`.
- **Create** `packages/gateway/src/auth/oauth-registry.test.ts` — per-descriptor + single-flight unit tests.
- **Modify** `packages/gateway/src/auth/pkce.ts` — becomes a thin facade delegating to the registry; deletes the per-provider `build*AuthorizeUrl`/`exchange*`/`run*OnLocalPort` helpers; keeps the `runPKCEFlow`/`refreshAccessToken`/`refreshSlackUserToken`/`refreshNotionToken`/`pkceCodeChallengeS256` export names.
- **Modify** `packages/gateway/src/auth/oauth-vault-tokens.ts` — `getValidVaultOAuthAccessToken` delegates to the registry resolver.
- **Modify** `packages/gateway/src/auth/notion-access-token.ts`, `slack-access-token.ts`, `google-access-token.ts` — delegate token validity to the registry resolver; keep signatures.
- **Modify** `scripts/structure-audit/check-nimbus-invariants.ts` — add `auth/oauth-registry.ts` to `VAULT_KEY_ALLOW_LIST`.

---

## Task 0: Baseline green

**Files:** none (verification only).

- [ ] **Step 1: Confirm the six auth test files pass before any change**

Run: `bun test packages/gateway/src/auth/`
Expected: PASS (all files green). Record the pass count — it must not drop for the rest of this PR.

- [ ] **Step 2: Confirm gateway typecheck baseline**

Run: `bun run typecheck`
Expected: only the pre-existing `nimbus-vscode` `@nimbus-dev/client` error; no `packages/gateway` errors.

---

## Task 1: Descriptor type + empty registry module

**Files:**
- Create: `packages/gateway/src/auth/oauth-registry.ts`
- Create: `packages/gateway/src/auth/oauth-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/auth/oauth-registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { OAUTH_PROVIDERS } from "./oauth-registry.ts";

describe("OAUTH_PROVIDERS table", () => {
  test("has an entry for every existing provider with its vault key", () => {
    expect(OAUTH_PROVIDERS.google.vaultKey).toBe("google.oauth");
    expect(OAUTH_PROVIDERS.microsoft.vaultKey).toBe("microsoft.oauth");
    expect(OAUTH_PROVIDERS.slack.vaultKey).toBe("slack.oauth");
    expect(OAUTH_PROVIDERS.notion.vaultKey).toBe("notion.oauth");
  });

  test("each descriptor's id matches its table key", () => {
    for (const [key, d] of Object.entries(OAUTH_PROVIDERS)) {
      expect(d.id).toBe(key);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: FAIL — `Cannot find module './oauth-registry.ts'`.

- [ ] **Step 3: Create the descriptor type + empty-bodied table**

Create `packages/gateway/src/auth/oauth-registry.ts`. Define the types and a table whose `buildAuthorizeParams`/`parseTokenResponse` are filled in Tasks 2–3 (for now, throwing stubs are acceptable because the Task 1 test only reads `id`/`vaultKey`). Use the existing `OAuthProvider` union and `PKCEResult` from `./pkce.ts` (re-exported), but to avoid a circular import, define the union here and have `pkce.ts` import it in Task 6.

```ts
import { validateVaultKeyOrThrow } from "../vault/key-format.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export type OAuthProvider = "google" | "microsoft" | "slack" | "notion";

export interface PKCEResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export type RegistryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AuthorizeArgs {
  clientId: string;
  scopes: string[];
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}

type ClientSecretMode = "none" | "optional" | "required";

export interface OAuthProviderDescriptor {
  id: OAuthProvider;
  vaultKey: string;
  authorizeUrl: string;
  tokenUrl: string;
  usesPkce: boolean;
  clientSecret: ClientSecretMode;
  secretPlacement: "body" | "basic_header";
  bodyFormat: "form" | "json";
  tokenHeaders?: Readonly<Record<string, string>>;
  mirrorPerService: boolean;
  buildAuthorizeParams(a: AuthorizeArgs): Record<string, string>;
  parseTokenResponse(json: unknown, requestedScopes: string[]): PKCEResult;
  /** Default success = HTTP ok; Slack overrides to require `ok: true`. */
  isTokenSuccess?(json: unknown, httpOk: boolean): boolean;
}

const STUB = (): never => {
  throw new Error("descriptor hook not yet implemented");
};

export const OAUTH_PROVIDERS: Record<OAuthProvider, OAuthProviderDescriptor> = {
  google: {
    id: "google",
    vaultKey: "google.oauth",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    usesPkce: true,
    clientSecret: "optional",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: true,
    buildAuthorizeParams: STUB,
    parseTokenResponse: STUB,
  },
  microsoft: {
    id: "microsoft",
    vaultKey: "microsoft.oauth",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    usesPkce: true,
    clientSecret: "none",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: true,
    buildAuthorizeParams: STUB,
    parseTokenResponse: STUB,
  },
  slack: {
    id: "slack",
    vaultKey: "slack.oauth",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    usesPkce: true,
    clientSecret: "none",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: STUB,
    parseTokenResponse: STUB,
  },
  notion: {
    id: "notion",
    vaultKey: "notion.oauth",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    usesPkce: false,
    clientSecret: "required",
    secretPlacement: "basic_header",
    bodyFormat: "json",
    tokenHeaders: { "Notion-Version": "2022-06-28" },
    mirrorPerService: false,
    buildAuthorizeParams: STUB,
    parseTokenResponse: STUB,
  },
};

// Re-exported so callers keep a single import surface. Used in later tasks.
export { validateVaultKeyOrThrow };
export type { NimbusVault };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```powershell
git add packages/gateway/src/auth/oauth-registry.ts packages/gateway/src/auth/oauth-registry.test.ts
git commit -m @'
feat(auth): OAuth provider registry — descriptor type + provider table skeleton

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 2: Pure parse helpers + google/microsoft hooks

**Files:**
- Modify: `packages/gateway/src/auth/oauth-registry.ts`
- Modify: `packages/gateway/src/auth/oauth-registry.test.ts`

These hooks must reproduce the *exact* current behavior from `pkce.ts` (`buildPkceAuthorizeUrl`, `parseTokenJson`, `scopesFromTokenResponse`).

- [ ] **Step 1: Write the failing tests**

Append to `oauth-registry.test.ts`:

```ts
describe("google/microsoft descriptor hooks", () => {
  test("google authorize params include offline + consent + PKCE", () => {
    const p = OAUTH_PROVIDERS.google.buildAuthorizeParams({
      clientId: "cid",
      scopes: ["openid", "email"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("openid email");
    expect(p["access_type"]).toBe("offline");
    expect(p["prompt"]).toBe("consent");
    expect(p["code_challenge"]).toBe("cc");
    expect(p["code_challenge_method"]).toBe("S256");
  });

  test("microsoft authorize params omit google-only extras", () => {
    const p = OAUTH_PROVIDERS.microsoft.buildAuthorizeParams({
      clientId: "cid",
      scopes: ["Calendars.Read"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["access_type"]).toBeUndefined();
    expect(p["prompt"]).toBeUndefined();
    expect(p["scope"]).toBe("Calendars.Read");
  });

  test("standard parseTokenResponse maps fields and falls back scope to requested", () => {
    const r = OAUTH_PROVIDERS.google.parseTokenResponse(
      { access_token: "a", refresh_token: "r", expires_in: 3600 },
      ["openid"],
    );
    expect(r.accessToken).toBe("a");
    expect(r.refreshToken).toBe("r");
    expect(r.scopes).toEqual(["openid"]);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: FAIL — `descriptor hook not yet implemented`.

- [ ] **Step 3: Add the pure helpers + standard hook, wire google/microsoft**

In `oauth-registry.ts`, add these pure helpers (lifted verbatim from `pkce.ts`) above the table, and replace the google/microsoft `buildAuthorizeParams`/`parseTokenResponse` stubs:

```ts
type OAuthTokenJson = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
};

function parseExpiresInSeconds(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number.parseInt(raw, 10);
  return Number.NaN;
}

function scopesFromTokenResponse(scopeField: string | undefined, requested: string[]): string[] {
  if (scopeField !== undefined && scopeField.trim() !== "") {
    return scopeField.split(/\s+/).filter((s) => s.length > 0);
  }
  return requested;
}

/** Standard OAuth2 form-token response → PKCEResult (google/microsoft/zoom). */
export function parseStandardTokenResponse(json: unknown, requested: string[]): PKCEResult {
  if (json === null || typeof json !== "object") {
    throw new Error("Token response was not valid JSON");
  }
  const o = json as OAuthTokenJson;
  const access = o.access_token;
  if (typeof access !== "string" || access.length === 0) {
    throw new Error("Token response missing access_token");
  }
  const expiresIn = parseExpiresInSeconds(o.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn < 0) {
    throw new Error("Token response missing expires_in");
  }
  const refresh = o.refresh_token;
  const scope = typeof o.scope === "string" ? o.scope : undefined;
  return {
    accessToken: access,
    refreshToken: typeof refresh === "string" ? refresh : "",
    expiresAt: Date.now() + Math.floor(expiresIn * 1000),
    scopes: scopesFromTokenResponse(scope, requested),
  };
}
```

Replace the google hooks:

```ts
    buildAuthorizeParams: (a) => ({
      client_id: a.clientId,
      redirect_uri: a.redirectUri,
      response_type: "code",
      scope: a.scopes.join(" "),
      state: a.state,
      ...(a.codeChallenge !== undefined
        ? { code_challenge: a.codeChallenge, code_challenge_method: "S256" }
        : {}),
      access_type: "offline",
      prompt: "consent",
    }),
    parseTokenResponse: parseStandardTokenResponse,
```

Replace the microsoft hooks (same minus the google-only `access_type`/`prompt`):

```ts
    buildAuthorizeParams: (a) => ({
      client_id: a.clientId,
      redirect_uri: a.redirectUri,
      response_type: "code",
      scope: a.scopes.join(" "),
      state: a.state,
      ...(a.codeChallenge !== undefined
        ? { code_challenge: a.codeChallenge, code_challenge_method: "S256" }
        : {}),
    }),
    parseTokenResponse: parseStandardTokenResponse,
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/gateway/src/auth/oauth-registry.ts packages/gateway/src/auth/oauth-registry.test.ts
git commit -m @'
feat(auth): registry — google/microsoft authorize params + standard token parse

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 3: slack + notion hooks (the outliers)

**Files:**
- Modify: `packages/gateway/src/auth/oauth-registry.ts`
- Modify: `packages/gateway/src/auth/oauth-registry.test.ts`

Reproduce `buildSlackAuthorizeUrl` / `pkceResultFromSlackOAuthV2Access` / `buildNotionAuthorizeUrl` / `pkceResultFromNotionTokenJson` exactly.

- [ ] **Step 1: Write the failing tests**

Append to `oauth-registry.test.ts`:

```ts
describe("slack descriptor hooks", () => {
  test("authorize params use user_scope (comma) + empty scope", () => {
    const p = OAUTH_PROVIDERS.slack.buildAuthorizeParams({
      clientId: "123.456",
      scopes: ["channels:read", "channels:history"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["user_scope"]).toBe("channels:read,channels:history");
    expect(p["scope"]).toBe("");
    expect(p["code_challenge_method"]).toBe("S256");
  });

  test("parseTokenResponse reads authed_user.access_token", () => {
    const r = OAUTH_PROVIDERS.slack.parseTokenResponse(
      { ok: true, authed_user: { access_token: "xoxp-a", refresh_token: "xoxe-r", expires_in: 3600, scope: "channels:read" } },
      ["channels:read"],
    );
    expect(r.accessToken).toBe("xoxp-a");
    expect(r.refreshToken).toBe("xoxe-r");
    expect(r.scopes).toEqual(["channels:read"]);
  });

  test("isTokenSuccess requires ok:true even on HTTP 200", () => {
    expect(OAUTH_PROVIDERS.slack.isTokenSuccess?.({ ok: false }, true)).toBe(false);
    expect(OAUTH_PROVIDERS.slack.isTokenSuccess?.({ ok: true }, true)).toBe(true);
  });
});

describe("notion descriptor hooks", () => {
  test("authorize params set owner=user, no PKCE challenge", () => {
    const p = OAUTH_PROVIDERS.notion.buildAuthorizeParams({
      clientId: "cid",
      scopes: [],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
    });
    expect(p["owner"]).toBe("user");
    expect(p["response_type"]).toBe("code");
    expect(p["code_challenge"]).toBeUndefined();
  });

  test("parseTokenResponse uses synthetic 24h expiry when expires_in absent", () => {
    const before = Date.now();
    const r = OAUTH_PROVIDERS.notion.parseTokenResponse(
      { access_token: "secret_a", refresh_token: "secret_r" },
      ["x"],
    );
    expect(r.accessToken).toBe("secret_a");
    expect(r.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000 - 5000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: FAIL — `descriptor hook not yet implemented`.

- [ ] **Step 3: Implement slack + notion hooks**

Add these pure parsers to `oauth-registry.ts` and wire them into the slack/notion descriptors:

```ts
export function parseSlackTokenResponse(json: unknown, requested: string[]): PKCEResult {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Invalid Slack OAuth response");
  }
  const au = (json as Record<string, unknown>)["authed_user"];
  if (au === null || typeof au !== "object" || Array.isArray(au)) {
    throw new Error("Slack OAuth response missing authed_user");
  }
  const user = au as Record<string, unknown>;
  const access = user["access_token"];
  if (typeof access !== "string" || access === "") {
    throw new Error("Slack user access token missing");
  }
  const refresh = user["refresh_token"];
  const refreshTok = typeof refresh === "string" && refresh !== "" ? refresh : "";
  if (refreshTok === "") {
    throw new Error(
      "Slack refresh token missing; enable token rotation on the Slack app and re-authorize",
    );
  }
  const expIn = user["expires_in"];
  let expiresSec = Number.NaN;
  if (typeof expIn === "number" && Number.isFinite(expIn)) expiresSec = expIn;
  else if (typeof expIn === "string") expiresSec = Number.parseInt(expIn, 10);
  const safeExpires = Number.isFinite(expiresSec) && expiresSec > 0 ? expiresSec : 43_200;
  const scopeStr = user["scope"];
  const scopes =
    typeof scopeStr === "string" && scopeStr.trim() !== ""
      ? scopeStr.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0)
      : requested;
  return {
    accessToken: access,
    refreshToken: refreshTok,
    expiresAt: Date.now() + Math.floor(safeExpires * 1000),
    scopes,
  };
}

export function parseNotionTokenResponse(json: unknown, requested: string[]): PKCEResult {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Notion token response invalid");
  }
  const o = json as { access_token?: unknown; refresh_token?: unknown };
  const access = o.access_token;
  if (typeof access !== "string" || access === "") {
    throw new Error("Notion token response missing access_token");
  }
  const refresh = o.refresh_token;
  const refreshStr = typeof refresh === "string" && refresh !== "" ? refresh : "";
  return {
    accessToken: access,
    refreshToken: refreshStr,
    expiresAt: Date.now() + 86_400 * 1000,
    scopes: requested,
  };
}
```

Slack descriptor hooks:

```ts
    buildAuthorizeParams: (a) => ({
      client_id: a.clientId,
      user_scope: a.scopes.join(","),
      redirect_uri: a.redirectUri,
      state: a.state,
      scope: "",
      ...(a.codeChallenge !== undefined
        ? { code_challenge: a.codeChallenge, code_challenge_method: "S256" }
        : {}),
    }),
    parseTokenResponse: parseSlackTokenResponse,
    isTokenSuccess: (json) =>
      json !== null && typeof json === "object" && (json as { ok?: unknown }).ok === true,
```

Notion descriptor hooks:

```ts
    buildAuthorizeParams: (a) => ({
      client_id: a.clientId,
      redirect_uri: a.redirectUri,
      response_type: "code",
      owner: "user",
      state: a.state,
    }),
    parseTokenResponse: parseNotionTokenResponse,
```

> Note: the Notion exchange historically rejects a missing refresh token at *initial* exchange (`allowNullRefresh=false`) but allows it at refresh. The generic exchange in Task 4 enforces the initial-refresh-required rule via `clientSecret === "required"` providers; `parseNotionTokenResponse` itself stays lenient (matches `refreshNotionToken`). Behavior parity is verified by the existing `notion-access-token.test.ts` in Task 8.

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/gateway/src/auth/oauth-registry.ts packages/gateway/src/auth/oauth-registry.test.ts
git commit -m @'
feat(auth): registry — slack (authed_user/ok) + notion (synthetic expiry) hooks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 4: Generic authorize-URL + token exchange

**Files:**
- Modify: `packages/gateway/src/auth/oauth-registry.ts`
- Modify: `packages/gateway/src/auth/oauth-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `oauth-registry.test.ts`:

```ts
import { buildAuthorizeUrl, exchangeAuthorizationCode } from "./oauth-registry.ts";

describe("buildAuthorizeUrl", () => {
  test("notion exchange posts JSON with Basic auth header; no token leaks on error", async () => {
    let seenAuth = "";
    let seenCT = "";
    const fetchImpl = async (_i: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seenAuth = h.get("authorization") ?? "";
      seenCT = h.get("content-type") ?? "";
      return new Response(JSON.stringify({ access_token: "secret_a", refresh_token: "secret_r" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const r = await exchangeAuthorizationCode({
      descriptor: OAUTH_PROVIDERS.notion,
      fetchFn: fetchImpl,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      authCode: "code",
      requestedScopes: [],
    });
    expect(r.accessToken).toBe("secret_a");
    expect(seenAuth.startsWith("Basic ")).toBe(true);
    expect(seenCT).toContain("application/json");
  });

  test("google exchange posts form with client_secret in body; HTTP error message omits secrets", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    let threw = "";
    try {
      await exchangeAuthorizationCode({
        descriptor: OAUTH_PROVIDERS.google,
        fetchFn: fetchImpl,
        clientId: "cid",
        clientSecret: "GOOGLE_WEB_SECRET",
        redirectUri: "http://127.0.0.1:1/oauth/callback",
        codeVerifier: "ver",
        authCode: "code",
        requestedScopes: ["openid"],
      });
    } catch (e) {
      threw = String(e instanceof Error ? e.message : e);
    }
    expect(threw).toContain("invalid_grant");
    expect(threw.includes("GOOGLE_WEB_SECRET")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: FAIL — `buildAuthorizeUrl`/`exchangeAuthorizationCode` not exported.

- [ ] **Step 3: Implement the generic engine**

Add to `oauth-registry.ts`:

```ts
export function buildAuthorizeUrl(d: OAuthProviderDescriptor, a: AuthorizeArgs): URL {
  const url = new URL(d.authorizeUrl);
  for (const [k, v] of Object.entries(d.buildAuthorizeParams(a))) {
    url.searchParams.set(k, v);
  }
  return url;
}

/** OAuth2 token-error JSON → user-safe summary (no secrets). */
function tokenErrorSummary(json: unknown): string | undefined {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return undefined;
  const o = json as Record<string, unknown>;
  const err = o["error"];
  if (typeof err !== "string" || err.length === 0) return undefined;
  const desc = o["error_description"];
  return typeof desc === "string" && desc.trim() !== "" ? `${err}: ${desc.trim()}` : err;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

interface TokenRequest {
  descriptor: OAuthProviderDescriptor;
  fetchFn: RegistryFetch;
  clientId: string;
  clientSecret?: string;
  grant: Record<string, string>;
  requestedScopes: string[];
}

async function postToken(req: TokenRequest): Promise<PKCEResult> {
  const d = req.descriptor;
  const headers: Record<string, string> = { ...(d.tokenHeaders ?? {}) };
  const fields: Record<string, string> = { client_id: req.clientId, ...req.grant };

  if (d.secretPlacement === "basic_header" && req.clientSecret !== undefined && req.clientSecret !== "") {
    headers["Authorization"] = basicAuthHeader(req.clientId, req.clientSecret);
  } else if (d.secretPlacement === "body" && req.clientSecret !== undefined && req.clientSecret !== "") {
    fields["client_secret"] = req.clientSecret;
  }

  let body: string;
  if (d.bodyFormat === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(fields);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) p.set(k, v);
    body = p.toString();
  }

  const res = await req.fetchFn(d.tokenUrl, { method: "POST", headers, body });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Token endpoint returned non-JSON");
  }
  const httpOk = res.ok;
  const success = d.isTokenSuccess ? d.isTokenSuccess(parsed, httpOk) : httpOk;
  if (!success) {
    const hint = tokenErrorSummary(parsed);
    throw new Error(hint === undefined ? "Token exchange failed" : `Token exchange failed (${hint})`);
  }
  return d.parseTokenResponse(parsed, req.requestedScopes);
}

export interface ExchangeArgs {
  descriptor: OAuthProviderDescriptor;
  fetchFn: RegistryFetch;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier?: string;
  authCode: string;
  requestedScopes: string[];
}

export async function exchangeAuthorizationCode(a: ExchangeArgs): Promise<PKCEResult> {
  const grant: Record<string, string> = {
    grant_type: "authorization_code",
    code: a.authCode,
    redirect_uri: a.redirectUri,
  };
  if (a.descriptor.usesPkce && a.codeVerifier !== undefined) {
    grant["code_verifier"] = a.codeVerifier;
  }
  return postToken({
    descriptor: a.descriptor,
    fetchFn: a.fetchFn,
    clientId: a.clientId,
    ...(a.clientSecret !== undefined && { clientSecret: a.clientSecret }),
    grant,
    requestedScopes: a.requestedScopes,
  });
}

export { postToken };
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/gateway/src/auth/oauth-registry.ts packages/gateway/src/auth/oauth-registry.test.ts
git commit -m @'
feat(auth): registry — generic authorize-URL builder + token exchange engine

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 5: Generic refresh + `getValidVaultAccessToken` with single-flight lock

**Files:**
- Modify: `packages/gateway/src/auth/oauth-registry.ts`
- Modify: `packages/gateway/src/auth/oauth-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `oauth-registry.test.ts`:

```ts
import { createMemoryVault } from "../testing/bun-test-support.ts";
import { getValidVaultAccessToken, refreshViaRegistry } from "./oauth-registry.ts";

describe("refreshViaRegistry", () => {
  test("persists merged refresh token (refresh_token ?? old) to the vault key", async () => {
    const vault = createMemoryVault();
    const r = await refreshViaRegistry({
      descriptor: OAUTH_PROVIDERS.microsoft,
      refreshToken: "old-refresh",
      clientId: "cid",
      vault,
      fetchFn: async () =>
        new Response(JSON.stringify({ access_token: "new-access", expires_in: 120 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(r.accessToken).toBe("new-access");
    expect(r.refreshToken).toBe("old-refresh");
    expect(await vault.get("microsoft.oauth")).toContain("new-access");
  });
});

describe("getValidVaultAccessToken single-flight", () => {
  test("two concurrent near-expiry calls trigger exactly one refresh", async () => {
    const vault = createMemoryVault();
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({ accessToken: "old", refreshToken: "r", expiresAt: 0 }),
    );
    let refreshCalls = 0;
    const fetchFn = async () => {
      refreshCalls += 1;
      await new Promise((res) => setTimeout(res, 20));
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const [a, b] = await Promise.all([
      getValidVaultAccessToken({ descriptor: OAUTH_PROVIDERS.microsoft, vault, clientId: "cid", fetchFn }),
      getValidVaultAccessToken({ descriptor: OAUTH_PROVIDERS.microsoft, vault, clientId: "cid", fetchFn }),
    ]);
    expect(a).toBe("fresh");
    expect(b).toBe("fresh");
    expect(refreshCalls).toBe(1);
  });

  test("returns cached token without refresh when not near expiry", async () => {
    const vault = createMemoryVault();
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({ accessToken: "cached", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
    );
    const token = await getValidVaultAccessToken({
      descriptor: OAUTH_PROVIDERS.microsoft,
      vault,
      clientId: "cid",
      fetchFn: async () => {
        throw new Error("must not refresh on a cache hit");
      },
    });
    expect(token).toBe("cached");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: FAIL — `refreshViaRegistry`/`getValidVaultAccessToken` not exported.

- [ ] **Step 3: Implement refresh + resolver + single-flight**

Add to `oauth-registry.ts`. Reuse `parseStoredOAuthTokens` from `./oauth-vault-tokens.ts` for reading the stored payload (it already validates shape and is unit-tested).

```ts
import { parseStoredOAuthTokens } from "./oauth-vault-tokens.ts";

async function persistTokens(vault: NimbusVault, vaultKey: string, r: PKCEResult): Promise<void> {
  validateVaultKeyOrThrow(vaultKey);
  await vault.set(
    vaultKey,
    JSON.stringify({
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      expiresAt: r.expiresAt,
      scopes: r.scopes,
    }),
  );
}

export interface RefreshArgs {
  descriptor: OAuthProviderDescriptor;
  refreshToken: string;
  clientId: string;
  vault: NimbusVault;
  clientSecret?: string;
  fetchFn?: RegistryFetch;
  /** Persist to this key instead of descriptor.vaultKey (Google per-service keys). */
  persistVaultKey?: string;
}

export async function refreshViaRegistry(a: RefreshArgs): Promise<PKCEResult> {
  const fetchFn: RegistryFetch = a.fetchFn ?? ((i, init) => globalThis.fetch(i, init));
  const partial = await postToken({
    descriptor: a.descriptor,
    fetchFn,
    clientId: a.clientId,
    ...(a.clientSecret !== undefined && { clientSecret: a.clientSecret }),
    grant: { grant_type: "refresh_token", refresh_token: a.refreshToken },
    requestedScopes: [],
  });
  const result: PKCEResult = {
    ...partial,
    refreshToken: partial.refreshToken === "" ? a.refreshToken : partial.refreshToken,
  };
  const key =
    a.persistVaultKey !== undefined && a.persistVaultKey.trim() !== ""
      ? a.persistVaultKey.trim()
      : a.descriptor.vaultKey;
  await persistTokens(a.vault, key, result);
  return result;
}

const REFRESH_MARGIN_MS = 120_000;
// Single-flight: coalesce concurrent refreshes for the same persisted token.
const inFlightRefresh = new Map<string, Promise<string>>();

export interface GetValidArgs {
  descriptor: OAuthProviderDescriptor;
  vault: NimbusVault;
  clientId: string;
  clientSecret?: string;
  /** Read/persist key override (Google per-service); defaults to descriptor.vaultKey. */
  vaultKey?: string;
  notConfiguredError?: string;
  parseErrors?: Parameters<typeof parseStoredOAuthTokens>[1];
  emptyClientIdError?: string;
  fetchFn?: RegistryFetch;
}

export async function getValidVaultAccessToken(a: GetValidArgs): Promise<string> {
  const vaultKey = a.vaultKey ?? a.descriptor.vaultKey;
  const raw = await a.vault.get(vaultKey);
  if (raw === null || raw === "") {
    throw new Error(a.notConfiguredError ?? `${a.descriptor.id} OAuth not configured`);
  }
  const parseErrors = a.parseErrors ?? {
    invalidJson: `Invalid ${vaultKey} vault payload`,
    invalidPayload: `Invalid ${vaultKey} vault payload`,
    missingAccess: `Missing ${a.descriptor.id} access token`,
    missingRefresh: `Missing ${a.descriptor.id} refresh token`,
    missingExpiry: "Missing token expiry",
  };
  const parsed = parseStoredOAuthTokens(raw, parseErrors);
  if (parsed.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return parsed.accessToken;
  }
  if (a.clientId === "") {
    throw new Error(a.emptyClientIdError ?? `Missing client id for ${a.descriptor.id} token refresh`);
  }
  const existing = inFlightRefresh.get(vaultKey);
  if (existing !== undefined) return existing;
  const p = (async () => {
    const next = await refreshViaRegistry({
      descriptor: a.descriptor,
      refreshToken: parsed.refreshToken,
      clientId: a.clientId,
      vault: a.vault,
      ...(a.clientSecret !== undefined && { clientSecret: a.clientSecret }),
      ...(a.vaultKey !== undefined && { persistVaultKey: a.vaultKey }),
      ...(a.fetchFn !== undefined && { fetchFn: a.fetchFn }),
    });
    return next.accessToken;
  })().finally(() => {
    inFlightRefresh.delete(vaultKey);
  });
  inFlightRefresh.set(vaultKey, p);
  return p;
}
```

> The `inFlightRefresh` map keys by `vaultKey`, so Google's per-service keys (`google_drive.oauth`, …) each get their own single-flight slot — correct, since they hold distinct tokens.

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: PASS (all tasks 1–5 tests, including the single-flight `refreshCalls === 1`).

- [ ] **Step 5: Commit**

```powershell
git add packages/gateway/src/auth/oauth-registry.ts packages/gateway/src/auth/oauth-registry.test.ts
git commit -m @'
feat(auth): registry — generic refresh + getValidVaultAccessToken w/ single-flight lock

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 6: Make `pkce.ts` a thin facade over the registry

**Files:**
- Modify: `packages/gateway/src/auth/pkce.ts`

Goal: `runPKCEFlow` keeps its signature and behavior but delegates to the registry; delete `buildPkceAuthorizeUrl`, `buildSlackAuthorizeUrl`, `buildNotionAuthorizeUrl`, `exchangePkceAuthorizationCode`, `exchangeNotionAuthorizationCode`, `exchangeSlackAuthorizationCode`, `runSlackOAuthOnLocalPort`, `runNotionOAuthOnLocalPort`, and the now-duplicated parse helpers. Keep the port-binding/callback-server logic (`buildPortSequence`, `handlePkceCallbackRequest`, `runOnLocalPort` shell, `runPKCEFlow`). Re-export `OAuthProvider`, `PKCEResult` from the registry so existing importers are unaffected.

- [ ] **Step 1: Rewrite `runOnLocalPort` to be provider-agnostic**

In `pkce.ts`, replace the three per-provider `runOnLocalPort` branches with one registry-driven body:

```ts
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type PKCEResult,
} from "./oauth-registry.ts";

async function runOnLocalPort(
  options: PKCEOptions,
  bindPort: number,
  fetchFn: PKCEFetch,
): Promise<PKCEResult> {
  const descriptor = OAUTH_PROVIDERS[options.provider];
  const usePkce = descriptor.usesPkce;
  const codeVerifier = usePkce ? randomUrlSafeString(32) : undefined;
  const codeChallenge = codeVerifier ? await pkceCodeChallengeS256(codeVerifier) : undefined;
  const state = randomUrlSafeString(16);
  const completion: { value?: OAuthCompletion } = {};

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: bindPort,
    fetch(req) {
      return handlePkceCallbackRequest(req, state, completion);
    },
  });
  const redirectUri = `http://127.0.0.1:${String(server.port)}${CALLBACK_PATH}`;
  const authUrl = buildAuthorizeUrl(descriptor, {
    clientId: options.clientId,
    scopes: options.scopes,
    redirectUri,
    state,
    ...(codeChallenge !== undefined && { codeChallenge }),
  });

  const abortTimer = setTimeout(() => {
    completion.value ??= { error: "timeout" };
  }, AUTH_TIMEOUT_MS);

  try {
    await options.openUrl(authUrl.toString());
    while (completion.value === undefined) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const done = completion.value;
    if ("error" in done) throw new Error("OAuth authorization did not complete");

    const clientSecret = options.oauthClientSecret?.trim();
    const result = await exchangeAuthorizationCode({
      descriptor,
      fetchFn,
      clientId: options.clientId,
      ...(clientSecret !== undefined && clientSecret !== "" && { clientSecret }),
      redirectUri,
      ...(codeVerifier !== undefined && { codeVerifier }),
      authCode: done.code,
      requestedScopes: options.scopes,
    });
    await persistTokens(options.vault, descriptor.vaultKey, result);
    return result;
  } finally {
    clearTimeout(abortTimer);
    server.stop();
  }
}
```

Add a local `persistTokens` (or import `persistTokens` if exported) — simplest is to import the registry's persistence. Define a tiny local one to avoid changing the registry's export surface:

```ts
import { validateVaultKeyOrThrow } from "../vault/key-format.ts";
async function persistTokens(vault: NimbusVault, vaultKey: string, r: PKCEResult): Promise<void> {
  validateVaultKeyOrThrow(vaultKey);
  await vault.set(
    vaultKey,
    JSON.stringify({ accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt, scopes: r.scopes }),
  );
}
```

- [ ] **Step 2: Delete the now-dead per-provider helpers**

Remove from `pkce.ts`: `buildPkceAuthorizeUrl`, `buildSlackAuthorizeUrl`, `buildNotionAuthorizeUrl`, `exchangePkceAuthorizationCode`, `exchangeNotionAuthorizationCode`, `exchangeSlackAuthorizationCode`, `runSlackOAuthOnLocalPort`, `runNotionOAuthOnLocalPort`, `slackOAuthV2Access` (now in registry via `postToken`/Slack hook — but `refreshSlackUserToken` still uses it; keep until Task 7), `parseTokenJson`, `scopesFromTokenResponse`, `parseExpiresInSeconds`, `pkceResultFromNotionTokenJson`, `pkceResultFromSlackOAuthV2Access`, `oauthTokenEndpointErrorSummary`, the `GOOGLE_*`/`MS_*`/`SLACK_*`/`NOTION_*` URL constants, `vaultKeyForProvider`. Keep `OAuthProvider`/`PKCEResult` only as re-exports from the registry.

> Do this incrementally: delete a helper, run `bun run typecheck` for gateway, fix the next reference, repeat. `refreshAccessToken`/`refreshSlackUserToken`/`refreshNotionToken` are migrated in Task 7 — leave their bodies for now (they may still reference local constants; if so, keep the minimal constants they need until Task 7, then delete).

- [ ] **Step 3: Run the behavior-preservation tests**

Run: `bun test packages/gateway/src/auth/pkce.test.ts`
Expected: PASS — all `runPKCEFlow` tests (google, microsoft, slack, ephemeral-port fallback) green **unchanged**. This proves the facade preserves behavior.

- [ ] **Step 4: Typecheck gateway**

Run: `bun run typecheck`
Expected: no `packages/gateway` errors (ignore the pre-existing `nimbus-vscode` one).

- [ ] **Step 5: Commit**

```powershell
git add packages/gateway/src/auth/pkce.ts packages/gateway/src/auth/oauth-registry.ts
git commit -m @'
refactor(auth): pkce.ts runPKCEFlow delegates to the registry; drop per-provider helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 7: Migrate refresh functions to the registry

**Files:**
- Modify: `packages/gateway/src/auth/pkce.ts`

Goal: `refreshAccessToken` keeps its export name, **widens** `provider` to `OAuthProvider`, and delegates to `refreshViaRegistry`. `refreshSlackUserToken` and `refreshNotionToken` keep their export names (consumed by `slack-access-token.ts` / `notion-access-token.ts` until Task 8 migrates those) and delegate to `refreshViaRegistry`.

- [ ] **Step 1: Rewrite the three refresh functions**

```ts
import { OAUTH_PROVIDERS, refreshViaRegistry, type OAuthProvider } from "./oauth-registry.ts";

export interface RefreshAccessTokenContext {
  vault: NimbusVault;
  fetchImpl?: PKCEFetch;
  clientSecret?: string;
  persistVaultKey?: string;
}

export async function refreshAccessToken(
  refreshToken: string,
  provider: OAuthProvider,
  clientId: string,
  ctx: RefreshAccessTokenContext,
): Promise<PKCEResult> {
  return refreshViaRegistry({
    descriptor: OAUTH_PROVIDERS[provider],
    refreshToken,
    clientId,
    vault: ctx.vault,
    ...(ctx.clientSecret !== undefined && { clientSecret: ctx.clientSecret }),
    ...(ctx.fetchImpl !== undefined && { fetchFn: ctx.fetchImpl }),
    ...(ctx.persistVaultKey !== undefined && { persistVaultKey: ctx.persistVaultKey }),
  });
}

export async function refreshSlackUserToken(
  refreshToken: string,
  clientId: string,
  ctx: RefreshAccessTokenContext,
): Promise<PKCEResult> {
  return refreshViaRegistry({
    descriptor: OAUTH_PROVIDERS.slack,
    refreshToken,
    clientId,
    vault: ctx.vault,
    ...(ctx.fetchImpl !== undefined && { fetchFn: ctx.fetchImpl }),
  });
}

export async function refreshNotionToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  ctx: RefreshAccessTokenContext,
): Promise<PKCEResult> {
  return refreshViaRegistry({
    descriptor: OAUTH_PROVIDERS.notion,
    refreshToken,
    clientId,
    clientSecret,
    vault: ctx.vault,
    ...(ctx.fetchImpl !== undefined && { fetchFn: ctx.fetchImpl }),
  });
}
```

Now delete any remaining `slackOAuthV2Access`, `notionBasicAuthHeader`, and leftover URL constants in `pkce.ts` — they're unused.

- [ ] **Step 2: Run the behavior-preservation tests**

Run: `bun test packages/gateway/src/auth/pkce.test.ts`
Expected: PASS — incl. `refreshAccessToken` tests ("writes merged refresh token", "includes client_secret in refresh body", "persists to persistVaultKey"). The Slack-refresh and Notion-refresh paths are covered by their resolver tests in Task 8.

- [ ] **Step 3: Typecheck gateway**

Run: `bun run typecheck`
Expected: no `packages/gateway` errors.

- [ ] **Step 4: Commit**

```powershell
git add packages/gateway/src/auth/pkce.ts
git commit -m @'
refactor(auth): refresh functions delegate to registry; widen refreshAccessToken provider type

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 8: Migrate the four resolvers to `getValidVaultAccessToken`

**Files:**
- Modify: `packages/gateway/src/auth/oauth-vault-tokens.ts`
- Modify: `packages/gateway/src/auth/notion-access-token.ts`
- Modify: `packages/gateway/src/auth/slack-access-token.ts`
- (No change needed to `google-access-token.ts` if `getValidVaultOAuthAccessToken` keeps its signature — it already delegates there.)

Goal: route the "read → margin → refresh → return" logic through the registry's `getValidVaultAccessToken`, keeping each public function's signature so its existing test passes unchanged.

- [ ] **Step 1: Reimplement `getValidVaultOAuthAccessToken` over the registry**

In `oauth-vault-tokens.ts`, keep the exported signature; delegate to `getValidVaultAccessToken`:

```ts
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidVaultOAuthAccessToken(args: {
  vault: NimbusVault;
  vaultKey: string;
  notConfiguredError: string;
  parseErrors: ParseStoredOAuthErrors;
  marginMs?: number;
  getClientId: () => string;
  emptyClientIdError: string;
  provider: "google" | "microsoft";
}): Promise<string> {
  const clientSecret =
    args.provider === "google" && Config.oauthGoogleClientSecret !== ""
      ? Config.oauthGoogleClientSecret
      : undefined;
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS[args.provider],
    vault: args.vault,
    vaultKey: args.vaultKey,
    clientId: args.getClientId(),
    ...(clientSecret !== undefined && { clientSecret }),
    notConfiguredError: args.notConfiguredError,
    parseErrors: args.parseErrors,
    emptyClientIdError: args.emptyClientIdError,
  });
}
```

> Keep `parseStoredOAuthTokens` and `ParseStoredOAuthErrors` exported from this file unchanged — the registry imports `parseStoredOAuthTokens` from here. `microsoftOAuthAccessFromConfig` and `readMicrosoftOAuthScopesForOutlookEnv` stay as-is.

- [ ] **Step 2: Run google + microsoft resolver tests**

Run: `bun test packages/gateway/src/auth/oauth-vault-tokens.test.ts packages/gateway/src/auth/google-access-token.test.ts packages/gateway/src/auth/oauth-vault-scopes.test.ts`
Expected: PASS unchanged.

- [ ] **Step 3: Reimplement `getValidNotionAccessToken` + `getValidSlackAccessToken`**

`notion-access-token.ts`:

```ts
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidNotionAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.notion,
    vault,
    clientId: Config.oauthNotionClientId,
    clientSecret: Config.oauthNotionClientSecret,
    notConfiguredError: "Notion OAuth not configured; run: nimbus connector auth notion",
    parseErrors: {
      invalidJson: "Invalid notion.oauth vault payload",
      invalidPayload: "Invalid notion.oauth vault payload",
      missingAccess: "Missing Notion access token",
      missingRefresh: "Missing Notion refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_NOTION_CLIENT_ID and NIMBUS_OAUTH_NOTION_CLIENT_SECRET for Notion token refresh",
  });
}
```

> The existing `notion-access-token.test.ts` asserts the throw message contains `"NIMBUS_OAUTH_NOTION_CLIENT_ID"` when client id/secret are empty. `getValidVaultAccessToken` throws `emptyClientIdError` when `clientId === ""`. Since the empty-config test leaves `oauthNotionClientId = ""`, the `emptyClientIdError` above fires — message matches. The refresh-error test (`"Notion token refresh failed"`) now surfaces as the generic `"Token exchange failed (...)"`. **This is a message change** — update *only that one assertion* in `notion-access-token.test.ts` to `rejects.toThrow("Token exchange failed")`. That is the single allowed test edit in this PR; note it in the commit.

`slack-access-token.ts`:

```ts
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidSlackAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.slack,
    vault,
    clientId: Config.oauthSlackClientId,
    notConfiguredError: "Slack OAuth not configured; run: nimbus connector auth slack",
    parseErrors: {
      invalidJson: "Invalid slack.oauth vault payload",
      invalidPayload: "Invalid slack.oauth vault payload",
      missingAccess: "Missing Slack access token",
      missingRefresh: "Missing Slack refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError: "Set NIMBUS_OAUTH_SLACK_CLIENT_ID for Slack token refresh",
  });
}
```

> `readConnectorSecret(vault, "slack"/"notion", "oauth")` resolves to the `slack.oauth`/`notion.oauth` vault key, which equals `descriptor.vaultKey` — so passing no `vaultKey` override is correct.

- [ ] **Step 4: Run notion + slack resolver tests**

Run: `bun test packages/gateway/src/auth/notion-access-token.test.ts packages/gateway/src/auth/slack-access-token.test.ts`
Expected: PASS — slack unchanged; notion with the one updated assertion.

- [ ] **Step 5: Run the whole auth suite + typecheck**

Run: `bun test packages/gateway/src/auth/`
Run: `bun run typecheck`
Expected: PASS; no gateway type errors. Pass count ≥ the Task 0 baseline.

- [ ] **Step 6: Commit**

```powershell
git add packages/gateway/src/auth/oauth-vault-tokens.ts packages/gateway/src/auth/notion-access-token.ts packages/gateway/src/auth/slack-access-token.ts packages/gateway/src/auth/notion-access-token.test.ts
git commit -m @'
refactor(auth): resolvers delegate to registry getValidVaultAccessToken

Single assertion update in notion-access-token.test.ts: refresh-failure
message is now the generic "Token exchange failed (...)" form.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 9: D11 vault-key allow-list

**Files:**
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts:19-26` (`VAULT_KEY_ALLOW_LIST`)

- [ ] **Step 1: Run the invariants audit to see the failure**

Run: `bun run audit:invariants`
Expected: FAIL — D11 flags `packages/gateway/src/auth/oauth-registry.ts` constructing `.oauth` vault keys outside the allow-list.

- [ ] **Step 2: Add the registry file to the allow-list**

In `check-nimbus-invariants.ts`, add to `VAULT_KEY_ALLOW_LIST` (alongside the existing `packages/gateway/src/auth/oauth-vault-tokens.ts`):

```ts
  "packages/gateway/src/auth/oauth-registry.ts",
```

- [ ] **Step 3: Re-run the audit**

Run: `bun run audit:invariants`
Expected: PASS (exit 0).

- [ ] **Step 4: Commit**

```powershell
git add scripts/structure-audit/check-nimbus-invariants.ts
git commit -m @'
chore(audit): allow-list auth/oauth-registry.ts for D11 vault-key construction

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 10: Full local gate + dead-code check

**Files:** none (verification + any fixups).

- [ ] **Step 1: Lint/format**

Run: `bunx biome check packages/gateway/src/auth/ scripts/structure-audit/check-nimbus-invariants.ts`
Expected: no errors. If formatting issues, run `bun run lint:fix` and re-stage.

- [ ] **Step 2: Dead-code audit (knip) — the deleted helpers must not leave orphan exports**

Run: `bun run audit:dead-code`
Expected: PASS. If knip flags a now-unused export (e.g. a helper a test no longer imports), delete it and re-run.

- [ ] **Step 3: Auth coverage**

Run: `bun test packages/gateway/src/auth/ --coverage`
Expected: PASS; `oauth-registry.ts` and the touched files at or above their package floor (new files target ≥85%; the existing auth coverage gate must not regress).

- [ ] **Step 4: Doc-reference check**

Run: `bun scripts/structure-audit/check-doc-references.ts --check`
Expected: PASS (the spec/plan paths resolve).

- [ ] **Step 5: Full preflight:fast (cheap static gates)**

Run: `bun run preflight:fast`
Expected: PASS. Resolve any gate failure before proceeding.

- [ ] **Step 6: Confirm clean tree + commit boundary**

Run: `git status`
Expected: clean working tree; the PR-1 commits (Tasks 1–9) present. No Zoom files exist.

---

## Self-review (completed during authoring)

- **Spec §1 coverage:** descriptor (Task 1) ✓ · pure parsers + google/MS hooks (Task 2) ✓ · slack/notion outliers + `isTokenSuccess` (Task 3) ✓ · generic exchange + secret-free error path (Task 4) ✓ · generic refresh + `refresh_token ?? old` + single-flight lock (Task 5) ✓ · `runPKCEFlow` facade keeps signature (Task 6) ✓ · `refreshAccessToken` widened, refresh fns delegate (Task 7) ✓ · resolvers keep signatures, delegate (Task 8) ✓ · Google per-service-key logic untouched (Task 8 note) ✓ · D11 allow-list (Task 9) ✓.
- **Behavior preservation:** the six existing auth tests are the net; the only sanctioned test edit is one assertion message in `notion-access-token.test.ts` (Task 8 Step 3), explicitly called out and committed with rationale.
- **Type consistency:** `OAuthProvider`/`PKCEResult` defined in `oauth-registry.ts`, re-exported by `pkce.ts`; `getValidVaultAccessToken`/`refreshViaRegistry`/`exchangeAuthorizationCode`/`buildAuthorizeUrl`/`OAUTH_PROVIDERS` names are used identically across Tasks 4–8.
- **No Zoom:** this PR adds the `"zoom"` literal nowhere — PR-2 widens the union and adds the descriptor.

## Hand-off to PR-2

PR-2 builds on the API this PR locks: `OAUTH_PROVIDERS` (add `zoom`), `getValidVaultAccessToken` (zoom resolver), widened `OAuthProvider` union, `exchangeAuthorizationCode`/`refreshViaRegistry`. The PR-2/PR-3 plans are written **after** PR-1 lands green, so their concrete code references the actually-landed signatures.
