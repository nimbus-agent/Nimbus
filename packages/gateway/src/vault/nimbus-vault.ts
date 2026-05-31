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
