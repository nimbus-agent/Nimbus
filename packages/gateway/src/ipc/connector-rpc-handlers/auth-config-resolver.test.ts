/**
 * auth-config-resolver.test.ts
 *
 * The PRODUCTION client-config resolver: `oauthClientConfigForProvider`, which reads the
 * `NIMBUS_OAUTH_*` values `Config` snapshotted at load, and `handleConnectorAuth`'s use of it when
 * no resolver is injected.
 *
 * `auth.test.ts` and `auth-oauth-pkce.test.ts` inject the resolver, so neither depends on the
 * machine's environment — and neither can see what the real resolver hands on. Here the values are
 * set on `Config` itself (it is a plain object; `config.ts` reads the environment once, at import),
 * saved before each test and restored after, so every arm runs on every machine: a CI runner has no
 * `NIMBUS_OAUTH_*` set at all, so google's configured-secret arm was otherwise never reached.
 *
 * The PKCE flow is injected through the `runPkceFlow` seam, so nothing binds a callback port, opens
 * a browser or reaches a provider.
 *
 * Rules: no `mock.module`; no `any`; real SQLite (migrated template) + mock vault.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openSeededInMemoryDb } from "../../../test/helpers/migrated-db-seed.ts";
import {
  GOOGLE_OAUTH_CLIENT_ID_HELP,
  MICROSOFT_OAUTH_CLIENT_ID_HELP,
} from "../../auth/oauth-env-help-messages.ts";
import type { PKCEOptions, PKCEResult } from "../../auth/pkce.ts";
import { Config } from "../../config.ts";
import { oauthProfileForService } from "../../connectors/connector-catalog.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import { handleConnectorAuth, oauthClientConfigForProvider } from "./auth.ts";
import type { ConnectorRpcHandlerContext } from "./context.ts";

/** The `Config` fields these tests set; `Config` is `as const`, so the cast is what allows a write. */
type OAuthConfigFields = {
  oauthGoogleClientId: string;
  oauthGoogleClientSecret: string;
  oauthMicrosoftClientId: string;
};
const mutableConfig = Config as unknown as OAuthConfigFields;

let saved: OAuthConfigFields;
let db: Database;
let localIndex: LocalIndex;
let vault: NimbusVault;

beforeEach(() => {
  saved = {
    oauthGoogleClientId: mutableConfig.oauthGoogleClientId,
    oauthGoogleClientSecret: mutableConfig.oauthGoogleClientSecret,
    oauthMicrosoftClientId: mutableConfig.oauthMicrosoftClientId,
  };
  db = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
  localIndex = new LocalIndex(db);
  vault = createMockVault();
});

afterEach(() => {
  mutableConfig.oauthGoogleClientId = saved.oauthGoogleClientId;
  mutableConfig.oauthGoogleClientSecret = saved.oauthGoogleClientSecret;
  mutableConfig.oauthMicrosoftClientId = saved.oauthMicrosoftClientId;
  db.close();
});

const TOKENS: PKCEResult = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 1_900_000_000_000,
  scopes: ["granted.read"],
};

/** A stand-in PKCE flow that records what it was handed. */
function recordingFlow(): {
  readonly calls: PKCEOptions[];
  readonly run: (options: PKCEOptions) => Promise<PKCEResult>;
} {
  const calls: PKCEOptions[] = [];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      return TOKENS;
    },
  };
}

/** A context with NO `resolveOAuthClientConfig`, so `handleConnectorAuth` uses the real one. */
function defaultResolverCtx(
  service: string,
  runPkceFlow: (options: PKCEOptions) => Promise<PKCEResult>,
): ConnectorRpcHandlerContext {
  return {
    rec: { service },
    vault,
    localIndex,
    openUrl: async () => {
      throw new Error("openUrl must not run — the PKCE flow is injected");
    },
    syncScheduler: undefined,
    connectorMesh: undefined,
    runPkceFlow,
  };
}

describe("oauthClientConfigForProvider — google's optional client secret", () => {
  test("a configured secret is carried, beside the configured client id", () => {
    mutableConfig.oauthGoogleClientId = "google-client-id";
    mutableConfig.oauthGoogleClientSecret = "google-client-secret";
    expect(oauthClientConfigForProvider(oauthProfileForService("google_drive"))).toEqual({
      clientId: "google-client-id",
      emptyClientIdMessage: GOOGLE_OAUTH_CLIENT_ID_HELP,
      clientSecret: "google-client-secret",
    });
  });

  test("an empty secret is left out, not carried as an empty string", () => {
    mutableConfig.oauthGoogleClientId = "google-client-id";
    mutableConfig.oauthGoogleClientSecret = "";
    const config = oauthClientConfigForProvider(oauthProfileForService("gmail"));
    expect(config).toEqual({
      clientId: "google-client-id",
      emptyClientIdMessage: GOOGLE_OAUTH_CLIENT_ID_HELP,
    });
    expect("clientSecret" in config).toBe(false);
  });

  test("microsoft never carries a secret, whatever google's is", () => {
    mutableConfig.oauthMicrosoftClientId = "ms-client-id";
    mutableConfig.oauthGoogleClientSecret = "google-client-secret";
    expect(oauthClientConfigForProvider(oauthProfileForService("onedrive"))).toEqual({
      clientId: "ms-client-id",
      emptyClientIdMessage: MICROSOFT_OAUTH_CLIENT_ID_HELP,
    });
  });
});

describe("handleConnectorAuth — with no resolver injected, Config decides", () => {
  test("google's configured id AND secret reach the PKCE flow", async () => {
    mutableConfig.oauthGoogleClientId = "google-client-id";
    mutableConfig.oauthGoogleClientSecret = "google-client-secret";
    const flow = recordingFlow();
    const out = await handleConnectorAuth(defaultResolverCtx("google_drive", flow.run));
    expect(out.value).toMatchObject({ ok: true, serviceId: "google_drive", verified: "verified" });
    expect(flow.calls).toHaveLength(1);
    expect(flow.calls[0]?.provider).toBe("google");
    expect(flow.calls[0]?.clientId).toBe("google-client-id");
    expect(flow.calls[0]?.oauthClientSecret).toBe("google-client-secret");
  });

  test("an empty google secret is not sent — the flow runs as a public PKCE client", async () => {
    mutableConfig.oauthGoogleClientId = "google-client-id";
    mutableConfig.oauthGoogleClientSecret = "";
    const flow = recordingFlow();
    await handleConnectorAuth(defaultResolverCtx("gmail", flow.run));
    expect(flow.calls[0]?.clientId).toBe("google-client-id");
    expect("oauthClientSecret" in (flow.calls[0] as PKCEOptions)).toBe(false);
  });

  test("an empty client id refuses with the provider's own help, before any flow runs", async () => {
    for (const [service, idField, help] of [
      ["google_drive", "oauthGoogleClientId", GOOGLE_OAUTH_CLIENT_ID_HELP],
      ["outlook", "oauthMicrosoftClientId", MICROSOFT_OAUTH_CLIENT_ID_HELP],
    ] as const) {
      mutableConfig[idField] = "";
      const flow = recordingFlow();
      let thrown: unknown;
      try {
        await handleConnectorAuth(defaultResolverCtx(service, flow.run));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConnectorRpcError);
      expect((thrown as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((thrown as ConnectorRpcError).message).toBe(help);
      expect(flow.calls).toEqual([]);
      expect(await vault.listKeys()).toEqual([]);
    }
  });
});
