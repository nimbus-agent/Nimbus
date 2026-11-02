/**
 * Reads one version's entry from a registry's signed `liveness.json` (quality layer).
 *
 * The bytes enter through `fetchRegistryBytes` (the one door; each remote request is ledgered as
 * `registry.liveness`). The file is verified against the key the PINNED, VERIFIED index names, then
 * its sequence and digest go through the V80 floor. Every failure reads as `unavailable`: the
 * liveness file is evidence, never a gate, so this function never throws.
 */
import {
  LIVENESS_FILE,
  type LivenessEntryRead,
  livenessDigest,
  MAX_LIVENESS_BYTES,
  parseLivenessFile,
  type RegistryIndex,
  readLivenessEntry,
  readRegistryLivenessKey,
  verifyLivenessFile,
} from "@nimbus-dev/registry-format";

import { readIndexedUserVersion } from "../../index/migrations/runner.ts";
import { fetchRegistryBytes, type RegistryFetchDeps } from "./registry-fetch.ts";
import { LIVENESS_SCHEMA_VERSION, recordLivenessAccepted } from "./registry-liveness-store.ts";

export const LIVENESS_FETCH_TIMEOUT_MS = 10_000;

export type RegistryLivenessRead =
  | { readonly state: "none" }
  | { readonly state: "unavailable" }
  | {
      readonly state: "verified";
      readonly nimbusVersion: string;
      readonly entry: LivenessEntryRead;
    };

const UNAVAILABLE: RegistryLivenessRead = { state: "unavailable" };

export async function readRegistryLiveness(
  deps: RegistryFetchDeps & { readonly livenessTimeoutMs?: number },
  reg: { readonly name: string; readonly url: string },
  index: RegistryIndex,
  id: string,
  version: string,
): Promise<RegistryLivenessRead> {
  try {
    const key = readRegistryLivenessKey(index);
    if (key === undefined) return { state: "none" };
    if (key === "invalid") return UNAVAILABLE;
    if (readIndexedUserVersion(deps.db) < LIVENESS_SCHEMA_VERSION) return UNAVAILABLE;
    const bytes = await fetchRegistryBytes(
      deps,
      { name: reg.name, url: reg.url },
      LIVENESS_FILE,
      { method: "registry.liveness", maxBytes: MAX_LIVENESS_BYTES },
      AbortSignal.timeout(deps.livenessTimeoutMs ?? LIVENESS_FETCH_TIMEOUT_MS),
    );
    const doc = parseLivenessFile(bytes);
    await verifyLivenessFile(doc, key);
    const outcome = recordLivenessAccepted(deps.db, reg.name, {
      livenessKey: key,
      sequence: doc.sequence,
      documentSha256: livenessDigest(doc),
      generatedAt: doc.generatedAt,
      now: deps.now(),
    });
    if (outcome !== "accepted") return UNAVAILABLE;
    return {
      state: "verified",
      nimbusVersion: doc.nimbusVersion,
      entry: readLivenessEntry(doc, id, version),
    };
  } catch {
    return UNAVAILABLE;
  }
}
