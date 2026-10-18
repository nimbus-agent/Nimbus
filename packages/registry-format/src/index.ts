/** Version of the extension-registry format rules this package implements. */
export const REGISTRY_FORMAT_VERSION = 1;

export { RegistryError, type RegistryErrorCode } from "./errors.ts";
export {
  assertSafeExtensionId,
  deriveExtensionServiceId,
  EXTENSION_SERVICE_ID_PATTERN,
  findServiceIdPrefixCollision,
  MAX_EXTENSION_ID_LENGTH,
} from "./extension-id.ts";
export { publisherKeyFingerprint } from "./fingerprint.ts";
export {
  isValidSemver,
  MAX_INDEX_BYTES,
  parseRegistryIndex,
  type RegistryChannel,
  type RegistryExtensionEntry,
  type RegistryIndex,
  type RegistryVersionEntry,
  registryIndexSigningBytes,
  verifyRegistryIndexPinned,
  verifyRegistryIndexSelf,
} from "./index-format.ts";
export {
  DEFAULT_EXTENSION_ENTRY,
  type ExtensionManifest,
  extensionEntryRelPath,
  PUBLISHER_ID_RE,
  PUBLISHER_KEY_RE,
  parseExtensionManifestForRegistry,
  parseExtensionManifestJson,
  type RegistryParseResult,
} from "./manifest.ts";
export {
  DEFAULT_NETWORK_PORT,
  type FilesystemPermissions,
  type NetworkEntry,
  parseNetworkEntry,
  type SandboxPermissions,
  validateAndNormalizePermissions,
} from "./permissions-validator.ts";
export { emptyIndex, publicKeyFromSeed, signIndex, verifyIndexSignature } from "./sign.ts";
