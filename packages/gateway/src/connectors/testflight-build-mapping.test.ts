import { describe, expect, test } from "bun:test";

import { mapTestflightAppToItem, mapTestflightBuildToItem } from "./testflight-build-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

describe("mapTestflightAppToItem", () => {
  test("maps a JSON:API app resource", () => {
    const row = mapTestflightAppToItem(
      {
        type: "apps",
        id: "6448001234",
        attributes: { name: "Acme", bundleId: "com.acme.app", sku: "ACME1" },
      },
      SYNCED_AT,
    );
    expect(row).not.toBeNull();
    expect(row?.service).toBe("testflight");
    expect(row?.type).toBe("app");
    expect(row?.externalId).toBe("6448001234");
    expect(row?.title).toBe("Acme");
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.metadata["bundle_id"]).toBe("com.acme.app");
  });

  test("falls back to bundleId then id for the title", () => {
    expect(
      mapTestflightAppToItem({ id: "x", attributes: { bundleId: "com.b" } }, SYNCED_AT)?.title,
    ).toBe("com.b");
    expect(mapTestflightAppToItem({ id: "x", attributes: {} }, SYNCED_AT)?.title).toBe("x");
  });

  test("returns null when id missing", () => {
    expect(mapTestflightAppToItem({ attributes: { name: "Acme" } }, SYNCED_AT)).toBeNull();
    expect(mapTestflightAppToItem(null, SYNCED_AT)).toBeNull();
    expect(mapTestflightAppToItem("nope", SYNCED_AT)).toBeNull();
  });
});

describe("mapTestflightBuildToItem", () => {
  const ctx = { appId: "6448001234", appName: "Acme", syncedAt: SYNCED_AT };

  test("maps a JSON:API build resource with full attributes", () => {
    const row = mapTestflightBuildToItem(
      {
        type: "builds",
        id: "10009999",
        attributes: {
          version: "204",
          processingState: "VALID",
          expired: false,
          uploadedDate: "2026-05-30T12:00:00Z",
          minOsVersion: "16.0",
          usesNonExemptEncryption: false,
        },
      },
      ctx,
    );
    expect(row).not.toBeNull();
    expect(row?.type).toBe("build");
    expect(row?.externalId).toBe("10009999");
    expect(row?.title).toBe("Acme #204 (VALID)");
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.url).toBeNull();
    expect(row?.modifiedAt).toBe(Date.parse("2026-05-30T12:00:00Z"));
    expect(row?.metadata).toMatchObject({
      app_id: "6448001234",
      version: "204",
      processing_state: "VALID",
      expired: false,
      uploaded_date: Date.parse("2026-05-30T12:00:00Z"),
      min_os_version: "16.0",
      uses_non_exempt_encryption: false,
    });
  });

  test("returns null when build id missing", () => {
    expect(mapTestflightBuildToItem({ attributes: { version: "1" } }, ctx)).toBeNull();
    expect(mapTestflightBuildToItem(null, ctx)).toBeNull();
  });

  test("parses uploadedDate to epoch-ms; null when absent or garbled", () => {
    const good = mapTestflightBuildToItem(
      { id: "b1", attributes: { uploadedDate: "2026-01-02T03:04:05Z" } },
      ctx,
    );
    expect(good?.metadata["uploaded_date"]).toBe(Date.parse("2026-01-02T03:04:05Z"));

    const garbled = mapTestflightBuildToItem(
      { id: "b2", attributes: { uploadedDate: "yesterday" } },
      ctx,
    );
    expect(garbled?.metadata["uploaded_date"]).toBeNull();
    expect(garbled?.modifiedAt).toBe(SYNCED_AT);

    const absent = mapTestflightBuildToItem({ id: "b3", attributes: {} }, ctx);
    expect(absent?.metadata["uploaded_date"]).toBeNull();
  });

  test("title falls back to #? without app name and version", () => {
    const row = mapTestflightBuildToItem(
      { id: "b4", attributes: {} },
      { appId: "a", appName: undefined, syncedAt: SYNCED_AT },
    );
    expect(row?.title).toBe("#?");
  });

  test("non-boolean expired/encryption become null", () => {
    const row = mapTestflightBuildToItem(
      { id: "b5", attributes: { expired: "no", usesNonExemptEncryption: 1 } },
      ctx,
    );
    expect(row?.metadata["expired"]).toBeNull();
    expect(row?.metadata["uses_non_exempt_encryption"]).toBeNull();
  });

  test("does not throw on an entirely bare row", () => {
    const row = mapTestflightBuildToItem({ id: "bare" }, ctx);
    expect(row?.externalId).toBe("bare");
    expect(row?.metadata["version"]).toBeNull();
  });
});
