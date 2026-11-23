import type { Database } from "bun:sqlite";
import pino, { type Logger } from "pino";
import type { AutoUpdateRpcDeps } from "../../extensions/auto-update-rpc.ts";
import type { ConnectorRequirementStatusesFn } from "../../extensions/connector-requirements.ts";
import type { ContinuityEntry } from "../../extensions/continuity/continuity-table.ts";
import type { ExtensionEvidenceDeps } from "../../extensions/extension-evidence.ts";
import type { ReachRunner } from "../../extensions/extension-reach.ts";
import type { ExtensionRunGrantEnv } from "../../extensions/extension-run-grants.ts";
import type { InstalledEvalDeps } from "../../extensions/installed-eval.ts";
import type { NimbusVault } from "../../vault/index.ts";
import { requireTrimmedStringField } from "../rpc-params.ts";
import type { ClientKind } from "../server/client-kind.ts";

export class AutomationRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.rpcCode = rpcCode;
    this.name = "AutomationRpcError";
  }
}

export type Hit = { kind: "hit"; value: unknown };

/** `rec[key]`, trimmed, or `Missing or invalid <key>` as an `AutomationRpcError`. */
export function requireString(rec: Record<string, unknown> | undefined, key: string): string {
  return requireTrimmedStringField(rec, key, AutomationRpcError);
}

export function requireNumber(rec: Record<string, unknown> | undefined, key: string): number {
  if (rec === undefined) {
    throw new AutomationRpcError(-32602, `Missing or invalid ${key}`);
  }
  const v = rec[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AutomationRpcError(-32602, `Missing or invalid ${key}`);
  }
  return v;
}

export interface AutomationRpcExtensionMeshHandle {
  /** Stops the extension's live client; keyed on the extension id, so it works after the grant is gone. */
  stopExtensionClient(extensionId: string): Promise<void>;
  /** Whether the mesh holds a live client for the extension — `list`/`info`'s `running` state. */
  isExtensionRunning(extensionId: string): boolean;
  /** Deletes the extension's stage root (and its old `ext.<serviceId>` leaf). Best-effort, never throws. */
  removeExtensionSandbox(serviceId: string): Promise<void>;
}

/**
 * The extension sync host's lifecycle hooks (`platform/register-extension-sync.ts`): every handler
 * that changes whether an extension may sync calls `refresh`, and `extension.remove` unregisters and
 * purges under the extension's INDEX id before its row and grant are deleted. Absent ⇒ no extension
 * sync host is running (tests, or a gateway that never built one).
 */
export interface AutomationRpcExtensionSyncHandle {
  refresh(extensionId: string): void;
  /** The id `refresh` registered the extension's sync under; `undefined` when it holds none. */
  syncServiceIdFor(extensionId: string): string | undefined;
  unregister(extensionId: string): void;
  purgeBeforeRemove(extensionId: string): Promise<unknown>;
}

/**
 * The local owner's HITL gate, as the executor runs it (`ToolExecutor.gate`): resolves `true` only
 * for "proceed". Built per call by the server dispatcher with the caller's own consent channel, so
 * the prompt reaches the client that asked.
 */
export type AutomationOwnerGate = (action: {
  type: string;
  payload: Record<string, unknown>;
}) => Promise<boolean>;

/** What `extension.eval` needs beyond the DB, Vault and owner gate; the extras are test seams. */
export type AutomationEvalDeps = Pick<
  InstalledEvalDeps,
  "sandboxDir" | "runtimeReadPaths" | "canConfine" | "createClient" | "verify" | "load" | "run"
>;

export interface AutomationCtx {
  db: Database;
  /**
   * The CONNECTION's declared client kind, set by the server from the session (never from params;
   * a `clientKind` key in params is refused). `workflow.save` sets a schedule only for `cli`/`ui`.
   */
  clientKind?: ClientKind;
  extensionsDir?: string;
  mesh?: AutomationRpcExtensionMeshHandle;
  vault?: NimbusVault;
  autoUpdate?: AutoUpdateRpcDeps;
  ownerGate?: AutomationOwnerGate;
  runGrantEnv?: ExtensionRunGrantEnv;
  /** The sandbox runner the run approval describes network reach from. */
  sandboxRunner?: ReachRunner;
  /** What the install approval states reach and the file outcome from; absent says "not known here". */
  evidence?: ExtensionEvidenceDeps;
  evalDeps?: AutomationEvalDeps;
  /** `[extensions] runtime` and not demo-rooted; absent means the default, `true`. */
  runtimeEnabled?: boolean;
  extensionSync?: AutomationRpcExtensionSyncHandle;
  /** The composition's continuity table; absent means the production default. */
  continuityTable?: readonly ContinuityEntry[];
  /** Test seam: stands in for `connectorRequirementStatuses`; production never passes it. */
  requirementStatuses?: ConnectorRequirementStatusesFn;
  /** Test seam: where an incomplete install rollback is warned; absent means this module's logger. */
  logger?: Pick<Logger, "warn">;
  /** `<dataDir>/extension-observations`: a removed extension's pending window files go with it. */
  observationDir?: string | undefined;
}

export const automationRpcLog = pino({
  name: "automation-rpc",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

export type AutomationHandler = (
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
) => Hit | Promise<Hit>;

/** The composition's table for a binding call; absent leaves the callee's production default. */
export function continuityTableOf(ctx: AutomationCtx): {
  continuityTable?: readonly ContinuityEntry[];
} {
  return ctx.continuityTable === undefined ? {} : { continuityTable: ctx.continuityTable };
}

/** Stops an extension's live client; a stop failure is swallowed — the row decision already stands. */
export async function stopExtensionBestEffort(
  mesh: AutomationRpcExtensionMeshHandle,
  id: string,
): Promise<void> {
  try {
    await mesh.stopExtensionClient(id);
  } catch {
    // The spawn path re-verifies the row and grant before every spawn, so a missed stop cannot
    // outlive the next spawn attempt; failing the lifecycle call would only strand the row.
  }
}
