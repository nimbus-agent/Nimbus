export { createNimbusVault } from "./factory.ts";

export { isWellFormedVaultKey, validateVaultKeyOrThrow } from "./key-format.ts";
export type {
  NimbusVault,
  VaultDeleter,
  VaultLister,
  VaultReader,
  VaultWriter,
} from "./nimbus-vault.ts";
