import { migrationRedactionRoots } from "../../../extensions/migration/migration-redact.ts";
import { dispatchMigrationRpc } from "../../migration-rpc.ts";
import type { RegistryOwnerGate } from "../../registry-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";
import { buildExtensionGateExecutor } from "./automation-rpcs.ts";

/**
 * `migration.*` (connector-unbundling spec § 7.2/§ 7.3): every method is in `FORBIDDEN_OVER_LAN`
 * (I5); `migration.list` and `migration.accept` are on the Tauri allowlist (I46), `decline` and
 * `retry` are not. Only `migration.accept` asks the owner, through the SAME gate-only executor the
 * extension lifecycle approvals use, bound to THIS session's consent channel, so the
 * `extension.migrate` prompt is unicast to the caller. `fromRenderer` (I46's audit field) is the
 * connection's declared kind — the Tauri bridge declares `ui` before any renderer frame, and the
 * renderer cannot reach `session.declareKind` — never a request field.
 */
export async function tryDispatchMigrationRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("migration.")) return phase4RpcSkipped;
  const engine = ctx.options.migrationEngine;
  const localIndex = ctx.options.localIndex;
  if (engine === undefined || localIndex === undefined) return phase4RpcSkipped;
  let ownerGate: RegistryOwnerGate | undefined;
  if (method === "migration.accept") {
    const toolExecutor = buildExtensionGateExecutor(ctx, localIndex, clientId);
    ownerGate = async (action) => (await toolExecutor.gate(action)) === "proceed";
  }
  const out = await dispatchMigrationRpc(method, params, {
    engine,
    ...(ownerGate === undefined ? {} : { ownerGate }),
    fromRenderer: ctx.getClientKind(clientId) === "ui",
    redactRoots: migrationRedactionRoots([
      ctx.options.dataDir,
      ctx.options.extensionsDir,
      ctx.options.configDir,
    ]),
  });
  if (out.kind === "hit") return out.value;
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}
