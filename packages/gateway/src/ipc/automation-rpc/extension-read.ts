import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { type ExtensionRow, listExtensions } from "../../automation/extension-store.ts";
import {
  type ExtensionManifestReader,
  readInstalledManifest,
} from "../../connectors/extension-sync/extension-identity.ts";
import { readVerifiedManifest } from "../../extensions/approve-run.ts";
import {
  type ConnectorRequirementDeps,
  type ConnectorRequirementInput,
  type ConnectorRequirementStatus,
  connectorRequirementStatusesByExtension,
  installedConnectorRequirements,
} from "../../extensions/connector-requirements.ts";
import { forwardDeps, reverseDeps } from "../../extensions/dependency-store.ts";
import {
  type AccessEvidence,
  accessEvidence,
  unreadableAccessEvidence,
} from "../../extensions/extension-evidence.ts";
import {
  PRE_T2_DISABLE_REASON,
  preT2DisabledIds,
  preT2DisableMessage,
  RECOVERED_PENDING_REHASH_REASON,
  recoveredPendingRehashMessage,
  recoveredPendingRehashRegistry,
  signatureDisabledRegistry,
  signatureDisableMessage,
} from "../../extensions/hard-disable.ts";
import { oneLine } from "../../extensions/install-plan-text.ts";
import { installedAuthorMetadata } from "../../extensions/installed-author-metadata.ts";
import {
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "../../extensions/manifest.ts";
import { unneededDependencies } from "../../extensions/orphaned-dependencies.ts";
import {
  type InstalledProvenanceView,
  readInstalledProvenance,
  reverifyInstalledProvenance,
} from "../../extensions/registry/installed-provenance.ts";
import {
  localInstallEvidence,
  type VersionEvidence,
} from "../../extensions/registry/version-evidence.ts";
import {
  type ExtensionRunGrantRow,
  getRunGrant,
  listRunGrants,
} from "../../extensions/run-grant-store.ts";
import { extensionRunFields } from "../../extensions/run-state.ts";
import {
  blockSubjectForInstalled,
  blocksForInstalled,
  type TrustBlock,
} from "../../extensions/trust/trust-blocks.ts";
import {
  type VerifiedPublisher,
  verifiedPublisherFor,
} from "../../extensions/trust/verified-publisher.ts";
import { verifyOneExtensionStrict } from "../../extensions/verify-extensions.ts";
import type { SignatureDisableReason } from "../../extensions/verify-signature.ts";
import { newestPrevVersion } from "../../extensions/version-store.ts";
import { readAuditEntries } from "../extension-audit-rpc.ts";
import {
  type AutomationCtx,
  type AutomationHandler,
  AutomationRpcError,
  automationRpcLog,
  continuityTableOf,
  type Hit,
  requireString,
} from "./shared.ts";

type ExtensionListItem = ExtensionRow &
  ReturnType<typeof extensionRunFields> & {
    /** R6: the current Nimbus verification lists the key that verified this copy (null otherwise). */
    verifiedPublisher: VerifiedPublisher | null;
    disabled_reason?:
      | typeof PRE_T2_DISABLE_REASON
      | typeof RECOVERED_PENDING_REHASH_REASON
      | SignatureDisableReason;
    needs_reinstall?: boolean;
    signature_disabled?: boolean;
    /** Installed only as a dependency and no edge names it now; the owner removes it. */
    orphaned?: true;
  };

/**
 * Attach the reason an extension is disabled, where the gateway knows one.
 *
 * Two independent registries, and they must stay independent on the wire. `needs_reinstall` is the
 * PRE-T2 flag and drives `--filter needs-reinstall`; a failed Ed25519 check gets `signature_disabled`
 * instead, because the remedies differ (I16) and quietly widening the filter would change what that
 * flag has meant since T2 PR 1.
 *
 * They cannot both apply in practice — the pre-T2 pass runs first and leaves those rows `enabled = 0`,
 * and the signature pass only iterates rows that are still `enabled = 1` — but pre-T2 is checked first
 * regardless rather than relying on that ordering.
 */
/**
 * The trust blocks applying to an installed row (I48), for display. A manifest that no longer reads
 * gives `[]` here; the spawn path refuses such a row on its own checks.
 */
function trustBlocksOf(db: Database, row: ExtensionRow): TrustBlock[] {
  try {
    return blocksForInstalled(db, row, readVerifiedManifest(row));
  } catch {
    return [];
  }
}

/**
 * The verified publisher of an installed copy (R6), from the same subject its trust blocks use. No
 * badge unless the copy still matches the manifest and entry hashes recorded at install
 * (`verifyOneExtensionStrict`) — a durable check, unlike the per-boot signature registry, which a
 * restart clears and which a hash-only boot failure never marks — and none for a copy this boot's
 * signature check disabled, or whose manifest no longer reads.
 */
function verifiedPublisherOf(db: Database, row: ExtensionRow): VerifiedPublisher | null {
  if (preT2DisabledIds().includes(row.id) || signatureDisabledRegistry.has(row.id)) return null;
  // R6 as amended 2026-10-27: a local-path copy's manifest signature does not bind its entry file.
  if (row.source_registry == null) return null;
  try {
    if (!verifyOneExtensionStrict(row)) return null;
    return verifiedPublisherFor(db, blockSubjectForInstalled(row, readVerifiedManifest(row)));
  } catch {
    return null;
  }
}

/**
 * The publisher the copy's hash-checked manifest declares (id and PUBLIC key), for display: the CLI
 * renders the id, a short key and the badge from it. Absent for an unsigned copy, or one whose
 * manifest no longer reads.
 */
function publisherOf(row: ExtensionRow): { publisher?: { id: string; key: string } } {
  try {
    const p = readVerifiedManifest(row).publisher;
    return p === undefined ? {} : { publisher: { id: p.id, key: p.key } };
  } catch {
    return {};
  }
}

function decorateExtensionList(
  db: Database,
  rows: readonly ExtensionRow[],
  grants: ReadonlyMap<string, ExtensionRunGrantRow>,
  isRunning: (id: string) => boolean,
): ExtensionListItem[] {
  const preT2 = new Set(preT2DisabledIds());
  const unneeded = new Set(unneededDependencies(db));
  const signature = new Map(signatureDisabledRegistry.list().map((e) => [e.id, e.reason]));
  return rows.map((r) => {
    const run = {
      ...extensionRunFields(r, grants.get(r.id) ?? null, isRunning(r.id), trustBlocksOf(db, r)),
      verifiedPublisher: verifiedPublisherOf(db, r),
      ...publisherOf(r),
      ...(unneeded.has(r.id) ? { orphaned: true as const } : {}),
    };
    if (preT2.has(r.id)) {
      return { ...r, ...run, disabled_reason: PRE_T2_DISABLE_REASON, needs_reinstall: true };
    }
    const reason = signature.get(r.id);
    if (reason !== undefined) {
      return { ...r, ...run, disabled_reason: reason, signature_disabled: true };
    }
    if (recoveredPendingRehashRegistry.has(r.id)) {
      return { ...r, ...run, disabled_reason: RECOVERED_PENDING_REHASH_REASON };
    }
    return { ...r, ...run };
  });
}

function isRunningIn(ctx: AutomationCtx, id: string): boolean {
  return ctx.mesh?.isExtensionRunning(id) ?? false;
}

/** What requirement status reads, or undefined without a Vault (tests, demo): nothing is computed. */
export function requirementDeps(ctx: AutomationCtx): ConnectorRequirementDeps | undefined {
  return ctx.vault === undefined
    ? undefined
    : { db: ctx.db, vault: ctx.vault, ...continuityTableOf(ctx) };
}

/** A manifest reader that reads each installed copy's manifest at most once. */
function memoManifestReader(): ExtensionManifestReader {
  const seen = new Map<string, ReturnType<ExtensionManifestReader>>();
  return (row) => {
    if (!seen.has(row.id)) seen.set(row.id, readInstalledManifest(row));
    return seen.get(row.id);
  };
}

/**
 * `requires` for each of `rows`, keyed by id: whether each connector its manifest requires is
 * connected (`[]` when it requires none), in one pass — every manifest is read once and every
 * distinct connector's status computed once, however many rows require it. A row is absent from
 * the map without a Vault, when its manifest no longer reads, or when the computation failed: its
 * `requires` is then omitted, never an error. A failed Vault read is that connector's `unknown`.
 */
async function requiresByExtension(
  ctx: AutomationCtx,
  rows: readonly ExtensionRow[],
): Promise<ReadonlyMap<string, ConnectorRequirementStatus[]>> {
  const deps = requirementDeps(ctx);
  if (deps === undefined) return new Map();
  const read = memoManifestReader();
  const required: ConnectorRequirementInput[] = [];
  const none: string[] = [];
  for (const row of rows) {
    const own = installedConnectorRequirements(row, read);
    if (own === undefined) continue;
    if (own.length === 0) none.push(row.id);
    required.push(...own);
  }
  const out = await connectorRequirementStatusesByExtension(
    { ...deps, readManifest: read },
    required,
    ctx.requirementStatuses,
  );
  for (const id of none) out.set(id, []);
  return out;
}

/** Whether the caller asked for connector-requirement status (`includeRequires: true`). */
function wantsRequires(rec: Record<string, unknown> | undefined): boolean {
  return rec?.["includeRequires"] === true;
}

function withRequires<T extends { id: string }>(
  item: T,
  requires: ReadonlyMap<string, ConnectorRequirementStatus[]>,
): T & { requires?: ConnectorRequirementStatus[] } {
  const own = requires.get(item.id);
  return own === undefined ? item : { ...item, requires: own };
}

async function handleExtensionList(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const filter = rec !== undefined && typeof rec["filter"] === "string" ? rec["filter"] : "";
  const grants = new Map(listRunGrants(ctx.db).map((g) => [g.extension_id, g]));
  const all = decorateExtensionList(ctx.db, listExtensions(ctx.db), grants, (id) =>
    isRunningIn(ctx, id),
  );
  const filtered =
    filter === "needs-reinstall" || filter === "needs_reinstall"
      ? all.filter((e) => e.needs_reinstall === true)
      : all;
  // Opt-in: the desktop polls this method and shows no requirements, and each connector's status
  // is Vault reads (a `secret-tool` spawn apiece on Linux). Once per call when asked, not per item.
  const requires = wantsRequires(rec) ? await requiresByExtension(ctx, filtered) : new Map();
  const extensions = filtered.map((item) => withRequires(item, requires));
  // `nimbus doctor` stays quiet about unapproved extensions when approving one would be refused.
  return {
    kind: "hit",
    value: { extensions, runtimeEnabled: ctx.runtimeEnabled ?? true },
  };
}

/**
 * Reach and the predicted file outcome for an installed extension, from the permissions its
 * installed manifest declares and its own install path (so the own-files check runs). An
 * unreadable manifest is stated on both lines, never omitted and never a guess.
 */
function installedAccess(row: ExtensionRow, ctx: AutomationCtx): { access: AccessEvidence } {
  try {
    const path = resolveExtensionManifestPath(row.install_path);
    if (path === undefined) throw new Error("no manifest file in the install directory");
    const { permissions } = parseExtensionManifestJson(readFileSync(path, "utf8"));
    return { access: accessEvidence(ctx.evidence, permissions, row.install_path) };
  } catch (e) {
    automationRpcLog.debug(
      { err: e instanceof Error ? e.message : "unexpected failure", id: row.id },
      "extension.info could not read the installed manifest",
    );
    return { access: unreadableAccessEvidence() };
  }
}

/**
 * Who tested an installed extension, its history and its checks. A registry-sourced one has no
 * index on hand and `info` starts no registry read, so it names where to look; a local one states
 * its own lines.
 */
function installedEvidence(
  row: ExtensionRow,
): { evidence: VersionEvidence } | { evidenceIn: string } {
  return row.source_registry == null
    ? { evidence: localInstallEvidence() }
    : { evidenceIn: oneLine(row.source_registry) };
}

/**
 * What a registry install kept of the installed version's build provenance (offline provenance
 * re-verification, slice 2), or nothing. Evidence shown to the owner, never a decision (I51).
 */
function installedProvenanceField(
  row: ExtensionRow,
  ctx: AutomationCtx,
): { installedProvenance?: InstalledProvenanceView } {
  const view = readInstalledProvenance(ctx.db, row.id, row.version);
  return view === undefined ? {} : { installedProvenance: view };
}

/**
 * Re-checks the installed version's stored Sigstore bundle offline against the roots of the running
 * release. No network, no write: CLI-only (never LAN, never Tauri).
 */
function handleExtensionVerifyProvenance(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Hit {
  const id = requireString(rec, "id");
  const row = listExtensions(ctx.db).find((r) => r.id === id);
  if (row === undefined) throw new AutomationRpcError(-32602, "Extension not found");
  return {
    kind: "hit",
    value: {
      id: row.id,
      version: row.version,
      ...reverifyInstalledProvenance(ctx.db, row.id, row.version),
    },
  };
}

/** What the installed extension did on this machine; local evidence only (never LAN, never Tauri). */
function handleExtensionAudit(rec: Record<string, unknown> | undefined, ctx: AutomationCtx): Hit {
  // An absent id lists every extension; one that is present must be a real id.
  const id = rec?.["id"] === undefined ? undefined : requireString(rec, "id");
  const extensions = readAuditEntries(ctx.db, id);
  if (extensions === undefined) throw new AutomationRpcError(-32602, "Extension not found");
  return { kind: "hit", value: { extensions } };
}

async function handleExtensionInfo(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const row = listExtensions(ctx.db).find((r) => r.id === id);
  if (row === undefined) {
    throw new AutomationRpcError(-32602, "Extension not found");
  }
  const fwd = forwardDeps(ctx.db, row.id);
  const rev = reverseDeps(ctx.db, row.id);
  const requires = wantsRequires(rec)
    ? (await requiresByExtension(ctx, [row])).get(row.id)
    : undefined;
  const run = {
    ...extensionRunFields(
      row,
      getRunGrant(ctx.db, row.id),
      isRunningIn(ctx, row.id),
      trustBlocksOf(ctx.db, row),
    ),
    verifiedPublisher: verifiedPublisherOf(ctx.db, row),
    ...publisherOf(row),
    ...(requires === undefined ? {} : { requires }),
    ...installedAccess(row, ctx),
    ...installedEvidence(row),
    ...installedAuthorMetadata(row),
    ...installedProvenanceField(row, ctx),
  };
  const preT2 = new Set(preT2DisabledIds());
  if (preT2.has(row.id)) {
    return {
      kind: "hit",
      value: {
        extension: {
          ...row,
          ...run,
          disabled_reason: PRE_T2_DISABLE_REASON,
          needs_reinstall: true,
          forwardDeps: fwd,
          reverseDeps: rev,
        },
        message: preT2DisableMessage(row.id, row.version),
      },
    };
  }

  // I16: the startup signature pass records WHY it hard-disabled a row. Until 2026-09-10 the only
  // production reader was a count in `diag.snapshot`, so `extension info` showed a signature
  // failure as a bare `enabled = 0` — indistinguishable from an extension the owner turned off.
  const signatureReason = signatureDisabledRegistry.reasonFor(row.id);
  if (signatureReason !== undefined) {
    return {
      kind: "hit",
      value: {
        extension: {
          ...row,
          ...run,
          ...resolveExtensionInfoExtras(row, ctx),
          disabled_reason: signatureReason,
          signature_disabled: true,
          forwardDeps: fwd,
          reverseDeps: rev,
        },
        message: signatureDisableMessage(row.id, row.version, signatureReason, row.source_registry),
      },
    };
  }

  if (recoveredPendingRehashRegistry.has(row.id)) {
    return {
      kind: "hit",
      value: {
        extension: {
          ...row,
          ...run,
          ...resolveExtensionInfoExtras(row, ctx),
          disabled_reason: RECOVERED_PENDING_REHASH_REASON,
          forwardDeps: fwd,
          reverseDeps: rev,
        },
        message: recoveredPendingRehashMessage(row.id, row.version),
      },
    };
  }

  return {
    kind: "hit",
    value: {
      extension: {
        ...row,
        ...run,
        ...resolveExtensionInfoExtras(row, ctx),
        forwardDeps: fwd,
        reverseDeps: rev,
      },
    },
  };
}

/**
 * The two fields `extension.info` resolves from outside the DB row: the newest directory under
 * `prev/`, and this run's cached auto-update check.
 *
 * Extracted so the signature-disabled branch above shares them. It was written as an early return
 * placed ABOVE the inline probe, which meant attaching a reason silently dropped both fields from
 * a response that had always carried them — surfacing a reason has to WIDEN the shape, never
 * narrow it. (The pre-T2 branch omits them too, and is left alone: that is shipped behaviour for a
 * different population of rows, not something to change while fixing this.)
 */
function resolveExtensionInfoExtras(
  row: ExtensionRow,
  ctx: AutomationCtx,
): { prevVersion: string | null; cachedUpdate: unknown } {
  let prevVersion: string | null = null;
  try {
    if (ctx.extensionsDir !== undefined) {
      prevVersion = newestPrevVersion(ctx.extensionsDir, row.id) ?? null;
    }
  } catch {
    // Best-effort — info still surfaces the row even if the prev/ probe failed.
  }
  return { prevVersion, cachedUpdate: ctx.autoUpdate?.cache.get(row.id) ?? null };
}

export const EXTENSION_READ_HANDLERS: Readonly<Record<string, AutomationHandler>> = {
  "extension.list": (rec, ctx) => handleExtensionList(rec, ctx),

  "extension.info": (rec, ctx) => handleExtensionInfo(rec, ctx),

  "extension.audit": (rec, ctx) => handleExtensionAudit(rec, ctx),

  "extension.verifyProvenance": (rec, ctx) => handleExtensionVerifyProvenance(rec, ctx),
};
