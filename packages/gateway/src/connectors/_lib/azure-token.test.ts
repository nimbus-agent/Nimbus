import { describe, expect, test } from "bun:test";

import { createMockVault } from "../../vault/mock.ts";
import {
  AZURE_MANAGEMENT_SCOPE,
  AZURE_STORAGE_SCOPE,
  AZURE_TOKEN_GAPS,
  type AzureFetch,
  createAzureTokenSource,
  hasAzureCredentials,
  isValidAzureTenant,
  requestAzureToken,
} from "./azure-token.ts";

const TENANT = "11111111-2222-3333-4444-555555555555";
const creds = { tenantId: TENANT, clientId: "app-id", clientSecret: "s3cret-value" };

function fake(status: number, body: unknown = { access_token: "tok-1" }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as AzureFetch;
  return { fn, calls };
}

describe("azure token", () => {
  test("a client-credentials POST to the tenant's v2 endpoint; the secret is only in the form body", async () => {
    const f = fake(200);
    const r = await requestAzureToken(creds, AZURE_STORAGE_SCOPE, f.fn);
    expect(r).toEqual({ kind: "token", token: "tok-1" });
    const call = f.calls[0];
    expect(call?.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(call?.init.method).toBe("POST");
    const form = new URLSearchParams(String(call?.init.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe("app-id");
    expect(form.get("client_secret")).toBe("s3cret-value");
    expect(form.get("scope")).toBe("https://storage.azure.com/.default");
    expect(call?.url).not.toContain("s3cret");
    expect(JSON.stringify(call?.init.headers)).not.toContain("s3cret");
    expect(call?.init.signal).toBeDefined();
  });

  test("the management scope is the 12b variant", () => {
    expect(AZURE_MANAGEMENT_SCOPE).toBe("https://management.azure.com/.default");
  });

  test("tenant validation", () => {
    for (const t of [TENANT, "contoso.onmicrosoft.com"]) expect(isValidAzureTenant(t)).toBe(true);
    for (const t of ["", "..", ".", "a/b", "a?b", "a b", "a#b", "x@y"]) {
      expect(isValidAzureTenant(t)).toBe(false);
    }
  });

  test("an invalid tenant makes no request", async () => {
    const f = fake(200);
    const r = await requestAzureToken({ ...creds, tenantId: "a/../b" }, AZURE_STORAGE_SCOPE, f.fn);
    expect(r).toEqual({ kind: "gap", reason: AZURE_TOKEN_GAPS.tenant });
    expect(f.calls).toHaveLength(0);
  });

  test("400, 401 and 403 are a stated gap that never echoes the body", async () => {
    for (const s of [400, 401, 403]) {
      const r = await requestAzureToken(
        creds,
        AZURE_STORAGE_SCOPE,
        fake(s, "AADSTS7000215 s3cret-value").fn,
      );
      expect(r).toEqual({ kind: "gap", reason: AZURE_TOKEN_GAPS.refused });
    }
  });

  test("429, 5xx, a thrown fetch and a reply with no token are retries", async () => {
    expect(await requestAzureToken(creds, AZURE_STORAGE_SCOPE, fake(429).fn)).toEqual({
      kind: "retry",
    });
    expect(await requestAzureToken(creds, AZURE_STORAGE_SCOPE, fake(503).fn)).toEqual({
      kind: "retry",
    });
    expect(await requestAzureToken(creds, AZURE_STORAGE_SCOPE, fake(200, {}).fn)).toEqual({
      kind: "retry",
    });
    expect(await requestAzureToken(creds, AZURE_STORAGE_SCOPE, fake(200, "not json").fn)).toEqual({
      kind: "retry",
    });
    const boom = (async () => {
      throw new Error("redirected");
    }) as unknown as AzureFetch;
    expect(await requestAzureToken(creds, AZURE_STORAGE_SCOPE, boom)).toEqual({ kind: "retry" });
  });

  test("a token source asks once per scope for the run", async () => {
    const f = fake(200);
    const src = createAzureTokenSource(creds, f.fn);
    await src.get(AZURE_STORAGE_SCOPE);
    await src.get(AZURE_STORAGE_SCOPE);
    expect(f.calls).toHaveLength(1);
    await src.get(AZURE_MANAGEMENT_SCOPE);
    expect(f.calls).toHaveLength(2);
  });

  test("refresh drops the held token and asks again", async () => {
    const f = fake(200);
    const src = createAzureTokenSource(creds, f.fn);
    await src.get(AZURE_STORAGE_SCOPE);
    await src.refresh(AZURE_STORAGE_SCOPE);
    expect(f.calls).toHaveLength(2);
    await src.get(AZURE_STORAGE_SCOPE);
    expect(f.calls).toHaveLength(2);
  });

  test("hasAzureCredentials needs all three fields", async () => {
    const vault = createMockVault();
    expect(await hasAzureCredentials(vault)).toBe(false);
    await vault.set("azure.tenant_id", TENANT);
    await vault.set("azure.client_id", "a");
    expect(await hasAzureCredentials(vault)).toBe(false);
    await vault.set("azure.client_secret", " ");
    expect(await hasAzureCredentials(vault)).toBe(false);
    await vault.set("azure.client_secret", "s");
    expect(await hasAzureCredentials(vault)).toBe(true);
  });
});
