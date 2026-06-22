# Workday Connector (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a read-only first-party MCP connector `workday` that indexes a tenant's org chart / workers, time-off, job postings (REST + OAuth) and admin-configured RaaS reports, behind a directory-safe PII allowlist.

**Architecture:** Mirrors the Mendeley OAuth lazy-mesh connector. The connector package (`packages/mcp-connectors/workday/`) is a thin stdio MCP server exposing live REST read tools; all background indexing + item mapping lives gateway-side (`packages/gateway/src/connectors/workday-*.ts`). Credentials/tenant arrive as spawn-time env vars (the connector never touches Vault). Workday's tenant-specific OAuth endpoints are handled by a descriptor *factory* fed into the existing OAuth registry's descriptor-parameter functions.

**Tech Stack:** Bun v1.2+, TypeScript 6 strict, zod, `@modelcontextprotocol/sdk`, BLAKE3 (via `db/audit-chain.ts`), bun:test.

**Spec:** [`docs/superpowers/specs/2026-06-21-slice9-workday-connector-design.md`](../specs/2026-06-21-slice9-workday-connector-design.md)

## Global Constraints

- **No `any`** — use `unknown` for external data; TS strict is non-negotiable.
- **Read-only** — no write/delete tools, no HITL action types, no `HITL_REQUIRED_BACKING` entry, NOT in `TEAM_CREDENTIAL_CONNECTORS`/`TEAM_SECRET_ANYOF_GROUPS`.
- **No new invariant. No schema migration** (item types are free per-connector strings).
- **No plaintext credentials** — only `workday.oauth` in Vault; client id/secret + tenant config are env vars; the connector process reads creds from `process.env` only (never the Vault API).
- **Item id format** — `"workday:<native_id>"`, stable across syncs, never a UUID.
- **PII** — mappers emit ONLY the directory-safe allowlist (Task 9); a contract test fails CI on any forbidden field.
- **Coverage floor** — every non-excluded new file under `packages/gateway/src` and `packages/mcp-connectors/workday/src` must be ≥85% line + ≥80% branch. `server.ts` + `tools.ts` are pathRegex-excluded; mappers / sync / field-allowlist / search-filter are NOT.
- **Cross-platform** — `path.join()` / `os.tmpdir()` in tests, never hardcoded separators.
- **Commit after every task.** Branch: `dev/asafgolombek/phase6-slice9-workday` (already created).
- **Verify Docker-Linux before first push** (coverage-floor is Linux-authoritative).

## Deviations from the spec (read first)

1. **Tenant config is env vars, not `nimbus.toml`** — `NIMBUS_WORKDAY_TENANT_HOST` + `NIMBUS_WORKDAY_TENANT` (needed at OAuth-descriptor-build time; the existing `[connectors.X]` toml parser throws for non-team-credential connectors). Spec §3 updated.
2. **Only the optional RaaS `reports[]` lives in `nimbus.toml`** `[connectors.workday]`; the team-credential parser is guarded to ignore tables without a `credential` key.
3. **Connector read tools fetch live REST** (like Mendeley's `mendeley_list = GET /documents`), they do NOT read the local index. RaaS reports are a **sync-only** concern (indexed; queried via `nimbus search`), not a live connector tool — keeping the connector process stateless (token + tenant host env only).

---

## File Structure

**New — connector package** `packages/mcp-connectors/workday/`:

- `package.json`, `nimbus.extension.json`, `tsconfig.json`
- `src/server.ts` — stdio entry; `registerWorkdayTools(reg)` + `import.meta.main` guard. (coverage-excluded)
- `src/tools.ts` — `WORKDAY_TOOL_NAMES` constant. (coverage-excluded)
- `src/search-filter.ts` — local filter helpers for the live `_search` tool.
- `test/server.test.ts`, `test/no-write-tools.test.ts`

**New — gateway** `packages/gateway/src/`:

- `connectors/workday-field-allowlist.ts` — directory-safe allowlists + RaaS denylist/fields.
- `connectors/workday-mappers.ts` — `mapWorkerToItem` / `mapTimeOffToItem` / `mapJobPostingToItem` / `mapReportRowToItem`.
- `connectors/workday-sync.ts` — `createWorkdaySyncable`.
- `auth/workday-access-token.ts` — `getValidWorkdayAccessToken`.
- `auth/workday-oauth-descriptor.ts` — `makeWorkdayDescriptor`.
- `config/nimbus-toml-workday.ts` — `parseNimbusWorkdayToml` (reports + time_off_history_days).
- matching `*.test.ts` for each.

**Modified — gateway** (registration sites, exact edits in tasks):

- `connectors/connector-catalog.ts` (service id, sync interval, `oauthProfileForService`)
- `connectors/connector-secrets-manifest.ts` (`workday: ["workday.oauth"]`)
- `auth/oauth-registry.ts` (`OAuthProvider` union, `OAUTH_PROVIDERS.workday`, descriptor resolution)
- `auth/pkce.ts`, `auth/oauth-vault-tokens.ts` (descriptor-resolution indirection)
- `auth/oauth-env-help-messages.ts` (help strings)
- `config.ts` (env-var reads)
- `ipc/connector-rpc-handlers/auth.ts` (`oauthClientConfigForProvider` case)
- `sync/rate-limiter.ts` (service union)
- `config/nimbus-toml-connectors.ts` (guard: ignore non-credential tables)
- `connectors/lazy-mesh/keys.ts`, `connector-spawns.ts`, `mesh.ts`, `credential-orchestration.ts`
- `platform/assemble-sync-registrations.ts` (register syncable)
- root `package.json` (workspaces), `docs/CHANGELOG.md`, `docs/roadmap.md`

---

## Task 1: Register the `workday` service id (catalog + secret keys + intervals)

Adds `workday` to the `ConnectorServiceId`-keyed sites that the type system forces to be exhaustive. Must land together to keep the build green.

**Files:**

- Modify: `packages/gateway/src/connectors/connector-catalog.ts` (`CONNECTOR_SERVICE_IDS` ~line 63; `CONNECTOR_SYNC_INTERVAL_MS` ~line 180)
- Modify: `packages/gateway/src/connectors/connector-secrets-manifest.ts` (~line 70)
- Modify: `packages/gateway/src/sync/rate-limiter.ts` (service union ~line 56)
- Modify: `packages/gateway/src/connectors/lazy-mesh/keys.ts` (`LAZY_MESH` ~line 22)
- Test: `packages/gateway/src/connectors/connector-secrets-manifest.test.ts` (existing — add a case, or create if absent)

**Interfaces:**

- Produces: `ConnectorServiceId` now includes `"workday"`; `LAZY_MESH.workday === "mesh:workday"`; `CONNECTOR_VAULT_SECRET_KEYS.workday === ["workday.oauth"]`.

- [ ] **Step 1: Write the failing test**

Add to `connector-secrets-manifest.test.ts`:

```ts
import { CONNECTOR_VAULT_SECRET_KEYS } from "./connector-secrets-manifest.ts";

test("workday declares only the oauth vault key", () => {
  expect(CONNECTOR_VAULT_SECRET_KEYS.workday).toEqual(["workday.oauth"]);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/connectors/connector-secrets-manifest.test.ts`
Expected: FAIL — `workday` not on `CONNECTOR_VAULT_SECRET_KEYS` (and a TS error on the property).

- [ ] **Step 3: Add `workday` to every forced site**

In `connector-catalog.ts`, add `"workday",` to the `CONNECTOR_SERVICE_IDS` array (keep alphabetical near the end) and add to `CONNECTOR_SYNC_INTERVAL_MS` (mirror Mendeley's 10-minute cadence — use the same `MIN10` constant the file already uses):

```ts
// CONNECTOR_SERVICE_IDS array:
  "workday",
// CONNECTOR_SYNC_INTERVAL_MS object:
  workday: MIN10,
```

In `connector-secrets-manifest.ts` after the `mendeley` line:

```ts
  // Workday HR. OAuth2 authorization-code flow against the tenant-specific
  // /ccx/oauth2/<tenant>/token endpoint; only the token bundle is vaulted.
  // Tenant host/name + client id/secret are env vars (see config.ts).
  workday: ["workday.oauth"],
```

In `sync/rate-limiter.ts` add `| "workday"` to the service union (~line 56).

In `lazy-mesh/keys.ts` add to the `LAZY_MESH` object:

```ts
  workday: "mesh:workday",
```

- [ ] **Step 4: Run the test + typecheck**

Run: `bun test packages/gateway/src/connectors/connector-secrets-manifest.test.ts && bun run --filter @nimbus-dev/gateway typecheck`
Expected: PASS; no TS errors. (If `CONNECTOR_SYNC_INTERVAL_MS` is a partial map, the typecheck still passes — adding the key is harmless.)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/connector-catalog.ts packages/gateway/src/connectors/connector-secrets-manifest.ts packages/gateway/src/connectors/connector-secrets-manifest.test.ts packages/gateway/src/sync/rate-limiter.ts packages/gateway/src/connectors/lazy-mesh/keys.ts
git commit -m "feat(workday): register service id + oauth vault key + lazy-mesh slot"
```

---

## Task 2: nimbus.toml RaaS reports parser + team-parser guard

**Files:**

- Create: `packages/gateway/src/config/nimbus-toml-workday.ts`
- Create: `packages/gateway/src/config/nimbus-toml-workday.test.ts`
- Modify: `packages/gateway/src/config/nimbus-toml-connectors.ts` (guard non-credential tables)
- Test: `packages/gateway/src/config/nimbus-toml-connectors.test.ts` (existing — add a guard case)

**Interfaces:**

- Produces:

  ```ts
  export interface WorkdayReport { label: string; url: string; keyField?: string; fields?: string[]; }
  export interface NimbusWorkdayToml { timeOffHistoryDays: number; reports: WorkdayReport[]; }
  export const DEFAULT_NIMBUS_WORKDAY_TOML: NimbusWorkdayToml; // { timeOffHistoryDays: 365, reports: [] }
  export function parseNimbusWorkdayToml(source: string, defaults?: NimbusWorkdayToml): NimbusWorkdayToml;
  export function loadNimbusWorkdayFromConfigDir(configDir: string): NimbusWorkdayToml;
  ```

- [ ] **Step 1: Write the failing test** (`nimbus-toml-workday.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_WORKDAY_TOML, parseNimbusWorkdayToml } from "./nimbus-toml-workday.ts";

describe("parseNimbusWorkdayToml", () => {
  test("defaults when section absent", () => {
    expect(parseNimbusWorkdayToml("")).toEqual(DEFAULT_NIMBUS_WORKDAY_TOML);
  });

  test("parses time_off_history_days + an array of reports", () => {
    const src = [
      "[connectors.workday]",
      "time_off_history_days = 90",
      "[[connectors.workday.reports]]",
      'label = "headcount"',
      'url = "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/Headcount?format=json"',
      'key_field = "employee_id"',
      'fields = ["employee_id", "org"]',
      "[[connectors.workday.reports]]",
      'label = "open-positions"',
      'url = "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/Open?format=json"',
    ].join("\n");
    const cfg = parseNimbusWorkdayToml(src);
    expect(cfg.timeOffHistoryDays).toBe(90);
    expect(cfg.reports).toHaveLength(2);
    expect(cfg.reports[0]).toEqual({
      label: "headcount",
      url: "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/Headcount?format=json",
      keyField: "employee_id",
      fields: ["employee_id", "org"],
    });
    expect(cfg.reports[1]).toEqual({
      label: "open-positions",
      url: "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/Open?format=json",
    });
  });

  test("drops a report missing label or url", () => {
    const src = ["[[connectors.workday.reports]]", 'label = "no-url"'].join("\n");
    expect(parseNimbusWorkdayToml(src).reports).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml-workday.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser** (`nimbus-toml-workday.ts`)

Reuse the toml primitives the codebase already exposes (`isTableHeader`, `splitKeyValue`, `parseString`, `stripComment`) — same imports as `nimbus-toml-connectors.ts`. Parse a TOML string array value (`fields = [...]`) with a small local helper.

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTableHeader, parseString, splitKeyValue, stripComment } from "./toml-primitives.ts";

export interface WorkdayReport {
  readonly label: string;
  readonly url: string;
  readonly keyField?: string;
  readonly fields?: string[];
}
export interface NimbusWorkdayToml {
  readonly timeOffHistoryDays: number;
  readonly reports: WorkdayReport[];
}
export const DEFAULT_NIMBUS_WORKDAY_TOML: NimbusWorkdayToml = {
  timeOffHistoryDays: 365,
  reports: [],
};

function parseStringArray(valRaw: string): string[] {
  const t = valRaw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return [];
  const inner = t.slice(1, -1).trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((s) => parseString(s.trim()))
    .filter((s) => s.length > 0);
}

interface ReportAccum {
  label?: string;
  url?: string;
  keyField?: string;
  fields?: string[];
}

function finalizeReport(r: ReportAccum): WorkdayReport | null {
  if (r.label === undefined || r.label === "" || r.url === undefined || r.url === "") {
    return null;
  }
  const out: WorkdayReport = { label: r.label, url: r.url };
  return {
    ...out,
    ...(r.keyField !== undefined && r.keyField !== "" ? { keyField: r.keyField } : {}),
    ...(r.fields !== undefined && r.fields.length > 0 ? { fields: r.fields } : {}),
  };
}

export function parseNimbusWorkdayToml(
  source: string,
  defaults: NimbusWorkdayToml = DEFAULT_NIMBUS_WORKDAY_TOML,
): NimbusWorkdayToml {
  let timeOffHistoryDays = defaults.timeOffHistoryDays;
  const reports: WorkdayReport[] = [];
  let section: "main" | "report" | "other" = "other";
  let cur: ReportAccum | null = null;

  const flush = (): void => {
    if (cur !== null) {
      const r = finalizeReport(cur);
      if (r !== null) reports.push(r);
      cur = null;
    }
  };

  for (const line of source.split(/\r?\n/)) {
    const t = stripComment(line).trim();
    if (t === "") continue;
    if (isTableHeader(t)) {
      flush();
      if (t === "[connectors.workday]") section = "main";
      else if (t === "[[connectors.workday.reports]]") {
        section = "report";
        cur = {};
      } else section = "other";
      continue;
    }
    const kv = splitKeyValue(t);
    if (kv === undefined) continue;
    if (section === "main" && kv.key === "time_off_history_days") {
      const n = Number.parseInt(parseString(kv.valRaw) || kv.valRaw.trim(), 10);
      if (Number.isFinite(n) && n > 0) timeOffHistoryDays = n;
    } else if (section === "report" && cur !== null) {
      if (kv.key === "label") cur.label = parseString(kv.valRaw);
      else if (kv.key === "url") cur.url = parseString(kv.valRaw);
      else if (kv.key === "key_field") cur.keyField = parseString(kv.valRaw);
      else if (kv.key === "fields") cur.fields = parseStringArray(kv.valRaw);
    }
  }
  flush();
  return { timeOffHistoryDays, reports };
}

export function loadNimbusWorkdayFromConfigDir(configDir: string): NimbusWorkdayToml {
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return DEFAULT_NIMBUS_WORKDAY_TOML;
  return parseNimbusWorkdayToml(readFileSync(tomlPath, "utf8"));
}
```

> If `time_off_history_days` is an unquoted int, `parseString` may return `""`; the `|| kv.valRaw.trim()` fallback handles the bare-number form. Verify `toml-primitives.ts` exports the four names; if `splitKeyValue`/`isTableHeader` live elsewhere, copy the import from `nimbus-toml-connectors.ts` (it uses the same set).

- [ ] **Step 4: Guard the team-credential parser**

In `nimbus-toml-connectors.ts`, in `processConnectorLine` / `resolveConnectorConfig`, skip tables that have no `credential` key so `[connectors.workday]` doesn't throw. Minimal change in `parseNimbusConnectorsToml`:

```ts
export function parseNimbusConnectorsToml(source: string): ConnectorsConfig {
  const out = new Map<TeamCredentialConnector, ConnectorCredentialConfig>();
  for (const [name, kv] of accumulateConnectorTables(source)) {
    if (kv["credential"] === undefined) continue; // non-credential table (e.g. workday reports) — ignore
    out.set(name as TeamCredentialConnector, resolveConnectorConfig(name, kv));
  }
  return out;
}
```

Add a regression test to `nimbus-toml-connectors.test.ts`:

```ts
test("ignores a [connectors.workday] table that has no credential key", () => {
  const src = ['[connectors.workday]', 'time_off_history_days = 90'].join("\n");
  expect(() => parseNimbusConnectorsToml(src)).not.toThrow();
  expect(parseNimbusConnectorsToml(src).size).toBe(0);
});
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/gateway/src/config/nimbus-toml-workday.test.ts packages/gateway/src/config/nimbus-toml-connectors.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml-workday.ts packages/gateway/src/config/nimbus-toml-workday.test.ts packages/gateway/src/config/nimbus-toml-connectors.ts packages/gateway/src/config/nimbus-toml-connectors.test.ts
git commit -m "feat(workday): nimbus.toml RaaS reports parser + non-credential table guard"
```

---

## Task 3: Config env vars + OAuth help messages

**Files:**

- Modify: `packages/gateway/src/config.ts` (~line 120, after the mendeley entries)
- Modify: `packages/gateway/src/auth/oauth-env-help-messages.ts` (after the MENDELEY help block)
- Test: `packages/gateway/src/config.test.ts` (existing — add a case)

**Interfaces:**

- Produces: `Config.oauthWorkdayClientId`, `Config.oauthWorkdayClientSecret`, `Config.workdayTenantHost`, `Config.workdayTenant` (all `string`, `""` when unset); `WORKDAY_OAUTH_CLIENT_ID_HELP`, `WORKDAY_OAUTH_CLIENT_SECRET_HELP`, `WORKDAY_TENANT_HELP`.

- [ ] **Step 1: Write the failing test** (`config.test.ts`)

```ts
test("workday tenant + client config read from env", () => {
  process.env["NIMBUS_WORKDAY_TENANT_HOST"] = "https://wd5.workday.com";
  process.env["NIMBUS_WORKDAY_TENANT"] = "acme";
  // Config is read at import time; re-import a fresh module copy:
  const cfg = require("./config.ts").Config;
  expect(cfg.workdayTenant).toBe("acme");
  expect(cfg.workdayTenantHost).toBe("https://wd5.workday.com");
});
```

> If `Config` is a frozen snapshot read once at import, mirror however `config.test.ts` already tests env-derived fields (e.g. it may use a `loadConfig()` helper). Match the existing pattern in that file rather than `require`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/config.test.ts`
Expected: FAIL — `workdayTenant` undefined.

- [ ] **Step 3: Add the Config entries** (`config.ts`, after the mendeley lines)

```ts
  oauthWorkdayClientId: processEnvGet("NIMBUS_OAUTH_WORKDAY_CLIENT_ID") ?? "",
  oauthWorkdayClientSecret: processEnvGet("NIMBUS_OAUTH_WORKDAY_CLIENT_SECRET") ?? "",
  workdayTenantHost: processEnvGet("NIMBUS_WORKDAY_TENANT_HOST") ?? "",
  workdayTenant: processEnvGet("NIMBUS_WORKDAY_TENANT") ?? "",
```

- [ ] **Step 4: Add the help messages** (`oauth-env-help-messages.ts`)

```ts
export const WORKDAY_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_WORKDAY_CLIENT_ID to your Workday API client ID (register an API Client for Integrations in your Workday tenant with the authorization-code grant).

You must also set NIMBUS_OAUTH_WORKDAY_CLIENT_SECRET, NIMBUS_WORKDAY_TENANT_HOST (e.g. https://wd5-services1.workday.com) and NIMBUS_WORKDAY_TENANT (your tenant name).

PowerShell:
  $env:NIMBUS_OAUTH_WORKDAY_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_WORKDAY_CLIENT_SECRET = "..."
  $env:NIMBUS_WORKDAY_TENANT_HOST = "https://wd5-services1.workday.com"
  $env:NIMBUS_WORKDAY_TENANT = "acme"`;

export const WORKDAY_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_WORKDAY_CLIENT_SECRET to your Workday API client secret (Workday's token endpoint requires it in the request body). It is not stored in the Nimbus vault.`;

export const WORKDAY_TENANT_HELP = `Set NIMBUS_WORKDAY_TENANT_HOST (your tenant API host, e.g. https://wd5-services1.workday.com) and NIMBUS_WORKDAY_TENANT (your tenant name) — Workday's OAuth + REST endpoints are tenant-specific.`;
```

- [ ] **Step 5: Run the test**

Run: `bun test packages/gateway/src/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/config.ts packages/gateway/src/config.test.ts packages/gateway/src/auth/oauth-env-help-messages.ts
git commit -m "feat(workday): env-var tenant/client config + oauth help messages"
```

---

## Task 4: Tenant-specific OAuth descriptor factory + resolution indirection

**Files:**

- Create: `packages/gateway/src/auth/workday-oauth-descriptor.ts`
- Create: `packages/gateway/src/auth/workday-oauth-descriptor.test.ts`
- Create: `packages/gateway/src/auth/workday-access-token.ts`
- Create: `packages/gateway/src/auth/workday-access-token.test.ts`
- Modify: `packages/gateway/src/auth/oauth-registry.ts` (`OAuthProvider` union + `OAUTH_PROVIDERS.workday` base entry)
- Modify: `packages/gateway/src/auth/pkce.ts` + `packages/gateway/src/auth/oauth-vault-tokens.ts` (descriptor resolution indirection)

**Interfaces:**

- Consumes: `OAuthProviderDescriptor`, `getValidVaultAccessToken`, `OAUTH_PROVIDERS` (Task in oauth-registry.ts); `Config.workdayTenantHost`/`workdayTenant`/`oauthWorkdayClientId`/`oauthWorkdayClientSecret` (Task 3).
- Produces:

  ```ts
  export function makeWorkdayDescriptor(args: { tenantHost: string; tenant: string }): OAuthProviderDescriptor;
  export function resolveOAuthDescriptor(provider: OAuthProvider): OAuthProviderDescriptor; // workday → factory(Config), else OAUTH_PROVIDERS[provider]
  export async function getValidWorkdayAccessToken(vault: NimbusVault): Promise<string>;
  ```

- [ ] **Step 1: Write the failing test** (`workday-oauth-descriptor.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { makeWorkdayDescriptor } from "./workday-oauth-descriptor.ts";

describe("makeWorkdayDescriptor", () => {
  test("interpolates tenant-specific authorize/token urls", () => {
    const d = makeWorkdayDescriptor({ tenantHost: "https://wd5.workday.com/", tenant: "acme" });
    expect(d.authorizeUrl).toBe("https://wd5.workday.com/ccx/oauth2/acme/authorize");
    expect(d.tokenUrl).toBe("https://wd5.workday.com/ccx/oauth2/acme/token");
    expect(d.vaultKey).toBe("workday.oauth");
    expect(d.id).toBe("workday");
    expect(d.clientSecret).toBe("required");
  });
  test("throws when tenant config is empty", () => {
    expect(() => makeWorkdayDescriptor({ tenantHost: "", tenant: "acme" })).toThrow(/tenant/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/auth/workday-oauth-descriptor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the factory** (`workday-oauth-descriptor.ts`)

Reuse the registry's `standardAuthorizeParams` + `parseStandardTokenResponse` by exporting them from `oauth-registry.ts` if not already exported (they are module-private today — add `export` to both function declarations). Workday uses the standard authorization-code flow with the client secret in the body.

```ts
import { Config } from "../config.ts";
import {
  type OAuthProvider,
  OAUTH_PROVIDERS,
  type OAuthProviderDescriptor,
  parseStandardTokenResponse,
  standardAuthorizeParams,
} from "./oauth-registry.ts";

function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function makeWorkdayDescriptor(args: {
  tenantHost: string;
  tenant: string;
}): OAuthProviderDescriptor {
  const host = trimSlash(args.tenantHost.trim());
  const tenant = args.tenant.trim();
  if (host === "" || tenant === "") {
    throw new Error(
      "Workday tenant not configured; set NIMBUS_WORKDAY_TENANT_HOST and NIMBUS_WORKDAY_TENANT",
    );
  }
  const base = `${host}/ccx/oauth2/${encodeURIComponent(tenant)}`;
  return {
    id: "workday",
    vaultKey: "workday.oauth",
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    usesPkce: false,
    clientSecret: "required",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: standardAuthorizeParams,
    parseTokenResponse: parseStandardTokenResponse,
  };
}

export function resolveOAuthDescriptor(provider: OAuthProvider): OAuthProviderDescriptor {
  if (provider === "workday") {
    return makeWorkdayDescriptor({
      tenantHost: Config.workdayTenantHost,
      tenant: Config.workdayTenant,
    });
  }
  return OAUTH_PROVIDERS[provider];
}
```

- [ ] **Step 4: Add `workday` to the union + a base `OAUTH_PROVIDERS` entry**

In `oauth-registry.ts`: add `| "workday"` to the `OAuthProvider` union; add a base entry to `OAUTH_PROVIDERS` (its URLs are placeholders never used directly — `resolveOAuthDescriptor` overrides them — but the entry keeps the `Record<OAuthProvider, …>` exhaustive and satisfies the `auth.ts:647` `OAUTH_PROVIDERS[provider].clientSecret` read):

```ts
  workday: {
    id: "workday",
    vaultKey: "workday.oauth",
    // Placeholder URLs — Workday endpoints are tenant-specific; the real
    // descriptor is built per-request by makeWorkdayDescriptor / resolveOAuthDescriptor.
    authorizeUrl: "https://workday.invalid/ccx/oauth2/authorize",
    tokenUrl: "https://workday.invalid/ccx/oauth2/token",
    usesPkce: false,
    clientSecret: "required",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: standardAuthorizeParams,
    parseTokenResponse: parseStandardTokenResponse,
  },
```

Add `export` to `standardAuthorizeParams` and `parseStandardTokenResponse` declarations.

- [ ] **Step 5a: Enumerate every descriptor lookup site first (review point 4)**

Run: `git grep -n "OAUTH_PROVIDERS\[" packages/gateway/src/auth/`
Inspect each hit and classify it: a site that **builds a descriptor for an authorize / code-exchange / refresh** must move to `resolveOAuthDescriptor(provider)`; a site that only **reads a static field** (`.clientSecret`, `.vaultKey`) may stay on the static map. Record the list before editing so none is missed.

- [ ] **Step 5b: Route the descriptor-resolution sites through `resolveOAuthDescriptor`**

Replace `OAUTH_PROVIDERS[provider]` with `resolveOAuthDescriptor(provider)` at the descriptor-build sites:

- `auth/pkce.ts` `refreshAccessToken` (~line 251): `descriptor: resolveOAuthDescriptor(provider),`
- `auth/pkce.ts` `runPKCEFlow` — grep for `OAUTH_PROVIDERS[` in this file; route the authorize/exchange descriptor build through `resolveOAuthDescriptor(provider)` too.
- `auth/oauth-vault-tokens.ts` (~line 28): `descriptor: resolveOAuthDescriptor(args.provider),`

Import `resolveOAuthDescriptor` from `./workday-oauth-descriptor.ts` in both files. Leave the `auth.ts:647` `OAUTH_PROVIDERS[profile.provider].clientSecret` read as-is (it only needs the static `clientSecret` mode, which the base entry provides).

> Grep to be exhaustive: `rg "OAUTH_PROVIDERS\[" packages/gateway/src` — every site that builds a *descriptor for an exchange/refresh/authorize* must use `resolveOAuthDescriptor`; sites that only read a static field (`.clientSecret`, `.vaultKey`) may stay.

- [ ] **Step 6: Implement `getValidWorkdayAccessToken`** (`workday-access-token.ts`)

```ts
import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken } from "./oauth-registry.ts";
import { makeWorkdayDescriptor } from "./workday-oauth-descriptor.ts";

export async function getValidWorkdayAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: makeWorkdayDescriptor({
      tenantHost: Config.workdayTenantHost,
      tenant: Config.workdayTenant,
    }),
    vault,
    clientId: Config.oauthWorkdayClientId,
    clientSecret: Config.oauthWorkdayClientSecret,
    notConfiguredError: "Workday OAuth not configured; run: nimbus connector auth workday",
    parseErrors: {
      invalidJson: "Invalid workday.oauth vault payload",
      invalidPayload: "Invalid workday.oauth vault payload",
      missingAccess: "Missing Workday access token",
      missingRefresh: "Missing Workday refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_WORKDAY_CLIENT_ID and NIMBUS_OAUTH_WORKDAY_CLIENT_SECRET for Workday token refresh",
  });
}
```

- [ ] **Step 7: Write the access-token test** (`workday-access-token.test.ts`)

Mirror `mendeley-access-token.test.ts`: set the env vars, seed a fake vault with a non-expired `workday.oauth` bundle, assert `getValidWorkdayAccessToken(vault)` returns the access token; assert it throws the not-configured error when the vault key is empty.

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getValidWorkdayAccessToken } from "./workday-access-token.ts";

function fakeVault(initial: Record<string, string>) {
  const m = new Map(Object.entries(initial));
  return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) } as never;
}

describe("getValidWorkdayAccessToken", () => {
  beforeEach(() => {
    process.env["NIMBUS_WORKDAY_TENANT_HOST"] = "https://wd5.workday.com";
    process.env["NIMBUS_WORKDAY_TENANT"] = "acme";
  });
  afterEach(() => {
    delete process.env["NIMBUS_WORKDAY_TENANT_HOST"];
    delete process.env["NIMBUS_WORKDAY_TENANT"];
  });

  test("returns the access token when not expired", async () => {
    const vault = fakeVault({
      "workday.oauth": JSON.stringify({
        accessToken: "tok-123",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["api"],
      }),
    });
    expect(await getValidWorkdayAccessToken(vault)).toBe("tok-123");
  });

  test("throws not-configured when vault key absent", async () => {
    await expect(getValidWorkdayAccessToken(fakeVault({}))).rejects.toThrow(/not configured/);
  });
});
```

> Match the exact fake-vault shape `mendeley-access-token.test.ts` uses (it may import a real in-memory vault helper). Reuse that helper if present rather than the inline stub.

- [ ] **Step 8: Run tests + typecheck**

Run: `bun test packages/gateway/src/auth/workday-oauth-descriptor.test.ts packages/gateway/src/auth/workday-access-token.test.ts && bun run --filter @nimbus-dev/gateway typecheck`
Expected: PASS, no TS errors.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/auth/workday-oauth-descriptor.ts packages/gateway/src/auth/workday-oauth-descriptor.test.ts packages/gateway/src/auth/workday-access-token.ts packages/gateway/src/auth/workday-access-token.test.ts packages/gateway/src/auth/oauth-registry.ts packages/gateway/src/auth/pkce.ts packages/gateway/src/auth/oauth-vault-tokens.ts
git commit -m "feat(workday): tenant-specific OAuth descriptor factory + resolution indirection"
```

---

## Task 5: Wire the `nimbus connector auth workday` flow

**Files:**

- Modify: `packages/gateway/src/connectors/connector-catalog.ts` (`oauthProfileForService` switch, before `default`)
- Modify: `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` (import help strings; `oauthClientConfigForProvider` case)
- Test: `packages/gateway/src/connectors/connector-catalog.test.ts` (existing — add a case)

**Interfaces:**

- Consumes: `WORKDAY_OAUTH_CLIENT_ID_HELP`/`_SECRET_HELP` (Task 3), `Config.oauthWorkday*` (Task 3).
- Produces: `oauthProfileForService("workday") === { provider: "workday", defaultScopes: [...] }`.

- [ ] **Step 1: Write the failing test** (`connector-catalog.test.ts`)

```ts
import { oauthProfileForService } from "./connector-catalog.ts";
test("workday maps to the workday oauth provider", () => {
  expect(oauthProfileForService("workday")).toEqual({ provider: "workday", defaultScopes: ["system"] });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/connectors/connector-catalog.test.ts`
Expected: FAIL — falls into the `default` (`oauthUnsupported`) branch and throws.

- [ ] **Step 3: Add the `oauthProfileForService` case** (before `default`)

```ts
    case "workday":
      return { provider: "workday", defaultScopes: ["system"] };
```

> `"system"` is Workday's standard API scope for an Integrations API Client. Confirm against your tenant's API Client config when integration-testing; the value flows through as the requested scope only.

- [ ] **Step 4: Add the `oauthClientConfigForProvider` case** (`auth.ts`)

Import the help strings at the top:

```ts
  WORKDAY_OAUTH_CLIENT_ID_HELP,
  WORKDAY_OAUTH_CLIENT_SECRET_HELP,
```

Add the case before `default`:

```ts
    case "workday":
      return {
        clientId: Config.oauthWorkdayClientId,
        emptyClientIdMessage: WORKDAY_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthWorkdayClientSecret,
        clientSecretMissingHelp: WORKDAY_OAUTH_CLIENT_SECRET_HELP,
      };
```

- [ ] **Step 5: Run the test + typecheck**

Run: `bun test packages/gateway/src/connectors/connector-catalog.test.ts && bun run --filter @nimbus-dev/gateway typecheck`
Expected: PASS. (The `oauthClientConfigForProvider` `never`-exhaustiveness default is now satisfied for `workday`.)

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/connectors/connector-catalog.ts packages/gateway/src/connectors/connector-catalog.test.ts packages/gateway/src/ipc/connector-rpc-handlers/auth.ts
git commit -m "feat(workday): wire nimbus connector auth workday oauth flow"
```

---

## Task 6: Scaffold the connector package

**Files:**

- Create: `packages/mcp-connectors/workday/package.json`
- Create: `packages/mcp-connectors/workday/nimbus.extension.json`
- Create: `packages/mcp-connectors/workday/tsconfig.json`
- Modify: root `package.json` (`workspaces` array — add `"packages/mcp-connectors/workday"`)

**Interfaces:** none yet (scaffolding). Copy each file from the `mendeley` package and rename ids.

- [ ] **Step 1: Copy the Mendeley package files**

Create `package.json` mirroring `packages/mcp-connectors/mendeley/package.json` with `"name": "@nimbus-dev/mcp-workday"` (match the mendeley naming scheme exactly), same scripts/deps.

Create `tsconfig.json` identical to mendeley's.

Create `nimbus.extension.json`:

```json
{
  "id": "com.nimbus.workday",
  "displayName": "Workday",
  "version": "0.1.0",
  "entrypoint": "dist/server.js",
  "runtime": "bun",
  "permissions": { "network": [], "filesystem": { "read": [], "write": [] } },
  "hitlRequired": [],
  "syncInterval": 600,
  "minNimbusVersion": "0.14.0"
}
```

> `network: []` — the tenant host is added at spawn via `manifestWithExtraNetworkHosts` (Task 16), exactly like argocd/mlflow. `hitlRequired: []` — read-only.

- [ ] **Step 2: Add to root workspaces**

Add `"packages/mcp-connectors/workday"` to the root `package.json` `workspaces` array (individual entry, no glob — required *before* `bun install`).

- [ ] **Step 3: Install + verify linkage**

Run: `bun install`
Expected: workspace links the new package without error.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-connectors/workday/package.json packages/mcp-connectors/workday/nimbus.extension.json packages/mcp-connectors/workday/tsconfig.json package.json bun.lock
git commit -m "chore(workday): scaffold connector package + workspace entry"
```

---

## Task 7: Connector server (live REST read tools) + search filter

**Files:**

- Create: `packages/mcp-connectors/workday/src/search-filter.ts`
- Create: `packages/mcp-connectors/workday/src/server.ts`
- Create: `packages/mcp-connectors/workday/src/tools.ts`
- Create: `packages/mcp-connectors/workday/test/server.test.ts`

**Interfaces:**

- Produces: `registerWorkdayTools(reg: ZodToolRegistrar): void`; `WORKDAY_TOOL_NAMES = ["workday_list","workday_get","workday_search"] as const`; `filterWorkdayWorkers`.
- Reads env: `WORKDAY_ACCESS_TOKEN`, `WORKDAY_TENANT_HOST`, `WORKDAY_TENANT` (injected at spawn, Task 16).

The live tools query the Workers REST collection (the connector's on-demand surface for the agent). Time-off / job-postings / reports are indexed by the gateway sync handler (Tasks 11–15); the live connector keeps a single, simple resource for agent queries.

- [ ] **Step 1: Write the failing test** (`test/server.test.ts`) — mirror `tableau/test/server-writes.test.ts` `captureTools()`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerWorkdayTools } from "../src/server.ts";

type Handler = (args: unknown) => Promise<McpListResult>;
function captureTools(): Map<string, Handler> {
  const t = new Map<string, Handler>();
  registerWorkdayTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      t.set(n, h as Handler),
  );
  return t;
}
function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("workday connector tools", () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    process.env["WORKDAY_ACCESS_TOKEN"] = "tok";
    process.env["WORKDAY_TENANT_HOST"] = "https://wd5.workday.com";
    process.env["WORKDAY_TENANT"] = "acme";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "w1", descriptor: "Ada Lovelace" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["WORKDAY_ACCESS_TOKEN"];
    delete process.env["WORKDAY_TENANT_HOST"];
    delete process.env["WORKDAY_TENANT"];
  });

  it("registers exactly the three read tools", () => {
    expect([...captureTools().keys()].sort()).toEqual(["workday_get", "workday_list", "workday_search"]);
  });

  it("workday_list returns the workers array", async () => {
    const out = payload(await (captureTools().get("workday_list") as Handler)({}));
    expect(out["data"]).toEqual([{ id: "w1", descriptor: "Ada Lovelace" }]);
  });

  it("throws when WORKDAY_ACCESS_TOKEN is unset", async () => {
    delete process.env["WORKDAY_ACCESS_TOKEN"];
    await expect((captureTools().get("workday_list") as Handler)({})).rejects.toThrow(/WORKDAY_ACCESS_TOKEN/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/mcp-connectors/workday/test/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `search-filter.ts`** (mirror mendeley's, over worker fields)

```ts
import { fieldsFromKeys } from "../../shared/search-filter.ts";

export const filterWorkdayWorkers = fieldsFromKeys([
  "descriptor",
  "title",
  "team",
  "department",
  "location",
]);
```

- [ ] **Step 4: Implement `tools.ts`**

```ts
export const WORKDAY_TOOL_NAMES = ["workday_list", "workday_get", "workday_search"] as const;
```

- [ ] **Step 5: Implement `server.ts`** (mirror `argocd/src/server.ts`)

```ts
import { z } from "zod";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import {
  fetchWithTimeout,
  mcpJsonResult as jsonResult,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../shared/run-read-only-mcp-connector.ts";
import { filterWorkdayWorkers } from "./search-filter.ts";

function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
function apiBase(): string {
  const host = trimSlash(requireProcessEnv("WORKDAY_TENANT_HOST"));
  const tenant = requireProcessEnv("WORKDAY_TENANT");
  // Workday Staffing REST: /ccx/api/staffing/v6/<tenant>/workers
  return `${host}/ccx/api/staffing/v6/${encodeURIComponent(tenant)}`;
}
function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${requireProcessEnv("WORKDAY_ACCESS_TOKEN")}`, Accept: "application/json" };
}
async function wdGet(path: string): Promise<unknown> {
  const res = await fetchWithTimeout(`${apiBase()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Workday ${String(res.status)}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as unknown;
}
function workersFrom(root: unknown): unknown[] {
  const d = (root as { data?: unknown })?.data;
  return Array.isArray(d) ? d : [];
}

export function registerWorkdayTools(reg: ZodToolRegistrar): void {
  reg(
    "workday_list",
    "List Workday workers (`GET /workers?limit=100`). Returns `{ data: [...] }` of worker objects (id, descriptor, title, team, department, location).",
    z.object({ limit: z.number().int().min(1).max(100).optional() }),
    async (p) => jsonResult(await wdGet(`/workers?limit=${p.limit ?? 100}`)),
  );
  reg(
    "workday_get",
    "Fetch one Workday worker by id (`GET /workers/{id}`).",
    z.object({ id: z.string().min(1) }),
    async (p) => jsonResult(await wdGet(`/workers/${encodeURIComponent(p.id)}`)),
  );
  reg(
    "workday_search",
    "Substring search across the first page of Workday workers (descriptor/title/team/department/location). Returns `{ matches: [...] }`.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await wdGet(`/workers?limit=100`);
      return jsonResult({ matches: filterWorkdayWorkers(workersFrom(root), { query: p.query, limit: p.limit }) });
    },
  );
}

if (import.meta.main) {
  await runReadOnlyMcpConnector("nimbus-workday", registerWorkdayTools);
}
```

- [ ] **Step 6: Run the test**

Run: `bun test packages/mcp-connectors/workday/test/server.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-connectors/workday/src/search-filter.ts packages/mcp-connectors/workday/src/server.ts packages/mcp-connectors/workday/src/tools.ts packages/mcp-connectors/workday/test/server.test.ts
git commit -m "feat(workday): connector server with live REST read tools"
```

---

## Task 8: no-row-data + no-write-tools contract test

**Files:**

- Create: `packages/mcp-connectors/workday/test/no-write-tools.test.ts`

**Interfaces:** Consumes `WORKDAY_TOOL_NAMES` (Task 7), `assertNoRowDataTools` from `@nimbus-dev/sdk`.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { WORKDAY_TOOL_NAMES } from "../src/tools.ts";

describe("Workday no-row-data + read-only contract", () => {
  it("registers only the metadata read tools", () => {
    expect([...WORKDAY_TOOL_NAMES]).toEqual(["workday_list", "workday_get", "workday_search"]);
  });
  it("exposes no row/cell/query tool — assertNoRowDataTools does not throw", () => {
    expect(() => assertNoRowDataTools(WORKDAY_TOOL_NAMES.map((name) => ({ name })), "workday")).not.toThrow();
  });
  it("rejects a hypothetical write/query tool (assertion is live)", () => {
    expect(() => assertNoRowDataTools([{ name: "workday_run_query" }], "workday")).toThrow();
  });
  it("has no create/update/delete tool name", () => {
    const writeish = WORKDAY_TOOL_NAMES.filter((n) => /_(create|update|delete|promote|sync)$/.test(n));
    expect(writeish).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test packages/mcp-connectors/workday/test/no-write-tools.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-connectors/workday/test/no-write-tools.test.ts
git commit -m "test(workday): no-row-data + read-only contract"
```

---

## Task 9: Directory-safe field allowlist

**Files:**

- Create: `packages/gateway/src/connectors/workday-field-allowlist.ts`
- Create: `packages/gateway/src/connectors/workday-field-allowlist.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export const WORKER_ALLOWED_FIELDS: readonly string[];
  export const TIME_OFF_ALLOWED_FIELDS: readonly string[];
  export const JOB_POSTING_ALLOWED_FIELDS: readonly string[];
  export function pickAllowed<T extends Record<string, unknown>>(row: T, allowed: readonly string[]): Record<string, unknown>;
  export function isPiiKey(key: string): boolean; // RaaS denylist heuristic
  export function applyReportFieldPolicy(row: Record<string, unknown>, fields?: readonly string[]): Record<string, unknown>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import {
  applyReportFieldPolicy,
  isPiiKey,
  pickAllowed,
  WORKER_ALLOWED_FIELDS,
} from "./workday-field-allowlist.ts";

describe("workday field allowlist", () => {
  test("pickAllowed keeps only allowlisted keys", () => {
    const row = { name: "Ada", title: "Eng", salary: 200000, ssn: "x", home_address: "y" };
    const out = pickAllowed(row, WORKER_ALLOWED_FIELDS);
    expect(out["name"]).toBe("Ada");
    expect(out["title"]).toBe("Eng");
    expect(out).not.toHaveProperty("salary");
    expect(out).not.toHaveProperty("ssn");
    expect(out).not.toHaveProperty("home_address");
  });

  test.each([
    "ssn", "national_id", "tax_id", "passport", "salary", "total_comp",
    "remuneration", "dob", "date_of_birth", "home_address", "medical_note",
    "bank_account", "routing_number", "iban", "gender", "ethnicity",
  ])("isPiiKey flags %s", (k) => {
    expect(isPiiKey(k)).toBe(true);
  });

  test("isPiiKey allows benign keys", () => {
    expect(isPiiKey("org")).toBe(false);
    expect(isPiiKey("headcount")).toBe(false);
    expect(isPiiKey("employee_id")).toBe(false);
  });

  test("applyReportFieldPolicy: explicit fields win, else denylist applies", () => {
    const row = { employee_id: "e1", org: "Eng", salary: 1, ssn: "x" };
    expect(applyReportFieldPolicy(row, ["employee_id", "org"])).toEqual({ employee_id: "e1", org: "Eng" });
    expect(applyReportFieldPolicy(row)).toEqual({ employee_id: "e1", org: "Eng" }); // salary+ssn dropped by denylist
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/connectors/workday-field-allowlist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export const WORKER_ALLOWED_FIELDS = [
  "name", "title", "manager", "managerId", "team", "supervisoryOrg",
  "department", "location", "workEmail", "workPhone", "hireDate",
  "employmentStatus", "canonicalUrl",
] as const;

export const TIME_OFF_ALLOWED_FIELDS = [
  "worker", "workerId", "type", "startDate", "endDate", "units", "status", "canonicalUrl",
] as const;

export const JOB_POSTING_ALLOWED_FIELDS = [
  "title", "team", "department", "location", "status", "postedDate", "canonicalUrl",
] as const;

const PII_KEY_RE =
  /(ssn|social_security|national_id|nationalid|tax_id|taxid|passport|salary|compensation|total_comp|remuneration|\bcomp\b|dob|date_of_birth|birth|home_address|^address$|street|postal|zip|medical|fmla|disability|bank|account_number|routing|iban|swift|gender|ethnicity|race|religion|marital|personal_email|personal_phone)/i;

export function isPiiKey(key: string): boolean {
  return PII_KEY_RE.test(key);
}

export function pickAllowed<T extends Record<string, unknown>>(
  row: T,
  allowed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
  }
  return out;
}

export function applyReportFieldPolicy(
  row: Record<string, unknown>,
  fields?: readonly string[],
): Record<string, unknown> {
  if (fields !== undefined && fields.length > 0) {
    return pickAllowed(row, fields);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!isPiiKey(k) && v !== undefined && v !== null) out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4: Run the test**

Run: `bun test packages/gateway/src/connectors/workday-field-allowlist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/workday-field-allowlist.ts packages/gateway/src/connectors/workday-field-allowlist.test.ts
git commit -m "feat(workday): directory-safe field allowlist + RaaS PII denylist"
```

---

## Task 10–13: Item mappers

All four mappers live in `packages/gateway/src/connectors/workday-mappers.ts` (tests in `workday-mappers.test.ts`). Each task adds one mapper + its tests; commit after each. First, establish the shared types used by every mapper.

**Shared types (define once, in Task 10's first edit):**

```ts
// BLAKE3 — the established gateway pattern (audit-chain.ts / egress-ledger.ts / share-format.ts
// all do this; there is NO blake3Hex helper to import). Used by stableRowKey in Task 13.
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
// Gateway-local object guard (NEVER import from mcp-connectors — gateway must not depend on
// connector packages; see Non-Negotiables / Dependency rules).
import { asRecord } from "./unknown-record.ts";
import type { MappedRow } from "./mapped-row.ts"; // confirm path used by mendeley-reference-mapping.ts: rg "MappedRow" packages/gateway/src/connectors/mendeley-reference-mapping.ts

export interface WorkdayMapContext {
  readonly syncedAt: number;
  readonly tenantHost: string;
  readonly tenant: string;
}
```

> Open `mendeley-reference-mapping.ts` and copy its exact `MappedRow` import + the `MendeleyMappedRow` shape; mirror it for `WorkdayMappedRow = MappedRow<"workday", "worker" | "time_off" | "job_posting" | "report">` (or four separate aliases). Use `upsertIndexedItemForSync`-compatible fields: `service`, `type`, `externalId`, `title`, `bodyPreview`, `url`, `canonicalUrl`, `modifiedAt`, `metadata`, `syncedAt`. Confirm the exact field names from `mendeley-reference-mapping.ts` (agent-confirmed shape).

### Task 10: `mapWorkerToItem`

**Interfaces:** `export function mapWorkerToItem(raw: unknown, ctx: WorkdayMapContext): WorkdayMappedRow | null;`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mapWorkerToItem } from "./workday-mappers.ts";

const ctx = { syncedAt: 1_700_000_000_000, tenantHost: "https://wd5.workday.com", tenant: "acme" };

describe("mapWorkerToItem", () => {
  test("maps allowlisted fields and a stable id; drops PII", () => {
    const raw = {
      id: "w-1", name: "Ada Lovelace", title: "Principal Engineer",
      manager: "Charles Babbage", team: "Analytical Engines", location: "London",
      salary: 250000, ssn: "123-45-6789", home_address: "12 Mayfair",
    };
    const item = mapWorkerToItem(raw, ctx);
    expect(item).not.toBeNull();
    expect(item?.externalId).toBe("w-1");
    expect(item?.service).toBe("workday");
    expect(item?.type).toBe("worker");
    expect(item?.title).toBe("Ada Lovelace");
    expect(item?.metadata).toMatchObject({ title: "Principal Engineer", team: "Analytical Engines" });
    expect(JSON.stringify(item?.metadata)).not.toContain("250000");
    expect(JSON.stringify(item?.metadata)).not.toContain("123-45-6789");
    expect(JSON.stringify(item)).not.toContain("Mayfair");
  });

  test("returns null when worker id is missing", () => {
    expect(mapWorkerToItem({ name: "x" }, ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/connectors/workday-mappers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mapWorkerToItem`**

```ts
// asRecord + blake3/bytesToHex are imported once in the shared-types block above.
import { pickAllowed, WORKER_ALLOWED_FIELDS } from "./workday-field-allowlist.ts";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function workerCanonicalUrl(ctx: WorkdayMapContext, id: string): string {
  return `${ctx.tenantHost.replace(/\/$/, "")}/${encodeURIComponent(ctx.tenant)}/d/inst/1$37/${encodeURIComponent(id)}.htmld`;
}

export function mapWorkerToItem(raw: unknown, ctx: WorkdayMapContext): WorkdayMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const id = str(row["id"]) ?? str(row["workerId"]);
  if (id === undefined) return null;
  const name = str(row["name"]) ?? str(row["descriptor"]) ?? `Worker ${id}`;
  const canonicalUrl = workerCanonicalUrl(ctx, id);
  const metadata = pickAllowed({ ...row, canonicalUrl }, WORKER_ALLOWED_FIELDS);
  return {
    service: "workday",
    type: "worker",
    externalId: id,
    title: name,
    bodyPreview: [str(row["title"]), str(row["team"]), str(row["location"])].filter(Boolean).join(" · "),
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt: ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
```

> Don't add `name` to `WORKER_ALLOWED_FIELDS` only to drop it — `name` IS allowlisted and stored in metadata too; that's fine. Confirm the exact `WorkdayMappedRow` field names against `mendeley-reference-mapping.ts` (e.g. it may use `bodyPreview` vs `body_preview`).

- [ ] **Step 4: Run the test**

Run: `bun test packages/gateway/src/connectors/workday-mappers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/workday-mappers.ts packages/gateway/src/connectors/workday-mappers.test.ts
git commit -m "feat(workday): mapWorkerToItem with PII allowlist"
```

### Task 11: `mapTimeOffToItem`

**Interfaces:** `export function mapTimeOffToItem(raw: unknown, ctx: WorkdayMapContext): WorkdayMappedRow | null;`

- [ ] **Step 1: Write the failing test** — assert id (`workday:` + native id), `type === "time_off"`, allowlisted (worker/type/startDate/endDate/units/status); assert a free-text `reason`/`comment`/`medicalNote` field never appears; null when id missing.

```ts
test("mapTimeOffToItem keeps category + dates, drops reason/comment", () => {
  const item = mapTimeOffToItem(
    { id: "to-9", worker: "Ada", type: "Sick", startDate: "2026-01-02", endDate: "2026-01-03",
      units: 2, status: "Approved", reason: "flu", comment: "private", medicalNote: "x" },
    ctx,
  );
  expect(item?.type).toBe("time_off");
  expect(item?.externalId).toBe("to-9");
  expect(item?.metadata).toMatchObject({ type: "Sick", status: "Approved", units: 2 });
  expect(JSON.stringify(item)).not.toContain("flu");
  expect(JSON.stringify(item)).not.toContain("private");
});
test("mapTimeOffToItem null without id", () => { expect(mapTimeOffToItem({}, ctx)).toBeNull(); });
```

- [ ] **Step 2: Run it (FAIL — not exported)**

Run: `bun test packages/gateway/src/connectors/workday-mappers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (mirror `mapWorkerToItem`, using `TIME_OFF_ALLOWED_FIELDS`, `type: "time_off"`, title `` `${type} ${startDate}` ``).

- [ ] **Step 4: Run (PASS)** — `bun test packages/gateway/src/connectors/workday-mappers.test.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(workday): mapTimeOffToItem (category+dates only)"`

### Task 12: `mapJobPostingToItem`

**Interfaces:** `export function mapJobPostingToItem(raw: unknown, ctx: WorkdayMapContext): WorkdayMappedRow | null;`

- [ ] **Step 1: Write the failing test** — id `workday:<reqId>`, `type === "job_posting"`, allowlisted (title/team/department/location/status/postedDate); assert a `description`/`qualifications` body field is NOT present (confirms §4.3 routing rationale); null when id missing.

- [ ] **Step 2: Run it (FAIL)** — `bun test packages/gateway/src/connectors/workday-mappers.test.ts`

- [ ] **Step 3: Implement** (mirror, `JOB_POSTING_ALLOWED_FIELDS`, `type: "job_posting"`, title = posting title).

- [ ] **Step 4: Run (PASS)**

- [ ] **Step 5: Commit** — `git commit -am "feat(workday): mapJobPostingToItem (no description body)"`

### Task 13: `mapReportRowToItem` (stable id + field policy)

**Interfaces:** `export function mapReportRowToItem(raw: unknown, report: WorkdayReport, ctx: WorkdayMapContext): WorkdayMappedRow | null;` (no index param — the id is content-derived, so position is irrelevant; review point 3).

- [ ] **Step 1: Write the failing test**

```ts
import type { WorkdayReport } from "../config/nimbus-toml-workday.ts";
const rpt: WorkdayReport = { label: "headcount", url: "https://wd5.workday.com/x" };

test("uses key_field for a stable external id", () => {
  const r = mapReportRowToItem({ employee_id: "e1", org: "Eng" }, { ...rpt, keyField: "employee_id" }, ctx);
  expect(r?.externalId).toBe("headcount:e1");
  expect(r?.type).toBe("report");
});
test("hashes the row content when no key_field — same content → same id (position-independent)", () => {
  const a = mapReportRowToItem({ org: "Eng", headcount: 12 }, rpt, ctx);
  const b = mapReportRowToItem({ org: "Eng", headcount: 12 }, rpt, ctx);
  const c = mapReportRowToItem({ org: "Sales", headcount: 7 }, rpt, ctx);
  expect(a?.externalId).toBe(b?.externalId); // identical content → identical id
  expect(a?.externalId).not.toBe(c?.externalId); // different content → different id
  expect(a?.externalId.startsWith("headcount:")).toBe(true);
});
test("applies fields allowlist / denylist", () => {
  const r = mapReportRowToItem({ employee_id: "e1", salary: 9, ssn: "x" }, rpt, ctx);
  expect(JSON.stringify(r)).not.toContain("salary");
  expect(JSON.stringify(r)).not.toContain("\"x\"");
});
```

- [ ] **Step 2: Run it (FAIL)** — `bun test packages/gateway/src/connectors/workday-mappers.test.ts`

- [ ] **Step 3: Implement**

```ts
import { applyReportFieldPolicy } from "./workday-field-allowlist.ts";
import type { WorkdayReport } from "../config/nimbus-toml-workday.ts";

function stableRowKey(row: Record<string, unknown>): string {
  const sorted = Object.keys(row).sort().map((k) => `${k}=${String(row[k])}`).join("");
  return bytesToHex(blake3(new TextEncoder().encode(sorted))).slice(0, 32);
}

export function mapReportRowToItem(
  raw: unknown,
  report: WorkdayReport,
  ctx: WorkdayMapContext,
): WorkdayMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const filtered = applyReportFieldPolicy(row, report.fields);
  const keyVal =
    report.keyField !== undefined && typeof row[report.keyField] === "string"
      ? (row[report.keyField] as string)
      : stableRowKey(row);
  const externalId = `${report.label}:${keyVal}`;
  return {
    service: "workday",
    type: "report",
    externalId,
    title: `${report.label} — ${keyVal}`,
    bodyPreview: Object.entries(filtered).slice(0, 4).map(([k, v]) => `${k}: ${String(v)}`).join(" · "),
    url: report.url,
    canonicalUrl: report.url,
    modifiedAt: ctx.syncedAt,
    metadata: { reportLabel: report.label, ...filtered },
    syncedAt: ctx.syncedAt,
  };
}
```

> BLAKE3 uses the established gateway pattern `bytesToHex(blake3(...))` imported directly from `@noble/hashes` (verified: `audit-chain.ts`, `egress-ledger.ts`, `share-format.ts` all do this — there is no `blake3Hex` helper). 32 hex chars of the digest is plenty for a row surrogate key.

- [ ] **Step 4: Run (PASS)** — `bun test packages/gateway/src/connectors/workday-mappers.test.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(workday): mapReportRowToItem (key_field/BLAKE3 stable id + field policy)"`

---

## Task 14: Sync handler — REST domains (workers / time-off / job-postings)

**Files:**

- Create: `packages/gateway/src/connectors/workday-sync.ts`
- Create: `packages/gateway/src/connectors/workday-sync.test.ts`

**Interfaces:**

- Consumes: the four mappers (Tasks 10–13), `getValidWorkdayAccessToken` (Task 4), `Config.workdayTenantHost`/`workdayTenant`, the cursor helpers + `Syncable`/`SyncResult` types.
- Produces:

  ```ts
  export function createWorkdaySyncable(options: {
    ensureWorkdayMcpRunning: () => Promise<void>;
    loadWorkdayConfig?: () => NimbusWorkdayToml; // injectable for tests
    fetchFn?: typeof fetch; // injectable for tests
    loadAccessToken?: () => Promise<string>; // injectable for tests
  }): Syncable;
  ```

**This task is a structural mirror of `packages/gateway/src/connectors/mendeley-sync.ts`.** Open that file and replicate its skeleton (`SERVICE_ID`, `CURSOR_PREFIX = "nimbus-workday1:"`, `createMendeleySyncable` → `createWorkdaySyncable`, `decodeNimbusJsonCursorPayload`/`encodeNimbusJsonCursor`, `upsertIndexedItemForSync`, `syncPassCursorSuccess`). Adaptations:

- Fetch THREE REST collections per sync pass: `/workers`, `/timeOff` (Absence), `/jobRequisitions` (Recruiting) — each token-paged, page-capped (`MAX_PAGES = 20`), mapped via `mapWorkerToItem` / `mapTimeOffToItem` / `mapJobPostingToItem`.
- **Per-domain isolation:** wrap each domain walk in try/catch; on error (e.g. 403/404 unlicensed) log via the sync ctx logger and continue with the other domains (do NOT throw out of the pass).
- Time-off walk bounded by `loadWorkdayConfig().timeOffHistoryDays` (a `?from=<isoDate>` query param `daysAgo`).
- Cursor records per-domain paging continuation; return `hasMore: true` while any domain has more pages.

- [ ] **Step 1: Write the failing test** (`workday-sync.test.ts`) — inject `fetchFn` + `loadAccessToken` + `loadWorkdayConfig`; assert mapped upserts across domains and per-domain isolation:

```ts
import { describe, expect, test } from "bun:test";
import { createWorkdaySyncable } from "./workday-sync.ts";
import { DEFAULT_NIMBUS_WORKDAY_TOML } from "../config/nimbus-toml-workday.ts";
// Use the SAME in-memory sync harness mendeley-sync.test.ts uses — open it and reuse its ctx/db setup helper.

function fetchStub(map: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    const key = Object.keys(map).find((k) => u.includes(k));
    if (key === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(map[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("createWorkdaySyncable", () => {
  test("maps workers + time-off + job-postings into upserts", async () => {
    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      fetchFn: fetchStub({
        "/workers": { data: [{ id: "w1", name: "Ada", title: "Eng" }] },
        "/timeOff": { data: [{ id: "t1", worker: "Ada", type: "PTO", startDate: "2026-01-01", endDate: "2026-01-02", status: "Approved" }] },
        "/jobRequisitions": { data: [{ id: "j1", title: "Staff Eng", status: "Open" }] },
      }),
    });
    // Drive syncable.sync(ctx, null) with the mendeley-style test ctx; assert 3 upserts with ids workday:w1 / workday:t1 / workday:j1 and types worker/time_off/job_posting.
    // (Fill ctx/db per mendeley-sync.test.ts harness.)
  });

  test("a domain that 404s does not abort the others", async () => {
    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      fetchFn: fetchStub({ "/workers": { data: [{ id: "w1", name: "Ada" }] } }), // timeOff + jobRequisitions → 404
    });
    // Assert the worker is still upserted (no throw).
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/connectors/workday-sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `workday-sync.ts`** by adapting `mendeley-sync.ts` per the adaptation list above. Key skeleton (fill helpers from the mendeley reference):

```ts
import { encodeNimbusJsonCursor, decodeNimbusJsonCursorPayload } from "./cursor.ts"; // confirm path from mendeley-sync.ts imports
import { upsertIndexedItemForSync } from "./sync-upsert.ts"; // confirm path from mendeley-sync.ts
import { getValidWorkdayAccessToken } from "../auth/workday-access-token.ts";
import { Config } from "../config.ts";
import { loadNimbusWorkdayFromConfigDir, type NimbusWorkdayToml } from "../config/nimbus-toml-workday.ts";
import { mapJobPostingToItem, mapTimeOffToItem, mapWorkerToItem, mapReportRowToItem } from "./workday-mappers.ts";

const SERVICE_ID = "workday";
const CURSOR_PREFIX = "nimbus-workday1:";
const MAX_PAGES = 20;

// createWorkdaySyncable(...) returns a Syncable matching mendeley-sync.ts's shape:
//  - serviceId, defaultIntervalMs (10*60*1000), initialSyncDepthDays
//  - sync(ctx, cursor): fetch token via loadAccessToken ?? getValidWorkdayAccessToken(ctx.vault);
//    build WorkdayMapContext { syncedAt: ctx.syncedAt, tenantHost: Config.workdayTenantHost, tenant: Config.workdayTenant };
//    walk each domain (try/catch per domain), map rows, upsertIndexedItemForSync(ctx, item);
//    return syncPassCursorSuccess(...) with the next cursor + hasMore.
```

Include the RaaS report walk hook now but as a no-op when `reports` is empty (Task 15 fills it), so the file's structure is complete.

- [ ] **Step 4: Run the test**

Run: `bun test packages/gateway/src/connectors/workday-sync.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/workday-sync.ts packages/gateway/src/connectors/workday-sync.test.ts
git commit -m "feat(workday): REST sync (workers/time-off/job-postings) with per-domain isolation"
```

---

## Task 15: Sync handler — RaaS reports with same-host enforcement

**Files:**

- Modify: `packages/gateway/src/connectors/workday-sync.ts` (fill the report walk)
- Modify: `packages/gateway/src/connectors/workday-sync.test.ts` (add report cases)

**Interfaces:** Consumes `mapReportRowToItem` (Task 13), `WorkdayReport` (Task 2). Adds an internal `sameTenantHost(reportUrl, tenantHost): boolean`.

- [ ] **Step 1: Write the failing test** (add to `workday-sync.test.ts`)

```ts
test("indexes RaaS report rows from a same-host report url", async () => {
  const syncable = createWorkdaySyncable({
    ensureWorkdayMcpRunning: async () => {},
    loadAccessToken: async () => "tok",
    loadWorkdayConfig: () => ({
      timeOffHistoryDays: 365,
      reports: [{ label: "headcount", url: "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/HC?format=json" }],
    }),
    fetchFn: fetchStub({
      "/workers": { data: [] },
      "/timeOff": { data: [] },
      "/jobRequisitions": { data: [] },
      "/customreport2/acme/ISU/HC": { Report_Entry: [{ org: "Eng", headcount: 12 }] },
    }),
  });
  // Assert one workday:report upsert with metadata.reportLabel === "headcount".
});

test("rejects a report url whose host != tenant host (no fetch, no upsert)", async () => {
  let fetched = false;
  const syncable = createWorkdaySyncable({
    ensureWorkdayMcpRunning: async () => {},
    loadAccessToken: async () => "tok",
    loadWorkdayConfig: () => ({
      timeOffHistoryDays: 365,
      reports: [{ label: "evil", url: "https://evil.example.com/report?format=json" }],
    }),
    fetchFn: (async (u: string) => { if (String(u).includes("evil")) fetched = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch,
  });
  // Drive sync; assert fetched === false and no report upsert (other domains may 404 harmlessly).
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/connectors/workday-sync.test.ts`
Expected: FAIL — reports not indexed / evil host fetched.

- [ ] **Step 3: Implement the report walk**

```ts
function sameTenantHost(reportUrl: string, tenantHost: string): boolean {
  try {
    return new URL(reportUrl).host === new URL(tenantHost).host;
  } catch {
    return false;
  }
}

function reportRowsFrom(root: unknown): unknown[] {
  // Workday RaaS JSON wraps rows under "Report_Entry"; fall back to a bare array.
  const entry = (root as { Report_Entry?: unknown })?.Report_Entry;
  if (Array.isArray(entry)) return entry;
  return Array.isArray(root) ? root : [];
}
```

In the sync pass, after the REST domains, for each `report` in `loadWorkdayConfig().reports`:

- skip + warn if `!sameTenantHost(report.url, Config.workdayTenantHost)`;
- else fetch with the bearer token (try/catch per report — a 401/non-ok is logged and skipped);
- map each row via `mapReportRowToItem(row, report, mapCtx)` and upsert.

- [ ] **Step 4: Run the test**

Run: `bun test packages/gateway/src/connectors/workday-sync.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/workday-sync.ts packages/gateway/src/connectors/workday-sync.test.ts
git commit -m "feat(workday): RaaS report indexing with same-host egress enforcement"
```

---

## Task 16: Lazy-mesh spawn (token + tenant host into the sandbox)

**Files:**

- Create: `packages/gateway/src/connectors/lazy-mesh/workday-spawn.ts` (or add `ensureWorkdayMcp` to `connector-spawns.ts` — match where Mendeley's lives; agent confirms `connector-spawns.ts`)
- Modify: `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts` (import + `ensureWorkdayMcp`)
- Modify: `packages/gateway/src/connectors/lazy-mesh/mesh.ts` (`ensureWorkdayRunning` + `collectBuiltInToolMaps` entry)
- Modify: `packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts` (`CredentialSpawners.ensureWorkdayMcp` + auto-spawn trigger)
- Test: `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts` (existing — add a workday case mirroring the mendeley one)

**Interfaces:**

- Produces: `ensureWorkdayMcp(ctx: MeshSpawnContext): Promise<void>`; `mesh.ensureWorkdayRunning()`.

`ensureWorkdayMcp` mirrors `ensureMendeleyMcp` (agent-confirmed, `connector-spawns.ts:493`) with two Workday-specific differences: (1) it injects three env vars, and (2) it adds the tenant host to the sandbox network allowlist via `manifestWithExtraNetworkHosts` (argocd/mlflow pattern).

- [ ] **Step 1: Write the failing test** — mirror the mendeley spawn test: seed `workday.oauth` in the fake vault + set `NIMBUS_WORKDAY_TENANT_HOST`/`_TENANT`; assert a client is registered for `LAZY_MESH.workday`; assert no spawn when the oauth secret is absent.

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts`
Expected: FAIL — `ensureWorkdayMcp` not exported.

- [ ] **Step 3: Implement `ensureWorkdayMcp`** (adapt `ensureMendeleyMcp`)

```ts
import { Config } from "../../config.ts";
import { hostnameFromUrl } from "./first-party-manifests.ts"; // confirm export site used by phase3-config.ts
import { manifestWithExtraNetworkHosts } from "./first-party-manifests.ts";
import { getValidWorkdayAccessToken } from "../../auth/workday-access-token.ts";

export async function ensureWorkdayMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.workday;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "workday", "oauth");
  if (raw === null || raw === "") return;
  const tenantHost = Config.workdayTenantHost.trim();
  const tenant = Config.workdayTenant.trim();
  if (tenantHost === "" || tenant === "") return;
  let accessToken: string;
  try {
    accessToken = await getValidWorkdayAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") return;
  const host = hostnameFromUrl(tenantHost);
  const manifest = manifestWithExtraNetworkHosts("workday", host === null ? [] : [host]);
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-workday-${randomUUID()}`,
      servers: {
        workday: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("workday")],
            env: extensionProcessEnv({
              WORKDAY_ACCESS_TOKEN: accessToken,
              WORKDAY_TENANT_HOST: tenantHost,
              WORKDAY_TENANT: tenant,
            }),
          },
          "workday",
          ctx,
          manifest, // confirm wrap()'s arity — mendeley's wrap() may take (spec, serviceId, ctx); if so, pass manifest via the wrap impl like phase3 does with wrapServerSpec
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}
```

> The Mendeley spawn uses a local `wrap(...)` that internally builds the manifest from `manifestForFirstParty`. To inject the extra host, either (a) extend `wrap` to accept an optional manifest, or (b) follow the `phase3-config.ts` argocd/mlflow form using `wrapServerSpec(spec, manifestWithExtraNetworkHosts("workday",[host]), cwd)` directly. Pick whichever matches the surrounding `connector-spawns.ts` style; the argocd form is the proven host-injection path.

- [ ] **Step 4: Wire mesh + credential-orchestration**

In `mesh.ts`: add `async ensureWorkdayRunning() { return ensureWorkdayMcp(this.spawnContext); }` and add `{ map: await list(LAZY_MESH.workday), name: "workday" }` to `collectBuiltInToolMaps()`.
In `credential-orchestration.ts`: add `readonly ensureWorkdayMcp: (ctx: MeshSpawnContext) => Promise<void>;` to `CredentialSpawners` and `await ensureIfConnectorSecretSet(ctx, "workday", "oauth", () => spawners.ensureWorkdayMcp(ctx));`.
In `connector-spawns.ts`: ensure `ensureWorkdayMcp` is exported + imported wherever `ensureMendeleyMcp` is referenced for the spawners object.

- [ ] **Step 5: Run the test + typecheck**

Run: `bun test packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts && bun run --filter @nimbus-dev/gateway typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/connectors/lazy-mesh/
git commit -m "feat(workday): lazy-mesh spawn with tenant host sandbox allowlisting"
```

---

## Task 17: Register the syncable + confirm embedding routing

**Files:**

- Modify: `packages/gateway/src/platform/assemble-sync-registrations.ts` (import + register)
- Test: `packages/gateway/src/embedding/routing.test.ts` (existing — add a workday default-routing case)

**Interfaces:** Consumes `createWorkdaySyncable` (Task 14), `connectorMesh.ensureWorkdayRunning` (Task 16).

- [ ] **Step 1: Write the failing test** (`routing.test.ts`) — confirm workday types default to MiniLM (not prose-heavy):

```ts
import { isProseHeavy } from "./routing.ts";
test("workday item types are not prose-heavy (384-dim default)", () => {
  for (const t of ["worker", "time_off", "job_posting", "report"]) {
    expect(isProseHeavy("workday", t)).toBe(false);
  }
});
```

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/src/embedding/routing.test.ts`
Expected: PASS immediately (no workday types in `PROSE_HEAVY_TYPES`). This test locks in §4.5 — leave `routing.ts` unchanged.

- [ ] **Step 3: Register the syncable** (`assemble-sync-registrations.ts`, mirror the mendeley block)

```ts
import { createWorkdaySyncable } from "../connectors/workday-sync.ts";
// inside registerConnectorMeshSyncables():
  syncScheduler.register(
    createWorkdaySyncable({
      ensureWorkdayMcpRunning: () => connectorMesh.ensureWorkdayRunning(),
    }),
  );
```

- [ ] **Step 4: Run the gateway connector/sync test suite + typecheck**

Run: `bun test packages/gateway/src/connectors/ packages/gateway/src/embedding/routing.test.ts && bun run --filter @nimbus-dev/gateway typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/platform/assemble-sync-registrations.ts packages/gateway/src/embedding/routing.test.ts
git commit -m "feat(workday): register sync handler + lock 384-dim routing"
```

---

## Task 18: Docs (README, CHANGELOG, roadmap)

**Files:**

- Create: `packages/mcp-connectors/workday/README.md` (public-tier H2 sections — `audit:package-readmes` enforces)
- Modify: `docs/CHANGELOG.md` (connector-delivery entry — NOT the CLAUDE.md/GEMINI.md status line)
- Modify: `docs/roadmap.md` (check the Workday box in "Deferred from Phase 5")

- [ ] **Step 1: Write the README** — copy the section skeleton from `packages/mcp-connectors/mendeley/README.md` (run `bun run audit:package-readmes` to learn the required H2 set). Document: env vars (`NIMBUS_OAUTH_WORKDAY_CLIENT_ID/_SECRET`, `NIMBUS_WORKDAY_TENANT_HOST`, `NIMBUS_WORKDAY_TENANT`), the `nimbus connector auth workday` flow, the four item types, the PII allowlist, and the optional `[[connectors.workday.reports]]` config.

- [ ] **Step 2: Add the CHANGELOG entry** under the current unreleased/dated section, describing the read-only Workday connector (workers/time-off/job-postings + RaaS reports; reuses no migration/HITL/invariant; directory-safe allowlist).

- [ ] **Step 3: Check the roadmap box** — change the Workday line in `docs/roadmap.md` "Deferred from Phase 5" from `- [ ]` to `- [x]` with the delivery date `2026-06-21` and a one-line summary (mirror the Mendeley `- [x]` row).

- [ ] **Step 4: Validate docs gates**

Run: `bun run audit:package-readmes && bun run audit:doc-refs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/workday/README.md docs/CHANGELOG.md docs/roadmap.md
git commit -m "docs(workday): connector README + CHANGELOG + roadmap check"
```

---

## Task 19: Full preflight + Docker-Linux coverage verification

**Files:** none (verification only).

- [ ] **Step 1: Run the fast static gates**

Run: `bun run preflight:fast`
Expected: PASS (types, biome, static structure audits incl. `check-nimbus-invariants` — confirm no new invariant drift, since I-count stays I1–I27).

- [ ] **Step 2: Run the full connector + gateway + auth + config test suites**

Run: `bun test packages/mcp-connectors/workday packages/gateway/src/connectors packages/gateway/src/auth packages/gateway/src/config`
Expected: all PASS.

- [ ] **Step 3: Docker-Linux coverage-floor (authoritative)**

Build the lcov in Docker (`oven/bun:latest`) and run `check.ts` against the `{}`-baseline as the True-Coverage workstream documents. Every new non-excluded file (`workday-field-allowlist.ts`, `workday-mappers.ts`, `workday-sync.ts`, `workday-oauth-descriptor.ts`, `workday-access-token.ts`, `nimbus-toml-workday.ts`, `workday/src/search-filter.ts`) must be ≥85% line + ≥80% branch.

Run (per the `ship-readiness-before-first-push` recipe): `bash scripts/.../build-lcov.sh` in Docker, then `bun scripts/structure-audit/.../check.ts`.
Expected: `coverage-floor: PASSED`, 0 violations. If a file is below floor, add targeted tests (not exclusions) and re-run.

- [ ] **Step 4: Full preflight**

Run: `bun run preflight`
Expected: all gates green.

- [ ] **Step 5: Whole-branch review + push**

Run a whole-branch `/code-review`; address findings. Then push and open the PR (base `main`). Watch CI (coverage-floor + Sonar).

```bash
git push -u origin dev/asafgolombek/phase6-slice9-workday
```

---

## Self-Review (author checklist — completed)

**Spec coverage:** Hybrid REST+RaaS → Tasks 7/14/15; workers/time-off/job-postings/report types → Tasks 10–13; directory-safe allowlist + contract test → Tasks 9/10–13; standalone items (no people-graph) → no person-store touch; tenant OAuth (review #1) → Task 4; stable RaaS ids (review #2) → Task 13; same-host egress (review #3) → Task 15; expanded denylist + per-report fields (review #4) → Task 9; time-off window (review #5) → Tasks 2/14; job-posting routing decline (review #6) → Task 12/17. ✅ all covered.

**Placeholder scan:** No "TBD"/"implement later". Several steps say "confirm exact name/path against reference file X" — these are verification instructions with the reference named, not missing content (the reference code was extracted during planning and the adaptation is fully specified). The one genuinely reference-dependent shape (`MappedRow`/`Syncable` field names) is flagged with the exact `rg` command to confirm. BLAKE3 + `asRecord` imports are verified against the live codebase (review fixes).

**Type consistency:** `WorkdayMapContext`, `WorkdayReport`, `NimbusWorkdayToml`, `WORKDAY_TOOL_NAMES`, `makeWorkdayDescriptor`/`resolveOAuthDescriptor`/`getValidWorkdayAccessToken`, the mapper signatures, and `createWorkdaySyncable`'s options are used consistently across tasks.

---

## Review resolutions (2026-06-21)

Responses to `2026-06-21-slice9-workday-connector-review.md` (all verified against the live codebase):

| # | Topic | Resolution |
| --- | --- | --- |
| 1 | BLAKE3 import (Tasks 10, 13) | **Fixed** — `audit-chain.ts` exports no `blake3Hex`; switched to the established `import { blake3 } from "@noble/hashes/blake3.js"` + `bytesToHex` pattern used by `audit-chain.ts`/`egress-ledger.ts`/`share-format.ts`. |
| 2 | Gateway importing from `mcp-connectors` (Task 10) | **Fixed** — dependency-rule violation. Use the existing gateway-local guard `asRecord` from `connectors/unknown-record.ts` instead of `asObjectish` from the connector package. |
| 3 | Dead `_index` param in `mapReportRowToItem` (Task 13) | **Fixed** — removed from the signature, tests, and the Task 15 call site (the id is content-hashed, so position is irrelevant). |
| 4 | Exhaustive OAuth descriptor-lookup audit (Task 4) | **Fixed** — added explicit Step 5a: run `git grep -n "OAUTH_PROVIDERS\[" packages/gateway/src/auth/` and classify every hit before editing. |
