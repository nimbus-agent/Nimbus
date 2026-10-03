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

  // Every operation is a synchronous Map access, but `NimbusVault` returns Promises and every real
  // backend REJECTS on a malformed key. `Promise.try` runs each body immediately and turns
  // `validateVaultKeyOrThrow`'s throw into that same rejection, so code exercised against this
  // vault in demo mode sees exactly the failure shape it would see against the OS store.
  set(key: string, value: string): Promise<void> {
    return Promise.try(() => {
      validateVaultKeyOrThrow(key);
      this.store.set(key, value);
    });
  }

  get(key: string): Promise<string | null> {
    return Promise.try(() => {
      validateVaultKeyOrThrow(key);
      return this.store.get(key) ?? null;
    });
  }

  delete(key: string): Promise<void> {
    return Promise.try(() => {
      validateVaultKeyOrThrow(key);
      this.store.delete(key);
    });
  }

  listKeys(prefix?: string): Promise<string[]> {
    const keys = [...this.store.keys()].sort(compareVaultKeysAlphabetically);
    if (prefix === undefined || prefix.length === 0) {
      return Promise.resolve(keys);
    }
    return Promise.resolve(keys.filter((k) => k.startsWith(prefix)));
  }
}
