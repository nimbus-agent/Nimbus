import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import { isWellFormedVaultKey, validateVaultKeyOrThrow } from "./key-format.ts";

const ALL_MANIFEST_KEYS = Object.values(CONNECTOR_VAULT_SECRET_KEYS).flat();

describe("vault key-format — manifest invariant", () => {
  test("every CONNECTOR_VAULT_SECRET_KEYS entry is well-formed", () => {
    const malformed = ALL_MANIFEST_KEYS.filter((k) => !isWellFormedVaultKey(k));
    expect(malformed).toEqual([]);
  });

  test("validateVaultKeyOrThrow accepts every manifest key", () => {
    for (const key of ALL_MANIFEST_KEYS) {
      expect(() => validateVaultKeyOrThrow(key)).not.toThrow();
    }
  });
});

describe("vault key-format — properties (fast-check)", () => {
  // unit:"binary" exercises lone surrogates; covers the full code-unit range.
  const anyString = fc.string({ unit: "binary" });

  test("isWellFormedVaultKey is total (never throws, always boolean)", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        expect(typeof isWellFormedVaultKey(s)).toBe("boolean");
      }),
      { numRuns: 1000 },
    );
  });

  test("isWellFormedVaultKey is total over long / control-char inputs (no throw, no hang)", () => {
    const longish = fc.integer({ min: 0, max: 2000 }).map((n) => "a.b".padEnd(n, "c"));
    const adversarial = fc.constantFrom(
      "svc.key\r\nx",
      "svc. key",
      "a".repeat(300),
      "",
      "a".repeat(257),
    );
    fc.assert(
      fc.property(fc.oneof(longish, adversarial), (s) => {
        expect(typeof isWellFormedVaultKey(s)).toBe("boolean");
      }),
      { numRuns: 500 },
    );
  });

  test("validateVaultKeyOrThrow throws iff !isWellFormedVaultKey", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        if (isWellFormedVaultKey(s)) {
          expect(() => validateVaultKeyOrThrow(s)).not.toThrow();
        } else {
          expect(() => validateVaultKeyOrThrow(s)).toThrow("Invalid vault key format");
        }
      }),
      { numRuns: 1000 },
    );
  });
});
