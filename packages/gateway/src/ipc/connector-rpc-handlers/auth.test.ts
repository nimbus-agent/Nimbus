/**
 * auth.test.ts — colocated coverage for connector-rpc-handlers/auth.ts.
 *
 * Focus: the OAuth-PKCE provider-config switch (`oauthClientConfigForProvider`, reached only via
 * `handleConnectorAuth` → `connectorAuthOAuthPkce`). Each OAuth provider's switch arm is exercised by
 * driving an auth for a service that maps to it; with NO OAuth client id configured, the flow fails
 * closed at the empty-client-id guard (BEFORE any network/PKCE), so the test never touches the real
 * OAuth flow.
 *
 * Determinism: `Config` reads `NIMBUS_OAUTH_*_CLIENT_ID` from `process.env` at module-load. To stay
 * hermetic on a dev box that has some ids configured, we blank those env vars BEFORE importing the
 * modules (so the cached `Config` snapshot sees empty ids), then load `auth.ts`/`config.ts` lazily.
 *
 * NOTE (uncovered, deliberately): the PKCE success block (sharedKey mirror + token persistence) and
 * the `oauthScopesFromConnectorRequest`/`oauthRedirectPortFromRec` request-driven branches live AFTER
 * `runPKCEFlow`, which performs a real OAuth round-trip (network + a local redirect listener). There
 * is no DI seam to inject `runPKCEFlow`/`Config` into `handleConnectorAuth`, so those lines are not
 * reachable from a hermetic unit test without `mock.module` (which this suite avoids).
 *
 * Rules: no `any` (cast through `unknown`); no `mock.module`; real in-memory SQLite + mock vault.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

// Blank every OAuth client-id / secret env var BEFORE the dynamic imports below read them. This makes
// the empty-client-id guard fire deterministically regardless of the developer's local env. The
// original values are captured so they can be restored after the suite — otherwise the mutation would
// leak into unrelated tests sharing the worker and cause order-dependent failures.
const oauthEnvBackup = new Map<string, string | undefined>();
for (const k of Object.keys(process.env)) {
  if (k.startsWith("NIMBUS_OAUTH_") && (k.endsWith("_CLIENT_ID") || k.endsWith("_CLIENT_SECRET"))) {
    oauthEnvBackup.set(k, process.env[k]);
    process.env[k] = "";
  }
}

const { LocalIndex } = await import("../../index/local-index.ts");
const { createMockVault } = await import("../../vault/mock.ts");
const { ConnectorRpcError } = await import("../connector-rpc-shared.ts");
const { handleConnectorAuth } = await import("./auth.ts");

afterAll(() => {
  for (const [k, v] of oauthEnvBackup) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type NimbusVault = import("../../vault/nimbus-vault.ts").NimbusVault;
type LocalIndexT = import("../../index/local-index.ts").LocalIndex;
type ConnectorRpcHandlerContext = import("./context.ts").ConnectorRpcHandlerContext;

let db: Database;
let localIndex: LocalIndexT;
let vault: NimbusVault;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
  vault = createMockVault();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

function ctxFor(service: string): ConnectorRpcHandlerContext {
  return {
    rec: { service },
    vault,
    localIndex,
    openUrl: async () => {},
    syncScheduler: undefined,
    connectorMesh: undefined,
  };
}

describe("handleConnectorAuth — OAuth provider config switch arms", () => {
  // Each service routes to a distinct OAuth provider arm in oauthClientConfigForProvider; with no
  // client id configured, connectorAuthOAuthPkce throws the provider-specific empty-client-id help.
  const oauthServices = [
    "google_drive", // google
    "onedrive", // microsoft
    "slack", // slack
    "notion", // notion
    "zoom", // zoom
    "hubspot", // hubspot
    "miro", // miro
    "canva", // canva
    "figma", // figma
    "salesforce", // salesforce
    "mendeley", // mendeley
  ] as const;

  for (const service of oauthServices) {
    test(`${service} reaches its provider arm and fails closed on the empty client id`, async () => {
      let caught: unknown;
      try {
        await handleConnectorAuth(ctxFor(service));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConnectorRpcError);
      expect((caught as InstanceType<typeof ConnectorRpcError>).rpcCode).toBe(-32602);
    });
  }
});

describe("handleConnectorAuth — PAT handler routing", () => {
  test("an unknown / invalid service id is rejected by parseServiceArg", async () => {
    let caught: unknown;
    try {
      await handleConnectorAuth(ctxFor("not-a-real-service"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConnectorRpcError);
  });

  test("a PAT-backed service (github) routes to its PAT handler (missing token → -32602)", async () => {
    let caught: unknown;
    try {
      await handleConnectorAuth(ctxFor("github"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConnectorRpcError);
    expect((caught as InstanceType<typeof ConnectorRpcError>).rpcCode).toBe(-32602);
  });

  test("a PAT-backed service (github) with a token succeeds and registers the scheduler", async () => {
    const out = await handleConnectorAuth({
      ...ctxFor("github"),
      rec: { service: "github", personalAccessToken: "ghp_test_token" },
    });
    expect(out.kind).toBe("hit");
    expect((out.value as { ok: boolean; serviceId: string }).ok).toBe(true);
    expect((out.value as { serviceId: string }).serviceId).toBe("github");
  });
});
