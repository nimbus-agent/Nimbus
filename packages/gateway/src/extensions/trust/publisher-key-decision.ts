/**
 * The one answer every install, update and migration door asks before trusting a publisher key
 * the signed index names (marketplace trust layer, spec R5; replaces the old "any different key is a
 * conflict" check). The Vault's trusted keys for the publisher are the starting point; a new key is
 * accepted when stored statements carry the publisher to it (`keyContinuity`), or when the owner
 * named its exact fingerprint with `--accept-publisher-key`. A revoked key is never accepted, by any
 * path: I48 refuses it before this is asked.
 */
import type { Database } from "bun:sqlite";
import { publisherKeyFingerprint, RegistryError } from "@nimbus-dev/registry-format";

import type { NimbusVault } from "../../vault/index.ts";
import { listTrustedPublisherKeys } from "../publisher-keys.ts";
import type { BlockSubject } from "./trust-blocks.ts";
import { type Continuity, keyContinuity } from "./trust-keys.ts";

/** A move from the keys the Vault trusts to another; fingerprints only, never key bytes. */
export type KeyChange = { readonly from: readonly string[]; readonly to: string };

export type KeyVia = Extract<Continuity, { ok: true }>["via"] | "owner";

export type PublisherKeyDecision =
  | { readonly ok: true; readonly via: KeyVia; readonly change: KeyChange | null }
  | {
      readonly ok: false;
      readonly reason: Extract<Continuity, { ok: false }>["reason"];
      readonly change: KeyChange;
    };

export interface PublisherKeyQuery {
  readonly publisherId: string;
  /** The base64 key the signed index names. */
  readonly key: string;
  readonly source: BlockSubject["source"];
  /** `--accept-publisher-key`: must be exactly the fingerprint of `key`. */
  readonly acceptFingerprint?: string;
  /**
   * An UPDATE of an installed extension: the fingerprint its row recorded. Continuity then starts
   * from that key alone, so one extension's update cannot fall back to a key only a sibling (or an
   * older, superseded install) uses. `null`/absent (a fresh install, or a row with no recorded
   * fingerprint, or one the Vault no longer holds) starts from every key the Vault trusts.
   */
  readonly installedFingerprint?: string | null;
}

export async function publisherKeyDecision(
  deps: { readonly db: Database; readonly vault: NimbusVault },
  q: PublisherKeyQuery,
): Promise<PublisherKeyDecision> {
  const inVault = (await listTrustedPublisherKeys(deps.vault, q.publisherId)).map((k) =>
    publisherKeyFingerprint(k),
  );
  // Trust stays Vault-only: the installed key counts only while the Vault still holds it.
  const own = q.installedFingerprint;
  const trusted = own != null && inVault.includes(own) ? [own] : inVault;
  const candidate = publisherKeyFingerprint(q.key);
  if (q.acceptFingerprint !== undefined && q.acceptFingerprint !== candidate) {
    throw new RegistryError(
      "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
      `--accept-publisher-key names ${q.acceptFingerprint}, but publisher "${q.publisherId}"'s key is now ${candidate}; nothing was accepted`,
    );
  }
  const c = keyContinuity(
    deps.db,
    { publisherId: q.publisherId, source: q.source },
    trusted,
    candidate,
  );
  const unchanged = trusted.length === 0 || trusted.includes(candidate);
  const change: KeyChange = { from: trusted, to: candidate };
  if (c.ok) return { ok: true, via: c.via, change: unchanged ? null : change };
  if (q.acceptFingerprint !== undefined && c.reason !== "revoked") {
    return { ok: true, via: "owner", change };
  }
  return { ok: false, reason: c.reason, change };
}

const CONFLICT_REASON: Readonly<Record<Extract<Continuity, { ok: false }>["reason"], string>> = {
  fork: "the publisher's key rotations lead to more than one key",
  revoked: "that key is revoked",
  unvouched:
    "no rotation from a key this machine trusts, and no Nimbus verification, vouches for it",
};

/** The refusal for a decision that is not ok, worded for each reason. */
export function publisherKeyConflict(
  publisherId: string,
  d: Extract<PublisherKeyDecision, { ok: false }>,
): RegistryError {
  const why = CONFLICT_REASON[d.reason];
  return new RegistryError(
    "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
    `publisher "${publisherId}" now uses key ${d.change.to} (trusted: ${d.change.from.join(", ")}); ${why}.${
      // A revoked key is accepted by no path, so offering the override would only mislead.
      d.reason === "revoked"
        ? ""
        : ` To trust it anyway, pass --accept-publisher-key ${d.change.to}`
    }`,
  );
}

/** The one sentence an install or update prompt shows for a key change. */
export function keyChangeNote(change: KeyChange, via: KeyVia): string {
  const from = change.from.join(", ");
  if (via === "owner") {
    return `publisher key CHANGED from ${from} to ${change.to}, not vouched for by any rotation or by Nimbus`;
  }
  return via === "nimbus"
    ? `publisher key changed from ${from} to ${change.to}, vouched for by Nimbus`
    : `publisher key changed from ${from} to ${change.to} via the publisher's signed rotation`;
}
