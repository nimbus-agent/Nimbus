import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import type { ExtensionRow } from "../../automation/extension-store.ts";
import { CONNECTOR_SERVICE_IDS } from "../../connectors/connector-catalog.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../../connectors/connector-secrets-manifest.ts";
import type { ExtensionManifest } from "../manifest.ts";
import { BUILTIN_REGISTRY } from "../registry/builtin-registry.ts";
import {
  bindingInputFor,
  CONTINUITY_TABLE,
  type ContinuityEntry,
  findContinuityBinding,
  validateContinuityEntries,
} from "./continuity-table.ts";

const KEY = "A".repeat(43) + "=";
const FP = "fp-official-root";

const READWISE: ContinuityEntry = {
  legacyServiceId: "readwise",
  extensionId: "com.nimbus.readwise",
  publisherKey: KEY,
  sourceRootFingerprint: FP,
  credentials: { token: "readwise.token" },
  expectedPermissions: { network: ["readwise.io"], read: [], write: [] },
  itemTypes: ["highlight", "book"],
};

describe("findContinuityBinding", () => {
  const table = [READWISE];
  const good = { extensionId: "com.nimbus.readwise", publisherKey: KEY, sourceRootFingerprint: FP };

  test("binds when all three match", () => {
    expect(findContinuityBinding(good, table)).toBe(READWISE);
  });
  test("extension id mismatch", () => {
    expect(findContinuityBinding({ ...good, extensionId: "com.other" }, table)).toBeUndefined();
  });
  test("publisher key mismatch", () => {
    expect(
      findContinuityBinding({ ...good, publisherKey: "B".repeat(43) + "=" }, table),
    ).toBeUndefined();
  });
  test("fingerprint mismatch", () => {
    expect(
      findContinuityBinding({ ...good, sourceRootFingerprint: "other" }, table),
    ).toBeUndefined();
  });
  test("missing key or fingerprint never binds", () => {
    expect(findContinuityBinding({ ...good, publisherKey: undefined }, table)).toBeUndefined();
    expect(findContinuityBinding({ ...good, sourceRootFingerprint: null }, table)).toBeUndefined();
    expect(
      findContinuityBinding({ ...good, sourceRootFingerprint: undefined }, table),
    ).toBeUndefined();
  });
  test("production table binds exactly the official Readwise extension", () => {
    expect(CONTINUITY_TABLE).toHaveLength(1);
    const prod = CONTINUITY_TABLE[0] as ContinuityEntry;
    expect(prod).toMatchObject({
      legacyServiceId: "readwise",
      extensionId: "com.nimbus.readwise",
      publisherKey: "wrUu5uyn3aS2efQOEAUd1eC6H3uqX/RwzIEqQHvAZ9A=",
      sourceRootFingerprint: "6fb9beb2cf6bdc748c72c03b30b83a9a",
      displayName: "Readwise",
    });
    // Another registry's copy (a different root fingerprint) never binds.
    expect(findContinuityBinding(good)).toBeUndefined();
    expect(
      findContinuityBinding({
        extensionId: prod.extensionId,
        publisherKey: prod.publisherKey,
        sourceRootFingerprint: prod.sourceRootFingerprint,
      }),
    ).toBe(prod);
  });
  test("entry fingerprint equals publisherKeyFingerprint(BUILTIN_REGISTRY.rootKey)", () => {
    expect(BUILTIN_REGISTRY).not.toBeNull();
    expect(CONTINUITY_TABLE[0]?.sourceRootFingerprint).toBe(
      publisherKeyFingerprint(BUILTIN_REGISTRY?.rootKey ?? ""),
    );
  });
  test("entry matches the published 0.2.0 manifest's permissions, credentials and item types", () => {
    const entry = CONTINUITY_TABLE[0] as ContinuityEntry;
    const manifest = JSON.parse(
      readFileSync(
        join(import.meta.dir, "__fixtures__", "com.nimbus.readwise-0.2.0.manifest.json"),
        "utf8",
      ),
    ) as ExtensionManifest;
    expect(manifest.id).toBe(entry.extensionId);
    expect(manifest.publisher?.key).toBe(entry.publisherKey);
    expect([...(manifest.permissions.network ?? [])].sort()).toEqual(
      [...entry.expectedPermissions.network].sort(),
    );
    expect(manifest.permissions.filesystem ?? { read: [], write: [] }).toEqual({
      read: [...entry.expectedPermissions.read],
      write: [...entry.expectedPermissions.write],
    });
    expect(Object.keys(manifest.credentials ?? {}).sort()).toEqual(
      Object.keys(entry.credentials).sort(),
    );
    expect([...(manifest.sync?.itemTypes ?? [])].sort()).toEqual([...entry.itemTypes].sort());
    expect(manifest.sync?.contract).toBe("1");
  });
});

describe("bindingInputFor", () => {
  test("takes id and fingerprint from the row and key from the manifest", () => {
    const row = { id: "com.nimbus.readwise", source_root_fingerprint: FP } as ExtensionRow;
    const manifest = { publisher: { id: "nimbus", key: KEY } } as ExtensionManifest;
    expect(bindingInputFor(row, manifest)).toEqual({
      extensionId: "com.nimbus.readwise",
      publisherKey: KEY,
      sourceRootFingerprint: FP,
    });
    expect(bindingInputFor(row, {} as ExtensionManifest).publisherKey).toBeUndefined();
  });
});

describe("validateContinuityEntries", () => {
  test("every entry names a catalog id", () => {
    for (const set of [CONTINUITY_TABLE, [READWISE]]) {
      expect(
        validateContinuityEntries(set, CONNECTOR_SERVICE_IDS, CONNECTOR_VAULT_SECRET_KEYS),
      ).toEqual([]);
    }
  });
  test("every legacy credential key is in CONNECTOR_VAULT_SECRET_KEYS for that id", () => {
    for (const set of [CONTINUITY_TABLE, [READWISE]]) {
      expect(
        validateContinuityEntries(set, CONNECTOR_SERVICE_IDS, CONNECTOR_VAULT_SECRET_KEYS),
      ).toEqual([]);
    }
  });
  test("a duplicate extensionId is refused", () => {
    const dup = { ...READWISE, legacyServiceId: "readwise" };
    const problems = validateContinuityEntries(
      [READWISE, dup],
      CONNECTOR_SERVICE_IDS,
      CONNECTOR_VAULT_SECRET_KEYS,
    );
    expect(problems.join(" | ")).toContain("duplicate extensionId com.nimbus.readwise");
  });
  test("fails for a non-catalog id", () => {
    const bad = { ...READWISE, legacyServiceId: "not_a_connector" };
    expect(
      validateContinuityEntries([bad], CONNECTOR_SERVICE_IDS, CONNECTOR_VAULT_SECRET_KEYS),
    ).not.toEqual([]);
  });
  test("fails for an unknown legacy vault key", () => {
    const bad = { ...READWISE, credentials: { token: "readwise.nope" } };
    expect(
      validateContinuityEntries([bad], CONNECTOR_SERVICE_IDS, CONNECTOR_VAULT_SECRET_KEYS),
    ).not.toEqual([]);
  });
  test("fixture publisher key is a 44-char base64 string", () => {
    expect(READWISE.publisherKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});
