import {
  ManifestFetchError,
  type Updater,
  UpdaterInstallUnsupportedError,
} from "../updater/updater.ts";

/** Server-error-range code for "this gateway cannot install updates" (distinct from -32603). */
export const UPDATER_INSTALL_UNSUPPORTED_RPC_CODE = -32000;

export class UpdaterRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "UpdaterRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface UpdaterRpcContext {
  updater: Updater | undefined;
}

export async function dispatchUpdaterRpc(
  method: string,
  _params: unknown,
  ctx: UpdaterRpcContext,
): Promise<unknown> {
  if (!ctx.updater) {
    throw new UpdaterRpcError(
      -32602,
      "ERR_UPDATER_NOT_CONFIGURED: updater service not initialised",
    );
  }
  switch (method) {
    case "updater.getStatus":
      return ctx.updater.getStatus();
    case "updater.checkNow":
      try {
        return await ctx.updater.checkNow();
      } catch (err) {
        if (err instanceof ManifestFetchError) {
          throw new UpdaterRpcError(-32603, `ERR_UPDATER_MANIFEST_UNREACHABLE: ${err.message}`);
        }
        throw err;
      }
    case "updater.applyUpdate":
      try {
        await ctx.updater.applyUpdate();
        return { jobId: Date.now().toString(36) };
      } catch (err) {
        // Checked BEFORE the message regex: the refusal is a typed error, and its wording must
        // never be able to land it in the signature arm.
        if (err instanceof UpdaterInstallUnsupportedError) {
          throw new UpdaterRpcError(UPDATER_INSTALL_UNSUPPORTED_RPC_CODE, err.message);
        }
        const message = err instanceof Error ? err.message : String(err);
        if (/signature|hash/i.test(message)) {
          throw new UpdaterRpcError(-32603, `ERR_UPDATER_SIGNATURE_INVALID: ${message}`);
        }
        throw err;
      }
    case "updater.rollback":
      return { ok: true };
    default:
      throw new UpdaterRpcError(-32601, `ERR_UPDATER_UNKNOWN_METHOD: ${method}`);
  }
}
