import { randomBytes } from "node:crypto";

/**
 * A capture id: `cap_` plus 128 bits from the CSPRNG as 32 hex digits. A UUID v4 carries only 122
 * random bits, below the 128 the agent door's ownership rule (`capture.state` answers only for the
 * id's submitter) assumes an id cannot be guessed with.
 */
export function newCaptureId(): string {
  return `cap_${randomBytes(16).toString("hex")}`;
}

/** The shape {@link newCaptureId} mints: `cap_` plus 32 lowercase hex digits. Nothing else is a capture id. */
const CAPTURE_ID_PATTERN = /^cap_[0-9a-f]{32}$/;

/** True for a gateway-minted capture id (AD4: the only text that may follow `agent:` in the ledger). */
export function isCaptureId(value: unknown): value is string {
  return typeof value === "string" && CAPTURE_ID_PATTERN.test(value);
}
