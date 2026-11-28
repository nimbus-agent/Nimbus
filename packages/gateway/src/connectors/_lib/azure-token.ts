// Phase 7 (the Cost Pack, slice 12a; owner ruling 2026-11-28): an Azure access token for the vaulted service
// principal, by the OAuth 2.0 client-credentials grant over HTTPS. No `az` CLI: `az login` takes a client secret
// only as a command-line argument (https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-service-principal),
// and a credential never goes in argv.
//
// Request (https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow):
//   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
//   grant_type=client_credentials & client_id & client_secret & scope=<resource>/.default
// The secret is in the HTTPS form body, only ever sent to login.microsoftonline.com (`fetchSameOriginOnly`: a
// redirect to any other origin is refused, and a POST is never redirected). A token lives in memory for one sync
// run (a {@link AzureTokenSource}), is never logged and never stored.
import type { SyncContext } from "../../sync/types.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { fetchSameOriginOnly } from "../same-origin-fetch.ts";

export const AZURE_STORAGE_SCOPE = "https://storage.azure.com/.default";
/** For slice 12b: the Cost Management Query API. */
export const AZURE_MANAGEMENT_SCOPE = "https://management.azure.com/.default";
export type AzureScope = typeof AZURE_STORAGE_SCOPE | typeof AZURE_MANAGEMENT_SCOPE;

export const AZURE_LOGIN_HOST = "https://login.microsoftonline.com";
export const AZURE_TOKEN_TIMEOUT_MS = 60_000;

/** A tenant id (GUID) or a verified domain name; "." and ".." never reach the URL. */
const TENANT_RE = /^[0-9a-fA-F-]{36}$|^[A-Za-z0-9.-]+$/;

export function isValidAzureTenant(t: string): boolean {
  return TENANT_RE.test(t) && t !== "." && t !== "..";
}

export interface AzureCredentials {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export type AzureFetch = typeof fetchSameOriginOnly;

/** `gap`: the credential is refused (a stated gap); `retry`: transient (network, 429, 5xx). */
export type AzureTokenResult =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "gap"; readonly reason: string }
  | { readonly kind: "retry" };

export const AZURE_TOKEN_GAPS = {
  tenant: "the stored Azure tenant id is not a tenant id or a domain name",
  refused:
    "Azure refused the stored service principal (check azure.tenant_id, azure.client_id and azure.client_secret)",
} as const;

/** The vaulted service principal through a sync's shared-credential grant; null unless all three are present. */
export async function azureCredentialsFor(ctx: SyncContext): Promise<AzureCredentials | null> {
  const tenantId = (await ctx.getSharedSecret("azure", "tenant_id"))?.trim() ?? "";
  const clientId = (await ctx.getSharedSecret("azure", "client_id"))?.trim() ?? "";
  const clientSecret = (await ctx.getSharedSecret("azure", "client_secret"))?.trim() ?? "";
  return tenantId === "" || clientId === "" || clientSecret === ""
    ? null
    : { tenantId, clientId, clientSecret };
}

/** The configured check for the Azure cost companions: all three service-principal fields are in the Vault. */
export async function hasAzureCredentials(vault: NimbusVault): Promise<boolean> {
  for (const k of ["tenant_id", "client_id", "client_secret"] as const) {
    if (((await readConnectorSecret(vault, "azure", k))?.trim() ?? "") === "") return false;
  }
  return true;
}

/** One token request. Never throws and never puts the secret or the response body into a reason. */
export async function requestAzureToken(
  creds: AzureCredentials,
  scope: AzureScope,
  fetchFn: AzureFetch = fetchSameOriginOnly,
): Promise<AzureTokenResult> {
  if (!isValidAzureTenant(creds.tenantId)) return { kind: "gap", reason: AZURE_TOKEN_GAPS.tenant };
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope,
  });
  let res: Response;
  try {
    res = await fetchFn(`${AZURE_LOGIN_HOST}/${creds.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(AZURE_TOKEN_TIMEOUT_MS),
    });
  } catch {
    return { kind: "retry" };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "gap", reason: AZURE_TOKEN_GAPS.refused };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "retry" };
  }
  try {
    const rec = (await res.json()) as unknown;
    const tok =
      typeof rec === "object" && rec !== null
        ? (rec as Record<string, unknown>)["access_token"]
        : undefined;
    return typeof tok === "string" && tok !== ""
      ? { kind: "token", token: tok }
      : { kind: "retry" };
  } catch {
    return { kind: "retry" };
  }
}

/** Tokens for ONE sync run: each scope is requested once, and a refused one is remembered for the run. */
export interface AzureTokenSource {
  get(scope: AzureScope): Promise<AzureTokenResult>;
  /** Drops the held token (it expired mid-run) and requests a new one. */
  refresh(scope: AzureScope): Promise<AzureTokenResult>;
}

export function createAzureTokenSource(
  creds: AzureCredentials,
  fetchFn: AzureFetch = fetchSameOriginOnly,
): AzureTokenSource {
  const held = new Map<AzureScope, Promise<AzureTokenResult>>();
  return {
    get(scope) {
      let p = held.get(scope);
      if (p === undefined) {
        p = requestAzureToken(creds, scope, fetchFn);
        held.set(scope, p);
      }
      return p;
    },
    refresh(scope) {
      held.delete(scope);
      return this.get(scope);
    },
  };
}
