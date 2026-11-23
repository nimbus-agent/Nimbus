import { homedir } from "node:os";
import { listExtensions } from "../../automation/extension-store.ts";
import {
  approveExtensionRun,
  currentRunCredentials,
  revokeExtensionRun,
} from "../../extensions/approve-run.ts";
import {
  CREDENTIAL_POST_CONSENT_CODES,
  type CredentialReadDeps,
  ExtensionCredentialError,
  extensionCredentialStatus,
  setExtensionCredential,
} from "../../extensions/extension-credential-set.ts";
import { ExtensionRunGrantError } from "../../extensions/run-grant-error.ts";
import { getRunGrant } from "../../extensions/run-grant-store.ts";
import type { NimbusVault } from "../../vault/index.ts";
import { emitGatewayEvent } from "../gateway-events.ts";
import {
  type AutomationCtx,
  type AutomationHandler,
  AutomationRpcError,
  continuityTableOf,
  type Hit,
  requireString,
  stopExtensionBestEffort,
} from "./shared.ts";

/** A refusal that happened AFTER the owner was involved is an internal-class error, like rehash's. */
const RUN_GRANT_POST_CONSENT: ReadonlySet<string> = new Set([
  "ERR_EXTENSION_RUN_NOT_APPROVED",
  "ERR_EXTENSION_RUN_CHANGED",
]);

function runGrantRpcError(e: unknown): unknown {
  if (!(e instanceof ExtensionRunGrantError)) return e;
  if (e.code === "ERR_EXTENSION_NOT_FOUND") {
    return new AutomationRpcError(-32602, "Extension not found");
  }
  return new AutomationRpcError(RUN_GRANT_POST_CONSENT.has(e.code) ? -32603 : -32602, e.message);
}

/**
 * `network` (I52): absent, an array of strings (the declared entries to keep), or the literal
 * `"none"` (no network, `[]`). Anything else is -32602. Which entries are declared is the approval's
 * own check (`narrowNetwork`), so this only fixes the shape.
 */
function approveRunNetworkParam(rec: Record<string, unknown> | undefined): { network?: string[] } {
  const raw = rec?.["network"];
  if (raw === undefined) return {};
  if (raw === "none") return { network: [] };
  if (Array.isArray(raw) && raw.every((e): e is string => typeof e === "string")) {
    return { network: [...raw] };
  }
  throw new AutomationRpcError(
    -32602,
    `Invalid params: 'network' must be an array of strings or "none"`,
  );
}

/**
 * Approve an installed extension to RUN (extension-runtime § 4.4): a second, separate approval from
 * install, asked under `extension.run`. The lazy mesh spawns it on first use, re-verifying first.
 */
async function handleExtensionApproveRun(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  // Validated before the `try`: inside it a malformed parameter would announce a failed approval.
  const rawModelAccess = rec?.["modelAccess"];
  if (rawModelAccess !== undefined && typeof rawModelAccess !== "boolean") {
    throw new AutomationRpcError(-32602, "Invalid params: 'modelAccess' must be a boolean");
  }
  const network = approveRunNetworkParam(rec);
  const ownerGate = ctx.ownerGate;
  if (ownerGate === undefined) {
    throw new AutomationRpcError(-32603, "extension.approveRun requires the owner's HITL gate");
  }
  const env = ctx.runGrantEnv;
  if (env === undefined) {
    throw new AutomationRpcError(
      -32603,
      "Gateway is not configured to resolve extension run grants",
    );
  }
  try {
    const out = await approveExtensionRun(id, {
      db: ctx.db,
      env,
      gate: ownerGate,
      runtimeEnabled: ctx.runtimeEnabled ?? true,
      now: Date.now,
      modelAccess: rawModelAccess === true,
      ...network,
      evidence: {
        ...(ctx.sandboxRunner === undefined ? {} : { sandbox: ctx.sandboxRunner }),
        homeDir: homedir(),
      },
      ...continuityTableOf(ctx),
    });
    // Registers its sync under the index id (or resumes a stale-grant pause) once the grant is live.
    ctx.extensionSync?.refresh(id);
    // Where that sync now lives (a bound extension's is its legacy id, not `serviceId`), so the CLI
    // can say when registration paused it. Absent when no sync was registered.
    const syncServiceId = ctx.extensionSync?.syncServiceIdFor(id);
    // `list`/`info` now carry runState, so a connected client must hear that it moved — as it
    // already does for install/enable/disable/remove/update. An unchanged re-approval moved nothing.
    if (out.changed) {
      emitGatewayEvent("extension.stateChanged", {
        extensionId: id,
        action: "approveRun",
        ok: true,
      });
    }
    return {
      kind: "hit",
      value: syncServiceId === undefined ? out : { ...out, syncServiceId },
    };
  } catch (e) {
    emitGatewayEvent("extension.stateChanged", {
      extensionId: id,
      action: "approveRun",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    throw runGrantRpcError(e);
  }
}

async function handleExtensionRevokeRun(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const mesh = ctx.mesh;
  // Read before the revoke deletes the grant: the stage root is named by its service id.
  const serviceId = getRunGrant(ctx.db, id)?.service_id;
  try {
    const out = await revokeExtensionRun(
      ctx.db,
      id,
      mesh === undefined ? undefined : (x) => mesh.stopExtensionClient(x),
    );
    // After the stop, the stages go too: a later re-approval starts from nothing a previous run
    // left, and a revoked extension leaves no copy of its code in the sandbox root.
    // Revoke stops sync and keeps items (spec § 8.3).
    if (out.revoked) ctx.extensionSync?.refresh(id);
    if (out.revoked && mesh !== undefined && serviceId !== undefined) {
      await mesh.removeExtensionSandbox(serviceId);
    }
    if (out.revoked) {
      emitGatewayEvent("extension.stateChanged", {
        extensionId: id,
        action: "revokeRun",
        ok: true,
      });
    }
    return { kind: "hit", value: out };
  } catch (e) {
    throw runGrantRpcError(e);
  }
}

function credentialRpcError(e: unknown): unknown {
  if (!(e instanceof ExtensionCredentialError)) return e;
  return new AutomationRpcError(
    CREDENTIAL_POST_CONSENT_CODES.has(e.code) ? -32603 : -32602,
    e.message,
  );
}

/**
 * The grant and binding lookups both credential methods share. The live derivation binds through
 * the SAME composed table as the trust check (C7), so neither can fall back to the baked default.
 */
function credentialReadDeps(ctx: AutomationCtx): Omit<CredentialReadDeps, "vault"> {
  return {
    readGrant: (x) => getRunGrant(ctx.db, x),
    liveCredentials: (x) => currentRunCredentials(ctx.db, x, ctx.continuityTable),
    ...continuityTableOf(ctx),
  };
}

function requireCredentialVault(ctx: AutomationCtx, method: string): NimbusVault {
  if (ctx.vault === undefined) {
    throw new AutomationRpcError(-32603, `${method} requires the Vault`);
  }
  return ctx.vault;
}

function requireInstalledExtension(ctx: AutomationCtx, id: string): void {
  if (!listExtensions(ctx.db).some((r) => r.id === id)) {
    throw new AutomationRpcError(-32602, "Extension not found");
  }
}

/**
 * Set one credential an approved extension declares (CLI-only, LAN-forbidden, refused in a demo
 * root). The Vault key comes from the run grant, never from the caller; the owner is asked once,
 * under `vault.set`. A running extension is stopped after the write, so it takes effect on its next start. The value is read here and passed straight to the Vault — it never appears in
 * the gate payload, the response, an error message or the audit row.
 */
async function handleExtensionCredentialSet(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const name = requireString(rec, "name");
  const value = rec?.["value"];
  if (typeof value !== "string") {
    throw new AutomationRpcError(-32602, "Invalid params: 'value' must be a string");
  }
  const gate = ctx.ownerGate;
  if (gate === undefined) {
    throw new AutomationRpcError(-32603, "extension.credentialSet requires the owner's HITL gate");
  }
  const vault = requireCredentialVault(ctx, "extension.credentialSet");
  requireInstalledExtension(ctx, id);
  try {
    const out = await setExtensionCredential(
      { vault, gate, ...credentialReadDeps(ctx) },
      { extensionId: id, name, value },
    );
    // A live `mesh:ext:` child keeps the env it was spawned with. Stopping it makes the next use
    // re-spawn — re-verifying and reading the new value; nothing else picks the change up.
    if (ctx.mesh !== undefined) await stopExtensionBestEffort(ctx.mesh, id);
    return { kind: "hit", value: out };
  } catch (e) {
    throw credentialRpcError(e);
  }
}

/** Which declared credentials hold a non-blank Vault value. Names only — never a value or key. */
async function handleExtensionCredentialStatus(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const vault = requireCredentialVault(ctx, "extension.credentialStatus");
  requireInstalledExtension(ctx, id);
  try {
    const out = await extensionCredentialStatus({ vault, ...credentialReadDeps(ctx) }, id);
    return { kind: "hit", value: out };
  } catch (e) {
    throw credentialRpcError(e);
  }
}

export const EXTENSION_RUN_HANDLERS: Readonly<Record<string, AutomationHandler>> = {
  "extension.approveRun": async (rec, ctx) => handleExtensionApproveRun(rec, ctx),

  "extension.revokeRun": async (rec, ctx) => handleExtensionRevokeRun(rec, ctx),

  "extension.credentialSet": async (rec, ctx) => handleExtensionCredentialSet(rec, ctx),

  "extension.credentialStatus": async (rec, ctx) => handleExtensionCredentialStatus(rec, ctx),
};
