import {
  listExtensions,
  setExtensionEnabled,
  setExtensionTreeDigest,
} from "../../automation/extension-store.ts";
import { installedConnectorRequirementStatuses } from "../../extensions/connector-requirements.ts";
import { accessEvidence, approvalFields } from "../../extensions/extension-evidence.ts";
import { recoveredPendingRehashRegistry } from "../../extensions/hard-disable.ts";
import {
  ExtensionInstallNotApprovedError,
  installExtensionFromLocalDirectory,
  installedKindOf,
  isPromotedInstall,
  reportIncompleteRollback,
} from "../../extensions/install-from-local.ts";
import {
  EvalApprovalDenied,
  evaluateInstalledExtensions,
} from "../../extensions/installed-eval.ts";
import {
  evidenceApprovalFields,
  localInstallEvidence,
} from "../../extensions/registry/version-evidence.ts";
import { computeExtensionTreeDigest } from "../../extensions/tree-digest.ts";
import { verifyOneExtensionStrict } from "../../extensions/verify-extensions.ts";
import { asRecord } from "../connector-rpc-shared.ts";
import { emitGatewayEvent } from "../gateway-events.ts";
import { requirementDeps } from "./extension-read.ts";
import {
  type AutomationCtx,
  type AutomationHandler,
  AutomationRpcError,
  automationRpcLog,
  continuityTableOf,
  type Hit,
  requireString,
} from "./shared.ts";

/** The trimmed `publisherKeyPath` param, or `undefined` when it is absent or not a string. */
function publisherKeyPathOf(rec: Record<string, unknown> | undefined): string | undefined {
  const raw = rec?.["publisherKeyPath"];
  return typeof raw === "string" ? raw.trim() : undefined;
}

/**
 * The RPC error a failed local install becomes. A rollback that left packages behind is warned and
 * named in the refusal (never swallowed).
 */
function localInstallRefusal(
  ctx: AutomationCtx,
  sourcePath: string,
  e: unknown,
): AutomationRpcError {
  const note = reportIncompleteRollback(ctx.logger ?? automationRpcLog, sourcePath, e);
  const msg = `${e instanceof Error ? e.message : String(e)}${note}`;
  return new AutomationRpcError(
    e instanceof ExtensionInstallNotApprovedError ? -32603 : -32602,
    msg,
  );
}

async function handleExtensionInstall(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const sourcePath = requireString(rec, "sourcePath");
  const dir = ctx.extensionsDir;
  if (dir === undefined || dir.trim() === "") {
    throw new AutomationRpcError(-32603, "Gateway is not configured with an extensions directory");
  }
  // Non-Negotiable 2: the consent gate lives in the executor. Without one this REFUSES rather than
  // installing on a client-side prompt the gateway never saw — that was the whole of install's
  // consent before this gate existed, and `--yes` skipped it.
  const ownerGate = ctx.ownerGate;
  if (ownerGate === undefined) {
    throw new AutomationRpcError(-32603, "extension.install requires the owner's HITL gate");
  }
  const publisherKeyPath = publisherKeyPathOf(rec);
  let installed: Awaited<ReturnType<typeof installExtensionFromLocalDirectory>>;
  try {
    installed = await installExtensionFromLocalDirectory({
      db: ctx.db,
      extensionsDir: dir,
      sourcePath,
      ...(ctx.vault !== undefined && { vault: ctx.vault }),
      ...continuityTableOf(ctx),
      ...(ctx.requirementStatuses !== undefined && {
        requirementStatuses: ctx.requirementStatuses,
      }),
      ...(publisherKeyPath !== undefined && publisherKeyPath !== "" && { publisherKeyPath }),
      approve: (request) =>
        ownerGate({
          type: "extension.install",
          payload: {
            ...request,
            ...approvalFields(
              accessEvidence(ctx.evidence, request.planPermissions ?? request.permissions),
            ),
            // A local root brings only already-installed dependencies (no registry fetch), so its own lines
            // are the local ones; `evidenceScope` still appears when the plan lists more than one package.
            ...evidenceApprovalFields(
              localInstallEvidence(),
              request.id,
              request.plan?.length ?? 1,
            ),
          },
        }),
    });
  } catch (e) {
    throw localInstallRefusal(ctx, sourcePath, e);
  }
  // A dependency kept by an explicit install: nothing was copied or approved, only its marker moved.
  if (isPromotedInstall(installed)) {
    return {
      kind: "hit",
      value: {
        id: installed.id,
        version: installed.version,
        promoted: true,
        ...(installed.sourceRegistry === undefined
          ? {}
          : { sourceRegistry: installed.sourceRegistry, channel: installed.channel }),
      },
    };
  }
  // After the install has landed, and outside its error handling: this never throws, and a
  // failure only leaves the field out — requirement status never fails an install.
  const deps = requirementDeps(ctx);
  const connectorRequirements =
    deps === undefined
      ? undefined
      : await installedConnectorRequirementStatuses(deps, [installed.id], ctx.requirementStatuses);
  return {
    kind: "hit",
    value: {
      id: installed.id,
      version: installed.version,
      installPath: installed.installPath,
      manifestHash: installed.manifestHash,
      entryHash: installed.entryHash,
      treeDigest: installed.treeDigest,
      kind: installedKindOf(ctx.db, installed.id),
      ...(connectorRequirements === undefined ? {} : { connectorRequirements }),
    },
  };
}

/**
 * Adopt the bytes now under an extension's install path as its trusted tree, by recording their
 * digest. That is exactly what an install approves, so it is gated as one: the owner is asked
 * under the `extension.install` action type, over the digest that will be stored.
 *
 * Refused, without prompting, when the manifest or entry no longer match their install-time
 * hashes — that is tampering or a half-applied update, and adopting it would launder the change;
 * the fix is a reinstall. The tree is hashed again after approval and must still match what the
 * owner saw, so bytes that change during the prompt are never the ones adopted.
 */
async function handleExtensionRehash(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const ownerGate = ctx.ownerGate;
  if (ownerGate === undefined) {
    throw new AutomationRpcError(-32603, "extension.rehash requires the owner's HITL gate");
  }
  const row = listExtensions(ctx.db).find((r) => r.id === id);
  if (row === undefined) {
    throw new AutomationRpcError(-32602, "Extension not found");
  }
  if (!verifyOneExtensionStrict(row)) {
    throw new AutomationRpcError(
      -32602,
      `ERR_EXTENSION_REHASH_MISMATCH: ${id}'s manifest or entry no longer matches what was installed; reinstall it instead`,
    );
  }
  const treeDigest = digestOrRefuse(row.install_path);
  if (treeDigest === row.tree_digest) {
    return { kind: "hit", value: { id, treeDigest, changed: false } };
  }
  const approved = await ownerGate({
    type: "extension.install",
    payload: {
      id,
      version: row.version,
      installPath: row.install_path,
      adopt: "rehash",
      treeDigest,
      previousTreeDigest: row.tree_digest,
    },
  });
  if (!approved) {
    throw new AutomationRpcError(
      -32603,
      `ERR_EXTENSION_REHASH_NOT_APPROVED: rehash of ${id} was not approved`,
    );
  }
  if (digestOrRefuse(row.install_path) !== treeDigest) {
    throw new AutomationRpcError(
      -32603,
      `ERR_EXTENSION_REHASH_CHANGED: ${id}'s files changed while approval was pending; nothing was adopted`,
    );
  }
  setExtensionTreeDigest(ctx.db, id, treeDigest);
  // A crash-recovered extension was left disabled so that adopting its files is the owner's act;
  // this approval is that act.
  if (recoveredPendingRehashRegistry.has(id)) {
    setExtensionEnabled(ctx.db, id, true);
    recoveredPendingRehashRegistry.unmark(id);
  }
  // A new digest leaves the run grant stale: its sync is unregistered and paused for re-approval
  // (and a crash-recovered extension re-enabled above is considered again).
  ctx.extensionSync?.refresh(id);
  return { kind: "hit", value: { id, treeDigest, changed: true } };
}

const EVAL_MAX_IDS = 50;

/** `ids`: 1–50 non-empty strings, else -32602. Checked before anything else, so before consent. */
function requireEvalIds(rec: Record<string, unknown> | undefined): string[] {
  const raw = rec?.["ids"];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > EVAL_MAX_IDS ||
    !raw.every((x): x is string => typeof x === "string" && x.trim() !== "")
  ) {
    throw new AutomationRpcError(
      -32602,
      `Missing or invalid ids (1 to ${EVAL_MAX_IDS} extension ids)`,
    );
  }
  return raw.map((x) => x.trim());
}

/**
 * Evaluate installed extensions' eval suites (invariant I49): one `extension.eval` approval from
 * the LOCAL owner for the whole call, never delegable. Everything is verified before the prompt.
 */
async function handleExtensionEval(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const ids = requireEvalIds(rec);
  // An owner who switched the extension runtime off should not have extension code executed by
  // another door, sandboxed or not: refused before any verification or prompt.
  if (ctx.runtimeEnabled === false) {
    throw new AutomationRpcError(
      -32603,
      "ERR_EXTENSION_EVAL_RUNTIME_DISABLED: the extension runtime is off on this gateway (`[extensions] runtime = false` in nimbus.toml); nothing was evaluated",
    );
  }
  const { ownerGate, runGrantEnv, evalDeps, vault } = ctx;
  if (
    ownerGate === undefined ||
    runGrantEnv === undefined ||
    evalDeps === undefined ||
    vault === undefined
  ) {
    throw new AutomationRpcError(
      -32603,
      "extension.eval requires the owner's HITL gate, the extension environment, the Vault and a sandbox",
    );
  }
  try {
    const results = await evaluateInstalledExtensions(ids, {
      ...evalDeps,
      db: ctx.db,
      vault,
      env: runGrantEnv,
      ownerGate,
    });
    return { kind: "hit", value: { results } };
  } catch (e) {
    if (e instanceof EvalApprovalDenied) throw new AutomationRpcError(-32603, e.message);
    throw e;
  }
}

function digestOrRefuse(installPath: string): string {
  try {
    return computeExtensionTreeDigest(installPath);
  } catch (e) {
    throw new AutomationRpcError(-32602, e instanceof Error ? e.message : String(e));
  }
}

export const EXTENSION_INSTALL_HANDLERS: Readonly<Record<string, AutomationHandler>> = {
  "extension.install": async (rec, ctx) => {
    const sourcePath = requireString(rec, "sourcePath");
    try {
      const out = await handleExtensionInstall(rec, ctx);
      const value = asRecord(out.value);
      const installedId =
        value !== undefined && typeof value["id"] === "string" ? value["id"] : sourcePath;
      emitGatewayEvent("extension.stateChanged", {
        extensionId: installedId,
        action: "install",
        ok: true,
      });
      return out;
    } catch (e) {
      emitGatewayEvent("extension.stateChanged", {
        extensionId: sourcePath,
        action: "install",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  "extension.rehash": async (rec, ctx) => handleExtensionRehash(rec, ctx),

  "extension.eval": (rec, ctx) => handleExtensionEval(rec, ctx),
};
