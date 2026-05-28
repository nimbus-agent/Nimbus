# Zoom Connector (PR-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Zoom connector — the **first fifth-provider entry in the OAuth registry that PR-1 landed** — indexing scheduled meetings (`zoom:meeting`) via `GET /v2/users/me/meetings?type=scheduled`. **No transcripts (Walk B is PR-3).** Read-only, `hitlRequired: []`. Authorization-code with PKCE; rotating refresh tokens handled by the registry's single-flight `getValidVaultAccessToken`.

**Architecture:** Zoom widens the `OAuthProvider` union in `auth/oauth-registry.ts` to `"google" | "microsoft" | "slack" | "notion" | "zoom"` and adds a fifth descriptor (`authorizeUrl`/`tokenUrl` on `zoom.us`, `usesPkce: true`, `clientSecret: "required"`, `secretPlacement: "basic_header"`, `bodyFormat: "form"`, standard `parseTokenResponse`, `mirrorPerService: false`, `vaultKey: "zoom.oauth"`). The new gateway-side resolver `auth/zoom-access-token.ts::getValidZoomAccessToken` delegates token validity to the registry's `getValidVaultAccessToken`. A dedicated lazy-mesh slot (`ensureZoomMcp`) resolves a fresh access token at spawn time and injects it as `ZOOM_TOKEN`. The sync handler (`connectors/zoom-sync.ts`) walks Walk A only; the pure mapper (`connectors/zoom-meeting-mapping.ts::mapZoomMeetingToItem`) emits `zoom:meeting` rows. MCP server `packages/mcp-connectors/zoom` exposes read-only `zoom_list` / `zoom_get` / `zoom_search` over the meetings endpoint.

**Tech Stack:** Bun + TypeScript 6 strict; `bun test`; Biome; existing connector infrastructure (`SyncContext`, `Syncable`, `upsertIndexedItemForSync`, `nimbus-json-cursor`, `pass-cursor-sync-result`, `connector-vault`, `lazy-mesh/`).

**Spec:** `docs/superpowers/specs/2026-05-27-zoom-connector-oauth-registry-design.md` §2 (Zoom auth wiring) + §3 (Walk A only; defer §3 Walk B + transcript mapper to PR-3) + §4 (PR-2 scope tests).

**Branch:** `dev/asafgolombek/connector-buildout-rest` (PR-1 landed at `88d4903d`; PR #447 open). PR-3 will be the follow-up plan.

---

## Pre-flight conventions (read once)

- All commands run from the worktree root `C:\gitrep\Nimbus\.worktrees\connector-buildout-rest` using **PowerShell** (Bash mangles `C:\` paths). Do **not** prefix with `cd`.
- `bun run typecheck` shows a **pre-existing** `nimbus-vscode` failure (`@nimbus-dev/client` + `@types/node`) — ignore it; only `@nimbus/gateway typecheck: Exited with code 0` matters.
- `bun test` does not typecheck — run `bun run typecheck` separately.
- The behaviour-preservation contract from PR-1 still holds: the seven auth tests (`pkce.test.ts`, `google-access-token.test.ts`, `notion-access-token.test.ts`, `slack-access-token.test.ts`, `oauth-vault-tokens.test.ts`, `oauth-vault-scopes.test.ts`, `oauth-registry.test.ts`) stay green. A new test file `zoom-access-token.test.ts` lands in Task 6.
- Commit after each task. End every commit message with:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- The pre-push hook is `preflight:fast` (still includes the known `nimbus-vscode` failure); push at the end of Task 12 with `NIMBUS_SKIP_PREPUSH=1` — same posture as PR-1.
- The PR-1 stack already sets `oauth-registry.ts` in `VAULT_KEY_ALLOW_LIST` (D11). PR-2 adds `auth/zoom-access-token.ts` to the same list (Task 11).

## File structure

**Create:**
- `packages/gateway/src/auth/zoom-access-token.ts` — `getValidZoomAccessToken(vault)`; mirrors `slack-access-token.ts` shape, delegates to the registry.
- `packages/gateway/src/auth/zoom-access-token.test.ts` — vault-miss / cache-hit / missing-client-id / refresh-success / **rotating-refresh-token persistence** / token-not-in-error.
- `packages/gateway/src/connectors/zoom-meeting-mapping.ts` — `mapZoomMeetingToItem` (pure, no I/O).
- `packages/gateway/src/connectors/zoom-meeting-mapping.test.ts` — id-skip / title fallback / ISO→epoch-ms / canonical-url / metadata shape.
- `packages/gateway/src/connectors/zoom-sync.ts` — `createZoomSyncable` (Walk A only).
- `packages/gateway/src/connectors/zoom-sync.test.ts` — pagination / first-page http-error pass-cursor-empty / first-page parse-error pass-cursor-empty / rate-limiter acquire / no-token noop.
- `packages/mcp-connectors/zoom/` — new MCP package (`package.json`, `src/server.ts`, `src/search-filter.ts`, `test/search-filter.test.ts`, `test/sandbox.test.ts`).

**Modify:**
- `packages/gateway/src/auth/oauth-registry.ts` — widen `OAuthProvider` union to add `"zoom"`; append `zoom` descriptor to `OAUTH_PROVIDERS`.
- `packages/gateway/src/auth/oauth-registry.test.ts` — table assertion + new zoom-specific descriptor tests.
- `packages/gateway/src/config.ts` — add `oauthZoomClientId` + `oauthZoomClientSecret`.
- `packages/gateway/src/auth/oauth-env-help-messages.ts` — `ZOOM_OAUTH_CLIENT_ID_HELP` + `ZOOM_OAUTH_CLIENT_SECRET_HELP`.
- `packages/gateway/src/connectors/connector-catalog.ts` — `"zoom"` in `CONNECTOR_SERVICE_IDS`, `CONNECTOR_SYNC_INTERVAL_MS.zoom`, `oauthProfileForService("zoom")` case.
- `packages/gateway/src/connectors/connector-secrets-manifest.ts` — `zoom: ["zoom.oauth"]`.
- `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` — extend `oauthClientConfigForProvider` + the secret supply branch in `connectorAuthOAuthPkce` (mirror the notion pattern, since Zoom also needs a secret).
- `packages/gateway/src/connectors/lazy-mesh/keys.ts` — add `zoom: "mesh:zoom"`.
- `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts` — add `ensureZoomMcp` (mirror `ensureNotionMcp` exactly).
- `packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts` — add `ensureZoomMcp` to `CredentialSpawners` + invocation in `ensureCredentialConnectorsRunning`.
- `packages/gateway/src/connectors/lazy-mesh/mesh.ts` — add `ensureZoomRunning()` method.
- `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts` — `zoom: baseManifest("com.nimbus.zoom", { network: ["api.zoom.us", "zoom.us"], filesystem: { read: [], write: [] } })`.
- `packages/gateway/src/platform/assemble-sync-registrations.ts` — register `createZoomSyncable({ ensureZoomMcpRunning: () => connectorMesh.ensureZoomRunning() })`.
- `scripts/structure-audit/check-nimbus-invariants.ts` — add `auth/zoom-access-token.ts` to `VAULT_KEY_ALLOW_LIST`.
- `docs/CHANGELOG.md`, `docs/roadmap.md` (line 505), `.claude/commands/nimbus-file-map.md`, `docs/cli-reference.md`, `docs/architecture.md`.

---

## Task 0: Baseline green

**Files:** none (verification only).

- [ ] **Step 1: Confirm the seven auth test files pass before any change**

Run: `bun test packages/gateway/src/auth/`
Expected: PASS (53 tests across 7 files in the worktree state at the head of PR-1).

- [ ] **Step 2: Confirm gateway typecheck baseline**

Run: `bun run typecheck`
Expected: `@nimbus/gateway typecheck: Exited with code 0`. The top-level exit code will be non-zero because of the pre-existing `nimbus-vscode` failure — ignore that.

- [ ] **Step 3: Confirm structural audits baseline**

Run: `bun run audit:invariants` then `bun run audit:boundaries`
Expected: both PASS.

---

## Task 1: Widen OAuthProvider + Zoom descriptor in `OAUTH_PROVIDERS`

**Files:**
- Modify: `packages/gateway/src/auth/oauth-registry.ts`
- Modify: `packages/gateway/src/auth/oauth-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/auth/oauth-registry.test.ts` (alongside the existing `OAUTH_PROVIDERS table` / `slack descriptor hooks` / `notion descriptor hooks` blocks):

```ts
describe("zoom descriptor", () => {
  test("table includes zoom with vaultKey, urls, and quirks", () => {
    expect(OAUTH_PROVIDERS.zoom.id).toBe("zoom");
    expect(OAUTH_PROVIDERS.zoom.vaultKey).toBe("zoom.oauth");
    expect(OAUTH_PROVIDERS.zoom.authorizeUrl).toBe("https://zoom.us/oauth/authorize");
    expect(OAUTH_PROVIDERS.zoom.tokenUrl).toBe("https://zoom.us/oauth/token");
    expect(OAUTH_PROVIDERS.zoom.usesPkce).toBe(true);
    expect(OAUTH_PROVIDERS.zoom.clientSecret).toBe("required");
    expect(OAUTH_PROVIDERS.zoom.secretPlacement).toBe("basic_header");
    expect(OAUTH_PROVIDERS.zoom.bodyFormat).toBe("form");
    expect(OAUTH_PROVIDERS.zoom.mirrorPerService).toBe(false);
    expect(OAUTH_PROVIDERS.zoom.tokenHeaders).toBeUndefined();
  });

  test("authorize params include S256 PKCE + scope joined with spaces", () => {
    const p = OAUTH_PROVIDERS.zoom.buildAuthorizeParams({
      clientId: "zoom-cid",
      scopes: ["meeting:read:list_meetings", "user:read:user"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("zoom-cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("meeting:read:list_meetings user:read:user");
    expect(p["state"]).toBe("st");
    expect(p["code_challenge"]).toBe("cc");
    expect(p["code_challenge_method"]).toBe("S256");
  });

  test("parseTokenResponse delegates to parseStandardTokenResponse", () => {
    const r = OAUTH_PROVIDERS.zoom.parseTokenResponse(
      { access_token: "zoom-a", refresh_token: "zoom-r", expires_in: 3600 },
      ["meeting:read:list_meetings"],
    );
    expect(r.accessToken).toBe("zoom-a");
    expect(r.refreshToken).toBe("zoom-r");
    expect(r.scopes).toEqual(["meeting:read:list_meetings"]);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: FAIL — `Property 'zoom' does not exist on type 'Record<...>'` (the descriptor is missing). The runner may also report a TS-level error.

- [ ] **Step 3: Widen the union + add the zoom descriptor**

In `packages/gateway/src/auth/oauth-registry.ts`:

Replace the union:

```ts
export type OAuthProvider = "google" | "microsoft" | "slack" | "notion" | "zoom";
```

Inside `OAUTH_PROVIDERS`, append the zoom descriptor after `notion` (the same shape as the existing entries — standard authorize params, `parseStandardTokenResponse`, basic-header secret placement, form body):

```ts
  zoom: {
    id: "zoom",
    vaultKey: "zoom.oauth",
    authorizeUrl: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    usesPkce: true,
    clientSecret: "required",
    secretPlacement: "basic_header",
    bodyFormat: "form",
    mirrorPerService: false,
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
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/gateway/src/auth/oauth-registry.test.ts`
Expected: PASS (3 new zoom tests on top of the existing 16).

- [ ] **Step 5: Gateway typecheck**

Run: `bun run typecheck`
Expected: gateway exits 0 (vscode-extension still red — ignore).

- [ ] **Step 6: Commit**

```powershell
git add packages/gateway/src/auth/oauth-registry.ts packages/gateway/src/auth/oauth-registry.test.ts
git commit -m @'
feat(auth): widen OAuthProvider union to include "zoom" + add zoom descriptor

Zoom uses standard PKCE + basic-header client secret + form body with
parseStandardTokenResponse. authorizeUrl/tokenUrl on zoom.us; vaultKey
"zoom.oauth"; mirrorPerService false; no tokenHeaders. The fifth provider
plugs into the registry the PR-1 stack landed — no code touches outside
the descriptor table.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 2: Config knobs + env-help messages

**Files:**
- Modify: `packages/gateway/src/config.ts`
- Modify: `packages/gateway/src/auth/oauth-env-help-messages.ts`

- [ ] **Step 1: Add Config knobs**

In `packages/gateway/src/config.ts`, after the existing `oauthNotionClientSecret` line:

```ts
  /** Zoom OAuth — token endpoint requires Basic auth with the client secret. */
  oauthZoomClientId: processEnvGet("NIMBUS_OAUTH_ZOOM_CLIENT_ID") ?? "",
  oauthZoomClientSecret: processEnvGet("NIMBUS_OAUTH_ZOOM_CLIENT_SECRET") ?? "",
```

- [ ] **Step 2: Add help-message constants**

Append to `packages/gateway/src/auth/oauth-env-help-messages.ts`:

```ts
export const ZOOM_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_ZOOM_CLIENT_ID to your Zoom OAuth app's Client ID (User-managed General app with PKCE).

How to obtain:
1. marketplace.zoom.us → Develop → Build App → General app (User-managed).
2. App Credentials → copy the Client ID; OAuth → add a redirect URL on localhost (Nimbus binds a loopback port for the callback).
3. Scopes — enable the granular GA scopes Nimbus uses (e.g. user:read:user, meeting:read:list_meetings).

You must also set NIMBUS_OAUTH_ZOOM_CLIENT_SECRET (Zoom's token endpoint requires HTTP Basic auth with the secret).

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_ZOOM_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_ZOOM_CLIENT_SECRET = "..."`;

export const ZOOM_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_ZOOM_CLIENT_SECRET to your Zoom OAuth app's Client Secret.

Zoom's token exchange requires the client secret in the environment (it is not stored in the Nimbus vault).

marketplace.zoom.us → your app → App Credentials → copy the Client Secret.

PowerShell example:
  $env:NIMBUS_OAUTH_ZOOM_CLIENT_SECRET = "..."`;
```

- [ ] **Step 3: Gateway typecheck**

Run: `bun run typecheck`
Expected: gateway exits 0.

- [ ] **Step 4: Commit**

```powershell
git add packages/gateway/src/config.ts packages/gateway/src/auth/oauth-env-help-messages.ts
git commit -m @'
feat(config): NIMBUS_OAUTH_ZOOM_CLIENT_ID + _SECRET knobs + env-help messages

Mirrors the Notion pattern (the only other registry provider with
clientSecret: "required"): two env-only knobs, two help-message constants
exported from auth/oauth-env-help-messages.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 3: Catalog wiring — `ConnectorServiceId` + sync interval + OAuth profile

**Files:**
- Modify: `packages/gateway/src/connectors/connector-catalog.ts`

- [ ] **Step 1: Add `"zoom"` to the service-id tuple**

In `packages/gateway/src/connectors/connector-catalog.ts`, append `"zoom"` as the last entry of `CONNECTOR_SERVICE_IDS`:

```ts
  "stackoverflow",
  "zoom",
] as const;
```

- [ ] **Step 2: Add a sync interval**

Append to `CONNECTOR_SYNC_INTERVAL_MS` (use `MIN10` — Zoom Webhooks for near-real-time are a separate workstream; 10 min batch sync is the right default for meetings):

```ts
  stackoverflow: MIN10,
  zoom: MIN10,
};
```

- [ ] **Step 3: Add the OAuth profile branch**

In `oauthProfileForService(serviceId)`, after the `case "notion":` arm:

```ts
    case "zoom":
      return {
        provider: "zoom",
        defaultScopes: [
          "user:read:user",
          "meeting:read:list_meetings",
          "cloud_recording:read:list_user_recordings",
        ],
      };
```

(The `cloud_recording:*` scope is requested in PR-2 so the same OAuth grant covers PR-3 transcripts without re-consent — granular GA scopes from the start, per spec §"Goals". Verify exact scope strings against current Zoom docs at implementation time.)

- [ ] **Step 4: Add the `ConnectorServiceId` exhaustiveness checks throw — confirm no `OAUTH_UNSUPPORTED_DETAILS` entry is needed**

Zoom is an OAuth provider, so it does **not** belong in `OAUTH_UNSUPPORTED_DETAILS`. No change there. The `oauthProfileForService` switch already covers it via the new branch above; the default branch's throw is unreachable for `"zoom"`.

- [ ] **Step 5: Confirm catalog test still passes**

Run: `bun test packages/gateway/src/connectors/connector-catalog.test.ts`
Expected: PASS (the catalog test likely iterates over `CONNECTOR_SERVICE_IDS` and confirms `CONNECTOR_SYNC_INTERVAL_MS` has an entry for each; both are now satisfied).

If the test fails because it asserts the exact list of OAuth-supported services, **update the assertion** (this is a sanctioned shape-change; note it in the commit). Search the test file for the existing OAuth-services literal and add `"zoom"` to it.

- [ ] **Step 6: Gateway typecheck**

Run: `bun run typecheck`
Expected: gateway exits 0.

- [ ] **Step 7: Commit**

```powershell
git add packages/gateway/src/connectors/connector-catalog.ts packages/gateway/src/connectors/connector-catalog.test.ts
git commit -m @'
feat(catalog): register "zoom" ConnectorServiceId + 10-min sync interval + OAuth profile

defaultScopes include cloud_recording:* so PR-3 transcripts ride the
same grant without re-consent. The user:read:user scope is the standard
identity-discovery scope used by /v2/users/me/* endpoints.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 4: Vault-secrets manifest entry

**Files:**
- Modify: `packages/gateway/src/connectors/connector-secrets-manifest.ts`

- [ ] **Step 1: Add `zoom: ["zoom.oauth"]`**

In `packages/gateway/src/connectors/connector-secrets-manifest.ts`, append to `CONNECTOR_VAULT_SECRET_KEYS`:

```ts
  stackoverflow: ["stackoverflow.token", "stackoverflow.team"],
  zoom: ["zoom.oauth"],
} as const satisfies {
```

- [ ] **Step 2: Confirm the manifest test still passes**

Run: `bun test packages/gateway/src/connectors/connector-secrets-manifest.test.ts`
Expected: PASS — the `satisfies` type predicate enforces exhaustive `ConnectorServiceId` coverage; without the `zoom` entry the TS compile would fail before tests run.

- [ ] **Step 3: Gateway typecheck**

Run: `bun run typecheck`
Expected: gateway exits 0.

- [ ] **Step 4: Commit**

```powershell
git add packages/gateway/src/connectors/connector-secrets-manifest.ts
git commit -m @'
feat(connectors): zoom vault-secrets manifest entry (zoom.oauth)

Single OAuth payload key — same shape as slack/notion. Cleared by
clearConnectorVaultSecretKeys when the connector is removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 5: `connector.auth` routing — zoom branch in `oauthClientConfigForProvider`

**Files:**
- Modify: `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts`

The Notion path is the template: `connectorAuthOAuthPkce` reads its client secret separately from the client id (because both must be checked + threaded into `runPKCEFlow` as `oauthClientSecret`). Zoom needs the same.

- [ ] **Step 1: Import the zoom help-message constants**

In `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts`, extend the existing import from `oauth-env-help-messages.ts`:

```ts
import {
  GOOGLE_OAUTH_CLIENT_ID_HELP,
  MICROSOFT_OAUTH_CLIENT_ID_HELP,
  NOTION_OAUTH_CLIENT_ID_HELP,
  NOTION_OAUTH_CLIENT_SECRET_HELP,
  SLACK_OAUTH_CLIENT_ID_HELP,
  ZOOM_OAUTH_CLIENT_ID_HELP,
  ZOOM_OAUTH_CLIENT_SECRET_HELP,
} from "../../auth/oauth-env-help-messages.ts";
```

- [ ] **Step 2: Extend `oauthClientConfigForProvider`**

Replace the `switch (profile.provider) { ... }` body to add a `zoom` case:

```ts
function oauthClientConfigForProvider(profile: ReturnType<typeof oauthProfileForService>): {
  clientId: string;
  emptyClientIdMessage: string;
} {
  switch (profile.provider) {
    case "google":
      return {
        clientId: Config.oauthGoogleClientId,
        emptyClientIdMessage: GOOGLE_OAUTH_CLIENT_ID_HELP,
      };
    case "microsoft":
      return {
        clientId: Config.oauthMicrosoftClientId,
        emptyClientIdMessage: MICROSOFT_OAUTH_CLIENT_ID_HELP,
      };
    case "slack":
      return {
        clientId: Config.oauthSlackClientId,
        emptyClientIdMessage: SLACK_OAUTH_CLIENT_ID_HELP,
      };
    case "notion":
      return {
        clientId: Config.oauthNotionClientId,
        emptyClientIdMessage: NOTION_OAUTH_CLIENT_ID_HELP,
      };
    case "zoom":
      return {
        clientId: Config.oauthZoomClientId,
        emptyClientIdMessage: ZOOM_OAUTH_CLIENT_ID_HELP,
      };
    default: {
      const _ex: never = profile.provider;
      throw new ConnectorRpcError(-32602, `Unsupported OAuth provider: ${_ex}`);
    }
  }
}
```

- [ ] **Step 3: Extend the secret-supply branch in `connectorAuthOAuthPkce`**

Replace the notion-secret block:

```ts
  const notionSecret = profile.provider === "notion" ? Config.oauthNotionClientSecret : undefined;
  if (profile.provider === "notion" && (notionSecret === undefined || notionSecret === "")) {
    throw new ConnectorRpcError(-32602, NOTION_OAUTH_CLIENT_SECRET_HELP);
  }
```

with:

```ts
  const notionSecret = profile.provider === "notion" ? Config.oauthNotionClientSecret : undefined;
  if (profile.provider === "notion" && (notionSecret === undefined || notionSecret === "")) {
    throw new ConnectorRpcError(-32602, NOTION_OAUTH_CLIENT_SECRET_HELP);
  }
  const zoomSecret = profile.provider === "zoom" ? Config.oauthZoomClientSecret : undefined;
  if (profile.provider === "zoom" && (zoomSecret === undefined || zoomSecret === "")) {
    throw new ConnectorRpcError(-32602, ZOOM_OAUTH_CLIENT_SECRET_HELP);
  }
```

Then extend the `merged` assignment to thread the zoom secret into `runPKCEFlow`:

```ts
  let merged: PKCEOptions = pkceBase;
  if (profile.provider === "notion" && notionSecret !== undefined && notionSecret !== "") {
    merged = { ...merged, oauthClientSecret: notionSecret };
  } else if (profile.provider === "zoom" && zoomSecret !== undefined && zoomSecret !== "") {
    merged = { ...merged, oauthClientSecret: zoomSecret };
  } else if (profile.provider === "google" && Config.oauthGoogleClientSecret !== "") {
    merged = { ...merged, oauthClientSecret: Config.oauthGoogleClientSecret };
  }
```

(`else if` chain — only one secret path applies per provider; Zoom never mirrors per-service so the existing google/microsoft `sharedKey` block below is untouched.)

- [ ] **Step 4: Gateway typecheck**

Run: `bun run typecheck`
Expected: gateway exits 0. (The `default: never` exhaustiveness check in `oauthClientConfigForProvider` proves the union is fully covered.)

- [ ] **Step 5: Run the connector-rpc auth tests if any reference the function**

Run: `bun test packages/gateway/src/ipc/connector-rpc-handlers/`
Expected: PASS unchanged. No existing test references `zoom`, so behaviour for the other four providers is unchanged.

- [ ] **Step 6: Commit**

```powershell
git add packages/gateway/src/ipc/connector-rpc-handlers/auth.ts
git commit -m @'
feat(connector-rpc): zoom branch in OAuth-PKCE auth handler

Mirrors the notion pattern (the only other provider with clientSecret:
"required"): a zoom-specific empty-config check that throws
ZOOM_OAUTH_CLIENT_SECRET_HELP, plus a third else-if in the secret-supply
chain that threads Config.oauthZoomClientSecret into runPKCEFlow as
PKCEOptions.oauthClientSecret. mirrorPerService is false so the
sharedKey mirror block is untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 6: `auth/zoom-access-token.ts` resolver + tests

**Files:**
- Create: `packages/gateway/src/auth/zoom-access-token.ts`
- Create: `packages/gateway/src/auth/zoom-access-token.test.ts`

The resolver is a thin wrapper over `getValidVaultAccessToken` — same shape as `notion-access-token.ts` (the only resolver besides Zoom whose provider needs both `clientId` AND `clientSecret`).

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/auth/zoom-access-token.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Config } from "../config.ts";
import { MockVault } from "../vault/mock.ts";
import { getValidZoomAccessToken } from "./zoom-access-token.ts";

const mutableConfig = Config as {
  oauthZoomClientId: string;
  oauthZoomClientSecret: string;
};

const originalFetch = globalThis.fetch;

describe("getValidZoomAccessToken", () => {
  let vault: MockVault;

  beforeEach(() => {
    vault = new MockVault();
    mutableConfig.oauthZoomClientId = "";
    mutableConfig.oauthZoomClientSecret = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mutableConfig.oauthZoomClientId = "";
    mutableConfig.oauthZoomClientSecret = "";
  });

  it("throws when zoom.oauth vault key is absent", async () => {
    await expect(getValidZoomAccessToken(vault)).rejects.toThrow("Zoom OAuth not configured");
  });

  it("returns cached token without a network call when not near expiry", async () => {
    await vault.set(
      "zoom.oauth",
      JSON.stringify({
        accessToken: "cached-zoom",
        refreshToken: "r-zoom",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      }),
    );
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("must not refresh on a cache hit");
    }) as unknown as typeof fetch;
    expect(await getValidZoomAccessToken(vault)).toBe("cached-zoom");
    expect(fetchCalled).toBe(false);
  });

  it("throws when token is expired but NIMBUS_OAUTH_ZOOM_CLIENT_ID is not set", async () => {
    await vault.set(
      "zoom.oauth",
      JSON.stringify({
        accessToken: "old",
        refreshToken: "r-old",
        expiresAt: Date.now() - 60_000,
      }),
    );
    await expect(getValidZoomAccessToken(vault)).rejects.toThrow("NIMBUS_OAUTH_ZOOM_CLIENT_ID");
  });

  it("refreshes when expired and persists rotated refresh token (Zoom rotates)", async () => {
    await vault.set(
      "zoom.oauth",
      JSON.stringify({
        accessToken: "old",
        refreshToken: "r-old",
        expiresAt: Date.now() - 60_000,
      }),
    );
    mutableConfig.oauthZoomClientId = "zoom-cid";
    mutableConfig.oauthZoomClientSecret = "zoom-secret";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ access_token: "fresh", refresh_token: "r-new", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const tok = await getValidZoomAccessToken(vault);
    expect(tok).toBe("fresh");
    const persisted = await vault.get("zoom.oauth");
    expect(persisted).toContain("fresh");
    expect(persisted).toContain("r-new");
    expect(persisted).not.toContain("r-old");
  });

  it("retains old refresh token when Zoom omits a new one on refresh", async () => {
    await vault.set(
      "zoom.oauth",
      JSON.stringify({
        accessToken: "old",
        refreshToken: "r-keepme",
        expiresAt: Date.now() - 60_000,
      }),
    );
    mutableConfig.oauthZoomClientId = "zoom-cid";
    mutableConfig.oauthZoomClientSecret = "zoom-secret";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    expect(await getValidZoomAccessToken(vault)).toBe("fresh");
    expect(await vault.get("zoom.oauth")).toContain("r-keepme");
  });

  it("never includes the client secret in a thrown error", async () => {
    await vault.set(
      "zoom.oauth",
      JSON.stringify({
        accessToken: "old",
        refreshToken: "r-old",
        expiresAt: Date.now() - 60_000,
      }),
    );
    mutableConfig.oauthZoomClientId = "zoom-cid";
    mutableConfig.oauthZoomClientSecret = "ZOOM_SECRET_SHOULD_NOT_LEAK";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "refresh expired" }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    let threw = "";
    try {
      await getValidZoomAccessToken(vault);
    } catch (e) {
      threw = String(e instanceof Error ? e.message : e);
    }
    expect(threw).toContain("invalid_grant");
    expect(threw.includes("ZOOM_SECRET_SHOULD_NOT_LEAK")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/auth/zoom-access-token.test.ts`
Expected: FAIL — `Cannot find module './zoom-access-token.ts'`.

- [ ] **Step 3: Implement the resolver**

Create `packages/gateway/src/auth/zoom-access-token.ts`:

```ts
import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

/**
 * Returns a valid Zoom user access token, refreshing via the registry's
 * single-flight `getValidVaultAccessToken` when near expiry. Persists the
 * rotated refresh token Zoom issues on every refresh (the chain-invalidating
 * concern that motivated the single-flight lock landed in PR-1).
 */
export async function getValidZoomAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.zoom,
    vault,
    clientId: Config.oauthZoomClientId,
    clientSecret: Config.oauthZoomClientSecret,
    notConfiguredError: "Zoom OAuth not configured; run: nimbus connector auth zoom",
    parseErrors: {
      invalidJson: "Invalid zoom.oauth vault payload",
      invalidPayload: "Invalid zoom.oauth vault payload",
      missingAccess: "Missing Zoom access token",
      missingRefresh: "Missing Zoom refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_ZOOM_CLIENT_ID and NIMBUS_OAUTH_ZOOM_CLIENT_SECRET for Zoom token refresh",
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/gateway/src/auth/zoom-access-token.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the whole auth suite**

Run: `bun test packages/gateway/src/auth/`
Expected: 59 pass / 0 fail (53 PR-1 baseline + 6 new).

- [ ] **Step 6: Commit**

```powershell
git add packages/gateway/src/auth/zoom-access-token.ts packages/gateway/src/auth/zoom-access-token.test.ts
git commit -m @'
feat(auth): getValidZoomAccessToken — registry-delegated resolver

Same shape as notion-access-token.ts (clientSecret: "required"
provider). Rotating-refresh-token persistence is tested explicitly —
this is the concern that motivated the PR-1 single-flight lock; Zoom
invalidates the entire token chain on refresh-token reuse.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 7: Lazy-mesh spawn — `ensureZoomMcp` + sandbox manifest

**Files:**
- Modify: `packages/gateway/src/connectors/lazy-mesh/keys.ts`
- Modify: `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts`
- Modify: `packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts`
- Modify: `packages/gateway/src/connectors/lazy-mesh/mesh.ts`
- Modify: `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts`

- [ ] **Step 1: Add the LAZY_MESH slot key**

In `packages/gateway/src/connectors/lazy-mesh/keys.ts`, append to the `LAZY_MESH` object:

```ts
  kubernetes: "mesh:kubernetes",
  obsidian: "mesh:obsidian",
  zoom: "mesh:zoom",
  phase3Bundle: "mesh:phase3-bundle",
} as const;
```

- [ ] **Step 2: Add the sandbox manifest entry**

In `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts`, append a `zoom` entry to `FIRST_PARTY_MANIFESTS` (alphabetical with the existing block; place after `notion`):

```ts
  zoom: baseManifest("com.nimbus.zoom", {
    // Zoom REST + OAuth — fixed SaaS hosts. api.zoom.us serves the REST API
    // and recording download URLs; zoom.us serves the OAuth authorize +
    // token endpoints. No self-hosted variant.
    network: ["api.zoom.us", "zoom.us"],
    filesystem: { read: [], write: [] },
  }),
```

- [ ] **Step 3: Add `ensureZoomMcp` to `connector-spawns.ts`**

In `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts`:

- Extend the existing top-of-file imports to add `getValidZoomAccessToken`:

```ts
import { getValidZoomAccessToken } from "../../auth/zoom-access-token.ts";
```

- Append (mirror `ensureNotionMcp` exactly):

```ts
/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts Zoom MCP when `zoom.oauth` is present and a valid access token can be resolved.
 */
export async function ensureZoomMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.zoom;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "zoom", "oauth");
  if (raw === null || raw === "") {
    return;
  }
  let accessToken: string;
  try {
    accessToken = await getValidZoomAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-zoom-${randomUUID()}`,
      servers: {
        zoom: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("zoom")],
            env: extensionProcessEnv({ ZOOM_TOKEN: accessToken }),
          },
          "zoom",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}
```

- [ ] **Step 4: Wire it into `credential-orchestration.ts`**

In `packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts`:

- Add to `CredentialSpawners`:

```ts
  readonly ensureSlackMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureZoomMcp: (ctx: MeshSpawnContext) => Promise<void>;
};
```

- Add the invocation in `ensureCredentialConnectorsRunning` (just before the obsidian/phase3 group):

```ts
  await ensureKubernetesIfVaultCreds(ctx, spawners);
  await ensureIfConnectorSecretSet(ctx, "zoom", "oauth", () => spawners.ensureZoomMcp(ctx));
  // Wave A PR 2 — Obsidian MCP starts when `[[filesystem.roots]]` are
```

- [ ] **Step 5: Expose `ensureZoomRunning` on the mesh**

In `packages/gateway/src/connectors/lazy-mesh/mesh.ts`:

- Add the import (find the existing `ensureNotionMcp` import and add to the same group):

```ts
import { ensureNotionMcp, ensureSlackMcp, ensureZoomMcp /* ... */ } from "./connector-spawns.ts";
```

(Match the existing import block's shape — the file already imports many `ensureXMcp` symbols.)

- Add the method (mirror `ensureSlackRunning`):

```ts
  async ensureZoomRunning(): Promise<void> {
    return ensureZoomMcp(this.spawnContext);
  }
```

Place it alphabetically (after `ensureSentryRunning` or wherever Z sits naturally in the existing order).

- [ ] **Step 6: Run the first-party-manifests test**

Run: `bun test packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts`
Expected: PASS — the manifest registry test verifies every key has a valid manifest; the new `zoom` entry must satisfy that.

- [ ] **Step 7: Run the lazy-mesh test suite**

Run: `bun test packages/gateway/src/connectors/lazy-mesh/`
Expected: PASS — `mesh.test.ts` exercises `ensureXRunning` shape; the new `ensureZoomRunning` is structurally identical to the existing ones, so the existing test pattern covers it without code edits.

- [ ] **Step 8: Gateway typecheck**

Run: `bun run typecheck`
Expected: gateway exits 0.

- [ ] **Step 9: Commit**

```powershell
git add packages/gateway/src/connectors/lazy-mesh/keys.ts packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts packages/gateway/src/connectors/lazy-mesh/mesh.ts packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts
git commit -m @'
feat(connectors/lazy-mesh): zoom slot + ensureZoomMcp + sandbox manifest (I15)

Mirrors the notion spawn pattern: a dedicated slot, getValidZoomAccessToken
resolves a fresh token at spawn (rotates it through the registry), injected
as ZOOM_TOKEN. Sandbox manifest covers api.zoom.us + zoom.us (REST + OAuth).
Wired through credential-orchestration (oauth-key gate) + mesh
ensureZoomRunning so the syncable can spawn it lazily.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 8: Mapper — `zoom-meeting-mapping.ts` + unit tests

**Files:**
- Create: `packages/gateway/src/connectors/zoom-meeting-mapping.ts`
- Create: `packages/gateway/src/connectors/zoom-meeting-mapping.test.ts`

Zoom `/v2/users/me/meetings` returns `{ meetings: [{ id, uuid, host_id, topic, type, start_time, duration, timezone, agenda, join_url, created_at, ... }] }`. `start_time` and `created_at` are ISO-8601 strings (NOT epoch). `id` is a numeric meeting id. `external_id = String(id)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/connectors/zoom-meeting-mapping.test.ts`:

```ts
import { describe, expect, it } from "bun:test";

import { mapZoomMeetingToItem } from "./zoom-meeting-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

describe("mapZoomMeetingToItem", () => {
  it("maps a populated meeting row", () => {
    const row = mapZoomMeetingToItem(
      {
        id: 83476203401,
        uuid: "abcd==",
        host_id: "host-1",
        topic: "Weekly Sync",
        type: 2,
        start_time: "2026-06-01T10:00:00Z",
        duration: 30,
        timezone: "UTC",
        agenda: "Project status",
        join_url: "https://zoom.us/j/83476203401?pwd=xyz",
        created_at: "2026-05-25T12:00:00Z",
      },
      { syncedAt: SYNCED_AT },
    );
    expect(row).not.toBeNull();
    expect(row?.service).toBe("zoom");
    expect(row?.type).toBe("meeting");
    expect(row?.externalId).toBe("83476203401");
    expect(row?.title).toBe("Weekly Sync");
    expect(row?.url).toBe("https://zoom.us/j/83476203401?pwd=xyz");
    expect(row?.canonicalUrl).toBe("https://zoom.us/j/83476203401?pwd=xyz");
    expect(row?.metadata).toMatchObject({
      meeting_id: 83476203401,
      uuid: "abcd==",
      host_id: "host-1",
      topic: "Weekly Sync",
      type: 2,
      duration_min: 30,
      timezone: "UTC",
      agenda: "Project status",
      join_url: "https://zoom.us/j/83476203401?pwd=xyz",
    });
    expect(row?.metadata["start_time"]).toBe(Date.parse("2026-06-01T10:00:00Z"));
    expect(row?.metadata["created_at"]).toBe(Date.parse("2026-05-25T12:00:00Z"));
    // modifiedAt MUST use created_at, not start_time — start_time is when the
    // meeting will happen, not when its row was last edited (a future-scheduled
    // meeting would otherwise get a future modifiedAt). Review point 1.
    expect(row?.modifiedAt).toBe(Date.parse("2026-05-25T12:00:00Z"));
    expect(row?.syncedAt).toBe(SYNCED_AT);
  });

  it("falls back title to `Meeting <id>` when topic is missing", () => {
    const row = mapZoomMeetingToItem(
      { id: 1234, start_time: "2026-06-01T10:00:00Z" },
      { syncedAt: SYNCED_AT },
    );
    expect(row?.title).toBe("Meeting 1234");
  });

  it("returns null when id is missing or non-numeric", () => {
    expect(mapZoomMeetingToItem({ topic: "no id" }, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapZoomMeetingToItem({ id: "not-a-number" }, { syncedAt: SYNCED_AT })).toBeNull();
  });

  it("nulls url + canonicalUrl when join_url is missing", () => {
    const row = mapZoomMeetingToItem(
      { id: 1, topic: "x", start_time: "2026-06-01T10:00:00Z" },
      { syncedAt: SYNCED_AT },
    );
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
  });

  it("modifiedAt prefers created_at over start_time (start_time may be future-dated)", () => {
    const row = mapZoomMeetingToItem(
      {
        id: 9,
        topic: "future",
        start_time: "2099-01-01T00:00:00Z",
        created_at: "2026-05-25T12:00:00Z",
      },
      { syncedAt: SYNCED_AT },
    );
    expect(row?.modifiedAt).toBe(Date.parse("2026-05-25T12:00:00Z"));
  });

  it("modifiedAt falls back to syncedAt when created_at is missing (no start_time fallback)", () => {
    const row = mapZoomMeetingToItem({ id: 7, topic: "no times" }, { syncedAt: SYNCED_AT });
    expect(row?.modifiedAt).toBe(SYNCED_AT);
  });

  it("tolerates a non-record input by returning null", () => {
    expect(mapZoomMeetingToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapZoomMeetingToItem("not an object", { syncedAt: SYNCED_AT })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/zoom-meeting-mapping.test.ts`
Expected: FAIL — `Cannot find module './zoom-meeting-mapping.ts'`.

- [ ] **Step 3: Implement the mapper**

Create `packages/gateway/src/connectors/zoom-meeting-mapping.ts`:

```ts
/**
 * Pure mapping from a Zoom `GET /v2/users/me/meetings?type=scheduled` list
 * element to the {@link upsertIndexedItemForSync} row shape. Lives separately
 * from `zoom-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "zoom", type = "meeting"` rows. `external_id = String(id)`
 * (Zoom meeting ids are numbers, like Raindrop's `_id` and Stack Overflow's
 * question ids); the row is skipped when `id` is missing/non-numeric.
 *
 * IMPORTANT: Zoom's `start_time` and `created_at` are ISO-8601 STRINGS (e.g.
 * `"2026-06-01T10:00:00Z"`), like the Stack Overflow / Readwise / Raindrop
 * connectors. Parse them to epoch-ms with the local {@link parseIsoMs}; never
 * pass through verbatim and never treat as epoch seconds.
 *
 * `zoom:meeting` is sparse-structured (topic + start_time + ids) — it is
 * deliberately NOT added to `PROSE_HEAVY_TYPES`. PR-3 adds `zoom:transcript`
 * to the prose-heavy set.
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface ZoomMeetingMappingContext {
  readonly syncedAt: number;
}

export interface ZoomMeetingMappedRow {
  readonly service: "zoom";
  readonly type: "meeting";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

/** ISO-8601 string → epoch ms, or null for non-strings / unparseable input. */
function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

export function mapZoomMeetingToItem(
  raw: unknown,
  ctx: ZoomMeetingMappingContext,
): ZoomMeetingMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const id = numberField(row, "id");
  if (id === undefined) {
    return null;
  }
  const externalId = String(id);
  const topic = stringField(row, "topic");
  const title = topic !== undefined && topic !== "" ? topic : `Meeting ${externalId}`;
  const joinUrl = stringField(row, "join_url");
  const url = joinUrl !== undefined && joinUrl !== "" ? joinUrl : null;
  const agenda = stringField(row, "agenda");
  const bodyPreview =
    agenda !== undefined && agenda !== ""
      ? agenda
      : topic !== undefined && topic !== ""
        ? topic
        : title;
  const startMs = parseIsoMs(row["start_time"]);
  const createdMs = parseIsoMs(row["created_at"]);
  const metadata: Record<string, unknown> = {
    meeting_id: id,
    uuid: stringField(row, "uuid") ?? null,
    host_id: stringField(row, "host_id") ?? null,
    topic: topic ?? null,
    type: numberField(row, "type") ?? null,
    start_time: startMs,
    duration_min: numberField(row, "duration") ?? null,
    timezone: stringField(row, "timezone") ?? null,
    agenda: agenda ?? null,
    join_url: joinUrl ?? null,
    created_at: createdMs,
    canonical_url: url,
  };
  return {
    service: "zoom",
    type: "meeting",
    externalId,
    title,
    bodyPreview,
    url,
    canonicalUrl: url,
    // modifiedAt uses created_at, NOT start_time. start_time is when the
    // meeting will happen — for scheduled future meetings it would produce a
    // future modifiedAt, which would corrupt "modified since X" queries.
    // Zoom's /v2/users/me/meetings list endpoint does not return an
    // updated_at field (only the GET /v2/meetings/{id} endpoint does); when
    // we eventually add per-meeting GET enrichment we can prefer updated_at.
    modifiedAt: createdMs ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/gateway/src/connectors/zoom-meeting-mapping.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```powershell
git add packages/gateway/src/connectors/zoom-meeting-mapping.ts packages/gateway/src/connectors/zoom-meeting-mapping.test.ts
git commit -m @'
feat(connectors): pure zoom meeting mapper + unit tests

Mirrors the Stack Overflow mapper structure: numeric-id skip, ISO-8601
parsed to epoch-ms via local parseIsoMs, canonical_url = join_url else
null, modifiedAt = start_time ?? created_at ?? syncedAt. zoom:meeting
stays on local MiniLM embeddings (NOT added to PROSE_HEAVY_TYPES);
zoom:transcript will be added in PR-3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 9: Sync handler — `zoom-sync.ts` (Walk A only) + integration test

**Files:**
- Create: `packages/gateway/src/connectors/zoom-sync.ts`
- Create: `packages/gateway/src/connectors/zoom-sync.test.ts`
- Modify: `packages/gateway/src/platform/assemble-sync-registrations.ts`
- Modify: `packages/gateway/src/sync/rate-limiter.ts` — add `"zoom"` to the `Provider` union and a `DEFAULT_QUOTAS.zoom` entry. This is non-negotiable: `ctx.rateLimiter.acquire("zoom")` is a typed call and won't compile without the union entry, and an unregistered provider would throw at runtime when the syncable first fires.

Walk A walks `GET /v2/users/me/meetings?type=scheduled&page_size=100`, following `next_page_token`, capped at `MAX_PAGES=20`. Uses `getValidZoomAccessToken(ctx.vault)` once per cycle. Each HTTP call gates on `ctx.rateLimiter.acquire("zoom")`. Cursor encoded via `nimbus-zoom1:`. First-page http/parse error maps to pass-cursor-empty (keep prior cursor); later-page errors break.

> **MAX_PAGES discussion (review point 3).** With `PAGE_SIZE=100` and `MAX_PAGES=20`, one cycle indexes at most 2 000 scheduled meetings. This matches every other Tier-1 connector's cap and is plenty for the median Zoom user. Heavy users (years of recurring meetings) would see truncation; raising the cap is a deliberate follow-up (likely paired with `initialSyncDepthDays` tuning and `next_page_token` cursor persistence across cycles), not a v1 change. A code comment in `zoom-sync.ts` flags the convention so future contributors don't bump it casually.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/connectors/zoom-sync.test.ts`. Mirror `stackoverflow-sync.test.ts` in spirit — use the same `SyncContext` test harness the existing connector tests use (find the canonical helper by looking at `stackoverflow-sync.test.ts` or `intercom-sync.test.ts`).

```ts
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { MockVault } from "../vault/mock.ts";
import { createZoomSyncable } from "./zoom-sync.ts";
// Sync-test helpers come from the existing test infrastructure — copy the
// fake-context shape used in stackoverflow-sync.test.ts / intercom-sync.test.ts
// (a fresh-temp-dir SqliteIndex + a stub rateLimiter + a logger + a fetch
// override). Implementers: reuse the canonical helper rather than open-coding.

const originalFetch = globalThis.fetch;

function meetingsResponse(meetings: unknown[], nextPageToken = ""): Response {
  return new Response(JSON.stringify({ meetings, next_page_token: nextPageToken }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("zoom-sync (Walk A — meetings)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("noop when zoom.oauth is absent", async () => {
    /* set up fresh ctx with empty vault */
    /* expect no fetch, no upserts, cursor preserved */
  });

  it("upserts a single page of meetings and acquires the rate limiter", async () => {
    /* seed vault with valid zoom.oauth */
    /* stub fetch to return one page (no next_page_token) */
    /* run sync; expect ctx.rateLimiter.acquire("zoom") called >= 1 */
    /* expect 1 upsert via mapZoomMeetingToItem */
  });

  it("follows next_page_token for two pages then stops", async () => {
    /* stub fetch to return page1 next="t2", page2 next="" */
    /* expect 2 fetches; expect 2 acquire calls; expect 2 upserts */
  });

  it("first-page HTTP error returns pass-cursor-empty (cursor unchanged)", async () => {
    /* stub fetch to return 500 */
    /* expect cursor unchanged, no upserts, no throw */
  });

  it("first-page parse error returns pass-cursor-empty (cursor reset)", async () => {
    /* stub fetch to return 200 with non-JSON */
    /* expect cursor reset to nimbus-zoom1:{pass:1} */
  });

  it("MAX_PAGES caps the walk at 20", async () => {
    /* stub fetch to always return next_page_token = "more" */
    /* expect exactly 20 fetches */
  });
});
```

> **Implementer note:** the test pseudo-bodies above call out the assertions you need to make. Open `packages/gateway/src/connectors/stackoverflow-sync.test.ts` and clone its `SyncContext` test-harness setup — that's the canonical shape (fresh temp dir + `SqliteIndex.openForWriting` + a fake `rateLimiter` + a fake `logger`). Don't invent a new harness.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/connectors/zoom-sync.test.ts`
Expected: FAIL — `Cannot find module './zoom-sync.ts'`.

- [ ] **Step 3: Implement `zoom-sync.ts`**

Create `packages/gateway/src/connectors/zoom-sync.ts`:

```ts
import { getValidZoomAccessToken } from "../auth/zoom-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";
import { mapZoomMeetingToItem } from "./zoom-meeting-mapping.ts";

const SERVICE_ID = "zoom";
const CURSOR_PREFIX = "nimbus-zoom1:";
const BASE = "https://api.zoom.us";
const PAGE_SIZE = 100;
// MAX_PAGES * PAGE_SIZE = 2 000 meetings/cycle. Matches every other Tier-1
// connector's cap; the median Zoom user has well under that. Heavy users
// (years of recurring meetings) would see truncation here — raising the cap
// is a deliberate follow-up paired with cursor-persistence across cycles,
// not a v1 change.
const MAX_PAGES = 20;

type ZoomCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ZoomCursorV1);
}

export type ZoomSyncableOptions = {
  ensureZoomMcpRunning: () => Promise<void>;
};

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

function meetingsPath(pageToken: string): string {
  const params = new URLSearchParams({
    type: "scheduled",
    page_size: String(PAGE_SIZE),
  });
  if (pageToken !== "") {
    params.set("next_page_token", pageToken);
  }
  return `/v2/users/me/meetings?${params.toString()}`;
}

async function zoomGet(
  ctx: SyncContext,
  token: string,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  // Bearer auth — the token is never logged. Path-only logging on error.
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "zoom GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function extractPage(parsed: unknown): { meetings: unknown[]; nextPageToken: string } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { meetings: [], nextPageToken: "" };
  }
  const meetings = root["meetings"];
  const nextRaw = root["next_page_token"];
  return {
    meetings: Array.isArray(meetings) ? meetings : [],
    nextPageToken: typeof nextRaw === "string" ? nextRaw : "",
  };
}

function upsertMeetings(ctx: SyncContext, meetings: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const m of meetings) {
    const mapped = mapZoomMeetingToItem(m, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

/**
 * Walk A only — `GET /v2/users/me/meetings?type=scheduled&page_size=100`,
 * following `next_page_token`, capped at MAX_PAGES. Walk B (recordings +
 * transcripts) is PR-3. The first-page http/parse error path maps to the
 * pass-cursor-empty result so a transient Zoom outage doesn't lose the
 * cursor; later-page errors break and keep whatever was already upserted.
 */
export function createZoomSyncable(options: ZoomSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureZoomMcpRunning();

      // Gate the sync on a present + valid token. No token → noop; the lazy
      // mesh also no-ops in this state, so this is the right "credentials
      // not configured" branch.
      const raw = await readConnectorSecret(ctx.vault, "zoom", "oauth");
      if (raw === null || raw === "") {
        return syncNoopResult(cursor, t0);
      }
      let token: string;
      try {
        token = await getValidZoomAccessToken(ctx.vault);
      } catch {
        return syncNoopResult(cursor, t0);
      }
      if (token === "") {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let pageToken = "";

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await zoomGet(ctx, token, meetingsPath(pageToken));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const { meetings, nextPageToken } = extractPage(outcome.parsed);
        totalUpserted += upsertMeetings(ctx, meetings, now);

        if (meetings.length === 0 || nextPageToken === "") {
          break;
        }
        pageToken = nextPageToken;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
```

- [ ] **Step 4: Register `"zoom"` with the rate limiter**

In `packages/gateway/src/sync/rate-limiter.ts`:

- Append `| "zoom"` to the `Provider` union (it sits as the last `|` arm; place after `"stackoverflow"`).
- Append a `zoom` entry to `DEFAULT_QUOTAS` matching the Tier-1 default:

```ts
  stackoverflow: { requestsPerMinute: 60, burstSize: 10 },
  zoom: { requestsPerMinute: 60, burstSize: 10 },
};
```

Zoom's published rate limit varies by plan tier (Light category: ~10 req/sec for `meetings/list`); 60 req/min with burst 10 is a conservative floor that matches every other Tier-1 connector and stays well under the lowest plan's documented ceiling. The TS `satisfies`-style exhaustiveness is enforced by `DEFAULT_QUOTAS: Record<Provider, ProviderQuota>` — without this entry the file won't compile.

- [ ] **Step 5: Register the syncable**

In `packages/gateway/src/platform/assemble-sync-registrations.ts`:

Add the import (alphabetical with the existing per-service imports — find the existing `createStackOverflowSyncable` import and add after it):

```ts
import { createStackOverflowSyncable } from "../connectors/stackoverflow-sync.ts";
import { createZoomSyncable } from "../connectors/zoom-sync.ts";
```

Add the registration (at the bottom of the function, after the last existing `syncScheduler.register`):

```ts
  syncScheduler.register(
    createZoomSyncable({
      ensureZoomMcpRunning: () => connectorMesh.ensureZoomRunning(),
    }),
  );
}
```

- [ ] **Step 6: Run the sync tests**

Run: `bun test packages/gateway/src/connectors/zoom-sync.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Run a broader sync test to confirm registration didn't break anything**

Run: `bun test packages/gateway/src/platform/assemble-sync-registrations.test.ts`
Expected: PASS (if the test asserts exhaustive coverage, the new `zoom` registration satisfies it; if it asserts a specific count, update that count in the same commit and note it in the message).

- [ ] **Step 8: Run the rate-limiter test**

Run: `bun test packages/gateway/src/sync/rate-limiter.test.ts`
Expected: PASS — the test likely iterates over `Provider` and confirms every entry has a `DEFAULT_QUOTAS` mapping (the TS-level exhaustiveness already enforces that, but a runtime check is common).

- [ ] **Step 9: Gateway typecheck**

Run: `bun run typecheck`
Expected: gateway exits 0.

- [ ] **Step 10: Commit**

```powershell
git add packages/gateway/src/connectors/zoom-sync.ts packages/gateway/src/connectors/zoom-sync.test.ts packages/gateway/src/sync/rate-limiter.ts packages/gateway/src/platform/assemble-sync-registrations.ts
git commit -m @'
feat(connectors): zoom Walk A — /v2/users/me/meetings sync handler

Token-paginated walk (next_page_token), MAX_PAGES=20, every HTTP call
gates on ctx.rateLimiter.acquire("zoom"). First-page http/parse error
maps to pass-cursor-empty so the next cycle re-walks. cursor encoded as
nimbus-zoom1:{pass:1}; the syncable is registered via
ensureZoomMcpRunning so the lazy mesh spawns Zoom on demand. Adds
"zoom" to rate-limiter Provider union + DEFAULT_QUOTAS (60 req/min,
burst 10 — matches every Tier-1 connector and stays under Zoom's
lightest-plan ceiling). Walk B (recordings + transcripts) is PR-3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 10: MCP server package `packages/mcp-connectors/zoom`

**Files:**
- Create: `packages/mcp-connectors/zoom/package.json`
- Create: `packages/mcp-connectors/zoom/tsconfig.json`
- Create: `packages/mcp-connectors/zoom/biome.json` (or whatever the existing connectors use — match `stackoverflow/`)
- Create: `packages/mcp-connectors/zoom/src/server.ts`
- Create: `packages/mcp-connectors/zoom/src/search-filter.ts`
- Create: `packages/mcp-connectors/zoom/test/search-filter.test.ts`
- Create: `packages/mcp-connectors/zoom/test/sandbox.test.ts`
- Create: `packages/mcp-connectors/zoom/README.md`

**Implementer:** clone the `packages/mcp-connectors/stackoverflow/` package structure exactly — same `package.json`, `tsconfig.json`, layout, `sandbox.test.ts` shape. Adjust names and the API surface as below.

- [ ] **Step 1: Scaffold the package files (package.json, tsconfig.json, README.md)**

Mirror `packages/mcp-connectors/stackoverflow/package.json` exactly — change the `name` to `"nimbus-mcp-zoom"`, keep the rest of the fields identical.

Mirror `packages/mcp-connectors/stackoverflow/tsconfig.json` exactly (a single `extends` line).

`README.md` — match the public-tier H2 sections used by other connector READMEs (Overview / Authentication / Tools / Coverage). The `audit:package-readmes` gate enforces this.

- [ ] **Step 2: Write the search-filter test**

Create `packages/mcp-connectors/zoom/test/search-filter.test.ts` mirroring `packages/mcp-connectors/stackoverflow/test/search-filter.test.ts`:

```ts
import { describe, expect, it } from "bun:test";

import { filterZoomMeetings } from "../src/search-filter.ts";

const SAMPLE = [
  { id: 1, topic: "Weekly sync", agenda: "status updates", host_id: "h-alice" },
  { id: 2, topic: "1:1 with Bob", agenda: "", host_id: "h-alice" },
  { id: 3, topic: "Design review", agenda: "scope cuts", host_id: "h-eve" },
];

describe("filterZoomMeetings", () => {
  it("matches topic substring (case-insensitive)", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "weekly" })).toHaveLength(1);
  });

  it("matches agenda substring", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "scope" })).toHaveLength(1);
  });

  it("limit caps the matches", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "with", limit: 0 })).toHaveLength(0);
  });

  it("returns empty when no match", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "no-match" })).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Implement `search-filter.ts`**

Create `packages/mcp-connectors/zoom/src/search-filter.ts`:

```ts
/**
 * Pure substring search over a Zoom meetings list. The MCP server uses this
 * to power `zoom_search` against the first page of `GET /v2/users/me/meetings`
 * — no API call is made (the search is local to the already-fetched page).
 */

export interface ZoomSearchOptions {
  readonly query: string;
  readonly limit?: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function stringField(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  return typeof v === "string" ? v : "";
}

export function filterZoomMeetings(
  meetings: readonly unknown[],
  options: ZoomSearchOptions,
): unknown[] {
  const q = options.query.trim().toLowerCase();
  if (q === "") {
    return [];
  }
  const limit = options.limit ?? 50;
  if (limit <= 0) {
    return [];
  }
  const matches: unknown[] = [];
  for (const m of meetings) {
    const row = asRecord(m);
    if (row === undefined) {
      continue;
    }
    const haystack =
      `${stringField(row, "topic")} ${stringField(row, "agenda")} ${stringField(row, "host_id")}`.toLowerCase();
    if (haystack.includes(q)) {
      matches.push(m);
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return matches;
}
```

- [ ] **Step 4: Run the filter test**

Run: `bun test packages/mcp-connectors/zoom/test/search-filter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement the MCP server**

Create `packages/mcp-connectors/zoom/src/server.ts`:

```ts
/**
 * nimbus-mcp-zoom — Zoom REST API MCP server (read-only). Credentials arrive
 * as the ZOOM_TOKEN env var, injected at spawn time by the Gateway after
 * resolving a fresh OAuth access token via getValidZoomAccessToken. Bearer
 * auth: `Authorization: Bearer <token>` + `Accept: application/json`; the
 * token is never logged. The API host is fixed at api.zoom.us. v1 indexes
 * scheduled meetings (`/v2/users/me/meetings?type=scheduled`); PR-3 adds
 * recordings/transcripts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterZoomMeetings } from "./search-filter.ts";

const BASE = "https://api.zoom.us";

function apiToken(): string {
  const t = process.env["ZOOM_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("ZOOM_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${apiToken()}`, Accept: "application/json" };
}

/**
 * Zoom path-encode a meeting id-or-UUID. Per Zoom's REST API docs: numeric
 * meeting IDs and UUIDs both go in the `{meetingId}` slot, but if a UUID
 * begins with `/` or contains `//`, it MUST be double-encoded. The simplest
 * safe rule is: detect the literal prefix / substring and double-encode in
 * those cases, single-encode otherwise. Numeric IDs never trigger the
 * double-encode branch.
 */
export function encodeZoomMeetingPathSegment(idOrUuid: string): string {
  const needsDoubleEncode = idOrUuid.startsWith("/") || idOrUuid.includes("//");
  const once = encodeURIComponent(idOrUuid);
  return needsDoubleEncode ? encodeURIComponent(once) : once;
}

async function zoomGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Zoom ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-zoom", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "zoom_list",
  "List the authenticated user's scheduled Zoom meetings (`GET /v2/users/me/meetings?type=scheduled&page_size=100`). Returns the `{ meetings: [...], next_page_token, page_size, total_records }` envelope — `meetings` holds the meeting objects.",
  z.object({}),
  async () => {
    return jsonResult(await zoomGet("/v2/users/me/meetings?type=scheduled&page_size=100"));
  },
);

reg(
  "zoom_get",
  "Fetch one Zoom meeting by its numeric meeting id OR its UUID (`GET /v2/meetings/{meetingId}`). Returns the meeting object directly (NOT wrapped in `{ meetings }`). Throws when no match is found. UUIDs are auto-double-encoded when they start with `/` or contain `//` (Zoom's documented requirement).",
  z.object({
    id: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(await zoomGet(`/v2/meetings/${encodeZoomMeetingPathSegment(p.id)}`));
  },
);

reg(
  "zoom_search",
  "**Substring search over the FIRST PAGE only** (up to 100 most recently-listed scheduled meetings) of the authenticated user's Zoom meetings. The Zoom REST API has no native text-search endpoint for meetings; this tool fetches `GET /v2/users/me/meetings?type=scheduled&page_size=100` once and matches the query locally against the meeting topic, agenda, and host id (case-insensitive). **Meetings older than the first page are not searchable here — query the local Nimbus index instead for full coverage.** Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const root = await zoomGet("/v2/users/me/meetings?type=scheduled&page_size=100");
    const meetings = (root as { meetings?: unknown[] } | null)?.meetings;
    const matches = Array.isArray(meetings)
      ? filterZoomMeetings(meetings, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
```

- [ ] **Step 6: Test the UUID double-encode helper**

The double-encode behaviour for UUIDs starting with `/` or containing `//` is Zoom's documented requirement; it deserves an explicit unit test. Create `packages/mcp-connectors/zoom/test/encode-meeting-path.test.ts`:

```ts
import { describe, expect, it } from "bun:test";

import { encodeZoomMeetingPathSegment } from "../src/server.ts";

describe("encodeZoomMeetingPathSegment", () => {
  it("single-encodes a plain numeric meeting id", () => {
    expect(encodeZoomMeetingPathSegment("83476203401")).toBe("83476203401");
  });

  it("single-encodes a normal base64-ish UUID", () => {
    expect(encodeZoomMeetingPathSegment("abcd1234==")).toBe("abcd1234%3D%3D");
  });

  it("double-encodes a UUID that starts with /", () => {
    expect(encodeZoomMeetingPathSegment("/abc==")).toBe(
      encodeURIComponent(encodeURIComponent("/abc==")),
    );
  });

  it("double-encodes a UUID that contains //", () => {
    expect(encodeZoomMeetingPathSegment("ab//cd")).toBe(
      encodeURIComponent(encodeURIComponent("ab//cd")),
    );
  });
});
```

(Note: this requires `encodeZoomMeetingPathSegment` to be `export`-ed from `src/server.ts` — already shown above in the implementation block.)

Run: `bun test packages/mcp-connectors/zoom/test/encode-meeting-path.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Sandbox contract test**

Create `packages/mcp-connectors/zoom/test/sandbox.test.ts` mirroring `packages/mcp-connectors/stackoverflow/test/sandbox.test.ts`. The test imports the package's manifest from `first-party-manifests.ts` (Task 7) and runs the SDK sandbox contract test — copy the existing connector's exact shape.

- [ ] **Step 9: Run the MCP package's tests**

Run: `bun test packages/mcp-connectors/zoom/`
Expected: PASS.

- [ ] **Step 10: Install + typecheck the new package**

Run: `bun install`
Then: `bun run typecheck`
Expected: `@nimbus/gateway typecheck: Exited with code 0`; `nimbus-mcp-zoom typecheck: Exited with code 0`.

- [ ] **Step 11: Commit**

```powershell
git add packages/mcp-connectors/zoom/ bun.lock
git commit -m @'
feat(mcp-connectors/zoom): read-only MCP server — list/get/search meetings

Bearer auth via injected ZOOM_TOKEN; fixed SaaS host api.zoom.us. Tools
mirror the Stack Overflow shape: zoom_list (first page of scheduled
meetings), zoom_get (by meeting id), zoom_search (substring over the
first-page topic/agenda/host). hitlRequired: []. PR-3 adds recordings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 11: D11 allow-list + docs

**Files:**
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/roadmap.md` (line 505 — Zoom row)
- Modify: `.claude/commands/nimbus-file-map.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: D11 allow-list update**

In `scripts/structure-audit/check-nimbus-invariants.ts`, append `auth/zoom-access-token.ts` to `VAULT_KEY_ALLOW_LIST` (alongside `oauth-registry.ts` from PR-1):

```ts
  // OAuth provider registry — single source of truth for descriptor.vaultKey
  // values across google/microsoft/slack/notion (PR-1).
  "packages/gateway/src/auth/oauth-registry.ts",
  // Zoom OAuth resolver — constructs the "zoom.oauth" vault key in its
  // parseErrors defaults (PR-2).
  "packages/gateway/src/auth/zoom-access-token.ts",
```

- [ ] **Step 2: Run audit:invariants**

Run: `bun run audit:invariants`
Expected: PASS (exit 0).

- [ ] **Step 3: CHANGELOG entry**

In `docs/CHANGELOG.md` under the existing `### 2026-05-27` section (the same date as PR-1), add a Zoom bullet near the bottom (after Stack Overflow). Use the established prose style — start with `- **Tier-1 connector — Zoom** ✅` and describe what landed (scheduled meetings via `/v2/users/me/meetings`, rotating refresh tokens through the single-flight registry, fixed `api.zoom.us`/`zoom.us` sandbox). Keep it dense — single bullet, multi-clause sentence, mirroring the existing Stack Overflow entry.

- [ ] **Step 4: Roadmap tick**

In `docs/roadmap.md`, change line 505 from `[ ] **Zoom** — meeting metadata, recordings index, AI-generated transcripts ...` to:

```md
- [x] **Zoom** — meeting metadata (PR-2 ✅ 2026-05-27); recordings index + AI-generated transcripts deferred to PR-3 on the same OAuth grant
```

(Adjust the wording to match the existing tick conventions in the file — keep the `Zoom` heading, mark the meetings part complete, note PR-3 follow-up.)

- [ ] **Step 5: nimbus-file-map entries**

In `.claude/commands/nimbus-file-map.md`, add rows for:
- `packages/gateway/src/connectors/zoom-sync.ts` — under the "Connectors + MCP Mesh" section
- `packages/gateway/src/connectors/zoom-meeting-mapping.ts` — same section
- `packages/mcp-connectors/zoom/src/server.ts` — same section
- `packages/gateway/src/auth/zoom-access-token.ts` — under "Vault + Auth"

Match the existing single-row prose density (the Stack Overflow / Pipedrive rows are good templates).

- [ ] **Step 6: cli-reference**

In `docs/cli-reference.md`, find the existing OAuth `nimbus connector auth` section and add a `zoom` entry. Existing entries (slack, notion) show the env-var requirements + the example invocation — match the shape.

- [ ] **Step 7: architecture.md**

In `docs/architecture.md`, find the connector + item-type tables (search for the Slack / Notion rows) and add Zoom rows to both. Specifically:
- Connector inventory row — `zoom` / `OAuth (PKCE + Basic-header secret)` / `meetings (PR-2); transcripts (PR-3 deferred)` / `hitlRequired: []`.
- Item-type row — `zoom:meeting` / sparse-structured / local MiniLM embeddings.

- [ ] **Step 8: Doc-references check**

Run: `bun scripts/structure-audit/check-doc-references.ts --check`
Expected: PASS (all new doc paths resolve).

- [ ] **Step 9: Commit**

```powershell
git add scripts/structure-audit/check-nimbus-invariants.ts docs/CHANGELOG.md docs/roadmap.md .claude/commands/nimbus-file-map.md docs/cli-reference.md docs/architecture.md
git commit -m @'
docs+audit: Zoom connector PR-2 — D11 allow-list, CHANGELOG, roadmap, file-map, cli-reference, architecture

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 12: Full local gate + push + PR update

**Files:** none (verification only).

- [ ] **Step 1: Run preflight:fast**

Run: `bun run preflight:fast --no-bail`
Expected: every gate except the pre-existing `typecheck` (vscode-extension) is green. Specifically:
- ✓ lint (biome)
- ✓ lint:markdown
- ✓ audit:doc-refs
- ✓ audit:openapi-drift
- ✓ audit:boundaries
- ✓ audit:invariants
- ✓ audit:any
- ✓ audit:release-please
- ✓ audit:js-licenses
- ✓ audit:svg-assets
- ✓ audit:readme-cli
- ✓ audit:package-readmes
- ✓ audit:cross-platform
- ✓ audit:exclusion-parity
- ✓ duplication (jscpd)

The ✗ on `typecheck` is the same pre-existing `nimbus-vscode` failure that PR-1 ignored.

- [ ] **Step 2: Run the full test suite for the touched directories**

Run: `bun test packages/gateway/src/auth/ packages/gateway/src/connectors/ packages/mcp-connectors/zoom/`
Expected: all tests pass.

- [ ] **Step 3: Push (the pre-push hook will fail on the same pre-existing typecheck — bypass with the documented escape hatch)**

Run: `$env:NIMBUS_SKIP_PREPUSH=1; git push origin dev/asafgolombek/connector-buildout-rest; Remove-Item Env:\NIMBUS_SKIP_PREPUSH`
Expected: push succeeds. The push updates the existing PR #447.

- [ ] **Step 4: Add a comment to PR #447 noting PR-2 is now stacked on top**

```powershell
gh pr comment 447 --body @'
PR-2 (Zoom connector — meetings only) is now stacked on top of PR-1 in this branch. New commits:

- `feat(auth): widen OAuthProvider union to include "zoom" + add zoom descriptor`
- `feat(config): NIMBUS_OAUTH_ZOOM_CLIENT_ID + _SECRET knobs + env-help messages`
- `feat(catalog): register "zoom" ConnectorServiceId + 10-min sync interval + OAuth profile`
- `feat(connectors): zoom vault-secrets manifest entry (zoom.oauth)`
- `feat(connector-rpc): zoom branch in OAuth-PKCE auth handler`
- `feat(auth): getValidZoomAccessToken — registry-delegated resolver`
- `feat(connectors/lazy-mesh): zoom slot + ensureZoomMcp + sandbox manifest (I15)`
- `feat(connectors): pure zoom meeting mapper + unit tests`
- `feat(connectors): zoom Walk A — /v2/users/me/meetings sync handler`
- `feat(mcp-connectors/zoom): read-only MCP server — list/get/search meetings`
- `docs+audit: Zoom connector PR-2 — D11 allow-list, CHANGELOG, roadmap, file-map, cli-reference, architecture`

PR-3 (Zoom recordings + transcripts on the same OAuth grant) is the follow-up plan.
'@
```

---

## Self-review (completed during authoring)

- **Spec §2 coverage (Zoom auth wiring):** descriptor in `OAUTH_PROVIDERS` (Task 1) ✓ · Config knobs (Task 2) ✓ · help-message constants (Task 2) ✓ · `connector.auth` zoom routing in `oauthClientConfigForProvider` + secret supply (Task 5) ✓ · `getValidZoomAccessToken` resolver (Task 6) ✓ · spawn injection + orchestration (Task 7) ✓ · sandbox manifest (Task 7) ✓ · catalog + secrets + rate-limiter slot + `ConnectorServiceId` (Tasks 3 + 4) ✓.
- **Spec §3 Walk A only:** sync handler with token-pagination + rate-limiter + first-page pass-cursor (Task 9) ✓ · pure mapper (Task 8) ✓ · MCP server with read-only meeting tools (Task 10) ✓ · D11 allow-list (Task 11) ✓.
- **Behaviour preservation:** the seven PR-1 auth tests (`pkce.test.ts`, `google-access-token.test.ts`, `notion-access-token.test.ts`, `slack-access-token.test.ts`, `oauth-vault-tokens.test.ts`, `oauth-vault-scopes.test.ts`, `oauth-registry.test.ts`) stay green unchanged. New test files: `oauth-registry.test.ts` gains 3 zoom-descriptor tests (additive — no edit to existing); `zoom-access-token.test.ts` lands fresh in Task 6.
- **Rotating refresh tokens:** the explicit test in Task 6 Step 1 asserts the new refresh token is persisted and the old one discarded — this is the chain-invalidating concern that motivated the PR-1 single-flight lock, and it lives at the resolver layer (no zoom-specific refresh code needed because `refreshViaRegistry` already does `refresh_token ?? old`).
- **PR-3 is explicitly deferred:** Walk B (`/v2/users/me/recordings`), VTT parsing, `zoom-transcript-mapping.ts`, `"zoom:transcript"` in `PROSE_HEAVY_TYPES`, the skip-if-exists check, and recordings MCP tools are out of scope. The OAuth grant in Task 3 already includes `cloud_recording:read:list_user_recordings` so PR-3 needs no re-consent.
- **Type consistency:** `OAuthProvider` ("zoom" added in Task 1) propagates through `oauthClientConfigForProvider` (Task 5) and `oauthProfileForService` (Task 3) via the existing exhaustiveness check. `ConnectorServiceId` is the same — the `satisfies` in `CONNECTOR_VAULT_SECRET_KEYS` (Task 4) enforces it. `ZoomMeetingMappedRow` is a fresh type local to Task 8; the sync handler in Task 9 consumes it through `upsertIndexedItemForSync` (the same path Stack Overflow uses).
- **No placeholder steps:** every code step shows the exact code; every command step shows the exact command + expected output; the test-harness reference in Task 9 Step 1 explicitly points to `stackoverflow-sync.test.ts` as the canonical helper to clone (the harness is non-trivial enough to clone rather than re-state, and that's an established codebase convention — see the existing 15+ `*-sync.test.ts` files all cloning the same shape).

## Review dispositions (2026-05-28)

Plan review (`…-pr2-review.md`) raised six points; dispositions:

1. **`modifiedAt` future-dating from `start_time`** — ✅ **fixed**. The mapper now uses `createdMs ?? ctx.syncedAt` (drops `startMs` from the fallback chain). `start_time` stays in metadata for "meetings starting next week"-style queries. Zoom's `/v2/users/me/meetings` list endpoint does not return `updated_at`; when per-meeting GET enrichment is added later we can prefer it. Two new mapper tests cover the new behaviour (Task 8).
2. **Topic fallback / `externalId` strictness** — ◐ **confirmed correct, no change**. `externalId = String(numberField(row, "id"))` parses through the typed helper and rejects non-numeric ids by returning `null` from the mapper (Task 8 already had the test).
3. **`MAX_PAGES = 20` truncates at 2000 meetings** — ◐ **deferred + documented**. Matches every Tier-1 connector's cap; raising it pairs with cross-cycle cursor persistence and is intentionally out of v1 scope. A `MAX_PAGES` code comment in `zoom-sync.ts` (Task 9 Step 3) flags the convention so future contributors don't bump it casually.
4. **Rate-limiter `Provider` union + `DEFAULT_QUOTAS` entry missing from plan** — ✅ **fixed**. Task 9 gained a new Step 4 (and renumbered subsequent steps): extend the union with `"zoom"` and add `zoom: { requestsPerMinute: 60, burstSize: 10 }` to `DEFAULT_QUOTAS`. The TS exhaustiveness of `Record<Provider, ProviderQuota>` enforces both — without the entry the file won't compile. The commit message in Task 9 Step 10 notes the addition.
5. **`zoom_search` first-page limitation in tool description** — ✅ **fixed**. The tool description now leads with a bolded callout and explicitly tells the LLM to "query the local Nimbus index instead for full coverage" when meetings older than the first page are needed (Task 10).
6. **Meeting-UUID double-encoding in `zoom_get`** — ✅ **fixed**. Added a documented `encodeZoomMeetingPathSegment` helper exported from `src/server.ts` that detects the Zoom-specific double-encode trigger (UUID starts with `/` or contains `//`) and applies double-encoding only when needed. Numeric ids and "normal" UUIDs are still single-encoded. A new unit-test file `test/encode-meeting-path.test.ts` covers all four cases (numeric, normal UUID, leading-`/`, embedded `//`).

## Hand-off to PR-3

PR-3 builds on the API this PR locks: `OAUTH_PROVIDERS.zoom` (descriptor reuse), `getValidZoomAccessToken` (token resolution), `mapZoomMeetingToItem` (PR-3 dedupe target — the parent-meeting upsert under the same `external_id`), `ensureZoomMcp` (the lazy-mesh slot — PR-3 will expand its MCP server's tool surface). PR-3 will:
- Add `connectors/zoom-transcript-mapping.ts` with `mapZoomTranscriptToItem` (VTT→plaintext pure function, `external_id = <meeting_uuid>:<recording_file_id>`).
- Add `"zoom:transcript"` to `PROSE_HEAVY_TYPES`.
- Extend `zoom-sync.ts` with Walk B (`/v2/users/me/recordings`, ≤30-day windowed cursor, skip-if-exists check on `external_id`).
- Add recordings tools (`zoom_recordings_list` / `zoom_transcript_get`) to the MCP server.
- Add the routing-test entry + the integration test for windowing.

The PR-3 plan is written **after** PR-2 lands green so its concrete code references the actually-landed signatures.
