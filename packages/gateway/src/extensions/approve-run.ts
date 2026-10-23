import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { type ExtensionRow, listExtensions } from "../automation/extension-store.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import {
  bindingInputFor,
  CONTINUITY_TABLE,
  type ContinuityEntry,
  findContinuityBinding,
} from "./continuity/continuity-table.ts";
import {
  type ResolvedRunCredentials,
  resolveRunCredentials,
  serializeRunCredentials,
  sortedNames,
} from "./extension-credentials.ts";
import {
  type ExtensionRunGrantEnv,
  type ResolvedRunGrants,
  resolveExtensionRunGrants,
  serializeRunGrants,
} from "./extension-run-grants.ts";
import { assertExtensionServiceIdFree, deriveExtensionServiceId } from "./extension-service-id.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import {
  type ExtensionManifest,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import { pendingMigrationForExtension } from "./migration/migration-store.ts";
import { networkAccessLine } from "./network-access-line.ts";
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
  /** `[extensions] runtime` (and not demo-rooted). `false` refuses before anything is resolved. */
  readonly runtimeEnabled: boolean;
  readonly now: () => number;
  /**
   * `nimbus extension approve --model`: offer this extension's tools to the engine agent (I42).
   * Absent means false. Every approval states the whole grant, so approving without it turns model
   * access off.
   */
  readonly modelAccess?: boolean;
  /**
   * The continuity table a legacy connector id binds through (`findContinuityBinding`). Absent means
   * the production `CONTINUITY_TABLE`; tests inject a fixture entry.
   */
  readonly continuityTable?: readonly ContinuityEntry[];
}

export interface ApproveExtensionRunResult {
  readonly id: string;
  readonly serviceId: string;
  readonly version: string;
  readonly treeDigest: string;
  readonly grants: ResolvedRunGrants;
  readonly modelAccess: boolean;
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

/**
 * Reads the manifest ONCE, hashes those exact bytes against the row's `manifest_hash`, and parses
 * the same bytes. `assertRunnable`'s strict verification read the file separately, so without this
 * a manifest swapped between the two reads would have its permissions granted unverified. Exported
 * for its test: through `approveExtensionRun` the strict check refuses a mismatch first, so this arm
 * is reachable only in that window.
 */
export function readVerifiedManifest(row: ExtensionRow): ExtensionManifest {
  const p = resolveExtensionManifestPath(row.install_path);
  if (p === undefined) {
    throw new ExtensionRunGrantError("ERR_EXTENSION_RUN_UNVERIFIED", `${row.id} has no manifest`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(p);
  } catch {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id}'s manifest could not be read`,
    );
  }
  const hex = createHash("sha256").update(bytes).digest("hex");
  if (!sha256HexEqualConstantTime(hex, row.manifest_hash)) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id}'s manifest no longer matches what was installed; reinstall it`,
    );
  }
  return parseExtensionManifestJson(bytes.toString("utf8"));
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
  modelAccess: boolean,
  credentials: ResolvedRunCredentials,
  reusesConnector?: string,
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
    // What the network grant means on THIS OS: the host list above is enforced on macOS and Linux,
    // but the Windows sandbox cannot limit network access by host, so the list alone would overstate
    // the confinement there. The same sentence the migration prompt shows.
    networkAccess: networkAccessLine(env.platform, grants.network),
    read: [...grants.read],
    write: [...grants.write],
    // The runtime's own read paths, added at every spawn, read-only. Shown, never stored (spec § 11
    // item 7). The install path is NOT among them: the extension is never granted its install tree.
    runtimeRead: [...env.runtimeReadPaths],
    // Where the code actually runs from (I43, `extension-stage.ts`): a copy re-digested against the
    // approved digest at every spawn, inside the working directory the sandbox lets it write.
    runsFrom: `a verified per-spawn copy of ${installPath}, in the extension's own writable working directory`,
    modelAccess,
    // The credentials the extension will receive: names and env vars ONLY — never a Vault key (which
    // would name a legacy connector's keyspace) and never a value. NOT named `credentials`: both the
    // consent display and the audit row redact any field whose name contains "credential", which
    // would hide exactly what the owner is being asked to grant.
    vaultEnv: sortedNames(credentials).map((name) => ({ name, env: credentials[name]?.env ?? "" })),
    ...(manifest.sync === undefined
      ? {}
      : {
          sync: `this extension syncs into your local index (item types: ${manifest.sync.itemTypes.join(", ")})`,
        }),
    // Bound through the continuity table: the extension reads an EXISTING connector's credential.
    // The legacy service id only — never its Vault key. Not named with "credential" for the same
    // redaction reason as `vaultEnv`.
    ...(reusesConnector === undefined ? {} : { reusesConnector }),
  };
}

/**
 * The credentials the grant carries, for `row` as it is now (its source decides the binding), and
 * the legacy connector they are bound to, if any. The ONE derivation: the approval, the spawn
 * verifier and `credentialSet`/`credentialStatus` all call it. `manifest` must be the verified one.
 */
export function resolvedCredentialsFor(
  row: ExtensionRow,
  manifest: ExtensionManifest,
  serviceId: string,
  table: readonly ContinuityEntry[],
): { credentials: ResolvedRunCredentials; binding: ContinuityEntry | undefined } {
  const binding = findContinuityBinding(bindingInputFor(row, manifest), table);
  return { credentials: resolveRunCredentials(manifest, serviceId, binding), binding };
}

/**
 * What `extensionId`'s run grant would carry if derived NOW — from the installed row, its
 * hash-checked manifest and the binding the row's source resolves to under `table`. `undefined`
 * when there is no installed row, no run grant, or no manifest that still matches the install:
 * a caller must treat that as "no binding holds".
 */
export function currentRunCredentials(
  db: Database,
  extensionId: string,
  table: readonly ContinuityEntry[] = CONTINUITY_TABLE,
): { credentials: ResolvedRunCredentials; binding: ContinuityEntry | undefined } | undefined {
  const row = listExtensions(db).find((r) => r.id === extensionId);
  if (row === undefined) return undefined;
  const grant = getRunGrant(db, extensionId);
  if (grant === null) return undefined;
  let manifest: ExtensionManifest;
  try {
    manifest = readVerifiedManifest(row);
  } catch {
    return undefined;
  }
  return resolvedCredentialsFor(row, manifest, grant.service_id, table);
}

/**
 * A migration's grant must read the legacy connector's credential: the binding resolves, names the
 * migrating legacy service, and maps every declared credential to its legacy Vault key.
 */
function assertMigrationBinding(
  extensionId: string,
  legacyServiceId: string,
  binding: ContinuityEntry | undefined,
  credentials: ResolvedRunCredentials,
): void {
  const names = sortedNames(credentials);
  const legacyNames = binding === undefined ? [] : sortedNames(binding.credentials);
  const bound =
    binding?.legacyServiceId === legacyServiceId &&
    names.length === legacyNames.length &&
    names.every((n) => credentials[n]?.vaultKey === binding.credentials[n]);
  if (!bound) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_NOT_MIGRATED",
      `${extensionId} is not bound to ${legacyServiceId}'s existing credential; nothing was granted`,
    );
  }
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
  const { gate } = deps;
  return approveRun(extensionId, deps, {
    modelAccess: deps.modelAccess === true,
    consent: {
      kind: "prompt",
      ask: (payload) => gate({ type: EXTENSION_RUN_ACTION_TYPE, payload }),
    },
  });
}

/**
 * The migration-approval entry point (connector-unbundling spec § 7.2 step 5). The owner's ONE
 * `extension.migrate` decision covers install + run grant + credential grant, so this raises no
 * prompt of its own; it lives here, beside `approveExtensionRun`, so the run grant is still written
 * only by this file (static rule D33(c) unchanged).
 *
 * Because it does not prompt, it refuses unless that decision is structurally in progress for
 * exactly this code: a `connector_migration` row awaiting approval for this extension id whose
 * staged tree digest equals the installed row's, and a continuity binding — the only source of the
 * legacy credential mapping — that resolves for the installed row and names that row's legacy
 * service. The grant never sets model access (§ 8.3 "Read tools"), and every declared credential
 * must map to the binding's LEGACY Vault key: the token the owner already stored is reused, never
 * re-entered, and never falls back to the extension's own keyspace.
 */
export async function approveMigratedExtensionRun(
  deps: Omit<ApproveExtensionRunDeps, "gate" | "modelAccess">,
  id: string,
): Promise<ApproveExtensionRunResult> {
  assertRuntimeEnabled(deps);
  const row = requireRow(deps.db, id);
  const pending = pendingMigrationForExtension(deps.db, id);
  if (pending === undefined) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_NOT_MIGRATED",
      `${id} has no migration awaiting approval; approve it with \`nimbus extension approve ${id}\``,
    );
  }
  if (row.tree_digest === null || pending.treeDigest !== row.tree_digest) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_NOT_MIGRATED",
      `the installed files of ${id} are not the ones the migration verified; nothing was granted`,
    );
  }
  return approveRun(id, deps, {
    modelAccess: false,
    consent: null,
    migratedFrom: pending.legacyServiceId,
  });
}

/** Before the row lookup and any prompt: with the runtime off an approval could never be used. */
function assertRuntimeEnabled(deps: { readonly runtimeEnabled: boolean }): void {
  if (!deps.runtimeEnabled) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUNTIME_DISABLED",
      "the extension runtime is off on this gateway (`[extensions] runtime = false`, or a demo gateway); nothing was granted",
    );
  }
}

type RunConsent =
  /** Ask the owner under `extension.run` over the resolved values. */
  | {
      readonly kind: "prompt";
      readonly ask: (payload: Record<string, unknown>) => Promise<boolean>;
    }
  /**
   * No prompt here: the owner's `extension.migrate` decision already covered this grant. Only
   * `approveMigratedExtensionRun` passes it, after its pending-migration checks.
   */
  | null;

async function approveRun(
  extensionId: string,
  deps: Omit<ApproveExtensionRunDeps, "gate" | "modelAccess">,
  opts: {
    readonly modelAccess: boolean;
    readonly consent: RunConsent;
    /** Set for a migration: the binding must resolve to this legacy service. */
    readonly migratedFrom?: string;
  },
): Promise<ApproveExtensionRunResult> {
  assertRuntimeEnabled(deps);
  const row = requireRow(deps.db, extensionId);
  const treeDigest = assertRunnable(row);
  const manifest = readVerifiedManifest(row);
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
  const continuityTable = deps.continuityTable ?? CONTINUITY_TABLE;
  const { credentials, binding } = resolvedCredentialsFor(
    row,
    manifest,
    serviceId,
    continuityTable,
  );
  if (opts.migratedFrom !== undefined) {
    assertMigrationBinding(row.id, opts.migratedFrom, binding, credentials);
  }
  const credentialsJson = serializeRunCredentials(credentials);
  const modelAccess = opts.modelAccess;
  const base = { id: row.id, serviceId, version: row.version, treeDigest, grants, modelAccess };
  if (
    existing !== null &&
    existing.version === row.version &&
    existing.tree_digest === treeDigest &&
    existing.permissions_json === permissionsJson &&
    existing.credentials_json === credentialsJson &&
    existing.model_access === (modelAccess ? 1 : 0)
  ) {
    return { ...base, changed: false };
  }

  const approved =
    opts.consent === null ||
    (await opts.consent.ask(
      buildRunConsentPayload(
        row,
        manifest,
        serviceId,
        treeDigest,
        grants,
        deps.env,
        modelAccess,
        credentials,
        binding?.legacyServiceId,
      ),
    ));
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
    after.install_path !== row.install_path ||
    after.version !== row.version ||
    after.tree_digest !== treeDigest ||
    digestOrNull(after.install_path) !== treeDigest ||
    // The digest covers only the install tree. A declared path OUTSIDE it (or a symlink along it)
    // can be retargeted — into the data dir, say — while the prompt is open, so the grants are
    // resolved again and must still be exactly what the owner saw.
    reresolvedGrants(manifest, after.install_path, deps.env) !== permissionsJson ||
    // The binding reads the row's source fingerprint, which an update can rewrite while the prompt
    // is open; the stored credentials must still be the ones the owner saw.
    serializeRunCredentials(
      resolvedCredentialsFor(after, manifest, serviceId, continuityTable).credentials,
    ) !== credentialsJson
  ) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_CHANGED",
      `${row.id} changed while approval was pending; nothing was granted`,
    );
  }
  if (existing === null) {
    // The pre-consent collision check saw the grants as they were BEFORE the prompt. A concurrent
    // approval (say of `a.b.c` beside our `a.b`) can store a prefix-colliding id while ours is open,
    // so the check runs again against the grants as they are now.
    const others = listRunGrants(deps.db)
      .filter((g) => g.extension_id !== row.id)
      .map((g) => g.service_id);
    try {
      assertExtensionServiceIdFree(serviceId, others);
    } catch (e) {
      if (!(e instanceof ExtensionRunGrantError)) throw e;
      throw new ExtensionRunGrantError(
        "ERR_EXTENSION_RUN_CHANGED",
        `${row.id}'s service id "${serviceId}" collided with another extension's grant while approval was pending; nothing was granted`,
      );
    }
  }
  upsertRunGrant(deps.db, {
    extension_id: row.id,
    service_id: serviceId,
    version: row.version,
    tree_digest: treeDigest,
    permissions_json: permissionsJson,
    model_access: modelAccess ? 1 : 0,
    approved_at: deps.now(),
    credentials_json: credentialsJson,
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
      // The grant is gone; the runtime re-checks it before every spawn.
    }
  }
  return { id: extensionId, revoked };
}
