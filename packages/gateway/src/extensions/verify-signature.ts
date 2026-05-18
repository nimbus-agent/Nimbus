/**
 * Ed25519 sign + verify re-export shim. Primitives live in `@nimbus-dev/sdk`
 * (MIT) so connector authors can sign without an AGPL dep. Gateway code
 * imports through this shim so existing relative import paths keep working.
 *
 * I16 wiring: `install-from-local.ts` and `verify-extensions.ts` both call
 * `verifyManifestSignature(...)` re-exported here.
 */

export type { SignatureDisableReason } from "@nimbus-dev/sdk";
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
} from "@nimbus-dev/sdk";
