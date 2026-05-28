import { compareVaultKeysAlphabetically, validateVaultKeyOrThrow } from "./key-format.ts";
import type { NimbusVault } from "./nimbus-vault.ts";

export class MockVault implements NimbusVault {
  private readonly store = new Map<string, string>();

  async set(key: string, value: string): Promise<void> {
    validateVaultKeyOrThrow(key);
    this.store.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    validateVaultKeyOrThrow(key);
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    validateVaultKeyOrThrow(key);
    this.store.delete(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const keys = [...this.store.keys()].sort(compareVaultKeysAlphabetically);
    if (prefix === undefined || prefix.length === 0) {
      return keys;
    }
    return keys.filter((k) => k.startsWith(prefix));
  }
}

export function createMockVault(): NimbusVault {
  return new MockVault();
}
