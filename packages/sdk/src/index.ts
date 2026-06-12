/**
 * @nimbus-dev/sdk v1.0.0 — Plugin API v1 (stable baseline)
 * MIT License
 *
 * Typed scaffolding for building Nimbus extensions (MCP connectors).
 * See CHANGELOG.md for the stable surface guarantee.
 */

export type { AuditEmit, AuditLogger } from "./audit-logger";
export { createScopedAuditLogger } from "./audit-logger";
export {
  assertNoRowDataTools,
  ExtensionContractError,
  ROW_DATA_TOOL_SEGMENTS,
  type RowDataToolCandidate,
  runContractTests,
} from "./contract-tests";
export {
  type AppStoreConnectJwtParams,
  signAppStoreConnectJwt,
} from "./crypto/app-store-connect-jwt";
export {
  canonicalize,
  canonicalizeManifest,
  ManifestNestedTooDeep,
  NonIntegerNumberInManifest,
  UnsupportedManifestValueType,
} from "./crypto/canonical-json";
export { base64UrlJson, type SignJwtOptions, signJwt } from "./crypto/jwt";
export {
  type FetchLike,
  type GoogleServiceAccount,
  mintGoogleAccessToken,
  parseServiceAccountJson,
  signServiceAccountAssertion,
} from "./crypto/service-account-token";
export type { SignatureDisableReason } from "./crypto/verify-signature";
export {
  decodeBase64,
  encodeBase64,
  errorToHardDisableReason,
  generateEd25519Keypair,
  PublisherKeyMismatch,
  SignatureInvalid,
  SignatureInvalidFormat,
  signManifest,
  verifyManifestSignature,
} from "./crypto/verify-signature";
export {
  channelUpgradeHint,
  type DistributionChannel,
  type ResolveChannelOptions,
  resolveDistributionChannel,
} from "./distribution-channel";
export type { HitlRequest } from "./hitl-request";
export { isHitlRequest } from "./hitl-request";
export { NimbusExtensionServer } from "./server";
export { MockGateway } from "./testing/index";
export type { ExtensionManifest, NimbusItem } from "./types";
