import { expect, test } from "bun:test";
import { formatVaultName, vaultIdFromAbsolutePath } from "./obsidian-vault-id.ts";

test("vaultIdFromAbsolutePath is the first 12 hex of sha256(absolutePath)", () => {
  const id = vaultIdFromAbsolutePath("/Users/asaf/Documents/MyVault");
  expect(id).toHaveLength(12);
  expect(/^[0-9a-f]{12}$/.test(id)).toBe(true);
});

test("vaultIdFromAbsolutePath is stable across calls for the same path", () => {
  const a = vaultIdFromAbsolutePath("/v");
  const b = vaultIdFromAbsolutePath("/v");
  expect(a).toBe(b);
});

test("vaultIdFromAbsolutePath differs across distinct paths", () => {
  expect(vaultIdFromAbsolutePath("/v")).not.toBe(vaultIdFromAbsolutePath("/w"));
});

test("formatVaultName returns the basename of the vault root path", () => {
  expect(formatVaultName("/Users/asaf/Documents/MyVault")).toBe("MyVault");
  expect(formatVaultName("/Users/asaf/Documents/MyVault/")).toBe("MyVault");
});
