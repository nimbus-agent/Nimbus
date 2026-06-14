# Mendeley Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a read-only Mendeley connector that indexes the user's Mendeley library document metadata into the local index as `mendeley:reference` items, mirroring the shipped Zotero connector but authenticating via Elsevier OAuth2.

**Architecture:** A new `packages/mcp-connectors/mendeley/` MCP server (interactive `list`/`get`/`search` tools, spawned lazily with an injected access token — the Notion OAuth pattern) plus a gateway-side `Syncable` (`mendeley-sync.ts` + `mendeley-reference-mapping.ts`) that background-indexes documents. Auth is a new `OAuthProvider` (`mendeley`, authorization-code, confidential client, user-supplied client id/secret via env). Pagination follows Mendeley's RFC 5988 `Link` header via a focused, rate-limit-aware fetch (the shared header-blind `connectorFetch` is left untouched).

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, Zod, `@modelcontextprotocol/sdk`, `@nimbus-dev/sdk`, the gateway sync/rate-limiter/OAuth-registry subsystems.

**Spec:** `docs/superpowers/specs/2026-06-14-slice9-mendeley-connector-design.md` (+ `-review.md` triage).

---

## Reference implementations (read these first)

| Concern | Reference file |
|---|---|
| OAuth provider descriptor | `packages/gateway/src/auth/oauth-registry.ts` (`notion`/`zoom` entries, `OAUTH_PROVIDERS`, `getValidVaultAccessToken`) |
| Per-provider token accessor | `packages/gateway/src/auth/notion-access-token.ts` |
| Client-config switch | `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` (`oauthClientConfigForProvider`) |
| Env-var config getters | `packages/gateway/src/config.ts:116-118` |
| OAuth help strings | `packages/gateway/src/auth/oauth-env-help-messages.ts` (`NOTION_OAUTH_*`) |
| Catalog / serviceId / oauthProfile | `packages/gateway/src/connectors/connector-catalog.ts` |
| Secrets manifest | `packages/gateway/src/connectors/connector-secrets-manifest.ts` (`notion`, `zotero`) |
| Rate limiter union + config | `packages/gateway/src/sync/rate-limiter.ts` (`Provider`, rate map) |
| Sandbox manifest | `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts` (`zotero`, `notion`) |
| Lazy OAuth spawn | `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts` (`ensureNotionMcp`) |
| Mesh slot + run method | `packages/gateway/src/connectors/lazy-mesh/{keys.ts, mesh.ts, credential-orchestration.ts}` |
| MCP server | `packages/mcp-connectors/zotero/src/server.ts` + `notion/src/server.ts` |
| Search filter | `packages/mcp-connectors/zotero/src/search-filter.ts` (+ test) |
| Gateway sync (OAuth) | `packages/gateway/src/connectors/notion-sync.ts` |
| Gateway sync (mapping/pagination) | `packages/gateway/src/connectors/zotero-sync.ts` + `zotero-reference-mapping.ts` |
| Sync registration | `packages/gateway/src/platform/assemble-sync-registrations.ts` (`createNotionSyncable`) |
| Sync result helpers | `packages/gateway/src/sync/pass-cursor-sync-result.ts`, `sync/types.ts` |

**Commands** (run from the worktree root `C:\gitrep\Nimbus\.claude\worktrees\dev+asafgolombek+phase6-slice9-deferred-phase5`):
- One test file: `bun test packages/gateway/src/connectors/mendeley-reference-mapping.test.ts`
- Connector tests: `bun test packages/mcp-connectors/mendeley`
- Typecheck (gateway): `bun run --filter @nimbus-dev/gateway typecheck` (or `cd packages/gateway && bunx tsc --noEmit`)
- Lint a path: `bunx biome check packages/gateway/src/connectors/mendeley-sync.ts`

**Note on the type-coupling order:** widening `OAuthProvider` (Task 2) before `ConnectorServiceId` (Task 3) keeps the build green, because `oauthProfileForService` (Task 3) returns `provider: "mendeley"`, which must already exist in the union.

---

## Task 1: Create the MCP connector package skeleton

**Files:**
- Create: `packages/mcp-connectors/mendeley/package.json`
- Create: `packages/mcp-connectors/mendeley/tsconfig.json`
- Create: `packages/mcp-connectors/mendeley/nimbus.extension.json`

- [ ] **Step 1: Write `package.json`** (mirror Zotero's)

```json
{
  "name": "nimbus-mcp-mendeley",
  "version": "0.1.0",
  "private": false,
  "license": "AGPL-3.0-only",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "test": "bun test",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "@nimbus-dev/sdk": "workspace:*",
    "zod": "^4.4.2"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["bun"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Write `nimbus.extension.json`** (read-only ⇒ empty `hitlRequired`; `network` is `api.mendeley.com` only)

```json
{
  "id": "com.nimbus.mendeley",
  "displayName": "Mendeley",
  "version": "0.1.0",
  "description": "Mendeley connector (read-only). Surfaces the metadata of the user's Mendeley reference library as `mendeley:reference` items in the local index — the title, the author list, the publication year, the source/publication, the document type, keywords, the DOI/identifiers, the source URL, and a truncated abstract. Binary PDF attachments are never fetched or parsed. Useful for research questions (\"what did I save about retrieval-augmented generation?\") without leaving Nimbus. Authenticates via the Elsevier OAuth2 authorization-code flow (confidential client); the user supplies their own NIMBUS_OAUTH_MENDELEY_CLIENT_ID / _SECRET. The SaaS host (api.mendeley.com) is fixed. The /documents endpoint paginates via RFC 5988 Link headers (rel=\"next\"); the connector walks a single page-capped forward pass per cycle and supports modified_since incremental pulls.",
  "author": "Nimbus",
  "entrypoint": "dist/server.js",
  "runtime": "bun",
  "permissions": {
    "network": ["api.mendeley.com"]
  },
  "hitlRequired": [],
  "syncInterval": 600,
  "minNimbusVersion": "0.2.0"
}
```

- [ ] **Step 4: Install workspace deps** so the new package links

Run: `bun install`
Expected: completes; `packages/mcp-connectors/mendeley/node_modules` symlinks `@nimbus-dev/sdk`.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/mendeley/package.json packages/mcp-connectors/mendeley/tsconfig.json packages/mcp-connectors/mendeley/nimbus.extension.json bun.lock
git commit -m "feat(mendeley): connector package skeleton + manifest"
```

---

## Task 2: Register the `mendeley` OAuth provider

**Files:**
- Modify: `packages/gateway/src/auth/oauth-registry.ts` (union ~line 5-15; `OAUTH_PROVIDERS` ~line 205)
- Create: `packages/gateway/src/auth/mendeley-access-token.ts`
- Test: `packages/gateway/src/auth/mendeley-access-token.test.ts`
- Modify: `packages/gateway/src/config.ts` (~line 118, after the zoom getters)
- Modify: `packages/gateway/src/auth/oauth-env-help-messages.ts`
- Modify: `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` (`oauthClientConfigForProvider`)

- [ ] **Step 1: Add `mendeley` to the `OAuthProvider` union**

In `oauth-registry.ts`, extend the union:

```ts
export type OAuthProvider =
  | "google"
  | "microsoft"
  | "slack"
  | "notion"
  | "zoom"
  | "hubspot"
  | "miro"
  | "canva"
  | "figma"
  | "salesforce"
  | "mendeley";
```

- [ ] **Step 2: Run typecheck to see the exhaustiveness failures**

Run: `cd packages/gateway && bunx tsc --noEmit`
Expected: FAIL — `OAUTH_PROVIDERS` is missing key `mendeley`, and `oauthClientConfigForProvider`'s switch is non-exhaustive. These are the sites Steps 3 + 6 fix.

- [ ] **Step 3: Add the Mendeley descriptor to `OAUTH_PROVIDERS`**

Insert after the `salesforce` entry (Elsevier uses standard form-encoded token exchange, basic-header client auth, no PKCE):

```ts
  mendeley: {
    id: "mendeley",
    vaultKey: "mendeley.oauth",
    authorizeUrl: "https://api.mendeley.com/oauth/authorize",
    tokenUrl: "https://api.mendeley.com/oauth/token",
    usesPkce: false,
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
    }),
    parseTokenResponse: parseStandardTokenResponse,
  },
```

- [ ] **Step 4: Add the env-var config getters**

In `packages/gateway/src/config.ts`, directly after the `oauthZoomClientSecret` line (~118), add:

```ts
  oauthMendeleyClientId: processEnvGet("NIMBUS_OAUTH_MENDELEY_CLIENT_ID") ?? "",
  oauthMendeleyClientSecret: processEnvGet("NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET") ?? "",
```

- [ ] **Step 5: Add the OAuth help strings**

In `packages/gateway/src/auth/oauth-env-help-messages.ts`, append:

```ts
export const MENDELEY_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_MENDELEY_CLIENT_ID to your Elsevier/Mendeley application's OAuth client ID.

1. https://dev.mendeley.com/myapps.html → register an application with the authorization-code flow.
2. Set the redirect URI to the Nimbus loopback redirect.

You must also set NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET (Mendeley's token endpoint requires HTTP Basic auth with the secret).

PowerShell:
  $env:NIMBUS_OAUTH_MENDELEY_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET = "..."`;

export const MENDELEY_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET to your Mendeley application's OAuth client secret.

Mendeley's token exchange requires the client secret in the environment (it is not stored in the Nimbus vault).
https://dev.mendeley.com/myapps.html → your application → copy the secret.

PowerShell:
  $env:NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET = "..."`;
```

- [ ] **Step 6: Add the `mendeley` case to `oauthClientConfigForProvider`**

In `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts`, add (and import the two help constants at the top of the file alongside the existing `NOTION_OAUTH_*` imports):

```ts
    case "mendeley":
      return {
        clientId: Config.oauthMendeleyClientId,
        emptyClientIdMessage: MENDELEY_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthMendeleyClientSecret,
        clientSecretMissingHelp: MENDELEY_OAUTH_CLIENT_SECRET_HELP,
      };
```

- [ ] **Step 7: Write the failing test for the token accessor**

`packages/gateway/src/auth/mendeley-access-token.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVaultForTesting } from "../vault/testing.ts";
import { getValidMendeleyAccessToken } from "./mendeley-access-token.ts";

describe("getValidMendeleyAccessToken", () => {
  test("returns the stored access token when unexpired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendeley-tok-"));
    const vault = await createVaultForTesting(dir);
    await vault.set(
      "mendeley.oauth",
      JSON.stringify({
        accessToken: "tok-abc",
        refreshToken: "ref-xyz",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["all"],
      }),
    );
    expect(await getValidMendeleyAccessToken(vault)).toBe("tok-abc");
  });

  test("throws an actionable error when not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendeley-tok-"));
    const vault = await createVaultForTesting(dir);
    await expect(getValidMendeleyAccessToken(vault)).rejects.toThrow(
      /Mendeley OAuth not configured/,
    );
  });
});
```

> If `../vault/testing.ts`/`createVaultForTesting` is not the exact helper name, copy the vault-setup lines verbatim from `notion-access-token.test.ts` in the same directory.

- [ ] **Step 8: Run the test — verify it fails**

Run: `bun test packages/gateway/src/auth/mendeley-access-token.test.ts`
Expected: FAIL — module `./mendeley-access-token.ts` not found.

- [ ] **Step 9: Implement `mendeley-access-token.ts`** (thin wrapper over the shared accessor — concurrency + refresh handled there)

```ts
import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidMendeleyAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.mendeley,
    vault,
    clientId: Config.oauthMendeleyClientId,
    clientSecret: Config.oauthMendeleyClientSecret,
    notConfiguredError: "Mendeley OAuth not configured; run: nimbus connector auth mendeley",
    parseErrors: {
      invalidJson: "Invalid mendeley.oauth vault payload",
      invalidPayload: "Invalid mendeley.oauth vault payload",
      missingAccess: "Missing Mendeley access token",
      missingRefresh: "Missing Mendeley refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_MENDELEY_CLIENT_ID and NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET for Mendeley token refresh",
  });
}
```

- [ ] **Step 10: Run the test + gateway typecheck — verify green**

Run: `bun test packages/gateway/src/auth/mendeley-access-token.test.ts`
Expected: PASS (2 tests).
Run: `cd packages/gateway && bunx tsc --noEmit`
Expected: PASS (no remaining exhaustiveness errors from the OAuth union). If the compiler flags any other provider-exhaustive switch, add the `mendeley` case there too.

- [ ] **Step 11: Commit**

```bash
git add packages/gateway/src/auth/oauth-registry.ts packages/gateway/src/auth/mendeley-access-token.ts packages/gateway/src/auth/mendeley-access-token.test.ts packages/gateway/src/config.ts packages/gateway/src/auth/oauth-env-help-messages.ts packages/gateway/src/ipc/connector-rpc-handlers/auth.ts
git commit -m "feat(mendeley): register the Mendeley OAuth2 provider"
```

---

## Task 3: Register the `mendeley` connector service id (catalog/secrets/rate-limiter/manifest)

**Files:**
- Modify: `packages/gateway/src/connectors/connector-catalog.ts` (service-id list, interval map, auth-detail map, `oauthProfileForService`)
- Modify: `packages/gateway/src/connectors/connector-secrets-manifest.ts`
- Modify: `packages/gateway/src/sync/rate-limiter.ts` (`Provider` union + rate map)
- Modify: `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts`
- Test: `packages/gateway/src/connectors/connector-catalog.test.ts` (extend existing assertions)

- [ ] **Step 1: Add `"mendeley"` to the connector service-id list**

In `connector-catalog.ts`, add `"mendeley"` to the `CONNECTOR_SERVICE_IDS` array (place it near the other reading/research connectors, e.g. after `"zotero"`).

- [ ] **Step 2: Run typecheck to enumerate the forced sites**

Run: `cd packages/gateway && bunx tsc --noEmit`
Expected: FAIL — `CONNECTOR_SYNC_INTERVAL_MS`, the auth-detail map, `oauthProfileForService`, and `connector-secrets-manifest.ts` all become non-exhaustive. Steps 3-6 fix them.

- [ ] **Step 3: Add the sync interval + auth detail**

In `connector-catalog.ts`:
- In `CONNECTOR_SYNC_INTERVAL_MS`, add: `mendeley: MIN10,`
- In the auth-description map (the `CONNECTOR_AUTH_DETAILS`-style record), add:
  `mendeley: "uses the Elsevier OAuth2 authorization-code flow with user-supplied NIMBUS_OAUTH_MENDELEY_CLIENT_ID/_SECRET (connector.auth mendeley)",`

- [ ] **Step 4: Add the `oauthProfileForService` case**

In `connector-catalog.ts` `oauthProfileForService`, add:

```ts
    case "mendeley":
      return { provider: "mendeley", defaultScopes: ["all"] };
```

- [ ] **Step 5: Add the secrets-manifest entry**

In `connector-secrets-manifest.ts`, add to the secret-keys map:

```ts
  mendeley: ["mendeley.oauth"],
```

- [ ] **Step 6: Add the rate-limiter provider + rate**

In `sync/rate-limiter.ts`:
- Add `| "mendeley"` to the `Provider` union.
- Add to the rate map: `mendeley: { requestsPerMinute: 60, burstSize: 10 },` (Mendeley's documented default is generous; 60/min mirrors Zotero).

- [ ] **Step 7: Add the sandbox manifest entry**

In `lazy-mesh/first-party-manifests.ts`, add alongside `zotero`:

```ts
  mendeley: baseManifest("com.nimbus.mendeley", {
    network: ["api.mendeley.com"],
    filesystem: { read: [], write: [] },
  }),
```

- [ ] **Step 8: Extend the catalog test**

In `connector-catalog.test.ts`, add `"mendeley"` to whatever expected-service-id assertion already lists `"zotero"` (find the test asserting the catalog contains the known connectors and add the entry, plus an interval assertion mirroring the zotero one if present).

- [ ] **Step 9: Typecheck + run catalog + manifest tests**

Run: `cd packages/gateway && bunx tsc --noEmit`
Expected: PASS.
Run: `bun test packages/gateway/src/connectors/connector-catalog.test.ts packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts`
Expected: PASS (the first-party-manifests test also enumerates known connectors — add `"mendeley"` there if it asserts an exhaustive list and fails).

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src/connectors/connector-catalog.ts packages/gateway/src/connectors/connector-catalog.test.ts packages/gateway/src/connectors/connector-secrets-manifest.ts packages/gateway/src/sync/rate-limiter.ts packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts
git commit -m "feat(mendeley): register the connector service id, secrets, rate limit, and sandbox manifest"
```

---

## Task 4: Build the MCP server tool surface (`list`/`get`/`search`)

**Files:**
- Create: `packages/mcp-connectors/mendeley/src/search-filter.ts`
- Create: `packages/mcp-connectors/mendeley/src/server.ts`
- Test: `packages/mcp-connectors/mendeley/test/search-filter.test.ts`
- Test: `packages/mcp-connectors/mendeley/test/sandbox.test.ts`

- [ ] **Step 1: Write the failing search-filter test**

`packages/mcp-connectors/mendeley/test/search-filter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { filterMendeleyDocuments } from "../src/search-filter.ts";

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc-1",
    title: "Exponential backoff with jitter avoids thundering-herd retries",
    type: "journal",
    abstract: "A study of full-jitter retry strategies for distributed queues.",
    year: 2024,
    source: "Journal of Reliability Engineering",
    identifiers: { doi: "10.1145/1234567.8901234" },
    authors: [
      { first_name: "Ada", last_name: "Lovelace" },
      { first_name: "Grace", last_name: "Hopper" },
    ],
    keywords: ["reliability", "retries"],
    last_modified: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

describe("filterMendeleyDocuments", () => {
  test("matches title, type, abstract, doi, source, authors, keywords (case-insensitive)", () => {
    expect(filterMendeleyDocuments([doc()], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "journal" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "full-jitter" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "10.1145/1234567" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "Reliability Engineering" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "Ada Lovelace" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "retries" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterMendeleyDocuments([doc()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-objectish entries and tolerates missing fields", () => {
    const sparse = doc({ abstract: undefined, identifiers: undefined, authors: [null, 7], keywords: undefined });
    expect(filterMendeleyDocuments([null, 42, "x", sparse], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterMendeleyDocuments([sparse], { query: "full-jitter" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => doc({ id: `d${String(i)}` }));
    expect(filterMendeleyDocuments(many, { query: "exponential backoff", limit: 3 })).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `bun test packages/mcp-connectors/mendeley/test/search-filter.test.ts`
Expected: FAIL — `../src/search-filter.ts` not found.

- [ ] **Step 3: Implement `search-filter.ts`** (uses the shared filter kit, same as Zotero)

```ts
import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type MendeleySearchMatchOptions = SearchMatchOptions;

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function authorName(a: unknown): string | null {
  if (a === null || typeof a !== "object") {
    return null;
  }
  const row = a as Record<string, unknown>;
  const parts = [nonEmptyString(row["first_name"]), nonEmptyString(row["last_name"])].filter(
    (p): p is string => p !== null,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

function authorNames(doc: Record<string, unknown>): string {
  const authors = doc["authors"];
  if (!Array.isArray(authors)) {
    return "";
  }
  const names: string[] = [];
  for (const a of authors) {
    const name = authorName(a);
    if (name !== null) {
      names.push(name);
    }
  }
  return names.join(" ");
}

function keywordNames(doc: Record<string, unknown>): string {
  const keywords = doc["keywords"];
  return Array.isArray(keywords)
    ? keywords.filter((k): k is string => typeof k === "string").join(" ")
    : "";
}

function doi(doc: Record<string, unknown>): string {
  const ids = asObjectish(doc["identifiers"]);
  return ids === undefined ? "" : stringField(ids, "doi");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const doc = asObjectish(item);
  if (doc === undefined) {
    return null;
  }
  return [
    stringField(doc, "title"),
    stringField(doc, "type"),
    stringField(doc, "abstract"),
    stringField(doc, "source"),
    doi(doc),
    authorNames(doc),
    keywordNames(doc),
  ];
}

export const filterMendeleyDocuments = makeQueryFilter(fieldsOf);
```

> Verify `asObjectish`, `makeQueryFilter`, `stringField`, `SearchMatchOptions` exist in `packages/mcp-connectors/shared/search-filter.ts` (Zotero imports them). If `stringField` returns `string` for missing keys (Zotero relies on this), no extra guards are needed.

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun test packages/mcp-connectors/mendeley/test/search-filter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the MCP server** (reads `MENDELEY_ACCESS_TOKEN` from env; Bearer auth; never touches the Vault)

`packages/mcp-connectors/mendeley/src/server.ts`:

```ts
import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterMendeleyDocuments } from "./search-filter.ts";

const BASE = "https://api.mendeley.com";
const DOC_ACCEPT = "application/vnd.mendeley-document.1+json";

function accessToken(): string {
  const t = process.env["MENDELEY_ACCESS_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("MENDELEY_ACCESS_TOKEN is not set");
  }
  return t;
}

async function mendeleyGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken()}`, Accept: DOC_ACCEPT },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Mendeley ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-mendeley", (reg) => {
  reg(
    "mendeley_list",
    "List the user's Mendeley library documents (`GET /documents?view=all&limit=100`). Returns the raw JSON array of document objects — each is `{ id, title, type, authors, year, source, identifiers: { doi, ... }, keywords, abstract, last_modified, websites, ... }`.",
    z.object({}),
    async () => {
      return jsonResult(await mendeleyGet(`/documents?view=all&limit=100`));
    },
  );

  reg(
    "mendeley_get",
    "Fetch one Mendeley document by its id (`GET /documents/{id}?view=all`). Returns the document object directly (NOT wrapped in an array). Throws when no match is found.",
    z.object({ id: z.string().min(1) }),
    async (p) => {
      return jsonResult(await mendeleyGet(`/documents/${encodeURIComponent(p.id)}?view=all`));
    },
  );

  reg(
    "mendeley_search",
    "Substring search across the first page of the user's library documents. Matches the query against the title, document type, abstract, source, DOI, formatted author names, and keywords (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }),
    async (p) => {
      const root = await mendeleyGet(`/documents?view=all&limit=100`);
      const matches = Array.isArray(root)
        ? filterMendeleyDocuments(root, { query: p.query, limit: p.limit })
        : [];
      return jsonResult({ matches });
    },
  );
});
```

- [ ] **Step 6: Write the sandbox contract test** (identical shape to Zotero's; gated on `NIMBUS_TEST_HARNESS`)

`packages/mcp-connectors/mendeley/test/sandbox.test.ts`:

```ts
import { describe, it } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSandboxContractTests } from "@nimbus-dev/sdk/testing";

const manifestPath = resolve(fileURLToPath(import.meta.url), "../../nimbus.extension.json");

describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])("sandbox contract", () => {
  it("respects declared permissions", async () => {
    await runSandboxContractTests(manifestPath);
  });
});
```

- [ ] **Step 7: Run the connector package tests + typecheck**

Run: `bun test packages/mcp-connectors/mendeley`
Expected: PASS (search-filter tests; sandbox skipped without the harness).
Run: `cd packages/mcp-connectors/mendeley && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-connectors/mendeley/src packages/mcp-connectors/mendeley/test
git commit -m "feat(mendeley): MCP server tool surface (list/get/search) + search filter"
```

---

## Task 5: Lazy-mesh OAuth spawn wiring

**Files:**
- Modify: `packages/gateway/src/connectors/lazy-mesh/keys.ts` (`LAZY_MESH`)
- Modify: `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts` (`ensureMendeleyMcp`)
- Modify: `packages/gateway/src/connectors/lazy-mesh/mesh.ts` (`ensureMendeleyRunning` + list map)
- Modify: `packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts`

- [ ] **Step 1: Add the mesh slot**

In `keys.ts` `LAZY_MESH`, add: `mendeley: "mesh:mendeley",`

- [ ] **Step 2: Add `ensureMendeleyMcp`** to `connector-spawns.ts`

Add the import near the existing `getValidNotionAccessToken` import:

```ts
import { getValidMendeleyAccessToken } from "../../auth/mendeley-access-token.ts";
```

Add the spawner (mirror `ensureNotionMcp`):

```ts
/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts Mendeley MCP when `mendeley.oauth` is present and a valid access token can be resolved.
 */
export async function ensureMendeleyMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.mendeley;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "mendeley", "oauth");
  if (raw === null || raw === "") {
    return;
  }
  let accessToken: string;
  try {
    accessToken = await getValidMendeleyAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-mendeley-${randomUUID()}`,
      servers: {
        mendeley: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("mendeley")],
            env: extensionProcessEnv({ MENDELEY_ACCESS_TOKEN: accessToken }),
          },
          "mendeley",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}
```

- [ ] **Step 3: Add `ensureMendeleyRunning` + the list entry** to `mesh.ts`

Add `ensureMendeleyMcp` to the import from `./connector-spawns.ts` (alongside `ensureNotionMcp`). Add the method (near `ensureNotionRunning`):

```ts
  async ensureMendeleyRunning(): Promise<void> {
    return ensureMendeleyMcp(this.spawnContext);
  }
```

Add to the tool-listing map (alongside the `{ map: await list(LAZY_MESH.notion), name: "notion" }` entry):

```ts
      { map: await list(LAZY_MESH.mendeley), name: "mendeley" },
```

- [ ] **Step 4: Register credential-gated spawn** in `credential-orchestration.ts`

After the notion line (~190), add:

```ts
  await ensureIfConnectorSecretSet(ctx, "mendeley", "oauth", () => spawners.ensureMendeleyMcp(ctx));
```

Ensure `ensureMendeleyMcp` is part of the `spawners` object/type wired in this file (mirror exactly how `ensureNotionMcp` is threaded — add it wherever `ensureNotionMcp` appears in the spawners shape).

- [ ] **Step 5: Typecheck**

Run: `cd packages/gateway && bunx tsc --noEmit`
Expected: PASS. Fix any spot the compiler flags where `ensureNotionMcp` has a sibling reference that now needs `ensureMendeleyMcp`.

- [ ] **Step 6: Run the lazy-mesh tests**

Run: `bun test packages/gateway/src/connectors/lazy-mesh`
Expected: PASS. If a test enumerates `LAZY_MESH` slots or spawner names, add `mendeley`/`ensureMendeleyMcp` to its expectations.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/connectors/lazy-mesh/keys.ts packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts packages/gateway/src/connectors/lazy-mesh/mesh.ts packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts
git commit -m "feat(mendeley): lazy-mesh OAuth spawn (ensureMendeleyMcp)"
```

---

## Task 6: Document → `reference` mapper

**Files:**
- Create: `packages/gateway/src/connectors/mendeley-reference-mapping.ts`
- Test: `packages/gateway/src/connectors/mendeley-reference-mapping.test.ts`

- [ ] **Step 1: Write the failing mapper test**

`packages/gateway/src/connectors/mendeley-reference-mapping.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mapMendeleyDocumentToItem } from "./mendeley-reference-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "9f8e-1234",
    title: "Exponential backoff with jitter",
    type: "journal",
    year: 2024,
    source: "Journal of Reliability Engineering",
    abstract: "Full-jitter retry strategies for distributed queues.",
    identifiers: { doi: "10.1145/1234567.8901234" },
    authors: [{ first_name: "Ada", last_name: "Lovelace" }, { first_name: "Grace", last_name: "Hopper" }],
    keywords: ["reliability", "retries"],
    websites: ["https://example.org/paper"],
    last_modified: "2024-03-02T08:00:00.000Z",
    created: "2024-03-01T12:00:00.000Z",
    ...over,
  };
}

describe("mapMendeleyDocumentToItem", () => {
  test("maps a full document to a reference row", () => {
    const row = mapMendeleyDocumentToItem(doc(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.service).toBe("mendeley");
    expect(row.type).toBe("reference");
    expect(row.externalId).toBe("9f8e-1234");
    expect(row.title).toBe("Exponential backoff with jitter");
    expect(row.canonicalUrl).toBe("https://example.org/paper");
    expect(row.modifiedAt).toBe(Date.parse("2024-03-02T08:00:00.000Z"));
    expect(row.metadata["doi"]).toBe("10.1145/1234567.8901234");
    expect(row.metadata["creators"]).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(row.metadata["source"]).toBe("Journal of Reliability Engineering");
  });

  test("returns null when id is missing", () => {
    expect(mapMendeleyDocumentToItem(doc({ id: undefined }), { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapMendeleyDocumentToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapMendeleyDocumentToItem(42, { syncedAt: SYNCED_AT })).toBeNull();
  });

  test("falls back to syncedAt when no timestamps, and derives a title when absent", () => {
    const row = mapMendeleyDocumentToItem(
      { id: "x1", last_modified: undefined, created: undefined, title: undefined, type: "book" },
      { syncedAt: SYNCED_AT },
    );
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.modifiedAt).toBe(SYNCED_AT);
    expect(row.title).toBe("book x1");
  });

  test("truncates an over-long abstract and over-long title", () => {
    const longAbstract = "a".repeat(900);
    const longTitle = "t".repeat(200);
    const row = mapMendeleyDocumentToItem(doc({ abstract: longAbstract, title: longTitle }), {
      syncedAt: SYNCED_AT,
    });
    if (row === null) throw new Error("expected row");
    expect((row.metadata["abstract"] as string).endsWith("…")).toBe(true);
    expect((row.metadata["abstract"] as string).length).toBe(501);
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.title.length).toBe(121);
  });

  test("tolerates non-object authors and a non-array keywords field", () => {
    const row = mapMendeleyDocumentToItem(
      doc({ authors: [null, 7, { last_name: "Knuth" }], keywords: "not-an-array" }),
      { syncedAt: SYNCED_AT },
    );
    if (row === null) throw new Error("expected row");
    expect(row.metadata["creators"]).toEqual(["Knuth"]);
    expect(row.metadata["keywords"]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `bun test packages/gateway/src/connectors/mendeley-reference-mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mendeley-reference-mapping.ts`** (ported from `zotero-reference-mapping.ts`, adapted to Mendeley's flat document shape)

```ts
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface MendeleyMappingContext {
  readonly syncedAt: number;
}

export type MendeleyMappedRow = MappedRow<"mendeley", "reference">;

const TITLE_MAX = 120;
const ABSTRACT_MAX = 500;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

export function authorNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const a of raw) {
    const row = asRecord(a);
    if (row === undefined) {
      continue;
    }
    const first = stringField(row, "first_name") ?? "";
    const last = stringField(row, "last_name") ?? "";
    const combined = [first, last].filter((p) => p !== "").join(" ");
    if (combined !== "") {
      names.push(combined);
    }
  }
  return names;
}

export function keywordList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string" && k !== "") : [];
}

function firstWebsite(raw: unknown): string | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  for (const w of raw) {
    if (typeof w === "string" && w !== "") {
      return w;
    }
  }
  return null;
}

function deriveTitle(title: string | null, docType: string | null, id: string): string {
  const trimmed = title === null ? "" : title.trim();
  if (trimmed === "") {
    return docType !== null && docType !== "" ? `${docType} ${id}` : `Reference ${id}`;
  }
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX)}…` : trimmed;
}

export function mapMendeleyDocumentToItem(
  raw: unknown,
  ctx: MendeleyMappingContext,
): MendeleyMappedRow | null {
  const doc = asRecord(raw);
  if (doc === undefined) {
    return null;
  }

  const id = stringField(doc, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const docType = stringField(doc, "type") ?? null;
  const rawTitle = stringField(doc, "title") ?? null;
  const year = numberField(doc, "year") ?? null;
  const source = stringField(doc, "source") ?? null;
  const abstractRaw = stringField(doc, "abstract") ?? null;
  const ids = asRecord(doc["identifiers"]);
  const doi = ids === undefined ? null : (stringField(ids, "doi") ?? null);
  const creators = authorNames(doc["authors"]);
  const keywords = keywordList(doc["keywords"]);
  const url = firstWebsite(doc["websites"]);

  const lastModified = parseIsoMs(doc["last_modified"]);
  const created = parseIsoMs(doc["created"]);

  const title = deriveTitle(rawTitle, docType, id);
  const abstract =
    abstractRaw !== null && abstractRaw.length > ABSTRACT_MAX
      ? `${abstractRaw.slice(0, ABSTRACT_MAX)}…`
      : abstractRaw;

  const creatorsOrTitle = creators.length > 0 ? creators.join(", ") : title;
  const bodyPreview = abstract !== null && abstract !== "" ? abstract : creatorsOrTitle;
  const canonicalUrl = url;
  const modifiedAt = lastModified ?? created ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    id,
    doc_type: docType,
    title: rawTitle,
    creators,
    year,
    source,
    last_modified: lastModified,
    created,
    keywords,
    doi,
    url: canonicalUrl,
    abstract,
  };

  return {
    service: "mendeley",
    type: "reference",
    externalId: id,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
```

> Confirm `asRecord`, `numberField`, `stringField` signatures in `./unknown-record.ts` match the Zotero mapper's usage (they do — Zotero imports the same three).

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun test packages/gateway/src/connectors/mendeley-reference-mapping.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/mendeley-reference-mapping.ts packages/gateway/src/connectors/mendeley-reference-mapping.test.ts
git commit -m "feat(mendeley): map documents to reference index rows"
```

---

## Task 7: RFC 5988 `Link` header `rel="next"` parser

**Files:**
- Create: `packages/gateway/src/connectors/mendeley-link-header.ts`
- Test: `packages/gateway/src/connectors/mendeley-link-header.test.ts`

- [ ] **Step 1: Write the failing parser test** (covers the review's robustness arms: casing, whitespace, quoting, multiple rels, absent)

```ts
import { describe, expect, test } from "bun:test";
import { parseNextLink } from "./mendeley-link-header.ts";

describe("parseNextLink", () => {
  test("extracts the rel=next URL", () => {
    expect(parseNextLink('<https://api.mendeley.com/documents?marker=AAA>; rel="next"')).toBe(
      "https://api.mendeley.com/documents?marker=AAA",
    );
  });

  test("picks next out of multiple links and tolerates whitespace/casing", () => {
    const h =
      '<https://api.mendeley.com/documents?marker=B>;   REL="next" , <https://api.mendeley.com/documents?marker=A>; rel="last"';
    expect(parseNextLink(h)).toBe("https://api.mendeley.com/documents?marker=B");
  });

  test("returns null when there is no next link", () => {
    expect(parseNextLink('<https://api.mendeley.com/documents?marker=Z>; rel="last"')).toBeNull();
    expect(parseNextLink("")).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `bun test packages/gateway/src/connectors/mendeley-link-header.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mendeley-link-header.ts`**

```ts
/**
 * Parse an RFC 5988 Link header and return the absolute URL of the `rel="next"`
 * relation, or null when absent. Tolerant of casing, surrounding whitespace, and
 * the quoting style of the rel value.
 */
export function parseNextLink(header: string | null): string | null {
  if (header === null || header.trim() === "") {
    return null;
  }
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/i);
    if (match === null) {
      continue;
    }
    const url = match[1]?.trim();
    const rel = match[2]?.trim().toLowerCase();
    if (rel === "next" && url !== undefined && url !== "") {
      return url;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun test packages/gateway/src/connectors/mendeley-link-header.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/mendeley-link-header.ts packages/gateway/src/connectors/mendeley-link-header.test.ts
git commit -m "feat(mendeley): RFC 5988 Link-header next-page parser"
```

---

## Task 8: Gateway sync handler

**Files:**
- Create: `packages/gateway/src/connectors/mendeley-sync.ts`
- Test: `packages/gateway/src/connectors/mendeley-sync.test.ts`

The sync handler walks `GET /documents?view=all&limit=100` (plus `modified_since=<ISO>` on incremental cycles), following `Link: rel="next"` up to a page cap, mapping each document and upserting it. It uses a focused, rate-limit-aware fetch (`fetchMendeleyPage`) that captures the `Link` header — `connectorFetch` is intentionally not used because it discards headers. The token is resolved via `getValidMendeleyAccessToken`; `fetchFn` is injectable for tests.

> **Date-format note (review item 2B):** `modified_since` is emitted via `new Date(ms).toISOString()` → `YYYY-MM-DDTHH:mm:ss.sssZ` (millisecond precision, trailing `Z`). Verify against the current Mendeley `/documents` docs during implementation; the test below pins the exact emitted string so a format change is caught.

- [ ] **Step 1: Write the failing sync test**

`packages/gateway/src/connectors/mendeley-sync.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import pino from "pino";
import { createMendeleySyncable } from "./mendeley-sync.ts";

// Minimal SyncContext fake — DB-backed upsert is exercised by integration tests;
// here we assert pagination, cursor, and error arms with a faked fetch.
function fakeCtx(fetchFn: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "mendeley-sync-"));
  const db = new Database(":memory:");
  const upserts: unknown[] = [];
  const ctx = {
    vault: {
      get: async (k: string) =>
        k === "mendeley.oauth"
          ? JSON.stringify({
              accessToken: "tok-abc",
              refreshToken: "ref",
              expiresAt: Date.now() + 3_600_000,
              scopes: ["all"],
            })
          : null,
      set: async () => {},
    },
    db,
    logger: pino({ level: "silent" }),
    rateLimiter: { acquire: async () => {} },
    sandboxCwd: dir,
    credentialFor: () => ({ credential: "personal" as const }),
    runTeamList: async () => [],
    __upserts: upserts,
  };
  return { ctx, upserts, fetchFn };
}

function jsonResponse(body: unknown, link?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (link !== undefined) headers.set("link", link);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("createMendeleySyncable", () => {
  test("no-ops when the OAuth secret is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendeley-sync-"));
    const ctx = {
      vault: { get: async () => null, set: async () => {} },
      db: new Database(":memory:"),
      logger: pino({ level: "silent" }),
      rateLimiter: { acquire: async () => {} },
      sandboxCwd: dir,
      credentialFor: () => ({ credential: "personal" as const }),
      runTeamList: async () => [],
    };
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} });
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("follows Link rel=next across pages and counts upserts", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("marker=PAGE2")) {
        return jsonResponse([{ id: "d2", title: "Second" }]);
      }
      return jsonResponse([{ id: "d1", title: "First" }], "<https://api.mendeley.com/documents?marker=PAGE2>; rel=\"next\"");
    }) as unknown as typeof fetch;

    const { ctx } = fakeCtx(fetchFn);
    const syncable = createMendeleySyncable(
      { ensureMendeleyMcpRunning: async () => {} },
      fetchFn,
    );
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
    expect(r.itemsUpserted).toBe(2);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("/documents?view=all&limit=100");
    expect(calls[0]).not.toContain("modified_since");
  });

  test("emits modified_since on an incremental cycle (millisecond ISO)", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const { ctx } = fakeCtx(fetchFn);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    const cursor = JSON.stringify({ since: "2024-03-02T08:00:00.000Z" });
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    await syncable.sync(ctx as any, cursor);
    expect(calls[0]).toContain("modified_since=2024-03-02T08%3A00%3A00.000Z");
  });

  test("first-page HTTP error returns an empty pass result", async () => {
    const fetchFn = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const { ctx } = fakeCtx(fetchFn);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
    expect(r.itemsUpserted).toBe(0);
  });
});
```

> If `upsertIndexedItemForSync` requires real index tables that `:memory:` lacks, wrap each upsert in the sync with the same DB the gateway integration tests use, or assert `itemsUpserted` only (the counter increments before/independently of any DB write failure is NOT acceptable — instead, in the test, point `ctx.db` at a DB initialized via the project's `createMemoryIndexDb` helper if one exists, mirroring connector sync tests). Prefer the existing pattern in `zotero-sync.test.ts` if present; otherwise use `createMemoryIndexDb`.

- [ ] **Step 2: Run it — verify it fails**

Run: `bun test packages/gateway/src/connectors/mendeley-sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mendeley-sync.ts`**

```ts
import { readConnectorSecret } from "./connector-vault.ts";
import { getValidMendeleyAccessToken } from "../auth/mendeley-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { mapMendeleyDocumentToItem } from "./mendeley-reference-mapping.ts";
import { parseNextLink } from "./mendeley-link-header.ts";

const SERVICE_ID = "mendeley";
const CURSOR_PREFIX = "nimbus-mendeley1:";
const BASE = "https://api.mendeley.com";
const DOC_ACCEPT = "application/vnd.mendeley-document.1+json";
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

type MendeleyCursorV1 = { since: string | null };
type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface PageOutcome {
  kind: "ok" | "http_error" | "parse_error";
  docs: unknown[];
  bytes: number;
  nextUrl: string | null;
}

function decodeCursor(cursor: string | null): MendeleyCursorV1 | null {
  if (cursor === null || !cursor.startsWith(CURSOR_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(cursor.slice(CURSOR_PREFIX.length)) as unknown;
    if (parsed !== null && typeof parsed === "object" && "since" in parsed) {
      const since = (parsed as { since: unknown }).since;
      return { since: typeof since === "string" ? since : null };
    }
  } catch {
    return null;
  }
  return null;
}

function firstPageUrl(since: string | null): string {
  const params = new URLSearchParams({ view: "all", limit: String(PAGE_LIMIT) });
  if (since !== null && since !== "") {
    params.set("modified_since", since);
  }
  return `${BASE}/documents?${params.toString()}`;
}

async function fetchMendeleyPage(
  ctx: SyncContext,
  accessToken: string,
  url: string,
  fetchFn: FetchFn,
): Promise<PageOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: DOC_ACCEPT },
  });
  const text = await res.text();
  const bytes = text.length;
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, url }, "connector fetch failed");
    return { kind: "http_error", docs: [], bytes, nextUrl: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { kind: "parse_error", docs: [], bytes, nextUrl: null };
  }
  return {
    kind: "ok",
    docs: Array.isArray(parsed) ? parsed : [],
    bytes,
    nextUrl: parseNextLink(res.headers.get("link")),
  };
}

function nextCursor(since: string): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { since } satisfies MendeleyCursorV1);
}

export type MendeleySyncableOptions = {
  ensureMendeleyMcpRunning: () => Promise<void>;
};

export function createMendeleySyncable(
  options: MendeleySyncableOptions,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMendeleyMcpRunning();
      const raw = await readConnectorSecret(ctx.vault, "mendeley", "oauth");
      if (raw === null || raw === "") {
        return syncNoopResult(cursor, t0);
      }
      let accessToken: string;
      try {
        accessToken = await getValidMendeleyAccessToken(ctx.vault);
      } catch {
        return syncNoopResult(cursor, t0);
      }

      const prev = decodeCursor(cursor);
      const syncStartIso = new Date().toISOString();
      let url: string | null = firstPageUrl(prev?.since ?? null);
      let totalBytes = 0;
      let upserted = 0;

      for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
        const outcome = await fetchMendeleyPage(ctx, accessToken, url, fetchFn);
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, nextCursor(syncStartIso))
              : syncPassCursorParseEmpty(t0, totalBytes, nextCursor(syncStartIso));
          }
          break;
        }
        for (const d of outcome.docs) {
          const mapped = mapMendeleyDocumentToItem(d, { syncedAt: Date.now() });
          if (mapped !== null) {
            upsertIndexedItemForSync(ctx, mapped);
            upserted += 1;
          }
        }
        url = outcome.nextUrl;
      }

      return syncPassCursorSuccess(t0, totalBytes, nextCursor(syncStartIso), upserted);
    },
  };
}
```

> Verify `encodeNimbusJsonCursor` and `upsertIndexedItemForSync` import paths against `zotero-sync.ts` (it imports the same two). Verify `mapMendeleyDocumentToItem`'s return type satisfies `upsertIndexedItemForSync`'s parameter (it mirrors the Zotero mapped row, which already satisfies it).

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun test packages/gateway/src/connectors/mendeley-sync.test.ts`
Expected: PASS. Adjust the `ctx` fake to whatever real `SyncContext`/DB helper the sibling `*-sync.test.ts` files use if the `:memory:` upsert path errors.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/mendeley-sync.ts packages/gateway/src/connectors/mendeley-sync.test.ts
git commit -m "feat(mendeley): gateway sync handler (Link-paginated, modified_since cursor)"
```

---

## Task 9: Wire the syncable into boot

**Files:**
- Modify: `packages/gateway/src/platform/assemble-sync-registrations.ts`

- [ ] **Step 1: Register the syncable**

Add the import near `createNotionSyncable`:

```ts
import { createMendeleySyncable } from "../connectors/mendeley-sync.ts";
```

Add the registration alongside the others (mirror the `createNotionSyncable` block):

```ts
    createMendeleySyncable({
      ensureMendeleyMcpRunning: () => connectorMesh.ensureMendeleyRunning(),
    }),
```

- [ ] **Step 2: Typecheck + run the assemble tests**

Run: `cd packages/gateway && bunx tsc --noEmit`
Expected: PASS.
Run: `bun test packages/gateway/src/platform/assemble-sync-registrations.test.ts`
Expected: PASS (if it asserts the registered service-id set, add `"mendeley"`).

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/platform/assemble-sync-registrations.ts packages/gateway/src/platform/assemble-sync-registrations.test.ts
git commit -m "feat(mendeley): register the syncable at gateway boot"
```

---

## Task 10: Connector README + docs + final verification

**Files:**
- Create: `packages/mcp-connectors/mendeley/README.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/roadmap.md` (check off the Mendeley row)

- [ ] **Step 1: Write the README with the required public-tier H2 sections**

Mirror `packages/mcp-connectors/zotero/README.md` headings exactly (the `audit:package-readmes` gate requires the public-tier sections). Cover: what it indexes (`mendeley:reference` metadata), auth (`nimbus connector auth mendeley` + the two env vars), the read-only tool surface (`mendeley_list`/`get`/`search`), and the no-PDF-content note.

Run to confirm the required headings: `bun run audit:package-readmes`
Expected: PASS (no missing-section errors for `mendeley`).

- [ ] **Step 2: Add the CHANGELOG entry** (per the connector-docs convention — log in `docs/CHANGELOG.md`, NOT the CLAUDE.md status line)

Add under the current unreleased/dated section:

```markdown
- **Mendeley connector** (read-only) — indexes the user's Mendeley library document metadata as `mendeley:reference` items (Phase 6 Slice 9). Elsevier OAuth2 auth; no PDF content is fetched.
```

- [ ] **Step 3: Check off the roadmap row**

In `docs/roadmap.md`, change the Mendeley bullet under "Deferred from Phase 5 → Browser & Reading" from `- [ ] **Mendeley**` to `- [x] **Mendeley**` and append the delivery note (dated 2026-06-14, reuses `reference` type, read-only).

- [ ] **Step 4: Commit docs**

```bash
git add packages/mcp-connectors/mendeley/README.md docs/CHANGELOG.md docs/roadmap.md
git commit -m "docs(mendeley): connector README, CHANGELOG, roadmap check-off"
```

- [ ] **Step 5: Coverage-floor dry run (Linux-authoritative)**

Every new file must clear ≥80% line+branch (baseline is `{}`). Build the lcov and run the floor check (Docker `oven/bun:latest` for parity, per the project's coverage-floor workflow):

Run: `bun run audit:coverage-floor` (or the Docker-Linux lcov build + `scripts/coverage-floor/check.ts` per the `nimbus-coverage-floor` skill)
Expected: PASS for all `mendeley-*` files. If a file is below floor, add the missing test arms (the mapper/link-parser/search-filter/sync tests above target the branch arms; extend them rather than excluding).

- [ ] **Step 6: Full preflight before first push**

Run: `bun run preflight`
Expected: PASS (typecheck across all packages, biome, tests, static structure audits, doc-refs). Resolve anything red before pushing.

- [ ] **Step 7: Final commit / ready to push**

```bash
git status   # confirm clean
git log --oneline origin/main..HEAD   # review the slice's commits
```

---

## Self-review checklist (completed by plan author)

**Spec coverage:**
- Read-only connector indexing `reference` metadata → Tasks 4, 6, 8 ✅
- OAuth2 provider (`mendeley.oauth`, env-supplied confidential client) → Task 2 ✅
- User-supplied client id/secret, no proxy, never in Vault → Task 2 (Steps 4-6, 9) ✅
- Documents-only, no annotations/folders/PDF-content → manifest desc + mapper scope (Tasks 1, 6) ✅
- No migration / not prose-heavy → no migration task; `routing.ts` deliberately untouched ✅
- Link-header pagination, shared `connectorFetch` untouched → Tasks 7, 8 ✅
- `modified_since` cursor, exact format pinned by test → Task 8 ✅
- Coverage floor on every new file → Task 10 Step 5 ✅
- CHANGELOG + roadmap + README public-tier → Task 10 ✅
- Collision-free with 7c (no executor/HITL/invariant/migration touches) → confirmed: no task edits those files ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. The few `>` notes ask the implementer to *verify an exact import/helper name against a named sibling file* — not to invent behavior.

**Type consistency:** `getValidMendeleyAccessToken` (Tasks 2, 5, 8), `mapMendeleyDocumentToItem` (Tasks 6, 8), `filterMendeleyDocuments` (Task 4), `parseNextLink` (Tasks 7, 8), `createMendeleySyncable` (Tasks 8, 9), `ensureMendeleyMcp`/`ensureMendeleyRunning` (Tasks 5, 9), `OAUTH_PROVIDERS.mendeley` (Tasks 2, 5) — names are consistent across tasks. Item type `"reference"`, service `"mendeley"`, vault key `mendeley.oauth`, env vars `NIMBUS_OAUTH_MENDELEY_CLIENT_ID/_SECRET` used uniformly.
