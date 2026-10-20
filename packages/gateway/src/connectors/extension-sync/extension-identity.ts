import type { Database } from "bun:sqlite";

import { type ExtensionRow, listExtensions } from "../../automation/extension-store.ts";
import { readVerifiedManifest } from "../../extensions/approve-run.ts";
import {
  bindingInputFor,
  CONTINUITY_TABLE,
  type ContinuityEntry,
  findContinuityBinding,
} from "../../extensions/continuity/continuity-table.ts";
import type { ResolvedRunCredentials } from "../../extensions/extension-credentials.ts";
import { EXTENSION_SERVICE_ID_PATTERN } from "../../extensions/extension-service-id.ts";
import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { type ExtensionRunGrantRow, listRunGrants } from "../../extensions/run-grant-store.ts";

/**
 * The two ids one approved extension answers to. The CODE-server id (`ext_<slug>`) keys the run
 * grant, the `mesh:ext:` slot and every `^ext_` check; the INDEX id is what the scheduler, items,
 * catalog, org policy and connector status use — the bound legacy id (`readwise`) when the
 * continuity table binds this extension, else the same `ext_<slug>`.
 */
export interface ExtensionIdentity {
  readonly extensionId: string;
  readonly codeServerId: string;
  readonly indexServiceId: string;
  readonly binding: ContinuityEntry | undefined;
}

/**
 * Pure. The binding is `findContinuityBinding(bindingInputFor(row, manifest), table)` — the same
 * derivation approval and the pre-spawn verifier use, never a reimplementation. Callers may pass a
 * manifest parsed from the install tree: the I43 pre-spawn verifier re-derives the binding from
 * the VERIFIED manifest and refuses when the credentials differ from the grant, so a tampered
 * manifest can never spawn or write.
 */
export function resolveExtensionIdentity(
  row: ExtensionRow,
  manifest: ExtensionManifest,
  grant: ExtensionRunGrantRow,
  table: readonly ContinuityEntry[] = CONTINUITY_TABLE,
): ExtensionIdentity {
  const binding = findContinuityBinding(bindingInputFor(row, manifest), table);
  return {
    extensionId: row.id,
    codeServerId: grant.service_id,
    indexServiceId: binding?.legacyServiceId ?? grant.service_id,
    binding,
  };
}

/** Reads an installed extension's manifest, or `undefined` when it is missing or unparseable. */
export type ExtensionManifestReader = (row: ExtensionRow) => ExtensionManifest | undefined;

/** Default reader: the hash-checked manifest of the installed tree; any failure reads as absent. */
export const readInstalledManifest: ExtensionManifestReader = (row) => {
  try {
    return readVerifiedManifest(row);
  } catch {
    return undefined;
  }
};

/**
 * An identity for every run grant whose extension row and manifest can be read; a grant whose row
 * or manifest is missing or unparseable is skipped, never thrown on.
 */
export function listExtensionIdentities(
  db: Database,
  table: readonly ContinuityEntry[] = CONTINUITY_TABLE,
  readManifest: ExtensionManifestReader = readInstalledManifest,
): Array<{ identity: ExtensionIdentity; grant: ExtensionRunGrantRow }> {
  const rows = new Map(listExtensions(db).map((r) => [r.id, r]));
  const out: Array<{ identity: ExtensionIdentity; grant: ExtensionRunGrantRow }> = [];
  for (const grant of listRunGrants(db)) {
    const row = rows.get(grant.extension_id);
    if (row === undefined) continue;
    const manifest = readManifest(row);
    if (manifest === undefined) continue;
    out.push({ identity: resolveExtensionIdentity(row, manifest, grant, table), grant });
  }
  return out;
}

/**
 * The index id the org-policy connector allowlist is asked about for the code-server id
 * `codeServerId`. Unreadable state falls back to the code-server id itself, which an allowlist
 * naming only the index id does not list — so a failure to resolve can only refuse, never permit.
 */
export function indexServiceIdForCodeServer(
  db: Database,
  codeServerId: string,
  table: readonly ContinuityEntry[] = CONTINUITY_TABLE,
  readManifest: ExtensionManifestReader = readInstalledManifest,
): string {
  const hit = listExtensionIdentities(db, table, readManifest).find(
    (e) => e.identity.codeServerId === codeServerId,
  );
  return hit?.identity.indexServiceId ?? codeServerId;
}

function parseCredentials(json: string): ResolvedRunCredentials | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, { env: string; vaultKey: string }> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (typeof v !== "object" || v === null) return undefined;
    const env: unknown = Reflect.get(v, "env");
    const vaultKey: unknown = Reflect.get(v, "vaultKey");
    if (typeof env !== "string" || typeof vaultKey !== "string") return undefined;
    out[name] = { env, vaultKey };
  }
  return out;
}

/**
 * Maps an INDEX id to the credentials its approved grant carries (`readwise` when bound, else the
 * `ext_` id); `undefined` for any id no readable grant answers to, or whose stored credentials do
 * not parse. Re-read on every call, so an approval, revoke or removal is seen at once.
 */
export function createExtensionCredentialsResolver(
  db: Database,
  table: readonly ContinuityEntry[] = CONTINUITY_TABLE,
  readManifest: ExtensionManifestReader = readInstalledManifest,
): (serviceId: string) => ResolvedRunCredentials | undefined {
  const boundIds = new Set(table.map((e) => e.legacyServiceId));
  return (serviceId) => {
    // Called on every scheduled run of every connector: answer built-ins with no I/O at all.
    const isExt = EXTENSION_SERVICE_ID_PATTERN.test(serviceId);
    if (!isExt && !boundIds.has(serviceId)) return undefined;
    // An `ext_` index id IS its grant's code-server id: read the grant directly, so a manifest that
    // has become unreadable cannot drop the id to the vacuous "configured" answer (I29).
    if (isExt) {
      const grant = listRunGrants(db).find((g) => g.service_id === serviceId);
      if (grant !== undefined) return parseCredentials(grant.credentials_json);
    }
    const hit = listExtensionIdentities(db, table, readManifest).find(
      (e) => e.identity.indexServiceId === serviceId,
    );
    return hit === undefined ? undefined : parseCredentials(hit.grant.credentials_json);
  };
}

/**
 * The extension that a connector id belongs to, or `undefined` for every other id: an `ext_`
 * code-server id carried by a run grant, or the INDEX id an approved extension syncs under (the
 * bound legacy id, e.g. `readwise`). `connector.remove` refuses these (plan decision 7) — removing
 * one there would clear index rows while the mesh slot and the grant lived on. Built-in ids that the
 * table does not bind answer with no I/O beyond the grant list.
 */
export function extensionIdBackingServiceId(
  db: Database,
  serviceId: string,
  table: readonly ContinuityEntry[] = CONTINUITY_TABLE,
  readManifest: ExtensionManifestReader = readInstalledManifest,
): string | undefined {
  const isExt = EXTENSION_SERVICE_ID_PATTERN.test(serviceId);
  if (isExt) {
    const grant = listRunGrants(db).find((g) => g.service_id === serviceId);
    if (grant !== undefined) return grant.extension_id;
  }
  if (!isExt && !table.some((e) => e.legacyServiceId === serviceId)) return undefined;
  return listExtensionIdentities(db, table, readManifest).find(
    (e) => e.identity.indexServiceId === serviceId,
  )?.identity.extensionId;
}
