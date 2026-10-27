/**
 * How the CLI words the verified-publisher badge (marketplace trust layer, spec R6) and an update's
 * signature status. "Verified publisher" means one thing only — Nimbus verified the publisher and
 * vouches for the key that signed the code — so the signature status is labelled as a signature,
 * and an extension with no publisher is "unsigned", never "unverified".
 */

export type VerifiedPublisherCli = { readonly github: string; readonly verifiedAt: string };

/** The gateway already constrains both fields; this keeps a terminal safe from any other sender. */
const handleOf = (v: VerifiedPublisherCli): string => v.github.replace(/[^A-Za-z0-9-]/g, "");
const dateOf = (v: VerifiedPublisherCli): string =>
  v.verifiedAt.replace(/[^0-9-]/g, "").slice(0, 10);

/** `Verified publisher: @handle (verified YYYY-MM-DD)`, or `Unverified publisher`. */
export function verifiedPublisherLine(v: VerifiedPublisherCli | null | undefined): string {
  if (v === null || v === undefined) return "Unverified publisher";
  return `Verified publisher: @${handleOf(v)} (verified ${dateOf(v)})`;
}

/** A table cell: `✓ @handle`, or `-`. */
export function verifiedPublisherCell(v: VerifiedPublisherCli | null | undefined): string {
  return v === null || v === undefined ? "-" : `✓ @${handleOf(v)}`;
}

/** An update's signature status; empty for a key conflict, where the signature was never checked. */
export function signatureLabel(
  status: "verified" | "signature_failed" | "publisher_key_conflict",
): string {
  if (status === "verified") return "signature verified";
  if (status === "signature_failed") return "signature failed";
  return "";
}
