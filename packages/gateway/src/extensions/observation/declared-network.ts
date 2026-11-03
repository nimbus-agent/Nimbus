import type { Database } from "bun:sqlite";

import { listExtensions } from "../../automation/extension-store.ts";
import { readVerifiedManifest } from "../approve-run.ts";
import { declaredNetworkEntries, parseRunGrants } from "../extension-run-grants.ts";
import { getRunGrant } from "../run-grant-store.ts";

/**
 * What an installed extension DECLARES for the network, for observation (audit, findings, offers):
 * the verified installed manifest's `permissions.network` in the form a run grant holds it
 * (`declaredNetworkEntries`), read through the same hash-checked reader the approval uses. File
 * grants are not resolved (nothing here spawns). After an owner narrowed the grant (I52), what the
 * manifest declares and what is approved differ; a host removed by narrowing is still DECLARED.
 *
 * When the manifest cannot be read and verified (missing, unreadable, its bytes no longer the
 * installed hash), or `version` is not the installed one, the stored grant's network is used
 * instead and `from` says so. `approved` is the stored grant's network, `undefined` with no grant.
 */
export type DeclaredNetwork = {
  entries: string[];
  from: "manifest" | "grant";
  approved: string[] | undefined;
};

export function declaredNetworkFor(db: Database, id: string, version: string): DeclaredNetwork {
  const grant = getRunGrant(db, id);
  const approved =
    grant === null ? undefined : [...(parseRunGrants(grant.permissions_json)?.network ?? [])];
  const row = listExtensions(db).find((r) => r.id === id);
  if (row !== undefined && row.version === version) {
    try {
      const manifest = readVerifiedManifest(row);
      return {
        entries: declaredNetworkEntries(manifest.permissions.network),
        from: "manifest",
        approved,
      };
    } catch {
      // Falls back to the grant below; the caller says so.
    }
  }
  return { entries: approved ?? [], from: "grant", approved };
}
