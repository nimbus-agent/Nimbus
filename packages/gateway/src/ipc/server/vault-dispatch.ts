import { asRecord } from "../../connectors/unknown-record.ts";
import { NULL_EGRESS_SINK } from "../../egress/egress-ledger.ts";
import { bindConsentChannel, ToolExecutor } from "../../engine/executor.ts";
import type { ConnectorDispatcher } from "../../engine/types.ts";
import { validateVaultKeyOrThrow } from "../../vault/key-format.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { ServerCtx } from "./context.ts";
import { RpcMethodError } from "./rpc-error.ts";

function assertWellFormedVaultKey(key: string): void {
  try {
    validateVaultKeyOrThrow(key);
  } catch {
    throw new RpcMethodError(-32602, "Invalid vault key format");
  }
}

type VaultDispatchHit = { readonly kind: "hit"; readonly value: unknown };
type VaultDispatchMiss = { readonly kind: "miss" };
type VaultDispatchOutcome = VaultDispatchHit | VaultDispatchMiss;

export async function dispatchVaultGated(
  vault: NimbusVault,
  toolExecutor: ToolExecutor | undefined,
  method: string,
  params: unknown,
): Promise<VaultDispatchOutcome> {
  if ((method === "vault.set" || method === "vault.delete") && toolExecutor !== undefined) {
    const rec = asRecord(params);
    const key = rec !== undefined && typeof rec["key"] === "string" ? rec["key"] : "";
    const gateResult = await toolExecutor.gate({ type: method, payload: { key } });
    if (gateResult !== "proceed" && gateResult.status === "rejected") {
      throw new RpcMethodError(-32000, gateResult.reason);
    }
  }
  return dispatchVaultIfPresent(vault, method, params);
}

async function dispatchVaultIfPresent(
  vault: NimbusVault,
  method: string,
  params: unknown,
): Promise<VaultDispatchOutcome> {
  switch (method) {
    case "vault.set": {
      const rec = asRecord(params);
      if (rec === undefined || typeof rec["key"] !== "string" || typeof rec["value"] !== "string") {
        throw new RpcMethodError(-32602, "Invalid params");
      }
      assertWellFormedVaultKey(rec["key"]);
      await vault.set(rec["key"], rec["value"]);
      return { kind: "hit", value: { ok: true } };
    }
    case "vault.get": {
      const rec = asRecord(params);
      if (rec === undefined || typeof rec["key"] !== "string") {
        throw new RpcMethodError(-32602, "Invalid params");
      }
      assertWellFormedVaultKey(rec["key"]);
      return { kind: "hit", value: await vault.get(rec["key"]) };
    }
    case "vault.delete": {
      const rec = asRecord(params);
      if (rec === undefined || typeof rec["key"] !== "string") {
        throw new RpcMethodError(-32602, "Invalid params");
      }
      assertWellFormedVaultKey(rec["key"]);
      await vault.delete(rec["key"]);
      return { kind: "hit", value: { ok: true } };
    }
    case "vault.listKeys": {
      const rec = asRecord(params);
      const prefix =
        rec !== undefined && typeof rec["prefix"] === "string" ? rec["prefix"] : undefined;
      return { kind: "hit", value: await vault.listKeys(prefix) };
    }
    default:
      return { kind: "miss" };
  }
}

export async function rpcVaultOrMethodNotFound(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  const stubDispatcher: ConnectorDispatcher = {
    dispatch(): Promise<unknown> {
      return Promise.reject(new Error("IPC-native gate does not dispatch to MCP"));
    },
  };
  // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
  const toolExecutor =
    ctx.options.localIndex === undefined
      ? undefined
      : new ToolExecutor(
          bindConsentChannel(ctx.consentImpl, clientId),
          ctx.options.localIndex,
          stubDispatcher,
          undefined,
          NULL_EGRESS_SINK,
        );
  const vaultOutcome = await dispatchVaultGated(ctx.options.vault, toolExecutor, method, params);
  if (vaultOutcome.kind === "hit") {
    return vaultOutcome.value;
  }
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}
