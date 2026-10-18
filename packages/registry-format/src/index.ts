/** Version of the extension-registry format rules this package implements. */
export const REGISTRY_FORMAT_VERSION = 1;

export {
  MAX_ENTRY_COUNT,
  MAX_MANIFEST_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_UNPACKED_BYTES,
} from "./caps.ts";
export { RegistryError, type RegistryErrorCode } from "./errors.ts";
export {
  assertCanonicalExtensionId,
  assertPublishableExtensionId,
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
export { type InspectedPackage, inspectPackage } from "./inspect.ts";
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
export { packExtensionDir } from "./pack.ts";
export { isPackageFile, listPackageFiles, PACKAGE_MANIFEST_FILE } from "./package-set.ts";
export {
  DEFAULT_NETWORK_PORT,
  type FilesystemPermissions,
  type NetworkEntry,
  parseNetworkEntry,
  type SandboxPermissions,
  validateAndNormalizePermissions,
} from "./permissions-validator.ts";
export { emptyIndex, publicKeyFromSeed, signIndex, verifyIndexSignature } from "./sign.ts";
export {
  effectiveRegistryConfig,
  type PublishCandidate,
  type PublishVerdict,
  parseRegistryConfig,
  type RegistryConfig,
  validatePublish,
} from "./validate-publish.ts";
