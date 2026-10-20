import { describe, expect, test } from "bun:test";
import type { ExtensionRow } from "../../automation/extension-store.ts";
import { CONNECTOR_SERVICE_IDS } from "../../connectors/connector-catalog.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../../connectors/connector-secrets-manifest.ts";
import type { ExtensionManifest } from "../manifest.ts";
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
  test("production table is empty and binds nothing", () => {
    expect(CONTINUITY_TABLE).toHaveLength(0);
    expect(findContinuityBinding(good)).toBeUndefined();
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
