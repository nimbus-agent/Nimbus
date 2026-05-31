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
  canonicalize,
  canonicalizeManifest,
  ManifestNestedTooDeep,
  NonIntegerNumberInManifest,
  UnsupportedManifestValueType,
} from "./crypto/canonical-json";
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
export type { HitlRequest } from "./hitl-request";
export { isHitlRequest } from "./hitl-request";
export { NimbusExtensionServer } from "./server";
export { MockGateway } from "./testing/index";
export type { ExtensionManifest, NimbusItem } from "./types";
