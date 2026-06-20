/**
 * @nimbus-dev/sdk v1.0.0 — Plugin API v1 (stable baseline)
 * MIT License
 *
 * Typed scaffolding for building Nimbus extensions (MCP connectors).
 * See CHANGELOG.md for the stable surface guarantee.
 */

export type {
  AgentBriefBase,
  CatchupItem,
  CatchupSection,
  ConflictType,
  Evidence,
  ExpertFinding,
  GapCategory,
  GapNote,
  ImpactFinding,
  JanitorPeerTouch,
  PreflightDownstream,
} from "./agents/brief-types.ts";
export { createBriefGuard } from "./agents/guard-factory";
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
export type { DataColumn, ParquetMetadataLike } from "./data-profile/index";
export {
  firstLineAndRows,
  jsKind,
  parquetColumnsFromMetadata,
  parseCsvHeader,
  parseJsonColumns,
  parseJsonlColumns,
} from "./data-profile/index";
export {
  channelUpgradeHint,
  type DistributionChannel,
  type ResolveChannelOptions,
  resolveDistributionChannel,
} from "./distribution-channel";
export type { FluxKindEntry } from "./flux-cd/index";
export { FLUX_KINDS, trimTrailingSlash } from "./flux-cd/index";
export type { HitlRequest } from "./hitl-request";
export { isHitlRequest } from "./hitl-request";
export {
  asRecord,
  asString,
  buildGetRequest,
  buildListRequest,
  buildSearchRequest,
  CORE_CAPABILITY,
  capPreview,
  EMAIL_PROPERTIES,
  extractAttachments,
  extractEmailList,
  formatAddress,
  formatAddresses,
  type JmapAttachmentMeta,
  type JmapEmailView,
  type JmapSession,
  MAIL_CAPABILITY,
  MAX_BODY_VALUE_BYTES,
  methodResponseArgs,
  PREVIEW_MAX_CHARS,
  parseSession,
  previewFor,
  SUBMISSION_CAPABILITY,
  validateApiUrl,
  viewEmail,
} from "./jmap-fastmail/index";
export { NimbusExtensionServer } from "./server";
export type { StorybookStory } from "./storybook/index";
export { parseStorybookIndex } from "./storybook/index";
export { MockGateway } from "./testing/index";
export type { ExtensionManifest, NimbusItem } from "./types";
