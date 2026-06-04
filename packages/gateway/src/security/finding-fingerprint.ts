import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export interface FindingFingerprintInput {
  readonly service: string;
  readonly externalId: string;
  readonly patternName: string;
  readonly matchRedacted: string;
  /** buildContextSnippet output: "before[REDACTED]after" — carries no secret bytes. */
  readonly contextSnippet: string;
}

function sha256Hex(s: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(s)));
}

/**
 * Stable, offset-independent mute-list key. Folds in a hash of the surrounding
 * context so multiple fixed-literal matches (PEM/PGP/gcp-sa) in one item stay
 * distinct. Reveals no secret bytes (uses the redacted match + [REDACTED] snippet).
 */
export function computeFindingFingerprint(input: FindingFingerprintInput): string {
  const ctxHash = sha256Hex(input.contextSnippet);
  return sha256Hex(
    `${input.service}:${input.externalId}:${input.patternName}:${input.matchRedacted}:${ctxHash}`,
  );
}
