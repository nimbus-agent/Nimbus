import { randomBytes } from "node:crypto";

/**
 * A capture id: `cap_` plus 128 bits from the CSPRNG as 32 hex digits. A UUID v4 carries only 122
 * random bits, below the 128 the agent door's ownership rule (`capture.state` answers only for the
 * id's submitter) assumes an id cannot be guessed with.
 */
export function newCaptureId(): string {
  return `cap_${randomBytes(16).toString("hex")}`;
}
