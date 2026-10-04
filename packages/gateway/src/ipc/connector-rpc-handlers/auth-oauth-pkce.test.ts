/**
 * auth-oauth-pkce.test.ts
 *
 * The half of `connectorAuthOAuthPkce` that runs AFTER its fail-closed guards: the exact options it
 * hands the PKCE flow (scopes, redirect port, client secret) and what it does once the flow
 * returns (mirror the shared Google/Microsoft token to the service's own key, register the
 * scheduler, report the GRANTED scopes as verified).
 *
 * `auth.test.ts` proves the guards with an injected client-config resolver and keeps
 * `runPKCEFlow` unreachable. This file injects the flow itself through the `runPkceFlow` seam, so
 * none of these tests binds a callback port, opens a browser or reaches a provider — and none
 * depends on the machine's `NIMBUS_OAUTH_*` environment, because the client config is injected too.
 *
 * Rules: no `mock.module`; no `any`; real SQLite (migrated template) + mock vault.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openSeededInMemoryDb } from "../../../test/helpers/migrated-db-seed.ts";
import type { PKCEOptions, PKCEResult } from "../../auth/pkce.ts";
import {
  type ConnectorOAuthProfile,
  type ConnectorServiceId,
  defaultSyncIntervalMsForService,
  oauthProfileForService,
} from "../../connectors/connector-catalog.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import { handleConnectorAuth, oauthClientConfigForProvider } from "./auth.ts";
import type { ConnectorRpcHandlerContext, OAuthClientConfig } from "./context.ts";

let db: Database;
let localIndex: LocalIndex;
let vault: NimbusVault;

beforeEach(() => {
  db = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
  localIndex = new LocalIndex(db);
  vault = createMockVault();
});

afterEach(() => {
  db.close();
});

const TOKENS: PKCEResult = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 1_900_000_000_000,
  // Deliberately NOT the requested set: a provider may grant less than was asked, and the handler
  // must report what was granted.
  scopes: ["granted.read"],
};

/**
 * A stand-in for `runPKCEFlow` that records the options it was handed and, like the real flow,
 * persists the tokens under the provider's SHARED Vault key before returning.
 */
function fakeFlow(sharedKey: string | undefined): {
  readonly calls: PKCEOptions[];
  readonly run: (options: PKCEOptions) => Promise<PKCEResult>;
} {
  const calls: PKCEOptions[] = [];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      if (sharedKey !== undefined) await options.vault.set(sharedKey, JSON.stringify(TOKENS));
      return TOKENS;
    },
  };
}

function ctxFor(
  rec: Record<string, unknown>,
  config: OAuthClientConfig,
  runPkceFlow: (options: PKCEOptions) => Promise<PKCEResult>,
): ConnectorRpcHandlerContext {
  return {
    rec,
    vault,
    localIndex,
    openUrl: async () => {
      throw new Error("openUrl must not run — the PKCE flow is injected");
    },
    syncScheduler: undefined,
    connectorMesh: undefined,
    resolveOAuthClientConfig: () => config,
    runPkceFlow,
  };
}

const CONFIG: OAuthClientConfig = { clientId: "client-123", emptyClientIdMessage: "unused" };

function registeredIntervalMs(serviceId: ConnectorServiceId): number | undefined {
  return localIndex.persistedConnectorStatuses(serviceId)[0]?.intervalMs;
}

/**
 * Every key in the Vault, in code-unit order. `listKeys()` sorts with `localeCompare`, whose order
 * for `.` against `_` is the ICU locale's business, not this test's.
 */
async function storedKeys(): Promise<string[]> {
  return [...(await vault.listKeys())].sort();
}

describe("connectorAuthOAuthPkce — after the guards pass", () => {
  test("google: the shared token is mirrored to the service's own key, and the run is registered", async () => {
    const flow = fakeFlow("google.oauth");
    const out = await handleConnectorAuth(ctxFor({ service: "google_drive" }, CONFIG, flow.run));

    expect(out).toEqual({
      kind: "hit",
      value: {
        ok: true,
        serviceId: "google_drive",
        scopesGranted: ["granted.read"],
        verified: "verified",
      },
    });
    expect(await vault.get("google_drive.oauth")).toBe(JSON.stringify(TOKENS));
    // Exactly the flow's own write plus the one mirror — no other service's key was touched.
    expect(await storedKeys()).toEqual(["google.oauth", "google_drive.oauth"]);
    expect(registeredIntervalMs("google_drive")).toBe(
      defaultSyncIntervalMsForService("google_drive"),
    );

    // The flow got the provider, the client id and the profile's default scopes — and no secret
    // or port, because none was configured or requested.
    expect(flow.calls).toHaveLength(1);
    const options = flow.calls[0] as PKCEOptions;
    expect(options.provider).toBe("google");
    expect(options.clientId).toBe("client-123");
    expect(options.scopes).toEqual([...oauthProfileForService("google_drive").defaultScopes]);
    expect(options.vault).toBe(vault);
    expect("oauthClientSecret" in options).toBe(false);
    expect("redirectPort" in options).toBe(false);
  });

  test("microsoft: the shared Microsoft token is mirrored to onedrive's own key", async () => {
    const flow = fakeFlow("microsoft.oauth");
    await handleConnectorAuth(ctxFor({ service: "onedrive" }, CONFIG, flow.run));
    expect(flow.calls[0]?.provider).toBe("microsoft");
    expect(await vault.get("onedrive.oauth")).toBe(JSON.stringify(TOKENS));
    expect(await storedKeys()).toEqual(["microsoft.oauth", "onedrive.oauth"]);
  });

  test("a provider with no shared key (slack) mirrors nothing but still registers", async () => {
    const flow = fakeFlow("slack.oauth");
    const out = await handleConnectorAuth(ctxFor({ service: "slack" }, CONFIG, flow.run));
    expect(out.value).toMatchObject({ serviceId: "slack", verified: "verified" });
    // The whole Vault, not a guess at which keys a stray mirror might write: only the flow's own.
    expect(await storedKeys()).toEqual(["slack.oauth"]);
    expect(registeredIntervalMs("slack")).toBe(defaultSyncIntervalMsForService("slack"));
  });

  test("requested scopes are trimmed, blanks and non-strings dropped", async () => {
    const flow = fakeFlow(undefined);
    await handleConnectorAuth(
      ctxFor(
        { service: "google_drive", scopes: ["  drive.metadata  ", "", "   ", 42, null, "openid"] },
        CONFIG,
        flow.run,
      ),
    );
    expect(flow.calls[0]?.scopes).toEqual(["drive.metadata", "openid"]);
  });

  test("a scopes param that is not an array, or names nothing usable, falls back to the defaults", async () => {
    const defaults = [...oauthProfileForService("google_drive").defaultScopes];
    for (const scopes of ["drive.metadata", ["", "  ", 7]]) {
      const flow = fakeFlow(undefined);
      await handleConnectorAuth(ctxFor({ service: "google_drive", scopes }, CONFIG, flow.run));
      expect(flow.calls[0]?.scopes).toEqual(defaults);
    }
  });

  test("a valid integer port is forwarded as the redirect port", async () => {
    const flow = fakeFlow(undefined);
    await handleConnectorAuth(ctxFor({ service: "google_drive", port: 53_682 }, CONFIG, flow.run));
    expect(flow.calls[0]?.redirectPort).toBe(53_682);
  });

  test("an out-of-range, fractional or non-numeric port is not forwarded", async () => {
    for (const port of [0, -1, 65_536, 1.5, "8080", Number.NaN]) {
      const flow = fakeFlow(undefined);
      await handleConnectorAuth(ctxFor({ service: "google_drive", port }, CONFIG, flow.run));
      expect("redirectPort" in (flow.calls[0] as PKCEOptions)).toBe(false);
    }
    // The bounds themselves are valid ports.
    for (const port of [1, 65_535]) {
      const flow = fakeFlow(undefined);
      await handleConnectorAuth(ctxFor({ service: "google_drive", port }, CONFIG, flow.run));
      expect(flow.calls[0]?.redirectPort).toBe(port);
    }
  });

  test("a configured client secret is handed to the flow; an empty one is not", async () => {
    const withSecret = fakeFlow(undefined);
    await handleConnectorAuth(
      ctxFor({ service: "notion" }, { ...CONFIG, clientSecret: "s3cret" }, withSecret.run),
    );
    expect(withSecret.calls[0]?.oauthClientSecret).toBe("s3cret");

    // google's secret is optional, so an empty one passes the guard — and must not be sent.
    const emptySecret = fakeFlow(undefined);
    await handleConnectorAuth(
      ctxFor({ service: "google_drive" }, { ...CONFIG, clientSecret: "" }, emptySecret.run),
    );
    expect("oauthClientSecret" in (emptySecret.calls[0] as PKCEOptions)).toBe(false);
  });

  test("a flow failure propagates as itself and registers nothing", async () => {
    const boom = new Error("OAuth authorization did not complete: access_denied");
    const ctx = ctxFor({ service: "google_drive" }, CONFIG, () => Promise.reject(boom));
    let thrown: unknown;
    try {
      await handleConnectorAuth(ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(boom);
    expect(registeredIntervalMs("google_drive")).toBeUndefined();
    expect(await storedKeys()).toEqual([]);
  });
});

describe("connectorAuthOAuthPkce — the required-secret guard's fallback message", () => {
  test("a required secret with no help text configured names the provider", async () => {
    const flow = fakeFlow(undefined);
    let thrown: unknown;
    try {
      // notion's secret is REQUIRED; this config has neither a secret nor a help message.
      await handleConnectorAuth(ctxFor({ service: "notion" }, CONFIG, flow.run));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConnectorRpcError);
    expect((thrown as ConnectorRpcError).rpcCode).toBe(-32602);
    expect((thrown as ConnectorRpcError).message).toBe("Missing OAuth client secret for notion");
    expect(flow.calls).toEqual([]);
  });
});

describe("oauthClientConfigForProvider — the exhaustive switch's default arm", () => {
  test("a provider outside the union at runtime is refused, not mapped to some arm", () => {
    // Unreachable through the type system; reachable from a stale or hand-edited profile.
    const stale = { provider: "myspace", defaultScopes: [] } as unknown as ConnectorOAuthProfile;
    let thrown: unknown;
    try {
      oauthClientConfigForProvider(stale);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConnectorRpcError);
    expect((thrown as ConnectorRpcError).rpcCode).toBe(-32602);
    expect((thrown as ConnectorRpcError).message).toBe("Unsupported OAuth provider: myspace");
  });
});
