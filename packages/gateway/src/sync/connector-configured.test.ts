// packages/gateway/src/sync/connector-configured.test.ts
import { describe, expect, test } from "bun:test";

import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import { isConnectorConfigured } from "./connector-configured.ts";

/** `vault.get` calls the FULL key — the same shape `connector-secrets-manifest.ts` lists. */
function fakeVault(secrets: Record<string, string>) {
  return {
    async get(fullKey: string): Promise<string | null> {
      return secrets[fullKey] ?? null;
    },
  } as unknown as Parameters<typeof isConnectorConfigured>[0];
}

/** A Vault whose `.get` always throws — proves the fail-closed contract: no signal, no sync, no row. */
function throwingVault() {
  return {
    async get(_fullKey: string): Promise<string | null> {
      throw new Error("vault unavailable");
    },
  } as unknown as Parameters<typeof isConnectorConfigured>[0];
}

describe("isConnectorConfigured", () => {
  test("a service with none of its manifest keys set is not configured", async () => {
    expect(await isConnectorConfigured(fakeVault({}), "github")).toBe(false);
  });

  test("a service with its manifest key set is configured", async () => {
    expect(await isConnectorConfigured(fakeVault({ "github.pat": "t" }), "github")).toBe(true);
  });

  test("a blank (whitespace-only) secret is treated as absent", async () => {
    expect(await isConnectorConfigured(fakeVault({ "github.pat": "   " }), "github")).toBe(false);
  });

  test("a multi-key service is configured when ANY one of its keys is set", async () => {
    // slack: ["slack.oauth", "slack.bot_token", "slack.app_token"] — only one need be present.
    expect(await isConnectorConfigured(fakeVault({ "slack.bot_token": "t" }), "slack")).toBe(true);
  });

  test("a multi-key service with none of its keys set is not configured", async () => {
    expect(await isConnectorConfigured(fakeVault({}), "slack")).toBe(false);
  });

  test("a service id absent from the manifest entirely is treated as configured (no signal, no gate)", async () => {
    expect(await isConnectorConfigured(fakeVault({}), "filesystem")).toBe(true);
  });

  test("notion is configured via its single oauth key", async () => {
    expect(await isConnectorConfigured(fakeVault({ "notion.oauth": "t" }), "notion")).toBe(true);
    expect(await isConnectorConfigured(fakeVault({}), "notion")).toBe(false);
  });

  // --- Fix 1: the 13 empty-manifest syncables now have a REAL configured-check ---------------

  describe("google_drive/gmail/google_photos/google_meet — resolveGoogleOAuthVaultKey", () => {
    for (const serviceId of ["google_drive", "gmail", "google_photos", "google_meet"] as const) {
      test(`${serviceId} is NOT configured against an empty vault`, async () => {
        expect(await isConnectorConfigured(fakeVault({}), serviceId)).toBe(false);
      });
    }
    test("google_drive is configured via its own per-service key", async () => {
      expect(
        await isConnectorConfigured(fakeVault({ "google_drive.oauth": "t" }), "google_drive"),
      ).toBe(true);
    });
    test("gmail is configured via the shared google.oauth key", async () => {
      expect(await isConnectorConfigured(fakeVault({ "google.oauth": "t" }), "gmail")).toBe(true);
    });
    test("google_meet is configured via its own per-service key", async () => {
      expect(
        await isConnectorConfigured(fakeVault({ "google_meet.oauth": "t" }), "google_meet"),
      ).toBe(true);
    });
  });

  describe("onedrive/outlook — the single shared microsoft.oauth key", () => {
    for (const serviceId of ["onedrive", "outlook"] as const) {
      test(`${serviceId} is NOT configured against an empty vault`, async () => {
        expect(await isConnectorConfigured(fakeVault({}), serviceId)).toBe(false);
      });
      test(`${serviceId} is configured once microsoft.oauth is set`, async () => {
        expect(await isConnectorConfigured(fakeVault({ "microsoft.oauth": "t" }), serviceId)).toBe(
          true,
        );
      });
    }
  });

  describe("github_actions — the same github.pat key github-actions-sync.ts reads", () => {
    test("NOT configured against an empty vault", async () => {
      expect(await isConnectorConfigured(fakeVault({}), "github_actions")).toBe(false);
    });
    test("configured once github.pat is set", async () => {
      expect(await isConnectorConfigured(fakeVault({ "github.pat": "t" }), "github_actions")).toBe(
        true,
      );
    });
  });

  describe("bigquery/cloud_logging/vertex_ai — the shared gcp.* credential pair", () => {
    for (const serviceId of ["bigquery", "cloud_logging", "vertex_ai"] as const) {
      test(`${serviceId} is NOT configured against an empty vault`, async () => {
        expect(await isConnectorConfigured(fakeVault({}), serviceId)).toBe(false);
      });
      test(`${serviceId} is NOT configured with only credentials_json_path (project_id missing)`, async () => {
        expect(
          await isConnectorConfigured(
            fakeVault({ "gcp.credentials_json_path": "/tmp/sa.json" }),
            serviceId,
          ),
        ).toBe(false);
      });
      test(`${serviceId} is NOT configured with only project_id (credentials_json_path missing)`, async () => {
        expect(await isConnectorConfigured(fakeVault({ "gcp.project_id": "p" }), serviceId)).toBe(
          false,
        );
      });
      test(`${serviceId} is NOT configured with only the optional gcp.region set`, async () => {
        expect(
          await isConnectorConfigured(fakeVault({ "gcp.region": "us-east1" }), serviceId),
        ).toBe(false);
      });
      test(`${serviceId} is configured once BOTH credentials_json_path and project_id are set`, async () => {
        expect(
          await isConnectorConfigured(
            fakeVault({ "gcp.credentials_json_path": "/tmp/sa.json", "gcp.project_id": "p" }),
            serviceId,
          ),
        ).toBe(true);
      });
    }
  });

  describe("athena/cloudwatch/sagemaker — the shared aws.* usable-credential formula", () => {
    for (const serviceId of ["athena", "cloudwatch", "sagemaker"] as const) {
      test(`${serviceId} is NOT configured against an empty vault`, async () => {
        expect(await isConnectorConfigured(fakeVault({}), serviceId)).toBe(false);
      });
      test(`${serviceId} is NOT configured with an access key but no secret/region/profile`, async () => {
        expect(
          await isConnectorConfigured(fakeVault({ "aws.access_key_id": "AKIA" }), serviceId),
        ).toBe(false);
      });
      test(`${serviceId} is configured via profile alone`, async () => {
        expect(
          await isConnectorConfigured(fakeVault({ "aws.profile": "default" }), serviceId),
        ).toBe(true);
      });
      test(`${serviceId} is configured via access key + secret + region`, async () => {
        expect(
          await isConnectorConfigured(
            fakeVault({
              "aws.access_key_id": "AKIA",
              "aws.secret_access_key": "s",
              "aws.default_region": "us-east-1",
            }),
            serviceId,
          ),
        ).toBe(true);
      });
    }
  });

  test("fail-closed: a throwing vault rejects rather than treating the service as configured", async () => {
    await expect(isConnectorConfigured(throwingVault(), "github_actions")).rejects.toThrow();
    await expect(isConnectorConfigured(throwingVault(), "bigquery")).rejects.toThrow();
    await expect(isConnectorConfigured(throwingVault(), "athena")).rejects.toThrow();
    await expect(isConnectorConfigured(throwingVault(), "gmail")).rejects.toThrow();
    await expect(isConnectorConfigured(throwingVault(), "onedrive")).rejects.toThrow();
    // The pre-existing manifest path is fail-closed too.
    await expect(isConnectorConfigured(throwingVault(), "github")).rejects.toThrow();
  });

  // --- Pinning test: no OTHER empty-manifest syncable is left ungated ------------------------
  //
  // Every `CONNECTOR_VAULT_SECRET_KEYS` entry with an EMPTY key list has no manifest-derived
  // signal of its own — before Fix 1, `isConnectorConfigured` fell through to "no signal, no
  // gate" (`true`) for every one of them. This test enumerates that exact set against an EMPTY
  // vault and asserts NONE of them still resolve to `true` — i.e. the derived-check map above
  // covers every empty-manifest service that exists today. A future connector added with an
  // empty manifest key list and no `DERIVED_CONFIGURED_CHECKS` entry fails THIS test (falls
  // through to `true` against an empty vault) rather than silently resuming the fabricated-row
  // bleed this whole fix closes.
  test("no empty-manifest syncable still bypasses the configured-check", async () => {
    const emptyManifestServiceIds = Object.entries(CONNECTOR_VAULT_SECRET_KEYS)
      .filter(([, keys]) => keys.length === 0)
      .map(([serviceId]) => serviceId);

    // Sanity: this is exactly the 13 services Fix 1 closes — if this drifts, the manifest
    // changed and this test's premise needs re-checking, not silent adaptation.
    expect(emptyManifestServiceIds.sort()).toEqual(
      [
        "google_drive",
        "gmail",
        "google_photos",
        "google_meet",
        "onedrive",
        "outlook",
        "github_actions",
        "bigquery",
        "athena",
        "cloudwatch",
        "sagemaker",
        "cloud_logging",
        "vertex_ai",
      ].sort(),
    );

    const emptyVault = fakeVault({});
    const stillBypassing: string[] = [];
    for (const serviceId of emptyManifestServiceIds) {
      if (await isConnectorConfigured(emptyVault, serviceId)) {
        stillBypassing.push(serviceId);
      }
    }
    expect(stillBypassing).toEqual([]);
  });
});
