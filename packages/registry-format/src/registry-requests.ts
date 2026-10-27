/**
 * Registry maintainer requests (marketplace trust layer, spec § 6.3): a maintainer revokes a
 * publisher key or takes an extension down FOR THEIR REGISTRY, signed by the registry root. A request
 * is the statement's subject and reason, unsigned: a local-folder registry signs it at once
 * (`nimbus registry maintain revoke-key|takedown`), and a GitHub registry commits it as
 * `trust-requests/<name>.json` for the sign job, the only holder of the root key, to sign on merge.
 *
 * A block is signed into an index at most once, by MEANING (`alreadyCarried`): kind and subject,
 * against statements that verify under the index's OWN root — never by request file name, so a
 * renamed or re-run request can never add a duplicate, and a reused name for a new subject is signed.
 */

import { RegistryError } from "./errors.ts";
import { publisherKeyFingerprint } from "./fingerprint.ts";
import type { RegistryIndex } from "./index-format.ts";
import type { StatementIndex } from "./publisher-statements.ts";
import { publicKeyFromSeed } from "./sign.ts";
import { readStatementList } from "./trust-feed.ts";
import {
  type ExtensionTakedownStatement,
  type KeyRevokeStatement,
  parseTrustStatement,
  signTrustStatement,
  type TrustStatement,
  verifyTrustStatement,
} from "./trust-statement.ts";

export type RegistryRequest =
  | { kind: "key.revoke"; publisherId: string; keyFingerprint: string; reason: string }
  | {
      kind: "extension.takedown";
      extensionId: string;
      /** Required only when the index no longer carries `extensionId`; must match it otherwise. */
      publisherId?: string;
      versions: "*" | readonly string[];
      reason: string;
    };

/** A request file's name (`trust-requests/<name>.json`). */
export const REQUEST_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const REVOKE_KEYS = ["kind", "publisherId", "keyFingerprint", "reason"] as const;
const TAKEDOWN_KEYS = ["kind", "extensionId", "publisherId", "versions", "reason"] as const;
const TAKEDOWN_REQUIRED = ["kind", "extensionId", "versions", "reason"] as const;

/** Placeholders that satisfy the statement format's signer fields while the subject is checked. */
const PLACEHOLDER_KEY = `${"A".repeat(43)}=`;
const PLACEHOLDER_SIGNATURE = `${"A".repeat(86)}==`;
const PLACEHOLDER_PUBLISHER = "placeholder";

function invalid(detail: string): RegistryError {
  return new RegistryError("ERR_TRUST_STATEMENT_INVALID", detail);
}

function exactKeys(
  o: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw invalid(`a request has an unknown key: ${k}`);
  }
  for (const k of required) {
    if (!Object.hasOwn(o, k)) throw invalid(`a request is missing key: ${k}`);
  }
}

/**
 * Strict parse of a request. The subject's fields follow the statement format's own rules (they are
 * checked by `parseTrustStatement` over the would-be statement); unknown keys are refused.
 */
export function parseRegistryRequest(raw: unknown): RegistryRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("a request must be an object");
  }
  const o = raw as Record<string, unknown>;
  const signer = {
    issuedAt: "2026-01-01T00:00:00Z",
    signerKey: PLACEHOLDER_KEY,
    signature: PLACEHOLDER_SIGNATURE,
  };
  if (o["kind"] === "key.revoke") {
    exactKeys(o, REVOKE_KEYS, REVOKE_KEYS);
    const s = parseTrustStatement({ ...o, ...signer }) as KeyRevokeStatement;
    return {
      kind: "key.revoke",
      publisherId: s.publisherId,
      keyFingerprint: s.keyFingerprint,
      reason: s.reason,
    };
  }
  if (o["kind"] === "extension.takedown") {
    exactKeys(o, TAKEDOWN_KEYS, TAKEDOWN_REQUIRED);
    const explicit = o["publisherId"];
    const s = parseTrustStatement({
      ...o,
      publisherId: explicit === undefined ? PLACEHOLDER_PUBLISHER : explicit,
      ...signer,
    }) as ExtensionTakedownStatement;
    return {
      kind: "extension.takedown",
      extensionId: s.extensionId,
      ...(explicit === undefined ? {} : { publisherId: s.publisherId }),
      versions: s.versions,
      reason: s.reason,
    };
  }
  throw invalid("a request's kind must be key.revoke or extension.takedown");
}

/** The publisher a takedown names: the index's for an indexed id; the request's explicit one otherwise. */
function takedownPublisher(
  req: Extract<RegistryRequest, { kind: "extension.takedown" }>,
  index: Pick<RegistryIndex, "extensions">,
): string {
  const entry = Object.hasOwn(index.extensions, req.extensionId)
    ? index.extensions[req.extensionId]
    : undefined;
  if (entry !== undefined) {
    if (req.publisherId !== undefined && req.publisherId !== entry.publisher.id) {
      throw invalid(
        `${req.extensionId} is bound to publisher ${entry.publisher.id} in this registry, not ${req.publisherId}`,
      );
    }
    return entry.publisher.id;
  }
  if (req.publisherId === undefined) {
    throw invalid(
      `${req.extensionId} is not in this registry's index; name its publisher with --publisher to take down copies already installed`,
    );
  }
  return req.publisherId;
}

/**
 * Signs `req` with the registry root seed. Refuses a seed that is not `index.rootKey`'s: clients
 * only honour a registry-signed statement under the root they pinned.
 */
export async function signRegistryRequest(
  req: RegistryRequest,
  index: Pick<RegistryIndex, "extensions" | "rootKey">,
  rootSeed: Uint8Array,
  issuedAt: string,
): Promise<TrustStatement> {
  const signerKey = Buffer.from(publicKeyFromSeed(rootSeed)).toString("base64");
  if (signerKey !== index.rootKey) {
    throw invalid(
      `the key given (fingerprint ${publisherKeyFingerprint(signerKey)}) is not this registry's root key (${publisherKeyFingerprint(index.rootKey)})`,
    );
  }
  if (req.kind === "key.revoke") {
    return signTrustStatement({ ...req, issuedAt, signerKey }, rootSeed);
  }
  const { publisherId: _explicit, ...rest } = req;
  return signTrustStatement(
    { ...rest, publisherId: takedownPublisher(req, index), issuedAt, signerKey },
    rootSeed,
  );
}

/** True when every version `want` names is covered by `have`. */
function covers(have: "*" | readonly string[], want: "*" | readonly string[]): boolean {
  if (have === "*") return true;
  if (want === "*") return false;
  return want.every((v) => have.includes(v));
}

function sameBlock(
  s: TrustStatement,
  req: RegistryRequest,
  index: Pick<RegistryIndex, "extensions">,
): boolean {
  if (req.kind === "key.revoke") {
    return (
      s.kind === "key.revoke" &&
      s.publisherId === req.publisherId &&
      s.keyFingerprint === req.keyFingerprint
    );
  }
  if (s.kind !== "extension.takedown" || s.extensionId !== req.extensionId) return false;
  let publisher: string;
  try {
    publisher = takedownPublisher(req, index);
  } catch {
    return false;
  }
  return s.publisherId === publisher && covers(s.versions, req.versions);
}

/**
 * True when the index already carries `req`'s block: a statement verifying as `registry` under the
 * index's own root, of the same kind and subject (and, for a takedown, versions covering the
 * request's). A publisher-signed or forged statement never counts.
 */
export function alreadyCarried(
  index: StatementIndex & Pick<RegistryIndex, "rootKey">,
  req: RegistryRequest,
): boolean {
  return readStatementList(index.statements).statements.some(
    (s) =>
      verifyTrustStatement(s, { registryRootKey: index.rootKey }) === "registry" &&
      s.signerKey === index.rootKey &&
      sameBlock(s, req, index),
  );
}
