// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
export interface VaultReader {
  get(key: string): Promise<string | null>;
}

export interface VaultWriter {
  set(key: string, value: string): Promise<void>;
}

export interface VaultDeleter {
  delete(key: string): Promise<void>;
}

export interface VaultLister {
  listKeys(prefix?: string): Promise<string[]>;
}

export interface NimbusVault extends VaultReader, VaultWriter, VaultDeleter, VaultLister {}
