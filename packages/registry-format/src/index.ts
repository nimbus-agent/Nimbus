/** Version of the extension-registry format rules this package implements. */
export const REGISTRY_FORMAT_VERSION = 1;

export {
  MAX_ENTRY_COUNT,
  MAX_MANIFEST_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_ROLE_PACK_DEFAULTS_BYTES,
  MAX_ROLE_PACK_MANIFEST_BYTES,
  MAX_UNPACKED_BYTES,
} from "./caps.ts";
export { codeUnitCompare } from "./code-unit-compare.ts";
export { RegistryError, type RegistryErrorCode } from "./errors.ts";
export { BASELINE_KEYS, isExtensionBaselineEnvKey } from "./extension-env.ts";
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
  type RegistryPackEntry,
  type RegistryPacksRead,
  type RegistryPackVersionEntry,
  type RegistryVersionEntry,
  readRegistryPacks,
  readRegistryReportUrl,
  readRegistryStatements,
  registryIndexDigest,
  registryIndexSigningBytes,
  verifyRegistryIndexPinned,
  verifyRegistryIndexSelf,
} from "./index-format.ts";
export { type InspectedPackage, inspectPackage } from "./inspect.ts";
export {
  DEFAULT_EXTENSION_ENTRY,
  type ExtensionCredentialDecls,
  type ExtensionManifest,
  type ExtensionSyncManifest,
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
export {
  CONNECTOR_ID_SHAPE_RE,
  MAX_ROLE_PACK_CONNECTORS,
  MAX_ROLE_PACK_MEMBERS,
  MAX_ROLE_PACK_ROLES,
  parseRolePackManifest,
  parseRolePackManifestValue,
  ROLE_PACK_ID_RE,
  ROLE_TAG_RE,
  type RolePackManifest,
  rolePackDigest,
} from "./role-pack.ts";
export { emptyIndex, publicKeyFromSeed, signIndex, verifyIndexSignature } from "./sign.ts";
export {
  MAX_STATEMENTS_PER_DOCUMENT,
  MAX_TRUST_FEED_BYTES,
  parseTrustFeed,
  readStatementList,
  readTrustFeedStatements,
  type StatementsRead,
  signTrustFeed,
  type TrustFeed,
  trustFeedDigest,
  trustFeedSigningBytes,
  verifyTrustFeedPinned,
} from "./trust-feed.ts";
export {
  type ExtensionTakedownStatement,
  isKnownStatementKind,
  type KeyRevokeStatement,
  type KeyRotateStatement,
  MAX_STATEMENT_REASON_CHARS,
  MAX_TAKEDOWN_VERSIONS,
  MAX_VERIFIED_KEYS,
  type PublisherVerifiedStatement,
  parseTrustStatement,
  type StatementSignerRole,
  signTrustStatement,
  TRUST_STATEMENT_KINDS,
  type TrustStatement,
  type TrustStatementKind,
  trustStatementId,
  trustStatementSigningBytes,
  type UnsignedTrustStatement,
  verifyTrustStatement,
} from "./trust-statement.ts";
export {
  effectiveRegistryConfig,
  type PublishCandidate,
  type PublishVerdict,
  parseRegistryConfig,
  type RegistryConfig,
  validatePublish,
} from "./validate-publish.ts";
