// packages/gateway/src/ipc/workflow-import-rpc.ts
// `workflow.export` and `workflow.import` (I59, signed workflow import, plan § 6).
//
//   workflow.export { name, author? } -> { bundle, fingerprint, stepsSha256, issuedAt }
//   workflow.import { bundle, replace?, acceptSignerChange?, signer?, schedule?, scheduleTz?, dryRun? }
//                   -> the import result (`automation/workflow-import.ts`)
//
// Both answer only a connection that declared `cli` or `ui` (the kind is the CONNECTION's, never a param:
// a `clientKind` key is refused), are in `FORBIDDEN_OVER_LAN` (I5) and demo-refused (I41), and are not on
// the Tauri allowlist (I7). The gateway never reads or writes a path: the CLI does the file I/O.
//
// Export signs the canonical body with the share signing key through `signBytesWithShareKey` (the seed is
// never held here) and writes ONE `not_required` audit row, type `workflow.export`, carrying hashes and the
// fingerprint only. The schedule of a workflow is never exported.
import type { Database } from "bun:sqlite";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import {
  assembleBundle,
  BundleError,
  buildBundleBody,
  bundleSignedBytes,
} from "../automation/workflow-bundle.ts";
import {
  IMPORT_ERR,
  ImportError,
  type ImportParams,
  importWorkflowBundle,
} from "../automation/workflow-import.ts";
import { ScheduleSaveError } from "../automation/workflow-schedule.ts";
import { getWorkflowByName } from "../automation/workflow-store.ts";
import type { OwnerApproval } from "../engine/owner-only-approval.ts";
import type { PlannedAction } from "../engine/types.ts";
import { signBytesWithShareKey } from "../share/share-keypair.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ClientKind } from "./server/client-kind.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

export interface WorkflowImportRpcCtx {
  readonly db: Database;
  /** The connection's declared kind (`ctx.getClientKind(clientId)`), never a param. */
  readonly callerKind: ClientKind;
  /** Asks the LOCAL owner (no delegation), human answers only. */
  readonly askOwner: (action: PlannedAction) => Promise<OwnerApproval>;
  readonly vault: NimbusVault;
  /** Writes an audit row (the export's `not_required` row). */
  readonly recordAudit: (actionType: string, actionJson: string) => void;
  readonly now?: () => number;
}

const ERR = (code: string, message: string): RpcMethodError =>
  new RpcMethodError(-32001, message, { code });

const IMPORT_KEYS: ReadonlySet<string> = new Set([
  "bundle",
  "replace",
  "acceptSignerChange",
  "signer",
  "schedule",
  "scheduleTz",
  "dryRun",
]);
const EXPORT_KEYS: ReadonlySet<string> = new Set(["name", "author"]);

function recordOf(
  params: unknown,
  allowed: ReadonlySet<string>,
  method: string,
): Record<string, unknown> {
  const rec =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  for (const key of Object.keys(rec)) {
    if (key === "clientKind") {
      throw new RpcMethodError(
        -32602,
        `${method}: clientKind is derived by the gateway and may not be sent`,
      );
    }
    if (!allowed.has(key))
      throw new RpcMethodError(-32602, `${method}: unknown parameter "${key}"`);
  }
  return rec;
}

function requireOwnerKind(kind: ClientKind, method: string): void {
  if (kind === "cli" || kind === "ui") return;
  throw ERR(
    IMPORT_ERR.LOCAL_ONLY,
    `${method} is available only to the owner's CLI or desktop on the local socket`,
  );
}

function optionalBool(rec: Record<string, unknown>, key: string, method: string): boolean {
  const v = rec[key];
  if (v === undefined) return false;
  if (typeof v !== "boolean")
    throw new RpcMethodError(-32602, `${method}: ${key} must be a boolean`);
  return v;
}

function optionalString(
  rec: Record<string, unknown>,
  key: string,
  method: string,
): string | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new RpcMethodError(-32602, `${method}: ${key} must be a string`);
  return v;
}

/** A refusal from the import or the bundle layer, as an RPC error carrying its stable `ERR_*` code. */
function asRpcError(e: unknown): unknown {
  if (e instanceof ImportError || e instanceof BundleError) return ERR(e.code, e.message);
  if (e instanceof ScheduleSaveError) return ERR(e.code, e.message);
  return e;
}

async function exportOne(ctx: WorkflowImportRpcCtx, params: unknown): Promise<unknown> {
  requireOwnerKind(ctx.callerKind, "workflow.export");
  const rec = recordOf(params, EXPORT_KEYS, "workflow.export");
  const name = optionalString(rec, "name", "workflow.export");
  if (name === undefined || name === "") {
    throw new RpcMethodError(-32602, "workflow.export: name is required");
  }
  const author = optionalString(rec, "author", "workflow.export") ?? null;
  const wf = getWorkflowByName(ctx.db, name);
  if (wf === null) throw ERR("ERR_WORKFLOW_NOT_FOUND", `no workflow named "${name}"`);
  const now = (ctx.now ?? Date.now)();
  try {
    const body = buildBundleBody(
      {
        name: wf.name,
        description: wf.description,
        author,
        issuedAt: now,
        stepsJson: wf.steps_json,
      },
      now,
    );
    const { sigB64, pubkeyB64 } = await signBytesWithShareKey(ctx.vault, bundleSignedBytes(body));
    const bundle = assembleBundle(body, sigB64, pubkeyB64);
    const fingerprint = publisherKeyFingerprint(pubkeyB64);
    ctx.recordAudit(
      "workflow.export",
      JSON.stringify({
        type: "workflow.export",
        name: wf.name,
        stepsSha256: body.stepsSha256,
        signerFingerprint: fingerprint,
        issuedAt: now,
      }),
    );
    return { bundle, fingerprint, stepsSha256: body.stepsSha256, issuedAt: now };
  } catch (e) {
    throw asRpcError(e);
  }
}

async function importOne(ctx: WorkflowImportRpcCtx, params: unknown): Promise<unknown> {
  requireOwnerKind(ctx.callerKind, "workflow.import");
  const rec = recordOf(params, IMPORT_KEYS, "workflow.import");
  const bundleText = rec["bundle"];
  if (typeof bundleText !== "string" || bundleText === "") {
    throw new RpcMethodError(-32602, "workflow.import: bundle must be the bundle file's text");
  }
  const signer = optionalString(rec, "signer", "workflow.import");
  const args: ImportParams = {
    bundleText,
    replace: optionalBool(rec, "replace", "workflow.import"),
    acceptSignerChange: optionalBool(rec, "acceptSignerChange", "workflow.import"),
    dryRun: optionalBool(rec, "dryRun", "workflow.import"),
    ...(signer === undefined ? {} : { signer }),
    schedule: rec["schedule"],
    scheduleTz: rec["scheduleTz"],
  };
  try {
    return await importWorkflowBundle(
      {
        db: ctx.db,
        now: ctx.now ?? Date.now,
        askOwner: ctx.askOwner,
        clientKind: ctx.callerKind,
      },
      args,
    );
  } catch (e) {
    throw asRpcError(e);
  }
}

/** Whether `method` is one of this module's two methods (the dispatcher names neither literal, static D50(b)). */
export function isWorkflowImportMethod(method: string): boolean {
  return method === "workflow.export" || method === "workflow.import";
}

export async function dispatchWorkflowImportRpc(
  method: string,
  params: unknown,
  ctx: WorkflowImportRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<WorkflowImportRpcCtx, unknown>(method, params, ctx, {
    "workflow.export": (p, c) => exportOne(c, p),
    "workflow.import": (p, c) => importOne(c, p),
  });
}
