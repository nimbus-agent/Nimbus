import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import { type ExtensionRow, listExtensions } from "../automation/extension-store.ts";
import {
  type ExtensionRunGrantEnv,
  type ResolvedRunGrants,
  resolveExtensionRunGrants,
  serializeRunGrants,
} from "./extension-run-grants.ts";
import { assertExtensionServiceIdFree, deriveExtensionServiceId } from "./extension-service-id.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import { publisherKeyFingerprint } from "./install-from-local.ts";
import {
  type ExtensionManifest,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { deleteRunGrant, getRunGrant, listRunGrants, upsertRunGrant } from "./run-grant-store.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { verifyOneExtensionStrict } from "./verify-extensions.ts";

/** The I2 action type a run approval is asked under. */
export const EXTENSION_RUN_ACTION_TYPE = "extension.run" as const;

/** The owner's HITL gate as the executor runs it: `true` only for "proceed". */
export type ExtensionRunGate = (action: {
  type: string;
  payload: Record<string, unknown>;
}) => Promise<boolean>;

export interface ApproveExtensionRunDeps {
  readonly db: Database;
  readonly env: ExtensionRunGrantEnv;
  readonly gate: ExtensionRunGate;
  readonly now: () => number;
}

export interface ApproveExtensionRunResult {
  readonly id: string;
  readonly serviceId: string;
  readonly version: string;
  readonly treeDigest: string;
  readonly grants: ResolvedRunGrants;
  readonly changed: boolean;
}

function requireRow(db: Database, id: string): ExtensionRow {
  const row = listExtensions(db).find((r) => r.id === id);
  if (row === undefined) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_NOT_FOUND",
      `extension "${id}" is not installed`,
    );
  }
  return row;
}

function digestOrNull(installPath: string): string | null {
  try {
    return computeExtensionTreeDigest(installPath);
  } catch {
    return null;
  }
}

/** Every refusal that needs no prompt. Returns the live tree digest, which equals the row's. */
function assertRunnable(row: ExtensionRow): string {
  if (row.enabled !== 1) {
    throw new ExtensionRunGrantError("ERR_EXTENSION_RUN_DISABLED", `${row.id} is disabled`);
  }
  // `extension.enable` flips `enabled` back without re-verifying the I16 signature, so a row the
  // startup pass hard-disabled can be enabled=1 again with its signature still failed. Refuse it.
  // The full I16 re-verification is the spawn path's (PR 3, `readVerifiedExtensionForSpawn`).
  const signatureReason = signatureDisabledRegistry.reasonFor(row.id);
  if (signatureReason !== undefined) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id} failed publisher signature verification at startup (${signatureReason}); see \`nimbus extension info ${row.id}\``,
    );
  }
  if (!verifyOneExtensionStrict(row)) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id}'s manifest or entry no longer matches what was installed; reinstall it`,
    );
  }
  if (row.tree_digest === null) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_NO_DIGEST",
      `${row.id} has no recorded tree digest; review its files and run \`nimbus extension rehash ${row.id}\` first`,
    );
  }
  const live = digestOrNull(row.install_path);
  if (live !== row.tree_digest) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_TREE_CHANGED",
      `${row.id}'s files changed since they were approved; review them and run \`nimbus extension rehash ${row.id}\``,
    );
  }
  return live;
}

function readManifest(row: ExtensionRow): ExtensionManifest {
  const p = resolveExtensionManifestPath(row.install_path);
  if (p === undefined) {
    throw new ExtensionRunGrantError("ERR_EXTENSION_RUN_UNVERIFIED", `${row.id} has no manifest`);
  }
  return parseExtensionManifestJson(readFileSync(p, "utf8"));
}

/**
 * What the owner sees under `extension.run`. Exported for its redaction test.
 *
 * The publisher field is `fingerprint`, NOT `keyFingerprint`: the consent display and the audit row
 * both redact any field whose NAME contains "key" (`executor.ts` `SENSITIVE_PAYLOAD_KEY`), which
 * would hide the one value that tells two publishers with the same id apart. Same name and shape as
 * the install prompt's (`install-from-local.ts`), which hit this first.
 */
export function buildRunConsentPayload(
  row: ExtensionRow,
  manifest: ExtensionManifest,
  serviceId: string,
  treeDigest: string,
  grants: ResolvedRunGrants,
  env: ExtensionRunGrantEnv,
): Record<string, unknown> {
  let installPath = row.install_path;
  try {
    // Canonical, like every resolved grant beside it, so the prompt shows one path form.
    installPath = env.realpath(row.install_path);
  } catch {
    // Keep the stored spelling; assertRunnable already proved the package is on disk.
  }
  return {
    id: row.id,
    version: row.version,
    serviceId,
    publisher:
      manifest.publisher === undefined
        ? "unsigned"
        : {
            id: manifest.publisher.id,
            fingerprint: publisherKeyFingerprint(manifest.publisher.key),
          },
    treeDigest,
    network: [...grants.network],
    read: [...grants.read],
    write: [...grants.write],
    // Added by the runtime at every spawn, read-only. Shown, never stored (spec § 11 item 7).
    runtimeRead: [installPath, ...env.runtimeReadPaths],
    modelAccess: false,
  };
}

/** Re-resolved grants, serialized; `null` when they no longer resolve at all. */
function reresolvedGrants(
  manifest: ExtensionManifest,
  installPath: string,
  env: ExtensionRunGrantEnv,
): string | null {
  try {
    return serializeRunGrants(resolveExtensionRunGrants(manifest.permissions, installPath, env));
  } catch {
    return null;
  }
}

/**
 * Approves an installed extension to run (spec § 4.4). Resolves everything first and refuses —
 * without prompting — anything the owner could not sensibly approve; then asks under
 * `extension.run` over the RESOLVED values; then re-checks the bytes, since the human is the
 * boundary and what they saw must be what is granted; and only then stores the grant.
 */
export async function approveExtensionRun(
  extensionId: string,
  deps: ApproveExtensionRunDeps,
): Promise<ApproveExtensionRunResult> {
  const row = requireRow(deps.db, extensionId);
  const treeDigest = assertRunnable(row);
  const manifest = readManifest(row);
  const grants = resolveExtensionRunGrants(manifest.permissions, row.install_path, deps.env);
  const existing = getRunGrant(deps.db, row.id);
  // Never recomputed once stored, so a slug-rule change cannot move an existing extension's tools.
  const serviceId = existing?.service_id ?? deriveExtensionServiceId(row.id);
  if (existing === null) {
    assertExtensionServiceIdFree(
      serviceId,
      listRunGrants(deps.db).map((g) => g.service_id),
    );
  }
  const permissionsJson = serializeRunGrants(grants);
  const base = { id: row.id, serviceId, version: row.version, treeDigest, grants };
  if (
    existing !== null &&
    existing.version === row.version &&
    existing.tree_digest === treeDigest &&
    existing.permissions_json === permissionsJson
  ) {
    return { ...base, changed: false };
  }

  const approved = await deps.gate({
    type: EXTENSION_RUN_ACTION_TYPE,
    payload: buildRunConsentPayload(row, manifest, serviceId, treeDigest, grants, deps.env),
  });
  if (!approved) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_NOT_APPROVED",
      `running ${row.id} was not approved`,
    );
  }

  const after = listExtensions(deps.db).find((r) => r.id === row.id);
  if (
    after === undefined ||
    after.enabled !== 1 ||
    after.version !== row.version ||
    after.tree_digest !== treeDigest ||
    digestOrNull(after.install_path) !== treeDigest ||
    // The digest covers only the install tree. A declared path OUTSIDE it (or a symlink along it)
    // can be retargeted — into the data dir, say — while the prompt is open, so the grants are
    // resolved again and must still be exactly what the owner saw.
    reresolvedGrants(manifest, after.install_path, deps.env) !== permissionsJson
  ) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_CHANGED",
      `${row.id} changed while approval was pending; nothing was granted`,
    );
  }
  upsertRunGrant(deps.db, {
    extension_id: row.id,
    service_id: serviceId,
    version: row.version,
    tree_digest: treeDigest,
    permissions_json: permissionsJson,
    model_access: 0,
    approved_at: deps.now(),
  });
  return { ...base, changed: true };
}

/**
 * Withdraws a run approval. Not gated: it only narrows. Stops the extension's client best-effort —
 * a stop failure never fails the revoke, since the grant is already gone.
 */
export async function revokeExtensionRun(
  db: Database,
  extensionId: string,
  stop?: (id: string) => Promise<void>,
): Promise<{ id: string; revoked: boolean }> {
  requireRow(db, extensionId);
  const revoked = deleteRunGrant(db, extensionId);
  if (revoked && stop !== undefined) {
    try {
      await stop(extensionId);
    } catch {
      // The grant is gone; the runtime (PR 3) re-checks it before every spawn.
    }
  }
  return { id: extensionId, revoked };
}
