import { compareVaultKeysAlphabetically, validateVaultKeyOrThrow } from "./key-format.ts";
import type { NimbusVault } from "./nimbus-vault.ts";

/**
 * An in-process, never-persisted vault — the ONLY vault a demo-rooted gateway opens (invariant
 * I41 clause 3). Path isolation cannot isolate the OS credential store: on macOS it is the
 * Keychain under a fixed service name and on Linux it is libsecret, neither of which lives under
 * `configDir`. A throwaway demo has no credential worth keeping, so the safe store is one that
 * cannot reach the OS at all and forgets everything when the process exits.
 */
export class EphemeralVault implements NimbusVault {
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
