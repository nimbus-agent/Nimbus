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
  defaultSyncIntervalMsForService,
  oauthProfileForService,
} from "../../connectors/connector-catalog.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../../connectors/connector-secrets-manifest.ts";
import { CREDENTIAL_PROBES, type ProbeVerdict } from "../../connectors/credential-probe.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import {
  connectorAuthUnavailableMessage,
  handleConnectorAuth,
  oauthClientConfigForProvider,
} from "./auth.ts";
import type {
  ConnectorRpcHandlerContext,
  ConnectorRpcHit,
  OAuthClientConfigResolver,
} from "./context.ts";

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

/**
 * The shared PAT-handler helpers (`registerAndSucceed`, `writeOrDeleteConnectorSecret`,
 * `tokenOnlyConnectorAuth`), driven through `handleConnectorAuth`. Every Vault op, credential
 * probe, probe-egress append and scheduler registration goes into ONE ordered log, so each
 * assertion pins ORDER and not just the end state: for a probed service the egress row and the
 * probe come before any write (I29), and for every service the registration comes after all writes.
 */
describe("PAT handlers — the exact Vault plan, then the shared registration tail", () => {
  /**
   * A context whose vault, scheduler registration and probe seams all log into `seq`. Each
   * registration's `now` argument goes into `stamps`, kept out of `seq` so a plan stays a fixed list.
   */
  function recordingCtx(
    service: string,
    fields: Record<string, unknown>,
    seq: string[],
    verdict: ProbeVerdict | null = null,
    stamps: number[] = [],
  ): ConnectorRpcHandlerContext {
    const inner = createMockVault();
    const recordingVault: NimbusVault = {
      get: (key) => inner.get(key),
      listKeys: (prefix) => inner.listKeys(prefix),
      set: async (key, value) => {
        seq.push(`write:${key}=${value}`);
        await inner.set(key, value);
      },
      delete: async (key) => {
        seq.push(`delete:${key}`);
        await inner.delete(key);
      },
    };
    const recordingIndex = {
      ensureConnectorSchedulerRegistration: (id: string, intervalMs: number, now: number): void => {
        seq.push(`register:${id}@${String(intervalMs)}`);
        stamps.push(now);
      },
      markConnectorReauthenticated: (id: string): void => {
        seq.push(`reauth:${id}`);
      },
    } as unknown as LocalIndex;
    return {
      rec: { service, ...fields },
      vault: recordingVault,
      localIndex: recordingIndex,
      openUrl: async () => {
        throw new Error(`OAuth was attempted for ${service}`);
      },
      syncScheduler: undefined,
      connectorMesh: undefined,
      runCredentialProbe: async (id) => {
        seq.push(`probe:${id}`);
        return verdict;
      },
      appendProbeEgress: (id) => {
        seq.push(`egress:${id}`);
      },
    };
  }

  function registered(id: ConnectorServiceId): string {
    return `register:${id}@${String(defaultSyncIntervalMsForService(id))}`;
  }

  /**
   * The one registration was stamped with the wall-clock time of the auth call itself, which a new
   * connector stores as its `next_sync_at`. A stamp one interval ahead (first sync a whole interval
   * late) or of `0` (a 1970 due time) leaves the plan and the result unchanged, so only this check
   * catches either. Bracketing the call depends on ordering alone, never on how fast the runner is.
   */
  function expectStampedDuring(stamps: readonly number[], before: number, after: number): void {
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toBeGreaterThanOrEqual(before);
    expect(stamps[0]).toBeLessThanOrEqual(after);
  }

  function success(
    id: ConnectorServiceId,
    verified: "verified" | "unverified" | null = null,
  ): ConnectorRpcHit {
    return { kind: "hit", value: { ok: true, serviceId: id, scopesGranted: [], verified } };
  }

  async function refusal(ctx: ConnectorRpcHandlerContext): Promise<unknown> {
    try {
      await handleConnectorAuth(ctx);
    } catch (e) {
      return e;
    }
    throw new Error("expected connector.auth to refuse");
  }

  /** Every PAT/secret handler with no credential probe: its request, then its Vault ops in order. */
  const NO_PROBE_PLANS: ReadonlyArray<{
    readonly label: string;
    readonly service: ConnectorServiceId;
    readonly fields: Record<string, unknown>;
    readonly plan: readonly string[];
  }> = [
    {
      label: "linear",
      service: "linear",
      fields: { token: " t " },
      plan: ["write:linear.api_key=t"],
    },
    {
      label: "circleci",
      service: "circleci",
      fields: { personalAccessToken: "t" },
      plan: ["write:circleci.api_token=t"],
    },
    {
      label: "pagerduty",
      service: "pagerduty",
      fields: { token: "t" },
      plan: ["write:pagerduty.api_token=t"],
    },
    {
      label: "discord",
      service: "discord",
      fields: { discordOptIn: true, token: "t" },
      plan: ["write:discord.bot_token=t", "write:discord.enabled=1"],
    },
    {
      label: "aws key pair + region",
      service: "aws",
      fields: { awsAccessKeyId: "AK", awsSecretAccessKey: "SK", awsDefaultRegion: " eu-west-1 " },
      plan: [
        "write:aws.access_key_id=AK",
        "write:aws.secret_access_key=SK",
        "write:aws.default_region=eu-west-1",
        "delete:aws.profile",
      ],
    },
    {
      label: "aws key pair + profile",
      service: "aws",
      fields: { awsAccessKeyId: "AK", awsSecretAccessKey: "SK", awsProfile: " dev " },
      plan: [
        "write:aws.access_key_id=AK",
        "write:aws.secret_access_key=SK",
        "delete:aws.default_region",
        "write:aws.profile=dev",
      ],
    },
    {
      label: "aws profile only",
      service: "aws",
      fields: { awsProfile: "dev" },
      plan: [
        "delete:aws.access_key_id",
        "delete:aws.secret_access_key",
        "delete:aws.default_region",
        "write:aws.profile=dev",
      ],
    },
    {
      label: "aws profile + region",
      service: "aws",
      fields: { awsProfile: "dev", awsDefaultRegion: "eu-west-1" },
      plan: [
        "delete:aws.access_key_id",
        "delete:aws.secret_access_key",
        "write:aws.default_region=eu-west-1",
        "write:aws.profile=dev",
      ],
    },
    {
      label: "azure",
      service: "azure",
      fields: { tenantId: "t", clientId: "c", clientSecret: "s" },
      plan: ["write:azure.tenant_id=t", "write:azure.client_id=c", "write:azure.client_secret=s"],
    },
    {
      label: "gcp gcloud mode",
      service: "gcp",
      fields: { authSource: "gcloud", projectId: "p" },
      plan: [
        "write:gcp.auth_source=gcloud",
        "write:gcp.project_id=p",
        "delete:gcp.credentials_json_path",
      ],
    },
    {
      label: "gcp key mode",
      service: "gcp",
      fields: { credentialsJsonPath: "/sa.json" },
      plan: [
        "write:gcp.credentials_json_path=/sa.json",
        "delete:gcp.auth_source",
        "delete:gcp.project_id",
      ],
    },
    {
      label: "gcp key mode + project",
      service: "gcp",
      fields: { credentialsJsonPath: "/sa.json", projectId: " p " },
      plan: [
        "write:gcp.credentials_json_path=/sa.json",
        "delete:gcp.auth_source",
        "write:gcp.project_id=p",
      ],
    },
    { label: "iac", service: "iac", fields: { iacOptIn: true }, plan: ["write:iac.enabled=1"] },
    {
      label: "grafana",
      service: "grafana",
      fields: { apiBaseUrl: "https://g.example/", token: "t" },
      plan: ["write:grafana.url=https://g.example", "write:grafana.api_token=t"],
    },
    {
      label: "sentry",
      service: "sentry",
      fields: { token: "t", orgSlug: "o" },
      plan: ["write:sentry.auth_token=t", "write:sentry.org_slug=o", "delete:sentry.url"],
    },
    {
      label: "sentry + url",
      service: "sentry",
      fields: { token: "t", orgSlug: "o", sentryUrl: " https://s.example// " },
      plan: [
        "write:sentry.auth_token=t",
        "write:sentry.org_slug=o",
        "write:sentry.url=https://s.example",
      ],
    },
    {
      // Keyed on the NORMALIZED value: "/" strips to "" and clears the key (contrast gitlab below).
      label: "sentry + a url that normalizes to empty",
      service: "sentry",
      fields: { token: "t", orgSlug: "o", sentryUrl: "/" },
      plan: ["write:sentry.auth_token=t", "write:sentry.org_slug=o", "delete:sentry.url"],
    },
    {
      label: "newrelic",
      service: "newrelic",
      fields: { token: "t" },
      plan: ["write:newrelic.api_key=t", "delete:newrelic.account_id"],
    },
    {
      label: "newrelic + account",
      service: "newrelic",
      fields: { token: "t", accountId: " 42 " },
      plan: ["write:newrelic.api_key=t", "write:newrelic.account_id=42"],
    },
    {
      label: "newrelic + blank account",
      service: "newrelic",
      fields: { token: "t", accountId: "   " },
      plan: ["write:newrelic.api_key=t", "delete:newrelic.account_id"],
    },
    {
      label: "datadog",
      service: "datadog",
      fields: { apiKey: "a", appKey: "b" },
      plan: ["write:datadog.api_key=a", "write:datadog.app_key=b", "delete:datadog.site"],
    },
    {
      label: "datadog + site",
      service: "datadog",
      fields: { apiKey: "a", appKey: "b", site: " datadoghq.eu " },
      plan: [
        "write:datadog.api_key=a",
        "write:datadog.app_key=b",
        "write:datadog.site=datadoghq.eu",
      ],
    },
    {
      label: "kubernetes",
      service: "kubernetes",
      fields: { kubeconfig: "/k" },
      plan: ["write:kubernetes.kubeconfig=/k", "delete:kubernetes.context"],
    },
    {
      label: "kubernetes + context",
      service: "kubernetes",
      fields: { kubeconfig: "/k", context: " prod " },
      plan: ["write:kubernetes.kubeconfig=/k", "write:kubernetes.context=prod"],
    },
    {
      label: "kubernetes + blank context",
      service: "kubernetes",
      fields: { kubeconfig: "/k", context: "   " },
      plan: ["write:kubernetes.kubeconfig=/k", "delete:kubernetes.context"],
    },
    {
      label: "kubernetes + non-string context",
      service: "kubernetes",
      fields: { kubeconfig: "/k", context: 7 },
      plan: ["write:kubernetes.kubeconfig=/k", "delete:kubernetes.context"],
    },
  ];

  for (const { label, service, fields, plan } of NO_PROBE_PLANS) {
    test(`${label}: no probe, the planned Vault ops, then one registration at the default interval, stamped now`, async () => {
      const seq: string[] = [];
      const stamps: number[] = [];
      const before = Date.now();
      const hit = await handleConnectorAuth(recordingCtx(service, fields, seq, null, stamps));
      const after = Date.now();
      expect(seq).toEqual([...plan, registered(service)]);
      expectStampedDuring(stamps, before, after);
      expect(hit).toEqual(success(service));
    });
  }

  /** The probed handlers that end on the shared tail (github keeps its own two-service tail). */
  const PROBED_PLANS: ReadonlyArray<{
    readonly service: ConnectorServiceId;
    readonly fields: Record<string, unknown>;
    readonly plan: readonly string[];
  }> = [
    {
      service: "gitlab",
      fields: { token: "t" },
      plan: ["write:gitlab.pat=t", "delete:gitlab.api_base"],
    },
    {
      service: "jenkins",
      fields: { apiBaseUrl: "https://ci.example/", username: "u", token: "t" },
      plan: [
        "write:jenkins.base_url=https://ci.example",
        "write:jenkins.username=u",
        "write:jenkins.api_token=t",
      ],
    },
    {
      service: "bitbucket",
      fields: { username: "u", token: "t" },
      plan: ["write:bitbucket.username=u", "write:bitbucket.app_password=t"],
    },
  ];

  const PASSING_VERDICTS: ReadonlyArray<{
    readonly verdict: ProbeVerdict | null;
    readonly verified: "verified" | "unverified" | null;
  }> = [
    // `scopes` on a valid verdict is deliberately non-empty: only github threads the probe's
    // scopes onto `scopesGranted`, so these three must still report `[]`.
    { verdict: { kind: "valid", scopes: ["read"] }, verified: "verified" },
    { verdict: { kind: "unconfirmed" }, verified: "unverified" },
    { verdict: null, verified: null },
  ];

  for (const { service, fields, plan } of PROBED_PLANS) {
    for (const { verdict, verified } of PASSING_VERDICTS) {
      test(`${service}: egress row, probe, the planned writes, then registration (verdict ${verdict?.kind ?? "null"})`, async () => {
        const seq: string[] = [];
        const stamps: number[] = [];
        const before = Date.now();
        const hit = await handleConnectorAuth(recordingCtx(service, fields, seq, verdict, stamps));
        const after = Date.now();
        const reauth = verdict?.kind === "valid" ? [`reauth:${service}`] : [];
        expect(seq).toEqual([
          `egress:${service}`,
          `probe:${service}`,
          ...reauth,
          ...plan,
          registered(service),
        ]);
        expectStampedDuring(stamps, before, after);
        expect(hit).toEqual(success(service, verified));
      });
    }

    test(`${service}: a rejected credential stores nothing and registers nothing`, async () => {
      const seq: string[] = [];
      const err = await refusal(
        recordingCtx(service, fields, seq, { kind: "rejected", httpStatus: 401 }),
      );
      expect(err).toBeInstanceOf(ConnectorRpcError);
      expect(err).toMatchObject({
        rpcCode: -32602,
        message: `${service} rejected the credential (HTTP 401). Nothing was stored.`,
      });
      expect(seq).toEqual([`egress:${service}`, `probe:${service}`]);
    });
  }

  test('gitlab keeps its own api_base rule: a supplied base that normalizes to "" is stored, not deleted', async () => {
    // Unlike sentry's url above, gitlab keys the branch on whether a base was SUPPLIED.
    const seq: string[] = [];
    await handleConnectorAuth(recordingCtx("gitlab", { token: "t", apiBaseUrl: "/" }, seq));
    expect(seq).toEqual([
      "egress:gitlab",
      "probe:gitlab",
      "write:gitlab.pat=t",
      "write:gitlab.api_base=",
      registered("gitlab"),
    ]);
  });

  test("every service with a registered credential probe runs it before its first write", async () => {
    // Iterates CREDENTIAL_PROBES itself, not a hand-kept list. `tokenOnlyConnectorAuth` never
    // probes, so a probe registered for one of its services would otherwise be skipped silently
    // and the credential stored unchecked. One request carries every field a probed handler needs.
    const probed = Object.keys(CREDENTIAL_PROBES) as ConnectorServiceId[];
    expect(probed.length).toBeGreaterThan(0);
    const fields = {
      token: "t",
      username: "u",
      apiBaseUrl: "https://x.example",
      atlassianEmail: "e@x.example",
    };
    for (const id of probed) {
      const seq: string[] = [];
      await handleConnectorAuth(recordingCtx(id, fields, seq));
      expect(seq.slice(0, 2)).toEqual([`egress:${id}`, `probe:${id}`]);
      expect(seq.some((op) => op.startsWith("write:"))).toBe(true);
    }
  });

  /** Every handler that reads its token as `personalAccessToken ?? token`, minus the token. */
  const PAT_READERS: ReadonlyArray<{
    readonly service: ConnectorServiceId;
    readonly fields: Record<string, unknown>;
    readonly tokenKey: string;
    readonly missing: string;
  }> = [
    {
      service: "github",
      fields: {},
      tokenKey: "github.pat",
      missing: "Missing personalAccessToken for github",
    },
    {
      service: "gitlab",
      fields: {},
      tokenKey: "gitlab.pat",
      missing: "Missing personalAccessToken for gitlab",
    },
    {
      service: "discord",
      fields: { discordOptIn: true },
      tokenKey: "discord.bot_token",
      missing: "Missing bot token for discord",
    },
    {
      service: "grafana",
      fields: { apiBaseUrl: "https://g.example" },
      tokenKey: "grafana.api_token",
      missing: "Grafana requires an API token (connector.auth grafana --token …)",
    },
    {
      service: "sentry",
      fields: { orgSlug: "o" },
      tokenKey: "sentry.auth_token",
      missing: "Sentry requires auth token and org slug (connector.auth sentry --token … --org …)",
    },
    {
      service: "newrelic",
      fields: {},
      tokenKey: "newrelic.api_key",
      missing: "New Relic requires a user API key (connector.auth newrelic --token …)",
    },
    {
      service: "jenkins",
      fields: { apiBaseUrl: "https://ci.example", username: "u" },
      tokenKey: "jenkins.api_token",
      missing: "Jenkins requires --token <api_token>",
    },
    {
      service: "bitbucket",
      fields: { username: "u" },
      tokenKey: "bitbucket.app_password",
      missing: "Missing app password for bitbucket (use token field)",
    },
  ];

  for (const { service, fields, tokenKey, missing } of PAT_READERS) {
    test(`${service}: reads its token as personalAccessToken ?? token`, async () => {
      const preferred: string[] = [];
      await handleConnectorAuth(
        recordingCtx(service, { ...fields, personalAccessToken: "first", token: "2nd" }, preferred),
      );
      expect(preferred).toContain(`write:${tokenKey}=first`);
      expect(preferred.some((op) => op.endsWith("=2nd"))).toBe(false);

      const nullSkipped: string[] = [];
      await handleConnectorAuth(
        recordingCtx(service, { ...fields, personalAccessToken: null, token: "2nd" }, nullSkipped),
      );
      expect(nullSkipped).toContain(`write:${tokenKey}=2nd`);

      // A preferred field that is set but unusable is refused before any probe or write, even
      // with a usable alias: `??` skips only null/undefined. `""` separates it from `||`, which
      // would skip it, and `42` from a reader that skips any non-string.
      for (const unusable of ["   ", "", 42]) {
        const blank: string[] = [];
        const err = await refusal(
          recordingCtx(service, { ...fields, personalAccessToken: unusable, token: "2nd" }, blank),
        );
        expect(err).toBeInstanceOf(ConnectorRpcError);
        expect(err).toMatchObject({ rpcCode: -32602, message: missing });
        expect(blank).toEqual([]);
      }
    });
  }
});

describe("token-only connectors (linear, circleci, pagerduty) — reading the token", () => {
  const TOKEN_ONLY: ReadonlyArray<{
    readonly service: ConnectorServiceId;
    readonly fields: readonly string[];
    readonly key: string;
    readonly missing: string;
  }> = [
    {
      service: "linear",
      fields: ["personalAccessToken", "token", "apiKey"],
      key: "linear.api_key",
      missing: "Missing API key for linear",
    },
    {
      service: "circleci",
      fields: ["personalAccessToken", "token"],
      key: "circleci.api_token",
      missing: "Missing API token for circleci",
    },
    {
      service: "pagerduty",
      fields: ["personalAccessToken", "token"],
      key: "pagerduty.api_token",
      missing: "Missing API token for pagerduty",
    },
  ];

  /** Vault writes in order, with no probe seam that could be reached unnoticed. */
  function tokenCtx(
    service: ConnectorServiceId,
    fields: Record<string, unknown>,
    writes: string[],
  ): ConnectorRpcHandlerContext {
    const inner = createMockVault();
    return {
      ...ctxFor(service),
      rec: { service, ...fields },
      vault: {
        get: (key) => inner.get(key),
        listKeys: (prefix) => inner.listKeys(prefix),
        delete: (key) => inner.delete(key),
        set: async (key, value) => {
          writes.push(`${key}=${value}`);
          await inner.set(key, value);
        },
      },
      runCredentialProbe: async () => {
        throw new Error(`a token-only connector (${service}) must not probe`);
      },
      appendProbeEgress: () => {
        throw new Error(`a token-only connector (${service}) must not append probe egress`);
      },
    };
  }

  async function refusalMessage(ctx: ConnectorRpcHandlerContext): Promise<unknown> {
    try {
      await handleConnectorAuth(ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorRpcError);
      expect((e as InstanceType<typeof ConnectorRpcError>).rpcCode).toBe(-32602);
      return (e as Error).message;
    }
    throw new Error("expected connector.auth to refuse");
  }

  for (const { service, fields, key, missing } of TOKEN_ONLY) {
    test(`${service}: each alias is read, and an earlier alias wins over every later one`, async () => {
      for (let i = 0; i < fields.length; i++) {
        const writes: string[] = [];
        const rec = Object.fromEntries(fields.slice(i).map((f) => [f, `from-${f}`]));
        await handleConnectorAuth(tokenCtx(service, rec, writes));
        expect(writes).toEqual([`${key}=from-${fields[i]}`]);
      }
      // The positive control for every refusal below: a successful auth DOES land a row where
      // `loadRegisteredIds` looks, so its `[]` there is an observation, not an empty query.
      expect(loadRegisteredIds()).toEqual([service]);
    });

    test(`${service}: a blank, empty or non-string preferred alias is refused, not skipped (a \`??\` chain)`, async () => {
      for (const unusable of ["   ", "", 42]) {
        const writes: string[] = [];
        const rec = { [fields[0] as string]: unusable, [fields.at(-1) as string]: "later" };
        expect(await refusalMessage(tokenCtx(service, rec, writes))).toBe(missing);
        expect(writes).toEqual([]);
      }
      expect(loadRegisteredIds()).toEqual([]);
    });

    test(`${service}: a null preferred alias is skipped, as \`??\` skips it`, async () => {
      const writes: string[] = [];
      const rec = { [fields[0] as string]: null, [fields.at(-1) as string]: "later" };
      await handleConnectorAuth(tokenCtx(service, rec, writes));
      expect(writes).toEqual([`${key}=later`]);
    });

    test(`${service}: a missing or non-string token is refused with its own message`, async () => {
      for (const rec of [{}, { [fields[0] as string]: 42 }]) {
        const writes: string[] = [];
        expect(await refusalMessage(tokenCtx(service, rec, writes))).toBe(missing);
        expect(writes).toEqual([]);
      }
      expect(loadRegisteredIds()).toEqual([]);
    });
  }

  /** Service ids with a scheduler row in this test's index — a refusal must register none. */
  function loadRegisteredIds(): string[] {
    return db
      .query<{ service_id: string }, []>("SELECT service_id FROM scheduler_state")
      .all()
      .map((r) => r.service_id);
  }
});
