import { runDataDelete } from "../commands/data-delete.ts";
import { runDataExport } from "../commands/data-export.ts";
import { DataImportVersionError, runDataImport } from "../commands/data-import.ts";
import { normalizeConnectorServiceId } from "../connectors/connector-catalog.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import type { KdfParams } from "../db/data-vault-crypto.ts";
import { collectIndexMetrics } from "../db/metrics.ts";
import type { ToolExecutor } from "../engine/executor.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export type DataRpcContext = {
  index: LocalIndex | undefined;
  vault: NimbusVault | undefined;
  platform: "win32" | "darwin" | "linux";
  nimbusVersion: string;
  schemaVersion?: number;
  kdfParams?: KdfParams;
  notify?: (method: string, params: Record<string, unknown>) => void;
  toolExecutor?: ToolExecutor;
};

type RpcResult = { kind: "hit"; value: unknown } | { kind: "miss" };

export class DataRpcError extends Error {
  readonly rpcCode: number;
  readonly rpcData?: Record<string, unknown>;
  constructor(rpcCode: number, message: string, rpcData?: Record<string, unknown>) {
    super(message);
    this.name = "DataRpcError";
    this.rpcCode = rpcCode;
    if (rpcData !== undefined) {
      this.rpcData = rpcData;
    }
  }
}

function asRecord(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== "object") return {};
  return params as Record<string, unknown>;
}

function requireDeps(ctx: DataRpcContext): { index: LocalIndex; vault: NimbusVault } {
  if (ctx.index === undefined || ctx.vault === undefined) {
    throw new DataRpcError(-32603, "data RPC unavailable: index or vault not configured");
  }
  return { index: ctx.index, vault: ctx.vault };
}

async function handleDataExport(
  rec: Record<string, unknown>,
  ctx: DataRpcContext,
): Promise<unknown> {
  const output = rec["output"];
  const passphrase = rec["passphrase"];
  const includeIndex = rec["includeIndex"] === true;
  if (typeof output !== "string" || output === "")
    throw new DataRpcError(-32602, "Missing param: output");
  if (typeof passphrase !== "string" || passphrase === "")
    throw new DataRpcError(-32602, "Missing param: passphrase");
  const executor = ctx.toolExecutor;
  if (executor === undefined) {
    throw new DataRpcError(-32603, "data.export requires a toolExecutor in context");
  }
  const gateResult = await executor.gate({
    type: "data.export",
    payload: { output, includeIndex },
  });
  if (gateResult !== "proceed") {
    return gateResult;
  }
  const { index, vault } = requireDeps(ctx);
  ctx.notify?.("data.exportProgress", { stage: "packing", bytesWritten: 0, totalBytes: 0 });
  const result = await runDataExport({
    output,
    passphrase,
    includeIndex,
    vault,
    index,
    platform: ctx.platform,
    nimbusVersion: ctx.nimbusVersion,
    schemaVersion: ctx.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    ...(ctx.kdfParams === undefined ? {} : { kdfParams: ctx.kdfParams }),
  });
  ctx.notify?.("data.exportCompleted", {
    path: result.outputPath,
    itemsExported: result.itemsExported,
  });
  return result;
}

async function handleDataImport(
  rec: Record<string, unknown>,
  ctx: DataRpcContext,
): Promise<unknown> {
  const { index, vault } = requireDeps(ctx);
  const bundlePath = rec["bundlePath"];
  const passphrase = rec["passphrase"];
  const recoverySeed = rec["recoverySeed"];
  if (typeof bundlePath !== "string" || bundlePath === "")
    throw new DataRpcError(-32602, "Missing param: bundlePath");
  ctx.notify?.("data.importProgress", { stage: "unpacking", bytesRead: 0, totalBytes: 0 });
  try {
    const result = await runDataImport({
      bundlePath,
      ...(typeof passphrase === "string" ? { passphrase } : {}),
      ...(typeof recoverySeed === "string" ? { recoverySeed } : {}),
      vault,
      index,
    });
    ctx.notify?.("data.importCompleted", { credentialsRestored: result.credentialsRestored });
    return result;
  } catch (err) {
    if (err instanceof DataImportVersionError) {
      throw new DataRpcError(-32010, err.message, {
        kind: "version_incompatible",
        archiveSchemaVersion: err.archiveSchemaVersion,
        currentSchemaVersion: err.currentSchemaVersion,
        relation: err.relation,
      });
    }
    throw err;
  }
}

async function handleDataDelete(
  rec: Record<string, unknown>,
  ctx: DataRpcContext,
): Promise<unknown> {
  const { index, vault } = requireDeps(ctx);
  const service = rec["service"];
  const dryRun = rec["dryRun"] === true;
  if (typeof service !== "string" || service === "")
    throw new DataRpcError(-32602, "Missing param: service");
  if (!dryRun) {
    const executor = ctx.toolExecutor;
    if (executor === undefined) {
      throw new DataRpcError(-32603, "data.delete requires a toolExecutor in context");
    }
    const gateResult = await executor.gate({
      type: "data.delete",
      payload: { service },
    });
    if (gateResult !== "proceed") {
      return gateResult;
    }
  }
  return runDataDelete({ service, dryRun, vault, index });
}

export type ExportPreflightResult = {
  lastExportAt: number | null;
  estimatedSizeBytes: number;
  itemCount: number;
};

export type DeletePreflightResult = {
  service: string;
  itemCount: number;
  embeddingCount: number;
  vaultKeyCount: number;
};

function handleGetExportPreflight(ctx: DataRpcContext): ExportPreflightResult {
  if (ctx.index === undefined) {
    return { lastExportAt: null, estimatedSizeBytes: 0, itemCount: 0 };
  }
  const db = ctx.index.getDatabase();
  const metrics = collectIndexMetrics(db);
  let lastExportAt: number | null = null;
  try {
    const row = db
      .query(
        "SELECT MAX(timestamp) AS ts FROM audit_log WHERE action_type = 'data.export' AND hitl_status = 'approved'",
      )
      .get() as { ts: number | null } | undefined;
    lastExportAt = row?.ts ?? null;
  } catch {
    // audit_log may not exist in older schemas — ignore
  }
  return {
    lastExportAt,
    estimatedSizeBytes: metrics.indexSizeBytes,
    itemCount: metrics.totalItems,
  };
}

function handleGetDeletePreflight(params: unknown, ctx: DataRpcContext): DeletePreflightResult {
  const p =
    params !== null && typeof params === "object" ? (params as Record<string, unknown>) : null;
  if (p === null || typeof p["service"] !== "string" || p["service"] === "") {
    throw new DataRpcError(-32602, "data.getDeletePreflight requires service:string");
  }
  const service = p["service"];
  if (ctx.index === undefined) {
    const serviceId = normalizeConnectorServiceId(service);
    const vaultKeyCount = serviceId === null ? 0 : CONNECTOR_VAULT_SECRET_KEYS[serviceId].length;
    return { service, itemCount: 0, embeddingCount: 0, vaultKeyCount };
  }
  const db = ctx.index.getDatabase();
  const metrics = collectIndexMetrics(db);
  const itemCount = metrics.itemCountByService[service] ?? 0;
  const embRow = db
    .query(
      "SELECT COUNT(DISTINCT ec.item_id) AS c FROM embedding_chunk ec JOIN item i ON ec.item_id = i.id WHERE i.service = ?",
    )
    .get(service) as { c: number } | undefined;
  const embeddingCount = embRow?.c ?? 0;
  const serviceId = normalizeConnectorServiceId(service);
  const vaultKeyCount = serviceId === null ? 0 : CONNECTOR_VAULT_SECRET_KEYS[serviceId].length;
  return { service, itemCount, embeddingCount, vaultKeyCount };
}

export async function dispatchDataRpc(
  method: string,
  params: unknown,
  ctx: DataRpcContext,
): Promise<RpcResult> {
  const rec = asRecord(params);
  if (method === "data.export") return { kind: "hit", value: await handleDataExport(rec, ctx) };
  if (method === "data.import") return { kind: "hit", value: await handleDataImport(rec, ctx) };
  if (method === "data.delete") return { kind: "hit", value: await handleDataDelete(rec, ctx) };
  if (method === "data.getExportPreflight")
    return { kind: "hit", value: handleGetExportPreflight(ctx) };
  if (method === "data.getDeletePreflight")
    return { kind: "hit", value: handleGetDeletePreflight(params, ctx) };
  return { kind: "miss" };
}
