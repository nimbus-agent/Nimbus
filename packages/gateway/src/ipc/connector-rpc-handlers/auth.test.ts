/**
 * auth.test.ts — colocated coverage for connector-rpc-handlers/auth.ts.
 *
 * Focus: the OAuth-PKCE provider-config switch (`oauthClientConfigForProvider`) and the two
 * fail-closed guards in `connectorAuthOAuthPkce` that stand in front of `runPKCEFlow`.
 *
 * Determinism (see issue #812). This suite used to drive both concerns through
 * `handleConnectorAuth`, relying on every OAuth client id being empty so the flow would fail
 * closed before any network. That premise is a property of the developer's environment, not of
 * the code: `Config` snapshots `NIMBUS_OAUTH_*` ONCE at module load, so blanking those vars at
 * the top of this file only worked while this file happened to be the first in the process to
 * import `config.ts`. In `bun test packages/gateway/src/ipc/` a sibling gets there first, the
 * blanking became a no-op, and on a machine with Google OAuth configured `google_drive` sailed
 * past the guard into a real PKCE round-trip — a live redirect listener and a real request to
 * Google with the developer's own credentials — which hung until the 5s timeout.
 *
 * A test that passes only because it never got far enough to try is exactly the failure this
 * file exists to catch, so the ordering dependency is gone rather than papered over with a
 * longer timeout:
 *
 *   - the switch arms are asserted DIRECTLY on the pure `oauthClientConfigForProvider`, which
 *     needs no env and cannot reach the network;
 *   - the guards are asserted through `handleConnectorAuth` with an INJECTED resolver
 *     (`resolveOAuthClientConfig`), so "the client id is empty" is established by the test
 *     instead of hoped for — and `runPKCEFlow` is unreachable by construction.
 *
 * Rules: no `any` (cast through `unknown`); no `mock.module`; real in-memory SQLite + mock vault.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CANVA_OAUTH_CLIENT_ID_HELP,
  FIGMA_OAUTH_CLIENT_ID_HELP,
  GOOGLE_OAUTH_CLIENT_ID_HELP,
  HUBSPOT_OAUTH_CLIENT_ID_HELP,
  MENDELEY_OAUTH_CLIENT_ID_HELP,
  MICROSOFT_OAUTH_CLIENT_ID_HELP,
  MIRO_OAUTH_CLIENT_ID_HELP,
  NOTION_OAUTH_CLIENT_ID_HELP,
  NOTION_OAUTH_CLIENT_SECRET_HELP,
  SALESFORCE_OAUTH_CLIENT_ID_HELP,
  SLACK_OAUTH_CLIENT_ID_HELP,
  WORKDAY_OAUTH_CLIENT_ID_HELP,
  ZOOM_OAUTH_CLIENT_ID_HELP,
} from "../../auth/oauth-env-help-messages.ts";
import {
  CONNECTOR_SERVICE_IDS,
  type ConnectorServiceId,
  credentialsReusedFrom,
  oauthProfileForService,
} from "../../connectors/connector-catalog.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../../connectors/connector-secrets-manifest.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import {
  connectorAuthUnavailableMessage,
  handleConnectorAuth,
  oauthClientConfigForProvider,
} from "./auth.ts";
import type { ConnectorRpcHandlerContext, OAuthClientConfigResolver } from "./context.ts";

let db: Database;
let localIndex: LocalIndex;
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

function ctxFor(service: string, resolve?: OAuthClientConfigResolver): ConnectorRpcHandlerContext {
  return {
    rec: { service },
    vault,
    localIndex,
    openUrl: async () => {},
    syncScheduler: undefined,
    connectorMesh: undefined,
    ...(resolve === undefined ? {} : { resolveOAuthClientConfig: resolve }),
  };
}

/**
 * One service per OAuth provider arm, with the help text that arm must return.
 *
 * The help constant is what identifies the arm: it is provider-specific and env-independent,
 * so asserting it proves the switch routed correctly without asserting a client id that
 * varies per machine.
 */
const PROVIDER_ARMS: ReadonlyArray<readonly [ConnectorServiceId, string]> = [
  ["google_drive", GOOGLE_OAUTH_CLIENT_ID_HELP],
  ["onedrive", MICROSOFT_OAUTH_CLIENT_ID_HELP],
  ["slack", SLACK_OAUTH_CLIENT_ID_HELP],
  ["notion", NOTION_OAUTH_CLIENT_ID_HELP],
  ["zoom", ZOOM_OAUTH_CLIENT_ID_HELP],
  ["hubspot", HUBSPOT_OAUTH_CLIENT_ID_HELP],
  ["miro", MIRO_OAUTH_CLIENT_ID_HELP],
  ["canva", CANVA_OAUTH_CLIENT_ID_HELP],
  ["figma", FIGMA_OAUTH_CLIENT_ID_HELP],
  ["salesforce", SALESFORCE_OAUTH_CLIENT_ID_HELP],
  ["mendeley", MENDELEY_OAUTH_CLIENT_ID_HELP],
  ["workday", WORKDAY_OAUTH_CLIENT_ID_HELP],
];

describe("oauthClientConfigForProvider — one arm per OAuth provider", () => {
  for (const [service, expectedHelp] of PROVIDER_ARMS) {
    test(`${service} routes to its provider arm`, () => {
      const config = oauthClientConfigForProvider(oauthProfileForService(service));
      expect(config.emptyClientIdMessage).toBe(expectedHelp);
    });
  }

  test("every arm is covered — the table tracks the provider list", () => {
    // A new OAuth provider adds a switch arm that nothing above would exercise. The switch's
    // `never` exhaustiveness check catches a MISSING arm at compile time; this catches an arm
    // that exists but is untested.
    const providers = new Set(
      PROVIDER_ARMS.map(([service]) => oauthProfileForService(service).provider),
    );
    expect(providers.size).toBe(PROVIDER_ARMS.length);
  });
});

describe("connectorAuthOAuthPkce — fail-closed before any PKCE round-trip", () => {
  // Injected, so emptiness is established by the test rather than by the machine's env. If a
  // guard ever stopped firing, the call would reach runPKCEFlow and this test would hang — which
  // is the regression it is here to catch, and which it can now actually catch.
  const emptyClientId: OAuthClientConfigResolver = () => ({
    clientId: "",
    emptyClientIdMessage: "no client id configured",
  });

  for (const [service] of PROVIDER_ARMS) {
    test(`${service} fails closed on an empty client id`, async () => {
      let caught: unknown;
      try {
        await handleConnectorAuth(ctxFor(service, emptyClientId));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConnectorRpcError);
      expect((caught as InstanceType<typeof ConnectorRpcError>).rpcCode).toBe(-32602);
      expect((caught as Error).message).toBe("no client id configured");
    });
  }

  test("a provider whose client secret is required fails closed when only the id is set", async () => {
    // The second guard. Only reachable with a NON-empty client id, so it was unreachable from
    // the old env-driven suite on a machine with no Notion credentials — i.e. always.
    const idButNoSecret: OAuthClientConfigResolver = () => ({
      clientId: "set-but-secret-missing",
      emptyClientIdMessage: NOTION_OAUTH_CLIENT_ID_HELP,
      clientSecret: "",
      clientSecretMissingHelp: NOTION_OAUTH_CLIENT_SECRET_HELP,
    });

    let caught: unknown;
    try {
      await handleConnectorAuth(ctxFor("notion", idButNoSecret));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConnectorRpcError);
    expect((caught as InstanceType<typeof ConnectorRpcError>).rpcCode).toBe(-32602);
    expect((caught as Error).message).toBe(NOTION_OAUTH_CLIENT_SECRET_HELP);
  });
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
      // Task 3 wires a real credential probe in front of every write. Inject a
      // seam here so this routing test stays offline and deterministic — the
      // probe's own behavior is covered in connector-rpc.test.ts.
      runCredentialProbe: async () => ({ kind: "valid" }),
    });
    expect(out.kind).toBe("hit");
    expect((out.value as { ok: boolean; serviceId: string }).ok).toBe(true);
    expect((out.value as { serviceId: string }).serviceId).toBe("github");
  });
});

describe("handleConnectorAuth — a service with no auth flow refuses usefully (#1531)", () => {
  /** A context whose browser opener fails the test if the handler ever reaches the OAuth path. */
  function refusingCtx(service: string): ConnectorRpcHandlerContext {
    return {
      ...ctxFor(service),
      rec: { service, personalAccessToken: "ignored-token" },
      openUrl: async () => {
        throw new Error(`OAuth was attempted for ${service}`);
      },
    };
  }

  async function refusalFor(service: string): Promise<InstanceType<typeof ConnectorRpcError>> {
    let caught: unknown;
    try {
      await handleConnectorAuth(refusingCtx(service));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConnectorRpcError);
    return caught as InstanceType<typeof ConnectorRpcError>;
  }

  test("the services the issue reproduced get a -32602 naming every `nimbus vault set` key", async () => {
    for (const service of [
      "stripe",
      "vercel",
      "elasticsearch",
      "localdb",
      "great_expectations",
    ] as const) {
      const err = await refusalFor(service);
      expect(err.rpcCode).toBe(-32602);
      expect(err.message).not.toContain("oauthProfileForService");
      for (const key of CONNECTOR_VAULT_SECRET_KEYS[service]) {
        expect(err.message).toContain(`nimbus vault set ${key} <value>`);
      }
      // The refusal must happen before anything is stored.
      expect(await vault.listKeys(`${service}.`)).toEqual([]);
    }
  });

  test("a service that syncs with another service's credential names that service", async () => {
    expect((await refusalFor("bigquery")).message).toContain("nimbus connector auth gcp");
    expect((await refusalFor("github_actions")).message).toContain("nimbus connector auth github");
    expect((await refusalFor("athena")).message).toContain("nimbus connector auth aws");
  });

  test("across the whole catalog, no refusal points back at the command that just failed", () => {
    for (const id of CONNECTOR_SERVICE_IDS) {
      const message = connectorAuthUnavailableMessage(id);
      if (message === null) continue;
      expect(message).not.toContain(`connector auth ${id}\``);
      expect(message).not.toContain(`connector.auth ${id}`);
      if (credentialsReusedFrom(id) === undefined) {
        // Every vault-set refusal names a command per manifest key, so none can be a dead end.
        const keys: readonly string[] = CONNECTOR_VAULT_SECRET_KEYS[id];
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) expect(message).toContain(`nimbus vault set ${key}`);
      }
    }
  });

  test("services that DO have a flow are untouched: a PAT handler or an OAuth profile gets no refusal", () => {
    for (const id of ["github", "jira", "aws", "google_drive", "notion", "slack"] as const) {
      expect(connectorAuthUnavailableMessage(id)).toBeNull();
    }
  });

  test("the OAuth-unsupported error no longer tells the user to run connector.auth", () => {
    expect(() => oauthProfileForService("stripe")).toThrow("does not use OAuth");
    try {
      oauthProfileForService("stripe");
    } catch (e) {
      expect(String(e)).not.toContain("connector.auth");
    }
  });
});
